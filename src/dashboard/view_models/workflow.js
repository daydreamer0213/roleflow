"use strict";

const { scopeShortId } = require("../../core/inherited_search_scope");
const { communicationAmbiguityState } = require("../../core/communication_batches");

function buildWorkflowViewModel({
  workflow = {}, plan = {}, daily = {}, communication = null, runtimeBlock = null,
  progressSnapshot = null, stopPreview = {}, healthReport = {}, reviewCandidates = [], quota = { remaining: 0 }
} = {}) {
  const status = String(workflow.status || "");
  const planner = workflow.planner || {};
  const progress = progressSnapshot ? progressView(progressSnapshot) : null;
  const phase = phaseView({ workflow, plan, daily, communication, runtimeBlock, reviewCandidates, quota });
  return {
    page: {
      title: "执行一轮", runId: String(workflow.id || ""), planId: String(plan.id || workflow.planId || ""),
      planHref: `/plan?planId=${encodeURIComponent(plan.id || workflow.planId || "")}`,
      queueHref: `/queue?planId=${encodeURIComponent(plan.id || workflow.planId || "")}`,
      currentPath: `/workflow?runId=${encodeURIComponent(workflow.id || "")}`
    },
    header: {
      statusLabel: workflowStatusLabel(status), sequence: number(workflow.sequence), localDay: String(workflow.localDay || ""),
      targetSuccessCount: number(workflow.targetSuccessCount), successfulCount: number(workflow.successfulCount),
      todaySuccessful: number(daily.successfulToday), dailyTarget: number(daily.dailyTarget), inventoryCount: number(workflow.inventoryCount)
    },
    scope: scopeView(planner),
    health: { report: JSON.parse(JSON.stringify(healthReport || {})) },
    progress,
    controls: controlView(progressSnapshot, workflow, stopPreview),
    phase,
    polling: pollingView(status, workflow, communication, progressSnapshot)
  };
}

function scopeView(planner) {
  if (planner?.acquisitionMode !== "inherited") return { visible: false, filters: [], keywords: [], unresolved: [] };
  const policy = planner.platformPolicy || {};
  const source = planner.keywordSource || {};
  return {
    visible: true, scopeKey: scopeShortId(planner.searchScope?.key) || "未记录", sourcePlanId: String(source.searchPlanId || ""),
    filters: (policy.filterSummary || []).map(String), keywords: (source.keywords || []).map((item) => String(item?.word || item || "")).filter(Boolean),
    unresolved: (policy.unresolvedParams || []).map((item) => String(item?.param || "")).filter(Boolean)
  };
}

function progressView(snapshot) {
  const analysis = snapshot?.progress?.analysis || {};
  const skipped = number(analysis.skipped);
  const detailRequired = number(analysis.detailRequired);
  const analyzed = number(analysis.succeeded) + Math.max(0, skipped - detailRequired);
  return {
    visible: true, revision: number(snapshot?.workflow?.progressRevision), status: String(snapshot?.workflow?.status || ""),
    controlState: String(snapshot?.workflow?.controlState || ""), stage: String(snapshot?.progress?.stage || ""),
    stageIndex: number(snapshot?.progress?.stageIndex), stageCount: number(snapshot?.progress?.stageCount),
    modelLabel: [snapshot?.model?.provider, snapshot?.model?.model].filter(Boolean).join(" · ") || "批量模型待记录",
    meter: { max: Math.max(1, number(analysis.total)), value: analyzed + detailRequired + number(analysis.failed) + number(analysis.stopped) },
    analysis: {
      total: number(analysis.total), succeeded: number(analysis.succeeded), running: number(analysis.running), retryPending: number(analysis.retryPending),
      detailRequired, failed: number(analysis.failed), remaining: number(analysis.pending) + number(analysis.running) + number(analysis.retryPending),
      collected: number(analysis.total), detailsRead: number(snapshot?.progress?.detailsRead), detailsPending: number(snapshot?.progress?.detailsPending),
      circuitTimeoutJobs: number(analysis.circuitTimeoutJobs), timeoutPauseThreshold: number(analysis.timeoutPauseThreshold || 10), lifetimeTimeoutJobs: number(analysis.lifetimeTimeoutJobs)
    },
    scanWaitLabel: scanWaitLabel(snapshot?.progress?.scanWait), etaLabel: etaLabel(snapshot?.progress?.eta),
    recentActivityLabel: (snapshot?.recentActivity || []).length ? snapshot.recentActivity.map(activityLabel).join("；") : "还没有新的分析活动。",
    staleEligible: ["created", "scanning", "analyzing"].includes(snapshot?.workflow?.status)
  };
}

function controlView(snapshot, workflow, stopPreview) {
  const status = String(snapshot?.workflow?.status || workflow.status || "");
  const access = stopPreview.access || {};
  return {
    canPause: Boolean(snapshot?.controls?.canPause), canResume: Boolean(snapshot?.controls?.canResume), canStop: Boolean(snapshot?.controls?.canStop),
    runningVisible: ["created", "scanning", "analyzing"].includes(status), pausedVisible: status === "paused",
    pauseReason: String(workflow.errorCode || "本轮已安全暂停"), endpoint: "/api/workflow-control", runId: String(workflow.id || ""),
    stopPreview: { collected: number(stopPreview.collected), analyzed: number(stopPreview.analyzed), failed: number(stopPreview.failed), unfinished: number(stopPreview.unfinished), access: { details: number(access.details), pages: number(access.pages), scrolls: number(access.scrolls) }, consumesRunSlot: Boolean(stopPreview.consumesRunSlot) }
  };
}

function phaseView({ workflow, plan, daily, communication, runtimeBlock, reviewCandidates, quota }) {
  const status = String(workflow.status || "");
  const common = { status, runId: String(workflow.id || ""), planId: String(plan.id || workflow.planId || ""), planHref: `/plan?planId=${encodeURIComponent(plan.id || workflow.planId || "")}`, queueHref: `/queue?planId=${encodeURIComponent(plan.id || workflow.planId || "")}` };
  if (status === "review_required" && communication) return { ...common, kind: "confirmed", communication: communicationView(communication, runtimeBlock), targetSuccessCount: number(workflow.targetSuccessCount) };
  if (status === "review_required") {
    const rows = (reviewCandidates || []).map(reviewRow);
    const defaultCount = rows.filter((row) => row.defaultChecked).length;
    const remaining = number(quota?.remaining);
    return { ...common, kind: "review", targetSuccessCount: number(workflow.targetSuccessCount), review: { rows, defaultCount, quotaRemaining: remaining, runtimeBlock: runtimeBlock ? { reasonCode: String(runtimeBlock.reasonCode || ""), blockedUntil: String(runtimeBlock.blockedUntil || "") } : null, browserMode: reviewBrowserMode(workflow), blocked: Boolean(runtimeBlock) || defaultCount === 0 || defaultCount > remaining } };
  }
  if (status === "communicating") return { ...common, kind: "communicating", communication: communicationView(communication, runtimeBlock) };
  if (status === "completed") return { ...common, kind: "completed", successfulCount: number(workflow.successfulCount), todaySuccessful: number(daily.successfulToday), dailyTarget: number(daily.dailyTarget), shortfall: shortfallText(workflow.shortfallCode) };
  if (status === "interrupted") {
    const communicationDetails = communication ? communicationView(communication, runtimeBlock) : null;
    return { ...common, kind: "interrupted", errorCode: String(workflow.errorCode || "WORKFLOW_INTERRUPTED"), errorMessage: String(workflow.errorMessage || "请检查诊断后继续。"), communication: communicationDetails, communicationHref: communicationDetails?.detailsHref || (workflow.communicationBatchId ? `/communication?batchId=${encodeURIComponent(workflow.communicationBatchId)}` : ""), resume: workflow.communicationBatchId ? null : resumeView(workflow) };
  }
  return { ...common, kind: ["created", "scanning", "analyzing", "paused"].includes(status) ? "active" : "fallback", errorCode: String(workflow.errorCode || workflow.shortfallCode || "本轮已经结束。") };
}

function reviewRow(job = {}) {
  const analysis = job.analysis || {};
  return {
    id: String(job.id || ""), url: safeExternalUrl(job.url), title: String(job.title || ""), company: String(job.company || ""), salary: String(job.salary || "薪资待确认"), experience: String(job.experience || "经验待确认"),
    schedule: scheduleLabel(analysis), evidence: evidenceLabel(analysis), reason: (analysis.fitReasons || []).slice(0, 2).join("；") || (job.matches || []).slice(0, 3).join("、") || "匹配证据已保存",
    hardBlockers: (analysis.hardBlockers || []).map((item) => typeof item === "string" ? item : item?.requirement || item?.reason || "").filter(Boolean).map(String),
    tier: workflowTier(job.workflowTier), defaultChecked: Boolean(job.defaultChecked)
  };
}

function communicationView(communication, runtimeBlock) {
  const batch = communication?.batch || {};
  const status = String(batch.status || "");
  const summary = { total: number(communication?.summary?.total), terminal: number(communication?.summary?.terminal), statusCounts: Object.fromEntries(Object.entries(communication?.summary?.statusCounts || {}).map(([key, value]) => [String(key), number(value)])) };
  const ambiguity = communicationAmbiguityState(summary, communication?.items || []);
  const ambiguousItem = ambiguity.firstItemId == null ? null : (communication?.items || []).find((item) => item?.id === ambiguity.firstItemId);
  const action = ambiguity.blocked ? "" : status === "confirmed" ? "start" : ["paused", "interrupted"].includes(status) ? "resume" : "";
  const detailsHref = batch.id ? `/communication?batchId=${encodeURIComponent(batch.id)}${ambiguousItem ? `#communication-item-${encodeURIComponent(ambiguousItem.id)}` : ""}` : "";
  return { batchId: String(batch.id || ""), status, action, actionLabel: action === "resume" ? "继续沟通" : action === "start" ? "开始沟通" : "", executionEnabled: Boolean(action && communication?.calibration?.executionEnabled && !runtimeBlock), summary, runtimeBlock: runtimeBlock ? String(runtimeBlock.reasonCode || "") : "", detailsHref, detailsLabel: ambiguity.blocked ? (ambiguousItem ? "处理不明确结果" : "沟通记录不一致，请刷新") : "检查清单详情" };
}

function resumeView(workflow) {
  const inherited = workflow.planner?.acquisitionMode === "inherited";
  const browserMode = reviewBrowserMode(workflow);
  return { endpoint: "/api/workflow-run/resume", runId: String(workflow.id || ""), inherited, browserMode, cdpPort: inherited && browserMode === "portable" ? 9222 : null };
}

function pollingView(status, workflow, communication, snapshot) {
  if (["created", "scanning", "analyzing", "paused"].includes(status)) return { kind: "progress", runId: String(workflow.id || ""), intervalMs: 2500, initialKey: [number(snapshot?.workflow?.progressRevision), snapshot?.workflow?.status || status, snapshot?.workflow?.controlState || workflow.controlState || ""].join("|"), terminalStates: ["review_required", "interrupted", "completed", "failed", "stopped"] };
  if (["communicating"].includes(status) || ["running", "stopping"].includes(communication?.batch?.status)) return { kind: "communication", runId: String(workflow.id || ""), intervalMs: 2500, initialKey: communicationKey(workflow, communication), terminalStates: [] };
  return { kind: "none", runId: String(workflow.id || ""), intervalMs: 2500, initialKey: "", terminalStates: [] };
}

function communicationKey(workflow, communication) { const counts = communication?.summary?.statusCounts || {}; return [workflow.status, communication?.batch?.status || "", number(workflow.successfulCount), number(counts.succeeded), number(counts.already_communicated), number(communication?.summary?.terminal)].join("|"); }
function reviewBrowserMode(workflow) { const mode = String(workflow.planner?.browserMode || (workflow.planner?.acquisitionMode === "inherited" ? "edge" : "portable")).trim().toLowerCase(); return mode === "edge" ? "edge" : "portable"; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function safeExternalUrl(value) { try { const url = new URL(String(value || "")); return ["http:", "https:"].includes(url.protocol) ? url.toString() : ""; } catch { return ""; } }
function scanWaitLabel(scanWait, now = Date.now()) { const retryAt = Date.parse(scanWait?.retryAt || ""); if (!Number.isFinite(retryAt) || retryAt <= now) return ""; return `安全冷却中，预计 ${Math.max(1, Math.ceil((retryAt - now) / 60000))} 分钟后继续（${new Date(retryAt).toLocaleTimeString("zh-CN", { hour12: false })}）`; }
function duration(seconds) { const value = Math.max(0, Math.ceil(number(seconds))); if (value < 60) return `${value} 秒`; if (value < 3600) return `${Math.ceil(value / 60)} 分钟`; const hours = Math.floor(value / 3600); const minutes = Math.ceil((value % 3600) / 60); return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`; }
function etaLabel(eta = {}) { if (eta.status === "available") return `预计剩余 ${duration(eta.minSeconds)}～${duration(eta.maxSeconds)}（基于最近 ${number(eta.sampleSize)} 个完成岗位估算）`; if (eta.status === "paused") return eta.minSeconds == null || eta.maxSeconds == null ? "已暂停；样本不足，正在估算" : `已暂停；剩余区间冻结为 ${duration(eta.minSeconds)}～${duration(eta.maxSeconds)}（${number(eta.sampleSize)} 个样本）`; return eta.status === "estimating" ? "正在估算" : "当前阶段不估算剩余时间"; }
function activityLabel(activity = {}) { const action = { analysis_started: "开始分析", analysis_succeeded: "已成功保存", analysis_failed: "分析失败", analysis_skipped: "已按本地规则处理", waiting_lease_expiry: "正在等待安全收尾", control_requested: "正在执行控制请求" }[activity.type] || "状态已更新"; return `任务 #${number(activity.taskId)} ${action}${activity.attempt ? `，第 ${number(activity.attempt)} 次尝试` : ""}${activity.modelRole === "backup" ? "，备用模型" : ""}${activity.errorCode ? `，${String(activity.errorCode)}` : ""}`; }
function evidenceLabel(analysis = {}) { const foundation = (analysis.requirementMatches || []).filter((item) => item?.foundation); const covered = foundation.filter((item) => ["matched", "transferable"].includes(item.state)).map((item) => item.requirement).filter(Boolean).join("、") || "暂无"; const unresolved = foundation.filter((item) => !["matched", "transferable"].includes(item.state)).map((item) => item.requirement).filter(Boolean).join("、") || "暂无"; const track = analysis.selectedTrackLabel ? `匹配分支：${String(analysis.selectedTrackLabel)} · ` : ""; const alignment = { aligned: "一致", mostly_aligned: "基本一致", partially_aligned: "部分一致", misaligned: "不一致", insufficient_evidence: "证据不足，待确认" }[analysis.roleAlignment] || "历史分析，待重新计算"; return `${track}岗位主体：${String(analysis.roleSummary || "岗位主体待确认")} · 主体匹配：${alignment} · 主体依据：${Array.isArray(analysis.roleResumeEvidence) ? analysis.roleResumeEvidence.length : 0} 条 · 已覆盖根基：${covered} · 待确认根基：${unresolved}`; }
function scheduleLabel(analysis = {}) { return { double_weekend: "双休", alternating_weekend: "大小周/单双休", single_weekend: "单休", unknown: "未说明" }[analysis.workSchedule || "unknown"]; }
function workflowTier(tier) { return { primary: "主投", apply: "可投", caution: "慎投" }[tier] || "待分析"; }
function workflowStatusLabel(status) { return { created: "本轮已建立", scanning: "正在筛选岗位", analyzing: "正在分析岗位", paused: "本轮已暂停", review_required: "等待确认本轮清单", communicating: "正在沟通", interrupted: "本轮已中断，等待继续", completed: "本轮已完成", failed: "本轮未完成", stopped: "本轮已停止" }[status] || "本轮进行中"; }
function shortfallText(code) { return code ? (code === "WORKFLOW_SUPPLY_EXHAUSTED" ? "本轮可用候选已处理完，没有用弱岗位凑数。" : String(code)) : ""; }

module.exports = { buildWorkflowViewModel };
