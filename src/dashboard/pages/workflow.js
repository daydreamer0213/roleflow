"use strict";

const { escapeHtml, escapeAttr } = require("../http/response");
const { renderDashboardFrame } = require("../ui/shell");
const { renderWorkflowHealthPanel } = require("../workflow_health_view");
const { communicationStatusLabel, communicationErrorLabel } = require("../status_labels");

function renderWorkflowPage(vm = {}) {
  const page = vm.page || {};
  const overview = renderPrimary(vm);
  const command = renderPrimaryCommand(vm.phase, vm.controls);
  const phase = renderPhase(vm.phase);
  const tracks = renderProgressTracks(vm.progress);
  const error = vm.progress?.visible ? '<p class="workflow-inline-error" data-workflow-error role="alert" hidden>无法读取任务状态</p>' : "";
  const actionFirst = Boolean(vm.controls?.pausedVisible || (vm.phase?.kind && vm.phase.kind !== "active"));
  const primaryContent = actionFirst
    ? `${command}${phase}${overview}${tracks}`
    : `${overview}${tracks}${command}${phase}`;
  return renderDashboardFrame({ currentPath: page.currentPath, todayPath: page.planHref, planId: page.planId, stage: "本轮执行", brandHref: page.planHref, content: `<main id="main-content" class="workflow-shell" data-workflow-page data-polling-kind="${escapeAttr(vm.polling?.kind || "none")}" data-workflow-run-id="${escapeAttr(vm.polling?.runId || page.runId)}" data-polling-interval="${Number(vm.polling?.intervalMs || 2500)}" data-polling-key="${escapeAttr(vm.polling?.initialKey || "")}" data-terminal-states="${escapeAttr((vm.polling?.terminalStates || []).join(","))}" data-workflow-status="${escapeAttr(vm.progress?.status || vm.phase?.status || "")}" data-workflow-control-state="${escapeAttr(vm.progress?.controlState || "")}" data-workflow-phase-key="${escapeAttr(vm.progress?.phaseKey || "")}">
  ${renderHeader(vm)}${error}${primaryContent}<details class="workflow-technical"><summary>运行详情</summary>${renderRunMetrics(vm.header)}${renderScope(vm.scope)}${vm.health?.report?.status ? renderWorkflowHealthPanel(vm.health.report) : ""}${renderProgress(vm.progress)}</details>
</main><script src="/assets/workflow.js"></script>` });
}

function renderHeader(vm) {
  const header = vm.header || {};
  const page = vm.page || {};
  return `<header class="workflow-head"><div class="workflow-headline"><div><p class="workflow-sequence">第 ${number(header.sequence)} 轮 · ${escapeHtml(header.localDay)}</p><h1>${escapeHtml(header.statusLabel)}</h1></div><a href="${escapeAttr(page.planHref)}">返回筛选方案</a></div></header>`;
}

function renderPrimary(vm = {}) {
  const overview = vm.overview || {};
  const blocker = overview.blocker || {};
  const cooldown = overview.cooldown || {};
  const blockerDetail = `<span data-overview-blocker-stable${cooldown.active ? " hidden" : ""}>${escapeHtml(blocker.label || "")}：${escapeHtml(blocker.detail || "")}；${escapeHtml(blocker.recovery || "")}</span><span data-cooldown data-retry-at="${escapeAttr(cooldown.retryAt || "")}"${cooldown.active ? "" : " hidden"}>安全冷却中：<span data-cooldown-reason>${escapeHtml(cooldown.reason || "")}</span>；重试时间 <time data-cooldown-retry-time datetime="${escapeAttr(cooldown.retryAt || "")}">${escapeHtml(cooldown.retryAtLabel || "")}</time>；<span data-cooldown-countdown data-retry-at="${escapeAttr(cooldown.retryAt || "")}" aria-hidden="true"></span></span>`;
  return `<div class="workflow-focus"><section class="workflow-primary" role="region" aria-labelledby="workflow-primary-title"><h2 id="workflow-primary-title">本轮概览</h2><dl class="workflow-primary-grid">${primaryField("当前阶段", overview.currentPhase, false, "phase")}${primaryField("整体进度", overview.overallProgress, false, "progress")}${primaryField("采集进度", overview.acquisitionProgress, false, "acquisition")}${primaryField("完整 JD", overview.jdProgress, false, "jd")}${primaryField("可用推荐", overview.usableRecommendations, false, "recommendations")}${primaryField("剩余工作", overview.remainingWork, false, "remaining")}${primaryField("预计继续时间", overview.estimatedContinuation, false, "eta")}${primaryField("暂停/阻塞原因", blockerDetail, true, "blocker")}${primaryField("下一步", overview.nextAction, false, "next-action")}</dl></section></div>`;
}

function primaryField(label, value, trusted = false, hook = "") { return `<div class="workflow-primary-field" data-workflow-primary-field><dt>${escapeHtml(label)}</dt><dd${hook ? ` data-overview-${escapeAttr(hook)}` : ""}>${trusted ? value : escapeHtml(String(value ?? ""))}</dd></div>`; }
function renderRunMetrics(header = {}) { return `<section class="workflow-run-metrics"><h2>本轮统计</h2><dl><div><dt>本轮目标</dt><dd>${number(header.targetSuccessCount)}</dd></div><div><dt>本轮成功</dt><dd>${number(header.successfulCount)}</dd></div><div><dt>今日进度</dt><dd>${number(header.todaySuccessful)} / ${number(header.dailyTarget)}</dd></div></dl></section>`; }

function renderProgressTracks(progress = {}) {
  if (!progress?.visible) return "";
  const order = ["scan", "jd", "analysis", "communication"];
  const tracks = order.map((name) => renderTrack(name, progress.tracks?.[name] || {})).join("");
  const jobs = (progress.analysisJobs || []).map((job) => `<article class="workflow-task-row" data-analysis-task-id="${number(job.taskId)}"${job.status === "running" ? ' aria-current="step"' : ""}><span class="workflow-task-position">#${number(job.position)}</span><span class="workflow-task-name"><strong>${escapeHtml(job.title)}</strong><small>${escapeHtml(job.company)}</small></span><span class="workflow-task-status" data-analysis-task-status>${escapeHtml(job.statusLabel)}</span></article>`).join("");
  return `<section class="workflow-result-list" aria-labelledby="workflow-tracks-title"><div class="workflow-tracks"><div class="workflow-tracks-heading"><div><h2 id="workflow-tracks-title">本轮逐项进度</h2><p aria-live="polite" data-current-activity>${escapeHtml(progress.currentActivityLabel || "")}</p></div></div>${tracks}${jobs ? `<section class="workflow-task-list" aria-labelledby="workflow-task-list-title"><h3 id="workflow-task-list-title">逐岗位分析</h3>${jobs}</section>` : ""}</div></section>`;
}

function renderTrack(name, track = {}) {
  const id = `workflow-track-${name}`;
  const value = track.indeterminate ? "" : ` value="${number(track.value)}"`;
  return `<section class="workflow-track" data-progress-track="${escapeAttr(name)}" aria-labelledby="${id}-label"><div class="workflow-track-head"><h3 id="${id}-label">${escapeHtml(track.label || "")}</h3><strong data-track-fraction="${escapeAttr(name)}">${escapeHtml(track.fraction || "0 / 0")}</strong></div><progress data-track-meter="${escapeAttr(name)}" aria-describedby="${id}-description" max="${Math.max(1, number(track.max))}"${value}></progress><p id="${id}-description">${escapeHtml(track.description || "")}</p></section>`;
}

function renderScope(scope = {}) {
  if (!scope.visible) return "";
  const cities = scope.cities?.length ? `<li>城市：${escapeHtml(scope.cities.join("、"))}</li>` : "";
  const range = scope.scopeKey ? `范围：${escapeHtml(scope.scopeKey)} · ` : "";
  const planHash = scope.planHash ? ` · 方案指纹：${escapeHtml(scope.planHash)}` : "";
  return `<section class="workflow-scope" data-workflow-diagnostics><h2>采集与筛选明细</h2><strong>${escapeHtml(scope.mode || "采集模式")} · 筛选来源：${escapeHtml(scope.sourceLabel || "已冻结条件")}</strong><ul>${cities}${(scope.filters || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>未额外限制平台条件</li>"}</ul><p>${range}关键词来源：Search Plan #${escapeHtml(scope.sourcePlanId)}${planHash}</p><p>本轮实际关键词：${escapeHtml((scope.actualKeywords || []).join("、") || "无")}</p><p class="hint">方案候选词：${number(scope.candidateKeywordCount)} 个；本轮只展示已冻结执行的关键词。</p>${scope.unresolved?.length ? `<p class="workflow-alert">未解析平台筛选：${escapeHtml(scope.unresolved.join("、"))}；采集 URL 已保留这些条件，本地不会猜值。</p>` : ""}<p class="hint">方案后续修改不会影响本轮；恢复仍使用这里显示的冻结条件。</p></section>`;
}

function renderPrimaryCommand(phase = {}, controls = {}) {
  if (!controls.runningVisible && !controls.pauseRequestedVisible && !controls.pausedVisible && !controls.stopOnlyVisible) return "";
  const stop = controls.stopPreview || {};
  const access = stop.access || {};
  const identity = `<input type="hidden" name="workflowRunId" value="${escapeAttr(controls.runId)}">`;
  const pausedPrimary = controls.pausedVisible ? ' data-workflow-primary="true"' : "";
  const stopOnly = controls.stopOnlyVisible
    ? `<div class="workflow-control-group" data-control-group="stop-only"><button class="workflow-stop" type="button" data-workflow-control data-action="stop-preview">结束本轮…</button></div>`
    : "";
  return `<section class="workflow-command" aria-label="本轮操作"><div class="workflow-control-area"><div class="workflow-control-group" data-control-group="running"${controls.runningVisible ? "" : " hidden"}><form method="post" action="${escapeAttr(controls.endpoint)}" data-workflow-control-form>${identity}<input type="hidden" name="action" value="pause"><button class="secondary" data-workflow-control data-action="pause"${controls.canPause ? "" : " disabled"}>暂停本轮</button></form><button class="workflow-stop" type="button" data-workflow-control data-action="stop-preview"${controls.canStop ? "" : " disabled"}>结束本轮…</button></div><div class="workflow-control-group" data-control-group="pause-requested"${controls.pauseRequestedVisible ? "" : " hidden"}><strong>正在暂停</strong><span>系统会在当前安全步骤完成后停止；显示“本轮已暂停”后再修改 BOSS 搜索条件。</span><button class="workflow-stop" type="button" data-workflow-control data-action="stop-preview"${controls.canStop ? "" : " disabled"}>结束本轮…</button></div><div class="workflow-control-group" data-control-group="paused"${controls.pausedVisible ? "" : " hidden"}><form method="post" action="${escapeAttr(controls.endpoint)}" data-workflow-control-form>${identity}<input type="hidden" name="action" value="resume"><button${pausedPrimary} data-workflow-control data-action="resume"${controls.canResume ? "" : " disabled"}>继续本轮</button></form><button class="workflow-stop" type="button" data-workflow-control data-action="stop-preview"${controls.canStop ? "" : " disabled"}>结束本轮…</button><strong>本轮已暂停</strong><span data-pause-reason>${escapeHtml(controls.pauseReason)}</span><a class="button-link" href="/settings#model-profile-batch_screening">测试批量模型连接</a><a class="button-link" href="/settings#model-profile-batch_screening">调整批量模型</a></div>${stopOnly}<section class="workflow-stop-confirmation" data-stop-confirmation hidden><h3>确认结束本轮</h3><p>已采集 <span data-stop-collected>${number(stop.collected)}</span> · 已分析 <span data-stop-analyzed>${number(stop.analyzed)}</span> · 失败 <span data-stop-failed>${number(stop.failed)}</span> · 未完成 <span data-stop-unfinished>${number(stop.unfinished)}</span></p><p>网页预算：详情 ${number(access.details)} · 页面 ${number(access.pages)} · 滚动 ${number(access.scrolls)}</p><p><strong data-stop-slot>${stop.consumesRunSlot ? "会占用今天一轮" : "不会占用今天一轮"}</strong>。结束后不能继续，已保存结果会保留。</p><div class="workflow-control-group"><form method="post" action="${escapeAttr(controls.endpoint)}" data-workflow-control-form>${identity}<input type="hidden" name="action" value="stop"><input type="hidden" name="confirmStop" value="1"><button class="workflow-stop" data-workflow-control data-action="stop-confirm">确认结束本轮</button></form><button type="button" data-action="stop-cancel">取消</button></div></section></div></section>`;
}

function renderProgress(progress) {
  if (!progress?.visible) return "";
  const analysis = progress.analysis || {};
  const scan = progress.scanTargets || {};
  const details = progress.details || {};
  return `<section class="workflow-live" data-workflow-panel data-progress-revision="${number(progress.revision)}"><div class="workflow-live-head"><div><p class="workflow-stage" data-stage-label>第 ${number(progress.stageIndex)} 阶段 / 共 ${number(progress.stageCount)} 阶段</p><h2 data-stage-name>${escapeHtml(progress.stage)}</h2></div><p class="workflow-model">${escapeHtml(progress.modelLabel)}</p></div><div class="workflow-analysis-grid" aria-label="采集与分析数量">${stat("搜索目标", scan.total, "data-scan-target-total")}${stat("目标完成", scan.completed, "data-scan-target-completed")}${stat("目标待完成", scan.pending, "data-scan-target-pending")}${stat("已采集岗位", details.collected, "data-detail-collected")}${stat("已读详情", details.read, "data-detail-read")}${stat("待读详情", details.pending, "data-detail-pending")}${stat("待分析", analysis.remaining, "data-analysis-remaining")}${stat("本轮直接完成", analysis.directSucceeded, "data-analysis-direct-succeeded")}${stat("失败后已解决", analysis.resolvedAfterFailure, "data-analysis-resolved-after-failure")}${stat("当前未解决", analysis.unresolvedFailed, "data-analysis-unresolved-failed")}</div><div class="workflow-live-meta"><section class="workflow-live-card"><h3>超时保护</h3><p data-analysis-timeouts>当前恢复周期最终超时 ${number(analysis.circuitTimeoutJobs)} / ${number(analysis.timeoutPauseThreshold)} · 本轮累计超时 ${number(analysis.lifetimeTimeoutJobs)}</p><p data-eta>${escapeHtml(progress.etaLabel)}</p></section><section class="workflow-live-card"><h3>最近活动</h3><p data-recent-activity>${escapeHtml(progress.recentActivityLabel)}</p></section></div><span hidden data-analysis-total>${number(analysis.total)}</span><span hidden data-analysis-succeeded>${number(analysis.directSucceeded)}</span><span hidden data-analysis-failed>${number(analysis.historicalFailed)}</span><span hidden data-analysis-historical-failed>${number(analysis.historicalFailed)}</span><span hidden data-analysis-running>${number(analysis.running)}</span><span hidden data-analysis-retry-pending>${number(analysis.retryPending)}</span><span hidden data-analysis-detail-required>${number(analysis.detailRequired)}</span><p class="workflow-scan-wait" data-scan-wait${progress.scanWaitLabel ? "" : " hidden"}>${escapeHtml(progress.scanWaitLabel)}</p><p class="workflow-stale" data-workflow-stale hidden>任务可能失去活动，请先检查诊断信息，不要重复启动。</p></section>`;
}

function renderPhase(phase = {}) {
  if (phase.kind === "review") return renderReview(phase);
  if (phase.kind === "confirmed") return renderConfirmed(phase);
  if (phase.kind === "communicating") return renderCommunicating(phase);
  if (phase.kind === "completed") return `<section class="workflow-phase"><div class="workflow-done"><h2>本轮已完成</h2><p>本轮成功 ${number(phase.successfulCount)}，今日进度 ${number(phase.todaySuccessful)} / ${number(phase.dailyTarget)}。</p>${phase.shortfall ? `<p class="hint">${escapeHtml(phase.shortfall)}</p>` : ""}</div><div class="workflow-actions"><a class="button-link" data-workflow-primary="true" href="${escapeAttr(phase.planHref)}">返回今日任务</a><a class="button-link" href="${escapeAttr(phase.queueHref)}">查看岗位记录</a></div></section>`;
  if (phase.kind === "interrupted") {
    const issue = phase.error || {};
    const impact = phase.communicationHref ? communicationErrorLabel(phase.errorCode) : issue.impact;
    return `<section class="workflow-phase"><div class="workflow-actions">${phase.communicationHref ? `<a class="button-link" data-workflow-primary="true" href="${escapeAttr(phase.communicationHref)}">${escapeHtml(phase.communication?.detailsLabel || "检查沟通中断项")}</a>` : renderResume(phase.resume)}</div><div class="workflow-alert"><strong>${escapeHtml(issue.title || "本轮已中断")}</strong><p>${escapeHtml(impact || "当前进度已保留。")}</p><p>${escapeHtml(issue.nextAction || "返回本轮查看状态。")}</p></div><details class="workflow-error-technical"><summary>技术信息</summary><p>错误编号：${escapeHtml(phase.errorCode)}</p>${phase.errorMessage ? `<p>${escapeHtml(phase.errorMessage)}</p>` : ""}</details></section>`;
  }
  if (phase.kind === "active") return "";
  return `<section class="workflow-phase"><div class="workflow-alert"><strong>本轮状态已结束</strong><p>${escapeHtml(phase.errorCode)}</p></div><div class="workflow-actions"><a class="button-link" data-workflow-primary="true" href="${escapeAttr(phase.planHref)}">返回今日任务</a></div></section>`;
}

function renderReview(phase) {
  const review = phase.review || {};
  const rows = (review.rows || []).map((job) => `<label class="workflow-job"><input type="checkbox" name="jobIds" value="${escapeAttr(job.id)}"${job.defaultChecked ? " checked" : ""}><span class="workflow-job-main"><strong>${job.url ? `<a href="${escapeAttr(job.url)}" target="_blank" rel="noreferrer">${escapeHtml(job.title)}</a>` : escapeHtml(job.title)}</strong><span class="workflow-job-meta">${escapeHtml(job.company)} · ${escapeHtml(job.salary)} · ${escapeHtml(job.experience)} · ${escapeHtml(job.schedule)}</span><span class="workflow-job-evidence">${escapeHtml(job.evidence)}</span><span class="workflow-job-reason">${escapeHtml(job.reason)}</span>${job.hardBlockers?.length ? `<span class="workflow-job-reason">硬性限制：${escapeHtml(job.hardBlockers.join("；"))}</span>` : ""}</span><span class="workflow-tier">${escapeHtml(job.tier)}</span></label>`).join("") || "<p class=\"hint\">本轮没有满足有效期、详情和匹配证据要求的候选。</p>";
  const summary = `<p class="hint">本轮成功目标 ${number(phase.targetSuccessCount)}；主投和可投默认勾选 ${number(review.defaultCount)} 个，包含补位项。慎投仅展示，需人工决定是否勾选。</p>`;
  const runtimeBlock = review.runtimeBlock ? `<div class="workflow-alert">${escapeHtml(review.runtimeBlock.reasonCode)}${review.runtimeBlock.blockedUntil ? ` · ${escapeHtml(review.runtimeBlock.blockedUntil)}` : ""}</div>` : "";
  return `<section class="workflow-phase"><h2>确认本轮沟通清单</h2><form id="workflow-review-form" method="post" action="/api/communication-batch" data-review-limit="${number(review.quotaRemaining)}" data-review-blocked="${review.runtimeBlock ? "true" : "false"}"><input type="hidden" name="workflowRunId" value="${escapeAttr(phase.runId || "")}"><input type="hidden" name="planId" value="${escapeAttr(phase.planId || "")}"><input type="hidden" name="browserMode" value="${escapeAttr(review.browserMode)}"><div class="workflow-sticky"><span>已选 <output id="workflow-selected-count">${number(review.defaultCount)}</output> 个 · 今日剩余额度 ${number(review.quotaRemaining)}</span><button data-workflow-primary="true" id="workflow-confirm"${review.blocked ? " disabled" : ""}>确认清单</button></div>${summary}${runtimeBlock}<div class="workflow-list">${rows}</div></form></section>`;
}

function renderConfirmed(phase) { const communication = phase.communication || {}; return `<section class="workflow-phase"><h2>清单已确认</h2><p>已选择 ${number(communication.summary?.total)} 个岗位，本轮成功目标 ${number(phase.targetSuccessCount)}。</p>${communication.runtimeBlock ? `<div class="workflow-alert">${escapeHtml(communication.runtimeBlock)}</div>` : ""}<div class="workflow-actions">${communication.executionEnabled ? `<form method="post" action="/api/communication-control"><input type="hidden" name="batchId" value="${escapeAttr(communication.batchId)}"><button data-workflow-primary="true" name="action" value="${escapeAttr(communication.action)}">${escapeHtml(communication.actionLabel)}</button></form>` : ""}<a class="button-link"${communication.executionEnabled ? "" : ' data-workflow-primary="true"'} href="${escapeAttr(communication.detailsHref)}">${escapeHtml(communication.detailsLabel || "检查清单详情")}</a></div></section>`; }
function renderCommunicating(phase) { const communication = phase.communication || {}; const rows = Object.entries(communication.summary?.statusCounts || {}).map(([status, count]) => `<tr><th>${escapeHtml(communicationStatusLabel(status))}</th><td>${number(count)}</td></tr>`).join(""); return `<section class="workflow-phase"><h2>正在沟通</h2>${communication.runtimeBlock ? `<div class="workflow-alert">${escapeHtml(communication.runtimeBlock)}</div>` : ""}<table class="workflow-status-table"><tbody>${rows}</tbody></table><div class="workflow-actions"><a class="button-link" data-workflow-primary="true" href="${escapeAttr(communication.detailsHref)}">查看执行明细</a></div></section>`; }
function renderResume(resume) { if (!resume) return ""; const identity = `<input type="hidden" name="workflowRunId" value="${escapeAttr(resume.runId)}">`; if (resume.fixedAuthority) return `<form method="post" action="${escapeAttr(resume.endpoint)}">${identity}${resume.cdpPort ? `<input type="hidden" name="cdpPort" value="${number(resume.cdpPort)}">` : ""}<input type="hidden" name="browserMode" value="${escapeAttr(resume.browserMode)}"><span class="hint">${resume.browserMode === "portable" ? "创建本轮时固定的 BOSS 搜索页；浏览器：RoleFlow 专用 Edge（推荐）" : "创建本轮时固定的 BOSS 标签页；浏览器：使用当前 Edge（高级，需要浏览器连接组件）"}</span><button data-workflow-primary="true">继续本轮</button></form>`; return `<form method="post" action="${escapeAttr(resume.endpoint)}">${identity}<select name="browserMode"><option value="edge"${resume.browserMode === "edge" ? " selected" : ""}>使用当前 Edge（高级，需要浏览器连接组件）</option><option value="portable"${resume.browserMode === "portable" ? " selected" : ""}>RoleFlow 专用 Edge（推荐）</option></select><button data-workflow-primary="true">继续本轮</button></form>`; }
function stat(label, value, hook) { return `<div class="workflow-stat"><span>${escapeHtml(label)}</span><strong ${hook}>${number(value)}</strong></div>`; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

module.exports = { renderWorkflowPage };
