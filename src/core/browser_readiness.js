const BROWSER_READINESS_MESSAGES = Object.freeze({
  browser_unavailable: "项目专用 Edge 尚未启动或已经断开。",
  boss_tab_missing: "未找到 BOSS 标签页，请在项目专用 Edge 打开 BOSS。",
  login_required: "等待登录：请在 BOSS 标签页完成登录。",
  search_page_required: "请在 BOSS 标签页打开岗位搜索结果页并设置本轮筛选。",
  risk_control: "BOSS 当前要求安全验证，请完成验证后再继续。",
  ready: "继承模式已就绪，可以执行一轮。"
});

const CODE_TO_STATUS = Object.freeze({
  BROWSER_DISCONNECTED: "browser_unavailable",
  BROWSER_TIMEOUT: "browser_unavailable",
  BROWSER_COMMAND_FAILED: "browser_unavailable",
  BOSS_TAB_REQUIRED: "boss_tab_missing",
  BOSS_LOGIN_REQUIRED: "login_required",
  BOSS_RISK_CONTROL: "risk_control",
  BOSS_SEARCH_PAGE_INVALID: "search_page_required",
  BOSS_SEARCH_PAGE_LOST: "search_page_required"
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
