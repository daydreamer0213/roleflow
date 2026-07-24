class ModelContractError extends Error {
  constructor(kind, message) {
    super(`${kind} 模型输出不符合契约：${message}`);
    this.name = "ModelContractError";
    this.code = "MODEL_CONTRACT_INVALID";
    this.statusCode = 422;
  }
}

const { normalizeMatchingCard } = require("./matching_card");

function validateModelResult(kind, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelContractError(kind, "必须返回 JSON 对象");
  if (kind === "analyzeResume") return validateResume(value);
  if (kind === "recommendSearchPlan") return validateSearchPlan(value);
  if (kind === "understandJob") return validateJobUnderstanding(value);
  if (kind === "matchJob") return validateMatchDecision(value);
  if (kind === "draftCommunication") return validateCommunication(value);
  if (kind === "buildCandidateMatchCard") return validateMatchingCardResult(value);
  throw new ModelContractError(kind, "未知分析类型");
}

function validateMatchingCardResult(value) {
  try {
    return normalizeMatchingCard(value, { source: "model" });
  } catch (error) {
    if (error && error.code === "MATCHING_CARD_INVALID") throw new ModelContractError("buildCandidateMatchCard", error.message);
    throw error;
  }
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

const REQUIREMENT_MATCH_STATES = ["matched", "transferable", "missing", "unknown", "not_applicable"];
const HARD_BLOCKER_KINDS = ["eligibility", "indispensable_core", "safety"];
const JOB_QUALITY_LEVELS = ["normal", "caution", "risk"];

function validateJobUnderstanding(value) {
  const evidenceSnippets = strings(value.evidenceSnippets, 8);
  return {
    jobId: text(value.jobId),
    roleSummary: text(value.roleSummary),
    realRoleType: text(value.realRoleType || "unknown"),
    businessScenario: text(value.businessScenario),
    coreResponsibilities: labeledEvidenceList(value.coreResponsibilities, 12),
    coreRequirements: list(value.coreRequirements).map((item) => {
      if (typeof item === "string") return { label: text(item), indispensable: false, evidence: "" };
      return { label: text(item?.label), indispensable: Boolean(item?.indispensable), evidence: text(item?.evidence) };
    }).filter((item) => item.label).slice(0, 16),
    preferredRequirements: labeledEvidenceList(value.preferredRequirements, 16),
    outcomeExpectations: labeledEvidenceList(value.outcomeExpectations, 8),
    coreStack: strings(value.coreStack, 10),
    niceToHave: strings(value.niceToHave, 16),
    senioritySignal: text(value.senioritySignal || "unknown"),
    eligibilityConstraints: strings(value.eligibilityConstraints, 8),
    hiddenRisks: list(value.hiddenRisks).map((risk) => ({ type: text(risk?.type), severity: ["low", "medium", "high"].includes(risk?.severity) ? risk.severity : "medium", evidence: text(risk?.evidence) })).filter((risk) => risk.type || risk.evidence),
    jobQuality: normalizeJobQuality(value.jobQuality),
    isFakeAI: Boolean(value.isFakeAI),
    isTrainingOrSales: Boolean(value.isTrainingOrSales),
    evidenceSnippets
  };
}

function labeledEvidenceList(value, limit) {
  return list(value).map((item) => {
    if (typeof item === "string") return { label: text(item), evidence: "" };
    return { label: text(item?.label), evidence: text(item?.evidence) };
  }).filter((item) => item.label).slice(0, limit);
}

function normalizeJobQuality(value) {
  const quality = object(value);
  const level = JOB_QUALITY_LEVELS.includes(quality.level) ? quality.level : "normal";
  const concerns = list(quality.concerns).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    return { type: text(item.type), evidence: text(item.evidence) };
  }).filter((item) => item && (item.type || item.evidence)).slice(0, 8);
  return { level, concerns };
}

function normalizeRequirementMatches(value) {
  return list(value).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ModelContractError("matchJob", "requirementMatches 必须是对象数组（requirement/state/indispensable/jdEvidence/resumeEvidence）");
    }
    return {
      requirement: text(item.requirement),
      state: REQUIREMENT_MATCH_STATES.includes(item.state) ? item.state : "unknown",
      indispensable: Boolean(item.indispensable),
      jdEvidence: text(item.jdEvidence),
      resumeEvidence: text(item.resumeEvidence)
    };
  }).filter((item) => item.requirement).slice(0, 16);
}

function normalizeStructuredHardBlockers(value) {
  return list(value).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ModelContractError("matchJob", "hardBlockers 必须是结构化对象数组（kind/requirement/jdEvidence/resumeEvidence），不接受字符串或旧式对象");
    }
    if (!HARD_BLOCKER_KINDS.includes(item.kind)) {
      throw new ModelContractError("matchJob", `hardBlockers.kind 只接受 ${HARD_BLOCKER_KINDS.join("/")}`);
    }
    const blocker = {
      kind: item.kind,
      requirement: text(item.requirement),
      jdEvidence: text(item.jdEvidence),
      resumeEvidence: text(item.resumeEvidence)
    };
    if (!blocker.requirement) throw new ModelContractError("matchJob", "hardBlockers 必须给出可核对的要求名称");
    if (!blocker.jdEvidence || !blocker.resumeEvidence) throw new ModelContractError("matchJob", "hardBlockers 必须同时提供 JD 与候选人证据");
    return blocker;
  }).slice(0, 8);
}

function validateMatchDecision(value) {
  if (!["apply", "caution", "skip", "review"].includes(value.recommendation)) throw new ModelContractError("matchJob", "recommendation 必须为 apply/caution/skip/review");
  for (const [field, raw] of [
    ["softGaps", value.softGaps ?? value.missingPoints],
    ["questionsToVerify", value.questionsToVerify ?? value.riskQuestions]
  ]) {
    if (list(raw).some((item) => typeof item !== "string" && !contractListItem(item))) throw new ModelContractError("matchJob", `${field} 必须是字符串数组`);
  }
  const confidence = Number(value.confidence);
  if (value.confidence === null || value.confidence === "" || !Number.isFinite(confidence)) throw new ModelContractError("matchJob", "confidence 必须是 0-1 的数字");
  const requirementMatches = normalizeRequirementMatches(value.requirementMatches);
  const jobQuality = normalizeJobQuality(value.jobQuality);
  const hardBlockers = normalizeStructuredHardBlockers(value.hardBlockers);
  for (const blocker of hardBlockers) {
    const match = requirementMatches.find((item) => item.requirement === blocker.requirement);
    if (match && match.state === "missing" && !match.indispensable) {
      throw new ModelContractError("matchJob", `要求「${blocker.requirement}」缺失但并非核心必备，不能作为硬性阻断`);
    }
  }
  const missingIndispensable = requirementMatches.some((item) => item.state === "missing" && item.indispensable);
  const transferableCore = requirementMatches.some((item) => item.state === "transferable" && item.indispensable);
  if (value.recommendation === "apply" && (missingIndispensable || jobQuality.level === "risk")) {
    throw new ModelContractError("matchJob", "存在核心必备要求缺失或岗位质量风险时 recommendation 不能为 apply");
  }
  const demoteApply = value.recommendation === "apply" && (transferableCore || jobQuality.level === "caution");
  const recommendation = demoteApply ? "caution" : value.recommendation;
  const softGaps = contractStrings(value.softGaps ?? value.missingPoints, 8);
  const questionsToVerify = contractStrings(value.questionsToVerify ?? value.riskQuestions, 8);
  const evidence = normalizeEvidence(value.evidence);
  const fitReasons = contractStrings(value.fitReasons ?? value.fit_reasons ?? value.matchReasons, 8);
  const result = {
    recommendation,
    fitLevel: demoteApply && value.fitLevel === "A" ? "B" : (["A", "B", "C", "D"].includes(value.fitLevel) ? value.fitLevel : "C"),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    fitReasons,
    requirementMatches,
    jobQuality,
    hardBlockers,
    softGaps,
    questionsToVerify,
    missingPoints: softGaps,
    blockingGaps: hardBlockers.map((item) => item.requirement),
    riskQuestions: questionsToVerify,
    recommendedResumeVersion: text(value.recommendedResumeVersion),
    primaryProjects: strings(value.primaryProjects, 4),
    greetingAngle: text(value.greetingAngle),
    evidence,
    hrPrep: object(value.hrPrep)
  };
  if (hardBlockers.length && recommendation !== "skip") throw new ModelContractError("matchJob", "已识别硬性阻断时 recommendation 必须为 skip");
  if (recommendation === "skip" && !hardBlockers.length) throw new ModelContractError("matchJob", "skip 必须包含至少一条可核对的结构化 hardBlockers");
  if (recommendation === "apply" && !["A", "B"].includes(result.fitLevel)) throw new ModelContractError("matchJob", "apply 的 fitLevel 必须为 A 或 B");
  if (recommendation === "apply") {
    const lackingEvidence = requirementMatches.some((item) => ["matched", "transferable"].includes(item.state) && (!item.jdEvidence || !item.resumeEvidence));
    if (lackingEvidence) throw new ModelContractError("matchJob", "apply 的逐项匹配必须同时具备 JD 与候选人证据");
  }
  if (["apply", "caution"].includes(recommendation)) {
    if (!result.fitReasons.length) throw new ModelContractError("matchJob", "apply/caution 至少需要一条具体匹配理由");
    if (!result.evidence.jd.length) throw new ModelContractError("matchJob", "apply/caution 至少需要一条 JD 证据");
    if (!result.evidence.resume.length) throw new ModelContractError("matchJob", "apply/caution 至少需要一条候选人证据");
  } else if (recommendation === "skip") {
    if (!result.evidence.jd.length || !result.evidence.resume.length) throw new ModelContractError("matchJob", "skip 的硬阻断必须同时提供 JD 与候选人证据");
  } else {
    const hasUnknownRequirement = requirementMatches.some((item) => item.state === "unknown" || item.state === "missing");
    const hasReason = result.fitReasons.length || softGaps.length || questionsToVerify.length;
    const statesInsufficientInfo = [...softGaps, ...questionsToVerify].some((item) => /信息|未提供|缺少|无法确认|待确认/.test(item));
    if (!hasReason && !hasUnknownRequirement) throw new ModelContractError("matchJob", "review 必须包含 unknown 项、待确认问题或缺失信息");
    if (!result.evidence.jd.length && !statesInsufficientInfo && !hasUnknownRequirement) throw new ModelContractError("matchJob", "review 至少需要 JD 证据或明确的待确认信息");
  }
  return result;
}

function effectiveHardBlockers(analysis = {}) {
  const raw = Object.prototype.hasOwnProperty.call(analysis, "hardBlockers")
    ? analysis.hardBlockers
    : analysis.blockingGaps;
  return list(raw).filter((item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) return HARD_BLOCKER_KINDS.includes(item.kind);
    return !isPolicySoftGap(contractListItem(item));
  });
}

function hardBlockerText(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return text(value.requirement || value.reason || value.kind);
  return text(value);
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

module.exports = { ModelContractError, validateModelResult, effectiveHardBlockers, hardBlockerText };
