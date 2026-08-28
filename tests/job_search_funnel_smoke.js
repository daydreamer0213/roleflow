const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDb, createBatch, upsertJob, markCandidateJob } = require("../src/core/storage");
const {
  ensureProgressCard,
  recordProgressEvent,
  recordVerifiedCommunicationStart,
  recordManualProgressAction
} = require("../src/core/candidate_progress");
const {
  feedbackMaturesAt,
  readNoReplyMaturesAt,
  diagnosisStrength,
  projectFunnelEntry,
  buildFunnelSnapshot
} = require("../src/core/funnel_maturity");
const {
  getFunnelPolicy,
  saveFunnelPolicy,
  ensureFunnelEntry,
  getFunnelEntry,
  listFunnelEntries,
  freezeReadyFunnelCohort,
  listFunnelCohorts,
  getFunnelCohort,
  listFunnelProgressEvents
} = require("../src/storage/funnel_store");

function event(type, occurredAt, metadata = {}) {
  return { type, occurredAt, metadata };
}

function maturityRulesSmoke() {
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

  assert.equal(diagnosisStrength(29), "facts");
  assert.equal(diagnosisStrength(30), "preliminary");
  assert.equal(diagnosisStrength(50), "comparable");
  assert.equal(diagnosisStrength(70), "formal");
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

  const oldEntryNewRead = projectFunnelEntry(entry, [
    event("outbound_read_observed", "2026-08-28T03:00:00.000Z", {
      source: "platform_observation",
      messageKey: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    })
  ], { now: "2026-08-28T04:00:00.000Z" });
  assert.equal(oldEntryNewRead.mature, true, "the job-level window is already mature");
  assert.equal(oldEntryNewRead.replied.value, null, "a newly read message starts a fresh reply window");
  assert.equal(oldEntryNewRead.readNoReplyMature, false);

  const oldEntryNewReadMature = projectFunnelEntry(entry, [
    event("outbound_read_observed", "2026-08-28T03:00:00.000Z", {
      source: "platform_observation",
      messageKey: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    })
  ], { now: "2026-08-31T03:00:00.000Z" });
  assert.equal(oldEntryNewReadMature.replied.value, false, "read-without-reply becomes negative only after its own window");
  assert.equal(oldEntryNewReadMature.readNoReplyMature, true);

  const newerDelivered = projectFunnelEntry(entry, [
    event("outbound_read_observed", "2026-08-25T08:00:00.000Z", {
      source: "platform_observation",
      messageKey: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
    }),
    event("outbound_delivered_observed", "2026-08-28T08:00:00.000Z", {
      source: "platform_observation",
      messageKey: "sha256:2222222222222222222222222222222222222222222222222222222222222222"
    })
  ], { now: "2026-08-31T09:00:00.000Z" });
  assert.equal(newerDelivered.read.value, true, "an earlier safe read remains a reached funnel milestone");
  assert.equal(newerDelivered.readNoReplyMature, false, "a newer delivered message clears the older read-no-reply clock");
  assert.equal(newerDelivered.readNoReplyMaturesAt, null);

  const historicalReplyThenNoReply = projectFunnelEntry(entry, [
    event("incoming_message_classified", "2026-08-25T03:00:00.000Z", {
      source: "platform_observation",
      messageIntent: "information_request"
    }),
    event("outbound_read_observed", "2026-08-26T04:00:00.000Z", {
      source: "platform_observation"
    })
  ], { now: "2026-08-28T04:00:00.000Z" });
  assert.equal(historicalReplyThenNoReply.replied.value, true, "the cumulative funnel remembers an earlier reply");
  assert.equal(historicalReplyThenNoReply.readNoReplyMature, true,
    "an older HR reply does not satisfy a newer read-without-reply window");

  const newUnclassifiedReply = projectFunnelEntry(entry, [
    event("message_group_classified", "2026-08-25T03:00:00.000Z", {
      source: "platform_observation",
      messageIntent: "polite_acknowledgement"
    }),
    event("inbound_reply_observed", "2026-08-25T04:00:00.000Z", {
      source: "platform_observation"
    })
  ], { now: "2026-08-28T04:00:00.000Z" });
  assert.equal(newUnclassifiedReply.effectiveConversation.value, null,
    "an old classification cannot mark a newer unclassified reply ineffective");

  const correctedTerminal = projectFunnelEntry(entry, [
    event("rejected", "2026-08-25T05:00:00.000Z", { source: "user_record" }),
    event("opportunity_closed", "2026-08-25T06:00:00.000Z", { source: "user_record" }),
    event("opportunity_reopened", "2026-08-25T07:00:00.000Z", { source: "user_record", stage: "needs_user_action" })
  ], { now: "2026-08-28T03:00:00.000Z" });
  assert.equal(correctedTerminal.rejected.value, false, "reopening clears the current rejected state");
  assert.equal(correctedTerminal.closed.value, false, "reopening clears the current closed state");

  const correctedInterview = projectFunnelEntry(entry, [
    event("interview_invited", "2026-08-25T05:00:00.000Z", { source: "user_record" }),
    event("interview_scheduled", "2026-08-25T06:00:00.000Z", { source: "user_record" }),
    event("manual_correction", "2026-08-25T07:00:00.000Z", {
      source: "user_record",
      fromStage: "interview_scheduled",
      toStage: "waiting_reply"
    })
  ], { now: "2026-08-28T03:00:00.000Z" });
  assert.equal(correctedInterview.interviewInvited.value, false);
  assert.equal(correctedInterview.interviewConfirmed.value, false, "a user stage correction overrides old interview milestones");

  const invitedAgain = projectFunnelEntry(entry, [
    event("interview_scheduled", "2026-08-25T06:00:00.000Z", { source: "user_record" }),
    event("manual_correction", "2026-08-25T07:00:00.000Z", {
      source: "user_record",
      toStage: "waiting_reply"
    }),
    event("message_group_classified", "2026-08-25T08:00:00.000Z", {
      source: "platform_observation",
      messageIntent: "interview_invitation"
    })
  ], { now: "2026-08-28T03:00:00.000Z" });
  assert.equal(invitedAgain.interviewInvited.value, true, "newer platform evidence can supersede an older correction");
  assert.equal(invitedAgain.interviewConfirmed.value, false, "a new invitation does not inherit an old confirmation");

  const platformRejected = projectFunnelEntry(entry, [
    event("rejected", "2026-08-25T09:00:00.000Z", { source: "platform_observation" })
  ], { now: "2026-08-28T03:00:00.000Z" });
  assert.equal(platformRejected.rejected.value, true, "an explicit platform rejection is valid terminal evidence");
  assert.equal(platformRejected.read.value, null);
  assert.equal(platformRejected.replied.value, null,
    "a terminal status without an HR message must not masquerade as a reply");

  const userClosedAfterRead = projectFunnelEntry(entry, [
    event("outbound_read_observed", "2026-08-25T03:00:00.000Z", { source: "platform_observation" }),
    event("opportunity_closed", "2026-08-25T04:00:00.000Z", { source: "user_record" })
  ], { now: "2026-08-29T03:00:00.000Z" });
  assert.equal(userClosedAfterRead.read.value, true);
  assert.equal(userClosedAfterRead.replied.value, null);
  assert.equal(userClosedAfterRead.closed.value, true);
  assert.equal(userClosedAfterRead.readNoReplyMature, false,
    "a terminal entry leaves the reply denominator instead of becoming a no-reply failure");
  assert.equal(userClosedAfterRead.replyWindowWaiting, false);

  const sameTimestampReply = projectFunnelEntry(entry, [
    event("outbound_read_observed", "2026-08-25T03:00:00.000Z", { source: "platform_observation" }),
    event("inbound_reply_observed", "2026-08-25T03:00:00.000Z", { source: "platform_observation" })
  ], { now: "2026-08-29T03:00:00.000Z" });
  assert.equal(sameTimestampReply.replied.value, true);
  assert.equal(sameTimestampReply.readNoReplyMature, false,
    "a same-observation reply conservatively satisfies the read window");
  assert.equal(sameTimestampReply.replyWindowWaiting, false);

  const historicalReplyThenClosed = [
    event("inbound_reply_observed", "2026-08-25T03:00:00.000Z", { source: "platform_observation" }),
    event("outbound_read_observed", "2026-08-27T03:00:00.000Z", { source: "platform_observation" }),
    event("opportunity_closed", "2026-08-27T04:00:00.000Z", { source: "user_record" })
  ];
  const closedBeforeDeadline = projectFunnelEntry(entry, historicalReplyThenClosed, {
    now: "2026-08-28T04:00:00.000Z"
  });
  assert.equal(closedBeforeDeadline.replied.value, true, "the earlier real reply remains a reached milestone");
  assert.equal(closedBeforeDeadline.closed.value, true);
  assert.equal(closedBeforeDeadline.replyWindowWaiting, false,
    "a current terminal state stops a newer read waiting clock even when an older reply exists");
  const closedAfterDeadline = projectFunnelEntry(entry, historicalReplyThenClosed, {
    now: "2026-08-31T03:00:00.000Z"
  });
  assert.equal(closedAfterDeadline.readNoReplyMature, false,
    "a closed opportunity never becomes a later read-no-reply failure");
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
    samplePolicy: {
      preliminarySampleTarget: 30,
      comparableSampleTarget: 50,
      formalSampleTarget: 70
    }
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

function conditionalFunnelSmoke() {
  const entries = [
    { id: 11, startedAt: "2026-08-20T00:00:00.000Z", matureAt: "2026-08-22T00:00:00.000Z" },
    { id: 12, startedAt: "2026-08-20T00:00:00.000Z", matureAt: "2026-08-22T00:00:00.000Z" },
    { id: 13, startedAt: "2026-08-20T00:00:00.000Z", matureAt: "2026-08-22T00:00:00.000Z" },
    { id: 14, startedAt: "2026-08-27T00:00:00.000Z", matureAt: "2026-08-31T00:00:00.000Z" }
  ];
  const snapshot = buildFunnelSnapshot(entries, new Map([
    [11, [event("outbound_delivered_observed", "2026-08-20T02:00:00.000Z")]],
    [12, [
      event("outbound_read_observed", "2026-08-20T02:00:00.000Z"),
      event("message_group_classified", "2026-08-20T03:00:00.000Z", { messageIntent: "information_request" })
    ]],
    [13, [event("outbound_read_observed", "2026-08-20T02:00:00.000Z")]],
    [14, [event("message_group_classified", "2026-08-27T03:00:00.000Z", { messageIntent: "interview_invitation" })]]
  ]), { now: "2026-08-28T00:00:00.000Z" });

  assert.deepEqual(snapshot.stages.read, { numerator: 2, denominator: 3, unknown: 0, waiting: 1 });
  assert.deepEqual(snapshot.stages.replied, { numerator: 1, denominator: 2, unknown: 0, waiting: 1 }, "reply conversion only uses reached read stages");
  assert.deepEqual(snapshot.stages.effectiveConversation, { numerator: 1, denominator: 1, unknown: 0, waiting: 1 });
  assert.deepEqual(snapshot.immediatePositive, {
    read: 3,
    replied: 2,
    effectiveConversation: 2,
    resumeRequested: 0,
    interviewInvited: 1,
    interviewConfirmed: 0
  }, "positive outcomes stay visible before the entry matures");
  assert.deepEqual(snapshot.earlyPositive, {
    read: 1,
    replied: 1,
    effectiveConversation: 1,
    resumeRequested: 0,
    interviewInvited: 1,
    interviewConfirmed: 0
  }, "positive outcomes inside the 48-hour waiting window remain separately visible");

  const replyWindowSnapshot = buildFunnelSnapshot(
    Array.from({ length: 30 }, (_, index) => ({
      id: 100 + index,
      startedAt: "2026-08-20T00:00:00.000Z",
      matureAt: "2026-08-22T00:00:00.000Z"
    })),
    new Map(Array.from({ length: 30 }, (_, index) => [100 + index, [
      event("outbound_read_observed", index < 10
        ? "2026-08-20T02:00:00.000Z"
        : "2026-08-28T03:00:00.000Z")
    ]])),
    { now: "2026-08-28T04:00:00.000Z" }
  );
  assert.equal(replyWindowSnapshot.mature, 30);
  assert.equal(replyWindowSnapshot.waiting, 20, "a fresh read starts a stage-level 48-hour wait");
  assert.equal(replyWindowSnapshot.unknown, 20);
  assert.deepEqual(replyWindowSnapshot.stages.replied, {
    numerator: 0,
    denominator: 10,
    unknown: 0,
    waiting: 20
  });

  const terminalSnapshot = buildFunnelSnapshot([
    { id: 200, startedAt: "2026-08-20T00:00:00.000Z", matureAt: "2026-08-22T00:00:00.000Z" }
  ], new Map([[200, [
    event("opportunity_closed", "2026-08-21T00:00:00.000Z", { source: "user_record" })
  ]]]), { now: "2026-08-28T04:00:00.000Z" });
  assert.deepEqual(terminalSnapshot.stages.read, {
    numerator: 0,
    denominator: 0,
    unknown: 0,
    waiting: 0
  }, "a terminal-only entry is excluded from response conversion denominators");
  assert.equal(terminalSnapshot.unknown, 0);

  const readThenTerminalSnapshot = buildFunnelSnapshot([
    { id: 201, startedAt: "2026-08-20T00:00:00.000Z", matureAt: "2026-08-22T00:00:00.000Z" }
  ], new Map([[201, [
    event("outbound_read_observed", "2026-08-20T03:00:00.000Z", { source: "platform_observation" }),
    event("opportunity_closed", "2026-08-21T00:00:00.000Z", { source: "user_record" })
  ]]]), { now: "2026-08-28T04:00:00.000Z" });
  assert.equal(readThenTerminalSnapshot.stages.read.numerator, 1,
    "a real read milestone remains visible after the user closes the opportunity");
  assert.equal(readThenTerminalSnapshot.stages.replied.denominator, 0,
    "the terminal action still leaves the reply conversion denominator");
}

function storageRulesSmoke() {
  const db = openDb(":memory:");
  try {
    const startedAt = "2026-08-25T02:00:00.000Z";
    const fixture = storageFixture(db, "main", startedAt, {
      keyword: "AI 应用开发",
      greeting: "您好，我做过 RAG 应用。",
      recommendation: "primary"
    });
    const resumeVersionId = insertResumeVersion(db, fixture.profileId, "resume-a", startedAt);
    const card = ensureProgressCard(db, {
      ...fixture,
      source: "boss",
      now: startedAt
    });

    assert.deepEqual(getFunnelPolicy(db, { profileId: fixture.profileId }), {
      profileId: fixture.profileId,
      preliminarySampleTarget: 30,
      comparableSampleTarget: 50,
      formalSampleTarget: 70,
      updatedAt: null
    });
    assert.equal(saveFunnelPolicy(db, {
      profileId: fixture.profileId,
      preliminarySampleTarget: 40,
      comparableSampleTarget: 60,
      formalSampleTarget: 80,
      updatedAt: startedAt
    }).formalSampleTarget, 80);
    assert.throws(() => saveFunnelPolicy(db, {
      profileId: fixture.profileId,
      preliminarySampleTarget: 50,
      comparableSampleTarget: 50,
      formalSampleTarget: 70,
      updatedAt: startedAt
    }), /strictly increase/);
    saveFunnelPolicy(db, {
      profileId: fixture.profileId,
      preliminarySampleTarget: 30,
      comparableSampleTarget: 50,
      formalSampleTarget: 70,
      updatedAt: startedAt
    });

    const first = ensureFunnelEntry(db, {
      profileId: fixture.profileId,
      planId: fixture.planId,
      jobId: fixture.jobId,
      cardId: card.id,
      sourceKind: "applied",
      startedAt
    });
    assert.equal(first.directionKey, "AI 应用开发");
    assert.equal(first.decisionBucket, "primary");
    assert.equal(first.resumeVersionId, resumeVersionId);
    assert.equal(first.greetingKey, digest("您好，我做过 RAG 应用。"));
    assert.equal(first.matureAt, "2026-08-27T02:00:00.000Z");

    db.prepare("UPDATE candidate_resume_versions SET is_active = 0, updated_at = ? WHERE id = ?")
      .run("2026-08-26T00:00:00.000Z", resumeVersionId);
    insertResumeVersion(db, fixture.profileId, "resume-b", "2026-08-26T00:00:00.000Z");
    db.prepare("UPDATE jobs SET keyword = 'Java', greeting = '新的招呼语', analysis_json = '{\"recommendation\":\"caution\"}' WHERE id = ?")
      .run(fixture.jobId);
    const repeated = ensureFunnelEntry(db, {
      profileId: fixture.profileId,
      planId: fixture.planId,
      jobId: fixture.jobId,
      cardId: card.id,
      sourceKind: "communication",
      startedAt: "2026-08-26T00:00:00.000Z"
    });
    assert.deepEqual(repeated, first, "later activity must not rewrite the original entry snapshot");
    assert.equal(listFunnelEntries(db, { profileId: fixture.profileId }).length, 1);

    const inboundOnly = storageFixture(db, "inbound-only", startedAt);
    ensureProgressCard(db, { ...inboundOnly, source: "boss", now: startedAt });
    assert.equal(getFunnelEntry(db, {
      profileId: inboundOnly.profileId,
      jobId: inboundOnly.jobId
    }), null, "a progress card alone must not become a funnel entry");

    for (let index = 1; index < 69; index += 1) {
      const extra = addJobToFixture(db, fixture, `mature-${index}`, startedAt);
      ensureFunnelEntry(db, {
        profileId: fixture.profileId,
        planId: fixture.planId,
        jobId: extra.jobId,
        sourceKind: "applied",
        startedAt
      });
    }
    assert.equal(listFunnelEntries(db, {
      profileId: fixture.profileId,
      unassignedOnly: true
    }).length, 69);
    assert.equal(freezeReadyFunnelCohort(db, {
      profileId: fixture.profileId,
      now: "2026-08-28T00:00:00.000Z"
    }), null, "69 mature entries do not meet a formal target of 70");

    for (let index = 69; index < 83; index += 1) {
      const extra = addJobToFixture(db, fixture, `mature-${index}`, startedAt);
      ensureFunnelEntry(db, {
        profileId: fixture.profileId,
        planId: fixture.planId,
        jobId: extra.jobId,
        sourceKind: "applied",
        startedAt
      });
    }
    const immature = addJobToFixture(db, fixture, "immature", "2026-08-28T02:00:00.000Z");
    ensureFunnelEntry(db, {
      profileId: fixture.profileId,
      planId: fixture.planId,
      jobId: immature.jobId,
      sourceKind: "applied",
      startedAt: "2026-08-28T02:00:00.000Z"
    });

    const cohort = freezeReadyFunnelCohort(db, {
      profileId: fixture.profileId,
      now: "2026-08-28T03:00:00.000Z"
    });
    assert.equal(cohort.sampleCount, 83, "all mature entries join the cohort instead of the first 70");
    assert.equal(getFunnelCohort(db, {
      profileId: fixture.profileId,
      cohortId: cohort.id
    }).entries.length, 83);
    assert.equal(listFunnelCohorts(db, { profileId: fixture.profileId, limit: 10 }).length, 1);
    assert.equal(freezeReadyFunnelCohort(db, {
      profileId: fixture.profileId,
      now: "2026-08-28T03:00:00.000Z"
    }), null, "freezing is idempotent when only immature work remains");
    assert.equal(getFunnelEntry(db, {
      profileId: fixture.profileId,
      jobId: immature.jobId
    }).cohortId, null);

    recordProgressEvent(db, {
      cardId: card.id,
      idempotencyKey: "progress:00000000-0000-4000-8000-000000000098",
      type: "rejected",
      actor: "user",
      summary: "旧记录，不属于本次求职动作",
      metadata: { source: "user_record" },
      occurredAt: "2026-08-24T02:00:00.000Z"
    });
    db.prepare(`INSERT INTO candidate_job_events(
      profile_id, job_id, plan_id, event_type, payload_json, created_at
    ) VALUES (?, ?, ?, 'rejected', '{}', ?)`)
      .run(fixture.profileId, fixture.jobId, fixture.planId, "2026-08-24T03:00:00.000Z");
    recordProgressEvent(db, {
      cardId: card.id,
      idempotencyKey: "progress:00000000-0000-4000-8000-000000000099",
      type: "interview_invited",
      actor: "user",
      summary: "用户记录收到面试邀请",
      metadata: { source: "user_record" },
      occurredAt: "2026-08-29T02:00:00.000Z"
    });
    const progressEvents = listFunnelProgressEvents(db, {
      profileId: fixture.profileId,
      entryIds: [first.id]
    });
    assert.equal(progressEvents.length, 1);
    assert.equal(progressEvents[0].entryId, first.id);
    assert.equal(progressEvents[0].type, "interview_invited");
    assert.equal(getFunnelEntry(db, {
      profileId: fixture.profileId,
      jobId: fixture.jobId
    }).cohortId, cohort.id, "late outcomes must not move frozen membership");

    const secondProfile = storageFixture(db, "second-profile", startedAt);
    const sharedJobEntry = ensureFunnelEntry(db, {
      profileId: secondProfile.profileId,
      planId: secondProfile.planId,
      jobId: fixture.jobId,
      sourceKind: "applied",
      startedAt
    });
    assert.notEqual(sharedJobEntry.profileId, first.profileId);
    assert.equal(sharedJobEntry.jobId, first.jobId);

    const isolated = storageFixture(db, "profile-isolation", startedAt, {
      keyword: "本用户方向",
      greeting: "本用户招呼语"
    });
    const foreign = storageFixture(db, "foreign-observer", startedAt);
    const foreignBatch = createBatch(db, "boss", "其他用户方向", "foreign observation", {
      profileId: foreign.profileId,
      searchPlanId: foreign.planId
    });
    upsertJob(db, {
      source: "boss",
      sourceId: "funnel-job-profile-isolation",
      keyword: "其他用户方向",
      title: "Foreign updated title",
      greeting: "其他用户招呼语",
      analysis: { recommendation: "caution" }
    }, foreignBatch);
    db.prepare("UPDATE job_observations SET seen_at = ? WHERE batch_id = ? AND job_id = ?")
      .run(startedAt, foreignBatch, isolated.jobId);
    const isolatedEntry = ensureFunnelEntry(db, {
      profileId: isolated.profileId,
      jobId: isolated.jobId,
      sourceKind: "applied",
      startedAt
    });
    assert.equal(isolatedEntry.directionKey, "本用户方向", "a missing plan id must still isolate observations by profile");
    assert.equal(isolatedEntry.greetingKey, digest("本用户招呼语"));

    const blindProfileId = Number(db.prepare(`INSERT INTO candidate_profiles(
      display_name, profile_json, source_hash, created_at, updated_at
    ) VALUES ('Blind Candidate', '{}', NULL, ?, ?)`).run(startedAt, startedAt).lastInsertRowid);
    db.prepare(`INSERT INTO search_plans(
      profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
    ) VALUES (?, 'Blind active plan', ?, NULL, 1, ?, ?)`)
      .run(blindProfileId, JSON.stringify({ directions: ["本用户计划方向"] }), startedAt, startedAt);
    const blindEntry = ensureFunnelEntry(db, {
      profileId: blindProfileId,
      jobId: isolated.jobId,
      sourceKind: "applied",
      startedAt
    });
    assert.equal(blindEntry.directionKey, "本用户计划方向",
      "without an owned observation, only the candidate's active plan may supply direction");
    assert.equal(blindEntry.decisionBucket, "");
    assert.equal(blindEntry.greetingKey, "",
      "global job fields updated by another candidate must never supply material snapshots");
  } finally {
    db.close();
  }
}

function enrollmentRulesSmoke() {
  const db = openDb(":memory:");
  try {
    const now = "2026-08-25T02:00:00.000Z";
    const applied = storageFixture(db, "enroll-applied", now);
    markCandidateJob(db, {
      profileId: applied.profileId,
      planId: applied.planId,
      jobId: applied.jobId,
      status: "applied"
    });
    const appliedEntry = getFunnelEntry(db, {
      profileId: applied.profileId,
      jobId: applied.jobId
    });
    assert(appliedEntry, "a user-confirmed application must enter the funnel");
    assert.equal(appliedEntry.sourceKind, "applied");

    for (const status of ["review", "later", "skipped", "no_reply", "interview", "rejected", "invalid", "salary_mismatch"]) {
      const job = addJobToFixture(db, applied, `not-entry-${status}`, now);
      markCandidateJob(db, {
        profileId: applied.profileId,
        planId: applied.planId,
        jobId: job.jobId,
        status
      });
      assert.equal(getFunnelEntry(db, {
        profileId: applied.profileId,
        jobId: job.jobId
      }), null, `${status} alone must not create an application/contact sample`);
    }

    const communication = storageFixture(db, "enroll-communication", now);
    const communicationCard = recordVerifiedCommunicationStart(db, {
      batch: {
        id: 101,
        profileId: communication.profileId,
        planId: communication.planId,
        site: "boss"
      },
      item: { id: 201, jobId: communication.jobId },
      outcome: "succeeded",
      now
    });
    const communicationEntry = getFunnelEntry(db, {
      profileId: communication.profileId,
      jobId: communication.jobId
    });
    assert.equal(communicationEntry.sourceKind, "communication");
    assert.equal(communicationEntry.cardId, communicationCard.id);

    markCandidateJob(db, {
      profileId: communication.profileId,
      planId: communication.planId,
      jobId: communication.jobId,
      status: "applied"
    });
    assert.deepEqual(getFunnelEntry(db, {
      profileId: communication.profileId,
      jobId: communication.jobId
    }), communicationEntry, "overlapping proof reuses the original entry and dimensions");

    const already = storageFixture(db, "enroll-already", now);
    recordVerifiedCommunicationStart(db, {
      batch: {
        id: 102,
        profileId: already.profileId,
        planId: already.planId,
        site: "boss"
      },
      item: { id: 202, jobId: already.jobId },
      outcome: "already_communicated",
      now
    });
    assert.equal(getFunnelEntry(db, {
      profileId: already.profileId,
      jobId: already.jobId
    }).sourceKind, "communication");

    const inbound = storageFixture(db, "enroll-inbound", now);
    const inboundCard = ensureProgressCard(db, { ...inbound, source: "boss", now });
    assert.equal(getFunnelEntry(db, {
      profileId: inbound.profileId,
      jobId: inbound.jobId
    }), null);
    recordManualProgressAction(db, {
      cardId: inboundCard.id,
      idempotencyKey: "progress:00000000-0000-4000-8000-000000000301",
      stage: "waiting_reply",
      eventType: "reply_confirmed_sent",
      summary: "用户确认已手动发送",
      nextAction: "等待招聘方回复",
      now
    });
    assert.equal(getFunnelEntry(db, {
      profileId: inbound.profileId,
      jobId: inbound.jobId
    }).sourceKind, "reply_sent", "an inbound opportunity enters only after the user actually replies");

    const rollback = storageFixture(db, "enroll-rollback", now);
    db.exec(`CREATE TRIGGER reject_funnel_entry BEFORE INSERT ON candidate_funnel_entries
      BEGIN SELECT RAISE(ABORT, 'funnel enrollment failed'); END`);
    assert.throws(() => markCandidateJob(db, {
      profileId: rollback.profileId,
      planId: rollback.planId,
      jobId: rollback.jobId,
      status: "applied"
    }), /funnel enrollment failed/);
    db.exec("DROP TRIGGER reject_funnel_entry");
    assert.equal(db.prepare(`SELECT count(*) AS count FROM candidate_job_states
      WHERE profile_id = ? AND job_id = ?`).get(rollback.profileId, rollback.jobId).count, 0);
    assert.equal(db.prepare(`SELECT count(*) AS count FROM candidate_job_events
      WHERE profile_id = ? AND job_id = ?`).get(rollback.profileId, rollback.jobId).count, 0);
    assert.equal(getFunnelEntry(db, {
      profileId: rollback.profileId,
      jobId: rollback.jobId
    }), null, "application state, event, and funnel entry must roll back together");

    const communicationRollback = storageFixture(db, "enroll-communication-rollback", now);
    db.exec(`CREATE TRIGGER reject_communication_funnel BEFORE INSERT ON candidate_funnel_entries
      BEGIN SELECT RAISE(ABORT, 'communication funnel enrollment failed'); END`);
    assert.throws(() => recordVerifiedCommunicationStart(db, {
      batch: {
        id: 103,
        profileId: communicationRollback.profileId,
        planId: communicationRollback.planId,
        site: "boss"
      },
      item: { id: 203, jobId: communicationRollback.jobId },
      outcome: "succeeded",
      now
    }), /communication funnel enrollment failed/);
    db.exec("DROP TRIGGER reject_communication_funnel");
    assert.equal(db.prepare(`SELECT count(*) AS count FROM candidate_progress_cards
      WHERE profile_id = ? AND job_id = ?`).get(
      communicationRollback.profileId,
      communicationRollback.jobId
    ).count, 0, "communication card creation rolls back with funnel enrollment");
    assert.equal(db.prepare(`SELECT count(*) AS count FROM candidate_progress_events events
      JOIN candidate_progress_cards cards ON cards.id = events.card_id
      WHERE cards.profile_id = ? AND cards.job_id = ?`).get(
      communicationRollback.profileId,
      communicationRollback.jobId
    ).count, 0);

    const replyRollback = storageFixture(db, "enroll-reply-rollback", now);
    const replyRollbackCard = ensureProgressCard(db, { ...replyRollback, source: "boss", now });
    const originalStage = replyRollbackCard.stage;
    db.exec(`CREATE TRIGGER reject_reply_funnel BEFORE INSERT ON candidate_funnel_entries
      BEGIN SELECT RAISE(ABORT, 'reply funnel enrollment failed'); END`);
    assert.throws(() => recordManualProgressAction(db, {
      cardId: replyRollbackCard.id,
      idempotencyKey: "progress:00000000-0000-4000-8000-000000000302",
      stage: "waiting_reply",
      eventType: "reply_confirmed_sent",
      summary: "用户确认已手动发送",
      nextAction: "等待招聘方回复",
      now
    }), /reply funnel enrollment failed/);
    db.exec("DROP TRIGGER reject_reply_funnel");
    assert.equal(db.prepare("SELECT stage FROM candidate_progress_cards WHERE id = ?")
      .get(replyRollbackCard.id).stage, originalStage, "reply stage rolls back with funnel enrollment");
    assert.equal(db.prepare(`SELECT count(*) AS count FROM candidate_progress_events
      WHERE card_id = ? AND idempotency_key = ?`).get(
      replyRollbackCard.id,
      "progress:00000000-0000-4000-8000-000000000302"
    ).count, 0, "reply completion event rolls back with funnel enrollment");
    assert.equal(getFunnelEntry(db, {
      profileId: replyRollback.profileId,
      jobId: replyRollback.jobId
    }), null);
  } finally {
    db.close();
  }
}

function storageFixture(db, suffix, now, observation = {}) {
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES (?, '{}', NULL, ?, ?)`).run(`Candidate ${suffix}`, now, now).lastInsertRowid);
  const planJson = JSON.stringify({
    name: `Plan ${suffix}`,
    directions: [observation.keyword || "AI 应用开发"]
  });
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, ?, ?, NULL, 1, ?, ?)`).run(profileId, `Plan ${suffix}`, planJson, now, now).lastInsertRowid);
  const { jobId } = addJobToFixture(db, { profileId, planId }, `job-${suffix}`, now, observation);
  return { profileId, planId, jobId };
}

function addJobToFixture(db, owner, suffix, now, observation = {}) {
  const batchId = createBatch(db, "boss", observation.keyword || "AI 应用开发", "funnel fixture", {
    profileId: owner.profileId,
    searchPlanId: owner.planId
  });
  const sourceId = `funnel-${suffix}`;
  const jobId = upsertJob(db, {
    source: "boss",
    sourceId,
    keyword: observation.keyword || "AI 应用开发",
    title: `Job ${suffix}`,
    company: "Fixture Co",
    location: "Guangzhou",
    greeting: observation.greeting || "",
    analysis: { recommendation: observation.recommendation || "apply" }
  }, batchId);
  db.prepare("UPDATE job_observations SET seen_at = ? WHERE batch_id = ? AND job_id = ?")
    .run(now, batchId, jobId);
  return { jobId, batchId };
}

function insertResumeVersion(db, profileId, versionKey, now) {
  return Number(db.prepare(`INSERT INTO candidate_resume_versions(
    profile_id, resume_document_id, version_key, name, target_roles_json, keywords_json,
    primary_projects_json, summary, analysis_json, is_active, created_at, updated_at
  ) VALUES (?, NULL, ?, ?, '[]', '[]', '[]', '', '{}', 1, ?, ?)`)
    .run(profileId, versionKey, versionKey, now, now).lastInsertRowid);
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value).trim().replace(/\s+/g, " ")).digest("hex")}`;
}

maturityRulesSmoke();
projectionRulesSmoke();
snapshotRulesSmoke();
conditionalFunnelSmoke();
storageRulesSmoke();
enrollmentRulesSmoke();
console.log("job_search_funnel_smoke: ok");
