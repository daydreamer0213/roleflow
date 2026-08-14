const assert = require("node:assert");
const {
  openDb,
  createBatch,
  upsertJob,
  markCandidateJob,
  createWorkflowRun,
  getWorkflowRun,
  transitionWorkflowRun,
  attachWorkflowCommunication
} = require("../src/core/storage");
const {
  createCommunicationBatch,
  getCommunicationBatch,
  listCommunicationBatchItems,
  resumeInterruptedCommunicationBatch,
  resolveAmbiguousCommunicationItem,
  setCommunicationBatchStatus,
  transitionCommunicationItem
} = require("../src/core/communication_batches");
const { runCommunicationBatch } = require("../src/core/communication_executor");
const { communicate } = require("../src/cli");
const {
  getProgressCardForJob,
  listProgressEvents
} = require("../src/core/candidate_progress");

function runPermittedBatch(input) {
  return runCommunicationBatch({ ...input, executionGate: () => true });
}

async function singleItemCheckpointSmoke() {
  const fixture = createFixture(2);
  const workflow = attachReviewWorkflow(fixture);
  const [first, second] = listCommunicationBatchItems(fixture.db, fixture.batch.id);
  let dispatches = 0;
  const summary = await runPermittedBatch({
    db: fixture.db,
    batchId: fixture.batch.id,
    singleItemId: first.id,
    accessController: { async reserve() {} },
    adapter: {
      async inspectCommunicationJob() { return { state: "ready" }; },
      async dispatchCommunication() { dispatches += 1; },
      async verifyCommunicationResult() { return { state: "succeeded" }; }
    },
    sleepFn: async () => {}
  });
  assert.strictEqual(dispatches, 1);
  assert.deepStrictEqual(
    listCommunicationBatchItems(fixture.db, fixture.batch.id)
      .map((item) => [item.id, item.status, item.clickCount]),
    [[first.id, "succeeded", 1], [second.id, "pending", 0]]
  );
  assert.strictEqual(summary.batchStatus, "interrupted");
  assert.strictEqual(
    getCommunicationBatch(fixture.db, fixture.batch.id).stopCode,
    "COMMUNICATION_SINGLE_ITEM_CHECKPOINT"
  );
  assert.strictEqual(getWorkflowRun(fixture.db, workflow.id).status, "interrupted");
  assert.strictEqual(
    getWorkflowRun(fixture.db, workflow.id).errorCode,
    "COMMUNICATION_SINGLE_ITEM_CHECKPOINT"
  );
  fixture.close();

  const mismatch = createFixture(2);
  const [mismatchFirst, mismatchSecond] = listCommunicationBatchItems(mismatch.db, mismatch.batch.id);
  let reserves = 0;
  let mismatchDispatches = 0;
  await assert.rejects(
    () => runPermittedBatch({
      db: mismatch.db,
      batchId: mismatch.batch.id,
      singleItemId: mismatchSecond.id,
      accessController: { async reserve() { reserves += 1; } },
      adapter: {
        async inspectCommunicationJob() { return { state: "ready" }; },
        async dispatchCommunication() { mismatchDispatches += 1; },
        async verifyCommunicationResult() { return { state: "succeeded" }; }
      },
      sleepFn: async () => {}
    }),
    (error) => error.code === "COMMUNICATION_SINGLE_ITEM_MISMATCH"
  );
  assert.strictEqual(reserves, 0);
  assert.strictEqual(mismatchDispatches, 0);
  assert.deepStrictEqual(
    listCommunicationBatchItems(mismatch.db, mismatch.batch.id)
      .map((item) => [item.id, item.status, item.clickCount]),
    [[mismatchFirst.id, "pending", 0], [mismatchSecond.id, "pending", 0]]
  );
  mismatch.close();

  const targetReached = createFixture(2);
  attachReviewWorkflow(targetReached, { targetSuccessCount: 1 });
  const [targetFirst, targetSecond] = listCommunicationBatchItems(targetReached.db, targetReached.batch.id);
  const targetDispatches = [];
  const targetAdapter = {
    async inspectCommunicationJob(job) { return { state: "ready", jobId: job.id }; },
    async dispatchCommunication(inspection) { targetDispatches.push(inspection.jobId); },
    async verifyCommunicationResult() { return { state: "succeeded" }; }
  };
  await runPermittedBatch({
    db: targetReached.db,
    batchId: targetReached.batch.id,
    singleItemId: targetFirst.id,
    accessController: { async reserve() {} },
    adapter: targetAdapter,
    sleepFn: async () => {}
  });
  resumeInterruptedCommunicationBatch(targetReached.db, { batchId: targetReached.batch.id });
  await runPermittedBatch({
    db: targetReached.db,
    batchId: targetReached.batch.id,
    singleItemId: targetSecond.id,
    accessController: { async reserve() {} },
    adapter: targetAdapter,
    sleepFn: async () => {}
  });
  assert.deepStrictEqual(targetDispatches, targetReached.jobIds);
  assert.deepStrictEqual(
    listCommunicationBatchItems(targetReached.db, targetReached.batch.id)
      .map((item) => [item.status, item.clickCount]),
    [["succeeded", 1], ["succeeded", 1]]
  );
  assert.strictEqual(getCommunicationBatch(targetReached.db, targetReached.batch.id).status, "interrupted");
  assert.strictEqual(getCommunicationBatch(targetReached.db, targetReached.batch.id).stopCode, "COMMUNICATION_SINGLE_ITEM_CHECKPOINT");
  targetReached.close();

  const atomicCheckpoint = createFixture(1);
  const atomicWorkflow = attachReviewWorkflow(atomicCheckpoint, { targetSuccessCount: 1 });
  const atomicItem = listCommunicationBatchItems(atomicCheckpoint.db, atomicCheckpoint.batch.id)[0];
  atomicCheckpoint.db.exec(`CREATE TEMP TRIGGER fail_single_item_workflow_checkpoint
    BEFORE UPDATE OF status ON workflow_runs
    WHEN OLD.id = '${atomicWorkflow.id}' AND NEW.status = 'interrupted'
    BEGIN SELECT RAISE(ABORT, 'forced single-item checkpoint failure'); END`);
  await assert.rejects(
    () => runPermittedBatch({
      db: atomicCheckpoint.db,
      batchId: atomicCheckpoint.batch.id,
      singleItemId: atomicItem.id,
      accessController: { async reserve() {} },
      adapter: {
        async inspectCommunicationJob() { return { state: "ready" }; },
        async dispatchCommunication() {},
        async verifyCommunicationResult() { return { state: "succeeded" }; }
      },
      sleepFn: async () => {}
    }),
    /forced single-item checkpoint failure/
  );
  assert.strictEqual(getCommunicationBatch(atomicCheckpoint.db, atomicCheckpoint.batch.id).status, "running");
  assert.strictEqual(getCommunicationBatch(atomicCheckpoint.db, atomicCheckpoint.batch.id).stopCode, null);
  assert.strictEqual(getWorkflowRun(atomicCheckpoint.db, atomicWorkflow.id).status, "communicating");
  assert.deepStrictEqual(
    listCommunicationBatchItems(atomicCheckpoint.db, atomicCheckpoint.batch.id)
      .map((item) => [item.status, item.clickCount]),
    [["succeeded", 1]]
  );
  atomicCheckpoint.close();
}

async function cliSingleItemPassThroughSmoke() {
  const fixture = createFixture(1);
  const item = listCommunicationBatchItems(fixture.db, fixture.batch.id)[0];
  let receivedSingleItemId = null;
  let restored = 0;
  await communicate(fixture.db, {
    batch: fixture.batch.id,
    browser: "edge",
    "single-item": String(item.id)
  }, {
    createBrowserFn: () => ({
      async listTabs() {
        return [
          { id: 31, windowId: 7, url: "https://www.zhipin.com/web/geek/jobs" },
          { id: 32, windowId: 7, url: "https://www.zhipin.com/web/geek/chat" }
        ];
      }
    }),
    createSiteAdapterFn: () => ({
      async preflight({ tabId }) {
        return tabId === 31
          ? { tabId, url: "https://www.zhipin.com/web/geek/jobs", isSearchPage: true }
          : { tabId, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false };
      },
      async captureCommunicationSearchState() {
        return { url: "https://www.zhipin.com/web/geek/jobs", scrollTop: 0 };
      },
      bindCommunicationTabs() {},
      async beginCommunicationSession() {},
      async restoreCommunicationSearchPage() { restored += 1; }
    }),
    async runCommunicationBatchFn(input) {
      receivedSingleItemId = input.singleItemId;
      return { batchStatus: "interrupted", terminal: 0, total: 1 };
    }
  });
  assert.strictEqual(receivedSingleItemId, item.id);
  assert.strictEqual(restored, 1);
  await assert.rejects(
    () => communicate(fixture.db, {
      batch: fixture.batch.id,
      browser: "edge"
    }, {
      createBrowserFn() { throw new Error("pending acceptance must require a single item before browser creation"); }
    }),
    (error) => error.code === "COMMUNICATION_E2E_SINGLE_ITEM_REQUIRED"
  );
  await assert.rejects(
    () => communicate(fixture.db, {
      batch: fixture.batch.id,
      browser: "edge",
      "single-item": "0"
    }, {
      createBrowserFn() { throw new Error("invalid single item must fail before browser creation"); }
    }),
    (error) => error.code === "COMMUNICATION_SINGLE_ITEM_INVALID"
  );
  fixture.close();

  const fallback = createFixture(1);
  const fallbackWorkflow = attachReviewWorkflow(fallback, { targetSuccessCount: 1 });
  const fallbackItem = listCommunicationBatchItems(fallback.db, fallback.batch.id)[0];
  fallback.db.exec(`CREATE TEMP TRIGGER fail_cli_workflow_interrupt
    BEFORE UPDATE OF status ON workflow_runs
    WHEN OLD.id = '${fallbackWorkflow.id}' AND NEW.status = 'interrupted'
    BEGIN SELECT RAISE(ABORT, 'forced CLI workflow interrupt failure'); END`);
  await assert.rejects(
    () => communicate(fallback.db, {
      batch: fallback.batch.id,
      browser: "edge",
      "single-item": String(fallbackItem.id)
    }, {
      createBrowserFn: () => ({
        async listTabs() {
          return [
            { id: 41, windowId: 8, url: "https://www.zhipin.com/web/geek/jobs" },
            { id: 42, windowId: 8, url: "https://www.zhipin.com/web/geek/chat" }
          ];
        }
      }),
      createSiteAdapterFn: () => ({
        async preflight({ tabId }) {
          return tabId === 41
            ? { tabId, url: "https://www.zhipin.com/web/geek/jobs", isSearchPage: true }
            : { tabId, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false };
        },
        async captureCommunicationSearchState() {
          return { url: "https://www.zhipin.com/web/geek/jobs", scrollTop: 0 };
        },
        bindCommunicationTabs() {},
        async beginCommunicationSession() {},
        async restoreCommunicationSearchPage() {},
        async inspectCommunicationJob() { return { state: "ready" }; },
        async dispatchCommunication() {},
        async verifyCommunicationResult() { return { state: "succeeded" }; }
      })
    }),
    /forced CLI workflow interrupt failure/
  );
  assert.strictEqual(getCommunicationBatch(fallback.db, fallback.batch.id).status, "running");
  assert.strictEqual(getWorkflowRun(fallback.db, fallbackWorkflow.id).status, "communicating");
  assert.deepStrictEqual(
    listCommunicationBatchItems(fallback.db, fallback.batch.id)
      .map((candidate) => [candidate.status, candidate.clickCount]),
    [["succeeded", 1]]
  );
  fallback.close();
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
  assert.deepStrictEqual(candidateStatuses(fixture), ["", ""]);
  for (const jobId of fixture.jobIds) {
    const card = getProgressCardForJob(fixture.db, { profileId: fixture.profileId, jobId });
    assert.strictEqual(card.stage, "waiting_reply");
    assert.deepStrictEqual(listProgressEvents(fixture.db, card.id).map((event) => event.type), ["contact_started"]);
  }
  assert.deepStrictEqual(
    fixture.db.prepare("SELECT payload_json FROM candidate_job_events WHERE event_type = 'applied' ORDER BY id").all()
      .map((event) => JSON.parse(event.payload_json).note),
    []
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
  assert.deepStrictEqual(candidateStatuses(fixture), [""]);
  const card = getProgressCardForJob(fixture.db, {
    profileId: fixture.profileId,
    jobId: fixture.jobIds[0]
  });
  assert.strictEqual(card.stage, "waiting_reply");
  assert.deepStrictEqual(listProgressEvents(fixture.db, card.id).map((event) => event.type), ["contact_already_exists"]);
  fixture.close();
}

async function oneReadOnlyRecoverySmoke() {
  const fixture = createFixture(1);
  let inspections = 0;
  const recoveryCalls = [];
  try {
    await runPermittedBatch({
      db: fixture.db,
      batchId: fixture.batch.id,
      accessController: { async reserve() {} },
      beforeReadOnlyRetry: async ({ item, error, recoveryAttempt }) => {
        recoveryCalls.push({ itemId: item.id, code: error.code, recoveryAttempt });
      },
      adapter: {
        async inspectCommunicationJob() {
          inspections += 1;
          if (inspections === 1) {
            throw Object.assign(new Error("temporary browser timeout"), { code: "BROWSER_TIMEOUT" });
          }
          return { state: "ready" };
        },
        async dispatchCommunication() {},
        async verifyCommunicationResult() { return { state: "succeeded" }; }
      },
      sleepFn: async () => {}
    });
    assert.strictEqual(inspections, 2);
    assert.deepStrictEqual(recoveryCalls, [{
      itemId: listCommunicationBatchItems(fixture.db, fixture.batch.id)[0].id,
      code: "BROWSER_TIMEOUT",
      recoveryAttempt: 1
    }]);
  } finally {
    fixture.close();
  }

  for (const code of ["BOSS_LOGIN_REQUIRED", "BOSS_RISK_CONTROL", "BOSS_OPERATOR_TABS_CHANGED"]) {
    const blocked = createFixture(1);
    let calls = 0;
    let retries = 0;
    const error = Object.assign(new Error(code), { code });
    try {
      await assert.rejects(
        () => runPermittedBatch({
          db: blocked.db,
          batchId: blocked.batch.id,
          accessController: { async reserve() {} },
          beforeReadOnlyRetry: async () => { retries += 1; },
          adapter: {
            async inspectCommunicationJob() { calls += 1; throw error; },
            async dispatchCommunication() {},
            async verifyCommunicationResult() { return { state: "succeeded" }; }
          },
          sleepFn: async () => {}
        }),
        (actual) => actual === error
      );
      assert.strictEqual(calls, 1);
      assert.strictEqual(retries, 0);
    } finally {
      blocked.close();
    }
  }
}

async function unavailableAndMismatchContinueSmoke() {
  const fixture = createFixture(3);
  const inspections = [
    { state: "job_unavailable", statusLabel: "\u505c\u6b62\u62db\u8058" },
    { state: "target_mismatch" },
    { state: "ready" }
  ];
  let inspected = 0;
  await runPermittedBatch({
    db: fixture.db,
    batchId: fixture.batch.id,
    accessController: { async reserve() {} },
    adapter: {
      async inspectCommunicationJob() { return inspections[inspected++]; },
      async dispatchCommunication() {},
      async verifyCommunicationResult() { return { state: "succeeded" }; }
    },
    randomFn: () => 0,
    sleepFn: async () => {}
  });
  const items = listCommunicationBatchItems(fixture.db, fixture.batch.id);
  assert.deepStrictEqual(items.map((item) => item.status), ["job_unavailable", "target_mismatch", "succeeded"]);
  assert.deepStrictEqual(items[0].evidence, {
    inspection: { state: "job_unavailable", statusLabel: "\u505c\u6b62\u62db\u8058" }
  });
  assert.deepStrictEqual(candidateStatuses(fixture), ["invalid", "review", ""]);
  assert.strictEqual(getProgressCardForJob(fixture.db, {
    profileId: fixture.profileId,
    jobId: fixture.jobIds[0]
  }), null);
  assert.strictEqual(getProgressCardForJob(fixture.db, {
    profileId: fixture.profileId,
    jobId: fixture.jobIds[1]
  }), null);
  assert.strictEqual(getProgressCardForJob(fixture.db, {
    profileId: fixture.profileId,
    jobId: fixture.jobIds[2]
  }).stage, "waiting_reply");
  fixture.close();
}

async function atomicProgressFailureSmoke() {
  const fixture = createFixture(1);
  fixture.db.exec(`CREATE TRIGGER fail_progress_event
    BEFORE INSERT ON candidate_progress_events
    BEGIN SELECT RAISE(ABORT, 'forced progress failure'); END`);
  await assert.rejects(
    () => runPermittedBatch({
      db: fixture.db,
      batchId: fixture.batch.id,
      accessController: { async reserve() {} },
      adapter: {
        async inspectCommunicationJob() { return { state: "ready" }; },
        async dispatchCommunication() {},
        async verifyCommunicationResult() { return { state: "succeeded" }; }
      },
      sleepFn: async () => {}
    }),
    /forced progress failure/
  );
  assert.strictEqual(
    listCommunicationBatchItems(fixture.db, fixture.batch.id)[0].status,
    "click_dispatched",
    "communication success must roll back when progress persistence fails"
  );
  assert.strictEqual(
    fixture.db.prepare("SELECT COUNT(*) AS count FROM candidate_progress_cards").get().count,
    0,
    "progress card and success status must commit together"
  );
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

  for (const code of ["COMMUNICATION_ACTION_NOT_TRIGGERED", "COMMUNICATION_USER_ACTION_REQUIRED"]) {
    const diagnostic = createFixture(2);
    const workflow = attachReviewWorkflow(diagnostic);
    let dispatches = 0;
    await assert.rejects(
      () => runPermittedBatch({
        db: diagnostic.db,
        batchId: diagnostic.batch.id,
        accessController: { async reserve() {} },
        adapter: {
          async inspectCommunicationJob() { return { state: "ready" }; },
          async dispatchCommunication() { dispatches += 1; },
          async verifyCommunicationResult() {
            return {
              state: "ambiguous",
              errorCode: code,
              evidence: {
                endpoints: code === "COMMUNICATION_USER_ACTION_REQUIRED"
                  ? Array.from({ length: 20 }, () => ({
                      endpointKind: "chat_config",
                      httpStatus: 200,
                      businessCode: "0",
                      businessCategory: "success",
                      elapsedMs: 7
                    }))
                  : [],
                pageState: code === "COMMUNICATION_ACTION_NOT_TRIGGERED" ? "no_matching_request" : "confirmation_dialog"
              }
            };
          }
        },
        sleepFn: async () => {}
      }),
      (error) => error.code === code
    );
    const items = listCommunicationBatchItems(diagnostic.db, diagnostic.batch.id);
    assert.strictEqual(dispatches, 1);
    assert.deepStrictEqual(items.map((item) => item.status), ["ambiguous", "pending"]);
    assert.deepStrictEqual(items.map((item) => item.clickCount), [1, 0]);
    assert.strictEqual(items[0].errorCode, code);
    assert.strictEqual(getCommunicationBatch(diagnostic.db, diagnostic.batch.id).stopCode, code);
    assert.strictEqual(getWorkflowRun(diagnostic.db, workflow.id).status, "interrupted");
    assert.strictEqual(getWorkflowRun(diagnostic.db, workflow.id).errorCode, code);
    if (code === "COMMUNICATION_USER_ACTION_REQUIRED") {
      assert.strictEqual(items[0].evidence.outcome.pageState, "confirmation_dialog");
      assert.strictEqual(items[0].evidence.outcome.endpoints.length, 12);
    }
    diagnostic.close();
  }

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
  assert.deepStrictEqual(candidateStatuses(fatal), ["later", ""]);
  assert(Date.parse(fatal.db.prepare("SELECT review_at FROM candidate_job_states WHERE profile_id = ? AND job_id = ?")
    .get(fatal.profileId, fatal.jobIds[0]).review_at) > Date.now());
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

async function pausedAmbiguityEntryGuardSmoke() {
  const direct = createFixture(2);
  pauseWithAmbiguousFirstItem(direct);
  const directBefore = getCommunicationBatch(direct.db, direct.batch.id);
  let directReserves = 0;
  let directDispatches = 0;
  let directError;
  try {
    await runPermittedBatch({
      db: direct.db,
      batchId: direct.batch.id,
      accessController: { async reserve() { directReserves += 1; } },
      adapter: {
        async inspectCommunicationJob() { return { state: "ready" }; },
        async dispatchCommunication() { directDispatches += 1; },
        async verifyCommunicationResult() { return { state: "succeeded" }; }
      },
      sleepFn: async () => {}
    });
  } catch (error) {
    directError = error;
  }

  const cli = createFixture(2);
  pauseWithAmbiguousFirstItem(cli);
  const cliBefore = getCommunicationBatch(cli.db, cli.batch.id);
  let cliDispatches = 0;
  let cliError;
  try {
    await communicate(cli.db, { batch: cli.batch.id, browser: "edge" }, {
      createBrowserFn: () => ({
        async listTabs() {
          return [
            { id: 31, windowId: 7, url: "https://www.zhipin.com/web/geek/jobs" },
            { id: 32, windowId: 7, url: "https://www.zhipin.com/web/geek/chat" }
          ];
        }
      }),
      createSiteAdapterFn: () => ({
        async preflight({ tabId }) {
          return tabId === 31
            ? { tabId, url: "https://www.zhipin.com/web/geek/jobs", isSearchPage: true }
            : { tabId, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false };
        },
        bindCommunicationTabs() {},
        async prepareCommunicationTab() { return 32; },
        async inspectCommunicationJob() { return { state: "ready" }; },
        async dispatchCommunication() { cliDispatches += 1; },
        async verifyCommunicationResult() { return { state: "succeeded" }; }
      })
    });
  } catch (error) {
    cliError = error;
  }

  assert.strictEqual(directError?.code, "COMMUNICATION_RESUME_REQUIRES_REVIEW");
  assert.strictEqual(cliError?.code, "COMMUNICATION_RESUME_REQUIRES_REVIEW");
  assert.deepStrictEqual(getCommunicationBatch(direct.db, direct.batch.id), directBefore);
  assert.deepStrictEqual(getCommunicationBatch(cli.db, cli.batch.id), cliBefore);
  assert.strictEqual(directReserves, 0);
  assert.strictEqual(directDispatches, 0);
  assert.strictEqual(cliDispatches, 0);
  assert.deepStrictEqual(listCommunicationBatchItems(direct.db, direct.batch.id).map((item) => item.status), ["ambiguous", "pending"]);
  assert.deepStrictEqual(listCommunicationBatchItems(cli.db, cli.batch.id).map((item) => item.status), ["ambiguous", "pending"]);
  direct.close();
  cli.close();
}

async function ambiguityDriftEntryGuardSmoke() {
  for (const [drift, action] of [
    ["summary-only", "start"],
    ["summary-only", "resume"],
    ["item-only", "start"],
    ["item-only", "resume"]
  ]) {
    const fixture = createFixture(2);
    if (action === "resume") {
      setCommunicationBatchStatus(fixture.db, { batchId: fixture.batch.id, status: "running" });
      setCommunicationBatchStatus(fixture.db, { batchId: fixture.batch.id, status: "paused" });
    }
    const beforeBatch = getCommunicationBatch(fixture.db, fixture.batch.id);
    const beforeItems = listCommunicationBatchItems(fixture.db, fixture.batch.id);
    let reserves = 0;
    let dispatches = 0;
    let caught;
    try {
      await runPermittedBatch({
        db: fixture.db,
        batchId: fixture.batch.id,
        ambiguityReader: () => drift === "summary-only"
          ? { blocked: true, summaryCount: 1, itemsCount: 0, countsMismatch: true, firstItemId: null }
          : { blocked: true, summaryCount: 0, itemsCount: 1, countsMismatch: true, firstItemId: beforeItems[0].id },
        accessController: { async reserve() { reserves += 1; } },
        adapter: {
          async inspectCommunicationJob() { return { state: "ready" }; },
          async dispatchCommunication() { dispatches += 1; },
          async verifyCommunicationResult() { return { state: "succeeded" }; }
        },
        sleepFn: async () => {}
      });
    } catch (error) {
      caught = error;
    }
    assert.strictEqual(caught?.code, "COMMUNICATION_RESUME_REQUIRES_REVIEW", `${action} must block ${drift} drift`);
    assert.deepStrictEqual(getCommunicationBatch(fixture.db, fixture.batch.id), beforeBatch);
    assert.deepStrictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id), beforeItems);
    assert.strictEqual(reserves, 0);
    assert.strictEqual(dispatches, 0);
    fixture.close();
  }
}

async function runningAmbiguityEntryGuardSmoke() {
  const fixture = createFixture(2);
  const workflow = attachReviewWorkflow(fixture);
  setCommunicationBatchStatus(fixture.db, { batchId: fixture.batch.id, status: "running" });
  const first = listCommunicationBatchItems(fixture.db, fixture.batch.id)[0];
  transitionCommunicationItem(fixture.db, { itemId: first.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(fixture.db, { itemId: first.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(fixture.db, {
    itemId: first.id,
    expectedStatus: "verified",
    status: "click_dispatched",
    audit: clickAudit(first)
  });
  transitionCommunicationItem(fixture.db, { itemId: first.id, expectedStatus: "click_dispatched", status: "ambiguous" });
  const workflowBefore = getWorkflowRun(fixture.db, workflow.id);
  const batchBefore = getCommunicationBatch(fixture.db, fixture.batch.id);
  const itemsBefore = listCommunicationBatchItems(fixture.db, fixture.batch.id);
  let reserves = 0;
  let inspections = 0;
  let dispatches = 0;
  let caught;
  try {
    await runPermittedBatch({
      db: fixture.db,
      batchId: fixture.batch.id,
      accessController: { async reserve() { reserves += 1; } },
      adapter: {
        async inspectCommunicationJob() { inspections += 1; return { state: "ready" }; },
        async dispatchCommunication() { dispatches += 1; },
        async verifyCommunicationResult() { return { state: "succeeded" }; }
      },
      sleepFn: async () => {}
    });
  } catch (error) {
    caught = error;
  }
  assert.strictEqual(caught?.code, "COMMUNICATION_RESUME_REQUIRES_REVIEW");
  assert.deepStrictEqual(getWorkflowRun(fixture.db, workflow.id), workflowBefore);
  assert.deepStrictEqual(getCommunicationBatch(fixture.db, fixture.batch.id), batchBefore);
  assert.deepStrictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id), itemsBefore);
  assert.strictEqual(reserves, 0);
  assert.strictEqual(inspections, 0);
  assert.strictEqual(dispatches, 0);
  fixture.close();
}

async function postClaimAmbiguityRollbackSmoke() {
  const fixture = createFixture(2);
  setCommunicationBatchStatus(fixture.db, { batchId: fixture.batch.id, status: "running" });
  const batchBefore = getCommunicationBatch(fixture.db, fixture.batch.id);
  const itemsBefore = listCommunicationBatchItems(fixture.db, fixture.batch.id);
  let ambiguityReads = 0;
  let reserves = 0;
  let dispatches = 0;
  let caught;
  try {
    await runPermittedBatch({
      db: fixture.db,
      batchId: fixture.batch.id,
      ambiguityReader() {
        ambiguityReads += 1;
        return ambiguityReads < 3
          ? { blocked: false, summaryCount: 0, itemsCount: 0, countsMismatch: false, firstItemId: null }
          : { blocked: true, summaryCount: 1, itemsCount: 0, countsMismatch: true, firstItemId: null };
      },
      accessController: { async reserve() { reserves += 1; } },
      adapter: {
        async inspectCommunicationJob() { return { state: "ready" }; },
        async dispatchCommunication() { dispatches += 1; },
        async verifyCommunicationResult() { return { state: "succeeded" }; }
      },
      sleepFn: async () => {}
    });
  } catch (error) {
    caught = error;
  }
  assert.strictEqual(caught?.code, "COMMUNICATION_RESUME_REQUIRES_REVIEW");
  assert.strictEqual(ambiguityReads, 3);
  assert.deepStrictEqual(getCommunicationBatch(fixture.db, fixture.batch.id), batchBefore);
  assert.deepStrictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id), itemsBefore);
  assert.strictEqual(listCommunicationBatchItems(fixture.db, fixture.batch.id)[0].status, "pending");
  assert.strictEqual(reserves, 0);
  assert.strictEqual(dispatches, 0);
  fixture.close();
}

async function ambiguityAfterReserveGuardSmoke() {
  const fixture = createFixture(2);
  const workflow = attachReviewWorkflow(fixture);
  setCommunicationBatchStatus(fixture.db, { batchId: fixture.batch.id, status: "running" });
  const [ambiguousItem, reservedItem] = listCommunicationBatchItems(fixture.db, fixture.batch.id);
  transitionCommunicationItem(fixture.db, { itemId: ambiguousItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(fixture.db, { itemId: ambiguousItem.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(fixture.db, {
    itemId: ambiguousItem.id,
    expectedStatus: "verified",
    status: "click_dispatched",
    audit: clickAudit(ambiguousItem)
  });
  transitionCommunicationItem(fixture.db, {
    itemId: ambiguousItem.id,
    expectedStatus: "click_dispatched",
    status: "ambiguous"
  });
  const clickCountsBefore = listCommunicationBatchItems(fixture.db, fixture.batch.id).map((item) => item.clickCount);
  let blocked = false;
  let reserves = 0;
  let inspections = 0;
  let dispatches = 0;
  let caught;
  try {
    await runPermittedBatch({
      db: fixture.db,
      batchId: fixture.batch.id,
      ambiguityReader() {
        return blocked
          ? { blocked: true, summaryCount: 1, itemsCount: 0, countsMismatch: true, firstItemId: null }
          : { blocked: false, summaryCount: 0, itemsCount: 0, countsMismatch: false, firstItemId: null };
      },
      accessController: {
        async reserve() {
          reserves += 1;
          blocked = true;
        }
      },
      adapter: {
        async inspectCommunicationJob() { inspections += 1; return { state: "ready" }; },
        async dispatchCommunication() { dispatches += 1; },
        async verifyCommunicationResult() { return { state: "succeeded" }; }
      },
      sleepFn: async () => {}
    });
  } catch (error) {
    caught = error;
  }
  const interruptedItems = listCommunicationBatchItems(fixture.db, fixture.batch.id);
  assert.strictEqual(caught?.code, "COMMUNICATION_RESUME_REQUIRES_REVIEW");
  assert.strictEqual(reserves, 1);
  assert.strictEqual(inspections, 0);
  assert.strictEqual(dispatches, 0);
  assert.strictEqual(getCommunicationBatch(fixture.db, fixture.batch.id).status, "interrupted");
  assert.strictEqual(getWorkflowRun(fixture.db, workflow.id).status, "interrupted");
  assert.deepStrictEqual(interruptedItems.map((item) => item.status), ["ambiguous", "pending"]);
  assert.deepStrictEqual(interruptedItems.map((item) => item.clickCount), clickCountsBefore);
  assert.strictEqual(interruptedItems.find((item) => item.id === reservedItem.id).clickCount, 0);

  resolveAmbiguousCommunicationItem(fixture.db, {
    itemId: ambiguousItem.id,
    status: "stopped",
    evidenceNote: "Manual review confirmed no additional communication was sent."
  });
  const resumed = resumeInterruptedCommunicationBatch(fixture.db, { batchId: fixture.batch.id });
  assert.strictEqual(resumed.requiresReview, false);
  assert.strictEqual(resumed.batch.status, "running");
  assert.deepStrictEqual(
    listCommunicationBatchItems(fixture.db, fixture.batch.id).map((item) => item.status),
    ["stopped", "pending"]
  );
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

async function observedOutcomeFailureSmoke() {
  const fixture = createFixture(2);
  let dispatches = 0;
  const results = [
    {
      state: "platform_rejected",
      evidence: {
        endpoints: [{
          endpointKind: "friend_add",
          httpStatus: 403,
          businessCode: "10003",
          businessCategory: "business_rejected",
          elapsedMs: 44,
          url: "https://www.zhipin.com/wapi/zpgeek/friend/add.json?securityId=secret-security",
          responseBody: "private BOSS response"
        }],
        pageState: "request_rejected",
        chatIdentity: "secret-chat"
      }
    },
    {
      state: "transport_failed",
      evidence: {
        endpoints: [{ endpointKind: "friend_add", businessCategory: "network_rejected", elapsedMs: 17 }],
        pageState: "request_failed"
      }
    }
  ];
  await runPermittedBatch({
    db: fixture.db,
    batchId: fixture.batch.id,
    accessController: { async reserve() {} },
    adapter: {
      async inspectCommunicationJob() { return { state: "ready" }; },
      async dispatchCommunication() { dispatches += 1; },
      async verifyCommunicationResult() { return results.shift(); }
    },
    sleepFn: async () => {}
  });
  const items = listCommunicationBatchItems(fixture.db, fixture.batch.id);
  assert.deepStrictEqual(items.map((item) => item.status), ["platform_rejected", "transport_failed"]);
  assert.deepStrictEqual(items.map((item) => item.clickCount), [1, 1]);
  assert.deepStrictEqual(items[0].evidence, {
    outcome: {
      endpoints: [{ endpointKind: "friend_add", httpStatus: 403, businessCode: "10003", businessCategory: "business_rejected", elapsedMs: 44 }],
      pageState: "request_rejected"
    }
  });
  assert.strictEqual(items[0].errorMessage, "BOSS rejected the communication request.");
  assert.strictEqual(items[1].errorMessage, "The communication request did not reach BOSS.");
  const persisted = fixture.db.prepare("SELECT evidence_json, error_message FROM communication_batch_items ORDER BY position").all();
  assert(!JSON.stringify(persisted).includes("secret-security"));
  assert(!JSON.stringify(persisted).includes("private BOSS response"));
  assert(!JSON.stringify(persisted).includes("secret-chat"));
  await runPermittedBatch({
    db: fixture.db,
    batchId: fixture.batch.id,
    accessController: { async reserve() { throw new Error("terminal items must not reserve again"); } },
    adapter: {
      async inspectCommunicationJob() { throw new Error("terminal items must not inspect again"); },
      async dispatchCommunication() { dispatches += 1; },
      async verifyCommunicationResult() { throw new Error("terminal items must not verify again"); }
    },
    sleepFn: async () => {}
  });
  assert.strictEqual(dispatches, 2, "an explicit failed result must not dispatch a second click");
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

function pauseWithAmbiguousFirstItem(fixture) {
  const first = listCommunicationBatchItems(fixture.db, fixture.batch.id)[0];
  setCommunicationBatchStatus(fixture.db, { batchId: fixture.batch.id, status: "running" });
  transitionCommunicationItem(fixture.db, { itemId: first.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(fixture.db, { itemId: first.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(fixture.db, { itemId: first.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(first) });
  transitionCommunicationItem(fixture.db, { itemId: first.id, expectedStatus: "click_dispatched", status: "ambiguous" });
  setCommunicationBatchStatus(fixture.db, { batchId: fixture.batch.id, status: "paused" });
}

function attachReviewWorkflow(fixture, { targetSuccessCount = 2 } = {}) {
  const workflow = createWorkflowRun(fixture.db, {
    profileId: fixture.profileId,
    planId: fixture.planId,
    localDay: "2026-08-11",
    sequence: 1,
    targetSuccessCount,
    inventoryCount: 2,
    candidateGap: 0,
    scanNeeded: false,
    planner: { browserMode: "edge" }
  });
  transitionWorkflowRun(fixture.db, { id: workflow.id, status: "review_required" });
  return attachWorkflowCommunication(fixture.db, {
    id: workflow.id,
    communicationBatchId: fixture.batch.id
  });
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
    analysis: {
      semanticStatus: "complete",
      recommendation: "primary",
      recommendationSchemaVersion: 2,
      fitLevel: "fit",
      hardBlockers: []
    }
  };
}

Promise.resolve()
  .then(singleItemCheckpointSmoke)
  .then(cliSingleItemPassThroughSmoke)
  .then(successFlowSmoke)
  .then(atomicProgressFailureSmoke)
  .then(alreadyCommunicatedSmoke)
  .then(oneReadOnlyRecoverySmoke)
  .then(unavailableAndMismatchContinueSmoke)
  .then(ambiguousAndFatalStopSmoke)
  .then(pauseResumeSmoke)
  .then(pausedAmbiguityEntryGuardSmoke)
  .then(ambiguityDriftEntryGuardSmoke)
  .then(ambiguityAfterReserveGuardSmoke)
  .then(runningAmbiguityEntryGuardSmoke)
  .then(postClaimAmbiguityRollbackSmoke)
  .then(stopDuringSlicedPacingSmoke)
  .then(dispatchFailureSmoke)
  .then(observedOutcomeFailureSmoke)
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
