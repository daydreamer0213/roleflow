const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { openDb, SCHEMA_VERSION } = require("../src/core/storage");
const MATCHING_CARD_VERSION = 5;
const DURABLE_WORKFLOW_VERSION = 6;
const CANDIDATE_PROGRESS_VERSION = 7;
const CANDIDATE_PROGRESS_IDEMPOTENCY_VERSION = 8;
const MESSAGE_PREVIEW_VERSION = 9;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-migration-"));
let db;

try {
  const freshPath = path.join(root, "fresh.sqlite");
  db = openDb(freshPath);
  assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  const freshMigrations = db.prepare("SELECT version, name, backup_path FROM schema_migrations").all().map((row) => ({ ...row }));
  assert.deepStrictEqual(
    freshMigrations,
    [
      { version: 1, name: "stable_scan_runtime", backup_path: null },
      { version: 2, name: "communication_batches_v1", backup_path: null },
      { version: 3, name: "workflow_runs_v1", backup_path: null },
      { version: 4, name: "workflow_runs_three_slots", backup_path: null },
      { version: MATCHING_CARD_VERSION, name: "candidate_matching_cards_v1", backup_path: null },
      { version: DURABLE_WORKFLOW_VERSION, name: "durable_workflow_progress_v1", backup_path: null },
      { version: CANDIDATE_PROGRESS_VERSION, name: "candidate_progress_v1", backup_path: null },
      { version: CANDIDATE_PROGRESS_IDEMPOTENCY_VERSION, name: "candidate_progress_event_idempotency", backup_path: null },
      { version: MESSAGE_PREVIEW_VERSION, name: "message_preview_states_v1", backup_path: null }
    ]
  );
  assert.strictEqual(freshMigrations[freshMigrations.length - 1].name, "message_preview_states_v1");
  assert.strictEqual(freshMigrations[freshMigrations.length - 1].version, SCHEMA_VERSION);
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
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='candidate_matching_cards'").get().n,
    1
  );
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='workflow_job_tasks'").get().n,
    1
  );
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='job_analysis_attempts'").get().n,
    1
  );
  assert.strictEqual(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_workflow_job_tasks_claim'").get().n,
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
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='message_preview_states'").get().n,
    1
  );
  assert(SCHEMA_VERSION >= 3);
  assert.strictEqual(SCHEMA_VERSION, MESSAGE_PREVIEW_VERSION);
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
      { version: MATCHING_CARD_VERSION, name: "candidate_matching_cards_v1" },
      { version: DURABLE_WORKFLOW_VERSION, name: "durable_workflow_progress_v1" },
      { version: CANDIDATE_PROGRESS_VERSION, name: "candidate_progress_v1" },
      { version: CANDIDATE_PROGRESS_IDEMPOTENCY_VERSION, name: "candidate_progress_event_idempotency" },
      { version: MESSAGE_PREVIEW_VERSION, name: "message_preview_states_v1" }
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
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='candidate_matching_cards'").get().n,
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
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='message_preview_states'").get().n,
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

  const v4LegacyPath = path.join(root, "production-v4-legacy.sqlite");
  db = openDb(v4LegacyPath);
  const v4Now = "2026-07-21T00:00:00.000Z";
  const v4Profile = {
    candidate: { name: "V4 Candidate", targetTitles: ["电商运营"] },
    skills: ["活动复盘", "ROI 分析"],
    projects: [{ name: "店铺活动复盘", tags: ["ROI"], pitch: "负责店铺活动复盘和投放 ROI 优化" }]
  };
  const v4ProfileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('V4 Candidate', ?, 'v4-resume-hash', ?, ?)`).run(JSON.stringify(v4Profile), v4Now, v4Now).lastInsertRowid);
  const v4DocumentId = Number(db.prepare(`INSERT INTO resume_documents(
    profile_id, original_file_name, format, content_hash, resume_text, text_truncated, diagnostics_json, created_at
  ) VALUES (?, 'resume.txt', 'text', 'v4-resume-hash', '脱敏简历文本', 0, '{}', ?)`).run(v4ProfileId, v4Now).lastInsertRowid);
  const v4VersionId = Number(db.prepare(`INSERT INTO profile_versions(
    profile_id, resume_document_id, profile_json, created_at
  ) VALUES (?, ?, ?, ?)`).run(v4ProfileId, v4DocumentId, JSON.stringify(v4Profile), v4Now).lastInsertRowid);
  db.exec(`
    DROP TABLE candidate_matching_cards;
    DELETE FROM schema_migrations WHERE version = ${MATCHING_CARD_VERSION};
    PRAGMA user_version = ${MATCHING_CARD_VERSION - 1};
  `);
  db.close();
  db = openDb(v4LegacyPath);
  assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM candidate_profiles").get().n, 1);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM profile_versions").get().n, 1);
  const migrationCards = db.prepare("SELECT * FROM candidate_matching_cards WHERE profile_id = ?").all(v4ProfileId);
  assert.strictEqual(migrationCards.length, 1, "无卡候选人升级后必须补出一张迁移草稿卡");
  assert.strictEqual(migrationCards[0].status, "draft");
  assert.strictEqual(migrationCards[0].source, "migration");
  assert.strictEqual(migrationCards[0].resume_content_hash, "v4-resume-hash");
  assert.strictEqual(Number(migrationCards[0].profile_version_id), v4VersionId);
  assert.strictEqual(Number(migrationCards[0].resume_document_id), v4DocumentId);
  const migrationCard = JSON.parse(migrationCards[0].card_json);
  assert.deepStrictEqual(migrationCard.targetDirections, ["电商运营"]);
  assert(migrationCard.strongEvidence.length >= 1, "迁移卡必须摘录既有画像证据，不得为空卡");
  assert.strictEqual(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  db.close();

  const v4MixedPath = path.join(root, "production-v4-mixed.sqlite");
  db = openDb(v4MixedPath);
  const noCardProfileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('No Card', ?, 'hash-no-card', ?, ?)`).run(JSON.stringify(v4Profile), v4Now, v4Now).lastInsertRowid);
  db.prepare(`INSERT INTO profile_versions(profile_id, resume_document_id, profile_json, created_at)
    VALUES (?, NULL, ?, ?)`).run(noCardProfileId, JSON.stringify(v4Profile), v4Now);
  const hasCardProfileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Has Card', ?, 'hash-has-card', ?, ?)`).run(JSON.stringify(v4Profile), v4Now, v4Now).lastInsertRowid);
  const hasCardVersionId = Number(db.prepare(`INSERT INTO profile_versions(
    profile_id, resume_document_id, profile_json, created_at
  ) VALUES (?, NULL, ?, ?)`).run(hasCardProfileId, JSON.stringify(v4Profile), v4Now).lastInsertRowid);
  db.prepare(`INSERT INTO candidate_matching_cards(
    profile_id, profile_version_id, resume_document_id, resume_content_hash,
    card_json, status, source, confirmed_at, created_at, updated_at
  ) VALUES (?, ?, NULL, 'hash-has-card', ?, 'draft', 'model', NULL, ?, ?)`)
    .run(hasCardProfileId, hasCardVersionId, JSON.stringify({ targetDirections: ["用户运营"], strongEvidence: [], transferableCapabilities: [], cautionTransitions: [], userNotes: [], source: "model" }), v4Now, v4Now);
  db.exec(`
    DELETE FROM schema_migrations WHERE version = ${MATCHING_CARD_VERSION};
    PRAGMA user_version = ${MATCHING_CARD_VERSION - 1};
  `);
  db.close();
  db = openDb(v4MixedPath);
  assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  const backfilled = db.prepare("SELECT * FROM candidate_matching_cards WHERE profile_id = ?").all(noCardProfileId);
  assert.strictEqual(backfilled.length, 1);
  assert.strictEqual(backfilled[0].source, "migration");
  assert.strictEqual(backfilled[0].resume_content_hash, "hash-no-card");
  const kept = db.prepare("SELECT * FROM candidate_matching_cards WHERE profile_id = ?").all(hasCardProfileId);
  assert.strictEqual(kept.length, 1, "已有卡的候选人不得重复补卡");
  assert.strictEqual(kept[0].source, "model");
  assert.deepStrictEqual(JSON.parse(kept[0].card_json).targetDirections, ["用户运营"]);
  assert.strictEqual(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  db.close();

  const progressV6Path = path.join(root, "candidate-progress-v6.sqlite");
  db = openDb(progressV6Path);
  const progressNow = "2026-07-23T00:00:00.000Z";
  const progressProfileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Progress Migration Candidate', '{}', NULL, ?, ?)`)
    .run(progressNow, progressNow).lastInsertRowid);
  const progressPlanId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Progress Migration Plan', '{}', NULL, 1, ?, ?)`)
    .run(progressProfileId, progressNow, progressNow).lastInsertRowid);
  const progressJobs = [
    { sourceId: "historical-communication-succeeded", status: "applied", reasonCode: "communication_succeeded" },
    { sourceId: "historical-v3-succeeded", status: "applied", reasonCode: "succeeded" },
    { sourceId: "historical-already-communicated", status: "later", reasonCode: "already_communicated" }
  ].map((item) => ({
    ...item,
    jobId: Number(db.prepare(`INSERT INTO jobs(
      source, source_id, title, first_seen_at, last_seen_at
    ) VALUES ('boss', ?, ?, ?, ?)`)
      .run(item.sourceId, item.sourceId, progressNow, progressNow).lastInsertRowid)
  }));
  for (const item of progressJobs) {
    db.prepare(`INSERT INTO candidate_job_states(
      profile_id, job_id, plan_id, status, reason_code, note, review_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'historical state', NULL, ?)`)
      .run(progressProfileId, item.jobId, progressPlanId, item.status, item.reasonCode, progressNow);
  }
  db.exec(`
    DROP TABLE candidate_progress_events;
    DROP TABLE candidate_progress_cards;
    DROP TABLE message_preview_states;
    DELETE FROM schema_migrations WHERE version IN (7, 8, 9);
    PRAGMA user_version = 6;
  `);
  db.close();
  db = openDb(progressV6Path);
  assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  const progressCards = db.prepare(`SELECT cards.job_id, cards.stage, events.type, events.idempotency_key
    FROM candidate_progress_cards cards
    JOIN candidate_progress_events events ON events.card_id = cards.id
    WHERE cards.profile_id = ?
    ORDER BY cards.job_id`).all(progressProfileId);
  assert.deepStrictEqual(
    progressCards.map((row) => ({
      jobId: Number(row.job_id),
      stage: row.stage,
      type: row.type,
      idempotencyKey: row.idempotency_key
    })),
    progressJobs.map((item) => ({
      jobId: item.jobId,
      stage: "waiting_reply",
      type: item.reasonCode === "already_communicated" ? "contact_already_exists" : "contact_started",
      idempotencyKey: `migration:communication:${progressProfileId}:${item.jobId}:${item.reasonCode}`
    }))
  );
  assert.deepStrictEqual(
    db.prepare(`SELECT job_id, status, reason_code FROM candidate_job_states
      WHERE profile_id = ? ORDER BY job_id`).all(progressProfileId).map((row) => ({
        jobId: Number(row.job_id),
        status: row.status,
        reasonCode: row.reason_code
      })),
    progressJobs.map((item) => ({
      jobId: item.jobId,
      status: item.status,
      reasonCode: item.reasonCode
    })),
    "candidate progress migration must not rewrite historical application status"
  );
  db.close();
  db = openDb(progressV6Path);
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM candidate_progress_cards WHERE profile_id = ?").get(progressProfileId).n,
    progressJobs.length,
    "candidate progress backfill must be idempotent"
  );
  assert.strictEqual(
    db.prepare(`SELECT COUNT(*) AS n FROM candidate_progress_events
      WHERE card_id IN (SELECT id FROM candidate_progress_cards WHERE profile_id = ?)`).get(progressProfileId).n,
    progressJobs.length,
    "candidate progress events must not duplicate after reopen"
  );
  db.close();

  const durableV5Path = path.join(root, "durable-v5.sqlite");
  db = openDb(durableV5Path);
  const v5Now = "2026-07-25T00:00:00.000Z";
  const v5ProfileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Durable Candidate', '{}', 'durable-hash', ?, ?)`).run(v5Now, v5Now).lastInsertRowid);
  const v5PlanId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Durable Plan', '{}', NULL, 1, ?, ?)`).run(v5ProfileId, v5Now, v5Now).lastInsertRowid);
  const v5BatchId = Number(db.prepare(`INSERT INTO batches(
    site, keyword, started_at, note, profile_id, search_plan_id, filter_snapshot_json, status
  ) VALUES ('boss', 'RAG', ?, 'durable v5', ?, ?, '{}', 'completed')`).run(v5Now, v5ProfileId, v5PlanId).lastInsertRowid);
  const v5JobRows = [
    { sourceId: "durable-succeeded", title: "Durable Succeeded", analysis: { semanticStatus: "complete", decisionSource: "model", recommendation: "apply" } },
    { sourceId: "durable-skipped", title: "Durable Skipped", analysis: { semanticStatus: "rule_only", decisionSource: "local_rules" } },
    { sourceId: "durable-pending", title: "Durable Pending", analysis: { semanticStatus: "pending", decisionSource: "analysis_pending" } }
  ];
  const v5JobIds = v5JobRows.map((row) => Number(db.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at, batch_id
  ) VALUES ('boss', ?, ?, ?, ?, ?)`).run(row.sourceId, row.title, v5Now, v5Now, v5BatchId).lastInsertRowid));
  v5JobRows.forEach((row, index) => {
    db.prepare(`INSERT INTO job_observations(
      job_id, batch_id, title, description, analysis_json, content_hash, content_hash_version, seen_at
    ) VALUES (?, ?, ?, 'JD text', ?, 'durable-hash', 1, ?)`)
      .run(v5JobIds[index], v5BatchId, row.title, JSON.stringify(row.analysis), v5Now);
  });
  const v5WorkflowAnalyzingId = "durable-v5-analyzing";
  db.prepare(`INSERT INTO workflow_runs(
    id, profile_id, plan_id, local_day, sequence, status, target_success_count,
    scan_needed, keywords_json, budget_json, planner_json, metrics_json,
    scan_batch_id, created_at, updated_at
  ) VALUES (?, ?, ?, '2026-07-25', 1, 'analyzing', 35, 1, '[]', '{}', '{}', '{}', ?, ?, ?)`)
    .run(v5WorkflowAnalyzingId, v5ProfileId, v5PlanId, v5BatchId, v5Now, v5Now);
  db.prepare(`INSERT INTO workflow_runs(
    id, profile_id, plan_id, local_day, sequence, status, target_success_count,
    scan_needed, keywords_json, budget_json, planner_json, metrics_json,
    created_at, updated_at
  ) VALUES ('durable-v5-completed', ?, ?, '2026-07-25', 2, 'completed', 35, 0, '[]', '{}', '{}', '{}', ?, ?)`)
    .run(v5ProfileId, v5PlanId, v5Now, v5Now);
  db.prepare(`INSERT INTO model_cache(cache_key, kind, provider, model, input_hash, result_json, created_at)
    VALUES ('durable-cache-key', 'matchJob', 'deepseek', 'deepseek-v4-flash', 'hash', '{}', ?)`).run(v5Now);
  const v5CommBatchId = Number(db.prepare(`INSERT INTO communication_batches(
    site, profile_id, plan_id, browser_mode, status, policy_json,
    confirmed_at, created_at, updated_at
  ) VALUES ('boss', ?, ?, 'portable', 'completed', '{}', ?, ?, ?)`)
    .run(v5ProfileId, v5PlanId, v5Now, v5Now, v5Now).lastInsertRowid);
  db.prepare(`INSERT INTO communication_batch_items(
    batch_id, job_id, position, job_url, title_snapshot, company_snapshot,
    status, click_count, finished_at, updated_at
  ) VALUES (?, ?, 1, 'https://www.zhipin.com/job_detail/durable-v5.html',
    'Durable Succeeded', 'Durable Co', 'succeeded', 1, ?, ?)`)
    .run(v5CommBatchId, v5JobIds[0], v5Now, v5Now);
  const v5WorkflowSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get().sql;
  db.exec(`
    DROP TABLE job_analysis_attempts;
    DROP TABLE workflow_job_tasks;
    DROP INDEX idx_workflow_runs_active;
    DROP INDEX idx_workflow_runs_daily;
    ALTER TABLE workflow_runs RENAME TO workflow_runs_v6;
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      profile_id INTEGER NOT NULL,
      plan_id INTEGER NOT NULL,
      local_day TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 3),
      status TEXT NOT NULL CHECK(status IN ('created','scanning','analyzing','review_required','communicating','completed','interrupted','failed','stopped')),
      target_success_count INTEGER NOT NULL CHECK(target_success_count >= 0),
      successful_count INTEGER NOT NULL DEFAULT 0 CHECK(successful_count >= 0),
      inventory_count INTEGER NOT NULL DEFAULT 0 CHECK(inventory_count >= 0),
      candidate_gap INTEGER NOT NULL DEFAULT 0 CHECK(candidate_gap >= 0),
      scan_needed INTEGER NOT NULL DEFAULT 1 CHECK(scan_needed IN (0, 1)),
      keywords_json TEXT NOT NULL DEFAULT '[]',
      budget_json TEXT NOT NULL DEFAULT '{}',
      planner_json TEXT NOT NULL DEFAULT '{}',
      metrics_json TEXT NOT NULL DEFAULT '{}',
      scan_run_id TEXT,
      scan_batch_id INTEGER,
      communication_batch_id INTEGER,
      shortfall_code TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      review_ready_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(profile_id, local_day, sequence)
    );
    INSERT INTO workflow_runs(
      id, profile_id, plan_id, local_day, sequence, status,
      target_success_count, successful_count, inventory_count, candidate_gap, scan_needed,
      keywords_json, budget_json, planner_json, metrics_json,
      scan_run_id, scan_batch_id, communication_batch_id,
      shortfall_code, error_code, error_message,
      created_at, started_at, review_ready_at, finished_at, updated_at
    )
    SELECT
      id, profile_id, plan_id, local_day, sequence, status,
      target_success_count, successful_count, inventory_count, candidate_gap, scan_needed,
      keywords_json, budget_json, planner_json, metrics_json,
      scan_run_id, scan_batch_id, communication_batch_id,
      shortfall_code, error_code, error_message,
      created_at, started_at, review_ready_at, finished_at, updated_at
    FROM workflow_runs_v6;
    DROP TABLE workflow_runs_v6;
    DELETE FROM schema_migrations WHERE version = 6;
    PRAGMA user_version = 5;
  `);
  db.close();

  const durableBackupDir = path.join(path.dirname(durableV5Path), "backups");
  const durableBackupsBefore = fs.readdirSync(durableBackupDir).filter((name) => name.endsWith(".sqlite"));
  db = openDb(durableV5Path);
  assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM candidate_profiles").get().n, 1);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 3);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM job_observations").get().n, 3);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM model_cache").get().n, 1);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM communication_batches").get().n, 1);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM communication_batch_items").get().n, 1);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get().n, 2);
  const analyzing = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(v5WorkflowAnalyzingId);
  assert.strictEqual(analyzing.control_state, "none");
  assert.strictEqual(Number(analyzing.recovery_generation), 0);
  assert.strictEqual(Number(analyzing.progress_revision), 0);
  assert.strictEqual(Number(analyzing.circuit_timeout_job_count), 0);
  assert.strictEqual(Number(analyzing.lifetime_timeout_job_count), 0);
  assert.strictEqual(analyzing.model_config_revision, null);
  const durableBackfilled = db.prepare(`
    SELECT o.analysis_json AS analysis_json, t.status AS task_status
    FROM workflow_job_tasks t
    JOIN job_observations o ON o.id = t.observation_id
    WHERE t.workflow_run_id = ?
    ORDER BY t.position
  `).all(v5WorkflowAnalyzingId);
  assert.strictEqual(durableBackfilled.length, 3);
  assert.deepStrictEqual(durableBackfilled.map((row) => row.task_status), ["succeeded", "skipped", "pending"]);
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM job_analysis_attempts").get().n,
    0,
    "历史结果不得伪造 job_analysis_attempts"
  );
  assert.strictEqual(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  db.prepare("UPDATE workflow_runs SET status = 'paused' WHERE id = ?").run(v5WorkflowAnalyzingId);
  assert.strictEqual(
    db.prepare("SELECT status FROM workflow_runs WHERE id = ?").get(v5WorkflowAnalyzingId).status,
    "paused"
  );
  assert.throws(
    () => db.prepare(`INSERT INTO workflow_job_tasks(
      workflow_run_id, batch_id, job_id, observation_id, position, status,
      recovery_generation, attempt_count_in_generation, total_attempt_count,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 4, 'pending', 0, 3, 0, ?, ?)`)
      .run(v5WorkflowAnalyzingId, v5BatchId, v5JobIds[0], db.prepare("SELECT id FROM job_observations WHERE job_id = ?").get(v5JobIds[0]).id, v5Now, v5Now),
    /CHECK/
  );
  assert.throws(
    () => db.prepare(`INSERT INTO workflow_job_tasks(
      workflow_run_id, batch_id, job_id, observation_id, position, status,
      recovery_generation, attempt_count_in_generation, total_attempt_count,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 5, 'pending', 0, 1, 0, ?, ?)`)
      .run(v5WorkflowAnalyzingId, v5BatchId, v5JobIds[0], db.prepare("SELECT id FROM job_observations WHERE job_id = ?").get(v5JobIds[0]).id, v5Now, v5Now),
    /UNIQUE/
  );
  db.close();
  const durableBackups = fs.readdirSync(durableBackupDir).filter((name) => name.endsWith(".sqlite"));
  assert.strictEqual(durableBackups.length, durableBackupsBefore.length + 1, "v5→v6 迁移必须产生一个备份");
  db = openDb(durableV5Path);
  db.close();
  assert.deepStrictEqual(
    fs.readdirSync(durableBackupDir).filter((name) => name.endsWith(".sqlite")),
    durableBackups,
    "重新打开 v6 不得创建第二个备份"
  );

  const durableRollbackPath = path.join(root, "durable-rollback.sqlite");
  const durableV5Backup = durableBackups.find((name) => !durableBackupsBefore.includes(name));
  assert.ok(durableV5Backup, "v5→v6 迁移后必须产生新的 v5 备份");
  fs.copyFileSync(path.join(durableBackupDir, durableV5Backup), durableRollbackPath);
  db = new DatabaseSync(durableRollbackPath);
  db.exec(`
    DROP TABLE schema_migrations;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
  `);
  db.close();
  let durableMigrationError;
  try {
    openDb(durableRollbackPath);
  } catch (error) {
    durableMigrationError = error;
  }
  assert.strictEqual(durableMigrationError?.code, "DB_MIGRATION_FAILED");
  db = new DatabaseSync(durableRollbackPath, { readOnly: true });
  assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, 5);
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='workflow_job_tasks'").get().n,
    0,
    "v6 迁移失败必须回滚新表"
  );
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 3);
  db.close();

  const futurePath = path.join(root, "future.sqlite");
  db = openDb(futurePath);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  db.close();
  assert.throws(
    () => openDb(futurePath),
    (error) => error.code === "DB_SCHEMA_NEWER_THAN_APP"
  );

  console.log("storage_migration_smoke ok");
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
