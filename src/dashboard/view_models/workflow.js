"use strict";

const { scopeShortId } = require("../../core/inherited_search_scope");
const { communicationAmbiguityState } = require("../../core/communication_ambiguity");

const ANALYSIS_STATUS_LABELS = Object.freeze({
  pending: "等待分析",
  running: "分析中",
  retry_pending: "等待重试",
  succeeded: "已完成",
  skipped: "已按本地规则处理",
  failed: "分析失败",
  stopped: "已停止"
});

function buildWorkflowViewModel({
  workflow = {}, plan = {}, daily = {}, communication = null, runtimeBlock = null,
  progressSnapshot = null, progressJobs = [], stopPreview = {}, healthReport = {}, reviewCandidates = [], quota = { remaining: 0 }
} = {}) {
  const status = String(workflow.status || "");
  const planner = workflow.planner || {};
  const progress = progressSnapshot ? progressView(progressSnapshot, progressJobs) : null;
  const phase = phaseView({ workflow, plan, daily, communication, runtimeBlock, reviewCandidates, quota });
  const controls = controlView(progressSnapshot, workflow, stopPreview);
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
    scope: scopeView(planner, workflow),
    health: { report: JSON.parse(JSON.stringify(healthReport || {})) },
    progress,
    controls,
    phase,
    overview: overviewView({ workflow, progress, phase, controls, runtimeBlock }),
    polling: pollingView(status, workflow, communication, progressSnapshot)
  };
}

function scopeView(planner, workflow) {
  const source = planner.keywordSource || {};
  const planHash = String(planner.planHash || "").slice(0, 10);
  if (planner?.acquisitionMode === "generated") {
    const labels = planner.nativeFilters?.labels || {};
    return {
      visible: true,
      mode: "通用模式",
      sourceLabel: "已保存的平台条件",
      planHash,
      cities: (planner.cityScopes || []).map((item) => String(item?.city || item?.cityCode || "")).filter(Boolean),
      filters: Object.entries(labels).flatMap(([name, values]) =>
        (values || []).map((value) => `${filterName(name)}：${value}`)
      ),
      actualKeywords: (workflow?.keywords || []).map((item) => String(item?.word || item || "")).filter(Boolean),
      candidateKeywordCount: (source.keywords || []).length,
      sourcePlanId: String(source.searchPlanId || ""),
      unresolved: []
    };
  }
  if (planner?.acquisitionMode !== "inherited") return { visible: false, filters: [], actualKeywords: [], candidateKeywordCount: 0, unresolved: [] };
  const policy = planner.platformPolicy || {};
  const region = workRegionLabel(policy);
  return {
    visible: true, mode: "继承模式", sourceLabel: "BOSS 当前页面", planHash,
    scopeKey: scopeShortId(planner.searchScope?.key) || "未记录", sourcePlanId: String(source.searchPlanId || ""),
    filters: [region, ...(policy.filterSummary || []).map(String).filter((item) => !String(item).includes("未解析参数"))].filter(Boolean).filter((item, index, values) => values.indexOf(item) === index),
    actualKeywords: (workflow?.keywords || []).map((item) => String(item?.word || item || "")).filter(Boolean),
    candidateKeywordCount: (source.keywords || []).length,
    unresolved: (policy.unresolvedParams || []).map((item) => String(item?.param || "")).filter(Boolean)
  };
}

function progressView(snapshot, progressJobs = []) {
  const source = snapshot?.progress || {};
  const analysis = source.analysis || {};
  const scanTargets = source.scanTargets || {};
  const details = source.details || {
    collected: source.collected,
    read: source.detailsRead,
    pending: source.detailsPending
  };
  const communication = source.communication || {};
  const tracks = source.tracks || {};
  const skipped = number(analysis.skipped);
  const detailRequired = number(analysis.detailRequired);
  const directSucceeded = number(analysis.succeeded);
  const historicalFailed = number(analysis.historicalFailed ?? analysis.failed);
  const resolvedAfterFailure = number(analysis.resolvedAfterFailure);
  const unresolvedFailed = Object.hasOwn(analysis, "unresolvedFailed")
    ? number(analysis.unresolvedFailed)
    : Math.max(0, historicalFailed - resolvedAfterFailure);
  const analyzed = directSucceeded + resolvedAfterFailure + Math.max(0, skipped - detailRequired);
  return {
    visible: true, revision: number(snapshot?.workflow?.progressRevision), status: String(snapshot?.workflow?.status || ""),
    controlState: String(snapshot?.workflow?.controlState || ""), stage: String(source.stage || ""),
    stageIndex: number(source.stageIndex), stageCount: number(source.stageCount), phaseKey: String(source.phaseKey || ""),
    remainingWorkLabel: String(source.remainingWorkLabel || "本轮状态正在更新"),
    modelLabel: [snapshot?.model?.provider, snapshot?.model?.model].filter(Boolean).join(" · ") || "批量模型待记录",
    meter: { max: Math.max(1, number(analysis.total)), value: analyzed + detailRequired + number(analysis.failed) + number(analysis.stopped) },
    scanTargets: {
      total: number(scanTargets.total), processed: number(scanTargets.processed), completed: number(scanTargets.completed), pending: number(scanTargets.pending),
      partial: number(scanTargets.partial), failed: number(scanTargets.failed)
    },
    details: {
      collected: number(details.collected), required: number(details.required), read: number(details.read), pending: number(details.pending),
      notRequired: number(details.notRequired), growing: Boolean(details.growing)
    },
    analysis: {
      total: number(analysis.total), succeeded: directSucceeded, directSucceeded, running: number(analysis.running), retryPending: number(analysis.retryPending),
      detailRequired, failed: historicalFailed, historicalFailed, resolvedAfterFailure, unresolvedFailed,
      remaining: number(analysis.pending) + number(analysis.running) + number(analysis.retryPending),
      stopped: number(analysis.stopped), collected: number(details.collected), detailsRead: number(details.read), detailsPending: number(details.pending),
      terminal: number(analysis.terminal),
      circuitTimeoutJobs: number(analysis.circuitTimeoutJobs), timeoutPauseThreshold: number(analysis.timeoutPauseThreshold || 10), lifetimeTimeoutJobs: number(analysis.lifetimeTimeoutJobs)
    },
    communication: {
      total: number(communication.total), pending: number(communication.pending), ambiguous: number(communication.ambiguous),
      succeeded: number(communication.succeeded), stopped: number(communication.stopped)
    },
    tracks: {
      scan: progressTrack(tracks.scan, "扫描岗位", `已处理 ${number(scanTargets.processed)} 个目标；成功 ${number(scanTargets.completed)}、部分 ${number(scanTargets.partial)}、失败 ${number(scanTargets.failed)}`),
      jd: progressTrack(tracks.jd, "完整 JD", `已读取 ${number(details.read)} 个需要完整 JD 的岗位；待补 ${number(details.pending)}；无需详情 ${number(details.notRequired)}${details.growing ? "；数量仍随扫描增长" : ""}`),
      analysis: progressTrack(tracks.analysis, "分析岗位", `已完成 ${number(analysis.terminal)} 个；本轮直接完成 ${directSucceeded}、失败后已解决 ${resolvedAfterFailure}、当前未解决 ${unresolvedFailed}、本地规则处理 ${Math.max(0, skipped - detailRequired)}、停止 ${number(analysis.stopped)}；历史失败 ${historicalFailed}`),
      communication: progressTrack(tracks.communication, "沟通岗位", `已到达终态 ${number(communication.terminal)} 个；成功 ${number(communication.succeeded)}、待人工确认 ${number(communication.ambiguous)}、停止 ${number(communication.stopped)}`)
    },
    currentActivityLabel: scanActivityLabel(source.scan, source.phaseKey),
    analysisJobs: (progressJobs || []).map((job) => ({
      taskId: number(job.taskId),
      position: number(job.position),
      status: String(job.status || ""),
      statusLabel: job.lastErrorCode === "DETAIL_REQUIRED"
        ? "详情待补"
        : job.status === "failed" && job.resolvedAfterFailure
          ? "首次失败，后续已解决"
        : ANALYSIS_STATUS_LABELS[String(job.status || "")] || "状态待确认",
      title: String(job.title || ""),
      company: String(job.company || "")
    })),
    cooldown: cooldownView(source.scanWait), scanWaitLabel: scanWaitLabel(source.scanWait), etaLabel: etaLabel(source.eta),
    recentActivityLabel: (snapshot?.recentActivity || []).length ? snapshot.recentActivity.map(activityLabel).join("；") : "还没有新的分析活动。",
    staleEligible: ["created", "scanning", "analyzing"].includes(snapshot?.workflow?.status)
  };
}

function progressTrack(track = {}, label, description) {
  const value = number(track.value);
  const max = number(track.max);
  return {
    value,
    max,
    indeterminate: Boolean(track.indeterminate),
    growing: Boolean(track.growing),
    fraction: `${value} / ${max}`,
    label,
    description
  };
}

function filterName(name) {
  return { salary: "薪资", experience: "经验", jobType: "职位类型", degree: "学历" }[name] || String(name);
}

function scanActivityLabel(scan = null, phaseKey = "") {
  if (!scan) {
    return phaseKey === "acquisition" ? "正在准备下一个扫描动作" : "当前阶段进度已保存";
  }
  const target = `${String(scan.targetLabel || "当前目标")}（目标 ${number(scan.targetPosition)} / ${number(scan.targetTotal)}）`;
  if (scan.activity === "reading_detail") {
    return `正在读取 ${target} 的岗位详情 ${number(scan.detailPosition)} / ${number(scan.detailTotal)}`;
  }
  if (scan.activity === "target_complete") return `${target} 已处理完成`;
  return `正在扫描 ${target}，已发现 ${number(scan.targetDiscovered)} 个岗位`;
}

function overviewView({ workflow, progress, phase, controls, runtimeBlock }) {
  const target = number(workflow.targetSuccessCount);
  const successful = number(workflow.successfulCount);
  const cooldown = progress?.cooldown || { active: false };
  const scan = progress?.scanTargets || {};
  const details = progress?.details || {};
  return {
    currentPhase: workflowStatusLabel(workflow.status),
    overallProgress: progress?.visible
      ? `第 ${number(progress.stageIndex)} / ${number(progress.stageCount)} 阶段`
      : target ? `${successful} / ${target}` : "等待状态更新",
    usableRecommendations: phase.kind === "review" ? number(phase.review.defaultCount) : number(workflow.inventoryCount),
    acquisitionProgress: `搜索目标 ${number(scan.processed)} / ${number(scan.total)} · 已获取 ${number(details.collected)} 个岗位`,
    jdProgress: `已读取 ${number(details.read)} / ${number(details.required)} · 待补 ${number(details.pending)}`,
    remainingWork: progress?.visible
      ? progress.remainingWorkLabel
      : phase.kind === "review"
        ? `已准备 ${phase.review.rows.length} 个候选岗位，等待你确认清单`
        : "本轮没有未完成工作",
    estimatedContinuation: cooldown.active ? `安全冷却至 ${cooldown.retryAtLabel}` : progress?.etaLabel || "当前阶段不估算剩余时间",
    blocker: blockerView({ workflow, cooldown, runtimeBlock }),
    nextAction: nextActionLabel(phase, controls),
    cooldown
  };
}

function blockerView({ workflow, cooldown, runtimeBlock }) {
  if (cooldown.active) return { label: "安全冷却中", detail: cooldown.reason, recovery: "到达重试时间后等待本地状态刷新" };
  if (runtimeBlock) return { label: "运行环境已阻塞", detail: runtimeBlockLabel(runtimeBlock.reasonCode), recovery: "检查运行环境后再查看本轮状态" };
  if (workflow.status === "paused") return { label: "本轮已暂停", detail: String(workflow.errorCode || "安全暂停"), recovery: "检查原因后继续本轮" };
  if (["interrupted", "failed", "stopped"].includes(workflow.status)) return { label: "本轮需要处理", detail: String(workflow.errorCode || workflow.shortfallCode || "状态已停止"), recovery: String(workflow.errorMessage || "检查技术明细后选择下一步") };
  return { label: "没有阻塞", detail: "本轮按当前安全规则进行", recovery: "等待下一次状态更新" };
}

function nextActionLabel(phase, controls) {
  if (phase.kind === "active") return controls.pausedVisible ? "检查暂停原因后继续本轮" : "系统正在继续处理，无需操作";
  return {
    review: "确认清单", confirmed: phase.communication?.actionLabel || phase.communication?.detailsLabel,
    communicating: "查看执行明细", completed: "返回今日任务", interrupted: phase.communicationHref ? phase.communication?.detailsLabel : "继续本轮",
    fallback: "返回今日任务"
  }[phase.kind] || "查看本轮状态";
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
  const fixedAuthority = inherited || workflow.planner?.planSnapshotVersion === 2;
  const browserMode = reviewBrowserMode(workflow);
  return { endpoint: "/api/workflow-run/resume", runId: String(workflow.id || ""), inherited, fixedAuthority, browserMode, cdpPort: inherited && browserMode === "portable" ? 9222 : null };
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
function workRegionLabel(policy = {}) { const location = policy.filters?.location || policy.filterSnapshot?.filters?.location || {}; if (location.mode === "nationwide") return "地点：全国"; const cities = (location.cities || []).map(localizedRegion).filter(Boolean); const districts = (location.districts || []).map(localizedRegion).filter(Boolean); if (!cities.length && !districts.length) return ""; return `地点：${[...cities, ...districts].join("、")}`; }
function localizedRegion(value) { const text = String(value || "").trim(); return { Guangzhou: "广州", Shenzhen: "深圳", Shanghai: "上海", Beijing: "北京", Hangzhou: "杭州", Chengdu: "成都", Tianhe: "天河", Panyu: "番禺", Nanshan: "南山", Pudong: "浦东" }[text] || (/^[\u3400-\u9fff·]+$/.test(text) ? text : ""); }
function cooldownView(scanWait = {}) { const retryAt = String(scanWait?.retryAt || ""); const retryMs = Date.parse(retryAt); if (!Number.isFinite(retryMs) || retryMs <= Date.now()) return { active: false }; return { active: true, reason: cooldownReason(scanWait.action), retryAt, retryAtLabel: new Date(retryMs).toLocaleString("zh-CN", { hour12: false }) }; }
function cooldownReason(action) { return { detail_open: "正在读取岗位详情", pane_detail_read: "正在读取岗位详情", job_detail_fetch: "正在读取岗位详情", list_navigation: "正在切换岗位列表" }[String(action || "")] || "平台访问正在安全冷却"; }
function runtimeBlockLabel(code) { return { BOSS_RISK_CONTROL: "平台风险控制仍在生效", BOSS_LOGIN_REQUIRED: "需要在浏览器中重新登录", BOSS_BROWSER_UNAVAILABLE: "浏览器连接不可用" }[String(code || "")] || "运行环境暂不可用"; }
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
