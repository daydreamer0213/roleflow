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
  const location = cityCodesSelected.includes(NATIONWIDE_CITY_CODE)
    ? { mode: "nationwide", codes: cityCodesSelected, cities: [], districts: [] }
    : cityCodesSelected.length && cityCodesSelected.every((code) => reverseCities.has(code))
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
    if (missingCodes.length) {
      unresolvedParams.push({ param: field.urlParam, codes: missingCodes });
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

function applyPlatformRuntimePolicy(configs = {}, policy = {}) {
  const filters = policy.filters || {};
  const cities = filters.location?.mode === "specific" ? filters.location.cities || [] : [];
  const salaryBounds = unionSalaryBounds(filters.salary?.ranges || []);
  const experience = filters.experience?.labels || [];
  const jobTypes = filters.jobType?.labels || [];
  const degrees = filters.degree?.labels || [];
  const projectedPlan = {
    ...(configs.searchPlan || {}),
    cities,
    salary: salaryBounds,
    salaryMode: salaryBounds.maxK > 0 ? "strict" : "wide",
    experience,
    jobTypes,
    degrees
  };
  const projected = {
    ...configs,
    acquisitionMode: "inherited",
    platformPolicy: policy,
    searchPlan: projectedPlan,
    targetPolicy: {
      ...(configs.targetPolicy || {}),
      jobTypes,
      enforceJobTypes: jobTypes.length > 0
    },
    profile: {
      ...(configs.profile || {}),
      location: {
        ...(configs.profile?.location || {}),
        target_cities: cities,
        default_city: cities[0] || "",
        boss_city_code: filters.location?.codes?.[0] || ""
      }
    },
    scoring: {
      ...(configs.scoring || {}),
      experience: { selected: [], allowStretch: false },
      salary: {
        ...(configs.scoring?.salary || {}),
        mode: salaryBounds.maxK > 0 ? "strict" : "wide",
        expected_min_k: salaryBounds.minK,
        expected_max_k: salaryBounds.maxK,
        preferred_max_k: salaryBounds.maxK || Number.MAX_SAFE_INTEGER,
        hard_max_k: Number.MAX_SAFE_INTEGER,
        experience_flex_max_k: salaryBounds.maxK || Number.MAX_SAFE_INTEGER
      }
    }
  };
  return {
    ...projected,
    analysisContext: runtimeAnalysisContext(
      projected.candidateProfile,
      projectedPlan,
      projected.matchingCard
    )
  };
}

function evaluatePlatformBoundaries(job = {}, policy = {}) {
  const tags = [];
  const risks = [];
  const filters = policy.filters || {};
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
  if (!filter.labels.some((label) => normalizeChoice(label) === normalizeChoice(actual))) {
    tags.push("platform_job_type_mismatch");
    risks.push(`求职类型不符合平台筛选：${filter.labels.join("、")}`);
  }
}

function emptyFilter() {
  return { codes: [], labels: [] };
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

function unionSalaryBounds(ranges) {
  if (!ranges.length) return { minK: 0, maxK: 0 };
  return {
    minK: Math.min(...ranges.map((range) => range.minK)),
    maxK: Math.max(...ranges.map((range) => range.maxK))
  };
}

function experienceBucket(value) {
  const text = String(value || "");
  if (/5-10年|5年以上|五年以上/.test(text)) return "senior";
  if (/3-5年|3年以上|三年以上/.test(text)) return "mid";
  if (/0-1年|0-3年|1-3年|2-3年|1年以上|2年以上/.test(text)) return "junior";
  if (/经验不限|无需经验|无经验|应届|在校/.test(text)) return "entry";
  return "";
}

function normalizeDegree(value) {
  return String(value || "").replace(/\s+|及以上|以上/g, "").trim();
}

function jobTypeLabel(job) {
  const text = `${job.title || ""} ${(job.tags || []).join(" ")} ${job.description || ""}`;
  if (/实习(?:生)?|intern/i.test(text)) return "实习";
  if (/兼职/.test(text)) return "兼职";
  if (/全职/.test(text)) return "全职";
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
  applyPlatformRuntimePolicy,
  evaluatePlatformBoundaries
};
