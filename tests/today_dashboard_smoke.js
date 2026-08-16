const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  openDb,
  saveProfileAnalysis,
  createMatchingCardDraft,
  confirmMatchingCard,
  createScanRun,
  finishScanRun,
  createWorkflowRun,
  transitionWorkflowRun
} = require("../src/core/storage");
const { matchingCardFromProfile } = require("../src/core/matching_card");
const { createDashboardServer } = require("../src/dashboard/server");
const { buildTodayViewModel, scanLabel } = require("../src/dashboard/view_models/today");
const { renderTodayPage } = require("../src/dashboard/pages/today");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `today-dashboard-${Date.now()}.sqlite`);
const logger = { info() {}, warn() {}, error() {}, requestId() { return "today-dashboard-smoke"; }, listRecent() { return []; } };

(async () => {
  assertEvaluationScriptExplainsMissingPlaywright();
  assertRendererIsPureAndEscapesHtml();
  assertScanStatusLabels();
  fs.mkdirSync(smokeDir, { recursive: true });
  const db = openDb(dbPath);
  const privateFileNameContacts = ["13876543210", "上海市浦东新区今日页路66号"];
  const ready = seedProfile(db, {
    name: "Ready Candidate",
    confirmCard: true,
    fileName: `Ready-${privateFileNameContacts[0]}-联系地址${privateFileNameContacts[1]}.txt`
  });
  const blocked = seedProfile(db, { name: "Blocked Candidate", confirmCard: false });
  let planRescoreCalls = 0;
  const server = createDashboardServer({
    db,
    root,
    dbPath,
    forceMock: true,
    logger,
    browserReadinessProbe: async () => ({ status: "ready", ready: true, message: "fixture ready", checkedAt: "2099-01-01T00:00:00.000Z" }),
    planRescore: () => { planRescoreCalls += 1; return { rescored: 1 }; }
  });
  const baseUrl = await listen(server);
  try {
    await assertConfirmedMatchCardPage(baseUrl, ready, privateFileNameContacts);
    await assertReadyTodayPage(baseUrl, ready, privateFileNameContacts);
    await savePlanAndAssertMode(baseUrl, db, ready, "generated");
    assert.strictEqual(planRescoreCalls, 1, "saving without an active workflow must rescore once");
    const persistedRun = createScanRun(db, {
      runId: "today-persisted-scan",
      site: "boss",
      command: "daily",
      planId: ready.planId
    });
    finishScanRun(db, { runId: persistedRun.runId, status: "completed" });
    await assertPersistedScanStatusPage(baseUrl, ready);
    await assertBlockedTodayPage(baseUrl, blocked);
    createActiveWorkflow(db, ready);
    await savePlanAndAssertMode(baseUrl, db, ready, "inherited");
    assert.strictEqual(planRescoreCalls, 1, "saving with an active workflow must defer rescore");
    await assertActiveTodayPage(baseUrl, ready);
  } finally {
    await close(server);
    db.close();
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
  console.log("today_dashboard_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function assertEvaluationScriptExplainsMissingPlaywright() {
  const evaluationScript = path.join(root, "scripts", "evaluate-today-dashboard.js");
  const result = spawnSync(process.execPath, [
    evaluationScript,
    "--target-root", root,
    "--label", "missing-playwright-contract",
    "--output-dir", path.join(smokeDir, "missing-playwright-contract")
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: "" }
  });
  assert.notStrictEqual(result.status, 0, "evaluation must fail when Playwright is unavailable");
  assert.match(
    result.stderr,
    /Playwright is unavailable.+NODE_PATH/s,
    "evaluation must explain how to provide the existing workspace Playwright package"
  );
}

function assertRendererIsPureAndEscapesHtml() {
  const viewModel = buildTodayViewModel({
    profile: { id: 7, displayName: `<img src=x onerror=alert(1)>`, profile: { candidate: { name: "候选人", city: "上海", targetTitles: ["AI 应用"] }, skills: [], projects: [] } },
    planRecord: { id: 12, profileId: 7 },
    plan: { name: `<script>bad()</script>`, cities: ["上海"], directions: ["AI 应用"], keywords: [], experience: [], jobTypes: [], degrees: [], salary: {}, scan: {} },
    workflowState: { activeRun: null, successfulToday: 0, dailyTarget: 70, inventory: [], slotsUsed: 0, maxRuns: 3, remainingBudget: { details: 360, pages: 60 }, nextPlan: { targetSuccessCount: 35 } },
    validation: { valid: true, errors: [], warnings: [] },
    planDependency: { stale: false, matchingCardRequired: false },
    bossRuntimeBlock: null,
    run: { state: "idle", error: "" },
    dailyScan: { keywordPlan: [], maxCards: 20, supplementalSalaryLaneKeywordLimit: 1, supplementalSalaryLaneCardLimit: 1, supplementalSalaryLaneDetailLimit: 1, detailLimits: { A: 1, B: 1 }, maxDetailTotal: 10 },
    broadScan: { keywordPlan: [], maxDetailTotal: 10 },
    scanBounds: { maxCards: [1, 100], maxDetailTotal: [1, 100], browserPageBudget: [1, 100] },
    scanDefaults: { maxCards: 20, maxDetailTotal: 20, browserPageBudget: 20 },
    dailyBCardLimit: 10,
    bossCatalog: null,
    bossFilterPreview: null,
    options: { cities: ["上海"], experience: [], jobTypes: [], degrees: [] }
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(viewModel)), viewModel, "today VM must contain plain serializable display data only");
  const html = renderTodayPage(viewModel);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, "today page must prefer the local display name");
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.strictEqual((html.match(/data-today-primary="true"/g) || []).length, 1, "a standalone renderer must emit one primary CTA without a DB or browser");
  assert.strictEqual((html.match(/class="metric"/g) || []).length, 3, "first screen must keep only three result metrics");
  assert.doesNotMatch(html, /class="action-meta"/, "primary action must not repeat the same metrics");
  assert.doesNotMatch(html, /当前数据安全/, "no-blocker state must not render a reassurance card");
  assert.doesNotMatch(html, /现在卡在哪里/, "no-blocker state must not render an empty blocker section");
  assert.match(html, /name="acquisitionMode" value="inherited" checked/);
  assert.match(html, /data-acquisition-panel="inherited"/);
  assert.match(html, /data-acquisition-panel="generated"/);
  assert.match(html, /RoleFlow 本地精筛/);
  assert.doesNotMatch(html, /<strong>平台已继承<\/strong>/);
}

function assertScanStatusLabels() {
  const cases = [
    [{ state: "running", kind: "daily" }, "正在执行日常扫描"],
    [{ state: "completed", kind: "daily" }, "日常扫描已完成"],
    [{ state: "running", kind: "broad" }, "正在执行广泛扫描"],
    [{ state: "completed", kind: "broad" }, "广泛扫描已完成"],
    [{ state: "running", kind: "refresh" }, "正在补读待刷新岗位"],
    [{ state: "completed", kind: "refresh" }, "待刷新岗位补读完成"],
    [{ state: "running", kind: "activity" }, "正在更新超过 3 天有效期的招聘方活跃状态"],
    [{ state: "completed", kind: "activity" }, "招聘方活跃状态更新完成"],
    [{ state: "partial" }, "本次扫描部分完成，可查看诊断后继续"],
    [{ state: "failed" }, "扫描失败，请查看错误"],
    [{ state: "interrupted" }, "扫描已中断，可重新启动"],
    [{ state: "idle" }, "尚未运行"]
  ];
  for (const [run, expected] of cases) assert.strictEqual(scanLabel(run, 3), expected);

  const viewModel = buildTodayViewModel({
    plan: { bossActiveDays: 3 },
    run: { state: "running", kind: "daily", error: "" }
  });
  assert.strictEqual(viewModel.run.label, "正在执行日常扫描");
  assert.match(renderTodayPage(viewModel), /扫描状态：<\/strong>正在执行日常扫描/);
}

async function assertReadyTodayPage(baseUrl, saved, privateFileNameContacts) {
  const favicon = await getText(baseUrl, "/favicon.ico");
  assert.strictEqual(favicon.status, 204, "dashboard pages must not emit a favicon 404 console error");
  const page = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.strictEqual(page.status, 200);
  for (const secret of privateFileNameContacts) {
    assert(!page.body.includes(secret), `today plan page must not expose filename contact: ${secret}`);
  }
  assert.match(page.body, /简历文件\.txt/);
  assert.match(page.body, /<h1[^>]*>今天先把高质量机会推进到人工确认。<\/h1>/);
  assert.match(page.body, /aria-current="page">今日任务<\/a>/);
  assert.match(page.body, /data-today-primary="true"[^>]*name="action"[^>]*value="start"/);
  assert.match(page.body, /name="planId" value="\d+"/);
  assert.match(page.body, /name="browserMode" value="edge"/);
  assert.doesNotMatch(page.body, /value="portable"/);
  assert.match(page.body, /data-browser-readiness-button[^>]*disabled/);
  assert.match(page.body, /id="browser-readiness-status"/);
  assert.match(page.body, /<details[^>]*>\s*<summary[^>]*><strong>调整筛选条件<\/strong>/);
  assert.match(page.body, /本地筛选方案/);
  assert.match(page.body, /平台采集方式/);
  assert.match(page.body, /RoleFlow 本地精筛/);
  assert.strictEqual((page.body.match(/class="metric"/g) || []).length, 3);
  assert.doesNotMatch(page.body, /当前数据安全/);
  assert.doesNotMatch(page.body, /现在卡在哪里/);
  assert.doesNotMatch(page.body, /class="action-meta"/);
  assertPlanAndAdvancedContracts(page.body);
  assertSingleDocument(page.body);
}

async function assertConfirmedMatchCardPage(baseUrl, saved, privateFileNameContacts) {
  const page = await getText(baseUrl, `/match-card?profileId=${saved.profileId}&cardId=${saved.cardId}`);
  assert.strictEqual(page.status, 200);
  for (const secret of privateFileNameContacts) {
    assert(!page.body.includes(secret), `confirmed matching-card page must not expose filename contact: ${secret}`);
  }
  assert.match(page.body, /当前扫描使用：简历文件\.txt/);
  assert.match(page.body, /匹配偏好卡 #\d+（已确认）/);
}

async function assertPersistedScanStatusPage(baseUrl, saved) {
  const page = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /扫描状态：<\/strong>日常扫描已完成/);
  assert.doesNotMatch(page.body, /扫描状态：<\/strong>尚未运行/);
}

async function assertBlockedTodayPage(baseUrl, saved) {
  const page = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /尚未确认匹配偏好卡/);
  assert.match(page.body, /data-today-primary="true"[^>]*href="\/match-card\?profileId=\d+&amp;cardId=\d+"/);
  assert.doesNotMatch(page.body, /data-browser-readiness-button/);
  assert.strictEqual((page.body.match(/data-today-primary="true"/g) || []).length, 1);
}

async function assertActiveTodayPage(baseUrl, saved) {
  const page = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /data-today-primary="true"[^>]*href="\/workflow\?runId=today-active-workflow"[^>]*>继续本轮/);
  assert.doesNotMatch(page.body, /name="action" value="start"/);
  assert.strictEqual((page.body.match(/data-today-primary="true"/g) || []).length, 1);
  assert.match(page.body, /当前任务条件已锁定/);
  assert.match(page.body, /下一次创建任务开始生效/);
}

function assertPlanAndAdvancedContracts(html) {
  assert.match(html, /<form[^>]*id="plan-form"[^>]*action="\/api\/plan"/);
  for (const name of ["profileId", "planId", "name", "acquisitionMode", "cities", "experience", "jobTypes", "degrees", "salaryMinK", "salaryMaxK", "salaryMode", "workSchedulePreference", "directions", "keywords", "excludeWords", "hardExcludes", "maxCards", "maxDetailTotal", "browserPageBudget"]) {
    assert.match(html, new RegExp(`name="${name}"`), `plan form must retain ${name}`);
  }
  assert.match(html, /高级信息与维护/);
  assert.match(html, /<form[^>]*action="\/api\/scan"/);
  for (const kind of ["daily", "broad", "refresh", "activity"]) assert.match(html, new RegExp(`name="scanKind" value="${kind}"`));
  assert.match(html, /href="\/queue\?planId=\d+"/);
  assert.match(html, /href="\/jobs\?planId=\d+&amp;batch=latest"/);
}

async function savePlanAndAssertMode(baseUrl, db, saved, acquisitionMode) {
  const response = await fetch(`${baseUrl}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      profileId: String(saved.profileId),
      planId: String(saved.planId),
      name: `mode ${acquisitionMode}`,
      acquisitionMode,
      cities: "上海",
      platformSalaryLanes: "10-20K",
      experience: "1-3年",
      jobTypes: "全职",
      degrees: "本科",
      salaryMinK: "15",
      salaryMaxK: "25",
      salaryMode: "strict",
      bossActiveDays: "3",
      allowExperienceStretch: "on",
      workSchedulePreference: "prefer_double_weekend",
      directions: "AI 应用开发",
      keywords: "RAG | A | fixture\nPython 后端 | B | fixture",
      maxCards: "40",
      maxDetailTotal: "80",
      browserPageBudget: "40"
    }),
    redirect: "manual"
  });
  assert.strictEqual(response.status, 303, await response.text());
  const row = db.prepare("SELECT plan_json FROM search_plans WHERE id = ?").get(saved.planId);
  const plan = JSON.parse(row.plan_json);
  assert.strictEqual(plan.acquisitionMode, acquisitionMode);
  assert.deepStrictEqual(plan.platform.generated.cities, ["上海"]);
  assert.strictEqual(Object.hasOwn(plan, "cities"), false);
  assert.strictEqual(Object.hasOwn(plan.platform, "salaryLanes"), false);
  const page = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.match(page.body, new RegExp(`name="acquisitionMode" value="${acquisitionMode}" checked`));
  const otherMode = acquisitionMode === "generated" ? "inherited" : "generated";
  assert.match(page.body, new RegExp(`data-acquisition-panel="${otherMode}"[^>]*hidden`));
}

function assertSingleDocument(html) {
  assert.strictEqual((html.match(/<!doctype html>/gi) || []).length, 1);
  assert.strictEqual((html.match(/<body>/gi) || []).length, 1);
}

function createActiveWorkflow(db, saved) {
  const workflow = createWorkflowRun(db, {
    id: "today-active-workflow",
    profileId: saved.profileId,
    planId: saved.planId,
    localDay: chinaLocalDay(),
    sequence: 1,
    targetSuccessCount: 35,
    successfulCount: 0,
    inventoryCount: 0,
    candidateGap: 35,
    scanNeeded: true,
    keywords: [],
    budget: {},
    planner: {},
    metrics: {}
  });
  transitionWorkflowRun(db, { id: workflow.id, status: "scanning" });
}

function chinaLocalDay() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function seedProfile(db, { name, confirmCard, fileName = `${name}.txt` }) {
  const profile = {
    candidate: { name, city: "上海", targetTitles: ["AI 应用开发工程师"], expectedSalary: "15-25K" },
    education: [], experiences: [], skills: [{ name: "Python", evidence: ["Today fixture"] }], projects: [{ name: "Today fixture", canSay: ["RAG"] }], credentials: [], strengths: []
  };
  const saved = saveProfileAnalysis(db, {
    profile,
    document: { originalFileName: fileName, format: "text", contentHash: `today-${name}`, text: "Python RAG experience ".repeat(10), diagnostics: {} },
    searchPlan: { name: `${name} plan`, cities: ["上海"], directions: ["AI 应用开发"], keywords: [{ word: "RAG", priority: "A", reason: "fixture" }, { word: "Python 后端", priority: "B", reason: "fixture" }], experience: ["1-3年"], jobTypes: ["全职"], degrees: [], salary: { minK: 15, maxK: 25 }, bossActiveDays: 3, platform: { site: "boss" } }
  });
  const draft = createMatchingCardDraft(db, { profileId: saved.profileId, profileVersionId: saved.profileVersionId, resumeDocumentId: saved.resumeDocumentId, resumeContentHash: `today-${name}`, card: matchingCardFromProfile(profile), source: "migration" });
  if (confirmCard) confirmMatchingCard(db, { profileId: saved.profileId, cardId: draft.id });
  return { ...saved, cardId: draft.id };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function getText(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.text() };
}
