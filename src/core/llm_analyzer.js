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
    draftCommunication: async (input) => applySensitiveExplanationGuard(
      input,
      validateAdapterResult("draftCommunication", await modelAdapter.draftCommunication(input))
    )
  };
}

function applySensitiveExplanationGuard(input, result) {
  if (String(input?.mode || "").trim() !== "hr_reply" || !isSensitiveExplanationRequest(input?.hrMessage)) {
    return result;
  }
  if (result.progressUpdate.stage === "needs_user_action" && !result.messages.length && result.missingFact) {
    return result;
  }
  return {
    ...result,
    messages: [],
    missingFact: {
      key: "sensitive_personal_explanation",
      question: "\u8bf7\u5148\u786e\u8ba4\u672c\u6b21\u9700\u8981\u56de\u590d\u7684\u4e2a\u4eba\u60c5\u51b5\u3002"
    },
    messageCategory: "other",
    progressUpdate: {
      stage: "needs_user_action",
      nextAction: "Provide current confirmation",
      summary: "Current personal explanation confirmation required"
    }
  };
}

function isSensitiveExplanationRequest(value) {
  const message = String(value || "").replace(/\s+/g, " ").trim();
  if (!message) return false;
  return /\bgap\b|\u7a7a\u7a97(?:\u671f)?/i.test(message)
    || /\b(?:why|reason).{0,24}\b(?:leave|left|leaving|resign|resigned)\b|\b(?:leave|left|leaving|resign|resigned).{0,24}\b(?:why|reason)\b|(?:\u4e3a\u4ec0\u4e48|\u4e3a\u4f55).{0,12}(?:\u79bb\u804c|\u8f9e\u804c|\u79bb\u5f00)|(?:\u79bb\u804c|\u8f9e\u804c|\u79bb\u5f00).{0,12}(?:\u539f\u56e0|\u7406\u7531)/i.test(message)
    || /\bshort(?:[-\s]?term)?\s+project\b|\b(?:why|reason).{0,24}\b(?:short[-\s]?term\s+project|project).{0,24}\b(?:short|ended|end)\b|\u77ed\u671f.{0,8}\u9879\u76ee|\u9879\u76ee.{0,12}(?:\u77ed|\u7ed3\u675f).{0,12}(?:\u539f\u56e0|\u4e3a\u4ec0\u4e48|\u4e3a\u4f55)/i.test(message);
}

function validateAdapterResult(kind, value) {
  try {
    return validateModelResult(kind, value);
  } catch (error) {
    if (error?.code === "MODEL_CONTRACT_INVALID") error.invalidOutput = value;
    throw error;
  }
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
