const assert = require("node:assert");
const {
  BROWSER_READINESS_MESSAGES,
  inspectBossBrowserReadiness
} = require("../src/core/browser_readiness");
const { BossSiteAdapter } = require("../src/adapters/sites/boss");
const { CdpBrowserAdapter } = require("../src/adapters/browser/cdp");
const { createMessageDiscoveryController } = require("../src/dashboard/message_discovery_controller");

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function inspect(result, browserMode = "edge") {
  return inspectBossBrowserReadiness({
    browserMode,
    now: () => "2099-01-01T00:00:00.000Z",
    preflight: async () => {
      if (result instanceof Error) throw result;
      return result;
    }
  });
}

(async () => {
  const cases = [
    ["BROWSER_DISCONNECTED", "browser_unavailable", "recover"],
    ["BROWSER_TIMEOUT", "browser_unavailable", "recover"],
    ["BROWSER_COMMAND_FAILED", "browser_unavailable", "recover"],
    ["BOSS_TAB_REQUIRED", "boss_tab_missing", "reconcile"],
    ["BOSS_LOGIN_REQUIRED", "login_required", "login"],
    ["BOSS_RISK_CONTROL", "risk_control", "verify"],
    ["BOSS_SEARCH_PAGE_INVALID", "search_page_required", "reconcile"],
    ["BOSS_SEARCH_PAGE_LOST", "search_page_required", "reconcile"],
    ["BOSS_SEARCH_TAB_CHANGED", "search_page_required", "reconcile"],
    ["BOSS_COMMUNICATION_PAGE_LOST", "communication_page_required", "reconcile"],
    ["BOSS_OPERATOR_TABS_CHANGED", "communication_page_required", "reconcile"]
  ];
  for (const [code, status, action] of cases) {
    assert.deepStrictEqual(await inspect(codedError(code)), {
      status,
      ready: false,
      message: BROWSER_READINESS_MESSAGES[status],
      action,
      checkedAt: "2099-01-01T00:00:00.000Z"
    });
  }

  assert.strictEqual((await inspect({ isSearchPage: false })).status, "search_page_required");
  assert.deepStrictEqual(await inspect({ isSearchPage: true }), {
    status: "ready",
    ready: true,
    message: BROWSER_READINESS_MESSAGES.ready,
    action: "none",
    checkedAt: "2099-01-01T00:00:00.000Z"
  });

  const supervisorCases = [
    ["unknown", "starting", "wait"],
    ["starting", "starting", "wait"],
    ["unavailable", "unavailable", "recover"],
    ["conflict", "conflict", "diagnostics"],
    ["stopped", "stopped", "recover"],
    ["needs_attention", "needs_attention", "diagnostics"]
  ];
  for (const [supervisorStatus, status, action] of supervisorCases) {
    let preflightCalls = 0;
    const state = await inspectBossBrowserReadiness({
      browserMode: "portable",
      supervisorSnapshot: { status: supervisorStatus, ready: false, message: "private raw path C:\\secret", action: "private" },
      preflight: async () => { preflightCalls += 1; return { isSearchPage: true }; },
      now: () => "2099-01-01T00:00:00.000Z"
    });
    assert.strictEqual(state.status, status);
    assert.strictEqual(state.action, action);
    assert.strictEqual(preflightCalls, 0, `${supervisorStatus} must stop before BOSS preflight`);
    assert.match(state.message, /请|稍候|无需/);
    assert.doesNotMatch(state.message, /CDP|9222|authority|C:\\|stack/i);
  }

  const communicationRequired = await inspect(codedError("BOSS_COMMUNICATION_PAGE_LOST"), "portable");
  assert.strictEqual(communicationRequired.status, "communication_page_required");
  assert.match(communicationRequired.message, /沟通页/);

  const unavailable = await inspectBossBrowserReadiness({
    preflight: async () => {
      const error = new Error("bridge unavailable");
      error.code = "BROWSER_DISCONNECTED";
      throw error;
    },
    now: () => "2099-01-01T00:00:00.000Z"
  });
  assert.strictEqual(unavailable.status, "browser_unavailable");
  assert.match(unavailable.message, /使用当前 Edge（高级，需要浏览器连接组件）/);

  const portableUnavailable = await inspectBossBrowserReadiness({
    browserMode: "portable",
    preflight: async () => { throw codedError("BROWSER_DISCONNECTED"); },
    now: () => "2099-01-01T00:00:00.000Z"
  });
  assert.strictEqual(portableUnavailable.status, "browser_unavailable");
  assert.match(portableUnavailable.message, /RoleFlow 专用 Edge/);
  assert.doesNotMatch(portableUnavailable.message, /普通 Edge/);

  const topology = await inspectBossBrowserReadiness({
    preflight: async () => {
      const error = new Error("fixed tabs differ");
      error.code = "BOSS_WINDOW_MISMATCH";
      throw error;
    },
    now: () => "2099-01-01T00:00:00.000Z"
  });
  assert.strictEqual(topology.status, "boss_tab_missing");
  assert.match(topology.message, /搜索页.*沟通页.*同一窗口/);

  const privateState = await inspect({
    isSearchPage: true,
    url: "https://www.zhipin.com/web/geek/jobs?query=secret",
    account: "private-account",
    cookie: "private-cookie",
    bodyText: "private-dom"
  });
  assert.deepStrictEqual(Object.keys(privateState).sort(), ["action", "checkedAt", "message", "ready", "status"]);

  await assert.rejects(
    () => inspect(codedError("UNEXPECTED_READINESS_FAILURE")),
    (error) => error.code === "UNEXPECTED_READINESS_FAILURE"
  );

  const unreadableBoss = new BossSiteAdapter({
    browser: {
      async listTabs() {
        return [
          { id: "boss-a", url: "https://www.zhipin.com/web/geek/jobs", title: "BOSS A" },
          { id: "boss-b", url: "https://www.zhipin.com/web/geek/jobs?page=2", title: "BOSS B" }
        ];
      },
      async evalValue(tabId) {
        const error = codedError("BROWSER_COMMAND_FAILED");
        error.message = `fixture DOM transport failed for ${tabId}`;
        throw error;
      }
    }
  });
  await assert.rejects(
    () => unreadableBoss.preflight(),
    (error) => error.code === "BROWSER_COMMAND_FAILED"
      && /fixture DOM transport failed/.test(error.message)
  );
  assert.strictEqual(new CdpBrowserAdapter({ port: 9222 }).port, 9222, "portable CDP must use fixed port 9222");
  assert.strictEqual(typeof createMessageDiscoveryController({
    db: null,
    acquireLease() {},
    renewLease() {},
    releaseLease() {}
  }).start, "function", "message discovery controller must expose start");
  console.log("browser_readiness_smoke ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
