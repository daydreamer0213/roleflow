const crypto = require("crypto");
const { matchingCardRevision } = require("./matching_card");

const PIPELINE_VERSIONS = Object.freeze({
  understandJob: "job-understanding-v8",
  matchJob: "match-decision-v15",
  communication: "communication-v2"
});

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function modelSearchPlanContext(searchPlan = {}) {
  return {
    cities: searchPlan.cities || [],
    experience: searchPlan.experience || [],
    jobTypes: searchPlan.jobTypes || [],
    directions: searchPlan.directions || []
  };
}

function runtimeAnalysisContext(candidateProfile, searchPlan, matchingCard = null) {
  return {
    profileVersion: stableHash(candidateProfile || {}),
    searchPlanVersion: stableHash(modelSearchPlanContext(searchPlan)),
    matchingCardVersion: matchingCard ? matchingCardRevision(matchingCard) : null
  };
}

function buildAnalysisRevision(configs, sourceContentHash) {
  return {
    profileVersion: configs.analysisContext?.profileVersion || stableHash(configs.candidateProfile || {}),
    searchPlanVersion: configs.analysisContext?.searchPlanVersion || stableHash(modelSearchPlanContext(configs.searchPlan)),
    matchingCardVersion: configs.analysisContext?.matchingCardVersion ?? null,
    sourceContentHash: String(sourceContentHash || ""),
    pipelineVersions: PIPELINE_VERSIONS
  };
}

function analysisStaleReasons(analysis, currentRevision) {
  const revision = analysis?.revision;
  if (!revision) return ["analysis_revision_missing"];
  const reasons = [];
  if (revision.profileVersion !== currentRevision.profileVersion) reasons.push("profile_changed");
  if (revision.searchPlanVersion !== currentRevision.searchPlanVersion) reasons.push("search_plan_changed");
  const previousCardVersion = revision.matchingCardVersion ?? null;
  const currentCardVersion = currentRevision.matchingCardVersion ?? null;
  // 历史修订没有记录卡版本时不补判卡变化，避免升级后把存量分析全部误判为陈旧。
  if (previousCardVersion && currentCardVersion && previousCardVersion !== currentCardVersion) reasons.push("matching_card_changed");
  if (revision.sourceContentHash !== currentRevision.sourceContentHash) reasons.push("job_source_changed");
  if (revision.pipelineVersions?.understandJob !== PIPELINE_VERSIONS.understandJob) reasons.push("job_understanding_pipeline_changed");
  if (revision.pipelineVersions?.matchJob !== PIPELINE_VERSIONS.matchJob) reasons.push("match_pipeline_changed");
  return reasons;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

module.exports = { PIPELINE_VERSIONS, stableHash, runtimeAnalysisContext, buildAnalysisRevision, analysisStaleReasons };
