const assert = require("node:assert");
const { prepareWorkspaceTabs } = require("../src/core/workspace_tabs");
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
      state.tabs.push({ ...createdTab, url });
      return createdTab.id;
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
    (error) => error.code === "WORKSPACE_DASHBOARD_WINDOW_MISMATCH"
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

  const commandBrowser = { kind: "portable-browser" };
  const commandCalls = { browser: [], adapter: [], preflight: 0 };
  const commandResult = await prepareWorkspaceTabsCommand({
    browser: "portable",
    "cdp-port": 9222,
    "dashboard-url": "http://localhost:8787/workspace"
  }, {
    browserFactory: (args) => {
      commandCalls.browser.push(args);
      return commandBrowser;
    },
    siteAdapterFactory: (site, context) => {
      commandCalls.adapter.push({ site, context });
      return {
        async preflight() {
          commandCalls.preflight += 1;
          return { isSearchPage: true };
        }
      };
    },
    prepareTabs: async ({ browser, dashboardUrl, inspectReadiness }) => {
      assert.strictEqual(browser, commandBrowser);
      assert.strictEqual(dashboardUrl, "http://localhost:8787/workspace");
      assert.strictEqual((await inspectReadiness()).status, "ready");
      return { status: "ready" };
    }
  });
  assert.deepStrictEqual(commandResult, { status: "ready" });
  assert.deepStrictEqual(commandCalls.browser, [{ browser: "portable", "cdp-port": 9222 }]);
  assert.strictEqual(commandCalls.adapter[0].site, "boss");
  assert.strictEqual(commandCalls.adapter[0].context.browser, commandBrowser);
  assert.strictEqual(commandCalls.preflight, 1);

  await assert.rejects(
    () => prepareWorkspaceTabsCommand({ browser: "edge" }),
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
