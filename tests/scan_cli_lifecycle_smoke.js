const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { executeWithSiteScanLease, resolveResumeBatch } = require("../src/cli");
const {
  openDb,
  createBatch,
  beginScanRun,
  getScanRun,
  getSiteScanLease,
  getLatestResumableBatch,
  recordScanTargetResult
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
  resumeBatchSmoke();
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
