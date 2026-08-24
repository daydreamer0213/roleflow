const BROWSER_READINESS_MESSAGES = Object.freeze(readinessMessages("edge"));

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
  BOSS_COMMUNICATION_PAGE_LOST: "communication_page_required",
  BOSS_OPERATOR_TABS_CHANGED: "communication_page_required",
  BOSS_WINDOW_MISMATCH: "boss_tab_missing",
  BOSS_COMMUNICATION_TAB_WINDOW_MISMATCH: "boss_tab_missing",
  BOSS_COMMUNICATION_TAB_WINDOW_UNKNOWN: "boss_tab_missing"
});

const STATUS_ACTIONS = Object.freeze({
  starting: "wait",
  unavailable: "recover",
  conflict: "diagnostics",
  stopped: "recover",
  needs_attention: "diagnostics",
  browser_unavailable: "recover",
  boss_tab_missing: "reconcile",
  login_required: "login",
  search_page_required: "reconcile",
  communication_page_required: "reconcile",
  risk_control: "verify",
  ambiguous: "diagnostics",
  ready: "none"
});

async function inspectBossBrowserReadiness({
  preflight,
  browserMode = "edge",
  supervisorSnapshot = null,
  now = () => new Date().toISOString()
}) {
  const supervisorStatus = String(supervisorSnapshot?.status || "");
  if (supervisorSnapshot && supervisorStatus !== "ready") {
    const status = supervisorStatus === "unknown" ? "starting" : supervisorStatus;
    if (STATUS_ACTIONS[status]) return readinessSnapshot(status, now, browserMode);
  }
  if (typeof preflight !== "function") {
    throw new TypeError("inspectBossBrowserReadiness requires preflight()");
  }
  try {
    const state = await preflight();
    return readinessSnapshot(state?.isSearchPage ? "ready" : "search_page_required", now, browserMode);
  } catch (error) {
    const status = CODE_TO_STATUS[error?.code];
    if (!status) throw error;
    return readinessSnapshot(status, now, browserMode);
  }
}

function readinessSnapshot(status, now, browserMode) {
  return {
    status,
    ready: status === "ready",
    message: readinessMessages(browserMode)[status],
    action: readinessAction(status),
    checkedAt: now()
  };
}

function readinessAction(status) {
  return STATUS_ACTIONS[status] || "none";
}

function readinessMessages(browserMode) {
  const label = browserMode === "edge"
    ? "使用当前 Edge（高级，需要浏览器连接组件）"
    : "RoleFlow 专用 Edge（推荐）";
  return {
    starting: `${label}正在启动，请稍候。`,
    unavailable: `${label}暂时无法启动。请确认这台电脑已安装 Microsoft Edge，然后点击恢复。`,
    conflict: `${label}正被其他程序占用。请打开诊断查看处理方法。`,
    stopped: `${label}已关闭。需要浏览器时，请点击恢复。`,
    needs_attention: `${label}需要处理后才能继续。请打开诊断查看提示。`,
    browser_unavailable: `${label} 未连接，请确认浏览器和连接服务均已就绪。`,
    boss_tab_missing: `请在${label}保留一个 BOSS 搜索页和一个 BOSS 沟通页，并放在同一窗口。`,
    login_required: `等待登录：请在${label}的 BOSS 标签页完成登录。`,
    search_page_required: `请在${label}的固定 BOSS 搜索标签打开职位搜索结果页并设置本轮筛选。`,
    communication_page_required: `请整理${label}的 BOSS 沟通页后再继续。`,
    risk_control: "BOSS 当前要求安全验证，请完成验证后再继续。",
    ambiguous: `${label}中存在无法安全判断的页面。请打开诊断查看处理方法。`,
    ready: `${label}已登录并就绪，可以执行一轮。`
  };
}

module.exports = {
  BROWSER_READINESS_MESSAGES,
  inspectBossBrowserReadiness,
  readinessAction
};
