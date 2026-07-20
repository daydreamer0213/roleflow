const assert = require("node:assert/strict");
const {
  openDb,
  createBatch,
  upsertJob,
  markCandidateJob
} = require("../src/core/storage");
const {
  workflowEligibility,
  listWorkflowInventory,
  reconcileCommunicationOutcome
} = require("../src/core/workflow_inventory");

const db = openDb(":memory:");

try {
  const now = "2026-07-20T08:00:00.000Z";
  const { profileId, planId } = seedPlan(db, now);
  const batchId = createBatch(db, "boss", "workflow-inventory", "workflow inventory", {
    profileId,
    searchPlanId: planId,
    startedAt: now
  });
  const ids = {};
  ids.primary = insert("primary", {}, batchId);
  ids.talk = insert("talk", { analysis: partialAnalysis() }, batchId);
  ids.lowRiskBackup = insert("low-risk-backup", {
    qualityTags: ["salary_target_core", "experience_salary_overlap"]
  }, batchId);
  ids.highSalaryBackup = insert("high-salary-backup", {
    qualityTags: ["salary_target_high", "experience_salary_overlap"]
  }, batchId);
  ids.applied = insert("applied", {}, batchId);
  ids.invalid = insert("invalid", {}, batchId);
  ids.futureLater = insert("future-later", {}, batchId);
  ids.ambiguous = insert("ambiguous", {}, batchId);
  ids.staleActivity = insert("stale-activity", { bossActiveDays: 7 }, batchId);
  ids.missingDetail = insert("missing-detail", { qualityTags: ["detail_unverified"], description: "short" }, batchId);
  ids.staleAnalysis = insert("stale-analysis", { analysis: { ...completeAnalysis(), semanticStatus: "stale" } }, batchId);

  markCandidateJob(db, { profileId, planId, jobId: ids.applied, status: "applied" });
  markCandidateJob(db, { profileId, planId, jobId: ids.invalid, status: "invalid" });
  markCandidateJob(db, {
    profileId,
    planId,
    jobId: ids.futureLater,
    status: "later",
    reviewAt: "2099-01-01T00:00:00.000Z"
  });
  seedAmbiguousCommunication(db, { profileId, planId, jobId: ids.ambiguous, now });
  const otherCandidate = seedPlan(db, now);
  seedAmbiguousCommunication(db, {
    profileId: otherCandidate.profileId,
    planId: otherCandidate.planId,
    jobId: ids.primary,
    now
  });

  const inventory = listWorkflowInventory(db, { planId, now });
  assert.deepStrictEqual(
    inventory.map((item) => [item.sourceId, item.workflowTier]),
    [
      ["primary", "primary"],
      ["talk", "talk"],
      ["low-risk-backup", "low_risk_backup"]
    ]
  );
  assert.strictEqual(workflowEligibility(job("pure-primary"), { now }).eligible, true);
  assert.strictEqual(
    workflowEligibility(job("pure-high", { qualityTags: ["salary_target_high", "experience_salary_overlap"] }), { now }).reasonCode,
    "WORKFLOW_BACKUP_NOT_LOW_RISK"
  );

  const outcomeJobIds = {
    succeeded: insert("outcome-succeeded", {}, batchId),
    already: insert("outcome-already", {}, batchId),
    unavailable: insert("outcome-unavailable", {}, batchId),
    mismatch: insert("outcome-mismatch", {}, batchId),
    actionUnavailable: insert("outcome-action-unavailable", {}, batchId)
  };
  const communicationBatch = { id: 91, profileId, planId };
  reconcileCommunicationOutcome(db, { batch: communicationBatch, item: { jobId: outcomeJobIds.succeeded }, status: "succeeded", now });
  reconcileCommunicationOutcome(db, { batch: communicationBatch, item: { jobId: outcomeJobIds.already }, status: "already_communicated", now });
  reconcileCommunicationOutcome(db, { batch: communicationBatch, item: { jobId: outcomeJobIds.unavailable }, status: "job_unavailable", now });
  reconcileCommunicationOutcome(db, { batch: communicationBatch, item: { jobId: outcomeJobIds.mismatch }, status: "target_mismatch", now });
  reconcileCommunicationOutcome(db, { batch: communicationBatch, item: { jobId: outcomeJobIds.actionUnavailable }, status: "action_unavailable", now });

  assert.strictEqual(state(outcomeJobIds.succeeded).status, "applied");
  assert.strictEqual(state(outcomeJobIds.already).status, "applied");
  assert.strictEqual(state(outcomeJobIds.unavailable).status, "invalid");
  assert.strictEqual(state(outcomeJobIds.mismatch).status, "review");
  assert.strictEqual(state(outcomeJobIds.actionUnavailable).status, "later");
  assert(Date.parse(state(outcomeJobIds.actionUnavailable).review_at) > Date.parse(now));

  console.log("workflow_inventory_smoke ok");

  function insert(sourceId, overrides, scanBatchId) {
    return upsertJob(db, job(sourceId, overrides), scanBatchId);
  }

  function state(jobId) {
    return db.prepare("SELECT status, review_at FROM candidate_job_states WHERE profile_id = ? AND job_id = ?")
      .get(profileId, jobId);
  }
} finally {
  db.close();
}

function seedPlan(database, now) {
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Inventory Candidate', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Inventory Plan', '{}', NULL, 1, ?, ?)`).run(profileId, now, now).lastInsertRowid);
  return { profileId, planId };
}

function seedAmbiguousCommunication(database, { profileId, planId, jobId, now }) {
  const communicationBatchId = Number(database.prepare(`INSERT INTO communication_batches(
    site, profile_id, plan_id, browser_mode, status, policy_json,
    confirmed_at, started_at, created_at, updated_at
  ) VALUES ('boss', ?, ?, 'edge', 'interrupted', '{}', ?, ?, ?, ?)`)
    .run(profileId, planId, now, now, now, now).lastInsertRowid);
  database.prepare(`INSERT INTO communication_batch_items(
    batch_id, job_id, position, job_url, title_snapshot, company_snapshot,
    status, click_count, updated_at
  ) VALUES (?, ?, 1, ?, 'Ambiguous role', 'Ambiguous company', 'ambiguous', 1, ?)`)
    .run(communicationBatchId, jobId, `https://www.zhipin.com/job_detail/ambiguous.html`, now);
}

function job(sourceId, overrides = {}) {
  return {
    source: "boss",
    sourceId,
    keyword: "workflow-inventory",
    title: `Role ${sourceId}`,
    company: `Company ${sourceId}`,
    location: "Guangzhou",
    salary: "10-15K",
    experience: "1-3 years",
    education: "Bachelor",
    bossActiveText: "Active today",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
    tags: ["Python", "RAG"],
    description: "Build and maintain a Python RAG application with retrieval, reranking, APIs, testing, and production diagnostics. ".repeat(3),
    score: 24,
    level: "Recommended",
    matches: ["Python", "RAG"],
    risks: [],
    qualityTags: ["salary_target_core"],
    analysis: completeAnalysis(),
    ...overrides
  };
}

function completeAnalysis() {
  return {
    provider: "openai_compatible",
    semanticStatus: "complete",
    recommendation: "apply",
    fitLevel: "A",
    confidence: 0.9,
    evidence: { jd: ["Python RAG"], resume: ["Python RAG"] },
    hardBlockers: []
  };
}

function partialAnalysis() {
  return {
    provider: "openai_compatible",
    semanticStatus: "partial",
    recommendation: "review",
    evidence: { jd: ["Python RAG"], resume: ["Python RAG"] },
    hardBlockers: []
  };
}
