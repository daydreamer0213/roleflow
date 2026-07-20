const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  listReportJobs,
  createBatch,
  getBatch,
  getLatestResumableBatch,
  upsertJob,
  markApplication,
  markCandidateJob,
  addFollowUpNote,
  buildBatchSummary,
  buildFeedbackSummary,
  getLatestBatchId,
  getLatestMainScanBatchId,
  getCandidateProfile,
  listCandidateProfiles,
  getSearchPlan,
  getActiveSearchPlan,
  getPlatformFilterCatalog,
  getSiteRuntimeState,
  getSiteScanLease,
  createScanRun,
  getWorkflowRun,
  transitionWorkflowRun,
  getLatestScanRun,
  recordScanRunProcessExit,
  interruptOrphanedScanRuns,
  saveProfileAnalysis,
  attachResumeDocumentFile,
  getResumeDocument,
  updateCandidateProfile,
  saveCandidateResumeVersion,
  listCandidateResumeVersions,
  recordResumeParseAttempt,
  listResumeParseAttempts,
  saveSearchPlan,
  rescorePlanObservations,
  compareProfileVersions,
  getSearchPlanDependency,
  listDecisionPool,
  listDecisionQueue,
  recordCandidateJobEvent,
  recordRecommendationFeedback,
  saveCandidateFact,
  listCandidateFacts,
  isJobAwaitingAction,
  OUTCOME_STATUSES
} = require("../core/storage");
const {
  createCommunicationBatch,
  getCommunicationBatch,
  listCommunicationBatchItems,
  setCommunicationBatchStatus,
  resolveAmbiguousCommunicationItem,
  transitionCommunicationItem,
  communicationBatchSummary,
  communicationQuotaSnapshot
} = require("../core/communication_batches");
const { parseResumeUpload, parseResumeText, MAX_UPLOAD_BYTES } = require("../core/resume_parser");
const { analyzeResumeProfile, recommendPlanForProfile, prepareResumeTextForModel } = require("../core/profile_onboarding");
const { createLlmAnalyzer } = require("../core/llm_analyzer");
const { normalizeCandidateProfile, normalizeSearchPlan } = require("../core/profile_schema");
const { CITY_CODES, planKeywords, profileToRuntimeConfigs, resolveScanPolicy } = require("../core/search_plan");
const { resolveNativeFilterSnapshot, formatNativeFilterSummary } = require("../core/platform_filters");
const { loadConfigs } = require("../config");
const { validateSearchPlan, assertSearchPlanReady } = require("../core/plan_validation");
const { createLogger, appError, errorMeta, publicError } = require("../core/observability");
const { listModelPresets, loadModelSettings, saveVerifiedModelConfiguration, testModelConnection, resolveRuntimeModelConfig, isModelReady } = require("../core/model_settings");
const { FEEDBACK_REASON_OPTIONS, normalizeFeedbackReason, feedbackReasonLabel } = require("../core/feedback");
const { storeResumeSourceFile, resolveResumeSourceFile } = require("../core/resume_files");
const { PRODUCT_POLICY } = require("../core/product_policy");
const { communicationCalibrationStatus, assertCommunicationExecutionEnabled } = require("../core/communication_calibration");
const { buildScanCliArgs } = require("../core/scan_execution");
const { scoreJob, decisionState } = require("../core/scoring");
const { createJobAnalysisRunner } = require("../core/job_analysis");
const boss = require("../adapters/sites/boss");

const VALID_STATUSES = new Set(OUTCOME_STATUSES);

function createDashboardServer({ db, root = path.resolve(__dirname, "../.."), dbPath = "", modelConfig = { provider: "mock", providers: { mock: {} } }, allowOfflineMock = false, forceMock = false, connectionTester = testModelConnection, logger = createLogger({ root, component: "dashboard" }), spawnProcess = spawn }) {
  const scanRuns = new Map();
  const orphaned = interruptOrphanedScanRuns(db, { site: "boss", heartbeatTimeoutMs: PRODUCT_POLICY.operations.scanOrphanTimeoutMs });
  if (orphaned.interrupted) logger.warn("orphaned_scan_runs_interrupted", orphaned);
  const offlineMockState = {
    source: "runtime",
    settings: { preset: "mock", provider: "mock", baseUrl: "", model: "offline-structured-mock", timeoutMs: 30000, connection: { status: "verified" } },
    keyConfigured: false,
    modelConfig: { provider: "mock", providers: { mock: { model: "offline-structured-mock" } } }
  };
  const getPublicModelSettings = () => forceMock ? offlineMockState : loadModelSettings({ root, fallbackModelConfig: modelConfig });
  const getRuntimeModelConfig = () => forceMock ? offlineMockState.modelConfig : resolveRuntimeModelConfig({ root, fallbackModelConfig: modelConfig }).modelConfig;
  const modelReady = () => allowOfflineMock || isModelReady(getPublicModelSettings());
  return http.createServer(async (req, res) => {
    const requestId = logger.requestId();
    const startedAt = Date.now();
    let url;
    res.on("finish", () => logger.info("http_request_completed", { requestId, method: req.method, path: url?.pathname || req.url, statusCode: res.statusCode, durationMs: Date.now() - startedAt }));
    try {
      url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") return redirectHome(res, db);
      if (req.method === "GET" && url.pathname === "/onboarding") return sendHtml(res, renderOnboarding({ profiles: listCandidateProfiles(db), modelState: getPublicModelSettings(), modelReady: modelReady(), selectedProfileId: url.searchParams.get("profileId") }));
      if (req.method === "GET" && url.pathname === "/settings") return sendHtml(res, renderModelSettingsPage({ modelState: getPublicModelSettings(), searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/profile") return sendHtml(res, renderProfilePage({ db, searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/resumes") return sendHtml(res, renderResumeVersionsPage({ db, searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/resume-file") return handleResumeFile(req, res, { db, root, searchParams: url.searchParams });
      if (req.method === "GET" && url.pathname === "/plan") return sendHtml(res, renderPlanPage({ db, searchParams: url.searchParams, modelConfig: getPublicModelSettings().modelConfig, scanRuns }));
      if (req.method === "GET" && url.pathname === "/queue") return sendHtml(res, renderQueuePage({ db, searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/communication/new") return sendHtml(res, renderCommunicationBuilderPage({ db, searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/communication") return sendHtml(res, renderCommunicationReviewPage({ db, searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/jobs") return sendHtml(res, renderDashboard(getDashboardData(db, url.searchParams)));
      if (req.method === "GET" && url.pathname === "/diagnostics") return sendHtml(res, renderDiagnosticsPage(logger.listRecent()));
      if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, logging: "enabled" });
      if (req.method === "GET" && url.pathname === "/api/scan-status") return sendJson(res, 200, scanStatus(scanRuns, url.searchParams.get("planId"), db));
      if (req.method === "GET" && url.pathname === "/api/communication-status") return handleCommunicationStatus(res, db, url.searchParams.get("batchId"));
      if (req.method === "POST" && url.pathname === "/api/communication-batch") return handleCommunicationBatch(req, res, db);
      if (req.method === "POST" && url.pathname === "/api/communication-control") return handleCommunicationControl(req, res, { db, root, dbPath, logger, requestId, spawnProcess });
      if (req.method === "POST" && url.pathname === "/api/communication-resolve") return handleCommunicationResolve(req, res, db);
      if (req.method === "POST" && url.pathname === "/api/mark") return handlePost(req, res, (body, type) => handleMarkApi(db, body, type), { logger, requestId, action: "mark_job" });
      if (req.method === "POST" && url.pathname === "/api/follow-up") return handlePost(req, res, (body, type) => handleFollowUpApi(db, body, type), { logger, requestId, action: "add_follow_up" });
      if (req.method === "POST" && url.pathname === "/api/feedback") return handlePost(req, res, (body, type) => handleRecommendationFeedbackApi(db, body, type), { logger, requestId, action: "recommendation_feedback" });
      if (req.method === "POST" && url.pathname === "/api/communication") return handleCommunication(req, res, { db, modelConfig: getRuntimeModelConfig(), modelReady: modelReady(), logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/analyze-job") return handleJobAnalysisRetry(req, res, { db, root, modelConfig: getRuntimeModelConfig(), modelReady: modelReady(), logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/resume/preview") return handleResumePreview(req, res, { root, logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/resume") return handleResumeUpload(req, res, { db, root, modelConfig: getRuntimeModelConfig(), modelReady: modelReady(), logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/settings/model") return handleModelSettingsSave(req, res, { root, fallbackModelConfig: modelConfig, connectionTester, logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/profile") return handleProfileSave(req, res, db, { logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/resume-version") return handleResumeVersionSave(req, res, { db, root, modelConfig: getRuntimeModelConfig(), modelReady: modelReady(), logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/plan/recommend") return handlePlanRecommend(req, res, { db, modelConfig: getRuntimeModelConfig(), modelReady: modelReady(), logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/plan") return handlePlanSave(req, res, db, { root, logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/scan") return handlePlanScan(req, res, { db, root, dbPath, scanRuns, logger, requestId, spawnProcess });
      sendText(res, 404, "Not found");
    } catch (error) {
      logger.error("http_unhandled_error", { requestId, method: req.method, path: url?.pathname || req.url, error: errorMeta(error) });
      respondUnexpectedError(res, error, requestId, url?.pathname || req.url);
    }
  });
}

function handleResumeFile(_req, res, { db, root, searchParams }) {
  const document = getResumeDocument(db, searchParams.get("id"));
  const filePath = document?.storedFilePath ? resolveResumeSourceFile(root, document.storedFilePath) : "";
  if (!document || !filePath) return sendText(res, 404, "简历原文件不存在或尚未保存。");
  const body = fs.readFileSync(filePath);
  const type = {
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(document.originalFileName || filePath))}`
  });
  res.end(body);
}

async function handleResumePreview(req, res, { root, logger, requestId }) {
  try {
    const form = parseMultipart(await readBodyBuffer(req, MAX_UPLOAD_BYTES + 64 * 1024), req.headers["content-type"] || "");
    const file = form.files.resume || form.files.resumeVersion;
    const pastedText = String(form.fields.resumeText || "").trim();
    if (!file && !pastedText) throw new Error("请选择简历文件，或粘贴完整的简历文本。");
    const resume = file
      ? await parseResumeUpload({ fileName: file.fileName, buffer: file.data, root })
      : parseResumeText({ text: pastedText });
    const prepared = prepareResumeTextForModel(resume.text);
    logger.info("resume_model_input_previewed", { requestId, source: file ? "file" : "pasted_text", charCount: prepared.text.length, redactions: prepared.redactions });
    sendJson(res, 200, { text: prepared.text, charCount: prepared.text.length, redactions: prepared.redactions });
  } catch (error) {
    const issue = publicError(error, { fallbackCode: "RESUME_PREVIEW_FAILED" });
    logger.warn("resume_model_input_preview_failed", { requestId, error: errorMeta(error), errorCode: issue.code });
    sendJson(res, issue.statusCode, { error: issue.message, errorCode: issue.code, requestId });
  }
}

async function handleJobAnalysisRetry(req, res, { db, root, modelConfig, modelReady, logger, requestId }) {
  let planId = 0;
  try {
    if (!modelReady) throw new Error("重试语义分析前，请先让当前模型通过连接测试。");
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    planId = Number(params.planId);
    const jobId = Number(params.jobId);
    const plan = getSearchPlan(db, planId);
    if (!plan) throw new Error("Search Plan 不存在。");
    const profile = getCandidateProfile(db, plan.profileId);
    if (!profile) throw new Error("候选人画像不存在。");
    const job = listDecisionPool(db, { planId }).find((item) => item.id === jobId);
    if (!job) throw new Error("岗位不存在或不属于当前筛选方案。");
    const baseConfigs = loadConfigs(root);
    baseConfigs.model = modelConfig;
    const configs = profileToRuntimeConfigs(baseConfigs, profile.profile, plan.plan, listCandidateResumeVersions(db, profile.id));
    const scored = scoreJob(job, configs);
    if (decisionState(scored) !== "ready") throw new Error("岗位详情或活跃状态仍未补全，请先处理来源信息。");
    const analyze = createJobAnalysisRunner(configs, plan.plan.keywords || [], { db, logger });
    const analysis = await analyze({ ...job, ...scored, greeting: job.greeting || "" });
    const batchId = createBatch(db, job.source || "boss", "analysis-retry", `analysis-retry:plan:${planId}:job:${jobId}`, {
      profileId: profile.id,
      searchPlanId: planId,
      filterSnapshot: { mode: "analysis-retry", jobId }
    });
    upsertJob(db, { ...job, ...scored, analysis, greeting: job.greeting || "" }, batchId);
    logger.info("job_analysis_retried", { requestId, planId, jobId, batchId, semanticStatus: analysis.semanticStatus, provider: analysis.provider, model: analysis.model });
    if (analysis.semanticStatus === "failed") {
      const error = new Error(analysis.error || "语义分析仍未完成，请稍后重试。");
      error.code = analysis.errorCode || "MODEL_ANALYSIS_FAILED";
      throw error;
    }
    redirect(res, `/queue?planId=${planId}`);
  } catch (error) {
    respondUiError(res, error, planId ? `/queue?planId=${planId}&pool=analysis_pending` : "/", { logger, requestId, event: "job_analysis_retry_failed", fallbackCode: "JOB_ANALYSIS_RETRY_FAILED" });
  }
}

function redirectHome(res, db) {
  const profile = listCandidateProfiles(db)[0];
  if (!profile) return redirect(res, "/onboarding");
  const plan = getActiveSearchPlan(db, profile.id);
  if (!plan) return redirect(res, `/onboarding?profileId=${profile.id}`);
  return redirect(res, getLatestBatchId(db, { planId: plan.id }) ? `/queue?planId=${plan.id}` : `/plan?profileId=${plan.profileId}&planId=${plan.id}`);
}

async function handleResumeUpload(req, res, { db, root, modelConfig, modelReady, logger, requestId }) {
  let form = { fields: {}, files: {} };
  let parseRecorded = false;
  try {
    if (!modelReady) throw new Error("请先完成模型配置，再解析简历。");
    form = parseMultipart(await readBodyBuffer(req, MAX_UPLOAD_BYTES + 64 * 1024), req.headers["content-type"] || "");
    const file = form.files.resume;
    const pastedText = String(form.fields.resumeText || "").trim();
    if (!file && !pastedText) throw new Error("请选择简历文件，或粘贴完整的简历文本。");
    let resume;
    try {
      resume = file
        ? await parseResumeUpload({ fileName: file.fileName, buffer: file.data, root })
        : parseResumeText({ text: pastedText });
    } catch (error) {
      const source = file ? `文件“${file.fileName}”` : "粘贴的简历文本";
      error.message = `${source}解析失败：${error.message}`;
      throw error;
    }
    logger.info("resume_parsed", { requestId, source: file ? "file" : "pasted_text", fileName: resume.originalFileName, format: resume.format, charCount: resume.charCount, textTruncated: resume.textTruncated });
    const profile = await analyzeResumeProfile({ modelConfig, resume, logger });
    const saved = saveProfileAnalysis(db, { profileId: form.fields.profileId, profile, document: resume, searchPlan: null });
    persistResumeSourceFile({ db, root, documentId: saved.resumeDocumentId, file, logger, requestId });
    recordResumeParseAttempt(db, { profileId: saved.profileId, document: resume });
    parseRecorded = true;
    logger.info("resume_profile_created", { requestId, profileId: saved.profileId, profileVersionId: saved.profileVersionId, modelProvider: modelConfig?.provider || "mock" });
    try {
      const plan = await recommendPlanForProfile({ modelConfig, profile, logger });
      const planId = saveSearchPlan(db, { profileId: saved.profileId, profileVersionId: saved.profileVersionId, plan });
      logger.info("search_plan_recommended", { requestId, profileId: saved.profileId, planId, profileVersionId: saved.profileVersionId });
      return redirect(res, `/plan?profileId=${saved.profileId}&planId=${planId}&created=1`);
    } catch (error) {
      error.message = `候选人画像和简历版本已保存，但搜索建议生成失败：${error.message}`;
      return respondUiError(res, error, `/profile?profileId=${saved.profileId}`, { logger, requestId, event: "search_plan_recommend_failed", fallbackCode: "SEARCH_PLAN_RECOMMEND_FAILED" });
    }
  } catch (error) {
    const failedFile = form.files?.resume;
    try {
      if (!parseRecorded) recordResumeParseAttempt(db, {
        profileId: form.fields?.profileId,
        fileName: failedFile?.fileName || "pasted_resume.txt",
        format: failedFile?.fileName ? path.extname(failedFile.fileName).slice(1) : "text",
        inputBytes: failedFile?.data?.length || Buffer.byteLength(String(form.fields?.resumeText || ""), "utf8"),
        error
      });
    } catch (recordError) {
      logger.warn("resume_parse_attempt_record_failed", { requestId, error: errorMeta(recordError) });
    }
    respondUiError(res, error, "/onboarding", { logger, requestId, event: "resume_upload_failed", fallbackCode: "RESUME_UPLOAD_FAILED" });
  }
}

async function handleModelSettingsSave(req, res, { root, fallbackModelConfig, connectionTester, logger, requestId }) {
  try {
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    const state = await saveVerifiedModelConfiguration({ root, input: params, fallbackModelConfig, connectionTester });
    logger.info("model_settings_saved", {
      requestId,
      preset: state.settings.preset,
      provider: state.settings.provider,
      model: state.settings.model,
      keyConfigured: state.keyConfigured,
      connectionStatus: state.connectionStatus,
      latencyMs: state.settings.connection?.latencyMs ?? null
    });
    redirect(res, isModelReady(state) ? safeSettingsNext(params.next) + "?modelConfigured=1" : "/settings?required=1&saved=1");
  } catch (error) {
    respondUiError(res, error, "/settings", { logger, requestId, event: "model_settings_save_failed", fallbackCode: "MODEL_SETTINGS_SAVE_FAILED" });
  }
}

async function handleProfileSave(req, res, db, { logger, requestId }) {
  try {
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    const profileId = Number(params.profileId);
    const existing = getCandidateProfile(db, profileId);
    if (!existing) throw new Error("candidate profile not found");
    const profile = profileFromForm(existing.profile, params);
    updateCandidateProfile(db, { profileId, profile });
    logger.info("candidate_profile_updated", { requestId, profileId, skillCount: profile.skills.length, projectCount: profile.projects.length });
    redirect(res, `/profile?profileId=${profileId}&saved=1`);
  } catch (error) {
    respondUiError(res, error, "/onboarding", { logger, requestId, event: "candidate_profile_update_failed", fallbackCode: "PROFILE_SAVE_FAILED" });
  }
}

async function handleResumeVersionSave(req, res, { db, root, modelConfig, modelReady, logger, requestId }) {
  let form = { fields: {}, files: {} };
  try {
    form = parseMultipart(await readBodyBuffer(req, MAX_UPLOAD_BYTES + 64 * 1024), req.headers["content-type"] || "");
    logger.info("resume_version_upload_received", { requestId, fieldNames: Object.keys(form.fields), fileFields: Object.keys(form.files) });
    const profileId = Number(form.fields.profileId);
    if (!getCandidateProfile(db, profileId)) throw new Error("candidate profile not found");
    const file = form.files.resumeVersion;
    const pastedText = String(form.fields.resumeText || "").trim();
    let document = null;
    if (file || pastedText) {
      document = file
        ? await parseResumeUpload({ fileName: file.fileName, buffer: file.data, root })
        : parseResumeText({ text: pastedText, fileName: "pasted_resume_version.txt" });
    }
    if (!document && !Number(form.fields.versionId)) throw new Error("请选择简历文件、粘贴简历文本，或编辑已有版本。");
    let analysis = null;
    if (document) {
      if (!modelReady) throw new Error("新增或替换简历版本需要可用模型，请先在模型设置中完成连接测试。");
      analysis = await analyzeResumeProfile({ modelConfig, resume: document, logger });
    }
    const saved = saveCandidateResumeVersion(db, {
      profileId,
      versionId: form.fields.versionId,
      document,
      version: { ...resumeVersionFromForm(form.fields), analysis }
    });
    persistResumeSourceFile({ db, root, documentId: saved.resumeDocumentId, file, logger, requestId });
    if (document) recordResumeParseAttempt(db, { profileId, document });
    logger.info("resume_version_saved", { requestId, profileId, versionId: saved.versionId, hasDocument: Boolean(document) });
    redirect(res, `/resumes?profileId=${profileId}&saved=1`);
  } catch (error) {
    const profileId = Number(form.fields?.profileId || 0);
    const file = form.files?.resumeVersion;
    try {
      if (profileId) recordResumeParseAttempt(db, {
        profileId,
        fileName: file?.fileName || "pasted_resume_version.txt",
        format: file?.fileName ? path.extname(file.fileName).slice(1) : "text",
        inputBytes: file?.data?.length || Buffer.byteLength(String(form.fields?.resumeText || ""), "utf8"),
        error
      });
    } catch (recordError) {
      logger.warn("resume_version_parse_attempt_record_failed", { requestId, error: errorMeta(recordError) });
    }
    const back = profileId ? `/resumes?profileId=${profileId}` : "/onboarding";
    respondUiError(res, error, back, { logger, requestId, event: "resume_version_save_failed", fallbackCode: "RESUME_VERSION_SAVE_FAILED" });
  }
}

function persistResumeSourceFile({ db, root, documentId, file, logger, requestId }) {
  if (!file || !documentId) return;
  try {
    const storedFilePath = storeResumeSourceFile({ root, documentId, fileName: file.fileName, buffer: file.data });
    attachResumeDocumentFile(db, documentId, storedFilePath);
    logger.info("resume_source_file_saved", { requestId, documentId, storedFilePath, bytes: file.data.length });
  } catch (error) {
    logger.warn("resume_source_file_save_failed", { requestId, documentId, error: errorMeta(error) });
  }
}

async function handlePlanRecommend(req, res, { db, modelConfig, modelReady, logger, requestId }) {
  try {
    if (!modelReady) throw new Error("生成搜索建议需要可用模型，请先完成模型连接测试。");
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    const profile = getCandidateProfile(db, Number(params.profileId));
    if (!profile) throw new Error("候选人画像不存在，请重新上传简历。");
    const plan = await recommendPlanForProfile({ modelConfig, profile: profile.profile, logger });
    const planId = saveSearchPlan(db, { profileId: profile.id, plan });
    logger.info("search_plan_recommended", { requestId, profileId: profile.id, planId });
    redirect(res, `/plan?profileId=${profile.id}&planId=${planId}&created=1`);
  } catch (error) {
    respondUiError(res, error, "/onboarding", { logger, requestId, event: "search_plan_recommend_failed", fallbackCode: "SEARCH_PLAN_RECOMMEND_FAILED" });
  }
}

function profileFromForm(existing, params) {
  const candidate = existing.candidate || {};
  const profile = {
    ...existing,
    candidate: {
      ...candidate,
      name: String(params.name || candidate.name || "").trim(),
      city: String(params.city || candidate.city || "").trim(),
      targetTitles: splitTerms(params.targetTitles),
      expectedSalary: String(params.expectedSalary || "").trim(),
      adjustableSalary: splitTerms(params.adjustableSalary)
    },
    education: parseEducationLines(params.education),
    experiences: parseExperienceLines(params.experiences),
    skills: parseSkillLines(params.skills),
    projects: parseProjectLines(params.projects),
    credentials: parseCredentialLines(params.credentials),
    strengths: splitLines(params.strengths),
    source: existing.source || {}
  };
  return normalizeCandidateProfile(profile, {
    provider: existing.source?.provider || "manual",
    model: existing.source?.model || "manual",
    resumeTextLength: existing.source?.resumeTextLength || 0,
    allowRiskMessaging: true
  });
}

function parseSkillLines(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, ...evidence] = line.split("|").map((item) => item.trim());
    return { name, level: "manual", evidence: splitTerms(evidence.join(",")) };
  });
}

function parseProjectLines(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, period, context, roleBoundary, canSay, technologies, results, avoidSaying] = line.split("|").map((item) => item.trim());
    return { name, period, context, roleBoundary: roleBoundary || "按实际参与边界表达", canSay: splitTerms(canSay), technologies: splitTerms(technologies), results: splitTerms(results), avoidSaying: splitTerms(avoidSaying) };
  });
}

function parseEducationLines(value) {
  return splitLines(value).map((line) => {
    const [school, degree, major, startDate, endDate, status, highlights] = line.split("|").map((item) => item.trim());
    return { school, degree, major, startDate, endDate, status, highlights: splitTerms(highlights) };
  });
}

function parseExperienceLines(value) {
  return splitLines(value).map((line) => {
    const [organization, role, type, startDate, endDate, roleBoundary, highlights, technologies] = line.split("|").map((item) => item.trim());
    return { organization, role, type, startDate, endDate, roleBoundary, highlights: splitTerms(highlights), technologies: splitTerms(technologies) };
  });
}

function parseCredentialLines(value) {
  return splitLines(value).map((line) => {
    const [name, ...details] = line.split("|").map((item) => item.trim());
    return { name, details: details.join(" | ") };
  });
}

function splitLines(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function resumeVersionFromForm(fields) {
  return {
    name: String(fields.name || "").trim() || "简历版本",
    targetRoles: splitTerms(fields.targetRoles),
    keywords: splitTerms(fields.keywords),
    primaryProjects: splitTerms(fields.primaryProjects),
    summary: String(fields.summary || "").trim(),
    isActive: fields.isActive === "on"
  };
}

async function handlePlanSave(req, res, db, { root, logger, requestId }) {
  try {
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    const profileId = Number(params.profileId);
    const profile = getCandidateProfile(db, profileId);
    if (!profile) throw new Error("候选人画像不存在，请重新上传简历。");
    const experience = splitTerms(params.experience);
    const plan = normalizeSearchPlan({
      name: params.name,
      cities: splitTerms(params.cities),
      salaryMinK: params.salaryMinK,
      salaryMaxK: params.salaryMaxK,
      salaryMode: params.salaryMode,
      platform: { site: "boss", salaryLanes: splitTerms(params.platformSalaryLanes) },
      experience,
      jobTypes: params.jobTypes === undefined ? ["全职"] : splitTerms(params.jobTypes),
      degrees: splitTerms(params.degrees),
      allowExperienceStretch: true,
      bossActiveDays: PRODUCT_POLICY.searchPlan.defaultBossActiveDays,
      workSchedulePreference: params.workSchedulePreference,
      directions: splitTerms(params.directions),
      keywords: parseKeywordLines(params.keywords),
      excludeWords: splitTerms(params.excludeWords),
      hardExcludes: splitTerms(params.hardExcludes),
      scan: {
        maxCards: params.maxCards,
        maxDetailTotal: params.maxDetailTotal,
        browserPageBudget: params.browserPageBudget
      },
      source: "user-confirmed"
    }, profile.profile);
    const validation = validateSearchPlan(plan, profile.profile);
    if (!validation.valid) throw new Error(validation.errors.join("；"));
    const planId = saveSearchPlan(db, { id: params.planId, profileId, plan });
    const runtimeConfigs = profileToRuntimeConfigs(
      loadConfigs(root),
      profile.profile,
      plan,
      listCandidateResumeVersions(db, profileId)
    );
    const rescore = rescorePlanObservations(db, { planId, configs: runtimeConfigs });
    logger.info("search_plan_saved", {
      requestId,
      profileId,
      planId,
      keywordCount: plan.keywords.length,
      cityCount: plan.cities.length,
      rescored: rescore.rescored
    });
    redirect(res, `/plan?profileId=${profileId}&planId=${planId}&saved=1`);
  } catch (error) {
    respondUiError(res, error, "/onboarding", { logger, requestId, event: "search_plan_save_failed", fallbackCode: "SEARCH_PLAN_SAVE_FAILED" });
  }
}

async function handlePlanScan(req, res, { db, root, dbPath, scanRuns, logger, requestId, spawnProcess }) {
  try {
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    const plan = getSearchPlan(db, params.planId);
    const profile = plan ? getCandidateProfile(db, plan.profileId) : null;
    if (plan && !profile) throw new Error("Search Plan 对应的候选人画像不存在，请重新选择画像。");
    assertSearchPlanReady(plan, profile?.profile || {}, plan ? getSearchPlanDependency(db, plan.id) : {});
    assertBossRuntimeAvailable(db);
    const orphaned = interruptOrphanedScanRuns(db, { site: "boss", heartbeatTimeoutMs: PRODUCT_POLICY.operations.scanOrphanTimeoutMs });
    if (orphaned.interrupted) logger.warn("orphaned_scan_runs_interrupted", orphaned);
    const latestRun = getLatestScanRun(db, { planId: plan.id, site: "boss" });
    if (latestRun?.status === "running" || [...scanRuns.values()].some((run) => !run.exited)) {
      throw new Error("BOSS 已有扫描任务正在启动或运行，请等待当前任务结束。");
    }
    const activeLease = getSiteScanLease(db, "boss");
    if (activeLease) throw new Error(`BOSS 已有扫描任务运行中（${activeLease.command}，开始于 ${activeLease.acquiredAt}）。`);
    const cdpPort = Math.max(1, Math.min(65535, Number(params.cdpPort || 9222)));
    const browserMode = params.browserMode === "edge" ? "edge" : "portable";
    const resumeBatchId = params.resumeBatchId ? Number(params.resumeBatchId) : null;
    let scanKind = ["broad", "refresh", "activity"].includes(params.scanKind) ? params.scanKind : "daily";
    if (resumeBatchId) {
      if (!Number.isInteger(resumeBatchId) || resumeBatchId <= 0) throw appError("SCAN_RESUME_BATCH_INVALID", "恢复批次编号无效。");
      const batch = getBatch(db, resumeBatchId);
      if (!batch || batch.site !== "boss" || batch.searchPlanId !== plan.id) {
        throw appError("SCAN_RESUME_BATCH_MISMATCH", "该恢复批次不属于当前 Search Plan。");
      }
      if (!["partial", "failed", "interrupted"].includes(batch.status) || !batch.filterSnapshot?.execution) {
        throw appError("SCAN_RESUME_STATUS_INVALID", "该批次当前不能安全恢复。");
      }
      scanKind = batch.filterSnapshot.execution.scanKind;
      if (!["daily", "broad"].includes(scanKind)) throw appError("SCAN_RESUME_KIND_INVALID", "只有日常或广泛扫描批次可以断点恢复。");
    }
    startPlanScan(scanRuns, { db, root, dbPath, planId: plan.id, cdpPort, browserMode, scanKind, resumeBatchId, logger, requestId, spawnProcess });
    redirect(res, `/plan?profileId=${plan.profileId}&planId=${plan.id}&scan=started`);
  } catch (error) {
    respondUiError(res, error, "/plan", { logger, requestId, event: "search_plan_scan_rejected", fallbackCode: "SCAN_START_FAILED" });
  }
}

function startPlanScan(scanRuns, {
  db,
  root,
  dbPath,
  planId,
  cdpPort,
  browserMode = "portable",
  scanKind = "daily",
  resumeBatchId = null,
  workflowRunId = "",
  logger,
  requestId,
  spawnProcess = spawn
}) {
  if (!dbPath) throw new Error("扫描数据路径未配置。");
  assertBossRuntimeAvailable(db);
  const orphaned = interruptOrphanedScanRuns(db, { site: "boss", heartbeatTimeoutMs: PRODUCT_POLICY.operations.scanOrphanTimeoutMs });
  if (orphaned.interrupted) logger.warn("orphaned_scan_runs_interrupted", orphaned);
  const runId = randomUUID();
  let workflowRun = workflowRunId ? getWorkflowRun(db, workflowRunId) : null;
  if (workflowRunId && (!workflowRun || workflowRun.planId !== Number(planId))) {
    throw appError("WORKFLOW_PLAN_MISMATCH", "Workflow run does not belong to this search plan.");
  }
  if (workflowRun && !["created", "scanning", "interrupted"].includes(workflowRun.status)) {
    throw appError("WORKFLOW_SCAN_STATUS_INVALID", `Workflow run cannot scan from ${workflowRun.status}.`);
  }
  if (workflowRun && workflowRun.status !== "scanning") {
    workflowRun = transitionWorkflowRun(db, { id: workflowRun.id, status: "scanning" });
  }
  const persistedResumeBatchId = workflowRun?.scanBatchId || null;
  if (workflowRun && resumeBatchId && persistedResumeBatchId !== Number(resumeBatchId)) {
    throw appError("WORKFLOW_SCAN_INPUT_MISMATCH", "Resume batch differs from the persisted workflow run.");
  }
  const effectiveResumeBatchId = workflowRun ? persistedResumeBatchId : resumeBatchId;
  const commandArgs = buildScanCliArgs({
    kind: scanKind,
    dbPath,
    planId,
    browserMode,
    cdpPort,
    runId,
    resumeBatchId: effectiveResumeBatchId,
    ...(workflowRun ? {
      workflowRunId: workflowRun.id,
      keywords: workflowRun.keywords.map((item) => item.word),
      maxCards: Math.max(...workflowRun.keywords.map((item) => Number(item.maxCards) || 0)),
      maxDetailTotal: workflowRun.budget.maxDetailTotal,
      browserPageBudget: workflowRun.budget.browserPageBudget
    } : {})
  });
  const persisted = createScanRun(db, { runId, site: "boss", command: scanKind, planId });
  const run = { runId, kind: scanKind, resumeBatchId: effectiveResumeBatchId, workflowRunId: workflowRun?.id || "", startedAt: persisted.createdAt, output: "", error: "", exitCode: null, child: null, exited: false };
  scanRuns.set(Number(planId), run);
  let exitRecorded = false;
  const recordExit = ({ exitCode = null, signal = "", error = null } = {}) => {
    if (exitRecorded) return;
    try {
      const finished = recordScanRunProcessExit(db, {
        runId,
        exitCode,
        signal,
        status: error ? "failed" : undefined,
        stopCode: error ? "SCAN_PROCESS_ERROR" : undefined,
        stopMessage: error?.message
      });
      exitRecorded = true;
      run.exited = true;
      run.child = null;
      run.exitCode = finished.processExitCode;
      run.error = finished.status === "completed" ? "" : error?.message || finished.stopMessage || run.output;
      if (workflowRun && error) {
        const currentWorkflow = getWorkflowRun(db, workflowRun.id);
        if (["scanning", "analyzing"].includes(currentWorkflow?.status)) {
          transitionWorkflowRun(db, {
            id: workflowRun.id,
            status: "failed",
            errorCode: "SCAN_PROCESS_ERROR",
            errorMessage: error.message
          });
        }
      }
      const context = {
        requestId,
        runId,
        planId: Number(planId),
        scanKind,
        status: finished.status,
        exitCode: finished.processExitCode,
        signal: finished.processSignal || null,
        durationMs: Date.parse(finished.finishedAt) - Date.parse(run.startedAt)
      };
      if (finished.status === "completed") logger.info("scan_process_completed", context);
      else if (finished.status === "failed") logger.error("scan_process_failed", { ...context, outputTail: run.output });
      else logger.warn("scan_process_stopped", { ...context, outputTail: run.output });
    } catch (recordError) {
      run.error = recordError.message;
      logger.error("scan_process_exit_record_failed", { requestId, runId, planId: Number(planId), error: errorMeta(recordError) });
    }
  };

  try {
    const child = spawnProcess(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.js", ...commandArgs], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    run.child = child;
    logger.info("scan_process_started", { requestId, runId, planId: Number(planId), scanKind, resumeBatchId: effectiveResumeBatchId, workflowRunId: workflowRun?.id || null, browserMode, cdpPort: browserMode === "portable" ? cdpPort : null, childPid: child.pid });
    const append = (chunk) => { run.output = `${run.output}${String(chunk)}`.slice(-4000); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      logger.error("scan_process_error", { requestId, runId, planId: Number(planId), error: errorMeta(error) });
      recordExit({ error });
    });
    child.on("close", (code, signal) => recordExit({ exitCode: code, signal }));
    return run;
  } catch (error) {
    recordExit({ error });
    throw error;
  }
}

function scanStatus(scanRuns, planId, db = null) {
  const normalizedPlanId = Number(planId || 0);
  if (db) interruptOrphanedScanRuns(db, { site: "boss", heartbeatTimeoutMs: PRODUCT_POLICY.operations.scanOrphanTimeoutMs });
  const local = scanRuns.get(normalizedPlanId);
  const persisted = db && normalizedPlanId ? getLatestScanRun(db, { planId: normalizedPlanId, site: "boss" }) : null;
  if (persisted) {
    const diagnostic = local?.runId === persisted.runId ? local : null;
    return {
      state: persisted.status,
      kind: persisted.command,
      runId: persisted.runId,
      planId: persisted.planId,
      batchId: persisted.batchId,
      startedAt: persisted.startedAt || persisted.createdAt,
      finishedAt: persisted.finishedAt,
      exitCode: persisted.processExitCode,
      output: diagnostic?.output || "",
      error: diagnostic?.error || persisted.stopMessage || "",
      recovered: !diagnostic
    };
  }
  const lease = db ? getSiteScanLease(db, "boss") : null;
  if (lease && (!normalizedPlanId || Number(lease.planId) === normalizedPlanId)) {
    return { state: "running", kind: lease.command, startedAt: lease.acquiredAt, recovered: true, planId: lease.planId };
  }
  return { state: "idle" };
}

async function handlePost(req, res, handler, { logger, requestId, action }) {
  const contentType = req.headers["content-type"] || "";
  const result = handler(await readBody(req), contentType);
  if (result.statusCode !== 200) {
    const body = { ...result.body, errorCode: result.body?.errorCode || "API_REQUEST_REJECTED", requestId };
    logger.warn("dashboard_api_rejected", { requestId, action, statusCode: result.statusCode, errorCode: body.errorCode });
    return sendJson(res, result.statusCode, body);
  }
  logger.info("dashboard_api_completed", { requestId, action });
  if (!contentType.includes("application/x-www-form-urlencoded")) return sendJson(res, 200, { ...result.body, requestId });
  res.writeHead(303, { location: refererPath(req) });
  res.end();
}

function getDashboardData(db, searchParams = new URLSearchParams()) {
  const filters = parseFilters(searchParams);
  const options = dashboardBatchOptions(db, filters);
  const jobs = filterJobs(listReportJobs(db, options), filters);
  return {
    filters,
    jobs,
    latestBatchId: options.batchId || getLatestBatchId(db, options),
    summary: summarizeJobs(jobs, buildBatchSummary(db, options))
  };
}

function dashboardBatchOptions(db, filters) {
  const options = batchOptions(filters);
  if (filters.batch !== "latest" || filters.batchId) return options;
  const latestMainBatchId = getLatestMainScanBatchId(db, options);
  return latestMainBatchId ? { ...options, batch: undefined, batchId: latestMainBatchId } : options;
}

function batchOptions(filters) {
  const planId = filters.planId || undefined;
  if (filters.batch === "all") return { batch: "all", planId };
  if (filters.batchId) return { batchId: filters.batchId, planId };
  return { batch: "latest", planId };
}

function parseFilters(searchParams) {
  const batchRaw = searchParams.get("batch") || "latest";
  const numericBatch = /^\d+$/.test(batchRaw) ? Number(batchRaw) : null;
  return {
    status: searchParams.get("outcome") || searchParams.get("status") || "pending",
    level: searchParams.get("level") || "all",
    fresh: searchParams.get("fresh") || "all",
    decision: searchParams.get("decision") || "all",
    q: (searchParams.get("q") || "").trim(),
    planId: Number(searchParams.get("planId") || 0) || null,
    batch: numericBatch ? "batchId" : batchRaw,
    batchId: searchParams.get("batchId") ? Number(searchParams.get("batchId")) : numericBatch
  };
}

function filterJobs(jobs, filters) {
  const q = filters.q.toLowerCase();
  return jobs.filter((job) => {
    if (filters.status !== "all") {
      const status = job.applicationStatus || "pending";
      if (status !== filters.status) return false;
    }
    if (filters.level !== "all" && job.level !== filters.level) return false;
    if (filters.decision && filters.decision !== "all" && job.decisionBucket !== filters.decision) return false;
    if (filters.fresh !== "all") {
      const repeated = job.firstSeenAt && job.lastSeenAt && job.firstSeenAt !== job.lastSeenAt;
      if (filters.fresh === "new" && repeated) return false;
      if (filters.fresh === "repeated" && !repeated) return false;
    }
    if (q && !`${job.title || ""} ${job.company || ""} ${job.location || ""}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function summarizeJobs(jobs, batchSummary) {
  const filtered = { total: jobs.length, pending: 0, applied: 0, skipped: 0, no_reply: 0, review: 0, later: 0, interview: 0, rejected: 0, invalid: 0, salary_mismatch: 0, newJobs: 0, repeated: 0 };
  for (const job of jobs) {
    const status = job.applicationStatus || "pending";
    if (filtered[status] !== undefined) filtered[status] += 1;
    if (job.firstSeenAt && job.lastSeenAt && job.firstSeenAt !== job.lastSeenAt) filtered.repeated += 1;
    else filtered.newJobs += 1;
  }
  return { ...batchSummary, filtered };
}

function handleMarkApi(db, rawBody, contentType = "application/json") {
  let params;
  try {
    params = parseBody(rawBody, contentType);
  } catch {
    return { statusCode: 400, body: { error: "invalid request body" } };
  }
  const jobId = Number(params.jobId);
  const status = String(params.status || "");
  const note = String(params.note || "").trim();
  const profileId = Number(params.profileId || 0);
  const planId = Number(params.planId || 0) || null;
  const rawReasonCode = String(params.reasonCode || "").trim().slice(0, 80);
  const reasonCode = normalizeFeedbackReason(rawReasonCode, status);
  let reviewAt = String(params.reviewAt || "").trim();

  if (!Number.isInteger(jobId) || jobId <= 0) return { statusCode: 400, body: { error: "invalid jobId" } };
  if (!VALID_STATUSES.has(status)) return { statusCode: 400, body: { error: "invalid status" } };
  if (rawReasonCode && !reasonCode) return { statusCode: 400, body: { error: "invalid feedback reason" } };
  if (reviewAt && !/^\d{4}-\d{2}-\d{2}$/.test(reviewAt)) return { statusCode: 400, body: { error: "invalid reviewAt" } };
  if (status === "later" && !reviewAt) reviewAt = dateInputAfterDays(7);
  const exists = db.prepare("SELECT id FROM jobs WHERE id = ?").get(jobId);
  if (!exists) return { statusCode: 404, body: { error: "job not found" } };

  if (profileId) {
    if (!getCandidateProfile(db, profileId)) return { statusCode: 404, body: { error: "candidate profile not found" } };
    markCandidateJob(db, { profileId, planId, jobId, status, note, reasonCode, reviewAt });
  } else {
    markApplication(db, jobId, status, note);
  }
  return { statusCode: 200, body: { ok: true, jobId, profileId: profileId || null, status, reviewAt } };
}

function dateInputAfterDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + Number(days || 0));
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function handleFollowUpApi(db, rawBody, contentType = "application/json") {
  let params;
  try {
    params = parseBody(rawBody, contentType);
  } catch {
    return { statusCode: 400, body: { error: "invalid request body" } };
  }
  const jobId = Number(params.jobId);
  const note = String(params.note || "").trim();
  const profileId = Number(params.profileId || 0);
  const planId = Number(params.planId || 0) || null;
  if (!Number.isInteger(jobId) || jobId <= 0) return { statusCode: 400, body: { error: "invalid jobId" } };
  if (!note) return { statusCode: 400, body: { error: "note required" } };
  try {
    if (profileId && !getCandidateProfile(db, profileId)) return { statusCode: 404, body: { error: "candidate profile not found" } };
    addFollowUpNote(db, jobId, note, profileId ? { profileId, planId } : {});
    return { statusCode: 200, body: { ok: true, jobId, profileId: profileId || null } };
  } catch (error) {
    return { statusCode: /not found/i.test(error.message) ? 404 : 400, body: { error: error.message } };
  }
}

function handleRecommendationFeedbackApi(db, rawBody, contentType = "application/json") {
  let params;
  try { params = parseBody(rawBody, contentType); } catch { return { statusCode: 400, body: { error: "invalid request body" } }; }
  const jobId = Number(params.jobId);
  const profileId = Number(params.profileId);
  const planId = Number(params.planId || 0) || null;
  const reasonCode = normalizeFeedbackReason(params.reasonCode);
  if (!jobId || !profileId) return { statusCode: 400, body: { error: "jobId and profileId are required" } };
  if (!reasonCode) return { statusCode: 400, body: { error: "invalid feedback reason" } };
  try {
    recordRecommendationFeedback(db, { profileId, jobId, planId, reasonCode, note: params.note });
    return { statusCode: 200, body: { ok: true, jobId, profileId, reasonCode } };
  } catch (error) {
    return { statusCode: /not found/i.test(error.message) ? 404 : 400, body: { error: error.message } };
  }
}

async function handleCommunication(req, res, { db, modelConfig, modelReady, logger, requestId }) {
  let params = {};
  try {
    if (!modelReady) throw new Error("生成沟通草稿需要可用模型，请先完成模型连接测试。");
    params = parseBody(await readBody(req), req.headers["content-type"] || "");
    const plan = getSearchPlan(db, Number(params.planId));
    if (!plan) throw new Error("筛选方案不存在。");
    const profile = getCandidateProfile(db, plan.profileId);
    if (!profile) throw new Error("候选人画像不存在。");
    const job = listDecisionPool(db, { planId: plan.id }).find((item) => Number(item.id) === Number(params.jobId));
    if (!job) throw new Error("岗位不存在或不属于当前筛选方案。");
    const mode = ["greeting", "hr_reply", "follow_up"].includes(params.mode) ? params.mode : "greeting";
    if (mode === "greeting" && !canGenerateGreeting(job)) throw new Error("只有证据完整的主投岗位可以生成定制招呼语；其他岗位请使用 BOSS 通用招呼语。");
    if (mode === "follow_up" && job.applicationStatus !== "no_reply") throw new Error("只有已标记为“无回复待跟进”的岗位可以生成跟进文案。");
    if (mode === "hr_reply" && !String(params.hrMessage || "").trim()) throw new Error("请粘贴 HR 的原话。");
    if (params.factKey && params.factValue) saveCandidateFact(db, { profileId: profile.id, factKey: params.factKey, factValue: params.factValue, source: "user_provided" });

    const analysis = job.analysis || {};
    const { riskMessaging: _ignoredRiskMessaging, ...candidateFacts } = profile.profile || {};
    const analyzer = createLlmAnalyzer({ modelConfig, logger });
    const result = await analyzer.draftCommunication({
      mode,
      candidateProfile: candidateFacts,
      resumeVersions: listCandidateResumeVersions(db, profile.id).filter((item) => item.isActive),
      jobUnderstanding: {
        jobId: job.sourceId || String(job.id),
        realRoleType: analysis.realRoleType || "unknown",
        businessScenario: analysis.businessScenario || "",
        coreRequirements: analysis.coreRequirements || [],
        coreStack: analysis.coreStack || [],
        hiddenRisks: analysis.hiddenRisks || [],
        evidenceSnippets: analysis.evidence?.jd || []
      },
      matchDecision: analysis,
      jobEvidence: { title: job.title, company: job.company, description: job.description, salary: job.salary, experience: job.experience },
      hrMessage: String(params.hrMessage || "").trim(),
      userProvidedFacts: listCandidateFacts(db, profile.id)
    });
    recordCandidateJobEvent(db, {
      profileId: profile.id,
      jobId: job.id,
      planId: plan.id,
      eventType: `communication_${mode}`,
      payload: { result, hrMessage: mode === "hr_reply" ? String(params.hrMessage || "").trim().slice(0, 2000) : "" }
    });
    logger.info("communication_draft_generated", { requestId, profileId: profile.id, planId: plan.id, jobId: job.id, mode, missingFact: result.missingFact?.key || "", messageCount: result.messages.length });
    sendHtml(res, renderCommunicationResult({ result, job, profile, plan, hrMessage: params.hrMessage || "" }));
  } catch (error) {
    const planId = Number(params.planId || 0);
    respondUiError(res, error, planId ? `/queue?planId=${planId}` : "/", { logger, requestId, event: "communication_draft_failed", fallbackCode: "COMMUNICATION_DRAFT_FAILED" });
  }
}

function canGenerateGreeting(job) {
  const analysis = job.analysis || {};
  return job.decisionBucket === "primary" && analysis.semanticStatus === "complete"
    && Boolean(analysis.evidence?.jd?.length && analysis.evidence?.resume?.length);
}

function renderCommunicationResult({ result, job, profile, plan, hrMessage }) {
  const title = { greeting: "定制招呼语", hr_reply: "HR 回复", follow_up: "无回复跟进" }[result.kind] || "沟通草稿";
  const messages = (result.messages || []).map((message, index) => `<section class="panel"><textarea id="communication-${index}" readonly>${escapeHtml(message)}</textarea><button type="button" onclick="copyCommunication('communication-${index}')">复制</button></section>`).join("");
  const missing = result.missingFact ? `<section class="panel"><p>${escapeHtml(result.missingFact.question)}</p><form class="form-stack" method="post" action="/api/communication"><input type="hidden" name="mode" value="${escapeAttr(result.kind)}"><input type="hidden" name="jobId" value="${job.id}"><input type="hidden" name="profileId" value="${profile.id}"><input type="hidden" name="planId" value="${plan.id}"><input type="hidden" name="hrMessage" value="${escapeAttr(hrMessage)}"><input type="hidden" name="factKey" value="${escapeAttr(result.missingFact.key)}"><label>你的真实情况<textarea name="factValue" required></textarea></label><button>保存事实并生成回复</button></form></section>` : "";
  return renderPage(title, `<main><nav>${navLinks(`/queue?planId=${plan.id}`)}</nav><h1>${escapeHtml(title)}</h1><p class="hint">${escapeHtml(job.title)} · ${escapeHtml(job.company || "")}。文案只生成到本页，不会自动发送。</p>${missing}${messages || (!missing ? '<section class="panel">没有生成可发送文案。</section>' : "")}</main><script>async function copyCommunication(id){const el=document.getElementById(id);if(el)await navigator.clipboard.writeText(el.value);}</script>`);
}

function parseBody(rawBody, contentType) {
  const text = String(rawBody || "");
  if (contentType.includes("application/json")) return text ? JSON.parse(text) : {};
  const result = {};
  for (const [key, value] of new URLSearchParams(text).entries()) {
    if (!(key in result)) result[key] = value;
    else if (Array.isArray(result[key])) result[key].push(value);
    else result[key] = [result[key], value];
  }
  return result;
}

async function handleCommunicationBatch(req, res, db) {
  const rawBody = await readBody(req);
  const result = communicationApiResult(() => {
    const params = parseBody(rawBody, req.headers["content-type"] || "");
    const quota = communicationQuota(db);
    const jobIds = arrayValue(params.jobIds);
    if (jobIds.length > quota.remaining) throw appError("COMMUNICATION_QUOTA_EXHAUSTED", "communication selection exceeds the remaining daily quota");
    const batch = createCommunicationBatch(db, {
      planId: params.planId,
      jobIds,
      browserMode: params.browserMode,
      policySnapshot: { calibration: communicationCalibrationStatus() }
    });
    return { batch, summary: communicationBatchSummary(db, batch.id), items: listCommunicationBatchItems(db, batch.id), quota: communicationQuota(db) };
  });
  if (!result.ok) return sendJson(res, result.statusCode, result.body);
  if (String(req.headers.accept || "").includes("application/json")) return sendJson(res, 200, result.body);
  redirect(res, `/communication?batchId=${result.body.batch.id}`);
}

async function handleCommunicationControl(req, res, { db, root, dbPath, logger, requestId, spawnProcess = spawn }) {
  const rawBody = await readBody(req);
  const result = communicationApiResult(() => {
    const params = parseBody(rawBody, req.headers["content-type"] || "");
    const action = String(params.action || "").trim().toLowerCase();
    const batchId = Number(params.batchId);
    const batch = getCommunicationBatch(db, batchId);
    if (!batch) throw appError("COMMUNICATION_BATCH_NOT_FOUND", "communication batch not found", { statusCode: 404 });
    if (action === "start" || action === "resume") {
      assertCommunicationExecutionEnabled();
      assertBossRuntimeAvailable(db);
      const expected = action === "start" ? "confirmed" : "paused";
      if (batch.status !== expected) {
        throw appError("COMMUNICATION_BATCH_STATUS_INVALID", `${action} requires a ${expected} communication batch`, { statusCode: 409 });
      }
      const running = setCommunicationBatchStatus(db, { batchId, status: "running" });
      startCommunicationProcess({ db, root, dbPath, batch: running, logger, requestId, spawnProcess });
      return { batch: running, summary: communicationBatchSummary(db, batchId), items: listCommunicationBatchItems(db, batchId) };
    }
    if (action !== "discard") throw appError("COMMUNICATION_CONTROL_INVALID", "communication action must be start, resume, or discard");
    const items = listCommunicationBatchItems(db, batchId);
    if (items.some((item) => ["succeeded", "already_communicated"].includes(item.status))) {
      throw appError("COMMUNICATION_DISCARD_PROTECTED", "a completed communication item prevents discard");
    }
    for (const item of items) {
      if (["pending", "opening", "verified"].includes(item.status)) {
        transitionCommunicationItem(db, { itemId: item.id, batchId, expectedStatus: item.status, status: "stopped" });
      } else if (item.status === "click_dispatched") {
        transitionCommunicationItem(db, { itemId: item.id, batchId, expectedStatus: "click_dispatched", status: "ambiguous" });
      }
    }
    const updated = setCommunicationBatchStatus(db, { batchId, status: "stopped", stopCode: "COMMUNICATION_BATCH_DISCARDED", stopMessage: "discarded before calibrated execution" });
    return { batch: updated, summary: communicationBatchSummary(db, batchId), items: listCommunicationBatchItems(db, batchId) };
  });
  if (!result.ok || String(req.headers.accept || "").includes("application/json")) return sendJson(res, result.statusCode, result.body);
  redirect(res, `/communication?batchId=${result.body.batch.id}`);
}

function startCommunicationProcess({ db, root, dbPath, batch, logger, requestId, spawnProcess = spawn }) {
  if (!dbPath) throw appError("COMMUNICATION_DB_PATH_REQUIRED", "沟通执行缺少数据库路径。", { statusCode: 500 });
  let child;
  try {
    child = spawnProcess(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "src/cli.js",
      "communicate",
      "--db", dbPath,
      "--batch", String(batch.id),
      "--browser", batch.browserMode
    ], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    setCommunicationBatchStatus(db, { batchId: batch.id, status: "interrupted", stopCode: "COMMUNICATION_PROCESS_START_FAILED", stopMessage: error.message });
    throw error;
  }
  logger.info("communication_process_started", { requestId, batchId: batch.id, planId: batch.planId, browserMode: batch.browserMode, childPid: child.pid });
  child.stdout?.on("data", (chunk) => logger.info("communication_process_output", { batchId: batch.id, stream: "stdout", message: String(chunk).slice(-2000) }));
  child.stderr?.on("data", (chunk) => logger.info("communication_process_output", { batchId: batch.id, stream: "stderr", message: String(chunk).slice(-2000) }));
  const interruptRunning = (code, message) => {
    const current = getCommunicationBatch(db, batch.id);
    if (current?.status === "running") {
      setCommunicationBatchStatus(db, { batchId: batch.id, status: "interrupted", stopCode: code, stopMessage: message });
    }
  };
  child.on("error", (error) => {
    interruptRunning("COMMUNICATION_PROCESS_ERROR", error.message);
    logger.error("communication_process_error", { requestId, batchId: batch.id, error: errorMeta(error) });
  });
  child.on("close", (code, signal) => {
    if (code !== 0) interruptRunning("COMMUNICATION_PROCESS_EXITED", signal ? `signal ${signal}` : `exit ${code}`);
    logger.info("communication_process_closed", { requestId, batchId: batch.id, exitCode: code, signal: signal || null });
  });
  return child;
}

async function handleCommunicationResolve(req, res, db) {
  const rawBody = await readBody(req);
  const result = communicationApiResult(() => {
    const params = parseBody(rawBody, req.headers["content-type"] || "");
    const item = resolveAmbiguousCommunicationItem(db, {
      batchId: params.batchId,
      itemId: params.itemId,
      status: params.status,
      evidenceNote: params.evidenceNote
    });
    return { item, batch: getCommunicationBatch(db, item.batchId), summary: communicationBatchSummary(db, item.batchId) };
  });
  if (!result.ok || String(req.headers.accept || "").includes("application/json")) return sendJson(res, result.statusCode, result.body);
  redirect(res, `/communication?batchId=${result.body.batch.id}`);
}

function handleCommunicationStatus(res, db, batchId) {
  const result = communicationApiResult(() => communicationStatus(db, batchId));
  sendJson(res, result.statusCode, result.body);
}

function communicationApiResult(action) {
  try {
    return { ok: true, statusCode: 200, body: action() };
  } catch (error) {
    const issue = publicError(error, { fallbackCode: "COMMUNICATION_REQUEST_FAILED" });
    return { ok: false, statusCode: issue.statusCode, body: { error: issue.message, errorCode: issue.code } };
  }
}

function communicationStatus(db, batchId) {
  const batch = getCommunicationBatch(db, batchId);
  if (!batch) throw appError("COMMUNICATION_BATCH_NOT_FOUND", "communication batch not found", { statusCode: 404 });
  return {
    batch,
    summary: communicationBatchSummary(db, batch.id),
    items: listCommunicationBatchItems(db, batch.id),
    quota: communicationQuota(db),
    calibration: communicationCalibrationStatus(),
    runtimeBlock: communicationRuntimeBlock(db)
  };
}

function communicationQuota(db) {
  return communicationQuotaSnapshot(db);
}

function communicationRuntimeBlock(db) {
  const state = getSiteRuntimeState(db, "boss");
  if (!state || state.status !== "blocked") return null;
  const blockedUntil = state.details?.blockedUntil || null;
  const blockedUntilMs = Date.parse(blockedUntil || "");
  if (Number.isFinite(blockedUntilMs) && blockedUntilMs <= Date.now()) return null;
  return { reasonCode: state.reasonCode || "BOSS_RUNTIME_BLOCKED", blockedUntil };
}

function assertBossRuntimeAvailable(db) {
  const block = communicationRuntimeBlock(db);
  if (!block) return;
  throw appError(block.reasonCode, "BOSS 访问仍处于安全暂停期。", { statusCode: 409 });
}

function arrayValue(value) {
  return Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function readBodyBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("上传文件过大。"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(buffer, contentType) {
  const matched = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!matched) throw new Error("简历上传格式无效。");
  const boundary = Buffer.from(`--${matched[1] || matched[2]}`);
  const separator = Buffer.from("\r\n\r\n");
  const fields = {};
  const files = {};
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf(boundary, cursor);
    if (start < 0) break;
    let contentStart = start + boundary.length;
    if (buffer.slice(contentStart, contentStart + 2).toString() === "--") break;
    if (buffer.slice(contentStart, contentStart + 2).toString() === "\r\n") contentStart += 2;
    const headerEnd = buffer.indexOf(separator, contentStart);
    if (headerEnd < 0) break;
    const headers = buffer.slice(contentStart, headerEnd).toString("utf8");
    const next = buffer.indexOf(boundary, headerEnd + separator.length);
    if (next < 0) break;
    const dataEnd = next >= 2 && buffer.slice(next - 2, next).toString() === "\r\n" ? next - 2 : next;
    const data = buffer.slice(headerEnd + separator.length, dataEnd);
    const disposition = headers.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (disposition) {
      const [, name, fileName] = disposition;
      if (fileName !== undefined && fileName !== "") files[name] = { fileName, data };
      else fields[name] = data.toString("utf8");
    }
    cursor = next;
  }
  return { fields, files };
}

function splitTerms(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((item) => String(item || "").split(/[,，、\n]/)).map((item) => item.trim()).filter(Boolean))];
}

function parseKeywordLines(value) {
  return String(value || "").split(/\r?\n/).map((line) => {
    const [word, priority, ...reason] = line.split("|").map((item) => item.trim());
    return { word, priority: String(priority || "B").toUpperCase(), reason: reason.join(" | ") || "用户确认的搜索关键词" };
  }).filter((item) => item.word);
}

function renderProfilePage({ db, searchParams }) {
  const requestedId = Number(searchParams.get("profileId") || 0);
  const fallback = listCandidateProfiles(db)[0];
  const profile = getCandidateProfile(db, requestedId || fallback?.id);
  if (!profile) return renderErrorPage("还没有候选人画像，请先上传简历。", "/onboarding");
  const candidate = profile.profile.candidate || {};
  const attempts = listResumeParseAttempts(db, profile.id);
  const activePlan = getActiveSearchPlan(db, profile.id);
  const dependency = activePlan ? getSearchPlanDependency(db, activePlan.id) : null;
  const saved = searchParams.get("saved") ? `<p class="notice">画像已保存。搜索方案不会被静默改写，请在方案页按需确认。</p>` : "";
  const planNotice = !activePlan
    ? `<form class="inline-form" method="post" action="/api/plan/recommend"><input type="hidden" name="profileId" value="${profile.id}"><button>生成搜索建议</button></form>`
    : dependency?.stale ? `<p class="setup-warning">当前筛选方案基于旧画像。请到<a href="/plan?profileId=${profile.id}&planId=${activePlan.id}">筛选方案</a>检查并保存后再扫描；系统不会自动覆盖你的人工条件。</p>` : "";
  return renderPage("画像摘要", `<main>
  <nav>${navLinks(`/profile?profileId=${profile.id}`)}<a href="/resumes?profileId=${profile.id}">简历版本</a><a href="/plan?profileId=${profile.id}">筛选方案</a></nav>
  <h1>画像摘要</h1>
  ${saved}
  ${planNotice}
  <p class="hint">默认按你提供的内容使用；只在需要调整方向、薪资或项目表述时再编辑。</p>
  <form class="panel form-stack" method="post" action="/api/profile">
    <input type="hidden" name="profileId" value="${escapeAttr(profile.id)}">
    <label>姓名<input name="name" value="${escapeAttr(candidate.name || profile.displayName)}"></label>
    <label>优先城市<input name="city" value="${escapeAttr(candidate.city || "")}" placeholder="例如：广州"></label>
    <label>目标方向<input name="targetTitles" value="${escapeAttr((candidate.targetTitles || []).join("、"))}" placeholder="用顿号或逗号分隔"></label>
    <label>期望薪资<input name="expectedSalary" value="${escapeAttr(candidate.expectedSalary || "")}" placeholder="例如：9-14K"></label>
    <label>可调整范围<input name="adjustableSalary" value="${escapeAttr((candidate.adjustableSalary || []).join("、"))}" placeholder="例如：8-12K、9-13K"></label>
    <label>教育经历（每行：学校 | 学历 | 专业 | 开始 | 结束 | 状态 | 亮点）<textarea name="education">${escapeHtml(profileEducationLines(profile.profile.education))}</textarea></label>
    <label>工作 / 实习 / 协作经历（每行：组织 | 岗位 | 类型 | 开始 | 结束 | 贡献边界 | 工作内容 | 技术）<textarea name="experiences">${escapeHtml(profileExperienceLines(profile.profile.experiences))}</textarea></label>
    <label>技能（每行：技能 | 佐证）<textarea name="skills">${escapeHtml(profileSkillLines(profile.profile.skills))}</textarea></label>
    <label>项目（每行：项目名 | 时间 | 背景 | 贡献边界 | 可讲点 | 技术 | 结果 | 不主动讲）<textarea name="projects">${escapeHtml(profileProjectLines(profile.profile.projects))}</textarea></label>
    <label>证书 / 语言（每行：名称 | 说明）<textarea name="credentials">${escapeHtml(profileCredentialLines(profile.profile.credentials))}</textarea></label>
    <label>个人优势（每行一项）<textarea name="strengths">${escapeHtml((profile.profile.strengths || []).join("\n"))}</textarea></label>
    <button>保存画像</button>
  </form>
  <section class="panel"><h2>解析诊断</h2><p class="hint">只展示本地解析元数据和前 360 字预览，不会上传简历文件。</p>${renderParseAttempts(attempts)}</section>
</main>`);
}

function renderResumeVersionsPage({ db, searchParams }) {
  const requestedId = Number(searchParams.get("profileId") || 0);
  const fallback = listCandidateProfiles(db)[0];
  const profile = getCandidateProfile(db, requestedId || fallback?.id);
  if (!profile) return renderErrorPage("还没有候选人画像，请先上传简历。", "/onboarding");
  const versions = listCandidateResumeVersions(db, profile.id);
  const saved = searchParams.get("saved") ? `<p class="notice">简历版本已保存，下一次扫描会优先用启用版本做匹配和推荐。</p>` : "";
  return renderPage("简历版本", `<main>
  <nav>${navLinks(`/resumes?profileId=${profile.id}`)}<a href="/profile?profileId=${profile.id}">画像确认</a><a href="/plan?profileId=${profile.id}">筛选方案</a></nav>
  <h1>简历版本</h1>
  ${saved}
  <p class="hint">每个版本都可以限定适用方向、关键词和主推项目；停用版本不会参与下次匹配。</p>
  <form class="panel form-stack" method="post" action="/api/resume-version" enctype="multipart/form-data">
    <input type="hidden" name="profileId" value="${escapeAttr(profile.id)}">
    <h2>新增版本</h2>
    <label>版本名称<input name="name" placeholder="例如：AI 应用开发版"></label>
    <label>简历文件<input name="resumeVersion" type="file" accept=".txt,.md,.docx,.pdf"></label>
    <label>或粘贴简历文本<textarea name="resumeText" placeholder="文件无法解析时可用"></textarea></label>
    ${renderResumeVersionFields({ isActive: true })}
    ${renderResumePreviewControls()}
    <p class="hint">原始文件留在本机；发送给模型前会自动遮蔽手机号、邮箱、身份证号和详细住址。</p>
    <button>解析并新增版本</button>
  </form>
  ${versions.length ? versions.map((version) => renderResumeVersion(version, profile.id)).join("") : `<section class="panel">暂无可用版本。</section>`}
</main>${resumePreviewScript()}`);
}

function renderResumeVersion(version, profileId) {
  const file = version.fileName ? `${version.fileName} / ${version.format || "text"}` : "仅元数据版本";
  const sourceFile = version.storedFilePath && version.resumeDocumentId
    ? ` · <a href="/resume-file?id=${escapeAttr(version.resumeDocumentId)}" target="_blank">打开原文件</a>`
    : "";
  const facts = version.analysis || {};
  const factSummary = version.resumeDocumentId
    ? `已保存正文引用；结构化事实：教育 ${(facts.education || []).length}、经历 ${(facts.experiences || []).length}、项目 ${(facts.projects || []).length}、技能 ${(facts.skills || []).length}`
    : "没有对应简历正文，不参与具体版本证据匹配";
  return `<form class="panel form-stack" method="post" action="/api/resume-version">
    <input type="hidden" name="profileId" value="${escapeAttr(profileId)}"><input type="hidden" name="versionId" value="${escapeAttr(version.id)}">
    <h2>${escapeHtml(version.name)}</h2><p class="hint">${escapeHtml(file)}${sourceFile}，更新于 ${escapeHtml(String(version.updatedAt || "").slice(0, 16).replace("T", " "))}</p><p class="hint">${escapeHtml(factSummary)}</p>
    ${renderResumeVersionFields(version)}
    ${renderParseDiagnostic(version.diagnostics)}
    <button>保存版本设置</button>
  </form>`;
}

function renderResumeVersionFields(version = {}) {
  return `<label>版本名称<input name="name" value="${escapeAttr(version.name || "")}"></label>
    <label>适用方向<input name="targetRoles" value="${escapeAttr((version.targetRoles || []).join("、"))}"></label>
    <label>关键词<input name="keywords" value="${escapeAttr((version.keywords || []).join("、"))}"></label>
    <label>主推项目<input name="primaryProjects" value="${escapeAttr((version.primaryProjects || []).join("、"))}"></label>
    <label>使用说明<input name="summary" value="${escapeAttr(version.summary || "")}"></label>
    <label class="checkbox"><input type="checkbox" name="isActive"${version.isActive === false ? "" : " checked"}>参与后续岗位匹配</label>`;
}

function profileSkillLines(skills = []) {
  return (skills || []).map((item) => `${item.name || item}${item.evidence?.length ? ` | ${item.evidence.join("、")}` : ""}`).join("\n");
}

function profileProjectLines(projects = []) {
  return (projects || []).map((item) => [item.name || item, item.period || "", item.context || "", item.roleBoundary || "", (item.canSay || []).join("、"), (item.technologies || []).join("、"), (item.results || []).join("、"), (item.avoidSaying || []).join("、")].join(" | ")).join("\n");
}

function profileEducationLines(items = []) {
  return (items || []).map((item) => [item.school, item.degree, item.major, item.startDate, item.endDate, item.status, (item.highlights || []).join("、")].join(" | ")).join("\n");
}

function profileExperienceLines(items = []) {
  return (items || []).map((item) => [item.organization, item.role, item.type, item.startDate, item.endDate, item.roleBoundary, (item.highlights || []).join("、"), (item.technologies || []).join("、")].join(" | ")).join("\n");
}

function profileCredentialLines(items = []) {
  return (items || []).map((item) => [item.name, item.details || ""].join(" | ")).join("\n");
}

function renderParseAttempts(attempts) {
  if (!attempts.length) return `<p class="hint">暂无解析记录。</p>`;
  const rows = attempts.map((attempt) => `<tr><td>${escapeHtml(String(attempt.createdAt || "").slice(0, 16).replace("T", " "))}</td><td>${escapeHtml(attempt.status)}</td><td>${escapeHtml(attempt.fileName)}</td><td>${escapeHtml(attempt.extractionMethod || "-")}</td><td>${escapeHtml(attempt.charCount)}</td><td>${escapeHtml(parseQualityLabel(attempt.diagnostics?.quality))}</td><td>${escapeHtml(parseOcrLabel(attempt.diagnostics?.ocr))}</td><td>${escapeHtml(attempt.errorCode || "-")}</td><td>${escapeHtml(attempt.preview || attempt.errorMessage || "-")}</td></tr>`).join("");
  return `<table class="diagnostics"><thead><tr><th>时间</th><th>结果</th><th>文件</th><th>提取方式</th><th>字数</th><th>文本质量</th><th>扫描件兜底</th><th>错误码</th><th>预览/原因</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderParseDiagnostic(diagnostics = {}) {
  if (!diagnostics || !Object.keys(diagnostics).length) return "";
  return `<div class="line"><strong>解析：</strong>${escapeHtml(diagnostics.extractionMethod || "-")}，${escapeHtml(diagnostics.charCount || 0)} 字，质量：${escapeHtml(parseQualityLabel(diagnostics.quality))}，扫描件兜底：${escapeHtml(parseOcrLabel(diagnostics.ocr))}</div>`;
}

function parseOcrLabel(ocr = {}) {
  if (!ocr || ocr.status === "not_required") return "不需要";
  return "疑似扫描件时请粘贴文本";
}

function parseQualityLabel(quality = {}) {
  if (quality?.status === "good") return "结构完整";
  if (quality?.status === "poor") return `不可用${quality.signals?.length ? `（${quality.signals.join("、")}）` : ""}`;
  return `可解析，部分常见栏目未识别${quality?.missingSections?.length ? `（${quality.missingSections.join("、")}）` : ""}`;
}

function resumeTextTemplate() {
  return [
    "# 求职意向",
    "目标岗位：",
    "目标城市：",
    "期望薪资：",
    "",
    "# 教育经历",
    "学校 | 专业 | 学历 | 起止时间",
    "",
    "# 工作 / 实习 / 协作经历",
    "公司或项目方 | 岗位 | 起止时间",
    "- 实际参与：",
    "- 可量化结果：",
    "- 个人贡献边界：",
    "",
    "# 项目经历",
    "项目名 | 时间 | 项目背景",
    "- 我负责：",
    "- 技术与工具：",
    "- 结果或证据：",
    "- 不主动讲的边界：",
    "",
    "# 专业技能",
    "熟悉：",
    "了解：",
    "",
    "# 个人优势",
    "与目标岗位直接相关的优势：",
    "语言 / 证书 / 作品链接（可选）："
  ].join("\n");
}

function renderOnboarding({ profiles, modelState, modelReady, selectedProfileId = "" }) {
  const selectedId = String(selectedProfileId || "");
  const options = profiles.map((profile) => `<option value="${escapeAttr(profile.id)}"${String(profile.id) === selectedId ? " selected" : ""}>更新：${escapeHtml(profile.displayName)}（${escapeHtml(profile.updatedAt.slice(0, 10))}）</option>`).join("");
  const settings = modelState?.settings || {};
  const status = modelReady ? `${settings.preset || settings.provider} · ${settings.model} · 已验证` : "模型尚未通过连接测试";
  const unavailable = modelReady ? "" : `<p class="setup-warning">解析简历需要可用模型。你仍可查看已有岗位和投递记录；要新建或更新画像，请先<a href="/settings?next=%2Fonboarding">配置并测试模型</a>。</p>`;
  return renderPage("简历分析", `<main>
  <nav>${navLinks()}</nav>
  <h1>简历分析</h1>
  <p class="hint">当前模型：${escapeHtml(status)}</p>
  ${unavailable}
  <form class="panel form-stack" method="post" action="/api/resume" enctype="multipart/form-data">
    <label>候选人画像<select name="profileId"><option value="">新建候选人</option>${options}</select></label>
    <label>上传简历文件<input name="resume" type="file" accept=".txt,.md,.docx,.pdf" onchange="document.getElementById('resume-text').value=''"></label>
    <label>或粘贴简历文本<textarea id="resume-text" name="resumeText" placeholder="工作/实习经历、项目经历、专业技能、个人优势" oninput="document.querySelector('[name=resume]').value=''"></textarea></label>
    <div class="inline-form"><button type="button" data-template="${escapeAttr(JSON.stringify(resumeTextTemplate()))}" onclick="const target=document.getElementById(&quot;resume-text&quot;);if(!target.value.trim())target.value=JSON.parse(this.dataset.template);target.focus()">使用模板</button></div>
    ${renderResumePreviewControls()}
    <p class="hint">提交后先在本地提取文本，并自动遮蔽手机号、邮箱、身份证号和详细住址，再发送给当前模型厂商生成画像和搜索建议。API Key 与原始文件不会随请求发送。</p>
    <button${modelReady ? "" : " disabled"}>解析并生成筛选建议</button>
  </form>
  ${profiles.length ? `<section class="panel"><h2>已有候选人</h2>${profiles.map((profile) => `<p><a href="/plan?profileId=${profile.id}&planId=${profile.activePlanId || ""}">${escapeHtml(profile.displayName)}</a> · 最近更新 ${escapeHtml(profile.updatedAt.slice(0, 16).replace("T", " "))}</p>`).join("")}</section>` : ""}
</main>${resumePreviewScript()}`);
}

function renderResumePreviewControls() {
  return `<div class="inline-form"><button type="button" onclick="previewResumeModelInput(this)">预览发送内容</button></div><details class="resume-preview" hidden><summary></summary><pre></pre></details>`;
}

function resumePreviewScript() {
  return `<script>async function previewResumeModelInput(button){const form=button.closest("form");const box=form.querySelector(".resume-preview");const summary=box.querySelector("summary");const pre=box.querySelector("pre");button.disabled=true;try{const response=await fetch("/api/resume/preview",{method:"POST",body:new FormData(form)});const data=await response.json();if(!response.ok)throw new Error(data.error||"预览失败");const labels={phone:"电话/手机",email:"邮箱",idCard:"身份证号",address:"详细住址"};const masked=Object.entries(data.redactions||{}).map(([key,count])=>(labels[key]||key)+" "+count+" 处").join("、")||"未发现需遮蔽字段";summary.textContent="将发送 "+data.charCount+" 字；"+masked;pre.textContent=data.text;box.hidden=false;box.open=true}catch(error){summary.textContent=error.message;pre.textContent="";box.hidden=false;box.open=true}finally{button.disabled=false}}</script>`;
}

function renderModelSettingsPage({ modelState, searchParams }) {
  const storedSettings = modelState.settings || {};
  const showAdvanced = searchParams.get("advanced") === "1" || storedSettings.preset === "mock";
  const presets = listModelPresets({ includeAdvanced: showAdvanced });
  const firstSetup = modelState.source === "legacy" && storedSettings.provider === "mock" && !modelState.keyConfigured;
  const settings = firstSetup
    ? { preset: "deepseek", provider: "openai_compatible", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", timeoutMs: 30000 }
    : storedSettings;
  const selectedPreset = presets.find((item) => item.id === settings.preset) || presets.find((item) => item.id === "custom");
  const presetOptions = presets.map((preset) => {
    const selected = preset.id === selectedPreset.id ? " selected" : "";
    return '<option value="' + escapeAttr(preset.id) + '"' + selected + '>' + escapeHtml(preset.label) + '</option>';
  }).join("");
  const required = searchParams.get("required") === "1";
  const saved = searchParams.get("modelConfigured") ? '<p class="notice">模型连接测试通过，设置与当前厂商密钥已保存。</p>' : "";
  const requiredNotice = required ? '<p class="setup-warning">开始解析简历前，请先让当前模型通过连接测试。</p>' : "";
  const keyStatus = modelState.keyErrorCode === "SECRET_UNREADABLE" ? "密钥文件无法解密，请重新输入" : modelState.keyConfigured ? "当前厂商密钥已加密保存" : "当前厂商尚未保存密钥";
  const connection = settings.connection || {};
  const connectionStatus = connection.status === "verified"
    ? `已验证${connection.checkedAt ? ` · ${String(connection.checkedAt).replace("T", " ").slice(0, 16)}` : ""}${connection.latencyMs !== null && connection.latencyMs !== undefined ? ` · ${connection.latencyMs}ms` : ""}`
    : "尚未验证，保存时会发送一次极小连接测试";
  const next = safeSettingsNext(searchParams.get("next"));
  const presetJson = JSON.stringify(presets);
  const body = [
    '<style>.settings-page{max-width:960px;padding-top:32px}.settings-header{max-width:720px;margin:34px 0 24px}.settings-header h1{font-size:30px;margin:4px 0 9px}.eyebrow{margin:0;color:#0969da;font-size:13px;font-weight:700}.setup-warning{border-left:4px solid #bf8700;background:#fff8c5;padding:10px 12px;margin:12px 0}.settings-form{max-width:none;padding:24px}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.settings-field{display:grid;gap:7px;font-size:14px;font-weight:600}.settings-field[hidden]{display:none}.settings-field input,.settings-field select{width:100%;box-sizing:border-box}.settings-field small{font-size:12px;line-height:1.45;font-weight:400;color:#57606a}.settings-field-wide{grid-column:1/-1}.settings-security{display:grid;gap:3px;border-top:1px solid #d8dee4;margin-top:22px;padding-top:16px;font-size:13px;color:#57606a}.settings-security strong{color:#1f2328}.settings-clear{margin-top:14px}.settings-actions{display:flex;justify-content:flex-end;margin-top:20px}@media(max-width:760px){.settings-page{padding-top:16px}.settings-header{margin:22px 0 18px}.settings-header h1{font-size:26px}.settings-form{padding:16px}.settings-grid{grid-template-columns:1fr}.settings-field-wide{grid-column:auto}.settings-actions{justify-content:stretch}.settings-actions button{width:100%}}</style>',
    '<main class="settings-page">',
    "  <nav>" + navLinks() + "</nav>",
    '  <header class="settings-header">',
    '    <p class="eyebrow">开始使用前</p>',
    '    <h1>配置模型</h1>',
    '    <p class="hint">模型用于简历结构化、岗位理解与匹配；只有强推荐岗位在你点击时才生成定制沟通。已有岗位和投递记录不依赖模型即可查看。</p>',
    "  </header>",
    saved,
    requiredNotice,
    '  <form class="panel settings-form" method="post" action="/api/settings/model">',
    '    <input type="hidden" name="next" value="' + escapeAttr(next) + '">',
    '    <div class="settings-grid">',
    '      <label class="settings-field">模型厂商<select id="model-preset" name="preset">' + presetOptions + "</select><small>常用接口地址已预设；每个厂商分别保存自己的 Key。</small></label>",
    '      <label class="settings-field">模型名称<input id="model-name" name="model" list="model-options" maxlength="160" value="' + escapeAttr(settings.model || "") + '" required><datalist id="model-options"></datalist><small>可以选推荐项，也可以直接填写厂商支持的新模型名。</small></label>',
    '      <label class="settings-field">API Key<input name="apiKey" type="password" autocomplete="new-password" placeholder="' + (modelState.keyConfigured ? "已保存，留空保持不变" : "粘贴 API Key") + '"><small>密钥状态：' + keyStatus + '。</small></label>',
    '      <div class="settings-field"><strong>连接状态</strong><small>' + escapeHtml(connectionStatus) + "</small></div>",
    "    </div>",
    '    <details class="plan-advanced"><summary>高级设置</summary><div class="settings-grid" style="margin-top:14px"><label class="settings-field settings-field-wide">兼容接口基础地址<input id="model-base-url" name="baseUrl" type="url" value="' + escapeAttr(settings.baseUrl || "") + '" placeholder="https://..."' + (selectedPreset.id === "custom" ? "" : " readonly") + '><small>预设厂商自动填充；自定义兼容接口可编辑。</small></label><label class="settings-field">请求超时（毫秒）<input name="timeoutMs" type="number" min="3000" max="120000" value="' + escapeAttr(settings.timeoutMs || 30000) + '"></label><label class="checkbox settings-clear"><input name="clearApiKey" type="checkbox">删除当前厂商密钥</label></div></details>',
    '    <div class="settings-security"><strong>本机安全存储</strong><span>API Key 仅按当前 Windows 用户加密保存，不进入配置文件、日志、数据库或绿色发布包。</span></div>',
    '    <div class="settings-actions"><button>测试连接并保存</button></div>',
    "  </form>",
    '  <script id="model-preset-data" type="application/json">' + presetJson + "</script>",
    "  <script>",
    "  (function () {",
    '    const presets = JSON.parse(document.getElementById("model-preset-data").textContent);',
    '    const presetSelect = document.getElementById("model-preset");',
    '    const baseUrl = document.getElementById("model-base-url");',
    '    const modelName = document.getElementById("model-name");',
    '    const modelOptions = document.getElementById("model-options");',
    "    function currentPreset() { return presets.find(function (item) { return item.id === presetSelect.value; }) || presets[0]; }",
    "    function syncMode() {",
    "      const preset = currentPreset();",
    '      baseUrl.readOnly = preset.id !== "custom";',
    "    }",
    "    function updatePreset() {",
    "      const preset = currentPreset();",
    '      baseUrl.value = preset.baseUrl || "";',
    '      modelOptions.innerHTML = "";',
    "      const names = preset.models.length ? preset.models : (preset.defaultModel ? [preset.defaultModel] : []);",
    "      names.forEach(function (name) {",
    '        const option = document.createElement("option");',
    "        option.value = name;",
    "        modelOptions.appendChild(option);",
    "      });",
    '      modelName.value = preset.defaultModel || "";',
    "      syncMode();",
    "    }",
    '    presetSelect.addEventListener("change", updatePreset);',
    "    syncMode();",
    "  }());",
    "  </script>",
    "</main>"
  ].join("\n");
  return renderPage("配置模型", body);
}

function renderModelOptions(preset, selectedModel) {
  const names = [...new Set([...(preset?.models || []), selectedModel].filter(Boolean))];
  if (!names.length) names.push("");
  return names.map((name) => {
    const selected = name === selectedModel ? " selected" : "";
    const label = name || "请在下方填写自定义模型名";
    return '<option value="' + escapeAttr(name) + '"' + selected + '>' + escapeHtml(label) + '</option>';
  }).join("");
}

const PLAN_CITY_OPTIONS = Object.keys(CITY_CODES);
const PLAN_EXPERIENCE_OPTIONS = PRODUCT_POLICY.searchPlan.experienceOptions;
const PLAN_JOB_TYPE_OPTIONS = PRODUCT_POLICY.searchPlan.jobTypeOptions;
const PLAN_DEGREE_OPTIONS = PRODUCT_POLICY.searchPlan.degreeOptions;

function renderPlanChoices(name, options, selectedValues = []) {
  const selected = new Set(selectedValues || []);
  return options.map((value) => {
    const checked = selected.has(value) ? " checked" : "";
    return '<label class="choice-item"><input type="checkbox" name="' + escapeAttr(name) + '" value="' + escapeAttr(value) + '"' + checked + '><span>' + escapeHtml(value) + "</span></label>";
  }).join("");
}

function renderPlanPage({ db, searchParams, scanRuns }) {
  const profiles = listCandidateProfiles(db);
  const requestedPlan = getSearchPlan(db, searchParams.get("planId"));
  const profileId = Number(searchParams.get("profileId") || requestedPlan?.profileId || profiles[0]?.id || 0);
  const profile = getCandidateProfile(db, profileId);
  if (!profile) return renderErrorPage("还没有候选人画像，请先上传简历。", "/onboarding");
  const planRecord = requestedPlan?.profileId === profile.id ? requestedPlan : getActiveSearchPlan(db, profile.id);
  if (!planRecord) return renderErrorPage("当前候选人没有可编辑的筛选计划。", "/onboarding");
  const plan = normalizeSearchPlan(planRecord.plan || {}, profile.profile);
  const dailyScan = resolveScanPolicy(plan, "daily");
  const broadScan = resolveScanPolicy(plan, "broad");
  const scanDefaults = PRODUCT_POLICY.searchPlan.broadScanDefaults;
  const scanBounds = PRODUCT_POLICY.searchPlan.scanBounds;
  const dailyBCardLimit = boss.weightedCardLimit("B", dailyScan.maxCards);
  const selectedExperience = plan.experience;
  const candidate = profile.profile.candidate || {};
  const run = scanStatus(scanRuns, planRecord.id, db);
  const resumableBatch = getLatestResumableBatch(db, { planId: planRecord.id, site: "boss" });
  const validation = validateSearchPlan(plan, profile.profile);
  const planDependency = getSearchPlanDependency(db, planRecord.id);
  const versionDiff = compareProfileVersions(db, profile.id);
  const feedback = buildFeedbackSummary(db, { profileId: profile.id });
  const bossCatalog = getPlatformFilterCatalog(db, "boss")?.catalog;
  const bossRuntimeBlock = communicationRuntimeBlock(db);
  const scanDisabled = run.state === "running" || !validation.valid || planDependency.stale || Boolean(bossRuntimeBlock);
  const bossFilterPreview = bossCatalog ? resolveNativeFilterSnapshot({ site: "boss", catalog: bossCatalog, plan }) : null;
  const bossSalaryOptions = bossCatalog?.fields?.salary?.options?.map((option) => option.label) || [];
  const resumeButton = resumableBatch
    ? `<button data-scan-button name="resumeBatchId" value="${resumableBatch.id}"${scanDisabled ? " disabled" : ""}>继续未完成扫描 #${resumableBatch.id}</button>`
    : "";
  const selectedBossSalaryLanes = plan.platform?.salaryLanes?.length
    ? plan.platform.salaryLanes
    : bossFilterPreview?.lanes?.flatMap((lane) => lane.labels?.salary || []) || [];
  const confirmation = searchParams.get("saved") ? "筛选方案已保存。" : searchParams.get("created") ? "已根据你提供的简历生成画像和筛选建议，可直接开始扫描；只有需要调整时再编辑。" : "";
  const dependencyNotice = planDependency.stale ? `<section class="panel validation validation-error"><strong>方案需要重新确认</strong><p>画像已更新，但当前方案仍基于旧画像。检查下方条件并保存一次即可重新绑定；系统不会自动覆盖你的人工设置。</p></section>` : "";
  const riskControlNotice = bossRuntimeBlock
    ? `<section class="panel validation validation-error"><strong>BOSS 扫描已因安全验证暂停</strong><p>限制到期前不会创建扫描进程；此前已采集的岗位和详情不会丢失。</p><p class="error-code">${escapeHtml(bossRuntimeBlock.reasonCode)}${bossRuntimeBlock.blockedUntil ? ` · 恢复时间 ${escapeHtml(bossRuntimeBlock.blockedUntil)}` : ""}</p></section>`
    : "";
  const planStyle = '<style>.plan-form{max-width:none}.plan-form .choice-section{grid-column:1/-1;display:grid;gap:8px}.choice-list{display:flex;flex-wrap:wrap;gap:8px}.choice-item{display:flex!important;align-items:center;gap:6px;border:1px solid #d8dee4;border-radius:4px;padding:7px 9px;font-size:14px}.choice-item input{width:auto}.plan-note{grid-column:1/-1;margin:0;color:#57606a;font-size:13px}.plan-advanced{grid-column:1/-1;border-top:1px solid #d8dee4;padding-top:14px}.plan-advanced summary{cursor:pointer;font-weight:600}.plan-advanced-body{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:12px}.plan-advanced-body .wide{grid-column:1/-1}@media(max-width:760px){.plan-advanced-body{grid-template-columns:1fr}.plan-advanced-body .wide{grid-column:auto}}</style>';
  return renderPage("筛选方案", `${planStyle}<main>
  <nav>${navLinks(`/plan?profileId=${profile.id}&planId=${planRecord.id}`)}</nav>
  <h1>筛选方案</h1>
  ${confirmation ? `<p class="notice">${escapeHtml(confirmation)}</p>` : ""}
  ${dependencyNotice}
  ${riskControlNotice}
  ${renderPlanValidation(validation)}
  <section class="panel profile-summary">
    <div><a href="/onboarding?profileId=${profile.id}">重新解析简历</a>　<a href="/profile?profileId=${profile.id}">编辑画像</a>　<a href="/resumes?profileId=${profile.id}">管理简历版本</a></div>
    <div><strong>${escapeHtml(candidate.name || profile.displayName)}</strong> · ${escapeHtml(candidate.city || "目标城市待确认")} · ${escapeHtml((candidate.targetTitles || []).join("、") || "目标岗位待确认")}</div>
    <div class="line">技能：${escapeHtml((profile.profile.skills || []).map((item) => item.name || item).join("、") || "待确认")}</div>
    <div class="line">项目：${escapeHtml((profile.profile.projects || []).map((item) => item.name || item).join("、") || "待确认")}</div>
    ${renderProfileDiff(versionDiff)}
    ${renderFeedbackInsight(feedback)}
    ${renderBossFilterPreview(bossFilterPreview, bossCatalog)}
  </section>
  <form id="plan-form" class="panel plan-form" method="post" action="/api/plan">
    <input type="hidden" name="profileId" value="${profile.id}"><input type="hidden" name="planId" value="${planRecord.id}">
    <label class="wide">方案名称<input name="name" value="${escapeAttr(plan.name || "")}" required></label>
    <div class="choice-section"><strong>目标城市</strong><div class="choice-list">${renderPlanChoices("cities", PLAN_CITY_OPTIONS, plan.cities)}</div></div>
    <div class="choice-section"><strong>工作经验</strong><div class="choice-list">${renderPlanChoices("experience", PLAN_EXPERIENCE_OPTIONS, selectedExperience)}</div></div>
    <div class="choice-section"><strong>求职类型</strong><div class="choice-list">${renderPlanChoices("jobTypes", bossCatalog?.fields?.jobType?.options?.map((item) => item.label) || PLAN_JOB_TYPE_OPTIONS, plan.jobTypes)}</div></div>
    <div class="choice-section"><strong>学历筛选（可选，不选则不限制）</strong><div class="choice-list">${renderPlanChoices("degrees", bossCatalog?.fields?.degree?.options?.map((item) => item.label) || PLAN_DEGREE_OPTIONS, plan.degrees)}</div></div>
    <label>最低薪资（K）<input type="number" min="0" max="100" name="salaryMinK" value="${escapeAttr(plan.salary?.minK || "")}"></label>
    <label>最高薪资（K）<input type="number" min="0" max="100" name="salaryMaxK" value="${escapeAttr(plan.salary?.maxK || "")}"></label>
    ${bossSalaryOptions.length ? `<div class="choice-section"><strong>BOSS 薪资抓取档位</strong><div class="choice-list">${renderPlanChoices("platformSalaryLanes", bossSalaryOptions, selectedBossSalaryLanes)}</div></div>` : ""}
    <label>薪资策略<select name="salaryMode"><option value="wide"${plan.salaryMode !== "strict" ? " selected" : ""}>宽松排序，范围外保留</option><option value="strict"${plan.salaryMode === "strict" ? " selected" : ""}>严格范围，范围外不推荐</option></select></label>
    <label>工作节奏<select name="workSchedulePreference"><option value="prefer_double_weekend"${plan.workSchedulePreference !== "no_preference" ? " selected" : ""}>优先双休，其他仍保留</option><option value="no_preference"${plan.workSchedulePreference === "no_preference" ? " selected" : ""}>不作为排序依据</option></select></label>
    <label class="wide">目标方向<input name="directions" value="${escapeAttr((plan.directions || []).join("，"))}" placeholder="例如：AI应用开发、RAG、Python后端"></label>
    <p class="plan-note">岗位质量会自动优先保留招聘方近 ${escapeHtml(plan.bossActiveDays)} 天活跃的岗位，并对超过经验范围但薪资偏初中级的岗位保留“可冲”标记。</p>
    <label class="wide">搜索关键词<textarea name="keywords" required>${escapeHtml(keywordLines(plan.keywords))}</textarea></label>
    <details class="plan-advanced"><summary>广泛扫描预算</summary><div class="plan-advanced-body"><label class="wide">排除词<input name="excludeWords" value="${escapeAttr((plan.excludeWords || []).join("，"))}"></label><label class="wide">硬排除词<input name="hardExcludes" value="${escapeAttr((plan.hardExcludes || []).join("，"))}"></label><label>A类每词岗位数<input type="number" min="${scanBounds.maxCards[0]}" max="${scanBounds.maxCards[1]}" name="maxCards" value="${escapeAttr(plan.scan.maxCards ?? scanDefaults.maxCards)}"></label><label>右栏详情安全上限<input type="number" min="${scanBounds.maxDetailTotal[0]}" max="${scanBounds.maxDetailTotal[1]}" name="maxDetailTotal" value="${escapeAttr(plan.scan.maxDetailTotal ?? scanDefaults.maxDetailTotal)}"></label><label>搜索页面安全上限<input type="number" min="${scanBounds.browserPageBudget[0]}" max="${scanBounds.browserPageBudget[1]}" name="browserPageBudget" value="${escapeAttr(plan.scan.browserPageBudget ?? scanDefaults.browserPageBudget)}"></label></div><p class="field-help">这些上限只控制低频广泛扫描。日常扫描会自动收敛到 A/B 关键词、首选薪资档、每个 A 词最多 ${dailyScan.maxCards} 张卡片和 ${dailyScan.maxDetailTotal} 个右栏详情。两种模式都使用单标签串行、随机等待和风控即停。</p></details>
    <div class="wide"><button>保存筛选方案</button><span id="plan-dirty-note" class="hint" hidden> 条件有修改，请先保存再扫描。</span></div>
  </form>
  <section class="panel scan-panel">
    <div><strong>扫描状态：</strong>${escapeHtml(scanLabel(run, plan.bossActiveDays))}</div>
    <p class="field-help">日常扫描：${dailyScan.keywordPlan.length} 个 A/B 关键词、首选薪资档、A/B 每词最多 ${dailyScan.maxCards}/${dailyBCardLimit} 张卡片和 ${dailyScan.detailLimits.A}/${dailyScan.detailLimits.B} 个新详情，总详情预算 ${dailyScan.maxDetailTotal}。广泛扫描：${broadScan.keywordPlan.length} 个全部关键词、所有薪资档、详情最多 ${broadScan.maxDetailTotal} 个。</p>
    ${run.error ? `<pre class="scan-error">${escapeHtml(run.error)}</pre>` : ""}
    <form class="inline-form" method="post" action="/api/scan"><input type="hidden" name="planId" value="${planRecord.id}"><input type="hidden" name="cdpPort" value="9222"><select name="browserMode" title="浏览器模式"><option value="edge">当前已登录 Edge</option><option value="portable">项目专用 Edge</option></select><button data-scan-button name="scanKind" value="daily"${scanDisabled ? " disabled" : ""}>日常扫描</button><button data-scan-button name="scanKind" value="broad"${scanDisabled ? " disabled" : ""}>广泛扫描</button>${resumeButton}<button data-scan-button name="scanKind" value="refresh"${scanDisabled ? " disabled" : ""}>补读缺失详情</button><button data-scan-button name="scanKind" value="activity"${scanDisabled ? " disabled" : ""}>更新过期活跃状态</button><a class="button-link" href="/queue?planId=${planRecord.id}">待处理队列</a><a class="button-link" href="/jobs?planId=${planRecord.id}&batch=latest">查看岗位</a></form>
  </section>
</main><script>(function(){const form=document.getElementById('plan-form');const note=document.getElementById('plan-dirty-note');if(!form)return;form.addEventListener('input',function(){document.querySelectorAll('[data-scan-button]').forEach(function(button){button.disabled=true});if(note)note.hidden=false});}());</script>${run.state === "running" ? `<script>setTimeout(()=>location.reload(),2500)</script>` : ""}`);
}

function renderBossFilterPreview(snapshot, catalog) {
  if (!catalog) return '<p class="plan-note">BOSS \u7ad9\u5185\u9884\u7b5b\u6761\u4ef6\u5c06\u5728\u9996\u6b21\u626b\u63cf\u65f6\u81ea\u52a8\u9884\u8bfb\uff0c\u4e4b\u540e\u6309\u672c\u65b9\u6848\u7684\u85aa\u8d44\u4e0e\u7ecf\u9a8c\u6761\u4ef6\u7ec4\u88c5 URL\u3002</p>';
  const summary = formatNativeFilterSummary(snapshot) || "\u672a\u547d\u4e2d\u53ef\u7528\u7684 BOSS \u9884\u7b5b\u6863\u4f4d";
  const refreshedAt = String(catalog.discoveredAt || "").replace("T", " ").slice(0, 16);
  return `<p class="plan-note">BOSS \u7ad9\u5185\u9884\u7b5b\uff1a${escapeHtml(summary)}\u3002\u89c4\u5219\u8bfb\u53d6\u4e8e ${escapeHtml(refreshedAt || "\u672a\u77e5\u65f6\u95f4")}\uff1b\u626b\u63cf\u65f6\u4ecd\u4f1a\u4fdd\u7559 JD \u5339\u914d\u3001\u6d3b\u8dc3\u5ea6\u548c\u5c97\u4f4d\u98ce\u9669\u5224\u65ad\u3002</p>`;
}

function renderErrorPage(message, back, { code = "", requestId = "" } = {}) {
  const diagnostic = code ? `<p class="error-code">错误编号：${escapeHtml(code)}${requestId ? ` · 请求编号：${escapeHtml(requestId)}` : ""}</p><p class="hint">可在“诊断”页面查看对应日志。</p>` : "";
  return renderPage("操作未完成", `<main><nav>${navLinks()}</nav><h1>操作未完成</h1><section class="panel"><p class="risk-text">${escapeHtml(message)}</p>${diagnostic}<p><a href="${escapeAttr(back)}">返回</a></p></section></main>`);
}

function renderDiagnosticsPage(entries = []) {
  const rows = entries.map((entry) => {
    const error = entry.error || {};
    const code = error.code || entry.errorCode || "";
    const usage = entry.usage || {};
    const modelSummary = String(entry.event || "").startsWith("model_") ? [
      entry.kind,
      [entry.provider, entry.model].filter(Boolean).join("/"),
      entry.cacheHit === true ? "缓存命中" : entry.cacheHit === false ? "实时调用" : "",
      Number.isFinite(entry.latencyMs) ? `${entry.latencyMs} ms` : "",
      Number.isFinite(entry.attempts) ? `${entry.attempts} 次尝试` : "",
      Number.isFinite(usage.total_tokens) ? `${usage.total_tokens} tokens` : "",
      entry.httpStatus ? `HTTP ${entry.httpStatus}` : ""
    ].filter(Boolean).join(" · ") : "";
    const message = String(modelSummary || error.message || entry.message || "").slice(0, 240);
    return `<tr><td>${escapeHtml(String(entry.time || "").replace("T", " ").slice(0, 19))}</td><td>${escapeHtml(entry.level || "")}</td><td>${escapeHtml(entry.component || "")}</td><td>${escapeHtml(entry.event || "")}</td><td>${escapeHtml(entry.requestId || "")}</td><td>${escapeHtml(code)}</td><td>${escapeHtml(message)}</td></tr>`;
  }).join("");
  return renderPage("诊断日志", `<main><nav>${navLinks()}</nav><h1>诊断日志</h1><p class="hint">仅展示最近 120 条脱敏日志。完整 JSONL 位于项目的 .runtime/logs。</p><section class="panel"><table class="diagnostics"><thead><tr><th>时间</th><th>级别</th><th>组件</th><th>事件</th><th>请求</th><th>错误码</th><th>摘要</th></tr></thead><tbody>${rows || "<tr><td colspan=\"7\">暂无日志</td></tr>"}</tbody></table></section></main>`);
}

function respondUiError(res, error, back, { logger, requestId, event, fallbackCode }) {
  const issue = publicError(error, { fallbackCode });
  logger.error(event, { requestId, error: errorMeta(error), errorCode: issue.code });
  sendHtml(res, renderErrorPage(issue.message, back, { code: issue.code, requestId }), issue.statusCode);
}

function respondUnexpectedError(res, error, requestId, requestPath) {
  const issue = publicError(error, { fallbackCode: "INTERNAL_ERROR", fallbackMessage: "服务处理失败，请查看错误编号对应的诊断日志。", statusCode: 500 });
  if (String(requestPath || "").startsWith("/api/")) return sendJson(res, issue.statusCode, { error: issue.message, errorCode: issue.code, requestId });
  sendHtml(res, renderErrorPage(issue.message, "/", { code: issue.code, requestId }), issue.statusCode);
}

function renderPlanValidation(validation) {
  if (!validation.errors.length && !validation.warnings.length) return "";
  const errors = validation.errors.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const warnings = validation.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  return `<section class="panel validation ${validation.valid ? "" : "validation-error"}">
    ${errors ? `<strong>扫描前需要修正</strong><ul>${errors}</ul>` : ""}
    ${warnings ? `<strong>建议确认</strong><ul>${warnings}</ul>` : ""}
  </section>`;
}

function renderProfileDiff(diff) {
  if (!diff.current) return "";
  const current = `${diff.current.fileName || "当前简历"} · ${String(diff.current.createdAt || "").slice(0, 10)}`;
  if (!diff.previous) return `<div class="line profile-diff"><strong>简历版本：</strong>${escapeHtml(current)}（初始版本）</div>`;
  if (!diff.changes.length) return `<div class="line profile-diff"><strong>简历版本：</strong>${escapeHtml(current)}（与上一版画像无关键差异）</div>`;
  const items = diff.changes.map((change) => {
    if (change.added || change.removed) {
      const details = [change.added?.length ? `新增：${change.added.join("、")}` : "", change.removed?.length ? `移除：${change.removed.join("、")}` : ""].filter(Boolean).join("；");
      return `<li>${escapeHtml(change.label)}：${escapeHtml(details)}</li>`;
    }
    return `<li>${escapeHtml(change.label)}：${escapeHtml(change.before || "未填写")} → ${escapeHtml(change.after || "未填写")}</li>`;
  }).join("");
  return `<div class="line profile-diff"><strong>简历版本：</strong>${escapeHtml(current)}，相对上一版：<ul>${items}</ul></div>`;
}

function renderFeedbackInsight(feedback = {}) {
  const reasonRows = Object.entries(feedback.reasonCounts || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${feedbackReasonLabel(reason)} ${count} 次`);
  const keywordRows = Object.entries(feedback.keywordReasons || {})
    .map(([keyword, reasons]) => [keyword, Object.values(reasons).reduce((sum, count) => sum + count, 0)])
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([keyword, count]) => `${keyword}（反馈 ${count}）`);
  if (!reasonRows.length && !keywordRows.length) return "";
  const sections = [
    reasonRows.length ? `高频跳过原因：${reasonRows.join("；")}` : "",
    keywordRows.length ? `待排查的关键词：${keywordRows.join("、")}` : ""
  ].filter(Boolean);
  return `<div class="line profile-diff"><strong>历史反馈：</strong>${escapeHtml(sections.join("。"))}。仅用于诊断，不自动调整筛选或排序。</div>`;
}

function renderPage(title, body) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
body{font-family:Segoe UI,Microsoft YaHei,sans-serif;margin:0;background:#f6f7f9;color:#1f2328}main{max-width:1160px;margin:0 auto;padding:24px}nav{display:flex;gap:14px;margin-bottom:18px}nav a{color:#0969da;text-decoration:none}h1{font-size:24px;margin:0 0 8px;letter-spacing:0}h2{font-size:16px;margin:0 0 10px}.hint,.line{color:#57606a;margin:7px 0}.notice{color:#0a6b2b}.risk-text{color:#b42318}.error-code{font-family:Consolas,monospace;color:#57606a}.panel{background:#fff;border:1px solid #d8dee4;border-radius:8px;padding:16px;margin:12px 0}.form-stack{display:grid;gap:12px;max-width:560px}.plan-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.plan-form .wide{grid-column:1/-1}.plan-form label,.form-stack label,.inline-form label{display:grid;gap:5px;font-size:14px}.plan-form .checkbox{display:flex;align-items:center;gap:8px;padding-top:24px}.plan-form .checkbox input{width:auto}input,select,textarea,button{font:inherit}input,select,textarea{min-width:0;padding:8px;border:1px solid #b8c0cc;border-radius:4px;background:#fff}textarea{min-height:118px;resize:vertical}button,.button-link{padding:8px 12px;border:1px solid #0969da;border-radius:4px;background:#0969da;color:#fff;cursor:pointer;text-decoration:none;display:inline-block}.button-link{line-height:20px}.inline-form{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin-top:12px}.inline-form input{width:120px}.resume-preview pre{max-height:360px;overflow:auto;white-space:pre-wrap;background:#f6f8fa;padding:10px;border:1px solid #d8dee4}.scan-error{white-space:pre-wrap;background:#fff1f0;padding:10px;max-height:180px;overflow:auto}.profile-summary{display:grid;gap:3px}.validation{border-left:4px solid #bf8700}.validation-error{border-left-color:#b42318}.validation strong{display:block}.validation ul,.profile-diff ul{margin:7px 0 0;padding-left:20px}.profile-diff{border-top:1px solid #d8dee4;padding-top:8px}.diagnostics{width:100%;border-collapse:collapse;font-size:12px}.diagnostics th,.diagnostics td{border-bottom:1px solid #d8dee4;padding:7px;text-align:left;vertical-align:top;word-break:break-word}@media(max-width:760px){main{padding:16px}.plan-form{grid-template-columns:1fr}.plan-form .wide{grid-column:auto}.plan-form .checkbox{padding-top:0}.inline-form{display:grid;grid-template-columns:1fr}.diagnostics{display:block;overflow-x:auto}}
button:disabled{cursor:not-allowed;background:#8c959f;border-color:#8c959f;opacity:.65}nav{flex-wrap:wrap}
</style>${body}</html>`;
}

function keywordLines(keywords = []) {
  return keywords.map((item) => `${item.word || item} | ${item.priority || "B"} | ${item.reason || "用户确认的搜索关键词"}`).join("\n");
}

function scanLabel(run, bossActiveDays = PRODUCT_POLICY.searchPlan.defaultBossActiveDays) {
  if (run.state === "running" && run.kind === "daily") return "正在执行日常扫描";
  if (run.state === "completed" && run.kind === "daily") return "日常扫描已完成";
  if (run.state === "running" && run.kind === "broad") return "正在执行广泛扫描";
  if (run.state === "completed" && run.kind === "broad") return "广泛扫描已完成";
  if (run.state === "running" && run.kind === "refresh") return "正在补读待刷新岗位";
  if (run.state === "completed" && run.kind === "refresh") return "待刷新岗位补读完成";
  if (run.state === "running" && run.kind === "activity") return `正在更新超过 ${bossActiveDays} 天有效期的招聘方活跃状态`;
  if (run.state === "completed" && run.kind === "activity") return "招聘方活跃状态更新完成";
  return {
    idle: "尚未运行",
    running: "扫描中",
    completed: "本次扫描已完成",
    partial: "本次扫描部分完成，可查看诊断后继续",
    failed: "扫描失败，请查看错误",
    interrupted: "扫描已中断，可重新启动"
  }[run.state] || "尚未运行";
}

function navLinks(current = "") {
  const planId = String(current).match(/[?&]planId=(\d+)/)?.[1];
  if (planId) return `<a href="/onboarding">简历</a><a href="${escapeAttr(current)}">筛选方案</a><a href="/queue?planId=${escapeAttr(planId)}">当前岗位</a><a href="/communication/new?planId=${escapeAttr(planId)}">批量沟通清单</a><a href="/settings">模型设置</a><a href="/diagnostics">诊断</a>`;
  return `<a href="/onboarding">简历</a><a href="${escapeAttr(current || "/")}">筛选方案</a><a href="/settings">模型设置</a><a href="/diagnostics">诊断</a>`;
}

function modelSetupPath(next = "/onboarding") {
  return "/settings?required=1&next=" + encodeURIComponent(safeSettingsNext(next));
}

function safeSettingsNext(value) {
  return value === "/onboarding" ? value : "/onboarding";
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

function renderDashboard(data) {
  return renderCompactDashboard(data);
}

function renderQueuePage({ db, searchParams }) {
  const requestedPlanId = Number(searchParams.get("planId") || 0);
  const fallbackProfile = listCandidateProfiles(db)[0];
  const fallbackPlan = fallbackProfile ? getActiveSearchPlan(db, fallbackProfile.id) : null;
  const plan = getSearchPlan(db, requestedPlanId) || fallbackPlan;
  if (!plan) return renderErrorPage("还没有可用的筛选方案，请先上传简历并确认方案。", "/onboarding");
  return renderCompactQueuePage({ db, plan, searchParams });
}

function renderCompactQueuePage({ db, plan, searchParams }) {
  const pool = ["focus", "primary", "talk", "backup", "analysis_pending", "detail_pending", "activity_pending", "no_reply", "not_recommended"].includes(searchParams.get("pool")) ? searchParams.get("pool") : "focus";
  const scope = ["all", "new", "repeated", "backlog"].includes(searchParams.get("scope")) ? searchParams.get("scope") : "all";
  const latestMainBatchId = getLatestMainScanBatchId(db, { planId: plan.id });
  const fullPool = listDecisionPool(db, { planId: plan.id });
  const allCandidates = fullPool.filter(compactAwaitingAction);
  const noReplyCandidates = fullPool.filter((job) => job.applicationStatus === "no_reply");
  const poolBase = pool === "no_reply" ? noReplyCandidates : allCandidates;
  const scopeCounts = Object.fromEntries(["all", "new", "repeated", "backlog"].map((key) => [key, poolBase.filter((job) => key === "all" || queueScopeForJob(job, latestMainBatchId) === key).length]));
  const candidates = poolBase.filter((job) => scope === "all" || queueScopeForJob(job, latestMainBatchId) === scope);
  const scopedAwaiting = allCandidates.filter((job) => scope === "all" || queueScopeForJob(job, latestMainBatchId) === scope);
  const refreshable = scopedAwaiting.filter((job) => job.decisionBucket === "refresh");
  const counts = Object.fromEntries(["primary", "talk", "backup", "analysis_pending", "refresh", "not_recommended"].map((key) => [key, scopedAwaiting.filter((job) => job.decisionBucket === key).length]));
  counts.detail_pending = refreshable.filter((job) => (job.qualityTags || []).includes("detail_unverified")).length;
  counts.activity_pending = refreshable.filter((job) => ((job.qualityTags || []).includes("activity_unverified") || (job.qualityTags || []).includes("stale_or_unknown_active")) && !(job.qualityTags || []).includes("detail_unverified")).length;
  counts.no_reply = noReplyCandidates.length;
  const wanted = pool === "focus" ? new Set(["primary", "talk"]) : new Set([pool]);
  const filtered = candidates.filter((job) => {
    const tags = job.qualityTags || [];
    if (pool === "no_reply") return true;
    if (pool === "detail_pending") return job.decisionBucket === "refresh" && tags.includes("detail_unverified");
    if (pool === "activity_pending") return job.decisionBucket === "refresh" && (tags.includes("activity_unverified") || tags.includes("stale_or_unknown_active")) && !tags.includes("detail_unverified");
    return wanted.has(job.decisionBucket);
  });
  const pageSize = 30;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(searchParams.get("page")) || 1));
  const jobs = filtered.slice((page - 1) * pageSize, page * pageSize);
  return renderCompactDashboard({
    jobs,
    filters: { status: "all", level: "all", fresh: "all", decision: "all", q: "", planId: plan.id, batch: "latest", batchId: null, queuePool: pool, queueScope: scope, queuePage: page, latestMainBatchId },
    latestBatchId: latestMainBatchId || getLatestBatchId(db, { planId: plan.id }),
    title: pool === "no_reply" ? "无回复待跟进" : "当前待处理岗位",
    hint: pool === "no_reply" ? "这里只显示你主动标记为无回复的岗位；跟进文案按需生成一次，不会自动提醒或发送。" : "岗位按唯一记录展示；可切换本轮新增、本轮重复和历史未处理，已投与跳过状态不会因再次扫描丢失。",
    queue: { pool, counts, scope, scopeCounts, total: filtered.length, page, pageSize, totalPages, latestMainBatchId }
  });
}

function renderCommunicationBuilderPage({ db, searchParams }) {
  const plan = getSearchPlan(db, searchParams.get("planId"));
  if (!plan) return renderErrorPage("没有可用的筛选方案。", "/queue");
  const quota = communicationQuota(db);
  const runtimeBlock = communicationRuntimeBlock(db);
  const eligible = listDecisionPool(db, { planId: plan.id }).filter((job) => ["primary", "talk", "backup"].includes(job.decisionBucket)
    && String(job.applicationStatus ?? "").length === 0);
  const selection = PRODUCT_POLICY.operations.bossCommunication.selection;
  const defaultIds = new Set(eligible
    .filter((job) => ["primary", "talk"].includes(job.decisionBucket))
    .slice(0, selection.targetCount)
    .map((job) => job.id));
  const defaultCount = defaultIds.size;
  const targetNotice = defaultCount >= selection.acceptableMin
    ? `已达到日常沟通区间，无需为凑满 ${selection.targetCount} 个补扫。`
    : `当前可沟通候选不足 ${selection.acceptableMin} 个，可在风险额度允许时补扫一轮。`;
  const rows = eligible.map((job) => {
    const checked = defaultIds.has(job.id) ? " checked" : "";
    return `<label class="communication-job"><input type="checkbox" name="jobIds" value="${escapeAttr(job.id)}"${checked}><span><strong>${escapeHtml(job.title)}</strong><br><small>${escapeHtml(job.company || "")} · ${escapeHtml(job.decisionBucket)}</small></span></label>`;
  }).join("") || "<p>当前没有可加入的岗位。</p>";
  const blockNotice = runtimeBlock ? `<p class="communication-warning">${escapeHtml(runtimeBlock.reasonCode)}${runtimeBlock.blockedUntil ? ` · ${escapeHtml(runtimeBlock.blockedUntil)}` : ""}</p>` : "";
  return renderPage("批量沟通清单", `<style>.communication-layout{max-width:860px}.communication-job{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid #d8e0e6}.communication-job input{width:auto;margin-top:4px}.communication-summary{position:sticky;bottom:0;background:#fff;border-top:1px solid #ccd7df;padding:12px 0}.communication-warning{color:#9a4b42;font-weight:700}</style><main class="communication-layout"><nav>${navLinks(`/plan?planId=${plan.id}`)}</nav><h1>批量沟通清单</h1>${blockNotice}<p>24 小时额度：已用 ${quota.used}，预留 ${quota.reserved}，剩余 ${quota.remaining}/${quota.limit}。</p><p>${escapeHtml(targetNotice)}</p><form id="communication-batch-form" method="post" action="/api/communication-batch"><input type="hidden" name="planId" value="${escapeAttr(plan.id)}"><label>浏览器 <select name="browserMode"><option value="edge">当前 Edge</option><option value="portable">项目专用 Edge</option></select></label><section>${rows}</section><div class="communication-summary">已选 <output id="selected-count" for="communication-batch-form">0</output> 项 <button${quota.remaining ? "" : " disabled"}>确认清单</button></div></form></main><script>(function(){const form=document.getElementById('communication-batch-form');const output=document.getElementById('selected-count');const update=()=>{output.value=form.querySelectorAll('input[name="jobIds"]:checked').length};form.addEventListener('change',update);update()}());</script>`);
}

function renderCommunicationReviewPage({ db, searchParams }) {
  const result = communicationApiResult(() => communicationStatus(db, searchParams.get("batchId")));
  if (!result.ok) return renderErrorPage(result.body.error, "/queue", { code: result.body.errorCode });
  const { batch, summary, items, quota, calibration, runtimeBlock } = result.body;
  const counts = Object.entries(summary.statusCounts).map(([status, count]) => `${escapeHtml(status)}: ${count}`).join(" · ") || "pending: 0";
  const rows = items.map((item) => {
    const resolution = item.status === "ambiguous" ? `<form class="communication-resolution" method="post" action="/api/communication-resolve"><input type="hidden" name="batchId" value="${item.batchId}"><input type="hidden" name="itemId" value="${item.id}"><label>处理依据<input name="evidenceNote" maxlength="1000" placeholder="例如：聊天页已显示对应岗位和招聘方" required></label><div><button name="status" value="succeeded">确认已沟通</button><button name="status" value="stopped">标记停止</button></div></form>` : "";
    return `<tr><td>${item.position}</td><td><a href="${escapeAttr(item.jobUrl)}" target="_blank">${escapeHtml(item.titleSnapshot)}</a><br><small>${escapeHtml(item.companySnapshot)}</small></td><td>${escapeHtml(item.status)}</td><td>${resolution}</td></tr>`;
  }).join("");
  const blockNotice = runtimeBlock ? `<p class="communication-warning">${escapeHtml(runtimeBlock.reasonCode)}${runtimeBlock.blockedUntil ? ` · ${escapeHtml(runtimeBlock.blockedUntil)}` : ""}</p>` : "";
  const action = batch.status === "confirmed" ? "start" : batch.status === "paused" ? "resume" : "";
  const executeControl = action && calibration.executionEnabled && !runtimeBlock
    ? `<form method="post" action="/api/communication-control"><input type="hidden" name="batchId" value="${batch.id}"><button name="action" value="${action}">${action === "start" ? "开始沟通" : "继续沟通"}</button></form>`
    : batch.status === "running" ? "<strong>沟通执行中</strong>" : "";
  const discardControl = ["confirmed", "paused"].includes(batch.status)
    ? `<form method="post" action="/api/communication-control"><input type="hidden" name="batchId" value="${batch.id}"><button name="action" value="discard">安全撤回</button></form>` : "";
  const calibrationNotice = calibration.executionEnabled ? "" : `<p class="communication-warning">校准状态：${escapeHtml(calibration.status)}，执行保持禁用。</p>`;
  return renderPage("批量沟通审阅", `<style>.communication-layout{max-width:960px}.communication-warning{color:#9a4b42;font-weight:700}.communication-table{width:100%;border-collapse:collapse}.communication-table th,.communication-table td{padding:8px;border-bottom:1px solid #d8e0e6;text-align:left;vertical-align:top}.communication-controls{display:flex;gap:8px;align-items:center;margin:14px 0}.communication-resolution{display:grid;gap:7px;min-width:260px}.communication-resolution label{display:grid;gap:4px}.communication-resolution div{display:flex;gap:6px}@media(max-width:760px){.communication-table,.communication-table tbody,.communication-table tr,.communication-table td{display:block;width:100%;box-sizing:border-box}.communication-table thead{display:none}.communication-table tr{padding:10px 0;border-bottom:1px solid #d8e0e6}.communication-table td{padding:4px 0;border:0}.communication-resolution{min-width:0}.communication-resolution div{flex-wrap:wrap}}</style><main class="communication-layout"><nav>${navLinks(`/plan?planId=${batch.planId}`)}<a href="/communication/new?planId=${batch.planId}">新建沟通清单</a></nav><h1>批量沟通审阅 #${batch.id}</h1><p>校准状态：${escapeHtml(calibration.status)}</p>${calibrationNotice}${blockNotice}<p>批次：${escapeHtml(batch.status)} · 已选：${summary.total} · ${counts}</p><p>24 小时额度：已用 ${quota.used}，预留 ${quota.reserved}，剩余 ${quota.remaining}/${quota.limit}。</p><div class="communication-controls">${executeControl}${discardControl}</div><table class="communication-table"><thead><tr><th>#</th><th>岗位</th><th>状态</th><th>人工处理</th></tr></thead><tbody>${rows}</tbody></table></main>`);
}

function compactAwaitingAction(job) {
  return isJobAwaitingAction(job);
}

function queueScopeForJob(job, latestMainBatchId) {
  if (!latestMainBatchId) return "backlog";
  if (Number(job.firstBatchId) === Number(latestMainBatchId)) return "new";
  if (Number(job.latestScanBatchId) === Number(latestMainBatchId)) return "repeated";
  return "backlog";
}

function renderCompactDashboard(data) {
  const { jobs = [], filters = {}, latestBatchId, queue = null, title = "投递操作台", hint = "" } = data;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
body{margin:0;background:#f5f7f8;color:#1f2933;font-family:Segoe UI,Microsoft YaHei,sans-serif}main{max-width:1100px;margin:0 auto;padding:22px 18px 48px}nav{display:flex;gap:14px;margin-bottom:20px}a{color:#1265a8;text-decoration:none}a:hover{text-decoration:underline}h1{font-size:24px;margin:0 0 7px}.hint{color:#5b6773;margin:0 0 16px}.panel{background:#fff;border:1px solid #d8e0e6;border-radius:8px;padding:12px 14px;margin:12px 0}.pool-tabs{display:flex;flex-wrap:wrap;gap:8px}.pool-tabs+.pool-tabs{margin-top:9px}.pool-tab{padding:7px 10px;border:1px solid #ccd7df;border-radius:6px;background:#fff;color:#344450}.pool-tab.active{background:#e6f3f0;border-color:#68aa9b;color:#155f54;font-weight:700;text-decoration:none}.queue-summary{margin-top:10px;color:#5b6773;font-size:13px}.pager{display:flex;justify-content:center;align-items:center;gap:10px;margin-top:14px}.pager a,.pager span{padding:7px 10px;border:1px solid #ccd7df;border-radius:5px;background:#fff}.filters{display:grid;grid-template-columns:repeat(6,minmax(110px,1fr)) auto;gap:8px}.filters input,.filters select,input,select{box-sizing:border-box;min-width:0;padding:8px;border:1px solid #b9c5ce;border-radius:5px;background:#fff}.job{background:#fff;border:1px solid #d7e0e6;border-radius:8px;padding:14px 16px;margin:10px 0}.job-top{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.job-title{font-size:16px;font-weight:700;line-height:1.35}.job-meta,.job-reason,.job-risk,.line{margin-top:7px;font-size:14px;line-height:1.45;color:#53616d}.job-reason{color:#27604f}.job-risk{color:#9a4b42}.decision{display:inline-block;white-space:nowrap;border:1px solid #d8e0e6;border-radius:999px;padding:4px 8px;font-size:12px;font-weight:700}.primary{background:#e6f3f0;border-color:#86b9ad;color:#155f54}.talk{background:#eef4fa;border-color:#9cbcdc;color:#245b87}.backup{background:#fff6df;border-color:#ead29a;color:#825b13}.analysis_pending{background:#f1f3f5;border-color:#b9c3cc;color:#46535e}.refresh{background:#f5f0fd;border-color:#c8b8e6;color:#64419b}.not_recommended{background:#f9e9e7;border-color:#e5b3ae;color:#9b3f37}.quick-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.quick-actions select{max-width:190px}button{padding:7px 10px;cursor:pointer;border:1px solid #aab8c2;border-radius:5px;background:#fff;color:#25313a}.apply{background:#176b5b;border-color:#176b5b;color:#fff}.skip{color:#8a3a33}.details{margin-top:11px;border-top:1px solid #e4e9ed;padding-top:9px}.details summary{cursor:pointer;color:#4f6170;font-size:13px}.detail-body{margin-top:10px}.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.chip{border:1px solid #d8dee4;border-radius:999px;padding:3px 7px;font-size:12px;background:#f6f8fa}.risk{background:#f9e9e7;border-color:#e5b3ae}.jd{white-space:pre-wrap;background:#f7f9fa;border-left:3px solid #2a7185;padding:9px 10px;font-size:13px;line-height:1.55}.detail-actions,.follow{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:10px}.detail-actions input,.follow input{flex:1 1 220px}textarea{box-sizing:border-box;width:100%;min-height:52px;margin-top:8px;padding:8px;border:1px solid #b9c5ce;border-radius:5px;background:#fafcfd}@media(max-width:760px){.filters{grid-template-columns:1fr 1fr}.job-top{display:block}.decision{margin-top:7px}}</style><main>
<nav><a href="/onboarding">简历</a>${filters.planId ? `<a href="/plan?planId=${escapeAttr(filters.planId)}">筛选方案</a><a href="/queue?planId=${escapeAttr(filters.planId)}">当前岗位</a>` : ""}<a href="/settings">模型设置</a><a href="/diagnostics">诊断</a></nav><h1>${escapeHtml(title)}</h1><p class="hint">${escapeHtml(hint)}${latestBatchId ? ` 主扫描批次 #${latestBatchId}` : ""}</p>
${queue ? renderCompactPoolTabs(queue, filters.planId) : renderCompactFilters(filters)}
${jobs.map((job) => renderCompactJob(job, filters)).join("") || "<section class=\"panel\">这个分组目前没有岗位。</section>"}${queue ? renderCompactPager(queue, filters.planId) : ""}</main><script>async function copyGreeting(id){const el=document.getElementById(id);if(el)await navigator.clipboard.writeText(el.value);}</script></html>`;
}

function renderCompactPoolTabs(queue, planId) {
  const scopes = [["all", "全部待处理", queue.scopeCounts.all || 0], ["new", "本轮新增", queue.scopeCounts.new || 0], ["repeated", "本轮重复", queue.scopeCounts.repeated || 0], ["backlog", "历史未处理", queue.scopeCounts.backlog || 0]];
  const tabs = [["focus", "主投 + 先聊", (queue.counts.primary || 0) + (queue.counts.talk || 0)], ["primary", "主投", queue.counts.primary || 0], ["talk", "先聊确认", queue.counts.talk || 0], ["backup", "备选", queue.counts.backup || 0], ["analysis_pending", "待语义分析", queue.counts.analysis_pending || 0], ["detail_pending", "待读详情", queue.counts.detail_pending || 0], ["activity_pending", "活跃待核验", queue.counts.activity_pending || 0], ["no_reply", "无回复跟进", queue.counts.no_reply || 0], ["not_recommended", "不建议", queue.counts.not_recommended || 0]];
  const scopeLinks = scopes.map(([key, label, count]) => `<a class="pool-tab ${queue.scope === key ? "active" : ""}" href="${queueHref(planId, queue.pool, key, 1)}">${escapeHtml(label)} ${count}</a>`).join("")
    + `<a class="pool-tab" href="/communication/new?planId=${escapeAttr(planId)}">批量沟通清单</a>`;
  const poolLinks = tabs.map(([key, label, count]) => `<a class="pool-tab ${queue.pool === key ? "active" : ""}" href="${queueHref(planId, key, queue.scope, 1)}">${escapeHtml(label)} ${count}</a>`).join("");
  const from = queue.total ? (queue.page - 1) * queue.pageSize + 1 : 0;
  const to = Math.min(queue.total, queue.page * queue.pageSize);
  return `<section class="panel"><div class="pool-tabs">${scopeLinks}</div><div class="pool-tabs">${poolLinks}</div><div class="queue-summary">当前显示 ${from}-${to} / 共 ${queue.total} 条；范围以主扫描批次 #${escapeHtml(queue.latestMainBatchId || "-")} 为准。</div></section>`;
}

function renderCompactPager(queue, planId) {
  if (queue.totalPages <= 1) return "";
  const previous = queue.page > 1 ? `<a href="${queueHref(planId, queue.pool, queue.scope, queue.page - 1)}">上一页</a>` : "<span>上一页</span>";
  const next = queue.page < queue.totalPages ? `<a href="${queueHref(planId, queue.pool, queue.scope, queue.page + 1)}">下一页</a>` : "<span>下一页</span>";
  return `<nav class="pager">${previous}<strong>第 ${queue.page} / ${queue.totalPages} 页</strong>${next}</nav>`;
}

function queueHref(planId, pool, scope, page) {
  const params = new URLSearchParams({ planId: String(planId), pool, scope, page: String(page) });
  return `/queue?${params.toString()}`;
}

function renderCompactFilters(filters) {
  return `<form class="panel filters" method="get" action="/jobs"><input type="hidden" name="planId" value="${escapeAttr(filters.planId || "")}">${select("status", filters.status, [["pending", "未处理"], ["review", "待确认"], ["later", "保留"], ["applied", "已投"], ["skipped", "跳过"], ["all", "全部"]])}${select("decision", filters.decision, [["all", "全部投递池"], ["primary", "主投"], ["talk", "先聊确认"], ["backup", "备选"], ["analysis_pending", "待语义分析"], ["refresh", "待刷新"], ["not_recommended", "不建议"]])}${select("level", filters.level, [["all", "全部级别"], ["优先", "优先"], ["可投", "可投"], ["可冲", "可冲"], ["谨慎", "谨慎"], ["不建议", "不建议"]])}${select("fresh", filters.fresh, [["all", "新增+重复"], ["new", "本批新增"], ["repeated", "重复出现"]])}${select("batch", filters.batchId ? String(filters.batchId) : filters.batch, [["latest", "最新批次"], ["all", "全部历史"]])}<input name="q" value="${escapeAttr(filters.q || "")}" placeholder="搜索标题/公司/地点"><button>过滤</button></form>`;
}

function renderCompactJob(job, filters) {
  const analysis = job.analysis || {};
  const query = compactQuery(filters);
  const context = `${job.profileId ? `<input type="hidden" name="profileId" value="${escapeAttr(job.profileId)}">` : ""}${job.searchPlanId ? `<input type="hidden" name="planId" value="${escapeAttr(job.searchPlanId)}">` : ""}`;
  const jobContext = `<input type="hidden" name="jobId" value="${escapeAttr(job.id)}">${context}`;
  const fitReason = (analysis.fitReasons || []).slice(0, 2).join("；") || "岗位方向与当前简历的匹配信息待补充。";
  const refreshFailure = compactRefreshFailure(job);
  const risk = refreshFailure || analysis.error || (job.risks || []).slice(0, 2).join("；") || "暂无明显硬风险；工作制与团队情况可在沟通时确认。";
  const status = job.applicationStatus ? ` · ${statusLabel(job)}` : "";
  const salaryLabel = job.salary || ((job.qualityTags || []).includes("salary_unverified") ? "薪资待确认" : "薪资未说明");
  const experienceLabel = job.experience || ((job.qualityTags || []).includes("experience_unverified") ? "经验待确认" : "经验未说明");
  const greetingAction = canGenerateGreeting(job) ? `<form class="detail-actions" method="post" action="/api/communication">${jobContext}<input type="hidden" name="mode" value="greeting"><button>生成定制招呼语</button></form>` : "";
  const followUpAction = job.applicationStatus === "no_reply" ? `<form class="detail-actions" method="post" action="/api/communication">${jobContext}<input type="hidden" name="mode" value="follow_up"><button>生成一次跟进文案</button></form>` : "";
  const hrReplyAction = `<form class="follow" method="post" action="/api/communication">${jobContext}<input type="hidden" name="mode" value="hr_reply"><textarea name="hrMessage" placeholder="粘贴 HR 原话" required></textarea><button>生成 HR 回复</button></form>`;
  const feedbackAction = `<form class="follow" method="post" action="/api/feedback${query}">${jobContext}${feedbackReasonSelect("", true)}<input name="note" placeholder="具体哪里推荐错了（可选）"><button>提交推荐反馈</button></form>`;
  const retryAnalysisAction = job.decisionBucket === "analysis_pending" ? `<form class="quick-actions" method="post" action="/api/analyze-job">${jobContext}<button>重试语义分析</button></form>` : "";
  return `<article class="job"><div class="job-top"><div><div class="job-title">${escapeHtml(job.title)}${job.url ? ` · <a href="${escapeAttr(job.url)}" target="_blank">打开岗位</a>` : ""}</div><div class="job-meta">${escapeHtml(job.company || "")} · ${escapeHtml(job.location || "")} · ${escapeHtml(salaryLabel)} · ${escapeHtml(experienceLabel)} · ${escapeHtml(compactActivityLabel(job))}${escapeHtml(status)}</div><div class="job-meta">${escapeHtml(compactSeenLabel(job, filters.latestMainBatchId))}</div></div><span class="decision ${escapeAttr(job.decisionBucket || "backup")}">${escapeHtml(compactDecisionLabel(job.decisionBucket))}</span></div><div class="job-reason">${escapeHtml(fitReason)}</div><div class="job-risk">${escapeHtml(risk)}</div>${retryAnalysisAction}${job.followUpNote ? `<div class="line"><strong>沟通记录：</strong>${escapeHtml(job.followUpNote)}</div>` : ""}<form class="quick-actions" method="post" action="/api/mark${query}">${jobContext}<button class="apply" name="status" value="applied">已投</button><button name="status" value="review">待确认</button><button name="status" value="later">7 天后再看</button><button class="skip" name="status" value="skipped">跳过</button></form><details class="details"><summary>查看 JD、沟通与完整记录</summary><div class="detail-body"><div class="line">决策来源：${escapeHtml(compactDecisionSource(analysis))} · 工作节奏：${escapeHtml(compactScheduleLabel(analysis))} · 推荐简历：${escapeHtml(analysis.recommendedResumeVersionName || analysis.recommendedResumeVersion || "待确认")} · 主推项目：${escapeHtml((analysis.primaryProjects || []).join("、") || "待确认")}</div><div class="chips">${chips(job.risks, "risk")}${chips(job.qualityTags, "tag")}</div><div class="jd">${escapeHtml(String(job.description || "暂无完整 JD").slice(0, 1500))}</div>${greetingAction}${followUpAction}${hrReplyAction}<form class="detail-actions" method="post" action="/api/mark${query}">${jobContext}<input name="note" placeholder="状态备注（可选）"><button name="status" value="no_reply">无回复待跟进</button><button name="status" value="interview">约面</button><button name="status" value="rejected">拒绝</button><button name="status" value="invalid">岗位无效</button><button name="status" value="salary_mismatch">薪资不匹配</button></form><form class="follow" method="post" action="/api/follow-up${query}">${jobContext}<input name="note" placeholder="记录沟通进展"><button>记录备注</button></form>${feedbackAction}</div></details></article>`;
}

function compactSeenLabel(job, latestMainBatchId) {
  const scope = queueScopeForJob(job, latestMainBatchId);
  const scopeLabel = { new: "本轮新增", repeated: "本轮重复", backlog: "历史未处理" }[scope] || "历史未处理";
  return `${scopeLabel} · 首次 ${compactDateTime(job.firstSeenAt)} · 最近 ${compactDateTime(job.lastSeenAt)}`;
}

function compactDateTime(value) {
  const text = String(value || "");
  return text ? text.replace("T", " ").slice(0, 16) : "未知";
}

function compactDecisionLabel(bucket) {
  return { primary: "主投", talk: "先聊确认", backup: "备选", analysis_pending: "待语义分析", refresh: "待刷新", not_recommended: "不建议" }[bucket] || "备选";
}

function compactDecisionSource(analysis = {}) {
  return {
    model: "模型证据匹配",
    model_partial: "模型初步判断",
    model_low_confidence: "模型低置信度复核",
    hard_boundary: "基础硬条件",
    source_refresh: "来源信息待刷新",
    local_rules: "本地基础规则",
    analysis_pending: "等待模型分析"
  }[analysis.decisionSource] || "待确认";
}

function compactScheduleLabel(analysis = {}) {
  return { double_weekend: "双休", alternating_weekend: "大小周/单双休", single_weekend: "单休", unknown: "未说明" }[analysis.workSchedule || "unknown"];
}

function compactActivityLabel(job = {}) {
  const label = job.bossActiveText || "活跃度待确认";
  const effectiveDays = Number(job.effectiveBossActiveDays);
  if (Number.isFinite(effectiveDays) && effectiveDays <= 3) return "3日内活跃";
  const age = Number(job.daysSinceLastSeen);
  return Number.isFinite(age) && age > 0 ? `${label}（${age}天前采集）` : label;
}

function compactRefreshFailure(job = {}) {
  if (job.refreshResult !== "failed") return "";
  const reason = {
    BOSS_LOGIN_REQUIRED: "登录状态不可用",
    BOSS_TAB_REQUIRED: "未找到可用 BOSS 页面",
    BOSS_PANE_SWITCH_TIMEOUT: "岗位详情加载超时",
    BOSS_CARD_NOT_FOUND: "岗位卡片已不可见",
    BOSS_INVALID_LINK: "岗位链接失效"
  }[job.refreshErrorCode] || "岗位详情补读失败";
  const retry = job.refreshNextRetryAt ? `，${String(job.refreshNextRetryAt).replace("T", " ").slice(0, 16)} 后可重试` : "";
  return `${reason}（已尝试 ${job.refreshAttemptNumber || 1} 次${retry}）`;
}

function compactQuery(filters) {
  const params = new URLSearchParams();
  if (filters.planId) params.set("planId", String(filters.planId));
  if (filters.queuePool) params.set("pool", filters.queuePool);
  if (filters.queueScope) params.set("scope", filters.queueScope);
  if (filters.queuePage) params.set("page", String(filters.queuePage));
  return params.size ? `?${params.toString()}` : "";
}

function select(name, value, options) {
  return `<select name="${escapeAttr(name)}">${options.map(([v, label]) => `<option value="${escapeAttr(v)}"${String(value) === String(v) ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select>`;
}

function feedbackReasonSelect(selected = "", required = false) {
  return `<select name="reasonCode" aria-label="不匹配原因"${required ? " required" : ""}><option value="">${required ? "选择推荐问题" : "不匹配原因（可选）"}</option>${FEEDBACK_REASON_OPTIONS.map((item) => `<option value="${escapeAttr(item.code)}"${item.code === selected ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select>`;
}

function chips(values = [], cls = "") {
  return values.map((value) => {
    const label = cls === "tag" ? workScheduleTagLabel(value) || qualityLabel(value) : value;
    return `<span class="chip ${cls}">${escapeHtml(label)}</span>`;
  }).join("");
}

function workScheduleTagLabel(value) {
  return {
    work_schedule_double: "双休明确",
    work_schedule_unknown: "工作制未说明",
    work_schedule_alternating: "大小周或单双休",
    work_schedule_single: "单休",
    work_schedule_low_priority: "工作节奏与薪资叠加低优先"
  }[value] || "";
}

function qualityLabel(value) {
  return {
    possible_duplicate: "疑似同公司同岗位重复",
    detail_changed: "岗位详情有变更",
    needs_recheck: "超过 14 天未再次出现，建议复核",
    duplicate_seen: "历史重复出现",
    location_mismatch: "地点不匹配",
    location_unverified: "地点待核验",
    inactive_boss: "招聘方不活跃",
    stale_or_unknown_active: "招聘方活跃状态需更新",
    activity_unverified: "招聘方活跃状态待刷新",
    missing_link: "缺少岗位链接",
    invalid_job_link: "岗位链接无效",
    role_mismatch: "岗位明显不属于技术开发或交付",
    internship_role: "实习岗位，不进入当前社招主投池",
    algorithm_role: "纯算法/训练岗位，不进入当前主投池",
    algorithm_hybrid: "算法训练占比待确认",
    hard_exclude: "命中硬排除条件",
    experience_stretch: "经验要求可冲刺",
    experience_stretch_low_salary: "3-5年但薪资偏初中级，可冲",
    salary_target_core: "薪资与目标贴合",
    salary_target_stretch: "薪资略高，可先聊",
    salary_target_high: "高薪资备选",
    salary_unverified: "薪资待确认",
    experience_unverified: "经验待确认",
    core_stack_mismatch: "核心技术栈不匹配",
    java_backend_heavy: "Java/Spring 主栈待确认",
    senior_engineering_heavy: "资深工程化要求较重",
    low_value_risk: "低价值风险"
  }[value] || String(value || "");
}

function statusLabel(job) {
  if (job.applicationStatus === "interview") return `已约面${job.applicationNote ? `：${job.applicationNote}` : ""}`;
  if (job.applicationStatus === "rejected") return `已拒绝${job.applicationNote ? `：${job.applicationNote}` : ""}`;
  if (job.applicationStatus === "invalid") return `岗位无效${job.applicationNote ? `：${job.applicationNote}` : ""}`;
  if (job.applicationStatus === "salary_mismatch") return `薪资不匹配${job.applicationNote ? `：${job.applicationNote}` : ""}`;
  if (job.applicationStatus === "applied") return `已投${job.applicationNote ? `：${job.applicationNote}` : ""}`;
  if (job.applicationStatus === "skipped") return `已跳过${job.applicationNote ? `：${job.applicationNote}` : ""}`;
  if (job.applicationStatus === "no_reply") return `无回复/待跟进${job.applicationNote ? `：${job.applicationNote}` : ""}`;
  if (job.applicationStatus === "review") return `需要人工复核${job.applicationNote ? `：${job.applicationNote}` : ""}`;
  if (job.applicationStatus === "later") return `稍后处理${job.reviewAt ? `：${job.reviewAt}` : ""}${job.applicationNote ? ` · ${job.applicationNote}` : ""}`;
  return "未处理";
}

function refererPath(req) {
  try {
    const url = new URL(req.headers.referer || "/", "http://127.0.0.1");
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}

function sendHtml(res, html, statusCode = 200) {
  res.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

module.exports = { createDashboardServer, startPlanScan, scanStatus, handleMarkApi, handleFollowUpApi, getDashboardData, filterJobs, renderDashboard, renderQueuePage, renderPlanPage };
