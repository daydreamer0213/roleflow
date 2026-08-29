const assert = require("node:assert/strict");
const vm = require("node:vm");
const { openDb, saveProfileAnalysis } = require("../src/core/storage");
const { createDashboardServer } = require("../src/dashboard/server");
const { RESUME_OPTIMIZATION_SCRIPT } = require("../src/dashboard/pages/resume_optimization");

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
    targetDirection: "AI 应用工程师",
    targetJobIds: [71],
    headline: "突出 <目标> 岗位相关经验",
    evidenceCatalog: [
      { id: "R1", kind: "resume", text: "参与知识库开发" },
      { id: "J1", kind: "job", text: "需要 Node.js <script>alert(1)</script>" }
    ],
    changeLedger: [{
      id: "S1",
      operation: "replace",
      originalText: "参与知识库开发",
      proposedText: "参与 Node.js <知识库> 开发",
      reason: "让相关技术更清楚",
      evidenceIds: ["R1", "J1"],
      editingPrinciple: "jd_vocabulary",
      decision: "accepted",
      userText: ""
    }],
    generatedText: "个人总结\n参与 Node.js <知识库> 开发",
    finalText: "个人总结\n参与 Node.js <知识库> 开发\n用户已校对",
    draftFormat: "whole_draft",
    userEditedAt: "2026-08-29T04:05:00.000Z",
    status: "draft",
    modelIdentity: { provider: "mock", model: "offline" },
    createdAt: "2026-08-29T04:00:00.000Z",
    updatedAt: "2026-08-29T04:00:00.000Z"
  };
  let createFailure = null;
  const service = {
    dashboard(input) {
      calls.dashboard.push(input);
      return {
        profile: { id: owner.profileId, displayName: "页面候选人" },
        plan: { id: owner.planId, profileId: owner.profileId, name: "页面测试方案", plan: { directions: ["AI 应用工程师"] } },
        resumes: [{ id: owner.resumeVersionId, name: "基础简历", isActive: true, resumeTextExcerpt: "个人总结\n参与知识库开发" }],
        jobs: [{ id: 71, title: "AI <应用> 工程师", company: "示例科技", description: "完整 JD", analysis: { semanticStatus: "complete" } }],
        directions: ["AI 应用工程师"],
        selectedJobs: [{ id: 71, title: "AI <应用> 工程师", company: "示例科技" }],
        drafts: [selectedDraft],
        selectedDraft,
        funnelDiagnosis: { strength: "facts", headline: "当前仅展示事实" }
      };
    },
    async createDraft(input) {
      calls.create.push(input);
      if (createFailure) throw createFailure;
      return selectedDraft;
    },
    getDraft() { return selectedDraft; },
    async saveDraft(input) {
      calls.save.push(input);
      if (saveGate) await saveGate;
      return { ...selectedDraft, finalText: "个人总结\n参与 Node.js 知识库开发" };
    },
    activateDraft(input) {
      calls.activate.push(input);
      return { ...selectedDraft, status: "activated", resultResumeVersionId: 88 };
    }
  };
  let releaseSave;
  let saveGate = null;
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
    assert.match(page.body, /目标投递方向/);
    assert.match(page.body, /本次参考岗位/);
    assert.match(page.body, /完整简历草稿/);
    assert.match(page.body, /name="finalText"/);
    assert.match(page.body, /用户已修改/);
    assert.match(page.body, /修改了什么/);
    assert.match(page.body, /岗位用词对齐/);
    assert.match(page.body, /AI &lt;应用&gt; 工程师/);
    assert.doesNotMatch(page.body, /AI <应用> 工程师/);
    assert.match(page.body, /突出 &lt;目标&gt; 岗位相关经验/);
    assert.match(page.body, /参与 Node\.js &lt;知识库&gt; 开发/);
    assert.doesNotMatch(page.body, /<script>alert\(1\)<\/script>/);
    assert.doesNotMatch(page.body, /decision_S1|userText_S1|接受建议|忽略建议/);
    assert.match(page.body, /复制当前全文/);
    assert.match(page.body, /启用为新版本/);
    assert.doesNotMatch(page.body, /确认启用|二次确认/);

    const create = await request(baseUrl, "/api/resume-optimization", {
      method: "POST",
      body: new URLSearchParams([
        ["planId", String(owner.planId)],
        ["sourceResumeVersionId", String(owner.resumeVersionId)],
        ["targetDirection", "AI 应用工程师"]
      ]).toString()
    });
    assert.equal(create.status, 303);
    assert.equal(create.headers.location, `/resume-optimization?planId=${owner.planId}&draftId=41#resume-opt-draft-title`);
    assert.deepEqual(calls.create, [{
      profileId: owner.profileId,
      planId: owner.planId,
      sourceResumeVersionId: owner.resumeVersionId,
      targetDirection: "AI 应用工程师"
    }]);

    saveGate = new Promise((resolve) => { releaseSave = resolve; });
    const savePromise = request(baseUrl, "/api/resume-optimization/save", {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ planId: owner.planId, draftId: 41, finalText: "自动保存中的旧文字" })
    });
    await waitFor(() => calls.save.length === 1);

    const activate = await request(baseUrl, "/api/resume-optimization/activate", {
      method: "POST",
      body: new URLSearchParams({
        planId: String(owner.planId),
        draftId: "41",
        finalText: "点击启用时更新的文字"
      }).toString()
    });
    assert.equal(activate.status, 303);
    assert.equal(activate.headers.location, `/resume-optimization?planId=${owner.planId}&draftId=41#resume-opt-activated`);
    assert.equal(calls.activate.length, 1, "activation must call the service exactly once without an intermediate confirmation page");
    assert.deepEqual(calls.activate[0], {
      profileId: owner.profileId,
      planId: owner.planId,
      draftId: 41,
      finalText: "点击启用时更新的文字"
    });
    releaseSave();
    const save = await savePromise;
    assert.equal(save.status, 200);
    assert.deepEqual(JSON.parse(save.body), { ok: true });
    assert.deepEqual(calls.save[0], {
      profileId: owner.profileId,
      draftId: 41,
      finalText: "自动保存中的旧文字"
    });

    createFailure = new Error("simulated resume model failure");
    const unhandled = [];
    const recordUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", recordUnhandled);
    try {
      const failedCreate = await request(baseUrl, "/api/resume-optimization", {
        method: "POST",
        timeoutMs: 1_000,
        body: new URLSearchParams([
          ["planId", String(owner.planId)],
          ["sourceResumeVersionId", String(owner.resumeVersionId)],
          ["targetDirection", "AI 应用工程师"]
        ]).toString()
      });
      assert.equal(failedCreate.status, 500, "async resume failures must reach the dashboard error boundary");
      assert.match(failedCreate.body, /requestId|请求|错误编号/);
      const health = await request(baseUrl, `/resume-optimization?planId=${owner.planId}`);
      assert.equal(health.status, 200, "dashboard must remain available after a resume workflow failure");
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
    assert.equal(unhandled.length, 0, "resume failure must not become an unhandled rejection");
    await resumeSubmitClientSmoke(RESUME_OPTIMIZATION_SCRIPT);

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
  const controller = options.timeoutMs ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
  if (timeout && typeof timeout.unref === "function") timeout.unref();
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      method: options.method || "GET",
      headers: options.method === "POST" ? { "content-type": options.contentType || "application/x-www-form-urlencoded" } : undefined,
      body: options.body,
      redirect: "manual",
      signal: controller?.signal
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text()
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for request");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function resumeSubmitClientSmoke(markup) {
  const script = markup.replace(/^<script>|<\/script>$/g, "");
  const formHandlers = new Map();
  const fieldHandlers = new Map();
  const status = { textContent: "修改后会自动保存。" };
  const editor = {
    value: "失败后仍应保留的简历全文",
    readOnly: false,
    addEventListener(type, handler) { fieldHandlers.set(type, handler); }
  };
  const button = {
    disabled: false,
    textContent: "启用为新版本",
    formAction: "/api/resume-optimization/activate",
    dataset: { resumeSuccessTarget: "resume-opt-activated" },
    getAttribute(name) { return name === "formaction" ? "/api/resume-optimization/activate" : null; }
  };
  const form = {
    action: "/api/resume-optimization/save",
    dataset: { resumeSuccessTarget: "resume-opt-draft-title" },
    elements: { planId: { value: "1" }, draftId: { value: "41" }, finalText: editor },
    querySelector(selector) {
      if (selector === "[data-resume-save-status]" || selector === "[data-resume-error]") return status;
      return null;
    },
    getAttribute(name) { return name === "action" ? "/api/resume-optimization/save" : null; },
    addEventListener(type, handler) { formHandlers.set(type, handler); }
  };
  class FakeFormData {
    constructor(source) { this.source = source; }
    *[Symbol.iterator]() {
      for (const [name, control] of Object.entries(this.source.elements)) yield [name, control.value];
    }
  }
  let response = { ok: false, url: "", async text() { return JSON.stringify({ error: "模型生成失败，请直接重试。" }); } };
  const navigations = [];
  let reloads = 0;
  let revealedTarget = "";
  const activatedTarget = { scrollIntoView() { revealedTarget = "resume-opt-activated"; } };
  const location = {
    href: "http://127.0.0.1/resume-optimization?planId=1&draftId=41#resume-opt-activated",
    hash: "#resume-opt-activated",
    assign(url) { navigations.push(url); },
    reload() { reloads += 1; }
  };
  const context = {
    document: {
      readyState: "complete",
      querySelector(selector) {
        if (selector === "[data-resume-editor]") return form;
        if (selector === "[data-copy-resume]") return null;
        return null;
      },
      querySelectorAll(selector) { return selector === "[data-resume-submit]" ? [form] : []; },
      getElementById(id) {
        if (id === "resume-opt-final-text") return editor;
        if (id === "resume-opt-activated") return activatedTarget;
        return null;
      }
    },
    navigator: { clipboard: { async writeText() {} } },
    FormData: FakeFormData,
    URLSearchParams,
    fetch: async () => response,
    location,
    setTimeout,
    clearTimeout,
    console
  };
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(revealedTarget, "resume-opt-activated", "a reloaded workflow result must be scrolled into view");
  await formHandlers.get("submit")({ preventDefault() {}, submitter: button });
  assert.equal(editor.value, "失败后仍应保留的简历全文");
  assert.match(status.textContent, /模型生成失败/);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "启用为新版本");

  response = { ok: true, url: "http://127.0.0.1/resume-optimization?planId=1&draftId=41", async text() { return ""; } };
  await formHandlers.get("submit")({ preventDefault() {}, submitter: button });
  assert.deepEqual(navigations, []);
  assert.equal(location.hash, "resume-opt-activated");
  assert.equal(reloads, 1, "same-draft activation must reload so the activated state replaces the old DOM");
}
