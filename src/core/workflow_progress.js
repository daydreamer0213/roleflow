"use strict";

const { PRODUCT_POLICY } = require("./product_policy");
const { workflowRunConsumesSlot } = require("./workflow_control");
const { hasCompleteJobDescription } = require("./job_description_readiness");

const WORKFLOW_STAGES = Object.freeze([
  "准备本轮",
  "读取搜索结果",
  "获取完整 JD",
  "分析岗位",
  "等待确认 / 执行沟通"
]);

// Deterministic status -> stage index mapping. scanning is the JD collection
// stage (the user-visible deliverable of the scan phase); review/communication
// and terminal states share the final stage label.
const STATUS_STAGE_INDEX = Object.freeze({
  created: 1,
  scanning: 3,
  analyzing: 4,
  review_required: 5,
  communicating: 5,
  completed: 5,
  failed: 5,
  stopped: 5
});

const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed"]);
const TERMINAL_ATTEMPT_STATUSES = new Set(["succeeded", "failed"]);
const ETA_SAMPLE_MINIMUM = 3;
const ETA_SAMPLE_LIMIT = 10;
const ACTIVITY_CAP = 20;

function getWorkflowProgressSnapshot(db, {
  workflowRunId,
  now = new Date().toISOString(),
  recentActivityLimit = 8,
  communicationSummary = null
} = {}) {
  const id = String(workflowRunId || "").trim();
  if (!id) return null;
  const workflow = db.prepare(`
    SELECT id, status, control_state, resume_phase,
      circuit_timeout_job_count, lifetime_timeout_job_count,
      progress_revision, last_activity_at, model_config_revision,
      planner_json, metrics_json, platform_access_started_at,
      scan_run_id, scan_batch_id, communication_batch_id, review_ready_at,
      (
        SELECT filter_snapshot_json
        FROM batches
        WHERE batches.id = workflow_runs.scan_batch_id
      ) AS scan_filter_snapshot_json,
      EXISTS(
        SELECT 1 FROM workflow_job_tasks t
        WHERE t.workflow_run_id = workflow_runs.id
      ) AS has_analysis_tasks
    FROM workflow_runs
    WHERE id = ?
  `).get(id);
  if (!workflow) return null;

  const clock = validIso(now);
  const activityLimit = Math.max(1, Math.min(ACTIVITY_CAP, Math.floor(Number(recentActivityLimit) || 8)));
  const controlling = ["pause_requested", "stop_requested"].includes(String(workflow.control_state || "none"));
  const status = String(workflow.status || "");

  const counts = countTaskStatuses(db, id);
  const detailCoverage = countObservationDetails(db, Number(workflow.scan_batch_id || 0), id);
  const collected = detailCoverage.collected;
  const detailsRead = detailCoverage.read;
  const detailsPending = Math.max(0, collected - detailsRead);
  const scanTargets = countScanTargets(
    db,
    Number(workflow.scan_batch_id || 0),
    workflow.scan_filter_snapshot_json
  );
  const details = {
    collected,
    read: detailsRead,
    pending: detailsPending
  };
  const communication = countCommunicationItems(
    db,
    Number(workflow.communication_batch_id || 0),
    communicationSummary?.statusCounts
  );

  const tasks = db.prepare(`
    SELECT id, status, finished_at, model_config_revision
    FROM workflow_job_tasks
    WHERE workflow_run_id = ?
    ORDER BY position ASC, id ASC
  `).all(id).map((row) => ({
    id: Number(row.id),
    status: row.status,
    finishedAt: row.finished_at || null,
    modelConfigRevision: row.model_config_revision || null
  }));

  const revision = String(workflow.model_config_revision || "").trim();
  const etaSamples = selectEtaSamples(db, id, revision);
  const modelIdentity = resolveModelIdentity(db, id, workflow);
  const eta = estimateWorkflowAnalysisEta({
    tasks,
    attempts: etaSamples,
    now: clock,
    status: controlling && status === "analyzing" ? "paused" : status,
    modelConfigRevision: revision,
    concurrency: modelIdentity.concurrency
  });

  const stageIndex = stageIndexFor(workflow);
  const metrics = parseJson(workflow.metrics_json, {});
  const scanHeartbeat = workflow.scan_run_id
    ? db.prepare("SELECT heartbeat_at FROM scan_runs WHERE id = ?").get(workflow.scan_run_id)?.heartbeat_at
    : null;
  const lastActivityAt = laterValidIso(workflow.last_activity_at, scanHeartbeat);
  const scanWait = status === "scanning"
    && metrics.scanWait?.runId === workflow.scan_run_id
    && Date.parse(metrics.scanWait.retryAt) > Date.parse(clock)
    ? {
        action: String(metrics.scanWait.action || ""),
        retryAt: metrics.scanWait.retryAt,
        delayMs: Math.max(0, Number(metrics.scanWait.delayMs || 0))
      }
    : null;
  const runForSlot = {
    status,
    platformAccessStartedAt: workflow.platform_access_started_at || null,
    metrics
  };

  return {
    workflow: {
      id,
      status,
      controlState: String(workflow.control_state || "none"),
      lastActivityAt,
      progressRevision: Number(workflow.progress_revision || 0)
    },
    progress: {
      stage: WORKFLOW_STAGES[stageIndex - 1],
      stageIndex,
      stageCount: WORKFLOW_STAGES.length,
      collected,
      detailsRead,
      detailsPending,
      scanTargets,
      details,
      scanWait,
      analysis: {
        total: counts.total,
        succeeded: counts.succeeded,
        running: counts.running,
        retryPending: counts.retryPending,
        failed: counts.failed,
        skipped: counts.skipped,
        detailRequired: counts.detailRequired,
        stopped: counts.stopped,
        pending: counts.pending,
        circuitTimeoutJobs: Number(workflow.circuit_timeout_job_count || 0),
        lifetimeTimeoutJobs: Number(workflow.lifetime_timeout_job_count || 0),
        timeoutPauseThreshold: Number(PRODUCT_POLICY.operations.modelAnalysis.timeoutCircuitThreshold)
      },
      communication,
      remainingWorkLabel: workflowRemainingWorkLabel(status, {
        scanTargets,
        details,
        analysis: counts,
        communication
      }),
      eta
    },
    model: {
      profile: "batch_screening",
      provider: modelIdentity.provider,
      model: modelIdentity.model,
      revision: modelIdentity.revision,
      backupEnabled: modelIdentity.backupEnabled,
      backupActiveForCurrentAttempt: modelIdentity.backupActiveForCurrentAttempt
    },
    controls: {
      canPause: ["scanning", "analyzing"].includes(status) && !controlling,
      canResume: status === "paused",
      canStop: !["completed", "failed", "stopped"].includes(status)
        && String(workflow.control_state || "none") !== "stop_requested",
      stopConsumesRunSlot: workflowRunConsumesSlot({ ...runForSlot, status: "stopped" })
    },
    recentActivity: buildRecentActivity(db, id, clock, activityLimit, controlling)
  };
}

function estimateWorkflowAnalysisEta({
  tasks = [],
  attempts = [],
  now,
  status,
  modelConfigRevision,
  concurrency
} = {}) {
  const runStatus = String(status || "");
  if (runStatus !== "analyzing" && runStatus !== "paused") {
    return { status: "not_applicable", minSeconds: null, maxSeconds: null, sampleSize: 0 };
  }

  const revision = String(modelConfigRevision || "");
  const samples = collectCompletionSamples(tasks, attempts, revision);
  const sampleSize = samples.length;
  if (runStatus === "paused") {
    const frozen = pausedEtaBounds(samples, tasks, concurrency);
    return { status: "paused", minSeconds: frozen.minSeconds, maxSeconds: frozen.maxSeconds, sampleSize };
  }
  if (sampleSize < ETA_SAMPLE_MINIMUM) {
    return { status: "estimating", minSeconds: null, maxSeconds: null, sampleSize };
  }

  const times = samples
    .map((sample) => Date.parse(sample.finishedAt))
    .sort((left, right) => left - right);
  const intervals = [];
  for (let index = 1; index < times.length; index += 1) {
    intervals.push(Math.max(1, times[index] - times[index - 1]));
  }
  intervals.sort((left, right) => left - right);
  const lowerInterval = percentile(intervals, 0.25);
  const medianInterval = percentile(intervals, 0.5);
  const upperInterval = percentile(intervals, 0.75);

  const counts = taskCounts(tasks);
  const remaining = counts.pending + counts.running + counts.retryPending;
  const upperUnits = remaining + counts.running + counts.retryPending;
  const effectiveConcurrency = Math.max(1, Math.floor(Number(concurrency) || 1));

  return {
    status: "available",
    minSeconds: Math.ceil((lowerInterval * remaining) / effectiveConcurrency / 1000),
    maxSeconds: Math.ceil((upperInterval * upperUnits) / effectiveConcurrency / 1000),
    sampleSize
  };
}

function pausedEtaBounds(samples, tasks, concurrency) {
  if (samples.length < ETA_SAMPLE_MINIMUM) {
    return { minSeconds: null, maxSeconds: null };
  }
  const times = samples
    .map((sample) => Date.parse(sample.finishedAt))
    .sort((left, right) => left - right);
  const intervals = [];
  for (let index = 1; index < times.length; index += 1) {
    intervals.push(Math.max(1, times[index] - times[index - 1]));
  }
  intervals.sort((left, right) => left - right);
  const lowerInterval = percentile(intervals, 0.25);
  const upperInterval = percentile(intervals, 0.75);
  const counts = taskCounts(tasks);
  const remaining = counts.pending + counts.running + counts.retryPending;
  const upperUnits = remaining + counts.running + counts.retryPending;
  const effectiveConcurrency = Math.max(1, Math.floor(Number(concurrency) || 1));
  return {
    minSeconds: Math.ceil((lowerInterval * remaining) / effectiveConcurrency / 1000),
    maxSeconds: Math.ceil((upperInterval * upperUnits) / effectiveConcurrency / 1000)
  };
}

function collectCompletionSamples(tasks, attempts, revision) {
  const candidates = (Array.isArray(attempts) ? attempts : []).filter((attempt) => (
    attempt
    && TERMINAL_ATTEMPT_STATUSES.has(String(attempt.status || ""))
    && Number(attempt.modelCallCount || 0) > 0
    && String(attempt.modelConfigRevision || "") === revision
    && attempt.finishedAt
    && Number.isFinite(Date.parse(attempt.finishedAt))
  ));
  const byTask = new Map();
  for (const attempt of candidates) {
    const key = Number(attempt.taskId);
    const existing = byTask.get(key);
    if (!existing || Date.parse(attempt.finishedAt) > Date.parse(existing.finishedAt)) {
      byTask.set(key, attempt);
    }
  }
  let samples = [...byTask.values()]
    .sort((left, right) => Date.parse(left.finishedAt) - Date.parse(right.finishedAt))
    .slice(-ETA_SAMPLE_LIMIT);
  if (samples.length) return samples;

  // Legacy fallback: terminal task rows carry their own completion time.
  samples = (Array.isArray(tasks) ? tasks : [])
    .filter((task) => (
      task
      && TERMINAL_TASK_STATUSES.has(String(task.status || ""))
      && task.finishedAt
      && Number.isFinite(Date.parse(task.finishedAt))
      && (revision ? String(task.modelConfigRevision || "") === revision : true)
    ))
    .sort((left, right) => Date.parse(left.finishedAt) - Date.parse(right.finishedAt))
    .slice(-ETA_SAMPLE_LIMIT);
  return samples;
}

function percentile(sorted, quantile) {
  const index = Math.min(sorted.length - 1, Math.floor(quantile * (sorted.length - 1)));
  return sorted[index];
}

function taskCounts(tasks) {
  const counts = { pending: 0, running: 0, retryPending: 0 };
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const status = String((task && task.status) || "");
    if (status === "pending") counts.pending += 1;
    else if (status === "running") counts.running += 1;
    else if (status === "retry_pending") counts.retryPending += 1;
  }
  return counts;
}

function stageIndexFor(workflow) {
  const status = String(workflow.status || "");
  if (["paused", "interrupted"].includes(status) && workflow.resume_phase) {
    return String(workflow.resume_phase || "") === "scanning" ? 3 : 4;
  }
  if (status === "interrupted") {
    if (workflow.communication_batch_id || workflow.review_ready_at) return 5;
    if (Number(workflow.has_analysis_tasks || 0) > 0) return 4;
    if (workflow.scan_batch_id) return 3;
    return 1;
  }
  return STATUS_STAGE_INDEX[status] || WORKFLOW_STAGES.length;
}

function countTaskStatuses(db, workflowRunId) {
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
    if (row.status === "skipped" && row.last_error_code === "DETAIL_REQUIRED") {
      counts.detailRequired += Number(row.n);
    }
  }
  return counts;
}

function countObservationDetails(db, scanBatchId, workflowRunId) {
  const batchId = Number(scanBatchId);
  const rows = Number.isInteger(batchId) && batchId > 0
    ? db.prepare(`
        SELECT description, quality_tags_json
        FROM job_observations
        WHERE batch_id = ?
      `).all(batchId)
    : db.prepare(`
        SELECT o.description, o.quality_tags_json
        FROM workflow_job_tasks t
        JOIN job_observations o ON o.id = t.observation_id
        WHERE t.workflow_run_id = ?
      `).all(workflowRunId);
  return {
    collected: rows.length,
    read: rows.filter((row) => hasCompleteJobDescription({
      description: row.description,
      qualityTags: parseJson(row.quality_tags_json, {})
    })).length
  };
}

function countScanTargets(db, scanBatchId, filterSnapshotJson) {
  const batchId = Number(scanBatchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return { total: 0, completed: 0, pending: 0, partial: 0, failed: 0 };
  }
  const execution = parseJson(filterSnapshotJson, {}).execution;
  const targets = Array.isArray(execution?.targets) ? execution.targets : [];
  const rows = db.prepare(`
    SELECT result.target_key, result.status
    FROM scan_target_results result
    JOIN (
      SELECT target_key, MAX(id) AS id
      FROM scan_target_results
      WHERE batch_id = ?
      GROUP BY target_key
    ) latest ON latest.id = result.id
  `).all(batchId);
  const statusByKey = new Map(rows.map((row) => [row.target_key, row.status]));
  const counts = { total: targets.length, completed: 0, pending: 0, partial: 0, failed: 0 };
  for (const target of targets) {
    const status = statusByKey.get(target?.targetKey);
    if (status === "completed") counts.completed += 1;
    else counts.pending += 1;
    if (status === "partial") counts.partial += 1;
    if (status === "failed") counts.failed += 1;
  }
  return counts;
}

function countCommunicationItems(db, communicationBatchId, knownStatusCounts = null) {
  const batchId = Number(communicationBatchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return { total: 0, pending: 0, ambiguous: 0, succeeded: 0, stopped: 0 };
  }
  const counts = knownStatusCounts
    ? Object.fromEntries(Object.entries(knownStatusCounts).map(([status, count]) => [status, Number(count)]))
    : Object.fromEntries(db.prepare(`
        SELECT status, COUNT(*) AS count
        FROM communication_batch_items
        WHERE batch_id = ?
        GROUP BY status
      `).all(batchId).map((row) => [row.status, Number(row.count)]));
  return {
    total: Object.values(counts).reduce((sum, value) => sum + value, 0),
    pending: sumStatuses(counts, ["pending", "opening", "verified", "click_dispatched"]),
    ambiguous: counts.ambiguous || 0,
    succeeded: sumStatuses(counts, ["succeeded", "already_communicated"]),
    stopped: sumStatuses(counts, [
      "stopped",
      "job_unavailable",
      "target_mismatch",
      "action_unavailable",
      "platform_rejected",
      "transport_failed"
    ])
  };
}

function workflowRemainingWorkLabel(status, progress) {
  if (status === "scanning") {
    return `还需完成 ${progress.scanTargets.pending} 个搜索目标；${progress.details.pending} 个岗位详情待读取`;
  }
  if (status === "analyzing" || status === "paused") {
    const pending = progress.analysis.pending
      + progress.analysis.running
      + progress.analysis.retryPending;
    return `还有 ${pending} 个岗位待分析；${progress.analysis.detailRequired} 个岗位待补详情`;
  }
  if (status === "review_required") {
    return "岗位已准备完成，等待你确认清单";
  }
  if (status === "communicating" || status === "interrupted") {
    return `还有 ${progress.communication.pending} 个岗位未执行；${progress.communication.ambiguous} 个结果待人工确认`;
  }
  return "本轮没有未完成工作";
}

function sumStatuses(counts, statuses) {
  return statuses.reduce((sum, status) => sum + Number(counts[status] || 0), 0);
}

function selectEtaSamples(db, workflowRunId, revision) {
  if (!revision) return [];
  return db.prepare(`
    SELECT task_id, MAX(finished_at) AS finished_at
    FROM job_analysis_attempts
    WHERE workflow_run_id = ?
      AND model_config_revision = ?
      AND status IN ('succeeded', 'failed')
      AND model_call_count > 0
      AND finished_at IS NOT NULL
    GROUP BY task_id
    ORDER BY finished_at DESC
    LIMIT ?
  `).all(workflowRunId, revision, ETA_SAMPLE_LIMIT).map((row) => ({
    taskId: Number(row.task_id),
    status: "succeeded",
    modelConfigRevision: revision,
    modelCallCount: 1,
    finishedAt: row.finished_at
  }));
}

function resolveModelIdentity(db, workflowRunId, workflow) {
  const planner = parseJson(workflow.planner_json, {});
  const profiles = (planner && typeof planner === "object" ? planner.modelProfiles : null) || {};
  const batch = profiles.batch_screening && typeof profiles.batch_screening === "object"
    ? profiles.batch_screening
    : {};
  const backup = profiles.batch_backup && typeof profiles.batch_backup === "object"
    ? profiles.batch_backup
    : null;
  let provider = String(batch.provider || "").trim();
  let model = String(batch.model || "").trim();
  const revision = String(batch.revision || workflow.model_config_revision || "").trim();
  if (!provider || !model) {
    const latest = db.prepare(`
      SELECT provider, model
      FROM job_analysis_attempts
      WHERE workflow_run_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(workflowRunId);
    provider = provider || (latest && String(latest.provider || "").trim()) || "";
    model = model || (latest && String(latest.model || "").trim()) || "";
  }
  const runningBackup = db.prepare(`
    SELECT 1
    FROM job_analysis_attempts
    WHERE workflow_run_id = ?
      AND status = 'running'
      AND backup_used = 1
    LIMIT 1
  `).get(workflowRunId);
  const concurrency = positiveInt(batch.concurrency);
  return {
    provider,
    model,
    revision,
    backupEnabled: Boolean(backup),
    backupActiveForCurrentAttempt: Boolean(runningBackup),
    concurrency
  };
}

function buildRecentActivity(db, workflowRunId, now, limit, controlling) {
  const rows = db.prepare(`
    SELECT a.task_id, a.total_attempt_number, a.status, a.error_code,
      a.backup_used, a.finished_at, a.updated_at,
      t.status AS task_status
    FROM job_analysis_attempts a
    JOIN workflow_job_tasks t ON t.id = a.task_id
    WHERE a.workflow_run_id = ?
    ORDER BY COALESCE(a.finished_at, a.updated_at, a.created_at) DESC, a.id DESC
    LIMIT ?
  `).all(workflowRunId, limit);
  const activity = rows.map((row) => {
    let type = "analysis_started";
    if (row.status === "succeeded") {
      type = String(row.task_status) === "skipped" ? "analysis_skipped" : "analysis_succeeded";
    } else if (row.status === "failed") {
      type = "analysis_failed";
    }
    return {
      type,
      taskId: Number(row.task_id),
      attempt: Number(row.total_attempt_number),
      modelRole: Number(row.backup_used) === 1 ? "backup" : "primary",
      errorCode: row.error_code || null,
      at: row.finished_at || row.updated_at
    };
  });

  if (controlling) {
    const waiting = db.prepare(`
      SELECT id, attempt_count_in_generation
      FROM workflow_job_tasks
      WHERE workflow_run_id = ?
        AND status = 'running'
        AND lease_expires_at > ?
      ORDER BY position ASC, id ASC
      LIMIT ?
    `).all(workflowRunId, now, limit);
    for (const row of waiting) {
      activity.unshift({
        type: "waiting_lease_expiry",
        taskId: Number(row.id),
        attempt: Number(row.attempt_count_in_generation || 0),
        modelRole: null,
        errorCode: "WAITING_LEASE_EXPIRY",
        at: now
      });
    }
  }
  return activity.slice(0, limit);
}

function validIso(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function laterValidIso(...values) {
  const valid = values
    .filter((value) => Number.isFinite(Date.parse(value)))
    .map((value) => new Date(value).toISOString());
  if (!valid.length) return null;
  return valid.reduce((latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest));
}

function parseJson(text, fallback) {
  try {
    const parsed = JSON.parse(text || "{}");
    return parsed === null || typeof parsed !== "object" ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

module.exports = {
  WORKFLOW_STAGES,
  getWorkflowProgressSnapshot,
  estimateWorkflowAnalysisEta
};
