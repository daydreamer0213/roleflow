const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { openDb } = require("../src/core/storage");
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
  const edgeBrowser = {
    async listTabs() {
      return [
        { id: 31, windowId: 7, url: "https://www.zhipin.com/web/geek/jobs" },
        { id: 32, windowId: 7, url: "https://www.zhipin.com/web/geek/chat" }
      ];
    },
    async createTab() { createTabCalls += 1; throw new Error("edge communication must not create tabs"); }
  };
  const edgeAdapter = {
    async preflight({ tabId }) {
      events.push(`preflight:${tabId}`);
      return tabId === 32
        ? { tabId: 32, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false }
        : { tabId: 31, url: "https://www.zhipin.com/web/geek/jobs", isSearchPage: true };
    },
    bindCommunicationTabs({ searchTabId, communicationTabId }) {
      events.push(`bind:${searchTabId}:${communicationTabId}`);
    },
    async prepareCommunicationTab(searchTabId) {
      events.push(`prepare:${searchTabId}`);
      return 32;
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
    "preflight:32",
    "preflight:31",
    "bind:31:32",
    "prepare:31",
    "run"
  ]);
  assert.strictEqual(createTabCalls, 0);

  let failedRunCalls = 0;
  await assert.rejects(
    () => communicate(db, { batch: edgeBatchId, browser: "edge" }, {
      createBrowserFn: () => edgeBrowser,
      createSiteAdapterFn: () => ({
        async preflight({ tabId }) {
          return tabId === 32
            ? { tabId: 32, url: "https://www.zhipin.com/web/geek/jobs", isSearchPage: true }
            : { tabId: 31, url: "https://www.zhipin.com/web/geek/jobs", isSearchPage: true };
        },
        bindCommunicationTabs() { throw new Error("must not bind after failed strict preflight"); },
        async prepareCommunicationTab() { throw new Error("must not prepare after failed strict preflight"); }
      }),
      runCommunicationBatchFn: async () => { failedRunCalls += 1; return { terminal: 0, total: 0 }; }
    }),
    (error) => error.code === "BOSS_COMMUNICATION_PAGE_LOST"
  );
  assert.strictEqual(failedRunCalls, 0);

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
