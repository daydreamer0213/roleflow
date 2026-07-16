const crypto = require("crypto");

const PIPELINE_VERSIONS = Object.freeze({
  understandJob: "job-understanding-v3",
  matchJob: "match-decision-v10",
  communication: "communication-v2"
});

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function runtimeAnalysisContext(candidateProfile, searchPlan) {
  return {
    profileVersion: stableHash(candidateProfile || {}),
    searchPlanVersion: stableHash(searchPlan || {})
  };
}

function buildAnalysisRevision(configs, sourceContentHash) {
  return {
    profileVersion: configs.analysisContext?.profileVersion || stableHash(configs.candidateProfile || {}),
    searchPlanVersion: configs.analysisContext?.searchPlanVersion || stableHash(configs.searchPlan || {}),
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
