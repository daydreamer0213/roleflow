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
  if (list(value.blockingGaps).some((item) => typeof item !== "string")) throw new ModelContractError("matchJob", "blockingGaps 必须是字符串数组");
  const recommendation = value.recommendation;
  const confidence = Number(value.confidence);
  if (value.confidence === null || value.confidence === "" || !Number.isFinite(confidence)) throw new ModelContractError("matchJob", "confidence 必须是 0-1 的数字");
  const result = {
    recommendation,
    fitLevel: ["A", "B", "C", "D"].includes(value.fitLevel) ? value.fitLevel : "C",
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    fitReasons: strings(value.fitReasons, 8),
    missingPoints: strings(value.missingPoints, 8),
    blockingGaps: strings(value.blockingGaps, 8),
    riskQuestions: strings(value.riskQuestions, 8),
    recommendedResumeVersion: text(value.recommendedResumeVersion),
    primaryProjects: strings(value.primaryProjects, 4),
    greetingAngle: text(value.greetingAngle),
    evidence: normalizeEvidence(value.evidence),
    hrPrep: object(value.hrPrep)
  };
  const inferredBlocking = result.missingPoints.filter((item) => /完全缺失|完全不匹配|不满足.{0,12}(?:核心|硬性)|不符合.{0,12}(?:核心|硬性|资格|届别)|核心.{0,16}(?:缺失|不匹配)|(?:无|缺少).{0,20}(?:C\+\+|Golang|Go语言|Java|Spring|CUDA|硬性资格|届别资格)/i.test(item));
  if (!result.blockingGaps.length && inferredBlocking.length) result.blockingGaps = inferredBlocking;
  if (result.blockingGaps.length && recommendation !== "skip") throw new ModelContractError("matchJob", "已识别硬性缺口时 recommendation 必须为 skip");
  if (recommendation === "apply" && !["A", "B"].includes(result.fitLevel)) throw new ModelContractError("matchJob", "apply 的 fitLevel 必须为 A 或 B");
  if (["apply", "caution"].includes(recommendation)) {
    if (!result.fitReasons.length) throw new ModelContractError("matchJob", "apply/caution 至少需要一条具体匹配理由");
    if (!result.evidence.jd.length) throw new ModelContractError("matchJob", "apply/caution 至少需要一条 JD 证据");
    if (!result.evidence.resume.length) throw new ModelContractError("matchJob", "apply/caution 至少需要一条候选人证据");
  } else {
    const hasReason = result.fitReasons.length || result.missingPoints.length || result.riskQuestions.length;
    const statesInsufficientInfo = result.missingPoints.some((item) => /信息|未提供|缺少|无法确认|待确认/.test(item));
    if (!hasReason) throw new ModelContractError("matchJob", "skip/review 必须说明岗位风险或信息不足");
    if (!result.evidence.jd.length && !statesInsufficientInfo) throw new ModelContractError("matchJob", "skip/review 至少需要 JD 风险证据或明确的信息不足说明");
  }
  return result;
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

module.exports = { ModelContractError, validateModelResult };
