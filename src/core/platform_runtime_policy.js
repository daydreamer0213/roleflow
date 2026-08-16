const { stableHash, runtimeAnalysisContext } = require("./analysis_revision");
const { normalizePlatformFilterCatalog, salaryRange } = require("./platform_filters");

const NATIONWIDE_CITY_CODE = "100010000";

function compilePlatformRuntimePolicy({ searchScope, catalog, urlOptions = [], cityCodes = {} } = {}) {
  if (!searchScope?.templateUrl || !searchScope?.templateHash) {
    throw policyError("PLATFORM_SCOPE_INVALID", "平台运行策略缺少继承范围。");
  }
  const normalizedCatalog = normalizePlatformFilterCatalog(catalog || {});
  const params = new URL(searchScope.templateUrl).searchParams;
  const knownParams = new Set(["city"]);
  const unresolvedParams = [];
  const reverseCities = new Map(
    Object.entries(cityCodes).map(([label, code]) => [String(code), label])
  );
  const cityCodesSelected = splitCodes(params.getAll("city"));
  const nationwideOnly = cityCodesSelected.length === 1
    && cityCodesSelected[0] === NATIONWIDE_CITY_CODE;
  const allSpecificCities = cityCodesSelected.length > 0
    && cityCodesSelected.every((code) => reverseCities.has(code));
  const location = nationwideOnly
    ? { mode: "nationwide", codes: cityCodesSelected, cities: [], districts: [] }
    : allSpecificCities
      ? {
        mode: "specific",
        codes: cityCodesSelected,
        cities: cityCodesSelected.map((code) => reverseCities.get(code)),
        districts: []
      }
      : { mode: cityCodesSelected.length ? "unresolved" : "unset", codes: cityCodesSelected, cities: [], districts: [] };
  if (location.mode === "unresolved") {
    unresolvedParams.push({ param: "city", codes: cityCodesSelected });
  }

  const filters = {
    location,
    salary: emptyFilter(),
    experience: emptyFilter(),
    degree: emptyFilter(),
    jobType: emptyFilter(),
    acquisitionOnly: {}
  };
  for (const field of Object.values(normalizedCatalog.fields || {})) {
    knownParams.add(field.urlParam);
    const codes = splitCodes(params.getAll(field.urlParam));
    if (!codes.length) continue;
    const optionsByCode = new Map(field.options.map((option) => [option.code, option]));
    const selected = codes.map((code) => optionsByCode.get(code)).filter(Boolean);
    const missingCodes = codes.filter((code) => !optionsByCode.has(code));
    if (missingCodes.length || !selected.every((option) => isSemanticallyDecodable(field.key, option.label))) {
      unresolvedParams.push({ param: field.urlParam, codes });
      continue;
    }
    const resolved = {
      codes: selected.map((option) => option.code),
      labels: selected.map((option) => option.label)
    };
    if (field.key === "salary") {
      filters.salary = {
        ...resolved,
        ranges: resolved.labels.map(salaryRange).filter(Boolean)
      };
    } else if (["experience", "degree", "jobType"].includes(field.key)) {
      filters[field.key] = resolved;
    } else {
      filters.acquisitionOnly[field.key] = resolved;
    }
  }
  const urlLabels = new Map(urlOptions.map((item) => [
    `${String(item?.param || "")}:${String(item?.code || "")}`,
    String(item?.label || "").trim()
  ]).filter(([, label]) => label));
  for (const name of [...new Set(params.keys())].sort()) {
    if (knownParams.has(name)) continue;
    const codes = splitCodes(params.getAll(name));
    const labels = codes.map((code) => urlLabels.get(`${name}:${code}`)).filter(Boolean);
    if (codes.length && labels.length === codes.length) {
      knownParams.add(name);
      if (name === "district") filters.location.districts = labels;
      else filters.acquisitionOnly[name] = { codes, labels };
      continue;
    }
    unresolvedParams.push({ param: name, codes });
  }
  const dedupedUnresolved = dedupeUnresolved(unresolvedParams);
  const filterSummary = formatPolicySummary(filters, dedupedUnresolved);
  const payload = {
    site: "boss",
    templateHash: searchScope.templateHash,
    filters,
    unresolvedParams: dedupedUnresolved
  };
  return {
    ...payload,
    filterSummary,
    hash: stableHash(payload)
  };
}

function compileGeneratedPlatformRuntimePolicy({ cityScopes = [], nativeFilters = {} } = {}) {
  const laneLabels = (nativeFilters.lanes || []).flatMap((lane) => lane.labels?.salary || []);
  const labels = nativeFilters.labels || {};
  const salaryLabels = [...new Set([...(labels.salary || []), ...laneLabels])];
  const filters = {
    location: {
      mode: cityScopes.length ? "specific" : "unset",
      codes: cityScopes.map((item) => item.cityCode),
      cities: cityScopes.map((item) => item.city).filter(Boolean),
      districts: []
    },
    salary: { codes: [], labels: salaryLabels, ranges: salaryLabels.map(salaryRange).filter(Boolean) },
    experience: { codes: [], labels: [...(labels.experience || [])] },
    degree: { codes: [], labels: [...(labels.degree || [])] },
    jobType: { codes: [], labels: [...(labels.jobType || [])] },
    acquisitionOnly: {}
  };
  const payload = { site: "boss", filters, unresolvedParams: [] };
  return { ...payload, filterSummary: formatPolicySummary(filters, []), hash: stableHash(payload) };
}

function applyPlatformRuntimePolicy(configs = {}, policy = {}, { acquisitionMode = "inherited" } = {}) {
  const sourcePlan = configs.searchPlan || {};
  const recommendationPolicy = {
    candidateProfile: configs.candidateProfile || {},
    searchPlan: sourcePlan,
    targetPolicy: configs.targetPolicy || {},
    scoring: configs.scoring || {}
  };
  const projected = {
    ...configs,
    acquisitionMode,
    platformPolicy: policy,
    acquisitionPolicy: policy,
    acquisitionPolicyHash: policy.hash || stableHash(policy),
    recommendationPolicyHash: stableHash(recommendationPolicy)
  };
  return {
    ...projected,
    analysisContext: runtimeAnalysisContext(
      projected.candidateProfile,
      sourcePlan,
      projected.matchingCard,
      projected.targetPolicy,
      projected.scoring
    )
  };
}

function evaluatePlatformBoundaries(job = {}, policy = {}) {
  const tags = [];
  const risks = [];
  const filters = policy.filters || {};
  if ((policy.unresolvedParams || []).length) {
    tags.push("platform_filter_unresolved");
    risks.push(`平台筛选参数未完全解析：${[
      ...new Set(policy.unresolvedParams.map((item) => item.param).filter(Boolean))
    ].join("、")}`);
  }
  checkDistrict(job, filters.location, tags, risks);
  checkSalary(job, filters.salary, tags, risks);
  checkExperience(job, filters.experience, tags, risks);
  checkDegree(job, filters.degree, tags, risks);
  checkJobType(job, filters.jobType, tags, risks);
  return { qualityTags: tags, risks };
}

function checkDistrict(job, locationFilter, tags, risks) {
  const districts = locationFilter?.districts || [];
  if (!districts.length) return;
  const actual = String(job.location || "").trim();
  if (!actual) {
    tags.push("platform_district_unverified");
    return;
  }
  if (!districts.some((district) => actual.includes(district.replace(/区$/, "")))) {
    tags.push("platform_district_mismatch");
    risks.push(`区域不符合平台筛选：${districts.join("、")}`);
  }
}

function checkSalary(job, filter, tags, risks) {
  if (!(filter?.ranges || []).length) return;
  const actual = parseSalaryRangeK(job.salary);
  if (actual.min === null || actual.max === null) {
    tags.push("platform_salary_unverified");
    return;
  }
  const overlaps = filter.ranges.some(
    (range) => Math.max(actual.min, range.minK) <= Math.min(actual.max, range.maxK)
  );
  if (!overlaps) {
    tags.push("platform_salary_mismatch");
    risks.push(`薪资不符合平台筛选：${filter.labels.join("、")}`);
  }
}

function checkExperience(job, filter, tags, risks) {
  if (!(filter?.labels || []).length) return;
  const actual = experienceBucket(job.experience || (job.tags || []).join(" "));
  if (!actual) {
    tags.push("platform_experience_unverified");
    return;
  }
  const allowed = new Set(filter.labels.map(experienceBucket).filter(Boolean));
  if (!allowed.has(actual)) {
    tags.push("platform_experience_mismatch");
    risks.push(`经验不符合平台筛选：${filter.labels.join("、")}`);
  }
}

function checkDegree(job, filter, tags, risks) {
  if (!(filter?.labels || []).length) return;
  const actual = normalizeDegree(job.education);
  if (!actual) {
    tags.push("platform_degree_unverified");
    return;
  }
  const allowed = new Set(filter.labels.map(normalizeDegree).filter(Boolean));
  if (!allowed.has(actual)) {
    tags.push("platform_degree_mismatch");
    risks.push(`学历不符合平台筛选：${filter.labels.join("、")}`);
  }
}

function checkJobType(job, filter, tags, risks) {
  if (!(filter?.labels || []).length) return;
  const actual = jobTypeLabel(job);
  if (!actual) {
    tags.push("platform_job_type_unverified");
    return;
  }
  if (!filter.labels.some((label) => jobTypeChoice(label) === actual)) {
    tags.push("platform_job_type_mismatch");
    risks.push(`求职类型不符合平台筛选：${filter.labels.join("、")}`);
  }
}

function emptyFilter() {
  return { codes: [], labels: [] };
}

function isSemanticallyDecodable(fieldKey, label) {
  if (fieldKey === "salary") return Boolean(salaryRange(label));
  if (fieldKey === "experience") return Boolean(experienceBucket(label));
  if (fieldKey === "degree") return isDegreeLabel(label);
  if (fieldKey === "jobType") return Boolean(jobTypeChoice(label));
  return true;
}

function parseSalaryRangeK(value) {
  const text = String(value || "");
  const range = text.match(/(\d+)\s*[-~—]\s*(\d+)\s*K/i);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const single = text.match(/(\d+)\s*K/i);
  return single ? { min: Number(single[1]), max: Number(single[1]) } : { min: null, max: null };
}

function splitCodes(values) {
  return [...new Set(values.flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim()).filter(Boolean))].sort();
}

function dedupeUnresolved(items) {
  const byParam = new Map();
  for (const item of items) {
    const codes = byParam.get(item.param) || new Set();
    for (const code of item.codes || []) codes.add(String(code));
    byParam.set(item.param, codes);
  }
  return [...byParam.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([param, codes]) => ({ param, codes: [...codes].sort() }));
}

function experienceBucket(value) {
  const text = String(value || "")
    .replace(/\s+/g, "")
    .replace(/[~—–至到]/g, "-");
  const lanes = new Set();
  if (/经验不限|无需经验|无经验/.test(text)) lanes.add("unlimited");
  if (/应届(?:生)?|在校生?/.test(text)) lanes.add("graduate");
  if (/0-1年|1年以内|1年以下|一年以内|一年以下/.test(text)) lanes.add("under-one");
  if (/1-3年|一-三年/.test(text)) lanes.add("one-three");
  if (/3-5年|三-五年/.test(text)) lanes.add("three-five");
  if (/5-10年|五-十年/.test(text)) lanes.add("five-ten");
  if (/10年(?:以上|及以上)|十年(?:以上|及以上)/.test(text)) lanes.add("ten-plus");
  return lanes.size === 1 ? [...lanes][0] : "";
}

function normalizeDegree(value) {
  return String(value || "").replace(/\s+|及以上|以上/g, "").trim();
}

function isDegreeLabel(value) {
  return /^(学历不限|不限|初中|中专|中技|高中|大专|本科|硕士|博士)$/.test(normalizeDegree(value));
}

function jobTypeLabel(job) {
  const text = `${job.title || ""} ${(job.tags || []).join(" ")} ${job.description || ""}`;
  if (/实习(?:生)?|intern/i.test(text)) return "实习";
  if (/兼职/.test(text)) return "兼职";
  if (/全职/.test(text)) return "全职";
  return "";
}

function jobTypeChoice(value) {
  const text = normalizeChoice(value);
  if (["实习", "实习生", "intern"].includes(text)) return "实习";
  if (text === "兼职") return "兼职";
  if (text === "全职") return "全职";
  return "";
}

function normalizeChoice(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function formatPolicySummary(filters, unresolved) {
  const values = [];
  if (filters.location.mode === "nationwide") values.push("地点：全国");
  if (filters.location.mode === "specific") values.push(`地点：${filters.location.cities.join("、")}`);
  if (filters.location.districts?.length) values.push(`区域：${filters.location.districts.join("、")}`);
  for (const [key, label] of [["salary", "薪资"], ["experience", "经验"], ["degree", "学历"], ["jobType", "求职类型"]]) {
    if (filters[key]?.labels?.length) values.push(`${label}：${filters[key].labels.join("、")}`);
  }
  for (const [key, value] of Object.entries(filters.acquisitionOnly || {})) {
    if (value.labels?.length) values.push(`${key}：${value.labels.join("、")}`);
  }
  if (unresolved.length) values.push(`未解析参数：${unresolved.map((item) => item.param).join("、")}`);
  return values;
}

function policyError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  compilePlatformRuntimePolicy,
  compileGeneratedPlatformRuntimePolicy,
  applyPlatformRuntimePolicy,
  evaluatePlatformBoundaries
};
