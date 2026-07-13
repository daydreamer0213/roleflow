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
    niceToHave: strings(value.niceToHave, 16),
    senioritySignal: text(value.senioritySignal || "unknown"),
    hiddenRisks: list(value.hiddenRisks).map((risk) => ({ type: text(risk?.type), severity: ["low", "medium", "high"].includes(risk?.severity) ? risk.severity : "medium", evidence: text(risk?.evidence) })).filter((risk) => risk.type || risk.evidence),
    isFakeAI: Boolean(value.isFakeAI),
    isTrainingOrSales: Boolean(value.isTrainingOrSales),
    evidenceSnippets
  };
}

function validateMatchDecision(value) {
  const recommendation = ["apply", "caution", "skip", "review"].includes(value.recommendation) ? value.recommendation : "review";
  const confidence = Number(value.confidence);
  return {
    recommendation,
    fitLevel: ["A", "B", "C", "D"].includes(value.fitLevel) ? value.fitLevel : "C",
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    fitReasons: strings(value.fitReasons, 8),
    missingPoints: strings(value.missingPoints, 8),
    riskQuestions: strings(value.riskQuestions, 8),
    recommendedResumeVersion: text(value.recommendedResumeVersion),
    primaryProjects: strings(value.primaryProjects, 4),
    greetingAngle: text(value.greetingAngle),
    evidence: normalizeEvidence(value.evidence),
    hrPrep: object(value.hrPrep)
  };
}

function validateCommunication(value) {
  const greeting = text(value.greeting);
  if (!greeting) throw new ModelContractError("draftCommunication", "缺少招呼语");
  return { jobId: text(value.jobId), greeting, hrReplies: object(value.hrReplies), tone: text(value.tone) };
}

function normalizeEvidence(value) {
  const evidence = object(value);
  return { jd: strings(evidence.jd || evidence.job, 6), resume: strings(evidence.resume || evidence.candidate, 6) };
}

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function list(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function text(value) { return String(value || "").trim().slice(0, 1000); }
function strings(value, limit) { return [...new Set(list(value).map((item) => text(item)).filter(Boolean))].slice(0, limit); }

module.exports = { ModelContractError, validateModelResult };
