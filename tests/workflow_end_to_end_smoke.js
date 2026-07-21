const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  openDb,
  saveProfileAnalysis,
  listWorkflowRuns,
  getWorkflowRun,
  getLatestScanRun,
  createBatch,
  beginScanRun,
  finishScanRun,
  attachWorkflowScan,
  transitionWorkflowRun,
  upsertJob
} = require("../src/core/storage");
const {
  getCommunicationBatch,
  listCommunicationBatchItems
} = require("../src/core/communication_batches");
const { listWorkflowReviewCandidates } = require("../src/core/workflow_inventory");
const { runCommunicationBatch } = require("../src/core/communication_executor");
const { createDashboardServer } = require("../src/dashboard/server");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `workflow-end-to-end-${Date.now()}.sqlite`);
const children = [];
const logger = {
  info() {}, warn() {}, error() {},
  child() { return this; },
  requestId() { return "workflow-end-to-end"; },
  listRecent() { return []; }
};

let db;
let server;

(async () => {
  fs.mkdirSync(smokeDir, { recursive: true });
  db = openDb(dbPath);
  const saved = seedProfile(db);
  server = createDashboardServer({
    db,
    root,
    dbPath,
    forceMock: true,
    allowOfflineMock: true,
    logger,
    spawnProcess(_file, args) {
      const child = new EventEmitter();
      child.pid = 8000 + children.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      children.push({ args, child });
      return child;
    }
  });
  const baseUrl = await listen(server);

  const first = await startWorkflow(baseUrl, saved.planId);
  assert.strictEqual(first.targetSuccessCount, 35);
  assert.deepStrictEqual(first.keywords.map((item) => item.word), ["AI application engineer", "RAG engineer"]);
  assert.deepStrictEqual(first.budget, { maxDetailTotal: 120, browserPageBudget: 20 });

  completeFakeScan(db, first, 32, "first");
  finishLatestChild("scan");
  const firstReview = listWorkflowReviewCandidates(db, first.id);
  assert.strictEqual(firstReview.filter((item) => item.defaultChecked).length, 32);
  const firstBatch = await confirmAndStart(baseUrl, first, firstReview);
  await executeFakeCommunication(db, firstBatch.id, [
    ...Array.from({ length: 30 }, () => "ready"),
    "job_unavailable",
    "job_unavailable"
  ]);
  finishLatestChild("communicate");
  const firstCompleted = getWorkflowRun(db, first.id);
  assert.strictEqual(firstCompleted.status, "completed");
  assert.strictEqual(firstCompleted.successfulCount, 30);
  assert.strictEqual(firstCompleted.shortfallCode, "WORKFLOW_SUPPLY_EXHAUSTED");
  db.prepare("UPDATE workflow_runs SET started_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 3 * 60 * 60_000).toISOString(), first.id);

  const second = await startWorkflow(baseUrl, saved.planId);
  assert.strictEqual(second.sequence, 2);
  assert.strictEqual(second.targetSuccessCount, 40);
  assert.deepStrictEqual(second.keywords.map((item) => item.word), ["Python AI backend", "Agent engineer"]);
  assert(!second.keywords.some((item) => first.keywords.some((used) => used.word === item.word)));

  completeFakeScan(db, second, 42, "second", {
    duplicateSourceId: "first-1",
    includeInvalid: true
  });
  finishLatestChild("scan");
  const secondReview = listWorkflowReviewCandidates(db, second.id);
  const secondSelected = secondReview.filter((item) => item.defaultChecked);
  assert.strictEqual(secondSelected.length, 42);
  assert(!secondReview.some((item) => item.sourceId === "first-1"));
  assert(!secondReview.some((item) => item.sourceId === "second-invalid"));

  const secondBatch = await confirmAndStart(baseUrl, second, secondReview);
  await executeFakeCommunication(db, secondBatch.id, Array.from({ length: 40 }, () => "ready"));
  finishLatestChild("communicate");
  const secondCompleted = getWorkflowRun(db, second.id);
  assert.strictEqual(secondCompleted.status, "completed");
  assert.strictEqual(secondCompleted.successfulCount, 40);
  assert.deepStrictEqual(
    listCommunicationBatchItems(db, secondBatch.id).slice(-2).map((item) => [item.status, item.clickCount]),
    [["stopped", 0], ["stopped", 0]]
  );

  const planPage = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.match(planPage.body, /70\s*\/\s*70/);
  const third = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
    browserMode: "edge",
    action: "start"
  });
  assert.strictEqual(third.status, 409);
  assert.match(third.body, /WORKFLOW_DAILY_TARGET_REACHED/);
  assert.strictEqual(listWorkflowRuns(db, { profileId: saved.profileId, localDay: first.localDay }).length, 2);

  console.log("workflow_end_to_end_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
  }
});

function seedProfile(database) {
  return saveProfileAnalysis(database, {
    profile: {
      candidate: {
        name: "Workflow Candidate",
        city: "广州",
        targetTitles: ["AI应用开发工程师"],
        expectedSalary: "10-20K"
      },
      education: [{ school: "Test University", degree: "本科", major: "电子信息工程" }],
      experiences: [],
      skills: [{ name: "Python", evidence: ["KnowledgeFlow"] }, { name: "RAG", evidence: ["DocMind"] }],
      projects: [{ name: "KnowledgeFlow", roleBoundary: "独立项目", canSay: ["LangGraph workflow"] }],
      credentials: [],
      strengths: []
    },
    document: {
      originalFileName: "workflow-e2e-resume.txt",
      format: "text",
      contentHash: "workflow-e2e-resume",
      text: "Python RAG LangGraph project experience. ".repeat(12),
      diagnostics: {}
    },
    searchPlan: {
      name: "Guangzhou AI",
      cities: ["广州"],
      directions: ["AI应用开发"],
      keywords: [
        { word: "AI application engineer", priority: "A" },
        { word: "RAG engineer", priority: "A" },
        { word: "Python AI backend", priority: "B" },
        { word: "Agent engineer", priority: "B" }
      ],
      salary: { minK: 10, maxK: 20 },
      experience: ["经验不限", "1-3年"],
      jobTypes: ["全职"],
      degrees: [],
      bossActiveDays: 3,
      platform: { site: "boss" }
    }
  });
}

async function startWorkflow(baseUrl, planId) {
  const response = await postForm(baseUrl, "/api/workflow-run", {
    planId,
    browserMode: "edge",
    action: "start"
  });
  assert.strictEqual(response.status, 303, response.body);
  const runId = new URL(response.location, baseUrl).searchParams.get("runId");
  const workflow = getWorkflowRun(db, runId);
  assert(workflow);
  assert.strictEqual(workflow.status, "scanning");
  return workflow;
}

function completeFakeScan(database, workflow, count, prefix, options = {}) {
  const scan = getLatestScanRun(database, { planId: workflow.planId, site: "boss" });
  assert(scan && scan.status === "running");
  const batchId = createBatch(database, "boss", workflow.keywords.map((item) => item.word).join(", "), "fake workflow scan", {
    profileId: workflow.profileId,
    searchPlanId: workflow.planId
  });
  beginScanRun(database, { runId: scan.id, batchId, processId: process.pid });
  attachWorkflowScan(database, { id: workflow.id, scanRunId: scan.id, scanBatchId: batchId });
  const keyword = workflow.keywords[0]?.word || "AI application engineer";
  for (let index = 0; index < count; index += 1) {
    upsertJob(database, job(`${prefix}-${index + 1}`, keyword), batchId);
  }
  if (options.duplicateSourceId) upsertJob(database, job(options.duplicateSourceId, keyword), batchId);
  if (options.includeInvalid) {
    upsertJob(database, job(`${prefix}-invalid`, keyword, {
      description: "",
      detailRequired: true,
      detailRead: false,
      analysis: { semanticStatus: "pending", recommendation: "review" }
    }), batchId);
  }
  finishScanRun(database, { runId: scan.id, status: "completed" });
  transitionWorkflowRun(database, {
    id: workflow.id,
    status: "analyzing",
    metrics: { collected: count + Number(Boolean(options.duplicateSourceId)) + Number(Boolean(options.includeInvalid)), detailsRead: count, analyzed: 0 }
  });
  const inventoryCount = listWorkflowReviewCandidates(database, workflow.id).length;
  transitionWorkflowRun(database, {
    id: workflow.id,
    status: "review_required",
    inventoryCount,
    metrics: { collected: count, detailsRead: count, detailsReused: 0, detailsPending: Number(Boolean(options.includeInvalid)), analyzed: count, eligible: inventoryCount }
  });
}

async function confirmAndStart(baseUrl, workflow, review) {
  const selectedIds = review.filter((item) => item.defaultChecked).map((item) => item.id);
  const confirmed = await postForm(baseUrl, "/api/communication-batch", {
    workflowRunId: workflow.id,
    planId: workflow.planId,
    browserMode: "edge",
    jobIds: selectedIds
  }, "application/json");
  assert.strictEqual(confirmed.status, 200, confirmed.body);
  const payload = JSON.parse(confirmed.body);
  const batch = getCommunicationBatch(db, payload.batch.id);
  const started = await postForm(baseUrl, "/api/communication-control", {
    batchId: batch.id,
    action: "start"
  }, "application/json");
  assert.strictEqual(started.status, 200, started.body);
  return getCommunicationBatch(db, batch.id);
}

async function executeFakeCommunication(database, batchId, states) {
  const queue = [...states];
  await runCommunicationBatch({
    db: database,
    batchId,
    executionGate: () => true,
    accessController: { async reserve() {} },
    adapter: {
      async inspectCommunicationJob() { return { state: queue.shift() || "ready" }; },
      async dispatchCommunication() {},
      async verifyCommunicationResult() { return { state: "succeeded" }; }
    },
    sleepFn: async () => {},
    randomFn: () => 0
  });
}

function finishLatestChild(command) {
  const entry = [...children].reverse().find((candidate) => candidate.args.includes(command));
  assert(entry, `missing ${command} child process`);
  entry.child.emit("close", 0, null);
}

function job(sourceId, keyword, overrides = {}) {
  return {
    source: "boss",
    sourceId,
    keyword,
    title: `AI Application Engineer ${sourceId}`,
    company: `Company ${sourceId}`,
    location: "广州",
    salary: "10-20K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
    tags: ["Python", "RAG"],
    description: "Build Python RAG applications with retrieval, reranking, FastAPI integration, testing, and production diagnostics. ".repeat(3),
    detailRequired: true,
    detailRead: true,
    score: 25,
    level: "推荐",
    matches: ["Python", "RAG"],
    risks: [],
    qualityTags: ["salary_target_core"],
    analysis: {
      provider: "mock",
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

async function listen(target) {
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${target.address().port}`;
}

async function getText(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.text() };
}

async function postForm(baseUrl, pathname, body, accept = "text/html") {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept },
    body: params,
    redirect: "manual"
  });
  return { status: response.status, location: response.headers.get("location"), body: await response.text() };
}
