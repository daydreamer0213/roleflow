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
    const { matchingCardFromProfile } = require("../src/core/matching_card");
    db = storage.openDb(dbPath);
    const fixture = fixtureProfile();
    const saved = storage.saveProfileAnalysis(db, fixture);
    const { profileId, planId } = saved;
    const seededDraft = storage.createMatchingCardDraft(db, {
      profileId,
      profileVersionId: saved.profileVersionId,
      resumeDocumentId: saved.resumeDocumentId,
      resumeContentHash: fixture.document.contentHash,
      card: matchingCardFromProfile(fixture.profile),
      source: "migration"
    });
    storage.confirmMatchingCard(db, { profileId, cardId: seededDraft.id });
    const otherPlanId = storage.saveSearchPlan(db, {
      profileId,
      plan: { ...fixturePlan(), name: "Other recovery plan" }
    });
    const unsupportedPlanId = storage.saveSearchPlan(db, {
      profileId,
      plan: {
        ...fixturePlan(),
        name: "Inherited unsupported Search Plan city",
        cities: ["测试未映射城市"]
      }
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

    db = storage.openDb(dbPath);
    storage.setSiteRuntimeState(db, "boss", {
      status: "blocked",
      reasonCode: "STABLE_PRE_RESUME_BLOCK",
      message: "must survive rejected resume"
    });
    const legacySnapshot = { ...snapshot, schemaVersion: 1 };
    const legacyBatchId = storage.createBatch(db, "boss", "legacy-resume", "legacy snapshot", {
      profileId,
      searchPlanId: planId,
      status: "interrupted",
      filterSnapshot: { execution: legacySnapshot }
    });
    const tamperedSnapshot = { ...snapshot, runtimePolicyHash: "tampered-without-rehash" };
    const tamperedBatchId = storage.createBatch(db, "boss", "tampered-resume", "tampered snapshot", {
      profileId,
      searchPlanId: planId,
      status: "interrupted",
      filterSnapshot: { execution: tamperedSnapshot }
    });
    const corruptInheritedSnapshot = {
      ...snapshot,
      searchTemplate: {
        mode: "inherited",
        url: "https://www.zhipin.com/web/geek/jobs",
        cityCode: ""
      },
      searchScope: {},
      keywordSource: {},
      platformPolicy: {}
    };
    const corruptInheritedBatchId = storage.createBatch(db, "boss", "corrupt-inherited", "corrupt inherited snapshot", {
      profileId,
      searchPlanId: planId,
      status: "interrupted",
      filterSnapshot: { execution: corruptInheritedSnapshot }
    });
    db.close();
    db = null;

    const legacyResume = runScan(dbPath, planId, "scan-e2e-legacy-resume", "reject-browser-create", {
      resumeBatchId: legacyBatchId
    });
    assertExit(legacyResume, 1, "legacy resume rejection");
    assert.match(legacyResume.stderr, /SCAN_SNAPSHOT_MISMATCH|schemaVersion/);

    const tamperedResume = runScan(dbPath, planId, "scan-e2e-tampered-resume", "reject-browser-create", {
      resumeBatchId: tamperedBatchId
    });
    assertExit(tamperedResume, 1, "tampered resume rejection");
    assert.match(tamperedResume.stderr, /SCAN_SNAPSHOT_MISMATCH|snapshotHash/);

    const corruptInheritedResume = runScan(
      dbPath,
      planId,
      "scan-e2e-corrupt-inherited-resume",
      "reject-browser-create",
      { resumeBatchId: corruptInheritedBatchId }
    );
    assertExit(corruptInheritedResume, 1, "corrupt inherited resume rejection");
    assert.match(corruptInheritedResume.stderr, /继承模式快照不完整/);

    db = storage.openDb(dbPath);
    assert.strictEqual(storage.getScanRun(db, "scan-e2e-legacy-resume"), null);
    assert.strictEqual(storage.getScanRun(db, "scan-e2e-tampered-resume"), null);
    assert.strictEqual(storage.getScanRun(db, "scan-e2e-corrupt-inherited-resume"), null);
    assert.strictEqual(storage.getSiteRuntimeState(db, "boss").reasonCode, "STABLE_PRE_RESUME_BLOCK");
    storage.clearSiteRuntimeState(db, "boss");
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
    assert.strictEqual(storage.getScanRun(db, "scan-e2e-wrong-plan"), null);
    assert.strictEqual(storage.getScanRun(db, "scan-e2e-changed-snapshot").stopCode, "SCAN_SNAPSHOT_MISMATCH");
    assert.strictEqual(storage.getScanRun(db, "scan-e2e-changed-snapshot").batchId, null);
    assert.strictEqual(storage.getBatch(db, batchId).status, "interrupted");
    assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM batches").get().count), 4);
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
    assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM batches").get().count), 4);
    assert.strictEqual(results.length, snapshot.targets.length, "each target must checkpoint exactly once");
    assert.deepStrictEqual(results.map((item) => item.targetKey).sort(), snapshot.targets.map((item) => item.targetKey).sort());
    assert(results.every((item) => item.status === "completed" && item.attemptNumber === 1));
    assert.strictEqual(results.filter((item) => item.targetKey === snapshot.targets[0].targetKey).length, 1,
      "the target completed before interruption must not run again");
    assert.deepStrictEqual(storage.listLatestScanTargetResults(db, batchId).map((item) => item.status),
      snapshot.targets.map(() => "completed"));

    db.close();
    db = null;

    const inheritedFirst = runScan(
      dbPath,
      unsupportedPlanId,
      "scan-e2e-inherited-unsupported-first",
      "interrupt-inherited-current"
    );
    assertExit(inheritedFirst, 1, "inherited current-page interruption");
    assert.match(inheritedFirst.stderr, /injected offline browser timeout/);

    db = storage.openDb(dbPath);
    const inheritedBatch = storage.getLatestResumableBatch(db, {
      planId: unsupportedPlanId,
      site: "boss"
    });
    assert(inheritedBatch);
    assert.strictEqual(inheritedBatch.filterSnapshot.execution.searchTemplate.mode, "inherited");
    db.close();
    db = null;

    const inheritedResumed = runScan(
      dbPath,
      unsupportedPlanId,
      "scan-e2e-inherited-unsupported-resumed",
      "complete",
      { resumeBatchId: inheritedBatch.id }
    );
    assertExit(inheritedResumed, 0, "inherited resume with unsupported Search Plan city");

    const generatedUnsupported = runScan(
      dbPath,
      unsupportedPlanId,
      "scan-e2e-generated-unsupported",
      "complete"
    );
    assertExit(generatedUnsupported, 1, "generated unsupported Search Plan city rejection");
    assert.match(generatedUnsupported.stderr, /BOSS 暂不支持这些城市：测试未映射城市/);

    await workflowPlatformAccessSmoke(storage);

    db = storage.openDb(dbPath);
    assert.strictEqual(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    console.log("scan_end_to_end_recovery_smoke ok");
  } finally {
    db?.close();
    rmRecursive(tempDir);
  }
}

function rmRecursive(target) {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;
      if (Date.now() >= deadline) throw error;
      const blocker = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(blocker, 0, 0, 100);
    }
  }
}

function runScan(dbPath, planId, runId, mode, {
  resumeBatchId = null,
  maxCards = 10,
  workflowRunId = null,
  keywords = null
} = {}) {
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
  if (workflowRunId) {
    args.push("--workflow-run", workflowRunId);
    args.push("--keywords", (Array.isArray(keywords) ? keywords : []).join(","));
  }
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      ROLEFLOW_SCAN_E2E_ADAPTER: "1",
      ROLEFLOW_SCAN_E2E_MODE: mode,
      ROLEFLOW_SCAN_E2E_DB: dbPath,
      ROLEFLOW_SCAN_E2E_WORKFLOW: workflowRunId || ""
    }
  });
}

async function workflowPlatformAccessSmoke(storage) {
  const { workflowRunConsumesSlot } = require("../src/core/workflow_control");
  await scenarioStopBeforeAccess(storage, workflowRunConsumesSlot);
  await scenarioFailureBeforeAccess(storage, workflowRunConsumesSlot);
  await scenarioStopAfterFirstTarget(storage, workflowRunConsumesSlot);
  await scenarioRepeatedEntry(storage);
}

async function scenarioStopBeforeAccess(storage, workflowRunConsumesSlot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-wf-pre-stop-"));
  try {
    const scenario = seedScenario(storage, root, "2026-10-01", "stop_requested");
    seedUnrelatedLease(storage, scenario.dbPath, "unrelated-pre-stop");
    const result = runScan(scenario.dbPath, scenario.planId, "wf-pre-access-stop", "complete", {
      workflowRunId: scenario.workflow.id,
      keywords: ["RAG", "Agent"]
    });
    assertExit(result, 0, "pre-access workflow stop");
    const db = storage.openDb(scenario.dbPath);
    try {
      const stopped = storage.getWorkflowRun(db, scenario.workflow.id);
      assert.strictEqual(stopped.status, "stopped");
      assert.strictEqual(stopped.controlState, "none");
      assert.strictEqual(stopped.platformAccessStartedAt, null);
      assert.strictEqual(workflowRunConsumesSlot(stopped), false);
      assert.strictEqual(storage.getSiteScanLease(db, "boss"), null);
      assert.strictEqual(storage.getSiteScanLease(db, "other")?.owner, "unrelated-pre-stop");
      assert.strictEqual(storage.listLatestScanTargetResults(db, stopped.scanBatchId).length, 0);
      assert.throws(
        () => require("../src/core/workflow_control").resumeWorkflowRun(db, {
          workflowRunId: stopped.id,
          now: "2026-10-01T01:10:00.000Z"
        }),
        (error) => error.code === "WORKFLOW_RUN_TERMINAL"
      );
      // seed revision 0 + finalize stop +1; the pre-access stop never wrote
      // the platform access marker, so its revision must not include it.
      assert.strictEqual(stopped.progressRevision, 1);
      assert.strictEqual(
        storage.getScanRun(db, "wf-pre-access-stop").stopCode,
        "WORKFLOW_STOP_REQUESTED"
      );
      storage.releaseSiteScanLease(db, { site: "other", owner: "unrelated-pre-stop" });
    } finally {
      db.close();
    }
  } finally {
    rmRecursive(root);
  }
}

async function scenarioFailureBeforeAccess(storage, workflowRunConsumesSlot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-wf-fail-pre-access-"));
  try {
    const scenario = seedScenario(storage, root, "2026-10-04", "none");
    const result = runScan(
      scenario.dbPath,
      scenario.planId,
      "wf-fail-before-access",
      "fail-before-access",
      {
        workflowRunId: scenario.workflow.id,
        keywords: ["RAG", "Agent"]
      }
    );
    assertExit(result, 1, "workflow failure before access");
    const db = storage.openDb(scenario.dbPath);
    try {
      const interrupted = storage.getWorkflowRun(db, scenario.workflow.id);
      assert.strictEqual(interrupted.status, "interrupted");
      assert.strictEqual(interrupted.platformAccessStartedAt, null);
      assert.strictEqual(workflowRunConsumesSlot(interrupted), false);
      assert.strictEqual(
        storage.listSiteAccessEvents(db, { site: "boss" })
          .filter((event) => event.details.runId === "wf-fail-before-access").length,
        0
      );
    } finally {
      db.close();
    }
  } finally {
    rmRecursive(root);
  }
}

async function scenarioStopAfterFirstTarget(storage, workflowRunConsumesSlot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-wf-stop-after-"));
  try {
    const scenario = seedScenario(storage, root, "2026-10-02", "none");
    seedUnrelatedLease(storage, scenario.dbPath, "unrelated-post-stop");
    const result = runScan(
      scenario.dbPath,
      scenario.planId,
      "wf-stop-after-first",
      "workflow-stop-after-first-target",
      {
        workflowRunId: scenario.workflow.id,
        keywords: ["RAG", "Agent"]
      }
    );
    assertExit(result, 0, "workflow stop after first target");
    const db = storage.openDb(scenario.dbPath);
    try {
      const stopped = storage.getWorkflowRun(db, scenario.workflow.id);
      assert(stopped.platformAccessStartedAt, "platform access must follow the first persisted access event");
      assert.strictEqual(stopped.status, "stopped");
      assert.strictEqual(stopped.controlState, "none");
      assert.strictEqual(workflowRunConsumesSlot(stopped), true);
      assert.strictEqual(storage.getSiteScanLease(db, "boss"), null);
      assert.strictEqual(storage.getSiteScanLease(db, "other")?.owner, "unrelated-post-stop");
      const savedResults = storage.listLatestScanTargetResults(db, stopped.scanBatchId);
      assert(savedResults.length >= 1, "at least one target must remain checkpointed");
      assert(savedResults.every((item) => item.status === "completed"));
      assert.throws(
        () => require("../src/core/workflow_control").resumeWorkflowRun(db, {
          workflowRunId: stopped.id,
          now: "2026-10-02T01:10:00.000Z"
        }),
        (error) => error.code === "WORKFLOW_RUN_TERMINAL"
      );
      // seed 0 + platform access marker +1 + finalize stop +1. If the marker
      // were written twice, this would be 3.
      assert.strictEqual(stopped.progressRevision, 2);
      assert.strictEqual(
        storage.getScanRun(db, "wf-stop-after-first").stopCode,
        "WORKFLOW_STOP_REQUESTED"
      );
      storage.releaseSiteScanLease(db, { site: "other", owner: "unrelated-post-stop" });
    } finally {
      db.close();
    }
  } finally {
    rmRecursive(root);
  }
}

async function scenarioRepeatedEntry(storage) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-wf-repeat-"));
  try {
    const scenario = seedScenario(storage, root, "2026-10-03", "none");
    const firstCrash = runScan(scenario.dbPath, scenario.planId, "wf-repeat-first", "interrupt", {
      workflowRunId: scenario.workflow.id,
      keywords: ["RAG", "Agent"]
    });
    assertExit(firstCrash, 1, "first workflow entry interruption");
    let db = storage.openDb(scenario.dbPath);
    let afterFirst;
    let persistedBatchId;
    try {
      afterFirst = storage.getWorkflowRun(db, scenario.workflow.id);
      assert(afterFirst.platformAccessStartedAt, "first entry must record the first persisted access event");
      assert.strictEqual(afterFirst.status, "interrupted");
      persistedBatchId = Number(afterFirst.scanBatchId);
      assert(persistedBatchId > 0, "first workflow entry must persist a scan batch");
    } finally {
      db.close();
    }

    const resumed = runScan(scenario.dbPath, scenario.planId, "wf-repeat-resumed", "complete", {
      workflowRunId: scenario.workflow.id,
      keywords: ["RAG", "Agent"],
      resumeBatchId: persistedBatchId
    });
    assertExit(resumed, 0, "second workflow entry");
    db = storage.openDb(scenario.dbPath);
    try {
      const afterSecond = storage.getWorkflowRun(db, scenario.workflow.id);
      assert.strictEqual(afterSecond.platformAccessStartedAt, afterFirst.platformAccessStartedAt);
      assert(afterSecond.progressRevision >= afterFirst.progressRevision);
      assert.strictEqual(afterSecond.status, "review_required");
    } finally {
      db.close();
    }
  } finally {
    rmRecursive(root);
  }
}

function seedScenario(storage, root, localDay, controlState) {
  const { matchingCardFromProfile } = require("../src/core/matching_card");
  const fixture = fixtureProfile();
  const dbPath = path.join(root, "jobs.sqlite");
  const db = storage.openDb(dbPath);
  try {
    const saved = storage.saveProfileAnalysis(db, fixture);
    const draft = storage.createMatchingCardDraft(db, {
      profileId: saved.profileId,
      profileVersionId: saved.profileVersionId,
      resumeDocumentId: saved.resumeDocumentId,
      resumeContentHash: fixture.document.contentHash,
      card: matchingCardFromProfile(fixture.profile),
      source: "migration"
    });
    storage.confirmMatchingCard(db, { profileId: saved.profileId, cardId: draft.id });
    const workflow = seedWorkflowRun(storage, db, {
      profileId: saved.profileId,
      planId: saved.planId,
      localDay,
      controlState
    });
    return {
      dbPath,
      planId: saved.planId,
      workflow
    };
  } finally {
    db.close();
  }
}

function seedUnrelatedLease(storage, dbPath, owner) {
  const db = storage.openDb(dbPath);
  try {
    storage.acquireSiteScanLease(db, {
      site: "other",
      owner,
      command: "offline-unrelated",
      ttlMs: 10 * 60_000
    });
  } finally {
    db.close();
  }
}

function seedWorkflowRun(storage, database, { profileId, planId, localDay, controlState = "none" }) {
  const now = new Date().toISOString();
  const workflow = storage.createWorkflowRun(database, {
    profileId,
    planId,
    localDay,
    sequence: 1,
    targetSuccessCount: 35,
    inventoryCount: 0,
    candidateGap: 35,
    scanNeeded: true,
    keywords: [
      { word: "RAG", priority: "A", maxCards: 10, maxDetails: 4 },
      { word: "Agent", priority: "B", maxCards: 10, maxDetails: 4 }
    ],
    budget: { maxDetailTotal: 4, browserPageBudget: 20 },
    planner: {
      remainingDailyTarget: 70,
      remainingRunSlots: 2,
      acquisitionMode: "generated"
    },
    modelConfigRevision: "wf-platform-access",
    createdAt: now
  });
  storage.transitionWorkflowRun(database, {
    id: workflow.id,
    status: "scanning",
    controlState,
    updatedAt: now
  });
  return storage.getWorkflowRun(database, workflow.id);
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
  const edgeControlPath = require.resolve("../src/adapters/browser/edge_control");
  const boss = require(bossPath);
  const observability = require(observabilityPath);
  const modelSettings = require(modelSettingsPath);
  const originalLoad = Module._load;
  const logger = { child: () => logger, debug() {}, info() {}, warn() {}, error() {} };

  class OfflineBossSiteAdapter {
    constructor({ accessController = null } = {}) {
      this.accessController = accessController;
    }

    async preflight({ tabId = null } = {}) {
      const inheritedCurrent = process.env.ROLEFLOW_SCAN_E2E_MODE?.includes("inherited-current");
      const searchTabId = "offline-boss-search-tab";
      const communicationTabId = "offline-boss-communication-tab";
      if (String(tabId) === communicationTabId) {
        return {
          tabId: communicationTabId,
          url: "https://www.zhipin.com/web/geek/chat",
          isSearchPage: false
        };
      }
      return {
        tabId: searchTabId,
        url: inheritedCurrent
          ? "https://www.zhipin.com/web/geek/jobs?query=offline&page=2"
          : "https://www.zhipin.com/web/geek/jobs",
        isSearchPage: true
      };
    }

    async inspectInheritedSearchPage() {
      return {
        url: "https://www.zhipin.com/web/geek/jobs?query=offline&page=2",
        catalog: {
          site: "boss",
          source: "offline-smoke",
          discoveredAt: new Date().toISOString(),
          fields: {}
        },
        urlOptions: []
      };
    }

    async discoverFilterCatalog() {
      return { site: "boss", source: "offline-smoke", discoveredAt: new Date().toISOString(), fields: {} };
    }

    async scan(options) {
      if (process.env.ROLEFLOW_SCAN_E2E_MODE === "fail-before-access") {
        const error = new Error("injected failure before first access reservation");
        error.code = "BROWSER_TIMEOUT";
        throw error;
      }
      await this.accessController?.reserve("list_navigation", {
        keyword: options.keywords?.[0] || ""
      });
      const requested = Array.isArray(options.targetKeys) ? new Set(options.targetKeys) : null;
      const targets = boss.buildBossScanTargets(options).filter((target) => !requested || requested.has(target.targetKey));
      assert(targets.length, "offline adapter received no scan targets");
      if (process.env.ROLEFLOW_SCAN_E2E_MODE === "workflow-stop-after-first-target") {
        assert(targets.length >= 2, "workflow stop fixture needs at least two targets");
        await checkpoint(options, targets[0]);
        markWorkflowStopRequested();
        await checkpoint(options, targets[1]);
        return [];
      }
      if (process.env.ROLEFLOW_SCAN_E2E_MODE?.startsWith("interrupt")) {
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

  class OfflineEdgeControlAdapter {
    constructor() {
      if (process.env.ROLEFLOW_SCAN_E2E_MODE === "reject-browser-create") {
        const error = new Error("browser was created before resume validation");
        error.code = "BROWSER_CREATED_TOO_EARLY";
        throw error;
      }
    }

    async listTabs() {
      return [
        {
          id: "offline-boss-search-tab",
          url: "https://www.zhipin.com/web/geek/jobs",
          windowId: 17
        },
        {
          id: "offline-boss-communication-tab",
          url: "https://www.zhipin.com/web/geek/chat",
          windowId: 17
        }
      ];
    }
  }

  Module._load = function load(request, parent, isMain) {
    let resolved;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch { /* use the original loader */ }
    if (resolved === bossPath) return { ...boss, BossSiteAdapter: OfflineBossSiteAdapter };
    if (resolved === edgeControlPath) return { EdgeControlAdapter: OfflineEdgeControlAdapter };
    if (resolved === reportsPath) return { renderReports: () => ({ mdPath: "offline.md", htmlPath: "offline.html" }) };
    if (resolved === observabilityPath) return { ...observability, createLogger: () => logger };
    if (resolved === modelSettingsPath) return {
      ...modelSettings,
      resolveRuntimeModelConfig: () => ({
        revision: "offline-e2e-rev",
        concurrency: 1,
        modelConfig: {
          provider: "mock",
          providers: {
            mock: {
              model: "offline-structured-mock",
              thinkingMode: "disabled",
              reasoningEffort: "high"
            }
          }
        }
      }),
      isModelReady: () => true
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

function markWorkflowStopRequested() {
  const storage = require("../src/core/storage");
  const database = storage.openDb(process.env.ROLEFLOW_SCAN_E2E_DB);
  try {
    database.prepare(`
      UPDATE workflow_runs SET
        control_state = 'stop_requested',
        updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), process.env.ROLEFLOW_SCAN_E2E_WORKFLOW);
  } finally {
    database.close();
  }
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
