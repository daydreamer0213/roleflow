const assert = require("node:assert/strict");
const {
  openDb,
  createBatch,
  createAndBindScanBatch,
  getBatch,
  createScanRun,
  getScanRun,
  beginScanRun,
  finishScanRun,
  heartbeatScanRun,
  recordScanRunProcessExit,
  interruptOrphanedScanRuns,
  checkpointScanTarget,
  upsertJob,
  acquireSiteScanLease,
  releaseSiteScanLease,
  getLatestMainScanBatchId
} = require("../src/core/storage");

const db = openDb(":memory:");

try {
  batchDefaultsSmoke();
  atomicBindSmoke();
  orphanLeaseSmoke();
  unleasedHeartbeatSmoke();
  lateProcessExitSmoke();
  checkpointLeaseLossSmoke();
  latestMainBatchSmoke();
  console.log("batch_state_consistency_smoke ok");
} finally {
  db.close();
}

function batchDefaultsSmoke() {
  const completed = getBatch(db, createBatch(db, "generic", "default", "default status"));
  assert.strictEqual(completed.status, "completed");
  assert(completed.finishedAt);

  const running = getBatch(db, createBatch(db, "generic", "running", "", { status: "running" }));
  assert.strictEqual(running.status, "running");
  assert.strictEqual(running.finishedAt, null);
  assert.strictEqual(getBatch(db, createBatch(db, "generic", "partial", "", { status: "partial" })).status, "partial");
  assert.throws(
    () => createBatch(db, "generic", "invalid", "", { status: "queued" }),
    (error) => error.code === "SCAN_BATCH_STATUS_INVALID"
  );
}

function atomicBindSmoke() {
  createScanRun(db, { runId: "leased-bind", site: "bind", command: "scan", planId: 41 });
  acquireSiteScanLease(db, { site: "bind", owner: "bind-owner", command: "scan", planId: 41 });

  const before = batchCount();
  assert.throws(() => createAndBindScanBatch(db, {
    runId: "leased-bind",
    leaseOwner: "wrong-owner",
    processId: 4100,
    site: "bind",
    keyword: "wrong",
    status: "running",
    searchPlanId: 41,
    filterSnapshot: { execution: { run: "wrong" } }
  }), (error) => error.code === "SCAN_RUN_LEASE_MISMATCH");
  assert.strictEqual(batchCount(), before);
  assert.strictEqual(getScanRun(db, "leased-bind").batchId, null);

  const batchId = createAndBindScanBatch(db, {
    runId: "leased-bind",
    leaseOwner: "bind-owner",
    processId: 4101,
    site: "bind",
    keyword: "main",
    note: "atomic",
    status: "running",
    profileId: 7,
    searchPlanId: 41,
    filterSnapshot: { execution: { run: "leased" } }
  });
  assert.strictEqual(typeof batchId, "number");
  assert.strictEqual(getScanRun(db, "leased-bind").batchId, batchId);
  assert.strictEqual(getScanRun(db, "leased-bind").leaseOwner, "bind-owner");
  assert.strictEqual(getBatch(db, batchId).status, "running");
  releaseSiteScanLease(db, { site: "bind", owner: "bind-owner" });

  createScanRun(db, { runId: "expired-bind", site: "expired", command: "scan", planId: 42 });
  acquireSiteScanLease(db, { site: "expired", owner: "expired-owner", command: "scan", planId: 42 });
  db.prepare("UPDATE site_scan_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE site = 'expired'").run();
  const expiredBefore = batchCount();
  assert.throws(() => createAndBindScanBatch(db, {
    runId: "expired-bind",
    leaseOwner: "expired-owner",
    site: "expired",
    keyword: "expired",
    status: "running",
    searchPlanId: 42
  }), (error) => error.code === "SCAN_RUN_LEASE_MISMATCH");
  assert.strictEqual(batchCount(), expiredBefore);
  assert.strictEqual(getScanRun(db, "expired-bind").batchId, null);

  createScanRun(db, { runId: "local-bind", site: "local", command: "scan" });
  const localBatchId = createAndBindScanBatch(db, {
    runId: "local-bind",
    processId: 4200,
    site: "local",
    keyword: "fixture",
    status: "running",
    filterSnapshot: { local: true }
  });
  assert.strictEqual(getScanRun(db, "local-bind").batchId, localBatchId);
  assert.strictEqual(getScanRun(db, "local-bind").leaseOwner, "");
}

function orphanLeaseSmoke() {
  const owner = "orphan-owner";
  createScanRun(db, { runId: "orphan-run", site: "orphan", command: "scan", planId: 51 });
  acquireSiteScanLease(db, { site: "orphan", owner, command: "scan", planId: 51 });
  beginScanRun(db, { runId: "orphan-run", leaseOwner: owner });
  db.prepare("UPDATE scan_runs SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = 'orphan-run'").run();

  assert.deepStrictEqual(interruptOrphanedScanRuns(db, {
    site: "orphan",
    now: new Date(),
    heartbeatTimeoutMs: 60_000
  }), { interrupted: 0, runIds: [] });
  assert.strictEqual(getScanRun(db, "orphan-run").status, "running");

  db.prepare("UPDATE site_scan_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE site = 'orphan'").run();
  assert.deepStrictEqual(interruptOrphanedScanRuns(db, {
    site: "orphan",
    now: new Date(),
    heartbeatTimeoutMs: 60_000
  }), { interrupted: 1, runIds: ["orphan-run"] });
  assert.strictEqual(getScanRun(db, "orphan-run").status, "interrupted");
  assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM site_scan_leases WHERE site = 'orphan'").get().count), 0);
}

function unleasedHeartbeatSmoke() {
  const heartbeatAt = "2030-01-01T00:00:00.000Z";
  createScanRun(db, {
    runId: "local-heartbeat-run",
    site: "local-heartbeat",
    command: "scan",
    heartbeatAt: "2000-01-01T00:00:00.000Z"
  });
  assert.throws(
    () => heartbeatScanRun(db, { runId: "local-heartbeat-run" }),
    (error) => error.code === "SCAN_RUN_LEASE_OWNER_REQUIRED"
  );
  const touched = heartbeatScanRun(db, {
    runId: "local-heartbeat-run",
    heartbeatAt,
    processId: 6100,
    allowUnleased: true
  });
  assert.strictEqual(touched.heartbeatAt, heartbeatAt);
  assert.strictEqual(touched.processId, 6100);
  assert.deepStrictEqual(interruptOrphanedScanRuns(db, {
    site: "local-heartbeat",
    now: "2030-01-01T00:01:59.000Z"
  }), { interrupted: 0, runIds: [] });
}

function lateProcessExitSmoke() {
  const batchId = createBatch(db, "resume", "main", "", {
    status: "running",
    searchPlanId: 61,
    filterSnapshot: { execution: { run: "resume" } }
  });
  createScanRun(db, { runId: "old-run", site: "resume", command: "scan", planId: 61, batchId });
  finishScanRun(db, {
    runId: "old-run",
    status: "interrupted",
    stopCode: "SCAN_RUN_ORPHANED",
    stopMessage: "old run stopped"
  });

  createScanRun(db, { runId: "resumed-run", site: "resume", command: "scan", planId: 61 });
  beginScanRun(db, { runId: "resumed-run", batchId });
  const lateFinish = finishScanRun(db, {
    runId: "old-run",
    status: "interrupted",
    stopCode: "LATE_OLD_PROCESS"
  });
  assert.strictEqual(lateFinish.stopCode, "SCAN_RUN_ORPHANED");
  assert.strictEqual(getBatch(db, batchId).status, "running");

  finishScanRun(db, { runId: "resumed-run", status: "completed" });
  assert.strictEqual(getBatch(db, batchId).status, "completed");

  const exited = recordScanRunProcessExit(db, { runId: "old-run", exitCode: 9 });
  assert.strictEqual(exited.status, "interrupted");
  assert.strictEqual(exited.stopCode, "SCAN_RUN_ORPHANED");
  assert.strictEqual(exited.processExitCode, 9);
  assert.strictEqual(getBatch(db, batchId).status, "completed");
}

function checkpointLeaseLossSmoke() {
  const owner = "checkpoint-owner";
  createScanRun(db, { runId: "checkpoint-run", site: "checkpoint", command: "scan", planId: 71 });
  acquireSiteScanLease(db, { site: "checkpoint", owner, command: "scan", planId: 71 });
  const batchId = createAndBindScanBatch(db, {
    runId: "checkpoint-run",
    leaseOwner: owner,
    site: "checkpoint",
    keyword: "checkpoint",
    status: "running",
    searchPlanId: 71,
    filterSnapshot: { execution: { run: "checkpoint" } }
  });
  db.prepare("UPDATE site_scan_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE site = 'checkpoint'").run();

  assert.throws(() => checkpointScanTarget(db, {
    runId: "checkpoint-run",
    batchId,
    leaseOwner: owner,
    targetKey: "checkpoint-target",
    status: "completed",
    jobs: []
  }), (error) => error.code === "SCAN_LEASE_LOST");
  assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM scan_target_results WHERE batch_id = ?").get(batchId).count), 0);
}

function latestMainBatchSmoke() {
  createBatch(db, "boss", "legacy", "", {
    searchPlanId: 81,
    filterSnapshot: { mode: "legacy" }
  });
  const mainBatchId = createBatch(db, "boss", "main", "", {
    searchPlanId: 81,
    filterSnapshot: { execution: { snapshotHash: "main" } }
  });
  upsertJob(db, observedJob("main-observation"), mainBatchId);
  createBatch(db, "boss", "analysis-retry", "", {
    searchPlanId: 81,
    filterSnapshot: { mode: "analysis-retry" }
  });
  createBatch(db, "boss", "empty-main", "", {
    searchPlanId: 81,
    filterSnapshot: { execution: { snapshotHash: "empty" } }
  });
  assert.strictEqual(getLatestMainScanBatchId(db, { planId: 81 }), mainBatchId);

  const otherPlanMain = createBatch(db, "boss", "other-main", "", {
    searchPlanId: 82,
    filterSnapshot: { execution: { snapshotHash: "other" } }
  });
  upsertJob(db, observedJob("other-observation"), otherPlanMain);
  assert.strictEqual(getLatestMainScanBatchId(db, { planId: 81 }), mainBatchId);
  assert.strictEqual(getLatestMainScanBatchId(db), otherPlanMain);
  assert.strictEqual(getLatestMainScanBatchId(db, { planId: 83 }), null);
}

function observedJob(sourceId) {
  return {
    source: "boss",
    sourceId,
    keyword: "main",
    title: "Observed Job",
    company: "Test Co",
    location: "Guangzhou",
    tags: [],
    description: "Observed job description",
    matches: [],
    risks: [],
    qualityTags: [],
    analysis: {}
  };
}

function batchCount() {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM batches").get().count);
}
