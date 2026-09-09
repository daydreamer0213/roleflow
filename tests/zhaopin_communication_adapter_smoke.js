const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ZhaopinCommunicationAdapter,
  inspectZhaopinCommunicationTabs
} = require("../src/adapters/sites/zhaopin_communication");
const { createSiteAdapter } = require("../src/adapters/sites");
const { CdpNetworkLog } = require("../src/adapters/browser/cdp_network_log");

let chromium;
try { ({ chromium } = require("playwright")); }
catch (error) {
  if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === "1") throw error;
  console.log("zhaopin_communication_adapter_smoke SKIP: Playwright unavailable");
  process.exit(0);
}

const SEARCH_TAB = "cdp-zhaopin-search";
const WINDOW_ID = 17;
const DASHBOARD_TAB = "dashboard";
const SEARCH_URL = "https://www.zhaopin.com/jobs/?pageMode=search&jl=548&kw=%E5%90%88%E6%88%90%E5%85%B3%E9%94%AE%E8%AF%8D";
const JOB_A = Object.freeze({
  id: 1,
  source: "zhaopin",
  sourceId: "CCSYNTH001J00000000001",
  url: "https://www.zhaopin.com/jobdetail/CCSYNTH001J00000000001.htm",
  title: "同名合成岗位",
  company: "合成甲有限责任公司",
  searchUrl: SEARCH_URL
});
const JOB_B = Object.freeze({
  ...JOB_A,
  id: 2,
  sourceId: "CCSYNTH002J00000000002",
  url: "https://www.zhaopin.com/jobdetail/CCSYNTH002J00000000002.htm",
  company: "合成乙公司"
});

function safeEntry(job = JOB_A, clock = 1000, overrides = {}) {
  return {
    sequence: 1,
    url: "https://cgate.zhaopin.com/imapi/imV2/createAndUpdateContextV2",
    method: "GET",
    requestTarget: { jobNumber: job.sourceId, scene: "2", operateType: "2" },
    resourceType: "Fetch",
    startedAt: new Date(clock).toISOString(),
    completedAt: new Date(clock + 5).toISOString(),
    status: 200,
    content: JSON.stringify({ data: { sessionId: "a".repeat(32) } }),
    ...overrides
  };
}

function rawEntry(job = JOB_A, clock = 1000, overrides = {}) {
  return {
    sequence: 1,
    requestId: "must-not-leak",
    url: `https://cgate.zhaopin.com/imapi/imV2/createAndUpdateContextV2?jobNumber=${job.sourceId}&positionChatBeforeDeliveryScene=2&positionChatBeforeDeliveryOperateType=2&token=must-not-leak`,
    method: "GET",
    resourceType: "Fetch",
    startedAt: new Date(clock).toISOString(),
    completedAt: new Date(clock + 5).toISOString(),
    status: 200,
    content: JSON.stringify({ data: { sessionId: "a".repeat(32) } }),
    ...overrides
  };
}

function fakeBrowser(page, { transport = "direct", onClick = null, startError = null, startResult = null, clickError = null, focusDisableError = null, stopNetworkError = null, hideNextPageJobBTitleUntilRendered = false, onRenderingEnabled = null } = {}) {
  const state = {
    activeTabId: DASHBOARD_TAB,
    windowId: WINDOW_ID,
    entries: [],
    pendingRequests: 0,
    sequence: 0,
    networkStarted: false,
    clock: 1000,
    imSnapshot: null,
    urlOverride: "",
    focusEnabled: false,
    renderLifecycleActive: false
  };
  const calls = [];
  const browser = {
    state,
    calls,
    async listTabs() {
      calls.push({ kind: "listTabs" });
      return [
        { id: DASHBOARD_TAB, windowId: state.windowId, active: state.activeTabId === DASHBOARD_TAB, url: "http://127.0.0.1:3000/communication" },
        { id: SEARCH_TAB, windowId: state.windowId, active: state.activeTabId === SEARCH_TAB, url: state.urlOverride || page.url() }
      ];
    },
    async evalValue(tabId, expression) {
      calls.push({ kind: "evalValue", tabId });
      assert.equal(tabId, SEARCH_TAB);
      if (state.imSnapshot && String(expression).includes("SidePanelThreeColumns")) return state.imSnapshot;
      return page.evaluate(expression);
    },
    async navigate(tabId, url) {
      calls.push({ kind: "navigate", tabId, url });
      assert.equal(tabId, SEARCH_TAB);
      await page.evaluate((next) => {
        history.replaceState({}, "", next);
        document.querySelector('.query-sug__input').value = new URL(next).searchParams.get('kw') || '';
        window.fixture.select(0);
      }, url);
      if (hideNextPageJobBTitleUntilRendered && !state.focusEnabled) {
        await page.evaluate(() => {
          document.querySelectorAll('.job-card')[1].querySelector('.vue-clamp__text').textContent = '';
        });
      }
      state.urlOverride = "";
    },
    async cdp(tabId, method, params) {
      calls.push({ kind: "focus", tabId, method, enabled: params?.enabled });
      if (params?.enabled === false && focusDisableError) {
        const failure = typeof focusDisableError === "function" ? focusDisableError() : focusDisableError;
        if (failure) throw failure;
      }
      if (method === "Emulation.setFocusEmulationEnabled") {
        state.focusEnabled = params?.enabled === true;
        if (state.focusEnabled && hideNextPageJobBTitleUntilRendered && state.renderLifecycleActive) {
          await page.evaluate(() => window.fixture.render());
          await onRenderingEnabled?.({ page, state });
        }
        if (!state.focusEnabled && hideNextPageJobBTitleUntilRendered) {
          await page.evaluate(() => {
            document.querySelectorAll('.job-card')[1].querySelector('.vue-clamp__text').textContent = '';
          });
        }
      }
      return {};
    },
    async clickAt(tabId, point) {
      calls.push({ kind: "prechat", tabId, point });
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('job-detail-summary__prechat'), point), true,
        "guarded coordinates must still point at 先聊聊");
      await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).click(), point);
      if (onClick) await onClick({ page, state });
      else {
        const sourceId = await page.evaluate(() => {
          const card = document.querySelector('.job-card--active');
          return card.__vue__?.$props?.job?.number || card.__vueParentComponent?.proxy?.$props?.job?.number;
        });
        const job = sourceId === JOB_B.sourceId ? JOB_B : JOB_A;
        state.sequence += 1;
        state.entries.push((transport === "edge" ? rawEntry : safeEntry)(job, state.clock, { sequence: state.sequence }));
        await page.evaluate(() => window.fixture.modal());
      }
      if (clickError) throw clickError;
      return {};
    },
    async startNetworkLog(tabId, options) {
      calls.push({ kind: "startNetworkLog", tabId, options });
      if (startError) throw startError;
      state.networkStarted = true;
      state.entries = [];
      if (startResult) return startResult;
      return transport === "edge"
        ? { tabId, meta: { enabled: true, pendingRequests: 0 } }
        : { started: true };
    },
    async getNetworkLogMark(tabId) {
      calls.push({ kind: "getNetworkLogMark", tabId });
      return transport === "edge"
        ? { tabId, mark: { lastSequence: state.sequence, nextSequence: state.sequence + 1, updatedAt: "1970-01-01T00:00:00.000Z" }, meta: { enabled: true } }
        : { mark: { lastSequence: state.sequence } };
    },
    async readNetworkLog(tabId, options) {
      calls.push({ kind: "readNetworkLog", tabId, options });
      return {
        entries: state.entries.filter((entry) => !Number.isInteger(entry.sequence) || entry.sequence > Number(options.sinceSequence || 0)),
        meta: { pendingRequests: state.pendingRequests }
      };
    },
    async stopNetworkLog(tabId) {
      calls.push({ kind: "stopNetworkLog", tabId });
      if (stopNetworkError) {
        const failure = typeof stopNetworkError === "function" ? stopNetworkError() : stopNetworkError;
        if (failure) throw failure;
      }
      state.networkStarted = false;
      return { stopped: true };
    },
    async bringToFront() { throw new Error("must not activate a tab"); },
    async createTab() { throw new Error("must not create a tab"); }
  };
  if (hideNextPageJobBTitleUntilRendered) {
    browser.setPageLifecycleActive = async (tabId) => {
      calls.push({ kind: "lifecycle", tabId });
      assert.equal(tabId, SEARCH_TAB);
      state.renderLifecycleActive = true;
    };
  }
  return browser;
}

function adapterFor(browser, extra = {}) {
  return new ZhaopinCommunicationAdapter({
    browser,
    nowFn: () => browser.state.clock,
    timeoutMs: 25,
    pollIntervalMs: 1,
    sleepFn: async () => { browser.state.clock += 5; },
    randomFn: () => 0,
    pacingState: null,
    onPacingCheckpoint: async (state) => browser.calls.push({ kind: "pacingCheckpoint", state }),
    accessController: { reserve: async (kind) => browser.calls.push({ kind: "reserve", accessKind: kind }) },
    ...extra
  });
}

function binding(captured) {
  return {
    mode: "portable",
    windowId: WINDOW_ID,
    searchTabId: SEARCH_TAB,
    searchReturnUrl: captured.url,
    searchScrollTop: captured.scrollTop,
    bindingGeneration: 1
  };
}

async function prepareSession(adapter, browser) {
  const inspected = await inspectZhaopinCommunicationTabs({ browser, adapter });
  assert.equal(inspected.windowId, WINDOW_ID);
  assert.equal(inspected.searchTab.id, SEARCH_TAB);
  const captured = await adapter.captureCommunicationSearchState(SEARCH_TAB);
  adapter.bindCommunicationTabs(binding(captured));
  await adapter.beginCommunicationSession();
  return captured;
}

async function main() {
  const readAbortController = new AbortController();
  const readAbortReason = Object.assign(new Error("fixture lease lost during base reader binding check"), { code: "SCAN_LEASE_LOST" });
  const readAfterAbort = [];
  const readAbortBrowser = {
    async listTabs() {
      return [
        { id: DASHBOARD_TAB, windowId: WINDOW_ID, active: true, url: "http://127.0.0.1:3000/communication" },
        { id: SEARCH_TAB, windowId: WINDOW_ID, active: false, url: SEARCH_URL }
      ];
    },
    async evalValue() {
      readAfterAbort.push(readAbortController.signal.aborted);
      throw new Error("page evaluation ran after lease loss");
    }
  };
  const readAbortAdapter = new ZhaopinCommunicationAdapter({ browser: readAbortBrowser, sleepFn: async () => {}, randomFn: () => 0 });
  readAbortAdapter.bindCommunicationTabs(binding({ url: SEARCH_URL, scrollTop: 0 }));
  await readAbortAdapter.beginCommunicationSession();
  readAbortAdapter.assertBoundTab = async () => { readAbortController.abort(readAbortReason); };
  await assert.rejects(() => readAbortAdapter.restoreCommunicationSearchPage(readAbortController.signal), (error) => error.code === "ZHAOPIN_ABORTED");
  assert.deepStrictEqual(readAfterAbort, [], "base search reader must not evaluate the page after its binding check loses the lease");

  const readyAbortController = new AbortController();
  const readyAbortReason = Object.assign(new Error("fixture lease lost during ready binding check"), { code: "SCAN_LEASE_LOST" });
  const readyAfterAbort = [];
  const readyAbortAdapter = new ZhaopinCommunicationAdapter({
    browser: {
      async evalValue() {
        readyAfterAbort.push(readyAbortController.signal.aborted);
        throw new Error("ready reader evaluated after lease loss");
      }
    },
    sleepFn: async () => {},
    randomFn: () => 0
  });
  readyAbortAdapter.assertBoundTab = async () => {};
  await assert.rejects(() => readyAbortAdapter.waitForSearchReady(SEARCH_TAB, {
    searchTemplate: { mode: "inherited", url: SEARCH_URL },
    keyword: "AI Agent",
    signal: readyAbortController.signal,
    assertTabBindings: async () => { readyAbortController.abort(readyAbortReason); }
  }), (error) => error.code === "ZHAOPIN_ABORTED");
  assert.deepStrictEqual(readyAfterAbort, [], "search-ready polling must not read the page after its binding check loses the lease");

  const browserProcess = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browserProcess.newPage();
    const html = fs.readFileSync(path.join(__dirname, "fixtures", "zhaopin", "communication.html"), "utf8");
    await page.route("https://www.zhaopin.com/jobs/**", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
    await page.goto(SEARCH_URL);

    assert(createSiteAdapter("zhaopin", { operation: "communication", browser: fakeBrowser(page) }) instanceof ZhaopinCommunicationAdapter);
    assert.equal(createSiteAdapter("zhaopin", { browser: fakeBrowser(page) }).constructor.name, "ZhaopinSiteAdapter", "search factory behavior stays unchanged");

    await page.evaluate(() => {
      const header = document.createElement("nav");
      header.className = "home-header__right fixture-authenticated-header";
      header.innerHTML = '<a class="home-header__b-login">合成入口</a><div class="home-header__c-login"><div class="c-login__top"><span class="c-login__top__name">合成账户</span><span class="c-login__top__photo"><img class="c-login__top__img" alt="合成头像"></span></div></div>';
      document.body.prepend(header);
    });
    const authenticatedHeaderBrowser = fakeBrowser(page);
    const authenticatedHeaderAdapter = adapterFor(authenticatedHeaderBrowser);
    await prepareSession(authenticatedHeaderAdapter, authenticatedHeaderBrowser);
    assert.equal((await authenticatedHeaderAdapter.inspectCommunicationJob(JOB_A)).state, "ready",
      "the observed authenticated home header is not a login challenge");
    assert.equal(authenticatedHeaderBrowser.calls.filter((call) => call.kind === "prechat").length, 0);
    assert.equal(await page.evaluate(() => window.fixture.applyClicks), 0);

    const nestedLoginBrowser = fakeBrowser(page);
    const nestedLoginAdapter = adapterFor(nestedLoginBrowser);
    await prepareSession(nestedLoginAdapter, nestedLoginBrowser);
    await page.evaluate(() => {
      const panel = document.createElement("section");
      panel.className = "login-panel fixture-nested-login";
      panel.textContent = "请登录";
      panel.style.cssText = "position:fixed;left:20px;top:20px;width:320px;height:200px;background:white";
      document.querySelector(".home-header__c-login").append(panel);
    });
    await assert.rejects(() => nestedLoginAdapter.inspectCommunicationJob(JOB_A), (error) => error.code === "ZHAOPIN_LOGIN_REQUIRED");
    assert.equal(nestedLoginBrowser.calls.filter((call) => call.kind === "prechat").length, 0);
    assert.equal(await page.evaluate(() => window.fixture.applyClicks), 0);

    const misplacedAccountBrowser = fakeBrowser(page);
    const misplacedAccountAdapter = adapterFor(misplacedAccountBrowser);
    await page.evaluate(() => document.querySelector(".fixture-nested-login").remove());
    await prepareSession(misplacedAccountAdapter, misplacedAccountBrowser);
    await page.evaluate(() => {
      document.querySelector(".fixture-authenticated-header").remove();
      const misplaced = document.createElement("div");
      misplaced.className = "home-header__c-login fixture-misplaced-account";
      misplaced.innerHTML = '<div class="c-login__top"><span class="c-login__top__name">错误父级下的合成账户</span></div>';
      document.body.prepend(misplaced);
    });
    await assert.rejects(() => misplacedAccountAdapter.inspectCommunicationJob(JOB_A), (error) => error.code === "ZHAOPIN_LOGIN_REQUIRED");
    assert.equal(misplacedAccountBrowser.calls.filter((call) => call.kind === "prechat").length, 0);
    assert.equal(await page.evaluate(() => window.fixture.applyClicks), 0);
    await page.evaluate(() => document.querySelector(".fixture-misplaced-account").remove());

    const directBrowser = fakeBrowser(page);
    const directAdapter = adapterFor(directBrowser);
    const activeBefore = directBrowser.state.activeTabId;
    const captured = await prepareSession(directAdapter, directBrowser);
    const inspection = await directAdapter.inspectCommunicationJob(JOB_A);
    assert.equal(inspection.state, "ready");
    assert.equal(directBrowser.calls.filter((call) => call.kind === "prechat").length, 0);
    const preparation = await directAdapter.prepareCommunicationDispatch(inspection);
    assert.equal(preparation.state, "prepared");
    assert.equal(directBrowser.calls.filter((call) => call.kind === "prechat").length, 0);
    await directAdapter.dispatchCommunication(inspection);
    assert.equal(directBrowser.calls.filter((call) => call.kind === "prechat").length, 1);
    assert.equal((await directAdapter.verifyCommunicationResult(JOB_A)).state, "succeeded");
    assert.equal(directBrowser.state.activeTabId, activeBefore);
    assert.equal(await page.evaluate(() => window.fixture.applyClicks), 0, "立即投递 must never be clicked");
    assert.equal(directBrowser.state.networkStarted, false);
    assert.equal(directBrowser.calls.filter((call) => call.kind === "focus" && call.enabled === false).length, 1);
    await page.evaluate(() => { window.fixture.reset(); window.fixture.select(0); });
    const serialInspection = await directAdapter.inspectCommunicationJob(JOB_B);
    assert.equal(serialInspection.state, "ready");
    await directAdapter.dispatchCommunication(serialInspection);
    assert.equal((await directAdapter.verifyCommunicationResult(JOB_B)).state, "succeeded", "two frozen targets execute serially on the same bound search tab");
    assert.equal(directBrowser.calls.filter((call) => call.kind === "prechat").length, 2);
    await preparation.cancel();
    const navigationBeforeRestore = directBrowser.calls.filter((call) => call.kind === "navigate").length;
    await directAdapter.restoreCommunicationSearchPage();
    await directAdapter.restoreCommunicationSearchPage();
    assert.equal(directBrowser.calls.filter((call) => call.kind === "navigate").length, navigationBeforeRestore + 1, "restore runs once");

    await page.goto(SEARCH_URL);
    await page.evaluate(() => { window.fixture.reset(); window.fixture.select(0); });
    const backgroundBrowser = fakeBrowser(page, { hideNextPageJobBTitleUntilRendered: true });
    const backgroundAdapter = adapterFor(backgroundBrowser);
    const backgroundActiveBefore = backgroundBrowser.state.activeTabId;
    await prepareSession(backgroundAdapter, backgroundBrowser);
    const backgroundInspection = await backgroundAdapter.inspectCommunicationJob(JOB_B);
    assert.equal(backgroundInspection.state, "ready", "background rendering remains held through exact JobCard lookup");
    assert.equal(backgroundInspection.sourceId, JOB_B.sourceId);
    assert.equal(backgroundBrowser.calls.filter((call) => call.kind === "prechat").length, 0);
    assert.equal(await page.evaluate(() => window.fixture.applyClicks), 0, "background lookup never clicks 立即投递");
    assert.equal(backgroundBrowser.state.activeTabId, backgroundActiveBefore);
    assert.equal(backgroundBrowser.state.focusEnabled, false, "background rendering is released after inspection");

    await page.goto(SEARCH_URL);
    await page.evaluate(() => { window.fixture.reset(); window.fixture.select(0); });
    const backgroundMissingBrowser = fakeBrowser(page, { hideNextPageJobBTitleUntilRendered: true });
    const backgroundMissingAdapter = adapterFor(backgroundMissingBrowser);
    await prepareSession(backgroundMissingAdapter, backgroundMissingBrowser);
    const backgroundMissing = { ...JOB_B, sourceId: "CCMISSING002J00000000002", url: "https://www.zhaopin.com/jobdetail/CCMISSING002J00000000002.htm" };
    await assert.rejects(() => backgroundMissingAdapter.inspectCommunicationJob(backgroundMissing),
      (error) => error.code === "ZHAOPIN_COMMUNICATION_TARGET_NOT_FOUND");
    assert.equal(backgroundMissingBrowser.state.focusEnabled, false, "not-found lookup releases background rendering");
    assert.equal(backgroundMissingBrowser.calls.filter((call) => call.kind === "prechat").length, 0);

    await page.goto(SEARCH_URL);
    await page.evaluate(() => { window.fixture.reset(); window.fixture.select(0); });
    const backgroundAbortController = new AbortController();
    const backgroundAbortBrowser = fakeBrowser(page, {
      hideNextPageJobBTitleUntilRendered: true,
      onRenderingEnabled: async () => backgroundAbortController.abort()
    });
    const backgroundAbortAdapter = adapterFor(backgroundAbortBrowser);
    await prepareSession(backgroundAbortAdapter, backgroundAbortBrowser);
    await assert.rejects(() => backgroundAbortAdapter.inspectCommunicationJob(JOB_B, backgroundAbortController.signal),
      (error) => error.name === "AbortError" || error.code === "ZHAOPIN_COMMUNICATION_ABORTED");
    assert.equal(backgroundAbortBrowser.state.focusEnabled, false, "cancelled lookup releases background rendering");
    assert.equal(backgroundAbortBrowser.calls.filter((call) => call.kind === "prechat").length, 0);

    await page.goto(SEARCH_URL);
    await page.evaluate(() => { window.fixture.reset(); window.fixture.select(0); });
    const backgroundCleanupError = Object.assign(new Error("background rendering cleanup failed"), { code: "BROWSER_COMMAND_FAILED" });
    let backgroundCleanupFailures = 0;
    const backgroundCleanupBrowser = fakeBrowser(page, {
      hideNextPageJobBTitleUntilRendered: true,
      focusDisableError: () => backgroundCleanupFailures++ === 0 ? backgroundCleanupError : null
    });
    const backgroundCleanupAdapter = adapterFor(backgroundCleanupBrowser);
    await prepareSession(backgroundCleanupAdapter, backgroundCleanupBrowser);
    await assert.rejects(() => backgroundCleanupAdapter.inspectCommunicationJob(JOB_B), (error) => error === backgroundCleanupError);
    assert.equal(backgroundCleanupBrowser.calls.filter((call) => call.kind === "prechat").length, 0, "cleanup failure cannot authorize dispatch");
    await page.evaluate(() => { window.fixture.reset(); window.fixture.select(0); });
    assert.equal((await backgroundCleanupAdapter.inspectCommunicationJob(JOB_B)).state, "ready", "cleanup failure clears inspection busy state");
    assert.equal(backgroundCleanupBrowser.state.focusEnabled, false);

    await page.goto(SEARCH_URL);
    await page.evaluate(() => { window.fixture.reset(); window.fixture.select(0); });
    const priorCleanupCause = new Error("prior cleanup cause");
    const combinedCleanupError = Object.assign(new Error("background rendering cleanup failed with prior cause"), {
      code: "BROWSER_COMMAND_FAILED",
      cause: priorCleanupCause
    });
    const combinedFailureBrowser = fakeBrowser(page, {
      hideNextPageJobBTitleUntilRendered: true,
      focusDisableError: combinedCleanupError
    });
    const combinedFailureAdapter = adapterFor(combinedFailureBrowser);
    await prepareSession(combinedFailureAdapter, combinedFailureBrowser);
    await assert.rejects(() => combinedFailureAdapter.inspectCommunicationJob(backgroundMissing), (error) => {
      assert(error instanceof AggregateError, "cleanup failure and original lookup failure must both be retained");
      assert.equal(error.code, "BROWSER_COMMAND_FAILED");
      assert.equal(error.cause?.code, "ZHAOPIN_COMMUNICATION_TARGET_NOT_FOUND");
      assert.equal(error.errors?.[0], combinedCleanupError);
      assert.equal(error.errors?.[0]?.cause, priorCleanupCause);
      assert.equal(error.errors?.[1]?.code, "ZHAOPIN_COMMUNICATION_TARGET_NOT_FOUND");
      return true;
    });
    assert.equal(combinedFailureBrowser.calls.filter((call) => call.kind === "prechat").length, 0, "combined cleanup failure cannot authorize dispatch");

    await page.goto(SEARCH_URL);
    await page.evaluate(() => window.fixture.useVue2());
    const vue2Browser = fakeBrowser(page);
    const vue2Adapter = adapterFor(vue2Browser);
    await prepareSession(vue2Adapter, vue2Browser);
    const vue2Inspection = await vue2Adapter.inspectCommunicationJob(JOB_A);
    assert.equal(vue2Inspection.state, "ready", "Vue 2 component identity is accepted by readiness");
    await vue2Adapter.dispatchCommunication(vue2Inspection);
    assert.equal(vue2Browser.calls.filter((call) => call.kind === "prechat").length, 1,
      "the final guarded expression rechecks all four Vue 2 IDs before one synthetic click");
    assert.equal((await vue2Adapter.verifyCommunicationResult(JOB_A)).state, "succeeded");

    await page.goto(SEARCH_URL);
    const abortedCleanupBrowser = fakeBrowser(page);
    const abortedCleanupAdapter = adapterFor(abortedCleanupBrowser);
    await prepareSession(abortedCleanupAdapter, abortedCleanupBrowser);
    const abortedCleanupInspection = await abortedCleanupAdapter.inspectCommunicationJob(JOB_A);
    await abortedCleanupAdapter.prepareCommunicationDispatch(abortedCleanupInspection);
    const abortedCleanupController = new AbortController();
    abortedCleanupController.abort(Object.assign(new Error("fixture lease lost"), { code: "SCAN_LEASE_LOST" }));
    const pageCallsBeforeAbortedCleanup = abortedCleanupBrowser.calls.filter((call) => ["listTabs", "evalValue", "navigate"].includes(call.kind)).length;
    await abortedCleanupAdapter.restoreCommunicationSearchPage(abortedCleanupController.signal);
    assert.equal(abortedCleanupBrowser.state.networkStarted, false, "lost-lease restoration still releases the network observer");
    assert.equal(abortedCleanupBrowser.calls.filter((call) => call.kind === "stopNetworkLog").length, 1,
      "lost-lease restoration performs resource cleanup once");
    assert.equal(abortedCleanupBrowser.calls.filter((call) => ["listTabs", "evalValue", "navigate"].includes(call.kind)).length, pageCallsBeforeAbortedCleanup,
      "lost-lease cleanup must not inspect, navigate, or scroll the page");

    await page.goto(SEARCH_URL);
    const waitAbortController = new AbortController();
    let restoring = false;
    const waitAbortBrowser = fakeBrowser(page);
    const waitAbortAdapter = adapterFor(waitAbortBrowser, {
      sleepFn: async () => {
        waitAbortBrowser.state.clock += 5;
        if (restoring) waitAbortController.abort(Object.assign(new Error("fixture lease lost during restore wait"), { code: "SCAN_LEASE_LOST" }));
      }
    });
    await prepareSession(waitAbortAdapter, waitAbortBrowser);
    restoring = true;
    await assert.rejects(() => waitAbortAdapter.restoreCommunicationSearchPage(waitAbortController.signal),
      (error) => error === waitAbortController.signal.reason);
    assert.equal(waitAbortBrowser.calls.filter((call) => call.kind === "navigate").length, 0,
      "lease loss during restore pacing must stop before navigation");

    await page.goto(SEARCH_URL);
    const edgeBrowser = fakeBrowser(page, { transport: "edge", onClick: async ({ page, state }) => {
      state.sequence += 1;
      state.entries.push(rawEntry(JOB_B, state.clock, { sequence: state.sequence }));
      await page.evaluate(() => window.fixture.modal());
    } });
    const edgeAdapter = adapterFor(edgeBrowser);
    await prepareSession(edgeAdapter, edgeBrowser);
    const secondInspection = await edgeAdapter.inspectCommunicationJob(JOB_B);
    assert.equal(secondInspection.state, "ready", "frozen keyword lookup finds the exact source ID after normal card navigation");
    await edgeAdapter.dispatchCommunication(secondInspection);
    const edgeResult = await edgeAdapter.verifyCommunicationResult(JOB_B);
    assert.equal(edgeResult.state, "succeeded");
    assert.equal(JSON.stringify(edgeResult).includes("must-not-leak"), false, "raw URL/request IDs never leave normalization");

    const missing = { ...JOB_A, sourceId: "CCMISSING001J00000000001", url: "https://www.zhaopin.com/jobdetail/CCMISSING001J00000000001.htm" };
    await assert.rejects(() => edgeAdapter.inspectCommunicationJob(missing), (error) => error.code === "ZHAOPIN_COMMUNICATION_TARGET_NOT_FOUND",
      "an equal-title different ID cannot dispatch");

    for (const [driftName, mutation] of [
      ["title", () => page.evaluate(() => { document.querySelector('.job-detail-summary__title-text').textContent = '漂移岗位'; })],
      ["company", () => page.evaluate(() => { document.querySelector('.job-detail-summary__company-name').textContent = '漂移公司'; })],
      ["link", () => page.evaluate(() => { document.querySelector('.job-company-info__view-all').href = 'https://www.zhaopin.com/jobdetail/CCWRONG001J00000000001.htm'; })],
      ["action", () => page.evaluate(() => { document.querySelector('.job-detail-summary__prechat').textContent = '立即沟通'; })],
      ["existing_modal", () => page.evaluate(() => window.fixture.modal())]
    ]) {
      await page.goto(SEARCH_URL); await mutation();
      const driftBrowser = fakeBrowser(page); const driftAdapter = adapterFor(driftBrowser); await prepareSession(driftAdapter, driftBrowser);
      assert.equal(driftName === "title" ? await page.locator('.job-detail-summary__title-text').textContent() : driftName === "action" ? await page.locator('.job-detail-summary__prechat').textContent() : new URL(await page.locator('.job-company-info__view-all').getAttribute('href')).pathname,
        driftName === "title" ? "漂移岗位" : driftName === "action" ? "立即沟通" : driftName === "link" ? "/jobdetail/CCWRONG001J00000000001.htm" : "/jobdetail/CCSYNTH001J00000000001.htm");
      if (driftName === "title") {
        const driftState = await driftAdapter.readSearchState(SEARCH_TAB);
        assert.equal(driftState.detail.title, "漂移岗位");
      }
      const driftInspection = await driftAdapter.inspectCommunicationJob(JOB_A);
      assert.notEqual(driftInspection.state, "ready", `${driftName} drift must stop readiness: ${JSON.stringify(driftInspection)}`);
      assert.equal(driftBrowser.calls.filter((call) => call.kind === "prechat").length, 0);
    }

    await page.goto(SEARCH_URL);
    const preClickError = Object.assign(new Error("observer failed"), { code: "BROWSER_COMMAND_FAILED" });
    const observerBrowser = fakeBrowser(page, { startError: preClickError }); const observerAdapter = adapterFor(observerBrowser); await prepareSession(observerAdapter, observerBrowser);
    const observerInspection = await observerAdapter.inspectCommunicationJob(JOB_A);
    await assert.rejects(() => observerAdapter.prepareCommunicationDispatch(observerInspection), (error) => error === preClickError);
    assert.equal(observerBrowser.calls.filter((call) => call.kind === "prechat").length, 0);

    await page.goto(SEARCH_URL);
    const malformedStartBrowser = fakeBrowser(page, { startResult: {} }); const malformedStartAdapter = adapterFor(malformedStartBrowser); await prepareSession(malformedStartAdapter, malformedStartBrowser);
    const malformedStartInspection = await malformedStartAdapter.inspectCommunicationJob(JOB_A);
    await assert.rejects(() => malformedStartAdapter.prepareCommunicationDispatch(malformedStartInspection), (error) => error.code === "ZHAOPIN_COMMUNICATION_NETWORK_UNAVAILABLE");
    assert.equal(malformedStartBrowser.calls.filter((call) => call.kind === "stopNetworkLog").length, 1, "a malformed start shape still releases the observer");
    assert.equal(malformedStartBrowser.calls.filter((call) => call.kind === "prechat").length, 0);

    await page.goto(SEARCH_URL);
    const cancelPreparationBrowser = fakeBrowser(page); const cancelPreparationAdapter = adapterFor(cancelPreparationBrowser); await prepareSession(cancelPreparationAdapter, cancelPreparationBrowser);
    const cancelPreparationInspection = await cancelPreparationAdapter.inspectCommunicationJob(JOB_A);
    const cancellable = await cancelPreparationAdapter.prepareCommunicationDispatch(cancelPreparationInspection);
    await cancellable.cancel(); await cancellable.cancel();
    assert.equal(cancelPreparationBrowser.calls.filter((call) => call.kind === "stopNetworkLog").length, 1, "pre-click cancellation is idempotent");
    assert.equal(cancelPreparationBrowser.calls.filter((call) => call.kind === "prechat").length, 0);

    await page.goto(SEARCH_URL);
    const transientStopError = Object.assign(new Error("transient observer cleanup failure"), { code: "BROWSER_COMMAND_FAILED" });
    let stopFailures = 0;
    const retryCancelBrowser = fakeBrowser(page, { stopNetworkError: () => stopFailures++ === 0 ? transientStopError : null });
    const retryCancelAdapter = adapterFor(retryCancelBrowser); await prepareSession(retryCancelAdapter, retryCancelBrowser);
    const retryCancelInspection = await retryCancelAdapter.inspectCommunicationJob(JOB_A);
    const retryableCancel = await retryCancelAdapter.prepareCommunicationDispatch(retryCancelInspection);
    await assert.rejects(() => retryableCancel.cancel(), (error) => error === transientStopError);
    await retryableCancel.cancel(); await retryableCancel.cancel();
    assert.equal(retryCancelBrowser.calls.filter((call) => call.kind === "stopNetworkLog").length, 2,
      "preparation cancellation retries a retained observer once, then stays idempotent");

    for (const markFailure of ["invalid", "throws"]) {
      await page.goto(SEARCH_URL);
      let failedStops = 0;
      const markBrowser = fakeBrowser(page, { stopNetworkError: () => failedStops++ === 0 ? transientStopError : null });
      const markAdapter = adapterFor(markBrowser);
      await prepareSession(markAdapter, markBrowser);
      const markInspection = await markAdapter.inspectCommunicationJob(JOB_A);
      markBrowser.getNetworkLogMark = async () => {
        if (markFailure === "throws") throw new Error("mark failed");
        return { mark: { lastSequence: -1 } };
      };
      await assert.rejects(() => markAdapter.prepareCommunicationDispatch(markInspection));
      assert.equal(markBrowser.state.networkStarted, true);
      await markAdapter.restoreCommunicationSearchPage();
      await markAdapter.restoreCommunicationSearchPage();
      assert.equal(markBrowser.state.networkStarted, false, `${markFailure}: restore must retry the observer retained after failed preparation cleanup`);
      assert.equal(markBrowser.calls.filter(call => call.kind === "stopNetworkLog").length, 2);
      assert.equal(markBrowser.calls.filter(call => call.kind === "prechat").length, 0);
      assert.equal(markAdapter.prepared, null);
      await assert.rejects(() => markAdapter.dispatchCommunication(markInspection));
      assert.equal(markBrowser.calls.filter(call => call.kind === "prechat").length, 0, "failed mark ownership cannot authorize dispatch");
    }

    await page.goto(SEARCH_URL);
    const finalGuardBrowser = fakeBrowser(page);
    const finalGuardAdapter = adapterFor(finalGuardBrowser);
    await prepareSession(finalGuardAdapter, finalGuardBrowser);
    const finalGuardInspection = await finalGuardAdapter.inspectCommunicationJob(JOB_A);
    await finalGuardAdapter.prepareCommunicationDispatch(finalGuardInspection);
    const finalGuardAbort = new AbortController();
    const originalEval = finalGuardBrowser.evalValue.bind(finalGuardBrowser);
    let releaseGuard;
    let guardEntered;
    const enteredGuard = new Promise(resolve => { guardEntered = resolve; });
    finalGuardBrowser.evalValue = async (...args) => {
      const result = await originalEval(...args);
      if (result?.ready === true && result.clickPoint) {
        guardEntered();
        await new Promise(resolve => { releaseGuard = resolve; });
      }
      return result;
    };
    const cancelledDispatch = finalGuardAdapter.dispatchCommunication(finalGuardInspection, finalGuardAbort.signal);
    await enteredGuard;
    finalGuardAbort.abort();
    releaseGuard();
    await assert.rejects(() => cancelledDispatch, error => error.code === "ZHAOPIN_COMMUNICATION_ABORTED");
    assert.equal(finalGuardBrowser.calls.filter(call => call.kind === "prechat").length, 0);
    assert.equal(finalGuardAdapter.dispatchedSourceIds.size, 0, "cancelled final guard must not record a dispatch");
    assert.equal(finalGuardBrowser.state.networkStarted, false);
    assert.equal(finalGuardBrowser.state.focusEnabled, false);

    for (const transport of ["direct", "edge"]) for (const pendingKind of ["application", "prechat"]) {
      await page.goto(SEARCH_URL);
      let observer;
      let releasePending;
      let pendingRead;
      const pendingObserved = new Promise(resolve => { pendingRead = resolve; });
      const pendingBrowser = fakeBrowser(page, { transport, onClick: async ({ state }) => {
        if (transport === "direct") {
          observer.onRequest({ requestId: "prechat", type: "Fetch", request: { url: rawEntry().url, method: "GET" } });
          if (pendingKind === "application") {
            observer.onResponse({ requestId: "prechat", response: { status: 200 } });
            observer.onFinished({ requestId: "prechat" });
            observer.onRequest({ requestId: "application", type: "Fetch", request: { url: "https://fe-api.zhaopin.com/c/pc/alan/jobs/application", method: "POST" } });
          }
        } else {
          if (pendingKind === "application") state.entries.push(rawEntry(JOB_A, state.clock, { sequence: ++state.sequence }));
          state.pendingRequests = 1;
        }
        await page.evaluate(() => window.fixture.modal());
      } });
      if (transport === "direct") {
        pendingBrowser.startNetworkLog = async (tabId, options) => {
          observer = new CdpNetworkLog({ options });
          observer.opened = observer.enabled = true;
          observer.command = async () => ({ body: JSON.stringify({ data: { sessionId: "a".repeat(32) } }) });
          pendingBrowser.state.networkStarted = true;
          return { started: true };
        };
        pendingBrowser.getNetworkLogMark = async () => observer.getMark();
        pendingBrowser.readNetworkLog = async (tabId, options) => observer.read(options);
        pendingBrowser.stopNetworkLog = async () => {
          await observer.stop();
          pendingBrowser.state.networkStarted = false;
          return { stopped: true };
        };
      }
      const pendingAdapter = adapterFor(pendingBrowser, { sleepFn: async () => {
        pendingBrowser.state.clock += 5;
        if (pendingBrowser.calls.some(call => call.kind === "prechat")) {
          pendingRead();
          await new Promise(resolve => { releasePending = resolve; });
        }
      } });
      await prepareSession(pendingAdapter, pendingBrowser);
      const pendingInspection = await pendingAdapter.inspectCommunicationJob(JOB_A);
      await pendingAdapter.dispatchCommunication(pendingInspection);
      let settled = false;
      const pendingVerification = pendingAdapter.verifyCommunicationResult(JOB_A).then(result => { settled = true; return result; });
      await Promise.race([pendingObserved, pendingVerification]);
      assert.equal(settled, false, `${transport}: must not succeed while ${pendingKind} is in flight`);
      assert.equal(pendingBrowser.state.networkStarted, true);
      if (transport === "direct") {
        observer.onResponse({ requestId: pendingKind, response: { status: 200 } });
        observer.onFinished({ requestId: pendingKind });
      }
      else {
        pendingBrowser.state.pendingRequests = 0;
        pendingBrowser.state.entries.push(rawEntry(JOB_A, pendingBrowser.state.clock, { sequence: ++pendingBrowser.state.sequence,
          ...(pendingKind === "application" ? { url: "https://fe-api.zhaopin.com/c/pc/alan/jobs/application", method: "POST" } : {}) }));
      }
      releasePending();
      const pendingResult = await pendingVerification;
      if (pendingKind === "application") assert.equal(pendingResult.errorCode, "ZHAOPIN_APPLICATION_ENDPOINT_OBSERVED");
      else assert.equal(pendingResult.state, "succeeded");
      assert.equal(pendingBrowser.state.networkStarted, false);
    }

    const outcomes = [
      ["accepted_without_pending_metadata", async ({ page, state }) => {
        state.pendingRequests = undefined;
        state.entries.push(safeEntry(JOB_A, state.clock, { sequence: ++state.sequence }));
        await page.evaluate(() => window.fixture.modal());
      }],
      ["accepted_with_unsettled_request", async ({ page, state }) => {
        state.pendingRequests = 1;
        state.entries.push(safeEntry(JOB_A, state.clock, { sequence: ++state.sequence }));
        await page.evaluate(() => window.fixture.modal());
      }],
      ["stale", ({ state }) => state.entries.push(safeEntry(JOB_A, state.clock - 100, { sequence: ++state.sequence }))],
      ["premark_inflight_completion", ({ state }) => state.entries.push(safeEntry(JOB_A, state.clock - 100, {
        sequence: ++state.sequence,
        completedAt: new Date(state.clock + 5).toISOString()
      }))],
      ["mismatch", ({ state }) => state.entries.push(safeEntry(JOB_B, state.clock, { sequence: ++state.sequence }))],
      ["pending", ({ state }) => { state.pendingRequests = 1; }],
      ["correct_without_response", ({ state }) => { state.pendingRequests = 1; state.entries.push(safeEntry(JOB_A, state.clock, { sequence: ++state.sequence, completedAt: "" })); }],
      ["application", ({ state }) => state.entries.push({ ...rawEntry(JOB_A, state.clock, { sequence: ++state.sequence }), url: "https://fe-api.zhaopin.com/c/pc/alan/jobs/application", method: "POST" })],
      ["banner_without_network", async ({ page }) => page.evaluate(() => window.fixture.modal())],
      ["changed_frontend", ({ state }) => state.entries.push(safeEntry(JOB_A, state.clock, { sequence: ++state.sequence }))],
      ["mixed_malformed", async ({ page, state }) => {
        state.entries.push(safeEntry(JOB_A, state.clock, { sequence: ++state.sequence }));
        state.entries.push(rawEntry(JOB_A, state.clock, {
          sequence: ++state.sequence,
          url: `https://cgate.zhaopin.com/imapi/imV2/createAndUpdateContextV2?jobNumber=${JOB_A.sourceId}&jobNumber=${JOB_B.sourceId}&positionChatBeforeDeliveryScene=2&positionChatBeforeDeliveryOperateType=2`
        }));
        await page.evaluate(() => window.fixture.modal());
      }],
      ["valid_plus_missing_started_at", async ({ page, state }) => {
        state.entries.push(safeEntry(JOB_A, state.clock, { sequence: ++state.sequence }));
        state.entries.push(safeEntry(JOB_A, state.clock, { sequence: ++state.sequence, startedAt: "" }));
        await page.evaluate(() => window.fixture.modal());
      }],
      ["valid_plus_missing_sequence", async ({ page, state }) => {
        state.entries.push(safeEntry(JOB_A, state.clock, { sequence: ++state.sequence }));
        state.entries.push(safeEntry(JOB_A, state.clock, { sequence: undefined }));
        await page.evaluate(() => window.fixture.modal());
      }]
    ];
    for (const [name, onClick] of outcomes) {
      await page.goto(SEARCH_URL);
      const outcomeBrowser = fakeBrowser(page, { onClick }); const outcomeAdapter = adapterFor(outcomeBrowser); await prepareSession(outcomeAdapter, outcomeBrowser);
      const current = await outcomeAdapter.inspectCommunicationJob(JOB_A);
      await outcomeAdapter.dispatchCommunication(current);
      const result = await outcomeAdapter.verifyCommunicationResult(JOB_A);
      assert.notEqual(result.state, "succeeded", `${name} must remain non-success`);
      assert.equal(outcomeBrowser.calls.filter((call) => call.kind === "prechat").length, 1, `${name} must never retry`);
      assert.equal(outcomeBrowser.state.networkStarted, false, `${name} cleanup stops the network log`);
    }

    await page.goto(SEARCH_URL);
    const pendingRiskBrowser = fakeBrowser(page, { onClick: async ({ page, state }) => {
      state.pendingRequests = 1;
      await page.evaluate(() => { document.title = "安全验证"; });
    } });
    const pendingRiskAdapter = adapterFor(pendingRiskBrowser); await prepareSession(pendingRiskAdapter, pendingRiskBrowser);
    const pendingRiskInspection = await pendingRiskAdapter.inspectCommunicationJob(JOB_A); await pendingRiskAdapter.dispatchCommunication(pendingRiskInspection);
    await assert.rejects(() => pendingRiskAdapter.verifyCommunicationResult(JOB_A), (error) => error.code === "ZHAOPIN_RISK_CONTROL",
      "each verification poll stops on current-page risk state before reading pending network evidence");
    assert.equal(pendingRiskBrowser.calls.filter((call) => call.kind === "readNetworkLog").length, 0);

    await page.goto(SEARCH_URL);
    const missingStatusBrowser = fakeBrowser(page, { onClick: async ({ page, state }) => {
      state.entries.push(safeEntry(JOB_A, state.clock, { sequence: ++state.sequence, status: undefined }));
      await page.evaluate(() => window.fixture.modal());
    } });
    const missingStatusAdapter = adapterFor(missingStatusBrowser); await prepareSession(missingStatusAdapter, missingStatusBrowser);
    const missingStatusInspection = await missingStatusAdapter.inspectCommunicationJob(JOB_A); await missingStatusAdapter.dispatchCommunication(missingStatusInspection);
    const missingStatus = await missingStatusAdapter.verifyCommunicationResult(JOB_A);
    assert.equal(missingStatus.state, "ambiguous", "a missing HTTP status is unknown, not a definite platform rejection");

    for (const body of [{ statusCode: 2024, data: { sessionId: "a".repeat(32) } }, { actionCode: 3000, sessionId: "a".repeat(32) }]) {
      await page.goto(SEARCH_URL);
      const rejectedBrowser = fakeBrowser(page, { onClick: async ({ page, state }) => {
        state.entries.push(safeEntry(JOB_A, state.clock, { sequence: ++state.sequence, content: JSON.stringify(body) }));
        await page.evaluate(() => window.fixture.modal());
      } });
      const rejectedAdapter = adapterFor(rejectedBrowser); await prepareSession(rejectedAdapter, rejectedBrowser);
      const rejectedInspection = await rejectedAdapter.inspectCommunicationJob(JOB_A); await rejectedAdapter.dispatchCommunication(rejectedInspection);
      const rejected = await rejectedAdapter.verifyCommunicationResult(JOB_A);
      assert.equal(rejected.state, "platform_rejected");
      assert.equal(rejected.evidence.endpoints[0].businessCategory, "business_rejected");
    }

    await page.goto(SEARCH_URL);
    let delayedReleased = false;
    const delayedBrowser = fakeBrowser(page, { onClick: ({ state }) => { state.pendingRequests = 1; } });
    const delayedAdapter = adapterFor(delayedBrowser, {
      sleepFn: async () => {
        delayedBrowser.state.clock += 5;
        if (!delayedReleased && delayedBrowser.calls.some((call) => call.kind === "prechat")) {
          delayedReleased = true;
          delayedBrowser.state.pendingRequests = 0;
          delayedBrowser.state.entries.push(safeEntry(JOB_A, delayedBrowser.state.clock, { sequence: ++delayedBrowser.state.sequence }));
          await page.evaluate(() => window.fixture.modal());
        }
      }
    });
    await prepareSession(delayedAdapter, delayedBrowser);
    const delayedInspection = await delayedAdapter.inspectCommunicationJob(JOB_A); await delayedAdapter.dispatchCommunication(delayedInspection);
    assert.equal(delayedBrowser.calls.filter((call) => call.kind === "focus" && call.enabled === false).length, 0,
      "focus emulation remains held until verification owns final cleanup");
    assert.equal((await delayedAdapter.verifyCommunicationResult(JOB_A)).state, "succeeded", "a delayed joined response is polled without a second click");
    assert.equal(delayedBrowser.calls.filter((call) => call.kind === "prechat").length, 1);
    assert.equal(delayedBrowser.calls.filter((call) => call.kind === "focus" && call.enabled === false).length, 1);

    await page.goto(SEARCH_URL);
    const transientDisableError = Object.assign(new Error("transient focus cleanup failure"), { code: "BROWSER_COMMAND_FAILED" });
    let disableFailures = 0;
    const recoveringBrowser = fakeBrowser(page, { focusDisableError: () => disableFailures++ === 0 ? transientDisableError : null });
    const recoveringAdapter = adapterFor(recoveringBrowser); await prepareSession(recoveringAdapter, recoveringBrowser);
    const recoveringInspection = await recoveringAdapter.inspectCommunicationJob(JOB_A); await recoveringAdapter.dispatchCommunication(recoveringInspection);
    await assert.rejects(() => recoveringAdapter.verifyCommunicationResult(JOB_A), (error) => error === transientDisableError);
    assert.equal(recoveringBrowser.calls.filter((call) => call.kind === "stopNetworkLog").length, 1,
      "network cleanup is attempted even when focus cleanup fails");
    assert.equal(recoveringBrowser.calls.filter((call) => call.kind === "focus" && call.enabled === false).length, 1);
    await recoveringAdapter.restoreCommunicationSearchPage();
    assert.equal(recoveringBrowser.calls.filter((call) => call.kind === "focus" && call.enabled === false).length, 2,
      "restore retries the retained focus cleanup resource");
    assert.equal(recoveringBrowser.calls.filter((call) => call.kind === "stopNetworkLog").length, 1,
      "an already released observer is not stopped twice");
    assert.equal(recoveringBrowser.state.focusEnabled, false);
    await page.evaluate(() => window.fixture.reset());
    assert.equal((await recoveringAdapter.inspectCommunicationJob(JOB_A)).state, "ready",
      "a cleanup failure cannot leave the adapter operation busy");

    await page.goto(SEARCH_URL);
    const cancelBrowser = fakeBrowser(page, { onClick: ({ state }) => { state.pendingRequests = 1; } }); const cancelAdapter = adapterFor(cancelBrowser); await prepareSession(cancelAdapter, cancelBrowser);
    const cancelInspection = await cancelAdapter.inspectCommunicationJob(JOB_A); await cancelAdapter.dispatchCommunication(cancelInspection);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => cancelAdapter.verifyCommunicationResult(JOB_A, controller.signal), (error) => error.code === "ZHAOPIN_COMMUNICATION_ABORTED");
    assert.equal(cancelBrowser.state.networkStarted, false);

    await page.goto(SEARCH_URL);
    const uncertainError = Object.assign(new Error("uncertain input dispatch"), { code: "BROWSER_DISCONNECTED" });
    const uncertainBrowser = fakeBrowser(page, { clickError: uncertainError }); const uncertainAdapter = adapterFor(uncertainBrowser); await prepareSession(uncertainAdapter, uncertainBrowser);
    const uncertainInspection = await uncertainAdapter.inspectCommunicationJob(JOB_A);
    await assert.rejects(() => uncertainAdapter.dispatchCommunication(uncertainInspection), (error) => error === uncertainError);
    await assert.rejects(() => uncertainAdapter.dispatchCommunication(uncertainInspection), (error) => error.code === "ZHAOPIN_COMMUNICATION_ALREADY_DISPATCHED");
    assert.equal(uncertainBrowser.calls.filter((call) => call.kind === "prechat").length, 1, "an uncertain dispatch is never retried");
    assert.equal(uncertainBrowser.state.networkStarted, false);

    await page.goto(SEARCH_URL);
    const imBrowser = fakeBrowser(page, { onClick: async ({ page, state }) => {
      const sourceId = await page.evaluate(() => document.querySelector('.job-card--active').__vueParentComponent.proxy.$props.job.number);
      const job = sourceId === JOB_B.sourceId ? JOB_B : JOB_A;
      state.sequence += 1;
      state.entries.push(safeEntry(job, state.clock, { sequence: state.sequence }));
      if (job === JOB_A) {
        state.urlOverride = `https://i.zhaopin.com/im?sessionId=${"a".repeat(32)}`;
        const selected = { rowIndex: 0, selected: true, sessionId: "a".repeat(32), jobNumber: JOB_A.sourceId, peerPartnerId: "501", senderId: "501", userId: "900", previewText: "合成预览" };
        state.imSnapshot = {
          state: "ready", listLoading: false, listError: "", rows: [selected],
          activeSessionId: selected.sessionId, activeSessionIdFromObject: selected.sessionId, activeJobNumber: selected.jobNumber,
          headerSessionId: selected.sessionId, headerJobNumber: selected.jobNumber, timelineLoading: false, timelineError: "",
          messages: [{ sessionId: selected.sessionId, jobNumber: selected.jobNumber, idServer: "801", flow: "out", fromMe: true, from: "900", type: "text", cardType: "", body: "您好", hasText: true, text: "您好" }]
        };
      } else {
        await page.evaluate(() => window.fixture.modal());
      }
    } });
    const imAdapter = adapterFor(imBrowser); await prepareSession(imAdapter, imBrowser);
    const imInspection = await imAdapter.inspectCommunicationJob(JOB_A); await imAdapter.dispatchCommunication(imInspection);
    assert.equal((await imAdapter.verifyCommunicationResult(JOB_A)).state, "succeeded", "same-tab IM success requires matching session/job and current outgoing text");
    const nextAfterIm = await imAdapter.inspectCommunicationJob(JOB_B);
    assert.equal(nextAfterIm.state, "ready", "a verified same-tab IM result can return through normal frozen lookup for the next job");
    await imAdapter.dispatchCommunication(nextAfterIm);
    assert.equal((await imAdapter.verifyCommunicationResult(JOB_B)).state, "succeeded");
    assert.equal(imBrowser.calls.filter((call) => call.kind === "prechat").length, 2);
    await imAdapter.restoreCommunicationSearchPage();
    assert.equal(imBrowser.calls.filter((call) => call.kind === "navigate").length, 2, "verified IM return and final restore each use one normal navigation");

    await page.goto(SEARCH_URL);
    const unverifiedImBrowser = fakeBrowser(page); const unverifiedImAdapter = adapterFor(unverifiedImBrowser); await prepareSession(unverifiedImAdapter, unverifiedImBrowser);
    unverifiedImBrowser.state.urlOverride = `https://i.zhaopin.com/im?sessionId=${"a".repeat(32)}`;
    unverifiedImBrowser.state.imSnapshot = imBrowser.state.imSnapshot;
    await assert.rejects(() => unverifiedImAdapter.inspectCommunicationJob(JOB_B), (error) => error.code === "ZHAOPIN_SEARCH_PAGE_LOST",
      "an arbitrary same-tab IM drift cannot authorize return navigation");
    assert.equal(unverifiedImBrowser.calls.filter((call) => call.kind === "navigate").length, 0);

    for (const mutateBinding of [
      (state) => { state.activeTabId = SEARCH_TAB; },
      (state) => { state.windowId += 1; }
    ]) {
      await page.goto(SEARCH_URL);
      const changedBrowser = fakeBrowser(page); const changedAdapter = adapterFor(changedBrowser); await prepareSession(changedAdapter, changedBrowser); mutateBinding(changedBrowser.state);
      await assert.rejects(() => changedAdapter.inspectCommunicationJob(JOB_A));
      assert.equal(changedBrowser.calls.filter((call) => call.kind === "prechat").length, 0);
    }

    for (const mutatePage of [
      () => page.evaluate(() => { document.title = "安全验证"; }),
      () => page.evaluate(() => { document.querySelector('.login-panel').hidden = false; }),
      () => page.evaluate(() => history.replaceState({}, "", "/unrelated"))
    ]) {
      await page.goto(SEARCH_URL);
      const stoppedBrowser = fakeBrowser(page); const stoppedAdapter = adapterFor(stoppedBrowser); await prepareSession(stoppedAdapter, stoppedBrowser); await mutatePage();
      await assert.rejects(() => stoppedAdapter.inspectCommunicationJob(JOB_A));
      assert.equal(stoppedBrowser.calls.filter((call) => call.kind === "prechat").length, 0);
    }
  } finally {
    await browserProcess.close();
  }
  console.log("zhaopin_communication_adapter_smoke ok");
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
