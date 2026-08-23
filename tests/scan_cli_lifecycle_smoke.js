const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  executeWithSiteScanLease,
  resolveResumeBatch,
  resolveScanTerminalStatus,
  resolveScanLimit,
  persistRefreshAttempt,
  assertScanLimitOverridesAllowed,
  assertWorkflowScanControl,
  preflightBossScanBrowser,
  runWithBoundBossScanBrowser,
  scanFailureStatus
} = require("../src/cli");
const {
  openDb,
  createBatch,
  createWorkflowRun,
  beginScanRun,
  getScanRun,
  getWorkflowRun,
  getSiteScanLease,
  getLatestResumableBatch,
  recordScanTargetResult,
  upsertJob,
  listReportJobs,
  transitionWorkflowRun,
  getLatestJobRefreshAttempt,
  recordSiteAccessEvent,
  listSiteAccessEvents
} = require("../src/core/storage");
const { buildScanExecutionSnapshot } = require("../src/core/scan_snapshot");
const { createSiteAccessController } = require("../src/core/site_access_budget");

const smokeDir = path.join(__dirname, "..", ".runtime", "smoke");
const dbPath = path.join(smokeDir, `scan-cli-lifecycle-${Date.now()}.sqlite`);
const accessLedgerPath = path.join(smokeDir, `scan-cli-access-ledger-${Date.now()}.sqlite`);
let db;

main()
  .then(() => console.log("scan_cli_lifecycle_smoke ok"))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    db?.close();
    for (const targetPath of [dbPath, accessLedgerPath]) {
      for (const suffix of ["", "-shm", "-wal"]) {
        try { fs.rmSync(`${targetPath}${suffix}`, { force: true }); } catch { /* no-op */ }
      }
    }
  });

async function main() {
  fs.mkdirSync(smokeDir, { recursive: true });
  db = openDb(dbPath);
  await fixedBossScanPreflightSmoke();
  await completedRunSmoke();
  await partialRunWithBatchSmoke();
  await interruptedRunSmoke();
  await failedRunSmoke();
  await localInputRunSmoke();
  await missingSharedAccessLedgerValueFailsClosedSmoke();
  await sameDatabasePathCaseSmoke();
  await unavailableSharedAccessLedgerFailsBeforeRunSmoke();
  await explicitSharedAccessLedgerSmoke();
  await workflowControlledOuterSmoke();
  resumeBatchSmoke();
  terminalAggregationSmoke();
  scanLimitSmoke();
  refreshCheckpointSmoke();
  workflowScanControlSmoke();
}

async function fixedBossScanPreflightSmoke() {
  assert.strictEqual(typeof preflightBossScanBrowser, "function");
  assert.strictEqual(typeof runWithBoundBossScanBrowser, "function");

  const fixedTabs = [
    { id: 31, windowId: 7, url: "https://www.zhipin.com/web/geek/jobs" },
    { id: 32, windowId: 7, url: "https://www.zhipin.com/web/geek/chat" },
    { id: 90, windowId: 7, url: "https://www.zhipin.com/web/geek/jobs/other" }
  ];
  const calls = [];
  let currentTabs = fixedTabs;
  const browser = { listTabs: async () => currentTabs };
  const adapter = {
    preflight: async (options) => {
      calls.push(options);
      return options?.tabId === 31
        ? { tabId: 31, url: "https://www.zhipin.com/web/geek/jobs", isSearchPage: true, mode: "search" }
        : { tabId: options?.tabId, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false, mode: "communication" };
    }
  };

  const edgeState = await preflightBossScanBrowser({ browserMode: "edge", browser, adapter });
  assert.deepStrictEqual(calls, [{ tabId: 32 }, { tabId: 31 }]);
  assert.deepStrictEqual(edgeState, {
    tabId: 31,
    communicationTabId: 32,
    url: "https://www.zhipin.com/web/geek/jobs",
    isSearchPage: true,
    mode: "search"
  });

  currentTabs = fixedTabs;
  const initialBoundState = await preflightBossScanBrowser({ browserMode: "edge", browser, adapter });
  currentTabs = fixedTabs.map((tab) => tab.id === 32 ? { ...tab, id: 33 } : tab);
  let communicationDriftActions = 0;
  await assert.rejects(
    () => runWithBoundBossScanBrowser({
      browserMode: "edge",
      browser,
      adapter,
      expectedSearchTabId: initialBoundState.tabId,
      expectedCommunicationTabId: initialBoundState.communicationTabId,
      action: async () => { communicationDriftActions += 1; }
    }),
    (error) => error.code === "BOSS_OPERATOR_TABS_CHANGED"
  );
  assert.strictEqual(communicationDriftActions, 0);
  currentTabs = fixedTabs;

  const lostSearchCalls = [];
  const lostSearchAdapter = {
    preflight: async (options) => {
      lostSearchCalls.push(options);
      return options?.tabId === 31
        ? { tabId: 31, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false }
        : { tabId: 32, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false };
    }
  };
  await assert.rejects(
    () => preflightBossScanBrowser({ browserMode: "edge", browser, adapter: lostSearchAdapter }),
    (error) => error.code === "BOSS_SEARCH_PAGE_LOST"
  );
  assert.deepStrictEqual(lostSearchCalls, [{ tabId: 32 }, { tabId: 31 }]);

  const badCommunicationCalls = [];
  await assert.rejects(
    () => preflightBossScanBrowser({
      browserMode: "edge",
      browser,
      adapter: {
        preflight: async (options) => {
          badCommunicationCalls.push(options);
          return { tabId: 31, url: "https://www.zhipin.com/web/geek/jobs", isSearchPage: true };
        }
      }
    }),
    (error) => error.code === "BOSS_COMMUNICATION_PAGE_LOST"
  );
  assert.deepStrictEqual(badCommunicationCalls, [{ tabId: 32 }]);

  const blockedActions = { inheritedInspect: 0, generatedCatalog: 0, finalScan: 0, refreshActivity: 0 };
  for (const [name, action] of Object.entries({
    inheritedInspect: async () => { blockedActions.inheritedInspect += 1; },
    generatedCatalog: async () => { blockedActions.generatedCatalog += 1; },
    finalScan: async () => { blockedActions.finalScan += 1; },
    refreshActivity: async () => { blockedActions.refreshActivity += 1; }
  })) {
    await assert.rejects(
      () => runWithBoundBossScanBrowser({ browserMode: "edge", browser, adapter: lostSearchAdapter, action }),
      (error) => error.code === "BOSS_SEARCH_PAGE_LOST",
      `${name} must stop before its page action when the fixed search page is lost`
    );
  }
  assert.deepStrictEqual(blockedActions, { inheritedInspect: 0, generatedCatalog: 0, finalScan: 0, refreshActivity: 0 });

  await assert.rejects(
    () => preflightBossScanBrowser({
      browserMode: "edge",
      browser: { listTabs: async () => [...fixedTabs, { id: 33, windowId: 7, url: "https://www.zhipin.com/web/geek/jobs?duplicate=1" }] },
      adapter
    }),
    (error) => error.code === "BOSS_TAB_REQUIRED"
  );
  await assert.rejects(
    () => preflightBossScanBrowser({
      browserMode: "edge",
      browser: { listTabs: async () => fixedTabs.filter((tab) => tab.id !== 32) },
      adapter
    }),
    (error) => error.code === "BOSS_TAB_REQUIRED"
  );
  await assert.rejects(
    () => preflightBossScanBrowser({
      browserMode: "edge",
      browser: { listTabs: async () => fixedTabs.map((tab) => tab.id === 32 ? { ...tab, windowId: 8 } : tab) },
      adapter
    }),
    (error) => error.code === "BOSS_WINDOW_MISMATCH"
  );

  currentTabs = fixedTabs.map((tab) => tab.id === 31 ? { ...tab, id: 33 } : tab);
  calls.length = 0;
  await assert.rejects(
    () => preflightBossScanBrowser({
      browserMode: "edge",
      browser,
      adapter,
      expectedSearchTabId: edgeState.tabId
    }),
    (error) => error.code === "BOSS_SEARCH_TAB_CHANGED"
  );
  assert.deepStrictEqual(calls, []);

  const portableEvents = [];
  const portableTabs = [
    { id: "CDP-search-31", windowId: 7, url: "https://www.zhipin.com/web/geek/jobs" },
    { id: "CDP-chat-32", windowId: 7, url: "https://www.zhipin.com/web/geek/chat" }
  ];
  const portableState = await preflightBossScanBrowser({
    browserMode: "portable",
    browser: { listTabs: async () => { portableEvents.push("list"); return portableTabs; } },
    adapter: {
      preflight: async ({ tabId }) => {
        portableEvents.push(`inspect:${tabId}`);
        return tabId === "CDP-search-31"
          ? { tabId, url: portableTabs[0].url, isSearchPage: true }
          : { tabId, url: portableTabs[1].url, isSearchPage: false };
      }
    }
  });
  assert.deepStrictEqual(portableEvents, [
    "list",
    "inspect:CDP-chat-32",
    "inspect:CDP-search-31",
    "list"
  ]);
  assert.deepStrictEqual(portableState, {
    tabId: "CDP-search-31",
    communicationTabId: "CDP-chat-32",
    url: portableTabs[0].url,
    isSearchPage: true
  });

  portableEvents.length = 0;
  await runWithBoundBossScanBrowser({
    browserMode: "portable",
    browser: { listTabs: async () => { portableEvents.push("list"); return portableTabs; } },
    adapter: {
      preflight: async ({ tabId }) => {
        portableEvents.push(`inspect:${tabId}`);
        return tabId === "CDP-search-31"
          ? { tabId, url: portableTabs[0].url, isSearchPage: true }
          : { tabId, url: portableTabs[1].url, isSearchPage: false };
      }
    },
    expectedSearchTabId: portableState.tabId,
    expectedCommunicationTabId: portableState.communicationTabId,
    action: async () => { portableEvents.push("scan-action"); }
  });
  assert.deepStrictEqual(portableEvents, [
    "list",
    "inspect:CDP-chat-32",
    "inspect:CDP-search-31",
    "list",
    "scan-action"
  ], "both typed CDP fixed tabs must be checked before the first scan action");
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

async function explicitSharedAccessLedgerSmoke() {
  const now = Date.now();
  const ledgerDb = openDb(accessLedgerPath);
  for (let index = 0; index < 16; index += 1) {
    recordSiteAccessEvent(ledgerDb, {
      site: "boss",
      action: "list_navigation",
      runId: "previous-baseline",
      createdAt: new Date(now - 1000 + index).toISOString()
    });
  }
  ledgerDb.close();

  const runId = "cli-shared-access-ledger";
  await assert.rejects(
    () => executeWithSiteScanLease(db, {
      db: dbPath,
      "run-id": runId,
      "access-ledger-db": accessLedgerPath
    }, "scan", async (_signal, execution) => {
      assert.notStrictEqual(execution.accessLedgerDb, db);
      const controller = createSiteAccessController({
        db: execution.accessLedgerDb,
        auditDb: db,
        site: "boss",
        runId,
        nowFn: () => now,
        sleepFn: async () => {}
      });
      await controller.reserve("list_navigation", { kind: "new-baseline" });
      return { status: "completed" };
    }),
    (error) => error.code === "BOSS_ACCESS_BUDGET_EXHAUSTED"
      && error.usage["24h"] === 16
  );
  assert.strictEqual(getScanRun(db, runId).status, "interrupted");

  const reopenedLedgerDb = openDb(accessLedgerPath);
  try {
    assert.strictEqual(listSiteAccessEvents(reopenedLedgerDb, {
      site: "boss",
      action: "list_navigation"
    }).length, 16);
  } finally {
    reopenedLedgerDb.close();
  }
}

async function unavailableSharedAccessLedgerFailsBeforeRunSmoke() {
  let runCalls = 0;
  await assert.rejects(
    () => executeWithSiteScanLease(db, {
      db: dbPath,
      "run-id": "cli-unavailable-access-ledger",
      "access-ledger-db": smokeDir
    }, "scan", async () => {
      runCalls += 1;
      return { status: "completed" };
    }),
    (error) => error.code === "BOSS_ACCESS_LEDGER_UNAVAILABLE"
  );
  assert.strictEqual(runCalls, 0, "the scan callback must not begin when the account ledger cannot open");
  assert.strictEqual(getScanRun(db, "cli-unavailable-access-ledger"), null);
  assert.strictEqual(getSiteScanLease(db, "boss"), null);
}

async function missingSharedAccessLedgerValueFailsClosedSmoke() {
  let runCalls = 0;
  await assert.rejects(
    () => executeWithSiteScanLease(db, {
      db: dbPath,
      "run-id": "cli-missing-access-ledger-value",
      "access-ledger-db": true
    }, "scan", async () => {
      runCalls += 1;
      return { status: "completed" };
    }),
    (error) => error.code === "BOSS_ACCESS_LEDGER_PATH_REQUIRED"
  );
  assert.strictEqual(runCalls, 0);
  assert.strictEqual(getScanRun(db, "cli-missing-access-ledger-value"), null);
}

async function sameDatabasePathCaseSmoke() {
  const alternateCase = dbPath.replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);
  const runId = "cli-same-ledger-case";
  const result = await executeWithSiteScanLease(db, {
    db: dbPath,
    "run-id": runId,
    "access-ledger-db": alternateCase
  }, "scan", async (_signal, execution) => {
    assert.strictEqual(execution.accessLedgerDb, db);
    return { status: "completed" };
  });
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(getScanRun(db, runId).status, "completed");
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
  for (const code of [
    "BOSS_SEARCH_TAB_CHANGED",
    "BOSS_OPERATOR_TABS_CHANGED",
    "BOSS_COMMUNICATION_PAGE_LOST",
    "BOSS_WINDOW_MISMATCH",
    "BROWSER_COMMAND_FAILED"
  ]) {
    assert.strictEqual(scanFailureStatus({ code }), "interrupted", `${code} must interrupt the run`);
  }
  assert.strictEqual(scanFailureStatus({ code: "BOSS_DETAIL_LOAD_TIMEOUT" }), "failed");
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

function workflowScanControlSmoke() {
  const now = new Date().toISOString();
  const profileId = Number(db.prepare(`
    INSERT INTO candidate_profiles(display_name, profile_json, source_hash, created_at, updated_at)
    VALUES ('Workflow Control Candidate', '{}', NULL, ?, ?)
  `).run(now, now).lastInsertRowid);
  const planId = Number(db.prepare(`
    INSERT INTO search_plans(profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at)
    VALUES (?, 'Workflow Control Plan', '{}', NULL, 1, ?, ?)
  `).run(profileId, now, now).lastInsertRowid);
  const workflow = createWorkflowRun(db, {
    profileId,
    planId,
    localDay: "2026-09-10",
    sequence: 1,
    targetSuccessCount: 35,
    successfulCount: 0,
    inventoryCount: 0,
    candidateGap: 35,
    scanNeeded: true,
    keywords: [{ word: "RAG", priority: "A" }],
    budget: { maxDetailTotal: 120, browserPageBudget: 20 },
    planner: { remainingDailyTarget: 70, remainingRunSlots: 2 }
  });
  assert.doesNotThrow(() => assertWorkflowScanControl(db, workflow.id));
  assert.doesNotThrow(() => assertWorkflowScanControl(db, "missing-workflow"));
  transitionWorkflowRun(db, { id: workflow.id, status: "scanning", controlState: "pause_requested" });
  assert.throws(
    () => assertWorkflowScanControl(db, workflow.id),
    (error) => error.code === "WORKFLOW_PAUSE_REQUESTED"
  );
  transitionWorkflowRun(db, { id: workflow.id, status: "scanning", controlState: "stop_requested" });
  assert.throws(
    () => assertWorkflowScanControl(db, workflow.id),
    (error) => error.code === "WORKFLOW_STOP_REQUESTED"
  );
  transitionWorkflowRun(db, { id: workflow.id, status: "paused", controlState: "none", resumePhase: "scanning" });
  assert.throws(
    () => assertWorkflowScanControl(db, workflow.id),
    (error) => error.code === "WORKFLOW_PAUSE_REQUESTED"
  );
  transitionWorkflowRun(db, { id: workflow.id, status: "stopped", controlState: "none" });
  assert.throws(
    () => assertWorkflowScanControl(db, workflow.id),
    (error) => error.code === "WORKFLOW_STOP_REQUESTED"
  );
}

async function workflowControlledOuterSmoke() {
  const pauseWorkflow = seedControlledWorkflow(db, "2026-09-20", "pause_requested");
  const pauseResult = await executeWithSiteScanLease(db, {
    "run-id": "cli-workflow-pause",
    "workflow-run": pauseWorkflow.id,
    plan: pauseWorkflow.planId
  }, "scan", async () => {
    assertWorkflowScanControl(db, pauseWorkflow.id);
    return { status: "completed" };
  });
  assert.strictEqual(pauseResult.status, "paused");
  assert.strictEqual(pauseResult.stopCode, "WORKFLOW_PAUSE_REQUESTED");
  const pauseRun = getScanRun(db, "cli-workflow-pause");
  assert.strictEqual(pauseRun.status, "interrupted");
  assert.strictEqual(pauseRun.stopCode, "WORKFLOW_PAUSE_REQUESTED");
  const pausedWorkflow = getWorkflowRun(db, pauseWorkflow.id);
  assert.strictEqual(pausedWorkflow.status, "paused");
  assert.strictEqual(pausedWorkflow.controlState, "none");
  assert.strictEqual(pausedWorkflow.resumePhase, "scanning");
  assert.strictEqual(getSiteScanLease(db, "boss"), null);

  const stopWorkflow = seedControlledWorkflow(db, "2026-09-21", "stop_requested");
  const stopResult = await executeWithSiteScanLease(db, {
    "run-id": "cli-workflow-stop",
    "workflow-run": stopWorkflow.id,
    plan: stopWorkflow.planId
  }, "scan", async () => {
    assertWorkflowScanControl(db, stopWorkflow.id);
    return { status: "completed" };
  });
  assert.strictEqual(stopResult.status, "stopped");
  assert.strictEqual(stopResult.stopCode, "WORKFLOW_STOP_REQUESTED");
  const stopRun = getScanRun(db, "cli-workflow-stop");
  assert.strictEqual(stopRun.status, "interrupted");
  assert.strictEqual(stopRun.stopCode, "WORKFLOW_STOP_REQUESTED");
  const stoppedWorkflow = getWorkflowRun(db, stopWorkflow.id);
  assert.strictEqual(stoppedWorkflow.status, "stopped");
  assert.strictEqual(stoppedWorkflow.controlState, "none");
  assert.strictEqual(getSiteScanLease(db, "boss"), null);
}

function seedControlledWorkflow(database, localDay, controlState) {
  const now = new Date().toISOString();
  const profileId = Number(database.prepare(`
    INSERT INTO candidate_profiles(display_name, profile_json, source_hash, created_at, updated_at)
    VALUES ('Workflow Outer Control Candidate', '{}', NULL, ?, ?)
  `).run(now, now).lastInsertRowid);
  const planId = Number(database.prepare(`
    INSERT INTO search_plans(profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at)
    VALUES (?, 'Workflow Outer Control Plan', '{}', NULL, 1, ?, ?)
  `).run(profileId, now, now).lastInsertRowid);
  const workflow = createWorkflowRun(database, {
    profileId,
    planId,
    localDay,
    sequence: 1,
    targetSuccessCount: 35,
    successfulCount: 0,
    inventoryCount: 0,
    candidateGap: 35,
    scanNeeded: true,
    keywords: [{ word: "RAG", priority: "A" }],
    budget: { maxDetailTotal: 120, browserPageBudget: 20 },
    planner: { remainingDailyTarget: 70, remainingRunSlots: 2 }
  });
  transitionWorkflowRun(database, {
    id: workflow.id,
    status: "scanning",
    controlState,
    resumePhase: controlState === "pause_requested" ? "scanning" : null
  });
  return { id: workflow.id, planId };
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
