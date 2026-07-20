const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  openDb,
  saveProfileAnalysis,
  listWorkflowRuns,
  getWorkflowRun,
  transitionWorkflowRun,
  createBatch,
  upsertJob
} = require("../src/core/storage");
const { listWorkflowReviewCandidates } = require("../src/core/workflow_inventory");
const { createDashboardServer } = require("../src/dashboard/server");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `workflow-dashboard-${Date.now()}.sqlite`);
const logger = {
  info() {}, warn() {}, error() {},
  requestId() { return "workflow-dashboard-smoke"; },
  listRecent() { return []; }
};

let db;
let server;

(async () => {
  fs.mkdirSync(smokeDir, { recursive: true });
  db = openDb(dbPath);
  const saved = seedProfile(db);
  const spawns = [];
  server = createDashboardServer({
    db,
    root,
    dbPath,
    forceMock: true,
    allowOfflineMock: true,
    logger,
    spawnProcess(file, args, options) {
      const child = new EventEmitter();
      child.pid = 6100 + spawns.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      spawns.push({ file, args, options, child });
      return child;
    }
  });
  const baseUrl = await listen(server);

  const planBefore = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.match(planBefore.body, /今日进度<\/span><strong>0\s*\/\s*70/);
  assert.match(planBefore.body, /下一轮目标<\/span><strong>35/);
  assert.strictEqual((planBefore.body.match(/name="action" value="start"/g) || []).length, 1);
  assert.doesNotMatch(planBefore.body, /上午|下午/);
  assert.match(planBefore.body, /高级扫描与维护/);

  const started = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
    browserMode: "edge",
    action: "start"
  });
  assert.strictEqual(started.status, 303);
  assert.match(started.location, /^\/workflow\?runId=/);
  const workflow = listWorkflowRuns(db, { planId: saved.planId })[0];
  assert.strictEqual(workflow.status, "scanning");
  assert.strictEqual(workflow.targetSuccessCount, 35);
  assert.strictEqual(spawns.length, 1);
  assert(spawns[0].args.includes("--workflow-run"));
  assert(spawns[0].args.includes(workflow.id));

  const scanningPage = await getText(baseUrl, started.location);
  assert.match(scanningPage.body, /正在筛选岗位/);
  assert.match(scanningPage.body, /本轮目标\s*<strong>35/);
  assert.doesNotMatch(scanningPage.body, /上午|下午/);

  spawns[0].child.emit("error", new Error("spawn failed"));
  const interruptedWorkflow = getWorkflowRun(db, workflow.id);
  assert.strictEqual(interruptedWorkflow.status, "interrupted");
  assert.strictEqual(interruptedWorkflow.sequence, 1);
  assert.strictEqual(interruptedWorkflow.errorCode, "SCAN_PROCESS_ERROR");

  const resumed = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: workflow.id,
    browserMode: "edge"
  });
  assert.strictEqual(resumed.status, 303);
  assert.strictEqual(resumed.location, `/workflow?runId=${workflow.id}`);
  assert.strictEqual(spawns.length, 2);
  assert.strictEqual(getWorkflowRun(db, workflow.id).status, "scanning");

  const batchId = createBatch(db, "boss", "workflow-dashboard", "workflow dashboard", {
    profileId: saved.profileId,
    searchPlanId: saved.planId
  });
  for (let index = 0; index < 6; index += 1) upsertJob(db, job(index + 1), batchId);
  transitionWorkflowRun(db, { id: workflow.id, status: "analyzing" });
  transitionWorkflowRun(db, { id: workflow.id, status: "review_required", inventoryCount: 6 });

  const reviewPage = await getText(baseUrl, started.location);
  assert.match(reviewPage.body, /确认本轮沟通清单/);
  assert.match(reviewPage.body, new RegExp(`name="workflowRunId" value="${workflow.id}"`));
  assert.strictEqual((reviewPage.body.match(/<input[^>]*name="jobIds"[^>]*checked/g) || []).length, 6);
  assert.match(reviewPage.body, /本轮成功目标\s*35/);

  const selectedIds = listWorkflowReviewCandidates(db, workflow.id)
    .filter((candidate) => candidate.defaultChecked)
    .map((candidate) => candidate.id);
  const confirmed = await postForm(baseUrl, "/api/communication-batch", {
    workflowRunId: workflow.id,
    planId: saved.planId,
    browserMode: "edge",
    jobIds: selectedIds
  });
  assert.strictEqual(confirmed.status, 303);
  assert.strictEqual(confirmed.location, `/workflow?runId=${workflow.id}`);

  const confirmedPage = await getText(baseUrl, confirmed.location);
  assert.match(confirmedPage.body, /清单已确认/);
  assert.match(confirmedPage.body, /name="action" value="start"/);
  assert.match(confirmedPage.body, /开始沟通/);

  transitionWorkflowRun(db, { id: workflow.id, status: "communicating" });
  transitionWorkflowRun(db, { id: workflow.id, status: "completed", successfulCount: 30, shortfallCode: "WORKFLOW_SUPPLY_EXHAUSTED" });
  const completedPage = await getText(baseUrl, confirmed.location);
  assert.match(completedPage.body, /本轮已完成/);
  assert.match(completedPage.body, /今日进度\s*<strong>30\s*\/\s*70/);
  assert.match(completedPage.body, /本轮成功\s*<strong>30/);

  const planAfter = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.match(planAfter.body, /今日进度<\/span><strong>30\s*\/\s*70/);
  assert.match(planAfter.body, /下一轮目标<\/span><strong>40/);
  assert.strictEqual((planAfter.body.match(/name="action" value="start"/g) || []).length, 1);
  assert.match(planAfter.body, /name="action" value="start" disabled/);

  const rejectedWhileScanExists = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
    browserMode: "edge",
    action: "start"
  });
  assert.strictEqual(rejectedWhileScanExists.status, 409);
  assert.strictEqual(listWorkflowRuns(db, { planId: saved.planId }).length, 1);

  console.log("workflow_dashboard_smoke ok");
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
      candidate: { name: "Workflow Candidate", city: "广州", targetTitles: ["AI应用开发工程师"], expectedSalary: "10-20K" },
      education: [{ school: "Test University", degree: "本科", major: "电子信息工程" }],
      experiences: [],
      skills: [{ name: "Python", evidence: ["KnowledgeFlow"] }, { name: "RAG", evidence: ["KnowledgeFlow"] }],
      projects: [{ name: "KnowledgeFlow", roleBoundary: "独立项目", canSay: ["LangGraph workflow"] }],
      credentials: [],
      strengths: []
    },
    document: {
      originalFileName: "workflow-resume.txt",
      format: "text",
      contentHash: "workflow-dashboard-resume",
      text: "Python RAG LangGraph project experience. ".repeat(10),
      diagnostics: {}
    },
    searchPlan: {
      name: "广州 AI",
      cities: ["广州"],
      directions: ["AI应用开发"],
      keywords: [
        { word: "AI应用开发工程师", priority: "A", reason: "主方向" },
        { word: "RAG工程师", priority: "A", reason: "主方向" },
        { word: "Python AI后端", priority: "B", reason: "补充方向" },
        { word: "Agent工程师", priority: "B", reason: "补充方向" }
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

function job(index) {
  return {
    source: "boss",
    sourceId: `workflow-dashboard-${index}`,
    keyword: "AI应用开发工程师",
    title: `AI应用开发工程师 ${index}`,
    company: `Company ${index}`,
    location: "广州",
    salary: "10-15K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/workflow-dashboard-${index}.html`,
    tags: ["Python", "RAG"],
    description: "负责 Python RAG 应用开发、检索优化、接口联调、测试与线上问题排查。".repeat(6),
    score: 28 - index,
    level: "优先",
    matches: ["Python", "RAG"],
    risks: [],
    qualityTags: ["salary_target_core"],
    analysis: {
      provider: "openai_compatible",
      semanticStatus: "complete",
      recommendation: "apply",
      confidence: 0.9,
      evidence: { jd: ["Python RAG"], resume: ["Python RAG"] },
      hardBlockers: []
    }
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

async function postForm(baseUrl, pathname, body) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
    redirect: "manual"
  });
  return { status: response.status, location: response.headers.get("location"), body: await response.text() };
}
