const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const COMMUNICATION_EXPORTS = [
  "BATCH_STATUSES", "ITEM_STATUSES", "TERMINAL_ITEM_STATUSES",
  "createCommunicationBatch", "getCommunicationBatch", "touchCommunicationBatch",
  "listCommunicationBatchItems", "setCommunicationBatchStatus",
  "resumeInterruptedCommunicationBatch", "pauseCommunicationBatchAfterReservationFailure",
  "transitionCommunicationItem", "resolveAmbiguousCommunicationItem",
  "communicationBatchSummary", "communicationQuotaSnapshot"
].sort();

const warnings = [];
const onWarning = (warning) => warnings.push(warning);
process.on("warning", onWarning);
const store = require("../src/storage/communication_store");
const coreFacade = require("../src/core/communication_batches");
const storage = require("../src/core/storage");
const candidateStore = require("../src/storage/candidate_store");
const jobStore = require("../src/storage/job_store");
const scanStore = require("../src/storage/scan_store");
const sharedStore = require("../src/storage/storage_shared");
const { communicationCalibrationStatus } = require("../src/core/communication_calibration");
process.removeListener("warning", onWarning);

assert.deepStrictEqual(Object.keys(store).sort(), COMMUNICATION_EXPORTS);
assert.strictEqual(coreFacade, store, "core compatibility facade must export the store object itself");
for (const name of COMMUNICATION_EXPORTS) assert.strictEqual(coreFacade[name], store[name], `${name} must keep its direct reference`);
assert.strictEqual(Object.keys(storage).length, 136);
assert.strictEqual(Object.keys(candidateStore).length, 29);
assert.strictEqual(Object.keys(jobStore).length, 26);
assert.strictEqual(Object.keys(scanStore).length, 35);
assert.strictEqual(Object.keys(sharedStore).length, 8);
assert.strictEqual(storage.getSearchPlan, candidateStore.getSearchPlan);
assert.strictEqual(storage.listDecisionPool, jobStore.listDecisionPool);
assert.strictEqual(storage.listSiteAccessEvents, scanStore.listSiteAccessEvents);
assert.strictEqual(warnings.filter((warning) => /circular/i.test(warning.message)).length, 0);

const {
  openDb,
  createBatch,
  upsertJob,
  markCandidateJob,
  recordSiteAccessEvent
} = storage;
const {
  createCommunicationBatch,
  getCommunicationBatch,
  touchCommunicationBatch,
  listCommunicationBatchItems,
  setCommunicationBatchStatus,
  resumeInterruptedCommunicationBatch,
  pauseCommunicationBatchAfterReservationFailure,
  transitionCommunicationItem,
  resolveAmbiguousCommunicationItem,
  communicationBatchSummary,
  communicationQuotaSnapshot
} = store;

runOwnerContract();
runQuotaContract();
runCoreConsumerChildren();
console.log("communication_store_contract_smoke ok");

function runOwnerContract() {
  const db = openDb(":memory:");
  try {
    const seeded = seed(db, "owner");
    const calibrationSnapshot = communicationCalibrationStatus();
    const baseline = tableSnapshot(db);
    const originalExec = db.exec.bind(db);
    let commitFailed = false;
    db.exec = (sql) => {
      if (String(sql) === "COMMIT" && !commitFailed) {
        commitFailed = true;
        throw new Error("late communication commit failure");
      }
      return originalExec(sql);
    };
    try {
      assert.throws(
        () => createCommunicationBatch(db, { planId: seeded.planId, jobIds: [seeded.ids[0]], browserMode: "edge" }),
        /late communication commit failure/
      );
    } finally {
      db.exec = originalExec;
    }
    assert.deepStrictEqual(tableSnapshot(db), baseline, "late create failure must rollback every table");

    const creation = observeTransactions(db, () => createCommunicationBatch(db, {
      planId: seeded.planId,
      jobIds: seeded.ids.slice(0, 8),
      browserMode: "portable",
      policySnapshot: { delayMs: [15000, 20000], calibration: calibrationSnapshot },
      now: "2030-01-02T08:00:00.000Z"
    }));
    assert.deepStrictEqual(creation.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
    const batch = creation.value;
    assert.deepStrictEqual(batch.policySnapshot, {
      delayMs: [15000, 20000],
      calibration: calibrationSnapshot,
      browser: { mode: "portable", cdpPort: 9222 }
    });
    assert.strictEqual(batch.policySnapshot.calibration.acceptance, "e2e_pending");
    assert.strictEqual(batch.policySnapshot.calibration.executionEnabled, true);
    assert.strictEqual(batch.status, "confirmed");
    const items = listCommunicationBatchItems(db, batch.id);
    assert.strictEqual(items.length, 8);
    assert.deepStrictEqual(Object.keys(items[0]).sort(), [
      "batchId", "clickCount", "clickedAt", "companySnapshot", "errorCode", "errorMessage",
      "evidence", "finishedAt", "id", "jobId", "jobUrl", "position", "startedAt", "status",
      "titleSnapshot", "updatedAt"
    ]);
    assert.strictEqual(items[0].titleSnapshot, "Role owner-0");
    assert.strictEqual(items[0].companySnapshot, "Company owner-0");
    assert.deepStrictEqual(items[0].evidence, {});
    assert.strictEqual(touchCommunicationBatch(db, batch.id, "2030-01-02T08:01:00.000Z"), 0);

    assertNoPartialBatch(db, () => createCommunicationBatch(db, {
      planId: seeded.planId, jobIds: [seeded.ids[8], seeded.ids[8]], browserMode: "edge"
    }), "COMMUNICATION_JOB_INELIGIBLE");
    assertNoPartialBatch(db, () => createCommunicationBatch(db, {
      planId: seeded.planId, jobIds: [], browserMode: "edge"
    }), "COMMUNICATION_JOB_INELIGIBLE");
    assertNoPartialBatch(db, () => createCommunicationBatch(db, {
      planId: seeded.planId, jobIds: [seeded.invalidUrlId], browserMode: "edge"
    }), "COMMUNICATION_JOB_INELIGIBLE");
    markCandidateJob(db, { profileId: seeded.profileId, planId: seeded.planId, jobId: seeded.appliedId, status: "applied" });
    assertNoPartialBatch(db, () => createCommunicationBatch(db, {
      planId: seeded.planId, jobIds: [seeded.appliedId], browserMode: "edge"
    }), "COMMUNICATION_JOB_INELIGIBLE");
    assert.throws(
      () => createCommunicationBatch(db, { planId: 0, jobIds: [seeded.ids[8]], browserMode: "edge" }),
      (error) => error.code === "COMMUNICATION_PLAN_INVALID"
    );
    assert.throws(
      () => createCommunicationBatch(db, { planId: seeded.planId, jobIds: [seeded.ids[8]], browserMode: "browser" }),
      (error) => error.code === "COMMUNICATION_BROWSER_MODE_INVALID"
    );

    assert.throws(
      () => setCommunicationBatchStatus(db, { batchId: batch.id, status: "completed" }),
      (error) => error.code === "COMMUNICATION_BATCH_TRANSITION_INVALID"
    );
    assert.strictEqual(setCommunicationBatchStatus(db, { id: batch.id, status: "running" }).status, "running");
    assert.strictEqual(touchCommunicationBatch(db, batch.id, "2030-01-02T08:02:00.000Z"), 1);
    assert.throws(
      () => setCommunicationBatchStatus(db, { batchId: batch.id, status: "completed" }),
      (error) => error.code === "COMMUNICATION_BATCH_ITEMS_UNFINISHED"
    );

    const [successItem, rollbackItem, ambiguousItem, stoppedItem, unavailableItem, mismatchItem, actionItem, alreadyItem] = items;
    transitionCommunicationItem(db, { id: successItem.id, fromStatus: "pending", toStatus: "opening" });
    transitionCommunicationItem(db, { itemId: successItem.id, expectedStatus: "opening", status: "verified" });
    const duplicate = createCommunicationBatch(db, { planId: seeded.planId, jobIds: [successItem.jobId], browserMode: "edge" });
    const auditRollback = observeTransactions(db, () => {
      const originalPrepare = db.prepare.bind(db);
      db.prepare = (sql) => {
        if (String(sql).includes("INSERT INTO events")) throw new Error("injected click audit failure");
        return originalPrepare(sql);
      };
      try {
        return assert.throws(
          () => transitionCommunicationItem(db, {
            itemId: successItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(successItem)
          }),
          /injected click audit failure/
        );
      } finally {
        db.prepare = originalPrepare;
      }
    });
    assert.deepStrictEqual(auditRollback.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.deepStrictEqual(listCommunicationBatchItems(db, batch.id)[0].status, "verified");
    assert.strictEqual(listCommunicationBatchItems(db, batch.id)[0].clickCount, 0);
    assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'communication_click'").get().count), 0);
    const dispatched = observeTransactions(db, () => transitionCommunicationItem(db, {
      itemId: successItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(successItem)
    }));
    assert.deepStrictEqual(dispatched.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
    assert.strictEqual(dispatched.value.clickCount, 1);
    assert.deepStrictEqual(JSON.parse(db.prepare("SELECT payload_json FROM events WHERE event_type = 'communication_click'").get().payload_json), clickAudit(successItem).payload);
    transitionCommunicationItem(db, { itemId: successItem.id, expectedStatus: "click_dispatched", status: "succeeded" });
    const duplicateItem = listCommunicationBatchItems(db, duplicate.id)[0];
    transitionCommunicationItem(db, { itemId: duplicateItem.id, expectedStatus: "pending", status: "opening" });
    transitionCommunicationItem(db, { itemId: duplicateItem.id, expectedStatus: "opening", status: "verified" });
    assert.throws(
      () => transitionCommunicationItem(db, {
        itemId: duplicateItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(duplicateItem)
      }),
      (error) => error.code === "COMMUNICATION_CLICK_ALREADY_DISPATCHED"
    );

    transitionCommunicationItem(db, { itemId: rollbackItem.id, expectedStatus: "pending", status: "opening" });
    const rollback = observeTransactions(db, () => pauseCommunicationBatchAfterReservationFailure(db, {
      batchId: batch.id, itemId: rollbackItem.id, now: "2030-01-02T08:03:00.000Z"
    }));
    assert.deepStrictEqual(rollback.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
    assert.strictEqual(rollback.value.batch.status, "paused");
    assert.strictEqual(rollback.value.item.status, "pending");
    assert.throws(
      () => pauseCommunicationBatchAfterReservationFailure(db, { batchId: batch.id, itemId: rollbackItem.id }),
      (error) => error.code === "COMMUNICATION_RESERVATION_ROLLBACK_CONFLICT"
    );
    setCommunicationBatchStatus(db, { batchId: batch.id, status: "running" });

    for (const [item, status] of [[stoppedItem, "stopped"], [unavailableItem, "job_unavailable"], [mismatchItem, "target_mismatch"], [actionItem, "action_unavailable"], [alreadyItem, "already_communicated"]]) {
      transitionCommunicationItem(db, { itemId: item.id, expectedStatus: "pending", status: "opening" });
      transitionCommunicationItem(db, { itemId: item.id, expectedStatus: "opening", status });
    }
    transitionCommunicationItem(db, { itemId: ambiguousItem.id, expectedStatus: "pending", status: "opening" });
    transitionCommunicationItem(db, { itemId: ambiguousItem.id, expectedStatus: "opening", status: "verified" });
    transitionCommunicationItem(db, {
      itemId: ambiguousItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(ambiguousItem)
    });
    transitionCommunicationItem(db, { itemId: ambiguousItem.id, expectedStatus: "click_dispatched", status: "ambiguous" });
    assert.throws(
      () => transitionCommunicationItem(db, { itemId: ambiguousItem.id, expectedStatus: "ambiguous", status: "succeeded" }),
      (error) => error.code === "COMMUNICATION_AMBIGUOUS_RESOLUTION_REQUIRED"
    );
    assert.throws(
      () => resolveAmbiguousCommunicationItem(db, { itemId: ambiguousItem.id, resolution: "succeeded" }),
      (error) => error.code === "COMMUNICATION_AMBIGUOUS_EVIDENCE_REQUIRED"
    );
    const resolutionTables = [
      "communication_batch_items",
      "events",
      "candidate_progress_cards",
      "candidate_progress_events"
    ];
    const beforeResolutionRollback = rowContentSnapshot(db, resolutionTables);
    const rollbackTrigger = "fail_target_candidate_progress_event";
    const rollbackIdempotencyKey = `communication:${batch.id}:${ambiguousItem.id}:succeeded`;
    db.exec(`CREATE TEMP TRIGGER ${rollbackTrigger}
      BEFORE INSERT ON candidate_progress_events
      WHEN NEW.idempotency_key = '${rollbackIdempotencyKey}'
        AND EXISTS (
          SELECT 1 FROM candidate_progress_cards
          WHERE id = NEW.card_id
            AND profile_id = ${batch.profileId}
            AND job_id = ${ambiguousItem.jobId}
        )
      BEGIN
        SELECT RAISE(ABORT, 'injected candidate progress event failure after card insert');
      END`);
    const originalResolutionExec = db.exec.bind(db);
    const rollbackStatements = [];
    db.exec = (sql) => {
      const statement = String(sql);
      rollbackStatements.push(statement);
      return originalResolutionExec(sql);
    };
    try {
      assert.throws(
        () => resolveAmbiguousCommunicationItem(db, {
          itemId: ambiguousItem.id,
          status: "succeeded",
          evidenceNote: "Injected late rollback fixture",
          now: "2030-01-02T08:03:30.000Z"
        }),
        /injected candidate progress event failure after card insert/
      );
    } finally {
      db.exec = originalResolutionExec;
      db.exec(`DROP TRIGGER IF EXISTS ${rollbackTrigger}`);
    }
    assert.strictEqual(db.prepare(`SELECT name FROM sqlite_temp_master
      WHERE type = 'trigger' AND name = ?`).get(rollbackTrigger), undefined);
    assert.strictEqual(db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name = ?`).get(rollbackTrigger), undefined);
    assert.deepStrictEqual(rollbackStatements, [
      "BEGIN IMMEDIATE",
      "SAVEPOINT candidate_progress_verified",
      "ROLLBACK TO candidate_progress_verified",
      "RELEASE candidate_progress_verified",
      "ROLLBACK"
    ]);
    const afterResolutionRollback = rowContentSnapshot(db, resolutionTables);
    assert.deepStrictEqual(afterResolutionRollback, beforeResolutionRollback);
    assert.strictEqual(
      listCommunicationBatchItems(db, batch.id).find((item) => item.id === ambiguousItem.id).status,
      "ambiguous"
    );
    assert.strictEqual(db.prepare(`SELECT id FROM events
      WHERE event_type = 'communication_manual_resolution'
        AND json_extract(payload_json, '$.itemId') = ?`).get(ambiguousItem.id), undefined);
    assert.deepStrictEqual(afterResolutionRollback.candidate_progress_cards, beforeResolutionRollback.candidate_progress_cards);
    assert.deepStrictEqual(afterResolutionRollback.candidate_progress_events, beforeResolutionRollback.candidate_progress_events);
    const resolved = observeTransactions(db, () => resolveAmbiguousCommunicationItem(db, {
      id: ambiguousItem.id, resolution: "succeeded", evidenceNote: "Verified local fixture", now: "2030-01-02T08:04:00.000Z"
    }));
    assert.deepStrictEqual(resolved.statements, [
      "BEGIN IMMEDIATE",
      "SAVEPOINT candidate_progress_verified",
      "RELEASE candidate_progress_verified",
      "COMMIT"
    ]);
    assert.deepStrictEqual(resolved.value.evidence.manualResolution, {
      status: "succeeded", note: "Verified local fixture", resolvedAt: "2030-01-02T08:04:00.000Z"
    });
    assert.deepStrictEqual(JSON.parse(db.prepare("SELECT payload_json FROM events WHERE event_type = 'communication_manual_resolution'").get().payload_json), {
      batchId: batch.id, itemId: ambiguousItem.id, jobId: ambiguousItem.jobId, status: "succeeded", note: "Verified local fixture"
    });
    assert.throws(
      () => resolveAmbiguousCommunicationItem(db, { itemId: ambiguousItem.id, status: "stopped", evidenceNote: "again" }),
      (error) => error.code === "COMMUNICATION_ITEM_TRANSITION_CONFLICT"
    );
    transitionCommunicationItem(db, { itemId: rollbackItem.id, expectedStatus: "pending", status: "stopped" });
    const summary = communicationBatchSummary(db, batch.id);
    assert.deepStrictEqual(summary, {
      batchId: batch.id, batchStatus: "running",
      statusCounts: { action_unavailable: 1, already_communicated: 1, job_unavailable: 1, stopped: 2, succeeded: 2, target_mismatch: 1 },
      total: 8, terminal: 8, remaining: 0
    });
    assert.strictEqual(setCommunicationBatchStatus(db, { batchId: batch.id, status: "completed" }).status, "completed");
    assert.throws(
      () => setCommunicationBatchStatus(db, { batchId: batch.id, status: "running" }),
      (error) => error.code === "COMMUNICATION_BATCH_TERMINAL"
    );

    const resumeBatch = createCommunicationBatch(db, { planId: seeded.planId, jobIds: [seeded.ids[8], seeded.ids[9]], browserMode: "edge" });
    setCommunicationBatchStatus(db, { batchId: resumeBatch.id, status: "running" });
    const [pendingResume, clickedResume] = listCommunicationBatchItems(db, resumeBatch.id);
    transitionCommunicationItem(db, { itemId: pendingResume.id, expectedStatus: "pending", status: "opening" });
    transitionCommunicationItem(db, { itemId: pendingResume.id, expectedStatus: "opening", status: "verified" });
    transitionCommunicationItem(db, { itemId: clickedResume.id, expectedStatus: "pending", status: "opening" });
    transitionCommunicationItem(db, { itemId: clickedResume.id, expectedStatus: "opening", status: "verified" });
    transitionCommunicationItem(db, {
      itemId: clickedResume.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(clickedResume)
    });
    setCommunicationBatchStatus(db, { batchId: resumeBatch.id, status: "interrupted", stopCode: "LOCAL_FIXTURE" });
    const blocked = observeTransactions(db, () => resumeInterruptedCommunicationBatch(db, { id: resumeBatch.id }));
    assert.deepStrictEqual(blocked.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
    assert.strictEqual(blocked.value.requiresReview, true);
    assert.deepStrictEqual(listCommunicationBatchItems(db, resumeBatch.id).map((item) => item.status), ["pending", "ambiguous"]);
    resolveAmbiguousCommunicationItem(db, { itemId: clickedResume.id, status: "stopped", evidenceNote: "Local recovery stop" });
    const resumed = observeTransactions(db, () => resumeInterruptedCommunicationBatch(db, { batchId: resumeBatch.id }));
    assert.deepStrictEqual(resumed.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
    assert.deepStrictEqual({ status: resumed.value.batch.status, requiresReview: resumed.value.requiresReview, finishedAt: resumed.value.batch.finishedAt }, {
      status: "running", requiresReview: false, finishedAt: null
    });
  } finally {
    db.close();
  }
}

function runQuotaContract() {
  const root = fs.mkdtempSync(path.join("D:\\DevData", "roleflow-communication-store-"));
  const dbPath = path.join(root, "communication.sqlite");
  const first = openDb(dbPath);
  const second = openDb(dbPath);
  try {
    const seeded = seed(first, "quota");
    const now = "2030-01-02T08:00:00.000Z";
    recordSiteAccessEvent(first, { site: "boss", action: "communication_visit", createdAt: "2030-01-01T15:59:59.999Z" });
    for (let index = 0; index < 149; index += 1) {
      recordSiteAccessEvent(first, { site: "boss", action: "communication_visit", createdAt: "2030-01-01T16:00:00.001Z" });
    }
    assert.deepStrictEqual(communicationQuotaSnapshot(first, { now }), { limit: 150, used: 149, reserved: 0, remaining: 1 });
    const reserved = createCommunicationBatch(first, { planId: seeded.planId, jobIds: [seeded.ids[0]], browserMode: "edge", now });
    assert.deepStrictEqual(communicationQuotaSnapshot(second, { now }), { limit: 150, used: 149, reserved: 1, remaining: 0 });
    assert.throws(
      () => createCommunicationBatch(second, { planId: seeded.planId, jobIds: [seeded.ids[1]], browserMode: "edge", now }),
      (error) => error.code === "COMMUNICATION_QUOTA_EXHAUSTED"
    );
    setCommunicationBatchStatus(first, { batchId: reserved.id, status: "running", now });
    const reservedItem = listCommunicationBatchItems(first, reserved.id)[0];
    recordSiteAccessEvent(first, {
      site: "boss", action: "communication_visit", createdAt: now,
      details: { batchId: reserved.id, itemId: reservedItem.id, jobId: reservedItem.jobId }
    });
    assert.deepStrictEqual(communicationQuotaSnapshot(first, { now }), { limit: 150, used: 150, reserved: 0, remaining: 0 });
    assert.deepStrictEqual(communicationQuotaSnapshot(first, { now: "2030-01-02T16:01:00.000Z" }), { limit: 150, used: 0, reserved: 1, remaining: 149 });
  } finally {
    first.close();
    second.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runCoreConsumerChildren() {
  for (const file of [
    "communication_batch_storage_smoke.js",
    "communication_executor_smoke.js",
    "communication_calibration_gate_smoke.js",
    "communication_cli_authority_smoke.js",
    "communication_application_smoke.js",
    "dashboard_communication_batch_smoke.js",
    "workflow_communication_smoke.js",
    "workflow_end_to_end_smoke.js",
    "workflow_recovery_smoke.js",
    "storage_migration_smoke.js"
  ]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
      cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 120000
    });
    assert.strictEqual(result.status, 0, `${file} must remain an offline core-facade consumer:\n${result.stderr || result.stdout}`);
  }
}

function seed(db, prefix) {
  const now = "2030-01-02T08:00:00.000Z";
  const profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(`Profile ${prefix}`, "{}", now, now).lastInsertRowid);
  const planId = Number(db.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(profileId, `Plan ${prefix}`, "{}", now, now).lastInsertRowid);
  const scanBatchId = createBatch(db, "boss", prefix, `${prefix} communication store contract`, { profileId, searchPlanId: planId });
  const ids = Array.from({ length: 12 }, (_, index) => upsertJob(db, job(`${prefix}-${index}`), scanBatchId));
  const invalidUrlId = upsertJob(db, job(`${prefix}-bad-url`, { url: "https://evil.example/job_detail/not-boss.html" }), scanBatchId);
  const appliedId = upsertJob(db, job(`${prefix}-applied`), scanBatchId);
  return { profileId, planId, ids, invalidUrlId, appliedId };
}

function job(sourceId, overrides = {}) {
  return {
    source: "boss", sourceId, keyword: "communication-store-contract", title: `Role ${sourceId}`,
    company: `Company ${sourceId}`, location: "Guangzhou", salary: "10-15K", experience: "1-3 years",
    education: "Bachelor", bossActiveText: "Active today", bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`, tags: ["Node.js"],
    description: "Offline communication store contract fixture.", score: 20, level: "recommended",
    matches: ["Node.js"], risks: [], qualityTags: [],
    analysis: { semanticStatus: "complete", recommendation: "primary", recommendationSchemaVersion: 2, fitLevel: "fit", hardBlockers: [] },
    ...overrides
  };
}

function clickAudit(item) {
  return {
    eventType: "communication_click",
    payload: { batchId: item.batchId, itemId: item.id, jobId: item.jobId, state: "click_dispatched" }
  };
}

function observeTransactions(db, action) {
  const originalExec = db.exec.bind(db);
  const statements = [];
  db.exec = (sql) => {
    statements.push(String(sql));
    return originalExec(sql);
  };
  try {
    return { value: action(), statements };
  } finally {
    db.exec = originalExec;
  }
}

function tableSnapshot(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => [name, Number(db.prepare(`SELECT COUNT(*) AS count FROM \"${name}\"`).get().count)]));
}

function rowContentSnapshot(db, tables) {
  return Object.fromEntries(tables.map((table) => [
    table,
    db.prepare(`SELECT * FROM \"${table}\" ORDER BY rowid`).all()
  ]));
}

function assertNoPartialBatch(db, action, code) {
  const before = tableSnapshot(db);
  assert.throws(action, (error) => error.code === code);
  assert.deepStrictEqual(tableSnapshot(db), before, `${code} must not leave partial rows`);
}
