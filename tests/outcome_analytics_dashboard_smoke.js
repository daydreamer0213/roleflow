const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  openDb,
  saveProfileAnalysis,
  createMatchingCardDraft,
  confirmMatchingCard,
  createBatch,
  upsertJob,
  markCandidateJob
} = require("../src/core/storage");
const { matchingCardFromProfile } = require("../src/core/matching_card");
const { createDashboardServer, renderQueuePage } = require("../src/dashboard/server");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `outcome-analytics-dashboard-${Date.now()}.sqlite`);
const logger = {
  info() {}, warn() {}, error() {},
  requestId() { return "outcome-analytics-dashboard-smoke"; },
  listRecent() { return []; }
};
const BAIT = Object.freeze({
  jobOrSourceId: "bait-job-source-id-4be2b00b",
  title: "bait-job-title-41f1e2a9",
  company: "bait-company-70db732d",
  url: "https://bait-job-url-5a7cf798.example/private",
  jd: "bait-jd-content-83c8b9fb",
  resume: "bait-resume-content-ef1518a2",
  rawModel: "bait-raw-model-output-e0a0d5cc"
});
const MISSING_KEYWORD = "\u672a\u8bb0\u5f55\u5173\u952e\u8bcd";
const OTHER_KEYWORD = "\u5176\u4ed6\u5173\u952e\u8bcd";

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
  seedJobs(db, batchId, { planId, profileId });

  server = createDashboardServer({
    db,
    root,
    dbPath,
    forceMock: true,
    allowOfflineMock: true,
    logger
  });
  const baseUrl = await listen(server);
  const page = await getText(baseUrl, `/queue?planId=${planId}&pool=analysis_pending`);

  assert.strictEqual(page.status, 200);
  const normalPanel = extractAnalyticsPanel(page.body);
  assertContains(normalPanel, /结果统计（只读）/, "outcome analytics heading is rendered in the panel");
  assertContains(normalPanel, /当前方案：Outcome &lt;analytics&gt; &amp; plan；纳入岗位：20；已记录终态：3。/, "safe plan context and aggregate summary are rendered");
  assertExcludes(normalPanel, /Outcome <analytics> & plan/, "raw plan name is not rendered");
  const tierTable = extractAnalyticsTable(normalPanel, "outcome-tier-table");
  for (const label of ["主投", "可投", "慎投", "不推荐"]) {
    assertContains(tierTable, new RegExp(`<th scope="row">${label}<\\/th>`), `tier label is rendered in the analytics table: ${label}`);
  }
  assert.strictEqual(extractTableBodyRows(tierTable).length, 4, "analytics table renders exactly four tier rows");
  assertContains(tierTable, /<th>已跳过<\/th>/, "analytics table includes the skipped column");
  assertContains(tierTable, /<th>薪资不匹配<\/th>/, "analytics table includes the salary mismatch column");
  assertTierMetrics(tierTable, "主投", [1, 0, 0, 0, 0, 1, 0]);
  assertTierMetrics(tierTable, "可投", [1, 0, 0, 0, 1, 0, 0]);
  assertTierMetrics(tierTable, "慎投", [1, 1, 0, 0, 0, 0, 0]);
  assertTierMetrics(tierTable, "不推荐", [1, 0, 0, 1, 0, 0, 0]);
  assertContains(normalPanel, /<p class="outcome-analytics-diagnostics">待分析或待刷新（不纳入四档比较）：16<\/p>/, "diagnostics count is separate from the four tiers");
  assertContains(normalPanel, /<p class="outcome-analytics-unclassified">未分类记录：0；未知推荐档位：0；未知状态：0<\/p>/, "aggregate-only unclassified counters are rendered");
  assertContains(normalPanel, /搜索方向（关键词）/, "keyword heading is rendered in the panel");
  const keywordTable = extractAnalyticsTable(normalPanel, "outcome-keyword-table");
  assert.strictEqual(extractTableBodyRows(keywordTable).length, 13, "dashboard renders every aggregator-bounded keyword row");
  assertContains(keywordTable, new RegExp(`<th scope="row">${MISSING_KEYWORD}<\\/th>`), "rendered keywords include the blank-keyword fallback");
  assertContains(keywordTable, new RegExp(`<th scope="row">${OTHER_KEYWORD}<\\/th>`), "rendered keywords include the aggregator overflow row");
  assertKeywordRowsReconcile(keywordTable);
  assert.strictEqual((normalPanel.match(/class="outcome-analytics-table-wrap"/g) || []).length, 2, "wide analytics tables use local horizontal overflow wrappers");
  assertContains(normalPanel, /\u4ec5\u4f9b\u89c2\u5bdf\uff0c\u4e0d\u8db3\u4ee5\u8c03\u53c2/, "deterministic v1 sample caution is rendered");
  assertContains(normalPanel, /调整匹配矩阵、权重或提示词前，必须取得用户确认/, "confirmation notice is rendered in the panel");
  assertExcludes(normalPanel, /模型准确率|自动调整二维表|成功率/, "prohibited claims are absent from the panel");
  for (const marker of Object.values(BAIT)) {
    assertExcludes(normalPanel, new RegExp(escapeRegExp(marker)), "analytics panel omits sensitive source data");
  }
  assertAnalyticsPanelPlacement(page.body, "normal analytics panel");

  const directFailurePage = renderQueuePage({
    db,
    searchParams: new URLSearchParams({ planId: String(planId), pool: "analysis_pending" }),
    outcomeAnalyticsReader() { throw new Error("direct analytics fixture failure"); }
  });
  assert.strictEqual(extractAnalyticsPanel(directFailurePage), "统计暂不可用", "direct queue rendering is fail-open without a logger");

  const unknownTierPage = renderQueuePage({
    db,
    searchParams: new URLSearchParams({ planId: String(planId) }),
    outcomeAnalyticsReader() {
      return { tiers: [{ tier: "toString", total: 1 }], diagnostics: { total: 0 }, keywords: [] };
    }
  });
  assertContains(extractAnalyticsPanel(unknownTierPage), /暂无四档结果记录。/, "unknown tier data uses the no-records behavior");
  assertContains(extractAnalyticsPanel(unknownTierPage), /暂无已记录结果。/, "zero terminal count uses the no-recorded-results behavior");

  const aggregateOnlyPage = renderQueuePage({
    db,
    searchParams: new URLSearchParams({ planId: String(planId) }),
    outcomeAnalyticsReader() {
      return {
        context: { planName: "Safe &amp; plan", rawPlanId: "raw-plan-id" },
        totals: { total: 7, recordedOutcomeCount: 1 },
        tiers: [],
        diagnostics: { total: 0, outcomes: {} },
        keywords: [],
        unclassified: {
          total: 2,
          unknownDecisionBucket: 1,
          unknownApplicationStatus: 1,
          rawDecisionBucket: "raw-decision-value",
          rawApplicationStatus: "raw-status-value"
        }
      };
    }
  });
  const aggregateOnlyPanel = extractAnalyticsPanel(aggregateOnlyPage);
  assertContains(aggregateOnlyPanel, /当前方案：Safe &amp; plan；纳入岗位：7；已记录终态：1。/, "aggregate terminal count includes an unclassified valid terminal result");
  assertContains(aggregateOnlyPanel, /未分类记录：2；未知推荐档位：1；未知状态：1/, "unknown counters render as aggregate numbers only");
  assertExcludes(aggregateOnlyPanel, /raw-plan-id|raw-decision-value|raw-status-value/, "raw context and unknown values are not rendered");

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
    const failure = await getText(failOpenBaseUrl, `/queue?planId=${planId}&pool=analysis_pending`);
    assert.strictEqual(failure.status, 200);
    assertContains(failure.body, /当前待处理岗位/, "queue heading is retained after analytics failure");
    const failurePanel = extractAnalyticsPanel(failure.body);
    assert.strictEqual(failurePanel, "统计暂不可用");
    assertAnalyticsPanelPlacement(failure.body, "fallback analytics panel");
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
      text: BAIT.resume,
      diagnostics: {}
    },
    searchPlan: {
      name: "Outcome <analytics> & plan",
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

function seedJobs(database, batchId, { planId, profileId }) {
  const jobs = [
    ["primary", "interview"],
    ["apply", "no_reply"],
    ["caution", ""],
    ["not_recommended", "skipped"],
    ["analysis_pending", ""]
  ];
  for (const [recommendation, status] of jobs) {
    const jobId = upsertJob(database, job(recommendation), batchId);
    if (status) markCandidateJob(database, { profileId, planId, jobId, status });
  }
  for (let index = 1; index <= 13; index += 1) {
    upsertJob(database, job("analysis_pending", `Named-${String(index).padStart(2, "0")}`, `named-${index}`), batchId);
  }
  for (let index = 1; index <= 2; index += 1) {
    upsertJob(database, job("analysis_pending", " ", `blank-${index}`), batchId);
  }
}

function job(recommendation, keyword = "RAG 工程师", sourceSuffix = recommendation) {
  const pending = recommendation === "analysis_pending";
  return {
    source: "outcome-analytics-smoke",
    sourceId: `${BAIT.jobOrSourceId}-${sourceSuffix}`,
    keyword,
    title: `${BAIT.title}-${recommendation}`,
    company: BAIT.company,
    location: "上海",
    salary: "15-25K",
    experience: "1-3年",
    education: "本科",
    url: BAIT.url,
    tags: [],
    description: BAIT.jd,
    analysis: {
      semanticStatus: pending ? "pending" : "complete",
      recommendation: pending ? "" : recommendation,
      recommendationSchemaVersion: 2,
      fitLevel: "fit",
      confidence: 0.9,
      evidence: { jd: [], resume: [] },
      hardBlockers: [],
      rawModelOutput: BAIT.rawModel
    }
  };
}

function extractAnalyticsPanel(body) {
  const match = body.match(/<section class="panel outcome-analytics">([\s\S]*?)<\/section>/);
  assert(match, "outcome analytics panel must remain in its fixed slot");
  return match[1];
}

function extractAnalyticsTable(panel, className) {
  const match = panel.match(new RegExp(`<table class="${className}">([\\s\\S]*?)<\\/table>`));
  assert(match, "analytics table must remain inside the analytics panel");
  return match[1];
}

function extractTableBodyRows(table) {
  const body = table.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || "";
  return body.match(/<tr>/g) || [];
}

function assertTierMetrics(table, label, expected) {
  const row = table.match(new RegExp(`<tr><th scope="row">${label}<\\/th>((?:<td>\\d+<\\/td>){7,})<\\/tr>`));
  assert(row, "analytics tier row is present");
  const values = [...row[1].matchAll(/<td>(\d+)<\/td>/g)].map((match) => Number(match[1]));
  assert.deepStrictEqual(values.slice(0, expected.length), expected, "analytics tier metrics match the seeded aggregate data");
}

function assertKeywordRowsReconcile(table) {
  const rows = [...table.matchAll(/<tr><th scope="row">[\s\S]*?<\/th>((?:<td>\d+<\/td>){8})<\/tr>/g)];
  assert.strictEqual(rows.length, 13, "every keyword row includes total and reconcilable outcome dimensions");
  for (const row of rows) {
    const [total, unresolved, applied, skipped, noReply, interview, rejectedOrInvalid, salaryMismatch] = [...row[1].matchAll(/<td>(\d+)<\/td>/g)].map((match) => Number(match[1]));
    assert.strictEqual(total, unresolved + applied + skipped + noReply + interview + rejectedOrInvalid + salaryMismatch, "keyword outcome dimensions reconcile with its total");
  }
}

function assertAnalyticsPanelPlacement(body, label) {
  const counters = body.indexOf('class="pool-tab active"');
  const panel = body.indexOf('class="panel outcome-analytics"');
  const retryControls = body.indexOf('action="/api/analyze-jobs"');
  const jobCards = body.indexOf('<article class="job">');
  assert(counters >= 0, `${label} retains the queue counters marker`);
  assert(panel > counters, `${label} follows the queue counters`);
  assert(retryControls > panel, `${label} precedes retry controls`);
  assert(jobCards > panel, `${label} precedes job cards`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
