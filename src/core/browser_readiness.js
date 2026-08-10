const BROWSER_READINESS_MESSAGES = Object.freeze({
  browser_unavailable: "Edge Control 未连接到普通 Edge，请启动桥接服务并确认扩展已连接。",
  boss_tab_missing: "请在普通 Edge 保留一个 BOSS 搜索页和一个 BOSS 沟通页，并放在同一窗口。",
  login_required: "等待登录：请在普通 Edge 的 BOSS 标签页完成登录。",
  search_page_required: "请在固定 BOSS 搜索标签打开职位搜索结果页并设置本轮筛选。",
  risk_control: "BOSS 当前要求安全验证，请完成验证后再继续。",
  ready: "普通 Edge 已登录并就绪，可以执行一轮。"
});

const CODE_TO_STATUS = Object.freeze({
  BROWSER_DISCONNECTED: "browser_unavailable",
  BROWSER_TIMEOUT: "browser_unavailable",
  BROWSER_COMMAND_FAILED: "browser_unavailable",
  BOSS_TAB_REQUIRED: "boss_tab_missing",
  BOSS_LOGIN_REQUIRED: "login_required",
  BOSS_RISK_CONTROL: "risk_control",
  BOSS_SEARCH_PAGE_INVALID: "search_page_required",
  BOSS_SEARCH_PAGE_LOST: "search_page_required",
  BOSS_SEARCH_TAB_CHANGED: "search_page_required",
  BOSS_COMMUNICATION_PAGE_LOST: "boss_tab_missing",
  BOSS_OPERATOR_TABS_CHANGED: "boss_tab_missing",
  BOSS_WINDOW_MISMATCH: "boss_tab_missing",
  BOSS_COMMUNICATION_TAB_WINDOW_MISMATCH: "boss_tab_missing",
  BOSS_COMMUNICATION_TAB_WINDOW_UNKNOWN: "boss_tab_missing"
});

async function inspectBossBrowserReadiness({
  preflight,
  now = () => new Date().toISOString()
}) {
  if (typeof preflight !== "function") {
    throw new TypeError("inspectBossBrowserReadiness requires preflight()");
  }
  try {
    const state = await preflight();
    return readinessSnapshot(state?.isSearchPage ? "ready" : "search_page_required", now);
  } catch (error) {
    const status = CODE_TO_STATUS[error?.code];
    if (!status) throw error;
    return readinessSnapshot(status, now);
  }
}

function readinessSnapshot(status, now) {
  return {
    status,
    ready: status === "ready",
    message: BROWSER_READINESS_MESSAGES[status],
    checkedAt: now()
  };
}

module.exports = {
  BROWSER_READINESS_MESSAGES,
  inspectBossBrowserReadiness
};
