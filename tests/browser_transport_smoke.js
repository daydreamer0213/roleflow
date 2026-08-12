const assert = require("node:assert/strict");
const http = require("node:http");
const { EdgeControlAdapter } = require("../src/adapters/browser/edge_control");
const { CdpBrowserAdapter } = require("../src/adapters/browser/cdp");

const state = {
  mode: "ok",
  edgeRequests: [],
  tabRequests: 0,
  versionRequests: 0,
  edgeNavigateResult: { id: "edge-created-tab" },
  edgeCdpFailureAt: null,
  edgeCdpDispatchCount: 0,
  cdpCreatedTargetListed: false,
  cdpListInvalidAfterCreate: false,
  cdpWindowlessInternalTarget: false
};

const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  res.setHeader("connection", "close");

  if (req.method === "POST" && req.url === "/api/command") {
    const payload = JSON.parse(await readBody(req));
    state.edgeRequests.push(payload);
    if (state.mode === "edge-timeout") return;
    if (state.mode === "edge-list-disconnect-once" && state.edgeRequests.length === 1) {
      req.socket.destroy();
      return;
    }
    if (state.mode === "edge-http-failure") {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "bridge unavailable" }));
      return;
    }
    let result = payload.command === "list_tabs"
      ? [{ id: "edge-tab", windowId: 42, active: true, url: "https://www.zhipin.com/web/geek/jobs" }]
      : payload.command === "navigate"
        ? state.edgeNavigateResult
        : { accepted: true };
    if (payload.command === "send_cdp") {
      const { method } = payload.args;
      if (method === "Target.createTarget") result = { targetId: "edge-created-tab" };
      if (method === "Input.dispatchMouseEvent") {
        state.edgeCdpDispatchCount += 1;
        if (state.edgeCdpDispatchCount === state.edgeCdpFailureAt) {
          res.end(JSON.stringify({ ok: false, error: "dispatch failed" }));
          return;
        }
      }
    }
    res.end(JSON.stringify({ ok: true, result }));
    return;
  }

  if (req.method === "GET" && req.url === "/json/version") {
    state.versionRequests += 1;
    res.end(JSON.stringify({
      Browser: "Edge/140",
      webSocketDebuggerUrl: "ws://transport.test/devtools/browser/cdp-browser"
    }));
    return;
  }

  if (req.method === "GET" && req.url === "/json/list") {
    state.tabRequests += 1;
    if (state.mode === "cdp-timeout") return;
    if (state.mode === "cdp-disconnect") {
      req.socket.destroy();
      return;
    }
    if (state.mode === "cdp-http-failure") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "bad request" }));
      return;
    }
    if (state.cdpListInvalidAfterCreate) {
      res.end(JSON.stringify({ error: "fixture target list unavailable" }));
      return;
    }
    const pages = [{
      id: "cdp-tab",
      type: "page",
      title: "Jobs",
      url: "https://www.zhipin.com/web/geek/jobs",
      webSocketDebuggerUrl: "ws://transport.test/devtools/page/cdp-tab"
    }];
    if (state.cdpCreatedTargetListed) {
      pages.push({
        id: "cdp-created-tab",
        type: "page",
        title: "Created",
        url: "about:blank",
        webSocketDebuggerUrl: "ws://transport.test/devtools/page/cdp-created-tab"
      });
    }
    if (state.cdpWindowlessInternalTarget) {
      pages.push({
        id: "cdp-edge-internal",
        type: "page",
        title: "Edge promotion",
        url: "edge://nurturing/",
        webSocketDebuggerUrl: "ws://transport.test/devtools/page/cdp-edge-internal"
      });
    }
    res.end(JSON.stringify(pages));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

main()
  .then(() => console.log("browser_transport_smoke ok"))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });

async function main() {
  const originalWebSocket = global.WebSocket;
  await listen(server);
  const port = server.address().port;
  const edge = makeEdgeAdapter(port, 100);
  const cdp = new CdpBrowserAdapter({ port, timeoutMs: 100 });

  try {
    reset("edge-timeout");
    edge.requestAttempts.length = 0;
    await rejectsWithCode(() => edge.navigate("edge-tab", "https://example.test/once"), "BROWSER_TIMEOUT");
    assert.deepStrictEqual(
      edge.requestAttempts.map((attempt) => attempt.command),
      ["navigate"],
      "timed-out navigation must not be retried"
    );

    reset("edge-list-disconnect-once");
    const edgeTabs = await edge.listTabs();
    assert.strictEqual(edgeTabs[0].id, "edge-tab");
    assert.strictEqual(state.edgeRequests.length, 2, "read-only Edge tab query may retry once");

    reset("edge-http-failure");
    const navigationError = await rejectsWithCode(
      () => edge.navigate("edge-tab", "https://example.test/no-retry"),
      "BROWSER_COMMAND_FAILED"
    );
    assert.strictEqual(navigationError.status, 503);
    assert.strictEqual(state.edgeRequests.length, 1, "failed navigation must not be retried");

    reset("edge-http-failure");
    await rejectsWithCode(
      () => edge.evalValue("edge-tab", "document.querySelector('button')?.click()"),
      "BROWSER_COMMAND_FAILED"
    );
    assert.strictEqual(state.edgeRequests.length, 1, "arbitrary eval must not be retried");
    assert.strictEqual(state.edgeRequests[0].command, "send_cdp");

    reset("cdp-timeout");
    await rejectsWithCode(() => cdp.listTabs(), "BROWSER_TIMEOUT");
    assert.strictEqual(state.tabRequests, 2, "read-only CDP tab query must retry at most once");

    reset("cdp-disconnect");
    await rejectsWithCode(() => cdp.listTabs(), "BROWSER_DISCONNECTED");
    assert.strictEqual(state.tabRequests, 2, "disconnected CDP tab query must retry at most once");

    reset("cdp-http-failure");
    const httpError = await rejectsWithCode(() => cdp.listTabs(), "BROWSER_COMMAND_FAILED");
    assert.strictEqual(httpError.status, 400);
    assert.strictEqual(state.tabRequests, 1, "non-retryable HTTP failure must not be retried");

    reset("ok");
    const websocket = installFakeWebSocket();
    global.WebSocket = websocket.FakeWebSocket;

    websocket.mode = "respond";
    const identifiedTabs = await cdp.listTabs();
    assert.strictEqual(identifiedTabs.length, 1);
    assert.strictEqual(identifiedTabs[0].id, "cdp-tab");
    assert.strictEqual(identifiedTabs[0].windowId, 42);
    assert.strictEqual(countMethod(websocket.messages, "Browser.getWindowForTarget"), 1);

    websocket.mode = "window-identity-missing";
    await rejectsWithCode(() => cdp.listTabs(), "BROWSER_COMMAND_FAILED");

    websocket.mode = "windowless-edge-internal-target";
    state.cdpWindowlessInternalTarget = true;
    const tabsWithWindowlessInternalTarget = await cdp.listTabs();
    assert.deepStrictEqual(tabsWithWindowlessInternalTarget.map((tab) => tab.id), ["cdp-tab"]);

    state.cdpWindowlessInternalTarget = false;
    websocket.mode = "windowless-web-target";
    await rejectsWithCode(() => cdp.listTabs(), "BROWSER_COMMAND_FAILED");

    websocket.mode = "windowless-blank-target";
    state.cdpCreatedTargetListed = true;
    await rejectsWithCode(() => cdp.listTabs(), "BROWSER_COMMAND_FAILED");
    state.cdpCreatedTargetListed = false;

    websocket.mode = "respond";

    websocket.mode = "disconnect";
    await rejectsWithCode(
      () => cdp.navigate("cdp-tab", "https://example.test/cdp-once"),
      "BROWSER_DISCONNECTED"
    );
    assert.strictEqual(countMethod(websocket.messages, "Page.navigate"), 1, "CDP navigation must be sent once");

    websocket.mode = "disconnect";
    await rejectsWithCode(
      () => cdp.evalValue("cdp-tab", "document.querySelector('button')?.click()"),
      "BROWSER_DISCONNECTED"
    );
    assert.strictEqual(countMethod(websocket.messages, "Runtime.evaluate"), 1, "CDP eval must be sent once");

    websocket.mode = "timeout";
    await rejectsWithCode(
      () => cdp.cdp("cdp-tab", "Runtime.getIsolateId"),
      "BROWSER_TIMEOUT"
    );
    assert.strictEqual(countMethod(websocket.messages, "Runtime.getIsolateId"), 1);

    websocket.mode = "respond";
    websocket.messages.length = 0;
    websocket.urls.length = 0;
    state.versionRequests = 0;
    assert.strictEqual(await cdp.createTab("cdp-tab", "https://example.test/new"), "cdp-created-tab");
    assert.strictEqual(state.versionRequests, 3);
    assert.strictEqual(websocket.urls.at(-1), "ws://transport.test/devtools/browser/cdp-browser");
    assert.notStrictEqual(websocket.urls.at(-1), "ws://transport.test/devtools/page/cdp-tab");
    assert.strictEqual(countMethod(websocket.messages, "Target.createTarget"), 1);
    assert.strictEqual(countMethod(websocket.messages, "Browser.getWindowForTarget") >= 2, true);

    websocket.mode = "created-window-mismatch";
    websocket.messages.length = 0;
    await rejectsWithCode(
      () => cdp.createTab("cdp-tab", "https://example.test/wrong-window"),
      "BROWSER_COMMAND_FAILED"
    );
    assert.strictEqual(countMethod(websocket.messages, "Target.createTarget"), 1);
    assert.strictEqual(countMethod(websocket.messages, "Target.closeTarget"), 1);

    websocket.mode = "created-window-identity-missing";
    websocket.messages.length = 0;
    const missingCreatedIdentityError = await rejectsWithCode(
      () => cdp.createTab("cdp-tab", "https://example.test/missing-window"),
      "BROWSER_COMMAND_FAILED"
    );
    assert.match(missingCreatedIdentityError.message, /no reliable browser window identity: cdp-created-tab/);
    assert.strictEqual(countMethod(websocket.messages, "Target.createTarget"), 1);
    assert.strictEqual(countMethod(websocket.messages, "Target.closeTarget"), 1);

    websocket.mode = "created-window-identity-error-close-fails";
    websocket.messages.length = 0;
    const failedCreatedIdentityError = await rejectsWithCode(
      () => cdp.createTab("cdp-tab", "https://example.test/identity-error"),
      "BROWSER_COMMAND_FAILED"
    );
    assert.match(failedCreatedIdentityError.message, /Browser\.getWindowForTarget failed/);
    assert.strictEqual(countMethod(websocket.messages, "Target.createTarget"), 1);
    assert.strictEqual(countMethod(websocket.messages, "Target.closeTarget"), 1);

    websocket.mode = "close-false-target-persists";
    websocket.messages.length = 0;
    const persistentCleanupError = await rejectsWithCode(
      () => cdp.createTab("cdp-tab", "https://example.test/persistent-cleanup"),
      "BROWSER_COMMAND_FAILED"
    );
    assert.match(persistentCleanupError.message, /Browser\.getWindowForTarget failed/, "the window identity error must remain the primary cause");
    assert.match(persistentCleanupError.message, /清理失败/);
    assert.match(persistentCleanupError.message, /关闭.*标签页/);
    assert.strictEqual(countMethod(websocket.messages, "Target.closeTarget"), 1);

    websocket.mode = "close-false-target-disappears";
    websocket.messages.length = 0;
    state.cdpCreatedTargetListed = false;
    const tabRequestsBeforeDisappearedCleanup = state.tabRequests;
    const disappearedCleanupError = await rejectsWithCode(
      () => cdp.createTab("cdp-tab", "https://example.test/disappeared-cleanup"),
      "BROWSER_COMMAND_FAILED"
    );
    assert.match(disappearedCleanupError.message, /Browser\.getWindowForTarget failed/);
    assert.doesNotMatch(disappearedCleanupError.message, /清理失败/);
    assert.strictEqual(state.tabRequests, tabRequestsBeforeDisappearedCleanup + 2, "cleanup must re-read targets after closeTarget success=false");

    websocket.mode = "close-false-target-list-invalid";
    websocket.messages.length = 0;
    state.cdpListInvalidAfterCreate = false;
    const unconfirmedCleanupError = await rejectsWithCode(
      () => cdp.createTab("cdp-tab", "https://example.test/unconfirmed-cleanup"),
      "BROWSER_COMMAND_FAILED"
    );
    assert.match(unconfirmedCleanupError.message, /Browser\.getWindowForTarget failed/);
    assert.match(unconfirmedCleanupError.message, /清理失败/);
    assert.match(unconfirmedCleanupError.message, /无法确认残留标签页是否已关闭/);

    websocket.mode = "respond";
    state.cdpListInvalidAfterCreate = false;
    await cdp.bringToFront("cdp-tab");
    assert.strictEqual(countMethod(websocket.messages, "Page.bringToFront"), 1);
    await cdp.clickAt("cdp-tab", { x: 120, y: 48 });
    assert.deepStrictEqual(
      websocket.messages.filter((message) => message.method === "Input.dispatchMouseEvent").slice(-3).map((message) => message.method),
      ["Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]
    );
    assert.deepStrictEqual(
      websocket.messages.filter((message) => message.method === "Input.dispatchMouseEvent").slice(-3).map((message) => message.params.type),
      ["mouseMoved", "mousePressed", "mouseReleased"]
    );
    await rejectsWithCode(
      () => cdp.clickAt("cdp-tab", { x: "not-a-number", y: 48 }),
      "BROWSER_COMMAND_FAILED"
    );

    websocket.mode = "fail-third-dispatch";
    websocket.messages.length = 0;
    await rejectsWithCode(() => cdp.clickAt("cdp-tab", { x: 120, y: 48 }), "BROWSER_COMMAND_FAILED");
    assert.strictEqual(countMethod(websocket.messages, "Input.dispatchMouseEvent"), 3);

    reset("ok");
    assert.strictEqual(await edge.createTab("edge-tab", "https://example.test/new"), "edge-created-tab");
    assert.strictEqual(state.edgeRequests[0].command, "list_tabs");
    assert.strictEqual(state.edgeRequests[1].command, "navigate");
    assert.deepStrictEqual(state.edgeRequests[1].args, {
      url: "https://example.test/new",
      createNewTab: true,
      active: false,
      windowId: 42
    });
    reset("ok");
    state.edgeNavigateResult = { tabId: "edge-created-tab-by-tab-id" };
    assert.strictEqual(await edge.createTab("edge-tab"), "edge-created-tab-by-tab-id");
    assert.deepStrictEqual(state.edgeRequests[1].args, {
      url: "about:blank",
      createNewTab: true,
      active: false,
      windowId: 42
    });
    reset("ok");
    state.edgeNavigateResult = { accepted: true };
    await rejectsWithCode(() => edge.createTab("edge-tab"), "BROWSER_COMMAND_FAILED");
    assert.strictEqual(state.edgeRequests.length, 2, "missing Edge tab id must not retry or send another command");
    reset("ok");
    await rejectsWithCode(() => edge.createTab("missing-tab"), "BROWSER_COMMAND_FAILED");
    assert.deepStrictEqual(state.edgeRequests.map((request) => request.command), ["list_tabs"]);

    reset("ok");
    await edge.bringToFront("edge-tab");
    assert.strictEqual(state.edgeRequests[0].args.method, "Page.bringToFront");
    await edge.clickAt("edge-tab", { x: 120, y: 48 });
    const edgeClickRequests = state.edgeRequests
      .filter((request) => request.command === "send_cdp")
      .slice(-3);
    assert.deepStrictEqual(
      edgeClickRequests.map((request) => request.args.method),
      ["Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]
    );
    assert.deepStrictEqual(
      edgeClickRequests.map((request) => request.args.params.type),
      ["mouseMoved", "mousePressed", "mouseReleased"]
    );
    await rejectsWithCode(
      () => edge.clickAt("edge-tab", { x: 120, y: "not-a-number" }),
      "BROWSER_COMMAND_FAILED"
    );

    reset("ok");
    state.edgeCdpFailureAt = 3;
    await rejectsWithCode(() => edge.clickAt("edge-tab", { x: 120, y: 48 }), "BROWSER_COMMAND_FAILED");
    assert.strictEqual(
      state.edgeRequests.filter((request) => request.command === "send_cdp").length,
      3,
      "failed Edge click dispatch must not be retried"
    );
  } finally {
    global.WebSocket = originalWebSocket;
    server.closeAllConnections?.();
    await close(server);
  }
}

function makeEdgeAdapter(port, timeoutMs) {
  const adapter = Object.create(EdgeControlAdapter.prototype);
  adapter.port = port;
  adapter.token = "test-token";
  adapter.timeoutMs = timeoutMs;
  adapter.requestAttempts = [];
  adapter.requestCommand = async function requestCommand(command, args) {
    this.requestAttempts.push({ command, args });
    return EdgeControlAdapter.prototype.requestCommand.call(this, command, args);
  };
  return adapter;
}

function reset(mode) {
  state.mode = mode;
  state.edgeRequests = [];
  state.tabRequests = 0;
  state.versionRequests = 0;
  state.edgeNavigateResult = { id: "edge-created-tab" };
  state.edgeCdpFailureAt = null;
  state.edgeCdpDispatchCount = 0;
  state.cdpCreatedTargetListed = false;
  state.cdpListInvalidAfterCreate = false;
  state.cdpWindowlessInternalTarget = false;
}

function installFakeWebSocket() {
  const control = { mode: "disconnect", messages: [], urls: [] };
  control.FakeWebSocket = class FakeWebSocket {
    constructor(url) {
      control.urls.push(url);
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    send(message) {
      const payload = JSON.parse(message);
      control.messages.push(payload);
      queueMicrotask(() => {
        const dispatchCount = control.messages.filter((item) => item.method === "Input.dispatchMouseEvent").length;
        let result = {};
        let error = null;
        if (payload.method === "Browser.getWindowForTarget") {
          if (control.mode === "window-identity-missing"
            || (control.mode === "created-window-identity-missing"
              && payload.params.targetId === "cdp-created-tab")) result = {};
          else if (control.mode === "windowless-edge-internal-target"
            && payload.params.targetId === "cdp-edge-internal") error = { message: "Browser window not found" };
          else if (control.mode === "windowless-web-target"
            && payload.params.targetId === "cdp-tab") error = { message: "Browser window not found" };
          else if (control.mode === "windowless-blank-target"
            && payload.params.targetId === "cdp-created-tab") error = { message: "Browser window not found" };
          else if (["created-window-identity-error-close-fails", "close-false-target-persists", "close-false-target-disappears", "close-false-target-list-invalid"].includes(control.mode)
            && payload.params.targetId === "cdp-created-tab") error = { message: "identity query failed" };
          else if (control.mode === "created-window-mismatch" && payload.params.targetId === "cdp-created-tab") result = { windowId: 99 };
          else result = { windowId: 42 };
        } else if (payload.method === "Target.createTarget") {
          result = { targetId: "cdp-created-tab" };
          state.cdpCreatedTargetListed = control.mode === "close-false-target-persists";
          state.cdpListInvalidAfterCreate = control.mode === "close-false-target-list-invalid";
        } else if (payload.method === "Target.closeTarget"
          && control.mode === "created-window-identity-error-close-fails") {
          error = { message: "cleanup failed" };
        } else if (payload.method === "Target.closeTarget"
          && ["close-false-target-persists", "close-false-target-disappears", "close-false-target-list-invalid"].includes(control.mode)) {
          result = { success: false };
          if (control.mode === "close-false-target-disappears") state.cdpCreatedTargetListed = false;
        } else if (control.mode === "fail-third-dispatch"
          && payload.method === "Input.dispatchMouseEvent"
          && dispatchCount === 3) {
          error = { message: "dispatch failed" };
        } else if (control.mode === "disconnect") {
          this.emit("close", { code: 1006, reason: "test disconnect" });
          return;
        } else if (control.mode === "timeout") {
          return;
        }
        this.emit("message", {
          data: JSON.stringify(error ? { id: payload.id, error } : { id: payload.id, result })
        });
      });
    }

    close() {}

    emit(type, event) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
  };
  return control;
}

function countMethod(messages, method) {
  return messages.filter((message) => message.method === method).length;
}

async function rejectsWithCode(fn, code) {
  let caught;
  await assert.rejects(fn, (error) => {
    caught = error;
    return error?.code === code;
  });
  return caught;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let value = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { value += chunk; });
    req.on("end", () => resolve(value));
    req.on("error", reject);
  });
}

function listen(target) {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolve);
  });
}

function close(target) {
  return new Promise((resolve) => target.close(resolve));
}
