const crypto = require("crypto");
const { createLlmAnalyzer } = require("./llm_analyzer");
const { explainJobMatch } = require("./match_explainer");
const { validateModelResult, effectiveHardBlockers } = require("./model_contract");
const { getModelCache, saveModelCache, sourceContentHash } = require("./storage");
const { decisionState } = require("./scoring");
const { PIPELINE_VERSIONS, buildAnalysisRevision } = require("./analysis_revision");

function createJobAnalysisRunner(configs, keywordPlan = [], { db = null, analyzer: injectedAnalyzer = null, logger = null } = {}) {
  const analyzer = injectedAnalyzer || createLlmAnalyzer({ modelConfig: configs.model, logger });
  const provider = configs.model?.provider || "mock";
  const ruleOnly = !injectedAnalyzer && provider === "mock";
  const candidateProfile = configs.candidateProfile;

  return async function analyzeJob(job) {
    const ruleMatch = explainJobMatch(job, configs, keywordPlan);
    const facts = jobFacts(job);
    const contentHash = sourceContentHash(facts);
    const revision = buildAnalysisRevision(configs, contentHash);
    if (ruleOnly) return createRuleOnlyAnalysis(configs, job, ruleMatch, revision);
    if (!candidateProfile || typeof candidateProfile !== "object") {
      return failedAnalysis(configs, job, revision, Object.assign(new Error("候选人画像不存在，无法执行语义匹配。"), { code: "CANDIDATE_PROFILE_REQUIRED" }));
    }

    try {
      const jobUnderstanding = await cachedModelCall({
        db,
        configs,
        logger,
        kind: "understandJob",
        pipelineVersion: PIPELINE_VERSIONS.understandJob,
        input: { job: { ...facts, sourceContentHash: contentHash } },
        run: analyzer.understandJob
      });
      const matchDecision = await cachedModelCall({
        db,
        configs,
        logger,
        kind: "matchJob",
        pipelineVersion: PIPELINE_VERSIONS.matchJob,
        input: {
          candidateProfile: candidateProfileForJobMatch(candidateProfile),
          resumeVersions: resumeVersionsForJobMatch(configs.resumeVersions),
          jobUnderstanding,
          jobEvidence: {
            sourceId: facts.sourceId,
            title: facts.title,
            salary: facts.salary,
            experience: facts.experience,
            education: facts.education,
            description: facts.description
          },
          searchPreferences: searchPreferences(configs)
        },
        run: analyzer.matchJob
      });
      const analysis = compactAnalysis(configs, { job, jobUnderstanding, matchDecision, revision });
      return applyRuleGuard(applyRoleIntentGuard(analysis, configs), job);
    } catch (error) {
      logger?.warn("job_analysis_failed", {
        jobId: job.sourceId || job.url || "",
        errorCode: error?.code || "MODEL_ANALYSIS_FAILED",
        errorMessage: error?.message || String(error)
      });
      return applyRuleGuard(failedAnalysis(configs, job, revision, error), job);
    }
  };
}

function createRuleOnlyAnalysis(configs, job, ruleMatch, revision = buildAnalysisRevision(configs, sourceContentHash(jobFacts(job)))) {
  const versionId = ruleMatch.recommendedResumeVersion || "";
  return applyRuleGuard({
    provider: "rule-only",
    model: "",
    semanticStatus: "rule_only",
    decisionSource: "local_rules",
    error: "",
    errorCode: "",
    realRoleType: "",
    businessScenario: "",
    coreRequirements: [],
    hiddenRisks: [],
    recommendation: "review",
    fitLevel: "C",
    confidence: null,
    recommendedResumeVersion: versionId,
    recommendedResumeVersionName: resumeVersionName(configs.resumeVersions, versionId),
    primaryProjects: ruleMatch.primaryProjects || [],
    fitReasons: ["当前未启用语义模型，岗位只完成了基础边界检查。"],
    hardBlockers: [],
    softGaps: ruleMatch.missingPoints || [],
    questionsToVerify: ruleMatch.riskQuestions || [],
    missingPoints: ruleMatch.missingPoints || [],
    blockingGaps: [],
    riskQuestions: ruleMatch.riskQuestions || [],
    evidence: { jd: [], resume: [] },
    greetingAngle: "",
    greeting: job.greeting || "",
    hrReplies: {},
    revision
  }, job);
}

async function cachedModelCall({ db, configs, logger = null, kind, pipelineVersion, input, run }) {
  const provider = configs.model?.provider || "mock";
  const model = configs.model?.providers?.[provider]?.model || "";
  const inputHash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const cacheKey = crypto.createHash("sha256").update(`${provider}|${model}|${kind}|${pipelineVersion}|${inputHash}`).digest("hex");
  if (db) {
    const cached = getModelCache(db, cacheKey);
    if (cached) {
      try {
        const result = validateModelResult(kind, cached.result);
        logger?.info("model_cache_hit", { kind, provider, model, pipelineVersion });
        logger?.info("model_call_completed", { kind, provider, model, cacheHit: true, latencyMs: 0, attempts: 0, httpStatus: null, usage: null, jsonModeFallback: false });
        return result;
      } catch (error) {
        if (error?.code !== "MODEL_CONTRACT_INVALID") throw error;
        logger?.warn("model_cache_contract_invalid", { kind, provider, model, pipelineVersion, errorMessage: error.message });
      }
    }
  }

  let result;
  let rawResult;
  try {
    rawResult = await run(input);
    result = validateModelResult(kind, rawResult);
  } catch (error) {
    if (error?.code !== "MODEL_CONTRACT_INVALID") throw error;
    const invalidOutput = error.invalidOutput ?? rawResult;
    logger?.warn("model_contract_repair_requested", {
      kind, provider, model, pipelineVersion, errorMessage: error.message,
      outputShape: contractOutputShape(invalidOutput)
    });
    try {
      const repaired = await run({
        ...input,
        contractRepair: {
          reason: error.message,
          invalidOutput,
          instruction: "只修正错误字段并返回完整 JSON；保留原有事实和有效证据，不得编造或输出通用占位语。"
        }
      });
      result = validateModelResult(kind, repaired);
      logger?.info("model_contract_repair_completed", { kind, provider, model, pipelineVersion });
    } catch (repairError) {
      logger?.warn("model_contract_repair_failed", {
        kind, provider, model, pipelineVersion,
        initialErrorMessage: error.message,
        errorMessage: repairError?.message || String(repairError),
        outputShape: contractOutputShape(repairError?.invalidOutput)
      });
      throw repairError;
    }
  }
  if (db) saveModelCache(db, { cacheKey, kind, provider, model, inputHash, result });
  logger?.info("model_cache_saved", { kind, provider, model, pipelineVersion });
  return result;
}

function contractOutputShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return typeof value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    Array.isArray(item) ? `array<${[...new Set(item.map((entry) => entry === null ? "null" : typeof entry))].join("|")}>` : item === null ? "null" : typeof item
  ]));
}

function compactAnalysis(configs, parts) {
  const provider = configs.model?.provider || "mock";
  const model = configs.model?.providers?.[provider]?.model || "";
  const decision = parts.matchDecision || {};
  const understanding = parts.jobUnderstanding || {};
  const job = parts.job || {};
  const versionId = decision.recommendedResumeVersion || "";
  const fullJd = job.detailRead === true || String(job.description || "").trim().length >= 120;
  return {
    provider,
    model,
    semanticStatus: fullJd ? "complete" : "partial",
    decisionSource: "model",
    error: "",
    errorCode: "",
    realRoleType: understanding.realRoleType || "unknown",
    businessScenario: understanding.businessScenario || "",
    coreRequirements: understanding.coreRequirements || [],
    coreStack: understanding.coreStack || [],
    eligibilityConstraints: understanding.eligibilityConstraints || [],
    hiddenRisks: understanding.hiddenRisks || [],
    senioritySignal: understanding.senioritySignal || "unknown",
    recommendation: decision.recommendation,
    fitLevel: decision.fitLevel,
    confidence: decision.confidence,
    recommendedResumeVersion: versionId,
    recommendedResumeVersionName: resumeVersionName(configs.resumeVersions, versionId),
    primaryProjects: decision.primaryProjects || [],
    fitReasons: decision.fitReasons || [],
    hardBlockers: decision.hardBlockers || decision.blockingGaps || [],
    softGaps: decision.softGaps || decision.missingPoints || [],
    questionsToVerify: decision.questionsToVerify || decision.riskQuestions || [],
    missingPoints: decision.softGaps || decision.missingPoints || [],
    blockingGaps: decision.hardBlockers || decision.blockingGaps || [],
    riskQuestions: decision.questionsToVerify || decision.riskQuestions || [],
    evidence: decision.evidence || { jd: [], resume: [] },
    greetingAngle: decision.greetingAngle || "",
    greeting: job.greeting || "",
    hrReplies: {},
    revision: parts.revision || buildAnalysisRevision(configs, sourceContentHash(jobFacts(job)))
  };
}

function failedAnalysis(configs, job, revision, error) {
  const provider = configs.model?.provider || "mock";
  return {
    provider,
    model: configs.model?.providers?.[provider]?.model || "",
    semanticStatus: "failed",
    decisionSource: "analysis_pending",
    error: error?.message || String(error || "模型分析失败"),
    errorCode: error?.code || "MODEL_ANALYSIS_FAILED",
    realRoleType: "",
    businessScenario: "",
    coreRequirements: [],
    hiddenRisks: [],
    recommendation: "review",
    fitLevel: "C",
    confidence: null,
    recommendedResumeVersion: "",
    recommendedResumeVersionName: "",
    primaryProjects: [],
    fitReasons: ["语义分析未完成，等待模型恢复后重试。"],
    hardBlockers: [],
    softGaps: [],
    questionsToVerify: [],
    missingPoints: [],
    blockingGaps: [],
    riskQuestions: [],
    evidence: { jd: [], resume: [] },
    greetingAngle: "",
    greeting: job.greeting || "",
    hrReplies: {},
    revision
  };
}

function applyRuleGuard(analysis, job) {
  const gate = decisionState(job);
  const qualityTags = new Set(job.qualityTags || []);
  if (gate === "blocked") return addGuard(analysis, "skip", "D", "已确认的基础条件不满足。", "blocked", "hard_boundary");
  if (gate === "refresh") return addGuard(analysis, "review", analysis.fitLevel || "C", "岗位来源信息需要刷新后再判断。", "refresh", "source_refresh");
  if (["failed", "stale", "pending"].includes(analysis.semanticStatus)) return { ...analysis, recommendation: "review", decisionSource: "analysis_pending" };
  if (analysis.semanticStatus === "partial") {
    return addGuard(analysis, "review", analysis.fitLevel || "C", "当前只有卡片级信息，完整 JD 补齐前不进入主投。", "partial", "model_partial");
  }
  const hardBlockers = effectiveHardBlockers(analysis);
  if (hardBlockers.length) {
    return addGuard({ ...analysis, hardBlockers, blockingGaps: hardBlockers }, "skip", "D", `存在不可沟通的硬性缺口：${hardBlockers[0]}`, analysis.semanticStatus, "hard_blocker_guard");
  }
  if (analysis.recommendation === "skip") {
    return addGuard({ ...analysis, hardBlockers: [], blockingGaps: [] }, "caution", analysis.fitLevel === "D" ? "C" : analysis.fitLevel, "当前只识别到可沟通差距，不作为直接淘汰依据。", analysis.semanticStatus, "soft_gap_guard");
  }
  const materialRisk = (analysis.hiddenRisks || []).find((risk) => ["medium", "high"].includes(risk?.severity));
  if (analysis.recommendation === "apply" && materialRisk) {
    const evidence = materialRisk.evidence ? `：${materialRisk.evidence}` : "";
    return addGuard(analysis, "caution", analysis.fitLevel === "A" ? "B" : analysis.fitLevel, `岗位存在需要先沟通确认的风险${evidence}`, analysis.semanticStatus, "semantic_risk_guard");
  }
  if (analysis.recommendation === "apply" && (qualityTags.has("experience_stretch") || qualityTags.has("experience_overrange") || qualityTags.has("experience_salary_overlap"))) {
    return addGuard(analysis, "caution", analysis.fitLevel === "A" ? "B" : analysis.fitLevel, "岗位年限高于候选人当前经历，只作为可沟通的经验可冲岗位。", analysis.semanticStatus, "experience_stretch_guard");
  }
  if (Number(analysis.confidence ?? 0) < 0.62) {
    return addGuard(analysis, "review", analysis.fitLevel || "C", "模型置信度较低，需要人工复核 JD 与简历证据。", analysis.semanticStatus, "model_low_confidence");
  }
  return analysis;
}

function applyRoleIntentGuard(analysis, configs) {
  if (analysis.recommendation !== "apply" || analysis.realRoleType !== "implementation_presales") return analysis;
  const candidate = configs.candidateProfile?.candidate || {};
  const targets = [
    candidate.targetTitle,
    ...(candidate.targetTitles || []),
    ...(candidate.directions || []),
    ...(configs.searchPlan?.directions || [])
  ].filter(Boolean).join(" ");
  if (/解决方案|实施|售前/.test(targets)) return analysis;
  return addGuard(analysis, "caution", analysis.fitLevel === "A" ? "B" : analysis.fitLevel, "岗位以实施、方案或客户交付为主，与当前纯开发目标存在职责偏移。", analysis.semanticStatus, "candidate_direction_guard");
}

function addGuard(analysis, recommendation, fitLevel, reason, semanticStatus = analysis.semanticStatus, decisionSource = analysis.decisionSource) {
  return {
    ...analysis,
    semanticStatus,
    decisionSource,
    recommendation,
    fitLevel,
    fitReasons: [reason, ...(analysis.fitReasons || []).filter((item) => item && item !== reason)],
    ruleAdjusted: true
  };
}

function jobFacts(job = {}) {
  return {
    source: job.source || "",
    sourceId: job.sourceId || "",
    title: job.title || "",
    company: job.company || "",
    location: job.location || "",
    salary: job.salary || "",
    experience: job.experience || "",
    education: job.education || "",
    bossActiveText: job.bossActiveText || "",
    url: job.url || "",
    tags: Array.isArray(job.tags) ? job.tags : [],
    description: job.description || ""
  };
}

function searchPreferences(configs) {
  const plan = configs.searchPlan || {};
  return {
    cities: plan.cities || [],
    experience: plan.experience || [],
    jobTypes: plan.jobTypes || [],
    directions: plan.directions || []
  };
}

function candidateProfileForJobMatch(profile) {
  const candidate = { ...(profile?.candidate || {}) };
  delete candidate.expectedSalary;
  delete candidate.adjustableSalary;
  return {
    candidate,
    education: profile?.education || [],
    experiences: profile?.experiences || [],
    skills: profile?.skills || [],
    projects: profile?.projects || [],
    credentials: profile?.credentials || [],
    strengths: profile?.strengths || []
  };
}

function resumeVersionsForJobMatch(resumeVersions = {}) {
  return {
    versions: (resumeVersions.versions || []).map((version) => ({
      id: version.id,
      name: version.name,
      summary: withoutSalaryPreference(version.summary),
      primaryProjects: version.primaryProjects || [],
      scenarios: version.scenarios || [],
      keywords: version.keywords || [],
      resumeFacts: candidateProfileForJobMatch(version.resumeFacts || {}),
      sourceDocument: version.sourceDocument ? {
        fileName: version.sourceDocument.fileName || "",
        format: version.sourceDocument.format || "",
        textExcerpt: withoutSalaryPreference(version.sourceDocument.textExcerpt)
      } : null
    }))
  };
}

function withoutSalaryPreference(value) {
  return String(value || "").replace(/(?:期望薪资|薪资期望|薪酬期望|期望待遇|薪资)\s*[：:]?\s*\d+(?:\.\d+)?\s*[-~—至]\s*\d+(?:\.\d+)?\s*[kK](?:\s*\/\s*月)?/gi, "").trim();
}

function resumeVersionName(resumeVersions, id) {
  return (resumeVersions?.versions || []).find((version) => version.id === id)?.name || id || "";
}

module.exports = {
  createJobAnalysisRunner,
  compactAnalysis,
  createRuleOnlyAnalysis,
  cachedModelCall,
  jobFacts
};
