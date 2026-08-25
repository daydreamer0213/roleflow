const { sameBrowserTabId, sortedBrowserTabIds } = require("./browser_tab_identity");

function workspaceError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  Object.defineProperty(error, "isWorkspaceError", { value: true });
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

function bossLocation(tab) {
  try {
    const url = new URL(tab?.url || "");
    return /(^|\.)zhipin\.com$/i.test(url.hostname)
      ? { origin: url.origin, path: url.pathname }
      : null;
  } catch {
    return null;
  }
}

function searchTabChanged(message, tab = null) {
  const observedLocation = bossLocation(tab);
  return workspaceError("BOSS_SEARCH_TAB_CHANGED", message, observedLocation ? { observedLocation } : {});
}

function assertBossOperatorTabs(tabs = []) {
  const bossTabs = tabs.filter(isBossTab);
  const searchTabs = tabs.filter((tab) => bossPath(tab) === "/web/geek/jobs");
  const communicationTabs = tabs.filter((tab) => bossPath(tab) === "/web/geek/chat");
  if (bossTabs.length !== 2 || searchTabs.length !== 1 || communicationTabs.length !== 1) {
    throw workspaceError(
      "BOSS_TAB_REQUIRED",
      "浏览器必须正好保留一个 BOSS 搜索页和一个 BOSS 沟通页。"
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
      "BOSS 搜索页和沟通页必须位于同一个浏览器窗口。"
    );
  }
  return {
    searchTab,
    communicationTab,
    windowId: searchTab.windowId
  };
}

async function inspectBossOperatorTabs({
  browser,
  inspectTab,
  expectedSearchTabId = null,
  expectedCommunicationTabId = null
}) {
  if (!browser || typeof browser.listTabs !== "function" || typeof inspectTab !== "function") {
    throw new TypeError("inspectBossOperatorTabs requires browser.listTabs() and inspectTab()");
  }
  const initialTabs = await browser.listTabs({ scope: "boss" });
  const fixed = assertBossOperatorTabs(initialTabs);
  const initialVisibleIds = visibleIdsInWindow(initialTabs, fixed.windowId);
  if (initialVisibleIds.length > 1) {
    throw workspaceError("BROWSER_COMMAND_FAILED", "固定 BOSS 标签页窗口同时出现多个前台标签页。");
  }
  assertExpectedBossOperatorTabIds(fixed, { expectedSearchTabId, expectedCommunicationTabId });
  const communicationState = await inspectTab(fixed.communicationTab.id);
  assertLiveBossOperatorState(communicationState, {
    tabId: fixed.communicationTab.id,
    pathname: "/web/geek/chat",
    code: "BOSS_COMMUNICATION_PAGE_LOST",
    requiresSearchPage: false
  });
  const searchState = await inspectTab(fixed.searchTab.id);
  assertLiveBossOperatorState(searchState, {
    tabId: fixed.searchTab.id,
    pathname: "/web/geek/jobs",
    code: "BOSS_SEARCH_PAGE_LOST",
    requiresSearchPage: true
  });
  const refreshedTabs = await browser.listTabs({ scope: "boss" });
  let refreshed;
  try {
    refreshed = assertBossOperatorTabs(refreshedTabs);
  } catch (error) {
    if (error?.code !== "BOSS_TAB_REQUIRED") throw error;
    const currentSearchTab = refreshedTabs.find((tab) => sameBrowserTabId(tab.id, fixed.searchTab.id));
    if (!currentSearchTab || bossPath(currentSearchTab) !== "/web/geek/jobs") {
      throw searchTabChanged("BOSS fixed search tab path changed during preflight.", currentSearchTab);
    }
    const currentCommunicationTab = refreshedTabs.find((tab) => sameBrowserTabId(tab.id, fixed.communicationTab.id));
    if (!currentCommunicationTab || bossPath(currentCommunicationTab) !== "/web/geek/chat") {
      throw workspaceError("BOSS_OPERATOR_TABS_CHANGED", "BOSS fixed communication tab path changed during preflight.");
    }
    throw error;
  }
  if (!sameBrowserTabId(refreshed.searchTab.id, fixed.searchTab.id)) {
    throw searchTabChanged("BOSS fixed search tab changed during preflight.", refreshed.searchTab);
  }
  if (!sameBrowserTabId(refreshed.communicationTab.id, fixed.communicationTab.id)) {
    throw workspaceError("BOSS_OPERATOR_TABS_CHANGED", "BOSS fixed communication tab changed during preflight.");
  }
  if (!sameTabIdLists(visibleIdsInWindow(refreshedTabs, refreshed.windowId), initialVisibleIds)) {
    throw workspaceError("BROWSER_COMMAND_FAILED", "固定 BOSS 标签页检查期间前台标签页发生变化。");
  }
  assertExpectedBossOperatorTabIds(refreshed, { expectedSearchTabId, expectedCommunicationTabId });
  return {
    ...refreshed,
    searchState,
    communicationState
  };
}

function assertExpectedBossOperatorTabIds(fixed, { expectedSearchTabId, expectedCommunicationTabId }) {
  if (expectedSearchTabId !== null && expectedSearchTabId !== undefined
    && !sameBrowserTabId(fixed.searchTab.id, expectedSearchTabId)) {
    throw searchTabChanged("BOSS fixed search tab changed before preflight.", fixed.searchTab);
  }
  if (expectedCommunicationTabId !== null && expectedCommunicationTabId !== undefined
    && !sameBrowserTabId(fixed.communicationTab.id, expectedCommunicationTabId)) {
    throw workspaceError("BOSS_OPERATOR_TABS_CHANGED", "BOSS fixed communication tab changed before preflight.");
  }
}

function assertBossRuntimeTabBindings(tabs = [], {
  expectedSearchTabId,
  expectedCommunicationTabId
} = {}) {
  if (tabs.filter(isBossTab).length !== 2) {
    throw workspaceError("BOSS_TAB_REQUIRED", "运行期间只能保留固定的 BOSS 搜索页和沟通页。");
  }
  const searchTab = tabs.find((tab) => sameBrowserTabId(tab.id, expectedSearchTabId));
  if (!searchTab) {
    throw searchTabChanged("BOSS fixed search tab changed during runtime.");
  }
  const communicationTab = tabs.find((tab) => sameBrowserTabId(tab.id, expectedCommunicationTabId));
  if (!communicationTab) {
    throw workspaceError("BOSS_OPERATOR_TABS_CHANGED", "BOSS fixed communication tab changed during runtime.");
  }
  if (!Number.isInteger(searchTab.windowId) || !Number.isInteger(communicationTab.windowId)) {
    throw workspaceError("BROWSER_COMMAND_FAILED", "BOSS fixed operator tabs lost their window identity during runtime.");
  }
  if (searchTab.windowId !== communicationTab.windowId) {
    throw workspaceError("BOSS_WINDOW_MISMATCH", "BOSS fixed operator tabs moved to different windows during runtime.");
  }
  if (visibleIdsInWindow(tabs, searchTab.windowId).length > 1) {
    throw workspaceError("BROWSER_COMMAND_FAILED", "固定 BOSS 标签页窗口同时出现多个前台标签页。");
  }
  if (!/^\/web\/geek\/jobs\/?$/i.test(bossPath(searchTab))
    && !/^\/job_detail\/[^/?#]+\.html$/i.test(bossPath(searchTab))) {
    throw searchTabChanged("BOSS fixed search tab left its permitted runtime path.", searchTab);
  }
  if (bossPath(communicationTab) !== "/web/geek/chat") {
    throw workspaceError("BOSS_COMMUNICATION_PAGE_LOST", "BOSS fixed communication tab left its required page.");
  }
  return { searchTab, communicationTab, windowId: searchTab.windowId };
}

function assertLiveBossOperatorState(state, { tabId, pathname, code, requiresSearchPage }) {
  let url;
  try {
    url = new URL(String(state?.url || ""));
  } catch {
    throw workspaceError(code, "BOSS fixed operator tab returned invalid live state.");
  }
  if (!sameBrowserTabId(state?.tabId, tabId)
    || !/(^|\.)zhipin\.com$/i.test(url.hostname)
    || url.pathname !== pathname
    || (requiresSearchPage ? state?.isSearchPage !== true : state?.isSearchPage === true)) {
    throw workspaceError(code, "BOSS fixed operator tab left its required page.");
  }
}

function isDashboardTab(tab, dashboardUrl) {
  try {
    const actual = new URL(tab?.url || "");
    const expected = new URL(dashboardUrl);
    return actual.origin === expected.origin;
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
  requireFixedBossTabs = false,
  bootstrapDedicatedTabs = false,
  allowStartupGuidance = false,
  stabilityIntervalMs = 250,
  stabilityTimeoutMs = 5000,
  sleepFn = wait,
  nowFn = Date.now
}) {
  if (!browser || typeof inspectReadiness !== "function") {
    throw new TypeError("prepareWorkspaceTabs requires browser and inspectReadiness()");
  }
  let tabs;
  try {
    tabs = bootstrapDedicatedTabs
      ? await listStableWorkspaceTabs(browser, {
        intervalMs: stabilityIntervalMs,
        timeoutMs: stabilityTimeoutMs,
        sleepFn,
        nowFn
      })
      : await browser.listTabs();
  } catch (error) {
    if (bootstrapDedicatedTabs && error?.isWorkspaceError) {
      return ambiguousWorkspaceResult(error.observedTabs || [], dashboardUrl, error);
    }
    throw error;
  }
  if (!bootstrapDedicatedTabs) {
    const fixedTabs = requireFixedBossTabs ? assertBossOperatorTabs(tabs) : null;
    const guidanceTab = fixedTabs?.searchTab || selectBossTab(tabs);
    if (!guidanceTab) throw workspaceError("BOSS_TAB_REQUIRED", "浏览器中没有 BOSS 标签页。");
    const readiness = await inspectReadiness({ guidanceTab, fixedTabs });
    const dashboardTabs = tabs.filter((tab) => isDashboardTab(tab, dashboardUrl));
    if (dashboardTabs.length > 1) {
      throw workspaceError("WORKSPACE_DASHBOARD_TAB_AMBIGUOUS", "RoleFlow Dashboard 标签页不止一个。");
    }
    return workspaceResult({
      guidanceTab,
      communicationTab: fixedTabs?.communicationTab || null,
      dashboardTab: dashboardTabs[0] || null,
      status: readiness.status
    });
  }
  const baseline = workspaceBaseline(tabs);
  let workingTabs = tabs;
  let current;
  try {
    current = assertDedicatedTopology(workingTabs, dashboardUrl);
  } catch (error) {
    return ambiguousWorkspaceResult(workingTabs, dashboardUrl, error);
  }
  const initialWindowId = (current.guidanceTab || current.dashboardTab).windowId;
  const initialVisibleIds = visibleIdsInWindow(workingTabs, initialWindowId);
  if (initialVisibleIds.length > 1) {
    return ambiguousWorkspaceResult(workingTabs, dashboardUrl, workspaceError(
      "BROWSER_COMMAND_FAILED",
      "RoleFlow 专用 Edge（推荐）同时出现多个前台标签页，无法安全继续。"
    ));
  }
  if (!current.guidanceTab && initialVisibleIds.length !== 1) {
    return ambiguousWorkspaceResult(workingTabs, dashboardUrl, workspaceError(
      "BROWSER_COMMAND_FAILED",
      "请恢复 RoleFlow 专用 Edge（推荐）窗口后重试；创建标签页前必须能确认唯一前台页。"
    ));
  }
  const createdIds = [];
  try {
    if (!current.guidanceTab) {
      const dashboardTab = current.dashboardTab;
      requireSingleVisibleTab(workingTabs, dashboardTab.windowId);
      const searchTabId = await browser.createTab(
        dashboardTab.id,
        "https://www.zhipin.com/web/geek/jobs"
      );
      createdIds.push(searchTabId);
      const afterSearch = await browser.listTabs();
      const searchTab = requireCreatedTab(afterSearch, {
        tabId: searchTabId,
        windowId: dashboardTab.windowId,
        bossOrigin: true,
        code: "BOSS_SEARCH_PAGE_INVALID"
      });
      requireVisibleBaseline(afterSearch, dashboardTab.windowId, baseline.visibleIds);
      current = assertDedicatedTopology(afterSearch, dashboardUrl);
      if (!sameBrowserTabId(current.guidanceTab?.id, searchTab.id)) {
        throw workspaceError("BOSS_SEARCH_TAB_CHANGED", "新建 BOSS 搜索页的身份无法安全确认。");
      }
      workingTabs = afterSearch;
    }

    const readiness = await inspectReadiness({
      guidanceTab: current.guidanceTab,
      fixedTabs: current.fixedTabs
    });
    if (readiness?.status === "login_required") {
      if (allowStartupGuidance) await guideStartupTab(browser, current.guidanceTab);
      return workspaceResult({
        guidanceTab: current.guidanceTab,
        dashboardTab: current.dashboardTab,
        status: readiness.status
      });
    }
    if (readiness?.status !== "ready") {
      return workspaceResult({
        guidanceTab: current.guidanceTab,
        communicationTab: current.fixedTabs?.communicationTab || null,
        dashboardTab: current.dashboardTab,
        status: readiness?.status
      });
    }

    const expectedGuidanceTabId = current.guidanceTab.id;
    const expectedCommunicationTabId = current.fixedTabs?.communicationTab?.id ?? null;
    const expectedDashboardTabId = current.dashboardTab?.id ?? null;
    const afterReadiness = await browser.listTabs();
    const refreshed = assertDedicatedTopology(afterReadiness, dashboardUrl);
    const refreshedWorkspaceTabs = [
      refreshed.guidanceTab,
      refreshed.fixedTabs?.communicationTab || null,
      refreshed.dashboardTab
    ].filter(Boolean);
    if (refreshedWorkspaceTabs.some((tab) => tab.windowId !== initialWindowId)) {
      throw workspaceError("WORKSPACE_WINDOW_MISMATCH", "RoleFlow 专用 Edge 工作区在就绪检查后更换了窗口。");
    }
    if (!sameBrowserTabId(refreshed.guidanceTab?.id, expectedGuidanceTabId)) {
      throw workspaceError("BOSS_SEARCH_TAB_CHANGED", "BOSS 搜索页在就绪检查后发生了变化。");
    }
    if (expectedCommunicationTabId !== null
      && !sameBrowserTabId(refreshed.fixedTabs?.communicationTab?.id, expectedCommunicationTabId)) {
      throw workspaceError("BOSS_COMMUNICATION_PAGE_LOST", "BOSS 沟通页在就绪检查后发生了变化。");
    }
    if (expectedDashboardTabId !== null
      && !sameBrowserTabId(refreshed.dashboardTab?.id, expectedDashboardTabId)) {
      throw workspaceError("WORKSPACE_DASHBOARD_TAB_REQUIRED", "RoleFlow Dashboard 在就绪检查后发生了变化。");
    }
    requireVisibleBaseline(afterReadiness, initialWindowId, baseline.visibleIds);
    current = refreshed;
    workingTabs = afterReadiness;
    if (bossPath(current.guidanceTab) !== "/web/geek/jobs") {
      throw workspaceError("BOSS_SEARCH_PAGE_INVALID", "已就绪的 BOSS 标签页不是职位搜索页。");
    }

    let communicationTab = current.fixedTabs?.communicationTab || null;
    if (!communicationTab) {
      requireSingleVisibleTab(workingTabs, current.guidanceTab.windowId);
      const chatUrl = new URL("/web/geek/chat", current.guidanceTab.url).toString();
      const communicationTabId = await browser.createTab(current.guidanceTab.id, chatUrl);
      createdIds.push(communicationTabId);
      const afterChat = await browser.listTabs();
      communicationTab = requireCreatedTab(afterChat, {
        tabId: communicationTabId,
        windowId: current.guidanceTab.windowId,
        path: "/web/geek/chat",
        code: "BOSS_COMMUNICATION_PAGE_LOST"
      });
      requireVisibleBaseline(afterChat, current.guidanceTab.windowId, baseline.visibleIds);
      assertDedicatedTopology(afterChat, dashboardUrl);
      workingTabs = afterChat;
    }

    let dashboardTab = current.dashboardTab;
    if (!dashboardTab) {
      const beforeDashboard = await browser.listTabs();
      requireSingleVisibleTab(beforeDashboard, current.guidanceTab.windowId);
      const dashboardTabId = await browser.createTab(current.guidanceTab.id, dashboardUrl);
      createdIds.push(dashboardTabId);
      const afterDashboard = await browser.listTabs();
      dashboardTab = requireCreatedTab(afterDashboard, {
        tabId: dashboardTabId,
        windowId: current.guidanceTab.windowId,
        dashboardUrl,
        code: "WORKSPACE_DASHBOARD_TAB_REQUIRED"
      });
      requireVisibleBaseline(afterDashboard, current.guidanceTab.windowId, baseline.visibleIds);
      assertDedicatedTopology(afterDashboard, dashboardUrl);
    }

    if (allowStartupGuidance) await guideStartupTab(browser, dashboardTab);
    return workspaceResult({
      guidanceTab: current.guidanceTab,
      communicationTab,
      dashboardTab,
      status: readiness.status
    });
  } catch (error) {
    await cleanupCreatedTabs(browser, createdIds, baseline, error);
    if (error?.isWorkspaceError && !error.cleanupError) {
      return ambiguousWorkspaceResult(tabs, dashboardUrl, error);
    }
    throw error;
  }
}

async function listStableWorkspaceTabs(browser, {
  intervalMs,
  timeoutMs,
  sleepFn,
  nowFn
}) {
  const startedAt = nowFn();
  let previous = "";
  while (true) {
    const tabs = await browser.listTabs();
    const current = workspaceTabsFingerprint(tabs);
    if (current === previous) return tabs;
    if (nowFn() - startedAt >= timeoutMs) {
      throw workspaceError(
        "WORKSPACE_TABS_UNSTABLE",
        "RoleFlow 专用 Edge（推荐）仍在恢复标签页，请稍后重试。",
        { observedTabs: tabs }
      );
    }
    previous = current;
    await sleepFn(intervalMs);
  }
}

function workspaceTabsFingerprint(tabs) {
  return JSON.stringify((tabs || []).map((tab) => ({
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active === true,
    url: stableWorkspaceUrl(tab.url)
  })).sort((left, right) => `${typeof left.id}:${left.id}`.localeCompare(`${typeof right.id}:${right.id}`)));
}

function stableWorkspaceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return String(value || "");
  }
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function assertDedicatedTopology(tabs, dashboardUrl) {
  if (tabs.some((tab) => !Number.isInteger(tab.windowId))) {
    throw workspaceError("BROWSER_COMMAND_FAILED", "RoleFlow 专用 Edge（推荐）标签页缺少可靠的窗口身份。");
  }
  const bossTabs = tabs.filter(isBossTab);
  const searchTabs = bossTabs.filter((tab) => bossPath(tab) === "/web/geek/jobs");
  const communicationTabs = bossTabs.filter((tab) => bossPath(tab) === "/web/geek/chat");
  const dashboardTabs = tabs.filter((tab) => isDashboardTab(tab, dashboardUrl));
  const exactPair = bossTabs.length === 2 && searchTabs.length === 1 && communicationTabs.length === 1;
  const singleGuidance = bossTabs.length === 1 && communicationTabs.length === 0;
  const dashboardOnly = bossTabs.length === 0 && dashboardTabs.length === 1 && tabs.length === 1;
  if (!exactPair && !singleGuidance && !dashboardOnly) {
    throw workspaceError("BOSS_TAB_REQUIRED", "RoleFlow 专用 Edge（推荐）只能保留一个 BOSS 引导页或固定的搜索页与沟通页。");
  }
  const guidanceTab = searchTabs[0] || bossTabs[0] || null;
  const anchorTab = guidanceTab || dashboardTabs[0];
  if (tabs.some((tab) => tab.windowId !== anchorTab.windowId)) {
    throw workspaceError("WORKSPACE_WINDOW_MISMATCH", "RoleFlow 专用 Edge（推荐）必须只保留一个可靠窗口。");
  }
  const fixedTabs = exactPair ? assertBossOperatorTabs(bossTabs) : null;
  if (dashboardTabs.length > 1) {
    throw workspaceError("WORKSPACE_DASHBOARD_TAB_AMBIGUOUS", "RoleFlow Dashboard 标签页不止一个。");
  }
  return { guidanceTab, fixedTabs, dashboardTab: dashboardTabs[0] || null };
}

function requireCreatedTab(tabs, {
  tabId,
  windowId,
  path = null,
  bossOrigin = false,
  dashboardUrl = null,
  code
}) {
  const tab = tabs.find((item) => sameBrowserTabId(item.id, tabId));
  if (!tab || (path && bossPath(tab) !== path)
    || (bossOrigin && !isBossTab(tab))
    || (dashboardUrl && !isDashboardTab(tab, dashboardUrl))) {
    throw workspaceError(code, "后台标签页创建后未能安全确认。");
  }
  if (tab.windowId !== windowId || tab.active) {
    throw workspaceError("BROWSER_COMMAND_FAILED", "新建标签页未保持在原窗口后台。", { tabId });
  }
  return tab;
}

function workspaceBaseline(tabs) {
  return {
    ids: sortedBrowserTabIds(tabs.map((tab) => tab.id)),
    visibleIds: sortedBrowserTabIds(tabs.filter((tab) => tab.active).map((tab) => tab.id))
  };
}

function visibleIdsInWindow(tabs, windowId) {
  return sortedBrowserTabIds(tabs
    .filter((tab) => tab.windowId === windowId && tab.active)
    .map((tab) => tab.id));
}

function requireSingleVisibleTab(tabs, windowId) {
  const visibleIds = visibleIdsInWindow(tabs, windowId);
  if (visibleIds.length !== 1) {
    throw workspaceError(
      "BROWSER_COMMAND_FAILED",
      "请恢复 RoleFlow 专用 Edge（推荐）窗口后重试；创建标签页前必须能确认唯一前台页。"
    );
  }
  return visibleIds;
}

function requireVisibleBaseline(tabs, windowId, expectedIds) {
  const actualIds = visibleIdsInWindow(tabs, windowId);
  if (!sameTabIdLists(actualIds, expectedIds)) {
    throw workspaceError("BROWSER_COMMAND_FAILED", "后台标签页操作改变了 RoleFlow 专用 Edge（推荐）的前台页。");
  }
}

async function guideStartupTab(browser, tab) {
  await browser.bringToFront(tab.id);
  const refreshed = await browser.listTabs();
  const current = refreshed.find((item) => sameBrowserTabId(item.id, tab.id));
  if (!current || current.windowId !== tab.windowId
    || !sameTabIdLists(visibleIdsInWindow(refreshed, tab.windowId), [tab.id])) {
    throw workspaceError("BROWSER_COMMAND_FAILED", "启动引导未能确认目标标签页成为前台页。");
  }
}

async function cleanupCreatedTabs(browser, createdIds, baseline, primaryError) {
  for (const tabId of [...createdIds].reverse()) {
    try {
      await browser.closeTab(tabId);
    } catch (error) {
      primaryError.message = `${primaryError.message}\n\n清理失败：${error.message || error}`;
      primaryError.cleanupError = error;
      return;
    }
  }
  try {
    const restored = workspaceBaseline(await listTabsAfterCloseSettles(browser));
    if (!sameTabIdLists(restored.ids, baseline.ids)
      || !sameTabIdLists(restored.visibleIds, baseline.visibleIds)) {
      throw workspaceError("BROWSER_COMMAND_FAILED", "启动清理后无法重证原始标签页基线。");
    }
  } catch (error) {
    primaryError.message = `${primaryError.message}\n\n清理失败：${error.message || error}`;
    primaryError.cleanupError = error;
  }
}

async function listTabsAfterCloseSettles(browser) {
  try {
    return await browser.listTabs();
  } catch (error) {
    if (error?.code !== "BROWSER_DISCONNECTED") throw error;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return browser.listTabs();
  }
}

function sameTabIdLists(left, right) {
  return left.length === right.length
    && left.every((value, index) => sameBrowserTabId(value, right[index]));
}

function workspaceResult({ guidanceTab, communicationTab = null, dashboardTab = null, status }) {
  return {
    bossTabId: guidanceTab.id,
    communicationTabId: communicationTab?.id ?? null,
    dashboardTabId: dashboardTab?.id ?? null,
    windowId: guidanceTab.windowId,
    status
  };
}

function ambiguousWorkspaceResult(tabs, dashboardUrl, error) {
  const searchTabs = tabs.filter((tab) => bossPath(tab) === "/web/geek/jobs");
  const communicationTabs = tabs.filter((tab) => bossPath(tab) === "/web/geek/chat");
  const dashboardTabs = tabs.filter((tab) => isDashboardTab(tab, dashboardUrl));
  const windowIds = [...new Set(tabs.map((tab) => tab.windowId).filter(Number.isInteger))];
  return {
    bossTabId: searchTabs.length === 1 ? searchTabs[0].id : null,
    communicationTabId: communicationTabs.length === 1 ? communicationTabs[0].id : null,
    dashboardTabId: dashboardTabs.length === 1 ? dashboardTabs[0].id : null,
    windowId: windowIds.length === 1 && tabs.every((tab) => Number.isInteger(tab.windowId))
      ? windowIds[0]
      : null,
    status: "ambiguous",
    errorCode: String(error?.code || "WORKSPACE_AMBIGUOUS"),
    message: String(error?.message || "RoleFlow 专用 Edge 工作区存在无法安全判断的页面。")
  };
}

module.exports = {
  prepareWorkspaceTabs,
  assertBossOperatorTabs,
  inspectBossOperatorTabs,
  assertBossRuntimeTabBindings
};
