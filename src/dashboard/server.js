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
  savePlatformFilterCatalog,
  getSiteRuntimeState,
  setSiteRuntimeState,
  getSiteScanLease,
  acquireSiteScanLease,
  renewSiteScanLease,
  releaseSiteScanLease,
  listSiteAccessEvents,
  createScanRun,
  createWorkflowRun,
  getWorkflowRun,
  getScanRun,
  attachWorkflowScan,
  getWorkflowHealthSnapshot,
  getWorkflowRunByCommunicationBatch,
  listWorkflowRuns,
  getActiveWorkflowRun,
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
  listMatchingResumeVersions,
  listProfileVersions,
  recordResumeParseAttempt,
  listResumeParseAttempts,
  saveSearchPlan,
  rescorePlanObservations,
  compareProfileVersions,
  getSearchPlanDependency,
  getActiveMatchingCard,
  getMatchingCard,
  listMatchingCards,
  createMatchingCardDraft,
  saveMatchingCardDraftEdit,
  confirmMatchingCard,
  getCandidateMatchingContext,
  listDecisionPool,
  listDecisionQueue,
  recordCandidateJobEvent,
  recordRecommendationFeedback,
  saveCandidateFact,
  listCandidateFacts,
  isJobAwaitingAction,
  OUTCOME_STATUSES,
  getOutcomeAnalyticsSnapshot
} = require("../core/storage");
const {
  createCommunicationBatch,
  getCommunicationBatch,
  listCommunicationBatchItems,
  setCommunicationBatchStatus,
  resumeInterruptedCommunicationBatch,
  resolveAmbiguousCommunicationItem,
  transitionCommunicationItem,
  communicationBatchSummary,
  communicationQuotaSnapshot
} = require("../core/communication_batches");
const {
  PROGRESS_STAGES,
  ensureProgressCard,
  transitionProgressCard,
  correctProgressStage,
  getProgressCardForJob,
  getProgressCardById,
  recordManualProgressAction,
  listProgressCardsWithEvents
} = require("../core/candidate_progress");
const { parseResumeUpload, parseResumeText, MAX_UPLOAD_BYTES } = require("../core/resume_parser");
const { analyzeResumeProfile, recommendPlanForProfile, prepareResumeTextForModel, buildCandidateMatchCard } = require("../core/profile_onboarding");
const { matchingCardFromProfile, matchingCardRevision } = require("../core/matching_card");
const { createLlmAnalyzer } = require("../core/llm_analyzer");
const { normalizeCandidateProfile, normalizeSearchPlan } = require("../core/profile_schema");
const { CITY_CODES, planKeywords, profileToRuntimeConfigs, resolveScanPolicy } = require("../core/search_plan");
const { resolveNativeFilterSnapshot, formatNativeFilterSummary } = require("../core/platform_filters");
const { isBossDetailAccessAction } = require("../core/site_access_usage");
const { loadConfigs } = require("../config");
const { validateSearchPlan, assertSearchPlanReady } = require("../core/plan_validation");
const { createLogger, appError, errorMeta, publicError, workflowLogContext } = require("../core/observability");
const {
  listModelPresets,
  listModelTaskProfiles,
  loadModelSettings,
  saveVerifiedModelTaskProfile,
  saveVerifiedBatchBackup,
  restoreRecommendedTaskProfile,
  testModelConnection,
  resolveRuntimeModelConfig,
  resolveRuntimeBatchBackup,
  isModelReady,
  supportsDeepSeekV4Thinking
} = require("../core/model_settings");
const { FEEDBACK_REASON_OPTIONS, normalizeFeedbackReason, feedbackReasonLabel } = require("../core/feedback");
const { storeResumeSourceFile, resolveResumeSourceFile } = require("../core/resume_files");
const { PRODUCT_POLICY } = require("../core/product_policy");
const { defaultSelectedForBatch } = require("../core/decision_policy");
const { communicationCalibrationStatus, assertCommunicationExecutionEnabled } = require("../core/communication_calibration");
const { buildScanCliArgs } = require("../core/scan_execution");
const { validateResumeBatch } = require("../core/scan_resume");
const { scoreJob, decisionState } = require("../core/scoring");
const { createJobAnalysisRunner } = require("../core/job_analysis");
const { mapWithConcurrency } = require("../core/async_pool");
const {
  chinaLocalDay,
  planWorkflowRun,
  consumedWorkflowBudget,
  countSlotConsumingRuns,
  recoverWorkflowRuns
} = require("../core/workflow_run");
const {
  workflowEligibility,
  listWorkflowInventory,
  listWorkflowReviewCandidates
} = require("../core/workflow_inventory");
const { buildWorkflowHealthReport } = require("../core/workflow_health");
const { getWorkflowProgressSnapshot } = require("../core/workflow_progress");
const {
  requestWorkflowPause,
  resumeWorkflowRun,
  requestWorkflowStop,
  finalizeWorkflowControl,
  workflowStopPreview
} = require("../core/workflow_control");
const { renderWorkflowHealthPanel } = require("./workflow_health_view");
const { listScopedKeywordStats } = require("../core/scoped_keyword_stats");

const PROGRESS_ACTIONS = Object.freeze({
  reply_confirmed_sent: {
    stage: "waiting_reply",
    eventType: "reply_confirmed_sent",
    summary: "用户确认已手动发送",
    nextAction: "等待招聘方回复"
  },
  mark_needs_user_action: {
    stage: "needs_user_action",
    eventType: "manual_review_requested",
    summary: "用户标记需要处理",
    nextAction: "请用户确认下一步"
  },
  mark_interview_invited: {
    stage: "interview_invited",
    eventType: "interview_invited",
    summary: "用户确认收到面试邀约",
    nextAction: "请用户决定是否接受并安排时间"
  },
  mark_interview_scheduled: {
    stage: "interview_scheduled",
    eventType: "interview_scheduled",
    summary: "",
    nextAction: "按已确认时间参加面试"
  },
  mark_resume_submitted: {
    stage: "resume_submitted",
    eventType: "resume_submitted",
    summary: "用户确认已投递简历",
    nextAction: "等待招聘方后续反馈"
  },
  mark_rejected: {
    stage: "rejected",
    eventType: "rejected",
    summary: "用户确认已拒绝",
    nextAction: ""
  },
  close_opportunity: {
    stage: "closed",
    eventType: "opportunity_closed",
    summary: "用户关闭机会",
    nextAction: ""
  },
  reopen_opportunity: {
    stage: "needs_user_action",
    eventType: "opportunity_reopened",
    summary: "用户重新开启机会",
    nextAction: "请用户确认下一步"
  }
});
const {
  buildInheritedSearchScope,
  assertInheritedAcquisitionScope,
  assertCompleteInheritedContext,
  freezeKeywordSource,
  scopeShortId
} = require("../core/inherited_search_scope");
const { compilePlatformRuntimePolicy } = require("../core/platform_runtime_policy");
const { EdgeControlAdapter } = require("../adapters/browser/edge_control");
const { CdpBrowserAdapter } = require("../adapters/browser/cdp");
const { createMessageDiscoveryController } = require("./message_discovery_controller");
const { renderMessageDiscoveryPage } = require("./message_discovery_view");
const boss = require("../adapters/sites/boss");
const { inspectBossBrowserReadiness } = require("../core/browser_readiness");
const { inspectBossOperatorTabs } = require("../core/workspace_tabs");

const VALID_STATUSES = new Set(OUTCOME_STATUSES);
const PORTABLE_CDP_PORT = 9222;
const BROWSER_READINESS_STATUSES = new Set([
  "browser_unavailable",
  "boss_tab_missing",
  "login_required",
  "search_page_required",
  "risk_control",
  "ready"
]);

function normalizeCdpPort(value, fallback = PORTABLE_CDP_PORT) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw appError("INVALID_SCAN_INPUT", "CDP 端口必须是 1 到 65535 之间的整数。", { statusCode: 409 });
  }
  return port;
}

function createDashboardBrowser({ browserMode, cdpPort }) {
  if (browserMode === "portable") return new CdpBrowserAdapter({ port: normalizeCdpPort(cdpPort) });
  if (browserMode === "edge") return new EdgeControlAdapter();
  throw appError("WORKFLOW_BROWSER_MODE_INVALID", "浏览器模式必须是当前 Edge 或项目专用 Edge。", { statusCode: 409 });
}

function createDashboardBrowserReadinessProbe({ logger }) {
  return ({ browserMode = "edge", cdpPort = null } = {}) => inspectDashboardBossBrowserReadiness({
    browserMode,
    cdpPort,
    logger
  });
}

async function inspectDashboardBossBrowserReadiness({
  browserMode = "edge",
  cdpPort = null,
  logger,
  browserFactory = createDashboardBrowser
}) {
  const browser = browserFactory({ browserMode, cdpPort });
  const adapter = new boss.BossSiteAdapter({ browser, logger });
  return inspectBossBrowserReadiness({
    preflight: async () => {
      if (browserMode !== "edge") return adapter.preflight();
      const inspected = await inspectBossOperatorTabs({
        browser,
        inspectTab: (tabId) => adapter.preflight({ tabId })
      });
      return inspected.searchState;
    }
  });
}

function publicBrowserReadinessSnapshot(readiness) {
  const { status, ready, message, checkedAt } = readiness || {};
  if (!BROWSER_READINESS_STATUSES.has(status)
    || typeof ready !== "boolean"
    || ready !== (status === "ready")
    || typeof message !== "string"
    || typeof checkedAt !== "string") {
    throw appError("BROWSER_READINESS_INVALID", "浏览器就绪状态无效。", { statusCode: 500 });
  }
  return { status, ready, message, checkedAt };
}

function resolveNewInheritedBrowser(input = {}) {
  const browserMode = String(input.browserMode || "edge").trim().toLowerCase();
  if (!["edge", "portable"].includes(browserMode)) {
    throw appError(
      "WORKFLOW_BROWSER_MODE_INVALID",
      "新的继承模式必须使用项目专用 Edge。",
      { statusCode: 409 }
    );
  }
  if (browserMode === "edge") return { browserMode: "edge", cdpPort: null };
  const cdpPort = normalizeCdpPort(input.cdpPort);
  if (cdpPort !== PORTABLE_CDP_PORT) {
    throw appError(
      "INHERITED_PORTABLE_PORT_REQUIRED",
      "新的继承模式固定使用项目专用 Edge 的 9222 端口。",
      { statusCode: 409 }
    );
  }
  return { browserMode, cdpPort };
}

function createDashboardServer({
  db,
  root = path.resolve(__dirname, "../.."),
  dbPath = "",
  modelConfig = { provider: "mock", providers: { mock: {} } },
  allowOfflineMock = false,
  forceMock = false,
  modelSettingsLoader = null,
  runtimeModelResolver = null,
  modelReadinessChecker = null,
  batchBackupResolver = null,
  connectionTester = testModelConnection,
  logger = createLogger({ root, component: "dashboard" }),
  spawnProcess = spawn,
  workflowHealth = {},
  outcomeAnalytics = {},
  inheritedContextResolver = resolveLiveInheritedContext,
  browserReadinessProbe = null,
  workflowResumeBrowserReadinessProbe = null,
  workflowControlSchedule = setTimeout,
  workflowControlGraceMs = PRODUCT_POLICY.operations.modelAnalysis.taskLeaseTtlMs,
  messageDiscoveryDependencies = {}
}) {
  const scanRuns = new Map();
  const resolvedBrowserReadinessProbe = browserReadinessProbe
    || createDashboardBrowserReadinessProbe({ logger });
  const resolvedWorkflowResumeBrowserReadinessProbe = workflowResumeBrowserReadinessProbe
    || ((authority) => inspectDashboardBossBrowserReadiness({ ...authority, logger }));
  const resolvedWorkflowHealth = {
    getSnapshot: workflowHealth?.getSnapshot || getWorkflowHealthSnapshot,
    buildReport: workflowHealth?.buildReport || buildWorkflowHealthReport,
    renderPanel: workflowHealth?.renderPanel || renderWorkflowHealthPanel
  };
  const outcomeAnalyticsReader = outcomeAnalytics?.getSnapshot || getOutcomeAnalyticsSnapshot;
  const recovery = recoverWorkflowRuns(db, {
    site: "boss",
    orphanTimeoutMs: PRODUCT_POLICY.operations.scanOrphanTimeoutMs
  });
  if (recovery.scanRunsInterrupted || recovery.workflowRunsInterrupted || recovery.workflowRunsCompleted) {
    logger.warn("workflow_recovery_reconciled", recovery);
  }
  const offlineConnection = {
    status: "verified",
    checkedAt: "2099-01-01T00:00:00.000Z",
    latencyMs: 0,
    httpStatus: 0,
    fingerprint: "offline-structured-mock"
  };
  const offlineMockState = {
    source: "runtime",
    settings: {
      schemaVersion: 2,
      credentialMode: "shared",
      sharedCredential: { preset: "mock", provider: "mock", baseUrl: "" },
      taskProfiles: {
        deep_analysis: {
          model: "offline-structured-mock",
          timeoutMs: 30000,
          thinkingMode: "disabled",
          reasoningEffort: "high",
          concurrency: 1,
          credentialRef: "shared",
          revision: "offline-structured-mock",
          connection: { ...offlineConnection }
        },
        batch_screening: {
          model: "offline-structured-mock",
          timeoutMs: 30000,
          thinkingMode: "disabled",
          reasoningEffort: "high",
          concurrency: 1,
          credentialRef: "shared",
          revision: "offline-structured-mock",
          connection: { ...offlineConnection }
        }
      },
      independentCredentials: { deep_analysis: null, batch_screening: null },
      batchBackup: {
        enabled: false,
        credentialRef: "shared",
        preset: "mock",
        provider: "mock",
        baseUrl: "",
        model: "offline-structured-mock",
        timeoutMs: 30000,
        thinkingMode: "disabled",
        reasoningEffort: "high",
        revision: "offline-structured-mock",
        connection: { ...offlineConnection }
      },
      revision: "offline-structured-mock",
      preset: "mock",
      provider: "mock",
      baseUrl: "",
      model: "offline-structured-mock",
      timeoutMs: 30000,
      thinkingMode: "disabled",
      reasoningEffort: "high",
      connection: { ...offlineConnection }
    },
    keyConfigured: false,
    keyReadable: false,
    keyStored: false,
    keyErrorCode: "",
    connectionStatus: "verified",
    modelConfig: { provider: "mock", providers: { mock: { model: "offline-structured-mock" } } }
  };
  const getPublicModelSettings = () => modelSettingsLoader
    ? modelSettingsLoader({ root, fallbackModelConfig: modelConfig })
    : forceMock
      ? offlineMockState
      : loadModelSettings({ root, fallbackModelConfig: modelConfig });
  const getRuntimeModelState = (taskProfile) => runtimeModelResolver
    ? runtimeModelResolver({ root, fallbackModelConfig: modelConfig, taskProfile })
    : forceMock
      ? offlineMockState
      : resolveRuntimeModelConfig({ root, fallbackModelConfig: modelConfig, taskProfile });
  const getRuntimeModel = (taskProfile) => getRuntimeModelState(taskProfile).modelConfig;
  const modelReady = (taskProfile, options = {}) => {
    if ((allowOfflineMock || forceMock) && !modelReadinessChecker) return true;
    const state = getRuntimeModelState(taskProfile);
    const checker = modelReadinessChecker || isModelReady;
    return checker(state, { taskProfile, ...options });
  };
  const getRuntimeBatchBackup = () => batchBackupResolver
    ? batchBackupResolver({ root, fallbackModelConfig: modelConfig })
    : forceMock
      ? null
      : resolveRuntimeBatchBackup({ root, fallbackModelConfig: modelConfig });
  const messageDiscovery = createMessageDiscoveryController({
    db,
    logger,
    getModelConfig: () => getRuntimeModel("deep_analysis"),
    modelReady: () => modelReady("deep_analysis"),
    acquireLease: acquireSiteScanLease,
    renewLease: renewSiteScanLease,
    releaseLease: releaseSiteScanLease,
    ...messageDiscoveryDependencies
  });
  const dashboardServer = http.createServer(async (req, res) => {
    const requestId = logger.requestId();
    const startedAt = Date.now();
    let url;
    res.on("finish", () => logger.info("http_request_completed", { requestId, method: req.method, path: url?.pathname || req.url, statusCode: res.statusCode, durationMs: Date.now() - startedAt }));
    try {
      url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") return redirectHome(res, db);
      if (req.method === "GET" && url.pathname === "/onboarding") return sendHtml(res, renderOnboarding({ profiles: listCandidateProfiles(db), modelState: getPublicModelSettings(), modelReady: modelReady("deep_analysis"), selectedProfileId: url.searchParams.get("profileId") }));
      if (req.method === "GET" && url.pathname === "/settings") return sendHtml(res, renderModelSettingsPage({ modelState: getPublicModelSettings(), searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/profile") return sendHtml(res, renderProfilePage({ db, searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/resumes") return sendHtml(res, renderResumeVersionsPage({ db, searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/resume-file") return handleResumeFile(req, res, { db, root, searchParams: url.searchParams });
      if (req.method === "GET" && url.pathname === "/plan") return sendHtml(res, renderPlanPage({ db, searchParams: url.searchParams, scanRuns }));
      if (req.method === "GET" && url.pathname === "/match-card") return sendHtml(res, renderMatchCardPage({ db, searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/workflow") return sendHtml(res, renderWorkflowPage({ db, searchParams: url.searchParams, logger, workflowHealth: resolvedWorkflowHealth }));
      if (req.method === "GET" && url.pathname === "/queue") return sendHtml(res, renderQueuePage({ db, searchParams: url.searchParams, logger, outcomeAnalyticsReader }));
      if (req.method === "GET" && url.pathname === "/messages") return sendHtml(res, renderMessageDiscoveryPage({
        db,
        searchParams: url.searchParams,
        controller: messageDiscovery,
        helpers: messageDiscoveryViewHelpers()
      }));
      if (req.method === "GET" && url.pathname === "/communication/new") return sendHtml(res, renderCommunicationBuilderPage({ db, searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/communication") return sendHtml(res, renderCommunicationReviewPage({ db, searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/jobs") return sendHtml(res, renderDashboard(getDashboardData(db, url.searchParams)));
      if (req.method === "GET" && url.pathname === "/diagnostics") return sendHtml(res, renderDiagnosticsPage(logger.listRecent()));
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, {
          ok: true,
          logging: "enabled",
          projectRoot: path.resolve(root),
          pid: process.pid
        });
      }
      if (req.method === "GET" && url.pathname === "/api/browser-readiness") {
        const authority = resolveNewInheritedBrowser({
          browserMode: url.searchParams.get("browserMode"),
          cdpPort: url.searchParams.get("cdpPort")
        });
        const readiness = await resolvedBrowserReadinessProbe(authority);
        return sendJson(res, 200, publicBrowserReadinessSnapshot(readiness));
      }
      if (req.method === "GET" && url.pathname === "/api/scan-status") return sendJson(res, 200, scanStatus(scanRuns, url.searchParams.get("planId"), db));
      if (req.method === "GET" && url.pathname === "/api/workflow-status") return handleWorkflowStatus(res, db, url.searchParams.get("runId"), logger);
      if (req.method === "POST" && url.pathname === "/api/workflow-control") {
        return handleWorkflowControl(req, res, {
          db,
          root,
          dbPath,
          scanRuns,
          logger,
          requestId,
          spawnProcess,
          browserReadinessProbe: resolvedWorkflowResumeBrowserReadinessProbe,
          getBatchModelState: () => getRuntimeModelState("batch_screening"),
          batchModelReady: () => modelReady("batch_screening"),
          workflowControlSchedule,
          workflowControlGraceMs
        });
      }
      if (req.method === "GET" && url.pathname === "/api/communication-status") return handleCommunicationStatus(res, db, url.searchParams.get("batchId"));
      if (req.method === "GET" && url.pathname === "/api/message-discovery-status") return handleMessageDiscoveryStatus(res, messageDiscovery, url.searchParams.get("profileId"));
      if (req.method === "POST" && url.pathname === "/api/communication-batch") return handleCommunicationBatch(req, res, db);
      if (req.method === "POST" && url.pathname === "/api/communication-control") return handleCommunicationControl(req, res, { db, root, dbPath, logger, requestId, spawnProcess });
      if (req.method === "POST" && url.pathname === "/api/communication-resolve") return handleCommunicationResolve(req, res, db);
      if (req.method === "POST" && url.pathname === "/api/mark") return handlePost(req, res, (body, type) => handleMarkApi(db, body, type), { logger, requestId, action: "mark_job" });
      if (req.method === "POST" && url.pathname === "/api/follow-up") return handlePost(req, res, (body, type) => handleFollowUpApi(db, body, type), { logger, requestId, action: "add_follow_up" });
      if (req.method === "POST" && url.pathname === "/api/feedback") return handlePost(req, res, (body, type) => handleRecommendationFeedbackApi(db, body, type), { logger, requestId, action: "recommendation_feedback" });
      if (req.method === "POST" && url.pathname === "/api/communication") return handleCommunication(req, res, { db, modelConfig: getRuntimeModel("deep_analysis"), modelReady: modelReady("deep_analysis"), logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/progress") return handleProgress(req, res, db, messageDiscovery);
      if (req.method === "POST" && url.pathname === "/api/message-discovery") return handleMessageDiscovery(req, res, messageDiscovery);
      if (req.method === "POST" && url.pathname === "/api/analyze-job") return handleJobAnalysisRetry(req, res, { db, root, modelConfig: getRuntimeModel("batch_screening"), modelReady: modelReady("batch_screening"), logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/analyze-jobs") return handleJobAnalysisRetry(req, res, { db, root, modelConfig: getRuntimeModel("batch_screening"), modelReady: modelReady("batch_screening"), logger, requestId, bulk: true });
      if (req.method === "POST" && url.pathname === "/api/resume/preview") return handleResumePreview(req, res, { root, logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/resume") return handleResumeUpload(req, res, { db, root, modelConfig: getRuntimeModel("deep_analysis"), modelReady: modelReady("deep_analysis"), logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/match-card") return handleMatchCardSave(req, res, { db, logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/match-card/confirm") return handleMatchCardConfirm(req, res, { db, logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/settings/model") return handleModelSettingsSave(req, res, { root, fallbackModelConfig: modelConfig, connectionTester, logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/profile") return handleProfileSave(req, res, db, { logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/resume-version") return handleResumeVersionSave(req, res, { db, root, modelConfig: getRuntimeModel("deep_analysis"), modelReady: modelReady("deep_analysis"), logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/plan/recommend") return handlePlanRecommend(req, res, { db, modelConfig: getRuntimeModel("deep_analysis"), modelReady: modelReady("deep_analysis"), logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/plan") return handlePlanSave(req, res, db, { root, logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/workflow-run") return handleWorkflowRunStart(req, res, { db, root, dbPath, scanRuns, modelReady: modelReady("batch_screening"), modelState: getPublicModelSettings(), backupRuntime: getRuntimeBatchBackup(), logger, requestId, spawnProcess, inheritedContextResolver });
      if (req.method === "POST" && url.pathname === "/api/workflow-run/resume") return handleWorkflowRunResume(req, res, { db, root, dbPath, scanRuns, batchModelReady: modelReady("batch_screening"), logger, requestId, spawnProcess, browserReadinessProbe: resolvedWorkflowResumeBrowserReadinessProbe });
      if (req.method === "POST" && url.pathname === "/api/scan") return handlePlanScan(req, res, { db, root, dbPath, scanRuns, modelReady: modelReady("batch_screening"), logger, requestId, spawnProcess });
      sendText(res, 404, "Not found");
    } catch (error) {
      logger.error("http_unhandled_error", { requestId, method: req.method, path: url?.pathname || req.url, error: errorMeta(error) });
      respondUnexpectedError(res, error, requestId, url?.pathname || req.url);
    }
  });
  const closeHttpServer = dashboardServer.close.bind(dashboardServer);
  dashboardServer.close = (callback) => {
    const discoveryCleanup = messageDiscovery.close();
    return closeHttpServer((serverError) => {
      Promise.resolve(discoveryCleanup).then(
        () => callback?.(serverError),
        (cleanupError) => {
          logger.warn("message_discovery_shutdown_cleanup_failed", {
            errorCode: String(cleanupError?.code || "MESSAGE_DISCOVERY_CLEANUP_FAILED")
          });
          callback?.(serverError || cleanupError);
        }
      );
    });
  };
  return dashboardServer;
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
    const prepared = prepareResumeTextForModel(resume.text, {
      originalFileName: resume.originalFileName
    });
    logger.info("resume_model_input_previewed", { requestId, source: file ? "file" : "pasted_text", charCount: prepared.text.length, redactions: prepared.redactions });
    sendJson(res, 200, { text: prepared.text, charCount: prepared.text.length, redactions: prepared.redactions });
  } catch (error) {
    const issue = publicError(error, { fallbackCode: "RESUME_PREVIEW_FAILED" });
    logger.warn("resume_model_input_preview_failed", { requestId, error: errorMeta(error), errorCode: issue.code });
    sendJson(res, issue.statusCode, { error: issue.message, errorCode: issue.code, requestId });
  }
}

async function handleJobAnalysisRetry(req, res, { db, root, modelConfig, modelReady, logger, requestId, bulk = false }) {
  let planId = 0;
  try {
    if (!modelReady) {
      throw appError(
        "MODEL_CONFIGURATION_REQUIRED",
        "重试语义分析前，请先完成批量筛选模型连接测试。",
        { statusCode: 409 }
      );
    }
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    planId = Number(params.planId);
    const plan = getSearchPlan(db, planId);
    if (!plan) throw new Error("Search Plan 不存在。");
    const matchingContext = getCandidateMatchingContext(db, plan.profileId);
    if (!matchingContext) {
      throw appError("MATCHING_CARD_CONFIRMATION_REQUIRED", "重试语义分析前，请先在工作台确认匹配偏好卡。", {
        statusCode: 409,
        details: { profileId: plan.profileId, cardId: getSearchPlanDependency(db, plan.id).draftCardId }
      });
    }
    const pool = listDecisionPool(db, { planId });
    const requestedJobId = Number(params.jobId);
    const jobs = bulk
      ? pool.filter((job) => job.decisionBucket === "analysis_pending" && isJobAwaitingAction(job))
        .slice(0, PRODUCT_POLICY.operations.modelAnalysis.maxRetryJobs)
      : pool.filter((job) => job.id === requestedJobId);
    if (!jobs.length) throw new Error(bulk ? "当前没有待重试的语义分析岗位。" : "岗位不存在或不属于当前筛选方案。");
    const baseConfigs = loadConfigs(root);
    baseConfigs.model = modelConfig;
    const configs = profileToRuntimeConfigs(baseConfigs, matchingContext.candidateProfile, plan.plan, listMatchingResumeVersions(db, plan.profileId), matchingContext.matchingCard);
    const analyze = createJobAnalysisRunner(configs, plan.plan.keywords || [], { db, logger });
    const batchId = createBatch(db, jobs[0].source || "boss", bulk ? "analysis-retry-bulk" : "analysis-retry", bulk
      ? `analysis-retry-bulk:plan:${planId}:jobs:${jobs.length}`
      : `analysis-retry:plan:${planId}:job:${jobs[0].id}`, {
      profileId: plan.profileId,
      searchPlanId: planId,
      filterSnapshot: { mode: bulk ? "analysis-retry-bulk" : "analysis-retry", jobIds: jobs.map((job) => job.id) }
    });
    const retryConcurrency = bulk ? PRODUCT_POLICY.operations.modelAnalysis.retryConcurrency : 1;
    const results = await mapWithConcurrency(jobs, retryConcurrency, async (job) => {
      const scored = scoreJob(job, configs);
      if (decisionState(scored) !== "ready") return { job, scored, sourcePending: true, analysis: job.analysis };
      const analysis = await analyze({ ...job, ...scored, greeting: job.greeting || "" });
      return { job, scored, sourcePending: false, analysis };
    });
    let completed = 0;
    let failed = 0;
    let sourcePending = 0;
    for (const result of results) {
      if (result.sourcePending) {
        sourcePending += 1;
        continue;
      }
      upsertJob(db, { ...result.job, ...result.scored, analysis: result.analysis, greeting: result.job.greeting || "" }, batchId);
      if (result.analysis.semanticStatus === "failed") failed += 1;
      else completed += 1;
    }
    reconcilePlanWorkflowInventory(db, planId);
    logger.info(bulk ? "job_analysis_bulk_retried" : "job_analysis_retried", {
      requestId,
      planId,
      jobIds: jobs.map((job) => job.id),
      batchId,
      requested: jobs.length,
      completed,
      failed,
      sourcePending,
      concurrency: retryConcurrency
    });
    if (!bulk && failed) {
      const analysis = results[0].analysis;
      const error = new Error(analysis.error || "语义分析仍未完成，请稍后重试。");
      error.code = analysis.errorCode || "MODEL_ANALYSIS_FAILED";
      throw error;
    }
    redirect(res, `/queue?planId=${planId}${failed || sourcePending ? "&pool=analysis_pending" : ""}`);
  } catch (error) {
    respondUiError(res, error, modelSettingsBack(
      error,
      planId ? `/queue?planId=${planId}&pool=analysis_pending` : "/"
    ), { logger, requestId, event: "job_analysis_retry_failed", fallbackCode: "JOB_ANALYSIS_RETRY_FAILED" });
  }
}

function reconcilePlanWorkflowInventory(db, planId) {
  const inventoryCount = listWorkflowInventory(db, { planId }).length;
  for (const workflow of listWorkflowRuns(db, {
    planId,
    localDay: chinaLocalDay(),
    statuses: ["review_required", "interrupted"],
    limit: 500
  })) {
    if (workflow.inventoryCount === inventoryCount) continue;
    transitionWorkflowRun(db, { id: workflow.id, status: workflow.status, inventoryCount });
  }
  return inventoryCount;
}

function redirectHome(res, db) {
  const profile = listCandidateProfiles(db)[0];
  if (!profile) return redirect(res, "/onboarding");
  const plan = getActiveSearchPlan(db, profile.id);
  if (!plan) return redirect(res, `/onboarding?profileId=${profile.id}`);
  return redirect(res, `/plan?profileId=${plan.profileId}&planId=${plan.id}`);
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
      const source = file ? "简历文件" : "粘贴的简历文本";
      error.message = `${source}解析失败：${error.message}`;
      throw error;
    }
    logger.info("resume_parsed", { requestId, source: file ? "file" : "pasted_text", format: resume.format, charCount: resume.charCount, textTruncated: resume.textTruncated });
    const requestedProfileId = Number(form.fields.profileId || 0) || null;
    const existing = requestedProfileId ? getCandidateProfile(db, requestedProfileId) : null;
    const reusableCard = existing && listMatchingCards(db, existing.id)
      .some((card) => card.resumeContentHash === resume.contentHash && ["draft", "confirmed"].includes(card.status));
    if (existing && ((existing.sourceHash && existing.sourceHash === resume.contentHash) || reusableCard)) {
      recordResumeParseAttempt(db, { profileId: existing.id, document: resume });
      parseRecorded = true;
      logger.info("resume_reupload_same_content", { requestId, profileId: existing.id, contentHash: resume.contentHash });
      return redirect(res, matchingCardEntryLocation(db, existing.id, resume.contentHash));
    }
    const profile = await analyzeResumeProfile({ modelConfig, resume, logger });
    const saved = saveProfileAnalysis(db, { profileId: form.fields.profileId, profile, document: resume, searchPlan: null });
    persistResumeSourceFile({ db, root, documentId: saved.resumeDocumentId, file, logger, requestId });
    recordResumeParseAttempt(db, { profileId: saved.profileId, document: resume });
    parseRecorded = true;
    logger.info("resume_profile_created", { requestId, profileId: saved.profileId, profileVersionId: saved.profileVersionId, modelProvider: modelConfig?.provider || "mock" });
    const cardId = await createUploadedMatchingCardDraft(db, { modelConfig, profile, saved, resume, logger, requestId });
    // 只要已有已确认匹配卡和 active 方案（无论方案当前是否 stale），新简历只生成草稿卡：
    // 旧卡与旧方案继续作为扫描依据，绝不自动停用、替换或重绑；确认新卡后由用户明确保存方案。
    // 只有首次上传、没有 confirmed 卡，或确实不存在任何 active 方案时才自动生成初始方案。
    const activeCard = getActiveMatchingCard(db, saved.profileId);
    const activePlan = getActiveSearchPlan(db, saved.profileId);
    if (activeCard && activePlan) {
      logger.info("search_plan_recommend_skipped", { requestId, profileId: saved.profileId, planId: activePlan.id, reason: "pending_matching_card_draft" });
    } else {
      try {
        const plan = await recommendPlanForProfile({ modelConfig, profile, logger });
        const planId = saveSearchPlan(db, { profileId: saved.profileId, profileVersionId: saved.profileVersionId, plan });
        logger.info("search_plan_recommended", { requestId, profileId: saved.profileId, planId, profileVersionId: saved.profileVersionId });
      } catch (planError) {
        logger.warn("search_plan_recommend_failed", { requestId, profileId: saved.profileId, error: errorMeta(planError) });
      }
    }
    return redirect(res, `/match-card?profileId=${saved.profileId}&cardId=${cardId}`);
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

// 相同内容重新上传：不新增画像版本、不调用模型，只按 profileId + resumeContentHash 决定去向。
function matchingCardEntryLocation(db, profileId, resumeContentHash) {
  const cards = listMatchingCards(db, profileId).filter((card) => card.resumeContentHash === resumeContentHash);
  const confirmed = cards.find((card) => card.status === "confirmed");
  if (confirmed) {
    const activePlan = getActiveSearchPlan(db, profileId);
    return `/plan?profileId=${profileId}&planId=${activePlan?.id || ""}`;
  }
  const draft = cards.find((card) => card.status === "draft");
  if (draft) return `/match-card?profileId=${profileId}&cardId=${draft.id}`;
  const latestVersion = listProfileVersions(db, profileId, 1)[0];
  if (!latestVersion) throw new Error("候选人画像没有已保存的简历版本，无法生成匹配偏好卡。");
  const created = createMatchingCardDraft(db, {
    profileId,
    profileVersionId: latestVersion.id,
    resumeDocumentId: latestVersion.resumeDocumentId,
    resumeContentHash,
    card: matchingCardFromProfile(latestVersion.profile),
    source: "migration"
  });
  return `/match-card?profileId=${profileId}&cardId=${created.id}`;
}

async function createUploadedMatchingCardDraft(db, { modelConfig, profile, saved, resume, logger, requestId }) {
  let card;
  try {
    card = await buildCandidateMatchCard({ modelConfig, profile, logger });
  } catch (error) {
    logger.warn("matching_card_draft_fallback", { requestId, profileId: saved.profileId, error: errorMeta(error) });
    card = matchingCardFromProfile(profile);
  }
  const draft = createMatchingCardDraft(db, {
    profileId: saved.profileId,
    profileVersionId: saved.profileVersionId,
    resumeDocumentId: saved.resumeDocumentId,
    resumeContentHash: resume.contentHash,
    card,
    source: "model"
  });
  logger.info("matching_card_draft_created", { requestId, profileId: saved.profileId, cardId: draft.id, source: draft.source });
  return draft.id;
}

function renderMatchCardPage({ db, searchParams }) {
  const profileId = Number(searchParams.get("profileId") || 0);
  const profile = getCandidateProfile(db, profileId);
  if (!profile) return renderErrorPage("还没有候选人画像，请先上传简历。", "/onboarding");
  const activeCard = getActiveMatchingCard(db, profileId);
  const requested = getMatchingCard(db, searchParams.get("cardId"));
  const card = requested?.profileId === profile.id ? requested : null;
  const drafts = listMatchingCards(db, profileId).filter((item) => item.status === "draft");
  const activeDocument = activeCard?.resumeDocumentId ? getResumeDocument(db, activeCard.resumeDocumentId) : null;
  const activeLabel = activeCard
    ? `${activeDocument?.originalFileName || "已保存简历版本"} · 确认于 ${activeCard.confirmedAt || "未知时间"}`
    : "尚无已确认的匹配偏好卡";
  const draftLinks = drafts
    .filter((item) => item.id !== card?.id)
    .map((item) => `<a class="button-link" href="/match-card?profileId=${profile.id}&cardId=${item.id}">打开草稿卡 #${item.id}</a>`)
    .join(" ");
  const notices = [];
  if (searchParams.get("saved")) notices.push(`<p class="notice">草稿已保存；确认之前不会改变扫描依据。</p>`);
  if (!activeCard) notices.push(`<p class="setup-warning">尚无已确认的匹配偏好卡。无需重新上传简历，打开现有草稿卡确认后即可扫描。 ${draftLinks}</p>`);
  if (card?.status === "draft" && activeCard) notices.push(`<p class="setup-warning">新简历待确认，不会自动替换当前匹配依据。</p>`);
  const body = !card
    ? `<section class="panel"><h2>选择要确认的草稿卡</h2><p class="hint">匹配偏好卡来自你已上传的简历；选择一张草稿卡检查并确认。</p><p>${draftLinks || "当前没有草稿卡。"}</p></section>`
    : card.status === "draft"
      ? `<section class="panel"><h2>匹配偏好卡 #${card.id}（草稿）</h2>
  <p class="hint">逐项核对模型从简历事实归纳的匹配依据；只有确认后，扫描和岗位匹配才会使用它。</p>
  <form class="form-stack" method="post" action="/api/match-card">
    <input type="hidden" name="profileId" value="${escapeAttr(profile.id)}">
    <input type="hidden" name="cardId" value="${escapeAttr(card.id)}">
    <label>目标方向（每行一个）<textarea name="targetDirections">${escapeHtml((card.card.targetDirections || []).join("\n"))}</textarea></label>
    <label>强证据（每行：名称 | 简历事实）<textarea name="strongEvidence">${escapeHtml((card.card.strongEvidence || []).map((item) => `${item.label} | ${item.evidence}`).join("\n"))}</textarea></label>
    <label>可迁移能力（每行：名称 | 简历事实 | 尚未证明的部分）<textarea name="transferableCapabilities">${escapeHtml((card.card.transferableCapabilities || []).map((item) => [item.label, item.evidence, item.limitation].filter(Boolean).join(" | ")).join("\n"))}</textarea></label>
    <label>需谨慎转向（每行：方向 | 原因）<textarea name="cautionTransitions">${escapeHtml((card.card.cautionTransitions || []).map((item) => `${item.direction} | ${item.reason}`).join("\n"))}</textarea></label>
    <label>用户补充偏好（每行一条；会用于岗位匹配，不会直接发送给招聘方；不能代替简历证据）<textarea name="userNotes">${escapeHtml((card.card.userNotes || []).join("\n"))}</textarea></label>
    <div><button type="submit">保存草稿</button></div>
  </form>
  <form class="inline-form" method="post" action="/api/match-card/confirm">
    <input type="hidden" name="profileId" value="${escapeAttr(profile.id)}">
    <input type="hidden" name="cardId" value="${escapeAttr(card.id)}">
    <button type="submit">确认匹配偏好卡</button>
  </form>
  <p class="hint">确认后，旧的已确认卡会被替换；基于旧卡的筛选方案需要重新保存一次。</p>
</section>`
      : card.status === "confirmed"
        ? `<section class="panel"><h2>匹配偏好卡 #${card.id}（已确认）</h2><p class="hint">这张卡是当前扫描与岗位匹配的根据；如需调整，请编辑后另存或重新上传新简历生成草稿。</p>${renderMatchingCardSummary(card.card)}</section>`
        : `<section class="panel"><h2>匹配偏好卡 #${card.id}（历史版本 · 已被替换）</h2><p class="hint">这张卡已被更新的确认卡替换，仅作历史留档，不能重新确认；当前扫描与岗位匹配不使用它。</p>${renderMatchingCardSummary(card.card)}</section>`;
  return renderPage("匹配偏好卡", `<main>
  <nav>${navLinks(`/match-card?profileId=${profile.id}${card ? `&cardId=${card.id}` : ""}`)}<a href="/plan?profileId=${profile.id}">筛选方案</a><a href="/resumes?profileId=${profile.id}">简历版本</a></nav>
  <h1>匹配偏好卡</h1>
  <p class="hint">当前扫描使用：${escapeHtml(activeLabel)}</p>
  ${notices.join("\n")}
  ${body}
</main>`);
}

function renderMatchingCardSummary(card = {}) {
  const items = (list, render) => (list || []).length ? `<ul>${list.map(render).join("")}</ul>` : "<p class=\"hint\">（空）</p>";
  return `<dl>
  <dt>目标方向</dt><dd>${escapeHtml((card.targetDirections || []).join("、") || "（空）")}</dd>
  <dt>强证据</dt><dd>${items(card.strongEvidence, (item) => `<li>${escapeHtml(item.label)}：${escapeHtml(item.evidence)}</li>`)}</dd>
  <dt>可迁移能力</dt><dd>${items(card.transferableCapabilities, (item) => `<li>${escapeHtml(item.label)}：${escapeHtml(item.evidence)}${item.limitation ? `（未证明：${escapeHtml(item.limitation)}）` : ""}</li>`)}</dd>
  <dt>需谨慎转向</dt><dd>${items(card.cautionTransitions, (item) => `<li>${escapeHtml(item.direction)}：${escapeHtml(item.reason)}</li>`)}</dd>
</dl>`;
}

function matchingCardFromForm(params = {}) {
  const lines = (value) => String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const segments = (line) => line.split("|").map((item) => item.trim());
  return {
    targetDirections: lines(params.targetDirections),
    strongEvidence: lines(params.strongEvidence).map((line) => {
      const [label, ...rest] = segments(line);
      return { label, evidence: rest.join(" | ") };
    }),
    transferableCapabilities: lines(params.transferableCapabilities).map((line) => {
      const [label, evidence, ...rest] = segments(line);
      return { label, evidence, limitation: rest.join(" | ") };
    }),
    cautionTransitions: lines(params.cautionTransitions).map((line) => {
      const [direction, ...rest] = segments(line);
      return { direction, reason: rest.join(" | ") };
    }),
    userNotes: lines(params.userNotes)
  };
}

async function handleMatchCardSave(req, res, { db, logger, requestId }) {
  try {
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    const profileId = Number(params.profileId);
    const cardId = Number(params.cardId);
    const saved = saveMatchingCardDraftEdit(db, { profileId, cardId, card: matchingCardFromForm(params) });
    logger.info("matching_card_draft_saved", { requestId, profileId, cardId: saved.id });
    redirect(res, `/match-card?profileId=${profileId}&cardId=${saved.id}&saved=1`);
  } catch (error) {
    respondUiError(res, error, "/match-card", { logger, requestId, event: "matching_card_save_failed", fallbackCode: "MATCHING_CARD_SAVE_FAILED" });
  }
}

async function handleMatchCardConfirm(req, res, { db, logger, requestId }) {
  try {
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    const profileId = Number(params.profileId);
    const cardId = Number(params.cardId);
    confirmMatchingCard(db, { profileId, cardId });
    logger.info("matching_card_confirmed", { requestId, profileId, cardId });
    const activePlan = getActiveSearchPlan(db, profileId);
    redirect(res, `/plan?profileId=${profileId}&planId=${activePlan?.id || ""}&matchCardConfirmed=1`);
  } catch (error) {
    respondUiError(res, error, "/match-card", { logger, requestId, event: "matching_card_confirm_failed", fallbackCode: "MATCHING_CARD_CONFIRM_FAILED" });
  }
}

async function handleModelSettingsSave(req, res, { root, fallbackModelConfig, connectionTester, logger, requestId }) {
  let taskProfile = "";
  let action = "";
  try {
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    taskProfile = String(params.taskProfile || "").trim();
    action = String(params.action || "save").trim();
    if (!["deep_analysis", "batch_screening", "batch_backup"].includes(taskProfile)) {
      throw appError("MODEL_TASK_PROFILE_INVALID", "模型任务配置无效。", { statusCode: 400 });
    }
    if (!["save", "restore_recommended"].includes(action)) {
      throw appError("MODEL_SETTINGS_ACTION_INVALID", "模型设置操作无效。", { statusCode: 400 });
    }
    if (action === "restore_recommended") {
      if (taskProfile === "batch_backup") {
        throw appError("MODEL_SETTINGS_ACTION_INVALID", "备用模型没有推荐值恢复操作。", { statusCode: 400 });
      }
      const state = restoreRecommendedTaskProfile({
        root,
        taskProfile,
        fallbackModelConfig
      });
      logger.info("model_task_profile_restored", {
        requestId,
        taskProfile,
        model: state.settings.taskProfiles[taskProfile].model,
        revision: state.settings.taskProfiles[taskProfile].revision,
        connectionStatus: state.settings.taskProfiles[taskProfile].connection.status
      });
      return redirect(res, `/settings?profile=${encodeURIComponent(taskProfile)}&recommended=1`);
    }
    const timeoutMs = Number(params.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 3000 || timeoutMs > 120000) {
      throw appError("MODEL_TIMEOUT_INVALID", "请求超时必须是 3000 到 120000 毫秒。", { statusCode: 400 });
    }
    const credentialMode = String(params.credentialMode || (taskProfile === "batch_backup" ? "independent" : "shared")).trim();
    if (!["shared", "independent"].includes(credentialMode)) {
      throw appError("MODEL_CREDENTIAL_MODE_INVALID", "凭据模式必须是共享或独立。", { statusCode: 400 });
    }
    if (taskProfile === "batch_backup" && credentialMode !== "independent") {
      throw appError("MODEL_CREDENTIAL_MODE_INVALID", "备用模型必须使用独立 API Key。", { statusCode: 400 });
    }
    const input = {
      ...params,
      model: String(params.model || "") === "__custom__"
        ? String(params.customModel || "")
        : String(params.model || ""),
      credentialRef: credentialMode,
      enabled: ["1", "on", "true"].includes(String(params.enabled || "").toLowerCase())
    };
    if (taskProfile === "deep_analysis") {
      if (Number(params.concurrency) !== 1) {
        throw appError("MODEL_CONCURRENCY_INVALID", "深度分析并发固定为 1。", { statusCode: 400 });
      }
    } else if (taskProfile === "batch_screening") {
      if (![1, 2].includes(Number(params.concurrency))) {
        throw appError("MODEL_CONCURRENCY_INVALID", "批量筛选并发只能是 1 或 2。", { statusCode: 400 });
      }
    }
    const state = taskProfile === "batch_backup"
      ? await saveVerifiedBatchBackup({
          root,
          input,
          fallbackModelConfig,
          connectionTester
        })
      : await saveVerifiedModelTaskProfile({
          root,
          taskProfile,
          input,
          fallbackModelConfig,
          connectionTester
        });
    const identity = modelTaskProfileIdentity(state.settings, taskProfile);
    logger.info("model_settings_saved", {
      requestId,
      taskProfile,
      provider: identity.provider,
      model: identity.model,
      revision: identity.revision,
      connectionStatus: identity.connection?.status || "unverified",
      latencyMs: identity.connection?.latencyMs ?? null
    });
    redirect(res, `/settings?profile=${encodeURIComponent(taskProfile)}&modelConfigured=1`);
  } catch (error) {
    respondUiError(res, error, taskProfile ? `/settings?profile=${encodeURIComponent(taskProfile)}` : "/settings", {
      logger,
      requestId,
      event: "model_settings_save_failed",
      fallbackCode: "MODEL_SETTINGS_SAVE_FAILED",
      metadata: { taskProfile, action }
    });
  }
}

function modelTaskProfileIdentity(settings, taskProfile) {
  if (taskProfile === "batch_backup") return settings.batchBackup || {};
  const profile = settings.taskProfiles?.[taskProfile] || {};
  const credential = profile.credentialRef === "independent"
    ? settings.independentCredentials?.[taskProfile]
    : settings.sharedCredential;
  return {
    ...profile,
    provider: credential?.provider || "",
    preset: credential?.preset || "",
    baseUrl: credential?.baseUrl || ""
  };
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
    const matchingContext = getCandidateMatchingContext(db, profileId);
    const planId = saveSearchPlan(db, { id: params.planId, profileId, profileVersionId: matchingContext?.profileVersionId || null, plan });
    const runtimeConfigs = profileToRuntimeConfigs(
      loadConfigs(root),
      matchingContext?.candidateProfile || profile.profile,
      plan,
      listMatchingResumeVersions(db, profileId),
      matchingContext?.matchingCard || null
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

async function handlePlanScan(req, res, { db, root, dbPath, scanRuns, modelReady, logger, requestId, spawnProcess }) {
  try {
    if (!modelReady) {
      throw appError(
        "MODEL_CONFIGURATION_REQUIRED",
        "扫描需要已验证的批量筛选模型，请打开 /settings#model-profile-batch_screening 完成连接测试。",
        { statusCode: 409 }
      );
    }
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    const plan = getSearchPlan(db, params.planId);
    if (plan && !getCandidateProfile(db, plan.profileId)) throw new Error("Search Plan 对应的候选人画像不存在，请重新选择画像。");
    const matchingContext = plan ? getCandidateMatchingContext(db, plan.profileId) : null;
    assertSearchPlanReady(plan, matchingContext?.candidateProfile || {}, plan ? getSearchPlanDependency(db, plan.id) : {});
    assertBossRuntimeAvailable(db);
    const orphaned = interruptOrphanedScanRuns(db, { site: "boss", heartbeatTimeoutMs: PRODUCT_POLICY.operations.scanOrphanTimeoutMs });
    if (orphaned.interrupted) logger.warn("orphaned_scan_runs_interrupted", orphaned);
    const latestRun = getLatestScanRun(db, { planId: plan.id, site: "boss" });
    if (latestRun?.status === "running" || [...scanRuns.values()].some((run) => !run.exited)) {
      throw new Error("BOSS 已有扫描任务正在启动或运行，请等待当前任务结束。");
    }
    const activeLease = getSiteScanLease(db, "boss");
    if (activeLease) throw new Error(`BOSS 已有扫描任务运行中（${activeLease.command}，开始于 ${activeLease.acquiredAt}）。`);
    const browserMode = params.browserMode === "portable" ? "portable" : "edge";
    const cdpPort = browserMode === "portable" ? normalizeCdpPort(params.cdpPort) : null;
    if (browserMode === "portable" && cdpPort !== PORTABLE_CDP_PORT) {
      throw appError(
        "INHERITED_PORTABLE_PORT_REQUIRED",
        "项目专用 Edge 固定使用 9222 端口。",
        { statusCode: 409 }
      );
    }
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
    respondUiError(res, error, modelSettingsBack(error, "/plan"), { logger, requestId, event: "search_plan_scan_rejected", fallbackCode: "SCAN_START_FAILED" });
  }
}

function buildWorkflowDashboardState(
  db,
  planRecord,
  now = new Date(),
  { searchScope = null, keywordSource = null } = {}
) {
  if (!planRecord) throw appError("WORKFLOW_PLAN_NOT_FOUND", "筛选方案不存在。", { statusCode: 404 });
  const localDay = chinaLocalDay(now);
  const runs = listWorkflowRuns(db, {
    profileId: planRecord.profileId,
    planId: planRecord.id,
    localDay,
    limit: PRODUCT_POLICY.operations.workflow.maxRunsPerDay
  }).sort((a, b) => a.sequence - b.sequence);
  const activeRun = getActiveWorkflowRun(db, {
    profileId: planRecord.profileId,
    planId: planRecord.id,
    localDay
  });
  const successfulToday = runs.reduce((sum, run) => sum + Number(run.successfulCount || 0), 0);
  const inventory = listWorkflowInventory(db, { planId: planRecord.id, now: asIso(now) });
  const budgetRuns = workflowRunsWithAccessUsage(db, runs, localDay);
  const usedBudget = consumedWorkflowBudget(budgetRuns);
  let keywordStats;
  if (searchScope?.key) {
    keywordStats = listScopedKeywordStats(db, {
      profileId: planRecord.profileId,
      scopeKey: searchScope.key,
      localDay,
      now: asIso(now)
    });
  } else {
    const usedKeywords = new Set(runs.flatMap((run) => run.keywords || [])
      .map((item) => String(item.word || item)));
    keywordStats = new Map();
    for (const job of listDecisionPool(db, { planId: planRecord.id })) {
      const word = String(job.keyword || "").trim();
      if (!word) continue;
      const stats = keywordStats.get(word) || {
        sampleSize: 0,
        eligibleCount: 0,
        usedToday: usedKeywords.has(word)
      };
      stats.sampleSize += 1;
      const probe = { ...job, applicationStatus: "", applicationReasonCode: "", reviewAt: "" };
      if (workflowEligibility(probe, { now: asIso(now) }).eligible) stats.eligibleCount += 1;
      keywordStats.set(word, stats);
    }
    for (const word of usedKeywords) {
      if (!keywordStats.has(word)) {
        keywordStats.set(word, { sampleSize: 0, eligibleCount: 0, usedToday: true });
      }
    }
  }
  const catalog = keywordSource?.keywords?.length
    ? keywordSource.keywords
    : (planRecord.plan?.keywords || []);
  const keywords = catalog.map((item, index) => {
    const source = typeof item === "string" ? { word: item, priority: "B", reason: "" } : item;
    const stats = keywordStats.get(String(source.word || "").trim())
      || { sampleSize: 0, eligibleCount: 0, usedToday: false };
    return {
      word: String(source.word || "").trim(),
      priority: source.priority || "B",
      reason: String(source.reason || ""),
      planOrder: index,
      ...stats
    };
  }).filter((item) => item.word);
  const policy = PRODUCT_POLICY.operations.workflow;
  const lastScanStartedAt = budgetRuns
    .filter((run) => run.scanNeeded && run.scanRunId)
    .map((run) => run.startedAt || run.createdAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const nextPlan = activeRun ? null : planWorkflowRun({
    now,
    localDay,
    successfulToday,
    completedRuns: countSlotConsumingRuns(runs),
    inventoryCount: inventory.length,
    dailyBudget: {
      details: policy.dailyDetailBudget,
      pages: policy.dailyPageBudget
    },
    usedBudget,
    lastScanStartedAt,
    keywords
  });
  return {
    localDay,
    runs,
    activeRun,
    successfulToday,
    dailyTarget: policy.dailyTarget,
    slotsUsed: countSlotConsumingRuns(runs),
    maxRuns: policy.maxRunsPerDay,
    inventory,
    usedBudget,
    remainingBudget: {
      details: Math.max(0, policy.dailyDetailBudget - usedBudget.details),
      pages: Math.max(0, policy.dailyPageBudget - usedBudget.pages)
    },
    nextPlan,
    keywords,
    searchScope,
    keywordSource
  };
}

function workflowRunsWithAccessUsage(db, runs, localDay) {
  const since = new Date(`${localDay}T00:00:00+08:00`).toISOString();
  const usageByRun = new Map();
  for (const event of listSiteAccessEvents(db, { site: "boss", since, limit: 10000 })) {
    const runId = String(event.details?.runId || "").trim();
    if (!runId || !["pane_detail_read", "detail_open", "list_navigation", "list_scroll"].includes(event.action)) continue;
    const usage = usageByRun.get(runId) || { details: 0, pages: 0, scrolls: 0 };
    if (isBossDetailAccessAction(event.action)) usage.details += 1;
    if (event.action === "list_navigation") usage.pages += 1;
    if (event.action === "list_scroll") usage.scrolls += 1;
    usageByRun.set(runId, usage);
  }
  return runs.map((run) => {
    const access = usageByRun.get(String(run.scanRunId || ""));
    return access ? { ...run, metrics: { ...(run.metrics || {}), access } } : run;
  });
}

async function resolveLiveInheritedContext({
  db,
  plan,
  matchingContext,
  logger,
  browserMode = "edge",
  cdpPort = null,
  browserFactory = createDashboardBrowser
}) {
  try {
    const browser = browserFactory({ browserMode, cdpPort });
    const adapter = new boss.BossSiteAdapter({ browser, logger });
    let preflight;
    if (browserMode === "edge") {
      const inspected = await inspectBossOperatorTabs({
        browser,
        inspectTab: (tabId) => adapter.preflight({ tabId })
      });
      preflight = inspected.searchState;
    } else {
      preflight = await adapter.preflight();
    }
    if (!preflight.isSearchPage) {
      throw appError(
        "BOSS_SEARCH_PAGE_INVALID",
        browserMode === "edge"
          ? "请先在当前已登录 Edge 的固定 BOSS 搜索页打开岗位搜索结果。"
          : "请先在项目专用 Edge 打开 BOSS 岗位搜索结果页。",
        { statusCode: 409 }
      );
    }
    const inspected = await adapter.inspectInheritedSearchPage({ tabId: preflight.tabId });
    const { searchTemplate, searchScope } = buildInheritedSearchScope({
      profileId: plan.profileId,
      rawUrl: inspected.url
    });
    const inspectedFieldCount = Object.keys(inspected.catalog?.fields || {}).length;
    if (inspectedFieldCount) {
      savePlatformFilterCatalog(db, {
        site: "boss",
        catalog: inspected.catalog,
        source: "live_dom",
        discoveredAt: inspected.catalog.discoveredAt
      });
    }
    const catalog = inspectedFieldCount
      ? inspected.catalog
      : getPlatformFilterCatalog(db, "boss")?.catalog || {};
    const keywordSource = freezeKeywordSource({
      planRecord: plan,
      matchingCardRevision: matchingCardRevision(matchingContext.matchingCard)
    });
    const platformPolicy = compilePlatformRuntimePolicy({
      searchScope,
      catalog,
      urlOptions: inspected.urlOptions,
      cityCodes: CITY_CODES
    });
    logger.info("inherited_scope_resolved", {
      site: "boss",
      scopeId: scopeShortId(searchScope.key),
      recognizedFilterCount: platformPolicy.filterSummary.length,
      unresolvedFilterCount: platformPolicy.unresolvedParams.length,
      keywordCatalogHash: keywordSource.catalogHash
    });
    for (const unresolved of platformPolicy.unresolvedParams) {
      logger.warn("platform_filter_unresolved", {
        site: "boss",
        scopeId: scopeShortId(searchScope.key),
        param: unresolved.param,
        unresolvedValueCount: Array.isArray(unresolved.codes) ? unresolved.codes.length : 0
      });
    }
    return {
      acquisitionMode: "inherited",
      searchTemplate,
      searchScope,
      keywordSource,
      platformPolicy
    };
  } catch (error) {
    if (error?.code === "BOSS_RISK_CONTROL") {
      setSiteRuntimeState(db, "boss", {
        status: "blocked",
        reasonCode: error.code,
        message: error.message,
        details: { phase: "inherited_context" }
      });
      throw error;
    }
    if (error?.code === "BROWSER_DISCONNECTED") {
      throw appError(
        browserMode === "edge" ? "BROWSER_UNAVAILABLE" : "PORTABLE_EDGE_REQUIRED",
        browserMode === "edge"
          ? "当前已登录 Edge 的 Edge Control 或桥接未连接，请启动或刷新桥接并确认扩展已连接。"
          : "项目专用 Edge 未启动或已经断开。请重新运行 Start.bat。",
        { statusCode: 409, cause: error }
      );
    }
    if (error?.code === "BOSS_LOGIN_REQUIRED") {
      throw appError(
        "BOSS_LOGIN_REQUIRED",
        browserMode === "edge"
          ? "请先在当前已登录 Edge 的固定 BOSS 页面登录。"
          : "请先在项目专用 Edge 登录 BOSS。",
        { statusCode: 409, cause: error }
      );
    }
    if ([
      "BOSS_RISK_CONTROL",
      "BOSS_LOGIN_REQUIRED",
      "BOSS_TAB_REQUIRED",
      "BOSS_SEARCH_PAGE_INVALID",
      "INHERITED_SCOPE_FILTER_REQUIRED"
    ].includes(error?.code)
      && !error.statusCode) {
      throw appError(error.code, error.message, { statusCode: 409, cause: error });
    }
    throw error;
  }
}

async function handleWorkflowRunStart(req, res, {
  db,
  root,
  dbPath,
  scanRuns,
  modelReady,
  modelState,
  backupRuntime,
  logger,
  requestId,
  spawnProcess,
  inheritedContextResolver
}) {
  let planId = 0;
  try {
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    const browserAuthority = resolveNewInheritedBrowser(params);
    planId = Number(params.planId || 0);
    const plan = getSearchPlan(db, planId);
    if (!plan || !getCandidateProfile(db, plan.profileId)) throw appError("WORKFLOW_PROFILE_NOT_FOUND", "筛选方案对应的候选人画像不存在。", { statusCode: 404 });
    const matchingContext = getCandidateMatchingContext(db, plan.profileId);
    assertSearchPlanReady(
      plan,
      matchingContext?.candidateProfile || {},
      getSearchPlanDependency(db, plan.id),
      { validatePlatformCities: false }
    );
    const preliminaryState = buildWorkflowDashboardState(db, plan);
    if (preliminaryState.activeRun) {
      return redirect(res, `/workflow?runId=${encodeURIComponent(preliminaryState.activeRun.id)}`);
    }
    if (preliminaryState.nextPlan?.errorCode) {
      throw appError(
        preliminaryState.nextPlan.errorCode,
        workflowBlockedMessage(preliminaryState.nextPlan.errorCode, preliminaryState.nextPlan),
        { statusCode: 409 }
      );
    }
    if (preliminaryState.nextPlan?.scanNeeded && !modelReady) {
      throw appError(
        "MODEL_CONFIGURATION_REQUIRED",
        "执行新一轮前，请先打开 /settings#model-profile-batch_screening 完成批量筛选模型连接测试。",
        { statusCode: 409 }
      );
    }
    const inheritedContext = await inheritedContextResolver({
      db,
      plan,
      matchingContext,
      logger,
      browserMode: browserAuthority.browserMode,
      cdpPort: browserAuthority.cdpPort
    });
    try {
      assertInheritedAcquisitionScope(inheritedContext.searchScope);
    } catch (error) {
      throw appError(error.code, error.message, { statusCode: 409, cause: error });
    }
    const state = buildWorkflowDashboardState(db, plan, new Date(), inheritedContext);
    if (state.activeRun) return redirect(res, `/workflow?runId=${encodeURIComponent(state.activeRun.id)}`);
    if (state.nextPlan?.errorCode) {
      throw appError(state.nextPlan.errorCode, workflowBlockedMessage(state.nextPlan.errorCode, state.nextPlan), { statusCode: 409 });
    }
    if (state.nextPlan.scanNeeded && !modelReady) {
      throw appError(
        "MODEL_CONFIGURATION_REQUIRED",
        "执行新一轮前，请先打开 /settings#model-profile-batch_screening 完成批量筛选模型连接测试。",
        { statusCode: 409 }
      );
    }
    if (state.nextPlan.scanNeeded) assertWorkflowScanAvailable(db, scanRuns, plan.id, logger);
    const modelProfiles = workflowModelProfilesSnapshot(modelState, { backupRuntime });
    const workflow = createWorkflowRun(db, {
      profileId: plan.profileId,
      planId: plan.id,
      localDay: state.localDay,
      sequence: state.runs.length + 1,
      targetSuccessCount: state.nextPlan.targetSuccessCount,
      inventoryCount: state.nextPlan.inventoryCount,
      candidateGap: state.nextPlan.candidateGap,
      scanNeeded: state.nextPlan.scanNeeded,
      keywords: state.nextPlan.selectedKeywords,
      budget: state.nextPlan.budget,
      modelConfigRevision: modelProfiles.batch_screening.revision,
      planner: {
        ...state.nextPlan,
        browserMode: browserAuthority.browserMode,
        cdpPort: browserAuthority.cdpPort,
        acquisitionMode: inheritedContext.acquisitionMode,
        searchTemplate: inheritedContext.searchTemplate,
        searchScope: inheritedContext.searchScope,
        keywordSource: inheritedContext.keywordSource,
        platformPolicy: inheritedContext.platformPolicy,
        modelProfiles
      },
      shortfallCode: state.nextPlan.shortfallReason || "",
      metrics: {
        planning: {
          inventory: state.nextPlan.inventoryCount,
          candidateGap: state.nextPlan.candidateGap,
          projectedNewCandidates: state.nextPlan.projectedNewCandidates
        }
      }
    });
    if (workflow.scanNeeded) {
      startPlanScan(scanRuns, {
        db,
        root,
        dbPath,
        planId: plan.id,
        cdpPort: browserAuthority.cdpPort,
        browserMode: browserAuthority.browserMode,
        scanKind: "daily",
        workflowRunId: workflow.id,
        logger,
        requestId,
        spawnProcess
      });
    } else {
      transitionWorkflowRun(db, {
        id: workflow.id,
        status: "review_required",
        inventoryCount: state.inventory.length,
        metrics: { ...workflow.metrics, planning: { ...workflow.metrics.planning, scanSkipped: true } }
      });
    }
    logger.info("workflow_run_started", {
      requestId,
      workflowRunId: workflow.id,
      planId: plan.id,
      sequence: workflow.sequence,
      targetSuccessCount: workflow.targetSuccessCount,
      scanNeeded: workflow.scanNeeded
    });
    redirect(res, `/workflow?runId=${encodeURIComponent(workflow.id)}`);
  } catch (error) {
    respondUiError(res, error, modelSettingsBack(error, planId ? `/plan?planId=${planId}` : "/plan"), {
      logger,
      requestId,
      event: "workflow_run_start_failed",
      fallbackCode: "WORKFLOW_RUN_START_FAILED"
    });
  }
}

function assertWorkflowScanAvailable(db, scanRuns, planId, logger) {
  assertBossRuntimeAvailable(db);
  const orphaned = interruptOrphanedScanRuns(db, {
    site: "boss",
    heartbeatTimeoutMs: PRODUCT_POLICY.operations.scanOrphanTimeoutMs
  });
  if (orphaned.interrupted) logger?.warn("orphaned_scan_runs_interrupted", orphaned);
  const latestRun = getLatestScanRun(db, { planId, site: "boss" });
  if (latestRun?.status === "running" || [...scanRuns.values()].some((run) => !run.exited)) {
    throw appError("WORKFLOW_SCAN_ALREADY_RUNNING", "BOSS 已有扫描任务正在运行，请先完成当前任务。", { statusCode: 409 });
  }
  const activeLease = getSiteScanLease(db, "boss");
  if (activeLease) {
    throw appError("WORKFLOW_SCAN_LEASE_ACTIVE", `BOSS 已有扫描任务运行中（${activeLease.command}）。`, { statusCode: 409 });
  }
}

async function handleWorkflowRunResume(req, res, {
  db,
  root,
  dbPath,
  scanRuns,
  batchModelReady,
  logger,
  requestId,
  spawnProcess,
  browserReadinessProbe
}) {
  let workflowRunId = "";
  try {
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    workflowRunId = String(params.workflowRunId || params.runId || "").trim();
    const workflow = getWorkflowRun(db, workflowRunId);
    if (!workflow) throw appError("WORKFLOW_RUN_NOT_FOUND", "本轮任务不存在。", { statusCode: 404 });
    if (workflowResumeNeedsBatchModel(db, workflow) && !batchModelReady) {
      throw appError(
        "MODEL_CONFIGURATION_REQUIRED",
        "继续本轮前，请先完成批量筛选模型连接测试。",
        { statusCode: 409 }
      );
    }
    const acquisitionMode = String(workflow.planner?.acquisitionMode || "").trim();
    if (!["generated", "inherited"].includes(acquisitionMode)) {
      throw appError(
        "WORKFLOW_ACQUISITION_MODE_INVALID",
        "本轮任务的采集模式无效，不能安全恢复。",
        { statusCode: 409 }
      );
    }
    if (acquisitionMode === "inherited") {
      try {
        assertCompleteInheritedContext(workflow.planner, {
          code: "WORKFLOW_INHERITED_SNAPSHOT_INVALID",
          message: "本轮继承模式快照不完整，不能安全恢复。",
          planId: workflow.planId
        });
      } catch (error) {
        throw appError(
          "WORKFLOW_INHERITED_SNAPSHOT_INVALID",
          "本轮继承模式快照不完整，不能安全恢复。",
          { statusCode: 409, cause: error }
        );
      }
    }
    const browserMode = resolveWorkflowResumeBrowserMode(workflow, params.browserMode);
    let cdpPort = null;
    if (browserMode === "portable") {
      const storedCdpPort = Number(workflow.planner?.cdpPort);
      if (acquisitionMode === "inherited"
        && (!Number.isInteger(storedCdpPort) || storedCdpPort !== PORTABLE_CDP_PORT)) {
        throw appError(
          "INHERITED_PORTABLE_PORT_REQUIRED",
          "项目专用 Edge 固定使用 9222 端口。",
          { statusCode: 409 }
        );
      }
      cdpPort = acquisitionMode === "inherited"
        ? storedCdpPort
        : normalizeCdpPort(params.cdpPort || (Number.isInteger(storedCdpPort) ? storedCdpPort : PORTABLE_CDP_PORT));
      if (cdpPort !== PORTABLE_CDP_PORT) {
        throw appError(
          "INHERITED_PORTABLE_PORT_REQUIRED",
          "项目专用 Edge 固定使用 9222 端口。",
          { statusCode: 409 }
        );
      }
    }
    if (["completed", "failed", "stopped"].includes(workflow.status)) {
      throw appError("WORKFLOW_RUN_TERMINAL", "本轮任务已经结束，不能继续执行。", { statusCode: 409 });
    }
    const resumesAnalysis = workflow.status === "interrupted"
      && String(workflow.resumePhase || "") === "analyzing";
    if (resumesAnalysis) {
      assertWorkflowAnalysisBatch(db, workflow);
    } else if (workflow.scanNeeded && workflow.scanBatchId) {
      validateResumeBatch({
        resumeBatchId: workflow.scanBatchId,
        resumedBatch: getBatch(db, workflow.scanBatchId),
        site: "boss",
        planId: workflow.planId
      });
    }
    const requiresBrowser = workflowResumeRequiresBrowser(db, workflow);
    if (acquisitionMode === "inherited" && requiresBrowser) {
      const readiness = publicBrowserReadinessSnapshot(await browserReadinessProbe({
        browserMode,
        cdpPort
      }));
      assertWorkflowResumeBrowserReady(readiness);
    }
    if (workflow.status === "created" || (workflow.status === "interrupted" && !workflow.communicationBatchId)) {
      if (resumesAnalysis) {
        transitionWorkflowRun(db, {
          id: workflow.id,
          status: "analyzing",
          resumePhase: null
        });
        startPlanScan(scanRuns, {
          db,
          root,
          dbPath,
          planId: workflow.planId,
          cdpPort,
          browserMode,
          scanKind: "daily",
          workflowRunId: workflow.id,
          logger,
          requestId,
          spawnProcess
        });
      } else if (workflow.scanNeeded) {
        assertWorkflowScanAvailable(db, scanRuns, workflow.planId, logger);
        startPlanScan(scanRuns, {
          db,
          root,
          dbPath,
          planId: workflow.planId,
          cdpPort,
          browserMode,
          scanKind: "daily",
          resumeBatchId: workflow.scanBatchId,
          workflowRunId: workflow.id,
          logger,
          requestId,
          spawnProcess
        });
      } else {
        transitionWorkflowRun(db, { id: workflow.id, status: "review_required" });
      }
    }
    redirect(res, `/workflow?runId=${encodeURIComponent(workflow.id)}`);
  } catch (error) {
    respondUiError(res, error, modelSettingsBack(
      error,
      workflowRunId ? `/workflow?runId=${encodeURIComponent(workflowRunId)}` : "/plan"
    ), {
      logger,
      requestId,
      event: "workflow_run_resume_failed",
      fallbackCode: "WORKFLOW_RUN_RESUME_FAILED"
    });
  }
}

function workflowResumeRequiresBrowser(db, workflow) {
  if (!workflow) return false;
  if (workflow.status === "created") return true;
  const phase = String(workflow.resumePhase || "");
  if (phase === "scanning") return true;
  if (phase === "analyzing") return false;
  // Crash recovery without an explicit resume phase: if analysis tasks were
  // already initialized, the remaining work is local analysis only and must
  // not require BOSS readiness. Otherwise the scan phase is still pending.
  const hasAnalysisTasks = Boolean(
    db.prepare("SELECT 1 FROM workflow_job_tasks WHERE workflow_run_id = ? LIMIT 1").get(workflow.id)
  );
  if (hasAnalysisTasks) return false;
  const scan = workflow.scanRunId ? getScanRun(db, workflow.scanRunId) : null;
  if (!scan) return true;
  return ["running", "created", "scanning"].includes(String(scan.status || ""));
}

function workflowResumeNeedsBatchModel(db, workflow) {
  if (!workflow) return false;
  if (workflow.scanNeeded) return true;
  if (["scanning", "analyzing"].includes(String(workflow.resumePhase || ""))) return true;
  return Boolean(
    db.prepare("SELECT 1 FROM workflow_job_tasks WHERE workflow_run_id = ? LIMIT 1").get(workflow.id)
  );
}

function assertWorkflowResumeBrowserReady(readiness) {
  if (readiness.ready && readiness.status === "ready") return;
  const code = {
    browser_unavailable: "BROWSER_UNAVAILABLE",
    boss_tab_missing: "BOSS_TAB_REQUIRED",
    login_required: "BOSS_LOGIN_REQUIRED",
    search_page_required: "BOSS_SEARCH_PAGE_INVALID",
    risk_control: "BOSS_RISK_CONTROL"
  }[readiness.status] || "BROWSER_READINESS_INVALID";
  throw appError(code, readiness.message, { statusCode: 409 });
}

function resolveWorkflowResumeBrowserMode(workflow, requestedMode = "") {
  const acquisitionMode = String(workflow?.planner?.acquisitionMode || "").trim();
  const requested = String(requestedMode || "").trim().toLowerCase();
  if (acquisitionMode === "inherited") {
    const stored = String(workflow?.planner?.browserMode || "edge").trim().toLowerCase();
    if (!["edge", "portable"].includes(stored)) {
      throw appError(
        "WORKFLOW_BROWSER_MODE_INVALID",
        "本轮保存的浏览器模式无效。",
        { statusCode: 409 }
      );
    }
    if (requested && requested !== stored) {
      throw appError(
        "WORKFLOW_BROWSER_MODE_MISMATCH",
        `本轮已固定使用 ${stored}，不能切换浏览器。`,
        { statusCode: 409 }
      );
    }
    return stored;
  }
  if (requested && !["edge", "portable"].includes(requested)) {
    throw appError(
      "WORKFLOW_BROWSER_MODE_INVALID",
      "浏览器模式必须是当前 Edge 或项目专用 Edge。",
      { statusCode: 409 }
    );
  }
  const stored = String(
    workflow?.planner?.browserMode
      || workflow?.planner?.browser?.mode
      || ""
  ).trim().toLowerCase();
  return requested || (["edge", "portable"].includes(stored) ? stored : "edge");
}

function handleWorkflowStatus(res, db, workflowRunId, logger = null) {
  const recovery = recoverWorkflowRuns(db, {
    workflowRunId,
    orphanTimeoutMs: PRODUCT_POLICY.operations.scanOrphanTimeoutMs
  });
  if ((recovery.scanRunsInterrupted || recovery.workflowRunsInterrupted || recovery.workflowRunsCompleted) && logger) {
    logger.warn("workflow_status_reconciled", { workflowRunId, ...recovery });
  }
  const snapshot = getWorkflowProgressSnapshot(db, { workflowRunId });
  if (!snapshot) {
    return sendJson(res, 404, {
      error: "本轮任务不存在。",
      errorCode: "WORKFLOW_RUN_NOT_FOUND"
    });
  }
  const workflow = getWorkflowRun(db, workflowRunId);
  const plan = getSearchPlan(db, workflow.planId);
  const daily = plan ? buildWorkflowDashboardState(db, plan) : null;
  const communication = workflow.communicationBatchId
    ? publicCommunicationStatus(communicationStatus(db, workflow.communicationBatchId))
    : null;
  sendJson(res, 200, {
    workflow: publicWorkflow({
      ...snapshot.workflow,
      errorCode: workflow.errorCode
    }),
    progress: snapshot.progress,
    model: snapshot.model,
    controls: snapshot.controls,
    recentActivity: snapshot.recentActivity,
    communication,
    today: daily ? { successful: daily.successfulToday, target: daily.dailyTarget, slotsUsed: daily.slotsUsed } : null
  });
}

async function handleWorkflowControl(req, res, {
  db,
  root,
  dbPath,
  scanRuns,
  logger,
  requestId,
  spawnProcess,
  browserReadinessProbe,
  getBatchModelState,
  batchModelReady,
  workflowControlSchedule,
  workflowControlGraceMs
}) {
  let workflowRunId = "";
  let action = "";
  try {
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    workflowRunId = String(params.workflowRunId || params.runId || "").trim();
    action = String(params.action || "").trim().toLowerCase();
    if (!["pause", "resume", "stop"].includes(action)) {
      throw appError(
        "WORKFLOW_CONTROL_ACTION_INVALID",
        "工作流操作必须是 pause、resume 或 stop。",
        { statusCode: 409 }
      );
    }
    let workflow = getWorkflowRun(db, workflowRunId);
    if (!workflow) {
      throw appError(
        "WORKFLOW_CONTROL_TARGET_MISMATCH",
        "指定的工作流不存在。",
        { statusCode: 409 }
      );
    }
    const now = new Date().toISOString();
    let activeRun = exactActiveWorkflowRun(scanRuns, workflow);
    const persistedExecutionRunning = exactPersistedWorkflowRunIsRunning(db, workflow);

    if (action === "pause") {
      if (workflow.status !== "paused") {
        requestWorkflowPause(db, { workflowRunId, now });
        if (activeRun) {
          scheduleExactWorkflowControlFallback({
            db,
            scanRuns,
            workflowRunId,
            expectedRun: activeRun,
            expectedControlState: "pause_requested",
            schedule: workflowControlSchedule,
            graceMs: workflowControlGraceMs,
            logger
          });
        } else if (!persistedExecutionRunning) {
          finalizeWorkflowControl(db, {
            workflowRunId,
            now: new Date().toISOString()
          });
        }
      }
      logger.info("workflow_control_applied", { requestId, workflowRunId, action });
      return redirect(res, `/workflow?runId=${encodeURIComponent(workflowRunId)}`);
    }

    if (action === "stop") {
      requestWorkflowStop(db, {
        workflowRunId,
        confirmStop: String(params.confirmStop || "") === "1",
        now
      });
      if (activeRun) {
        scheduleExactWorkflowControlFallback({
          db,
          scanRuns,
          workflowRunId,
          expectedRun: activeRun,
          expectedControlState: "stop_requested",
          schedule: workflowControlSchedule,
          graceMs: workflowControlGraceMs,
          logger
        });
      } else if (!persistedExecutionRunning) {
        finalizeWorkflowControl(db, {
          workflowRunId,
          now: new Date().toISOString()
        });
      }
      logger.info("workflow_control_applied", { requestId, workflowRunId, action });
      return redirect(res, `/workflow?runId=${encodeURIComponent(workflowRunId)}`);
    }

    if (workflow.status === "paused" && activeRun) {
      throw appError(
        "WORKFLOW_CONTROL_SETTLING",
        "上一执行进程仍在完成暂停，请稍后再继续本轮。",
        { statusCode: 409 }
      );
    }
    if (activeRun
      && ["scanning", "analyzing"].includes(workflow.status)
      && workflow.controlState === "none") {
      logger.info("workflow_control_idempotent", { requestId, workflowRunId, action });
      return redirect(res, `/workflow?runId=${encodeURIComponent(workflowRunId)}`);
    }

    const shouldLaunch = !activeRun;
    const targetPhase = workflow.status === "paused"
      ? String(workflow.resumePhase || "analyzing")
      : String(workflow.status || "");
    const readyForResume = batchModelReady();
    if (shouldLaunch && workflowResumeNeedsBatchModel(db, workflow) && !readyForResume) {
      throw appError(
        "MODEL_CONFIGURATION_REQUIRED",
        "继续本轮前，请先测试批量筛选模型连接。",
        { statusCode: 409 }
      );
    }
    const requiresBrowser = shouldLaunch && targetPhase === "scanning";
    let authority = null;
    if (requiresBrowser) {
      authority = resolveWorkflowControlBrowserAuthority(workflow, params);
      const readiness = publicBrowserReadinessSnapshot(await browserReadinessProbe(authority));
      assertWorkflowResumeBrowserReady(readiness);
      const refreshed = getWorkflowRun(db, workflowRunId);
      activeRun = exactActiveWorkflowRun(scanRuns, refreshed);
      if (activeRun
        && ["scanning", "analyzing"].includes(refreshed?.status)
        && refreshed.controlState === "none") {
        logger.info("workflow_control_idempotent", { requestId, workflowRunId, action });
        return redirect(res, `/workflow?runId=${encodeURIComponent(workflowRunId)}`);
      }
      if (!sameWorkflowControlSnapshot(workflow, refreshed)) {
        throw appError(
          "WORKFLOW_CONTROL_STATE_CHANGED",
          "工作流状态在浏览器检查期间发生变化，请刷新后重试。",
          { statusCode: 409 }
        );
      }
      if (workflow.scanNeeded && workflow.scanBatchId) {
        validateResumeBatch({
          resumeBatchId: workflow.scanBatchId,
          resumedBatch: getBatch(db, workflow.scanBatchId),
          site: "boss",
          planId: workflow.planId
        });
      }
      assertWorkflowScanAvailable(db, scanRuns, workflow.planId, logger);
    } else if (shouldLaunch && targetPhase === "analyzing") {
      assertWorkflowAnalysisBatch(db, workflow);
    }
    const modelEvidence = workflowBatchResumeEvidence(getBatchModelState(), {
      ready: readyForResume
    });
    workflow = resumeWorkflowRun(db, {
      workflowRunId,
      ...modelEvidence,
      now
    });

    if (shouldLaunch) {
      if (workflow.scanNeeded) {
        const launchAuthority = requiresBrowser
          ? authority
          : { browserMode: "portable", cdpPort: PORTABLE_CDP_PORT };
        try {
          startPlanScan(scanRuns, {
            db,
            root,
            dbPath,
            planId: workflow.planId,
            cdpPort: launchAuthority.cdpPort,
            browserMode: launchAuthority.browserMode,
            scanKind: "daily",
            resumeBatchId: workflow.scanBatchId,
            workflowRunId: workflow.id,
            logger,
            requestId,
            spawnProcess
          });
        } catch (launchError) {
          settleFailedWorkflowLaunch(db, scanRuns, workflow, launchError);
          throw launchError;
        }
      } else if (workflow.status !== "review_required") {
        workflow = transitionWorkflowRun(db, {
          id: workflow.id,
          status: "review_required"
        });
      }
    }
    logger.info("workflow_control_applied", {
      requestId,
      workflowRunId,
      action,
      resumedPhase: workflow.status
    });
    return redirect(res, `/workflow?runId=${encodeURIComponent(workflowRunId)}`);
  } catch (error) {
    const issue = publicError(error, {
      fallbackCode: "WORKFLOW_CONTROL_FAILED",
      fallbackMessage: "工作流控制未能完成。",
      statusCode: 409
    });
    logger.error("workflow_control_failed", {
      requestId,
      workflowRunId,
      action,
      error: errorMeta(error),
      errorCode: issue.code
    });
    return sendJson(res, issue.statusCode, {
      error: issue.message,
      errorCode: issue.code,
      requestId,
      ...(issue.code === "MODEL_CONFIGURATION_REQUIRED"
        ? { settingsHref: "/settings#model-profile-batch_screening" }
        : {})
    });
  }
}

function sameWorkflowControlSnapshot(before, after) {
  return Boolean(before && after)
    && before.id === after.id
    && before.status === after.status
    && before.controlState === after.controlState
    && Number(before.progressRevision || 0) === Number(after.progressRevision || 0);
}

function settleFailedWorkflowLaunch(db, scanRuns, workflow, error) {
  const current = getWorkflowRun(db, workflow?.id);
  if (!current
    || !["scanning", "analyzing"].includes(current.status)
    || exactActiveWorkflowRun(scanRuns, current)) {
    return current;
  }
  return transitionWorkflowRun(db, {
    id: current.id,
    status: "interrupted",
    errorCode: String(error?.code || "WORKFLOW_PROCESS_LAUNCH_FAILED"),
    errorMessage: String(error?.message || "workflow process launch failed")
  });
}

function scheduleExactWorkflowControlFallback({
  db,
  scanRuns,
  workflowRunId,
  expectedRun,
  expectedControlState,
  schedule,
  graceMs,
  logger
}) {
  if (!expectedRun?.child || typeof schedule !== "function") return null;
  const expectedChild = expectedRun.child;
  const delayMs = Math.max(1, Number(graceMs)
    || PRODUCT_POLICY.operations.modelAnalysis.taskLeaseTtlMs);
  let timer;
  try {
    timer = schedule(() => {
      const workflow = getWorkflowRun(db, workflowRunId);
      const active = exactActiveWorkflowRun(scanRuns, workflow);
      if (!workflow
        || workflow.controlState !== expectedControlState
        || active !== expectedRun
        || active.child !== expectedChild
        || active.exited) {
        return false;
      }
      if (typeof expectedChild.kill !== "function") {
        logger?.warn("workflow_control_fallback_unavailable", {
          workflowRunId,
          controlState: expectedControlState
        });
        return false;
      }
      const killed = expectedChild.kill("SIGTERM");
      logger?.warn("workflow_control_fallback_terminated", {
        workflowRunId,
        controlState: expectedControlState,
        killed: killed !== false
      });
      return killed !== false;
    }, delayMs);
    timer?.unref?.();
  } catch (error) {
    logger?.error("workflow_control_fallback_schedule_failed", {
      workflowRunId,
      controlState: expectedControlState,
      error: errorMeta(error)
    });
  }
  return timer || null;
}

function publicWorkflow(workflow) {
  return {
    id: String(workflow.id || ""),
    status: String(workflow.status || ""),
    controlState: String(workflow.controlState || "none"),
    lastActivityAt: workflow.lastActivityAt || null,
    progressRevision: Number(workflow.progressRevision || 0),
    errorCode: workflow.errorCode ? String(workflow.errorCode) : null
  };
}

function publicCommunicationStatus(communication) {
  if (!communication) return null;
  return {
    batch: {
      id: Number(communication.batch?.id || 0),
      status: String(communication.batch?.status || "")
    },
    summary: {
      batchId: Number(communication.summary?.batchId || 0),
      batchStatus: String(communication.summary?.batchStatus || ""),
      statusCounts: Object.fromEntries(
        Object.entries(communication.summary?.statusCounts || {})
          .filter(([status, count]) => /^[a-z_]+$/.test(status) && Number.isFinite(Number(count)))
          .map(([status, count]) => [status, Math.max(0, Number(count))])
      ),
      total: Math.max(0, Number(communication.summary?.total || 0)),
      terminal: Math.max(0, Number(communication.summary?.terminal || 0)),
      remaining: Math.max(0, Number(communication.summary?.remaining || 0))
    }
  };
}

function exactActiveWorkflowRun(scanRuns, workflow) {
  if (!workflow) return null;
  const keys = [
    `workflow:${workflow.id}`,
    Number(workflow.planId)
  ];
  for (const key of keys) {
    const local = scanRuns.get(key);
    if (local
      && !local.exited
      && local.workflowRunId === workflow.id
      && local.child) {
      return local;
    }
  }
  return null;
}

function exactPersistedWorkflowRunIsRunning(db, workflow) {
  if (!workflow?.scanRunId) return false;
  return getScanRun(db, workflow.scanRunId)?.status === "running";
}

function workflowModelProfilesSnapshot(modelState, { backupRuntime = null } = {}) {
  const settings = modelState?.settings || {};
  const batch = settings.taskProfiles?.batch_screening;
  if (!batch?.revision) {
    throw appError(
      "MODEL_CONFIGURATION_REQUIRED",
      "批量筛选模型配置缺少版本，不能创建可恢复工作流。",
      { statusCode: 409 }
    );
  }
  const credential = batch.credentialRef === "independent"
    ? settings.independentCredentials?.batch_screening
    : settings.sharedCredential;
  const backup = settings.batchBackup;
  const backupUsable = Boolean(
    backupRuntime
    && backup?.enabled
    && backup.connection?.status === "verified"
  );
  return {
    batch_screening: {
      revision: String(batch.revision),
      provider: String(credential?.provider || ""),
      model: String(batch.model || ""),
      thinkingMode: String(batch.thinkingMode || "disabled"),
      reasoningEffort: String(batch.reasoningEffort || "high"),
      timeoutMs: Number(batch.timeoutMs || 0),
      concurrency: Number(batch.concurrency || 1)
    },
    batch_backup: backupUsable ? {
      revision: String(backup.revision || backupRuntime.revision || ""),
      provider: String(backup.provider || ""),
      model: String(backup.model || ""),
      thinkingMode: String(backup.thinkingMode || "disabled"),
      reasoningEffort: String(backup.reasoningEffort || "high"),
      timeoutMs: Number(backup.timeoutMs || 0)
    } : null
  };
}

function workflowBatchResumeEvidence(modelState, { ready = false } = {}) {
  const profile = modelState?.settings?.taskProfiles?.batch_screening;
  if (!ready || !profile || profile.connection?.status !== "verified") return {};
  return {
    batchModelRevision: String(profile.revision || ""),
    batchModelVerifiedAt: String(profile.connection.checkedAt || "")
  };
}

function assertWorkflowAnalysisBatch(db, workflow) {
  const batch = workflow?.scanBatchId ? getBatch(db, workflow.scanBatchId) : null;
  if (!batch
    || batch.site !== "boss"
    || Number(batch.searchPlanId || 0) !== Number(workflow?.planId || 0)
    || Number(batch.profileId || 0) !== Number(workflow?.profileId || 0)) {
    throw appError(
      "WORKFLOW_ANALYSIS_BATCH_MISMATCH",
      "本轮持久化分析批次不存在或不属于当前工作流。",
      { statusCode: 409 }
    );
  }
  return batch;
}

function resolveWorkflowControlBrowserAuthority(workflow, params = {}) {
  const acquisitionMode = String(workflow?.planner?.acquisitionMode || "").trim();
  if (!["generated", "inherited"].includes(acquisitionMode)) {
    throw appError(
      "WORKFLOW_ACQUISITION_MODE_INVALID",
      "本轮任务的采集模式无效。",
      { statusCode: 409 }
    );
  }
  if (acquisitionMode === "inherited") {
    try {
      assertCompleteInheritedContext(workflow.planner, {
        code: "WORKFLOW_INHERITED_SNAPSHOT_INVALID",
        message: "本轮继承模式快照不完整。",
        planId: workflow.planId
      });
    } catch (error) {
      throw appError(
        "WORKFLOW_INHERITED_SNAPSHOT_INVALID",
        "本轮继承模式快照不完整。",
        { statusCode: 409, cause: error }
      );
    }
  }
  const browserMode = resolveWorkflowResumeBrowserMode(workflow, params.browserMode);
  if (browserMode === "edge") return { browserMode: "edge", cdpPort: null };
  const storedCdpPort = Number(workflow?.planner?.cdpPort);
  const cdpPort = normalizeCdpPort(
    params.cdpPort || (Number.isInteger(storedCdpPort) ? storedCdpPort : PORTABLE_CDP_PORT)
  );
  if (cdpPort !== PORTABLE_CDP_PORT) {
    throw appError(
      "INHERITED_PORTABLE_PORT_REQUIRED",
      "继承模式必须使用项目专用 Edge 的 9222 端口。",
      { statusCode: 409 }
    );
  }
  return { browserMode, cdpPort };
}

function workflowBlockedMessage(code, plan = {}) {
  return {
    WORKFLOW_DAILY_RUN_LIMIT: "今天的三轮任务都已创建。",
    WORKFLOW_DAILY_TARGET_REACHED: "今天的目标已完成，无需再创建新一轮。",
    WORKFLOW_THIRD_SCAN_NOT_NEEDED: "当前候选库存已足够，不需要追加第三轮扫描。",
    WORKFLOW_SCAN_INTERVAL: plan.nextRunAt
      ? `两轮扫描至少间隔 2 小时，下次可在 ${new Date(plan.nextRunAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 开始。`
      : "两轮扫描至少间隔 2 小时。"
  }[code] || "当前不能创建新一轮。";
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function startPlanScan(scanRuns, {
  db,
  root,
  dbPath,
  planId,
  cdpPort,
  browserMode = "edge",
  scanKind = "daily",
  resumeBatchId = null,
  workflowRunId = "",
  logger,
  requestId,
  spawnProcess = spawn
}) {
  if (!dbPath) throw new Error("扫描数据路径未配置。");
  const runId = randomUUID();
  let workflowRun = workflowRunId ? getWorkflowRun(db, workflowRunId) : null;
  if (workflowRunId && (!workflowRun || workflowRun.planId !== Number(planId))) {
    throw appError("WORKFLOW_PLAN_MISMATCH", "Workflow run does not belong to this search plan.");
  }
  if (workflowRun && !["created", "scanning", "analyzing", "interrupted"].includes(workflowRun.status)) {
    throw appError("WORKFLOW_SCAN_STATUS_INVALID", `Workflow run cannot scan from ${workflowRun.status}.`);
  }
  if (workflowRun && !["scanning", "analyzing"].includes(workflowRun.status)) {
    workflowRun = transitionWorkflowRun(db, { id: workflowRun.id, status: "scanning" });
  }
  const analysisOnly = workflowRun?.status === "analyzing";
  if (!analysisOnly) {
    assertBossRuntimeAvailable(db);
    const orphaned = interruptOrphanedScanRuns(db, {
      site: "boss",
      heartbeatTimeoutMs: PRODUCT_POLICY.operations.scanOrphanTimeoutMs
    });
    if (orphaned.interrupted) logger.warn("orphaned_scan_runs_interrupted", orphaned);
  }
  const processLogger = typeof logger.child === "function" ? logger.child({
    ...workflowLogContext({ ...(workflowRun || {}), scanRunId: runId }),
    requestId,
    runId,
    planId: Number(planId),
    scanKind
  }) : logger;
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
    resumeBatchId: analysisOnly ? null : effectiveResumeBatchId,
    ...(workflowRun ? {
      workflowRunId: workflowRun.id,
      analysisOnly,
      keywords: workflowRun.keywords.map((item) => item.word),
      maxCards: Math.max(...workflowRun.keywords.map((item) => Number(item.maxCards) || 0)),
      maxDetailTotal: workflowRun.budget.maxDetailTotal,
      browserPageBudget: workflowRun.budget.browserPageBudget
    } : {})
  });
  const persisted = createScanRun(db, { runId, site: "boss", command: scanKind, planId });
  if (analysisOnly) {
    try {
      attachWorkflowScan(db, {
        id: workflowRun.id,
        scanRunId: runId,
        scanBatchId: persistedResumeBatchId
      });
    } catch (error) {
      recordScanRunProcessExit(db, {
        runId,
        status: "failed",
        stopCode: String(error?.code || "WORKFLOW_ANALYSIS_ATTACH_FAILED"),
        stopMessage: String(error?.message || "analysis execution could not be attached")
      });
      throw error;
    }
  }
  const run = { runId, kind: scanKind, resumeBatchId: effectiveResumeBatchId, workflowRunId: workflowRun?.id || "", startedAt: persisted.createdAt, output: "", error: "", exitCode: null, child: null, exited: false };
  scanRuns.set(analysisOnly ? `workflow:${workflowRun.id}` : Number(planId), run);
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
      if (workflowRun) {
        const currentWorkflow = getWorkflowRun(db, workflowRun.id);
        if (["pause_requested", "stop_requested"].includes(currentWorkflow?.controlState)) {
          finalizeWorkflowControl(db, {
            workflowRunId: workflowRun.id,
            now: finished.finishedAt || new Date().toISOString()
          });
        } else if (["scanning", "analyzing"].includes(currentWorkflow?.status)) {
          transitionWorkflowRun(db, {
            id: workflowRun.id,
            status: "interrupted",
            errorCode: String(
              error?.code
              || finished.stopCode
              || (finished.status === "completed"
                ? "WORKFLOW_PROCESS_EXITED_EARLY"
                : "SCAN_PROCESS_ERROR")
            ),
            errorMessage: String(
              error?.message
              || finished.stopMessage
              || "workflow process exited before reaching a terminal workflow state"
            )
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
      const linkedContext = workflowLogContext({
        ...(workflowRun ? getWorkflowRun(db, workflowRun.id) : {}),
        scanRunId: runId
      });
      if (finished.status === "completed") processLogger.info("scan_process_completed", { ...context, ...linkedContext });
      else if (finished.status === "failed") processLogger.error("scan_process_failed", { ...context, ...linkedContext, outputTail: run.output });
      else processLogger.warn("scan_process_stopped", { ...context, ...linkedContext, outputTail: run.output });
    } catch (recordError) {
      run.error = recordError.message;
      processLogger.error("scan_process_exit_record_failed", { error: errorMeta(recordError) });
    }
  };

  try {
    const child = spawnProcess(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.js", ...commandArgs], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    run.child = child;
    processLogger.info("scan_process_started", { resumeBatchId: effectiveResumeBatchId, browserMode, cdpPort: browserMode === "portable" ? cdpPort : null, childPid: child.pid });
    const append = (chunk) => { run.output = `${run.output}${String(chunk)}`.slice(-4000); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      processLogger.error("scan_process_error", { error: errorMeta(error) });
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

async function handleMessageDiscovery(req, res, controller) {
  try {
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    const action = String(params.action || "").trim();
    let result;
    if (action === "start") result = controller.start(params.profileId);
    else if (action === "stop") result = controller.stop(params.profileId);
    else if (action === "dismiss") result = controller.dismiss(params.profileId);
    else throw appError("MESSAGE_DISCOVERY_ACTION_INVALID", "消息发现操作无效。", { statusCode: 400 });
    sendJson(res, result.statusCode, result.body);
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 400;
    sendJson(res, statusCode, {
      error: messageDiscoveryPublicError(error),
      errorCode: error?.code || "MESSAGE_DISCOVERY_FAILED"
    });
  }
}

function handleMessageDiscoveryStatus(res, controller, profileIdValue) {
  try {
    sendJson(res, 200, controller.status(profileIdValue));
  } catch (error) {
    sendJson(res, 400, {
      error: messageDiscoveryPublicError(error),
      errorCode: error?.code || "MESSAGE_DISCOVERY_FAILED"
    });
  }
}

function messageDiscoveryPublicError(error) {
  return {
    MESSAGE_DISCOVERY_PROFILE_INVALID: "profileId 无效。",
    MESSAGE_DISCOVERY_PROFILE_NOT_FOUND: "候选人画像不存在。",
    MESSAGE_DISCOVERY_ALREADY_RUNNING: "该候选人的消息发现正在运行。",
    MESSAGE_DISCOVERY_LEASE_BUSY: "BOSS 当前有其他任务运行。",
    MESSAGE_DISCOVERY_NOT_FOUND: "没有可操作的消息发现任务。",
    MESSAGE_DISCOVERY_NOT_RUNNING: "消息发现当前未运行。",
    MESSAGE_DISCOVERY_RUNNING: "请先安全停止，再放弃草稿。",
    MESSAGE_DISCOVERY_ACTION_INVALID: "消息发现操作无效。"
  }[String(error?.code || "")] || "消息发现操作失败。";
}

function messageDiscoveryViewHelpers() {
  return {
    getCandidateProfile,
    renderErrorPage,
    renderPage,
    navLinks,
    escapeHtml,
    escapeAttr,
    progressStageLabel,
    newProgressRequestKey
  };
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

async function handleProgress(req, res, db, messageDiscovery = null) {
  try {
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    const card = getProgressCardById(db, params.cardId);
    if (!card) throw appError("PROGRESS_CARD_NOT_FOUND", "进展卡不存在。", { statusCode: 404 });
    const action = String(params.action || "").trim();
    if (action === "correct_stage") {
      const targetStage = String(params.targetStage || "").trim();
      if (!PROGRESS_STAGES.has(targetStage)) throw appError("PROGRESS_STAGE_INVALID", "目标阶段无效。", { statusCode: 400 });
      correctProgressStage(db, {
        cardId: card.id,
        idempotencyKey: params.idempotencyKey,
        expectedStage: card.stage,
        toStage: targetStage,
        reason: params.reason
      });
    } else {
      const definition = PROGRESS_ACTIONS[action];
      if (!definition) throw appError("PROGRESS_ACTION_INVALID", "进展操作无效。", { statusCode: 400 });
      const enteredSummary = String(params.summary || "").trim();
      if (action === "mark_interview_scheduled" && !enteredSummary) {
        throw appError("PROGRESS_INTERVIEW_SUMMARY_REQUIRED", "请填写你确认的面试安排摘要。", { statusCode: 400 });
      }
      let scheduledAt = String(params.scheduledAt || "").trim();
      if (action === "mark_interview_scheduled") {
        if (!Number.isFinite(Date.parse(scheduledAt))) {
          throw appError("PROGRESS_INTERVIEW_TIME_INVALID", "面试时间必须是有效日期时间。", { statusCode: 400 });
        }
        scheduledAt = new Date(scheduledAt).toISOString();
      }
      recordManualProgressAction(db, {
        cardId: card.id,
        idempotencyKey: params.idempotencyKey,
        stage: definition.stage,
        eventType: definition.eventType,
        summary: enteredSummary || definition.summary,
        nextAction: definition.nextAction,
        scheduledAt
      });
      if (action === "reply_confirmed_sent" && messageDiscovery) {
        messageDiscovery.clearDraftForCard(card.profileId, card.id);
      }
    }
    redirect(res, `/queue?planId=${card.planId}`);
  } catch (error) {
    const issue = publicError(error, { fallbackCode: "PROGRESS_UPDATE_FAILED" });
    const statusCode = Number(issue.statusCode) >= 400 && Number(issue.statusCode) < 500
      ? issue.statusCode
      : 400;
    sendJson(res, statusCode, { error: issue.message, errorCode: issue.code });
  }
}

function canGenerateGreeting(job) {
  const analysis = job.analysis || {};
  return ["primary", "apply"].includes(job.decisionBucket) && analysis.semanticStatus === "complete"
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
      workflowRunId: params.workflowRunId,
      planId: params.planId,
      jobIds,
      browserMode: params.browserMode,
      policySnapshot: { calibration: communicationCalibrationStatus() }
    });
    return { batch, summary: communicationBatchSummary(db, batch.id), items: listCommunicationBatchItems(db, batch.id), quota: communicationQuota(db) };
  });
  if (!result.ok) return sendJson(res, result.statusCode, result.body);
  if (String(req.headers.accept || "").includes("application/json")) return sendJson(res, 200, result.body);
  const workflow = getWorkflowRunByCommunicationBatch(db, result.body.batch.id);
  redirect(res, workflow ? `/workflow?runId=${encodeURIComponent(workflow.id)}` : `/communication?batchId=${result.body.batch.id}`);
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
      const expected = action === "start" ? ["confirmed"] : ["paused", "interrupted"];
      if (!expected.includes(batch.status)) {
        throw appError("COMMUNICATION_BATCH_STATUS_INVALID", `${action} requires a ${expected.join(" or ")} communication batch`, { statusCode: 409 });
      }
      const running = batch.status === "interrupted"
        ? resumeInterruptedCommunicationBatch(db, { batchId }).batch
        : setCommunicationBatchStatus(db, { batchId, status: "running" });
      if (running.status !== "running") {
        throw appError("COMMUNICATION_RESUME_REQUIRES_REVIEW", "请先人工处理结果不明确的岗位，再继续沟通。", { statusCode: 409 });
      }
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
  const workflow = getWorkflowRunByCommunicationBatch(db, result.body.batch.id);
  redirect(res, workflow ? `/workflow?runId=${encodeURIComponent(workflow.id)}` : `/communication?batchId=${result.body.batch.id}`);
}

function startCommunicationProcess({ db, root, dbPath, batch, logger, requestId, spawnProcess = spawn }) {
  if (!dbPath) throw appError("COMMUNICATION_DB_PATH_REQUIRED", "沟通执行缺少数据库路径。", { statusCode: 500 });
  const workflow = getWorkflowRunByCommunicationBatch(db, batch.id);
  const processLogger = typeof logger.child === "function" ? logger.child({
    ...workflowLogContext({ ...(workflow || {}), communicationBatchId: batch.id }),
    requestId,
    batchId: batch.id,
    planId: batch.planId,
    operation: "communication"
  }) : logger;
  let child;
  try {
    const portableCdpPort = batch.browserMode === "portable"
      ? portableCommunicationCdpPort(batch)
      : null;
    const commandArgs = [
      "--disable-warning=ExperimentalWarning",
      "src/cli.js",
      "communicate",
      "--db", dbPath,
      "--batch", String(batch.id),
      "--browser", batch.browserMode
    ];
    if (batch.browserMode === "portable") {
      commandArgs.push(
        "--cdp-port",
        String(portableCdpPort)
      );
    }
    child = spawnProcess(process.execPath, commandArgs, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    setCommunicationBatchStatus(db, { batchId: batch.id, status: "interrupted", stopCode: "COMMUNICATION_PROCESS_START_FAILED", stopMessage: error.message });
    throw error;
  }
  processLogger.info("communication_process_started", { browserMode: batch.browserMode, childPid: child.pid });
  child.stdout?.on("data", (chunk) => processLogger.info("communication_process_output", { stream: "stdout", message: String(chunk).slice(-2000) }));
  child.stderr?.on("data", (chunk) => processLogger.info("communication_process_output", { stream: "stderr", message: String(chunk).slice(-2000) }));
  const interruptRunning = (code, message) => {
    const current = getCommunicationBatch(db, batch.id);
    if (current?.status === "running") {
      setCommunicationBatchStatus(db, { batchId: batch.id, status: "interrupted", stopCode: code, stopMessage: message });
    }
  };
  child.on("error", (error) => {
    interruptRunning("COMMUNICATION_PROCESS_ERROR", error.message);
    processLogger.error("communication_process_error", { error: errorMeta(error) });
  });
  child.on("close", (code, signal) => {
    if (code !== 0) interruptRunning("COMMUNICATION_PROCESS_EXITED", signal ? `signal ${signal}` : `exit ${code}`);
    processLogger.info("communication_process_closed", { exitCode: code, signal: signal || null });
  });
  return child;
}

function portableCommunicationCdpPort(batch) {
  const browserPolicy = batch.policySnapshot?.browser;
  if (!browserPolicy) return PORTABLE_CDP_PORT;
  if (!Number.isInteger(browserPolicy.cdpPort) || browserPolicy.cdpPort !== PORTABLE_CDP_PORT) {
    throw appError(
      "COMMUNICATION_PORTABLE_CDP_PORT_INVALID",
      "portable communication requires fixed CDP port 9222",
      { statusCode: 409 }
    );
  }
  return browserPolicy.cdpPort;
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
  <p class="hint">每个版本都可以限定适用方向、关键词和主推项目；停用版本不会参与下次匹配。投递版简历只用于岗位沟通与版本管理：新增、编辑或停用版本不会改变基础候选人画像，也不会替换当前匹配偏好卡。</p>
  <form class="panel form-stack" method="post" action="/api/resume-version" enctype="multipart/form-data">
    <input type="hidden" name="profileId" value="${escapeAttr(profile.id)}">
    <h2>新增版本</h2>
    <label>版本名称<input name="name" placeholder="例如：AI 应用开发版"></label>
    <label>简历文件<input name="resumeVersion" type="file" accept=".txt,.md,.docx,.pdf"></label>
    <label>或粘贴简历文本<textarea name="resumeText" placeholder="文件无法解析时可用"></textarea></label>
    ${renderResumeVersionFields({ isActive: true })}
    ${renderResumePreviewControls()}
    <p class="hint">原始文件留在本机；姓名、手机号、邮箱、住址和身份证号会在本地遮盖后再发送模型。</p>
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
    <p class="hint">提交后先在本地提取文本；姓名、手机号、邮箱、住址和身份证号会在本地遮盖后再发送模型，由当前模型厂商生成画像和搜索建议。API Key 与原始文件不会随请求发送。</p>
    <button${modelReady ? "" : " disabled"}>解析并生成筛选建议</button>
  </form>
  ${profiles.length ? `<section class="panel"><h2>已有候选人</h2>${profiles.map((profile) => `<p><a href="/plan?profileId=${profile.id}&planId=${profile.activePlanId || ""}">${escapeHtml(profile.displayName)}</a> · 最近更新 ${escapeHtml(profile.updatedAt.slice(0, 16).replace("T", " "))}</p>`).join("")}</section>` : ""}
</main>${resumePreviewScript()}`);
}

function renderResumePreviewControls() {
  return `<div class="inline-form"><button type="button" onclick="previewResumeModelInput(this)">预览发送内容</button></div><details class="resume-preview" hidden><summary></summary><pre></pre></details>`;
}

function resumePreviewScript() {
  return `<script>async function previewResumeModelInput(button){const form=button.closest("form");const box=form.querySelector(".resume-preview");const summary=box.querySelector("summary");const pre=box.querySelector("pre");button.disabled=true;try{const response=await fetch("/api/resume/preview",{method:"POST",body:new FormData(form)});const data=await response.json();if(!response.ok)throw new Error(data.error||"预览失败");const labels={name:"姓名",phone:"电话/手机",email:"邮箱",idCard:"身份证号",address:"详细住址"};const masked=Object.entries(data.redactions||{}).map(([key,count])=>(labels[key]||key)+" "+count+" 处").join("、")||"未发现需遮蔽字段";summary.textContent="将发送 "+data.charCount+" 字；"+masked;pre.textContent=data.text;box.hidden=false;box.open=true}catch(error){summary.textContent=error.message;pre.textContent="";box.hidden=false;box.open=true}finally{button.disabled=false}}</script>`;
}

function renderModelSettingsPage({ modelState, searchParams }) {
  const settings = modelState.settings || {};
  const currentCredentials = [
    settings.sharedCredential,
    settings.independentCredentials?.deep_analysis,
    settings.independentCredentials?.batch_screening,
    settings.batchBackup
  ].filter(Boolean);
  const includeAdvanced = searchParams.get("advanced") === "1"
    || currentCredentials.some((credential) => credential.preset === "mock");
  const presets = listModelPresets({ includeAdvanced });
  const profiles = listModelTaskProfiles();
  const selectedProfile = String(searchParams.get("profile") || "");
  const saved = searchParams.get("modelConfigured")
    ? `<p class="notice">模型连接测试通过，${escapeHtml(selectedProfile || "任务配置")} 已保存。</p>`
    : "";
  const restored = searchParams.get("recommended")
    ? `<p class="setup-warning">已恢复推荐值；请重新测试连接后再使用该任务配置。</p>`
    : "";
  const keyStatus = modelState.keyErrorCode === "SECRET_UNREADABLE"
    ? "API Key 文件无法解密，请重新输入"
    : modelState.keyConfigured
      ? "API Key 已加密保存"
      : "尚未保存共享 API Key";
  const profileSections = profiles.map((definition) => renderModelTaskProfileSection({
    definition,
    settings,
    presets,
    modelState,
    selected: selectedProfile === definition.id
  })).join("");
  const backupSection = renderBatchBackupSettings({
    settings,
    presets,
    modelState,
    selected: selectedProfile === "batch_backup"
  });
  const presetJson = JSON.stringify(presets).replace(/</g, "\\u003c");
  const body = `<style>
    .settings-page{max-width:980px;padding-top:28px}.settings-header{max-width:760px;margin:28px 0 20px}.settings-header h1{font-size:30px;margin:4px 0 9px}.eyebrow{margin:0;color:#176b5b;font-size:13px;font-weight:700}.settings-credentials{border-left:4px solid #176b5b}.settings-profile{scroll-margin-top:18px;padding:22px}.settings-profile.selected{box-shadow:0 0 0 3px #b9ddd4}.settings-profile-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.settings-profile-head h2{font-size:21px;margin-bottom:4px}.settings-current{margin:0;color:#46545e;font-size:13px}.settings-recommended{margin:12px 0;padding:10px 12px;border:1px solid #c9d8de;border-radius:6px;background:#f7fafb;color:#46545e;font-size:13px}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.settings-field{display:grid;gap:6px;font-size:14px;font-weight:600}.settings-field input,.settings-field select{width:100%;box-sizing:border-box}.settings-field small{font-size:12px;line-height:1.45;font-weight:400;color:#57606a}.settings-field-wide{grid-column:1/-1}.settings-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:9px;margin-top:18px}.settings-secondary{background:#fff;color:#176b5b;border-color:#176b5b}.settings-advanced{margin-top:16px}.settings-advanced summary{cursor:pointer;font-weight:700}.settings-advanced-grid{margin-top:14px}.settings-status{padding:9px 11px;border-left:3px solid #8c959f;background:#f6f8fa}.settings-status.verified{border-left-color:#176b5b;background:#edf7f4}.settings-backup{scroll-margin-top:18px}.settings-backup summary{cursor:pointer;font-size:18px;font-weight:700}.settings-backup-body{padding-top:16px}.settings-toggle{display:flex;align-items:center;gap:8px}.settings-toggle input{width:auto}.setup-warning{border-left:4px solid #bf8700;background:#fff8c5;padding:10px 12px;margin:12px 0}@media(max-width:760px){.settings-page{padding-top:16px}.settings-header{margin:20px 0 16px}.settings-header h1{font-size:26px}.settings-profile{padding:16px}.settings-profile-head{display:block}.settings-current{margin-top:7px}.settings-grid{grid-template-columns:1fr}.settings-field-wide{grid-column:auto}.settings-actions{justify-content:stretch}.settings-actions button{width:100%}}
  </style><main class="settings-page">
    <nav>${navLinks()}</nav>
    <header class="settings-header">
      <p class="eyebrow">按任务选择模型</p>
      <h1>模型设置</h1>
      <p class="hint">深度分析处理简历与内容生成；批量筛选处理岗位理解、匹配和重试。两套配置默认共享厂商和 API Key，但模型参数互不覆盖。</p>
    </header>
    ${saved}${restored}
    <section class="panel settings-credentials">
      <h2>共享厂商和 API Key</h2>
      <p>默认模式：两套任务配置共享厂商和 Windows 加密保存的 Key。需要拆分时，在对应配置的“高级设置”中选择“独立厂商和 API Key”。</p>
      <div class="settings-grid">
        <label class="settings-field">共享模型厂商<select id="shared-model-preset">${renderPresetOptions(presets, settings.sharedCredential?.preset || "deepseek")}</select><small>选择后会同步到仍使用共享凭据的任务配置。</small></label>
        <label class="settings-field">共享 API Key<input id="shared-model-api-key" type="password" autocomplete="new-password" placeholder="${modelState.keyConfigured ? "已保存，留空保持不变" : "粘贴 API Key"}"><small>在下方任一共享任务点击“测试连接并保存”时写入。</small></label>
      </div>
      <p class="settings-current">当前共享厂商：${escapeHtml(settings.sharedCredential?.preset || "未设置")} · ${escapeHtml(keyStatus)}</p>
    </section>
    ${profileSections}
    ${backupSection}
    <p class="hint">API Key 不进入设置 JSON、日志、数据库或页面响应。</p>
    <script id="model-preset-data" type="application/json">${presetJson}</script>
    ${modelSettingsClientScript()}
  </main>`;
  return renderPage("模型设置", body);
}

function renderModelTaskProfileSection({ definition, settings, presets, modelState, selected }) {
  const profile = settings.taskProfiles?.[definition.id] || {};
  const credential = modelCredentialForTask(settings, definition.id);
  const preset = presets.find((item) => item.id === credential.preset)
    || presets.find((item) => item.id === "custom")
    || presets[0];
  const purpose = definition.id === "deep_analysis"
    ? "用于简历解析、候选人画像、搜索建议、匹配偏好卡和主动生成沟通内容。"
    : "用于岗位理解、岗位匹配、单岗重试和批量重试。";
  const recommended = definition.recommended;
  const connection = profile.connection || {};
  const verified = connection.status === "verified";
  const supportsThinking = supportsDeepSeekV4Thinking(preset.id, profile.model);
  const shared = profile.credentialRef !== "independent";
  const customModel = !(preset.models || []).includes(profile.model);
  const current = `${credential.preset || credential.provider || "未设置"} · ${profile.model || "未设置"} · ${profile.timeoutMs || 0}ms · 并发 ${profile.concurrency || 1}`;
  const recommendedText = `${recommended.model} · ${recommended.timeoutMs}ms · 思考${recommended.thinkingMode === "enabled" ? "开启" : "关闭"} · 并发 ${recommended.concurrency}`;
  const profileId = escapeAttr(definition.id);
  return `<section class="panel settings-profile${selected ? " selected" : ""}" id="model-profile-${profileId}">
    <div class="settings-profile-head">
      <div><h2>${escapeHtml(definition.label)}</h2><p class="hint">${escapeHtml(purpose)}</p></div>
      <p class="settings-current">当前值：${escapeHtml(current)}</p>
    </div>
    <p class="settings-recommended">推荐值：${escapeHtml(recommendedText)}</p>
    <form class="model-profile-form" method="post" action="/api/settings/model" data-task-profile="${profileId}">
      <input type="hidden" name="taskProfile" value="${profileId}">
      <div class="settings-grid">
        <label class="settings-field">模型厂商<select class="profile-preset" name="preset">${renderPresetOptions(presets, preset.id)}</select><small>共享模式下修改厂商会应用到两套任务；要拆分请打开高级设置。</small></label>
        <label class="settings-field">模型<select class="profile-model" name="model">${renderProfileModelOptions(preset, profile.model)}</select><input class="profile-custom-model" name="customModel" maxlength="160" value="${customModel ? escapeAttr(profile.model || "") : ""}" placeholder="填写自定义模型名"${customModel ? "" : " hidden"}></label>
        <label class="settings-field">请求超时（毫秒）<input name="timeoutMs" type="number" min="3000" max="120000" value="${Number(profile.timeoutMs || recommended.timeoutMs)}" required></label>
        ${definition.id === "deep_analysis"
          ? `<label class="settings-field">并发数<output>1（固定）</output><input type="hidden" name="concurrency" value="1"><small>深度分析保持串行，避免高成本调用重叠。</small></label>`
          : `<label class="settings-field">并发数<select name="concurrency"><option value="1"${Number(profile.concurrency) === 1 ? " selected" : ""}>1</option><option value="2"${Number(profile.concurrency) === 2 ? " selected" : ""}>2（推荐）</option></select><small>只并发处理已保存到本地的 JD，不增加 BOSS 页面并发。</small></label>`}
        <label class="settings-field profile-thinking"${supportsThinking ? "" : " hidden"}>思考模式<select name="thinkingMode"${supportsThinking ? "" : " disabled"}><option value="disabled"${profile.thinkingMode === "disabled" ? " selected" : ""}>关闭思考</option><option value="enabled"${profile.thinkingMode === "enabled" ? " selected" : ""}>开启思考</option></select></label>
        <label class="settings-field profile-reasoning"${supportsThinking ? "" : " hidden"}>推理强度<select name="reasoningEffort"${supportsThinking ? "" : " disabled"}><option value="high"${profile.reasoningEffort === "high" ? " selected" : ""}>高（high）</option><option value="max"${profile.reasoningEffort === "max" ? " selected" : ""}>最高（max）</option></select></label>
        <div class="settings-field settings-status${verified ? " verified" : ""}"><strong>连接状态</strong><small>${escapeHtml(modelConnectionLabel(connection))}</small></div>
      </div>
      <details class="settings-advanced"><summary>高级设置</summary>
        <div class="settings-grid settings-advanced-grid">
          <label class="settings-field">凭据模式<select class="profile-credential-mode" name="credentialMode"><option value="shared"${shared ? " selected" : ""}>共享厂商和 API Key</option><option value="independent"${shared ? "" : " selected"}>独立厂商和 API Key</option></select></label>
          <div class="settings-field settings-field-wide profile-independent-credentials"${shared ? " hidden" : ""}>
            <label class="settings-field">独立 API Key<input class="profile-api-key" name="apiKey" type="password" autocomplete="new-password" placeholder="已保存则可留空"><small>只供当前任务使用；切换厂商时不会复用共享或另一厂商的 Key。</small></label>
            <label class="settings-field">兼容接口基础地址<input class="profile-base-url" name="baseUrl" type="url" value="${escapeAttr(credential.baseUrl || "")}"${preset.id === "custom" ? "" : " readonly"}></label>
          </div>
        </div>
      </details>
      <div class="settings-actions">
        <button class="settings-secondary" name="action" value="restore_recommended" formnovalidate>恢复推荐值</button>
        <button name="action" value="save">测试连接并保存</button>
      </div>
    </form>
  </section>`;
}

function renderBatchBackupSettings({ settings, presets, modelState, selected }) {
  const backup = settings.batchBackup || {};
  const preset = presets.find((item) => item.id === backup.preset)
    || presets.find((item) => item.id === "custom")
    || presets[0];
  const customModel = !(preset.models || []).includes(backup.model);
  const verified = backup.connection?.status === "verified";
  return `<details class="panel settings-backup${selected ? " selected" : ""}" id="model-profile-batch_backup">
    <summary>批量备用模型 · ${backup.enabled ? "已启用" : "备用模型默认关闭"}</summary>
    <div class="settings-backup-body">
      <p class="setup-warning">备用模型必须先通过连接测试，只用于单岗第二次尝试，不会替换整批主模型。</p>
      <form class="model-profile-form" method="post" action="/api/settings/model" data-task-profile="batch_backup">
        <input type="hidden" name="taskProfile" value="batch_backup">
        <div class="settings-grid">
          <label class="settings-toggle settings-field-wide"><input name="enabled" type="checkbox"${backup.enabled ? " checked" : ""}>启用已验证的备用模型</label>
          <label class="settings-field">模型厂商<select class="profile-preset" name="preset">${renderPresetOptions(presets, preset.id)}</select></label>
          <label class="settings-field">模型<select class="profile-model" name="model">${renderProfileModelOptions(preset, backup.model)}</select><input class="profile-custom-model" name="customModel" maxlength="160" value="${customModel ? escapeAttr(backup.model || "") : ""}" placeholder="填写自定义模型名"${customModel ? "" : " hidden"}></label>
          <label class="settings-field">请求超时（毫秒）<input name="timeoutMs" type="number" min="3000" max="120000" value="${Number(backup.timeoutMs || 90000)}" required></label>
          <label class="settings-field profile-thinking">思考模式<select name="thinkingMode"><option value="disabled"${backup.thinkingMode === "disabled" ? " selected" : ""}>关闭思考</option><option value="enabled"${backup.thinkingMode === "enabled" ? " selected" : ""}>开启思考</option></select></label>
          <label class="settings-field profile-reasoning">推理强度<select name="reasoningEffort"><option value="high"${backup.reasoningEffort === "high" ? " selected" : ""}>高（high）</option><option value="max"${backup.reasoningEffort === "max" ? " selected" : ""}>最高（max）</option></select></label>
          <div class="settings-field settings-status${verified ? " verified" : ""}"><strong>连接状态</strong><small>${escapeHtml(modelConnectionLabel(backup.connection))}</small></div>
        </div>
        <details class="settings-advanced"><summary>高级设置</summary><div class="settings-grid settings-advanced-grid">
          <input type="hidden" name="credentialMode" value="independent">
          <label class="settings-field">备用模型专用 API Key<input name="apiKey" type="password" autocomplete="new-password" placeholder="已保存则可留空"><small>备用模型使用独立密钥，不会复用主模型或其他厂商的 Key。</small></label>
          <label class="settings-field settings-field-wide">兼容接口基础地址<input class="profile-base-url" name="baseUrl" type="url" value="${escapeAttr(backup.baseUrl || "")}"${preset.id === "custom" ? "" : " readonly"}></label>
        </div></details>
        <div class="settings-actions"><button name="action" value="save">测试连接并保存备用模型</button></div>
      </form>
    </div>
  </details>`;
}

function modelCredentialForTask(settings, taskProfile) {
  const profile = settings.taskProfiles?.[taskProfile] || {};
  return profile.credentialRef === "independent"
    ? settings.independentCredentials?.[taskProfile] || settings.sharedCredential || {}
    : settings.sharedCredential || {};
}

function renderPresetOptions(presets, selectedPreset) {
  return presets.map((preset) => `<option value="${escapeAttr(preset.id)}"${preset.id === selectedPreset ? " selected" : ""}>${escapeHtml(preset.label)}</option>`).join("");
}

function renderProfileModelOptions(preset, selectedModel) {
  const models = [...new Set([...(preset.models || []), selectedModel].filter(Boolean))];
  const custom = selectedModel && !(preset.models || []).includes(selectedModel);
  const options = models.map((model) => `<option value="${escapeAttr(model)}"${model === selectedModel ? " selected" : ""}>${escapeHtml(model)}</option>`);
  options.push(`<option value="__custom__"${custom ? " selected" : ""}>自定义模型…</option>`);
  return options.join("");
}

function modelConnectionLabel(connection = {}) {
  if (connection.status !== "verified") return "尚未验证，保存时会发送一次极小连接测试";
  const checkedAt = connection.checkedAt
    ? ` · ${String(connection.checkedAt).replace("T", " ").slice(0, 16)}`
    : "";
  const latency = connection.latencyMs !== null && connection.latencyMs !== undefined
    ? ` · ${connection.latencyMs}ms`
    : "";
  return `已验证${checkedAt}${latency}`;
}

function modelSettingsClientScript() {
  return `<script>(function(){
    const presets=JSON.parse(document.getElementById("model-preset-data").textContent);
    const sharedPreset=document.getElementById("shared-model-preset");
    const sharedApiKey=document.getElementById("shared-model-api-key");
    ${supportsDeepSeekV4Thinking.toString()}
    const presetById=(id)=>presets.find((item)=>item.id===id)||presets[0];
    document.querySelectorAll(".model-profile-form").forEach((form)=>{
      const presetSelect=form.querySelector(".profile-preset");
      const modelSelect=form.querySelector(".profile-model");
      const customModel=form.querySelector(".profile-custom-model");
      const baseUrl=form.querySelector(".profile-base-url");
      const thinking=form.querySelector(".profile-thinking");
      const reasoning=form.querySelector(".profile-reasoning");
      const thinkingSelect=thinking?.querySelector("select");
      const reasoningSelect=reasoning?.querySelector("select");
      const credentialMode=form.querySelector(".profile-credential-mode");
      const independentCredentials=form.querySelector(".profile-independent-credentials");
      const profileApiKey=form.querySelector(".profile-api-key");
      const syncModelControls=()=>{
        const preset=presetById(presetSelect.value);
        const model=modelSelect.value==="__custom__"?customModel.value:modelSelect.value;
        const supports=supportsDeepSeekV4Thinking(preset.id,model);
        customModel.hidden=modelSelect.value!=="__custom__";
        if(thinking){thinking.hidden=!supports;thinkingSelect.disabled=!supports}
        if(reasoning){reasoning.hidden=!supports;reasoningSelect.disabled=!supports}
      };
      const populateModels=()=>{
        const preset=presetById(presetSelect.value);
        modelSelect.replaceChildren();
        [...preset.models,"__custom__"].forEach((model)=>{
          const option=document.createElement("option");
          option.value=model;
          option.textContent=model==="__custom__"?"自定义模型…":model;
          modelSelect.appendChild(option);
        });
        modelSelect.value=preset.defaultModel||"__custom__";
        if(baseUrl){baseUrl.value=preset.baseUrl||"";baseUrl.readOnly=preset.id!=="custom"}
        syncModelControls();
      };
      const syncCredentialMode=()=>{
        if(independentCredentials)independentCredentials.hidden=credentialMode?.value!=="independent";
      };
      presetSelect.addEventListener("change",()=>{
        populateModels();
        if(credentialMode?.value==="shared"&&sharedPreset&&sharedPreset.value!==presetSelect.value){
          sharedPreset.value=presetSelect.value;
          sharedPreset.dispatchEvent(new Event("change"));
        }
      });
      modelSelect.addEventListener("change",syncModelControls);
      customModel.addEventListener("input",syncModelControls);
      credentialMode?.addEventListener("change",syncCredentialMode);
      form.addEventListener("submit",()=>{
        if(credentialMode?.value==="shared"){
          if(sharedPreset)presetSelect.value=sharedPreset.value;
          if(profileApiKey&&sharedApiKey)profileApiKey.value=sharedApiKey.value;
        }
      });
      syncCredentialMode();
      syncModelControls();
    });
    sharedPreset?.addEventListener("change",()=>{
      document.querySelectorAll(".model-profile-form").forEach((form)=>{
        if(form.querySelector(".profile-credential-mode")?.value!=="shared")return;
        const presetSelect=form.querySelector(".profile-preset");
        if(presetSelect&&presetSelect.value!==sharedPreset.value){
          presetSelect.value=sharedPreset.value;
          presetSelect.dispatchEvent(new Event("change"));
        }
      });
    });
  }());</script>`;
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
  const inheritedWorkflowValidation = validateSearchPlan(plan, profile.profile, {
    validatePlatformCities: false
  });
  const planDependency = getSearchPlanDependency(db, planRecord.id);
  const versionDiff = compareProfileVersions(db, profile.id);
  const feedback = buildFeedbackSummary(db, { profileId: profile.id });
  const bossCatalog = getPlatformFilterCatalog(db, "boss")?.catalog;
  const bossRuntimeBlock = communicationRuntimeBlock(db);
  const workflowState = buildWorkflowDashboardState(db, planRecord);
  const scanDisabled = run.state === "running" || !validation.valid || planDependency.stale || planDependency.matchingCardRequired || Boolean(bossRuntimeBlock);
  const workflowStartDisabled = !inheritedWorkflowValidation.valid || planDependency.stale || planDependency.matchingCardRequired || Boolean(bossRuntimeBlock)
    || Boolean(workflowState.nextPlan?.scanNeeded && run.state === "running");
  const bossFilterPreview = bossCatalog ? resolveNativeFilterSnapshot({ site: "boss", catalog: bossCatalog, plan }) : null;
  const bossSalaryOptions = bossCatalog?.fields?.salary?.options?.map((option) => option.label) || [];
  const resumeButton = resumableBatch
    ? `<button data-scan-button name="resumeBatchId" value="${resumableBatch.id}"${scanDisabled ? " disabled" : ""}>继续未完成扫描 #${resumableBatch.id}</button>`
    : "";
  const selectedBossSalaryLanes = plan.platform?.salaryLanes?.length
    ? plan.platform.salaryLanes
    : bossFilterPreview?.lanes?.flatMap((lane) => lane.labels?.salary || []) || [];
  const confirmation = searchParams.get("saved") ? "筛选方案已保存。" : searchParams.get("created") ? "已根据你提供的简历生成画像和筛选建议，可直接开始扫描；只有需要调整时再编辑。" : searchParams.get("matchCardConfirmed") ? "匹配偏好卡已确认，将作为扫描与岗位匹配的依据，可直接开始扫描；只有需要调整时再编辑。" : "";
  const dependencyNotice = planDependency.stale ? `<section class="panel validation validation-error"><strong>方案需要重新确认</strong><p>画像已更新，但当前方案仍基于旧画像。检查下方条件并保存一次即可重新绑定；系统不会自动覆盖你的人工设置。</p></section>` : "";
  const matchingCardNotice = planDependency.matchingCardRequired
    ? `<section class="panel validation validation-error"><strong>尚未确认匹配偏好卡</strong><p>扫描和岗位匹配只依据已确认的匹配偏好卡。请到<a href="/match-card?profileId=${profile.id}${planDependency.draftCardId ? `&cardId=${planDependency.draftCardId}` : ""}">匹配偏好卡</a>检查并确认现有草稿；无需重新上传简历。</p></section>`
    : "";
  const riskControlNotice = bossRuntimeBlock
    ? `<section class="panel validation validation-error"><strong>BOSS 扫描已因安全验证暂停</strong><p>限制到期前不会创建扫描进程；此前已采集的岗位和详情不会丢失。</p><p class="error-code">${escapeHtml(bossRuntimeBlock.reasonCode)}${bossRuntimeBlock.blockedUntil ? ` · 恢复时间 ${escapeHtml(bossRuntimeBlock.blockedUntil)}` : ""}</p></section>`
    : "";
  const planStyle = '<style>.workflow-launch{margin:16px 0 20px;padding:18px 0;border-top:3px solid #176b5b;border-bottom:1px solid #cfd8dc}.workflow-launch-head{display:flex;justify-content:space-between;align-items:center;gap:18px}.workflow-kicker{margin:0 0 4px;color:#176b5b;font-size:12px;font-weight:700}.workflow-launch h2{font-size:20px;margin:0}.workflow-start{display:flex;align-items:center;gap:8px}.workflow-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:18px;border:1px solid #d4dde2}.workflow-metrics div{padding:11px 13px;border-right:1px solid #d4dde2}.workflow-metrics div:last-child{border-right:0}.workflow-metrics span{display:block;color:#5c6870;font-size:12px}.workflow-metrics strong{display:block;margin-top:4px;font-size:19px}.workflow-budget{margin-top:9px;color:#5c6870;font-size:13px}.workflow-primary{min-width:112px;text-align:center;background:#176b5b!important;border-color:#176b5b!important}.plan-settings>summary,.legacy-operations>summary{cursor:pointer;font-weight:600}.plan-settings .plan-form{margin-top:16px}.plan-form{max-width:none}.plan-form .choice-section{grid-column:1/-1;display:grid;gap:8px}.choice-list{display:flex;flex-wrap:wrap;gap:8px}.choice-item{display:flex!important;align-items:center;gap:6px;border:1px solid #d8dee4;border-radius:4px;padding:7px 9px;font-size:14px}.choice-item input{width:auto}.plan-note{grid-column:1/-1;margin:0;color:#57606a;font-size:13px}.plan-advanced{grid-column:1/-1;border-top:1px solid #d8dee4;padding-top:14px}.plan-advanced summary{cursor:pointer;font-weight:600}.plan-advanced-body{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:12px}.plan-advanced-body .wide{grid-column:1/-1}.legacy-operations .scan-panel{padding-top:12px}@media(max-width:760px){.workflow-launch-head{align-items:stretch;flex-direction:column}.workflow-start{display:grid}.workflow-metrics{grid-template-columns:1fr 1fr}.workflow-metrics div:nth-child(2){border-right:0}.workflow-metrics div:nth-child(-n+2){border-bottom:1px solid #d4dde2}.plan-advanced-body{grid-template-columns:1fr}.plan-advanced-body .wide{grid-column:auto}}</style>';
  return renderPage("筛选方案", `${planStyle}<main>
  <nav>${navLinks(`/plan?profileId=${profile.id}&planId=${planRecord.id}`)}</nav>
  <h1>筛选方案</h1>
  ${renderWorkflowLaunchPanel({ planRecord, workflowState, disabled: workflowStartDisabled })}
  ${confirmation ? `<p class="notice">${escapeHtml(confirmation)}</p>` : ""}
  ${dependencyNotice}
  ${matchingCardNotice}
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
  <details class="panel plan-settings"><summary>调整筛选条件</summary><form id="plan-form" class="plan-form" method="post" action="/api/plan">
    <input type="hidden" name="profileId" value="${profile.id}"><input type="hidden" name="planId" value="${planRecord.id}">
    <label class="wide">方案名称<input name="name" value="${escapeAttr(plan.name || "")}" required></label>
    <div class="choice-section"><strong>目标城市</strong><div class="choice-list">${renderPlanChoices("cities", PLAN_CITY_OPTIONS, plan.cities)}</div></div>
    <div class="choice-section"><strong>工作经验</strong><div class="choice-list">${renderPlanChoices("experience", PLAN_EXPERIENCE_OPTIONS, selectedExperience)}</div></div>
    <div class="choice-section"><strong>求职类型</strong><div class="choice-list">${renderPlanChoices("jobTypes", bossCatalog?.fields?.jobType?.options?.map((item) => item.label) || PLAN_JOB_TYPE_OPTIONS, plan.jobTypes)}</div></div>
    <div class="choice-section"><strong>学历筛选（可选，不选则不限制）</strong><div class="choice-list">${renderPlanChoices("degrees", bossCatalog?.fields?.degree?.options?.map((item) => item.label) || PLAN_DEGREE_OPTIONS, plan.degrees)}</div></div>
    <label>最低薪资（K）<input type="number" min="0" max="100" name="salaryMinK" value="${escapeAttr(plan.salary?.minK || "")}"></label>
    <label>最高薪资（K）<input type="number" min="0" max="100" name="salaryMaxK" value="${escapeAttr(plan.salary?.maxK || "")}"></label>
    ${bossSalaryOptions.length ? `<div class="choice-section"><strong>BOSS 薪资抓取档位</strong><div class="choice-list">${renderPlanChoices("platformSalaryLanes", bossSalaryOptions, selectedBossSalaryLanes)}</div></div>` : ""}
    <label>薪资策略<select name="salaryMode"><option value="wide"${plan.salaryMode !== "strict" ? " selected" : ""}>宽松排序，范围外保留</option><option value="strict"${plan.salaryMode === "strict" ? " selected" : ""}>严格范围，低于下限不推荐</option></select></label>
    <label>工作节奏<select name="workSchedulePreference"><option value="prefer_double_weekend"${plan.workSchedulePreference !== "no_preference" ? " selected" : ""}>优先双休，其他仍保留</option><option value="no_preference"${plan.workSchedulePreference === "no_preference" ? " selected" : ""}>不作为排序依据</option></select></label>
    <label class="wide">目标方向<input name="directions" value="${escapeAttr((plan.directions || []).join("，"))}" placeholder="例如：AI应用开发、RAG、Python后端"></label>
    <p class="plan-note">岗位质量会自动优先保留招聘方近 ${escapeHtml(plan.bossActiveDays)} 天活跃的岗位，并对超过经验范围但薪资偏初中级的岗位保留“可冲”标记。</p>
    <label class="wide">搜索关键词<textarea name="keywords" required>${escapeHtml(keywordLines(plan.keywords))}</textarea></label>
    <details class="plan-advanced"><summary>广泛扫描预算</summary><div class="plan-advanced-body"><label class="wide">排除词<input name="excludeWords" value="${escapeAttr((plan.excludeWords || []).join("，"))}"></label><label class="wide">硬排除词<input name="hardExcludes" value="${escapeAttr((plan.hardExcludes || []).join("，"))}"></label><label>A类每词岗位数<input type="number" min="${scanBounds.maxCards[0]}" max="${scanBounds.maxCards[1]}" name="maxCards" value="${escapeAttr(plan.scan.maxCards ?? scanDefaults.maxCards)}"></label><label>右栏详情安全上限<input type="number" min="${scanBounds.maxDetailTotal[0]}" max="${scanBounds.maxDetailTotal[1]}" name="maxDetailTotal" value="${escapeAttr(plan.scan.maxDetailTotal ?? scanDefaults.maxDetailTotal)}"></label><label>搜索页面安全上限<input type="number" min="${scanBounds.browserPageBudget[0]}" max="${scanBounds.browserPageBudget[1]}" name="browserPageBudget" value="${escapeAttr(plan.scan.browserPageBudget ?? scanDefaults.browserPageBudget)}"></label></div><p class="field-help">这些上限只控制低频广泛扫描。日常扫描会自动收敛到 A/B 关键词，主薪资档覆盖全部关键词，补充薪资档只覆盖最高优先关键词；每个 A 词最多 ${dailyScan.maxCards} 张主档卡片，补充档最多 ${dailyScan.supplementalSalaryLaneCardLimit} 张卡片和 ${dailyScan.supplementalSalaryLaneDetailLimit} 个右栏详情。两种模式都使用单标签串行、随机等待和风控即停。</p></details>
    <div class="wide"><button>保存筛选方案</button><span id="plan-dirty-note" class="hint" hidden> 条件有修改，请先保存再扫描。</span></div>
  </form></details>
  <details class="panel legacy-operations"><summary>高级扫描与维护</summary><section class="scan-panel">
    <div><strong>扫描状态：</strong>${escapeHtml(scanLabel(run, plan.bossActiveDays))}</div>
    <p class="field-help">日常扫描：${dailyScan.keywordPlan.length} 个 A/B 关键词，主薪资档全部覆盖，补充薪资档仅覆盖前 ${dailyScan.supplementalSalaryLaneKeywordLimit} 个关键词；A/B 主档每词最多 ${dailyScan.maxCards}/${dailyBCardLimit} 张卡片和 ${dailyScan.detailLimits.A}/${dailyScan.detailLimits.B} 个新详情，补充档最多 ${dailyScan.supplementalSalaryLaneCardLimit} 张卡片和 ${dailyScan.supplementalSalaryLaneDetailLimit} 个新详情，总详情预算 ${dailyScan.maxDetailTotal}。广泛扫描：${broadScan.keywordPlan.length} 个全部关键词、所有薪资档、详情最多 ${broadScan.maxDetailTotal} 个。</p>
    ${run.error ? `<pre class="scan-error">${escapeHtml(run.error)}</pre>` : ""}
    <form class="inline-form" method="post" action="/api/scan"><input type="hidden" name="planId" value="${planRecord.id}"><input type="hidden" name="cdpPort" value="9222"><select name="browserMode" title="浏览器模式"><option value="edge" selected>当前已登录 Edge（推荐）</option><option value="portable">项目专用 Edge（手动备用，需要独立登录）</option></select><button data-scan-button name="scanKind" value="daily"${scanDisabled ? " disabled" : ""}>日常扫描</button><button data-scan-button name="scanKind" value="broad"${scanDisabled ? " disabled" : ""}>广泛扫描</button>${resumeButton}<button data-scan-button name="scanKind" value="refresh"${scanDisabled ? " disabled" : ""}>补读缺失详情</button><button data-scan-button name="scanKind" value="activity"${scanDisabled ? " disabled" : ""}>更新过期活跃状态</button><a class="button-link" href="/queue?planId=${planRecord.id}">待处理队列</a><a class="button-link" href="/jobs?planId=${planRecord.id}&batch=latest">查看岗位</a></form>
  </section></details>
</main><script>(function(){const form=document.getElementById('plan-form');const note=document.getElementById('plan-dirty-note');if(!form)return;form.addEventListener('input',function(){document.querySelectorAll('[data-scan-button]').forEach(function(button){button.disabled=true});if(note)note.hidden=false});}());</script>${run.state === "running" ? `<script>setTimeout(()=>location.reload(),2500)</script>` : ""}`);
}

function renderWorkflowLaunchPanel({ planRecord, workflowState, disabled = false }) {
  const active = workflowState.activeRun;
  const next = workflowState.nextPlan;
  const target = active?.targetSuccessCount ?? next?.targetSuccessCount ?? 0;
  const action = active
    ? `<a class="button-link workflow-primary" href="/workflow?runId=${escapeAttr(active.id)}">继续本轮</a>`
    : next?.errorCode
      ? `<button class="workflow-primary" disabled>今日任务已结束</button>`
      : `<form class="workflow-start" method="post" action="/api/workflow-run">
          <input type="hidden" name="planId" value="${planRecord.id}">
          <input type="hidden" name="cdpPort" value="9222">
          <label>浏览器 <select name="browserMode"><option value="edge" selected>当前已登录 Edge（推荐）</option><option value="portable">项目专用 Edge（手动备用，需要独立登录）</option></select></label>
          <span class="hint">使用普通 Edge 中已登录的固定 BOSS 搜索页</span>
          <button
            class="workflow-primary"
            name="action"
            value="start"
            data-browser-readiness-button
            data-browser-base-disabled="${disabled ? "true" : "false"}"
            disabled>执行一轮</button>
        </form>`;
  const status = active ? workflowStatusLabel(active.status) : next?.errorCode ? workflowBlockedMessage(next.errorCode, next) : "可以开始新一轮";
  return `<section class="workflow-launch" aria-labelledby="workflow-launch-title">
    <div class="workflow-launch-head"><div><p class="workflow-kicker">今日求职任务</p><h2 id="workflow-launch-title">${escapeHtml(status)}</h2></div>${action}</div>
    <div class="workflow-metrics">
      <div><span>今日进度</span><strong>${workflowState.successfulToday} / ${workflowState.dailyTarget}</strong></div>
      <div><span>${active ? "本轮目标" : "下一轮目标"}</span><strong>${target}</strong></div>
      <div><span>可用候选</span><strong>${workflowState.inventory.length}</strong></div>
      <div><span>已用轮次</span><strong>${workflowState.slotsUsed} / ${workflowState.maxRuns}</strong></div>
    </div>
    <div class="workflow-budget">剩余详情读取预算 ${workflowState.remainingBudget.details} · 剩余搜索页预算 ${workflowState.remainingBudget.pages}${next?.shortfallReason ? ` · ${escapeHtml(workflowShortfallLabel(next.shortfallReason))}` : ""}</div>
    <div id="browser-readiness-status" class="workflow-budget" role="status">正在检查当前已登录 Edge 与固定 BOSS 页面状态…</div>
    <script>
    (function(){
      const statusNode = document.getElementById('browser-readiness-status');
      const button = document.querySelector('[data-browser-readiness-button]');
      const browserMode = document.querySelector('select[name=browserMode]');
      if (!statusNode || !button) return;
      const baseDisabled = button.dataset.browserBaseDisabled === 'true';
      let readinessInFlight = false;
      let queuedRefresh = false;
      let selectionVersion = 0;
      function readinessUrl() {
        const mode = browserMode?.value === 'portable' ? 'portable' : 'edge';
        const params = new URLSearchParams({browserMode:mode});
        if (mode === 'portable') params.set('cdpPort','9222');
        return '/api/browser-readiness?'+params.toString();
      }
      async function refreshReadiness({queueIfBusy=false}={}) {
        if (readinessInFlight) {
          if (queueIfBusy) queuedRefresh = true;
          return;
        }
        const requestVersion = selectionVersion;
        const requestUrl = readinessUrl();
        readinessInFlight = true;
        button.disabled = true;
        try {
          const response = await fetch(requestUrl, {cache:'no-store'});
          if (!response.ok) throw new Error('readiness request failed');
          const state = await response.json();
          if (requestVersion !== selectionVersion || requestUrl !== readinessUrl()) return;
          statusNode.textContent = state.message || '浏览器状态未知。';
          statusNode.dataset.status = state.status || 'unknown';
          button.disabled = baseDisabled || state.status !== 'ready';
        } catch {
          if (requestVersion !== selectionVersion || requestUrl !== readinessUrl()) return;
          statusNode.textContent = '无法确认当前已登录 Edge 状态，请检查本地服务。';
          statusNode.dataset.status = 'browser_unavailable';
          button.disabled = true;
        } finally {
          readinessInFlight = false;
          if (queuedRefresh || requestVersion !== selectionVersion || requestUrl !== readinessUrl()) {
            queuedRefresh = false;
            void refreshReadiness();
          }
        }
      }
      refreshReadiness();
      browserMode?.addEventListener('change', function(){selectionVersion+=1;void refreshReadiness({queueIfBusy:true})});
      setInterval(refreshReadiness, 5000);
    })();
    </script>
  </section>`;
}

function workflowStatusLabel(status) {
  return {
    created: "本轮已建立",
    scanning: "正在筛选岗位",
    analyzing: "正在分析岗位",
    paused: "本轮已暂停",
    review_required: "等待确认本轮清单",
    communicating: "正在沟通",
    interrupted: "本轮已中断，等待继续",
    completed: "本轮已完成",
    failed: "本轮未完成",
    stopped: "本轮已停止"
  }[status] || "本轮进行中";
}

function workflowShortfallLabel(code) {
  return {
    WORKFLOW_PROJECTED_SUPPLY_SHORTFALL: "预计候选可能不足，不会用明显弱岗位凑数",
    WORKFLOW_SCAN_BUDGET_EMPTY: "今日安全预算不足",
    WORKFLOW_NO_KEYWORDS: "没有可用搜索关键词"
  }[code] || "候选可能不足";
}

function workflowHealthFailureCode(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : "WORKFLOW_HEALTH_FAILED";
}

function renderInheritedScopeSummary(workflow) {
  if (workflow?.planner?.acquisitionMode !== "inherited") return "";
  const scope = workflow.planner.searchScope || {};
  const source = workflow.planner.keywordSource || {};
  const policy = workflow.planner.platformPolicy || {};
  const filters = (policy.filterSummary || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const keywords = (source.keywords || [])
    .map((item) => escapeHtml(item.word || "")).filter(Boolean).join("、");
  const unresolved = (policy.unresolvedParams || []).map((item) => item.param).filter(Boolean);
  return `<section class="workflow-scope">
    <strong>筛选来源：BOSS 当前页面</strong>
    <ul>${filters || "<li>使用平台默认筛选</li>"}</ul>
    <p>范围：${escapeHtml(scopeShortId(scope.key))} · 关键词来源：Search Plan #${escapeHtml(source.searchPlanId || "")}</p>
    <p>本轮关键词：${keywords || "无"}</p>
    ${unresolved.length ? `<p class="workflow-alert">未解析平台筛选：${escapeHtml(unresolved.join("、"))}；采集 URL 已保留这些条件，本地不会猜值。</p>` : ""}
    <p class="hint">修改 BOSS 筛选会创建新的统计范围；本轮恢复仍使用当前冻结范围。</p>
  </section>`;
}

function renderWorkflowPage({ db, searchParams, logger = null, workflowHealth }) {
  const workflowRunId = searchParams.get("runId");
  const recovery = recoverWorkflowRuns(db, {
    workflowRunId,
    orphanTimeoutMs: PRODUCT_POLICY.operations.scanOrphanTimeoutMs
  });
  if ((recovery.scanRunsInterrupted || recovery.workflowRunsInterrupted || recovery.workflowRunsCompleted) && logger) {
    logger.warn("workflow_page_reconciled", { workflowRunId, ...recovery });
  }
  let workflow = getWorkflowRun(db, workflowRunId);
  if (!workflow) return renderErrorPage("本轮任务不存在。", "/plan", { code: "WORKFLOW_RUN_NOT_FOUND" });
  if (["review_required", "interrupted"].includes(workflow.status)) {
    reconcilePlanWorkflowInventory(db, workflow.planId);
    workflow = getWorkflowRun(db, workflowRunId);
  }
  const plan = getSearchPlan(db, workflow.planId);
  if (!plan) return renderErrorPage("本轮任务对应的筛选方案不存在。", "/plan", { code: "WORKFLOW_PLAN_NOT_FOUND" });
  const daily = buildWorkflowDashboardState(db, plan);
  const communication = workflow.communicationBatchId ? communicationStatus(db, workflow.communicationBatchId) : null;
  const runtimeBlock = communicationRuntimeBlock(db);
  const phase = renderWorkflowPhase({ db, workflow, plan, daily, communication, runtimeBlock });
  const progressSnapshot = getWorkflowProgressSnapshot(db, {
    workflowRunId: workflow.id
  });
  const progressPanel = progressSnapshot
    ? renderWorkflowProgressPanel({
        snapshot: progressSnapshot,
        workflow,
        stopPreview: workflowStopPreview(db, { workflowRunId: workflow.id })
      })
    : "";
  let healthPanel = "";
  try {
    const snapshot = workflowHealth.getSnapshot(db, {
      profileId: plan.profileId,
      planId: plan.id,
      now: new Date().toISOString()
    });
    healthPanel = workflowHealth.renderPanel(workflowHealth.buildReport(snapshot));
  } catch (error) {
    logger?.warn("workflow_health_render_failed", {
      workflowRunId: workflow.id,
      planId: plan.id,
      errorCode: workflowHealthFailureCode(error)
    });
  }
  const incrementalProgress = ["created", "scanning", "analyzing", "paused"].includes(workflow.status);
  const polling = incrementalProgress
    ? workflowProgressClientScript({
        runId: workflow.id,
        initialRevision: progressSnapshot?.workflow?.progressRevision || 0,
        initialStatus: progressSnapshot?.workflow?.status || workflow.status,
        initialControlState: progressSnapshot?.workflow?.controlState || workflow.controlState
      })
    : shouldPollWorkflow(workflow, communication)
      ? `<script>(function(){const initial=${JSON.stringify(workflowPollKey(workflow, communication))};const timer=setInterval(async function(){try{const response=await fetch('/api/workflow-status?runId=${encodeURIComponent(workflow.id)}',{cache:'no-store'});if(!response.ok)return;const data=await response.json();const counts=data.communication?.summary?.statusCounts||{};const next=[data.workflow.status,data.communication?.batch?.status||'',data.workflow.successfulCount,counts.succeeded||0,counts.already_communicated||0,data.communication?.summary?.terminal||0].join('|');if(next!==initial){clearInterval(timer);location.reload()}}catch{}},2500)}());</script>`
      : "";
  const style = `<style>
    .workflow-shell{max-width:1040px}.workflow-head{padding:18px 0;border-top:3px solid #176b5b;border-bottom:1px solid #ccd7dc}.workflow-headline{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.workflow-head h1{margin:2px 0 0}.workflow-sequence{margin:0;color:#176b5b;font-size:12px;font-weight:700}.workflow-progress{display:flex;flex-wrap:wrap;gap:18px;margin-top:14px;color:#46545e;font-size:13px}.workflow-progress strong{color:#202b33;font-size:17px}.workflow-scope{max-width:100%;min-width:0;padding:14px 0;border-bottom:1px solid #ccd7dc;overflow-wrap:anywhere;word-break:break-word}.workflow-scope ul{margin:8px 0;padding-left:20px}.workflow-scope p{margin:8px 0}.workflow-phase{padding:18px 0}.workflow-phase h2{font-size:18px}.workflow-actions{display:flex;flex-wrap:wrap;gap:9px;align-items:center;margin:14px 0}.workflow-list{border-top:1px solid #d4dde2}.workflow-job{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:10px;align-items:start;padding:12px 4px;border-bottom:1px solid #d4dde2}.workflow-job input{width:18px;height:18px;margin-top:2px}.workflow-job-main strong{font-size:15px}.workflow-job-meta,.workflow-job-reason,.workflow-job-evidence{margin-top:4px;color:#5a6871;font-size:13px;line-height:1.45}.workflow-job-evidence{display:block}.workflow-tier{padding:3px 7px;border:1px solid #aab9c2;border-radius:4px;background:#f5f8f9;color:#37454f;font-size:12px;white-space:nowrap}.workflow-tier.primary{border-color:#77a99d;background:#e9f4f1;color:#155f54}.workflow-tier.apply{border-color:#9cbcdc;background:#eef4fa;color:#245b87}.workflow-tier.caution{border-color:#d7b66a;background:#fff7e5;color:#795817}.workflow-sticky{position:sticky;bottom:0;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 4px;background:rgba(246,247,249,.97);border-top:1px solid #bfcbd2}.workflow-status-table{width:100%;border-collapse:collapse}.workflow-status-table th,.workflow-status-table td{padding:8px;border-bottom:1px solid #d8e0e5;text-align:left}.workflow-alert{padding:10px 12px;border-left:3px solid #b42318;background:#fff1f0;color:#8b3029}.workflow-done{border-left:3px solid #176b5b;padding:10px 12px;background:#edf7f4}@media(max-width:700px){.workflow-headline{display:block}.workflow-job{grid-template-columns:28px minmax(0,1fr)}.workflow-tier{grid-column:2}.workflow-sticky{align-items:stretch;flex-direction:column}.workflow-sticky button{width:100%}}
    .workflow-live{padding:20px 0;border-bottom:1px solid #ccd7dc}.workflow-live-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.workflow-stage{margin:0;color:#176b5b;font-size:13px;font-weight:700}.workflow-live h2{margin:4px 0 0;font-size:21px}.workflow-model{margin:0;color:#5a6871;font-size:13px}.workflow-meter{width:100%;height:10px;margin:15px 0 17px;accent-color:#176b5b}.workflow-analysis-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:1px;background:#d8e0e5;border:1px solid #d8e0e5;border-radius:7px;overflow:hidden}.workflow-stat{padding:12px;background:#fff}.workflow-stat span{display:block;color:#5a6871;font-size:12px}.workflow-stat strong{display:block;margin-top:4px;font-size:20px}.workflow-live-meta{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-top:12px}.workflow-live-card{padding:12px 14px;border:1px solid #d8e0e5;border-radius:7px;background:#fff}.workflow-live-card h3{margin:0 0 7px;font-size:13px}.workflow-live-card p{margin:5px 0;color:#46545e;font-size:13px;line-height:1.5}.workflow-control-area{margin-top:14px}.workflow-control-group{display:flex;flex-wrap:wrap;gap:9px;align-items:center}.workflow-control-group[hidden],.workflow-stop-confirmation[hidden],.workflow-inline-error[hidden],.workflow-stale[hidden]{display:none}.workflow-control-group form{margin:0}.workflow-stop{border-color:#b42318;background:#fff;color:#9a332b}.workflow-stop-confirmation{margin-top:12px;padding:13px 14px;border:1px solid #e1b2ae;border-radius:7px;background:#fff7f6}.workflow-stop-confirmation h3{margin:0 0 8px;font-size:15px}.workflow-stop-confirmation p{margin:5px 0}.workflow-inline-error,.workflow-stale{margin-top:12px;padding:10px 12px;border-left:3px solid #b42318;background:#fff1f0;color:#8b3029}.workflow-stale{border-left-color:#bf8700;background:#fff8e5;color:#765a16}.workflow-control-group button:focus-visible,.workflow-control-group a:focus-visible{outline:3px solid #7cb9e8;outline-offset:2px}
    @media(max-width:760px){.workflow-live-head{display:block}.workflow-model{margin-top:7px}.workflow-analysis-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.workflow-live-meta{grid-template-columns:1fr}.workflow-control-group{align-items:stretch;flex-direction:column}.workflow-control-group form,.workflow-control-group button,.workflow-control-group a{width:100%}}
  </style>`;
  return renderPage("执行一轮", `${style}<main class="workflow-shell"><nav>${navLinks(`/plan?planId=${plan.id}`)}<a href="/workflow?runId=${escapeAttr(workflow.id)}">本轮</a></nav>
    <header class="workflow-head"><div class="workflow-headline"><div><p class="workflow-sequence">第 ${workflow.sequence} 轮 · ${escapeHtml(workflow.localDay)}</p><h1>${escapeHtml(workflowStatusLabel(workflow.status))}</h1></div><a href="/plan?planId=${plan.id}">返回筛选方案</a></div>
      <div class="workflow-progress"><span>本轮目标 <strong>${workflow.targetSuccessCount}</strong></span><span>本轮成功 <strong>${workflow.successfulCount}</strong></span><span>今日进度 <strong>${daily.successfulToday} / ${daily.dailyTarget}</strong></span><span>有效候选 <strong>${workflow.inventoryCount}</strong></span></div>
    </header>${renderInheritedScopeSummary(workflow)}${healthPanel}${progressPanel}${phase}</main>${polling}`);
}

function renderWorkflowProgressPanel({ snapshot, workflow, stopPreview }) {
  const analysis = snapshot.progress.analysis;
  const completed = analysis.succeeded + analysis.failed + analysis.skipped + analysis.stopped;
  const remaining = analysis.pending + analysis.running + analysis.retryPending;
  const runningVisible = ["created", "scanning", "analyzing"].includes(snapshot.workflow.status);
  const pausedVisible = snapshot.workflow.status === "paused";
  const recentActivity = snapshot.recentActivity.length
    ? snapshot.recentActivity.map(workflowActivityLabel).join("；")
    : "还没有新的分析活动。";
  const modelLabel = [snapshot.model.provider, snapshot.model.model].filter(Boolean).join(" · ")
    || "批量模型待记录";
  const pauseReason = workflow.errorCode || "本轮已安全暂停";
  const slotLabel = stopPreview.consumesRunSlot ? "会占用今天一轮" : "不会占用今天一轮";
  const access = stopPreview.access || {};
  const controlIdentity = `<input type="hidden" name="workflowRunId" value="${escapeAttr(workflow.id)}">`;
  return `<section class="workflow-live" data-workflow-panel data-progress-revision="${snapshot.workflow.progressRevision}">
    <div class="workflow-live-head">
      <div aria-live="polite">
        <p class="workflow-stage" data-stage-label>第 ${snapshot.progress.stageIndex} 阶段 / 共 ${snapshot.progress.stageCount} 阶段</p>
        <h2 data-stage-name>${escapeHtml(snapshot.progress.stage)}</h2>
      </div>
      <p class="workflow-model">${escapeHtml(modelLabel)}</p>
    </div>
    <progress class="workflow-meter" data-analysis-progress aria-label="岗位分析完成进度" max="${Math.max(1, analysis.total)}" value="${completed}">${completed} / ${analysis.total}</progress>
    <div class="workflow-analysis-grid" aria-label="岗位分析数量">
      ${workflowProgressStat("总数", analysis.total, "data-analysis-total")}
      ${workflowProgressStat("成功", analysis.succeeded, "data-analysis-succeeded")}
      ${workflowProgressStat("处理中", analysis.running, "data-analysis-running")}
      ${workflowProgressStat("等待重试", analysis.retryPending, "data-analysis-retry-pending")}
      ${workflowProgressStat("待补详情", analysis.detailRequired, "data-analysis-detail-required")}
      ${workflowProgressStat("失败", analysis.failed, "data-analysis-failed")}
      ${workflowProgressStat("剩余", remaining, "data-analysis-remaining")}
    </div>
    <div class="workflow-live-meta">
      <section class="workflow-live-card" aria-labelledby="workflow-timeout-heading">
        <h3 id="workflow-timeout-heading">超时保护</h3>
        <p data-analysis-timeouts>当前恢复周期最终超时 ${analysis.circuitTimeoutJobs} / ${analysis.timeoutPauseThreshold} · 本轮累计超时 ${analysis.lifetimeTimeoutJobs}</p>
        <p data-eta>${escapeHtml(workflowEtaLabel(snapshot.progress.eta))}</p>
      </section>
      <section class="workflow-live-card" aria-labelledby="workflow-activity-heading">
        <h3 id="workflow-activity-heading">最近活动</h3>
        <p data-recent-activity aria-live="polite">${escapeHtml(recentActivity)}</p>
      </section>
    </div>
    <p class="workflow-stale" data-workflow-stale hidden>任务可能失去活动，请先检查诊断信息，不要重复启动。</p>
    <p class="workflow-inline-error" data-workflow-error role="alert" hidden>无法读取任务状态</p>
    <div class="workflow-control-area">
      <div class="workflow-control-group" data-control-group="running"${runningVisible ? "" : " hidden"}>
        <form method="post" action="/api/workflow-control" data-workflow-control-form>${controlIdentity}<button data-workflow-control data-action="pause" name="action" value="pause"${snapshot.controls.canPause ? "" : " disabled"}>暂停本轮</button></form>
        <button class="workflow-stop" type="button" data-workflow-control data-action="stop-preview"${snapshot.controls.canStop ? "" : " disabled"}>结束本轮…</button>
      </div>
      <div class="workflow-control-group" data-control-group="paused"${pausedVisible ? "" : " hidden"}>
        <strong>本轮已暂停</strong>
        <span data-pause-reason>${escapeHtml(pauseReason)}</span>
        <a class="button-link" href="/settings#model-profile-batch_screening">测试批量模型连接</a>
        <a class="button-link" href="/settings#model-profile-batch_screening">调整批量模型</a>
        <form method="post" action="/api/workflow-control" data-workflow-control-form>${controlIdentity}<button data-workflow-control data-action="resume" name="action" value="resume"${snapshot.controls.canResume ? "" : " disabled"}>继续本轮</button></form>
        <button class="workflow-stop" type="button" data-workflow-control data-action="stop-preview"${snapshot.controls.canStop ? "" : " disabled"}>结束本轮…</button>
      </div>
      <section class="workflow-stop-confirmation" data-stop-confirmation hidden>
        <h3>确认结束本轮</h3>
        <p>已采集 <span data-stop-collected>${stopPreview.collected}</span> · 已分析 <span data-stop-analyzed>${stopPreview.analyzed}</span> · 失败 <span data-stop-failed>${stopPreview.failed}</span> · 未完成 <span data-stop-unfinished>${stopPreview.unfinished}</span></p>
        <p>网页预算：详情 ${Number(access.details || 0)} · 页面 ${Number(access.pages || 0)} · 滚动 ${Number(access.scrolls || 0)}</p>
        <p><strong data-stop-slot>${slotLabel}</strong>。结束后不能继续，已保存结果会保留。</p>
        <div class="workflow-control-group">
          <form method="post" action="/api/workflow-control" data-workflow-control-form>${controlIdentity}<input type="hidden" name="action" value="stop"><input type="hidden" name="confirmStop" value="1"><button class="workflow-stop" data-workflow-control data-action="stop-confirm">确认结束本轮</button></form>
          <button type="button" data-action="stop-cancel">取消</button>
        </div>
      </section>
    </div>
  </section>`;
}

function workflowProgressStat(label, value, hook) {
  return `<div class="workflow-stat"><span>${escapeHtml(label)}</span><strong ${hook}>${Number(value || 0)}</strong></div>`;
}

function workflowActivityLabel(activity = {}) {
  const action = {
    analysis_started: "开始分析",
    analysis_succeeded: "已成功保存",
    analysis_failed: "分析失败",
    analysis_skipped: "已按本地规则处理",
    waiting_lease_expiry: "正在等待安全收尾",
    control_requested: "正在执行控制请求"
  }[activity.type] || "状态已更新";
  const attempt = activity.attempt ? `，第 ${Number(activity.attempt)} 次尝试` : "";
  const role = activity.modelRole === "backup" ? "，备用模型" : "";
  const error = activity.errorCode ? `，${activity.errorCode}` : "";
  return `任务 #${Number(activity.taskId || 0)} ${action}${attempt}${role}${error}`;
}

function workflowEtaLabel(eta = {}) {
  if (eta.status === "available") {
    return `预计剩余 ${workflowDurationLabel(eta.minSeconds)}～${workflowDurationLabel(eta.maxSeconds)}（基于最近 ${Number(eta.sampleSize || 0)} 个完成岗位估算）`;
  }
  if (eta.status === "paused") {
    if (eta.minSeconds == null || eta.maxSeconds == null) return "已暂停；样本不足，正在估算";
    return `已暂停；剩余区间冻结为 ${workflowDurationLabel(eta.minSeconds)}～${workflowDurationLabel(eta.maxSeconds)}（${Number(eta.sampleSize || 0)} 个样本）`;
  }
  if (eta.status === "estimating") return "正在估算";
  return "当前阶段不估算剩余时间";
}

function workflowDurationLabel(seconds) {
  const value = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (value < 60) return `${value} 秒`;
  if (value < 3600) return `${Math.ceil(value / 60)} 分钟`;
  const hours = Math.floor(value / 3600);
  const minutes = Math.ceil((value % 3600) / 60);
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

function workflowProgressClientScript({
  runId,
  initialRevision,
  initialStatus,
  initialControlState
}) {
  const staleThresholdMs = Math.max(
    30000,
    Number(PRODUCT_POLICY.operations.scanOrphanTimeoutMs || 120000)
  );
  const initialKey = [
    Number(initialRevision || 0),
    initialStatus || "",
    initialControlState || ""
  ].join("|");
  return `<script data-workflow-progress-client>(function(){
    const runId=${JSON.stringify(String(runId || ""))};
    const staleThresholdMs=${staleThresholdMs};
    let lastKey=${JSON.stringify(initialKey)};
    let pollInFlight=false;
    let timer=null;
    const terminalStates=new Set(["review_required","completed","failed","stopped"]);
    const panel=document.querySelector("[data-workflow-panel]");
    if(!panel)return;
    const node=(selector)=>panel.querySelector(selector);
    const nodes=(selector)=>Array.from(panel.querySelectorAll(selector));
    const setText=(selector,value)=>{const target=node(selector);if(target)target.textContent=String(value)};
    const duration=(seconds)=>{const value=Math.max(0,Math.ceil(Number(seconds)||0));if(value<60)return value+" 秒";if(value<3600)return Math.ceil(value/60)+" 分钟";const hours=Math.floor(value/3600);const minutes=Math.ceil((value%3600)/60);return minutes?hours+" 小时 "+minutes+" 分钟":hours+" 小时"};
    const etaText=(eta)=>{if(eta.status==="available")return "预计剩余 "+duration(eta.minSeconds)+"～"+duration(eta.maxSeconds)+"（基于最近 "+Number(eta.sampleSize||0)+" 个完成岗位估算）";if(eta.status==="paused")return eta.minSeconds==null||eta.maxSeconds==null?"已暂停；样本不足，正在估算":"已暂停；剩余区间冻结为 "+duration(eta.minSeconds)+"～"+duration(eta.maxSeconds)+"（"+Number(eta.sampleSize||0)+" 个样本）";if(eta.status==="estimating")return "正在估算";return "当前阶段不估算剩余时间"};
    const activityText=(activity)=>{const labels={analysis_started:"开始分析",analysis_succeeded:"已成功保存",analysis_failed:"分析失败",analysis_skipped:"已按本地规则处理",waiting_lease_expiry:"正在等待安全收尾",control_requested:"正在执行控制请求"};const action=labels[activity.type]||"状态已更新";const attempt=activity.attempt?"，第 "+Number(activity.attempt)+" 次尝试":"";const role=activity.modelRole==="backup"?"，备用模型":"";const error=activity.errorCode?"，"+String(activity.errorCode):"";return "任务 #"+Number(activity.taskId||0)+" "+action+attempt+role+error};
    const setControlsDisabled=(disabled)=>{nodes("[data-workflow-control]").forEach((button)=>{button.disabled=Boolean(disabled)})};
    const renderWorkflowError=(message)=>{const error=node("[data-workflow-error]");if(error){error.textContent=message||"无法读取任务状态";error.hidden=false}setControlsDisabled(true)};
    const clearWorkflowError=()=>{const error=node("[data-workflow-error]");if(error)error.hidden=true};
    const renderActivityHealth=(workflow)=>{const warning=node("[data-workflow-stale]");if(!warning)return;const at=Date.parse(workflow.lastActivityAt||"");const active=["created","scanning","analyzing"].includes(workflow.status);warning.hidden=!(active&&Number.isFinite(at)&&Date.now()-at>staleThresholdMs)};
    const renderWorkflowProgress=(snapshot)=>{const analysis=snapshot.progress.analysis;const remaining=Number(analysis.pending||0)+Number(analysis.running||0)+Number(analysis.retryPending||0);const detailRequired=Number(analysis.detailRequired||0);const analyzed=Number(analysis.succeeded||0)+Math.max(0,Number(analysis.skipped||0)-detailRequired);const completed=analyzed+detailRequired+Number(analysis.failed||0)+Number(analysis.stopped||0);setText("[data-stage-label]","第 "+Number(snapshot.progress.stageIndex)+" 阶段 / 共 "+Number(snapshot.progress.stageCount)+" 阶段");setText("[data-stage-name]",snapshot.progress.stage);setText("[data-analysis-total]",analysis.total);setText("[data-analysis-succeeded]",analysis.succeeded);setText("[data-analysis-running]",analysis.running);setText("[data-analysis-retry-pending]",analysis.retryPending);setText("[data-analysis-detail-required]",detailRequired);setText("[data-analysis-failed]",analysis.failed);setText("[data-analysis-remaining]",remaining);setText("[data-analysis-timeouts]","当前恢复周期最终超时 "+Number(analysis.circuitTimeoutJobs||0)+" / "+Number(analysis.timeoutPauseThreshold||10)+" · 本轮累计超时 "+Number(analysis.lifetimeTimeoutJobs||0));setText("[data-eta]",etaText(snapshot.progress.eta));setText("[data-recent-activity]",snapshot.recentActivity.length?snapshot.recentActivity.map(activityText).join("；"):"还没有新的分析活动。");setText("[data-stop-collected]",analysis.total);setText("[data-stop-analyzed]",analyzed);setText("[data-stop-failed]",analysis.failed);setText("[data-stop-unfinished]",remaining);setText("[data-stop-slot]",snapshot.controls.stopConsumesRunSlot?"会占用今天一轮":"不会占用今天一轮");const progress=node("[data-analysis-progress]");if(progress){progress.max=Math.max(1,Number(analysis.total||0));progress.value=completed}panel.dataset.progressRevision=String(snapshot.workflow.progressRevision);renderActivityHealth(snapshot.workflow)};
    const renderWorkflowControls=(snapshot)=>{const paused=snapshot.workflow.status==="paused";const running=["created","scanning","analyzing"].includes(snapshot.workflow.status);const runningGroup=node('[data-control-group="running"]');const pausedGroup=node('[data-control-group="paused"]');if(runningGroup)runningGroup.hidden=!running;if(pausedGroup)pausedGroup.hidden=!paused;const pause=node('[data-action="pause"]');const resume=node('[data-action="resume"]');const stopConfirm=node('[data-action="stop-confirm"]');nodes('[data-action="stop-preview"]').forEach((button)=>{button.disabled=!snapshot.controls.canStop});if(pause)pause.disabled=!snapshot.controls.canPause;if(resume)resume.disabled=!snapshot.controls.canResume;if(stopConfirm)stopConfirm.disabled=!snapshot.controls.canStop;if(paused)setText("[data-pause-reason]",snapshot.workflow.errorCode||"本轮已安全暂停");if(terminalStates.has(snapshot.workflow.status)){setControlsDisabled(true);if(timer)clearInterval(timer)}};
    const validSnapshot=(snapshot)=>Boolean(snapshot&&snapshot.workflow&&snapshot.progress&&snapshot.progress.analysis&&snapshot.progress.eta&&snapshot.controls&&Array.isArray(snapshot.recentActivity));
    const pollWorkflowStatus=async()=>{if(pollInFlight)return;pollInFlight=true;try{const response=await fetch("/api/workflow-status?runId="+encodeURIComponent(runId),{cache:"no-store"});if(!response.ok)throw new Error("status response");const snapshot=await response.json();if(!validSnapshot(snapshot))throw new Error("status payload");clearWorkflowError();renderWorkflowControls(snapshot);const nextKey=[Number(snapshot.workflow.progressRevision||0),snapshot.workflow.status||"",snapshot.workflow.controlState||""].join("|");renderActivityHealth(snapshot.workflow);if(nextKey===lastKey)return;lastKey=nextKey;renderWorkflowProgress(snapshot)}catch(error){renderWorkflowError("无法读取任务状态")}finally{pollInFlight=false}};
    nodes("[data-workflow-control-form]").forEach((form)=>form.addEventListener("submit",()=>setControlsDisabled(true)));
    nodes('[data-action="stop-preview"]').forEach((button)=>button.addEventListener("click",()=>{const confirmation=node("[data-stop-confirmation]");if(confirmation){confirmation.hidden=false;node('[data-action="stop-confirm"]')?.focus()}}));
    node('[data-action="stop-cancel"]')?.addEventListener("click",()=>{const confirmation=node("[data-stop-confirmation]");if(confirmation)confirmation.hidden=true});
    timer=setInterval(pollWorkflowStatus,2500);
  }());</script>`;
}

function renderWorkflowPhase({ db, workflow, plan, daily, communication, runtimeBlock }) {
  if (["created", "scanning", "analyzing", "paused"].includes(workflow.status)) return "";
  if (workflow.status === "review_required") {
    if (communication) return renderConfirmedWorkflowCommunication(workflow, communication, runtimeBlock);
    return renderWorkflowReview({ db, workflow, plan, runtimeBlock });
  }
  if (workflow.status === "communicating") {
    return renderRunningWorkflowCommunication(workflow, communication, runtimeBlock);
  }
  if (workflow.status === "completed") {
    const shortfall = workflow.shortfallCode
      ? `<p class="hint">${workflow.shortfallCode === "WORKFLOW_SUPPLY_EXHAUSTED" ? "本轮可用候选已处理完，没有用弱岗位凑数。" : escapeHtml(workflow.shortfallCode)}</p>`
      : "";
    return `<section class="workflow-phase"><div class="workflow-done"><h2>本轮已完成</h2><p>本轮成功 ${workflow.successfulCount}，今日进度 ${daily.successfulToday} / ${daily.dailyTarget}。</p>${shortfall}</div><div class="workflow-actions"><a class="button-link" href="/plan?planId=${plan.id}">返回今日任务</a><a class="button-link" href="/queue?planId=${plan.id}">查看岗位记录</a></div></section>`;
  }
  if (workflow.status === "interrupted") {
    const communicationReview = workflow.communicationBatchId
      ? `<a class="button-link" href="/communication?batchId=${workflow.communicationBatchId}">检查沟通中断项</a>`
      : renderWorkflowResumeForm(workflow);
    return `<section class="workflow-phase"><div class="workflow-alert"><strong>本轮已中断</strong><p>${escapeHtml(workflow.errorCode || "WORKFLOW_INTERRUPTED")} · ${escapeHtml(workflow.errorMessage || "请检查诊断后继续。")}</p></div><div class="workflow-actions">${communicationReview}</div></section>`;
  }
  return `<section class="workflow-phase"><div class="workflow-alert"><strong>${escapeHtml(workflowStatusLabel(workflow.status))}</strong><p>${escapeHtml(workflow.errorCode || workflow.shortfallCode || "本轮已经结束。")}</p></div><div class="workflow-actions"><a class="button-link" href="/plan?planId=${plan.id}">返回今日任务</a></div></section>`;
}

function renderWorkflowResumeForm(workflow) {
  const identity = `<input type="hidden" name="workflowRunId" value="${escapeAttr(workflow.id)}">`;
  if (workflow.planner?.acquisitionMode === "inherited") {
    const browserMode = resolveWorkflowResumeBrowserMode(workflow);
    const label = browserMode === "portable"
      ? "使用项目专用 Edge 的 BOSS 搜索页"
      : "使用当前已登录 Edge 中的固定 BOSS 搜索页";
    const cdpPort = browserMode === "portable" ? `<input type="hidden" name="cdpPort" value="${PORTABLE_CDP_PORT}">` : "";
    return `<form method="post" action="/api/workflow-run/resume">${identity}${cdpPort}<input type="hidden" name="browserMode" value="${browserMode}"><span class="hint">${label}</span><button>继续本轮</button></form>`;
  }
  const selectedMode = resolveWorkflowResumeBrowserMode(workflow);
  const edgeSelected = selectedMode === "edge" ? " selected" : "";
  const portableSelected = selectedMode === "portable" ? " selected" : "";
  return `<form method="post" action="/api/workflow-run/resume">${identity}<select name="browserMode"><option value="edge"${edgeSelected}>当前已登录 Edge</option><option value="portable"${portableSelected}>项目专用 Edge</option></select><button>继续本轮</button></form>`;
}

function renderWorkflowReview({ db, workflow, plan, runtimeBlock }) {
  const candidates = listWorkflowReviewCandidates(db, workflow.id);
  const quota = communicationQuota(db);
  const browserMode = String(
    workflow.planner?.browserMode
      || (workflow.planner?.acquisitionMode === "inherited" ? "edge" : "portable")
  ).trim().toLowerCase();
  const defaultCount = candidates.filter((candidate) => candidate.defaultChecked).length;
  const rows = candidates.map((job) => {
    const fitReason = (job.analysis?.fitReasons || []).slice(0, 2).join("；") || (job.matches || []).slice(0, 3).join("、") || "匹配证据已保存";
    const hardBlockers = hardBlockerLabels(job.analysis);
    const hardBlockerNote = hardBlockers.length ? `<span class="workflow-job-reason">硬性限制：${escapeHtml(hardBlockers.join("；"))}</span>` : "";
    return `<label class="workflow-job"><input type="checkbox" name="jobIds" value="${job.id}"${job.defaultChecked ? " checked" : ""}><span class="workflow-job-main"><strong><a href="${escapeAttr(job.url)}" target="_blank" rel="noreferrer">${escapeHtml(job.title)}</a></strong><span class="workflow-job-meta">${escapeHtml(job.company || "")} · ${escapeHtml(job.salary || "薪资待确认")} · ${escapeHtml(job.experience || "经验待确认")} · ${escapeHtml(compactScheduleLabel(job.analysis))}</span>${renderRoleEvidenceSummary(job.analysis, "workflow-job-evidence")}<span class="workflow-job-reason">${escapeHtml(fitReason)}</span>${hardBlockerNote}</span><span class="workflow-tier ${workflowTierClass(job.workflowTier)}">${escapeHtml(workflowTierLabel(job.workflowTier))}</span></label>`;
  }).join("") || `<p class="hint">本轮没有满足有效期、详情和匹配证据要求的候选。</p>`;
  const blocked = Boolean(runtimeBlock) || quota.remaining <= 0 || defaultCount === 0 || defaultCount > quota.remaining;
  return `<section class="workflow-phase"><h2>确认本轮沟通清单</h2><p class="hint">本轮成功目标 ${workflow.targetSuccessCount}；主投和可投默认勾选 ${defaultCount} 个，包含补位项。慎投仅展示，需人工决定是否勾选。</p>${runtimeBlock ? `<div class="workflow-alert">${escapeHtml(runtimeBlock.reasonCode)}${runtimeBlock.blockedUntil ? ` · ${escapeHtml(runtimeBlock.blockedUntil)}` : ""}</div>` : ""}<form id="workflow-review-form" method="post" action="/api/communication-batch"><input type="hidden" name="workflowRunId" value="${escapeAttr(workflow.id)}"><input type="hidden" name="planId" value="${plan.id}"><input type="hidden" name="browserMode" value="${escapeAttr(browserMode)}"><div class="workflow-list">${rows}</div><div class="workflow-sticky"><span>已选 <output id="workflow-selected-count">${defaultCount}</output> 个 · 今日剩余额度 ${quota.remaining}</span><button id="workflow-confirm"${blocked ? " disabled" : ""}>确认清单</button></div></form></section><script>(function(){const form=document.getElementById('workflow-review-form');const output=document.getElementById('workflow-selected-count');const confirm=document.getElementById('workflow-confirm');if(!form)return;const limit=${quota.remaining};const fixedBlocked=${Boolean(runtimeBlock)};const update=()=>{const count=form.querySelectorAll('input[name="jobIds"]:checked').length;output.value=count;confirm.disabled=fixedBlocked||count===0||count>limit};form.addEventListener('change',update);update()}());</script>`;
}

function renderConfirmedWorkflowCommunication(workflow, communication, runtimeBlock) {
  const batch = communication.batch;
  const action = batch.status === "confirmed" ? "start" : ["paused", "interrupted"].includes(batch.status) ? "resume" : "";
  const actionLabel = action === "resume" ? "继续沟通" : "开始沟通";
  const control = action && communication.calibration.executionEnabled && !runtimeBlock
    ? `<form method="post" action="/api/communication-control"><input type="hidden" name="batchId" value="${batch.id}"><button name="action" value="${action}">${actionLabel}</button></form>`
    : "";
  return `<section class="workflow-phase"><h2>清单已确认</h2><p>已选择 ${communication.summary.total} 个岗位，本轮成功目标 ${workflow.targetSuccessCount}。</p>${runtimeBlock ? `<div class="workflow-alert">${escapeHtml(runtimeBlock.reasonCode)}</div>` : ""}<div class="workflow-actions">${control}<a class="button-link" href="/communication?batchId=${batch.id}">检查清单详情</a></div></section>`;
}

function renderRunningWorkflowCommunication(workflow, communication, runtimeBlock) {
  if (!communication) return `<section class="workflow-phase"><div class="workflow-alert">沟通批次尚未建立，请查看诊断。</div></section>`;
  const rows = Object.entries(communication.summary.statusCounts)
    .map(([status, count]) => `<tr><th>${escapeHtml(status)}</th><td>${count}</td></tr>`)
    .join("");
  return `<section class="workflow-phase"><h2>正在沟通</h2>${runtimeBlock ? `<div class="workflow-alert">${escapeHtml(runtimeBlock.reasonCode)}</div>` : ""}<table class="workflow-status-table"><tbody>${rows}</tbody></table><div class="workflow-actions"><a class="button-link" href="/communication?batchId=${communication.batch.id}">查看执行明细</a></div></section>`;
}

function workflowTierLabel(tier) {
  return {
    primary: "主投",
    apply: "可投",
    caution: "慎投"
  }[tier] || "待分析";
}

function workflowTierClass(tier) {
  return ["primary", "apply", "caution"].includes(tier) ? tier : "";
}

function roleAlignmentLabel(value) {
  return {
    aligned: "一致",
    mostly_aligned: "基本一致",
    partially_aligned: "部分一致",
    misaligned: "不一致",
    insufficient_evidence: "证据不足，待确认"
  }[value] || "历史分析，待重新计算";
}

function foundationEvidenceLists(analysis) {
  const rows = (analysis?.requirementMatches || []).filter(
    (item) => item?.foundation === true
  );
  return {
    covered: rows.filter((item) =>
      ["matched", "transferable"].includes(item.state)
    ).map((item) => item.requirement),
    unresolved: rows.filter((item) =>
      !["matched", "transferable"].includes(item.state)
    ).map((item) => item.requirement)
  };
}

function hardBlockerLabels(analysis = {}) {
  return (analysis.hardBlockers || [])
    .map((item) => typeof item === "string" ? item : item?.requirement || item?.reason || "")
    .filter(Boolean);
}

function renderRoleEvidenceSummary(analysis = {}, className = "line", tag = "span") {
  const foundation = foundationEvidenceLists(analysis);
  const track = analysis.selectedTrackLabel
    ? `匹配分支：${escapeHtml(analysis.selectedTrackLabel)} · `
    : "";
  const roleSummary = String(analysis.roleSummary || "岗位主体待确认");
  const evidenceCount = Array.isArray(analysis.roleResumeEvidence) ? analysis.roleResumeEvidence.length : 0;
  const covered = foundation.covered.filter(Boolean).join("、") || "暂无";
  const unresolved = foundation.unresolved.filter(Boolean).join("、") || "暂无";
  return `<${tag} class="${escapeAttr(className)}">${track}岗位主体：${escapeHtml(roleSummary)} · 主体匹配：${escapeHtml(roleAlignmentLabel(analysis.roleAlignment))} · 主体依据：${evidenceCount} 条 · 已覆盖根基：${escapeHtml(covered)} · 待确认根基：${escapeHtml(unresolved)}</${tag}>`;
}

function shouldPollWorkflow(workflow, communication) {
  return ["created", "scanning", "analyzing", "communicating"].includes(workflow.status)
    || ["running", "stopping"].includes(communication?.batch?.status);
}

function workflowPollKey(workflow, communication) {
  const counts = communication?.summary?.statusCounts || {};
  return [
    workflow.status,
    communication?.batch?.status || "",
    workflow.successfulCount,
    counts.succeeded || 0,
    counts.already_communicated || 0,
    communication?.summary?.terminal || 0
  ].join("|");
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

function modelSettingsBack(error, fallback) {
  return error?.code === "MODEL_CONFIGURATION_REQUIRED"
    ? "/settings#model-profile-batch_screening"
    : fallback;
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
body{font-family:Segoe UI,Microsoft YaHei,sans-serif;margin:0;background:#f6f7f9;color:#1f2328}main{max-width:1160px;margin:0 auto;padding:24px}nav{display:flex;gap:14px;margin-bottom:18px}nav a{color:#0969da;text-decoration:none}h1{font-size:24px;margin:0 0 8px;letter-spacing:0}h2{font-size:16px;margin:0 0 10px}.hint,.line{color:#57606a;margin:7px 0}.notice{color:#0a6b2b}.risk-text{color:#b42318}.error-code{font-family:Consolas,monospace;color:#57606a}.panel{background:#fff;border:1px solid #d8dee4;border-radius:8px;padding:16px;margin:12px 0}.form-stack{display:grid;gap:12px;max-width:560px}.plan-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.plan-form .wide{grid-column:1/-1}.plan-form label,.form-stack label,.inline-form label{display:grid;gap:5px;font-size:14px}.plan-form .checkbox{display:flex;align-items:center;gap:8px;padding-top:24px}.plan-form .checkbox input{width:auto}input,select,textarea,button{font:inherit}input,select,textarea{min-width:0;padding:8px;border:1px solid #b8c0cc;border-radius:4px;background:#fff}input,select,button,.button-link{min-height:44px;box-sizing:border-box}textarea{min-height:118px;resize:vertical}button,.button-link{padding:8px 12px;border:1px solid #0969da;border-radius:4px;background:#0969da;color:#fff;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}.button-link{line-height:20px}.inline-form{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin-top:12px}.inline-form input{width:120px}.resume-preview pre{max-height:360px;overflow:auto;white-space:pre-wrap;background:#f6f8fa;padding:10px;border:1px solid #d8dee4}.scan-error{white-space:pre-wrap;background:#fff1f0;padding:10px;max-height:180px;overflow:auto}.profile-summary{display:grid;gap:3px}.validation{border-left:4px solid #bf8700}.validation-error{border-left-color:#b42318}.validation strong{display:block}.validation ul,.profile-diff ul{margin:7px 0 0;padding-left:20px}.profile-diff{border-top:1px solid #d8dee4;padding-top:8px}.diagnostics{width:100%;border-collapse:collapse;font-size:12px}.diagnostics th,.diagnostics td{border-bottom:1px solid #d8dee4;padding:7px;text-align:left;vertical-align:top;word-break:break-word}@media(max-width:760px){main{padding:16px}.plan-form{grid-template-columns:1fr}.plan-form .wide{grid-column:auto}.plan-form .checkbox{padding-top:0}.inline-form{display:grid;grid-template-columns:1fr}.diagnostics{display:block;overflow-x:auto}}
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
  if (planId) return `<a href="/onboarding">简历</a><a href="${escapeAttr(current)}">今日任务</a><a href="/queue?planId=${escapeAttr(planId)}">当前岗位</a><a href="/communication/new?planId=${escapeAttr(planId)}">批量沟通清单</a><a href="/settings">模型设置</a><a href="/diagnostics">诊断</a>`;
  return `<a href="/onboarding">简历</a><a href="${escapeAttr(current || "/")}">筛选方案</a><a href="/settings">模型设置</a><a href="/diagnostics">诊断</a>`;
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

function renderDashboard(data) {
  return renderCompactDashboard(data);
}

function renderQueuePage({ db, searchParams, logger, outcomeAnalyticsReader = getOutcomeAnalyticsSnapshot }) {
  const requestedPlanId = Number(searchParams.get("planId") || 0);
  const fallbackProfile = listCandidateProfiles(db)[0];
  const fallbackPlan = fallbackProfile ? getActiveSearchPlan(db, fallbackProfile.id) : null;
  const plan = getSearchPlan(db, requestedPlanId) || fallbackPlan;
  if (!plan) return renderErrorPage("还没有可用的筛选方案，请先上传简历并确认方案。", "/onboarding");
  const outcomeAnalyticsLogger = logger && typeof logger.warn === "function" ? logger : { warn() {} };
  let outcomeAnalyticsPanel;
  try {
    outcomeAnalyticsPanel = renderOutcomeAnalyticsPanel(outcomeAnalyticsReader(db, { planId: plan.id }));
  } catch {
    outcomeAnalyticsLogger.warn("outcome_analytics_render_failed", { code: "OUTCOME_ANALYTICS_UNAVAILABLE" });
    outcomeAnalyticsPanel = '<section class="panel outcome-analytics">统计暂不可用</section>';
  }
  return renderCompactQueuePage({ db, plan, searchParams, outcomeAnalyticsPanel });
}

function renderCompactQueuePage({ db, plan, searchParams, outcomeAnalyticsPanel = "" }) {
  const pool = ["focus", "primary", "apply", "caution", "analysis_pending", "detail_pending", "activity_pending", "no_reply", "not_recommended", "waiting_reply", "needs_user_action", "interview"].includes(searchParams.get("pool")) ? searchParams.get("pool") : "focus";
  const scope = ["all", "new", "repeated", "backlog"].includes(searchParams.get("scope")) ? searchParams.get("scope") : "all";
  const latestMainBatchId = getLatestMainScanBatchId(db, { planId: plan.id });
  const progressCards = listProgressCardsWithEvents(db, { profileId: plan.profileId });
  const progressByJob = new Map(progressCards.map((card) => [Number(card.jobId), card]));
  const fullPool = listDecisionPool(db, { planId: plan.id })
    .map((job) => ({ ...job, progressCard: progressByJob.get(Number(job.id)) || null }));
  const allCandidates = fullPool.filter((job) => compactAwaitingAction(job) && !job.progressCard);
  const noReplyCandidates = fullPool.filter((job) => job.applicationStatus === "no_reply");
  const progressCandidates = fullPool.filter((job) => job.progressCard);
  const progressPools = new Set(["waiting_reply", "needs_user_action", "interview"]);
  const poolBase = pool === "no_reply" ? noReplyCandidates : progressPools.has(pool) ? progressCandidates : allCandidates;
  const scopeCounts = Object.fromEntries(["all", "new", "repeated", "backlog"].map((key) => [key, poolBase.filter((job) => key === "all" || queueScopeForJob(job, latestMainBatchId) === key).length]));
  const candidates = poolBase.filter((job) => scope === "all" || queueScopeForJob(job, latestMainBatchId) === scope);
  const scopedAwaiting = allCandidates.filter((job) => scope === "all" || queueScopeForJob(job, latestMainBatchId) === scope);
  const refreshable = scopedAwaiting.filter((job) => job.decisionBucket === "refresh");
  const counts = Object.fromEntries(["primary", "apply", "caution", "analysis_pending", "refresh", "not_recommended"].map((key) => [key, scopedAwaiting.filter((job) => job.decisionBucket === key).length]));
  counts.detail_pending = refreshable.filter((job) => (job.qualityTags || []).includes("detail_unverified")).length;
  counts.activity_pending = refreshable.filter((job) => ((job.qualityTags || []).includes("activity_unverified") || (job.qualityTags || []).includes("stale_or_unknown_active")) && !(job.qualityTags || []).includes("detail_unverified")).length;
  counts.no_reply = noReplyCandidates.length;
  const scopedProgress = progressCandidates.filter((job) => scope === "all" || queueScopeForJob(job, latestMainBatchId) === scope);
  counts.waiting_reply = scopedProgress.filter((job) => job.progressCard.stage === "waiting_reply").length;
  counts.needs_user_action = scopedProgress.filter((job) => ["needs_user_action", "reply_ready"].includes(job.progressCard.stage)).length;
  counts.interview = scopedProgress.filter((job) => ["interview_invited", "interview_scheduled"].includes(job.progressCard.stage)).length;
  const wanted = pool === "focus" ? new Set(["primary", "apply"]) : new Set([pool]);
  const filtered = candidates.filter((job) => {
    const tags = job.qualityTags || [];
    if (pool === "no_reply") return true;
    if (pool === "detail_pending") return job.decisionBucket === "refresh" && tags.includes("detail_unverified");
    if (pool === "activity_pending") return job.decisionBucket === "refresh" && (tags.includes("activity_unverified") || tags.includes("stale_or_unknown_active")) && !tags.includes("detail_unverified");
    if (pool === "waiting_reply") return job.progressCard?.stage === "waiting_reply";
    if (pool === "needs_user_action") return ["needs_user_action", "reply_ready"].includes(job.progressCard?.stage);
    if (pool === "interview") return ["interview_invited", "interview_scheduled"].includes(job.progressCard?.stage);
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
    title: pool === "no_reply" ? "无回复待跟进" : progressPools.has(pool) ? "求职进展" : "当前待处理岗位",
    hint: pool === "no_reply"
      ? "这里只显示你主动标记为无回复的岗位；跟进文案按需生成一次，不会自动提醒或发送。"
      : progressPools.has(pool)
        ? "进展操作只更新本地记录；回复、投递、面试确认仍由你在平台上手动完成。"
        : "岗位按唯一记录展示；可切换本轮新增、本轮重复和历史未处理，已投与跳过状态不会因再次扫描丢失。",
    queue: { pool, counts, scope, scopeCounts, total: filtered.length, page, pageSize, totalPages, latestMainBatchId, profileId: plan.profileId },
    outcomeAnalyticsPanel
  });
}

const OUTCOME_TIER_LABELS = {
  primary: "主投",
  apply: "可投",
  caution: "慎投",
  not_recommended: "不推荐"
};

function outcomeTierLabel(key) {
  return Object.hasOwn(OUTCOME_TIER_LABELS, key) ? OUTCOME_TIER_LABELS[key] : "";
}

function renderOutcomeAnalyticsPanel(aggregate) {
  const tierRows = outcomeTierRows(aggregate);
  const keywordRows = outcomeKeywordRows(aggregate);
  const planName = typeof aggregate?.context?.planName === "string" && aggregate.context.planName ? aggregate.context.planName : "-";
  const includedCount = outcomeIncludedCount(aggregate);
  const terminalCount = outcomeTerminalCount(aggregate);
  const tiers = tierRows.length
    ? Object.keys(OUTCOME_TIER_LABELS).map((key) => {
      const row = tierRows.find((item) => item.key === key) || {};
      return '<tr><th scope="row">' + escapeHtml(outcomeTierLabel(key)) + '</th>' + outcomeAnalyticsMetricCells(row) + '</tr>';
    }).join("")
    : '<tr><td colspan="9">\u6682\u65e0\u56db\u6863\u7ed3\u679c\u8bb0\u5f55\u3002</td></tr>';
  const keywords = keywordRows.length
    ? '<div class="outcome-analytics-table-wrap"><table class="outcome-keyword-table"><thead><tr><th>\u5173\u952e\u8bcd</th>' + outcomeAnalyticsMetricHeaders() + '</tr></thead><tbody>' + keywordRows.map((item) => '<tr><th scope="row">' + escapeHtml(item.label) + '</th>' + outcomeAnalyticsMetricCells(item) + '</tr>').join("") + '</tbody></table></div>'
    : "<p>\u6682\u65e0\u5173\u952e\u8bcd\u7edf\u8ba1\u8bb0\u5f55\u3002</p>";
  const unclassified = outcomeUnclassifiedCounts(aggregate);
  const noRecordedResults = terminalCount === 0 ? '<p class="outcome-analytics-empty">\u6682\u65e0\u5df2\u8bb0\u5f55\u7ed3\u679c\u3002</p>' : "";
  const style = '<style>.outcome-analytics-table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}.outcome-tier-table,.outcome-keyword-table{width:100%;min-width:880px;border-collapse:collapse}.outcome-tier-table th,.outcome-tier-table td,.outcome-keyword-table th,.outcome-keyword-table td{padding:7px;border-bottom:1px solid #d8e0e6;text-align:left;white-space:nowrap}.outcome-analytics-context,.outcome-analytics-diagnostics,.outcome-analytics-unclassified,.outcome-analytics-empty{margin:10px 0;color:#5b6773;font-size:13px}</style>';
  return style + '<section class="panel outcome-analytics"><h2>\u7ed3\u679c\u7edf\u8ba1\uff08\u53ea\u8bfb\uff09</h2><p class="outcome-analytics-context">\u5f53\u524d\u65b9\u6848\uff1a' + planName + '\uff1b\u7eb3\u5165\u5c97\u4f4d\uff1a' + includedCount + '\uff1b\u5df2\u8bb0\u5f55\u7ec8\u6001\uff1a' + terminalCount + '\u3002</p><div class="outcome-analytics-table-wrap"><table class="outcome-tier-table"><thead><tr><th>\u63a8\u8350\u6863\u4f4d</th>' + outcomeAnalyticsMetricHeaders() + '</tr></thead><tbody>' + tiers + '</tbody></table></div><p class="outcome-analytics-diagnostics">\u5f85\u5206\u6790\u6216\u5f85\u5237\u65b0\uff08\u4e0d\u7eb3\u5165\u56db\u6863\u6bd4\u8f83\uff09\uff1a' + outcomeDiagnosticsCount(aggregate) + '</p><p class="outcome-analytics-unclassified">\u672a\u5206\u7c7b\u8bb0\u5f55\uff1a' + unclassified.total + '\uff1b\u672a\u77e5\u63a8\u8350\u6863\u4f4d\uff1a' + unclassified.unknownDecisionBucket + '\uff1b\u672a\u77e5\u72b6\u6001\uff1a' + unclassified.unknownApplicationStatus + '</p>' + noRecordedResults + '<h3>\u641c\u7d22\u65b9\u5411\uff08\u5173\u952e\u8bcd\uff09</h3>' + keywords + '<p class="queue-summary">\u4ec5\u4f9b\u89c2\u5bdf\uff0c\u4e0d\u8db3\u4ee5\u8c03\u53c2</p><p class="queue-summary">\u63d0\u793a\uff1a\u8c03\u6574\u5339\u914d\u77e9\u9635\u3001\u6743\u91cd\u6216\u63d0\u793a\u8bcd\u524d\uff0c\u5fc5\u987b\u53d6\u5f97\u7528\u6237\u786e\u8ba4\u3002</p></section>';
}

function outcomeAnalyticsMetricHeaders() {
  return "<th>\u603b\u6570</th><th>\u672a\u5904\u7406</th><th>\u5df2\u6295</th><th>\u5df2\u8df3\u8fc7</th><th>\u65e0\u56de\u590d</th><th>\u5df2\u7ea6\u9762</th><th>\u5df2\u62d2\u7edd\u6216\u65e0\u6548</th><th>\u85aa\u8d44\u4e0d\u5339\u914d</th>";
}

function outcomeAnalyticsMetricCells(row) {
  return ["total", "unresolved", "applied", "skipped", "no_reply", "interview", "rejected_or_invalid", "salary_mismatch"].map((key) => '<td>' + outcomeCount(row, key) + '</td>').join("");
}

function outcomeTierRows(aggregate) {
  const rows = Array.isArray(aggregate?.tiers) ? aggregate.tiers : [];
  return rows.map((row) => ({ ...row, key: String(row?.key || row?.tier || row?.recommendationTier || "") }))
    .filter((row) => outcomeTierLabel(row.key));
}

function outcomeKeywordRows(aggregate) {
  const rows = Array.isArray(aggregate?.keywords) ? aggregate.keywords : [];
  return rows.map((row) => ({ ...row, label: String(row?.label || row?.keyword || row?.word || "") }))
    .filter((row) => row.label);
}

function outcomeCount(row, key) {
  if (key === "unresolved") {
    const groups = [row, row?.counts, row?.statusCounts, row?.outcomes];
    const value = groups.map((group) => Number(group?.unresolvedCount)).find(Number.isFinite);
    return value === undefined ? outcomeCount(row, "pending") + outcomeCount(row, "review") + outcomeCount(row, "later") : value;
  }
  const groups = [row, row?.counts, row?.statusCounts, row?.outcomes];
  if (key === "rejected_or_invalid") {
    const direct = groups.map((group) => Number(group?.[key])).find(Number.isFinite);
    if (direct !== undefined) return direct;
    return outcomeCount(row, "rejected") + outcomeCount(row, "invalid");
  }
  const value = groups.map((group) => Number(group?.[key])).find(Number.isFinite);
  return value === undefined ? 0 : value;
}

function outcomeDiagnosticsCount(aggregate) {
  const diagnostics = aggregate?.diagnostics || {};
  const value = diagnostics.analysis_pending ?? diagnostics.pending ?? diagnostics.total ?? aggregate?.analysisPending ?? aggregate?.pending;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function outcomeIncludedCount(aggregate) {
  return outcomeCount(aggregate?.totals || {}, "total");
}

function outcomeTerminalCount(aggregate) {
  const aggregateCount = Number(aggregate?.totals?.recordedOutcomeCount);
  if (Number.isFinite(aggregateCount)) return Math.max(0, aggregateCount);
  const terminalOutcomes = ["applied", "skipped", "no_reply", "interview", "rejected", "invalid", "salary_mismatch"];
  return [...outcomeTierRows(aggregate), aggregate?.diagnostics || {}]
    .reduce((total, row) => total + terminalOutcomes.reduce((sum, status) => sum + outcomeCount(row, status), 0), 0);
}

function outcomeUnclassifiedCounts(aggregate) {
  const unclassified = aggregate?.unclassified || {};
  return {
    total: outcomeCount(unclassified, "total"),
    unknownDecisionBucket: outcomeCount(unclassified, "unknownDecisionBucket"),
    unknownApplicationStatus: outcomeCount(unclassified, "unknownApplicationStatus")
  };
}


function renderCommunicationBuilderPage({ db, searchParams }) {
  const plan = getSearchPlan(db, searchParams.get("planId"));
  if (!plan) return renderErrorPage("没有可用的筛选方案。", "/queue");
  const quota = communicationQuota(db);
  const runtimeBlock = communicationRuntimeBlock(db);
  const eligible = listDecisionPool(db, { planId: plan.id }).filter((job) => ["primary", "apply", "caution"].includes(job.decisionBucket)
    && String(job.applicationStatus ?? "").length === 0);
  const selection = PRODUCT_POLICY.operations.bossCommunication.selection;
  const defaultIds = new Set(eligible
    .filter((job) => defaultSelectedForBatch(job.decisionBucket))
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
  return renderPage("批量沟通清单", `<style>.communication-layout{max-width:860px}.communication-job{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid #d8e0e6}.communication-job input{width:auto;margin-top:4px}.communication-summary{position:sticky;bottom:0;background:#fff;border-top:1px solid #ccd7df;padding:12px 0}.communication-warning{color:#9a4b42;font-weight:700}</style><main class="communication-layout"><nav>${navLinks(`/plan?planId=${plan.id}`)}</nav><h1>批量沟通清单</h1>${blockNotice}<p>今日额度：已用 ${quota.used}，预留 ${quota.reserved}，剩余 ${quota.remaining}/${quota.limit}。</p><p>${escapeHtml(targetNotice)}</p><form id="communication-batch-form" method="post" action="/api/communication-batch"><input type="hidden" name="planId" value="${escapeAttr(plan.id)}"><label>浏览器 <select name="browserMode"><option value="edge" selected>当前已登录 Edge（推荐）</option><option value="portable">项目专用 Edge（手动备用）</option></select></label><section>${rows}</section><div class="communication-summary">已选 <output id="selected-count" for="communication-batch-form">0</output> 项 <button${quota.remaining ? "" : " disabled"}>确认清单</button></div></form></main><script>(function(){const form=document.getElementById('communication-batch-form');const output=document.getElementById('selected-count');const update=()=>{output.value=form.querySelectorAll('input[name="jobIds"]:checked').length};form.addEventListener('change',update);update()}());</script>`);
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
  const action = batch.status === "confirmed" ? "start" : ["paused", "interrupted"].includes(batch.status) ? "resume" : "";
  const executeControl = action && calibration.executionEnabled && !runtimeBlock
    ? `<form method="post" action="/api/communication-control"><input type="hidden" name="batchId" value="${batch.id}"><button name="action" value="${action}">${action === "start" ? "开始沟通" : "继续沟通"}</button></form>`
    : batch.status === "running" ? "<strong>沟通执行中</strong>" : "";
  const discardControl = ["confirmed", "paused"].includes(batch.status)
    ? `<form method="post" action="/api/communication-control"><input type="hidden" name="batchId" value="${batch.id}"><button name="action" value="discard">安全撤回</button></form>` : "";
  const calibrationNotice = calibration.executionEnabled ? "" : `<p class="communication-warning">校准状态：${escapeHtml(calibration.status)}，执行保持禁用。</p>`;
  return renderPage("批量沟通审阅", `<style>.communication-layout{max-width:960px}.communication-warning{color:#9a4b42;font-weight:700}.communication-table{width:100%;border-collapse:collapse}.communication-table th,.communication-table td{padding:8px;border-bottom:1px solid #d8e0e6;text-align:left;vertical-align:top}.communication-controls{display:flex;gap:8px;align-items:center;margin:14px 0}.communication-resolution{display:grid;gap:7px;min-width:260px}.communication-resolution label{display:grid;gap:4px}.communication-resolution div{display:flex;gap:6px}@media(max-width:760px){.communication-table,.communication-table tbody,.communication-table tr,.communication-table td{display:block;width:100%;box-sizing:border-box}.communication-table thead{display:none}.communication-table tr{padding:10px 0;border-bottom:1px solid #d8e0e6}.communication-table td{padding:4px 0;border:0}.communication-resolution{min-width:0}.communication-resolution div{flex-wrap:wrap}}</style><main class="communication-layout"><nav>${navLinks(`/plan?planId=${batch.planId}`)}<a href="/communication/new?planId=${batch.planId}">新建沟通清单</a></nav><h1>批量沟通审阅 #${batch.id}</h1><p>校准状态：${escapeHtml(calibration.status)}</p>${calibrationNotice}${blockNotice}<p>批次：${escapeHtml(batch.status)} · 已选：${summary.total} · ${counts}</p><p>今日额度：已用 ${quota.used}，预留 ${quota.reserved}，剩余 ${quota.remaining}/${quota.limit}。</p><div class="communication-controls">${executeControl}${discardControl}</div><table class="communication-table"><thead><tr><th>#</th><th>岗位</th><th>状态</th><th>人工处理</th></tr></thead><tbody>${rows}</tbody></table></main>`);
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
  const { jobs = [], filters = {}, latestBatchId, queue = null, title = "投递操作台", hint = "", outcomeAnalyticsPanel = "" } = data;
  const analysisRetry = queue?.pool === "analysis_pending" && Number(queue.counts.analysis_pending || 0) > 0
    ? `<section class="panel"><form method="post" action="/api/analyze-jobs"><input type="hidden" name="planId" value="${escapeAttr(filters.planId)}"><button class="apply">批量重试全部待分析岗位（${queue.counts.analysis_pending}）</button></form><p class="line">仅使用已保存的岗位详情，模型并发固定为 ${PRODUCT_POLICY.operations.modelAnalysis.retryConcurrency}，不会访问招聘网站。</p></section>`
    : "";
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
body{margin:0;background:#f5f7f8;color:#1f2933;font-family:Segoe UI,Microsoft YaHei,sans-serif}main{max-width:1100px;margin:0 auto;padding:22px 18px 48px}nav{display:flex;gap:14px;margin-bottom:20px}a{color:#1265a8;text-decoration:none}a:hover{text-decoration:underline}h1{font-size:24px;margin:0 0 7px}.hint{color:#5b6773;margin:0 0 16px}.panel{background:#fff;border:1px solid #d8e0e6;border-radius:8px;padding:12px 14px;margin:12px 0}.pool-tabs{display:flex;flex-wrap:wrap;gap:8px}.pool-tabs+.pool-tabs{margin-top:9px}.pool-tab{padding:7px 10px;border:1px solid #ccd7df;border-radius:6px;background:#fff;color:#344450}.pool-tab.active{background:#e6f3f0;border-color:#68aa9b;color:#155f54;font-weight:700;text-decoration:none}.queue-summary{margin-top:10px;color:#5b6773;font-size:13px}.pager{display:flex;justify-content:center;align-items:center;gap:10px;margin-top:14px}.pager a,.pager span{padding:7px 10px;border:1px solid #ccd7df;border-radius:5px;background:#fff}.filters{display:grid;grid-template-columns:repeat(6,minmax(110px,1fr)) auto;gap:8px}.filters input,.filters select,input,select{box-sizing:border-box;min-width:0;padding:8px;border:1px solid #b9c5ce;border-radius:5px;background:#fff}.job{background:#fff;border:1px solid #d7e0e6;border-radius:8px;padding:14px 16px;margin:10px 0}.job-top{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.job-title{font-size:16px;font-weight:700;line-height:1.35}.job-meta,.job-reason,.job-risk,.line{margin-top:7px;font-size:14px;line-height:1.45;color:#53616d}.job-reason{color:#27604f}.job-risk{color:#9a4b42}.decision{display:inline-block;white-space:nowrap;border:1px solid #d8e0e6;border-radius:999px;padding:4px 8px;font-size:12px;font-weight:700}.decision.primary{background:#e6f3f0;border-color:#86b9ad;color:#155f54}.decision.apply{background:#eef4fa;border-color:#9cbcdc;color:#245b87}.decision.caution{background:#fff6df;border-color:#ead29a;color:#825b13}.analysis_pending{background:#f1f3f5;border-color:#b9c3cc;color:#46535e}.refresh{background:#f5f0fd;border-color:#c8b8e6;color:#64419b}.not_recommended{background:#f9e9e7;border-color:#e5b3ae;color:#9b3f37}.quick-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.quick-actions select{max-width:190px}button{padding:7px 10px;cursor:pointer;border:1px solid #aab8c2;border-radius:5px;background:#fff;color:#25313a}.apply{background:#176b5b;border-color:#176b5b;color:#fff}.skip{color:#8a3a33}.details{margin-top:11px;border-top:1px solid #e4e9ed;padding-top:9px}.details summary{cursor:pointer;color:#4f6170;font-size:13px}.detail-body{margin-top:10px}.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.chip{border:1px solid #d8dee4;border-radius:999px;padding:3px 7px;font-size:12px;background:#f6f8fa}.risk{background:#f9e9e7;border-color:#e5b3ae}.jd{white-space:pre-wrap;background:#f7f9fa;border-left:3px solid #2a7185;padding:9px 10px;font-size:13px;line-height:1.55}.detail-actions,.follow{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:10px}.detail-actions input,.follow input{flex:1 1 220px}textarea{box-sizing:border-box;width:100%;min-height:52px;margin-top:8px;padding:8px;border:1px solid #b9c5ce;border-radius:5px;background:#fafcfd}@media(max-width:760px){.filters{grid-template-columns:1fr 1fr}.job-top{display:block}.decision{margin-top:7px}}</style><main>
<nav><a href="/onboarding">简历</a>${filters.planId ? `<a href="/plan?planId=${escapeAttr(filters.planId)}">筛选方案</a><a href="/queue?planId=${escapeAttr(filters.planId)}">当前岗位</a>` : ""}<a href="/settings">模型设置</a><a href="/diagnostics">诊断</a></nav><h1>${escapeHtml(title)}</h1><p class="hint">${escapeHtml(hint)}${latestBatchId ? ` 主扫描批次 #${latestBatchId}` : ""}</p>
  ${queue ? renderCompactPoolTabs(queue, filters.planId, queue.profileId) : renderCompactFilters(filters)}${outcomeAnalyticsPanel}${analysisRetry}
${jobs.map((job) => renderCompactJob(job, filters)).join("") || "<section class=\"panel\">这个分组目前没有岗位。</section>"}${queue ? renderCompactPager(queue, filters.planId) : ""}</main><script>async function copyGreeting(id){const el=document.getElementById(id);if(el)await navigator.clipboard.writeText(el.value);}</script></html>`;
}

function renderCompactPoolTabs(queue, planId, profileId = "") {
  const scopes = [["all", "全部待处理", queue.scopeCounts.all || 0], ["new", "本轮新增", queue.scopeCounts.new || 0], ["repeated", "本轮重复", queue.scopeCounts.repeated || 0], ["backlog", "历史未处理", queue.scopeCounts.backlog || 0]];
  const tabs = [["focus", "主投 + 可投", (queue.counts.primary || 0) + (queue.counts.apply || 0)], ["primary", "主投", queue.counts.primary || 0], ["apply", "可投", queue.counts.apply || 0], ["caution", "慎投", queue.counts.caution || 0], ["analysis_pending", "待语义分析", queue.counts.analysis_pending || 0], ["detail_pending", "待读详情", queue.counts.detail_pending || 0], ["activity_pending", "活跃待核验", queue.counts.activity_pending || 0], ["no_reply", "无回复跟进", queue.counts.no_reply || 0], ["waiting_reply", "等待回复", queue.counts.waiting_reply || 0], ["needs_user_action", "需要处理", queue.counts.needs_user_action || 0], ["interview", "面试进展", queue.counts.interview || 0], ["not_recommended", "不推荐", queue.counts.not_recommended || 0]];
  const scopeLinks = scopes.map(([key, label, count]) => `<a class="pool-tab ${queue.scope === key ? "active" : ""}" href="${queueHref(planId, queue.pool, key, 1)}">${escapeHtml(label)} ${count}</a>`).join("")
    + `<a class="pool-tab" href="/communication/new?planId=${escapeAttr(planId)}">批量沟通清单</a>`
    + (profileId ? `<a class="pool-tab" href="/messages?profileId=${escapeAttr(profileId)}">消息发现</a>` : "");
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
  return `<form class="panel filters" method="get" action="/jobs"><input type="hidden" name="planId" value="${escapeAttr(filters.planId || "")}">${select("status", filters.status, [["pending", "未处理"], ["review", "待确认"], ["later", "保留"], ["applied", "已投"], ["skipped", "跳过"], ["all", "全部"]])}${select("decision", filters.decision, [["all", "全部投递池"], ["primary", "主投"], ["apply", "可投"], ["caution", "慎投"], ["analysis_pending", "待语义分析"], ["refresh", "待刷新"], ["not_recommended", "不推荐"]])}${select("level", filters.level, [["all", "全部级别"], ["优先", "优先"], ["可投", "可投"], ["可冲", "可冲"], ["谨慎", "谨慎"], ["不建议", "不建议"]])}${select("fresh", filters.fresh, [["all", "新增+重复"], ["new", "本批新增"], ["repeated", "重复出现"]])}${select("batch", filters.batchId ? String(filters.batchId) : filters.batch, [["latest", "最新批次"], ["all", "全部历史"]])}<input name="q" value="${escapeAttr(filters.q || "")}" placeholder="搜索标题/公司/地点"><button>过滤</button></form>`;
}

function renderCompactJob(job, filters) {
  const html = renderCompactJobBase(job, filters);
  if (!job.progressCard) return html;
  return html.replace("</details></article>", `</details>${renderProgressPanel(job.progressCard)}</article>`);
}

function renderCompactJobBase(job, filters) {
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
  const roleEvidenceSummary = renderRoleEvidenceSummary(analysis, "line", "div");
  return `<article class="job"><div class="job-top"><div><div class="job-title">${escapeHtml(job.title)}${job.url ? ` · <a href="${escapeAttr(job.url)}" target="_blank">打开岗位</a>` : ""}</div><div class="job-meta">${escapeHtml(job.company || "")} · ${escapeHtml(job.location || "")} · ${escapeHtml(salaryLabel)} · ${escapeHtml(experienceLabel)} · ${escapeHtml(compactActivityLabel(job))}${escapeHtml(status)}</div><div class="job-meta">${escapeHtml(compactSeenLabel(job, filters.latestMainBatchId))}</div></div><span class="decision ${escapeAttr(job.decisionBucket || "backup")}">${escapeHtml(compactDecisionLabel(job.decisionBucket))}</span></div><div class="job-reason">${escapeHtml(fitReason)}</div><div class="job-risk">${escapeHtml(risk)}</div>${retryAnalysisAction}${job.followUpNote ? `<div class="line"><strong>沟通记录：</strong>${escapeHtml(job.followUpNote)}</div>` : ""}<form class="quick-actions" method="post" action="/api/mark${query}">${jobContext}<button class="apply" name="status" value="applied">已投</button><button name="status" value="review">待确认</button><button name="status" value="later">7 天后再看</button><button class="skip" name="status" value="skipped">跳过</button></form><details class="details"><summary>查看 JD、沟通与完整记录</summary><div class="detail-body">${roleEvidenceSummary}<div class="line">决策来源：${escapeHtml(compactDecisionSource(analysis))} · 工作节奏：${escapeHtml(compactScheduleLabel(analysis))} · 推荐简历：${escapeHtml(analysis.recommendedResumeVersionName || analysis.recommendedResumeVersion || "待确认")} · 主推项目：${escapeHtml((analysis.primaryProjects || []).join("、") || "待确认")}</div><div class="chips">${chips(job.risks, "risk")}${chips(job.qualityTags, "tag")}</div><div class="jd">${escapeHtml(String(job.description || "暂无完整 JD").slice(0, 1500))}</div>${greetingAction}${followUpAction}${hrReplyAction}<form class="detail-actions" method="post" action="/api/mark${query}">${jobContext}<input name="note" placeholder="状态备注（可选）"><button name="status" value="no_reply">无回复待跟进</button><button name="status" value="interview">约面</button><button name="status" value="rejected">拒绝</button><button name="status" value="invalid">岗位无效</button><button name="status" value="salary_mismatch">薪资不匹配</button></form><form class="follow" method="post" action="/api/follow-up${query}">${jobContext}<input name="note" placeholder="记录沟通进展"><button>记录备注</button></form>${feedbackAction}</div></details></article>`;
}

function renderProgressPanel(card) {
  const eventTimeline = (card.events || []).slice(-5)
    .map((event) => `<li>${escapeHtml(compactDateTime(event.occurredAt))} · ${escapeHtml(event.summary)}</li>`)
    .join("");
  const context = `<input type="hidden" name="cardId" value="${card.id}">`;
  const requestKey = () => `<input type="hidden" name="idempotencyKey" value="${escapeAttr(newProgressRequestKey())}">`;
  const actionButton = (action, label) => `<form method="post" action="/api/progress">${context}${requestKey()}<button name="action" value="${action}">${label}</button></form>`;
  const stageAction = card.stage === "reply_ready"
    ? actionButton("reply_confirmed_sent", "已手动发送")
    : card.stage === "interview_invited"
      ? `<form class="follow" method="post" action="/api/progress">${context}${requestKey()}<input type="hidden" name="action" value="mark_interview_scheduled"><input name="summary" placeholder="你确认的面试安排" required><input type="datetime-local" name="scheduledAt" required><button>标记已安排面试</button></form>`
      : "";
  const controls = card.stage === "closed"
    ? actionButton("reopen_opportunity", "重新开启机会")
    : `${stageAction}${actionButton("mark_needs_user_action", "标记需要处理")}${actionButton("mark_resume_submitted", "标记已投递简历")}${actionButton("close_opportunity", "关闭机会")}`;
  const correctionOptions = [...PROGRESS_STAGES]
    .map((stage) => `<option value="${stage}">${escapeHtml(progressStageLabel(stage))}</option>`)
    .join("");
  return `<section class="progress-card" style="margin-top:12px;padding:12px;border:1px solid #86b9ad;border-radius:7px;background:#f3faf8"><strong>${escapeHtml(progressStageLabel(card.stage))}</strong><div class="line">下一步：${escapeHtml(card.nextAction || "等待用户确认")}${card.scheduledAt ? ` · ${escapeHtml(compactDateTime(card.scheduledAt))}` : ""}</div>${eventTimeline ? `<ol>${eventTimeline}</ol>` : ""}<p class="line">所有按钮只更新本地记录，不会自动填写或发送。</p><div class="quick-actions">${controls}</div><details><summary>纠正阶段</summary><form class="follow" method="post" action="/api/progress">${context}${requestKey()}<input type="hidden" name="action" value="correct_stage"><select name="targetStage">${correctionOptions}</select><input name="reason" placeholder="纠正原因" required><button>保存纠正</button></form></details></section>`;
}

function newProgressRequestKey() {
  return `progress:${randomUUID()}`;
}

function progressStageLabel(stage) {
  return {
    contact_started: "已发起沟通",
    waiting_reply: "已发起沟通",
    needs_user_action: "需要你处理",
    reply_ready: "回复草稿已就绪",
    interview_invited: "收到面试邀约",
    interview_scheduled: "面试已安排",
    resume_submitted: "已投递简历",
    rejected: "已拒绝",
    closed: "已关闭"
  }[stage] || "求职进展";
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
  return { primary: "主投", apply: "可投", caution: "慎投", analysis_pending: "待语义分析", refresh: "待刷新", not_recommended: "不推荐" }[bucket] || "待分析";
}

function compactDecisionSource(analysis = {}) {
  return {
    model: "模型证据匹配",
    weighted_decision_matrix: "本地加权二维表",
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

module.exports = {
  createDashboardServer,
  buildWorkflowDashboardState,
  resolveLiveInheritedContext,
  inspectDashboardBossBrowserReadiness,
  startPlanScan,
  scanStatus,
  handleMarkApi,
  handleFollowUpApi,
  getDashboardData,
  filterJobs,
  renderDashboard,
  renderQueuePage,
  renderPlanPage
};
