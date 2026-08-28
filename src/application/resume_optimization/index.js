const {
  getCandidateProfile,
  getSearchPlan,
  listCandidateResumeVersions,
  listCandidateFacts,
  listCandidateAnswerMemories,
  listDecisionPool,
  createResumeOptimization,
  getResumeOptimization,
  listResumeOptimizations,
  saveResumeOptimizationDraft,
  activateResumeOptimization
} = require("../../core/storage");
const { prepareResumeTextForModel } = require("../../core/resume_privacy");
const {
  buildResumeEvidenceCatalog,
  validateResumeOptimizationDraft,
  normalizeResumeSuggestionDecisions,
  renderOptimizedResume
} = require("../../core/resume_optimization");
const { createFunnelAnalysisService } = require("../funnel_analysis");

function createResumeOptimizationService({ db, adapter = null, funnelAnalysisService = null } = {}) {
  if (!db) throw new Error("resume optimization service requires db");
  const funnelAnalysis = funnelAnalysisService || createFunnelAnalysisService({ db });

  return Object.freeze({
    createDraft,
    getDraft,
    listDrafts,
    saveDraft,
    activateDraft,
    dashboard
  });

  async function createDraft(input = {}) {
    const profileId = requiredId(input.profileId, "profileId");
    const plan = ownedPlan(profileId, input.planId);
    const source = ownedSource(profileId, input.sourceResumeVersionId);
    const jobs = ownedCompleteJobs(plan, input.jobIds);
    if (!adapter || typeof adapter.generateResumeOptimization !== "function") {
      throw serviceError("RESUME_OPTIMIZATION_MODEL_UNAVAILABLE", "当前深度分析模型不可用，请先检查模型设置");
    }

    const profile = getCandidateProfile(db, profileId);
    const identityNames = [profile?.displayName, profile?.profile?.candidate?.name]
      .map((value) => String(value || "").trim()).filter(Boolean);
    const prepared = prepareResumeTextForModel(source.text, {
      identity: { names: identityNames },
      originalFileName: source.fileName,
      strict: true
    });
    const facts = listCandidateFacts(db, profileId);
    const answers = applicableAnswers(listCandidateAnswerMemories(db, {
      profileId,
      activeOnly: true,
      source: "user_edited_reply",
      limit: 100
    }), jobs);
    const funnelDiagnosis = compactDiagnosis(funnelAnalysis.getDashboard({ profileId }));
    const evidenceCatalog = buildResumeEvidenceCatalog({
      sourceText: prepared.text,
      jobs,
      facts,
      answerMemories: answers,
      diagnosis: funnelDiagnosis
    });
    const modelInput = {
      sourceResume: {
        id: source.id,
        documentId: source.documentId,
        contentHash: source.contentHash,
        text: prepared.text
      },
      jobs: jobs.map(modelJob),
      candidateFacts: facts,
      answerMemories: answers,
      funnelDiagnosis,
      evidenceCatalog
    };
    const raw = await adapter.generateResumeOptimization(modelInput);
    const validated = validateResumeOptimizationDraft(raw, {
      sourceText: source.text,
      evidenceCatalog
    });
    return createResumeOptimization(db, {
      profileId,
      sourceResumeVersionId: source.id,
      targetJobIds: jobs.map((job) => job.id),
      evidenceCatalog,
      headline: validated.headline,
      suggestions: validated.suggestions,
      modelIdentity: {
        provider: String(adapter.provider || "unknown"),
        model: String(adapter.model || "")
      }
    });
  }

  function getDraft({ profileId, draftId, optimizationId } = {}) {
    return getResumeOptimization(db, {
      profileId: requiredId(profileId, "profileId"),
      optimizationId: requiredId(draftId || optimizationId, "draftId")
    });
  }

  function listDrafts({ profileId, limit = 30 } = {}) {
    return listResumeOptimizations(db, requiredId(profileId, "profileId"), limit);
  }

  function saveDraft({ profileId, draftId, optimizationId, decisions = {} } = {}) {
    const owned = getDraft({ profileId, draftId: draftId || optimizationId });
    if (!owned) throw serviceError("RESUME_OPTIMIZATION_NOT_FOUND", "定向简历草稿不存在");
    if (owned.status !== "draft") throw serviceError("RESUME_OPTIMIZATION_CLOSED", "已启用的定向简历不能继续修改");
    const suggestions = normalizeResumeSuggestionDecisions(owned.suggestions, decisions);
    const finalText = renderOptimizedResume(owned.sourceText, suggestions);
    return saveResumeOptimizationDraft(db, {
      profileId: owned.profileId,
      optimizationId: owned.id,
      suggestions,
      finalText
    });
  }

  function activateDraft({ profileId, draftId, optimizationId } = {}) {
    const owned = getDraft({ profileId, draftId: draftId || optimizationId });
    if (!owned) throw serviceError("RESUME_OPTIMIZATION_NOT_FOUND", "定向简历草稿不存在");
    const jobs = rowsForJobIds(owned.targetJobIds);
    const titles = [...new Set(jobs.map((job) => String(job.title || "").trim()).filter(Boolean))];
    return activateResumeOptimization(db, {
      profileId: owned.profileId,
      optimizationId: owned.id,
      version: {
        name: titles.length === 1 ? `${titles[0]}定向版` : "定向简历",
        targetRoles: titles,
        summary: owned.headline || "基于目标岗位证据生成并由用户确认的定向版本。"
      }
    });
  }

  function dashboard({ profileId, planId, draftId = null } = {}) {
    const profile = requiredId(profileId, "profileId");
    const plan = ownedPlan(profile, planId);
    const jobs = listDecisionPool(db, { planId: plan.id }).filter(isCompleteJob);
    const drafts = listResumeOptimizations(db, profile, 30);
    const selectedDraft = draftId
      ? getResumeOptimization(db, { profileId: profile, optimizationId: draftId })
      : drafts[0] || null;
    return {
      profile: getCandidateProfile(db, profile),
      plan,
      resumes: listCandidateResumeVersions(db, profile),
      jobs,
      drafts,
      selectedDraft,
      funnelDiagnosis: compactDiagnosis(funnelAnalysis.getDashboard({ profileId: profile }))
    };
  }

  function ownedPlan(profileId, planId) {
    const plan = getSearchPlan(db, requiredId(planId, "planId"));
    if (!plan || plan.profileId !== profileId) {
      throw serviceError("RESUME_OPTIMIZATION_PLAN_NOT_OWNED", "搜索计划不存在或不属于当前候选人");
    }
    return plan;
  }

  function ownedSource(profileId, versionId) {
    const id = requiredId(versionId, "sourceResumeVersionId");
    const row = db.prepare(`SELECT rv.id, rv.resume_document_id, rv.name,
      rd.original_file_name, rd.content_hash, rd.resume_text
      FROM candidate_resume_versions rv
      JOIN resume_documents rd ON rd.id = rv.resume_document_id
      WHERE rv.id = ? AND rv.profile_id = ?`).get(id, profileId);
    if (!row) throw serviceError("RESUME_OPTIMIZATION_SOURCE_NOT_OWNED", "源简历不存在或不属于当前候选人");
    return {
      id: Number(row.id),
      documentId: Number(row.resume_document_id),
      name: row.name,
      fileName: row.original_file_name,
      contentHash: row.content_hash,
      text: row.resume_text
    };
  }

  function ownedCompleteJobs(plan, values) {
    const ids = [...new Set((Array.isArray(values) ? values : []).map((value) => requiredId(value, "jobId")))];
    if (ids.length < 1 || ids.length > 5) throw new Error("请选择 1-5 个目标岗位");
    const pool = new Map(listDecisionPool(db, { planId: plan.id }).map((job) => [Number(job.id), job]));
    const jobs = ids.map((id) => {
      const selected = pool.get(id);
      if (!selected) throw serviceError("RESUME_OPTIMIZATION_JOB_NOT_OWNED", "目标岗位不存在或不属于当前搜索计划");
      if (!isCompleteJob(selected)) throw serviceError("RESUME_OPTIMIZATION_JOB_INCOMPLETE", "目标岗位缺少完整 JD 或岗位分析");
      return selected;
    });
    return jobs;
  }

  function rowsForJobIds(ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return db.prepare(`SELECT id, title, company FROM jobs WHERE id IN (${placeholders})`).all(...ids);
  }
}

function isCompleteJob(job) {
  const description = String(job?.description || "").trim();
  return description.length >= 20 && job?.analysis?.semanticStatus === "complete";
}

function modelJob(job) {
  return {
    id: Number(job.id),
    title: String(job.title || ""),
    company: String(job.company || ""),
    description: String(job.description || ""),
    analysis: job.analysis || {}
  };
}

function applicableAnswers(answers, jobs) {
  const jobIds = new Set(jobs.map((job) => String(job.id)));
  const companies = new Set(jobs.map((job) => String(job.company || "").trim()).filter(Boolean));
  return answers.filter((answer) => {
    const scope = answer.scope || { kind: "global", key: "" };
    if (["global", "experience"].includes(scope.kind)) return true;
    if (scope.kind === "job") return jobIds.has(String(scope.key || ""));
    if (scope.kind === "company") return companies.has(String(scope.key || "").trim());
    return false;
  });
}

function compactDiagnosis(value) {
  if (!value) return null;
  return {
    analysisSource: value.analysisSource || "",
    strength: value.currentPool?.strength || "facts",
    headline: value.headline || "",
    priorityCheck: value.priorityCheck || ""
  };
}

function requiredId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new TypeError(`${label} must be a positive integer`);
  return id;
}

function serviceError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { createResumeOptimizationService };
