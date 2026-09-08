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
const { errorMeta } = require("../src/core/observability");

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
      return [{ id: "dashboard", url: "http://127.0.0.1/plan", active: true, windowId: 1 }, { id: "ZHAOPIN-SEARCH", url: page.url() || url, active: false, windowId: 1 }];
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
    async setPageLifecycleActive(tabId) {
      calls.push({ type: "lifecycle", tabId });
      assert.equal(tabId, "ZHAOPIN-SEARCH");
    },
    async cdp(tabId, method, params) {
      calls.push({ type: "cdp", tabId, method, params });
      assert.equal(tabId, "ZHAOPIN-SEARCH");
      assert.equal(method, "Emulation.setFocusEmulationEnabled");
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
    assert.equal(second.company, "合成乙公司", "verified card publisher must survive client-company detail metadata");
    assert.equal(second.clientCompany, "合成客户公司");
    assert.equal(second.description, "职位描述：合成乙职责，要求独立完成可靠交付。");
    const storage = require('../src/core/storage');
    const db = storage.openDb(':memory:');
    try {
      const batchId = storage.createBatch(db, 'zhaopin', '合成关键词', 'reader-facts');
      storage.upsertJob(db, second, batchId);
      const facts = require('../src/core/job_analysis').jobFacts(storage.listReportJobs(db, { batchId })[0]);
      assert.equal(facts.company, '合成乙公司');
      assert.equal(facts.clientCompany, '合成客户公司');
    } finally { db.close(); }
    assert.equal(bridge.calls.some((call) => call.type === "navigate"), false);

    const afterSwitch = await adapter.readSearchState("ZHAOPIN-SEARCH");
    assert.equal(afterSwitch.selectedIndex, 1);
    assert.notEqual(afterSwitch.detail.sourceId, state.detail.sourceId, "same title cards must remain independent jobs");
    assert.equal(await adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", afterSwitch.cards[2]), null, "unchanged detail link must not be adopted after a card click");
    assert.equal(await adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", afterSwitch.cards[3]), null, "empty card title must stop before click");

    const deniedAdapter = new ZhaopinSiteAdapter({
      browser: bridge,
      sleepFn: async () => {},
      accessController: { reserve: async () => { throw Object.assign(new Error("access denied"), { code: "ZHAOPIN_ACCESS_DENIED" }); } }
    });
    const deniedBefore = await deniedAdapter.readSearchState("ZHAOPIN-SEARCH");
    await assert.rejects(
      () => deniedAdapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", deniedBefore.cards[0]),
      (error) => error.code === "ZHAOPIN_ACCESS_DENIED"
    );
    assert.equal((await deniedAdapter.readSearchState("ZHAOPIN-SEARCH")).selectedIndex, deniedBefore.selectedIndex, "a denied access reservation must not change the selected card");

    await page.reload();
    const waitState = await adapter.readSearchState("ZHAOPIN-SEARCH");
    const waitedAdapter = new ZhaopinSiteAdapter({
      browser: bridge,
      sleepFn: async () => {},
      accessController: {
        reserve: async () => page.evaluate(() => {
          document.querySelectorAll(".job-card .vue-clamp__text")[1].textContent = "等待后变更岗位";
        })
      }
    });
    assert.equal(await waitedAdapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", waitState.cards[1]), null, "a card changed while waiting for access must not be clicked");
    assert.equal((await waitedAdapter.readSearchState("ZHAOPIN-SEARCH")).selectedIndex, 0, "a changed card must leave the previous detail selected");

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

    const currentFixtureHtml = fs.readFileSync(path.join(__dirname, "fixtures", "zhaopin", "search-current.html"), "utf8");
    await page.route("https://www.zhaopin.com/jobs-current/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: currentFixtureHtml
    }));
    await page.goto("https://www.zhaopin.com/jobs-current/?pageMode=search&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D");
    await page.evaluate(() => history.replaceState({}, "", "/jobs/?pageMode=search&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D"));
    const currentState = await adapter.readSearchState("ZHAOPIN-SEARCH");
    assert.equal(currentState.keyword, "合成关键词");
    assert.equal(currentState.cards[0].sourceId, "CCSYNTH001J00000000001");
    assert.equal(currentState.detail.title, "当前结构合成岗位");
    assert.equal(currentState.detail.company, "合成甲公司");
    assert.equal(currentState.detail.clientCompany, "合成客户公司");
    assert.equal(currentState.detail.salary, "18K-25K");
    assert.equal(currentState.detail.location, "合成市·甲区");
    assert.equal(currentState.detail.experience, "3-5年");
    assert.equal(currentState.detail.education, "本科");
    assert.equal(currentState.detail.description, "职位描述：当前结构合成职责，要求独立完成可靠交付。");
    assert.equal(currentState.detail.description.includes("诱饵"), false);
    assert.equal(currentState.detail.sourceId, "CCSYNTH001J00000000001");
    const currentDetail = await adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", currentState.cards[0]);
    assert.ok(currentDetail, "current selected card and summary IDs match the trusted link");
    assert.equal(currentDetail.company, "合成甲公司");
    assert.equal(currentDetail.clientCompany, "合成客户公司");

    await page.evaluate(() => { document.querySelector(".job-company-info__name").textContent = "合成丙公司"; });
    const wrongPublisherState = await adapter.readSearchState("ZHAOPIN-SEARCH");
    assert.equal(
      await adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", wrongPublisherState.cards[0]),
      null,
      "an explicit client company must not bypass a publisher mismatch"
    );

    const vue2FixtureHtml = fs.readFileSync(path.join(__dirname, "fixtures", "zhaopin", "search-vue2.html"), "utf8");
    await page.route("https://www.zhaopin.com/jobs-vue2/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: vue2FixtureHtml
    }));
    await page.goto("https://www.zhaopin.com/jobs-vue2/?pageMode=search&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D");
    await page.evaluate(() => history.replaceState({}, "", "/jobs/?pageMode=search&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D"));
    await page.evaluate(() => {
      window.__zhaopinReadSearchState = () => ({ legacyFixture: true });
      window.__zhaopinReadSearchState.__roleflowVersion = 4;
    });
    const vue2State = await adapter.readSearchState("ZHAOPIN-SEARCH");
    assert.equal(await page.evaluate(() => window.__zhaopinReadSearchState.__roleflowVersion), 5,
      "the upgraded injection replaces a previously cached version 4 helper");
    assert.equal(vue2State.cards[0].sourceId, "CCSYNTHV2A1J00000000001", "Vue 2 JobCard exposes the trusted card ID");
    assert.ok(await adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", vue2State.cards[0]), "same-ID 北京 朝阳 建外 and 北京·朝阳区 are one location");
    const noExternalActionCount = bridge.calls.filter((call) => ["navigate", "bringToFront"].includes(call.type) || call === "bringToFront").length;

    for (const [label, mutate] of [
      ["cross-city", () => { document.querySelector("#vue2-card .job-card__location").textContent = "上海 朝阳 建外"; }],
      ["different-district", () => { document.querySelector("#vue2-card .job-card__location").textContent = "北京 海淀 中关村"; }],
      ["card-id", () => { document.getElementById("vue2-card").__vue__.$props.job.number = "CCWRONGCARD2J00000000001"; }],
      ["detail-id", () => { document.getElementById("vue2-summary").__vue__.$props.jobDetail.detailedPosition.number = "CCWRONGDETAILJ00000000001"; }],
      ["computed-id", () => { document.getElementById("vue2-summary").__vue__.position.number = "CCWRONGCOMPUTJ00000000001"; }],
      ["link-id", () => { document.querySelector(".job-company-info__view-all").href = "https://www.zhaopin.com/jobdetail/CCWRONGLINK2J00000000001.htm"; }],
      ["unmarked-company", () => { document.querySelector(".job-detail-summary__company-name").textContent = "合成冲突公司"; }]
    ]) {
      await page.goto("https://www.zhaopin.com/jobs-vue2/?pageMode=search&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D");
      await page.evaluate(() => history.replaceState({}, "", "/jobs/?pageMode=search&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D"));
      await page.evaluate(mutate);
      const unsafe = await adapter.readSearchState("ZHAOPIN-SEARCH");
      assert.equal(await adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", unsafe.cards[0]), null, `${label} conflict must reject the detail`);
    }
    assert.equal(bridge.calls.filter((call) => ["navigate", "bringToFront"].includes(call.type) || call === "bringToFront").length, noExternalActionCount,
      "rejected identity/location cases perform no external navigation or focus action");

    await page.goto("https://www.zhaopin.com/jobs-vue2/?pageMode=search&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D");
    await page.evaluate(() => {
      history.replaceState({}, "", "/jobs/?pageMode=search&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D");
      delete document.getElementById("vue2-card").__vue__;
      delete document.getElementById("vue2-summary").__vue__;
    });
    const idlessState = await adapter.readSearchState("ZHAOPIN-SEARCH");
    assert.equal(await adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", idlessState.cards[0]), null,
      "without reliable component IDs the original strict location comparison remains in force");

    await page.goto("https://www.zhaopin.com/jobs-current/?pageMode=search&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D");
    await page.evaluate(() => history.replaceState({}, "", "/jobs/?pageMode=search&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D"));
    await page.evaluate(() => { document.querySelector("#current-card .job-card__location").textContent = "另一市 甲区"; });
    const wrongLocationState = await adapter.readSearchState("ZHAOPIN-SEARCH");
    assert.equal(
      await adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", wrongLocationState.cards[0]),
      null,
      "location punctuation equivalence must not accept another city"
    );
    await page.evaluate(() => { document.querySelector("#current-card .job-card__location").textContent = "合成市 甲区"; });

    await page.evaluate(() => {
      document.getElementById("current-card").__vueParentComponent.proxy.$props.job.number = "CCWRONGCARD1J00000000001";
    });
    const wrongCardIdState = await adapter.readSearchState("ZHAOPIN-SEARCH");
    assert.equal(wrongCardIdState.cards[0].title, wrongCardIdState.detail.title);
    assert.equal(
      await adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", wrongCardIdState.cards[0]),
      null,
      "an equal-title current card sourceId must still match the trusted link"
    );
    await page.evaluate(() => {
      document.getElementById("current-card").__vueParentComponent.proxy.$props.job.number = "CCSYNTH001J00000000001";
    });

    await page.evaluate(() => {
      const summary = document.getElementById("current-summary").__vueParentComponent;
      summary.proxy.$props.jobDetail.detailedPosition.number = "CCWRONG001J00000000001";
      summary.proxy.position.number = "CCWRONG001J00000000001";
    });
    assert.equal(
      await adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", currentState.cards[0]),
      null,
      "equal titles must not override a current-layout sourceId mismatch"
    );
    await backgroundReadinessSmoke(page, currentFixtureHtml);
    await defaultFilterCompatibilitySmoke(page);
    await page.goto("https://www.zhaopin.com/jobs/?pageMode=search&jl=548&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D");
    await page.evaluate(() => {
      document.querySelectorAll('.job-card').forEach(node => node.remove());
      document.querySelectorAll('.job-detail-panel,.job-detail-card').forEach(node => node.remove());
      const status = document.createElement('div');
      status.className = 'job-list-panel__status job-list-panel__status--more';
      status.textContent = '没有更多了';
      document.querySelector('.job-list-panel').append(status);
    });
    const emptyState = await adapter.readSearchState("ZHAOPIN-SEARCH");
    assert.equal(emptyState.confirmedEnd, true);
    assert.equal(emptyState.loading, false, "confirmed empty results must not be mistaken for loading");
    let emptyWaits = 0;
    const emptyAdapter = new ZhaopinSiteAdapter({ browser: bridge, sleepFn: async () => { emptyWaits++; }, randomFn: () => 0 });
    const emptyOptions = { searchTemplate: canonicalizeZhaopinSearchTemplate(page.url()), keyword: "合成关键词", filterSummary: emptyState.filterSummary };
    assert.equal((await emptyAdapter.waitForSearchReady("ZHAOPIN-SEARCH", emptyOptions)).cards.length, 0);
    assert.equal(emptyWaits, 0, "confirmed empty result is immediately ready");
    await assert.rejects(() => emptyAdapter.waitForSearchReady("ZHAOPIN-SEARCH", { ...emptyOptions, keyword: "different" }), error => error.code === "ZHAOPIN_SEARCH_RESTORE_TIMEOUT");
    await page.evaluate(() => document.querySelector('.job-list-panel__status--more').remove());
    assert.equal((await adapter.readSearchState("ZHAOPIN-SEARCH")).loading, true);
    await assert.rejects(() => emptyAdapter.waitForSearchReady("ZHAOPIN-SEARCH", emptyOptions), error => error.code === "ZHAOPIN_SEARCH_RESTORE_TIMEOUT");
  } finally {
    await browser.close();
  }
  console.log("zhaopin_readonly_smoke ok");
}

async function backgroundReadinessSmoke(page, fixtureHtml) {
  const searchUrl = "https://www.zhaopin.com/jobs/?pageMode=search&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D";
  await page.route("https://www.zhaopin.com/jobs-background/**", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixtureHtml }));
  const reset = async () => {
    await page.goto("https://www.zhaopin.com/jobs-background/?pageMode=search&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D");
    await page.evaluate((url) => {
      history.replaceState({}, "", url);
      document.title = "后台合成智联搜索页";
      document.querySelector("#current-card .vue-clamp__text").textContent = "";
    }, searchUrl);
  };
  const options = {
    searchTemplate: canonicalizeZhaopinSearchTemplate(searchUrl),
    keyword: "合成关键词",
    filterSummary: ["合成地区"]
  };
  const renderingBridge = (failDisable = null) => {
    const bridge = localBrowser(page, searchUrl);
    let lifecycleActive = false;
    let focusEnabled = false;
    bridge.setPageLifecycleActive = async (tabId) => {
      bridge.calls.push({ type: "lifecycle", tabId });
      lifecycleActive = true;
    };
    bridge.cdp = async (tabId, method, params) => {
      bridge.calls.push({ type: "cdp", tabId, method, params });
      assert.equal(method, "Emulation.setFocusEmulationEnabled");
      focusEnabled = params.enabled;
      if (!params.enabled && failDisable) throw failDisable;
    };
    return {
      bridge,
      render: async () => {
        if (lifecycleActive && focusEnabled) {
          await page.evaluate(() => { document.querySelector("#current-card .vue-clamp__text").textContent = "当前结构合成岗位"; });
        }
      }
    };
  };

  await reset();
  const success = renderingBridge();
  const successAdapter = new ZhaopinSiteAdapter({ browser: success.bridge, sleepFn: success.render });
  assert.equal((await successAdapter.waitForSearchReady("ZHAOPIN-SEARCH", options)).cards[0].title, "当前结构合成岗位");
  assert.deepEqual(success.bridge.calls.filter((call) => call.type === "lifecycle" || call.type === "cdp").map((call) => call.type === "lifecycle" ? "lifecycle" : call.params.enabled), ["lifecycle", true, false]);
  assert.equal((await success.bridge.listTabs()).find((tab) => tab.active).id, "dashboard", "background rendering must preserve the foreground tab");
  assert.equal(success.bridge.calls.some((call) => call.type === "bringToFront"), false);

  for (const [label, prepare, run] of [
    ["timeout", reset, (adapter) => adapter.waitForSearchReady("ZHAOPIN-SEARCH", { ...options, keyword: "不同关键词" })],
    ["login", async () => { await reset(); await page.evaluate(() => document.body.append("请登录")); }, (adapter) => adapter.waitForSearchReady("ZHAOPIN-SEARCH", options)],
    ["risk", async () => { await reset(); await page.evaluate(() => { document.title = "安全验证"; }); }, (adapter) => adapter.waitForSearchReady("ZHAOPIN-SEARCH", options)]
  ]) {
    await prepare();
    const scoped = renderingBridge();
    const scopedAdapter = new ZhaopinSiteAdapter({ browser: scoped.bridge, sleepFn: async () => {} });
    await assert.rejects(() => run(scopedAdapter));
    assert.deepEqual(scoped.bridge.calls.filter((call) => call.type === "cdp").map((call) => call.params.enabled), [true, false], `${label} must release background focus emulation`);
  }

  await reset();
  const cancelled = renderingBridge();
  const controller = new AbortController();
  const cancelledAdapter = new ZhaopinSiteAdapter({ browser: cancelled.bridge, sleepFn: async () => controller.abort() });
  await assert.rejects(() => cancelledAdapter.waitForSearchReady("ZHAOPIN-SEARCH", { ...options, signal: controller.signal }), (error) => error.code === "ZHAOPIN_ABORTED");
  assert.deepEqual(cancelled.bridge.calls.filter((call) => call.type === "cdp").map((call) => call.params.enabled), [true, false], "cancellation must release background focus emulation");

  await reset();
  await page.evaluate(() => { document.querySelector("#current-card .vue-clamp__text").textContent = "当前结构合成岗位"; });
  const cleanupFailure = Object.assign(new Error("focus cleanup failed"), { code: "BROWSER_COMMAND_FAILED" });
  const brokenCleanup = renderingBridge(cleanupFailure);
  await assert.rejects(() => new ZhaopinSiteAdapter({ browser: brokenCleanup.bridge, sleepFn: async () => {} }).waitForSearchReady("ZHAOPIN-SEARCH", options), (error) => error === cleanupFailure);
  assert.deepEqual(brokenCleanup.bridge.calls.filter((call) => call.type === "cdp").map((call) => call.params.enabled), [true, false], "cleanup failure must be surfaced after exactly one release attempt");

  await reset();
  await page.evaluate(() => { document.title = "安全验证"; });
  const transportCause = Object.assign(new Error("transport disconnected"), { code: "BROWSER_DISCONNECTED" });
  const doubleCleanupFailure = Object.assign(new Error("focus cleanup failed after risk"), { code: "BROWSER_COMMAND_FAILED", cause: transportCause });
  const doubleFailure = renderingBridge(doubleCleanupFailure);
  await assert.rejects(
    () => new ZhaopinSiteAdapter({ browser: doubleFailure.bridge, sleepFn: async () => {} }).waitForSearchReady("ZHAOPIN-SEARCH", options),
    (error) => {
      assert.equal(error.code, "BROWSER_COMMAND_FAILED", "cleanup failure remains the outward error");
      assert.equal(error.cause?.code, "ZHAOPIN_RISK_CONTROL", "the primary operation failure remains visible to errorMeta");
      assert.deepEqual(error.errors, [doubleCleanupFailure, error.cause], "both cleanup and primary failures remain directly accessible");
      assert.equal(doubleCleanupFailure.cause, transportCause, "the cleanup transport cause is not overwritten");
      assert.equal(errorMeta(error).cause.message, error.cause.message);
      return true;
    }
  );
}

async function defaultFilterCompatibilitySmoke(page) {
  const searchUrl = "https://www.zhaopin.com/jobs/?pageMode=search&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D";
  await page.goto("https://www.zhaopin.com/jobs-background/?pageMode=search&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D");
  await page.evaluate((url) => history.replaceState({}, "", url), searchUrl);
  const defaults = ["地区", "薪资", "学历", "经验", "公司性质", "融资阶段", "公司人数", "工作性质", "职位类别", "公司行业"];
  const setFilters = (labels) => page.evaluate((items) => {
    document.querySelectorAll(".filter-select-box").forEach((node) => node.remove());
    const input = document.querySelector(".query-sug__input");
    for (const text of items) {
      const box = document.createElement("div");
      box.className = "filter-select-box";
      const label = document.createElement("span");
      label.className = "filter-select-box__label";
      label.textContent = text;
      box.append(label);
      input.after(box);
    }
  }, labels);
  const bridge = localBrowser(page, searchUrl);
  const adapter = new ZhaopinSiteAdapter({ browser: bridge, sleepFn: async () => {} });
  const base = { searchTemplate: canonicalizeZhaopinSearchTemplate(searchUrl), keyword: "合成关键词" };
  await setFilters(defaults);
  assert.equal((await adapter.waitForSearchReady("ZHAOPIN-SEARCH", { ...base, filterSummary: defaults.filter((item) => item !== "融资阶段") })).filterSummary.length, 10,
    "a newly added verified default financing label is compatible with the saved nine defaults");
  for (const [saved, current, label] of [
    [defaults, defaults.map((item) => item === "融资阶段" ? "已融资" : item), "specific current selection"],
    [["广东", ...defaults.slice(1)], defaults, "lost saved selection"],
    [[...defaults, "未知标签甲"], [...defaults, "未知标签乙"], "changed unknown label"]
  ]) {
    await setFilters(current);
    await assert.rejects(() => adapter.waitForSearchReady("ZHAOPIN-SEARCH", { ...base, filterSummary: saved }), (error) => error.code === "ZHAOPIN_SEARCH_RESTORE_TIMEOUT", `${label} must remain strict`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
