const {
  createBatch,
  upsertJob,
  getSearchPlan,
  listMatchingResumeVersions,
  getSearchPlanDependency,
  getCandidateMatchingContext,
  listDecisionPool,
  isJobAwaitingAction
} = require("../../core/storage");
const { profileToRuntimeConfigs } = require("../../core/search_plan");
const { loadConfigs } = require("../../config");
const { appError } = require("../../core/observability");
const { PRODUCT_POLICY } = require("../../core/product_policy");
const { scoreJob, decisionState } = require("../../core/scoring");
const { createJobAnalysisRunner } = require("../../core/job_analysis");
const { mapWithConcurrency } = require("../../core/async_pool");
const { reconcilePlanWorkflowInventory } = require("../../core/workflow_inventory");

function retryOneJobAnalysis({ db, input = {}, deps = {} }) {
  return retryJobAnalyses({ db, input, deps, bulk: false });
}

function retryPendingJobAnalyses({ db, input = {}, deps = {} }) {
  return retryJobAnalyses({ db, input, deps, bulk: true });
}

async function retryJobAnalyses({ db, input, deps, bulk }) {
  if (!deps.modelReady) {
    throw appError(
      "MODEL_CONFIGURATION_REQUIRED",
      "重试语义分析前，请先完成批量筛选模型连接测试。",
      { statusCode: 409 }
    );
  }
  const planId = Number(input.planId);
  const plan = getSearchPlan(db, planId);
  if (!plan) throw new Error("Search Plan 不存在。");
  const matchingContext = getCandidateMatchingContext(db, plan.profileId);
  if (!matchingContext) {
    throw appError("MATCHING_CARD_CONFIRMATION_REQUIRED", "重试语义分析前，请先在工作台确认匹配偏好卡。", {
      statusCode: 409,
      details: { profileId: plan.profileId, cardId: getSearchPlanDependency(db, plan.id).draftCardId }
    });
  }
  const pool = listDecisionPool(db, { planId });
  const requestedJobId = Number(input.jobId);
  const jobs = bulk
    ? pool.filter((job) => job.decisionBucket === "analysis_pending" && isJobAwaitingAction(job))
      .slice(0, PRODUCT_POLICY.operations.modelAnalysis.maxRetryJobs)
    : pool.filter((job) => job.id === requestedJobId);
  if (!jobs.length) throw new Error(bulk ? "当前没有待重试的语义分析岗位。" : "岗位不存在或不属于当前筛选方案。");
  const baseConfigs = loadConfigs(deps.root);
  baseConfigs.model = deps.modelConfig;
  const configs = profileToRuntimeConfigs(baseConfigs, matchingContext.candidateProfile, plan.plan, listMatchingResumeVersions(db, plan.profileId), matchingContext.matchingCard);
  const makeRunner = deps.createJobAnalysisRunner || createJobAnalysisRunner;
  const analyze = makeRunner(configs, plan.plan.keywords || [], { db, logger: deps.logger });
  const batchId = createBatch(db, jobs[0].source || "boss", bulk ? "analysis-retry-bulk" : "analysis-retry", bulk
    ? `analysis-retry-bulk:plan:${planId}:jobs:${jobs.length}`
    : `analysis-retry:plan:${planId}:job:${jobs[0].id}`, {
    profileId: plan.profileId,
    searchPlanId: planId,
    filterSnapshot: { mode: bulk ? "analysis-retry-bulk" : "analysis-retry", jobIds: jobs.map((job) => job.id) }
  });
  const concurrency = bulk ? PRODUCT_POLICY.operations.modelAnalysis.retryConcurrency : 1;
  const results = await mapWithConcurrency(jobs, concurrency, async (job) => {
    const scored = scoreJob(job, configs);
    if (decisionState(scored) !== "ready") return { job, scored, sourcePending: true, analysis: job.analysis };
    const analysis = await analyze({ ...job, ...scored, greeting: job.greeting || "" });
    return { job, scored, sourcePending: false, analysis };
  });
  let completed = 0;
  let failed = 0;
  let sourcePending = 0;
  for (const result of results) {
    if (result.sourcePending) {
      sourcePending += 1;
      continue;
    }
    upsertJob(db, { ...result.job, ...result.scored, analysis: result.analysis, greeting: result.job.greeting || "" }, batchId);
    if (result.analysis.semanticStatus === "failed") failed += 1;
    else completed += 1;
  }
  reconcilePlanWorkflowInventory(db, planId);
  return {
    kind: bulk ? "bulk" : "one",
    planId,
    batchId,
    jobIds: jobs.map((job) => job.id),
    requested: jobs.length,
    completed,
    failed,
    sourcePending,
    concurrency,
    results
  };
}

module.exports = {
  retryOneJobAnalysis,
  retryPendingJobAnalyses
};
