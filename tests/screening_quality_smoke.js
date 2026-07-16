const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  normalizeBossUrl,
  normalizeBossNavigationUrl,
  normalizeBossJob,
  cleanDetailText,
  parseBossActivityText,
  BossSiteAdapter,
  buildBossSearchUrl,
  parseBossFilterCatalog,
  weightedCardLimit,
  mergeScanCandidate,
  normalizePageBudget,
  randomBetween
} = require("../src/adapters/sites/boss");
const { resolveNativeFilterSnapshot } = require("../src/core/platform_filters");
const { scoreJob, decisionState, activeDays } = require("../src/core/scoring");
const { extractJobMetadata } = require("../src/core/job_metadata");
const { normalizeSearchPlan } = require("../src/core/profile_schema");
const {
  openDb,
  createBatch,
  upsertJob,
  markApplication,
  bindBatchToPlan,
  rescorePlanObservations,
  listReportJobs,
  listDecisionQueue,
  decisionBucket,
  applyJobQualityGovernance,
  getPlatformFilterCatalog,
  savePlatformFilterCatalog
} = require("../src/core/storage");

const root = path.resolve(__dirname, "..");
const tmpDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(tmpDir, `screening-quality-${Date.now()}.sqlite`);
fs.mkdirSync(tmpDir, { recursive: true });

const freshActivity = applyJobQualityGovernance([{
  id: 1,
  bossActiveDays: 0,
  bossActiveText: "今日活跃",
  lastSeenAt: "2026-07-13T00:00:00.000Z",
  qualityTags: []
}], { now: "2026-07-15T00:00:00.000Z", maxActiveDays: 3 })[0];
assert.strictEqual(freshActivity.effectiveBossActiveDays, 2);
assert.strictEqual(freshActivity.decisionBucket, "backup");
assert(freshActivity.qualityTags.includes("activity_snapshot_aged"));
assert(!freshActivity.qualityTags.includes("stale_or_unknown_active"));

const expiredActivity = applyJobQualityGovernance([{
  id: 2,
  bossActiveDays: 0,
  bossActiveText: "今日活跃",
  lastSeenAt: "2026-07-10T00:00:00.000Z",
  qualityTags: []
}], { now: "2026-07-15T00:00:00.000Z", maxActiveDays: 3 })[0];
assert.strictEqual(expiredActivity.effectiveBossActiveDays, 5);
assert(expiredActivity.qualityTags.includes("stale_or_unknown_active"));
assert.strictEqual(expiredActivity.decisionBucket, "refresh");

assert.strictEqual(normalizeBossUrl("https://www.zhipin.com/job_detail/abc123.html?ka=search"), "https://www.zhipin.com/job_detail/abc123.html");
assert.strictEqual(normalizeBossNavigationUrl("https://www.zhipin.com/job_detail/abc123.html?securityId=token"), "https://www.zhipin.com/job_detail/abc123.html?securityId=token");
assert.strictEqual(normalizeBossUrl("javascript:;"), "");
assert.strictEqual(normalizeBossUrl("https://www.zhipin.com/web/geek/jobs"), "");
assert.deepStrictEqual(extractJobMetadata("广州 · 12-18K·13薪 · 1-3年 · 本科"), { salary: "12-18K·13薪", experience: "1-3年", education: "本科" });
assert.deepStrictEqual(normalizeBossJob({
  source: "boss", title: "Python Engineer", company: "Quality Corp", location: "广州", url: "https://www.zhipin.com/job_detail/metadata.html",
  cardText: "广州 10-15K 2-3年 本科 Python FastAPI"
}), {
  source: "boss", sourceId: "boss:metadata", keyword: "", title: "Python Engineer", company: "Quality Corp", location: "广州",
  salary: "10-15K", experience: "2-3年", education: "本科", bossActiveText: "", url: "https://www.zhipin.com/job_detail/metadata.html",
  tags: [], description: "", detailRead: false
});
assert.strictEqual(parseBossActivityText("负责在线客服系统集成"), "");
assert.strictEqual(parseBossActivityText("梁子其 近半年活跃"), "近半年活跃");
assert.strictEqual(activeDays("近半年活跃"), 180);
assert.strictEqual(parseBossActivityText("在线"), "今日活跃");
assert.strictEqual(parseBossActivityText("许女士 在线 网思科技"), "今日活跃");
assert.strictEqual(parseBossActivityText("刚刚活跃"), "今日活跃");
assert.strictEqual(parseBossActivityText("符先生 2周内活跃"), "2周内活跃");
assert.strictEqual(activeDays("2周内活跃"), 14);
assert.strictEqual(parseBossActivityText("张先生 2月内活跃"), "2月内活跃");
assert.strictEqual(activeDays("2月内活跃"), 60);
assert.strictEqual(normalizeBossJob({ title: "AI应用", bossActiveText: "在线" }).bossActiveText, "今日活跃");
assert.strictEqual(weightedCardLimit("A", 100), 100);
assert.strictEqual(weightedCardLimit("B", 100), 65);
assert.strictEqual(weightedCardLimit("C", 100), 40);
assert.strictEqual(normalizePageBudget(10), 20);
assert.strictEqual(normalizePageBudget(500), 300);
assert.strictEqual(randomBetween(100, 200, () => 0), 100);
assert.strictEqual(randomBetween(100, 200, () => 1), 200);
const bossCatalog = parseBossFilterCatalog([
  { options: [
    { ka: "sel-job-rec-salary-404", label: "5-10K" },
    { ka: "sel-job-rec-salary-405", label: "10-20K" }
  ] },
  { options: [
    { ka: "sel-job-rec-exp-101", label: "\u7ecf\u9a8c\u4e0d\u9650" },
    { ka: "sel-job-rec-exp-104", label: "1-3\u5e74" },
    { ka: "sel-job-rec-exp-105", label: "3-5\u5e74" }
  ] }
]);
const nativeFilters = resolveNativeFilterSnapshot({ site: "boss", catalog: bossCatalog, plan: {
  salary: { minK: 8, maxK: 12 },
  experience: ["\u7ecf\u9a8c\u4e0d\u9650", "0-3\u5e74", "1-3\u5e74", "3-5\u5e74\uff08\u53ef\u51b2\uff09"]
} });
assert.deepStrictEqual(nativeFilters.params, { salary: ["404"], experience: ["101", "104", "105"] });
assert.deepStrictEqual(nativeFilters.labels, { salary: ["5-10K"], experience: ["经验不限", "1-3年", "3-5年"] });
const tenToTwenty = resolveNativeFilterSnapshot({
  site: "boss",
  catalog: bossCatalog,
  plan: { salary: { minK: 10, maxK: 20 }, experience: ["1-3\u5e74"] }
});
assert.deepStrictEqual(tenToTwenty.params, { salary: ["405"], experience: ["104"] });
const splitSalaryLanes = resolveNativeFilterSnapshot({
  site: "boss",
  catalog: bossCatalog,
  plan: {
    salary: { minK: 10, maxK: 20 },
    experience: ["1-3\u5e74", "3-5\u5e74\uff08\u53ef\u51b2\uff09"],
    platform: { salaryLanes: ["5-10K", "10-20K"] }
  }
});
assert.strictEqual(splitSalaryLanes.lanes.length, 2);
assert.deepStrictEqual(splitSalaryLanes.lanes.map((lane) => lane.params), [
  { experience: ["104", "105"], salary: ["405"] },
  { experience: ["104", "105"], salary: ["404"] }
]);
const filteredSearchUrl = new URL(buildBossSearchUrl({ keyword: "RAG", cityCode: "101280100", nativeFilters }));
assert.strictEqual(filteredSearchUrl.searchParams.get("query"), "RAG");
assert.strictEqual(filteredSearchUrl.searchParams.get("city"), "101280100");
assert.strictEqual(filteredSearchUrl.searchParams.get("salary"), "404");
assert.strictEqual(filteredSearchUrl.searchParams.get("experience"), "101,104,105");
const extendedSearchUrl = new URL(buildBossSearchUrl({
  keyword: "Python",
  cityCode: "101280100",
  nativeFilters: { params: { degree: ["203"], jobType: ["1901"] } }
}));
assert.strictEqual(extendedSearchUrl.searchParams.get("degree"), "203");
assert.strictEqual(extendedSearchUrl.searchParams.get("jobType"), "1901");

const scanCandidates = new Map();
const scanJob = (id) => ({ source: "boss", url: `https://www.zhipin.com/job_detail/${id}.html`, title: id, company: "Quality Corp" });
mergeScanCandidate(scanCandidates, { job: scanJob("same"), keyword: "Docker", priority: "C", keywordOrder: 2, index: 0, quickScore: 10 });
mergeScanCandidate(scanCandidates, { job: scanJob("same"), keyword: "RAG", priority: "A", keywordOrder: 0, index: 1, quickScore: 8 });
for (let index = 0; index < 4; index += 1) mergeScanCandidate(scanCandidates, { job: scanJob(`b-${index}`), keyword: "LangChain", priority: "B", keywordOrder: 1, index, quickScore: 20 - index });
for (let index = 0; index < 4; index += 1) mergeScanCandidate(scanCandidates, { job: scanJob(`c-${index}`), keyword: "Docker", priority: "C", keywordOrder: 2, index, quickScore: 20 - index });
assert.strictEqual(scanCandidates.size, 9);
assert.strictEqual(scanCandidates.get("boss:same").priority, "A");
assert.deepStrictEqual(scanCandidates.get("boss:same").keywords.sort(), ["Docker", "RAG"]);
assert(!cleanDetailText("职位描述 负责 Python 开发 BOSS安全提示 求职安全提醒").includes("BOSS安全提示"));

const configs = {
  profile: { location: { target_cities: ["广州"] } },
  candidateProfile: { skills: ["Python", "FastAPI", "RAG", "Agent"] },
  scoring: {
    boss_activity: { max_active_days: 3, unknown_penalty: 3, inactive_penalty: 10 },
    salary: { preferred_max_k: 24, hard_max_k: 35, experience_flex_max_k: 18, expected_min_k: 9 },
    work_schedule: { preference: "prefer_double_weekend", double_weekend_bonus: 4, alternating_weekend_penalty: 3, single_weekend_penalty: 6 },
    positive_keywords: [{ word: "Python", weight: 4, label: "Python" }, { word: "RAG", weight: 4, label: "RAG" }],
    risk_rules: [],
    exclude_words: [],
    allowExperienceStretch: true,
    experience_stretch_keywords: ["Python", "RAG", "AI"]
  }
};

const ready = scoreJob(job({ bossActiveText: "今日活跃", experience: "3-5年", salary: "10-16K" }), configs);
assert.strictEqual(decisionState(ready), "ready");
assert(ready.qualityTags.includes("experience_stretch"));
assert.strictEqual(decisionBucket({ ...ready, risks: ["Java占比需确认"], analysis: {} }), "talk");
assert.strictEqual(decisionBucket({ ...ready, level: "可投", qualityTags: ["work_schedule_unknown"], risks: [], analysis: {} }), "talk");

const unknown = scoreJob(job({ bossActiveText: "" }), configs);
assert.strictEqual(decisionState(unknown), "refresh");
const metadataUnknown = scoreJob(job({ salary: "", experience: "", bossActiveText: "今日活跃" }), configs);
assert(metadataUnknown.qualityTags.includes("salary_unverified"));
assert(metadataUnknown.qualityTags.includes("experience_unverified"));
assert.strictEqual(decisionState(metadataUnknown), "ready");
assert.strictEqual(decisionBucket({ ...metadataUnknown, analysis: {} }), "talk");
const listOnly = scoreJob(job({ detailRequired: true, detailRead: false }), configs);
assert.strictEqual(decisionState(listOnly), "refresh");
const scopedConfigs = {
  ...configs,
  scoring: {
    ...configs.scoring,
    experience: { selected: ["0-3年", "3-5年（可冲）"], allowStretch: true },
    salary: { ...configs.scoring.salary, expected_min_k: 9, expected_max_k: 12, mode: "strict" }
  }
};
const stretch = scoreJob(job({ experience: "3-5年", salary: "10-12K" }), scopedConfigs);
assert(stretch.qualityTags.includes("experience_stretch"));
assert(stretch.qualityTags.includes("experience_stretch_low_salary"));
assert.strictEqual(stretch.level, "可冲");
const stretchAtMarket = scoreJob(job({ experience: "3-5年", salary: "20-30K" }), scopedConfigs);
assert(stretchAtMarket.qualityTags.includes("experience_salary_above_target"));
assert(!stretchAtMarket.qualityTags.includes("experience_stretch_low_salary"));
const stretchWithoutTechnicalEvidence = scoreJob(job({
  title: "AI应用开发工程师",
  description: "负责 AI 工具销售和客户拓展。",
  tags: [],
  experience: "3-5年",
  salary: "10-12K"
}), scopedConfigs);
assert.strictEqual(stretchWithoutTechnicalEvidence.canStretch, false);
assert.notStrictEqual(stretchWithoutTechnicalEvidence.level, "可冲");
const overRange = scoreJob(job({ experience: "5-10年", salary: "10-12K" }), scopedConfigs);
assert(overRange.qualityTags.includes("experience_overrange"));
assert.strictEqual(decisionBucket({ ...overRange, analysis: {} }), "backup");
const strictSalary = scoreJob(job({ experience: "0-3年", salary: "15-20K" }), scopedConfigs);
assert.strictEqual(decisionState(strictSalary), "blocked");

const finalSalaryConfigs = {
  ...scopedConfigs,
  scoring: {
    ...scopedConfigs.scoring,
    salary: { ...scopedConfigs.scoring.salary, expected_min_k: 10, expected_max_k: 20, experience_flex_max_k: 20, mode: "wide" }
  }
};
const stretchWithinTarget = scoreJob(job({ experience: "3-5年", salary: "15-20K" }), finalSalaryConfigs);
assert(stretchWithinTarget.qualityTags.includes("experience_stretch"));
assert.strictEqual(decisionState(stretchWithinTarget), "ready");
for (const salary of ["15-25K", "12-24K"]) {
  const overlap = scoreJob(job({ experience: "3-5年", salary }), finalSalaryConfigs);
  assert(overlap.qualityTags.includes("experience_salary_overlap"));
  assert.strictEqual(decisionState(overlap), "ready");
  assert.strictEqual(decisionBucket({ ...overlap, analysis: {} }), "backup");
}
const aboveTarget = scoreJob(job({ experience: "3-5年", salary: "20-30K" }), finalSalaryConfigs);
assert(aboveTarget.qualityTags.includes("experience_salary_above_target"));
assert.strictEqual(decisionState(aboveTarget), "blocked");
const unknownStretchSalary = scoreJob(job({ experience: "3-5年", salary: "" }), finalSalaryConfigs);
assert(unknownStretchSalary.qualityTags.includes("salary_unverified"));
assert(!unknownStretchSalary.qualityTags.includes("experience_salary_above_target"));
assert.strictEqual(decisionState(unknownStretchSalary), "ready");

const doubleWeekend = scoreJob(job({ description: "负责企业 RAG 应用开发，周末双休。" }), configs);
const alternatingWeekend = scoreJob(job({ description: "负责企业 RAG 应用开发，大小周。" }), configs);
assert(doubleWeekend.qualityTags.includes("work_schedule_double"));
assert(alternatingWeekend.qualityTags.includes("work_schedule_alternating"));
assert.strictEqual(decisionState(alternatingWeekend), "ready");
assert(doubleWeekend.score > alternatingWeekend.score);

const lowPriority = scoreJob(job({ salary: "5-6K", description: "Python RAG 开发，大小周。" }), configs);
assert(lowPriority.qualityTags.includes("work_schedule_low_priority"));

const inactive = scoreJob(job({ bossActiveText: "7日内活跃" }), configs);
assert.strictEqual(decisionState(inactive), "blocked");

const offCity = scoreJob(job({ title: "AI Agent 开发（base 佛山）" }), configs);
assert.strictEqual(decisionState(offCity), "blocked");
const offCityInJd = scoreJob(job({
  title: "AI Agent 开发工程师",
  location: "广州·荔湾区",
  description: "负责企业 RAG 与 Agent 开发。上班地点：佛山南海。"
}), configs);
assert(offCityInJd.qualityTags.includes("location_mismatch"));
assert.strictEqual(decisionState(offCityInJd), "blocked");

const wrongRole = scoreJob(job({ title: "AI 培训讲师", bossActiveText: "今日活跃" }), configs);
assert.strictEqual(decisionState(wrongRole), "blocked");
const knowledgeTrainer = scoreJob(job({
  title: "AI知识库训练师",
  bossActiveText: "今日活跃",
  description: "负责企业知识库资料整理、切片、标签管理、Prompt 调优和培训文档。"
}), configs);
assert(knowledgeTrainer.qualityTags.includes("role_mismatch"));
assert.strictEqual(decisionState(knowledgeTrainer), "blocked");
const internshipRole = scoreJob(job({ title: "大模型应用开发实习生", bossActiveText: "今日活跃" }), configs);
assert(internshipRole.qualityTags.includes("internship_role"));
assert.strictEqual(decisionState(internshipRole), "blocked");
const algorithmRole = scoreJob(job({ title: "RAG 算法工程师", bossActiveText: "今日活跃" }), configs);
assert(algorithmRole.qualityTags.includes("algorithm_role"));
assert.strictEqual(decisionState(algorithmRole), "blocked");
const hybridRole = scoreJob(job({ title: "AI Agent 开发工程师", bossActiveText: "今日活跃", description: "负责 Agent 应用开发和 RAG，参与模型训练、算法研究。" }), configs);
assert(hybridRole.qualityTags.includes("algorithm_hybrid"));
assert.strictEqual(decisionState(hybridRole), "ready");
const cppGoCore = scoreJob(job({
  title: "RAG 平台工程师", bossActiveText: "今日活跃",
  description: "负责 RAG 服务开发。任职要求：熟练掌握 C++ 或 Golang，具备服务端开发经验；了解 RAG 者优先。"
}), configs);
assert(cppGoCore.qualityTags.includes("core_stack_mismatch"));
assert.strictEqual(decisionBucket({ ...cppGoCore, analysis: {} }), "backup");
const javaCore = scoreJob(job({
  title: "AI 后端工程师", bossActiveText: "今日活跃",
  description: "岗位职责：负责 AI 平台。任职要求：熟练掌握 Java 和 Spring Boot，具备微服务开发经验。"
}), configs);
assert(javaCore.qualityTags.includes("java_backend_heavy"));
assert.strictEqual(decisionBucket({ ...javaCore, analysis: {} }), "backup");
const pythonCore = scoreJob(job({
  title: "AI 应用开发工程师", bossActiveText: "今日活跃",
  description: "岗位职责：负责 RAG 知识库。任职要求：熟练掌握 Python 和 FastAPI，具备 RAG 项目经验。"
}), configs);
assert.strictEqual(pythonCore.technicalFit.kind, "aligned");
assert(!cleanDetailText("职位描述 负责 Python 开发。公司介绍 这部分不是 JD").includes("公司介绍"));
assert.strictEqual(normalizeSearchPlan({}, { candidate: { city: "广州" } }).workSchedulePreference, "prefer_double_weekend");

const db = openDb(dbPath);
try {
  savePlatformFilterCatalog(db, { site: "boss", catalog: bossCatalog, discoveredAt: bossCatalog.discoveredAt });
  assert.strictEqual(getPlatformFilterCatalog(db, "boss").catalog.version, bossCatalog.version);
  const now = new Date().toISOString();
  const profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name, profile_json, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("Quality Candidate", JSON.stringify({ candidate: { city: "广州" } }), "quality", now, now).lastInsertRowid);
  const planId = Number(db.prepare("INSERT INTO search_plans(profile_id, name, plan_json, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)")
    .run(profileId, "Quality Plan", JSON.stringify({ cities: ["广州"] }), now, now).lastInsertRowid);
  const batchId = createBatch(db, "boss", "Python", "legacy-manual");
  const appliedId = upsertJob(db, { ...job({ bossActiveText: "今日活跃" }), ...ready, greeting: "" }, batchId);
  const pendingId = upsertJob(db, {
    ...job({ sourceId: "boss:pending", title: "Python RAG Engineer", bossActiveText: "今日活跃" }),
    ...scoreJob(job({ sourceId: "boss:pending", title: "Python RAG Engineer", bossActiveText: "今日活跃" }), configs),
    greeting: ""
  }, batchId);
  markApplication(db, appliedId, "applied", "already applied");

  const bound = bindBatchToPlan(db, { batchId, planId });
  assert.strictEqual(bound.profileId, profileId);
  assert.strictEqual(bound.migratedStates, 1);
  assert.strictEqual(db.prepare("SELECT profile_id, search_plan_id FROM batches WHERE id = ?").get(batchId).search_plan_id, planId);
  assert.strictEqual(rescorePlanObservations(db, { planId, configs }).rescored, 2);

  const reports = listReportJobs(db, { planId, batch: "latest" });
  assert.strictEqual(reports.find((item) => item.id === appliedId).applicationStatus, "applied");
  assert(listDecisionQueue(db, { planId, limit: 10 }).some((item) => item.id === pendingId));
  assert(!listDecisionQueue(db, { planId, limit: 10 }).some((item) => item.id === appliedId));
} finally {
  db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* Windows can release SQLite late. */ }
  }
}

const preflightDbPath = path.join(tmpDir, `scan-preflight-${Date.now()}.sqlite`);
try {
  const preflight = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "src/cli.js",
    "scan",
    "--db",
    preflightDbPath,
    "--browser",
    "edge",
    "--keywords",
    "Python"
  ], { cwd: root, encoding: "utf8" });
  assert.notStrictEqual(preflight.status, 0);
  assert(/必须传入 --plan/.test(`${preflight.stderr}\n${preflight.stdout}`));
  const preflightDb = openDb(preflightDbPath);
  assert.strictEqual(preflightDb.prepare("SELECT count(*) AS n FROM batches").get().n, 0);
  preflightDb.close();
} finally {
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${preflightDbPath}${suffix}`, { force: true }); } catch { /* no-op */ }
  }
}

browserAllocationSmoke().then(() => {
  console.log("screening_quality_smoke ok");
}).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function browserAllocationSmoke() {
  const cards = (prefix, count, duplicate = false) => Array.from({ length: count }, (_, index) => {
    const id = duplicate && index === 0 ? "same" : `${prefix}-${index}`;
    return {
      title: `${prefix} ${index}`,
      company: "Scan Quality Corp",
      location: "广州",
      salary: "10-15K",
      url: `https://www.zhipin.com/job_detail/${id}.html`,
      cardText: `${prefix} Python RAG`
    };
  });
  const fixtures = {
    RAG: cards("A", 4, true),
    LangChain: cards("B", 5, true),
    Docker: cards("C", 5, true)
  };
  const browser = {
    keyword: "",
    nativeFilterVisits: [],
    async activeTabId() { return "fake-tab"; },
    async navigate(_tabId, url) {
      const parsed = new URL(url);
      this.keyword = parsed.searchParams.get("query");
      this.nativeFilterVisits.push({ salary: parsed.searchParams.get("salary"), experience: parsed.searchParams.get("experience") });
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.cardLimits = [];
  adapter.detailUrls = [];
  adapter.collectCards = async (_tabId, limit) => {
    adapter.cardLimits.push(limit);
    return fixtures[browser.keyword].slice(0, limit);
  };
  adapter.readCardDetail = async (_tabId, job) => {
    const url = job.url;
    adapter.detailUrls.push(url);
    return { description: `职位描述 Python RAG ${url}`, bossActiveText: "今日活跃" };
  };
  adapter.readDetail = async (_tabId, url) => ({ description: `职位描述 Python RAG ${url}`, bossActiveText: "今日活跃" });
  const jobs = await adapter.scanBrowser({
    keywords: ["RAG", "LangChain", "Docker"],
    keywordPlan: [{ word: "RAG", priority: "A" }, { word: "LangChain", priority: "B" }, { word: "Docker", priority: "C" }],
    maxCards: 100,
    maxDetailTotal: 20,
    nativeFilters: splitSalaryLanes,
    scoreQuick: () => 0
  });
  assert.deepStrictEqual(adapter.cardLimits, [100, 100, 65, 65, 40, 40]);
  assert.strictEqual(jobs.length, 12);
  assert.strictEqual(adapter.detailUrls.length, 12);
  assert.strictEqual(new Set(adapter.detailUrls).size, 12);
  assert.strictEqual(adapter.detailUrls.filter((url) => url.includes("same.html")).length, 1);
  assert.deepStrictEqual(browser.nativeFilterVisits.map((item) => item.salary), ["405", "404", "405", "404", "405", "404"]);
  assert(browser.nativeFilterVisits.every((item) => item.experience === "104,105"));
  assert.strictEqual(jobs.filter((job) => job.detailRequired).length, 12);
  assert.strictEqual(jobs.filter((job) => job.detailRead).length, 12);
  const refreshedJobs = await adapter.refreshDetails([{ ...jobs[0], bossActiveText: "", detailRead: false }], { limit: 1 });
  assert.strictEqual(refreshedJobs.length, 1);
  assert.strictEqual(refreshedJobs[0].bossActiveText, "今日活跃");
  assert(refreshedJobs[0].detailRead);

  const visitedCities = [];
  const cityBrowser = {
    cityCode: "",
    async activeTabId() { return "city-tab"; },
    async navigate(_tabId, url) {
      this.cityCode = new URL(url).searchParams.get("city");
      visitedCities.push(this.cityCode);
    }
  };
  const cityAdapter = new BossSiteAdapter({ browser: cityBrowser, sleepFn: async () => {} });
  cityAdapter.assertSearchPage = async () => ({ isSearchPage: true });
  cityAdapter.collectCards = async () => [{
    title: `AI应用开发-${cityBrowser.cityCode}`,
    company: "City Quality Corp",
    location: cityBrowser.cityCode === "101280100" ? "广州" : "深圳",
    salary: "10-12K",
    url: `https://www.zhipin.com/job_detail/city-${cityBrowser.cityCode}.html`,
    cardText: "Python RAG"
  }];
  cityAdapter.readCardDetail = async (_tabId, job) => ({ description: `职位描述 Python RAG ${job.url}`, bossActiveText: "今日活跃" });
  const cityJobs = await cityAdapter.scanBrowser({
    keywords: ["RAG"],
    keywordPlan: [{ word: "RAG", priority: "A" }],
    cityScopes: [{ city: "广州", cityCode: "101280100" }, { city: "深圳", cityCode: "101280600" }],
    maxCards: 20,
    maxDetailTotal: 10,
    scoreQuick: () => 0
  });
  assert.deepStrictEqual(visitedCities, ["101280100", "101280600"]);
  assert.strictEqual(cityJobs.length, 2);
  assert(cityJobs.every((job) => job.detailRead));

  let blockedNavigationCount = 0;
  const pacingAdapter = new BossSiteAdapter({
    browser: { async navigate() { blockedNavigationCount += 1; } },
    sleepFn: async () => {},
    randomFn: () => 0
  });
  pacingAdapter.pageBudget = 20;
  pacingAdapter.listNavigations = 20;
  pacingAdapter.pageNavigations = 20;
  await assert.rejects(
    () => pacingAdapter.navigateWithPacing("pacing-tab", "https://www.zhipin.com/web/geek/jobs", "list"),
    (error) => error.code === "BOSS_PAGE_BUDGET_REACHED"
  );
  assert.strictEqual(blockedNavigationCount, 0);
  await pacingAdapter.navigateWithPacing("pacing-tab", "https://www.zhipin.com/job_detail/quality.html", "detail");
  assert.strictEqual(blockedNavigationCount, 1);

  const syntaxBrowser = {
    async navigate() {},
    async evalValue(_tabId, expression) {
      new Function(expression);
      if (expression.includes("const currentJobId")) {
        return { currentJobId: "syntax", description: "Python RAG ".repeat(20), bossActiveText: "今日活跃" };
      }
      return true;
    }
  };
  const syntaxAdapter = new BossSiteAdapter({ browser: syntaxBrowser, sleepFn: async () => {} });
  syntaxAdapter.assertDetailPage = async () => ({ jobId: "syntax" });
  const syntaxDetail = await syntaxAdapter.readDetail("syntax-tab", "https://www.zhipin.com/job_detail/syntax.html");
  assert.strictEqual(syntaxDetail.bossActiveText, "今日活跃");

  const pacingSleeps = [];
  const pacingAdapterMin = new BossSiteAdapter({ browser: {}, sleepFn: async (delay) => pacingSleeps.push(delay), randomFn: () => 0 });
  const pacingAdapterMax = new BossSiteAdapter({ browser: {}, sleepFn: async (delay) => pacingSleeps.push(delay), randomFn: () => 1 });
  await pacingAdapterMin.waitWithPacing("scroll");
  await pacingAdapterMin.waitWithPacing("target");
  await pacingAdapterMax.waitWithPacing("refresh");
  assert.deepStrictEqual(pacingSleeps, [900, 2500, 2200]);
  const cooldownSleeps = [];
  const periodic = new BossSiteAdapter({ browser: {}, sleepFn: async (delay) => cooldownSleeps.push(delay), randomFn: () => 0 });
  periodic.nextPacingCooldownAt = 1;
  await periodic.waitWithPacing("card");
  assert.deepStrictEqual(cooldownSleeps, [1000, 4000]);
  assert.strictEqual(periodic.nextPacingCooldownAt, 19);

  const detailCooldownSleeps = [];
  const detailPacing = new BossSiteAdapter({ browser: {}, sleepFn: async (delay) => detailCooldownSleeps.push(delay), randomFn: () => 0 });
  detailPacing.nextDetailMicroCooldownAt = 1;
  detailPacing.nextDetailMacroCooldownAt = 99;
  await detailPacing.waitAfterDetailAction();
  assert.deepStrictEqual(detailCooldownSleeps, [7000]);
  detailPacing.detailActions = 31;
  detailPacing.nextDetailMicroCooldownAt = 99;
  detailPacing.nextDetailMacroCooldownAt = 32;
  await detailPacing.waitAfterDetailAction();
  assert.deepStrictEqual(detailCooldownSleeps, [7000, 90000]);
}

function job(overrides = {}) {
  return {
    source: "boss",
    sourceId: "boss:quality",
    keyword: "Python",
    title: "Python RAG Engineer",
    company: "Quality Corp",
    location: "广州",
    salary: "10-16K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    url: "https://www.zhipin.com/job_detail/quality.html",
    tags: ["Python", "RAG"],
    description: "负责企业知识库和 RAG 应用开发。",
    ...overrides
  };
}
