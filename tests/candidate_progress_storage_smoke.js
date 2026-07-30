const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb } = require("../src/core/storage");
const {
  ensureProgressCard,
  recordProgressEvent,
  transitionProgressCard,
  correctProgressStage,
  recordIncomingMessageClassification,
  recordDiscoveredMessageClassification,
  recordManualProgressAction,
  getProgressCardForJob,
  listMessageDiscoveryCandidates,
  listProgressCards,
  listProgressEvents
} = require("../src/core/candidate_progress");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-candidate-progress-"));
let db;

try {
  const dbPath = path.join(root, "progress.sqlite");
  db = openDb(dbPath);
  const now = "2026-07-23T08:00:00.000Z";
  const { profileId, planId, jobId } = createFixture(db, "progress", now);

  const card = ensureProgressCard(db, { profileId, planId, jobId, source: "boss", now });
  assert.strictEqual(card.stage, "contact_started");
  assert.strictEqual(
    ensureProgressCard(db, { profileId, planId, jobId, source: "boss", now }).id,
    card.id,
    "a profile and job must have exactly one progress card"
  );
  assert.strictEqual(getProgressCardForJob(db, { profileId, jobId }).id, card.id);
  assert.deepStrictEqual(listProgressCards(db, { profileId, stages: ["contact_started"] }).map((item) => item.id), [card.id]);

  const discoveryFixture = createFixture(db, "message-discovery", now);
  db.prepare("UPDATE jobs SET title = 'Java Engineer' WHERE id = ?").run(discoveryFixture.jobId);
  const discoveryCard = ensureProgressCard(db, { ...discoveryFixture, source: "boss", now });
  const discoveryCandidates = listMessageDiscoveryCandidates(db, { profileId: discoveryFixture.profileId });
  assert.deepStrictEqual(discoveryCandidates.map((item) => item.cardId), [discoveryCard.id]);
  assert.strictEqual(discoveryCandidates[0].title, "Java Engineer");

  const discoveredInput = {
    cardId: discoveryCard.id,
    platform: "boss",
    threadKey: `sha256:${"a".repeat(64)}`,
    messageKey: `sha256:${"b".repeat(64)}`,
    messageCategory: "qualification",
    missingFactKey: "",
    progressUpdate: { stage: "reply_ready", nextAction: "Copy after user review" },
    occurredAt: "2026-07-30T01:00:00.000Z"
  };
  const discovered = recordDiscoveredMessageClassification(db, discoveredInput);
  assert.strictEqual(discovered.stage, "reply_ready");
  assert.strictEqual(discovered.threadKey, `sha256:${"a".repeat(64)}`);
  assert.strictEqual(recordDiscoveredMessageClassification(db, discoveredInput).stage, "reply_ready");
  assert.strictEqual(
    listProgressEvents(db, discoveryCard.id).filter((event) => event.type === "incoming_message_classified").length,
    1,
    "the same discovered message must create one event"
  );
  assert.throws(
    () => recordDiscoveredMessageClassification(db, {
      ...discoveredInput,
      messageCategory: "salary"
    }),
    (error) => error.code === "PROGRESS_IDEMPOTENCY_CONFLICT"
  );

  const rollbackFixture = createFixture(db, "discovery-rollback", now);
  const rollbackCard = ensureProgressCard(db, { ...rollbackFixture, source: "boss", now });
  assert.throws(
    () => recordDiscoveredMessageClassification(db, {
      cardId: rollbackCard.id,
      platform: "boss",
      threadKey: `sha256:${"c".repeat(64)}`,
      messageKey: `sha256:${"d".repeat(64)}`,
      messageCategory: "qualification",
      missingFactKey: "",
      progressUpdate: { stage: "interview_scheduled", nextAction: "" },
      occurredAt: "2026-07-30T01:01:00.000Z"
    }),
    (error) => error.code === "PROGRESS_STAGE_TRANSITION_INVALID"
  );
  assert.strictEqual(getProgressCardForJob(db, {
    profileId: rollbackFixture.profileId,
    jobId: rollbackFixture.jobId
  }).threadKey, "");
  assert.strictEqual(listProgressEvents(db, rollbackCard.id).length, 0);

  recordProgressEvent(db, {
    cardId: card.id,
    idempotencyKey: requestKey(1),
    type: "incoming_message_classified",
    actor: "system",
    summary: "项目事实确认",
    metadata: { category: "project_fact", factKey: "project_status", jobId },
    occurredAt: "2026-07-23T08:01:00.000Z"
  });
  recordProgressEvent(db, {
    cardId: card.id,
    idempotencyKey: requestKey(1),
    type: "incoming_message_classified",
    actor: "system",
    summary: "项目事实确认",
    metadata: { category: "project_fact", factKey: "project_status", jobId },
    occurredAt: "2026-07-23T08:01:00.000Z"
  });
  const initialEvents = listProgressEvents(db, card.id);
  assert.strictEqual(initialEvents.length, 1, "repeated event writes must be idempotent");
  assert.throws(
    () => recordProgressEvent(db, {
      cardId: card.id,
      idempotencyKey: "progress:salary-expectation-is-sensitive",
      type: "incoming_message_classified",
      actor: "system",
      summary: "项目事实确认",
      metadata: { category: "project_fact" }
    }),
    (error) => error.code === "PROGRESS_IDEMPOTENCY_KEY_INVALID"
  );
  assert.throws(
    () => recordProgressEvent(db, {
      cardId: card.id,
      idempotencyKey: requestKey(1),
      type: "incoming_message_classified",
      actor: "system",
      summary: "不同操作内容",
      metadata: { category: "project_fact", factKey: "project_status", jobId }
    }),
    (error) => error.code === "PROGRESS_IDEMPOTENCY_CONFLICT"
  );
  assert.strictEqual(initialEvents[0].summary, "项目事实确认");
  assert.deepStrictEqual(initialEvents[0].metadata, {
    category: "project_fact",
    factKey: "project_status",
    jobId
  });
  assert(!JSON.stringify(initialEvents).includes("HR 原话正文"));

  const sanitizedFixture = createFixture(db, "sanitized-summary", now);
  const sanitizedCard = ensureProgressCard(db, {
    ...sanitizedFixture,
    source: "boss",
    now
  });
  recordIncomingMessageClassification(db, {
    cardId: sanitizedCard.id,
    idempotencyKey: requestKey(2),
    messageCategory: "project_fact",
    missingFactKey: "project_status",
    progressUpdate: {
      stage: "needs_user_action",
      nextAction: "请用户确认项目事实",
      summary: "HR 原话正文"
    },
    occurredAt: "2026-07-23T08:01:30.000Z"
  });
  recordIncomingMessageClassification(db, {
    cardId: sanitizedCard.id,
    idempotencyKey: requestKey(2),
    messageCategory: "project_fact",
    missingFactKey: "project_status",
    progressUpdate: {
      stage: "needs_user_action",
      nextAction: "请用户确认项目事实",
      summary: "另一段 HR 原话"
    },
    occurredAt: "2026-07-23T08:01:31.000Z"
  });
  const sanitizedEvents = listProgressEvents(db, sanitizedCard.id);
  assert.strictEqual(sanitizedEvents.length, 1, "classification retries must not append events");
  assert.strictEqual(sanitizedEvents[0].summary, "项目事实确认");
  assert(!JSON.stringify(sanitizedEvents).includes("HR 原话正文"));

  for (const forbiddenKey of ["message", "body", "text", "html", "draft", "screenshot"]) {
    assert.throws(
      () => recordProgressEvent(db, {
        cardId: card.id,
        idempotencyKey: requestKey(3),
        type: "incoming_message_classified",
        actor: "system",
        summary: "净化检查",
        metadata: { category: "privacy_check", [forbiddenKey]: "HR 原话正文" }
      }),
      (error) => error.code === "PROGRESS_EVENT_METADATA_FORBIDDEN"
    );
  }
  assert.strictEqual(listProgressEvents(db, card.id).length, initialEvents.length);

  transitionProgressCard(db, {
    cardId: sanitizedCard.id,
    expectedStage: "needs_user_action",
    stage: "reply_ready",
    nextAction: "复制草稿并手动发送",
    now: "2026-07-23T08:01:40.000Z"
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    recordManualProgressAction(db, {
      cardId: sanitizedCard.id,
      idempotencyKey: requestKey(4),
      eventType: "manual_reply_sent",
      stage: "waiting_reply",
      summary: "用户确认已手动发送",
      nextAction: "等待招聘方回复",
      now: `2026-07-23T08:01:4${attempt + 1}.000Z`
    });
  }
  assert.strictEqual(
    listProgressEvents(db, sanitizedCard.id).filter((event) => event.type === "manual_reply_sent").length,
    1,
    "manual action retries must not append events"
  );
  assert.throws(
    () => recordManualProgressAction(db, {
      cardId: sanitizedCard.id,
      idempotencyKey: requestKey(4),
      eventType: "opportunity_closed",
      stage: "closed",
      summary: "用户关闭机会",
      nextAction: "",
      now: "2026-07-23T08:01:45.000Z"
    }),
    (error) => error.code === "PROGRESS_IDEMPOTENCY_CONFLICT"
  );

  const movedFixture = createFixture(db, "plan-move", now);
  const movedCard = ensureProgressCard(db, { ...movedFixture, source: "boss", now });
  const latestPlanId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Latest reliable plan', '{}', NULL, 1, ?, ?)`)
    .run(movedFixture.profileId, now, now).lastInsertRowid);
  const reassignedCard = ensureProgressCard(db, {
    profileId: movedFixture.profileId,
    planId: latestPlanId,
    jobId: movedFixture.jobId,
    source: "boss",
    now: "2026-07-23T08:01:50.000Z"
  });
  assert.strictEqual(reassignedCard.id, movedCard.id, "cross-plan discovery must keep the unique card");
  assert.strictEqual(reassignedCard.planId, movedFixture.planId, "plan remains source metadata");
  const delayedOldCall = ensureProgressCard(db, {
    ...movedFixture,
    source: "boss",
    now: "2026-07-23T08:01:40.000Z"
  });
  assert.strictEqual(delayedOldCall.planId, movedFixture.planId, "delayed calls cannot move card ownership");
  assert.deepStrictEqual(
    listProgressCards(db, { profileId: movedFixture.profileId }).map((item) => item.id),
    [movedCard.id],
    "profile progress pool must expose the unique card across plans"
  );

  assert.throws(
    () => transitionProgressCard(db, {
      cardId: card.id,
      expectedStage: "contact_started",
      stage: "interview_scheduled",
      nextAction: "",
      scheduledAt: null
    }),
    (error) => error.code === "PROGRESS_STAGE_TRANSITION_INVALID"
  );

  assert.throws(
    () => correctProgressStage(db, {
      cardId: card.id,
      idempotencyKey: requestKey(5),
      expectedStage: "contact_started",
      toStage: "interview_scheduled",
      reason: " ",
      now: "2026-07-23T08:02:00.000Z"
    }),
    (error) => error.code === "PROGRESS_CORRECTION_REASON_REQUIRED"
  );

  const corrected = correctProgressStage(db, {
    cardId: card.id,
    idempotencyKey: requestKey(6),
    expectedStage: "contact_started",
    toStage: "interview_scheduled",
    reason: "用户确认阶段应为已安排面试",
    now: "2026-07-23T08:02:00.000Z"
  });
  assert.strictEqual(corrected.id, card.id);
  assert.strictEqual(corrected.stage, "interview_scheduled");
  assert.strictEqual(correctProgressStage(db, {
    cardId: card.id,
    idempotencyKey: requestKey(6),
    expectedStage: "contact_started",
    toStage: "interview_scheduled",
    reason: "用户确认阶段应为已安排面试",
    now: "2026-07-23T08:02:01.000Z"
  }).stage, "interview_scheduled", "same correction retry must return current state before stage validation");
  assert.throws(
    () => correctProgressStage(db, {
      cardId: card.id,
      idempotencyKey: requestKey(6),
      expectedStage: "contact_started",
      toStage: "interview_scheduled",
      reason: "改成不同纠正内容",
      now: "2026-07-23T08:02:02.000Z"
    }),
    (error) => error.code === "PROGRESS_IDEMPOTENCY_CONFLICT"
  );
  let events = listProgressEvents(db, card.id);
  assert.strictEqual(events.length, initialEvents.length + 1);
  assert.strictEqual(events.filter((event) => event.type === "manual_correction").length, 1);
  assert.deepStrictEqual(events.at(-1).metadata, {
    fromStage: "contact_started",
    toStage: "interview_scheduled"
  });

  correctProgressStage(db, {
    cardId: card.id,
    idempotencyKey: requestKey(7),
    expectedStage: "interview_scheduled",
    toStage: "closed",
    reason: "用户主动关闭机会",
    now: "2026-07-23T08:03:00.000Z"
  });
  assert.throws(
    () => correctProgressStage(db, {
      cardId: card.id,
      idempotencyKey: requestKey(8),
      expectedStage: "closed",
      toStage: "rejected",
      reason: "错误的关闭后纠正",
      now: "2026-07-23T08:04:00.000Z"
    }),
    (error) => error.code === "PROGRESS_STAGE_TRANSITION_INVALID"
  );
  const reopened = correctProgressStage(db, {
    cardId: card.id,
    idempotencyKey: requestKey(9),
    expectedStage: "closed",
    toStage: "needs_user_action",
    reason: "用户重新开启机会",
    now: "2026-07-23T08:05:00.000Z"
  });
  assert.strictEqual(reopened.id, card.id);
  assert.strictEqual(reopened.stage, "needs_user_action");
  assert.strictEqual(listProgressCards(db, { profileId }).length, 1);
  assert.strictEqual(listProgressEvents(db, card.id).length, initialEvents.length + 3);
  db.close();
  db = null;

  const historicalPath = path.join(root, "historical-v4.sqlite");
  db = openDb(historicalPath);
  const history = createFixture(db, "historical", now);
  const legacySuccess = createFixture(db, "legacy-success", now);
  const legacyAlready = createFixture(db, "legacy-already", now);
  db.prepare(`INSERT INTO candidate_job_states(
    profile_id, job_id, plan_id, status, reason_code, note, review_at, updated_at
  ) VALUES (?, ?, ?, 'applied', 'communication_succeeded', '', NULL, ?)`)
    .run(history.profileId, history.jobId, history.planId, now);
  db.prepare(`INSERT INTO candidate_job_states(
    profile_id, job_id, plan_id, status, reason_code, note, review_at, updated_at
  ) VALUES (?, ?, ?, 'applied', 'succeeded', '', NULL, ?)`)
    .run(legacySuccess.profileId, legacySuccess.jobId, legacySuccess.planId, now);
  db.prepare(`INSERT INTO candidate_job_states(
    profile_id, job_id, plan_id, status, reason_code, note, review_at, updated_at
  ) VALUES (?, ?, NULL, 'applied', 'already_communicated', '', NULL, ?)`)
    .run(legacyAlready.profileId, legacyAlready.jobId, now);
  const communicationBatchId = Number(db.prepare(`INSERT INTO communication_batches(
    site, profile_id, plan_id, browser_mode, status, policy_json,
    confirmed_at, finished_at, created_at, updated_at
  ) VALUES ('boss', ?, ?, 'edge', 'completed', '{}', ?, ?, ?, ?)`)
    .run(legacyAlready.profileId, legacyAlready.planId, now, now, now, now).lastInsertRowid);
  db.prepare(`INSERT INTO communication_batch_items(
    batch_id, job_id, position, job_url, title_snapshot, status,
    click_count, finished_at, updated_at
  ) VALUES (?, ?, 1, 'https://example.test/already', 'Already communicated',
    'already_communicated', 0, ?, ?)`)
    .run(communicationBatchId, legacyAlready.jobId, now, now);
  db.exec(`
    DROP TABLE IF EXISTS candidate_progress_events;
    DROP TABLE IF EXISTS candidate_progress_cards;
    DELETE FROM schema_migrations WHERE version > 4;
    PRAGMA user_version = 4;
  `);
  db.close();

  db = openDb(historicalPath);
  const historicalCard = getProgressCardForJob(db, {
    profileId: history.profileId,
    jobId: history.jobId
  });
  assert.strictEqual(historicalCard.stage, "waiting_reply");
  assert.deepStrictEqual(
    { ...db.prepare(`SELECT status, reason_code FROM candidate_job_states
      WHERE profile_id = ? AND job_id = ?`).get(history.profileId, history.jobId) },
    { status: "applied", reason_code: "communication_succeeded" },
    "migration must not rewrite the historical application status"
  );
  const historicalEvents = listProgressEvents(db, historicalCard.id);
  assert.strictEqual(historicalEvents.length, 1);
  assert.strictEqual(historicalEvents[0].actor, "system");
  assert(!JSON.stringify(historicalEvents).includes("HR 原话正文"));
  assert.strictEqual(
    getProgressCardForJob(db, {
      profileId: legacySuccess.profileId,
      jobId: legacySuccess.jobId
    }).stage,
    "waiting_reply"
  );
  const alreadyCard = getProgressCardForJob(db, {
    profileId: legacyAlready.profileId,
    jobId: legacyAlready.jobId
  });
  assert.strictEqual(alreadyCard.planId, legacyAlready.planId);
  assert.strictEqual(alreadyCard.stage, "waiting_reply");
  assert.strictEqual(listProgressEvents(db, alreadyCard.id)[0].type, "contact_already_exists");

  db.close();
  db = openDb(historicalPath);
  db.exec(`
    DELETE FROM schema_migrations WHERE version IN (5, 6);
    PRAGMA user_version = 4;
  `);
  db.close();
  db = openDb(historicalPath);
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS count FROM candidate_progress_cards").get().count,
    3
  );
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS count FROM candidate_progress_events").get().count,
    3
  );
  assert.strictEqual(listProgressEvents(db, historicalCard.id).length, 1);

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

function requestKey(sequence) {
  return `progress:00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}
