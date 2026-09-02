const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { openDb, saveProfileAnalysis, createBatch, upsertJob } = require("../src/core/storage");
const { createDashboardServer, normalizeDashboardBrowserAuthority } = require("../src/dashboard/server");
const response = require("../src/dashboard/http/response");
const { renderPage } = require("../src/dashboard/ui/shell");
const { renderNavigation } = require("../src/dashboard/ui/navigation");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `dashboard-shell-${Date.now()}.sqlite`);
const browserAuthority = { browserMode: "portable", cdpPort: 9222, profilePath: path.resolve(smokeDir, "dedicated-edge-profile") };
let diagnosticEntries = [];
const logger = { info() {}, warn() {}, error() {}, requestId() { return "dashboard-shell-smoke"; }, listRecent() { return diagnosticEntries; } };

(async () => {
  assert.strictEqual(typeof response.escapeHtml, "function", "the response utility must expose HTML escaping");
  assert.strictEqual(typeof response.escapeAttr, "function", "the response utility must expose attribute escaping");
  assert.strictEqual(typeof normalizeDashboardBrowserAuthority, "function", "the Dashboard must expose browser-authority validation");
  assert.throws(
    () => normalizeDashboardBrowserAuthority(),
    (error) => error && error.code === "WORKFLOW_BROWSER_MODE_INVALID",
    "a Dashboard without startup browser authority must be rejected"
  );
  assert.throws(
    () => normalizeDashboardBrowserAuthority({ browserMode: "edge", cdpPort: 9222, profilePath: "" }),
    (error) => error && error.code === "DASHBOARD_BROWSER_AUTHORITY_INVALID",
    "advanced Edge authority must not include a portable CDP identity"
  );
  assert.strictEqual(response.escapeHtml(`<&>\"'`), "&lt;&amp;&gt;&quot;&#39;");
  assert.strictEqual(response.escapeAttr(`<&>\"'`), "&lt;&amp;&gt;&quot;&#39;");

  assert.strictEqual(typeof renderNavigation, "function", "the navigation renderer must be available");
  for (const navigationCase of [
    { currentPath: "/plan?planId=17", todayPath: "/plan?planId=17", label: "今日任务" },
    { currentPath: "/workflow?runId=workflow-17", todayPath: "/plan?planId=17", label: "发现岗位" },
    { currentPath: "/queue?planId=17&pool=primary", href: "/queue?planId=17&amp;pool=primary", todayPath: "/plan?planId=17", label: "岗位记录" },
    { currentPath: "/jobs?planId=17&batch=latest", href: "/jobs?planId=17&amp;batch=latest", todayPath: "/plan?planId=17", label: "岗位记录" },
    { currentPath: "/communication/new?planId=17", todayPath: "/plan?planId=17", label: "发送记录" },
    { currentPath: "/communication?planId=17", href: "/communication?planId=17", todayPath: "/plan?planId=17", label: "发送记录" },
    { currentPath: "/messages?planId=17", href: "/messages?planId=17", todayPath: "/plan?planId=17", label: "消息与回复" },
    { currentPath: "/funnel?planId=17", href: "/funnel?planId=17", todayPath: "/plan?planId=17", label: "求职体检" },
    { currentPath: "/resume-optimization?planId=17", href: "/resume-optimization?planId=17", todayPath: "/plan?planId=17", label: "简历工作室" },
    { currentPath: "/interview?planId=17", href: "/interview?planId=17", todayPath: "/plan?planId=17", label: "面试训练" },
    { currentPath: "/settings", label: "模型与设置" },
    { currentPath: "/diagnostics", label: "运行诊断" },
    { currentPath: "/onboarding", label: "简历工作室" }
  ]) {
    const markup = renderNavigation({ ...navigationCase, planId: 17 });
    assertCurrentLink(markup, navigationCase.href || navigationCase.currentPath, navigationCase.label);
  }
  const encodedPlanNavigation = renderNavigation({ currentPath: "/queue?planId=plan%20id%2F17", todayPath: "/plan?planId=plan%20id%2F17", planId: "plan id/17" });
  assert.match(encodedPlanNavigation, /href="\/queue\?planId=plan%20id%2F17" aria-current="page">岗位记录<\/a>/);

  assert.strictEqual(typeof renderPage, "function", "the page shell renderer must be available");
  const page = renderPage({ title: `<title>`, body: "<main>body</main>", scripts: ["<script>window.roleflowShellTest=true</script>"] });
  assert.match(page, /<title>&lt;title&gt;<\/title>/);
  assert.match(page, /<link rel="stylesheet" href="\/assets\/roleflow\.css">/);
  assert.match(page, /<script>window\.roleflowShellTest=true<\/script>/);

  fs.mkdirSync(smokeDir, { recursive: true });
  const db = openDb(dbPath);
  const queueFixture = seedQueueFixture(db);
  const server = createDashboardServer({ db, root, dbPath, forceMock: true, logger, browserAuthority });
  const baseUrl = await listen(server);
  try {
    const stylesheet = await getText(baseUrl, "/assets/roleflow.css");
    assert.strictEqual(stylesheet.status, 200, "the fixed dashboard stylesheet must be served");
    assert.match(stylesheet.contentType, /^text\/css(?:;|$)/);
    assert.match(stylesheet.body, /:root/);
    assert.match(stylesheet.body, /\.app-sidebar\{/,
      "the emitted stylesheet must include the desktop sidebar");

    const runtimeAsset = await getText(baseUrl, "/assets/runtime.js");
    assert.strictEqual(runtimeAsset.status, 200, "the shared runtime client must be served");
    assert.match(runtimeAsset.contentType, /^application\/javascript(?:;|$)/);
    await assertRuntimeClient(runtimeAsset.body);

    const unknownAsset = await getText(baseUrl, "/assets/%2e%2e%2fpackage.json");
    assert.strictEqual(unknownAsset.status, 404, "unknown asset paths must not reach the filesystem");
    assert.strictEqual(unknownAsset.body, "Not found");
    assert.doesNotMatch(unknownAsset.body, /roleflow/);

    const health = await getJson(baseUrl, "/health");
    assert.strictEqual(health.status, 200, "existing JSON API responses must remain available");
    assert.match(health.contentType, /^application\/json(?:;|$)/);
    assert.strictEqual(health.body.ok, true);
    assert.deepStrictEqual(health.body.browserAuthority, browserAuthority);

    for (const pathname of ["/onboarding", "/settings", "/plan", "/workflow", "/queue", "/communication/new", "/communication", "/jobs", "/diagnostics"]) {
      const page = await getText(baseUrl, pathname);
      assert.strictEqual(page.status, 200, `${pathname} must keep its HTML response`);
      assert.match(page.contentType, /^text\/html(?:;|$)/);
      assert.match(page.body, /<link rel="stylesheet" href="\/assets\/roleflow\.css">/);
    }

    const queue = await getText(baseUrl, `/queue?planId=${queueFixture.planId}`);
    assert.strictEqual(queue.status, 200);
    assert.match(queue.body, /<h1>当前待处理岗位<\/h1>/);
    assert.match(queue.body, /class="pool-tabs"/);
    assert.match(queue.body, /<link rel="stylesheet" href="\/assets\/roleflow\.css">/);
    assertCurrentLink(queue.body, `/queue?planId=${queueFixture.planId}`, "岗位记录");
    assert.strictEqual((queue.body.match(/<!doctype html>/gi) || []).length, 1, "queue must have one document shell");
    assert.strictEqual((queue.body.match(/<body>/gi) || []).length, 1, "queue must not nest a second body");
    assertSharedFrame(queue.body, `/queue?planId=${queueFixture.planId}`, "queue");
    assert.match(queue.body, /<form class="quick-actions" method="post" action="\/api\/mark/);
    assert.doesNotMatch(queue.body, /multiBusinessDistrict/, "internal unresolved parameter names must not leak into job cards");
    assert.match(queue.body, /需确认轮班/, "other user-relevant risks must remain visible");

    const jobs = await getText(baseUrl, `/jobs?planId=${queueFixture.planId}&batch=latest`);
    assert.strictEqual(jobs.status, 200);
    assertSharedFrame(jobs.body, `/jobs?planId=${queueFixture.planId}&amp;batch=latest`, "jobs");
    assert.match(jobs.body, /<form class="panel filters" method="get" action="\/jobs">/);

    const builder = await getText(baseUrl, `/communication/new?planId=${queueFixture.planId}`);
    assertSharedFrame(builder.body, `/communication\/new\?planId=${queueFixture.planId}`, "communication builder");
    assert.match(builder.body, /<form id="communication-batch-form" method="post" action="\/api\/communication-batch">/);
    assert.match(builder.body, /name="browserMode"/);

    const communication = await getText(baseUrl, `/communication?planId=${queueFixture.planId}`);
    assertSharedFrame(communication.body, `/communication\?planId=${queueFixture.planId}`, "communication center");
    assert.match(communication.body, /<h1>自动沟通<\/h1>/);
    assert.match(communication.body, /进入清单页不会创建、确认或启动任何沟通/);
    assert.strictEqual((communication.body.match(/data-page-primary="true"/g) || []).length, 1, "communication center must have one primary action");

    const messages = await getText(baseUrl, `/messages?planId=${queueFixture.planId}`);
    assert.strictEqual(messages.status, 200);
    assertSharedFrame(messages.body, `/messages\?planId=${queueFixture.planId}`, "message discovery");
    assert.match(messages.body, /<h1>BOSS 消息发现与回复<\/h1>/);
    assert.strictEqual((messages.body.match(/>消息与回复<\/a>/g) || []).length, 1, "message discovery must have one primary navigation entry");

    const funnel = await getText(baseUrl, `/funnel?planId=${queueFixture.planId}`);
    assert.strictEqual(funnel.status, 200);
    assertSharedFrame(funnel.body, `/funnel?planId=${queueFixture.planId}`, "job search checkup");
    assert.match(funnel.body, /<h1 id="funnel-title">求职体检<\/h1>/);
    assert.match(funnel.body, /还没有可统计的求职动作/);

    const onboarding = await getText(baseUrl, "/onboarding");
    assertSharedFrame(onboarding.body, "/onboarding", "onboarding");
    assert.match(onboarding.body, /data-onboarding-primary="true"/);
    assert.match(onboarding.body, /<form class="panel form-stack" method="post" action="\/api\/resume" enctype="multipart\/form-data">/);

    const settings = await getText(baseUrl, "/settings");
    assertSharedFrame(settings.body, "/settings", "settings");
    assert.match(settings.body, /<form class="model-profile-form" method="post" action="\/api\/settings\/model"/);
    assert.doesNotMatch(settings.body, /data-page-primary=/, "settings must explicitly have no page-level primary marker");

    const diagnostics = await getText(baseUrl, "/diagnostics");
    assertSharedFrame(diagnostics.body, "/diagnostics", "diagnostics");
    assert.doesNotMatch(diagnostics.body, /data-page-primary=/, "diagnostics must explicitly have no page-level primary marker");
    assertCurrentLink(jobs.body, `/jobs?planId=${queueFixture.planId}&amp;batch=latest`, "岗位记录");
    for (const [pathname, name] of [
      [`/match-card?profileId=${queueFixture.profileId}`, "match card"],
      [`/profile?profileId=${queueFixture.profileId}`, "profile"],
      [`/resumes?profileId=${queueFixture.profileId}`, "resume versions"]
    ]) {
      const migratedPage = await getText(baseUrl, pathname);
      assert.strictEqual(migratedPage.status, 200, `${name} must keep its HTML response`);
      assertSharedFrame(migratedPage.body, `/plan?profileId=${queueFixture.profileId}&amp;planId=${queueFixture.planId}`, name);
      assert.strictEqual((migratedPage.body.match(/<main(?:\s|>)/g) || []).length, 1, `${name} must use exactly one main region`);
      assert.match(migratedPage.body, /<main id="main-content">/, `${name} must preserve the shared main-content target`);
      const primaryNavigation = migratedPage.body.match(/<nav class="primary-nav"[^>]*>([\s\S]*?)<\/nav>/);
      assert.ok(primaryNavigation, `${name} must expose primary navigation`);
      assert.strictEqual((primaryNavigation[1].match(/>今日任务<\/a>/g) || []).length, 1, `${name} must keep one today destination`);
      assert.strictEqual((primaryNavigation[1].match(/#today-discovery"[^>]*>发现岗位<\/a>/g) || []).length, 1, `${name} must keep one discovery destination`);
      const mainContent = migratedPage.body.match(/<main id="main-content">([\s\S]*?)<\/main>/);
      assert.ok(mainContent, `${name} must expose main content`);
      assert.doesNotMatch(mainContent[1], /href="\/plan\?profileId=/, `${name} must not duplicate the plan destination in page content`);
    }

    const resumes = await getText(baseUrl, `/resumes?profileId=${queueFixture.profileId}`);
    const createResumeForm = resumes.body.match(/<form class="panel form-stack" method="post" action="\/api\/resume-version" enctype="multipart\/form-data">([\s\S]*?)<\/form>/);
    assert.ok(createResumeForm, "resume create form must remain present");
    assert.strictEqual((createResumeForm[1].match(/<input[^>]*name="name"/g) || []).length, 1, "resume create form must have one version-name input");
    assert.strictEqual((createResumeForm[1].match(/<label>\u7248\u672c\u540d\u79f0<input name="name"/g) || []).length, 1, "resume create form must have one visible version-name label");

    diagnosticEntries = [
      { time: "2099-01-01T00:00:00.000Z", level: "warn", component: "scan", event: "scan_waiting", requestId: "warn-request" },
      { time: "2099-01-01T00:01:00.000Z", level: "error", component: "scan", event: "scan_failed", requestId: "error-request", errorCode: "SCAN_FAILED", error: { message: "safe failure" } },
      { time: "2099-01-01T00:02:00.000Z", level: "info", component: "http", event: "http_request_completed", requestId: "routine-request" }
    ];
    const defaultDiagnostics = await getText(baseUrl, "/diagnostics");
    assert.match(defaultDiagnostics.body, /scan_waiting/);
    assert.match(defaultDiagnostics.body, /scan_failed/);
    assert.doesNotMatch(defaultDiagnostics.body, /http_request_completed/);
    assert.match(defaultDiagnostics.body, /\u95ee\u9898\u548c\u5efa\u8bae\u884c\u52a8\u4f18\u5148/);
    assert.match(defaultDiagnostics.body, /href="\/diagnostics\?events=all"/);
    assert.match(defaultDiagnostics.body, /SCAN_FAILED/);
    assert.match(defaultDiagnostics.body, /error-request/);
    const allDiagnostics = await getText(baseUrl, "/diagnostics?events=all");
    assert.match(allDiagnostics.body, /http_request_completed/);
    const unknownDiagnostics = await getText(baseUrl, "/diagnostics?events=unknown");
    assert.doesNotMatch(unknownDiagnostics.body, /http_request_completed/);
  } finally {
    await close(server);
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
  console.log("dashboard_shell_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function getText(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, contentType: response.headers.get("content-type") || "", body: await response.text() };
}

async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, contentType: response.headers.get("content-type") || "", body: await response.json() };
}

function assertCurrentLink(markup, href, label) {
  assert.match(markup, new RegExp(`<a[^>]*href="${escapeRegExp(href)}"[^>]*aria-current="page"[^>]*>${label}</a>`));
}

function assertSharedFrame(markup, href, name) {
  assert.strictEqual((markup.match(/class="app-shell"/g) || []).length, 1, `${name} must use exactly one shared app shell`);
  assert.strictEqual((markup.match(/class="primary-nav"/g) || []).length, 1, `${name} must use exactly one primary navigation`);
  assert.doesNotMatch(markup, /<main[^>]*>\s*<nav(?:\s|>)/, `${name} must not retain an inner duplicate navigation`);
  assert.match(markup, new RegExp(`<a[^>]*href="${escapeRegExp(href)}"[^>]*aria-current="page"`), `${name} must preserve its active navigation`);
  assert.strictEqual((markup.match(/data-runtime-status/g) || []).length, 1, `${name} must expose one shared runtime status`);
  assert.match(markup, /data-runtime-status[^>]*aria-live="polite"/);
  assert.match(markup, /data-runtime-title>正在准备专用 Edge/);
  assert.match(markup, /data-runtime-message/);
  assert.match(markup, /data-runtime-recover[^>]*hidden/);
  assert.strictEqual((markup.match(/src="\/assets\/runtime\.js"/g) || []).length, 1, `${name} must load one runtime client`);
}

async function assertRuntimeClient(source) {
  const elements = {
    "[data-runtime-status]": { dataset: {} },
    "[data-runtime-title]": { textContent: "" },
    "[data-runtime-message]": { textContent: "" },
    "[data-runtime-recover]": {
      hidden: true,
      disabled: false,
      textContent: "",
      addEventListener(type, handler) { this[type] = handler; }
    }
  };
  const documentHandlers = {};
  const pending = [];
  const fetchCalls = [];
  const timers = new Map();
  let timerId = 0;
  const document = {
    hidden: false,
    querySelector(selector) { return elements[selector] || null; },
    addEventListener(type, handler) { documentHandlers[type] = handler; }
  };
  const context = {
    document,
    fetch(url, options = {}) {
      fetchCalls.push({ url, options });
      return new Promise((resolve) => pending.push(resolve));
    },
    setTimeout(handler, delay) {
      const id = ++timerId;
      timers.set(id, { handler, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    console: { error() {} }
  };
  vm.runInNewContext(source, context, { filename: "runtime.js" });
  assert.deepStrictEqual(fetchCalls.map((call) => call.url), ["/api/runtime-status"]);
  documentHandlers.visibilitychange();
  assert.strictEqual(fetchCalls.length, 1, "runtime polling must keep one request in flight");

  pending.shift()({
    ok: true,
    async json() {
      return {
        application: { status: "ready", ready: true },
        browser: { status: "unavailable", ready: false },
        workspace: { status: "unchecked" }
      };
    }
  });
  await settlePromises();
  assert.match(elements["[data-runtime-title]"].textContent, /专用 Edge/);
  assert.strictEqual(elements["[data-runtime-recover]"].hidden, false);
  assert([...timers.values()].every((timer) => timer.delay === 5000), "runtime polling must use the fixed five-second interval");

  const click = elements["[data-runtime-recover]"].click;
  const clickPromise = click();
  assert.strictEqual(fetchCalls.at(-1).url, "/api/runtime/browser/recover");
  assert.strictEqual(fetchCalls.at(-1).options.method, "POST");
  pending.shift()({
    ok: false,
    async json() {
      return {
        error: "请先等待专用 Edge 准备完成。",
        errorCode: "BROWSER_RUNTIME_NOT_READY",
        requestId: "runtime-readable-error"
      };
    }
  });
  await clickPromise;
  await settlePromises();
  assert.strictEqual(elements["[data-runtime-message]"].textContent, "请先等待专用 Edge 准备完成。");

  document.hidden = true;
  documentHandlers.visibilitychange();
  assert.strictEqual(timers.size, 0, "hidden pages must stop runtime polling");
  document.hidden = false;
  documentHandlers.visibilitychange();
  assert.strictEqual(fetchCalls.at(-1).url, "/api/runtime-status", "visible pages must resume local runtime polling");
  assert(fetchCalls.every((call) => String(call.url).startsWith("/api/runtime")), "runtime client must call only local runtime endpoints");
}

async function settlePromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function seedQueueFixture(database) {
  const profile = {
    candidate: { name: "Queue Candidate", city: "广州", targetTitles: ["AI应用开发工程师"], expectedSalary: "10-20K" },
    education: [{ school: "Test University", degree: "本科", major: "Computer Science" }],
    experiences: [],
    skills: [{ name: "Python", evidence: ["Queue Project"] }, { name: "RAG", evidence: ["Queue Project"] }],
    projects: [{ name: "Queue Project", roleBoundary: "personal project", canSay: ["Built a RAG workflow"] }],
    credentials: [],
    strengths: []
  };
  const saved = saveProfileAnalysis(database, {
    profile,
    document: { originalFileName: "queue-resume.txt", format: "text", contentHash: "dashboard-shell-queue", text: "Python RAG project experience. ".repeat(8), diagnostics: {} },
    searchPlan: { name: "Queue plan", cities: ["广州"], directions: ["AI应用开发"], keywords: [{ word: "RAG", priority: "A" }], experience: ["1-3年"], jobTypes: ["全职"], bossActiveDays: 3 }
  });
  const batchId = createBatch(database, "boss", "dashboard-shell", "queue fixture", { profileId: saved.profileId, searchPlanId: saved.planId, filterSnapshot: { execution: { scanKind: "daily" } } });
  upsertJob(database, {
    source: "boss", sourceId: "dashboard-shell-queue-job", keyword: "RAG", title: "Queue Fixture Engineer", company: "Fixture Co", location: "广州", salary: "15-20K", experience: "1-3年", education: "本科", bossActiveText: "今日活跃", bossActiveDays: 0,
    url: "https://www.zhipin.com/job_detail/dashboard-shell-queue.html", tags: ["Python", "RAG"], description: "Build Python RAG applications and maintain production services. ".repeat(5), score: 20, level: "优先", matches: ["Python", "RAG"], risks: ["平台筛选参数未完全解析：multiBusinessDistrict", "需确认轮班"], qualityTags: [],
    analysis: { provider: "mock", model: "offline", semanticStatus: "complete", decisionSource: "model", recommendation: "primary", fitLevel: "A", confidence: 0.9, fitReasons: ["Python RAG matches"], evidence: { jd: ["Python RAG"], resume: ["Python RAG"] } }
  }, batchId);
  return saved;
}
