const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  openDb,
  recordSiteAccessEvent,
  listSiteAccessEvents
} = require("../src/core/storage");
const { createSiteAccessController } = require("../src/core/site_access_budget");
const { PRODUCT_POLICY } = require("../src/core/product_policy");

async function rollingWindowSmoke() {
  const db = openDb(":memory:");
  const unlockAt = Date.parse("2026-07-18T00:06:00+08:00");
  let now = unlockAt + 60 * 60 * 1000;
  recordSiteAccessEvent(db, {
    site: "boss",
    action: "risk_control",
    createdAt: new Date(unlockAt - 24 * 60 * 60 * 1000).toISOString(),
    details: { blockedUntil: new Date(unlockAt).toISOString() }
  });
  for (let index = 0; index < 5; index += 1) {
    recordSiteAccessEvent(db, {
      site: "boss",
      action: "detail_open",
      createdAt: new Date(now - 5 * 60 * 1000 + index * 1000).toISOString()
    });
  }

  const sleeps = [];
  const controller = createSiteAccessController({
    db,
    site: "boss",
    nowFn: () => now,
    randomFn: () => 0,
    sleepFn: async (delayMs) => {
      sleeps.push(delayMs);
      now += delayMs;
    }
  });
  const result = await controller.reserve("detail_open", { jobId: "job-9" });
  assert.strictEqual(result.mode, "recovery");
  assert.strictEqual(sleeps.length, 1);
  assert(sleeps[0] >= 5 * 60 * 1000 && sleeps[0] <= 5 * 60 * 1000 + 2000);
  assert.strictEqual(listSiteAccessEvents(db, {
    site: "boss",
    action: "detail_open",
    since: new Date(unlockAt - 24 * 60 * 60 * 1000).toISOString()
  }).length, 6);
  db.close();
}

async function rollingDayStopSmoke() {
  const db = openDb(":memory:");
  const now = Date.parse("2026-07-18T12:00:00+08:00");
  recordSiteAccessEvent(db, {
    site: "boss",
    action: "risk_control",
    createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString()
  });
  for (let index = 0; index < 30; index += 1) {
    recordSiteAccessEvent(db, {
      site: "boss",
      action: "detail_open",
      createdAt: new Date(now - 2 * 60 * 60 * 1000 + index * 1000).toISOString()
    });
  }
  const controller = createSiteAccessController({ db, site: "boss", nowFn: () => now, sleepFn: async () => {} });
  await assert.rejects(
    () => controller.reserve("detail_open"),
    (error) => error.code === "BOSS_ACCESS_BUDGET_EXHAUSTED"
      && error.mode === "recovery"
      && error.window === "24h"
      && error.limit === 30
      && Date.parse(error.retryAt) > now
  );
  db.close();
}

async function normalModeSmoke() {
  const db = openDb(":memory:");
  const now = Date.parse("2026-07-21T12:00:00+08:00");
  const controller = createSiteAccessController({ db, site: "boss", nowFn: () => now, sleepFn: async () => {} });
  const result = await controller.reserve("list_navigation", { keyword: "RAG" });
  assert.strictEqual(result.mode, "normal");
  assert.strictEqual(result.usage["24h"], 1);
  db.close();
}

async function naturalDayResetSmoke() {
  const db = openDb(":memory:");
  const now = Date.parse("2026-07-22T00:01:00+08:00");
  for (let index = 0; index < 16; index += 1) {
    recordSiteAccessEvent(db, {
      site: "boss",
      action: "list_navigation",
      createdAt: new Date(Date.parse("2026-07-21T23:59:00+08:00") + index).toISOString()
    });
  }
  const controller = createSiteAccessController({ db, site: "boss", nowFn: () => now, sleepFn: async () => {} });
  const result = await controller.reserve("list_navigation", { keyword: "RAG" });
  assert.strictEqual(result.usage["24h"], 1, "previous China-local day must not consume today's quota");
  db.close();
}

async function naturalDayRetryAtSmoke() {
  const db = openDb(":memory:");
  const now = Date.parse("2026-07-21T23:59:00+08:00");
  for (let index = 0; index < 16; index += 1) {
    recordSiteAccessEvent(db, {
      site: "boss",
      action: "list_navigation",
      createdAt: new Date(now - 60_000 + index).toISOString()
    });
  }
  const controller = createSiteAccessController({ db, site: "boss", nowFn: () => now, sleepFn: async () => {} });
  await assert.rejects(
    () => controller.reserve("list_navigation"),
    (error) => error.code === "BOSS_ACCESS_BUDGET_EXHAUSTED"
      && error.window === "24h"
      && error.limit === 16
      && error.retryAt === "2026-07-21T16:00:00.000Z"
  );
  db.close();
}

function configuredDetailBudgetsSmoke() {
  assert.deepStrictEqual(PRODUCT_POLICY.operations.bossAccessBudget.modes.normal.pane_detail_read, {
    "10m": 45,
    "1h": 240,
    "24h": 360
  });
  assert.deepStrictEqual(PRODUCT_POLICY.operations.bossAccessBudget.modes.recovery.pane_detail_read, {
    "10m": 20,
    "1h": 80,
    "24h": 120
  });
  assert.deepStrictEqual(PRODUCT_POLICY.operations.bossAccessBudget.modes.normal.detail_open, {
    "10m": 8,
    "1h": 25,
    "24h": 60
  });
  assert.deepStrictEqual(PRODUCT_POLICY.operations.bossAccessBudget.modes.recovery.detail_open, {
    "10m": 5,
    "1h": 15,
    "24h": 30
  });
  assert.strictEqual(PRODUCT_POLICY.dailyScan.maxDetailTotal, 240);
  assert.deepStrictEqual(PRODUCT_POLICY.dailyScan.detailLimits, { A: 45, B: 30 });
  assert.deepStrictEqual(PRODUCT_POLICY.operations.bossAccessBudget.modes.normal.list_navigation, { "24h": 16 });
  assert.deepStrictEqual(PRODUCT_POLICY.operations.bossAccessBudget.modes.normal.list_scroll, { "24h": 120 });
}

async function paneDetailDailyStopSmoke() {
  const db = openDb(":memory:");
  const now = Date.parse("2026-07-21T12:00:00+08:00");
  for (let index = 0; index < 360; index += 1) {
    recordSiteAccessEvent(db, {
      site: "boss",
      action: "pane_detail_read",
      createdAt: new Date(now - 2 * 60 * 60_000 + index).toISOString()
    });
  }
  const controller = createSiteAccessController({ db, site: "boss", nowFn: () => now, sleepFn: async () => {} });
  await assert.rejects(
    () => controller.reserve("pane_detail_read"),
    (error) => error.code === "BOSS_ACCESS_BUDGET_EXHAUSTED"
      && error.window === "24h"
      && error.limit === 360
      && error.message.includes("右栏详情")
  );
  db.close();
}

async function abortDuringWindowWaitSmoke() {
  const db = openDb(":memory:");
  let now = Date.parse("2026-07-21T12:00:00+08:00");
  for (let index = 0; index < 8; index += 1) {
    recordSiteAccessEvent(db, {
      site: "boss",
      action: "detail_open",
      createdAt: new Date(now - 60_000 + index * 1000).toISOString()
    });
  }
  const abortController = new AbortController();
  const controller = createSiteAccessController({
    db,
    site: "boss",
    signal: abortController.signal,
    nowFn: () => now,
    randomFn: () => 0,
    sleepFn: async (delayMs) => {
      now += delayMs;
      abortController.abort(Object.assign(new Error("cancelled"), { code: "SCAN_ABORTED" }));
    }
  });
  await assert.rejects(() => controller.reserve("detail_open"), (error) => error.code === "SCAN_ABORTED");
  db.close();
}

async function communicationTenMinuteBudgetSmoke() {
  const db = openDb(":memory:");
  let now = Date.parse("2026-07-21T12:00:00+08:00");
  for (let index = 0; index < 8; index += 1) {
    recordSiteAccessEvent(db, {
      site: "boss",
      action: "detail_open",
      createdAt: new Date(now - 60_000 + index).toISOString()
    });
  }
  for (let index = 0; index < 21; index += 1) {
    recordSiteAccessEvent(db, {
      site: "boss",
      action: "communication_visit",
      createdAt: new Date(now - 30_000 + index).toISOString()
    });
  }

  const sleeps = [];
  const controller = createSiteAccessController({
    db,
    site: "boss",
    nowFn: () => now,
    randomFn: () => 0,
    sleepFn: async (delayMs) => {
      sleeps.push(delayMs);
      now += delayMs;
    }
  });
  const first = await controller.reserve("communication_visit", { batchId: 1, jobId: 9 });
  assert.strictEqual(first.usage["10m"], 30);
  assert.strictEqual(sleeps.length, 0);
  await controller.reserve("communication_visit", { batchId: 1, jobId: 10 });
  assert.deepStrictEqual(sleeps, [541_000]);
  db.close();
}

async function communicationThirtyMinuteBudgetSmoke() {
  const db = openDb(":memory:");
  let now = Date.parse("2026-07-21T12:00:00+08:00");
  for (let index = 0; index < 60; index += 1) {
    recordSiteAccessEvent(db, {
      site: "boss",
      action: index % 2 === 0 ? "detail_open" : "communication_visit",
      createdAt: new Date(now - 20 * 60_000 + index).toISOString()
    });
  }

  const sleeps = [];
  const controller = createSiteAccessController({
    db,
    site: "boss",
    nowFn: () => now,
    randomFn: () => 0,
    sleepFn: async (delayMs) => {
      sleeps.push(delayMs);
      now += delayMs;
    }
  });
  await controller.reserve("communication_visit", { batchId: 1, jobId: 11 });
  assert.deepStrictEqual(sleeps, [601_000]);
  db.close();
}

async function communicationWindowBoundarySmoke() {
  const db = openDb(":memory:");
  let now = Date.parse("2026-07-21T12:00:00+08:00");
  recordSiteAccessEvent(db, {
    site: "boss",
    action: "detail_open",
    createdAt: new Date(now - 10 * 60_000).toISOString()
  });
  for (let index = 0; index < 30; index += 1) {
    recordSiteAccessEvent(db, {
      site: "boss",
      action: "communication_visit",
      createdAt: new Date(now - 60_000 + index).toISOString()
    });
  }

  const sleeps = [];
  const controller = createSiteAccessController({
    db,
    site: "boss",
    nowFn: () => now,
    randomFn: () => 0,
    sleepFn: async (delayMs) => {
      sleeps.push(delayMs);
      now += delayMs;
    }
  });
  await controller.reserve("communication_visit", { batchId: 1, jobId: 13 });
  assert.deepStrictEqual(sleeps, [541_000]);
  db.close();
}

async function communicationUsesControllerPolicySmoke() {
  const db = openDb(":memory:");
  const now = Date.parse("2026-07-21T12:00:00+08:00");
  for (let index = 0; index < 8; index += 1) {
    recordSiteAccessEvent(db, {
      site: "boss",
      action: "detail_open",
      createdAt: new Date(now - 60_000 + index).toISOString()
    });
  }
  for (let index = 0; index < 29; index += 1) {
    recordSiteAccessEvent(db, {
      site: "boss",
      action: "communication_visit",
      createdAt: new Date(now - 30_000 + index).toISOString()
    });
  }

  const sleeps = [];
  const controller = createSiteAccessController({
    db,
    site: "boss",
    policy: {
      ...PRODUCT_POLICY.operations.bossAccessBudget,
      combinedUsage: {
        ...PRODUCT_POLICY.operations.bossCommunication.combinedUsage,
        "10m": ["communication_visit"]
      }
    },
    nowFn: () => now,
    randomFn: () => 0,
    sleepFn: async (delayMs) => sleeps.push(delayMs)
  });
  const result = await controller.reserve("communication_visit", { batchId: 1, jobId: 14 });
  assert.strictEqual(result.usage["10m"], 30);
  assert.deepStrictEqual(sleeps, []);
  db.close();
}

async function communicationDailyBudgetSmoke() {
  const db = openDb(":memory:");
  const now = Date.parse("2026-07-21T12:00:00+08:00");
  for (let index = 0; index < 500; index += 1) {
    recordSiteAccessEvent(db, {
      site: "boss",
      action: "detail_open",
      createdAt: new Date(now - 23 * 60 * 60_000 + index).toISOString()
    });
  }
  for (let index = 0; index < 150; index += 1) {
    recordSiteAccessEvent(db, {
      site: "boss",
      action: "communication_visit",
      createdAt: new Date(now - 2 * 60 * 60_000 + index).toISOString()
    });
  }

  const controller = createSiteAccessController({ db, site: "boss", nowFn: () => now, sleepFn: async () => {} });
  await assert.rejects(
    () => controller.reserve("communication_visit", { batchId: 1, jobId: 12 }),
    (error) => error.code === "BOSS_ACCESS_BUDGET_EXHAUSTED"
      && error.window === "24h"
      && error.limit === 150
      && error.usage["24h"] === 150
  );
  db.close();
}

async function communicationReservationIsIdempotentSmoke() {
  const db = openDb(":memory:");
  const now = Date.parse("2026-07-21T12:00:00+08:00");
  const controller = createSiteAccessController({ db, site: "boss", nowFn: () => now, sleepFn: async () => {} });
  const details = { batchId: 7, itemId: 99, jobId: 12 };
  const first = await controller.reserve("communication_visit", details);
  const second = await controller.reserve("communication_visit", details);
  assert.strictEqual(first.reused, false);
  assert.strictEqual(second.reused, true);
  assert.strictEqual(second.usage["24h"], 1);
  assert.strictEqual(listSiteAccessEvents(db, {
    site: "boss",
    action: "communication_visit",
    since: new Date(now - 1000).toISOString()
  }).length, 1);
  db.close();
}

async function transactionBoundarySmoke() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-access-transaction-"));
  const dbPath = path.join(root, "jobs.sqlite");
  const db = openDb(dbPath);
  const observer = openDb(dbPath);
  try {
    let now = Date.parse("2026-07-21T12:00:00+08:00");
    for (let index = 0; index < 8; index += 1) {
      recordSiteAccessEvent(db, {
        site: "boss",
        action: "detail_open",
        createdAt: new Date(now - 60_000 + index).toISOString()
      });
    }

    const transaction = instrumentTransactions(db);
    const controller = createSiteAccessController({
      db,
      site: "boss",
      nowFn: () => now,
      randomFn: () => 0,
      sleepFn: async (delayMs) => {
        assert.strictEqual(transaction.open, false, "budget transaction must be released before waiting");
        observer.exec("BEGIN IMMEDIATE");
        observer.exec("ROLLBACK");
        now += delayMs;
      }
    });
    await controller.reserve("detail_open", { jobId: "atomic-wait" });
    assert(transaction.commands.includes("BEGIN IMMEDIATE"));
    assert(transaction.commands.includes("COMMIT"));
    assert.strictEqual(transaction.recordedOutsideTransaction, 0, "usage read and event insert must share one write transaction");

    const dailyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-access-daily-"));
    const dailyPath = path.join(dailyRoot, "jobs.sqlite");
    const dailyDb = openDb(dailyPath);
    const dailyObserver = openDb(dailyPath);
    try {
      const dailyNow = Date.parse("2026-07-21T12:00:00+08:00");
      recordSiteAccessEvent(dailyDb, {
        site: "boss",
        action: "risk_control",
        createdAt: new Date(dailyNow - 2 * 60 * 60_000).toISOString()
      });
      for (let index = 0; index < 30; index += 1) {
        recordSiteAccessEvent(dailyDb, {
          site: "boss",
          action: "detail_open",
          createdAt: new Date(dailyNow - 60_000 + index).toISOString()
        });
      }
      const dailyTransaction = instrumentTransactions(dailyDb);
      const dailyController = createSiteAccessController({ db: dailyDb, site: "boss", nowFn: () => dailyNow });
      await assert.rejects(
        () => dailyController.reserve("detail_open"),
        (error) => error.code === "BOSS_ACCESS_BUDGET_EXHAUSTED"
      );
      assert.strictEqual(dailyTransaction.open, false, "budget transaction must be released before throwing");
      dailyObserver.exec("BEGIN IMMEDIATE");
      dailyObserver.exec("ROLLBACK");
      assert.deepStrictEqual(dailyTransaction.commands.slice(-2), ["BEGIN IMMEDIATE", "COMMIT"]);
    } finally {
      dailyDb.close();
      dailyObserver.close();
      fs.rmSync(dailyRoot, { recursive: true, force: true });
    }
  } finally {
    db.close();
    observer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function instrumentTransactions(db) {
  const state = { open: false, commands: [], recordedOutsideTransaction: 0 };
  const originalExec = db.exec.bind(db);
  const originalPrepare = db.prepare.bind(db);
  db.exec = (sql) => {
    const command = String(sql).trim().toUpperCase();
    if (["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"].includes(command)) state.commands.push(command);
    const result = originalExec(sql);
    if (command === "BEGIN IMMEDIATE") state.open = true;
    if (command === "COMMIT" || command === "ROLLBACK") state.open = false;
    return result;
  };
  db.prepare = (sql) => {
    if (String(sql).includes("INSERT INTO events") && !state.open) state.recordedOutsideTransaction += 1;
    return originalPrepare(sql);
  };
  return state;
}

function filteredLedgerLimitSmoke() {
  const db = openDb(":memory:");
  const base = Date.parse("2026-07-21T12:00:00+08:00");
  for (let index = 0; index < 150; index += 1) {
    recordSiteAccessEvent(db, {
      site: "boss",
      action: "detail_open",
      createdAt: new Date(base + index * 1000).toISOString()
    });
  }
  recordSiteAccessEvent(db, {
    site: "boss",
    action: "risk_control",
    createdAt: new Date(base + 151_000).toISOString()
  });
  assert.strictEqual(listSiteAccessEvents(db, {
    site: "boss",
    action: "risk_control",
    since: new Date(base).toISOString(),
    limit: 100
  }).length, 1);
  db.close();
}

Promise.resolve()
  .then(rollingWindowSmoke)
  .then(rollingDayStopSmoke)
  .then(normalModeSmoke)
  .then(naturalDayResetSmoke)
  .then(naturalDayRetryAtSmoke)
  .then(configuredDetailBudgetsSmoke)
  .then(paneDetailDailyStopSmoke)
  .then(abortDuringWindowWaitSmoke)
  .then(communicationTenMinuteBudgetSmoke)
  .then(communicationThirtyMinuteBudgetSmoke)
  .then(communicationWindowBoundarySmoke)
  .then(communicationUsesControllerPolicySmoke)
  .then(communicationDailyBudgetSmoke)
  .then(communicationReservationIsIdempotentSmoke)
  .then(transactionBoundarySmoke)
  .then(filteredLedgerLimitSmoke)
  .then(() => console.log("site_access_budget_smoke ok"))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
