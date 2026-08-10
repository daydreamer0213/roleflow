const { escapeHtml } = require("../http/response");
const { escapeAttr } = require("../http/response");
const { renderNavigation } = require("./navigation");

function renderPage({ title = "", body = "", scripts = [] } = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/assets/roleflow.css"></head><body>${body}${scripts.join("")}</body></html>`;
}

function renderDashboardFrame({ currentPath = "", todayPath = "", planId = "", stage = "", brandHref = "/plan", content = "" } = {}) {
  return `<a class="skip-link" href="#main-content">跳到主要内容</a><div class="app-shell"><aside class="signal-rail" aria-label="RoleFlow 阶段标记"><div class="rail-mark" aria-hidden="true">RF</div><div class="rail-label">${escapeHtml(stage)}</div><div class="rail-spacer"></div><span class="rail-dot attention" title="有待处理事项"></span></aside><div class="page"><header class="topbar"><a class="brand" href="${escapeAttr(brandHref)}"><strong>RoleFlow</strong><span>本地岗位工作台</span></a><nav class="primary-nav" aria-label="主导航">${renderNavigation({ currentPath, todayPath, planId })}</nav><span class="nav-scroll-hint" aria-hidden="true">左右滑动查看更多</span></header>${content}</div></div>`;
}

module.exports = { renderPage, renderDashboardFrame };
