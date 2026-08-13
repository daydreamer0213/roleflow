"use strict";

const { escapeAttr, escapeHtml } = require("../http/response");
const { renderDashboardFrame } = require("../ui/shell");
const { communicationStatusLabel } = require("../status_labels");

function renderCommunicationPage(vm = {}) {
  const page = vm.page || {};
  return renderDashboardFrame({ currentPath: page.currentPath, todayPath: page.planHref, planId: page.planId, stage: "自动沟通", brandHref: page.planHref || "/plan", content: `<main id="main-content" class="communication-shell">
    ${header(vm)}${primary(vm)}${currentBatch(vm)}${history(vm)}
  </main>` });
}

function header(vm) {
  const state = stateLabel(vm.state);
  return `<header class="page-heading communication-heading"><p class="eyebrow">沟通中心</p><h1>自动沟通</h1><p class="lede">在这里核对已确认清单、处理不明确结果，并查看串行执行进度。确认后系统串行执行；不会自主发送。</p><div class="heading-meta"><span class="status ${statusClass(vm.state)}">${escapeHtml(state)}</span>${vm.page?.planName ? `<span>筛选方案：${escapeHtml(vm.page.planName)}</span>` : ""}</div></header>`;
}

function primary(vm) {
  if (vm.state === "no_batch") return `<section class="action-panel communication-empty"><p class="section-label">尚未确认沟通清单</p><h2>先从岗位清单建立人工确认的沟通批次</h2><p class="muted">进入清单页不会创建、确认或启动任何沟通。</p><a class="button" data-page-primary="true" href="${escapeAttr(vm.page?.planId ? `/communication/new?planId=${encodeURIComponent(vm.page.planId)}` : "/plan")}">查看沟通清单</a></section>`;
  if (vm.state === "integrity_blocked") return `<section id="communication-recovery" class="alert" role="alert"><strong>批次范围无法安全确认</strong><p>检测到 ${escapeHtml(vm.integrityIssue || "范围不一致")}。本地数据未被修改；请从筛选方案重新进入，或查看诊断。</p><a class="button secondary" href="/diagnostics">查看诊断</a></section>`;
  if (vm.state === "needs_resolution") {
    const first = (vm.items || []).find((item) => item.status === "ambiguous");
    const recovery = first ? `<a class="button secondary" href="/communication?batchId=${number(vm.batch?.id)}#communication-item-${number(first.id)}">处理不明确结果</a>` : `<a class="button secondary" href="/diagnostics">查看诊断</a>`;
    return `<section id="communication-recovery" class="alert" role="alert"><strong>需要先处理不明确结果</strong><p>${vm.ambiguity?.countsMismatch ? "批次汇总与条目状态不一致。" : "存在不能确认结果的岗位。"} 已移除所有开始和继续表单；请在下方填写可核验的处理依据。</p>${recovery}</section>`;
  }
  if (vm.state === "running") return `<section class="action-panel"><p class="section-label">串行执行中</p><h2>正在按确认清单逐项执行</h2><p class="muted">仅显示已核验的沟通结果；配额预留和尝试不会被计作成功。</p></section>`;
  if (vm.state === "completed") return `<section class="action-panel"><p class="section-label">本批次已结束</p><h2>已保留结果，未把未核验尝试当作成功</h2><p class="muted">可在下方查看条目和近期批次。</p></section>`;
  if (!vm.controls?.visible) return "";
  const discard = ["confirmed", "paused"].includes(vm.batch?.status) ? `<form method="post" action="/api/communication-control"><input type="hidden" name="batchId" value="${number(vm.batch?.id)}"><button class="communication-discard" name="action" value="discard">安全撤回</button></form>` : "";
  return `<section class="action-panel"><p class="section-label">等待人工确认</p><h2>确认后按固定清单串行执行</h2><p class="muted">开始前仍会检查校准、身份、配额、冷却、无重复点击和范围一致性。</p><div class="button-row"><form method="post" action="/api/communication-control"><input type="hidden" name="batchId" value="${number(vm.batch?.id)}"><button class="communication-primary" data-page-primary="true" name="action" value="${escapeAttr(vm.controls.action)}">${escapeHtml(vm.controls.label)}</button></form>${discard}</div></section>`;
}

function currentBatch(vm) {
  if (!vm.batch) return "";
  const quota = vm.quota || {};
  const outcomes = vm.outcomes || {};
  const runtime = vm.runtimeBlock ? `<div class="alert" role="alert"><strong>运行环境已阻止执行</strong><p>${escapeHtml(vm.runtimeBlock.reasonCode)}${vm.runtimeBlock.blockedUntil ? ` · ${escapeHtml(vm.runtimeBlock.blockedUntil)}` : ""}</p></div>` : "";
  const calibration = vm.calibration || {};
  return `<section class="communication-current"><div class="card-head"><div><p class="section-label">当前批次</p><h2>批次 #${number(vm.batch.id)}</h2></div><span class="status ${statusClass(vm.state)}">${escapeHtml(stateLabel(vm.state))}</span></div><div class="card-body">${runtime}<div class="communication-metrics" aria-label="批次统计"><div><span>已确认岗位</span><strong>${number(vm.batch.total)}</strong></div><div><span>已完成条目</span><strong>${number(vm.batch.terminal)}</strong></div><div><span>已核验成功</span><strong>${number(outcomes.succeeded)}</strong></div><div><span>剩余待处理</span><strong>${number(vm.batch.remaining)}</strong></div></div><div class="communication-ledger"><section><h3>安全操作额度</h3><p>已用 ${number(quota.used)} · 已预留 ${number(quota.reserved)} · 剩余 ${number(quota.remaining)} / ${number(quota.limit)}</p></section><section><h3>已核验沟通结果</h3><p>成功 ${number(outcomes.succeeded)} · 已沟通 ${number(outcomes.alreadyCommunicated)} · 停止 ${number(outcomes.stopped)} · 未成功 ${number(outcomes.failed)}</p></section><section><h3>沟通校准</h3><p>实施：${escapeHtml(calibration.implementation === "implemented" ? "已实现" : calibration.implementation || "未知")} · 校准：${escapeHtml(calibration.calibration === "calibrated" ? "已完成" : calibration.calibration || "未知")}</p><p>端到端验收：${escapeHtml(calibration.acceptance === "e2e_pending" ? "待人工 E2E 验收（e2e_pending）" : calibration.acceptance || "未知")} · 技术执行门：${calibration.executionEnabled ? "已启用" : "未启用"}</p></section></div><div class="communication-items">${(vm.items || []).map(item).join("") || "<p class=\"hint\">该批次没有可显示的条目。</p>"}</div></div></section>`;
}

function item(row = {}) {
  const title = row.jobUrl ? `<a href="${escapeAttr(row.jobUrl)}" target="_blank" rel="noreferrer">${escapeHtml(row.title || "未保存岗位")}</a>` : escapeHtml(row.title || "未保存岗位");
  const resolution = row.resolution ? `<form class="communication-resolution" method="post" action="/api/communication-resolve"><input type="hidden" name="batchId" value="${number(row.batchId)}"><input type="hidden" name="itemId" value="${number(row.id)}"><label>处理依据（必须可核验）<input name="evidenceNote" maxlength="1000" placeholder="例如：聊天页已显示对应岗位和招聘方" required></label><div class="button-row"><button class="secondary" name="status" value="succeeded">确认已沟通</button><button class="secondary" name="status" value="stopped">标记停止</button></div></form>` : "";
  return `<article id="communication-item-${number(row.id)}" class="communication-item"><div class="communication-item-head"><div><p class="section-label">#${number(row.position)}</p><h3>${title}</h3><p class="muted">${escapeHtml(row.company || "未保存公司")}</p></div><span class="status ${statusClass(row.status)}">${escapeHtml(itemStatusLabel(row.status))}</span></div><dl class="definition-grid communication-facts"><div><dt>薪资</dt><dd>${escapeHtml(row.salary)}</dd></div><div><dt>地点</dt><dd>${escapeHtml(row.location)}</dd></div><div><dt>推荐层级</dt><dd>${escapeHtml(tierLabel(row.tier))}</dd></div><div><dt>点击记录</dt><dd>${number(row.clickCount)}</dd></div></dl><details><summary>查看推荐依据、风险和处理信息</summary><div class="communication-detail"><p><strong>关键证据：</strong>${escapeHtml((row.evidence || []).join("；") || "未保存")}</p><p><strong>风险：</strong>${escapeHtml((row.risks || []).join("；") || "未保存")}</p><p><strong>建议原因：</strong>${escapeHtml(row.proposalReason || "未保存")}</p>${row.errorCode ? `<p class="risk-text"><strong>${escapeHtml(row.errorCode)}</strong> ${escapeHtml(row.errorMessage)}</p>` : ""}</div></details>${resolution}</article>`;
}

function history(vm) {
  if (!(vm.history || []).length) return "";
  return `<section class="communication-history"><div class="card-head"><div><p class="section-label">近期历史</p><h2>同一筛选方案的已关联批次</h2></div></div><div class="card-body list">${vm.history.map((entry) => `<div class="list-row"><div><strong>批次 #${number(entry.batchId)}</strong><p>${escapeHtml(itemStatusLabel(entry.status))} · 已核验成功 ${number(entry.succeeded)} / ${number(entry.total)}</p></div><a class="button quiet" href="${escapeAttr(entry.href)}">查看</a></div>`).join("")}</div></section>`;
}

function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0; }
function stateLabel(state) { return { pending_review: "等待确认", running: "串行执行中", needs_resolution: "需要处理", completed: "已结束", no_batch: "尚无批次", integrity_blocked: "范围已阻止" }[state] || "处理中"; }
function itemStatusLabel(status) { return communicationStatusLabel(status); }
function tierLabel(tier) { return { primary: "主投", apply: "可投", caution: "慎投" }[tier] || tier || "未保存"; }
function statusClass(value) { return ["needs_resolution", "integrity_blocked", "ambiguous", "failed", "platform_rejected", "transport_failed"].includes(value) ? "danger" : ["pending_review", "confirmed", "paused", "interrupted", "opening", "verified", "click_dispatched"].includes(value) ? "waiting" : "good"; }

module.exports = { renderCommunicationPage };
