const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const {
  openDb,
  createBatch,
  upsertJob,
  markCandidateJob,
  recordSiteAccessEvent,
  setSiteRuntimeState,
  createWorkflowRun,
  transitionWorkflowRun,
  attachWorkflowCommunication
} = require("../src/core/storage");
const {
  getCommunicationBatch,
  listCommunicationBatchItems,
  setCommunicationBatchStatus,
  transitionCommunicationItem
} = require("../src/core/communication_batches");
const {
  communicationAmbiguityState,
  communicationAmbiguityStateForBatch
} = require("../src/core/communication_ambiguity");
const { buildCommunicationViewModel } = require("../src/dashboard/view_models/communication");
const { renderCommunicationPage } = require("../src/dashboard/pages/communication");
const { createDashboardServer } = require("../src/dashboard/server");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `dashboard-communication-batch-${Date.now()}.sqlite`);
const logger = { info() {}, warn() {}, error() {}, requestId() { return "dashboard-communication-batch-smoke"; }, listRecent() { return []; } };
let db;
let server;

function communicationStatus(batch = {}, summary = {}, items = []) {
  return {
    batch: { id: 41, profileId: 7, planId: 11, status: "confirmed", ...batch },
    summary: { batchId: 41, batchStatus: "confirmed", total: 1, terminal: 0, remaining: 1, statusCounts: { pending: 1 }, ...summary },
    items,
    quota: { limit: 150, used: 4, reserved: 1, remaining: 145 },
    calibration: { implementation: "implemented", calibration: "calibrated", acceptance: "e2e_pending", executionEnabled: true },
    runtimeBlock: null
  };
}

function assertCommunicationViewModel() {
  const pending = buildCommunicationViewModel({
    scope: { profile: { id: 7 }, plan: { id: 11, name: "Scoped plan" } },
    current: communicationStatus({}, {}, [{ id: 1, batchId: 41, status: "pending", titleSnapshot: "Pending role", companySnapshot: "Example", salarySnapshot: "15-20K", locationSnapshot: "Guangzhou", tierSnapshot: "primary", evidenceSnapshot: ["Python"], riskSnapshot: ["weekend unknown"], proposalReasonSnapshot: "skill match" }])
  });
  assert.equal(pending.state, "pending_review");
  assert.equal(pending.controls.action, "start");
  assert.equal(pending.controls.visible, true);
  assert.equal(pending.quota.used, 4);
  assert.equal(pending.outcomes.succeeded, 0);

  const running = buildCommunicationViewModel({ scope: { profile: { id: 7 }, plan: { id: 11 } }, current: communicationStatus({ status: "running" }, { batchStatus: "running" }) });
  assert.equal(running.state, "running");
  assert.equal(running.controls.visible, false);

  const needsResolution = buildCommunicationViewModel({
    scope: { profile: { id: 7 }, plan: { id: 11 } },
    current: communicationStatus({ status: "interrupted" }, { batchStatus: "interrupted", statusCounts: { ambiguous: 1, pending: 1 }, total: 2, remaining: 2 }, [
      { id: 2, batchId: 41, status: "pending", titleSnapshot: "Later role" },
      { id: 1, batchId: 41, status: "ambiguous", titleSnapshot: "Ambiguous role" }
    ])
  });
  assert.equal(needsResolution.state, "needs_resolution");
  assert.equal(needsResolution.items[0].status, "ambiguous");
  assert.equal(needsResolution.controls.visible, false);
  assert.equal(needsResolution.items[0].resolution.evidenceRequired, true);

  const completed = buildCommunicationViewModel({ scope: { profile: { id: 7 }, plan: { id: 11 } }, current: communicationStatus({ status: "completed" }, { batchStatus: "completed", total: 2, terminal: 2, remaining: 0, statusCounts: { succeeded: 1, stopped: 1 } }, [{ id: 1, status: "succeeded" }, { id: 2, status: "stopped" }]) });
  assert.equal(completed.state, "completed");
  assert.equal(completed.outcomes.succeeded, 1);

  const history = buildCommunicationViewModel({ scope: { profile: { id: 7 }, plan: { id: 11 } }, current: communicationStatus(), history: [communicationStatus({ id: 40, status: "stopped" }, { batchId: 40, batchStatus: "stopped", total: 1, terminal: 1, remaining: 0, statusCounts: { stopped: 1 } })] });
  assert.equal(history.history.length, 1);
  assert.equal(history.history[0].batchId, 40);

  const noBatch = buildCommunicationViewModel({ scope: { profile: { id: 7 }, plan: { id: 11 } } });
  assert.equal(noBatch.state, "no_batch");
  assert.equal(noBatch.controls.visible, false);

  const planIsolation = buildCommunicationViewModel({ scope: { profile: { id: 7 }, plan: { id: 11 } }, current: communicationStatus(), discoveredWorkflowRuns: [{ planId: 11, communicationBatchId: 41 }, { planId: 12, communicationBatchId: 99 }] });
  assert.deepEqual(planIsolation.discoveredBatchIds, [41]);

  const directOrphan = buildCommunicationViewModel({ scope: { profile: { id: 7 }, plan: { id: 11 } }, current: communicationStatus(), directBatch: true });
  assert.equal(directOrphan.source, "direct_orphan");
  assert.equal(directOrphan.history.length, 0);

  const mismatch = buildCommunicationViewModel({ scope: { profile: { id: 7 }, plan: { id: 11 } }, current: communicationStatus({ planId: 12 }), integrityIssue: "batch_plan_mismatch" });
  assert.equal(mismatch.state, "integrity_blocked");
  assert.equal(mismatch.controls.visible, false);

  const unknownStatusHtml = renderCommunicationPage(buildCommunicationViewModel({
    scope: { profile: { id: 7 }, plan: { id: 11 } },
    current: communicationStatus({}, { statusCounts: { future_status: 1 } }, [
      { id: 1, batchId: 41, status: "future_status", titleSnapshot: "Future role" }
    ])
  }));
  assert.match(unknownStatusHtml, /状态待确认/);
  assert.doesNotMatch(unknownStatusHtml, />future_status</);

  const links = buildCommunicationViewModel({
    scope: { profile: { id: 7 }, plan: { id: 11 } },
    current: communicationStatus({}, {}, [
      { id: 1, batchId: 41, status: "pending", jobUrl: "javascript:alert(1)" },
      { id: 2, batchId: 41, status: "pending", jobUrl: "https://example.com/job_detail/role.html" },
      { id: 3, batchId: 41, status: "pending", jobUrl: "https://www.zhipin.com/job_detail/approved-role.html" }
    ])
  });
  assert.deepEqual(links.items.map((item) => item.jobUrl), ["", "", "https://www.zhipin.com/job_detail/approved-role.html"]);
}

assertCommunicationViewModel();

(async () => {
  fs.mkdirSync(smokeDir, { recursive: true });
  db = openDb(dbPath);
  const fixture = seed(db);
  const spawns = [];
  let ambiguityOverride = null;
  server = createDashboardServer({ db, root, dbPath, logger,
    communicationAmbiguityReader(database, requestedBatchId) {
      return ambiguityOverride || communicationAmbiguityStateForBatch(database, requestedBatchId);
    },
    spawnProcess(file, args, options) {
    spawns.push({ file, args, options });
    const child = new EventEmitter();
    child.pid = 5252;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  } });
  const baseUrl = await listen(server);

  const builder = await getText(baseUrl, `/communication/new?planId=${fixture.planId}`);
  assert.match(builder.body, new RegExp(`name="jobIds" value="${fixture.primaryId}" checked`));
  assert.match(builder.body, new RegExp(`name="jobIds" value="${fixture.talkId}"`));
  assert.match(builder.body, /· apply<\/small>/);
  assert.match(builder.body, new RegExp(`name="jobIds" value="${fixture.backupId}"`));
  assert.doesNotMatch(builder.body, new RegExp(`name="jobIds" value="${fixture.backupId}" checked`));
  assert.doesNotMatch(builder.body, new RegExp(`value="${fixture.notRecommendedId}"`));
  assert.doesNotMatch(builder.body, new RegExp(`value="${fixture.appliedId}"`));
  assert.doesNotMatch(builder.body, new RegExp(`value="${fixture.skippedId}"`));
  assert.match(builder.body, /<output[^>]*id="selected-count"/);
  assert.match(builder.body, /form\.addEventListener\('change',update\);update\(\)/);
  assert.match(builder.body, /<option value="edge" selected>\u5f53\u524d\u5df2\u767b\u5f55 Edge\uff08\u63a8\u8350\uff09<\/option>/);
  assert.match(builder.body, /<option value="portable">\u9879\u76ee\u4e13\u7528 Edge\uff08\u624b\u52a8\u5907\u7528\uff09<\/option>/);
  assert.strictEqual((builder.body.match(/<input[^>]*name="jobIds"[^>]*checked/g) || []).length, 30);
  assert.match(builder.body, /已达到日常沟通区间，无需为凑满 30 个补扫/);

  const smallBuilder = await getText(baseUrl, `/communication/new?planId=${fixture.smallPlanId}`);
  assert.strictEqual((smallBuilder.body.match(/<input[^>]*name="jobIds"[^>]*checked/g) || []).length, 21);
  assert.match(smallBuilder.body, /当前可沟通候选不足 22 个，可在风险额度允许时补扫一轮/);
  assert.doesNotMatch(smallBuilder.body, /自动补扫|开始补扫/);

  const queue = await getText(baseUrl, `/queue?planId=${fixture.planId}`);
  const plan = await getText(baseUrl, `/plan?planId=${fixture.planId}`);
  assert.match(queue.body, new RegExp(`/communication/new\\?planId=${fixture.planId}`));
  assert.match(plan.body, new RegExp(`/communication/new\\?planId=${fixture.planId}`));
  assert.match(queue.body, /批量沟通清单/);
  assert.match(queue.body, /薪资与目标贴合/);
  assert.match(plan.body, /批量沟通清单/);
  assert.doesNotMatch(plan.body, />Resume</);

  await expectApiError(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.notRecommendedId, browserMode: "edge", title: "forged" }, "COMMUNICATION_JOB_INELIGIBLE");
  await expectApiError(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.appliedId, browserMode: "edge", company: "forged" }, "COMMUNICATION_JOB_INELIGIBLE");
  await expectApiError(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.skippedId, browserMode: "edge", company: "forged" }, "COMMUNICATION_JOB_INELIGIBLE");
  await expectApiError(baseUrl, "/api/communication-batch", { planId: fixture.planId, browserMode: "edge" }, "COMMUNICATION_JOB_INELIGIBLE");

  const created = await postJson(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: [fixture.primaryId, fixture.backupId], browserMode: "portable", title: "forged", company: "forged", bucket: "not_recommended", url: "https://invalid.example" });
  assert.strictEqual(created.status, 200);
  const batchId = created.body.batch.id;
  assert.deepStrictEqual(listCommunicationBatchItems(db, batchId).map((item) => [item.jobId, item.titleSnapshot, item.companySnapshot]), [
    [fixture.primaryId, "Primary role", "Company primary"],
    [fixture.backupId, "Backup role", "Company backup"]
  ]);

  const historyWorkflow = reviewWorkflow(db, { id: "communication-history", planId: fixture.planId, localDay: "2098-01-02" });
  const historyBatch = await postJson(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.talkId, browserMode: "edge" });
  attachWorkflowCommunication(db, { workflowRunId: historyWorkflow.id, communicationBatchId: historyBatch.body.batch.id });
  setCommunicationBatchStatus(db, { batchId: historyBatch.body.batch.id, status: "stopped" });
  const currentWorkflow = reviewWorkflow(db, { id: "communication-current", planId: fixture.planId, localDay: "2098-01-03" });
  const currentBatch = await postJson(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.safeId, browserMode: "edge" });
  attachWorkflowCommunication(db, { workflowRunId: currentWorkflow.id, communicationBatchId: currentBatch.body.batch.id });
  const automaticCenter = await getText(baseUrl, `/communication?planId=${fixture.planId}`);
  assert.match(automaticCenter.body, new RegExp(`当前批次</p><h2>批次 #${currentBatch.body.batch.id}</h2>`));
  assert.match(automaticCenter.body, new RegExp(`href="/communication\\?batchId=${historyBatch.body.batch.id}"`));
  assert.match(automaticCenter.body, /<dt>薪资<\/dt><dd>10-15K<\/dd>/);
  assert.match(automaticCenter.body, /<dt>地点<\/dt><dd>Guangzhou<\/dd>/);
  assert.doesNotMatch(automaticCenter.body, new RegExp(`批次 #${batchId}</h2>`), "unlinked legacy batches must not enter automatic history");
  for (const pathname of [
    "/communication?planId=999999",
    `/communication?planId=${fixture.planId}&profileId=${fixture.otherProfileId}`,
    "/communication?profileId=999999"
  ]) {
    const spawnsBeforeInvalidScope = spawns.length;
    const invalidScope = await getText(baseUrl, pathname);
    assert.match(invalidScope.body, /批次范围无法安全确认/, `${pathname} must fail closed`);
    assert.doesNotMatch(invalidScope.body, /name="action" value="(?:start|resume)"/, `${pathname} must not expose execution controls`);
    assert.strictEqual(spawns.length, spawnsBeforeInvalidScope, `${pathname} must not spawn communication`);
  }
  const [unsafeSchemeItem, unsafeOriginItem] = listCommunicationBatchItems(db, batchId);
  db.prepare("UPDATE communication_batch_items SET job_url = ? WHERE id = ?").run("javascript:alert(1)", unsafeSchemeItem.id);
  db.prepare("UPDATE communication_batch_items SET job_url = ? WHERE id = ?").run("https://example.com/job_detail/role.html", unsafeOriginItem.id);
  const unsafeLinks = await getText(baseUrl, `/communication?batchId=${batchId}`);
  assert.doesNotMatch(unsafeLinks.body, /href="javascript:alert\(1\)"/);
  assert.doesNotMatch(unsafeLinks.body, /href="https:\/\/example\.com\/job_detail\/role\.html"/);
  const validLinks = await getText(baseUrl, `/communication?batchId=${currentBatch.body.batch.id}`);
  assert.match(validLinks.body, /href="https:\/\/www\.zhipin\.com\/job_detail\/safe\.html"/);
  const directOrphan = await getText(baseUrl, `/communication?batchId=${batchId}`);
  assert.match(directOrphan.body, new RegExp(`批次 #${batchId}</h2>`), "a direct legacy batch URL must remain readable");
  const mismatchedBatch = await getText(baseUrl, `/communication?batchId=${batchId}&planId=${fixture.smallPlanId}`);
  assert.match(mismatchedBatch.body, /批次范围无法安全确认/);
  assert.doesNotMatch(mismatchedBatch.body, /name="action" value="(?:start|resume)"/);

  const tamperedPortable = await postJson(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: [fixture.talkId],
    browserMode: "portable"
  });
  assert.strictEqual(tamperedPortable.status, 200);
  const tamperedBatchId = tamperedPortable.body.batch.id;
  db.prepare("UPDATE communication_batches SET policy_json = ? WHERE id = ?").run(JSON.stringify({
    ...tamperedPortable.body.batch.policySnapshot,
    browser: { mode: "portable", cdpPort: 9223 }
  }), tamperedBatchId);
  const spawnsBeforeTamperedStart = spawns.length;
  await expectApiError(
    baseUrl,
    "/api/communication-control",
    { batchId: tamperedBatchId, action: "start" },
    "COMMUNICATION_PORTABLE_CDP_PORT_INVALID",
    409
  );
  assert.strictEqual(spawns.length, spawnsBeforeTamperedStart);

  const review = await getText(baseUrl, `/communication?batchId=${batchId}`);
  assert.strictEqual((review.body.match(/class="app-shell"/g) || []).length, 1, "communication review must use one shared app shell");
  assert.strictEqual((review.body.match(/class="primary-nav"/g) || []).length, 1, "communication review must use one primary navigation");
  assert.doesNotMatch(review.body, /<main[^>]*>\s*<nav(?:\s|>)/, "communication review must not retain an inner navigation");
  assert.match(review.body, /实施：已实现/);
  assert.match(review.body, /校准：已完成/);
  assert.match(review.body, /端到端验收：待人工 E2E 验收（e2e_pending）/);
  assert.match(review.body, /技术执行门：已启用/);
  assert.match(review.body, /name="action" value="start"/);
  assert.match(review.body, /class="communication-primary" data-page-primary="true" name="action" value="start"/);
  assert.match(review.body, /class="communication-discard" name="action" value="discard"/);
  const status = await getJson(baseUrl, `/api/communication-status?batchId=${batchId}`);
  assert.deepStrictEqual(Object.keys(status.body).sort(), ["batch", "calibration", "items", "quota", "runtimeBlock", "summary"]);
  assert.deepStrictEqual(status.body.calibration, {
    implementation: "implemented",
    calibration: "calibrated",
    acceptance: "e2e_pending",
    executionEnabled: true
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(status.body.calibration, "status"), false);
  assert.strictEqual(status.body.calibration.executionEnabled, true);
  assert.strictEqual(status.body.quota.limit, 150);
  assert.strictEqual(typeof communicationAmbiguityState, "function");
  const reviewItem = listCommunicationBatchItems(db, batchId)[0];
  assert.strictEqual(communicationAmbiguityState(
    { statusCounts: { ambiguous: 1, pending: 1 } },
    [{ ...reviewItem, status: "pending" }]
  ).blocked, true);
  assert.strictEqual(communicationAmbiguityState(
    { statusCounts: { pending: 2 } },
    [{ ...reviewItem, status: "ambiguous" }]
  ).firstItemId, reviewItem.id);
  for (const [drift, action, jobId] of [
    ["summary-only", "start", fixture.summaryDriftStartId],
    ["summary-only", "resume", fixture.summaryDriftResumeId],
    ["item-only", "start", fixture.itemDriftStartId],
    ["item-only", "resume", fixture.itemDriftResumeId]
  ]) {
    const driftBatch = await postJson(baseUrl, "/api/communication-batch", {
      planId: fixture.planId,
      jobIds: jobId,
      browserMode: "edge"
    });
    if (action === "resume") {
      setCommunicationBatchStatus(db, { batchId: driftBatch.body.batch.id, status: "running" });
      setCommunicationBatchStatus(db, { batchId: driftBatch.body.batch.id, status: "paused" });
    }
    const driftItem = listCommunicationBatchItems(db, driftBatch.body.batch.id)[0];
    ambiguityOverride = drift === "summary-only"
      ? communicationAmbiguityState({ statusCounts: { ambiguous: 1 } }, [{ ...driftItem, status: "pending" }])
      : communicationAmbiguityState({ statusCounts: {} }, [{ ...driftItem, status: "ambiguous" }]);
    const batchBefore = getCommunicationBatch(db, driftBatch.body.batch.id);
    const itemsBefore = listCommunicationBatchItems(db, driftBatch.body.batch.id);
    const spawnsBefore = spawns.length;
    await expectApiError(baseUrl, "/api/communication-control", {
      batchId: driftBatch.body.batch.id,
      action
    }, "COMMUNICATION_RESUME_REQUIRES_REVIEW", 409);
    assert.deepStrictEqual(getCommunicationBatch(db, driftBatch.body.batch.id), batchBefore);
    assert.deepStrictEqual(listCommunicationBatchItems(db, driftBatch.body.batch.id), itemsBefore);
    assert.strictEqual(spawns.length, spawnsBefore);
    ambiguityOverride = null;
  }

  const started = await postJson(baseUrl, "/api/communication-control", { batchId, action: "start" });
  assert.strictEqual(started.status, 200);
  assert.strictEqual(started.body.batch.status, "running");
  assert.strictEqual(spawns.length, 1);
  assert.deepStrictEqual(
    spawns[0].args.slice(spawns[0].args.indexOf("--browser")),
    ["--browser", "portable", "--cdp-port", "9222"]
  );

  setCommunicationBatchStatus(db, {
    batchId,
    status: "interrupted",
    stopCode: "BROWSER_DISCONNECTED",
    stopMessage: "test interruption"
  });
  const interruptedReview = await getText(baseUrl, `/communication?batchId=${batchId}`);
  assert.match(interruptedReview.body, /name="action" value="resume"/);
  const resumedBatch = await postJson(baseUrl, "/api/communication-control", { batchId, action: "resume" });
  assert.strictEqual(resumedBatch.status, 200);
  assert.strictEqual(resumedBatch.body.batch.status, "running");
  assert.strictEqual(spawns.length, 2);
  assert(spawns[0].args.includes("communicate"));
  assert(spawns[0].args.includes(String(batchId)));
  await expectApiError(baseUrl, "/api/communication-control", { batchId, action: "start" }, "COMMUNICATION_BATCH_STATUS_INVALID", 409);

  const [ambiguousItem, secondAmbiguousItem] = listCommunicationBatchItems(db, batchId);
  for (const item of [ambiguousItem, secondAmbiguousItem]) {
    transitionCommunicationItem(db, { itemId: item.id, expectedStatus: "pending", status: "opening" });
    transitionCommunicationItem(db, { itemId: item.id, expectedStatus: "opening", status: "verified" });
    transitionCommunicationItem(db, { itemId: item.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(item) });
    transitionCommunicationItem(db, { itemId: item.id, expectedStatus: "click_dispatched", status: "ambiguous" });
  }
  setCommunicationBatchStatus(db, {
    batchId,
    status: "interrupted",
    stopCode: "COMMUNICATION_RESULT_AMBIGUOUS",
    stopMessage: "manual review required"
  });
  const ambiguousReview = await getText(baseUrl, `/communication?batchId=${batchId}`);
  assert.match(ambiguousReview.body, /name="evidenceNote"[^>]*required/);
  assert.doesNotMatch(ambiguousReview.body, /name="action" value="resume"/);
  assert.match(ambiguousReview.body, /处理不明确结果/);
  assert.match(ambiguousReview.body, new RegExp(`href="/communication\\?batchId=${batchId}#communication-item-${ambiguousItem.id}"`));
  assert.match(ambiguousReview.body, new RegExp(`id="communication-item-${ambiguousItem.id}"`));
  await expectApiError(baseUrl, "/api/communication-control", { batchId, action: "resume" }, "COMMUNICATION_RESUME_REQUIRES_REVIEW", 409);
  await expectApiError(baseUrl, "/api/communication-resolve", { batchId, itemId: ambiguousItem.id, status: "pending", evidenceNote: "invalid status" }, "COMMUNICATION_AMBIGUOUS_RESOLUTION_INVALID");
  await expectApiError(baseUrl, "/api/communication-resolve", { batchId, itemId: ambiguousItem.id, status: "stopped" }, "COMMUNICATION_AMBIGUOUS_EVIDENCE_REQUIRED");
  const evidenceNote = "岗位页无法确认结果，人工停止";
  const resolved = await postJson(baseUrl, "/api/communication-resolve", { batchId, itemId: ambiguousItem.id, status: "stopped", evidenceNote });
  assert.strictEqual(resolved.status, 200);
  assert.strictEqual(resolved.body.item.status, "stopped");
  const resolutionAudit = db.prepare("SELECT payload_json FROM events WHERE job_id = ? AND event_type = 'communication_manual_resolution' ORDER BY id DESC LIMIT 1").get(fixture.primaryId);
  assert.strictEqual(JSON.parse(resolutionAudit.payload_json).note, evidenceNote);
  assert.strictEqual(db.prepare("SELECT status FROM candidate_job_states WHERE profile_id = ? AND job_id = ?").get(1, fixture.primaryId), undefined);
  await expectApiError(baseUrl, "/api/communication-control", { batchId, action: "resume" }, "COMMUNICATION_RESUME_REQUIRES_REVIEW", 409);
  const secondResolved = await postJson(baseUrl, "/api/communication-resolve", { batchId, itemId: secondAmbiguousItem.id, status: "stopped", evidenceNote: "第二个岗位已人工核对并停止" });
  assert.strictEqual(secondResolved.status, 200);
  assert.strictEqual(secondResolved.body.item.status, "stopped");
  const resumedAfterReview = await postJson(baseUrl, "/api/communication-control", { batchId, action: "resume" });
  assert.strictEqual(resumedAfterReview.status, 200);
  assert.strictEqual(resumedAfterReview.body.batch.status, "running");
  assert.strictEqual(spawns.length, 3);

  const discardable = await postJson(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.talkId, browserMode: "edge" });
  const discarded = await postForm(baseUrl, "/api/communication-control", { batchId: discardable.body.batch.id, action: "discard" });
  assert.strictEqual(discarded.status, 303);
  assert.strictEqual(discarded.location, `/communication?batchId=${discardable.body.batch.id}`);
  assert.strictEqual(getCommunicationBatch(db, discardable.body.batch.id).status, "stopped");
  assert.deepStrictEqual(listCommunicationBatchItems(db, discardable.body.batch.id).map((item) => item.status), ["stopped"]);

  const protectedBatch = await postJson(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.safeId, browserMode: "edge" });
  const protectedItem = listCommunicationBatchItems(db, protectedBatch.body.batch.id)[0];
  transitionCommunicationItem(db, { itemId: protectedItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: protectedItem.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(db, { itemId: protectedItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(protectedItem) });
  transitionCommunicationItem(db, { itemId: protectedItem.id, expectedStatus: "click_dispatched", status: "succeeded" });
  await expectApiError(baseUrl, "/api/communication-control", { batchId: protectedBatch.body.batch.id, action: "discard" }, "COMMUNICATION_DISCARD_PROTECTED");

  for (let index = 0; index < 150; index += 1) recordSiteAccessEvent(db, { site: "boss", action: "communication_visit" });
  await expectApiError(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.safeId, browserMode: "edge" }, "COMMUNICATION_QUOTA_EXHAUSTED");
  setSiteRuntimeState(db, "boss", { status: "blocked", reasonCode: "BOSS_RISK_CONTROL", details: { blockedUntil: "2099-01-01T00:00:00.000Z" } });
  const blockedBuilder = await getText(baseUrl, `/communication/new?planId=${fixture.planId}`);
  assert.match(blockedBuilder.body, /BOSS_RISK_CONTROL/);
  const blockedPlan = await getText(baseUrl, `/plan?planId=${fixture.planId}`);
  assert.match(blockedPlan.body, /data-scan-button name="scanKind" value="daily" disabled/);
  assert.match(blockedPlan.body, /data-scan-button name="scanKind" value="broad" disabled/);
  assert.strictEqual(spawns.length, 3);
  console.log("dashboard_communication_batch_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
  }
});

function seed(database) {
  const now = new Date().toISOString();
  const profileId = Number(database.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?)").run("Dashboard smoke", "{}", now, now).lastInsertRowid);
  const planId = Number(database.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(profileId, "Dashboard smoke", "{}", now, now).lastInsertRowid);
  const scanBatchId = createBatch(database, "boss", "dashboard-communication", "dashboard communication smoke", { profileId, searchPlanId: planId });
  const primaryId = upsertJob(database, job("primary", { title: "Primary role", qualityTags: ["salary_target_core"], analysis: completeAnalysis() }), scanBatchId);
  const talkId = upsertJob(database, job("talk", { title: "Talk role", analysis: completeAnalysis("apply") }), scanBatchId);
  const backupId = upsertJob(database, job("backup", { title: "Backup role", analysis: completeAnalysis("caution"), qualityTags: ["experience_overrange"] }), scanBatchId);
  const notRecommendedId = upsertJob(database, job("not-recommended", { title: "Not recommended role", level: "不建议", analysis: completeAnalysis("not_recommended"), qualityTags: ["hard_exclude"] }), scanBatchId);
  const appliedId = upsertJob(database, job("applied", { title: "Applied role" }), scanBatchId);
  const safeId = upsertJob(database, job("safe", { title: "Safe role" }), scanBatchId);
  const skippedId = upsertJob(database, job("skipped", { title: "Skipped role" }), scanBatchId);
  const summaryDriftStartId = upsertJob(database, job("summary-drift-start"), scanBatchId);
  const summaryDriftResumeId = upsertJob(database, job("summary-drift-resume"), scanBatchId);
  const itemDriftStartId = upsertJob(database, job("item-drift-start"), scanBatchId);
  const itemDriftResumeId = upsertJob(database, job("item-drift-resume"), scanBatchId);
  for (let index = 0; index < 35; index += 1) {
    upsertJob(database, job(`extra-${index}`, { title: `Extra role ${index}`, analysis: completeAnalysis("apply") }), scanBatchId);
  }
  markCandidateJob(database, { profileId, planId, jobId: appliedId, status: "applied" });
  markCandidateJob(database, { profileId, planId, jobId: skippedId, status: "skipped" });

  const smallPlanId = Number(database.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(profileId, "Small dashboard smoke", "{}", now, now).lastInsertRowid);
  const smallBatchId = createBatch(database, "boss", "small-dashboard-communication", "small dashboard communication smoke", { profileId, searchPlanId: smallPlanId });
  for (let index = 0; index < 21; index += 1) {
    upsertJob(database, job(`small-${index}`, { title: `Small role ${index}`, analysis: completeAnalysis("apply") }), smallBatchId);
  }
  const otherProfileId = Number(database.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?)").run("Other dashboard smoke", "{}", now, now).lastInsertRowid);
  Number(database.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(otherProfileId, "Other dashboard plan", "{}", now, now).lastInsertRowid);
  return { planId, smallPlanId, otherProfileId, primaryId, talkId, backupId, notRecommendedId, appliedId, skippedId, safeId, summaryDriftStartId, summaryDriftResumeId, itemDriftStartId, itemDriftResumeId };
}

function reviewWorkflow(database, { id, planId, localDay }) {
  const run = createWorkflowRun(database, {
    id,
    profileId: 1,
    planId,
    localDay,
    sequence: 1,
    targetSuccessCount: 2,
    inventoryCount: 2,
    scanNeeded: false
  });
  return transitionWorkflowRun(database, { id: run.id, status: "review_required" });
}

function job(sourceId, overrides = {}) {
  return { source: "boss", sourceId, keyword: "dashboard-communication", title: "Communication role", company: `Company ${sourceId}`, location: "Guangzhou", salary: "10-15K", experience: "1-3 years", education: "Bachelor", bossActiveText: "Active today", bossActiveDays: 0, url: `https://www.zhipin.com/job_detail/${sourceId}.html`, tags: ["Python"], description: "Dashboard communication batch smoke job.", score: 20, level: "可投", matches: ["Python"], risks: [], qualityTags: [], analysis: completeAnalysis(), ...overrides };
}

function completeAnalysis(recommendation = "primary") {
  return { semanticStatus: "complete", recommendation, recommendationSchemaVersion: 2, fitLevel: recommendation === "primary" ? "fit" : "mostly_fit", confidence: 0.9, evidence: { jd: ["Python"], resume: ["Python"] } };
}

function clickAudit(item) {
  return { eventType: "communication_click", payload: { batchId: item.batchId, itemId: item.id, jobId: item.jobId, state: "click_dispatched" } };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function getText(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.text() };
}

async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function postJson(baseUrl, pathname, body) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
  }
  const response = await fetch(`${baseUrl}${pathname}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: params, redirect: "manual" });
  return { status: response.status, body: await response.json() };
}

async function postForm(baseUrl, pathname, body) {
  const params = new URLSearchParams(body);
  const response = await fetch(`${baseUrl}${pathname}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params, redirect: "manual" });
  return { status: response.status, location: response.headers.get("location") };
}

async function expectApiError(baseUrl, pathname, body, code, status = 400) {
  const response = await postJson(baseUrl, pathname, body);
  assert.strictEqual(response.status, status);
  assert.strictEqual(response.body.errorCode, code);
}
