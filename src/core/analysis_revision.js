const crypto = require("crypto");
const { matchingCardRevision } = require("./matching_card");
const { normalizeThinkingMode, normalizeReasoningEffort } = require("./model_settings");

const PIPELINE_VERSIONS = Object.freeze({
  understandJob: "job-understanding-v19",
  matchJob: "match-decision-v44",
  decisionRules: "four-tier-weighted-v4.7",
  communication: "communication-v2"
});

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeBaseUrl(value) {
  const endpoint = String(value || "").trim();
  if (!endpoint) return "";
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error("MODEL_INFERENCE_BASE_URL_INVALID");
  }
}

function modelInferenceVersion(config = {}) {
  return stableHash({
    provider: normalizeProvider(config.provider),
    baseUrl: normalizeBaseUrl(config.baseUrl),
    model: String(config.model || "").trim(),
    thinkingMode: normalizeThinkingMode(config.thinkingMode),
    reasoningEffort: normalizeReasoningEffort(config.reasoningEffort)
  });
}

function modelInferenceConfig(modelConfig = {}) {
  const provider = normalizeProvider(modelConfig.provider || "mock");
  const providerConfig = modelConfig.providers?.[provider] || modelConfig.providers?.[modelConfig.provider] || {};
  return {
    provider,
    baseUrl: modelConfig.baseUrl ?? providerConfig.baseUrl,
    model: modelConfig.model ?? providerConfig.model,
    thinkingMode: modelConfig.thinkingMode ?? providerConfig.thinkingMode,
    reasoningEffort: modelConfig.reasoningEffort ?? providerConfig.reasoningEffort
  };
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
    semanticMatchingMode: configs.semanticMatchingMode
      || configs.model?.semanticMatchingMode
      || "split",
    modelInferenceVersion: modelInferenceVersion(modelInferenceConfig(configs.model)),
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
  if (revision.semanticMatchingMode
    && currentRevision.semanticMatchingMode
    && revision.semanticMatchingMode !== currentRevision.semanticMatchingMode) {
    reasons.push("semantic_matching_mode_changed");
  }
  if (currentRevision.modelInferenceVersion
    && revision.modelInferenceVersion !== currentRevision.modelInferenceVersion) {
    reasons.push("model_inference_changed");
  }
  if (revision.pipelineVersions?.understandJob !== PIPELINE_VERSIONS.understandJob) reasons.push("job_understanding_pipeline_changed");
  if (revision.pipelineVersions?.matchJob !== PIPELINE_VERSIONS.matchJob) reasons.push("match_pipeline_changed");
  if (revision.pipelineVersions?.decisionRules !== PIPELINE_VERSIONS.decisionRules) reasons.push("decision_rules_changed");
  return reasons;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

module.exports = {
  PIPELINE_VERSIONS,
  stableHash,
  modelInferenceVersion,
  runtimeAnalysisContext,
  buildAnalysisRevision,
  analysisStaleReasons
};
