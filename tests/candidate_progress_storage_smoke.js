const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb, createBatch, upsertJob } = require("../src/core/storage");
const {
  ensureProgressCard,
  recordDiscoveredMessageClassification,
  recordDiscoveredMessageGroupClassification,
  correctProgressStage,
  getProgressCardForJob,
  bindProgressCardThread,
  listMessageDiscoveryCandidates,
  findMessageDiscoveryJobContext,
  listProgressCardsWithEvents,
  listProgressEvents
} = require("../src/core/candidate_progress");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-candidate-progress-"));
let db;

try {
  db = openDb(path.join(root, "progress.sqlite"));
  const now = "2026-07-23T08:00:00.000Z";
  const fixture = createFixture(db, "progress", now);

  const first = ensureProgressCard(db, {
    profileId: fixture.profileId,
    planId: fixture.planId,
    jobId: fixture.jobId,
    source: "boss",
    now
  });
  const second = ensureProgressCard(db, {
    profileId: fixture.profileId,
    planId: fixture.planId,
    jobId: fixture.jobId,
    source: "boss",
    now
  });
  assert.strictEqual(first.id, second.id);
  assert.strictEqual(first.stage, "contact_started");
  const withJob = listProgressCardsWithEvents(db, { profileId: fixture.profileId })[0];
  assert.deepStrictEqual(withJob.job, {
    id: fixture.jobId,
    source: "boss",
    sourceId: "job-progress",
    title: "Job progress",
    company: "",
    salary: "",
    location: "",
    url: "",
    batchId: null
  });

  const recorded = recordDiscoveredMessageClassification(db, {
    cardId: first.id,
    platform: "boss",
    threadKey: digest("thread"),
    messageKey: digest("message"),
    messageCategory: "availability",
    missingFactKey: "",
    progressUpdate: {
      stage: "reply_ready",
      nextAction: "untrusted model text"
    },
    occurredAt: now
  });
  assert.strictEqual(recorded.stage, "reply_ready");
  assert.strictEqual(recorded.nextAction, "Review draft before manual send");
  assert.strictEqual(listProgressEvents(db, first.id).length, 1);
  const bound = bindProgressCardThread(db, {
    cardId: first.id,
    threadKey: digest("thread"),
    now
  });
  assert.strictEqual(bound.threadKey, digest("thread"));
  assert.throws(
    () => bindProgressCardThread(db, {
      cardId: first.id,
      threadKey: digest("different-thread"),
      now
    }),
    (error) => error.code === "PROGRESS_THREAD_CONFLICT"
  );

  const repeated = recordDiscoveredMessageClassification(db, {
    cardId: first.id,
    platform: "boss",
    threadKey: digest("thread"),
    messageKey: digest("message"),
    messageCategory: "availability",
    missingFactKey: "",
    progressUpdate: {
      stage: "reply_ready",
      nextAction: "different untrusted text"
    },
    occurredAt: now
  });
  assert.strictEqual(repeated.id, recorded.id);
  assert.strictEqual(listProgressEvents(db, first.id).length, 1);

  const rollbackFixture = createFixture(db, "rollback", now);
  const rollbackCard = ensureProgressCard(db, {
    ...rollbackFixture,
    source: "boss",
    now
  });
  assert.throws(
    () => recordDiscoveredMessageClassification(db, {
      cardId: rollbackCard.id,
      platform: "boss",
      threadKey: digest("rollback-thread"),
      messageKey: digest("rollback-message"),
      messageCategory: "availability",
      missingFactKey: "",
      progressUpdate: {
        stage: "interview_scheduled",
        nextAction: ""
      },
      occurredAt: "2026-07-23T08:01:00.000Z"
    }),
    (error) => error.code === "PROGRESS_STAGE_TRANSITION_INVALID"
  );
  assert.strictEqual(getProgressCardForJob(db, {
    profileId: rollbackFixture.profileId,
    jobId: rollbackFixture.jobId
  }).threadKey, "");
  assert.strictEqual(listProgressEvents(db, rollbackCard.id).length, 0);

  const groupFixture = createFixture(db, "group", now);
  const groupCard = ensureProgressCard(db, {
    ...groupFixture,
    source: "boss",
    now
  });
  const groupInput = {
    cardId: groupCard.id,
    platform: "boss",
    threadKey: digest("group-thread"),
    messageKeys: [digest("group-msg-1"), digest("group-msg-2")],
    messageGroupKey: digest("group"),
    messageIntent: "information_request",
    messageCategory: "availability",
    missingFactKey: "",
    progressUpdate: {
      stage: "reply_ready",
      nextAction: "untrusted model text"
    },
    occurredAt: "2026-07-23T08:02:00.000Z"
  };
  const groupRecorded = recordDiscoveredMessageGroupClassification(db, groupInput);
  assert.strictEqual(groupRecorded.stage, "reply_ready");
  assert.strictEqual(groupRecorded.nextAction, "Review draft before manual send");
  const groupEvents = listProgressEvents(db, groupCard.id);
  assert.strictEqual(
    groupEvents.length,
    3,
    "two message events plus one group event"
  );
  assert(
    groupEvents.every((event) => event.metadata.messageIntent === "information_request"),
    "group and individual message events must preserve the safe semantic intent"
  );
  assert.strictEqual(recordDiscoveredMessageGroupClassification(db, groupInput).id, groupCard.id);
  assert.strictEqual(
    listProgressEvents(db, groupCard.id).length,
    3,
    "group retry must not duplicate events"
  );
  assert.throws(
    () => recordDiscoveredMessageGroupClassification(db, {
      ...groupInput,
      messageIntent: "interview_keyword_seen"
    }),
    (error) => error.code === "PROGRESS_MESSAGE_INTENT_INVALID"
  );
  const groupRollbackFixture = createFixture(db, "group-rollback", now);
  const groupRollbackCard = ensureProgressCard(db, {
    ...groupRollbackFixture,
    source: "boss",
    now
  });
  assert.throws(
    () => recordDiscoveredMessageGroupClassification(db, {
      cardId: groupRollbackCard.id,
      platform: "boss",
      threadKey: digest("group-rollback-thread"),
      messageKeys: [digest("group-rollback-msg")],
      messageGroupKey: digest("group-rollback"),
      messageIntent: "information_request",
      messageCategory: "availability",
      missingFactKey: "",
      progressUpdate: {
        stage: "interview_scheduled",
        nextAction: ""
      },
      occurredAt: "2026-07-23T08:03:00.000Z"
    }),
    (error) => error.code === "PROGRESS_STAGE_TRANSITION_INVALID"
  );
  assert.strictEqual(getProgressCardForJob(db, {
    profileId: groupRollbackFixture.profileId,
    jobId: groupRollbackFixture.jobId
  }).threadKey, "");
  assert.strictEqual(listProgressEvents(db, groupRollbackCard.id).length, 0);

  const correctionFixture = createFixture(db, "correction", now);
  const correctionCard = ensureProgressCard(db, {
    ...correctionFixture,
    source: "boss",
    now
  });
  const correctionKey = "progress:00000000-0000-4000-8000-000000000001";
  correctProgressStage(db, {
    cardId: correctionCard.id,
    idempotencyKey: correctionKey,
    expectedStage: "contact_started",
    toStage: "interview_scheduled",
    reason: "用户确认阶段应为已安排面试",
    now: "2026-07-23T08:04:00.000Z"
  });
  assert.throws(
    () => correctProgressStage(db, {
      cardId: correctionCard.id,
      idempotencyKey: correctionKey,
      expectedStage: "waiting_reply",
      toStage: "interview_scheduled",
      reason: "用户确认阶段应为已安排面试",
      now: "2026-07-23T08:04:01.000Z"
    }),
    (error) => error.code === "PROGRESS_IDEMPOTENCY_CONFLICT",
    "the same correction idempotency key must include the expected from stage"
  );

  const contextFixture = createFixture(db, "context", now);
  ensureProgressCard(db, { ...contextFixture, source: "boss", now });
  const oldComplete = recordContextObservation(db, contextFixture, {
    keyword: "message-old-complete",
    seenAt: "2026-07-23T08:05:00.000Z",
    description: "OLD_COMPLETE_JD ".repeat(12),
    analysis: { semanticStatus: "complete", marker: "old-same-observation" },
    tags: ["old-tag"],
    qualityTags: ["trusted-detail"]
  });
  recordContextObservation(db, contextFixture, {
    keyword: "message-new-failed",
    seenAt: "2026-07-23T08:06:00.000Z",
    description: "NEW_FAILED_JD ".repeat(12),
    analysis: { semanticStatus: "failed", marker: "must-not-mix" }
  });
  const otherPlanId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Other plan', '{}', NULL, 0, ?, ?)`).run(contextFixture.profileId, now, now).lastInsertRowid);
  recordContextObservation(db, { ...contextFixture, planId: otherPlanId }, {
    keyword: "message-other-plan",
    seenAt: "2026-07-23T08:07:00.000Z",
    description: "OTHER_PLAN_JD ".repeat(12),
    analysis: { semanticStatus: "complete", marker: "must-not-cross-plan" }
  });
  const otherProfileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Other profile', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  recordContextObservation(db, { ...contextFixture, profileId: otherProfileId }, {
    keyword: "message-other-profile",
    seenAt: "2026-07-23T08:08:00.000Z",
    description: "OTHER_PROFILE_JD ".repeat(12),
    analysis: { semanticStatus: "complete", marker: "must-not-cross-profile" }
  });
  db.prepare(`UPDATE jobs
    SET title = 'LATEST_FAILED_TITLE', company = 'Latest Failed Co',
      location = 'Shenzhen', salary = '99-100K'
    WHERE id = ?`).run(contextFixture.jobId);

  const contextCandidate = listMessageDiscoveryCandidates(db, { profileId: contextFixture.profileId })
    .find((item) => item.jobId === contextFixture.jobId);
  assert.strictEqual(contextCandidate.sourceId, "job-context");
  assert.strictEqual(contextCandidate.title, "Job context");
  assert.strictEqual(contextCandidate.company, "Context Co");
  assert.strictEqual(contextCandidate.city, "Guangzhou");
  assert.strictEqual(contextCandidate.salary, "20-30K");
  assert.strictEqual(contextCandidate.observationId, oldComplete.observationId);
  assert.strictEqual(contextCandidate.description, "OLD_COMPLETE_JD ".repeat(12));
  assert.deepStrictEqual(contextCandidate.analysis, { semanticStatus: "complete", marker: "old-same-observation" });
  assert.deepStrictEqual(contextCandidate.tags, ["old-tag"]);
  assert.deepStrictEqual(contextCandidate.qualityTags, ["trusted-detail"]);
  assert.strictEqual(contextCandidate.contextComplete, true);
  assert.strictEqual(contextCandidate.contextSource, "local_cache");
  assert.deepStrictEqual(
    findMessageDiscoveryJobContext(db, {
      profileId: contextFixture.profileId,
      planId: contextFixture.planId,
      sourceId: "job-context"
    }),
    contextCandidate
  );

  console.log("candidate_progress_storage_smoke ok");
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}

function createFixture(database, suffix, now) {
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES (?, '{}', NULL, ?, ?)`).run(`Candidate ${suffix}`, now, now).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, ?, '{}', NULL, 1, ?, ?)`).run(profileId, `Plan ${suffix}`, now, now).lastInsertRowid);
  const jobId = Number(database.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at
  ) VALUES ('boss', ?, ?, ?, ?)`).run(`job-${suffix}`, `Job ${suffix}`, now, now).lastInsertRowid);
  return { profileId, planId, jobId };
}

function recordContextObservation(database, fixture, overrides = {}) {
  const batchId = createBatch(database, "boss", overrides.keyword, "message discovery context fixture", {
    profileId: fixture.profileId,
    searchPlanId: fixture.planId
  });
  upsertJob(database, {
    source: "boss",
    sourceId: "job-context",
    keyword: overrides.keyword,
    title: "Job context",
    company: "Context Co",
    location: "Guangzhou",
    salary: "20-30K",
    experience: "3-5年",
    education: "本科",
    bossActiveText: "今日活跃",
    url: "https://www.zhipin.com/job_detail/job-context.html",
    tags: overrides.tags || [],
    description: overrides.description,
    qualityTags: overrides.qualityTags || [],
    analysis: overrides.analysis
  }, batchId);
  const row = database.prepare("SELECT id FROM job_observations WHERE batch_id = ? AND job_id = ?")
    .get(batchId, fixture.jobId);
  database.prepare("UPDATE job_observations SET seen_at = ? WHERE id = ?").run(overrides.seenAt, row.id);
  return { batchId, observationId: Number(row.id) };
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}
