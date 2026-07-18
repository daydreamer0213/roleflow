const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
  BossSiteAdapter,
  classifyBossCommunicationSnapshot
} = require("../src/adapters/sites/boss");
const { communicationCalibrationStatus } = require("../src/core/communication_calibration");

const jobUrl = "https://www.zhipin.com/job_detail/fake123.html";
const secondJobUrl = "https://www.zhipin.com/job_detail/fake456.html";
const searchUrl = "https://www.zhipin.com/web/geek/jobs?query=fake";
const communicationLabel = "\u7acb\u5373\u6c9f\u901a";
const continuingCommunicationLabel = "\u7ee7\u7eed\u6c9f\u901a";
const readySnapshot = {
  url: jobUrl,
  jobId: "fake123",
  pageReady: true,
  risk: false,
  login: false,
  jobStatus: "\u62db\u8058\u4e2d",
  title: "AI\u5e94\u7528\u5f00\u53d1\u5de5\u7a0b\u5e08",
  company: "\u793a\u4f8b\u79d1\u6280",
  salary: "10-15K",
  bossActiveText: "\u4eca\u65e5\u6d3b\u8dc3",
  actions: [{ label: communicationLabel, x: 320, y: 120, width: 150, height: 45 }]
};
const expectedJob = {
  url: jobUrl,
  title: readySnapshot.title,
  company: readySnapshot.company
};
const secondJob = {
  url: secondJobUrl,
  title: "\u540e\u7aef\u5f00\u53d1\u5de5\u7a0b\u5e08",
  company: "\u53e6\u4e00\u5bb6\u79d1\u6280"
};

assert.deepStrictEqual(
  classifyBossCommunicationSnapshot(readySnapshot, expectedJob),
  {
    state: "ready",
    jobId: "fake123",
    title: readySnapshot.title,
    company: readySnapshot.company,
    salary: "10-15K",
    bossActiveText: readySnapshot.bossActiveText,
    actionLabel: communicationLabel,
    clickPoint: { x: 395, y: 142.5 }
  }
);

for (const [snapshot, expectedState] of [
  [{ ...readySnapshot, jobId: "other" }, "target_mismatch"],
  [{ ...readySnapshot, url: secondJobUrl }, "target_mismatch"],
  [{ ...readySnapshot, url: "https://www.zhipin.com/job_detail/.html" }, "target_mismatch"],
  [{ ...readySnapshot, title: "Java\u5f00\u53d1\u5de5\u7a0b\u5e08" }, "target_mismatch"],
  [{ ...readySnapshot, company: "\u53e6\u4e00\u5bb6\u516c\u53f8" }, "target_mismatch"],
  [{ ...readySnapshot, jobStatus: "\u505c\u6b62\u62db\u8058", actions: [] }, "job_unavailable"],
  [{ ...readySnapshot, jobStatus: "" }, "action_unavailable"],
  [{ ...readySnapshot, actions: [] }, "action_unavailable"],
  [{ ...readySnapshot, actions: [{ ...readySnapshot.actions[0] }, { ...readySnapshot.actions[0] }] }, "action_unavailable"],
  [{ ...readySnapshot, actions: [{ ...readySnapshot.actions[0], label: "\u6536\u85cf" }] }, "action_unavailable"],
  [{ ...readySnapshot, actions: [{ ...readySnapshot.actions[0], visible: false }] }, "action_unavailable"],
  [{ ...readySnapshot, actions: [{ ...readySnapshot.actions[0], disabled: true }] }, "action_unavailable"],
  [{ ...readySnapshot, pageReady: false }, "action_unavailable"]
]) {
  assert.strictEqual(classifyBossCommunicationSnapshot(snapshot, expectedJob).state, expectedState);
}
assert.strictEqual(
  classifyBossCommunicationSnapshot(
    { ...readySnapshot, company: "\u5e7f\u5dde\u661f\u6cb3\u667a\u80fd\u79d1\u6280\u6709\u9650\u516c\u53f8" },
    { ...expectedJob, company: "\u661f\u6cb3\u667a\u80fd" }
  ).state,
  "ready"
);
assert.throws(
  () => classifyBossCommunicationSnapshot({ ...readySnapshot, risk: true }, expectedJob),
  (error) => error.code === "BOSS_RISK_CONTROL"
);
assert.throws(
  () => classifyBossCommunicationSnapshot({ ...readySnapshot, login: true }, expectedJob),
  (error) => error.code === "BOSS_LOGIN_REQUIRED"
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function actionNode(label = communicationLabel, { visible = true, disabled = false } = {}) {
  return testNode({
    text: label,
    rect: visible ? { x: 320, y: 120, width: 150, height: 45 } : { x: 320, y: 120, width: 0, height: 0 },
    disabled,
    style: visible ? {} : { display: "none" }
  });
}

function fixtureForUrl(url, fixtures) {
  const job = url === secondJobUrl ? secondJob : expectedJob;
  return {
    job,
    jobStatus: readySnapshot.jobStatus,
    actions: [actionNode()],
    ...(fixtures.get(url) || {})
  };
}

function snapshotContext(url, fixtures) {
  const fixture = fixtureForUrl(url, fixtures);
  const actionRoot = testNode({ actions: fixture.actions });
  const header = testNode({ children: { ".job-op": actionRoot } });
  const nodes = {
    ".job-primary.detail-box": /^\/job_detail\//.test(new URL(url).pathname) ? header : null,
    ".job-primary": /^\/job_detail\//.test(new URL(url).pathname) ? header : null,
    ".job-primary h1": testNode({ text: fixture.job.title }),
    ".job-primary .salary": testNode({ text: readySnapshot.salary }),
    ".sider-company .company-info": testNode({ text: fixture.job.company }),
    ".job-boss-info .boss-active-time": testNode({ text: readySnapshot.bossActiveText })
  };
  if (fixture.jobStatus !== undefined) nodes[".job-status"] = testNode({ text: fixture.jobStatus });
  const document = {
    title: "",
    body: { innerText: "Standalone detail fixture" },
    querySelector(selector) { return nodes[selector] || null; },
    querySelectorAll(selector) {
      const collections = { ".sign-form, .login-register, [class*='login-form']": [] };
      return collections[selector] || [];
    }
  };
  const context = vm.createContext({
    document,
    location: new URL(url),
    URLSearchParams,
    getComputedStyle(element) {
      return { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto", ...(element?.style || {}) };
    }
  });
  context.window = context;
  return context;
}

function testNode({ text = "", rect = { x: 0, y: 0, width: 0, height: 0 }, actions = [], children = {}, disabled = false, style = {} } = {}) {
  return {
    innerText: text,
    textContent: text,
    disabled,
    style,
    classList: { contains(name) { return disabled && name === "disabled"; } },
    getAttribute(name) { return disabled && name === "aria-disabled" ? "true" : null; },
    getBoundingClientRect() { return rect; },
    matches(selector) { return disabled && selector === ":disabled"; },
    querySelector(selector) { return children[selector] || null; },
    querySelectorAll(selector) { return selector === "a, button, [role='button']" ? actions : []; }
  };
}

function fakeBrowser({ tabs = [], fixtures = new Map(), createTabGate = null, createStarted = null } = {}) {
  const calls = { listTabs: 0, createTab: [], bringToFront: [], navigate: [], evalValue: [], clickAt: [] };
  let currentTabs = tabs;
  const contexts = new Map();
  const snapshots = [];
  return {
    calls,
    snapshots,
    async listTabs() {
      calls.listTabs += 1;
      return currentTabs;
    },
    async createTab(openerTabId, url) {
      calls.createTab.push([openerTabId, url]);
      createStarted?.resolve();
      if (createTabGate) await createTabGate.promise;
      const opener = currentTabs.find((tab) => tab.id === openerTabId);
      const id = `communication-created${calls.createTab.length === 1 ? "" : `-${calls.createTab.length}`}`;
      currentTabs = [...currentTabs, { id, url, windowId: opener?.windowId }];
      return id;
    },
    async bringToFront(tabId) { calls.bringToFront.push(tabId); },
    async navigate(tabId, url) {
      calls.navigate.push([tabId, url]);
      currentTabs = currentTabs.map((tab) => tab.id === tabId ? { ...tab, url } : tab);
      contexts.delete(tabId);
    },
    async evalValue(tabId, expression) {
      calls.evalValue.push([tabId, expression]);
      const tab = currentTabs.find((candidate) => candidate.id === tabId);
      if (!contexts.has(tabId)) contexts.set(tabId, snapshotContext(tab?.url || "about:blank", fixtures));
      const result = vm.runInContext(expression, contexts.get(tabId));
      if (expression === "(() => window.__bossCommunicationSnapshot())()") snapshots.push(result);
      return result;
    },
    async clickAt(tabId, x, y) { calls.clickAt.push([tabId, x, y]); },
    setTabUrl(tabId, url) {
      currentTabs = currentTabs.map((tab) => tab.id === tabId ? { ...tab, url } : tab);
      contexts.delete(tabId);
    },
    removeTab(tabId) {
      currentTabs = currentTabs.filter((tab) => tab.id !== tabId);
      contexts.delete(tabId);
    }
  };
}

function assertNoPageAction(browser, before) {
  assert.strictEqual(browser.calls.createTab.length, before.createTab);
  assert.strictEqual(browser.calls.navigate.length, before.navigate);
  assert.strictEqual(browser.calls.clickAt.length, before.clickAt);
}

function preparationCallCounts(browser) {
  return {
    listTabs: browser.calls.listTabs,
    createTab: browser.calls.createTab.length,
    bringToFront: browser.calls.bringToFront.length,
    navigate: browser.calls.navigate.length,
    evalValue: browser.calls.evalValue.length,
    clickAt: browser.calls.clickAt.length
  };
}

function assertNoPreparationAction(browser, before) {
  assert.deepStrictEqual(preparationCallCounts(browser), before);
}

(async () => {
  const existingBrowser = fakeBrowser({
    tabs: [
      { id: "search", url: searchUrl, windowId: "window-1" },
      { id: "detail", url: jobUrl, windowId: "window-1" }
    ]
  });
  const existingAdapter = new BossSiteAdapter({ browser: existingBrowser, sleepFn: async () => {} });
  assert.strictEqual(await existingAdapter.prepareCommunicationTab("search"), "detail");
  assert.strictEqual(await existingAdapter.prepareCommunicationTab("search"), "detail");
  assert.deepStrictEqual(existingBrowser.calls.createTab, []);

  const pinnedSearchBrowser = fakeBrowser({
    tabs: [
      { id: "search-1", url: searchUrl, windowId: "window-1" },
      { id: "search-2", url: `${searchUrl}&page=2`, windowId: "window-1" }
    ]
  });
  const pinnedSearchAdapter = new BossSiteAdapter({ browser: pinnedSearchBrowser, sleepFn: async () => {} });
  await pinnedSearchAdapter.prepareCommunicationTab("search-1");
  const callsBeforeSearchRebind = preparationCallCounts(pinnedSearchBrowser);
  await assert.rejects(
    () => pinnedSearchAdapter.prepareCommunicationTab("search-2"),
    (error) => error.code === "BOSS_SEARCH_PAGE_LOST"
  );
  assertNoPreparationAction(pinnedSearchBrowser, callsBeforeSearchRebind);

  const unknownSearchWindowBrowser = fakeBrowser({ tabs: [{ id: "search", url: searchUrl }] });
  const unknownSearchWindowCalls = preparationCallCounts(unknownSearchWindowBrowser);
  await assert.rejects(
    () => new BossSiteAdapter({ browser: unknownSearchWindowBrowser, sleepFn: async () => {} }).prepareCommunicationTab("search"),
    (error) => error.code === "BOSS_COMMUNICATION_TAB_WINDOW_UNKNOWN"
  );
  assert.deepStrictEqual(preparationCallCounts(unknownSearchWindowBrowser), {
    ...unknownSearchWindowCalls,
    listTabs: unknownSearchWindowCalls.listTabs + 1
  });

  const storedUnknownWindowBrowser = fakeBrowser({
    tabs: [
      { id: "search", url: searchUrl, windowId: "window-1" },
      { id: "stored-detail", url: jobUrl }
    ]
  });
  const storedUnknownWindowAdapter = new BossSiteAdapter({ browser: storedUnknownWindowBrowser, sleepFn: async () => {} });
  storedUnknownWindowAdapter.communicationTabId = "stored-detail";
  const storedUnknownWindowCalls = preparationCallCounts(storedUnknownWindowBrowser);
  await assert.rejects(
    () => storedUnknownWindowAdapter.prepareCommunicationTab("search"),
    (error) => error.code === "BOSS_COMMUNICATION_TAB_WINDOW_MISMATCH"
  );
  assert.strictEqual(storedUnknownWindowBrowser.calls.createTab.length, storedUnknownWindowCalls.createTab);
  assert.strictEqual(storedUnknownWindowBrowser.calls.bringToFront.length, storedUnknownWindowCalls.bringToFront);
  assert.strictEqual(storedUnknownWindowBrowser.calls.navigate.length, storedUnknownWindowCalls.navigate);
  assert.strictEqual(storedUnknownWindowBrowser.calls.clickAt.length, storedUnknownWindowCalls.clickAt);

  const reusableUnknownWindowBrowser = fakeBrowser({
    tabs: [
      { id: "search", url: searchUrl, windowId: "window-1" },
      { id: "untrusted-detail", url: jobUrl }
    ]
  });
  const reusableUnknownWindowAdapter = new BossSiteAdapter({ browser: reusableUnknownWindowBrowser, sleepFn: async () => {} });
  assert.strictEqual(await reusableUnknownWindowAdapter.prepareCommunicationTab("search"), "communication-created");
  assert.deepStrictEqual(reusableUnknownWindowBrowser.calls.createTab, [["search", "about:blank"]]);
  assert.deepStrictEqual(reusableUnknownWindowBrowser.calls.bringToFront, ["communication-created"]);

  existingBrowser.setTabUrl("search", jobUrl);
  const callsBeforeSearchDrift = {
    createTab: existingBrowser.calls.createTab.length,
    navigate: existingBrowser.calls.navigate.length,
    clickAt: existingBrowser.calls.clickAt.length
  };
  await assert.rejects(
    () => existingAdapter.prepareCommunicationTab(),
    (error) => error.code === "BOSS_SEARCH_PAGE_LOST"
  );
  assertNoPageAction(existingBrowser, callsBeforeSearchDrift);

  const closedSearchBrowser = fakeBrowser({ tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }] });
  const closedSearchAdapter = new BossSiteAdapter({ browser: closedSearchBrowser, sleepFn: async () => {} });
  await closedSearchAdapter.prepareCommunicationTab("search");
  closedSearchBrowser.removeTab("search");
  const callsBeforeSearchClosed = {
    createTab: closedSearchBrowser.calls.createTab.length,
    navigate: closedSearchBrowser.calls.navigate.length,
    clickAt: closedSearchBrowser.calls.clickAt.length
  };
  await assert.rejects(
    () => closedSearchAdapter.prepareCommunicationTab(),
    (error) => error.code === "BOSS_SEARCH_PAGE_LOST"
  );
  assertNoPageAction(closedSearchBrowser, callsBeforeSearchClosed);

  const crossWindowBrowser = fakeBrowser({
    tabs: [
      { id: "search", url: searchUrl, windowId: "window-1" },
      { id: "detail", url: jobUrl, windowId: "window-2" }
    ]
  });
  assert.strictEqual(
    await new BossSiteAdapter({ browser: crossWindowBrowser, sleepFn: async () => {} }).prepareCommunicationTab("search"),
    "communication-created"
  );
  assert.deepStrictEqual(crossWindowBrowser.calls.createTab, [["search", "about:blank"]]);

  const createGate = deferred();
  const createStarted = deferred();
  const parallelPrepareBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    createTabGate: createGate,
    createStarted
  });
  const parallelPrepareAdapter = new BossSiteAdapter({ browser: parallelPrepareBrowser, sleepFn: async () => {} });
  const firstPrepare = parallelPrepareAdapter.prepareCommunicationTab("search");
  await createStarted.promise;
  const secondPrepare = parallelPrepareAdapter.prepareCommunicationTab("search");
  assert.strictEqual(parallelPrepareBrowser.calls.createTab.length, 1);
  createGate.resolve();
  assert.strictEqual(await firstPrepare, "communication-created");
  assert.strictEqual(await secondPrepare, "communication-created");

  const inspectBrowser = fakeBrowser({ tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }] });
  const inspectAdapter = new BossSiteAdapter({ browser: inspectBrowser, sleepFn: async () => {} });
  const inspection = await inspectAdapter.inspectCommunicationJob(expectedJob);
  assert.strictEqual(inspection.state, "ready");
  const secondInspection = await inspectAdapter.inspectCommunicationJob(secondJob);
  assert.strictEqual(secondInspection.state, "ready");
  assert.deepStrictEqual(inspectBrowser.calls.createTab, [["search", "about:blank"]]);
  assert.deepStrictEqual(inspectBrowser.calls.navigate, [["communication-created", jobUrl], ["communication-created", secondJobUrl]]);
  assert.strictEqual(inspectBrowser.calls.clickAt.length, 0);
  assert(inspectBrowser.calls.evalValue.some(([, expression]) => expression.includes("window.__bossCommunicationSnapshot = function()")));
  const snapshot = JSON.parse(JSON.stringify(inspectBrowser.snapshots[0]));
  assert.deepStrictEqual(snapshot, readySnapshot);
  assert.deepStrictEqual(Object.keys(snapshot).sort(), [
    "actions", "bossActiveText", "company", "jobId", "jobStatus", "login", "pageReady", "risk", "salary", "title", "url"
  ]);

  for (const fixture of [
    { actions: [actionNode("\u6536\u85cf"), actionNode("\u5b8c\u5584\u7b80\u5386"), actionNode(), actionNode(continuingCommunicationLabel)] },
    { actions: [actionNode(communicationLabel, { visible: false })] },
    { actions: [actionNode(communicationLabel, { disabled: true })] },
    { jobStatus: undefined }
  ]) {
    const browser = fakeBrowser({
      tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
      fixtures: new Map([[jobUrl, fixture]])
    });
    const result = await new BossSiteAdapter({ browser, sleepFn: async () => {} }).inspectCommunicationJob(expectedJob);
    assert.strictEqual(result.state, "action_unavailable");
    const domSnapshot = JSON.parse(JSON.stringify(browser.snapshots[0]));
    if (fixture.actions?.[0] && fixture.actions.length === 1) assert.deepStrictEqual(domSnapshot.actions, []);
    if (fixture.actions?.some((action) => action.innerText === continuingCommunicationLabel)) {
      assert.deepStrictEqual(domSnapshot.actions.map((action) => action.label), [communicationLabel, continuingCommunicationLabel]);
    }
    if (fixture.jobStatus === undefined && !fixture.actions) assert.strictEqual(domSnapshot.jobStatus, "");
  }

  const busySleepStarted = deferred();
  const busySleepGate = deferred();
  const busyBrowser = fakeBrowser({ tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }] });
  const busyAdapter = new BossSiteAdapter({
    browser: busyBrowser,
    sleepFn: async () => {
      busySleepStarted.resolve();
      await busySleepGate.promise;
    }
  });
  const firstInspection = busyAdapter.inspectCommunicationJob(expectedJob);
  await busySleepStarted.promise;
  await assert.rejects(
    () => busyAdapter.inspectCommunicationJob(secondJob),
    (error) => error.code === "BOSS_COMMUNICATION_BUSY"
  );
  assert.deepStrictEqual(busyBrowser.calls.createTab, [["search", "about:blank"]]);
  assert.deepStrictEqual(busyBrowser.calls.navigate, [["communication-created", jobUrl]]);
  busySleepGate.resolve();
  assert.strictEqual((await firstInspection).state, "ready");
  assert.strictEqual((await busyAdapter.inspectCommunicationJob(secondJob)).state, "ready");

  await assert.rejects(
    () => inspectAdapter.inspectCommunicationJob({ url: "http://www.zhipin.com/job_detail/fake123.html", title: expectedJob.title, company: expectedJob.company }),
    (error) => error.code === "BOSS_COMMUNICATION_URL_INVALID"
  );
  await assert.rejects(
    () => inspectAdapter.dispatchCommunication({}),
    (error) => error.code === "BOSS_COMMUNICATION_CALIBRATION_REQUIRED"
  );
  await assert.rejects(
    () => inspectAdapter.verifyCommunicationResult({}),
    (error) => error.code === "BOSS_COMMUNICATION_CALIBRATION_REQUIRED"
  );
  assert.strictEqual(inspectBrowser.calls.clickAt.length, 0);
  assert.deepStrictEqual(communicationCalibrationStatus(), { status: "pending", executionEnabled: false });
  console.log("boss_communication_page_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
