const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  canonicalizeZhaopinSearchTemplate,
  buildZhaopinSearchUrl,
  zhaopinJobIdentity
} = require("../src/core/zhaopin_search_scope");
const {
  ZhaopinSiteAdapter,
  ZHAOPIN_PAGE_HELPERS_EXPRESSION
} = require("../src/adapters/sites/zhaopin");

async function loadPlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === "1") throw error;
    console.log("zhaopin_readonly_smoke skipped: playwright unavailable");
    return null;
  }
}

function localBrowser(page, url) {
  const calls = [];
  return {
    calls,
    async listTabs() {
      calls.push("listTabs");
      return [{ id: "ZHAOPIN-SEARCH", url: page.url() || url, active: false, windowId: 1 }];
    },
    async evalValue(tabId, expression) {
      calls.push({ type: "evalValue", tabId, expression });
      assert.equal(tabId, "ZHAOPIN-SEARCH");
      return page.evaluate(expression);
    },
    async navigate(tabId, target) {
      calls.push({ type: "navigate", tabId, target });
      assert.equal(tabId, "ZHAOPIN-SEARCH");
    },
    async bringToFront() {
      throw new Error("readonly adapter must not activate a tab");
    }
  };
}

async function main() {
  assert.notStrictEqual(
    zhaopinJobIdentity("https://www.zhaopin.com/jobdetail/CCSYNTH001J00000000001.htm").sourceId,
    zhaopinJobIdentity("https://www.zhaopin.com/jobdetail/CCSYNTH002J00000000002.htm").sourceId
  );
  assert.throws(() => zhaopinJobIdentity("https://www.zhaopin.com/companydetail/CZSYNTH.htm"));
  assert.throws(() => zhaopinJobIdentity("https://example.test/jobdetail/CCSYNTH001J00000000001.htm"));

  const template = canonicalizeZhaopinSearchTemplate("https://www.zhaopin.com/jobs/?pageMode=search&jl=548&sl=10001,15000&el=4&kw=old&utm_source=fixture");
  assert.deepEqual(template, {
    mode: "inherited",
    url: "https://www.zhaopin.com/jobs/?el=4&jl=548&pageMode=search&sl=10001%2C15000",
    cityCode: "548"
  });
  assert.throws(
    () => canonicalizeZhaopinSearchTemplate("https://www.zhaopin.com/jobs/?pageMode=search&jl=548&unverified=1"),
    (error) => error.code === "ZHAOPIN_SEARCH_PARAM_UNSUPPORTED" && /unverified/.test(error.message)
  );
  const target = new URL(buildZhaopinSearchUrl({ keyword: "AI 应用", searchTemplate: template }));
  assert.equal(target.searchParams.get("jl"), "548");
  assert.equal(target.searchParams.get("sl"), "10001,15000");
  assert.equal(target.searchParams.get("el"), "4");
  assert.equal(target.searchParams.get("kw"), "AI 应用");
  assert.equal(target.searchParams.get("pageMode"), "search");

  const playwright = await loadPlaywright();
  if (!playwright) return;
  const browser = await playwright.chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    const fixture = path.join(__dirname, "fixtures", "zhaopin", "search.html");
    const fixtureHtml = fs.readFileSync(fixture, "utf8");
    await page.route("https://www.zhaopin.com/jobs/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: fixtureHtml
    }));
    await page.goto("https://www.zhaopin.com/jobs/?pageMode=search&jl=548&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D");
    const bridge = localBrowser(page, "https://www.zhaopin.com/jobs/?pageMode=search&jl=548&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D");
    const adapter = new ZhaopinSiteAdapter({ browser: bridge, sleepFn: async () => {}, randomFn: () => 0 });

    const state = await adapter.readSearchState("ZHAOPIN-SEARCH");
    assert.equal(state.cards.length, 4);
    assert.equal(state.cards[0].sourceId, undefined, "sourceId must come from the current detail, not list index");
    assert.equal(state.cards[0].title, "同名合成岗位");
    assert.equal(state.detail.description.includes("HR区域"), false, "description must come only from the detail body");
    assert.equal(await page.evaluate(ZHAOPIN_PAGE_HELPERS_EXPRESSION), true, "exported DOM helper must run in a real page");

    const second = await adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", state.cards[1]);
    assert.ok(second, "a selected card with matching visible detail must produce a job");
    assert.equal(second.sourceId, "CCSYNTH002J00000000002");
    assert.equal(second.company, "");
    assert.equal(second.clientCompany, "合成客户公司");
    assert.equal(second.description, "职位描述：合成乙职责，要求独立完成可靠交付。");
    assert.equal(bridge.calls.some((call) => call.type === "navigate"), false);

    const afterSwitch = await adapter.readSearchState("ZHAOPIN-SEARCH");
    assert.equal(afterSwitch.selectedIndex, 1);
    assert.notEqual(afterSwitch.detail.sourceId, state.detail.sourceId, "same title cards must remain independent jobs");
    assert.equal(await adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", afterSwitch.cards[2]), null, "unchanged detail link must not be adopted after a card click");
    assert.equal(await adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", afterSwitch.cards[3]), null, "empty card title must stop before click");

    await page.evaluate(() => { document.title = "安全验证"; });
    await assert.rejects(
      () => adapter.readSearchState("ZHAOPIN-SEARCH"),
      (error) => error.code === "ZHAOPIN_RISK_CONTROL"
    );
    await page.route("https://www.zhaopin.com/not-search", (route) => route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: fixtureHtml
    }));
    await page.goto("https://www.zhaopin.com/not-search");
    await assert.rejects(
      () => adapter.readSearchState("ZHAOPIN-SEARCH"),
      (error) => error.code === "ZHAOPIN_SEARCH_PAGE_LOST"
    );
    await page.goto("https://www.zhaopin.com/jobs/?pageMode=recommend");
    await assert.rejects(
      () => adapter.readSearchState("ZHAOPIN-SEARCH"),
      (error) => error.code === "ZHAOPIN_SEARCH_PAGE_LOST"
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", afterSwitch.cards[1], controller.signal),
      (error) => error.code === "ZHAOPIN_ABORTED"
    );
    assert.equal(bridge.calls.includes("bringToFront"), false);
  } finally {
    await browser.close();
  }
  console.log("zhaopin_readonly_smoke ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
