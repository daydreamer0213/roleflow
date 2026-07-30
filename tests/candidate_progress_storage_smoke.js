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
  getProgressCardForJob,
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
  assert.deepStrictEqual(listProgressCards(db, { planId, stages: ["contact_started"] }).map((item) => item.id), [card.id]);

  recordProgressEvent(db, {
    cardId: card.id,
    type: "incoming_message_classified",
    actor: "system",
    summary: "项目事实确认",
    metadata: { category: "project_fact", factKey: "project_status", jobId },
    occurredAt: "2026-07-23T08:01:00.000Z"
  });
  const initialEvents = listProgressEvents(db, card.id);
  assert.strictEqual(initialEvents[0].summary, "项目事实确认");
  assert.deepStrictEqual(initialEvents[0].metadata, {
    category: "project_fact",
    factKey: "project_status",
    jobId
  });
  assert(!JSON.stringify(initialEvents).includes("HR 原话正文"));

  for (const forbiddenKey of ["message", "body", "text", "html", "draft", "screenshot"]) {
    assert.throws(
      () => recordProgressEvent(db, {
        cardId: card.id,
        type: "incoming_message_classified",
        actor: "system",
        summary: "净化检查",
        metadata: { category: "privacy_check", [forbiddenKey]: "HR 原话正文" }
      }),
      (error) => error.code === "PROGRESS_EVENT_METADATA_FORBIDDEN"
    );
  }
  assert.strictEqual(listProgressEvents(db, card.id).length, initialEvents.length);

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
      expectedStage: "contact_started",
      toStage: "interview_scheduled",
      reason: " ",
      now: "2026-07-23T08:02:00.000Z"
    }),
    (error) => error.code === "PROGRESS_CORRECTION_REASON_REQUIRED"
  );

  const corrected = correctProgressStage(db, {
    cardId: card.id,
    expectedStage: "contact_started",
    toStage: "interview_scheduled",
    reason: "用户确认阶段应为已安排面试",
    now: "2026-07-23T08:02:00.000Z"
  });
  assert.strictEqual(corrected.id, card.id);
  assert.strictEqual(corrected.stage, "interview_scheduled");
  let events = listProgressEvents(db, card.id);
  assert.strictEqual(events.length, initialEvents.length + 1);
  assert.strictEqual(events.filter((event) => event.type === "manual_correction").length, 1);
  assert.deepStrictEqual(events.at(-1).metadata, {
    fromStage: "contact_started",
    toStage: "interview_scheduled"
  });

  correctProgressStage(db, {
    cardId: card.id,
    expectedStage: "interview_scheduled",
    toStage: "closed",
    reason: "用户主动关闭机会",
    now: "2026-07-23T08:03:00.000Z"
  });
  assert.throws(
    () => correctProgressStage(db, {
      cardId: card.id,
      expectedStage: "closed",
      toStage: "rejected",
      reason: "错误的关闭后纠正",
      now: "2026-07-23T08:04:00.000Z"
    }),
    (error) => error.code === "PROGRESS_STAGE_TRANSITION_INVALID"
  );
  const reopened = correctProgressStage(db, {
    cardId: card.id,
    expectedStage: "closed",
    toStage: "needs_user_action",
    reason: "用户重新开启机会",
    now: "2026-07-23T08:05:00.000Z"
  });
  assert.strictEqual(reopened.id, card.id);
  assert.strictEqual(reopened.stage, "needs_user_action");
  assert.strictEqual(listProgressCards(db, { planId }).length, 1);
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
    DELETE FROM schema_migrations WHERE version = 5;
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
