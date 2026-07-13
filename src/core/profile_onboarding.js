const { createLlmAnalyzer } = require("./llm_analyzer");
const { normalizeCandidateProfile, normalizeSearchPlan } = require("./profile_schema");

async function analyzeResumeToPlan({ modelConfig, resume }) {
  const analyzer = createLlmAnalyzer({ modelConfig });
  const rawProfile = await analyzer.analyzeResume({ resumeText: resume.text, profileHints: {} });
  const profile = normalizeCandidateProfile(rawProfile, {
    provider: modelConfig?.provider || "mock",
    model: modelConfig?.providers?.[modelConfig?.provider]?.model || "",
    resumeTextLength: resume.text.length,
    inputMethod: resume.diagnostics?.extractionMethod || resume.format || "unknown",
    inputTrust: "user_provided"
  });
  const rawPlan = await analyzer.recommendSearchPlan({ candidateProfile: profile });
  const plan = normalizeSearchPlan(rawPlan, profile);
  return { profile, plan };
}

module.exports = { analyzeResumeToPlan };
