const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  openDb,
  createBatch,
  upsertJob,
  markCandidateJob,
  recordSiteAccessEvent
} = require("../src/core/storage");
const {
  createCommunicationBatch,
  getCommunicationBatch,
  listCommunicationBatchItems,
  setCommunicationBatchStatus,
  transitionCommunicationItem,
  resolveAmbiguousCommunicationItem,
  communicationBatchSummary,
  communicationQuotaSnapshot
} = require("../src/core/communication_batches");

const db = openDb(":memory:");

try {
  const now = new Date().toISOString();
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)`).run("Batch smoke", "{}", now, now).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run(profileId, "Batch smoke", "{}", now, now).lastInsertRowid);
  const scanBatchId = createBatch(db, "boss", "batch-smoke", "communication batch smoke", { profileId, searchPlanId: planId });

  const primaryId = upsertJob(db, job("primary", {
    title: "Primary role",
    analysis: completeAnalysis()
  }), scanBatchId);
  const talkId = upsertJob(db, job("talk", {
    title: "Talk role",
    analysis: { semanticStatus: "partial", recommendation: "review" }
  }), scanBatchId);
  const backupId = upsertJob(db, job("backup", {
    title: "Backup role",
    qualityTags: ["experience_overrange"]
  }), scanBatchId);
  const atomicId = upsertJob(db, job("atomic"), scanBatchId);
  const notRecommendedId = upsertJob(db, job("not-recommended", {
    title: "Not recommended role",
    level: "不建议",
    qualityTags: ["role_mismatch"]
  }), scanBatchId);
  const alreadyCommunicatedId = upsertJob(db, job("already-communicated", {
    title: "Already communicated role"
  }), scanBatchId);
  const evilUrlId = upsertJob(db, job("evil-url", {
    title: "Evil URL role",
    url: "https://evil.example/job_detail/evil.html?next=https://www.zhipin.com/job_detail/good.html"
  }), scanBatchId);

  const selected = createCommunicationBatch(db, {
    planId,
    jobIds: [primaryId, talkId, backupId],
    browserMode: "edge",
    policySnapshot: { delayMs: [15000, 20000] }
  });
  assert.strictEqual(selected.status, "confirmed");
  assert.deepStrictEqual(
    listCommunicationBatchItems(db, selected.id).map((item) => item.status),
    ["pending", "pending", "pending"]
  );
  const safeStop = createCommunicationBatch(db, { planId, jobIds: [alreadyCommunicatedId], browserMode: "edge" });
  const safeStopItem = listCommunicationBatchItems(db, safeStop.id)[0];
  assert.strictEqual(
    transitionCommunicationItem(db, { itemId: safeStopItem.id, expectedStatus: "pending", status: "stopped" }).status,
    "stopped"
  );
  assert.throws(
    () => createCommunicationBatch(db, { planId, jobIds: [notRecommendedId], browserMode: "edge" }),
    (error) => error.code === "COMMUNICATION_JOB_INELIGIBLE"
  );
  assert.throws(
    () => createCommunicationBatch(db, { planId, jobIds: [evilUrlId], browserMode: "edge" }),
    (error) => error.code === "COMMUNICATION_JOB_INELIGIBLE"
  );
  const duplicate = createCommunicationBatch(db, { planId, jobIds: [primaryId], browserMode: "edge" });
  const alreadyCommunicated = createCommunicationBatch(db, { planId, jobIds: [alreadyCommunicatedId], browserMode: "edge" });
  const atomic = createCommunicationBatch(db, { planId, jobIds: [atomicId], browserMode: "edge" });

  markCandidateJob(db, { profileId, planId, jobId: backupId, status: "applied" });
  assert.throws(
    () => createCommunicationBatch(db, { planId, jobIds: [backupId], browserMode: "edge" }),
    (error) => error.code === "COMMUNICATION_JOB_INELIGIBLE"
  );
  for (const status of ["no_reply", "interview", "rejected", "skipped", "invalid", "salary_mismatch", "later", "review"]) {
    const jobId = upsertJob(db, job(`status-${status}`, { title: `Status ${status}` }), scanBatchId);
    markCandidateJob(db, { profileId, planId, jobId, status });
    assert.throws(
      () => createCommunicationBatch(db, { planId, jobIds: [jobId], browserMode: "edge" }),
      (error) => error.code === "COMMUNICATION_JOB_INELIGIBLE"
    );
  }

  const [primaryItem, talkItem, backupItem] = listCommunicationBatchItems(db, selected.id);
  assert.throws(
    () => transitionCommunicationItem(db, { itemId: primaryItem.id, expectedStatus: "pending", status: "succeeded" }),
    (error) => error.code === "COMMUNICATION_ITEM_TRANSITION_INVALID"
  );
  transitionCommunicationItem(db, { itemId: primaryItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: primaryItem.id, expectedStatus: "opening", status: "verified" });
  const dispatched = transitionCommunicationItem(db, {
    itemId: primaryItem.id,
    expectedStatus: "verified",
    status: "click_dispatched",
    evidence: { dispatched: true },
    audit: clickAudit(primaryItem)
  });
  assert.strictEqual(dispatched.clickCount, 1);
  transitionCommunicationItem(db, { itemId: primaryItem.id, expectedStatus: "click_dispatched", status: "succeeded" });
  assert.throws(
    () => createCommunicationBatch(db, { planId, jobIds: [primaryId], browserMode: "edge" }),
    (error) => error.code === "COMMUNICATION_JOB_INELIGIBLE"
  );
  const duplicateItem = listCommunicationBatchItems(db, duplicate.id)[0];
  transitionCommunicationItem(db, { itemId: duplicateItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: duplicateItem.id, expectedStatus: "opening", status: "verified" });
  assert.throws(
    () => transitionCommunicationItem(db, { itemId: duplicateItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(duplicateItem) }),
    (error) => error.code === "COMMUNICATION_CLICK_ALREADY_DISPATCHED"
  );

  transitionCommunicationItem(db, { itemId: talkItem.id, expectedStatus: "pending", status: "opening" });
  assert.throws(
    () => transitionCommunicationItem(db, { itemId: talkItem.id, expectedStatus: "opening", status: "ambiguous" }),
    (error) => error.code === "COMMUNICATION_ITEM_TRANSITION_INVALID"
  );
  transitionCommunicationItem(db, { itemId: talkItem.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(db, { itemId: talkItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(talkItem) });
  transitionCommunicationItem(db, { itemId: talkItem.id, expectedStatus: "click_dispatched", status: "ambiguous" });
  assert.throws(
    () => resolveAmbiguousCommunicationItem(db, { itemId: talkItem.id, status: "pending" }),
    (error) => error.code === "COMMUNICATION_AMBIGUOUS_RESOLUTION_INVALID"
  );
  assert.strictEqual(
    resolveAmbiguousCommunicationItem(db, { itemId: talkItem.id, status: "succeeded" }).status,
    "succeeded"
  );
  const resolvedState = db.prepare("SELECT status, note FROM candidate_job_states WHERE profile_id = ? AND job_id = ?").get(profileId, talkId);
  assert.strictEqual(resolvedState.status, "applied");
  assert.strictEqual(resolvedState.note, `RoleFlow 批量沟通 #${selected.id}`);

  transitionCommunicationItem(db, { itemId: backupItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: backupItem.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(db, { itemId: backupItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(backupItem) });
  transitionCommunicationItem(db, { itemId: backupItem.id, expectedStatus: "click_dispatched", status: "ambiguous" });
  assert.strictEqual(
    resolveAmbiguousCommunicationItem(db, { itemId: backupItem.id, status: "stopped" }).status,
    "stopped"
  );
  const alreadyCommunicatedItem = listCommunicationBatchItems(db, alreadyCommunicated.id)[0];
  transitionCommunicationItem(db, { itemId: alreadyCommunicatedItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: alreadyCommunicatedItem.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(db, { itemId: alreadyCommunicatedItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(alreadyCommunicatedItem) });
  transitionCommunicationItem(db, { itemId: alreadyCommunicatedItem.id, expectedStatus: "click_dispatched", status: "already_communicated" });
  assert.throws(
    () => createCommunicationBatch(db, { planId, jobIds: [alreadyCommunicatedId], browserMode: "edge" }),
    (error) => error.code === "COMMUNICATION_JOB_INELIGIBLE"
  );
  const completed = setCommunicationBatchStatus(db, { batchId: selected.id, status: "completed" });
  assert.ok(completed.finishedAt);
  assert.throws(
    () => setCommunicationBatchStatus(db, { batchId: selected.id, status: "running" }),
    (error) => error.code === "COMMUNICATION_BATCH_TERMINAL"
  );
  assert.strictEqual(getCommunicationBatch(db, selected.id).status, "completed");
  assert.deepStrictEqual(communicationBatchSummary(db, selected.id).statusCounts, {
    stopped: 1,
    succeeded: 2
  });
  batchStatusOptimisticConflictSmoke();
  atomicClickAuditSmoke(db, atomic.id);
  quotaReservationAtomicitySmoke();

  console.log("communication_batch_storage_smoke ok");
} finally {
  db.close();
}

function job(sourceId, overrides = {}) {
  return {
    source: "boss",
    sourceId,
    keyword: "batch-smoke",
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
    description: "Build Python services for communication batch storage.",
    score: 20,
    level: "可投",
    matches: ["Python"],
    risks: [],
    qualityTags: [],
    analysis: {},
    ...overrides
  };
}

function completeAnalysis() {
  return {
    semanticStatus: "complete",
    recommendation: "apply",
    confidence: 0.9,
    evidence: { jd: ["Python"], resume: ["Python"] }
  };
}

function clickAudit(item) {
  return {
    eventType: "communication_click",
    payload: { batchId: item.batchId, itemId: item.id, jobId: item.jobId, state: "click_dispatched" }
  };
}

function atomicClickAuditSmoke(db, batchId) {
  const item = listCommunicationBatchItems(db, batchId)[0];
  transitionCommunicationItem(db, { itemId: item.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: item.id, expectedStatus: "opening", status: "verified" });
  assert.throws(
    () => transitionCommunicationItem(db, { itemId: item.id, expectedStatus: "verified", status: "click_dispatched" }),
    (error) => error.code === "COMMUNICATION_CLICK_AUDIT_REQUIRED"
  );
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (String(sql).includes("INSERT INTO events")) throw new Error("audit write failed");
    return originalPrepare(sql);
  };
  try {
    assert.throws(
      () => transitionCommunicationItem(db, { itemId: item.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(item) }),
      /audit write failed/
    );
  } finally {
    db.prepare = originalPrepare;
  }
  const unchanged = listCommunicationBatchItems(db, batchId)[0];
  assert.strictEqual(unchanged.status, "verified");
  assert.strictEqual(unchanged.clickCount, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'communication_click'").get().count, 4);
  transitionCommunicationItem(db, { itemId: item.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(item) });
  assert.strictEqual(listCommunicationBatchItems(db, batchId)[0].clickCount, 1);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'communication_click'").get().count, 5);
}

function quotaReservationAtomicitySmoke() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-quota-reservation-"));
  const dbPath = path.join(root, "jobs.sqlite");
  const quotaDb = openDb(dbPath);
  const secondRequestDb = openDb(dbPath);
  try {
    const now = "2030-01-02T00:00:00.000Z";
    const profileId = Number(quotaDb.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?)").run("Quota smoke", "{}", now, now).lastInsertRowid);
    const planId = Number(quotaDb.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(profileId, "Quota smoke", "{}", now, now).lastInsertRowid);
    const scanBatchId = createBatch(quotaDb, "boss", "quota", "quota smoke", { profileId, searchPlanId: planId });
    const firstId = upsertJob(quotaDb, job("quota-first", { analysis: completeAnalysis() }), scanBatchId);
    const secondId = upsertJob(quotaDb, job("quota-second", { analysis: completeAnalysis() }), scanBatchId);
    const windowStart = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
    recordSiteAccessEvent(quotaDb, { site: "boss", action: "communication_visit", createdAt: windowStart });
    for (let index = 0; index < 149; index += 1) recordSiteAccessEvent(quotaDb, { site: "boss", action: "communication_visit", createdAt: "2030-01-01T00:00:00.001Z" });
    assert.deepStrictEqual(communicationQuotaSnapshot(quotaDb, { now }), { limit: 150, used: 149, reserved: 0, remaining: 1 });
    createCommunicationBatch(quotaDb, { planId, jobIds: [firstId], browserMode: "edge", now });
    assert.deepStrictEqual(communicationQuotaSnapshot(quotaDb, { now }), { limit: 150, used: 149, reserved: 1, remaining: 0 });
    assert.throws(
      () => createCommunicationBatch(secondRequestDb, { planId, jobIds: [secondId], browserMode: "edge", now }),
      (error) => error.code === "COMMUNICATION_QUOTA_EXHAUSTED"
    );
  } finally {
    quotaDb.close();
    secondRequestDb.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function batchStatusOptimisticConflictSmoke() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-batch-status-race-"));
  const dbPath = path.join(root, "jobs.sqlite");
  const first = openDb(dbPath);
  const second = openDb(dbPath);
  try {
    const now = new Date().toISOString();
    const profileId = Number(first.prepare(`INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)`).run("Race smoke", "{}", now, now).lastInsertRowid);
    const planId = Number(first.prepare(`INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(profileId, "Race smoke", "{}", now, now).lastInsertRowid);
    const batchId = Number(first.prepare(`INSERT INTO communication_batches(
      site, profile_id, plan_id, browser_mode, status, policy_json, confirmed_at, created_at, updated_at
    ) VALUES ('boss', ?, ?, 'edge', 'confirmed', '{}', ?, ?, ?)`)
      .run(profileId, planId, now, now, now).lastInsertRowid);
    const originalPrepare = first.prepare.bind(first);
    let injected = false;
    first.prepare = (sql) => {
      if (!injected && String(sql).includes("UPDATE communication_batches SET")) {
        injected = true;
        second.prepare(`UPDATE communication_batches SET status = 'completed', finished_at = ?, updated_at = ? WHERE id = ?`)
          .run(now, now, batchId);
      }
      return originalPrepare(sql);
    };
    assert.throws(
      () => setCommunicationBatchStatus(first, { batchId, status: "running" }),
      (error) => error.code === "COMMUNICATION_BATCH_TRANSITION_CONFLICT"
    );
    assert.strictEqual(getCommunicationBatch(second, batchId).status, "completed");
  } finally {
    first.close();
    second.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
