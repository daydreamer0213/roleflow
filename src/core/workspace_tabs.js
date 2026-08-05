function workspaceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isBossTab(tab) {
  try {
    return /(^|\.)zhipin\.com$/i.test(new URL(tab?.url || "").hostname);
  } catch {
    return false;
  }
}

function isDashboardTab(tab, dashboardUrl) {
  try {
    const actual = new URL(tab?.url || "");
    const expected = new URL(dashboardUrl);
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function selectBossTab(tabs) {
  const bossTabs = tabs.filter(isBossTab);
  return bossTabs.find((tab) => /\/web\/geek\/jobs/i.test(new URL(tab.url).pathname))
    || bossTabs[0]
    || null;
}

async function prepareWorkspaceTabs({ browser, dashboardUrl, inspectReadiness }) {
  if (!browser || typeof inspectReadiness !== "function") {
    throw new TypeError("prepareWorkspaceTabs requires browser and inspectReadiness()");
  }
  const tabs = await browser.listTabs();
  const bossTab = selectBossTab(tabs);
  if (!bossTab) {
    throw workspaceError("BOSS_TAB_REQUIRED", "项目专用 Edge 中没有 BOSS 标签页。");
  }
  const bossTabs = tabs.filter(isBossTab);
  if (bossTabs.some((tab) => String(tab.windowId) !== String(bossTab.windowId))) {
    throw workspaceError(
      "BOSS_WINDOW_MISMATCH",
      "BOSS 标签页分布在多个项目 Edge 窗口，请关闭多余窗口后重试。"
    );
  }
  if (!Number.isInteger(bossTab.windowId)) {
    throw workspaceError("BROWSER_COMMAND_FAILED", "BOSS 标签页没有可靠的窗口身份。");
  }
  const dashboardTabs = tabs.filter((tab) => isDashboardTab(tab, dashboardUrl));
  const crossWindow = dashboardTabs.find((tab) =>
    String(tab.windowId) !== String(bossTab.windowId)
  );
  if (crossWindow) {
    throw workspaceError(
      "WORKSPACE_DASHBOARD_WINDOW_MISMATCH",
      "RoleFlow 工作台位于另一个项目 Edge 窗口，请关闭多余窗口后重试。"
    );
  }
  if (tabs.some((tab) => !Number.isInteger(tab.windowId) || tab.windowId !== bossTab.windowId)) {
    throw workspaceError(
      "WORKSPACE_WINDOW_MISMATCH",
      "项目专用 Edge 包含多个窗口或缺少可靠的窗口身份，请关闭多余窗口后重试。"
    );
  }

  let dashboardTab = dashboardTabs[0] || null;
  if (!dashboardTab) {
    const dashboardTabId = await browser.createTab(bossTab.id, dashboardUrl);
    // CdpBrowserAdapter.createTab() returns only after proving same-window identity.
    dashboardTab = {
      id: dashboardTabId,
      url: dashboardUrl,
      windowId: bossTab.windowId
    };
  }

  const readiness = await inspectReadiness();
  await browser.bringToFront(readiness.status === "ready" ? dashboardTab.id : bossTab.id);
  return {
    bossTabId: bossTab.id,
    dashboardTabId: dashboardTab.id,
    windowId: bossTab.windowId,
    status: readiness.status
  };
}

module.exports = { prepareWorkspaceTabs };
