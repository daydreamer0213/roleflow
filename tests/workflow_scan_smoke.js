const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  openDb,
  saveProfileAnalysis,
  createMatchingCardDraft,
  confirmMatchingCard,
  createWorkflowRun,
  getWorkflowRun,
  getScanRun,
  transitionWorkflowRun,
  createBatch,
  beginScanRun,
  finishScanRun,
  attachWorkflowScan,
  upsertJob,
  recordSiteAccessEvent,
  listSiteAccessEvents
} = require("../src/core/storage");
const { matchingCardFromProfile } = require("../src/core/matching_card");
const { buildInheritedSearchScope } = require("../src/core/inherited_search_scope");
const { compilePlatformRuntimePolicy } = require("../src/core/platform_runtime_policy");
const { CITY_CODES } = require("../src/core/search_plan");
const { executeWithSiteScanLease, workflowMetrics, workflowAccessUsage } = require("../src/cli");

const root = path.resolve(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `workflow-scan-${Date.now()}.sqlite`);
const completeJobsPath = path.join(smokeDir, `workflow-scan-complete-jds-${Date.now()}.json`);
const reportsBefore = new Set(fs.existsSync(path.join(root, "reports")) ? fs.readdirSync(path.join(root, "reports")) : []);
let db;

main()
  .then(() => console.log("workflow_scan_smoke ok"))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try { db?.close(); } catch {}
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    fs.rmSync(completeJobsPath, { force: true });
    cleanupReports();
  });

async function main() {
  assert.deepStrictEqual(workflowMetrics({
    detailCoverage: {
      collected: 3,
      detailRequired: 3,
      detailRead: 2,
      detailsReused: 1,
      detailPending: 1,
      detailFailed: 1
    },
    analyzed: 2,
    saved: 2,
    inventoryCount: 1
  }), {
    collected: 3,
    cards: 3,
    detailsRequired: 3,
    detailsRead: 2,
    detailsReused: 1,
    detailsPending: 1,
    detailsFailed: 1,
    analyzed: 2,
    saved: 2,
    eligible: 1
  });
  fs.mkdirSync(smokeDir, { recursive: true });
  const completeJobs = JSON.parse(fs.readFileSync(path.join(root, "data", "sample_jobs.json"), "utf8"))
    .map((job) => ({
      ...job,
      description: `${job.description} `.repeat(4),
      detailRead: true,
      detailRequired: true
    }));
  fs.writeFileSync(completeJobsPath, JSON.stringify(completeJobs));
  db = openDb(dbPath);
  for (const action of ["list_navigation", "list_scroll", "pane_detail_read", "pane_detail_read"]) {
    recordSiteAccessEvent(db, { site: "boss", action, runId: "usage-probe" });
  }
  recordSiteAccessEvent(db, { site: "boss", action: "pane_detail_read", runId: "other-run" });
  assert.deepStrictEqual(workflowAccessUsage(db, "usage-probe"), { details: 2, pages: 1, scrolls: 1 });
  const saved = seedProfile(db);
  const workflow = createWorkflowRun(db, workflowInput(saved));
  const invalidInherited = createWorkflowRun(db, workflowInput(saved, {
    id: "workflow-invalid-inherited",
    localDay: "2026-07-19",
    planner: {
      acquisitionMode: "inherited",
      searchTemplate: { mode: "inherited", url: "", cityCode: "" },
      searchScope: {},
      keywordSource: {},
      platformPolicy: {}
    }
  }));
  const missingMode = createWorkflowRun(db, workflowInput(saved, {
    id: "workflow-missing-acquisition-mode",
    localDay: "2026-07-17",
    planner: { remainingDailyTarget: 70, remainingRunSlots: 2 }
  }));
  const unknownMode = createWorkflowRun(db, workflowInput(saved, {
    id: "workflow-unknown-acquisition-mode",
    localDay: "2026-07-18",
    planner: { acquisitionMode: "future-mode", remainingDailyTarget: 70, remainingRunSlots: 2 }
  }));
  db.close();
  db = null;

  const invalidResult = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "src/cli.js",
    "scan",
    "--db", dbPath,
    "--input", completeJobsPath,
    "--plan", String(saved.planId),
    "--force-mock",
    "--run-id", "workflow-invalid-inherited-process",
    "--workflow-run", invalidInherited.id,
    "--keywords", "AI application,RAG engineer",
    "--max-cards", "50",
    "--max-detail-total", "120",
    "--browser-page-budget", "20"
  ], { cwd: root, encoding: "utf8" });
  assert.strictEqual(invalidResult.status, 1, invalidResult.stderr || invalidResult.stdout);
  assert.match(invalidResult.stderr, /本轮继承模式快照不完整/);
  db = openDb(dbPath);
  assert.strictEqual(getScanRun(db, "workflow-invalid-inherited-process").stopCode, "WORKFLOW_INHERITED_SNAPSHOT_INVALID");
  assert.strictEqual(getWorkflowRun(db, invalidInherited.id).errorCode, "WORKFLOW_INHERITED_SNAPSHOT_INVALID");
  db.close();
  db = null;

  for (const [malformedWorkflow, runId] of [
    [missingMode, "workflow-missing-acquisition-mode-process"],
    [unknownMode, "workflow-unknown-acquisition-mode-process"]
  ]) {
    const malformedResult = spawnWorkflowScan({
      dbPath,
      planId: saved.planId,
      workflowRunId: malformedWorkflow.id,
      runId
    });
    assert.strictEqual(malformedResult.status, 1, malformedResult.stderr || malformedResult.stdout);
    assert.match(malformedResult.stderr, /本轮任务的采集模式无效/);
    db = openDb(dbPath);
    assert.strictEqual(getScanRun(db, runId).stopCode, "WORKFLOW_ACQUISITION_MODE_INVALID");
    assert.strictEqual(getWorkflowRun(db, malformedWorkflow.id).errorCode, "WORKFLOW_ACQUISITION_MODE_INVALID");
    assert.strictEqual(getWorkflowRun(db, malformedWorkflow.id).scanBatchId, null);
    db.close();
    db = null;
  }

  db = openDb(dbPath);
  const unsupportedSaved = seedProfile(db, {
    city: "测试未映射城市",
    fixtureId: "unsupported-inherited-city"
  });
  const inheritedScope = buildInheritedSearchScope({
    profileId: unsupportedSaved.profileId,
    rawUrl: "https://www.zhipin.com/web/geek/jobs?query=ignored&page=2"
  });
  const inheritedPolicy = compilePlatformRuntimePolicy({
    searchScope: inheritedScope.searchScope,
    catalog: {},
    cityCodes: CITY_CODES
  });
  const unsupportedInherited = createWorkflowRun(db, workflowInput(unsupportedSaved, {
    id: "workflow-inherited-unsupported-plan-city",
    localDay: "2026-07-23",
    planner: {
      acquisitionMode: "inherited",
      searchTemplate: inheritedScope.searchTemplate,
      searchScope: inheritedScope.searchScope,
      keywordSource: {
        searchPlanId: unsupportedSaved.planId,
        profileVersionId: unsupportedSaved.profileVersionId,
        matchingCardRevision: "fixture-card",
        catalogHash: "fixture-keywords",
        keywords: [
          { word: "AI application", priority: "A", reason: "" },
          { word: "RAG engineer", priority: "B", reason: "" }
        ]
      },
      platformPolicy: inheritedPolicy
    }
  }));
  db.close();
  db = null;
  const inheritedUnsupportedResult = spawnWorkflowScan({
    dbPath,
    planId: unsupportedSaved.planId,
    workflowRunId: unsupportedInherited.id,
    runId: "workflow-inherited-unsupported-plan-city-process"
  });
  assert.strictEqual(
    inheritedUnsupportedResult.status,
    0,
    inheritedUnsupportedResult.stderr || inheritedUnsupportedResult.stdout
  );

  const result = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "src/cli.js",
    "scan",
    "--db", dbPath,
    "--input", completeJobsPath,
    "--plan", String(saved.planId),
    "--force-mock",
    "--run-id", "workflow-scan-process",
    "--workflow-run", workflow.id,
    "--keywords", "AI application,RAG engineer",
    "--max-cards", "50",
    "--max-detail-total", "120",
    "--browser-page-budget", "20"
  ], { cwd: root, encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  db = openDb(dbPath);
  const completed = getWorkflowRun(db, workflow.id);
  assert.strictEqual(completed.status, "review_required");
  assert.strictEqual(completed.scanRunId, "workflow-scan-process");
  assert(completed.scanBatchId);
  assert(completed.reviewReadyAt);
  assert.strictEqual(completed.metrics.analyzed, 2);
  assert.deepStrictEqual(completed.keywords.map((item) => item.word), ["AI application", "RAG engineer"]);

  const analysisOnly = seedAnalysisOnlyResume(db, saved);
  const batchCountBeforeAnalysisResume = Number(
    db.prepare("SELECT COUNT(*) AS count FROM batches").get().count
  );
  db.close();
  db = null;
  const analysisOnlyResult = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "src/cli.js",
    "scan",
    "--db", dbPath,
    "--plan", String(saved.planId),
    "--force-mock",
    "--run-id", "workflow-analysis-only-process",
    "--workflow-run", analysisOnly.workflowId,
    "--analysis-only"
  ], { cwd: root, encoding: "utf8" });
  assert.strictEqual(
    analysisOnlyResult.status,
    0,
    analysisOnlyResult.stderr || analysisOnlyResult.stdout
  );
  db = openDb(dbPath);
  const analysisOnlyCompleted = getWorkflowRun(db, analysisOnly.workflowId);
  assert.strictEqual(analysisOnlyCompleted.status, "review_required");
  assert.strictEqual(analysisOnlyCompleted.scanBatchId, analysisOnly.batchId);
  assert.strictEqual(analysisOnlyCompleted.scanRunId, "workflow-analysis-only-process");
  assert.strictEqual(analysisOnlyCompleted.platformAccessStartedAt, null);
  assert.strictEqual(getScanRun(db, "workflow-analysis-only-process").batchId, null);
  assert.strictEqual(getScanRun(db, "workflow-analysis-only-process").status, "completed");
  assert.strictEqual(
    databaseBatchStatus(db, analysisOnly.batchId),
    "completed",
    "analysis-only resume must not reopen the completed acquisition batch"
  );
  assert.strictEqual(
    Number(db.prepare("SELECT COUNT(*) AS count FROM batches").get().count),
    batchCountBeforeAnalysisResume,
    "analysis-only resume must reuse the persisted batch"
  );
  assert.strictEqual(
    listSiteAccessEvents(db, { site: "boss" })
      .filter((event) => event.details.runId === "workflow-analysis-only-process").length,
    0,
    "analysis-only resume must not record BOSS access"
  );

  const interrupted = createWorkflowRun(db, workflowInput(saved, {
    id: "workflow-interrupted",
    localDay: "2026-07-21",
    sequence: 1
  }));
  transitionWorkflowRun(db, { id: interrupted.id, status: "scanning" });
  const batchId = createBatch(db, "boss", "resume", "workflow interrupted", {
    profileId: saved.profileId,
    searchPlanId: saved.planId,
    status: "running"
  });
  await assert.rejects(
    () => executeWithSiteScanLease(db, {
      "run-id": "workflow-interrupted-scan",
      "workflow-run": interrupted.id,
      plan: String(saved.planId),
      input: "fixture.json"
    }, "scan", async (_signal, execution) => {
      beginScanRun(db, { runId: execution.runId, batchId, processId: process.pid });
      attachWorkflowScan(db, { id: interrupted.id, scanRunId: execution.runId, scanBatchId: batchId });
      throw Object.assign(new Error("browser timed out"), { code: "BROWSER_TIMEOUT" });
    }),
    (error) => error.code === "BROWSER_TIMEOUT"
  );
  const preserved = getWorkflowRun(db, interrupted.id);
  assert.strictEqual(preserved.status, "interrupted");
  assert.strictEqual(preserved.sequence, 1);
  assert.strictEqual(preserved.scanBatchId, batchId);
  assert.strictEqual(transitionWorkflowRun(db, { id: interrupted.id, status: "scanning" }).scanBatchId, batchId);

  const modelInterrupted = createWorkflowRun(db, workflowInput(saved, {
    id: "workflow-model-interrupted",
    localDay: "2026-07-22",
    sequence: 1
  }));
  transitionWorkflowRun(db, { id: modelInterrupted.id, status: "scanning" });
  const modelBatchId = createBatch(db, "boss", "resume", "workflow model interrupted", {
    profileId: saved.profileId,
    searchPlanId: saved.planId,
    status: "running"
  });
  await assert.rejects(
    () => executeWithSiteScanLease(db, {
      "run-id": "workflow-model-interrupted-scan",
      "workflow-run": modelInterrupted.id,
      plan: String(saved.planId),
      input: "fixture.json"
    }, "scan", async (_signal, execution) => {
      beginScanRun(db, { runId: execution.runId, batchId: modelBatchId, processId: process.pid });
      attachWorkflowScan(db, { id: modelInterrupted.id, scanRunId: execution.runId, scanBatchId: modelBatchId });
      throw Object.assign(new Error("model request failed"), { code: "MODEL_REQUEST_FAILED" });
    }),
    (error) => error.code === "MODEL_REQUEST_FAILED"
  );
  const modelPreserved = getWorkflowRun(db, modelInterrupted.id);
  assert.strictEqual(modelPreserved.status, "interrupted");
  assert.strictEqual(modelPreserved.sequence, 1);
  assert.strictEqual(modelPreserved.scanBatchId, modelBatchId);
  assert.strictEqual(getScanRun(db, "workflow-model-interrupted-scan").status, "failed");
}

function spawnWorkflowScan({ dbPath, planId, workflowRunId, runId }) {
  return spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "src/cli.js",
    "scan",
    "--db", dbPath,
    "--input", completeJobsPath,
    "--plan", String(planId),
    "--force-mock",
    "--run-id", runId,
    "--workflow-run", workflowRunId,
    "--keywords", "AI application,RAG engineer",
    "--max-cards", "50",
    "--max-detail-total", "120",
    "--browser-page-budget", "20"
  ], { cwd: root, encoding: "utf8" });
}

function seedAnalysisOnlyResume(database, saved) {
  const workflow = createWorkflowRun(database, workflowInput(saved, {
    id: "workflow-analysis-only",
    localDay: "2026-07-24",
    sequence: 1,
    modelConfigRevision: "force-mock"
  }));
  const batchId = createBatch(database, "boss", "analysis-only", "completed scan checkpoint", {
    profileId: saved.profileId,
    searchPlanId: saved.planId,
    status: "running"
  });
  const jobs = JSON.parse(fs.readFileSync(path.join(root, "data", "sample_jobs.json"), "utf8"));
  for (const [index, raw] of jobs.entries()) {
    upsertJob(database, {
      ...raw,
      sourceId: `${raw.sourceId}-analysis-only-${index + 1}`,
      description: `${raw.description} `.repeat(4),
      detailRead: true
    }, batchId);
  }
  transitionWorkflowRun(database, { id: workflow.id, status: "scanning" });
  beginScanRun(database, {
    runId: "workflow-analysis-only-original-scan",
    site: "boss",
    command: "daily",
    planId: saved.planId,
    batchId,
    processId: process.pid
  });
  attachWorkflowScan(database, {
    id: workflow.id,
    scanRunId: "workflow-analysis-only-original-scan",
    scanBatchId: batchId
  });
  finishScanRun(database, {
    runId: "workflow-analysis-only-original-scan",
    status: "completed"
  });
  transitionWorkflowRun(database, {
    id: workflow.id,
    status: "analyzing",
    modelConfigRevision: "force-mock"
  });
  return {
    workflowId: workflow.id,
    batchId,
    originalScanRunId: "workflow-analysis-only-original-scan"
  };
}

function databaseBatchStatus(database, batchId) {
  return database.prepare("SELECT status FROM batches WHERE id = ?").get(batchId)?.status || "";
}

function seedProfile(database, { city = "广州", fixtureId = "workflow-scan" } = {}) {
  const profile = {
    candidate: { name: "Workflow Candidate", city, targetTitles: ["AI应用开发工程师"], expectedSalary: "10-20K" },
    education: [{ school: "Test University", degree: "Bachelor", major: "Engineering" }],
    experiences: [],
    skills: [{ name: "Python", evidence: ["KnowledgeFlow"] }, { name: "RAG", evidence: ["KnowledgeFlow"] }],
    projects: [{ name: "KnowledgeFlow", roleBoundary: "Independent project", canSay: ["LangGraph workflow"] }],
    credentials: [],
    strengths: []
  };
  const searchPlan = {
    name: `${city} AI`,
    cities: [city],
    directions: ["AI应用开发"],
    keywords: [
      { word: "AI application", priority: "A" },
      { word: "RAG engineer", priority: "B" }
    ],
    salary: { minK: 10, maxK: 20 },
    experience: ["1-3年"],
    jobTypes: ["全职"],
    bossActiveDays: 3,
    platform: { site: "boss" }
  };
  const saved = saveProfileAnalysis(database, {
    profile,
    document: {
      originalFileName: "workflow-resume.txt",
      format: "text",
      contentHash: `${fixtureId}-resume`,
      text: "Python RAG LangGraph project experience. ".repeat(10),
      diagnostics: {}
    },
    searchPlan
  });
  confirmSeededMatchingCard(database, saved, profile, `${fixtureId}-resume`);
  return saved;
}

// 扫描/工作流以已确认匹配偏好卡为前提；离线种子用确定性映射直接确认，不走模型。
function confirmSeededMatchingCard(database, saved, profile, resumeContentHash) {
  const draft = createMatchingCardDraft(database, {
    profileId: saved.profileId,
    profileVersionId: saved.profileVersionId,
    resumeDocumentId: saved.resumeDocumentId,
    resumeContentHash,
    card: matchingCardFromProfile(profile),
    source: "migration"
  });
  confirmMatchingCard(database, { profileId: saved.profileId, cardId: draft.id });
}

function workflowInput(saved, overrides = {}) {
  return {
    profileId: saved.profileId,
    planId: saved.planId,
    localDay: "2026-07-20",
    sequence: 1,
    targetSuccessCount: 35,
    inventoryCount: 0,
    candidateGap: 35,
    scanNeeded: true,
    keywords: [
      { word: "AI application", priority: "A", maxCards: 50, maxDetails: 45 },
      { word: "RAG engineer", priority: "B", maxCards: 32, maxDetails: 30 }
    ],
    budget: { maxDetailTotal: 120, browserPageBudget: 20 },
    planner: { acquisitionMode: "generated", remainingDailyTarget: 70, remainingRunSlots: 2 },
    ...overrides
  };
}

function cleanupReports() {
  const reportDir = path.join(root, "reports");
  if (!fs.existsSync(reportDir)) return;
  for (const file of fs.readdirSync(reportDir)) {
    if (!reportsBefore.has(file) && /^boss_shortlist_.*\.(md|html)$/.test(file)) {
      fs.rmSync(path.join(reportDir, file), { force: true });
    }
  }
}
