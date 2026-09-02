const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const storage = require("../src/core/storage");
const scanStore = require("../src/storage/scan_store");
const candidateStore = require("../src/storage/candidate_store");
const jobStore = require("../src/storage/job_store");
const shared = require("../src/storage/storage_shared");

const ROOT = path.join(__dirname, "..");
const CHECKPOINT_TABLES = ["jobs", "job_observations", "scan_runs", "scan_target_results", "batches", "site_scan_leases"];
const SCAN_OPERATIONS = [
  "createBatch", "createAndBindScanBatch", "getBatch", "getLatestResumableBatch",
  "createScanRun", "getScanRun", "getLatestScanRun", "beginScanRun", "claimScanRun",
  "heartbeatScanRun", "finishScanRun", "recordScanRunProcessExit", "interruptOrphanedScanRuns",
  "checkpointScanProgress", "checkpointScanTarget", "recordScanTargetResult", "listScanTargetResults",
  "listLatestScanTargetResults", "summarizeScanTargets", "getSiteRuntimeState", "setSiteRuntimeState",
  "clearSiteRuntimeState", "getSitePacingState", "setSitePacingState", "mergeBossPacingStates",
  "recordSiteAccessEvent", "listSiteAccessEvents", "acquireSiteScanLease",
  "renewSiteScanLease", "releaseSiteScanLease", "getSiteScanLease", "listReusableJobDetails",
  "recordJobRefreshAttempt", "listJobRefreshAttempts", "getLatestJobRefreshAttempt",
  "getPlatformFilterCatalog", "savePlatformFilterCatalog"
];

const db = storage.openDb(":memory:");
try {
  contract01ExportsAndReferences();
  contract02LoadGraphAndCircularWarnings();
  contract03BatchAndResumable();
  contract04CreateAndBind();
  contract05Lifecycle();
  contract06ProcessExit();
  contract07Orphans();
  contract08Checkpoints();
  contract09TargetHistoryAndSummary();
  contract10RuntimeAndAccess();
  contract11TwoHandleLease();
  contract12ReuseRefreshAndCatalog();
  contract13FacadeConsumers();
  console.log("scan_store_contract_smoke ok (13 behavior contracts)");
} finally {
  db.close();
}

function contract01ExportsAndReferences() {
  assert.equal(Object.keys(storage).length, 187);
  assert.equal(Object.keys(candidateStore).length, 29);
  assert.equal(Object.keys(jobStore).length, 26);
  assert.deepEqual(Object.keys(scanStore).sort(), [...SCAN_OPERATIONS, "SCAN_RUN_STATUSES", "normalizeBossPacing"].sort());
  assert.equal(storage.SCAN_RUN_STATUSES, scanStore.SCAN_RUN_STATUSES);
  for (const name of SCAN_OPERATIONS) assert.equal(storage[name], scanStore[name]);
  for (const name of Object.keys(candidateStore)) assert.equal(storage[name], candidateStore[name]);
  for (const name of Object.keys(jobStore)) assert.equal(storage[name], jobStore[name]);
  assert.deepEqual(Object.keys(shared).sort(), [
    "OUTCOME_STATUSES", "immediateTransaction", "nowIso", "nullableText", "optionalInteger", "optionalPositiveInteger", "parseJson", "storageError", "validDate"
  ]);
}

function contract02LoadGraphAndCircularWarnings() {
  const script = `
    const Module = require("node:module");
    const path = require("node:path");
    const scanPath = require.resolve(${JSON.stringify(path.join(ROOT, "src", "storage", "scan_store.js"))});
    const edges = [];
    const original = Module._load;
    Module._load = function(request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (parent && path.resolve(parent.filename) === path.resolve(scanPath)) edges.push(resolved);
      return original.apply(this, arguments);
    };
    require(scanPath);
    require(${JSON.stringify(path.join(ROOT, "src", "core", "storage.js"))});
    require(${JSON.stringify(path.join(ROOT, "src", "storage", "candidate_store.js"))});
    require(${JSON.stringify(path.join(ROOT, "src", "storage", "job_store.js"))});
    process.stdout.write(JSON.stringify(edges));
  `;
  const child = spawnSync(process.execPath, ["-e", script], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.doesNotMatch(child.stderr, /circular dependency/i);
  const dependencies = JSON.parse(child.stdout).map((value) => value === "crypto" ? value : path.basename(value)).sort();
  assert.deepEqual(dependencies, ["crypto", "job_store.js", "product_policy.js", "storage_shared.js"]);
}

function contract03BatchAndResumable() {
  const completed = storage.getBatch(db, storage.createBatch(db, "boss", "default", "note"));
  assertKeys(completed, ["id", "site", "keyword", "startedAt", "note", "profileId", "searchPlanId", "filterSnapshot", "status", "finishedAt", "stopCode", "stopMessage"]);
  assert.deepEqual(pick(completed, ["site", "keyword", "note", "profileId", "searchPlanId", "filterSnapshot", "status", "stopCode", "stopMessage"]), {
    site: "boss", keyword: "default", note: "note", profileId: null, searchPlanId: null, filterSnapshot: {}, status: "completed", stopCode: "", stopMessage: ""
  });
  assert.equal(completed.finishedAt, completed.startedAt);
  for (const status of scanStore.SCAN_RUN_STATUSES) {
    assert.equal(storage.getBatch(db, storage.createBatch(db, "batch-status", status, "", { status })).status, status);
  }
  const planId = seedPlan(db, "resumable");
  storage.createBatch(db, "boss", "completed", "", { status: "completed", searchPlanId: planId, filterSnapshot: { execution: true } });
  storage.createBatch(db, "other", "wrong-site", "", { status: "failed", searchPlanId: planId, filterSnapshot: { execution: true } });
  storage.createBatch(db, "boss", "false", "", { status: "failed", searchPlanId: planId, filterSnapshot: { execution: 0 } });
  storage.createBatch(db, "boss", "picked", "", { status: "interrupted", searchPlanId: planId, filterSnapshot: { execution: "legacy-truthy" } });
  assert.equal(storage.getLatestResumableBatch(db, { planId, site: "boss" }).keyword, "picked");
  assert.equal(storage.getLatestResumableBatch(db, { planId, site: "missing" }), null);
  assert.equal(storage.getLatestResumableBatch(db, { site: "boss" }), null);
  assertThrowsCode(() => storage.createBatch(db, "boss", "bad", "", { status: "queued" }), "SCAN_BATCH_STATUS_INVALID");
}

function contract04CreateAndBind() {
  const runId = "bind-late-run";
  storage.createScanRun(db, { runId, site: "bind-late", planId: 44 });
  storage.acquireSiteScanLease(db, { site: "bind-late", owner: "bind-owner", planId: 44 });
  let lateHits = 0;
  db.function("contract_bind_late", () => { lateHits += 1; throw new Error("bind late failure"); });
  db.exec(`CREATE TEMP TRIGGER bind_late_failure AFTER UPDATE OF batch_id ON scan_runs
    WHEN NEW.id = 'bind-late-run' AND NEW.batch_id IS NOT NULL BEGIN SELECT contract_bind_late(); END`);
  const before = snapshotTables(db, ["batches", "scan_runs", "site_scan_leases"]);
  const observed = observeTransactions(db);
  assert.throws(() => storage.createAndBindScanBatch(observed.db, {
    runId, site: "bind-late", searchPlanId: 44, leaseOwner: "bind-owner", processId: 401, status: "running", filterSnapshot: { execution: {} }
  }));
  assert.equal(lateHits, 1, "failure runs after scan_runs.batch_id update");
  assert.deepEqual(observed.transactions, ["BEGIN IMMEDIATE", "ROLLBACK"]);
  assert.deepEqual(snapshotTables(db, ["batches", "scan_runs", "site_scan_leases"]), before);
  db.exec("DROP TRIGGER bind_late_failure");

  const successRun = storage.createScanRun(db, { runId: "bind-success-run", site: "bind-success", planId: 45 });
  storage.acquireSiteScanLease(db, { site: "bind-success", owner: "bind-success-owner", planId: 45 });
  const successObserved = observeTransactions(db);
  const batchId = storage.createAndBindScanBatch(successObserved.db, {
    runId: successRun.id, site: "bind-success", searchPlanId: 45, leaseOwner: "bind-success-owner", processId: 402, status: "running", filterSnapshot: { execution: { lane: "A" } }
  });
  assert.deepEqual(successObserved.transactions, ["BEGIN IMMEDIATE", "COMMIT"]);
  assert.equal(storage.getScanRun(db, successRun.id).batchId, batchId);
  assert.equal(storage.getBatch(db, batchId).status, "running");

  const gates = [
    { name: "missing run", patch: { runId: "" }, code: "SCAN_RUN_ID_REQUIRED" },
    { name: "unknown run", patch: { runId: "not-found" }, code: "SCAN_RUN_NOT_FOUND" },
    { name: "missing site", patch: { site: "" }, code: "SCAN_RUN_SITE_REQUIRED" },
    { name: "wrong site", patch: { site: "other" }, code: "SCAN_RUN_BATCH_MISMATCH" },
    { name: "wrong plan", patch: { searchPlanId: 99 }, code: "SCAN_RUN_PLAN_MISMATCH" },
    { name: "wrong owner", patch: { leaseOwner: "other" }, code: "SCAN_RUN_LEASE_MISMATCH" },
    { name: "no lease", noLease: true, code: "SCAN_RUN_LEASE_MISMATCH" },
    { name: "already bound", bound: true, code: "SCAN_RUN_BATCH_MISMATCH" }
  ];
  for (const gate of gates) withDb((gateDb) => {
    const planId = seedPlan(gateDb, `bind-${gate.name}`);
    const site = "bind-gate";
    const owner = "bind-owner";
    const bound = gate.bound ? storage.createBatch(gateDb, site, "bound", "", { status: "running", searchPlanId: planId }) : null;
    storage.createScanRun(gateDb, { runId: "bind-gate-run", site, planId, batchId: bound });
    if (!gate.noLease) storage.acquireSiteScanLease(gateDb, { site, owner, planId });
    const input = { runId: "bind-gate-run", site, searchPlanId: planId, leaseOwner: owner, status: "running", ...gate.patch };
    const snapshot = snapshotTables(gateDb, ["batches", "scan_runs", "site_scan_leases"]);
    assertThrowsCode(() => storage.createAndBindScanBatch(gateDb, input), gate.code, gate.name);
    assert.deepEqual(snapshotTables(gateDb, ["batches", "scan_runs", "site_scan_leases"]), snapshot, gate.name);
  });
}

function contract05Lifecycle() {
  const batchId = storage.createBatch(db, "lifecycle", "run", "", { status: "running" });
  const created = storage.createScanRun(db, { runId: "lifecycle-run", site: "lifecycle", batchId, processId: 10 });
  assertKeys(created, ["id", "runId", "site", "command", "planId", "batchId", "status", "leaseOwner", "processId", "createdAt", "startedAt", "heartbeatAt", "finishedAt", "stopCode", "stopMessage", "processExitCode", "processSignal"]);
  const beginObserved = observeTransactions(db);
  const begun = storage.beginScanRun(beginObserved.db, { runId: created.id, batchId, processId: 10, startedAt: "2030-01-01T00:00:00.000Z" });
  assert.deepEqual(beginObserved.transactions, ["BEGIN IMMEDIATE", "COMMIT"]);
  assert.equal(begun.status, "running");
  assert.equal(storage.heartbeatScanRun(db, { runId: created.id, allowUnleased: true, heartbeatAt: "2030-01-01T00:00:01.000Z" }).heartbeatAt, "2030-01-01T00:00:01.000Z");
  const finished = storage.finishScanRun(db, { runId: created.id, status: "completed", finishedAt: "2030-01-01T00:00:02.000Z" });
  assert.equal(finished.status, "completed");
  assert.equal(storage.getBatch(db, batchId).status, "completed");
  assert.equal(storage.finishScanRun(db, { runId: created.id, status: "completed" }).status, "completed");
  assertThrowsCode(() => storage.finishScanRun(db, { runId: created.id, status: "failed" }), "SCAN_RUN_ALREADY_FINISHED");

  withDb((claimDb) => {
    const planId = seedPlan(claimDb, "claim-success");
    const batchId = storage.createBatch(claimDb, "claim-site", "claim", "", { status: "completed", searchPlanId: planId });
    const run = storage.createScanRun(claimDb, { runId: "claim-success-run", site: "claim-site", planId });
    storage.acquireSiteScanLease(claimDb, { site: "claim-site", owner: "claim-owner", planId, ttlMs: 60_000 });
    const observed = observeTransactions(claimDb);
    const claimed = storage.claimScanRun(observed.db, {
      runId: run.id, batchId, leaseOwner: "claim-owner", processId: 41,
      startedAt: "2030-01-01T00:00:00.000Z", heartbeatAt: "2030-01-01T00:00:01.000Z"
    });
    assert.deepEqual(observed.transactions, ["BEGIN IMMEDIATE", "COMMIT"]);
    assert.deepEqual(pick(claimed, ["runId", "site", "planId", "batchId", "status", "leaseOwner", "processId", "startedAt", "heartbeatAt"]), {
      runId: "claim-success-run", site: "claim-site", planId, batchId, status: "running", leaseOwner: "claim-owner", processId: 41,
      startedAt: "2030-01-01T00:00:00.000Z", heartbeatAt: "2030-01-01T00:00:01.000Z"
    });
    assert.equal(storage.getBatch(claimDb, batchId).status, "running");
    assert.deepEqual(pick(storage.getSiteScanLease(claimDb, "claim-site"), ["site", "owner", "planId"]), { site: "claim-site", owner: "claim-owner", planId });
  });

  const claimFailures = [
    { name: "wrong owner", setup: ({ db, planId }) => storage.acquireSiteScanLease(db, { site: "claim-failure", owner: "real-owner", planId }), input: { leaseOwner: "wrong-owner" }, code: "SCAN_RUN_LEASE_MISMATCH" },
    { name: "already claimed", setup: ({ db, planId }) => {
      storage.acquireSiteScanLease(db, { site: "claim-failure", owner: "real-owner", planId });
      db.prepare("UPDATE scan_runs SET lease_owner = 'real-owner' WHERE id = 'claim-failure-run'").run();
    }, input: { leaseOwner: "other-owner" }, code: "SCAN_RUN_CLAIMED" },
    { name: "expired lease", setup: ({ db, planId }) => {
      storage.acquireSiteScanLease(db, { site: "claim-failure", owner: "claim-owner", planId });
      db.prepare("UPDATE site_scan_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE site = 'claim-failure'").run();
    }, input: { leaseOwner: "claim-owner" }, code: "SCAN_RUN_LEASE_MISMATCH" },
    { name: "missing lease", setup: () => {}, input: { leaseOwner: "claim-owner" }, code: "SCAN_RUN_LEASE_MISMATCH" },
    { name: "batch site mismatch", setup: ({ db, planId }) => {
      storage.acquireSiteScanLease(db, { site: "claim-failure", owner: "claim-owner", planId });
      return { batchId: storage.createBatch(db, "other-site", "claim", "", { status: "completed", searchPlanId: planId }) };
    }, input: { leaseOwner: "claim-owner" }, code: "SCAN_RUN_BATCH_MISMATCH" },
    { name: "batch plan mismatch", setup: ({ db }) => {
      storage.acquireSiteScanLease(db, { site: "claim-failure", owner: "claim-owner", planId: 999 });
      return { batchId: storage.createBatch(db, "claim-failure", "claim", "", { status: "completed", searchPlanId: 999 }) };
    }, input: { leaseOwner: "claim-owner" }, code: "SCAN_RUN_PLAN_MISMATCH" }
  ];
  for (const failure of claimFailures) withDb((claimDb) => {
    const planId = seedPlan(claimDb, `claim-${failure.name}`);
    storage.createScanRun(claimDb, { runId: "claim-failure-run", site: "claim-failure", planId });
    const setupResult = failure.setup({ db: claimDb, planId });
    const batchId = setupResult?.batchId || storage.createBatch(claimDb, "claim-failure", "claim", "", { status: "completed", searchPlanId: planId });
    const before = snapshotTables(claimDb, ["scan_runs", "batches", "site_scan_leases"]);
    const observed = observeTransactions(claimDb);
    assertThrowsCode(() => storage.claimScanRun(observed.db, { runId: "claim-failure-run", batchId, ...failure.input }), failure.code, failure.name);
    assert.deepEqual(observed.transactions, ["BEGIN IMMEDIATE", "ROLLBACK"], failure.name);
    assert.deepEqual(snapshotTables(claimDb, ["scan_runs", "batches", "site_scan_leases"]), before, failure.name);
  });
}

function contract06ProcessExit() {
  withDb((exitDb) => {
    const nonzero = storage.createScanRun(exitDb, { runId: "exit-nonzero", site: "exit" });
    const observed = observeTransactions(exitDb);
    const result = storage.recordScanRunProcessExit(observed.db, { runId: nonzero.id, exitCode: 7, exitedAt: "2030-01-01T00:00:00.000Z" });
    assert.deepEqual(observed.transactions, ["BEGIN IMMEDIATE", "COMMIT"]);
    assert.deepEqual(pick(result, ["status", "processExitCode", "processSignal", "stopCode"]), { status: "failed", processExitCode: 7, processSignal: "", stopCode: "SCAN_PROCESS_EXIT" });
  });
  withDb((exitDb) => {
    const batchId = storage.createBatch(exitDb, "exit-signal", "sigterm", "", { status: "running" });
    const run = storage.createScanRun(exitDb, { runId: "exit-sigterm", site: "exit-signal", batchId });
    const result = storage.recordScanRunProcessExit(exitDb, { runId: run.id, signal: "SIGTERM", exitCode: null, exitedAt: "2030-01-01T00:00:00.000Z" });
    assert.deepEqual(pick(result, ["status", "processExitCode", "processSignal", "stopCode"]), { status: "interrupted", processExitCode: null, processSignal: "SIGTERM", stopCode: "SCAN_PROCESS_SIGNAL" });
    assert.equal(storage.getBatch(exitDb, batchId).status, "interrupted");
  });
  for (const expected of ["completed", "partial", "failed"]) withDb((exitDb) => {
    const batchId = storage.createBatch(exitDb, "summary", expected, "", { status: "running" });
    storage.recordScanTargetResult(exitDb, { batchId, targetKey: expected, status: expected, jobCount: 2 });
    const run = storage.createScanRun(exitDb, { runId: `exit-${expected}`, site: "summary", batchId });
    assert.equal(storage.recordScanRunProcessExit(exitDb, { runId: run.id, exitCode: 0 }).status, expected);
    assert.equal(storage.getBatch(exitDb, batchId).status, expected);
  });
  withDb((exitDb) => {
    const batchId = storage.createBatch(exitDb, "rebound", "exit", "", { status: "running" });
    const oldRun = storage.createScanRun(exitDb, { runId: "exit-old", site: "rebound", batchId });
    storage.createScanRun(exitDb, { runId: "exit-rebound", site: "rebound", batchId });
    assert.equal(storage.recordScanRunProcessExit(exitDb, { runId: oldRun.id, exitCode: 7 }).status, "failed");
    assert.equal(storage.getBatch(exitDb, batchId).status, "running");
  });
  withDb((exitDb) => {
    const batchId = storage.createBatch(exitDb, "exit-rollback", "sync", "", { status: "running" });
    const run = storage.createScanRun(exitDb, { runId: "exit-rollback-run", site: "exit-rollback", batchId });
    let hits = 0;
    exitDb.function("contract_exit_late", () => { hits += 1; throw new Error("process exit late failure"); });
    exitDb.exec(`CREATE TEMP TRIGGER process_exit_late AFTER UPDATE OF status ON batches
      WHEN NEW.id = ${batchId} BEGIN SELECT contract_exit_late(); END`);
    const before = snapshotTables(exitDb, ["scan_runs", "batches", "scan_target_results"]);
    const observed = observeTransactions(exitDb);
    assert.throws(() => storage.recordScanRunProcessExit(observed.db, { runId: run.id, exitCode: 9 }));
    assert.equal(hits, 1, "failure runs after terminal batch synchronization");
    assert.deepEqual(observed.transactions, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.deepEqual(snapshotTables(exitDb, ["scan_runs", "batches", "scan_target_results"]), before);
  });
}

function contract07Orphans() {
  withDb((orphanDb) => {
    const fresh = storage.createScanRun(orphanDb, { runId: "fresh", site: "orphan", heartbeatAt: "2030-01-01T00:00:00.000Z" });
    assert.deepEqual(storage.interruptOrphanedScanRuns(orphanDb, { site: "orphan", now: "2030-01-01T00:00:00.500Z", heartbeatTimeoutMs: 1_000 }), { interrupted: 0, runIds: [] });
    assert.equal(storage.getScanRun(orphanDb, fresh.id).status, "running");
  });
  withDb((orphanDb) => {
    const owner = "active-owner";
    storage.acquireSiteScanLease(orphanDb, { site: "lease-protected", owner });
    const run = storage.createScanRun(orphanDb, { runId: "lease-protected-run", site: "lease-protected", leaseOwner: owner, heartbeatAt: "2000-01-01T00:00:00.000Z" });
    assert.deepEqual(storage.interruptOrphanedScanRuns(orphanDb, { site: "lease-protected", now: new Date(), heartbeatTimeoutMs: 1 }), { interrupted: 0, runIds: [] });
    assert.equal(storage.getScanRun(orphanDb, run.id).status, "running");
  });
  withDb((orphanDb) => {
    const owner = "expired-owner";
    storage.acquireSiteScanLease(orphanDb, { site: "lease-expired", owner });
    const run = storage.createScanRun(orphanDb, { runId: "lease-expired-run", site: "lease-expired", leaseOwner: owner, heartbeatAt: "2000-01-01T00:00:00.000Z" });
    orphanDb.prepare("UPDATE site_scan_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE site = 'lease-expired'").run();
    assert.deepEqual(storage.interruptOrphanedScanRuns(orphanDb, { site: "lease-expired", now: "2030-01-01", heartbeatTimeoutMs: 1 }), { interrupted: 1, runIds: [run.id] });
    assert.equal(storage.getScanRun(orphanDb, run.id).status, "interrupted");
    assert.equal(orphanDb.prepare("SELECT COUNT(*) AS count FROM site_scan_leases WHERE site = 'lease-expired'").get().count, 0);
  });
  withDb((orphanDb) => {
    const batchId = storage.createBatch(orphanDb, "rebound", "orphan", "", { status: "running" });
    const oldRun = storage.createScanRun(orphanDb, { runId: "orphan-old", site: "rebound", batchId, heartbeatAt: "2000-01-01T00:00:00.000Z" });
    storage.createScanRun(orphanDb, { runId: "orphan-rebound", site: "rebound", batchId, heartbeatAt: "2030-01-01T00:00:10.000Z" });
    assert.deepEqual(storage.interruptOrphanedScanRuns(orphanDb, { site: "rebound", now: "2030-01-01T00:00:10.000Z", heartbeatTimeoutMs: 1_000 }), { interrupted: 1, runIds: [oldRun.id] });
    assert.equal(storage.getBatch(orphanDb, batchId).status, "running");
  });
  withDb((orphanDb) => {
    const batchId = storage.createBatch(orphanDb, "orphan-single", "stale", "", { status: "running" });
    const run = storage.createScanRun(orphanDb, { runId: "orphan-single-run", site: "orphan-single", batchId, heartbeatAt: "2000-01-01T00:00:00.000Z" });
    assert.deepEqual(storage.interruptOrphanedScanRuns(orphanDb, { site: "orphan-single", now: "2030-01-01", heartbeatTimeoutMs: 1 }), { interrupted: 1, runIds: [run.id] });
    assert.equal(storage.getScanRun(orphanDb, run.id).status, "interrupted");
    assert.equal(storage.getBatch(orphanDb, batchId).status, "interrupted");
  });
  withDb((orphanDb) => {
    const batchId = storage.createBatch(orphanDb, "orphan-mismatch", "stale", "", { status: "running" });
    const run = storage.createScanRun(orphanDb, { runId: "orphan-mismatch-run", site: "orphan-mismatch", batchId, leaseOwner: "run-owner", heartbeatAt: "2000-01-01T00:00:00.000Z" });
    storage.acquireSiteScanLease(orphanDb, { site: "orphan-mismatch", owner: "other-owner" });
    const beforeLease = snapshotTables(orphanDb, ["site_scan_leases"]);
    assert.deepEqual(storage.interruptOrphanedScanRuns(orphanDb, { site: "orphan-mismatch", now: "2030-01-01", heartbeatTimeoutMs: 1 }), { interrupted: 1, runIds: [run.id] });
    assert.equal(storage.getScanRun(orphanDb, run.id).status, "interrupted");
    assert.deepEqual(snapshotTables(orphanDb, ["site_scan_leases"]), beforeLease);
  });
}

function contract08Checkpoints() {
  withDb((checkpointDb) => {
    const fixture = checkpointFixture(checkpointDb, "progress-late");
    let hits = 0;
    checkpointDb.function("contract_progress_late", () => { hits += 1; throw new Error("progress late failure"); });
    checkpointDb.exec(`CREATE TEMP TRIGGER progress_late AFTER UPDATE OF heartbeat_at ON scan_runs
      WHEN NEW.id = '${fixture.runId}' BEGIN SELECT contract_progress_late(); END`);
    const before = snapshotTables(checkpointDb, CHECKPOINT_TABLES);
    const observed = observeTransactions(checkpointDb);
    assert.throws(() => storage.checkpointScanProgress(observed.db, checkpointInput(fixture, false)));
    assert.equal(hits, 1, "failure runs after jobs, observations, and heartbeat update");
    assert.deepEqual(observed.transactions, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.deepEqual(snapshotTables(checkpointDb, CHECKPOINT_TABLES), before);
    checkpointDb.exec("DROP TRIGGER progress_late");
    const success = observeTransactions(checkpointDb);
    assert.equal(storage.checkpointScanProgress(success.db, checkpointInput(fixture, false)).jobCount, 1);
    assert.deepEqual(success.transactions, ["BEGIN IMMEDIATE", "COMMIT"]);
  });
  withDb((checkpointDb) => {
    const fixture = checkpointFixture(checkpointDb, "target-late");
    let hits = 0;
    checkpointDb.function("contract_target_late", () => { hits += 1; throw new Error("target late failure"); });
    checkpointDb.exec(`CREATE TEMP TRIGGER target_late AFTER INSERT ON scan_target_results
      WHEN NEW.batch_id = ${fixture.batchId} BEGIN SELECT contract_target_late(); END`);
    const before = snapshotTables(checkpointDb, CHECKPOINT_TABLES);
    const observed = observeTransactions(checkpointDb);
    assert.throws(() => storage.checkpointScanTarget(observed.db, checkpointInput(fixture, true)));
    assert.equal(hits, 1, "failure runs after job, observation, heartbeat, and target result insert");
    assert.deepEqual(observed.transactions, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.deepEqual(snapshotTables(checkpointDb, CHECKPOINT_TABLES), before);
    checkpointDb.exec("DROP TRIGGER target_late");
    const success = observeTransactions(checkpointDb);
    const result = storage.checkpointScanTarget(success.db, checkpointInput(fixture, true));
    assert.equal(result.attemptNumber, 1);
    assert.deepEqual(success.transactions, ["BEGIN IMMEDIATE", "COMMIT"]);
  });
  for (const operation of ["checkpointScanProgress", "checkpointScanTarget"]) checkpointGates(operation);
}

function checkpointGates(operation) {
  const cases = [
    { name: "missing run", patch: { runId: "" }, code: "SCAN_RUN_ID_REQUIRED" },
    { name: "unknown run", patch: { runId: "unknown" }, code: "SCAN_RUN_NOT_FOUND" },
    { name: "finished run", mutate: ({ db, fixture }) => storage.finishScanRun(db, { runId: fixture.runId, status: "completed", leaseOwner: fixture.owner }), code: "SCAN_RUN_NOT_RUNNING" },
    { name: "missing batch", patch: { batchId: null }, code: "SCAN_RUN_BATCH_REQUIRED" },
    { name: "missing owner", patch: { leaseOwner: "" }, code: "SCAN_RUN_LEASE_OWNER_REQUIRED" },
    { name: "wrong batch", mutate: ({ db, fixture }) => ({ batchId: storage.createBatch(db, fixture.site, "other", "", { status: "running", searchPlanId: fixture.planId }) }), code: "SCAN_RUN_BATCH_MISMATCH" },
    { name: "wrong owner", patch: { leaseOwner: "other-owner" }, code: "SCAN_RUN_LEASE_MISMATCH" },
    { name: "wrong site", mutate: ({ db, fixture }) => {
      const batchId = storage.createBatch(db, "other-site", "other", "", { status: "running", searchPlanId: fixture.planId });
      db.prepare("UPDATE scan_runs SET batch_id = ? WHERE id = ?").run(batchId, fixture.runId);
      return { batchId };
    }, code: "SCAN_RUN_BATCH_MISMATCH" },
    { name: "wrong plan", mutate: ({ db, fixture }) => {
      const otherPlan = seedPlan(db, "other-plan");
      const batchId = storage.createBatch(db, fixture.site, "other", "", { status: "running", searchPlanId: otherPlan });
      db.prepare("UPDATE scan_runs SET batch_id = ? WHERE id = ?").run(batchId, fixture.runId);
      return { batchId };
    }, code: "SCAN_RUN_PLAN_MISMATCH" },
    { name: "missing batch row", mutate: ({ db, fixture }) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare("UPDATE scan_runs SET batch_id = 99999 WHERE id = ?").run(fixture.runId);
      return { batchId: 99999 };
    }, code: "SCAN_BATCH_NOT_FOUND" },
    { name: "non-running batch", mutate: ({ db, fixture }) => db.prepare("UPDATE batches SET status = 'completed' WHERE id = ?").run(fixture.batchId), code: "SCAN_BATCH_NOT_RUNNING" },
    { name: "expired lease", mutate: ({ db, fixture }) => db.prepare("UPDATE site_scan_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE site = ?").run(fixture.site), code: "SCAN_LEASE_LOST" }
  ];
  for (const gate of cases) withDb((gateDb) => {
    const fixture = checkpointFixture(gateDb, `${operation}-${gate.name}`);
    const patch = gate.mutate ? gate.mutate({ db: gateDb, fixture }) : gate.patch;
    const before = snapshotTables(gateDb, CHECKPOINT_TABLES);
    assertThrowsCode(() => storage[operation](gateDb, { ...checkpointInput(fixture, operation === "checkpointScanTarget"), ...patch }), gate.code, `${operation}: ${gate.name}`);
    assert.deepEqual(snapshotTables(gateDb, CHECKPOINT_TABLES), before, `${operation}: ${gate.name}`);
  });
}

function contract09TargetHistoryAndSummary() {
  const batchId = storage.createBatch(db, "history", "targets", "", { status: "running" });
  assert.deepEqual(storage.summarizeScanTargets(db, batchId), { batchId, status: "running", total: 0, completed: 0, partial: 0, failed: 0, jobCount: 0 });
  storage.recordScanTargetResult(db, { batchId, targetKey: "same", city: "GZ", keyword: "node", laneId: "a", status: "partial", jobCount: 2, details: { first: true }, startedAt: "2029-01-01", finishedAt: "2029-01-01T00:00:01Z" });
  storage.recordScanTargetResult(db, { batchId, targetKey: "same", status: "completed", jobCount: 3, details: { second: true }, startedAt: "2029-01-01", finishedAt: "2029-01-01T00:00:02Z" });
  storage.recordScanTargetResult(db, { batchId, targetKey: "failed", status: "failed", jobCount: 1, errorCode: "E", errorMessage: "bad" });
  const history = storage.listScanTargetResults(db, batchId);
  assert.equal(history.length, 3);
  assertKeys(history[0], ["id", "batchId", "targetKey", "city", "keyword", "laneId", "status", "jobCount", "errorCode", "errorMessage", "details", "attemptNumber", "startedAt", "finishedAt"]);
  assert.deepEqual(storage.listLatestScanTargetResults(db, batchId).map((row) => [row.targetKey, row.attemptNumber]), [["same", 2], ["failed", 1]]);
  assert.deepEqual(storage.summarizeScanTargets(db, batchId), { batchId, status: "partial", total: 2, completed: 1, partial: 0, failed: 1, jobCount: 4 });
  assert.throws(() => storage.recordScanTargetResult(db, { targetKey: "missing-batch" }), (error) => error.message === "scan target batchId is required");
  assert.throws(() => storage.recordScanTargetResult(db, { batchId, targetKey: "" }), (error) => error.message === "scan target key is required");
}

function contract10RuntimeAndAccess() {
  assert.throws(() => storage.setSiteRuntimeState(db, "", { status: "ready" }), (error) => error.message === "site runtime state requires a site");
  const runtime = storage.setSiteRuntimeState(db, "Runtime", { status: "blocked", reasonCode: "x", message: "blocked", details: { n: 1 } });
  assertKeys(runtime, ["site", "status", "reasonCode", "message", "details", "updatedAt"]);
  assert.deepEqual(storage.getSiteRuntimeState(db, "runtime").details, { n: 1 });
  storage.clearSiteRuntimeState(db, "runtime");
  assert.equal(storage.getSiteRuntimeState(db, "runtime"), null);
  const first = storage.recordSiteAccessEvent(db, { site: "Access", action: "Open", runId: "r1", details: { city: "GZ" }, createdAt: "2029-01-01T00:00:00.000Z" });
  storage.recordSiteAccessEvent(db, { site: "access", action: "Read", runId: "r2", details: { city: "SZ" }, createdAt: "2029-01-01T00:00:01.000Z" });
  storage.recordSiteAccessEvent(db, { site: "other", action: "Open", runId: "r3", createdAt: "2029-01-01T00:00:02.000Z" });
  assertKeys(first, ["id", "site", "action", "createdAt", "details"]);
  assert.deepEqual(first.details, { city: "GZ", site: "access", action: "open", runId: "r1" });
  assert.deepEqual(storage.listSiteAccessEvents(db, { site: "access", since: "2029-01-01" }).map((row) => row.action), ["open", "read"]);
  assert.deepEqual(storage.listSiteAccessEvents(db, { site: "access", since: "2029-01-01", limit: 1 }).map((row) => row.action), ["open"]);
  assert.deepEqual(storage.listSiteAccessEvents(db, { site: "access", action: "read", since: "2029-01-01" }).map((row) => row.details.city), ["SZ"]);
  assert.equal(storage.listSiteAccessEvents(db, { site: "access", since: "2030-01-01" }).length, 0);
  assert.throws(() => storage.recordSiteAccessEvent(db, { action: "open" }), (error) => error.message === "站点访问事件必须包含 site 和 action。");
  assert.throws(() => storage.recordSiteAccessEvent(db, { site: "access" }), (error) => error.message === "站点访问事件必须包含 site 和 action。");
  withDb((capDb) => {
    const insert = capDb.prepare("INSERT INTO events(job_id, event_type, payload_json, created_at) VALUES (NULL, 'site_access', ?, ?)");
    capDb.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 10_001; index += 1) insert.run(JSON.stringify({ site: "cap", action: "read", runId: "" }), `2030-01-01T00:00:${String(index % 60).padStart(2, "0")}.${String(index).padStart(3, "0")}Z`);
      capDb.exec("COMMIT");
    } catch (error) {
      capDb.exec("ROLLBACK");
      throw error;
    }
    assert.equal(storage.listSiteAccessEvents(capDb, { site: "cap", limit: 20_000 }).length, 10_000);
  });
}

function contract11TwoHandleLease() {
  const tempDbPath = path.join(ROOT, ".runtime", "scan-store-contract-lease.sqlite");
  fs.rmSync(tempDbPath, { force: true });
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(tempDbPath + suffix, { force: true });
  const dbA = storage.openDb(tempDbPath);
  const dbB = storage.openDb(tempDbPath);
  try {
    const first = storage.acquireSiteScanLease(dbA, { site: "two-handle", owner: "a", ttlMs: 60_000 });
    assertKeys(first, ["site", "owner", "command", "planId", "acquiredAt", "expiresAt"]);
    assert.throws(() => storage.acquireSiteScanLease(dbB, { site: "two-handle", owner: "b" }), (error) => error.code === "SCAN_ALREADY_RUNNING" && error.lease.owner === "a");
    assertThrowsCode(() => storage.renewSiteScanLease(dbB, { site: "two-handle", owner: "b" }), "SCAN_LEASE_LOST");
    assert.equal(storage.releaseSiteScanLease(dbA, { site: "two-handle", owner: "b" }), false);
    assert.equal(storage.releaseSiteScanLease(dbA, { site: "two-handle", owner: "a" }), true);
    assert.equal(storage.acquireSiteScanLease(dbB, { site: "two-handle", owner: "b" }).owner, "b");
    assert.equal(storage.acquireSiteScanLease(dbB, { site: "other-handle", owner: "c" }).owner, "c");
    dbB.prepare("UPDATE site_scan_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE site = 'two-handle'").run();
    assert.equal(storage.getSiteScanLease(dbB, "two-handle"), null);
  } finally {
    dbA.close();
    dbB.close();
    fs.rmSync(tempDbPath, { force: true });
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(tempDbPath + suffix, { force: true });
  }
}

function contract12ReuseRefreshAndCatalog() {
  const profileA = seedProfile(db, "detail-a");
  const profileB = seedProfile(db, "detail-b");
  const freshBatch = storage.createBatch(db, "boss", "fresh", "", { profileId: profileA, status: "completed" });
  const oldBatch = storage.createBatch(db, "boss", "old", "", { profileId: profileA, status: "completed" });
  const otherProfileBatch = storage.createBatch(db, "boss", "other-profile", "", { profileId: profileB, status: "completed" });
  const otherSiteBatch = storage.createBatch(db, "other", "other-site", "", { profileId: profileA, status: "completed" });
  const newest = job("detail-latest"); newest.title = "newest"; newest.description = "x".repeat(120); jobStore.upsertJob(db, newest, freshBatch);
  db.prepare("UPDATE job_observations SET boss_active_text = 'fresh-active' WHERE batch_id = ? AND title = 'newest'").run(freshBatch);
  const older = job("detail-latest"); older.title = "older"; older.description = "x".repeat(120); jobStore.upsertJob(db, older, oldBatch);
  db.prepare("UPDATE job_observations SET seen_at = '2020-01-01T00:00:00.000Z' WHERE batch_id = ?").run(oldBatch);
  const short = job("detail-short"); short.description = "x".repeat(119); jobStore.upsertJob(db, short, freshBatch);
  const wrongProfile = job("detail-profile"); wrongProfile.description = "x".repeat(120); jobStore.upsertJob(db, wrongProfile, otherProfileBatch);
  const wrongSite = job("detail-site", "other"); wrongSite.description = "x".repeat(120); jobStore.upsertJob(db, wrongSite, otherSiteBatch);
  const staleActivity = job("detail-stale"); staleActivity.description = "x".repeat(120); jobStore.upsertJob(db, staleActivity, freshBatch);
  db.prepare("UPDATE job_observations SET seen_at = ?, boss_active_text = 'stale-active' WHERE batch_id = ? AND title = ?").run(new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(), freshBatch, "detail-stale");
  const twoDay = job("detail-two-day"); twoDay.description = "x".repeat(120); jobStore.upsertJob(db, twoDay, freshBatch);
  db.prepare("UPDATE job_observations SET seen_at = ? WHERE batch_id = ? AND title = ?").run(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), freshBatch, "detail-two-day");
  const eightDay = job("detail-eight-day"); eightDay.description = "x".repeat(120); jobStore.upsertJob(db, eightDay, freshBatch);
  db.prepare("UPDATE job_observations SET seen_at = ? WHERE batch_id = ? AND title = ?").run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), freshBatch, "detail-eight-day");
  const details = storage.listReusableJobDetails(db, { site: "boss", profileId: profileA });
  assert.equal(details.find((row) => row.sourceId === "detail-latest").title, "newest");
  assert.equal(details.find((row) => row.sourceId === "detail-latest").bossActiveText, "fresh-active");
  assert.equal(details.some((row) => ["detail-short", "detail-profile", "detail-site", "detail-eight-day"].includes(row.sourceId)), false);
  assert.equal(details.find((row) => row.sourceId === "detail-stale").bossActiveText, "");
  assert.equal(storage.listReusableJobDetails(db, { site: "boss", profileId: profileA, maxAgeDays: 0 }).some((row) => row.sourceId === "detail-two-day"), false);
  assert.equal(storage.listReusableJobDetails(db, { site: "boss", profileId: profileA, maxAgeDays: 40 }).some((row) => row.sourceId === "detail-eight-day"), true);
  assertKeys(details[0], ["sourceId", "title", "company", "location", "salary", "experience", "education", "bossActiveText", "description", "seenAt"]);

  const jobId = Number(db.prepare("SELECT id FROM jobs WHERE source_id = 'detail-latest'").get().id);
  assert.equal(storage.recordJobRefreshAttempt(db, { jobId, result: "failed", errorCode: "E1", errorMessage: "first", nextRetryAt: "2030-01-01", createdAt: "2029-01-01" }), 1);
  assert.equal(storage.recordJobRefreshAttempt(db, { jobId, result: "ok", createdAt: "2029-01-02" }), 2);
  const refreshes = storage.listJobRefreshAttempts(db, jobId, { limit: 100 });
  assert.deepEqual(refreshes.map((row) => row.attemptNumber), [2, 1]);
  assert.equal(storage.listJobRefreshAttempts(db, jobId, { limit: 1 }).length, 1);
  assert.deepEqual(pick(refreshes[1], ["result", "errorCode", "errorMessage", "nextRetryAt"]), { result: "failed", errorCode: "E1", errorMessage: "first", nextRetryAt: "2030-01-01" });
  assertKeys(refreshes[0], ["id", "jobId", "result", "errorCode", "errorMessage", "attemptNumber", "nextRetryAt", "createdAt"]);
  assert.equal(storage.getLatestJobRefreshAttempt(db, jobId).attemptNumber, 2);
  assert.throws(() => storage.recordJobRefreshAttempt(db, { jobId: 0 }), /jobId is required/);
  assert.throws(() => storage.recordJobRefreshAttempt(db, { jobId: 99999 }), /job not found/);

  assert.equal(storage.getPlatformFilterCatalog(db, "missing"), null);
  storage.savePlatformFilterCatalog(db, { site: "boss", catalog: { city: ["GZ"] }, source: "first", discoveredAt: "2029-01-01" });
  const catalog = storage.savePlatformFilterCatalog(db, { site: "boss", catalog: { city: ["SZ"] }, source: "second", discoveredAt: "2029-01-02" });
  assertKeys(catalog, ["site", "catalog", "source", "discoveredAt", "updatedAt"]);
  assert.deepEqual(pick(catalog, ["site", "catalog", "source", "discoveredAt"]), { site: "boss", catalog: { city: ["SZ"] }, source: "second", discoveredAt: "2029-01-02" });
  assert.throws(() => storage.savePlatformFilterCatalog(db, { catalog: {} }), (error) => error.message === "platform filter catalog site is required");
  db.prepare("UPDATE platform_filter_catalogs SET catalog_json = 'bad json' WHERE site = 'boss'").run();
  assert.deepEqual(storage.getPlatformFilterCatalog(db, "boss").catalog, {});
}

function contract13FacadeConsumers() {
  const consumers = [
    "scan_cli_lifecycle_smoke.js",
    "site_access_budget_smoke.js",
    "workflow_scan_smoke.js",
    "workflow_health_smoke.js",
    "dashboard_scan_lifecycle_smoke.js",
    "storage_migration_smoke.js"
  ];
  for (const file of consumers) {
    const child = spawnSync(process.execPath, [path.join(__dirname, file)], { cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 120_000 });
    assert.equal(child.status, 0, `${file}: ${child.stderr || child.stdout}`);
  }
}

function checkpointFixture(targetDb, label) {
  const site = `checkpoint-${label}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const owner = `${site}-owner`;
  const planId = seedPlan(targetDb, site);
  const batchId = storage.createBatch(targetDb, site, "checkpoint", "", { status: "running", searchPlanId: planId });
  storage.acquireSiteScanLease(targetDb, { site, owner, planId });
  const run = storage.createScanRun(targetDb, { runId: `${site}-run`, site, planId });
  storage.beginScanRun(targetDb, { runId: run.id, batchId, leaseOwner: owner });
  return { site, owner, planId, batchId, runId: run.id };
}

function checkpointInput(fixture, target) {
  return {
    runId: fixture.runId,
    batchId: fixture.batchId,
    leaseOwner: fixture.owner,
    jobs: [job(`${fixture.runId}-job`)],
    ...(target ? { targetKey: `${fixture.runId}-target`, status: "completed", details: { checked: true } } : {})
  };
}

function observeTransactions(targetDb) {
  const transactions = [];
  return {
    transactions,
    db: new Proxy(targetDb, {
      get(target, property) {
        if (property === "exec") return (sql) => {
          const statement = String(sql).trim().toUpperCase();
          if (["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"].includes(statement)) transactions.push(statement);
          return target.exec(sql);
        };
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      }
    })
  };
}

function snapshotTables(targetDb, tables) {
  return Object.fromEntries(tables.map((table) => [table, targetDb.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

function assertKeys(value, keys) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

function assertThrowsCode(fn, code, label = code) {
  assert.throws(fn, (error) => error && error.code === code, label);
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function withDb(fn) {
  const targetDb = storage.openDb(":memory:");
  try { return fn(targetDb); } finally { targetDb.close(); }
}

function seedProfile(targetDb, label) {
  const now = new Date().toISOString();
  return Number(targetDb.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, '{}', ?, ?)").run(label, now, now).lastInsertRowid);
}

function seedPlan(targetDb, label) {
  const profileId = seedProfile(targetDb, label);
  const now = new Date().toISOString();
  return Number(targetDb.prepare("INSERT INTO search_plans(profile_id, name, plan_json, is_active, created_at, updated_at) VALUES (?, ?, '{}', 1, ?, ?)").run(profileId, label, now, now).lastInsertRowid);
}

function job(sourceId, source = "boss") {
  return {
    source, sourceId, keyword: "contract", title: sourceId, company: "Contract Co", location: "GZ", salary: "10K", experience: "1-3", education: "Bachelor",
    tags: [], description: "detail", score: 80, level: "A", matches: [], risks: [], qualityTags: [], analysis: { provider: "test", semanticStatus: "complete" }
  };
}
