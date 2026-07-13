const CITY_CODES = {
  "广州": "101280100", "深圳": "101280600", "北京": "101010100", "上海": "101020100",
  "杭州": "101210100", "成都": "101270100", "武汉": "101200100", "南京": "101190100",
  "苏州": "101190400", "长沙": "101250100", "佛山": "101280800", "东莞": "101281600",
  "珠海": "101281800", "天津": "101030100", "西安": "101110100", "重庆": "101040100"
};

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
      keywords: item.keywords || []
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
        boss_city_code: plan.bossCityCode || configs.profile?.location?.boss_city_code || "101280100"
      }
    },
    scoring: {
      ...configs.scoring,
      positive_keywords: positiveKeywords,
      // 保留全局岗位风险规则；用户方案里的排除词只是额外规则，不能把基础质量治理覆盖掉。
      risk_rules: [...(configs.scoring?.risk_rules || []), ...softExclusions],
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
        hard_max_k: Number(salary.maxK || configs.scoring?.salary?.hard_max_k || 35) + 12,
        expected_min_k: Number(salary.minK || 0),
        expected_max_k: Number(salary.maxK || 0),
        experience_flex_max_k: Number(salary.maxK || configs.scoring?.salary?.experience_flex_max_k || 18) + 4
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

function safeActiveDays(value) {
  const days = Number(value);
  return [1, 3, 7].includes(days) ? days : 3;
}

function normalizeExperienceSelections(values) {
  return [...new Set((values || []).map((item) => {
    const text = String(item || "").trim().replace(/^(\d+)-(\d+)\?$/, "$1-$2年");
    return /^3-5年(?:（可冲）)?$/.test(text) ? "3-5年（可冲）" : text;
  }).filter(Boolean))];
}

module.exports = { CITY_CODES, cityToBossCode, profileToRuntimeConfigs, planKeywords, normalizeExperienceSelections };
