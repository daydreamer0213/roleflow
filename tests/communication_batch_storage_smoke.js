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
  touchCommunicationBatch,
  listCommunicationBatchItems,
  setCommunicationBatchStatus,
  resumeInterruptedCommunicationBatch,
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
  assert.strictEqual(setCommunicationBatchStatus(db, { batchId: safeStop.id, status: "stopped" }).status, "stopped");
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
  assert.throws(
    () => transitionCommunicationItem(db, { itemId: talkItem.id, expectedStatus: "opening", status: "pending" }),
    (error) => error.code === "COMMUNICATION_ITEM_TRANSITION_INVALID"
  );
  transitionCommunicationItem(db, { itemId: talkItem.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(db, { itemId: talkItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(talkItem) });
  transitionCommunicationItem(db, { itemId: talkItem.id, expectedStatus: "click_dispatched", status: "ambiguous" });
  assert.throws(
    () => resolveAmbiguousCommunicationItem(db, { itemId: talkItem.id, status: "pending" }),
    (error) => error.code === "COMMUNICATION_AMBIGUOUS_RESOLUTION_INVALID"
  );
  assert.throws(
    () => resolveAmbiguousCommunicationItem(db, { itemId: talkItem.id, status: "succeeded" }),
    (error) => error.code === "COMMUNICATION_AMBIGUOUS_EVIDENCE_REQUIRED"
  );
  const successNote = "聊天页已显示对应岗位和招聘方";
  assert.strictEqual(
    resolveAmbiguousCommunicationItem(db, { itemId: talkItem.id, status: "succeeded", evidenceNote: successNote }).status,
    "succeeded"
  );
  const resolvedItem = listCommunicationBatchItems(db, selected.id).find((item) => item.id === talkItem.id);
  assert.strictEqual(resolvedItem.evidence.manualResolution.status, "succeeded");
  assert.strictEqual(resolvedItem.evidence.manualResolution.note, successNote);
  const successAudit = db.prepare("SELECT payload_json FROM events WHERE job_id = ? AND event_type = 'communication_manual_resolution' ORDER BY id DESC LIMIT 1").get(talkId);
  assert.deepStrictEqual(JSON.parse(successAudit.payload_json), {
    batchId: selected.id,
    itemId: talkItem.id,
    jobId: talkId,
    status: "succeeded",
    note: successNote
  });
  const resolvedState = db.prepare("SELECT status, note FROM candidate_job_states WHERE profile_id = ? AND job_id = ?").get(profileId, talkId);
  assert.strictEqual(resolvedState.status, "applied");
  assert.strictEqual(resolvedState.note, `RoleFlow 批量沟通 #${selected.id}`);

  transitionCommunicationItem(db, { itemId: backupItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: backupItem.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(db, { itemId: backupItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(backupItem) });
  transitionCommunicationItem(db, { itemId: backupItem.id, expectedStatus: "click_dispatched", status: "ambiguous" });
  assert.strictEqual(
    resolveAmbiguousCommunicationItem(db, { itemId: backupItem.id, status: "stopped", evidenceNote: "页面无法确认沟通结果，人工停止" }).status,
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
  assert.throws(
    () => setCommunicationBatchStatus(db, { batchId: selected.id, status: "completed" }),
    (error) => error.code === "COMMUNICATION_BATCH_TRANSITION_INVALID"
  );
  setCommunicationBatchStatus(db, { batchId: selected.id, status: "running" });
  assert.throws(
    () => setCommunicationBatchStatus(db, { batchId: selected.id, status: "running" }),
    (error) => error.code === "COMMUNICATION_BATCH_TRANSITION_INVALID"
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
  communicationNaturalDayResetSmoke();
  batchTransitionGraphSmoke();
  interruptedResumeSmoke();

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
    const now = "2030-01-02T08:00:00.000Z";
    const profileId = Number(quotaDb.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?)").run("Quota smoke", "{}", now, now).lastInsertRowid);
    const planId = Number(quotaDb.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(profileId, "Quota smoke", "{}", now, now).lastInsertRowid);
    const scanBatchId = createBatch(quotaDb, "boss", "quota", "quota smoke", { profileId, searchPlanId: planId });
    const firstId = upsertJob(quotaDb, job("quota-first", { analysis: completeAnalysis() }), scanBatchId);
    const secondId = upsertJob(quotaDb, job("quota-second", { analysis: completeAnalysis() }), scanBatchId);
    const windowStart = "2030-01-01T15:59:59.999Z";
    recordSiteAccessEvent(quotaDb, { site: "boss", action: "communication_visit", createdAt: windowStart });
    for (let index = 0; index < 149; index += 1) recordSiteAccessEvent(quotaDb, { site: "boss", action: "communication_visit", createdAt: "2030-01-01T16:00:00.001Z" });
    assert.deepStrictEqual(communicationQuotaSnapshot(quotaDb, { now }), { limit: 150, used: 149, reserved: 0, remaining: 1 });
    const firstBatch = createCommunicationBatch(quotaDb, { planId, jobIds: [firstId], browserMode: "edge", now });
    assert.deepStrictEqual(communicationQuotaSnapshot(quotaDb, { now }), { limit: 150, used: 149, reserved: 1, remaining: 0 });
    setCommunicationBatchStatus(quotaDb, { batchId: firstBatch.id, status: "running", now });
    assert.strictEqual(touchCommunicationBatch(quotaDb, firstBatch.id, "2030-01-02T00:01:00.000Z"), 1);
    assert.strictEqual(getCommunicationBatch(quotaDb, firstBatch.id).updatedAt, "2030-01-02T00:01:00.000Z");
    const firstItem = listCommunicationBatchItems(quotaDb, firstBatch.id)[0];
    recordSiteAccessEvent(quotaDb, {
      site: "boss",
      action: "communication_visit",
      createdAt: now,
      details: { batchId: firstBatch.id, itemId: firstItem.id, jobId: firstId }
    });
    assert.deepStrictEqual(communicationQuotaSnapshot(quotaDb, { now }), { limit: 150, used: 150, reserved: 0, remaining: 0 });
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

function communicationNaturalDayResetSmoke() {
  const database = openDb(":memory:");
  try {
    const now = "2030-01-02T16:01:00.000Z";
    for (let index = 0; index < 150; index += 1) {
      recordSiteAccessEvent(database, {
        site: "boss",
        action: "communication_visit",
        createdAt: `2030-01-02T15:59:59.${String(index).padStart(3, "0")}Z`
      });
    }
    assert.deepStrictEqual(communicationQuotaSnapshot(database, { now }), {
      limit: 150,
      used: 0,
      reserved: 0,
      remaining: 150
    });
  } finally {
    database.close();
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

function batchTransitionGraphSmoke() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-batch-transition-"));
  const transitionDb = openDb(path.join(root, "jobs.sqlite"));
  try {
    const now = new Date().toISOString();
    const profileId = Number(transitionDb.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("Transition smoke", "{}", now, now).lastInsertRowid);
    const planId = Number(transitionDb.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(profileId, "Transition smoke", "{}", now, now).lastInsertRowid);
    const scanBatchId = createBatch(transitionDb, "boss", "transition-smoke", "transition smoke", { profileId, searchPlanId: planId });
    const jobId = upsertJob(transitionDb, job("transition-smoke", { analysis: completeAnalysis() }), scanBatchId);
    const batch = createCommunicationBatch(transitionDb, { planId, jobIds: [jobId], browserMode: "edge" });

    assert.throws(
      () => setCommunicationBatchStatus(transitionDb, { batchId: batch.id, status: "confirmed" }),
      (error) => error.code === "COMMUNICATION_BATCH_TRANSITION_INVALID"
    );
    assert.throws(
      () => setCommunicationBatchStatus(transitionDb, { batchId: batch.id, status: "completed" }),
      (error) => error.code === "COMMUNICATION_BATCH_TRANSITION_INVALID"
    );
    setCommunicationBatchStatus(transitionDb, { batchId: batch.id, status: "running" });
    assert.throws(
      () => setCommunicationBatchStatus(transitionDb, { batchId: batch.id, status: "completed" }),
      (error) => error.code === "COMMUNICATION_BATCH_ITEMS_UNFINISHED"
    );
    setCommunicationBatchStatus(transitionDb, { batchId: batch.id, status: "paused" });
    assert.throws(
      () => setCommunicationBatchStatus(transitionDb, { batchId: batch.id, status: "confirmed" }),
      (error) => error.code === "COMMUNICATION_BATCH_TRANSITION_INVALID"
    );
    setCommunicationBatchStatus(transitionDb, { batchId: batch.id, status: "stopping" });
    const item = listCommunicationBatchItems(transitionDb, batch.id)[0];
    transitionCommunicationItem(transitionDb, { itemId: item.id, expectedStatus: "pending", status: "stopped" });
    assert.strictEqual(setCommunicationBatchStatus(transitionDb, { batchId: batch.id, status: "stopped" }).status, "stopped");
  } finally {
    transitionDb.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function interruptedResumeSmoke() {
  const database = openDb(":memory:");
  try {
    const now = new Date().toISOString();
    const profileId = Number(database.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("Resume smoke", "{}", now, now).lastInsertRowid);
    const planId = Number(database.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(profileId, "Resume smoke", "{}", now, now).lastInsertRowid);
    const scanBatchId = createBatch(database, "boss", "resume-smoke", "resume smoke", { profileId, searchPlanId: planId });
    const jobIds = [0, 1].map((index) => upsertJob(database, job(`resume-${index}`, { analysis: completeAnalysis() }), scanBatchId));
    const batch = createCommunicationBatch(database, { planId, jobIds, browserMode: "edge" });
    setCommunicationBatchStatus(database, { batchId: batch.id, status: "running" });
    const [verified, dispatched] = listCommunicationBatchItems(database, batch.id);
    transitionCommunicationItem(database, { itemId: verified.id, expectedStatus: "pending", status: "opening" });
    transitionCommunicationItem(database, { itemId: verified.id, expectedStatus: "opening", status: "verified" });
    transitionCommunicationItem(database, { itemId: dispatched.id, expectedStatus: "pending", status: "opening" });
    transitionCommunicationItem(database, { itemId: dispatched.id, expectedStatus: "opening", status: "verified" });
    transitionCommunicationItem(database, {
      itemId: dispatched.id,
      expectedStatus: "verified",
      status: "click_dispatched",
      audit: clickAudit(dispatched)
    });
    setCommunicationBatchStatus(database, { batchId: batch.id, status: "interrupted", stopCode: "BROWSER_DISCONNECTED" });

    const blocked = resumeInterruptedCommunicationBatch(database, { batchId: batch.id });
    assert.strictEqual(blocked.requiresReview, true);
    assert.strictEqual(blocked.batch.status, "interrupted");
    assert.deepStrictEqual(listCommunicationBatchItems(database, batch.id).map((item) => item.status), ["pending", "ambiguous"]);

    resolveAmbiguousCommunicationItem(database, {
      batchId: batch.id,
      itemId: dispatched.id,
      status: "stopped",
      evidenceNote: "No verified chat result"
    });
    const resumed = resumeInterruptedCommunicationBatch(database, { batchId: batch.id });
    assert.strictEqual(resumed.requiresReview, false);
    assert.strictEqual(resumed.batch.status, "running");
    assert.strictEqual(resumed.batch.finishedAt, null);
    assert.strictEqual(resumed.batch.stopCode, null);
  } finally {
    database.close();
  }
}
