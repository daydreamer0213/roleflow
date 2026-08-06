const assert = require("node:assert/strict");
const {
  openDb,
  createBatch,
  createScanRun,
  createWorkflowRun,
  attachWorkflowScan,
  transitionWorkflowRun,
  upsertJob
} = require("../src/core/storage");
const {
  initializeWorkflowJobTasks,
  claimWorkflowJobTask,
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
