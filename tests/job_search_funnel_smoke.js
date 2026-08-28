const assert = require("node:assert/strict");
const {
  DEFAULT_FORMAL_SAMPLE_TARGET,
  normalizeFormalSampleTarget,
  feedbackMaturesAt,
  readNoReplyMaturesAt,
  diagnosisStrength,
  projectFunnelEntry,
  buildFunnelSnapshot
} = require("../src/core/funnel_maturity");

function event(type, occurredAt, metadata = {}) {
  return { type, occurredAt, metadata };
}

function maturityRulesSmoke() {
  assert.equal(DEFAULT_FORMAL_SAMPLE_TARGET, 50);
  assert.equal(normalizeFormalSampleTarget(), 50);
  assert.equal(normalizeFormalSampleTarget(20), 20);
  assert.equal(normalizeFormalSampleTarget("500"), 500);
  assert.throws(() => normalizeFormalSampleTarget(19), /between 20 and 500/);
  assert.throws(() => normalizeFormalSampleTarget(501), /between 20 and 500/);
  assert.throws(() => normalizeFormalSampleTarget(20.5), /between 20 and 500/);

  assert.equal(
    feedbackMaturesAt("2026-08-25T02:00:00.000Z"),
    "2026-08-27T02:00:00.000Z",
    "a Tuesday contact matures at the same time on Thursday"
  );
  assert.equal(
    feedbackMaturesAt("2026-08-27T02:00:00.000Z"),
    "2026-08-31T02:00:00.000Z",
    "a Saturday China-time deadline moves to Monday"
  );
  assert.equal(
    feedbackMaturesAt("2026-08-28T02:00:00.000Z"),
    "2026-08-31T02:00:00.000Z",
    "a Sunday China-time deadline moves to Monday"
  );
  assert.equal(
    readNoReplyMaturesAt("2026-08-27T08:30:00.000Z"),
    "2026-08-31T08:30:00.000Z"
  );

  assert.equal(diagnosisStrength(19, 50), "facts");
  assert.equal(diagnosisStrength(20, 50), "preliminary");
  assert.equal(diagnosisStrength(49, 50), "preliminary");
  assert.equal(diagnosisStrength(50, 50), "formal");
  assert.equal(diagnosisStrength(20, 20), "formal");
}

function projectionRulesSmoke() {
  const entry = {
    id: 7,
    startedAt: "2026-08-25T02:00:00.000Z",
    matureAt: "2026-08-27T02:00:00.000Z"
  };
  const earlyReply = projectFunnelEntry(entry, [
    event("message_group_classified", "2026-08-25T03:00:00.000Z", {
      source: "platform_observation",
      messageIntent: "information_request"
    })
  ], { now: "2026-08-25T04:00:00.000Z" });
  assert.equal(earlyReply.replied.value, true, "a positive reply is visible immediately");
  assert.equal(earlyReply.effectiveConversation.value, true);
  assert.equal(earlyReply.mature, false, "positive results do not bypass cohort maturity");
  assert.equal(earlyReply.waitingReason, "feedback_window");

  const readWaiting = projectFunnelEntry(entry, [
    event("outbound_read_observed", "2026-08-27T08:00:00.000Z", {
      source: "platform_observation",
      messageKey: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    })
  ], { now: "2026-08-31T07:59:59.000Z" });
  assert.equal(readWaiting.read.value, true);
  assert.equal(readWaiting.readNoReplyMature, false);
  assert.equal(readWaiting.readNoReplyMaturesAt, "2026-08-31T08:00:00.000Z");

  const laterRead = projectFunnelEntry(entry, [
    event("outbound_read_observed", "2026-08-25T08:00:00.000Z", {
      source: "platform_observation",
      messageKey: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }),
    event("outbound_read_observed", "2026-08-27T08:00:00.000Z", {
      source: "platform_observation",
      messageKey: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    })
  ], { now: "2026-08-31T08:00:00.000Z" });
  assert.equal(laterRead.readNoReplyMaturesAt, "2026-08-31T08:00:00.000Z");
  assert.equal(laterRead.readNoReplyMature, true, "the latest read digest owns the deadline");

  const repliedAfterRead = projectFunnelEntry(entry, [
    event("outbound_read_observed", "2026-08-25T08:00:00.000Z", {
      source: "platform_observation",
      messageKey: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }),
    event("incoming_message_classified", "2026-08-25T09:00:00.000Z", {
      source: "platform_observation",
      messageCategory: "other"
    })
  ], { now: "2026-08-29T09:00:00.000Z" });
  assert.equal(repliedAfterRead.replied.value, true);
  assert.equal(repliedAfterRead.readNoReplyMature, false, "a later reply exits read-no-reply");

  const noticeOnly = projectFunnelEntry(entry, [
    event("platform_notice_observed", "2026-08-25T03:00:00.000Z", {
      source: "platform_observation"
    })
  ], { now: "2026-08-28T03:00:00.000Z" });
  assert.equal(noticeOnly.replied.value, null);
  assert.equal(noticeOnly.effectiveConversation.value, null);
  assert.deepEqual(noticeOnly.unknownFields, ["read", "replied", "effectiveConversation"]);
}

function snapshotRulesSmoke() {
  const entries = [
    { id: 1, startedAt: "2026-08-25T00:00:00.000Z", matureAt: "2026-08-27T00:00:00.000Z" },
    { id: 2, startedAt: "2026-08-27T00:00:00.000Z", matureAt: "2026-08-31T00:00:00.000Z" },
    { id: 3, startedAt: "2026-08-25T01:00:00.000Z", matureAt: "2026-08-27T01:00:00.000Z" }
  ];
  const snapshot = buildFunnelSnapshot(entries, new Map([
    [1, [event("outbound_read_observed", "2026-08-25T04:00:00.000Z")]],
    [2, []],
    [3, [event("message_group_classified", "2026-08-25T05:00:00.000Z", {
      messageIntent: "information_request"
    })]]
  ]), {
    now: "2026-08-28T00:00:00.000Z",
    formalSampleTarget: 50
  });

  assert.equal(snapshot.started, 3);
  assert.equal(snapshot.mature, 2);
  assert.equal(snapshot.waiting, 1);
  assert.equal(snapshot.strength, "facts");
  assert.deepEqual(snapshot.stages.replied, {
    numerator: 1,
    denominator: 2,
    unknown: 0,
    waiting: 1
  });
}

maturityRulesSmoke();
projectionRulesSmoke();
snapshotRulesSmoke();
console.log("job_search_funnel_smoke: ok");
