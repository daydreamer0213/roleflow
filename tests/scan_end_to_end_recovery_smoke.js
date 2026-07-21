const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

if (process.env.ROLEFLOW_SCAN_E2E_ADAPTER === "1") {
  installOfflineBoundaries();
} else {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-scan-e2e-"));
  const dbPath = path.join(tempDir, "jobs.sqlite");
  let db;
  try {
    const storage = require("../src/core/storage");
    db = storage.openDb(dbPath);
    const { profileId, planId } = storage.saveProfileAnalysis(db, fixtureProfile());
    const otherPlanId = storage.saveSearchPlan(db, {
      profileId,
      plan: { ...fixturePlan(), name: "Other recovery plan" }
    });
    db.close();
    db = null;

    const first = runScan(dbPath, planId, "scan-e2e-first", "interrupt");
    assertExit(first, 1, "injected interruption");

    db = storage.openDb(dbPath);
    const batch = db.prepare("SELECT id FROM batches ORDER BY id").get();
    assert(batch, "first production scan must create a batch");
    const batchId = Number(batch.id);
    const storedBatch = storage.getBatch(db, batchId);
    const snapshot = storedBatch.filterSnapshot.execution;
    assert(snapshot?.targets?.length >= 2, "fixture must produce at least two scan targets");
    assert.strictEqual(storedBatch.status, "interrupted");
    assert.strictEqual(storage.getScanRun(db, "scan-e2e-first").batchId, batchId);
    assert.strictEqual(storage.getScanRun(db, "scan-e2e-first").status, "interrupted");
    assert.deepStrictEqual(
      storage.listLatestScanTargetResults(db, batchId).map((item) => item.targetKey),
      [snapshot.targets[0].targetKey]
    );
    db.close();
    db = null;

    const wrongPlan = runScan(dbPath, otherPlanId, "scan-e2e-wrong-plan", "complete", {
      resumeBatchId: batchId
    });
    assertExit(wrongPlan, 1, "cross-plan resume rejection");

    const changedSnapshot = runScan(dbPath, planId, "scan-e2e-changed-snapshot", "complete", {
      resumeBatchId: batchId,
      maxCards: 11
    });
    assertExit(changedSnapshot, 1, "changed-snapshot resume rejection");

    db = storage.openDb(dbPath);
    assert.strictEqual(storage.getScanRun(db, "scan-e2e-wrong-plan").stopCode, "SCAN_RESUME_BATCH_MISMATCH");
    assert.strictEqual(storage.getScanRun(db, "scan-e2e-wrong-plan").batchId, null);
    assert.strictEqual(storage.getScanRun(db, "scan-e2e-changed-snapshot").stopCode, "SCAN_SNAPSHOT_MISMATCH");
    assert.strictEqual(storage.getScanRun(db, "scan-e2e-changed-snapshot").batchId, null);
    assert.strictEqual(storage.getBatch(db, batchId).status, "interrupted");
    assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM batches").get().count), 1);
    db.close();
    db = null;

    const resumed = runScan(dbPath, planId, "scan-e2e-resumed", "complete", {
      resumeBatchId: batchId
    });
    assertExit(resumed, 0, "explicit resume");

    db = storage.openDb(dbPath);
    const results = storage.listScanTargetResults(db, batchId);
    assert.strictEqual(storage.getScanRun(db, "scan-e2e-resumed").batchId, batchId);
    assert.strictEqual(storage.getScanRun(db, "scan-e2e-resumed").status, "completed");
    assert.strictEqual(storage.getBatch(db, batchId).status, "completed");
    assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM batches").get().count), 1);
    assert.strictEqual(results.length, snapshot.targets.length, "each target must checkpoint exactly once");
    assert.deepStrictEqual(results.map((item) => item.targetKey).sort(), snapshot.targets.map((item) => item.targetKey).sort());
    assert(results.every((item) => item.status === "completed" && item.attemptNumber === 1));
    assert.strictEqual(results.filter((item) => item.targetKey === snapshot.targets[0].targetKey).length, 1,
      "the target completed before interruption must not run again");
    assert.deepStrictEqual(storage.listLatestScanTargetResults(db, batchId).map((item) => item.status),
      snapshot.targets.map(() => "completed"));
    assert.strictEqual(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    console.log("scan_end_to_end_recovery_smoke ok");
  } finally {
    db?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runScan(dbPath, planId, runId, mode, { resumeBatchId = null, maxCards = 10 } = {}) {
  const args = [
    "--require", __filename,
    path.join(root, "src", "cli.js"),
    "scan", "--db", dbPath,
    "--plan", String(planId),
    "--run-id", runId,
    "--site", "boss",
    "--scan-mode", "broad",
    "--browser", "edge",
    "--max-cards", String(maxCards),
    "--max-detail-total", "4",
    "--browser-page-budget", "20",
    "--refresh-platform-filters"
  ];
  if (resumeBatchId) args.push("--resume-batch", String(resumeBatchId));
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      ROLEFLOW_SCAN_E2E_ADAPTER: "1",
      ROLEFLOW_SCAN_E2E_MODE: mode
    }
  });
}

function assertExit(result, expected, label) {
  assert.strictEqual(result.signal, null, `${label} received ${result.signal || result.error?.message}`);
  assert.strictEqual(result.status, expected, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function fixtureProfile() {
  return {
    profile: {
      candidate: { name: "Recovery Smoke", city: "广州", targetTitles: ["AI应用开发"], expectedSalary: "10-20K" },
      skills: [{ name: "Python", evidence: ["offline fixture"] }],
      projects: [{ name: "RoleFlow", roleBoundary: "independent", canSay: ["Python", "RAG"] }]
    },
    document: {
      originalFileName: "recovery-smoke.txt",
      format: "text",
      contentHash: "scan-end-to-end-recovery-smoke",
      text: "Python RAG Agent offline recovery smoke fixture",
      diagnostics: {}
    },
    searchPlan: fixturePlan()
  };
}

function fixturePlan() {
  return {
    name: "Recovery smoke plan",
    cities: ["广州"],
    directions: ["AI应用开发"],
    keywords: [{ word: "RAG", priority: "A" }, { word: "Agent", priority: "B" }],
    salary: { minK: 10, maxK: 20 },
    experience: ["1-3年"],
    jobTypes: ["全职"],
    platform: { site: "boss" },
    bossActiveDays: 3
  };
}

function installOfflineBoundaries() {
  const Module = require("node:module");
  const bossPath = require.resolve("../src/adapters/sites/boss");
  const reportsPath = require.resolve("../src/reports/render");
  const observabilityPath = require.resolve("../src/core/observability");
  const modelSettingsPath = require.resolve("../src/core/model_settings");
  const boss = require(bossPath);
  const observability = require(observabilityPath);
  const modelSettings = require(modelSettingsPath);
  const originalLoad = Module._load;
  const logger = { child: () => logger, debug() {}, info() {}, warn() {}, error() {} };

  class OfflineBossSiteAdapter {
    async preflight() {
      return { tabId: "offline-boss-tab" };
    }

    async discoverFilterCatalog() {
      return { site: "boss", source: "offline-smoke", discoveredAt: new Date().toISOString(), fields: {} };
    }

    async scan(options) {
      const requested = Array.isArray(options.targetKeys) ? new Set(options.targetKeys) : null;
      const targets = boss.buildBossScanTargets(options).filter((target) => !requested || requested.has(target.targetKey));
      assert(targets.length, "offline adapter received no scan targets");
      if (process.env.ROLEFLOW_SCAN_E2E_MODE === "interrupt") {
        assert(targets.length >= 2, "interruption fixture needs at least two targets");
        await checkpoint(options, targets[0]);
        const error = new Error("injected offline browser timeout");
        error.code = "BROWSER_TIMEOUT";
        throw error;
      }
      const jobs = [];
      for (const target of targets) jobs.push(...await checkpoint(options, target));
      options.onScanComplete?.({ status: "completed" });
      return jobs;
    }
  }

  Module._load = function load(request, parent, isMain) {
    let resolved;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch { /* use the original loader */ }
    if (resolved === bossPath) return { ...boss, BossSiteAdapter: OfflineBossSiteAdapter };
    if (resolved === reportsPath) return { renderReports: () => ({ mdPath: "offline.md", htmlPath: "offline.html" }) };
    if (resolved === observabilityPath) return { ...observability, createLogger: () => logger };
    if (resolved === modelSettingsPath) return {
      ...modelSettings,
      resolveRuntimeModelConfig: () => ({
        modelConfig: { provider: "mock", providers: { mock: { model: "offline-structured-mock" } } }
      })
    };
    return originalLoad.call(this, request, parent, isMain);
  };
}

async function checkpoint(options, target) {
  const jobs = [offlineJob(target)];
  await options.onTargetComplete({
    targetKey: target.targetKey,
    city: target.city.city,
    keyword: target.keyword,
    laneId: target.laneId,
    status: "completed",
    jobCount: jobs.length,
    jobs
  });
  return jobs;
}

function offlineJob(target) {
  const id = Buffer.from(target.targetKey).toString("hex").slice(0, 40);
  return {
    source: "boss",
    sourceId: `offline-${id}`,
    keyword: target.keyword,
    title: `${target.keyword} AI应用开发工程师`,
    company: "Offline Recovery Co",
    location: "广州",
    salary: "15-20K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    bossActiveDays: 0,
    tags: ["Python", "RAG", "Agent"],
    description: "负责 Python、RAG 与 Agent 应用开发，建设企业知识库检索和工具调用链路。".repeat(5),
    url: `https://www.zhipin.com/job_detail/${id}.html`,
    detailRequired: true,
    detailRead: true
  };
}
