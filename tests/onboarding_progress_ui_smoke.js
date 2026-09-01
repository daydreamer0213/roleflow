const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { openDb } = require("../src/core/storage");
const { createDashboardServer } = require("../src/dashboard/server");
const { getOnboardingRun } = require("../src/storage/onboarding_store");
const { processOnboardingRun } = require("../src/core/onboarding_run");
const { createLogger } = require("../src/core/observability");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-onboarding-progress-"));
const appRoot = path.join(root, "application");
const dataRoot = path.join(root, "user data");
const dbPath = path.join(dataRoot, "data", "jobs.sqlite");
fs.mkdirSync(appRoot, { recursive: true });
const db = openDb(dbPath);
const spawns = [];
const initialSearchPrepareCalls = [];
const dashboardWarnings = [];
const dashboardLogger = createLogger({ root: dataRoot, component: "dashboard-test" });
const writeDashboardWarning = dashboardLogger.warn.bind(dashboardLogger);
dashboardLogger.warn = (event, details) => {
  dashboardWarnings.push({ event, details });
  writeDashboardWarning(event, details);
};
let server;

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  server?.close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function main() {
  server = createDashboardServer({
    db,
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
    root: appRoot,
    dataRoot,
    dbPath,
    forceMock: true,
    logger: dashboardLogger,
    browserFactory() {
      return { fixture: "onboarding-browser" };
    },
    async initialSearchPreparer(input) {
      initialSearchPrepareCalls.push(input);
      throw Object.assign(new Error("fixture preparation failure"), {
        code: "INITIAL_SEARCH_PREPARE_FIXTURE"
      });
    },
    spawnProcess(file, args, options) {
      const child = new EventEmitter();
      child.pid = 4321;
      child.unref = () => {};
      spawns.push({ file, args, options, child });
      return child;
    }
  });
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;

  const form = new FormData();
  const resumeText = [
    "姓名：王小明",
    "手机：13800138000",
    "求职意向：AI 应用开发工程师",
    "项目经历：KnowledgeFlow 项目，使用 Python、FastAPI 和 RAG。",
    "工作经历：参与企业知识检索服务开发并负责接口联调。",
    "专业技能：Python、FastAPI、RAG、SQLite、Docker。"
  ].join("\n");
  form.set("resume", new Blob([resumeText], { type: "text/plain" }), "candidate.txt");
  const upload = await fetch(`${base}/api/resume`, {
    method: "POST",
    body: form,
    redirect: "manual"
  });
  assert.strictEqual(upload.status, 303);
  const progressLocation = upload.headers.get("location");
  assert.match(progressLocation, /^\/onboarding\/progress\?runId=/);
  const runId = new URL(`${base}${progressLocation}`).searchParams.get("runId");
  assert(runId);
  assert.strictEqual(spawns.length, 1);
  assert(spawns[0].args.includes("onboarding-process"));
  assert(spawns[0].args.includes("--run"));
  assert(spawns[0].args.includes(runId));
  assert.deepStrictEqual(
    spawns[0].args.slice(spawns[0].args.indexOf("--data-root"), spawns[0].args.indexOf("--data-root") + 2),
    ["--data-root", dataRoot]
  );
  assert.strictEqual(spawns[0].options.windowsHide, true);
  assert.deepStrictEqual(spawns[0].options.stdio, ["ignore", "ignore", "ignore"]);

  const rootDuringRun = await fetch(`${base}/`, { redirect: "manual" });
  assert.strictEqual(rootDuringRun.headers.get("location"), progressLocation);

  const progress = await fetch(`${base}${progressLocation}`);
  const progressHtml = await progress.text();
  assert.strictEqual(progress.status, 200);
  for (const text of [
    "简历已接收",
    "正在生成候选人画像",
    "正在生成匹配偏好卡",
    "正在生成本地筛选方案",
    'aria-live="polite"',
    'data-onboarding-progress'
  ]) {
    assert(progressHtml.includes(text), `progress page must include ${text}`);
  }
  assert(!progressHtml.includes("13800138000"));
  assert(!progressHtml.includes("王小明"));
  assert(!progressHtml.includes("data-progress-percent"), "progress page must not show a fake percentage");
  assert(!progressHtml.includes("<progress"), "progress page must show stages, not a fabricated progress bar");

  const queuedStatus = await fetch(`${base}/api/onboarding-status?runId=${encodeURIComponent(runId)}`);
  const queued = await queuedStatus.json();
  assert.strictEqual(queuedStatus.status, 200);
  assert.strictEqual(queued.status, "queued");
  assert.strictEqual(queued.stage, "parsed");
  assert(!JSON.stringify(queued).includes("13800138000"));
  assert(!JSON.stringify(queued).includes("王小明"));

  let releasePlan;
  let planStarted;
  const planStartedPromise = new Promise((resolve) => { planStarted = resolve; });
  const processing = processOnboardingRun({
    db,
    runId,
    modelConfig: { provider: "mock", providers: { mock: { model: "offline-structured-mock" } } },
    logger: quietLogger(),
    recommendPlan: async () => {
      planStarted();
      return new Promise((resolve) => { releasePlan = resolve; });
    }
  });
  await planStartedPromise;
  const buildingPlanStatus = await fetch(`${base}/api/onboarding-status?runId=${encodeURIComponent(runId)}`);
  const buildingPlan = await buildingPlanStatus.json();
  assert.strictEqual(buildingPlan.status, "running");
  assert.strictEqual(buildingPlan.stage, "building_plan");
  assert.strictEqual(buildingPlan.nextHref, "", "matching card must stay gated until the search plan is complete");
  assert.strictEqual(buildingPlan.nextLabel, "");
  const buildingPlanPage = await fetch(`${base}${progressLocation}`);
  const buildingPlanHtml = await buildingPlanPage.text();
  assert(
    !buildingPlanHtml.includes('<a class="button-link onboarding-next"'),
    "progress page must not offer the matching-card step early"
  );
  const partialRun = getOnboardingRun(db, runId);
  const earlyCardLocation = `/match-card?profileId=${partialRun.profileId}&cardId=${partialRun.matchingCardId}`;
  const earlyCardPage = await fetch(`${base}${earlyCardLocation}`);
  const earlyCardHtml = await earlyCardPage.text();
  assert(!earlyCardHtml.includes('action="/api/match-card/confirm"'), "a direct card URL must not bypass the search-plan gate");
  assert(earlyCardHtml.includes("筛选方案"));
  const earlyConfirm = await fetch(`${base}/api/match-card/confirm`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ profileId: partialRun.profileId, cardId: partialRun.matchingCardId }),
    redirect: "manual"
  });
  assert.notStrictEqual(earlyConfirm.status, 303, "the confirm endpoint must enforce the same search-plan gate");
  assert.strictEqual(
    db.prepare("SELECT status FROM candidate_matching_cards WHERE id = ?").get(partialRun.matchingCardId).status,
    "draft"
  );
  const repeatedForm = new FormData();
  repeatedForm.set("profileId", String(partialRun.profileId));
  repeatedForm.set("resume", new Blob([resumeText], { type: "text/plain" }), "candidate.txt");
  const repeatedUpload = await fetch(`${base}/api/resume`, {
    method: "POST",
    body: repeatedForm,
    redirect: "manual"
  });
  assert.strictEqual(repeatedUpload.status, 303);
  assert.strictEqual(repeatedUpload.headers.get("location"), progressLocation, "same-resume upload must return to the unfinished onboarding run");
  releasePlan({
    name: "本地筛选方案",
    cities: ["广州"],
    salary: { minK: 10, maxK: 18 },
    experience: ["经验不限"],
    allowExperienceStretch: true,
    bossActiveDays: 3,
    directions: ["AI 应用开发工程师"],
    keywords: [{ word: "AI 应用开发", priority: "A", reason: "目标岗位" }],
    excludeWords: [],
    hardExcludes: []
  });
  await processing;
  const completedStatus = await fetch(`${base}/api/onboarding-status?runId=${encodeURIComponent(runId)}`);
  const completed = await completedStatus.json();
  assert.strictEqual(completed.status, "completed", JSON.stringify(completed));
  assert.strictEqual(completed.stage, "ready");
  assert.match(completed.nextHref, /^\/match-card\?profileId=/);
  assert.strictEqual(completed.nextLabel, "检查匹配偏好卡");

  const completedPage = await fetch(`${base}${progressLocation}`);
  const completedHtml = await completedPage.text();
  assert(completedHtml.includes("处理完成"));
  assert(completedHtml.includes("检查匹配偏好卡"));
  assert(completedHtml.includes(completed.nextHref.replaceAll("&", "&amp;")));

  const stored = getOnboardingRun(db, runId);
  assert(fs.existsSync(path.join(dataRoot, ".runtime", "resumes", `${stored.resumeDocumentId}.txt`)));
  assert(!fs.existsSync(path.join(appRoot, ".runtime", "resumes")), "resume sources must not be written under the app root");
  assert(fs.existsSync(path.join(dataRoot, ".runtime", "logs")), "Dashboard logs must use the stable data root");
  assert(stored.profileVersionId > 0);
  assert(stored.matchingCardId > 0);
  assert(stored.searchPlanId > 0);
  spawns[0].child.emit("close", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(initialSearchPrepareCalls.length, 1, "clean onboarding completion must prepare the initial search page once");
  assert.strictEqual(initialSearchPrepareCalls[0].plan.id, stored.searchPlanId);
  assert.strictEqual(initialSearchPrepareCalls[0].browser.fixture, "onboarding-browser");
  assert(initialSearchPrepareCalls[0].adapter, "the completion hook must receive the paced BOSS adapter");
  assert(dashboardWarnings.some((entry) => entry.event === "onboarding_initial_search_prepare_failed"
    && entry.details.errorCode === "INITIAL_SEARCH_PREPARE_FIXTURE"));
  assert.strictEqual(getOnboardingRun(db, runId).status, "completed", "search preparation failure must not roll back onboarding results");
  const rootAfterCompletion = await fetch(`${base}/`, { redirect: "manual" });
  assert.strictEqual(
    rootAfterCompletion.headers.get("location"),
    completed.nextHref,
    "home must not skip the unconfirmed matching card"
  );
  await testSpawnFailureStaysRecoverable();
  await testAsynchronousChildFailureStaysRecoverable();
  await testNonzeroChildExitStaysRecoverable();
  await testStatusPollingRecoversStaleRun();
  console.log("onboarding_progress_ui_smoke ok");
}

async function testSpawnFailureStaysRecoverable() {
  const failedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-onboarding-spawn-fail-"));
  const failedDbPath = path.join(failedRoot, "jobs.sqlite");
  const failedDb = openDb(failedDbPath);
  const failedServer = createDashboardServer({
    db: failedDb,
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
    root: failedRoot,
    dbPath: failedDbPath,
    forceMock: true,
    spawnProcess() {
      throw Object.assign(new Error("fixture spawn failure"), { code: "ENOENT" });
    }
  });
  try {
    await listen(failedServer);
    const base = `http://127.0.0.1:${failedServer.address().port}`;
    const form = new FormData();
    form.set("resumeText", [
      "姓名：可恢复候选人",
      "求职意向：AI 应用开发工程师",
      "项目经历：KnowledgeFlow 项目，使用 Python、FastAPI 和 RAG。",
      "工作经历：参与企业知识检索服务开发并负责接口联调。",
      "专业技能：Python、FastAPI、RAG、SQLite、Docker。"
    ].join("\n"));
    const upload = await fetch(`${base}/api/resume`, {
      method: "POST",
      body: form,
      redirect: "manual"
    });
    assert.strictEqual(upload.status, 303);
    const location = upload.headers.get("location");
    assert.match(location, /^\/onboarding\/progress\?runId=/);
    const page = await fetch(`${base}${location}`);
    const html = await page.text();
    assert(html.includes("处理已中断"));
    assert(html.includes("重试当前处理"));
    assert(html.includes("简历后台处理未能启动"));
    const runId = new URL(`${base}${location}`).searchParams.get("runId");
    const retry = await fetch(`${base}/api/onboarding-retry`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ runId }),
      redirect: "manual"
    });
    assert.strictEqual(retry.status, 303);
    assert.strictEqual(retry.headers.get("location"), location);
    const retriedPage = await fetch(`${base}${location}`);
    const retriedHtml = await retriedPage.text();
    assert(retriedHtml.includes("处理已中断"));
    assert(retriedHtml.includes("重试当前处理"));
    const home = await fetch(`${base}/`, { redirect: "manual" });
    assert.strictEqual(home.headers.get("location"), location);
  } finally {
    await new Promise((resolve) => failedServer.close(resolve));
    failedDb.close();
    fs.rmSync(failedRoot, { recursive: true, force: true });
  }
}

async function testAsynchronousChildFailureStaysRecoverable() {
  const fixture = await createFailureFixture({
    spawnProcess() {
      const child = new EventEmitter();
      child.pid = 5001;
      child.unref = () => {};
      setImmediate(() => child.emit("error", Object.assign(
        new Error("asynchronous fixture failure"),
        { code: "ENOENT" }
      )));
      return child;
    }
  });
  try {
    const location = await uploadFixtureResume(fixture.base);
    await new Promise((resolve) => setImmediate(resolve));
    const runId = new URL(`${fixture.base}${location}`).searchParams.get("runId");
    const status = await (await fetch(
      `${fixture.base}/api/onboarding-status?runId=${encodeURIComponent(runId)}`
    )).json();
    assert.strictEqual(status.status, "failed");
    assert.strictEqual(status.errorCode, "ONBOARDING_PROCESS_ERROR");
  } finally {
    await fixture.close();
  }
}

async function testNonzeroChildExitStaysRecoverable() {
  let preparationCalls = 0;
  const fixture = await createFailureFixture({
    initialSearchPreparer: async () => { preparationCalls += 1; },
    spawnProcess() {
      const child = new EventEmitter();
      child.pid = 5003;
      child.unref = () => {};
      setImmediate(() => child.emit("close", 1, null));
      return child;
    }
  });
  try {
    const location = await uploadFixtureResume(fixture.base);
    await new Promise((resolve) => setImmediate(resolve));
    const runId = new URL(`${fixture.base}${location}`).searchParams.get("runId");
    const status = await (await fetch(
      `${fixture.base}/api/onboarding-status?runId=${encodeURIComponent(runId)}`
    )).json();
    assert.strictEqual(status.status, "failed");
    assert.strictEqual(status.errorCode, "ONBOARDING_PROCESS_EXITED");
    assert.strictEqual(preparationCalls, 0, "an interrupted onboarding process must not prepare the search page");
  } finally {
    await fixture.close();
  }
}

async function testStatusPollingRecoversStaleRun() {
  const fixture = await createFailureFixture({
    spawnProcess() {
      const child = new EventEmitter();
      child.pid = 5002;
      child.unref = () => {};
      return child;
    }
  });
  try {
    const location = await uploadFixtureResume(fixture.base);
    const runId = new URL(`${fixture.base}${location}`).searchParams.get("runId");
    fixture.db.prepare(`
      UPDATE onboarding_runs
      SET status = 'queued',
        heartbeat_at = '2026-01-01T00:00:00.000Z',
        updated_at = '2026-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(runId);
    const status = await (await fetch(
      `${fixture.base}/api/onboarding-status?runId=${encodeURIComponent(runId)}`
    )).json();
    assert.strictEqual(status.status, "failed");
    assert.strictEqual(status.errorCode, "ONBOARDING_RUN_ORPHANED");
  } finally {
    await fixture.close();
  }
}

async function createFailureFixture({ spawnProcess, initialSearchPreparer }) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-onboarding-child-fail-"));
  const fixtureDbPath = path.join(fixtureRoot, "jobs.sqlite");
  const fixtureDb = openDb(fixtureDbPath);
  const fixtureServer = createDashboardServer({
    db: fixtureDb,
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
    root: fixtureRoot,
    dbPath: fixtureDbPath,
    forceMock: true,
    initialSearchPreparer,
    spawnProcess
  });
  await listen(fixtureServer);
  return {
    base: `http://127.0.0.1:${fixtureServer.address().port}`,
    db: fixtureDb,
    async close() {
      await new Promise((resolve) => fixtureServer.close(resolve));
      fixtureDb.close();
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  };
}

async function uploadFixtureResume(base) {
  const form = new FormData();
  form.set("resumeText", [
    "姓名：进程失败候选人",
    "求职意向：AI 应用开发工程师",
    "项目经历：KnowledgeFlow 项目，使用 Python、FastAPI 和 RAG。",
    "工作经历：参与企业知识检索服务开发并负责接口联调。",
    "专业技能：Python、FastAPI、RAG、SQLite、Docker。"
  ].join("\n"));
  const upload = await fetch(`${base}/api/resume`, {
    method: "POST",
    body: form,
    redirect: "manual"
  });
  assert.strictEqual(upload.status, 303);
  return upload.headers.get("location");
}

function listen(target) {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolve);
  });
}

function quietLogger({ warnings = [] } = {}) {
  return {
    requestId() { return "onboarding-progress-ui"; },
    info() {},
    warn(event, details) { warnings.push({ event, details }); },
    error() {},
    listRecent() { return []; },
    child() { return this; }
  };
}
