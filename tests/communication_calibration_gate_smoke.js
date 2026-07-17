const assert = require("node:assert/strict");
const { openDb, createBatch, upsertJob } = require("../src/core/storage");
const { createCommunicationBatch } = require("../src/core/communication_batches");
const {
  communicationCalibrationStatus,
  assertCommunicationExecutionEnabled
} = require("../src/core/communication_calibration");
const { createDashboardServer } = require("../src/dashboard/server");

const logger = { info() {}, warn() {}, error() {}, requestId() { return "communication-calibration-gate-smoke"; }, listRecent() { return []; } };
let db;
let server;

(async () => {
  assert.deepStrictEqual(communicationCalibrationStatus(), { status: "pending", executionEnabled: false });
  assert.throws(
    () => assertCommunicationExecutionEnabled(),
    (error) => error.code === "BOSS_COMMUNICATION_CALIBRATION_REQUIRED" && error.statusCode === 409
  );

  db = openDb(":memory:");
  const { planId, jobId } = seed(db);
  const batch = createCommunicationBatch(db, { planId, jobIds: [jobId], browserMode: "edge" });
  let spawnCalls = 0;
  server = createDashboardServer({
    db,
    logger,
    spawnProcess() { spawnCalls += 1; throw new Error("communication must remain gated"); }
  });
  const baseUrl = await listen(server);

  for (const action of ["start", "resume"]) {
    const response = await postJson(baseUrl, "/api/communication-control", { batchId: batch.id, action });
    assert.strictEqual(response.status, 409);
    assert.strictEqual(response.body.errorCode, "BOSS_COMMUNICATION_CALIBRATION_REQUIRED");
  }
  assert.strictEqual(spawnCalls, 0);

  console.log("communication_calibration_gate_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) db.close();
});

function seed(database) {
  const now = new Date().toISOString();
  const profileId = Number(database.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("Calibration gate smoke", "{}", now, now).lastInsertRowid);
  const planId = Number(database.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(profileId, "Calibration gate smoke", "{}", now, now).lastInsertRowid);
  const scanBatchId = createBatch(database, "boss", "calibration-gate-smoke", "calibration gate smoke", { profileId, searchPlanId: planId });
  const jobId = upsertJob(database, {
    source: "boss",
    sourceId: "calibration-gate-smoke",
    keyword: "calibration-gate-smoke",
    title: "Calibration gate role",
    company: "RoleFlow",
    location: "Guangzhou",
    salary: "10-15K",
    experience: "1-3 years",
    education: "Bachelor",
    bossActiveText: "Active today",
    bossActiveDays: 0,
    url: "https://www.zhipin.com/job_detail/calibration-gate-smoke.html",
    tags: ["Node.js"],
    description: "Local calibration gate smoke fixture.",
    score: 20,
    level: "recommended",
    matches: ["Node.js"],
    risks: [],
    qualityTags: [],
    analysis: {}
  }, scanBatchId);
  return { planId, jobId };
}

async function listen(app) {
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${app.address().port}`;
}

async function postJson(baseUrl, pathname, body) {
  const params = new URLSearchParams(body);
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: params
  });
  return { status: response.status, body: await response.json() };
}
