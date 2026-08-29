const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const storage = require("../src/core/storage");

const db = storage.openDb(":memory:");

try {
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Round Candidate', '{}', NULL, '2026-08-20T01:00:00.000Z', '2026-08-20T01:00:00.000Z')`)
    .run().lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Round Plan', '{"directions":["AI 应用工程师"]}', NULL, 1,
    '2026-08-20T01:00:00.000Z', '2026-08-20T01:00:00.000Z')`)
    .run(profileId).lastInsertRowid);

  const initial = storage.ensureActiveFunnelStrategyRound(db, {
    profileId,
    planId,
    startedAt: "2026-08-20T02:00:00.000Z"
  });
  assert.equal(initial.sequenceNumber, 1);
  assert.equal(initial.status, "active");
  assert.deepEqual(initial.thresholds, { preliminary: 30, comparable: 50, formal: 70 });
  assert.deepEqual(initial.changeKinds, ["initial"]);
  assert.deepEqual(initial.strategySnapshot.directions, ["AI 应用工程师"]);

  const jobA = addJob(db, { profileId, planId, sourceId: "round-a" });
  const entryA = storage.ensureFunnelEntry(db, {
    profileId,
    planId,
    jobId: jobA,
    sourceKind: "applied",
    startedAt: "2026-08-20T03:00:00.000Z"
  });
  assert.equal(entryA.strategyRoundId, initial.id);

  const next = storage.startFunnelStrategyRound(db, {
    profileId,
    planId,
    fromRoundId: initial.id,
    sourceKey: `manual:${initial.id}`,
    changeKinds: ["greeting"],
    changeNote: "已修改招呼语",
    startedAt: "2026-08-29T02:00:00.000Z"
  });
  assert.equal(next.sequenceNumber, 2);
  assert.equal(next.status, "active");
  assert.deepEqual(next.changeKinds, ["greeting"]);
  assert.equal(storage.getFunnelStrategyRound(db, {
    profileId,
    planId,
    roundId: initial.id
  }).status, "closed");

  const jobB = addJob(db, { profileId, planId, sourceId: "round-b" });
  const entryB = storage.ensureFunnelEntry(db, {
    profileId,
    planId,
    jobId: jobB,
    sourceKind: "communication",
    startedAt: "2026-08-29T02:30:00.000Z"
  });
  assert.equal(entryB.strategyRoundId, next.id);
  assert.deepEqual(
    storage.listFunnelEntries(db, { profileId, planId, strategyRoundId: initial.id }).map((entry) => entry.id),
    [entryA.id]
  );
  assert.deepEqual(
    storage.listFunnelEntries(db, { profileId, planId, strategyRoundId: next.id }).map((entry) => entry.id),
    [entryB.id]
  );

  const retried = storage.startFunnelStrategyRound(db, {
    profileId,
    planId,
    fromRoundId: initial.id,
    sourceKey: `manual:${initial.id}`,
    changeKinds: ["greeting"],
    changeNote: "已修改招呼语",
    startedAt: "2026-08-29T02:00:00.000Z"
  });
  assert.equal(retried.id, next.id);
  assert.equal(storage.listFunnelStrategyRounds(db, { profileId, planId }).length, 2);

  const repeatedEntryA = storage.ensureFunnelEntry(db, {
    profileId,
    planId,
    jobId: jobA,
    sourceKind: "reply_sent",
    startedAt: "2026-08-29T04:00:00.000Z"
  });
  assert.equal(repeatedEntryA.strategyRoundId, initial.id, "later activity must not rebind the original job");
  storage.recordCandidateJobEvent(db, {
    profileId,
    planId,
    jobId: jobA,
    eventType: "interview",
    payload: { source: "late_reply" }
  });
  assert.equal(
    storage.getFunnelEntry(db, { profileId, jobId: jobA }).strategyRoundId,
    initial.id,
    "late outcomes stay with the strategy round where contact began"
  );

  assert.throws(() => storage.startFunnelStrategyRound(db, {
    profileId,
    planId,
    fromRoundId: initial.id,
    sourceKey: "manual:stale",
    changeKinds: ["strategy"],
    changeNote: "迟到请求",
    startedAt: "2026-08-29T03:00:00.000Z"
  }), (error) => error.code === "FUNNEL_ROUND_STALE");

  verifyLegacyBackfill();
  console.log("funnel_strategy_round_store_smoke: ok");
} finally {
  db.close();
}

function addJob(db, { profileId, planId, sourceId }) {
  const batchId = storage.createBatch(db, "boss", "AI 应用工程师", "round membership fixture", {
    profileId,
    searchPlanId: planId
  });
  return storage.upsertJob(db, {
    source: "boss",
    sourceId,
    keyword: "AI 应用工程师",
    title: `Job ${sourceId}`,
    company: "Fixture Co"
  }, batchId);
}

function verifyLegacyBackfill() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-funnel-rounds-"));
  const dbPath = path.join(tempRoot, "legacy.db");
  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, backup_path TEXT
      );
      CREATE TABLE candidate_profiles (
        id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, profile_json TEXT NOT NULL,
        source_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE search_plans (
        id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL, name TEXT NOT NULL,
        plan_json TEXT NOT NULL, profile_version_id INTEGER, is_active INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE candidate_resume_versions (
        id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL
      );
      CREATE TABLE candidate_funnel_policies (
        profile_id INTEGER PRIMARY KEY, preliminary_sample_target INTEGER NOT NULL,
        comparable_sample_target INTEGER NOT NULL, formal_sample_target INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE candidate_funnel_cohorts (
        id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL,
        preliminary_sample_target INTEGER NOT NULL, comparable_sample_target INTEGER NOT NULL,
        formal_sample_target INTEGER NOT NULL, sample_count INTEGER NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT NOT NULL, frozen_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE candidate_funnel_entries (
        id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL, job_id INTEGER NOT NULL,
        card_id INTEGER, cohort_id INTEGER, plan_id INTEGER,
        source_kind TEXT NOT NULL, started_at TEXT NOT NULL, mature_at TEXT NOT NULL,
        direction_key TEXT NOT NULL DEFAULT '', decision_bucket TEXT NOT NULL DEFAULT '',
        resume_version_id INTEGER, greeting_key TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(profile_id, job_id)
      );
      INSERT INTO candidate_profiles VALUES (
        1, 'Legacy Candidate', '{}', NULL,
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
      INSERT INTO search_plans VALUES (
        1, 1, 'Legacy Plan', '{"directions":["AI 应用工程师"]}', NULL, 1,
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
      INSERT INTO candidate_funnel_policies VALUES (
        1, 30, 50, 70, '2026-08-01T00:00:00.000Z'
      );
      INSERT INTO candidate_funnel_cohorts VALUES (
        7, 1, 30, 50, 70, 1,
        '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
        '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:00.000Z'
      );
      INSERT INTO candidate_funnel_entries VALUES (
        11, 1, 101, NULL, 7, 1, 'applied',
        '2026-08-02T00:00:00.000Z', '2026-08-04T00:00:00.000Z',
        'AI 应用工程师', 'apply', NULL, '',
        '2026-08-02T00:00:00.000Z', '2026-08-05T00:00:00.000Z'
      );
      INSERT INTO candidate_funnel_entries VALUES (
        12, 1, 102, NULL, NULL, 1, 'applied',
        '2026-08-06T00:00:00.000Z', '2026-08-08T00:00:00.000Z',
        'AI 应用工程师', 'apply', NULL, '',
        '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z'
      );
      PRAGMA user_version = 22;
    `);
  } finally {
    legacy.close();
  }

  const migrated = storage.openDb(dbPath);
  try {
    assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 23);
    const rounds = storage.listFunnelStrategyRounds(migrated, { profileId: 1, planId: 1 });
    assert.equal(rounds.length, 2);
    assert.equal(rounds[0].status, "active");
    assert.equal(rounds[1].status, "closed");
    assert(rounds.every((round) => round.legacyUncertain));
    const entries = migrated.prepare(`SELECT id, cohort_id, strategy_round_id
      FROM candidate_funnel_entries ORDER BY id`).all();
    assert.equal(Number(entries[0].cohort_id), 7, "legacy cohort membership must remain unchanged");
    assert(entries.every((entry) => Number(entry.strategy_round_id) > 0));
    assert.equal(Number(entries[0].strategy_round_id), rounds[1].id);
    assert.equal(Number(entries[1].strategy_round_id), rounds[0].id);
  } finally {
    migrated.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
