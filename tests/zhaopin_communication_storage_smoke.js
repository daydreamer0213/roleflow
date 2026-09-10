const assert = require("node:assert/strict");
const {
  openDb,
  createBatch,
  upsertJob,
  archiveCandidateJob,
  recordSiteAccessEvent,
  setSiteRuntimeState,
  createWorkflowRun,
  transitionWorkflowRun
} = require("../src/core/storage");
const { savePlatformSearchContext } = require("../src/storage/platform_search_context_store");
const {
  createCommunicationBatch,
  getCommunicationBatch,
  bindCommunicationBatchRuntime,
  listCommunicationBatchItems,
  resumeInterruptedCommunicationBatch,
  communicationQuotaSnapshot,
  isCommunicationJobEligible
} = require("../src/core/communication_batches");
const {
  communicationCalibrationStatus,
  assertCommunicationExecutionEnabled
} = require("../src/core/communication_calibration");
const {
  communicationRuntimeBlock,
  assertCommunicationRuntimeAvailable
} = require("../src/core/communication_runtime");
const { createSiteAccessController } = require("../src/core/site_access_budget");
const { runCommunicationBatch } = require("../src/core/communication_executor");
const { getProgressCardForJob } = require("../src/core/candidate_progress");
const { PRODUCT_POLICY } = require("../src/core/product_policy");
const {
  createCommunicationBatch: createApplicationCommunicationBatch,
  getCommunicationStatus
} = require("../src/application/communication");

const NOW = "2030-01-02T08:00:00.000Z";
const ZHAOPIN_SEARCH_URL = "https://www.zhaopin.com/jobs/?jl=548&pageMode=search&sl=10001&kw=AI+Agent";

async function main() {
  storageAndEligibilitySmoke();
  quotaAndRuntimeIsolationSmoke();
  calibrationAndBrowserBindingSmoke();
  await executorResumeAndProgressSmoke();
  await targetMismatchSingleItemSmoke();
  console.log("zhaopin_communication_storage_smoke ok");
}

function storageAndEligibilitySmoke() {
  const fixture = createFixture();
  try {
    const good = addJob(fixture, "ZLGOOD1");
    const second = addJob(fixture, "ZLGOOD2", { title: "Second ZL role" });
    const batch = createCommunicationBatch(fixture.db, {
      site: "zhaopin",
      planId: fixture.planId,
      jobIds: [good],
      browserMode: "edge",
      now: NOW
    });
    assert.equal(batch.site, "zhaopin");
    assert.equal(batch.policySnapshot.zhaopin.targets[String(good)].sourceId, "ZLGOOD1");
    assert.equal(batch.policySnapshot.zhaopin.targets[String(good)].searchUrl, ZHAOPIN_SEARCH_URL);
    assert.equal(getCommunicationStatus({ db: fixture.db, batchId: batch.id }).calibration.acceptance, "e2e_pending");

    const applicationBatch = createApplicationCommunicationBatch({
      db: fixture.db,
      input: { site: "zhaopin", planId: fixture.planId, jobIds: [second], browserMode: "edge" }
    }).batch;
    assert.equal(applicationBatch.site, "zhaopin");
    assert.equal(applicationBatch.policySnapshot.calibration.executionEnabled, true);
    const inferredApplicationJob = addJob(fixture, "ZLINFERREDAPP");
    const inferredApplicationBatch = createApplicationCommunicationBatch({
      db: fixture.db,
      input: { planId: fixture.planId, jobIds: [inferredApplicationJob], browserMode: "edge" }
    }).batch;
    assert.equal(inferredApplicationBatch.site, "zhaopin");
    assert.equal(inferredApplicationBatch.policySnapshot.calibration.acceptance, "e2e_pending");
    assert.equal(inferredApplicationBatch.policySnapshot.calibration.executionEnabled, true);

    fixture.db.prepare("UPDATE job_observations SET keyword = 'changed keyword' WHERE job_id = ?").run(good);
    fixture.db.prepare("UPDATE search_plans SET plan_json = ? WHERE id = ?")
      .run(JSON.stringify({ cities: ["Shenzhen"], keywords: [{ word: "changed keyword" }] }), fixture.planId);
    savePlatformSearchContext(fixture.db, {
      planId: fixture.planId,
      site: "zhaopin",
      searchTemplate: { mode: "inherited", url: "https://www.zhaopin.com/jobs/?pageMode=search&jl=763" },
      filterSummary: ["changed"]
    });
    assert.equal(getCommunicationBatch(fixture.db, batch.id).policySnapshot.zhaopin.targets[String(good)].searchUrl, ZHAOPIN_SEARCH_URL);

    const boss = addJob(fixture, "boss-one", {
      source: "boss",
      url: "https://www.zhipin.com/job_detail/boss-one.html",
      description: "BOSS keeps its established eligibility behavior."
    });
    const countBefore = batchCount(fixture.db);
    assert.throws(
      () => createCommunicationBatch(fixture.db, {
        planId: fixture.planId,
        jobIds: [second, boss],
        browserMode: "edge",
        now: NOW
      }),
      { code: "COMMUNICATION_SOURCE_MISMATCH" }
    );
    assert.equal(batchCount(fixture.db), countBefore);
    assert.throws(
      () => createCommunicationBatch(fixture.db, {
        site: "boss",
        planId: fixture.planId,
        jobIds: [second],
        browserMode: "edge",
        now: NOW
      }),
      { code: "COMMUNICATION_SOURCE_MISMATCH" }
    );

    const otherPlan = insertPlan(fixture.db, fixture.profileId, "Other plan");
    const otherPlanBatch = createBatch(fixture.db, "zhaopin", "AI Agent", "other plan", {
      profileId: fixture.profileId,
      searchPlanId: otherPlan
    });
    const wrongPlan = upsertJob(fixture.db, zhaopinJob("ZLPLAN2"), otherPlanBatch);
    assertRejected(fixture, wrongPlan);

    const otherProfile = insertProfile(fixture.db, "Other profile");
    const otherProfilePlan = insertPlan(fixture.db, otherProfile, "Other profile plan");
    const otherProfileBatch = createBatch(fixture.db, "zhaopin", "AI Agent", "other profile", {
      profileId: otherProfile,
      searchPlanId: otherProfilePlan
    });
    const wrongProfile = upsertJob(fixture.db, zhaopinJob("ZLPROFILE2"), otherProfileBatch);
    assertRejected(fixture, wrongProfile);

    const samePlanWrongProfileBatch = createBatch(fixture.db, "zhaopin", "AI Agent", "same plan wrong profile", {
      profileId: otherProfile,
      searchPlanId: fixture.planId
    });
    const samePlanWrongProfile = upsertJob(fixture.db, zhaopinJob("ZLSAMEPLANWRONGPROFILE"), samePlanWrongProfileBatch);
    const beforeWrongProfile = batchCount(fixture.db);
    assertRejected(fixture, samePlanWrongProfile);
    assert.equal(batchCount(fixture.db), beforeWrongProfile);

    for (const [sourceId, overrides] of [
      ["", { sourceId: "" }],
      ["ZLSHORT", { description: "short JD" }],
      ["ZLPENDING", { analysis: { ...completeAnalysis(), semanticStatus: "pending" } }],
      ["ZLOFFLINE", { analysis: { ...completeAnalysis(), sourceAvailability: "offline" } }],
      ["ZLURLID", { url: "https://www.zhaopin.com/jobdetail/ZLOTHER.htm" }],
      ["ZLMESSAGE", { keyword: "message-discovery-detail" }],
      ["ZLBLOCKER", { qualityTags: ["part_time_role"] }]
    ]) {
      assertRejected(fixture, addJob(fixture, sourceId || "missing-source", overrides));
    }

    const wrongEvidenceBatch = createBatch(fixture.db, "boss", "AI Agent", "wrong source evidence", {
      profileId: fixture.profileId,
      searchPlanId: fixture.planId
    });
    const wrongEvidence = upsertJob(fixture.db, zhaopinJob("ZLEVIDENCE"), wrongEvidenceBatch);
    assertRejected(fixture, wrongEvidence);

    const archived = addJob(fixture, "ZLARCHIVED");
    archiveCandidateJob(fixture.db, { profileId: fixture.profileId, planId: fixture.planId, jobId: archived });
    assertRejected(fixture, archived);

    const applied = addJob(fixture, "ZLAPPLIED");
    fixture.db.prepare(`INSERT INTO candidate_job_states(
      profile_id, job_id, plan_id, status, updated_at
    ) VALUES (?, ?, ?, 'applied', ?)`)
      .run(fixture.profileId, applied, fixture.planId, NOW);
    assertRejected(fixture, applied);

    const existing = addJob(fixture, "ZLEXISTING");
    const existingBatch = createCommunicationBatch(fixture.db, {
      site: "zhaopin", planId: fixture.planId, jobIds: [existing], browserMode: "edge", now: NOW
    });
    const existingItem = listCommunicationBatchItems(fixture.db, existingBatch.id)[0];
    fixture.db.prepare("UPDATE communication_batch_items SET status = 'succeeded', click_count = 1 WHERE id = ?")
      .run(existingItem.id);
    assertRejected(fixture, existing);

    const noContextFixture = createFixture({ saveContext: false });
    try {
      const noContextJob = addJob(noContextFixture, "ZLNOCONTEXT");
      assert.throws(
        () => createCommunicationBatch(noContextFixture.db, {
          site: "zhaopin", planId: noContextFixture.planId, jobIds: [noContextJob], browserMode: "edge", now: NOW
        }),
        (error) => error.code === "ZHAOPIN_COMMUNICATION_SEARCH_CONTEXT_REQUIRED"
          && /准备|保存/.test(error.message)
      );
    } finally {
      noContextFixture.db.close();
    }

    assert.equal(isCommunicationJobEligible(fixture.db, zhaopinJob("ZLFAKE")), false,
      "a rejected ZL job must not fall through the default BOSS branch");
    assert.throws(() => isCommunicationJobEligible(fixture.db, zhaopinJob("ZLFAKE"), { site: "invalid" }),
      { code: "COMMUNICATION_SITE_INVALID" });

    const workflowJob = addJob(fixture, "ZLWORKFLOW");
    const workflow = createWorkflowRun(fixture.db, {
      id: "zhaopin-communication-storage-workflow",
      profileId: fixture.profileId,
      planId: fixture.planId,
      site: "zhaopin",
      localDay: "2030-01-02",
      sequence: 1,
      targetSuccessCount: 1,
      inventoryCount: 1,
      scanNeeded: false,
      planner: { site: "zhaopin", browserMode: "edge" }
    });
    transitionWorkflowRun(fixture.db, { id: workflow.id, status: "review_required" });
    const workflowBatch = createCommunicationBatch(fixture.db, {
      workflowRunId: workflow.id,
      jobIds: [workflowJob],
      browserMode: "edge",
      now: NOW
    });
    assert.equal(workflowBatch.site, "zhaopin");

    const bossWorkflow = createWorkflowRun(fixture.db, {
      id: "boss-communication-source-mismatch",
      profileId: fixture.profileId,
      planId: fixture.planId,
      site: "boss",
      localDay: "2030-01-02",
      sequence: 1,
      targetSuccessCount: 1,
      inventoryCount: 1,
      scanNeeded: false,
      planner: { site: "boss", browserMode: "edge" }
    });
    transitionWorkflowRun(fixture.db, { id: bossWorkflow.id, status: "review_required" });
    const beforeWorkflowMismatch = batchCount(fixture.db);
    assert.throws(() => createCommunicationBatch(fixture.db, {
      workflowRunId: bossWorkflow.id,
      jobIds: [addJob(fixture, "ZLWORKFLOWMISMATCH")],
      browserMode: "edge",
      now: NOW
    }), { code: "COMMUNICATION_SOURCE_MISMATCH" });
    assert.equal(batchCount(fixture.db), beforeWorkflowMismatch);
  } finally {
    fixture.db.close();
  }
}

function quotaAndRuntimeIsolationSmoke() {
  const fixture = createFixture();
  try {
    const zlJob = addJob(fixture, "ZLQUOTA");
    const bossJob = addJob(fixture, "boss-quota", {
      source: "boss",
      url: "https://www.zhipin.com/job_detail/boss-quota.html",
      description: "BOSS quota fixture"
    });
    const zlBatch = createCommunicationBatch(fixture.db, {
      site: "zhaopin", planId: fixture.planId, jobIds: [zlJob], browserMode: "edge", now: NOW
    });
    const bossBatch = createCommunicationBatch(fixture.db, {
      site: "boss", planId: fixture.planId, jobIds: [bossJob], browserMode: "edge", now: NOW
    });
    assert.deepEqual(communicationQuotaSnapshot(fixture.db, { site: "zhaopin", now: NOW }), {
      limit: 150, used: 0, reserved: 1, remaining: 149
    });
    assert.deepEqual(communicationQuotaSnapshot(fixture.db, { site: "boss", now: NOW }), {
      limit: 150, used: 0, reserved: 1, remaining: 149
    });
    const zlItem = listCommunicationBatchItems(fixture.db, zlBatch.id)[0];
    recordSiteAccessEvent(fixture.db, {
      site: "zhaopin", action: "communication_visit", createdAt: NOW,
      details: { batchId: zlBatch.id, itemId: zlItem.id, jobId: zlJob }
    });
    assert.deepEqual(communicationQuotaSnapshot(fixture.db, { site: "zhaopin", now: NOW }), {
      limit: 150, used: 1, reserved: 0, remaining: 149
    });
    assert.deepEqual(communicationQuotaSnapshot(fixture.db, { site: "boss", now: NOW }), {
      limit: 150, used: 0, reserved: 1, remaining: 149
    });
    assert.equal(listCommunicationBatchItems(fixture.db, bossBatch.id)[0].status, "pending");
    assert.throws(() => communicationQuotaSnapshot(fixture.db, { site: "invalid", now: NOW }),
      { code: "COMMUNICATION_SITE_INVALID" });

    const blockedUntil = "2030-01-02T10:00:00.000Z";
    setSiteRuntimeState(fixture.db, "zhaopin", {
      status: "blocked", reasonCode: "ZHAOPIN_RISK_CONTROL", details: { blockedUntil }
    });
    assert.deepEqual(communicationRuntimeBlock(fixture.db, { site: "zhaopin", nowMs: Date.parse(NOW) }), {
      reasonCode: "ZHAOPIN_RISK_CONTROL", blockedUntil
    });
    assert.equal(communicationRuntimeBlock(fixture.db, { site: "boss", nowMs: Date.parse(NOW) }), null);
    setSiteRuntimeState(fixture.db, "boss", {
      status: "blocked", reasonCode: "BOSS_RUNTIME_BLOCKED", details: { blockedUntil }
    });
    setSiteRuntimeState(fixture.db, "zhaopin", { status: "ready" });
    assert.equal(communicationRuntimeBlock(fixture.db, { site: "zhaopin", nowMs: Date.parse(NOW) }), null);
    assert.deepEqual(communicationRuntimeBlock(fixture.db, { site: "boss", nowMs: Date.parse(NOW) }), {
      reasonCode: "BOSS_RUNTIME_BLOCKED", blockedUntil
    });
    assert.throws(() => assertCommunicationRuntimeAvailable(fixture.db, { site: "boss" }), /BOSS/);
    assert.throws(() => communicationRuntimeBlock(fixture.db, { site: "invalid", nowMs: Date.parse(NOW) }),
      { code: "COMMUNICATION_SITE_INVALID" });
  } finally {
    fixture.db.close();
  }
}

function calibrationAndBrowserBindingSmoke() {
  assert.deepEqual(communicationCalibrationStatus("zhaopin"), {
    implementation: "implemented",
    calibration: "dom_verified",
    acceptance: "e2e_pending",
    executionEnabled: true
  });
  assert.equal(assertCommunicationExecutionEnabled("zhaopin").executionEnabled, true);
  assert.throws(() => communicationCalibrationStatus("invalid"), { code: "COMMUNICATION_SITE_INVALID" });
  assert.deepEqual(PRODUCT_POLICY.operations.zhaopinCommunication.selection, { targetCount: 30, acceptableMin: 22 });
  assert.deepEqual(PRODUCT_POLICY.operations.zhaopinCommunication.delayMs, [15000, 20000]);
  assert.deepEqual(PRODUCT_POLICY.operations.zhaopinCommunication.limits, { "10m": 30, "30m": 60, "24h": 150 });

  const fixture = createFixture();
  try {
    const jobId = addJob(fixture, "ZLBIND");
    const batch = createCommunicationBatch(fixture.db, {
      site: "zhaopin", planId: fixture.planId, jobIds: [jobId], browserMode: "edge", now: NOW
    });
    const binding = {
      mode: "edge",
      windowId: 9,
      searchTabId: 17,
      searchReturnUrl: ZHAOPIN_SEARCH_URL,
      searchScrollTop: 80,
      bindingGeneration: 1
    };
    assert.deepEqual(bindCommunicationBatchRuntime(fixture.db, { batchId: batch.id, browser: binding }).runtime.browser, binding);
    assert.throws(() => bindCommunicationBatchRuntime(fixture.db, {
      batchId: batch.id,
      browser: { ...binding, bindingGeneration: 1, searchReturnUrl: "https://www.zhaopin.com/jobs/?pageMode=search&jl=548" }
    }), { code: "COMMUNICATION_BROWSER_BINDING_INVALID" });

    const portableJob = addJob(fixture, "ZLPORTABLE");
    const portableBatch = createCommunicationBatch(fixture.db, {
      site: "zhaopin", planId: fixture.planId, jobIds: [portableJob], browserMode: "portable", now: NOW
    });
    const portableBinding = {
      ...binding,
      mode: "portable",
      searchTabId: "CDP-ZL-search-target",
      bindingGeneration: 1
    };
    assert.equal(
      bindCommunicationBatchRuntime(fixture.db, { batchId: portableBatch.id, browser: portableBinding })
        .runtime.browser.searchTabId,
      "CDP-ZL-search-target"
    );
  } finally {
    fixture.db.close();
  }
}

async function executorResumeAndProgressSmoke() {
  const fixture = createFixture();
  const originalResume = Number(fixture.db.prepare(`INSERT INTO candidate_resume_versions(
    profile_id,version_key,name,is_active,created_at,updated_at
  ) VALUES (?,'original','Original resume',1,?,?)`).run(fixture.profileId, NOW, NOW).lastInsertRowid);
  try {
    const jobId = addJob(fixture, "ZLEXECUTOR");
    const batch = createCommunicationBatch(fixture.db, {
      site: "zhaopin", planId: fixture.planId, jobIds: [jobId], browserMode: "edge", now: NOW
    });
    const item = listCommunicationBatchItems(fixture.db, batch.id)[0];
    const gateCalls = [];
    const runtimeCalls = [];
    const executionGate = (site) => {
      gateCalls.push(site);
      return { executionEnabled: true, acceptance: "e2e_pending" };
    };
    const accessController = createSiteAccessController({
      db: fixture.db,
      site: "zhaopin",
      runId: "zhaopin-communication-storage-smoke",
      nowFn: () => Date.parse(NOW)
    });
    const runtimeGate = (db, options) => {
      assert.equal(db, fixture.db);
      runtimeCalls.push(options.site);
    };
    let inspectCalls = 0;
    let dispatches = 0;
    const immutableJobs = [];
    const adapter = {
      async inspectCommunicationJob(job) {
        immutableJobs.push(job);
        inspectCalls += 1;
        if (inspectCalls === 1) {
          throw Object.assign(new Error("target not found"), { code: "ZHAOPIN_COMMUNICATION_TARGET_NOT_FOUND" });
        }
        return { state: "ready" };
      },
      async prepareCommunicationDispatch() { return { async cancel() {} }; },
      async dispatchCommunication() { dispatches += 1; },
      async verifyCommunicationResult(job) {
        immutableJobs.push(job);
        return {
          state: "succeeded",
          evidence: {
            endpoints: [{
              endpointKind: "zhaopin_prechat",
              httpStatus: 200,
              businessCategory: "success",
              elapsedMs: 17,
              secret: "must-not-persist"
            }],
            pageState: "succeeded"
          }
        };
      }
    };

    await assert.rejects(() => runCommunicationBatch({
      db: fixture.db,
      batchId: batch.id,
      singleItemId: item.id,
      adapter,
      accessController,
      executionGate,
      runtimeGate,
      sleepFn: async () => {}
    }), { code: "ZHAOPIN_COMMUNICATION_TARGET_NOT_FOUND" });
    assert.equal(getCommunicationBatch(fixture.db, batch.id).status, "interrupted");
    assert.deepEqual(listCommunicationBatchItems(fixture.db, batch.id).map((entry) => [entry.status, entry.clickCount]), [["pending", 0]]);
    assert.equal(siteVisitCount(fixture.db, "zhaopin"), 1);
    assert.equal(dispatches, 0);

    resumeInterruptedCommunicationBatch(fixture.db, { batchId: batch.id });
    await runCommunicationBatch({
      db: fixture.db,
      batchId: batch.id,
      singleItemId: item.id,
      adapter,
      accessController,
      executionGate,
      runtimeGate,
      sleepFn: async () => {}
    });
    assert.equal(siteVisitCount(fixture.db, "zhaopin"), 1, "reservation reuse must remain idempotent");
    assert.equal(inspectCalls, 2, "the first interrupted lookup must not retry automatically");
    assert.equal(dispatches, 1);
    assert(gateCalls.length >= 3 && gateCalls.every((site) => site === "zhaopin"));
    assert(runtimeCalls.length >= 3 && runtimeCalls.every((site) => site === "zhaopin"));
    assert.deepEqual(immutableJobs, [
      frozenJob(jobId, batch.id, item.id),
      frozenJob(jobId, batch.id, item.id),
      frozenJob(jobId, batch.id, item.id)
    ]);
    const completedItem = listCommunicationBatchItems(fixture.db, batch.id)[0];
    assert.equal(completedItem.status, "succeeded");
    assert.deepEqual(completedItem.evidence.outcome.endpoints, [{
      endpointKind: "zhaopin_prechat", httpStatus: 200, businessCategory: "success", elapsedMs: 17
    }]);
    assert.equal(getProgressCardForJob(fixture.db, { profileId: fixture.profileId, jobId }).stage, "waiting_reply");
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM candidate_funnel_entries").get().count, 1,
      "verified Zhaopin greeting must enter feedback exactly once");
    const entry = fixture.db.prepare("SELECT * FROM candidate_funnel_entries WHERE job_id = ?").get(jobId);
    assert.equal(entry.profile_id, fixture.profileId);
    assert.equal(entry.plan_id, fixture.planId);
    assert.equal(entry.source_kind, "communication");
    assert(Date.parse(entry.mature_at) - Date.parse(entry.started_at) >= 48 * 60 * 60 * 1000);
    const { createFunnelAnalysisService } = require("../src/application/funnel_analysis");
    const { startFunnelStrategyRound } = require("../src/storage/funnel_store");
    const boundary = new Date(Date.parse(entry.started_at) + 24 * 60 * 60 * 1000).toISOString();
    fixture.db.prepare('UPDATE candidate_resume_versions SET is_active=0,updated_at=? WHERE id=?').run(boundary, originalResume);
    const secondRound = startFunnelStrategyRound(fixture.db, {
      profileId: fixture.profileId, planId: fixture.planId, fromRoundId: entry.strategy_round_id,
      sourceKey: "feedback-test-next-round", changeKinds: ["greeting"], startedAt: boundary
    });
    // Simulate an upgrade from the version that saved the verified event but omitted its funnel entry.
    fixture.db.prepare("DELETE FROM candidate_funnel_entries WHERE id = ?").run(entry.id);
    const feedback = createFunnelAnalysisService({ db: fixture.db, now: () => boundary });
    for (const status of ["pending", "ambiguous", "already_communicated"]) {
      fixture.db.prepare("UPDATE communication_batch_items SET status=? WHERE id=?").run(status, item.id);
      feedback.refresh({ profileId: fixture.profileId, planId: fixture.planId });
      assert.equal(fixture.db.prepare("SELECT COUNT(*) n FROM candidate_funnel_entries").get().n, 0,
        `${status} cannot establish a verified outbound start`);
    }
    const { ensureFunnelEntry } = require("../src/storage/funnel_store");
    assert.throws(() => ensureFunnelEntry(fixture.db, {
      profileId: fixture.profileId, planId: fixture.planId, jobId, cardId: entry.card_id,
      sourceKind: "reply_sent", startedAt: entry.started_at
    }), { code: "READONLY_SITE_FUNNEL_FORBIDDEN" }, "copied Zhaopin drafts cannot be counted as sent replies");
    fixture.db.prepare("UPDATE communication_batch_items SET status='succeeded' WHERE id=?").run(item.id);
    feedback.refresh({ profileId: fixture.profileId, planId: fixture.planId });
    feedback.refresh({ profileId: fixture.profileId, planId: fixture.planId });
    const repaired = fixture.db.prepare("SELECT * FROM candidate_funnel_entries WHERE job_id = ?").get(jobId);
    assert.equal(repaired.strategy_round_id, entry.strategy_round_id, "late repair belongs to the original strategy");
    assert.equal(repaired.started_at, entry.started_at, "repair cannot reset the 48-hour clock");
    assert.equal(repaired.resume_version_id, originalResume, "historical repair retains the original strategy's resume even after it is updated or disabled");
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM candidate_funnel_entries").get().count, 1);
    const after = feedback.refresh({ profileId: fixture.profileId, planId: fixture.planId });
    assert.equal(after.currentRound.id, secondRound.id);
    assert.equal(after.currentRound.started, 0, "old communication must not enter the new strategy");
    assert.equal(after.previousRound.started, 1);

    const bypass = createFixture();
    try {
      const bypassJob = addJob(bypass, "ZLBYPASS");
      const bypassBatch = createCommunicationBatch(bypass.db, {
        site: "zhaopin", planId: bypass.planId, jobIds: [bypassJob], browserMode: "edge", now: NOW
      });
      let reserves = 0;
      await assert.rejects(() => runCommunicationBatch({
        db: bypass.db,
        batchId: bypassBatch.id,
        adapter: successAdapter(),
        accessController: { async reserve() { reserves += 1; } },
        executionGate: () => ({ executionEnabled: true, acceptance: "e2e_pending" }),
        sleepFn: async () => {}
      }), { code: "COMMUNICATION_E2E_SINGLE_ITEM_REQUIRED" });
      assert.equal(reserves, 0);
    } finally {
      bypass.db.close();
    }

    for (const failedTable of ["candidate_progress_events", "candidate_funnel_entries"]) {
      const atomic = createFixture();
      try {
        const atomicJob = addJob(atomic, "ZLATOMIC");
        const atomicBatch = createCommunicationBatch(atomic.db, {
          site: "zhaopin", planId: atomic.planId, jobIds: [atomicJob], browserMode: "edge", now: NOW
        });
        const atomicItem = listCommunicationBatchItems(atomic.db, atomicBatch.id)[0];
        atomic.db.exec(`CREATE TEMP TRIGGER fail_zhaopin_progress
          BEFORE INSERT ON ${failedTable}
          BEGIN SELECT RAISE(ABORT, 'forced zhaopin progress failure'); END`);
        await assert.rejects(() => runCommunicationBatch({
          db: atomic.db,
          batchId: atomicBatch.id,
          singleItemId: atomicItem.id,
          adapter: successAdapter(),
          accessController: { async reserve() {} },
          executionGate,
          sleepFn: async () => {}
        }), /forced zhaopin progress failure/);
        assert.deepEqual(listCommunicationBatchItems(atomic.db, atomicBatch.id).map((entry) => [entry.status, entry.clickCount]),
          [["click_dispatched", 1]]);
        assert.equal(getProgressCardForJob(atomic.db, { profileId: atomic.profileId, jobId: atomicJob }), null);
        assert.equal(atomic.db.prepare("SELECT COUNT(*) n FROM candidate_funnel_entries").get().n, 0);
      } finally {
        atomic.db.close();
      }
    }
  } finally {
    fixture.db.close();
  }
}

async function targetMismatchSingleItemSmoke() {
  const fixture = createFixture();
  try {
    const jobIds = [addJob(fixture, "ZLMISMATCH"), addJob(fixture, "ZLREMAINING")];
    const batch = createCommunicationBatch(fixture.db, {
      site: "zhaopin", planId: fixture.planId, jobIds, browserMode: "edge", now: NOW
    });
    const [first, second] = listCommunicationBatchItems(fixture.db, batch.id);
    const visited = [];
    let dispatches = 0;
    const input = {
      db: fixture.db, batchId: batch.id, singleItemId: first.id,
      accessController: createSiteAccessController({ db: fixture.db, site: "zhaopin", nowFn: () => Date.parse(NOW) }),
      adapter: {
        ...successAdapter(),
        async inspectCommunicationJob(job) {
          visited.push(job.id);
          return { state: job.id === jobIds[0] ? "target_mismatch" : "ready" };
        },
        async dispatchCommunication() { dispatches += 1; }
      },
      executionGate: () => ({ executionEnabled: true, acceptance: "e2e_pending" }),
      sleepFn: async () => {}
    };
    await assert.rejects(() => runCommunicationBatch(input), { code: "COMMUNICATION_TARGET_MISMATCH" });
    assert.equal(getCommunicationBatch(fixture.db, batch.id).status, "interrupted");
    assert.equal(getCommunicationBatch(fixture.db, batch.id).stopCode, "COMMUNICATION_TARGET_MISMATCH",
      "the mismatch reason must not become an ordinary single-item acceptance checkpoint");
    assert.deepEqual(listCommunicationBatchItems(fixture.db, batch.id).map(item => [item.status, item.clickCount]),
      [["target_mismatch", 0], ["pending", 0]]);
    assert.deepEqual(visited, [jobIds[0]]);
    assert.equal(dispatches, 0);
    assert.equal(siteVisitCount(fixture.db, "zhaopin"), 1);
    assert.equal(siteVisitCount(fixture.db, "boss"), 0);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) n FROM candidate_funnel_entries").get().n, 0);
    resumeInterruptedCommunicationBatch(fixture.db, { batchId: batch.id });
    await runCommunicationBatch({ ...input, singleItemId: second.id });
    assert.deepEqual(visited, jobIds);
    assert.equal(dispatches, 1);
    assert.equal(getCommunicationBatch(fixture.db, batch.id).stopCode, "COMMUNICATION_SINGLE_ITEM_CHECKPOINT");
    assert.equal(fixture.db.prepare("SELECT COUNT(*) n FROM candidate_funnel_entries").get().n, 1);
    assert.equal(getProgressCardForJob(fixture.db, { profileId: fixture.profileId, jobId: jobIds[0] }), null);
  } finally {
    fixture.db.close();
  }
}

function createFixture({ saveContext = true } = {}) {
  const db = openDb(":memory:");
  const profileId = insertProfile(db, "ZL communication fixture");
  const planId = insertPlan(db, profileId, "ZL communication plan");
  const scanBatchId = createBatch(db, "zhaopin", "AI Agent", "ZL communication fixture", {
    profileId,
    searchPlanId: planId
  });
  if (saveContext) {
    savePlatformSearchContext(db, {
      planId,
      site: "zhaopin",
      searchTemplate: { mode: "inherited", url: "https://www.zhaopin.com/jobs/?pageMode=search&jl=548&sl=10001" },
      filterSummary: ["广州", "10-15K"]
    });
  }
  return { db, profileId, planId, scanBatchId };
}

function insertProfile(db, name) {
  return Number(db.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, '{}', ?, ?)")
    .run(name, NOW, NOW).lastInsertRowid);
}

function insertPlan(db, profileId, name) {
  return Number(db.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)")
    .run(profileId, name, NOW, NOW).lastInsertRowid);
}

function addJob(fixture, sourceId, overrides = {}) {
  return upsertJob(fixture.db, zhaopinJob(sourceId, overrides), fixture.scanBatchId);
}

function zhaopinJob(sourceId, overrides = {}) {
  return {
    source: "zhaopin",
    sourceId,
    keyword: "AI Agent",
    title: `ZL role ${sourceId}`,
    company: `Company ${sourceId}`,
    location: "Guangzhou",
    salary: "10-15K",
    experience: "1-3 years",
    education: "Bachelor",
    bossActiveText: "",
    bossActiveDays: null,
    url: `https://www.zhaopin.com/jobdetail/${sourceId}.htm`,
    tags: ["AI"],
    description: "Complete synthetic Zhaopin job description with responsibilities, requirements, delivery boundaries, production ownership, and verifiable technical context. ".repeat(2),
    score: 20,
    level: "recommended",
    matches: ["AI"],
    risks: [],
    qualityTags: [],
    analysis: completeAnalysis(),
    ...overrides
  };
}

function completeAnalysis() {
  return {
    semanticStatus: "complete",
    recommendation: "primary",
    recommendationSchemaVersion: 2,
    fitLevel: "fit",
    confidence: 0.9,
    hardBlockers: [],
    evidence: { jd: ["AI delivery"], resume: ["AI project"] }
  };
}

function assertRejected(fixture, jobId) {
  assert.throws(() => createCommunicationBatch(fixture.db, {
    site: "zhaopin",
    planId: fixture.planId,
    jobIds: [jobId],
    browserMode: "edge",
    now: NOW
  }), (error) => error.code === "COMMUNICATION_JOB_INELIGIBLE");
}

function frozenJob(jobId, batchId, itemId) {
  return {
    id: jobId,
    batchId,
    itemId,
    position: 1,
    url: "https://www.zhaopin.com/jobdetail/ZLEXECUTOR.htm",
    title: "ZL role ZLEXECUTOR",
    company: "Company ZLEXECUTOR",
    source: "zhaopin",
    sourceId: "ZLEXECUTOR",
    searchUrl: ZHAOPIN_SEARCH_URL
  };
}

function successAdapter() {
  return {
    async inspectCommunicationJob() { return { state: "ready" }; },
    async prepareCommunicationDispatch() { return { async cancel() {} }; },
    async dispatchCommunication() {},
    async verifyCommunicationResult() { return { state: "succeeded", evidence: { endpoints: [], pageState: "succeeded" } }; }
  };
}

function batchCount(db) {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM communication_batches").get().count);
}

function siteVisitCount(db, site) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM events
    WHERE event_type = 'site_access'
      AND json_extract(payload_json, '$.site') = ?
      AND json_extract(payload_json, '$.action') = 'communication_visit'`).get(site).count);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
