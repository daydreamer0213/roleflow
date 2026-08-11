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
const { createSiteAccessController, formatAccessWaitDuration } = require("../src/core/site_access_budget");
const { assertBossRuntimeTabBindings } = require("../src/core/workspace_tabs");
const { validateResumeBatch } = require("../src/core/scan_resume");
const { buildScanExecutionSnapshot } = require("../src/core/scan_snapshot");
const { persistBossRiskControl } = require("../src/cli");

main().then(() => console.log("boss_safe_pacing_smoke ok")).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  await paneDetailDelaySmoke();
  await threeMinuteBudgetSmoke();
  checkpointResumeSmoke();
  riskControlClassificationSmoke();
  assert.strictEqual(formatAccessWaitDuration(2_500), "约 3 秒");
  assert.strictEqual(formatAccessWaitDuration(61_000), "约 2 分钟");
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
