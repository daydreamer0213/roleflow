const assert = require("node:assert/strict");
const { createBrowserSupervisor } = require("../src/core/browser_supervisor");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function scheduler() {
  const pending = new Map();
  const cancelled = [];
  let nextId = 0;
  return {
    pending,
    cancelled,
    schedule(callback) {
      const id = ++nextId;
      pending.set(id, callback);
      return id;
    },
    cancel(id) {
      cancelled.push(id);
      pending.delete(id);
    },
    async run(id) {
      const callback = pending.get(id);
      assert.strictEqual(typeof callback, "function", `missing scheduled callback ${id}`);
      pending.delete(id);
      callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

function session(id = "session-1") {
  return {
    sessionId: id,
    pid: 42,
    cdpUrl: "http://127.0.0.1:9222",
    profilePath: "C:\\Users\\Example\\AppData\\Local\\RoleFlow\\BrowserProfile",
    edgePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  };
}

function expectedSnapshot(status, overrides = {}) {
  const states = {
    unknown: [false, "尚未检查 RoleFlow 专用 Edge。", "none"],
    starting: [false, "正在准备 RoleFlow 专用 Edge……", "none"],
    ready: [true, "RoleFlow 专用 Edge 已准备好。", "none"],
    unavailable: [false, "RoleFlow 专用 Edge 暂时无法使用。", "install_edge"],
    conflict: [false, "RoleFlow 专用 Edge 存在本地冲突，未改动任何浏览器。", "view_help"],
    stopped: [false, "RoleFlow 专用 Edge 已关闭，已保留当前进度。", "recover"],
    needs_attention: [false, "RoleFlow 专用 Edge 需要处理后才能继续。", "view_diagnostics"]
  };
  const [ready, message, action] = states[status];
  return {
    status,
    ready,
    message,
    action,
    checkedAt: "2099-01-01T00:00:00.000Z",
    failureCount: 0,
    sessionId: "",
    ...overrides
  };
}

(async () => {
  const ensureGate = deferred();
  const runtimeScheduler = scheduler();
  let ensureCalls = 0;
  let inspectCalls = 0;
  const supervisor = createBrowserSupervisor({
    ensureBrowser: async ({ dashboardUrl, reason }) => {
      ensureCalls += 1;
      assert.strictEqual(dashboardUrl, "http://127.0.0.1:8787/");
      assert.strictEqual(reason, "startup");
      return ensureGate.promise;
    },
    inspectBrowser: async (currentSession) => {
      inspectCalls += 1;
      assert.strictEqual(currentSession.sessionId, "session-1");
      return { ready: true, browser: "Edge/140", pageCount: 1 };
    },
    schedule: runtimeScheduler.schedule,
    cancelSchedule: runtimeScheduler.cancel,
    now: () => "2099-01-01T00:00:00.000Z"
  });

  assert.deepStrictEqual(supervisor.getSnapshot(), expectedSnapshot("unknown"));
  const firstEnsure = supervisor.ensure({ dashboardUrl: "http://127.0.0.1:8787/", reason: "startup" });
  const secondEnsure = supervisor.start({ dashboardUrl: "http://127.0.0.1:8787/", reason: "startup" });
  assert.deepStrictEqual(supervisor.getSnapshot(), expectedSnapshot("starting"));
  assert.strictEqual(ensureCalls, 1, "parallel ensure calls must share one local launch attempt");

  ensureGate.resolve(session());
  assert.deepStrictEqual(await firstEnsure, expectedSnapshot("ready", { sessionId: "session-1" }));
  assert.deepStrictEqual(await secondEnsure, expectedSnapshot("ready", { sessionId: "session-1" }));
  assert.strictEqual(ensureCalls, 1);
  assert.strictEqual(inspectCalls, 1);
  assert.strictEqual(runtimeScheduler.pending.size, 1, "a ready session must schedule one transport monitor");

  await supervisor.inspect();
  assert.deepStrictEqual(supervisor.getSnapshot(), expectedSnapshot("ready", { sessionId: "session-1" }));
  assert.strictEqual(inspectCalls, 2);
  assert.strictEqual(ensureCalls, 1, "transport inspection must never launch Edge");

  supervisor.close();
  assert.deepStrictEqual(runtimeScheduler.cancelled, [1]);
  assert.strictEqual(runtimeScheduler.pending.size, 0);

  for (const [code, status, action] of [
    ["PORTABLE_EDGE_NOT_FOUND", "unavailable", "install_edge"],
    ["PORTABLE_EDGE_START_TIMEOUT", "unavailable", "install_edge"],
    ["PORTABLE_EDGE_PORT_OCCUPIED_NOT_CDP", "conflict", "view_help"],
    ["PORTABLE_EDGE_LISTENER_SNAPSHOT_MISMATCH", "conflict", "view_help"],
    ["ROLEFLOW_BROWSER_PROFILE_IN_USE", "conflict", "view_help"],
    ["UNEXPECTED_LOCAL_FAILURE", "needs_attention", "view_diagnostics"]
  ]) {
    let calls = 0;
    const failed = createBrowserSupervisor({
      ensureBrowser: async () => {
        calls += 1;
        throw codedError(code);
      },
      inspectBrowser: async () => ({ ready: true }),
      schedule: () => 1,
      cancelSchedule: () => {},
      now: () => "2099-01-01T00:00:00.000Z"
    });
    const snapshot = await failed.ensure({ dashboardUrl: "http://127.0.0.1:8787/" });
    assert.strictEqual(snapshot.status, status, code);
    assert.strictEqual(snapshot.action, action, code);
    assert.strictEqual(snapshot.ready, false, code);
    assert.strictEqual(snapshot.failureCount, 1, code);
    assert.strictEqual(snapshot.sessionId, "", code);
    assert.strictEqual(calls, 1, `${code} must not retry process launch`);
    failed.close();
  }

  let reconnectLaunches = 0;
  let transportReady = true;
  const stoppedScheduler = scheduler();
  const stoppedSupervisor = createBrowserSupervisor({
    ensureBrowser: async () => {
      reconnectLaunches += 1;
      return session("stopped-session");
    },
    inspectBrowser: async () => {
      if (!transportReady) throw codedError("BROWSER_DISCONNECTED");
      return { ready: true, browser: "Edge/140", pageCount: 1 };
    },
    schedule: stoppedScheduler.schedule,
    cancelSchedule: stoppedScheduler.cancel,
    now: () => "2099-01-01T00:00:00.000Z"
  });
  await stoppedSupervisor.ensure({ dashboardUrl: "http://127.0.0.1:8787/" });
  transportReady = false;
  await stoppedScheduler.run(1);
  const stopped = stoppedSupervisor.getSnapshot();
  assert.deepStrictEqual(stopped, expectedSnapshot("stopped", {
    action: "recover",
    failureCount: 1,
    sessionId: "stopped-session"
  }));
  assert.strictEqual(reconnectLaunches, 1, "a lost transport must wait for explicit recovery");
  assert.strictEqual(stoppedScheduler.pending.size, 0, "a stopped session must not poll forever");

  transportReady = true;
  const recovered = await stoppedSupervisor.ensure({
    dashboardUrl: "http://127.0.0.1:8787/",
    reason: "user_recovery"
  });
  assert.strictEqual(recovered.status, "ready");
  assert.strictEqual(reconnectLaunches, 2, "explicit recovery may run one new ensure attempt");
  stoppedSupervisor.close();

  console.log("browser_supervisor_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
