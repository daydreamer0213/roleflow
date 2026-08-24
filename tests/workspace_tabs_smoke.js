const assert = require("node:assert");
const {
  prepareWorkspaceTabs,
  assertBossOperatorTabs,
  inspectBossOperatorTabs,
  assertBossRuntimeTabBindings
} = require("../src/core/workspace_tabs");
const { prepareWorkspaceTabsCommand } = require("../src/cli");

function fakeBrowser(initialTabs, createdTab = null) {
  const state = {
    tabs: initialTabs.map((tab) => ({ ...tab })),
    createCalls: [],
    frontCalls: [],
    closeCalls: [],
    listCalls: 0
  };
  return {
    state,
    async listTabs() { state.listCalls += 1; return state.tabs.map((tab) => ({ ...tab })); },
    async createTab(openerTabId, url) {
      state.createCalls.push({ openerTabId, url });
      if (!createdTab) throw new Error("unexpected createTab");
      if (!createdTab.omitFromList) state.tabs.push({ ...createdTab, url });
      return createdTab.returnId || createdTab.id;
    },
    async closeTab(tabId) {
      state.closeCalls.push(tabId);
      state.tabs = state.tabs.filter((tab) => tab.id !== tabId);
      return { success: true };
    },
    async bringToFront(tabId) {
      state.frontCalls.push(tabId);
      const selected = state.tabs.find((tab) => tab.id === tabId);
      if (selected) {
        for (const tab of state.tabs) {
          if (tab.windowId === selected.windowId) tab.active = tab.id === tabId;
        }
      }
    }
  };
}

function dedicatedBrowser(initialTabs, createdTabs = []) {
  const browser = fakeBrowser(initialTabs);
  browser.state.createdTabs = createdTabs.map((tab) => ({ ...tab }));
  browser.createTab = async (openerTabId, url) => {
    browser.state.createCalls.push({ openerTabId, url });
    const next = browser.state.createdTabs.shift();
    if (!next) throw new Error("unexpected createTab");
    const tab = { ...next, url: next.resolvedUrl || url };
    if (!next.omitFromList) browser.state.tabs.push(tab);
    return next.returnId ?? next.id;
  };
  return browser;
}

(async () => {
  const boss = {
    id: "boss-search",
    url: "https://www.zhipin.com/web/geek/jobs",
    windowId: 42
  };
  const fixedCommunication = {
    id: "boss-communication",
    url: "https://www.zhipin.com/web/geek/chat",
    windowId: 42
  };
  assert.strictEqual(typeof inspectBossOperatorTabs, "function");
  const inspectionCalls = [];
  const strictInspection = await inspectBossOperatorTabs({
    browser: fakeBrowser([boss, fixedCommunication, {
      id: "unrelated-non-boss",
      url: "https://example.invalid/notes",
      windowId: 99
    }]),
    inspectTab: async (tabId) => {
      inspectionCalls.push(tabId);
      return String(tabId) === String(fixedCommunication.id)
        ? { tabId, url: fixedCommunication.url, isSearchPage: false }
        : { tabId, url: boss.url, isSearchPage: true };
    }
  });
  assert.deepStrictEqual(inspectionCalls, [fixedCommunication.id, boss.id]);
  assert.deepStrictEqual({
    searchTabId: strictInspection.searchTab.id,
    communicationTabId: strictInspection.communicationTab.id,
    searchState: strictInspection.searchState,
    communicationState: strictInspection.communicationState,
    windowId: strictInspection.windowId
  }, {
    searchTabId: boss.id,
    communicationTabId: fixedCommunication.id,
    searchState: { tabId: boss.id, url: boss.url, isSearchPage: true },
    communicationState: { tabId: fixedCommunication.id, url: fixedCommunication.url, isSearchPage: false },
    windowId: 42
  });
  for (const unmanagedBoss of [
    { id: "same-window-boss-detail", url: "https://www.zhipin.com/job_detail/extra.html", windowId: 42 },
    { id: "other-window-boss-detail", url: "https://www.zhipin.com/job_detail/extra.html", windowId: 99 }
  ]) {
    assert.throws(
      () => assertBossOperatorTabs([boss, fixedCommunication, unmanagedBoss]),
      (error) => error.code === "BOSS_TAB_REQUIRED"
    );
    let unmanagedInspectionCalls = 0;
    await assert.rejects(() => inspectBossOperatorTabs({
      browser: fakeBrowser([boss, fixedCommunication, unmanagedBoss]),
      inspectTab: async () => { unmanagedInspectionCalls += 1; }
    }), (error) => error.code === "BOSS_TAB_REQUIRED");
    assert.strictEqual(unmanagedInspectionCalls, 0);
  }

  let multipleVisibleInspectionCalls = 0;
  await assert.rejects(() => inspectBossOperatorTabs({
    browser: fakeBrowser([
      { ...boss, active: true },
      { ...fixedCommunication, active: true }
    ]),
    inspectTab: async () => { multipleVisibleInspectionCalls += 1; }
  }), (error) => error.code === "BROWSER_COMMAND_FAILED");
  assert.strictEqual(multipleVisibleInspectionCalls, 0);

  const zeroVisibleInspectionCalls = [];
  await inspectBossOperatorTabs({
    browser: fakeBrowser([
      { ...boss, active: false },
      { ...fixedCommunication, active: false }
    ]),
    inspectTab: async (tabId) => {
      zeroVisibleInspectionCalls.push(tabId);
      return tabId === fixedCommunication.id
        ? { tabId, url: fixedCommunication.url, isSearchPage: false }
        : { tabId, url: boss.url, isSearchPage: true };
    }
  });
  assert.deepStrictEqual(zeroVisibleInspectionCalls, [fixedCommunication.id, boss.id]);

  let visibleDriftListCalls = 0;
  await assert.rejects(() => inspectBossOperatorTabs({
    browser: {
      async listTabs() {
        visibleDriftListCalls += 1;
        return visibleDriftListCalls === 1
          ? [{ ...boss, active: true }, { ...fixedCommunication, active: false }]
          : [{ ...boss, active: false }, { ...fixedCommunication, active: true }];
      }
    },
    inspectTab: async (tabId) => tabId === fixedCommunication.id
      ? { tabId, url: fixedCommunication.url, isSearchPage: false }
      : { tabId, url: boss.url, isSearchPage: true }
  }), (error) => error.code === "BROWSER_COMMAND_FAILED");
  const communicationLostCalls = [];
  await assert.rejects(
    () => inspectBossOperatorTabs({
      browser: fakeBrowser([boss, fixedCommunication]),
      inspectTab: async (tabId) => {
        communicationLostCalls.push(tabId);
        return { tabId, url: boss.url, isSearchPage: true };
      }
    }),
    (error) => error.code === "BOSS_COMMUNICATION_PAGE_LOST"
  );
  assert.deepStrictEqual(communicationLostCalls, [fixedCommunication.id]);
  let listCalls = 0;
  const driftingBrowser = {
    async listTabs() {
      listCalls += 1;
      return listCalls === 1
        ? [boss, fixedCommunication]
        : [{ ...boss, id: "replacement-search" }, fixedCommunication];
    }
  };
  await assert.rejects(
    () => inspectBossOperatorTabs({
      browser: driftingBrowser,
      expectedSearchTabId: boss.id,
      expectedCommunicationTabId: fixedCommunication.id,
      inspectTab: async (tabId) => String(tabId) === String(fixedCommunication.id)
        ? { tabId, url: fixedCommunication.url, isSearchPage: false }
        : { tabId, url: boss.url, isSearchPage: true }
    }),
    (error) => error.code === "BOSS_SEARCH_TAB_CHANGED"
  );
  let pathDriftListCalls = 0;
  await assert.rejects(
    () => inspectBossOperatorTabs({
      browser: {
        async listTabs() {
          pathDriftListCalls += 1;
          return pathDriftListCalls === 1
            ? [boss, fixedCommunication]
            : [{ ...boss, url: "https://www.zhipin.com/web/geek/chat?drift=1" }, fixedCommunication];
        }
      },
      inspectTab: async (tabId) => String(tabId) === String(fixedCommunication.id)
        ? { tabId, url: fixedCommunication.url, isSearchPage: false }
        : { tabId, url: boss.url, isSearchPage: true }
    }),
    (error) => error.code === "BOSS_SEARCH_TAB_CHANGED"
  );
  assert.deepStrictEqual(
    assertBossOperatorTabs([boss, fixedCommunication]),
    {
      searchTab: boss,
      communicationTab: fixedCommunication,
      windowId: 42
    }
  );
  assert.strictEqual(typeof assertBossRuntimeTabBindings, "function");
  assert.deepStrictEqual(
    assertBossRuntimeTabBindings([
      { ...boss, url: "https://www.zhipin.com/job_detail/runtime-bound.html" },
      fixedCommunication
    ], {
      expectedSearchTabId: boss.id,
      expectedCommunicationTabId: fixedCommunication.id
    }),
    {
      searchTab: { ...boss, url: "https://www.zhipin.com/job_detail/runtime-bound.html" },
      communicationTab: fixedCommunication,
      windowId: 42
    }
  );
  assert.throws(
    () => assertBossRuntimeTabBindings([boss, { ...fixedCommunication, id: "replacement-chat" }], {
      expectedSearchTabId: boss.id,
      expectedCommunicationTabId: fixedCommunication.id
    }),
    (error) => error.code === "BOSS_OPERATOR_TABS_CHANGED"
  );
  assert.throws(
    () => assertBossOperatorTabs([boss]),
    (error) => error.code === "BOSS_TAB_REQUIRED"
  );
  assert.throws(
    () => assertBossOperatorTabs([
      boss,
      { ...fixedCommunication, windowId: 99 }
    ]),
    (error) => error.code === "BOSS_WINDOW_MISMATCH"
  );
  assert.throws(
    () => assertBossOperatorTabs([
      boss,
      { ...boss, id: "duplicate-boss-search" },
      fixedCommunication
    ]),
    (error) => error.code === "BOSS_TAB_REQUIRED"
  );
  assert.throws(
    () => assertBossOperatorTabs([
      boss,
      { ...fixedCommunication, windowId: undefined }
    ]),
    (error) => error.code === "BROWSER_COMMAND_FAILED"
  );
  assert.doesNotThrow(
    () => assertBossOperatorTabs([
      boss,
      fixedCommunication,
      {
        id: "ordinary-edge-unrelated",
        url: "https://example.invalid/",
        windowId: 99
      }
    ]),
    "unrelated non-BOSS Edge windows must not invalidate the fixed BOSS pair"
  );
  const dashboard = {
    id: "roleflow-dashboard",
    url: "http://127.0.0.1:8787/",
    windowId: 42
  };

  const dashboardOnlyLoginQuiet = dedicatedBrowser([
    { ...dashboard, active: true }
  ], [
    { id: "CDP-dashboard-login-quiet", windowId: 42, active: false }
  ]);
  const dashboardOnlyLoginQuietResult = await prepareWorkspaceTabs({
    browser: dashboardOnlyLoginQuiet,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    allowStartupGuidance: false,
    inspectReadiness: async ({ guidanceTab, fixedTabs }) => {
      assert.strictEqual(guidanceTab.id, "CDP-dashboard-login-quiet");
      assert.strictEqual(fixedTabs, null);
      return { status: "login_required" };
    }
  });
  assert.deepStrictEqual(dashboardOnlyLoginQuietResult, {
    bossTabId: "CDP-dashboard-login-quiet",
    communicationTabId: null,
    dashboardTabId: dashboard.id,
    windowId: 42,
    status: "login_required"
  });
  assert.deepStrictEqual(dashboardOnlyLoginQuiet.state.createCalls, [{
    openerTabId: dashboard.id,
    url: "https://www.zhipin.com/web/geek/jobs"
  }]);
  assert.deepStrictEqual(dashboardOnlyLoginQuiet.state.frontCalls, []);

  const dashboardOnlyLoginGuided = dedicatedBrowser([
    { ...dashboard, active: true }
  ], [
    { id: "CDP-dashboard-login-guided", windowId: 42, active: false }
  ]);
  const dashboardOnlyLoginGuidedResult = await prepareWorkspaceTabs({
    browser: dashboardOnlyLoginGuided,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    allowStartupGuidance: true,
    inspectReadiness: async () => ({ status: "login_required" })
  });
  assert.strictEqual(dashboardOnlyLoginGuidedResult.status, "login_required");
  assert.deepStrictEqual(dashboardOnlyLoginGuided.state.createCalls, [{
    openerTabId: dashboard.id,
    url: "https://www.zhipin.com/web/geek/jobs"
  }]);
  assert.deepStrictEqual(dashboardOnlyLoginGuided.state.frontCalls, ["CDP-dashboard-login-guided"]);

  const dashboardOnlyRedirectedLogin = dedicatedBrowser([
    { ...dashboard, active: true }
  ], [
    {
      id: "CDP-dashboard-login-redirect",
      windowId: 42,
      active: false,
      resolvedUrl: "https://www.zhipin.com/"
    }
  ]);
  let redirectedLoginInspections = 0;
  const dashboardOnlyRedirectedLoginResult = await prepareWorkspaceTabs({
    browser: dashboardOnlyRedirectedLogin,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    allowStartupGuidance: true,
    inspectReadiness: async ({ guidanceTab }) => {
      redirectedLoginInspections += 1;
      assert.strictEqual(guidanceTab.id, "CDP-dashboard-login-redirect");
      assert.strictEqual(guidanceTab.url, "https://www.zhipin.com/");
      return { status: "login_required" };
    }
  });
  assert.strictEqual(dashboardOnlyRedirectedLoginResult.status, "login_required");
  assert.strictEqual(redirectedLoginInspections, 1);
  assert.deepStrictEqual(dashboardOnlyRedirectedLogin.state.closeCalls, []);
  assert.deepStrictEqual(dashboardOnlyRedirectedLogin.state.frontCalls, ["CDP-dashboard-login-redirect"]);

  const dashboardOnlyTransitionReady = dedicatedBrowser([
    { ...dashboard, active: true }
  ], [
    {
      id: "CDP-dashboard-transition-search",
      windowId: 42,
      active: false,
      resolvedUrl: "https://www.zhipin.com/"
    },
    { id: "CDP-dashboard-transition-chat", windowId: 42, active: false }
  ]);
  const dashboardOnlyTransitionResult = await prepareWorkspaceTabs({
    browser: dashboardOnlyTransitionReady,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    allowStartupGuidance: false,
    inspectReadiness: async () => {
      dashboardOnlyTransitionReady.state.tabs.find(
        (tab) => tab.id === "CDP-dashboard-transition-search"
      ).url = "https://www.zhipin.com/web/geek/jobs";
      return { status: "ready" };
    }
  });
  assert.strictEqual(dashboardOnlyTransitionResult.status, "ready");
  assert.deepStrictEqual(dashboardOnlyTransitionReady.state.createCalls, [
    { openerTabId: dashboard.id, url: "https://www.zhipin.com/web/geek/jobs" },
    { openerTabId: "CDP-dashboard-transition-search", url: "https://www.zhipin.com/web/geek/chat" }
  ]);
  assert.deepStrictEqual(dashboardOnlyTransitionReady.state.closeCalls, []);

  const searchDriftAfterReadiness = dedicatedBrowser([
    { ...boss, active: true }
  ], [
    { id: "must-not-create-chat-after-drift", windowId: 42, active: false }
  ]);
  const searchDriftResult = await prepareWorkspaceTabs({
    browser: searchDriftAfterReadiness,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    allowStartupGuidance: false,
    inspectReadiness: async () => {
      searchDriftAfterReadiness.state.tabs[0].url = "https://www.zhipin.com/job_detail/drift.html";
      return { status: "ready" };
    }
  });
  assert.strictEqual(searchDriftResult.status, "ambiguous");
  assert.deepStrictEqual(searchDriftAfterReadiness.state.createCalls, []);

  const dashboardOnlyReady = dedicatedBrowser([
    { ...dashboard, active: true }
  ], [
    { id: "CDP-dashboard-search", windowId: 42, active: false },
    { id: "CDP-dashboard-chat", windowId: 42, active: false }
  ]);
  const dashboardOnlyReadyResult = await prepareWorkspaceTabs({
    browser: dashboardOnlyReady,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    allowStartupGuidance: true,
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.deepStrictEqual(dashboardOnlyReadyResult, {
    bossTabId: "CDP-dashboard-search",
    communicationTabId: "CDP-dashboard-chat",
    dashboardTabId: dashboard.id,
    windowId: 42,
    status: "ready"
  });
  assert.deepStrictEqual(dashboardOnlyReady.state.createCalls, [
    { openerTabId: dashboard.id, url: "https://www.zhipin.com/web/geek/jobs" },
    { openerTabId: "CDP-dashboard-search", url: "https://www.zhipin.com/web/geek/chat" }
  ]);
  assert.deepStrictEqual(dashboardOnlyReady.state.frontCalls, [dashboard.id]);

  const completedCreateCount = dashboardOnlyReady.state.createCalls.length;
  const completedFrontCount = dashboardOnlyReady.state.frontCalls.length;
  const repeatedResult = await prepareWorkspaceTabs({
    browser: dashboardOnlyReady,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    allowStartupGuidance: false,
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.strictEqual(repeatedResult.status, "ready");
  assert.strictEqual(dashboardOnlyReady.state.createCalls.length, completedCreateCount);
  assert.strictEqual(dashboardOnlyReady.state.frontCalls.length, completedFrontCount);

  const hiddenDashboardOnly = dedicatedBrowser([
    { ...dashboard, active: false }
  ], [{ id: "must-not-be-created", windowId: 42, active: false }]);
  const hiddenDashboardResult = await prepareWorkspaceTabs({
    browser: hiddenDashboardOnly,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    allowStartupGuidance: false,
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.strictEqual(hiddenDashboardResult.status, "ambiguous");
  assert.strictEqual(hiddenDashboardResult.errorCode, "BROWSER_COMMAND_FAILED");
  assert.deepStrictEqual(hiddenDashboardOnly.state.createCalls, []);

  for (const ambiguousTabs of [
    [{ ...dashboard, active: true }, { ...boss, active: false }, { ...boss, id: "second-boss", active: false }],
    [{ ...dashboard, active: true }, { id: "other-window", url: "https://example.invalid/", windowId: 99, active: false }]
  ]) {
    const ambiguous = dedicatedBrowser(ambiguousTabs);
    const ambiguousResult = await prepareWorkspaceTabs({
      browser: ambiguous,
      dashboardUrl: dashboard.url,
      bootstrapDedicatedTabs: true,
      allowStartupGuidance: false,
      inspectReadiness: async () => ({ status: "ready" })
    });
    assert.strictEqual(ambiguousResult.status, "ambiguous");
    assert.deepStrictEqual(ambiguous.state.createCalls, []);
    assert.deepStrictEqual(ambiguous.state.closeCalls, []);
  }

  const dashboardBootstrapCleanup = dedicatedBrowser([
    { ...dashboard, active: true }
  ], [
    { id: "CDP-cleanup-search", windowId: 42, active: false },
    { id: "CDP-cleanup-chat", windowId: 42, active: true }
  ]);
  const dashboardBootstrapCleanupResult = await prepareWorkspaceTabs({
    browser: dashboardBootstrapCleanup,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    allowStartupGuidance: false,
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.strictEqual(dashboardBootstrapCleanupResult.status, "ambiguous");
  assert.strictEqual(dashboardBootstrapCleanupResult.errorCode, "BROWSER_COMMAND_FAILED");
  assert.deepStrictEqual(dashboardBootstrapCleanup.state.createCalls, [
    { openerTabId: dashboard.id, url: "https://www.zhipin.com/web/geek/jobs" },
    { openerTabId: "CDP-cleanup-search", url: "https://www.zhipin.com/web/geek/chat" }
  ]);
  assert.deepStrictEqual(dashboardBootstrapCleanup.state.closeCalls, [
    "CDP-cleanup-chat",
    "CDP-cleanup-search"
  ]);
  assert.deepStrictEqual(dashboardBootstrapCleanup.state.tabs, [{ ...dashboard, active: true }]);

  const loginTab = { id: "CDP-login", url: "https://www.zhipin.com/", windowId: 42, active: true };
  const loginBrowser = dedicatedBrowser([loginTab]);
  const loginInspections = [];
  const loginResult = await prepareWorkspaceTabs({
    browser: loginBrowser,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    allowStartupGuidance: true,
    inspectReadiness: async (context) => {
      loginInspections.push(context);
      return { status: "login_required" };
    }
  });
  assert.strictEqual(loginResult.status, "login_required");
  assert.deepStrictEqual(loginInspections, [{ guidanceTab: loginTab, fixedTabs: null }]);
  assert.deepStrictEqual(loginBrowser.state.createCalls, []);
  assert.deepStrictEqual(loginBrowser.state.frontCalls, [loginTab.id]);

  for (const readiness of ["risk_control", "search_page_required", "browser_unavailable", "not_ready"]) {
    const stopped = dedicatedBrowser([{ ...boss, active: true }]);
    const result = await prepareWorkspaceTabs({
      browser: stopped,
      dashboardUrl: dashboard.url,
      bootstrapDedicatedTabs: true,
      inspectReadiness: async ({ guidanceTab, fixedTabs }) => {
        assert.strictEqual(guidanceTab.id, boss.id);
        assert.strictEqual(fixedTabs, null);
        return { status: readiness };
      }
    });
    assert.strictEqual(result.status, readiness);
    assert.deepStrictEqual(stopped.state.createCalls, []);
    assert.deepStrictEqual(stopped.state.frontCalls, []);
  }

  const inspectionFailure = dedicatedBrowser([{ ...boss, active: true }]);
  await assert.rejects(() => prepareWorkspaceTabs({
    browser: inspectionFailure,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    inspectReadiness: async () => { throw new Error("fixture readiness failure"); }
  }), /fixture readiness failure/);
  assert.deepStrictEqual(inspectionFailure.state.createCalls, []);
  assert.deepStrictEqual(inspectionFailure.state.frontCalls, []);

  const bootstrapped = dedicatedBrowser([{ ...boss, active: true }], [
    { id: "CDP-chat", windowId: 42, active: false },
    { id: "CDP-dashboard", windowId: 42, active: false }
  ]);
  const bootstrappedResult = await prepareWorkspaceTabs({
    browser: bootstrapped,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    allowStartupGuidance: true,
    inspectReadiness: async ({ guidanceTab, fixedTabs }) => {
      assert.strictEqual(guidanceTab.id, boss.id);
      assert.strictEqual(fixedTabs, null);
      return { status: "ready" };
    }
  });
  assert.deepStrictEqual(bootstrappedResult, {
    bossTabId: boss.id,
    communicationTabId: "CDP-chat",
    dashboardTabId: "CDP-dashboard",
    windowId: 42,
    status: "ready"
  });
  assert.deepStrictEqual(bootstrapped.state.createCalls, [
    { openerTabId: boss.id, url: "https://www.zhipin.com/web/geek/chat" },
    { openerTabId: boss.id, url: dashboard.url }
  ]);
  assert.deepStrictEqual(bootstrapped.state.frontCalls, ["CDP-dashboard"]);

  const redirectedDashboard = dedicatedBrowser([{ ...boss, active: true }], [
    { id: "CDP-chat-redirect", windowId: 42, active: false },
    {
      id: "CDP-dashboard-redirect",
      windowId: 42,
      active: false,
      resolvedUrl: "http://127.0.0.1:8787/settings?firstRun=1"
    }
  ]);
  const redirectedResult = await prepareWorkspaceTabs({
    browser: redirectedDashboard,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    allowStartupGuidance: true,
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.strictEqual(redirectedResult.dashboardTabId, "CDP-dashboard-redirect");
  assert.deepStrictEqual(redirectedDashboard.state.frontCalls, ["CDP-dashboard-redirect"]);

  const invalidTopologies = [
    [{ ...boss, active: true }, { ...boss, id: "duplicate-search", active: false }],
    [{ ...boss, active: true }, fixedCommunication, { ...fixedCommunication, id: "duplicate-chat" }],
    [{ ...boss, active: true }, fixedCommunication, { id: "unmanaged", url: "https://www.zhipin.com/job_detail/x.html", windowId: 42 }],
    [{ ...boss, active: true }, { ...fixedCommunication, windowId: 99 }],
    [{ ...boss, windowId: undefined, active: true }]
  ];
  for (const tabs of invalidTopologies) {
    const invalid = dedicatedBrowser(tabs);
    let inspections = 0;
    const invalidResult = await prepareWorkspaceTabs({
      browser: invalid,
      dashboardUrl: dashboard.url,
      bootstrapDedicatedTabs: true,
      inspectReadiness: async () => { inspections += 1; return { status: "ready" }; }
    });
    assert.strictEqual(invalidResult.status, "ambiguous");
    assert.strictEqual(inspections, 0);
    assert.deepStrictEqual(invalid.state.createCalls, []);
    assert.deepStrictEqual(invalid.state.frontCalls, []);
  }

  const duplicateDashboard = dedicatedBrowser([
    { ...boss, active: true }, fixedCommunication, dashboard, { ...dashboard, id: "dashboard-2" }
  ]);
  const duplicateDashboardResult = await prepareWorkspaceTabs({
    browser: duplicateDashboard,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.strictEqual(duplicateDashboardResult.status, "ambiguous");
  assert.strictEqual(duplicateDashboardResult.errorCode, "WORKSPACE_DASHBOARD_TAB_AMBIGUOUS");
  assert.deepStrictEqual(duplicateDashboard.state.closeCalls, []);

  const noVisible = dedicatedBrowser([{ ...boss, active: false }]);
  const noVisibleResult = await prepareWorkspaceTabs({
    browser: noVisible,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.strictEqual(noVisibleResult.status, "ambiguous");
  assert.strictEqual(noVisibleResult.errorCode, "BROWSER_COMMAND_FAILED");
  assert.match(noVisibleResult.message, /恢复.*专用 Edge/);
  assert.deepStrictEqual(noVisible.state.createCalls, []);
  assert.deepStrictEqual(noVisible.state.frontCalls, []);

  const completeButHidden = dedicatedBrowser([
    { ...boss, active: false },
    { ...fixedCommunication, active: false },
    { ...dashboard, active: false }
  ]);
  const completeHiddenResult = await prepareWorkspaceTabs({
    browser: completeButHidden,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    allowStartupGuidance: true,
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.strictEqual(completeHiddenResult.status, "ready");
  assert.deepStrictEqual(completeButHidden.state.createCalls, []);
  assert.deepStrictEqual(completeButHidden.state.frontCalls, [dashboard.id]);

  const hiddenWindowDrift = dedicatedBrowser([
    { ...boss, active: false },
    { ...fixedCommunication, active: false },
    { ...dashboard, active: false }
  ]);
  const hiddenWindowDriftResult = await prepareWorkspaceTabs({
    browser: hiddenWindowDrift,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    allowStartupGuidance: true,
    inspectReadiness: async () => {
      for (const tab of hiddenWindowDrift.state.tabs) tab.windowId = 99;
      return { status: "ready" };
    }
  });
  assert.strictEqual(hiddenWindowDriftResult.status, "ambiguous");
  assert.strictEqual(hiddenWindowDriftResult.errorCode, "WORKSPACE_WINDOW_MISMATCH");
  assert.deepStrictEqual(hiddenWindowDrift.state.frontCalls, []);

  const multipleVisible = dedicatedBrowser([
    { ...boss, active: true },
    { id: "visible-user-page", url: "https://example.invalid/", windowId: 42, active: true }
  ]);
  let multipleVisibleInspections = 0;
  const multipleVisibleResult = await prepareWorkspaceTabs({
    browser: multipleVisible,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    inspectReadiness: async () => { multipleVisibleInspections += 1; return { status: "risk_control" }; }
  });
  assert.strictEqual(multipleVisibleResult.status, "ambiguous");
  assert.strictEqual(multipleVisibleResult.errorCode, "BROWSER_COMMAND_FAILED");
  assert.strictEqual(multipleVisibleInspections, 0, "two visible pages invalidate even read-only startup inspection");

  const foregroundChat = dedicatedBrowser([{ ...boss, active: true }, {
    id: "unrelated-user-page", url: "https://example.invalid/", windowId: 42, active: false
  }], [{ id: "CDP-chat-foreground", windowId: 42, active: true }]);
  const foregroundChatResult = await prepareWorkspaceTabs({
    browser: foregroundChat,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.strictEqual(foregroundChatResult.status, "ambiguous");
  assert.deepStrictEqual(foregroundChat.state.closeCalls, ["CDP-chat-foreground"]);
  assert(foregroundChat.state.tabs.some((tab) => tab.id === "unrelated-user-page"));
  assert.deepStrictEqual(foregroundChat.state.frontCalls, []);
  assert(foregroundChat.state.listCalls >= 3, "cleanup must re-list and re-prove the typed baseline");

  const foregroundDashboard = dedicatedBrowser([{ ...boss, active: true }], [
    { id: "CDP-chat-cleanup", windowId: 42, active: false },
    { id: "CDP-dashboard-foreground", windowId: 42, active: true }
  ]);
  const foregroundDashboardResult = await prepareWorkspaceTabs({
    browser: foregroundDashboard,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.strictEqual(foregroundDashboardResult.status, "ambiguous");
  assert.deepStrictEqual(
    foregroundDashboard.state.closeCalls,
    ["CDP-dashboard-foreground", "CDP-chat-cleanup"],
    "bootstrap cleanup closes only invocation-owned tabs in reverse order"
  );
  assert.deepStrictEqual(foregroundDashboard.state.frontCalls, []);

  const transientCleanup = dedicatedBrowser([{ ...boss, active: true }], [
    { id: "CDP-chat-transient-cleanup", windowId: 42, active: false },
    {
      id: "CDP-dashboard-wrong-origin",
      windowId: 42,
      active: false,
      resolvedUrl: "http://127.0.0.1:9876/"
    }
  ]);
  const listTransientCleanup = transientCleanup.listTabs.bind(transientCleanup);
  transientCleanup.listTabs = async () => {
    if (transientCleanup.state.listCalls === 5) {
      transientCleanup.state.listCalls += 1;
      const error = new Error("fixture closed target is still disappearing");
      error.code = "BROWSER_DISCONNECTED";
      throw error;
    }
    return listTransientCleanup();
  };
  const transientCleanupResult = await prepareWorkspaceTabs({
    browser: transientCleanup,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.strictEqual(transientCleanupResult.status, "ambiguous");
  assert.strictEqual(transientCleanupResult.errorCode, "WORKSPACE_DASHBOARD_TAB_REQUIRED");
  assert.deepStrictEqual(
    transientCleanup.state.closeCalls,
    ["CDP-dashboard-wrong-origin", "CDP-chat-transient-cleanup"]
  );
  assert.doesNotMatch(transientCleanupResult.message, /清理失败/);

  const failedFocus = dedicatedBrowser([
    { ...boss, active: true }, fixedCommunication, { ...dashboard, active: false }
  ]);
  failedFocus.bringToFront = async (tabId) => { failedFocus.state.frontCalls.push(tabId); };
  const failedFocusResult = await prepareWorkspaceTabs({
    browser: failedFocus,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    allowStartupGuidance: true,
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.strictEqual(failedFocusResult.status, "ambiguous");
  assert.deepStrictEqual(failedFocus.state.frontCalls, [dashboard.id], "startup focus guidance must not retry");

  const typedRuntimeTabs = [
    { id: 42, url: boss.url, windowId: 42 },
    { id: "42", url: fixedCommunication.url, windowId: 42 }
  ];
  assert.throws(() => assertBossRuntimeTabBindings(typedRuntimeTabs, {
    expectedSearchTabId: "42",
    expectedCommunicationTabId: "42"
  }), (error) => error.code === "BOSS_SEARCH_TAB_CHANGED");

  function workspaceCommandDependencies(calls) {
    const browser = {
      kind: `${calls.label}-browser`,
      async listTabs() {
        calls.browserList += 1;
        return calls.liveTabs.map((tab) => ({ ...tab }));
      }
    };
    return {
      browserFactory: (args) => {
        calls.browser.push(args);
        return browser;
      },
      siteAdapterFactory: (site, context) => {
        calls.adapter.push({ site, context });
        return {
          async preflight(options) {
            calls.preflight.push(options);
            return String(options?.tabId) === String(calls.fixedTabs.communicationTab.id)
              ? { tabId: options.tabId, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false }
              : { tabId: options?.tabId, url: "https://www.zhipin.com/web/geek/jobs", isSearchPage: true };
          }
        };
      },
      prepareTabs: async ({
        browser: receivedBrowser,
        dashboardUrl,
        requireFixedBossTabs,
        bootstrapDedicatedTabs,
        allowStartupGuidance,
        inspectReadiness
      }) => {
        assert.strictEqual(receivedBrowser, browser);
        assert.strictEqual(dashboardUrl, "http://localhost:8787/workspace");
        calls.requireFixedBossTabs = requireFixedBossTabs;
        calls.bootstrapDedicatedTabs = bootstrapDedicatedTabs;
        calls.allowStartupGuidance = allowStartupGuidance;
        assert.strictEqual((await inspectReadiness({
          guidanceTab: calls.fixedTabs.searchTab,
          fixedTabs: calls.fixedTabs
        })).status, "ready");
        return { status: "ready" };
      }
    };
  }

  const commandCalls = {
    label: "edge",
    browser: [],
    adapter: [],
    preflight: [],
    browserList: 0,
    requireFixedBossTabs: null,
    bootstrapDedicatedTabs: null,
    allowStartupGuidance: null,
    fixedTabs: {
      searchTab: { id: "fixed-search", url: "https://www.zhipin.com/web/geek/jobs", windowId: 55 },
      communicationTab: { id: "fixed-communication", url: "https://www.zhipin.com/web/geek/chat", windowId: 55 }
    },
    liveTabs: [
      { id: "fixed-search", url: "https://www.zhipin.com/web/geek/jobs", windowId: 55 },
      { id: "fixed-communication", url: "https://www.zhipin.com/web/geek/chat", windowId: 55 }
    ]
  };
  const commandResult = await prepareWorkspaceTabsCommand({
    "dashboard-url": "http://localhost:8787/workspace"
  }, workspaceCommandDependencies(commandCalls));
  assert.deepStrictEqual(commandResult, { status: "ready" });
  assert.deepStrictEqual(commandCalls.browser, [{ browser: "edge" }]);
  assert.strictEqual(commandCalls.requireFixedBossTabs, true);
  assert.strictEqual(commandCalls.bootstrapDedicatedTabs, false);
  assert.strictEqual(commandCalls.allowStartupGuidance, true);
  assert.strictEqual(commandCalls.browserList, 2);
  assert.strictEqual(commandCalls.adapter[0].site, "boss");
  assert.deepStrictEqual(commandCalls.preflight, [
    { tabId: "fixed-communication" },
    { tabId: "fixed-search" }
  ]);

  const portableCalls = {
    label: "portable",
    browser: [],
    adapter: [],
    preflight: [],
    browserList: 0,
    requireFixedBossTabs: null
  };
  portableCalls.fixedTabs = commandCalls.fixedTabs;
  portableCalls.liveTabs = commandCalls.liveTabs;
  await prepareWorkspaceTabsCommand({
    browser: "portable",
    "cdp-port": 9222,
    "dashboard-url": "http://localhost:8787/workspace"
  }, workspaceCommandDependencies(portableCalls));
  assert.deepStrictEqual(portableCalls.browser, [{
    browser: "portable",
    "cdp-port": 9222
  }]);
  assert.strictEqual(portableCalls.requireFixedBossTabs, true);
  assert.strictEqual(portableCalls.bootstrapDedicatedTabs, true);
  assert.strictEqual(portableCalls.allowStartupGuidance, true);
  assert.strictEqual(portableCalls.browserList, 2);
  assert.deepStrictEqual(portableCalls.preflight, [
    { tabId: "fixed-communication" },
    { tabId: "fixed-search" }
  ]);

  await assert.rejects(
    () => prepareWorkspaceTabsCommand({
      browser: "portable",
      "cdp-port": 9333
    }),
    (error) => error.code === "WORKSPACE_PORTABLE_BROWSER_REQUIRED"
  );
  await assert.rejects(
    () => prepareWorkspaceTabsCommand({ "dashboard-url": "https://example.test/" }),
    (error) => error.code === "WORKSPACE_DASHBOARD_URL_INVALID"
  );

  console.log("workspace_tabs_smoke ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
