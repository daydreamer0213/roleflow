const assert = require("node:assert");
const {
  openDb,
  recordSiteAccessEvent,
  listSiteAccessEvents
} = require("../src/core/storage");
const { createSiteAccessController } = require("../src/core/site_access_budget");

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
  for (let index = 0; index < 8; index += 1) {
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
  }).length, 9);
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
  for (let index = 0; index < 20; index += 1) {
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
      && error.limit === 20
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

async function abortDuringWindowWaitSmoke() {
  const db = openDb(":memory:");
  let now = Date.parse("2026-07-21T12:00:00+08:00");
  for (let index = 0; index < 12; index += 1) {
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
  assert.strictEqual(sleeps.length, 1);
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
  assert.strictEqual(sleeps.length, 1);
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
  .then(abortDuringWindowWaitSmoke)
  .then(communicationTenMinuteBudgetSmoke)
  .then(communicationThirtyMinuteBudgetSmoke)
  .then(communicationDailyBudgetSmoke)
  .then(filteredLedgerLimitSmoke)
  .then(() => console.log("site_access_budget_smoke ok"))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
