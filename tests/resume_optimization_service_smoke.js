const assert = require("node:assert");
const storage = require("../src/core/storage");
const { createResumeOptimizationService } = require("../src/application/resume_optimization");
const { MockModelAdapter } = require("../src/adapters/models/mock");

function profile(name) {
  return {
    candidate: { name, city: "广州", targetTitles: ["AI 应用工程师"] },
    skills: [{ name: "Node.js" }],
    projects: [{ name: "企业知识库", canSay: ["参与知识库开发"] }]
  };
}

function document(hash, name) {
  const text = `${name}\n个人总结\n参与企业知识库开发\n技能：Node.js`;
  return {
    originalFileName: `${name}.txt`,
    format: "text",
    contentHash: hash,
    text,
    diagnostics: { extractionMethod: "text", inputBytes: Buffer.byteLength(text) }
  };
}

function job(sourceId, overrides = {}) {
  return {
    source: "boss",
    sourceId,
    keyword: "AI 应用工程师",
    title: "AI 应用工程师",
    company: "示例科技",
    location: "广州",
    salary: "15-25K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
    tags: ["Node.js", "知识库"],
    description: "负责 Node.js 企业知识库应用开发、检索评估和接口交付，要求具备完整项目经验。",
    score: 18,
    level: "可投",
    matches: ["Node.js"],
    risks: [],
    qualityTags: [],
    analysis: {
      provider: "mock",
      model: "offline",
      semanticStatus: "complete",
      recommendation: "apply",
      evidence: { jd: ["JD：负责 Node.js 企业知识库应用开发"], resume: ["简历：参与企业知识库开发"] }
    },
    ...overrides
  };
}

const db = storage.openDb(":memory:");

(async () => {
try {
  const owner = storage.saveProfileAnalysis(db, {
    profile: profile("候选人甲"),
    document: document("resume-owner", "候选人甲"),
    searchPlan: { name: "Owner plan", cities: ["广州"], directions: ["AI 应用工程师"], keywords: [{ word: "知识库", priority: "A" }] }
  });
  const other = storage.saveProfileAnalysis(db, {
    profile: profile("候选人乙"),
    document: document("resume-other", "候选人乙"),
    searchPlan: { name: "Other plan", cities: ["深圳"], directions: ["后端工程师"], keywords: [{ word: "后端", priority: "A" }] }
  });
  const ownerBatch = storage.createBatch(db, "boss", "知识库", "resume optimization service", {
    profileId: owner.profileId,
    searchPlanId: owner.planId
  });
  const validJobId = storage.upsertJob(db, job("resume-service-valid"), ownerBatch);
  const representativeJobIds = [validJobId];
  for (const [index, company] of ["示例科技", "甲公司", "乙公司", "丙公司", "丁公司"].entries()) {
    representativeJobIds.push(storage.upsertJob(db, job(`resume-service-${index + 2}`, {
      company,
      analysis: {
        ...job("analysis-template").analysis,
        recommendation: index === 0 ? "primary" : index === 1 ? "caution" : "apply",
        realRoleType: "AI 应用工程师",
        businessScenario: `企业知识库场景 ${index + 2}`
      }
    }), ownerBatch));
  }
  const incompleteJobId = storage.upsertJob(db, job("resume-service-incomplete", {
    description: "",
    analysis: { semanticStatus: "failed", errorCode: "MODEL_TIMEOUT" }
  }), ownerBatch);

  storage.saveCandidateFact(db, {
    profileId: owner.profileId,
    factKey: "availability",
    factValue: "两周内到岗",
    source: "user_provided"
  });
  const now = "2026-08-29T03:00:00.000Z";
  const cardId = Number(db.prepare(`INSERT INTO candidate_progress_cards(
    profile_id, plan_id, job_id, source, stage, next_action, last_event_at, created_at, updated_at
  ) VALUES (?, ?, ?, 'boss', 'reply_ready', '处理草稿', ?, ?, ?)`)
    .run(owner.profileId, owner.planId, validJobId, now, now, now).lastInsertRowid);
  const [replyDraft] = storage.recordMessageReplyDrafts(db, {
    profileId: owner.profileId,
    cardId,
    jobId: validJobId,
    messageGroupKey: `sha256:${require("node:crypto").createHash("sha256").update("resume-service-memory").digest("hex")}`,
    questionSummary: "到岗时间",
    messageIntent: "availability",
    messageCategory: "basic",
    messages: ["一个月内可以到岗"],
    createdAt: now
  });
  storage.completeMessageReplyDraft(db, {
    profileId: owner.profileId,
    draftId: replyDraft.id,
    finalText: "两周内可以到岗",
    changedText: "两周内可以到岗",
    completionKind: "copied",
    scope: { kind: "global", key: "" },
    extractedFacts: [],
    completedAt: now
  });

  const calls = [];
  const adapter = {
    provider: "scripted",
    model: "resume-test",
    async generateResumeOptimization(input) {
      calls.push(input);
      return {
        headline: "突出知识库项目与 Node.js 技术栈",
        suggestions: [{
          id: "S1",
          operation: "replace",
          originalText: "参与企业知识库开发",
          proposedText: "参与 Node.js 企业知识库开发",
          reason: "补充简历中已有且岗位需要的技术栈",
          evidenceIds: ["R3", "R4", "J1"],
          editingPrinciple: "jd_vocabulary"
        }]
      };
    }
  };
  const service = createResumeOptimizationService({ db, adapter });

  assert.rejects(() => service.createDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    sourceResumeVersionId: owner.resumeVersionId,
    targetDirection: "后端工程师"
  }), (error) => error.code === "RESUME_OPTIMIZATION_DIRECTION_NOT_OWNED");
  assert.rejects(() => service.createDraft({
    profileId: other.profileId,
    planId: other.planId,
    sourceResumeVersionId: other.resumeVersionId,
    targetDirection: "后端工程师"
  }), (error) => error.code === "RESUME_OPTIMIZATION_NO_COMPLETE_JD");

  const rowsBeforeMalformed = db.prepare("SELECT count(*) AS n FROM resume_optimizations").get().n;
  const malformedService = createResumeOptimizationService({
    db,
    adapter: {
      provider: "scripted",
      model: "malformed",
      async generateResumeOptimization() {
        return { headline: "错误", suggestions: [{
          id: "S1",
          operation: "replace",
          originalText: "不存在的原文",
          proposedText: "改写",
          reason: "错误",
          evidenceIds: ["R1"],
          editingPrinciple: "concision"
        }] };
      }
    }
  });
  await assert.rejects(() => malformedService.createDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    sourceResumeVersionId: owner.resumeVersionId,
    targetDirection: "AI 应用工程师"
  }), /原文/);
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM resume_optimizations").get().n, rowsBeforeMalformed);

  const draft = await service.createDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    sourceResumeVersionId: owner.resumeVersionId,
    targetDirection: "AI 应用工程师"
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].sourceResume.id, owner.resumeVersionId);
  assert(calls[0].sourceResume.text.includes("参与企业知识库开发"));
  assert(!calls[0].sourceResume.text.includes("候选人甲"), "model input must redact the candidate identity");
  assert(draft.targetJobIds.length >= 3 && draft.targetJobIds.length <= 5);
  assert(!draft.targetJobIds.includes(incompleteJobId));
  const selectedJobs = calls[0].jobs;
  assert.strictEqual(new Set(selectedJobs.map((item) => item.company)).size, selectedJobs.length);
  assert(selectedJobs.every((item) => representativeJobIds.includes(item.id)));
  assert(selectedJobs.every((item) => item.description === job("expected").description));
  assert(selectedJobs.every((item) => item.analysis.semanticStatus === "complete"));
  assert(calls[0].evidenceCatalog.some((item) => item.kind === "fact" && item.text.includes("两周内到岗")));
  assert(calls[0].evidenceCatalog.some((item) => item.kind === "answer" && item.text.includes("两周内可以到岗")));
  assert.strictEqual(draft.targetDirection, "AI 应用工程师");
  assert.match(draft.generatedText, /Node\.js 企业知识库/);
  assert.strictEqual(draft.finalText, draft.generatedText);
  assert.strictEqual(draft.changeLedger[0].editingPrinciple, "jd_vocabulary");
  assert.strictEqual(draft.suggestions[0].decision, "accepted");
  assert.strictEqual(draft.modelIdentity.provider, "scripted");

  const saved = service.saveDraft({
    profileId: owner.profileId,
    draftId: draft.id,
    finalText: `${draft.finalText}\n用户补充：已校对`
  });
  assert(saved.finalText.includes("用户补充：已校对"));
  assert(!saved.finalText.includes("参与企业知识库开发"));

  const activated = service.activateDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    draftId: draft.id,
    finalText: saved.finalText
  });
  assert.strictEqual(activated.status, "activated");
  assert(storage.listCandidateResumeVersions(db, owner.profileId).some((version) => version.id === activated.resultResumeVersionId));
  const activatedVersion = storage.listCandidateResumeVersions(db, owner.profileId)
    .find((version) => version.id === activated.resultResumeVersionId);
  assert.strictEqual(activatedVersion.name, "AI 应用工程师定向版");
  assert.deepStrictEqual(activatedVersion.targetRoles, ["AI 应用工程师"]);
  const strategyRound = storage.getActiveFunnelStrategyRound(db, {
    profileId: owner.profileId,
    planId: owner.planId
  });
  assert.strictEqual(activated.strategyRoundId, strategyRound.id);
  assert.strictEqual(strategyRound.sourceKey, `resume_optimization:${draft.id}`);

  const dashboard = service.dashboard({ profileId: owner.profileId, planId: owner.planId, draftId: draft.id });
  assert.strictEqual(dashboard.selectedDraft.id, draft.id);
  assert(dashboard.resumes.some((resume) => resume.id === activated.resultResumeVersionId));
  assert(dashboard.jobs.some((item) => item.id === validJobId));
  assert(!dashboard.jobs.some((item) => item.id === incompleteJobId));
  assert.deepStrictEqual(dashboard.directions, ["AI 应用工程师"]);
  assert.deepStrictEqual(new Set(dashboard.selectedJobs.map((item) => item.id)), new Set(draft.targetJobIds));

  const mockDraft = await createResumeOptimizationService({ db, adapter: new MockModelAdapter() }).createDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    sourceResumeVersionId: owner.resumeVersionId,
    targetDirection: "AI 应用工程师"
  });
  assert.strictEqual(mockDraft.suggestions[0].originalText, "参与企业知识库开发");

  console.log("resume_optimization_service_smoke ok");
} finally {
  db.close();
}
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
