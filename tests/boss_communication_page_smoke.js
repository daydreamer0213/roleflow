const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
  BossSiteAdapter,
  classifyBossCommunicationSnapshot
} = require("../src/adapters/sites/boss");
const { communicationCalibrationStatus } = require("../src/core/communication_calibration");

const jobUrl = "https://www.zhipin.com/job_detail/fake123.html";
const secondJobUrl = "https://www.zhipin.com/job_detail/fake456.html";
const communicationLabel = "\u7acb\u5373\u6c9f\u901a";
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

assert.strictEqual(
  classifyBossCommunicationSnapshot({ ...readySnapshot, jobId: "other" }, expectedJob).state,
  "target_mismatch"
);
assert.strictEqual(
  classifyBossCommunicationSnapshot({ ...readySnapshot, url: secondJobUrl }, expectedJob).state,
  "target_mismatch"
);
assert.strictEqual(
  classifyBossCommunicationSnapshot({ ...readySnapshot, url: "https://www.zhipin.com/job_detail/.html" }, expectedJob).state,
  "target_mismatch"
);
assert.strictEqual(
  classifyBossCommunicationSnapshot({ ...readySnapshot, title: "Java\u5f00\u53d1\u5de5\u7a0b\u5e08" }, expectedJob).state,
  "target_mismatch"
);
assert.strictEqual(
  classifyBossCommunicationSnapshot({ ...readySnapshot, company: "\u53e6\u4e00\u5bb6\u516c\u53f8" }, expectedJob).state,
  "target_mismatch"
);
assert.strictEqual(
  classifyBossCommunicationSnapshot(
    { ...readySnapshot, company: "\u5e7f\u5dde\u661f\u6cb3\u667a\u80fd\u79d1\u6280\u6709\u9650\u516c\u53f8" },
    { ...expectedJob, company: "\u661f\u6cb3\u667a\u80fd" }
  ).state,
  "ready"
);
assert.strictEqual(
  classifyBossCommunicationSnapshot(
    { ...readySnapshot, company: "\u661f\u6cb3\u667a\u80fd" },
    { ...expectedJob, company: "\u5e7f\u5dde\u661f\u6cb3\u667a\u80fd\u79d1\u6280\u6709\u9650\u516c\u53f8" }
  ).state,
  "ready"
);
assert.strictEqual(
  classifyBossCommunicationSnapshot({ ...readySnapshot, jobStatus: "\u505c\u6b62\u62db\u8058", actions: [] }, expectedJob).state,
  "job_unavailable"
);
assert.strictEqual(
  classifyBossCommunicationSnapshot({ ...readySnapshot, actions: [] }, expectedJob).state,
  "action_unavailable"
);
assert.strictEqual(
  classifyBossCommunicationSnapshot({
    ...readySnapshot,
    actions: [
      { ...readySnapshot.actions[0] },
      { ...readySnapshot.actions[0] }
    ]
  }, expectedJob).state,
  "action_unavailable"
);
function without(snapshot, field) {
  const copy = { ...snapshot };
  delete copy[field];
  return copy;
}
for (const [snapshot, expectedState] of [
  [{ ...readySnapshot, pageReady: false }, "action_unavailable"],
  [without(readySnapshot, "jobId"), "target_mismatch"],
  [without(readySnapshot, "title"), "target_mismatch"],
  [without(readySnapshot, "company"), "target_mismatch"],
  [{ ...readySnapshot, actions: [{ ...readySnapshot.actions[0], label: "\u6536\u85cf" }] }, "action_unavailable"],
  [{ ...readySnapshot, actions: [{ ...readySnapshot.actions[0], visible: false }] }, "action_unavailable"],
  [{ ...readySnapshot, actions: [{ ...readySnapshot.actions[0], disabled: true }] }, "action_unavailable"]
]) {
  assert.strictEqual(classifyBossCommunicationSnapshot(snapshot, expectedJob).state, expectedState);
}
assert.throws(
  () => classifyBossCommunicationSnapshot({ ...readySnapshot, risk: true }, expectedJob),
  (error) => error.code === "BOSS_RISK_CONTROL"
);
assert.throws(
  () => classifyBossCommunicationSnapshot({ ...readySnapshot, login: true }, expectedJob),
  (error) => error.code === "BOSS_LOGIN_REQUIRED"
);

function snapshotContext(url) {
  const job = url === secondJobUrl ? secondJob : expectedJob;
  const action = testNode({ text: communicationLabel, rect: { x: 320, y: 120, width: 150, height: 45 } });
  const actionRoot = testNode({ actions: [action] });
  const header = testNode({ children: { ".job-op": actionRoot } });
  const nodes = {
    ".job-primary.detail-box": header,
    ".job-primary": header,
    ".job-primary h1": testNode({ text: job.title }),
    ".job-primary .salary": testNode({ text: readySnapshot.salary }),
    ".job-status": testNode({ text: readySnapshot.jobStatus }),
    ".sider-company .company-info": testNode({ text: job.company }),
    ".job-boss-info .boss-active-time": testNode({ text: readySnapshot.bossActiveText })
  };
  const document = {
    title: "",
    body: { innerText: "Standalone detail fixture" },
    querySelector(selector) { return nodes[selector] || null; },
    querySelectorAll() { return []; }
  };
  const context = vm.createContext({
    document,
    location: new URL(url),
    URLSearchParams,
    getComputedStyle() {
      return { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto" };
    }
  });
  context.window = context;
  return context;
}

function testNode({ text = "", rect = { x: 0, y: 0, width: 0, height: 0 }, actions = [], children = {} } = {}) {
  return {
    innerText: text,
    textContent: text,
    disabled: false,
    classList: { contains() { return false; } },
    getAttribute() { return null; },
    getBoundingClientRect() { return rect; },
    matches() { return false; },
    querySelector(selector) { return children[selector] || null; },
    querySelectorAll() { return actions; }
  };
}

function fakeBrowser({ tabs } = {}) {
  const calls = { listTabs: 0, createTab: [], bringToFront: [], navigate: [], evalValue: [], clickAt: [] };
  let currentTabs = tabs || [];
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
      const id = "communication-created";
      currentTabs = [...currentTabs, { id, url }];
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
      if (!contexts.has(tabId)) contexts.set(tabId, snapshotContext(tab?.url || "about:blank"));
      const result = vm.runInContext(expression, contexts.get(tabId));
      if (expression === "(() => window.__bossCommunicationSnapshot())()") snapshots.push(result);
      return result;
    },
    async clickAt(tabId, x, y) { calls.clickAt.push([tabId, x, y]); },
    setTabUrl(tabId, url) {
      currentTabs = currentTabs.map((tab) => tab.id === tabId ? { ...tab, url } : tab);
      contexts.delete(tabId);
    }
  };
}

(async () => {
  const existingBrowser = fakeBrowser({
    tabs: [
      { id: "search", url: "https://www.zhipin.com/web/geek/jobs?query=fake" },
      { id: "detail", url: jobUrl }
    ]
  });
  const existingAdapter = new BossSiteAdapter({ browser: existingBrowser, sleepFn: async () => {} });
  assert.strictEqual(await existingAdapter.prepareCommunicationTab("search"), "detail");
  assert.deepStrictEqual(existingBrowser.calls.createTab, []);
  assert.strictEqual(await existingAdapter.prepareCommunicationTab("search"), "detail");
  assert.deepStrictEqual(existingBrowser.calls.createTab, []);
  existingBrowser.setTabUrl("detail", "https://www.zhipin.com/web/geek/jobs?query=fake");
  const callsBeforeLostTab = {
    createTab: existingBrowser.calls.createTab.length,
    navigate: existingBrowser.calls.navigate.length,
    clickAt: existingBrowser.calls.clickAt.length
  };
  await assert.rejects(
    () => existingAdapter.prepareCommunicationTab("search"),
    (error) => error.code === "BOSS_DETAIL_PAGE_LOST"
  );
  assert.strictEqual(existingBrowser.calls.createTab.length, callsBeforeLostTab.createTab);
  assert.strictEqual(existingBrowser.calls.navigate.length, callsBeforeLostTab.navigate);
  assert.strictEqual(existingBrowser.calls.clickAt.length, callsBeforeLostTab.clickAt);
  assert.deepStrictEqual(existingBrowser.calls.bringToFront, ["detail", "detail"]);

  const createdBrowser = fakeBrowser({
    tabs: [{ id: "search", url: "https://www.zhipin.com/web/geek/jobs?query=fake" }]
  });
  const createdAdapter = new BossSiteAdapter({ browser: createdBrowser, sleepFn: async () => {} });
  assert.strictEqual(await createdAdapter.prepareCommunicationTab("search"), "communication-created");
  assert.deepStrictEqual(createdBrowser.calls.createTab, [["search", "about:blank"]]);
  assert.deepStrictEqual(createdBrowser.calls.bringToFront, ["communication-created"]);

  const inspectBrowser = fakeBrowser({
    tabs: [{ id: "search", url: "https://www.zhipin.com/web/geek/jobs?query=fake" }]
  });
  const inspectAdapter = new BossSiteAdapter({ browser: inspectBrowser, sleepFn: async () => {} });
  const inspection = await inspectAdapter.inspectCommunicationJob({ url: jobUrl, title: expectedJob.title, company: expectedJob.company });
  assert.strictEqual(inspection.state, "ready");
  const secondInspection = await inspectAdapter.inspectCommunicationJob(secondJob);
  assert.strictEqual(secondInspection.state, "ready");
  assert.deepStrictEqual(inspectBrowser.calls.createTab, [["search", "about:blank"]]);
  assert.deepStrictEqual(inspectBrowser.calls.navigate, [["communication-created", jobUrl], ["communication-created", secondJobUrl]]);
  assert.strictEqual(inspectBrowser.calls.navigate.length, 2);
  assert.deepStrictEqual(inspectBrowser.calls.bringToFront, ["communication-created", "communication-created"]);
  assert.strictEqual(inspectBrowser.calls.clickAt.length, 0);
  assert(inspectBrowser.calls.evalValue.every(([, expression]) => !expression.includes("clickAt")));
  const snapshot = JSON.parse(JSON.stringify(inspectBrowser.snapshots[0]));
  assert.deepStrictEqual(snapshot, readySnapshot);
  assert.deepStrictEqual(Object.keys(snapshot).sort(), [
    "actions", "bossActiveText", "company", "jobId", "jobStatus", "login", "pageReady", "risk", "salary", "title", "url"
  ]);
  for (const sensitiveOrNonContractField of ["description", "email", "html", "jd", "phone", "recruiter"]) {
    assert(!Object.hasOwn(snapshot, sensitiveOrNonContractField));
  }

  await assert.rejects(
    () => inspectAdapter.inspectCommunicationJob({ url: "http://www.zhipin.com/job_detail/fake123.html", title: expectedJob.title, company: expectedJob.company }),
    (error) => error.code === "BOSS_COMMUNICATION_URL_INVALID"
  );
  await assert.rejects(
    () => inspectAdapter.inspectCommunicationJob({ url: "https://www.zhipin.com/job_detail/", title: expectedJob.title, company: expectedJob.company }),
    (error) => error.code === "BOSS_COMMUNICATION_URL_INVALID"
  );
  assert.strictEqual(inspectBrowser.calls.clickAt.length, 0);

  await assert.rejects(
    () => inspectAdapter.dispatchCommunication({}),
    (error) => error.code === "BOSS_COMMUNICATION_CALIBRATION_REQUIRED"
  );
  assert.strictEqual(inspectBrowser.calls.clickAt.length, 0);
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
