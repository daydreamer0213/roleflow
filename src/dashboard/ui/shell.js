const { escapeHtml } = require("../http/response");
const { escapeAttr } = require("../http/response");
const { renderNavigation } = require("./navigation");

function renderPage({ title = "", body = "", scripts = [] } = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/assets/roleflow.css"></head><body>${body}${scripts.join("")}</body></html>`;
}

function renderDashboardFrame({ currentPath = "", todayPath = "", planId = "", stage = "", brandHref = "/plan", content = "" } = {}) {
  return `<a class="skip-link" href="#main-content">跳到主要内容</a><div class="app-shell"><aside class="app-sidebar"><a class="sidebar-brand" href="${escapeAttr(brandHref)}"><span class="sidebar-mark" aria-hidden="true">RF</span><strong>RoleFlow</strong></a><div class="sidebar-context"><span>当前页面</span><strong>${escapeHtml(stage || "工作台")}</strong></div><nav class="primary-nav" aria-label="主导航">${renderNavigation({ currentPath, todayPath, planId })}</nav></aside><div class="page app-workspace"><section class="runtime-status" data-runtime-status data-state="waiting" aria-live="polite"><span class="runtime-signal" aria-hidden="true"></span><span class="runtime-copy"><strong data-runtime-title>正在准备专用 Edge…</strong><span data-runtime-message>工作台可以继续使用。</span></span><button type="button" data-runtime-recover hidden>恢复专用 Edge</button></section>${content}</div></div><script src="/assets/runtime.js"></script>`;
}

function renderFramedPage({ title = "", currentPath = "", todayPath = "", planId = "", stage = "", brandHref = "/plan", content = "", scripts = [] } = {}) {
  return renderPage({ title, body: renderDashboardFrame({ currentPath, todayPath, planId, stage, brandHref, content }), scripts });
}

module.exports = { renderPage, renderDashboardFrame, renderFramedPage };
