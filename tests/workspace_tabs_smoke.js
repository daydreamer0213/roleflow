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
    const tab = { ...next, url };
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

  const loginTab = { id: "CDP-login", url: "https://www.zhipin.com/", windowId: 42, active: true };
  const loginBrowser = dedicatedBrowser([loginTab]);
  const loginInspections = [];
  const loginResult = await prepareWorkspaceTabs({
    browser: loginBrowser,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
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
    await assert.rejects(() => prepareWorkspaceTabs({
      browser: invalid,
      dashboardUrl: dashboard.url,
      bootstrapDedicatedTabs: true,
      inspectReadiness: async () => { inspections += 1; return { status: "ready" }; }
    }));
    assert.strictEqual(inspections, 0);
    assert.deepStrictEqual(invalid.state.createCalls, []);
    assert.deepStrictEqual(invalid.state.frontCalls, []);
  }

  const duplicateDashboard = dedicatedBrowser([
    { ...boss, active: true }, fixedCommunication, dashboard, { ...dashboard, id: "dashboard-2" }
  ]);
  await assert.rejects(() => prepareWorkspaceTabs({
    browser: duplicateDashboard,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    inspectReadiness: async () => ({ status: "ready" })
  }), (error) => error.code === "WORKSPACE_DASHBOARD_TAB_AMBIGUOUS");
  assert.deepStrictEqual(duplicateDashboard.state.closeCalls, []);

  const noVisible = dedicatedBrowser([{ ...boss, active: false }]);
  await assert.rejects(() => prepareWorkspaceTabs({
    browser: noVisible,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    inspectReadiness: async () => ({ status: "ready" })
  }), (error) => error.code === "BROWSER_COMMAND_FAILED" && /恢复.*专用 Edge/.test(error.message));
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
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.strictEqual(completeHiddenResult.status, "ready");
  assert.deepStrictEqual(completeButHidden.state.createCalls, []);
  assert.deepStrictEqual(completeButHidden.state.frontCalls, [dashboard.id]);

  const multipleVisible = dedicatedBrowser([
    { ...boss, active: true },
    { id: "visible-user-page", url: "https://example.invalid/", windowId: 42, active: true }
  ]);
  let multipleVisibleInspections = 0;
  await assert.rejects(() => prepareWorkspaceTabs({
    browser: multipleVisible,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    inspectReadiness: async () => { multipleVisibleInspections += 1; return { status: "risk_control" }; }
  }), (error) => error.code === "BROWSER_COMMAND_FAILED");
  assert.strictEqual(multipleVisibleInspections, 0, "two visible pages invalidate even read-only startup inspection");

  const foregroundChat = dedicatedBrowser([{ ...boss, active: true }, {
    id: "unrelated-user-page", url: "https://example.invalid/", windowId: 42, active: false
  }], [{ id: "CDP-chat-foreground", windowId: 42, active: true }]);
  await assert.rejects(() => prepareWorkspaceTabs({
    browser: foregroundChat,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    inspectReadiness: async () => ({ status: "ready" })
  }), (error) => error.code === "BROWSER_COMMAND_FAILED");
  assert.deepStrictEqual(foregroundChat.state.closeCalls, ["CDP-chat-foreground"]);
  assert(foregroundChat.state.tabs.some((tab) => tab.id === "unrelated-user-page"));
  assert.deepStrictEqual(foregroundChat.state.frontCalls, []);
  assert(foregroundChat.state.listCalls >= 3, "cleanup must re-list and re-prove the typed baseline");

  const foregroundDashboard = dedicatedBrowser([{ ...boss, active: true }], [
    { id: "CDP-chat-cleanup", windowId: 42, active: false },
    { id: "CDP-dashboard-foreground", windowId: 42, active: true }
  ]);
  await assert.rejects(() => prepareWorkspaceTabs({
    browser: foregroundDashboard,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    inspectReadiness: async () => ({ status: "ready" })
  }), (error) => error.code === "BROWSER_COMMAND_FAILED");
  assert.deepStrictEqual(
    foregroundDashboard.state.closeCalls,
    ["CDP-dashboard-foreground", "CDP-chat-cleanup"],
    "bootstrap cleanup closes only invocation-owned tabs in reverse order"
  );
  assert.deepStrictEqual(foregroundDashboard.state.frontCalls, []);

  const failedFocus = dedicatedBrowser([
    { ...boss, active: true }, fixedCommunication, { ...dashboard, active: false }
  ]);
  failedFocus.bringToFront = async (tabId) => { failedFocus.state.frontCalls.push(tabId); };
  await assert.rejects(() => prepareWorkspaceTabs({
    browser: failedFocus,
    dashboardUrl: dashboard.url,
    bootstrapDedicatedTabs: true,
    inspectReadiness: async () => ({ status: "ready" })
  }), (error) => error.code === "BROWSER_COMMAND_FAILED");
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
        inspectReadiness
      }) => {
        assert.strictEqual(receivedBrowser, browser);
        assert.strictEqual(dashboardUrl, "http://localhost:8787/workspace");
        calls.requireFixedBossTabs = requireFixedBossTabs;
        calls.bootstrapDedicatedTabs = bootstrapDedicatedTabs;
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
