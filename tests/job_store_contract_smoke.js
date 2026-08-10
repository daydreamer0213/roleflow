const assert = require("node:assert");

const JOB_EXPORTS = [
  "upsertKeywordSource", "upsertJob", "listReportJobs", "markApplication", "bindBatchToPlan",
  "rescorePlanObservations", "reassessBatchObservations", "addFollowUpNote", "recordCandidateJobEvent",
  "listCandidateJobEvents", "recordRecommendationFeedback", "markCandidateJob", "buildFeedbackSummary",
  "buildBatchSummary", "getLatestBatchId", "getLatestMainScanBatchId", "listDecisionPool",
  "getOutcomeAnalyticsSnapshot", "listDecisionQueue", "isJobAwaitingAction", "decisionBucket",
  "applyJobQualityGovernance", "isActivityProbeDue", "sourceContentHash", "getModelCache", "saveModelCache"
].sort();

const CANDIDATE_EXPORTS = [
  "saveProfileAnalysis", "attachResumeDocumentFile", "getResumeDocument", "saveSearchPlan", "getCandidateProfile",
  "listCandidateProfiles", "saveCandidateResumeVersion", "listCandidateResumeVersions", "listMatchingResumeVersions",
  "recordResumeParseAttempt", "listResumeParseAttempts", "updateCandidateProfile", "getSearchPlan",
  "getActiveSearchPlan", "listSearchPlans", "listProfileVersions", "getLatestProfileVersionId",
  "getSearchPlanDependency", "getMatchingCard", "getActiveMatchingCard", "listMatchingCards",
  "createMatchingCardDraft", "confirmMatchingCard", "saveMatchingCardDraftEdit", "saveConfirmedMatchingCardRevision",
  "getCandidateMatchingContext", "compareProfileVersions", "saveCandidateFact", "listCandidateFacts"
].sort();

const warnings = [];
const onWarning = (warning) => warnings.push(warning);
process.on("warning", onWarning);
const jobStore = require("../src/storage/job_store");
const candidateStore = require("../src/storage/candidate_store");
const storage = require("../src/core/storage");
process.removeListener("warning", onWarning);

assert.strictEqual(JOB_EXPORTS.length, 26);
assert.strictEqual(CANDIDATE_EXPORTS.length, 29);
assert.strictEqual(Object.keys(storage).length, 136);
assert.deepStrictEqual(Object.keys(jobStore).sort(), JOB_EXPORTS);
assert.deepStrictEqual(Object.keys(candidateStore).sort(), CANDIDATE_EXPORTS);
for (const name of JOB_EXPORTS) assert.strictEqual(storage[name], jobStore[name], `${name} must be a direct facade reference`);
for (const name of CANDIDATE_EXPORTS) assert.strictEqual(storage[name], candidateStore[name], `${name} must remain a direct facade reference`);
assert.strictEqual(warnings.filter((warning) => /circular/i.test(warning.message)).length, 0, "facade and direct stores must load without circular warnings");

const db = storage.openDb(":memory:");
try {
  jobStore.upsertKeywordSource(db, "AI", "smoke");
  jobStore.saveModelCache(db, { cacheKey: "smoke", kind: "job", provider: "test", model: "test", inputHash: "one", result: { first: true } });
  jobStore.saveModelCache(db, { cacheKey: "smoke", kind: "job", provider: "test", model: "test", inputHash: "two", result: { second: true } });
  assert.deepStrictEqual(jobStore.getModelCache(db, "smoke").result, { second: true });
  db.prepare("UPDATE model_cache SET result_json = 'bad json' WHERE cache_key = 'smoke'").run();
  assert.deepStrictEqual(jobStore.getModelCache(db, "smoke").result, {});

  const batchId = storage.createBatch(db, "boss", "AI", "job-store contract");
  db.exec("BEGIN IMMEDIATE");
  const jobId = jobStore.upsertJob(db, {
    source: "boss", sourceId: "job-store-contract", keyword: "AI", title: "Product Manager", company: "RoleFlow",
    location: "Shanghai", salary: "25k", experience: "3 years", education: "Bachelor", tags: ["AI"],
    description: "A complete job description for the job storage contract smoke test.", url: "https://example.invalid/job-store-contract"
  }, batchId);
  db.exec("COMMIT");
  assert.strictEqual(jobStore.upsertJob(db, { source: "boss", sourceId: "job-store-contract", title: "Product Manager", company: "RoleFlow" }, batchId), jobId);
  const report = jobStore.listReportJobs(db, { batch: "all" });
  assert.strictEqual(report.length, 1);
  assert.strictEqual(report[0].sourceId, "job-store-contract");
  assert.strictEqual(report[0].previousContentHash, "");
  assert.strictEqual(jobStore.sourceContentHash(report[0]).length, 64);

  const governed = jobStore.applyJobQualityGovernance([{ ...report[0], analysis: { semanticStatus: "complete", recommendation: "recommended", recommendationSchemaVersion: 2 }, lastSeenAt: "2026-08-01T00:00:00.000Z", bossActiveDays: 1 }], { now: "2026-08-05T00:00:00.000Z" });
  assert.deepStrictEqual(governed[0].qualityTags.slice(-2), ["activity_snapshot_aged", "stale_or_unknown_active"]);
  assert.strictEqual(jobStore.decisionBucket({ ...governed[0], analysis: { semanticStatus: "failed" } }), "refresh");
  assert.strictEqual(jobStore.decisionBucket({ ...governed[0], analysis: { semanticStatus: "complete", hardBlockers: ["blocker"] } }), "refresh");
  assert.strictEqual(jobStore.isActivityProbeDue(governed[0], { now: Date.parse("2026-08-05T00:00:00.000Z") }), true);
} finally {
  db.close();
}

console.log("job_store_contract_smoke ok");
