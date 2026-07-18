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
const communicationSentTitle = "\u5df2\u5411BOSS\u53d1\u9001\u6d88\u606f";
const stayOnPageLabel = "\u7559\u5728\u6b64\u9875\u7ee7\u7eed\u6c9f\u901a";
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
  actions: [{
    label: communicationLabel,
    x: 320,
    y: 120,
    width: 150,
    height: 45,
    isFriend: "false",
    redirectJobId: "fake123",
    hasChatIdentity: true
  }],
  successDialog: { visible: false, title: "", footer: "" }
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
assert.deepStrictEqual(
  classifyBossCommunicationSnapshot({
    ...readySnapshot,
    actions: [{ ...readySnapshot.actions[0], label: continuingCommunicationLabel, isFriend: "true" }]
  }, expectedJob),
  { state: "already_communicated" }
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
  [{ ...readySnapshot, actions: [{ ...readySnapshot.actions[0], redirectJobId: "other" }] }, "action_unavailable"],
  [{ ...readySnapshot, actions: [{ ...readySnapshot.actions[0], hasChatIdentity: false }] }, "action_unavailable"],
  [{ ...readySnapshot, actions: [{ ...readySnapshot.actions[0], isFriend: "true" }] }, "action_unavailable"],
  [{ ...readySnapshot, actions: [{ ...readySnapshot.actions[0], visible: false }] }, "action_unavailable"],
  [{ ...readySnapshot, actions: [{ ...readySnapshot.actions[0], disabled: true }] }, "action_unavailable"],
  [{ ...readySnapshot, actions: [{ ...readySnapshot.actions[0], label: continuingCommunicationLabel, visible: false }] }, "action_unavailable"],
  [{ ...readySnapshot, actions: [{ ...readySnapshot.actions[0], label: continuingCommunicationLabel, disabled: true }] }, "action_unavailable"],
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

function actionNode(label = communicationLabel, {
  visible = true,
  disabled = false,
  isFriend = "false",
  redirectJobId = "fake123",
  hasChatIdentity = true
} = {}) {
  return testNode({
    text: label,
    rect: visible ? { x: 320, y: 120, width: 150, height: 45 } : { x: 320, y: 120, width: 0, height: 0 },
    disabled,
    style: visible ? {} : { display: "none" },
    attrs: {
      "data-isfriend": isFriend,
      "redirect-url": `/web/geek/chat?${hasChatIdentity ? "id=chat-fake&" : ""}jobId=${redirectJobId}`
    }
  });
}

function sentFixture(overrides = {}) {
  return {
    actions: [actionNode(continuingCommunicationLabel, { isFriend: "true" })],
    successDialog: { visible: true, title: communicationSentTitle, footer: stayOnPageLabel },
    ...overrides
  };
}

function fixtureForUrl(url, fixtures) {
  const job = url === secondJobUrl ? secondJob : expectedJob;
  const jobId = (new URL(url).pathname.match(/^\/job_detail\/([^/?#]+)\.html$/i) || [])[1] || "";
  return {
    job,
    jobStatus: readySnapshot.jobStatus,
    actions: [actionNode(communicationLabel, { redirectJobId: jobId })],
    ...(fixtures.get(url) || {})
  };
}

function snapshotContext(url, fixtures, onActionClick = () => {}) {
  const fixture = fixtureForUrl(url, fixtures);
  for (const action of fixture.actions || []) action.click = onActionClick;
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
  if (fixture.successDialog) {
    nodes[".greet-boss-pop, .greet-pop"] = testNode({
      rect: fixture.successDialog.visible === false
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: 200, y: 120, width: 480, height: 260 },
      children: {
        ".dialog-title": testNode({ text: fixture.successDialog.title || "" }),
        ".dialog-footer": testNode({ text: fixture.successDialog.footer || "" })
      }
    });
  }
  if (fixture.jobStatus !== undefined) nodes[".job-status"] = testNode({ text: fixture.jobStatus });
  const document = {
    title: fixture.title || "",
    body: { innerText: fixture.bodyText || "Standalone detail fixture" },
    querySelector(selector) { return nodes[selector] || null; },
    querySelectorAll(selector) {
      const collections = { ".sign-form, .login-register, [class*='login-form']": [] };
      return collections[selector] || [];
    }
  };
  const context = vm.createContext({
    document,
    location: new URL(url),
    URL,
    URLSearchParams,
    getComputedStyle(element) {
      return { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto", ...(element?.style || {}) };
    }
  });
  context.window = context;
  return context;
}

function testNode({
  text = "",
  rect = { x: 0, y: 0, width: 0, height: 0 },
  actions = [],
  children = {},
  disabled = false,
  style = {},
  attrs = {}
} = {}) {
  return {
    innerText: text,
    textContent: text,
    disabled,
    style,
    classList: { contains(name) { return disabled && name === "disabled"; } },
    getAttribute(name) {
      if (Object.prototype.hasOwnProperty.call(attrs, name)) return attrs[name];
      return disabled && name === "aria-disabled" ? "true" : null;
    },
    getBoundingClientRect() { return rect; },
    matches(selector) { return disabled && selector === ":disabled"; },
    querySelector(selector) { return children[selector] || null; },
    querySelectorAll(selector) { return selector === "a, button, [role='button']" ? actions : []; }
  };
}

function fakeBrowser({
  tabs = [],
  fixtures = new Map(),
  afterClickFixtures = new Map(),
  guardedClickGate = null,
  guardedClickStarted = null,
  guardedClickDriftUrl = "",
  createTabGate = null,
  createStarted = null
} = {}) {
  const calls = { listTabs: 0, createTab: [], bringToFront: [], navigate: [], evalValue: [], clickAt: [], guardedClick: [] };
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
      if (expression.includes("__bossGuardedCommunicationClick")) {
        calls.guardedClick.push([tabId, expression]);
        guardedClickStarted?.resolve();
        if (guardedClickGate) await guardedClickGate.promise;
        if (guardedClickDriftUrl) {
          currentTabs = currentTabs.map((tab) => tab.id === tabId ? { ...tab, url: guardedClickDriftUrl } : tab);
          contexts.delete(tabId);
        }
      }
      const tab = currentTabs.find((candidate) => candidate.id === tabId);
      if (!contexts.has(tabId)) {
        const contextUrl = tab?.url || "about:blank";
        contexts.set(tabId, snapshotContext(contextUrl, fixtures, () => {
          const nextFixture = afterClickFixtures.get(contextUrl);
          if (nextFixture) fixtures.set(contextUrl, nextFixture);
          contexts.delete(tabId);
        }));
      }
      const result = vm.runInContext(expression, contexts.get(tabId));
      if (expression === "(() => window.__bossCommunicationSnapshot())()") snapshots.push(result);
      return result;
    },
    async clickAt(tabId, point) { calls.clickAt.push([tabId, point]); },
    setTabUrl(tabId, url) {
      currentTabs = currentTabs.map((tab) => tab.id === tabId ? { ...tab, url } : tab);
      contexts.delete(tabId);
    },
    setFixture(url, fixture) {
      fixtures.set(url, fixture);
      for (const tab of currentTabs.filter((candidate) => candidate.url === url)) {
        const context = contexts.get(tab.id);
        if (!context) continue;
        context.document.title = fixture.title || "";
        context.document.body.innerText = fixture.bodyText || "Standalone detail fixture";
      }
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
  assert.strictEqual(browser.calls.guardedClick.length, before.guardedClick || 0);
}

function preparationCallCounts(browser) {
  return {
    listTabs: browser.calls.listTabs,
    createTab: browser.calls.createTab.length,
    bringToFront: browser.calls.bringToFront.length,
    navigate: browser.calls.navigate.length,
    evalValue: browser.calls.evalValue.length,
    clickAt: browser.calls.clickAt.length,
    guardedClick: browser.calls.guardedClick.length
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
    (error) => error.code === "BOSS_COMMUNICATION_TAB_WINDOW_UNKNOWN"
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
  const reusableUnknownWindowCalls = preparationCallCounts(reusableUnknownWindowBrowser);
  await assert.rejects(
    () => reusableUnknownWindowAdapter.prepareCommunicationTab("search"),
    (error) => error.code === "BOSS_COMMUNICATION_TAB_WINDOW_UNKNOWN"
  );
  assert.strictEqual(reusableUnknownWindowBrowser.calls.createTab.length, reusableUnknownWindowCalls.createTab);
  assert.strictEqual(reusableUnknownWindowBrowser.calls.navigate.length, reusableUnknownWindowCalls.navigate);
  assert.strictEqual(reusableUnknownWindowBrowser.calls.clickAt.length, reusableUnknownWindowCalls.clickAt);

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
    "actions", "bossActiveText", "company", "jobId", "jobStatus", "login", "pageReady", "risk", "salary", "successDialog", "title", "url"
  ]);

  const alreadyCommunicatedBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    fixtures: new Map([[jobUrl, { actions: [actionNode(continuingCommunicationLabel, { isFriend: "true" })] }]])
  });
  const alreadyCommunicatedResult = await new BossSiteAdapter({
    browser: alreadyCommunicatedBrowser,
    sleepFn: async () => {}
  }).inspectCommunicationJob(expectedJob);
  assert.strictEqual(alreadyCommunicatedResult.state, "already_communicated");
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(alreadyCommunicatedBrowser.snapshots[0].actions.map((action) => action.label))),
    [continuingCommunicationLabel]
  );
  assert.strictEqual(alreadyCommunicatedBrowser.calls.clickAt.length, 0);

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

  const executionBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    afterClickFixtures: new Map([[jobUrl, sentFixture()]])
  });
  const executionAdapter = new BossSiteAdapter({ browser: executionBrowser, sleepFn: async () => {} });
  const executionInspection = await executionAdapter.inspectCommunicationJob(expectedJob);
  assert.deepStrictEqual(
    await executionAdapter.dispatchCommunication(executionInspection),
    { state: "dispatched", jobId: "fake123" }
  );
  assert.strictEqual(executionBrowser.calls.clickAt.length, 0);
  assert.strictEqual(executionBrowser.calls.guardedClick.length, 1);
  assert.strictEqual(executionBrowser.calls.guardedClick[0][0], "communication-created");
  assert.match(executionBrowser.calls.guardedClick[0][1], /__bossGuardedCommunicationClick/);
  assert.match(executionBrowser.calls.guardedClick[0][1], /fake123/);
  assert.deepStrictEqual(
    await executionAdapter.verifyCommunicationResult(expectedJob),
    { state: "succeeded", jobId: "fake123" }
  );
  assert.deepStrictEqual(executionBrowser.calls.navigate, [["communication-created", jobUrl]]);
  await assert.rejects(
    () => executionAdapter.dispatchCommunication(executionInspection),
    (error) => error.code === "BOSS_COMMUNICATION_ALREADY_DISPATCHED"
  );
  assert.strictEqual(executionBrowser.calls.guardedClick.length, 1);

  const guardedClickGate = deferred();
  const guardedClickStarted = deferred();
  const lockedBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    afterClickFixtures: new Map([[jobUrl, sentFixture()]]),
    guardedClickGate,
    guardedClickStarted
  });
  const lockedAdapter = new BossSiteAdapter({ browser: lockedBrowser, sleepFn: async () => {} });
  const lockedInspection = await lockedAdapter.inspectCommunicationJob(expectedJob);
  const lockedDispatch = lockedAdapter.dispatchCommunication(lockedInspection);
  await guardedClickStarted.promise;
  await assert.rejects(
    () => lockedAdapter.inspectCommunicationJob(secondJob),
    (error) => error.code === "BOSS_COMMUNICATION_BUSY"
  );
  await assert.rejects(
    () => lockedAdapter.verifyCommunicationResult(expectedJob),
    (error) => error.code === "BOSS_COMMUNICATION_BUSY"
  );
  guardedClickGate.resolve();
  assert.deepStrictEqual(await lockedDispatch, { state: "dispatched", jobId: "fake123" });
  assert.deepStrictEqual(lockedBrowser.calls.navigate, [["communication-created", jobUrl]]);

  const clickDriftBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    guardedClickDriftUrl: secondJobUrl
  });
  const clickDriftAdapter = new BossSiteAdapter({ browser: clickDriftBrowser, sleepFn: async () => {} });
  const clickDriftInspection = await clickDriftAdapter.inspectCommunicationJob(expectedJob);
  await assert.rejects(
    () => clickDriftAdapter.dispatchCommunication(clickDriftInspection),
    (error) => error.code === "BOSS_COMMUNICATION_TARGET_CHANGED"
  );
  await assert.rejects(
    () => clickDriftAdapter.dispatchCommunication(clickDriftInspection),
    (error) => error.code === "BOSS_COMMUNICATION_ALREADY_DISPATCHED"
  );
  assert.strictEqual(clickDriftBrowser.calls.guardedClick.length, 1);

  const guardRiskGate = deferred();
  const guardRiskStarted = deferred();
  const guardRiskBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    guardedClickGate: guardRiskGate,
    guardedClickStarted: guardRiskStarted
  });
  const guardRiskAdapter = new BossSiteAdapter({ browser: guardRiskBrowser, sleepFn: async () => {} });
  const guardRiskInspection = await guardRiskAdapter.inspectCommunicationJob(expectedJob);
  const guardRiskDispatch = guardRiskAdapter.dispatchCommunication(guardRiskInspection);
  await guardRiskStarted.promise;
  guardRiskBrowser.setFixture(jobUrl, { bodyText: "\u8d26\u6237\u5b58\u5728\u5f02\u5e38\u884c\u4e3a" });
  guardRiskGate.resolve();
  await assert.rejects(
    () => guardRiskDispatch,
    (error) => error.code === "BOSS_RISK_CONTROL"
  );
  assert.strictEqual(guardRiskBrowser.calls.guardedClick.length, 1);

  const driftBrowser = fakeBrowser({ tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }] });
  const driftAdapter = new BossSiteAdapter({ browser: driftBrowser, sleepFn: async () => {} });
  const driftInspection = await driftAdapter.inspectCommunicationJob(expectedJob);
  driftBrowser.setTabUrl("communication-created", secondJobUrl);
  await assert.rejects(
    () => driftAdapter.dispatchCommunication(driftInspection),
    (error) => error.code === "BOSS_COMMUNICATION_TARGET_CHANGED"
  );
  assert.strictEqual(driftBrowser.calls.clickAt.length, 0);
  assert.strictEqual(driftBrowser.calls.guardedClick.length, 0);

  const ambiguousBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    afterClickFixtures: new Map([[jobUrl, sentFixture({ successDialog: null })]])
  });
  const ambiguousAdapter = new BossSiteAdapter({ browser: ambiguousBrowser, sleepFn: async () => {} });
  const ambiguousInspection = await ambiguousAdapter.inspectCommunicationJob(expectedJob);
  await ambiguousAdapter.dispatchCommunication(ambiguousInspection);
  assert.deepStrictEqual(
    await ambiguousAdapter.verifyCommunicationResult(expectedJob),
    { state: "ambiguous" }
  );
  assert.strictEqual(ambiguousBrowser.snapshots.length, 6);
  await assert.rejects(
    () => new BossSiteAdapter({ browser: ambiguousBrowser, sleepFn: async () => {} }).verifyCommunicationResult(expectedJob),
    (error) => error.code === "BOSS_COMMUNICATION_VERIFICATION_UNAVAILABLE"
  );

  const missingStatusBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    afterClickFixtures: new Map([[jobUrl, sentFixture({ jobStatus: undefined })]])
  });
  const missingStatusAdapter = new BossSiteAdapter({ browser: missingStatusBrowser, sleepFn: async () => {} });
  const missingStatusInspection = await missingStatusAdapter.inspectCommunicationJob(expectedJob);
  await missingStatusAdapter.dispatchCommunication(missingStatusInspection);
  assert.deepStrictEqual(
    await missingStatusAdapter.verifyCommunicationResult(expectedJob),
    { state: "ambiguous" }
  );

  for (const [bodyText, errorCode] of [
    ["\u8d26\u6237\u5b58\u5728\u5f02\u5e38\u884c\u4e3a", "BOSS_RISK_CONTROL"],
    ["\u767b\u5f55\u540e\u53ef\u67e5\u770b", "BOSS_LOGIN_REQUIRED"]
  ]) {
    const blockedBrowser = fakeBrowser({
      tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
      afterClickFixtures: new Map([[jobUrl, sentFixture({ bodyText })]])
    });
    const blockedAdapter = new BossSiteAdapter({ browser: blockedBrowser, sleepFn: async () => {} });
    const blockedInspection = await blockedAdapter.inspectCommunicationJob(expectedJob);
    await blockedAdapter.dispatchCommunication(blockedInspection);
    await assert.rejects(
      () => blockedAdapter.verifyCommunicationResult(expectedJob),
      (error) => error.code === errorCode
    );
  }

  const closedAfterClickBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    afterClickFixtures: new Map([[jobUrl, sentFixture()]])
  });
  const closedAfterClickAdapter = new BossSiteAdapter({ browser: closedAfterClickBrowser, sleepFn: async () => {} });
  const closedAfterClickInspection = await closedAfterClickAdapter.inspectCommunicationJob(expectedJob);
  await closedAfterClickAdapter.dispatchCommunication(closedAfterClickInspection);
  closedAfterClickBrowser.removeTab("communication-created");
  await assert.rejects(
    () => closedAfterClickAdapter.verifyCommunicationResult(expectedJob),
    (error) => error.code === "BOSS_COMMUNICATION_TARGET_CHANGED"
  );
  assert.strictEqual(closedAfterClickBrowser.calls.guardedClick.length, 1);

  await assert.rejects(
    () => executionAdapter.dispatchCommunication({}),
    (error) => error.code === "BOSS_COMMUNICATION_INSPECTION_INVALID"
  );
  assert.strictEqual(inspectBrowser.calls.clickAt.length, 0);
  assert.deepStrictEqual(communicationCalibrationStatus(), { status: "pending", executionEnabled: false });
  console.log("boss_communication_page_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
