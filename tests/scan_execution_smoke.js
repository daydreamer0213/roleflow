const assert = require("node:assert/strict");
const {
  resolveScanKind,
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
  cliArgsMatrixSmoke();
  await normalReleaseSmoke();
  await leaseLossSmoke(() => { throw new Error("renew failed"); });
  await leaseLossSmoke(() => ({ owner: "another-owner" }));
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
    }
  }

  assert.throws(
    () => buildScanCliArgs({ ...common, kind: "unknown", browserMode: "edge" }),
    (error) => error.code === "UNKNOWN_SCAN_KIND"
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
