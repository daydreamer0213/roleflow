const assert = require("node:assert/strict");
const {
  openDb,
  createBatch,
  createScanRun,
  finishScanRun,
  createWorkflowRun,
  getWorkflowRun,
  listWorkflowRuns,
  getActiveWorkflowRun,
  transitionWorkflowRun,
  attachWorkflowScan,
  replaceWorkflowScanContext,
  attachWorkflowCommunication,
  acquireSiteScanLease,
  releaseSiteScanLease
} = require("../src/core/storage");

const db = openDb(":memory:");

try {
  const { profileId, planId } = seedPlan(db);
  const first = createWorkflowRun(db, input({ profileId, planId, localDay: "2026-07-20", sequence: 1 }));
  assert.strictEqual(first.status, "created");
  assert.strictEqual(first.targetSuccessCount, 35);
  assert.deepStrictEqual(first.keywords, [{ word: "RAG", priority: "A" }]);
  assert.deepStrictEqual(first.budget, { maxDetailTotal: 120, browserPageBudget: 20 });
  assert.strictEqual(getWorkflowRun(db, first.id).id, first.id);
  assert.strictEqual(getActiveWorkflowRun(db, { profileId, planId, localDay: "2026-07-20" }).id, first.id);
  assert.deepStrictEqual(listWorkflowRuns(db, { profileId, localDay: "2026-07-20" }).map((run) => run.id), [first.id]);

  assert.throws(
    () => transitionWorkflowRun(db, { id: first.id, status: "communicating" }),
    (error) => error.code === "WORKFLOW_TRANSITION_INVALID"
  );
  assert.strictEqual(transitionWorkflowRun(db, { id: first.id, status: "scanning" }).status, "scanning");

  const batchId = createBatch(db, "boss", "RAG", "workflow storage", { profileId, searchPlanId: planId });
  const scanRun = createScanRun(db, { runId: "workflow-scan-1", planId, batchId });
  const withScan = attachWorkflowScan(db, { id: first.id, scanRunId: scanRun.id, scanBatchId: batchId });
  assert.strictEqual(withScan.scanRunId, scanRun.id);
  assert.strictEqual(withScan.scanBatchId, batchId);
  assert.strictEqual(
    attachWorkflowScan(db, { id: first.id, scanRunId: scanRun.id, scanBatchId: batchId }).scanRunId,
    scanRun.id
  );
  const competingWorkflow = createWorkflowRun(db, input({
    profileId,
    planId,
    localDay: "2026-07-19",
    sequence: 1
  }));
  transitionWorkflowRun(db, { id: competingWorkflow.id, status: "scanning" });
  assert.throws(
    () => attachWorkflowScan(db, {
      id: competingWorkflow.id,
      scanRunId: scanRun.id,
      scanBatchId: batchId
    }),
    (error) => error.code === "WORKFLOW_SCAN_EXECUTION_OWNED"
  );
  transitionWorkflowRun(db, { id: competingWorkflow.id, status: "stopped" });
  assert.throws(
    () => attachWorkflowScan(db, { id: first.id, scanRunId: "different-scan", scanBatchId: batchId }),
    (error) => error.code === "WORKFLOW_SCAN_LINK_MISMATCH"
  );

  transitionWorkflowRun(db, { id: first.id, status: "analyzing", metrics: { cards: 50, details: 40 } });
  const review = transitionWorkflowRun(db, {
    id: first.id,
    status: "review_required",
    inventoryCount: 31,
    metrics: { cards: 50, details: 40, eligible: 31 }
  });
  assert.strictEqual(review.inventoryCount, 31);
  assert.strictEqual(review.metrics.eligible, 31);
  assert(review.reviewReadyAt);

  const communicationBatchId = seedCommunicationBatch(db, { profileId, planId });
  assert.strictEqual(
    attachWorkflowCommunication(db, { id: first.id, communicationBatchId }).communicationBatchId,
    communicationBatchId
  );
  transitionWorkflowRun(db, { id: first.id, status: "communicating" });
  const completed = transitionWorkflowRun(db, {
    id: first.id,
    status: "completed",
    successfulCount: 30,
    shortfallCode: "WORKFLOW_SUPPLY_EXHAUSTED"
  });
  assert.strictEqual(completed.successfulCount, 30);
  assert.strictEqual(completed.shortfallCode, "WORKFLOW_SUPPLY_EXHAUSTED");
  assert(completed.finishedAt);
  assert.strictEqual(getActiveWorkflowRun(db, { profileId, planId, localDay: "2026-07-20" }), null);

  assert.throws(
    () => createWorkflowRun(db, input({ profileId, planId, localDay: "2026-07-20", sequence: 1 })),
    (error) => error.code === "WORKFLOW_RUN_SLOT_EXISTS"
  );
  const second = createWorkflowRun(db, input({
    profileId,
    planId,
    localDay: "2026-07-20",
    sequence: 2,
    targetSuccessCount: 40
  }));
  assert.strictEqual(second.sequence, 2);
  const third = createWorkflowRun(db, input({
    profileId,
    planId,
    localDay: "2026-07-20",
    sequence: 3,
    targetSuccessCount: 40
  }));
  assert.strictEqual(third.sequence, 3);
  assert.throws(
    () => createWorkflowRun(db, input({ profileId, planId, localDay: "2026-07-20", sequence: 4 })),
    (error) => error.code === "WORKFLOW_SEQUENCE_INVALID"
  );

  transitionWorkflowRun(db, { id: second.id, status: "scanning" });
  transitionWorkflowRun(db, { id: second.id, status: "interrupted", errorCode: "BOSS_LOGIN_REQUIRED", errorMessage: "login expired" });
  const resumed = transitionWorkflowRun(db, { id: second.id, status: "scanning" });
  assert.strictEqual(resumed.status, "scanning");
  assert.strictEqual(resumed.errorCode, "");
  const pausedRun = createWorkflowRun(db, input({
    profileId,
    planId,
    localDay: "2026-07-21",
    sequence: 1,
    modelConfigRevision: "durable-revision"
  }));
  transitionWorkflowRun(db, { id: pausedRun.id, status: "scanning" });
  transitionWorkflowRun(db, { id: pausedRun.id, status: "analyzing" });
  const pauseRequested = transitionWorkflowRun(db, {
    id: pausedRun.id,
    status: "analyzing",
    controlState: "pause_requested",
    progressRevision: 7,
    lastActivityAt: "2026-07-21T00:00:05.000Z"
  });
  assert.strictEqual(pauseRequested.controlState, "pause_requested");
  assert.strictEqual(pauseRequested.progressRevision, 7);
  const paused = transitionWorkflowRun(db, {
    id: pausedRun.id,
    status: "paused",
    controlState: "none",
    resumePhase: "analyzing",
    circuitTimeoutJobCount: 10,
    lifetimeTimeoutJobCount: 10
  });
  assert.strictEqual(paused.status, "paused");
  assert.strictEqual(paused.resumePhase, "analyzing");
  assert.strictEqual(paused.circuitTimeoutJobCount, 10);
  assert.strictEqual(paused.lifetimeTimeoutJobCount, 10);
  assert.strictEqual(paused.modelConfigRevision, "durable-revision");
  assert.strictEqual(paused.lastActivityAt, "2026-07-21T00:00:05.000Z");
  assert.strictEqual(getActiveWorkflowRun(db, { profileId, planId, localDay: "2026-07-21" }).id, pausedRun.id);
  const resumedAnalyzing = transitionWorkflowRun(db, {
    id: pausedRun.id,
    status: "analyzing",
    controlState: "none",
    resumePhase: null,
    recoveryGeneration: 1
  });
  assert.strictEqual(resumedAnalyzing.status, "analyzing");
  assert.strictEqual(resumedAnalyzing.recoveryGeneration, 1);
  transitionWorkflowRun(db, { id: pausedRun.id, status: "stopped" });
  assert.strictEqual(
    getActiveWorkflowRun(db, { profileId, planId, localDay: "2026-07-21" }),
    null
  );
  transitionWorkflowRun(db, { id: second.id, status: "stopped" });
  transitionWorkflowRun(db, { id: third.id, status: "stopped" });

  const resumedScanWorkflow = createWorkflowRun(db, input({
    profileId,
    planId,
    localDay: "2026-07-22",
    sequence: 1
  }));
  transitionWorkflowRun(db, { id: resumedScanWorkflow.id, status: "scanning" });
  const resumedBatchId = createBatch(db, "boss", "RAG", "workflow scan resume", { profileId, searchPlanId: planId });
  const oldScan = createScanRun(db, { runId: "workflow-resume-old", planId, batchId: resumedBatchId });
  attachWorkflowScan(db, { id: resumedScanWorkflow.id, scanRunId: oldScan.id, scanBatchId: resumedBatchId });
  finishScanRun(db, { runId: oldScan.id, status: "interrupted", stopCode: "BROWSER_TIMEOUT" });
  transitionWorkflowRun(db, { id: resumedScanWorkflow.id, status: "interrupted", errorCode: "BROWSER_TIMEOUT" });
  transitionWorkflowRun(db, { id: resumedScanWorkflow.id, status: "scanning" });
  const newScan = createScanRun(db, { runId: "workflow-resume-new", planId, batchId: resumedBatchId });
  const rebound = attachWorkflowScan(db, {
    id: resumedScanWorkflow.id,
    scanRunId: newScan.id,
    scanBatchId: resumedBatchId
  });
  assert.strictEqual(rebound.scanRunId, newScan.id);
  assert.strictEqual(rebound.scanBatchId, resumedBatchId);

  const replaceableWorkflow = createWorkflowRun(db, input({
    profileId,
    planId,
    localDay: "2026-07-23",
    sequence: 1,
    planner: {
      acquisitionMode: "inherited",
      searchScope: { key: "boss:1:old-scope" }
    }
  }));
  transitionWorkflowRun(db, { id: replaceableWorkflow.id, status: "scanning" });
  const replaceableBatchId = createBatch(db, "boss", "RAG", "workflow scope replacement", {
    profileId,
    searchPlanId: planId
  });
  const replaceableScan = createScanRun(db, {
    runId: "workflow-replace-old",
    planId,
    batchId: replaceableBatchId
  });
  attachWorkflowScan(db, {
    id: replaceableWorkflow.id,
    scanRunId: replaceableScan.id,
    scanBatchId: replaceableBatchId
  });
  finishScanRun(db, {
    runId: replaceableScan.id,
    status: "interrupted",
    stopCode: "BOSS_SEARCH_SCOPE_CHANGED"
  });
  transitionWorkflowRun(db, {
    id: replaceableWorkflow.id,
    status: "interrupted",
    errorCode: "BOSS_SEARCH_SCOPE_CHANGED"
  });
  const beforeReplacement = getWorkflowRun(db, replaceableWorkflow.id);
  const replacementPlanner = {
    acquisitionMode: "inherited",
    searchScope: { key: "boss:1:new-scope" }
  };
  const replaced = replaceWorkflowScanContext(db, {
    workflowRunId: replaceableWorkflow.id,
    expectedUpdatedAt: beforeReplacement.updatedAt,
    planner: { ...replacementPlanner, selectedKeywords: [{ word: "LLM应用", priority: "A" }] },
    keywords: [{ word: "LLM应用", priority: "A" }],
    replacedAt: "2099-02-02T00:00:00.000Z"
  });
  assert.strictEqual(replaced.id, beforeReplacement.id);
  assert.strictEqual(replaced.localDay, beforeReplacement.localDay);
  assert.strictEqual(replaced.sequence, beforeReplacement.sequence);
  assert.strictEqual(replaced.scanRunId, "");
  assert.strictEqual(replaced.scanBatchId, null);
  assert.strictEqual(replaced.status, "interrupted");
  assert.strictEqual(replaced.resumePhase, "scanning");
  assert.strictEqual(replaced.recoveryGeneration, beforeReplacement.recoveryGeneration + 1);
  assert.deepStrictEqual(replaced.keywords, [{ word: "LLM应用", priority: "A" }]);
  assert.deepStrictEqual(replaced.planner.selectedKeywords, [{ word: "LLM应用", priority: "A" }]);
  assert.strictEqual(replaced.planner.searchScope.key, replacementPlanner.searchScope.key);
  assert.deepStrictEqual(replaced.planner.scopeReplacements.at(-1), {
    replacedAt: "2099-02-02T00:00:00.000Z",
    oldScopeKey: "boss:1:old-scope",
    oldBatchId: replaceableBatchId,
    newScopeKey: "boss:1:new-scope"
  });
  assert(db.prepare("SELECT 1 FROM batches WHERE id = ?").get(replaceableBatchId));
  const afterReplacement = getWorkflowRun(db, replaceableWorkflow.id);
  assert.throws(
    () => replaceWorkflowScanContext(db, {
      workflowRunId: replaceableWorkflow.id,
      expectedUpdatedAt: beforeReplacement.updatedAt,
      planner: replacementPlanner,
      replacedAt: "2099-02-02T00:00:01.000Z"
    }),
    (error) => error.code === "WORKFLOW_SCAN_CONTEXT_STALE"
  );
  assert.deepStrictEqual(getWorkflowRun(db, replaceableWorkflow.id), afterReplacement);

  const activeProcess = seedReplaceableWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-07-24",
    runId: "workflow-replace-active",
    finishScan: false
  });
  assertReplacementRejected(db, activeProcess, replacementPlanner, "WORKFLOW_SCAN_CONTEXT_PROCESS_ACTIVE");

  const activeLease = seedReplaceableWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-07-25",
    runId: "workflow-replace-lease"
  });
  acquireSiteScanLease(db, { site: "boss", owner: "workflow-replace-lease-owner", planId, ttlMs: 600_000 });
  assertReplacementRejected(db, activeLease, replacementPlanner, "WORKFLOW_SCAN_CONTEXT_LEASE_ACTIVE");
  releaseSiteScanLease(db, { site: "boss", owner: "workflow-replace-lease-owner" });

  const wrongPhase = createWorkflowRun(db, input({ profileId, planId, localDay: "2026-07-26", sequence: 1 }));
  transitionWorkflowRun(db, { id: wrongPhase.id, status: "scanning" });
  transitionWorkflowRun(db, { id: wrongPhase.id, status: "analyzing" });
  transitionWorkflowRun(db, { id: wrongPhase.id, status: "interrupted" });
  assertReplacementRejected(db, getWorkflowRun(db, wrongPhase.id), replacementPlanner, "WORKFLOW_SCAN_CONTEXT_STATUS_INVALID");

  const communicationExists = seedReplaceableWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-07-27",
    runId: "workflow-replace-communication"
  });
  attachWorkflowCommunication(db, {
    id: communicationExists.id,
    communicationBatchId: seedCommunicationBatch(db, { profileId, planId })
  });
  assertReplacementRejected(
    db,
    getWorkflowRun(db, communicationExists.id),
    replacementPlanner,
    "WORKFLOW_SCAN_CONTEXT_COMMUNICATION_EXISTS"
  );

  const analysisExists = seedReplaceableWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-07-28",
    runId: "workflow-replace-analysis"
  });
  seedWorkflowAnalysisTask(db, analysisExists);
  assertReplacementRejected(db, analysisExists, replacementPlanner, "WORKFLOW_SCAN_CONTEXT_ANALYSIS_EXISTS");

  const terminal = createWorkflowRun(db, input({ profileId, planId, localDay: "2026-07-29", sequence: 1 }));
  transitionWorkflowRun(db, { id: terminal.id, status: "stopped" });
  assertReplacementRejected(db, getWorkflowRun(db, terminal.id), replacementPlanner, "WORKFLOW_SCAN_CONTEXT_STATUS_INVALID");

  const invalidPlanner = seedReplaceableWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-07-30",
    runId: "workflow-replace-invalid"
  });
  assertReplacementRejected(db, invalidPlanner, { acquisitionMode: "inherited", searchScope: {} }, "WORKFLOW_SCAN_CONTEXT_INVALID");

  console.log("workflow_storage_smoke ok");
} finally {
  db.close();
}

function input(overrides = {}) {
  return {
    profileId: 1,
    planId: 1,
    localDay: "2026-07-20",
    sequence: 1,
    targetSuccessCount: 35,
    inventoryCount: 0,
    candidateGap: 35,
    scanNeeded: true,
    keywords: [{ word: "RAG", priority: "A" }],
    budget: { maxDetailTotal: 120, browserPageBudget: 20 },
    planner: { remainingDailyTarget: 70, remainingRunSlots: 2 },
    ...overrides
  };
}

function seedPlan(database) {
  const now = new Date().toISOString();
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Workflow Candidate', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Workflow Plan', '{}', NULL, 1, ?, ?)`).run(profileId, now, now).lastInsertRowid);
  return { profileId, planId };
}

function seedCommunicationBatch(database, { profileId, planId }) {
  const now = new Date().toISOString();
  return Number(database.prepare(`INSERT INTO communication_batches(
    site, profile_id, plan_id, browser_mode, status, policy_json,
    confirmed_at, created_at, updated_at
  ) VALUES ('boss', ?, ?, 'edge', 'confirmed', '{}', ?, ?, ?)`)
    .run(profileId, planId, now, now, now).lastInsertRowid);
}

function seedReplaceableWorkflow(database, {
  profileId,
  planId,
  localDay,
  runId,
  finishScan = true
}) {
  const workflow = createWorkflowRun(database, input({
    profileId,
    planId,
    localDay,
    sequence: 1,
    planner: { acquisitionMode: "inherited", searchScope: { key: `${runId}-old-scope` } }
  }));
  transitionWorkflowRun(database, { id: workflow.id, status: "scanning" });
  const batchId = createBatch(database, "boss", "RAG", runId, { profileId, searchPlanId: planId });
  const scan = createScanRun(database, { runId, planId, batchId });
  attachWorkflowScan(database, { id: workflow.id, scanRunId: scan.id, scanBatchId: batchId });
  if (finishScan) finishScanRun(database, { runId: scan.id, status: "interrupted", stopCode: "BOSS_SEARCH_SCOPE_CHANGED" });
  transitionWorkflowRun(database, { id: workflow.id, status: "interrupted", errorCode: "BOSS_SEARCH_SCOPE_CHANGED" });
  return getWorkflowRun(database, workflow.id);
}

function seedWorkflowAnalysisTask(database, workflow) {
  const now = "2026-07-28T00:00:00.000Z";
  const jobId = Number(database.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at
  ) VALUES ('boss', ?, 'Analysis gate fixture', ?, ?)`)
    .run(`analysis-gate-${workflow.id}`, now, now).lastInsertRowid);
  const observationId = Number(database.prepare(`INSERT INTO job_observations(
    job_id, batch_id, title, content_hash, seen_at
  ) VALUES (?, ?, 'Analysis gate fixture', ?, ?)`)
    .run(jobId, workflow.scanBatchId, `analysis-hash-${workflow.id}`, now).lastInsertRowid);
  database.prepare(`INSERT INTO workflow_job_tasks(
    workflow_run_id, batch_id, job_id, observation_id, position, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 1, 'pending', ?, ?)`)
    .run(workflow.id, workflow.scanBatchId, jobId, observationId, now, now);
}

function assertReplacementRejected(database, workflow, planner, code) {
  const before = getWorkflowRun(database, workflow.id);
  const scanCount = Number(database.prepare("SELECT COUNT(*) AS count FROM scan_runs").get().count);
  assert.throws(
    () => replaceWorkflowScanContext(database, {
      workflowRunId: workflow.id,
      expectedUpdatedAt: before.updatedAt,
      planner
    }),
    (error) => error.code === code,
    code
  );
  assert.deepStrictEqual(getWorkflowRun(database, workflow.id), before, code);
  assert.strictEqual(
    Number(database.prepare("SELECT COUNT(*) AS count FROM scan_runs").get().count),
    scanCount,
    code
  );
}
