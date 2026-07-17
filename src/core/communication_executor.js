const { PRODUCT_POLICY } = require("./product_policy");
const { markCandidateJob } = require("./storage");
const {
  TERMINAL_ITEM_STATUSES,
  getCommunicationBatch,
  listCommunicationBatchItems,
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
  signal = null
}) {
  validateDependencies({ db, batchId, adapter, accessController });
  let batch = getCommunicationBatch(db, batchId);
  if (!batch) throw codedError("COMMUNICATION_BATCH_NOT_FOUND", "communication batch not found");
  if (["confirmed", "paused"].includes(batch.status)) {
    batch = setCommunicationBatchStatus(db, { batchId, status: "running" });
  }
  if (batch.status === "stopping") return stopPendingItems(db, batchId, logger);
  if (isTerminalBatch(batch.status)) return communicationBatchSummary(db, batchId);
  if (batch.status !== "running") throw codedError("COMMUNICATION_BATCH_STATUS_INVALID", "communication batch is not runnable");

  while (true) {
    throwIfAborted(signal, db, batchId);
    batch = getCommunicationBatch(db, batchId);
    if (batch.status === "paused") {
      logger?.info("communication_batch_paused", { batchId });
      return communicationBatchSummary(db, batchId);
    }
    if (batch.status === "stopping") return stopPendingItems(db, batchId, logger);
    if (isTerminalBatch(batch.status)) return communicationBatchSummary(db, batchId);

    const items = listCommunicationBatchItems(db, batchId);
    const pending = items.find((item) => item.status === "pending");
    if (!pending) return finalizeBatch(db, batchId, logger);

    await accessController.reserve("communication_visit", {
      batchId: pending.batchId,
      itemId: pending.id,
      jobId: pending.jobId
    });
    throwIfAborted(signal, db, batchId);
    transitionCommunicationItem(db, { itemId: pending.id, batchId, expectedStatus: "pending", status: "opening" });

    let inspection;
    try {
      inspection = await adapter.inspectCommunicationJob(immutableJob(pending), signal);
    } catch (error) {
      transitionToUnavailable(db, batchId, pending, error);
      if (isFatal(error) || signal?.aborted) return interruptAndThrow(db, batchId, error, logger);
      await paceAfterTerminalItem({ db, batchId, logger, sleepFn, randomFn, signal });
      continue;
    }

    const state = communicationState(inspection);
    if (state === "ready") {
      await dispatchAndVerify({ db, batchId, batch, pending, inspection, adapter, logger, signal });
    } else if (state === "already_communicated") {
      transitionCommunicationItem(db, { itemId: pending.id, batchId, expectedStatus: "opening", status: "already_communicated" });
      markApplied(db, batch, pending);
      recordAudit(db, pending, "communication_result", "already_communicated");
    } else {
      const finalState = ["job_unavailable", "target_mismatch", "action_unavailable"].includes(state)
        ? state
        : "action_unavailable";
      transitionCommunicationItem(db, { itemId: pending.id, batchId, expectedStatus: "opening", status: finalState });
      recordAudit(db, pending, "communication_result", finalState);
    }

    const pacing = await paceAfterTerminalItem({ db, batchId, logger, sleepFn, randomFn, signal });
    if (pacing) return pacing;
  }
}

async function dispatchAndVerify({ db, batchId, batch, pending, inspection, adapter, logger, signal }) {
  transitionCommunicationItem(db, { itemId: pending.id, batchId, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(db, { itemId: pending.id, batchId, expectedStatus: "verified", status: "click_dispatched" });
  recordAudit(db, pending, "communication_click", "click_dispatched");

  try {
    await adapter.dispatchCommunication(inspection, signal);
  } catch (error) {
    return ambiguousAndThrow(db, batchId, pending, error, logger);
  }

  let result;
  try {
    result = await adapter.verifyCommunicationResult(immutableJob(pending), signal);
  } catch (error) {
    return ambiguousAndThrow(db, batchId, pending, error, logger);
  }
  if (communicationState(result) !== "succeeded") {
    return ambiguousAndThrow(
      db,
      batchId,
      pending,
      codedError("COMMUNICATION_RESULT_AMBIGUOUS", "communication result could not be verified"),
      logger
    );
  }
  transitionCommunicationItem(db, { itemId: pending.id, batchId, expectedStatus: "click_dispatched", status: "succeeded" });
  markApplied(db, batch, pending);
  recordAudit(db, pending, "communication_result", "succeeded");
}

async function paceAfterTerminalItem({ db, batchId, logger, sleepFn, randomFn, signal }) {
  if (!listCommunicationBatchItems(db, batchId).some((item) => item.status === "pending")) return null;
  let remainingMs = randomDelay(PRODUCT_POLICY.operations.bossCommunication.delayMs, randomFn);
  logger?.info("communication_batch_pacing", { batchId, delayMs: remainingMs });
  while (remainingMs > 0) {
    throwIfAborted(signal, db, batchId);
    const batch = getCommunicationBatch(db, batchId);
    if (batch.status === "paused") {
      logger?.info("communication_batch_paused", { batchId });
      return communicationBatchSummary(db, batchId);
    }
    if (batch.status === "stopping") return stopPendingItems(db, batchId, logger);
    const sliceMs = Math.min(1000, remainingMs);
    await sleepFn(sliceMs, signal);
    remainingMs -= sliceMs;
  }
  throwIfAborted(signal, db, batchId);
  const batch = getCommunicationBatch(db, batchId);
  if (batch.status === "paused") return communicationBatchSummary(db, batchId);
  if (batch.status === "stopping") return stopPendingItems(db, batchId, logger);
  return null;
}

function stopPendingItems(db, batchId, logger) {
  for (const item of listCommunicationBatchItems(db, batchId)) {
    if (item.status !== "pending") continue;
    transitionCommunicationItem(db, { itemId: item.id, batchId, expectedStatus: "pending", status: "stopped" });
    recordAudit(db, item, "communication_result", "stopped");
  }
  const batch = getCommunicationBatch(db, batchId);
  if (!isTerminalBatch(batch.status)) setCommunicationBatchStatus(db, { batchId, status: "stopped", stopCode: "COMMUNICATION_STOP_REQUESTED" });
  logger?.info("communication_batch_stopped", { batchId });
  return communicationBatchSummary(db, batchId);
}

function finalizeBatch(db, batchId, logger) {
  const batch = getCommunicationBatch(db, batchId);
  if (batch.status === "paused") return communicationBatchSummary(db, batchId);
  if (batch.status === "stopping") return stopPendingItems(db, batchId, logger);
  const unfinished = listCommunicationBatchItems(db, batchId).find((item) => !TERMINAL_ITEM_STATUSES.has(item.status));
  if (unfinished) {
    const error = codedError("COMMUNICATION_RESUME_REQUIRES_REVIEW", "communication batch contains an unfinished item");
    return interruptAndThrow(db, batchId, error, logger);
  }
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

function markApplied(db, batch, item) {
  markCandidateJob(db, { profileId: batch.profileId, planId: batch.planId, jobId: item.jobId, status: "applied" });
}

function recordAudit(db, item, eventType, state) {
  db.prepare("INSERT INTO events(job_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)")
    .run(item.jobId, eventType, JSON.stringify({ batchId: item.batchId, itemId: item.id, jobId: item.jobId, state }), new Date().toISOString());
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
  return Math.floor(low + random * (high - low + 1));
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

function throwIfAborted(signal, db, batchId) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error
    ? signal.reason
    : codedError("COMMUNICATION_ABORTED", "communication execution aborted");
  interruptAndThrow(db, batchId, error, null);
}

function validateDependencies({ db, batchId, adapter, accessController }) {
  if (!db) throw new Error("db is required");
  if (!Number.isInteger(Number(batchId)) || Number(batchId) <= 0) throw codedError("COMMUNICATION_BATCH_INVALID", "batchId is required");
  for (const method of ["inspectCommunicationJob", "dispatchCommunication", "verifyCommunicationResult"]) {
    if (typeof adapter?.[method] !== "function") throw new Error(`adapter.${method} is required`);
  }
  if (typeof accessController?.reserve !== "function") throw new Error("accessController.reserve is required");
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
