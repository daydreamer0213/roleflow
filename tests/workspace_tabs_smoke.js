const assert = require("node:assert");
const {
  prepareWorkspaceTabs,
  assertBossOperatorTabs,
  inspectBossOperatorTabs
} = require("../src/core/workspace_tabs");
const { prepareWorkspaceTabsCommand } = require("../src/cli");

function fakeBrowser(initialTabs, createdTab = null) {
  const state = {
    tabs: initialTabs.map((tab) => ({ ...tab })),
    createCalls: [],
    frontCalls: []
  };
  return {
    state,
    async listTabs() { return state.tabs.map((tab) => ({ ...tab })); },
    async createTab(openerTabId, url) {
      state.createCalls.push({ openerTabId, url });
      if (!createdTab) throw new Error("unexpected createTab");
      if (!createdTab.omitFromList) state.tabs.push({ ...createdTab, url });
      return createdTab.returnId || createdTab.id;
    },
    async bringToFront(tabId) { state.frontCalls.push(tabId); }
  };
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
      id: "unrelated-boss-detail",
      url: "https://www.zhipin.com/web/geek/jobs/detail",
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
    "unrelated ordinary Edge windows must not invalidate the fixed BOSS pair"
  );
  const dashboard = {
    id: "roleflow-dashboard",
    url: "http://127.0.0.1:8787/",
    windowId: 42
  };

  const existing = fakeBrowser([boss, dashboard]);
  const existingResult = await prepareWorkspaceTabs({
    browser: existing,
    dashboardUrl: dashboard.url,
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.deepStrictEqual(existingResult, {
    bossTabId: boss.id,
    dashboardTabId: dashboard.id,
    windowId: 42,
    status: "ready"
  });
  assert.deepStrictEqual(existing.state.createCalls, []);
  assert.deepStrictEqual(existing.state.frontCalls, [dashboard.id]);

  const created = fakeBrowser([boss], {
    id: "created-dashboard",
    windowId: 42
  });
  const createdResult = await prepareWorkspaceTabs({
    browser: created,
    dashboardUrl: dashboard.url,
    inspectReadiness: async () => ({ status: "login_required" })
  });
  assert.strictEqual(createdResult.dashboardTabId, "created-dashboard");
  assert.deepStrictEqual(created.state.createCalls, [{
    openerTabId: boss.id,
    url: dashboard.url
  }]);
  assert.deepStrictEqual(created.state.frontCalls, [boss.id]);

  const fixedCreated = fakeBrowser([
    boss,
    fixedCommunication,
    {
      id: "unrelated-ordinary-edge-window",
      url: "https://example.invalid/",
      windowId: 99
    }
  ], {
    id: "900",
    returnId: 900,
    windowId: 42
  });
  const fixedCreatedResult = await prepareWorkspaceTabs({
    browser: fixedCreated,
    dashboardUrl: dashboard.url,
    requireFixedBossTabs: true,
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.strictEqual(
    fixedCreatedResult.dashboardTabId,
    "900",
    "created dashboard identity must come from the post-create tab list"
  );
  assert.deepStrictEqual(fixedCreated.state.frontCalls, ["900"]);

  const fixedReadiness = [];
  await prepareWorkspaceTabs({
    browser: fakeBrowser([
      boss,
      fixedCommunication,
      dashboard,
      {
        id: "unrelated-boss-page",
        url: "https://www.zhipin.com/web/geek/jobs/other",
        windowId: 99
      }
    ]),
    dashboardUrl: dashboard.url,
    requireFixedBossTabs: true,
    inspectReadiness: async (fixed) => {
      fixedReadiness.push({
        searchTabId: fixed.searchTab.id,
        communicationTabId: fixed.communicationTab.id,
        windowId: fixed.windowId
      });
      return { status: "ready" };
    }
  });
  assert.deepStrictEqual(fixedReadiness, [{
    searchTabId: "boss-search",
    communicationTabId: "boss-communication",
    windowId: 42
  }]);

  await assert.rejects(
    () => prepareWorkspaceTabs({
      browser: fakeBrowser([boss, fixedCommunication], {
        id: "dashboard-in-other-window",
        windowId: 99
      }),
      dashboardUrl: dashboard.url,
      requireFixedBossTabs: true,
      inspectReadiness: async () => ({ status: "ready" })
    }),
    (error) => error.code === "WORKSPACE_DASHBOARD_WINDOW_MISMATCH"
  );
  await assert.rejects(
    () => prepareWorkspaceTabs({
      browser: fakeBrowser([boss, fixedCommunication], {
        id: "dashboard-missing-from-list",
        omitFromList: true
      }),
      dashboardUrl: dashboard.url,
      requireFixedBossTabs: true,
      inspectReadiness: async () => ({ status: "ready" })
    }),
    (error) => error.code === "WORKSPACE_DASHBOARD_TAB_REQUIRED"
  );

  const wrongWindow = fakeBrowser([boss, {
    ...dashboard,
    windowId: 99
  }]);
  await assert.rejects(
    () => prepareWorkspaceTabs({
      browser: wrongWindow,
      dashboardUrl: dashboard.url,
      inspectReadiness: async () => ({ status: "ready" })
    }),
    (error) => {
      assert.strictEqual(error.code, "WORKSPACE_DASHBOARD_WINDOW_MISMATCH");
      assert.match(error.message, /仅移动或关闭 RoleFlow Dashboard 标签页/);
      assert.match(error.message, /不要关闭含有无关页面的普通 Edge 窗口/);
      return true;
    }
  );

  await assert.rejects(
    () => prepareWorkspaceTabs({
      browser: fakeBrowser([dashboard]),
      dashboardUrl: dashboard.url,
      inspectReadiness: async () => ({ status: "ready" })
    }),
    (error) => error.code === "BOSS_TAB_REQUIRED"
  );

  await assert.rejects(
    () => prepareWorkspaceTabs({
      browser: fakeBrowser([
        boss,
        {
          id: "boss-other-window",
          url: "https://www.zhipin.com/web/geek/chat",
          windowId: 99
        }
      ]),
      dashboardUrl: dashboard.url,
      inspectReadiness: async () => ({ status: "ready" })
    }),
    (error) => error.code === "BOSS_WINDOW_MISMATCH"
  );

  await assert.rejects(
    () => prepareWorkspaceTabs({
      browser: fakeBrowser([
        boss,
        dashboard,
        {
          id: "other-window-page",
          url: "about:blank",
          windowId: 99
        }
      ]),
      dashboardUrl: dashboard.url,
      inspectReadiness: async () => ({ status: "ready" })
    }),
    (error) => error.code === "WORKSPACE_WINDOW_MISMATCH"
  );

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
        inspectReadiness
      }) => {
        assert.strictEqual(receivedBrowser, browser);
        assert.strictEqual(dashboardUrl, "http://localhost:8787/workspace");
        calls.requireFixedBossTabs = requireFixedBossTabs;
        assert.strictEqual((await inspectReadiness(requireFixedBossTabs ? calls.fixedTabs : null)).status, "ready");
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
  assert.strictEqual(portableCalls.requireFixedBossTabs, false);
  assert.strictEqual(portableCalls.browserList, 0);
  assert.deepStrictEqual(portableCalls.preflight, [undefined]);

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
