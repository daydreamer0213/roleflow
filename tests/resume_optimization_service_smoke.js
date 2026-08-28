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
  const incompleteJobId = storage.upsertJob(db, job("resume-service-incomplete", {
    description: "",
    analysis: { semanticStatus: "failed", errorCode: "MODEL_TIMEOUT" }
  }), ownerBatch);
  const otherBatch = storage.createBatch(db, "boss", "后端", "other profile", {
    profileId: other.profileId,
    searchPlanId: other.planId
  });
  const otherJobId = storage.upsertJob(db, job("resume-service-other", { company: "其他公司" }), otherBatch);

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
          evidenceIds: ["R3", "R4", "J1"]
        }]
      };
    }
  };
  const service = createResumeOptimizationService({ db, adapter });

  assert.rejects(() => service.createDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    sourceResumeVersionId: owner.resumeVersionId,
    jobIds: [otherJobId]
  }), (error) => error.code === "RESUME_OPTIMIZATION_JOB_NOT_OWNED");
  assert.rejects(() => service.createDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    sourceResumeVersionId: owner.resumeVersionId,
    jobIds: [incompleteJobId]
  }), (error) => error.code === "RESUME_OPTIMIZATION_JOB_INCOMPLETE");

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
          evidenceIds: ["R1"]
        }] };
      }
    }
  });
  await assert.rejects(() => malformedService.createDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    sourceResumeVersionId: owner.resumeVersionId,
    jobIds: [validJobId]
  }), /原文/);
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM resume_optimizations").get().n, rowsBeforeMalformed);

  const draft = await service.createDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    sourceResumeVersionId: owner.resumeVersionId,
    jobIds: [validJobId]
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].sourceResume.id, owner.resumeVersionId);
  assert(calls[0].sourceResume.text.includes("参与企业知识库开发"));
  assert(!calls[0].sourceResume.text.includes("候选人甲"), "model input must redact the candidate identity");
  assert.deepStrictEqual(calls[0].jobs.map((item) => item.id), [validJobId]);
  assert.strictEqual(calls[0].jobs[0].description, job("expected").description);
  assert.strictEqual(calls[0].jobs[0].analysis.semanticStatus, "complete");
  assert(calls[0].evidenceCatalog.some((item) => item.kind === "fact" && item.text.includes("两周内到岗")));
  assert(calls[0].evidenceCatalog.some((item) => item.kind === "answer" && item.text.includes("两周内可以到岗")));
  assert.strictEqual(draft.suggestions[0].decision, "pending");
  assert.strictEqual(draft.modelIdentity.provider, "scripted");

  const saved = service.saveDraft({
    profileId: owner.profileId,
    draftId: draft.id,
    decisions: { S1: { decision: "edited", userText: "参与 Node.js 知识库应用开发" } }
  });
  assert(saved.finalText.includes("参与 Node.js 知识库应用开发"));
  assert(!saved.finalText.includes("参与企业知识库开发"));

  const activated = service.activateDraft({ profileId: owner.profileId, draftId: draft.id });
  assert.strictEqual(activated.status, "activated");
  assert(storage.listCandidateResumeVersions(db, owner.profileId).some((version) => version.id === activated.resultResumeVersionId));

  const dashboard = service.dashboard({ profileId: owner.profileId, planId: owner.planId, draftId: draft.id });
  assert.strictEqual(dashboard.selectedDraft.id, draft.id);
  assert(dashboard.resumes.some((resume) => resume.id === activated.resultResumeVersionId));
  assert(dashboard.jobs.some((item) => item.id === validJobId));
  assert(!dashboard.jobs.some((item) => item.id === incompleteJobId));

  const mockDraft = await createResumeOptimizationService({ db, adapter: new MockModelAdapter() }).createDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    sourceResumeVersionId: owner.resumeVersionId,
    jobIds: [validJobId]
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
