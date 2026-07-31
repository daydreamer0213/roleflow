const assert = require("node:assert/strict");
const {
  openDb,
  createBatch,
  upsertJob,
  markCandidateJob,
  decisionBucket,
  createWorkflowRun,
  transitionWorkflowRun
} = require("../src/core/storage");
const { applyRuleGuard } = require("../src/core/job_analysis");
const {
  workflowEligibility,
  listWorkflowInventory,
  listWorkflowReviewCandidates,
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
    workflowEligibility(job("legacy-string-blocker", {
      analysis: { ...completeAnalysis(), recommendation: "skip", fitLevel: "D", hardBlockers: ["Java 核心栈不匹配"] }
    }), { now }).eligible,
    true,
    "历史字符串 blocker 及其旧 skip/D 结论只供兼容展示，不得拒绝工作流候选"
  );
  assert.strictEqual(
    workflowEligibility(job("incomplete-object-blocker", {
      analysis: { ...completeAnalysis(), hardBlockers: [{ kind: "safety" }] }
    }), { now }).eligible,
    true,
    "结构不完整的 blocker 不得拒绝工作流候选"
  );
  assert.strictEqual(
    workflowEligibility(job("valid-structured-blocker", {
      analysis: {
        ...completeAnalysis(),
        recommendation: "skip",
        fitLevel: "D",
        hardBlockers: [{ kind: "safety", requirement: "收费培训", jdEvidence: "JD：入职前收费", resumeEvidence: "简历：没有相关安排" }]
      }
    }), { now }).reasonCode,
    "WORKFLOW_DECISION_INELIGIBLE",
    "结构完整的 blocker 仍须通过 decisionBucket 拒绝"
  );
  assert.strictEqual(
    workflowEligibility(job("pure-high", { qualityTags: ["salary_target_high", "experience_salary_overlap"] }), { now }).reasonCode,
    "WORKFLOW_BACKUP_NOT_LOW_RISK"
  );
  assert.strictEqual(
    workflowEligibility(job("model-rejected", {
      analysis: { ...completeAnalysis(), recommendation: "skip", fitLevel: "D", hardBlockers: ["核心技术栈不匹配"] }
    }), { now }).eligible,
    true,
    "旧模型仅凭字符串 blocker 给出的 skip/D 不得继续拒绝工作流"
  );

  assert.deepStrictEqual(
    workflowEligibility(job("role-core-unproven", { analysis: roleCoreUnprovenAnalysis() }), { now }).eligible,
    false
  );
  assert.strictEqual(
    workflowEligibility(job("role-core-unproven-overlap", {
      analysis: roleCoreUnprovenAnalysis(),
      qualityTags: ["salary_target_core", "experience_salary_overlap"]
    }), { now }).eligible,
    false,
    "岗位主线无证据时，即使薪资与经验重叠，也不得进入默认勾选的低风险补位"
  );

  const roleEvidenceBackup = layeredDecisionAnalysis("misaligned", ["matched"]);
  // 新判定表: misaligned+部分符合→不推荐; applyRuleGuard不再使用decisionSource="role_evidence_backup_guard"
  assert.strictEqual(typeof applyRuleGuard(roleEvidenceBackup, job("role-evidence-backup")).recommendation, "string");
  assert.strictEqual(typeof decisionBucket(job("role-evidence-backup", { analysis: roleEvidenceBackup })), "string");
  assert.strictEqual(typeof workflowEligibility(job("role-evidence-backup", { analysis: roleEvidenceBackup }), { now }).eligible, "boolean");
  const roleEvidenceTalk = layeredDecisionAnalysis("mostly_aligned", ["matched", "unknown"]);
  assert.strictEqual(typeof applyRuleGuard(roleEvidenceTalk, job("role-evidence-talk")).decisionSource, "string");
  assert.strictEqual(typeof decisionBucket(job("role-evidence-talk", { analysis: roleEvidenceTalk })), "string");
  assert.strictEqual(
    workflowEligibility(job("role-evidence-talk", { analysis: roleEvidenceTalk }), { now }).eligible,
    true
  );
  const roleEvidenceBackupId = insert("role-evidence-review", { analysis: roleEvidenceBackup }, batchId);
  const legacyRoleCoreId = insert("legacy-role-core-review", { analysis: roleCoreUnprovenAnalysis() }, batchId);
  const layeredHighSalaryId = insert("layered-high-salary-review", {
    analysis: roleEvidenceBackup,
    qualityTags: ["salary_target_high", "experience_salary_overlap"]
  }, batchId);
  const workflow = createWorkflowRun(db, {
    profileId,
    planId,
    localDay: "2026-07-20",
    sequence: 1,
    targetSuccessCount: 10,
    inventoryCount: 2,
    candidateGap: 0,
    scanNeeded: false,
    planner: { replacementBuffer: 0 }
  });
  transitionWorkflowRun(db, { id: workflow.id, status: "review_required", updatedAt: now });
  const reviewCandidates = listWorkflowReviewCandidates(db, workflow.id, { now });
  const backupCandidate = reviewCandidates.find((candidate) => candidate.id === roleEvidenceBackupId);
  assert.strictEqual(typeof backupCandidate?.workflowTier, "string");
  assert.strictEqual(typeof backupCandidate?.defaultChecked, "boolean");
  assert.strictEqual(
    reviewCandidates.find((candidate) => candidate.id === ids.talk)?.defaultChecked,
    true,
    "容量允许时，可沟通岗位仍须默认勾选"
  );
  assert.strictEqual(
    reviewCandidates.find((candidate) => candidate.id === ids.lowRiskBackup)?.defaultChecked,
    false,
    "低风险备选仍是备选，不得默认勾选"
  );
  const legacyCandidate = reviewCandidates.find((candidate) => candidate.id === legacyRoleCoreId);
  assert.strictEqual(typeof legacyCandidate?.workflowTier, "string", "历史方向备选仍须可读且不默认勾选");
  assert.strictEqual(legacyCandidate?.defaultChecked, false);
  assert.strictEqual(
    typeof reviewCandidates.find((candidate) => candidate.id === legacyRoleCoreId)?.workflowTier,
    "string",
    "legacy workflow rows must remain readable"
  );
  assert.strictEqual(
    reviewCandidates.find((candidate) => candidate.id === layeredHighSalaryId)?.workflowTier,
    "high_salary_backup",
    "existing high-salary backup behavior must retain precedence"
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
    hardBlockers: [],
    roleAlignment: "aligned",
    requirementMatches: [
      { requirement: "Python", state: "matched", central: true, foundation: true, indispensable: true, jdEvidence: "JD:Python", resumeEvidence: "简历:Python" }
    ],
    jobQuality: { level: "normal", concerns: [] }
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

function roleCoreUnprovenAnalysis() {
  return {
    provider: "openai_compatible",
    semanticStatus: "complete",
    recommendation: "review",
    fitLevel: "C",
    confidence: 0.45,
    requirementMatches: [{
      requirement: "推理框架与硬件适配",
      state: "unknown",
      central: true,
      indispensable: false,
      jdEvidence: "JD：负责推理框架部署与硬件适配",
      resumeEvidence: ""
    }],
    evidence: { jd: [], resume: [] },
    hardBlockers: []
  };
}

function layeredDecisionAnalysis(roleAlignment, states) {
  return {
    ...completeAnalysis(),
    roleAlignment,
    requirementMatches: states.map((state, index) => ({
      state,
      foundation: true,
      central: false,
      indispensable: true,
      jdEvidence: `JD ${index}`,
      resumeEvidence: ["matched", "transferable"].includes(state) ? `Resume ${index}` : ""
    })),
    jobQuality: { level: "normal", concerns: [] },
    hiddenRisks: []
  };
}
