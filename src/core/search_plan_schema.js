const SEARCH_PLAN_SCHEMA_VERSION = 2;
const MODES = new Set(["inherited", "generated"]);

function acquisitionModeOf(plan = {}) {
  const raw = String(plan?.acquisitionMode || "inherited").trim().toLowerCase();
  if (!MODES.has(raw)) {
    const error = new Error("采集模式无效。");
    error.code = "SEARCH_PLAN_ACQUISITION_MODE_INVALID";
    throw error;
  }
  return raw;
}

function generatedPlatformOf(plan = {}) {
  const nested = plan?.platform?.generated || {};
  return {
    cities: strings(nested.cities ?? plan.cities),
    salaryLanes: strings(nested.salaryLanes ?? plan?.platform?.salaryLanes),
    experience: strings(nested.experience ?? plan.experience),
    jobTypes: strings(nested.jobTypes ?? plan.jobTypes ?? plan.jobType),
    degrees: strings(nested.degrees ?? plan.degrees ?? plan.degree)
  };
}

function canonicalSearchPlanV2(plan = {}) {
  const generated = generatedPlatformOf(plan);
  return {
    schemaVersion: SEARCH_PLAN_SCHEMA_VERSION,
    name: String(plan.name || "岗位筛选计划").trim() || "岗位筛选计划",
    acquisitionMode: acquisitionModeOf(plan),
    platform: { site: String(plan?.platform?.site || "boss").trim().toLowerCase(), generated },
    salary: clone(plan.salary || {}),
    salaryMode: plan.salaryMode,
    allowExperienceStretch: plan.allowExperienceStretch !== false,
    bossActiveDays: plan.bossActiveDays,
    workSchedulePreference: plan.workSchedulePreference,
    directions: strings(plan.directions),
    keywords: clone(Array.isArray(plan.keywords) ? plan.keywords : []),
    excludeWords: strings(plan.excludeWords),
    hardExcludes: strings(plan.hardExcludes),
    scan: clone(plan.scan || {}),
    source: String(plan.source || "model-recommended")
  };
}

function strings(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  SEARCH_PLAN_SCHEMA_VERSION,
  acquisitionModeOf,
  generatedPlatformOf,
  canonicalSearchPlanV2
};
