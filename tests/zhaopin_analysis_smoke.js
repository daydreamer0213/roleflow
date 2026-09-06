const assert = require("node:assert/strict");
const { openDb, saveProfileAnalysis, createBatch, upsertJob, listReportJobs, createWorkflowRun, transitionWorkflowRun, getWorkflowObservationJob } = require("../src/core/storage");
const { scoreJob, salaryRangeK, decisionState } = require("../src/core/scoring");
const { jobFacts } = require("../src/core/job_analysis");
const { sourceContentHash } = require("../src/storage/job_store");
const { canonicalizeZhaopinSearchTemplate, buildZhaopinSearchUrl } = require("../src/core/zhaopin_search_scope");
const { buildInheritedSearchScope, assertCompleteInheritedContext, freezeKeywordSource } = require("../src/core/inherited_search_scope");
const { buildScanExecutionSnapshot } = require("../src/core/scan_snapshot");
const { compileZhaopinPlatformRuntimePolicy } = require("../src/core/platform_runtime_policy");

const nativeTemplate = canonicalizeZhaopinSearchTemplate("https://www.zhaopin.com/jobs/?pageMode=search&jl=548&sl=10001,15000&el=4&we=0103&ct=5&cs=3&et=2&kw=旧关键词");
assert.deepEqual(new URL(buildZhaopinSearchUrl({ searchTemplate: nativeTemplate, keyword: "新关键词" })).searchParams.getAll("we"), ["0103"]);
assert.equal(new URL(buildZhaopinSearchUrl({ searchTemplate: nativeTemplate, keyword: "新关键词" })).searchParams.get("ct"), "5");
assert.equal(new URL(buildZhaopinSearchUrl({ searchTemplate: nativeTemplate, keyword: "新关键词" })).searchParams.get("cs"), "3");
assert.equal(new URL(buildZhaopinSearchUrl({ searchTemplate: nativeTemplate, keyword: "新关键词" })).searchParams.get("et"), "2");
const zhaopinScope = buildInheritedSearchScope({ profileId: 7, site: "zhaopin", rawUrl: nativeTemplate.url });
const zhaopinKeywordSource = freezeKeywordSource({ planRecord: { id: 9, profileVersionId: 10, plan: { keywords: [{ word: "新关键词", priority: "A" }] } }, matchingCardRevision: "card-zl" });
assert.doesNotThrow(() => assertCompleteInheritedContext({
  searchTemplate: zhaopinScope.searchTemplate,
  searchScope: zhaopinScope.searchScope,
  keywordSource: zhaopinKeywordSource,
  platformPolicy: { site: "zhaopin", templateHash: zhaopinScope.searchScope.templateHash, hash: "policy-zl", filters: {}, unresolvedParams: [], filterSummary: ["原生条件"] }
}, { planId: 9 }));
assert.throws(() => require("../src/core/workflow_acquisition").assertAcquisitionContext({
  acquisitionMode: "inherited", site: "boss", searchTemplate: zhaopinScope.searchTemplate, searchScope: zhaopinScope.searchScope,
  keywordSource: zhaopinKeywordSource,
  platformPolicy: { site: "zhaopin", templateHash: zhaopinScope.searchScope.templateHash, hash: "policy-zl", filters: {}, unresolvedParams: [], filterSummary: [] }
}, { planId: 9 }), (error) => error.code === "WORKFLOW_ACQUISITION_SITE_MISMATCH");
assert.deepEqual(compileZhaopinPlatformRuntimePolicy({ searchScope: zhaopinScope.searchScope, filterSummary: ["广东", "1-3年"] }), {
  site: "zhaopin",
  templateHash: zhaopinScope.searchScope.templateHash,
  filters: {
    location: { mode: "native", codes: ["548"], cities: [], districts: [] },
    salary: { codes: [], labels: [] }, experience: { codes: [], labels: [] }, degree: { codes: [], labels: [] }, jobType: { codes: [], labels: [] },
    acquisitionOnly: { native: { codes: ["cs=3", "ct=5", "el=4", "et=2", "jl=548", "sl=10001,15000", "we=0103"], labels: [] } }
  },
  unresolvedParams: [],
  filterSummary: ["广东", "1-3年"],
  hash: compileZhaopinPlatformRuntimePolicy({ searchScope: zhaopinScope.searchScope, filterSummary: ["广东", "1-3年"] }).hash
});
assert.deepEqual(buildScanExecutionSnapshot({
  site: "zhaopin", searchTemplate: zhaopinScope.searchTemplate, searchScope: zhaopinScope.searchScope,
  keywordSource: zhaopinKeywordSource, platformPolicy: { site: "zhaopin" }, keywordPlan: zhaopinKeywordSource.keywords,
  limits: { maxCards: 11 }
}).targets, [{ targetKey: "zhaopin:548:新关键词:A:1", cityCode: "548", keyword: "新关键词", priority: "A", laneId: "native", cardLimit: 11 }]);

assert.deepEqual(salaryRangeK("1.5-1.6万·13薪"), { min: 15, max: 16 });
assert.deepEqual(salaryRangeK("8000-15000元"), { min: 8, max: 15 });
assert.deepEqual(salaryRangeK("10-20K·13薪"), { min: 10, max: 20 });
assert.deepEqual(salaryRangeK("20-30万/年"), { min: null, max: null });
assert.deepEqual(salaryRangeK("150-200元/时"), { min: null, max: null });
assert.deepEqual(salaryRangeK("150-200元/小时"), { min: null, max: null });
assert.deepEqual(salaryRangeK("1万-1.5万/月"), { min: 10, max: 15 });
assert.deepEqual(salaryRangeK("10K-**K"), { min: null, max: null });
assert.deepEqual(salaryRangeK("**-15K"), { min: null, max: null });
assert.deepEqual(salaryRangeK("10K-20**K"), { min: null, max: null });
assert.deepEqual(salaryRangeK("300-400元 天薪"), { min: null, max: null });
assert.deepEqual(salaryRangeK("面议"), { min: null, max: null });

const configs = {
  candidateProfile: { candidate: { targetTitles: ["AI应用开发"] } },
  targetPolicy: { directions: ["AI应用开发"], jobTypes: ["全职"] },
  profile: { location: { target_cities: ["广州"] } },
  platformPolicy: {},
  scoring: { positive_keywords: [], risk_rules: [], exclude_words: [], boss_activity: { max_active_days: 3, unknown_penalty: 3, inactive_penalty: 10 }, salary: { expected_min_k: 10 }, experience: {} }
};
const zhaopinScore = scoreJob({ source: "zhaopin", title: "AI应用开发", company: "发布方", salary: "8000-15000元", location: "广州", url: "https://www.zhaopin.com/jobdetail/CCSYNTH001J00000000001.htm", description: "完整岗位职责".repeat(20) }, configs);
assert.equal(zhaopinScore.qualityTags.includes("activity_unverified"), false);
assert.equal(zhaopinScore.qualityTags.includes("inactive_boss"), false);
assert.equal(decisionState(zhaopinScore), "ready");
const hourlyScore = scoreJob({ source: "zhaopin", title: "AI兼职", company: "发布方", salary: "150-200元/小时", location: "广州", tags: ["兼职"], url: "https://www.zhaopin.com/jobdetail/CCSYNTH002J00000000002.htm", description: "完整岗位职责".repeat(20) }, configs);
assert.equal(hourlyScore.qualityTags.includes("part_time_role"), true);
assert.equal(hourlyScore.qualityTags.includes("salary_unverified"), true);

const legacyHash = sourceContentHash({ title: "岗位", company: "发布方", location: "广州", salary: "10K", experience: "1-3年", education: "本科", tags: [], description: "职责" });
assert.equal(sourceContentHash({ title: "岗位", company: "发布方", location: "广州", salary: "10K", experience: "1-3年", education: "本科", tags: [], description: "职责", clientCompany: "" }), legacyHash);
assert.notEqual(sourceContentHash({ title: "岗位", company: "发布方", location: "广州", salary: "10K", experience: "1-3年", education: "本科", tags: [], description: "职责", clientCompany: "客户公司" }), legacyHash);
assert.equal(jobFacts({ company: "发布方", clientCompany: "客户公司" }).clientCompany, "客户公司");
assert.equal(Object.hasOwn(jobFacts({ company: "发布方" }), "clientCompany"), false);

const db = openDb(":memory:");
try {
  const saved = saveProfileAnalysis(db, {
    profile: { candidate: { name: "分析隔离", city: "广州", targetTitles: ["AI应用开发"] }, skills: [], projects: [] },
    document: { originalFileName: "analysis.txt", format: "text", contentHash: "analysis-v1", text: "resume", diagnostics: {} },
    searchPlan: { name: "分析方案", cities: ["广州"], keywords: ["AI应用"] }
  });
  const batchId = createBatch(db, "zhaopin", "AI应用", "analysis", { profileId: saved.profileId, searchPlanId: saved.planId, filterSnapshot: { execution: {} } });
  const jobId = upsertJob(db, { source: "zhaopin", sourceId: "CCSYNTH003J00000000003", keyword: "AI应用", title: "AI应用开发", company: "发布方", clientCompany: "客户公司", location: "广州", salary: "1.5-1.6万·13薪", tags: [], description: "完整岗位职责".repeat(20) }, batchId);
  const stored = listReportJobs(db, { batchId })[0];
  assert.equal(stored.id, jobId);
  assert.equal(stored.company, "发布方");
  assert.equal(stored.clientCompany, "客户公司");
  assert.equal(getWorkflowObservationJob(db, stored.observationId).clientCompany, "客户公司");
  createWorkflowRun(db, { id: "zhaopin-analysis", profileId: saved.profileId, planId: saved.planId, localDay: "2026-09-06", sequence: 1, site: "zhaopin" });
  transitionWorkflowRun(db, { id: "zhaopin-analysis", status: "scanning" });
  transitionWorkflowRun(db, { id: "zhaopin-analysis", status: "analyzing" });
  assert.equal(transitionWorkflowRun(db, { id: "zhaopin-analysis", status: "completed" }).status, "completed");
} finally {
  db.close();
}

console.log("zhaopin_analysis_smoke ok");
