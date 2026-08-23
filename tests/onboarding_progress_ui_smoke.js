const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { openDb } = require("../src/core/storage");
const { createDashboardServer } = require("../src/dashboard/server");
const { getOnboardingRun } = require("../src/storage/onboarding_store");
const { processOnboardingRun } = require("../src/core/onboarding_run");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-onboarding-progress-"));
const dbPath = path.join(root, "jobs.sqlite");
const db = openDb(dbPath);
const spawns = [];
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
    root,
    dbPath,
    forceMock: true,
    spawnProcess(file, args, options) {
      spawns.push({ file, args, options });
      const child = new EventEmitter();
      child.pid = 4321;
      child.unref = () => {};
      return child;
    }
  });
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;

  const form = new FormData();
  form.set("resumeText", [
    "姓名：王小明",
    "手机：13800138000",
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
  const progressLocation = upload.headers.get("location");
  assert.match(progressLocation, /^\/onboarding\/progress\?runId=/);
  const runId = new URL(`${base}${progressLocation}`).searchParams.get("runId");
  assert(runId);
  assert.strictEqual(spawns.length, 1);
  assert(spawns[0].args.includes("onboarding-process"));
  assert(spawns[0].args.includes("--run"));
  assert(spawns[0].args.includes(runId));
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

  await processOnboardingRun({
    db,
    runId,
    modelConfig: { provider: "mock", providers: { mock: { model: "offline-structured-mock" } } },
    logger: quietLogger()
  });
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
  assert(stored.profileVersionId > 0);
  assert(stored.matchingCardId > 0);
  assert(stored.searchPlanId > 0);
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
  const fixture = await createFailureFixture({
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

async function createFailureFixture({ spawnProcess }) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-onboarding-child-fail-"));
  const fixtureDbPath = path.join(fixtureRoot, "jobs.sqlite");
  const fixtureDb = openDb(fixtureDbPath);
  const fixtureServer = createDashboardServer({
    db: fixtureDb,
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
    root: fixtureRoot,
    dbPath: fixtureDbPath,
    forceMock: true,
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

function quietLogger() {
  return {
    requestId() { return "onboarding-progress-ui"; },
    info() {},
    warn() {},
    error() {},
    listRecent() { return []; },
    child() { return this; }
  };
}
