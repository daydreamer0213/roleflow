const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const {
  openDb,
  createBatch,
  upsertJob,
  setSiteRuntimeState,
  clearSiteRuntimeState
} = require("../src/core/storage");
const {
  getCommunicationBatch,
  listCommunicationBatchItems,
  setCommunicationBatchStatus,
  transitionCommunicationItem
} = require("../src/core/communication_batches");
const {
  createCommunicationBatch,
  controlCommunicationBatch,
  getCommunicationStatus,
  resolveAmbiguousCommunication
} = require("../src/application/communication");
const { createDashboardServer } = require("../src/dashboard/server");

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

  for (const fn of [createCommunicationBatch, controlCommunicationBatch, getCommunicationStatus, resolveAmbiguousCommunication]) {
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
  assert.throws(
    () => controlCommunicationBatch({ db, input: { batchId: missingLauncher.batch.id, action: "start" } }),
    (error) => error.code === "COMMUNICATION_PROCESS_LAUNCHER_REQUIRED"
  );
  assert.strictEqual(getCommunicationBatch(db, missingLauncher.batch.id).status, "confirmed");
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

  const created = await postJson(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: fixture.startJobId,
    browserMode: "portable",
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
  assert.deepStrictEqual(created.body.batch.policySnapshot.browser, { mode: "portable", cdpPort: 9222 });

  const status = getCommunicationStatus({ db, batchId });
  assert.deepStrictEqual(Object.keys(status).sort(), ["batch", "calibration", "items", "quota", "runtimeBlock", "summary"]);
  assert.deepStrictEqual(status.calibration, {
    implementation: "implemented",
    calibration: "calibrated",
    acceptance: "e2e_pending",
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
  await expectApiError(baseUrl, "/api/communication-control", { batchId, action: "start" }, "BOSS_RISK_CONTROL", 409);
  assert.strictEqual(spawns.length, 0);
  clearSiteRuntimeState(db, "boss");
  await expectApiError(baseUrl, "/api/communication-control", { batchId, action: "pause" }, "COMMUNICATION_CONTROL_INVALID");
  assert.strictEqual(spawns.length, 0);

  const started = await postJson(baseUrl, "/api/communication-control", { batchId, action: "start" });
  assert.strictEqual(started.status, 200);
  assert.deepStrictEqual(Object.keys(started.body).sort(), ["batch", "items", "summary"]);
  assert.strictEqual(started.body.batch.status, "running");
  assert.strictEqual(spawns.length, 1);
  assert.deepStrictEqual(spawns[0].args.slice(spawns[0].args.indexOf("communicate")), [
    "communicate", "--db", dbPath, "--batch", String(batchId), "--browser", "portable", "--cdp-port", "9222"
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
  spawnBehavior = "throw";
  await expectApiError(baseUrl, "/api/communication-control", { batchId: syncSpawnFailure.body.batch.id, action: "start" }, "COMMUNICATION_REQUEST_FAILED");
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
  const childErrorStarted = await postJson(baseUrl, "/api/communication-control", { batchId: childErrorFailure.body.batch.id, action: "start" });
  assert.strictEqual(childErrorStarted.status, 200);
  spawnedChildren.at(-1).emit("error", new Error("child process error"));
  assert.deepStrictEqual(
    pickBatchState(getCommunicationBatch(db, childErrorFailure.body.batch.id)),
    { status: "interrupted", stopCode: "COMMUNICATION_PROCESS_ERROR" }
  );

  noDbPathServer = createDashboardServer({ db, root, dbPath: "", logger, spawnProcess() { throw new Error("spawn must not run without dbPath"); } });
  const noDbPathBaseUrl = await listen(noDbPathServer);
  const missingDbPath = await postJson(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: fixture.missingDbPathJobId,
    browserMode: "edge"
  });
  await expectApiError(noDbPathBaseUrl, "/api/communication-control", { batchId: missingDbPath.body.batch.id, action: "start" }, "COMMUNICATION_DB_PATH_REQUIRED", 500);
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
    planId,
    directJobId: upsertJob(database, job("direct", { title: "Direct role" }), scanBatchId),
    launcherJobId: upsertJob(database, job("launcher", { title: "Launcher role" }), scanBatchId),
    directResolveJobId: upsertJob(database, job("direct-resolve", { title: "Direct resolve role" }), scanBatchId),
    startJobId: upsertJob(database, job("start", { title: "Start role", company: "Start company" }), scanBatchId),
    ambiguousJobId: upsertJob(database, job("ambiguous", { title: "Ambiguous role" }), scanBatchId),
    discardJobId: upsertJob(database, job("discard", { title: "Discard role" }), scanBatchId),
    syncSpawnJobId: upsertJob(database, job("sync-spawn", { title: "Sync spawn role" }), scanBatchId),
    childErrorJobId: upsertJob(database, job("child-error", { title: "Child error role" }), scanBatchId),
    missingDbPathJobId: upsertJob(database, job("missing-db-path", { title: "Missing dbPath role" }), scanBatchId)
  };
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
  const item = listCommunicationBatchItems(database, batchId)[0];
  transitionCommunicationItem(database, { itemId: item.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(database, { itemId: item.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(database, { itemId: item.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(item) });
  return transitionCommunicationItem(database, { itemId: item.id, expectedStatus: "click_dispatched", status: "ambiguous" });
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
