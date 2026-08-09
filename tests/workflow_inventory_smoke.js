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
const { ensureProgressCard, transitionProgressCard } = require("../src/core/candidate_progress");

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
  ids.primary = insert("primary", { analysis: completeAnalysis("primary") }, batchId);
  ids.talk = insert("talk", { analysis: completeAnalysis("apply") }, batchId);
  ids.lowRiskBackup = insert("low-risk-backup", {
    analysis: completeAnalysis("caution"),
    qualityTags: ["salary_target_core", "experience_salary_overlap"]
  }, batchId);
  ids.highSalaryBackup = insert("high-salary-backup", {
    analysis: completeAnalysis("caution"),
    qualityTags: ["salary_target_high", "experience_salary_overlap"]
  }, batchId);
  ids.applied = insert("applied", {}, batchId);
  ids.invalid = insert("invalid", {}, batchId);
  ids.futureLater = insert("future-later", {}, batchId);
  ids.ambiguous = insert("ambiguous", {}, batchId);
  ids.progressActive = insert("progress-active", {}, batchId);
  ids.verifiedClosed = insert("verified-closed", {}, batchId);
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
  ensureProgressCard(db, {
    profileId,
    planId,
    jobId: ids.progressActive,
    source: "boss",
    now
  });
  seedCommunicationState(db, {
    profileId,
    planId,
    jobId: ids.verifiedClosed,
    status: "succeeded",
    now
  });
  const verifiedClosedCard = ensureProgressCard(db, {
    profileId,
    planId,
    jobId: ids.verifiedClosed,
    source: "boss",
    now
  });
  transitionProgressCard(db, {
    cardId: verifiedClosedCard.id,
    expectedStage: "contact_started",
    stage: "closed",
    now
  });

  const inventory = listWorkflowInventory(db, { planId, now });
  assert.deepStrictEqual(
    inventory.map((item) => [item.sourceId, item.workflowTier]),
    [
      ["primary", "primary"],
      ["talk", "apply"]
    ]
  );
  assert.strictEqual(
    inventory.some((item) => item.id === ids.progressActive),
    false,
    "an active progress card must remove the job from the communication inventory"
  );
  assert.strictEqual(
    inventory.some((item) => item.id === ids.verifiedClosed),
    false,
    "verified communication must stay out of inventory after its progress card becomes terminal"
  );
  assert.strictEqual(workflowEligibility(job("pure-primary"), { now }).eligible, true);
  assert.deepStrictEqual(
    workflowEligibility(job("short-verified-detail", {
      description: "Verified but incomplete JD. ".repeat(4),
      qualityTags: []
    }), { now }),
    { eligible: false, tier: "", reasonCode: "WORKFLOW_DETAIL_REQUIRED" },
    "不足 120 字的岗位描述不得进入复核或沟通候选，即使旧分析已标为完整"
  );
  assert.strictEqual(
    workflowEligibility(job("legacy-string-blocker", {
      analysis: { ...completeAnalysis(), recommendationSchemaVersion: 1, recommendation: "skip", fitLevel: "D", hardBlockers: ["Java 核心栈不匹配"] }
    }), { now }).eligible,
    false,
    "历史 skip 必须按批准映射读取为不推荐，不因字符串 blocker 结构不完整而升档"
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
        recommendation: "not_recommended",
        fitLevel: "D",
        hardBlockers: [{ kind: "safety", requirement: "收费培训", jdEvidence: "JD：入职前收费", resumeEvidence: "简历：没有相关安排" }]
      }
    }), { now }).reasonCode,
    "WORKFLOW_DECISION_INELIGIBLE",
    "结构完整的 blocker 仍须通过 decisionBucket 拒绝"
  );
  assert.strictEqual(
    workflowEligibility(job("pure-high", {
      analysis: completeAnalysis("caution"),
      qualityTags: ["salary_target_high", "experience_salary_overlap"]
    }), { now }).reasonCode,
    "WORKFLOW_DECISION_CAUTION"
  );
  assert.strictEqual(
    workflowEligibility(job("progress-active"), { now, progressStage: "waiting_reply" }).reasonCode,
    "WORKFLOW_PROGRESS_ACTIVE"
  );
  assert.strictEqual(
    workflowEligibility(job("already-contacted"), { now, communicationStatus: "succeeded" }).reasonCode,
    "WORKFLOW_COMMUNICATION_VERIFIED"
  );
  assert.strictEqual(
    workflowEligibility(job("model-rejected", {
      analysis: { ...completeAnalysis(), recommendationSchemaVersion: 1, recommendation: "skip", fitLevel: "D", hardBlockers: ["核心技术栈不匹配"] }
    }), { now }).eligible,
    false,
    "旧 skip 必须稳定映射为不推荐"
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

  const roleEvidenceExclusion = layeredDecisionAnalysis("misaligned", ["matched"]);
  const guardedRoleEvidenceExclusion = applyRuleGuard(roleEvidenceExclusion, job("role-evidence-exclusion"));
  assert.strictEqual(guardedRoleEvidenceExclusion.recommendation, "not_recommended");
  assert.strictEqual(decisionBucket(job("role-evidence-exclusion", { analysis: guardedRoleEvidenceExclusion })), "not_recommended");
  assert.strictEqual(workflowEligibility(job("role-evidence-exclusion", { analysis: guardedRoleEvidenceExclusion }), { now }).eligible, false);
  const roleEvidenceTalk = layeredDecisionAnalysis("mostly_aligned", ["matched", "unknown"]);
  const guardedRoleEvidenceTalk = applyRuleGuard(roleEvidenceTalk, job("role-evidence-talk"));
  assert.strictEqual(guardedRoleEvidenceTalk.decisionSource, "weighted_decision_matrix");
  assert.strictEqual(decisionBucket(job("role-evidence-talk", { analysis: guardedRoleEvidenceTalk })), "caution");
  assert.strictEqual(
    workflowEligibility(job("role-evidence-talk", { analysis: guardedRoleEvidenceTalk }), { now }).eligible,
    false
  );
  const semanticRiskReview = {
    ...layeredDecisionAnalysis("aligned", ["matched"]),
    recommendation: "caution",
    decisionSource: "semantic_risk_guard"
  };
  assert.strictEqual(
    workflowEligibility(job("semantic-risk-review", { analysis: semanticRiskReview }), { now }).reasonCode,
    "WORKFLOW_DECISION_CAUTION",
    "语义风险慎投不得进入默认沟通库存"
  );
  const roleEvidenceBackupId = insert("role-evidence-review", { analysis: guardedRoleEvidenceExclusion }, batchId);
  const legacyRoleCoreId = insert("legacy-role-core-review", { analysis: roleCoreUnprovenAnalysis() }, batchId);
  const semanticRiskReviewId = insert("semantic-risk-review", { analysis: semanticRiskReview }, batchId);
  const layeredHighSalaryId = insert("layered-high-salary-review", {
    analysis: { ...guardedRoleEvidenceExclusion, recommendation: "caution" },
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
  assert.strictEqual(backupCandidate, undefined,
    "主方向完全错位的岗位不得进入慎投复核集合");
  const semanticRiskCandidate = reviewCandidates.find((candidate) => candidate.id === semanticRiskReviewId);
  assert.strictEqual(semanticRiskCandidate?.workflowTier, "caution");
  assert.strictEqual(semanticRiskCandidate?.defaultChecked, false, "通用人工复核岗位不得默认勾选");
  assert.strictEqual(
    reviewCandidates.find((candidate) => candidate.id === ids.talk)?.defaultChecked,
    true,
    "容量允许时，可投岗位仍须默认勾选"
  );
  assert.strictEqual(
    reviewCandidates.find((candidate) => candidate.id === ids.lowRiskBackup)?.defaultChecked,
    false,
    "慎投不得默认勾选"
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
    "caution",
    "高薪跨度已经在分析阶段归入慎投，人工可见但不默认勾选"
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

  assert.strictEqual(state(outcomeJobIds.succeeded), undefined);
  assert.strictEqual(state(outcomeJobIds.already), undefined);
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

function seedCommunicationState(database, { profileId, planId, jobId, status, now }) {
  const communicationBatchId = Number(database.prepare(`INSERT INTO communication_batches(
    site, profile_id, plan_id, browser_mode, status, policy_json,
    confirmed_at, started_at, finished_at, created_at, updated_at
  ) VALUES ('boss', ?, ?, 'edge', 'completed', '{}', ?, ?, ?, ?, ?)`)
    .run(profileId, planId, now, now, now, now, now).lastInsertRowid);
  database.prepare(`INSERT INTO communication_batch_items(
    batch_id, job_id, position, job_url, title_snapshot, company_snapshot,
    status, click_count, finished_at, updated_at
  ) VALUES (?, ?, 1, ?, 'Verified role', 'Verified company', ?, 1, ?, ?)`)
    .run(communicationBatchId, jobId, `https://www.zhipin.com/job_detail/verified-${jobId}.html`, status, now, now);
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

function completeAnalysis(recommendation = "primary") {
  return {
    provider: "openai_compatible",
    semanticStatus: "complete",
    recommendation,
    recommendationSchemaVersion: 2,
    fitLevel: recommendation === "primary" ? "fit" : "mostly_fit",
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
    recommendation: null,
    recommendationSchemaVersion: 2,
    evidence: { jd: ["Python RAG"], resume: ["Python RAG"] },
    hardBlockers: []
  };
}

function roleCoreUnprovenAnalysis() {
  return {
    provider: "openai_compatible",
    semanticStatus: "complete",
    recommendation: "caution",
    recommendationSchemaVersion: 2,
    fitLevel: "insufficient_evidence",
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
