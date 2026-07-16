const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  SCAN_RUN_STATUSES,
  openDb,
  createBatch,
  getBatch,
  createScanRun,
  getScanRun,
  beginScanRun,
  heartbeatScanRun,
  finishScanRun,
  recordScanRunProcessExit,
  interruptOrphanedScanRuns,
  checkpointScanTarget,
  listScanTargetResults,
  listLatestScanTargetResults,
  summarizeScanTargets,
  acquireSiteScanLease,
  releaseSiteScanLease,
  upsertJob,
  reassessBatchObservations
} = require("../src/core/storage");

const smokeDir = path.join(__dirname, "..", ".runtime", "smoke");
const dbPath = path.join(smokeDir, `scan-recovery-${Date.now()}.sqlite`);
let db;

(async () => {
  fs.mkdirSync(smokeDir, { recursive: true });
  db = openDb(dbPath);
  assert.strictEqual(Object.values(db.prepare("PRAGMA busy_timeout").get())[0], 5000);
  assert.deepStrictEqual(SCAN_RUN_STATUSES, ["running", "completed", "partial", "failed", "interrupted"]);
  assert.deepStrictEqual(
    db.prepare("PRAGMA table_info(batches)").all().map((column) => column.name).filter((name) => ["status", "finished_at", "stop_code", "stop_message"].includes(name)),
    ["status", "finished_at", "stop_code", "stop_message"]
  );
  assert.throws(() => db.prepare(`INSERT INTO scan_runs(id, site, command, status, created_at)
    VALUES ('invalid-status', 'boss', 'scan', 'queued', ?)`)
    .run(new Date().toISOString()), /CHECK constraint failed/);
  const statusBatch = createBatch(db, "boss", "status-check", "status-check");
  assert.throws(() => db.prepare("UPDATE batches SET status = 'queued' WHERE id = ?").run(statusBatch), /CHECK constraint failed/);

  const { profileId, planId, otherPlanId } = seedPlans(db);
  const owner = "scan-recovery-owner";
  acquireSiteScanLease(db, { site: "boss", owner, planId, ttlMs: 10 * 60 * 1000 });

  observationFailureRollsBack(db, { profileId, planId, owner });
  targetFailureRollsBack(db, { profileId, planId, owner });
  lifecycleAndIdempotency(db, { profileId, planId, owner });
  processExitAndOrphanRecovery(db, { profileId, planId, owner });
  await wrongPlanReassessmentIsRejected(db, { profileId, planId, otherPlanId });

  releaseSiteScanLease(db, { site: "boss", owner });
  console.log("scan_recovery_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  if (db) db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* no-op */ }
  }
});

function seedPlans(database) {
  const now = new Date().toISOString();
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Recovery Candidate', '{}', NULL, ?, ?)`)
    .run(now, now).lastInsertRowid);
  const insertPlan = database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, ?, '{}', NULL, 1, ?, ?)`);
  const planId = Number(insertPlan.run(profileId, "Recovery Plan", now, now).lastInsertRowid);
  const otherPlanId = Number(insertPlan.run(profileId, "Other Plan", now, now).lastInsertRowid);
  return { profileId, planId, otherPlanId };
}

function startRun(database, { label, profileId, planId, owner }) {
  const batchId = createBatch(database, "boss", label, `scan-recovery:${label}`, {
    profileId,
    searchPlanId: planId,
    filterSnapshot: { label }
  });
  const created = createScanRun(database, { runId: `run-${label}`, site: "boss", command: "scan", planId });
  const batch = getBatch(database, batchId);
  assert.strictEqual(batch.searchPlanId, planId);
  assert.deepStrictEqual(batch.filterSnapshot, { label });
  assert.strictEqual(getScanRun(database, created.id).status, "running");
  const run = beginScanRun(database, { runId: created.id, batchId, leaseOwner: owner, processId: process.pid });
  assert.strictEqual(run.batchId, batchId);
  assert.strictEqual(run.leaseOwner, owner);
  return { runId: run.id, batchId };
}

function observationFailureRollsBack(database, context) {
  const { runId, batchId } = startRun(database, { ...context, label: "observation-failure" });
  database.exec(`CREATE TEMP TRIGGER inject_observation_failure
    BEFORE INSERT ON job_observations
    WHEN NEW.title = 'Observation Fail 2'
    BEGIN SELECT RAISE(ABORT, 'injected observation failure'); END`);
  assert.throws(() => checkpointScanTarget(database, {
    runId,
    batchId,
    leaseOwner: context.owner,
    targetKey: "observation-failure-target",
    city: "Guangzhou",
    keyword: "atomic",
    laneId: "A",
    status: "completed",
    jobs: [job("obs-fail-1", "Observation Fail 1"), job("obs-fail-2", "Observation Fail 2")]
  }), /injected observation failure/);
  database.exec("DROP TRIGGER inject_observation_failure");
  assert.strictEqual(count(database, "SELECT COUNT(*) AS count FROM jobs WHERE source_id LIKE 'obs-fail-%'"), 0);
  assert.strictEqual(count(database, "SELECT COUNT(*) AS count FROM job_observations WHERE batch_id = ?", batchId), 0);
  assert.strictEqual(listScanTargetResults(database, batchId).length, 0);
  finishScanRun(database, { runId, leaseOwner: context.owner, status: "failed", stopCode: "INJECTED_OBSERVATION_FAILURE" });
}

function targetFailureRollsBack(database, context) {
  const { runId, batchId } = startRun(database, { ...context, label: "target-failure" });
  const heartbeatBefore = getScanRun(database, runId).heartbeatAt;
  database.exec(`CREATE TEMP TRIGGER inject_target_failure
    BEFORE INSERT ON scan_target_results
    WHEN NEW.target_key = 'target-insert-fail'
    BEGIN SELECT RAISE(ABORT, 'injected target failure'); END`);
  assert.throws(() => checkpointScanTarget(database, {
    runId,
    batchId,
    leaseOwner: context.owner,
    targetKey: "target-insert-fail",
    status: "completed",
    jobs: [job("target-fail-1", "Target Fail 1"), job("target-fail-2", "Target Fail 2")]
  }), /injected target failure/);
  database.exec("DROP TRIGGER inject_target_failure");
  assert.strictEqual(count(database, "SELECT COUNT(*) AS count FROM jobs WHERE source_id LIKE 'target-fail-%'"), 0);
  assert.strictEqual(count(database, "SELECT COUNT(*) AS count FROM job_observations WHERE batch_id = ?", batchId), 0);
  assert.strictEqual(listScanTargetResults(database, batchId).length, 0);
  assert.strictEqual(getScanRun(database, runId).heartbeatAt, heartbeatBefore);
  finishScanRun(database, { runId, leaseOwner: context.owner, status: "failed", stopCode: "INJECTED_TARGET_FAILURE" });
}

function lifecycleAndIdempotency(database, context) {
  const { runId, batchId } = startRun(database, { ...context, label: "idempotency" });
  const heartbeat = heartbeatScanRun(database, { runId, leaseOwner: context.owner });
  assert(heartbeat.heartbeatAt);
  checkpointScanTarget(database, {
    runId,
    batchId,
    leaseOwner: context.owner,
    targetKey: "same-target",
    status: "completed",
    jobs: [job("stable-job", "Stable Job v1")]
  });
  checkpointScanTarget(database, {
    runId,
    batchId,
    leaseOwner: context.owner,
    targetKey: "same-target",
    status: "partial",
    errorCode: "PARTIAL_PAGE",
    jobs: [job("stable-job", "Stable Job v2")]
  });
  assert.strictEqual(count(database, "SELECT COUNT(*) AS count FROM job_observations WHERE batch_id = ?", batchId), 1);
  assert.strictEqual(listScanTargetResults(database, batchId).length, 2);
  const latest = listLatestScanTargetResults(database, batchId);
  assert.strictEqual(latest.length, 1);
  assert.strictEqual(latest[0].attemptNumber, 2);
  assert.strictEqual(latest[0].status, "partial");
  assert.deepStrictEqual(summarizeScanTargets(database, batchId), {
    batchId,
    status: "partial",
    total: 1,
    completed: 0,
    partial: 1,
    failed: 0,
    jobCount: 1
  });

  const finished = finishScanRun(database, {
    runId,
    leaseOwner: context.owner,
    status: "partial",
    stopCode: "PARTIAL_PAGE",
    stopMessage: "one target stopped early"
  });
  assert.strictEqual(finished.status, "partial");
  const batch = database.prepare("SELECT status, finished_at, stop_code, stop_message FROM batches WHERE id = ?").get(batchId);
  assert.strictEqual(batch.status, "partial");
  assert(batch.finished_at);
  assert.strictEqual(batch.stop_code, "PARTIAL_PAGE");
  assert.strictEqual(batch.stop_message, "one target stopped early");

  const exited = recordScanRunProcessExit(database, { runId, exitCode: 17 });
  assert.strictEqual(exited.status, "partial");
  assert.strictEqual(exited.processExitCode, 17);
  assert.strictEqual(database.prepare("SELECT status FROM batches WHERE id = ?").get(batchId).status, "partial");
}

function processExitAndOrphanRecovery(database, context) {
  const completedRun = startRun(database, { ...context, label: "process-exit" });
  checkpointScanTarget(database, {
    ...completedRun,
    leaseOwner: context.owner,
    targetKey: "completed-target",
    status: "completed",
    jobs: [job("process-exit-job", "Process Exit Job")]
  });
  const exited = recordScanRunProcessExit(database, { runId: completedRun.runId, exitCode: 0 });
  assert.strictEqual(exited.status, "completed");
  assert.strictEqual(database.prepare("SELECT status FROM batches WHERE id = ?").get(completedRun.batchId).status, "completed");

  const orphan = startRun(database, { ...context, label: "orphan" });
  database.prepare("UPDATE scan_runs SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(orphan.runId);
  database.prepare("UPDATE site_scan_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE site = ? AND owner = ?")
    .run("boss", context.owner);
  const interrupted = interruptOrphanedScanRuns(database, { heartbeatTimeoutMs: 60_000 });
  assert.deepStrictEqual(interrupted, { interrupted: 1, runIds: [orphan.runId] });
  assert.strictEqual(getScanRun(database, orphan.runId).status, "interrupted");
  assert.strictEqual(database.prepare("SELECT status FROM batches WHERE id = ?").get(orphan.batchId).status, "interrupted");
}

async function wrongPlanReassessmentIsRejected(database, { profileId, planId, otherPlanId }) {
  const batchId = createBatch(database, "boss", "wrong-plan", "wrong-plan", { profileId, searchPlanId: planId });
  upsertJob(database, job("wrong-plan-job", "Wrong Plan Job"), batchId);
  const beforeJob = database.prepare("SELECT title, score, analysis_json, last_seen_at, batch_id FROM jobs WHERE source_id = 'wrong-plan-job'").get();
  const beforeObservation = database.prepare("SELECT title, score, analysis_json, content_hash, seen_at FROM job_observations WHERE batch_id = ?").get(batchId);
  let analyzerCalls = 0;
  await assert.rejects(() => reassessBatchObservations(database, {
    batchId,
    planId: otherPlanId,
    configs: {},
    analyzeJob: async () => { analyzerCalls += 1; return {}; }
  }), (error) => error.code === "BATCH_PLAN_MISMATCH");
  assert.strictEqual(analyzerCalls, 0);
  assert.deepStrictEqual(database.prepare("SELECT title, score, analysis_json, last_seen_at, batch_id FROM jobs WHERE source_id = 'wrong-plan-job'").get(), beforeJob);
  assert.deepStrictEqual(database.prepare("SELECT title, score, analysis_json, content_hash, seen_at FROM job_observations WHERE batch_id = ?").get(batchId), beforeObservation);
}

function job(sourceId, title) {
  return {
    source: "boss",
    sourceId,
    keyword: "atomic",
    title,
    company: "Recovery Co",
    location: "Guangzhou",
    salary: "15-20K",
    experience: "1-3 years",
    education: "Bachelor",
    tags: [],
    description: "Normalized job description",
    score: 80,
    level: "A",
    matches: [],
    risks: [],
    qualityTags: [],
    analysis: { provider: "test", semanticStatus: "complete" }
  };
}

function count(database, sql, ...params) {
  return Number(database.prepare(sql).get(...params).count);
}
