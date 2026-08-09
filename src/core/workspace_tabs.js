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

function bossPath(tab) {
  try {
    const url = new URL(tab?.url || "");
    return /(^|\.)zhipin\.com$/i.test(url.hostname) ? url.pathname : "";
  } catch {
    return "";
  }
}

function assertBossOperatorTabs(tabs = []) {
  const searchTabs = tabs.filter((tab) => bossPath(tab) === "/web/geek/jobs");
  const communicationTabs = tabs.filter((tab) => bossPath(tab) === "/web/geek/chat");
  if (searchTabs.length !== 1 || communicationTabs.length !== 1) {
    throw workspaceError(
      "BOSS_TAB_REQUIRED",
      "普通 Edge 必须正好保留一个 BOSS 搜索页和一个 BOSS 沟通页。"
    );
  }
  const [searchTab] = searchTabs;
  const [communicationTab] = communicationTabs;
  if (!Number.isInteger(searchTab.windowId)
    || !Number.isInteger(communicationTab.windowId)) {
    throw workspaceError(
      "BROWSER_COMMAND_FAILED",
      "固定 BOSS 标签页缺少可靠的窗口身份。"
    );
  }
  if (searchTab.windowId !== communicationTab.windowId) {
    throw workspaceError(
      "BOSS_WINDOW_MISMATCH",
      "BOSS 搜索页和沟通页必须位于同一个普通 Edge 窗口。"
    );
  }
  return {
    searchTab,
    communicationTab,
    windowId: searchTab.windowId
  };
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

async function prepareWorkspaceTabs({
  browser,
  dashboardUrl,
  inspectReadiness,
  requireFixedBossTabs = false
}) {
  if (!browser || typeof inspectReadiness !== "function") {
    throw new TypeError("prepareWorkspaceTabs requires browser and inspectReadiness()");
  }
  const tabs = await browser.listTabs();
  const fixed = requireFixedBossTabs
    ? assertBossOperatorTabs(tabs)
    : null;
  const bossTab = fixed?.searchTab || selectBossTab(tabs);
  if (!bossTab) {
    throw workspaceError("BOSS_TAB_REQUIRED", "项目专用 Edge 中没有 BOSS 标签页。");
  }
  const bossTabs = tabs.filter(isBossTab);
  if (!requireFixedBossTabs
    && bossTabs.some((tab) => String(tab.windowId) !== String(bossTab.windowId))) {
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
      "RoleFlow Dashboard 标签页位于另一个窗口。请仅移动或关闭 RoleFlow Dashboard 标签页；不要关闭含有无关页面的普通 Edge 窗口。"
    );
  }
  if (!requireFixedBossTabs
    && tabs.some((tab) => !Number.isInteger(tab.windowId) || tab.windowId !== bossTab.windowId)) {
    throw workspaceError(
      "WORKSPACE_WINDOW_MISMATCH",
      "项目专用 Edge 包含多个窗口或缺少可靠的窗口身份，请关闭多余窗口后重试。"
    );
  }

  let dashboardTab = dashboardTabs[0] || null;
  if (!dashboardTab) {
    const dashboardTabId = await browser.createTab(bossTab.id, dashboardUrl);
    const createdTabs = await browser.listTabs();
    dashboardTab = createdTabs.find((tab) => String(tab.id) === String(dashboardTabId)) || null;
    if (!dashboardTab) {
      throw workspaceError(
        "WORKSPACE_DASHBOARD_TAB_REQUIRED",
        "RoleFlow Dashboard 标签页创建后未能在浏览器中确认。"
      );
    }
    if (!Number.isInteger(dashboardTab.windowId)
      || dashboardTab.windowId !== bossTab.windowId) {
      throw workspaceError(
        "WORKSPACE_DASHBOARD_WINDOW_MISMATCH",
        "RoleFlow Dashboard 标签页位于另一个窗口。请仅移动或关闭 RoleFlow Dashboard 标签页；不要关闭含有无关页面的普通 Edge 窗口。"
      );
    }
  }

  const readiness = await inspectReadiness(fixed);
  await browser.bringToFront(readiness.status === "ready" ? dashboardTab.id : bossTab.id);
  return {
    bossTabId: bossTab.id,
    dashboardTabId: dashboardTab.id,
    windowId: bossTab.windowId,
    status: readiness.status
  };
}

module.exports = {
  prepareWorkspaceTabs,
  assertBossOperatorTabs
};
