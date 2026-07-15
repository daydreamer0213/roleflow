const { createLlmAnalyzer } = require("./llm_analyzer");
const { normalizeCandidateProfile, normalizeSearchPlan } = require("./profile_schema");

async function analyzeResumeToPlan({ modelConfig, resume, logger = null }) {
  const profile = await analyzeResumeProfile({ modelConfig, resume, logger });
  const plan = await recommendPlanForProfile({ modelConfig, profile, logger });
  return { profile, plan };
}

async function analyzeResumeProfile({ modelConfig, resume, logger = null }) {
  const analyzer = createLlmAnalyzer({ modelConfig, logger });
  const modelInput = prepareResumeTextForModel(resume.text);
  resume.diagnostics = {
    ...(resume.diagnostics || {}),
    modelInput: {
      charCount: modelInput.text.length,
      preview: modelInput.preview,
      redactions: modelInput.redactions
    }
  };
  const rawProfile = await analyzer.analyzeResume({ resumeText: modelInput.text, profileHints: {} });
  return normalizeCandidateProfile(rawProfile, {
    provider: modelConfig?.provider || "mock",
    model: modelConfig?.providers?.[modelConfig?.provider]?.model || "",
    resumeTextLength: resume.text.length,
    inputMethod: resume.diagnostics?.extractionMethod || resume.format || "unknown",
    inputTrust: "user_provided"
  });
}

function prepareResumeTextForModel(value) {
  let text = String(value || "");
  const redactions = {};
  const replace = (pattern, label, replacer) => {
    text = text.replace(pattern, (...args) => {
      redactions[label] = (redactions[label] || 0) + 1;
      return typeof replacer === "function" ? replacer(...args) : replacer;
    });
  };
  replace(/(^|\n)(\s*(?:手机|电话|联系电话|联系方式)\s*[：:]?\s*)[^\n]+/gi, "phone", (_match, line, prefix) => `${line}${prefix}[已隐藏]`);
  replace(/(^|\n)(\s*(?:家庭住址|通讯地址|详细地址|现住址|住址|地址)\s*[：:]?\s*)[^\n]+/gi, "address", (_match, line, prefix) => `${line}${prefix}[已隐藏]`);
  replace(/(?<![\dA-Za-z])(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, "phone", "[手机号已隐藏]");
  replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "email", "[邮箱已隐藏]");
  replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, "idCard", "[身份证号已隐藏]");
  return {
    text,
    preview: text.slice(0, 1200),
    redactions
  };
}

async function recommendPlanForProfile({ modelConfig, profile, logger = null }) {
  const analyzer = createLlmAnalyzer({ modelConfig, logger });
  const rawPlan = await analyzer.recommendSearchPlan({ candidateProfile: profile });
  return normalizeSearchPlan(rawPlan, profile);
}

module.exports = { analyzeResumeToPlan, analyzeResumeProfile, recommendPlanForProfile, prepareResumeTextForModel };
