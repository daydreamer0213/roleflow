"use strict";

const assert = require("node:assert/strict");
const {
  openDb,
  createBatch,
  createScanRun,
  createWorkflowRun,
  getWorkflowRun,
  getScanRun,
  listWorkflowRuns,
  getActiveWorkflowRun,
  transitionWorkflowRun,
  attachWorkflowScan,
  upsertJob,
  insertWorkflowJobTaskRow,
  acquireSiteScanLease,
  getSiteScanLease
} = require("../src/core/storage");
const {
  requestWorkflowPause,
  resumeWorkflowRun,
  requestWorkflowStop,
  finalizeWorkflowControl,
  workflowRunConsumesSlot,
  workflowStopPreview
} = require("../src/core/workflow_control");
const { countSlotConsumingRuns } = require("../src/core/workflow_run");

const db = openDb(":memory:");

try {
  testPauseTransitionAndIdempotency();
  testFinalizePauseSettlesControlState();
  testResumeManualPauseKeepsGenerationAndRevision();
  testResumeModelRecheckGate();
  testResumeRecoveryGenerationTaskMigration();
  testResumeRejections();
  testResumeRejectsStopAndSettlingControl();
  testStopConfirmationAndIdempotency();
  testExactLeaseReleaseOnlyTargetRun();
  testRunSlotSemantics();
  testActiveRunBlocksButIsNotDoubleCounted();
  testStopPreviewIsDatabaseDerived();
  testFinalizePauseDoesNotTouchInterrupted();
  console.log("workflow_control_smoke ok");
} finally {
  db.close();
}

function testPauseTransitionAndIdempotency() {
  const { profileId, planId } = seedPlan(db);
  const analyzing = seedAnalyzingWorkflow(db, { profileId, planId, localDay: "2026-08-01" });
  const beforeRevision = analyzing.workflow.progressRevision;
  const pausedRequest = requestWorkflowPause(db, {
    workflowRunId: analyzing.workflow.id,
    now: "2026-08-01T02:00:00.000Z"
  });
  assert.strictEqual(pausedRequest.controlState, "pause_requested");
  assert.strictEqual(pausedRequest.resumePhase, "analyzing");
  assert.strictEqual(pausedRequest.progressRevision, beforeRevision + 1);

  const repeated = requestWorkflowPause(db, {
    workflowRunId: analyzing.workflow.id,
    now: "2026-08-01T02:00:01.000Z"
  });
  assert.strictEqual(repeated.controlState, "pause_requested");
  assert.strictEqual(repeated.progressRevision, beforeRevision + 1);

  const scanning = seedScanningWorkflow(db, { profileId, planId, localDay: "2026-08-02" });
  const scanningPause = requestWorkflowPause(db, {
    workflowRunId: scanning.workflow.id,
    now: "2026-08-02T02:00:00.000Z"
  });
  assert.strictEqual(scanningPause.resumePhase, "scanning");

  const review = seedWorkflow(db, { profileId, planId, localDay: "2026-08-03" });
  transitionWorkflowRun(db, { id: review.id, status: "scanning" });
  transitionWorkflowRun(db, { id: review.id, status: "analyzing" });
  transitionWorkflowRun(db, { id: review.id, status: "review_required" });
  assert.throws(
    () => requestWorkflowPause(db, { workflowRunId: review.id, now: "2026-08-03T02:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_PAUSE_NOT_ALLOWED"
  );

  const communicating = seedWorkflow(db, { profileId, planId, localDay: "2026-08-04" });
  transitionWorkflowRun(db, { id: communicating.id, status: "scanning" });
  transitionWorkflowRun(db, { id: communicating.id, status: "analyzing" });
  transitionWorkflowRun(db, { id: communicating.id, status: "review_required" });
  transitionWorkflowRun(db, { id: communicating.id, status: "communicating" });
  assert.throws(
    () => requestWorkflowPause(db, { workflowRunId: communicating.id, now: "2026-08-04T02:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_PAUSE_NOT_ALLOWED"
  );

  const terminal = seedWorkflow(db, { profileId, planId, localDay: "2026-08-05" });
  transitionWorkflowRun(db, { id: terminal.id, status: "scanning" });
  transitionWorkflowRun(db, { id: terminal.id, status: "analyzing" });
  transitionWorkflowRun(db, { id: terminal.id, status: "review_required" });
  transitionWorkflowRun(db, { id: terminal.id, status: "completed" });
  assert.throws(
    () => requestWorkflowPause(db, { workflowRunId: terminal.id, now: "2026-08-05T02:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_RUN_TERMINAL"
  );

  assert.throws(
    () => requestWorkflowPause(db, { workflowRunId: "missing-pause", now: "2026-08-05T02:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_CONTROL_TARGET_MISMATCH"
  );
}

function testFinalizePauseSettlesControlState() {
  const { profileId, planId } = seedPlan(db);
  const analyzing = seedAnalyzingWorkflow(db, { profileId, planId, localDay: "2026-08-06" });
  requestWorkflowPause(db, { workflowRunId: analyzing.workflow.id, now: "2026-08-06T02:00:00.000Z" });
  const paused = finalizeWorkflowControl(db, {
    workflowRunId: analyzing.workflow.id,
    now: "2026-08-06T02:05:00.000Z"
  });
  assert.strictEqual(paused.status, "paused");
  assert.strictEqual(paused.controlState, "none");
  assert.strictEqual(paused.resumePhase, "analyzing");

  const again = finalizeWorkflowControl(db, {
    workflowRunId: analyzing.workflow.id,
    now: "2026-08-06T02:06:00.000Z"
  });
  assert.strictEqual(again.status, "paused");
  assert.strictEqual(again.controlState, "none");

  // Legacy executor path leaves paused + pause_requested; finalize clears it.
  const legacy = seedAnalyzingWorkflow(db, { profileId, planId, localDay: "2026-08-07" });
  transitionWorkflowRun(db, {
    id: legacy.workflow.id,
    status: "paused",
    controlState: "pause_requested",
    resumePhase: "analyzing"
  });
  const settled = finalizeWorkflowControl(db, {
    workflowRunId: legacy.workflow.id,
    now: "2026-08-07T02:05:00.000Z"
  });
  assert.strictEqual(settled.status, "paused");
  assert.strictEqual(settled.controlState, "none");

  const noop = finalizeWorkflowControl(db, {
    workflowRunId: analyzing.workflow.id,
    now: "2026-08-06T02:07:00.000Z"
  });
  assert.strictEqual(noop.controlState, "none");
}

function testResumeManualPauseKeepsGenerationAndRevision() {
  const { profileId, planId } = seedPlan(db);
  const scenario = seedAnalyzingWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-08-08",
    modelConfigRevision: "rev-manual",
    taskStates: [
      { status: "pending" },
      { status: "retry_pending", attempts: 1, totalAttempts: 1, priority: 20 }
    ]
  });
  const workflowId = scenario.workflow.id;
  requestWorkflowPause(db, { workflowRunId: workflowId, now: "2026-08-08T02:00:00.000Z" });
  finalizeWorkflowControl(db, { workflowRunId: workflowId, now: "2026-08-08T02:05:00.000Z" });

  const resumed = resumeWorkflowRun(db, {
    workflowRunId: workflowId,
    now: "2026-08-08T03:00:00.000Z"
  });
  assert.strictEqual(resumed.status, "analyzing");
  assert.strictEqual(resumed.controlState, "none");
  assert.strictEqual(resumed.resumePhase, null);
  assert.strictEqual(resumed.recoveryGeneration, 0);
  assert.strictEqual(resumed.modelConfigRevision, "rev-manual");

  const tasks = workflowTasks(db, workflowId);
  assert.strictEqual(tasks[0].model_config_revision, "rev-manual");
  assert.strictEqual(tasks[1].status, "retry_pending");
  assert.strictEqual(tasks[1].recovery_generation, 0);
  assert.strictEqual(tasks[1].priority, 20);
  assert.strictEqual(tasks[1].model_config_revision, "rev-manual");

  const again = resumeWorkflowRun(db, {
    workflowRunId: workflowId,
    now: "2026-08-08T03:00:01.000Z"
  });
  assert.strictEqual(again.recoveryGeneration, 0);
  assert.strictEqual(again.status, "analyzing");

  const scanning = seedScanningWorkflow(db, { profileId, planId, localDay: "2026-08-09" });
  requestWorkflowPause(db, { workflowRunId: scanning.workflow.id, now: "2026-08-09T02:00:00.000Z" });
  finalizeWorkflowControl(db, { workflowRunId: scanning.workflow.id, now: "2026-08-09T02:05:00.000Z" });
  const resumedScan = resumeWorkflowRun(db, {
    workflowRunId: scanning.workflow.id,
    now: "2026-08-09T03:00:00.000Z"
  });
  assert.strictEqual(resumedScan.status, "scanning");
  assert.strictEqual(resumedScan.id, scanning.workflow.id);
  assert.strictEqual(resumedScan.sequence, scanning.workflow.sequence);
}

function testResumeModelRecheckGate() {
  const { profileId, planId } = seedPlan(db);
  const scenario = seedAnalyzingWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-08-10",
    modelConfigRevision: "rev-old"
  });
  const workflowId = scenario.workflow.id;
  db.prepare(`UPDATE workflow_runs
    SET error_code = 'MODEL_TIMEOUT_CIRCUIT_OPEN', circuit_timeout_job_count = 10, lifetime_timeout_job_count = 10
    WHERE id = ?`).run(workflowId);
  requestWorkflowPause(db, { workflowRunId: workflowId, now: "2026-08-10T02:00:00.000Z" });
  const paused = finalizeWorkflowControl(db, { workflowRunId: workflowId, now: "2026-08-10T02:05:00.000Z" });
  assert.strictEqual(paused.status, "paused");

  assert.throws(
    () => resumeWorkflowRun(db, {
      workflowRunId: workflowId,
      batchModelRevision: "rev-new",
      batchModelVerifiedAt: "2026-08-10T02:05:00.000Z",
      now: "2026-08-10T03:00:00.000Z"
    }),
    (error) => error.code === "WORKFLOW_MODEL_RECHECK_REQUIRED"
  );
  assert.throws(
    () => resumeWorkflowRun(db, { workflowRunId: workflowId, now: "2026-08-10T03:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_MODEL_RECHECK_REQUIRED"
  );

  const resumed = resumeWorkflowRun(db, {
    workflowRunId: workflowId,
    batchModelRevision: "rev-new",
    batchModelVerifiedAt: "2026-08-10T02:05:01.000Z",
    now: "2026-08-10T03:00:00.000Z"
  });
  assert.strictEqual(resumed.status, "analyzing");
  assert.strictEqual(resumed.controlState, "none");
  assert.strictEqual(resumed.recoveryGeneration, 1);
  assert.strictEqual(resumed.circuitTimeoutJobCount, 0);
  assert.strictEqual(resumed.lifetimeTimeoutJobCount, 10);
  assert.strictEqual(resumed.modelConfigRevision, "rev-new");

  const again = resumeWorkflowRun(db, {
    workflowRunId: workflowId,
    batchModelRevision: "rev-new",
    batchModelVerifiedAt: "2026-08-10T02:05:02.000Z",
    now: "2026-08-10T03:00:01.000Z"
  });
  assert.strictEqual(again.recoveryGeneration, 1);
}

function testResumeRecoveryGenerationTaskMigration() {
  const { profileId, planId } = seedPlan(db);
  const scenario = seedAnalyzingWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-08-11",
    modelConfigRevision: "rev-0",
    taskStates: [
      { status: "failed", generation: 0, attempts: 2, totalAttempts: 2, lastErrorCode: "MODEL_TIMEOUT", errorKind: "retryable" },
      { status: "failed", generation: 0, attempts: 2, totalAttempts: 2, lastErrorCode: "MODEL_TIMEOUT", errorKind: "retryable" },
      { status: "succeeded", generation: 0, attempts: 1, totalAttempts: 1 },
      { status: "skipped", generation: 0, attempts: 1, totalAttempts: 1 },
      { status: "failed", generation: 0, attempts: 2, totalAttempts: 2, lastErrorCode: "MODEL_CONTRACT_INVALID", errorKind: "terminal" },
      { status: "pending", generation: 0 },
      { status: "retry_pending", generation: 0, attempts: 1, totalAttempts: 1, priority: 20, lastErrorCode: "MODEL_TIMEOUT", errorKind: "retryable" },
      { status: "retry_pending", generation: 0, attempts: 1, totalAttempts: 1, priority: 20, lastErrorCode: "MODEL_AUTH_FAILED", errorKind: "configuration" },
      { status: "running", generation: 0, attempts: 1, totalAttempts: 1, leaseOwner: "worker-old" }
    ]
  });
  const workflowId = scenario.workflow.id;
  db.prepare(`UPDATE workflow_runs
    SET error_code = 'MODEL_CONFIGURATION_REQUIRED', circuit_timeout_job_count = 3, lifetime_timeout_job_count = 12
    WHERE id = ?`).run(workflowId);
  requestWorkflowPause(db, { workflowRunId: workflowId, now: "2026-08-11T02:00:00.000Z" });
  finalizeWorkflowControl(db, { workflowRunId: workflowId, now: "2026-08-11T02:05:00.000Z" });

  const resumed = resumeWorkflowRun(db, {
    workflowRunId: workflowId,
    batchModelRevision: "rev-1",
    batchModelVerifiedAt: "2026-08-11T02:05:01.000Z",
    now: "2026-08-11T03:00:00.000Z"
  });
  assert.strictEqual(resumed.recoveryGeneration, 1);
  assert.strictEqual(resumed.circuitTimeoutJobCount, 0);
  assert.strictEqual(resumed.lifetimeTimeoutJobCount, 12);
  assert.strictEqual(resumed.modelConfigRevision, "rev-1");

  const tasks = workflowTasks(db, workflowId);
  const [timeoutA, timeoutB, succeeded, skipped, unrelated, pending, ordinaryRetry, configTrigger, running] = tasks;
  for (const task of [timeoutA, timeoutB]) {
    assert.strictEqual(task.status, "retry_pending");
    assert.strictEqual(task.recovery_generation, 1);
    assert.strictEqual(task.attempt_count_in_generation, 0);
    assert.strictEqual(task.priority, 10);
    assert.strictEqual(task.model_config_revision, "rev-1");
    assert.strictEqual(task.available_at, null);
    assert.strictEqual(task.lease_owner, null);
    assert.strictEqual(task.finished_at, null);
  }
  assert.strictEqual(succeeded.status, "succeeded");
  assert.strictEqual(succeeded.model_config_revision, "rev-0");
  assert.strictEqual(skipped.status, "skipped");
  assert.strictEqual(skipped.model_config_revision, "rev-0");
  assert.strictEqual(unrelated.status, "failed");
  assert.strictEqual(unrelated.model_config_revision, "rev-0");
  assert.strictEqual(pending.status, "pending");
  assert.strictEqual(pending.recovery_generation, 0);
  assert.strictEqual(pending.model_config_revision, "rev-1");
  assert.strictEqual(ordinaryRetry.status, "retry_pending");
  assert.strictEqual(ordinaryRetry.recovery_generation, 0);
  assert.strictEqual(ordinaryRetry.attempt_count_in_generation, 1);
  assert.strictEqual(ordinaryRetry.priority, 20);
  assert.strictEqual(ordinaryRetry.model_config_revision, "rev-1");
  assert.strictEqual(configTrigger.status, "retry_pending");
  assert.strictEqual(configTrigger.recovery_generation, 1);
  assert.strictEqual(configTrigger.attempt_count_in_generation, 0);
  assert.strictEqual(configTrigger.priority, 10);
  assert.strictEqual(configTrigger.model_config_revision, "rev-1");
  assert.strictEqual(running.status, "running");
  assert.strictEqual(running.lease_owner, "worker-old");
  assert.strictEqual(running.model_config_revision, "rev-1");

  const again = resumeWorkflowRun(db, {
    workflowRunId: workflowId,
    batchModelRevision: "rev-1",
    batchModelVerifiedAt: "2026-08-11T02:05:02.000Z",
    now: "2026-08-11T03:00:01.000Z"
  });
  assert.strictEqual(again.recoveryGeneration, 1);
}

function testResumeRejections() {
  const { profileId, planId } = seedPlan(db);
  const stopped = seedWorkflow(db, { profileId, planId, localDay: "2026-08-12" });
  transitionWorkflowRun(db, { id: stopped.id, status: "scanning" });
  transitionWorkflowRun(db, { id: stopped.id, status: "stopped" });
  assert.throws(
    () => resumeWorkflowRun(db, { workflowRunId: stopped.id, now: "2026-08-12T02:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_RUN_TERMINAL"
  );

  const failed = seedWorkflow(db, { profileId, planId, localDay: "2026-08-13" });
  transitionWorkflowRun(db, { id: failed.id, status: "scanning" });
  transitionWorkflowRun(db, { id: failed.id, status: "interrupted", errorCode: "SCAN_FAILED" });
  transitionWorkflowRun(db, { id: failed.id, status: "failed" });
  assert.throws(
    () => resumeWorkflowRun(db, { workflowRunId: failed.id, now: "2026-08-13T02:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_RUN_TERMINAL"
  );

  const created = seedWorkflow(db, { profileId, planId, localDay: "2026-08-14" });
  assert.throws(
    () => resumeWorkflowRun(db, { workflowRunId: created.id, now: "2026-08-14T02:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_RESUME_NOT_ALLOWED"
  );

  assert.throws(
    () => resumeWorkflowRun(db, { workflowRunId: "missing-resume", now: "2026-08-14T02:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_CONTROL_TARGET_MISMATCH"
  );
}

function testResumeRejectsStopAndSettlingControl() {
  const { profileId, planId } = seedPlan(db);

  const stopping = seedAnalyzingWorkflow(db, { profileId, planId, localDay: "2026-08-24" });
  transitionWorkflowRun(db, {
    id: stopping.workflow.id,
    status: "analyzing",
    controlState: "stop_requested"
  });
  assert.throws(
    () => resumeWorkflowRun(db, { workflowRunId: stopping.workflow.id, now: "2026-08-24T02:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_RESUME_NOT_ALLOWED"
  );

  const pausedStopping = seedAnalyzingWorkflow(db, { profileId, planId, localDay: "2026-08-25" });
  transitionWorkflowRun(db, {
    id: pausedStopping.workflow.id,
    status: "paused",
    controlState: "stop_requested",
    resumePhase: "analyzing"
  });
  assert.throws(
    () => resumeWorkflowRun(db, { workflowRunId: pausedStopping.workflow.id, now: "2026-08-25T02:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_RESUME_NOT_ALLOWED"
  );

  const settling = seedAnalyzingWorkflow(db, { profileId, planId, localDay: "2026-08-26" });
  requestWorkflowPause(db, { workflowRunId: settling.workflow.id, now: "2026-08-26T02:00:00.000Z" });
  assert.strictEqual(getWorkflowRun(db, settling.workflow.id).controlState, "pause_requested");
  assert.throws(
    () => resumeWorkflowRun(db, { workflowRunId: settling.workflow.id, now: "2026-08-26T02:00:01.000Z" }),
    (error) => error.code === "WORKFLOW_RESUME_NOT_ALLOWED"
  );

  const interruptedStopping = seedAnalyzingWorkflow(db, { profileId, planId, localDay: "2026-08-27" });
  transitionWorkflowRun(db, {
    id: interruptedStopping.workflow.id,
    status: "interrupted",
    controlState: "stop_requested",
    errorCode: "SCAN_RUN_ORPHANED"
  });
  assert.throws(
    () => resumeWorkflowRun(db, { workflowRunId: interruptedStopping.workflow.id, now: "2026-08-27T02:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_RESUME_NOT_ALLOWED"
  );
}

function testStopConfirmationAndIdempotency() {
  const { profileId, planId } = seedPlan(db);
  const scenario = seedAnalyzingWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-08-15",
    taskStates: [
      { status: "pending" },
      { status: "retry_pending", attempts: 1, totalAttempts: 1, priority: 20 }
    ]
  });
  const workflowId = scenario.workflow.id;
  assert.throws(
    () => requestWorkflowStop(db, { workflowRunId: workflowId, now: "2026-08-15T02:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_STOP_CONFIRMATION_REQUIRED"
  );
  assert.throws(
    () => requestWorkflowStop(db, { workflowRunId: workflowId, confirmStop: false, now: "2026-08-15T02:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_STOP_CONFIRMATION_REQUIRED"
  );

  const requested = requestWorkflowStop(db, {
    workflowRunId: workflowId,
    confirmStop: true,
    now: "2026-08-15T02:00:00.000Z"
  });
  assert.strictEqual(requested.workflow.controlState, "stop_requested");
  assert.strictEqual(requested.stopConsumesRunSlot, false);
  const requestedRevision = requested.workflow.progressRevision;
  const repeated = requestWorkflowStop(db, {
    workflowRunId: workflowId,
    confirmStop: true,
    now: "2026-08-15T02:00:01.000Z"
  });
  assert.strictEqual(repeated.workflow.progressRevision, requestedRevision);

  const stopped = finalizeWorkflowControl(db, { workflowRunId: workflowId, now: "2026-08-15T02:05:00.000Z" });
  assert.strictEqual(stopped.status, "stopped");
  assert.strictEqual(stopped.controlState, "none");
  const tasks = workflowTasks(db, workflowId);
  assert.deepStrictEqual(tasks.map((task) => task.status), ["stopped", "stopped"]);
  assert.ok(tasks.every((task) => task.lease_owner === null && task.finished_at));

  const idempotent = requestWorkflowStop(db, {
    workflowRunId: workflowId,
    confirmStop: true,
    now: "2026-08-15T02:06:00.000Z"
  });
  assert.strictEqual(idempotent.workflow.status, "stopped");
  assert.strictEqual(idempotent.stopConsumesRunSlot, false);

  const completed = seedWorkflow(db, { profileId, planId, localDay: "2026-08-16" });
  transitionWorkflowRun(db, { id: completed.id, status: "scanning" });
  transitionWorkflowRun(db, { id: completed.id, status: "analyzing" });
  transitionWorkflowRun(db, { id: completed.id, status: "review_required" });
  transitionWorkflowRun(db, { id: completed.id, status: "completed" });
  assert.throws(
    () => requestWorkflowStop(db, { workflowRunId: completed.id, confirmStop: true, now: "2026-08-16T02:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_RUN_TERMINAL"
  );
  assert.throws(
    () => requestWorkflowStop(db, { workflowRunId: "missing-stop", confirmStop: true, now: "2026-08-16T02:00:00.000Z" }),
    (error) => error.code === "WORKFLOW_CONTROL_TARGET_MISMATCH"
  );
}

function testExactLeaseReleaseOnlyTargetRun() {
  const { profileId, planId } = seedPlan(db);
  const a = seedScanningWorkflow(db, { profileId, planId, localDay: "2026-08-17" });
  const b = seedScanningWorkflow(db, { profileId, planId, localDay: "2026-08-18" });
  db.prepare("UPDATE scan_runs SET lease_owner = 'lease-owner-A' WHERE id = ?").run(a.scan.id);
  db.prepare("UPDATE scan_runs SET lease_owner = 'lease-owner-B' WHERE id = ?").run(b.scan.id);
  acquireSiteScanLease(db, { site: "boss", owner: "lease-owner-A", planId, ttlMs: 600_000 });

  requestWorkflowStop(db, { workflowRunId: a.workflow.id, confirmStop: true, now: "2026-08-17T02:00:00.000Z" });
  const stoppedA = finalizeWorkflowControl(db, { workflowRunId: a.workflow.id, now: "2026-08-17T02:05:00.000Z" });
  assert.strictEqual(stoppedA.status, "stopped");
  assert.strictEqual(getScanRun(db, a.scan.id).status, "interrupted");
  assert.strictEqual(getSiteScanLease(db, "boss"), null);
  assert.strictEqual(getScanRun(db, b.scan.id).status, "running");
  assert.strictEqual(getWorkflowRun(db, b.workflow.id).status, "scanning");

  const c = seedScanningWorkflow(db, { profileId, planId, localDay: "2026-08-19" });
  db.prepare("UPDATE scan_runs SET lease_owner = 'lease-owner-C' WHERE id = ?").run(c.scan.id);
  db.prepare(`INSERT INTO site_scan_leases(site, owner, command, plan_id, acquired_at, expires_at)
    VALUES ('liepin', 'lease-owner-X', 'scan', ?, '2026-08-19T01:00:00.000Z', '2030-01-01T00:00:00.000Z')`)
    .run(planId);
  requestWorkflowStop(db, { workflowRunId: c.workflow.id, confirmStop: true, now: "2026-08-19T02:00:00.000Z" });
  finalizeWorkflowControl(db, { workflowRunId: c.workflow.id, now: "2026-08-19T02:05:00.000Z" });
  assert.strictEqual(getScanRun(db, c.scan.id).status, "interrupted");
  assert.strictEqual(getSiteScanLease(db, "liepin").owner, "lease-owner-X");
}

function testRunSlotSemantics() {
  assert.strictEqual(workflowRunConsumesSlot(null), false);
  assert.strictEqual(workflowRunConsumesSlot({ status: "stopped" }), false);
  assert.strictEqual(
    workflowRunConsumesSlot({ status: "stopped", platformAccessStartedAt: "2026-08-01T00:00:00.000Z" }),
    true
  );
  assert.strictEqual(
    workflowRunConsumesSlot({ status: "stopped", metrics: { access: { details: 1, pages: 0, scrolls: 0 } } }),
    true
  );
  assert.strictEqual(workflowRunConsumesSlot({ status: "completed" }), true);
  assert.strictEqual(workflowRunConsumesSlot({ status: "failed" }), true);
  assert.strictEqual(workflowRunConsumesSlot({ status: "paused" }), false);
  assert.strictEqual(workflowRunConsumesSlot({ status: "interrupted" }), false);
  assert.strictEqual(workflowRunConsumesSlot({ status: "created" }), false);
  assert.strictEqual(workflowRunConsumesSlot({ status: "scanning" }), false);
  assert.strictEqual(workflowRunConsumesSlot({ status: "analyzing" }), false);

  const runs = [
    { status: "stopped" },
    { status: "stopped", platformAccessStartedAt: "2026-08-01T00:00:00.000Z" },
    { status: "completed" },
    { status: "failed" },
    { status: "paused" },
    { status: "interrupted" }
  ];
  assert.strictEqual(runs.filter(workflowRunConsumesSlot).length, 3);
  assert.strictEqual(countSlotConsumingRuns(runs), 3);
  assert.strictEqual(countSlotConsumingRuns([{ status: "stopped" }, { status: "paused" }]), 0);
}

function testActiveRunBlocksButIsNotDoubleCounted() {
  const { profileId, planId } = seedPlan(db);
  const paused = seedAnalyzingWorkflow(db, { profileId, planId, localDay: "2026-08-20" });
  requestWorkflowPause(db, { workflowRunId: paused.workflow.id, now: "2026-08-20T02:00:00.000Z" });
  finalizeWorkflowControl(db, { workflowRunId: paused.workflow.id, now: "2026-08-20T02:05:00.000Z" });
  assert.strictEqual(
    getActiveWorkflowRun(db, { profileId, planId, localDay: "2026-08-20" }).id,
    paused.workflow.id
  );
  assert.strictEqual(
    countSlotConsumingRuns(listWorkflowRuns(db, { profileId, planId, localDay: "2026-08-20" })),
    0
  );

  const resumed = resumeWorkflowRun(db, { workflowRunId: paused.workflow.id, now: "2026-08-20T03:00:00.000Z" });
  assert.strictEqual(resumed.id, paused.workflow.id);
  assert.strictEqual(resumed.sequence, 1);
  assert.strictEqual(
    getActiveWorkflowRun(db, { profileId, planId, localDay: "2026-08-20" }).id,
    paused.workflow.id
  );

  const completed = seedAnalyzingWorkflow(db, { profileId, planId, localDay: "2026-08-21" });
  const otherPaused = seedAnalyzingWorkflow(db, { profileId, planId, localDay: "2026-08-21", sequence: 2 });
  transitionWorkflowRun(db, { id: completed.workflow.id, status: "review_required" });
  transitionWorkflowRun(db, { id: completed.workflow.id, status: "completed" });
  requestWorkflowPause(db, { workflowRunId: otherPaused.workflow.id, now: "2026-08-21T02:00:00.000Z" });
  finalizeWorkflowControl(db, { workflowRunId: otherPaused.workflow.id, now: "2026-08-21T02:05:00.000Z" });
  assert.strictEqual(
    countSlotConsumingRuns(listWorkflowRuns(db, { profileId, planId, localDay: "2026-08-21" })),
    1
  );
}

function testStopPreviewIsDatabaseDerived() {
  const { profileId, planId } = seedPlan(db);
  const scenario = seedAnalyzingWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-08-22",
    taskStates: [
      { status: "succeeded", attempts: 1, totalAttempts: 1 },
      { status: "skipped", attempts: 1, totalAttempts: 1 },
      { status: "failed", attempts: 2, totalAttempts: 2 },
      { status: "pending" },
      { status: "retry_pending", attempts: 1, totalAttempts: 1, priority: 20 }
    ]
  });
  transitionWorkflowRun(db, {
    id: scenario.workflow.id,
    status: "analyzing",
    metrics: { collected: 20, analyzed: 12, access: { details: 34, pages: 7, scrolls: 9 } }
  });
  db.prepare("UPDATE workflow_runs SET platform_access_started_at = '2026-08-22T01:06:01.000Z' WHERE id = ?")
    .run(scenario.workflow.id);
  const preview = workflowStopPreview(db, { workflowRunId: scenario.workflow.id });
  assert.deepStrictEqual(preview, {
    collected: 5,
    analyzed: 2,
    failed: 1,
    unfinished: 2,
    access: { details: 34, pages: 7, scrolls: 9 },
    consumesRunSlot: true
  });

  const noAccess = seedAnalyzingWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-08-23",
    taskStates: [{ status: "pending" }]
  });
  transitionWorkflowRun(db, {
    id: noAccess.workflow.id,
    status: "analyzing",
    metrics: { collected: 3 }
  });
  const beforeStop = workflowStopPreview(db, { workflowRunId: noAccess.workflow.id });
  assert.deepStrictEqual(beforeStop, {
    collected: 1,
    analyzed: 0,
    failed: 0,
    unfinished: 1,
    access: { details: 0, pages: 0, scrolls: 0 },
    consumesRunSlot: false
  });
  requestWorkflowStop(db, { workflowRunId: noAccess.workflow.id, confirmStop: true, now: "2026-08-23T02:00:00.000Z" });
  finalizeWorkflowControl(db, { workflowRunId: noAccess.workflow.id, now: "2026-08-23T02:05:00.000Z" });
  const afterStop = workflowStopPreview(db, { workflowRunId: noAccess.workflow.id });
  assert.deepStrictEqual(afterStop, {
    collected: 1,
    analyzed: 0,
    failed: 0,
    unfinished: 0,
    access: { details: 0, pages: 0, scrolls: 0 },
    consumesRunSlot: false
  });

  assert.throws(
    () => workflowStopPreview(db, { workflowRunId: "missing-preview" }),
    (error) => error.code === "WORKFLOW_CONTROL_TARGET_MISMATCH"
  );
}

function testFinalizePauseDoesNotTouchInterrupted() {
  const { profileId, planId } = seedPlan(db);
  const scenario = seedAnalyzingWorkflow(db, { profileId, planId, localDay: "2026-08-28" });
  transitionWorkflowRun(db, {
    id: scenario.workflow.id,
    status: "interrupted",
    controlState: "pause_requested",
    resumePhase: "analyzing",
    errorCode: "SCAN_RUN_ORPHANED",
    errorMessage: "scan heartbeat expired while pause was settling"
  });
  const result = finalizeWorkflowControl(db, {
    workflowRunId: scenario.workflow.id,
    now: "2026-08-28T02:05:00.000Z"
  });
  assert.strictEqual(result.status, "interrupted");
  assert.strictEqual(result.controlState, "pause_requested");
  assert.strictEqual(result.errorCode, "SCAN_RUN_ORPHANED");
  assert.strictEqual(getWorkflowRun(db, scenario.workflow.id).status, "interrupted");
}

function seedPlan(database) {
  const createdAt = "2026-08-01T00:00:00.000Z";
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Control Candidate', '{}', NULL, ?, ?)`).run(createdAt, createdAt).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Control Plan', '{}', NULL, 1, ?, ?)`).run(profileId, createdAt, createdAt).lastInsertRowid);
  return { profileId, planId };
}

function seedWorkflow(database, { profileId, planId, localDay, sequence = 1, modelConfigRevision = "rev-1" }) {
  return createWorkflowRun(database, {
    profileId,
    planId,
    localDay,
    sequence,
    targetSuccessCount: 35,
    inventoryCount: 0,
    candidateGap: 35,
    scanNeeded: true,
    keywords: [{ word: "RAG", priority: "A" }],
    budget: { maxDetailTotal: 120, browserPageBudget: 20 },
    planner: { remainingDailyTarget: 70, remainingRunSlots: 2 },
    modelConfigRevision,
    createdAt: `${localDay}T01:00:00.000Z`
  });
}

function seedScanningWorkflow(database, { profileId, planId, localDay, sequence = 1 }) {
  const workflow = seedWorkflow(database, { profileId, planId, localDay, sequence });
  transitionWorkflowRun(database, { id: workflow.id, status: "scanning", updatedAt: `${localDay}T01:05:00.000Z` });
  const batchId = createBatch(database, "boss", "RAG", "control scan", { profileId, searchPlanId: planId });
  const scan = createScanRun(database, { runId: `scan-${workflow.id}`, planId, batchId });
  attachWorkflowScan(database, { id: workflow.id, scanRunId: scan.id, scanBatchId: batchId });
  return { workflow: getWorkflowRun(database, workflow.id), scan, batchId };
}

function seedAnalyzingWorkflow(database, { profileId, planId, localDay, sequence = 1, modelConfigRevision = "rev-1", taskStates = [] }) {
  const workflow = seedWorkflow(database, { profileId, planId, localDay, sequence, modelConfigRevision });
  transitionWorkflowRun(database, { id: workflow.id, status: "scanning", updatedAt: `${localDay}T01:05:00.000Z` });
  const batchId = createBatch(database, "boss", "RAG", "control analysis", { profileId, searchPlanId: planId });
  const scan = createScanRun(database, { runId: `scan-${workflow.id}`, planId, batchId });
  attachWorkflowScan(database, { id: workflow.id, scanRunId: scan.id, scanBatchId: batchId });
  transitionWorkflowRun(database, { id: workflow.id, status: "analyzing", updatedAt: `${localDay}T01:06:00.000Z` });
  taskStates.forEach((state, index) => {
    const sourceId = `${localDay}-job-${index + 1}`;
    const jobId = Number(upsertJob(database, {
      source: "boss",
      sourceId,
      title: `Control Job ${index + 1}`,
      analysis: {}
    }, batchId));
    const observationId = Number(database.prepare(
      "SELECT id FROM job_observations WHERE batch_id = ? AND job_id = ?"
    ).get(batchId, jobId).id);
    insertWorkflowJobTaskRow(database, {
      workflowRunId: workflow.id,
      batchId,
      jobId,
      observationId,
      position: index + 1,
      status: "pending",
      recoveryGeneration: 0,
      modelConfigRevision,
      now: `${localDay}T01:06:00.000Z`
    });
    const taskId = Number(database.prepare(
      "SELECT id FROM workflow_job_tasks WHERE workflow_run_id = ? AND job_id = ?"
    ).get(workflow.id, jobId).id);
    const terminal = ["succeeded", "skipped", "failed"].includes(state.status || "pending");
    database.prepare(`
      UPDATE workflow_job_tasks SET
        status = ?, recovery_generation = ?, attempt_count_in_generation = ?, total_attempt_count = ?,
        priority = ?, model_config_revision = ?, last_error_code = ?, last_error_kind = ?,
        available_at = NULL, lease_owner = ?, leased_at = NULL, lease_expires_at = NULL,
        finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      state.status || "pending",
      state.generation ?? 0,
      state.attempts ?? 0,
      state.totalAttempts ?? state.attempts ?? 0,
      state.priority ?? 100,
      state.revision ?? modelConfigRevision,
      state.lastErrorCode ?? null,
      state.errorKind ?? null,
      state.leaseOwner ?? null,
      state.finishedAt !== undefined
        ? state.finishedAt
        : (terminal ? `${localDay}T01:07:00.000Z` : null),
      `${localDay}T01:07:00.000Z`,
      taskId
    );
  });
  return { workflow: getWorkflowRun(database, workflow.id), batchId, scan, taskIds: [] };
}

function workflowTasks(database, workflowId) {
  return database.prepare(`
    SELECT * FROM workflow_job_tasks
    WHERE workflow_run_id = ?
    ORDER BY position ASC, id ASC
  `).all(workflowId);
}
