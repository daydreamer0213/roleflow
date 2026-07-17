const assert = require("node:assert");
const { BossSiteAdapter } = require("../src/adapters/sites/boss");

const JOB = {
  sourceId: "boss:abc123",
  url: "https://www.zhipin.com/job_detail/abc123.html?ka=search_list",
  title: "AI \u5e94\u7528\u5f00\u53d1\u5de5\u7a0b\u5e08",
  company: "\u793a\u4f8b\u516c\u53f8"
};

async function main() {
  await tabPreparationSmoke();
  await inspectionStatesSmoke();
  await protectiveStateSmoke();
  await dispatchAndVerificationSmoke();
}

async function tabPreparationSmoke() {
  const reusable = new FakeBrowser({ tabs: [searchTab(), detailTab()] });
  const reusableAdapter = makeAdapter(reusable);
  assert.strictEqual(await reusableAdapter.prepareCommunicationTab("search-tab"), "detail-tab");
  assert.deepStrictEqual(reusable.createdTabs, []);
  assert.deepStrictEqual(reusable.frontedTabs, ["detail-tab"]);

  const created = new FakeBrowser({ tabs: [searchTab()] });
  const createdAdapter = makeAdapter(created);
  assert.strictEqual(await createdAdapter.prepareCommunicationTab("search-tab"), "action-tab");
  assert.deepStrictEqual(created.createdTabs, [{ openerTabId: "search-tab", url: "about:blank" }]);
  assert.deepStrictEqual(created.frontedTabs, ["action-tab"]);
  assert.strictEqual(created.closedTabs.length, 0, "the search tab must remain open");
}

async function inspectionStatesSmoke() {
  const ready = makeAdapter(new FakeBrowser({ communication: communicationState() }));
  assert.deepStrictEqual(await ready.inspectCommunicationJob("action-tab", JOB), {
    state: "ready",
    jobId: "abc123",
    title: JOB.title,
    company: JOB.company,
    actionLabel: "\u7acb\u5373\u6c9f\u901a",
    clickPoint: { x: 500, y: 120 }
  });

  const already = makeAdapter(new FakeBrowser({ communication: communicationState({ actionLabel: "\u7ee7\u7eed\u6c9f\u901a" }) }));
  assert.deepStrictEqual(await already.inspectCommunicationJob("action-tab", JOB), {
    state: "already_communicated",
    jobId: "abc123",
    title: JOB.title,
    company: JOB.company
  });

  const unavailable = makeAdapter(new FakeBrowser({ communication: communicationState({ unavailableText: "\u804c\u4f4d\u5df2\u4e0b\u67b6" }) }));
  assert.deepStrictEqual(await unavailable.inspectCommunicationJob("action-tab", JOB), {
    state: "job_unavailable",
    jobId: "abc123",
    title: JOB.title,
    company: JOB.company
  });

  const mismatch = makeAdapter(new FakeBrowser({ communication: communicationState({ title: "\u5176\u4ed6\u5c97\u4f4d" }) }));
  assert.deepStrictEqual(await mismatch.inspectCommunicationJob("action-tab", JOB), {
    state: "target_mismatch",
    jobId: "abc123",
    title: "\u5176\u4ed6\u5c97\u4f4d",
    company: JOB.company
  });

  const unavailableAction = makeAdapter(new FakeBrowser({ communication: communicationState({ candidateCount: 0, actionLabel: "" }) }));
  assert.deepStrictEqual(await unavailableAction.inspectCommunicationJob("action-tab", JOB), {
    state: "action_unavailable",
    jobId: "abc123",
    title: JOB.title,
    company: JOB.company
  });

  const duplicateAction = makeAdapter(new FakeBrowser({ communication: communicationState({ candidateCount: 2 }) }));
  assert.deepStrictEqual(await duplicateAction.inspectCommunicationJob("action-tab", JOB), {
    state: "action_unavailable",
    jobId: "abc123",
    title: JOB.title,
    company: JOB.company
  });
}

async function protectiveStateSmoke() {
  const risk = makeAdapter(new FakeBrowser({ page: { isRiskPage: true } }));
  await rejectsWithCode(() => risk.inspectCommunicationJob("action-tab", JOB), "BOSS_RISK_CONTROL");

  const login = makeAdapter(new FakeBrowser({ page: { isLoginPage: true } }));
  await rejectsWithCode(() => login.inspectCommunicationJob("action-tab", JOB), "BOSS_LOGIN_REQUIRED");
}

async function dispatchAndVerificationSmoke() {
  const browser = new FakeBrowser({
    communication: communicationState(),
    verification: [communicationState({ actionLabel: "\u5df2\u6c9f\u901a" })]
  });
  const adapter = makeAdapter(browser);
  const inspection = await adapter.inspectCommunicationJob("action-tab", JOB);
  await adapter.dispatchCommunication("action-tab", inspection);
  assert.deepStrictEqual(browser.clicks, [{ tabId: "action-tab", point: { x: 500, y: 120 } }]);
  assert.deepStrictEqual(await adapter.verifyCommunicationResult("action-tab", JOB), {
    state: "succeeded",
    evidence: "already_communicated"
  });
  assert.strictEqual(browser.navigations.length, 1, "verification must not reload the detail page");

  const chatBrowser = new FakeBrowser({
    communication: communicationState(),
    verification: [communicationState({ chatJobId: "abc123" })]
  });
  const chatAdapter = makeAdapter(chatBrowser);
  await chatAdapter.dispatchCommunication("action-tab", await chatAdapter.inspectCommunicationJob("action-tab", JOB));
  assert.deepStrictEqual(await chatAdapter.verifyCommunicationResult("action-tab", JOB), {
    state: "succeeded",
    evidence: "chat_surface"
  });

  const ambiguousBrowser = new FakeBrowser({
    communication: communicationState(),
    verification: Array.from({ length: 5 }, () => communicationState())
  });
  const ambiguous = makeAdapter(ambiguousBrowser);
  await ambiguous.dispatchCommunication("action-tab", await ambiguous.inspectCommunicationJob("action-tab", JOB));
  ambiguousBrowser.communicationReads = 0;
  assert.deepStrictEqual(await ambiguous.verifyCommunicationResult("action-tab", JOB), {
    state: "ambiguous"
  });
  assert.strictEqual(ambiguousBrowser.communicationReads, 4, "verification may poll at most four times");
}

function makeAdapter(browser) {
  return new BossSiteAdapter({ browser, sleepFn: async () => {} });
}

function searchTab() {
  return { id: "search-tab", active: true, url: "https://www.zhipin.com/web/geek/jobs", title: "BOSS\u76f4\u8058" };
}

function detailTab() {
  return { id: "detail-tab", active: false, url: "https://www.zhipin.com/job_detail/other.html", title: "BOSS\u76f4\u8058" };
}

function communicationState(overrides = {}) {
  return {
    currentJobId: "abc123",
    title: JOB.title,
    company: JOB.company,
    unavailableText: "",
    candidateCount: 1,
    actionLabel: "\u7acb\u5373\u6c9f\u901a",
    clickPoint: { x: 500, y: 120 },
    chatJobId: "",
    ...overrides
  };
}

class FakeBrowser {
  constructor({ tabs = [searchTab(), { id: "action-tab", active: false, url: "about:blank", title: "" }], communication = communicationState(), verification = [], page = {} } = {}) {
    this.tabs = tabs;
    this.communication = communication;
    this.verification = [...verification];
    this.page = page;
    this.createdTabs = [];
    this.frontedTabs = [];
    this.closedTabs = [];
    this.navigations = [];
    this.clicks = [];
    this.communicationReads = 0;
  }

  async listTabs() {
    return this.tabs;
  }

  async createTab(openerTabId, url) {
    this.createdTabs.push({ openerTabId, url });
    this.tabs.push({ id: "action-tab", active: false, url, title: "" });
    return "action-tab";
  }

  async bringToFront(tabId) {
    this.frontedTabs.push(tabId);
  }

  async navigate(tabId, url) {
    this.navigations.push({ tabId, url });
    const tab = this.tabs.find((item) => item.id === tabId);
    if (tab) tab.url = url;
  }

  async clickAt(tabId, point) {
    this.clicks.push({ tabId, point });
  }

  async evalValue(_tabId, script) {
    if (script.includes("window.__bossCommunicationState()")) {
      this.communicationReads += 1;
      return this.clicks.length ? (this.verification.shift() || this.communication) : this.communication;
    }
    if (script.includes("isSearchPage:")) {
      return {
        path: "/web/geek/jobs",
        title: "BOSS\u76f4\u8058",
        isRiskPage: Boolean(this.page.isRiskPage),
        isLoginPage: Boolean(this.page.isLoginPage),
        isSearchPage: true
      };
    }
    if (script.includes("jobId: (location.pathname.match")) {
      return {
        path: "/job_detail/abc123.html",
        title: "BOSS\u76f4\u8058",
        isRiskPage: Boolean(this.page.isRiskPage),
        isLoginPage: Boolean(this.page.isLoginPage),
        jobId: "abc123"
      };
    }
    return true;
  }
}

async function rejectsWithCode(action, code) {
  await assert.rejects(action, (error) => error?.code === code);
}

main()
  .then(() => console.log("boss_communication_action_smoke ok"))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
