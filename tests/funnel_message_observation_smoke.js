const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDb } = require("../src/core/storage");
const {
  ensureProgressCard,
  bindProgressCardThread,
  listProgressEvents,
  recordDiscoveredMessageGroupClassification
} = require("../src/core/candidate_progress");
const { projectFunnelEntry } = require("../src/core/funnel_maturity");
const { recordFunnelRowObservations } = require("../src/core/funnel_observation");

const db = openDb(":memory:");
try {
  const now = "2026-08-25T02:00:00.000Z";
  const owner = createOwner(db, now);
  const read = createBoundCard(db, owner, "read", now);
  const delivered = createBoundCard(db, owner, "delivered", now);
  const reply = createBoundCard(db, owner, "reply", now);
  const notice = createBoundCard(db, owner, "notice", now);
  const secretPreview = "SECRET_HR_PREVIEW_SHOULD_NOT_PERSIST";
  const secretRecruiter = "SECRET_RECRUITER_LABEL";

  const observed = recordFunnelRowObservations(db, {
    profileId: owner.profileId,
    platform: "boss",
    rows: [
      row(read.threadKey, "read-a", "self_read", secretPreview, secretRecruiter),
      row(delivered.threadKey, "delivered-a", "self_delivered", secretPreview, secretRecruiter),
      row(reply.threadKey, "reply-a", "possible_hr_reply", secretPreview, secretRecruiter),
      row(notice.threadKey, "notice-a", "platform_notice", secretPreview, secretRecruiter),
      row(digest("unbound-thread"), "unbound-a", "possible_hr_reply", secretPreview, secretRecruiter)
    ],
    observedAt: now
  });
  assert.deepEqual(observed, {
    readObserved: 1,
    deliveredObserved: 1,
    inboundReplyObserved: 1,
    skipped: 2
  });
  assert.deepEqual(listProgressEvents(db, read.card.id).map((item) => item.type), ["outbound_read_observed"]);
  assert.deepEqual(listProgressEvents(db, delivered.card.id).map((item) => item.type), ["outbound_delivered_observed"]);
  assert.deepEqual(listProgressEvents(db, reply.card.id).map((item) => item.type), ["inbound_reply_observed"]);
  assert.equal(listProgressEvents(db, notice.card.id).length, 0);

  const persisted = db.prepare(`SELECT summary, metadata_json FROM candidate_progress_events
    WHERE card_id IN (?, ?, ?) ORDER BY id`).all(read.card.id, delivered.card.id, reply.card.id);
  assert(persisted.every((item) => !item.summary.includes(secretPreview) && !item.summary.includes(secretRecruiter)));
  assert(persisted.every((item) => !item.metadata_json.includes(secretPreview) && !item.metadata_json.includes(secretRecruiter)));
  assert(persisted.every((item) => item.metadata_json.includes("sha256:")));
  assert(!JSON.stringify(observed).includes(secretPreview), "the public result contains counts only");

  recordFunnelRowObservations(db, {
    profileId: owner.profileId,
    platform: "boss",
    rows: [row(read.threadKey, "read-a", "self_read", "changed raw preview", "changed label")],
    observedAt: "2026-08-25T03:00:00.000Z"
  });
  assert.equal(listProgressEvents(db, read.card.id).length, 1, "the same safe preview observation is idempotent");

  recordFunnelRowObservations(db, {
    profileId: owner.profileId,
    platform: "boss",
    rows: [row(read.threadKey, "read-b", "self_read", "another preview", "another label")],
    observedAt: "2026-08-27T02:00:00.000Z"
  });
  const readEvents = listProgressEvents(db, read.card.id);
  assert.equal(readEvents.length, 2, "a new read digest is a new safe observation");
  const readProjection = projectFunnelEntry({
    id: 1,
    startedAt: now,
    matureAt: "2026-08-27T02:00:00.000Z"
  }, readEvents, { now: "2026-08-31T02:00:00.000Z" });
  assert.equal(readProjection.readNoReplyMaturesAt, "2026-08-31T02:00:00.000Z");
  assert.equal(readProjection.readNoReplyMature, true);

  const resume = createBoundCard(db, owner, "resume", now);
  const resumeInput = {
    cardId: resume.card.id,
    platform: "boss",
    threadKey: resume.threadKey,
    messageKeys: [digest("resume-message")],
    messageGroupKey: digest("resume-group"),
    messageIntent: "manual_review",
    messageCategory: "other",
    missingFactKey: "",
    manualActions: [{ kind: "resume_request" }],
    progressUpdate: { stage: "needs_user_action" },
    occurredAt: now
  };
  recordDiscoveredMessageGroupClassification(db, resumeInput);
  assert.deepEqual(
    listProgressEvents(db, resume.card.id).map((item) => item.type).sort(),
    ["incoming_message_classified", "message_group_classified", "resume_requested"].sort()
  );
  recordDiscoveredMessageGroupClassification(db, resumeInput);
  assert.equal(listProgressEvents(db, resume.card.id).length, 3, "résumé request retries stay idempotent");

  const interview = createBoundCard(db, owner, "interview", now);
  recordDiscoveredMessageGroupClassification(db, {
    cardId: interview.card.id,
    platform: "boss",
    threadKey: interview.threadKey,
    messageKeys: [digest("interview-message")],
    messageGroupKey: digest("interview-group"),
    messageIntent: "interview_invitation",
    messageCategory: "other",
    missingFactKey: "",
    progressUpdate: { stage: "interview_invited" },
    occurredAt: now
  });
  const interviewEvents = listProgressEvents(db, interview.card.id);
  assert.equal(interviewEvents.length, 2, "the classified group already proves the interview without a duplicate event");
  assert.equal(projectFunnelEntry({
    id: 2,
    startedAt: now,
    matureAt: "2026-08-27T02:00:00.000Z"
  }, interviewEvents, { now }).interviewInvited.value, true);

  console.log("funnel_message_observation_smoke: ok");
} finally {
  db.close();
}

function createOwner(database, now) {
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Observation candidate', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Observation plan', '{}', NULL, 1, ?, ?)`).run(profileId, now, now).lastInsertRowid);
  return { profileId, planId };
}

function createBoundCard(database, owner, suffix, now) {
  const jobId = Number(database.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at
  ) VALUES ('boss', ?, ?, ?, ?)`).run(`observation-${suffix}`, `Observation ${suffix}`, now, now).lastInsertRowid);
  const card = ensureProgressCard(database, {
    ...owner,
    jobId,
    source: "boss",
    now
  });
  const threadKey = digest(`thread-${suffix}`);
  bindProgressCardThread(database, { cardId: card.id, threadKey, now });
  return { card, jobId, threadKey };
}

function row(conversationKey, preview, previewKind, previewText, recruiterLabel) {
  return {
    rowIndex: 0,
    unread: false,
    selected: false,
    conversationKey,
    previewDigest: digest(preview),
    previewKind,
    previewText,
    recruiterLabel
  };
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}
