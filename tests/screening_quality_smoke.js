const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  normalizeBossUrl,
  cleanDetailText,
  parseBossActivityText,
  BossSiteAdapter,
  weightedCardLimit,
  detailQuotas,
  mergeScanCandidate,
  selectDetailCandidates
} = require("../src/adapters/sites/boss");
const { scoreJob, decisionState, activeDays } = require("../src/core/scoring");
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
  decisionBucket
} = require("../src/core/storage");

const root = path.resolve(__dirname, "..");
const tmpDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(tmpDir, `screening-quality-${Date.now()}.sqlite`);
fs.mkdirSync(tmpDir, { recursive: true });

assert.strictEqual(normalizeBossUrl("https://www.zhipin.com/job_detail/abc123.html?ka=search"), "https://www.zhipin.com/job_detail/abc123.html");
assert.strictEqual(normalizeBossUrl("javascript:;"), "");
assert.strictEqual(normalizeBossUrl("https://www.zhipin.com/web/geek/jobs"), "");
assert.strictEqual(parseBossActivityText("负责在线客服系统集成"), "");
assert.strictEqual(parseBossActivityText("梁子其 近半年活跃"), "近半年活跃");
assert.strictEqual(activeDays("近半年活跃"), 180);
assert.strictEqual(parseBossActivityText("许女士 在线 网思科技"), "在线");
assert.strictEqual(weightedCardLimit("A", 100), 100);
assert.strictEqual(weightedCardLimit("B", 100), 65);
assert.strictEqual(weightedCardLimit("C", 100), 40);
assert.deepStrictEqual(detailQuotas([{ priority: "A" }, { priority: "B" }, { priority: "C" }], 20), { A: 20, B: 11, C: 5 });

const scanCandidates = new Map();
const scanJob = (id) => ({ source: "boss", url: `https://www.zhipin.com/job_detail/${id}.html`, title: id, company: "Quality Corp" });
mergeScanCandidate(scanCandidates, { job: scanJob("same"), keyword: "Docker", priority: "C", keywordOrder: 2, index: 0, quickScore: 10 });
mergeScanCandidate(scanCandidates, { job: scanJob("same"), keyword: "RAG", priority: "A", keywordOrder: 0, index: 1, quickScore: 8 });
for (let index = 0; index < 4; index += 1) mergeScanCandidate(scanCandidates, { job: scanJob(`b-${index}`), keyword: "LangChain", priority: "B", keywordOrder: 1, index, quickScore: 20 - index });
for (let index = 0; index < 4; index += 1) mergeScanCandidate(scanCandidates, { job: scanJob(`c-${index}`), keyword: "Docker", priority: "C", keywordOrder: 2, index, quickScore: 20 - index });
assert.strictEqual(scanCandidates.size, 9);
assert.strictEqual(scanCandidates.get("boss:same").priority, "A");
assert.deepStrictEqual(scanCandidates.get("boss:same").keywords.sort(), ["Docker", "RAG"]);
const detailSelection = selectDetailCandidates([...scanCandidates.values()], [{ word: "RAG", priority: "A" }, { word: "LangChain", priority: "B" }, { word: "Docker", priority: "C" }], { detailLimit: 4, maxDetailTotal: 20 });
assert.strictEqual(detailSelection.filter((item) => item.priority === "A").length, 1);
assert.strictEqual(detailSelection.filter((item) => item.priority === "B").length, 3);
assert.strictEqual(detailSelection.filter((item) => item.priority === "C").length, 1);
assert(!cleanDetailText("职位描述 负责 Python 开发 BOSS安全提示 求职安全提醒").includes("BOSS安全提示"));

const configs = {
  profile: { location: { target_cities: ["广州"] } },
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
assert.strictEqual(decisionBucket({ ...ready, level: "可投", qualityTags: ["work_schedule_unknown"], risks: [], analysis: {} }), "primary");

const unknown = scoreJob(job({ bossActiveText: "" }), configs);
assert.strictEqual(decisionState(unknown), "refresh");
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
const overRange = scoreJob(job({ experience: "5-10年", salary: "10-12K" }), scopedConfigs);
assert(overRange.qualityTags.includes("experience_overrange"));
assert.strictEqual(decisionBucket({ ...overRange, analysis: {} }), "backup");
const strictSalary = scoreJob(job({ experience: "0-3年", salary: "15-20K" }), scopedConfigs);
assert.strictEqual(decisionState(strictSalary), "blocked");

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

const wrongRole = scoreJob(job({ title: "AI 培训讲师", bossActiveText: "今日活跃" }), configs);
assert.strictEqual(decisionState(wrongRole), "blocked");
const internshipRole = scoreJob(job({ title: "大模型应用开发实习生", bossActiveText: "今日活跃" }), configs);
assert(internshipRole.qualityTags.includes("internship_role"));
assert.strictEqual(decisionState(internshipRole), "blocked");
const algorithmRole = scoreJob(job({ title: "RAG 算法工程师", bossActiveText: "今日活跃" }), configs);
assert(algorithmRole.qualityTags.includes("algorithm_role"));
assert.strictEqual(decisionState(algorithmRole), "blocked");
const hybridRole = scoreJob(job({ title: "AI Agent 开发工程师", bossActiveText: "今日活跃", description: "负责 Agent 应用开发和 RAG，参与模型训练、算法研究。" }), configs);
assert(hybridRole.qualityTags.includes("algorithm_hybrid"));
assert.strictEqual(decisionState(hybridRole), "ready");
assert(!cleanDetailText("职位描述 负责 Python 开发。公司介绍 这部分不是 JD").includes("公司介绍"));
assert.strictEqual(normalizeSearchPlan({}, { candidate: { city: "广州" } }).workSchedulePreference, "prefer_double_weekend");

const db = openDb(dbPath);
try {
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
    async activeTabId() { return "fake-tab"; },
    async navigate(_tabId, url) { this.keyword = new URL(url).searchParams.get("query"); }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  adapter.cardLimits = [];
  adapter.detailUrls = [];
  adapter.collectCards = async (_tabId, limit) => {
    adapter.cardLimits.push(limit);
    return fixtures[browser.keyword].slice(0, limit);
  };
  adapter.readDetail = async (_tabId, url) => {
    adapter.detailUrls.push(url);
    return { description: `职位描述 Python RAG ${url}`, bossActiveText: "今日活跃" };
  };
  const jobs = await adapter.scanBrowser({
    keywords: ["RAG", "LangChain", "Docker"],
    keywordPlan: [{ word: "RAG", priority: "A" }, { word: "LangChain", priority: "B" }, { word: "Docker", priority: "C" }],
    maxCards: 100,
    detailLimit: 4,
    maxDetailTotal: 20,
    scoreQuick: () => 0
  });
  assert.deepStrictEqual(adapter.cardLimits, [100, 65, 40]);
  assert.strictEqual(jobs.length, 12);
  assert.strictEqual(adapter.detailUrls.length, 8);
  assert.strictEqual(new Set(adapter.detailUrls).size, 8);
  assert.strictEqual(adapter.detailUrls.filter((url) => url.includes("same.html")).length, 1);
  assert(jobs.every((job) => job.detailRequired));
  assert.strictEqual(jobs.filter((job) => job.detailRead).length, 8);

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
  cityAdapter.collectCards = async () => [{
    title: `AI应用开发-${cityBrowser.cityCode}`,
    company: "City Quality Corp",
    location: cityBrowser.cityCode === "101280100" ? "广州" : "深圳",
    salary: "10-12K",
    url: `https://www.zhipin.com/job_detail/city-${cityBrowser.cityCode}.html`,
    cardText: "Python RAG"
  }];
  cityAdapter.readDetail = async (_tabId, url) => ({ description: `职位描述 Python RAG ${url}`, bossActiveText: "今日活跃" });
  const cityJobs = await cityAdapter.scanBrowser({
    keywords: ["RAG"],
    keywordPlan: [{ word: "RAG", priority: "A" }],
    cityScopes: [{ city: "广州", cityCode: "101280100" }, { city: "深圳", cityCode: "101280600" }],
    maxCards: 20,
    detailLimit: 1,
    maxDetailTotal: 10,
    scoreQuick: () => 0
  });
  assert.deepStrictEqual(visitedCities, ["101280100", "101280600"]);
  assert.strictEqual(cityJobs.length, 2);
  assert(cityJobs.every((job) => job.detailRead));
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
