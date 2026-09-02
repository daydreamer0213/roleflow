"use strict";

const assert = require("node:assert/strict");
const { projectMessageFollowUpCandidate } = require("../src/core/message_follow_up");

const ENTRY = {
  id: 7,
  startedAt: "2026-08-25T02:00:00.000Z",
  matureAt: "2026-08-27T02:00:00.000Z"
};
const CONVERSATION_KEY = `sha256:${"a".repeat(64)}`;
const BASE = {
  entry: ENTRY,
  events: [event("outbound_delivered_observed", "2026-08-25T03:00:00.000Z")],
  job: { decisionBucket: "primary", applicationStatus: "applied", archived: false },
  card: { stage: "waiting_reply", threadKey: CONVERSATION_KEY },
  hasSentFollowUp: false,
  hasActiveFollowUp: false,
  now: "2026-08-27T03:00:00.000Z"
};

const eligible = projectMessageFollowUpCandidate(BASE);
assert.equal(eligible.eligible, true);
assert.equal(eligible.reasonCode, "");
assert.equal(eligible.matureAt, ENTRY.matureAt);
assert.equal(eligible.waitingSince, "2026-08-25T03:00:00.000Z");
assert.equal(eligible.waitedHours, 48);

assert.equal(projectMessageFollowUpCandidate({
  ...BASE,
  now: "2026-08-27T01:59:59.000Z"
}).reasonCode, "feedback_waiting");

const weekend = projectMessageFollowUpCandidate({
  ...BASE,
  entry: {
    id: 8,
    startedAt: "2026-08-27T02:00:00.000Z",
    matureAt: "2026-08-31T02:00:00.000Z"
  },
  events: [event("outbound_delivered_observed", "2026-08-27T02:00:00.000Z")],
  now: "2026-08-29T03:00:00.000Z"
});
assert.equal(weekend.reasonCode, "feedback_waiting");

const freshRead = projectMessageFollowUpCandidate({
  ...BASE,
  events: [event("outbound_read_observed", "2026-08-28T03:00:00.000Z")],
  now: "2026-08-29T03:00:00.000Z"
});
assert.equal(freshRead.reasonCode, "feedback_waiting");
assert.equal(freshRead.waitingSince, "2026-08-28T03:00:00.000Z");

const matureRead = projectMessageFollowUpCandidate({
  ...BASE,
  events: [event("outbound_read_observed", "2026-08-28T03:00:00.000Z")],
  now: "2026-08-31T03:00:00.000Z"
});
assert.equal(matureRead.eligible, true);
assert.equal(matureRead.waitedHours, 72);

assert.equal(projectMessageFollowUpCandidate({
  ...BASE,
  events: [
    ...BASE.events,
    event("incoming_message_classified", "2026-08-25T04:00:00.000Z", {
      source: "platform_observation",
      messageIntent: "information_request"
    })
  ]
}).reasonCode, "not_unanswered");

for (const decisionBucket of ["caution", "not_recommended", "analysis_pending"]) {
  assert.equal(projectMessageFollowUpCandidate({
    ...BASE,
    job: { ...BASE.job, decisionBucket }
  }).reasonCode, "tier_ineligible");
}

assert.equal(projectMessageFollowUpCandidate({
  ...BASE,
  job: { ...BASE.job, archived: true }
}).reasonCode, "archived");
assert.equal(projectMessageFollowUpCandidate({
  ...BASE,
  card: { ...BASE.card, threadKey: "" }
}).reasonCode, "conversation_unresolved");

for (const stage of [
  "contact_started", "needs_user_action", "reply_ready", "interview_invited",
  "interview_scheduled", "resume_submitted", "rejected", "closed"
]) {
  assert.equal(projectMessageFollowUpCandidate({
    ...BASE,
    card: { ...BASE.card, stage }
  }).reasonCode, "stage_ineligible");
}

for (const applicationStatus of [
  "review", "later", "skipped", "interview", "rejected", "invalid", "salary_mismatch"
]) {
  assert.equal(projectMessageFollowUpCandidate({
    ...BASE,
    job: { ...BASE.job, applicationStatus }
  }).reasonCode, "outcome_ineligible");
}

assert.equal(projectMessageFollowUpCandidate({
  ...BASE,
  hasSentFollowUp: true
}).reasonCode, "already_followed_up");
assert.equal(projectMessageFollowUpCandidate({
  ...BASE,
  hasActiveFollowUp: true
}).reasonCode, "follow_up_active");

assert.equal(projectMessageFollowUpCandidate({
  ...BASE,
  events: []
}).reasonCode, "not_unanswered");

assert.throws(
  () => projectMessageFollowUpCandidate({ ...BASE, now: "not-a-date" }),
  /now/
);

console.log("message_follow_up_smoke ok");

function event(type, occurredAt, metadata = {}) {
  return { type, occurredAt, metadata };
}
