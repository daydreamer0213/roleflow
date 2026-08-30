const { createModelAdapter } = require("../adapters/models");
const { validateModelResult } = require("./model_contract");

const DEFAULT_MODEL_CONFIG = {
  provider: "mock",
  providers: {
    mock: { model: "offline-structured-mock" }
  }
};

function createLlmAnalyzer({ modelConfig = DEFAULT_MODEL_CONFIG, adapter = null, logger = null } = {}) {
  const modelAdapter = adapter || createModelAdapter(modelConfig, { logger });
  return {
    analyzeResume: async (input, options = {}) => validateAdapterResult("analyzeResume", await modelAdapter.analyzeResume(input, options)),
    recommendSearchPlan: async (input, options = {}) => validateAdapterResult("recommendSearchPlan", await modelAdapter.recommendSearchPlan(input, options)),
    understandJob: async (input, options = {}) => validateAdapterResult("understandJob", await modelAdapter.understandJob(input, options)),
    matchJob: async (input, options = {}) => validateAdapterResult(
      "matchJob",
      await modelAdapter.matchJob(input, options),
      { jobUnderstanding: input?.jobUnderstanding }
    ),
    draftCommunication: async (input, options = {}) => validateAdapterResult("draftCommunication", await modelAdapter.draftCommunication(input, options)),
    buildCandidateMatchCard: async (input, options = {}) => validateAdapterResult("buildCandidateMatchCard", await modelAdapter.buildCandidateMatchCard(input, options))
  };
}

function validateAdapterResult(kind, value, context = {}) {
  try {
    return validateModelResult(kind, value, context);
  } catch (error) {
    if (error?.code === "MODEL_CONTRACT_INVALID") error.invalidOutput = value;
    throw error;
  }
}

let defaultAnalyzer = null;

function getDefaultAnalyzer() {
  if (!defaultAnalyzer) defaultAnalyzer = createLlmAnalyzer();
  return defaultAnalyzer;
}

function analyzeResume(input, options) {
  return getDefaultAnalyzer().analyzeResume(input, options);
}

function understandJob(input, options) {
  return getDefaultAnalyzer().understandJob(input, options);
}

function recommendSearchPlan(input, options) {
  return getDefaultAnalyzer().recommendSearchPlan(input, options);
}

function matchJob(input, options) {
  return getDefaultAnalyzer().matchJob(input, options);
}

function draftCommunication(input, options) {
  return getDefaultAnalyzer().draftCommunication(input, options);
}

function buildCandidateMatchCard(input, options) {
  return getDefaultAnalyzer().buildCandidateMatchCard(input, options);
}

module.exports = {
  createLlmAnalyzer,
  analyzeResume,
  recommendSearchPlan,
  understandJob,
  matchJob,
  draftCommunication,
  buildCandidateMatchCard
};
