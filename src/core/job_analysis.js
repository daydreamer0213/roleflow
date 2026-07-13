const { createLlmAnalyzer } = require("./llm_analyzer");
const { explainJobMatch } = require("./match_explainer");
const crypto = require("crypto");
const { getModelCache, saveModelCache } = require("./storage");

function createJobAnalysisRunner(configs, keywordPlan = [], { db = null, analyzer: injectedAnalyzer = null, logger = null } = {}) {
  const analyzer = injectedAnalyzer || createLlmAnalyzer({ modelConfig: configs.model });
  const ruleOnly = !injectedAnalyzer && (configs.model?.provider || "mock") === "mock";
  let candidateProfilePromise = null;

  async function getCandidateProfile() {
    if (!candidateProfilePromise) {
      candidateProfilePromise = analyzer.analyzeResume({
        resumeText: "",
        profileHints: configs.candidateProfile || {}
      });
    }
    return candidateProfilePromise;
  }

  return async function analyzeJob(job) {
    const ruleMatch = explainJobMatch(job, configs, keywordPlan);
    if (ruleOnly) {
      return createRuleOnlyAnalysis(configs, job, ruleMatch);
    }
    try {
      const candidateProfile = await getCandidateProfile();
      const jobUnderstanding = await cachedModelCall({ db, configs, logger, kind: "understandJob", input: { job, candidateProfile }, run: analyzer.understandJob });
      const matchDecision = await cachedModelCall({ db, configs, logger, kind: "matchJob", input: {
        candidateProfile,
        resumeVersions: configs.resumeVersions,
        jobUnderstanding,
        ruleMatch
      }, run: analyzer.matchJob });
      const communication = await cachedModelCall({ db, configs, logger, kind: "draftCommunication", input: {
        candidateProfile,
        jobUnderstanding,
        matchDecision
      }, run: analyzer.draftCommunication });
      return applyRuleGuard(compactAnalysis(configs, {
        job,
        jobUnderstanding,
        matchDecision,
        communication,
        ruleMatch
      }), job);
    } catch (error) {
      logger?.warn("job_analysis_fallback", { jobId: job.sourceId || job.url || "", errorCode: error?.code || "MODEL_ANALYSIS_FAILED", errorMessage: error?.message || String(error) });
      return applyRuleGuard(compactAnalysis(configs, {
        job,
        ruleMatch,
        communication: { greeting: job.greeting || "" },
        error: error.message || String(error)
      }), job);
    }
  };
}

function createRuleOnlyAnalysis(configs, job, ruleMatch) {
  const compact = compactAnalysis(configs, {
    job,
    ruleMatch,
    communication: { greeting: job.greeting || "" }
  });
  return applyRuleGuard({
    ...compact,
    provider: "rule-only",
    model: "",
    confidence: null,
    fitReasons: compact.fitReasons?.length ? compact.fitReasons : ["未配置大模型，当前仅按岗位类型、城市、薪资和技能规则排序。"]
  }, job);
}

async function cachedModelCall({ db, configs, logger = null, kind, input, run }) {
  if (!db) return run(input);
  const provider = configs.model?.provider || "mock";
  const model = configs.model?.providers?.[provider]?.model || "";
  const inputHash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const cacheKey = crypto.createHash("sha256").update(`${provider}|${model}|${kind}|${inputHash}`).digest("hex");
  const cached = getModelCache(db, cacheKey);
  if (cached) {
    logger?.info("model_cache_hit", { kind, provider, model });
    return cached.result;
  }
  const result = await run(input);
  saveModelCache(db, { cacheKey, kind, provider, model, inputHash, result });
  logger?.info("model_cache_saved", { kind, provider, model });
  return result;
}

function compactAnalysis(configs, parts) {
  const provider = configs.model?.provider || "mock";
  const model = configs.model?.providers?.[provider]?.model || "";
  const decision = parts.matchDecision || {};
  const understanding = parts.jobUnderstanding || {};
  const communication = parts.communication || {};
  const rule = parts.ruleMatch || {};
  const job = parts.job || {};
  const versionId = decision.recommendedResumeVersion || rule.recommendedResumeVersion || "";
  const versionName = resumeVersionName(configs.resumeVersions, versionId);
  const primaryProjects = decision.primaryProjects || rule.primaryProjects || [];

  return {
    provider: parts.error ? "rule-fallback" : provider,
    model,
    error: parts.error || "",
    realRoleType: understanding.realRoleType || "",
    businessScenario: understanding.businessScenario || "",
    recommendation: decision.recommendation || recommendationFromScore(job.score),
    fitLevel: decision.fitLevel || fitLevelFromScore(job.score),
    confidence: decision.confidence ?? null,
    recommendedResumeVersion: versionId,
    recommendedResumeVersionName: versionName,
    primaryProjects,
    fitReasons: decision.fitReasons || rule.fitReasons || [],
    missingPoints: decision.missingPoints || rule.missingPoints || [],
    riskQuestions: decision.riskQuestions || rule.riskQuestions || [],
    evidence: decision.evidence || { jd: understanding.evidenceSnippets || [], resume: [] },
    greetingAngle: decision.greetingAngle || rule.greetingAngle || "",
    greeting: chooseGreeting(configs, job, versionName, primaryProjects, communication.greeting),
    hrReplies: communication.hrReplies || {}
  };
}

function applyRuleGuard(analysis, job) {
  const score = Number(job.score ?? 0);
  const risks = job.risks || [];
  if (score <= -20) {
    return addGuard(analysis, "skip", "D", "规则护栏：岗位分数过低，建议跳过。");
  }
  if (score < 6 || risks.length >= 3) {
    return addGuard(analysis, analysis.recommendation === "skip" ? "skip" : "caution", analysis.fitLevel || "C", "规则护栏：存在明显风险，投递前需要人工确认。");
  }
  const usesLiveModel = !["mock", "rule-only", "rule-gate", "rule-fallback"].includes(analysis.provider);
  if (usesLiveModel && Number(analysis.confidence ?? 0) < 0.62) {
    return addGuard(analysis, "review", analysis.fitLevel || "C", "模型置信度较低，先人工复核 JD 与简历证据。");
  }
  return analysis;
}

function addGuard(analysis, recommendation, fitLevel, reason) {
  return {
    ...analysis,
    recommendation,
    fitLevel,
    fitReasons: [reason, ...(analysis.fitReasons || []).filter((item) => !/unknown|可做初步匹配/.test(String(item)))],
    ruleAdjusted: true
  };
}

function chooseGreeting(configs, job, versionName, primaryProjects, modelGreeting) {
  if ((configs.model?.provider || "mock") !== "mock" && modelGreeting) return modelGreeting;
  const name = configs.candidateProfile?.candidate?.name || configs.profile?.candidate?.name || "候选人";
  const title = job.title || "AI 相关";
  const projects = (primaryProjects || []).slice(0, 2).join("、") || versionName || "AI 应用项目";
  return `您好，我是${name}。看到这个${title}岗位和我做过的${projects}经验比较匹配，想进一步了解岗位职责和团队情况，方便的话可以沟通一下。`;
}

function recommendationFromScore(score) {
  return Number(score ?? 0) >= 6 ? "apply" : "caution";
}

function fitLevelFromScore(score) {
  const value = Number(score ?? 0);
  if (value >= 12) return "A";
  if (value >= 6) return "B";
  if (value >= 0) return "C";
  return "D";
}

function resumeVersionName(resumeVersions, id) {
  return (resumeVersions?.versions || []).find((version) => version.id === id)?.name || id || "";
}

module.exports = { createJobAnalysisRunner, compactAnalysis, createRuleOnlyAnalysis };
