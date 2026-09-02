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
  validateResumeActivationText,
  renderOptimizedResume,
  selectRepresentativeResumeJobs
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
    const targetDirection = ownedDirection(plan, input.targetDirection);
    const jobs = selectRepresentativeResumeJobs(
      listDecisionPool(db, { planId: plan.id }).filter(isCompleteJob),
      { targetDirection, limit: 5 }
    );
    if (!jobs.length) {
      throw serviceError("RESUME_OPTIMIZATION_NO_COMPLETE_JD", "当前方向还没有可核验的完整岗位信息，暂时不能生成定向简历");
    }
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
    const funnelDiagnosis = compactDiagnosis(funnelAnalysis.getDashboard({ profileId, planId: plan.id }));
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
      targetDirection,
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
    const generatedText = renderOptimizedResume(source.text, validated.suggestions);
    return createResumeOptimization(db, {
      profileId,
      planId: plan.id,
      sourceResumeVersionId: source.id,
      targetDirection,
      targetJobIds: jobs.map((job) => job.id),
      evidenceCatalog,
      headline: validated.headline,
      suggestions: validated.suggestions,
      generatedText,
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

  function saveDraft({ profileId, draftId, optimizationId, finalText } = {}) {
    const owned = getDraft({ profileId, draftId: draftId || optimizationId });
    if (!owned) throw serviceError("RESUME_OPTIMIZATION_NOT_FOUND", "定向简历草稿不存在");
    if (owned.status !== "draft") throw serviceError("RESUME_OPTIMIZATION_CLOSED", "已启用的定向简历不能继续修改");
    const saved = saveResumeOptimizationDraft(db, {
      profileId: owned.profileId,
      optimizationId: owned.id,
      finalText
    });
    return { ...saved, integrity: integrityFor(saved, saved.finalText) };
  }

  function activateDraft({ profileId, planId, draftId, optimizationId, finalText } = {}) {
    const owned = getDraft({ profileId, draftId: draftId || optimizationId });
    if (!owned) throw serviceError("RESUME_OPTIMIZATION_NOT_FOUND", "定向简历草稿不存在");
    const plan = ownedPlan(owned.profileId, planId);
    if (owned.planId !== plan.id) {
      throw serviceError("RESUME_OPTIMIZATION_PLAN_MISMATCH", "这份定向简历不属于当前投递方案，请返回原方案启用");
    }
    let integrity = null;
    if (owned.status === "draft") {
      integrity = integrityFor(owned, finalText);
      if (!integrity.valid) {
        const error = serviceError("RESUME_ACTIVATION_INTEGRITY_FAILED", "当前简历仍有需要修改的问题，尚未启用");
        error.issues = publicIssues(integrity.errors);
        throw error;
      }
    }
    const activated = activateResumeOptimization(db, {
      profileId: owned.profileId,
      planId: plan.id,
      optimizationId: owned.id,
      finalText,
      version: {
        name: owned.targetDirection ? `${owned.targetDirection}定向版` : "定向简历",
        targetRoles: owned.targetDirection ? [owned.targetDirection] : [],
        summary: owned.headline || "基于目标岗位证据生成并由用户确认的定向版本。"
      }
    });
    return { ...activated, integrity };
  }

  function dashboard({ profileId, planId, draftId = null } = {}) {
    const profile = requiredId(profileId, "profileId");
    const plan = ownedPlan(profile, planId);
    const jobs = listDecisionPool(db, { planId: plan.id }).filter(isCompleteJob);
    const drafts = listResumeOptimizations(db, profile, 30).filter((draft) => draft.planId === plan.id);
    const selectedDraft = draftId
      ? getResumeOptimization(db, { profileId: profile, optimizationId: draftId })
      : drafts[0] || null;
    const scopedDraft = selectedDraft?.planId === plan.id ? selectedDraft : null;
    return {
      profile: getCandidateProfile(db, profile),
      plan,
      resumes: listCandidateResumeVersions(db, profile),
      jobs,
      directions: Array.isArray(plan.plan?.directions) ? plan.plan.directions : [],
      drafts,
      selectedDraft: scopedDraft,
      selectedJobs: scopedDraft ? rowsForJobIds(scopedDraft.targetJobIds) : [],
      selectedIntegrity: scopedDraft?.status === "draft"
        ? integrityFor(scopedDraft, scopedDraft.finalText)
        : null,
      funnelDiagnosis: compactDiagnosis(funnelAnalysis.getDashboard({ profileId: profile, planId: plan.id }))
    };
  }

  function integrityFor(draft, finalText) {
    const source = ownedSource(draft.profileId, draft.sourceResumeVersionId);
    const profile = getCandidateProfile(db, draft.profileId);
    const answers = applicableAnswers(listCandidateAnswerMemories(db, {
      profileId: draft.profileId,
      activeOnly: true,
      source: "user_edited_reply",
      limit: 100
    }), integrityJobs(draft.targetJobIds));
    return validateResumeActivationText({
      sourceText: source.text,
      generatedText: draft.generatedText,
      finalText,
      candidateName: profile?.profile?.candidate?.name || profile?.displayName || "",
      facts: listCandidateFacts(db, draft.profileId),
      answerMemories: answers,
      suggestions: draft.changeLedger
    });
  }

  function integrityJobs(ids) {
    if (!Array.isArray(ids) || !ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return db.prepare(`SELECT id, source_id, company FROM jobs WHERE id IN (${placeholders})`)
      .all(...ids).map((row) => ({ id: Number(row.id), sourceId: row.source_id || "", company: row.company || "" }));
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

  function ownedDirection(plan, value) {
    const direction = String(value || "").trim();
    const directions = Array.isArray(plan.plan?.directions)
      ? plan.plan.directions.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    if (!direction || !directions.includes(direction)) {
      throw serviceError("RESUME_OPTIMIZATION_DIRECTION_NOT_OWNED", "目标投递方向不属于当前搜索计划");
    }
    return direction;
  }

  function rowsForJobIds(ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = new Map(db.prepare(`SELECT id, title, company FROM jobs WHERE id IN (${placeholders})`)
      .all(...ids).map((row) => [Number(row.id), { ...row, id: Number(row.id) }]));
    return ids.map((id) => rows.get(Number(id))).filter(Boolean);
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
  const jobIds = new Set(jobs.flatMap((job) => [job.id, job.sourceId].map((value) => String(value || "")).filter(Boolean)));
  const companies = new Set(jobs.map((job) => String(job.company || "").trim()).filter(Boolean));
  return answers.filter((answer) => {
    const scope = answer.scope || { kind: "global", key: "" };
    if (["global", "experience"].includes(scope.kind)) return true;
    if (scope.kind === "job") return jobIds.has(String(scope.key || ""));
    if (scope.kind === "company") return companies.has(String(scope.key || "").trim());
    return false;
  });
}

function publicIssues(items) {
  return [...new Set((Array.isArray(items) ? items : []).map((item) => String(item?.code || ""))
    .filter((code) => /^RESUME_[A-Z0-9_]+$/.test(code)))]
    .slice(0, 8)
    .map((code) => ({ code }));
}

function compactDiagnosis(value) {
  if (!value) return null;
  return {
    analysisSource: value.analysisSource || "",
    strength: value.currentRound?.strength || value.currentPool?.strength || "facts",
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
