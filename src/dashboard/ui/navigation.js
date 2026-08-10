const { escapeAttr, escapeHtml } = require("../http/response");

function renderNavigation({ currentPath = "", planId = "" } = {}) {
  const current = String(currentPath || "");
  const resolvedPlanId = String(planId || current.match(/[?&]planId=(\d+)/)?.[1] || "");
  if (resolvedPlanId) {
    return [
      navigationLink("/onboarding", "简历"),
      navigationLink(current, "今日任务", true),
      navigationLink(`/queue?planId=${resolvedPlanId}`, "当前岗位"),
      navigationLink(`/communication/new?planId=${resolvedPlanId}`, "批量沟通清单"),
      navigationLink("/settings", "模型设置"),
      navigationLink("/diagnostics", "诊断")
    ].join("");
  }
  return [
    navigationLink("/onboarding", "简历"),
    navigationLink(current || "/", "筛选方案", Boolean(current)),
    navigationLink("/settings", "模型设置"),
    navigationLink("/diagnostics", "诊断")
  ].join("");
}

function navigationLink(href, label, current = false) {
  return `<a href="${escapeAttr(href)}"${current ? ' aria-current="page"' : ""}>${escapeHtml(label)}</a>`;
}

module.exports = { renderNavigation };
