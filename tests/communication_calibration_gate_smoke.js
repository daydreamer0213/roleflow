const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { openDb, createBatch, upsertJob } = require("../src/core/storage");
const { createCommunicationBatch, getCommunicationBatch } = require("../src/core/communication_batches");
const {
  communicationCalibrationStatus,
  assertCommunicationExecutionEnabled
} = require("../src/core/communication_calibration");
const { createDashboardServer } = require("../src/dashboard/server");

const logger = { info() {}, warn() {}, error() {}, requestId() { return "communication-calibration-gate-smoke"; }, listRecent() { return []; } };
let db;
let server;

(async () => {
  assert.deepStrictEqual(communicationCalibrationStatus(), { status: "calibrated", executionEnabled: true });
  assert.deepStrictEqual(assertCommunicationExecutionEnabled(), { status: "calibrated", executionEnabled: true });

  db = openDb(":memory:");
  const { planId, jobId } = seed(db);
  const batch = createCommunicationBatch(db, { planId, jobIds: [jobId], browserMode: "edge" });
  const spawns = [];
  let spawnedChild;
  server = createDashboardServer({
    db,
    root: process.cwd(),
    dbPath: "D:\\RoleFlow\\calibration-smoke.sqlite",
    logger,
    spawnProcess(file, args, options) {
      spawns.push({ file, args, options });
      const child = new EventEmitter();
      child.pid = 4242;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      spawnedChild = child;
      return child;
    }
  });
  const baseUrl = await listen(server);

  const response = await postJson(baseUrl, "/api/communication-control", { batchId: batch.id, action: "start" });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.batch.status, "running");
  assert.strictEqual(getCommunicationBatch(db, batch.id).status, "running");
  assert.strictEqual(spawns.length, 1);
  assert.deepStrictEqual(spawns[0].args.slice(0, 4), ["--disable-warning=ExperimentalWarning", "src/cli.js", "communicate", "--db"]);
  assert(spawns[0].args.includes(String(batch.id)));
  assert(spawns[0].args.includes("edge"));
  spawnedChild.emit("close", 1, null);
  assert.strictEqual(getCommunicationBatch(db, batch.id).status, "interrupted");
  assert.strictEqual(getCommunicationBatch(db, batch.id).stopCode, "COMMUNICATION_PROCESS_EXITED");

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
