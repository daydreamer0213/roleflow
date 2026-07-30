const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { openDb, SCHEMA_VERSION } = require("../src/core/storage");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-migration-"));
let db;

try {
  const freshPath = path.join(root, "fresh.sqlite");
  db = openDb(freshPath);
  assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.deepStrictEqual(
    db.prepare("SELECT version, name, backup_path FROM schema_migrations").all().map((row) => ({ ...row })),
    [
      { version: 1, name: "stable_scan_runtime", backup_path: null },
      { version: 2, name: "communication_batches_v1", backup_path: null },
      { version: 3, name: "workflow_runs_v1", backup_path: null },
      { version: 4, name: "workflow_runs_three_slots", backup_path: null },
      { version: 5, name: "candidate_progress_v1", backup_path: null },
      { version: 6, name: "candidate_progress_event_idempotency", backup_path: null }
    ]
  );
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='communication_batches'").get().n,
    1
  );
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='communication_batch_items'").get().n,
    1
  );
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get().n,
    1
  );
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='candidate_progress_cards'").get().n,
    1
  );
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='candidate_progress_events'").get().n,
    1
  );
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM pragma_table_info('candidate_progress_events') WHERE name='idempotency_key'").get().n,
    1
  );
  assert(SCHEMA_VERSION >= 6);
  assert.strictEqual(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  db.close();
  assert.strictEqual(fs.existsSync(path.join(root, "backups")), false, "new databases must not create upgrade backups");

  const productionV1Path = path.join(root, "production-v1.sqlite");
  db = openDb(productionV1Path);
  db.prepare("INSERT INTO keyword_sources(keyword, source, created_at) VALUES (?, ?, ?)")
    .run("v1-preserved", "migration-smoke", "2026-07-15T00:00:00.000Z");
  db.exec(`
    DROP TABLE communication_batch_items;
    DROP TABLE communication_batches;
    DROP TABLE workflow_runs;
    DELETE FROM schema_migrations WHERE version IN (2, 3, 4);
    PRAGMA user_version = 1;
  `);
  db.close();

  db = openDb(productionV1Path);
  assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.deepStrictEqual(
    db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all().map((row) => ({ ...row })),
    [
      { version: 1, name: "stable_scan_runtime" },
      { version: 2, name: "communication_batches_v1" },
      { version: 3, name: "workflow_runs_v1" },
      { version: 4, name: "workflow_runs_three_slots" },
      { version: 5, name: "candidate_progress_v1" },
      { version: 6, name: "candidate_progress_event_idempotency" }
    ]
  );
  assert.strictEqual(db.prepare("SELECT source FROM keyword_sources WHERE keyword = 'v1-preserved'").get().source, "migration-smoke");
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='communication_batches'").get().n,
    1
  );
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='communication_batch_items'").get().n,
    1
  );
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get().n,
    1
  );
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='candidate_progress_cards'").get().n,
    1
  );
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='candidate_progress_events'").get().n,
    1
  );
  db.close();
  const backupDir = path.join(root, "backups");
  const backupsAfterProductionV1Migration = fs.readdirSync(backupDir).filter((name) => name.endsWith(".sqlite"));
  assert.strictEqual(backupsAfterProductionV1Migration.length, 1);

  const legacyPath = path.join(root, "legacy.sqlite");
  db = new DatabaseSync(legacyPath);
  db.exec(`
    CREATE TABLE batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site TEXT NOT NULL,
      keyword TEXT,
      started_at TEXT NOT NULL,
      note TEXT,
      profile_id INTEGER,
      search_plan_id INTEGER,
      filter_snapshot_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      keyword TEXT,
      title TEXT NOT NULL,
      company TEXT,
      location TEXT,
      salary TEXT,
      experience TEXT,
      education TEXT,
      boss_active_text TEXT,
      boss_active_days INTEGER,
      url TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      description TEXT,
      score INTEGER NOT NULL DEFAULT 0,
      level TEXT,
      matches_json TEXT NOT NULL DEFAULT '[]',
      risks_json TEXT NOT NULL DEFAULT '[]',
      quality_tags_json TEXT NOT NULL DEFAULT '[]',
      greeting TEXT,
      analysis_json TEXT NOT NULL DEFAULT '{}',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      batch_id INTEGER,
      UNIQUE(source, source_id)
    );
    INSERT INTO batches(id, site, keyword, started_at, note, profile_id, search_plan_id, filter_snapshot_json)
      VALUES (1, 'boss', 'RAG', '2026-07-15T00:00:00.000Z', 'legacy', 1, 1, '{}');
    INSERT INTO jobs(
      id, source, source_id, keyword, title, company, location, salary, experience, education,
      url, description, first_seen_at, last_seen_at, batch_id
    ) VALUES (
      1, 'boss', 'legacy-1', 'RAG', 'AI 应用开发', '示例公司', '广州', '10-15K', '1-3年', '本科',
      'https://example.test/job/1', '负责 RAG 应用开发', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', 1
    );
    PRAGMA user_version = 0;
  `);
  db.close();

  db = openDb(legacyPath);
  assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.deepStrictEqual(
    { ...db.prepare("SELECT status, finished_at, stop_code FROM batches WHERE id = 1").get() },
    { status: "completed", finished_at: "2026-07-15T00:00:00.000Z", stop_code: "LEGACY_STATUS_INFERRED" }
  );
  assert.strictEqual(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM jobs").get().n, 1);
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM job_observations").get().n, 1);
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM scan_runs").get().n, 0);
  assert.strictEqual(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  const migration = db.prepare("SELECT version, backup_path FROM schema_migrations ORDER BY version DESC LIMIT 1").get();
  assert.strictEqual(migration.version, SCHEMA_VERSION);
  assert.ok(migration.backup_path && fs.existsSync(migration.backup_path));
  db.close();

  const backupsAfterMigration = fs.readdirSync(backupDir).filter((name) => name.endsWith(".sqlite"));
  assert.strictEqual(backupsAfterMigration.length, backupsAfterProductionV1Migration.length + 1);
  const backup = new DatabaseSync(migration.backup_path, { readOnly: true });
  assert.strictEqual(backup.prepare("PRAGMA user_version").get().user_version, 0);
  assert.strictEqual(backup.prepare("SELECT count(*) AS n FROM jobs").get().n, 1);
  assert.strictEqual(
    backup.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'scan_runs'").get().n,
    0
  );
  assert.strictEqual(backup.prepare("PRAGMA quick_check").get().quick_check, "ok");
  backup.close();

  db = openDb(legacyPath);
  db.close();
  assert.deepStrictEqual(
    fs.readdirSync(backupDir).filter((name) => name.endsWith(".sqlite")),
    backupsAfterMigration,
    "reopening the current schema must not create another backup"
  );

  const rollbackPath = path.join(root, "rollback.sqlite");
  fs.copyFileSync(path.join(backupDir, backupsAfterMigration[0]), rollbackPath);
  db = new DatabaseSync(rollbackPath);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)");
  db.close();
  let migrationError;
  try {
    openDb(rollbackPath);
  } catch (error) {
    migrationError = error;
  }
  assert.strictEqual(migrationError?.code, "DB_MIGRATION_FAILED");
  assert.ok(migrationError.backupPath && fs.existsSync(migrationError.backupPath));
  db = new DatabaseSync(rollbackPath, { readOnly: true });
  assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, 0);
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM pragma_table_info('batches') WHERE name = 'status'").get().n,
    0,
    "failed migration must roll back added columns"
  );
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'scan_runs'").get().n,
    0,
    "failed migration must roll back created tables"
  );
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM jobs").get().n, 1);
  assert.strictEqual(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  db.close();

  const productionV2Path = path.join(root, "production-v2.sqlite");
  db = openDb(productionV2Path);
  const v2Now = "2026-07-20T00:00:00.000Z";
  const v2ProfileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('V2 Candidate', '{}', NULL, ?, ?)`).run(v2Now, v2Now).lastInsertRowid);
  const v2PlanId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'V2 Plan', '{}', NULL, 1, ?, ?)`).run(v2ProfileId, v2Now, v2Now).lastInsertRowid);
  const v2JobId = Number(db.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at
  ) VALUES ('boss', 'v2-preserved-job', 'V2 preserved job', ?, ?)`).run(v2Now, v2Now).lastInsertRowid);
  db.prepare(`INSERT INTO candidate_job_states(
    profile_id, job_id, plan_id, status, reason_code, note, review_at, updated_at
  ) VALUES (?, ?, ?, 'review', 'v2-preserved', '', NULL, ?)`)
    .run(v2ProfileId, v2JobId, v2PlanId, v2Now);
  const v2Counts = {
    jobs: db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count,
    states: db.prepare("SELECT COUNT(*) AS count FROM candidate_job_states").get().count
  };
  db.exec(`
    DROP TABLE workflow_runs;
    DELETE FROM schema_migrations WHERE version IN (3, 4);
    PRAGMA user_version = 2;
  `);
  db.close();
  db = openDb(productionV2Path);
  assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, v2Counts.jobs);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM candidate_job_states").get().count, v2Counts.states);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get().count, 0);
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='idx_workflow_runs_active'").get().count,
    1
  );
  db.close();

  const productionV3Path = path.join(root, "production-v3.sqlite");
  db = openDb(productionV3Path);
  const v3ProfileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('V3 Candidate', '{}', NULL, ?, ?)`).run(v2Now, v2Now).lastInsertRowid);
  const v3PlanId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'V3 Plan', '{}', NULL, 1, ?, ?)`).run(v3ProfileId, v2Now, v2Now).lastInsertRowid);
  db.prepare(`INSERT INTO workflow_runs(
    id, profile_id, plan_id, local_day, sequence, status, target_success_count,
    created_at, updated_at
  ) VALUES ('v3-preserved-workflow', ?, ?, '2026-07-20', 1, 'completed', 35, ?, ?)`)
    .run(v3ProfileId, v3PlanId, v2Now, v2Now);
  const workflowSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get().sql;
  db.exec(`
    DROP INDEX idx_workflow_runs_active;
    DROP INDEX idx_workflow_runs_daily;
    ALTER TABLE workflow_runs RENAME TO workflow_runs_v4;
    ${workflowSql.replace("BETWEEN 1 AND 3", "BETWEEN 1 AND 2")};
    INSERT INTO workflow_runs SELECT * FROM workflow_runs_v4;
    DROP TABLE workflow_runs_v4;
    CREATE INDEX idx_workflow_runs_active ON workflow_runs(profile_id, plan_id, local_day, status, sequence);
    CREATE INDEX idx_workflow_runs_daily ON workflow_runs(profile_id, local_day, sequence);
    DELETE FROM schema_migrations WHERE version = 4;
    PRAGMA user_version = 3;
  `);
  db.close();
  db = openDb(productionV3Path);
  assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.strictEqual(db.prepare("SELECT status FROM workflow_runs WHERE id = 'v3-preserved-workflow'").get().status, "completed");
  assert.match(
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get().sql,
    /sequence BETWEEN 1 AND 3/
  );
  db.prepare(`INSERT INTO workflow_runs(
    id, profile_id, plan_id, local_day, sequence, status, target_success_count,
    created_at, updated_at
  ) VALUES ('v3-new-third-slot', ?, ?, '2026-07-21', 3, 'created', 10, ?, ?)`)
    .run(v3ProfileId, v3PlanId, v2Now, v2Now);
  db.close();

  const historicalOutcomePath = path.join(root, "historical-outcome-v2.sqlite");
  db = openDb(historicalOutcomePath);
  const historyProfileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('History Candidate', '{}', NULL, ?, ?)`).run(v2Now, v2Now).lastInsertRowid);
  const historyPlanId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'History Plan', '{}', NULL, 1, ?, ?)`).run(historyProfileId, v2Now, v2Now).lastInsertRowid);
  const historyJobId = Number(db.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at
  ) VALUES ('boss', 'historical-unavailable', 'Historical unavailable job', ?, ?)`)
    .run(v2Now, v2Now).lastInsertRowid);
  const historyBatchId = Number(db.prepare(`INSERT INTO communication_batches(
    site, profile_id, plan_id, browser_mode, status, policy_json,
    confirmed_at, started_at, finished_at, created_at, updated_at
  ) VALUES ('boss', ?, ?, 'edge', 'completed', '{}', ?, ?, ?, ?, ?)`)
    .run(historyProfileId, historyPlanId, v2Now, v2Now, v2Now, v2Now, v2Now).lastInsertRowid);
  db.prepare(`INSERT INTO communication_batch_items(
    batch_id, job_id, position, job_url, title_snapshot, company_snapshot,
    status, click_count, finished_at, updated_at
  ) VALUES (?, ?, 1, 'https://www.zhipin.com/job_detail/historical-unavailable.html',
    'Historical unavailable job', 'History Company', 'job_unavailable', 0, ?, ?)`)
    .run(historyBatchId, historyJobId, v2Now, v2Now);
  db.exec(`
    DROP TABLE workflow_runs;
    DELETE FROM schema_migrations WHERE version IN (3, 4);
    PRAGMA user_version = 2;
  `);
  db.close();
  db = openDb(historicalOutcomePath);
  assert.strictEqual(
    db.prepare("SELECT status FROM candidate_job_states WHERE profile_id = ? AND job_id = ?")
      .get(historyProfileId, historyJobId).status,
    "invalid"
  );
  db.close();

  const futurePath = path.join(root, "future.sqlite");
  db = openDb(futurePath);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  db.close();
  assert.throws(
    () => openDb(futurePath),
    (error) => error.code === "DB_SCHEMA_NEWER_THAN_APP"
  );

  const progressV5Path = path.join(root, "candidate-progress-v5.sqlite");
  db = openDb(progressV5Path);
  const progressNow = "2026-07-23T08:00:00.000Z";
  const progressProfileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Migration Candidate', '{}', NULL, ?, ?)`).run(progressNow, progressNow).lastInsertRowid);
  const progressPlanId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Migration Plan', '{}', NULL, 1, ?, ?)`).run(progressProfileId, progressNow, progressNow).lastInsertRowid);
  const progressJobId = Number(db.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at
  ) VALUES ('boss', 'migration-v5-job', 'Migration V5 Job', ?, ?)`).run(progressNow, progressNow).lastInsertRowid);
  const progressCardId = Number(db.prepare(`INSERT INTO candidate_progress_cards(
    profile_id, plan_id, job_id, source, stage, next_action,
    last_event_at, created_at, updated_at
  ) VALUES (?, ?, ?, 'boss', 'waiting_reply', '等待招聘方回复', ?, ?, ?)`)
    .run(progressProfileId, progressPlanId, progressJobId, progressNow, progressNow, progressNow).lastInsertRowid);
  const oldEventId = Number(db.prepare(`INSERT INTO candidate_progress_events(
    card_id, idempotency_key, type, actor, summary, metadata_json, occurred_at, created_at
  ) VALUES (?, 'progress:00000000-0000-4000-8000-000000000001',
    'contact_started', 'system', '旧事件', '{}', ?, ?)`)
    .run(progressCardId, progressNow, progressNow).lastInsertRowid);
  db.exec(`
    DROP TRIGGER candidate_progress_events_require_idempotency;
    DROP INDEX idx_candidate_progress_events_idempotency;
    DROP INDEX idx_candidate_progress_events_card;
    ALTER TABLE candidate_progress_events RENAME TO candidate_progress_events_v6;
    CREATE TABLE candidate_progress_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(card_id) REFERENCES candidate_progress_cards(id)
    );
    INSERT INTO candidate_progress_events(
      id, card_id, type, actor, summary, metadata_json, occurred_at, created_at
    )
    SELECT id, card_id, type, actor, summary, metadata_json, occurred_at, created_at
    FROM candidate_progress_events_v6;
    DROP TABLE candidate_progress_events_v6;
    CREATE INDEX idx_candidate_progress_events_card
      ON candidate_progress_events(card_id, occurred_at);
    CREATE TRIGGER fail_progress_v6_update
    BEFORE UPDATE ON candidate_progress_events
    BEGIN SELECT RAISE(ABORT, 'forced v6 migration failure'); END;
    DELETE FROM schema_migrations WHERE version = 6;
    PRAGMA user_version = 5;
  `);
  db.close();
  db = null;
  assert.throws(
    () => openDb(progressV5Path),
    /forced v6 migration failure/
  );
  let rawV5 = new DatabaseSync(progressV5Path);
  assert.strictEqual(rawV5.prepare("PRAGMA user_version").get().user_version, 5);
  assert.strictEqual(
    rawV5.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('candidate_progress_events') WHERE name = 'idempotency_key'").get().count,
    0,
    "failed v6 migration must roll back the added column"
  );
  assert.strictEqual(rawV5.prepare("SELECT COUNT(*) AS count FROM candidate_progress_events").get().count, 1);
  rawV5.exec("DROP TRIGGER fail_progress_v6_update");
  rawV5.close();

  db = openDb(progressV5Path);
  const migratedEvent = db.prepare(`SELECT idempotency_key FROM candidate_progress_events
    WHERE id = ?`).get(oldEventId);
  assert.strictEqual(migratedEvent.idempotency_key, `legacy:event:${oldEventId}`);
  assert.strictEqual(
    db.prepare(`SELECT "unique" AS is_unique FROM pragma_index_list('candidate_progress_events')
      WHERE name = 'idx_candidate_progress_events_idempotency'`).get().is_unique,
    1
  );
  assert.throws(
    () => db.prepare(`INSERT INTO candidate_progress_events(
      card_id, idempotency_key, type, actor, summary, metadata_json, occurred_at, created_at
    ) VALUES (?, ?, 'contact_started', 'system', '重复键', '{}', ?, ?)`)
      .run(progressCardId, migratedEvent.idempotency_key, progressNow, progressNow),
    /UNIQUE/
  );
  db.close();
  rawV5 = new DatabaseSync(progressV5Path);
  rawV5.exec("DELETE FROM schema_migrations WHERE version = 6; PRAGMA user_version = 5;");
  rawV5.close();
  db = openDb(progressV5Path);
  assert.deepStrictEqual(
    { ...db.prepare("SELECT COUNT(*) AS count, MIN(idempotency_key) AS key FROM candidate_progress_events").get() },
    { count: 1, key: `legacy:event:${oldEventId}` },
    "rerunning v6 migration must preserve migrated events and keys"
  );

  console.log("storage_migration_smoke ok");
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
