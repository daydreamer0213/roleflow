const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  openDb,
  createWorkflowRun,
  transitionWorkflowRun,
  attachWorkflowCommunication
} = require("../src/core/storage");
const { getCommunicationBatch } = require("../src/core/communication_batches");
const { communicate } = require("../src/cli");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `communication-cli-authority-${Date.now()}.sqlite`);
let db;

(async () => {
  fs.mkdirSync(smokeDir, { recursive: true });
  db = openDb(dbPath);
  const now = "2026-08-05T08:00:00.000Z";
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, created_at, updated_at
  ) VALUES (?, '{}', ?, ?)`).run("CLI authority smoke", now, now).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, created_at, updated_at
  ) VALUES (?, ?, '{}', ?, ?)`).run(profileId, "CLI authority smoke", now, now).lastInsertRowid);
  const batchId = Number(db.prepare(`INSERT INTO communication_batches(
    site, profile_id, plan_id, browser_mode, status, policy_json,
    confirmed_at, created_at, updated_at
  ) VALUES ('boss', ?, ?, 'portable', 'confirmed', ?, ?, ?, ?)`)
    .run(
      profileId,
      planId,
      JSON.stringify({ browser: { mode: "portable", cdpPort: 9222 } }),
      now,
      now,
      now
    ).lastInsertRowid);
  db.close();
  db = null;

  const result = spawnSync(process.execPath, [
    path.join(root, "src", "cli.js"),
    "communicate",
    "--db",
    dbPath,
    "--batch",
    String(batchId),
    "--browser",
    "portable",
    "--cdp-port",
    "9333"
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000
  });

  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /COMMUNICATION_PORTABLE_CDP_PORT_MISMATCH/);

  db = openDb(dbPath);
  const persisted = db.prepare("SELECT status, started_at, stop_code FROM communication_batches WHERE id = ?").get(batchId);
  assert.deepStrictEqual({ ...persisted }, {
    status: "confirmed",
    started_at: null,
    stop_code: null
  });

  const edgeBatchId = Number(db.prepare(`INSERT INTO communication_batches(
    site, profile_id, plan_id, browser_mode, status, policy_json,
    confirmed_at, created_at, updated_at
  ) VALUES ('boss', ?, ?, 'edge', 'confirmed', ?, ?, ?, ?)`)
    .run(
      profileId,
      planId,
      JSON.stringify({ browser: { mode: "edge", cdpPort: null } }),
      now,
      now,
      now
    ).lastInsertRowid);
  const events = [];
  let createTabCalls = 0;
  const searchUrl = "https://www.zhipin.com/web/geek/jobs?city=100010000&query=RAG&page=2";
  const edgeBrowser = {
    async listTabs() {
      return [
        { id: 1995685534, windowId: 1995685675, url: searchUrl },
        { id: 1995685619, windowId: 1995685675, url: "https://www.zhipin.com/web/geek/chat" }
      ];
    },
    async createTab() { createTabCalls += 1; throw new Error("edge communication must not create tabs"); }
  };
  const edgeAdapter = {
    async preflight({ tabId }) {
      events.push(`preflight:${tabId}`);
      return tabId === 1995685619
        ? { tabId: 1995685619, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false }
        : { tabId: 1995685534, url: searchUrl, isSearchPage: true };
    },
    async captureCommunicationSearchState(tabId) {
      events.push(`capture:${tabId}`);
      return { url: searchUrl, scrollTop: 240 };
    },
    bindCommunicationTabs(binding) {
      events.push(["bind", binding]);
    },
    async beginCommunicationSession() {
      events.push("begin");
      return 1995685534;
    },
    async restoreCommunicationSearchPage() {
      events.push("restore");
    }
  };
  const summary = await communicate(db, { batch: edgeBatchId, browser: "edge" }, {
    createBrowserFn: () => edgeBrowser,
    createSiteAdapterFn: () => edgeAdapter,
    runCommunicationBatchFn: async ({ adapter }) => {
      assert.strictEqual(adapter, edgeAdapter);
      events.push("run");
      return { terminal: 0, total: 0 };
    }
  });
  assert.deepStrictEqual(summary, { terminal: 0, total: 0 });
  assert.deepStrictEqual(events, [
    "preflight:1995685619",
    "preflight:1995685534",
    "capture:1995685534",
    ["bind", {
      mode: "edge",
      windowId: 1995685675,
      searchTabId: 1995685534,
      messageTabId: 1995685619,
      searchReturnUrl: searchUrl,
      searchScrollTop: 240,
      bindingGeneration: 1
    }],
    "begin",
    "run",
    "restore"
  ]);
  assert.deepStrictEqual(getCommunicationBatch(db, edgeBatchId).runtime.browser, {
    mode: "edge",
    windowId: 1995685675,
    searchTabId: 1995685534,
    messageTabId: 1995685619,
    searchReturnUrl: searchUrl,
    searchScrollTop: 240,
    bindingGeneration: 1
  });
  assert.strictEqual(typeof getCommunicationBatch(db, edgeBatchId).runtime.browser.searchTabId, "number");
  assert.strictEqual(createTabCalls, 0);

  let failedRunCalls = 0;
  await assert.rejects(
    () => communicate(db, { batch: edgeBatchId, browser: "edge" }, {
      createBrowserFn: () => edgeBrowser,
      createSiteAdapterFn: () => ({
        async preflight({ tabId }) {
          return tabId === 1995685619
            ? { tabId: 1995685619, url: "https://www.zhipin.com/web/geek/jobs", isSearchPage: true }
            : { tabId: 1995685534, url: searchUrl, isSearchPage: true };
        },
        bindCommunicationTabs() { throw new Error("must not bind after failed strict preflight"); },
        async prepareCommunicationTab() { throw new Error("must not prepare after failed strict preflight"); }
      }),
      runCommunicationBatchFn: async () => { failedRunCalls += 1; return { terminal: 0, total: 0 }; }
    }),
    (error) => error.code === "BOSS_COMMUNICATION_PAGE_LOST"
  );
  assert.strictEqual(failedRunCalls, 0);

  const runError = Object.assign(new Error("fixture run failed"), { code: "FIXTURE_RUN_FAILED" });
  let restoreCalls = 0;
  await assert.rejects(
    () => communicate(db, { batch: edgeBatchId, browser: "edge" }, {
      createBrowserFn: () => edgeBrowser,
      createSiteAdapterFn: () => ({
        async preflight({ tabId }) {
          return tabId === 1995685619
            ? { tabId, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false }
            : { tabId, url: searchUrl, isSearchPage: true };
        },
        async captureCommunicationSearchState() { return { url: searchUrl, scrollTop: 240 }; },
        bindCommunicationTabs() {},
        async beginCommunicationSession() {},
        async restoreCommunicationSearchPage() { restoreCalls += 1; }
      }),
      runCommunicationBatchFn: async () => { throw runError; }
    }),
    (error) => error === runError
  );
  assert.strictEqual(restoreCalls, 1, "a started Edge session must restore the search tab after execution failure");

  const restoreError = Object.assign(new Error("fixture restore failed"), { code: "BOSS_SEARCH_PAGE_LOST" });
  const completionLogs = [];
  const originalLog = console.log;
  try {
    console.log = (...values) => completionLogs.push(values.join(" "));
    await assert.rejects(
      () => communicate(db, { batch: edgeBatchId, browser: "edge" }, {
        createBrowserFn: () => edgeBrowser,
        createSiteAdapterFn: () => ({
          async preflight({ tabId }) {
            return tabId === 1995685619
              ? { tabId, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false }
              : { tabId, url: searchUrl, isSearchPage: true };
          },
          async captureCommunicationSearchState() { return { url: searchUrl, scrollTop: 240 }; },
          bindCommunicationTabs() {},
          async beginCommunicationSession() {},
          async restoreCommunicationSearchPage() { throw restoreError; }
        }),
        runCommunicationBatchFn: async () => ({ terminal: 1, total: 1 })
      }),
      (error) => error === restoreError
    );
  } finally {
    console.log = originalLog;
  }
  assert.doesNotMatch(completionLogs.join("\n"), /沟通批次.*完成/);

  const driftBatchId = Number(db.prepare(`INSERT INTO communication_batches(
    site, profile_id, plan_id, browser_mode, status, policy_json,
    confirmed_at, created_at, updated_at
  ) VALUES ('boss', ?, ?, 'edge', 'confirmed', ?, ?, ?, ?)`)
    .run(profileId, planId, JSON.stringify({ browser: { mode: "edge" } }), now, now, now).lastInsertRowid);
  const driftWorkflow = createWorkflowRun(db, {
    profileId,
    planId,
    localDay: "2026-08-06",
    sequence: 1,
    targetSuccessCount: 1,
    candidateGap: 1,
    scanNeeded: false,
    planner: {
      browserMode: "edge",
      acquisitionMode: "inherited",
      searchScope: {
        templateUrl: "https://www.zhipin.com/web/geek/jobs?city=101010100"
      }
    }
  });
  transitionWorkflowRun(db, { id: driftWorkflow.id, status: "review_required" });
  attachWorkflowCommunication(db, { id: driftWorkflow.id, communicationBatchId: driftBatchId });
  let driftBound = 0;
  let driftRun = 0;
  await assert.rejects(
    () => communicate(db, { batch: driftBatchId, browser: "edge" }, {
      createBrowserFn: () => edgeBrowser,
      createSiteAdapterFn: () => ({
        async preflight({ tabId }) {
          return tabId === 1995685619
            ? { tabId, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false }
            : { tabId, url: searchUrl, isSearchPage: true };
        },
        async captureCommunicationSearchState() { return { url: searchUrl, scrollTop: 240 }; },
        bindCommunicationTabs() { driftBound += 1; },
        async beginCommunicationSession() {},
        async restoreCommunicationSearchPage() {}
      }),
      runCommunicationBatchFn: async () => { driftRun += 1; return { terminal: 0, total: 0 }; }
    }),
    (error) => error.code === "BOSS_COMMUNICATION_SCOPE_MISMATCH"
  );
  assert.strictEqual(driftBound, 0);
  assert.strictEqual(driftRun, 0);
  assert.deepStrictEqual(getCommunicationBatch(db, driftBatchId).runtime, {});

  console.log("communication_cli_authority_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  db?.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
  }
});
