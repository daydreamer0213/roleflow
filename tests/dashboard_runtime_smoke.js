const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openDb } = require("../src/core/storage");
const { createDashboardServer } = require("../src/dashboard/server");

const root = path.resolve(__dirname, "..");
const smokeRoot = path.join(root, ".runtime", "dashboard-runtime-smoke");
const dbPath = path.join(smokeRoot, `runtime-${process.pid}-${Date.now()}.sqlite`);

function snapshot(status, overrides = {}) {
  const ready = status === "ready";
  return {
    status,
    ready,
    message: ready ? "RoleFlow 专用 Edge 已准备好。" : "正在准备 RoleFlow 专用 Edge……",
    action: "none",
    checkedAt: "2099-01-01T00:00:00.000Z",
    failureCount: 0,
    sessionId: ready ? "runtime-session" : "",
    ...overrides
  };
}

function fakeSupervisor() {
  let current = snapshot("starting");
  const calls = [];
  let closed = 0;
  return {
    calls,
    get closed() { return closed; },
    getSnapshot() { return { ...current }; },
    setSnapshot(value) { current = { ...value }; },
    async ensure(input) {
      calls.push({ ...input });
      current = snapshot("ready");
      return { ...current };
    },
    close() { closed += 1; }
  };
}

function quietLogger() {
  fs.mkdirSync(path.join(smokeRoot, ".runtime", "logs"), { recursive: true });
  const logger = {
    info() {},
    warn() {},
    error() {},
    requestId: (() => { let id = 0; return () => `runtime-${++id}`; })(),
    listRecent() { return []; },
    child() { return logger; },
    logDir: path.join(smokeRoot, ".runtime", "logs")
  };
  return logger;
}

(async () => {
  fs.mkdirSync(smokeRoot, { recursive: true });
  const db = openDb(dbPath);
  const supervisor = fakeSupervisor();
  const browserAuthority = {
    browserMode: "portable",
    cdpPort: 9222,
    profilePath: "C:\\Users\\Example\\AppData\\Local\\RoleFlow\\BrowserProfile"
  };
  const reconcileCalls = [];
  const openedLogFolders = [];
  let failOpeningLogs = false;
  let spawnCalls = 0;
  const workspaceResponses = [
    { status: "ready", bossTabId: "boss-search", communicationTabId: "boss-chat", dashboardTabId: "dashboard" },
    { status: "login_required", bossTabId: "boss-login", communicationTabId: null, dashboardTabId: "dashboard" },
    { status: "ambiguous", errorCode: "BOSS_TAB_REQUIRED", message: "工作区存在多个候选页面。" }
  ];
  const server = createDashboardServer({
    db,
    dbPath,
    root,
    dataRoot: smokeRoot,
    forceMock: true,
    logger: quietLogger(),
    browserAuthority,
    browserSupervisor: supervisor,
    spawnProcess() { spawnCalls += 1; throw new Error("browser gate must run before spawn"); },
    workspaceReconciler: async (input) => {
      reconcileCalls.push({ ...input });
      return workspaceResponses.shift();
    },
    applicationVersion: "9.8.7-test",
    launchSessionId: "launch-session-test",
    diagnosticsActionToken: "diagnostics-action-test",
    openLogsFolder: (folder) => {
      if (failOpeningLogs) throw new Error("explorer unavailable");
      openedLogFolders.push(folder);
    }
  });
  const base = await listen(server);
  try {
    const health = await getJson(base, "/health");
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.ok, true);
    assert.strictEqual(health.body.applicationStatus, "ready");
    assert.deepStrictEqual(health.body.browserRuntime, snapshot("starting"));
    assert.deepStrictEqual(health.body.workspaceRuntime, {
      status: "unchecked",
      ready: false,
      message: "BOSS 工作区尚未检查。"
    });
    assert.deepStrictEqual(health.body.browserAuthority, browserAuthority);

    const runtime = await getJson(base, "/api/runtime-status");
    assert.deepStrictEqual(runtime.body, {
      application: { status: "ready", ready: true },
      browser: snapshot("starting"),
      workspace: {
        status: "unchecked",
        ready: false,
        message: "BOSS 工作区尚未检查。"
      }
    });

    const diagnostics = await getJson(base, "/api/runtime-diagnostics");
    assert.strictEqual(diagnostics.status, 200);
    assert.strictEqual(diagnostics.body.schemaVersion, 1);
    assert.match(diagnostics.body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepStrictEqual(diagnostics.body.application, {
      status: "ready",
      ready: true,
      version: "9.8.7-test",
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      launchSessionId: "launch-session-test"
    });
    assert.deepStrictEqual(diagnostics.body.browser, {
      status: "starting",
      ready: false,
      action: "none",
      checkedAt: "2099-01-01T00:00:00.000Z",
      failureCount: 0,
      sessionId: ""
    });
    assert.deepStrictEqual(diagnostics.body.workspace, {
      status: "unchecked",
      ready: false
    });
    assert.deepStrictEqual(diagnostics.body.logs, {
      available: true,
      label: "RoleFlow 用户日志目录"
    });
    const diagnosticText = JSON.stringify(diagnostics.body);
    assert.doesNotMatch(diagnosticText, /profilePath|BrowserProfile|commandLine|cookie|resume|BOSS-SEARCH|boss-search/i);
    assert.doesNotMatch(diagnosticText, new RegExp(escapeRegExp(path.resolve(smokeRoot)), "i"));

    const diagnosticsPage = await fetch(`${base}/diagnostics`).then((response) => response.text());
    assert.match(diagnosticsPage, /复制诊断信息/);
    assert.match(diagnosticsPage, /打开日志文件夹/);
    assert.match(diagnosticsPage, /当前用户的 RoleFlow 数据目录/);
    assert.doesNotMatch(diagnosticsPage, /项目的 \.runtime\/logs/);

    const missingAction = await postJson(base, "/api/runtime-diagnostics/open-logs", {});
    assert.strictEqual(missingAction.status, 403);
    assert.strictEqual(missingAction.body.errorCode, "RUNTIME_DIAGNOSTICS_ACTION_REQUIRED");
    assert.deepStrictEqual(openedLogFolders, []);

    const rejectedLogPath = await postJson(base, "/api/runtime-diagnostics/open-logs", {
      path: "C:\\Windows"
    }, { "x-roleflow-action": "diagnostics-action-test" });
    assert.strictEqual(rejectedLogPath.status, 400);
    assert.strictEqual(rejectedLogPath.body.errorCode, "RUNTIME_DIAGNOSTICS_INPUT_NOT_ALLOWED");
    assert.deepStrictEqual(openedLogFolders, []);

    const openedLogs = await postJson(base, "/api/runtime-diagnostics/open-logs", {}, {
      "x-roleflow-action": "diagnostics-action-test"
    });
    assert.strictEqual(openedLogs.status, 200);
    assert.deepStrictEqual(openedLogs.body, { ok: true });
    assert.deepStrictEqual(openedLogFolders, [path.resolve(smokeRoot, ".runtime", "logs")]);

    const logDir = path.resolve(smokeRoot, ".runtime", "logs");
    const externalLogDir = path.resolve(smokeRoot, "external-log-target");
    const externalSentinel = path.join(externalLogDir, "keep.txt");
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.mkdirSync(externalLogDir, { recursive: true });
    fs.writeFileSync(externalSentinel, "keep", "utf8");
    fs.symlinkSync(externalLogDir, logDir, "junction");
    const blockedReparse = await postJson(base, "/api/runtime-diagnostics/open-logs", {}, {
      "x-roleflow-action": "diagnostics-action-test"
    });
    assert.strictEqual(blockedReparse.status, 500);
    assert.strictEqual(blockedReparse.body.errorCode, "ROLEFLOW_RUNTIME_REPARSE_POINT_BLOCKED");
    assert.deepStrictEqual(openedLogFolders, [path.resolve(smokeRoot, ".runtime", "logs")]);
    assert.strictEqual(fs.readFileSync(externalSentinel, "utf8"), "keep");
    fs.rmSync(logDir, { force: true });
    fs.mkdirSync(logDir, { recursive: true });

    failOpeningLogs = true;
    const failedOpen = await postJson(base, "/api/runtime-diagnostics/open-logs", {}, {
      "x-roleflow-action": "diagnostics-action-test"
    });
    assert.strictEqual(failedOpen.status, 500);
    assert.strictEqual(failedOpen.body.errorCode, "RUNTIME_LOG_FOLDER_OPEN_FAILED");
    failOpeningLogs = false;

    supervisor.setSnapshot(snapshot("unavailable", {
      message: "RoleFlow 专用 Edge 暂时无法使用。",
      action: "install_edge",
      failureCount: 1
    }));
    const degradedHealth = await getJson(base, "/health");
    assert.strictEqual(degradedHealth.status, 200);
    assert.strictEqual(degradedHealth.body.applicationStatus, "ready");
    assert.strictEqual(degradedHealth.body.browserRuntime.status, "unavailable");
    const unavailableReadiness = await getJson(base, "/api/browser-readiness");
    assert.strictEqual(unavailableReadiness.status, 200);
    assert.strictEqual(unavailableReadiness.body.status, "unavailable");
    assert.strictEqual(unavailableReadiness.body.action, "recover");

    for (const pathname of ["/onboarding", "/settings", "/diagnostics"]) {
      const response = await fetch(`${base}${pathname}`);
      assert.strictEqual(response.status, 200, `${pathname} must remain available without Edge`);
    }

    for (const pathname of ["/api/scan", "/api/workflow-run"]) {
      const blocked = await postJson(base, pathname, {});
      assert.strictEqual(blocked.status, 409, `${pathname} must stop while the managed browser is unavailable`);
      assert.strictEqual(blocked.body.errorCode, "BROWSER_RUNTIME_NOT_READY");
    }
    const blockedDiscovery = await postJson(base, "/api/message-discovery", {
      action: "start",
      profileId: 1
    });
    assert.strictEqual(blockedDiscovery.status, 409);
    assert.strictEqual(blockedDiscovery.body.errorCode, "BROWSER_RUNTIME_NOT_READY");
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM site_scan_leases WHERE site = 'boss'").get().count,
      0,
      "browser gate must stop message discovery before lease acquisition"
    );
    assert.strictEqual(spawnCalls, 0);
    assert.deepStrictEqual(supervisor.calls, [], "operation failures must never recover Edge automatically");

    const blockedReconcile = await postJson(base, "/api/runtime/workspace/reconcile", {
      startupGuidance: true
    });
    assert.strictEqual(blockedReconcile.status, 409);
    assert.strictEqual(blockedReconcile.body.errorCode, "BROWSER_RUNTIME_NOT_READY");
    assert.deepStrictEqual(reconcileCalls, []);

    supervisor.setSnapshot(snapshot("ready"));
    const reconciled = await postJson(base, "/api/runtime/workspace/reconcile", {
      startupGuidance: true
    });
    assert.strictEqual(reconciled.status, 200);
    assert.deepStrictEqual(reconciled.body.workspace, {
      status: "ready",
      ready: true,
      message: "BOSS 工作区已就绪。"
    });
    assert.doesNotMatch(JSON.stringify(reconciled.body), /boss-search|boss-chat|dashboard/);
    const readyRuntime = await getJson(base, "/api/runtime-status");
    assert.strictEqual(readyRuntime.body.workspace.status, "ready");
    assert.strictEqual(readyRuntime.body.workspace.ready, true);
    assert.deepStrictEqual(reconcileCalls, [{
      startupGuidance: false,
      reason: "user_reconcile"
    }]);

    supervisor.setSnapshot(snapshot("unavailable", {
      message: "RoleFlow 专用 Edge 暂时无法使用。",
      action: "install_edge",
      failureCount: 1
    }));

    const recovered = await postJson(base, "/api/runtime/browser/recover", {});
    assert.strictEqual(recovered.status, 200);
    assert.deepStrictEqual(recovered.body, {
      browser: snapshot("ready"),
      workspace: {
        status: "login_required",
        ready: false,
        message: "请在专用 Edge 登录 BOSS，完成后重新检查。"
      }
    });
    assert.doesNotMatch(JSON.stringify(recovered.body), /boss-login|dashboard/);
    assert.deepStrictEqual(supervisor.calls, [{
      dashboardUrl: `${base}/`,
      reason: "user_recovery"
    }]);
    assert.deepStrictEqual(reconcileCalls, [
      { startupGuidance: false, reason: "user_reconcile" },
      { startupGuidance: false, reason: "user_recovery" }
    ]);
    const loginRuntime = await getJson(base, "/api/runtime-status");
    assert.strictEqual(loginRuntime.body.workspace.status, "login_required");
    assert.match(loginRuntime.body.workspace.message, /登录/);

    const ambiguous = await postJson(base, "/api/runtime/workspace/reconcile", {
      startupGuidance: true
    });
    assert.strictEqual(ambiguous.status, 200);
    assert.deepStrictEqual(ambiguous.body.workspace, {
      status: "ambiguous",
      ready: false,
      message: "BOSS 工作区存在无法安全判断的页面，请查看诊断。"
    });
    const ambiguousRuntime = await getJson(base, "/api/runtime-status");
    assert.strictEqual(ambiguousRuntime.body.workspace.status, "ambiguous");
    assert.doesNotMatch(JSON.stringify(ambiguousRuntime.body.workspace), /boss-search|boss-chat|dashboard/);
    const healthAfterAmbiguity = await getJson(base, "/health");
    assert.strictEqual(healthAfterAmbiguity.status, 200);
    assert.strictEqual(healthAfterAmbiguity.body.applicationStatus, "ready");
    assert.deepStrictEqual(reconcileCalls.at(-1), {
      startupGuidance: false,
      reason: "user_reconcile"
    });

    workspaceResponses.push({ status: "ready", bossTabId: "initial-boss", communicationTabId: "initial-chat" });
    const initialWorkspace = await server.reconcileWorkspace({
      startupGuidance: true,
      reason: "initial_startup"
    });
    assert.strictEqual(initialWorkspace.status, "ready");
    const afterInitialRuntime = await getJson(base, "/api/runtime-status");
    assert.strictEqual(afterInitialRuntime.body.workspace.status, "ready");
  } finally {
    await close(server);
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
  assert.strictEqual(supervisor.closed, 1, "Dashboard shutdown must close its browser supervisor");

  console.log("dashboard_runtime_smoke ok");
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

async function getJson(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function postJson(base, pathname, body, extraHeaders = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
