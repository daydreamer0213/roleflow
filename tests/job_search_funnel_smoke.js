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
storageRulesSmoke();
enrollmentRulesSmoke();
console.log("job_search_funnel_smoke: ok");
