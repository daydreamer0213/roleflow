const assert = require("node:assert/strict");
const { openDb, saveProfileAnalysis } = require("../src/core/storage");
const { createDashboardServer } = require("../src/dashboard/server");

const logger = {
  info() {}, warn() {}, error() {},
  requestId() { return "dashboard-mock-interview-smoke"; },
  listRecent() { return []; }
};

(async () => {
  const db = openDb(":memory:");
  const owner = saveProfileAnalysis(db, {
    profile: {
      candidate: { name: "页面候选人", city: "广州", targetTitles: ["AI 应用工程师"] },
      skills: [{ name: "Node.js" }], projects: [{ name: "知识库" }]
    },
    document: {
      originalFileName: "resume.txt", format: "text", contentHash: "interview-page-resume",
      text: "个人总结\n参与知识库开发", diagnostics: {}
    },
    searchPlan: {
      name: "页面测试方案", cities: ["广州"], directions: ["AI 应用工程师"],
      keywords: [{ word: "知识库", priority: "A" }]
    }
  });
  const calls = { dashboard: [], start: [], answer: [], finish: [], retry: [] };
  const selectedSession = {
    id: 51,
    profileId: owner.profileId,
    jobId: 71,
    resumeVersionId: owner.resumeVersionId,
    context: {
      job: { id: 71, title: "AI <应用> 工程师", company: "示例科技", description: "完整 JD" },
      resume: { versionId: owner.resumeVersionId, name: "基础简历", text: "参与知识库开发" }
    },
    settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 },
    status: "completed",
    report: {
      conclusion: "岗位动机清楚，但项目贡献要更具体。",
      strengths: ["回答直接", "岗位相关"], improvements: ["补充个人行动"],
      followUpRisks: [{ turnNumber: 1, reason: "贡献边界会被追问" }],
      retryRecommendations: [{ turnNumber: 1, reason: "用行动和结果重答" }],
      answerStructures: [{ turnNumber: 1, outline: ["背景", "行动", "结果"] }]
    },
    turns: [{
      id: 61, turnNumber: 1, questionText: "请介绍相关项目。", questionFocus: "project",
      basedOnTurnNumber: null, answerText: "我参与了 <script>alert(1)</script> 知识库开发。",
      answerReview: { conclusion: "相关", strengths: ["直接"], improvements: ["补充贡献"], turnNumbers: [1] },
      retries: [{
        id: 81, turnNumber: 1, retryIndex: 1,
        answerText: "我参与知识库开发，并负责接口联调。",
        review: { turnNumber: 1, conclusion: "更具体", improved: true, strengths: ["补充行动"], remainingImprovements: ["补充结果"] }
      }]
    }]
  };
  const service = {
    dashboard(input) {
      calls.dashboard.push(input);
      return {
        profile: { id: owner.profileId, displayName: "页面候选人" },
        plan: { id: owner.planId, profileId: owner.profileId, name: "页面测试方案" },
        resumes: [{ id: owner.resumeVersionId, name: "基础简历", isActive: true }],
        jobs: [{ id: 71, title: "AI <应用> 工程师", company: "示例科技", description: "完整 JD", analysis: { semanticStatus: "complete" } }],
        sessions: [selectedSession],
        selectedSession
      };
    },
    async startSession(input) { calls.start.push(input); return { id: 52 }; },
    async answerTurn(input) { calls.answer.push(input); return selectedSession; },
    async finishSession(input) { calls.finish.push(input); return selectedSession; },
    async retryTurn(input) { calls.retry.push(input); return selectedSession.turns[0].retries[0]; }
  };
  let readinessCalls = 0;
  const server = createDashboardServer({
    db,
    forceMock: true,
    allowOfflineMock: true,
    logger,
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
    browserReadinessProbe: async () => { readinessCalls += 1; throw new Error("local interview must not probe browser"); },
    mockInterviewService: service
  });
  const baseUrl = await listen(server);
  try {
    const page = await request(baseUrl, `/interview?planId=${owner.planId}&sessionId=51`);
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>模拟面试训练<\/title>/);
    assert.match(page.body, /aria-current="page">模拟面试<\/a>/);
    assert.match(page.body, /无需面试邀请/);
    assert.deepEqual(calls.dashboard, [{ profileId: owner.profileId, planId: owner.planId, sessionId: 51 }]);
    assert.match(page.body, /基础简历/);
    assert.match(page.body, /AI &lt;应用&gt; 工程师/);
    assert.doesNotMatch(page.body, /AI <应用> 工程师/);
    assert.match(page.body, /岗位动机清楚/);
    assert(page.body.indexOf("岗位动机清楚") < page.body.indexOf("请介绍相关项目"), "completed report must appear before transcript");
    assert.match(page.body, /我参与了 &lt;script&gt;alert\(1\)&lt;\/script&gt; 知识库开发/);
    assert.doesNotMatch(page.body, /<script>alert\(1\)<\/script>/);
    assert.match(page.body, /原回答/);
    assert.match(page.body, /我参与知识库开发，并负责接口联调/);
    assert.match(page.body, /name="sessionId" value="51"/);
    assert.match(page.body, /name="turnNumber" value="1"/);

    const start = await request(baseUrl, "/api/interview/start", {
      method: "POST",
      body: new URLSearchParams({
        planId: String(owner.planId), jobId: "71", resumeVersionId: String(owner.resumeVersionId),
        type: "mixed", difficulty: "standard", plannedQuestions: "5"
      }).toString()
    });
    assert.equal(start.status, 303);
    assert.equal(start.headers.location, `/interview?planId=${owner.planId}&sessionId=52`);
    assert.deepEqual(calls.start[0], {
      profileId: owner.profileId, planId: owner.planId, jobId: 71,
      resumeVersionId: owner.resumeVersionId,
      settings: { type: "mixed", difficulty: "standard", plannedQuestions: 5 }
    });

    const answer = await request(baseUrl, "/api/interview/answer", {
      method: "POST",
      body: new URLSearchParams({ planId: String(owner.planId), sessionId: "51", turnNumber: "1", answerText: "我的回答" }).toString()
    });
    assert.equal(answer.status, 303);
    assert.deepEqual(calls.answer[0], { profileId: owner.profileId, planId: owner.planId, sessionId: 51, turnNumber: 1, answerText: "我的回答" });

    const finish = await request(baseUrl, "/api/interview/finish", {
      method: "POST", body: new URLSearchParams({ planId: String(owner.planId), sessionId: "51" }).toString()
    });
    assert.equal(finish.status, 303);
    assert.deepEqual(calls.finish[0], { profileId: owner.profileId, planId: owner.planId, sessionId: 51 });

    const retry = await request(baseUrl, "/api/interview/retry", {
      method: "POST",
      body: new URLSearchParams({ planId: String(owner.planId), sessionId: "51", turnNumber: "1", answerText: "我的重答" }).toString()
    });
    assert.equal(retry.status, 303);
    assert.deepEqual(calls.retry[0], { profileId: owner.profileId, planId: owner.planId, sessionId: 51, turnNumber: 1, answerText: "我的重答" });
    assert.equal(readinessCalls, 0, "local interview workflow must not inspect browser readiness");

    console.log("dashboard_mock_interview_smoke ok");
  } finally {
    await close(server);
    db.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: options.method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
    body: options.body,
    redirect: "manual"
  });
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
}
