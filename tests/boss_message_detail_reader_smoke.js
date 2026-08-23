const assert = require("node:assert/strict");
const { createBossMessageDetailReader } = require("../src/adapters/sites/boss_message_detail_reader");

const SEARCH_TAB_ID = "search-target-101";
const COMMUNICATION_TAB_ID = "communication-target-102";
const DASHBOARD_TAB_ID = "dashboard-target-103";
const DETAIL_TAB_ID = "42";
const WINDOW_ID = 7;
const SECRET = "private-secret-token";
const jobTarget = Object.freeze({
  jobId: "abcDEF123",
  navigationUrl: `https://www.zhipin.com/job_detail/abcDEF123.html?securityId=${SECRET}`,
  canonicalUrl: "https://www.zhipin.com/job_detail/abcDEF123.html"
});
const selected = Object.freeze({
  positionName: "Java Engineer",
  companyName: "Fixture Company",
  city: "Shenzhen"
});

function baseTabs() {
  return [
    { id: SEARCH_TAB_ID, windowId: WINDOW_ID, active: false, url: "https://www.zhipin.com/web/geek/jobs" },
    { id: COMMUNICATION_TAB_ID, windowId: WINDOW_ID, active: false, url: "https://www.zhipin.com/web/geek/chat" },
    { id: DASHBOARD_TAB_ID, windowId: WINDOW_ID, active: true, url: "http://127.0.0.1:3000/messages" }
  ];
}

function communication(overrides = {}) {
  return {
    url: jobTarget.navigationUrl,
    jobId: jobTarget.jobId,
    documentReadyState: "complete",
    risk: false,
    login: false,
    pageReady: true,
    title: selected.positionName,
    company: selected.companyName,
    salary: "20-30K",
    bossActiveText: "今日活跃",
    ...overrides
  };
}

function pane(overrides = {}) {
  return {
    activeJobId: "",
    componentCurrentJobId: jobTarget.jobId,
    paneJobId: jobTarget.jobId,
    currentJobId: jobTarget.jobId,
    jobDetailLoading: false,
    title: selected.positionName,
    description: "负责 Java 服务研发、Spring 系统维护、数据库优化和线上问题排查。".repeat(4),
    bossActiveText: "今日活跃",
    salary: "20-30K",
    experience: "3-5年",
    education: "本科及以上",
    hasRoot: true,
    ...overrides
  };
}

function messageDetail(overrides = {}) {
  return {
    currentJobId: jobTarget.jobId,
    rootCount: 1,
    hasRoot: true,
    title: selected.positionName,
    company: selected.companyName,
    description: pane().description,
    bossActiveText: "今日活跃",
    salary: "20-30K",
    experience: "3-5年",
    education: "本科及以上",
    ...overrides
  };
}

function fakeBrowser({
  minimized = false,
  newTabActive = false,
  detailWindowId = WINDOW_ID,
  detailTabId = DETAIL_TAB_ID,
  returnedTabId = DETAIL_TAB_ID,
  listedUrl = null,
  listedUrlSequence = null,
  createError = null,
  createErrorAfterInsert = false,
  onCreate = null,
  closeNoop = false,
  twoVisibleAfterClose = false,
  communicationSnapshot = communication(),
  paneSnapshot = pane(),
  detailSnapshot = messageDetail()
} = {}) {
  const browser = {
    tabs: baseTabs().map((tab) => minimized ? { ...tab, active: false } : tab),
    calls: [],
    detailListIndex: 0,
    async listTabs() {
      this.calls.push({ name: "listTabs" });
      return this.tabs.map((tab) => ({
        ...tab,
        ...(tab.id === detailTabId && Array.isArray(listedUrlSequence)
          ? { url: listedUrlSequence[Math.min(this.detailListIndex++, listedUrlSequence.length - 1)] }
          : {})
      }));
    },
    async createTab(openerTabId, url) {
      this.calls.push({ name: "createTab", openerTabId, url });
      const detail = { id: detailTabId, windowId: detailWindowId, active: newTabActive, url: listedUrl || url };
      if (newTabActive) {
        for (const tab of this.tabs) tab.active = false;
      }
      if (!createError || createErrorAfterInsert) this.tabs.push(detail);
      onCreate?.();
      if (createError) throw createError;
      return returnedTabId;
    },
    async evalValue(tabId, expression) {
      this.calls.push({ name: "evalValue", tabId, expression });
      if (expression.includes("__bossCommunicationSnapshot")) return { ...communicationSnapshot };
      if (expression.includes("__bossMessageDetailSnapshot")) return { ...detailSnapshot };
      if (expression.includes("__bossPaneState")) return { ...paneSnapshot };
      return true;
    },
    async closeTab(tabId) {
      this.calls.push({ name: "closeTab", tabId });
      if (!closeNoop) {
        const closingWasActive = this.tabs.some((tab) => tab.id === tabId && tab.active === true);
        this.tabs = this.tabs.filter((tab) => tab.id !== tabId);
        if (closingWasActive) {
          const dashboard = this.tabs.find((tab) => tab.id === DASHBOARD_TAB_ID);
          if (dashboard) dashboard.active = true;
        }
        if (twoVisibleAfterClose) {
          const search = this.tabs.find((tab) => tab.id === SEARCH_TAB_ID);
          if (search) search.active = true;
        }
      }
      return true;
    }
  };
  return browser;
}

function makeReader(browser, { identityError = null, rejectAbortedIdentitySignal = false } = {}) {
  const hooks = [];
  const identitySignals = [];
  const messageReader = {
    async readSelectedJobTarget(received, signal) {
      hooks.push("recheckMessage");
      identitySignals.push(Boolean(signal?.aborted));
      assert.strictEqual(received, selected);
      if (rejectAbortedIdentitySignal && signal?.aborted) {
        throw signal.reason || Object.assign(new Error("stopped"), { code: "MESSAGE_DISCOVERY_STOPPED" });
      }
      if (identityError) throw identityError;
      return jobTarget;
    }
  };
  const reader = createBossMessageDetailReader({
    browser,
    messageReader,
    sleepFn: async () => {},
    beforeOpen: async ({ jobId, assertTabBindings }) => {
      hooks.push("beforeOpen");
      assert.strictEqual(jobId, jobTarget.jobId);
      await assertTabBindings();
    },
    afterIssuedAttempt: async ({ jobId, assertTabBindings }) => {
      hooks.push("afterIssuedAttempt");
      assert.strictEqual(jobId, jobTarget.jobId);
      await assertTabBindings();
    }
  });
  return { reader, hooks, identitySignals };
}

async function read(reader, signal = null) {
  return reader.readSelectedJobDetail({
    communicationTabId: COMMUNICATION_TAB_ID,
    selected,
    jobTarget,
    signal
  });
}

(async () => {
  const browser = fakeBrowser();
  const { reader, hooks } = makeReader(browser);
  const detail = await read(reader);
  assert.deepStrictEqual(detail, {
    sourceId: jobTarget.jobId,
    canonicalUrl: jobTarget.canonicalUrl,
    title: selected.positionName,
    company: selected.companyName,
    location: selected.city,
    salary: "20-30K",
    experience: "3-5年",
    education: "本科及以上",
    bossActiveText: "今日活跃",
    tags: ["3-5年", "本科及以上"],
    description: pane().description
  });
  assert.deepStrictEqual(hooks, ["beforeOpen", "recheckMessage", "afterIssuedAttempt"]);
  assert.deepStrictEqual(browser.tabs, baseTabs(), "the transient detail tab must be closed after a successful read");
  assert.strictEqual(browser.tabs.find((tab) => tab.active).id, DASHBOARD_TAB_ID);
  assert.strictEqual(browser.calls.filter((call) => call.name === "createTab").length, 1);
  assert.strictEqual(browser.calls.filter((call) => call.name === "closeTab").length, 1);
  assert.strictEqual(browser.calls.some((call) => /bringToFront|focus/i.test(call.name)), false);

  const cleanupVisibilityBrowser = fakeBrowser({ twoVisibleAfterClose: true });
  const cleanupVisibility = makeReader(cleanupVisibilityBrowser);
  await assert.rejects(
    () => read(cleanupVisibility.reader),
    (error) => error.code === "BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED"
  );
  assert.deepStrictEqual(
    cleanupVisibilityBrowser.tabs.filter((tab) => tab.active).map((tab) => tab.id),
    [SEARCH_TAB_ID, DASHBOARD_TAB_ID],
    "cleanup visibility drift must retain the exact unsafe two-visible fixture"
  );
  assert.strictEqual(cleanupVisibilityBrowser.calls.filter((call) => call.name === "createTab").length, 1);
  assert.strictEqual(cleanupVisibilityBrowser.calls.filter((call) => call.name === "closeTab").length, 1);
  assert.deepStrictEqual(cleanupVisibility.hooks, ["beforeOpen", "afterIssuedAttempt"]);

  const minimizedBrowser = fakeBrowser({ minimized: true });
  const minimized = makeReader(minimizedBrowser);
  await assert.rejects(
    () => read(minimized.reader),
    (error) => error.code === "BOSS_MESSAGE_DETAIL_NOT_BACKGROUND"
  );
  assert.deepStrictEqual(minimized.hooks, [], "a minimized window must stop before pacing or issued-attempt accounting");
  assert.strictEqual(minimizedBrowser.calls.filter((call) => call.name === "createTab").length, 0);
  assert.strictEqual(minimizedBrowser.calls.filter((call) => call.name === "closeTab").length, 0);
  assert.deepStrictEqual(
    minimizedBrowser.tabs,
    baseTabs().map((tab) => ({ ...tab, active: false })),
    "a minimized window must leave the pending item and exact typed baseline untouched"
  );

  const ambiguousVisibleBrowser = fakeBrowser();
  ambiguousVisibleBrowser.tabs[0].active = true;
  const ambiguousVisible = makeReader(ambiguousVisibleBrowser);
  await assert.rejects(
    () => read(ambiguousVisible.reader),
    (error) => error.code === "BOSS_MESSAGE_DETAIL_NOT_BACKGROUND"
  );
  assert.deepStrictEqual(ambiguousVisible.hooks, [], "multiple visible tabs must stop before pacing or accounting");
  assert.strictEqual(ambiguousVisibleBrowser.calls.filter((call) => call.name === "createTab").length, 0);

  const delayedUrlBrowser = fakeBrowser({
    listedUrlSequence: ["", jobTarget.navigationUrl]
  });
  const delayedUrl = makeReader(delayedUrlBrowser);
  const delayedDetail = await read(delayedUrl.reader);
  assert.strictEqual(delayedDetail.sourceId, jobTarget.jobId);
  assert.deepStrictEqual(
    delayedUrlBrowser.tabs,
    baseTabs(),
    "a background detail tab whose URL appears on the next read must complete and restore the baseline"
  );

  const delayedBlankBrowser = fakeBrowser({
    listedUrlSequence: ["about:blank", jobTarget.navigationUrl]
  });
  const delayedBlank = makeReader(delayedBlankBrowser);
  const delayedBlankDetail = await read(delayedBlank.reader);
  assert.strictEqual(delayedBlankDetail.sourceId, jobTarget.jobId);
  assert.deepStrictEqual(delayedBlankBrowser.tabs, baseTabs(),
    "an attributable about:blank tab may wait for its exact target URL and must then restore the baseline");

  const standaloneBrowser = fakeBrowser({
    paneSnapshot: pane({
      currentJobId: "different-pane-job",
      paneJobId: "different-pane-job",
      componentCurrentJobId: "different-pane-job",
      title: "Different pane job"
    })
  });
  const standalone = makeReader(standaloneBrowser);
  const standaloneDetail = await read(standalone.reader);
  assert.strictEqual(standaloneDetail.sourceId, jobTarget.jobId);
  assert.deepStrictEqual(
    standaloneBrowser.tabs,
    baseTabs(),
    "standalone message detail identity must come from the page path and header, not pane-only fields"
  );

  for (const [options, code] of [
    [{ newTabActive: true }, "BOSS_MESSAGE_DETAIL_NOT_BACKGROUND"],
    [{ detailWindowId: WINDOW_ID + 1 }, "BOSS_MESSAGE_DETAIL_NOT_BACKGROUND"],
    [{ returnedTabId: 42 }, "BOSS_MESSAGE_DETAIL_NOT_BACKGROUND"],
    [{ detailTabId: 42, returnedTabId: 42 }, "BOSS_MESSAGE_DETAIL_NOT_BACKGROUND"],
    [{ listedUrl: "https://www.zhipin.com/web/geek/chat" }, "BOSS_MESSAGE_DETAIL_NOT_BACKGROUND"],
    [{ communicationSnapshot: communication({ title: "Different job" }) }, "BOSS_MESSAGE_DETAIL_TARGET_MISMATCH"],
    [{ communicationSnapshot: communication({ risk: true }) }, "BOSS_RISK_CONTROL"],
    [{ communicationSnapshot: communication({ login: true }) }, "BOSS_LOGIN_REQUIRED"],
    [{ detailSnapshot: messageDetail({ description: "too short" }) }, "BOSS_MESSAGE_DETAIL_INCOMPLETE"],
    [{ detailSnapshot: messageDetail({ currentJobId: "different-job" }) }, "BOSS_MESSAGE_DETAIL_TARGET_MISMATCH"],
    [{ detailSnapshot: messageDetail({ rootCount: 2, hasRoot: false }) }, "BOSS_MESSAGE_DETAIL_TARGET_MISMATCH"],
    [{ listedUrl: "about:blank" }, "BOSS_MESSAGE_DETAIL_NOT_BACKGROUND"],
    [{ closeNoop: true }, "BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED"]
  ]) {
    const failingBrowser = fakeBrowser(options);
    const failing = makeReader(failingBrowser);
    const error = await assert.rejects(() => read(failing.reader), (received) => received.code === code);
    assert.doesNotMatch(String(error?.message || ""), new RegExp(SECRET));
    assert.strictEqual(failing.hooks.at(-1), "afterIssuedAttempt");
    if (!options.closeNoop) {
      assert.deepStrictEqual(failingBrowser.tabs, baseTabs(), `${code} must restore the fixed-tab baseline`);
    }
  }

  const uncertainCreate = fakeBrowser({
    createError: Object.assign(new Error(`bridge echoed securityId=${SECRET}`), { code: "BROWSER_COMMAND_FAILED" }),
    createErrorAfterInsert: true
  });
  const uncertain = makeReader(uncertainCreate);
  const uncertainError = await assert.rejects(
    () => read(uncertain.reader),
    (error) => error.code === "BOSS_MESSAGE_DETAIL_BROWSER_FAILED"
  );
  assert.doesNotMatch(String(uncertainError), new RegExp(SECRET));
  assert.deepStrictEqual(uncertainCreate.tabs, baseTabs(), "an ambiguously created matching detail tab must be cleaned up");
  assert.deepStrictEqual(uncertain.hooks, ["beforeOpen", "afterIssuedAttempt"]);
  assert.strictEqual(uncertainCreate.calls.filter((call) => call.name === "createTab").length, 1, "ambiguous create must never retry");

  const uncertainWrongWindow = fakeBrowser({
    detailWindowId: WINDOW_ID + 1,
    createError: Object.assign(new Error("bridge result was ambiguous"), { code: "BROWSER_COMMAND_FAILED" }),
    createErrorAfterInsert: true
  });
  const uncertainWrong = makeReader(uncertainWrongWindow);
  await assert.rejects(() => read(uncertainWrong.reader), (error) => error.code === "BOSS_MESSAGE_DETAIL_BROWSER_FAILED");
  assert.deepStrictEqual(
    uncertainWrongWindow.tabs,
    baseTabs(),
    "an ambiguously created target detail must be cleaned up even if Edge reports the wrong window"
  );

  const uncertainLoading = fakeBrowser({
    listedUrl: "about:blank",
    createError: Object.assign(new Error(`loading securityId=${SECRET}`), { code: "BROWSER_COMMAND_FAILED" }),
    createErrorAfterInsert: true
  });
  const loading = makeReader(uncertainLoading);
  const loadingError = await assert.rejects(
    () => read(loading.reader),
    (error) => error.code === "BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED"
  );
  assert.doesNotMatch(String(loadingError), new RegExp(SECRET));
  assert.strictEqual(
    uncertainLoading.calls.some((call) => call.name === "closeTab"),
    false,
    "an unattributed same-window tab must never be guessed and closed"
  );
  assert.deepStrictEqual(
    uncertainLoading.tabs,
    [...baseTabs(), { id: DETAIL_TAB_ID, windowId: WINDOW_ID, active: false, url: "about:blank" }],
    "an unattributed tab must remain visible for manual recovery"
  );

  const abortController = new AbortController();
  const abortedBrowser = fakeBrowser({
    onCreate: () => abortController.abort(Object.assign(new Error("stopped"), { code: "MESSAGE_DISCOVERY_STOPPED" }))
  });
  const aborted = makeReader(abortedBrowser, { rejectAbortedIdentitySignal: true });
  await assert.rejects(
    () => read(aborted.reader, abortController.signal),
    (error) => error.code === "MESSAGE_DISCOVERY_STOPPED"
  );
  assert.deepStrictEqual(abortedBrowser.tabs, baseTabs(), "an aborted read must still close its transient detail tab");
  assert.deepStrictEqual(aborted.identitySignals, [false], "cleanup identity verification must not inherit the business abort");

  for (const invalidTarget of [{
    ...jobTarget,
    navigationUrl: `${jobTarget.navigationUrl}&extra=1`
  }, {
    ...jobTarget,
    navigationUrl: `${jobTarget.navigationUrl}#private`
  }]) {
    const strictBrowser = fakeBrowser();
    const strict = makeReader(strictBrowser);
    await assert.rejects(
      () => strict.reader.readSelectedJobDetail({
        communicationTabId: COMMUNICATION_TAB_ID,
        selected,
        jobTarget: invalidTarget
      }),
      (error) => error.code === "BOSS_MESSAGE_JOB_TARGET_UNAVAILABLE"
    );
    assert.strictEqual(strictBrowser.calls.length, 0, "an inexact trusted URL must stop before browser access");
  }

  const driftError = Object.assign(new Error("selected conversation changed"), { code: "BOSS_MESSAGE_TARGET_MISMATCH" });
  const driftBrowser = fakeBrowser();
  const drift = makeReader(driftBrowser, { identityError: driftError });
  await assert.rejects(
    () => read(drift.reader),
    (error) => error.code === "BOSS_MESSAGE_TARGET_MISMATCH" && error !== driftError
  );
  assert.deepStrictEqual(driftBrowser.tabs, baseTabs());
  assert.deepStrictEqual(drift.hooks, ["beforeOpen", "recheckMessage", "afterIssuedAttempt"]);

  console.log("boss_message_detail_reader_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
