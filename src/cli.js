#!/usr/bin/env node
const path = require("path");
const crypto = require("crypto");
const { loadConfigs } = require("./config");
const { EdgeControlAdapter } = require("./adapters/browser/edge_control");
const { CdpBrowserAdapter } = require("./adapters/browser/cdp");
const { BossSiteAdapter, cleanDetailText } = require("./adapters/sites/boss");
const { scoreJob, decisionState } = require("./core/scoring");
const { resolvePlannedKeywords } = require("./core/keyword_planner");
const { createJobAnalysisRunner } = require("./core/job_analysis");
const { analyzeResumeToPlan } = require("./core/profile_onboarding");
const {
  cityToBossCode,
  profileToRuntimeConfigs,
  planKeywords,
  resolveScanPolicy,
  applyScanPolicyToFilters
} = require("./core/search_plan");
const { isCatalogFresh, resolveNativeFilterSnapshot, formatNativeFilterSummary } = require("./core/platform_filters");
const {
  openDb,
  createBatch,
  createAndBindScanBatch,
  getBatch,
  beginScanRun,
  heartbeatScanRun,
  finishScanRun,
  interruptOrphanedScanRuns,
  checkpointScanTarget,
  listLatestScanTargetResults,
  getSiteRuntimeState,
  setSiteRuntimeState,
  clearSiteRuntimeState,
  recordSiteAccessEvent,
  acquireSiteScanLease,
  renewSiteScanLease,
  releaseSiteScanLease,
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
  getSearchPlan,
  getSearchPlanDependency,
  getLatestBatchId,
  listCandidateResumeVersions,
  listDecisionPool,
  isActivityProbeDue,
  saveProfileAnalysis,
  attachResumeDocumentFile,
  bindBatchToPlan,
  rescorePlanObservations,
  reassessBatchObservations
} = require("./core/storage");
const { createSiteAccessController } = require("./core/site_access_budget");
const { parseResumeUpload } = require("./core/resume_parser");
const { renderReports } = require("./reports/render");
const { createDashboardServer } = require("./dashboard/server");
const { createLogger, errorMeta } = require("./core/observability");
const { resolveRuntimeModelConfig } = require("./core/model_settings");
const { mapWithConcurrency } = require("./core/async_pool");
const { storeResumeSourceFile } = require("./core/resume_files");
const { assertSearchPlanReady } = require("./core/plan_validation");
const { PRODUCT_POLICY } = require("./core/product_policy");
const { resolveScanKind, withSiteScanLease: runWithSiteScanLease } = require("./core/scan_execution");
const { getCommunicationBatch, setCommunicationBatchStatus } = require("./core/communication_batches");
const { runCommunicationBatch } = require("./core/communication_executor");
const {
  buildScanExecutionSnapshot,
  assertScanSnapshotCompatible,
  remainingTargetKeys,
  summarizeResumePlan
} = require("./core/scan_snapshot");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_DB = path.join(ROOT, "data", "jobs.sqlite");
const logger = createLogger({ root: ROOT, component: "cli" });

if (require.main === module) {
  main().catch((err) => {
    logger.error("cli_command_failed", { command: process.argv[2] || "help", error: errorMeta(err) });
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

async function main() {
  const [command = "help", ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);
  if (["help", "--help", "-h"].includes(command) || args.help) return printHelp();
  logger.info("cli_command_started", { command, argKeys: Object.keys(args).sort() });

  const db = openDb(path.resolve(args.db || DEFAULT_DB));
  if (command === "init-db") {
    console.log(`SQLite ready: ${path.resolve(args.db || DEFAULT_DB)}`);
    return;
  }

  if (command === "scan") return executeWithSiteScanLease(db, args, command, (signal, execution) => scan(db, args, { signal, execution }));
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

async function communicate(db, args) {
  const batchId = Number(args.batch);
  if (!Number.isInteger(batchId) || batchId <= 0) throw new Error("需要 --batch <Communication Batch ID>");
  const batch = getCommunicationBatch(db, batchId);
  if (!batch) throw new Error(`未找到沟通批次 #${batchId}`);
  const browserMode = String(args.browser || batch.browserMode || "").trim().toLowerCase();
  if (browserMode !== batch.browserMode) throw new Error(`沟通批次固定使用 ${batch.browserMode}，不能切换为 ${browserMode}。`);
  const browser = createBrowser({ ...args, browser: browserMode });
  if (!browser) throw new Error("沟通执行需要已配置的 Edge 浏览器连接。");
  const runId = `communication-${batchId}-${crypto.randomUUID()}`;
  const communicationLogger = logger.child({ runId, batchId, planId: batch.planId, site: "boss", operation: "communication" });
  const accessController = createSiteAccessController({ db, site: "boss", runId, logger: communicationLogger });
  const adapter = createSiteAdapter("boss", { browser, logger: communicationLogger, accessController });

  try {
    const browserState = await adapter.preflight();
    await adapter.prepareCommunicationTab(browserState.tabId);
    const summary = await runCommunicationBatch({ db, batchId, adapter, accessController, logger: communicationLogger });
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
  }
}

async function executeWithSiteScanLease(db, args, command, run) {
  const planRecord = args.plan ? getSearchPlan(db, args.plan) : null;
  const site = String(args.site || planRecord?.plan?.platform?.site || "boss").trim().toLowerCase();
  const scanKind = resolveScanKind(command, args);
  const runId = String(args["run-id"] || crypto.randomUUID()).trim();
  const planId = Number(args.plan || 0) || null;
  const runLogger = logger.child({ runId, planId, scanKind, site });
  interruptOrphanedScanRuns(db, { site });
  if (command === "scan" && args.input) {
    const scanRun = beginScanRun(db, {
      runId,
      site,
      command: scanKind,
      planId,
      processId: process.pid
    });
    const execution = { runId, leaseOwner: "", site, scanKind, planId, logger: runLogger };
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
    const execution = { runId, leaseOwner: owner, site, scanKind, planId, logger: runLogger };
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
    const status = scanFailureStatus(error);
    if (error?.code === "BOSS_RISK_CONTROL") {
      const site = execution?.site || "boss";
      setSiteRuntimeState(db, site, {
        status: "blocked",
        reasonCode: error.code,
        message: error.message,
        details: { phase: "tracked_run", runId }
      });
      recordSiteAccessEvent(db, {
        site,
        action: "risk_control",
        runId,
        details: {
          errorCode: error.code,
          errorMessage: error.message,
          blockedUntil: error.blockedUntil || ""
        }
      });
    }
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

async function scan(db, args, { signal = null, execution = null } = {}) {
  assertScanActive(signal);
  const scanLogger = execution?.logger || logger;
  if (!args.plan && !args.input) {
    throw new Error("真实浏览器扫描必须传入 --plan <Search Plan ID>，避免岗位和投递状态脱离候选人画像。");
  }
  if (args["force-mock"] === true && !args.input) {
    throw new Error("真实浏览器扫描不能使用 --force-mock。请配置模型后按 Search Plan 扫描。");
  }
  let configs = loadConfigs(ROOT, {
    profile: args.profile,
    resumeVersions: args["resume-versions"]
  });
  configs.model = args["force-mock"] === true
    ? offlineMockModelConfig()
    : resolveRuntimeModelConfig({ root: ROOT, fallbackModelConfig: configs.model }).modelConfig;
  let planRecord = null;
  if (args.plan) {
    planRecord = getSearchPlan(db, args.plan);
    if (!planRecord) throw new Error(`未找到 Search Plan #${args.plan}`);
    const profileRecord = getCandidateProfile(db, planRecord.profileId);
    if (!profileRecord) throw new Error(`Search Plan #${args.plan} 对应的候选人画像不存在。`);
    assertSearchPlanReady(planRecord, profileRecord.profile, getSearchPlanDependency(db, planRecord.id));
    configs = profileToRuntimeConfigs(configs, profileRecord.profile, planRecord.plan, listCandidateResumeVersions(db, profileRecord.id));
  }
  const planned = planRecord && !args.keywords && !args.keyword
    ? (() => {
      const keywordPlan = (planRecord.plan.keywords || []).map((item) => ({ ...item }));
      return { keywords: keywordPlan.map((item) => item.word), keywordPlan, source: `search-plan:${planRecord.id}` };
    })()
    : resolvePlannedKeywords(args, configs);
  if (!planned.keywords.length) throw new Error("Search Plan 没有可用关键词，请先在页面补充后再扫描。");
  const requestedScanMode = String(args["scan-mode"] || "");
  const scanMode = requestedScanMode === "broad"
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
  const analyzeJob = createJobAnalysisRunner(configs, keywordPlan, { db, logger: scanLogger });
  const analysisConcurrency = resolveAnalysisConcurrency(args);
  const site = String(args.site || planRecord?.plan?.platform?.site || "boss").trim().toLowerCase();
  const browser = createBrowser(args);
  const accessController = !args.input && site === "boss"
    ? createSiteAccessController({ db, site, runId: execution?.runId || "", logger: scanLogger, signal })
    : null;
  const adapter = createSiteAdapter(site, { browser, logger: scanLogger, accessController });
  const cityScopes = resolveCityScopes(args, planRecord, configs);
  let browserState = null;
  if (!args.input) {
    try {
      browserState = await adapter.preflight();
      assertScanActive(signal);
      const priorRuntimeState = getSiteRuntimeState(db, site);
      if (priorRuntimeState?.status === "blocked") {
        clearSiteRuntimeState(db, site);
        scanLogger.info("site_runtime_block_cleared", { site, priorReasonCode: priorRuntimeState.reasonCode });
      }
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
  }
  const nativeFilterSnapshot = args.input
    ? { site, scanMode, params: {}, labels: {}, lanes: [] }
    : applyScanPolicyToFilters(
      await resolveBossPlatformFilters({ db, adapter, args, plan: planRecord?.plan, cityScopes, keyword: keywords[0], tabId: browserState.tabId, logger: scanLogger }),
      scanPolicy
    );
  if (!args.input) console.error(`[platform] BOSS 预筛：${formatNativeFilterSummary(nativeFilterSnapshot) || "未命中可用原生条件"}`);
  assertScanLimitOverridesAllowed(args, scanMode);
  const scanLimits = {
    maxCards: resolveScanLimit(args, "max-cards", scanPolicy.maxCards, scanPolicy.maxCards, "maxCards"),
    maxDetailTotal: resolveScanLimit(args, "max-detail-total", scanPolicy.maxDetailTotal, scanPolicy.maxDetailTotal, "maxDetailTotal"),
    browserPageBudget: resolveScanLimit(args, "browser-page-budget", scanPolicy.browserPageBudget, scanPolicy.browserPageBudget, "browserPageBudget"),
    detailLimits: scanPolicy.detailLimits
  };
  const executionSnapshot = args.input ? null : buildScanExecutionSnapshot({
    site,
    scanKind: scanMode,
    runtimePolicyHash: scanPolicy.policyHash,
    cityScopes,
    keywordPlan,
    nativeFilters: nativeFilterSnapshot,
    limits: scanLimits
  });
  const resumeBatchId = parseOptionalPositiveIntegerArg(args, "resume-batch");
  if (resumeBatchId && args.input) throw codedError("SCAN_RESUME_INPUT_UNSUPPORTED", "JSON 输入扫描不能恢复浏览器批次。");
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
        runtimePolicyHash: scanPolicy.policyHash,
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
  }
  for (const keyword of keywords) upsertKeywordSource(db, keyword, source);
  scanLogger.info("scan_started", {
    batchId,
    planId: planRecord?.id || null,
    keywordCount: keywords.length,
    source,
    scanMode,
    runtimePolicyVersion: scanPolicy.policyVersion,
    runtimePolicyHash: scanPolicy.policyHash,
    browser: args.browser || "input",
    hasInput: Boolean(args.input),
    analysisConcurrency,
    nativeFilters: args.input ? null : nativeFilterSnapshot,
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
  };

  const rawJobs = await adapter.scan({
    input: args.input,
    tabId: browserState?.tabId,
    keywords,
    keywordPlan,
    cityScopes,
    nativeFilters: nativeFilterSnapshot,
    browserPageBudget: scanLimits.browserPageBudget,
    maxCards: scanLimits.maxCards,
    maxDetailTotal: scanLimits.maxDetailTotal,
    detailLimits: scanLimits.detailLimits,
    targetKeys: resumeTargetKeys,
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
    onScanComplete: (summary) => { scanSummary = summary; },
    signal
  });
  assertScanActive(signal);

  const detailCoverage = args.input ? null : {
    collected: rawJobs.length,
    hardFiltered: rawJobs.filter((job) => !job.detailRequired).length,
    detailRequired: rawJobs.filter((job) => job.detailRequired).length,
    detailRead: rawJobs.filter((job) => job.detailRequired && job.detailRead).length,
    detailPending: rawJobs.filter((job) => job.detailRequired && !job.detailRead).length,
    detailFailed: rawJobs.filter((job) => job.detailRequired
      && !job.detailRead
      && job.detailErrorCode
      && !["BOSS_DETAIL_SAFETY_LIMIT", "BOSS_DETAIL_FAIR_SHARE_PENDING"].includes(job.detailErrorCode)).length
  };
  if (detailCoverage) scanLogger.info("boss_detail_coverage", { batchId, ...detailCoverage });
  const analysisCandidates = new Map();
  if (resumeBatchId) {
    for (const job of listReportJobs(db, { batchId, limit: 10000 })) {
      if (job.analysis?.semanticStatus === "pending" || job.analysis?.decisionSource === "analysis_pending") {
        analysisCandidates.set(job.sourceId || job.url || String(job.id), job);
      }
    }
  }
  for (const job of rawJobs) analysisCandidates.set(job.sourceId || job.url, job);
  const jobsToAnalyze = [...analysisCandidates.values()];
  scanLogger.info("job_analysis_started", { batchId, jobCount: jobsToAnalyze.length, analysisConcurrency, resumedPending: Math.max(0, jobsToAnalyze.length - rawJobs.length) });
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
  const report = renderReports(listReportJobs(db, { batchId }), path.join(ROOT, "reports"));
  scanLogger.info("scan_completed", { batchId, saved, reportMarkdown: path.basename(report.mdPath), reportHtml: path.basename(report.htmlPath) });
  console.log(`导入 ${saved} 个岗位`);
  if (detailCoverage) {
    console.log(`详情覆盖：应读 ${detailCoverage.detailRequired}，成功 ${detailCoverage.detailRead}，待补 ${detailCoverage.detailPending}；左栏明确排除 ${detailCoverage.hardFiltered}`);
  }
  console.log(`Markdown: ${report.mdPath}`);
  console.log(`HTML: ${report.htmlPath}`);
  const targetSummary = executionSnapshot
    ? summarizeResumePlan(executionSnapshot, listLatestScanTargetResults(db, batchId))
    : null;
  const finalStatus = resolveScanTerminalStatus({ targetSummary, scanSummary });
  const defaultStopCode = finalStatus === "partial"
    ? "SCAN_TARGETS_PARTIAL"
    : finalStatus === "failed" ? "SCAN_TARGETS_FAILED" : "";
  return {
    status: finalStatus,
    batchId,
    stopCode: scanSummary?.fatalErrorCode || defaultStopCode,
    stopMessage: scanSummary?.fatalErrorMessage || ""
  };
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
      recommendation: "review",
      fitLevel: "C",
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
  assertSearchPlanReady(planRecord, profileRecord.profile, getSearchPlanDependency(db, planRecord.id));
  const browser = createBrowser(args);
  if (!browser) throw new Error("补读岗位详情需要 --browser edge 或 --browser portable。");
  const accessController = createSiteAccessController({ db, site: "boss", runId: execution?.runId || "", logger: scanLogger, signal });
  const adapter = createSiteAdapter("boss", { browser, logger: scanLogger, accessController });
  const browserState = await adapter.preflight();
  assertScanActive(signal);

  let configs = loadConfigs(ROOT);
  configs.model = resolveRuntimeModelConfig({ root: ROOT, fallbackModelConfig: configs.model }).modelConfig;
  configs = profileToRuntimeConfigs(configs, profileRecord.profile, planRecord.plan, listCandidateResumeVersions(db, profileRecord.id));
  const keywordPlan = (planRecord.plan.keywords || []).map((item) => ({ ...item }));
  const analyzeJob = createJobAnalysisRunner(configs, keywordPlan, { db, logger: scanLogger });
  const analysisConcurrency = resolveAnalysisConcurrency(args);
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
  const rawJobs = await refreshMethod(pending, {
    limit,
    tabId: browserState.tabId,
    signal,
    onAttempt: async (attempt) => {
      assertScanActive(signal);
      persistRefreshAttempt(db, attempt, { batchId, activityOnly });
      if (Object.hasOwn(attemptCounts, attempt.result)) attemptCounts[attempt.result] += 1;
    }
  });
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

function resolveAnalysisConcurrency(args) {
  const parsed = Number(args["analysis-concurrency"] ?? 4);
  if (!Number.isInteger(parsed)) return 4;
  return Math.max(1, Math.min(8, parsed));
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
    "BOSS_SEARCH_PAGE_LOST",
    "BOSS_DETAIL_PAGE_LOST",
    "BOSS_ACCESS_BUDGET_EXHAUSTED",
    "BROWSER_TIMEOUT",
    "BROWSER_DISCONNECTED"
  ]).has(code) ? "interrupted" : "failed";
}

function assertScanLimitOverridesAllowed(args, scanMode) {
  const keys = ["max-cards", "max-detail-total", "browser-page-budget"]
    .filter((key) => Object.hasOwn(args, key));
  if (scanMode === "daily" && keys.length) {
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

function resolveResumeBatch(db, { resumeBatchId, site, planId, executionSnapshot }) {
  const resumedBatch = getBatch(db, resumeBatchId);
  if (!resumedBatch) throw codedError("SCAN_RESUME_BATCH_NOT_FOUND", `恢复批次 #${resumeBatchId} 不存在。`);
  if (resumedBatch.site !== site || resumedBatch.searchPlanId !== Number(planId || 0)) {
    throw codedError("SCAN_RESUME_BATCH_MISMATCH", `批次 #${resumeBatchId} 不属于当前站点和 Search Plan。`);
  }
  if (!["partial", "failed", "interrupted"].includes(resumedBatch.status)) {
    throw codedError("SCAN_RESUME_STATUS_INVALID", `批次 #${resumeBatchId} 当前状态为 ${resumedBatch.status}，不能恢复。`);
  }
  const storedSnapshot = resumedBatch.filterSnapshot?.execution;
  if (!storedSnapshot) throw codedError("SCAN_RESUME_SNAPSHOT_MISSING", `批次 #${resumeBatchId} 没有执行快照，无法安全恢复。`);
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
    recommendation: blocked ? "skip" : "review",
    fitLevel: blocked ? "D" : "C",
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
    : resolveRuntimeModelConfig({ root: ROOT, fallbackModelConfig: configs.model }).modelConfig;
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

  let configs = loadConfigs(ROOT);
  configs.model = args["use-model"] === true
    ? resolveRuntimeModelConfig({ root: ROOT, fallbackModelConfig: configs.model }).modelConfig
    : offlineMockModelConfig();
  configs = profileToRuntimeConfigs(configs, profileRecord.profile, planRecord.plan, listCandidateResumeVersions(db, profileRecord.id));
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
  const configs = profileToRuntimeConfigs(loadConfigs(ROOT), profileRecord.profile, planRecord.plan, listCandidateResumeVersions(db, profileRecord.id));
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
  server.listen(port, "127.0.0.1", () => {
    console.log(`Dashboard: http://127.0.0.1:${port}/`);
    console.log("只写本地 SQLite，不会自动投递或发消息。按 Ctrl+C 停止。");
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
  run.ps1 scan --site boss --browser edge --plan <Search Plan ID> --refresh-platform-filters
  run.ps1 scan --site boss --browser edge --plan <Search Plan ID> --analysis-concurrency 4
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
  executeWithSiteScanLease,
  resolveResumeBatch,
  normalizeScanTerminalStatus,
  resolveScanTerminalStatus,
  scanFailureStatus,
  resolveScanLimit,
  persistRefreshAttempt,
  assertScanLimitOverridesAllowed
};
