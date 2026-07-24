class ModelContractError extends Error {
  constructor(kind, message) {
    super(`${kind} 模型输出不符合契约：${message}`);
    this.name = "ModelContractError";
    this.code = "MODEL_CONTRACT_INVALID";
    this.statusCode = 422;
  }
}

const { normalizeMatchingCard } = require("./matching_card");

function validateModelResult(kind, value, context = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelContractError(kind, "必须返回 JSON 对象");
  if (kind === "analyzeResume") return validateResume(value);
  if (kind === "recommendSearchPlan") return validateSearchPlan(value);
  if (kind === "understandJob") return validateJobUnderstanding(value);
  if (kind === "matchJob") return validateMatchDecision(value, context);
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
    coreResponsibilities: understandingEvidenceList(value.coreResponsibilities, "coreResponsibilities", 12),
    coreRequirements: understandingCoreRequirements(value.coreRequirements),
    preferredRequirements: understandingEvidenceList(value.preferredRequirements, "preferredRequirements", 16),
    outcomeExpectations: understandingEvidenceList(value.outcomeExpectations, "outcomeExpectations", 8),
    coreStack: strings(value.coreStack, 10),
    niceToHave: strings(value.niceToHave, 16),
    senioritySignal: text(value.senioritySignal || "unknown"),
    eligibilityConstraints: strings(value.eligibilityConstraints, 8),
    hiddenRisks: understandingHiddenRisks(value.hiddenRisks),
    jobQuality: normalizeJobQuality(value.jobQuality, "understandJob"),
    isFakeAI: Boolean(value.isFakeAI),
    isTrainingOrSales: Boolean(value.isTrainingOrSales),
    evidenceSnippets
  };
}

// 旧字符串或缺 evidence 的条目一律抛契约错误进入修复，绝不静默升级为对象结构。
function understandingEvidenceList(value, field, limit) {
  return list(value).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ModelContractError("understandJob", `${field} 必须是 {label,evidence} 对象数组，不接受字符串`);
    }
    const label = text(item.label);
    if (!label) throw new ModelContractError("understandJob", `${field} 每项必须有非空 label`);
    const evidence = text(item.evidence);
    if (!evidence) throw new ModelContractError("understandJob", `${field}「${label}」必须给出 JD evidence`);
    return { label, evidence };
  }).slice(0, limit);
}

function understandingCoreRequirements(value) {
  return list(value).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ModelContractError("understandJob", "coreRequirements 必须是 {label,indispensable,evidence} 对象数组，不接受字符串");
    }
    const label = text(item.label);
    if (!label) throw new ModelContractError("understandJob", "coreRequirements 每项必须有非空 label");
    const evidence = text(item.evidence);
    if (!evidence) throw new ModelContractError("understandJob", `coreRequirements「${label}」必须给出 JD evidence`);
    if (typeof item.indispensable !== "boolean") {
      throw new ModelContractError("understandJob", `coreRequirements「${label}」的 indispensable 必须是 boolean`);
    }
    return { label, indispensable: item.indispensable, evidence };
  }).slice(0, 16);
}

function understandingHiddenRisks(value) {
  return list(value).map((risk) => {
    if (!risk || typeof risk !== "object" || Array.isArray(risk)) {
      throw new ModelContractError("understandJob", "hiddenRisks 必须是 {type,severity,evidence} 对象数组");
    }
    const type = text(risk.type);
    const evidence = text(risk.evidence);
    if (!type || !evidence) throw new ModelContractError("understandJob", "hiddenRisks 每项必须有非空 type 和 evidence");
    if (!["low", "medium", "high"].includes(risk.severity)) {
      throw new ModelContractError("understandJob", `hiddenRisks「${type}」的 severity 必须是 low/medium/high`);
    }
    return { type, severity: risk.severity, evidence };
  }).slice(0, 8);
}

function normalizeJobQuality(value, kind) {
  const quality = object(value);
  // 岗位质量影响投递决策：缺失或非法 level 必须触发契约修复，不得静默按 normal 放行。
  if (!JOB_QUALITY_LEVELS.includes(quality.level)) {
    throw new ModelContractError(kind, `jobQuality.level 必须是 ${JOB_QUALITY_LEVELS.join("/")} 之一`);
  }
  const concerns = list(quality.concerns).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ModelContractError(kind, "jobQuality.concerns 必须是 {type,evidence} 对象数组");
    }
    const type = text(item.type);
    const evidence = text(item.evidence);
    if (!type || !evidence) throw new ModelContractError(kind, "jobQuality.concerns 每项必须有非空 type 和 evidence");
    return { type, evidence };
  }).slice(0, 8);
  return { level: quality.level, concerns };
}

function normalizeRequirementMatches(value) {
  return list(value).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ModelContractError("matchJob", "requirementMatches 必须是对象数组（requirement/state/indispensable/jdEvidence/resumeEvidence）");
    }
    if (!REQUIREMENT_MATCH_STATES.includes(item.state)) {
      throw new ModelContractError("matchJob", `requirementMatches.state 只接受 ${REQUIREMENT_MATCH_STATES.join("/")}，收到「${text(item.state) || "空值"}」`);
    }
    const requirement = text(item.requirement);
    if (!requirement) throw new ModelContractError("matchJob", "requirementMatches 必须给出非空 requirement，不得留空后消失");
    return {
      requirement,
      state: item.state,
      indispensable: Boolean(item.indispensable),
      jdEvidence: text(item.jdEvidence),
      resumeEvidence: text(item.resumeEvidence)
    };
  }).slice(0, 16);
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

// MatchDecision 必须与本次 JobUnderstanding 一一核对：核心要求恰好覆盖一次，
// 不得漏项、重复、虚构，indispensable 必须与理解一致（模型无权修改）。
function assertRequirementCoverage(coreRequirements, requirementMatches) {
  const counts = new Map();
  for (const match of requirementMatches) {
    counts.set(match.requirement, (counts.get(match.requirement) || 0) + 1);
  }
  for (const [name, count] of counts) {
    if (count > 1) throw new ModelContractError("matchJob", `requirementMatches 中「${name}」重复出现，每条核心要求必须恰好匹配一次`);
  }
  const expectedNames = new Set(coreRequirements.map((item) => text(item.label)));
  for (const match of requirementMatches) {
    if (!expectedNames.has(match.requirement)) {
      throw new ModelContractError("matchJob", `requirementMatches 包含 JobUnderstanding 中不存在的核心要求「${match.requirement}」，不得虚构`);
    }
  }
  for (const requirement of coreRequirements) {
    const label = text(requirement.label);
    const match = requirementMatches.find((item) => item.requirement === label);
    if (!match) {
      throw new ModelContractError("matchJob", `requirementMatches 漏掉核心要求「${label}」，必须逐项覆盖 JobUnderstanding.coreRequirements`);
    }
    if (match.indispensable !== requirement.indispensable) {
      throw new ModelContractError("matchJob", `requirementMatches「${label}」的 indispensable 必须与 JobUnderstanding 一致，模型不得修改`);
    }
  }
}

function validateMatchDecision(value, context = {}) {
  if (!["apply", "caution", "skip", "review"].includes(value.recommendation)) throw new ModelContractError("matchJob", "recommendation 必须为 apply/caution/skip/review");
  for (const [field, raw] of [
    ["softGaps", value.softGaps ?? value.missingPoints],
    ["questionsToVerify", value.questionsToVerify ?? value.riskQuestions]
  ]) {
    if (list(raw).some((item) => typeof item !== "string" && !contractListItem(item))) throw new ModelContractError("matchJob", `${field} 必须是字符串数组`);
  }
  const confidence = Number(value.confidence);
  if (value.confidence === null || value.confidence === "" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new ModelContractError("matchJob", "confidence 必须是 0-1 的数字");
  }
  const requirementMatches = normalizeRequirementMatches(value.requirementMatches);
  const jobQuality = normalizeJobQuality(value.jobQuality, "matchJob");
  const hardBlockers = normalizeStructuredHardBlockers(value.hardBlockers);
  const jobUnderstanding = context?.jobUnderstanding;
  if (jobUnderstanding && Array.isArray(jobUnderstanding.coreRequirements)) {
    assertRequirementCoverage(jobUnderstanding.coreRequirements, requirementMatches);
  }
  // indispensable_core 阻断必须精确对应同名、state=missing 且 indispensable=true 的核心项。
  for (const blocker of hardBlockers) {
    if (blocker.kind !== "indispensable_core") continue;
    const match = requirementMatches.find((item) => item.requirement === blocker.requirement);
    if (!match) {
      throw new ModelContractError("matchJob", `indispensable_core 硬性阻断「${blocker.requirement}」必须对应同名核心要求`);
    }
    if (match.state !== "missing" || !match.indispensable) {
      throw new ModelContractError("matchJob", `indispensable_core 硬性阻断「${blocker.requirement}」只能对应 state=missing 且 indispensable=true 的核心要求`);
    }
  }
  const transferableCore = requirementMatches.some((item) => item.state === "transferable" && item.indispensable);
  if (value.recommendation === "apply") {
    // apply 要求每一条核心必备项都有直接证据；仅可迁移证据自动降 caution，其余未决状态一律触发契约修复。
    if (!requirementMatches.length) {
      throw new ModelContractError("matchJob", "没有可核对的核心要求时 recommendation 不能为 apply，应使用 review");
    }
    const unresolvedCore = requirementMatches.find((item) => item.indispensable && !["matched", "transferable"].includes(item.state));
    if (unresolvedCore) {
      throw new ModelContractError("matchJob", `核心必备要求「${unresolvedCore.requirement}」状态为 ${unresolvedCore.state}，recommendation 不能为 apply`);
    }
    if (jobQuality.level === "risk") {
      throw new ModelContractError("matchJob", "岗位质量存在风险时 recommendation 不能为 apply");
    }
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
    confidence,
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

// 决策路径只接受结构化三类 blocker。历史分析里的字符串 blocker（旧 hardBlockers 或 blockingGaps）
// 仅供页面展示，绝不进入 skip、分桶或任何硬排除判断。
function decisionHardBlockers(analysis = {}) {
  return list(analysis.hardBlockers).filter((item) => item && typeof item === "object" && !Array.isArray(item) && HARD_BLOCKER_KINDS.includes(item.kind));
}

// 展示兼容：读取历史分析中的硬缺口条目（含旧式字符串），只用于页面呈现，禁止用于新决策。
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

module.exports = { ModelContractError, validateModelResult, effectiveHardBlockers, decisionHardBlockers, hardBlockerText };
