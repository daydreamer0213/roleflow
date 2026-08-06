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
const {
  initializeWorkflowJobTasks,
  claimWorkflowJobTask,
  commitWorkflowJobTaskSuccess,
  listWorkflowJobTasks,
  listJobAnalysisAttempts
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
  await crashExpiredLeaseResumeE2E();
  pausedRecoveryNoBrowserNoChild();
  orphanAnalyzingTaskRecoveryCounts();
  console.log("workflow_recovery_smoke ok");
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

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
    for (let index = 0; index < 3; index += 1) {
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
    assert.strictEqual(initialized.inserted, 3);

    const claims = [];
    for (let index = 0; index < 3; index += 1) {
      claims.push(claimWorkflowJobTask(database, {
        workflowRunId: workflow.id,
        leaseOwner: `crash-worker-${index + 1}`,
        leaseTtlMs: 3 * 60_000,
        selectModelIdentity: () => modelIdentity("crash-rev"),
        now: `${localDay}T01:06:00.000Z`
      }));
    }
    assert.strictEqual(claims.length, 3);
    for (let index = 0; index < 2; index += 1) {
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
    // third task lease expired while its attempt was still running.
    database.prepare("UPDATE scan_runs SET heartbeat_at = ? WHERE id = ?")
      .run(`${localDay}T01:07:00.000Z`, scan.id);
    database.prepare("UPDATE workflow_job_tasks SET lease_expires_at = ? WHERE id = ?")
      .run(`${localDay}T01:06:30.000Z`, claims[2].task.id);

    const report = recoverWorkflowRuns(database, {
      now: new Date(`${localDay}T02:00:00.000Z`),
      orphanTimeoutMs: 60_000
    });
    assert.strictEqual(report.scanRunsInterrupted, 1);
    assert.strictEqual(report.workflowRunsInterrupted, 1);
    assert.strictEqual(report.tasksRecovered, 1);
    assert.strictEqual(report.tasksFailed, 0);
    assert.strictEqual(getWorkflowRun(database, workflow.id).status, "interrupted");
    assert.deepStrictEqual(
      workflowTasks(database, workflow.id).map((task) => task.status),
      ["succeeded", "succeeded", "retry_pending"]
    );
    for (const jobId of [jobIds[0], jobIds[1]]) {
      const observation = database.prepare(
        "SELECT analysis_json FROM job_observations WHERE job_id = ? AND batch_id = ?"
      ).get(jobId, batchId);
      assert.strictEqual(JSON.parse(observation.analysis_json).semanticStatus, "complete");
    }

    const resumed = await runWorkflowAnalysisPhase(database, {
      workflowRun: getWorkflowRun(database, workflow.id),
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
    assert.strictEqual(resumed.claimed, 1);
    assert.strictEqual(resumed.succeeded, 1);
    assert.strictEqual(getWorkflowRun(database, workflow.id).status, "review_required");
    const finalTasks = workflowTasks(database, workflow.id);
    assert.deepStrictEqual(finalTasks.map((task) => task.status), ["succeeded", "succeeded", "succeeded"]);
    const attempts = listJobAnalysisAttempts(database, {
      workflowRunId: workflow.id,
      taskId: finalTasks[2].id
    });
    assert.strictEqual(attempts.length, 2);
    assert.deepStrictEqual(attempts.map((attempt) => attempt.status).sort(), ["failed", "succeeded"]);
  } finally {
    database.close();
  }
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
