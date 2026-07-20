const {
  decisionBucket,
  listDecisionPool,
  markCandidateJob
} = require("./storage");
const { isBossJobUrl } = require("./scoring");

const MAX_ACTIVE_DAYS = 3;
const MIN_DETAIL_LENGTH = 80;
const BLOCKING_COMMUNICATION_STATUSES = new Set([
  "opening",
  "verified",
  "click_dispatched",
  "succeeded",
  "already_communicated",
  "job_unavailable",
  "target_mismatch",
  "ambiguous"
]);
const LOW_RISK_BACKUP_BLOCKERS = new Set([
  "salary_target_high",
  "senior_engineering_heavy",
  "core_stack_mismatch",
  "inactive_boss",
  "stale_or_unknown_active",
  "detail_unverified",
  "needs_recheck"
]);

function workflowEligibility(job = {}, context = {}) {
  const now = normalizedNow(context.now);
  const status = String(job.applicationStatus || "").trim();
  if (status && !(status === "later" && retryDue(job.reviewAt, now))) {
    return ineligible("WORKFLOW_CANDIDATE_STATE_EXISTS");
  }
  if (BLOCKING_COMMUNICATION_STATUSES.has(String(context.communicationStatus || "").trim())) {
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
  if (tags.has("detail_unverified") || String(job.description || "").trim().length < MIN_DETAIL_LENGTH) {
    return ineligible("WORKFLOW_DETAIL_REQUIRED");
  }

  const semanticStatus = String(job.analysis?.semanticStatus || "").trim();
  if (!["complete", "partial"].includes(semanticStatus)) {
    return ineligible("WORKFLOW_ANALYSIS_INCOMPLETE");
  }
  const bucket = job.decisionBucket || decisionBucket(job);
  if (bucket === "primary" || bucket === "talk") {
    return { eligible: true, tier: bucket, reasonCode: "" };
  }
  if (bucket !== "backup") return ineligible("WORKFLOW_DECISION_INELIGIBLE");
  if (!tags.has("salary_target_core") || !tags.has("experience_salary_overlap")
    || [...LOW_RISK_BACKUP_BLOCKERS].some((tag) => tags.has(tag))) {
    return ineligible("WORKFLOW_BACKUP_NOT_LOW_RISK");
  }
  return { eligible: true, tier: "low_risk_backup", reasonCode: "" };
}

function listWorkflowInventory(db, { planId, now = new Date().toISOString() } = {}) {
  const communicationStates = latestCommunicationStates(db);
  return listDecisionPool(db, { planId })
    .map((job) => {
      const result = workflowEligibility(job, {
        now,
        communicationStatus: communicationStates.get(Number(job.id)) || ""
      });
      return { ...job, workflowEligibility: result, workflowTier: result.tier || "" };
    })
    .filter((job) => job.workflowEligibility.eligible)
    .sort((a, b) => tierRank(a.workflowTier) - tierRank(b.workflowTier)
      || Number(b.score || 0) - Number(a.score || 0)
      || Number(b.id || 0) - Number(a.id || 0));
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
    succeeded: { candidateStatus: "applied", reasonCode: "communication_succeeded" },
    already_communicated: { candidateStatus: "applied", reasonCode: "already_communicated" },
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

function latestCommunicationStates(db) {
  const rows = db.prepare(`WITH ranked AS (
      SELECT job_id, status,
        ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY updated_at DESC, id DESC) AS rank
      FROM communication_batch_items
    )
    SELECT job_id, status FROM ranked WHERE rank = 1`).all();
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

function tierRank(tier) {
  return { primary: 0, talk: 1, low_risk_backup: 2 }[tier] ?? 9;
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
  reconcileCommunicationOutcome
};
