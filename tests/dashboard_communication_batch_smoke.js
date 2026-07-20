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
  setSiteRuntimeState
} = require("../src/core/storage");
const {
  getCommunicationBatch,
  listCommunicationBatchItems,
  transitionCommunicationItem
} = require("../src/core/communication_batches");
const { createDashboardServer } = require("../src/dashboard/server");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `dashboard-communication-batch-${Date.now()}.sqlite`);
const logger = { info() {}, warn() {}, error() {}, requestId() { return "dashboard-communication-batch-smoke"; }, listRecent() { return []; } };
let db;
let server;

(async () => {
  fs.mkdirSync(smokeDir, { recursive: true });
  db = openDb(dbPath);
  const fixture = seed(db);
  const spawns = [];
  server = createDashboardServer({ db, root, dbPath, logger, spawnProcess(file, args, options) {
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
  assert.match(builder.body, new RegExp(`name="jobIds" value="${fixture.talkId}" checked`));
  assert.match(builder.body, new RegExp(`name="jobIds" value="${fixture.backupId}"`));
  assert.doesNotMatch(builder.body, new RegExp(`name="jobIds" value="${fixture.backupId}" checked`));
  assert.doesNotMatch(builder.body, new RegExp(`value="${fixture.notRecommendedId}"`));
  assert.doesNotMatch(builder.body, new RegExp(`value="${fixture.appliedId}"`));
  assert.doesNotMatch(builder.body, new RegExp(`value="${fixture.skippedId}"`));
  assert.match(builder.body, /<output[^>]*id="selected-count"/);
  assert.match(builder.body, /form\.addEventListener\('change',update\);update\(\)/);

  const queue = await getText(baseUrl, `/queue?planId=${fixture.planId}`);
  const plan = await getText(baseUrl, `/plan?planId=${fixture.planId}`);
  assert.match(queue.body, new RegExp(`/communication/new\\?planId=${fixture.planId}`));
  assert.match(plan.body, new RegExp(`/communication/new\\?planId=${fixture.planId}`));
  assert.match(queue.body, /批量沟通清单/);
  assert.match(plan.body, /批量沟通清单/);
  assert.doesNotMatch(plan.body, />Resume</);

  await expectApiError(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.notRecommendedId, browserMode: "edge", title: "forged" }, "COMMUNICATION_JOB_INELIGIBLE");
  await expectApiError(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.appliedId, browserMode: "edge", company: "forged" }, "COMMUNICATION_JOB_INELIGIBLE");
  await expectApiError(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.skippedId, browserMode: "edge", company: "forged" }, "COMMUNICATION_JOB_INELIGIBLE");
  await expectApiError(baseUrl, "/api/communication-batch", { planId: fixture.planId, browserMode: "edge" }, "COMMUNICATION_JOB_INELIGIBLE");

  const created = await postJson(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: [fixture.primaryId, fixture.backupId], browserMode: "edge", title: "forged", company: "forged", bucket: "not_recommended", url: "https://invalid.example" });
  assert.strictEqual(created.status, 200);
  const batchId = created.body.batch.id;
  assert.deepStrictEqual(listCommunicationBatchItems(db, batchId).map((item) => [item.jobId, item.titleSnapshot, item.companySnapshot]), [
    [fixture.primaryId, "Primary role", "Company primary"],
    [fixture.backupId, "Backup role", "Company backup"]
  ]);

  const review = await getText(baseUrl, `/communication?batchId=${batchId}`);
  assert.match(review.body, /校准状态：calibrated/);
  assert.match(review.body, /name="action" value="start"/);
  const status = await getJson(baseUrl, `/api/communication-status?batchId=${batchId}`);
  assert.deepStrictEqual(Object.keys(status.body).sort(), ["batch", "calibration", "items", "quota", "runtimeBlock", "summary"]);
  assert.strictEqual(status.body.calibration.executionEnabled, true);
  assert.strictEqual(status.body.quota.limit, 150);

  const started = await postJson(baseUrl, "/api/communication-control", { batchId, action: "start" });
  assert.strictEqual(started.status, 200);
  assert.strictEqual(started.body.batch.status, "running");
  assert.strictEqual(spawns.length, 1);
  assert(spawns[0].args.includes("communicate"));
  assert(spawns[0].args.includes(String(batchId)));
  await expectApiError(baseUrl, "/api/communication-control", { batchId, action: "start" }, "COMMUNICATION_BATCH_STATUS_INVALID", 409);

  const ambiguousItem = listCommunicationBatchItems(db, batchId)[0];
  transitionCommunicationItem(db, { itemId: ambiguousItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: ambiguousItem.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(db, { itemId: ambiguousItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(ambiguousItem) });
  transitionCommunicationItem(db, { itemId: ambiguousItem.id, expectedStatus: "click_dispatched", status: "ambiguous" });
  const ambiguousReview = await getText(baseUrl, `/communication?batchId=${batchId}`);
  assert.match(ambiguousReview.body, /name="evidenceNote"[^>]*required/);
  await expectApiError(baseUrl, "/api/communication-resolve", { batchId, itemId: ambiguousItem.id, status: "pending", evidenceNote: "invalid status" }, "COMMUNICATION_AMBIGUOUS_RESOLUTION_INVALID");
  await expectApiError(baseUrl, "/api/communication-resolve", { batchId, itemId: ambiguousItem.id, status: "stopped" }, "COMMUNICATION_AMBIGUOUS_EVIDENCE_REQUIRED");
  const evidenceNote = "岗位页无法确认结果，人工停止";
  const resolved = await postJson(baseUrl, "/api/communication-resolve", { batchId, itemId: ambiguousItem.id, status: "stopped", evidenceNote });
  assert.strictEqual(resolved.status, 200);
  assert.strictEqual(resolved.body.item.status, "stopped");
  const resolutionAudit = db.prepare("SELECT payload_json FROM events WHERE job_id = ? AND event_type = 'communication_manual_resolution' ORDER BY id DESC LIMIT 1").get(fixture.primaryId);
  assert.strictEqual(JSON.parse(resolutionAudit.payload_json).note, evidenceNote);
  assert.strictEqual(db.prepare("SELECT status FROM candidate_job_states WHERE profile_id = ? AND job_id = ?").get(1, fixture.primaryId), undefined);
  assert.strictEqual(spawns.length, 1);

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
  assert.strictEqual(spawns.length, 1);
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
  const primaryId = upsertJob(database, job("primary", { title: "Primary role", analysis: completeAnalysis() }), scanBatchId);
  const talkId = upsertJob(database, job("talk", { title: "Talk role", analysis: { semanticStatus: "partial", recommendation: "review" } }), scanBatchId);
  const backupId = upsertJob(database, job("backup", { title: "Backup role", qualityTags: ["experience_overrange"] }), scanBatchId);
  const notRecommendedId = upsertJob(database, job("not-recommended", { title: "Not recommended role", level: "不建议", qualityTags: ["role_mismatch"] }), scanBatchId);
  const appliedId = upsertJob(database, job("applied", { title: "Applied role" }), scanBatchId);
  const safeId = upsertJob(database, job("safe", { title: "Safe role" }), scanBatchId);
  const skippedId = upsertJob(database, job("skipped", { title: "Skipped role" }), scanBatchId);
  markCandidateJob(database, { profileId, planId, jobId: appliedId, status: "applied" });
  markCandidateJob(database, { profileId, planId, jobId: skippedId, status: "skipped" });
  return { planId, primaryId, talkId, backupId, notRecommendedId, appliedId, skippedId, safeId };
}

function job(sourceId, overrides = {}) {
  return { source: "boss", sourceId, keyword: "dashboard-communication", title: "Communication role", company: `Company ${sourceId}`, location: "Guangzhou", salary: "10-15K", experience: "1-3 years", education: "Bachelor", bossActiveText: "Active today", bossActiveDays: 0, url: `https://www.zhipin.com/job_detail/${sourceId}.html`, tags: ["Python"], description: "Dashboard communication batch smoke job.", score: 20, level: "可投", matches: ["Python"], risks: [], qualityTags: [], analysis: {}, ...overrides };
}

function completeAnalysis() {
  return { semanticStatus: "complete", recommendation: "apply", confidence: 0.9, evidence: { jd: ["Python"], resume: ["Python"] } };
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
