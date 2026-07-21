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
  attachWorkflowCommunication
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
