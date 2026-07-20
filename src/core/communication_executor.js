const { PRODUCT_POLICY } = require("./product_policy");
const { reconcileCommunicationOutcome } = require("./workflow_inventory");
const { assertCommunicationExecutionEnabled } = require("./communication_calibration");
const {
  TERMINAL_ITEM_STATUSES,
  getCommunicationBatch,
  listCommunicationBatchItems,
  pauseCommunicationBatchAfterReservationFailure,
  setCommunicationBatchStatus,
  transitionCommunicationItem,
  communicationBatchSummary
} = require("./communication_batches");

const FATAL_CODES = new Set([
  "BOSS_RISK_CONTROL",
  "BOSS_LOGIN_REQUIRED",
  "BROWSER_TIMEOUT",
  "BROWSER_DISCONNECTED",
  "BOSS_DETAIL_PAGE_LOST",
  "BOSS_COMMUNICATION_STRUCTURE_CHANGED"
]);

async function runCommunicationBatch({
  db,
  batchId,
  adapter,
  accessController,
  logger = null,
  sleepFn = sleep,
  randomFn = Math.random,
  signal = null,
  executionGate = assertCommunicationExecutionEnabled
}) {
  validateDependencies({ db, batchId, adapter, accessController, executionGate });
  assertExecutionEnabled(executionGate);
  let batch = getCommunicationBatch(db, batchId);
  if (!batch) throw codedError("COMMUNICATION_BATCH_NOT_FOUND", "communication batch not found");
  if (["confirmed", "paused"].includes(batch.status)) batch = setCommunicationBatchStatus(db, { batchId, status: "running" });
  if (batch.status === "stopping") return stopUnfinishedItems(db, batchId, logger);
  if (isTerminalBatch(batch.status)) return communicationBatchSummary(db, batchId);
  if (batch.status !== "running") throw codedError("COMMUNICATION_BATCH_STATUS_INVALID", "communication batch is not runnable");

  while (true) {
    const control = observeControl(db, batchId, signal, logger);
    if (control) return control;
    const item = listCommunicationBatchItems(db, batchId).find((candidate) => !TERMINAL_ITEM_STATUSES.has(candidate.status));
    if (!item) return finalizeBatch(db, batchId, logger);
    if (item.status !== "pending") return recoverIncompleteItem(db, batchId, item, logger);

    try {
      transitionCommunicationItem(db, { itemId: item.id, batchId, expectedStatus: "pending", status: "opening" });
    } catch (error) {
      if (error.code === "COMMUNICATION_ITEM_TRANSITION_CONFLICT") continue;
      throw error;
    }

    const afterClaim = observeControl(db, batchId, signal, logger);
    if (afterClaim) return afterClaim;
    try {
      await accessController.reserve("communication_visit", { batchId: item.batchId, itemId: item.id, jobId: item.jobId });
    } catch (error) {
      try {
        pauseCommunicationBatchAfterReservationFailure(db, { batchId, itemId: item.id });
      } catch (rollbackError) {
        logger?.error("communication_reservation_rollback_failed", {
          batchId,
          itemId: item.id,
          code: errorCode(rollbackError)
        });
      }
      throw error;
    }
    const afterReserve = observeControl(db, batchId, signal, logger);
    if (afterReserve) return afterReserve;

    let inspection;
    try {
      inspection = await adapter.inspectCommunicationJob(immutableJob(item), signal);
    } catch (error) {
      const afterInspectFailure = observeControl(db, batchId, signal, logger);
      if (afterInspectFailure) return afterInspectFailure;
      transitionToUnavailable(db, batchId, item, error);
      if (isFatal(error) || signal?.aborted) return interruptAndThrow(db, batchId, error, logger);
      const pacing = await paceAfterTerminalItem({ db, batchId, logger, sleepFn, randomFn, signal });
      if (pacing) return pacing;
      continue;
    }

    const afterInspect = observeControl(db, batchId, signal, logger);
    if (afterInspect) return afterInspect;
    const state = communicationState(inspection);
    if (state === "ready") {
      await dispatchAndVerify({
        db,
        batchId,
        batch: getCommunicationBatch(db, batchId),
        item,
        inspection,
        adapter,
        logger,
        signal,
        executionGate
      });
    } else if (state === "already_communicated") {
      transitionCommunicationItem(db, { itemId: item.id, batchId, expectedStatus: "opening", status: "already_communicated" });
      reconcileCommunicationOutcome(db, {
        batch: getCommunicationBatch(db, batchId), item, status: "already_communicated", note: `RoleFlow batch #${batchId}`
      });
      recordAudit(db, item, "communication_result", "already_communicated");
    } else {
      const finalState = ["job_unavailable", "target_mismatch", "action_unavailable"].includes(state)
        ? state
        : "action_unavailable";
      transitionCommunicationItem(db, { itemId: item.id, batchId, expectedStatus: "opening", status: finalState });
      reconcileCommunicationOutcome(db, {
        batch: getCommunicationBatch(db, batchId), item, status: finalState, note: `RoleFlow batch #${batchId}`
      });
      recordAudit(db, item, "communication_result", finalState);
    }

    const pacing = await paceAfterTerminalItem({ db, batchId, logger, sleepFn, randomFn, signal });
    if (pacing) return pacing;
  }
}

async function dispatchAndVerify({ db, batchId, batch, item, inspection, adapter, logger, signal, executionGate }) {
  const beforeDispatch = observeControl(db, batchId, signal, logger);
  if (beforeDispatch) return beforeDispatch;
  try {
    assertExecutionEnabled(executionGate);
  } catch (error) {
    transitionCommunicationItem(db, {
      itemId: item.id,
      batchId,
      expectedStatus: "opening",
      status: "stopped",
      errorCode: errorCode(error)
    });
    recordAudit(db, item, "communication_result", "stopped");
    return interruptAndThrow(db, batchId, error, logger);
  }
  transitionCommunicationItem(db, { itemId: item.id, batchId, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(db, {
    itemId: item.id,
    batchId,
    expectedStatus: "verified",
    status: "click_dispatched",
    audit: clickAudit(item)
  });

  try {
    await adapter.dispatchCommunication(inspection, signal);
  } catch (error) {
    return ambiguousAndThrow(db, batchId, item, error, logger);
  }

  let result;
  try {
    result = await adapter.verifyCommunicationResult(immutableJob(item), signal);
  } catch (error) {
    return ambiguousAndThrow(db, batchId, item, error, logger);
  }
  if (communicationState(result) !== "succeeded") {
    return ambiguousAndThrow(
      db,
      batchId,
      item,
      codedError("COMMUNICATION_RESULT_AMBIGUOUS", "communication result could not be verified"),
      logger
    );
  }
  transitionCommunicationItem(db, { itemId: item.id, batchId, expectedStatus: "click_dispatched", status: "succeeded" });
  reconcileCommunicationOutcome(db, { batch, item, status: "succeeded", note: `RoleFlow batch #${batch.id}` });
  recordAudit(db, item, "communication_result", "succeeded");
}

async function paceAfterTerminalItem({ db, batchId, logger, sleepFn, randomFn, signal }) {
  if (!listCommunicationBatchItems(db, batchId).some((item) => item.status === "pending")) return null;
  let remainingMs = randomDelay(PRODUCT_POLICY.operations.bossCommunication.delayMs, randomFn);
  logger?.info("communication_batch_pacing", { batchId, delayMs: remainingMs });
  while (remainingMs > 0) {
    const control = observeControl(db, batchId, signal, logger);
    if (control) return control;
    const sliceMs = Math.min(1000, remainingMs);
    try {
      await sleepFn(sliceMs, signal);
    } catch (error) {
      return interruptAndThrow(db, batchId, error, logger);
    }
    remainingMs -= sliceMs;
  }
  return observeControl(db, batchId, signal, logger);
}

function observeControl(db, batchId, signal, logger) {
  if (signal?.aborted) {
    const error = signal.reason instanceof Error
      ? signal.reason
      : codedError("COMMUNICATION_ABORTED", "communication execution aborted");
    return interruptAndThrow(db, batchId, error, logger);
  }
  const batch = getCommunicationBatch(db, batchId);
  if (batch.status === "paused") {
    logger?.info("communication_batch_paused", { batchId });
    return communicationBatchSummary(db, batchId);
  }
  if (batch.status === "stopping") return stopUnfinishedItems(db, batchId, logger);
  if (isTerminalBatch(batch.status)) return communicationBatchSummary(db, batchId);
  return null;
}

function stopUnfinishedItems(db, batchId, logger) {
  for (const item of listCommunicationBatchItems(db, batchId)) {
    if (item.status === "pending" || item.status === "opening" || item.status === "verified") {
      transitionCommunicationItem(db, { itemId: item.id, batchId, expectedStatus: item.status, status: "stopped" });
      recordAudit(db, item, "communication_result", "stopped");
    } else if (item.status === "click_dispatched") {
      transitionCommunicationItem(db, { itemId: item.id, batchId, expectedStatus: "click_dispatched", status: "ambiguous" });
      recordAudit(db, item, "communication_result", "ambiguous");
    }
  }
  const batch = getCommunicationBatch(db, batchId);
  if (!isTerminalBatch(batch.status)) setCommunicationBatchStatus(db, { batchId, status: "stopped", stopCode: "COMMUNICATION_STOP_REQUESTED" });
  logger?.info("communication_batch_stopped", { batchId });
  return communicationBatchSummary(db, batchId);
}

function recoverIncompleteItem(db, batchId, item, logger) {
  const state = item.status === "click_dispatched" ? "ambiguous" : "stopped";
  transitionCommunicationItem(db, { itemId: item.id, batchId, expectedStatus: item.status, status: state });
  recordAudit(db, item, "communication_result", state);
  return interruptAndThrow(
    db,
    batchId,
    codedError("COMMUNICATION_RESUME_REQUIRES_REVIEW", "communication batch contains an unfinished item"),
    logger
  );
}

function finalizeBatch(db, batchId, logger) {
  const batch = getCommunicationBatch(db, batchId);
  if (batch.status === "paused") return communicationBatchSummary(db, batchId);
  if (batch.status === "stopping") return stopUnfinishedItems(db, batchId, logger);
  setCommunicationBatchStatus(db, { batchId, status: "completed" });
  logger?.info("communication_batch_completed", { batchId });
  return communicationBatchSummary(db, batchId);
}

function transitionToUnavailable(db, batchId, item, error) {
  transitionCommunicationItem(db, {
    itemId: item.id,
    batchId,
    expectedStatus: "opening",
    status: "action_unavailable",
    errorCode: errorCode(error)
  });
  reconcileCommunicationOutcome(db, {
    batch: getCommunicationBatch(db, batchId), item, status: "action_unavailable", note: `RoleFlow batch #${batchId}`
  });
  recordAudit(db, item, "communication_result", "action_unavailable");
}

function ambiguousAndThrow(db, batchId, item, error, logger) {
  transitionCommunicationItem(db, {
    itemId: item.id,
    batchId,
    expectedStatus: "click_dispatched",
    status: "ambiguous",
    errorCode: errorCode(error)
  });
  recordAudit(db, item, "communication_result", "ambiguous");
  return interruptAndThrow(db, batchId, error, logger);
}

function interruptAndThrow(db, batchId, error, logger) {
  const batch = getCommunicationBatch(db, batchId);
  if (!isTerminalBatch(batch.status)) {
    setCommunicationBatchStatus(db, {
      batchId,
      status: "interrupted",
      stopCode: errorCode(error),
      stopMessage: "communication execution interrupted"
    });
  }
  logger?.warn("communication_batch_interrupted", { batchId, code: errorCode(error) });
  throw error;
}

function recordAudit(db, item, eventType, state) {
  db.prepare("INSERT INTO events(job_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)")
    .run(item.jobId, eventType, JSON.stringify({ batchId: item.batchId, itemId: item.id, jobId: item.jobId, state }), new Date().toISOString());
}

function clickAudit(item) {
  return {
    eventType: "communication_click",
    payload: { batchId: item.batchId, itemId: item.id, jobId: item.jobId, state: "click_dispatched" }
  };
}

function immutableJob(item) {
  return Object.freeze({
    id: item.jobId,
    batchId: item.batchId,
    itemId: item.id,
    position: item.position,
    url: item.jobUrl,
    title: item.titleSnapshot,
    company: item.companySnapshot
  });
}

function communicationState(value) {
  return String(typeof value === "string" ? value : value?.state || "").trim().toLowerCase();
}

function randomDelay([first, second], randomFn) {
  const low = Math.min(Number(first), Number(second));
  const high = Math.max(Number(first), Number(second));
  const random = Math.max(0, Math.min(1, Number(randomFn()) || 0));
  return Math.floor(low + random * (high - low));
}

function isFatal(error) {
  return FATAL_CODES.has(errorCode(error));
}

function isTerminalBatch(status) {
  return ["completed", "stopped", "interrupted", "failed"].includes(status);
}

function errorCode(error) {
  return String(error?.code || "COMMUNICATION_EXECUTION_FAILED");
}

function validateDependencies({ db, batchId, adapter, accessController, executionGate }) {
  if (!db) throw new Error("db is required");
  if (!Number.isInteger(Number(batchId)) || Number(batchId) <= 0) throw codedError("COMMUNICATION_BATCH_INVALID", "batchId is required");
  for (const method of ["inspectCommunicationJob", "dispatchCommunication", "verifyCommunicationResult"]) {
    if (typeof adapter?.[method] !== "function") throw new Error(`adapter.${method} is required`);
  }
  if (typeof accessController?.reserve !== "function") throw new Error("accessController.reserve is required");
  if (typeof executionGate !== "function") throw new Error("executionGate is required");
}

function assertExecutionEnabled(executionGate) {
  const result = executionGate();
  if (result === false || result?.executionEnabled === false) {
    throw codedError("BOSS_COMMUNICATION_CALIBRATION_REQUIRED", "BOSS communication calibration is required before execution");
  }
  return result;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : codedError("COMMUNICATION_ABORTED", "communication execution aborted"));
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

module.exports = { runCommunicationBatch };
