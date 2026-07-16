const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  openDb,
  createScanRun,
  getLatestScanRun,
  finishScanRun,
  acquireSiteScanLease
} = require("../src/core/storage");
const {
  createDashboardServer,
  startPlanScan,
  scanStatus
} = require("../src/dashboard/server");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `dashboard-scan-lifecycle-${Date.now()}.sqlite`);
const logger = {
  info() {},
  warn() {},
  error() {},
  requestId() { return "dashboard-scan-lifecycle-smoke"; },
  listRecent() { return []; }
};
let db;

try {
  fs.mkdirSync(smokeDir, { recursive: true });
  db = openDb(dbPath);
  commandAndSuccessfulExitSmoke(db);
  failedAndInterruptedExitSmoke(db);
  orphanRecheckSmoke(db);
  restartRecoveryAndOrphanCleanupSmoke(db);
  console.log("dashboard_scan_lifecycle_smoke ok");
} finally {
  if (db) db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* no-op */ }
  }
}

function commandAndSuccessfulExitSmoke(database) {
  const expectedCommand = {
    daily: "scan",
    broad: "scan",
    refresh: "refresh-details",
    activity: "refresh-activity"
  };
  const calls = [];

  for (const [index, kind] of ["daily", "broad", "refresh", "activity"].entries()) {
    const planId = 100 + index;
    const spawnProcess = spawnHarness(database, planId, calls);
    const scanRuns = new Map();
    const run = startPlanScan(scanRuns, {
      db: database,
      root,
      dbPath,
      planId,
      cdpPort: 9333,
      browserMode: index % 2 ? "portable" : "edge",
      scanKind: kind,
      logger,
      requestId: `request-${kind}`,
      spawnProcess
    });
    const call = calls.at(-1);
    const cliArgs = call.args.slice(2);
    assert.strictEqual(cliArgs[0], expectedCommand[kind]);
    assert.strictEqual(cliArgs[cliArgs.indexOf("--run-id") + 1], run.runId);
    assert.match(run.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert(!cliArgs.includes("--max-cards"));
    assert(!cliArgs.includes("--max-details"));
    assert(!cliArgs.includes("--limit"));
    if (kind === "daily" || kind === "broad") {
      assert.strictEqual(cliArgs[cliArgs.indexOf("--scan-mode") + 1], kind);
    }

    call.child.stdout.emit("data", `output-${kind}`);
    assert.strictEqual(scanStatus(scanRuns, planId, database).output, `output-${kind}`);
    call.child.emit("close", 0, null);
    const persisted = getLatestScanRun(database, { planId, site: "boss" });
    assert.strictEqual(persisted.status, "completed");
    assert.strictEqual(persisted.site, "boss");
    assert.strictEqual(persisted.command, kind);
    assert.strictEqual(persisted.planId, planId);
    assert.strictEqual(scanStatus(new Map(), planId, database).state, "completed");
    assert.strictEqual(scanStatus(new Map(), planId, database).recovered, true);
  }

  const resumeCalls = [];
  startPlanScan(new Map(), {
    db: database,
    root,
    dbPath,
    planId: 150,
    cdpPort: 9222,
    browserMode: "edge",
    scanKind: "daily",
    resumeBatchId: 88,
    logger,
    requestId: "request-resume",
    spawnProcess: spawnHarness(database, 150, resumeCalls)
  });
  const resumeArgs = resumeCalls[0].args.slice(2);
  assert.strictEqual(resumeArgs[resumeArgs.indexOf("--resume-batch") + 1], "88");
  resumeCalls[0].child.emit("close", 7, null);
}

function failedAndInterruptedExitSmoke(database) {
  const failed = launch(database, 201);
  failed.child.emit("close", 7, null);
  assert.strictEqual(getLatestScanRun(database, { planId: 201, site: "boss" }).status, "failed");

  const interrupted = launch(database, 202);
  interrupted.child.emit("close", null, "SIGTERM");
  assert.strictEqual(getLatestScanRun(database, { planId: 202, site: "boss" }).status, "interrupted");

  const errored = launch(database, 203);
  errored.child.emit("error", new Error("spawn failed"));
  errored.child.emit("close", 9, null);
  const persisted = getLatestScanRun(database, { planId: 203, site: "boss" });
  assert.strictEqual(persisted.status, "failed");
  assert.strictEqual(persisted.stopCode, "SCAN_PROCESS_ERROR");
  assert.strictEqual(persisted.processExitCode, null);

  const partial = launch(database, 204);
  finishScanRun(database, {
    runId: partial.runId,
    status: "partial",
    stopCode: "SCAN_TARGETS_PARTIAL"
  });
  partial.child.emit("close", 0, null);
  const partialPersisted = getLatestScanRun(database, { planId: 204, site: "boss" });
  assert.strictEqual(partialPersisted.status, "partial");
  assert.strictEqual(partialPersisted.stopCode, "SCAN_TARGETS_PARTIAL");
}

function orphanRecheckSmoke(database) {
  const staleAt = "2000-01-01T00:00:00.000Z";
  createScanRun(database, {
    runId: "dashboard-status-stale-run",
    site: "boss",
    command: "daily",
    planId: 310,
    createdAt: staleAt,
    heartbeatAt: staleAt
  });
  const status = scanStatus(new Map(), 310, database);
  assert.strictEqual(status.state, "interrupted");
  assert.strictEqual(database.prepare("SELECT status FROM scan_runs WHERE id = ?").get("dashboard-status-stale-run").status, "interrupted");

  createScanRun(database, {
    runId: "dashboard-start-stale-run",
    site: "boss",
    command: "daily",
    planId: 311,
    createdAt: staleAt,
    heartbeatAt: staleAt
  });
  const started = launch(database, 311);
  assert.strictEqual(database.prepare("SELECT status FROM scan_runs WHERE id = ?").get("dashboard-start-stale-run").status, "interrupted");
  started.child.emit("close", 0, null);
}

function restartRecoveryAndOrphanCleanupSmoke(database) {
  const staleAt = "2000-01-01T00:00:00.000Z";
  createScanRun(database, {
    runId: "dashboard-stale-run",
    site: "boss",
    command: "activity",
    planId: 301,
    createdAt: staleAt,
    heartbeatAt: staleAt
  });
  createScanRun(database, {
    runId: "dashboard-fresh-run",
    site: "boss",
    command: "daily",
    planId: 302,
    heartbeatAt: new Date().toISOString()
  });
  acquireSiteScanLease(database, {
    site: "boss",
    owner: "dashboard-fresh-owner",
    command: "daily",
    planId: 302,
    ttlMs: 10 * 60 * 1000
  });

  createDashboardServer({ db: database, root, dbPath, logger });
  assert.strictEqual(getLatestScanRun(database, { planId: 301, site: "boss" }).status, "interrupted");
  assert.strictEqual(getLatestScanRun(database, { planId: 302, site: "boss" }).status, "running");
  const recovered = scanStatus(new Map(), 302, database);
  assert.strictEqual(recovered.state, "running");
  assert.strictEqual(recovered.kind, "daily");
  assert.strictEqual(recovered.recovered, true);
}

function launch(database, planId) {
  const calls = [];
  startPlanScan(new Map(), {
    db: database,
    root,
    dbPath,
    planId,
    cdpPort: 9222,
    browserMode: "edge",
    scanKind: "daily",
    logger,
    requestId: `request-${planId}`,
    spawnProcess: spawnHarness(database, planId, calls)
  });
  return calls[0];
}

function spawnHarness(database, planId, calls) {
  return (command, args, options) => {
    const persisted = getLatestScanRun(database, { planId, site: "boss" });
    assert(persisted, "scan run must exist before spawn");
    assert.strictEqual(persisted.status, "running");
    const child = new EventEmitter();
    child.pid = 4000 + planId;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    calls.push({ command, args, options, child, runId: persisted.runId });
    return child;
  };
}
