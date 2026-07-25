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
    analyzeResume: async (input) => validateAdapterResult("analyzeResume", await modelAdapter.analyzeResume(input)),
    recommendSearchPlan: async (input) => validateAdapterResult("recommendSearchPlan", await modelAdapter.recommendSearchPlan(input)),
    understandJob: async (input) => validateAdapterResult("understandJob", await modelAdapter.understandJob(input)),
    matchJob: async (input) => validateAdapterResult("matchJob", await modelAdapter.matchJob(input)),
    draftCommunication: async (input) => validateAdapterResult("draftCommunication", await modelAdapter.draftCommunication(input)),
    buildCandidateMatchCard: async (input) => validateAdapterResult("buildCandidateMatchCard", await modelAdapter.buildCandidateMatchCard(input))
  };
}

function validateAdapterResult(kind, value) {
  try {
    return validateModelResult(kind, value);
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

function analyzeResume(input) {
  return getDefaultAnalyzer().analyzeResume(input);
}

function understandJob(input) {
  return getDefaultAnalyzer().understandJob(input);
}

function recommendSearchPlan(input) {
  return getDefaultAnalyzer().recommendSearchPlan(input);
}

function matchJob(input) {
  return getDefaultAnalyzer().matchJob(input);
}

function draftCommunication(input) {
  return getDefaultAnalyzer().draftCommunication(input);
}

function buildCandidateMatchCard(input) {
  return getDefaultAnalyzer().buildCandidateMatchCard(input);
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
