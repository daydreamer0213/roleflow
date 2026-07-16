const CITY_CODES = {
  "广州": "101280100", "深圳": "101280600", "北京": "101010100", "上海": "101020100",
  "杭州": "101210100", "成都": "101270100", "武汉": "101200100", "南京": "101190100",
  "苏州": "101190400", "长沙": "101250100", "佛山": "101280800", "东莞": "101281600",
  "珠海": "101281800", "天津": "101030100", "西安": "101110100", "重庆": "101040100"
};
const { runtimeAnalysisContext, stableHash } = require("./analysis_revision");
const { PRODUCT_POLICY_VERSION, PRODUCT_POLICY } = require("./product_policy");

const DAILY_SCAN_LIMITS = PRODUCT_POLICY.dailyScan;

function cityToBossCode(city) {
  return CITY_CODES[String(city || "").trim()] || "";
}

function profileToRuntimeConfigs(configs, candidateProfile, searchPlan, resumeVersionsOverride = null) {
  const plan = searchPlan || {};
  const candidate = candidateProfile?.candidate || {};
  const persistedVersions = Array.isArray(resumeVersionsOverride) ? resumeVersionsOverride
    .filter((item) => item && item.isActive !== false)
    .map((item) => ({
      id: item.versionKey || item.id,
      name: item.name,
      summary: item.summary || "",
      primaryProjects: item.primaryProjects || [],
      scenarios: item.targetRoles || [],
      keywords: item.keywords || [],
      resumeFacts: item.analysis || {},
      sourceDocument: item.resumeDocumentId ? {
        id: item.resumeDocumentId,
        fileName: item.fileName || "",
        format: item.format || "",
        contentHash: item.contentHash || "",
        textExcerpt: item.resumeTextExcerpt || ""
      } : null
    })) : [];
  const resumeVersions = persistedVersions.length ? { versions: persistedVersions }
    : candidateProfile?.resumeVersions?.length ? { versions: candidateProfile.resumeVersions } : configs.resumeVersions;
  const positiveKeywords = buildPositiveKeywords(plan, candidateProfile);
  const softExclusions = (plan.excludeWords || []).map((word) => ({ word, penalty: 10, risk: `偏离筛选方向：${word}` }));
  const salary = plan.salary || {};
  const selectedExperience = normalizeExperienceSelections(plan.experience || []);
  return {
    ...configs,
    candidateProfile,
    searchPlan: plan,
    analysisContext: runtimeAnalysisContext(candidateProfile, plan),
    targetPolicy: {
      jobTypes: plan.jobTypes || ["全职"],
      directions: plan.directions || candidate.targetTitles || [],
      skills: (candidateProfile?.skills || []).map((item) => typeof item === "string" ? item : item.name).filter(Boolean)
    },
    resumeVersions,
    profile: {
      ...configs.profile,
      candidate: {
        ...configs.profile?.candidate,
        name: candidate.name || configs.profile?.candidate?.name || "候选人",
        city: candidate.city || configs.profile?.candidate?.city || "",
        target_roles: plan.directions || candidate.targetTitles || []
      },
      location: {
        ...configs.profile?.location,
        target_cities: plan.cities || [candidate.city].filter(Boolean),
        default_city: plan.cities?.[0] || candidate.city || configs.profile?.location?.default_city || "",
        boss_city_code: plan.bossCityCode || cityToBossCode(plan.cities?.[0]) || ""
      }
    },
    scoring: {
      ...configs.scoring,
      positive_keywords: positiveKeywords,
      // 语义方向由画像和模型判断；这里仅保留用户当前方案明确设置的软排除词。
      risk_rules: softExclusions,
      boss_activity: { ...configs.scoring?.boss_activity, max_active_days: safeActiveDays(plan.bossActiveDays) },
      work_schedule: {
        ...configs.scoring?.work_schedule,
        preference: plan.workSchedulePreference === "no_preference" ? "no_preference" : "prefer_double_weekend"
      },
      allowExperienceStretch: plan.allowExperienceStretch !== false,
      experience: {
        selected: selectedExperience,
        allowStretch: plan.allowExperienceStretch !== false
      },
      salary: {
        ...configs.scoring?.salary,
        mode: plan.salaryMode === "strict" ? "strict" : "wide",
        preferred_max_k: Number(salary.maxK || configs.scoring?.salary?.preferred_max_k || 24),
        hard_max_k: Number(salary.maxK || configs.scoring?.salary?.hard_max_k || 35) + PRODUCT_POLICY.matching.salaryHardMaxMarginK,
        expected_min_k: Number(salary.minK || 0),
        expected_max_k: Number(salary.maxK || 0),
        experience_flex_max_k: Number(salary.maxK || configs.scoring?.salary?.experience_flex_max_k || 18)
      },
      experience_stretch_keywords: [...new Set([...(plan.directions || []), ...planKeywords(plan), ...(candidateProfile?.skills || []).map((item) => item.name || item)])],
      exclude_words: [...new Set([...(plan.hardExcludes || [])])]
    }
  };
}

function buildPositiveKeywords(plan, candidateProfile) {
  const weight = { A: 4, B: 3, C: 2 };
  const values = [];
  for (const item of plan.keywords || []) {
    const word = typeof item === "string" ? item : item.word;
    const priority = typeof item === "object" ? item.priority : "B";
    if (word) values.push({ word, weight: weight[priority] || 3, label: word });
  }
  for (const word of plan.directions || []) if (word) values.push({ word, weight: 4, label: word });
  for (const item of candidateProfile?.skills || []) {
    const word = typeof item === "string" ? item : item.name;
    if (word) values.push({ word, weight: 2, label: word });
  }
  const unique = new Map();
  for (const item of values) if (!unique.has(String(item.word).toLowerCase())) unique.set(String(item.word).toLowerCase(), item);
  return [...unique.values()].slice(0, 40);
}

function planKeywords(plan) {
  return (plan?.keywords || []).map((item) => typeof item === "string" ? item : item.word).filter(Boolean);
}

function resolveScanPolicy(plan = {}, requestedMode = "daily") {
  const planPolicy = PRODUCT_POLICY.searchPlan;
  const mode = requestedMode === "broad" ? "broad" : "daily";
  const scan = plan.scan || {};
  const allKeywords = (plan.keywords || []).map((item) => typeof item === "string"
    ? { word: item, priority: "B", reason: "" }
    : { ...item, priority: ["A", "B", "C"].includes(item.priority) ? item.priority : "B" })
    .filter((item) => item.word);
  const dailyKeywords = allKeywords.filter((item) => DAILY_SCAN_LIMITS.priorities.includes(item.priority));
  const broad = {
    maxCards: bounded(scan.maxCards, planPolicy.broadScanDefaults.maxCards, ...planPolicy.scanBounds.maxCards),
    maxDetailTotal: bounded(scan.maxDetailTotal, planPolicy.broadScanDefaults.maxDetailTotal, ...planPolicy.scanBounds.maxDetailTotal),
    browserPageBudget: bounded(scan.browserPageBudget, planPolicy.broadScanDefaults.browserPageBudget, ...planPolicy.scanBounds.browserPageBudget)
  };
  const resolved = {
    mode,
    keywordPlan: mode === "daily" ? (dailyKeywords.length ? dailyKeywords : allKeywords.slice(0, 4)) : allKeywords,
    maxCards: mode === "daily" ? DAILY_SCAN_LIMITS.maxCards : broad.maxCards,
    maxDetailTotal: mode === "daily" ? DAILY_SCAN_LIMITS.maxDetailTotal : broad.maxDetailTotal,
    browserPageBudget: mode === "daily" ? DAILY_SCAN_LIMITS.browserPageBudget : broad.browserPageBudget,
    detailLimits: mode === "daily" ? DAILY_SCAN_LIMITS.detailLimits : null,
    salaryLaneLimit: mode === "daily" ? DAILY_SCAN_LIMITS.salaryLaneLimit : null
  };
  const snapshot = {
    version: PRODUCT_POLICY_VERSION,
    mode: resolved.mode,
    keywords: resolved.keywordPlan.map(({ word, priority }) => ({ word, priority })),
    platform: plan.platform || {},
    cities: plan.cities || [],
    directions: plan.directions || [],
    salary: plan.salary || {},
    salaryMode: plan.salaryMode || planPolicy.defaultSalaryMode,
    experience: plan.experience || [],
    allowExperienceStretch: plan.allowExperienceStretch !== false,
    jobTypes: plan.jobTypes || [],
    degrees: plan.degrees || [],
    excludeWords: plan.excludeWords || [],
    hardExcludes: plan.hardExcludes || [],
    bossActiveDays: safeActiveDays(plan.bossActiveDays),
    workSchedulePreference: plan.workSchedulePreference || planPolicy.defaultWorkSchedulePreference,
    limits: {
      maxCards: resolved.maxCards,
      maxDetailTotal: resolved.maxDetailTotal,
      browserPageBudget: resolved.browserPageBudget,
      detailLimits: resolved.detailLimits,
      salaryLaneLimit: resolved.salaryLaneLimit
    }
  };
  return { ...resolved, policyVersion: PRODUCT_POLICY_VERSION, policyHash: stableHash(snapshot), snapshot };
}

function applyScanPolicyToFilters(snapshot = {}, policy = {}) {
  const lanes = Array.isArray(snapshot.lanes) ? snapshot.lanes : [];
  const selected = Number.isFinite(policy.salaryLaneLimit) ? lanes.slice(0, policy.salaryLaneLimit) : lanes;
  const primary = selected[0];
  return {
    ...snapshot,
    scanMode: policy.mode || "daily",
    ...(primary ? { params: primary.params || {}, labels: primary.labels || {} } : {}),
    lanes: selected
  };
}

function bounded(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

function safeActiveDays(value) {
  const policy = PRODUCT_POLICY.searchPlan;
  const days = Number(value);
  return policy.allowedBossActiveDays.includes(days) ? days : policy.defaultBossActiveDays;
}

function normalizeExperienceSelections(values) {
  return [...new Set((values || []).map((item) => {
    const text = String(item || "").trim().replace(/^(\d+)-(\d+)\?$/, "$1-$2年");
    return /^3-5年(?:（可冲）)?$/.test(text) ? "3-5年（可冲）" : text;
  }).filter(Boolean))];
}

module.exports = {
  CITY_CODES,
  DAILY_SCAN_LIMITS,
  cityToBossCode,
  profileToRuntimeConfigs,
  planKeywords,
  normalizeExperienceSelections,
  resolveScanPolicy,
  applyScanPolicyToFilters
};
