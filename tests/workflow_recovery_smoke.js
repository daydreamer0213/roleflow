const assert = require("node:assert/strict");
const {
  openDb,
  createBatch,
  createScanRun,
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
const { createDashboardServer } = require("../src/dashboard/server");

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

  assert.strictEqual(report.scanRunsInterrupted, 1);
  assert.strictEqual(report.workflowRunsInterrupted, 4);
  assert.strictEqual(report.workflowRunsCompleted, 1);
  assert.strictEqual(report.reviewRunsPreserved, 1);
  assert.strictEqual(report.browserActionsStarted, 0);

  assert.strictEqual(getWorkflowRun(db, freshScan.workflow.id).status, "scanning");
  assert.strictEqual(getWorkflowRun(db, staleScan.workflow.id).status, "interrupted");
  assert.strictEqual(getWorkflowRun(db, staleScan.workflow.id).errorCode, "SCAN_RUN_ORPHANED");
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
  console.log("workflow_recovery_smoke ok");
} finally {
  db.close();
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
