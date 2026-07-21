const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  openDb,
  saveProfileAnalysis,
  createWorkflowRun,
  getWorkflowRun,
  getScanRun,
  transitionWorkflowRun,
  createBatch,
  beginScanRun,
  attachWorkflowScan,
  recordSiteAccessEvent
} = require("../src/core/storage");
const { executeWithSiteScanLease, workflowMetrics, workflowAccessUsage } = require("../src/cli");

const root = path.resolve(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `workflow-scan-${Date.now()}.sqlite`);
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
  db = openDb(dbPath);
  for (const action of ["list_navigation", "list_scroll", "pane_detail_read", "pane_detail_read"]) {
    recordSiteAccessEvent(db, { site: "boss", action, runId: "usage-probe" });
  }
  recordSiteAccessEvent(db, { site: "boss", action: "pane_detail_read", runId: "other-run" });
  assert.deepStrictEqual(workflowAccessUsage(db, "usage-probe"), { details: 2, pages: 1, scrolls: 1 });
  const saved = seedProfile(db);
  const workflow = createWorkflowRun(db, workflowInput(saved));
  db.close();
  db = null;

  const result = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "src/cli.js",
    "scan",
    "--db", dbPath,
    "--input", path.join("data", "sample_jobs.json"),
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

function seedProfile(database) {
  const profile = {
    candidate: { name: "Workflow Candidate", city: "广州", targetTitles: ["AI应用开发工程师"], expectedSalary: "10-20K" },
    education: [{ school: "Test University", degree: "Bachelor", major: "Engineering" }],
    experiences: [],
    skills: [{ name: "Python", evidence: ["KnowledgeFlow"] }, { name: "RAG", evidence: ["KnowledgeFlow"] }],
    projects: [{ name: "KnowledgeFlow", roleBoundary: "Independent project", canSay: ["LangGraph workflow"] }],
    credentials: [],
    strengths: []
  };
  const searchPlan = {
    name: "Guangzhou AI",
    cities: ["广州"],
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
  return saveProfileAnalysis(database, {
    profile,
    document: {
      originalFileName: "workflow-resume.txt",
      format: "text",
      contentHash: "workflow-scan-resume",
      text: "Python RAG LangGraph project experience. ".repeat(10),
      diagnostics: {}
    },
    searchPlan
  });
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
    planner: { remainingDailyTarget: 70, remainingRunSlots: 2 },
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
