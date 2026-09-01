const assert = require("node:assert");
const {
  chooseInitialSearchKeyword,
  prepareInitialSearchPage
} = require("../src/application/onboarding/initial_search_page");

function fixture({ searchUrl = "https://www.zhipin.com/web/geek/jobs?city=101280100&businessDistrict=1001&page=4", extraTabs = [] } = {}) {
  const searchTab = { id: "boss-search", url: searchUrl, windowId: 7, active: false };
  const communicationTab = { id: "boss-communication", url: "https://www.zhipin.com/web/geek/chat", windowId: 7, active: false };
  const state = {
    tabs: [searchTab, communicationTab, ...extraTabs],
    preflightCalls: [],
    navigations: [],
    assertions: [],
    bindingChecks: 0
  };
  const browser = {
    async listTabs(options) {
      assert.deepStrictEqual(options, { scope: "boss" });
      return state.tabs.map((tab) => ({ ...tab }));
    }
  };
  const adapter = {
    async preflight({ tabId }) {
      state.preflightCalls.push(tabId);
      if (tabId === communicationTab.id) {
        return { tabId, url: communicationTab.url, isSearchPage: false };
      }
      return { tabId, url: searchUrl, isSearchPage: true };
    },
    async navigateWithPacing(tabId, url, kind, options) {
      state.navigations.push({ tabId, url, kind, enforceBudget: options.enforceBudget });
      await options.assertTabBindings();
      state.bindingChecks += 1;
    },
    async assertSearchPage(tabId) {
      state.assertions.push(tabId);
    }
  };
  return { browser, adapter, state };
}

(async () => {
  assert.strictEqual(chooseInitialSearchKeyword({
    plan: {
      keywords: [
        { word: " 次要运营 ", priority: "B" },
        { word: "核心用户运营", priority: "A" },
        { word: "另一核心方向", priority: "A" }
      ]
    }
  }), "核心用户运营");
  assert.strictEqual(chooseInitialSearchKeyword({ keywords: ["默认方向"] }), "默认方向");
  assert.strictEqual(chooseInitialSearchKeyword({ plan: { keywords: [{ word: " ", priority: "A" }] } }), "");

  const prepared = fixture();
  const result = await prepareInitialSearchPage({
    plan: {
      plan: {
        keywords: [
          { word: "用户运营", priority: "B" },
          { word: "电商运营", priority: "A" }
        ]
      }
    },
    browser: prepared.browser,
    adapter: prepared.adapter
  });
  assert.deepStrictEqual(result, { status: "prepared", tabId: "boss-search" });
  assert.deepStrictEqual(prepared.state.preflightCalls, ["boss-communication", "boss-search"]);
  assert.strictEqual(prepared.state.navigations.length, 1);
  assert.strictEqual(prepared.state.navigations[0].tabId, "boss-search");
  assert.strictEqual(prepared.state.navigations[0].kind, "list");
  assert.strictEqual(prepared.state.navigations[0].enforceBudget, true);
  const preparedUrl = new URL(prepared.state.navigations[0].url);
  assert.strictEqual(preparedUrl.searchParams.get("query"), "电商运营");
  assert.strictEqual(preparedUrl.searchParams.get("city"), "101280100");
  assert.strictEqual(preparedUrl.searchParams.get("businessDistrict"), "1001");
  assert.strictEqual(preparedUrl.searchParams.has("page"), false);
  assert.deepStrictEqual(prepared.state.assertions, ["boss-search"]);
  assert.strictEqual(prepared.state.bindingChecks, 1);

  const existing = fixture({
    searchUrl: "https://www.zhipin.com/web/geek/jobs?query=%E4%BA%A7%E5%93%81%E8%BF%90%E8%90%A5&city=101280100&page=2"
  });
  assert.deepStrictEqual(await prepareInitialSearchPage({
    plan: { keywords: [{ word: "电商运营", priority: "A" }] },
    browser: existing.browser,
    adapter: existing.adapter
  }), { status: "skipped", reason: "query_present" });
  assert.strictEqual(existing.state.navigations.length, 0);

  const missing = fixture();
  assert.deepStrictEqual(await prepareInitialSearchPage({
    plan: { keywords: [] },
    browser: missing.browser,
    adapter: missing.adapter
  }), { status: "skipped", reason: "keyword_missing" });
  assert.strictEqual(missing.state.preflightCalls.length, 0);
  assert.strictEqual(missing.state.navigations.length, 0);

  const ambiguous = fixture({
    extraTabs: [{ id: "boss-detail", url: "https://www.zhipin.com/job_detail/extra.html", windowId: 7 }]
  });
  await assert.rejects(() => prepareInitialSearchPage({
    plan: { keywords: [{ word: "电商运营", priority: "A" }] },
    browser: ambiguous.browser,
    adapter: ambiguous.adapter
  }), (error) => error.code === "BOSS_TAB_REQUIRED");
  assert.strictEqual(ambiguous.state.preflightCalls.length, 0);
  assert.strictEqual(ambiguous.state.navigations.length, 0);

  console.log("initial_search_page_smoke: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
