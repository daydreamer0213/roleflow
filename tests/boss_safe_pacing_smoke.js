const assert = require("node:assert/strict");
const {
  openDb,
  createBatch,
  createScanRun,
  beginScanRun,
  acquireSiteScanLease,
  checkpointScanProgress,
  finishScanRun,
  getBatch,
  getSiteRuntimeState,
  listSiteAccessEvents,
  recordSiteAccessEvent
} = require("../src/core/storage");
const { PRODUCT_POLICY } = require("../src/core/product_policy");
const { BossSiteAdapter } = require("../src/adapters/sites/boss");
const { createSiteAccessController, formatAccessWaitDuration, resolveAccessMode } = require("../src/core/site_access_budget");
const { assertBossRuntimeTabBindings } = require("../src/core/workspace_tabs");
const { validateResumeBatch } = require("../src/core/scan_resume");
const { buildScanExecutionSnapshot } = require("../src/core/scan_snapshot");
const { persistBossRiskControl, executeTrackedScanRun } = require("../src/cli");

main().then(() => console.log("boss_safe_pacing_smoke ok")).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  await paneDetailDelaySmoke();
  await pacingRestoreFailClosedSmoke();
  await productionScanPacingCompositionSmoke();
  await sqliteCheckpointResumeChainSmoke();
  await threeMinuteBudgetSmoke();
  recoveryExpirySmoke();
  invalidRiskTimeSmoke();
  checkpointResumeSmoke();
  riskControlClassificationSmoke();
  await trackedRiskPersistsOnceSmoke();
  assert.strictEqual(formatAccessWaitDuration(2_500), "约 3 秒");
  assert.strictEqual(formatAccessWaitDuration(61_000), "约 2 分钟");
}

async function pacingRestoreFailClosedSmoke() {
  const adapter = new BossSiteAdapter({ sleepFn: async () => {}, randomFn: () => 0 });
  adapter.restorePacing({
    pacedActions: 1,
    nextPacingCooldownAt: Number.MAX_SAFE_INTEGER,
    detailActions: 1,
    nextDetailMicroCooldownAt: 7,
    nextDetailMacroCooldownAt: 17
  });
  assert.deepStrictEqual(adapter.pacingState(), {
    pacedActions: 0,
    nextPacingCooldownAt: 18,
    detailActions: 0,
    nextDetailMicroCooldownAt: 6,
    nextDetailMacroCooldownAt: 16
  });
  adapter.restorePacing({
    pacedActions: 1,
    nextPacingCooldownAt: 19,
    detailActions: 1,
    nextDetailMicroCooldownAt: 7,
    nextDetailMacroCooldownAt: 17,
    sleep: "unsafe"
  });
  assert.strictEqual(typeof adapter.sleep, "function");
  assert.strictEqual(adapter.pacedActions, 0);
  for (const invalidState of [
    { pacedActions: 1.5, nextPacingCooldownAt: 19, detailActions: 1, nextDetailMicroCooldownAt: 7, nextDetailMacroCooldownAt: 17 },
    { pacedActions: 1, nextPacingCooldownAt: 19, detailActions: 1, nextDetailMicroCooldownAt: -1, nextDetailMacroCooldownAt: 17 },
    { pacedActions: 1, nextPacingCooldownAt: 19, detailActions: 1, nextDetailMicroCooldownAt: 15, nextDetailMacroCooldownAt: 17 }
  ]) {
    adapter.restorePacing(invalidState);
    assert.strictEqual(adapter.pacedActions, 0);
    assert.strictEqual(adapter.nextPacingCooldownAt, 18);
  }
  adapter.restorePacing({
    pacedActions: 18,
    nextPacingCooldownAt: 18,
    detailActions: 6,
    nextDetailMicroCooldownAt: 6,
    nextDetailMacroCooldownAt: 16
  });
  const sleeps = [];
  adapter.sleep = async (ms) => sleeps.push(ms);
  await adapter.waitWithPacing("pane_detail_read");
  assert.deepStrictEqual(sleeps, [8000, 4000], "a saved overdue threshold must conservatively cool down first");
}

async function productionScanPacingCompositionSmoke() {
  const order = [];
  let reads = 0;
  const adapter = new BossSiteAdapter({
    browser: { async navigate() {} },
    sleepFn: async () => {},
    randomFn: () => 0
  });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [testCard("success"), testCard("failure"), testCard("cached")];
  adapter.readVisiblePaneDetail = async (_tabId, job) => {
    reads += 1;
    if (job.sourceId === "failure") throw Object.assign(new Error("pane timed out"), { code: "BOSS_PANE_SWITCH_TIMEOUT" });
    return { description: "complete pane detail ".repeat(20), bossActiveText: "today" };
  };
  const jobs = await adapter.scanBrowser({
    tabId: "search",
    keywords: ["pacing"],
    cityScopes: [{ city: "Guangzhou", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 3,
    getReusableDetail: (job) => job.sourceId === "cached"
      ? { description: "cached complete detail ".repeat(20), bossActiveText: "today" }
      : null,
    onDetailCheckpoint: async () => order.push("detail-checkpoint"),
    onPacingCheckpoint: async (state) => order.push(`pacing-${state.detailActions}`),
    onDetailResult: async (result) => order.push(`detail-${result.outcome}`)
  });
  assert.strictEqual(reads, 2);
  assert.deepStrictEqual(order, [
    "detail-checkpoint", "pacing-1", "detail-succeeded", "pacing-2", "detail-failed"
  ]);
  assert.deepStrictEqual(jobs.map((job) => [job.sourceId, job.detailRead, Boolean(job.detailReused)]), [
    ["success", true, false], ["failure", false, false], ["cached", true, true]
  ]);
  const resumed = new BossSiteAdapter({ sleepFn: async () => {}, randomFn: () => 0 });
  resumed.restorePacing({
    pacedActions: 18,
    nextPacingCooldownAt: 18,
    detailActions: 2,
    nextDetailMicroCooldownAt: 6,
    nextDetailMacroCooldownAt: 16
  });
  const resumedSleeps = [];
  resumed.sleep = async (ms) => resumedSleeps.push(ms);
  await resumed.waitWithPacing("pane_detail_read");
  assert.deepStrictEqual(resumedSleeps, [8000, 4000], "the resumed first detail cannot burst past an overdue cooldown");
}

async function paneDetailDelaySmoke() {
  const sleeps = [];
  let paneJobId = "first";
  const adapter = new BossSiteAdapter({
    browser: {
      async evalValue(_tabId, expression) {
        if (expression.includes("window.__bossPaneState()")) {
          return {
            activeJobId: paneJobId,
            componentCurrentJobId: paneJobId,
            paneJobId,
            currentJobId: paneJobId,
            jobDetailLoading: false,
            title: `Role ${paneJobId}`,
            description: "complete detail ".repeat(20),
            canScroll: false
          };
        }
        return true;
      }
    },
    sleepFn: async (ms) => sleeps.push(ms),
    randomFn: () => 0
  });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  for (const id of ["first", "second"]) {
    paneJobId = id;
    const detail = await adapter.readVisiblePaneDetail("search", {
      title: `Role ${id}`,
      url: `https://www.zhipin.com/job_detail/${id}.html`
    });
    assert(detail?.description.length >= 120);
  }
  assert.deepStrictEqual(sleeps, [8000, 8000]);
  assert.strictEqual(adapter.pacedActions, 2);
}

async function threeMinuteBudgetSmoke() {
  const now = Date.parse("2026-08-12T12:00:00+08:00");
  for (const [mode, limit] of [["normal", 12], ["recovery", 5]]) {
    const db = openDb(":memory:");
    if (mode === "recovery") {
      recordSiteAccessEvent(db, {
        site: "boss",
        action: "risk_control",
        createdAt: new Date(now - 1_000).toISOString(),
        details: { blockedUntil: new Date(now + 48 * 60 * 60_000).toISOString() }
      });
    }
    for (let index = 0; index < limit; index += 1) {
      recordSiteAccessEvent(db, {
        site: "boss",
        action: "pane_detail_read",
        createdAt: new Date(now - 1_000 + index).toISOString()
      });
    }
    const waits = [];
    let clock = now;
    const controller = createSiteAccessController({
      db,
      site: "boss",
      nowFn: () => clock,
      randomFn: () => 0,
      sleepFn: async (ms) => {
        waits.push(ms);
        clock += ms;
      }
    });
    await controller.reserve("pane_detail_read", { jobId: `${mode}-job` });
    assert.strictEqual(waits.length, 1, `${mode} must cool down at its three-minute limit`);
    assert.strictEqual(PRODUCT_POLICY.operations.bossAccessBudget.modes[mode].pane_detail_read["3m"], limit);
    db.close();
  }
}

function recoveryExpirySmoke() {
  const riskAt = Date.parse("2026-08-12T00:00:00.000Z");
  const hour = 60 * 60_000;
  for (const [label, sourceBlockedUntil, expectedBlockedUntil] of [
    ["early", "2026-08-13T08:00:00+08:00", "2026-08-13T08:00:00+08:00"],
    ["late", "2026-08-15T08:00:00+08:00", "2026-08-15T08:00:00+08:00"],
    ["missing", null, riskAt + 48 * hour],
    ["invalid", "not-a-date", riskAt + 48 * hour]
  ]) {
    const db = openDb(":memory:");
    const error = Object.assign(new Error(label), { code: "BOSS_RISK_CONTROL" });
    if (sourceBlockedUntil !== null) error.blockedUntil = sourceBlockedUntil;
    persistBossRiskControl(db, { site: "boss", runId: label, error, nowMs: riskAt });
    const expectedValue = typeof expectedBlockedUntil === "number"
      ? new Date(expectedBlockedUntil).toISOString()
      : expectedBlockedUntil;
    assert.strictEqual(getSiteRuntimeState(db, "boss").details.blockedUntil, expectedValue);
    const riskEvent = listSiteAccessEvents(db, { site: "boss", action: "risk_control" })[0];
    assert.strictEqual(riskEvent.createdAt, new Date(riskAt).toISOString());
    assert.strictEqual(riskEvent.details.blockedUntil, expectedValue);
    if (label === "early") {
      assert.strictEqual(resolveAccessMode(db, { site: "boss", nowMs: riskAt + 47 * hour }), "recovery");
      assert.strictEqual(resolveAccessMode(db, { site: "boss", nowMs: riskAt + 49 * hour }), "normal");
    }
    if (["missing", "invalid"].includes(label)) {
      assert.strictEqual(resolveAccessMode(db, { site: "boss", nowMs: riskAt + 49 * hour }), "normal");
    }
    if (label === "late") {
      assert.strictEqual(resolveAccessMode(db, { site: "boss", nowMs: riskAt + 71 * hour }), "recovery");
      assert.strictEqual(resolveAccessMode(db, { site: "boss", nowMs: riskAt + 73 * hour }), "normal");
    }
    db.close();
  }
}

function invalidRiskTimeSmoke() {
  const hour = 60 * 60_000;
  const platformBlockedUntil = "2099-01-01T00:00:00.000Z";
  const db = openDb(":memory:");
  const error = Object.assign(new Error("invalid now"), {
    code: "BOSS_RISK_CONTROL",
    blockedUntil: platformBlockedUntil
  });
  assert.doesNotThrow(() => persistBossRiskControl(db, {
    site: "boss",
    runId: "invalid-now-platform",
    error,
    nowMs: NaN
  }));
  assert.strictEqual(getSiteRuntimeState(db, "boss").details.blockedUntil, platformBlockedUntil);
  const [riskEvent] = listSiteAccessEvents(db, { site: "boss", action: "risk_control" });
  assert.strictEqual(listSiteAccessEvents(db, { site: "boss", action: "risk_control" }).length, 1);
  const createdAtMs = Date.parse(riskEvent.createdAt);
  assert(Number.isFinite(createdAtMs));
  assert.strictEqual(resolveAccessMode(db, { site: "boss", nowMs: createdAtMs + 47 * hour }), "recovery");
  assert.strictEqual(resolveAccessMode(db, { site: "boss", nowMs: Date.parse(platformBlockedUntil) + hour }), "normal");
  db.close();

  const fallbackDb = openDb(":memory:");
  assert.doesNotThrow(() => persistBossRiskControl(fallbackDb, {
    site: "boss",
    runId: "invalid-now-fallback",
    error: Object.assign(new Error("invalid now fallback"), { code: "BOSS_RISK_CONTROL" }),
    nowMs: NaN
  }));
  const fallbackState = getSiteRuntimeState(fallbackDb, "boss");
  const [fallbackEvent] = listSiteAccessEvents(fallbackDb, { site: "boss", action: "risk_control" });
  assert(Number.isFinite(Date.parse(fallbackEvent.createdAt)));
  assert.strictEqual(Date.parse(fallbackState.details.blockedUntil) - Date.parse(fallbackEvent.createdAt), 48 * hour);
  fallbackDb.close();
}

async function sqliteCheckpointResumeChainSmoke() {
  const db = openDb(":memory:");
  const snapshot = executionSnapshot();
  const batchId = createBatch(db, "boss", "chain", "chain", {
    status: "running", profileId: 1, searchPlanId: 2, filterSnapshot: { execution: snapshot }
  });
  const run = createScanRun(db, { runId: "chain-run", site: "boss", command: "scan", planId: 2 });
  acquireSiteScanLease(db, { site: "boss", owner: "chain-owner", planId: 2 });
  beginScanRun(db, { runId: run.id, batchId, leaseOwner: "chain-owner" });
  const accessController = createSiteAccessController({ db, site: "boss", runId: run.id, nowFn: () => 0, sleepFn: async () => {} });
  const firstSleeps = [];
  const first = checkpointAdapter({ accessController, sleeps: firstSleeps, cards: [testCard("one"), testCard("two")] });
  await assert.rejects(() => first.scanBrowser({
    tabId: "search", keywords: ["chain"], cityScopes: [{ city: "Guangzhou", cityCode: "101280100" }], maxCards: 20, maxDetailTotal: 2,
    onDetailCheckpoint: async ({ job }) => {
      checkpointScanProgress(db, { runId: run.id, batchId, leaseOwner: "chain-owner", jobs: [checkpointJob(job)] });
      if (job.sourceId === "two") throw Object.assign(new Error("simulated interruption"), { code: "SCAN_ABORTED" });
    },
    onPacingCheckpoint: async (pacingState) => checkpointScanProgress(db, {
      runId: run.id, batchId, leaseOwner: "chain-owner", jobs: [], runtime: { bossPacing: pacingState }
    })
  }), (error) => error.code === "SCAN_ABORTED");
  assert.deepStrictEqual(firstSleeps.filter((ms) => ms === 8000), [8000, 8000]);
  const savedRuntime = getBatch(db, batchId).filterSnapshot.runtime.bossPacing;
  assert.strictEqual(savedRuntime.detailActions, 1, "the interrupted job is absent from the latest pacing checkpoint");
  const overdueRuntime = { ...savedRuntime, nextPacingCooldownAt: savedRuntime.pacedActions };
  checkpointScanProgress(db, {
    runId: run.id, batchId, leaseOwner: "chain-owner", jobs: [], runtime: { bossPacing: overdueRuntime }
  });
  finishScanRun(db, { runId: run.id, leaseOwner: "chain-owner", status: "interrupted" });
  const resumed = validateResumeBatch({ resumeBatchId: batchId, resumedBatch: getBatch(db, batchId), site: "boss", planId: 2 });
  assert.strictEqual(resumed.runtime.bossPacing.detailActions, 1, "pacing may lag the interrupted job by only one detail");
  assert.strictEqual(resumed.runtime.bossPacing.nextPacingCooldownAt, overdueRuntime.nextPacingCooldownAt);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM job_observations WHERE batch_id = ?").get(batchId).n, 2);
  assert.strictEqual(listSiteAccessEvents(db, { site: "boss", action: "pane_detail_read" }).length, 2);

  const resumedSleeps = [];
  const resumedAdapter = checkpointAdapter({ accessController, sleeps: resumedSleeps, cards: [testCard("three")] });
  const jobs = await resumedAdapter.scanBrowser({
    tabId: "search", keywords: ["chain"], cityScopes: [{ city: "Guangzhou", cityCode: "101280100" }], maxCards: 20, maxDetailTotal: 1,
    pacingState: resumed.runtime.bossPacing
  });
  assert.deepStrictEqual(resumedSleeps.filter((ms) => ms === 4000 || ms === 8000), [4000, 8000]);
  assert.deepStrictEqual(jobs.map((job) => [job.sourceId, job.detailRead]), [["three", true]]);
  assert.strictEqual(listSiteAccessEvents(db, { site: "boss", action: "pane_detail_read" }).length, 3);
  db.close();
}

function checkpointResumeSmoke() {
  const db = openDb(":memory:");
  const snapshot = executionSnapshot();
  const batchId = createBatch(db, "boss", "pacing", "pacing", {
    status: "running",
    profileId: 1,
    searchPlanId: 2,
    filterSnapshot: { execution: snapshot }
  });
  const run = createScanRun(db, { runId: "pacing-run", site: "boss", command: "scan", planId: 2 });
  acquireSiteScanLease(db, { site: "boss", owner: "pacing-owner", planId: 2 });
  beginScanRun(db, { runId: run.id, batchId, leaseOwner: "pacing-owner" });
  const pacing = { pacedActions: 7, nextPacingCooldownAt: 19, detailActions: 7, nextDetailMicroCooldownAt: 8, nextDetailMacroCooldownAt: 18 };
  checkpointScanProgress(db, { runId: run.id, batchId, leaseOwner: "pacing-owner", jobs: [], runtime: { bossPacing: pacing } });
  const checkpointed = getBatch(db, batchId);
  assert.deepStrictEqual(checkpointed.filterSnapshot.runtime.bossPacing, pacing);
  assert.strictEqual(checkpointed.filterSnapshot.execution.snapshotHash, snapshot.snapshotHash);
  finishScanRun(db, { runId: run.id, leaseOwner: "pacing-owner", status: "interrupted" });
  const resumed = validateResumeBatch({ resumeBatchId: batchId, resumedBatch: getBatch(db, batchId), site: "boss", planId: 2 });
  assert.deepStrictEqual(resumed.runtime.bossPacing, pacing);
  const resumedAdapter = new BossSiteAdapter({ randomFn: () => 0 });
  resumedAdapter.restorePacing(resumed.runtime.bossPacing);
  assert.deepStrictEqual(resumedAdapter.pacingState(), pacing);

  const oldBatchId = createBatch(db, "boss", "old", "old", {
    status: "interrupted",
    profileId: 1,
    searchPlanId: 2,
    filterSnapshot: { execution: snapshot }
  });
  const oldResume = validateResumeBatch({ resumeBatchId: oldBatchId, resumedBatch: getBatch(db, oldBatchId), site: "boss", planId: 2 });
  assert.deepStrictEqual(oldResume.runtime, {});
  db.close();
}

function riskControlClassificationSmoke() {
  const verifyError = captureSearchTabChange("https://www.zhipin.com/web/passport/zp/verify.html?token=private");
  assert.deepStrictEqual(verifyError.observedLocation, {
    origin: "https://www.zhipin.com",
    path: "/web/passport/zp/verify.html"
  });
  assert(!JSON.stringify(verifyError).includes("private"));
  const db = openDb(":memory:");
  assert.strictEqual(persistBossRiskControl(db, { site: "boss", runId: "risk-run", phase: "tracked_run", error: verifyError, nowMs: 0 }), true);
  const state = getSiteRuntimeState(db, "boss");
  assert.strictEqual(state.status, "blocked");
  assert.strictEqual(Date.parse(state.details.blockedUntil), 48 * 60 * 60_000);
  const risks = listSiteAccessEvents(db, { site: "boss", action: "risk_control" });
  assert.deepStrictEqual(risks[0].details.observedLocation, verifyError.observedLocation);
  assert(!JSON.stringify(risks[0]).includes("private"));

  const manualError = captureSearchTabChange("https://www.zhipin.com/web/geek/chat?company=private");
  assert.strictEqual(persistBossRiskControl(db, { site: "boss", runId: "manual-run", phase: "tracked_run", error: manualError, nowMs: 0 }), false);
  assert.strictEqual(listSiteAccessEvents(db, { site: "boss", action: "risk_control" }).length, 1);
  db.close();
}

async function trackedRiskPersistsOnceSmoke() {
  for (const error of [
    Object.assign(new Error("risk"), { code: "BOSS_RISK_CONTROL" }),
    captureSearchTabChange("https://www.zhipin.com/web/passport/zp/verify.html?token=private")
  ]) {
    const db = openDb(":memory:");
    db.exec(`CREATE TABLE runtime_writes(kind TEXT NOT NULL);
      CREATE TEMP TRIGGER runtime_state_insert AFTER INSERT ON site_runtime_states
      BEGIN INSERT INTO runtime_writes(kind) VALUES ('insert'); END;
      CREATE TEMP TRIGGER runtime_state_update AFTER UPDATE ON site_runtime_states
      BEGIN INSERT INTO runtime_writes(kind) VALUES ('update'); END;`);
    const batchId = createBatch(db, "boss", "risk", "risk", { status: "running", profileId: 1, searchPlanId: 2 });
    const run = createScanRun(db, { runId: `risk-${error.code}`, site: "boss", command: "scan", planId: 2 });
    acquireSiteScanLease(db, { site: "boss", owner: "risk-owner", planId: 2 });
    beginScanRun(db, { runId: run.id, batchId, leaseOwner: "risk-owner" });
    await assert.rejects(
      () => executeTrackedScanRun(db, {
        runId: run.id,
        leaseOwner: "risk-owner",
        runLogger: { info() {}, warn() {}, error() {} },
        run: async () => { throw error; },
        execution: { site: "boss" }
      }),
      (received) => received === error
    );
    assert.strictEqual(listSiteAccessEvents(db, { site: "boss", action: "risk_control" }).length, 1);
    assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM site_runtime_states WHERE site = 'boss'").get().n), 1);
    assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM runtime_writes").get().n), 1);
    db.close();
  }
}

function captureSearchTabChange(url) {
  assert.throws(() => assertBossRuntimeTabBindings([
    { id: "search", url, windowId: 1 },
    { id: "communication", url: "https://www.zhipin.com/web/geek/chat", windowId: 1 }
  ], { expectedSearchTabId: "search", expectedCommunicationTabId: "communication" }), (error) => {
    assert.strictEqual(error.code, "BOSS_SEARCH_TAB_CHANGED");
    return true;
  });
  try {
    assertBossRuntimeTabBindings([
      { id: "search", url, windowId: 1 },
      { id: "communication", url: "https://www.zhipin.com/web/geek/chat", windowId: 1 }
    ], { expectedSearchTabId: "search", expectedCommunicationTabId: "communication" });
  } catch (error) {
    return error;
  }
  throw new Error("expected BOSS_SEARCH_TAB_CHANGED");
}

function executionSnapshot() {
  return buildScanExecutionSnapshot({
    site: "boss",
    scanKind: "daily",
    runtimePolicyHash: "pacing-policy",
    searchTemplate: { mode: "generated", url: "", cityCode: "101280100" },
    cityScopes: [{ city: "Guangzhou", cityCode: "101280100" }],
    keywordPlan: [{ word: "Pacing", priority: "A" }],
    nativeFilters: { lanes: [] },
    limits: { maxCards: 10, maxDetailTotal: 10, browserPageBudget: 20 }
  });
}

function testCard(sourceId) {
  return {
    source: "boss",
    sourceId,
    title: sourceId,
    company: "Test Co",
    location: "Guangzhou",
    salary: "10-20K",
    experience: "1-3 years",
    education: "Bachelor",
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`
  };
}

function checkpointAdapter({ accessController, sleeps, cards }) {
  const adapter = new BossSiteAdapter({
    browser: { async navigate() {} },
    accessController,
    sleepFn: async (ms) => sleeps.push(ms),
    randomFn: () => 0
  });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => cards;
  adapter.readVisiblePaneDetail = async (_tabId, job) => {
    await adapter.waitWithPacing("pane_detail_read");
    await adapter.reserveAccess("pane_detail_read", { jobId: job.sourceId });
    return { description: "checkpoint detail ".repeat(20), bossActiveText: "today" };
  };
  return adapter;
}

function checkpointJob(job) {
  return {
    ...job,
    score: 80,
    level: "A",
    matches: [],
    risks: [],
    qualityTags: [],
    analysis: { provider: "test", semanticStatus: "complete" }
  };
}
