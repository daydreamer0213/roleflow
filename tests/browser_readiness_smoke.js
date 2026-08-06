const assert = require("node:assert");
const {
  BROWSER_READINESS_MESSAGES,
  inspectBossBrowserReadiness
} = require("../src/core/browser_readiness");
const { BossSiteAdapter } = require("../src/adapters/sites/boss");

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function inspect(result) {
  return inspectBossBrowserReadiness({
    now: () => "2099-01-01T00:00:00.000Z",
    preflight: async () => {
      if (result instanceof Error) throw result;
      return result;
    }
  });
}

(async () => {
  const cases = [
    ["BROWSER_DISCONNECTED", "browser_unavailable"],
    ["BROWSER_TIMEOUT", "browser_unavailable"],
    ["BROWSER_COMMAND_FAILED", "browser_unavailable"],
    ["BOSS_TAB_REQUIRED", "boss_tab_missing"],
    ["BOSS_LOGIN_REQUIRED", "login_required"],
    ["BOSS_RISK_CONTROL", "risk_control"],
    ["BOSS_SEARCH_PAGE_INVALID", "search_page_required"],
    ["BOSS_SEARCH_PAGE_LOST", "search_page_required"]
  ];
  for (const [code, status] of cases) {
    assert.deepStrictEqual(await inspect(codedError(code)), {
      status,
      ready: false,
      message: BROWSER_READINESS_MESSAGES[status],
      checkedAt: "2099-01-01T00:00:00.000Z"
    });
  }

  assert.strictEqual((await inspect({ isSearchPage: false })).status, "search_page_required");
  assert.deepStrictEqual(await inspect({ isSearchPage: true }), {
    status: "ready",
    ready: true,
    message: BROWSER_READINESS_MESSAGES.ready,
    checkedAt: "2099-01-01T00:00:00.000Z"
  });

  const privateState = await inspect({
    isSearchPage: true,
    url: "https://www.zhipin.com/web/geek/jobs?query=secret",
    account: "private-account",
    cookie: "private-cookie",
    bodyText: "private-dom"
  });
  assert.deepStrictEqual(Object.keys(privateState).sort(), ["checkedAt", "message", "ready", "status"]);

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
  console.log("browser_readiness_smoke ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
