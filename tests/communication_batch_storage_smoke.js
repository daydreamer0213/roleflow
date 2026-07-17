const assert = require("node:assert");
const {
  openDb,
  createBatch,
  upsertJob,
  markCandidateJob
} = require("../src/core/storage");
const {
  createCommunicationBatch,
  listCommunicationBatchItems,
  transitionCommunicationItem,
  resolveAmbiguousCommunicationItem,
  communicationBatchSummary
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
  const notRecommendedId = upsertJob(db, job("not-recommended", {
    title: "Not recommended role",
    level: "不建议",
    qualityTags: ["role_mismatch"]
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
  assert.throws(
    () => createCommunicationBatch(db, { planId, jobIds: [notRecommendedId], browserMode: "edge" }),
    (error) => error.code === "COMMUNICATION_JOB_INELIGIBLE"
  );

  markCandidateJob(db, { profileId, planId, jobId: backupId, status: "applied" });
  assert.throws(
    () => createCommunicationBatch(db, { planId, jobIds: [backupId], browserMode: "edge" }),
    (error) => error.code === "COMMUNICATION_JOB_INELIGIBLE"
  );

  const [primaryItem, talkItem, backupItem] = listCommunicationBatchItems(db, selected.id);
  transitionCommunicationItem(db, { itemId: primaryItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: primaryItem.id, expectedStatus: "opening", status: "verified" });
  const dispatched = transitionCommunicationItem(db, {
    itemId: primaryItem.id,
    expectedStatus: "verified",
    status: "click_dispatched",
    evidence: { dispatched: true }
  });
  assert.strictEqual(dispatched.clickCount, 1);
  assert.throws(
    () => transitionCommunicationItem(db, { itemId: primaryItem.id, expectedStatus: "verified", status: "click_dispatched" }),
    (error) => error.code === "COMMUNICATION_CLICK_ALREADY_DISPATCHED"
  );

  transitionCommunicationItem(db, { itemId: talkItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: talkItem.id, expectedStatus: "opening", status: "ambiguous" });
  assert.throws(
    () => resolveAmbiguousCommunicationItem(db, { itemId: talkItem.id, status: "pending" }),
    (error) => error.code === "COMMUNICATION_AMBIGUOUS_RESOLUTION_INVALID"
  );
  assert.strictEqual(
    resolveAmbiguousCommunicationItem(db, { itemId: talkItem.id, status: "succeeded" }).status,
    "succeeded"
  );

  transitionCommunicationItem(db, { itemId: backupItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: backupItem.id, expectedStatus: "opening", status: "ambiguous" });
  assert.strictEqual(
    resolveAmbiguousCommunicationItem(db, { itemId: backupItem.id, status: "stopped" }).status,
    "stopped"
  );
  assert.deepStrictEqual(communicationBatchSummary(db, selected.id).statusCounts, {
    click_dispatched: 1,
    stopped: 1,
    succeeded: 1
  });

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
