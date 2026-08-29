const INTERVIEW_TYPES = new Set(["general", "technical", "behavioral", "mixed"]);
const INTERVIEW_DIFFICULTIES = new Set(["warmup", "standard", "challenging"]);

function cleanText(value, maxLength, label, { required = true } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new Error(`${label}不能为空`);
  if (text.length > maxLength) throw new Error(`${label}过长`);
  return text;
}

function boundedTextArray(value, label, { maxItems = 6, itemLength = 1_000 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label}格式无效`);
  return value.map((item) => cleanText(item, itemLength, label));
}

function buildResumeInterviewEvidenceCatalog(sourceText) {
  const lines = String(sourceText ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("简历证据不能为空");
  return lines.map((text, index) => ({ id: `R${index + 1}`, kind: "resume", text }));
}

function projectInterviewFacts({ factRevisions = [], answerMemories = [], allowedScopeKinds = [] } = {}) {
  const allowedScopes = new Set(allowedScopeKinds.map((kind) => String(kind || "").trim()).filter(Boolean));
  const memoriesById = new Map((Array.isArray(answerMemories) ? answerMemories : [])
    .filter((memory) => memory && !memory.withdrawnAt)
    .map((memory) => [Number(memory.id), memory]));
  const newestByKey = new Map();

  for (const revision of Array.isArray(factRevisions) ? factRevisions : []) {
    if (!revision || revision.withdrawnAt) continue;
    const factKey = String(revision.factKey || "").trim();
    if (!factKey) continue;
    const memoryId = Number(revision.answerMemoryId || 0);
    const memory = memoryId ? memoriesById.get(memoryId) : null;
    if (memoryId && (!memory || !allowedScopes.has(String(memory.scope?.kind || "")))) continue;
    const rankedAt = Date.parse(memory ? memory.updatedAt : revision.createdAt);
    const rank = Number.isFinite(rankedAt) ? rankedAt : 0;
    const id = Number(revision.id || 0);
    const current = newestByKey.get(factKey);
    if (!current || rank > current.rank || (rank === current.rank && id > current.id)) {
      newestByKey.set(factKey, { revision, rank, id });
    }
  }

  return [...newestByKey.entries()]
    .filter(([, selected]) => selected.revision.operation !== "delete")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([factKey, selected]) => ({
      factKey,
      factValue: String(selected.revision.factValue ?? ""),
      source: String(selected.revision.source || "")
    }));
}

function normalizeInterviewSettings(input = {}) {
  const type = cleanText(input.type || "mixed", 30, "面试类型");
  if (!INTERVIEW_TYPES.has(type)) throw new Error(`不支持的面试类型：${type}`);
  const difficulty = cleanText(input.difficulty || "standard", 30, "面试难度");
  if (!INTERVIEW_DIFFICULTIES.has(difficulty)) throw new Error(`不支持的面试难度：${difficulty}`);
  const plannedQuestions = Number(input.plannedQuestions ?? 6);
  if (!Number.isInteger(plannedQuestions) || plannedQuestions < 3 || plannedQuestions > 12) {
    throw new Error("计划题数必须为 3-12");
  }
  return { type, difficulty, plannedQuestions };
}

function turnNumberSet(turns) {
  return new Set((Array.isArray(turns) ? turns : []).map((turn) => Number(turn.turnNumber))
    .filter((value) => Number.isInteger(value) && value > 0));
}

function normalizeTurnNumbers(value, validTurns, label) {
  if (!Array.isArray(value) || value.length > 12) throw new Error(`${label}题号格式无效`);
  const numbers = [...new Set(value.map(Number))];
  for (const turnNumber of numbers) {
    if (!Number.isInteger(turnNumber) || !validTurns.has(turnNumber)) {
      throw new Error(`${label}引用了不存在的题号：${turnNumber}`);
    }
  }
  return numbers;
}

function normalizeAnswerReview(value, validTurns) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("回答复盘格式无效");
  return {
    conclusion: cleanText(value.conclusion, 2_000, "回答结论"),
    strengths: boundedTextArray(value.strengths, "回答优点"),
    improvements: boundedTextArray(value.improvements, "回答改进点"),
    turnNumbers: normalizeTurnNumbers(value.turnNumbers, validTurns, "回答复盘")
  };
}

function normalizeQuestion(value, evidenceById) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("下一题格式无效");
  const basedOn = value.basedOnTurnNumber;
  const resumeEvidenceIds = [...new Set((Array.isArray(value.resumeEvidenceIds) ? value.resumeEvidenceIds : [])
    .map((item) => String(item || "").trim()).filter(Boolean))];
  if (resumeEvidenceIds.length < 1 || resumeEvidenceIds.length > 4) throw new Error("问题必须引用 1-4 条简历证据");
  for (const evidenceId of resumeEvidenceIds) {
    if (!evidenceById.has(evidenceId)) throw new Error(`问题引用了不存在的简历证据：${evidenceId}`);
  }
  return {
    text: cleanText(value.text, 4_000, "问题"),
    focus: cleanText(value.focus, 120, "问题重点"),
    resumeEvidenceIds,
    basedOnTurnNumber: basedOn === null || basedOn === undefined || basedOn === ""
      ? null
      : Number(basedOn),
    answerEvidence: cleanText(value.answerEvidence, 300, "回答片段", { required: false })
  };
}

function validateInterviewStep(raw, context = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("面试步骤格式无效");
  const turns = Array.isArray(context.turns) ? context.turns : [];
  const resumeEvidenceCatalog = Array.isArray(context.resumeEvidenceCatalog) ? context.resumeEvidenceCatalog : [];
  const evidenceById = new Map(resumeEvidenceCatalog.map((item) => [String(item?.id || "").trim(), item]));
  if (turns.length === 0 && raw.answerReview != null) throw new Error("首题不能包含回答复盘");
  const validTurns = turnNumberSet(turns);
  const complete = raw.complete === true;
  const answerReview = raw.answerReview == null ? null : normalizeAnswerReview(raw.answerReview, validTurns);
  const nextQuestion = raw.nextQuestion == null ? null : normalizeQuestion(raw.nextQuestion, evidenceById);

  if (turns.length > 0 && !answerReview) throw new Error("回答后必须先生成复盘");
  if (turns.length > 0) {
    const latestTurnNumber = Number(turns[turns.length - 1].turnNumber);
    if (!answerReview.turnNumbers.includes(latestTurnNumber)) {
      throw new Error("回答复盘必须引用刚回答的上一题");
    }
  }
  if (complete && nextQuestion) throw new Error("面试结束时不能同时生成下一题");
  if (!complete && !nextQuestion) throw new Error("未结束时必须生成下一题");

  if (nextQuestion) {
    if (turns.length === 0 && nextQuestion.basedOnTurnNumber !== null) {
      throw new Error("首题不能引用上一题");
    }
    if (turns.length === 0 && nextQuestion.answerEvidence) {
      throw new Error("首题不能包含上一回答片段");
    }
    if (turns.length > 0) {
      const previousTurnNumber = Number(turns[turns.length - 1].turnNumber);
      if (nextQuestion.basedOnTurnNumber !== previousTurnNumber) {
        throw new Error("追问必须引用上一题回答");
      }
      const previousAnswer = String(turns[turns.length - 1].answer || "");
      if (!nextQuestion.answerEvidence
        || !previousAnswer.includes(nextQuestion.answerEvidence)
        || !nextQuestion.text.includes(nextQuestion.answerEvidence)) {
        throw new Error("追问必须用上一题回答中的真实回答片段承接");
      }
    }
  }

  return { answerReview, nextQuestion, complete };
}

function rejectProbabilityFields(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/offer.*probab|probab.*offer|录用.*概率/i.test(key)) throw new Error("复盘不能包含录用概率");
    rejectProbabilityFields(child);
  }
}

function normalizeTurnReasonItems(value, validTurns, label) {
  if (!Array.isArray(value) || value.length > 12) throw new Error(`${label}格式无效`);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label}格式无效`);
    const turnNumber = Number(item.turnNumber);
    if (!Number.isInteger(turnNumber) || !validTurns.has(turnNumber)) {
      throw new Error(`${label}引用了不存在的题号：${turnNumber}`);
    }
    return { turnNumber, reason: cleanText(item.reason, 1_000, `${label}理由`) };
  });
}

function validateInterviewReport(raw, context = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("面试复盘格式无效");
  rejectProbabilityFields(raw);
  const validTurns = turnNumberSet(context.turns);
  const answerStructures = Array.isArray(raw.answerStructures) ? raw.answerStructures.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("回答结构格式无效");
    const turnNumber = Number(item.turnNumber);
    if (!Number.isInteger(turnNumber) || !validTurns.has(turnNumber)) {
      throw new Error(`回答结构引用了不存在的题号：${turnNumber}`);
    }
    return { turnNumber, outline: boundedTextArray(item.outline, "回答结构", { maxItems: 8, itemLength: 500 }) };
  }) : (() => { throw new Error("回答结构格式无效"); })();
  if (answerStructures.length > 12) throw new Error("回答结构过多");
  return {
    conclusion: cleanText(raw.conclusion, 3_000, "复盘结论"),
    strengths: boundedTextArray(raw.strengths, "最强项", { maxItems: 3 }),
    improvements: boundedTextArray(raw.improvements, "改进项", { maxItems: 3 }),
    followUpRisks: normalizeTurnReasonItems(raw.followUpRisks, validTurns, "追问风险"),
    retryRecommendations: normalizeTurnReasonItems(raw.retryRecommendations, validTurns, "重练建议"),
    answerStructures
  };
}

function validateRetryReview(raw, context = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("重答复盘格式无效");
  rejectProbabilityFields(raw);
  const expectedTurnNumber = Number(context.turnNumber);
  const turnNumber = Number(raw.turnNumber);
  if (!Number.isInteger(turnNumber) || turnNumber !== expectedTurnNumber) throw new Error("重答复盘题号不匹配");
  if (typeof raw.improved !== "boolean") throw new Error("重答改进结果格式无效");
  return {
    turnNumber,
    conclusion: cleanText(raw.conclusion, 2_000, "重答结论"),
    improved: raw.improved,
    strengths: boundedTextArray(raw.strengths, "重答优点"),
    remainingImprovements: boundedTextArray(raw.remainingImprovements, "剩余改进点")
  };
}

module.exports = {
  normalizeInterviewSettings,
  buildResumeInterviewEvidenceCatalog,
  projectInterviewFacts,
  validateInterviewStep,
  validateInterviewReport,
  validateRetryReview
};
