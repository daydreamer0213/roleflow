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
  setCommunicationBatchStatus,
  transitionCommunicationItem
} = require("../src/core/communication_batches");
const { runCommunicationBatch } = require("../src/core/communication_executor");

function runPermittedBatch(input) {
  return runCommunicationBatch({ ...input, executionGate: () => true });
}

async function successFlowSmoke() {
  const fixture = createFixture(2);
  const calls = [];
  const adapter = {
    async inspectCommunicationJob() { calls.push("inspect"); return { state: "ready" }; },
    async dispatchCommunication() { calls.push("dispatch"); },
    async verifyCommunicationResult() { calls.push("verify"); return { state: "succeeded" }; }
  };
  const accessController = { async reserve() { calls.push("reserve"); } };
  const summary = await runPermittedBatch({
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
  assert.deepStrictEqual(
    fixture.db.prepare("SELECT payload_json FROM candidate_job_events WHERE event_type = 'applied' ORDER BY id").all()
      .map((event) => JSON.parse(event.payload_json).note),
    [`RoleFlow batch #${fixture.batch.id}`, `RoleFlow batch #${fixture.batch.id}`]
  );
  fixture.close();
}

async function alreadyCommunicatedSmoke() {
  const fixture = createFixture(1);
  let dispatches = 0;
  await runPermittedBatch({
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
  await runPermittedBatch({
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
    () => runPermittedBatch({
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
    () => runPermittedBatch({
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
  await runPermittedBatch({ db: fixture.db, batchId: fixture.batch.id, adapter, accessController: { async reserve() {} }, sleepFn: async () => {} });
  assert.strictEqual(getCommunicationBatch(fixture.db, fixture.batch.id).status, "paused");
  assert.deepStrictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id).map((item) => item.status), ["succeeded", "pending"]);
  await runPermittedBatch({ db: fixture.db, batchId: fixture.batch.id, adapter, accessController: { async reserve() {} }, sleepFn: async () => {} });
  assert.strictEqual(inspected, 2);
  assert.strictEqual(getCommunicationBatch(fixture.db, fixture.batch.id).status, "completed");
  fixture.close();
}

async function stopDuringSlicedPacingSmoke() {
  const fixture = createFixture(2);
  let inspected = 0;
  const waits = [];
  await runPermittedBatch({
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
    () => runPermittedBatch({
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
  await runPermittedBatch({
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

async function claimBeforeReserveSmoke() {
  const fixture = createFixture(2);
  let firstReserves = 0;
  let secondReserves = 0;
  let inspections = 0;
  let releaseReserve;
  const reserveStarted = new Promise((resolve) => { releaseReserve = resolve; });
  let unblockReserve;
  const reserveBlocked = new Promise((resolve) => { unblockReserve = resolve; });
  const first = runPermittedBatch({
    db: fixture.db,
    batchId: fixture.batch.id,
    accessController: {
      async reserve() {
        firstReserves += 1;
        releaseReserve();
        await reserveBlocked;
      }
    },
    adapter: {
      async inspectCommunicationJob() { inspections += 1; return { state: "ready" }; },
      async dispatchCommunication() {},
      async verifyCommunicationResult() { return { state: "succeeded" }; }
    },
    sleepFn: async () => {}
  });
  await reserveStarted;
  assert.strictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id)[0].status, "opening");
  await assert.rejects(
    () => runPermittedBatch({
      db: fixture.db,
      batchId: fixture.batch.id,
      accessController: { async reserve() { secondReserves += 1; } },
      adapter: {
        async inspectCommunicationJob() { inspections += 1; return { state: "ready" }; },
        async dispatchCommunication() {},
        async verifyCommunicationResult() { return { state: "succeeded" }; }
      },
      sleepFn: async () => {}
    }),
    (error) => error.code === "COMMUNICATION_RESUME_REQUIRES_REVIEW"
  );
  unblockReserve();
  await first;
  assert.strictEqual(firstReserves, 1);
  assert.strictEqual(secondReserves, 0);
  assert.strictEqual(inspections, 0);
  assert.deepStrictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id).map((item) => item.status), ["stopped", "pending"]);
  fixture.close();
}

async function incompleteRecoverySmoke() {
  for (const status of ["opening", "verified", "click_dispatched"]) {
    const fixture = createFixture(2);
    const first = listCommunicationBatchItems(fixture.db, fixture.batch.id)[0];
    if (status !== "opening") transitionCommunicationItem(fixture.db, { itemId: first.id, expectedStatus: "pending", status: "opening" });
    if (status === "verified" || status === "click_dispatched") {
      transitionCommunicationItem(fixture.db, { itemId: first.id, expectedStatus: "opening", status: "verified" });
    }
    if (status === "click_dispatched") {
      transitionCommunicationItem(fixture.db, { itemId: first.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(first) });
    }
    if (status === "opening") transitionCommunicationItem(fixture.db, { itemId: first.id, expectedStatus: "pending", status: "opening" });
    let reserves = 0;
    await assert.rejects(
      () => runPermittedBatch({
        db: fixture.db,
        batchId: fixture.batch.id,
        accessController: { async reserve() { reserves += 1; } },
        adapter: { async inspectCommunicationJob() {}, async dispatchCommunication() {}, async verifyCommunicationResult() {} },
        sleepFn: async () => {}
      }),
      (error) => error.code === "COMMUNICATION_RESUME_REQUIRES_REVIEW"
    );
    assert.strictEqual(reserves, 0);
    assert.strictEqual(getCommunicationBatch(fixture.db, fixture.batch.id).status, "interrupted");
    assert.strictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id)[0].status, status === "click_dispatched" ? "ambiguous" : "stopped");
    assert.strictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id)[1].status, "pending");
    fixture.close();
  }
}

async function controlBeforeDispatchSmoke() {
  const fixture = createFixture(2);
  let dispatches = 0;
  await runPermittedBatch({
    db: fixture.db,
    batchId: fixture.batch.id,
    accessController: { async reserve() {} },
    adapter: {
      async inspectCommunicationJob() {
        setCommunicationBatchStatus(fixture.db, { batchId: fixture.batch.id, status: "paused" });
        return { state: "ready" };
      },
      async dispatchCommunication() { dispatches += 1; },
      async verifyCommunicationResult() { return { state: "succeeded" }; }
    },
    sleepFn: async () => {}
  });
  assert.strictEqual(dispatches, 0);
  assert.strictEqual(getCommunicationBatch(fixture.db, fixture.batch.id).status, "paused");
  assert.deepStrictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id).map((item) => item.status), ["opening", "pending"]);
  fixture.close();
}

async function controlAfterReserveAndInspectFailureSmoke() {
  const afterReserve = createFixture(2);
  let inspections = 0;
  await runPermittedBatch({
    db: afterReserve.db,
    batchId: afterReserve.batch.id,
    accessController: {
      async reserve() { setCommunicationBatchStatus(afterReserve.db, { batchId: afterReserve.batch.id, status: "stopping" }); }
    },
    adapter: {
      async inspectCommunicationJob() { inspections += 1; return { state: "ready" }; },
      async dispatchCommunication() {},
      async verifyCommunicationResult() { return { state: "succeeded" }; }
    },
    sleepFn: async () => {}
  });
  assert.strictEqual(inspections, 0);
  assert.deepStrictEqual(listCommunicationBatchItems(afterReserve.db, afterReserve.batch.id).map((item) => item.status), ["stopped", "stopped"]);
  afterReserve.close();

  const afterInspectFailure = createFixture(2);
  await runPermittedBatch({
    db: afterInspectFailure.db,
    batchId: afterInspectFailure.batch.id,
    accessController: { async reserve() {} },
    adapter: {
      async inspectCommunicationJob() {
        setCommunicationBatchStatus(afterInspectFailure.db, { batchId: afterInspectFailure.batch.id, status: "stopping" });
        throw new Error("inspection ended during stop");
      },
      async dispatchCommunication() {},
      async verifyCommunicationResult() { return { state: "succeeded" }; }
    },
    sleepFn: async () => {}
  });
  assert.deepStrictEqual(listCommunicationBatchItems(afterInspectFailure.db, afterInspectFailure.batch.id).map((item) => item.status), ["stopped", "stopped"]);
  afterInspectFailure.close();
}

async function stoppingSafetySmoke() {
  const fixture = createFixture(4);
  const [, opening, verified, dispatched] = listCommunicationBatchItems(fixture.db, fixture.batch.id);
  transitionCommunicationItem(fixture.db, { itemId: opening.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(fixture.db, { itemId: verified.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(fixture.db, { itemId: verified.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(fixture.db, { itemId: dispatched.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(fixture.db, { itemId: dispatched.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(fixture.db, { itemId: dispatched.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(dispatched) });
  setCommunicationBatchStatus(fixture.db, { batchId: fixture.batch.id, status: "running" });
  setCommunicationBatchStatus(fixture.db, { batchId: fixture.batch.id, status: "stopping" });
  await runPermittedBatch({
    db: fixture.db,
    batchId: fixture.batch.id,
    accessController: { async reserve() { throw new Error("must not reserve"); } },
    adapter: { async inspectCommunicationJob() {}, async dispatchCommunication() {}, async verifyCommunicationResult() {} },
    sleepFn: async () => {}
  });
  assert.strictEqual(getCommunicationBatch(fixture.db, fixture.batch.id).status, "stopped");
  assert.deepStrictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id).map((item) => item.status), ["stopped", "stopped", "stopped", "ambiguous"]);
  fixture.close();
}

async function cooldownAbortAndUpperBoundSmoke() {
  const aborted = createFixture(2);
  const abortController = new AbortController();
  const abortError = Object.assign(new Error("cooldown aborted"), { code: "COMMUNICATION_ABORTED" });
  await assert.rejects(
    () => runPermittedBatch({
      db: aborted.db,
      batchId: aborted.batch.id,
      accessController: { async reserve() {} },
      adapter: {
        async inspectCommunicationJob() { return { state: "ready" }; },
        async dispatchCommunication() {},
        async verifyCommunicationResult() { return { state: "succeeded" }; }
      },
      signal: abortController.signal,
      sleepFn: async () => {
        abortController.abort(abortError);
        throw abortError;
      }
    }),
    (error) => error === abortError
  );
  assert.strictEqual(getCommunicationBatch(aborted.db, aborted.batch.id).status, "interrupted");
  aborted.close();

  const bounded = createFixture(2);
  const waits = [];
  await runPermittedBatch({
    db: bounded.db,
    batchId: bounded.batch.id,
    accessController: { async reserve() {} },
    adapter: {
      async inspectCommunicationJob() { return { state: "ready" }; },
      async dispatchCommunication() {},
      async verifyCommunicationResult() { return { state: "succeeded" }; }
    },
    randomFn: () => 1,
    sleepFn: async (ms) => waits.push(ms)
  });
  assert.strictEqual(waits.reduce((sum, ms) => sum + ms, 0), 20_000);
  assert(waits.every((ms) => ms <= 1000));
  bounded.close();
}

async function calibrationGateSmoke() {
  const enabledAtEntry = createFixture(1);
  let entryInspections = 0;
  await runCommunicationBatch({
    db: enabledAtEntry.db,
    batchId: enabledAtEntry.batch.id,
    accessController: { async reserve() {} },
    adapter: {
      async inspectCommunicationJob() { entryInspections += 1; return { state: "ready" }; },
      async dispatchCommunication() {},
      async verifyCommunicationResult() { return { state: "succeeded" }; }
    }
  });
  assert.strictEqual(entryInspections, 1);
  assert.strictEqual(getCommunicationBatch(enabledAtEntry.db, enabledAtEntry.batch.id).status, "completed");
  assert.strictEqual(listCommunicationBatchItems(enabledAtEntry.db, enabledAtEntry.batch.id)[0].status, "succeeded");
  enabledAtEntry.close();

  const closedBeforeDispatch = createFixture(1);
  const gateError = Object.assign(new Error("calibration revoked"), { code: "BOSS_COMMUNICATION_CALIBRATION_REQUIRED" });
  let gateCalls = 0;
  let dispatches = 0;
  await assert.rejects(
    () => runCommunicationBatch({
      db: closedBeforeDispatch.db,
      batchId: closedBeforeDispatch.batch.id,
      executionGate() {
        gateCalls += 1;
        if (gateCalls === 2) throw gateError;
        return true;
      },
      accessController: { async reserve() {} },
      adapter: {
        async inspectCommunicationJob() { return { state: "ready" }; },
        async dispatchCommunication() { dispatches += 1; },
        async verifyCommunicationResult() { return { state: "succeeded" }; }
      }
    }),
    (error) => error === gateError
  );
  assert.strictEqual(gateCalls, 2);
  assert.strictEqual(dispatches, 0);
  assert.strictEqual(getCommunicationBatch(closedBeforeDispatch.db, closedBeforeDispatch.batch.id).status, "interrupted");
  assert.strictEqual(listCommunicationBatchItems(closedBeforeDispatch.db, closedBeforeDispatch.batch.id)[0].status, "stopped");
  closedBeforeDispatch.close();
}

async function reserveFailureRollbackSmoke() {
  const fixture = createFixture(1);
  const reserveError = Object.assign(new Error("daily budget exhausted"), { code: "BOSS_ACCESS_BUDGET_EXHAUSTED" });
  let inspections = 0;
  const adapter = {
    async inspectCommunicationJob() { inspections += 1; return { state: "ready" }; },
    async dispatchCommunication() {},
    async verifyCommunicationResult() { return { state: "succeeded" }; }
  };
  await assert.rejects(
    () => runPermittedBatch({
      db: fixture.db,
      batchId: fixture.batch.id,
      accessController: { async reserve() { throw reserveError; } },
      adapter
    }),
    (error) => error === reserveError
  );
  assert.strictEqual(inspections, 0);
  assert.strictEqual(getCommunicationBatch(fixture.db, fixture.batch.id).status, "paused");
  assert.strictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id)[0].status, "pending");

  await runPermittedBatch({
    db: fixture.db,
    batchId: fixture.batch.id,
    accessController: { async reserve() {} },
    adapter,
    sleepFn: async () => {}
  });
  assert.strictEqual(inspections, 1);
  assert.strictEqual(getCommunicationBatch(fixture.db, fixture.batch.id).status, "completed");
  fixture.close();
}

function clickAudit(item) {
  return {
    eventType: "communication_click",
    payload: { batchId: item.batchId, itemId: item.id, jobId: item.jobId, state: "click_dispatched" }
  };
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
  .then(claimBeforeReserveSmoke)
  .then(incompleteRecoverySmoke)
  .then(controlBeforeDispatchSmoke)
  .then(controlAfterReserveAndInspectFailureSmoke)
  .then(stoppingSafetySmoke)
  .then(cooldownAbortAndUpperBoundSmoke)
  .then(calibrationGateSmoke)
  .then(reserveFailureRollbackSmoke)
  .then(() => console.log("communication_executor_smoke ok"))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
