const {
  createCommunicationBatch: createImmutableCommunicationBatch,
  getCommunicationBatch,
  listCommunicationBatchItems,
  setCommunicationBatchStatus,
  resumeInterruptedCommunicationBatch,
  resolveAmbiguousCommunicationItem,
  transitionCommunicationItem,
  communicationBatchSummary,
  communicationQuotaSnapshot
} = require("../../core/communication_batches");
const { communicationCalibrationStatus, assertCommunicationExecutionEnabled } = require("../../core/communication_calibration");
const { appError } = require("../../core/observability");
const { communicationRuntimeBlock, assertBossRuntimeAvailable } = require("../../core/communication_runtime");

function createCommunicationBatch({ db, input = {}, deps = {} }) {
  const quota = communicationQuotaSnapshot(db);
  const jobIds = Array.isArray(input.jobIds) ? input.jobIds : [];
  if (jobIds.length > quota.remaining) {
    throw appError("COMMUNICATION_QUOTA_EXHAUSTED", "communication selection exceeds the remaining daily quota");
  }
  const batch = createImmutableCommunicationBatch(db, {
    workflowRunId: input.workflowRunId,
    planId: input.planId,
    jobIds,
    browserMode: input.browserMode,
    policySnapshot: { calibration: communicationCalibrationStatus() }
  });
  return communicationBatchResult(db, batch);
}

function controlCommunicationBatch({ db, input = {}, deps = {} }) {
  const action = String(input.action || "").trim().toLowerCase();
  const batchId = Number(input.batchId);
  const batch = getCommunicationBatch(db, batchId);
  if (!batch) throw appError("COMMUNICATION_BATCH_NOT_FOUND", "communication batch not found", { statusCode: 404 });
  if (action === "start" || action === "resume") {
    assertCommunicationExecutionEnabled();
    assertBossRuntimeAvailable(db);
    const expected = action === "start" ? ["confirmed"] : ["paused", "interrupted"];
    if (!expected.includes(batch.status)) {
      throw appError("COMMUNICATION_BATCH_STATUS_INVALID", `${action} requires a ${expected.join(" or ")} communication batch`, { statusCode: 409 });
    }
    if (typeof deps.spawnCommunication !== "function") {
      throw appError("COMMUNICATION_PROCESS_LAUNCHER_REQUIRED", "communication process launcher is required", { statusCode: 500 });
    }
    const running = batch.status === "interrupted"
      ? resumeInterruptedCommunicationBatch(db, { batchId }).batch
      : setCommunicationBatchStatus(db, { batchId, status: "running" });
    if (running.status !== "running") {
      throw appError("COMMUNICATION_RESUME_REQUIRES_REVIEW", "请先人工处理结果不明确的岗位，再继续沟通。", { statusCode: 409 });
    }
    deps.spawnCommunication({ db, batch: running });
    return communicationControlResult(db, running);
  }
  if (action !== "discard") {
    throw appError("COMMUNICATION_CONTROL_INVALID", "communication action must be start, resume, or discard");
  }
  const items = listCommunicationBatchItems(db, batchId);
  if (items.some((item) => ["succeeded", "already_communicated"].includes(item.status))) {
    throw appError("COMMUNICATION_DISCARD_PROTECTED", "a completed communication item prevents discard");
  }
  for (const item of items) {
    if (["pending", "opening", "verified"].includes(item.status)) {
      transitionCommunicationItem(db, { itemId: item.id, batchId, expectedStatus: item.status, status: "stopped" });
    } else if (item.status === "click_dispatched") {
      transitionCommunicationItem(db, { itemId: item.id, batchId, expectedStatus: "click_dispatched", status: "ambiguous" });
    }
  }
  const updated = setCommunicationBatchStatus(db, {
    batchId,
    status: "stopped",
    stopCode: "COMMUNICATION_BATCH_DISCARDED",
    stopMessage: "discarded before calibrated execution"
  });
  return communicationControlResult(db, updated);
}

function getCommunicationStatus({ db, batchId, deps = {} }) {
  const batch = getCommunicationBatch(db, batchId);
  if (!batch) throw appError("COMMUNICATION_BATCH_NOT_FOUND", "communication batch not found", { statusCode: 404 });
  return {
    batch,
    summary: communicationBatchSummary(db, batch.id),
    items: listCommunicationBatchItems(db, batch.id),
    quota: communicationQuotaSnapshot(db),
    calibration: communicationCalibrationStatus(),
    runtimeBlock: communicationRuntimeBlock(db)
  };
}

function resolveAmbiguousCommunication({ db, input = {}, deps = {} }) {
  const item = resolveAmbiguousCommunicationItem(db, {
    batchId: input.batchId,
    itemId: input.itemId,
    status: input.status,
    evidenceNote: input.evidenceNote
  });
  return { item, batch: getCommunicationBatch(db, item.batchId), summary: communicationBatchSummary(db, item.batchId) };
}

function communicationBatchResult(db, batch) {
  return {
    batch,
    summary: communicationBatchSummary(db, batch.id),
    items: listCommunicationBatchItems(db, batch.id),
    quota: communicationQuotaSnapshot(db)
  };
}

function communicationControlResult(db, batch) {
  return {
    batch,
    summary: communicationBatchSummary(db, batch.id),
    items: listCommunicationBatchItems(db, batch.id)
  };
}

module.exports = {
  createCommunicationBatch,
  controlCommunicationBatch,
  getCommunicationStatus,
  resolveAmbiguousCommunication
};
