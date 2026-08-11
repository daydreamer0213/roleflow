const assert = require("node:assert/strict");
const {
  applyPlatformRuntimePolicy,
  evaluatePlatformBoundaries
} = require("../src/core/platform_runtime_policy");
const {
  buildAnalysisRevision,
  analysisStaleReasons
} = require("../src/core/analysis_revision");
const { scoreJob, decisionState } = require("../src/core/scoring");
const { decisionBucket } = require("../src/core/storage");

const recommendation = {
  candidateProfile: { candidate: { targetTitles: ["AI应用开发工程师"] } },
  matchingCard: { targetDirections: ["AI应用开发"] },
  searchPlan: {
    cities: ["广州"],
    salary: { minK: 9, maxK: 14 },
    experience: ["经验不限"],
    jobTypes: ["全职"],
    directions: ["AI应用开发"],
    bossActiveDays: 1,
    workSchedulePreference: "prefer_double_weekend",
    excludeWords: ["外包"]
  },
  targetPolicy: { directions: ["AI应用开发"], jobTypes: ["全职"], skills: ["Python"] },
  profile: { location: { target_cities: ["广州"] } },
  scoring: {
    positive_keywords: [{ word: "RAG", weight: 4, label: "RAG" }],
    risk_rules: [{ word: "外包", penalty: 10, risk: "外包风险" }],
    exclude_words: ["外包"],
    boss_activity: { max_active_days: 1, unknown_penalty: 3, inactive_penalty: 10 },
    work_schedule: { preference: "prefer_double_weekend" },
    salary: { mode: "strict", expected_min_k: 9, expected_max_k: 14, hard_max_k: 35 }
  }
};

const narrowAcquisition = {
  site: "boss",
  templateHash: "template-5-10",
  filters: {
    location: { mode: "specific", codes: ["101280100"], cities: ["广州"], districts: [] },
    salary: { codes: ["405"], labels: ["5-10K"], ranges: [{ minK: 5, maxK: 10 }] }
  },
  unresolvedParams: [],
  filterSummary: ["薪资：5-10K"],
  hash: "acquisition-5-10"
};
const inherited = applyPlatformRuntimePolicy(recommendation, narrowAcquisition);
assert.deepStrictEqual(inherited.searchPlan.salary, { minK: 9, maxK: 14 });
assert.deepStrictEqual(inherited.scoring.risk_rules, recommendation.scoring.risk_rules);
assert.deepStrictEqual(inherited.scoring.exclude_words, ["外包"]);
assert.strictEqual(inherited.scoring.boss_activity.max_active_days, 1);
assert.strictEqual(inherited.scoring.work_schedule.preference, "prefer_double_weekend");
assert.deepStrictEqual(inherited.acquisitionPolicy.filters.salary.ranges, [{ minK: 5, maxK: 10 }]);
assert.match(inherited.acquisitionPolicyHash, /^[a-f0-9]{64}$|^acquisition-5-10$/);

const strictBoundary = evaluatePlatformBoundaries({ salary: "5-10K" }, narrowAcquisition);
assert(strictBoundary.qualityTags.includes("platform_salary_unverified") === false);
const revision = buildAnalysisRevision(inherited, "job-source-1");
assert.deepStrictEqual(analysisStaleReasons({ revision }, buildAnalysisRevision(inherited, "job-source-1")), []);
for (const changedRecommendation of [
  { searchPlan: { ...recommendation.searchPlan, salary: { minK: 5, maxK: 10 } } },
  { scoring: { ...recommendation.scoring, salary: { ...recommendation.scoring.salary, expected_min_k: 10 } } },
  { targetPolicy: { ...recommendation.targetPolicy, directions: ["平台运营"] } }
]) {
  const changed = applyPlatformRuntimePolicy({ ...recommendation, ...changedRecommendation }, narrowAcquisition);
  assert.notStrictEqual(
    buildAnalysisRevision(changed, "job-source-1").searchPlanVersion,
    revision.searchPlanVersion
  );
}
const changedAcquisition = applyPlatformRuntimePolicy(recommendation, {
  ...narrowAcquisition,
  hash: "acquisition-10-20",
  filters: { ...narrowAcquisition.filters, salary: { codes: ["406"], labels: ["10-20K"], ranges: [{ minK: 10, maxK: 20 }] } }
});
assert.strictEqual(changedAcquisition.recommendationPolicyHash, inherited.recommendationPolicyHash);
assert.notStrictEqual(changedAcquisition.acquisitionPolicyHash, inherited.acquisitionPolicyHash);
assert.deepStrictEqual(
  analysisStaleReasons({ revision }, buildAnalysisRevision(changedAcquisition, "job-source-1")),
  []
);

const knownSalaryBoundaryCases = ["5-6K", "5-7K", "6-7K", "6-8K", "7-8K", "8-8K"];
const replay104 = {
  batchId: "gate-a-task-1-deterministic-104",
  source: "offline-fixture",
  jobs: Array.from({ length: 104 }, (_, index) => ({
    sourceId: `replay-${String(index + 1).padStart(3, "0")}`,
    salary: knownSalaryBoundaryCases[index] || "9-14K",
    title: "AI应用开发工程师",
    location: "广州"
  }))
};
assert.strictEqual(replay104.jobs.length, 104);
const replayResults = replay104.jobs.map((job) => scoreJob(job, inherited));
const boundaryResults = replayResults.filter((result) => result.qualityTags.includes("salary_out_of_range"));
assert.strictEqual(replayResults.length, 104);
assert.strictEqual(boundaryResults.length, 6);
assert(boundaryResults.every((result) => result.qualityTags.includes("salary_out_of_range")));
assert(boundaryResults.every((result) => decisionState(result) === "blocked"));
assert(boundaryResults.every((result) => !["primary", "apply", "caution"].includes(
  decisionBucket({
    ...result,
    analysis: { semanticStatus: "complete", recommendation: "apply" }
  })
)));
console.log(JSON.stringify({ replay: replay104.batchId, jobs: replay104.jobs.length, boundaryCases: boundaryResults.length }));

console.log("analysis_revision_smoke ok");
