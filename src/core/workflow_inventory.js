const {
  decisionBucket,
  getWorkflowRun,
  getSearchPlan,
  listDecisionPool,
  listWorkflowRuns,
  transitionWorkflowRun,
  markCandidateJob
} = require("./storage");
const { PRODUCT_POLICY } = require("./product_policy");
const { isBossJobUrl } = require("./scoring");
const { defaultSelectedForBatch } = require("./decision_policy");
const { hasCompleteJobDescription } = require("./job_description_readiness");
const { TERMINAL_PROGRESS_STAGES, listProgressCards } = require("./candidate_progress");

const MAX_ACTIVE_DAYS = 3;
const BLOCKING_COMMUNICATION_STATUSES = new Set([
  "opening",
  "verified",
  "click_dispatched",
  "job_unavailable",
  "target_mismatch",
  "ambiguous"
]);
const VERIFIED_COMMUNICATION_STATUSES = new Set(["succeeded", "already_communicated"]);
function workflowEligibility(job = {}, context = {}) {
  const now = normalizedNow(context.now);
  const status = String(job.applicationStatus || "").trim();
  if (status && !(status === "later" && retryDue(job.reviewAt, now))) {
    return ineligible("WORKFLOW_CANDIDATE_STATE_EXISTS");
  }
  const progressStage = String(context.progressStage || "").trim();
  if (progressStage && !TERMINAL_PROGRESS_STAGES.has(progressStage)) {
    return ineligible("WORKFLOW_PROGRESS_ACTIVE");
  }
  const communicationStatus = String(context.communicationStatus || "").trim();
  if (VERIFIED_COMMUNICATION_STATUSES.has(communicationStatus)) {
    return ineligible("WORKFLOW_COMMUNICATION_VERIFIED");
  }
  if (BLOCKING_COMMUNICATION_STATUSES.has(communicationStatus)) {
    return ineligible("WORKFLOW_COMMUNICATION_STATE_BLOCKED");
  }
  if (String(job.source || "").toLowerCase() !== "boss" || !isBossJobUrl(job.url)) {
    return ineligible("WORKFLOW_JOB_URL_INVALID");
  }

  const tags = new Set(job.qualityTags || []);
  const activeDays = Number(job.effectiveBossActiveDays ?? job.bossActiveDays);
  if (!Number.isFinite(activeDays) || activeDays > MAX_ACTIVE_DAYS
    || tags.has("inactive_boss") || tags.has("stale_or_unknown_active")) {
    return ineligible("WORKFLOW_ACTIVITY_STALE");
  }
  if (!hasCompleteJobDescription(job)) {
    return ineligible("WORKFLOW_DETAIL_REQUIRED");
  }

  const semanticStatus = String(job.analysis?.semanticStatus || "").trim();
  if (semanticStatus !== "complete") {
    return ineligible("WORKFLOW_ANALYSIS_INCOMPLETE");
  }
  const bucket = job.decisionBucket || decisionBucket(job);
  if (bucket === "primary" || bucket === "apply") {
    return { eligible: true, tier: bucket, reasonCode: "" };
  }
  if (bucket === "caution") return ineligible("WORKFLOW_DECISION_CAUTION");
  return ineligible("WORKFLOW_DECISION_INELIGIBLE");
}

function listWorkflowInventory(db, { planId, now = new Date().toISOString() } = {}) {
  const communicationStates = latestCommunicationStates(db, getSearchPlan(db, planId)?.profileId);
  const progressCards = progressCardsByJob(db, planId);
  return listDecisionPool(db, { planId })
    .map((job) => {
      const result = workflowEligibility(job, {
        now,
        communicationStatus: communicationStates.get(Number(job.id)) || "",
        progressStage: progressCards.get(Number(job.id))?.stage || ""
      });
      return {
        ...job,
        progressCard: progressCards.get(Number(job.id)) || null,
        workflowEligibility: result,
        workflowTier: result.tier || ""
      };
    })
    .filter((job) => job.workflowEligibility.eligible)
    .sort((a, b) => tierRank(a.workflowTier) - tierRank(b.workflowTier)
      || Number(b.score || 0) - Number(a.score || 0)
      || Number(b.id || 0) - Number(a.id || 0));
}

function listWorkflowReviewCandidates(db, workflowRunId, { now = new Date().toISOString() } = {}) {
  const workflow = getWorkflowRun(db, workflowRunId);
  if (!workflow) throw inventoryError("WORKFLOW_RUN_NOT_FOUND", "workflow run was not found");
  const communicationStates = latestCommunicationStates(db, workflow.profileId);
  const progressCards = progressCardsByJob(db, workflow.planId);
  const candidates = listDecisionPool(db, { planId: workflow.planId })
    .map((job) => {
      const communicationStatus = communicationStates.get(Number(job.id)) || "";
      if (VERIFIED_COMMUNICATION_STATUSES.has(communicationStatus)) return null;
      const result = workflowEligibility(job, {
        now,
        communicationStatus,
        progressStage: progressCards.get(Number(job.id))?.stage || ""
      });
      const caution = !result.eligible
        && result.reasonCode === "WORKFLOW_DECISION_CAUTION";
      if (!result.eligible && !caution) return null;
      return {
        ...job,
        progressCard: progressCards.get(Number(job.id)) || null,
        workflowRunId: workflow.id,
        workflowEligibility: result,
        workflowTier: caution ? "caution" : result.tier,
        fromCurrentScan: Boolean(workflow.scanBatchId && Number(job.batchId) === workflow.scanBatchId),
        defaultChecked: false,
        selectable: true
      };
    })
    .filter(Boolean)
    .sort((a, b) => reviewTierRank(a.workflowTier) - reviewTierRank(b.workflowTier)
      || Number(b.fromCurrentScan) - Number(a.fromCurrentScan)
      || Number(b.score || 0) - Number(a.score || 0)
      || Number(b.id || 0) - Number(a.id || 0));

  const replacementBuffer = nonNegativeInteger(
    workflow.planner?.replacementBuffer ?? PRODUCT_POLICY.operations.workflow.replacementBuffer
  );
  let remainingDefaults = workflow.targetSuccessCount + replacementBuffer;
  return candidates.map((candidate) => {
    const defaultChecked = defaultSelectedForBatch(candidate.decisionBucket) && remainingDefaults > 0;
    if (defaultChecked) remainingDefaults -= 1;
    return { ...candidate, defaultChecked };
  });
}

function reconcilePlanWorkflowInventory(db, planId) {
  const inventoryCount = listWorkflowInventory(db, { planId }).length;
  for (const workflow of listWorkflowRuns(db, {
    planId,
    localDay: shanghaiLocalDay(),
    statuses: ["review_required", "interrupted"],
    limit: 500
  })) {
    if (workflow.inventoryCount === inventoryCount) continue;
    transitionWorkflowRun(db, { id: workflow.id, status: workflow.status, inventoryCount });
  }
  return inventoryCount;
}

function reconcileCommunicationOutcome(db, {
  batch,
  item,
  status,
  now = new Date().toISOString(),
  note = ""
} = {}) {
  const outcome = String(status || "").trim();
  const mapping = {
    job_unavailable: { candidateStatus: "invalid", reasonCode: "job_unavailable" },
    target_mismatch: { candidateStatus: "review", reasonCode: "target_mismatch" },
    action_unavailable: { candidateStatus: "later", reasonCode: "action_unavailable", retryHours: 24 }
  }[outcome];
  if (!mapping) return { reconciled: false, status: outcome };
  if (!batch?.profileId || !batch?.planId || !item?.jobId) {
    throw inventoryError("WORKFLOW_OUTCOME_CONTEXT_INVALID", "communication outcome requires batch and job identity");
  }
  const at = normalizedNow(now);
  const reviewAt = mapping.retryHours
    ? new Date(Date.parse(at) + mapping.retryHours * 60 * 60_000).toISOString()
    : "";
  markCandidateJob(db, {
    profileId: batch.profileId,
    planId: batch.planId,
    jobId: item.jobId,
    status: mapping.candidateStatus,
    reasonCode: mapping.reasonCode,
    reviewAt,
    note: String(note || `RoleFlow communication batch #${batch.id}: ${outcome}`)
  });
  return { reconciled: true, status: mapping.candidateStatus, reviewAt };
}

function progressCardsByJob(db, planId) {
  const profileId = getSearchPlan(db, planId)?.profileId;
  if (!profileId) return new Map();
  return new Map(listProgressCards(db, { profileId })
    .map((card) => [Number(card.jobId), card]));
}

function latestCommunicationStates(db, profileId) {
  const rows = db.prepare(`WITH ranked AS (
      SELECT items.job_id, items.status,
        ROW_NUMBER() OVER (PARTITION BY items.job_id ORDER BY items.updated_at DESC, items.id DESC) AS rank
      FROM communication_batch_items items
      JOIN communication_batches batches ON batches.id = items.batch_id
      WHERE batches.profile_id = ?
    )
    SELECT job_id, status FROM ranked WHERE rank = 1`).all(Number(profileId || 0));
  return new Map(rows.map((row) => [Number(row.job_id), row.status]));
}

function retryDue(reviewAt, now) {
  const due = Date.parse(reviewAt || "");
  return Number.isFinite(due) && due <= Date.parse(now);
}

function normalizedNow(value) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) throw inventoryError("WORKFLOW_TIME_INVALID", "workflow inventory time is invalid");
  return new Date(parsed).toISOString();
}

function shanghaiLocalDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw inventoryError("WORKFLOW_TIME_INVALID", "workflow inventory time is invalid");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function tierRank(tier) {
  return { primary: 0, apply: 1 }[tier] ?? 9;
}

function reviewTierRank(tier) {
  return { primary: 0, apply: 1, caution: 2 }[tier] ?? 9;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function ineligible(reasonCode) {
  return { eligible: false, tier: "", reasonCode };
}

function inventoryError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  workflowEligibility,
  listWorkflowInventory,
  listWorkflowReviewCandidates,
  reconcilePlanWorkflowInventory,
  reconcileCommunicationOutcome
};
