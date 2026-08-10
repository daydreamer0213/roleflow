const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openDb, saveProfileAnalysis, createBatch, upsertJob } = require("../src/core/storage");
const { createDashboardServer } = require("../src/dashboard/server");
const response = require("../src/dashboard/http/response");
const { renderPage } = require("../src/dashboard/ui/shell");
const { renderNavigation } = require("../src/dashboard/ui/navigation");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `dashboard-shell-${Date.now()}.sqlite`);
const logger = { info() {}, warn() {}, error() {}, requestId() { return "dashboard-shell-smoke"; }, listRecent() { return []; } };

(async () => {
  assert.strictEqual(typeof response.escapeHtml, "function", "the response utility must expose HTML escaping");
  assert.strictEqual(typeof response.escapeAttr, "function", "the response utility must expose attribute escaping");
  assert.strictEqual(response.escapeHtml(`<&>\"'`), "&lt;&amp;&gt;&quot;&#39;");
  assert.strictEqual(response.escapeAttr(`<&>\"'`), "&lt;&amp;&gt;&quot;&#39;");

  assert.strictEqual(typeof renderNavigation, "function", "the navigation renderer must be available");
  for (const navigationCase of [
    { currentPath: "/plan?planId=17", todayPath: "/plan?planId=17", label: "今日任务" },
    { currentPath: "/workflow?runId=workflow-17", todayPath: "/plan?planId=17", label: "本轮" },
    { currentPath: "/queue?planId=17&pool=primary", href: "/queue?planId=17", todayPath: "/plan?planId=17", label: "当前岗位" },
    { currentPath: "/jobs?planId=17&batch=latest", href: "/jobs?planId=17&amp;batch=latest", todayPath: "/plan?planId=17", label: "岗位列表" },
    { currentPath: "/communication/new?planId=17", todayPath: "/plan?planId=17", label: "批量沟通清单" },
    { currentPath: "/communication?batchId=17", todayPath: "/plan?planId=17", label: "批量沟通审阅" },
    { currentPath: "/settings", label: "模型设置" },
    { currentPath: "/diagnostics", label: "诊断" },
    { currentPath: "/onboarding", label: "简历" }
  ]) {
    const markup = renderNavigation({ ...navigationCase, planId: 17 });
    assertCurrentLink(markup, navigationCase.href || navigationCase.currentPath, navigationCase.label);
  }
  const encodedPlanNavigation = renderNavigation({ currentPath: "/queue?planId=plan%20id%2F17", todayPath: "/plan?planId=plan%20id%2F17", planId: "plan id/17" });
  assert.match(encodedPlanNavigation, /href="\/queue\?planId=plan%20id%2F17" aria-current="page">当前岗位<\/a>/);

  assert.strictEqual(typeof renderPage, "function", "the page shell renderer must be available");
  const page = renderPage({ title: `<title>`, body: "<main>body</main>", scripts: ["<script>window.roleflowShellTest=true</script>"] });
  assert.match(page, /<title>&lt;title&gt;<\/title>/);
  assert.match(page, /<link rel="stylesheet" href="\/assets\/roleflow\.css">/);
  assert.match(page, /<script>window\.roleflowShellTest=true<\/script>/);

  fs.mkdirSync(smokeDir, { recursive: true });
  const db = openDb(dbPath);
  const queueFixture = seedQueueFixture(db);
  const server = createDashboardServer({ db, root, dbPath, forceMock: true, logger });
  const baseUrl = await listen(server);
  try {
    const stylesheet = await getText(baseUrl, "/assets/roleflow.css");
    assert.strictEqual(stylesheet.status, 200, "the fixed dashboard stylesheet must be served");
    assert.match(stylesheet.contentType, /^text\/css(?:;|$)/);
    assert.match(stylesheet.body, /:root/);

    const unknownAsset = await getText(baseUrl, "/assets/%2e%2e%2fpackage.json");
    assert.strictEqual(unknownAsset.status, 404, "unknown asset paths must not reach the filesystem");
    assert.strictEqual(unknownAsset.body, "Not found");
    assert.doesNotMatch(unknownAsset.body, /roleflow/);

    const health = await getJson(baseUrl, "/health");
    assert.strictEqual(health.status, 200, "existing JSON API responses must remain available");
    assert.match(health.contentType, /^application\/json(?:;|$)/);
    assert.strictEqual(health.body.ok, true);

    for (const pathname of ["/onboarding", "/settings", "/plan", "/workflow", "/queue", "/communication/new", "/jobs", "/diagnostics"]) {
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
    assertCurrentLink(queue.body, `/queue?planId=${queueFixture.planId}`, "当前岗位");
    assert.strictEqual((queue.body.match(/<!doctype html>/gi) || []).length, 1, "queue must have one document shell");
    assert.strictEqual((queue.body.match(/<body>/gi) || []).length, 1, "queue must not nest a second body");
    assertSharedFrame(queue.body, `/queue?planId=${queueFixture.planId}`, "queue");
    assert.match(queue.body, /<form class="quick-actions" method="post" action="\/api\/mark/);

    const jobs = await getText(baseUrl, `/jobs?planId=${queueFixture.planId}&batch=latest`);
    assert.strictEqual(jobs.status, 200);
    assertSharedFrame(jobs.body, `/jobs?planId=${queueFixture.planId}&amp;batch=latest`, "jobs");
    assert.match(jobs.body, /<form class="panel filters" method="get" action="\/jobs">/);

    const builder = await getText(baseUrl, `/communication/new?planId=${queueFixture.planId}`);
    assertSharedFrame(builder.body, `/communication\/new\?planId=${queueFixture.planId}`, "communication builder");
    assert.match(builder.body, /<form id="communication-batch-form" method="post" action="\/api\/communication-batch">/);
    assert.match(builder.body, /name="browserMode"/);

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
    assertCurrentLink(jobs.body, `/jobs?planId=${queueFixture.planId}&amp;batch=latest`, "岗位列表");
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
  assert.match(markup, new RegExp(`<a href="${escapeRegExp(href)}" aria-current="page">${label}</a>`));
}

function assertSharedFrame(markup, href, name) {
  assert.strictEqual((markup.match(/class="app-shell"/g) || []).length, 1, `${name} must use exactly one shared app shell`);
  assert.strictEqual((markup.match(/class="primary-nav"/g) || []).length, 1, `${name} must use exactly one primary navigation`);
  assert.doesNotMatch(markup, /<main[^>]*>\s*<nav(?:\s|>)/, `${name} must not retain an inner duplicate navigation`);
  assert.match(markup, new RegExp(`<a href="${escapeRegExp(href)}" aria-current="page">`), `${name} must preserve its active navigation`);
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
    url: "https://www.zhipin.com/job_detail/dashboard-shell-queue.html", tags: ["Python", "RAG"], description: "Build Python RAG applications and maintain production services. ".repeat(5), score: 20, level: "优先", matches: ["Python", "RAG"], risks: [], qualityTags: [],
    analysis: { provider: "mock", model: "offline", semanticStatus: "complete", decisionSource: "model", recommendation: "primary", fitLevel: "A", confidence: 0.9, fitReasons: ["Python RAG matches"], evidence: { jd: ["Python RAG"], resume: ["Python RAG"] } }
  }, batchId);
  return saved;
}
