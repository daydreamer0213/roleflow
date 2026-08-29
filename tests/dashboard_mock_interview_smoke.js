const assert = require("node:assert/strict");
const storage = require("../src/core/storage");
const { openDb, saveProfileAnalysis } = storage;
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
    sessionKind: "resume_general",
    jobId: null,
    resumeVersionId: owner.resumeVersionId,
    context: {
      sessionKind: "resume_general",
      job: null,
      resume: { versionId: owner.resumeVersionId, name: "基础简历", text: "参与知识库开发" },
      resumeEvidenceCatalog: [{ id: "R1", kind: "resume", text: "参与知识库开发" }]
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
      resumeEvidenceIds: ["R1"],
      basedOnTurnNumber: null, answerText: "我参与了 <script>alert(1)</script> 知识库开发。",
      answerReview: { conclusion: "相关", strengths: ["直接"], improvements: ["补充贡献"], turnNumbers: [1] },
      retries: [{
        id: 81, turnNumber: 1, retryIndex: 1,
        answerText: "我参与知识库开发，并负责接口联调。",
        review: { turnNumber: 1, conclusion: "更具体", improved: true, strengths: ["补充行动"], remainingImprovements: ["补充结果"] }
      }]
    }]
  };
  let answerFailure = null;
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
    async answerTurn(input) { calls.answer.push(input); if (answerFailure) throw answerFailure; return selectedSession; },
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
    assert.match(page.body, /简历通用面试/);
    assert.match(page.body, /岗位专项面试/);
    assert.match(page.body, /value="resume_general" checked/);
    assert.match(page.body, /这道题来自简历/);
    assert.match(page.body, /参与知识库开发/);
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
        planId: String(owner.planId), sessionKind: "resume_general", resumeVersionId: String(owner.resumeVersionId),
        type: "mixed", difficulty: "standard", plannedQuestions: "5"
      }).toString()
    });
    assert.equal(start.status, 303);
    assert.equal(start.headers.location, `/interview?planId=${owner.planId}&sessionId=52`);
    assert.deepEqual(calls.start[0], {
      profileId: owner.profileId, planId: owner.planId, sessionKind: "resume_general", jobId: null,
      resumeVersionId: owner.resumeVersionId,
      settings: { type: "mixed", difficulty: "standard", plannedQuestions: 5 }
    });

    const specificStart = await request(baseUrl, "/api/interview/start", {
      method: "POST",
      body: new URLSearchParams({
        planId: String(owner.planId), sessionKind: "job_specific", jobId: "71",
        resumeVersionId: String(owner.resumeVersionId), type: "mixed", difficulty: "standard", plannedQuestions: "5"
      }).toString()
    });
    assert.equal(specificStart.status, 303);
    assert.deepEqual(calls.start[1], {
      profileId: owner.profileId, planId: owner.planId, sessionKind: "job_specific", jobId: 71,
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

    answerFailure = new Error("simulated interview model failure");
    const unhandled = [];
    const recordUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", recordUnhandled);
    try {
      const failedAnswer = await request(baseUrl, "/api/interview/answer", {
        method: "POST",
        timeoutMs: 1_000,
        body: new URLSearchParams({ planId: String(owner.planId), sessionId: "51", turnNumber: "1", answerText: "失败时保留" }).toString()
      });
      assert.equal(failedAnswer.status, 500, "async interview failures must reach the dashboard error boundary");
      assert.match(failedAnswer.body, /requestId|请求|错误编号/);
      const health = await request(baseUrl, `/interview?planId=${owner.planId}&sessionId=51`);
      assert.equal(health.status, 200, "dashboard must remain available after an interview workflow failure");
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
    assert.equal(unhandled.length, 0, "interview failure must not become an unhandled rejection");
    await verifyDefaultServiceConcurrency();

    console.log("dashboard_mock_interview_smoke ok");
  } finally {
    await close(server);
    db.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function verifyDefaultServiceConcurrency() {
  const db = openDb(":memory:");
  const owner = saveProfileAnalysis(db, {
    profile: { candidate: { name: "并发候选人", city: "广州", targetTitles: ["AI 应用工程师"] } },
    document: {
      originalFileName: "concurrent.txt", format: "text", contentHash: "interview-concurrent-resume",
      text: "参与企业知识库开发", diagnostics: {}
    },
    searchPlan: {
      name: "并发完成方案", cities: ["广州"], directions: ["AI 应用工程师"],
      keywords: [{ word: "知识库", priority: "A" }]
    }
  });
  const batch = storage.createBatch(db, "boss", "知识库", "interview concurrency", {
    profileId: owner.profileId, searchPlanId: owner.planId
  });
  const jobId = storage.upsertJob(db, {
    source: "boss", sourceId: "interview-dashboard-concurrent", keyword: "知识库",
    title: "AI 应用工程师", company: "示例科技", location: "广州", salary: "15-25K",
    experience: "1-3年", education: "本科", bossActiveText: "今日活跃", bossActiveDays: 0,
    url: "https://www.zhipin.com/job_detail/interview-dashboard-concurrent.html", tags: ["Node.js"],
    description: "负责企业知识库开发、检索评估和接口交付，要求具备完整项目经验。",
    score: 18, level: "可投", matches: ["Node.js"], risks: [], qualityTags: [],
    analysis: { provider: "mock", model: "offline", semanticStatus: "complete", recommendation: "apply" }
  }, batch);
  const session = storage.createMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionKind: "job_specific", jobId, resumeVersionId: owner.resumeVersionId,
    context: {
      sessionKind: "job_specific",
      job: { id: jobId, title: "AI 应用工程师" },
      resume: { versionId: owner.resumeVersionId, text: "参与企业知识库开发" },
      resumeEvidenceCatalog: [{ id: "R1", kind: "resume", text: "参与企业知识库开发" }]
    },
    settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 },
    initialQuestion: { text: "第一题", focus: "intro", resumeEvidenceIds: ["R1"], basedOnTurnNumber: null, answerEvidence: "" }
  });
  const answers = ["第一题回答", "第二题回答", "第三题回答"];
  for (let index = 0; index < answers.length; index += 1) {
    const turnNumber = index + 1;
    storage.answerMockInterviewTurn(db, {
      profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber,
      answerText: answers[index],
      answerReview: { conclusion: "已复盘", strengths: [], improvements: [], turnNumbers: [turnNumber] },
      nextQuestion: turnNumber < 3 ? {
        text: `你提到“${answers[index]}”，请继续。`, focus: "project",
        resumeEvidenceIds: ["R1"],
        basedOnTurnNumber: turnNumber, answerEvidence: answers[index]
      } : null
    });
  }
  let reportCalls = 0;
  const adapter = {
    provider: "counted",
    model: "dashboard-concurrency",
    async reviewMockInterview() {
      reportCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        conclusion: "完成", strengths: ["相关"], improvements: ["补充结果"],
        followUpRisks: [{ turnNumber: 2, reason: "需要细节" }],
        retryRecommendations: [{ turnNumber: 2, reason: "重新组织" }],
        answerStructures: [{ turnNumber: 2, outline: ["背景", "行动", "结果"] }]
      };
    }
  };
  const server = createDashboardServer({
    db,
    forceMock: true,
    allowOfflineMock: true,
    logger,
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
    mockInterviewAdapterResolver: () => adapter
  });
  const baseUrl = await listen(server);
  const body = new URLSearchParams({ planId: String(owner.planId), sessionId: String(session.id) }).toString();
  try {
    const [first, second] = await Promise.all([
      request(baseUrl, "/api/interview/finish", { method: "POST", body }),
      request(baseUrl, "/api/interview/finish", { method: "POST", body })
    ]);
    assert.equal(first.status, 303);
    assert.equal(second.status, 303);
    assert.equal(reportCalls, 1, "parallel HTTP finishes must share one Dashboard service and one model call");
  } finally {
    await close(server);
    db.close();
  }
}

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
  const controller = options.timeoutMs ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
  if (timeout && typeof timeout.unref === "function") timeout.unref();
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      method: options.method || "GET",
      headers: options.method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
      body: options.body,
      redirect: "manual",
      signal: controller?.signal
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
}
