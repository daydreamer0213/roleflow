"use strict";

const { projectFunnelEntry } = require("./funnel_maturity");

const ELIGIBLE_TIERS = new Set(["primary", "apply"]);
const INELIGIBLE_OUTCOMES = new Set([
  "review",
  "later",
  "skipped",
  "interview",
  "rejected",
  "invalid",
  "salary_mismatch"
]);
const OUTBOUND_EVENT_TYPES = new Set([
  "outbound_read_observed",
  "outbound_delivered_observed"
]);

function projectMessageFollowUpCandidate(input = {}) {
  const funnel = projectFunnelEntry(input.entry, input.events, { now: input.now });
  if (!ELIGIBLE_TIERS.has(String(input.job?.decisionBucket || ""))) {
    return rejected("tier_ineligible", funnel, input);
  }
  if (input.job?.archived === true) return rejected("archived", funnel, input);
  if (!String(input.card?.threadKey || "").trim()) {
    return rejected("conversation_unresolved", funnel, input);
  }
  if (String(input.card?.stage || "") !== "waiting_reply") {
    return rejected("stage_ineligible", funnel, input);
  }
  if (INELIGIBLE_OUTCOMES.has(String(input.job?.applicationStatus || ""))) {
    return rejected("outcome_ineligible", funnel, input);
  }
  if (input.hasSentFollowUp === true) {
    return rejected("already_followed_up", funnel, input);
  }
  if (input.hasActiveFollowUp === true) {
    return rejected("follow_up_active", funnel, input);
  }
  if (!funnel.mature || funnel.replyWindowWaiting) {
    return rejected("feedback_waiting", funnel, input);
  }
  if (funnel.replied.value !== false || funnel.terminalCurrent) {
    return rejected("not_unanswered", funnel, input);
  }
  return projected(true, "", funnel, input);
}

function rejected(reasonCode, funnel, input) {
  return projected(false, reasonCode, funnel, input);
}

function projected(eligible, reasonCode, funnel, input) {
  const waitingSince = latestOutboundAt(input.events, funnel.startedAt);
  const nowMs = Date.parse(input.now);
  const waitingMs = waitingSince ? Date.parse(waitingSince) : Number.NaN;
  return {
    eligible,
    reasonCode,
    matureAt: funnel.matureAt,
    waitingSince,
    waitedHours: Number.isFinite(nowMs) && Number.isFinite(waitingMs)
      ? Math.max(0, Math.floor((nowMs - waitingMs) / 3_600_000))
      : 0
  };
}

function latestOutboundAt(events, startedAt) {
  const startedMs = Date.parse(startedAt);
  let latest = "";
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const event of Array.isArray(events) ? events : []) {
    if (!OUTBOUND_EVENT_TYPES.has(String(event?.type || ""))) continue;
    const occurredMs = Date.parse(event?.occurredAt || "");
    if (!Number.isFinite(occurredMs) || occurredMs < startedMs || occurredMs < latestMs) continue;
    latest = new Date(occurredMs).toISOString();
    latestMs = occurredMs;
  }
  return latest || new Date(startedMs).toISOString();
}

module.exports = {
  projectMessageFollowUpCandidate
};
