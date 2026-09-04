const { createLlmAnalyzer } = require("./llm_analyzer");
const { normalizeCandidateProfile, normalizeSearchPlan } = require("./profile_schema");
const { prepareResumeTextForModel } = require("./resume_privacy");

async function analyzeResumeToPlan({ modelConfig, resume, logger = null, identity = null, strictPrivacy = false }) {
  const profile = await analyzeResumeProfile({ modelConfig, resume, logger, identity, strictPrivacy });
  const plan = await recommendPlanForProfile({ modelConfig, profile, logger });
  return { profile, plan };
}

async function analyzeResumeProfile({
  modelConfig,
  resume,
  logger = null,
  identity = null,
  strictPrivacy = false,
  preparedModelInput = null,
  analyzerFactory = createLlmAnalyzer
}) {
  const modelInput = preparedModelInput || prepareResumeTextForModel(resume.text, {
    originalFileName: resume.originalFileName,
    identity,
    strict: strictPrivacy
  });
  const { preview: _rawPreview, ...safeDiagnostics } = resume.diagnostics || {};
  resume.diagnostics = {
    ...safeDiagnostics,
    preview: modelInput.preview,
    modelInput: {
      charCount: modelInput.text.length,
      preview: modelInput.preview,
      redactions: modelInput.redactions
    }
  };
  const analyzer = analyzerFactory({ modelConfig, logger });
  const rawProfile = await analyzer.analyzeResume({ resumeText: modelInput.text, profileHints: {} });
  return normalizeCandidateProfile(rawProfile, {
    provider: modelConfig?.provider || "mock",
    model: modelConfig?.providers?.[modelConfig?.provider]?.model || "",
    resumeTextLength: resume.text.length,
    inputMethod: resume.diagnostics?.extractionMethod || resume.format || "unknown",
    inputTrust: "user_provided"
  });
}

async function recommendPlanForProfile({ modelConfig, profile, logger = null }) {
  const analyzer = createLlmAnalyzer({ modelConfig, logger });
  const rawPlan = await analyzer.recommendSearchPlan({ candidateProfile: profile });
  return normalizeSearchPlan({
    ...rawPlan,
    salary: { minK: 0, maxK: 0 },
    salaryMinK: 0,
    salaryMaxK: 0,
    allowPartTime: false,
    platform: {
      ...rawPlan.platform,
      generated: { ...rawPlan.platform?.generated, salaryLanes: [] }
    }
  }, profile);
}

async function buildCandidateMatchCard({ modelConfig, profile, logger = null, adapter = null }) {
  const analyzer = createLlmAnalyzer({ modelConfig, logger, adapter });
  return analyzer.buildCandidateMatchCard({
    candidateProfile: profileForMatchingCard(profile)
  });
}

function profileForMatchingCard(profile = {}) {
  return {
    candidate: profile.candidate || {}, education: profile.education || [],
    experiences: profile.experiences || [], skills: profile.skills || [],
    projects: profile.projects || [], credentials: profile.credentials || [],
    strengths: profile.strengths || []
  };
}

module.exports = { analyzeResumeToPlan, analyzeResumeProfile, recommendPlanForProfile, prepareResumeTextForModel, buildCandidateMatchCard, profileForMatchingCard };
