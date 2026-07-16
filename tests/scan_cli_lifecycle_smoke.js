const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  executeWithSiteScanLease,
  resolveResumeBatch,
  resolveScanTerminalStatus,
  resolveScanLimit,
  persistRefreshAttempt,
  assertScanLimitOverridesAllowed
} = require("../src/cli");
const {
  openDb,
  createBatch,
  beginScanRun,
  getScanRun,
  getSiteScanLease,
  getLatestResumableBatch,
  recordScanTargetResult,
  upsertJob,
  listReportJobs,
  getLatestJobRefreshAttempt
} = require("../src/core/storage");
const { buildScanExecutionSnapshot } = require("../src/core/scan_snapshot");

const smokeDir = path.join(__dirname, "..", ".runtime", "smoke");
const dbPath = path.join(smokeDir, `scan-cli-lifecycle-${Date.now()}.sqlite`);
let db;

main()
  .then(() => console.log("scan_cli_lifecycle_smoke ok"))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    db?.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* no-op */ }
    }
  });

async function main() {
  fs.mkdirSync(smokeDir, { recursive: true });
  db = openDb(dbPath);
  await completedRunSmoke();
  await partialRunWithBatchSmoke();
  await interruptedRunSmoke();
  await failedRunSmoke();
  await localInputRunSmoke();
  resumeBatchSmoke();
  terminalAggregationSmoke();
  scanLimitSmoke();
  refreshCheckpointSmoke();
}

async function completedRunSmoke() {
  const runId = "cli-completed";
  const result = await executeWithSiteScanLease(db, { "run-id": runId }, "scan", async (signal, execution) => {
    assert.strictEqual(signal.aborted, false);
    assert.strictEqual(execution.runId, runId);
    assert.strictEqual(execution.scanKind, "daily");
    return { status: "completed" };
  });
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(getScanRun(db, runId).status, "completed");
  assert.strictEqual(getSiteScanLease(db, "boss"), null);
}

async function partialRunWithBatchSmoke() {
  const runId = "cli-partial";
  let batchId;
  await executeWithSiteScanLease(db, { "run-id": runId, "scan-mode": "broad" }, "scan", async (_signal, execution) => {
    batchId = createBatch(db, "boss", "partial", "partial smoke");
    beginScanRun(db, {
      runId,
      batchId,
      leaseOwner: execution.leaseOwner,
      processId: process.pid
    });
    return { status: "partial", batchId, stopCode: "SCAN_TARGETS_PARTIAL" };
  });
  const run = getScanRun(db, runId);
  assert.strictEqual(run.status, "partial");
  assert.strictEqual(run.batchId, batchId);
  assert.strictEqual(run.stopCode, "SCAN_TARGETS_PARTIAL");
  assert.strictEqual(db.prepare("SELECT status FROM batches WHERE id = ?").get(batchId).status, "partial");
}

async function interruptedRunSmoke() {
  const runId = "cli-interrupted";
  await assert.rejects(() => executeWithSiteScanLease(db, { "run-id": runId }, "scan", async () => {
    const error = new Error("edge timed out");
    error.code = "BROWSER_TIMEOUT";
    throw error;
  }), (error) => error.code === "BROWSER_TIMEOUT");
  assert.strictEqual(getScanRun(db, runId).status, "interrupted");
  assert.strictEqual(getSiteScanLease(db, "boss"), null);
}

async function failedRunSmoke() {
  const runId = "cli-failed";
  await assert.rejects(() => executeWithSiteScanLease(db, { "run-id": runId }, "scan", async () => {
    const error = new Error("checkpoint failed");
    error.code = "SCAN_CHECKPOINT_FAILED";
    throw error;
  }), (error) => error.code === "SCAN_CHECKPOINT_FAILED");
  assert.strictEqual(getScanRun(db, runId).status, "failed");
  assert.strictEqual(getSiteScanLease(db, "boss"), null);
}

async function localInputRunSmoke() {
  const runId = "cli-local-input";
  const result = await executeWithSiteScanLease(db, { "run-id": runId, input: "fixture.json" }, "scan", async (signal, execution) => {
    assert.strictEqual(signal, null);
    assert.strictEqual(execution.runId, runId);
    assert.strictEqual(execution.leaseOwner, "");
    assert.strictEqual(getSiteScanLease(db, "boss"), null);
    return { status: "completed" };
  });
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(getScanRun(db, runId).status, "completed");
  assert.strictEqual(getSiteScanLease(db, "boss"), null);
}

function resumeBatchSmoke() {
  const planId = 77;
  const snapshot = buildScanExecutionSnapshot({
    site: "boss",
    scanKind: "daily",
    runtimePolicyHash: "resume-policy",
    cityScopes: [{ city: "Guangzhou", cityCode: "101280100" }],
    keywordPlan: [{ word: "RAG", priority: "A" }, { word: "Agent", priority: "B" }],
    nativeFilters: { lanes: [{ id: "main", rank: 0, params: { salary: ["405"] } }] },
    limits: { maxCards: 50, maxDetailTotal: 80, browserPageBudget: 20, detailLimits: { A: 40, B: 30 } }
  });
  const batchId = createBatch(db, "boss", "resume", "resume smoke", {
    searchPlanId: planId,
    filterSnapshot: { execution: snapshot }
  });
  db.prepare("UPDATE batches SET status = 'interrupted' WHERE id = ?").run(batchId);
  recordScanTargetResult(db, {
    batchId,
    targetKey: snapshot.targets[0].targetKey,
    status: "completed",
    jobCount: 4
  });
  recordScanTargetResult(db, {
    batchId,
    targetKey: snapshot.targets[1].targetKey,
    status: "partial",
    jobCount: 2
  });

  const resolved = resolveResumeBatch(db, {
    resumeBatchId: batchId,
    site: "boss",
    planId,
    executionSnapshot: snapshot
  });
  assert.strictEqual(getLatestResumableBatch(db, { planId, site: "boss" }).id, batchId);
  assert.deepStrictEqual(resolved.targetKeys, [snapshot.targets[1].targetKey]);
  assert.deepStrictEqual(resolved.progress, {
    total: 2,
    completed: 1,
    pending: 1,
    partial: 1,
    failed: 0,
    targetKeys: [snapshot.targets[1].targetKey]
  });

  assert.throws(() => resolveResumeBatch(db, {
    resumeBatchId: batchId,
    site: "boss",
    planId: planId + 1,
    executionSnapshot: snapshot
  }), (error) => error.code === "SCAN_RESUME_BATCH_MISMATCH");
  const changed = buildScanExecutionSnapshot({
    site: "boss",
    scanKind: "daily",
    runtimePolicyHash: "resume-policy",
    cityScopes: [{ city: "Guangzhou", cityCode: "101280100" }],
    keywordPlan: [{ word: "RAG", priority: "A" }, { word: "Agent", priority: "B" }],
    nativeFilters: { lanes: [{ id: "main", rank: 0, params: { salary: ["405"] } }] },
    limits: { maxCards: 40, maxDetailTotal: 80, browserPageBudget: 20, detailLimits: { A: 40, B: 30 } }
  });
  assert.throws(() => resolveResumeBatch(db, {
    resumeBatchId: batchId,
    site: "boss",
    planId,
    executionSnapshot: changed
  }), (error) => error.code === "SCAN_SNAPSHOT_MISMATCH");
}

function terminalAggregationSmoke() {
  assert.strictEqual(resolveScanTerminalStatus({
    targetSummary: { pending: 0, completed: 2, partial: 0, failed: 0 }
  }), "completed");
  assert.strictEqual(resolveScanTerminalStatus({
    targetSummary: { pending: 1, completed: 1, partial: 0, failed: 1 }
  }), "partial");
  assert.strictEqual(resolveScanTerminalStatus({
    targetSummary: { pending: 2, completed: 0, partial: 0, failed: 2 }
  }), "failed");
  assert.strictEqual(resolveScanTerminalStatus({
    targetSummary: { pending: 2, completed: 0, partial: 0, failed: 0 },
    scanSummary: { status: "failed", fatalErrorCode: "BROWSER_DISCONNECTED" }
  }), "interrupted");
}

function scanLimitSmoke() {
  assert.strictEqual(resolveScanLimit({ "max-cards": "10" }, "max-cards", 50, 50, "maxCards"), 10);
  assert.strictEqual(resolveScanLimit({ "max-cards": "200" }, "max-cards", 50, 50, "maxCards"), 200);
  assert.throws(
    () => resolveScanLimit({ "max-cards": "9" }, "max-cards", 50, 50, "maxCards"),
    (error) => error.code === "INVALID_SCAN_LIMIT"
  );
  assert.throws(
    () => resolveScanLimit({ "max-detail-total": "1000.5" }, "max-detail-total", 220, 220, "maxDetailTotal"),
    (error) => error.code === "INVALID_SCAN_LIMIT"
  );
  assert.throws(
    () => assertScanLimitOverridesAllowed({ "max-cards": "10" }, "daily"),
    (error) => error.code === "DAILY_SCAN_LIMIT_OVERRIDE"
  );
  assert.doesNotThrow(() => assertScanLimitOverridesAllowed({ "max-cards": "10" }, "broad"));
  assert.doesNotThrow(() => assertScanLimitOverridesAllowed({}, "daily"));
}

function refreshCheckpointSmoke() {
  const sourceBatchId = createBatch(db, "boss", "refresh-source", "refresh-source");
  const jobId = upsertJob(db, refreshJob("refresh-checkpoint", "old detail"), sourceBatchId);
  const refreshBatchId = createBatch(db, "boss", "activity-probe", "refresh", { status: "running" });
  const nextRetryAt = persistRefreshAttempt(db, {
    job: { id: jobId },
    refreshedJob: refreshJob("refresh-checkpoint", "saved before later failure"),
    result: "success"
  }, { batchId: refreshBatchId, activityOnly: true });
  assert(Date.parse(nextRetryAt) > Date.now());
  assert.strictEqual(getLatestJobRefreshAttempt(db, jobId).result, "success");
  assert.strictEqual(listReportJobs(db, { batchId: refreshBatchId })[0].description, "saved before later failure");

  const failedJobId = upsertJob(db, refreshJob("refresh-checkpoint-failure", "old"), sourceBatchId);
  const failedBatchId = createBatch(db, "boss", "detail-refresh", "refresh-failure", { status: "running" });
  db.exec(`CREATE TEMP TRIGGER fail_refresh_observation
    BEFORE INSERT ON job_observations
    WHEN NEW.batch_id = ${failedBatchId}
    BEGIN SELECT RAISE(ABORT, 'injected refresh checkpoint failure'); END`);
  assert.throws(() => persistRefreshAttempt(db, {
    job: { id: failedJobId },
    refreshedJob: refreshJob("refresh-checkpoint-failure", "must not be marked successful"),
    result: "success"
  }, { batchId: failedBatchId }), /injected refresh checkpoint failure/);
  assert.strictEqual(getLatestJobRefreshAttempt(db, failedJobId), null);
  db.exec("DROP TRIGGER fail_refresh_observation");
}

function refreshJob(sourceId, description) {
  return {
    source: "boss",
    sourceId,
    keyword: "refresh",
    title: "Refresh Job",
    company: "Refresh Co",
    location: "Guangzhou",
    salary: "10-20K",
    experience: "1-3 years",
    education: "Bachelor",
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
    description,
    score: 10,
    level: "可投",
    matches: ["Python"],
    risks: [],
    qualityTags: [],
    analysis: { semanticStatus: "complete", recommendation: "apply", fitLevel: "B", evidence: { jd: [], resume: [] } }
  };
}
