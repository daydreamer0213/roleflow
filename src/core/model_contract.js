class ModelContractError extends Error {
  constructor(kind, message) {
    super(`${kind} 模型输出不符合契约：${message}`);
    this.name = "ModelContractError";
    this.code = "MODEL_CONTRACT_INVALID";
    this.statusCode = 422;
  }
}

function validateModelResult(kind, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelContractError(kind, "必须返回 JSON 对象");
  if (kind === "analyzeResume") return validateResume(value);
  if (kind === "recommendSearchPlan") return validateSearchPlan(value);
  if (kind === "understandJob") return validateJobUnderstanding(value);
  if (kind === "matchJob") return validateMatchDecision(value);
  if (kind === "draftCommunication") return validateCommunication(value);
  throw new ModelContractError(kind, "未知分析类型");
}

function validateResume(value) {
  const candidate = object(value.candidate);
  if (!candidate.name && !list(candidate.targetTitles).length) throw new ModelContractError("analyzeResume", "缺少候选人基本信息");
  return {
    ...value,
    candidate: {
      ...candidate,
      name: text(candidate.name || "候选人"),
      city: text(candidate.city),
      targetTitles: strings(candidate.targetTitles || candidate.target_roles || candidate.directions, 12),
      expectedSalary: text(candidate.expectedSalary),
      adjustableSalary: strings(candidate.adjustableSalary, 4)
    },
    skills: list(value.skills).map((item) => typeof item === "string" ? { name: text(item), level: "resume", evidence: [] } : { name: text(item?.name), level: text(item?.level || "resume"), evidence: strings(item?.evidence, 8) }).filter((item) => item.name),
    projects: list(value.projects).filter((item) => item && text(item.name)).slice(0, 6),
    resumeVersions: list(value.resumeVersions).slice(0, 4)
  };
}

function validateSearchPlan(value) {
  const keywords = list(value.keywords || value.includeKeywords || value.searchKeywords).map((item) => typeof item === "string" ? { word: text(item), priority: "B", reason: "模型建议" } : {
    word: text(item?.word || item?.keyword),
    priority: ["A", "B", "C"].includes(String(item?.priority).toUpperCase()) ? String(item.priority).toUpperCase() : "B",
    reason: text(item?.reason || item?.rationale || "模型建议")
  }).filter((item) => item.word);
  if (!keywords.length && !list(value.directions).length) throw new ModelContractError("recommendSearchPlan", "缺少关键词或目标方向");
  return { ...value, keywords, cities: strings(value.cities || value.city, 5), directions: strings(value.directions, 12) };
}

function validateJobUnderstanding(value) {
  const evidenceSnippets = strings(value.evidenceSnippets, 8);
  return {
    jobId: text(value.jobId),
    realRoleType: text(value.realRoleType || "unknown"),
    businessScenario: text(value.businessScenario),
    coreRequirements: strings(value.coreRequirements, 16),
    coreStack: strings(value.coreStack, 10),
    niceToHave: strings(value.niceToHave, 16),
    senioritySignal: text(value.senioritySignal || "unknown"),
    eligibilityConstraints: strings(value.eligibilityConstraints, 8),
    hiddenRisks: list(value.hiddenRisks).map((risk) => ({ type: text(risk?.type), severity: ["low", "medium", "high"].includes(risk?.severity) ? risk.severity : "medium", evidence: text(risk?.evidence) })).filter((risk) => risk.type || risk.evidence),
    isFakeAI: Boolean(value.isFakeAI),
    isTrainingOrSales: Boolean(value.isTrainingOrSales),
    evidenceSnippets
  };
}

function validateMatchDecision(value) {
  if (!["apply", "caution", "skip", "review"].includes(value.recommendation)) throw new ModelContractError("matchJob", "recommendation 必须为 apply/caution/skip/review");
  for (const [field, raw] of [
    ["hardBlockers", value.hardBlockers ?? value.blockingGaps],
    ["softGaps", value.softGaps ?? value.missingPoints],
    ["questionsToVerify", value.questionsToVerify ?? value.riskQuestions]
  ]) {
    if (list(raw).some((item) => typeof item !== "string" && !contractListItem(item))) throw new ModelContractError("matchJob", `${field} 必须是字符串数组`);
  }
  const confidence = Number(value.confidence);
  if (value.confidence === null || value.confidence === "" || !Number.isFinite(confidence)) throw new ModelContractError("matchJob", "confidence 必须是 0-1 的数字");
  const legacyBlockingGaps = contractStrings(value.blockingGaps, 8);
  const explicitHardBlockers = Object.prototype.hasOwnProperty.call(value, "hardBlockers");
  const blockerCandidates = explicitHardBlockers ? contractStrings(value.hardBlockers, 8) : legacyBlockingGaps;
  const hardBlockers = blockerCandidates.filter((item) => !isPolicySoftGap(item));
  const downgradedSoftGaps = blockerCandidates.filter(isPolicySoftGap);
  const softOnlySkip = value.recommendation === "skip" && !hardBlockers.length && downgradedSoftGaps.length;
  const recommendation = softOnlySkip ? "caution" : value.recommendation;
  const softGaps = contractStrings([
    ...contractStrings(value.softGaps ?? value.missingPoints, 8),
    ...downgradedSoftGaps
  ], 8);
  const questionsToVerify = contractStrings(value.questionsToVerify ?? value.riskQuestions, 8);
  const evidence = normalizeEvidence(value.evidence);
  const fitReasons = contractStrings(value.fitReasons ?? value.fit_reasons ?? value.matchReasons, 8);
  const result = {
    recommendation,
    fitLevel: softOnlySkip && value.fitLevel === "D" ? "C" : (["A", "B", "C", "D"].includes(value.fitLevel) ? value.fitLevel : "C"),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    fitReasons,
    hardBlockers,
    softGaps,
    questionsToVerify,
    missingPoints: softGaps,
    blockingGaps: hardBlockers,
    riskQuestions: questionsToVerify,
    recommendedResumeVersion: text(value.recommendedResumeVersion),
    primaryProjects: strings(value.primaryProjects, 4),
    greetingAngle: text(value.greetingAngle),
    evidence,
    hrPrep: object(value.hrPrep)
  };
  if (hardBlockers.length && recommendation !== "skip") throw new ModelContractError("matchJob", "已识别硬性阻断时 recommendation 必须为 skip");
  if (recommendation === "skip" && !hardBlockers.length) throw new ModelContractError("matchJob", "skip 必须包含至少一条可核对的 hardBlockers");
  if (recommendation === "apply" && !["A", "B"].includes(result.fitLevel)) throw new ModelContractError("matchJob", "apply 的 fitLevel 必须为 A 或 B");
  if (["apply", "caution"].includes(recommendation)) {
    if (!result.fitReasons.length) throw new ModelContractError("matchJob", "apply/caution 至少需要一条具体匹配理由");
    if (!result.evidence.jd.length) throw new ModelContractError("matchJob", "apply/caution 至少需要一条 JD 证据");
    if (!result.evidence.resume.length) throw new ModelContractError("matchJob", "apply/caution 至少需要一条候选人证据");
  } else if (recommendation === "skip") {
    if (!result.evidence.jd.length || !result.evidence.resume.length) throw new ModelContractError("matchJob", "skip 的硬阻断必须同时提供 JD 与候选人证据");
  } else {
    const hasReason = result.fitReasons.length || softGaps.length || questionsToVerify.length;
    const statesInsufficientInfo = [...softGaps, ...questionsToVerify].some((item) => /信息|未提供|缺少|无法确认|待确认/.test(item));
    if (!hasReason) throw new ModelContractError("matchJob", "review 必须说明待确认信息");
    if (!result.evidence.jd.length && !statesInsufficientInfo) throw new ModelContractError("matchJob", "review 至少需要 JD 证据或明确的待确认信息");
  }
  return result;
}

function effectiveHardBlockers(analysis = {}) {
  const blockers = Object.prototype.hasOwnProperty.call(analysis, "hardBlockers")
    ? contractStrings(analysis.hardBlockers, 8)
    : contractStrings(analysis.blockingGaps, 8);
  return blockers.filter((item) => !isPolicySoftGap(item));
}

function isPolicySoftGap(value) {
  const gap = text(value);
  if (/C\+\+|Golang|Go语言|\bGo\b|Spring|CUDA|模型训练|模型微调|算法训练|深度学习训练|(?:^|[^A-Za-z])Java(?:$|[^A-Za-z])|不符合.{0,12}(?:届别|在校|硬性资格)/i.test(gap)) return false;
  return /(?:经验|年限).{0,20}(?:不足|未达到|较少|不满)|(?:3\s*[-~至]\s*5|\d+\s*年以上).{0,12}(?:经验|要求)|仅有.{0,12}实习|学历|本科|硕士|博士|985|211|RPA|MySQL|JavaScript|前端|未提及|未提供|无法确认|待确认/i.test(gap);
}

function validateCommunication(value) {
  const kind = ["greeting", "hr_reply", "follow_up"].includes(value.kind) ? value.kind : "greeting";
  const messages = strings(value.messages || value.replies || value.greeting, 2);
  const rawMissingFact = object(value.missingFact);
  const missingFact = rawMissingFact.key || rawMissingFact.question
    ? { key: text(rawMissingFact.key).slice(0, 80), question: text(rawMissingFact.question) }
    : null;
  const evidence = normalizeEvidence(value.evidence);
  if (missingFact) {
    if (!missingFact.key || !missingFact.question) throw new ModelContractError("draftCommunication", "missingFact 必须同时包含 key 和 question");
    if (messages.length) throw new ModelContractError("draftCommunication", "缺少关键事实时不能同时生成可发送回复");
  } else if (!messages.length) {
    throw new ModelContractError("draftCommunication", "缺少可发送文案或待补事实问题");
  }
  if (!missingFact && ["greeting", "follow_up"].includes(kind) && (!evidence.jd.length || !evidence.resume.length)) {
    throw new ModelContractError("draftCommunication", "定制沟通必须同时包含 JD 与候选人证据");
  }
  return { kind, jobId: text(value.jobId), messages, missingFact, evidence, tone: text(value.tone) };
}

function normalizeEvidence(value) {
  const evidence = object(value);
  return { jd: strings(evidence.jd || evidence.job, 6), resume: strings(evidence.resume || evidence.candidate, 6) };
}

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function list(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function text(value) { return String(value || "").trim().slice(0, 1000); }
function strings(value, limit) { return [...new Set(list(value).map((item) => text(item)).filter(Boolean))].slice(0, limit); }
function contractStrings(value, limit) { return [...new Set(list(value).map(contractListItem).filter(Boolean))].slice(0, limit); }
function contractListItem(value) {
  if (typeof value === "string") return text(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return text(value.reason || value.gap || value.description || value.message || value.issue || value.value);
}

module.exports = { ModelContractError, validateModelResult, effectiveHardBlockers };
