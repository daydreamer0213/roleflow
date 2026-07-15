const { cityToBossCode } = require("./search_plan");

function normalizeCandidateProfile(input = {}, meta = {}) {
  const source = object(input.source);
  const candidate = object(input.candidate);
  const projects = list(input.projects).map(normalizeProject).filter((item) => item.name).slice(0, 10);
  const skills = list(input.skills).map(normalizeSkill).filter((item) => item.name).slice(0, 40);
  const targetTitles = strings(candidate.targetTitles || candidate.targetTitle || candidate.target_roles || candidate.directions, 10);
  const city = text(candidate.city || candidate.location || "");
  return {
    candidate: {
      name: text(candidate.name || "候选人"),
      city,
      targetTitles,
      expectedSalary: text(candidate.expectedSalary),
      adjustableSalary: strings(candidate.adjustableSalary, 4)
    },
    education: list(input.education || input.educations).map(normalizeEducation).filter((item) => item.school || item.degree || item.major).slice(0, 6),
    experiences: list(input.experiences || input.workExperiences || input.workExperience || input.internships).map(normalizeExperienceRecord).filter((item) => item.organization || item.role).slice(0, 12),
    skills,
    projects,
    credentials: list(input.credentials || input.certificates).map(normalizeCredential).filter((item) => item.name).slice(0, 12),
    strengths: strings(input.strengths || input.personalStrengths || input.advantages, 12),
    // Real resume versions are persisted from user uploads, never invented during profile parsing.
    resumeVersions: [],
    riskMessaging: meta.allowRiskMessaging ? normalizeRiskMessaging(input.riskMessaging) : {},
    // 简历画像只保留可投递的信息，不把模型对简历细节的追问展示给用户。
    evidenceGaps: [],
    source: {
      provider: text(source.provider || meta.provider || ""),
      model: text(source.model || meta.model || ""),
      resumeTextLength: Number(source.resumeTextLength || meta.resumeTextLength || 0),
      inputMethod: text(source.inputMethod || meta.inputMethod || "unknown"),
      inputTrust: text(source.inputTrust || meta.inputTrust || "user_provided"),
      generatedAt: new Date().toISOString()
    }
  };
}

function normalizeSearchPlan(input = {}, candidateProfile = {}) {
  const candidate = object(candidateProfile.candidate);
  const city = strings(input.cities || input.city || candidate.city, 5);
  const keywordInput = input.keywords || input.includeKeywords || input.searchKeywords;
  const keywords = list(keywordInput).map(normalizeKeyword).filter((item) => item.word).slice(0, 18);
  const fallbackKeywords = keywords.length ? keywords : defaultKeywords(candidateProfile);
  const salary = object(input.salary);
  const platform = object(input.platform);
  const minK = number(input.salaryMinK ?? salary.minK, inferSalary(candidate.expectedSalary).min);
  const maxK = number(input.salaryMaxK ?? salary.maxK, inferSalary(candidate.expectedSalary).max);
  return {
    name: text(input.name || `${city[0] || "目标城市"}岗位筛选计划`),
    platform: {
      site: normalizePlatformSite(platform.site || input.site || "boss"),
      salaryLanes: strings(platform.salaryLanes || input.platformSalaryLanes, 4)
    },
    cities: city,
    bossCityCode: text(input.bossCityCode || cityToBossCode(city[0]) || ""),
    salary: { minK, maxK },
    salaryMode: input.salaryMode === "strict" ? "strict" : "wide",
    experience: normalizeExperience(input.experience || ["经验不限", "0-3年", "1-3年"]),
    jobTypes: strings(input.jobTypes || input.jobType || ["全职"], 4),
    degrees: strings(input.degrees || input.degree, 8),
    allowExperienceStretch: input.allowExperienceStretch !== false,
    bossActiveDays: normalizeBossActiveDays(input.bossActiveDays),
    workSchedulePreference: normalizeWorkSchedulePreference(input.workSchedulePreference),
    directions: strings(input.directions || candidate.targetTitles, 10),
    keywords: fallbackKeywords,
    excludeWords: strings(input.excludeWords || input.excludeTerms || ["销售", "培训", "讲师", "课程顾问"], 20),
    hardExcludes: strings(input.hardExcludes, 20),
    scan: {
      maxCards: Math.max(10, Math.min(200, number(object(input.scan).maxCards, 80))),
      detailLimit: Math.max(0, Math.min(12, number(object(input.scan).detailLimit, 8))),
      maxDetailTotal: Math.max(1, Math.min(24, number(object(input.scan).maxDetailTotal, 24))),
      browserPageBudget: Math.max(20, Math.min(300, number(object(input.scan).browserPageBudget, 90)))
    },
    source: text(input.source || "model-recommended")
  };
}

function normalizeKeyword(value) {
  if (typeof value === "string") return { word: text(value), priority: "B", reason: "从简历方向生成" };
  const item = object(value);
  const priority = ["A", "B", "C"].includes(String(item.priority).toUpperCase()) ? String(item.priority).toUpperCase() : "B";
  return { word: text(item.word || item.keyword), priority, reason: text(item.reason || item.rationale || "从简历方向生成") };
}

function normalizeProject(value) {
  const item = object(value);
  return {
    name: text(item.name),
    period: text(item.period || item.time),
    context: text(item.context || item.background || item.description),
    roleBoundary: text(item.roleBoundary || item.boundary || "按简历事实稳健表达，不夸大职责边界。"),
    canSay: strings(item.canSay || item.contributions || item.highlights || item.skills, 16),
    technologies: strings(item.technologies || item.techStack || item.tags, 16),
    results: strings(item.results || item.outcomes || item.evidence, 10),
    avoidSaying: strings(item.avoidSaying, 8)
  };
}

function normalizeEducation(value) {
  if (typeof value === "string") return { school: text(value), degree: "", major: "", startDate: "", endDate: "", status: "", highlights: [] };
  const item = object(value);
  return {
    school: text(item.school || item.institution),
    degree: text(item.degree || item.educationLevel),
    major: text(item.major || item.field),
    startDate: text(item.startDate || item.start),
    endDate: text(item.endDate || item.end || item.graduationYear),
    status: text(item.status || item.graduationStatus),
    highlights: strings(item.highlights || item.details, 8)
  };
}

function normalizeExperienceRecord(value) {
  if (typeof value === "string") return { organization: text(value), role: "", type: "", startDate: "", endDate: "", roleBoundary: "", highlights: [], technologies: [] };
  const item = object(value);
  return {
    organization: text(item.organization || item.company || item.employer || item.projectParty),
    role: text(item.role || item.title || item.position),
    type: text(item.type || item.experienceType),
    startDate: text(item.startDate || item.start),
    endDate: text(item.endDate || item.end),
    roleBoundary: text(item.roleBoundary || item.boundary),
    highlights: strings(item.highlights || item.contributions || item.responsibilities, 16),
    technologies: strings(item.technologies || item.techStack, 16)
  };
}

function normalizeCredential(value) {
  if (typeof value === "string") return { name: text(value), details: "" };
  const item = object(value);
  return { name: text(item.name || item.title), details: text(item.details || item.level || item.score) };
}

function normalizeSkill(value) {
  if (typeof value === "string") return { name: text(value), level: "resume", evidence: [] };
  const item = object(value);
  return { name: text(item.name), level: text(item.level || "resume"), evidence: strings(item.evidence, 8) };
}

function normalizeResumeVersion(value, index) {
  const item = object(value);
  const name = text(item.name || `简历版本 ${index + 1}`);
  return {
    id: text(item.id || slug(name) || `resume_${index + 1}`),
    name,
    summary: text(item.summary),
    primaryProjects: strings(item.primaryProjects, 4),
    scenarios: strings(item.scenarios || item.targetRoles, 8),
    keywords: strings(item.keywords, 12)
  };
}

function normalizeRiskMessaging(value) {
  const item = object(value);
  const result = {};
  for (const key of ["gap", "shortProject", "deloitteInternship", "publicInfoProject"]) {
    if (text(item[key])) result[key] = text(item[key]);
  }
  return result;
}

function defaultKeywords(profile) {
  const candidate = object(profile.candidate);
  return strings(candidate.targetTitles, 10).map((word, index) => ({ word, priority: index < 4 ? "A" : "B", reason: "从候选人目标岗位生成" }));
}

function inferSalary(value) {
  const numbers = String(value || "").match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
  return { min: numbers[0] || 0, max: numbers[1] || numbers[0] || 0 };
}

function normalizeExperience(value) {
  const result = [...new Set(strings(value, 8).map(normalizeExperienceValue).filter(Boolean))];
  return result.length ? result : ["经验不限", "0-3年", "1-3年"];
}

function normalizeExperienceValue(value) {
  const textValue = text(value).replace(/^(\d+)-(\d+)\?$/, "$1-$2年");
  if (/^3-5年(?:（可冲）)?$/.test(textValue)) return "3-5年（可冲）";
  return textValue;
}

function normalizeBossActiveDays(value) {
  const days = number(value, 3);
  return [1, 3, 7].includes(days) ? days : 3;
}

function normalizeWorkSchedulePreference(value) {
  return value === "no_preference" ? "no_preference" : "prefer_double_weekend";
}

function normalizePlatformSite(value) {
  return String(value || "").trim().toLowerCase() || "boss";
}

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function list(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function text(value) { return String(value || "").trim().slice(0, 1000); }
function strings(value, limit) { return [...new Set(list(value).map((item) => text(item)).filter(Boolean))].slice(0, limit); }
function number(value, fallback) { const result = Number(value); return Number.isFinite(result) ? result : fallback; }
function slug(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }

module.exports = { normalizeCandidateProfile, normalizeSearchPlan, inferSalary, normalizeBossActiveDays, normalizeWorkSchedulePreference };
