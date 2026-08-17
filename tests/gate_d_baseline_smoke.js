const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { openDb, SCHEMA_VERSION } = require("../src/core/storage");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "prepare-gate-d-baseline.js");
const TEST_ROOT = fs.mkdtempSync(path.join("D:\\DevData", "RoleFlow-gate-d-baseline-test-"));
const SOURCE_COMMIT = "a".repeat(40);
const WORKTREE_PROTECTED_DB = path.join(ROOT, "data", "jobs.sqlite");

const PRESERVED_TABLES = [
  "schema_migrations",
  "candidate_profiles",
  "resume_documents",
  "candidate_resume_versions",
  "profile_versions",
  "search_plans",
  "candidate_facts",
  "candidate_matching_cards"
];

const OPERATIONAL_TABLES = [
  "onboarding_runs",
  "resume_parse_attempts",
  "keyword_sources",
  "platform_filter_catalogs",
  "model_cache",
  "site_runtime_states",
  "site_scan_leases",
  "job_analysis_attempts",
  "workflow_job_tasks",
  "workflow_runs",
  "candidate_progress_events",
  "candidate_progress_cards",
  "message_preview_states",
  "message_discovery_runtime_states",
  "message_discovery_unresolved_items",
  "communication_batch_items",
  "communication_batches",
  "candidate_job_events",
  "candidate_job_states",
  "applications",
  "events",
  "job_refresh_attempts",
  "job_observations",
  "scan_target_results",
  "scan_runs",
  "batches",
  "jobs"
];

function hash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function count(db, table) {
  return Number(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n);
}

function tableCounts(db, tables) {
  return Object.fromEntries(tables.map((table) => [table, count(db, table)]));
}

function insert(db, sql, ...values) {
  return db.prepare(sql).run(...values);
}

function createFixture(file) {
  const db = openDb(file);
  const now = "2026-08-12T00:00:00.000Z";
  const profileId = Number(insert(db, `INSERT INTO candidate_profiles(display_name, profile_json, source_hash, created_at, updated_at)
    VALUES ('Gate D', '{}', 'profile-hash', ?, ?)`, now, now).lastInsertRowid);
  const resumeId = Number(insert(db, `INSERT INTO resume_documents(profile_id, original_file_name, format, content_hash, resume_text, created_at)
    VALUES (?, 'resume.txt', 'txt', 'resume-hash', 'preserved resume', ?)`, profileId, now).lastInsertRowid);
  const profileVersionId = Number(insert(db, `INSERT INTO profile_versions(profile_id, resume_document_id, profile_json, created_at)
    VALUES (?, ?, '{"version":1}', ?)`, profileId, resumeId, now).lastInsertRowid);
  insert(db, `INSERT INTO candidate_resume_versions(profile_id, resume_document_id, version_key, name, created_at, updated_at)
    VALUES (?, ?, 'v1', 'Preserved resume version', ?, ?)`, profileId, resumeId, now, now);
  const planId = Number(insert(db, `INSERT INTO search_plans(profile_id, name, plan_json, profile_version_id, created_at, updated_at)
    VALUES (?, 'Preserved plan', '{}', ?, ?, ?)`, profileId, profileVersionId, now, now).lastInsertRowid);
  insert(db, `INSERT INTO candidate_facts(profile_id, fact_key, fact_value, created_at, updated_at)
    VALUES (?, 'city', 'Shanghai', ?, ?)`, profileId, now, now);
  insert(db, `INSERT INTO candidate_matching_cards(profile_id, profile_version_id, resume_document_id, resume_content_hash, card_json, status, source, created_at, updated_at)
    VALUES (?, ?, ?, 'resume-hash', '{}', 'confirmed', 'user', ?, ?)`, profileId, profileVersionId, resumeId, now, now);
  insert(db, `INSERT INTO resume_parse_attempts(profile_id, original_file_name, status, created_at)
    VALUES (?, 'resume.txt', 'succeeded', ?)`, profileId, now);
  insert(db, `INSERT INTO keyword_sources(keyword, source, created_at) VALUES ('java', 'scan', ?)`, now);
  insert(db, `INSERT INTO platform_filter_catalogs(site, catalog_json, source, discovered_at, updated_at)
    VALUES ('boss', '{}', 'scan', ?, ?)`, now, now);
  const batchId = Number(insert(db, `INSERT INTO batches(site, keyword, started_at, profile_id, search_plan_id, status)
    VALUES ('boss', 'java', ?, ?, ?, 'completed')`, now, profileId, planId).lastInsertRowid);
  const jobId = Number(insert(db, `INSERT INTO jobs(source, source_id, title, first_seen_at, last_seen_at)
    VALUES ('boss', 'job-1', 'Operational job', ?, ?)`, now, now).lastInsertRowid);
  const observationId = Number(insert(db, `INSERT INTO job_observations(job_id, batch_id, title, content_hash, seen_at)
    VALUES (?, ?, 'Operational job', 'job-hash', ?)`, jobId, batchId, now).lastInsertRowid);
  insert(db, `INSERT INTO applications(job_id, status, updated_at) VALUES (?, 'review', ?)`, jobId, now);
  insert(db, `INSERT INTO events(job_id, event_type, created_at) VALUES (?, 'follow_up', ?)`, jobId, now);
  insert(db, `INSERT INTO candidate_job_states(profile_id, job_id, plan_id, status, updated_at)
    VALUES (?, ?, ?, 'review', ?)`, profileId, jobId, planId, now);
  insert(db, `INSERT INTO candidate_job_events(profile_id, job_id, plan_id, event_type, created_at)
    VALUES (?, ?, ?, 'follow_up', ?)`, profileId, jobId, planId, now);
  insert(db, `INSERT INTO model_cache(cache_key, kind, provider, input_hash, result_json, created_at)
    VALUES ('cache-1', 'analysis', 'test', 'input-hash', '{}', ?)`, now);
  insert(db, `INSERT INTO scan_target_results(batch_id, target_key, status, started_at, finished_at)
    VALUES (?, 'target-1', 'completed', ?, ?)`, batchId, now, now);
  insert(db, `INSERT INTO scan_runs(id, site, plan_id, batch_id, status, created_at)
    VALUES ('scan-1', 'boss', ?, ?, 'completed', ?)`, planId, batchId, now);
  insert(db, `INSERT INTO site_runtime_states(site, status, updated_at) VALUES ('boss', 'ready', ?)`, now);
  insert(db, `INSERT INTO site_scan_leases(site, owner, command, acquired_at, expires_at)
    VALUES ('boss', 'fixture', 'scan', ?, ?)`, now, now);
  insert(db, `INSERT INTO job_refresh_attempts(job_id, result, attempt_number, created_at)
    VALUES (?, 'succeeded', 1, ?)`, jobId, now);
  const communicationBatchId = Number(insert(db, `INSERT INTO communication_batches(site, profile_id, plan_id, browser_mode, status, confirmed_at, created_at, updated_at)
    VALUES ('boss', ?, ?, 'edge', 'completed', ?, ?, ?)`, profileId, planId, now, now, now).lastInsertRowid);
  insert(db, `INSERT INTO communication_batch_items(batch_id, job_id, position, job_url, title_snapshot, status, updated_at)
    VALUES (?, ?, 1, 'https://example.test/job-1', 'Operational job', 'succeeded', ?)`, communicationBatchId, jobId, now);
  insert(db, `INSERT INTO workflow_runs(id, profile_id, plan_id, local_day, sequence, status, target_success_count, scan_run_id, scan_batch_id, communication_batch_id, created_at, updated_at)
    VALUES ('workflow-1', ?, ?, '2026-08-12', 1, 'completed', 1, 'scan-1', ?, ?, ?, ?)`, profileId, planId, batchId, communicationBatchId, now, now);
  const taskId = Number(insert(db, `INSERT INTO workflow_job_tasks(workflow_run_id, batch_id, job_id, observation_id, position, status, created_at, updated_at)
    VALUES ('workflow-1', ?, ?, ?, 1, 'succeeded', ?, ?)`, batchId, jobId, observationId, now, now).lastInsertRowid);
  insert(db, `INSERT INTO job_analysis_attempts(workflow_run_id, task_id, job_id, recovery_generation, attempt_in_generation, total_attempt_number, profile_kind, model_config_revision, provider, model, thinking_mode, reasoning_effort, status, started_at, created_at, updated_at)
    VALUES ('workflow-1', ?, ?, 0, 1, 1, 'batch_screening', 'r1', 'test', 'test', 'off', 'low', 'succeeded', ?, ?, ?)`, taskId, jobId, now, now, now);
  const progressCardId = Number(insert(db, `INSERT INTO candidate_progress_cards(profile_id, plan_id, job_id, source, stage, last_event_at, created_at, updated_at)
    VALUES (?, ?, ?, 'boss', 'applied', ?, ?, ?)`, profileId, planId, jobId, now, now, now).lastInsertRowid);
  insert(db, `INSERT INTO candidate_progress_events(card_id, idempotency_key, type, actor, occurred_at, created_at)
    VALUES (?, 'progress-1', 'created', 'user', ?, ?)`, progressCardId, now, now);
  insert(db, `INSERT INTO message_preview_states(profile_id, platform, conversation_key, preview_digest, preview_kind, observed_at, updated_at)
    VALUES (?, 'boss', 'conversation-1', 'digest', 'text', ?, ?)`, profileId, now, now);
  insert(db, `INSERT INTO message_discovery_runtime_states(platform, pacing_json, updated_at)
    VALUES ('boss', '{"detailActions":1}', ?)`, now);
  insert(db, `INSERT INTO message_discovery_unresolved_items(profile_id, platform, conversation_key, preview_digest, preview_kind, reason_code, first_observed_at, last_observed_at)
    VALUES (?, 'boss', 'conversation-2', 'digest', 'text', 'unknown', ?, ?)`, profileId, now, now);
  const before = { preserved: tableCounts(db, PRESERVED_TABLES), operational: tableCounts(db, OPERATIONAL_TABLES) };
  db.close();
  return before;
}

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
}

function runPrepared(...args) {
  return run("--source-commit", SOURCE_COMMIT, "--protected-db", WORKTREE_PROTECTED_DB, ...args);
}

function expectRejected(result, message) {
  assert.notStrictEqual(result.status, 0, `${message}: ${result.stdout}\n${result.stderr}`);
}

function bundleFile(bundle, name) {
  return bundle.files.find((file) => file.name === name);
}

function assertNoArtifacts(archive, baseline) {
  for (const file of [archive, `${archive}.manifest.json`, baseline, `${baseline}.report.json`, `${baseline}.receipt.json`]) {
    assert.strictEqual(fs.existsSync(file), false, `failed preparation must not publish ${file}`);
  }
  for (const directory of new Set([path.dirname(archive), path.dirname(baseline)])) {
    if (fs.existsSync(directory)) {
      assert.strictEqual(fs.readdirSync(directory).some((name) => name.includes(".partial-")), false, `failed preparation must clean partial files in ${directory}`);
    }
  }
}

try {
  const source = path.join(TEST_ROOT, "source.sqlite");
  const archive = path.join(TEST_ROOT, "archive", "fixture.sqlite");
  const baseline = path.join(TEST_ROOT, "baseline", "fixture.sqlite");
  const before = createFixture(source);
  const sourceHash = hash(source);

  const prepared = runPrepared("--source", source, "--archive", archive, "--baseline", baseline);
  assert.strictEqual(prepared.status, 0, prepared.stderr || prepared.stdout);
  assert.strictEqual(hash(source), sourceHash, "baseline preparation must never modify the source database");
  assert(fs.existsSync(archive), "a complete archive must be created before the baseline clone");
  assert(fs.existsSync(baseline), "a separate baseline clone must be created");
  const archiveManifest = JSON.parse(fs.readFileSync(`${archive}.manifest.json`, "utf8"));
  const report = JSON.parse(fs.readFileSync(`${baseline}.report.json`, "utf8"));
  const receipt = JSON.parse(fs.readFileSync(`${baseline}.receipt.json`, "utf8"));
  assert.strictEqual(archiveManifest.sourcePath, source);
  assert.strictEqual(bundleFile(archiveManifest.sourceBundle.before, "database").sha256, sourceHash);
  assert.deepStrictEqual(archiveManifest.sourceBundle.before, archiveManifest.sourceBundle.after, "source SQLite bundle must stay stable across VACUUM INTO");
  assert.strictEqual(archiveManifest.schemaVersion, SCHEMA_VERSION);
  assert.match(archiveManifest.createdAtUtc, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(archiveManifest.sourceCommit, SOURCE_COMMIT);
  assert.match(archiveManifest.toolCommit, /^[0-9a-f]{40}$/);
  assert.notStrictEqual(archiveManifest.toolCommit, SOURCE_COMMIT, "source commit must not be inferred from the tool worktree HEAD");
  assert.strictEqual(archiveManifest.archiveSnapshot.size, fs.statSync(archive).size);
  assert.strictEqual(archiveManifest.archiveSnapshot.sha256, hash(archive));
  assert.match(archiveManifest.archiveSnapshot.note, /not a byte-for-byte source bundle copy/);
  assert.strictEqual(receipt.complete, true);
  assert.strictEqual(receipt.archiveSha256, hash(archive));
  assert.deepStrictEqual(report.preserved.before, before.preserved);
  assert.deepStrictEqual(report.preserved.after, before.preserved);
  assert.deepStrictEqual(report.operational.before, before.operational);
  assert.deepStrictEqual(report.operational.after, Object.fromEntries(OPERATIONAL_TABLES.map((table) => [table, 0])));
  assert.strictEqual(report.checks.foreignKeyCheck, "ok");
  assert.strictEqual(report.checks.quickCheck, "ok");

  const archiveDb = new DatabaseSync(archive, { readOnly: true });
  assert.deepStrictEqual(tableCounts(archiveDb, PRESERVED_TABLES), before.preserved);
  assert.deepStrictEqual(tableCounts(archiveDb, OPERATIONAL_TABLES), before.operational);
  assert.strictEqual(archiveDb.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.strictEqual(archiveDb.prepare("PRAGMA quick_check").get().quick_check, "ok");
  archiveDb.close();

  const clone = new DatabaseSync(baseline, { readOnly: true });
  assert.deepStrictEqual(tableCounts(clone, PRESERVED_TABLES), before.preserved);
  assert.deepStrictEqual(tableCounts(clone, OPERATIONAL_TABLES), Object.fromEntries(OPERATIONAL_TABLES.map((table) => [table, 0])));
  assert.strictEqual(clone.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.strictEqual(clone.prepare("PRAGMA quick_check").get().quick_check, "ok");
  clone.close();

  expectRejected(run("--source", source, "--archive", path.join(TEST_ROOT, "archive", "missing-commit.sqlite"), "--baseline", path.join(TEST_ROOT, "baseline", "missing-commit.sqlite")), "source commit must be explicit");
  expectRejected(runPrepared("--source", source, "--archive", source.toUpperCase(), "--baseline", path.join(TEST_ROOT, "baseline", "same-source.sqlite")), "case-insensitive archive alias equal to source must be rejected");
  expectRejected(runPrepared("--source", source, "--archive", path.join(TEST_ROOT, "archive", "same-source.sqlite"), "--baseline", source), "baseline destination equal to source must be rejected");
  expectRejected(runPrepared("--source", source, "--archive", path.join(TEST_ROOT, "archive", "protected.sqlite"), "--baseline", WORKTREE_PROTECTED_DB), "worktree production data/jobs.sqlite must be rejected as a target");
  const explicitProtected = path.join(TEST_ROOT, "protected-main.sqlite");
  expectRejected(run("--source-commit", SOURCE_COMMIT, "--protected-db", explicitProtected, "--source", source, "--archive", path.join(TEST_ROOT, "archive", "explicit-protected.sqlite"), "--baseline", explicitProtected), "explicit protected database must be rejected as a target");
  expectRejected(runPrepared("--source", source, "--archive", archive, "--baseline", baseline), "existing artifacts must not be overwritten by default");

  const unknownTable = path.join(TEST_ROOT, "unknown-table.sqlite");
  createFixture(unknownTable);
  const unknownDb = new DatabaseSync(unknownTable);
  unknownDb.exec("CREATE TABLE unexpected_operational_history (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO unexpected_operational_history(value) VALUES ('must fail closed');");
  unknownDb.close();
  expectRejected(runPrepared("--source", unknownTable, "--archive", path.join(TEST_ROOT, "archive", "unknown-table.sqlite"), "--baseline", path.join(TEST_ROOT, "baseline", "unknown-table.sqlite")), "unknown populated tables must fail closed");

  const futureSchema = path.join(TEST_ROOT, "future-schema.sqlite");
  createFixture(futureSchema);
  const futureDb = new DatabaseSync(futureSchema);
  futureDb.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  futureDb.close();
  expectRejected(runPrepared("--source", futureSchema, "--archive", path.join(TEST_ROOT, "archive", "future-schema.sqlite"), "--baseline", path.join(TEST_ROOT, "baseline", "future-schema.sqlite")), "unknown schema versions must fail closed");

  const emptyPreserved = path.join(TEST_ROOT, "empty-preserved.sqlite");
  openDb(emptyPreserved).close();
  const emptyArchive = path.join(TEST_ROOT, "archive", "empty-preserved.sqlite");
  const emptyBaseline = path.join(TEST_ROOT, "baseline", "empty-preserved.sqlite");
  expectRejected(runPrepared("--source", emptyPreserved, "--archive", emptyArchive, "--baseline", emptyBaseline), "empty candidate/profile preservation set must fail closed");
  assertNoArtifacts(emptyArchive, emptyBaseline);

  const junction = path.join(TEST_ROOT, "junction-alias");
  try {
    fs.symlinkSync(TEST_ROOT, junction, "junction");
    const aliasProtected = path.join(junction, "junction-protected.sqlite");
    expectRejected(run("--source-commit", SOURCE_COMMIT, "--protected-db", aliasProtected, "--source", source, "--archive", path.join(TEST_ROOT, "archive", "junction.sqlite"), "--baseline", path.join(TEST_ROOT, "junction-protected.sqlite")), "junction aliases must protect the same target");
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) throw error;
    console.log(`gate_d_baseline_smoke junction check skipped: ${error.code}`);
  }

  const { prepare } = require(SCRIPT);
  const faultSource = path.join(TEST_ROOT, "fault.sqlite");
  createFixture(faultSource);
  const faultArchive = path.join(TEST_ROOT, "archive", "fault.sqlite");
  const faultBaseline = path.join(TEST_ROOT, "baseline", "fault.sqlite");
  assert.throws(
    () => prepare({ source: faultSource, sourceCommit: SOURCE_COMMIT, archive: faultArchive, baseline: faultBaseline, protectedDbs: [WORKTREE_PROTECTED_DB] }, { afterArchiveSnapshot() { throw new Error("injected failure"); } }),
    /injected failure/
  );
  assertNoArtifacts(faultArchive, faultBaseline);

  const changingSource = path.join(TEST_ROOT, "changing.sqlite");
  createFixture(changingSource);
  const changingArchive = path.join(TEST_ROOT, "archive", "changing.sqlite");
  const changingBaseline = path.join(TEST_ROOT, "baseline", "changing.sqlite");
  assert.throws(
    () => prepare({ source: changingSource, sourceCommit: SOURCE_COMMIT, archive: changingArchive, baseline: changingBaseline, protectedDbs: [WORKTREE_PROTECTED_DB] }, {
      beforeSourceAfterFingerprint() {
        const db = new DatabaseSync(changingSource);
        db.prepare("INSERT INTO candidate_facts(profile_id, fact_key, fact_value, created_at, updated_at) VALUES (1, 'changed', 'yes', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')").run();
        db.close();
      }
    }),
    /source SQLite bundle changed/
  );
  assertNoArtifacts(changingArchive, changingBaseline);

  const receiptUnlinkSource = path.join(TEST_ROOT, "receipt-unlink.sqlite");
  createFixture(receiptUnlinkSource);
  const receiptUnlinkArchive = path.join(TEST_ROOT, "archive", "receipt-unlink.sqlite");
  const receiptUnlinkBaseline = path.join(TEST_ROOT, "baseline", "receipt-unlink.sqlite");
  assert.throws(
    () => prepare({ source: receiptUnlinkSource, sourceCommit: SOURCE_COMMIT, archive: receiptUnlinkArchive, baseline: receiptUnlinkBaseline, protectedDbs: [WORKTREE_PROTECTED_DB] }, {
      unlinkPartial(partial, finalPath) {
        if (finalPath.endsWith(".receipt.json")) throw new Error("injected receipt partial unlink failure");
        fs.unlinkSync(partial);
      }
    }),
    /injected receipt partial unlink failure/
  );
  assertNoArtifacts(receiptUnlinkArchive, receiptUnlinkBaseline);

  console.log("gate_d_baseline_smoke ok");
} finally {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
}
