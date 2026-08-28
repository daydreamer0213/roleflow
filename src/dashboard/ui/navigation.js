const { escapeAttr, escapeHtml } = require("../http/response");

function renderNavigation({ currentPath = "", todayPath = "", planId = "" } = {}) {
  const current = String(currentPath || "");
  const currentRoute = routePath(current);
  const resolvedPlanId = String(planId || planIdFromPath(todayPath) || planIdFromPath(current) || "");
  if (resolvedPlanId) {
    const encodedPlanId = encodeURIComponent(resolvedPlanId);
    const links = [
      navigationLink("/onboarding", "简历", currentRoute === "/onboarding"),
      navigationLink(todayPath || `/plan?planId=${encodedPlanId}`, "今日任务", currentRoute === "/plan"),
      navigationLink(`/queue?planId=${encodedPlanId}`, "当前岗位", currentRoute === "/queue"),
      navigationLink(`/communication/new?planId=${encodedPlanId}`, "批量沟通清单", currentRoute === "/communication/new"),
      navigationLink(`/communication?planId=${encodedPlanId}`, "自动沟通", currentRoute === "/communication"),
      navigationLink(currentRoute === "/messages" ? current : `/messages?planId=${encodedPlanId}`, "消息发现", currentRoute === "/messages"),
      navigationLink(`/funnel?planId=${encodedPlanId}`, "求职体检", currentRoute === "/funnel"),
      navigationLink(`/resume-optimization?planId=${encodedPlanId}`, "定向简历", currentRoute === "/resume-optimization"),
      navigationLink("/settings", "模型设置", currentRoute === "/settings"),
      navigationLink("/diagnostics", "诊断", currentRoute === "/diagnostics")
    ];
    if (currentRoute === "/workflow") links.push(navigationLink(current, "本轮", true));
    if (currentRoute === "/jobs") links.push(navigationLink(current, "岗位列表", true));
    return links.join("");
  }
  const links = [
    navigationLink("/onboarding", "简历", currentRoute === "/onboarding"),
    navigationLink(todayPath || "/", "筛选方案", currentRoute === "/plan"),
    navigationLink("/settings", "模型设置", currentRoute === "/settings"),
    navigationLink("/diagnostics", "诊断", currentRoute === "/diagnostics")
  ];
  if (currentRoute === "/messages") links.push(navigationLink(current, "消息发现", true));
  return links.join("");
}

function planIdFromPath(value) {
  try {
    return new URL(String(value || ""), "http://127.0.0.1").searchParams.get("planId") || "";
  } catch {
    return "";
  }
}

function routePath(value) {
  try {
    return new URL(String(value || ""), "http://127.0.0.1").pathname;
  } catch {
    return "";
  }
}

function navigationLink(href, label, current = false) {
  return `<a href="${escapeAttr(href)}"${current ? ' aria-current="page"' : ""}>${escapeHtml(label)}</a>`;
}

module.exports = { renderNavigation };
