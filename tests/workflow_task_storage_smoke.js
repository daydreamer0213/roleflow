const assert = require("node:assert/strict");
const {
  openDb,
  createBatch,
  createScanRun,
  createWorkflowRun,
  attachWorkflowScan,
  transitionWorkflowRun,
  upsertJob,
  insertWorkflowJobTaskRow
} = require("../src/core/storage");
const {
  initializeWorkflowJobTasks,
  claimWorkflowJobTask,
  commitWorkflowJobTaskSuccess,
  commitWorkflowJobTaskFailure,
  commitWorkflowJobTaskSkipped,
  recoverExpiredWorkflowJobTasks,
  listWorkflowJobTasks,
  listJobAnalysisAttempts
} = require("../src/core/workflow_analysis_tasks");

const db = openDb(":memory:");

try {
  testInitializationAndIdempotency();
  testInitialTaskStatusDerivation();
  testBatchAndWorkflowMismatchRejection();
  testAtomicClaimLifecycle();
  testClaimOrdering();
  testFutureAvailableAtBlocksClaim();
  testWorkflowGateReturnsNullWithoutMutation();
  testExactObservationRebuild();
  testAtomicSuccessCommit();
  testOwnerMismatchAndDuplicateRejected();
  testRollbackOnObservationWriteFailure();
  testSkippedCommit();
  testTelemetryWithAndWithoutUsage();
  testAnalyzedJobSourceMismatchRejected();
  testModelIdentityMismatchRejected();
  testStartedAtMismatchRejected();
  testNarrowInsertConflictBehavior();
  testClaimNormalizesNowToUtc();
  testListJobAnalysisAttemptsRejectsInvalidTaskId();
  testFirstRetryableFailurePersistsCooldown();
  testSecondOrdinaryFailureTerminalWithoutCounters();
  testSecondTimeoutCountsOnceAndCannotDoubleCount();
  testConfigErrorsPauseImmediatelyWithoutSecondAttempt();
  testNonRetryableFirstFailureIsTerminal();
  testExpiredLeaseRecoveryFirstAndSecondAttempts();
  testRecoverySkipsTerminalAndRespectsGates();
  testFailureOwnerMismatchAndRollback();
  testFailureIdentityCannotOverrideClaim();
  console.log("workflow_task_storage_smoke ok");
} finally {
  db.close();
}

function testInitializationAndIdempotency() {
  const scenario = seedWorkflow(db, {
    analyses: [{}, {}, {}],
    localDay: "2026-08-06",
    modelConfigRevision: "mrev-init"
  });
  const first = initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-init",
    now: "2026-08-06T00:00:00.000Z"
  });
  assert.deepStrictEqual(first, { inserted: 3, existing: 0, total: 3 });

  const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
  assert.strictEqual(tasks.length, 3);
  assert.deepStrictEqual(tasks.map((task) => task.position), [1, 2, 3]);
  assert.deepStrictEqual(tasks.map((task) => task.jobId), scenario.jobIds);
  for (const task of tasks) {
    assert.strictEqual(task.status, "pending");
    assert.strictEqual(task.modelConfigRevision, "mrev-init");
  }

  const second = initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-init",
    now: "2026-08-06T00:00:01.000Z"
  });
  assert.deepStrictEqual(second, { inserted: 0, existing: 3, total: 3 });
  const afterRepeat = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
  assert.deepStrictEqual(afterRepeat.map((task) => task.position), [1, 2, 3]);
  assert.deepStrictEqual(afterRepeat.map((task) => task.status), ["pending", "pending", "pending"]);
  assert.deepStrictEqual(afterRepeat.map((task) => task.jobId), scenario.jobIds);
}

function testInitialTaskStatusDerivation() {
  const scenario = seedWorkflow(db, {
    analyses: [
      { semanticStatus: "complete", decisionSource: "model" },
      { semanticStatus: "rule_only", decisionSource: "local_rules" },
      { semanticStatus: "pending", decisionSource: "scan" }
    ],
    localDay: "2026-08-06",
    modelConfigRevision: "mrev-status"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-status",
    now: "2026-08-06T00:00:00.000Z"
  });
  const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
  assert.deepStrictEqual(tasks.map((task) => task.status), ["succeeded", "skipped", "pending"]);
}

function testBatchAndWorkflowMismatchRejection() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-07",
    modelConfigRevision: "mrev-mismatch"
  });
  const foreignBatchId = createBatch(db, "boss", "FOREIGN", "foreign", {
    profileId: scenario.profileId,
    searchPlanId: scenario.planId
  });
  const foreignJobId = upsertJob(db, {
    source: "boss",
    sourceId: "foreign-job-1",
    title: "Foreign Job",
    analysis: {}
  }, foreignBatchId);
  assert(foreignJobId > 0);

  assert.throws(
    () => initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: foreignBatchId,
      jobs: observationEntries(db, foreignBatchId),
      modelConfigRevision: "mrev-mismatch",
      now: "2026-08-07T00:00:00.000Z"
    }),
    (error) => error.code === "WORKFLOW_TASK_WORKFLOW_BATCH_MISMATCH"
  );

  assert.throws(
    () => initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: [...observationEntries(db, scenario.batchId), ...observationEntries(db, foreignBatchId)],
      modelConfigRevision: "mrev-mismatch",
      now: "2026-08-07T00:00:00.000Z"
    }),
    (error) => error.code === "WORKFLOW_TASK_BATCH_MISMATCH"
  );
}

function testAtomicClaimLifecycle() {
  const scenario = seedWorkflow(db, {
    analyses: [{}, {}, {}],
    localDay: "2026-08-08",
    modelConfigRevision: "mrev-claim"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-claim",
    now: "2026-08-08T00:00:00.000Z"
  });

  const claimNow = "2026-08-08T00:05:00.000Z";
  const first = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-a",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: claimNow
  });
  assert(first);
  assert.strictEqual(first.task.status, "running");
  assert.strictEqual(first.task.leaseOwner, "worker-a");
  assert(first.task.leaseExpiresAt > claimNow);
  assert.strictEqual(first.task.attemptCountInGeneration, 1);
  assert.strictEqual(first.task.totalAttemptCount, 1);
  assert.strictEqual(first.task.startedAt, claimNow);
  assert.strictEqual(first.task.modelConfigRevision, "mrev-claim");
  assert.strictEqual(first.task.lastAttemptModelRevision, "revision-1");

  assert.strictEqual(first.attempt.status, "running");
  assert.strictEqual(first.attempt.taskId, first.task.id);
  assert.strictEqual(first.attempt.attemptInGeneration, 1);
  assert.strictEqual(first.attempt.totalAttemptNumber, 1);
  assert.strictEqual(first.attempt.profileKind, "batch_screening");
  assert.strictEqual(first.attempt.modelConfigRevision, "revision-1");
  assert.strictEqual(first.attempt.provider, "deepseek");
  assert.strictEqual(first.attempt.model, "deepseek-v4-flash");
  assert.strictEqual(first.attempt.thinkingMode, "disabled");
  assert.strictEqual(first.attempt.reasoningEffort, "high");
  assert.strictEqual(first.attempt.backupUsed, 0);

  const persistedAttempt = db.prepare(
    "SELECT status FROM job_analysis_attempts WHERE task_id = ?"
  ).get(first.task.id);
  assert.strictEqual(persistedAttempt.status, "running");
  const persistedTasks = listJobAnalysisAttempts(db, {
    workflowRunId: scenario.workflowId,
    taskId: first.task.id
  });
  assert.strictEqual(persistedTasks.length, 1);

  const second = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-b",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: claimNow
  });
  assert(second);
  assert.notStrictEqual(second.task.id, first.task.id);
  assert.strictEqual(second.task.leaseOwner, "worker-b");
  assert.strictEqual(second.task.attemptCountInGeneration, 1);
  assert.strictEqual(second.task.totalAttemptCount, 1);

  const run = db.prepare(
    "SELECT progress_revision, last_activity_at FROM workflow_runs WHERE id = ?"
  ).get(scenario.workflowId);
  assert.strictEqual(run.progress_revision, 2);
  assert.strictEqual(run.last_activity_at, claimNow);

  const third = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-c",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: claimNow
  });
  assert(third);
  assert.notStrictEqual(third.task.id, first.task.id);
  assert.notStrictEqual(third.task.id, second.task.id);
  assert.strictEqual(
    claimWorkflowJobTask(db, {
      workflowRunId: scenario.workflowId,
      leaseOwner: "worker-d",
      leaseTtlMs: 60_000,
      selectModelIdentity: modelIdentity,
      now: claimNow
    }),
    null
  );
}

function testClaimOrdering() {
  const scenario = seedWorkflow(db, {
    analyses: [{}, {}, {}],
    localDay: "2026-08-09",
    modelConfigRevision: "mrev-order"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-order",
    now: "2026-08-09T00:00:00.000Z"
  });
  const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
  assert.strictEqual(tasks.length, 3);
  db.prepare("UPDATE workflow_job_tasks SET priority = 10 WHERE id = ?").run(tasks[1].id);
  db.prepare("UPDATE workflow_job_tasks SET priority = 50 WHERE id = ?").run(tasks[0].id);

  const first = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-order-1",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-09T00:01:00.000Z"
  });
  assert.strictEqual(first.task.id, tasks[1].id);

  const second = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-order-2",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-09T00:01:00.000Z"
  });
  assert.strictEqual(second.task.id, tasks[0].id);

  const third = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-order-3",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-09T00:01:00.000Z"
  });
  assert.strictEqual(third.task.id, tasks[2].id);
}

function testFutureAvailableAtBlocksClaim() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-10",
    modelConfigRevision: "mrev-cooldown"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-cooldown",
    now: "2026-08-10T00:00:00.000Z"
  });
  const task = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId })[0];
  db.prepare(`
    UPDATE workflow_job_tasks
    SET status = 'retry_pending', attempt_count_in_generation = 1, total_attempt_count = 1, available_at = ?
    WHERE id = ?
  `).run("2026-08-10T12:00:00.000Z", task.id);

  const blocked = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-early",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-10T08:00:00.000Z"
  });
  assert.strictEqual(blocked, null);
  const afterBlock = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId })[0];
  assert.strictEqual(afterBlock.status, "retry_pending");
  assert.strictEqual(afterBlock.attemptCountInGeneration, 1);
  assert.strictEqual(
    db.prepare("SELECT progress_revision FROM workflow_runs WHERE id = ?").get(scenario.workflowId).progress_revision,
    0
  );

  const due = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-due",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-10T13:00:00.000Z"
  });
  assert(due);
  assert.strictEqual(due.task.id, task.id);
  assert.strictEqual(due.task.attemptCountInGeneration, 2);
  assert.strictEqual(due.task.totalAttemptCount, 2);
  assert.strictEqual(due.attempt.attemptInGeneration, 2);
  assert.strictEqual(due.attempt.totalAttemptNumber, 2);
  assert.strictEqual(due.attempt.modelConfigRevision, "revision-2");
}

function testWorkflowGateReturnsNullWithoutMutation() {
  const paused = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-11",
    modelConfigRevision: "mrev-pause"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: paused.workflowId,
    batchId: paused.batchId,
    jobs: observationEntries(db, paused.batchId),
    modelConfigRevision: "mrev-pause",
    now: "2026-08-11T00:00:00.000Z"
  });
  db.prepare("UPDATE workflow_runs SET control_state = 'pause_requested' WHERE id = ?").run(paused.workflowId);
  const pausedClaim = claimWorkflowJobTask(db, {
    workflowRunId: paused.workflowId,
    leaseOwner: "worker-paused",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-11T00:01:00.000Z"
  });
  assert.strictEqual(pausedClaim, null);
  assert.strictEqual(listWorkflowJobTasks(db, { workflowRunId: paused.workflowId })[0].status, "pending");
  assert.strictEqual(
    db.prepare("SELECT progress_revision FROM workflow_runs WHERE id = ?").get(paused.workflowId).progress_revision,
    0
  );

  const scanning = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-11",
    modelConfigRevision: "mrev-scanning"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scanning.workflowId,
    batchId: scanning.batchId,
    jobs: observationEntries(db, scanning.batchId),
    modelConfigRevision: "mrev-scanning",
    now: "2026-08-11T00:00:00.000Z"
  });
  db.prepare("UPDATE workflow_runs SET status = 'scanning' WHERE id = ?").run(scanning.workflowId);
  const scanningClaim = claimWorkflowJobTask(db, {
    workflowRunId: scanning.workflowId,
    leaseOwner: "worker-scanning",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-11T00:01:00.000Z"
  });
  assert.strictEqual(scanningClaim, null);
  assert.strictEqual(listWorkflowJobTasks(db, { workflowRunId: scanning.workflowId })[0].status, "pending");
  assert.strictEqual(
    db.prepare("SELECT progress_revision FROM workflow_runs WHERE id = ?").get(scanning.workflowId).progress_revision,
    0
  );
}

function testExactObservationRebuild() {
  const originalAnalysis = { semanticStatus: "pending", decisionSource: "scan", note: "original" };
  const scenario = seedWorkflow(db, {
    analyses: [originalAnalysis],
    localDay: "2026-08-12",
    modelConfigRevision: "mrev-snapshot",
    titleOverride: "Original Title"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-snapshot",
    now: "2026-08-12T00:00:00.000Z"
  });
  const task = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId })[0];

  const otherBatchId = createBatch(db, "boss", "RAG", "other batch", {
    profileId: scenario.profileId,
    searchPlanId: scenario.planId
  });
  upsertJob(db, {
    source: "boss",
    sourceId: scenario.sourceIds[0],
    title: "Mutated Title",
    analysis: { semanticStatus: "complete", decisionSource: "model", note: "mutated" }
  }, otherBatchId);
  assert.strictEqual(
    db.prepare("SELECT title FROM jobs WHERE id = ?").get(scenario.jobIds[0]).title,
    "Mutated Title"
  );

  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-snapshot",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-12T00:01:00.000Z"
  });
  assert(claimed);
  assert.strictEqual(claimed.job.observationId, task.observationId);
  assert.strictEqual(claimed.job.title, "Original Title");
  assert.deepStrictEqual(claimed.job.analysis, originalAnalysis);
}

function seedWorkflow(database, { analyses, localDay, modelConfigRevision, titleOverride = "" }) {
  const now = new Date().toISOString();
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Workflow Task Candidate', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Workflow Task Plan', '{}', NULL, 1, ?, ?)`).run(profileId, now, now).lastInsertRowid);
  const batchId = createBatch(database, "boss", "RAG", "workflow task smoke", {
    profileId,
    searchPlanId: planId
  });
  const sourceIds = [];
  const jobIds = [];
  analyses.forEach((analysis, index) => {
    const sourceId = `${localDay}-job-${index + 1}`;
    const jobId = upsertJob(database, {
      source: "boss",
      sourceId,
      title: titleOverride || `Job ${index + 1} (${localDay})`,
      analysis
    }, batchId);
    sourceIds.push(sourceId);
    jobIds.push(Number(jobId));
  });
  const workflowId = createWorkflowRun(database, {
    profileId,
    planId,
    localDay,
    sequence: 1,
    targetSuccessCount: 35,
    inventoryCount: 0,
    candidateGap: 35,
    scanNeeded: true,
    keywords: [{ word: "RAG", priority: "A" }],
    budget: { maxDetailTotal: 120, browserPageBudget: 20 },
    planner: { remainingDailyTarget: 70, remainingRunSlots: 2 },
    modelConfigRevision
  }).id;
  const scanRun = createScanRun(database, {
    runId: `scan-${localDay}-${profileId}`,
    planId,
    batchId
  });
  transitionWorkflowRun(database, { id: workflowId, status: "scanning" });
  attachWorkflowScan(database, {
    id: workflowId,
    scanRunId: scanRun.id,
    scanBatchId: batchId
  });
  transitionWorkflowRun(database, { id: workflowId, status: "analyzing" });
  return { workflowId, batchId, profileId, planId, jobIds, sourceIds };
}

function observationEntries(database, batchId) {
  return database.prepare(`
    SELECT id AS observationId, job_id AS jobId
    FROM job_observations
    WHERE batch_id = ?
    ORDER BY id
  `).all(batchId).map((row) => ({
    jobId: Number(row.jobId),
    observationId: Number(row.observationId)
  }));
}

function modelIdentity({ attemptInGeneration, totalAttemptNumber }) {
  return {
    profileKind: "batch_screening",
    modelConfigRevision: `revision-${totalAttemptNumber}`,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    thinkingMode: "disabled",
    reasoningEffort: "high",
    backupUsed: 0
  };
}

function testAtomicSuccessCommit() {
  const scenario = seedWorkflow(db, {
    analyses: [{ semanticStatus: "pending", decisionSource: "scan", note: "before" }],
    localDay: "2026-08-13",
    modelConfigRevision: "mrev-success"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-success",
    now: "2026-08-13T00:00:00.000Z"
  });
  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-success",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-13T00:05:00.000Z"
  });
  assert(claimed);
  const before = db.prepare(
    "SELECT progress_revision FROM workflow_runs WHERE id = ?"
  ).get(scenario.workflowId).progress_revision;
  assert.strictEqual(before, 1);

  const startedAt = "2026-08-13T00:05:00.000Z";
  const finishedAt = "2026-08-13T00:05:42.500Z";
  const analyzedJob = {
    ...claimed.job,
    analysis: {
      semanticStatus: "complete",
      decisionSource: "model",
      recommendation: { tier: "apply", confidence: 0.9 },
      summary: "matched"
    }
  };
  const result = commitWorkflowJobTaskSuccess(db, {
    taskId: claimed.task.id,
    leaseOwner: "worker-success",
    analyzedJob,
    modelIdentity: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      modelConfigRevision: "revision-1",
      thinkingMode: "disabled",
      reasoningEffort: "high",
      backupUsed: 0
    },
    telemetry: {
      modelCallCount: 2,
      promptTokens: 1200,
      completionTokens: 340,
      totalTokens: 1540
    },
    startedAt,
    finishedAt
  });

  const jobAnalysis = JSON.parse(
    db.prepare("SELECT analysis_json FROM jobs WHERE id = ?").get(scenario.jobIds[0]).analysis_json
  );
  assert.strictEqual(jobAnalysis.semanticStatus, "complete");
  assert.strictEqual(jobAnalysis.recommendation.tier, "apply");
  const observationAnalysis = JSON.parse(
    db.prepare("SELECT analysis_json FROM job_observations WHERE id = ?")
      .get(claimed.task.observationId).analysis_json
  );
  assert.strictEqual(observationAnalysis.summary, "matched");

  assert.strictEqual(result.task.status, "succeeded");
  assert.strictEqual(result.task.leaseOwner, null);
  assert.strictEqual(result.task.leaseExpiresAt, null);
  assert.strictEqual(result.task.availableAt, null);
  assert.strictEqual(result.task.lastErrorCode, null);
  assert.strictEqual(result.task.finishedAt, finishedAt);
  assert.strictEqual(result.task.startedAt, startedAt);
  assert.strictEqual(result.task.attemptCountInGeneration, 1);
  assert.strictEqual(result.task.totalAttemptCount, 1);

  const attempts = listJobAnalysisAttempts(db, {
    workflowRunId: scenario.workflowId,
    taskId: claimed.task.id
  });
  assert.strictEqual(attempts.length, 1);
  const attempt = attempts[0];
  assert.strictEqual(attempt.status, "succeeded");
  assert.strictEqual(attempt.modelConfigRevision, "revision-1");
  assert.strictEqual(attempt.provider, "deepseek");
  assert.strictEqual(attempt.model, "deepseek-v4-flash");
  assert.strictEqual(attempt.thinkingMode, "disabled");
  assert.strictEqual(attempt.reasoningEffort, "high");
  assert.strictEqual(attempt.backupUsed, 0);
  assert.strictEqual(attempt.modelCallCount, 2);
  assert.strictEqual(attempt.promptTokens, 1200);
  assert.strictEqual(attempt.completionTokens, 340);
  assert.strictEqual(attempt.totalTokens, 1540);
  assert.strictEqual(attempt.latencyMs, 42500);
  assert.strictEqual(attempt.finishedAt, finishedAt);
  assert.strictEqual(attempt.errorCode, null);

  assert.strictEqual(result.workflow.id, scenario.workflowId);
  assert.strictEqual(result.workflow.progressRevision, before + 1);
  assert.strictEqual(result.workflow.lastActivityAt, finishedAt);
  const persistedWorkflow = db.prepare(
    "SELECT progress_revision, last_activity_at FROM workflow_runs WHERE id = ?"
  ).get(scenario.workflowId);
  assert.strictEqual(persistedWorkflow.progress_revision, before + 1);
  assert.strictEqual(persistedWorkflow.last_activity_at, finishedAt);
}

function testOwnerMismatchAndDuplicateRejected() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-14",
    modelConfigRevision: "mrev-owner"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-owner",
    now: "2026-08-14T00:00:00.000Z"
  });
  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-a",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-14T00:01:00.000Z"
  });
  const startedAt = "2026-08-14T00:01:00.000Z";
  const finishedAt = "2026-08-14T00:01:05.000Z";
  const analyzedJob = {
    ...claimed.job,
    analysis: { semanticStatus: "complete", decisionSource: "model" }
  };
  const base = {
    taskId: claimed.task.id,
    analyzedJob,
    modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
    telemetry: { modelCallCount: 1 },
    startedAt,
    finishedAt
  };

  assert.throws(
    () => commitWorkflowJobTaskSuccess(db, { ...base, leaseOwner: "worker-b" }),
    (error) => error.code === "WORKFLOW_TASK_LEASE_OWNER_MISMATCH"
  );
  const stillRunning = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId })[0];
  assert.strictEqual(stillRunning.status, "running");
  assert.strictEqual(stillRunning.leaseOwner, "worker-a");
  assert.strictEqual(
    db.prepare("SELECT progress_revision FROM workflow_runs WHERE id = ?").get(scenario.workflowId).progress_revision,
    1
  );

  const completed = commitWorkflowJobTaskSuccess(db, { ...base, leaseOwner: "worker-a" });
  assert.strictEqual(completed.task.status, "succeeded");

  assert.throws(
    () => commitWorkflowJobTaskSuccess(db, { ...base, leaseOwner: "worker-a" }),
    (error) => error.code === "WORKFLOW_TASK_NOT_RUNNING"
  );
  assert.throws(
    () => commitWorkflowJobTaskSkipped(db, {
      taskId: claimed.task.id,
      leaseOwner: "worker-a",
      analyzedJob: null,
      reasonCode: "DUPLICATE",
      startedAt,
      finishedAt
    }),
    (error) => error.code === "WORKFLOW_TASK_NOT_RUNNING"
  );
  const attempts = listJobAnalysisAttempts(db, {
    workflowRunId: scenario.workflowId,
    taskId: claimed.task.id
  });
  assert.strictEqual(attempts.length, 1);
  assert.strictEqual(attempts[0].status, "succeeded");
}

function testRollbackOnObservationWriteFailure() {
  const scenario = seedWorkflow(db, {
    analyses: [{ semanticStatus: "pending", decisionSource: "scan", note: "original" }],
    localDay: "2026-08-15",
    modelConfigRevision: "mrev-rollback"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-rollback",
    now: "2026-08-15T00:00:00.000Z"
  });
  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-rollback",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-15T00:01:00.000Z"
  });

  const beforeTask = db.prepare("SELECT * FROM workflow_job_tasks WHERE id = ?").get(claimed.task.id);
  const beforeAttempt = db.prepare(
    "SELECT * FROM job_analysis_attempts WHERE task_id = ?"
  ).get(claimed.task.id);
  const beforeJobAnalysis = db.prepare("SELECT analysis_json FROM jobs WHERE id = ?")
    .get(scenario.jobIds[0]).analysis_json;
  const beforeObservationAnalysis = db.prepare("SELECT analysis_json FROM job_observations WHERE id = ?")
    .get(claimed.task.observationId).analysis_json;
  const beforeWorkflow = db.prepare(
    "SELECT progress_revision, last_activity_at, updated_at FROM workflow_runs WHERE id = ?"
  ).get(scenario.workflowId);

  db.exec(`
    CREATE TEMP TRIGGER fail_observation_write
    BEFORE UPDATE ON job_observations
    WHEN NEW.batch_id = ${scenario.batchId}
    BEGIN
      SELECT RAISE(ABORT, 'injected observation write failure');
    END
  `);
  try {
    assert.throws(
      () => commitWorkflowJobTaskSuccess(db, {
        taskId: claimed.task.id,
        leaseOwner: "worker-rollback",
        analyzedJob: {
          ...claimed.job,
          analysis: { semanticStatus: "complete", decisionSource: "model", summary: "must not persist" }
        },
        modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
        telemetry: { modelCallCount: 1 },
        startedAt: "2026-08-15T00:01:00.000Z",
        finishedAt: "2026-08-15T00:01:05.000Z"
      }),
      /injected observation write failure/
    );
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_observation_write");
  }

  const afterTask = db.prepare("SELECT * FROM workflow_job_tasks WHERE id = ?").get(claimed.task.id);
  assert.strictEqual(afterTask.status, beforeTask.status);
  assert.strictEqual(afterTask.lease_owner, beforeTask.lease_owner);
  assert.strictEqual(afterTask.finished_at, beforeTask.finished_at);
  assert.strictEqual(afterTask.updated_at, beforeTask.updated_at);
  const afterAttempt = db.prepare(
    "SELECT * FROM job_analysis_attempts WHERE task_id = ?"
  ).get(claimed.task.id);
  assert.strictEqual(afterAttempt.status, "running");
  assert.strictEqual(afterAttempt.finished_at, beforeAttempt.finished_at);
  assert.strictEqual(afterAttempt.updated_at, beforeAttempt.updated_at);
  assert.strictEqual(
    db.prepare("SELECT analysis_json FROM jobs WHERE id = ?").get(scenario.jobIds[0]).analysis_json,
    beforeJobAnalysis
  );
  assert.strictEqual(
    db.prepare("SELECT analysis_json FROM job_observations WHERE id = ?")
      .get(claimed.task.observationId).analysis_json,
    beforeObservationAnalysis
  );
  const afterWorkflow = db.prepare(
    "SELECT progress_revision, last_activity_at, updated_at FROM workflow_runs WHERE id = ?"
  ).get(scenario.workflowId);
  assert.deepStrictEqual(afterWorkflow, beforeWorkflow);

  const completed = commitWorkflowJobTaskSuccess(db, {
    taskId: claimed.task.id,
    leaseOwner: "worker-rollback",
    analyzedJob: {
      ...claimed.job,
      analysis: { semanticStatus: "complete", decisionSource: "model", summary: "recovered" }
    },
    modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
    telemetry: { modelCallCount: 1 },
    startedAt: "2026-08-15T00:01:00.000Z",
    finishedAt: "2026-08-15T00:01:05.000Z"
  });
  assert.strictEqual(completed.task.status, "succeeded");
}

function testSkippedCommit() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-16",
    modelConfigRevision: "mrev-skip"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-skip",
    now: "2026-08-16T00:00:00.000Z"
  });
  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-skip",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-16T00:01:00.000Z"
  });
  const startedAt = "2026-08-16T00:01:00.000Z";
  const finishedAt = "2026-08-16T00:01:02.000Z";
  const result = commitWorkflowJobTaskSkipped(db, {
    taskId: claimed.task.id,
    leaseOwner: "worker-skip",
    analyzedJob: {
      ...claimed.job,
      analysis: {
        semanticStatus: "rule_only",
        decisionSource: "local_rules",
        ruleCode: "DETAIL_MISSING"
      }
    },
    reasonCode: "DETAIL_MISSING",
    startedAt,
    finishedAt
  });

  assert.strictEqual(result.task.status, "skipped");
  assert.strictEqual(result.task.lastErrorCode, "DETAIL_MISSING");
  assert.strictEqual(result.task.leaseOwner, null);
  assert.strictEqual(result.task.leaseExpiresAt, null);
  assert.strictEqual(result.task.availableAt, null);
  assert.strictEqual(result.task.finishedAt, finishedAt);

  const jobAnalysis = JSON.parse(
    db.prepare("SELECT analysis_json FROM jobs WHERE id = ?").get(scenario.jobIds[0]).analysis_json
  );
  assert.strictEqual(jobAnalysis.decisionSource, "local_rules");
  assert.strictEqual(jobAnalysis.ruleCode, "DETAIL_MISSING");
  const observationAnalysis = JSON.parse(
    db.prepare("SELECT analysis_json FROM job_observations WHERE id = ?")
      .get(claimed.task.observationId).analysis_json
  );
  assert.strictEqual(observationAnalysis.semanticStatus, "rule_only");

  const attempt = listJobAnalysisAttempts(db, {
    workflowRunId: scenario.workflowId,
    taskId: claimed.task.id
  })[0];
  assert.strictEqual(attempt.status, "succeeded");
  assert.strictEqual(attempt.errorCode, null);
  assert.strictEqual(attempt.modelCallCount, 0);
  assert.strictEqual(attempt.promptTokens, 0);
  assert.strictEqual(attempt.completionTokens, 0);
  assert.strictEqual(attempt.totalTokens, 0);
  assert.strictEqual(attempt.latencyMs, 2000);
  assert.strictEqual(attempt.finishedAt, finishedAt);

  const persistedWorkflow = db.prepare(
    "SELECT progress_revision, last_activity_at FROM workflow_runs WHERE id = ?"
  ).get(scenario.workflowId);
  assert.strictEqual(persistedWorkflow.progress_revision, 2);
  assert.strictEqual(persistedWorkflow.last_activity_at, finishedAt);
  assert.strictEqual(result.workflow.progressRevision, 2);

  const reclaim = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-skip-2",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-16T00:02:00.000Z"
  });
  assert.strictEqual(reclaim, null);

  assert.throws(
    () => commitWorkflowJobTaskSkipped(db, {
      taskId: claimed.task.id,
      leaseOwner: "worker-skip",
      analyzedJob: null,
      reasonCode: "DETAIL_MISSING",
      startedAt,
      finishedAt
    }),
    (error) => error.code === "WORKFLOW_TASK_NOT_RUNNING"
  );
}

function testTelemetryWithAndWithoutUsage() {
  const scenario = seedWorkflow(db, {
    analyses: [{}, {}],
    localDay: "2026-08-17",
    modelConfigRevision: "mrev-telemetry"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-telemetry",
    now: "2026-08-17T00:00:00.000Z"
  });

  const first = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-t1",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-17T00:01:00.000Z"
  });
  commitWorkflowJobTaskSuccess(db, {
    taskId: first.task.id,
    leaseOwner: "worker-t1",
    analyzedJob: { ...first.job, analysis: { semanticStatus: "complete", decisionSource: "model" } },
    modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
    startedAt: "2026-08-17T00:01:00.000Z",
    finishedAt: "2026-08-17T00:01:03.000Z"
  });
  const withoutUsage = listJobAnalysisAttempts(db, {
    workflowRunId: scenario.workflowId,
    taskId: first.task.id
  })[0];
  assert.strictEqual(withoutUsage.status, "succeeded");
  assert.strictEqual(withoutUsage.modelCallCount, 0);
  assert.strictEqual(withoutUsage.promptTokens, 0);
  assert.strictEqual(withoutUsage.completionTokens, 0);
  assert.strictEqual(withoutUsage.totalTokens, 0);
  assert.strictEqual(withoutUsage.latencyMs, 3000);

  const second = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-t2",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-17T00:02:00.000Z"
  });
  commitWorkflowJobTaskSuccess(db, {
    taskId: second.task.id,
    leaseOwner: "worker-t2",
    analyzedJob: { ...second.job, analysis: { semanticStatus: "complete", decisionSource: "model" } },
    modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
    telemetry: { modelCallCount: 3, promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    startedAt: "2026-08-17T00:02:00.000Z",
    finishedAt: "2026-08-17T00:02:06.000Z"
  });
  const withUsage = listJobAnalysisAttempts(db, {
    workflowRunId: scenario.workflowId,
    taskId: second.task.id
  })[0];
  assert.strictEqual(withUsage.modelCallCount, 3);
  assert.strictEqual(withUsage.promptTokens, 100);
  assert.strictEqual(withUsage.completionTokens, 50);
  assert.strictEqual(withUsage.totalTokens, 150);
  assert.strictEqual(withUsage.latencyMs, 6000);
}

function testAnalyzedJobSourceMismatchRejected() {
  const scenario = seedWorkflow(db, {
    analyses: [{ semanticStatus: "pending", decisionSource: "scan", note: "before" }],
    localDay: "2026-08-21",
    modelConfigRevision: "mrev-source"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-source",
    now: "2026-08-21T00:00:00.000Z"
  });
  const startedAt = "2026-08-21T00:01:00.000Z";
  const finishedAt = "2026-08-21T00:01:05.000Z";
  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-source",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: startedAt
  });
  assert(claimed);

  const mismatchedJob = {
    ...claimed.job,
    sourceId: "wrong-source-id",
    analysis: { semanticStatus: "complete", decisionSource: "model", summary: "must not persist" }
  };
  const beforeTask = db.prepare("SELECT * FROM workflow_job_tasks WHERE id = ?").get(claimed.task.id);
  const beforeAttempt = db.prepare(
    "SELECT * FROM job_analysis_attempts WHERE task_id = ?"
  ).get(claimed.task.id);
  const beforeJobAnalysis = db.prepare("SELECT analysis_json FROM jobs WHERE id = ?")
    .get(scenario.jobIds[0]).analysis_json;
  const beforeObservationAnalysis = db.prepare("SELECT analysis_json FROM job_observations WHERE id = ?")
    .get(claimed.task.observationId).analysis_json;
  const beforeWorkflow = db.prepare(
    "SELECT progress_revision, last_activity_at, updated_at FROM workflow_runs WHERE id = ?"
  ).get(scenario.workflowId);

  const successArgs = {
    taskId: claimed.task.id,
    leaseOwner: "worker-source",
    analyzedJob: mismatchedJob,
    modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
    telemetry: { modelCallCount: 1 },
    startedAt,
    finishedAt
  };
  assert.throws(
    () => commitWorkflowJobTaskSuccess(db, successArgs),
    (error) => error.code === "WORKFLOW_TASK_ANALYZED_JOB_MISMATCH"
  );
  assert.strictEqual(
    db.prepare("SELECT id FROM jobs WHERE source = ? AND source_id = ?")
      .get("boss", "wrong-source-id"),
    undefined
  );

  assert.throws(
    () => commitWorkflowJobTaskSkipped(db, {
      taskId: claimed.task.id,
      leaseOwner: "worker-source",
      analyzedJob: mismatchedJob,
      reasonCode: "DETAIL_MISSING",
      startedAt,
      finishedAt
    }),
    (error) => error.code === "WORKFLOW_TASK_ANALYZED_JOB_MISMATCH"
  );
  assert.strictEqual(
    db.prepare("SELECT id FROM jobs WHERE source = ? AND source_id = ?")
      .get("boss", "wrong-source-id"),
    undefined
  );

  const afterTask = db.prepare("SELECT * FROM workflow_job_tasks WHERE id = ?").get(claimed.task.id);
  assert.strictEqual(afterTask.status, beforeTask.status);
  assert.strictEqual(afterTask.lease_owner, beforeTask.lease_owner);
  assert.strictEqual(afterTask.updated_at, beforeTask.updated_at);
  const afterAttempt = db.prepare(
    "SELECT * FROM job_analysis_attempts WHERE task_id = ?"
  ).get(claimed.task.id);
  assert.strictEqual(afterAttempt.status, beforeAttempt.status);
  assert.strictEqual(afterAttempt.updated_at, beforeAttempt.updated_at);
  assert.strictEqual(
    db.prepare("SELECT analysis_json FROM jobs WHERE id = ?").get(scenario.jobIds[0]).analysis_json,
    beforeJobAnalysis
  );
  assert.strictEqual(
    db.prepare("SELECT analysis_json FROM job_observations WHERE id = ?")
      .get(claimed.task.observationId).analysis_json,
    beforeObservationAnalysis
  );
  const afterWorkflow = db.prepare(
    "SELECT progress_revision, last_activity_at, updated_at FROM workflow_runs WHERE id = ?"
  ).get(scenario.workflowId);
  assert.deepStrictEqual(afterWorkflow, beforeWorkflow);

  const completed = commitWorkflowJobTaskSuccess(db, {
    ...successArgs,
    analyzedJob: {
      ...claimed.job,
      analysis: { semanticStatus: "complete", decisionSource: "model", summary: "recovered" }
    }
  });
  assert.strictEqual(completed.task.status, "succeeded");
}

function testModelIdentityMismatchRejected() {
  const scenario = seedWorkflow(db, {
    analyses: [{}, {}],
    localDay: "2026-08-22",
    modelConfigRevision: "mrev-identity"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-identity",
    now: "2026-08-22T00:00:00.000Z"
  });
  const startedAt = "2026-08-22T00:01:00.000Z";
  const finishedAt = "2026-08-22T00:01:03.000Z";
  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-identity",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: startedAt
  });
  assert(claimed);
  const base = {
    taskId: claimed.task.id,
    leaseOwner: "worker-identity",
    analyzedJob: { ...claimed.job, analysis: { semanticStatus: "complete", decisionSource: "model" } },
    telemetry: { modelCallCount: 1 },
    startedAt,
    finishedAt
  };

  const wrongModel = modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 });
  wrongModel.model = "other-model";
  assert.throws(
    () => commitWorkflowJobTaskSuccess(db, { ...base, modelIdentity: wrongModel }),
    (error) => error.code === "WORKFLOW_TASK_MODEL_IDENTITY_MISMATCH"
  );

  const wrongBackup = modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 });
  wrongBackup.backupUsed = 1;
  assert.throws(
    () => commitWorkflowJobTaskSuccess(db, { ...base, modelIdentity: wrongBackup }),
    (error) => error.code === "WORKFLOW_TASK_MODEL_IDENTITY_MISMATCH"
  );

  const afterAttempt = db.prepare(
    "SELECT * FROM job_analysis_attempts WHERE task_id = ?"
  ).get(claimed.task.id);
  assert.strictEqual(afterAttempt.status, "running");
  assert.strictEqual(afterAttempt.model, "deepseek-v4-flash");
  assert.strictEqual(afterAttempt.model_config_revision, "revision-1");
  assert.strictEqual(afterAttempt.thinking_mode, "disabled");
  assert.strictEqual(afterAttempt.reasoning_effort, "high");
  assert.strictEqual(afterAttempt.backup_used, 0);
  assert.strictEqual(afterAttempt.finished_at, null);
  assert.strictEqual(
    db.prepare("SELECT progress_revision FROM workflow_runs WHERE id = ?").get(scenario.workflowId).progress_revision,
    1
  );

  const partialIdentity = { provider: "deepseek" };
  const completed = commitWorkflowJobTaskSuccess(db, {
    ...base,
    modelIdentity: partialIdentity
  });
  assert.strictEqual(completed.task.status, "succeeded");
  const persistedAttempt = listJobAnalysisAttempts(db, {
    workflowRunId: scenario.workflowId,
    taskId: claimed.task.id
  })[0];
  assert.strictEqual(persistedAttempt.provider, "deepseek");
  assert.strictEqual(persistedAttempt.model, "deepseek-v4-flash");
  assert.strictEqual(persistedAttempt.modelConfigRevision, "revision-1");
  assert.strictEqual(persistedAttempt.thinkingMode, "disabled");
  assert.strictEqual(persistedAttempt.reasoningEffort, "high");
  assert.strictEqual(persistedAttempt.backupUsed, 0);
}

function testStartedAtMismatchRejected() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-23",
    modelConfigRevision: "mrev-started"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-started",
    now: "2026-08-23T00:00:00.000Z"
  });
  const startedAt = "2026-08-23T00:01:00.000Z";
  const finishedAt = "2026-08-23T00:01:03.000Z";
  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-started",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: startedAt
  });
  assert(claimed);
  assert.strictEqual(claimed.attempt.startedAt, startedAt);

  const args = {
    taskId: claimed.task.id,
    leaseOwner: "worker-started",
    analyzedJob: { ...claimed.job, analysis: { semanticStatus: "complete", decisionSource: "model" } },
    modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
    telemetry: { modelCallCount: 1 },
    startedAt: "2026-08-23T00:02:00.000Z",
    finishedAt
  };
  assert.throws(
    () => commitWorkflowJobTaskSuccess(db, args),
    (error) => error.code === "WORKFLOW_TASK_STARTED_AT_MISMATCH"
  );
  const afterAttempt = db.prepare(
    "SELECT * FROM job_analysis_attempts WHERE task_id = ?"
  ).get(claimed.task.id);
  assert.strictEqual(afterAttempt.status, "running");
  assert.strictEqual(afterAttempt.started_at, startedAt);
  assert.strictEqual(afterAttempt.latency_ms, null);
  assert.strictEqual(
    db.prepare("SELECT progress_revision FROM workflow_runs WHERE id = ?").get(scenario.workflowId).progress_revision,
    1
  );

  const completed = commitWorkflowJobTaskSuccess(db, { ...args, startedAt });
  assert.strictEqual(completed.task.status, "succeeded");
  const attempt = listJobAnalysisAttempts(db, {
    workflowRunId: scenario.workflowId,
    taskId: claimed.task.id
  })[0];
  assert.strictEqual(attempt.startedAt, startedAt);
  assert.strictEqual(attempt.finishedAt, finishedAt);
  assert.strictEqual(attempt.latencyMs, 3000);
}

function testNarrowInsertConflictBehavior() {
  const scenario = seedWorkflow(db, {
    analyses: [{}, {}],
    localDay: "2026-08-18",
    modelConfigRevision: "mrev-conflict"
  });
  const observations = db.prepare(`
    SELECT id, job_id FROM job_observations
    WHERE batch_id = ?
    ORDER BY id
  `).all(scenario.batchId);
  assert.strictEqual(observations.length, 2);
  const now = "2026-08-18T00:00:00.000Z";
  const base = {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobId: Number(observations[0].job_id),
    observationId: Number(observations[0].id),
    position: 1,
    status: "pending",
    recoveryGeneration: 0,
    modelConfigRevision: "mrev-conflict",
    now
  };
  assert.strictEqual(Number(insertWorkflowJobTaskRow(db, base).changes), 1);
  assert.strictEqual(Number(insertWorkflowJobTaskRow(db, base).changes), 0);

  assert.throws(
    () => insertWorkflowJobTaskRow(db, {
      ...base,
      jobId: Number(observations[1].job_id),
      observationId: Number(observations[1].id),
      position: -5
    }),
    /CHECK/i
  );
  const count = db.prepare(
    "SELECT count(*) AS n FROM workflow_job_tasks WHERE workflow_run_id = ?"
  ).get(scenario.workflowId).n;
  assert.strictEqual(count, 1);
}

function testClaimNormalizesNowToUtc() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-19",
    modelConfigRevision: "mrev-utc"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-utc",
    now: "2026-08-19T00:00:00.000Z"
  });
  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-utc",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: new Date("2026-08-19T00:05:00.000Z")
  });
  assert(claimed);
  assert.strictEqual(claimed.task.startedAt, "2026-08-19T00:05:00.000Z");
  assert.strictEqual(claimed.task.leasedAt, "2026-08-19T00:05:00.000Z");
  assert.strictEqual(claimed.task.leaseExpiresAt, "2026-08-19T00:06:00.000Z");
  assert.strictEqual(claimed.attempt.startedAt, "2026-08-19T00:05:00.000Z");
  assert.strictEqual(
    db.prepare("SELECT last_activity_at FROM workflow_runs WHERE id = ?")
      .get(scenario.workflowId).last_activity_at,
    "2026-08-19T00:05:00.000Z"
  );
}

function testListJobAnalysisAttemptsRejectsInvalidTaskId() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-20",
    modelConfigRevision: "mrev-list"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-list",
    now: "2026-08-20T00:00:00.000Z"
  });
  for (const taskId of [0, -1, "abc", null, undefined, 1.5]) {
    assert.throws(
      () => listJobAnalysisAttempts(db, { workflowRunId: scenario.workflowId, taskId }),
      (error) => error.code === "WORKFLOW_TASK_INVALID_TASK_ID"
    );
  }
}

function testFirstRetryableFailurePersistsCooldown() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-24",
    modelConfigRevision: "mrev-fail-1"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-fail-1",
    now: "2026-08-24T00:00:00.000Z"
  });
  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-fail-1",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-24T00:05:00.000Z"
  });
  assert(claimed);
  const startedAt = "2026-08-24T00:05:00.000Z";
  const finishedAt = "2026-08-24T00:05:30.000Z";
  const retryAt = "2026-08-24T00:10:00.000Z";
  const result = commitWorkflowJobTaskFailure(db, {
    taskId: claimed.task.id,
    leaseOwner: "worker-fail-1",
    errorCode: "MODEL_TIMEOUT",
    retryable: true,
    retryAt,
    errorStage: "analyze",
    modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
    telemetry: { modelCallCount: 1, promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    startedAt,
    finishedAt
  });
  assert.strictEqual(result.outcome, "retry_pending");
  assert.strictEqual(result.task.status, "retry_pending");
  assert.strictEqual(result.task.attemptCountInGeneration, 1);
  assert.strictEqual(result.task.totalAttemptCount, 1);
  assert.strictEqual(result.task.availableAt, retryAt);
  assert.strictEqual(result.task.priority, 20);
  assert.strictEqual(result.task.finishedAt, null);
  assert.strictEqual(result.task.startedAt, startedAt);
  assert.strictEqual(result.task.leaseOwner, null);
  assert.strictEqual(result.task.leaseExpiresAt, null);
  assert.strictEqual(result.task.lastErrorCode, "MODEL_TIMEOUT");
  assert.strictEqual(result.task.lastErrorStage, "analyze");
  assert.strictEqual(result.task.lastErrorKind, "retryable");

  const attempt = listJobAnalysisAttempts(db, {
    workflowRunId: scenario.workflowId,
    taskId: claimed.task.id
  })[0];
  assert.strictEqual(attempt.status, "failed");
  assert.strictEqual(attempt.errorCode, "MODEL_TIMEOUT");
  assert.strictEqual(attempt.errorStage, "analyze");
  assert.strictEqual(attempt.retryable, 1);
  assert.strictEqual(attempt.modelConfigRevision, "revision-1");
  assert.strictEqual(attempt.provider, "deepseek");
  assert.strictEqual(attempt.model, "deepseek-v4-flash");
  assert.strictEqual(attempt.thinkingMode, "disabled");
  assert.strictEqual(attempt.reasoningEffort, "high");
  assert.strictEqual(attempt.backupUsed, 0);
  assert.strictEqual(attempt.modelCallCount, 1);
  assert.strictEqual(attempt.promptTokens, 100);
  assert.strictEqual(attempt.completionTokens, 20);
  assert.strictEqual(attempt.totalTokens, 120);
  assert.strictEqual(attempt.latencyMs, 30000);
  assert.strictEqual(attempt.finishedAt, finishedAt);

  assert.strictEqual(result.workflow.progressRevision, 2);
  assert.strictEqual(result.workflow.lastActivityAt, finishedAt);
  const counters = workflowTimeoutCounts(scenario.workflowId);
  assert.strictEqual(counters.circuit_timeout_job_count, 0);
  assert.strictEqual(counters.lifetime_timeout_job_count, 0);

  const early = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-fail-early",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-24T00:09:00.000Z"
  });
  assert.strictEqual(early, null);
  const stillCooldown = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId })[0];
  assert.strictEqual(stillCooldown.status, "retry_pending");
  assert.strictEqual(stillCooldown.attemptCountInGeneration, 1);
  assert.strictEqual(stillCooldown.availableAt, retryAt);

  const due = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-fail-due",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-24T00:10:00.000Z"
  });
  assert(due);
  assert.strictEqual(due.task.id, claimed.task.id);
  assert.strictEqual(due.task.attemptCountInGeneration, 2);
  assert.strictEqual(due.task.totalAttemptCount, 2);
  assert.strictEqual(due.attempt.attemptInGeneration, 2);
  assert.strictEqual(due.attempt.modelConfigRevision, "revision-2");
}

function testSecondOrdinaryFailureTerminalWithoutCounters() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-25",
    modelConfigRevision: "mrev-fail-2"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-fail-2",
    now: "2026-08-25T00:00:00.000Z"
  });
  const claimNow = "2026-08-25T00:01:00.000Z";
  const first = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-2a",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: claimNow
  });
  const firstFail = commitWorkflowJobTaskFailure(db, {
    taskId: first.task.id,
    leaseOwner: "worker-2a",
    errorCode: "HTTP_429",
    retryable: true,
    retryAt: "2026-08-25T00:01:01.000Z",
    errorStage: "analyze",
    modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
    startedAt: claimNow,
    finishedAt: "2026-08-25T00:01:00.500Z"
  });
  assert.strictEqual(firstFail.outcome, "retry_pending");

  const second = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-2b",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-25T00:01:01.000Z"
  });
  assert(second);
  assert.strictEqual(second.task.attemptCountInGeneration, 2);
  const secondFail = commitWorkflowJobTaskFailure(db, {
    taskId: second.task.id,
    leaseOwner: "worker-2b",
    errorCode: "HTTP_429",
    retryable: true,
    retryAt: "2026-08-25T00:01:02.000Z",
    errorStage: "analyze",
    modelIdentity: modelIdentity({ attemptInGeneration: 2, totalAttemptNumber: 2 }),
    startedAt: "2026-08-25T00:01:01.000Z",
    finishedAt: "2026-08-25T00:01:01.700Z"
  });
  assert.strictEqual(secondFail.outcome, "failed");
  assert.strictEqual(secondFail.task.status, "failed");
  assert.strictEqual(secondFail.task.finishedAt, "2026-08-25T00:01:01.700Z");
  assert.strictEqual(secondFail.task.attemptCountInGeneration, 2);
  assert.strictEqual(secondFail.task.totalAttemptCount, 2);
  assert.strictEqual(secondFail.task.availableAt, null);
  assert.strictEqual(secondFail.task.leaseOwner, null);
  assert.strictEqual(secondFail.task.lastErrorCode, "HTTP_429");
  assert.strictEqual(secondFail.task.lastErrorKind, "retryable");
  const counters = workflowTimeoutCounts(scenario.workflowId);
  assert.strictEqual(counters.circuit_timeout_job_count, 0);
  assert.strictEqual(counters.lifetime_timeout_job_count, 0);

  const attempts = listJobAnalysisAttempts(db, {
    workflowRunId: scenario.workflowId,
    taskId: second.task.id
  });
  assert.strictEqual(attempts.length, 2);
  assert.strictEqual(attempts[1].status, "failed");
  assert.strictEqual(attempts[1].retryable, 1);
  assert.strictEqual(attempts[1].errorCode, "HTTP_429");
  assert.strictEqual(attempts[1].errorStage, "analyze");

  assert.strictEqual(claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-2c",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-25T00:02:00.000Z"
  }), null);
}

function testSecondTimeoutCountsOnceAndCannotDoubleCount() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-26",
    modelConfigRevision: "mrev-timeout"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-timeout",
    now: "2026-08-26T00:00:00.000Z"
  });
  const claimNow = "2026-08-26T00:01:00.000Z";
  const retryAt = "2026-08-26T00:02:00.000Z";
  const first = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-t-a",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: claimNow
  });
  const failureArgs = {
    taskId: first.task.id,
    leaseOwner: "worker-t-a",
    errorCode: "MODEL_TIMEOUT",
    retryable: true,
    retryAt,
    errorStage: "analyze",
    modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
    startedAt: claimNow,
    finishedAt: "2026-08-26T00:01:30.000Z"
  };
  const firstFail = commitWorkflowJobTaskFailure(db, failureArgs);
  assert.strictEqual(firstFail.outcome, "retry_pending");
  let counters = workflowTimeoutCounts(scenario.workflowId);
  assert.strictEqual(counters.circuit_timeout_job_count, 0);
  assert.strictEqual(counters.lifetime_timeout_job_count, 0);

  const second = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-t-b",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: retryAt
  });
  assert(second);
  assert.strictEqual(second.task.attemptCountInGeneration, 2);
  const finalArgs = {
    ...failureArgs,
    taskId: second.task.id,
    leaseOwner: "worker-t-b",
    modelIdentity: modelIdentity({ attemptInGeneration: 2, totalAttemptNumber: 2 }),
    startedAt: retryAt,
    finishedAt: "2026-08-26T00:02:30.000Z"
  };
  const finalFail = commitWorkflowJobTaskFailure(db, finalArgs);
  assert.strictEqual(finalFail.outcome, "failed");
  assert.strictEqual(finalFail.task.status, "failed");
  assert.strictEqual(finalFail.task.finishedAt, "2026-08-26T00:02:30.000Z");
  assert.strictEqual(finalFail.task.lastErrorCode, "MODEL_TIMEOUT");
  counters = workflowTimeoutCounts(scenario.workflowId);
  assert.strictEqual(counters.circuit_timeout_job_count, 1);
  assert.strictEqual(counters.lifetime_timeout_job_count, 1);
  assert.strictEqual(finalFail.workflow.circuitTimeoutJobCount, 1);
  assert.strictEqual(finalFail.workflow.lifetimeTimeoutJobCount, 1);

  assert.throws(
    () => commitWorkflowJobTaskFailure(db, finalArgs),
    (error) => error.code === "WORKFLOW_TASK_NOT_RUNNING"
  );
  counters = workflowTimeoutCounts(scenario.workflowId);
  assert.strictEqual(counters.circuit_timeout_job_count, 1);
  assert.strictEqual(counters.lifetime_timeout_job_count, 1);

  const recovered = recoverExpiredWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    now: "2026-08-26T00:05:00.000Z"
  });
  assert.deepStrictEqual(recovered, { recovered: 0, failed: 0 });
  counters = workflowTimeoutCounts(scenario.workflowId);
  assert.strictEqual(counters.circuit_timeout_job_count, 1);
  assert.strictEqual(counters.lifetime_timeout_job_count, 1);

  assert.strictEqual(claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-t-c",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-26T00:05:00.000Z"
  }), null);
}

function testConfigErrorsPauseImmediatelyWithoutSecondAttempt() {
  const pauseCodes = [
    "MODEL_KEY_REQUIRED",
    "MODEL_AUTH_FAILED",
    "MODEL_ENDPOINT_OR_MODEL_NOT_FOUND",
    "MODEL_CONFIGURATION_REQUIRED"
  ];
  pauseCodes.forEach((code, index) => {
    const scenario = seedWorkflow(db, {
      analyses: [{}],
      localDay: "2026-08-26",
      modelConfigRevision: `mrev-pause-${index}`
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: `mrev-pause-${index}`,
      now: "2026-08-26T00:00:00.000Z"
    });
    const claimNow = "2026-08-26T00:01:00.000Z";
    const claimed = claimWorkflowJobTask(db, {
      workflowRunId: scenario.workflowId,
      leaseOwner: `worker-pause-${index}`,
      leaseTtlMs: 60_000,
      selectModelIdentity: modelIdentity,
      now: claimNow
    });
    assert(claimed);
    // Even when the executor marks a config error retryable, it must not trigger
    // an automatic second attempt in this generation; the supplied retryAt is ignored.
    const result = commitWorkflowJobTaskFailure(db, {
      taskId: claimed.task.id,
      leaseOwner: `worker-pause-${index}`,
      errorCode: code,
      retryable: index === 0,
      retryAt: "2026-08-26T00:02:00.000Z",
      errorStage: "analyze",
      modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
      startedAt: claimNow,
      finishedAt: "2026-08-26T00:01:10.000Z"
    });
    assert.strictEqual(result.outcome, "pause_requested");
    assert.strictEqual(result.task.status, "retry_pending");
    assert.strictEqual(result.task.attemptCountInGeneration, 1);
    assert.strictEqual(result.task.totalAttemptCount, 1);
    assert.strictEqual(result.task.availableAt, null);
    assert.strictEqual(result.task.priority, 100);
    assert.strictEqual(result.task.finishedAt, null);
    assert.strictEqual(result.task.leaseOwner, null);
    assert.strictEqual(result.task.lastErrorCode, code);
    assert.strictEqual(result.task.lastErrorStage, "analyze");
    assert.strictEqual(result.task.lastErrorKind, "configuration");

    const attempt = listJobAnalysisAttempts(db, {
      workflowRunId: scenario.workflowId,
      taskId: claimed.task.id
    })[0];
    assert.strictEqual(attempt.status, "failed");
    assert.strictEqual(attempt.errorCode, code);
    assert.strictEqual(attempt.errorStage, "analyze");
    assert.strictEqual(attempt.retryable, 0);

    assert.strictEqual(result.workflow.controlState, "pause_requested");
    assert.strictEqual(result.workflow.resumePhase, "analyzing");
    assert.strictEqual(result.workflow.progressRevision, 2);
    assert.strictEqual(result.workflow.lastActivityAt, "2026-08-26T00:01:10.000Z");
    const counters = workflowTimeoutCounts(scenario.workflowId);
    assert.strictEqual(counters.circuit_timeout_job_count, 0);
    assert.strictEqual(counters.lifetime_timeout_job_count, 0);

    assert.strictEqual(claimWorkflowJobTask(db, {
      workflowRunId: scenario.workflowId,
      leaseOwner: `worker-pause-again-${index}`,
      leaseTtlMs: 60_000,
      selectModelIdentity: modelIdentity,
      now: "2026-08-26T00:05:00.000Z"
    }), null);
    assert.throws(
      () => commitWorkflowJobTaskFailure(db, {
        taskId: claimed.task.id,
        leaseOwner: `worker-pause-${index}`,
        errorCode: code,
        retryable: false,
        errorStage: "analyze",
        startedAt: claimNow,
        finishedAt: "2026-08-26T00:01:11.000Z"
      }),
      (error) => error.code === "WORKFLOW_TASK_NOT_RUNNING"
    );
  });
  const attemptColumns = db.prepare("PRAGMA table_info(job_analysis_attempts)").all()
    .map((column) => column.name);
  assert(!attemptColumns.includes("error_message"));
}

function testNonRetryableFirstFailureIsTerminal() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-26",
    modelConfigRevision: "mrev-terminal"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-terminal",
    now: "2026-08-26T00:00:00.000Z"
  });
  const claimNow = "2026-08-26T00:01:00.000Z";
  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-terminal",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: claimNow
  });
  const result = commitWorkflowJobTaskFailure(db, {
    taskId: claimed.task.id,
    leaseOwner: "worker-terminal",
    errorCode: "LOCAL_INPUT_INVALID",
    retryable: false,
    errorStage: "analyze",
    modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
    startedAt: claimNow,
    finishedAt: "2026-08-26T00:01:02.000Z"
  });
  assert.strictEqual(result.outcome, "failed");
  assert.strictEqual(result.task.status, "failed");
  assert.strictEqual(result.task.finishedAt, "2026-08-26T00:01:02.000Z");
  assert.strictEqual(result.task.availableAt, null);
  assert.strictEqual(result.task.lastErrorCode, "LOCAL_INPUT_INVALID");
  assert.strictEqual(result.task.lastErrorKind, "terminal");
  const counters = workflowTimeoutCounts(scenario.workflowId);
  assert.strictEqual(counters.circuit_timeout_job_count, 0);
  assert.strictEqual(counters.lifetime_timeout_job_count, 0);
  assert.strictEqual(claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-terminal-2",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-26T00:02:00.000Z"
  }), null);
}

function testExpiredLeaseRecoveryFirstAndSecondAttempts() {
  const scenario = seedWorkflow(db, {
    analyses: [{}, {}],
    localDay: "2026-08-27",
    modelConfigRevision: "mrev-recover"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-recover",
    now: "2026-08-27T00:00:00.000Z"
  });
  const claimNow = "2026-08-27T00:00:00.000Z";
  const first = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-r-a",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: claimNow
  });
  const second = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-r-b",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: claimNow
  });
  assert(first);
  assert(second);
  assert.notStrictEqual(first.task.id, second.task.id);

  // Drive the second task to a second running attempt with an expired lease.
  const retryAt = "2026-08-27T00:00:10.000Z";
  commitWorkflowJobTaskFailure(db, {
    taskId: second.task.id,
    leaseOwner: "worker-r-b",
    errorCode: "MODEL_TIMEOUT",
    retryable: true,
    retryAt,
    errorStage: "analyze",
    modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
    startedAt: claimNow,
    finishedAt: "2026-08-27T00:00:05.000Z"
  });
  const secondAttempt = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-r-c",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: retryAt
  });
  assert(secondAttempt);
  assert.strictEqual(secondAttempt.task.attemptCountInGeneration, 2);

  const now = "2026-08-27T00:02:00.000Z";
  const result = recoverExpiredWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    now
  });
  assert.deepStrictEqual(result, { recovered: 1, failed: 1 });

  const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
  const byId = Object.fromEntries(tasks.map((task) => [task.id, task]));
  const recoveredTask = byId[first.task.id];
  assert.strictEqual(recoveredTask.status, "retry_pending");
  assert.strictEqual(recoveredTask.attemptCountInGeneration, 1);
  assert.strictEqual(recoveredTask.totalAttemptCount, 1);
  assert.strictEqual(recoveredTask.priority, 20);
  assert.strictEqual(recoveredTask.availableAt, null);
  assert.strictEqual(recoveredTask.finishedAt, null);
  assert.strictEqual(recoveredTask.leaseOwner, null);
  assert.strictEqual(recoveredTask.leaseExpiresAt, null);
  assert.strictEqual(recoveredTask.lastErrorCode, "LEASE_EXPIRED");
  assert.strictEqual(recoveredTask.lastErrorStage, "execution");
  assert.strictEqual(recoveredTask.lastErrorKind, "lease_expired");

  const failedTask = byId[second.task.id];
  assert.strictEqual(failedTask.status, "failed");
  assert.strictEqual(failedTask.attemptCountInGeneration, 2);
  assert.strictEqual(failedTask.totalAttemptCount, 2);
  assert.strictEqual(failedTask.finishedAt, now);
  assert.strictEqual(failedTask.leaseOwner, null);
  assert.strictEqual(failedTask.lastErrorCode, "LEASE_EXPIRED");
  assert.strictEqual(failedTask.lastErrorKind, "lease_expired");

  const recoveredAttempt = listJobAnalysisAttempts(db, {
    workflowRunId: scenario.workflowId,
    taskId: first.task.id
  })[0];
  assert.strictEqual(recoveredAttempt.status, "failed");
  assert.strictEqual(recoveredAttempt.errorCode, "LEASE_EXPIRED");
  assert.strictEqual(recoveredAttempt.errorStage, "execution");
  assert.strictEqual(recoveredAttempt.retryable, 1);
  assert.strictEqual(recoveredAttempt.finishedAt, now);
  assert.strictEqual(recoveredAttempt.latencyMs, 120000);

  const counters = workflowTimeoutCounts(scenario.workflowId);
  assert.strictEqual(counters.circuit_timeout_job_count, 0);
  assert.strictEqual(counters.lifetime_timeout_job_count, 0);

  const again = recoverExpiredWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    now
  });
  assert.deepStrictEqual(again, { recovered: 0, failed: 0 });

  const reclaim = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-r-d",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now
  });
  assert(reclaim);
  assert.strictEqual(reclaim.task.id, first.task.id);
  assert.strictEqual(reclaim.task.attemptCountInGeneration, 2);
  assert.strictEqual(reclaim.task.totalAttemptCount, 2);
}

function testRecoverySkipsTerminalAndRespectsGates() {
  const scenario = seedWorkflow(db, {
    analyses: [{}, {}, {}],
    localDay: "2026-08-28",
    modelConfigRevision: "mrev-recover-gate"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-recover-gate",
    now: "2026-08-28T00:00:00.000Z"
  });
  const claimNow = "2026-08-28T00:00:00.000Z";
  const succeeded = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-rg-1",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: claimNow
  });
  commitWorkflowJobTaskSuccess(db, {
    taskId: succeeded.task.id,
    leaseOwner: "worker-rg-1",
    analyzedJob: { ...succeeded.job, analysis: { semanticStatus: "complete", decisionSource: "model" } },
    modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
    startedAt: claimNow,
    finishedAt: "2026-08-28T00:00:03.000Z"
  });
  const failed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-rg-2",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: claimNow
  });
  commitWorkflowJobTaskFailure(db, {
    taskId: failed.task.id,
    leaseOwner: "worker-rg-2",
    errorCode: "HTTP_429",
    retryable: false,
    errorStage: "analyze",
    modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
    startedAt: claimNow,
    finishedAt: "2026-08-28T00:00:04.000Z"
  });
  const running = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-rg-3",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: claimNow
  });
  assert(running);

  const now = "2026-08-28T00:05:00.000Z";
  const result = recoverExpiredWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    now
  });
  assert.deepStrictEqual(result, { recovered: 1, failed: 0 });
  const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
  const byId = Object.fromEntries(tasks.map((task) => [task.id, task]));
  assert.strictEqual(byId[succeeded.task.id].status, "succeeded");
  assert.strictEqual(byId[failed.task.id].status, "failed");
  assert.strictEqual(byId[running.task.id].status, "retry_pending");

  const paused = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-28",
    modelConfigRevision: "mrev-recover-paused"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: paused.workflowId,
    batchId: paused.batchId,
    jobs: observationEntries(db, paused.batchId),
    modelConfigRevision: "mrev-recover-paused",
    now: "2026-08-28T01:00:00.000Z"
  });
  claimWorkflowJobTask(db, {
    workflowRunId: paused.workflowId,
    leaseOwner: "worker-rp",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-28T01:00:00.000Z"
  });
  db.prepare("UPDATE workflow_runs SET control_state = 'pause_requested' WHERE id = ?").run(paused.workflowId);
  const pausedRecovery = recoverExpiredWorkflowJobTasks(db, {
    workflowRunId: paused.workflowId,
    now: "2026-08-28T01:05:00.000Z"
  });
  assert.deepStrictEqual(pausedRecovery, { recovered: 0, failed: 0 });
  const pausedTask = listWorkflowJobTasks(db, { workflowRunId: paused.workflowId })[0];
  assert.strictEqual(pausedTask.status, "running");
  assert.strictEqual(pausedTask.leaseOwner, "worker-rp");

  const scanning = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-28",
    modelConfigRevision: "mrev-recover-scanning"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scanning.workflowId,
    batchId: scanning.batchId,
    jobs: observationEntries(db, scanning.batchId),
    modelConfigRevision: "mrev-recover-scanning",
    now: "2026-08-28T02:00:00.000Z"
  });
  claimWorkflowJobTask(db, {
    workflowRunId: scanning.workflowId,
    leaseOwner: "worker-rs",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-28T02:00:00.000Z"
  });
  db.prepare("UPDATE workflow_runs SET status = 'scanning' WHERE id = ?").run(scanning.workflowId);
  const scanningRecovery = recoverExpiredWorkflowJobTasks(db, {
    workflowRunId: scanning.workflowId,
    now: "2026-08-28T02:05:00.000Z"
  });
  assert.deepStrictEqual(scanningRecovery, { recovered: 0, failed: 0 });
  assert.strictEqual(listWorkflowJobTasks(db, { workflowRunId: scanning.workflowId })[0].status, "running");
}

function testFailureOwnerMismatchAndRollback() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-29",
    modelConfigRevision: "mrev-fail-owner"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-fail-owner",
    now: "2026-08-29T00:00:00.000Z"
  });
  const claimNow = "2026-08-29T00:01:00.000Z";
  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-fail-a",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: claimNow
  });
  const base = {
    taskId: claimed.task.id,
    errorCode: "MODEL_TIMEOUT",
    retryable: true,
    retryAt: "2026-08-29T00:06:00.000Z",
    errorStage: "analyze",
    modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
    startedAt: claimNow,
    finishedAt: "2026-08-29T00:01:30.000Z"
  };
  assert.throws(
    () => commitWorkflowJobTaskFailure(db, { ...base, leaseOwner: "worker-other" }),
    (error) => error.code === "WORKFLOW_TASK_LEASE_OWNER_MISMATCH"
  );
  const afterMismatch = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId })[0];
  assert.strictEqual(afterMismatch.status, "running");
  assert.strictEqual(afterMismatch.leaseOwner, "worker-fail-a");
  assert.strictEqual(
    db.prepare("SELECT progress_revision FROM workflow_runs WHERE id = ?").get(scenario.workflowId).progress_revision,
    1
  );

  db.exec(`
    CREATE TEMP TRIGGER fail_workflow_activity
    BEFORE UPDATE ON workflow_runs
    WHEN NEW.id = '${scenario.workflowId}'
    BEGIN
      SELECT RAISE(ABORT, 'injected workflow activity failure');
    END
  `);
  try {
    assert.throws(
      () => commitWorkflowJobTaskFailure(db, { ...base, leaseOwner: "worker-fail-a" }),
      /injected workflow activity failure/
    );
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_workflow_activity");
  }
  const afterRollback = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId })[0];
  assert.strictEqual(afterRollback.status, "running");
  assert.strictEqual(afterRollback.leaseOwner, "worker-fail-a");
  assert.strictEqual(afterRollback.leaseExpiresAt, "2026-08-29T00:02:00.000Z");
  const attempt = db.prepare("SELECT * FROM job_analysis_attempts WHERE task_id = ?").get(claimed.task.id);
  assert.strictEqual(attempt.status, "running");
  assert.strictEqual(attempt.finished_at, null);
  assert.strictEqual(attempt.updated_at, attempt.created_at);
  const workflow = db.prepare(
    "SELECT progress_revision, last_activity_at, control_state, resume_phase FROM workflow_runs WHERE id = ?"
  ).get(scenario.workflowId);
  assert.strictEqual(workflow.progress_revision, 1);
  assert.strictEqual(workflow.control_state, "none");
  assert.strictEqual(workflow.resume_phase, null);

  const ok = commitWorkflowJobTaskFailure(db, { ...base, leaseOwner: "worker-fail-a" });
  assert.strictEqual(ok.outcome, "retry_pending");
  assert.strictEqual(ok.task.status, "retry_pending");
  assert.strictEqual(ok.task.availableAt, "2026-08-29T00:06:00.000Z");
}

function testFailureIdentityCannotOverrideClaim() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-30",
    modelConfigRevision: "mrev-fail-id"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-fail-id",
    now: "2026-08-30T00:00:00.000Z"
  });
  const claimNow = "2026-08-30T00:01:00.000Z";
  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-fail-id",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: claimNow
  });
  const base = {
    taskId: claimed.task.id,
    leaseOwner: "worker-fail-id",
    errorCode: "MODEL_TIMEOUT",
    retryable: true,
    retryAt: "2026-08-30T00:06:00.000Z",
    errorStage: "analyze",
    startedAt: claimNow,
    finishedAt: "2026-08-30T00:01:30.000Z"
  };
  const wrong = modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 });
  wrong.model = "some-other-model";
  assert.throws(
    () => commitWorkflowJobTaskFailure(db, { ...base, modelIdentity: wrong }),
    (error) => error.code === "WORKFLOW_TASK_MODEL_IDENTITY_MISMATCH"
  );
  const attempt = db.prepare("SELECT * FROM job_analysis_attempts WHERE task_id = ?").get(claimed.task.id);
  assert.strictEqual(attempt.status, "running");
  assert.strictEqual(attempt.model, "deepseek-v4-flash");
  assert.strictEqual(attempt.model_config_revision, "revision-1");
  assert.strictEqual(attempt.updated_at, attempt.created_at);

  const result = commitWorkflowJobTaskFailure(db, {
    ...base,
    modelIdentity: { provider: "deepseek" }
  });
  assert.strictEqual(result.outcome, "retry_pending");
  const persisted = listJobAnalysisAttempts(db, {
    workflowRunId: scenario.workflowId,
    taskId: claimed.task.id
  })[0];
  assert.strictEqual(persisted.status, "failed");
  assert.strictEqual(persisted.provider, "deepseek");
  assert.strictEqual(persisted.model, "deepseek-v4-flash");
  assert.strictEqual(persisted.modelConfigRevision, "revision-1");
  assert.strictEqual(persisted.thinkingMode, "disabled");
  assert.strictEqual(persisted.reasoningEffort, "high");
  assert.strictEqual(persisted.backupUsed, 0);
}

function workflowTimeoutCounts(workflowId) {
  return db.prepare(
    "SELECT circuit_timeout_job_count, lifetime_timeout_job_count FROM workflow_runs WHERE id = ?"
  ).get(workflowId);
}
