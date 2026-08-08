const assert = require("node:assert/strict");
const {
  openDb,
  createBatch,
  createScanRun,
  finishScanRun,
  createWorkflowRun,
  getWorkflowRun,
  listWorkflowRuns,
  transitionWorkflowRun,
  attachWorkflowScan,
  attachWorkflowCommunication,
  upsertJob
} = require("../src/core/storage");
const { getCommunicationBatch } = require("../src/core/communication_batches");
const { recoverWorkflowRuns } = require("../src/core/workflow_run");
const {
  requestWorkflowPause,
  requestWorkflowStop,
  resumeWorkflowRun,
  finalizeWorkflowControl
} = require("../src/core/workflow_control");
const { createDashboardServer } = require("../src/dashboard/server");
const {
  initializeWorkflowJobTasks,
  claimWorkflowJobTask,
  commitWorkflowJobTaskSuccess,
  listWorkflowJobTasks
} = require("../src/core/workflow_analysis_tasks");
const { runWorkflowAnalysisPhase } = require("../src/core/job_analysis");

(async () => {
  const db = openDb(":memory:");
  const now = new Date("2026-07-20T08:00:00.000Z");
  try {
  const { profileId, planId } = seedPlan(db);
  const freshScan = seedScanningWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-07-15",
    sequence: 1,
    heartbeatAt: "2026-07-20T07:59:30.000Z"
  });
  const staleScan = seedScanningWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-07-16",
    sequence: 1,
    heartbeatAt: "2026-07-20T07:55:00.000Z"
  });
  const stalePause = seedScanningWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-07-12",
    sequence: 1,
    heartbeatAt: "2026-07-20T07:55:00.000Z"
  });
  requestWorkflowPause(db, {
    workflowRunId: stalePause.workflow.id,
    now: "2026-07-20T07:59:00.000Z"
  });
  const staleStop = seedScanningWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-07-11",
    sequence: 1,
    heartbeatAt: "2026-07-20T07:55:00.000Z"
  });
  requestWorkflowStop(db, {
    workflowRunId: staleStop.workflow.id,
    confirmStop: true,
    now: "2026-07-20T07:59:00.000Z"
  });
  const missingScan = seedWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-07-14",
    sequence: 1
  });
  transitionWorkflowRun(db, { id: missingScan.id, status: "scanning", updatedAt: "2026-07-20T07:55:00.000Z" });
  const orphanedCreated = seedWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-07-13",
    sequence: 1
  });
  db.prepare("UPDATE workflow_runs SET updated_at = ? WHERE id = ?")
    .run("2026-07-20T07:55:00.000Z", orphanedCreated.id);
  const review = seedWorkflow(db, { profileId, planId, localDay: "2026-07-17", sequence: 1 });
  transitionWorkflowRun(db, { id: review.id, status: "scanning" });
  transitionWorkflowRun(db, { id: review.id, status: "analyzing" });
  transitionWorkflowRun(db, {
    id: review.id,
    status: "review_required",
    inventoryCount: 17,
    metrics: { collected: 50, detailsRead: 38, analyzed: 38, eligible: 17 }
  });
  db.prepare("UPDATE workflow_runs SET updated_at = ? WHERE id = ?")
    .run("2026-07-19T00:00:00.000Z", review.id);

  const staleCommunication = seedCommunicatingWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-07-18",
    sequence: 1,
    batchStatus: "running",
    batchUpdatedAt: "2026-07-20T07:55:00.000Z",
    itemStatuses: ["pending", "pending"]
  });
  const activeCommunication = seedCommunicatingWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-07-18",
    sequence: 2,
    batchStatus: "running",
    batchUpdatedAt: "2026-07-20T07:55:00.000Z",
    itemUpdatedAt: "2026-07-20T07:59:30.000Z",
    itemStatuses: ["opening", "pending"]
  });
  const completedCommunication = seedCommunicatingWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-07-19",
    sequence: 1,
    batchStatus: "completed",
    batchUpdatedAt: "2026-07-20T07:59:00.000Z",
    itemStatuses: ["succeeded", "already_communicated", "stopped"]
  });

  const countBefore = listWorkflowRuns(db, { profileId, limit: 100 }).length;
  const report = recoverWorkflowRuns(db, { now, orphanTimeoutMs: 60_000 });

  assert.strictEqual(report.scanRunsInterrupted, 3);
  assert.strictEqual(report.workflowRunsInterrupted, 4);
  assert.strictEqual(report.workflowRunsPaused, 1);
  assert.strictEqual(report.workflowRunsStopped, 1);
  assert.strictEqual(report.workflowRunsCompleted, 1);
  assert.strictEqual(report.reviewRunsPreserved, 1);
  assert.strictEqual(report.browserActionsStarted, 0);

  assert.strictEqual(getWorkflowRun(db, freshScan.workflow.id).status, "scanning");
  assert.strictEqual(getWorkflowRun(db, staleScan.workflow.id).status, "interrupted");
  assert.strictEqual(getWorkflowRun(db, staleScan.workflow.id).errorCode, "SCAN_RUN_ORPHANED");
  const recoveredPause = getWorkflowRun(db, stalePause.workflow.id);
  assert.strictEqual(recoveredPause.status, "paused");
  assert.strictEqual(recoveredPause.controlState, "none");
  assert.strictEqual(recoveredPause.resumePhase, "scanning");
  const resumedPause = resumeWorkflowRun(db, {
    workflowRunId: stalePause.workflow.id,
    now: "2026-07-20T08:01:00.000Z"
  });
  assert.strictEqual(resumedPause.status, "scanning");
  assert.strictEqual(resumedPause.controlState, "none");
  assert.strictEqual(getWorkflowRun(db, staleStop.workflow.id).status, "stopped");
  assert.strictEqual(getWorkflowRun(db, staleStop.workflow.id).controlState, "none");
  assert.strictEqual(getWorkflowRun(db, missingScan.id).status, "interrupted");
  assert.strictEqual(getWorkflowRun(db, missingScan.id).errorCode, "SCAN_RUN_MISSING");
  assert.strictEqual(getWorkflowRun(db, orphanedCreated.id).status, "interrupted");
  assert.strictEqual(getWorkflowRun(db, orphanedCreated.id).errorCode, "WORKFLOW_CHILD_NOT_STARTED");
  assert.strictEqual(getWorkflowRun(db, review.id).status, "review_required");
  assert.strictEqual(getWorkflowRun(db, review.id).inventoryCount, 17);
  assert.deepStrictEqual(getWorkflowRun(db, review.id).metrics, {
    collected: 50,
    detailsRead: 38,
    analyzed: 38,
    eligible: 17
  });

  assert.strictEqual(getCommunicationBatch(db, staleCommunication.batchId).status, "interrupted");
  const interruptedCommunication = getWorkflowRun(db, staleCommunication.workflow.id);
  assert.strictEqual(interruptedCommunication.status, "interrupted");
  assert.strictEqual(interruptedCommunication.successfulCount, 0);
  assert.strictEqual(interruptedCommunication.metrics.communication.selected, 2);
  assert.strictEqual(interruptedCommunication.metrics.communication.succeeded, 0);
  assert(Number.isFinite(interruptedCommunication.metrics.durationMs));

  assert.strictEqual(getCommunicationBatch(db, activeCommunication.batchId).status, "running");
  assert.strictEqual(getWorkflowRun(db, activeCommunication.workflow.id).status, "communicating");

  const completed = getWorkflowRun(db, completedCommunication.workflow.id);
  assert.strictEqual(completed.status, "completed");
  assert.strictEqual(completed.successfulCount, 2);
  assert.strictEqual(completed.metrics.communication.selected, 3);
  assert.strictEqual(completed.metrics.communication.succeeded, 2);
  assert.strictEqual(completed.metrics.communication.unavailable, 0);
  assert(Number.isFinite(completed.metrics.durationMs));

  assert.strictEqual(listWorkflowRuns(db, { profileId, limit: 100 }).length, countBefore);
  const resumed = transitionWorkflowRun(db, { id: staleScan.workflow.id, status: "scanning" });
  assert.strictEqual(resumed.sequence, staleScan.workflow.sequence);
  assert.strictEqual(listWorkflowRuns(db, { profileId, limit: 100 }).length, countBefore);

  dashboardStartupRecovery();
  await crashExpiredLeaseResumeE2E();
  await manualPauseConcurrencyTwoE2E();
  await timeoutCircuitRecoveryE2E();
  pausedRecoveryNoBrowserNoChild();
  orphanAnalyzingTaskRecoveryCounts();
  activeAnalysisExecutionRecoverySmoke();
  console.log("workflow_recovery_smoke ok");
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function activeAnalysisExecutionRecoverySmoke() {
  const database = openDb(":memory:");
  try {
    const { profileId, planId } = seedPlan(database);
    const workflow = seedWorkflow(database, {
      profileId,
      planId,
      localDay: "2026-09-30",
      sequence: 1
    });
    const batchId = createBatch(database, "boss", "analysis", "completed acquisition", {
      profileId,
      searchPlanId: planId,
      status: "running"
    });
    transitionWorkflowRun(database, { id: workflow.id, status: "scanning" });
    const acquisition = createScanRun(database, {
      runId: "analysis-recovery-acquisition",
      site: "boss",
      command: "daily",
      planId,
      batchId,
      startedAt: "2026-09-30T00:00:00.000Z",
      heartbeatAt: "2026-09-30T00:00:00.000Z"
    });
    attachWorkflowScan(database, {
      id: workflow.id,
      scanRunId: acquisition.id,
      scanBatchId: batchId
    });
    finishScanRun(database, {
      runId: acquisition.id,
      status: "completed",
      finishedAt: "2026-09-30T00:01:00.000Z"
    });
    transitionWorkflowRun(database, {
      id: workflow.id,
      status: "analyzing",
      updatedAt: "2026-09-30T00:02:00.000Z"
    });
    const execution = createScanRun(database, {
      runId: "analysis-recovery-current",
      site: "boss",
      command: "daily",
      planId,
      startedAt: "2026-09-30T00:02:00.000Z",
      heartbeatAt: "2026-09-30T00:02:30.000Z"
    });
    attachWorkflowScan(database, {
      id: workflow.id,
      scanRunId: execution.id,
      scanBatchId: batchId
    });

    const report = recoverWorkflowRuns(database, {
      workflowRunId: workflow.id,
      now: new Date("2026-09-30T00:03:00.000Z"),
      orphanTimeoutMs: 60_000
    });
    const preserved = getWorkflowRun(database, workflow.id);
    assert.strictEqual(report.workflowRunsInterrupted, 0);
    assert.strictEqual(report.activeRunsPreserved, 1);
    assert.strictEqual(preserved.status, "analyzing");
    assert.strictEqual(preserved.scanRunId, execution.id);
    assert.strictEqual(preserved.scanBatchId, batchId);
    assert.strictEqual(database.prepare("SELECT status FROM batches WHERE id = ?").get(batchId).status, "completed");
  } finally {
    database.close();
  }
}

async function crashExpiredLeaseResumeE2E() {
  const database = openDb(":memory:");
  try {
    const { profileId, planId } = seedPlan(database);
    const localDay = "2026-09-10";
    const batchId = createBatch(database, "boss", "RAG", "crash recovery", {
      profileId,
      searchPlanId: planId
    });
    const jobIds = [];
    for (let index = 0; index < 8; index += 1) {
      const sourceId = `crash-job-${index + 1}`;
      jobIds.push(Number(upsertJob(database, {
        source: "boss",
        sourceId,
        keyword: "RAG",
        title: `Crash Job ${index + 1}`,
        company: "Crash Co",
        location: "Guangzhou",
        salary: "10-20K",
        experience: "1-3年",
        education: "本科",
        url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
        description: "Python RAG application development",
        score: 20,
        level: "A",
        matches: ["Python", "RAG"],
        risks: [],
        qualityTags: [],
        analysis: { semanticStatus: "pending", decisionSource: "analysis_pending" }
      }, batchId)));
    }
    const workflow = createWorkflowRun(database, {
      profileId,
      planId,
      localDay,
      sequence: 1,
      targetSuccessCount: 35,
      inventoryCount: 0,
      candidateGap: 35,
      scanNeeded: true,
      keywords: [{ word: "RAG", priority: "A", maxCards: 50, maxDetails: 40 }],
      budget: { maxDetailTotal: 120, browserPageBudget: 20 },
      planner: { remainingDailyTarget: 70, remainingRunSlots: 2 },
      modelConfigRevision: "crash-rev",
      createdAt: `${localDay}T01:00:00.000Z`
    });
    transitionWorkflowRun(database, {
      id: workflow.id,
      status: "scanning",
      updatedAt: `${localDay}T01:05:00.000Z`
    });
    const scan = createScanRun(database, {
      runId: `scan-crash-${workflow.id}`,
      planId,
      batchId,
      startedAt: `${localDay}T01:05:00.000Z`,
      heartbeatAt: `${localDay}T01:05:00.000Z`
    });
    attachWorkflowScan(database, { id: workflow.id, scanRunId: scan.id, scanBatchId: batchId });
    transitionWorkflowRun(database, {
      id: workflow.id,
      status: "analyzing",
      modelConfigRevision: "crash-rev",
      updatedAt: `${localDay}T01:06:00.000Z`
    });

    const initialized = initializeWorkflowJobTasks(database, {
      workflowRunId: workflow.id,
      batchId,
      jobs: observationEntries(database, batchId),
      modelConfigRevision: "crash-rev",
      now: `${localDay}T01:06:00.000Z`
    });
    assert.strictEqual(initialized.inserted, 8);

    const claims = [];
    // Only the first four tasks were claimed when the child disappeared;
    // the remaining four are still pending and must survive the recovery.
    for (let index = 0; index < 4; index += 1) {
      claims.push(claimWorkflowJobTask(database, {
        workflowRunId: workflow.id,
        leaseOwner: `crash-worker-${index + 1}`,
        leaseTtlMs: 3 * 60_000,
        selectModelIdentity: () => modelIdentity("crash-rev"),
        now: `${localDay}T01:06:00.000Z`
      }));
    }
    assert.strictEqual(claims.length, 4);
    for (let index = 0; index < 3; index += 1) {
      commitWorkflowJobTaskSuccess(database, {
        taskId: claims[index].task.id,
        leaseOwner: `crash-worker-${index + 1}`,
        analyzedJob: analyzedJobFor(claims[index].job),
        modelIdentity: modelIdentity("crash-rev"),
        telemetry: { modelCallCount: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        startedAt: `${localDay}T01:06:00.000Z`,
        finishedAt: `${localDay}T01:07:00.000Z`
      });
    }

    // Simulate the child disappearing: the scan heartbeat is stale and the
    // fourth task lease expired while its attempt was still running.
    database.prepare("UPDATE scan_runs SET heartbeat_at = ? WHERE id = ?")
      .run(`${localDay}T01:07:00.000Z`, scan.id);
    database.prepare("UPDATE workflow_job_tasks SET lease_expires_at = ? WHERE id = ?")
      .run(`${localDay}T01:06:30.000Z`, claims[3].task.id);

    const report = recoverWorkflowRuns(database, {
      now: new Date(`${localDay}T02:00:00.000Z`),
      orphanTimeoutMs: 60_000
    });
    assert.strictEqual(report.scanRunsInterrupted, 1);
    assert.strictEqual(report.workflowRunsInterrupted, 1);
    assert.strictEqual(report.tasksRecovered, 1);
    assert.strictEqual(report.tasksFailed, 0);
    const recoveredWorkflow = getWorkflowRun(database, workflow.id);
    assert.strictEqual(recoveredWorkflow.status, "interrupted");
    assert.strictEqual(recoveredWorkflow.recoveryGeneration, 0);
    assert.strictEqual(recoveredWorkflow.circuitTimeoutJobCount, 0);
    assert.deepStrictEqual(
      workflowTasks(database, workflow.id).map((task) => task.status),
      ["succeeded", "succeeded", "succeeded", "retry_pending", "pending", "pending", "pending", "pending"]
    );
    for (const jobId of jobIds.slice(0, 3)) {
      const observation = database.prepare(
        "SELECT analysis_json FROM job_observations WHERE job_id = ? AND batch_id = ?"
      ).get(jobId, batchId);
      assert.strictEqual(JSON.parse(observation.analysis_json).semanticStatus, "complete");
    }

    const resumed = await runWorkflowAnalysisPhase(database, {
      // Re-enter the same persisted workflow. A crash recovery must not
      // create a new daily run or advance the recovery generation.
      workflowRun: recoveredWorkflow,
      batchId,
      jobsToAnalyze: reportJobsAscending(database, batchId),
      configs: {},
      keywordPlan: [],
      logger: silentLogger(),
      signal: null,
      modelRuntimes: { primary: { ...primaryRuntime(), concurrency: 1 }, backup: null },
      createAnalyzeJob: () => async (job) => analyzedJobFor(job),
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      now: fixedClock(`${localDay}T02:05:00.000Z`),
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    assert.strictEqual(resumed.status, "drained");
    assert.strictEqual(resumed.claimed, 5);
    assert.strictEqual(resumed.succeeded, 5);
    assert.strictEqual(getWorkflowRun(database, workflow.id).status, "review_required");
    const finalTasks = workflowTasks(database, workflow.id);
    assert.deepStrictEqual(finalTasks.map((task) => task.status), [
      "succeeded", "succeeded", "succeeded", "succeeded",
      "succeeded", "succeeded", "succeeded", "succeeded"
    ]);
    assert.strictEqual(finalTasks.filter((task) => task.finished_at).length, 8);
    assert.strictEqual(finalTasks.filter((task) => task.recovery_generation !== 0).length, 0);

    const attempts = database.prepare(`
      SELECT task_id, COUNT(*) AS count,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded
      FROM job_analysis_attempts
      WHERE workflow_run_id = ?
      GROUP BY task_id
      ORDER BY task_id
    `).all(workflow.id);
    assert.strictEqual(attempts.length, 8);
    assert.deepStrictEqual(attempts.map((row) => [row.count, row.failed, row.succeeded]), [
      [1, 0, 1], [1, 0, 1], [1, 0, 1], [2, 1, 1],
      [1, 0, 1], [1, 0, 1], [1, 0, 1], [1, 0, 1]
    ]);
    assert.strictEqual(Number(database.prepare(
      "SELECT COUNT(*) AS count FROM job_analysis_attempts WHERE workflow_run_id = ?"
    ).get(workflow.id).count), 9);
  } finally {
    database.close();
  }
}

async function manualPauseConcurrencyTwoE2E() {
  const database = openDb(":memory:");
  try {
    const fixture = seedAnalysisWorkflow(database, {
      localDay: "2026-09-13",
      revision: "pause-rev",
      count: 5
    });
    const started = [];
    let release;
    const releaseGate = new Promise((resolve) => { release = resolve; });
    let startedResolve;
    const startedReady = new Promise((resolve) => { startedResolve = resolve; });
    let analysisNow = "2026-09-13T01:05:00.000Z";

    const runPromise = runWorkflowAnalysisPhase(database, {
      workflowRun: fixture.workflow,
      batchId: fixture.batchId,
      jobsToAnalyze: fixture.jobs,
      configs: {},
      keywordPlan: [],
      logger: silentLogger(),
      signal: null,
      modelRuntimes: { primary: { ...runtimeFor("pause-rev", 2) }, backup: null },
      createAnalyzeJob: () => async (job) => analyzedJobFor(job),
      analyzeScannedJob: async (raw) => {
        started.push(raw.sourceId);
        if (started.length === 2) startedResolve();
        await releaseGate;
        return analyzedJobFor(raw);
      },
      now: () => analysisNow,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });

    await startedReady;
    const beforePause = getWorkflowRun(database, fixture.workflow.id);
    assert.strictEqual(beforePause.status, "analyzing");
    assert.strictEqual(beforePause.controlState, "none");
    assert.strictEqual(started.length, 2, "exactly two workers must be in flight before pause");

    const requested = requestWorkflowPause(database, {
      workflowRunId: fixture.workflow.id,
      now: "2026-09-13T01:05:30.000Z"
    });
    assert.strictEqual(requested.controlState, "pause_requested");
    assert.strictEqual(requested.resumePhase, "analyzing");

    // Both in-flight model calls settle and persist. The control flag is
    // already durable, so neither worker may claim task three afterwards.
    analysisNow = "2026-09-13T01:05:45.000Z";
    release();
    const pausedSummary = await runPromise;
    assert.strictEqual(pausedSummary.status, "paused");
    assert.strictEqual(started.length, 2, "manual pause must prevent a third claim");
    assert.deepStrictEqual(
      workflowTasks(database, fixture.workflow.id).map((task) => task.status),
      ["succeeded", "succeeded", "pending", "pending", "pending"]
    );

    const paused = getWorkflowRun(database, fixture.workflow.id);
    assert.strictEqual(paused.status, "paused");
    assert.strictEqual(paused.controlState, "pause_requested");
    finalizeWorkflowControl(database, {
      workflowRunId: fixture.workflow.id,
      now: "2026-09-13T01:06:00.000Z"
    });
    const resumed = resumeWorkflowRun(database, {
      workflowRunId: fixture.workflow.id,
      now: "2026-09-13T01:07:00.000Z"
    });
    assert.strictEqual(resumed.id, fixture.workflow.id);
    assert.strictEqual(resumed.sequence, fixture.workflow.sequence);
    assert.strictEqual(resumed.localDay, fixture.workflow.localDay);
    assert.strictEqual(resumed.recoveryGeneration, fixture.workflow.recoveryGeneration);

    const resumedSourceIds = [];
    const drain = await runWorkflowAnalysisPhase(database, {
      workflowRun: resumed,
      batchId: fixture.batchId,
      jobsToAnalyze: fixture.jobs,
      configs: {},
      keywordPlan: [],
      logger: silentLogger(),
      signal: null,
      modelRuntimes: { primary: { ...runtimeFor("pause-rev", 2) }, backup: null },
      createAnalyzeJob: () => async (job) => analyzedJobFor(job),
      analyzeScannedJob: async (raw) => {
        resumedSourceIds.push(raw.sourceId);
        return analyzedJobFor(raw);
      },
      now: fixedClock("2026-09-13T01:07:30.000Z"),
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    assert.strictEqual(drain.status, "drained");
    assert.strictEqual(resumedSourceIds.length, 3);
    assert.deepStrictEqual(
      workflowTasks(database, fixture.workflow.id).map((task) => task.status),
      ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]
    );
    assert.strictEqual(listWorkflowRuns(database, { profileId: fixture.workflow.profileId, limit: 10 }).length, 1);
    assert.strictEqual(database.prepare(
      "SELECT COUNT(*) AS count FROM job_analysis_attempts WHERE workflow_run_id = ?"
    ).get(fixture.workflow.id).count, 5);
  } finally {
    database.close();
  }
}

async function timeoutCircuitRecoveryE2E() {
  const database = openDb(":memory:");
  try {
    const fixture = seedAnalysisWorkflow(database, {
      localDay: "2026-09-14",
      revision: "timeout-rev-1",
      count: 12
    });
    const timeoutSourceIds = fixture.sourceIds.slice(0, 10);
    const untouchedSourceIds = fixture.sourceIds.slice(10);
    let firstPhaseCalls = 0;
    const first = await runWorkflowAnalysisPhase(database, {
      workflowRun: fixture.workflow,
      batchId: fixture.batchId,
      jobsToAnalyze: fixture.jobs,
      configs: {},
      keywordPlan: [],
      logger: silentLogger(),
      signal: null,
      modelRuntimes: { primary: { ...runtimeFor("timeout-rev-1", 1) }, backup: null },
      createAnalyzeJob: () => async (job) => analyzedJobFor(job),
      analyzeScannedJob: async () => {
        firstPhaseCalls += 1;
        const error = new Error("offline model timeout");
        error.code = "MODEL_TIMEOUT";
        throw error;
      },
      now: fixedClock("2026-09-14T01:10:00.000Z"),
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    assert.strictEqual(first.status, "paused");
    assert.strictEqual(firstPhaseCalls, 20, "ten jobs must each reach a final timeout");
    const paused = getWorkflowRun(database, fixture.workflow.id);
    assert.strictEqual(paused.status, "paused");
    assert.strictEqual(paused.controlState, "pause_requested");
    assert.strictEqual(paused.errorCode, "MODEL_TIMEOUT_CIRCUIT_OPEN");
    assert.strictEqual(paused.circuitTimeoutJobCount, 10);
    assert.strictEqual(paused.lifetimeTimeoutJobCount, 10);
    assert.strictEqual(paused.recoveryGeneration, 0);
    assert.deepStrictEqual(
      workflowTasks(database, fixture.workflow.id).map((task) => task.status),
      ["failed", "failed", "failed", "failed", "failed", "failed", "failed", "failed", "failed", "failed", "pending", "pending"]
    );

    assert.throws(
      () => resumeWorkflowRun(database, {
        workflowRunId: fixture.workflow.id,
        now: "2026-09-14T01:11:00.000Z"
      }),
      (error) => error.code === "WORKFLOW_MODEL_RECHECK_REQUIRED"
    );

    const resumed = resumeWorkflowRun(database, {
      workflowRunId: fixture.workflow.id,
      batchModelRevision: "timeout-rev-2",
      batchModelVerifiedAt: "2026-09-14T01:11:00.000Z",
      now: "2026-09-14T01:12:00.000Z"
    });
    assert.strictEqual(resumed.recoveryGeneration, 1);
    assert.strictEqual(resumed.circuitTimeoutJobCount, 0);
    assert.strictEqual(resumed.lifetimeTimeoutJobCount, 10);
    const migrated = workflowTasks(database, fixture.workflow.id);
    assert(migrated.slice(0, 10).every((task) => (
      task.status === "retry_pending"
      && task.recovery_generation === 1
      && task.priority === 10
    )));
    assert(migrated.slice(10).every((task) => (
      task.status === "pending"
      && task.recovery_generation === 0
      && task.priority === 100
    )));

    const resumedSourceIds = [];
    const drained = await runWorkflowAnalysisPhase(database, {
      workflowRun: resumed,
      batchId: fixture.batchId,
      jobsToAnalyze: fixture.jobs,
      configs: {},
      keywordPlan: [],
      logger: silentLogger(),
      signal: null,
      modelRuntimes: { primary: { ...runtimeFor("timeout-rev-2", 1) }, backup: null },
      createAnalyzeJob: () => async (job) => analyzedJobFor(job),
      analyzeScannedJob: async (raw) => {
        resumedSourceIds.push(raw.sourceId);
        return analyzedJobFor(raw);
      },
      now: fixedClock("2026-09-14T01:12:30.000Z"),
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    assert.strictEqual(drained.status, "drained");
    assert.deepStrictEqual(resumedSourceIds, [...timeoutSourceIds, ...untouchedSourceIds]);
    const completed = getWorkflowRun(database, fixture.workflow.id);
    assert.strictEqual(completed.status, "review_required");
    assert.strictEqual(completed.recoveryGeneration, 1);
    assert.strictEqual(completed.circuitTimeoutJobCount, 0);
    assert.strictEqual(completed.lifetimeTimeoutJobCount, 10);
    assert(workflowTasks(database, fixture.workflow.id).every((task) => task.status === "succeeded"));
  } finally {
    database.close();
  }
}

function seedAnalysisWorkflow(database, { localDay, revision, count }) {
  const { profileId, planId } = seedPlan(database);
  const batchId = createBatch(database, "boss", "RAG", "analysis fixture", {
    profileId,
    searchPlanId: planId,
    status: "running"
  });
  const sourceIds = [];
  for (let index = 0; index < count; index += 1) {
    const sourceId = `analysis-${localDay}-${index + 1}`;
    sourceIds.push(sourceId);
    upsertJob(database, {
      source: "boss",
      sourceId,
      keyword: "RAG",
      title: `Analysis Job ${index + 1}`,
      company: "Offline Analysis Co",
      location: "Guangzhou",
      salary: "10-20K",
      experience: "1-3 years",
      education: "Bachelor",
      url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
      description: "Python RAG application development",
      score: 20,
      level: "A",
      matches: ["Python", "RAG"],
      risks: [],
      qualityTags: [],
      analysis: { semanticStatus: "pending", decisionSource: "analysis_pending" }
    }, batchId);
  }
  const workflow = createWorkflowRun(database, {
    profileId,
    planId,
    localDay,
    sequence: 1,
    targetSuccessCount: count,
    inventoryCount: 0,
    candidateGap: count,
    scanNeeded: true,
    keywords: [{ word: "RAG", priority: "A", maxCards: count, maxDetails: count }],
    budget: { maxDetailTotal: 120, browserPageBudget: 20 },
    planner: { remainingDailyTarget: 70, remainingRunSlots: 2 },
    modelConfigRevision: revision,
    createdAt: `${localDay}T01:00:00.000Z`
  });
  transitionWorkflowRun(database, {
    id: workflow.id,
    status: "scanning",
    updatedAt: `${localDay}T01:01:00.000Z`
  });
  const scan = createScanRun(database, {
    runId: `scan-analysis-${workflow.id}`,
    planId,
    batchId,
    startedAt: `${localDay}T01:01:00.000Z`,
    heartbeatAt: `${localDay}T01:01:00.000Z`
  });
  attachWorkflowScan(database, { id: workflow.id, scanRunId: scan.id, scanBatchId: batchId });
  finishScanRun(database, {
    runId: scan.id,
    status: "completed",
    finishedAt: `${localDay}T01:02:00.000Z`
  });
  return {
    workflow: getWorkflowRun(database, workflow.id),
    batchId,
    jobs: observationEntries(database, batchId),
    sourceIds
  };
}

function runtimeFor(revision, concurrency) {
  return {
    revision,
    concurrency,
    modelConfig: {
      provider: "mock",
      providers: {
        mock: {
          model: "offline-mock",
          thinkingMode: "disabled",
          reasoningEffort: "high"
        }
      }
    }
  };
}

function pausedRecoveryNoBrowserNoChild() {
  const database = openDb(":memory:");
  try {
    const { profileId, planId } = seedPlan(database);
    const localDay = "2026-09-11";
    const workflow = seedWorkflow(database, { profileId, planId, localDay, sequence: 1 });
    transitionWorkflowRun(database, { id: workflow.id, status: "scanning" });
    const batchId = createBatch(database, "boss", "RAG", "paused scan", {
      profileId,
      searchPlanId: planId
    });
    const scan = createScanRun(database, {
      runId: `scan-paused-${workflow.id}`,
      planId,
      batchId,
      heartbeatAt: `${localDay}T01:59:30.000Z`
    });
    attachWorkflowScan(database, { id: workflow.id, scanRunId: scan.id, scanBatchId: batchId });
    transitionWorkflowRun(database, { id: workflow.id, status: "analyzing" });
    transitionWorkflowRun(database, {
      id: workflow.id,
      status: "paused",
      resumePhase: "analyzing",
      controlState: "none"
    });

    const report = recoverWorkflowRuns(database, {
      now: new Date(`${localDay}T02:00:00.000Z`),
      orphanTimeoutMs: 60_000
    });
    assert.strictEqual(report.scanRunsInterrupted, 0);
    assert.strictEqual(report.workflowRunsInterrupted, 0);
    assert.strictEqual(report.workflowRunsCompleted, 0);
    assert.strictEqual(report.browserActionsStarted, 0);
    assert.strictEqual(report.activeRunsPreserved, 1);
    assert.strictEqual(getWorkflowRun(database, workflow.id).status, "paused");
    assert.strictEqual(database.prepare("SELECT status FROM scan_runs WHERE id = ?").get(scan.id).status, "running");
  } finally {
    database.close();
  }
}

function orphanAnalyzingTaskRecoveryCounts() {
  const database = openDb(":memory:");
  try {
    const { profileId, planId } = seedPlan(database);
    const localDay = "2026-09-12";
    const batchId = createBatch(database, "boss", "RAG", "orphan task recovery", {
      profileId,
      searchPlanId: planId
    });
    for (let index = 0; index < 2; index += 1) {
      const sourceId = `orphan-job-${index + 1}`;
      upsertJob(database, {
        source: "boss",
        sourceId,
        keyword: "RAG",
        title: `Orphan Job ${index + 1}`,
        company: "Orphan Co",
        location: "Guangzhou",
        salary: "10-20K",
        experience: "1-3年",
        education: "本科",
        url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
        description: "Python RAG application development",
        score: 20,
        level: "A",
        matches: ["Python", "RAG"],
        risks: [],
        qualityTags: [],
        analysis: { semanticStatus: "pending", decisionSource: "analysis_pending" }
      }, batchId);
    }
    const workflow = createWorkflowRun(database, {
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
      modelConfigRevision: "orphan-rev",
      createdAt: `${localDay}T01:00:00.000Z`
    });
    transitionWorkflowRun(database, { id: workflow.id, status: "scanning" });
    const scan = createScanRun(database, {
      runId: `scan-orphan-${workflow.id}`,
      planId,
      batchId,
      heartbeatAt: `${localDay}T01:50:00.000Z`
    });
    attachWorkflowScan(database, { id: workflow.id, scanRunId: scan.id, scanBatchId: batchId });
    transitionWorkflowRun(database, { id: workflow.id, status: "analyzing" });
    initializeWorkflowJobTasks(database, {
      workflowRunId: workflow.id,
      batchId,
      jobs: observationEntries(database, batchId),
      modelConfigRevision: "orphan-rev",
      now: `${localDay}T01:06:00.000Z`
    });
    const claims = [];
    for (let index = 0; index < 2; index += 1) {
      claims.push(claimWorkflowJobTask(database, {
        workflowRunId: workflow.id,
        leaseOwner: `orphan-worker-${index + 1}`,
        leaseTtlMs: 3 * 60_000,
        selectModelIdentity: () => modelIdentity("orphan-rev"),
        now: `${localDay}T01:06:00.000Z`
      }));
    }
    // The second task already exhausted its retry budget before the crash.
    database.prepare(`
      UPDATE workflow_job_tasks SET
        attempt_count_in_generation = 2,
        total_attempt_count = 2,
        lease_expires_at = ?
      WHERE id = ?
    `).run(`${localDay}T01:06:30.000Z`, claims[1].task.id);

    const report = recoverWorkflowRuns(database, {
      now: new Date(`${localDay}T02:00:00.000Z`),
      orphanTimeoutMs: 60_000
    });
    assert.strictEqual(report.tasksRecovered, 1);
    assert.strictEqual(report.tasksFailed, 1);
    assert.strictEqual(report.workflowRunsInterrupted, 1);
    const tasks = workflowTasks(database, workflow.id);
    assert.deepStrictEqual(tasks.map((task) => task.status), ["retry_pending", "failed"]);
    assert.strictEqual(tasks[0].last_error_code, "LEASE_EXPIRED");
    assert.strictEqual(tasks[1].last_error_code, "LEASE_EXPIRED");
    assert.strictEqual(tasks[0].finished_at, null);
    assert(tasks[1].finished_at);
  } finally {
    database.close();
  }
}

function dashboardStartupRecovery() {
  const database = openDb(":memory:");
  try {
    const { profileId, planId } = seedPlan(database);
    const stale = seedScanningWorkflow(database, {
      profileId,
      planId,
      localDay: "2026-07-12",
      sequence: 1,
      heartbeatAt: "2000-01-01T00:00:00.000Z"
    });
    createDashboardServer({
      db: database,
      forceMock: true,
      allowOfflineMock: true,
      logger: {
        info() {}, warn() {}, error() {},
        requestId() { return "workflow-recovery-startup"; },
        listRecent() { return []; }
      }
    });
    assert.strictEqual(getWorkflowRun(database, stale.workflow.id).status, "interrupted");
  } finally {
    database.close();
  }
}

function seedPlan(database) {
  const createdAt = "2026-07-01T00:00:00.000Z";
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Recovery Candidate', '{}', NULL, ?, ?)`).run(createdAt, createdAt).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Recovery Plan', '{}', NULL, 1, ?, ?)`).run(profileId, createdAt, createdAt).lastInsertRowid);
  return { profileId, planId };
}

function seedWorkflow(database, { profileId, planId, localDay, sequence }) {
  return createWorkflowRun(database, {
    profileId,
    planId,
    localDay,
    sequence,
    targetSuccessCount: 35,
    inventoryCount: 0,
    candidateGap: 35,
    scanNeeded: true,
    keywords: [{ word: "RAG", priority: "A", maxCards: 50, maxDetails: 40 }],
    budget: { maxDetailTotal: 40, browserPageBudget: 10 },
    planner: { replacementBuffer: 5 },
    createdAt: `${localDay}T01:00:00.000Z`
  });
}

function seedScanningWorkflow(database, input) {
  const workflow = seedWorkflow(database, input);
  transitionWorkflowRun(database, { id: workflow.id, status: "scanning", updatedAt: input.heartbeatAt });
  const batchId = createBatch(database, "boss", "RAG", "recovery scan", {
    profileId: input.profileId,
    searchPlanId: input.planId
  });
  const scan = createScanRun(database, {
    runId: `scan-${workflow.id}`,
    planId: input.planId,
    batchId,
    startedAt: input.heartbeatAt,
    heartbeatAt: input.heartbeatAt
  });
  attachWorkflowScan(database, { id: workflow.id, scanRunId: scan.id, scanBatchId: batchId });
  database.prepare("UPDATE workflow_runs SET updated_at = ? WHERE id = ?").run(input.heartbeatAt, workflow.id);
  return { workflow: getWorkflowRun(database, workflow.id), scan, batchId };
}

function seedCommunicatingWorkflow(database, input) {
  const workflow = seedWorkflow(database, input);
  transitionWorkflowRun(database, { id: workflow.id, status: "scanning" });
  transitionWorkflowRun(database, { id: workflow.id, status: "analyzing" });
  transitionWorkflowRun(database, { id: workflow.id, status: "review_required" });
  const batchId = seedCommunicationBatch(database, input);
  attachWorkflowCommunication(database, { id: workflow.id, communicationBatchId: batchId });
  transitionWorkflowRun(database, { id: workflow.id, status: "communicating" });
  database.prepare("UPDATE workflow_runs SET updated_at = ? WHERE id = ?")
    .run(input.batchUpdatedAt, workflow.id);
  return { workflow: getWorkflowRun(database, workflow.id), batchId };
}

function seedCommunicationBatch(database, input) {
  const batchId = Number(database.prepare(`INSERT INTO communication_batches(
    site, profile_id, plan_id, browser_mode, status, policy_json,
    confirmed_at, started_at, finished_at, created_at, updated_at
  ) VALUES ('boss', ?, ?, 'edge', ?, '{}', ?, ?, ?, ?, ?)`)
    .run(
      input.profileId,
      input.planId,
      input.batchStatus,
      input.batchUpdatedAt,
      input.batchUpdatedAt,
      input.batchStatus === "completed" ? input.batchUpdatedAt : null,
      input.batchUpdatedAt,
      input.batchUpdatedAt
    ).lastInsertRowid);
  input.itemStatuses.forEach((status, index) => {
    const sourceId = `recovery-${batchId}-${index}`;
    const scanBatchId = createBatch(database, "boss", "RAG", "communication recovery job", {
      profileId: input.profileId,
      searchPlanId: input.planId
    });
    upsertJob(database, {
      source: "boss",
      sourceId,
      keyword: "RAG",
      title: `RAG Engineer ${index}`,
      company: "Recovery Co",
      location: "Guangzhou",
      salary: "10-20K",
      experience: "1-3 years",
      education: "Bachelor",
      url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
      tags: ["Python", "RAG"],
      description: "Python RAG application development",
      score: 20,
      level: "A",
      matches: ["Python", "RAG"],
      risks: [],
      qualityTags: [],
      analysis: { semanticStatus: "complete", recommendation: "apply" }
    }, scanBatchId);
    const jobId = Number(database.prepare("SELECT id FROM jobs WHERE source_id = ?").get(sourceId).id);
    database.prepare(`INSERT INTO communication_batch_items(
      batch_id, job_id, position, job_url, title_snapshot, company_snapshot,
      status, click_count, evidence_json, finished_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'Recovery Co', ?, ?, '{}', ?, ?)`)
      .run(
        batchId,
        jobId,
        index + 1,
        `https://www.zhipin.com/job_detail/${sourceId}.html`,
        `RAG Engineer ${index}`,
        status,
        ["succeeded", "already_communicated"].includes(status) ? 1 : 0,
        ["succeeded", "already_communicated", "stopped"].includes(status) ? input.batchUpdatedAt : null,
        input.itemUpdatedAt || input.batchUpdatedAt
      );
  });
  return batchId;
}

function observationEntries(database, batchId) {
  return database.prepare(`
    SELECT job_id AS jobId, id AS observationId
    FROM job_observations
    WHERE batch_id = ?
    ORDER BY job_id ASC
  `).all(batchId);
}

function reportJobsAscending(database, batchId) {
  return database.prepare(`
    SELECT o.job_id AS jobId, o.id AS observationId
    FROM job_observations o
    WHERE o.batch_id = ?
    ORDER BY o.job_id ASC
  `).all(batchId);
}

function workflowTasks(database, workflowId) {
  return database.prepare(`
    SELECT * FROM workflow_job_tasks
    WHERE workflow_run_id = ?
    ORDER BY position ASC, id ASC
  `).all(workflowId);
}

function analyzedJobFor(job) {
  return {
    source: "boss",
    sourceId: job.sourceId,
    keyword: "RAG",
    title: job.title || "Crash Job",
    company: job.company || "Crash Co",
    location: job.location || "Guangzhou",
    salary: job.salary || "10-20K",
    experience: job.experience || "1-3年",
    education: job.education || "本科",
    url: job.url,
    description: job.description,
    score: job.score ?? 20,
    level: "A",
    matches: ["Python", "RAG"],
    risks: [],
    qualityTags: [],
    analysis: {
      semanticStatus: "complete",
      decisionSource: "model",
      recommendation: "apply",
      fitLevel: "A",
      confidence: 0.9,
      evidence: { jd: ["Python RAG"], resume: ["Python RAG"] },
      revision: "crash-rev"
    }
  };
}

function modelIdentity(revision) {
  return {
    profileKind: "batch_screening",
    modelConfigRevision: revision,
    provider: "mock",
    model: "offline-mock",
    thinkingMode: "disabled",
    reasoningEffort: "high",
    backupUsed: 0
  };
}

function primaryRuntime() {
  return {
    revision: "crash-rev",
    concurrency: 2,
    modelConfig: {
      provider: "mock",
      providers: {
        mock: {
          model: "offline-mock",
          thinkingMode: "disabled",
          reasoningEffort: "high"
        }
      }
    }
  };
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, child: () => silentLogger() };
}

function fixedClock(iso) {
  return () => iso;
}
