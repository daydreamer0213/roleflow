const assert = require("node:assert/strict");
const {
  openDb,
  createBatch,
  upsertJob,
  createWorkflowRun,
  getWorkflowRun,
  transitionWorkflowRun
} = require("../src/core/storage");
const {
  createCommunicationBatch,
  listCommunicationBatchItems
} = require("../src/core/communication_batches");
const { runCommunicationBatch } = require("../src/core/communication_executor");
const { listWorkflowInventory, listWorkflowReviewCandidates } = require("../src/core/workflow_inventory");

async function workflowCommunicationSmoke() {
  const db = openDb(":memory:");
  try {
    const now = "2026-07-20T08:00:00.000Z";
    const { profileId, planId } = seedPlan(db, now);
    const scanBatchId = createBatch(db, "boss", "workflow-communication", "workflow communication", {
      profileId,
      searchPlanId: planId,
      startedAt: now
    });
    const lowRiskIds = Array.from({ length: 5 }, (_, index) => upsertJob(
      db,
      job(`candidate-${index + 1}`),
      scanBatchId
    ));
    const highSalaryId = upsertJob(db, job("high-salary", {
      salary: "15-25K",
      qualityTags: ["salary_target_high", "experience_salary_overlap"]
    }), scanBatchId);

    const workflow = createWorkflowRun(db, {
      profileId,
      planId,
      localDay: "2026-07-20",
      sequence: 1,
      targetSuccessCount: 3,
      inventoryCount: 5,
      candidateGap: 0,
      scanNeeded: false,
      planner: { replacementBuffer: 2 }
    });
    transitionWorkflowRun(db, { id: workflow.id, status: "review_required", updatedAt: now });

    const review = listWorkflowReviewCandidates(db, workflow.id, { now });
    const selectedIds = review.filter((candidate) => candidate.defaultChecked).map((candidate) => candidate.id);
    assert.deepStrictEqual([...selectedIds].sort((a, b) => a - b), lowRiskIds);
    assert.strictEqual(review.find((candidate) => candidate.id === highSalaryId)?.defaultChecked, false);
    assert.strictEqual(review.find((candidate) => candidate.id === highSalaryId)?.workflowTier, "high_salary_backup");

    const batch = createCommunicationBatch(db, {
      workflowRunId: workflow.id,
      planId,
      jobIds: selectedIds,
      browserMode: "edge",
      now
    });
    assert.strictEqual(getWorkflowRun(db, workflow.id).communicationBatchId, batch.id);
    assert.strictEqual(batch.policySnapshot.targetSuccessCount, 3);
    const confirmedWorkflow = getWorkflowRun(db, workflow.id);
    assert.strictEqual(confirmedWorkflow.metrics.selected, 5);
    assert.strictEqual(confirmedWorkflow.metrics.communication.selected, 5);

    const states = ["ready", "job_unavailable", "ready", "ready"];
    let visits = 0;
    const summary = await runCommunicationBatch({
      db,
      batchId: batch.id,
      executionGate: () => true,
      accessController: { async reserve() { visits += 1; } },
      adapter: {
        async inspectCommunicationJob() { return { state: states.shift() }; },
        async dispatchCommunication() {},
        async verifyCommunicationResult() { return { state: "succeeded" }; }
      },
      sleepFn: async () => {},
      randomFn: () => 0
    });

    assert.strictEqual(visits, 4);
    assert.strictEqual(summary.batchStatus, "completed");
    assert.deepStrictEqual(
      listCommunicationBatchItems(db, batch.id).map((item) => [item.status, item.clickCount]),
      [
        ["succeeded", 1],
        ["job_unavailable", 0],
        ["succeeded", 1],
        ["succeeded", 1],
        ["stopped", 0]
      ]
    );
    assert.deepStrictEqual(selectedIds.map((jobId) => candidateStatus(db, profileId, jobId)), [
      "applied",
      "invalid",
      "applied",
      "applied",
      ""
    ]);
    assert(listWorkflowInventory(db, { planId, now }).some((candidate) => candidate.id === selectedIds[4]));

    const completed = getWorkflowRun(db, workflow.id);
    assert.strictEqual(completed.status, "completed");
    assert.strictEqual(completed.successfulCount, 3);
    assert.strictEqual(completed.shortfallCode, "");
    assert.strictEqual(completed.metrics.selected, 5);
    assert.strictEqual(completed.metrics.succeeded, 3);
    assert.strictEqual(completed.metrics.unavailable, 1);
    assert.strictEqual(completed.metrics.communication.succeeded, 3);
    assert.strictEqual(completed.metrics.communication.unavailable, 1);
    assert(Number.isFinite(completed.metrics.durationMs));
    const auditRows = db.prepare(`SELECT event_type, payload_json FROM events
      WHERE job_id = ? AND event_type IN ('communication_click', 'communication_result')
      ORDER BY id`).all(selectedIds[0]);
    assert.strictEqual(auditRows.length, 2);
    for (const row of auditRows) {
      const payload = JSON.parse(row.payload_json);
      assert.strictEqual(payload.workflowRunId, workflow.id);
      assert.strictEqual(payload.scanRunId, null);
      assert.strictEqual(payload.scanBatchId, null);
      assert.strictEqual(payload.communicationBatchId, batch.id);
    }
  } finally {
    db.close();
  }
}

function seedPlan(db, now) {
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Workflow Candidate', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Workflow Plan', '{}', NULL, 1, ?, ?)`).run(profileId, now, now).lastInsertRowid);
  return { profileId, planId };
}

function job(sourceId, overrides = {}) {
  return {
    source: "boss",
    sourceId,
    keyword: "workflow-communication",
    title: `AI application engineer ${sourceId}`,
    company: `Company ${sourceId}`,
    location: "Guangzhou",
    salary: "10-15K",
    experience: "1-3 years",
    education: "Bachelor",
    bossActiveText: "Active today",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
    tags: ["Python", "RAG"],
    description: "Build and maintain Python RAG applications with retrieval, reranking, APIs, testing, and production diagnostics. ".repeat(3),
    score: 24,
    level: "Recommended",
    matches: ["Python", "RAG"],
    risks: [],
    qualityTags: ["salary_target_core"],
    analysis: {
      provider: "openai_compatible",
      semanticStatus: "complete",
      recommendation: "apply",
      fitLevel: "A",
      confidence: 0.9,
      evidence: { jd: ["Python RAG"], resume: ["Python RAG"] },
      hardBlockers: []
    },
    ...overrides
  };
}

function candidateStatus(db, profileId, jobId) {
  return db.prepare("SELECT status FROM candidate_job_states WHERE profile_id = ? AND job_id = ?")
    .get(profileId, jobId)?.status || "";
}

workflowCommunicationSmoke()
  .then(() => console.log("workflow_communication_smoke ok"))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
