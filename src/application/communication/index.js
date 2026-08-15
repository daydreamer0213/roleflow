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
const { communicationAmbiguityStateForBatch } = require("../../core/communication_ambiguity");
const { communicationCalibrationStatus, assertCommunicationExecutionEnabled } = require("../../core/communication_calibration");
const { appError } = require("../../core/observability");
const { communicationRuntimeBlock, assertCommunicationRuntimeAvailable } = require("../../core/communication_runtime");

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
  const control = validateCommunicationControl({ db, input, deps });
  const { action, batchId, batch, singleItem } = control;
  if (action === "start" || action === "resume") {
    const running = batch.status === "interrupted"
      ? resumeInterruptedCommunicationBatch(db, { batchId }).batch
      : setCommunicationBatchStatus(db, { batchId, status: "running" });
    if (running.status !== "running") {
      throw appError("COMMUNICATION_RESUME_REQUIRES_REVIEW", "请先人工处理结果不明确的岗位，再继续沟通。", { statusCode: 409 });
    }
    deps.spawnCommunication({
      db,
      batch: running,
      ...(singleItem ? { singleItemId: singleItem.id } : {})
    });
    return communicationControlResult(db, running);
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

function validateCommunicationControl({ db, input = {}, deps = {} }) {
  const requestedAction = String(input.action || "").trim().toLowerCase();
  const singleItemAction = requestedAction === "start_one" || requestedAction === "resume_one";
  const action = requestedAction.replace(/_one$/, "");
  const batchId = Number(input.batchId);
  const batch = getCommunicationBatch(db, batchId);
  if (!batch) throw appError("COMMUNICATION_BATCH_NOT_FOUND", "communication batch not found", { statusCode: 404 });
  if (action === "start" || action === "resume") {
    const expected = action === "start" ? ["confirmed"] : ["paused", "interrupted"];
    if (!expected.includes(batch.status)) {
      throw appError("COMMUNICATION_BATCH_STATUS_INVALID", `${action} requires a ${expected.join(" or ")} communication batch`, { statusCode: 409 });
    }
    const readAmbiguity = deps.communicationAmbiguityReader || communicationAmbiguityStateForBatch;
    if (readAmbiguity(db, batchId).blocked) {
      throw appError("COMMUNICATION_RESUME_REQUIRES_REVIEW", "请先人工处理结果不明确的岗位，再继续沟通。", { statusCode: 409 });
    }
    const calibration = (deps.communicationCalibrationReader || communicationCalibrationStatus)();
    if (calibration.acceptance === "e2e_pending" && !singleItemAction) {
      throw appError("COMMUNICATION_E2E_SINGLE_ITEM_REQUIRED", "端到端验收期间每次只能确认一个岗位。", { statusCode: 409 });
    }
    const singleItem = singleItemAction
      ? authorizedSingleCommunicationItem(listCommunicationBatchItems(db, batchId), input.itemId)
      : null;
    assertCommunicationExecutionEnabled();
    assertCommunicationRuntimeAvailable(db);
    if (typeof deps.spawnCommunication !== "function") {
      throw appError("COMMUNICATION_PROCESS_LAUNCHER_REQUIRED", "communication process launcher is required", { statusCode: 500 });
    }
    return { requestedAction, action, batchId, batch, singleItem };
  }
  if (action !== "discard") {
    throw appError("COMMUNICATION_CONTROL_INVALID", "communication action must be start, resume, start_one, resume_one, or discard");
  }
  return { requestedAction, action, batchId, batch, singleItem: null };
}

function authorizedSingleCommunicationItem(items, itemId) {
  const next = items.find((item) => item.status === "pending");
  const requestedId = Number(itemId);
  if (!next
    || !Number.isInteger(requestedId)
    || requestedId <= 0
    || next.id !== requestedId
    || Number(next.clickCount || 0) !== 0) {
    throw appError("COMMUNICATION_SINGLE_ITEM_MISMATCH", "授权岗位已变化，请刷新后重新确认。", { statusCode: 409 });
  }
  return next;
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

async function rebindCommunicationBrowser({ db, input = {}, deps = {} }) {
  const batchId = Number(input.batchId);
  const batch = getCommunicationBatch(db, batchId);
  if (!batch) throw appError("COMMUNICATION_BATCH_NOT_FOUND", "communication batch not found", { statusCode: 404 });
  if (batch.browserMode !== "edge") {
    throw appError("COMMUNICATION_BROWSER_REBIND_UNAVAILABLE", "只有当前 Edge 批次可以重新检查浏览器页面。", { statusCode: 409 });
  }
  if (!["paused", "interrupted"].includes(batch.status)) {
    throw appError("COMMUNICATION_BATCH_STATUS_INVALID", "只有已暂停或已中断的批次可以重新检查浏览器页面。", { statusCode: 409 });
  }
  const items = listCommunicationBatchItems(db, batchId);
  const readAmbiguity = deps.communicationAmbiguityReader || communicationAmbiguityStateForBatch;
  if (items.some((item) => ["click_dispatched", "ambiguous"].includes(item.status))
    || readAmbiguity(db, batchId).blocked) {
    throw appError("COMMUNICATION_BROWSER_REBIND_BLOCKED", "请先人工确认已发出操作的沟通结果，再重新检查浏览器页面。", { statusCode: 409 });
  }
  if (!batch.runtime?.browser) {
    throw appError("COMMUNICATION_BROWSER_BINDING_REQUIRED", "该批次还没有可更新的浏览器页面绑定。", { statusCode: 409 });
  }
  assertCommunicationRuntimeAvailable(db);
  if (typeof deps.inspectAndBindCommunicationBrowser !== "function") {
    throw appError("COMMUNICATION_BROWSER_REBINDER_REQUIRED", "communication browser rebinder is required", { statusCode: 500 });
  }
  const rebound = await deps.inspectAndBindCommunicationBrowser({ db, batch });
  return communicationControlResult(db, rebound);
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
  validateCommunicationControl,
  getCommunicationStatus,
  rebindCommunicationBrowser,
  resolveAmbiguousCommunication
};
