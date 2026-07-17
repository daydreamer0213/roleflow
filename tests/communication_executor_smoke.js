const assert = require("node:assert");
const {
  openDb,
  createBatch,
  upsertJob,
  markCandidateJob
} = require("../src/core/storage");
const {
  createCommunicationBatch,
  getCommunicationBatch,
  listCommunicationBatchItems,
  setCommunicationBatchStatus
} = require("../src/core/communication_batches");
const { runCommunicationBatch } = require("../src/core/communication_executor");

async function successFlowSmoke() {
  const fixture = createFixture(2);
  const calls = [];
  const adapter = {
    async inspectCommunicationJob() { calls.push("inspect"); return { state: "ready" }; },
    async dispatchCommunication() { calls.push("dispatch"); },
    async verifyCommunicationResult() { calls.push("verify"); return { state: "succeeded" }; }
  };
  const accessController = { async reserve() { calls.push("reserve"); } };
  const summary = await runCommunicationBatch({
    db: fixture.db,
    batchId: fixture.batch.id,
    adapter,
    accessController,
    randomFn: () => 0,
    sleepFn: async () => calls.push("sleep")
  });
  assert.deepStrictEqual(calls, [
    "reserve", "inspect", "dispatch", "verify",
    ...Array(15).fill("sleep"),
    "reserve", "inspect", "dispatch", "verify"
  ]);
  assert.strictEqual(summary.batchStatus, "completed");
  assert.deepStrictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id).map((item) => item.clickCount), [1, 1]);
  assert.deepStrictEqual(candidateStatuses(fixture), ["applied", "applied"]);
  fixture.close();
}

async function alreadyCommunicatedSmoke() {
  const fixture = createFixture(1);
  let dispatches = 0;
  await runCommunicationBatch({
    db: fixture.db,
    batchId: fixture.batch.id,
    accessController: { async reserve() {} },
    adapter: {
      async inspectCommunicationJob() { return { state: "already_communicated" }; },
      async dispatchCommunication() { dispatches += 1; },
      async verifyCommunicationResult() { throw new Error("must not verify"); }
    },
    sleepFn: async () => {}
  });
  assert.strictEqual(dispatches, 0);
  assert.strictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id)[0].status, "already_communicated");
  assert.deepStrictEqual(candidateStatuses(fixture), ["applied"]);
  fixture.close();
}

async function unavailableAndMismatchContinueSmoke() {
  const fixture = createFixture(3);
  const states = ["job_unavailable", "target_mismatch", "ready"];
  let inspected = 0;
  await runCommunicationBatch({
    db: fixture.db,
    batchId: fixture.batch.id,
    accessController: { async reserve() {} },
    adapter: {
      async inspectCommunicationJob() { return { state: states[inspected++] }; },
      async dispatchCommunication() {},
      async verifyCommunicationResult() { return { state: "succeeded" }; }
    },
    randomFn: () => 0,
    sleepFn: async () => {}
  });
  assert.deepStrictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id).map((item) => item.status), ["job_unavailable", "target_mismatch", "succeeded"]);
  fixture.close();
}

async function ambiguousAndFatalStopSmoke() {
  const ambiguous = createFixture(2);
  let ambiguousInspections = 0;
  await assert.rejects(
    () => runCommunicationBatch({
      db: ambiguous.db,
      batchId: ambiguous.batch.id,
      accessController: { async reserve() {} },
      adapter: {
        async inspectCommunicationJob() { ambiguousInspections += 1; return { state: "ready" }; },
        async dispatchCommunication() {},
        async verifyCommunicationResult() { return { state: "not_confirmed" }; }
      },
      sleepFn: async () => {}
    }),
    (error) => error.code === "COMMUNICATION_RESULT_AMBIGUOUS"
  );
  assert.strictEqual(ambiguousInspections, 1);
  assert.strictEqual(getCommunicationBatch(ambiguous.db, ambiguous.batch.id).status, "interrupted");
  assert.deepStrictEqual(listCommunicationBatchItems(ambiguous.db, ambiguous.batch.id).map((item) => item.status), ["ambiguous", "pending"]);
  ambiguous.close();

  const fatal = createFixture(2);
  let fatalInspections = 0;
  const fatalError = Object.assign(new Error("detail page disappeared"), { code: "BOSS_DETAIL_PAGE_LOST" });
  await assert.rejects(
    () => runCommunicationBatch({
      db: fatal.db,
      batchId: fatal.batch.id,
      accessController: { async reserve() {} },
      adapter: {
        async inspectCommunicationJob() { fatalInspections += 1; throw fatalError; },
        async dispatchCommunication() {},
        async verifyCommunicationResult() { return { state: "succeeded" }; }
      },
      sleepFn: async () => {}
    }),
    (error) => error === fatalError
  );
  assert.strictEqual(fatalInspections, 1);
  assert.strictEqual(getCommunicationBatch(fatal.db, fatal.batch.id).status, "interrupted");
  assert.deepStrictEqual(listCommunicationBatchItems(fatal.db, fatal.batch.id).map((item) => item.status), ["action_unavailable", "pending"]);
  fatal.close();
}

async function pauseResumeSmoke() {
  const fixture = createFixture(2);
  let inspected = 0;
  const adapter = {
    async inspectCommunicationJob() { inspected += 1; return { state: "ready" }; },
    async dispatchCommunication() {},
    async verifyCommunicationResult() {
      if (inspected === 1) setCommunicationBatchStatus(fixture.db, { batchId: fixture.batch.id, status: "paused" });
      return { state: "succeeded" };
    }
  };
  await runCommunicationBatch({ db: fixture.db, batchId: fixture.batch.id, adapter, accessController: { async reserve() {} }, sleepFn: async () => {} });
  assert.strictEqual(getCommunicationBatch(fixture.db, fixture.batch.id).status, "paused");
  assert.deepStrictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id).map((item) => item.status), ["succeeded", "pending"]);
  await runCommunicationBatch({ db: fixture.db, batchId: fixture.batch.id, adapter, accessController: { async reserve() {} }, sleepFn: async () => {} });
  assert.strictEqual(inspected, 2);
  assert.strictEqual(getCommunicationBatch(fixture.db, fixture.batch.id).status, "completed");
  fixture.close();
}

async function stopDuringSlicedPacingSmoke() {
  const fixture = createFixture(2);
  let inspected = 0;
  const waits = [];
  await runCommunicationBatch({
    db: fixture.db,
    batchId: fixture.batch.id,
    accessController: { async reserve() {} },
    adapter: {
      async inspectCommunicationJob() { inspected += 1; return { state: "ready" }; },
      async dispatchCommunication() {},
      async verifyCommunicationResult() { return { state: "succeeded" }; }
    },
    randomFn: () => 0,
    sleepFn: async (ms) => {
      waits.push(ms);
      setCommunicationBatchStatus(fixture.db, { batchId: fixture.batch.id, status: "stopping" });
    }
  });
  assert.deepStrictEqual(waits, [1000]);
  assert.strictEqual(inspected, 1);
  assert.strictEqual(getCommunicationBatch(fixture.db, fixture.batch.id).status, "stopped");
  assert.deepStrictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id).map((item) => item.status), ["succeeded", "stopped"]);
  fixture.close();
}

async function dispatchFailureSmoke() {
  const fixture = createFixture(2);
  let dispatches = 0;
  const dispatchError = Object.assign(new Error("transport failed"), { code: "BROWSER_DISCONNECTED" });
  await assert.rejects(
    () => runCommunicationBatch({
      db: fixture.db,
      batchId: fixture.batch.id,
      accessController: { async reserve() {} },
      adapter: {
        async inspectCommunicationJob() { return { state: "ready" }; },
        async dispatchCommunication() { dispatches += 1; throw dispatchError; },
        async verifyCommunicationResult() { throw new Error("must not verify"); }
      },
      sleepFn: async () => {}
    }),
    (error) => error === dispatchError
  );
  assert.strictEqual(dispatches, 1);
  assert.strictEqual(getCommunicationBatch(fixture.db, fixture.batch.id).status, "interrupted");
  assert.deepStrictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id).map((item) => item.status), ["ambiguous", "pending"]);
  fixture.close();
}

async function auditSanitizationSmoke() {
  const fixture = createFixture(1);
  await runCommunicationBatch({
    db: fixture.db,
    batchId: fixture.batch.id,
    accessController: { async reserve() {} },
    adapter: {
      async inspectCommunicationJob() { return { state: "ready", resumeContent: "secret resume", token: "secret token" }; },
      async dispatchCommunication() {},
      async verifyCommunicationResult() { return { state: "succeeded", credentials: "secret credentials" }; }
    },
    sleepFn: async () => {}
  });
  const audits = fixture.db.prepare("SELECT job_id, event_type, payload_json FROM events WHERE event_type IN ('communication_click', 'communication_result') ORDER BY id").all();
  assert.deepStrictEqual(audits.map((audit) => audit.event_type), ["communication_click", "communication_result"]);
  for (const audit of audits) {
    const payload = JSON.parse(audit.payload_json);
    assert.strictEqual(payload.batchId, fixture.batch.id);
    assert.strictEqual(payload.jobId, fixture.jobIds[0]);
    assert.strictEqual(payload.itemId, listCommunicationBatchItems(fixture.db, fixture.batch.id)[0].id);
    assert.strictEqual(payload.state, audit.event_type === "communication_click" ? "click_dispatched" : "succeeded");
    assert(!JSON.stringify(payload).includes("secret"));
  }
  fixture.close();
}

function createFixture(count) {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  const profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("Executor smoke", "{}", now, now).lastInsertRowid);
  const planId = Number(db.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(profileId, "Executor smoke", "{}", now, now).lastInsertRowid);
  const scanBatchId = createBatch(db, "boss", "executor-smoke", "executor smoke", { profileId, searchPlanId: planId });
  const jobIds = Array.from({ length: count }, (_, index) => upsertJob(db, job(index + 1), scanBatchId));
  const batch = createCommunicationBatch(db, { planId, jobIds, browserMode: "edge" });
  return { db, profileId, planId, jobIds, batch, close: () => db.close() };
}

function candidateStatuses(fixture) {
  return fixture.jobIds.map((jobId) => fixture.db.prepare("SELECT status FROM candidate_job_states WHERE profile_id = ? AND job_id = ?")
    .get(fixture.profileId, jobId)?.status || "");
}

function job(index) {
  return {
    source: "boss",
    sourceId: `executor-${index}`,
    keyword: "executor-smoke",
    title: `Executor role ${index}`,
    company: `Company ${index}`,
    location: "Guangzhou",
    salary: "10-15K",
    experience: "1-3 years",
    education: "Bachelor",
    bossActiveText: "Active today",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/executor-${index}.html`,
    tags: ["Python"],
    description: "Build Python services.",
    score: 20,
    level: "recommended",
    matches: ["Python"],
    risks: [],
    qualityTags: [],
    analysis: {}
  };
}

Promise.resolve()
  .then(successFlowSmoke)
  .then(alreadyCommunicatedSmoke)
  .then(unavailableAndMismatchContinueSmoke)
  .then(ambiguousAndFatalStopSmoke)
  .then(pauseResumeSmoke)
  .then(stopDuringSlicedPacingSmoke)
  .then(dispatchFailureSmoke)
  .then(auditSanitizationSmoke)
  .then(() => console.log("communication_executor_smoke ok"))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
