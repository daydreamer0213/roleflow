class ModelContractError extends Error {
  constructor(kind, message) {
    super(`${kind} 模型输出不符合契约：${message}`);
    this.name = "ModelContractError";
    this.code = "MODEL_CONTRACT_INVALID";
    this.statusCode = 422;
  }
}

const { normalizeMatchingCard } = require("./matching_card");

const ROLE_ALIGNMENT_STATES = Object.freeze([
  "aligned",
  "mostly_aligned",
  "partially_aligned",
  "misaligned",
  "insufficient_evidence"
]);

function validateModelResult(kind, value, context = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelContractError(kind, "必须返回 JSON 对象");
  if (kind === "analyzeResume") return validateResume(value);
  if (kind === "recommendSearchPlan") return validateSearchPlan(value);
  if (kind === "understandJob") return validateJobUnderstanding(value);
  if (kind === "matchJob") {
    if (Object.prototype.hasOwnProperty.call(value, "matches")
      || Object.prototype.hasOwnProperty.call(value, "eligibility")
      || Object.prototype.hasOwnProperty.call(value, "certainty")) {
      if (Object.prototype.hasOwnProperty.call(value, "certainty")
        || Object.prototype.hasOwnProperty.call(value, "uncertainties")
        || Object.prototype.hasOwnProperty.call(value, "cautions")) {
        return validateCompactMatchEvidence(value, context);
      }
      return validateSparseMatchEvidence(value, context);
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

function isExperienceYearsRequirement(requirement) {
  const source = `${requirement?.requirement || ""} ${requirement?.jdEvidence || ""}`;
  const numeral = String.raw`(?:\d+|一|二|两|三|四|五|六|七|八|九|十)`;
  const years = String.raw`${numeral}\s*(?:[-至到~～]\s*${numeral})?\s*年`;
  const experience = String.raw`(?:经验|年限|工作经历|从业经历|相关经历)`;
  return new RegExp(`${experience}.{0,20}${years}|${years}.{0,12}${experience}`).test(source);
}

function isSoftOnlyEligibilityConstraint(value) {
  const source = String(value || "");
  const softPattern = /可接受|接受应届|欢迎应届|应届亦可|均可|优先|加分|不限|无硬性要求/;
  const soft = softPattern.test(source);
  const hard = /仅限|只招|仅招|只接受|仅接受|必须|须为|限定|不接受|不招|不得|硬性/.test(source);
  const hasSeparateHardQualification = source.split(/[，,；;。()（）/、]|并且|同时|而且|以及|和|且|但/)
    .some((part) => !softPattern.test(part) && /大专|专科|本科|学士|硕士|研究生|博士|学历|学位|证书|资格证/.test(part));
  return soft && !hard && !hasSeparateHardQualification;
}

function hasExplicitCoreIncompatibilityEvidence(value) {
  const source = String(value || "");
  if (/不能确认|不能确定|不能判断|不能证明|无法确认|无法确定|无法判断|无法证明|不确定|待确认|尚待确认|无法从(?:简历|现有材料|材料)确认/.test(source)) {
    return false;
  }
  return /不接受|不考虑|拒绝|不能|无法|不愿|只接受|仅接受/.test(source);
}

function normalizedCohortYear(value) {
  const digits = String(value || "");
  return Number(digits.length === 2 ? `20${digits}` : digits);
}

function cohortYears(value) {
  const source = String(value || "");
  const years = new Set();
  for (const match of source.matchAll(/((?:20)?\d{2})\s*[-至到~～]\s*((?:20)?\d{2})\s*届/g)) {
    const first = normalizedCohortYear(match[1]);
    const last = normalizedCohortYear(match[2]);
    if (Number.isInteger(first) && Number.isInteger(last) && last >= first && last - first <= 10) {
      for (let year = first; year <= last; year += 1) years.add(year);
    }
  }
  for (const match of source.matchAll(/((?:(?:20)?\d{2}\s*(?:、|,|，|\/|或)\s*)+(?:20)?\d{2})\s*届/g)) {
    for (const year of match[1].matchAll(/(?:20)?\d{2}/g)) years.add(normalizedCohortYear(year[0]));
  }
  for (const match of source.matchAll(/((?:20)?\d{2})\s*(?:届|年.{0,8}毕业)/g)) {
    years.add(normalizedCohortYear(match[1]));
  }
  return [...years];
}

function cohortConstraint(value) {
  const source = String(value || "");
  const after = source.match(/((?:20)?\d{2})\s*届\s*(?:及\s*)?(?:以后|之后|起)/);
  const before = source.match(/((?:20)?\d{2})\s*届\s*(?:及\s*)?(?:以前|之前)/);
  return {
    years: cohortYears(source),
    minimum: after ? normalizedCohortYear(after[1]) : 0,
    maximum: before ? normalizedCohortYear(before[1]) : 0
  };
}

function matchesCohortConstraint(constraint, year) {
  return constraint.years.includes(year)
    || Boolean(constraint.minimum && year >= constraint.minimum)
    || Boolean(constraint.maximum && year <= constraint.maximum);
}

const EDUCATION_RANKS = Object.freeze({
  中专: 1,
  高中: 1,
  大专: 2,
  专科: 2,
  本科: 3,
  学士: 3,
  硕士: 4,
  研究生: 4,
  博士: 5
});

function educationMentions(value) {
  const source = String(value || "");
  return [...source.matchAll(/中专|高中|大专|专科|本科|学士|硕士|研究生|博士/g)]
    .map((match) => {
      const before = source.slice(Math.max(0, match.index - 10), match.index);
      const after = source.slice(match.index + match[0].length, match.index + match[0].length + 12);
      return {
        label: match[0],
        rank: EDUCATION_RANKS[match[0]],
        index: match.index,
        negated: /(?:未取得|未获得|未达到|没有|无).{0,4}$/.test(before)
          || /^(?:学历|学位)?(?:尚未取得|未取得|未获得|未达到|没有|无)/.test(after)
      };
    });
}

function educationRank(value) {
  return educationMentions(value)
    .filter((item) => !item.negated)
    .reduce((highest, item) => Math.max(highest, item.rank), 0);
}

function negatedEducationRank(value) {
  return educationMentions(value)
    .filter((item) => item.negated)
    .reduce((highest, item) => Math.max(highest, item.rank), 0);
}

function eligibilityClauses(value) {
  return String(value || "")
    .split(/[，,；;。()（）/、]|并且|同时|而且|以及|和|且|但/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isSoftQualificationClause(value) {
  return /优先|加分|可选|可接受|不限|无硬性要求/.test(String(value || ""));
}

function requiredEducationRank(value) {
  for (const clause of eligibilityClauses(value)) {
    if (isSoftQualificationClause(clause)) continue;
    const mentions = educationMentions(clause);
    const threshold = mentions.find((item) => {
      const before = clause.slice(Math.max(0, item.index - 8), item.index);
      const after = clause.slice(item.index + item.label.length, item.index + item.label.length + 8);
      return /(?:至少|最低|不低于).{0,4}$/.test(before) || /^(?:学历)?(?:及以上|以上|起)/.test(after);
    });
    if (threshold) return threshold.rank;
    if (mentions.length) return mentions[0].rank;
  }
  return 0;
}

function requiredCertificate(value) {
  const clause = String(value || "")
    .replace(/JD[：:]?/gi, " ")
    .split(/[，,；;。()（）/、]|并且|同时|而且|以及|和|且|但/)
    .find((part) => /资格证|证书|认证/.test(part)
      && /必须|须|硬性|要求|应当|需要|持有|须持|必备|具有|具备|取得|通过/.test(part)
      && !isSoftQualificationClause(part));
  const source = String(clause || "")
    .replace(/(?:必须持有|必须持|须持有|须持|持有|持|必须|须|硬性|要求|应当|需要|必备项?|具有|具备|取得|通过|有效的?)/g, " ");
  const match = source.match(/(?:^|[\s：:])([A-Za-z0-9\u4e00-\u9fa5]{1,16}(?:资格证|证书|认证))/);
  return match?.[1] || "";
}

function requiresFullTimeEducation(value) {
  return eligibilityClauses(value)
    .some((part) => /全日制/.test(part) && !/非全日制/.test(part) && !isSoftQualificationClause(part));
}

function hasExplicitEligibilityConflictEvidence(requirement, jdEvidence, resumeEvidence) {
  const expected = `${requirement || ""} ${jdEvidence || ""}`.trim();
  const actual = String(resumeEvidence || "").trim();
  if (!expected || !actual
    || /未提供|未体现|未提及|未说明|不能确认|不能确定|无法确认|无法确定|不确定|待确认|尚待确认|信息不足|缺少(?:相关)?信息|可能|似乎|或许|疑似|大概|推测|估计|也许|未知|不详|未核实|待核实/.test(actual)) {
    return false;
  }

  const expectedCohort = cohortConstraint(expected);
  const actualYears = cohortYears(actual);
  if (expectedCohort.years.length && actualYears.length && /仅限|只招|仅招|限定|仅面向|只接受|仅接受/.test(expected)) {
    if (!actualYears.some((year) => matchesCohortConstraint(expectedCohort, year))) return true;
  }
  const requiresInSchool = expected
    && eligibilityClauses(expected)
      .some((part) => !isSoftQualificationClause(part)
        && !/(?:非|不)在校|(?:非|不)在读|不(?:要求|需要|限).{0,8}(?:在校|在读)|无需.{0,8}(?:在校|在读)/.test(part)
        && /(?:仅限|只招|仅招|限定|仅面向|必须|须为|需为|需要是|需要为|硬性要求|要求为|要求).{0,16}(?:在校|在读)/.test(part));
  if (requiresInSchool && /已毕业|已经毕业|毕业于|非在校|不在校|已离校|已退学/.test(actual)) return true;

  const minimumEducation = requiredEducationRank(expected);
  const actualEducation = educationRank(actual);
  if (requiresFullTimeEducation(expected) && /非全日制|非统招|成人(?:教育|本科)|函授|自考/.test(actual)) return true;
  if (minimumEducation && actualEducation && actualEducation < minimumEducation) return true;
  if (minimumEducation && actualEducation < minimumEducation && negatedEducationRank(actual) >= minimumEducation) return true;

  const certificate = requiredCertificate(expected);
  if (certificate && actual.includes(certificate)
    && (new RegExp(`(?:未取得|未持有|没有|无).{0,8}${certificate}`).test(actual)
      || new RegExp(`${certificate}.{0,8}(?:尚未取得|未取得|未持有|没有|无)`).test(actual))) {
    return true;
  }
  return false;
}

function validateJobUnderstanding(value) {
  if (Object.prototype.hasOwnProperty.call(value, "requirements")
    || Object.prototype.hasOwnProperty.call(value, "eligibility")
    || Object.prototype.hasOwnProperty.call(value, "riskSignals")) {
    return validateCompactJobUnderstanding(value);
  }
  const evidenceSnippets = contractStringArray(value.evidenceSnippets, "understandJob", "evidenceSnippets", 8);
  const eligibilityConstraints = contractStringArray(value.eligibilityConstraints, "understandJob", "eligibilityConstraints", 8)
    .filter((item) => !isSoftOnlyEligibilityConstraint(item));
  const responsibilityEvidence = Object.prototype.hasOwnProperty.call(value, "responsibilityEvidence")
    ? responsibilityEvidenceList(value.responsibilityEvidence)
    : [];
  const hiringTracks = normalizeHiringTracks(value.hiringTracks, {
    roleSummary: value.roleSummary,
    responsibilityEvidence
  });
  const trackIds = new Set(hiringTracks.map((track) => track.id));
  const coreRequirements = understandingCoreRequirements(value.coreRequirements)
    .map((item, index) => ({
      id: `R${index + 1}`,
      ...item,
      trackIds: Object.prototype.hasOwnProperty.call(value.coreRequirements?.[index] || {}, "trackIds")
        ? normalizeRequirementTrackIds(value.coreRequirements[index].trackIds, trackIds, `coreRequirements[${index}]`)
        : ["T1"]
    }));
  const normalized = {
    jobId: text(value.jobId),
    industryContext: text(value.industryContext || value.businessScenario || "未明确"),
    hiringTracks,
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
  if (hiringTracks.length === 1) {
    normalized.roleSummary = hiringTracks[0].roleSummary;
    normalized.responsibilityEvidence = hiringTracks[0].responsibilityEvidence;
  }
  return normalized;
}

function validateCompactJobUnderstanding(value) {
  const industryContext = requiredCompactString(value.industryContext, "industryContext");
  const hasHiringTracks = Object.prototype.hasOwnProperty.call(value, "hiringTracks");
  if (hasHiringTracks && !Array.isArray(value.hiringTracks)) {
    throw new ModelContractError("understandJob", "hiringTracks 必须是数组");
  }
  if (hasHiringTracks && (Object.prototype.hasOwnProperty.call(value, "roleSummary")
    || Object.prototype.hasOwnProperty.call(value, "responsibilityEvidence"))) {
    throw new ModelContractError("understandJob", "hiringTracks 紧凑格式不得包含顶层 roleSummary 或 responsibilityEvidence");
  }
  if (hasHiringTracks && Object.keys(value).some((field) => ![
    "industryContext", "hiringTracks", "requirements", "eligibility", "riskSignals"
  ].includes(field))) {
    throw new ModelContractError("understandJob", "新版紧凑 understandJob 只允许 industryContext、hiringTracks、requirements、eligibility、riskSignals");
  }
  if (!hasHiringTracks) {
    requiredCompactString(value.roleSummary, "roleSummary");
    responsibilityEvidenceList(value.responsibilityEvidence);
  }
  const hiringTracks = normalizeHiringTracks(value.hiringTracks, {
    roleSummary: value.roleSummary,
    responsibilityEvidence: value.responsibilityEvidence
  });
  const trackIds = new Set(hiringTracks.map((track) => track.id));
  const requirements = requiredCompactArray(value.requirements, "requirements");
  if (requirements.length > 16) {
    throw new ModelContractError("understandJob", "requirements 最多包含 16 条");
  }
  const eligibility = requiredCompactArray(value.eligibility, "eligibility");
  const riskSignals = requiredCompactArray(value.riskSignals, "riskSignals");
  for (const requirement of requirements) {
    validateCompactEvidence(requirement?.evidence, "requirements.evidence");
  }
  for (const riskSignal of riskSignals) {
    validateCompactEvidence(riskSignal?.evidence, "riskSignals.evidence");
  }
  const coreRequirements = understandingCoreRequirements(requirements, { requireFoundation: true })
    .map((item, index) => ({
      id: `R${index + 1}`,
      ...item,
      trackIds: hasHiringTracks
        ? normalizeRequirementTrackIds(requirements[index]?.trackIds, trackIds, `requirements[${index}]`)
        : ["T1"]
    }));
  const eligibilityConstraints = contractStringArray(eligibility, "understandJob", "eligibility", 8)
    .filter((item) => !isSoftOnlyEligibilityConstraint(item));
  const hiddenRisks = understandingHiddenRisks(riskSignals);
  const concerns = hiddenRisks.map(({ type, evidence }) => ({ type, evidence }));
  const normalized = {
    jobId: text(value.jobId),
    industryContext,
    hiringTracks,
    realRoleType: "unknown",
    businessScenario: "",
    coreResponsibilities: [],
    coreRequirements,
    preferredRequirements: [],
    outcomeExpectations: [],
    coreStack: [],
    niceToHave: [],
    senioritySignal: "unknown",
    eligibilityConstraints,
    eligibilityItems: eligibilityConstraints.map((label, index) => ({ id: `E${index + 1}`, label })),
    hiddenRisks,
    jobQuality: {
      level: hiddenRisks.some((risk) => risk.severity === "high") ? "risk" : (hiddenRisks.length ? "caution" : "normal"),
      concerns
    },
    isFakeAI: false,
    isTrainingOrSales: false,
    evidenceSnippets: []
  };
  if (hiringTracks.length === 1) {
    normalized.roleSummary = hiringTracks[0].roleSummary;
    normalized.responsibilityEvidence = hiringTracks[0].responsibilityEvidence;
  }
  return normalized;
}

function normalizeHiringTracks(value, legacy = {}) {
  const hasExplicitTracks = Array.isArray(value);
  const source = hasExplicitTracks ? value : [{
    id: "T1",
    label: "默认招聘方向",
    roleSummary: legacy.roleSummary || "未明确主体工作",
    responsibilityEvidence: legacy.responsibilityEvidence || []
  }];
  if (!source.length || source.length > 4) {
    throw new ModelContractError("understandJob", "hiringTracks 必须包含 1-4 个招聘分支");
  }
  const seen = new Set();
  return source.map((item, index) => {
    const id = requiredContractString(item?.id, "understandJob", `hiringTracks[${index}].id`);
    if (id !== `T${index + 1}` || seen.has(id)) {
      throw new ModelContractError("understandJob", "hiringTracks.id 必须按 T1-T4 唯一连续编号");
    }
    seen.add(id);
    const responsibilityEvidence = responsibilityEvidenceList(item?.responsibilityEvidence);
    if (hasExplicitTracks && !responsibilityEvidence.length) {
      throw new ModelContractError("understandJob", `hiringTracks[${index}].responsibilityEvidence 必须至少包含一条 JD 证据`);
    }
    return {
      id,
      label: requiredCompactString(item?.label, `hiringTracks[${index}].label`),
      roleSummary: requiredCompactString(item?.roleSummary, `hiringTracks[${index}].roleSummary`),
      responsibilityEvidence
    };
  });
}

function normalizeRequirementTrackIds(value, trackIds, field) {
  if (!Array.isArray(value) || !value.length) {
    throw new ModelContractError("understandJob", `${field}.trackIds 必须是非空数组`);
  }
  const normalized = [...new Set(value.map((id) =>
    requiredContractString(id, "understandJob", `${field}.trackIds`)
  ))];
  if (normalized.some((id) => !trackIds.has(id))) {
    throw new ModelContractError("understandJob", `${field}.trackIds 包含不存在的招聘分支`);
  }
  return normalized;
}

function requirementsForTrack(jobUnderstanding, selectedTrackId) {
  const tracks = normalizeHiringTracks(jobUnderstanding?.hiringTracks, {
    roleSummary: jobUnderstanding?.roleSummary,
    responsibilityEvidence: jobUnderstanding?.responsibilityEvidence
  });
  const allTrackIds = tracks.map((track) => track.id);
  if (!allTrackIds.includes(selectedTrackId)) {
    throw new ModelContractError("matchJob", `selectedTrackId ${selectedTrackId} 不存在`);
  }
  return list(jobUnderstanding?.coreRequirements).filter((item) => {
    const owned = Array.isArray(item.trackIds) && item.trackIds.length ? item.trackIds : ["T1"];
    return owned.includes(selectedTrackId)
      || (allTrackIds.every((id) => owned.includes(id)) && owned.length === allTrackIds.length);
  });
}

function normalizeExpectedRequirement(item, index) {
  return {
    id: requiredContractString(item.id || `R${index + 1}`, "matchJob", "jobUnderstanding.coreRequirements.id"),
    label: requiredContractString(item.label, "matchJob", "jobUnderstanding.coreRequirements.label"),
    trackIds: Array.isArray(item.trackIds) && item.trackIds.length ? item.trackIds : ["T1"],
    foundation: Boolean(item.foundation),
    central: typeof item.central === "boolean" ? item.central : Boolean(item.indispensable),
    indispensable: Boolean(item.indispensable),
    evidence: requiredContractString(item.evidence, "matchJob", "jobUnderstanding.coreRequirements.evidence")
  };
}

function selectedTrackContext(value, jobUnderstanding) {
  if (!jobUnderstanding || typeof jobUnderstanding !== "object" || Array.isArray(jobUnderstanding)
    || !Array.isArray(jobUnderstanding.coreRequirements)
    || (!Array.isArray(jobUnderstanding.hiringTracks) && !text(jobUnderstanding.roleSummary))) {
    throw new ModelContractError("matchJob", "match evidence requires jobUnderstanding with core requirements and role data");
  }
  const legacySingleTrack = Array.isArray(jobUnderstanding?.hiringTracks)
    && jobUnderstanding.hiringTracks.length === 1
    && jobUnderstanding.hiringTracks[0]?.id === "T1"
    && !jobUnderstanding.hiringTracks[0]?.responsibilityEvidence?.length;
  const useLegacyTrackFallback = legacySingleTrack || !Array.isArray(jobUnderstanding?.hiringTracks);
  const tracks = normalizeHiringTracks(useLegacyTrackFallback ? undefined : jobUnderstanding?.hiringTracks, {
    roleSummary: jobUnderstanding?.roleSummary,
    responsibilityEvidence: jobUnderstanding?.responsibilityEvidence
  });
  const fallback = tracks.length === 1 && !Object.prototype.hasOwnProperty.call(value, "selectedTrackId")
    ? tracks[0].id
    : value.selectedTrackId;
  const selectedTrackId = requiredContractString(fallback, "matchJob", "selectedTrackId");
  const track = tracks.find((item) => item.id === selectedTrackId);
  if (!track) throw new ModelContractError("matchJob", `selectedTrackId ${selectedTrackId} 不存在`);
  return {
    trackCount: tracks.length,
    selectedTrackId,
    selectedTrackLabel: track.label,
    roleSummary: track.roleSummary,
    responsibilityEvidence: track.responsibilityEvidence,
    requirements: requirementsForTrack({
      ...jobUnderstanding,
      hiringTracks: useLegacyTrackFallback ? undefined : tracks
    }, selectedTrackId)
  };
}

function requiredCompactString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ModelContractError("understandJob", `${field} 必须是非空字符串`);
  }
  return text(value);
}

function requiredCompactArray(value, field) {
  if (!Array.isArray(value)) {
    throw new ModelContractError("understandJob", `${field} 必须是数组；没有内容时输出空数组 []`);
  }
  return value;
}

function responsibilityEvidenceList(value) {
  if (!Array.isArray(value)) {
    throw new ModelContractError("understandJob", "responsibilityEvidence 必须是字符串数组");
  }
  return value.map((item) => {
    const evidence = requiredContractString(item, "understandJob", "responsibilityEvidence");
    if (!evidence.startsWith("JD：") || evidence.length > 120) {
      throw new ModelContractError(
        "understandJob",
        "responsibilityEvidence 必须以“JD：”开头且不超过 120 个字符"
      );
    }
    return evidence;
  }).slice(0, 4);
}

function validateCompactEvidence(value, field) {
  if (typeof value !== "string" || !value.startsWith("JD：") || !value.slice("JD：".length).trim() || value.length > 120) {
    throw new ModelContractError("understandJob", `${field} evidence 必须以 JD：开头、包含原文且最多 120 个字符`);
  }
}

function validateSparseMatchEvidence(value, context = {}) {
  const jobUnderstanding = context?.jobUnderstanding;
  if (!jobUnderstanding || !Array.isArray(jobUnderstanding.coreRequirements)) {
    throw new ModelContractError("matchJob", "sparse match evidence requires jobUnderstanding");
  }
  const selected = selectedTrackContext(value, jobUnderstanding);
  const requirements = selected.requirements.map(normalizeExpectedRequirement);
  const eligibilityItems = Array.isArray(jobUnderstanding.eligibilityItems)
    ? jobUnderstanding.eligibilityItems
    : list(jobUnderstanding.eligibilityConstraints).map((label, index) => ({ id: `E${index + 1}`, label }));
  const matches = sparseEvidenceItems(value.matches, {
    field: "matches",
    expected: requirements,
    states: REQUIREMENT_MATCH_STATES,
    evidenceStates: ["matched", "transferable", "missing"]
  });
  const derivedRoleEvidence = selected.trackCount > 1
    ? {
      roleResumeEvidence: [...new Set(matches
        .filter((item) => ["matched", "transferable", "missing"].includes(item.state))
        .map((item) => item.resumeEvidence)
        .filter(Boolean))].slice(0, 4),
      roleGaps: matches
        .filter((item) => item.state === "missing")
        .map((item) => requirements.find((requirement) => requirement.id === item.id))
        .filter(Boolean)
        .map((requirement) => `${requirement.label}缺少直接简历证据`)
        .slice(0, 4)
    }
    : null;
  if (derivedRoleEvidence && ["misaligned", "insufficient_evidence"].includes(value.roleAlignment)
    && !derivedRoleEvidence.roleGaps.length) {
    derivedRoleEvidence.roleGaps.push("所选招聘方向的职责匹配信息待确认");
  }
  const roleAlignmentEvidence = validateRoleAlignmentEvidence(
    derivedRoleEvidence ? { ...value, ...derivedRoleEvidence } : value,
    selected
  );
  const eligibility = sparseEvidenceItems(value.eligibility, {
    field: "eligibility",
    expected: eligibilityItems,
    states: ELIGIBILITY_MATCH_STATES,
    evidenceStates: ["satisfied", "conflict"]
  });
  const byRequirementId = new Map(matches.map((item) => [item.id, item]));
  const byEligibilityId = new Map(eligibility.map((item) => [item.id, item]));
  const requirementMatches = requirements.map((requirement) => {
    const match = byRequirementId.get(requirement.id) || { state: "unknown", resumeEvidence: "" };
    const unverifiedIndispensableMissing = match.state === "missing"
      && requirement.indispensable
      && !hasExplicitCoreIncompatibilityEvidence(match.resumeEvidence);
    return {
      requirement: requirement.label,
      state: unverifiedIndispensableMissing ? "unknown" : match.state,
      foundation: requirement.foundation,
      central: requirement.central,
      indispensable: requirement.indispensable,
      jdEvidence: requirement.evidence,
      resumeEvidence: match.resumeEvidence
    };
  });
  const normalizedEligibility = eligibilityItems.map((item, index) => {
    const id = requiredContractString(item.id || `E${index + 1}`, "matchJob", "jobUnderstanding.eligibilityItems.id");
    const label = requiredContractString(item.label, "matchJob", "jobUnderstanding.eligibilityItems.label");
    const match = byEligibilityId.get(id) || { state: "unknown", resumeEvidence: "" };
    const verifiedConflict = match.state === "conflict" && hasExplicitEligibilityConflictEvidence(
      label,
      `JD：${label}`,
      match.resumeEvidence
    );
    return { id, label, state: match.state === "conflict" && !verifiedConflict ? "unknown" : match.state, resumeEvidence: match.resumeEvidence };
  });
  const hardBlockers = [];
  for (const match of requirementMatches) {
    if (match.indispensable && match.state === "missing" && !isExperienceYearsRequirement(match)) {
      hardBlockers.push({ kind: "indispensable_core", requirement: match.requirement, jdEvidence: match.jdEvidence, resumeEvidence: match.resumeEvidence });
    }
  }
  for (const item of normalizedEligibility) {
    if (item.state === "conflict") {
      hardBlockers.push({ kind: "eligibility", requirement: item.label, jdEvidence: `JD：${item.label}`, resumeEvidence: item.resumeEvidence });
    }
  }
  const unknownRequirements = requirementMatches.filter((item) => ["unknown", "not_applicable"].includes(item.state));
  const unknownEligibility = normalizedEligibility.filter((item) => item.state === "unknown");
  const transferable = requirementMatches.filter((item) => item.state === "transferable");
  const softMissing = requirementMatches.filter((item) => item.state === "missing" && !hardBlockers.some((blocker) => blocker.requirement === item.requirement));
  const decisionRequirements = requirementMatches.filter((item) => item.foundation || item.central || item.indispensable);
  const decisionUnknownRequirements = unknownRequirements.filter((item) => decisionRequirements.includes(item));
  const decisionTransferable = transferable.filter((item) => decisionRequirements.includes(item));
  const decisionSoftMissing = softMissing.filter((item) => decisionRequirements.includes(item));
  const jobQuality = jobUnderstanding.jobQuality || { level: "normal", concerns: [] };
  const hasPositiveEvidence = requirementMatches.some((item) => ["matched", "transferable"].includes(item.state));
  const completeDirect = decisionRequirements.length > 0
    && decisionRequirements.every((item) => item.state === "matched")
    && normalizedEligibility.every((item) => item.state === "satisfied");
  let recommendation;
  if (hardBlockers.length) recommendation = "skip";
  else if (!requirementMatches.length || !hasPositiveEvidence || decisionUnknownRequirements.length || unknownEligibility.length || jobQuality.level === "risk") recommendation = "review";
  else if (decisionTransferable.length || decisionSoftMissing.length || jobQuality.level === "caution") recommendation = "caution";
  else recommendation = "apply";
  const confidence = completeDirect ? 0.9 : hasPositiveEvidence && !decisionUnknownRequirements.length && !unknownEligibility.length ? 0.72 : 0.45;
  const fitLevel = recommendation === "skip" ? "D" : recommendation === "review" ? "C" : recommendation === "caution" ? "B" : "A";
  const fitReasons = [
    ...requirementMatches.filter((item) => ["matched", "transferable"].includes(item.state))
      .map((item) => `${item.requirement}：${item.state === "matched" ? "有直接简历证据" : "有可迁移简历证据"}`)
  ].slice(0, 8);
  const softGaps = [
    ...transferable.map((item) => `${item.requirement}目前只有可迁移证据`),
    ...softMissing.map((item) => `${item.requirement}缺少直接简历证据`),
    ...(jobQuality.level === "risk" ? ["岗位存在安全或合规风险，交由本地规则处理"] : [])
  ].slice(0, 8);
  const questionsToVerify = [
    ...unknownRequirements.map((item) => `${item.requirement}的信息待确认`),
    ...unknownEligibility.map((item) => `${item.label}的资格信息待确认`),
    ...(requirementMatches.length && !hasPositiveEvidence ? ["候选人核心要求证据缺少，待确认"] : [])
  ].slice(0, 8);
  const jdEvidence = requirementMatches.filter((item) => ["matched", "transferable", "missing"].includes(item.state)).map((item) => item.jdEvidence)
    .concat(hardBlockers.filter((item) => item.kind === "eligibility").map((item) => item.jdEvidence), list(jobUnderstanding.hiddenRisks).map((item) => text(item?.evidence)).filter(Boolean), list(jobQuality.concerns).map((item) => text(item?.evidence)).filter(Boolean)).slice(0, 6);
  const resumeEvidence = [...matches, ...normalizedEligibility].map((item) => item.resumeEvidence).filter(Boolean).slice(0, 6);
  return {
    selectedTrackId: selected.selectedTrackId,
    selectedTrackLabel: selected.selectedTrackLabel,
    roleSummary: selected.roleSummary,
    responsibilityEvidence: selected.responsibilityEvidence,
    ...roleAlignmentEvidence,
    matches,
    eligibility,
    recommendation, fitLevel, confidence, fitReasons, requirementMatches, jobQuality, hardBlockers, softGaps, questionsToVerify,
    missingPoints: softGaps, blockingGaps: hardBlockers.map((item) => item.requirement), riskQuestions: questionsToVerify,
    recommendedResumeVersion: "", primaryProjects: [], greetingAngle: "", evidence: { jd: jdEvidence, resume: resumeEvidence }, hrPrep: {}
  };
}

function validateRoleAlignmentEvidence(value, jobUnderstanding) {
  if (!ROLE_ALIGNMENT_STATES.includes(value.roleAlignment)) {
    throw new ModelContractError("matchJob", `roleAlignment must be one of ${ROLE_ALIGNMENT_STATES.join("/")}`);
  }
  const roleResumeEvidence = contractStringsStrict(value.roleResumeEvidence, "matchJob", "roleResumeEvidence", {
    prefix: "简历：", limit: 4, maxLength: 120
  });
  const roleGaps = contractStringsStrict(value.roleGaps, "matchJob", "roleGaps", { limit: 4, maxLength: 120 });
  const responsibilityEvidence = jobUnderstanding?.responsibilityEvidence || [];
  if (!responsibilityEvidence.length && value.roleAlignment !== "insufficient_evidence") {
    throw new ModelContractError("matchJob", "empty responsibilityEvidence requires insufficient_evidence");
  }
  if (["aligned", "mostly_aligned", "partially_aligned"].includes(value.roleAlignment) && !roleResumeEvidence.length) {
    throw new ModelContractError("matchJob", `${value.roleAlignment} requires roleResumeEvidence`);
  }
  if (value.roleAlignment === "misaligned" && (!responsibilityEvidence.length || !roleResumeEvidence.length || !roleGaps.length)) {
    throw new ModelContractError("matchJob", "misaligned requires responsibility evidence, resume evidence, and a gap");
  }
  if (value.roleAlignment === "insufficient_evidence" && !roleGaps.length) {
    throw new ModelContractError("matchJob", "insufficient_evidence requires a concrete gap");
  }
  return { roleAlignment: value.roleAlignment, roleResumeEvidence, roleGaps };
}

function sparseEvidenceItems(value, { field, expected, states, evidenceStates }) {
  if (!Array.isArray(value)) throw new ModelContractError("matchJob", `${field} must be an array`);
  const expectedIds = new Set(expected.map((item, index) => item.id || `${field === "matches" ? "R" : "E"}${index + 1}`));
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ModelContractError("matchJob", `${field} must contain evidence objects`);
    const id = requiredContractString(item.id, "matchJob", `${field}.id`);
    if (!expectedIds.has(id)) throw new ModelContractError("matchJob", `${field} contains unknown ID ${id}`);
    if (seen.has(id)) throw new ModelContractError("matchJob", `${field} contains duplicate ID ${id}`);
    seen.add(id);
    if (!states.includes(item.state)) throw new ModelContractError("matchJob", `${field}.state is invalid`);
    const resumeEvidence = optionalContractString(item.resumeEvidence, "matchJob", `${field}.resumeEvidence`);
    if (evidenceStates.includes(item.state) && !resumeEvidence) throw new ModelContractError("matchJob", `${field}.${item.state} requires resumeEvidence`);
    if (resumeEvidence) validateMatchResumeEvidence(resumeEvidence, field);
    return { id, state: item.state, resumeEvidence };
  });
}

function validateCompactMatchEvidence(value, context = {}) {
  const jobUnderstanding = context?.jobUnderstanding;
  if (!jobUnderstanding || !Array.isArray(jobUnderstanding.coreRequirements)) {
    throw new ModelContractError("matchJob", "紧凑匹配证据必须携带本次 jobUnderstanding");
  }
  const selected = selectedTrackContext(value, jobUnderstanding);
  if (selected.trackCount > 1) {
    throw new ModelContractError("matchJob", "multi-track matching requires sparse evidence");
  }
  const requirements = selected.requirements.map(normalizeExpectedRequirement);
  const eligibilityItems = Array.isArray(jobUnderstanding.eligibilityItems)
    ? jobUnderstanding.eligibilityItems
    : list(jobUnderstanding.eligibilityConstraints).map((label, index) => ({ id: `E${index + 1}`, label }));

  const matches = compactEvidenceItems(value.matches, {
    field: "matches",
    expected: requirements,
    states: REQUIREMENT_MATCH_STATES,
    evidenceStates: ["matched", "transferable"]
  });
  const expectedEligibilityById = new Map(eligibilityItems.map((item) => [item.id, item]));
  const eligibility = compactEvidenceItems(value.eligibility, {
    field: "eligibility",
    expected: eligibilityItems,
    states: ELIGIBILITY_MATCH_STATES,
    evidenceStates: ["satisfied", "conflict"]
  }).map((item) => item.state === "conflict" && !hasExplicitEligibilityConflictEvidence(
    expectedEligibilityById.get(item.id)?.label,
    "",
    item.resumeEvidence
  )
    ? { ...item, state: "unknown", resumeEvidence: "" }
    : item);
  const uncertainties = contractStringArray(value.uncertainties, "matchJob", "uncertainties", 8);
  const cautions = compactCautions(value.cautions);
  if (!MATCH_CERTAINTY_LEVELS.includes(value.certainty)) {
    throw new ModelContractError("matchJob", `certainty 必须是 ${MATCH_CERTAINTY_LEVELS.join("/")} 之一`);
  }

  const byRequirementId = new Map(matches.map((item) => [item.id, item]));
  const requirementMatches = requirements.map((requirement) => {
    const match = byRequirementId.get(requirement.id);
    const evidencedCoreConflict = match.state === "missing"
      && requirement.indispensable
      && hasExplicitCoreIncompatibilityEvidence(match.resumeEvidence);
    return {
      requirement: requirement.label,
      state: match.state === "missing" && requirement.indispensable && !evidencedCoreConflict ? "unknown" : match.state,
      foundation: requirement.foundation,
      central: requirement.central,
      indispensable: requirement.indispensable,
      jdEvidence: requirement.evidence,
      resumeEvidence: match.resumeEvidence
    };
  });
  const byEligibilityId = new Map(eligibility.map((item) => [item.id, item]));
  const hardBlockers = [];
  for (const requirement of requirementMatches) {
    if (!requirement.indispensable
      || requirement.state !== "missing"
      || !requirement.resumeEvidence
      || isExperienceYearsRequirement(requirement)) continue;
    hardBlockers.push({
      kind: "indispensable_core",
      requirement: requirement.requirement,
      jdEvidence: requirement.jdEvidence,
      resumeEvidence: requirement.resumeEvidence
    });
  }
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
  const decisionRequirements = requirementMatches.filter((item) => item.foundation || item.central || item.indispensable);
  const decisionUnknownRequirements = unknownRequirements.filter((item) => decisionRequirements.includes(item));
  const decisionTransferable = transferable.filter((item) => decisionRequirements.includes(item));
  const decisionSoftMissing = softMissing.filter((item) => decisionRequirements.includes(item));
  const decisionCautions = cautions.filter((item) => ["candidate_transition", "preference_conflict"].includes(item.kind));
  const jobQuality = jobUnderstanding.jobQuality || { level: "normal", concerns: [] };
  const hasPositiveRequirementEvidence = requirementMatches.some((item) => ["matched", "transferable"].includes(item.state));
  let recommendation;
  if (hardBlockers.length) recommendation = "skip";
  else if (!requirementMatches.length || !hasPositiveRequirementEvidence || decisionUnknownRequirements.length || unknownEligibility.length
    || uncertainties.length || value.certainty === "low" || jobQuality.level === "risk") recommendation = "review";
  else if (decisionTransferable.length || decisionSoftMissing.length || decisionCautions.length || jobQuality.level === "caution") recommendation = "caution";
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
    ...(!requirementMatches.length ? ["JD 信息不足，未提取到可核对的核心要求"] : []),
    ...(jobQuality.level === "risk" ? ["岗位存在安全或合规风险，交由本地规则处理"] : [])
  ].slice(0, 8);
  const questionsToVerify = [
    ...uncertainties,
    ...unknownRequirements.map((item) => `${item.requirement}的信息待确认`),
    ...unknownEligibility.map((item) => `${eligibilityItems.find((entry) => entry.id === item.id)?.label || item.id}的资格信息待确认`),
    ...(requirementMatches.length && !hasPositiveRequirementEvidence ? ["候选人核心要求证据缺少，待确认"] : [])
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
    selectedTrackId: selected.selectedTrackId,
    selectedTrackLabel: selected.selectedTrackLabel,
    roleSummary: selected.roleSummary,
    responsibilityEvidence: selected.responsibilityEvidence,
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
    if (resumeEvidence) validateMatchResumeEvidence(resumeEvidence, field);
    return { id, state: item.state, resumeEvidence };
  });
  for (const item of expected) {
    if (!seen.has(item.id)) throw new ModelContractError("matchJob", `${field} 漏掉 ${item.id}`);
  }
  return result;
}

function validateMatchResumeEvidence(resumeEvidence, field) {
  if (!resumeEvidence.startsWith("简历：") || !resumeEvidence.slice("简历：".length).trim() || resumeEvidence.length > 120) {
    throw new ModelContractError("matchJob", `${field}.resumeEvidence 必须以“简历：”开头、包含候选人事实且最多 120 个字符`);
  }
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

function understandingCoreRequirements(value, { requireFoundation = false } = {}) {
  const requirements = list(value).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ModelContractError("understandJob", "coreRequirements 必须是 {label,indispensable,evidence} 对象数组，不接受字符串");
    }
    const label = requiredContractString(item.label, "understandJob", "coreRequirements.label");
    const evidence = requiredContractString(item.evidence, "understandJob", "coreRequirements.evidence");
    if (typeof item.indispensable !== "boolean") {
      throw new ModelContractError("understandJob", `coreRequirements「${label}」的 indispensable 必须是 boolean`);
    }
    if (requireFoundation && typeof item.foundation !== "boolean") {
      throw new ModelContractError("understandJob", `coreRequirements「${label}」的 foundation 必须是 boolean`);
    }
    return {
      label,
      foundation: requireFoundation ? item.foundation : Boolean(item.foundation),
      central: typeof item.central === "boolean" ? item.central : Boolean(item.indispensable),
      indispensable: item.indispensable,
      evidence
    };
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
      foundation: Boolean(item.foundation),
      central: typeof item.central === "boolean" ? item.central : item.indispensable,
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
  const roleAlignment = ROLE_ALIGNMENT_STATES.includes(value.roleAlignment) ? value.roleAlignment : "";
  const roleResumeEvidence = Array.isArray(value.roleResumeEvidence) ? contractStrings(value.roleResumeEvidence, 4) : [];
  const roleGaps = Array.isArray(value.roleGaps) ? contractStrings(value.roleGaps, 4) : [];
  const jobUnderstanding = context?.jobUnderstanding;
  const selected = selectedTrackContext(value, jobUnderstanding);
  if (selected.trackCount > 1) {
    throw new ModelContractError("matchJob", "multi-track matching requires sparse evidence");
  }
  const requirements = selected.requirements.map(normalizeExpectedRequirement);
  if (jobUnderstanding && Array.isArray(jobUnderstanding.coreRequirements)) {
    assertRequirementCoverage(requirements, requirementMatches);
    const sourceRequirements = new Map(requirements.map((item) => [text(item.label), item]));
    for (const match of requirementMatches) {
      const source = sourceRequirements.get(match.requirement);
      match.foundation = Boolean(source?.foundation);
      match.central = typeof source?.central === "boolean" ? source.central : Boolean(source?.indispensable);
      match.indispensable = Boolean(source?.indispensable);
    }
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
    if (!hasExplicitCoreIncompatibilityEvidence(blocker.resumeEvidence)) {
      throw new ModelContractError("matchJob", `indispensable_core 硬性阻断「${blocker.requirement}」必须包含候选人明确不兼容的事实`);
    }
  }
  for (const blocker of hardBlockers) {
    if (blocker.kind === "eligibility" && !hasExplicitEligibilityConflictEvidence(
      blocker.requirement,
      blocker.jdEvidence,
      blocker.resumeEvidence
    )) {
      throw new ModelContractError("matchJob", `eligibility 硬性阻断「${blocker.requirement}」不能仅依据资格信息缺失`);
    }
  }
  for (const match of requirementMatches) {
    if (match.indispensable
      && match.state === "missing"
      && !isExperienceYearsRequirement(match)
      && !hardBlockers.some((blocker) => blocker.kind === "indispensable_core" && blocker.requirement === match.requirement)) {
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
    selectedTrackId: selected.selectedTrackId,
    selectedTrackLabel: selected.selectedTrackLabel,
    roleSummary: selected.roleSummary,
    responsibilityEvidence: selected.responsibilityEvidence,
    roleAlignment,
    roleResumeEvidence,
    roleGaps,
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
  const structured = Boolean(item) && typeof item === "object" && !Array.isArray(item)
    && HARD_BLOCKER_KINDS.includes(item.kind)
    && typeof item.requirement === "string" && Boolean(item.requirement.trim())
    && typeof item.jdEvidence === "string" && Boolean(item.jdEvidence.trim())
    && typeof item.resumeEvidence === "string" && Boolean(item.resumeEvidence.trim());
  if (!structured) return false;
  if (item.kind === "indispensable_core") return hasExplicitCoreIncompatibilityEvidence(item.resumeEvidence);
  if (item.kind === "eligibility") {
    return hasExplicitEligibilityConflictEvidence(item.requirement, item.jdEvidence, item.resumeEvidence);
  }
  return true;
}

function decisionHardBlockers(analysis = {}) {
  return list(analysis.hardBlockers).filter(isDecisionHardBlocker);
}

function roleCoreEvidenceState(analysis = {}) {
  const central = list(analysis.requirementMatches).filter((item) => (
    item?.central === true
      || (typeof item?.central !== "boolean" && item?.indispensable === true)
  ));
  const centralEvidence = central.filter((item) => (
    ["matched", "transferable"].includes(item.state)
      && typeof item.resumeEvidence === "string"
      && Boolean(item.resumeEvidence.trim())
  ));
  return {
    centralRequirementCount: central.length,
    centralEvidenceCount: centralEvidence.length,
    unproven: central.length > 0 && centralEvidence.length === 0
  };
}

function roleEvidenceDecisionState(analysis = {}) {
  const matches = Array.isArray(analysis.requirementMatches) ? analysis.requirementMatches : [];
  const hasLayeredSemantics = ROLE_ALIGNMENT_STATES.includes(analysis.roleAlignment);
  const foundation = matches.filter((item) => item?.foundation === true);

  if (!hasLayeredSemantics) {
    const legacy = roleCoreEvidenceState(analysis);
    return {
      semantics: "legacy",
      alignment: "",
      foundationState: legacy.unproven ? "unproven" : "none",
      foundationRequirementCount: 0,
      foundationPositiveCount: 0,
      hasTransferableFoundation: false,
      hasConcreteFoundationGap: false,
      bucketCeiling: legacy.unproven ? "backup" : "primary",
      bucketFloor: null,
      reasonCode: legacy.unproven ? "legacy_role_core_unproven" : ""
    };
  }

  const positive = foundation.filter((item) => ["matched", "transferable"].includes(item.state));
  const foundationState = !foundation.length
    ? "none"
    : !positive.length
      ? "unproven"
      : positive.length === foundation.length
        ? "complete"
        : "partial";
  const hasTransferableFoundation = foundation.some((item) => item.state === "transferable");
  const hasTransferableCentral = matches.some((item) => item?.central === true && item.state === "transferable");
  const hasConcreteFoundationGap = matches.some((item) => (
    item?.state === "missing" && (item?.central === true || item?.foundation === true)
  ));

  let bucketCeiling = "backup";
  let bucketFloor = null;
  if (
    ["aligned", "mostly_aligned"].includes(analysis.roleAlignment)
    && foundationState === "complete"
    && !hasTransferableFoundation
    && !hasTransferableCentral
    && !hasConcreteFoundationGap
  ) {
    bucketCeiling = "primary";
    bucketFloor = "talk";
  } else if (["aligned", "mostly_aligned"].includes(analysis.roleAlignment) && !hasConcreteFoundationGap) {
    bucketCeiling = "talk";
    bucketFloor = "talk";
  } else if (
    !hasConcreteFoundationGap
    && ((analysis.roleAlignment === "aligned" && ["complete", "partial"].includes(foundationState))
      || (analysis.roleAlignment === "mostly_aligned" && ["complete", "partial"].includes(foundationState)))
  ) {
    bucketCeiling = "talk";
  }

  return {
    semantics: "layered",
    alignment: analysis.roleAlignment,
    foundationState,
    foundationRequirementCount: foundation.length,
    foundationPositiveCount: positive.length,
    hasTransferableFoundation,
    hasConcreteFoundationGap,
    bucketCeiling,
    bucketFloor,
    reasonCode: roleEvidenceReasonCode(analysis.roleAlignment, foundationState)
  };
}

function roleEvidenceReasonCode(alignment, foundationState) {
  if (alignment !== "aligned") return `role_${alignment}`;
  return foundationState === "complete" ? "role_aligned" : `foundation_${foundationState}`;
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

function contractStringsStrict(value, kind, field, { prefix = "", limit, maxLength }) {
  if (!Array.isArray(value)) throw new ModelContractError(kind, `${field} must be an array`);
  return [...new Set(value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new ModelContractError(kind, `${field} must contain non-empty strings`);
    const itemText = item.trim();
    if ((prefix && (!itemText.startsWith(prefix) || !itemText.slice(prefix.length).trim())) || itemText.length > maxLength) {
      throw new ModelContractError(kind, `${field} must use the required evidence format`);
    }
    return itemText;
  }))].slice(0, limit);
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

module.exports = {
  ModelContractError,
  validateModelResult,
  effectiveHardBlockers,
  decisionHardBlockers,
  roleCoreEvidenceState,
  roleEvidenceDecisionState,
  hardBlockerText,
  requirementsForTrack
};
