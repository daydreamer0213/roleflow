const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  openDb,
  saveProfileAnalysis,
  createMatchingCardDraft,
  confirmMatchingCard,
  createBatch,
  upsertJob
} = require("../src/core/storage");
const { matchingCardFromProfile } = require("../src/core/matching_card");
const { createDashboardServer } = require("../src/dashboard/server");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `outcome-analytics-dashboard-${Date.now()}.sqlite`);
const logger = {
  info() {}, warn() {}, error() {},
  requestId() { return "outcome-analytics-dashboard-smoke"; },
  listRecent() { return []; }
};

let db;
let server;

(async () => {
  fs.mkdirSync(smokeDir, { recursive: true });
  db = openDb(dbPath);
  const { planId, profileId } = seedPlan(db);
  const batchId = createBatch(db, "boss", "outcome-analytics-dashboard", "outcome analytics dashboard", {
    profileId,
    searchPlanId: planId
  });
  seedJobs(db, batchId);

  server = createDashboardServer({
    db,
    root,
    dbPath,
    forceMock: true,
    allowOfflineMock: true,
    logger
  });
  const baseUrl = await listen(server);
  const page = await getText(baseUrl, `/queue?planId=${planId}`);

  assert.strictEqual(page.status, 200);
  assertContains(page.body, /结果统计（只读）/, "outcome analytics heading is rendered");
  for (const label of ["主投", "可投", "慎投", "不推荐"]) assertContains(page.body, new RegExp(label), `tier label is rendered: ${label}`);
  assertContains(page.body, /待分析或待刷新（不纳入四档比较）/, "diagnostics label is rendered");
  for (const column of ["推荐档位", "总数", "未处理", "已投", "已跳过", "无回复", "已约面", "已拒绝或无效"]) {
    assertContains(page.body, new RegExp(column), `tier column is rendered: ${column}`);
  }
  assertContains(page.body, /搜索方向（关键词）/, "keyword heading is rendered");
  assertContains(page.body, /调整匹配矩阵、权重或提示词前，必须取得用户确认/, "confirmation notice is rendered");
  assertExcludes(page.body, /模型准确率|自动调整二维表|成功率/, "prohibited claims are absent");
  const normalPanel = extractAnalyticsPanel(page.body);
  assert(!normalPanel.includes("private-primary-title"));
  assert(!normalPanel.includes("private-company"));
  assert(!normalPanel.includes("private-job-url"));

  const warnings = [];
  const failOpenServer = createDashboardServer({
    db,
    root,
    dbPath,
    forceMock: true,
    allowOfflineMock: true,
    logger: {
      ...logger,
      warn(event, metadata) { warnings.push({ event, metadata }); }
    },
    outcomeAnalytics: {
      getSnapshot() {
        throw new Error("private analytics fixture failure");
      }
    }
  });
  const failOpenBaseUrl = await listen(failOpenServer);
  try {
    const failure = await getText(failOpenBaseUrl, `/queue?planId=${planId}&pool=caution`);
    assert.strictEqual(failure.status, 200);
    assertContains(failure.body, /当前待处理岗位/, "queue heading is retained after analytics failure");
    const failurePanel = extractAnalyticsPanel(failure.body);
    assert.strictEqual(failurePanel, "统计暂不可用");
    assert(failure.body.indexOf('class="panel outcome-analytics"') > failure.body.indexOf("当前待处理岗位"));
    assert(failure.body.indexOf('class="panel outcome-analytics"') < failure.body.indexOf('<article class="job">'));
    assertExcludes(failure.body, /结果统计（只读）|private analytics fixture failure/, "failure panel reveals no analytics details");
    assert.deepStrictEqual(warnings, [{
      event: "outcome_analytics_render_failed",
      metadata: { code: "OUTCOME_ANALYTICS_UNAVAILABLE" }
    }]);
  } finally {
    await new Promise((resolve) => failOpenServer.close(resolve));
  }

  console.log("outcome_analytics_dashboard_smoke ok");
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

function seedPlan(database) {
  const profile = {
    candidate: { name: "Outcome Candidate", city: "上海", targetTitles: ["AI 工程师"], expectedSalary: "15-25K" },
    education: [], experiences: [], skills: [], projects: [], credentials: [], strengths: []
  };
  const saved = saveProfileAnalysis(database, {
    profile,
    document: {
      originalFileName: "outcome-resume.txt",
      format: "text",
      contentHash: "outcome-analytics-dashboard-resume",
      text: "Outcome analytics fixture resume.",
      diagnostics: {}
    },
    searchPlan: {
      name: "Outcome analytics",
      cities: ["上海"],
      directions: ["AI 应用开发"],
      keywords: [{ word: "RAG 工程师", priority: "A", reason: "主方向" }],
      salary: { minK: 15, maxK: 25 },
      experience: ["1-3年"],
      jobTypes: ["全职"],
      degrees: [],
      bossActiveDays: 3,
      platform: { site: "boss" }
    }
  });
  const draft = createMatchingCardDraft(database, {
    profileId: saved.profileId,
    profileVersionId: saved.profileVersionId,
    resumeDocumentId: saved.resumeDocumentId,
    resumeContentHash: "outcome-analytics-dashboard-resume",
    card: matchingCardFromProfile(profile),
    source: "migration"
  });
  confirmMatchingCard(database, { profileId: saved.profileId, cardId: draft.id });
  return saved;
}

function seedJobs(database, batchId) {
  const jobs = [
    job("primary", "interview"),
    job("apply", "no_reply"),
    job("caution", ""),
    job("not_recommended", "skipped"),
    job("analysis_pending", "")
  ];
  for (const item of jobs) upsertJob(database, item, batchId);
}

function job(recommendation, applicationStatus) {
  const pending = recommendation === "analysis_pending";
  return {
    source: "boss",
    sourceId: `outcome-analytics-${recommendation}`,
    keyword: "RAG 工程师",
    title: `private-${recommendation}-title`,
    company: "private-company",
    location: "上海",
    salary: "15-25K",
    experience: "1-3年",
    education: "本科",
    url: "https://private-job-url.example/job",
    tags: [],
    description: "private JD",
    applicationStatus,
    analysis: {
      semanticStatus: pending ? "pending" : "complete",
      recommendation: pending ? "" : recommendation,
      recommendationSchemaVersion: 2,
      fitLevel: "fit",
      confidence: 0.9,
      evidence: { jd: [], resume: [] },
      hardBlockers: []
    }
  };
}

function extractAnalyticsPanel(body) {
  const match = body.match(/<section class="panel outcome-analytics">([\s\S]*?)<\/section>/);
  assert(match, "outcome analytics panel must remain in its fixed slot");
  return match[1];
}

function assertContains(body, expression, message) {
  assert(expression.test(body), message);
}

function assertExcludes(body, expression, message) {
  assert(!expression.test(body), message);
}

async function listen(target) {
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${target.address().port}`;
}

async function getText(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.text() };
}
