const crypto = require("node:crypto");
const { nowIso, parseJson, optionalPositiveInteger, nullableText, immediateTransaction } = require("./storage_shared");
const { MIN_COMPLETE_JOB_DESCRIPTION_LENGTH, DETAIL_UNVERIFIED_TAG } = require("../core/job_description_readiness");

const WORKFLOW_RUN_STATUSES = [
  "created",
  "scanning",
  "analyzing",
  "review_required",
  "communicating",
  "paused",
  "completed",
  "interrupted",
  "failed",
  "stopped"
];
const ACTIVE_WORKFLOW_RUN_STATUSES = ["created", "scanning", "analyzing", "review_required", "communicating", "interrupted", "paused"];
const TERMINAL_WORKFLOW_RUN_STATUSES = new Set(["completed", "failed", "stopped"]);
const WORKFLOW_CONTROL_STATES = new Set(["none", "pause_requested", "stop_requested"]);
const WORKFLOW_TIMEOUT_CIRCUIT_OPEN_CODE = "MODEL_TIMEOUT_CIRCUIT_OPEN";
const WORKFLOW_DETAIL_REQUIRED_CODE = "DETAIL_REQUIRED";
const WORKFLOW_DETAIL_REQUIRED_KIND = "waiting_for_detail";
const WORKFLOW_OBSERVATION_QUALITY_JSON_SQL = `CASE
  WHEN json_valid(COALESCE(o.quality_tags_json, '[]')) THEN CASE
    WHEN json_type(COALESCE(o.quality_tags_json, '[]')) = 'array' THEN COALESCE(o.quality_tags_json, '[]')
    ELSE '["${DETAIL_UNVERIFIED_TAG}"]'
  END
  ELSE '["${DETAIL_UNVERIFIED_TAG}"]'
END`;
const WORKFLOW_OBSERVATION_READY_SQL = `
  length(trim(COALESCE(o.description, ''))) >= ${MIN_COMPLETE_JOB_DESCRIPTION_LENGTH}
  AND NOT EXISTS (
    SELECT 1 FROM json_each(${WORKFLOW_OBSERVATION_QUALITY_JSON_SQL}) quality_tag
    WHERE quality_tag.value = '${DETAIL_UNVERIFIED_TAG}'
  )
`;
const WORKFLOW_OBSERVATION_LOCAL_SKIP_SQL = `CASE
  WHEN json_valid(COALESCE(o.analysis_json, '{}')) THEN (
    json_extract(o.analysis_json, '$.decisionSource') IN ('local_rules', 'hard_boundary')
    OR json_extract(o.analysis_json, '$.semanticStatus') IN ('rule_only', 'blocked')
  )
  ELSE 0
END`;
const WORKFLOW_TRANSITIONS = Object.freeze({
  created: new Set(["scanning", "review_required", "interrupted", "failed", "stopped"]),
  scanning: new Set(["analyzing", "paused", "interrupted", "failed", "stopped"]),
  analyzing: new Set(["paused", "review_required", "interrupted", "failed", "stopped"]),
  paused: new Set(["scanning", "analyzing", "stopped"]),
  review_required: new Set(["communicating", "completed", "stopped"]),
  communicating: new Set(["completed", "interrupted", "failed", "stopped"]),
  interrupted: new Set(["scanning", "analyzing", "review_required", "communicating", "failed", "stopped"]),
  completed: new Set(),
  failed: new Set(),
  stopped: new Set()
});


function createWorkflowRun(db, input = {}) {
  const id = String(input.id || crypto.randomUUID()).trim();
  const profileId = optionalPositiveInteger(input.profileId, "profileId");
  const planId = optionalPositiveInteger(input.planId, "planId");
  const localDay = String(input.localDay || "").trim();
  const sequence = optionalPositiveInteger(input.sequence, "sequence");
  if (!id) throw workflowRunError("WORKFLOW_RUN_ID_REQUIRED", "workflow run id is required");
  if (!profileId || !planId) throw workflowRunError("WORKFLOW_OWNER_REQUIRED", "workflow run profile and plan are required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDay)) {
    throw workflowRunError("WORKFLOW_LOCAL_DAY_INVALID", "workflow local day must use YYYY-MM-DD");
  }
  if (![1, 2, 3].includes(sequence)) {
    throw workflowRunError("WORKFLOW_SEQUENCE_INVALID", "workflow run sequence must be 1, 2, or 3");
  }
  const owner = db.prepare("SELECT profile_id FROM search_plans WHERE id = ?").get(planId);
  if (!owner || Number(owner.profile_id) !== profileId) {
    throw workflowRunError("WORKFLOW_PLAN_PROFILE_MISMATCH", "workflow plan does not belong to the selected profile");
  }
  const now = String(input.createdAt || nowIso());
  try {
    db.prepare(`INSERT INTO workflow_runs(
      id, profile_id, plan_id, local_day, sequence, status,
      target_success_count, successful_count, inventory_count, candidate_gap, scan_needed,
      keywords_json, budget_json, planner_json, metrics_json,
      shortfall_code, error_code, error_message, model_config_revision, last_activity_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        profileId,
        planId,
        localDay,
        sequence,
        nonNegativeInteger(input.targetSuccessCount),
        nonNegativeInteger(input.successfulCount),
        nonNegativeInteger(input.inventoryCount),
        nonNegativeInteger(input.candidateGap),
        input.scanNeeded === false ? 0 : 1,
        JSON.stringify(Array.isArray(input.keywords) ? input.keywords : []),
        JSON.stringify(input.budget || {}),
        JSON.stringify(input.planner || {}),
        JSON.stringify(input.metrics || {}),
        nullableText(input.shortfallCode),
        nullableText(input.errorCode),
        nullableText(input.errorMessage, 2000),
        nullableText(input.modelConfigRevision),
        now,
        now,
        now
      );
  } catch (error) {
    if (/workflow_runs\.profile_id, workflow_runs\.local_day, workflow_runs\.sequence|UNIQUE constraint failed: workflow_runs/i.test(error.message)) {
      throw workflowRunError("WORKFLOW_RUN_SLOT_EXISTS", "workflow run slot already exists for this local day");
    }
    throw error;
  }
  return getWorkflowRun(db, id);
}

function getWorkflowRun(db, id) {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) return null;
  const row = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(normalizedId);
  return row ? workflowRunRow(row) : null;
}

function getWorkflowRunByCommunicationBatch(db, communicationBatchId) {
  const batchId = optionalPositiveInteger(communicationBatchId, "communicationBatchId");
  if (!batchId) return null;
  const row = db.prepare("SELECT * FROM workflow_runs WHERE communication_batch_id = ?").get(batchId);
  return row ? workflowRunRow(row) : null;
}

function listWorkflowRuns(db, filters = {}) {
  const clauses = [];
  const params = [];
  const profileId = optionalPositiveInteger(filters.profileId, "profileId");
  const planId = optionalPositiveInteger(filters.planId, "planId");
  if (profileId) { clauses.push("profile_id = ?"); params.push(profileId); }
  if (planId) { clauses.push("plan_id = ?"); params.push(planId); }
  if (filters.localDay) { clauses.push("local_day = ?"); params.push(String(filters.localDay)); }
  const statuses = (Array.isArray(filters.statuses) ? filters.statuses : [])
    .map((status) => String(status || "").trim())
    .filter((status) => WORKFLOW_RUN_STATUSES.includes(status));
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  const limit = Math.max(1, Math.min(500, Number(filters.limit) || 100));
  params.push(limit);
  return db.prepare(`SELECT * FROM workflow_runs
    ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY local_day DESC, sequence DESC, created_at DESC LIMIT ?`)
    .all(...params)
    .map(workflowRunRow);
}

function getActiveWorkflowRun(db, filters = {}) {
  return listWorkflowRuns(db, {
    ...filters,
    statuses: ACTIVE_WORKFLOW_RUN_STATUSES,
    limit: 1
  })[0] || null;
}

function transitionWorkflowRun(db, input = {}) {
  const id = String(input.id || input.workflowRunId || "").trim();
  const nextStatus = String(input.status || "").trim();
  const current = getWorkflowRun(db, id);
  if (!current) throw workflowRunError("WORKFLOW_RUN_NOT_FOUND", "workflow run was not found");
  if (!WORKFLOW_RUN_STATUSES.includes(nextStatus)) {
    throw workflowRunError("WORKFLOW_STATUS_INVALID", "workflow run status is invalid");
  }
  if (nextStatus !== current.status && !WORKFLOW_TRANSITIONS[current.status]?.has(nextStatus)) {
    throw workflowRunError("WORKFLOW_TRANSITION_INVALID", `workflow run cannot transition from ${current.status} to ${nextStatus}`);
  }
  const now = String(input.updatedAt || nowIso());
  const resumed = (current.status === "interrupted" || current.status === "paused")
    && ["scanning", "analyzing", "review_required", "communicating"].includes(nextStatus);
  const errorCode = resumed ? null
    : Object.hasOwn(input, "errorCode") ? nullableText(input.errorCode)
      : nullableText(current.errorCode);
  const errorMessage = resumed ? null
    : Object.hasOwn(input, "errorMessage") ? nullableText(input.errorMessage, 2000)
      : nullableText(current.errorMessage, 2000);
  const metrics = Object.hasOwn(input, "metrics") ? input.metrics : current.metrics;
  const controlState = Object.hasOwn(input, "controlState")
    ? String(input.controlState || "none")
    : current.controlState || "none";
  if (!WORKFLOW_CONTROL_STATES.has(controlState)) {
    throw workflowRunError("WORKFLOW_CONTROL_INVALID", "workflow run control state is invalid");
  }
  const interruptedResumePhase = nextStatus === "interrupted"
    && ["scanning", "analyzing"].includes(current.status)
    ? current.status

    : null;
  const resumePhase = Object.hasOwn(input, "resumePhase")
    ? (input.resumePhase ? String(input.resumePhase) : null)
    : (resumed ? null : (current.resumePhase || interruptedResumePhase));
  if (resumePhase && !["scanning", "analyzing"].includes(resumePhase)) {
    throw workflowRunError("WORKFLOW_RESUME_PHASE_INVALID", "workflow run resume phase is invalid");
  }
  const progressRevision = Object.hasOwn(input, "progressRevision")
    ? nonNegativeInteger(input.progressRevision)
    : current.progressRevision;
  const recoveryGeneration = Object.hasOwn(input, "recoveryGeneration")
    ? nonNegativeInteger(input.recoveryGeneration)
    : current.recoveryGeneration;
  const circuitTimeoutJobCount = Object.hasOwn(input, "circuitTimeoutJobCount")
    ? nonNegativeInteger(input.circuitTimeoutJobCount)
    : current.circuitTimeoutJobCount;
  const lifetimeTimeoutJobCount = Object.hasOwn(input, "lifetimeTimeoutJobCount")
    ? nonNegativeInteger(input.lifetimeTimeoutJobCount)
    : current.lifetimeTimeoutJobCount;
  const modelConfigRevision = Object.hasOwn(input, "modelConfigRevision")
    ? nullableText(input.modelConfigRevision)
    : nullableText(current.modelConfigRevision);
  const lastActivityAt = Object.hasOwn(input, "lastActivityAt")
    ? String(input.lastActivityAt || now)
    : String(current.lastActivityAt || now);
  const platformAccessStartedAt = Object.hasOwn(input, "platformAccessStartedAt")
    ? (input.platformAccessStartedAt ? String(input.platformAccessStartedAt) : null)
    : String(current.platformAccessStartedAt || "");
  db.prepare(`UPDATE workflow_runs SET
      status = ?,
      successful_count = ?,
      inventory_count = ?,
      metrics_json = ?,
      shortfall_code = ?,
      error_code = ?,
      error_message = ?,
      control_state = ?,
      resume_phase = ?,
      recovery_generation = ?,
      circuit_timeout_job_count = ?,
      lifetime_timeout_job_count = ?,
      progress_revision = ?,
      last_activity_at = ?,
      model_config_revision = ?,
      platform_access_started_at = ?,
      started_at = CASE WHEN ? IN ('scanning','review_required') THEN COALESCE(started_at, ?) ELSE started_at END,
      review_ready_at = CASE WHEN ? = 'review_required' THEN COALESCE(review_ready_at, ?) ELSE review_ready_at END,
      finished_at = CASE WHEN ? IN ('completed','failed','stopped') THEN COALESCE(finished_at, ?) ELSE finished_at END,
      updated_at = ?
    WHERE id = ?`)
    .run(
      nextStatus,
      Object.hasOwn(input, "successfulCount") ? nonNegativeInteger(input.successfulCount) : current.successfulCount,
      Object.hasOwn(input, "inventoryCount") ? nonNegativeInteger(input.inventoryCount) : current.inventoryCount,
      JSON.stringify(metrics || {}),
      Object.hasOwn(input, "shortfallCode") ? nullableText(input.shortfallCode) : nullableText(current.shortfallCode),
      errorCode,
      errorMessage,
      controlState,
      resumePhase,
      recoveryGeneration,
      circuitTimeoutJobCount,
      lifetimeTimeoutJobCount,
      progressRevision,
      lastActivityAt,
      modelConfigRevision,
      platformAccessStartedAt || null,
      nextStatus,
      now,
      nextStatus,
      now,
      nextStatus,
      now,
      now,
      id
    );
  return getWorkflowRun(db, id);
}

function attachWorkflowScan(db, input = {}) {
  return immediateTransaction(db, () => {
    const id = String(input.id || input.workflowRunId || "").trim();
    const run = getWorkflowRun(db, id);
    if (!run) throw workflowRunError("WORKFLOW_RUN_NOT_FOUND", "workflow run was not found");
    if (!["scanning", "analyzing", "interrupted"].includes(run.status)) {
      throw workflowRunError(
        "WORKFLOW_SCAN_LINK_INVALID",
        "workflow execution can only be attached during scanning, analyzing, or interruption"
      );
    }
    const scanRunId = String(input.scanRunId || "").trim();
    const scanBatchId = optionalPositiveInteger(input.scanBatchId, "scanBatchId");
    if (!scanRunId || !scanBatchId) throw workflowRunError("WORKFLOW_SCAN_LINK_REQUIRED", "scan run and batch are required");
    const owner = db.prepare(`
      SELECT id
      FROM workflow_runs
      WHERE scan_run_id = ? AND id <> ?
      LIMIT 1
    `).get(scanRunId, id);
    if (owner) {
      throw workflowRunError(
        "WORKFLOW_SCAN_EXECUTION_OWNED",
        "scan execution is already attached to another workflow run"
      );
    }
    if (run.scanBatchId && run.scanBatchId !== scanBatchId) {
      throw workflowRunError("WORKFLOW_SCAN_LINK_MISMATCH", "workflow run is already attached to another scan");
    }
    if (run.scanRunId && run.scanRunId !== scanRunId) {
      const previous = db.prepare("SELECT status, batch_id, plan_id FROM scan_runs WHERE id = ?").get(run.scanRunId);
      if (!previous
        || previous.status === "running"
        || Number(previous.plan_id || 0) !== run.planId
        || (previous.batch_id && Number(previous.batch_id) !== scanBatchId)) {
        throw workflowRunError("WORKFLOW_SCAN_LINK_MISMATCH", "workflow run is already attached to another active scan");
      }
    }
    const scan = db.prepare("SELECT plan_id, batch_id, status FROM scan_runs WHERE id = ?").get(scanRunId);
    const batch = db.prepare("SELECT search_plan_id FROM batches WHERE id = ?").get(scanBatchId);
    if (!scan || !batch || Number(scan.plan_id || 0) !== run.planId || Number(batch.search_plan_id || 0) !== run.planId
      || scan.status !== "running" || (scan.batch_id && Number(scan.batch_id) !== scanBatchId)) {
      throw workflowRunError("WORKFLOW_SCAN_LINK_MISMATCH", "scan run or batch does not belong to this workflow plan");
    }
    db.prepare("UPDATE workflow_runs SET scan_run_id = ?, scan_batch_id = ?, updated_at = ? WHERE id = ?")
      .run(scanRunId, scanBatchId, nowIso(), id);
    return getWorkflowRun(db, id);
  });
}

function attachWorkflowScanRun(db, input = {}) {
  return immediateTransaction(db, () => {
    const id = String(input.id || input.workflowRunId || "").trim();
    const run = getWorkflowRun(db, id);
    if (!run) throw workflowRunError("WORKFLOW_RUN_NOT_FOUND", "workflow run was not found");
    if (!["scanning", "analyzing", "interrupted"].includes(run.status)) {
      throw workflowRunError(
        "WORKFLOW_SCAN_LINK_INVALID",
        "workflow execution can only be attached during scanning, analyzing, or interruption"
      );
    }
    const scanRunId = String(input.scanRunId || "").trim();
    if (!scanRunId) throw workflowRunError("WORKFLOW_SCAN_RUN_REQUIRED", "scan run is required");
    const owner = db.prepare(`
      SELECT id
      FROM workflow_runs
      WHERE scan_run_id = ? AND id <> ?
      LIMIT 1
    `).get(scanRunId, id);
    if (owner) {
      throw workflowRunError(
        "WORKFLOW_SCAN_EXECUTION_OWNED",
        "scan execution is already attached to another workflow run"
      );
    }
    if (run.scanRunId && run.scanRunId !== scanRunId) {
      const previous = db.prepare("SELECT status, plan_id FROM scan_runs WHERE id = ?").get(run.scanRunId);
      if (!previous || previous.status === "running" || Number(previous.plan_id || 0) !== run.planId) {
        throw workflowRunError("WORKFLOW_SCAN_LINK_MISMATCH", "workflow run is already attached to another active scan");
      }
    }
    const scan = db.prepare("SELECT plan_id, status FROM scan_runs WHERE id = ?").get(scanRunId);
    if (!scan || Number(scan.plan_id || 0) !== run.planId || scan.status !== "running") {
      throw workflowRunError("WORKFLOW_SCAN_LINK_MISMATCH", "scan run does not belong to this workflow plan");
    }
    db.prepare("UPDATE workflow_runs SET scan_run_id = ?, updated_at = ? WHERE id = ?")
      .run(scanRunId, nowIso(), id);
    return getWorkflowRun(db, id);
  });
}

function attachWorkflowCommunication(db, input = {}) {
  const id = String(input.id || input.workflowRunId || "").trim();
  const run = getWorkflowRun(db, id);
  if (!run) throw workflowRunError("WORKFLOW_RUN_NOT_FOUND", "workflow run was not found");
  if (!["review_required", "communicating", "interrupted"].includes(run.status)) {
    throw workflowRunError("WORKFLOW_COMMUNICATION_LINK_INVALID", "communication can only be attached after review");
  }
  const communicationBatchId = optionalPositiveInteger(input.communicationBatchId, "communicationBatchId");
  if (!communicationBatchId) throw workflowRunError("WORKFLOW_COMMUNICATION_LINK_REQUIRED", "communication batch is required");
  if (run.communicationBatchId && run.communicationBatchId !== communicationBatchId) {
    throw workflowRunError("WORKFLOW_COMMUNICATION_LINK_MISMATCH", "workflow run is already attached to another communication batch");
  }
  const batch = db.prepare("SELECT profile_id, plan_id FROM communication_batches WHERE id = ?").get(communicationBatchId);
  if (!batch || Number(batch.profile_id) !== run.profileId || Number(batch.plan_id) !== run.planId) {
    throw workflowRunError("WORKFLOW_COMMUNICATION_LINK_MISMATCH", "communication batch does not belong to this workflow run");
  }
  db.prepare("UPDATE workflow_runs SET communication_batch_id = ?, updated_at = ? WHERE id = ?")
    .run(communicationBatchId, nowIso(), id);
  return getWorkflowRun(db, id);
}

function workflowRunRow(row) {
  return {
    id: row.id,
    profileId: Number(row.profile_id),
    planId: Number(row.plan_id),
    localDay: row.local_day,
    sequence: Number(row.sequence),
    status: row.status,
    targetSuccessCount: Number(row.target_success_count),

    successfulCount: Number(row.successful_count),
    inventoryCount: Number(row.inventory_count),
    candidateGap: Number(row.candidate_gap),
    scanNeeded: Boolean(row.scan_needed),
    keywords: parseJson(row.keywords_json, []),
    budget: parseJson(row.budget_json, {}),
    planner: parseJson(row.planner_json, {}),
    metrics: parseJson(row.metrics_json, {}),
    scanRunId: row.scan_run_id || "",
    scanBatchId: Number(row.scan_batch_id || 0) || null,
    communicationBatchId: Number(row.communication_batch_id || 0) || null,
    shortfallCode: row.shortfall_code || "",
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    controlState: row.control_state || "none",
    resumePhase: row.resume_phase || null,
    recoveryGeneration: Number(row.recovery_generation || 0),
    circuitTimeoutJobCount: Number(row.circuit_timeout_job_count || 0),
    lifetimeTimeoutJobCount: Number(row.lifetime_timeout_job_count || 0),
    progressRevision: Number(row.progress_revision || 0),
    lastActivityAt: row.last_activity_at || null,
    modelConfigRevision: row.model_config_revision || "",
    platformAccessStartedAt: row.platform_access_started_at || null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    reviewReadyAt: row.review_ready_at || null,
    finishedAt: row.finished_at || null,
    updatedAt: row.updated_at
  };
}

function workflowJobTaskRow(row) {
  return {
    id: Number(row.id),
    workflowRunId: row.workflow_run_id,
    batchId: Number(row.batch_id),
    jobId: Number(row.job_id),
    observationId: Number(row.observation_id),
    position: Number(row.position),
    status: row.status,
    recoveryGeneration: Number(row.recovery_generation || 0),
    attemptCountInGeneration: Number(row.attempt_count_in_generation || 0),
    totalAttemptCount: Number(row.total_attempt_count || 0),
    priority: Number(row.priority || 100),
    availableAt: row.available_at || null,
    leaseOwner: row.lease_owner || null,
    leasedAt: row.leased_at || null,
    leaseExpiresAt: row.lease_expires_at || null,
    modelConfigRevision: row.model_config_revision || null,
    lastAttemptModelRevision: row.last_attempt_model_revision || null,
    lastErrorCode: row.last_error_code || null,
    lastErrorStage: row.last_error_stage || null,
    lastErrorKind: row.last_error_kind || null,
    totalLatencyMs: Number(row.total_latency_ms || 0),
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function jobAnalysisAttemptRow(row) {
  return {
    id: Number(row.id),
    workflowRunId: row.workflow_run_id,
    taskId: Number(row.task_id),
    jobId: Number(row.job_id),
    recoveryGeneration: Number(row.recovery_generation || 0),
    attemptInGeneration: Number(row.attempt_in_generation),
    totalAttemptNumber: Number(row.total_attempt_number),
    profileKind: row.profile_kind,
    modelConfigRevision: row.model_config_revision,
    provider: row.provider,
    model: row.model,
    thinkingMode: row.thinking_mode,
    reasoningEffort: row.reasoning_effort,
    backupUsed: Number(row.backup_used || 0),
    status: row.status,
    errorCode: row.error_code || null,
    errorStage: row.error_stage || null,
    retryable: Number(row.retryable || 0),
    modelCallCount: Number(row.model_call_count || 0),
    promptTokens: Number(row.prompt_tokens || 0),
    completionTokens: Number(row.completion_tokens || 0),
    totalTokens: Number(row.total_tokens || 0),
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function workflowObservationJobRow(row) {
  return {
    id: Number(row.job_id),
    source: row.source,
    sourceId: row.source_id,
    observationId: Number(row.id),
    batchId: Number(row.batch_id),
    keyword: row.keyword || null,
    title: row.title,
    company: row.company || null,
    location: row.location || null,
    salary: row.salary || null,
    experience: row.experience || null,
    education: row.education || null,
    bossActiveText: row.boss_active_text || null,
    bossActiveDays: row.boss_active_days ?? null,
    url: row.url || null,
    tags: parseJson(row.tags_json, []),
    description: row.description || null,
    score: Number(row.score || 0),
    level: row.level || null,
    matches: parseJson(row.matches_json, []),
    risks: parseJson(row.risks_json, []),
    qualityTags: parseJson(row.quality_tags_json, []),
    greeting: row.greeting || null,
    analysis: parseJson(row.analysis_json, {})
  };
}

function countWorkflowJobTasks(db, workflowRunId) {
  return Number(db.prepare(
    "SELECT count(*) AS n FROM workflow_job_tasks WHERE workflow_run_id = ?"
  ).get(workflowRunId).n);
}

function insertWorkflowJobTaskRow(db, {
  workflowRunId,
  batchId,
  jobId,
  observationId,
  position,
  status,
  recoveryGeneration,
  modelConfigRevision,
  now
}) {
  return db.prepare(`
    INSERT INTO workflow_job_tasks(
      workflow_run_id, batch_id, job_id, observation_id, position, status,
      recovery_generation, attempt_count_in_generation, total_attempt_count, priority,
      model_config_revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 100, ?, ?, ?)
    ON CONFLICT(workflow_run_id, job_id) DO NOTHING
  `).run(
    workflowRunId,
    batchId,
    jobId,
    observationId,
    position,
    status,
    recoveryGeneration,
    modelConfigRevision || null,
    now,
    now
  );
}

function reactivateWorkflowDetailRequiredTaskRow(db, {
  workflowRunId,
  batchId,
  jobId,
  observationId,
  modelConfigRevision,
  now
}) {
  return db.prepare(`
    UPDATE workflow_job_tasks SET
      observation_id = ?,
      status = CASE
        WHEN attempt_count_in_generation > 0 THEN 'retry_pending'
        ELSE 'pending'
      END,
      priority = CASE WHEN attempt_count_in_generation > 0 THEN 20 ELSE 100 END,
      available_at = NULL,
      lease_owner = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      model_config_revision = ?,
      last_error_code = NULL,
      last_error_stage = NULL,
      last_error_kind = NULL,
      finished_at = NULL,
      updated_at = ?
    WHERE workflow_run_id = ?
      AND batch_id = ?

      AND job_id = ?
      AND status = 'skipped'
      AND last_error_code = ?
      AND attempt_count_in_generation < 2
      AND EXISTS (
        SELECT 1
        FROM job_observations o
        WHERE o.id = workflow_job_tasks.observation_id
          AND o.job_id = workflow_job_tasks.job_id
          AND o.batch_id = workflow_job_tasks.batch_id
          AND ${WORKFLOW_OBSERVATION_READY_SQL}
      )
  `).run(
    observationId,
    modelConfigRevision || null,
    now,
    workflowRunId,
    batchId,
    jobId,
    WORKFLOW_DETAIL_REQUIRED_CODE
  );
}

function selectReadyWorkflowJobEntries(db, { batchId, entries }) {
  const selectObservation = db.prepare(`
    SELECT id, job_id
    FROM job_observations
    WHERE id = ? AND job_id = ? AND batch_id = ?
  `);
  const selectReady = db.prepare(`
    SELECT o.id AS observation_id, o.job_id AS job_id
    FROM job_observations o
    WHERE o.id = ?
      AND o.job_id = ?
      AND o.batch_id = ?
      AND ${WORKFLOW_OBSERVATION_READY_SQL}
  `);
  const ready = [];
  for (const entry of entries || []) {
    const jobId = Number(entry.jobId);
    const observationId = Number(entry.observationId);
    const observation = selectObservation.get(observationId, jobId, batchId);
    if (!observation) {
      throw workflowRunError(
        "WORKFLOW_TASK_BATCH_MISMATCH",
        `job ${jobId} (observation ${observationId}) does not belong to batch ${batchId}`
      );
    }
    const row = selectReady.get(observationId, jobId, batchId);
    if (!row) continue;
    ready.push({
      ...entry,
      jobId: Number(row.job_id),
      observationId: Number(row.observation_id)
    });
  }
  return ready;
}

function isWorkflowJobTaskObservationReady(db, { taskId }) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM workflow_job_tasks t
    JOIN job_observations o
      ON o.id = t.observation_id
      AND o.job_id = t.job_id
      AND o.batch_id = t.batch_id
    WHERE t.id = ?
      AND ${WORKFLOW_OBSERVATION_READY_SQL}
  `).get(taskId));
}

function settleIncompleteWorkflowJobTaskRows(db, { workflowRunId, now }) {
  const localSkipped = db.prepare(`
    UPDATE workflow_job_tasks AS t SET
      status = 'skipped',
      priority = 100,
      available_at = NULL,
      lease_owner = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      last_error_code = NULL,
      last_error_stage = NULL,
      last_error_kind = NULL,
      finished_at = ?,
      updated_at = ?
    WHERE t.workflow_run_id = ?
      AND t.status IN ('pending', 'retry_pending')
      AND EXISTS (
        SELECT 1
        FROM job_observations o
        WHERE o.id = t.observation_id
          AND o.job_id = t.job_id
          AND o.batch_id = t.batch_id
          AND ${WORKFLOW_OBSERVATION_LOCAL_SKIP_SQL}
      )
  `).run(now, now, workflowRunId);
  const detailRequired = db.prepare(`
    UPDATE workflow_job_tasks AS t SET
      status = 'skipped',
      priority = 100,
      available_at = NULL,
      lease_owner = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      last_error_code = ?,
      last_error_stage = 'input',
      last_error_kind = ?,
      finished_at = ?,
      updated_at = ?
    WHERE t.workflow_run_id = ?
      AND t.status IN ('pending', 'retry_pending')
      AND EXISTS (
        SELECT 1
        FROM job_observations o
        WHERE o.id = t.observation_id
          AND o.job_id = t.job_id
          AND o.batch_id = t.batch_id
          AND NOT (${WORKFLOW_OBSERVATION_READY_SQL})
      )
  `).run(
    WORKFLOW_DETAIL_REQUIRED_CODE,
    WORKFLOW_DETAIL_REQUIRED_KIND,
    now,
    now,
    workflowRunId
  );
  return { changes: Number(localSkipped.changes || 0) + Number(detailRequired.changes || 0) };
}

function replaceWorkflowScanContext(db, input = {}) {
  return immediateTransaction(db, () => {
    const id = String(input.id || input.workflowRunId || "").trim();
    const run = getWorkflowRun(db, id);
    if (!run) throw workflowRunError("WORKFLOW_RUN_NOT_FOUND", "workflow run was not found");
    if (String(input.expectedUpdatedAt || "") !== String(run.updatedAt || "")) {
      throw workflowRunError("WORKFLOW_SCAN_CONTEXT_STALE", "workflow run changed before scan context replacement");
    }
    if (!["paused", "interrupted"].includes(run.status) || run.resumePhase !== "scanning") {
      throw workflowRunError("WORKFLOW_SCAN_CONTEXT_STATUS_INVALID", "workflow scan context can only be replaced while paused or interrupted scanning");
    }
    if (run.controlState !== "none") {
      throw workflowRunError("WORKFLOW_SCAN_CONTEXT_CONTROL_ACTIVE", "workflow control must settle before scan context replacement");
    }
    if (run.communicationBatchId) {
      throw workflowRunError("WORKFLOW_SCAN_CONTEXT_COMMUNICATION_EXISTS", "workflow communication already exists");
    }
    if (countWorkflowJobTasks(db, id) > 0) {
      throw workflowRunError("WORKFLOW_SCAN_CONTEXT_ANALYSIS_EXISTS", "workflow analysis tasks already exist");
    }
    const activeLease = db.prepare("SELECT expires_at FROM site_scan_leases WHERE site = 'boss'").get();
    const replacedAt = String(input.replacedAt || nowIso());
    if (activeLease && Date.parse(activeLease.expires_at) > Date.parse(replacedAt)) {
      throw workflowRunError("WORKFLOW_SCAN_CONTEXT_LEASE_ACTIVE", "BOSS scan lease is still active");
    }
    const scan = run.scanRunId
      ? db.prepare("SELECT status FROM scan_runs WHERE id = ?").get(run.scanRunId)
      : null;
    if (scan?.status === "running") {
      throw workflowRunError("WORKFLOW_SCAN_CONTEXT_PROCESS_ACTIVE", "workflow scan process is still active");
    }
    const planner = input.planner;
    const newScopeKey = String(planner?.searchScope?.key || "").trim();
    if (!planner || typeof planner !== "object" || Array.isArray(planner) || !newScopeKey) {
      throw workflowRunError("WORKFLOW_SCAN_CONTEXT_INVALID", "replacement scan context is incomplete");
    }
    const nextPlanner = {
      ...planner,
      scopeReplacements: [
        ...(Array.isArray(run.planner?.scopeReplacements) ? run.planner.scopeReplacements : []),
        {
          replacedAt,
          oldScopeKey: String(run.planner?.searchScope?.key || ""),
          oldBatchId: run.scanBatchId,
          newScopeKey
        }
      ]
    };
    const result = db.prepare(`UPDATE workflow_runs SET
      status = 'interrupted',
      planner_json = ?,
      control_state = 'none',
      resume_phase = 'scanning',
      recovery_generation = recovery_generation + 1,
      scan_run_id = NULL,
      scan_batch_id = NULL,
      error_code = NULL,
      error_message = NULL,
      updated_at = ?
    WHERE id = ? AND updated_at = ?`)
      .run(JSON.stringify(nextPlanner), replacedAt, id, run.updatedAt);
    if (Number(result.changes || 0) !== 1) {
      throw workflowRunError("WORKFLOW_SCAN_CONTEXT_STALE", "workflow run changed before scan context replacement");
    }
    return getWorkflowRun(db, id);
  });
}

function selectClaimableWorkflowJobTaskRow(db, { workflowRunId, now }) {
  return db.prepare(`
    SELECT t.*
    FROM workflow_job_tasks t
    JOIN job_observations o
      ON o.id = t.observation_id
      AND o.job_id = t.job_id
      AND o.batch_id = t.batch_id
    WHERE t.workflow_run_id = ?
      AND t.status IN ('pending', 'retry_pending')
      AND t.attempt_count_in_generation < 2
      AND (t.available_at IS NULL OR t.available_at <= ?)
      AND (t.lease_owner IS NULL OR t.lease_expires_at IS NULL OR t.lease_expires_at <= ?)
      AND ${WORKFLOW_OBSERVATION_READY_SQL}
    ORDER BY t.priority ASC, t.position ASC, t.id ASC
    LIMIT 1
  `).get(workflowRunId, now, now) || null;
}

function claimWorkflowJobTaskRow(db, {
  taskId,
  leaseOwner,
  leasedAt,
  leaseExpiresAt,
  attemptCountInGeneration,
  totalAttemptCount,
  lastAttemptModelRevision,
  now
}) {
  return db.prepare(`
    UPDATE workflow_job_tasks SET
      status = 'running',
      lease_owner = ?,
      leased_at = ?,
      lease_expires_at = ?,
      attempt_count_in_generation = ?,
      total_attempt_count = ?,
      last_attempt_model_revision = ?,
      started_at = ?,
      updated_at = ?
    WHERE id = ?
      AND status IN ('pending', 'retry_pending')
      AND attempt_count_in_generation = ?
      AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
      AND (available_at IS NULL OR available_at <= ?)
  `).run(
    leaseOwner,
    leasedAt,
    leaseExpiresAt,
    attemptCountInGeneration,
    totalAttemptCount,
    lastAttemptModelRevision,
    now,
    now,
    taskId,
    attemptCountInGeneration - 1,
    now,
    now
  );
}

function insertJobAnalysisAttemptRow(db, {
  workflowRunId,
  taskId,
  jobId,
  recoveryGeneration,
  attemptInGeneration,
  totalAttemptNumber,
  profileKind,
  modelConfigRevision,
  provider,
  model,
  thinkingMode,
  reasoningEffort,
  backupUsed,
  startedAt,
  now
}) {
  return db.prepare(`
    INSERT INTO job_analysis_attempts(
      workflow_run_id, task_id, job_id, recovery_generation, attempt_in_generation,
      total_attempt_number, profile_kind, model_config_revision, provider, model,
      thinking_mode, reasoning_effort, backup_used, status, retryable, model_call_count,
      prompt_tokens, completion_tokens, total_tokens, started_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, 0, 0, 0, 0, ?, ?, ?)
  `).run(
    workflowRunId,
    taskId,
    jobId,
    recoveryGeneration,
    attemptInGeneration,
    totalAttemptNumber,
    profileKind,
    modelConfigRevision,
    provider,

    model,
    thinkingMode,
    reasoningEffort,
    backupUsed ? 1 : 0,
    startedAt,
    now,
    now
  );
}

function incrementWorkflowRunActivity(db, { workflowRunId, now }) {
  db.prepare(`
    UPDATE workflow_runs SET
      progress_revision = progress_revision + 1,
      last_activity_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(now, now, workflowRunId);
}

function getWorkflowObservationJob(db, observationId) {
  const row = db.prepare(`
    SELECT o.id, o.job_id, o.batch_id, o.keyword, o.title, o.company, o.location, o.salary,
      o.experience, o.education, o.boss_active_text, o.boss_active_days, o.url, o.tags_json,
      o.description, o.score, o.level, o.matches_json, o.risks_json, o.quality_tags_json,
      o.greeting, o.analysis_json, j.source, j.source_id
    FROM job_observations o
    JOIN jobs j ON j.id = o.job_id
    WHERE o.id = ?
  `).get(observationId);
  return row ? workflowObservationJobRow(row) : null;
}

function listWorkflowJobTaskRows(db, { workflowRunId, statuses, limit }) {
  const cap = Math.max(1, Math.min(10000, Number(limit) || 10000));
  const statusClause = Array.isArray(statuses) && statuses.length > 0
    ? `AND status IN (${statuses.map(() => "?").join(", ")})`
    : "";
  const rows = db.prepare(`
    SELECT * FROM workflow_job_tasks
    WHERE workflow_run_id = ? ${statusClause}
    ORDER BY position ASC, id ASC
    LIMIT ?
  `).all(workflowRunId, ...(Array.isArray(statuses) ? statuses : []), cap);
  return rows.map(workflowJobTaskRow);
}

function getWorkflowJobTaskRow(db, taskId) {
  return db.prepare("SELECT * FROM workflow_job_tasks WHERE id = ?").get(taskId) || null;
}

function getRunningJobAnalysisAttemptRow(db, taskId) {
  return db.prepare(`
    SELECT * FROM job_analysis_attempts
    WHERE task_id = ? AND status = 'running'
    ORDER BY id DESC
    LIMIT 1
  `).get(taskId) || null;
}

function finishJobAnalysisAttemptRow(db, {
  attemptId,
  status,
  provider,
  model,
  modelConfigRevision,
  thinkingMode,
  reasoningEffort,
  backupUsed,
  modelCallCount,
  promptTokens,
  completionTokens,
  totalTokens,
  latencyMs,
  errorCode,
  errorStage,
  retryable,
  finishedAt,
  now
}) {
  return db.prepare(`
    UPDATE job_analysis_attempts SET
      status = ?,
      provider = ?,
      model = ?,
      model_config_revision = ?,
      thinking_mode = ?,
      reasoning_effort = ?,
      backup_used = ?,
      model_call_count = ?,
      prompt_tokens = ?,
      completion_tokens = ?,
      total_tokens = ?,
      error_code = ?,
      error_stage = ?,
      retryable = ?,
      finished_at = ?,
      latency_ms = ?,
      updated_at = ?
    WHERE id = ? AND status = 'running'
  `).run(
    status,
    provider,
    model,
    modelConfigRevision,
    thinkingMode,
    reasoningEffort,
    backupUsed ? 1 : 0,
    modelCallCount,
    promptTokens,
    completionTokens,
    totalTokens,
    errorCode || null,
    errorStage || null,
    retryable ? 1 : 0,
    finishedAt,
    latencyMs,
    now,
    attemptId
  );
}

function failWorkflowJobTaskRow(db, {
  taskId,
  leaseOwner,
  status,
  errorCode,
  errorStage,
  errorKind,
  priority,
  availableAt,
  finishedAt,
  now
}) {
  const hasPriority = priority !== undefined && priority !== null;
  return db.prepare(`
    UPDATE workflow_job_tasks SET
      status = ?,
      lease_owner = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      available_at = ?,
      priority = CASE WHEN ? IS NULL THEN priority ELSE ? END,
      last_error_code = ?,
      last_error_stage = ?,
      last_error_kind = ?,
      finished_at = ?,
      updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_owner = ?
  `).run(
    status,
    availableAt || null,
    hasPriority ? priority : null,
    hasPriority ? priority : null,
    errorCode || null,
    errorStage || null,
    errorKind || null,
    finishedAt || null,
    now,
    taskId,
    leaseOwner
  );
}

function incrementWorkflowTimeoutCounters(db, { workflowRunId, now, circuitThreshold }) {
  db.prepare(`
    UPDATE workflow_runs SET
      circuit_timeout_job_count = circuit_timeout_job_count + 1,
      lifetime_timeout_job_count = lifetime_timeout_job_count + 1,
      updated_at = ?
    WHERE id = ?
  `).run(now, workflowRunId);
  const threshold = Number(circuitThreshold);
  if (Number.isInteger(threshold) && threshold > 0) {
    db.prepare(`
      UPDATE workflow_runs SET
        control_state = 'pause_requested',
        resume_phase = 'analyzing',
        error_code = ?,
        progress_revision = progress_revision + 1,
        last_activity_at = ?,
        updated_at = ?
      WHERE id = ? AND circuit_timeout_job_count >= ? AND control_state = 'none'
    `).run(WORKFLOW_TIMEOUT_CIRCUIT_OPEN_CODE, now, now, workflowRunId, threshold);
  }
}

function requestWorkflowRunConfigurationPause(db, { workflowRunId, now }) {
  db.prepare(`
    UPDATE workflow_runs SET
      control_state = 'pause_requested',
      resume_phase = 'analyzing',
      progress_revision = progress_revision + 1,
      last_activity_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(now, now, workflowRunId);
}

function recordWorkflowScanWait(db, {

  workflowRunId,
  runId,
  action,
  delayMs,
  retryAt,
  now
}) {
  const id = String(workflowRunId || "").trim();
  if (!id) return null;
  const clock = String(now || nowIso());
  const wait = JSON.stringify({
    runId: String(runId || ""),
    action: String(action || ""),
    delayMs: Math.max(0, Number(delayMs || 0)),
    retryAt: String(retryAt || "")
  });
  const result = db.prepare(`
    UPDATE workflow_runs SET
      metrics_json = json_set(COALESCE(metrics_json, '{}'), '$.scanWait', json(?)),
      last_activity_at = ?,
      updated_at = ?,
      progress_revision = progress_revision + 1
    WHERE id = ?
  `).run(wait, clock, clock, id);
  return Number(result.changes || 0) > 0 ? getWorkflowRun(db, id) : null;
}

function recordWorkflowPlatformAccess(db, { workflowRunId, now }) {
  const id = String(workflowRunId || "").trim();
  if (!id) return null;
  const clock = String(now || nowIso());
  const result = db.prepare(`
    UPDATE workflow_runs SET
      platform_access_started_at = COALESCE(platform_access_started_at, ?),
      metrics_json = json_remove(COALESCE(metrics_json, '{}'), '$.scanWait'),
      last_activity_at = ?,
      updated_at = ?,
      progress_revision = progress_revision + 1
    WHERE id = ?
  `).run(clock, clock, clock, id);
  return Number(result.changes || 0) > 0 ? getWorkflowRun(db, id) : null;
}

function countWorkflowJobTaskStatuses(db, workflowRunId) {
  const rows = db.prepare(`
    SELECT status, last_error_code, count(*) AS n
    FROM workflow_job_tasks
    WHERE workflow_run_id = ?
    GROUP BY status, last_error_code
  `).all(workflowRunId);
  const counts = {
    pending: 0,
    running: 0,
    retryPending: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    detailRequired: 0,
    stopped: 0,
    total: 0
  };
  for (const row of rows) {
    const key = row.status === "retry_pending" ? "retryPending" : row.status;
    if (Object.hasOwn(counts, key)) {
      counts[key] += Number(row.n);
      counts.total += Number(row.n);
    }
    if (row.status === "skipped" && row.last_error_code === WORKFLOW_DETAIL_REQUIRED_CODE) {
      counts.detailRequired += Number(row.n);
    }
  }
  return counts;
}

function selectEarliestRetryAvailableAt(db, { workflowRunId, now }) {
  const row = db.prepare(`
    SELECT MIN(available_at) AS earliest
    FROM workflow_job_tasks
    WHERE workflow_run_id = ?
      AND status = 'retry_pending'
      AND available_at IS NOT NULL
      AND available_at > ?
  `).get(workflowRunId, now);
  return row && row.earliest ? row.earliest : null;
}

function markWorkflowJobTasksStopped(db, { workflowRunId, now }) {
  return db.prepare(`
    UPDATE workflow_job_tasks SET
      status = 'stopped',
      lease_owner = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      available_at = NULL,
      finished_at = COALESCE(finished_at, ?),
      updated_at = ?
    WHERE workflow_run_id = ? AND status IN ('pending', 'retry_pending')
  `).run(now, now, workflowRunId);
}

function selectExpiredLeaseWorkflowJobTaskRows(db, { workflowRunId, now }) {
  return db.prepare(`
    SELECT * FROM workflow_job_tasks
    WHERE workflow_run_id = ?
      AND status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= ?
    ORDER BY position ASC, id ASC
  `).all(workflowRunId, now).map(workflowJobTaskRow);
}

function completeWorkflowJobTaskRow(db, {
  taskId,
  leaseOwner,
  status,
  reasonCode,
  reasonKind,
  finishedAt,
  now
}) {
  return db.prepare(`
    UPDATE workflow_job_tasks SET
      status = ?,
      lease_owner = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      available_at = NULL,
      last_error_code = ?,
      last_error_stage = NULL,
      last_error_kind = ?,
      finished_at = ?,
      updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_owner = ?
  `).run(
    status,
    reasonCode || null,
    reasonKind || null,
    finishedAt,
    now,
    taskId,
    leaseOwner
  );
}

function listJobAnalysisAttemptRows(db, { workflowRunId, taskId, limit }) {
  const cap = Math.max(1, Math.min(10000, Number(limit) || 10000));
  const taskIdNum = Number(taskId);
  if (!Number.isInteger(taskIdNum) || taskIdNum <= 0) {
    throw new Error(`listJobAnalysisAttemptRows requires a positive integer taskId, got ${taskId}`);
  }
  const rows = db.prepare(`
    SELECT * FROM job_analysis_attempts
    WHERE workflow_run_id = ? AND task_id = ?
    ORDER BY total_attempt_number ASC, id ASC
    LIMIT ?
  `).all(workflowRunId, taskIdNum, cap);
  return rows.map(jobAnalysisAttemptRow);
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function workflowRunError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  createWorkflowRun,
  getWorkflowRun,
  getWorkflowRunByCommunicationBatch,
  listWorkflowRuns,
  getActiveWorkflowRun,
  transitionWorkflowRun,
  attachWorkflowScan,
  attachWorkflowScanRun,
  replaceWorkflowScanContext,
  attachWorkflowCommunication,
  requestWorkflowRunConfigurationPause,
  recordWorkflowScanWait,
  recordWorkflowPlatformAccess,
  workflowJobTaskRow,
  jobAnalysisAttemptRow,
  countWorkflowJobTasks,
  insertWorkflowJobTaskRow,
  reactivateWorkflowDetailRequiredTaskRow,
  selectReadyWorkflowJobEntries,
  isWorkflowJobTaskObservationReady,
  settleIncompleteWorkflowJobTaskRows,
  selectClaimableWorkflowJobTaskRow,
  claimWorkflowJobTaskRow,
  insertJobAnalysisAttemptRow,
  incrementWorkflowRunActivity,
  getWorkflowObservationJob,
  listWorkflowJobTaskRows,
  listJobAnalysisAttemptRows,
  getWorkflowJobTaskRow,
  getRunningJobAnalysisAttemptRow,
  finishJobAnalysisAttemptRow,
  failWorkflowJobTaskRow,
  incrementWorkflowTimeoutCounters,
  countWorkflowJobTaskStatuses,
  selectEarliestRetryAvailableAt,
  markWorkflowJobTasksStopped,
  selectExpiredLeaseWorkflowJobTaskRows,
  completeWorkflowJobTaskRow,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_TIMEOUT_CIRCUIT_OPEN_CODE
};
