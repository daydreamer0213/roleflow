"use strict";

const {
  getWorkflowRun,
  immediateTransaction,
  transitionWorkflowRun,
  markWorkflowJobTasksStopped,
  countWorkflowJobTaskStatuses
} = require("./storage");
const { completedWorkflowAnalysisCount } = require("./workflow_analysis_tasks");

const MODEL_PAUSE_CODES = new Set([
  "MODEL_TIMEOUT_CIRCUIT_OPEN",
  "MODEL_AUTH_REQUIRED",
  "MODEL_CONFIGURATION_REQUIRED"
]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped"]);
const PAUSABLE_STATUSES = new Set(["analyzing", "scanning"]);
const RESUME_TARGET_STATUSES = new Set(["analyzing", "scanning"]);
const UNFINISHED_TASK_STATUSES = new Set(["pending", "retry_pending", "running"]);

function requestWorkflowPause(db, { workflowRunId, now }) {
  const clock = requiredNow(now);
  return immediateTransaction(db, () => {
    const run = requiredWorkflowRun(db, workflowRunId);
    if (TERMINAL_STATUSES.has(run.status)) {
      throw controlError("WORKFLOW_RUN_TERMINAL", "workflow run is already terminal and cannot be paused");
    }
    if (run.controlState === "stop_requested" || !PAUSABLE_STATUSES.has(run.status)) {
      throw controlError(
        "WORKFLOW_PAUSE_NOT_ALLOWED",
        `workflow run ${run.status} cannot be paused`
      );
    }
    if (run.controlState === "pause_requested") return run;
    db.prepare(`
      UPDATE workflow_runs SET
        control_state = 'pause_requested',
        resume_phase = ?,
        progress_revision = progress_revision + 1,
        last_activity_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(run.status, clock, clock, run.id);
    return getWorkflowRun(db, run.id);
  });
}

function resumeWorkflowRun(db, {
  workflowRunId,
  batchModelRevision,
  batchModelVerifiedAt,
  now
}) {
  const clock = requiredNow(now);
  return immediateTransaction(db, () => {
    const run = requiredWorkflowRun(db, workflowRunId);
    if (TERMINAL_STATUSES.has(run.status)) {
      throw controlError("WORKFLOW_RUN_TERMINAL", "workflow run is already terminal and cannot be resumed");
    }
    if (run.controlState === "stop_requested") {
      throw controlError(
        "WORKFLOW_RESUME_NOT_ALLOWED",
        "workflow stop was requested and cannot be resumed"
      );
    }
    if (run.status !== "paused") {
      // Repeated form submission after a successful resume is idempotent and
      // must never create another recovery generation. Idempotency only
      // applies when the run is already active with no pending control.
      if (RESUME_TARGET_STATUSES.has(run.status) && run.controlState === "none") return run;
      throw controlError(
        "WORKFLOW_RESUME_NOT_ALLOWED",
        `workflow run ${run.status} cannot be resumed; only paused runs can resume`
      );
    }
    const targetPhase = run.resumePhase || "analyzing";
    const modelCaused = MODEL_PAUSE_CODES.has(String(run.errorCode || ""));
    if (!modelCaused) {
      return transitionWorkflowRun(db, {
        id: run.id,
        status: targetPhase,
        controlState: "none",
        resumePhase: null,
        recoveryGeneration: run.recoveryGeneration,
        circuitTimeoutJobCount: run.circuitTimeoutJobCount,
        lifetimeTimeoutJobCount: run.lifetimeTimeoutJobCount,
        modelConfigRevision: run.modelConfigRevision,
        progressRevision: run.progressRevision + 1,
        lastActivityAt: clock,
        updatedAt: clock
      });
    }

    const revision = String(batchModelRevision || "").trim();
    const verifiedAtMs = Date.parse(String(batchModelVerifiedAt || ""));
    const pauseBoundaryMs = Math.max(
      Date.parse(run.updatedAt || ""),
      Date.parse(run.lastActivityAt || "")
    );
    if (!revision || !Number.isFinite(verifiedAtMs) || !Number.isFinite(pauseBoundaryMs)
      || verifiedAtMs <= pauseBoundaryMs) {
      throw controlError(
        "WORKFLOW_MODEL_RECHECK_REQUIRED",
        "batch model must be verified strictly after the pause before resuming"
      );
    }

    const nextGeneration = run.recoveryGeneration + 1;
    migrateFinalTimeoutTasks(db, run, nextGeneration, revision, clock);
    migrateConfigurationTriggerTasks(db, run, nextGeneration, revision, clock);
    updateUnfinishedTaskRevision(db, run.id, revision, clock);

    return transitionWorkflowRun(db, {
      id: run.id,
      status: targetPhase,
      controlState: "none",
      resumePhase: null,
      recoveryGeneration: nextGeneration,
      circuitTimeoutJobCount: 0,
      lifetimeTimeoutJobCount: run.lifetimeTimeoutJobCount,
      modelConfigRevision: revision,
      progressRevision: run.progressRevision + 1,
      lastActivityAt: clock,
      updatedAt: clock
    });
  });
}

function requestWorkflowStop(db, { workflowRunId, confirmStop, now }) {
  const clock = requiredNow(now);
  return immediateTransaction(db, () => {
    const run = requiredWorkflowRun(db, workflowRunId);
    if (TERMINAL_STATUSES.has(run.status)) {
      if (run.status === "stopped") {
        return { workflow: run, stopConsumesRunSlot: workflowRunConsumesSlot(run) };
      }
      throw controlError("WORKFLOW_RUN_TERMINAL", "workflow run is already terminal and cannot be stopped");
    }
    if (confirmStop !== true) {
      throw controlError(
        "WORKFLOW_STOP_CONFIRMATION_REQUIRED",
        "stopping a workflow requires confirmStop === true"
      );
    }
    if (run.controlState === "stop_requested") {
      return { workflow: run, stopConsumesRunSlot: workflowRunConsumesSlot(run) };
    }
    db.prepare(`
      UPDATE workflow_runs SET
        control_state = 'stop_requested',
        progress_revision = progress_revision + 1,
        last_activity_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(clock, clock, run.id);
    const workflow = getWorkflowRun(db, run.id);
    return { workflow, stopConsumesRunSlot: workflowRunConsumesSlot(run) };
  });
}

function finalizeWorkflowControl(db, { workflowRunId, now }) {
  const clock = requiredNow(now);
  return immediateTransaction(db, () => {
    const run = requiredWorkflowRun(db, workflowRunId);
    if (run.controlState === "none") return run;
    if (run.controlState === "pause_requested") {
      // An interrupted run supersedes a stale pause request: never turn an
      // orphaned run into paused from a finalize call. Recovery owns the run.
      if (run.status === "interrupted") return run;
      if (run.status !== "paused") {
        releaseWorkflowScanLease(db, run);
        return transitionWorkflowRun(db, {
          id: run.id,
          status: "paused",
          controlState: "none",
          resumePhase: run.resumePhase || "analyzing",
          progressRevision: run.progressRevision + 1,
          lastActivityAt: clock,
          updatedAt: clock
        });
      }
      // Executor already moved the run to paused but left the control flag.
      return transitionWorkflowRun(db, {
        id: run.id,
        status: "paused",
        controlState: "none",
        resumePhase: run.resumePhase || "analyzing",
        updatedAt: clock
      });
    }

    markWorkflowJobTasksStopped(db, { workflowRunId: run.id, now: clock });
    finishWorkflowScanRun(db, run, clock);
    releaseWorkflowScanLease(db, run);
    if (run.status !== "stopped") {
      return transitionWorkflowRun(db, {
        id: run.id,
        status: "stopped",
        controlState: "none",
        progressRevision: run.progressRevision + 1,
        lastActivityAt: clock,
        updatedAt: clock
      });
    }
    return transitionWorkflowRun(db, {
      id: run.id,
      status: "stopped",
      controlState: "none",
      updatedAt: clock
    });
  });
}

function workflowRunConsumesSlot(run) {
  if (!run || typeof run !== "object") return false;
  const status = String(run.status || "");
  if (["completed", "failed"].includes(status)) return true;
  if (status !== "stopped") return false;
  if (run.platformAccessStartedAt) return true;
  const access = run.metrics && typeof run.metrics === "object" ? run.metrics.access : null;
  return Boolean(access) && (
    Number(access.details || 0) > 0
    || Number(access.pages || 0) > 0
    || Number(access.scrolls || 0) > 0
  );
}

function workflowStopPreview(db, { workflowRunId }) {
  const run = requiredWorkflowRun(db, workflowRunId);
  const counts = countWorkflowJobTaskStatuses(db, workflowRunId);
  const rawAccess = run.metrics && typeof run.metrics === "object" ? run.metrics.access : null;
  const access = {
    details: Number(rawAccess?.details || 0),
    pages: Number(rawAccess?.pages || 0),
    scrolls: Number(rawAccess?.scrolls || 0)
  };
  return {
    collected: counts.total,
    analyzed: completedWorkflowAnalysisCount(counts),
    failed: counts.failed,
    unfinished: counts.pending + counts.retryPending + counts.running,
    access,
    consumesRunSlot: workflowRunConsumesSlot({ ...run, status: "stopped" })
  };
}

function migrateFinalTimeoutTasks(db, run, nextGeneration, revision, clock) {
  db.prepare(`
    UPDATE workflow_job_tasks SET
      status = 'retry_pending',
      recovery_generation = ?,
      attempt_count_in_generation = 0,
      priority = 10,
      available_at = NULL,
      lease_owner = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      finished_at = NULL,
      model_config_revision = ?,
      updated_at = ?
    WHERE workflow_run_id = ?
      AND status = 'failed'
      AND last_error_code = 'MODEL_TIMEOUT'
      AND recovery_generation = ?
  `).run(
    nextGeneration,
    revision,
    clock,
    run.id,
    run.recoveryGeneration
  );
}

function migrateConfigurationTriggerTasks(db, run, nextGeneration, revision, clock) {
  db.prepare(`
    UPDATE workflow_job_tasks SET
      recovery_generation = ?,
      attempt_count_in_generation = 0,
      priority = 10,
      available_at = NULL,
      lease_owner = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      finished_at = NULL,
      model_config_revision = ?,
      updated_at = ?
    WHERE workflow_run_id = ?
      AND status = 'retry_pending'
      AND last_error_kind = 'configuration'
      AND recovery_generation = ?
  `).run(
    nextGeneration,
    revision,
    clock,
    run.id,
    run.recoveryGeneration
  );
}

function updateUnfinishedTaskRevision(db, workflowRunId, revision, clock) {
  const placeholders = [...UNFINISHED_TASK_STATUSES].map(() => "?").join(", ");
  db.prepare(`
    UPDATE workflow_job_tasks SET
      model_config_revision = ?,
      updated_at = ?
    WHERE workflow_run_id = ?
      AND status IN (${placeholders})
  `).run(revision, clock, workflowRunId, ...UNFINISHED_TASK_STATUSES);
}

function finishWorkflowScanRun(db, run, clock) {
  if (!run.scanRunId) return null;
  const scan = db.prepare("SELECT * FROM scan_runs WHERE id = ?").get(run.scanRunId);
  if (!scan || scan.status !== "running") return scan || null;
  db.prepare(`
    UPDATE scan_runs SET
      status = 'interrupted',
      heartbeat_at = ?,
      finished_at = ?,
      stop_code = 'WORKFLOW_STOP_REQUESTED',
      stop_message = 'workflow stop requested after safe unit settled'
    WHERE id = ? AND status = 'running'
  `).run(clock, clock, scan.id);
  if (scan.batch_id) {
    const batch = db.prepare("SELECT status FROM batches WHERE id = ?").get(scan.batch_id);
    const rebound = db.prepare(
      "SELECT 1 FROM scan_runs WHERE batch_id = ? AND id <> ? AND status = 'running' LIMIT 1"
    ).get(scan.batch_id, scan.id);
    if (batch?.status === "running" && !rebound) {
      db.prepare(`
        UPDATE batches SET
          status = 'interrupted',
          finished_at = ?,
          stop_code = 'WORKFLOW_STOP_REQUESTED',
          stop_message = 'workflow stop requested after safe unit settled'
        WHERE id = ?
      `).run(clock, scan.batch_id);
    }
  }
  return scan;
}

function releaseWorkflowScanLease(db, run) {
  if (!run.scanRunId) return false;
  const scan = db.prepare("SELECT site, status, lease_owner FROM scan_runs WHERE id = ?").get(run.scanRunId);
  // Never release by site or port alone; only the exact owner of the exact scan run.
  if (!scan || scan.status === "running" || !scan.lease_owner) return false;
  const result = db.prepare("DELETE FROM site_scan_leases WHERE site = ? AND owner = ?")
    .run(scan.site, scan.lease_owner);
  return Number(result.changes || 0) > 0;
}

function requiredWorkflowRun(db, workflowRunId) {
  const run = getWorkflowRun(db, workflowRunId);
  if (!run) {
    throw controlError(
      "WORKFLOW_CONTROL_TARGET_MISMATCH",
      `workflow run ${workflowRunId} does not exist`
    );
  }
  return run;
}

function requiredNow(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw controlError("WORKFLOW_CONTROL_TIME_INVALID", `invalid control time ${value}`);
  }
  return new Date(ms).toISOString();
}

function controlError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  requestWorkflowPause,
  resumeWorkflowRun,
  requestWorkflowStop,
  finalizeWorkflowControl,
  workflowRunConsumesSlot,
  workflowStopPreview
};
