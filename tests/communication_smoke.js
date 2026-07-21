const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  openDb,
  saveProfileAnalysis,
  createBatch,
  upsertJob,
  listReportJobs,
  getLatestMainScanBatchId,
  buildFeedbackSummary,
  listCandidateFacts
} = require("../src/core/storage");
const { createDashboardServer } = require("../src/dashboard/server");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-communication-"));
fs.mkdirSync(path.join(root, "configs"), { recursive: true });
for (const name of ["profile.example.json", "keywords.yaml", "scoring.yaml"]) {
  fs.copyFileSync(path.resolve(__dirname, "..", "configs", name), path.join(root, "configs", name));
}
const dbPath = path.join(root, "jobs.sqlite");
const db = openDb(dbPath);
let server;

(async () => {
  try {
    const profile = {
      candidate: { name: "测试候选人", city: "广州", targetTitles: ["AI应用开发工程师"], expectedSalary: "10-18K" },
      education: [{ school: "测试大学", degree: "本科", major: "电子信息" }],
      experiences: [],
      skills: [{ name: "Python", evidence: ["KnowledgeFlow"] }, { name: "RAG", evidence: ["KnowledgeFlow"] }],
      projects: [{ name: "KnowledgeFlow", roleBoundary: "独立项目", canSay: ["LangGraph 多 Agent 工作流"] }],
      credentials: [], strengths: []
    };
    const plan = { name: "广州 AI", cities: ["广州"], directions: ["AI应用开发"], keywords: [{ word: "AI应用开发", priority: "A" }], experience: ["1-3年"], jobTypes: ["全职"], bossActiveDays: 3 };
    const saved = saveProfileAnalysis(db, {
      profile,
      document: { originalFileName: "resume.txt", format: "text", contentHash: "communication-resume", text: "教育经历 测试大学 本科。项目经历 KnowledgeFlow，使用 Python、RAG 和 LangGraph 完成多 Agent 工作流。专业技能 Python RAG。".repeat(3), diagnostics: {} },
      searchPlan: plan
    });
    const batchId = createBatch(db, "boss", "AI应用开发", "communication", {
      profileId: saved.profileId,
      searchPlanId: saved.planId,
      filterSnapshot: { execution: { scanKind: "daily" } }
    });
    const analysis = {
      provider: "mock", model: "offline-structured-mock", semanticStatus: "complete", decisionSource: "model",
      recommendation: "apply", fitLevel: "A", confidence: 0.9, realRoleType: "ai_application", businessScenario: "企业知识库 RAG",
      coreRequirements: ["Python", "RAG"], hiddenRisks: [], primaryProjects: ["KnowledgeFlow"], recommendedResumeVersion: "main",
      fitReasons: ["岗位 RAG 职责与 KnowledgeFlow 项目对应"], missingPoints: [], blockingGaps: [], riskQuestions: [],
      evidence: { jd: ["负责企业知识库 RAG 与 Agent 应用开发"], resume: ["KnowledgeFlow 使用 Python、RAG 与 LangGraph"] }
    };
    const jobId = upsertJob(db, {
      source: "boss", sourceId: "communication-job", keyword: "AI应用开发", title: "AI应用开发工程师", company: "测试公司", location: "广州",
      salary: "10-18K", experience: "1-3年", education: "本科", bossActiveText: "今日活跃", bossActiveDays: 0,
      url: "https://www.zhipin.com/job_detail/communication.html", tags: ["Python", "RAG"],
      description: "负责企业知识库 RAG 检索链路、Agent 工具调用与 FastAPI 接口开发，需要 Python 项目经验。".repeat(4),
      score: 20, level: "优先", matches: ["Python", "RAG"], risks: [], qualityTags: ["work_schedule_double"], analysis
    }, batchId);

    server = createDashboardServer({ db, root, dbPath, forceMock: true });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const queueHtml = await (await fetch(`${base}/queue?planId=${saved.planId}`)).text();
    assert(queueHtml.includes("生成定制招呼语"));

    const greeting = await post(base, "/api/communication", { mode: "greeting", jobId, profileId: saved.profileId, planId: saved.planId });
    const greetingHtml = await greeting.text();
    assert.strictEqual(greeting.status, 200, greetingHtml);
    assert(greetingHtml.includes("KnowledgeFlow"));
    assert(greetingHtml.includes("企业知识库"));

    const missingGap = await post(base, "/api/communication", { mode: "hr_reply", jobId, profileId: saved.profileId, planId: saved.planId, hrMessage: "为什么中间 GAP 了一年？" });
    const missingGapHtml = await missingGap.text();
    assert.strictEqual(missingGap.status, 200, missingGapHtml);
    assert(missingGapHtml.includes("这段 GAP 期间你实际在做什么"));
    assert(!missingGapHtml.includes("持续学习并做项目"), "缺少事实时不能生成猜测回复");

    const gapFact = "这段时间主要做职业方向探索，并系统学习和实践 AI 应用开发。";
    const answeredGap = await post(base, "/api/communication", { mode: "hr_reply", jobId, profileId: saved.profileId, planId: saved.planId, hrMessage: "为什么中间 GAP 了一年？", factKey: "gap", factValue: gapFact });
    const answeredGapHtml = await answeredGap.text();
    assert.strictEqual(answeredGap.status, 200, answeredGapHtml);
    assert(answeredGapHtml.includes(gapFact));
    assert.strictEqual(listCandidateFacts(db, saved.profileId)[0].source, "user_provided");

    await post(base, "/api/mark", { jobId, profileId: saved.profileId, planId: saved.planId, status: "applied" });
    await post(base, "/api/feedback", { jobId, profileId: saved.profileId, planId: saved.planId, reasonCode: "company_mismatch", note: "公司信息不足" });
    assert.strictEqual(listReportJobs(db, { planId: saved.planId, batch: "all", profileId: saved.profileId })[0].applicationStatus, "applied", "推荐反馈不能覆盖投递状态");
    assert.strictEqual(buildFeedbackSummary(db, { profileId: saved.profileId }).reasonCounts.company_mismatch, 1);

    await post(base, "/api/mark", { jobId, profileId: saved.profileId, planId: saved.planId, status: "no_reply" });
    const noReplyHtml = await (await fetch(`${base}/queue?planId=${saved.planId}&pool=no_reply`)).text();
    assert(noReplyHtml.includes("无回复待跟进"));
    assert(noReplyHtml.includes("生成一次跟进文案"));
    const followUp = await post(base, "/api/communication", { mode: "follow_up", jobId, profileId: saved.profileId, planId: saved.planId });
    const followUpHtml = await followUp.text();
    assert.strictEqual(followUp.status, 200, followUpHtml);
    assert(followUpHtml.includes("KnowledgeFlow"));

    const failedBatchId = createBatch(db, "boss", "analysis-source", "analysis-source", {
      profileId: saved.profileId,
      searchPlanId: saved.planId,
      filterSnapshot: { execution: { scanKind: "daily" } }
    });
    const failedJobId = upsertJob(db, {
      source: "boss", sourceId: "analysis-retry-job", keyword: "AI application", title: "AI Application Engineer",
      company: "Retry Test", location: plan.cities[0], salary: "10-18K", experience: plan.experience[0], education: "本科",
      bossActiveText: "今日活跃", bossActiveDays: 0, url: "https://www.zhipin.com/job_detail/analysis-retry.html",
      tags: ["Python", "RAG"], description: "Build Python RAG and Agent applications with FastAPI, vector search, retrieval evaluation, API integration, testing, and production diagnostics. ".repeat(3),
      score: 20, level: "可投", matches: ["Python", "RAG"], risks: [], qualityTags: [],
      analysis: { provider: "openai_compatible", model: "test-model", semanticStatus: "failed", decisionSource: "analysis_pending", recommendation: "review", fitLevel: "C", error: "timeout", errorCode: "MODEL_TIMEOUT", evidence: { jd: [], resume: [] } }
    }, failedBatchId);
    const pendingHtml = await (await fetch(`${base}/queue?planId=${saved.planId}&pool=analysis_pending`)).text();
    assert(pendingHtml.includes("重试语义分析"));
    const retriedResponse = await post(base, "/api/analyze-job", { jobId: failedJobId, profileId: saved.profileId, planId: saved.planId });
    const retriedBody = await retriedResponse.text();
    assert.strictEqual(retriedResponse.status, 303, retriedBody);
    const retriedJob = listReportJobs(db, { planId: saved.planId, batch: "all", profileId: saved.profileId, limit: 100 }).find((job) => job.id === failedJobId);
    assert.strictEqual(retriedJob.analysis.semanticStatus, "rule_only");
    assert.strictEqual(db.prepare("SELECT keyword FROM batches ORDER BY id DESC LIMIT 1").get().keyword, "analysis-retry");
    assert.strictEqual(getLatestMainScanBatchId(db, { planId: saved.planId }), failedBatchId, "analysis retry must not become the latest main scan");

    const bulkJobIds = ["bulk-a", "bulk-b"].map((sourceId) => upsertJob(db, {
      source: "boss", sourceId, keyword: "AI application", title: `AI Application Engineer ${sourceId}`,
      company: "Bulk Retry Test", location: plan.cities[0], salary: "10-18K", experience: plan.experience[0], education: "本科",
      bossActiveText: "今日活跃", bossActiveDays: 0, url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
      tags: ["Python", "RAG"], description: "Build Python RAG and Agent applications with FastAPI, vector search, retrieval evaluation, API integration, testing, and production diagnostics. ".repeat(3),
      score: 20, level: "可投", matches: ["Python", "RAG"], risks: [], qualityTags: [],
      analysis: { provider: "openai_compatible", model: "test-model", semanticStatus: "failed", decisionSource: "analysis_pending", recommendation: "review", fitLevel: "C", error: "timeout", errorCode: "MODEL_TIMEOUT", evidence: { jd: [], resume: [] } }
    }, failedBatchId));
    const bulkPendingHtml = await (await fetch(`${base}/queue?planId=${saved.planId}&pool=analysis_pending`)).text();
    assert(bulkPendingHtml.includes("批量重试全部待分析岗位"));
    const bulkResponse = await post(base, "/api/analyze-jobs", { planId: saved.planId });
    const bulkBody = await bulkResponse.text();
    assert.strictEqual(bulkResponse.status, 303, bulkBody);
    const bulkJobs = listReportJobs(db, { planId: saved.planId, batch: "all", profileId: saved.profileId, limit: 100 })
      .filter((job) => bulkJobIds.includes(job.id));
    assert.strictEqual(bulkJobs.length, 2);
    assert(bulkJobs.every((job) => job.analysis.semanticStatus === "rule_only"));
    assert.strictEqual(db.prepare("SELECT keyword FROM batches ORDER BY id DESC LIMIT 1").get().keyword, "analysis-retry-bulk");
    assert.strictEqual(getLatestMainScanBatchId(db, { planId: saved.planId }), failedBatchId, "bulk analysis retry must not become the latest main scan");
    console.log("communication_smoke ok");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function post(base, route, values) {
  return fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])).toString(),
    redirect: "manual"
  });
}
