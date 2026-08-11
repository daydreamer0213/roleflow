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
  getCommunicationBatch,
  listCommunicationBatchItems
} = require("../src/core/communication_batches");
const { runCommunicationBatch } = require("../src/core/communication_executor");
const { listWorkflowInventory, listWorkflowReviewCandidates } = require("../src/core/workflow_inventory");
const { getProgressCardForJob } = require("../src/core/candidate_progress");
const { buildWorkflowViewModel } = require("../src/dashboard/view_models/workflow");
const {
  communicate,
  resolveCommunicationBrowserAuthority
} = require("../src/cli");

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
      analysis: completeAnalysis("caution"),
      qualityTags: ["salary_target_high", "experience_salary_overlap"]
    }), scanBatchId);
    const roleCoreBackupId = upsertJob(db, job("role-core-unproven", {
      qualityTags: ["salary_target_core", "experience_salary_overlap"],
      analysis: {
        provider: "openai_compatible",
        semanticStatus: "complete",
        recommendation: "caution",
        recommendationSchemaVersion: 2,
        fitLevel: "insufficient_evidence",
        confidence: 0.45,
        requirementMatches: [{
          requirement: "推理框架与硬件适配",
          state: "unknown",
          central: true,
          indispensable: false,
          jdEvidence: "JD：负责推理框架部署与硬件适配",
          resumeEvidence: ""
        }],
        evidence: { jd: [], resume: [] },
        hardBlockers: []
      }
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
      planner: {
        acquisitionMode: "inherited",
        browserMode: "portable",
        cdpPort: 9222,
        replacementBuffer: 2
      }
    });
    transitionWorkflowRun(db, { id: workflow.id, status: "review_required", updatedAt: now });

    const review = listWorkflowReviewCandidates(db, workflow.id, { now });
    const selectedIds = review.filter((candidate) => candidate.defaultChecked).map((candidate) => candidate.id);
    assert.deepStrictEqual([...selectedIds].sort((a, b) => a - b), lowRiskIds);
    assert.strictEqual(review.find((candidate) => candidate.id === highSalaryId)?.defaultChecked, false);
    assert.strictEqual(review.find((candidate) => candidate.id === highSalaryId)?.workflowTier, "caution");
    assert.strictEqual(review.find((candidate) => candidate.id === roleCoreBackupId)?.defaultChecked, false);
    assert.strictEqual(typeof review.find((candidate) => candidate.id === roleCoreBackupId)?.workflowTier, "string");

    const interruptedCommunication = buildWorkflowViewModel({
      workflow: { id: workflow.id, planId, status: "review_required" },
      plan: { id: planId },
      communication: {
        batch: { id: 91, status: "interrupted" },
        calibration: { executionEnabled: true },
        summary: { total: 2, terminal: 0, statusCounts: { ambiguous: 1, pending: 1 } },
        items: [{ id: 41, status: "ambiguous" }, { id: 42, status: "pending" }]
      }
    }).phase.communication;
    assert.deepStrictEqual(interruptedCommunication, {
      batchId: "91",
      status: "interrupted",
      action: "",
      actionLabel: "",
      executionEnabled: false,
      summary: { total: 2, terminal: 0, statusCounts: { ambiguous: 1, pending: 1 } },
      runtimeBlock: "",
      detailsHref: "/communication?batchId=91#communication-item-41",
      detailsLabel: "处理不明确结果"
    });
    const interruptedWorkflowPhase = buildWorkflowViewModel({
      workflow: {
        id: workflow.id,
        planId,
        status: "interrupted",
        communicationBatchId: 91,
        errorCode: "COMMUNICATION_RESULT_AMBIGUOUS"
      },
      plan: { id: planId },
      communication: {
        batch: { id: 91, status: "interrupted" },
        calibration: { executionEnabled: true },
        summary: { total: 2, terminal: 1, statusCounts: { ambiguous: 1, pending: 1 } },
        items: [{ id: 41, status: "ambiguous" }, { id: 42, status: "pending" }]
      }
    }).phase;
    assert.strictEqual(interruptedWorkflowPhase.kind, "interrupted");
    assert.strictEqual(interruptedWorkflowPhase.communication.detailsLabel, "处理不明确结果");
    assert.strictEqual(interruptedWorkflowPhase.communication.detailsHref, "/communication?batchId=91#communication-item-41");

    assert.throws(
      () => createCommunicationBatch(db, {
        workflowRunId: workflow.id,
        planId,
        jobIds: selectedIds,
        browserMode: "edge"
      }),
      (error) => error.code === "WORKFLOW_COMMUNICATION_BROWSER_MISMATCH"
    );

    for (const cdpPort of [9223, 0, null]) {
      db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
        .run(JSON.stringify({ ...workflow.planner, cdpPort }), workflow.id);
      assert.throws(
        () => createCommunicationBatch(db, {
          workflowRunId: workflow.id,
          planId,
          jobIds: selectedIds,
          browserMode: "portable"
        }),
        (error) => error.code === "WORKFLOW_COMMUNICATION_PORTABLE_CDP_PORT_INVALID"
      );
      assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM communication_batches").get().count), 0);
    }
    db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
      .run(JSON.stringify(workflow.planner), workflow.id);

    const batch = createCommunicationBatch(db, {
      workflowRunId: workflow.id,
      planId,
      jobIds: selectedIds,
      browserMode: "portable",
      now
    });
    assert.strictEqual(getWorkflowRun(db, workflow.id).communicationBatchId, batch.id);
    assert.strictEqual(batch.policySnapshot.targetSuccessCount, 3);
    assert.deepStrictEqual(batch.policySnapshot.browser, { mode: "portable", cdpPort: 9222 });
    const confirmedWorkflow = getWorkflowRun(db, workflow.id);
    assert.strictEqual(confirmedWorkflow.metrics.selected, 5);
    assert.strictEqual(confirmedWorkflow.metrics.communication.selected, 5);

    let browserFactoryCalls = 0;
    await assert.rejects(
      () => communicate(db, {
        batch: batch.id,
        browser: "portable",
        "cdp-port": "9333"
      }, {
        createBrowserFn() {
          browserFactoryCalls += 1;
          throw new Error("browser factory must not be reached");
        }
      }),
      (error) => error.code === "COMMUNICATION_PORTABLE_CDP_PORT_MISMATCH"
    );
    assert.strictEqual(browserFactoryCalls, 0);
    assert.strictEqual(getCommunicationBatch(db, batch.id).status, "confirmed");
    assert.deepStrictEqual(
      listCommunicationBatchItems(db, batch.id).map((item) => item.status),
      selectedIds.map(() => "pending")
    );
    assert.deepStrictEqual(
      resolveCommunicationBrowserAuthority(batch, { browser: "portable", "cdp-port": "9222" }),
      { browser: "portable", "cdp-port": 9222 }
    );
    assert.deepStrictEqual(
      resolveCommunicationBrowserAuthority(batch, { browser: "portable" }),
      { browser: "portable", "cdp-port": 9222 }
    );
    const legacyPolicySnapshot = { ...batch.policySnapshot };
    delete legacyPolicySnapshot.browser;
    assert.deepStrictEqual(
      resolveCommunicationBrowserAuthority({
        ...batch,
        policySnapshot: legacyPolicySnapshot
      }, { browser: "portable" }),
      { browser: "portable", "cdp-port": 9222 }
    );
    assert.throws(
      () => resolveCommunicationBrowserAuthority({
        ...batch,
        policySnapshot: {
          ...batch.policySnapshot,
          browser: { mode: "portable", cdpPort: "9222" }
        }
      }, { browser: "portable" }),
      (error) => error.code === "COMMUNICATION_PORTABLE_BROWSER_POLICY_INVALID"
    );
    assert.throws(
      () => resolveCommunicationBrowserAuthority(batch, {
        browser: "portable",
        "cdp-port": "9222.0"
      }),
      (error) => error.code === "COMMUNICATION_PORTABLE_CDP_PORT_MISMATCH"
    );

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
      "",
      "invalid",
      "",
      "",
      ""
    ]);
    for (const jobId of [selectedIds[0], selectedIds[2], selectedIds[3]]) {
      assert.strictEqual(getProgressCardForJob(db, { profileId, jobId }).stage, "waiting_reply");
    }
    assert.strictEqual(getProgressCardForJob(db, { profileId, jobId: selectedIds[1] }), null);
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
    analysis: completeAnalysis(),
    ...overrides
  };
}

function completeAnalysis(recommendation = "primary") {
  return {
    provider: "openai_compatible",
    semanticStatus: "complete",
    recommendation,
    recommendationSchemaVersion: 2,
    fitLevel: recommendation === "primary" ? "fit" : "mostly_fit",
    confidence: 0.9,
    evidence: { jd: ["Python RAG"], resume: ["Python RAG"] },
    hardBlockers: []
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
