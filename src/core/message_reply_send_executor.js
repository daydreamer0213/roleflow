const { PRODUCT_POLICY } = require("./product_policy");
const { stopPendingMessageReplySendItems } = require("./storage");
const {
  loadReplySendBatch,
  transitionReplySendBatch,
  transitionReplySendItem,
  publicReplySendBatch
} = require("./message_reply_send_batches");

const TERMINAL_BATCH_STATUSES = new Set(["completed", "stopped", "interrupted"]);
const PRE_CLICK_ITEM_STATUSES = new Set(["pending", "selecting", "verified", "filled"]);
const TARGET_MISMATCH_CODES = new Set([
  "BOSS_MESSAGE_REPLY_TARGET_MISMATCH",
  "BOSS_MESSAGE_TARGET_MISMATCH",
  "BOSS_MESSAGE_ROW_DRIFTED"
]);

async function runMessageReplySendBatch({
  db,
  batchId,
  sender,
  accessController,
  onVerifiedSuccess,
  sleepFn = sleep,
  randomFn = Math.random,
  signal = null,
  logger = null
} = {}) {
  assertDependencies({ db, sender, accessController, onVerifiedSuccess, sleepFn });
  const batch = positiveInteger(batchId, "batchId");
  const owner = db.prepare("SELECT profile_id FROM message_reply_send_batches WHERE id = ?").get(batch);
  if (!owner) throw executorError("MESSAGE_REPLY_SEND_BATCH_NOT_FOUND", "message reply send batch was not found");
  const profileId = Number(owner.profile_id);
  let snapshot = loadReplySendBatch(db, { profileId, batchId: batch });
  if (TERMINAL_BATCH_STATUSES.has(snapshot.batch.status)) return publicReplySendBatch(snapshot);
  if (snapshot.batch.status === "running") {
    return normalizeStaleRun(db, { profileId, batchId: batch, snapshot, logger });
  }
  if (snapshot.batch.status !== "confirmed") {
    throw executorError("MESSAGE_REPLY_SEND_BATCH_STATUS_INVALID", "message reply send batch cannot start");
  }

  transitionReplySendBatch(db, {
    profileId,
    batchId: batch,
    expectedStatus: "confirmed",
    status: "running"
  });
  logger?.info("message_reply_send_batch_started", { batchId: batch, itemCount: snapshot.items.length });

  for (let position = 0; position < snapshot.items.length; position += 1) {
    const itemId = snapshot.items[position].id;
    let preparation = null;
    let durableClick = false;
    try {
      await checkpoint(db, { profileId, batchId: batch, itemId, signal });
      transitionReplySendItem(db, {
        profileId, batchId: batch, itemId,
        expectedStatus: "pending", status: "selecting"
      });
      await checkpoint(db, { profileId, batchId: batch, itemId, signal, expectedItemStatus: "selecting" });
      const current = currentItem(db, { profileId, batchId: batch, itemId });
      await accessController.reserve("message_reply_send", {
        batchId: batch,
        itemId,
        jobId: current.jobId
      });

      await checkpoint(db, { profileId, batchId: batch, itemId, signal, expectedItemStatus: "selecting" });
      const inspection = await sender.inspectReplyTarget(current, signal);
      await checkpoint(db, { profileId, batchId: batch, itemId, signal, expectedItemStatus: "selecting" });
      transitionReplySendItem(db, {
        profileId, batchId: batch, itemId,
        expectedStatus: "selecting", status: "verified"
      });

      await checkpoint(db, { profileId, batchId: batch, itemId, signal, expectedItemStatus: "verified" });
      preparation = await sender.fillReply(inspection, current.replyText, signal);
      await checkpoint(db, { profileId, batchId: batch, itemId, signal, expectedItemStatus: "verified" });
      transitionReplySendItem(db, {
        profileId, batchId: batch, itemId,
        expectedStatus: "verified", status: "filled"
      });

      await checkpoint(db, { profileId, batchId: batch, itemId, signal, expectedItemStatus: "filled" });
      transitionReplySendItem(db, {
        profileId, batchId: batch, itemId,
        expectedStatus: "filled", status: "click_dispatched", clickCount: 1
      });
      durableClick = true;
      await checkpoint(db, { profileId, batchId: batch, itemId, signal, expectedItemStatus: "click_dispatched" });
      await sender.dispatchReply(preparation, signal);
      await checkpoint(db, { profileId, batchId: batch, itemId, signal, expectedItemStatus: "click_dispatched" });
      const outcome = normalizeOutcome(await sender.verifyReplyResult(preparation, signal));
      await checkpoint(db, { profileId, batchId: batch, itemId, signal, expectedItemStatus: "click_dispatched" });

      if (outcome.state !== "succeeded") {
        const terminalStatus = outcome.state === "platform_rejected" ? "platform_rejected" : "ambiguous";
        transitionReplySendItem(db, {
          profileId, batchId: batch, itemId,
          expectedStatus: "click_dispatched", status: terminalStatus, clickCount: 1,
          evidence: outcome.evidence,
          errorCode: outcomeCode(outcome.state),
          errorMessage: "reply send was not verified as successful"
        });
        return interruptBatch(db, {
          profileId, batchId: batch,
          code: outcomeCode(outcome.state),
          message: "reply batch stopped after an unverified send outcome",
          logger
        });
      }

      try {
        await checkpoint(db, { profileId, batchId: batch, itemId, signal, expectedItemStatus: "click_dispatched" });
        await onVerifiedSuccess({ batchId: batch, itemId });
      } catch (error) {
        markDispatchedAmbiguousIfNeeded(db, {
          profileId, batchId: batch, itemId,
          code: "MESSAGE_REPLY_SEND_LOCAL_COMMIT_FAILED",
          message: "verified reply could not be committed locally",
          evidence: outcome.evidence
        });
        return interruptBatch(db, {
          profileId, batchId: batch,
          code: "MESSAGE_REPLY_SEND_LOCAL_COMMIT_FAILED",
          message: "reply batch stopped after local completion failed",
          logger,
          cause: error
        });
      }
      const completedItem = currentItem(db, { profileId, batchId: batch, itemId });
      if (completedItem.status !== "succeeded") {
        markDispatchedAmbiguousIfNeeded(db, {
          profileId, batchId: batch, itemId,
          code: "MESSAGE_REPLY_SEND_LOCAL_COMMIT_FAILED",
          message: "verified reply completion was not persisted",
          evidence: outcome.evidence
        });
        return interruptBatch(db, {
          profileId, batchId: batch,
          code: "MESSAGE_REPLY_SEND_LOCAL_COMMIT_FAILED",
          message: "reply batch stopped after local completion was not persisted",
          logger
        });
      }

      logger?.info("message_reply_send_item_succeeded", { batchId: batch, itemId, position });
      if (position + 1 < snapshot.items.length) {
        await checkpoint(db, { profileId, batchId: batch, signal });
        await sleepFn(interItemDelay(randomFn), signal);
        await checkpoint(db, { profileId, batchId: batch, signal });
      }
    } catch (error) {
      if (error instanceof TerminalBatchSignal) {
        if (preparation && !durableClick) await sender.clearPreparedReply(preparation).catch(() => {});
        return error.publicSnapshot;
      }
      if (durableClick) {
        markDispatchedAmbiguousIfNeeded(db, {
          profileId, batchId: batch, itemId,
          code: "MESSAGE_REPLY_SEND_AMBIGUOUS",
          message: "reply send stopped after click ownership was persisted"
        });
      } else {
        if (preparation) await sender.clearPreparedReply(preparation).catch(() => {});
        markPreClickFailure(db, { profileId, batchId: batch, itemId, error });
      }
      return interruptBatch(db, {
        profileId, batchId: batch,
        code: durableClick ? "MESSAGE_REPLY_SEND_AMBIGUOUS" : safeErrorCode(error),
        message: durableClick
          ? "reply batch stopped after an ambiguous click outcome"
          : "reply batch stopped before a send click",
        logger,
        cause: error
      });
    }
  }

  snapshot = loadReplySendBatch(db, { profileId, batchId: batch });
  if (!snapshot.items.every((item) => item.status === "succeeded")) {
    return interruptBatch(db, {
      profileId, batchId: batch,
      code: "MESSAGE_REPLY_SEND_INCOMPLETE",
      message: "reply batch did not complete every item",
      logger
    });
  }
  transitionReplySendBatch(db, {
    profileId, batchId: batch,
    expectedStatus: "running", status: "completed"
  });
  logger?.info("message_reply_send_batch_completed", { batchId: batch, itemCount: snapshot.items.length });
  return publicReplySendBatch(loadReplySendBatch(db, { profileId, batchId: batch }));
}

function normalizeStaleRun(db, { profileId, batchId, snapshot, logger }) {
  if (snapshot.items.every((item) => item.status === "succeeded")) {
    transitionReplySendBatch(db, {
      profileId, batchId, expectedStatus: "running", status: "completed"
    });
    return publicReplySendBatch(loadReplySendBatch(db, { profileId, batchId }));
  }
  for (const item of snapshot.items.filter((entry) => entry.status === "click_dispatched")) {
    transitionReplySendItem(db, {
      profileId, batchId, itemId: item.id,
      expectedStatus: "click_dispatched", status: "ambiguous", clickCount: 1,
      errorCode: "MESSAGE_REPLY_SEND_STALE_CLICK",
      errorMessage: "historical click outcome requires manual review"
    });
  }
  return interruptBatch(db, {
    profileId, batchId,
    code: "MESSAGE_REPLY_SEND_STALE_RUN",
    message: "stale reply batch was stopped without replay",
    logger
  });
}

async function checkpoint(db, { profileId, batchId, itemId = null, signal, expectedItemStatus = null }) {
  if (signal?.aborted) throw signal.reason || executorError("MESSAGE_REPLY_SEND_ABORTED", "message reply send was aborted");
  const snapshot = loadReplySendBatch(db, { profileId, batchId });
  if (snapshot.batch.status !== "running") {
    throw new TerminalBatchSignal(publicReplySendBatch(snapshot));
  }
  if (itemId !== null && expectedItemStatus !== null) {
    const item = snapshot.items.find((entry) => entry.id === itemId);
    if (!item || item.status !== expectedItemStatus) {
      throw executorError("MESSAGE_REPLY_SEND_CONTROL_CHANGED", "message reply send item changed concurrently");
    }
  }
  return snapshot;
}

function markPreClickFailure(db, { profileId, batchId, itemId, error }) {
  const snapshot = loadReplySendBatch(db, { profileId, batchId });
  if (snapshot.batch.status !== "running") return;
  const item = snapshot.items.find((entry) => entry.id === itemId);
  if (!item || !PRE_CLICK_ITEM_STATUSES.has(item.status)) return;
  const targetMismatch = TARGET_MISMATCH_CODES.has(safeErrorCode(error));
  const status = targetMismatch && item.status !== "pending" ? "target_mismatch" : "stopped";
  transitionReplySendItem(db, {
    profileId, batchId, itemId,
    expectedStatus: item.status,
    status,
    errorCode: safeErrorCode(error),
    errorMessage: targetMismatch ? "confirmed reply target changed" : "reply send stopped before click"
  });
}

function markDispatchedAmbiguousIfNeeded(db, { profileId, batchId, itemId, code, message, evidence }) {
  const item = currentItem(db, { profileId, batchId, itemId });
  if (item.status !== "click_dispatched") return;
  transitionReplySendItem(db, {
    profileId, batchId, itemId,
    expectedStatus: "click_dispatched", status: "ambiguous", clickCount: 1,
    evidence, errorCode: code, errorMessage: message
  });
}

function interruptBatch(db, { profileId, batchId, code, message, logger, cause = null }) {
  let snapshot = loadReplySendBatch(db, { profileId, batchId });
  if (!TERMINAL_BATCH_STATUSES.has(snapshot.batch.status)) {
    stopPendingMessageReplySendItems(db, {
      profileId, batchId,
      errorCode: code,
      errorMessage: message
    });
    snapshot = loadReplySendBatch(db, { profileId, batchId });
    transitionReplySendBatch(db, {
      profileId, batchId,
      expectedStatus: snapshot.batch.status,
      status: "interrupted",
      stopCode: code
    });
  }
  logger?.warn("message_reply_send_batch_interrupted", {
    batchId,
    code,
    causeCode: safeErrorCode(cause)
  });
  return publicReplySendBatch(loadReplySendBatch(db, { profileId, batchId }));
}

function currentItem(db, { profileId, batchId, itemId }) {
  const item = loadReplySendBatch(db, { profileId, batchId }).items.find((entry) => entry.id === itemId);
  if (!item) throw executorError("MESSAGE_REPLY_SEND_ITEM_NOT_FOUND", "message reply send item was not found");
  return item;
}

function normalizeOutcome(value) {
  const state = String(value?.state || "");
  if (!["succeeded", "target_mismatch", "platform_rejected", "ambiguous"].includes(state)) {
    throw executorError("MESSAGE_REPLY_SEND_OUTCOME_INVALID", "reply sender returned an invalid outcome");
  }
  return { state, evidence: value?.evidence && typeof value.evidence === "object" ? value.evidence : {} };
}

function outcomeCode(state) {
  return {
    target_mismatch: "BOSS_MESSAGE_REPLY_TARGET_MISMATCH",
    platform_rejected: "BOSS_MESSAGE_REPLY_PLATFORM_REJECTED",
    ambiguous: "MESSAGE_REPLY_SEND_AMBIGUOUS"
  }[state] || "MESSAGE_REPLY_SEND_AMBIGUOUS";
}

function interItemDelay(randomFn) {
  const [low, high] = PRODUCT_POLICY.operations.bossCommunication.delayMs;
  const ratio = Math.max(0, Math.min(1, Number(randomFn()) || 0));
  return Math.round(low + (high - low) * ratio);
}

function safeErrorCode(error) {
  const code = String(error?.code || "MESSAGE_REPLY_SEND_FAILED");
  return /^[A-Z0-9_]{1,100}$/.test(code) ? code : "MESSAGE_REPLY_SEND_FAILED";
}

function assertDependencies({ db, sender, accessController, onVerifiedSuccess, sleepFn }) {
  if (!db?.prepare) throw new TypeError("db is required");
  for (const name of ["inspectReplyTarget", "fillReply", "dispatchReply", "verifyReplyResult", "clearPreparedReply"]) {
    if (typeof sender?.[name] !== "function") throw new TypeError(`sender.${name} is required`);
  }
  if (typeof accessController?.reserve !== "function") throw new TypeError("accessController.reserve is required");
  if (typeof onVerifiedSuccess !== "function") throw new TypeError("onVerifiedSuccess is required");
  if (typeof sleepFn !== "function") throw new TypeError("sleepFn is required");
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

function executorError(code, message) {
  return Object.assign(new Error(message), { code });
}

class TerminalBatchSignal extends Error {
  constructor(publicSnapshot) {
    super("message reply batch is terminal");
    this.publicSnapshot = publicSnapshot;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || executorError("MESSAGE_REPLY_SEND_ABORTED", "message reply send was aborted"));
    }, { once: true });
  });
}

module.exports = {
  runMessageReplySendBatch
};
