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
  if (kind === "matchJob") {
    if (Object.prototype.hasOwnProperty.call(value, "matches")
      || Object.prototype.hasOwnProperty.call(value, "eligibility")
      || Object.prototype.hasOwnProperty.call(value, "certainty")) {
      return validateCompactMatchEvidence(value, context);
    }
    return validateMatchDecision(value, context);
  }
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
const ELIGIBILITY_MATCH_STATES = ["satisfied", "conflict", "unknown"];
const MATCH_CERTAINTY_LEVELS = ["high", "medium", "low"];
const COMPACT_CAUTION_KINDS = ["candidate_transition", "preferred_gap", "outcome_uncertain", "preference_conflict"];
const HARD_BLOCKER_KINDS = ["eligibility", "indispensable_core", "safety"];
const JOB_QUALITY_LEVELS = ["normal", "caution", "risk"];

function validateJobUnderstanding(value) {
  const evidenceSnippets = contractStringArray(value.evidenceSnippets, "understandJob", "evidenceSnippets", 8);
  const coreRequirements = understandingCoreRequirements(value.coreRequirements)
    .map((item, index) => ({ id: `R${index + 1}`, ...item }));
  const eligibilityConstraints = contractStringArray(value.eligibilityConstraints, "understandJob", "eligibilityConstraints", 8);
  return {
    jobId: text(value.jobId),
    roleSummary: text(value.roleSummary),
    realRoleType: text(value.realRoleType || "unknown"),
    businessScenario: text(value.businessScenario),
    coreResponsibilities: understandingEvidenceList(value.coreResponsibilities, "coreResponsibilities", 12),
    coreRequirements,
    preferredRequirements: understandingEvidenceList(value.preferredRequirements, "preferredRequirements", 16),
    outcomeExpectations: understandingEvidenceList(value.outcomeExpectations, "outcomeExpectations", 8),
    coreStack: contractStringArray(value.coreStack, "understandJob", "coreStack", 10),
    niceToHave: contractStringArray(value.niceToHave, "understandJob", "niceToHave", 16),
    senioritySignal: text(value.senioritySignal || "unknown"),
    eligibilityConstraints,
    eligibilityItems: eligibilityConstraints.map((label, index) => ({ id: `E${index + 1}`, label })),
    hiddenRisks: understandingHiddenRisks(value.hiddenRisks),
    jobQuality: normalizeJobQuality(value.jobQuality, "understandJob"),
    isFakeAI: Boolean(value.isFakeAI),
    isTrainingOrSales: Boolean(value.isTrainingOrSales),
    evidenceSnippets
  };
}

function validateCompactMatchEvidence(value, context = {}) {
  const jobUnderstanding = context?.jobUnderstanding;
  if (!jobUnderstanding || !Array.isArray(jobUnderstanding.coreRequirements)) {
    throw new ModelContractError("matchJob", "紧凑匹配证据必须携带本次 jobUnderstanding");
  }
  const requirements = jobUnderstanding.coreRequirements.map((item, index) => ({
    id: requiredContractString(item.id || `R${index + 1}`, "matchJob", "jobUnderstanding.coreRequirements.id"),
    label: requiredContractString(item.label, "matchJob", "jobUnderstanding.coreRequirements.label"),
    indispensable: Boolean(item.indispensable),
    evidence: requiredContractString(item.evidence, "matchJob", "jobUnderstanding.coreRequirements.evidence")
  }));
  const eligibilityItems = Array.isArray(jobUnderstanding.eligibilityItems)
    ? jobUnderstanding.eligibilityItems
    : list(jobUnderstanding.eligibilityConstraints).map((label, index) => ({ id: `E${index + 1}`, label }));

  const matches = compactEvidenceItems(value.matches, {
    field: "matches",
    expected: requirements,
    states: REQUIREMENT_MATCH_STATES,
    evidenceStates: ["matched", "transferable"]
  });
  const eligibility = compactEvidenceItems(value.eligibility, {
    field: "eligibility",
    expected: eligibilityItems,
    states: ELIGIBILITY_MATCH_STATES,
    evidenceStates: ["satisfied", "conflict"]
  });
  const uncertainties = contractStringArray(value.uncertainties, "matchJob", "uncertainties", 8);
  const cautions = compactCautions(value.cautions);
  if (!MATCH_CERTAINTY_LEVELS.includes(value.certainty)) {
    throw new ModelContractError("matchJob", `certainty 必须是 ${MATCH_CERTAINTY_LEVELS.join("/")} 之一`);
  }

  const byRequirementId = new Map(matches.map((item) => [item.id, item]));
  const requirementMatches = requirements.map((requirement) => {
    const match = byRequirementId.get(requirement.id);
    return {
      requirement: requirement.label,
      state: match.state === "missing" && requirement.indispensable ? "unknown" : match.state,
      indispensable: requirement.indispensable,
      jdEvidence: requirement.evidence,
      resumeEvidence: match.resumeEvidence
    };
  });
  const byEligibilityId = new Map(eligibility.map((item) => [item.id, item]));
  const hardBlockers = [];
  for (const item of eligibilityItems) {
    const match = byEligibilityId.get(item.id);
    if (match.state !== "conflict") continue;
    hardBlockers.push({
      kind: "eligibility",
      requirement: item.label,
      jdEvidence: `JD：${item.label}`,
      resumeEvidence: match.resumeEvidence
    });
  }

  const unknownRequirements = requirementMatches.filter((item) => ["unknown", "not_applicable"].includes(item.state));
  const unknownEligibility = eligibility.filter((item) => item.state === "unknown");
  const transferable = requirementMatches.filter((item) => item.state === "transferable");
  const softMissing = requirementMatches.filter((item) => item.state === "missing" && !hardBlockers.some((blocker) => blocker.requirement === item.requirement));
  const jobQuality = jobUnderstanding.jobQuality || { level: "normal", concerns: [] };
  const hasPositiveRequirementEvidence = requirementMatches.some((item) => ["matched", "transferable"].includes(item.state));
  let recommendation;
  if (hardBlockers.length) recommendation = "skip";
  else if (!requirementMatches.length || !hasPositiveRequirementEvidence || unknownRequirements.length || unknownEligibility.length
    || uncertainties.length || value.certainty === "low" || jobQuality.level === "risk") recommendation = "review";
  else if (transferable.length || softMissing.length || cautions.length || jobQuality.level === "caution") recommendation = "caution";
  else recommendation = "apply";

  const fitLevel = recommendation === "skip"
    ? "D"
    : recommendation === "review"
      ? "C"
      : recommendation === "caution" || value.certainty !== "high"
        ? "B"
        : "A";
  const confidence = value.certainty === "high" ? 0.9 : value.certainty === "medium" ? 0.72 : 0.45;
  const fitReasons = requirementMatches
    .filter((item) => ["matched", "transferable"].includes(item.state))
    .map((item) => `${item.requirement}：${item.state === "matched" ? "有直接简历证据" : "有可迁移简历证据"}`)
    .slice(0, 8);
  const softGaps = [
    ...transferable.map((item) => `${item.requirement}目前只有可迁移证据`),
    ...softMissing.map((item) => `${item.requirement}未找到直接简历证据`),
    ...cautions.map((item) => item.detail),
    ...(jobQuality.level === "risk" ? ["岗位存在安全或合规风险，交由本地规则处理"] : [])
  ].slice(0, 8);
  const questionsToVerify = [
    ...uncertainties,
    ...unknownRequirements.map((item) => `${item.requirement}的信息待确认`),
    ...unknownEligibility.map((item) => `${eligibilityItems.find((entry) => entry.id === item.id)?.label || item.id}的资格信息待确认`)
  ].slice(0, 8);
  const jdEvidence = requirementMatches
    .filter((item) => ["matched", "transferable", "missing"].includes(item.state))
    .map((item) => item.jdEvidence)
    .filter(Boolean)
    .concat(
      hardBlockers.filter((item) => item.kind === "eligibility").map((item) => item.jdEvidence),
      list(jobUnderstanding.hiddenRisks).map((item) => text(item?.evidence)).filter(Boolean),
      list(jobQuality.concerns).map((item) => text(item?.evidence)).filter(Boolean)
    )
    .slice(0, 6);
  const resumeEvidence = [...matches, ...eligibility]
    .map((item) => item.resumeEvidence)
    .filter(Boolean)
    .slice(0, 6);

  return {
    recommendation,
    fitLevel,
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
    recommendedResumeVersion: "",
    primaryProjects: [],
    greetingAngle: "",
    evidence: { jd: jdEvidence, resume: resumeEvidence },
    hrPrep: {}
  };
}

function compactEvidenceItems(value, { field, expected, states, evidenceStates }) {
  if (!Array.isArray(value)) throw new ModelContractError("matchJob", `${field} 必须是数组`);
  const expectedIds = new Set(expected.map((item) => item.id));
  const seen = new Set();
  const result = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ModelContractError("matchJob", `${field} 必须是 {id,state,resumeEvidence} 对象数组`);
    }
    const id = requiredContractString(item.id, "matchJob", `${field}.id`);
    if (!expectedIds.has(id)) throw new ModelContractError("matchJob", `${field} 包含不存在的 ID ${id}`);
    if (seen.has(id)) throw new ModelContractError("matchJob", `${field} 中的 ID ${id} 重复`);
    seen.add(id);
    if (!states.includes(item.state)) {
      throw new ModelContractError("matchJob", `${field}.state 必须是 ${states.join("/")} 之一`);
    }
    const resumeEvidence = optionalContractString(item.resumeEvidence, "matchJob", `${field}.resumeEvidence`);
    if (evidenceStates.includes(item.state) && !resumeEvidence) {
      throw new ModelContractError("matchJob", `${field} 的 ${item.state} 状态必须提供 resumeEvidence`);
    }
    return { id, state: item.state, resumeEvidence };
  });
  for (const item of expected) {
    if (!seen.has(item.id)) throw new ModelContractError("matchJob", `${field} 漏掉 ${item.id}`);
  }
  return result;
}

function compactCautions(value) {
  if (!Array.isArray(value)) throw new ModelContractError("matchJob", "cautions 必须是数组");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !COMPACT_CAUTION_KINDS.includes(item.kind)) {
      throw new ModelContractError("matchJob", `cautions.kind 必须是 ${COMPACT_CAUTION_KINDS.join("/")} 之一`);
    }
    return {
      kind: item.kind,
      detail: requiredContractString(item.detail, "matchJob", "cautions.detail")
    };
  }).slice(0, 8);
}

// 旧字符串或缺 evidence 的条目一律抛契约错误进入修复，绝不静默升级为对象结构。
function understandingEvidenceList(value, field, limit) {
  return list(value).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ModelContractError("understandJob", `${field} 必须是 {label,evidence} 对象数组，不接受字符串`);
    }
    const label = requiredContractString(item.label, "understandJob", `${field}.label`);
    const evidence = requiredContractString(item.evidence, "understandJob", `${field}.evidence`);
    return { label, evidence };
  }).slice(0, limit);
}

function understandingCoreRequirements(value) {
  const requirements = list(value).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ModelContractError("understandJob", "coreRequirements 必须是 {label,indispensable,evidence} 对象数组，不接受字符串");
    }
    const label = requiredContractString(item.label, "understandJob", "coreRequirements.label");
    const evidence = requiredContractString(item.evidence, "understandJob", "coreRequirements.evidence");
    if (typeof item.indispensable !== "boolean") {
      throw new ModelContractError("understandJob", `coreRequirements「${label}」的 indispensable 必须是 boolean`);
    }
    return { label, indispensable: item.indispensable, evidence };
  }).slice(0, 16);
  assertUniqueCoreRequirements(requirements, "understandJob");
  return requirements;
}

function understandingHiddenRisks(value) {
  return list(value).map((risk) => {
    if (!risk || typeof risk !== "object" || Array.isArray(risk)) {
      throw new ModelContractError("understandJob", "hiddenRisks 必须是 {type,severity,evidence} 对象数组");
    }
    const type = requiredContractString(risk.type, "understandJob", "hiddenRisks.type");
    const evidence = requiredContractString(risk.evidence, "understandJob", "hiddenRisks.evidence");
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
    const type = requiredContractString(item.type, kind, "jobQuality.concerns.type");
    const evidence = requiredContractString(item.evidence, kind, "jobQuality.concerns.evidence");
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
    const requirement = requiredContractString(item.requirement, "matchJob", "requirementMatches.requirement");
    if (typeof item.indispensable !== "boolean") {
      throw new ModelContractError("matchJob", "requirementMatches.indispensable 必须是 boolean，不得强制转换");
    }
    return {
      requirement,
      state: item.state,
      indispensable: item.indispensable,
      jdEvidence: optionalContractString(item.jdEvidence, "matchJob", "requirementMatches.jdEvidence"),
      resumeEvidence: optionalContractString(item.resumeEvidence, "matchJob", "requirementMatches.resumeEvidence")
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
      requirement: requiredContractString(item.requirement, "matchJob", "hardBlockers.requirement"),
      jdEvidence: requiredContractString(item.jdEvidence, "matchJob", "hardBlockers.jdEvidence"),
      resumeEvidence: requiredContractString(item.resumeEvidence, "matchJob", "hardBlockers.resumeEvidence")
    };
    return blocker;
  }).slice(0, 8);
}

// MatchDecision 必须与本次 JobUnderstanding 一一核对：核心要求恰好覆盖一次，
// 不得漏项、重复、虚构，indispensable 必须与理解一致（模型无权修改）。
function assertRequirementCoverage(coreRequirements, requirementMatches) {
  assertUniqueCoreRequirements(coreRequirements, "matchJob");
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

function assertUniqueCoreRequirements(coreRequirements, kind) {
  const seen = new Set();
  for (const requirement of coreRequirements) {
    const label = text(requirement?.label);
    if (seen.has(label)) {
      throw new ModelContractError(kind, `coreRequirements 中的「${label}」重复，无法逐项一一核对`);
    }
    seen.add(label);
  }
}

function assertJobQualityAlignment(jobUnderstanding, jobQuality) {
  const sourceQuality = jobUnderstanding?.jobQuality;
  if (!sourceQuality || !JOB_QUALITY_LEVELS.includes(sourceQuality.level)) return;
  if (jobQuality.level !== sourceQuality.level) {
    throw new ModelContractError("matchJob", `jobQuality.level 必须照抄 JobUnderstanding 的 ${sourceQuality.level}，不得降级或改写`);
  }
  for (const concern of sourceQuality.concerns || []) {
    const preserved = jobQuality.concerns.some((item) => item.type === concern.type && item.evidence === concern.evidence);
    if (!preserved) {
      throw new ModelContractError("matchJob", `jobQuality.concerns 必须保留 JobUnderstanding 已识别的「${concern.type}」及原始证据`);
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
  assertJobQualityAlignment(jobUnderstanding, jobQuality);
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
  for (const match of requirementMatches) {
    if (match.indispensable && match.state === "missing" && !hardBlockers.some((blocker) => blocker.kind === "indispensable_core" && blocker.requirement === match.requirement)) {
      const applyDetail = value.recommendation === "apply" ? "，recommendation 不能为 apply" : "";
      throw new ModelContractError("matchJob", `缺少 indispensable_core 硬性阻断：核心必备要求「${match.requirement}」状态为 missing${applyDetail}`);
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
  const evidence = normalizeEvidence(value.evidence, "matchJob");
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

// 决策路径只接受结构完整的三类 blocker：合法 kind、非空 requirement、JD 与候选人双侧证据齐全。
// 历史分析里的字符串 blocker、缺字段对象或非法 kind 仅供页面展示或忽略，绝不进入 skip、分桶或任何硬排除判断。
function isDecisionHardBlocker(item) {
  return Boolean(item) && typeof item === "object" && !Array.isArray(item)
    && HARD_BLOCKER_KINDS.includes(item.kind)
    && typeof item.requirement === "string" && Boolean(item.requirement.trim())
    && typeof item.jdEvidence === "string" && Boolean(item.jdEvidence.trim())
    && typeof item.resumeEvidence === "string" && Boolean(item.resumeEvidence.trim());
}

function decisionHardBlockers(analysis = {}) {
  return list(analysis.hardBlockers).filter(isDecisionHardBlocker);
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
  const evidence = normalizeEvidence(value.evidence, "draftCommunication");
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

function normalizeEvidence(value, kind) {
  const evidence = object(value);
  return {
    jd: contractStringArray(evidence.jd || evidence.job, kind, "evidence.jd", 6),
    resume: contractStringArray(evidence.resume || evidence.candidate, kind, "evidence.resume", 6)
  };
}

function requiredContractString(value, kind, field) {
  const description = /evidence/i.test(field) ? `${field} 证据字段` : field;
  if (typeof value !== "string" || !value.trim()) throw new ModelContractError(kind, `${description}必须是非空字符串`);
  return text(value);
}

function optionalContractString(value, kind, field) {
  const description = /evidence/i.test(field) ? `${field} 证据字段` : field;
  if (typeof value !== "string") throw new ModelContractError(kind, `${description}必须是字符串`);
  return text(value);
}

function contractStringArray(value, kind, field, limit) {
  const values = list(value);
  if (values.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ModelContractError(kind, `${field} 必须是非空字符串数组（每项一句原文短句；没有内容时输出空数组 []，不要输出对象或 null）`);
  }
  return [...new Set(values.map((item) => text(item)))].slice(0, limit);
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
