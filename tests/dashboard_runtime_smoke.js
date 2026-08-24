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
  const logger = {
    info() {},
    warn() {},
    error() {},
    requestId: (() => { let id = 0; return () => `runtime-${++id}`; })(),
    listRecent() { return []; },
    child() { return logger; }
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
  const workspaceResponses = [
    { status: "ready", bossTabId: "boss-search", communicationTabId: "boss-chat", dashboardTabId: "dashboard" },
    { status: "login_required", bossTabId: "boss-login", communicationTabId: null, dashboardTabId: "dashboard" },
    { status: "ambiguous", errorCode: "BOSS_TAB_REQUIRED", message: "工作区存在多个候选页面。" }
  ];
  const server = createDashboardServer({
    db,
    dbPath,
    root,
    forceMock: true,
    logger: quietLogger(),
    browserAuthority,
    browserSupervisor: supervisor,
    workspaceReconciler: async (input) => {
      reconcileCalls.push({ ...input });
      return workspaceResponses.shift();
    }
  });
  const base = await listen(server);
  try {
    const health = await getJson(base, "/health");
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.ok, true);
    assert.strictEqual(health.body.applicationStatus, "ready");
    assert.deepStrictEqual(health.body.browserRuntime, snapshot("starting"));
    assert.deepStrictEqual(health.body.browserAuthority, browserAuthority);

    const runtime = await getJson(base, "/api/runtime-status");
    assert.deepStrictEqual(runtime.body, {
      application: { status: "ready", ready: true },
      browser: snapshot("starting")
    });

    supervisor.setSnapshot(snapshot("unavailable", {
      message: "RoleFlow 专用 Edge 暂时无法使用。",
      action: "install_edge",
      failureCount: 1
    }));
    const degradedHealth = await getJson(base, "/health");
    assert.strictEqual(degradedHealth.status, 200);
    assert.strictEqual(degradedHealth.body.applicationStatus, "ready");
    assert.strictEqual(degradedHealth.body.browserRuntime.status, "unavailable");

    for (const pathname of ["/onboarding", "/settings", "/diagnostics"]) {
      const response = await fetch(`${base}${pathname}`);
      assert.strictEqual(response.status, 200, `${pathname} must remain available without Edge`);
    }

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
    assert.strictEqual(reconciled.body.workspace.status, "ready");
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
        bossTabId: "boss-login",
        communicationTabId: null,
        dashboardTabId: "dashboard"
      }
    });
    assert.deepStrictEqual(supervisor.calls, [{
      dashboardUrl: `${base}/`,
      reason: "user_recovery"
    }]);
    assert.deepStrictEqual(reconcileCalls, [
      { startupGuidance: false, reason: "user_reconcile" },
      { startupGuidance: false, reason: "user_recovery" }
    ]);

    const ambiguous = await postJson(base, "/api/runtime/workspace/reconcile", {
      startupGuidance: true
    });
    assert.strictEqual(ambiguous.status, 200);
    assert.strictEqual(ambiguous.body.workspace.status, "ambiguous");
    const healthAfterAmbiguity = await getJson(base, "/health");
    assert.strictEqual(healthAfterAmbiguity.status, 200);
    assert.strictEqual(healthAfterAmbiguity.body.applicationStatus, "ready");
    assert.deepStrictEqual(reconcileCalls.at(-1), {
      startupGuidance: false,
      reason: "user_reconcile"
    });
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

async function postJson(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
