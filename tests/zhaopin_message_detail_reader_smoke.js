const assert = require("node:assert/strict");
let chromium;
try { ({ chromium } = require("playwright")); }
catch (error) {
  if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === "1") throw error;
  console.log("zhaopin_message_detail_reader_smoke SKIP: Playwright unavailable");
  process.exit(0);
}
const {
  createZhaopinMessageDetailReader,
  parseZhaopinMessageDetailSnapshot,
  ZHAOPIN_MESSAGE_DETAIL_SNAPSHOT_EXPRESSION
} = require("../src/adapters/sites/zhaopin_message_detail_reader");

const JOB_ID = "CCSYNTH001J00000000001";
const IM_TAB_ID = 202;
const DETAIL_TAB_ID = 303;
const WINDOW_ID = 7;
const IM_URL = "https://i.zhaopin.com/im?refcode=synthetic";
const NAVIGATION_URL = `https://www.zhaopin.com/jobdetail/${JOB_ID}.html`;
const CANONICAL_URL = `https://www.zhaopin.com/jobdetail/${JOB_ID}.htm`;
const DESCRIPTION = "负责合成系统的设计、开发、测试、上线与稳定性治理，参与需求分析和技术方案评审，持续改善工程质量、监控告警、故障诊断与跨团队交付效率。".repeat(3);

function snapshot(overrides = {}) {
  return {
    state: "ready",
    currentJobId: JOB_ID,
    title: "合成软件工程师",
    company: "合成科技有限公司",
    location: "北京",
    salary: "20-30K",
    experience: "3-5年",
    education: "本科",
    tags: ["Node.js", "服务端"],
    description: DESCRIPTION,
    availability: "unknown",
    ...overrides
  };
}

function baselineTabs(extra = []) {
  return [
    { id: 1, windowId: WINDOW_ID, active: true, url: "http://127.0.0.1:3000/messages" },
    { id: IM_TAB_ID, windowId: WINDOW_ID, active: false, url: IM_URL },
    ...extra
  ];
}

function fakeBrowser({ samples = [snapshot(), snapshot()], created = {}, returnedId = DETAIL_TAB_ID, createError = null, createErrorAfterInsert = false, baselineExtra = [], closeError = null } = {}) {
  const calls = [];
  const tabs = baselineTabs(baselineExtra);
  let sampleIndex = 0;
  return {
    calls,
    tabs,
    async listTabs() { calls.push(["listTabs"]); return tabs.map((tab) => ({ ...tab })); },
    async createTab(parentId, url) {
      calls.push(["createTab", parentId, url]);
      const tab = { id: DETAIL_TAB_ID, windowId: WINDOW_ID, active: false, url, ...created };
      if (!tabs.some((item) => item.id === tab.id)) tabs.push(tab);
      if (createError && createErrorAfterInsert) throw createError;
      if (createError) throw createError;
      return returnedId;
    },
    async setPageLifecycleActive(tabId) { calls.push(["setPageLifecycleActive", tabId]); },
    async evalValue(tabId, expression) {
      calls.push(["evalValue", tabId, expression]);
      assert.equal(tabId, DETAIL_TAB_ID);
      return samples[Math.min(sampleIndex++, samples.length - 1)];
    },
    async closeTab(tabId) {
      calls.push(["closeTab", tabId]);
      if (closeError) throw closeError;
      const index = tabs.findIndex((tab) => tab.id === tabId);
      if (index >= 0) tabs.splice(index, 1);
    },
    async bringToFront() { throw new Error("must not focus"); }
  };
}

function makeReader(browser, options = {}) {
  let clock = 0;
  const hooks = [];
  const identitySignals = [];
  const waits = [];
  const reader = createZhaopinMessageDetailReader({
    browser,
    messageReader: {
      async readSelectedJobTarget(selected, signal) {
        identitySignals.push(Boolean(signal?.aborted));
        if (options.identityError) throw options.identityError;
        assert.equal(selected, SELECTED);
        return JOB_TARGET;
      }
    },
    beforeOpen: async () => hooks.push("beforeOpen"),
    afterIssuedAttempt: async () => hooks.push("afterIssuedAttempt"),
    nowFn: () => clock,
    timeoutMs: options.timeoutMs || 30,
    pollIntervalMs: 1,
    sleepFn: async (_ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      waits.push(_ms);
      clock += 5;
      options.afterSleep?.();
    }
  });
  return { reader, hooks, identitySignals, waits };
}

const SELECTED = Object.freeze({ positionName: "合成软件工程师", companyName: "合成科技" });
const JOB_TARGET = Object.freeze({ jobId: JOB_ID, navigationUrl: NAVIGATION_URL, canonicalUrl: CANONICAL_URL, availability: "unknown" });

async function read(reader, signal = null) {
  return reader.readSelectedJobDetail({ communicationTabId: IM_TAB_ID, selected: SELECTED, jobTarget: JOB_TARGET, signal });
}

(async () => {
  const edge = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await edge.newPage();
    const body = `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <h1 class="summary-planes__title">合成软件工程师</h1>
      <strong class="summary-planes__salary">20-30K</strong>
      <ul class="summary-planes__info"><li>北京</li><li>3-5年</li><li>本科</li></ul>
      <div class="describtion-card__detail-content">${DESCRIPTION}</div>
      <span class="describtion-card__skills-item">Node.js</span><span class="describtion-card__skills-item">服务端</span>
      <a class="company-info__name">合成科技有限公司</a>
    </body></html>`;
    await page.route(NAVIGATION_URL, (route) => route.fulfill({ status: 200, contentType: "text/html", body }));
    await page.goto(NAVIGATION_URL);
    const observed = parseZhaopinMessageDetailSnapshot(await page.evaluate(ZHAOPIN_MESSAGE_DETAIL_SNAPSHOT_EXPRESSION));
    assert.deepStrictEqual(
      [observed.sourceId, observed.title, observed.company, observed.location, observed.experience, observed.education, observed.description],
      [JOB_ID, "合成软件工程师", "合成科技有限公司", "北京", "3-5年", "本科", DESCRIPTION]
    );
  } finally {
    await edge.close();
  }

  const parsed = parseZhaopinMessageDetailSnapshot(snapshot());
  assert.equal(parsed.sourceId, JOB_ID);
  assert.equal(parsed.title, "合成软件工程师");
  assert.equal(parsed.company, "合成科技有限公司");
  assert.equal(parsed.description, DESCRIPTION);

  const browser = fakeBrowser();
  const success = makeReader(browser);
  assert.deepStrictEqual(await read(success.reader), {
    source: "zhaopin", sourceId: JOB_ID, canonicalUrl: CANONICAL_URL,
    title: "合成软件工程师", company: "合成科技有限公司", location: "北京",
    salary: "20-30K", experience: "3-5年", education: "本科",
    tags: ["Node.js", "服务端"], description: DESCRIPTION, availability: "unknown"
  });
  assert.deepStrictEqual(success.hooks, ["beforeOpen", "afterIssuedAttempt"]);
  assert.deepStrictEqual(success.identitySignals, [false]);
  assert.deepStrictEqual(browser.tabs, baselineTabs());
  assert.equal(browser.calls.filter(([name]) => name === "createTab").length, 1);
  assert.equal(browser.calls.some(([name]) => name === "bringToFront"), false);

  const stringReturn = fakeBrowser({ returnedId: String(DETAIL_TAB_ID) });
  await read(makeReader(stringReturn).reader);
  assert.equal(stringReturn.calls.find(([name]) => name === "closeTab")[1], DETAIL_TAB_ID, "cleanup uses the typed id from listTabs");

  const changing = fakeBrowser({ samples: [snapshot({ salary: "10K" }), snapshot({ salary: "11K" }), snapshot({ salary: "12K" }), snapshot({ salary: "12K" })] });
  assert.equal((await read(makeReader(changing).reader)).salary, "12K", "two stable content samples are required");

  const loading = fakeBrowser({ samples: [snapshot({ documentReadyState: "loading" }), snapshot({ documentReadyState: "loading" })] });
  assert.equal((await read(makeReader(loading).reader)).sourceId, JOB_ID, "complete stable body must not wait for all resource loads");

  const skeleton = fakeBrowser({ samples: [
    snapshot({ title: "", company: "", description: "", loading: true }),
    snapshot(),
    snapshot()
  ] });
  const skeletonReader = makeReader(skeleton);
  assert.equal((await read(skeletonReader.reader)).sourceId, JOB_ID, "an empty same-job skeleton must wait for complete stable content");
  assert.equal(skeleton.calls.filter(([name]) => name === "evalValue").length, 3);
  assert.equal(skeletonReader.waits.length, 2);

  const missing = fakeBrowser({ samples: [snapshot({ title: "", company: "", description: "", loading: true })] });
  const missingReader = makeReader(missing, { timeoutMs: 10 });
  await assert.rejects(() => read(missingReader.reader), (error) => error.code === "ZHAOPIN_MESSAGE_DETAIL_INCOMPLETE");
  assert(missing.calls.filter(([name]) => name === "evalValue").length > 1, "an empty same-job skeleton must poll until timeout");

  const waitingController = new AbortController();
  const waiting = fakeBrowser({ samples: [snapshot({ title: "", company: "", description: "", loading: true })] });
  const waitingReader = makeReader(waiting, {
    afterSleep() {
      waitingController.abort(Object.assign(new Error("stopped while waiting"), { code: "MESSAGE_DISCOVERY_STOPPED" }));
    }
  });
  await assert.rejects(
    () => read(waitingReader.reader, waitingController.signal),
    (error) => error.code === "MESSAGE_DISCOVERY_STOPPED"
  );
  assert.equal(waiting.calls.filter(([name]) => name === "evalValue").length, 1, "cancellation must stop the next skeleton sample");
  assert.deepStrictEqual(waiting.tabs, baselineTabs());

  const offline = fakeBrowser({ samples: [snapshot({ availability: "offline" }), snapshot({ availability: "offline" })] });
  assert.equal((await read(makeReader(offline).reader)).availability, "offline");

  for (const bad of [
    snapshot({ currentJobId: "CCWRONG001J00000000001" }),
    snapshot({ title: "另一个岗位" }),
    snapshot({ company: "完全不同公司" })
  ]) {
    const badBrowser = fakeBrowser({ samples: [bad, bad] });
    await assert.rejects(() => read(makeReader(badBrowser).reader), (error) => error.code === "ZHAOPIN_MESSAGE_DETAIL_TARGET_MISMATCH");
    assert.deepStrictEqual(badBrowser.tabs, baselineTabs());
  }

  const incomplete = fakeBrowser({ samples: [snapshot({ description: "" })] });
  await assert.rejects(() => read(makeReader(incomplete, { timeoutMs: 10 }).reader), (error) => error.code === "ZHAOPIN_MESSAGE_DETAIL_INCOMPLETE");
  assert.deepStrictEqual(incomplete.tabs, baselineTabs());

  const wrongWindow = fakeBrowser({ created: { windowId: WINDOW_ID + 1 } });
  await assert.rejects(() => read(makeReader(wrongWindow).reader), (error) => error.code === "ZHAOPIN_MESSAGE_DETAIL_NOT_BACKGROUND");
  assert.deepStrictEqual(wrongWindow.tabs, baselineTabs());

  const physicalOpenError = Object.assign(new Error("bridge failed private page text"), { code: "BROWSER_COMMAND_FAILED" });
  const uncertain = fakeBrowser({ createError: physicalOpenError, createErrorAfterInsert: true });
  await assert.rejects(() => read(makeReader(uncertain).reader), (error) => error.code === "ZHAOPIN_MESSAGE_DETAIL_BROWSER_FAILED");
  assert.deepStrictEqual(uncertain.tabs, baselineTabs(), "an attributable exact target is cleaned up after create throws");

  const preexisting = { id: 404, windowId: WINDOW_ID, active: false, url: NAVIGATION_URL };
  const withUserTab = fakeBrowser({ baselineExtra: [preexisting] });
  await read(makeReader(withUserTab).reader);
  assert.deepStrictEqual(withUserTab.tabs, baselineTabs([preexisting]), "cleanup must not close a pre-existing user tab");

  const unrelated = { id: 999, windowId: WINDOW_ID, active: false, url: "https://example.test/user-tab" };
  const wrongReported = fakeBrowser({ baselineExtra: [unrelated], returnedId: unrelated.id });
  await assert.rejects(() => read(makeReader(wrongReported).reader), (error) => error.code === "ZHAOPIN_MESSAGE_DETAIL_NOT_BACKGROUND");
  assert.deepStrictEqual(wrongReported.tabs, baselineTabs([unrelated]), "an unverified returned id must never close a pre-existing user tab");

  const abortedController = new AbortController();
  const abortedBrowser = fakeBrowser();
  const aborted = makeReader(abortedBrowser);
  abortedBrowser.createTab = async (parentId, url) => {
    abortedBrowser.calls.push(["createTab", parentId, url]);
    abortedBrowser.tabs.push({ id: DETAIL_TAB_ID, windowId: WINDOW_ID, active: false, url });
    abortedController.abort(Object.assign(new Error("stopped"), { code: "MESSAGE_DISCOVERY_STOPPED" }));
    return DETAIL_TAB_ID;
  };
  await assert.rejects(() => read(aborted.reader, abortedController.signal), (error) => error.code === "MESSAGE_DISCOVERY_STOPPED");
  assert.deepStrictEqual(aborted.identitySignals, [false], "cleanup identity recheck must not inherit an aborted signal");
  assert.deepStrictEqual(abortedBrowser.tabs, baselineTabs());

  for (const invalid of [
    { ...JOB_TARGET, navigationUrl: `https://evil.example/jobdetail/${JOB_ID}.html` },
    { ...JOB_TARGET, navigationUrl: `https://www.zhaopin.com/jobdetail/OTHER.htm` },
    { ...JOB_TARGET, canonicalUrl: `https://www.zhaopin.com/jobdetail/${JOB_ID}.html` }
  ]) {
    const strictBrowser = fakeBrowser();
    const strict = makeReader(strictBrowser);
    await assert.rejects(
      () => strict.reader.readSelectedJobDetail({ communicationTabId: IM_TAB_ID, selected: SELECTED, jobTarget: invalid }),
      (error) => error.code === "ZHAOPIN_MESSAGE_JOB_TARGET_UNAVAILABLE"
    );
    assert.equal(strictBrowser.calls.length, 0);
  }

  console.log("zhaopin_message_detail_reader_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
