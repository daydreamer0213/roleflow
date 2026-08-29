const {
  getCandidateProfile,
  getSearchPlan,
  listCandidateResumeVersions,
  listCandidateAnswerMemories,
  listCandidateFactRevisions,
  listDecisionPool,
  createMockInterviewSession,
  getMockInterviewSession,
  listMockInterviewSessions,
  answerMockInterviewTurn,
  completeMockInterviewSession,
  recordMockInterviewRetry
} = require("../../core/storage");
const { prepareResumeTextForModel } = require("../../core/resume_privacy");
const {
  normalizeInterviewSettings,
  buildResumeInterviewEvidenceCatalog,
  projectInterviewFacts,
  validateInterviewStep,
  validateInterviewReport,
  validateRetryReview
} = require("../../core/mock_interview");

function createMockInterviewService({ db, adapter = null } = {}) {
  if (!db) throw new Error("mock interview service requires db");
  const finishFlights = new Map();

  return Object.freeze({
    startSession,
    answerTurn,
    finishSession,
    retryTurn,
    getSession,
    listSessions,
    dashboard
  });

  async function startSession(input = {}) {
    requireAdapterMethod("generateMockInterviewStep");
    const profileId = requiredId(input.profileId, "profileId");
    const plan = ownedPlan(profileId, input.planId);
    const sessionKind = normalizeSessionKind(input.sessionKind);
    if (sessionKind === "resume_general" && input.jobId !== undefined && input.jobId !== null && input.jobId !== "") {
      throw serviceError("MOCK_INTERVIEW_GENERAL_JOB_FORBIDDEN", "简历通用面试不能绑定岗位");
    }
    const job = sessionKind === "job_specific" ? ownedCompleteJob(plan, input.jobId) : null;
    const resume = ownedResume(profileId, input.resumeVersionId);
    const settings = normalizeInterviewSettings(input.settings);
    const context = buildFrozenContext(profileId, plan.id, sessionKind, job, resume);
    const rawStep = await adapter.generateMockInterviewStep({ context, settings, turns: [] });
    const step = validateInterviewStep(rawStep, {
      turns: [],
      resumeEvidenceCatalog: context.resumeEvidenceCatalog,
      sessionKind: context.sessionKind
    });
    const session = createMockInterviewSession(db, {
      profileId,
      planId: plan.id,
      sessionKind,
      jobId: job?.id ?? null,
      resumeVersionId: resume.id,
      context,
      settings,
      initialQuestion: step.nextQuestion,
      modelIdentity: { provider: String(adapter.provider || "unknown"), model: String(adapter.model || "") }
    });
    return getSession({ profileId, planId: plan.id, sessionId: session.id });
  }

  async function answerTurn(input = {}) {
    const profileId = requiredId(input.profileId, "profileId");
    const planId = requiredId(input.planId, "planId");
    const sessionId = requiredId(input.sessionId, "sessionId");
    const turnNumber = requiredId(input.turnNumber, "turnNumber");
    const answerText = requiredText(input.answerText, "回答", 20_000);
    const session = ownedActiveSession(profileId, planId, sessionId);
    const turn = session.turns.find((item) => item.turnNumber === turnNumber);
    if (!turn) throw serviceError("MOCK_INTERVIEW_TURN_NOT_FOUND", "当前面试题不存在");
    if (turn.answerText) {
      if (turn.answerText === answerText) return session;
      throw serviceError("MOCK_INTERVIEW_TURN_ALREADY_ANSWERED", "当前问题已经回答");
    }
    requireAdapterMethod("generateMockInterviewStep");
    const last = session.turns[session.turns.length - 1];
    if (last?.turnNumber !== turnNumber) throw serviceError("MOCK_INTERVIEW_TURN_NOT_CURRENT", "只能回答当前问题");
    const turns = session.turns.map((item) => ({
      turnNumber: item.turnNumber,
      question: item.questionText,
      focus: item.questionFocus,
      answer: item.turnNumber === turnNumber ? answerText : item.answerText,
      answerReview: item.answerReview
    }));
    const rawStep = await adapter.generateMockInterviewStep({
      context: session.context,
      settings: session.settings,
      turns
    });
    const step = validateInterviewStep(rawStep, {
      turns,
      resumeEvidenceCatalog: session.context.resumeEvidenceCatalog,
      sessionKind: session.context.sessionKind
    });
    const plannedQuestions = Number(session.settings.plannedQuestions);
    if (turns.length < plannedQuestions && step.complete) {
      throw serviceError("MOCK_INTERVIEW_STEP_TOO_EARLY", "模型在达到计划题数前结束了面试，本次回答未保存");
    }
    if (turns.length >= plannedQuestions && !step.complete) {
      throw serviceError("MOCK_INTERVIEW_STEP_TOO_LATE", "模型达到计划题数后仍继续出题，本次回答未保存");
    }
    answerMockInterviewTurn(db, {
      profileId,
      planId,
      sessionId,
      turnNumber,
      answerText,
      answerReview: step.answerReview,
      nextQuestion: step.nextQuestion
    });
    return getSession({ profileId, planId, sessionId });
  }

  async function finishSession(input = {}) {
    const profileId = requiredId(input.profileId, "profileId");
    const planId = requiredId(input.planId, "planId");
    const sessionId = requiredId(input.sessionId, "sessionId");
    const session = getSession({ profileId, planId, sessionId });
    if (!session) throw serviceError("MOCK_INTERVIEW_NOT_FOUND", "面试会话不存在");
    if (session.status === "completed" && session.report) return session;
    if (session.status !== "active") throw serviceError("MOCK_INTERVIEW_COMPLETED", "面试已经结束");
    const flightKey = `${profileId}:${planId}:${sessionId}`;
    if (finishFlights.has(flightKey)) return finishFlights.get(flightKey);
    const operation = (async () => {
      requireAdapterMethod("reviewMockInterview");
      if (!session.turns.length || session.turns.some((turn) => !turn.answerText)) {
        throw serviceError("MOCK_INTERVIEW_INCOMPLETE", "请先完成当前问题");
      }
      if (session.turns.length < Number(session.settings.plannedQuestions || 0)) {
        throw serviceError("MOCK_INTERVIEW_INCOMPLETE", "当前训练还没有达到计划题数");
      }
      const rawReport = await adapter.reviewMockInterview({
        context: session.context,
        settings: session.settings,
        turns: modelTurns(session.turns)
      });
      const report = validateInterviewReport(rawReport, { turns: session.turns });
      return completeMockInterviewSession(db, { profileId, planId, sessionId, report });
    });
    const result = operation();
    finishFlights.set(flightKey, result);
    try {
      return await result;
    } finally {
      if (finishFlights.get(flightKey) === result) finishFlights.delete(flightKey);
    }
  }

  async function retryTurn(input = {}) {
    const profileId = requiredId(input.profileId, "profileId");
    const planId = requiredId(input.planId, "planId");
    const sessionId = requiredId(input.sessionId, "sessionId");
    const turnNumber = requiredId(input.turnNumber, "turnNumber");
    const answerText = requiredText(input.answerText, "重答", 20_000);
    const session = getSession({ profileId, planId, sessionId });
    if (!session) throw serviceError("MOCK_INTERVIEW_NOT_FOUND", "面试会话不存在");
    if (session.status !== "completed") throw serviceError("MOCK_INTERVIEW_INCOMPLETE", "面试结束后才能重练");
    const turn = session.turns.find((item) => item.turnNumber === turnNumber && item.answerText);
    if (!turn) throw serviceError("MOCK_INTERVIEW_TURN_NOT_FOUND", "已回答的面试题不存在");
    const existingRetry = turn.retries[turn.retries.length - 1];
    if (existingRetry?.answerText === answerText) return existingRetry;
    requireAdapterMethod("reviewMockInterviewRetry");
    const rawReview = await adapter.reviewMockInterviewRetry({
      context: session.context,
      settings: session.settings,
      turn: {
        turnNumber: turn.turnNumber,
        question: turn.questionText,
        originalAnswer: turn.answerText,
        originalReview: turn.answerReview,
        retryAnswer: answerText,
        earlierRetries: turn.retries
      }
    });
    const review = validateRetryReview(rawReview, { turnNumber });
    return recordMockInterviewRetry(db, { profileId, planId, sessionId, turnNumber, answerText, review });
  }

  function getSession({ profileId, planId, sessionId } = {}) {
    return hydrateSessionContext(getMockInterviewSession(db, {
      profileId: requiredId(profileId, "profileId"),
      planId: requiredId(planId, "planId"),
      sessionId: requiredId(sessionId, "sessionId")
    }));
  }

  function listSessions({ profileId, planId, sessionKind = "", limit = 30 } = {}) {
    return listMockInterviewSessions(db, {
      profileId: requiredId(profileId, "profileId"),
      planId: requiredId(planId, "planId"),
      sessionKind,
      limit
    }).map(hydrateSessionContext);
  }

  function dashboard({ profileId, planId, sessionId = null } = {}) {
    const profile = requiredId(profileId, "profileId");
    const plan = ownedPlan(profile, planId);
    const sessions = listMockInterviewSessions(db, { profileId: profile, planId: plan.id, limit: 30 })
      .map(hydrateSessionContext);
    return {
      profile: getCandidateProfile(db, profile),
      plan,
      jobs: listDecisionPool(db, { planId: plan.id }).filter(isCompleteJob),
      resumes: listCandidateResumeVersions(db, profile).filter((resume) => resume.isActive),
      sessions,
      selectedSession: sessionId
        ? hydrateSessionContext(getMockInterviewSession(db, { profileId: profile, planId: plan.id, sessionId }))
        : sessions[0] || null
    };
  }

  function buildFrozenContext(profileId, planId, sessionKind, job, resume) {
    const profile = getCandidateProfile(db, profileId);
    const names = [profile?.displayName, profile?.profile?.candidate?.name]
      .map((value) => String(value || "").trim()).filter(Boolean);
    const prepared = prepareResumeTextForModel(resume.text, {
      identity: { names }, originalFileName: resume.fileName, strict: true
    });
    const allowedScopeKinds = sessionKind === "resume_general"
      ? ["global", "experience"]
      : ["global", "experience", "job", "company"];
    const activeAnswers = applicableAnswers(listCandidateAnswerMemories(db, {
      profileId,
      activeOnly: true,
      source: "user_edited_reply",
      limit: 100
    }), { sessionKind, job });
    const factMemories = listCandidateAnswerMemories(db, {
      profileId,
      activeOnly: false,
      source: "user_edited_reply",
      limit: 500
    }).filter((memory) => !memory.withdrawnAt);
    const historyQuery = sessionKind === "resume_general"
      ? { profileId, sessionKind, limit: 30 }
      : { profileId, planId, sessionKind, limit: 30 };
    const priorWeaknesses = listMockInterviewSessions(db, historyQuery)
      .filter((session) => session.status === "completed" && session.report)
      .flatMap((session) => [
        ...(session.report.improvements || []),
        ...(session.report.retryRecommendations || []).map((item) => item.reason)
      ]).filter(Boolean).slice(0, 8);
    return {
      sessionKind,
      job: job ? {
        id: Number(job.id),
        title: String(job.title || ""),
        company: String(job.company || ""),
        description: String(job.description || ""),
        analysis: job.analysis || {}
      } : null,
      resume: {
        versionId: resume.id,
        name: resume.name,
        contentHash: resume.contentHash,
        text: prepared.text
      },
      resumeEvidenceCatalog: buildResumeInterviewEvidenceCatalog(prepared.text),
      candidateFacts: projectInterviewFacts({
        factRevisions: listCandidateFactRevisions(db, { profileId, limit: 2000 }),
        answerMemories: factMemories,
        allowedScopeKinds
      }),
      answerMemories: activeAnswers,
      priorWeaknesses
    };
  }

  function hydrateSessionContext(session) {
    if (!session) return null;
    const context = session.context && typeof session.context === "object" ? session.context : {};
    const resumeEvidenceCatalog = Array.isArray(context.resumeEvidenceCatalog) && context.resumeEvidenceCatalog.length
      ? context.resumeEvidenceCatalog
      : buildResumeInterviewEvidenceCatalog(context.resume?.text);
    return {
      ...session,
      context: {
        ...context,
        sessionKind: context.sessionKind || session.sessionKind,
        resumeEvidenceCatalog
      }
    };
  }

  function ownedPlan(profileId, planId) {
    const plan = getSearchPlan(db, requiredId(planId, "planId"));
    if (!plan || plan.profileId !== profileId) {
      throw serviceError("MOCK_INTERVIEW_PLAN_NOT_OWNED", "搜索计划不存在或不属于当前候选人");
    }
    return plan;
  }

  function ownedCompleteJob(plan, jobId) {
    const id = requiredId(jobId, "jobId");
    const job = listDecisionPool(db, { planId: plan.id }).find((item) => Number(item.id) === id);
    if (!job) throw serviceError("MOCK_INTERVIEW_JOB_NOT_OWNED", "岗位不存在或不属于当前搜索计划");
    if (!isCompleteJob(job)) throw serviceError("MOCK_INTERVIEW_JOB_INCOMPLETE", "岗位缺少完整 JD 或岗位分析");
    return job;
  }

  function ownedResume(profileId, resumeVersionId) {
    const id = requiredId(resumeVersionId, "resumeVersionId");
    const row = db.prepare(`SELECT rv.id, rv.name, rd.original_file_name, rd.content_hash, rd.resume_text
      FROM candidate_resume_versions rv JOIN resume_documents rd ON rd.id = rv.resume_document_id
      WHERE rv.id = ? AND rv.profile_id = ? AND rv.is_active = 1`).get(id, profileId);
    if (!row) throw serviceError("MOCK_INTERVIEW_RESUME_NOT_OWNED", "启用中的简历不存在或不属于当前候选人");
    return {
      id: Number(row.id),
      name: row.name,
      fileName: row.original_file_name,
      contentHash: row.content_hash,
      text: row.resume_text
    };
  }

  function ownedActiveSession(profileId, planId, sessionId) {
    const session = hydrateSessionContext(getMockInterviewSession(db, { profileId, planId, sessionId }));
    if (!session) throw serviceError("MOCK_INTERVIEW_NOT_FOUND", "面试会话不存在");
    if (session.status !== "active") throw serviceError("MOCK_INTERVIEW_COMPLETED", "面试已经结束");
    return session;
  }

  function requireAdapterMethod(name) {
    if (!adapter || typeof adapter[name] !== "function") {
      throw serviceError("MOCK_INTERVIEW_MODEL_UNAVAILABLE", "当前深度分析模型不可用，请先检查模型设置");
    }
  }
}

function modelTurns(turns) {
  return turns.map((turn) => ({
    turnNumber: turn.turnNumber,
    question: turn.questionText,
    focus: turn.questionFocus,
    answer: turn.answerText,
    answerReview: turn.answerReview
  }));
}

function applicableAnswers(answers, { sessionKind, job }) {
  return answers.filter((answer) => {
    const scope = answer.scope || { kind: "global", key: "" };
    if (["global", "experience"].includes(scope.kind)) return true;
    if (sessionKind === "resume_general" || !job) return false;
    if (scope.kind === "job") return String(scope.key || "") === String(job.id);
    if (scope.kind === "company") return String(scope.key || "").trim() === String(job.company || "").trim();
    return false;
  });
}

function normalizeSessionKind(value) {
  const kind = String(value || "resume_general").trim();
  if (!["resume_general", "job_specific"].includes(kind)) {
    throw new Error(`不支持的面试场景：${kind}`);
  }
  return kind;
}

function isCompleteJob(job) {
  return String(job?.description || "").trim().length >= 20 && job?.analysis?.semanticStatus === "complete";
}

function requiredId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new TypeError(`${label} must be a positive integer`);
  return id;
}

function requiredText(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (text.length > maxLength) throw new Error(`${label}过长`);
  return text;
}

function serviceError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { createMockInterviewService };
