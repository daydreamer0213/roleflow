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
  documentReadyState: "complete",
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
  successDialog: { visible: false, title: "", footer: "" },
  inlineChatSent: false
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

function numericBinding(overrides = {}) {
  return {
    mode: "edge",
    windowId: 1995685675,
    searchTabId: 1995685534,
    messageTabId: 1995685619,
    searchReturnUrl: searchUrl,
    searchScrollTop: 900,
    bindingGeneration: 1,
    ...overrides
  };
}

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
assert.strictEqual(
  classifyBossCommunicationSnapshot({ ...readySnapshot, jobStatus: "\u6700\u65b0" }, expectedJob).state,
  "ready",
  "BOSS uses .job-status for the 最新 freshness badge; it must not be treated as unavailable"
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

function inlineChatSentFixture(overrides = {}) {
  return {
    actions: [actionNode(continuingCommunicationLabel, { isFriend: "true" })],
    successDialog: null,
    inlineChatSent: true,
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

function snapshotContext(url, fixtures, onActionClick = () => {}, transport = null) {
  const fixture = fixtureForUrl(url, fixtures);
  let context;
  for (const action of fixture.actions || []) action.click = () => onActionClick(context);
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
  if (fixture.inlineChatSent) {
    nodes[".dialog-wrap.startchat-dialog .message-list .message-item .status.success"] = testNode({
      text: "\u5df2\u53d1\u9001",
      rect: { x: 220, y: 180, width: 42, height: 18 }
    });
  }
  if (fixture.jobStatus !== undefined) nodes[".job-status"] = testNode({ text: fixture.jobStatus });
  const document = {
    title: fixture.title || "",
    body: { innerText: fixture.bodyText || "Standalone detail fixture" },
    readyState: fixture.documentReadyState || "complete",
    querySelector(selector) { return nodes[selector] || null; },
    querySelectorAll(selector) {
      const collections = {
        ".sign-form, .login-register, [class*='login-form']": [],
        ".dialog-wrap.startchat-dialog .message-list .message-item .status.success": nodes[".dialog-wrap.startchat-dialog .message-list .message-item .status.success"]
          ? [nodes[".dialog-wrap.startchat-dialog .message-list .message-item .status.success"]]
          : []
      };
      return collections[selector] || [];
    },
    documentElement: { scrollHeight: 1440 }
  };
  context = vm.createContext({
    document,
    location: new URL(url),
    URL,
    URLSearchParams,
    innerHeight: 800,
    scrollTo(_x, y) { context.scrollY = y; },
    scrollY: 0,
    getComputedStyle(element) {
      return { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto", ...(element?.style || {}) };
    }
  });
  context.window = context;
  transport?.install(context);
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
  observerOutcomes = [],
  realObserver = false,
  transport = null,
  snapshotSequence = [],
  guardedClickGate = null,
  guardedClickStarted = null,
  guardedClickDriftUrl = "",
  createTabGate = null,
  createStarted = null
} = {}) {
  const calls = { listTabs: 0, createTab: [], bringToFront: [], navigate: [], evalValue: [], clickAt: [], guardedClick: [], restoreScroll: [] };
  let currentTabs = tabs;
  const contexts = new Map();
  const helperExpressions = new Map();
  const snapshots = [];
  const queuedObserverOutcomes = [...observerOutcomes];
  const queuedSnapshots = [...snapshotSequence];
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
      if (expression.includes("window.__bossCommunicationSnapshot = function()")) {
        helperExpressions.set(tabId, expression);
      }
      if (expression.includes("__bossGuardedCommunicationClick")) {
        calls.guardedClick.push([tabId, expression]);
        guardedClickStarted?.resolve();
        if (guardedClickGate) await guardedClickGate.promise;
        if (guardedClickDriftUrl) {
          currentTabs = currentTabs.map((tab) => tab.id === tabId ? { ...tab, url: guardedClickDriftUrl } : tab);
          contexts.delete(tabId);
        }
      }
      if (expression === "(() => window.__bossCommunicationSnapshot())()" && queuedSnapshots.length) {
        const snapshot = queuedSnapshots.shift();
        snapshots.push(snapshot);
        return snapshot;
      }
      if (!realObserver && expression.includes("window.__bossCommunicationOutcomeResult?.(")) {
        const outcome = queuedObserverOutcomes.shift() || observerOutcomes.at(-1);
        return outcome || {
          state: "accepted",
          evidence: {
            endpoints: [{ endpointKind: "friend_add", httpStatus: 200, businessCode: "0", businessCategory: "success", elapsedMs: 1 }],
            pageState: "request_accepted"
          }
        };
      }
      const tab = currentTabs.find((candidate) => candidate.id === tabId);
      if (!contexts.has(tabId)) {
        const contextUrl = tab?.url || "about:blank";
        contexts.set(tabId, snapshotContext(contextUrl, fixtures, (context) => {
          transport?.onAction?.(context);
          const nextFixture = afterClickFixtures.get(contextUrl);
          if (!realObserver) {
            if (nextFixture) fixtures.set(contextUrl, nextFixture);
            contexts.delete(tabId);
          }
        }, realObserver ? transport : null));
        const helperExpression = helperExpressions.get(tabId);
        if (helperExpression && helperExpression !== expression) {
          vm.runInContext(helperExpression, contexts.get(tabId));
        }
      }
      const result = vm.runInContext(expression, contexts.get(tabId));
      if (expression.includes("document.documentElement.scrollHeight") && result?.requested !== undefined) {
        calls.restoreScroll.push({ tabId, requested: result.requested, applied: result.applied });
      }
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
        contexts.delete(tab.id);
      }
    },
    removeTab(tabId) {
      currentTabs = currentTabs.filter((tab) => tab.id !== tabId);
      contexts.delete(tabId);
    },
    context(tabId) {
      return contexts.get(tabId) || null;
    },
    tab(tabId) {
      const tab = currentTabs.find((candidate) => candidate.id === tabId);
      return tab ? { ...tab } : null;
    }
  };
}

function responseFixture({ status = 200, body = '{"code":0}', cloneText = null } = {}) {
  return {
    status,
    clone() {
      return { text: () => cloneText || Promise.resolve(body) };
    }
  };
}

function observerTransport({ now = 0 } = {}) {
  const transport = {
    now,
    fetchPlans: [],
    xhrPlans: [],
    fetchCalls: [],
    originalFetch: null,
    originalXhr: null,
    onAction: null,
    install(context) {
      context.Date = { now: () => transport.now };
      context.fetch = (url) => {
        transport.fetchCalls.push(String(url));
        const plan = transport.fetchPlans.shift() || {};
        if (plan.reject) return Promise.reject(plan.reject);
        if (plan.pending) return plan.pending;
        return Promise.resolve(plan.response || responseFixture());
      };
      transport.originalFetch = context.fetch;
      class FakeXhr {
        constructor() {
          this.listeners = new Map();
          this.status = 0;
          this.responseText = "";
        }
        addEventListener(type, listener, options = {}) {
          const entries = this.listeners.get(type) || [];
          entries.push({ listener, once: options.once === true });
          this.listeners.set(type, entries);
        }
        emit(type) {
          const entries = this.listeners.get(type) || [];
          this.listeners.set(type, entries.filter((entry) => !entry.once));
          for (const entry of entries) entry.listener();
        }
        open(method, url) {
          this.method = method;
          this.url = url;
        }
        send() {
          const plan = transport.xhrPlans.shift() || {};
          if (plan.throw) throw plan.throw;
          if (plan.pending || plan.abort) return;
          queueMicrotask(() => {
            if (plan.reject) this.emit("error");
            else {
              this.status = plan.status ?? 200;
              this.responseText = plan.body || '{"code":0}';
            }
            this.emit("loadend");
          });
        }
        abort() {
          this.emit("abort");
          this.emit("loadend");
        }
      }
      context.XMLHttpRequest = FakeXhr;
      transport.originalXhr = FakeXhr;
    },
    fetch(context, url, plan = {}) {
      transport.fetchPlans.push(plan);
      return context.fetch(url);
    },
    xhr(context, url, plan = {}) {
      transport.xhrPlans.push(plan);
      const request = new context.XMLHttpRequest();
      request.open("POST", url);
      request.send();
      return request;
    }
  };
  return transport;
}

const trustedSuccessSnapshot = {
  ...readySnapshot,
  actions: [{ ...readySnapshot.actions[0], label: continuingCommunicationLabel, isFriend: "true" }],
  successDialog: { visible: true, title: communicationSentTitle, footer: stayOnPageLabel }
};

async function realObserverBehaviorSmoke() {
  const dispatchAndVerify = async ({ transport, snapshots = [trustedSuccessSnapshot] }) => {
    const browser = fakeBrowser({
      tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
      realObserver: true,
      transport,
      snapshotSequence: [readySnapshot, readySnapshot, readySnapshot, readySnapshot, ...snapshots]
    });
    const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
    const inspection = await adapter.inspectCommunicationJob(expectedJob);
    await adapter.dispatchCommunication(inspection);
    return { browser, adapter, result: await adapter.verifyCommunicationResult(expectedJob) };
  };

  const successTransport = observerTransport();
  successTransport.onAction = (context) => {
    successTransport.fetch(context, "https://www.zhipin.com/wapi/ignored?securityId=ignored", {
      response: responseFixture({ body: '{"code":"ignored","message":"private"}' })
    });
    successTransport.fetch(context, "https://www.zhipin.com/wapi/zpchat/config/get?chatId=private", {
      response: responseFixture({ body: '{"code":0,"message":"secret config"}' })
    });
    successTransport.fetch(context, "https://www.zhipin.com/wapi/zpgeek/friend/add.json?securityId=secret", {
      response: responseFixture({ body: '{"code":0,"message":"secret message"}' })
    });
  };
  const success = await dispatchAndVerify({ transport: successTransport });
  assert.strictEqual(success.result.state, "succeeded");
  assert.deepStrictEqual(Array.from(success.result.evidence.endpoints, (event) => event.endpointKind), ["chat_config", "friend_add"]);
  assert(!JSON.stringify(success.result).includes("securityId"));
  assert(!JSON.stringify(success.result).includes("secret message"));

  const delayedPageTransport = observerTransport();
  delayedPageTransport.onAction = (context) => delayedPageTransport.fetch(
    context,
    "https://www.zhipin.com/wapi/zpgeek/friend/add.json",
    { response: responseFixture({ body: '{"code":0}' }) }
  );
  assert.strictEqual(
    (await dispatchAndVerify({ transport: delayedPageTransport, snapshots: [readySnapshot, trustedSuccessSnapshot] })).result.state,
    "succeeded",
    "a settled friend-add result must remain available until delayed page success is observed"
  );

  const mixedTransport = observerTransport();
  mixedTransport.onAction = (context) => {
    mixedTransport.fetch(context, "https://www.zhipin.com/wapi/zpgeek/friend/add.json", {
      response: responseFixture({ body: '{"code":0}' })
    });
    mixedTransport.fetch(context, "https://www.zhipin.com/wapi/zpchat/config/get", {
      response: responseFixture({ status: 503, body: '{"code":"retry"}' })
    });
  };
  assert.strictEqual((await dispatchAndVerify({ transport: mixedTransport })).result.state, "ambiguous");

  const cloneGate = deferred();
  const timingTransport = observerTransport();
  let appReceivedResponse = false;
  timingTransport.onAction = (context) => {
    timingTransport.fetch(context, "https://www.zhipin.com/wapi/zpgeek/friend/add.json", {
      response: responseFixture({ cloneText: cloneGate.promise })
    }).then(() => { appReceivedResponse = true; });
  };
  const timingBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    realObserver: true,
    transport: timingTransport,
    snapshotSequence: [readySnapshot, readySnapshot, readySnapshot, readySnapshot, trustedSuccessSnapshot]
  });
  const timingAdapter = new BossSiteAdapter({ browser: timingBrowser, sleepFn: async () => {} });
  const timingInspection = await timingAdapter.inspectCommunicationJob(expectedJob);
  await timingAdapter.dispatchCommunication(timingInspection);
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(appReceivedResponse, true, "observer must not delay the page fetch response while clone text is pending");
  cloneGate.resolve('{"code":0}');
  assert.strictEqual((await timingAdapter.verifyCommunicationResult(expectedJob)).state, "succeeded");

  const abortTransport = observerTransport();
  abortTransport.onAction = (context) => abortTransport.xhr(
    context,
    "https://www.zhipin.com/wapi/zpgeek/friend/add.json",
    { abort: true }
  ).abort();
  assert.strictEqual((await dispatchAndVerify({ transport: abortTransport, snapshots: [readySnapshot] })).result.state, "transport_failed");

  const nativeSendError = new Error("native xhr send failed");
  const throwingTransport = observerTransport();
  let pageCaughtNativeSend = null;
  throwingTransport.onAction = (context) => {
    try {
      throwingTransport.xhr(context, "https://www.zhipin.com/wapi/zpgeek/friend/add.json", { throw: nativeSendError });
    } catch (error) {
      pageCaughtNativeSend = error;
    }
  };
  const throwing = await dispatchAndVerify({ transport: throwingTransport, snapshots: [readySnapshot] });
  assert.strictEqual(pageCaughtNativeSend, nativeSendError, "observer must preserve the page native send throw");
  assert.strictEqual(throwing.result.state, "transport_failed");
  assert.strictEqual(throwing.result.evidence.endpoints[0].businessCategory, "network_rejected");
  const throwingContext = throwing.browser.context("communication-created");
  assert.strictEqual(throwingContext.fetch, throwingTransport.originalFetch, "terminal transport failure must clean up interception");
  assert.strictEqual(throwingContext.__bossCommunicationOutcomeObserver, undefined, "terminal transport failure must clear observer global");
  const throwingRearmed = vm.runInContext("window.__bossRegisterCommunicationOutcomeObserver()", throwingContext);
  assert.strictEqual(throwingRearmed.closed, false, "observer must re-arm after synchronous native send failure");
  vm.runInContext("window.__bossCloseCommunicationOutcomeObserver()", throwingContext);

  const timeoutTransport = observerTransport({ now: 0 });
  timeoutTransport.onAction = (context) => {
    timeoutTransport.fetch(context, "https://www.zhipin.com/wapi/zpgeek/friend/add.json", { pending: new Promise(() => {}) });
    timeoutTransport.now = 15_001;
  };
  assert.strictEqual((await dispatchAndVerify({ transport: timeoutTransport, snapshots: [readySnapshot] })).result.evidence.pageState, "observer_timeout");

  const noMatchTransport = observerTransport();
  assert.strictEqual((await dispatchAndVerify({ transport: noMatchTransport, snapshots: [readySnapshot] })).result.evidence.pageState, "no_matching_request");

  const cleanupTransport = observerTransport();
  cleanupTransport.onAction = (context) => cleanupTransport.fetch(
    context,
    "https://www.zhipin.com/wapi/zpgeek/friend/add.json",
    { pending: new Promise(() => {}) }
  );
  const cleanupBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    realObserver: true,
    transport: cleanupTransport,
    snapshotSequence: [readySnapshot, readySnapshot, readySnapshot, readySnapshot, { ...readySnapshot, risk: true }]
  });
  const cleanupAdapter = new BossSiteAdapter({ browser: cleanupBrowser, sleepFn: async () => {} });
  const cleanupInspection = await cleanupAdapter.inspectCommunicationJob(expectedJob);
  await cleanupAdapter.dispatchCommunication(cleanupInspection);
  await assert.rejects(() => cleanupAdapter.verifyCommunicationResult(expectedJob), (error) => error.code === "BOSS_RISK_CONTROL");
  const cleanupContext = cleanupBrowser.context("communication-created");
  assert.strictEqual(cleanupContext.fetch, cleanupTransport.originalFetch, "exceptional verification exit must restore fetch");
  assert.strictEqual(cleanupContext.__bossCommunicationOutcomeObserver, undefined, "closed observer must clear its own global");
  const rearmed = vm.runInContext("window.__bossRegisterCommunicationOutcomeObserver()", cleanupContext);
  assert.strictEqual(rearmed.closed, false, "a closed observer must be replaceable");
  assert.notStrictEqual(cleanupContext.fetch, cleanupTransport.originalFetch, "replacement observer must re-arm interception");
  vm.runInContext("window.__bossCloseCommunicationOutcomeObserver()", cleanupContext);
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
  assert.deepStrictEqual(existingBrowser.calls.bringToFront, []);

  const boundBrowser = fakeBrowser({
    tabs: [
      { id: 1995685534, url: searchUrl, windowId: 1995685675 },
      { id: 1995685619, url: "https://www.zhipin.com/web/geek/chat", windowId: 1995685675 }
    ]
  });
  const boundAdapter = new BossSiteAdapter({ browser: boundBrowser, sleepFn: async () => {} });
  boundAdapter.bindCommunicationTabs(numericBinding());
  await boundAdapter.beginCommunicationSession();
  assert.strictEqual(await boundAdapter.prepareCommunicationTab(1995685534), 1995685534);
  assert.strictEqual((await boundAdapter.inspectCommunicationJob(expectedJob)).state, "ready");
  assert.strictEqual((await boundAdapter.inspectCommunicationJob(secondJob)).state, "ready");
  await boundAdapter.restoreCommunicationSearchPage();
  await boundAdapter.restoreCommunicationSearchPage();
  assert.deepStrictEqual(boundBrowser.calls.createTab, []);
  assert.deepStrictEqual(boundBrowser.calls.navigate, [
    [1995685534, jobUrl],
    [1995685534, secondJobUrl],
    [1995685534, searchUrl]
  ]);
  assert.strictEqual(boundBrowser.tab(1995685619).url, "https://www.zhipin.com/web/geek/chat");
  assert.deepStrictEqual(boundBrowser.calls.restoreScroll, [{
    tabId: 1995685534,
    requested: 900,
    applied: 640
  }]);
  assert.throws(
    () => new BossSiteAdapter({ browser: boundBrowser, sleepFn: async () => {} }).bindCommunicationTabs(
      numericBinding({ searchTabId: "1995685534" })
    ),
    (error) => error.code === "BOSS_COMMUNICATION_BINDING_REQUIRED"
  );
  boundBrowser.removeTab(1995685619);
  await assert.rejects(
    () => boundAdapter.prepareCommunicationTab(1995685534),
    (error) => error.code === "BOSS_OPERATOR_TABS_CHANGED"
  );
  assert.deepStrictEqual(boundBrowser.calls.createTab, []);

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
      && /重新运行 Start\.bat/.test(error.message)
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
      && /重新运行 Start\.bat/.test(error.message)
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
      && /重新运行 Start\.bat/.test(error.message)
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
  assert.deepStrictEqual(inspectBrowser.calls.bringToFront, []);
  assert.strictEqual(inspectBrowser.calls.clickAt.length, 0);
  assert(inspectBrowser.calls.evalValue.some(([, expression]) => expression.includes("window.__bossCommunicationSnapshot = function()")));
  const snapshot = JSON.parse(JSON.stringify(inspectBrowser.snapshots[0]));
  assert.deepStrictEqual(snapshot, readySnapshot);
  assert.deepStrictEqual(Object.keys(snapshot).sort(), [
    "actions", "bossActiveText", "company", "documentReadyState", "inlineChatSent", "jobId", "jobStatus", "login", "pageReady", "risk", "salary", "successDialog", "title", "url"
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

  const observedSuccessBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    afterClickFixtures: new Map([[jobUrl, sentFixture()]]),
    observerOutcomes: [{
      state: "accepted",
      evidence: {
        endpoints: [{
          endpointKind: "friend_add",
          httpStatus: 200,
          businessCode: "0",
          businessCategory: "success",
          elapsedMs: 291,
          url: `${jobUrl}?securityId=fixture-security&chatId=private-chat`,
          responseBody: "private message body"
        }],
        pageState: "request_accepted",
        securityId: "fixture-security"
      }
    }]
  });
  const observedSuccessAdapter = new BossSiteAdapter({ browser: observedSuccessBrowser, sleepFn: async () => {} });
  const observedSuccessInspection = await observedSuccessAdapter.inspectCommunicationJob(expectedJob);
  await observedSuccessAdapter.dispatchCommunication(observedSuccessInspection);
  const observedSuccess = await observedSuccessAdapter.verifyCommunicationResult(expectedJob);
  assert.deepStrictEqual(observedSuccess, {
    state: "succeeded",
    jobId: "fake123",
    evidence: {
      endpoints: [{ endpointKind: "friend_add", httpStatus: 200, businessCode: "0", businessCategory: "success", elapsedMs: 291 }],
      pageState: "succeeded"
    }
  });
  assert(!JSON.stringify(observedSuccess).includes("fixture-security"));
  assert(!JSON.stringify(observedSuccess).includes("private message body"));
  assert(observedSuccessBrowser.calls.guardedClick[0][1].includes("__bossRegisterCommunicationOutcomeObserver"));

  for (const [name, observerOutcome, expectedState, expectedPageState] of [
    ["HTTP failure", {
      state: "platform_rejected",
      evidence: { endpoints: [{ endpointKind: "friend_add", httpStatus: 503, businessCategory: "http_failure", elapsedMs: 91 }] }
    }, "platform_rejected"],
    ["network rejection", {
      state: "transport_failed",
      evidence: { endpoints: [{ endpointKind: "friend_add", businessCategory: "network_rejected", elapsedMs: 17 }] }
    }, "transport_failed"],
    ["non-zero BOSS business result", {
      state: "platform_rejected",
      evidence: { endpoints: [{ endpointKind: "friend_add", httpStatus: 200, businessCode: "10003", businessCategory: "business_rejected", elapsedMs: 44 }] }
    }, "platform_rejected"],
    ["observer timeout", { state: "timeout", evidence: { pageState: "observer_timeout" } }, "ambiguous", "observer_timeout"],
    ["no matching request", { state: "no_matching_request", evidence: { pageState: "no_matching_request" } }, "ambiguous", "no_matching_request"]
  ]) {
    const browser = fakeBrowser({
      tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
      observerOutcomes: [observerOutcome]
    });
    const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
    const inspected = await adapter.inspectCommunicationJob(expectedJob);
    await adapter.dispatchCommunication(inspected);
    const result = await adapter.verifyCommunicationResult(expectedJob);
    assert.strictEqual(result.state, expectedState, name);
    if (expectedPageState) assert.strictEqual(result.evidence?.pageState, expectedPageState, name);
    assert(!JSON.stringify(result).includes("securityId"), `${name} must keep evidence sanitized`);
  }

  const unstableReadinessBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    snapshotSequence: [
      readySnapshot,
      readySnapshot,
      readySnapshot,
      { ...readySnapshot, login: true }
    ]
  });
  const unstableReadinessAdapter = new BossSiteAdapter({ browser: unstableReadinessBrowser, sleepFn: async () => {} });
  const unstableReadinessInspection = await unstableReadinessAdapter.inspectCommunicationJob(expectedJob);
  await assert.rejects(
    () => unstableReadinessAdapter.dispatchCommunication(unstableReadinessInspection),
    (error) => error.code === "BOSS_LOGIN_REQUIRED"
  );
  assert.strictEqual(unstableReadinessBrowser.calls.guardedClick.length, 0, "unstable fixed-tab readiness must stop before click");

  const inlineChatBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    afterClickFixtures: new Map([[jobUrl, inlineChatSentFixture()]])
  });
  const inlineChatAdapter = new BossSiteAdapter({ browser: inlineChatBrowser, sleepFn: async () => {} });
  const inlineChatInspection = await inlineChatAdapter.inspectCommunicationJob(expectedJob);
  await inlineChatAdapter.dispatchCommunication(inlineChatInspection);
  assert.strictEqual((await inlineChatAdapter.verifyCommunicationResult(expectedJob)).state, "succeeded");
  const inlineChatSnapshot = JSON.parse(JSON.stringify(inlineChatBrowser.snapshots.at(-1)));
  assert.strictEqual(inlineChatSnapshot.successDialog.visible, false);
  assert.strictEqual(inlineChatSnapshot.inlineChatSent, true);

  const latestStatusBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    fixtures: new Map([[jobUrl, { jobStatus: "\u6700\u65b0" }]]),
    afterClickFixtures: new Map([[jobUrl, inlineChatSentFixture({ jobStatus: "\u6700\u65b0" })]])
  });
  const latestStatusAdapter = new BossSiteAdapter({ browser: latestStatusBrowser, sleepFn: async () => {} });
  const latestStatusInspection = await latestStatusAdapter.inspectCommunicationJob(expectedJob);
  assert.strictEqual(latestStatusInspection.state, "ready");
  assert.deepStrictEqual(
    await latestStatusAdapter.dispatchCommunication(latestStatusInspection),
    { state: "dispatched", jobId: "fake123" }
  );
  assert.strictEqual((await latestStatusAdapter.verifyCommunicationResult(expectedJob)).state, "succeeded");

  assert.deepStrictEqual(
    classifyBossCommunicationSnapshot({ ...readySnapshot, documentReadyState: "loading" }, expectedJob),
    { state: "loading" },
    "a partially loaded detail page must not become clickable"
  );

  const slowReadyBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    fixtures: new Map([[jobUrl, { documentReadyState: "loading" }]])
  });
  let slowReadySleeps = 0;
  const slowReadyAdapter = new BossSiteAdapter({
    browser: slowReadyBrowser,
    sleepFn: async () => {
      slowReadySleeps += 1;
      if (slowReadySleeps === 3) slowReadyBrowser.setFixture(jobUrl, { documentReadyState: "complete" });
    }
  });
  assert.strictEqual((await slowReadyAdapter.inspectCommunicationJob(expectedJob)).state, "ready");
  assert(
    slowReadySleeps >= 3,
    "inspection must keep waiting until the standalone detail page finishes loading"
  );

  const settledWithoutActionBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    fixtures: new Map([[jobUrl, { actions: [] }]])
  });
  let settledWithoutActionSleeps = 0;
  const settledWithoutActionAdapter = new BossSiteAdapter({
    browser: settledWithoutActionBrowser,
    sleepFn: async () => { settledWithoutActionSleeps += 1; }
  });
  assert.strictEqual(
    (await settledWithoutActionAdapter.inspectCommunicationJob(expectedJob)).state,
    "action_unavailable"
  );
  assert(
    settledWithoutActionSleeps <= 5,
    "a fully loaded page with no communication action must not consume the long loading-page wait window"
  );

  const loadingBeforeClickBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }]
  });
  const loadingBeforeClickAdapter = new BossSiteAdapter({ browser: loadingBeforeClickBrowser, sleepFn: async () => {} });
  const loadingBeforeClickInspection = await loadingBeforeClickAdapter.inspectCommunicationJob(expectedJob);
  loadingBeforeClickBrowser.setFixture(jobUrl, { documentReadyState: "loading" });
  await assert.rejects(
    () => loadingBeforeClickAdapter.dispatchCommunication(loadingBeforeClickInspection),
    (error) => error?.code === "BOSS_COMMUNICATION_READINESS_TIMEOUT"
  );
  assert.strictEqual(loadingBeforeClickBrowser.calls.guardedClick.length, 0, "readiness timeout must stop before click");

  const delayedSuccessBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }]
  });
  let delayedSuccessSleeps = 0;
  const delayedSuccessAdapter = new BossSiteAdapter({
    browser: delayedSuccessBrowser,
    sleepFn: async () => {
      if (delayedSuccessBrowser.calls.guardedClick.length === 0) return;
      delayedSuccessSleeps += 1;
      if (delayedSuccessSleeps === 5) delayedSuccessBrowser.setFixture(jobUrl, inlineChatSentFixture());
    }
  });
  const delayedSuccessInspection = await delayedSuccessAdapter.inspectCommunicationJob(expectedJob);
  await delayedSuccessAdapter.dispatchCommunication(delayedSuccessInspection);
  assert.strictEqual(
    (await delayedSuccessAdapter.verifyCommunicationResult(expectedJob)).state,
    "succeeded",
    "verification must tolerate a success state that appears after the legacy four-poll window"
  );
  assert(delayedSuccessSleeps >= 5);

  for (const [description, action] of [
    ["friend state is not confirmed", actionNode(continuingCommunicationLabel, { isFriend: "false" })],
    ["redirect target changed", actionNode(continuingCommunicationLabel, { isFriend: "true", redirectJobId: "other" })],
    ["chat identity is absent", actionNode(continuingCommunicationLabel, { isFriend: "true", hasChatIdentity: false })]
  ]) {
    const untrustedInlineChatBrowser = fakeBrowser({
      tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
      afterClickFixtures: new Map([[jobUrl, inlineChatSentFixture({ actions: [action] })]])
    });
    const untrustedInlineChatAdapter = new BossSiteAdapter({ browser: untrustedInlineChatBrowser, sleepFn: async () => {} });
    const untrustedInlineChatInspection = await untrustedInlineChatAdapter.inspectCommunicationJob(expectedJob);
    await untrustedInlineChatAdapter.dispatchCommunication(untrustedInlineChatInspection);
    assert.strictEqual((await untrustedInlineChatAdapter.verifyCommunicationResult(expectedJob)).state, "ambiguous", description);
  }
  assert.strictEqual(executionBrowser.calls.guardedClick[0][0], "communication-created");
  assert.match(executionBrowser.calls.guardedClick[0][1], /__bossGuardedCommunicationClick/);
  assert.match(executionBrowser.calls.guardedClick[0][1], /fake123/);
  assert.strictEqual((await executionAdapter.verifyCommunicationResult(expectedJob)).state, "succeeded");
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

  const continuedWithoutSuccessEvidenceBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    afterClickFixtures: new Map([[jobUrl, sentFixture({ successDialog: null })]])
  });
  const continuedWithoutSuccessEvidenceAdapter = new BossSiteAdapter({ browser: continuedWithoutSuccessEvidenceBrowser, sleepFn: async () => {} });
  const ambiguousInspection = await continuedWithoutSuccessEvidenceAdapter.inspectCommunicationJob(expectedJob);
  await continuedWithoutSuccessEvidenceAdapter.dispatchCommunication(ambiguousInspection);
  assert.strictEqual((await continuedWithoutSuccessEvidenceAdapter.verifyCommunicationResult(expectedJob)).state, "ambiguous");
  assert.strictEqual(continuedWithoutSuccessEvidenceBrowser.snapshots.length, 44);
  await assert.rejects(
    () => new BossSiteAdapter({ browser: continuedWithoutSuccessEvidenceBrowser, sleepFn: async () => {} }).verifyCommunicationResult(expectedJob),
    (error) => error.code === "BOSS_COMMUNICATION_VERIFICATION_UNAVAILABLE"
  );

  const missingStatusBrowser = fakeBrowser({
    tabs: [{ id: "search", url: searchUrl, windowId: "window-1" }],
    afterClickFixtures: new Map([[jobUrl, sentFixture({ jobStatus: undefined })]])
  });
  const missingStatusAdapter = new BossSiteAdapter({ browser: missingStatusBrowser, sleepFn: async () => {} });
  const missingStatusInspection = await missingStatusAdapter.inspectCommunicationJob(expectedJob);
  await missingStatusAdapter.dispatchCommunication(missingStatusInspection);
  assert.strictEqual((await missingStatusAdapter.verifyCommunicationResult(expectedJob)).state, "ambiguous");

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
  await realObserverBehaviorSmoke();
  assert.strictEqual(inspectBrowser.calls.clickAt.length, 0);
  assert.deepStrictEqual(communicationCalibrationStatus(), {
    implementation: "implemented",
    calibration: "calibrated",
    acceptance: "e2e_pending",
    executionEnabled: true
  });
  console.log("boss_communication_page_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
