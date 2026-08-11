#!/usr/bin/env node
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { loadConfigs } = require("./config");
const { EdgeControlAdapter } = require("./adapters/browser/edge_control");
const { CdpBrowserAdapter } = require("./adapters/browser/cdp");
const { BossSiteAdapter, cleanDetailText, resolveBossSearchContext } = require("./adapters/sites/boss");
const { scoreJob, decisionState } = require("./core/scoring");
const { resolvePlannedKeywords } = require("./core/keyword_planner");
const { createJobAnalysisRunner, runWorkflowAnalysisPhase } = require("./core/job_analysis");
const { completedWorkflowAnalysisCount } = require("./core/workflow_analysis_tasks");
const { analyzeResumeToPlan } = require("./core/profile_onboarding");
const {
  CITY_CODES,
  cityToBossCode,
  profileToRuntimeConfigs,
  planKeywords,
  resolveScanPolicy,
  applyScanPolicyToFilters
} = require("./core/search_plan");
const { isCatalogFresh, resolveNativeFilterSnapshot, formatNativeFilterSummary } = require("./core/platform_filters");
const {
  openDb,
  getWorkflowRun,
  getWorkflowRunByCommunicationBatch,
  transitionWorkflowRun,
  attachWorkflowScan,
  attachWorkflowScanRun,
  createBatch,
  createAndBindScanBatch,
  getBatch,
  beginScanRun,
  heartbeatScanRun,
  finishScanRun,
  interruptOrphanedScanRuns,
  checkpointScanProgress,
  checkpointScanTarget,
  listLatestScanTargetResults,
  getSiteRuntimeState,
  setSiteRuntimeState,
  clearSiteRuntimeState,
  recordSiteAccessEvent,
  listSiteAccessEvents,
  acquireSiteScanLease,
  renewSiteScanLease,
  releaseSiteScanLease,
  recordWorkflowScanWait,
  recordWorkflowPlatformAccess,
  listReusableJobDetails,
  recordJobRefreshAttempt,
  getLatestJobRefreshAttempt,
  getPlatformFilterCatalog,
  savePlatformFilterCatalog,
  buildFeedbackSummary,
  buildBatchSummary,
  upsertKeywordSource,
  upsertJob,
  listReportJobs,
  markApplication,
  getCandidateProfile,
  getCandidateMatchingContext,
  getSearchPlan,
  getSearchPlanDependency,
  getLatestBatchId,
  listMatchingResumeVersions,
  listDecisionPool,
  isActivityProbeDue,
  saveProfileAnalysis,
  attachResumeDocumentFile,
  bindBatchToPlan,
  rescorePlanObservations,
  reassessBatchObservations
} = require("./core/storage");
const { listWorkflowInventory } = require("./core/workflow_inventory");
const { createSiteAccessController } = require("./core/site_access_budget");
const { isBossDetailAccessAction } = require("./core/site_access_usage");
const { parseResumeUpload } = require("./core/resume_parser");
const { renderReports } = require("./reports/render");
const { createDashboardServer } = require("./dashboard/server");
const { createLogger, errorMeta, workflowLogContext } = require("./core/observability");
const { resolveReadOnlyModelSettingsRoot, resolveRuntimeModelConfig, resolveRuntimeBatchBackup, isModelReady } = require("./core/model_settings");
const { mapWithConcurrency } = require("./core/async_pool");
const { storeResumeSourceFile } = require("./core/resume_files");
const { assertSearchPlanReady } = require("./core/plan_validation");
const { PRODUCT_POLICY } = require("./core/product_policy");
const { stableHash } = require("./core/analysis_revision");
const { matchingCardRevision } = require("./core/matching_card");
const {
  buildInheritedSearchScope,
  assertInheritedAcquisitionScope,
  assertCompleteInheritedContext,
  freezeKeywordSource,
  scopeShortId
} = require("./core/inherited_search_scope");
const { compilePlatformRuntimePolicy, applyPlatformRuntimePolicy } = require("./core/platform_runtime_policy");
const { resolveScanKind, withSiteScanLease: runWithSiteScanLease } = require("./core/scan_execution");
const { getCommunicationBatch, setCommunicationBatchStatus, touchCommunicationBatch } = require("./core/communication_batches");
const { runCommunicationBatch } = require("./core/communication_executor");
const { finalizeWorkflowControl } = require("./core/workflow_control");
const {
  buildScanExecutionSnapshot,
  assertScanSnapshotCompatible,
  remainingTargetKeys,
  summarizeResumePlan
} = require("./core/scan_snapshot");
const { validateResumeBatch } = require("./core/scan_resume");
const { inspectBossBrowserReadiness } = require("./core/browser_readiness");
const { prepareWorkspaceTabs, inspectBossOperatorTabs, assertBossRuntimeTabBindings } = require("./core/workspace_tabs");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_DB = path.join(ROOT, "data", "jobs.sqlite");
const logger = createLogger({ root: ROOT, component: "cli" });

if (require.main === module) {
  main().catch((err) => {
    logger.error("cli_command_failed", { command: process.argv[2] || "help", error: errorMeta(err) });
    if (err?.code === "MATCHING_CARD_CONFIRMATION_REQUIRED") {
      const profileId = err.details?.profileId ?? "";
      const cardId = err.details?.cardId ?? "";
      console.error(`[MATCHING_CARD_CONFIRMATION_REQUIRED] ${err.message}`);
      console.error(`请在工作台确认现有匹配偏好卡：profileId=${profileId}${cardId ? `，可用草稿卡 cardId=${cardId}` : ""}。确认后即可重新运行当前命令。`);
    } else {
      console.error(err.stack || err.message);
    }
    process.exit(1);
  });
}

async function main() {
  const [command = "help", ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);
  if (["help", "--help", "-h"].includes(command) || args.help) return printHelp();
  logger.info("cli_command_started", { command, argKeys: Object.keys(args).sort() });

  if (command === "workspace-tabs") return prepareWorkspaceTabsCommand(args);
  const db = openDb(path.resolve(args.db || DEFAULT_DB));
  if (command === "init-db") {
    console.log(`SQLite ready: ${path.resolve(args.db || DEFAULT_DB)}`);
    return;
  }

  if (command === "scan") {
    const resumeValidation = prevalidateDirectScanResume(db, args);
    return executeWithSiteScanLease(
      db,
      args,
      command,
      (signal, execution) => scan(db, args, { signal, execution, resumeValidation })
    );
  }
  if (command === "refresh-details") return executeWithSiteScanLease(db, args, command, (signal, execution) => refreshDetails(db, args, { signal, execution }));
  if (command === "refresh-activity") return executeWithSiteScanLease(db, args, command, (signal, execution) => refreshDetails(db, { ...args, "activity-only": true }, { signal, execution }));
  if (command === "profile-create") return createProfile(db, args);
  if (command === "bind-batch") return bindBatch(db, args);
  if (command === "reassess-batch") return reassessBatch(db, args);
  if (command === "rescore-plan") return rescorePlan(db, args);
  if (command === "rebuild-report") return rebuildReport(db, args);
  if (command === "dashboard") return startDashboard(db, args);
  if (command === "feedback-summary") return printFeedbackSummary(db);
  if (command === "batch-summary") return printBatchSummary(db, args);
  if (command === "communicate") return communicate(db, args);
  if (command === "mark-applied") return mark(db, args, "applied");
  if (command === "mark-skipped") return mark(db, args, "skipped");
  if (command === "mark-no-reply") return mark(db, args, "no_reply");
  throw new Error(`未知命令：${command}`);
}

async function prepareWorkspaceTabsCommand(
  args,
  {
    browserFactory = createBrowser,
    siteAdapterFactory = createSiteAdapter,
    prepareTabs = prepareWorkspaceTabs
  } = {}
) {
  const browserMode = String(args.browser || "edge").trim().toLowerCase();
  const cdpPort = Number(args["cdp-port"] || 9222);
  if (!["edge", "portable"].includes(browserMode)
    || (browserMode === "portable" && cdpPort !== 9222)) {
    const error = new Error("工作台同窗启动固定使用项目专用 Edge 的 9222 端口。");
    error.message = "工作台默认复用普通 Edge；项目专用 Edge 仅支持显式 portable/9222。";
    error.code = "WORKSPACE_PORTABLE_BROWSER_REQUIRED";
    throw error;
  }
  const dashboardUrl = String(args["dashboard-url"] || "http://127.0.0.1:8787/");
  const parsedDashboardUrl = new URL(dashboardUrl);
  if (parsedDashboardUrl.protocol !== "http:"
    || !["127.0.0.1", "localhost"].includes(parsedDashboardUrl.hostname)) {
    const error = new Error("工作台 URL 必须是本机 HTTP 地址。");
    error.code = "WORKSPACE_DASHBOARD_URL_INVALID";
    throw error;
  }
  const browserArgs = browserMode === "portable"
    ? { browser: "portable", "cdp-port": 9222 }
    : { browser: "edge" };
  const browser = browserFactory(browserArgs);
  const adapter = siteAdapterFactory("boss", { browser, logger });
  const result = await prepareTabs({
    browser,
    dashboardUrl: parsedDashboardUrl.toString(),
    requireFixedBossTabs: browserMode === "edge",
    inspectReadiness: (fixed) => inspectBossBrowserReadiness({
      preflight: async () => {
        if (!fixed) return adapter.preflight();
        const inspected = await inspectBossOperatorTabs({
          browser,
          inspectTab: (tabId) => adapter.preflight({ tabId }),
          expectedSearchTabId: fixed.searchTab.id,
          expectedCommunicationTabId: fixed.communicationTab.id
        });
        return inspected.searchState;
      }
    })
  });
  console.log(`RoleFlow workspace tabs ready: ${result.status}`);
  return result;
}

async function communicate(
  db,
  args,
  {
    createBrowserFn = createBrowser,
    createSiteAdapterFn = createSiteAdapter,
    runCommunicationBatchFn = runCommunicationBatch
  } = {}
) {
  const batchId = Number(args.batch);
  if (!Number.isInteger(batchId) || batchId <= 0) throw new Error("需要 --batch <Communication Batch ID>");
  const batch = getCommunicationBatch(db, batchId);
  if (!batch) throw new Error(`未找到沟通批次 #${batchId}`);
  const browserArgs = resolveCommunicationBrowserAuthority(batch, args);
  const browserMode = browserArgs.browser;
  const browser = createBrowserFn(browserArgs);
  if (!browser) throw new Error("沟通执行需要已配置的 Edge 浏览器连接。");
  const runId = `communication-${batchId}-${crypto.randomUUID()}`;
  const workflowRun = getWorkflowRunByCommunicationBatch(db, batchId);
  const communicationLogger = logger.child({
    ...workflowLogContext({ ...(workflowRun || {}), communicationBatchId: batchId }),
    runId,
    batchId,
    planId: batch.planId,
    site: "boss",
    operation: "communication"
  });
  const accessController = createSiteAccessController({ db, site: "boss", runId, logger: communicationLogger });
  const adapter = createSiteAdapterFn("boss", { browser, logger: communicationLogger, accessController });
  const stopHeartbeat = startCommunicationHeartbeat(db, batchId, communicationLogger);

  try {
    if (browserMode === "edge") {
      const inspected = await inspectBossOperatorTabs({
        browser,
        inspectTab: (tabId) => adapter.preflight({ tabId })
      });
      if (typeof adapter.bindCommunicationTabs !== "function") {
        throw codedError("BOSS_COMMUNICATION_BINDING_REQUIRED", "Edge communication requires fixed BOSS operator tab binding.");
      }
      adapter.bindCommunicationTabs({
        searchTabId: inspected.searchTab.id,
        communicationTabId: inspected.communicationTab.id
      });
      await adapter.prepareCommunicationTab(inspected.searchTab.id);
    } else {
      const browserState = await adapter.preflight();
      await adapter.prepareCommunicationTab(browserState.tabId);
    }
    const summary = await runCommunicationBatchFn({ db, batchId, adapter, accessController, logger: communicationLogger });
    console.log(`沟通批次 #${batchId} 完成：${summary.terminal}/${summary.total}`);
    return summary;
  } catch (error) {
    const current = getCommunicationBatch(db, batchId);
    if (current?.status === "running") {
      setCommunicationBatchStatus(db, {
        batchId,
        status: "interrupted",
        stopCode: error?.code || "COMMUNICATION_PROCESS_FAILED",
        stopMessage: error?.message || String(error)
      });
    }
    if (error?.code === "BOSS_RISK_CONTROL") {
      setSiteRuntimeState(db, "boss", {
        status: "blocked",
        reasonCode: error.code,
        message: error.message,
        details: { phase: "communication", batchId }
      });
      recordSiteAccessEvent(db, {
        site: "boss",
        action: "risk_control",
        runId,
        details: { batchId, errorCode: error.code, errorMessage: error.message }
      });
    }
    throw error;
  } finally {
    stopHeartbeat();
  }
}

function resolveCommunicationBrowserAuthority(batch, args = {}) {
  const batchMode = String(batch?.browserMode || "").trim().toLowerCase();
  const browserMode = String(args.browser || batchMode || "").trim().toLowerCase();
  if (browserMode !== batchMode) {
    throw new Error(`沟通批次固定使用 ${batchMode}，不能切换为 ${browserMode}。`);
  }
  if (batchMode !== "portable") return { ...args, browser: browserMode };

  const policySnapshot = batch?.policySnapshot;
  const hasBrowserPolicy = Boolean(
    policySnapshot
    && typeof policySnapshot === "object"
    && Object.prototype.hasOwnProperty.call(policySnapshot, "browser")
  );
  const browserPolicy = hasBrowserPolicy ? policySnapshot.browser : null;
  const frozenPort = hasBrowserPolicy ? browserPolicy?.cdpPort : 9222;
  if (hasBrowserPolicy && (
    !browserPolicy
    || typeof browserPolicy !== "object"
    || Array.isArray(browserPolicy)
    || String(browserPolicy.mode || "").trim().toLowerCase() !== batchMode
    || !Number.isInteger(browserPolicy.cdpPort)
    || browserPolicy.cdpPort !== 9222
  )) {
    throw codedError(
      "COMMUNICATION_PORTABLE_BROWSER_POLICY_INVALID",
      "[COMMUNICATION_PORTABLE_BROWSER_POLICY_INVALID] portable 沟通批次缺少有效的冻结浏览器策略。"
    );
  }

  const suppliedPort = args["cdp-port"];
  const suppliedPortMatches = suppliedPort === frozenPort
    || (typeof suppliedPort === "string" && suppliedPort.trim() === String(frozenPort));
  if (suppliedPort !== undefined && !suppliedPortMatches) {
    throw codedError(
      "COMMUNICATION_PORTABLE_CDP_PORT_MISMATCH",
      `[COMMUNICATION_PORTABLE_CDP_PORT_MISMATCH] --cdp-port 必须与沟通批次冻结端口 ${frozenPort} 完全一致。`
    );
  }
  return { ...args, browser: browserMode, "cdp-port": frozenPort };
}

function startCommunicationHeartbeat(db, batchId, communicationLogger) {
  const timer = setInterval(() => {
    try {
      touchCommunicationBatch(db, batchId);
    } catch (error) {
      communicationLogger?.warn("communication_heartbeat_failed", {
        batchId,
        errorCode: error?.code || "COMMUNICATION_HEARTBEAT_FAILED",
        errorMessage: error?.message || String(error)
      });
    }
  }, PRODUCT_POLICY.operations.communicationHeartbeatMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function executeWithSiteScanLease(db, args, command, run) {
  const planRecord = args.plan ? getSearchPlan(db, args.plan) : null;
  const site = String(args.site || planRecord?.plan?.platform?.site || "boss").trim().toLowerCase();
  const scanKind = resolveScanKind(command, args);
  const runId = String(args["run-id"] || crypto.randomUUID()).trim();
  const planId = Number(args.plan || 0) || null;
  const workflowRun = prepareWorkflowExecution(db, args, planId);
  const workflowRunId = workflowRun?.id || "";
  const runLogger = logger.child({
    ...workflowLogContext({ ...(workflowRun || {}), scanRunId: runId }),
    runId,
    planId,
    scanKind,
    site
  });
  if (workflowRun?.status === "analyzing" && args["analysis-only"] === true) {
    const scanRun = beginScanRun(db, {
      runId,
      site,
      command: scanKind,
      planId,
      processId: process.pid
    });
    const execution = {
      runId,
      leaseOwner: "",
      site,
      scanKind,
      planId,
      workflowRunId,
      logger: runLogger
    };
    runLogger.info("scan_run_started", { status: scanRun.status, analysisOnly: true });
    return executeTrackedScanRun(db, {
      runId,
      leaseOwner: "",
      runLogger,
      run,
      signal: null,
      execution
    });
  }
  interruptOrphanedScanRuns(db, { site });
  if (command === "scan" && args.input) {
    const scanRun = beginScanRun(db, {
      runId,
      site,
      command: scanKind,
      planId,
      processId: process.pid
    });
    const execution = { runId, leaseOwner: "", site, scanKind, planId, workflowRunId, logger: runLogger };
    runLogger.info("scan_run_started", { status: scanRun.status, localInput: true });
    return executeTrackedScanRun(db, { runId, leaseOwner: "", runLogger, run, signal: null, execution });
  }

  const owner = `${runId}:${process.pid}`;
  let runClaimed = false;
  return runWithSiteScanLease({
    acquire(input) {
      const lease = acquireSiteScanLease(db, input);
      runLogger.info("site_scan_lease_acquired", { planId: lease.planId, owner, expiresAt: lease.expiresAt });
      return lease;
    },
    renew(input) {
      const expiresAt = renewSiteScanLease(db, { site, owner });
      if (runClaimed) heartbeatScanRun(db, { runId, leaseOwner: owner, processId: process.pid });
      runLogger.info("site_scan_lease_renewed", { owner, expiresAt });
      return { site, owner, expiresAt };
    },
    release(input) {
      const released = releaseSiteScanLease(db, input);
      runLogger.info("site_scan_lease_released", { owner, released });
      return released;
    }
  }, {
    site,
    owner,
    command: scanKind,
    planId
  }, async (signal) => {
    const scanRun = beginScanRun(db, {
      runId,
      site,
      command: scanKind,
      planId,
      leaseOwner: owner,
      processId: process.pid
    });
    runClaimed = true;
    const execution = { runId, leaseOwner: owner, site, scanKind, planId, workflowRunId, logger: runLogger };
    runLogger.info("scan_run_started", { status: scanRun.status });
    return executeTrackedScanRun(db, { runId, leaseOwner: owner, runLogger, run, signal, execution });
  });
}

async function executeTrackedScanRun(db, { runId, leaseOwner, runLogger, run, signal, execution }) {
  const localHeartbeat = leaseOwner ? null : setInterval(() => {
    try {
      heartbeatScanRun(db, {
        runId,
        processId: process.pid,
        allowUnleased: true
      });
    } catch (error) {
      runLogger.warn("scan_run_heartbeat_failed", { error: errorMeta(error) });
    }
  }, PRODUCT_POLICY.operations.scanHeartbeatMs);
  localHeartbeat?.unref?.();
  try {
    const result = await run(signal, execution);
    const status = normalizeScanTerminalStatus(result?.status || "completed");
    const finished = finishScanRun(db, {
      runId,
      leaseOwner: leaseOwner || undefined,
      status,
      stopCode: result?.stopCode,
      stopMessage: result?.stopMessage
    });
    runLogger.info("scan_run_finished", { batchId: finished.batchId, status: finished.status, stopCode: finished.stopCode });
    return result;
  } catch (error) {
    if (error?.code === "WORKFLOW_PAUSE_REQUESTED" || error?.code === "WORKFLOW_STOP_REQUESTED") {
      const finished = finishScanRun(db, {
        runId,
        leaseOwner: leaseOwner || undefined,
        status: "interrupted",
        stopCode: error.code,
        stopMessage: error?.message || String(error)
      });
      runLogger.warn("scan_run_control_settled", {
        batchId: finished.batchId,
        status: finished.status,
        stopCode: finished.stopCode,
        workflowRunId: execution?.workflowRunId || ""
      });
      if (execution?.workflowRunId) {
        finalizeWorkflowControl(db, {
          workflowRunId: execution.workflowRunId,
          now: new Date().toISOString()
        });
      }
      return {
        status: error.code === "WORKFLOW_PAUSE_REQUESTED" ? "paused" : "stopped",
        stopCode: error.code
      };
    }
    const status = scanFailureStatus(error);
    transitionWorkflowScanFailure(db, execution?.workflowRunId, status, error);
    persistBossRiskControl(db, { site: execution?.site || "boss", runId, phase: "tracked_run", error });
    try {
      const finished = finishScanRun(db, {
        runId,
        leaseOwner: leaseOwner || undefined,
        status,
        stopCode: error?.code || "SCAN_FAILED",
        stopMessage: error?.message || String(error)
      });
      runLogger.warn("scan_run_finished", { batchId: finished.batchId, status: finished.status, stopCode: finished.stopCode });
    } catch (finishError) {
      runLogger.error("scan_run_finish_failed", { status, error: errorMeta(finishError) });
    }
    throw error;
  } finally {
    if (localHeartbeat) clearInterval(localHeartbeat);
  }
}

function resolveScanModelSettingsContext(args, { root = ROOT, pathPolicy = {} } = {}) {
  if (args["model-settings-root"] === undefined) {
    return { root, readOnly: false };
  }
  const externalRoot = resolveReadOnlyModelSettingsRoot(args["model-settings-root"], {
    worktreeRoot: pathPolicy.worktreeRoot || root,
    homeRoot: pathPolicy.homeRoot || os.homedir(),
    tempRoot: pathPolicy.tempRoot || os.tmpdir()
  });
  return { root: externalRoot, readOnly: true };
}

function resolveScanModelRuntime({
  context,
  fallbackModelConfig,
  primaryResolver = resolveRuntimeModelConfig,
  backupResolver = resolveRuntimeBatchBackup
}) {
  const primaryState = primaryResolver({
    root: context.root,
    readOnly: context.readOnly,
    fallbackModelConfig,
    taskProfile: "batch_screening"
  });
  const backupState = backupResolver({
    root: context.root,
    readOnly: context.readOnly,
    fallbackModelConfig
  });
  return { primaryState, backupState };
}

async function scan(
  db,
  args,
  {
    signal = null,
    execution = null,
    resumeValidation = null,
    resolveScanModelSettingsContext: resolveContext = resolveScanModelSettingsContext,
    resolveScanModelRuntime: resolveRuntime = resolveScanModelRuntime,
    createBrowser: injectedCreateBrowser = createBrowser
  } = {}
) {
  assertScanActive(signal);
  const createBrowser = injectedCreateBrowser;
  const analysisOnly = args["analysis-only"] === true;
  let scanLogger = execution?.logger || logger;
  if (!args.plan && !args.input) {
    throw new Error("真实浏览器扫描必须传入 --plan <Search Plan ID>，避免岗位和投递状态脱离候选人画像。");
  }
  if (args["force-mock"] === true && !args.input && !analysisOnly) {
    throw new Error("真实浏览器扫描不能使用 --force-mock。请配置模型后按 Search Plan 扫描。");
  }
  let configs = loadConfigs(ROOT, {
    profile: args.profile,
    resumeVersions: args["resume-versions"]
  });
  let primaryState;
  let backupState;
  if (args["force-mock"] === true) {
    primaryState = { revision: "force-mock", concurrency: 1, modelConfig: offlineMockModelConfig() };
    backupState = null;
    configs.model = offlineMockModelConfig();
  } else {
    const modelSettingsContext = resolveContext(args);
    const runtime = resolveRuntime({
      context: modelSettingsContext,
      fallbackModelConfig: configs.model
    });
    primaryState = runtime.primaryState;
    backupState = runtime.backupState;
    configs.model = primaryState.modelConfig;
  }
  if (args["force-mock"] !== true && !isModelReady(primaryState, { taskProfile: "batch_screening" })) {
    throw codedError(
      "MODEL_CONFIGURATION_REQUIRED",
      "扫描前请先在模型设置中测试并保存批量筛选模型。"
    );
  }
  let planRecord = null;
  let matchingContext = null;
  if (args.plan) {
    planRecord = getSearchPlan(db, args.plan);
    if (!planRecord) throw new Error(`未找到 Search Plan #${args.plan}`);
    const profileRecord = getCandidateProfile(db, planRecord.profileId);
    if (!profileRecord) throw new Error(`Search Plan #${args.plan} 对应的候选人画像不存在。`);
    matchingContext = getCandidateMatchingContext(db, planRecord.profileId);
  }
  const workflowRun = resolveWorkflowScanContext(db, args, planRecord);
  const workflowAcquisitionMode = workflowRun
    ? String(workflowRun.planner?.acquisitionMode || "").trim()
    : "";
  if (workflowRun && !analysisOnly && !["generated", "inherited"].includes(workflowAcquisitionMode)) {
    throw codedError(
      "WORKFLOW_ACQUISITION_MODE_INVALID",
      "本轮任务的采集模式无效，不能安全扫描或恢复。"
    );
  }
  let acquisitionMode = workflowAcquisitionMode
    || resumeValidation?.acquisitionMode
    || (args.input ? "generated" : "");
  if (planRecord) {
    assertSearchPlanReady(
      planRecord,
      matchingContext?.candidateProfile || {},
      getSearchPlanDependency(db, planRecord.id),
      { validatePlatformCities: acquisitionMode === "generated" }
    );
    if (!matchingContext) throw new Error(`Search Plan #${args.plan} 缺少已确认匹配偏好卡对应的画像版本。`);
    configs = profileToRuntimeConfigs(
      configs,
      matchingContext.candidateProfile,
      planRecord.plan,
      listMatchingResumeVersions(db, planRecord.profileId),
      matchingContext.matchingCard
    );
  }
  if (analysisOnly) {
    return resumeWorkflowAnalysisOnly(db, {
      workflowRun,
      planRecord,
      configs,
      primaryState,
      backupState,
      signal,
      execution,
      scanLogger,
      analysisConcurrency: resolveAnalysisConcurrency(args, primaryState.concurrency)
    });
  }
  if (workflowRun && execution?.runId) {
    attachWorkflowScanRun(db, {
      id: workflowRun.id,
      scanRunId: execution.runId
    });
  }
  const frozenInherited = workflowAcquisitionMode === "inherited"
    ? {
      acquisitionMode: "inherited",
      searchTemplate: workflowRun.planner.searchTemplate,
      searchScope: workflowRun.planner.searchScope,
      keywordSource: workflowRun.planner.keywordSource,
      platformPolicy: workflowRun.planner.platformPolicy
    }
    : null;
  if (frozenInherited) {
    assertCompleteInheritedContext(frozenInherited, {
      code: "WORKFLOW_INHERITED_SNAPSHOT_INVALID",
      message: "本轮继承模式快照不完整，不能安全扫描或恢复。",
      planId: planRecord?.id
    });
  }
  const planned = workflowRun
    ? {
      keywords: workflowRun.keywords.map((item) => item.word),
      keywordPlan: workflowRun.keywords.map((item) => ({ ...item })),
      source: `workflow-run:${workflowRun.id}`
    }
    : planRecord && !args.keywords && !args.keyword
    ? (() => {
      const keywordPlan = (planRecord.plan.keywords || []).map((item) => ({ ...item }));
      return { keywords: keywordPlan.map((item) => item.word), keywordPlan, source: `search-plan:${planRecord.id}` };
    })()
    : resolvePlannedKeywords(args, configs);
  if (!planned.keywords.length) throw new Error("Search Plan 没有可用关键词，请先在页面补充后再扫描。");
  const requestedScanMode = String(args["scan-mode"] || "");
  const scanMode = workflowRun ? "daily" : requestedScanMode === "broad"
    ? "broad"
    : requestedScanMode === "daily"
      ? "daily"
      : (planRecord && !args.input ? "daily" : "broad");
  const scanPolicy = resolveScanPolicy({
    ...(planRecord?.plan || {}),
    keywords: planned.keywordPlan
  }, scanMode);
  const keywordPlan = scanPolicy.keywordPlan;
  const keywords = keywordPlan.map((item) => item.word);
  const source = `${planned.source}:${scanMode}`;
  if (!keywords.length) throw new Error(`Search Plan has no keywords for ${scanMode} scan mode.`);
  const analysisConcurrency = resolveAnalysisConcurrency(args, primaryState.concurrency);
  const site = String(args.site || planRecord?.plan?.platform?.site || "boss").trim().toLowerCase();
  const resumeBatchId = resumeValidation?.resumeBatchId
    || parseOptionalPositiveIntegerArg(args, "resume-batch");
  if (resumeBatchId && args.input) throw codedError("SCAN_RESUME_INPUT_UNSUPPORTED", "JSON 输入扫描不能恢复浏览器批次。");
  const validatedResume = resumeBatchId
    ? resumeValidation || validateResumeBatchPreflight(db, {
      resumeBatchId,
      site,
      planId: planRecord?.id
    })
    : null;
  const storedExecution = validatedResume?.storedSnapshot || null;
  const browser = createBrowser(args);
  const accessController = !args.input && site === "boss"
    ? createSiteAccessController({
      db,
      site,
      runId: execution?.runId || "",
      logger: scanLogger,
      signal,
      onReserved: workflowRun
        ? (event) => recordWorkflowPlatformAccess(db, {
          workflowRunId: workflowRun.id,
          now: event.createdAt
        })
        : null,
      assertActive: workflowRun
        ? () => assertWorkflowScanControl(db, workflowRun.id)
        : null,
      onWait: workflowRun
        ? (wait) => recordWorkflowScanWait(db, {
          workflowRunId: workflowRun.id,
          runId: execution?.runId || "",
          action: wait.action,
          delayMs: wait.delayMs,
          retryAt: wait.retryAt
        })
        : null
    })
    : null;
  const adapter = createSiteAdapter(site, { browser, logger: scanLogger, accessController });
  let browserState = null;
  const usesFixedBossSearchTab = site === "boss" && String(args.browser || "").trim().toLowerCase() === "edge";
  const preflightBrowser = async (expectedSearchTabId = null, expectedCommunicationTabId = null) => {
    try {
      if (!usesFixedBossSearchTab) return await adapter.preflight();
      return await preflightBossScanBrowser({
        browserMode: "edge",
        browser,
        adapter,
        expectedSearchTabId,
        expectedCommunicationTabId
      });
    } catch (error) {
      if (error?.code === "BOSS_RISK_CONTROL") {
        setSiteRuntimeState(db, site, {
          status: "blocked",
          reasonCode: error.code,
          message: error.message,
          details: { phase: "preflight" }
        });
      }
      throw error;
    }
  };
  const runWithBoundFixedBossSearchAction = async (action) => {
    if (!usesFixedBossSearchTab) return action(browserState);
    try {
      return await runWithBoundBossScanBrowser({
        browserMode: "edge",
        browser,
        adapter,
        expectedSearchTabId: browserState.tabId,
        expectedCommunicationTabId: browserState.communicationTabId,
        action: async (nextBrowserState) => {
          browserState = nextBrowserState;
          assertScanActive(signal);
          return action(nextBrowserState);
        }
      });
    } catch (error) {
      if (error?.code === "BOSS_RISK_CONTROL") {
        setSiteRuntimeState(db, site, {
          status: "blocked",
          reasonCode: error.code,
          message: error.message,
          details: { phase: "preflight" }
        });
      }
      throw error;
    }
  };
  let plannedCityScopes = acquisitionMode === "generated"
    ? resolveCityScopes(args, planRecord, configs)
    : null;
  if (!args.input) {
    browserState = await preflightBrowser();
    assertScanActive(signal);
    const priorRuntimeState = getSiteRuntimeState(db, site);
    if (priorRuntimeState?.status === "blocked") {
      clearSiteRuntimeState(db, site);
      scanLogger.info("site_runtime_block_cleared", { site, priorReasonCode: priorRuntimeState.reasonCode });
    }
  }
  let directSearchContext = null;
  if (!workflowRun && !args.input) {
    directSearchContext = resolveBossSearchContext({
      currentUrl: browserState?.url || browserState?.tab?.url || "",
      storedTemplate: storedExecution?.searchTemplate,
      cityScopes: plannedCityScopes || []
    });
    if (!acquisitionMode) acquisitionMode = directSearchContext.searchTemplate.mode;
  }
  if (acquisitionMode === "generated" && !plannedCityScopes) {
    assertSearchPlanReady(
      planRecord,
      matchingContext?.candidateProfile || {},
      getSearchPlanDependency(db, planRecord.id)
    );
    plannedCityScopes = resolveCityScopes(args, planRecord, configs);
    if (directSearchContext) {
      directSearchContext = resolveBossSearchContext({
        currentUrl: browserState?.url || browserState?.tab?.url || "",
        storedTemplate: storedExecution?.searchTemplate,
        cityScopes: plannedCityScopes
      });
    }
  }
  let searchTemplate;
  let cityScopes = plannedCityScopes || [];
  let searchScope = {};
  let keywordSource = {};
  let platformPolicy = {};
  if (frozenInherited) {
    configs = applyPlatformRuntimePolicy(configs, frozenInherited.platformPolicy);
    searchTemplate = frozenInherited.searchTemplate;
    searchScope = frozenInherited.searchScope;
    keywordSource = frozenInherited.keywordSource;
    platformPolicy = frozenInherited.platformPolicy;
    cityScopes = [{
      city: platformPolicy.filters?.location?.cities?.[0] || "",
      cityCode: searchTemplate.cityCode || "platform-default"
    }];
  } else if (workflowAcquisitionMode === "generated") {
    searchTemplate = { mode: "generated", url: "", cityCode: "" };
    cityScopes = plannedCityScopes;
  } else {
    const searchContext = args.input
      ? { searchTemplate: { mode: "generated", url: "", cityCode: "" }, cityScopes: plannedCityScopes }
      : directSearchContext || resolveBossSearchContext({
        currentUrl: browserState?.url || browserState?.tab?.url || "",
        storedTemplate: storedExecution?.searchTemplate,
        cityScopes: plannedCityScopes || []
      });
    searchTemplate = searchContext.searchTemplate;
    cityScopes = searchContext.cityScopes;
    if (searchTemplate.mode === "inherited") {
      if (resumeBatchId && storedExecution) {
        searchScope = storedExecution.searchScope || {};
        keywordSource = storedExecution.keywordSource || {};
        platformPolicy = storedExecution.platformPolicy || {};
        assertInheritedAcquisitionScope(searchScope);
      } else {
        const inspected = await runWithBoundFixedBossSearchAction((state) =>
          adapter.inspectInheritedSearchPage({ tabId: state.tabId })
        );
        ({ searchTemplate, searchScope } = buildInheritedSearchScope({
          profileId: planRecord.profileId,
          rawUrl: inspected.url
        }));
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
        keywordSource = freezeKeywordSource({
          planRecord,
          matchingCardRevision: matchingCardRevision(matchingContext.matchingCard)
        });
        platformPolicy = compilePlatformRuntimePolicy({
          searchScope,
          catalog,
          urlOptions: inspected.urlOptions,
          cityCodes: CITY_CODES
        });
      }
      configs = applyPlatformRuntimePolicy(configs, platformPolicy);
      cityScopes = [{
        city: platformPolicy.filters?.location?.cities?.[0] || "",
        cityCode: searchTemplate.cityCode || "platform-default"
      }];
    }
  }
  const generatedFilterCatalog = !args.input && searchTemplate.mode !== "inherited"
    ? await runWithBoundFixedBossSearchAction((state) =>
      resolveBossPlatformFilters({ db, adapter, args, plan: planRecord?.plan, cityScopes, keyword: keywords[0], tabId: state.tabId, logger: scanLogger })
    )
    : null;
  const nativeFilterSnapshot = args.input
    ? { site, scanMode, params: {}, labels: {}, lanes: [] }
    : searchTemplate.mode === "inherited"
      ? { site, scanMode, source: "search_template", params: {}, labels: {}, lanes: [] }
      : applyScanPolicyToFilters(
        generatedFilterCatalog,
        scanPolicy
      );
  if (!args.input) {
    console.error(searchTemplate.mode === "inherited"
      ? `[platform] BOSS 预筛：继承当前搜索页（仅替换关键词）`
      : `[platform] BOSS 预筛：${formatNativeFilterSummary(nativeFilterSnapshot) || "未命中可用原生条件"}`);
  }
  if (searchTemplate.mode === "inherited") {
    scanLogger.info("inherited_scan_context_ready", {
      site,
      scopeId: scopeShortId(searchScope.key),
      platformPolicyHash: platformPolicy.hash || "",
      recommendationPolicyHash: configs.recommendationPolicyHash || "",
      keywordCatalogHash: keywordSource.catalogHash || ""
    });
  }
  const analyzeJob = createJobAnalysisRunner(configs, keywordPlan, { db, logger: scanLogger });
  assertScanLimitOverridesAllowed(args, scanMode, Boolean(workflowRun));
  const workflowMaxCards = workflowRun
    ? Math.max(...workflowRun.keywords.map((item) => Number(item.maxCards) || 0))
    : 0;
  const scanLimits = {
    maxCards: workflowRun ? workflowMaxCards
      : resolveScanLimit(args, "max-cards", scanPolicy.maxCards, scanPolicy.maxCards, "maxCards"),
    maxDetailTotal: workflowRun ? Number(workflowRun.budget.maxDetailTotal)
      : resolveScanLimit(args, "max-detail-total", scanPolicy.maxDetailTotal, scanPolicy.maxDetailTotal, "maxDetailTotal"),
    browserPageBudget: workflowRun ? Number(workflowRun.budget.browserPageBudget)
      : resolveScanLimit(args, "browser-page-budget", scanPolicy.browserPageBudget, scanPolicy.browserPageBudget, "browserPageBudget"),
    detailLimits: scanPolicy.detailLimits,
    supplementalSalaryLaneKeywordLimit: scanPolicy.supplementalSalaryLaneKeywordLimit,
    supplementalSalaryLaneCardLimit: scanPolicy.supplementalSalaryLaneCardLimit,
    supplementalSalaryLaneDetailLimit: scanPolicy.supplementalSalaryLaneDetailLimit
  };
  const runtimePolicyHash = searchTemplate.mode === "inherited"
    ? stableHash({
      productPolicyVersion: scanPolicy.policyVersion,
      scanMode,
      platformPolicyHash: platformPolicy.hash
    })
    : scanPolicy.policyHash;
  const executionSnapshot = args.input ? null : buildScanExecutionSnapshot({
    site,
    scanKind: scanMode,
    runtimePolicyHash,
    recommendationPolicyHash: configs.recommendationPolicyHash || "",
    searchTemplate,
    searchScope,
    keywordSource,
    platformPolicy,
    cityScopes,
    keywordPlan,
    nativeFilters: nativeFilterSnapshot,
    limits: scanLimits
  });
  const reusableDetails = new Map((args.input ? [] : listReusableJobDetails(db, {
    site,
    profileId: planRecord?.profileId,
    maxAgeDays: PRODUCT_POLICY.operations.detailCacheMaxAgeDays
  })).map((item) => [item.sourceId, item]));
  if (reusableDetails.size) scanLogger.info("boss_reusable_details_loaded", { count: reusableDetails.size, maxAgeDays: PRODUCT_POLICY.operations.detailCacheMaxAgeDays });
  let batchId;
  let resumeTargetKeys;
  if (resumeBatchId) {
    const resume = resolveResumeBatch(db, {
      resumeBatchId,
      site,
      planId: planRecord?.id,
      executionSnapshot
    });
    resumeTargetKeys = resume.targetKeys;
    batchId = resume.batchId;
    scanLogger.info("scan_resume_prepared", {
      batchId,
      snapshotHash: executionSnapshot.snapshotHash,
      ...resume.progress
    });
  } else {
    const note = args.input ? `json-input:${source}` : `browser:${args.browser || "none"}:${source}`;
    const context = {
      status: "running",
      profileId: planRecord?.profileId,
      searchPlanId: planRecord?.id,
      filterSnapshot: {
        ...nativeFilterSnapshot,
        runtimePolicy: scanPolicy.snapshot,
        runtimePolicyHash,
        searchTemplate,
        ...(executionSnapshot ? { execution: executionSnapshot } : {})
      }
    };
    batchId = execution
      ? createAndBindScanBatch(db, {
        runId: execution.runId,
        leaseOwner: execution.leaseOwner,
        processId: process.pid,
        site,
        keyword: keywords.join(", "),
        note,
        ...context
      })
      : createBatch(db, site, keywords.join(", "), note, context);
  }
  if (execution) {
    beginScanRun(db, {
      runId: execution.runId,
      batchId,
      leaseOwner: execution.leaseOwner,
      processId: process.pid
    });
    if (workflowRun) {
      attachWorkflowScan(db, {
        id: workflowRun.id,
        scanRunId: execution.runId,
        scanBatchId: batchId
      });
    }
    if (scanLogger.child) {
      scanLogger = scanLogger.child(workflowLogContext({
        ...(workflowRun || {}),
        scanRunId: execution.runId,
        scanBatchId: batchId
      }));
    }
  }
  for (const keyword of keywords) upsertKeywordSource(db, keyword, source);
  scanLogger.info("scan_started", {
    batchId,
    planId: planRecord?.id || null,
    keywordCount: keywords.length,
    source,
    scanMode,
    runtimePolicyVersion: scanPolicy.policyVersion,
    runtimePolicyHash,
    browser: args.browser || "input",
    hasInput: Boolean(args.input),
    analysisConcurrency,
    nativeFilters: args.input ? null : nativeFilterSnapshot,
    searchTemplate: args.input ? null : {
      mode: searchTemplate.mode,
      cityCode: searchTemplate.cityCode || "",
      scopeId: searchTemplate.mode === "inherited" ? scopeShortId(searchScope.key) : ""
    },
    scanLimits,
    resumeBatchId: resumeBatchId || null,
    resumeTargetCount: resumeTargetKeys?.length ?? null,
    modelProvider: configs.model?.provider || "mock",
    model: configs.model?.providers?.[configs.model?.provider || "mock"]?.model || ""
  });

  let checkpointed = 0;
  let scanSummary = null;
  const onTargetComplete = args.input ? null : async (result) => {
    assertScanActive(signal);
    try {
      const jobs = (result.jobs || []).map((raw) => checkpointScannedJob(raw, configs));
      checkpointScanTarget(db, {
        runId: execution.runId,
        batchId,
        leaseOwner: execution.leaseOwner,
        target: result,
        jobs
      });
      checkpointed += jobs.length;
    } catch (error) {
      if (["SCAN_LEASE_LOST", "SCAN_RUN_LEASE_MISMATCH"].includes(error?.code)) {
        throw error;
      }
      const checkpointError = new Error(`扫描目标 ${result.targetKey} 保存失败：${error.message}`);
      checkpointError.code = "SCAN_CHECKPOINT_FAILED";
      checkpointError.cause = error;
      throw checkpointError;
    }
    scanLogger.info("scan_target_checkpointed", {
      batchId,
      targetKey: result.targetKey,
      status: result.status,
      jobCount: result.jobCount,
      checkpointed
    });
    if (workflowRun) assertWorkflowScanControl(db, workflowRun.id);
  };

  if (workflowRun) assertWorkflowScanControl(db, workflowRun.id);
  const rawJobs = await runWithBoundFixedBossSearchAction((state) => adapter.scan({
    input: args.input,
    tabId: state?.tabId,
    keywords,
    keywordPlan,
    cityScopes,
    nativeFilters: nativeFilterSnapshot,
    searchTemplate,
    browserPageBudget: scanLimits.browserPageBudget,
    maxCards: scanLimits.maxCards,
    maxDetailTotal: scanLimits.maxDetailTotal,
    detailLimits: scanLimits.detailLimits,
    supplementalSalaryLaneKeywordLimit: scanLimits.supplementalSalaryLaneKeywordLimit,
    supplementalSalaryLaneCardLimit: scanLimits.supplementalSalaryLaneCardLimit,
    supplementalSalaryLaneDetailLimit: scanLimits.supplementalSalaryLaneDetailLimit,
    targetKeys: resumeTargetKeys,
    pacingState: validatedResume?.runtime?.bossPacing || null,
    scoreQuick: (job) => scoreJob(job, configs).score,
    shouldReadDetail: (job) => decisionState(scoreJob({ ...job, detailRequired: true }, configs)) !== "blocked",
    getReusableDetail: (job) => reusableDetails.get(job.sourceId),
    onRiskControl: async (risk) => {
      setSiteRuntimeState(db, site, {
        status: "blocked",
        reasonCode: risk.errorCode || "BOSS_RISK_CONTROL",
        message: risk.errorMessage || "BOSS 要求安全验证，扫描已暂停。",
        details: { batchId, detailsRead: risk.detailsRead, candidates: risk.candidates }
      });
      recordSiteAccessEvent(db, {
        site,
        action: "risk_control",
        runId: execution?.runId || "",
        details: { batchId, errorCode: risk.errorCode || "BOSS_RISK_CONTROL", errorMessage: risk.errorMessage || "" }
      });
    },
    onTargetComplete,
    onDetailCheckpoint: args.input ? null : async (result) => {
      assertScanActive(signal);
      try {
        const job = checkpointScannedJob(result.job, configs);
        checkpointScanProgress(db, {
          runId: execution.runId,
          batchId,
          leaseOwner: execution.leaseOwner,
          jobs: [job]
        });
      } catch (error) {
        if (["SCAN_LEASE_LOST", "SCAN_RUN_LEASE_MISMATCH"].includes(error?.code)) {
          throw error;
        }
        const checkpointError = new Error(`扫描详情 ${result.job?.sourceId || result.job?.url || ""} 保存失败：${error.message}`);
        checkpointError.code = "SCAN_CHECKPOINT_FAILED";
        checkpointError.cause = error;
        throw checkpointError;
      }
    },
    onPacingCheckpoint: args.input ? null : async (pacingState) => {
      checkpointScanProgress(db, {
        runId: execution.runId,
        batchId,
        leaseOwner: execution.leaseOwner,
        jobs: [],
        runtime: { bossPacing: pacingState }
      });
    },
    onDetailResult: args.input ? null : async (result) => persistDetailOutcome(db, {
      site,
      runId: execution?.runId || "",
      batchId,
      result
    }),
    onScanComplete: (summary) => { scanSummary = summary; },
    signal,
    assertTabBindings: usesFixedBossSearchTab
      ? async () => assertBossRuntimeTabBindings(await browser.listTabs(), {
        expectedSearchTabId: state.tabId,
        expectedCommunicationTabId: state.communicationTabId
      })
      : null
  }));
  assertScanActive(signal);

  const detailCoverage = args.input ? null : {
    collected: rawJobs.length,
    hardFiltered: rawJobs.filter((job) => !job.detailRequired).length,
    detailRequired: rawJobs.filter((job) => job.detailRequired).length,
    detailRead: rawJobs.filter((job) => job.detailRequired && job.detailRead).length,
    detailsReused: rawJobs.filter((job) => job.detailRequired && job.detailRead && job.detailReused).length,
    detailPending: rawJobs.filter((job) => job.detailRequired && !job.detailRead).length,
    detailFailed: rawJobs.filter((job) => job.detailRequired
      && !job.detailRead
      && job.detailErrorCode
      && !["BOSS_DETAIL_SAFETY_LIMIT", "BOSS_DETAIL_FAIR_SHARE_PENDING"].includes(job.detailErrorCode)).length
  };
  if (detailCoverage) scanLogger.info("boss_detail_coverage", { batchId, ...detailCoverage });
  let jobsToAnalyze;
  if (workflowRun) {
    if (args.input) {
      for (const raw of rawJobs) upsertJob(db, checkpointScannedJob(raw, configs), batchId);
    }
    jobsToAnalyze = listReportJobs(db, { batchId, limit: 10000 });
  } else {
    const analysisCandidates = new Map();
    if (resumeBatchId) {
      for (const job of listReportJobs(db, { batchId, limit: 10000 })) {
        if (job.analysis?.semanticStatus === "pending" || job.analysis?.decisionSource === "analysis_pending") {
          analysisCandidates.set(job.sourceId || job.url || String(job.id), job);
        }
      }
    }
    for (const job of rawJobs) analysisCandidates.set(job.sourceId || job.url, job);
    jobsToAnalyze = [...analysisCandidates.values()];
  }
  const targetSummary = executionSnapshot
    ? summarizeResumePlan(executionSnapshot, listLatestScanTargetResults(db, batchId))
    : null;
  const finalStatus = resolveScanTerminalStatus({ targetSummary, scanSummary });
  const defaultStopCode = finalStatus === "partial"
    ? "SCAN_TARGETS_PARTIAL"
    : finalStatus === "failed" ? "SCAN_TARGETS_FAILED" : "";
  scanLogger.info("job_analysis_started", { batchId, jobCount: jobsToAnalyze.length, analysisConcurrency, resumedPending: Math.max(0, jobsToAnalyze.length - rawJobs.length) });

  let workflowAnalysisSummary = null;
  let report = null;
  if (workflowRun) {
    const access = workflowAccessUsage(db, execution?.runId || workflowRun.scanRunId);
    assertScanActive(signal);
    workflowAnalysisSummary = await runWorkflowAnalysisPhase(db, {
      workflowRun,
      batchId,
      jobsToAnalyze,
      configs,
      keywordPlan,
      logger: scanLogger,
      signal,
      modelRuntimes: { primary: primaryState, backup: backupState },
      analyzeScannedJob: (raw, { configs: runtimeConfigs, analyzeJob }) => analyzeScannedJob(raw, {
        configs: { ...configs, model: runtimeConfigs?.model || configs.model },
        analyzeJob
      }),
      metrics: workflowMetrics({ detailCoverage, rawJobs, analyzed: 0, saved: 0, access }),
      reviewIfDrained: finalStatus === "completed",
      renderReports: (phaseDb, phaseBatchId, { counts }) => {
        const savedCount = completedWorkflowAnalysisCount(counts);
        report = renderReports(listReportJobs(phaseDb, { batchId: phaseBatchId }), path.join(ROOT, "reports"));
        scanLogger.info("scan_completed", {
          batchId: phaseBatchId,
          saved: savedCount,
          reportMarkdown: path.basename(report.mdPath),
          reportHtml: path.basename(report.htmlPath)
        });
        console.log(`导入 ${savedCount} 个岗位`);
        console.log(`Markdown: ${report.mdPath}`);
        console.log(`HTML: ${report.htmlPath}`);
      }
    });
    if (workflowAnalysisSummary.status === "paused" || workflowAnalysisSummary.status === "stopped") {
      finalizeWorkflowControl(db, {
        workflowRunId: workflowRun.id,
        now: new Date().toISOString()
      });
      const controlledStopCode = workflowAnalysisSummary.status === "paused"
        ? "WORKFLOW_PAUSE_REQUESTED"
        : "WORKFLOW_STOP_REQUESTED";
      return {
        status: "interrupted",
        batchId,
        stopCode: controlledStopCode,
        stopMessage: `workflow analysis ${workflowAnalysisSummary.status}`
      };
    }
    if (workflowAnalysisSummary.status === "interrupted") {
      return {
        status: "interrupted",
        batchId,
        stopCode: workflowAnalysisSummary.errorCode || "SCAN_ABORTED",
        stopMessage: "workflow analysis interrupted at a safe boundary"
      };
    }
    if (workflowAnalysisSummary.status === "drained" && finalStatus !== "completed") {
      const inventoryCount = listWorkflowInventory(db, { planId: planRecord.id }).length;
      const metrics = workflowMetrics({
        detailCoverage,
        rawJobs,
        analyzed: workflowAnalysisSummary.succeeded + workflowAnalysisSummary.skipped,
        saved: workflowAnalysisSummary.succeeded + workflowAnalysisSummary.skipped,
        inventoryCount,
        access
      });
      transitionWorkflowRun(db, {
        id: workflowRun.id,
        status: "interrupted",
        inventoryCount,
        metrics,
        errorCode: scanSummary?.fatalErrorCode || defaultStopCode || "SCAN_INCOMPLETE",
        errorMessage: scanSummary?.fatalErrorMessage || "scan did not complete all planned targets"
      });
    }
  } else {
    const analyzedJobs = await mapWithConcurrency(jobsToAnalyze, analysisConcurrency, (raw) => {
      assertScanActive(signal);
      return analyzeScannedJob(raw, { configs, analyzeJob });
    });
    assertScanActive(signal);
    let saved = 0;
    for (const job of analyzedJobs) {
      upsertJob(db, job, batchId);
      saved += 1;
    }
    scanLogger.info("job_analysis_completed", { batchId, jobCount: analyzedJobs.length, analysisConcurrency });
    report = renderReports(listReportJobs(db, { batchId }), path.join(ROOT, "reports"));
    scanLogger.info("scan_completed", { batchId, saved, reportMarkdown: path.basename(report.mdPath), reportHtml: path.basename(report.htmlPath) });
    console.log(`导入 ${saved} 个岗位`);
    console.log(`Markdown: ${report.mdPath}`);
    console.log(`HTML: ${report.htmlPath}`);
  }
  if (detailCoverage) {
    console.log(`详情覆盖：应读 ${detailCoverage.detailRequired}，成功 ${detailCoverage.detailRead}，待补 ${detailCoverage.detailPending}；左栏明确排除 ${detailCoverage.hardFiltered}`);
  }
  return {
    status: finalStatus,
    batchId,
    stopCode: scanSummary?.fatalErrorCode || defaultStopCode,
    stopMessage: scanSummary?.fatalErrorMessage || ""
  };
}

async function resumeWorkflowAnalysisOnly(db, {
  workflowRun,
  planRecord,
  configs,
  primaryState,
  backupState,
  signal,
  execution,
  scanLogger,
  analysisConcurrency
}) {
  if (!workflowRun || workflowRun.status !== "analyzing") {
    throw codedError(
      "WORKFLOW_ANALYSIS_STATUS_INVALID",
      "Analysis-only resume requires an analyzing workflow run."
    );
  }
  const batchId = Number(workflowRun.scanBatchId || 0);
  const batch = batchId ? getBatch(db, batchId) : null;
  if (!batch
    || batch.site !== "boss"
    || Number(batch.searchPlanId || 0) !== Number(planRecord?.id || 0)
    || Number(batch.profileId || 0) !== Number(workflowRun.profileId)) {
    throw codedError(
      "WORKFLOW_ANALYSIS_BATCH_MISMATCH",
      "The persisted analysis batch does not belong to this workflow."
    );
  }
  if (!execution?.runId) {
    throw codedError(
      "WORKFLOW_ANALYSIS_EXECUTION_REQUIRED",
      "Analysis-only resume requires a persisted execution run."
    );
  }
  attachWorkflowScan(db, {
    id: workflowRun.id,
    scanRunId: execution.runId,
    scanBatchId: batchId
  });

  const jobsToAnalyze = listReportJobs(db, { batchId, limit: 10000 });
  const keywordPlan = workflowRun.keywords.map((item) => ({ ...item }));
  scanLogger.info("job_analysis_started", {
    batchId,
    jobCount: jobsToAnalyze.length,
    analysisConcurrency,
    resumedPending: jobsToAnalyze.length,
    analysisOnly: true
  });
  assertScanActive(signal);
  let report = null;
  const summary = await runWorkflowAnalysisPhase(db, {
    workflowRun,
    batchId,
    jobsToAnalyze,
    configs,
    keywordPlan,
    logger: scanLogger,
    signal,
    modelRuntimes: { primary: primaryState, backup: backupState },
    analyzeScannedJob: (raw, { configs: runtimeConfigs, analyzeJob }) => analyzeScannedJob(raw, {
      configs: { ...configs, model: runtimeConfigs?.model || configs.model },
      analyzeJob
    }),
    metrics: workflowRun.metrics || {},
    reviewIfDrained: true,
    renderReports: (phaseDb, phaseBatchId, { counts }) => {
      const savedCount = completedWorkflowAnalysisCount(counts);
      report = renderReports(
        listReportJobs(phaseDb, { batchId: phaseBatchId }),
        path.join(ROOT, "reports")
      );
      scanLogger.info("scan_completed", {
        batchId: phaseBatchId,
        saved: savedCount,
        reportMarkdown: path.basename(report.mdPath),
        reportHtml: path.basename(report.htmlPath),
        analysisOnly: true
      });
      console.log(`导入 ${savedCount} 个岗位`);
      console.log(`Markdown: ${report.mdPath}`);
      console.log(`HTML: ${report.htmlPath}`);
    }
  });

  if (summary.status === "paused" || summary.status === "stopped") {
    finalizeWorkflowControl(db, {
      workflowRunId: workflowRun.id,
      now: new Date().toISOString()
    });
    return {
      status: "interrupted",
      batchId,
      stopCode: summary.status === "paused"
        ? "WORKFLOW_PAUSE_REQUESTED"
        : "WORKFLOW_STOP_REQUESTED",
      stopMessage: `workflow analysis ${summary.status}`
    };
  }
  if (summary.status === "interrupted") {
    return {
      status: "interrupted",
      batchId,
      stopCode: summary.errorCode || "SCAN_ABORTED",
      stopMessage: "workflow analysis interrupted at a safe boundary"
    };
  }
  return { status: "completed", batchId };
}

async function analyzeScannedJob(raw, { configs, analyzeJob }) {
  const scored = scoreJob(raw, configs);
  const gate = decisionState(scored);
  const baseAnalysis = gate === "ready"
    ? await analyzeJob({ ...raw, ...scored, greeting: raw.greeting || "" })
    : ruleGateAnalysis({ ...raw, ...scored, greeting: raw.greeting || "" }, gate);
  const analysis = {
    ...baseAnalysis,
    workSchedule: scored.workSchedule,
    workScheduleEvidence: scored.workScheduleEvidence
  };
  return { ...raw, ...scored, analysis, greeting: raw.greeting || "" };
}

function checkpointScannedJob(raw, configs) {
  const scored = scoreJob(raw, configs);
  const gate = decisionState(scored);
  const analysis = gate === "ready"
    ? {
      provider: "scan-checkpoint",
      model: "",
      semanticStatus: "pending",
      decisionSource: "analysis_pending",
      recommendation: null,
      decisionStatus: "needs_retry",
      fitLevel: null,
      confidence: null,
      fitReasons: ["岗位来源事实已保存，等待本批语义分析完成。"],
      hardBlockers: [],
      softGaps: [],
      questionsToVerify: scored.risks || [],
      missingPoints: [],
      blockingGaps: [],
      riskQuestions: scored.risks || [],
      evidence: { jd: [], resume: [] },
      greeting: "",
      workSchedule: scored.workSchedule,
      workScheduleEvidence: scored.workScheduleEvidence
    }
    : {
      ...ruleGateAnalysis({ ...raw, ...scored }, gate),
      workSchedule: scored.workSchedule,
      workScheduleEvidence: scored.workScheduleEvidence
    };
  return { ...raw, ...scored, analysis, greeting: "" };
}

async function refreshDetails(db, args, { signal = null, execution = null } = {}) {
  assertScanActive(signal);
  const scanLogger = execution?.logger || logger;
  const activityOnly = args["activity-only"] === true;
  const planId = Number(args.plan);
  if (!Number.isInteger(planId) || planId <= 0) throw new Error("需要 --plan <Search Plan ID>");
  const planRecord = getSearchPlan(db, planId);
  if (!planRecord) throw new Error(`未找到 Search Plan #${planId}`);
  const profileRecord = getCandidateProfile(db, planRecord.profileId);
  if (!profileRecord) throw new Error(`Search Plan #${planId} 对应的候选人画像不存在。`);
  const matchingContext = getCandidateMatchingContext(db, planRecord.profileId);
  assertSearchPlanReady(planRecord, matchingContext?.candidateProfile || {}, getSearchPlanDependency(db, planRecord.id));
  if (!matchingContext) throw new Error(`Search Plan #${planId} 缺少已确认匹配偏好卡对应的画像版本。`);
  let configs = loadConfigs(ROOT);
  const batchModelState = resolveRuntimeModelConfig({
    root: ROOT,
    fallbackModelConfig: configs.model,
    taskProfile: "batch_screening"
  });
  if (!isModelReady(batchModelState, { taskProfile: "batch_screening" })) {
    throw codedError(
      "MODEL_CONFIGURATION_REQUIRED",
      "补读岗位前请先在模型设置中测试并保存批量筛选模型。"
    );
  }
  configs.model = batchModelState.modelConfig;
  configs = profileToRuntimeConfigs(configs, matchingContext.candidateProfile, planRecord.plan, listMatchingResumeVersions(db, planRecord.profileId), matchingContext.matchingCard);
  const browser = createBrowser(args);
  if (!browser) throw new Error("补读岗位详情需要 --browser edge 或 --browser portable。");
  const accessController = createSiteAccessController({ db, site: "boss", runId: execution?.runId || "", logger: scanLogger, signal });
  const adapter = createSiteAdapter("boss", { browser, logger: scanLogger, accessController });
  const usesFixedBossSearchTab = String(args.browser || "").trim().toLowerCase() === "edge";
  const preflightBrowser = async (expectedSearchTabId = null, expectedCommunicationTabId = null) => {
    try {
      return await preflightBossScanBrowser({
        browserMode: usesFixedBossSearchTab ? "edge" : args.browser,
        browser,
        adapter,
        expectedSearchTabId,
        expectedCommunicationTabId
      });
    } catch (error) {
      if (error?.code === "BOSS_RISK_CONTROL") {
        setSiteRuntimeState(db, "boss", {
          status: "blocked",
          reasonCode: error.code,
          message: error.message,
          details: { phase: "preflight" }
        });
      }
      throw error;
    }
  };
  let browserState = await preflightBrowser();
  const runWithBoundFixedBossRefreshAction = async (action) => {
    if (!usesFixedBossSearchTab) return action(browserState);
    try {
      return await runWithBoundBossScanBrowser({
        browserMode: "edge",
        browser,
        adapter,
        expectedSearchTabId: browserState.tabId,
        expectedCommunicationTabId: browserState.communicationTabId,
        action: async (nextBrowserState) => {
          browserState = nextBrowserState;
          assertScanActive(signal);
          return action(nextBrowserState);
        }
      });
    } catch (error) {
      if (error?.code === "BOSS_RISK_CONTROL") {
        setSiteRuntimeState(db, "boss", {
          status: "blocked",
          reasonCode: error.code,
          message: error.message,
          details: { phase: "preflight" }
        });
      }
      throw error;
    }
  };
  assertScanActive(signal);

  const keywordPlan = (planRecord.plan.keywords || []).map((item) => ({ ...item }));
  const analyzeJob = createJobAnalysisRunner(configs, keywordPlan, { db, logger: scanLogger });
  const analysisConcurrency = resolveAnalysisConcurrency(args, batchModelState.concurrency);
  const limit = Math.max(1, Math.min(PRODUCT_POLICY.operations.refreshLimit, Number(args.limit) || PRODUCT_POLICY.operations.refreshLimit));
  const pending = listDecisionPool(db, { planId })
    .filter((job) => {
      const tags = new Set(job.qualityTags || []);
      const status = job.applicationStatus || "pending";
      const lastAttempt = getLatestJobRefreshAttempt(db, job.id);
      const coolingDown = lastAttempt?.nextRetryAt && Date.parse(lastAttempt.nextRetryAt) > Date.now();
      const common = job.source === "boss"
        && job.url
        && !coolingDown
        && job.decisionBucket === "refresh"
        && ["pending", "review", "later"].includes(status);
      if (!common) return false;
      if (activityOnly) return isActivityProbeDue(job, { maxActiveDays: planRecord.plan.bossActiveDays });
      return tags.has("detail_unverified") || tags.has("activity_unverified");
    })
    .sort((a, b) => Number((a.qualityTags || []).includes("detail_unverified")) - Number((b.qualityTags || []).includes("detail_unverified")))
    .slice(0, limit);
  if (!pending.length) {
    console.log(activityOnly ? "当前没有超过 3 天有效期、需要更新活跃状态的历史岗位。" : "当前没有需要补读的岗位详情。");
    return { status: "completed", batchId: null };
  }

  const refreshKind = activityOnly ? "activity-probe" : "detail-refresh";
  const note = `browser:${args.browser || "none"}:${refreshKind}:plan:${planId}`;
  const batchContext = {
    status: "running",
    profileId: planRecord.profileId,
    searchPlanId: planId,
    filterSnapshot: { mode: refreshKind, requested: pending.length }
  };
  const batchId = execution
    ? createAndBindScanBatch(db, {
      runId: execution.runId,
      leaseOwner: execution.leaseOwner,
      processId: process.pid,
      site: "boss",
      keyword: refreshKind,
      note,
      ...batchContext
    })
    : createBatch(db, "boss", refreshKind, note, batchContext);
  if (execution) {
    beginScanRun(db, {
      runId: execution.runId,
      batchId,
      leaseOwner: execution.leaseOwner,
      processId: process.pid
    });
  }
  scanLogger.info(activityOnly ? "activity_probe_started" : "detail_refresh_started", { batchId, planId, requested: pending.length, browser: args.browser, analysisConcurrency });
  const refreshMethod = activityOnly ? adapter.probeActivities.bind(adapter) : adapter.refreshDetails.bind(adapter);
  const attemptCounts = { success: 0, failed: 0 };
  const rawJobs = await runWithBoundFixedBossRefreshAction((state) => refreshMethod(pending, {
    limit,
    tabId: state.tabId,
    signal,
    assertTabBindings: usesFixedBossSearchTab
      ? async () => assertBossRuntimeTabBindings(await browser.listTabs(), {
        expectedSearchTabId: state.tabId,
        expectedCommunicationTabId: state.communicationTabId
      })
      : null,
    onAttempt: async (attempt) => {
      assertScanActive(signal);
      persistRefreshAttempt(db, attempt, { batchId, activityOnly });
      if (Object.hasOwn(attemptCounts, attempt.result)) attemptCounts[attempt.result] += 1;
    }
  }));
  assertScanActive(signal);
  const analyzedJobs = await mapWithConcurrency(rawJobs, analysisConcurrency, (raw) => {
    assertScanActive(signal);
    return activityOnly
      ? analyzeActivityProbe(raw, { configs, analyzeJob })
      : analyzeScannedJob(raw, { configs, analyzeJob });
  });
  assertScanActive(signal);
  for (const job of analyzedJobs) upsertJob(db, job, batchId);
  const report = renderReports(listReportJobs(db, { batchId, limit: 500 }), path.join(ROOT, "reports"));
  scanLogger.info(activityOnly ? "activity_probe_completed" : "detail_refresh_completed", { batchId, planId, requested: pending.length, refreshed: analyzedJobs.length });
  console.log(`${activityOnly ? "活跃状态更新" : "补读"}完成：请求 ${pending.length} 条，成功 ${analyzedJobs.length} 条`);
  console.log(`Markdown: ${report.mdPath}`);
  console.log(`HTML: ${report.htmlPath}`);
  const status = analyzedJobs.length === pending.length
    ? "completed"
    : analyzedJobs.length > 0 ? "partial" : "failed";
  return {
    status,
    batchId,
    stopCode: status === "completed" ? "" : status === "partial" ? "REFRESH_PARTIAL" : "REFRESH_FAILED",
    stopMessage: status === "completed" ? "" : `${attemptCounts.failed} of ${pending.length} refresh attempt(s) failed.`
  };
}

function persistRefreshAttempt(db, attempt, { batchId, activityOnly = false } = {}) {
  const result = String(attempt?.result || "");
  if (result === "success") {
    if (!attempt.refreshedJob) {
      throw codedError("REFRESH_RESULT_MISSING", "成功的补读结果缺少岗位数据，未记录成功状态。");
    }
    upsertJob(db, attempt.refreshedJob, batchId);
  }
  const nextRetryAt = result === "failed"
    ? refreshRetryAt(attempt.errorCode)
    : activityOnly
      ? new Date(Date.now() + PRODUCT_POLICY.operations.activityRefreshDays * 24 * 60 * 60 * 1000).toISOString()
      : "";
  recordJobRefreshAttempt(db, {
    jobId: attempt.job.id,
    result,
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
    nextRetryAt
  });
  return nextRetryAt;
}

async function analyzeActivityProbe(raw, { configs, analyzeJob }) {
  const scored = scoreJob(raw, configs);
  const existing = raw.analysis || {};
  if (decisionState(scored) === "ready" && ["complete", "partial"].includes(existing.semanticStatus)) {
    return {
      ...raw,
      ...scored,
      analysis: { ...existing, workSchedule: scored.workSchedule, workScheduleEvidence: scored.workScheduleEvidence }
    };
  }
  return analyzeScannedJob(raw, { configs, analyzeJob });
}

function resolveAnalysisConcurrency(args, configuredConcurrency = PRODUCT_POLICY.operations.modelAnalysis.scanConcurrency) {
  const configured = [1, 2].includes(Number(configuredConcurrency))
    ? Number(configuredConcurrency)
    : PRODUCT_POLICY.operations.modelAnalysis.scanConcurrency;
  const parsed = Number(args["analysis-concurrency"] ?? configured);
  if (!Number.isInteger(parsed)) return configured;
  return Math.max(1, Math.min(configured, parsed));
}

function refreshRetryAt(errorCode) {
  const code = String(errorCode || "");
  const delayMs = /RISK|CONTROL/.test(code)
    ? 12 * 60 * 60 * 1000
    : /LOGIN|AUTH/.test(code)
      ? 30 * 60 * 1000
    : /NOT_FOUND|INVALID_LINK/.test(code)
      ? 7 * 24 * 60 * 60 * 1000
      : 6 * 60 * 60 * 1000;
  return new Date(Date.now() + delayMs).toISOString();
}

function assertScanActive(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("扫描已中止。");
  error.code = "SCAN_ABORTED";
  throw error;
}

function assertWorkflowScanControl(db, workflowRunId) {
  if (!workflowRunId) return;
  const run = getWorkflowRun(db, workflowRunId);
  if (!run) return;
  if (run.controlState === "pause_requested" || run.status === "paused") {
    throw codedError(
      "WORKFLOW_PAUSE_REQUESTED",
      "workflow pause requested at a safe scan boundary; checkpoint preserved"
    );
  }
  if (run.controlState === "stop_requested" || run.status === "stopped") {
    throw codedError(
      "WORKFLOW_STOP_REQUESTED",
      "workflow stop requested at a safe scan boundary; checkpoint preserved"
    );
  }
}

function normalizeScanTerminalStatus(status) {
  const normalized = String(status || "completed").trim().toLowerCase();
  return ["completed", "partial", "failed", "interrupted"].includes(normalized) ? normalized : "completed";
}

function resolveScanTerminalStatus({ targetSummary = null, scanSummary = null } = {}) {
  const fatalErrorCode = String(scanSummary?.fatalErrorCode || "");
  if (fatalErrorCode) return scanFailureStatus({ code: fatalErrorCode });
  if (!targetSummary) return normalizeScanTerminalStatus(scanSummary?.status || "completed");
  if (targetSummary.pending === 0) return "completed";
  if (targetSummary.completed > 0 || targetSummary.partial > 0) return "partial";
  if (targetSummary.failed > 0) return "failed";
  const adapterStatus = normalizeScanTerminalStatus(scanSummary?.status || "partial");
  return adapterStatus === "completed" ? "partial" : adapterStatus;
}

function scanFailureStatus(error) {
  const code = String(error?.code || "");
  return new Set([
    "SCAN_LEASE_LOST",
    "SCAN_ABORTED",
    "BOSS_RISK_CONTROL",
    "BOSS_LOGIN_REQUIRED",
    "BOSS_TAB_REQUIRED",
    "BOSS_SEARCH_TAB_CHANGED",
    "BOSS_OPERATOR_TABS_CHANGED",
    "BOSS_COMMUNICATION_PAGE_LOST",
    "BOSS_WINDOW_MISMATCH",
    "BOSS_SEARCH_PAGE_LOST",
    "BOSS_DETAIL_PAGE_LOST",
    "BOSS_ACCESS_BUDGET_EXHAUSTED",
    "BROWSER_TIMEOUT",
    "BROWSER_COMMAND_FAILED",
    "BROWSER_DISCONNECTED"
  ]).has(code) ? "interrupted" : "failed";
}

function persistBossRiskControl(db, { site = "boss", runId = "", phase = "", error, nowMs = Date.now() } = {}) {
  if (!isBossRiskControl(error)) return false;
  const blockedUntil = new Date(Number(nowMs) + PRODUCT_POLICY.operations.bossAccessBudget.recoveryHours * 60 * 60_000).toISOString();
  const observedLocation = safeBossRiskLocation(error?.observedLocation);
  const details = {
    phase: String(phase || ""),
    errorCode: String(error?.code || "BOSS_RISK_CONTROL"),
    blockedUntil,
    recovery: true,
    ...(observedLocation ? { observedLocation } : {})
  };
  setSiteRuntimeState(db, site, {
    status: "blocked",
    reasonCode: details.errorCode,
    message: "BOSS risk control detected; scanning safely stopped.",
    details
  });
  recordSiteAccessEvent(db, { site, action: "risk_control", runId, details });
  return true;
}

function isBossRiskControl(error) {
  if (error?.code === "BOSS_RISK_CONTROL") return true;
  return error?.code === "BOSS_SEARCH_TAB_CHANGED" && Boolean(safeBossRiskLocation(error?.observedLocation));
}

function safeBossRiskLocation(location) {
  const origin = String(location?.origin || "");
  const path = String(location?.path || "");
  return origin === "https://www.zhipin.com" && /^\/web\/passport\/zp\/(?:verify|403)\.html$/i.test(path)
    ? { origin, path }
    : null;
}

function prepareWorkflowExecution(db, args, planId) {
  const workflowRunId = String(args?.["workflow-run"] || "").trim();
  if (!workflowRunId) return null;
  const run = getWorkflowRun(db, workflowRunId);
  if (!run) throw codedError("WORKFLOW_RUN_NOT_FOUND", `Workflow run ${workflowRunId} does not exist.`);
  if (!planId || run.planId !== Number(planId)) {
    throw codedError("WORKFLOW_PLAN_MISMATCH", "Workflow run belongs to another search plan.");
  }
  if (args?.["analysis-only"] === true) {
    if (run.status !== "analyzing") {
      throw codedError(
        "WORKFLOW_ANALYSIS_STATUS_INVALID",
        `Analysis-only resume requires analyzing status, not ${run.status}.`
      );
    }
    return run;
  }
  if (!["created", "scanning", "interrupted"].includes(run.status)) {
    throw codedError("WORKFLOW_SCAN_STATUS_INVALID", `Workflow run cannot scan from ${run.status}.`);
  }
  return run.status === "scanning" ? run : transitionWorkflowRun(db, { id: run.id, status: "scanning" });
}

function resolveWorkflowScanContext(db, args, planRecord) {
  const workflowRunId = String(args?.["workflow-run"] || "").trim();
  if (!workflowRunId) return null;
  const run = getWorkflowRun(db, workflowRunId);
  if (!run) throw codedError("WORKFLOW_RUN_NOT_FOUND", `Workflow run ${workflowRunId} does not exist.`);
  if (!planRecord || run.planId !== Number(planRecord.id) || run.profileId !== Number(planRecord.profileId)) {
    throw codedError("WORKFLOW_PLAN_MISMATCH", "Workflow run does not match the selected search plan and profile.");
  }
  if (args?.["analysis-only"] === true) {
    if (run.status !== "analyzing") {
      throw codedError(
        "WORKFLOW_ANALYSIS_STATUS_INVALID",
        `Analysis-only resume requires analyzing status, not ${run.status}.`
      );
    }
    if (!run.scanBatchId) {
      throw codedError(
        "WORKFLOW_ANALYSIS_BATCH_REQUIRED",
        "Analysis-only resume requires the workflow's persisted scan batch."
      );
    }
    return run;
  }
  if (run.status !== "scanning") {
    throw codedError("WORKFLOW_SCAN_STATUS_INVALID", `Workflow run must be scanning, not ${run.status}.`);
  }
  if (!run.scanNeeded) throw codedError("WORKFLOW_SCAN_NOT_NEEDED", "Workflow run already has enough valid inventory.");
  const persistedKeywords = run.keywords.map((item) => String(item.word || "").trim()).filter(Boolean);
  const suppliedKeywords = splitWorkflowKeywords(args.keywords || args.keyword);
  if (!persistedKeywords.length || suppliedKeywords.length !== persistedKeywords.length
    || suppliedKeywords.some((word, index) => word !== persistedKeywords[index])) {
    throw codedError("WORKFLOW_SCAN_INPUT_MISMATCH", "Workflow keywords differ from the persisted run plan.");
  }
  const expected = {
    "max-cards": Math.max(...run.keywords.map((item) => Number(item.maxCards) || 0)),
    "max-detail-total": Number(run.budget.maxDetailTotal),
    "browser-page-budget": Number(run.budget.browserPageBudget)
  };
  for (const [key, value] of Object.entries(expected)) {
    if (!Number.isInteger(value) || value <= 0 || Number(args[key]) !== value) {
      throw codedError("WORKFLOW_SCAN_INPUT_MISMATCH", `--${key} differs from the persisted workflow budget.`);
    }
  }
  const resumeBatchId = parseOptionalPositiveIntegerArg(args, "resume-batch");
  if (run.scanBatchId && resumeBatchId !== run.scanBatchId) {
    throw codedError("WORKFLOW_SCAN_INPUT_MISMATCH", "Workflow resume batch differs from the persisted scan batch.");
  }
  if (!run.scanBatchId && resumeBatchId) {
    throw codedError("WORKFLOW_SCAN_INPUT_MISMATCH", "A new workflow run cannot resume an unrelated scan batch.");
  }
  return run;
}

function transitionWorkflowScanFailure(db, workflowRunId, _scanStatus, error) {
  if (!workflowRunId) return null;
  const run = getWorkflowRun(db, workflowRunId);
  if (!run || !["scanning", "analyzing", "interrupted"].includes(run.status)) return run;
  // The child scan keeps its failed/partial status for diagnostics; the workflow
  // remains resumable so a transient dependency cannot consume a daily slot.
  return transitionWorkflowRun(db, {
    id: run.id,
    status: "interrupted",
    errorCode: error?.code || "SCAN_FAILED",
    errorMessage: error?.message || String(error || "scan failed")
  });
}

function workflowMetrics({ detailCoverage, rawJobs = [], analyzed = 0, saved = 0, inventoryCount = 0, access } = {}) {
  const collected = Number(detailCoverage?.collected ?? rawJobs.length ?? 0);
  const metrics = {
    collected,
    cards: collected,
    detailsRequired: Number(detailCoverage?.detailRequired || 0),
    detailsRead: Number(detailCoverage?.detailRead || 0),
    detailsReused: Number(detailCoverage?.detailsReused || 0),
    detailsPending: Number(detailCoverage?.detailPending || 0),
    detailsFailed: Number(detailCoverage?.detailFailed || 0),
    analyzed: Number(analyzed || 0),
    saved: Number(saved || 0),
    eligible: Number(inventoryCount || 0)
  };
  if (access) {
    metrics.access = {
      details: Number(access.details || 0),
      pages: Number(access.pages || 0),
      scrolls: Number(access.scrolls || 0)
    };
  }
  return metrics;
}

function workflowAccessUsage(db, scanRunId) {
  const normalizedRunId = String(scanRunId || "").trim();
  if (!normalizedRunId) return null;
  const usage = { details: 0, pages: 0, scrolls: 0 };
  for (const event of listSiteAccessEvents(db, { site: "boss", limit: 10000 })) {
    if (String(event.details?.runId || "") !== normalizedRunId) continue;
    if (isBossDetailAccessAction(event.action)) usage.details += 1;
    if (event.action === "list_navigation") usage.pages += 1;
    if (event.action === "list_scroll") usage.scrolls += 1;
  }
  return usage;
}

function persistDetailOutcome(db, { site, runId = "", batchId, result = {} } = {}) {
  const succeeded = result?.outcome === "succeeded";
  const accessMode = ["visible_pane", "standalone_detail"].includes(result?.accessMode)
    ? result.accessMode
    : "unknown";
  return recordSiteAccessEvent(db, {
    site,
    action: "pane_detail_result",
    runId,
    details: {
      batchId: Number(batchId),
      outcome: succeeded ? "succeeded" : "failed",
      errorCode: succeeded ? "" : String(result?.errorCode || "BOSS_DETAIL_LOAD_TIMEOUT"),
      accessMode
    }
  });
}

function splitWorkflowKeywords(value) {
  return String(value || "").split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
}

function assertScanLimitOverridesAllowed(args, scanMode, workflowBound = false) {
  const keys = ["max-cards", "max-detail-total", "browser-page-budget"]
    .filter((key) => Object.hasOwn(args, key));
  if (scanMode === "daily" && keys.length && !workflowBound) {
    throw codedError(
      "DAILY_SCAN_LIMIT_OVERRIDE",
      `日常扫描预算由产品策略固定；${keys.map((key) => `--${key}`).join("、")} 仅可用于 broad 模式。`
    );
  }
}

function resolveScanLimit(args, key, plannedValue, fallback, boundKey) {
  const raw = args[key] ?? plannedValue;
  const value = Number(raw);
  const bounds = PRODUCT_POLICY.searchPlan.scanBounds[boundKey];
  if (!Number.isInteger(value)) {
    throw codedError("INVALID_SCAN_LIMIT", `--${key} 必须是整数。`);
  }
  if (bounds && (value < bounds[0] || value > bounds[1])) {
    throw codedError("INVALID_SCAN_LIMIT", `--${key} 必须在 ${bounds[0]}-${bounds[1]} 之间。`);
  }
  if (value <= 0) throw codedError("INVALID_SCAN_LIMIT", `--${key} 必须是正整数。`);
  return Number.isInteger(value) ? value : fallback;
}

function parseOptionalPositiveIntegerArg(args, key) {
  const raw = args?.[key];
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw codedError("INVALID_SCAN_INPUT", `--${key} 必须是正整数。`);
  return value;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function preflightBossScanBrowser({
  browserMode,
  browser,
  adapter,
  expectedSearchTabId = null,
  expectedCommunicationTabId = null
}) {
  if (String(browserMode || "").trim().toLowerCase() !== "edge") {
    return adapter.preflight();
  }
  const inspected = await inspectBossOperatorTabs({
    browser,
    inspectTab: (tabId) => adapter.preflight({ tabId }),
    expectedSearchTabId,
    expectedCommunicationTabId
  });
  return {
    ...(inspected.searchState || {}),
    tabId: inspected.searchTab.id,
    communicationTabId: inspected.communicationTab.id
  };
}

async function runWithBoundBossScanBrowser({
  browserMode,
  browser,
  adapter,
  expectedSearchTabId = null,
  expectedCommunicationTabId = null,
  action
}) {
  if (typeof action !== "function") throw new TypeError("runWithBoundBossScanBrowser requires action()");
  const browserState = await preflightBossScanBrowser({
    browserMode,
    browser,
    adapter,
    expectedSearchTabId,
    expectedCommunicationTabId
  });
  return action(browserState);
}

function prevalidateDirectScanResume(db, args = {}) {
  const resumeBatchId = parseOptionalPositiveIntegerArg(args, "resume-batch");
  if (!resumeBatchId) return null;
  if (args.input) throw codedError("SCAN_RESUME_INPUT_UNSUPPORTED", "JSON 输入扫描不能恢复浏览器批次。");
  const planId = Number(args.plan || 0);
  const planRecord = Number.isInteger(planId) && planId > 0 ? getSearchPlan(db, planId) : null;
  const site = String(args.site || planRecord?.plan?.platform?.site || "boss").trim().toLowerCase();
  return validateResumeBatchPreflight(db, { resumeBatchId, site, planId });
}

function validateResumeBatchPreflight(db, { resumeBatchId, site, planId }) {
  const resumedBatch = getBatch(db, resumeBatchId);
  return validateResumeBatch({
    resumeBatchId,
    resumedBatch,
    site,
    planId
  });
}

function resolveResumeBatch(db, { resumeBatchId, site, planId, executionSnapshot }) {
  const { storedSnapshot } = validateResumeBatchPreflight(db, {
    resumeBatchId,
    site,
    planId
  });
  assertScanSnapshotCompatible(storedSnapshot, executionSnapshot);
  const latestResults = listLatestScanTargetResults(db, resumeBatchId);
  return {
    batchId: resumeBatchId,
    targetKeys: remainingTargetKeys(storedSnapshot, latestResults),
    progress: summarizeResumePlan(storedSnapshot, latestResults)
  };
}

async function resolveBossPlatformFilters({ db, adapter, args, plan, cityScopes, keyword, tabId, logger: scopedLogger = logger }) {
  const stored = getPlatformFilterCatalog(db, "boss");
  let catalog = stored?.catalog;
  const shouldRefresh = args["refresh-platform-filters"] === true || !isCatalogFresh(catalog);
  if (shouldRefresh) {
    catalog = await adapter.discoverFilterCatalog({
      cityCode: cityScopes[0]?.cityCode,
      keyword: keyword || "Python",
      tabId
    });
    savePlatformFilterCatalog(db, {
      site: "boss",
      catalog,
      source: catalog.source || "live_dom",
      discoveredAt: catalog.discoveredAt
    });
  }
  const snapshot = resolveNativeFilterSnapshot({
    site: "boss",
    catalog,
    plan,
    overrides: {
      salary: args["boss-salary"],
      experience: args["boss-experience"]
    }
  });
  scopedLogger.info("platform_filters_resolved", {
    site: "boss",
    refreshed: shouldRefresh,
    catalogVersion: snapshot.catalogVersion,
    params: snapshot.params,
    labels: snapshot.labels
  });
  for (const warning of snapshot.warnings || []) scopedLogger.warn("platform_filter_remapped", { site: "boss", ...warning });
  return snapshot;
}

function resolveCityScopes(args, planRecord, configs) {
  if (args.city) return [{ city: "", cityCode: String(args.city) }];
  const cities = planRecord?.plan?.cities?.length ? planRecord.plan.cities : [configs.profile.location?.default_city].filter(Boolean);
  const scopes = [];
  const unsupported = [];
  for (const city of cities) {
    const cityCode = cityToBossCode(city) || (city === cities[0] ? planRecord?.plan?.bossCityCode : "");
    if (!cityCode) {
      unsupported.push(city);
      continue;
    }
    if (!scopes.some((item) => item.cityCode === cityCode)) scopes.push({ city, cityCode });
  }
  if (unsupported.length) throw new Error(`暂不支持这些城市的 BOSS 编码：${unsupported.join("、")}`);
  if (scopes.length) return scopes;
  return [{ city: "", cityCode: configs.profile.location?.boss_city_code || "101280100" }];
}

function ruleGateAnalysis(job, gate) {
  const blocked = gate === "blocked";
  return {
    provider: "rule-gate",
    model: "",
    semanticStatus: blocked ? "blocked" : "refresh",
    decisionSource: blocked ? "hard_boundary" : "source_refresh",
    error: "",
    realRoleType: "",
    businessScenario: "",
    recommendation: blocked ? "not_recommended" : null,
    decisionStatus: blocked ? "decided" : "needs_retry",
    recommendationSchemaVersion: 2,
    fitLevel: blocked ? "no_fit" : null,
    confidence: null,
    recommendedResumeVersion: "",
    recommendedResumeVersionName: "",
    primaryProjects: [],
    fitReasons: [blocked ? "基础条件不满足，未进入模型匹配。" : "招聘方活跃状态未确认，等待刷新后再进入投递队列。"],
    hardBlockers: [],
    softGaps: [],
    questionsToVerify: job.risks || [],
    missingPoints: [],
    blockingGaps: [],
    riskQuestions: job.risks || [],
    evidence: { jd: [], resume: [] },
    greetingAngle: "",
    greeting: ""
  };
}

async function createProfile(db, args) {
  if (!args.resume) throw new Error("需要 --resume <简历文件路径>");
  const resumePath = path.resolve(args.resume);
  const fileName = path.basename(resumePath);
  const buffer = require("fs").readFileSync(resumePath);
  const resume = await parseResumeUpload({ fileName, buffer, root: ROOT });
  const configs = loadConfigs(ROOT);
  configs.model = args["force-mock"] === true
    ? offlineMockModelConfig()
    : resolveRuntimeModelConfig({
      root: ROOT,
      fallbackModelConfig: configs.model,
      taskProfile: "deep_analysis"
    }).modelConfig;
  const { profile, plan } = await analyzeResumeToPlan({ modelConfig: configs.model, resume });
  const saved = saveProfileAnalysis(db, { profile, document: resume, searchPlan: plan });
  try {
    const storedFilePath = storeResumeSourceFile({ root: ROOT, documentId: saved.resumeDocumentId, fileName, buffer });
    attachResumeDocumentFile(db, saved.resumeDocumentId, storedFilePath);
  } catch (error) {
    logger.warn("resume_source_file_save_failed", { documentId: saved.resumeDocumentId, error: errorMeta(error) });
  }
  logger.info("cli_profile_created", { profileId: saved.profileId, planId: saved.planId, fileName: resume.originalFileName, format: resume.format, charCount: resume.charCount });
  console.log(`Profile: ${saved.profileId}`);
  console.log(`Search plan: ${saved.planId}`);
  console.log(`Keywords: ${planKeywords(plan).join("、")}`);
}

function bindBatch(db, args) {
  const batchId = Number(args.batch);
  const planId = Number(args.plan);
  if (!Number.isInteger(batchId) || batchId <= 0) throw new Error("需要 --batch <批次 ID>");
  if (!Number.isInteger(planId) || planId <= 0) throw new Error("需要 --plan <Search Plan ID>");
  const result = bindBatchToPlan(db, { batchId, planId });
  logger.info("batch_bound_to_plan", result);
  console.log(`批次 #${result.batchId} 已绑定 Search Plan #${result.planId}，迁入 ${result.migratedStates} 条投递状态。`);
}

async function reassessBatch(db, args) {
  const batchId = Number(args.batch || getLatestBatchId(db, { planId: args.plan }));
  const planId = Number(args.plan);
  if (!Number.isInteger(batchId) || batchId <= 0) throw new Error("需要 --batch <批次 ID>");
  if (!Number.isInteger(planId) || planId <= 0) throw new Error("需要 --plan <Search Plan ID>");
  const planRecord = getSearchPlan(db, planId);
  if (!planRecord) throw new Error(`未找到 Search Plan #${planId}`);
  const profileRecord = getCandidateProfile(db, planRecord.profileId);
  if (!profileRecord) throw new Error(`Search Plan #${planId} 对应的候选人画像不存在。`);
  // 重评与扫描使用同一套已确认匹配上下文：未确认的新简历不得影响重评结果。
  const matchingContext = getCandidateMatchingContext(db, planRecord.profileId);
  assertSearchPlanReady(planRecord, matchingContext?.candidateProfile || {}, getSearchPlanDependency(db, planRecord.id));
  if (!matchingContext) throw new Error(`Search Plan #${planId} 缺少已确认匹配偏好卡对应的画像版本。`);

  let configs = loadConfigs(ROOT);
  configs.model = args["use-model"] === true
    ? resolveRuntimeModelConfig({
      root: ROOT,
      fallbackModelConfig: configs.model,
      taskProfile: "batch_screening"
    }).modelConfig
    : offlineMockModelConfig();
  configs = profileToRuntimeConfigs(configs, matchingContext.candidateProfile, planRecord.plan, listMatchingResumeVersions(db, planRecord.profileId), matchingContext.matchingCard);
  const keywordPlan = (planRecord.plan.keywords || []).map((item) => ({ ...item }));
  const analyzeJob = createJobAnalysisRunner(configs, keywordPlan, { db, logger });
  const result = await reassessBatchObservations(db, {
    batchId,
    planId,
    configs,
    analyzeJob,
    cleanDescription: cleanDetailText
  });
  logger.info("batch_reassessed", { ...result, planId, analysisMode: args["use-model"] === true ? "model" : "rules" });
  console.log(`批次 #${result.batchId} 已重评估 ${result.reassessed} 条岗位（${args["use-model"] === true ? "模型" : "规则"}模式）。`);
}

function createBrowser(args) {
  if (args.browser === "edge") return new EdgeControlAdapter();
  if (args.browser === "cdp" || args.browser === "portable") {
    return new CdpBrowserAdapter({
      port: Number(args["cdp-port"] || 9222)
    });
  }
  return null;
}

function createSiteAdapter(site, context) {
  if (site === "boss") return new BossSiteAdapter(context);
  throw new Error(`当前版本尚未接入 ${site}。请先选择 BOSS 直聘。`);
}

function offlineMockModelConfig() {
  return {
    provider: "mock",
    providers: { mock: { model: "offline-structured-mock" } }
  };
}

function rescorePlan(db, args) {
  const planId = Number(args.plan);
  if (!Number.isInteger(planId) || planId <= 0) throw new Error("需要 --plan <Search Plan ID>");
  const planRecord = getSearchPlan(db, planId);
  if (!planRecord) throw new Error(`未找到 Search Plan #${planId}`);
  const profileRecord = getCandidateProfile(db, planRecord.profileId);
  if (!profileRecord) throw new Error(`Search Plan #${planId} 对应的候选人画像不存在`);
  // 重算与扫描使用同一套已确认匹配上下文：未确认的新简历不得影响重算结果。
  const matchingContext = getCandidateMatchingContext(db, planRecord.profileId);
  assertSearchPlanReady(planRecord, matchingContext?.candidateProfile || {}, getSearchPlanDependency(db, planRecord.id));
  if (!matchingContext) throw new Error(`Search Plan #${planId} 缺少已确认匹配偏好卡对应的画像版本。`);
  const configs = profileToRuntimeConfigs(loadConfigs(ROOT), matchingContext.candidateProfile, planRecord.plan, listMatchingResumeVersions(db, planRecord.profileId), matchingContext.matchingCard);
  const result = rescorePlanObservations(db, { planId, configs });
  logger.info("plan_rescored", result);
  console.log(`Search Plan #${planId} 已按最新规则重算 ${result.rescored} 条岗位。`);
}

function rebuildReport(db, args = {}) {
  const batchId = Number(args.batch || 0);
  const jobs = batchId ? listReportJobs(db, { batchId, limit: 500 }) : listReportJobs(db, { limit: 500 });
  const report = renderReports(jobs, path.join(ROOT, "reports"));
  console.log(`Markdown: ${report.mdPath}`);
  console.log(`HTML: ${report.htmlPath}`);
}

function startDashboard(db, args) {
  const port = Number(args.port || 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("Invalid --port");
  const server = createDashboardServer({
    db,
    dbPath: path.resolve(args.db || DEFAULT_DB),
    root: ROOT,
    modelConfig: loadConfigs(ROOT).model,
    allowOfflineMock: args["allow-offline-mock"] === true,
    forceMock: args["force-mock"] === true
  });
  logger.info("dashboard_starting", { port, dbPath: path.resolve(args.db || DEFAULT_DB) });
  installDashboardSignalHandlers({ server, db, logger });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Dashboard: http://127.0.0.1:${port}/`);
    console.log("只写本地 SQLite，不会自动投递或发消息。按 Ctrl+C 停止。");
  });
  return server;
}

function installDashboardSignalHandlers({
  server,
  db,
  processRef = process,
  logger: scopedLogger = logger
} = {}) {
  if (!server || typeof server.close !== "function") throw new Error("dashboard shutdown requires a server");
  if (!db || typeof db.close !== "function") throw new Error("dashboard shutdown requires a database");
  let shutdownPromise = null;
  const onSigint = () => {
    void shutdown("SIGINT").catch((error) => {
      scopedLogger.error("dashboard_shutdown_failed", { signal: "SIGINT", error: errorMeta(error) });
    });
  };
  const onSigterm = () => {
    void shutdown("SIGTERM").catch((error) => {
      scopedLogger.error("dashboard_shutdown_failed", { signal: "SIGTERM", error: errorMeta(error) });
    });
  };
  const dispose = () => {
    processRef.removeListener("SIGINT", onSigint);
    processRef.removeListener("SIGTERM", onSigterm);
  };
  const shutdown = (signal = "") => {
    if (shutdownPromise) return shutdownPromise;
    dispose();
    scopedLogger.info("dashboard_shutdown_started", { signal: String(signal || "") });
    shutdownPromise = closeDashboardServer(server)
      .then(() => db.close())
      .then(() => {
        processRef.exitCode = 0;
        scopedLogger.info("dashboard_shutdown_completed", { signal: String(signal || "") });
      })
      .catch((error) => {
        processRef.exitCode = 1;
        throw error;
      });
    return shutdownPromise;
  };
  processRef.once("SIGINT", onSigint);
  processRef.once("SIGTERM", onSigterm);
  return { shutdown, dispose };
}

function closeDashboardServer(server) {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
    } catch (error) {
      if (error?.code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    }
  });
}

function mark(db, args, status) {
  if (!args["job-id"]) throw new Error("需要 --job-id <id>");
  markApplication(db, Number(args["job-id"]), status, args.note || args.reason || "");
  logger.info("cli_job_marked", { jobId: Number(args["job-id"]), status });
  console.log(`已标记 job ${args["job-id"]}: ${status}`);
}

function printFeedbackSummary(db) {
  const summary = buildFeedbackSummary(db);
  console.log(`Applied: ${summary.totals.applied}`);
  console.log(`Skipped: ${summary.totals.skipped}`);
  console.log(`No reply: ${summary.totals.no_reply}`);
  printTop("Skipped companies", summary.companies);
  printTop("Skipped keywords", summary.keywords);
}

function printBatchSummary(db, args = {}) {
  const options = args["batch-id"] ? { batchId: Number(args["batch-id"]) } : { batch: args.batch || "latest" };
  const summary = buildBatchSummary(db, options);
  console.log(`Batch: ${summary.batchId || "all"}`);
  console.log(`Imported: ${summary.imported}`);
  console.log(`Pending: ${summary.pending}`);
  console.log(`Applied: ${summary.applied}`);
  console.log(`Skipped: ${summary.skipped}`);
  console.log(`No reply: ${summary.no_reply}`);
  console.log(`New: ${summary.newJobs}`);
  console.log(`Repeated: ${summary.repeated}`);
  console.log(`Non Guangzhou: ${summary.nonGuangzhou}`);
  console.log(`Inactive/unknown: ${summary.inactiveOrUnknown}`);
  console.log("Top risks:");
  if (!summary.riskTop.length) {
    console.log("  - none");
    return;
  }
  for (const item of summary.riskTop) console.log(`  - ${item.risk}: ${item.count}`);
}

function printTop(label, stats) {
  const rows = Object.entries(stats || {})
    .map(([name, value]) => ({ name, ...value }))
    .filter((item) => item.skipped > 0)
    .sort((a, b) => b.skipped - a.skipped || a.name.localeCompare(b.name, "zh-CN"))
    .slice(0, 8);
  console.log(`${label}:`);
  if (!rows.length) {
    console.log("  - none");
    return;
  }
  for (const item of rows) console.log(`  - ${item.name}: skipped ${item.skipped}, applied ${item.applied}, no_reply ${item.no_reply || 0}`);
}

function resolveKeywords(args, configs) {
  const raw = args.keywords || args.keyword;
  if (raw) return splitList(raw);
  return (configs.keywords.keywords || []).map((item) => item.word).filter(Boolean);
}

function splitList(value) {
  return String(value || "")
    .split(/[,，、\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--help" || item === "-h") args.help = true;
    else if (item.startsWith("--")) args[item.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return args;
}

function printHelp() {
  console.log(`用法:
  run.ps1 init-db
  run.ps1 profile-create --resume "D:\\resume.docx"
  run.ps1 scan --plan <Search Plan ID> --browser portable --cdp-port 9222
  run.ps1 bind-batch --batch <Batch ID> --plan <Search Plan ID>
  run.ps1 reassess-batch --batch <Batch ID> --plan <Search Plan ID>
  run.ps1 rescore-plan --plan <Search Plan ID>
  run.ps1 scan --site boss --input data\\sample_jobs.json
  run.ps1 scan --site boss --browser edge --plan <Search Plan ID>
  run.ps1 scan --site boss --browser edge --plan <Search Plan ID> --scan-mode daily
  run.ps1 scan --site boss --browser edge --plan <Search Plan ID> --scan-mode broad
  run.ps1 scan --plan <Search Plan ID> --browser portable --cdp-port 9222 --model-settings-root <external-root>  # scan-only, read-only
  run.ps1 scan --site boss --browser edge --plan <Search Plan ID> --refresh-platform-filters
  run.ps1 scan --site boss --browser edge --plan <Search Plan ID> --analysis-concurrency 2
  run.ps1 refresh-details --browser edge --plan <Search Plan ID> --limit 8
  run.ps1 refresh-activity --browser edge --plan <Search Plan ID> --limit 8
  run.ps1 scan --input data\\sample_jobs.json --profile profiles\\guo_mingfu.json --resume-versions profiles\\resume_versions.json
  run.ps1 dashboard --port 8787
  run.ps1 rebuild-report --batch <Batch ID>
  run.ps1 feedback-summary
  run.ps1 batch-summary --batch latest
  run.ps1 communicate --batch <Communication Batch ID> --browser edge
  run.ps1 mark-applied --job-id <id> --note "人工确认已沟通"
  run.ps1 mark-skipped --job-id <id> --reason "地点不合适"
  run.ps1 mark-no-reply --job-id <id> --note "已投递，暂未回复"

安全边界：扫描只读岗位信息；批量沟通必须先在本地页面确认清单，再由 communicate 命令串行执行。`);
}

module.exports = {
  scan,
  resolveScanModelSettingsContext,
  resolveScanModelRuntime,
  prepareWorkspaceTabsCommand,
  startDashboard,
  installDashboardSignalHandlers,
  communicate,
  resolveCommunicationBrowserAuthority,
  executeWithSiteScanLease,
  validateResumeBatchPreflight,
  resolveResumeBatch,
  normalizeScanTerminalStatus,
  resolveScanTerminalStatus,
  scanFailureStatus,
  resolveScanLimit,
  persistRefreshAttempt,
  assertScanLimitOverridesAllowed,
  workflowMetrics,
  workflowAccessUsage,
  persistDetailOutcome,
  resolveAnalysisConcurrency,
  assertWorkflowScanControl,
  preflightBossScanBrowser,
  runWithBoundBossScanBrowser,
  persistBossRiskControl
};
