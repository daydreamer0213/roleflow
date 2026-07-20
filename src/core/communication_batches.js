const {
  getSearchPlan,
  getWorkflowRun,
  attachWorkflowCommunication,
  transitionWorkflowRun,
  listDecisionPool,
  listSiteAccessEvents
} = require("./storage");
const { isBossJobUrl } = require("./scoring");
const { PRODUCT_POLICY } = require("./product_policy");
const { listWorkflowReviewCandidates, reconcileCommunicationOutcome } = require("./workflow_inventory");

const BATCH_STATUSES = new Set(["confirmed", "running", "paused", "stopping", "completed", "stopped", "interrupted", "failed"]);
const ITEM_STATUSES = new Set(["pending", "opening", "verified", "click_dispatched", "succeeded", "already_communicated", "job_unavailable", "target_mismatch", "action_unavailable", "ambiguous", "stopped"]);
const TERMINAL_ITEM_STATUSES = new Set(["succeeded", "already_communicated", "job_unavailable", "target_mismatch", "action_unavailable", "ambiguous", "stopped"]);
const ALLOWED_BUCKETS = new Set(["primary", "talk", "backup"]);
const TERMINAL_BATCH_STATUSES = new Set(["completed", "stopped", "interrupted", "failed"]);
const BATCH_TRANSITIONS = new Map([
  ["confirmed", new Set(["running", "stopped"])],
  ["running", new Set(["paused", "stopping", "completed", "interrupted", "failed"])],
  ["paused", new Set(["running", "stopping", "stopped", "interrupted"])],
  ["stopping", new Set(["stopped", "interrupted", "failed"])]
]);
const ITEM_TRANSITIONS = new Map([
  ["pending", new Set(["opening", "stopped"])],
  ["opening", new Set(["verified", "already_communicated", "job_unavailable", "target_mismatch", "action_unavailable", "stopped"])],
  ["verified", new Set(["click_dispatched", "stopped"])],
  ["click_dispatched", new Set(["succeeded", "already_communicated", "ambiguous", "stopped"])],
  ["ambiguous", new Set(["succeeded", "stopped"])]
]);

function createCommunicationBatch(db, input = {}) {
  const workflowRunId = String(input.workflowRunId || "").trim();
  const workflow = workflowRunId ? getWorkflowRun(db, workflowRunId) : null;
  if (workflowRunId && !workflow) throw codedError("WORKFLOW_RUN_NOT_FOUND", "workflow run was not found");
  const planId = positiveInteger(input.planId ?? workflow?.planId, "COMMUNICATION_PLAN_INVALID", "planId is required");
  const plan = getSearchPlan(db, planId);
  if (!plan) throw codedError("COMMUNICATION_PLAN_NOT_FOUND", "communication plan not found");
  if (workflow && (workflow.planId !== planId || workflow.profileId !== plan.profileId)) {
    throw codedError("WORKFLOW_COMMUNICATION_LINK_MISMATCH", "communication plan does not belong to this workflow run");
  }
  if (workflow && workflow.status !== "review_required") {
    throw codedError("WORKFLOW_COMMUNICATION_LINK_INVALID", "workflow communication can only be confirmed during review");
  }
  if (workflow?.communicationBatchId) {
    throw codedError("WORKFLOW_COMMUNICATION_ALREADY_LINKED", "workflow run already has a communication batch");
  }
  const browserMode = String(input.browserMode || "").trim().toLowerCase();
  if (!["edge", "portable"].includes(browserMode)) {
    throw codedError("COMMUNICATION_BROWSER_MODE_INVALID", "browserMode must be edge or portable");
  }
  const jobIds = normalizedJobIds(input.jobIds);
  const now = timestamp(input.now);
  const replacementBuffer = workflow
    ? nonNegativeInteger(workflow.planner?.replacementBuffer ?? PRODUCT_POLICY.operations.workflow.replacementBuffer)
    : 0;
  if (workflow && jobIds.length > workflow.targetSuccessCount + replacementBuffer) {
    throw codedError("WORKFLOW_COMMUNICATION_SELECTION_LIMIT", "workflow selection exceeds target and replacement buffer");
  }
  const policyJson = JSON.stringify({
    ...(input.policySnapshot || {}),
    ...(workflow ? {
      workflowRunId: workflow.id,
      targetSuccessCount: workflow.targetSuccessCount,
      replacementBuffer
    } : {})
  });

  db.exec("BEGIN IMMEDIATE");
  try {
    const quota = communicationQuotaSnapshot(db, { now });
    if (jobIds.length > quota.remaining) {
      throw codedError("COMMUNICATION_QUOTA_EXHAUSTED", "communication selection exceeds the remaining daily quota");
    }
    const jobsById = new Map((workflow
      ? listWorkflowReviewCandidates(db, workflow.id, { now })
      : listDecisionPool(db, { planId }))
      .map((job) => [Number(job.id), job]));
    const conflicts = db.prepare(`SELECT communication_batch_items.id FROM communication_batch_items
      JOIN communication_batches ON communication_batches.id = communication_batch_items.batch_id
      WHERE communication_batch_items.job_id = ?
        AND communication_batch_items.status IN ('click_dispatched', 'ambiguous', 'succeeded', 'already_communicated')
      LIMIT 1`);
    const selected = jobIds.map((jobId) => {
      const job = jobsById.get(jobId);
      if (!job || !ALLOWED_BUCKETS.has(job.decisionBucket) || !isBossJobUrl(job.url)
        || hasUserApplicationStatus(job) || conflicts.get(jobId)) {
        throw codedError("COMMUNICATION_JOB_INELIGIBLE", `job ${jobId} is not eligible for communication`);
      }
      return job;
    });
    const batchId = Number(db.prepare(`INSERT INTO communication_batches(
      site, profile_id, plan_id, browser_mode, status, policy_json, confirmed_at, created_at, updated_at
    ) VALUES ('boss', ?, ?, ?, 'confirmed', ?, ?, ?, ?)`)
      .run(plan.profileId, planId, browserMode, policyJson, now, now, now).lastInsertRowid);
    const insertItem = db.prepare(`INSERT INTO communication_batch_items(
      batch_id, job_id, position, job_url, title_snapshot, company_snapshot, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`);
    selected.forEach((job, index) => {
      insertItem.run(batchId, Number(job.id), index + 1, String(job.url), String(job.title || ""), String(job.company || ""), now);
    });
    if (workflow) {
      const linked = attachWorkflowCommunication(db, { id: workflow.id, communicationBatchId: batchId });
      transitionWorkflowRun(db, {
        id: linked.id,
        status: "review_required",
        metrics: {
          ...linked.metrics,
          selected: selected.length,
          communication: {
            ...(linked.metrics.communication || {}),
            batchId,
            selected: selected.length,
            target: linked.targetSuccessCount
          }
        }
      });
    }
    db.exec("COMMIT");
    return getCommunicationBatch(db, batchId);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function getCommunicationBatch(db, batchId) {
  const row = db.prepare("SELECT * FROM communication_batches WHERE id = ?").get(positiveInteger(batchId, "COMMUNICATION_BATCH_INVALID", "batchId is required"));
  return row ? batchRow(row) : null;
}

function listCommunicationBatchItems(db, batchId) {
  const id = positiveInteger(batchId, "COMMUNICATION_BATCH_INVALID", "batchId is required");
  return db.prepare("SELECT * FROM communication_batch_items WHERE batch_id = ? ORDER BY position ASC, id ASC")
    .all(id)
    .map(itemRow);
}

function setCommunicationBatchStatus(db, input = {}) {
  const batchId = positiveInteger(input.batchId ?? input.id, "COMMUNICATION_BATCH_INVALID", "batchId is required");
  const status = String(input.status || "").trim();
  if (!BATCH_STATUSES.has(status)) throw codedError("COMMUNICATION_BATCH_STATUS_INVALID", "invalid communication batch status");
  const current = getCommunicationBatch(db, batchId);
  if (!current) throw codedError("COMMUNICATION_BATCH_NOT_FOUND", "communication batch not found");
  if (TERMINAL_BATCH_STATUSES.has(current.status)) {
    throw codedError("COMMUNICATION_BATCH_TERMINAL", "terminal communication batch cannot resume");
  }
  if (!BATCH_TRANSITIONS.get(current.status)?.has(status)) {
    throw codedError("COMMUNICATION_BATCH_TRANSITION_INVALID", "invalid communication batch transition");
  }
  if (status === "completed" && hasUnfinishedCommunicationItems(db, batchId)) {
    throw codedError("COMMUNICATION_BATCH_ITEMS_UNFINISHED", "communication batch cannot complete while items remain unfinished");
  }
  const now = timestamp(input.now);
  const startedAt = status === "running" ? current.startedAt || now : current.startedAt;
  const finishedAt = TERMINAL_BATCH_STATUSES.has(status) ? current.finishedAt || now : current.finishedAt;
  const result = db.prepare(`UPDATE communication_batches SET
    status = ?, started_at = ?, finished_at = ?, stop_code = ?, stop_message = ?, updated_at = ?
    WHERE id = ? AND status = ?`).run(
    status,
    startedAt || null,
    finishedAt || null,
    input.stopCode === undefined ? current.stopCode : stringOrNull(input.stopCode),
    input.stopMessage === undefined ? current.stopMessage : stringOrNull(input.stopMessage),
    now,
    batchId,
    current.status
  );
  if (Number(result.changes) === 0) {
    throw codedError("COMMUNICATION_BATCH_TRANSITION_CONFLICT", "communication batch status changed before transition");
  }
  return getCommunicationBatch(db, batchId);
}

function pauseCommunicationBatchAfterReservationFailure(db, input = {}) {
  const batchId = positiveInteger(input.batchId, "COMMUNICATION_BATCH_INVALID", "batchId is required");
  const itemId = positiveInteger(input.itemId, "COMMUNICATION_ITEM_INVALID", "itemId is required");
  const now = timestamp(input.now);
  db.exec("BEGIN IMMEDIATE");
  try {
    const batch = getCommunicationBatch(db, batchId);
    const item = getCommunicationBatchItem(db, itemId);
    if (!batch || batch.status !== "running" || !item || item.batchId !== batchId
      || item.status !== "opening" || item.clickCount !== 0) {
      throw codedError("COMMUNICATION_RESERVATION_ROLLBACK_CONFLICT", "communication reservation rollback state changed");
    }
    const result = db.prepare(`UPDATE communication_batch_items SET
      status = 'pending', started_at = NULL, finished_at = NULL,
      error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ? AND batch_id = ? AND status = 'opening' AND click_count = 0`)
      .run(now, itemId, batchId);
    if (Number(result.changes) !== 1) {
      throw codedError("COMMUNICATION_RESERVATION_ROLLBACK_CONFLICT", "communication item changed before reservation rollback");
    }
    setCommunicationBatchStatus(db, { batchId, status: "paused", now });
    db.exec("COMMIT");
    return { batch: getCommunicationBatch(db, batchId), item: getCommunicationBatchItem(db, itemId) };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function hasUnfinishedCommunicationItems(db, batchId) {
  const terminal = [...TERMINAL_ITEM_STATUSES].map(() => "?").join(", ");
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM communication_batch_items
    WHERE batch_id = ? AND status NOT IN (${terminal})`).get(batchId, ...TERMINAL_ITEM_STATUSES).count) > 0;
}

function transitionCommunicationItem(db, input = {}, options = {}) {
  const itemId = positiveInteger(input.itemId ?? input.id, "COMMUNICATION_ITEM_INVALID", "itemId is required");
  const expectedStatus = String(input.expectedStatus ?? input.fromStatus ?? "").trim();
  const status = String(input.status ?? input.toStatus ?? "").trim();
  if (!ITEM_STATUSES.has(expectedStatus) || !ITEM_STATUSES.has(status)) {
    throw codedError("COMMUNICATION_ITEM_STATUS_INVALID", "valid expectedStatus and status are required");
  }
  const allowedStatuses = ITEM_TRANSITIONS.get(expectedStatus);
  if (!allowedStatuses || !allowedStatuses.has(status)) {
    if (TERMINAL_ITEM_STATUSES.has(expectedStatus)) {
    const code = expectedStatus === "ambiguous"
      ? "COMMUNICATION_AMBIGUOUS_RESOLUTION_REQUIRED"
      : "COMMUNICATION_ITEM_TERMINAL";
    throw codedError(code, "terminal communication item cannot transition");
    }
    throw codedError("COMMUNICATION_ITEM_TRANSITION_INVALID", "invalid communication item transition");
  }
  if (expectedStatus === "ambiguous" && !options.allowAmbiguousResolution) {
    throw codedError("COMMUNICATION_AMBIGUOUS_RESOLUTION_REQUIRED", "ambiguous items must use the resolver");
  }
  const dispatching = expectedStatus === "verified" && status === "click_dispatched";
  if (status === "click_dispatched" && !dispatching) {
    throw codedError("COMMUNICATION_CLICK_TRANSITION_INVALID", "only verified items can dispatch a click");
  }
  if (dispatching) db.exec("BEGIN IMMEDIATE");
  try {
    const current = getCommunicationBatchItem(db, itemId);
    if (!current) throw codedError("COMMUNICATION_ITEM_NOT_FOUND", "communication item not found");
    if (input.batchId !== undefined && Number(input.batchId) !== current.batchId) {
      throw codedError("COMMUNICATION_ITEM_NOT_FOUND", "communication item not found in batch");
    }
    if (dispatching && (current.clickCount >= 1 || db.prepare(`SELECT id FROM communication_batch_items
      WHERE job_id = ? AND click_count = 1 AND id <> ? LIMIT 1`).get(current.jobId, itemId))) {
      throw codedError("COMMUNICATION_CLICK_ALREADY_DISPATCHED", "communication click was already dispatched");
    }
    const clickAudit = dispatching ? validatedClickAudit(input.audit, current) : null;
    const now = timestamp(input.now);
    const terminal = TERMINAL_ITEM_STATUSES.has(status);
    const evidence = input.evidence === undefined ? current.evidence : input.evidence;
    const whereBatch = input.batchId === undefined ? "" : " AND batch_id = ?";
    const params = [
      status,
      dispatching ? 1 : 0,
      JSON.stringify(evidence || {}),
      input.errorCode === undefined ? current.errorCode : stringOrNull(input.errorCode),
      input.errorMessage === undefined ? current.errorMessage : stringOrNull(input.errorMessage),
      status === "pending" ? 0 : 1,
      now,
      dispatching ? 1 : 0,
      now,
      terminal ? 1 : 0,
      now,
      now,
      itemId,
      expectedStatus
    ];
    if (input.batchId !== undefined) params.push(Number(input.batchId));
    const result = db.prepare(`UPDATE communication_batch_items SET
      status = ?,
      click_count = CASE WHEN ? THEN 1 ELSE click_count END,
      evidence_json = ?,
      error_code = ?,
      error_message = ?,
      started_at = CASE WHEN ? THEN COALESCE(started_at, ?) ELSE started_at END,
      clicked_at = CASE WHEN ? THEN ? ELSE clicked_at END,
      finished_at = CASE WHEN ? THEN COALESCE(finished_at, ?) ELSE finished_at END,
      updated_at = ?
      WHERE id = ? AND status = ?${whereBatch}`).run(...params);
    if (Number(result.changes) === 0) {
      const actual = getCommunicationBatchItem(db, itemId);
      if (dispatching && (actual?.clickCount || actual?.status === "click_dispatched")) {
        throw codedError("COMMUNICATION_CLICK_ALREADY_DISPATCHED", "communication click was already dispatched");
      }
      throw codedError("COMMUNICATION_ITEM_TRANSITION_CONFLICT", "communication item status changed before transition");
    }
    if (clickAudit) {
      db.prepare("INSERT INTO events(job_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)")
        .run(current.jobId, clickAudit.eventType, JSON.stringify(clickAudit.payload), now);
    }
    const item = getCommunicationBatchItem(db, itemId);
    if (dispatching) db.exec("COMMIT");
    return item;
  } catch (error) {
    if (dispatching) {
      try { db.exec("ROLLBACK"); } catch {}
    }
    throw error;
  }
}

function validatedClickAudit(value, item) {
  if (!value || typeof value !== "object") {
    throw codedError("COMMUNICATION_CLICK_AUDIT_REQUIRED", "click dispatch requires an audit event");
  }
  const payload = value.payload;
  const expected = { batchId: item.batchId, itemId: item.id, jobId: item.jobId, state: "click_dispatched" };
  const keys = Object.keys(payload || {}).sort().join(",");
  const legacyKeys = "batchId,itemId,jobId,state";
  const workflowKeys = "batchId,communicationBatchId,itemId,jobId,scanBatchId,scanRunId,state,workflowRunId";
  if (value.eventType !== "communication_click" || !payload || typeof payload !== "object"
    || ![legacyKeys, workflowKeys].includes(keys)
    || Object.entries(expected).some(([key, expectedValue]) => payload[key] !== expectedValue)) {
    throw codedError("COMMUNICATION_CLICK_AUDIT_INVALID", "invalid click audit event");
  }
  if (keys === workflowKeys && payload.communicationBatchId !== item.batchId) {
    throw codedError("COMMUNICATION_CLICK_AUDIT_INVALID", "invalid click audit workflow context");
  }
  return { eventType: value.eventType, payload: keys === workflowKeys ? { ...expected,
    workflowRunId: payload.workflowRunId,
    scanRunId: payload.scanRunId,
    scanBatchId: payload.scanBatchId,
    communicationBatchId: payload.communicationBatchId
  } : expected };
}

function resumeInterruptedCommunicationBatch(db, input = {}) {
  const batchId = positiveInteger(input.batchId ?? input.id, "COMMUNICATION_BATCH_INVALID", "batchId is required");
  const now = timestamp(input.now);
  db.exec("BEGIN IMMEDIATE");
  try {
    const batch = getCommunicationBatch(db, batchId);
    if (!batch || batch.status !== "interrupted") {
      throw codedError("COMMUNICATION_BATCH_STATUS_INVALID", "resume requires an interrupted communication batch");
    }
    const items = listCommunicationBatchItems(db, batchId);
    for (const item of items) {
      if (["opening", "verified"].includes(item.status) && item.clickCount === 0) {
        db.prepare(`UPDATE communication_batch_items SET
          status = 'pending', started_at = NULL, finished_at = NULL,
          error_code = NULL, error_message = NULL, updated_at = ?
          WHERE id = ? AND batch_id = ? AND status = ? AND click_count = 0`)
          .run(now, item.id, batchId, item.status);
      } else if (item.status === "click_dispatched") {
        db.prepare(`UPDATE communication_batch_items SET
          status = 'ambiguous', finished_at = COALESCE(finished_at, ?),
          error_code = COALESCE(error_code, 'COMMUNICATION_RESUME_REQUIRES_REVIEW'), updated_at = ?
          WHERE id = ? AND batch_id = ? AND status = 'click_dispatched'`)
          .run(now, now, item.id, batchId);
      }
    }
    const requiresReview = db.prepare(`SELECT 1 FROM communication_batch_items
      WHERE batch_id = ? AND status = 'ambiguous' LIMIT 1`).get(batchId);
    if (requiresReview) {
      db.prepare("UPDATE communication_batches SET updated_at = ? WHERE id = ?").run(now, batchId);
      db.exec("COMMIT");
      return { batch: getCommunicationBatch(db, batchId), requiresReview: true };
    }
    const result = db.prepare(`UPDATE communication_batches SET
      status = 'running', started_at = COALESCE(started_at, ?), finished_at = NULL,
      stop_code = NULL, stop_message = NULL, updated_at = ?
      WHERE id = ? AND status = 'interrupted'`).run(now, now, batchId);
    if (Number(result.changes) !== 1) {
      throw codedError("COMMUNICATION_BATCH_TRANSITION_CONFLICT", "communication batch changed before resume");
    }
    db.exec("COMMIT");
    return { batch: getCommunicationBatch(db, batchId), requiresReview: false };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function resolveAmbiguousCommunicationItem(db, input = {}) {
  const status = String(input.status ?? input.toStatus ?? input.resolution ?? "").trim();
  if (!["succeeded", "stopped"].includes(status)) {
    throw codedError("COMMUNICATION_AMBIGUOUS_RESOLUTION_INVALID", "ambiguous items can only resolve to succeeded or stopped");
  }
  const evidenceNote = String(input.evidenceNote || "").trim().slice(0, 1000);
  if (!evidenceNote) {
    throw codedError("COMMUNICATION_AMBIGUOUS_EVIDENCE_REQUIRED", "manual resolution evidence is required");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = getCommunicationBatchItem(db, positiveInteger(input.itemId ?? input.id, "COMMUNICATION_ITEM_INVALID", "itemId is required"));
    const resolvedAt = timestamp(input.now);
    const evidence = {
      ...(current?.evidence || {}),
      manualResolution: { status, note: evidenceNote, resolvedAt }
    };
    const item = transitionCommunicationItem(db, {
      ...input,
      expectedStatus: "ambiguous",
      status,
      evidence,
      now: resolvedAt
    }, { allowAmbiguousResolution: true });
    db.prepare("INSERT INTO events(job_id, event_type, payload_json, created_at) VALUES (?, 'communication_manual_resolution', ?, ?)")
      .run(item.jobId, JSON.stringify({
        batchId: item.batchId,
        itemId: item.id,
        jobId: item.jobId,
        status,
        note: evidenceNote
      }), resolvedAt);
    if (status === "succeeded") {
      const batch = getCommunicationBatch(db, item.batchId);
      reconcileCommunicationOutcome(db, {
        batch,
        item,
        status,
        now: resolvedAt,
        note: `RoleFlow 批量沟通 #${batch.id}`
      });
    }
    db.exec("COMMIT");
    return item;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function communicationQuotaSnapshot(db, { now } = {}) {
  const at = timestamp(now);
  const endMs = Date.parse(at);
  const startMs = endMs - 24 * 60 * 60 * 1000;
  const since = new Date(startMs).toISOString();
  const used = listSiteAccessEvents(db, { site: "boss", action: "communication_visit", since })
    .filter((event) => {
      const eventMs = Date.parse(event.createdAt);
      return Number.isFinite(eventMs) && eventMs > startMs && eventMs <= endMs;
    }).length;
  const reserved = Number(db.prepare(`SELECT COUNT(*) AS count
    FROM communication_batch_items items
    JOIN communication_batches batches ON batches.id = items.batch_id
    WHERE batches.status IN ('confirmed', 'running', 'paused', 'stopping')
      AND items.status IN ('pending', 'opening', 'verified', 'click_dispatched')`).get().count);
  const limit = Number(PRODUCT_POLICY.operations.bossCommunication.limits["24h"]);
  return { limit, used, reserved, remaining: Math.max(0, limit - used - reserved) };
}

function hasUserApplicationStatus(job) {
  return String(job?.applicationStatus ?? "").length > 0;
}

function communicationBatchSummary(db, batchId) {
  const batch = getCommunicationBatch(db, batchId);
  if (!batch) throw codedError("COMMUNICATION_BATCH_NOT_FOUND", "communication batch not found");
  const statusCounts = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) AS count
    FROM communication_batch_items WHERE batch_id = ? GROUP BY status`).all(batch.id)
    .map((row) => [row.status, Number(row.count)]));
  const total = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
  const terminal = [...TERMINAL_ITEM_STATUSES].reduce((sum, status) => sum + (statusCounts[status] || 0), 0);
  return {
    batchId: batch.id,
    batchStatus: batch.status,
    statusCounts,
    total,
    terminal,
    remaining: total - terminal
  };
}

function getCommunicationBatchItem(db, itemId) {
  const row = db.prepare("SELECT * FROM communication_batch_items WHERE id = ?").get(itemId);
  return row ? itemRow(row) : null;
}

function batchRow(row) {
  return {
    id: Number(row.id),
    site: row.site,
    profileId: Number(row.profile_id),
    planId: Number(row.plan_id),
    browserMode: row.browser_mode,
    status: row.status,
    policySnapshot: parseJson(row.policy_json, {}),
    confirmedAt: row.confirmed_at,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    stopCode: row.stop_code || null,
    stopMessage: row.stop_message || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function itemRow(row) {
  return {
    id: Number(row.id),
    batchId: Number(row.batch_id),
    jobId: Number(row.job_id),
    position: Number(row.position),
    jobUrl: row.job_url,
    titleSnapshot: row.title_snapshot,
    companySnapshot: row.company_snapshot,
    status: row.status,
    clickCount: Number(row.click_count),
    evidence: parseJson(row.evidence_json, {}),
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    startedAt: row.started_at || null,
    clickedAt: row.clicked_at || null,
    finishedAt: row.finished_at || null,
    updatedAt: row.updated_at
  };
}

function normalizedJobIds(value) {
  if (!Array.isArray(value) || !value.length) {
    throw codedError("COMMUNICATION_JOB_INELIGIBLE", "at least one jobId is required");
  }
  const ids = value.map((jobId) => positiveInteger(jobId, "COMMUNICATION_JOB_INELIGIBLE", "invalid jobId"));
  if (new Set(ids).size !== ids.length) {
    throw codedError("COMMUNICATION_JOB_INELIGIBLE", "jobIds must not contain duplicates");
  }
  return ids;
}

function positiveInteger(value, code, message) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw codedError(code, message);
  return number;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function stringOrNull(value) {
  const text = String(value || "").trim();
  return text || null;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  BATCH_STATUSES,
  ITEM_STATUSES,
  TERMINAL_ITEM_STATUSES,
  createCommunicationBatch,
  getCommunicationBatch,
  listCommunicationBatchItems,
  setCommunicationBatchStatus,
  resumeInterruptedCommunicationBatch,
  pauseCommunicationBatchAfterReservationFailure,
  transitionCommunicationItem,
  resolveAmbiguousCommunicationItem,
  communicationBatchSummary,
  communicationQuotaSnapshot
};
