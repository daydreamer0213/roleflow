const assert = require("node:assert/strict");
const {
  resolveScanKind,
  resolveDetailMode,
  resolveProductDetailMode,
  buildScanCliArgs,
  withSiteScanLease
} = require("../src/core/scan_execution");

main()
  .then(() => console.log("scan_execution_smoke ok"))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });

async function main() {
  scanKindSmoke();
  productDetailModeSmoke();
  cliArgsMatrixSmoke();
  await normalReleaseSmoke();
  await leaseLossSmoke(() => { throw new Error("renew failed"); });
  await leaseLossSmoke(() => ({ owner: "another-owner" }));
  await leaseLossWaitsForCleanupSmoke();
}

function productDetailModeSmoke() {
  assert.strictEqual(resolveDetailMode("search_page_api"), "search_page_api", "研究/历史模式标识必须保留");
  assert.strictEqual(resolveProductDetailMode(undefined), "trusted_pane");
  assert.strictEqual(resolveProductDetailMode("trusted_pane"), "trusted_pane");
  assert.throws(
    () => resolveProductDetailMode("search_page_api"),
    (error) => error.code === "PRODUCT_DETAIL_MODE_UNSUPPORTED"
      && error.statusCode === 409
      && /trusted_pane/.test(error.message)
  );
}

function scanKindSmoke() {
  assert.strictEqual(resolveScanKind("scan", {}), "daily");
  assert.strictEqual(resolveScanKind("scan", { "scan-mode": "daily" }), "daily");
  assert.strictEqual(resolveScanKind("scan", { scanMode: "broad" }), "broad");
  assert.strictEqual(resolveScanKind("refresh-details", {}), "refresh");
  assert.strictEqual(resolveScanKind("refresh-activity", {}), "activity");
  assert.throws(
    () => resolveScanKind("scan", { "scan-mode": "unknown" }),
    (error) => error.code === "UNKNOWN_SCAN_KIND"
  );
}

function cliArgsMatrixSmoke() {
  const dbPath = "D:\\RoleFlow data\\jobs.sqlite";
  const common = {
    dbPath,
    planId: 42,
    cdpPort: 9333,
    runId: "run-smoke",
    maxCards: 999,
    maxDetails: 999,
    limit: 999
  };
  const expectedByKind = {
    daily: ["scan", "--db", dbPath, "--plan", "42", "--run-id", "run-smoke", "--site", "boss", "--scan-mode", "daily"],
    broad: ["scan", "--db", dbPath, "--plan", "42", "--run-id", "run-smoke", "--site", "boss", "--scan-mode", "broad"],
    refresh: ["refresh-details", "--db", dbPath, "--plan", "42", "--run-id", "run-smoke"],
    activity: ["refresh-activity", "--db", dbPath, "--plan", "42", "--run-id", "run-smoke"]
  };

  for (const kind of ["daily", "broad", "refresh", "activity"]) {
    for (const browserMode of ["edge", "portable"]) {
      const actual = buildScanCliArgs({ ...common, kind, browserMode });
      const browserArgs = browserMode === "edge"
        ? ["--browser", "edge"]
        : ["--browser", "portable", "--cdp-port", "9333"];
      assert.deepStrictEqual(actual, [...expectedByKind[kind], ...browserArgs]);
      assert(!actual.includes("--max-cards"));
      assert(!actual.includes("--max-details"));
      assert(!actual.includes("--limit"));
      assert(!actual.includes("--detail-mode"));
    }
  }

  assert.throws(
    () => buildScanCliArgs({ ...common, kind: "unknown", browserMode: "edge" }),
    (error) => error.code === "UNKNOWN_SCAN_KIND"
  );
  assert.deepStrictEqual(
    buildScanCliArgs({ ...common, kind: "daily", browserMode: "edge", resumeBatchId: 73 }),
    [...expectedByKind.daily, "--resume-batch", "73", "--browser", "edge"]
  );
  assert.throws(
    () => buildScanCliArgs({ ...common, kind: "daily", browserMode: "edge", detailMode: "search_page_api" }),
    (error) => error.code === "PRODUCT_DETAIL_MODE_UNSUPPORTED" && error.statusCode === 409
  );
  assert.deepStrictEqual(
    buildScanCliArgs({ ...common, kind: "daily", browserMode: "edge", detailMode: "trusted_pane" }),
    [...expectedByKind.daily, "--detail-mode", "trusted_pane", "--browser", "edge"]
  );
  assert.throws(
    () => buildScanCliArgs({ ...common, kind: "daily", browserMode: "edge", detailMode: "unsafe_fallback" }),
    (error) => error.code === "INVALID_DETAIL_MODE"
  );
  assert.deepStrictEqual(
    buildScanCliArgs({
      ...common,
      kind: "daily",
      browserMode: "edge",
      workflowRunId: "workflow-run-1",
      keywords: ["Agent engineer", "AI knowledge base"],
      maxCards: 50,
      maxDetailTotal: 120,
      browserPageBudget: 20
    }),
    [
      ...expectedByKind.daily,
      "--workflow-run", "workflow-run-1",
      "--keywords", "Agent engineer,AI knowledge base",
      "--max-cards", "50",
      "--max-detail-total", "120",
      "--browser-page-budget", "20",
      "--browser", "edge"
    ]
  );
  assert.deepStrictEqual(
    buildScanCliArgs({
      kind: "daily",
      dbPath,
      planId: 42,
      runId: "analysis-only-run",
      workflowRunId: "workflow-run-analysis",
      analysisOnly: true
    }),
    [
      "scan",
      "--db", dbPath,
      "--plan", "42",
      "--run-id", "analysis-only-run",
      "--site", "boss",
      "--scan-mode", "daily",
      "--workflow-run", "workflow-run-analysis",
      "--analysis-only"
    ]
  );
  assert.throws(
    () => buildScanCliArgs({ ...common, kind: "daily", browserMode: "edge", workflowRunId: "workflow-run-1" }),
    (error) => error.code === "INVALID_SCAN_INPUT"
  );
  assert.throws(
    () => buildScanCliArgs({ ...common, kind: "refresh", browserMode: "edge", resumeBatchId: 73 }),
    (error) => error.code === "INVALID_SCAN_INPUT"
  );
}

async function normalReleaseSmoke() {
  const calls = [];
  let cleared = false;
  let signal;
  const result = await withSiteScanLease({
    acquire(input) {
      calls.push(["acquire", input]);
      return { site: "boss", owner: "owner-a" };
    },
    renew(input) {
      calls.push(["renew", input]);
      return { owner: "owner-a" };
    },
    release(input) {
      calls.push(["release", input]);
      return true;
    },
    setInterval(callback, intervalMs) {
      calls.push(["schedule", intervalMs, callback]);
      return { unref() { calls.push(["unref"]); } };
    },
    clearInterval() {
      cleared = true;
    }
  }, {
    site: "boss",
    owner: "owner-a",
    command: "scan",
    planId: 42,
    renewIntervalMs: 25
  }, async (abortSignal) => {
    signal = abortSignal;
    return "completed";
  });

  assert.strictEqual(result, "completed");
  assert(signal instanceof AbortSignal);
  assert.strictEqual(signal.aborted, false);
  assert.strictEqual(cleared, true);
  assert.deepStrictEqual(calls[0], ["acquire", { site: "boss", owner: "owner-a", command: "scan", planId: 42 }]);
  assert.deepStrictEqual(calls.find(([kind]) => kind === "release"), ["release", { site: "boss", owner: "owner-a" }]);
}

async function leaseLossSmoke(renew) {
  let heartbeat;
  let released;
  let signal;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const execution = withSiteScanLease({
    acquire: () => ({ site: "boss", owner: "owner-a" }),
    renew,
    release(input) {
      released = input;
      return true;
    },
    setInterval(callback) {
      heartbeat = callback;
      return 1;
    },
    clearInterval() {}
  }, {
    site: "boss",
    owner: "owner-a",
    command: "scan",
    planId: 42,
    renewIntervalMs: 1
  }, (abortSignal) => {
    signal = abortSignal;
    markStarted();
    return new Promise((resolve, reject) => {
      abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
    });
  });

  await started;
  await heartbeat();
  await assert.rejects(execution, (error) => error.code === "SCAN_LEASE_LOST");
  assert.strictEqual(signal.aborted, true);
  assert.strictEqual(signal.reason.code, "SCAN_LEASE_LOST");
  assert.deepStrictEqual(released, { site: "boss", owner: "owner-a" });
}

async function leaseLossWaitsForCleanupSmoke() {
  let heartbeat;
  let cleanupFinished = false;
  let finishCleanup;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const cleanup = new Promise((resolve) => { finishCleanup = resolve; });
  const execution = withSiteScanLease({
    acquire: () => ({ site: "boss", owner: "owner-a" }),
    renew: () => { throw new Error("renew failed"); },
    release: () => true,
    setInterval(callback) {
      heartbeat = callback;
      return 1;
    },
    clearInterval() {}
  }, {
    site: "boss",
    owner: "owner-a",
    command: "scan",
    planId: 42
  }, async (signal) => {
    markStarted();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    await cleanup;
    cleanupFinished = true;
  });

  await started;
  await heartbeat();
  let settled = false;
  execution.finally(() => { settled = true; }).catch(() => {});
  await Promise.resolve();
  assert.strictEqual(settled, false);
  finishCleanup();
  await assert.rejects(execution, (error) => error.code === "SCAN_LEASE_LOST");
  assert.strictEqual(cleanupFinished, true);
}
