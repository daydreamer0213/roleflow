const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const storage = require("../src/core/storage");
const scanStore = require("../src/storage/scan_store");
const candidateStore = require("../src/storage/candidate_store");
const jobStore = require("../src/storage/job_store");
const shared = require("../src/storage/storage_shared");

const SCAN_OPERATIONS = [
  "createBatch", "createAndBindScanBatch", "getBatch", "getLatestResumableBatch",
  "createScanRun", "getScanRun", "getLatestScanRun", "beginScanRun", "claimScanRun",
  "heartbeatScanRun", "finishScanRun", "recordScanRunProcessExit", "interruptOrphanedScanRuns",
  "checkpointScanProgress", "checkpointScanTarget", "recordScanTargetResult", "listScanTargetResults",
  "listLatestScanTargetResults", "summarizeScanTargets", "getSiteRuntimeState", "setSiteRuntimeState",
  "clearSiteRuntimeState", "recordSiteAccessEvent", "listSiteAccessEvents", "acquireSiteScanLease",
  "renewSiteScanLease", "releaseSiteScanLease", "getSiteScanLease", "listReusableJobDetails",
  "recordJobRefreshAttempt", "listJobRefreshAttempts", "getLatestJobRefreshAttempt",
  "getPlatformFilterCatalog", "savePlatformFilterCatalog"
];

assert.equal(Object.keys(storage).length, 136);
assert.equal(Object.keys(candidateStore).length, 29);
assert.equal(Object.keys(jobStore).length, 26);
assert.deepEqual(Object.keys(scanStore).sort(), [...SCAN_OPERATIONS, "SCAN_RUN_STATUSES"].sort());
assert.equal(storage.SCAN_RUN_STATUSES, scanStore.SCAN_RUN_STATUSES);
for (const name of SCAN_OPERATIONS) assert.equal(storage[name], scanStore[name]);
assert.deepEqual(Object.keys(shared).sort(), ["nowIso", "parseJson", "OUTCOME_STATUSES", "storageError", "optionalInteger", "optionalPositiveInteger", "nullableText", "validDate"].sort());
for (const name of Object.keys(jobStore)) assert.equal(storage[name], jobStore[name]);
for (const name of Object.keys(candidateStore)) assert.equal(storage[name], candidateStore[name]);

const db = storage.openDb(":memory:");
try {
  batchAndResumableContract();
  createAndBindRollbackContract();
  lifecycleAndProcessExitContract();
  orphanAndReboundContract();
  checkpointAtomicityContract();
  targetHistoryContract();
  runtimeAndAccessContract();
  detailRefreshCatalogContract();
  console.log("scan_store_contract_smoke ok (13 behavior contracts)");
} finally {
  db.close();
}

function batchAndResumableContract() {
  const completed = storage.getBatch(db, storage.createBatch(db, "boss", "default", "note"));
  assert.equal(completed.status, "completed");
  assert.equal(completed.note, "note");
  assert.equal(completed.filterSnapshot && typeof completed.filterSnapshot, "object");
  const planId = seedPlan("resume");
  storage.createBatch(db, "boss", "ignored", "", { status: "partial", searchPlanId: planId, filterSnapshot: { execution: 1 } });
  storage.createBatch(db, "boss", "picked", "", { status: "failed", searchPlanId: planId, filterSnapshot: { execution: "legacy-truthy" } });
  const resumable = storage.getLatestResumableBatch(db, { planId, site: "boss" });
  assert.equal(resumable.keyword, "picked");
  assert.equal(resumable.filterSnapshot.execution, "legacy-truthy");
  assert.throws(() => storage.createBatch(db, "boss", "bad", "", { status: "queued" }), (error) => error.code === "SCAN_BATCH_STATUS_INVALID");
}

function createAndBindRollbackContract() {
  const runId = "bind-late-run";
  storage.createScanRun(db, { runId, site: "bind-late", planId: 44 });
  storage.acquireSiteScanLease(db, { site: "bind-late", owner: "bind-owner", planId: 44 });
  db.exec("CREATE TEMP TRIGGER bind_late_failure AFTER INSERT ON batches BEGIN SELECT RAISE(ABORT, 'bind late failure'); END");
  assert.throws(() => storage.createAndBindScanBatch(db, { runId, site: "bind-late", searchPlanId: 44, leaseOwner: "bind-owner", status: "running", filterSnapshot: { execution: {} } }), /bind late failure/);
  db.exec("DROP TRIGGER bind_late_failure");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM batches WHERE site = 'bind-late'").get().count, 0);
  assert.equal(storage.getScanRun(db, runId).batchId, null);
  storage.releaseSiteScanLease(db, { site: "bind-late", owner: "bind-owner" });
}

function lifecycleAndProcessExitContract() {
  const run = storage.createScanRun(db, { runId: "lifecycle-run", site: "lifecycle", planId: 45 });
  const started = storage.beginScanRun(db, { runId: run.id, processId: 10 });
  assert.equal(started.status, "running");
  assert.equal(storage.heartbeatScanRun(db, { runId: run.id, allowUnleased: true, heartbeatAt: "2030-01-01T00:00:00.000Z" }).heartbeatAt, "2030-01-01T00:00:00.000Z");
  const finished = storage.finishScanRun(db, { runId: run.id, status: "completed", finishedAt: "2030-01-01T00:00:01.000Z" });
  assert.equal(finished.status, "completed");
  assert.equal(storage.finishScanRun(db, { runId: run.id, status: "completed" }).status, "completed");
  assert.throws(() => storage.finishScanRun(db, { runId: run.id, status: "failed" }), (error) => error.code === "SCAN_RUN_ALREADY_FINISHED");

  const signal = storage.createScanRun(db, { runId: "signal-run", site: "exit" });
  const signaled = storage.recordScanRunProcessExit(db, { runId: signal.id, signal: "SIGTERM", exitedAt: "2030-01-01T00:00:02.000Z" });
  assert.equal(signaled.status, "interrupted");
  assert.equal(signaled.processSignal, "SIGTERM");
  const zero = storage.createScanRun(db, { runId: "zero-run", site: "exit" });
  assert.equal(storage.recordScanRunProcessExit(db, { runId: zero.id, exitCode: 0 }).status, "completed");
}

function orphanAndReboundContract() {
  const batchId = storage.createBatch(db, "orphan", "rebound", "", { status: "running" });
  storage.createScanRun(db, { runId: "orphan-old", site: "orphan", batchId });
  storage.createScanRun(db, { runId: "orphan-rebound", site: "orphan", batchId });
  db.prepare("UPDATE scan_runs SET heartbeat_at = '2000-01-01T00:00:00.000Z', created_at = '2000-01-01T00:00:00.000Z' WHERE id IN ('orphan-old', 'orphan-rebound')").run();
  assert.equal(storage.interruptOrphanedScanRuns(db, { site: "orphan", now: new Date("2030-01-01"), heartbeatTimeoutMs: 1 }).interrupted, 2);
  assert.equal(storage.getBatch(db, batchId).status, "interrupted");
  const protectedBatch = storage.createBatch(db, "orphan-protected", "rebound", "", { status: "running" });
  storage.createScanRun(db, { runId: "protected-old", site: "orphan-protected", batchId: protectedBatch });
  storage.createScanRun(db, { runId: "protected-rebound", site: "orphan-protected", batchId: protectedBatch });
  db.prepare("UPDATE scan_runs SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE batch_id = ?").run(protectedBatch);
  db.prepare("UPDATE scan_runs SET status = 'completed' WHERE id = 'protected-old'").run();
  assert.equal(storage.interruptOrphanedScanRuns(db, { site: "orphan-protected", now: new Date("2030-01-01"), heartbeatTimeoutMs: 1 }).interrupted, 1);
}

function checkpointAtomicityContract() {
  const owner = "checkpoint-owner";
  const lease = storage.acquireSiteScanLease(db, { site: "checkpoint", owner, planId: 46 });
  const batchId = storage.createBatch(db, "checkpoint", "atomic", "", { status: "running", searchPlanId: 46 });
  const run = storage.createScanRun(db, { runId: "checkpoint-run", site: "checkpoint", planId: 46 });
  storage.beginScanRun(db, { runId: run.id, batchId, leaseOwner: owner });
  db.exec("CREATE TEMP TRIGGER checkpoint_late_failure AFTER INSERT ON job_observations BEGIN SELECT RAISE(ABORT, 'checkpoint late failure'); END");
  const before = snapshotTables(["jobs", "job_observations", "scan_target_results", "scan_runs"]);
  assert.throws(() => storage.checkpointScanProgress(db, { runId: run.id, batchId, leaseOwner: owner, jobs: [job("checkpoint-fail")] }), /checkpoint late failure/);
  assert.deepEqual(snapshotTables(["jobs", "job_observations", "scan_target_results", "scan_runs"]), before);
  db.exec("DROP TRIGGER checkpoint_late_failure");
  const result = storage.checkpointScanTarget(db, { runId: run.id, batchId, leaseOwner: owner, targetKey: "target-1", status: "completed", jobs: [job("checkpoint-ok")] });
  assert.equal(result.jobCount, 1);
  assert.equal(storage.listScanTargetResults(db, batchId).length, 1);
  storage.releaseSiteScanLease(db, { site: "checkpoint", owner });
  assert.equal(lease.site, "checkpoint");
}

function targetHistoryContract() {
  const batchId = storage.createBatch(db, "history", "targets", "", { status: "running" });
  storage.recordScanTargetResult(db, { batchId, targetKey: "same", status: "partial", jobCount: 2, startedAt: "2029-01-01", finishedAt: "2029-01-01T00:00:01Z" });
  storage.recordScanTargetResult(db, { batchId, targetKey: "same", status: "completed", jobCount: 3, startedAt: "2029-01-01", finishedAt: "2029-01-01T00:00:02Z" });
  storage.recordScanTargetResult(db, { batchId, targetKey: "failed", status: "failed", jobCount: 1 });
  assert.equal(storage.listScanTargetResults(db, batchId).length, 3);
  assert.deepEqual(storage.listLatestScanTargetResults(db, batchId).map((row) => row.targetKey), ["same", "failed"]);
  assert.deepEqual(storage.summarizeScanTargets(db, batchId), { batchId, status: "partial", total: 2, completed: 1, partial: 0, failed: 1, jobCount: 4 });
}

function runtimeAndAccessContract() {
  assert.equal(storage.setSiteRuntimeState(db, "runtime", { status: "blocked", reasonCode: "x", details: { n: 1 } }).status, "blocked");
  assert.deepEqual(storage.getSiteRuntimeState(db, "runtime").details, { n: 1 });
  storage.clearSiteRuntimeState(db, "runtime");
  assert.equal(storage.getSiteRuntimeState(db, "runtime"), null);
  storage.recordSiteAccessEvent(db, { site: "Access", action: "Open", runId: "r1", details: { city: "GZ" }, createdAt: "2029-01-01T00:00:00Z" });
  storage.recordSiteAccessEvent(db, { site: "access", action: "Read", runId: "r2", details: {}, createdAt: "2029-01-01T00:00:01Z" });
  assert.equal(storage.listSiteAccessEvents(db, { site: "access", action: "open", since: "2020-01-01", limit: 1 })[0].details.city, "GZ");
  assert.equal(storage.listSiteAccessEvents(db, { site: "other" }).length, 0);
}

function detailRefreshCatalogContract() {
  const profileId = seedProfile("detail");
  const freshBatch = storage.createBatch(db, "boss", "detail", "", { profileId, status: "completed" });
  const oldBatch = storage.createBatch(db, "boss", "detail-old", "", { profileId, status: "completed" });
  const fresh = job("reuse-source", "fresh");
  fresh.description = "x".repeat(120);
  jobStore.upsertJob(db, fresh, freshBatch);
  db.prepare("UPDATE job_observations SET seen_at = ?, boss_active_text = ? WHERE batch_id = ?").run(new Date().toISOString(), "active", freshBatch);
  const old = job("reuse-old", "too-short");
  old.description = "x".repeat(119);
  jobStore.upsertJob(db, old, oldBatch);
  assert.deepEqual(storage.listReusableJobDetails(db, { site: "boss", profileId, maxAgeDays: 7 }).map((row) => row.sourceId), ["reuse-source"]);
  const jobId = Number(db.prepare("SELECT id FROM jobs WHERE source_id = 'reuse-source'").get().id);
  assert.equal(storage.recordJobRefreshAttempt(db, { jobId, result: "failed", errorCode: "E" }), 1);
  assert.equal(storage.recordJobRefreshAttempt(db, { jobId, result: "ok" }), 2);
  assert.equal(storage.getLatestJobRefreshAttempt(db, jobId).attemptNumber, 2);
  storage.savePlatformFilterCatalog(db, { site: "boss", catalog: { city: ["GZ"] }, source: "test", discoveredAt: "2029-01-01" });
  storage.savePlatformFilterCatalog(db, { site: "boss", catalog: { city: ["SZ"] }, source: "test-2", discoveredAt: "2029-01-02" });
  assert.deepEqual(storage.getPlatformFilterCatalog(db, "boss").catalog, { city: ["SZ"] });
  db.prepare("UPDATE platform_filter_catalogs SET catalog_json = 'bad json' WHERE site = 'boss'").run();
  assert.deepEqual(storage.getPlatformFilterCatalog(db, "boss").catalog, {});
}

function snapshotTables(tables) {
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

function seedProfile(label) {
  const now = new Date().toISOString();
  return Number(db.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, '{}', ?, ?)").run(label, now, now).lastInsertRowid);
}

function seedPlan(label) {
  const profileId = seedProfile(label);
  const now = new Date().toISOString();
  return Number(db.prepare("INSERT INTO search_plans(profile_id, name, plan_json, is_active, created_at, updated_at) VALUES (?, ?, '{}', 1, ?, ?)").run(profileId, label, now, now).lastInsertRowid);
}

function job(sourceId) {
  return { source: "boss", sourceId, keyword: "contract", title: sourceId, company: "Contract Co", location: "GZ", salary: "10K", experience: "1-3", education: "Bachelor", tags: [], description: "detail", score: 80, level: "A", matches: [], risks: [], qualityTags: [], analysis: { provider: "test", semanticStatus: "complete" } };
}

const tempDbPath = path.join(__dirname, "..", ".runtime", "scan-store-contract-lease.sqlite");
fs.rmSync(tempDbPath, { force: true });
for (const suffix of ["-wal", "-shm"]) fs.rmSync(tempDbPath + suffix, { force: true });
const dbA = storage.openDb(tempDbPath);
const dbB = storage.openDb(tempDbPath);
try {
  storage.acquireSiteScanLease(dbA, { site: "two-handle", owner: "a", ttlMs: 60000 });
  assert.throws(() => storage.acquireSiteScanLease(dbB, { site: "two-handle", owner: "b" }), (error) => error.code === "SCAN_ALREADY_RUNNING" && error.lease.owner === "a");
  assert.throws(() => storage.renewSiteScanLease(dbB, { site: "two-handle", owner: "b" }), (error) => error.code === "SCAN_LEASE_LOST");
  assert.equal(storage.releaseSiteScanLease(dbA, { site: "two-handle", owner: "a" }), true);
  assert.equal(storage.acquireSiteScanLease(dbB, { site: "two-handle", owner: "b" }).owner, "b");
  assert.equal(storage.acquireSiteScanLease(dbB, { site: "other-handle", owner: "c" }).owner, "c");
  dbB.prepare("UPDATE site_scan_leases SET expires_at = '2000-01-01T00:00:00Z' WHERE site = 'two-handle'").run();
  assert.equal(storage.getSiteScanLease(dbB, "two-handle"), null);
  storage.releaseSiteScanLease(dbB, { site: "other-handle", owner: "c" });
} finally {
  dbA.close();
  dbB.close();
  fs.rmSync(tempDbPath, { force: true });
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(tempDbPath + suffix, { force: true });
}
