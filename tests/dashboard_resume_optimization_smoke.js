const assert = require("node:assert/strict");
const { openDb, saveProfileAnalysis } = require("../src/core/storage");
const { createDashboardServer } = require("../src/dashboard/server");

const logger = {
  info() {}, warn() {}, error() {},
  requestId() { return "dashboard-resume-optimization-smoke"; },
  listRecent() { return []; }
};

(async () => {
  const db = openDb(":memory:");
  const owner = saveProfileAnalysis(db, {
    profile: {
      candidate: { name: "页面候选人", city: "广州", targetTitles: ["AI 应用工程师"] },
      skills: [{ name: "Node.js" }],
      projects: [{ name: "知识库" }]
    },
    document: {
      originalFileName: "resume.txt",
      format: "text",
      contentHash: "dashboard-resume-source",
      text: "个人总结\n参与知识库开发",
      diagnostics: {}
    },
    searchPlan: {
      name: "页面测试方案",
      cities: ["广州"],
      directions: ["AI 应用工程师"],
      keywords: [{ word: "知识库", priority: "A" }]
    }
  });
  const calls = { dashboard: [], create: [], save: [], activate: [] };
  const selectedDraft = {
    id: 41,
    profileId: owner.profileId,
    sourceResumeVersionId: owner.resumeVersionId,
    sourceResumeDocumentId: owner.resumeDocumentId,
    sourceContentHash: "dashboard-resume-source",
    sourceText: "个人总结\n参与知识库开发",
    targetJobIds: [71],
    headline: "突出 <目标> 岗位相关经验",
    evidenceCatalog: [
      { id: "R1", kind: "resume", text: "参与知识库开发" },
      { id: "J1", kind: "job", text: "需要 Node.js <script>alert(1)</script>" }
    ],
    suggestions: [{
      id: "S1",
      operation: "replace",
      originalText: "参与知识库开发",
      proposedText: "参与 Node.js <知识库> 开发",
      reason: "让相关技术更清楚",
      evidenceIds: ["R1", "J1"],
      decision: "pending",
      userText: ""
    }],
    finalText: "个人总结\n参与知识库开发",
    status: "draft",
    modelIdentity: { provider: "mock", model: "offline" },
    createdAt: "2026-08-29T04:00:00.000Z",
    updatedAt: "2026-08-29T04:00:00.000Z"
  };
  const service = {
    dashboard(input) {
      calls.dashboard.push(input);
      return {
        profile: { id: owner.profileId, displayName: "页面候选人" },
        plan: { id: owner.planId, profileId: owner.profileId, name: "页面测试方案" },
        resumes: [{ id: owner.resumeVersionId, name: "基础简历", isActive: true, resumeTextExcerpt: "个人总结\n参与知识库开发" }],
        jobs: [{ id: 71, title: "AI <应用> 工程师", company: "示例科技", description: "完整 JD", analysis: { semanticStatus: "complete" } }],
        drafts: [selectedDraft],
        selectedDraft,
        funnelDiagnosis: { strength: "facts", headline: "当前仅展示事实" }
      };
    },
    async createDraft(input) {
      calls.create.push(input);
      return selectedDraft;
    },
    getDraft() { return selectedDraft; },
    saveDraft(input) {
      calls.save.push(input);
      return { ...selectedDraft, finalText: "个人总结\n参与 Node.js 知识库开发" };
    },
    activateDraft(input) {
      calls.activate.push(input);
      return { ...selectedDraft, status: "activated", resultResumeVersionId: 88 };
    }
  };
  const server = createDashboardServer({
    db,
    forceMock: true,
    allowOfflineMock: true,
    logger,
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
    resumeOptimizationService: service
  });
  const baseUrl = await listen(server);
  try {
    const page = await request(baseUrl, `/resume-optimization?planId=${owner.planId}&draftId=41`);
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>定向简历优化<\/title>/);
    assert.match(page.body, /aria-current="page">定向简历<\/a>/);
    assert.deepEqual(calls.dashboard, [{ profileId: owner.profileId, planId: owner.planId, draftId: 41 }]);
    assert.match(page.body, /基础简历/);
    assert.match(page.body, /AI &lt;应用&gt; 工程师/);
    assert.doesNotMatch(page.body, /AI <应用> 工程师/);
    assert.match(page.body, /突出 &lt;目标&gt; 岗位相关经验/);
    assert.match(page.body, /参与 Node\.js &lt;知识库&gt; 开发/);
    assert.doesNotMatch(page.body, /<script>alert\(1\)<\/script>/);
    assert.match(page.body, /name="decision_S1" value="accepted"/);
    assert.match(page.body, /name="decision_S1" value="edited"/);
    assert.match(page.body, /name="decision_S1" value="ignored"/);
    assert.match(page.body, /name="userText_S1"/);
    assert.match(page.body, /复制当前全文/);
    assert.match(page.body, /启用为新版本/);
    assert.doesNotMatch(page.body, /确认启用|二次确认/);

    const create = await request(baseUrl, "/api/resume-optimization", {
      method: "POST",
      body: new URLSearchParams([
        ["planId", String(owner.planId)],
        ["sourceResumeVersionId", String(owner.resumeVersionId)],
        ["jobIds", "71"]
      ]).toString()
    });
    assert.equal(create.status, 303);
    assert.equal(create.headers.location, `/resume-optimization?planId=${owner.planId}&draftId=41`);
    assert.deepEqual(calls.create, [{
      profileId: owner.profileId,
      planId: owner.planId,
      sourceResumeVersionId: owner.resumeVersionId,
      jobIds: [71]
    }]);

    const save = await request(baseUrl, "/api/resume-optimization/save", {
      method: "POST",
      body: new URLSearchParams({
        planId: String(owner.planId),
        draftId: "41",
        decision_S1: "edited",
        userText_S1: "参与 Node.js 知识库开发"
      }).toString()
    });
    assert.equal(save.status, 303);
    assert.equal(calls.save.length, 1);
    assert.deepEqual(calls.save[0].decisions, { S1: { decision: "edited", userText: "参与 Node.js 知识库开发" } });

    const activate = await request(baseUrl, "/api/resume-optimization/activate", {
      method: "POST",
      body: new URLSearchParams({ planId: String(owner.planId), draftId: "41" }).toString()
    });
    assert.equal(activate.status, 303);
    assert.equal(calls.activate.length, 1, "activation must call the service exactly once without an intermediate confirmation page");
    assert.deepEqual(calls.activate[0], { profileId: owner.profileId, draftId: 41 });

    console.log("dashboard_resume_optimization_smoke ok");
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
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text()
  };
}
