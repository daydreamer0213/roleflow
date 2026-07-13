const { createModelAdapter } = require("../adapters/models");
const { validateModelResult } = require("./model_contract");

const DEFAULT_MODEL_CONFIG = {
  provider: "mock",
  providers: {
    mock: { model: "offline-structured-mock" }
  }
};

function createLlmAnalyzer({ modelConfig = DEFAULT_MODEL_CONFIG, adapter = null } = {}) {
  const modelAdapter = adapter || createModelAdapter(modelConfig);
  return {
    analyzeResume: async (input) => validateModelResult("analyzeResume", await modelAdapter.analyzeResume(input)),
    recommendSearchPlan: async (input) => validateModelResult("recommendSearchPlan", await modelAdapter.recommendSearchPlan(input)),
    understandJob: async (input) => validateModelResult("understandJob", await modelAdapter.understandJob(input)),
    matchJob: async (input) => validateModelResult("matchJob", await modelAdapter.matchJob(input)),
    draftCommunication: async (input) => validateModelResult("draftCommunication", await modelAdapter.draftCommunication(input))
  };
}

const defaultAnalyzer = createLlmAnalyzer();

function analyzeResume(input) {
  return defaultAnalyzer.analyzeResume(input);
}

function understandJob(input) {
  return defaultAnalyzer.understandJob(input);
}

function recommendSearchPlan(input) {
  return defaultAnalyzer.recommendSearchPlan(input);
}

function matchJob(input) {
  return defaultAnalyzer.matchJob(input);
}

function draftCommunication(input) {
  return defaultAnalyzer.draftCommunication(input);
}

module.exports = {
  createLlmAnalyzer,
  analyzeResume,
  recommendSearchPlan,
  understandJob,
  matchJob,
  draftCommunication
};
