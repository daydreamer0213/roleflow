const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  openDb,
  createBatch,
  upsertJob,
  listDecisionPool,
  listReportJobs,
  saveProfileAnalysis,
  isJobAwaitingAction,
  isActivityProbeDue
} = require("../src/core/storage");
const { classifyExperienceFit } = require("../src/core/scoring");
const { handleMarkApi, renderQueuePage } = require("../src/dashboard/server");

const root = path.resolve(__dirname, "..");
const dbPath = path.join(root, ".runtime", "smoke", `data-visibility-${Date.now()}.sqlite`);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

try {
  const { profileId, planId } = saveProfileAnalysis(db, {
    profile: { candidate: { name: "Visibility Test", targetTitles: ["AI应用开发"] }, skills: [], projects: [] },
    document: {
      originalFileName: "visibility.txt",
      format: "text",
      contentHash: "visibility-profile",
      text: "visibility test",
      diagnostics: {}
    },
    searchPlan: { name: "Visibility Plan", cities: ["广州"], keywords: [{ word: "RAG", priority: "A" }] }
  });

  uniqueJobsBeforeLimitSmoke({ profileId, planId });
  contentHashSmoke({ profileId, planId });
  activitySnapshotSmoke({ profileId, planId });
  experiencePrioritySmoke();
  queueUiSmoke({ profileId, planId });
  assert.strictEqual(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  console.log("data_visibility_smoke ok");
} finally {
  db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* no-op */ }
  }
}

function uniqueJobsBeforeLimitSmoke({ profileId, planId }) {
  const oldBatch = createBatch(db, "boss", "old-unique", "visibility-old", { profileId, searchPlanId: planId });
  for (let index = 0; index < 120; index += 1) {
    upsertJob(db, job(`old-${index}`, { title: `历史未处理 ${index}` }), oldBatch);
  }

  for (let round = 0; round < 55; round += 1) {
    const batchId = createBatch(db, "boss", "repeat", `visibility-repeat-${round}`, { profileId, searchPlanId: planId });
    for (let index = 0; index < 10; index += 1) {
      upsertJob(db, job(`repeat-${index}`, { salary: `${10 + round}-${15 + round}K` }), batchId);
    }
  }

  assert(db.prepare("SELECT COUNT(*) AS count FROM job_observations").get().count > 500);
  const pool = listDecisionPool(db, { planId });
  assert.strictEqual(pool.length, 130, "重复 observation 不得挤掉唯一岗位");
  assert(pool.some((item) => item.sourceId === "old-119"), "历史未处理岗位必须仍可见");
  assert.strictEqual(pool.find((item) => item.sourceId === "repeat-0").salary, "64-69K", "应选择该岗位最新 observation");
}

function contentHashSmoke({ profileId, planId }) {
  const first = createBatch(db, "boss", "hash", "hash-first", { profileId, searchPlanId: planId });
  const jobId = upsertJob(db, job("hash-stable", { score: 10, analysis: { provider: "model-a", recommendation: "caution" } }), first);
  const second = createBatch(db, "boss", "hash", "hash-model-change", { profileId, searchPlanId: planId });
  upsertJob(db, job("hash-stable", { score: 99, analysis: { provider: "model-b", recommendation: "apply" } }), second);
  let current = listReportJobs(db, { planId, limit: 1000 }).find((item) => item.id === jobId);
  assert.strictEqual(current.detailChanged, false, "仅模型结果或分数变化不得冒充 JD 变化");

  const third = createBatch(db, "boss", "hash", "hash-source-change", { profileId, searchPlanId: planId });
  upsertJob(db, job("hash-stable", { salary: "12-18K", score: 99, analysis: { provider: "model-b", recommendation: "apply" } }), third);
  current = listReportJobs(db, { planId, limit: 1000 }).find((item) => item.id === jobId);
  assert.strictEqual(current.detailChanged, true, "平台薪资或 JD 变化必须可见");
  assert(db.prepare("SELECT COUNT(*) AS count FROM job_observations WHERE job_id = ? AND content_hash_version = 1").get(jobId).count >= 3);
}

function activitySnapshotSmoke({ profileId, planId }) {
  const batchId = createBatch(db, "boss", "activity", "activity-aging", { profileId, searchPlanId: planId });
  const jobId = upsertJob(db, job("activity-old", { bossActiveText: "今日活跃", bossActiveDays: 0 }), batchId);
  const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE job_observations SET seen_at = ? WHERE job_id = ?").run(old, jobId);
  const current = listReportJobs(db, { planId, limit: 1000 }).find((item) => item.id === jobId);
  assert(current.qualityTags.includes("activity_snapshot_aged"));
  assert(current.qualityTags.includes("stale_or_unknown_active"));
  assert.strictEqual(current.effectiveBossActiveDays, 5);
  assert.strictEqual(current.decisionBucket, "refresh");
  assert.strictEqual(isActivityProbeDue(current), true, "原来 3 日内活跃、因快照老化失效的岗位应进入探针");
  assert.strictEqual(isActivityProbeDue({ ...current, refreshNextRetryAt: new Date(Date.now() + 60_000).toISOString() }), false, "冷却期内不得重复探测");
  assert.strictEqual(isActivityProbeDue({ ...current, bossActiveDays: 7, effectiveBossActiveDays: 12 }), false, "采集时已是周内活跃的岗位不得进入探针");
  assert.strictEqual(isActivityProbeDue({ ...current, bossActiveDays: 30, effectiveBossActiveDays: 35 }), false, "采集时已是月内活跃的岗位不得进入探针");
  assert.strictEqual(isActivityProbeDue({ ...current, bossActiveDays: 180, effectiveBossActiveDays: 185 }), false, "采集时已是近半年活跃的岗位不得进入探针");
}

function experiencePrioritySmoke() {
  const policy = { selected: ["经验不限", "1-3年", "3-5年"], allowStretch: true };
  const structured = classifyExperienceFit({
    experience: "1-3年",
    tags: ["本科"],
    description: "公司产品已有 5 年历史，负责人具备 8 年行业经验。"
  }, policy);
  assert.strictEqual(structured.inScope, true);
  assert.strictEqual(structured.overRange, false);

  const fallback = classifyExperienceFit({
    experience: "",
    tags: ["本科"],
    description: "职位描述。任职要求：至少 5 年 Python 后端开发经验，熟悉 RAG。"
  }, policy);
  assert.strictEqual(fallback.overRange, true);

  const irrelevant = classifyExperienceFit({
    experience: "",
    tags: ["本科"],
    description: "公司成立 5 年，产品服务企业客户。"
  }, policy);
  assert.strictEqual(irrelevant.overRange, false);
  assert.strictEqual(irrelevant.outOfScope, false);
}

function queueUiSmoke({ profileId, planId }) {
  const latestBatchId = createBatch(db, "boss", "latest-main", "queue-scope", { profileId, searchPlanId: planId });
  const newJobId = upsertJob(db, job("latest-new", { title: "本轮新增岗位" }), latestBatchId);
  upsertJob(db, job("old-0", { title: "本轮再次出现岗位" }), latestBatchId);
  const lastPage = renderQueuePage({ db, searchParams: new URLSearchParams({ planId: String(planId), pool: "talk", scope: "all", page: "5" }) });
  assert(lastPage.includes("当前待处理岗位"));
  assert(lastPage.includes("当前显示 121-131 / 共 131 条"));
  assert(lastPage.includes("上一页"));
  assert(lastPage.includes("本轮新增 1"));
  assert(lastPage.includes("本轮重复 1"));
  assert(lastPage.includes("历史未处理 131"));

  const newest = renderQueuePage({ db, searchParams: new URLSearchParams({ planId: String(planId), pool: "talk", scope: "new" }) });
  assert(newest.includes("本轮新增岗位"));
  assert(newest.includes("首次 "));
  assert(newest.includes("最近 "));
  assert(newest.includes("7 天后再看"));

  const repeated = renderQueuePage({ db, searchParams: new URLSearchParams({ planId: String(planId), pool: "talk", scope: "repeated" }) });
  assert(repeated.includes("本轮再次出现岗位"));

  const mark = handleMarkApi(db, JSON.stringify({ jobId: newJobId, profileId, planId, status: "later" }));
  assert.strictEqual(mark.statusCode, 200);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(mark.body.reviewAt));
  const stored = listReportJobs(db, { planId, limit: 1000 }).find((item) => item.id === newJobId);
  assert.strictEqual(isJobAwaitingAction(stored), false, "7 天后再看必须立即移出当前待处理队列");
}

function job(sourceId, overrides = {}) {
  return {
    source: "boss",
    sourceId,
    keyword: "RAG",
    title: "AI应用开发工程师",
    company: "Visibility Corp",
    location: "广州",
    salary: "10-15K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
    tags: ["Python", "RAG"],
    description: "任职要求：1-3 年 Python 开发经验，熟悉 RAG 与 Agent。",
    score: 50,
    level: "可投",
    matches: ["RAG"],
    risks: [],
    qualityTags: [],
    greeting: "",
    analysis: { provider: "mock", recommendation: "caution" },
    ...overrides
  };
}
