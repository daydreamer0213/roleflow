const assert = require("node:assert/strict");
const {
  canonicalizeBossSearchTemplate,
  buildInheritedSearchScope,
  assertInheritedAcquisitionScope,
  freezeKeywordSource,
  scopeShortId
} = require("../src/core/inherited_search_scope");
const {
  compilePlatformRuntimePolicy,
  applyPlatformRuntimePolicy,
  evaluatePlatformBoundaries
} = require("../src/core/platform_runtime_policy");
const { CITY_CODES } = require("../src/core/search_plan");

const firstUrl = "https://www.zhipin.com/web/geek/jobs?query=RAG&page=3&city=100010000&salary=405&unknownFilter=9&ka=search&utm_source=test";
const secondUrl = "https://www.zhipin.com/web/geek/jobs?unknownFilter=9&salary=405&city=100010000&query=Agent&page=1";
const first = buildInheritedSearchScope({ profileId: 7, rawUrl: firstUrl });
const second = buildInheritedSearchScope({ profileId: 7, rawUrl: secondUrl });

assert.deepStrictEqual(first.searchTemplate, {
  mode: "inherited",
  url: "https://www.zhipin.com/web/geek/jobs?city=100010000&salary=405&unknownFilter=9",
  cityCode: "100010000"
});
assert.strictEqual(first.searchScope.key, second.searchScope.key);
assert.strictEqual(first.searchScope.templateHash, second.searchScope.templateHash);
assert.deepStrictEqual(first.searchScope.filterParams, {
  city: ["100010000"],
  salary: ["405"],
  unknownFilter: ["9"]
});
assert.match(first.searchScope.key, /^boss:7:[a-f0-9]{64}$/);
assert.strictEqual(scopeShortId(first.searchScope.key), first.searchScope.templateHash.slice(0, 10));

const platformDefault = buildInheritedSearchScope({
  profileId: 7,
  rawUrl: "https://www.zhipin.com/web/geek/jobs?query=RAG&page=3&ka=search&utm_source=test"
});
assert.deepStrictEqual(platformDefault.searchTemplate, {
  mode: "inherited",
  url: "https://www.zhipin.com/web/geek/jobs",
  cityCode: ""
});
assert.deepStrictEqual(platformDefault.searchScope.filterParams, {});
assert.match(platformDefault.searchScope.key, /^boss:7:[a-f0-9]{64}$/);
const platformDefaultPolicy = compilePlatformRuntimePolicy({
  searchScope: platformDefault.searchScope,
  catalog: {},
  cityCodes: CITY_CODES
});
assert.deepStrictEqual(platformDefaultPolicy.filters.location, {
  mode: "unset",
  codes: [],
  cities: [],
  districts: []
});
assert.deepStrictEqual(platformDefaultPolicy.unresolvedParams, []);

assert.notStrictEqual(
  buildInheritedSearchScope({
    profileId: 7,
    rawUrl: "https://www.zhipin.com/web/geek/jobs?city=101280100&salary=405"
  }).searchScope.key,
  first.searchScope.key
);
assert.notStrictEqual(
  buildInheritedSearchScope({ profileId: 8, rawUrl: firstUrl }).searchScope.key,
  first.searchScope.key
);
assert.throws(
  () => canonicalizeBossSearchTemplate("https://www.zhipin.com/guangzhou/"),
  (error) => error.code === "BOSS_SEARCH_PAGE_INVALID"
);
for (const rawUrl of [
  "https://example.com/web/geek/jobs",
  "https://www.zhipin.com/web/geek/recommend"
]) {
  assert.throws(
    () => buildInheritedSearchScope({ profileId: 7, rawUrl }),
    (error) => error.code === "BOSS_SEARCH_PAGE_INVALID"
  );
}
assert.throws(
  () => buildInheritedSearchScope({ profileId: 0, rawUrl: platformDefault.searchTemplate.url }),
  (error) => error.code === "INHERITED_SCOPE_PROFILE_INVALID"
);
assert.throws(
  () => assertInheritedAcquisitionScope({ filterParams: {} }),
  (error) => error.code === "INHERITED_SCOPE_INVALID"
);

const keywordSource = freezeKeywordSource({
  planRecord: {
    id: 11,
    profileVersionId: 23,
    plan: {
      keywords: [
        { word: "AI应用开发工程师", priority: "A", reason: "主方向", ignored: "not copied" },
        { word: "RAG开发工程师", priority: "B", reason: "检索增强" }
      ]
    }
  },
  matchingCardRevision: "card-revision-5"
});
assert.deepStrictEqual(keywordSource.keywords, [
  { word: "AI应用开发工程师", priority: "A", reason: "主方向" },
  { word: "RAG开发工程师", priority: "B", reason: "检索增强" }
]);
assert.strictEqual(keywordSource.searchPlanId, 11);
assert.strictEqual(keywordSource.profileVersionId, 23);
assert.strictEqual(keywordSource.matchingCardRevision, "card-revision-5");
assert.match(keywordSource.catalogHash, /^[a-f0-9]{64}$/);

const platformCatalog = {
  site: "boss",
  source: "fixture",
  discoveredAt: "2026-08-04T00:00:00.000Z",
  fields: {
    salary: {
      key: "salary", label: "薪资待遇", urlParam: "salary",
      selection: "single", semantic: "salary_range",
      options: [{ code: "405", label: "10-20K" }]
    },
    experience: {
      key: "experience", label: "工作经验", urlParam: "experience",
      selection: "multiple", semantic: "experience",
      options: [{ code: "104", label: "1-3年" }]
    },
    degree: {
      key: "degree", label: "学历要求", urlParam: "degree",
      selection: "single", semantic: "choice",
      options: [{ code: "203", label: "本科" }]
    },
    jobType: {
      key: "jobType", label: "求职类型", urlParam: "jobType",
      selection: "single", semantic: "choice",
      options: [{ code: "1901", label: "全职" }]
    }
  }
};

const nationwideScope = buildInheritedSearchScope({
  profileId: 7,
  rawUrl: "https://www.zhipin.com/web/geek/jobs?city=100010000&salary=405&experience=104&degree=203&jobType=1901&industry=100020"
}).searchScope;
const nationwidePolicy = compilePlatformRuntimePolicy({
  searchScope: nationwideScope,
  catalog: platformCatalog,
  urlOptions: [{ param: "industry", code: "100020", label: "互联网" }],
  cityCodes: CITY_CODES
});
assert.strictEqual(nationwidePolicy.filters.location.mode, "nationwide");
assert.deepStrictEqual(nationwidePolicy.filters.location.cities, []);
assert.deepStrictEqual(nationwidePolicy.filters.salary.labels, ["10-20K"]);
assert.deepStrictEqual(nationwidePolicy.filters.experience.labels, ["1-3年"]);
assert.deepStrictEqual(nationwidePolicy.filters.degree.labels, ["本科"]);
assert.deepStrictEqual(nationwidePolicy.filters.jobType.labels, ["全职"]);
assert.deepStrictEqual(nationwidePolicy.filters.acquisitionOnly.industry, {
  codes: ["100020"],
  labels: ["互联网"]
});
assert.deepStrictEqual(nationwidePolicy.unresolvedParams, []);
assert.match(nationwidePolicy.hash, /^[a-f0-9]{64}$/);

const guangzhouScope = buildInheritedSearchScope({
  profileId: 7,
  rawUrl: "https://www.zhipin.com/web/geek/jobs?city=101280100&salary=405"
}).searchScope;
const guangzhouPolicy = compilePlatformRuntimePolicy({
  searchScope: guangzhouScope,
  catalog: platformCatalog,
  cityCodes: CITY_CODES
});
assert.deepStrictEqual(guangzhouPolicy.filters.location.cities, ["广州"]);

const mixedNationwideCityScope = buildInheritedSearchScope({
  profileId: 7,
  rawUrl: "https://www.zhipin.com/web/geek/jobs?city=100010000&city=999"
}).searchScope;
const mixedNationwideCityPolicy = compilePlatformRuntimePolicy({
  searchScope: mixedNationwideCityScope,
  catalog: platformCatalog,
  cityCodes: CITY_CODES
});
assert.deepStrictEqual(mixedNationwideCityPolicy.filters.location, {
  mode: "unresolved",
  codes: ["100010000", "999"],
  cities: [],
  districts: []
});
assert.deepStrictEqual(mixedNationwideCityPolicy.unresolvedParams, [
  { param: "city", codes: ["100010000", "999"] }
]);
assert.deepStrictEqual(
  evaluatePlatformBoundaries({ location: "佛山" }, mixedNationwideCityPolicy).qualityTags,
  ["platform_filter_unresolved"]
);

const districtScope = buildInheritedSearchScope({
  profileId: 7,
  rawUrl: "https://www.zhipin.com/web/geek/jobs?city=101280100&district=101280105"
}).searchScope;
const districtPolicy = compilePlatformRuntimePolicy({
  searchScope: districtScope,
  catalog: platformCatalog,
  urlOptions: [{ param: "district", code: "101280105", label: "天河区" }],
  cityCodes: CITY_CODES
});
assert.deepStrictEqual(districtPolicy.filters.location.districts, ["天河区"]);

const unresolvedPolicy = compilePlatformRuntimePolicy({
  searchScope: nationwideScope,
  catalog: platformCatalog,
  cityCodes: CITY_CODES
});
assert.deepStrictEqual(unresolvedPolicy.unresolvedParams, [
  { param: "industry", codes: ["100020"] }
]);
assert(evaluatePlatformBoundaries({}, unresolvedPolicy).qualityTags.includes("platform_filter_unresolved"));

const mixedSalaryScope = buildInheritedSearchScope({
  profileId: 7,
  rawUrl: "https://www.zhipin.com/web/geek/jobs?city=100010000&salary=405,999"
}).searchScope;
const mixedSalaryPolicy = compilePlatformRuntimePolicy({
  searchScope: mixedSalaryScope,
  catalog: platformCatalog,
  cityCodes: CITY_CODES
});
assert.deepStrictEqual(mixedSalaryPolicy.filters.salary.labels, []);
assert.deepStrictEqual(mixedSalaryPolicy.unresolvedParams, [
  { param: "salary", codes: ["405", "999"] }
]);
assert.deepStrictEqual(
  evaluatePlatformBoundaries({ salary: "30-40K" }, mixedSalaryPolicy).qualityTags,
  ["platform_filter_unresolved"]
);

const mixedExperienceScope = buildInheritedSearchScope({
  profileId: 7,
  rawUrl: "https://www.zhipin.com/web/geek/jobs?city=100010000&experience=104,999"
}).searchScope;
const mixedExperiencePolicy = compilePlatformRuntimePolicy({
  searchScope: mixedExperienceScope,
  catalog: platformCatalog,
  cityCodes: CITY_CODES
});
assert.deepStrictEqual(mixedExperiencePolicy.filters.experience.labels, []);
assert.deepStrictEqual(mixedExperiencePolicy.unresolvedParams, [
  { param: "experience", codes: ["104", "999"] }
]);

const unparseableCatalog = {
  ...platformCatalog,
  fields: {
    ...platformCatalog.fields,
    salary: {
      ...platformCatalog.fields.salary,
      options: [{ code: "499", label: "面议" }]
    },
    experience: {
      ...platformCatalog.fields.experience,
      options: [{ code: "199", label: "若干年" }]
    }
  }
};
const unparseableScope = buildInheritedSearchScope({
  profileId: 7,
  rawUrl: "https://www.zhipin.com/web/geek/jobs?city=100010000&salary=499&experience=199"
}).searchScope;
const unparseablePolicy = compilePlatformRuntimePolicy({
  searchScope: unparseableScope,
  catalog: unparseableCatalog,
  cityCodes: CITY_CODES
});
assert.deepStrictEqual(unparseablePolicy.filters.salary.labels, []);
assert.deepStrictEqual(unparseablePolicy.filters.experience.labels, []);
assert.deepStrictEqual(unparseablePolicy.unresolvedParams, [
  { param: "experience", codes: ["199"] },
  { param: "salary", codes: ["499"] }
]);

const baseConfigs = {
  candidateProfile: { candidate: { targetTitles: ["AI应用开发工程师"] } },
  matchingCard: { targetDirections: ["AI应用开发"] },
  searchPlan: {
    cities: ["广州"],
    salary: { minK: 9, maxK: 14 },
    experience: ["经验不限"],
    jobTypes: ["实习"],
    degrees: ["硕士"],
    directions: ["AI应用开发"],
    keywords: [
      { word: " RAG ", priority: "A", reason: " 主方向 ", ignored: "not copied" },
      { word: "Agent", priority: "invalid", reason: 42, extra: true },
      " LangChain ",
      { word: " ", priority: "A", ignored: "drop entire item" },
      null
    ],
    bossActiveDays: 1,
    workSchedulePreference: "prefer_double_weekend",
    allowExperienceStretch: true,
    excludeWords: ["外包"],
    hardExcludes: ["外包"]
  },
  targetPolicy: { directions: ["AI应用开发"], jobTypes: ["实习"], skills: ["Python"] },
  profile: { location: { target_cities: ["广州"] } },
  scoring: {
    positive_keywords: [{ word: "RAG", weight: 4, label: "RAG" }],
    risk_rules: [{ word: "外包", penalty: 10, risk: "旧方案软排除" }],
    exclude_words: ["外包"],
    boss_activity: { max_active_days: 1, unknown_penalty: 3, inactive_penalty: 10 },
    work_schedule: { preference: "prefer_double_weekend", single_weekend_penalty: 6 },
    allowExperienceStretch: true,
    experience_stretch_keywords: ["RAG"],
    salary: { expected_min_k: 9, expected_max_k: 14, hard_max_k: 35 },
    experience: { selected: ["经验不限"], allowStretch: true }
  }
};
const inheritedConfigs = applyPlatformRuntimePolicy(baseConfigs, nationwidePolicy);
assert.deepStrictEqual(inheritedConfigs.profile.location.target_cities, ["广州"]);
assert.deepStrictEqual(inheritedConfigs.searchPlan.cities, ["广州"]);
assert.deepStrictEqual(inheritedConfigs.searchPlan.salary, { minK: 9, maxK: 14 });
assert.deepStrictEqual(inheritedConfigs.searchPlan.experience, ["经验不限"]);
assert.deepStrictEqual(inheritedConfigs.searchPlan.jobTypes, ["实习"]);
assert.deepStrictEqual(inheritedConfigs.searchPlan.degrees, ["硕士"]);
assert.deepStrictEqual(inheritedConfigs.searchPlan.directions, ["AI应用开发"]);
assert.deepStrictEqual(inheritedConfigs.searchPlan, baseConfigs.searchPlan);
assert.strictEqual(inheritedConfigs.searchPlan.bossActiveDays, 1);
assert.strictEqual(inheritedConfigs.searchPlan.workSchedulePreference, "prefer_double_weekend");
assert.strictEqual(inheritedConfigs.searchPlan.allowExperienceStretch, true);
assert.deepStrictEqual(inheritedConfigs.searchPlan.excludeWords, ["外包"]);
assert.deepStrictEqual(inheritedConfigs.searchPlan.hardExcludes, ["外包"]);
assert.deepStrictEqual(inheritedConfigs.targetPolicy.directions, ["AI应用开发"]);
assert.strictEqual(inheritedConfigs.scoring.salary.expected_min_k, 9);
assert.strictEqual(inheritedConfigs.scoring.salary.expected_max_k, 14);
assert.deepStrictEqual(inheritedConfigs.scoring.positive_keywords, [
  { word: "RAG", weight: 4, label: "RAG" }
]);
assert.deepStrictEqual(inheritedConfigs.scoring.risk_rules, baseConfigs.scoring.risk_rules);
assert.deepStrictEqual(inheritedConfigs.scoring.exclude_words, ["外包"]);
assert.strictEqual(inheritedConfigs.scoring.boss_activity.max_active_days, 1);
assert.strictEqual(inheritedConfigs.scoring.work_schedule.preference, "prefer_double_weekend");
assert.strictEqual(inheritedConfigs.scoring.allowExperienceStretch, true);
assert.deepStrictEqual(inheritedConfigs.scoring.experience_stretch_keywords, ["RAG"]);
assert.match(inheritedConfigs.acquisitionPolicyHash, /^[a-f0-9]{64}$/);
assert.match(inheritedConfigs.recommendationPolicyHash, /^[a-f0-9]{64}$/);
assert.notStrictEqual(inheritedConfigs.acquisitionPolicyHash, inheritedConfigs.recommendationPolicyHash);
assert.deepStrictEqual(inheritedConfigs.acquisitionPolicy.filters.salary.ranges, [{ minK: 10, maxK: 20 }]);

assert.deepStrictEqual(
  evaluatePlatformBoundaries({
    salary: "30-40K", experience: "3-5年", education: "硕士", tags: ["实习"]
  }, nationwidePolicy).qualityTags,
  [
    "platform_salary_mismatch",
    "platform_experience_mismatch",
    "platform_degree_mismatch",
    "platform_job_type_mismatch"
  ]
);
assert.deepStrictEqual(
  evaluatePlatformBoundaries({ location: "广州·越秀区" }, districtPolicy).qualityTags,
  ["platform_district_mismatch"]
);
assert.deepStrictEqual(
  evaluatePlatformBoundaries({
    salary: "", experience: "", education: "", tags: []
  }, nationwidePolicy).qualityTags,
  [
    "platform_salary_unverified",
    "platform_experience_unverified",
    "platform_degree_unverified",
    "platform_job_type_unverified"
  ]
);

function experienceBoundaryTags(actual, labels) {
  return evaluatePlatformBoundaries(
    { experience: actual },
    { filters: { experience: { codes: [], labels } }, unresolvedParams: [] }
  ).qualityTags;
}

assert.deepStrictEqual(
  experienceBoundaryTags("1年以内", ["1-3年"]),
  ["platform_experience_mismatch"]
);
assert.deepStrictEqual(
  experienceBoundaryTags("10年以上", ["5-10年"]),
  ["platform_experience_mismatch"]
);
assert.deepStrictEqual(experienceBoundaryTags("1年以下", ["1年以内"]), []);
assert.deepStrictEqual(experienceBoundaryTags("应届生", ["应届"]), []);
assert.deepStrictEqual(experienceBoundaryTags("无经验", ["经验不限"]), []);
assert.deepStrictEqual(
  experienceBoundaryTags("3年以上", ["3-5年"]),
  ["platform_experience_unverified"]
);
assert.deepStrictEqual(experienceBoundaryTags("5-10年", ["3-5年", "5-10年"]), []);
assert.deepStrictEqual(
  experienceBoundaryTags("10年以上", ["3-5年", "5-10年"]),
  ["platform_experience_mismatch"]
);

console.log("inherited_search_scope_smoke ok");
