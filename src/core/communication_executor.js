const { PRODUCT_POLICY } = require("./product_policy");
const { reconcileCommunicationOutcome } = require("./workflow_inventory");
const { recordVerifiedCommunicationStart } = require("./candidate_progress");
const { assertCommunicationExecutionEnabled } = require("./communication_calibration");
const { getWorkflowRunByCommunicationBatch, transitionWorkflowRun } = require("./storage");
const { communicationWorkflowMetrics } = require("./workflow_run");
const { workflowLogContext } = require("./observability");
const {
  TERMINAL_ITEM_STATUSES,
  getCommunicationBatch,
  listCommunicationBatchItems,
  pauseCommunicationBatchAfterReservationFailure,
  setCommunicationBatchStatus,
  transitionCommunicationItem,
  communicationBatchSummary
} = require("./communication_batches");
const { communicationAmbiguityStateForBatch } = require("./communication_ambiguity");

const FATAL_CODES = new Set([
  "BOSS_RISK_CONTROL",
  "BOSS_LOGIN_REQUIRED",
  "BROWSER_TIMEOUT",
  "BROWSER_DISCONNECTED",
  "BOSS_DETAIL_PAGE_LOST",
  "BOSS_COMMUNICATION_STRUCTURE_CHANGED",
  "BOSS_OPERATOR_TABS_CHANGED",
  "BOSS_WINDOW_MISMATCH",
  "BOSS_SEARCH_PAGE_LOST",
  "BOSS_COMMUNICATION_PAGE_LOST"
]);
const READ_ONLY_RECOVERY_CODES = new Set([
  "BROWSER_TIMEOUT",
  "BOSS_COMMUNICATION_HELPER_MISSING",
  "BOSS_COMMUNICATION_PAGE_NOT_READY"
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
  beforeReadOnlyRetry = null,
  singleItemId = null,
  executionGate = assertCommunicationExecutionEnabled,
  ambiguityReader = communicationAmbiguityStateForBatch
}) {
  validateDependencies({ db, batchId, adapter, accessController, executionGate, ambiguityReader });
  const authorizedItemId = normalizeSingleItemId(singleItemId);
  assertExecutionEnabled(executionGate);
  let batch = getCommunicationBatch(db, batchId);
  if (!batch) throw codedError("COMMUNICATION_BATCH_NOT_FOUND", "communication batch not found");
  if (["confirmed", "paused", "running"].includes(batch.status)) assertNoUnresolvedAmbiguity(db, batchId, ambiguityReader);
  if (["confirmed", "paused"].includes(batch.status)) batch = setCommunicationBatchStatus(db, { batchId, status: "running" });
  if (batch.status === "stopping") return stopUnfinishedItems(db, batchId, logger);
  if (isTerminalBatch(batch.status)) return communicationBatchSummary(db, batchId);
  if (batch.status !== "running") throw codedError("COMMUNICATION_BATCH_STATUS_INVALID", "communication batch is not runnable");
  ensureWorkflowCommunicating(db, batchId);

  while (true) {
    const control = observeControl(db, batchId, signal, logger);
    if (control) return control;
    if (authorizedItemId === null && workflowTargetReached(db, batchId)) {
      assertNoUnresolvedAmbiguity(db, batchId, ambiguityReader);
      stopPendingReplacements(db, batchId, logger);
      return finalizeBatch(db, batchId, logger);
    }
    const item = listCommunicationBatchItems(db, batchId).find((candidate) => !TERMINAL_ITEM_STATUSES.has(candidate.status));
    if (!item) {
      assertNoUnresolvedAmbiguity(db, batchId, ambiguityReader);
      return finalizeBatch(db, batchId, logger);
    }
    if (authorizedItemId !== null
      && (item.id !== authorizedItemId || item.status !== "pending" || Number(item.clickCount || 0) !== 0)) {
      return interruptAndThrow(
        db,
        batchId,
        codedError("COMMUNICATION_SINGLE_ITEM_MISMATCH", "authorized communication item changed"),
        logger
      );
    }
    if (item.status !== "pending") {
      assertNoUnresolvedAmbiguity(db, batchId, ambiguityReader);
      return recoverIncompleteItem(db, batchId, item, logger);
    }

    try {
      claimPendingCommunicationItem(db, batchId, item, ambiguityReader);
    } catch (error) {
      if (error.code === "COMMUNICATION_ITEM_TRANSITION_CONFLICT") continue;
      throw error;
    }

    const afterClaim = observeControl(db, batchId, signal, logger);
    if (afterClaim) return afterClaim;
    assertNoUnresolvedAmbiguity(db, batchId, ambiguityReader);
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
    try {
      assertNoUnresolvedAmbiguity(db, batchId, ambiguityReader);
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
      return interruptAndThrow(db, batchId, error, logger);
    }

    let inspection;
    try {
      inspection = await inspectWithOneRecovery({
        adapter,
        item,
        signal,
        beforeReadOnlyRetry
      });
    } catch (error) {
      const afterInspectFailure = observeControl(db, batchId, signal, logger);
      if (afterInspectFailure) return afterInspectFailure;
      transitionToUnavailable(db, batchId, item, error);
      if (isFatal(error) || signal?.aborted) return interruptAndThrow(db, batchId, error, logger);
      if (authorizedItemId !== null) return checkpointSingleItemRun(db, batchId, logger);
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
        executionGate,
        ambiguityReader
      });
    } else if (state === "already_communicated") {
      commitVerifiedCommunication(db, {
        batch: getCommunicationBatch(db, batchId),
        item,
        expectedStatus: "opening",
        status: "already_communicated",
        outcome: "already_communicated"
      });
      recordAudit(db, item, "communication_result", "already_communicated");
    } else {
      const finalState = ["job_unavailable", "target_mismatch", "action_unavailable"].includes(state)
        ? state
        : "action_unavailable";
      transitionCommunicationItem(db, {
        itemId: item.id,
        batchId,
        expectedStatus: "opening",
        status: finalState,
        evidence: communicationInspectionEvidence(inspection, finalState)
      });
      reconcileCommunicationOutcome(db, {
        batch: getCommunicationBatch(db, batchId), item, status: finalState, note: `RoleFlow batch #${batchId}`
      });
      recordAudit(db, item, "communication_result", finalState);
    }

    if (authorizedItemId !== null) return checkpointSingleItemRun(db, batchId, logger);
    if (workflowTargetReached(db, batchId)) continue;
    const pacing = await paceAfterTerminalItem({ db, batchId, logger, sleepFn, randomFn, signal });
    if (pacing) return pacing;
  }
}

function normalizeSingleItemId(value) {
  if (value === null || value === undefined || value === "") return null;
  const itemId = Number(value);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    throw codedError("COMMUNICATION_SINGLE_ITEM_INVALID", "single communication item id is invalid");
  }
  return itemId;
}

async function inspectWithOneRecovery({ adapter, item, signal, beforeReadOnlyRetry }) {
  try {
    return await adapter.inspectCommunicationJob(immutableJob(item), signal);
  } catch (error) {
    if (!READ_ONLY_RECOVERY_CODES.has(errorCode(error))
      || Number(item.clickCount || 0) !== 0
      || typeof beforeReadOnlyRetry !== "function") {
      throw error;
    }
    await beforeReadOnlyRetry({ item, error, recoveryAttempt: 1 });
    return adapter.inspectCommunicationJob(immutableJob(item), signal);
  }
}

function claimPendingCommunicationItem(db, batchId, item, ambiguityReader) {
  db.exec("SAVEPOINT communication_item_claim");
  try {
    assertNoUnresolvedAmbiguity(db, batchId, ambiguityReader);
    transitionCommunicationItem(db, { itemId: item.id, batchId, expectedStatus: "pending", status: "opening" });
    assertNoUnresolvedAmbiguity(db, batchId, ambiguityReader);
    db.exec("RELEASE SAVEPOINT communication_item_claim");
  } catch (error) {
    try { db.exec("ROLLBACK TO SAVEPOINT communication_item_claim"); } catch {}
    try { db.exec("RELEASE SAVEPOINT communication_item_claim"); } catch {}
    throw error;
  }
}

function assertNoUnresolvedAmbiguity(db, batchId, ambiguityReader) {
  if (ambiguityReader(db, batchId).blocked) {
    throw codedError("COMMUNICATION_RESUME_REQUIRES_REVIEW", "communication batch contains an unresolved ambiguous item");
  }
}

function communicationInspectionEvidence(inspection = {}, state = "") {
  const statusLabel = String(inspection?.statusLabel || "").trim().slice(0, 100);
  return {
    inspection: {
      state: String(state || inspection?.state || "").trim(),
      ...(statusLabel ? { statusLabel } : {})
    }
  };
}

async function dispatchAndVerify({ db, batchId, batch, item, inspection, adapter, logger, signal, executionGate, ambiguityReader }) {
  const beforeDispatch = observeControl(db, batchId, signal, logger);
  if (beforeDispatch) return beforeDispatch;
  assertNoUnresolvedAmbiguity(db, batchId, ambiguityReader);
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
    audit: clickAudit(db, item)
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
  const resultState = communicationState(result);
  if (["platform_rejected", "transport_failed"].includes(resultState)) {
    transitionCommunicationItem(db, {
      itemId: item.id,
      batchId,
      expectedStatus: "click_dispatched",
      status: resultState,
      evidence: { outcome: communicationOutcomeEvidence(result) },
      errorCode: resultState === "platform_rejected" ? "COMMUNICATION_PLATFORM_REJECTED" : "COMMUNICATION_TRANSPORT_FAILED",
      errorMessage: resultState === "platform_rejected"
        ? "BOSS rejected the communication request."
        : "The communication request did not reach BOSS."
    });
    recordAudit(db, item, "communication_result", resultState);
    return;
  }
  if (resultState !== "succeeded") {
    const ambiguityCode = [
      "COMMUNICATION_ACTION_NOT_TRIGGERED",
      "COMMUNICATION_USER_ACTION_REQUIRED",
      "COMMUNICATION_RESULT_AMBIGUOUS"
    ].includes(String(result?.errorCode || ""))
      ? String(result.errorCode)
      : "COMMUNICATION_RESULT_AMBIGUOUS";
    return ambiguousAndThrow(
      db,
      batchId,
      item,
      codedError(ambiguityCode, "communication result could not be verified"),
      logger,
      communicationOutcomeEvidence(result)
    );
  }
  commitVerifiedCommunication(db, {
    batch,
    item,
    expectedStatus: "click_dispatched",
    status: "succeeded",
    outcome: "succeeded",
    evidence: { outcome: communicationOutcomeEvidence(result) }
  });
  recordAudit(db, item, "communication_result", "succeeded");
}

function commitVerifiedCommunication(db, { batch, item, expectedStatus, status, outcome, evidence }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    transitionCommunicationItem(db, {
      itemId: item.id,
      batchId: batch.id,
      expectedStatus,
      status,
      ...(evidence ? { evidence } : {})
    });
    recordVerifiedCommunicationStart(db, { batch, item, outcome });
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
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
  const workflow = getWorkflowRunByCommunicationBatch(db, batchId);
  if (workflow && ["review_required", "communicating", "interrupted"].includes(workflow.status)) {
    transitionWorkflowRun(db, {
      id: workflow.id,
      status: "stopped",
      successfulCount: successfulCommunicationCount(db, batchId),
      shortfallCode: "WORKFLOW_STOP_REQUESTED"
    });
  }
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
  const completedBatch = getCommunicationBatch(db, batchId);
  const workflow = getWorkflowRunByCommunicationBatch(db, batchId);
  const successfulCount = successfulCommunicationCount(db, batchId);
  if (workflow && workflow.status === "communicating") {
    transitionWorkflowRun(db, {
      id: workflow.id,
      status: "completed",
      successfulCount,
      shortfallCode: successfulCount >= workflow.targetSuccessCount ? "" : "WORKFLOW_SUPPLY_EXHAUSTED",
      metrics: communicationWorkflowMetrics(
        workflow,
        communicationBatchSummary(db, batchId),
        completedBatch
      )
    });
  }
  logger?.info("communication_batch_completed", { batchId, workflowRunId: workflow?.id || null, successfulCount });
  return communicationBatchSummary(db, batchId);
}

function checkpointSingleItemRun(db, batchId, logger) {
  const code = "COMMUNICATION_SINGLE_ITEM_CHECKPOINT";
  let summary;
  let workflow;
  db.exec("SAVEPOINT communication_single_item_checkpoint");
  try {
    setCommunicationBatchStatus(db, {
      batchId,
      status: "interrupted",
      stopCode: code,
      stopMessage: "single communication item acceptance checkpoint"
    });
    const batch = getCommunicationBatch(db, batchId);
    summary = communicationBatchSummary(db, batchId);
    workflow = getWorkflowRunByCommunicationBatch(db, batchId);
    if (workflow?.status === "communicating") {
      transitionWorkflowRun(db, {
        id: workflow.id,
        status: "interrupted",
        successfulCount: successfulCommunicationCount(db, batchId),
        metrics: communicationWorkflowMetrics(workflow, summary, batch),
        errorCode: code,
        errorMessage: "single communication item acceptance checkpoint"
      });
    }
    db.exec("RELEASE SAVEPOINT communication_single_item_checkpoint");
  } catch (error) {
    try { db.exec("ROLLBACK TO SAVEPOINT communication_single_item_checkpoint"); } catch {}
    try { db.exec("RELEASE SAVEPOINT communication_single_item_checkpoint"); } catch {}
    throw error;
  }
  logger?.info("communication_single_item_checkpoint", {
    batchId,
    workflowRunId: workflow?.id || null
  });
  return summary;
}

function ensureWorkflowCommunicating(db, batchId) {
  const workflow = getWorkflowRunByCommunicationBatch(db, batchId);
  if (!workflow) return null;
  if (["review_required", "interrupted"].includes(workflow.status)) {
    return transitionWorkflowRun(db, { id: workflow.id, status: "communicating" });
  }
  if (workflow.status !== "communicating" && workflow.status !== "completed") {
    throw codedError("WORKFLOW_COMMUNICATION_STATE_INVALID", "workflow run is not ready for communication");
  }
  return workflow;
}

function workflowTargetReached(db, batchId) {
  const workflow = getWorkflowRunByCommunicationBatch(db, batchId);
  return Boolean(workflow && workflow.targetSuccessCount > 0
    && successfulCommunicationCount(db, batchId) >= workflow.targetSuccessCount);
}

function successfulCommunicationCount(db, batchId) {
  return listCommunicationBatchItems(db, batchId)
    .filter((item) => item.status === "succeeded" || item.status === "already_communicated")
    .length;
}

function stopPendingReplacements(db, batchId, logger) {
  let stopped = 0;
  for (const item of listCommunicationBatchItems(db, batchId)) {
    if (item.status !== "pending") continue;
    transitionCommunicationItem(db, {
      itemId: item.id,
      batchId,
      expectedStatus: "pending",
      status: "stopped",
      errorCode: "WORKFLOW_TARGET_REACHED"
    });
    stopped += 1;
  }
  logger?.info("workflow_replacements_released", { batchId, stopped });
  return stopped;
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

function ambiguousAndThrow(db, batchId, item, error, logger, evidence = undefined) {
  transitionCommunicationItem(db, {
    itemId: item.id,
    batchId,
    expectedStatus: "click_dispatched",
    status: "ambiguous",
    errorCode: errorCode(error),
    ...(evidence ? { evidence: { outcome: evidence } } : {})
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
  const interruptedBatch = getCommunicationBatch(db, batchId);
  const summary = communicationBatchSummary(db, batchId);
  const workflow = getWorkflowRunByCommunicationBatch(db, batchId);
  if (workflow && workflow.status === "communicating") {
    transitionWorkflowRun(db, {
      id: workflow.id,
      status: "interrupted",
      successfulCount: successfulCommunicationCount(db, batchId),
      metrics: communicationWorkflowMetrics(workflow, summary, interruptedBatch),
      errorCode: errorCode(error),
      errorMessage: "communication execution interrupted"
    });
  }
  logger?.warn("communication_batch_interrupted", { batchId, code: errorCode(error) });
  throw error;
}

function recordAudit(db, item, eventType, state) {
  db.prepare("INSERT INTO events(job_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)")
    .run(item.jobId, eventType, JSON.stringify({
      ...workflowAuditContext(db, item.batchId),
      batchId: item.batchId,
      itemId: item.id,
      jobId: item.jobId,
      state
    }), new Date().toISOString());
}

function clickAudit(db, item) {
  return {
    eventType: "communication_click",
    payload: {
      ...workflowAuditContext(db, item.batchId),
      batchId: item.batchId,
      itemId: item.id,
      jobId: item.jobId,
      state: "click_dispatched"
    }
  };
}

function workflowAuditContext(db, batchId) {
  const workflow = getWorkflowRunByCommunicationBatch(db, batchId);
  return workflowLogContext({ ...(workflow || {}), communicationBatchId: batchId });
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

function communicationOutcomeEvidence(value = {}) {
  const evidence = value?.evidence || {};
  const endpoints = Array.isArray(evidence.endpoints) ? evidence.endpoints.slice(0, 12) : [];
  const categories = new Set(["success", "http_failure", "business_rejected", "network_rejected", "network_timeout", "network_aborted", "response_unparsed"]);
  const pageStates = new Set(["request_accepted", "request_rejected", "request_failed", "request_conflict", "request_unparsed", "observer_timeout", "no_matching_request", "request_pending", "succeeded", "page_unverified", "confirmation_dialog"]);
  return {
    endpoints: endpoints.map((endpoint) => {
      const endpointKind = String(endpoint?.endpointKind || "").trim();
      if (!["chat_config", "friend_add"].includes(endpointKind)) return null;
      const httpStatus = Number(endpoint?.httpStatus);
      const businessCode = String(endpoint?.businessCode || "").trim();
      const businessCategory = String(endpoint?.businessCategory || "").trim();
      const elapsedMs = Number(endpoint?.elapsedMs);
      return {
        endpointKind,
        ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
        ...(/^[A-Za-z0-9_-]{1,32}$/.test(businessCode) ? { businessCode } : {}),
        ...(categories.has(businessCategory) ? { businessCategory } : {}),
        ...(Number.isFinite(elapsedMs) && elapsedMs >= 0 ? { elapsedMs: Math.min(60_000, Math.floor(elapsedMs)) } : {})
      };
    }).filter(Boolean),
    ...(pageStates.has(String(evidence.pageState || "").trim()) ? { pageState: String(evidence.pageState).trim() } : {})
  };
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

function validateDependencies({ db, batchId, adapter, accessController, executionGate, ambiguityReader }) {
  if (!db) throw new Error("db is required");
  if (!Number.isInteger(Number(batchId)) || Number(batchId) <= 0) throw codedError("COMMUNICATION_BATCH_INVALID", "batchId is required");
  for (const method of ["inspectCommunicationJob", "dispatchCommunication", "verifyCommunicationResult"]) {
    if (typeof adapter?.[method] !== "function") throw new Error(`adapter.${method} is required`);
  }
  if (typeof accessController?.reserve !== "function") throw new Error("accessController.reserve is required");
  if (typeof executionGate !== "function") throw new Error("executionGate is required");
  if (typeof ambiguityReader !== "function") throw new Error("ambiguityReader is required");
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
