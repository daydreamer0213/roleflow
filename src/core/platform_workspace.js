const { sameBrowserTabId } = require("./browser_tab_identity");

const PLATFORM_WORKSPACE_DEFINITIONS = Object.freeze({
  boss: Object.freeze({
    label: "BOSS",
    searchUrl: "https://www.zhipin.com/web/geek/jobs",
    messageUrl: "https://www.zhipin.com/web/geek/chat"
  }),
  zhaopin: Object.freeze({
    label: "智联",
    searchUrl: "https://www.zhaopin.com/jobs/?pageMode=search",
    messageUrl: "https://i.zhaopin.com/im"
  })
});

async function preparePlatformWorkspaceTabs({
  browser,
  dashboardUrl,
  enabledPlatforms = [],
  previousWorkspace = null
} = {}) {
  if (!browser || typeof browser.listTabs !== "function" || typeof browser.createTab !== "function") {
    throw workspaceError("BROWSER_COMMAND_FAILED", "招聘平台工作区需要可用的专用 Edge。");
  }
  const enabled = normalizePlatforms(enabledPlatforms);
  let tabs = await browser.listTabs();
  const dashboardTab = await resolveDashboardTab({ browser, tabs, dashboardUrl, previousWorkspace });
  tabs = await browser.listTabs();

  if (!enabled.length) {
    return workspaceResult({
      dashboardTab,
      enabled,
      platforms: {},
      status: "platform_selection_required"
    });
  }

  const platforms = {};
  for (const site of enabled) {
    const previous = previousWorkspace?.platforms?.[site] || null;
    const searchTab = await ensureRoleTab({
      browser,
      tabs,
      openerTab: dashboardTab,
      previousTabId: previous?.searchTabId,
      site,
      role: "search"
    });
    tabs = await browser.listTabs();
    const messageTab = await ensureRoleTab({
      browser,
      tabs,
      openerTab: dashboardTab,
      previousTabId: previous?.messageTabId,
      site,
      role: "message"
    });
    tabs = await browser.listTabs();
    platforms[site] = platformSnapshot({ site, searchTab, messageTab, windowId: dashboardTab.windowId });
  }

  const states = enabled.map((site) => platforms[site].status);
  const status = states.every((value) => value === "ready")
    ? "ready"
    : states.some((value) => value === "login_required")
      ? "login_required"
      : "not_ready";
  return workspaceResult({ dashboardTab, enabled, platforms, status });
}

async function resolveDashboardTab({ browser, tabs, dashboardUrl, previousWorkspace }) {
  let dashboardTab = findById(tabs, previousWorkspace?.dashboardTabId);
  if (!isDashboardTab(dashboardTab, dashboardUrl)) dashboardTab = null;
  const candidates = tabs.filter((tab) => isDashboardTab(tab, dashboardUrl));
  dashboardTab ||= chooseTab(candidates);
  if (dashboardTab) return requireWindowIdentity(dashboardTab);

  const opener = chooseTab(tabs.filter((tab) => Number.isInteger(tab?.windowId)));
  if (!opener) throw workspaceError("WORKSPACE_DASHBOARD_TAB_REQUIRED", "专用 Edge 中没有可用的 RoleFlow 工作台页面。");
  const tabId = await browser.createTab(opener.id, dashboardUrl);
  const refreshed = await browser.listTabs();
  dashboardTab = findById(refreshed, tabId);
  if (!isDashboardTab(dashboardTab, dashboardUrl) || dashboardTab.windowId !== opener.windowId) {
    throw workspaceError("WORKSPACE_DASHBOARD_TAB_REQUIRED", "RoleFlow 工作台页面未能在原窗口后台建立。");
  }
  return requireWindowIdentity(dashboardTab);
}

async function ensureRoleTab({ browser, tabs, openerTab, previousTabId, site, role }) {
  const previous = findById(tabs, previousTabId);
  const oppositeRole = role === "search" ? "message" : "search";
  const previousBelongsToRole = matchesRole(previous, site, role, { allowRuntimePath: role === "search" });
  const previousIsLoginLanding = isPlatformTab(previous, site)
    && !matchesRole(previous, site, oppositeRole, { allowRuntimePath: oppositeRole === "search" });
  if (previous && previous.windowId === openerTab.windowId && (previousBelongsToRole || previousIsLoginLanding)) {
    return requireWindowIdentity(previous);
  }
  const candidates = tabs.filter((tab) => tab.windowId === openerTab.windowId && matchesRole(tab, site, role));
  const existing = chooseTab(candidates);
  if (existing) return requireWindowIdentity(existing);

  const definition = PLATFORM_WORKSPACE_DEFINITIONS[site];
  const url = role === "search" ? definition.searchUrl : definition.messageUrl;
  const tabId = await browser.createTab(openerTab.id, url);
  const refreshed = await browser.listTabs();
  const created = findById(refreshed, tabId);
  if (!created || created.windowId !== openerTab.windowId || created.active === true) {
    throw workspaceError("BROWSER_COMMAND_FAILED", `${definition.label}页面未能在工作台后台建立。`);
  }
  return requireWindowIdentity(created);
}

function platformSnapshot({ site, searchTab, messageTab, windowId }) {
  const searchReady = matchesRole(searchTab, site, "search", { allowRuntimePath: true });
  const messageReady = matchesRole(messageTab, site, "message");
  const sameWindow = searchTab.windowId === windowId && messageTab.windowId === windowId;
  const status = searchReady && messageReady && sameWindow
    ? "ready"
    : isPlatformTab(searchTab, site) || isPlatformTab(messageTab, site)
      ? "login_required"
      : "not_ready";
  return {
    site,
    enabled: true,
    status,
    searchTabId: searchTab.id,
    messageTabId: messageTab.id,
    windowId
  };
}

function workspaceResult({ dashboardTab, enabled, platforms, status }) {
  const boss = platforms.boss || null;
  const zhaopin = platforms.zhaopin || null;
  return {
    status,
    enabledPlatforms: enabled,
    dashboardTabId: dashboardTab.id,
    windowId: dashboardTab.windowId,
    platforms,
    bossTabId: boss?.searchTabId ?? null,
    communicationTabId: boss?.messageTabId ?? null,
    zhaopinSearchTabId: zhaopin?.searchTabId ?? null,
    zhaopinMessageTabId: zhaopin?.messageTabId ?? null
  };
}

function normalizePlatforms(value) {
  const requested = new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim().toLowerCase()));
  for (const site of requested) {
    if (!Object.hasOwn(PLATFORM_WORKSPACE_DEFINITIONS, site)) {
      throw workspaceError("WORKSPACE_PLATFORM_INVALID", "请选择 RoleFlow 当前支持的招聘平台。");
    }
  }
  return Object.keys(PLATFORM_WORKSPACE_DEFINITIONS).filter((site) => requested.has(site));
}

function matchesRole(tab, site, role, { allowRuntimePath = false } = {}) {
  let url;
  try { url = new URL(String(tab?.url || "")); } catch { return false; }
  if (site === "boss") {
    if (!/(^|\.)zhipin\.com$/i.test(url.hostname)) return false;
    if (role === "message") return url.pathname === "/web/geek/chat";
    return url.pathname === "/web/geek/jobs"
      || (allowRuntimePath && /^\/job_detail\/[^/?#]+\.html$/i.test(url.pathname));
  }
  if (site === "zhaopin") {
    if (role === "message") return url.hostname === "i.zhaopin.com" && /^\/im\/?$/i.test(url.pathname);
    return url.hostname === "www.zhaopin.com" && /^\/jobs\/?$/i.test(url.pathname);
  }
  return false;
}

function isPlatformTab(tab, site) {
  try {
    const hostname = new URL(String(tab?.url || "")).hostname;
    return site === "boss"
      ? /(^|\.)zhipin\.com$/i.test(hostname)
      : site === "zhaopin" && /(^|\.)zhaopin\.com$/i.test(hostname);
  } catch { return false; }
}

function isDashboardTab(tab, dashboardUrl) {
  try {
    const actual = new URL(String(tab?.url || ""));
    const expected = new URL(String(dashboardUrl || ""));
    return actual.origin === expected.origin;
  } catch { return false; }
}

function findById(tabs, tabId) {
  if (tabId === null || tabId === undefined) return null;
  return (tabs || []).find((tab) => sameBrowserTabId(tab.id, tabId)) || null;
}

function chooseTab(tabs) {
  return [...(tabs || [])].sort((left, right) => {
    if (left.active === true && right.active !== true) return -1;
    if (right.active === true && left.active !== true) return 1;
    return `${typeof left.id}:${String(left.id)}`.localeCompare(`${typeof right.id}:${String(right.id)}`);
  })[0] || null;
}

function requireWindowIdentity(tab) {
  if (!tab || !Number.isInteger(tab.windowId)) {
    throw workspaceError("BROWSER_COMMAND_FAILED", "工作区页面缺少可靠的浏览器窗口身份。");
  }
  return tab;
}

function workspaceError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.isWorkspaceError = true;
  return error;
}

module.exports = {
  PLATFORM_WORKSPACE_DEFINITIONS,
  preparePlatformWorkspaceTabs,
  matchesRole,
  isPlatformTab
};
