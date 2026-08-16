const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const runtimeWarnings = [];
process.on("warning", (warning) => runtimeWarnings.push(warning));
const {
  openDb,
  saveProfileAnalysis,
  createMatchingCardDraft,
  confirmMatchingCard,
  createBatch,
  upsertJob,
  listDecisionPool,
  listReportJobs,
  markCandidateJob,
  createWorkflowRun,
  getWorkflowRun,
  isJobAwaitingAction
} = require("../src/core/storage");
const { matchingCardFromProfile } = require("../src/core/matching_card");
const { listWorkflowInventory, reconcilePlanWorkflowInventory } = require("../src/core/workflow_inventory");
const { PRODUCT_POLICY } = require("../src/core/product_policy");
const {
  retryOneJobAnalysis,
  retryPendingJobAnalyses
} = require("../src/application/analysis");
const { createDashboardServer } = require("../src/dashboard/server");

const root = path.resolve(__dirname, "..");
const tempDir = path.join(root, ".runtime", `analysis-application-${process.pid}-${Date.now()}`);
const dbPath = path.join(tempDir, "jobs.sqlite");
const db = openDb(dbPath);
const logger = { info() {}, warn() {}, error() {} };
let server;

(async () => {
  try {
    await testDashboardContract();
    await testApplicationBoundary();
    assert(!runtimeWarnings.some((warning) => /circular dependency/i.test(warning.message)), "analysis inventory core ownership must not introduce a circular dependency");
    console.log("analysis_application_smoke ok");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function testApplicationBoundary() {
  const single = seedPlan("single");
  const singleJobId = seedFailedJob(single, "single-complete");
  const workflow = createWorkflowRun(db, {
    id: "analysis-retry-inventory",
    profileId: single.profileId,
    planId: single.planId,
    localDay: chinaLocalDay(),
    sequence: 1,
    inventoryCount: 999
  });
  db.prepare("UPDATE workflow_runs SET status = 'review_required' WHERE id = ?").run(workflow.id);
  assert.strictEqual(reconcilePlanWorkflowInventory(db, single.planId), listWorkflowInventory(db, { planId: single.planId }).length);
  const singleRunner = controlledRunner();
  const one = await retryOneJobAnalysis({
    db,
    input: { planId: single.planId, jobId: singleJobId },
    deps: applicationDeps(singleRunner)
  });
  assert.deepStrictEqual(Object.keys(one).sort(), ["batchId", "completed", "concurrency", "failed", "jobIds", "kind", "planId", "requested", "results", "sourcePending"]);
  assert.strictEqual(one.kind, "one");
  assert.strictEqual(one.concurrency, 1);
  assert.strictEqual(one.completed, 1);
  assert.deepStrictEqual(one.jobIds, [singleJobId]);
  assert.strictEqual(singleRunner.peak, 1, "single retry must not run concurrent analyses");
  assert.strictEqual(batch(db, one.batchId).keyword, "analysis-retry");
  assert.deepStrictEqual(batch(db, one.batchId).filterSnapshot.jobIds, [singleJobId]);
  const retriedSingle = job(db, single.planId, singleJobId);
  assert.strictEqual(retriedSingle.analysis.semanticStatus, "complete");
  assert.deepStrictEqual(retriedSingle.analysis.analysisRevision, { fixture: "single-complete", version: "analysis-retry-smoke" });
  assert.strictEqual(getWorkflowRun(db, workflow.id).inventoryCount, listWorkflowInventory(db, { planId: single.planId }).length);

  const messageContext = seedPlan("message-context");
  const messageJobId = seedFailedJob(messageContext, "message-context-complete");
  const messageRawDescription = "Message discovery detail must remain attached to the exact analyzed observation, including responsibilities, requirements, delivery boundaries, and production quality evidence. ".repeat(2).trim();
  const messageRawBatchId = createBatch(db, "boss", "message-discovery-detail", "message discovery raw detail", {
    profileId: messageContext.profileId,
    searchPlanId: messageContext.planId,
    filterSnapshot: { mode: "message-discovery-detail", sourceId: "message-context-complete" }
  });
  const messageRawJob = job(db, messageContext.planId, messageJobId);
  upsertJob(db, {
    ...messageRawJob,
    description: messageRawDescription,
    analysis: {
      provider: "message-discovery-detail",
      semanticStatus: "pending",
      decisionSource: "analysis_pending",
      recommendation: null
    }
  }, messageRawBatchId);
  const messageRetry = await retryOneJobAnalysis({
    db,
    input: { planId: messageContext.planId, jobId: messageJobId },
    deps: applicationDeps(controlledRunner({ delayMs: 0 }))
  });
  const messageAnalysisObservation = db.prepare(`SELECT description, analysis_json
    FROM job_observations WHERE batch_id = ? AND job_id = ?`).get(messageRetry.batchId, messageJobId);
  assert.strictEqual(messageAnalysisObservation.description, messageRawDescription);
  assert.strictEqual(JSON.parse(messageAnalysisObservation.analysis_json).semanticStatus, "complete");

  const mixed = seedPlan("mixed");
  const completeId = seedFailedJob(mixed, "bulk-complete");
  const partialId = seedFailedJob(mixed, "bulk-partial");
  const failedId = seedFailedJob(mixed, "bulk-failed");
  const sourcePendingId = seedFailedJob(mixed, "bulk-source-pending", { location: "Beijing" });
  const ignoredId = seedFailedJob(mixed, "bulk-applied");
  markCandidateJob(db, { profileId: mixed.profileId, planId: mixed.planId, jobId: ignoredId, status: "applied", reasonCode: "test" });
  const expectedMixed = pendingIds(mixed.planId);
  assert(expectedMixed.includes(sourcePendingId));
  assert(!expectedMixed.includes(ignoredId));
  const mixedRunner = controlledRunner();
  const bulk = await retryPendingJobAnalyses({
    db,
    input: { planId: mixed.planId },
    deps: applicationDeps(mixedRunner)
  });
  assert.strictEqual(bulk.kind, "bulk");
  assert.deepStrictEqual(bulk.jobIds, expectedMixed);
  assert.strictEqual(bulk.requested, 4);
  assert.strictEqual(bulk.completed, 2);
  assert.strictEqual(bulk.failed, 1);
  assert.strictEqual(bulk.sourcePending, 1);
  assert.strictEqual(bulk.concurrency, PRODUCT_POLICY.operations.modelAnalysis.retryConcurrency);
  assert.strictEqual(mixedRunner.peak, PRODUCT_POLICY.operations.modelAnalysis.retryConcurrency, "bulk must use the configured retry concurrency");
  assert(!mixedRunner.calls.includes("bulk-source-pending"), "source-pending jobs must not invoke the analyzer seam");
  assert.strictEqual(job(db, mixed.planId, completeId).analysis.semanticStatus, "complete");
  assert.strictEqual(job(db, mixed.planId, partialId).analysis.semanticStatus, "partial");
  assert.strictEqual(job(db, mixed.planId, failedId).analysis.errorCode, "MODEL_TIMEOUT");
  assert.deepStrictEqual(job(db, mixed.planId, partialId).analysis.analysisRevision, { fixture: "bulk-partial", version: "analysis-retry-smoke" });
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM job_observations WHERE batch_id = ? AND job_id = ?").get(bulk.batchId, sourcePendingId).count, 0);
  assert.deepStrictEqual(batch(db, bulk.batchId).filterSnapshot.jobIds, expectedMixed);

  const capped = seedPlan("capped");
  for (let index = 0; index < PRODUCT_POLICY.operations.modelAnalysis.maxRetryJobs + 2; index += 1) {
    seedFailedJob(capped, `capped-${String(index).padStart(2, "0")}`);
  }
  const expectedCapped = pendingIds(capped.planId).slice(0, PRODUCT_POLICY.operations.modelAnalysis.maxRetryJobs);
  const cappedRunner = controlledRunner({ delayMs: 0 });
  const cappedResult = await retryPendingJobAnalyses({ db, input: { planId: capped.planId }, deps: applicationDeps(cappedRunner) });
  assert.deepStrictEqual(cappedResult.jobIds, expectedCapped);
  assert.strictEqual(cappedResult.requested, PRODUCT_POLICY.operations.modelAnalysis.maxRetryJobs);

  const errors = seedPlan("errors");
  const errorRunner = controlledRunner();
  await rejects(() => retryOneJobAnalysis({ db, input: { planId: errors.planId, jobId: 1 }, deps: applicationDeps(errorRunner, { modelReady: false }) }), (error) => {
    assert.strictEqual(error.code, "MODEL_CONFIGURATION_REQUIRED");
    assert.strictEqual(error.statusCode, 409);
  });
  await rejects(() => retryOneJobAnalysis({ db, input: { planId: 999999, jobId: 1 }, deps: applicationDeps(errorRunner) }), (error) => {
    assert.strictEqual(error.message, "Search Plan 不存在。");
  });
  const missingCard = seedPlan("missing-card", { confirmCard: false });
  await rejects(() => retryOneJobAnalysis({ db, input: { planId: missingCard.planId, jobId: 1 }, deps: applicationDeps(errorRunner) }), (error) => {
    assert.strictEqual(error.code, "MATCHING_CARD_CONFIRMATION_REQUIRED");
    assert.strictEqual(error.statusCode, 409);
  });
  await rejects(() => retryOneJobAnalysis({ db, input: { planId: errors.planId, jobId: 999999 }, deps: applicationDeps(errorRunner) }), (error) => {
    assert.strictEqual(error.message, "岗位不存在或不属于当前筛选方案。");
  });
  await rejects(() => retryPendingJobAnalyses({ db, input: { planId: errors.planId }, deps: applicationDeps(errorRunner) }), (error) => {
    assert.strictEqual(error.message, "当前没有待重试的语义分析岗位。");
  });
  assert.deepStrictEqual(errorRunner.calls, [], "validation failures must happen before analyzer execution");
}

async function testDashboardContract() {
  const http = seedPlan("http");
  const failedJobId = seedFailedJob(http, "http-failed");
  const bulk = seedPlan("http-bulk");
  seedFailedJob(bulk, "http-bulk-failed");
  seedFailedJob(bulk, "http-bulk-source-pending", { location: "Beijing" });
  const empty = seedPlan("http-empty");
  const requests = [];
  const httpRunner = controlledRunner();
  const runtimeModelConfig = { provider: "mock", providers: { mock: { model: "offline-structured-mock" } } };
  let ready = true;
  const httpLogger = {
    info() {}, warn() {}, error() {},
    requestId() { return "analysis-http-request"; },
    listRecent() { return []; }
  };
  server = createDashboardServer({
    db,
    root,
    dbPath,
    forceMock: true,
    logger: httpLogger,
    analysisRetryRunnerFactory: httpRunner.create,
    runtimeModelResolver({ taskProfile }) {
      requests.push({ kind: "runtime", taskProfile });
      return { modelConfig: runtimeModelConfig };
    },
    modelReadinessChecker(_state, { taskProfile }) {
      requests.push({ kind: "ready", taskProfile });
      return ready;
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const singleFailed = await post(base, "/api/analyze-job", { planId: http.planId, jobId: failedJobId });
  const singleFailedHtml = await singleFailed.text();
  assert.strictEqual(singleFailed.status, 400);
  assert(singleFailedHtml.includes("MODEL_TIMEOUT"));
  assert(singleFailedHtml.includes("analysis-http-request"));
  assert(singleFailedHtml.includes(`href="/queue?planId=${http.planId}&amp;pool=analysis_pending"`));
  assert(requests.some((entry) => entry.taskProfile === "batch_screening"), "retry routes must resolve the batch_screening task profile");
  assert(httpRunner.configs.every((configs) => configs.model === runtimeModelConfig), "runner seam must receive the route's batch_screening model config without replacing it");

  const bulkMixed = await post(base, "/api/analyze-jobs", { planId: bulk.planId });
  assert.strictEqual(bulkMixed.status, 303);
  assert.strictEqual(bulkMixed.headers.get("location"), `/queue?planId=${bulk.planId}&pool=analysis_pending`);

  ready = false;
  const modelBlocked = await post(base, "/api/analyze-jobs", { planId: http.planId });
  const modelBlockedHtml = await modelBlocked.text();
  assert.strictEqual(modelBlocked.status, 409);
  assert(modelBlockedHtml.includes("MODEL_CONFIGURATION_REQUIRED"));
  assert(modelBlockedHtml.includes("analysis-http-request"));
  assert(modelBlockedHtml.includes('href="/settings#model-profile-batch_screening"'));

  ready = true;
  const noCard = seedPlan("http-no-card", { confirmCard: false });
  const noCardResponse = await post(base, "/api/analyze-job", { planId: noCard.planId, jobId: 1 });
  const noCardHtml = await noCardResponse.text();
  assert.strictEqual(noCardResponse.status, 409);
  assert(noCardHtml.includes("MATCHING_CARD_CONFIRMATION_REQUIRED"));
  assert(noCardHtml.includes("analysis-http-request"));
  assert(noCardHtml.includes(`href="/queue?planId=${noCard.planId}&amp;pool=analysis_pending"`));

  const missingPlan = await post(base, "/api/analyze-job", { jobId: 1 });
  const missingPlanHtml = await missingPlan.text();
  assert.strictEqual(missingPlan.status, 400);
  assert(missingPlanHtml.includes("JOB_ANALYSIS_RETRY_FAILED"));
  assert(missingPlanHtml.includes("analysis-http-request"));
  assert(missingPlanHtml.includes('href="/"'));

  const missingJob = await post(base, "/api/analyze-job", { planId: http.planId, jobId: 999999 });
  const missingJobHtml = await missingJob.text();
  assert.strictEqual(missingJob.status, 400);
  assert(missingJobHtml.includes("JOB_ANALYSIS_RETRY_FAILED"));
  assert(missingJobHtml.includes("analysis-http-request"));
  assert(missingJobHtml.includes(`href="/queue?planId=${http.planId}&amp;pool=analysis_pending"`));

  const emptyBulk = await post(base, "/api/analyze-jobs", { planId: empty.planId });
  const emptyBulkHtml = await emptyBulk.text();
  assert.strictEqual(emptyBulk.status, 400);
  assert(emptyBulkHtml.includes("JOB_ANALYSIS_RETRY_FAILED"));
  assert(emptyBulkHtml.includes("analysis-http-request"));
  assert(emptyBulkHtml.includes(`href="/queue?planId=${empty.planId}&amp;pool=analysis_pending"`));
}

function seedPlan(label, { confirmCard = true } = {}) {
  const profile = {
    candidate: { name: `Candidate ${label}`, city: "Guangzhou", targetTitles: ["AI Engineer"], expectedSalary: "10-18K" },
    education: [{ school: "Test University", degree: "本科", major: "Computer Science" }],
    experiences: [],
    skills: [{ name: "Python", evidence: ["project"] }, { name: "RAG", evidence: ["project"] }],
    projects: [{ name: "KnowledgeFlow", roleBoundary: "owner", canSay: ["built retrieval"] }],
    credentials: [], strengths: []
  };
  const saved = saveProfileAnalysis(db, {
    profile,
    document: { originalFileName: `${label}.txt`, format: "text", contentHash: `${label}-resume`, text: "Python RAG retrieval project evidence ".repeat(12), diagnostics: {} },
    searchPlan: { name: `Plan ${label}`, cities: ["Guangzhou"], directions: ["AI Engineer"], keywords: [{ word: "AI Engineer", priority: "A" }], experience: ["1-3年"], jobTypes: ["全职"], bossActiveDays: 3 }
  });
  if (confirmCard) {
    const card = createMatchingCardDraft(db, {
      profileId: saved.profileId,
      profileVersionId: saved.profileVersionId,
      resumeDocumentId: saved.resumeDocumentId,
      resumeContentHash: `${label}-resume`,
      card: matchingCardFromProfile(profile),
      source: "migration"
    });
    confirmMatchingCard(db, { profileId: saved.profileId, cardId: card.id });
  }
  return saved;
}

function seedFailedJob(saved, sourceId, overrides = {}) {
  const batchId = createBatch(db, "boss", "seed", "analysis application smoke", {
    profileId: saved.profileId,
    searchPlanId: saved.planId,
    filterSnapshot: { execution: { scanKind: "daily" } }
  });
  return upsertJob(db, {
    source: "boss",
    sourceId,
    keyword: "AI Engineer",
    title: "AI Application Engineer",
    company: "Smoke Co",
    location: "Guangzhou",
    salary: "10-18K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
    tags: ["Python", "RAG"],
    description: "Build Python RAG and agent applications with retrieval evaluation, FastAPI integration, production diagnostics, testing, and complete delivery ownership. ".repeat(3),
    score: 20,
    level: "可投",
    matches: ["Python", "RAG"],
    risks: [],
    qualityTags: [],
    analysis: { provider: "mock", model: "offline", semanticStatus: "failed", decisionSource: "analysis_pending", recommendation: "review", fitLevel: "C", error: "previous timeout", errorCode: "MODEL_TIMEOUT", evidence: { jd: [], resume: [] } },
    ...overrides
  }, batchId);
}

function applicationDeps(runner, overrides = {}) {
  return {
    root,
    logger,
    modelReady: true,
    modelConfig: { provider: "mock", providers: { mock: { model: "offline-structured-mock" } } },
    createJobAnalysisRunner: runner.create,
    ...overrides
  };
}

function controlledRunner({ delayMs = 10 } = {}) {
  const state = { calls: [], active: 0, peak: 0, configs: [] };
  return {
    get calls() { return state.calls; },
    get peak() { return state.peak; },
    get configs() { return state.configs; },
    create(configs) {
      state.configs.push(configs);
      return async (jobInput) => {
        state.calls.push(jobInput.sourceId);
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        try {
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
          const semanticStatus = jobInput.sourceId.includes("partial") ? "partial"
            : jobInput.sourceId.includes("failed") ? "failed"
              : "complete";
          return {
            provider: "fixture",
            model: "offline-runner",
            semanticStatus,
            decisionStatus: semanticStatus === "partial" ? "needs_retry" : "ready",
            recommendation: semanticStatus === "complete" ? "apply" : "review",
            fitLevel: semanticStatus === "complete" ? "A" : "C",
            error: semanticStatus === "failed" ? "fixture timeout" : "",
            errorCode: semanticStatus === "failed" ? "MODEL_TIMEOUT" : "",
            evidence: { jd: ["complete fixture JD"], resume: ["fixture resume evidence"] },
            analysisRevision: { fixture: jobInput.sourceId, version: "analysis-retry-smoke" }
          };
        } finally {
          state.active -= 1;
        }
      };
    }
  };
}

function pendingIds(planId) {
  return listDecisionPool(db, { planId })
    .filter((item) => item.decisionBucket === "analysis_pending" && isJobAwaitingAction(item))
    .map((item) => item.id);
}

function job(database, planId, jobId) {
  return listReportJobs(database, { planId, batch: "all", limit: 10000 }).find((item) => item.id === jobId);
}

function batch(database, batchId) {
  const row = database.prepare("SELECT keyword, filter_snapshot_json FROM batches WHERE id = ?").get(batchId);
  return { keyword: row.keyword, filterSnapshot: JSON.parse(row.filter_snapshot_json) };
}

async function rejects(operation, verify) {
  try {
    await operation();
    assert.fail("expected operation to reject");
  } catch (error) {
    verify(error);
  }
}

function chinaLocalDay() {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function post(base, route, values) {
  return fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])).toString(),
    redirect: "manual"
  });
}
