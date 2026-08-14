"use strict";

const { communicationAmbiguityState } = require("../../core/communication_ambiguity");
const { isBossJobUrl } = require("../../core/scoring");

const TERMINAL_BATCH_STATUSES = new Set(["completed", "stopped", "failed"]);
const VERIFIED_OUTCOMES = new Set(["succeeded", "already_communicated"]);

function buildCommunicationViewModel({
  scope = {}, current = null, history = [], directBatch = false,
  integrityIssue = "", discoveredWorkflowRuns = [], detailsByJobId = new Map()
} = {}) {
  const planId = number(scope.plan?.id);
  const profileId = number(scope.profile?.id || scope.plan?.profileId);
  const discoveredBatchIds = [...new Set((discoveredWorkflowRuns || [])
    .filter((run) => number(run.planId) === planId && (!profileId || !number(run.profileId) || number(run.profileId) === profileId))
    .map((run) => number(run.communicationBatchId))
    .filter(Boolean))];
  const page = { planId, profileId, planName: text(scope.plan?.name), planHref: planId ? `/plan?planId=${encodeURIComponent(planId)}` : "/plan", currentPath: planId ? `/communication?planId=${encodeURIComponent(planId)}` : "/communication" };
  if (integrityIssue) return blockedView({ page, integrityIssue, discoveredBatchIds });
  if (!current) return emptyView({ page, discoveredBatchIds });

  const batch = current.batch || {};
  const summary = current.summary || {};
  const ambiguity = communicationAmbiguityState(summary, current.items);
  const items = (Array.isArray(current.items) ? current.items : [])
    .map((item) => itemView(item, detailsByJobId))
    .sort((left, right) => Number(right.status === "ambiguous") - Number(left.status === "ambiguous") || left.position - right.position || left.id - right.id);
  const state = ambiguity.blocked ? "needs_resolution" : stateFor(batch, summary);
  const action = batch.status === "confirmed" ? "start" : ["paused", "interrupted"].includes(batch.status) ? "resume" : "";
  const pendingAcceptance = text(current.calibration?.acceptance) === "e2e_pending";
  const singleItem = pendingAcceptance ? items.find((item) => item.status === "pending") || null : null;
  const controlAction = pendingAcceptance && action ? `${action}_one` : action;
  const executionEnabled = Boolean(current.calibration?.executionEnabled) && !current.runtimeBlock && !ambiguity.blocked;
  const executionControlVisible = state === "pending_review"
    && Boolean(controlAction)
    && executionEnabled
    && (!pendingAcceptance || Boolean(singleItem));
  const controls = {
    visible: executionControlVisible,
    action: controlAction,
    label: pendingAcceptance ? "验收这个岗位并自动暂停" : action === "start" ? "确认后串行执行" : "继续串行执行",
    singleItemId: pendingAcceptance ? number(singleItem?.id) : 0,
    singleItemTitle: pendingAcceptance ? text(singleItem?.title) : "",
    singleItemCompany: pendingAcceptance ? text(singleItem?.company) : "",
    rebindVisible: state === "pending_review"
      && ["paused", "interrupted"].includes(text(batch.status))
      && text(batch.browserMode) === "edge"
      && Boolean(batch.runtime?.browser)
      && !executionControlVisible,
    recoveryHref: `/communication?batchId=${encodeURIComponent(number(batch.id))}#communication-recovery`
  };
  return {
    page,
    source: directBatch ? "direct_orphan" : "workflow_history",
    state,
    batch: batchView(batch, summary),
    items,
    quota: quotaView(current.quota),
    outcomes: outcomeView(summary),
    calibration: calibrationView(current.calibration),
    runtimeBlock: current.runtimeBlock ? { reasonCode: text(current.runtimeBlock.reasonCode), blockedUntil: text(current.runtimeBlock.blockedUntil) } : null,
    ambiguity: { blocked: ambiguity.blocked, countsMismatch: ambiguity.countsMismatch, firstItemId: number(ambiguity.firstItemId) || null },
    controls,
    history: directBatch ? [] : (history || []).map(historyView),
    discoveredBatchIds
  };
}

function blockedView({ page, integrityIssue, discoveredBatchIds }) {
  return { page, source: "integrity_blocked", state: "integrity_blocked", integrityIssue: text(integrityIssue), batch: null, items: [], quota: quotaView(), outcomes: outcomeView(), calibration: calibrationView(), runtimeBlock: null, ambiguity: { blocked: true, countsMismatch: true, firstItemId: null }, controls: emptyControls("/diagnostics"), history: [], discoveredBatchIds };
}

function emptyView({ page, discoveredBatchIds }) {
  return { page, source: "workflow_history", state: "no_batch", batch: null, items: [], quota: quotaView(), outcomes: outcomeView(), calibration: calibrationView(), runtimeBlock: null, ambiguity: { blocked: false, countsMismatch: false, firstItemId: null }, controls: emptyControls("/diagnostics"), history: [], discoveredBatchIds };
}

function emptyControls(recoveryHref) {
  return { visible: false, action: "", label: "", singleItemId: 0, singleItemTitle: "", singleItemCompany: "", rebindVisible: false, recoveryHref };
}

function stateFor(batch, summary) {
  if (TERMINAL_BATCH_STATUSES.has(text(batch.status)) || number(summary.remaining) === 0 && number(summary.total) > 0) return "completed";
  if (batch.status === "running" || batch.status === "stopping") return "running";
  return "pending_review";
}

function batchView(batch, summary) {
  return { id: number(batch.id), browserMode: text(batch.browserMode), status: text(batch.status), total: number(summary.total), terminal: number(summary.terminal), remaining: number(summary.remaining), statusCounts: countMap(summary.statusCounts), confirmedAt: text(batch.confirmedAt) };
}

function itemView(item = {}, detailsByJobId) {
  const detail = detailsByJobId instanceof Map ? detailsByJobId.get(number(item.jobId)) || {} : {};
  const analysis = detail.analysis || {};
  return {
    id: number(item.id), batchId: number(item.batchId), jobId: number(item.jobId), position: number(item.position), status: text(item.status), clickCount: number(item.clickCount),
    title: text(item.titleSnapshot || detail.title), company: text(item.companySnapshot || detail.company), jobUrl: safeBossJobUrl(item.jobUrl || detail.url),
    salary: text(detail.salary || item.salarySnapshot || "未保存"), location: text(detail.location || item.locationSnapshot || "未保存"),
    tier: text(detail.decisionBucket || item.tierSnapshot || "未保存"), evidence: stringList(analysis.fitReasons || detail.matches || item.evidenceSnapshot || item.evidence?.resume || []),
    risks: stringList(analysis.riskQuestions || detail.risks || item.riskSnapshot || []), proposalReason: text((analysis.fitReasons || [])[0] || item.proposalReasonSnapshot || "依据已确认的岗位清单"),
    resolution: item.status === "ambiguous" ? { evidenceRequired: true } : null,
    errorCode: text(item.errorCode), errorMessage: text(item.errorMessage)
  };
}

function historyView(status = {}) {
  const batch = status.batch || {};
  const summary = status.summary || {};
  return { batchId: number(batch.id || summary.batchId), status: text(batch.status || summary.batchStatus), total: number(summary.total), succeeded: number(summary.statusCounts?.succeeded) + number(summary.statusCounts?.already_communicated), href: `/communication?batchId=${encodeURIComponent(number(batch.id || summary.batchId))}` };
}

function quotaView(quota = {}) { return { limit: number(quota.limit), used: number(quota.used), reserved: number(quota.reserved), remaining: number(quota.remaining) }; }
function outcomeView(summary = {}) { const counts = countMap(summary.statusCounts); return { succeeded: number(counts.succeeded) + number(counts.already_communicated), alreadyCommunicated: number(counts.already_communicated), stopped: number(counts.stopped), failed: number(counts.platform_rejected) + number(counts.transport_failed) + number(counts.job_unavailable) + number(counts.target_mismatch) + number(counts.action_unavailable) }; }
function calibrationView(calibration = {}) { return { status: text(calibration.status), implementation: text(calibration.implementation), calibration: text(calibration.calibration), acceptance: text(calibration.acceptance), executionEnabled: Boolean(calibration.executionEnabled) }; }
function countMap(value) { return Object.fromEntries(Object.entries(value || {}).filter(([key, count]) => /^[a-z_]+$/.test(key) && Number.isFinite(Number(count))).map(([key, count]) => [key, number(count)])); }
function stringList(value) { return (Array.isArray(value) ? value : []).map(text).filter(Boolean); }
function safeBossJobUrl(value) { const url = text(value); return isBossJobUrl(url) ? url : ""; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0; }
function text(value) { return String(value || "").trim(); }

module.exports = { buildCommunicationViewModel };
