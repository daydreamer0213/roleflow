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
  listErrorAtCall = 0,
  listErrorAtCalls = [],
  listErrorAfterCloseAtCall = 0,
  listErrorCode = "BROWSER_DISCONNECTED",
  closeNoop = false,
  twoVisibleAfterClose = false,
  communicationSnapshot = communication(),
  communicationScriptFailure = null,
  replaceDocumentAfterFirstHelper = false,
  paneSnapshot = pane(),
  detailSnapshot = messageDetail(),
  evalErrorPattern = null,
  onEval = null
} = {}) {
  const browser = {
    tabs: baseTabs().map((tab) => minimized ? { ...tab, active: false } : tab),
    calls: [],
    listCallCount: 0,
    postCloseListCount: 0,
    closed: false,
    detailListIndex: 0,
    helperInjectionCount: 0,
    helperInstalled: false,
    async listTabs() {
      this.calls.push({ name: "listTabs" });
      this.listCallCount += 1;
      if (this.closed) this.postCloseListCount += 1;
      if (this.listCallCount === listErrorAtCall || listErrorAtCalls.includes(this.listCallCount)) {
        throw Object.assign(new Error("socket closed"), { code: listErrorCode });
      }
      if (listErrorAfterCloseAtCall > 0 && this.postCloseListCount === listErrorAfterCloseAtCall) {
        throw Object.assign(new Error("socket closed"), { code: listErrorCode });
      }
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
    async setPageLifecycleActive(tabId) {
      this.calls.push({ name: "setPageLifecycleActive", tabId });
      return true;
    },
    async evalValue(tabId, expression) {
      this.calls.push({ name: "evalValue", tabId, expression });
      onEval?.({ browser: this, tabId, expression });
      if (evalErrorPattern && expression.trim().startsWith(evalErrorPattern)) {
        throw Object.assign(new Error(`runtime exception ${SECRET}`), { code: "BROWSER_COMMAND_FAILED" });
      }
      if (expression.includes("window.__bossCommunicationSnapshot = function")) {
        this.helperInjectionCount += 1;
        this.helperInstalled = !(replaceDocumentAfterFirstHelper && this.helperInjectionCount === 1);
        return true;
      }
      if (expression.includes("__roleflowSafeCommunicationSnapshot")) {
        if (!this.helperInstalled) {
          return {
            ok: false,
            error: {
              errorName: "TypeError",
              errorKind: "not_function",
              errorMember: "window.__bossCommunicationSnapshot"
            }
          };
        }
        return communicationScriptFailure
          ? { ok: false, error: communicationScriptFailure }
          : { ok: true, value: { ...communicationSnapshot } };
      }
      if (expression.includes("__bossCommunicationSnapshot")) return { ...communicationSnapshot };
      if (expression.includes("__bossMessageDetailSnapshot")) return { ...detailSnapshot };
      if (expression.includes("__bossPaneState")) return { ...paneSnapshot };
      return true;
    },
    async closeTab(tabId) {
      this.calls.push({ name: "closeTab", tabId });
      this.closed = true;
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

function makeReader(browser, { identityError = null, rejectAbortedIdentitySignal = false, logger = null } = {}) {
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
    logger,
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
  assert.strictEqual(browser.calls.filter((call) => call.name === "setPageLifecycleActive").length, 1);
  assert.strictEqual(browser.calls.filter((call) => call.name === "closeTab").length, 1);
  assert(
    browser.calls.findIndex((call) => call.name === "setPageLifecycleActive")
      > browser.calls.findIndex((call) => call.name === "createTab"),
    "the transient page may only be woken after its exact background target has been created"
  );
  assert(
    browser.calls.findIndex((call) => call.name === "setPageLifecycleActive")
      < browser.calls.findIndex((call) => call.name === "evalValue"),
    "the verified background target must be woken before page helpers or detail reads"
  );
  assert.strictEqual(browser.calls.some((call) => /bringToFront|focus/i.test(call.name)), false);

  const settlingCloseBrowser = fakeBrowser({
    listErrorAfterCloseAtCall: 1,
    listErrorCode: "BROWSER_COMMAND_FAILED"
  });
  const settlingClose = makeReader(settlingCloseBrowser);
  const settlingCloseDetail = await read(settlingClose.reader);
  assert.strictEqual(settlingCloseDetail.sourceId, jobTarget.jobId);
  assert.deepStrictEqual(settlingCloseBrowser.tabs, baseTabs());
  assert.strictEqual(
    settlingCloseBrowser.calls.filter((call) => call.name === "createTab").length,
    1,
    "a transient post-close list failure must not re-open or re-read the external detail"
  );

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
  const minimizedDetail = await read(minimized.reader);
  assert.strictEqual(minimizedDetail.sourceId, jobTarget.jobId);
  assert.deepStrictEqual(minimized.hooks, ["beforeOpen", "recheckMessage", "afterIssuedAttempt"]);
  assert.strictEqual(minimizedBrowser.calls.filter((call) => call.name === "createTab").length, 1);
  assert.strictEqual(minimizedBrowser.calls.filter((call) => call.name === "closeTab").length, 1);
  assert.deepStrictEqual(
    minimizedBrowser.tabs,
    baseTabs().map((tab) => ({ ...tab, active: false })),
    "a zero-visible Edge window must restore the exact hidden typed baseline"
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
  const diagnosticEvents = [];
  const uncertain = makeReader(uncertainCreate, {
    logger: { warn(event, fields) { diagnosticEvents.push({ event, fields }); } }
  });
  const uncertainError = await assert.rejects(
    () => read(uncertain.reader),
    (error) => error.code === "BOSS_MESSAGE_DETAIL_BROWSER_FAILED"
  );
  assert.doesNotMatch(String(uncertainError), new RegExp(SECRET));
  assert.deepStrictEqual(uncertainCreate.tabs, baseTabs(), "an ambiguously created matching detail tab must be cleaned up");
  assert.deepStrictEqual(uncertain.hooks, ["beforeOpen", "afterIssuedAttempt"]);
  assert.strictEqual(uncertainCreate.calls.filter((call) => call.name === "createTab").length, 1, "ambiguous create must never retry");
  assert.deepStrictEqual(diagnosticEvents, [{
    event: "boss_message_detail_read_failed",
    fields: {
      phase: "create_tab",
      code: "BOSS_MESSAGE_DETAIL_BROWSER_FAILED",
      causeCode: "BROWSER_COMMAND_FAILED"
    }
  }]);
  assert.doesNotMatch(JSON.stringify(diagnosticEvents), new RegExp(SECRET));

  const readDiagnosticEvents = [];
  const readFailureBrowser = fakeBrowser({ evalErrorPattern: "(function __roleflowSafeCommunicationSnapshot" });
  const readFailure = makeReader(readFailureBrowser, {
    logger: { warn(event, fields) { readDiagnosticEvents.push({ event, fields }); } }
  });
  await assert.rejects(
    () => read(readFailure.reader),
    (error) => error.code === "BOSS_MESSAGE_DETAIL_BROWSER_FAILED"
  );
  assert.deepStrictEqual(readDiagnosticEvents[0]?.fields, {
    phase: "read_page_state",
    code: "BOSS_MESSAGE_DETAIL_BROWSER_FAILED",
    causeCode: "BROWSER_COMMAND_FAILED"
  });
  assert.doesNotMatch(JSON.stringify(readDiagnosticEvents), new RegExp(SECRET));
  assert.deepStrictEqual(readFailureBrowser.tabs, baseTabs());

  const replacedDocumentBrowser = fakeBrowser({ replaceDocumentAfterFirstHelper: true });
  const replacedDocument = makeReader(replacedDocumentBrowser);
  const replacedDocumentDetail = await read(replacedDocument.reader);
  assert.strictEqual(replacedDocumentDetail.sourceId, jobTarget.jobId);
  assert.strictEqual(
    replacedDocumentBrowser.helperInjectionCount,
    2,
    "a helper lost during navigation must be re-injected into the current detail document"
  );
  assert.deepStrictEqual(replacedDocumentBrowser.tabs, baseTabs());

  let liveReadCount = 0;
  const midReadDriftBrowser = fakeBrowser({
    communicationSnapshot: communication({ pageReady: false }),
    onEval({ browser, expression }) {
      if (!expression.includes("__roleflowSafeCommunicationSnapshot") || ++liveReadCount !== 1) return;
      for (const tab of browser.tabs) tab.active = tab.id === DETAIL_TAB_ID;
    }
  });
  const midReadDrift = makeReader(midReadDriftBrowser);
  await assert.rejects(
    () => read(midReadDrift.reader),
    (error) => error.code === "BOSS_MESSAGE_DETAIL_NOT_BACKGROUND"
  );
  assert.strictEqual(
    midReadDriftBrowser.calls.filter((call) => call.name === "evalValue"
      && call.expression.includes("__bossMessageDetailSnapshot")).length,
    0,
    "a detail tab that becomes visible during readiness polling must stop before reading the job snapshot"
  );
  assert.deepStrictEqual(midReadDriftBrowser.tabs, baseTabs());

  let fixedBindingReadCount = 0;
  const midReadFixedBindingDriftBrowser = fakeBrowser({
    communicationSnapshot: communication({ pageReady: false }),
    onEval({ browser, expression }) {
      if (!expression.includes("__roleflowSafeCommunicationSnapshot") || ++fixedBindingReadCount !== 1) return;
      browser.tabs.find((tab) => tab.id === SEARCH_TAB_ID).url = "https://www.zhipin.com/web/geek/other";
    }
  });
  const midReadFixedBindingDrift = makeReader(midReadFixedBindingDriftBrowser);
  await assert.rejects(
    () => read(midReadFixedBindingDrift.reader),
    (error) => error.code === "BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED"
  );
  assert.strictEqual(
    midReadFixedBindingDriftBrowser.calls.filter((call) => call.name === "evalValue"
      && call.expression.includes("__bossMessageDetailSnapshot")).length,
    0,
    "a fixed BOSS tab that drifts during readiness polling must stop before reading the job snapshot"
  );
  assert.strictEqual(midReadFixedBindingDriftBrowser.calls.filter((call) => call.name === "createTab").length, 1);
  assert.strictEqual(midReadFixedBindingDriftBrowser.calls.filter((call) => call.name === "closeTab").length, 1);

  const scriptDiagnosticEvents = [];
  const scriptFailureBrowser = fakeBrowser({
    communicationScriptFailure: {
      errorName: "TypeError",
      errorKind: "null_member",
      errorMember: "getBoundingClientRect"
    }
  });
  const scriptFailure = makeReader(scriptFailureBrowser, {
    logger: { warn(event, fields) { scriptDiagnosticEvents.push({ event, fields }); } }
  });
  await assert.rejects(
    () => read(scriptFailure.reader),
    (error) => error.code === "BOSS_MESSAGE_DETAIL_BROWSER_FAILED"
  );
  assert.deepStrictEqual(scriptDiagnosticEvents[0]?.fields, {
    phase: "read_page_state",
    code: "BOSS_MESSAGE_DETAIL_BROWSER_FAILED",
    causeCode: "BROWSER_COMMAND_FAILED",
    scriptErrorName: "TypeError",
    scriptErrorKind: "null_member",
    scriptErrorMember: "getBoundingClientRect"
  });
  assert.deepStrictEqual(scriptFailureBrowser.tabs, baseTabs());

  const cleanupDiagnosticEvents = [];
  const cleanupFailureBrowser = fakeBrowser({
    evalErrorPattern: "(function __roleflowSafeCommunicationSnapshot",
    listErrorAtCall: 6
  });
  const cleanupFailure = makeReader(cleanupFailureBrowser, {
    logger: { warn(event, fields) { cleanupDiagnosticEvents.push({ event, fields }); } }
  });
  await assert.rejects(
    () => read(cleanupFailure.reader),
    (error) => error.code === "BOSS_MESSAGE_DETAIL_BROWSER_FAILED"
  );
  assert.strictEqual(cleanupDiagnosticEvents[0]?.fields?.phase, "cleanup_attribute_tab");
  assert.strictEqual(cleanupDiagnosticEvents[0]?.fields?.causeCode, "BROWSER_DISCONNECTED");

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

  const cleanupBrowserEvents = [];
  const cleanupBrowser = fakeBrowser();
  const cleanupBrowserFailure = makeReader(cleanupBrowser, {
    identityError: Object.assign(new Error(`bridge failed ${SECRET}`), { code: "BROWSER_COMMAND_FAILED" }),
    logger: { warn(event, fields) { cleanupBrowserEvents.push({ event, fields }); } }
  });
  await assert.rejects(
    () => read(cleanupBrowserFailure.reader),
    (error) => error.code === "BOSS_MESSAGE_DETAIL_BROWSER_FAILED"
  );
  assert.strictEqual(cleanupBrowserEvents[0]?.fields?.phase, "cleanup_recheck_message");
  assert.strictEqual(cleanupBrowserEvents[0]?.fields?.causeCode, "BROWSER_COMMAND_FAILED");
  assert.doesNotMatch(JSON.stringify(cleanupBrowserEvents), new RegExp(SECRET));

  console.log("boss_message_detail_reader_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
