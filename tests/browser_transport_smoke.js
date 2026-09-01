const assert = require("node:assert/strict");
const http = require("node:http");
const { EdgeControlAdapter } = require("../src/adapters/browser/edge_control");
const { CdpBrowserAdapter } = require("../src/adapters/browser/cdp");
let browserTabIdentity = null;
try {
  browserTabIdentity = require("../src/core/browser_tab_identity");
} catch {
  // Kept null so the transport behaviors can reach RED before the new helper exists.
}

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
  cdpWindowlessInternalTarget: false,
  cdpExtraPage: false
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
    if (state.cdpExtraPage) {
      pages.unshift({
        id: "cdp-hidden-first",
        type: "page",
        title: "Hidden first",
        url: "https://example.test/hidden-first",
        webSocketDebuggerUrl: "ws://transport.test/devtools/page/cdp-hidden-first"
      });
    }
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
    websocket.visibilityByTarget = {
      "cdp-tab": "visible",
      "cdp-hidden-first": "hidden",
      "cdp-created-tab": "hidden"
    };
    const transport = await cdp.inspectTransport();
    assert.deepStrictEqual(transport, { browser: "Edge/140", pageCount: 1 });
    assert.strictEqual(countMethod(websocket.messages, "Browser.getVersion"), 1);
    assert.strictEqual(countMethod(websocket.messages, "Page.navigate"), 0);
    assert.strictEqual(countMethod(websocket.messages, "Page.bringToFront"), 0);

    const identifiedTabs = await cdp.listTabs();
    assert.strictEqual(identifiedTabs.length, 1);
    assert.strictEqual(identifiedTabs[0].id, "cdp-tab");
    assert.strictEqual(identifiedTabs[0].windowId, 42);
    assert.strictEqual(countMethod(websocket.messages, "Browser.getWindowForTarget"), 1);

    state.cdpExtraPage = true;
    websocket.messages.length = 0;
    const visibilityTabs = await cdp.listTabs();
    assert.deepStrictEqual(
      visibilityTabs.map((tab) => [tab.id, tab.active]),
      [["cdp-hidden-first", false], ["cdp-tab", true]],
      "CDP active state must follow observed visibility, not /json/list order"
    );
    assert.strictEqual(countMethod(websocket.messages, "Runtime.evaluate"), 2);

    websocket.messages.length = 0;
    const bossScopedTabs = await cdp.listTabs({ scope: "boss" });
    assert.deepStrictEqual(bossScopedTabs.map((tab) => tab.id), ["cdp-tab"]);
    assert.strictEqual(countMethod(websocket.messages, "Runtime.evaluate"), 1,
      "BOSS-scoped tab inspection must not evaluate an unrelated Dashboard page");
    assert.strictEqual(countMethod(websocket.messages, "Browser.getWindowForTarget"), 1);
    state.cdpExtraPage = false;

    websocket.mode = "visibility-timeout-once";
    websocket.messages.length = 0;
    const recoveredTabs = await cdp.listTabs({ scope: "boss" });
    assert.deepStrictEqual(recoveredTabs.map((tab) => tab.id), ["cdp-tab"]);
    assert.strictEqual(
      websocket.messages.filter((message) => message.method === "Runtime.evaluate"
        && message.params.expression === "document.visibilityState").length,
      2,
      "a transient timeout while reading page visibility must retry the read exactly once"
    );

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

    state.cdpExtraPage = true;
    websocket.messages.length = 0;
    await cdp.evalValue("cdp-tab", "document.title");
    assert.strictEqual(
      websocket.messages.filter((message) => message.method === "Runtime.evaluate"
        && message.params.expression === "document.visibilityState").length,
      0,
      "a command for a known tab must not inspect every page visibility first"
    );
    assert.strictEqual(
      websocket.messages.filter((message) => message.method === "Runtime.evaluate"
        && message.params.expression === "document.title").length,
      1
    );
    state.cdpExtraPage = false;

    websocket.mode = "disconnect-navigation";
    await rejectsWithCode(
      () => cdp.navigate("cdp-tab", "https://example.test/cdp-once"),
      "BROWSER_DISCONNECTED"
    );
    assert.strictEqual(countMethod(websocket.messages, "Page.navigate"), 1, "CDP navigation must be sent once");

    websocket.mode = "disconnect-eval";
    await rejectsWithCode(
      () => cdp.evalValue("cdp-tab", "document.querySelector('button')?.click()"),
      "BROWSER_DISCONNECTED"
    );
    assert.strictEqual(
      websocket.messages.filter((message) => message.method === "Runtime.evaluate"
        && message.params.expression === "document.querySelector('button')?.click()").length,
      1,
      "CDP eval must be sent once"
    );

    websocket.mode = "timeout-isolate";
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
    assert.strictEqual(state.versionRequests, 4);
    assert(websocket.urls.includes("ws://transport.test/devtools/browser/cdp-browser"));
    assert(websocket.urls.includes("ws://transport.test/devtools/page/cdp-created-tab"));
    assert.strictEqual(countMethod(websocket.messages, "Target.createTarget"), 1);
    assert.strictEqual(countMethod(websocket.messages, "Browser.getWindowForTarget") >= 2, true);
    await cdp.closeTab("cdp-created-tab");

    websocket.messages.length = 0;
    websocket.visibilityByTarget["cdp-tab"] = "hidden";
    assert.strictEqual(
      await cdp.createTab("cdp-tab", "https://example.test/minimized-window"),
      "cdp-created-tab",
      "a minimized window may create a verified background tab without restoring itself"
    );
    assert.strictEqual(countMethod(websocket.messages, "Target.createTarget"), 1);
    assert.strictEqual(countMethod(websocket.messages, "Page.bringToFront"), 0);
    await cdp.closeTab("cdp-created-tab");
    websocket.visibilityByTarget["cdp-tab"] = "visible";

    websocket.mode = "created-visible";
    websocket.messages.length = 0;
    const visibleCreateListRequests = state.tabRequests;
    await rejectsWithCode(
      () => cdp.createTab("cdp-tab", "https://example.test/foreground-created"),
      "BROWSER_COMMAND_FAILED"
    );
    assert.strictEqual(countMethod(websocket.messages, "Target.createTarget"), 1);
    assert.strictEqual(countMethod(websocket.messages, "Target.closeTarget"), 1);
    assert.strictEqual(countMethod(websocket.messages, "Page.bringToFront"), 0);
    assert.strictEqual(
      state.tabRequests - visibleCreateListRequests,
      3,
      "post-issue cleanup must re-list and prove the original typed/visible baseline"
    );

    websocket.mode = "created-visibility-missing";
    websocket.messages.length = 0;
    await rejectsWithCode(
      () => cdp.createTab("cdp-tab", "https://example.test/visibility-unavailable"),
      "BROWSER_COMMAND_FAILED"
    );
    assert.strictEqual(countMethod(websocket.messages, "Target.createTarget"), 1);
    assert.strictEqual(countMethod(websocket.messages, "Target.closeTarget"), 1);
    assert.strictEqual(countMethod(websocket.messages, "Page.bringToFront"), 0);

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

    for (const [mode, succeeds] of [
      ["close-success", true],
      ["close-false", false],
      ["close-missing", false],
      ["close-ambiguous", false],
      ["close-disconnected", false]
    ]) {
      websocket.mode = mode;
      websocket.messages.length = 0;
      if (succeeds) {
        assert.deepStrictEqual(await cdp.closeTab("cdp-created-tab"), { success: true });
      } else {
        await rejectsWithCode(() => cdp.closeTab("cdp-created-tab"),
          mode === "close-disconnected" ? "BROWSER_DISCONNECTED" : "BROWSER_COMMAND_FAILED");
      }
      assert.strictEqual(countMethod(websocket.messages, "Target.closeTarget"), 1, `${mode} must not retry cleanup`);
    }

    websocket.mode = "created-window-mismatch-close-false";
    websocket.messages.length = 0;
    const cleanupFailure = await rejectsWithCode(
      () => cdp.createTab("cdp-tab", "https://example.test/cleanup-failure"),
      "BROWSER_COMMAND_FAILED"
    );
    assert.match(cleanupFailure.message, /清理失败/);
    assert.strictEqual(countMethod(websocket.messages, "Target.closeTarget"), 1);
    assert.strictEqual(countMethod(websocket.messages, "Page.bringToFront"), 0);

    websocket.mode = "respond";
    state.cdpListInvalidAfterCreate = false;
    await cdp.bringToFront("cdp-tab");
    assert.strictEqual(countMethod(websocket.messages, "Page.bringToFront"), 1);
    await cdp.setPageLifecycleActive("cdp-tab");
    assert.strictEqual(countMethod(websocket.messages, "Page.setWebLifecycleState"), 1);
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

    websocket.mode = "respond";
    websocket.messages.length = 0;
    websocket.responseBodies = {
      "allowed-success": { body: JSON.stringify({ code: 0, private: "in-memory-only" }), base64Encoded: false },
      "allowed-http-failure": { body: JSON.stringify({ code: 10003 }), base64Encoded: false }
    };
    for (const method of ["startNetworkLog", "getNetworkLogMark", "readNetworkLog", "stopNetworkLog"]) {
      assert.strictEqual(typeof cdp[method], "function", `portable CDP must implement ${method}`);
    }
    await cdp.startNetworkLog("cdp-tab", {
      maxEntries: 3,
      maxBodies: 2,
      maxBodyBytes: 8192,
      resourceTypes: ["XHR", "Fetch"],
      bodyUrlIncludes: ["/wapi/zpgeek/friend/add.json"],
      urlIncludes: ["/wapi/zpchat/config/get", "/wapi/zpgeek/friend/add.json"],
      captureBodies: true,
      clear: true
    });
    assert.strictEqual(countMethod(websocket.messages, "Network.enable"), 1);
    assert.deepStrictEqual(await cdp.getNetworkLogMark("cdp-tab"), { mark: { lastSequence: 0 } });
    const observerSocket = latestSocket(websocket, "/devtools/page/cdp-tab");
    emitNetworkRequest(observerSocket, {
      requestId: "external-same-path",
      url: "https://tracker.example/wapi/zpgeek/friend/add.json?secret=external",
      type: "Fetch"
    });
    emitNetworkRequest(observerSocket, {
      requestId: "document-request",
      url: "https://www.zhipin.com/wapi/zpgeek/friend/add.json?secret=document",
      type: "Document"
    });
    emitNetworkRequest(observerSocket, {
      requestId: "allowed-success",
      url: "https://www.zhipin.com/wapi/zpgeek/friend/add.json?securityId=private",
      type: "Fetch",
      headers: { Cookie: "must-not-leak", Authorization: "must-not-leak" },
      postData: "must-not-leak"
    });
    emitNetworkResponse(observerSocket, { requestId: "allowed-success", status: 200, type: "Fetch" });
    emitNetworkFinished(observerSocket, "allowed-success");
    emitNetworkRequest(observerSocket, {
      requestId: "allowed-http-failure",
      url: "https://www.zhipin.com/wapi/zpchat/config/get?friendId=private",
      type: "XHR"
    });
    emitNetworkResponse(observerSocket, { requestId: "allowed-http-failure", status: 503, type: "XHR" });
    emitNetworkFinished(observerSocket, "allowed-http-failure");
    emitNetworkRequest(observerSocket, {
      requestId: "allowed-network-failure",
      url: "https://www.zhipin.com/wapi/zpgeek/friend/add.json?securityId=private-2",
      type: "Fetch"
    });
    emitNetworkFailed(observerSocket, "allowed-network-failure");
    emitNetworkFinished(observerSocket, "allowed-success");
    await flushAsyncEvents();
    const observed = await cdp.readNetworkLog("cdp-tab", {
      sinceSequence: 0,
      maxEntries: 12,
      includeBodies: true,
      resourceTypes: ["XHR", "Fetch"],
      urlIncludes: ["/wapi/zpchat/config/get", "/wapi/zpgeek/friend/add.json"],
      consume: false
    });
    assert.strictEqual(observed.entries.length, 3);
    assert.deepStrictEqual(observed.entries.map((entry) => entry.sequence), [1, 2, 3]);
    assert.strictEqual(observed.entries[0].url, "https://www.zhipin.com/wapi/zpgeek/friend/add.json");
    assert.strictEqual(observed.entries[0].status, 200);
    assert.match(observed.entries[0].content, /"code":0/);
    assert.strictEqual(observed.entries[1].status, 503);
    assert.strictEqual(observed.entries[2].failed, true);
    assert(!JSON.stringify(observed).includes("securityId"));
    assert(!JSON.stringify(observed).includes("friendId"));
    assert(!JSON.stringify(observed).includes("must-not-leak"));

    const firstObserverSocket = observerSocket;
    websocket.responseBodies = {
      "bounded-1": { body: "1234567890abcdefghijklmnopqrstuvwxyz", base64Encoded: false },
      "bounded-2": { body: "second-body-must-not-be-read", base64Encoded: false }
    };
    await cdp.startNetworkLog("cdp-tab", {
      maxEntries: 2,
      maxBodies: 1,
      maxBodyBytes: 16,
      resourceTypes: ["XHR", "Fetch"],
      bodyUrlIncludes: ["/wapi/zpgeek/friend/add.json"],
      urlIncludes: ["/wapi/zpgeek/friend/add.json"],
      captureBodies: true,
      clear: true
    });
    assert.strictEqual(firstObserverSocket.closed, true, "replacing an observer must close its socket");
    const boundedSocket = latestSocket(websocket, "/devtools/page/cdp-tab");
    for (const requestId of ["bounded-1", "bounded-2", "bounded-3"]) {
      emitNetworkRequest(boundedSocket, {
        requestId,
        url: `https://www.zhipin.com/wapi/zpgeek/friend/add.json?request=${requestId}`,
        type: "Fetch"
      });
      emitNetworkResponse(boundedSocket, { requestId, status: 200, type: "Fetch" });
      emitNetworkFinished(boundedSocket, requestId);
    }
    await flushAsyncEvents();
    const bounded = await cdp.readNetworkLog("cdp-tab", { sinceSequence: 0, includeBodies: true });
    assert.strictEqual(bounded.entries.length, 2);
    assert.strictEqual(bounded.entries.filter((entry) => Object.hasOwn(entry, "content")).length, 1);
    assert(Buffer.byteLength(bounded.entries[0].content, "utf8") <= 16);
    assert.strictEqual(countMethod(websocket.messages, "Network.getResponseBody"), 2,
      "one allowlisted body from each observer may be read");
    await cdp.stopNetworkLog("cdp-tab");
    assert.strictEqual(boundedSocket.closed, true);
    assert(countMethod(websocket.messages, "Network.disable") >= 2);
    await rejectsWithCode(() => cdp.getNetworkLogMark("cdp-tab"), "BROWSER_COMMAND_FAILED");

    await cdp.startNetworkLog("cdp-tab", networkLogOptions());
    const disconnectedObserver = latestSocket(websocket, "/devtools/page/cdp-tab");
    disconnectedObserver.emit("close", { code: 1006, reason: "fixture disconnect" });
    await flushAsyncEvents();
    assert.strictEqual(cdp.networkObservers.size, 0);
    await rejectsWithCode(() => cdp.getNetworkLogMark("cdp-tab"), "BROWSER_COMMAND_FAILED");

    websocket.bodyErrors = new Set(["body-error"]);
    await cdp.startNetworkLog("cdp-tab", networkLogOptions());
    const bodyErrorObserver = latestSocket(websocket, "/devtools/page/cdp-tab");
    emitNetworkRequest(bodyErrorObserver, {
      requestId: "body-error",
      url: "https://www.zhipin.com/wapi/zpgeek/friend/add.json",
      type: "Fetch"
    });
    emitNetworkResponse(bodyErrorObserver, { requestId: "body-error", status: 200, type: "Fetch" });
    emitNetworkFinished(bodyErrorObserver, "body-error");
    await flushAsyncEvents();
    assert.strictEqual(cdp.networkObservers.size, 0);
    await rejectsWithCode(() => cdp.getNetworkLogMark("cdp-tab"), "BROWSER_COMMAND_FAILED");
    websocket.bodyErrors.clear();

    await cdp.startNetworkLog("cdp-tab", networkLogOptions());
    websocket.messages.length = 0;
    await cdp.closeTab("cdp-tab");
    const disableIndex = websocket.messages.findIndex((message) => message.method === "Network.disable");
    const closeIndex = websocket.messages.findIndex((message) => message.method === "Target.closeTarget");
    assert(disableIndex >= 0 && closeIndex > disableIndex, "target close must release network observation first");
    await rejectsWithCode(() => cdp.getNetworkLogMark("cdp-tab"), "BROWSER_COMMAND_FAILED");

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
    await edge.closeTab(928374);
    assert.deepStrictEqual(state.edgeRequests.map((request) => request.command), ["send_cdp"]);
    assert.strictEqual(state.edgeRequests[0].args.tabId, 928374);
    assert.strictEqual(state.edgeRequests[0].args.method, "Page.close");
    assert.strictEqual(
      state.edgeRequests.filter((request) => request.args.method === "Page.bringToFront").length,
      0,
      "closing a background tab must not focus any Edge tab"
    );

    reset("ok");
    await edge.bringToFront("edge-tab");
    assert.strictEqual(state.edgeRequests[0].args.method, "Page.bringToFront");
    reset("ok");
    await edge.setPageLifecycleActive("edge-tab");
    assert.strictEqual(state.edgeRequests[0].args.method, "Page.setWebLifecycleState");
    assert.deepStrictEqual(state.edgeRequests[0].args.params, { state: "active" });
    reset("ok");
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
    const numericTabId = 1995686980;
    await edge.startNetworkLog(numericTabId, {
      maxEntries: 12,
      maxBodies: 4,
      maxBodyBytes: 8192,
      resourceTypes: ["XHR", "Fetch"],
      bodyUrlIncludes: ["/wapi/zpgeek/friend/add.json"],
      urlIncludes: ["/wapi/zpchat/config/get", "/wapi/zpgeek/friend/add.json"],
      captureBodies: true,
      clear: true
    });
    await edge.getNetworkLogMark(numericTabId);
    await edge.readNetworkLog(numericTabId, {
      sinceSequence: 7,
      maxEntries: 12,
      includeBodies: true,
      resourceTypes: ["XHR", "Fetch"],
      urlIncludes: ["/wapi/zpchat/config/get", "/wapi/zpgeek/friend/add.json"],
      consume: false
    });
    await edge.stopNetworkLog(numericTabId, { clear: true, detachIfIdle: false });
    assert.deepStrictEqual(
      state.edgeRequests.map((request) => request.command),
      ["start_network_log", "get_network_log_mark", "read_network_log", "stop_network_log"]
    );
    assert(state.edgeRequests.every((request) => request.args.tabId === numericTabId));
    assert.strictEqual(state.edgeRequests[0].args.maxBodyBytes, 8192);
    assert.strictEqual(state.edgeRequests[2].args.sinceSequence, 7);

    reset("ok");
    state.edgeCdpFailureAt = 3;
    await rejectsWithCode(() => edge.clickAt("edge-tab", { x: 120, y: 48 }), "BROWSER_COMMAND_FAILED");
    assert.strictEqual(
      state.edgeRequests.filter((request) => request.command === "send_cdp").length,
      3,
      "failed Edge click dispatch must not be retried"
    );

    assert(browserTabIdentity, "browser tab identity helper must exist");
    const { isBrowserTabId, sameBrowserTabId, sortedBrowserTabIds } = browserTabIdentity;
    assert.strictEqual(isBrowserTabId(42), true);
    assert.strictEqual(isBrowserTabId("CDP-target-42"), true);
    assert.strictEqual(sameBrowserTabId(42, "42"), false);
    assert.deepStrictEqual(sortedBrowserTabIds(["b", 2, "a", 1]), [1, 2, "a", "b"]);
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
  state.cdpExtraPage = false;
}

function installFakeWebSocket() {
  const control = {
    mode: "disconnect",
    messages: [],
    urls: [],
    visibilityByTarget: {},
    responseBodies: {},
    bodyErrors: new Set(),
    instances: []
  };
  control.FakeWebSocket = class FakeWebSocket {
    constructor(url) {
      control.urls.push(url);
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      control.instances.push(this);
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
        if (payload.method === "Network.getResponseBody") {
          if (control.bodyErrors.has(payload.params.requestId)) error = { message: "fixture body read failed" };
          else result = control.responseBodies[payload.params.requestId] || { body: "", base64Encoded: false };
        } else if (payload.method === "Runtime.evaluate"
          && payload.params.expression === "document.visibilityState") {
          if (control.mode === "visibility-timeout-once"
            && countMethod(control.messages, "Runtime.evaluate") === 1) return;
          const targetId = this.url.split("/").at(-1);
          const stateValue = control.mode === "created-visible" && targetId === "cdp-created-tab"
            ? "visible"
            : control.mode === "created-visibility-missing" && targetId === "cdp-created-tab"
              ? undefined
              : control.visibilityByTarget[targetId];
          result = stateValue === undefined ? {} : { result: { value: stateValue } };
        } else if (payload.method === "Browser.getWindowForTarget") {
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
          else if (["created-window-mismatch", "created-window-mismatch-close-false"].includes(control.mode)
            && payload.params.targetId === "cdp-created-tab") result = { windowId: 99 };
          else result = { windowId: 42 };
        } else if (payload.method === "Target.createTarget") {
          result = { targetId: "cdp-created-tab" };
          state.cdpCreatedTargetListed = true;
          state.cdpListInvalidAfterCreate = control.mode === "close-false-target-list-invalid";
        } else if (payload.method === "Target.closeTarget"
          && control.mode === "created-window-identity-error-close-fails") {
          error = { message: "cleanup failed" };
        } else if (payload.method === "Target.closeTarget" && control.mode === "close-disconnected") {
          this.emit("close", { code: 1006, reason: "test cleanup disconnect" });
          return;
        } else if (payload.method === "Target.closeTarget" && control.mode === "close-success") {
          result = { success: true };
        } else if (payload.method === "Target.closeTarget" && control.mode === "close-false") {
          result = { success: false };
        } else if (payload.method === "Target.closeTarget" && control.mode === "close-missing") {
          result = {};
        } else if (payload.method === "Target.closeTarget" && control.mode === "close-ambiguous") {
          result = { success: "true" };
        } else if (payload.method === "Target.closeTarget" && control.mode === "created-window-mismatch-close-false") {
          result = { success: false };
        } else if (payload.method === "Target.closeTarget"
          && ["close-false-target-persists", "close-false-target-disappears", "close-false-target-list-invalid"].includes(control.mode)) {
          result = { success: false };
          if (control.mode === "close-false-target-disappears") state.cdpCreatedTargetListed = false;
        } else if (payload.method === "Target.closeTarget") {
          result = { success: true };
          state.cdpCreatedTargetListed = false;
        } else if (control.mode === "fail-third-dispatch"
          && payload.method === "Input.dispatchMouseEvent"
          && dispatchCount === 3) {
          error = { message: "dispatch failed" };
        } else if ((control.mode === "disconnect-navigation" && payload.method === "Page.navigate")
          || (control.mode === "disconnect-eval" && payload.method === "Runtime.evaluate"
            && payload.params.expression !== "document.visibilityState")
          || control.mode === "disconnect") {
          this.emit("close", { code: 1006, reason: "test disconnect" });
          return;
        } else if ((control.mode === "timeout-isolate" && payload.method === "Runtime.getIsolateId")
          || control.mode === "timeout") {
          return;
        }
        this.emit("message", {
          data: JSON.stringify(error ? { id: payload.id, error } : { id: payload.id, result })
        });
      });
    }

    close() { this.closed = true; }

    emit(type, event) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
  };
  return control;
}

function latestSocket(control, urlSuffix) {
  const socket = control.instances.filter((item) => item.url.endsWith(urlSuffix) && !item.closed).at(-1);
  assert(socket, `expected an open websocket ending with ${urlSuffix}`);
  return socket;
}

function networkLogOptions() {
  return {
    maxEntries: 12,
    maxBodies: 4,
    maxBodyBytes: 8192,
    resourceTypes: ["XHR", "Fetch"],
    bodyUrlIncludes: ["/wapi/zpgeek/friend/add.json"],
    urlIncludes: ["/wapi/zpchat/config/get", "/wapi/zpgeek/friend/add.json"],
    captureBodies: true,
    clear: true
  };
}

function emitNetworkRequest(socket, { requestId, url, type, headers = {}, postData = "" }) {
  socket.emit("message", { data: JSON.stringify({
    method: "Network.requestWillBeSent",
    params: { requestId, type, request: { url, method: "POST", headers, postData } }
  }) });
}

function emitNetworkResponse(socket, { requestId, status, type }) {
  socket.emit("message", { data: JSON.stringify({
    method: "Network.responseReceived",
    params: { requestId, type, response: { status, url: "must-not-be-trusted" } }
  }) });
}

function emitNetworkFinished(socket, requestId) {
  socket.emit("message", { data: JSON.stringify({ method: "Network.loadingFinished", params: { requestId } }) });
}

function emitNetworkFailed(socket, requestId) {
  socket.emit("message", { data: JSON.stringify({
    method: "Network.loadingFailed",
    params: { requestId, errorText: "private network error", canceled: false }
  }) });
}

function flushAsyncEvents() {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
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
