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
const { getCommunicationBatch, setCommunicationBatchStatus } = require("../src/core/communication_batches");
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
    "--single-item",
    "1",
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

  const portableEvents = [];
  const portableSearchUrl = "https://www.zhipin.com/web/geek/jobs?query=java&page=2";
  const portableBrowser = {
    async listTabs() {
      portableEvents.push("listTabs");
      return [
        { id: "CDP-search", windowId: 17, url: portableSearchUrl },
        { id: "CDP-chat", windowId: 17, url: "https://www.zhipin.com/web/geek/chat" }
      ];
    },
    async createTab() { throw new Error("portable communication must not create tabs"); },
    async navigate() {},
    async cdp() {},
    async evalValue() {},
    async clickAt() {},
    async startNetworkLog() {},
    async getNetworkLogMark() { return 0; },
    async readNetworkLog() { return []; },
    async stopNetworkLog() {}
  };
  const beforeCapabilityFailure = getCommunicationBatch(db, batchId);
  const beforeCapabilityEvents = Number(db.prepare("SELECT COUNT(*) AS count FROM events").get().count);
  let capabilityAdapterCreations = 0;
  let capabilityRuns = 0;
  const browserWithoutNetworkObservation = {
    ...portableBrowser,
    startNetworkLog: undefined,
    getNetworkLogMark: undefined,
    readNetworkLog: undefined,
    stopNetworkLog: undefined
  };
  await assert.rejects(
    () => communicate(db, {
      batch: batchId,
      browser: "portable",
      "cdp-port": "9222",
      "single-item": "1"
    }, {
      createBrowserFn: () => browserWithoutNetworkObservation,
      createSiteAdapterFn: () => {
        capabilityAdapterCreations += 1;
        throw new Error("capability failure must happen before site adapter creation");
      },
      runCommunicationBatchFn: async () => {
        capabilityRuns += 1;
        return { terminal: 0, total: 0 };
      }
    }),
    (error) => error.code === "BOSS_COMMUNICATION_BROWSER_CAPABILITY_MISSING"
      && /startNetworkLog/.test(error.message)
      && /getNetworkLogMark/.test(error.message)
      && /readNetworkLog/.test(error.message)
      && /stopNetworkLog/.test(error.message)
  );
  assert.strictEqual(capabilityAdapterCreations, 0);
  assert.strictEqual(capabilityRuns, 0);
  assert.deepStrictEqual(portableEvents, []);
  assert.deepStrictEqual(getCommunicationBatch(db, batchId), beforeCapabilityFailure);
  assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM events").get().count), beforeCapabilityEvents);
  const portableAdapter = {
    async preflight({ tabId } = {}) {
      portableEvents.push(`preflight:${tabId}`);
      return tabId === "CDP-chat"
        ? { tabId, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false }
        : { tabId, url: portableSearchUrl, isSearchPage: true };
    },
    async prepareCommunicationTab(tabId) {
      portableEvents.push(`weak-prepare:${tabId}`);
      return "CDP-search";
    },
    async captureCommunicationSearchState(tabId) {
      portableEvents.push(`capture:${tabId}`);
      return { url: portableSearchUrl, scrollTop: 120 };
    },
    bindCommunicationTabs(binding) { portableEvents.push(["bind", binding]); },
    async beginCommunicationSession() { portableEvents.push("begin"); },
    async restoreCommunicationSearchPage() { portableEvents.push("restore"); }
  };
  assert.deepStrictEqual(await communicate(db, {
    batch: batchId,
    browser: "portable",
    "cdp-port": "9222",
    "single-item": "1"
  }, {
    createBrowserFn: () => portableBrowser,
    createSiteAdapterFn: () => portableAdapter,
    runCommunicationBatchFn: async ({ adapter }) => {
      assert.strictEqual(adapter, portableAdapter);
      portableEvents.push("run");
      return { terminal: 0, total: 0 };
    }
  }), { terminal: 0, total: 0 });
  const expectedPortableBinding = {
    mode: "portable",
    windowId: 17,
    searchTabId: "CDP-search",
    messageTabId: "CDP-chat",
    searchReturnUrl: portableSearchUrl,
    searchScrollTop: 120,
    bindingGeneration: 1
  };
  assert.deepStrictEqual(portableEvents, [
    "listTabs",
    "preflight:CDP-chat",
    "preflight:CDP-search",
    "listTabs",
    "capture:CDP-search",
    ["bind", expectedPortableBinding],
    "begin",
    "run",
    "restore"
  ]);
  assert.deepStrictEqual(getCommunicationBatch(db, batchId).runtime.browser, expectedPortableBinding);
  assert.strictEqual(typeof getCommunicationBatch(db, batchId).runtime.browser.searchTabId, "string");

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
    async createTab() { createTabCalls += 1; throw new Error("edge communication must not create tabs"); },
    async navigate() {},
    async cdp() {},
    async evalValue() {},
    async clickAt() {},
    async startNetworkLog() {},
    async getNetworkLogMark() { return 0; },
    async readNetworkLog() { return []; },
    async stopNetworkLog() {}
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
  const summary = await communicate(db, { batch: edgeBatchId, browser: "edge", "single-item": "1" }, {
    createBrowserFn: () => edgeBrowser,
    createSiteAdapterFn: () => edgeAdapter,
    runCommunicationBatchFn: async ({ adapter, singleItemId }) => {
      assert.strictEqual(adapter, edgeAdapter);
      assert.strictEqual(singleItemId, 1);
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
    () => communicate(db, { batch: edgeBatchId, browser: "edge", "single-item": "1" }, {
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
    () => communicate(db, { batch: edgeBatchId, browser: "edge", "single-item": "1" }, {
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
      () => communicate(db, { batch: edgeBatchId, browser: "edge", "single-item": "1" }, {
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
  await assert.doesNotReject(
    () => communicate(db, { batch: driftBatchId, browser: "edge", "single-item": "1" }, {
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
    })
  );
  assert.strictEqual(driftBound, 1);
  assert.strictEqual(driftRun, 1);
  assert.strictEqual(getCommunicationBatch(db, driftBatchId).runtime.browser.searchReturnUrl, searchUrl);
  assert.strictEqual(getCommunicationBatch(db, driftBatchId).runtime.browser.searchScrollTop, 240);

  const nextSearchUrl = "https://www.zhipin.com/web/geek/jobs?query=新的关键词";
  const changedPageDeps = {
    createBrowserFn: () => ({ ...edgeBrowser, async listTabs() {
      return (await edgeBrowser.listTabs()).map((tab) => tab.id === 1995685534 ? { ...tab, url: nextSearchUrl } : tab);
    } }),
    createSiteAdapterFn: () => ({ ...edgeAdapter,
      async preflight({ tabId }) {
        return tabId === 1995685619
          ? { tabId, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false }
          : { tabId, url: nextSearchUrl, isSearchPage: true };
      },
      async captureCommunicationSearchState() { return { url: nextSearchUrl, scrollTop: 60 }; }
    }),
    runCommunicationBatchFn: async () => { driftRun += 1; return { terminal: 0, total: 0 }; }
  };
  setCommunicationBatchStatus(db, { batchId: driftBatchId, status: "running" });
  setCommunicationBatchStatus(db, { batchId: driftBatchId, status: "paused" });
  await communicate(db, { batch: driftBatchId, browser: "edge", "single-item": "1" }, changedPageDeps);
  assert.strictEqual(driftRun, 2, "a paused CLI batch can recapture its current page without changing the confirmed jobs");
  assert.strictEqual(getCommunicationBatch(db, driftBatchId).runtime.browser.bindingGeneration, 2);
  assert.strictEqual(getCommunicationBatch(db, driftBatchId).runtime.browser.searchReturnUrl, new URL(nextSearchUrl).toString());
  assert.strictEqual(getCommunicationBatch(db, driftBatchId).runtime.browser.searchScrollTop, 60);
  setCommunicationBatchStatus(db, { batchId: driftBatchId, status: "running" });
  await assert.rejects(() => communicate(db, { batch: driftBatchId, browser: "edge", "single-item": "1" }, {
    createBrowserFn: () => edgeBrowser, createSiteAdapterFn: () => edgeAdapter,
    runCommunicationBatchFn: async () => { throw new Error("must not execute after a running binding changed"); }
  }), (error) => error.code === "COMMUNICATION_BROWSER_BINDING_MISMATCH");

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
