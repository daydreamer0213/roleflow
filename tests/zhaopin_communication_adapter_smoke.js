const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ZhaopinCommunicationAdapter,
  inspectZhaopinCommunicationTabs
} = require("../src/adapters/sites/zhaopin_communication");
const { createSiteAdapter } = require("../src/adapters/sites");

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

function fakeBrowser(page, { transport = "direct", onClick = null, startError = null, startResult = null, clickError = null, focusDisableError = null } = {}) {
  const state = {
    activeTabId: DASHBOARD_TAB,
    windowId: WINDOW_ID,
    entries: [],
    pendingRequests: 0,
    sequence: 0,
    networkStarted: false,
    clock: 1000,
    imSnapshot: null,
    urlOverride: ""
  };
  const calls = [];
  return {
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
      state.urlOverride = "";
    },
    async cdp(tabId, method, params) {
      calls.push({ kind: "focus", tabId, method, enabled: params?.enabled });
      if (params?.enabled === false && focusDisableError) throw focusDisableError;
      return {};
    },
    async clickAt(tabId, point) {
      calls.push({ kind: "prechat", tabId, point });
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('job-detail-summary__prechat'), point), true,
        "guarded coordinates must still point at 先聊聊");
      await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).click(), point);
      if (onClick) await onClick({ page, state });
      else {
        const sourceId = await page.evaluate(() => document.querySelector('.job-card--active').__vueParentComponent.proxy.$props.job.number);
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
      return { entries: state.entries.filter((entry) => entry.sequence > Number(options.sinceSequence || 0)), meta: { pendingRequests: state.pendingRequests } };
    },
    async stopNetworkLog(tabId) {
      calls.push({ kind: "stopNetworkLog", tabId });
      state.networkStarted = false;
      return { stopped: true };
    },
    async bringToFront() { throw new Error("must not activate a tab"); },
    async createTab() { throw new Error("must not create a tab"); }
  };
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
  const browserProcess = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browserProcess.newPage();
    const html = fs.readFileSync(path.join(__dirname, "fixtures", "zhaopin", "communication.html"), "utf8");
    await page.route("https://www.zhaopin.com/jobs/**", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
    await page.goto(SEARCH_URL);

    assert(createSiteAdapter("zhaopin", { operation: "communication", browser: fakeBrowser(page) }) instanceof ZhaopinCommunicationAdapter);
    assert.equal(createSiteAdapter("zhaopin", { browser: fakeBrowser(page) }).constructor.name, "ZhaopinSiteAdapter", "search factory behavior stays unchanged");

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

    const outcomes = [
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
    assert.equal((await delayedAdapter.verifyCommunicationResult(JOB_A)).state, "succeeded", "a delayed joined response is polled without a second click");
    assert.equal(delayedBrowser.calls.filter((call) => call.kind === "prechat").length, 1);

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
    const imBrowser = fakeBrowser(page, { onClick: ({ state }) => {
      state.sequence += 1;
      state.entries.push(safeEntry(JOB_A, state.clock, { sequence: state.sequence }));
      state.urlOverride = `https://i.zhaopin.com/im?sessionId=${"a".repeat(32)}`;
      const selected = { rowIndex: 0, selected: true, sessionId: "a".repeat(32), jobNumber: JOB_A.sourceId, peerPartnerId: "501", senderId: "501", userId: "900", previewText: "合成预览" };
      state.imSnapshot = {
        state: "ready", listLoading: false, listError: "", rows: [selected],
        activeSessionId: selected.sessionId, activeSessionIdFromObject: selected.sessionId, activeJobNumber: selected.jobNumber,
        headerSessionId: selected.sessionId, headerJobNumber: selected.jobNumber, timelineLoading: false, timelineError: "",
        messages: [{ sessionId: selected.sessionId, jobNumber: selected.jobNumber, idServer: "801", flow: "out", fromMe: true, from: "900", type: "text", cardType: "", body: "您好", hasText: true, text: "您好" }]
      };
    } });
    const imAdapter = adapterFor(imBrowser); await prepareSession(imAdapter, imBrowser);
    const imInspection = await imAdapter.inspectCommunicationJob(JOB_A); await imAdapter.dispatchCommunication(imInspection);
    assert.equal((await imAdapter.verifyCommunicationResult(JOB_A)).state, "succeeded", "same-tab IM success requires matching session/job and current outgoing text");
    await imAdapter.restoreCommunicationSearchPage();
    assert.equal(imBrowser.calls.filter((call) => call.kind === "navigate").length, 1, "same-tab IM result restores the captured search page");

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
