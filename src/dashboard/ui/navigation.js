const { escapeAttr, escapeHtml } = require("../http/response");

function renderNavigation({ currentPath = "", todayPath = "", planId = "" } = {}) {
  const current = String(currentPath || "");
  const currentRoute = routePath(current);
  const resolvedPlanId = String(planId || planIdFromPath(todayPath) || planIdFromPath(current) || "");
  if (resolvedPlanId) {
    const encodedPlanId = encodeURIComponent(resolvedPlanId);
    const planHref = currentRoute === "/plan" ? current : (todayPath || `/plan?planId=${encodedPlanId}`);
    const workflowHref = currentRoute === "/workflow" ? current : `${planHref}#today-discovery`;
    const jobsHref = ["/queue", "/jobs"].includes(currentRoute) ? current : `/queue?planId=${encodedPlanId}`;
    const communicationHref = ["/communication", "/communication/new"].includes(currentRoute)
      ? current
      : `/communication/new?planId=${encodedPlanId}`;
    const messagesHref = currentRoute === "/messages" ? current : `/messages?planId=${encodedPlanId}`;
    const resumeRoutes = ["/resume-optimization", "/profile", "/resumes", "/onboarding"];
    const resumeHref = resumeRoutes.includes(currentRoute) ? current : `/resume-optimization?planId=${encodedPlanId}`;
    return [
      navigationGroup("工作台", [
        navigationLink(planHref, "今日任务", currentRoute === "/plan")
      ]),
      navigationGroup("求职", [
        navigationLink(workflowHref, "发现岗位", currentRoute === "/workflow"),
        navigationLink(jobsHref, "岗位记录", ["/queue", "/jobs"].includes(currentRoute)),
        navigationLink(`/funnel?planId=${encodedPlanId}`, "求职体检", currentRoute === "/funnel")
      ]),
      navigationGroup("沟通", [
        navigationLink(messagesHref, "消息与回复", currentRoute === "/messages"),
        navigationLink(communicationHref, "发送记录", ["/communication", "/communication/new"].includes(currentRoute))
      ]),
      navigationGroup("成长", [
        navigationLink(resumeHref, "简历工作室", resumeRoutes.includes(currentRoute)),
        navigationLink(`/interview?planId=${encodedPlanId}`, "面试训练", currentRoute === "/interview")
      ]),
      navigationGroup("", [
        navigationLink("/settings", "模型与设置", currentRoute === "/settings"),
        navigationLink("/diagnostics", "运行诊断", currentRoute === "/diagnostics")
      ], "sidebar-utility")
    ].join("");
  }
  const resumeHref = currentRoute === "/onboarding" ? current : "/onboarding";
  return [
    navigationGroup("工作台", [
      navigationLink(todayPath || "/", "今日任务", currentRoute === "/plan")
    ]),
    navigationGroup("成长", [
      navigationLink(resumeHref, "简历工作室", currentRoute === "/onboarding")
    ]),
    navigationGroup("", [
      navigationLink("/settings", "模型与设置", currentRoute === "/settings"),
      navigationLink("/diagnostics", "运行诊断", currentRoute === "/diagnostics")
    ], "sidebar-utility")
  ].join("");
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
  return `<a class="nav-item" href="${escapeAttr(href)}"${current ? ' aria-current="page"' : ""}>${escapeHtml(label)}</a>`;
}

function navigationGroup(label, links, extraClass = "") {
  const className = ["nav-group", extraClass].filter(Boolean).join(" ");
  return `<section class="${className}">${label ? `<span class="nav-group-label">${escapeHtml(label)}</span>` : ""}<div class="nav-group-items">${links.join("")}</div></section>`;
}

module.exports = { renderNavigation };
