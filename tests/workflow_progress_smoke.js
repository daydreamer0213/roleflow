"use strict";

const assert = require("node:assert/strict");
const {
  openDb,
  createBatch,
  createScanRun,
  createWorkflowRun,
  attachWorkflowScan,
  transitionWorkflowRun,
  recordWorkflowScanWait,
  recordWorkflowPlatformAccess,
  recordScanTargetResult,
  attachWorkflowCommunication,
  upsertJob
} = require("../src/core/storage");
const {
  initializeWorkflowJobTasks,
  claimWorkflowJobTask,
  commitWorkflowJobTaskSuccess,
  commitWorkflowJobTaskFailure,
  recoverExpiredWorkflowJobTasks,
  listWorkflowJobTasks
} = require("../src/core/workflow_analysis_tasks");
const {
  getWorkflowProgressSnapshot,
  listWorkflowProgressJobs,
  estimateWorkflowAnalysisEta
} = require("../src/core/workflow_progress");

const db = openDb(":memory:");

try {
  testSnapshotRequiresExactRunId();
  testRecordWorkflowScanWait();
  testScanWaitAndHeartbeatActivity();
  testAggregateCountsMatchSqlAndInvariant();
  testCollectedDetailCountsComeFromObservations();
  testStageSpecificProgressBreakdown();
  testTruthfulFourTrackReadModel();
  testFailedTaskResolutionUsesLatestPlanObservation();
  testCommunicationProgressSeparatesAmbiguity();
  testStageMapping();
  testModelIdentityFromPlannerSnapshot();
  testModelIdentityFallbackNeverReadsGlobalDefaults();
  testRecentActivityCapAndWhitelist();
  testRecentActivityNeverLeaksJobContent();
  testWaitingForUnexpiredLeaseDuringControlledStop();
  testEtaEstimatingWithFewerThanThreeSamples();
  testEtaAvailableWithThreeSamples();
  testEtaUsesOnlyNewestTenCurrentRevisionSamples();
  testEtaExcludesSkippedPseudoAttempts();
  testEtaDeduplicatesPerTask();
  testEtaRetryPendingWidensOnlyUpperBound();
  testEtaPausedFreezesBounds();
  testEtaNotApplicableOutsideAnalysis();
  testEtaBoundsAreNonNegativeIntegers();
  testLeaseRecoveryBumpsRevisionOncePerBatch();
  console.log("workflow_progress_smoke ok");
} finally {
  db.close();
}

function testSnapshotRequiresExactRunId() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-06",
    modelConfigRevision: "mrev-exact"
  });
  assert.strictEqual(
    getWorkflowProgressSnapshot(db, { workflowRunId: "missing-run-id" }),
    null
  );
  assert.strictEqual(
    getWorkflowProgressSnapshot(db, { workflowRunId: `${scenario.workflowId}-suffix` }),
    null
  );
  const snapshot = getWorkflowProgressSnapshot(db, { workflowRunId: scenario.workflowId });
  assert.strictEqual(snapshot.workflow.id, scenario.workflowId);
}

function testRecordWorkflowScanWait() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-14",
    modelConfigRevision: "mrev-record-scan-wait"
  });
  const workflow = recordWorkflowScanWait(db, {
    workflowRunId: scenario.workflowId,
    runId: scenario.scanRunId,
    action: "detail_open",
    delayMs: 600000,
    retryAt: "2026-08-15T00:10:00.000Z",
    now: "2026-08-15T00:00:00.000Z"
  });
  assert.deepStrictEqual(workflow.metrics.scanWait, {
    runId: scenario.scanRunId,
    action: "detail_open",
    delayMs: 600000,
    retryAt: "2026-08-15T00:10:00.000Z"
  });
  assert.strictEqual(workflow.lastActivityAt, "2026-08-15T00:00:00.000Z");
}

function testScanWaitAndHeartbeatActivity() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-15",
    modelConfigRevision: "mrev-scan-wait"
  });
  db.prepare(`
    UPDATE workflow_runs SET
      status = 'scanning',
      last_activity_at = ?,
      metrics_json = ?
    WHERE id = ?
  `).run(
    "2026-08-15T00:00:00.000Z",
    JSON.stringify({
      scanWait: {
        runId: scenario.scanRunId,
        action: "detail_open",
        retryAt: "2026-08-15T00:10:00.000Z",
        delayMs: 600000
      }
    }),
    scenario.workflowId
  );
  db.prepare("UPDATE scan_runs SET heartbeat_at = ? WHERE id = ?")
    .run("2026-08-15T00:00:20.000Z", scenario.scanRunId);

  const snapshot = getWorkflowProgressSnapshot(db, {
    workflowRunId: scenario.workflowId,
    now: "2026-08-15T00:00:30.000Z"
  });
  assert.strictEqual(snapshot.workflow.lastActivityAt, "2026-08-15T00:00:20.000Z");
  assert.deepStrictEqual(snapshot.progress.scanWait, {
    action: "detail_open",
    retryAt: "2026-08-15T00:10:00.000Z",
    delayMs: 600000
  });

  recordWorkflowPlatformAccess(db, {
    workflowRunId: scenario.workflowId,
    now: "2026-08-15T00:00:40.000Z"
  });
  const afterPlatformAccess = getWorkflowProgressSnapshot(db, {
    workflowRunId: scenario.workflowId,
    now: "2026-08-15T00:00:41.000Z"
  });
  assert.strictEqual(afterPlatformAccess.workflow.lastActivityAt, "2026-08-15T00:00:40.000Z");
  assert.strictEqual(afterPlatformAccess.progress.scanWait, null);
}

function testAggregateCountsMatchSqlAndInvariant() {
  const scenario = seedWorkflow(db, {
    analyses: [{}, {}, {}, {}, {}, {}, {}],
    localDay: "2026-08-07",
    modelConfigRevision: "mrev-counts"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-counts",
    now: "2026-08-07T00:00:00.000Z"
  });
  const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
  const byId = Object.fromEntries(tasks.map((task) => [task.id, task]));
  const ids = tasks.map((task) => task.id);

  db.prepare("UPDATE workflow_job_tasks SET status = 'succeeded' WHERE id = ?").run(ids[0]);
  db.prepare("UPDATE workflow_job_tasks SET status = 'failed' WHERE id = ?").run(ids[1]);
  db.prepare("UPDATE workflow_job_tasks SET status = 'skipped', last_error_code = 'DETAIL_REQUIRED' WHERE id = ?").run(ids[2]);
  db.prepare("UPDATE workflow_job_tasks SET status = 'stopped' WHERE id = ?").run(ids[3]);
  db.prepare("UPDATE workflow_job_tasks SET status = 'running' WHERE id = ?").run(ids[4]);
  db.prepare("UPDATE workflow_job_tasks SET status = 'retry_pending' WHERE id = ?").run(ids[5]);

  const snapshot = getWorkflowProgressSnapshot(db, {
    workflowRunId: scenario.workflowId,
    now: "2026-08-07T01:00:00.000Z"
  });
  const analysis = snapshot.progress.analysis;
  const raw = db.prepare(`
    SELECT status, count(*) AS n
    FROM workflow_job_tasks
    WHERE workflow_run_id = ?
    GROUP BY status
  `).all(scenario.workflowId);
  const rawCounts = { pending: 0, running: 0, retry_pending: 0, succeeded: 0, failed: 0, skipped: 0, stopped: 0 };
  for (const row of raw) rawCounts[row.status] = Number(row.n);

  assert.strictEqual(analysis.pending, rawCounts.pending);
  assert.strictEqual(analysis.running, rawCounts.running);
  assert.strictEqual(analysis.retryPending, rawCounts.retry_pending);
  assert.strictEqual(analysis.succeeded, rawCounts.succeeded);
  assert.strictEqual(analysis.failed, rawCounts.failed);
  assert.strictEqual(analysis.skipped, rawCounts.skipped);
  assert.strictEqual(analysis.detailRequired, 1);
  assert.strictEqual(analysis.stopped, rawCounts.stopped);
  assert.strictEqual(analysis.total, tasks.length);
  assert.strictEqual(
    analysis.total,
    analysis.pending + analysis.running + analysis.retryPending
      + analysis.succeeded + analysis.failed + analysis.skipped + analysis.stopped
  );
  assert.strictEqual(analysis.timeoutPauseThreshold, 10);
  assert.strictEqual(analysis.circuitTimeoutJobs, 0);
  assert.strictEqual(analysis.lifetimeTimeoutJobs, 0);
}

function testCollectedDetailCountsComeFromObservations() {
  const scenario = seedWorkflow(db, {
    analyses: [{}, {}, {}, {}],
    localDay: "2026-08-08",
    modelConfigRevision: "mrev-details",
    descriptions: [
      "A".repeat(200),
      "B".repeat(200),
      "C".repeat(200),
      ""
    ]
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId).slice(0, 2),
    modelConfigRevision: "mrev-details",
    now: "2026-08-08T00:00:00.000Z"
  });
  db.prepare(`
    UPDATE job_observations
    SET quality_tags_json = '["detail_unverified"]'
    WHERE job_id = ? AND batch_id = ?
  `).run(observationEntries(db, scenario.batchId)[2].jobId, scenario.batchId);
  const snapshot = getWorkflowProgressSnapshot(db, { workflowRunId: scenario.workflowId });
  assert.strictEqual(snapshot.progress.collected, 4);
  assert.strictEqual(snapshot.progress.detailsRead, 2);
  assert.strictEqual(snapshot.progress.detailsPending, 1);
  assert.deepStrictEqual(snapshot.progress.details, {
    collected: 4,
    required: 3,
    read: 2,
    pending: 1,
    notRequired: 1,
    growing: false
  });
}

function testStageSpecificProgressBreakdown() {
  const scenario = seedWorkflow(db, {
    analyses: Array.from({ length: 12 }, () => ({})),
    localDay: "2026-08-16",
    modelConfigRevision: "mrev-stage-breakdown",
    descriptions: [
      ..."ABCDE".split("").map((letter) => letter.repeat(200)),
      ...Array.from({ length: 7 }, () => "")
    ]
  });
  const targets = Array.from({ length: 5 }, (_, index) => ({
    targetKey: `target-${index + 1}`
  }));
  db.prepare("UPDATE batches SET filter_snapshot_json = ? WHERE id = ?")
    .run(JSON.stringify({ execution: { targets } }), scenario.batchId);
  for (const [targetKey, status] of [
    ["target-1", "completed"],
    ["target-2", "completed"],
    ["target-3", "partial"],
    ["target-4", "failed"]
  ]) {
    recordScanTargetResult(db, {
      batchId: scenario.batchId,
      targetKey,
      status,
      finishedAt: "2026-08-16T00:00:00.000Z"
    });
  }
  db.prepare("UPDATE workflow_runs SET status = 'scanning' WHERE id = ?")
    .run(scenario.workflowId);

  const snapshot = getWorkflowProgressSnapshot(db, {
    workflowRunId: scenario.workflowId,
    now: "2026-08-16T00:01:00.000Z"
  });
  assert.deepStrictEqual(snapshot.progress.scanTargets, {
    total: 5,
    processed: 4,
    completed: 2,
    partial: 1,
    failed: 1,
    pending: 1
  });
  assert.deepStrictEqual(snapshot.progress.details, {
    collected: 12,
    required: 5,
    read: 5,
    pending: 0,
    notRequired: 7,
    growing: true
  });
  assert.match(snapshot.progress.remainingWorkLabel, /1 个搜索目标/);
  assert.match(snapshot.progress.remainingWorkLabel, /0 个岗位详情待读取/);
}

function testTruthfulFourTrackReadModel() {
  const scanningScenario = seedWorkflow(db, {
    analyses: [{}, {}, {}],
    localDay: "2026-08-18",
    modelConfigRevision: "mrev-truthful-scan-progress",
    descriptions: ["A".repeat(200), "", ""],
    keepCreated: true
  });
  const observations = observationEntries(db, scanningScenario.batchId);
  db.prepare(`
    UPDATE job_observations
    SET quality_tags_json = '["detail_unverified"]'
    WHERE id = ?
  `).run(observations[1].observationId);
  const targetKey = "101280100|RAG|default";
  const execution = {
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    targets: [
      { targetKey: "target-1", cityCode: "101280100", keyword: "AI", cardLimit: 20 },
      { targetKey, cityCode: "101280100", keyword: "RAG", cardLimit: 20 },
      { targetKey: "target-3", cityCode: "101280100", keyword: "Agent", cardLimit: 20 }
    ]
  };
  db.prepare("UPDATE batches SET filter_snapshot_json = ? WHERE id = ?").run(JSON.stringify({
    execution,
    runtime: {
      scanProgress: {
        version: 1,
        activity: "reading_detail",
        targetKey,
        targetLabel: "不可信标签",
        targetPosition: 2,
        targetTotal: 3,
        targetDiscovered: 12,
        detailPosition: 4,
        detailTotal: 7,
        updatedAt: "2026-08-18T00:00:00.000Z"
      }
    }
  }), scanningScenario.batchId);
  for (const [key, status] of [["target-1", "partial"], [targetKey, "failed"]]) {
    recordScanTargetResult(db, {
      batchId: scanningScenario.batchId,
      targetKey: key,
      status,
      finishedAt: "2026-08-18T00:00:00.000Z"
    });
  }
  transitionWorkflowRun(db, { id: scanningScenario.workflowId, status: "scanning" });
  attachWorkflowScan(db, {
    id: scanningScenario.workflowId,
    scanRunId: scanningScenario.scanRunId,
    scanBatchId: scanningScenario.batchId
  });

  const scanning = getWorkflowProgressSnapshot(db, {
    workflowRunId: scanningScenario.workflowId,
    now: "2026-08-18T00:01:00.000Z"
  });
  assert.strictEqual(scanning.progress.phaseKey, "acquisition");
  assert.strictEqual(scanning.progress.stageCount, 4);
  assert.strictEqual(scanning.progress.stageIndex, 2);
  assert.deepStrictEqual(scanning.progress.scanTargets, {
    total: 3,
    processed: 2,
    completed: 0,
    partial: 1,
    failed: 1,
    pending: 1
  });
  assert.deepStrictEqual(scanning.progress.details, {
    collected: 3,
    required: 2,
    read: 1,
    pending: 1,
    notRequired: 1,
    growing: true
  });
  assert.deepStrictEqual(scanning.progress.scan, {
    activity: "reading_detail",
    targetKey,
    targetLabel: "广州 · RAG",
    targetPosition: 2,
    targetTotal: 3,
    targetDiscovered: 12,
    detailPosition: 4,
    detailTotal: 7
  });
  assert.deepStrictEqual(scanning.progress.tracks, {
    scan: { value: 2, max: 3, indeterminate: false },
    jd: { value: 1, max: 2, indeterminate: false, growing: true },
    analysis: { value: 0, max: 0, indeterminate: false },
    communication: { value: 0, max: 0, indeterminate: false }
  });

  const analysisScenario = seedWorkflow(db, {
    analyses: [{}, {}, {}],
    localDay: "2026-08-19",
    modelConfigRevision: "mrev-truthful-analysis-progress",
    titleOverride: "Private Job Title",
    companyOverride: "Private Company"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: analysisScenario.workflowId,
    batchId: analysisScenario.batchId,
    jobs: observationEntries(db, analysisScenario.batchId),
    modelConfigRevision: "mrev-truthful-analysis-progress",
    now: "2026-08-19T00:00:00.000Z"
  });
  const taskIds = listWorkflowJobTasks(db, {
    workflowRunId: analysisScenario.workflowId
  }).map((task) => task.id);
  db.prepare("UPDATE workflow_job_tasks SET status = 'running' WHERE id = ?").run(taskIds[0]);
  db.prepare(`
    UPDATE workflow_job_tasks
    SET status = 'skipped', last_error_code = 'DETAIL_REQUIRED'
    WHERE id = ?
  `).run(taskIds[1]);
  db.prepare(`
    UPDATE workflow_job_tasks
    SET status = 'failed', last_error_code = 'PRIVATE_FAILURE'
    WHERE id = ?
  `).run(taskIds[2]);
  const analyzing = getWorkflowProgressSnapshot(db, {
    workflowRunId: analysisScenario.workflowId,
    now: "2026-08-19T00:01:00.000Z"
  });
  assert.strictEqual(analyzing.progress.phaseKey, "analysis");
  assert.strictEqual(analyzing.progress.stageIndex, 3);
  assert.strictEqual(analyzing.progress.analysis.terminal, 2);
  assert.deepStrictEqual(analyzing.progress.analysis.tasks, [
    { id: taskIds[0], position: 1, status: "running", lastErrorCode: null, resolvedAfterFailure: false },
    { id: taskIds[1], position: 2, status: "skipped", lastErrorCode: "DETAIL_REQUIRED", resolvedAfterFailure: false },
    { id: taskIds[2], position: 3, status: "failed", lastErrorCode: null, resolvedAfterFailure: false }
  ]);
  assert(!JSON.stringify(analyzing.progress.analysis.tasks).includes("Private Company"));
  assert(!JSON.stringify(analyzing.progress.analysis.tasks).includes("Private Job Title"));
  const displayRows = listWorkflowProgressJobs(db, analysisScenario.workflowId);
  assert.deepStrictEqual(displayRows.map((row) => Object.keys(row).sort()), Array.from(
    { length: 3 },
    () => ["company", "lastErrorCode", "position", "resolvedAfterFailure", "status", "taskId", "title"]
  ));
  assert(displayRows.every((row) => row.title === "Private Job Title" && row.company === "Private Company"));

  transitionWorkflowRun(db, { id: analysisScenario.workflowId, status: "review_required" });
  const review = getWorkflowProgressSnapshot(db, {
    workflowRunId: analysisScenario.workflowId,
    now: "2026-08-19T00:02:00.000Z"
  });
  assert.strictEqual(review.progress.phaseKey, "review");
  assert.strictEqual(review.progress.stageIndex, 4);
}

function testFailedTaskResolutionUsesLatestPlanObservation() {
  const scenario = seedWorkflow(db, {
    analyses: [{}, {}],
    localDay: "2026-08-24",
    modelConfigRevision: "mrev-resolved-failure"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-resolved-failure",
    now: "2026-08-24T00:00:00.000Z"
  });
  const tasks = listWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId
  });
  db.prepare(`
    UPDATE workflow_job_tasks
    SET status = 'failed', last_error_code = 'MODEL_CALL_FAILED', finished_at = ?
    WHERE workflow_run_id = ?
  `).run("2026-08-24T00:01:00.000Z", scenario.workflowId);

  const resolvedJob = db.prepare(`
    SELECT source, source_id, title, company, location, salary, experience,
      education, url, description
    FROM jobs
    WHERE id = ?
  `).get(tasks[0].jobId);
  const retryBatchId = createBatch(db, "boss", "analysis-retry", "resolved failure smoke", {
    profileId: scenario.profileId,
    searchPlanId: scenario.planId
  });
  upsertJob(db, {
    source: resolvedJob.source,
    sourceId: resolvedJob.source_id,
    title: resolvedJob.title,
    company: resolvedJob.company,
    location: resolvedJob.location,
    salary: resolvedJob.salary,
    experience: resolvedJob.experience,
    education: resolvedJob.education,
    url: resolvedJob.url,
    description: resolvedJob.description,
    qualityTags: [],
    analysis: {
      semanticStatus: "complete",
      decisionStatus: "decided",
      decisionSource: "model",
      recommendation: "apply"
    }
  }, retryBatchId);

  const snapshot = getWorkflowProgressSnapshot(db, {
    workflowRunId: scenario.workflowId,
    now: "2026-08-24T00:02:00.000Z"
  });
  assert.strictEqual(snapshot.progress.analysis.failed, 2);
  assert.strictEqual(snapshot.progress.analysis.historicalFailed, 2);
  assert.strictEqual(snapshot.progress.analysis.resolvedAfterFailure, 1);
  assert.strictEqual(snapshot.progress.analysis.unresolvedFailed, 1);
  assert.deepStrictEqual(
    snapshot.progress.analysis.tasks.map((task) => task.resolvedAfterFailure),
    [true, false]
  );

  const displayRows = listWorkflowProgressJobs(db, scenario.workflowId);
  assert.deepStrictEqual(
    displayRows.map((row) => row.resolvedAfterFailure),
    [true, false]
  );
  assert(!JSON.stringify(displayRows).includes("analysis_json"));
  assert(!JSON.stringify(displayRows).includes("MODEL_CALL_FAILED"));
}

function testCommunicationProgressSeparatesAmbiguity() {
  const scenario = seedWorkflow(db, {
    analyses: [{}, {}],
    localDay: "2026-08-17",
    modelConfigRevision: "mrev-communication-breakdown"
  });
  transitionWorkflowRun(db, { id: scenario.workflowId, status: "review_required" });
  const now = "2026-08-17T00:00:00.000Z";
  const batchId = Number(db.prepare(`INSERT INTO communication_batches(
      site, profile_id, plan_id, browser_mode, status, policy_json,
      confirmed_at, created_at, updated_at
    ) VALUES ('boss', ?, ?, 'edge', 'running', '{}', ?, ?, ?)`)
    .run(scenario.profileId, scenario.planId, now, now, now).lastInsertRowid);
  const jobs = observationEntries(db, scenario.batchId);
  const insert = db.prepare(`INSERT INTO communication_batch_items(
      batch_id, job_id, position, job_url, title_snapshot, company_snapshot,
      status, finished_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run(
    batchId,
    jobs[0].jobId,
    1,
    "https://www.zhipin.com/job_detail/communication-progress-1.html",
    "Ambiguous role",
    "Example One",
    "ambiguous",
    now,
    now
  );
  insert.run(
    batchId,
    jobs[1].jobId,
    2,
    "https://www.zhipin.com/job_detail/communication-progress-2.html",
    "Pending role",
    "Example Two",
    "pending",
    null,
    now
  );
  attachWorkflowCommunication(db, {
    id: scenario.workflowId,
    communicationBatchId: batchId
  });
  transitionWorkflowRun(db, { id: scenario.workflowId, status: "communicating" });

  const snapshot = getWorkflowProgressSnapshot(db, {
    workflowRunId: scenario.workflowId,
    now
  });
  assert.deepStrictEqual(snapshot.progress.communication, {
    total: 2,
    pending: 1,
    ambiguous: 1,
    succeeded: 0,
    stopped: 0,
    terminal: 1
  });
  assert.deepStrictEqual(snapshot.progress.tracks.communication, {
    value: 1,
    max: 2,
    indeterminate: false
  });
  assert.match(snapshot.progress.remainingWorkLabel, /1 个岗位未执行/);
  assert.match(snapshot.progress.remainingWorkLabel, /1 个结果待人工确认/);
}

function testStageMapping() {
  const labels = {
    1: "准备本轮",
    2: "采集岗位与完整 JD",
    3: "分析岗位",
    4: "确认清单与执行沟通"
  };
  const statuses = [
    ["created", 1],
    ["scanning", 2],
    ["analyzing", 3],
    ["review_required", 4],
    ["communicating", 4],
    ["completed", 4],
    ["failed", 4],
    ["stopped", 4]
  ];
  for (const [status, index] of statuses) {
    const scenario = seedWorkflow(db, {
      analyses: [{}],
      localDay: "2026-08-09",
      modelConfigRevision: `mrev-stage-${status}`,
      keepCreated: ["created", "scanning"].includes(status)
    });
    if (status === "scanning") transitionWorkflowRun(db, { id: scenario.workflowId, status: "scanning" });
    if (status === "review_required") {
      transitionWorkflowRun(db, { id: scenario.workflowId, status: "review_required" });
    }
    if (status === "communicating") {
      transitionWorkflowRun(db, { id: scenario.workflowId, status: "review_required" });
      transitionWorkflowRun(db, { id: scenario.workflowId, status: "communicating" });
    }
    if (status === "completed") {
      transitionWorkflowRun(db, { id: scenario.workflowId, status: "review_required" });
      transitionWorkflowRun(db, { id: scenario.workflowId, status: "completed" });
    }
    if (status === "failed") {
      transitionWorkflowRun(db, { id: scenario.workflowId, status: "failed" });
    }
    if (status === "stopped") {
      transitionWorkflowRun(db, { id: scenario.workflowId, status: "stopped" });
    }
    const snapshot = getWorkflowProgressSnapshot(db, { workflowRunId: scenario.workflowId });
    assert.strictEqual(snapshot.progress.stageCount, 4);
    assert.strictEqual(snapshot.progress.stageIndex, index);
    assert.strictEqual(snapshot.progress.stage, labels[index]);
  }

  for (const resumePhase of ["scanning", "analyzing"]) {
    const scenario = seedWorkflow(db, {
      analyses: [{}],
      localDay: "2026-08-10",
      modelConfigRevision: "mrev-stage-paused",
      keepCreated: true
    });
    transitionWorkflowRun(db, { id: scenario.workflowId, status: "scanning" });
    transitionWorkflowRun(db, { id: scenario.workflowId, status: "paused", resumePhase, controlState: "none" });
    const snapshot = getWorkflowProgressSnapshot(db, { workflowRunId: scenario.workflowId });
    assert.strictEqual(snapshot.workflow.status, "paused");
    assert.strictEqual(snapshot.progress.stageIndex, resumePhase === "scanning" ? 2 : 3);
  }

  for (const resumePhase of ["scanning", "analyzing"]) {
    const scenario = seedWorkflow(db, {
      analyses: [{}],
      localDay: "2026-08-10",
      modelConfigRevision: `mrev-stage-interrupted-${resumePhase}`,
      keepCreated: resumePhase === "scanning"
    });
    if (resumePhase === "scanning") {
      transitionWorkflowRun(db, { id: scenario.workflowId, status: "scanning" });
    }
    const interrupted = transitionWorkflowRun(db, {
      id: scenario.workflowId,
      status: "interrupted",
      errorCode: "TEST_INTERRUPTED"
    });
    const snapshot = getWorkflowProgressSnapshot(db, { workflowRunId: scenario.workflowId });
    assert.strictEqual(interrupted.resumePhase, resumePhase);
    assert.strictEqual(snapshot.workflow.status, "interrupted");
    assert.strictEqual(snapshot.progress.stageIndex, resumePhase === "scanning" ? 2 : 3);
  }

  const createdInterrupted = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-10",
    modelConfigRevision: "mrev-stage-interrupted-created",
    keepCreated: true
  });
  transitionWorkflowRun(db, {
    id: createdInterrupted.workflowId,
    status: "interrupted",
    errorCode: "WORKFLOW_CHILD_NOT_STARTED"
  });
  assert.strictEqual(
    getWorkflowProgressSnapshot(db, { workflowRunId: createdInterrupted.workflowId }).progress.stageIndex,
    1
  );

  const resumedThenCommunicationInterrupted = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-10",
    modelConfigRevision: "mrev-stage-interrupted-cleared",
    keepCreated: true
  });
  transitionWorkflowRun(db, { id: resumedThenCommunicationInterrupted.workflowId, status: "scanning" });
  const firstInterruption = transitionWorkflowRun(db, {
    id: resumedThenCommunicationInterrupted.workflowId,
    status: "interrupted",
    errorCode: "SCAN_INTERRUPTED"
  });
  assert.strictEqual(firstInterruption.resumePhase, "scanning");
  const resumed = transitionWorkflowRun(db, {
    id: resumedThenCommunicationInterrupted.workflowId,
    status: "scanning"
  });
  assert.strictEqual(resumed.resumePhase, null);
  transitionWorkflowRun(db, { id: resumedThenCommunicationInterrupted.workflowId, status: "analyzing" });
  transitionWorkflowRun(db, { id: resumedThenCommunicationInterrupted.workflowId, status: "review_required" });
  transitionWorkflowRun(db, { id: resumedThenCommunicationInterrupted.workflowId, status: "communicating" });
  const secondInterruption = transitionWorkflowRun(db, {
    id: resumedThenCommunicationInterrupted.workflowId,
    status: "interrupted",
    errorCode: "COMMUNICATION_INTERRUPTED"
  });
  assert.strictEqual(secondInterruption.resumePhase, null);
  assert.strictEqual(
    getWorkflowProgressSnapshot(db, {
      workflowRunId: resumedThenCommunicationInterrupted.workflowId
    }).progress.stageIndex,
    4
  );
}

function testModelIdentityFromPlannerSnapshot() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-11",
    modelConfigRevision: "snapshot-batch-revision",
    planner: {
      modelProfiles: {
        batch_screening: {
          revision: "snapshot-batch-revision",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          thinkingMode: "disabled",
          reasoningEffort: "high",
          timeoutMs: 90000,
          concurrency: 2
        },
        batch_backup: {
          revision: "backup-rev",
          provider: "deepseek",
          model: "deepseek-v4-pro"
        }
      }
    }
  });
  const snapshot = getWorkflowProgressSnapshot(db, { workflowRunId: scenario.workflowId });
  assert.deepStrictEqual(snapshot.model, {
    profile: "batch_screening",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    revision: "snapshot-batch-revision",
    backupEnabled: true,
    backupActiveForCurrentAttempt: false
  });
}

function testModelIdentityFallbackNeverReadsGlobalDefaults() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-12",
    modelConfigRevision: "mrev-fallback"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-fallback",
    now: "2026-08-12T00:00:00.000Z"
  });
  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-fallback",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-12T00:00:00.000Z"
  });
  assert(claimed);
  const snapshot = getWorkflowProgressSnapshot(db, { workflowRunId: scenario.workflowId });
  assert.strictEqual(snapshot.model.provider, "deepseek");
  assert.strictEqual(snapshot.model.model, "deepseek-v4-flash");
  assert.strictEqual(snapshot.model.revision, "mrev-fallback");
  assert.strictEqual(snapshot.model.backupEnabled, false);
}

function testRecentActivityCapAndWhitelist() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-13",
    modelConfigRevision: "mrev-activity"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-activity",
    now: "2026-08-13T00:00:00.000Z"
  });
  const taskId = Number(db.prepare(
    "SELECT id FROM workflow_job_tasks WHERE workflow_run_id = ? LIMIT 1"
  ).get(scenario.workflowId).id);
  const jobId = Number(db.prepare(
    "SELECT job_id FROM workflow_job_tasks WHERE workflow_run_id = ? LIMIT 1"
  ).get(scenario.workflowId).job_id);
  for (let index = 0; index < 25; index += 1) {
    const base = 10_000 + index * 1_000;
    insertAttemptRow(db, {
      workflowRunId: scenario.workflowId,
      taskId,
      jobId,
      recoveryGeneration: index + 1,
      attemptInGeneration: 1,
      totalAttemptNumber: index + 1,
      modelConfigRevision: "mrev-activity",
      status: index % 2 === 0 ? "succeeded" : "failed",
      modelCallCount: 1,
      errorCode: index % 2 === 0 ? null : "MODEL_TIMEOUT",
      startedAt: iso(base),
      finishedAt: iso(base + 500)
    });
  }
  const small = getWorkflowProgressSnapshot(db, {
    workflowRunId: scenario.workflowId,
    recentActivityLimit: 8,
    now: "2026-08-13T00:01:00.000Z"
  });
  assert.strictEqual(small.recentActivity.length, 8);
  const large = getWorkflowProgressSnapshot(db, {
    workflowRunId: scenario.workflowId,
    recentActivityLimit: 100,
    now: "2026-08-13T00:01:00.000Z"
  });
  assert.strictEqual(large.recentActivity.length, 20);
  const newest = large.recentActivity[0];
  assert.deepStrictEqual(
    Object.keys(newest).sort(),
    ["at", "attempt", "errorCode", "modelRole", "taskId", "type"]
  );
  assert.strictEqual(newest.taskId, taskId);
  assert.strictEqual(newest.type, "analysis_succeeded");
  assert.strictEqual(newest.modelRole, "primary");
  assert.strictEqual(newest.errorCode, null);
  assert.strictEqual(large.recentActivity[1].type, "analysis_failed");
  assert.strictEqual(large.recentActivity[1].errorCode, "MODEL_TIMEOUT");
  assert(large.recentActivity[1].at < large.recentActivity[0].at);
}

function testRecentActivityNeverLeaksJobContent() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-14",
    modelConfigRevision: "mrev-redact",
    titleOverride: "Confidential Job Title 42",
    companyOverride: "Confidential Company 42"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-redact",
    now: "2026-08-14T00:00:00.000Z"
  });
  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-redact",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-14T00:00:00.000Z"
  });
  commitWorkflowJobTaskSuccess(db, {
    taskId: claimed.task.id,
    leaseOwner: "worker-redact",
    analyzedJob: {
      ...claimed.job,
      analysis: { semanticStatus: "complete", decisionSource: "model", summary: "private model summary" }
    },
    modelIdentity: modelIdentity({ attemptInGeneration: 1, totalAttemptNumber: 1 }),
    telemetry: { modelCallCount: 1 },
    startedAt: "2026-08-14T00:00:00.000Z",
    finishedAt: "2026-08-14T00:00:03.000Z"
  });
  const snapshot = getWorkflowProgressSnapshot(db, { workflowRunId: scenario.workflowId });
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    "Confidential Job Title 42",
    "Confidential Company 42",
    "apiKey",
    "api_key",
    "resume",
    "prompt",
    "private model summary"
  ]) {
    assert(!serialized.includes(forbidden), `snapshot leaked forbidden token: ${forbidden}`);
  }
  assert.strictEqual(snapshot.recentActivity.length, 1);
  assert.strictEqual(snapshot.recentActivity[0].type, "analysis_succeeded");
  assert.strictEqual(snapshot.recentActivity[0].taskId, claimed.task.id);
  assert.strictEqual(snapshot.recentActivity[0].attempt, 1);
  assert.strictEqual(snapshot.recentActivity[0].modelRole, "primary");
}

function testWaitingForUnexpiredLeaseDuringControlledStop() {
  const scenario = seedWorkflow(db, {
    analyses: [{}],
    localDay: "2026-08-15",
    modelConfigRevision: "mrev-waiting"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-waiting",
    now: "2026-08-15T00:00:00.000Z"
  });
  const claimed = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-waiting",
    leaseTtlMs: 180_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-15T00:00:00.000Z"
  });
  assert(claimed);
  db.prepare(`
    UPDATE workflow_runs SET
      control_state = 'stop_requested',
      progress_revision = progress_revision + 1,
      last_activity_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run("2026-08-15T00:00:01.000Z", "2026-08-15T00:00:01.000Z", scenario.workflowId);
  const snapshot = getWorkflowProgressSnapshot(db, {
    workflowRunId: scenario.workflowId,
    now: "2026-08-15T00:00:30.000Z"
  });
  assert(snapshot.recentActivity.some((entry) =>
    entry.type === "waiting_lease_expiry"
    && entry.taskId === claimed.task.id
    && entry.errorCode === "WAITING_LEASE_EXPIRY"
  ));
  assert.strictEqual(snapshot.progress.eta.status, "paused");
  assert.strictEqual(snapshot.controls.canStop, false);
  assert.strictEqual(snapshot.workflow.controlState, "stop_requested");
}

function testEtaEstimatingWithFewerThanThreeSamples() {
  for (const sampleCount of [0, 1, 2]) {
    const attempts = Array.from({ length: sampleCount }, (_, index) => attemptSample({
      taskId: index + 1,
      finishedAt: iso(1_000 + index * 1_000)
    }));
    const eta = estimateWorkflowAnalysisEta({
      tasks: [{ status: "pending" }],
      attempts,
      now: iso(60_000),
      status: "analyzing",
      modelConfigRevision: "rev",
      concurrency: 1
    });
    assert.strictEqual(eta.status, "estimating");
    assert.strictEqual(eta.minSeconds, null);
    assert.strictEqual(eta.maxSeconds, null);
    assert.strictEqual(eta.sampleSize, sampleCount);
  }
}

function testEtaAvailableWithThreeSamples() {
  const eta = estimateWorkflowAnalysisEta({
    tasks: [{ status: "pending" }, { status: "pending" }, { status: "pending" }, { status: "pending" }],
    attempts: [1, 2, 3].map((index) => attemptSample({
      taskId: index,
      finishedAt: iso(index * 1_000)
    })),
    now: iso(60_000),
    status: "analyzing",
    modelConfigRevision: "rev",
    concurrency: 1
  });
  assert.strictEqual(eta.status, "available");
  assert.strictEqual(eta.sampleSize, 3);
  assert.strictEqual(eta.minSeconds, 4);
  assert.strictEqual(eta.maxSeconds, 4);
}

function testEtaUsesOnlyNewestTenCurrentRevisionSamples() {
  const current = [];
  for (let index = 0; index < 12; index += 1) {
    current.push(attemptSample({
      taskId: index + 1,
      finishedAt: iso((index + 1) * 1_000),
      modelConfigRevision: "rev-current"
    }));
  }
  const stale = [100, 101, 102].map((offset) => attemptSample({
    taskId: 100 + offset,
    finishedAt: iso(offset * 10_000),
    modelConfigRevision: "rev-old"
  }));
  const eta = estimateWorkflowAnalysisEta({
    tasks: [{ status: "pending" }],
    attempts: [...current, ...stale],
    now: iso(120_000),
    status: "analyzing",
    modelConfigRevision: "rev-current",
    concurrency: 1
  });
  assert.strictEqual(eta.status, "available");
  assert.strictEqual(eta.sampleSize, 10);
  assert.strictEqual(eta.minSeconds, 1);
  assert.strictEqual(eta.maxSeconds, 1);

  const mixed = estimateWorkflowAnalysisEta({
    tasks: [{ status: "pending" }],
    attempts: [
      attemptSample({ taskId: 1, finishedAt: iso(1_000), modelConfigRevision: "rev-new" }),
      attemptSample({ taskId: 2, finishedAt: iso(2_000), modelConfigRevision: "rev-new" }),
      attemptSample({ taskId: 3, finishedAt: iso(3_000), modelConfigRevision: "rev-new" }),
      attemptSample({ taskId: 90, finishedAt: iso(90_000), modelConfigRevision: "rev-old" }),
      attemptSample({ taskId: 91, finishedAt: iso(95_000), modelConfigRevision: "rev-old" }),
      attemptSample({ taskId: 92, finishedAt: iso(100_000), modelConfigRevision: "rev-old" })
    ],
    now: iso(120_000),
    status: "analyzing",
    modelConfigRevision: "rev-new",
    concurrency: 1
  });
  assert.strictEqual(mixed.sampleSize, 3);
  assert.strictEqual(mixed.minSeconds, 1);
  assert.strictEqual(mixed.maxSeconds, 1);
}

function testEtaExcludesSkippedPseudoAttempts() {
  const attempts = [
    attemptSample({ taskId: 1, finishedAt: iso(1_000), modelCallCount: 0 }),
    attemptSample({ taskId: 2, finishedAt: iso(2_000), modelCallCount: 0 }),
    attemptSample({ taskId: 3, finishedAt: iso(3_000), modelCallCount: 1 })
  ];
  const eta = estimateWorkflowAnalysisEta({
    tasks: [{ status: "pending" }],
    attempts,
    now: iso(60_000),
    status: "analyzing",
    modelConfigRevision: "rev",
    concurrency: 1
  });
  assert.strictEqual(eta.status, "estimating");
  assert.strictEqual(eta.sampleSize, 1);
  assert.strictEqual(eta.minSeconds, null);
}

function testEtaDeduplicatesPerTask() {
  const attempts = [
    attemptSample({ taskId: 1, finishedAt: iso(500), status: "failed" }),
    attemptSample({ taskId: 1, finishedAt: iso(1_000), status: "succeeded" }),
    attemptSample({ taskId: 2, finishedAt: iso(2_000) }),
    attemptSample({ taskId: 3, finishedAt: iso(3_000) })
  ];
  const eta = estimateWorkflowAnalysisEta({
    tasks: [{ status: "pending" }],
    attempts,
    now: iso(60_000),
    status: "analyzing",
    modelConfigRevision: "rev",
    concurrency: 1
  });
  assert.strictEqual(eta.sampleSize, 3);
  assert.strictEqual(eta.status, "available");
  assert.strictEqual(eta.minSeconds, 1);
}

function testEtaRetryPendingWidensOnlyUpperBound() {
  const eta = estimateWorkflowAnalysisEta({
    tasks: [
      { status: "pending" },
      { status: "pending" },
      { status: "pending" },
      { status: "retry_pending" },
      { status: "running" }
    ],
    attempts: [1, 2, 3].map((index) => attemptSample({
      taskId: index,
      finishedAt: iso(index * 1_000)
    })),
    now: iso(60_000),
    status: "analyzing",
    modelConfigRevision: "rev",
    concurrency: 1
  });
  assert.strictEqual(eta.status, "available");
  assert.strictEqual(eta.minSeconds, 5);
  assert.strictEqual(eta.maxSeconds, 7);
  assert(eta.minSeconds < eta.maxSeconds);
}

function testEtaPausedFreezesBounds() {
  const args = {
    tasks: [{ status: "pending" }, { status: "pending" }, { status: "pending" }, { status: "pending" }],
    attempts: [1, 2, 3].map((index) => attemptSample({
      taskId: index,
      finishedAt: iso(index * 1_000)
    })),
    status: "paused",
    modelConfigRevision: "rev",
    concurrency: 1
  };
  const first = estimateWorkflowAnalysisEta({ ...args, now: iso(60_000) });
  const later = estimateWorkflowAnalysisEta({ ...args, now: iso(600_000) });
  assert.strictEqual(first.status, "paused");
  assert.strictEqual(later.status, "paused");
  assert.deepStrictEqual(
    [first.minSeconds, first.maxSeconds, first.sampleSize],
    [later.minSeconds, later.maxSeconds, later.sampleSize]
  );
  assert.strictEqual(first.minSeconds, 4);
}

function testEtaNotApplicableOutsideAnalysis() {
  for (const status of ["created", "scanning", "review_required", "communicating", "completed", "failed", "stopped", "interrupted"]) {
    const eta = estimateWorkflowAnalysisEta({
      tasks: [{ status: "pending" }],
      attempts: [1, 2, 3].map((index) => attemptSample({
        taskId: index,
        finishedAt: iso(index * 1_000)
      })),
      now: iso(60_000),
      status,
      modelConfigRevision: "rev",
      concurrency: 1
    });
    assert.strictEqual(eta.status, "not_applicable");
    assert.strictEqual(eta.minSeconds, null);
    assert.strictEqual(eta.maxSeconds, null);
  }
}

function testEtaBoundsAreNonNegativeIntegers() {
  for (let round = 0; round < 5; round += 1) {
    const attempts = [1, 2, 3, 4, 5].map((index) => attemptSample({
      taskId: index,
      finishedAt: iso(index * 777 + round * 13)
    }));
    const eta = estimateWorkflowAnalysisEta({
      tasks: [
        { status: "pending" },
        { status: "retry_pending" },
        { status: "running" },
        { status: "pending" }
      ],
      attempts,
      now: iso(60_000),
      status: "analyzing",
      modelConfigRevision: "rev",
      concurrency: 2
    });
    assert.strictEqual(eta.status, "available");
    assert(Number.isInteger(eta.minSeconds));
    assert(Number.isInteger(eta.maxSeconds));
    assert(eta.minSeconds >= 0);
    assert(eta.maxSeconds >= 0);
    assert(eta.minSeconds <= eta.maxSeconds);
  }
}

function testLeaseRecoveryBumpsRevisionOncePerBatch() {
  const scenario = seedWorkflow(db, {
    analyses: [{}, {}, {}],
    localDay: "2026-08-16",
    modelConfigRevision: "mrev-recovery-bump"
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    batchId: scenario.batchId,
    jobs: observationEntries(db, scenario.batchId),
    modelConfigRevision: "mrev-recovery-bump",
    now: "2026-08-16T00:00:00.000Z"
  });
  const first = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-bump-a",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-16T00:00:00.000Z"
  });
  const second = claimWorkflowJobTask(db, {
    workflowRunId: scenario.workflowId,
    leaseOwner: "worker-bump-b",
    leaseTtlMs: 60_000,
    selectModelIdentity: modelIdentity,
    now: "2026-08-16T00:00:00.000Z"
  });
  assert(first);
  assert(second);
  const before = workflowProgress(db, scenario.workflowId);
  const result = recoverExpiredWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    now: "2026-08-16T00:02:00.000Z"
  });
  assert.strictEqual(result.recovered + result.failed, 2);
  const after = workflowProgress(db, scenario.workflowId);
  assert.strictEqual(after.progress_revision, before.progress_revision + 1);
  assert.strictEqual(after.last_activity_at, "2026-08-16T00:02:00.000Z");

  const noop = recoverExpiredWorkflowJobTasks(db, {
    workflowRunId: scenario.workflowId,
    now: "2026-08-16T00:02:30.000Z"
  });
  assert.deepStrictEqual(noop, { recovered: 0, failed: 0 });
  const unchanged = workflowProgress(db, scenario.workflowId);
  assert.strictEqual(unchanged.progress_revision, after.progress_revision);
  assert.strictEqual(unchanged.last_activity_at, after.last_activity_at);
}

function workflowProgress(database, workflowRunId) {
  return database.prepare(
    "SELECT progress_revision, last_activity_at FROM workflow_runs WHERE id = ?"
  ).get(workflowRunId);
}

function attemptSample({
  taskId,
  finishedAt,
  status = "succeeded",
  modelConfigRevision = "rev",
  modelCallCount = 1
}) {
  return {
    taskId,
    status,
    modelConfigRevision,
    modelCallCount,
    finishedAt
  };
}

function insertAttemptRow(database, input) {
  database.prepare(`
    INSERT INTO job_analysis_attempts(
      workflow_run_id, task_id, job_id, recovery_generation, attempt_in_generation,
      total_attempt_number, profile_kind, model_config_revision, provider, model,
      thinking_mode, reasoning_effort, backup_used, status, error_code, retryable, model_call_count,
      prompt_tokens, completion_tokens, total_tokens, started_at, finished_at,
      latency_ms, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'batch_screening', ?, 'deepseek', 'deepseek-v4-flash',
      'disabled', 'high', 0, ?, ?, 0, ?, 0, 0, 0, ?, ?, ?, ?, ?)
  `).run(
    input.workflowRunId,
    input.taskId,
    input.jobId || 0,
    input.recoveryGeneration,
    input.attemptInGeneration,
    input.totalAttemptNumber,
    input.modelConfigRevision,
    input.status,
    input.errorCode || null,
    input.modelCallCount,
    input.startedAt,
    input.finishedAt,
    Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.startedAt)),
    input.startedAt,
    input.startedAt
  );
}

function iso(ms) {
  return new Date(ms).toISOString();
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

function seedWorkflow(database, {
  analyses,
  localDay,
  modelConfigRevision,
  planner = {},
  descriptions = [],
  titleOverride = "",
  companyOverride = "",
  keepCreated = false
}) {
  const now = new Date().toISOString();
  const profileId = Number(database.prepare(`
    INSERT INTO candidate_profiles(
      display_name, profile_json, source_hash, created_at, updated_at
    ) VALUES ('Workflow Progress Candidate', '{}', NULL, ?, ?)
  `).run(now, now).lastInsertRowid);
  const planId = Number(database.prepare(`
    INSERT INTO search_plans(
      profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
    ) VALUES (?, 'Workflow Progress Plan', '{}', NULL, 1, ?, ?)
  `).run(profileId, now, now).lastInsertRowid);
  const batchId = createBatch(database, "boss", "RAG", "workflow progress smoke", {
    profileId,
    searchPlanId: planId
  });
  analyses.forEach((analysis, index) => {
    upsertJob(database, {
      source: "boss",
      sourceId: `${localDay}-progress-job-${index + 1}`,
      title: titleOverride || `Progress Job ${index + 1}`,
      company: companyOverride || `Progress Co ${index + 1}`,
      url: `https://www.zhipin.com/job_detail/${localDay}-progress-job-${index + 1}.html`,
      description: descriptions[index] === undefined
        ? "Complete JD evidence for workflow progress smoke. ".repeat(4)
        : descriptions[index],
      qualityTags: [],
      analysis
    }, batchId);
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
    planner,
    modelConfigRevision
  }).id;
  const scanRun = createScanRun(database, {
    runId: `scan-${localDay}-${profileId}`,
    planId,
    batchId
  });
  if (!keepCreated) {
    transitionWorkflowRun(database, { id: workflowId, status: "scanning" });
    attachWorkflowScan(database, {
      id: workflowId,
      scanRunId: scanRun.id,
      scanBatchId: batchId
    });
    transitionWorkflowRun(database, { id: workflowId, status: "analyzing" });
  }
  return { workflowId, batchId, profileId, planId, scanRunId: scanRun.id };
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
