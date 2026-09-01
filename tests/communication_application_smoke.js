const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const {
  openDb,
  createBatch,
  createWorkflowRun,
  getWorkflowRun,
  transitionWorkflowRun,
  upsertJob,
  setSiteRuntimeState,
  clearSiteRuntimeState
} = require("../src/core/storage");
const {
  getCommunicationBatch,
  bindCommunicationBatchRuntime,
  listCommunicationBatchItems,
  setCommunicationBatchStatus,
  transitionCommunicationItem
} = require("../src/core/communication_batches");
const {
  createCommunicationBatch,
  controlCommunicationBatch,
  getCommunicationStatus,
  rebindCommunicationBrowser,
  resolveAmbiguousCommunication
} = require("../src/application/communication");
const { createDashboardServer } = require("../src/dashboard/server");
const { persistBossRiskControl } = require("../src/cli");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `communication-application-${Date.now()}.sqlite`);
const logger = { info() {}, warn() {}, error() {}, requestId() { return "communication-application-smoke"; }, listRecent() { return []; } };
let db;
let server;
let noDbPathServer;

(async () => {
  fs.mkdirSync(smokeDir, { recursive: true });
  db = openDb(dbPath);
  const fixture = seed(db);
  const spawns = [];
  const spawnedChildren = [];
  let spawnBehavior = "normal";
  server = createDashboardServer({
    db,
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
    root,
    dbPath,
    logger,
    spawnProcess(file, args, options) {
      spawns.push({ file, args, options });
      if (spawnBehavior === "throw") throw new Error("spawn failed");
      const child = new EventEmitter();
      child.pid = 3201;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      spawnedChildren.push(child);
      return child;
    }
  });
  const baseUrl = await listen(server);

  for (const fn of [createCommunicationBatch, controlCommunicationBatch, getCommunicationStatus, rebindCommunicationBrowser, resolveAmbiguousCommunication]) {
    assert.strictEqual(typeof fn, "function");
  }

  const direct = createCommunicationBatch({
    db,
    input: { planId: fixture.planId, jobIds: [fixture.directJobId], browserMode: "edge" }
  });
  assert.deepStrictEqual(Object.keys(direct).sort(), ["batch", "items", "quota", "summary"]);
  assert.strictEqual(direct.batch.status, "confirmed");
  const directDiscard = controlCommunicationBatch({ db, input: { batchId: direct.batch.id, action: "discard" } });
  assert.strictEqual(directDiscard.batch.status, "stopped");
  const missingLauncher = createCommunicationBatch({
    db,
    input: { planId: fixture.planId, jobIds: [fixture.launcherJobId], browserMode: "edge" }
  });
  const missingLauncherItem = listCommunicationBatchItems(db, missingLauncher.batch.id)[0];
  assert.throws(
    () => controlCommunicationBatch({
      db,
      input: { batchId: missingLauncher.batch.id, action: "start_one", itemId: missingLauncherItem.id }
    }),
    (error) => error.code === "COMMUNICATION_PROCESS_LAUNCHER_REQUIRED"
  );
  assert.strictEqual(getCommunicationBatch(db, missingLauncher.batch.id).status, "confirmed");
  const mismatched = createCommunicationBatch({
    db,
    input: {
      planId: fixture.planId,
      jobIds: [fixture.mismatchFirstJobId, fixture.mismatchSecondJobId],
      browserMode: "edge"
    }
  });
  const [mismatchFirst, mismatchSecond] = listCommunicationBatchItems(db, mismatched.batch.id);
  let mismatchSpawns = 0;
  assert.throws(
    () => controlCommunicationBatch({
      db,
      input: { batchId: mismatched.batch.id, action: "start_one", itemId: mismatchSecond.id },
      deps: { spawnCommunication() { mismatchSpawns += 1; } }
    }),
    (error) => error.code === "COMMUNICATION_SINGLE_ITEM_MISMATCH" && error.statusCode === 409
  );
  assert.strictEqual(mismatchSpawns, 0);
  assert.strictEqual(getCommunicationBatch(db, mismatched.batch.id).status, "confirmed");
  assert.deepStrictEqual(
    listCommunicationBatchItems(db, mismatched.batch.id).map((item) => [item.id, item.status, item.clickCount]),
    [[mismatchFirst.id, "pending", 0], [mismatchSecond.id, "pending", 0]]
  );
  const rebindable = createCommunicationBatch({
    db,
    input: { planId: fixture.planId, jobIds: [fixture.rebindJobId], browserMode: "edge" }
  });
  bindCommunicationBatchRuntime(db, {
    batchId: rebindable.batch.id,
    browser: browserBinding({ bindingGeneration: 1 })
  });
  setCommunicationBatchStatus(db, { batchId: rebindable.batch.id, status: "running" });
  setCommunicationBatchStatus(db, { batchId: rebindable.batch.id, status: "paused" });
  let rebindCalls = 0;
  const rebound = await rebindCommunicationBrowser({
    db,
    input: { batchId: rebindable.batch.id },
    deps: {
      async inspectAndBindCommunicationBrowser({ batch }) {
        rebindCalls += 1;
        return bindCommunicationBatchRuntime(db, {
          batchId: batch.id,
          browser: browserBinding({
            windowId: 1995685675,
            searchTabId: 1995685534,
            messageTabId: 1995685619,
            searchScrollTop: 360,
            bindingGeneration: batch.runtime.browser.bindingGeneration
          }),
          rebind: true
        });
      }
    }
  });
  assert.strictEqual(rebindCalls, 1);
  assert.strictEqual(rebound.batch.status, "paused");
  assert.strictEqual(rebound.batch.runtime.browser.bindingGeneration, 2);
  assert.strictEqual(rebound.batch.runtime.browser.searchTabId, 1995685534);
  const portableRebindable = createCommunicationBatch({
    db,
    input: { planId: fixture.planId, jobIds: [fixture.portableRebindJobId], browserMode: "portable" }
  });
  bindCommunicationBatchRuntime(db, {
    batchId: portableRebindable.batch.id,
    browser: browserBinding({
      mode: "portable",
      windowId: 17,
      searchTabId: "CDP-search",
      messageTabId: "CDP-chat"
    })
  });
  setCommunicationBatchStatus(db, { batchId: portableRebindable.batch.id, status: "running" });
  setCommunicationBatchStatus(db, { batchId: portableRebindable.batch.id, status: "interrupted" });
  const portableRebound = await rebindCommunicationBrowser({
    db,
    input: { batchId: portableRebindable.batch.id },
    deps: {
      async inspectAndBindCommunicationBrowser({ batch }) {
        return bindCommunicationBatchRuntime(db, {
          batchId: batch.id,
          browser: browserBinding({
            mode: "portable",
            windowId: 17,
            searchTabId: "CDP-search-next",
            messageTabId: "CDP-chat-next",
            bindingGeneration: batch.runtime.browser.bindingGeneration
          }),
          rebind: true
        });
      }
    }
  });
  assert.deepStrictEqual(portableRebound.batch.runtime.browser, browserBinding({
    mode: "portable",
    windowId: 17,
    searchTabId: "CDP-search-next",
    messageTabId: "CDP-chat-next",
    bindingGeneration: 2
  }));
  const portableBlocked = createCommunicationBatch({
    db,
    input: { planId: fixture.planId, jobIds: [fixture.portableBlockedRebindJobId], browserMode: "portable" }
  });
  bindCommunicationBatchRuntime(db, {
    batchId: portableBlocked.batch.id,
    browser: browserBinding({ mode: "portable", windowId: 17, searchTabId: "CDP-blocked-search", messageTabId: "CDP-blocked-chat" })
  });
  setCommunicationBatchStatus(db, { batchId: portableBlocked.batch.id, status: "running" });
  setCommunicationBatchStatus(db, { batchId: portableBlocked.batch.id, status: "interrupted" });
  const portableBlockedItem = transitionToAmbiguous(db, portableBlocked.batch.id);
  let portableBlockedInspections = 0;
  await assert.rejects(() => rebindCommunicationBrowser({
    db,
    input: { batchId: portableBlocked.batch.id },
    deps: { async inspectAndBindCommunicationBrowser() { portableBlockedInspections += 1; } }
  }), (error) => error.code === "COMMUNICATION_BROWSER_REBIND_BLOCKED" && error.statusCode === 409);
  assert.strictEqual(portableBlockedInspections, 0);
  await clickedTerminalPortableRebindRecoverySmoke(db, fixture);
  recoveryFloorCommunicationGuardSmoke(db, fixture);
  const directResolution = createCommunicationBatch({
    db,
    input: { planId: fixture.planId, jobIds: [fixture.directResolveJobId], browserMode: "edge" }
  });
  const directResolutionItem = transitionToAmbiguous(db, directResolution.batch.id);
  const directResolved = resolveAmbiguousCommunication({
    db,
    input: { batchId: directResolution.batch.id, itemId: directResolutionItem.id, status: "stopped", evidenceNote: "Direct application review evidence." }
  });
  assert.deepStrictEqual(Object.keys(directResolved).sort(), ["batch", "item", "summary"]);
  assert.strictEqual(directResolved.item.status, "stopped");
  assert.strictEqual(directResolved.batch.id, directResolution.batch.id);

  const batchesBeforeForgedAuthority = Number(db.prepare("SELECT COUNT(*) AS count FROM communication_batches").get().count);
  await expectApiError(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: fixture.startJobId,
    browserMode: "portable",
    cdpPort: 9222
  }, "DASHBOARD_BROWSER_AUTHORITY_MISMATCH", 409);
  assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM communication_batches").get().count), batchesBeforeForgedAuthority);
  const created = await postJson(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: fixture.startJobId,
    title: "forged title",
    company: "forged company"
  });
  assert.strictEqual(created.status, 200);
  assert.deepStrictEqual(Object.keys(created.body).sort(), ["batch", "items", "quota", "summary"]);
  const batchId = created.body.batch.id;
  assert.deepStrictEqual(listCommunicationBatchItems(db, batchId).map((item) => [item.jobId, item.titleSnapshot, item.companySnapshot, item.jobUrl]), [[
    fixture.startJobId,
    "Start role",
    "Start company",
    "https://www.zhipin.com/job_detail/start.html"
  ]]);
  assert.deepStrictEqual(created.body.batch.policySnapshot.browser, { mode: "edge" });

  const status = getCommunicationStatus({ db, batchId });
  assert.deepStrictEqual(Object.keys(status).sort(), ["batch", "calibration", "items", "quota", "runtimeBlock", "summary"]);
  assert.deepStrictEqual(status.calibration, {
    implementation: "implemented",
    calibration: "calibrated",
    acceptance: "accepted",
    executionEnabled: true
  });
  const httpStatus = await getJson(baseUrl, `/api/communication-status?batchId=${batchId}`);
  assert.strictEqual(httpStatus.status, 200);
  assert.deepStrictEqual(httpStatus.body, status);

  setSiteRuntimeState(db, "boss", {
    status: "blocked",
    reasonCode: "BOSS_RISK_CONTROL",
    details: { blockedUntil: "2099-01-01T00:00:00.000Z" }
  });
  const startItem = listCommunicationBatchItems(db, batchId)[0];
  await expectApiError(
    baseUrl,
    "/api/communication-control",
    { batchId, action: "start_one", itemId: startItem.id },
    "BOSS_RISK_CONTROL",
    409
  );
  assert.strictEqual(spawns.length, 0);
  clearSiteRuntimeState(db, "boss");
  await expectApiError(baseUrl, "/api/communication-control", { batchId, action: "pause" }, "COMMUNICATION_CONTROL_INVALID");
  assert.strictEqual(spawns.length, 0);
  assert.throws(
    () => controlCommunicationBatch({
      db,
      input: { batchId, action: "start" },
      deps: {
        communicationCalibrationReader: () => ({
          implementation: "implemented",
          calibration: "calibrated",
          acceptance: "e2e_pending",
          executionEnabled: true
        }),
        spawnCommunication() {}
      }
    }),
    (error) => error.code === "COMMUNICATION_E2E_SINGLE_ITEM_REQUIRED"
  );
  assert.strictEqual(spawns.length, 0);

  const started = await postJson(baseUrl, "/api/communication-control", {
    batchId,
    action: "start"
  });
  assert.strictEqual(started.status, 200);
  assert.deepStrictEqual(Object.keys(started.body).sort(), ["batch", "items", "summary"]);
  assert.strictEqual(started.body.batch.status, "running");
  assert.strictEqual(spawns.length, 1);
  assert.deepStrictEqual(spawns[0].args.slice(spawns[0].args.indexOf("communicate")), [
    "communicate", "--db", dbPath, "--batch", String(batchId), "--browser", "edge"
  ]);

  const interrupted = await postJson(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: fixture.ambiguousJobId,
    browserMode: "edge"
  });
  const interruptedItem = listCommunicationBatchItems(db, interrupted.body.batch.id)[0];
  setCommunicationBatchStatus(db, { batchId: interrupted.body.batch.id, status: "running" });
  transitionCommunicationItem(db, { itemId: interruptedItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: interruptedItem.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(db, { itemId: interruptedItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(interruptedItem) });
  transitionCommunicationItem(db, { itemId: interruptedItem.id, expectedStatus: "click_dispatched", status: "ambiguous" });
  setCommunicationBatchStatus(db, { batchId: interrupted.body.batch.id, status: "interrupted" });
  let ambiguousRebindCalls = 0;
  await assert.rejects(
    () => rebindCommunicationBrowser({
      db,
      input: { batchId: interrupted.body.batch.id },
      deps: {
        async inspectAndBindCommunicationBrowser() {
          ambiguousRebindCalls += 1;
          throw new Error("ambiguous rebind must fail before browser inspection");
        }
      }
    }),
    (error) => error.code === "COMMUNICATION_BROWSER_REBIND_BLOCKED" && error.statusCode === 409
  );
  assert.strictEqual(ambiguousRebindCalls, 0);
  await expectApiError(baseUrl, "/api/communication-control", { batchId: interrupted.body.batch.id, action: "resume" }, "COMMUNICATION_RESUME_REQUIRES_REVIEW", 409);
  assert.strictEqual(spawns.length, 1);
  await expectApiError(baseUrl, "/api/communication-resolve", { batchId: interrupted.body.batch.id, itemId: interruptedItem.id, status: "stopped" }, "COMMUNICATION_AMBIGUOUS_EVIDENCE_REQUIRED");
  const resolved = await postJson(baseUrl, "/api/communication-resolve", {
    batchId: interrupted.body.batch.id,
    itemId: interruptedItem.id,
    status: "stopped",
    evidenceNote: "Human review could not verify the result."
  });
  assert.strictEqual(resolved.status, 200);
  assert.strictEqual(resolved.body.item.status, "stopped");
  assert.strictEqual(resolved.body.item.clickCount, 1);
  assert.deepStrictEqual(JSON.parse(db.prepare("SELECT payload_json FROM events WHERE event_type = 'communication_manual_resolution' ORDER BY id DESC LIMIT 1").get().payload_json), {
    batchId: interrupted.body.batch.id,
    itemId: interruptedItem.id,
    jobId: fixture.ambiguousJobId,
    status: "stopped",
    note: "Human review could not verify the result."
  });

  const discardable = await postJson(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: fixture.discardJobId,
    browserMode: "edge"
  });
  const discarded = await postForm(baseUrl, "/api/communication-control", { batchId: discardable.body.batch.id, action: "discard" });
  assert.strictEqual(discarded.status, 303);
  assert.strictEqual(discarded.location, `/communication?batchId=${discardable.body.batch.id}`);
  assert.strictEqual(getCommunicationBatch(db, discardable.body.batch.id).status, "stopped");

  const syncSpawnFailure = await postJson(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: fixture.syncSpawnJobId,
    browserMode: "edge"
  });
  const syncSpawnItem = listCommunicationBatchItems(db, syncSpawnFailure.body.batch.id)[0];
  spawnBehavior = "throw";
  await expectApiError(baseUrl, "/api/communication-control", {
    batchId: syncSpawnFailure.body.batch.id,
    action: "start_one",
    itemId: syncSpawnItem.id
  }, "COMMUNICATION_REQUEST_FAILED");
  assert.deepStrictEqual(
    pickBatchState(getCommunicationBatch(db, syncSpawnFailure.body.batch.id)),
    { status: "interrupted", stopCode: "COMMUNICATION_PROCESS_START_FAILED" }
  );
  spawnBehavior = "normal";

  const childErrorFailure = await postJson(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: fixture.childErrorJobId,
    browserMode: "edge"
  });
  const childErrorItem = listCommunicationBatchItems(db, childErrorFailure.body.batch.id)[0];
  const childErrorStarted = await postJson(baseUrl, "/api/communication-control", {
    batchId: childErrorFailure.body.batch.id,
    action: "start_one",
    itemId: childErrorItem.id
  });
  assert.strictEqual(childErrorStarted.status, 200);
  spawnedChildren.at(-1).emit("error", new Error("child process error"));
  assert.deepStrictEqual(
    pickBatchState(getCommunicationBatch(db, childErrorFailure.body.batch.id)),
    { status: "interrupted", stopCode: "COMMUNICATION_PROCESS_ERROR" }
  );

  const parentFailureWorkflow = createReviewWorkflow(db, fixture);
  const parentFailure = createCommunicationBatch({
    db,
    input: {
      workflowRunId: parentFailureWorkflow.id,
      planId: fixture.planId,
      jobIds: [fixture.parentFailureJobId],
      browserMode: "edge"
    }
  });
  const parentFailureItem = listCommunicationBatchItems(db, parentFailure.batch.id)[0];
  const parentFailureStarted = await postJson(baseUrl, "/api/communication-control", {
    batchId: parentFailure.batch.id,
    action: "start_one",
    itemId: parentFailureItem.id
  });
  assert.strictEqual(parentFailureStarted.status, 200);
  transitionWorkflowRun(db, { id: parentFailureWorkflow.id, status: "communicating" });
  db.exec(`CREATE TEMP TRIGGER fail_parent_workflow_interrupt
    BEFORE UPDATE OF status ON workflow_runs
    WHEN OLD.id = '${parentFailureWorkflow.id}' AND NEW.status = 'interrupted'
    BEGIN SELECT RAISE(ABORT, 'forced parent workflow interrupt failure'); END`);
  spawnedChildren.at(-1).emit("close", 1, null);
  db.exec("DROP TRIGGER fail_parent_workflow_interrupt");
  assert.strictEqual(getCommunicationBatch(db, parentFailure.batch.id).status, "running");
  assert.strictEqual(getWorkflowRun(db, parentFailureWorkflow.id).status, "communicating");
  spawnedChildren.at(-1).emit("close", 1, null);
  assert.strictEqual(getCommunicationBatch(db, parentFailure.batch.id).status, "interrupted");
  assert.strictEqual(getWorkflowRun(db, parentFailureWorkflow.id).status, "interrupted");

  noDbPathServer = createDashboardServer({ db, root, dbPath: "", browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" }, logger, spawnProcess() { throw new Error("spawn must not run without dbPath"); } });
  const noDbPathBaseUrl = await listen(noDbPathServer);
  const missingDbPath = await postJson(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: fixture.missingDbPathJobId,
    browserMode: "edge"
  });
  const missingDbPathItem = listCommunicationBatchItems(db, missingDbPath.body.batch.id)[0];
  await expectApiError(noDbPathBaseUrl, "/api/communication-control", {
    batchId: missingDbPath.body.batch.id,
    action: "start_one",
    itemId: missingDbPathItem.id
  }, "COMMUNICATION_DB_PATH_REQUIRED", 500);
  assert.deepStrictEqual(
    pickBatchState(getCommunicationBatch(db, missingDbPath.body.batch.id)),
    { status: "interrupted", stopCode: "COMMUNICATION_PROCESS_START_FAILED" }
  );

  console.log("communication_application_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (noDbPathServer) await new Promise((resolve) => noDbPathServer.close(resolve));
  if (db) db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
  }
});

function seed(database) {
  const now = new Date().toISOString();
  const profileId = Number(database.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?)").run("Application smoke", "{}", now, now).lastInsertRowid);
  const planId = Number(database.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(profileId, "Application smoke", "{}", now, now).lastInsertRowid);
  const scanBatchId = createBatch(database, "boss", "communication-application", "communication application smoke", { profileId, searchPlanId: planId });
  return {
    profileId,
    planId,
    directJobId: upsertJob(database, job("direct", { title: "Direct role" }), scanBatchId),
    launcherJobId: upsertJob(database, job("launcher", { title: "Launcher role" }), scanBatchId),
    rebindJobId: upsertJob(database, job("rebind", { title: "Rebind role" }), scanBatchId),
    portableRebindJobId: upsertJob(database, job("portable-rebind", { title: "Portable rebind role" }), scanBatchId),
    portableBlockedRebindJobId: upsertJob(database, job("portable-rebind-blocked", { title: "Portable blocked rebind role" }), scanBatchId),
    portableSucceededRebindJobId: upsertJob(database, job("portable-rebind-succeeded", { title: "Portable succeeded rebind role" }), scanBatchId),
    portableAlreadyRebindJobId: upsertJob(database, job("portable-rebind-already", { title: "Portable already communicated role" }), scanBatchId),
    portableStoppedRebindJobId: upsertJob(database, job("portable-rebind-stopped", { title: "Portable stopped rebind role" }), scanBatchId),
    directResolveJobId: upsertJob(database, job("direct-resolve", { title: "Direct resolve role" }), scanBatchId),
    mismatchFirstJobId: upsertJob(database, job("mismatch-first", { title: "Mismatch first role" }), scanBatchId),
    mismatchSecondJobId: upsertJob(database, job("mismatch-second", { title: "Mismatch second role" }), scanBatchId),
    startJobId: upsertJob(database, job("start", { title: "Start role", company: "Start company" }), scanBatchId),
    ambiguousJobId: upsertJob(database, job("ambiguous", { title: "Ambiguous role" }), scanBatchId),
    discardJobId: upsertJob(database, job("discard", { title: "Discard role" }), scanBatchId),
    syncSpawnJobId: upsertJob(database, job("sync-spawn", { title: "Sync spawn role" }), scanBatchId),
    childErrorJobId: upsertJob(database, job("child-error", { title: "Child error role" }), scanBatchId),
    parentFailureJobId: upsertJob(database, job("parent-failure", {
      title: "Parent failure role",
      description: "Build Python services for communication application testing with complete role evidence. ".repeat(4)
    }), scanBatchId),
    missingDbPathJobId: upsertJob(database, job("missing-db-path", { title: "Missing dbPath role" }), scanBatchId)
  };
}

function createReviewWorkflow(database, fixture) {
  const workflow = createWorkflowRun(database, {
    profileId: fixture.profileId,
    planId: fixture.planId,
    localDay: "2026-08-14",
    sequence: 1,
    targetSuccessCount: 1,
    inventoryCount: 1,
    candidateGap: 0,
    scanNeeded: false,
    keywords: [],
    budget: { maxDetailTotal: 0, browserPageBudget: 0 },
    planner: { browserMode: "edge" }
  });
  transitionWorkflowRun(database, { id: workflow.id, status: "scanning" });
  transitionWorkflowRun(database, { id: workflow.id, status: "analyzing" });
  transitionWorkflowRun(database, { id: workflow.id, status: "review_required" });
  return getWorkflowRun(database, workflow.id);
}

function browserBinding(overrides = {}) {
  return {
    mode: "edge",
    windowId: 103,
    searchTabId: 101,
    messageTabId: 102,
    searchReturnUrl: "https://www.zhipin.com/web/geek/jobs?city=100010000",
    searchScrollTop: 120,
    bindingGeneration: 1,
    ...overrides
  };
}

function recoveryFloorCommunicationGuardSmoke(database, fixture) {
  const riskAtMs = Date.UTC(2026, 7, 12, 0, 0, 0);
  persistBossRiskControl(database, {
    site: "boss",
    runId: "communication-application-recovery-floor",
    error: Object.assign(new Error("BOSS risk control"), {
      code: "BOSS_RISK_CONTROL",
      blockedUntil: new Date(riskAtMs + 60 * 60_000).toISOString()
    }),
    nowMs: riskAtMs
  });
  const startBatch = createCommunicationBatch({
    db: database,
    input: { planId: fixture.planId, jobIds: [fixture.directJobId], browserMode: "edge" }
  }).batch;
  const resumeBatch = createCommunicationBatch({
    db: database,
    input: { planId: fixture.planId, jobIds: [fixture.launcherJobId], browserMode: "edge" }
  }).batch;
  setCommunicationBatchStatus(database, { batchId: resumeBatch.id, status: "running" });
  setCommunicationBatchStatus(database, { batchId: resumeBatch.id, status: "paused" });
  const startItem = listCommunicationBatchItems(database, startBatch.id)[0];
  const resumeItem = listCommunicationBatchItems(database, resumeBatch.id)[0];
  let spawnCalls = 0;
  withFrozenNow(riskAtMs + 47 * 60 * 60_000, () => {
    for (const [batchId, action, itemId] of [
      [startBatch.id, "start_one", startItem.id],
      [resumeBatch.id, "resume_one", resumeItem.id]
    ]) {
      assert.throws(
        () => controlCommunicationBatch({
          db: database,
          input: { batchId, action, itemId },
          deps: { spawnCommunication() { spawnCalls += 1; } }
        }),
        (error) => error.code === "BOSS_RISK_CONTROL" && error.statusCode === 409
      );
    }
  });
  assert.strictEqual(spawnCalls, 0, "recovery floor must reject before spawnCommunication");
  assert.strictEqual(getCommunicationBatch(database, startBatch.id).status, "confirmed");
  assert.strictEqual(getCommunicationBatch(database, resumeBatch.id).status, "paused");
  clearSiteRuntimeState(database, "boss");
}

function withFrozenNow(nowMs, fn) {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function job(sourceId, overrides = {}) {
  return {
    source: "boss",
    sourceId,
    keyword: "communication-application",
    title: "Communication role",
    company: `Company ${sourceId}`,
    location: "Guangzhou",
    salary: "10-15K",
    experience: "1-3 years",
    education: "Bachelor",
    bossActiveText: "Active today",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
    tags: ["Python"],
    description: "Build Python services for communication application testing.",
    score: 20,
    level: "可投",
    matches: ["Python"],
    risks: [],
    qualityTags: [],
    analysis: {
      semanticStatus: "complete",
      recommendation: "primary",
      recommendationSchemaVersion: 2,
      fitLevel: "fit",
      confidence: 0.9,
      evidence: { jd: ["Python"], resume: ["Python"] }
    },
    ...overrides
  };
}

function clickAudit(item) {
  return {
    eventType: "communication_click",
    payload: { batchId: item.batchId, itemId: item.id, jobId: item.jobId, state: "click_dispatched" }
  };
}

function transitionToAmbiguous(database, batchId) {
  const clicked = transitionToClicked(database, batchId);
  return transitionCommunicationItem(database, { itemId: clicked.id, expectedStatus: "click_dispatched", status: "ambiguous" });
}

function transitionToClicked(database, batchId) {
  const item = listCommunicationBatchItems(database, batchId)[0];
  transitionCommunicationItem(database, { itemId: item.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(database, { itemId: item.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(database, { itemId: item.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(item) });
  return listCommunicationBatchItems(database, batchId)[0];
}

async function clickedTerminalPortableRebindRecoverySmoke(database, fixture) {
  for (const [status, jobId] of [
    ["succeeded", fixture.portableSucceededRebindJobId],
    ["already_communicated", fixture.portableAlreadyRebindJobId],
    ["stopped", fixture.portableStoppedRebindJobId]
  ]) {
    const created = createCommunicationBatch({
      db: database,
      input: { planId: fixture.planId, jobIds: [jobId], browserMode: "portable" }
    });
    bindCommunicationBatchRuntime(database, {
      batchId: created.batch.id,
      browser: browserBinding({
        mode: "portable",
        windowId: 17,
        searchTabId: `CDP-${status}-search`,
        messageTabId: `CDP-${status}-chat`
      })
    });
    setCommunicationBatchStatus(database, { batchId: created.batch.id, status: "running" });
    setCommunicationBatchStatus(database, { batchId: created.batch.id, status: "interrupted" });
    const clicked = transitionToClicked(database, created.batch.id);
    if (status === "already_communicated") {
      transitionCommunicationItem(database, { itemId: clicked.id, expectedStatus: "click_dispatched", status });
    } else {
      const ambiguous = transitionCommunicationItem(database, {
        itemId: clicked.id, expectedStatus: "click_dispatched", status: "ambiguous"
      });
      resolveAmbiguousCommunication({
        db: database,
        input: {
          batchId: created.batch.id,
          itemId: ambiguous.id,
          status,
          evidenceNote: `Manual ${status} fixture evidence.`
        }
      });
    }
    const before = getCommunicationBatch(database, created.batch.id).runtime.browser;
    let inspections = 0;
    const rebound = await rebindCommunicationBrowser({
      db: database,
      input: { batchId: created.batch.id },
      deps: {
        async inspectAndBindCommunicationBrowser() {
          inspections += 1;
          return bindCommunicationBatchRuntime(database, {
            batchId: created.batch.id,
            browser: { ...before, searchScrollTop: before.searchScrollTop + 1 },
            rebind: true
          });
        }
      }
    });
    assert.strictEqual(inspections, 1, `${status} must allow one read-only browser inspection`);
    assert.deepStrictEqual(rebound.batch.runtime.browser, {
      ...before,
      searchScrollTop: before.searchScrollTop + 1,
      bindingGeneration: before.bindingGeneration + 1
    });
    assert.strictEqual(listCommunicationBatchItems(database, created.batch.id)[0].clickCount, 1);
  }
}

function pickBatchState(batch) {
  return { status: batch.status, stopCode: batch.stopCode };
}

async function listen(instance) {
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${instance.address().port}`;
}

async function postJson(baseUrl, pathname, body) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: params,
    redirect: "manual"
  });
  return { status: response.status, body: await response.json() };
}

async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function postForm(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    redirect: "manual"
  });
  return { status: response.status, location: response.headers.get("location") };
}

async function expectApiError(baseUrl, pathname, body, code, status = 400) {
  const response = await postJson(baseUrl, pathname, body);
  assert.strictEqual(response.status, status);
  assert.strictEqual(response.body.errorCode, code);
}
