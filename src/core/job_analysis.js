const crypto = require("crypto");
const { createLlmAnalyzer } = require("./llm_analyzer");
const { explainJobMatch } = require("./match_explainer");
const { validateModelResult, decisionHardBlockers, hardBlockerText } = require("./model_contract");
const {
  getModelCache,
  saveModelCache,
  sourceContentHash,
  transitionWorkflowRun,
  getWorkflowRun,
  selectReadyWorkflowJobEntries
} = require("./storage");
const { runWorkflowAnalysis } = require("./workflow_analysis_executor");
const { hasCompleteJobDescription } = require("./job_description_readiness");
const {
  initializeWorkflowJobTasks,
  reactivateWorkflowDetailRequiredTasks,
  recoverExpiredWorkflowJobTasks,
  countWorkflowJobTaskStatusesForRun,
  completedWorkflowAnalysisCount
} = require("./workflow_analysis_tasks");
const { listWorkflowInventory } = require("./workflow_inventory");
const { decisionState } = require("./scoring");
const { PIPELINE_VERSIONS, buildAnalysisRevision, modelInferenceVersion } = require("./analysis_revision");
const { deriveMatrixDecision } = require("./four_tier_decision");
const {
  DECISION_POLICY,
  DECISION_POLICY_HASH,
  RECOMMENDATION_SCHEMA_VERSION,
  capRecommendationTier
} = require("./decision_policy");

function createJobAnalysisRunner(configs, keywordPlan = [], {
  db = null,
  analyzer: injectedAnalyzer = null,
  logger = null,
  errorMode = "result"
} = {}) {
  if (!["result", "throw"].includes(errorMode)) {
    throw new Error(`createJobAnalysisRunner errorMode must be "result" or "throw", got ${errorMode}`);
  }
  const analyzer = injectedAnalyzer || createLlmAnalyzer({ modelConfig: configs.model, logger });
  const provider = configs.model?.provider || "mock";
  const ruleOnly = !injectedAnalyzer && provider === "mock";
  const candidateProfile = configs.candidateProfile;
  const semanticMatchingMode = effectiveSemanticMatchingMode(configs);

  return async function analyzeJob(job, { signal = null } = {}) {
    throwIfOperationAborted(signal);
    const ruleMatch = explainJobMatch(job, configs, keywordPlan);
    const facts = jobFacts(job);
    const contentHash = sourceContentHash(facts);
    const revision = buildAnalysisRevision(configs, contentHash);
    if (ruleOnly) return createRuleOnlyAnalysis(configs, job, ruleMatch, revision);
    if (!candidateProfile || typeof candidateProfile !== "object") {
      const missingProfileError = Object.assign(
        new Error("候选人画像不存在，无法执行语义匹配。"),
        { code: "CANDIDATE_PROFILE_REQUIRED" }
      );
      if (errorMode === "throw") {
        logger?.warn("job_analysis_failed", {
          jobId: job.sourceId || job.url || "",
          errorCode: missingProfileError.code,
          errorMessage: missingProfileError.message
        });
        throw missingProfileError;
      }
      return failedAnalysis(configs, job, revision, missingProfileError);
    }

    try {
      const jobUnderstanding = await cachedModelCall({
        db,
        configs,
        logger,
        kind: "understandJob",
        pipelineVersion: PIPELINE_VERSIONS.understandJob,
        input: { job: { ...facts, sourceContentHash: contentHash } },
        signal,
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
          candidateMatchCard: configs.matchingCard || null,
          jobUnderstanding,
          searchPreferences: searchPreferences(configs),
          semanticMatchingMode,
          modelRecommendationMode: semanticMatchingMode === "split"
            ? "off"
            : (configs.modelRecommendationMode || DECISION_POLICY.modelRecommendationMode)
        },
        signal,
        run: analyzer.matchJob
      });
      const analysis = compactAnalysis(configs, { job, jobUnderstanding, matchDecision, ruleMatch, revision });
      return applyRuleGuard(analysis, job);
    } catch (error) {
      logger?.warn("job_analysis_failed", {
        jobId: job.sourceId || job.url || "",
        errorCode: error?.code || "MODEL_ANALYSIS_FAILED",
        errorMessage: error?.message || String(error)
      });
      if (signal?.aborted) throw signalAbortReason(signal);
      if (errorMode === "throw") {
        if (!error.stage && error.modelStage) error.stage = error.modelStage;
        if (!error.phase && error.modelPhase) error.phase = error.modelPhase;
        throw error;
      }
      return applyRuleGuard(failedAnalysis(configs, job, revision, error), job);
    }
  };
}

async function runWorkflowAnalysisPhase(db, input = {}) {
  const workflowRun = input.workflowRun;
  const runId = String(workflowRun?.id || "").trim();
  if (!runId) {
    throw workflowPhaseError(
      "WORKFLOW_PHASE_RUN_ID_REQUIRED",
      "runWorkflowAnalysisPhase requires workflowRun.id"
    );
  }
  const batchId = Number(input.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    throw workflowPhaseError(
      "WORKFLOW_PHASE_BATCH_ID_REQUIRED",
      "runWorkflowAnalysisPhase requires a numeric batchId"
    );
  }
  const jobs = Array.isArray(input.jobsToAnalyze) ? input.jobsToAnalyze : [];
  const modelRuntimes = input.modelRuntimes && typeof input.modelRuntimes === "object"
    ? input.modelRuntimes
    : {};
  const primaryRuntime = modelRuntimes.primary && typeof modelRuntimes.primary === "object"
    ? modelRuntimes.primary
    : {};
  const backupRuntime = modelRuntimes.backup && typeof modelRuntimes.backup === "object"
    ? modelRuntimes.backup
    : null;
  const logger = input.logger && typeof input.logger === "object" ? input.logger : {};
  const now = typeof input.now === "function" ? input.now : () => new Date().toISOString();
  const revision = String(
    primaryRuntime.revision || workflowRun.modelConfigRevision || "cli-batch-scan"
  ).trim();
  const metrics = input.metrics && typeof input.metrics === "object" ? input.metrics : {};

  const entries = jobs
    .map((job, index) => ({
      jobId: Number(job.id ?? job.jobId),
      observationId: Number(job.observationId ?? job.observation_id),
      position: index + 1
    }))
    .filter((entry) => (
      Number.isInteger(entry.jobId) && entry.jobId > 0
      && Number.isInteger(entry.observationId) && entry.observationId > 0
    ));
  const readyEntries = selectReadyWorkflowJobEntries(db, { batchId, entries });

  transitionWorkflowRun(db, {
    id: runId,
    status: "analyzing",
    modelConfigRevision: revision,
    metrics
  });
  reactivateWorkflowDetailRequiredTasks(db, {
    workflowRunId: runId,
    batchId,
    jobs: readyEntries,
    modelConfigRevision: revision,
    now: now()
  });
  initializeWorkflowJobTasks(db, {
    workflowRunId: runId,
    batchId,
    jobs: entries,
    modelConfigRevision: revision,
    now: now()
  });
  // Production resume/analysis path: before claiming anything, recover any
  // running task whose lease expired while a previous child disappeared, so
  // the queue can drain instead of stalling on permanently running rows.
  recoverExpiredWorkflowJobTasks(db, { workflowRunId: runId, now: now() });

  const keywordPlan = Array.isArray(input.keywordPlan) ? input.keywordPlan : [];
  const summary = await runWorkflowAnalysis({
    db,
    workflowRunId: runId,
    primaryRuntime,
    backupRuntime,
    createAnalyzeJob: input.createAnalyzeJob || ((runtime, options) => createJobAnalysisRunner(
      { ...(input.configs || {}), model: runtime?.modelConfig || input.configs?.model },
      keywordPlan,
      { db, logger: options?.logger || logger, errorMode: "throw" }
    )),
    analyzeScannedJob: input.analyzeScannedJob || (async (raw, { analyzeJob, signal }) => analyzeJob(raw, { signal })),
    logger,
    now,
    sleep: typeof input.sleep === "function" ? input.sleep : undefined,
    random: typeof input.random === "function" ? input.random : undefined,
    retryBackoffMs: Array.isArray(input.retryBackoffMs) ? input.retryBackoffMs : undefined,
    workerIdFactory: typeof input.workerIdFactory === "function" ? input.workerIdFactory : undefined,
    signal: input.signal && typeof input.signal === "object" ? input.signal : null
  });

  if (summary.status !== "drained") return summary;
  const counts = countWorkflowJobTaskStatusesForRun(db, runId);
  if (counts.pending > 0 || counts.running > 0 || counts.retryPending > 0) {
    throw workflowPhaseError(
      "WORKFLOW_PHASE_QUEUE_NOT_DRAINED",
      `workflow ${runId} analysis queue is not drained`
    );
  }
  if (input.reviewIfDrained === false) return summary;

  const inventoryCount = listWorkflowInventory(db, { planId: workflowRun.planId }).length;
  const reviewedMetrics = {
    ...metrics,
    analyzed: completedWorkflowAnalysisCount(counts),
    saved: completedWorkflowAnalysisCount(counts),
    inventoryCount,
    eligible: inventoryCount
  };
  const reviewed = transitionWorkflowRun(db, {
    id: runId,
    status: "review_required",
    inventoryCount,
    metrics: reviewedMetrics
  });
  if (typeof input.renderReports === "function") {
    input.renderReports(db, batchId, { workflow: reviewed, counts });
  }
  return summary;
}

function workflowPhaseError(code, message) {
  return Object.assign(new Error(message), { code });
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
    industryContext: "",
    selectedTrackId: "",
    selectedTrackLabel: "",
    roleSummary: "",
    businessScenario: "",
    responsibilityEvidence: [],
    responsibilityMatches: [],
    roleAlignment: "",
    roleResumeEvidence: [],
    roleGaps: [],
    coreRequirements: [],
    requirementMatches: [],
    hiddenRisks: [],
    recommendation: null,
    decisionStatus: "needs_retry",
    fitLevel: null,
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

async function cachedModelCall({ db, configs, logger = null, kind, pipelineVersion, input, signal = null, run }) {
  throwIfOperationAborted(signal);
  const modelConfig = configs.model || {};
  const provider = modelConfig.provider || "mock";
  const providerConfig = modelConfig.providers?.[provider] || {};
  const model = modelConfig.model || providerConfig.model || "";
  const inferenceVersion = modelInferenceVersion({
    provider,
    baseUrl: modelConfig.baseUrl ?? providerConfig.baseUrl,
    model,
    thinkingMode: modelConfig.thinkingMode ?? providerConfig.thinkingMode,
    reasoningEffort: modelConfig.reasoningEffort ?? providerConfig.reasoningEffort
  });
  const inputHash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const cacheKey = crypto.createHash("sha256").update(
    `${provider}|${model}|${inferenceVersion}|${kind}|${pipelineVersion}|${inputHash}`
  ).digest("hex");
  // matchJob 的跨字段核对需要本次 JobUnderstanding 作为最小上下文，
  // 让缓存读取、首次校验和契约修复使用同一份判定依据。
  const validationContext = kind === "matchJob" ? {
    jobUnderstanding: input?.jobUnderstanding,
    modelRecommendationMode: input?.modelRecommendationMode || DECISION_POLICY.modelRecommendationMode
  } : undefined;
  if (db) {
    const cached = getModelCache(db, cacheKey);
    if (cached) {
      try {
        const result = validateModelResult(kind, cached.result, validationContext);
        throwIfOperationAborted(signal);
        logger?.info("model_cache_hit", { kind, provider, model, pipelineVersion });
        logger?.info("model_call_completed", { kind, provider, model, cacheHit: true, latencyMs: 0, attempts: 0, httpStatus: null, usage: null, jsonModeFallback: false });
        return result;
      } catch (error) {
        if (error?.code !== "MODEL_CONTRACT_INVALID") {
          error.modelStage = kind;
          error.modelPhase = "initial";
          throw error;
        }
        logger?.warn("model_cache_contract_invalid", { kind, provider, model, pipelineVersion, errorMessage: error.message });
      }
    }
  }

  let result;
  let rawResult;
  try {
    rawResult = await run(input, { signal });
    throwIfOperationAborted(signal);
    result = validateModelResult(kind, rawResult, validationContext);
  } catch (error) {
    if (error?.code !== "MODEL_CONTRACT_INVALID" || error?.modelRepairHandled) {
      error.modelStage ||= kind;
      error.modelPhase ||= "initial";
      throw error;
    }
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
      }, { signal });
      throwIfOperationAborted(signal);
      result = validateModelResult(kind, repaired, validationContext);
      logger?.info("model_contract_repair_completed", { kind, provider, model, pipelineVersion });
    } catch (repairError) {
      logger?.warn("model_contract_repair_failed", {
        kind, provider, model, pipelineVersion,
        initialErrorMessage: error.message,
        errorMessage: repairError?.message || String(repairError),
        outputShape: contractOutputShape(repairError?.invalidOutput)
      });
      repairError.modelStage = kind;
      repairError.modelPhase = "contract_repair";
      throw repairError;
    }
  }
  throwIfOperationAborted(signal);
  if (db) saveModelCache(db, { cacheKey, kind, provider, model, inputHash, result });
  logger?.info("model_cache_saved", { kind, provider, model, pipelineVersion });
  return result;
}

function throwIfOperationAborted(signal) {
  if (signal?.aborted) throw signalAbortReason(signal);
}

function signalAbortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("operation aborted"), {
    name: "AbortError",
    code: "OPERATION_ABORTED"
  });
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
  const ruleMatch = parts.ruleMatch || {};
  const job = parts.job || {};
  const versionId = decision.recommendedResumeVersion || ruleMatch.recommendedResumeVersion || "";
  const fullJd = hasCompleteJobDescription(job);
  const semanticMatchingMode = effectiveSemanticMatchingMode(configs);
  return {
    provider,
    model,
    semanticStatus: fullJd ? "complete" : "partial",
    decisionSource: "model",
    error: "",
    errorCode: "",
    realRoleType: job.employmentType && job.employmentType !== "unknown"
      ? job.employmentType
      : understanding.realRoleType || "",
    industryContext: understanding.industryContext || "未明确",
    selectedTrackId: decision.selectedTrackId || "",
    selectedTrackLabel: decision.selectedTrackLabel || "",
    roleSummary: decision.roleSummary || "",
    responsibilityEvidence: decision.responsibilityEvidence || [],
    responsibilityMatches: decision.responsibilityMatches || [],
    businessScenario: understanding.businessScenario || "",
    coreResponsibilities: understanding.coreResponsibilities || [],
    coreRequirements: (understanding.coreRequirements || []).map((item) => typeof item === "string" ? item : item.label).filter(Boolean),
    coreStack: understanding.coreStack || [],
    eligibilityConstraints: understanding.eligibilityConstraints || [],
    hiddenRisks: understanding.hiddenRisks || [],
    senioritySignal: understanding.senioritySignal || "unknown",
    requirementMatches: decision.requirementMatches || [],
    roleAlignment: decision.roleAlignment || "",
    roleResumeEvidence: decision.roleResumeEvidence || [],
    roleGaps: decision.roleGaps || [],
    jobQuality: decision.jobQuality || understanding.jobQuality || { level: "normal", concerns: [] },
    recommendation: null,
    decisionStatus: "pending",
    modelRecommendation: decision.modelRecommendation,
    semanticMatchingMode,
    modelRecommendationMode: semanticMatchingMode === "split"
      ? "off"
      : (configs.modelRecommendationMode || DECISION_POLICY.modelRecommendationMode),
    recommendationSchemaVersion: RECOMMENDATION_SCHEMA_VERSION,
    decisionPolicyHash: DECISION_POLICY_HASH,
    fitLevel: decision.fitLevel,
    confidence: decision.confidence,
    recommendedResumeVersion: versionId,
    recommendedResumeVersionName: resumeVersionName(configs.resumeVersions, versionId),
    primaryProjects: decision.primaryProjects?.length ? decision.primaryProjects : (ruleMatch.primaryProjects || []),
    fitReasons: decision.fitReasons || [],
    hardBlockers: decision.hardBlockers || [],
    softGaps: decision.softGaps || decision.missingPoints || [],
    questionsToVerify: decision.questionsToVerify || decision.riskQuestions || [],
    missingPoints: decision.softGaps || decision.missingPoints || [],
    blockingGaps: decision.blockingGaps || (decision.hardBlockers || []).map((item) => hardBlockerText(item)).filter(Boolean),
    riskQuestions: decision.questionsToVerify || decision.riskQuestions || [],
    evidence: decision.evidence || { jd: [], resume: [] },
    greetingAngle: decision.greetingAngle || ruleMatch.greetingAngle || "",
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
    errorStage: error?.modelStage || "",
    errorPhase: error?.modelPhase || "",
    errorResponseKind: error?.responseFailureKind || "",
    errorRequestedMaxTokens: Number.isFinite(Number(error?.requestedMaxTokens))
      ? Number(error.requestedMaxTokens)
      : null,
    errorHttpStatus: Number.isInteger(Number(error?.httpStatus || error?.status))
      && Number(error?.httpStatus || error?.status) >= 100
      && Number(error?.httpStatus || error?.status) <= 599
      ? Number(error?.httpStatus || error?.status)
      : null,
    errorJsonModeApplied: typeof error?.jsonModeApplied === "boolean"
      ? error.jsonModeApplied
      : null,
    errorContentLength: Number.isInteger(Number(error?.contentLength))
      && Number(error.contentLength) >= 0
      && Number(error.contentLength) <= 10000000
      ? Number(error.contentLength)
      : null,
    errorContentTypeKind: error?.responseContentTypeKind || "",
    errorEnvelopeKind: error?.responseEnvelopeKind || "",
    errorParseFailureKind: error?.responseParseFailureKind || "",
    errorHadUtf8Bom: typeof error?.responseHadUtf8Bom === "boolean"
      ? error.responseHadUtf8Bom
      : null,
    realRoleType: "",
    industryContext: "",
    selectedTrackId: "",
    selectedTrackLabel: "",
    roleSummary: "",
    businessScenario: "",
    responsibilityEvidence: [],
    responsibilityMatches: [],
    roleAlignment: "",
    roleResumeEvidence: [],
    roleGaps: [],
    coreRequirements: [],
    requirementMatches: [],
    hiddenRisks: [],
    recommendation: null,
    decisionStatus: "needs_retry",
    fitLevel: null,
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

  // 一、本地已确认的基础边界不依赖模型语义，可直接排除。
  if (gate === "blocked") {
    const semanticStatus = analysis.semanticStatus === "complete" ? "complete" : "blocked";
    return addGuard(
      analysis,
      "not_recommended",
      "no_fit",
      hardBoundaryReason(job, qualityTags),
      semanticStatus,
      "hard_boundary"
    );
  }

  // 二、技术失败和证据未完成不伪装成四档建议。模型 hardBlocker 与岗位风险
  // 可能来自失败或过期的分析对象，必须等语义状态完整后才能参与定档。
  if (gate === "refresh") {
    return needsRetry(analysis, "岗位信息需要刷新后重新分析。");
  }
  if (["failed", "stale", "pending"].includes(analysis.semanticStatus)) {
    return needsRetry(analysis);
  }
  if (analysis.semanticStatus === "partial") {
    return needsRetry(analysis, "当前只有卡片级信息，完整 JD 补齐前不进入判定。");
  }
  // 三、完整语义结果中的明确硬边界优先于加权匹配结果。
  const hardBlockers = decisionHardBlockers(analysis);
  if (hardBlockers.length) {
    return addGuard(
      { ...analysis, hardBlockers },
      "not_recommended",
      "no_fit",
      `存在不可沟通的硬性缺口：${hardBlockerText(hardBlockers[0])}`,
      analysis.semanticStatus,
      "hard_blocker_guard"
    );
  }
  if (analysis.jobQuality?.level === "risk") {
    return addGuard(
      analysis,
      "not_recommended",
      "no_fit",
      "岗位存在安全或合规风险，不建议投递。",
      analysis.semanticStatus,
      "job_quality_risk_guard"
    );
  }
  if (!DECISION_POLICY.matrix[analysis.roleAlignment]) {
    return needsRetry(analysis, "岗位方向证据不足，等待补充后重新判定。");
  }

  // 四、代码计算 70/30 加权结果并查四档二维表。模型 shadow 建议不参与。
  const decisionMetrics = deriveMatrixDecision({
    roleAlignment: analysis.roleAlignment,
    requirementMatches: analysis.requirementMatches,
    responsibilityMatches: analysis.responsibilityMatches
  });
  let guarded = {
    ...analysis,
    recommendation: decisionMetrics.matrixRecommendation,
    decisionStatus: "decided",
    decisionSource: "weighted_decision_matrix",
    fitLevel: decisionMetrics.fitBand,
    decisionMetrics,
    recommendationSchemaVersion: RECOMMENDATION_SCHEMA_VERSION,
    decisionPolicyHash: DECISION_POLICY_HASH
  };

  // 五、已有产品安全信号只能向下封顶，不能反向提升。
  if (qualityTags.has("eligibility_review") && guarded.recommendation !== "not_recommended") {
    guarded = addGuard(
      guarded,
      capRecommendationTier(guarded.recommendation, "caution"),
      guarded.fitLevel,
      "资格待确认：岗位存在届别或在校条件，需要确认后再决定。",
      guarded.semanticStatus,
      "eligibility_review_guard"
    );
  }
  if (qualityTags.has("experience_stretch") || qualityTags.has("experience_overrange") || qualityTags.has("experience_salary_overlap")) {
    guarded = capGuard(
      guarded,
      "apply",
      "岗位年限高于候选人当前经历，最高归入可投。",
      "experience_stretch_guard"
    );
  }
  if (qualityTags.has("salary_target_high") || qualityTags.has("experience_salary_overlap")) {
    guarded = capGuard(
      guarded,
      "caution",
      "岗位薪资或经验跨度需要先确认，最高归入慎投。",
      "salary_stretch_guard"
    );
  }
  if (hasTransferableIndispensable(analysis)) {
    guarded = capGuard(
      guarded,
      "apply",
      "核心硬性要求只有可迁移证据，最高归入可投。",
      "indispensable_transferable_guard"
    );
  }
  if (hasShadowResponsibilitySprawlCaution(analysis) && guarded.recommendation !== "not_recommended") {
    guarded = capGuard(
      guarded,
      "caution",
      "岗位存在职责发散，且模型语义建议慎投，最高归入慎投。",
      "model_quality_caution_guard"
    );
  }
  const materialRisk = (analysis.hiddenRisks || []).find((risk) => (
    risk?.type !== "responsibility_sprawl"
      && ["medium", "high"].includes(risk?.severity)
  ));
  if (materialRisk && guarded.recommendation !== "not_recommended") {
    const evidence = materialRisk.evidence ? `：${materialRisk.evidence}` : "";
    guarded = capGuard(
      guarded,
      "caution",
      `岗位存在需要先沟通确认的风险${evidence}`,
      "semantic_risk_guard"
    );
  }

  // 六、缺少双侧证据属于分析未完成，不进入四档。
  if (missingEitherSideEvidence(guarded)) {
    return needsRetry(guarded, "模型结论缺少可核对的双侧证据，标记待重试。", "model_evidence_gap");
  }

  return guarded;
}

function hardBoundaryReason(job, qualityTags) {
  const risks = Array.isArray(job?.risks) ? job.risks.filter(Boolean) : [];
  const selectors = [
    ["cohort_mismatch", /届|毕业年份/],
    ["student_status_mismatch", /在校|已毕业/],
    ["internship_role", /实习/],
    ["part_time_role", /兼职|小时/]
  ];
  for (const [tag, pattern] of selectors) {
    if (!qualityTags.has(tag)) continue;
    const risk = risks.find((item) => pattern.test(String(item)));
    if (risk) return risk;
  }
  return "已确认的基础条件不满足。";
}

function effectiveSemanticMatchingMode(configs = {}) {
  const mode = String(
    configs.semanticMatchingMode
      || configs.model?.semanticMatchingMode
      || "split"
  ).trim().toLowerCase();
  if (!["split", "legacy"].includes(mode)) {
    throw new Error("semanticMatchingMode must be split or legacy");
  }
  return mode;
}

function hasTransferableIndispensable(analysis) {
  return (analysis.requirementMatches || []).some((item) => (
    item?.state === "transferable" && item?.indispensable === true
  ));
}

function hasShadowResponsibilitySprawlCaution(analysis) {
  return analysis?.modelRecommendation === "caution"
    && analysis?.jobQuality?.level === "caution"
    && (analysis.jobQuality.concerns || []).some((concern) => concern?.type === "responsibility_sprawl");
}

function missingEitherSideEvidence(analysis) {
  const evidence = analysis.evidence || {};
  return !(evidence.jd || []).length || !(evidence.resume || []).length;
}

function addGuard(analysis, recommendation, fitLevel, reason, semanticStatus = analysis.semanticStatus, decisionSource = analysis.decisionSource) {
  return {
    ...analysis,
    semanticStatus,
    decisionSource,
    recommendation,
    decisionStatus: "decided",
    fitLevel,
    fitReasons: [reason, ...(analysis.fitReasons || []).filter((item) => item && item !== reason)],
    ruleAdjusted: true
  };
}

function capGuard(analysis, cap, reason, decisionSource) {
  const recommendation = capRecommendationTier(analysis.recommendation, cap);
  if (recommendation === analysis.recommendation) return analysis;
  return addGuard(analysis, recommendation, analysis.fitLevel, reason, analysis.semanticStatus, decisionSource);
}

function needsRetry(analysis, reason = "", decisionSource = "needs_retry") {
  return {
    ...analysis,
    recommendation: null,
    decisionStatus: "needs_retry",
    decisionSource,
    fitLevel: null,
    decisionMetrics: null,
    fitReasons: reason
      ? [reason, ...(analysis.fitReasons || []).filter((item) => item && item !== reason)]
      : (analysis.fitReasons || []),
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

function resumeVersionName(resumeVersions, id) {
  return (resumeVersions?.versions || []).find((version) => version.id === id)?.name || id || "";
}

module.exports = {
  createJobAnalysisRunner,
  runWorkflowAnalysisPhase,
  compactAnalysis,
  createRuleOnlyAnalysis,
  cachedModelCall,
  applyRuleGuard,
  jobFacts
};
