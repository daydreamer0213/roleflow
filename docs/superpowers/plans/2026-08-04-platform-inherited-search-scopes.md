# Platform-Inherited Search Scopes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让继承模式把当前 BOSS 搜索页的筛选条件当成独立搜索计划，按候选人和平台筛选范围隔离关键词历史，并在扫描、分析和恢复时始终使用同一份冻结快照。

**Architecture:** 新增三个聚焦模块：`inherited_search_scope.js` 负责规范化 BOSS 搜索 URL、计算范围键和冻结关键词来源；`platform_runtime_policy.js` 负责把平台 URL 与筛选目录编译成本地运行边界；`scoped_keyword_stats.js` 负责按范围查询关键词样本和当日使用情况。工作流启动接口先对现有 Edge 标签页做只读预检，保存范围、关键词和平台策略；CLI 子进程只消费这份快照，生成模式继续走现有路径。

**Tech Stack:** Node.js 22、CommonJS、`node:sqlite`、Edge Control、现有无框架 HTTP 仪表盘、`node:assert` smoke tests。

## Global Constraints

- 设计依据是 `docs/superpowers/specs/2026-08-04-platform-inherited-search-scope-design.md`。
- 继承模式只使用现有已登录 Edge 中的 BOSS 搜索标签页；预检和规划阶段不得导航、点击、沟通或投递。
- BOSS 当前页的城市、区域、薪资、经验、学历、求职类型及其他稳定筛选参数，是继承模式采集和本地硬边界的唯一来源。
- 当前页的 `query` 和 `page` 不属于范围；每个扫描目标只能替换 `query` 并移除 `page`。
- 继承模式只从已确认 Search Plan 复制关键词的 `word`、`priority`、`reason`，不得复制 Search Plan 的城市、薪资、经验、学历或求职类型。
- 范围键固定为 `boss:<profile-id>:<sha256(canonical-platform-template)>`；缺少范围键的历史批次不得进入继承模式关键词统计。
- URL 规范化必须移除 `query`、`page`、`ka`、`source`、`from`、`src`、`trackId`、`lid`、`_`、`timestamp` 和 `utm_` 前缀参数；其他未知参数默认保留。
- 无法解码的平台参数必须保留在采集 URL 中并记录 `platform_filter_unresolved`；不得用项目 Search Plan 猜值，也不得仅因解码器缺失而排除岗位。
- 恢复扫描只使用工作流和批次中的冻结范围、关键词来源及平台策略，不采纳恢复时标签页的新筛选。
- 生成模式、浏览器节奏、随机延迟、冷却、检查点、访问预算和风控即停规则保持不变。
- 生产代码不得加入 `Python AI后端` 或任何职业专用短语判断；该词只作为当前用户计划的数据变更删除。
- 所有自动化测试使用临时 SQLite、假浏览器或保存的 DOM fixture；只有 Task 7 可以在备份后修改 `D:\Guo\ZhiPing\data\jobs.sqlite`。
- 不新增依赖，不在 `C:` 写入缓存、数据库或构建产物。

---

### Task 1: Canonical Search Scope and Frozen Keyword Source

**Files:**
- Create: `src/core/inherited_search_scope.js`
- Create: `tests/inherited_search_scope_smoke.js`
- Modify: `tests/run_all.js:4-53`

**Interfaces:**
- Consumes: live BOSS search URL, Search Plan record, profile ID, matching-card revision.
- Produces: `canonicalizeBossSearchTemplate(rawUrl)`, `buildInheritedSearchScope({ profileId, rawUrl })`, `freezeKeywordSource({ planRecord, matchingCardRevision })`, and `scopeShortId(scopeKey)`.
- Produces shape:

```js
{
  searchTemplate: { mode: "inherited", url, cityCode },
  searchScope: {
    key,
    site: "boss",
    templateHash,
    templateUrl,
    filterParams
  }
}
```

- [ ] **Step 1: Write the failing canonicalization and keyword-freeze test**

Create `tests/inherited_search_scope_smoke.js`:

```js
const assert = require("node:assert/strict");
const {
  canonicalizeBossSearchTemplate,
  buildInheritedSearchScope,
  freezeKeywordSource,
  scopeShortId
} = require("../src/core/inherited_search_scope");

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

console.log("inherited_search_scope_smoke ok");
```

Add `"inherited_search_scope_smoke.js"` immediately after `"workflow_planner_smoke.js"` in `tests/run_all.js`.

- [ ] **Step 2: Run the new test and verify the missing module failure**

Run: `node tests/inherited_search_scope_smoke.js`

Expected: FAIL with `Cannot find module '../src/core/inherited_search_scope'`.

- [ ] **Step 3: Implement the pure scope module**

Create `src/core/inherited_search_scope.js`:

```js
const crypto = require("node:crypto");
const { stableHash } = require("./analysis_revision");

const BOSS_SEARCH_ORIGIN = "https://www.zhipin.com";
const BOSS_SEARCH_PATH = "/web/geek/jobs";
const REMOVED_PARAMS = new Set([
  "query", "page", "ka", "source", "from", "src",
  "trackId", "lid", "_", "timestamp"
]);

function canonicalizeBossSearchTemplate(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch (cause) {
    throw scopeError("BOSS_SEARCH_PAGE_INVALID", "当前 BOSS 搜索页 URL 无效。", cause);
  }
  if (url.origin !== BOSS_SEARCH_ORIGIN || url.pathname.replace(/\/+$/, "") !== BOSS_SEARCH_PATH) {
    throw scopeError("BOSS_SEARCH_PAGE_INVALID", "当前标签页不是可用的 BOSS 搜索页。");
  }
  const grouped = new Map();
  for (const [name, value] of url.searchParams.entries()) {
    if (REMOVED_PARAMS.has(name) || name.startsWith("utm_")) continue;
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(String(value));
  }
  const canonicalParams = new URLSearchParams();
  for (const name of [...grouped.keys()].sort()) {
    for (const value of grouped.get(name).sort()) canonicalParams.append(name, value);
  }
  const canonical = new URL(BOSS_SEARCH_PATH, BOSS_SEARCH_ORIGIN);
  canonical.search = canonicalParams.toString();
  const urlText = canonical.toString().replace(/\?$/, "");
  return {
    mode: "inherited",
    url: urlText,
    cityCode: canonicalParams.get("city") || ""
  };
}

function buildInheritedSearchScope({ profileId, rawUrl } = {}) {
  const normalizedProfileId = Number(profileId);
  if (!Number.isInteger(normalizedProfileId) || normalizedProfileId <= 0) {
    throw scopeError("INHERITED_SCOPE_PROFILE_INVALID", "继承范围需要有效候选人画像。");
  }
  const searchTemplate = canonicalizeBossSearchTemplate(rawUrl);
  const templateHash = crypto.createHash("sha256").update(searchTemplate.url).digest("hex");
  const filterParams = {};
  const url = new URL(searchTemplate.url);
  for (const name of [...new Set(url.searchParams.keys())].sort()) {
    filterParams[name] = url.searchParams.getAll(name);
  }
  return {
    searchTemplate,
    searchScope: {
      key: `boss:${normalizedProfileId}:${templateHash}`,
      site: "boss",
      templateHash,
      templateUrl: searchTemplate.url,
      filterParams
    }
  };
}

function freezeKeywordSource({ planRecord, matchingCardRevision = "" } = {}) {
  if (!planRecord?.id || !planRecord?.profileVersionId) {
    throw scopeError("INHERITED_KEYWORD_SOURCE_INVALID", "继承模式缺少已确认的 Search Plan 版本。");
  }
  const keywords = (planRecord.plan?.keywords || []).map((item) => ({
    word: String(typeof item === "string" ? item : item?.word || "").trim(),
    priority: ["A", "B", "C"].includes(item?.priority) ? item.priority : "B",
    reason: String(item?.reason || "").trim()
  })).filter((item) => item.word);
  if (!keywords.length) {
    throw scopeError("INHERITED_KEYWORD_SOURCE_EMPTY", "已确认的 Search Plan 没有可用关键词。");
  }
  return {
    searchPlanId: Number(planRecord.id),
    profileVersionId: Number(planRecord.profileVersionId),
    matchingCardRevision: String(matchingCardRevision || ""),
    catalogHash: stableHash(keywords),
    keywords
  };
}

function scopeShortId(scopeKey) {
  return String(scopeKey || "").split(":").at(-1)?.slice(0, 10) || "";
}

function scopeError(code, message, cause) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  canonicalizeBossSearchTemplate,
  buildInheritedSearchScope,
  freezeKeywordSource,
  scopeShortId
};
```

- [ ] **Step 4: Run focused and full scope-adjacent tests**

Run:

```powershell
node tests/inherited_search_scope_smoke.js
node tests/screening_quality_smoke.js
node tests/scan_snapshot_smoke.js
```

Expected: the new test prints `inherited_search_scope_smoke ok`; both existing tests still pass.

- [ ] **Step 5: Commit the pure scope boundary**

```powershell
git add -- src/core/inherited_search_scope.js tests/inherited_search_scope_smoke.js tests/run_all.js
git commit -m "feat: add inherited search scope identity"
```

Expected: one commit containing only the pure module and its test registration.

---

### Task 2: Compile Platform Filters into Runtime Boundaries

**Files:**
- Create: `src/core/platform_runtime_policy.js`
- Modify: `src/core/scoring.js:33-238,303-315`
- Modify: `tests/inherited_search_scope_smoke.js`
- Modify: `tests/screening_quality_smoke.js:250-410`

**Interfaces:**
- Consumes: `searchScope`, normalized platform catalog, URL-option labels read from the current DOM, and `CITY_CODES`.
- Produces: `compilePlatformRuntimePolicy({ searchScope, catalog, urlOptions, cityCodes })`, `applyPlatformRuntimePolicy(configs, policy)`, and `evaluatePlatformBoundaries(job, policy)`.
- `applyPlatformRuntimePolicy` preserves candidate evidence and role directions, but replaces Search Plan acquisition fields and local scoring boundaries.
- `evaluatePlatformBoundaries` returns `{ qualityTags, risks }`; unknown job metadata returns an `*_unverified` tag, not a mismatch.

- [ ] **Step 1: Add failing policy-compiler and runtime-boundary assertions**

Append to `tests/inherited_search_scope_smoke.js`:

```js
const {
  compilePlatformRuntimePolicy,
  applyPlatformRuntimePolicy,
  evaluatePlatformBoundaries
} = require("../src/core/platform_runtime_policy");
const { CITY_CODES } = require("../src/core/search_plan");

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

const baseConfigs = {
  candidateProfile: { candidate: { targetTitles: ["AI应用开发工程师"] } },
  matchingCard: { targetDirections: ["AI应用开发"] },
  searchPlan: {
    cities: ["广州"],
    salary: { minK: 9, maxK: 14 },
    experience: ["经验不限"],
    jobTypes: ["实习"],
    degrees: ["硕士"],
    directions: ["AI应用开发"]
  },
  targetPolicy: { directions: ["AI应用开发"], jobTypes: ["实习"], skills: ["Python"] },
  profile: { location: { target_cities: ["广州"] } },
  scoring: {
    salary: { expected_min_k: 9, expected_max_k: 14, hard_max_k: 35 },
    experience: { selected: ["经验不限"], allowStretch: true }
  }
};
const inheritedConfigs = applyPlatformRuntimePolicy(baseConfigs, nationwidePolicy);
assert.deepStrictEqual(inheritedConfigs.profile.location.target_cities, []);
assert.deepStrictEqual(inheritedConfigs.searchPlan.cities, []);
assert.deepStrictEqual(inheritedConfigs.searchPlan.salary, { minK: 10, maxK: 20 });
assert.deepStrictEqual(inheritedConfigs.searchPlan.experience, ["1-3年"]);
assert.deepStrictEqual(inheritedConfigs.searchPlan.jobTypes, ["全职"]);
assert.deepStrictEqual(inheritedConfigs.searchPlan.degrees, ["本科"]);
assert.deepStrictEqual(inheritedConfigs.targetPolicy.directions, ["AI应用开发"]);
assert.strictEqual(inheritedConfigs.scoring.salary.expected_min_k, 10);
assert.strictEqual(inheritedConfigs.scoring.salary.expected_max_k, 20);

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
```

In `tests/screening_quality_smoke.js`, import `applyPlatformRuntimePolicy`, define a self-contained policy, and assert a decoded mismatch is blocked while missing metadata is not blocked solely by the platform decoder:

```js
const {
  applyPlatformRuntimePolicy
} = require("../src/core/platform_runtime_policy");

const inheritedBoundaryPolicy = {
  hash: "screening-platform-policy",
  filters: {
    location: { mode: "nationwide", codes: ["100010000"], cities: [], districts: [] },
    salary: { codes: ["405"], labels: ["10-20K"], ranges: [{ minK: 10, maxK: 20 }] },
    experience: { codes: ["104"], labels: ["1-3年"] },
    degree: { codes: ["203"], labels: ["本科"] },
    jobType: { codes: ["1901"], labels: ["全职"] },
    acquisitionOnly: {}
  },
  unresolvedParams: [],
  filterSummary: ["地点：全国", "薪资：10-20K", "经验：1-3年", "学历：本科", "求职类型：全职"]
};
const inheritedBoundaryConfigs = applyPlatformRuntimePolicy(configs, inheritedBoundaryPolicy);
const platformMismatch = scoreJob(job({
  salary: "30-40K",
  experience: "3-5年",
  education: "硕士",
  tags: ["实习"],
  bossActiveText: "今日活跃"
}), inheritedBoundaryConfigs);
assert.strictEqual(decisionState(platformMismatch), "blocked");
assert(platformMismatch.qualityTags.includes("platform_salary_mismatch"));

const platformUnknown = scoreJob(job({
  salary: "",
  experience: "",
  education: "",
  tags: [],
  bossActiveText: "今日活跃"
}), inheritedBoundaryConfigs);
assert.notStrictEqual(decisionState(platformUnknown), "blocked");
```

- [ ] **Step 2: Run the focused tests and verify the missing policy module failure**

Run:

```powershell
node tests/inherited_search_scope_smoke.js
node tests/screening_quality_smoke.js
```

Expected: FAIL because `platform_runtime_policy.js` does not exist.

- [ ] **Step 3: Implement the compiler and config projection**

Create `src/core/platform_runtime_policy.js` with these exported functions and exact output rules:

```js
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
```

- [ ] **Step 4: Connect the compiled policy to local hard-boundary scoring**

In `src/core/scoring.js`, import `evaluatePlatformBoundaries`. Immediately after `qualityTags` is initialized, merge the platform result:

```js
const platformBoundary = evaluatePlatformBoundaries(job, configs.platformPolicy);
qualityTags.push(...platformBoundary.qualityTags);
risks.push(...platformBoundary.risks);
```

Replace the internship gate with:

```js
const enforceJobTypes = configs.targetPolicy?.enforceJobTypes !== false;
if (role.kind === "internship" && enforceJobTypes && !acceptsInternship) {
  score -= 100;
  qualityTags.push("internship_role");
  risks.push("实习岗位不在当前社招目标内");
}
```

Use the same `enforceJobTypes` condition in `stretchEligible` and `roleBlocked`.

Extend `decisionState` with the four decoded platform mismatches:

```js
const hardBoundaryTags = [
  "missing_link",
  "invalid_job_link",
  "location_mismatch",
  "inactive_boss",
  "hard_exclude",
  "internship_role",
  "salary_out_of_range",
  "platform_district_mismatch",
  "platform_salary_mismatch",
  "platform_experience_mismatch",
  "platform_degree_mismatch",
  "platform_job_type_mismatch"
];
if (hardBoundaryTags.some((tag) => tags.has(tag))) return "blocked";
```

Do not add any `*_unverified` tag to this hard-boundary list.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node tests/inherited_search_scope_smoke.js
node tests/screening_quality_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: all three tests pass; generated-mode scoring assertions in `semantic_pipeline_smoke.js` remain unchanged.

- [ ] **Step 6: Commit the platform runtime policy**

```powershell
git add -- src/core/platform_runtime_policy.js src/core/scoring.js tests/inherited_search_scope_smoke.js tests/screening_quality_smoke.js
git commit -m "feat: compile inherited platform boundaries"
```

Expected: one commit containing the generic platform compiler, scoring integration, and focused tests.

---

### Task 3: Read the Current BOSS Page without Navigation

**Files:**
- Modify: `src/adapters/sites/boss.js:307-443,1395-1478,2045-2065`
- Create: `tests/fixtures/boss_inherited_filter_dom.json`
- Modify: `tests/source_acquisition_smoke.js:1-110`
- Modify: `tests/screening_quality_smoke.js:200-250`

**Interfaces:**
- Consumes: an already verified BOSS search tab ID.
- Produces: `BossSiteAdapter.inspectInheritedSearchPage({ tabId })`.
- Produces:

```js
{
  tabId,
  url,
  searchTemplate,
  catalog,
  urlOptions
}
```

- Guarantees: calls `assertSearchPage` and DOM evaluation only; it never calls `navigate`, `clickAt`, or `discoverFilterCatalog`.

- [ ] **Step 1: Add a failing no-navigation inspection test**

Create the redacted DOM-evaluation fixture `tests/fixtures/boss_inherited_filter_dom.json`:

```json
{
  "url": "https://www.zhipin.com/web/geek/jobs?query=RAG&page=2&city=100010000&salary=405",
  "rawFields": [
    {
      "label": "薪资待遇",
      "options": [
        { "ka": "sel-job-rec-salary-405", "label": "10-20K" }
      ]
    }
  ],
  "urlOptions": [
    { "param": "district", "code": "101280105", "label": "天河区" }
  ]
}
```

Add this function to `tests/source_acquisition_smoke.js` and invoke it immediately after `preflightSmoke()`:

```js
async function inheritedPageInspectionSmoke() {
  let navigations = 0;
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, "fixtures", "boss_inherited_filter_dom.json"),
    "utf8"
  ));
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("isSearchPage")) {
        return {
          url: "https://www.zhipin.com/web/geek/jobs?query=RAG&page=2&city=100010000&salary=405",
          title: "全国招聘",
          isBoss: true,
          isLoginPage: false,
          isRiskPage: false,
          loggedIn: true,
          isSearchPage: true,
          hasJobStructure: true
        };
      }
      if (expression.includes("condition-filter-select")) {
        return fixture;
      }
      return {
        url: "https://www.zhipin.com/web/geek/jobs?query=RAG&page=2&city=100010000&salary=405",
        path: "/web/geek/jobs",
        isRiskPage: false,
        isLoginPage: false,
        hasJobStructure: true
      };
    },
    async navigate() { navigations += 1; }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  const inspected = await adapter.inspectInheritedSearchPage({ tabId: "BOSS-SEARCH" });
  assert.strictEqual(navigations, 0);
  assert.strictEqual(inspected.tabId, "BOSS-SEARCH");
  assert.strictEqual(inspected.searchTemplate.cityCode, "100010000");
  assert.strictEqual(inspected.catalog.fields.salary.options[0].label, "10-20K");
  assert.deepStrictEqual(inspected.urlOptions, [
    { param: "district", code: "101280105", label: "天河区" }
  ]);
}
```

- [ ] **Step 2: Run the acquisition test and verify the missing method failure**

Run: `node tests/source_acquisition_smoke.js`

Expected: FAIL with `adapter.inspectInheritedSearchPage is not a function`.

- [ ] **Step 3: Add the read-only adapter method**

Import `canonicalizeBossSearchTemplate` from `src/core/inherited_search_scope.js`, then add this method after `preflight()`:

```js
async inspectInheritedSearchPage({ tabId = null } = {}) {
  if (!this.browser) {
    throw bossError("BOSS_BROWSER_REQUIRED", "继承模式预检需要浏览器连接。");
  }
  const selectedTabId = tabId || await this.browser.activeTabId();
  await this.assertSearchPage(selectedTabId);
  const state = await this.browser.evalValue(selectedTabId, `(() => ({
    url: location.href,
    rawFields: Array.from(document.querySelectorAll(".condition-filter-select")).map((node) => ({
      label: (node.querySelector(".current-select .placeholder-text")?.textContent || "").replace(/\\s+/g, " ").trim(),
      options: Array.from(node.querySelectorAll("[ka*='sel-job-rec-']")).map((option) => ({
        ka: option.getAttribute("ka") || "",
        label: (option.textContent || "").replace(/\\s+/g, " ").trim()
      }))
    })),
    urlOptions: Array.from(document.querySelectorAll('a[href*="/web/geek/jobs"]')).flatMap((node) => {
      try {
        const optionUrl = new URL(node.href, location.href);
        if (optionUrl.origin !== location.origin || !/^\\/web\\/geek\\/jobs\\/?$/i.test(optionUrl.pathname)) return [];
        const label = String(node.textContent || "").replace(/\\s+/g, " ").trim();
        if (!label) return [];
        return [...optionUrl.searchParams.entries()]
          .filter(([param, code]) => param !== "query" && param !== "page" && code)
          .flatMap(([param, value]) => String(value).split(",")
            .map((code) => ({ param, code: code.trim(), label }))
            .filter((item) => item.code));
      } catch {
        return [];
      }
    })
  }))()`);
  const searchTemplate = canonicalizeBossSearchTemplate(state?.url);
  return {
    tabId: selectedTabId,
    url: String(state?.url || ""),
    searchTemplate,
    catalog: parseBossFilterCatalog(state?.rawFields || []),
    urlOptions: dedupeBossUrlOptions(state?.urlOptions || [])
  };
}
```

Add this file-local helper:

```js
function dedupeBossUrlOptions(items = []) {
  const unique = new Map();
  for (const item of items) {
    const normalized = {
      param: String(item?.param || "").trim(),
      code: String(item?.code || "").trim(),
      label: String(item?.label || "").replace(/\s+/g, " ").trim()
    };
    if (!normalized.param || !normalized.code || !normalized.label) continue;
    unique.set(`${normalized.param}:${normalized.code}`, normalized);
  }
  return [...unique.values()].sort((left, right) =>
    left.param.localeCompare(right.param) || left.code.localeCompare(right.code)
  );
}
```

Change `normalizeBossSearchTemplate(value)` to delegate valid search pages to `canonicalizeBossSearchTemplate`. Preserve its existing generated fallback:

```js
function normalizeBossSearchTemplate(value) {
  const raw = typeof value === "string" ? value : value?.url;
  try {
    return canonicalizeBossSearchTemplate(raw);
  } catch {
    return { mode: "generated", url: "", cityCode: "" };
  }
}
```

Export no new free function; callers use the adapter method.

- [ ] **Step 4: Remove Search Plan city fallback from inherited target identity**

In `resolveBossSearchContext`, replace the inherited `cityScopes` result with:

```js
cityScopes: [{
  city: matched?.city || "",
  cityCode: searchTemplate.cityCode || "platform-default"
}]
```

Update `tests/screening_quality_smoke.js` so an inherited URL without `city` expects `cityCode: "platform-default"` and never inherits the configured Guangzhou code. Keep generated-mode expectations unchanged.

- [ ] **Step 5: Run adapter and URL regression tests**

Run:

```powershell
node tests/source_acquisition_smoke.js
node tests/screening_quality_smoke.js
node tests/browser_transport_smoke.js
```

Expected: all three pass; the fake browser records zero navigation during inherited-page inspection.

- [ ] **Step 6: Commit the read-only page inspection**

```powershell
git add -- src/adapters/sites/boss.js tests/fixtures/boss_inherited_filter_dom.json tests/source_acquisition_smoke.js tests/screening_quality_smoke.js
git commit -m "feat: inspect inherited BOSS filters read only"
```

Expected: one commit; no browser communication code changes.

---

### Task 4: Isolate Keyword Yield and Same-Day Usage by Scope

**Files:**
- Create: `src/core/scoped_keyword_stats.js`
- Create: `tests/scoped_keyword_stats_smoke.js`
- Modify: `src/dashboard/server.js:828-907`
- Modify: `tests/workflow_planner_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: `profileId`, `scopeKey`, China local day, and observation/batch/workflow JSON already stored in SQLite.
- Produces: `listScopedKeywordStats(db, { profileId, scopeKey, localDay, now }) -> Map<string, { sampleSize, eligibleCount, usedToday }>`.
- Deduplication key: `jobs.source + jobs.source_id + observation.keyword`; latest observation wins.
- Eligibility ignores later application and communication state by passing empty state fields into `workflowEligibility`.

- [ ] **Step 1: Write the failing scope-statistics test**

Create `tests/scoped_keyword_stats_smoke.js`:

```js
const assert = require("node:assert/strict");
const {
  openDb,
  saveProfileAnalysis,
  createBatch,
  upsertJob,
  createWorkflowRun
} = require("../src/core/storage");
const { listScopedKeywordStats } = require("../src/core/scoped_keyword_stats");

const db = openDb(":memory:");
const saved = saveProfileAnalysis(db, {
  profile: {
    candidate: { name: "Scope Fixture", city: "广州", targetTitles: ["AI应用开发"] },
    education: [], experiences: [], skills: [], projects: [], credentials: [], strengths: []
  },
  document: {
    originalFileName: "scope.txt",
    format: "text",
    contentHash: "scope-fixture",
    text: "scope fixture ".repeat(20),
    diagnostics: {}
  },
  searchPlan: {
    name: "Scope",
    cities: ["广州"],
    directions: ["AI应用开发"],
    keywords: [
      { word: "AI应用开发", priority: "A" },
      { word: "RAG开发", priority: "B" }
    ],
    salary: { minK: 10, maxK: 20 },
    experience: ["1-3年"],
    jobTypes: ["全职"],
    platform: { site: "boss" }
  }
});

function eligibleJob(sourceId, keyword, overrides = {}) {
  return {
    source: "boss",
    sourceId,
    keyword,
    title: "AI应用开发工程师",
    company: "Fixture",
    location: "广州",
    salary: "10-20K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
    tags: ["全职"],
    description: "负责 AI 应用开发、测试、交付和线上优化。".repeat(10),
    score: 20,
    level: "可投",
    matches: ["AI应用"],
    risks: [],
    qualityTags: [],
    analysis: {
      semanticStatus: "complete",
      recommendation: "apply",
      recommendationSchemaVersion: 2,
      hardBlockers: []
    },
    ...overrides
  };
}

function scopedBatch(scopeKey, keyword) {
  return createBatch(db, "boss", keyword, "scope fixture", {
    profileId: saved.profileId,
    searchPlanId: saved.planId,
    filterSnapshot: {
      execution: { searchScope: { key: scopeKey } }
    }
  });
}

const scopeA = "boss:1:scope-a";
const scopeB = "boss:1:scope-b";
upsertJob(db, eligibleJob("same", "AI应用开发"), scopedBatch(scopeA, "AI应用开发"));
upsertJob(db, eligibleJob("same", "AI应用开发"), scopedBatch(scopeA, "AI应用开发"));
upsertJob(db, eligibleJob("same", "RAG开发"), scopedBatch(scopeA, "RAG开发"));
upsertJob(db, eligibleJob("bad", "AI应用开发", {
  analysis: { semanticStatus: "complete", recommendation: "not_recommended", recommendationSchemaVersion: 2 }
}), scopedBatch(scopeA, "AI应用开发"));
upsertJob(db, eligibleJob("other-scope", "AI应用开发"), scopedBatch(scopeB, "AI应用开发"));
upsertJob(db, eligibleJob("legacy", "AI应用开发"), createBatch(db, "boss", "AI应用开发", "legacy", {
  profileId: saved.profileId,
  searchPlanId: saved.planId
}));

createWorkflowRun(db, {
  profileId: saved.profileId,
  planId: saved.planId,
  localDay: "2026-08-04",
  sequence: 1,
  targetSuccessCount: 1,
  inventoryCount: 0,
  candidateGap: 1,
  scanNeeded: true,
  keywords: [{ word: "RAG开发", priority: "B" }],
  budget: { maxDetailTotal: 1, browserPageBudget: 1 },
  planner: { searchScope: { key: scopeA } }
});

const stats = listScopedKeywordStats(db, {
  profileId: saved.profileId,
  scopeKey: scopeA,
  localDay: "2026-08-04",
  now: "2026-08-04T04:00:00.000Z"
});
assert.deepStrictEqual(stats.get("AI应用开发"), {
  sampleSize: 2,
  eligibleCount: 1,
  usedToday: false
});
assert.deepStrictEqual(stats.get("RAG开发"), {
  sampleSize: 1,
  eligibleCount: 1,
  usedToday: true
});
db.close();

console.log("scoped_keyword_stats_smoke ok");
```

Register `"scoped_keyword_stats_smoke.js"` after `"inherited_search_scope_smoke.js"` in `tests/run_all.js`.

- [ ] **Step 2: Run the new test and verify the missing module failure**

Run: `node tests/scoped_keyword_stats_smoke.js`

Expected: FAIL with `Cannot find module '../src/core/scoped_keyword_stats'`.

- [ ] **Step 3: Implement the single scoped query boundary**

Create `src/core/scoped_keyword_stats.js`:

```js
const { decisionBucket } = require("./storage");
const { workflowEligibility } = require("./workflow_inventory");

function listScopedKeywordStats(db, {
  profileId,
  scopeKey,
  localDay,
  now = new Date().toISOString()
} = {}) {
  const normalizedProfileId = Number(profileId);
  const normalizedScopeKey = String(scopeKey || "").trim();
  if (!Number.isInteger(normalizedProfileId) || normalizedProfileId <= 0 || !normalizedScopeKey) {
    return new Map();
  }
  const rows = db.prepare(`WITH ranked AS (
      SELECT jobs.source, jobs.source_id, o.keyword, o.url, o.boss_active_days,
        o.description, o.quality_tags_json, o.analysis_json,
        ROW_NUMBER() OVER (
          PARTITION BY jobs.source, jobs.source_id, o.keyword
          ORDER BY o.seen_at DESC, o.id DESC
        ) AS observation_rank
      FROM job_observations o
      JOIN jobs ON jobs.id = o.job_id
      JOIN batches b ON b.id = o.batch_id
      WHERE b.profile_id = ?
        AND json_extract(b.filter_snapshot_json, '$.execution.searchScope.key') = ?
    )
    SELECT * FROM ranked WHERE observation_rank = 1`)
    .all(normalizedProfileId, normalizedScopeKey);
  const usedRows = /^\d{4}-\d{2}-\d{2}$/.test(String(localDay || ""))
    ? db.prepare(`SELECT keywords_json FROM workflow_runs
        WHERE profile_id = ? AND local_day = ?
          AND json_extract(planner_json, '$.searchScope.key') = ?`)
      .all(normalizedProfileId, String(localDay), normalizedScopeKey)
    : [];
  const usedToday = new Set(usedRows.flatMap((row) =>
    parseJson(row.keywords_json, []).map((item) => String(item?.word || item || "").trim())
  ).filter(Boolean));
  const stats = new Map();
  for (const row of rows) {
    const word = String(row.keyword || "").trim();
    if (!word) continue;
    const qualityTags = parseJson(row.quality_tags_json, []);
    const analysis = parseJson(row.analysis_json, {});
    const job = {
      source: row.source,
      sourceId: row.source_id,
      keyword: word,
      url: row.url || "",
      bossActiveDays: row.boss_active_days,
      description: row.description || "",
      qualityTags,
      analysis,
      applicationStatus: "",
      applicationReasonCode: "",
      reviewAt: ""
    };
    job.decisionBucket = decisionBucket(job);
    const current = stats.get(word) || {
      sampleSize: 0,
      eligibleCount: 0,
      usedToday: usedToday.has(word)
    };
    current.sampleSize += 1;
    if (workflowEligibility(job, { now }).eligible) current.eligibleCount += 1;
    stats.set(word, current);
  }
  for (const word of usedToday) {
    if (!stats.has(word)) {
      stats.set(word, { sampleSize: 0, eligibleCount: 0, usedToday: true });
    }
  }
  return stats;
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

module.exports = { listScopedKeywordStats };
```

- [ ] **Step 4: Make workflow planning accept a frozen scope and catalog**

Change the signature in `src/dashboard/server.js`:

```js
function buildWorkflowDashboardState(
  db,
  planRecord,
  now = new Date(),
  { searchScope = null, keywordSource = null } = {}
) {
```

Replace the global `listDecisionPool` keyword-statistics loop and plan-level `usedKeywords` set with:

```js
const scopedStats = searchScope?.key
  ? listScopedKeywordStats(db, {
    profileId: planRecord.profileId,
    scopeKey: searchScope.key,
    localDay,
    now: asIso(now)
  })
  : new Map();
const catalog = keywordSource?.keywords?.length
  ? keywordSource.keywords
  : (planRecord.plan?.keywords || []);
const keywords = catalog.map((item, index) => {
  const source = typeof item === "string" ? { word: item, priority: "B", reason: "" } : item;
  const stats = scopedStats.get(String(source.word || "").trim())
    || { sampleSize: 0, eligibleCount: 0, usedToday: false };
  return {
    word: String(source.word || "").trim(),
    priority: source.priority || "B",
    reason: String(source.reason || ""),
    planOrder: index,
    ...stats
  };
}).filter((item) => item.word);
```

Return `searchScope` and `keywordSource` in the dashboard state. Import `listScopedKeywordStats` at the top.

- [ ] **Step 5: Prove a fresh scope falls back to priority and configured order**

In `tests/workflow_planner_smoke.js`, add:

```js
const freshInheritedScope = planWorkflowRun(fixture({
  keywords: [
    keyword("AI应用开发工程师", "A", 0),
    keyword("大模型应用开发工程师", "A", 1),
    keyword("Agent开发工程师", "A", 2),
    keyword("RAG开发工程师", "B", 3)
  ]
}));
assert.deepStrictEqual(
  freshInheritedScope.selectedKeywords.map((item) => item.word),
  ["AI应用开发工程师", "大模型应用开发工程师", "Agent开发工程师"]
);
```

- [ ] **Step 6: Run scope-statistics and planner tests**

Run:

```powershell
node tests/scoped_keyword_stats_smoke.js
node tests/workflow_planner_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: all three pass; dashboard fixtures without a live scope use zero scoped history rather than legacy plan-wide yield.

- [ ] **Step 7: Commit scoped keyword scheduling**

```powershell
git add -- src/core/scoped_keyword_stats.js src/dashboard/server.js tests/scoped_keyword_stats_smoke.js tests/workflow_planner_smoke.js tests/run_all.js
git commit -m "feat: isolate keyword yield by inherited scope"
```

Expected: one commit with no schema migration.

---

### Task 5: Freeze the Inherited Context before Starting a Workflow

**Files:**
- Modify: `src/dashboard/server.js:1-108,108-175,927-1014,1119-1250`
- Modify: `src/cli.js:1-30,347-625,989-1040,1155-1190`
- Modify: `src/core/scan_snapshot.js:1-70,121-220`
- Modify: `tests/workflow_dashboard_smoke.js`
- Modify: `tests/scan_snapshot_smoke.js`
- Modify: `tests/workflow_scan_smoke.js`

**Interfaces:**
- Consumes: live page inspection, confirmed matching context, platform catalog, scope-specific keyword stats.
- Produces workflow planner fields:

```js
{
  acquisitionMode: "inherited",
  searchTemplate,
  searchScope,
  keywordSource,
  platformPolicy
}
```

- Produces scan snapshot schema version `3` with the same four fields.
- Initial scan and resume consume the frozen workflow fields; resume never rebuilds them from the current live URL.

- [ ] **Step 1: Add a fake inherited-context resolver to the dashboard smoke test**

In `seedProfile()` inside `tests/workflow_dashboard_smoke.js`, replace the keyword fixture with:

```js
keywords: [
  { word: "AI应用开发工程师", priority: "A", reason: "主方向" },
  { word: "大模型应用开发工程师", priority: "A", reason: "主方向" },
  { word: "Agent开发工程师", priority: "A", reason: "主方向" },
  { word: "RAG工程师", priority: "B", reason: "补充方向" }
],
```

In `tests/workflow_dashboard_smoke.js`, define a controllable resolver:

```js
let inheritedFailureCode = "";
const inheritedContextResolver = async ({ plan, matchingContext }) => {
  if (inheritedFailureCode) {
    throw Object.assign(new Error(`blocked by ${inheritedFailureCode}`), {
      code: inheritedFailureCode,
      statusCode: 409
    });
  }
  return {
  acquisitionMode: "inherited",
  searchTemplate: {
    mode: "inherited",
    url: "https://www.zhipin.com/web/geek/jobs?city=100010000&salary=405",
    cityCode: "100010000"
  },
  searchScope: {
    key: `boss:${plan.profileId}:fixture-scope`,
    site: "boss",
    templateHash: "fixture-scope",
    templateUrl: "https://www.zhipin.com/web/geek/jobs?city=100010000&salary=405",
    filterParams: { city: ["100010000"], salary: ["405"] }
  },
  keywordSource: {
    searchPlanId: plan.id,
    profileVersionId: plan.profileVersionId,
    matchingCardRevision: "fixture-card",
    catalogHash: "fixture-catalog",
    keywords: plan.plan.keywords.map(({ word, priority, reason = "" }) => ({ word, priority, reason }))
  },
  platformPolicy: {
    hash: "fixture-policy",
    site: "boss",
    templateHash: "fixture-scope",
    filters: {
      location: { mode: "nationwide", codes: ["100010000"], cities: [], districts: [] },
      salary: { codes: ["405"], labels: ["10-20K"], ranges: [{ minK: 10, maxK: 20 }] },
      experience: { codes: [], labels: [] },
      degree: { codes: [], labels: [] },
      jobType: { codes: [], labels: [] },
      acquisitionOnly: {}
    },
    unresolvedParams: [],
    filterSummary: ["地点：全国", "薪资：10-20K"]
  },
    matchingContext
  };
};
```

Pass `inheritedContextResolver` to `createDashboardServer`.

Before the portable-mode and successful requests, prove live preflight failures create neither workflow nor child process:

```js
for (const code of [
  "BOSS_RISK_CONTROL",
  "BOSS_LOGIN_REQUIRED",
  "BOSS_SEARCH_PAGE_INVALID"
]) {
  inheritedFailureCode = code;
  const rejected = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
    browserMode: "edge",
    action: "start"
  });
  assert.strictEqual(rejected.status, 409);
  assert.strictEqual(listWorkflowRuns(db, { planId: saved.planId }).length, 0);
  assert.strictEqual(spawns.length, 0);
}
inheritedFailureCode = "";
```

After creating the workflow, assert:

```js
assert.strictEqual(workflow.planner.acquisitionMode, "inherited");
assert.strictEqual(workflow.planner.searchScope.key, `boss:${saved.profileId}:fixture-scope`);
assert.strictEqual(workflow.planner.platformPolicy.hash, "fixture-policy");
assert.deepStrictEqual(
  workflow.keywords.map((item) => item.word),
  ["AI应用开发工程师", "大模型应用开发工程师", "Agent开发工程师"]
);
```

Before starting the accepted workflow, submit a separate `browserMode=portable` request and assert:

```js
const portableStart = await postForm(baseUrl, "/api/workflow-run", {
  planId: saved.planId,
  browserMode: "portable",
  action: "start"
});
assert.strictEqual(portableStart.status, 409);
assert.match(portableStart.body, /INHERITED_EDGE_REQUIRED/);
```

After forcing the accepted workflow into `interrupted`, submit its resume once with `browserMode=portable`:

```js
const spawnCountBeforePortableResume = spawns.length;
const portableResume = await postForm(baseUrl, "/api/workflow-run/resume", {
  workflowRunId: workflow.id,
  browserMode: "portable"
});
assert.strictEqual(portableResume.status, 409);
assert.match(portableResume.body, /INHERITED_EDGE_REQUIRED/);
assert.strictEqual(spawns.length, spawnCountBeforePortableResume);
```

Then keep the existing successful Edge resume assertion.

- [ ] **Step 2: Run the dashboard test and verify the missing injection/frozen fields**

Run: `node tests/workflow_dashboard_smoke.js`

Expected: FAIL because `createDashboardServer` does not accept or invoke `inheritedContextResolver`.

- [ ] **Step 3: Add the production read-only context resolver**

Extend `createDashboardServer` with:

```js
inheritedContextResolver = resolveLiveInheritedContext
```

Pass it to `handleWorkflowRunStart`.

Add `resolveLiveInheritedContext` in `src/dashboard/server.js`:

```js
async function resolveLiveInheritedContext({
  db,
  plan,
  matchingContext,
  logger
}) {
  try {
    const adapter = new boss.BossSiteAdapter({
      browser: new EdgeControlAdapter(),
      logger
    });
    const preflight = await adapter.preflight();
    if (!preflight.isSearchPage) {
      throw appError(
        "BOSS_SEARCH_PAGE_INVALID",
        "请先在现有 Edge 的 BOSS-SEARCH 标签页打开岗位搜索结果页。",
        { statusCode: 409 }
      );
    }
    const inspected = await adapter.inspectInheritedSearchPage({ tabId: preflight.tabId });
    const { searchTemplate, searchScope } = buildInheritedSearchScope({
      profileId: plan.profileId,
      rawUrl: inspected.url
    });
    const inspectedFieldCount = Object.keys(inspected.catalog?.fields || {}).length;
    if (inspectedFieldCount) {
      savePlatformFilterCatalog(db, {
        site: "boss",
        catalog: inspected.catalog,
        source: "live_dom",
        discoveredAt: inspected.catalog.discoveredAt
      });
    }
    const catalog = inspectedFieldCount
      ? inspected.catalog
      : getPlatformFilterCatalog(db, "boss")?.catalog || {};
    const keywordSource = freezeKeywordSource({
      planRecord: plan,
      matchingCardRevision: matchingCardRevision(matchingContext.matchingCard)
    });
    const platformPolicy = compilePlatformRuntimePolicy({
      searchScope,
      catalog,
      urlOptions: inspected.urlOptions,
      cityCodes: CITY_CODES
    });
    logger.info("inherited_scope_resolved", {
      site: "boss",
      scopeId: scopeShortId(searchScope.key),
      recognizedFilterCount: platformPolicy.filterSummary.length,
      unresolvedFilterCount: platformPolicy.unresolvedParams.length,
      keywordCatalogHash: keywordSource.catalogHash
    });
    for (const unresolved of platformPolicy.unresolvedParams) {
      logger.warn("platform_filter_unresolved", {
        site: "boss",
        scopeId: scopeShortId(searchScope.key),
        param: unresolved.param,
        codes: unresolved.codes
      });
    }
    return {
      acquisitionMode: "inherited",
      searchTemplate,
      searchScope,
      keywordSource,
      platformPolicy
    };
  } catch (error) {
    if (["BOSS_RISK_CONTROL", "BOSS_LOGIN_REQUIRED", "BOSS_TAB_REQUIRED", "BOSS_SEARCH_PAGE_INVALID"].includes(error?.code)
      && !error.statusCode) {
      throw appError(error.code, error.message, { statusCode: 409, cause: error });
    }
    throw error;
  }
}
```

Import `EdgeControlAdapter`, `buildInheritedSearchScope`, `freezeKeywordSource`, `scopeShortId`, `compilePlatformRuntimePolicy`, `matchingCardRevision`, and `savePlatformFilterCatalog`.

- [ ] **Step 4: Resolve the live scope before keyword planning and workflow creation**

In `handleWorkflowRunStart`, reject non-Edge input before preflight:

```js
if (params.browserMode && params.browserMode !== "edge") {
  throw appError(
    "INHERITED_EDGE_REQUIRED",
    "继承模式必须使用当前已登录 Edge 的 BOSS-SEARCH 标签页。",
    { statusCode: 409 }
  );
}
```

After Search Plan readiness checks and before `buildWorkflowDashboardState`, call:

```js
const inheritedContext = await inheritedContextResolver({
  db,
  plan,
  matchingContext,
  logger
});
const state = buildWorkflowDashboardState(db, plan, new Date(), inheritedContext);
```

When creating the workflow, freeze:

```js
planner: {
  ...state.nextPlan,
  acquisitionMode: inheritedContext.acquisitionMode,
  searchTemplate: inheritedContext.searchTemplate,
  searchScope: inheritedContext.searchScope,
  keywordSource: inheritedContext.keywordSource,
  platformPolicy: inheritedContext.platformPolicy
}
```

Always start workflow scans with `browserMode: "edge"`. Do not invoke the resolver in `handleWorkflowRunResume`; resume reads `workflow.planner`.

In `handleWorkflowRunResume`, if `workflow.planner.acquisitionMode === "inherited"` and the submitted browser mode is not empty or `edge`, return `INHERITED_EDGE_REQUIRED` with HTTP 409. Pass `browserMode: "edge"` to `startPlanScan`.

In `renderWorkflowLaunchPanel` and the interrupted-workflow resume form, replace the browser `<select>` with:

```html
<input type="hidden" name="browserMode" value="edge">
<span class="hint">使用当前 Edge 的 BOSS-SEARCH 标签页</span>
```

Do not change the Edge/portable selector in the separate “高级扫描与维护” controls; those existing direct-scan paths retain their current mode resolution.

- [ ] **Step 5: Extend the scan snapshot and compatibility gate**

In `src/core/scan_snapshot.js`:

1. Set `SCHEMA_VERSION = 3`.
2. Add `searchScope`, `keywordSource`, and `platformPolicy` to `PAYLOAD_FIELDS`.
3. Normalize and include them in `buildScanExecutionSnapshot`.

Use this exact safe projection:

```js
function normalizeInheritedContext(input = {}) {
  return cloneJson({
    searchScope: {
      key: String(input.searchScope?.key || ""),
      site: String(input.searchScope?.site || ""),
      templateHash: String(input.searchScope?.templateHash || ""),
      templateUrl: String(input.searchScope?.templateUrl || ""),
      filterParams: input.searchScope?.filterParams || {}
    },
    keywordSource: {
      searchPlanId: Number(input.keywordSource?.searchPlanId || 0),
      profileVersionId: Number(input.keywordSource?.profileVersionId || 0),
      matchingCardRevision: String(input.keywordSource?.matchingCardRevision || ""),
      catalogHash: String(input.keywordSource?.catalogHash || ""),
      keywords: input.keywordSource?.keywords || []
    },
    platformPolicy: input.platformPolicy || {}
  });
}
```

Generated snapshots use empty normalized objects for these fields. In `tests/scan_snapshot_smoke.js`, add a complete inherited context to `input`, expect schema `3`, and add three mutations that independently change the scope key, catalog hash, and platform-policy hash; every mutation must change `snapshotHash` and fail compatibility.

- [ ] **Step 6: Make CLI consume the workflow snapshot before creating its analyzer**

In `src/cli.js`, move `createJobAnalysisRunner` below browser preflight and acquisition-context resolution.

For a workflow scan, use:

```js
const frozenInherited = workflowRun?.planner?.acquisitionMode === "inherited"
  ? {
    acquisitionMode: "inherited",
    searchTemplate: workflowRun.planner.searchTemplate,
    searchScope: workflowRun.planner.searchScope,
    keywordSource: workflowRun.planner.keywordSource,
    platformPolicy: workflowRun.planner.platformPolicy
  }
  : null;
```

Validate all four frozen objects and their hashes before navigation:

```js
if (frozenInherited && (
  frozenInherited.searchTemplate?.mode !== "inherited"
  || !frozenInherited.searchScope?.key
  || !frozenInherited.keywordSource?.catalogHash
  || !frozenInherited.platformPolicy?.hash
)) {
  throw codedError(
    "WORKFLOW_INHERITED_SNAPSHOT_INVALID",
    "本轮继承模式快照不完整，不能安全扫描或恢复。"
  );
}
```

When frozen context exists:

```js
configs = applyPlatformRuntimePolicy(configs, frozenInherited.platformPolicy);
searchTemplate = frozenInherited.searchTemplate;
searchScope = frozenInherited.searchScope;
keywordSource = frozenInherited.keywordSource;
platformPolicy = frozenInherited.platformPolicy;
cityScopes = [{
  city: platformPolicy.filters?.location?.cities?.[0] || "",
  cityCode: searchTemplate.cityCode || "platform-default"
}];
```

For a non-workflow inherited scan, call `adapter.inspectInheritedSearchPage`, build the scope, freeze the current plan keyword source, compile the policy with `urlOptions: inspected.urlOptions`, and apply it before creating `analyzeJob`. For generated mode, retain the current `resolveBossPlatformFilters`, `resolveScanPolicy`, config, and analyzer path without projection.

Build the inherited runtime-policy hash with:

```js
const runtimePolicyHash = searchTemplate.mode === "inherited"
  ? stableHash({
    productPolicyVersion: scanPolicy.policyVersion,
    scanMode,
    platformPolicyHash: platformPolicy.hash
  })
  : scanPolicy.policyHash;
```

Pass `searchScope`, `keywordSource`, and `platformPolicy` into `buildScanExecutionSnapshot`. Persist them in `filterSnapshot.execution`; do not log the full template URL.

- [ ] **Step 7: Ensure resume uses only frozen fields**

In `resolveResumeBatch`, keep `assertScanSnapshotCompatible(storedSnapshot, executionSnapshot)` as the single resume gate. Add assertions in `tests/scan_snapshot_smoke.js`:

```js
const changedLivePage = {
  ...input,
  searchTemplate: input.searchTemplate,
  searchScope: input.searchScope,
  keywordSource: input.keywordSource,
  platformPolicy: input.platformPolicy
};
assertScanSnapshotCompatible(
  snapshot,
  buildScanExecutionSnapshot(changedLivePage)
);
```

The test represents a changed live tab that is deliberately absent from the frozen input. A changed frozen scope must still fail.

Update `tests/workflow_scan_smoke.js` fixture workflows that use JSON input to set `planner.acquisitionMode: "generated"`; this proves offline generated workflow scans do not require a BOSS page.

- [ ] **Step 8: Run workflow, snapshot, and CLI regression tests**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
node tests/scan_snapshot_smoke.js
node tests/workflow_scan_smoke.js
node tests/scan_cli_lifecycle_smoke.js
node tests/scan_end_to_end_recovery_smoke.js
```

Expected: all five pass; no test opens a real browser or reads `data/jobs.sqlite`.

- [ ] **Step 9: Commit frozen workflow execution**

```powershell
git add -- src/dashboard/server.js src/cli.js src/core/scan_snapshot.js tests/workflow_dashboard_smoke.js tests/scan_snapshot_smoke.js tests/workflow_scan_smoke.js
git commit -m "feat: freeze inherited workflow execution"
```

Expected: one commit covering workflow creation, CLI consumption, snapshot schema 3, and resume compatibility.

---

### Task 6: Show Scope Authority and Privacy-Safe Diagnostics

**Files:**
- Modify: `src/dashboard/server.js:2173-2290`
- Modify: `tests/workflow_dashboard_smoke.js`
- Modify: `tests/observability_context_smoke.js`

**Interfaces:**
- Consumes: `workflow.planner.searchScope`, `keywordSource`, `platformPolicy`.
- Produces: a visible inherited-scope summary on every workflow phase.
- Logs only short scope ID, counts, hashes already intended for audit, parameter names, and codes; never logs the full URL, candidate identity, resume text, JD, cookies, keys, or browser state.

- [ ] **Step 1: Add failing workflow-page assertions**

In `tests/workflow_dashboard_smoke.js`, after loading `scanningPage`, assert:

```js
for (const text of [
  "筛选来源：BOSS 当前页面",
  "地点：全国",
  "薪资：10-20K",
  "范围：fixture-sc",
  "关键词来源：Search Plan",
  "AI应用开发工程师",
  "RAG工程师",
  "Agent工程师",
  "修改 BOSS 筛选会创建新的统计范围"
]) {
  assert.match(scanningPage.body, new RegExp(text));
}
assert.doesNotMatch(scanningPage.body, /广州 AI.*目标城市/);
```

Create a second fake context with:

```js
unresolvedParams: [{ param: "industry", codes: ["100020"] }]
```

Assert the page contains `未解析平台筛选：industry` but does not render a raw authenticated browser-state object.

- [ ] **Step 2: Run the dashboard test and verify the missing summary**

Run: `node tests/workflow_dashboard_smoke.js`

Expected: FAIL because the workflow page does not yet render inherited authority.

- [ ] **Step 3: Add one reusable scope-summary renderer**

Add to `src/dashboard/server.js`:

```js
function renderInheritedScopeSummary(workflow) {
  if (workflow?.planner?.acquisitionMode !== "inherited") return "";
  const scope = workflow.planner.searchScope || {};
  const source = workflow.planner.keywordSource || {};
  const policy = workflow.planner.platformPolicy || {};
  const filters = (policy.filterSummary || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const keywords = (source.keywords || [])
    .map((item) => escapeHtml(item.word || "")).filter(Boolean).join("、");
  const unresolved = (policy.unresolvedParams || []).map((item) => item.param).filter(Boolean);
  return `<section class="workflow-scope">
    <strong>筛选来源：BOSS 当前页面</strong>
    <ul>${filters || "<li>使用平台默认筛选</li>"}</ul>
    <p>范围：${escapeHtml(scopeShortId(scope.key))} · 关键词来源：Search Plan #${escapeHtml(source.searchPlanId || "")}</p>
    <p>本轮关键词：${keywords || "无"}</p>
    ${unresolved.length ? `<p class="workflow-alert">未解析平台筛选：${escapeHtml(unresolved.join("、"))}；采集 URL 已保留这些条件，本地不会猜值。</p>` : ""}
    <p class="hint">修改 BOSS 筛选会创建新的统计范围；本轮恢复仍使用当前冻结范围。</p>
  </section>`;
}
```

Add minimal styles for `.workflow-scope`, then place `${renderInheritedScopeSummary(workflow)}` between the workflow header and phase. Import `scopeShortId`.

- [ ] **Step 4: Add privacy assertions for observability**

In `tests/observability_context_smoke.js`, feed an inherited-scope event through the existing test logger:

```js
logger.info("inherited_scope_resolved", {
  site: "boss",
  scopeId: "1234567890",
  recognizedFilterCount: 4,
  unresolvedFilterCount: 1,
  keywordCatalogHash: "catalog-hash"
});
```

Assert serialized events include these fields and do not include any of:

```js
[
  "https://www.zhipin.com/web/geek/jobs?",
  "candidateProfile",
  "resumeText",
  "description",
  "cookie",
  "apiKey"
]
```

- [ ] **Step 5: Run dashboard and observability tests**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
node tests/observability_context_smoke.js
node tests/data_visibility_smoke.js
```

Expected: all three pass; the dashboard displays only the short range ID and filter summary.

- [ ] **Step 6: Commit UI and diagnostics**

```powershell
git add -- src/dashboard/server.js tests/workflow_dashboard_smoke.js tests/observability_context_smoke.js
git commit -m "feat: show inherited search authority"
```

Expected: one commit containing UI copy and privacy-safe logging assertions.

---

### Task 7: Full Verification, Current Plan Data Edit, and Read-Only Live Acceptance

**Files:**
- Modify operational data only after backup: `data/jobs.sqlite`
- Create operational backup: `data/backups/jobs-before-inherited-scope-<timestamp>.sqlite`
- No additional tracked source file is required.

**Interfaces:**
- Consumes: active Search Plan `#1`, its complete persisted plan JSON, current Edge `BOSS-SEARCH` page, and the implementation from Tasks 1-6.
- Produces: Search Plan `#1` with only `Python AI后端` removed from its keyword catalog.
- Produces: a fresh inherited scope whose first selection uses the remaining A-priority direct keywords.

- [ ] **Step 1: Run the complete offline suite before touching operational data**

Run:

```powershell
npm.cmd test
git diff --check
git status --short
```

Expected: all offline checks pass; `git diff --check` prints nothing; the working tree contains no uncommitted production-code changes.

- [ ] **Step 2: Back up and update only the current keyword catalog**

Ensure no BOSS scan lease is active, then run:

```powershell
@'
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  openDb,
  getSearchPlan,
  saveSearchPlan,
  getSiteScanLease
} = require("./src/core/storage");

const dbPath = "D:/Guo/ZhiPing/data/jobs.sqlite";
const db = openDb(dbPath);
const lease = getSiteScanLease(db, "boss");
if (lease) throw new Error(`BOSS scan lease is active: ${lease.command}`);
const record = getSearchPlan(db, 1);
if (!record) throw new Error("Search Plan #1 not found");
const before = record.plan.keywords || [];
const removed = before.filter((item) => String(item?.word || item) === "Python AI后端");
assert.strictEqual(removed.length, 1);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(
  "D:/Guo/ZhiPing/data/backups",
  `jobs-before-inherited-scope-${timestamp}.sqlite`
);
db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
const plan = {
  ...record.plan,
  keywords: before.filter((item) => String(item?.word || item) !== "Python AI后端")
};
saveSearchPlan(db, {
  id: record.id,
  profileId: record.profileId,
  profileVersionId: record.profileVersionId,
  plan
});
const saved = getSearchPlan(db, 1);
assert.strictEqual(saved.plan.keywords.some(
  (item) => String(item?.word || item) === "Python AI后端"
), false);
assert.deepStrictEqual(
  saved.plan.keywords.map((item) => String(item?.word || item)),
  ["AI应用开发工程师", "大模型应用开发工程师", "Agent开发工程师", "RAG开发工程师", "AI知识库开发"]
);
console.log(JSON.stringify({
  planId: saved.id,
  backupPath,
  keywordCount: saved.plan.keywords.length,
  removedKeyword: "Python AI后端"
}));
db.close();
'@ | node
```

Expected: JSON reports `planId:1`, `keywordCount:5`, the removed keyword, and a backup path under `D:\Guo\ZhiPing\data\backups`.

- [ ] **Step 3: Verify the saved plan without changing observations**

Run:

```powershell
@'
const assert = require("node:assert/strict");
const {openDb,getSearchPlan} = require("./src/core/storage");
const db = openDb("D:/Guo/ZhiPing/data/jobs.sqlite");
const record = getSearchPlan(db, 1);
assert.deepStrictEqual(record.plan.keywords.map((item) => ({
  word: item.word,
  priority: item.priority,
  reason: item.reason || ""
})), [
  { word: "AI应用开发工程师", priority: "A", reason: record.plan.keywords[0].reason || "" },
  { word: "大模型应用开发工程师", priority: "A", reason: record.plan.keywords[1].reason || "" },
  { word: "Agent开发工程师", priority: "A", reason: record.plan.keywords[2].reason || "" },
  { word: "RAG开发工程师", priority: "B", reason: record.plan.keywords[3].reason || "" },
  { word: "AI知识库开发", priority: "B", reason: record.plan.keywords[4].reason || "" }
]);
db.close();
console.log("current inherited keyword catalog ok");
'@ | node
```

Expected: `current inherited keyword catalog ok`. Do not run `rescore-plan`; removing a search phrase does not change stored job semantics.

- [ ] **Step 4: Perform a minimal read-only live preflight**

Keep the existing logged-in `BOSS-SEARCH` tab on the intended filters, then run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-edge-control.ps1 -CheckOnly
@'
(async () => {
  const {EdgeControlAdapter} = require("./src/adapters/browser/edge_control");
  const {BossSiteAdapter} = require("./src/adapters/sites/boss");
  const {buildInheritedSearchScope,scopeShortId} = require("./src/core/inherited_search_scope");
  const {compilePlatformRuntimePolicy} = require("./src/core/platform_runtime_policy");
  const {CITY_CODES} = require("./src/core/search_plan");
  const {openDb,getPlatformFilterCatalog} = require("./src/core/storage");
  const db = openDb("D:/Guo/ZhiPing/data/jobs.sqlite");
  const adapter = new BossSiteAdapter({browser:new EdgeControlAdapter()});
  const preflight = await adapter.preflight();
  const inspected = await adapter.inspectInheritedSearchPage({tabId:preflight.tabId});
  const {searchScope} = buildInheritedSearchScope({profileId:1,rawUrl:inspected.url});
  const catalog = Object.keys(inspected.catalog.fields || {}).length
    ? inspected.catalog
    : getPlatformFilterCatalog(db,"boss")?.catalog || {};
  const policy = compilePlatformRuntimePolicy({
    searchScope,
    catalog,
    urlOptions:inspected.urlOptions,
    cityCodes:CITY_CODES
  });
  console.log(JSON.stringify({
    tabId:preflight.tabId,
    scopeId:scopeShortId(searchScope.key),
    filterSummary:policy.filterSummary,
    unresolvedParams:policy.unresolvedParams.map((item)=>item.param)
  }));
  db.close();
})().catch((error)=>{console.error(error.code || error.message);process.exit(1)});
'@ | node
```

Expected: Edge bridge check succeeds; output contains one tab ID, a ten-character scope ID, the recognized filter summary, and only unresolved parameter names. The command performs no navigation.

- [ ] **Step 5: Start one inherited workflow and verify the frozen plan**

From the existing dashboard, use the primary `执行一轮` button. The form now always uses the current Edge tab. After redirect to `/workflow?runId=<id>`, verify the page shows:

```text
筛选来源：BOSS 当前页面
范围：<10-character id>
本轮关键词：AI应用开发工程师、大模型应用开发工程师、Agent开发工程师
```

Read the created workflow and batch without printing private job text:

```powershell
@'
const assert = require("node:assert/strict");
const {openDb,listWorkflowRuns,getBatch} = require("./src/core/storage");
const db = openDb("D:/Guo/ZhiPing/data/jobs.sqlite");
const run = listWorkflowRuns(db,{profileId:1,planId:1,limit:1})[0];
assert.strictEqual(run.planner.acquisitionMode,"inherited");
assert.deepStrictEqual(run.keywords.map((item)=>item.word),[
  "AI应用开发工程师",
  "大模型应用开发工程师",
  "Agent开发工程师"
]);
assert(run.planner.searchScope.key);
assert(run.planner.platformPolicy.hash);
assert(run.planner.keywordSource.catalogHash);
const batch = run.scanBatchId ? getBatch(db,run.scanBatchId) : null;
if(batch){
  assert.strictEqual(
    batch.filterSnapshot.execution.searchScope.key,
    run.planner.searchScope.key
  );
  assert.strictEqual(
    batch.filterSnapshot.execution.platformPolicy.hash,
    run.planner.platformPolicy.hash
  );
}
console.log(JSON.stringify({
  workflowRunId:run.id,
  status:run.status,
  scopeId:run.planner.searchScope.key.split(":").at(-1).slice(0,10),
  keywordCount:run.keywords.length,
  batchSnapshotVerified:Boolean(batch)
}));
db.close();
'@ | node
```

Expected: the three direct A-priority keywords are frozen; if the child process has already created a batch, its scope and policy hashes match the workflow.

- [ ] **Step 6: Verify generated mode and complete regression**

Run:

```powershell
node tests/scan_cli_lifecycle_smoke.js
node tests/workflow_scan_smoke.js
node tests/scan_end_to_end_recovery_smoke.js
npm.cmd test
git diff --check
git status --short
```

Expected: all tests pass; generated fixture scans remain browser-independent; `git diff --check` is empty; the operational SQLite and its backup are not staged by Git.

- [ ] **Step 7: Record the implementation checkpoint**

If Step 6 leaves no tracked changes, do not create an empty commit. Record:

```powershell
git log -7 --oneline
git status --short
```

Expected: the implementation branch contains the focused commits from Tasks 1-6, and `data/jobs.sqlite` remains ignored operational data.
