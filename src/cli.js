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
  recordScanTargetResult,
  getSiteRuntimeState,
  setSiteRuntimeState,
  clearSiteRuntimeState,
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

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_DB = path.join(ROOT, "data", "jobs.sqlite");
const logger = createLogger({ root: ROOT, component: "cli" });

main().catch((err) => {
  logger.error("cli_command_failed", { command: process.argv[2] || "help", error: errorMeta(err) });
  console.error(err.stack || err.message);
  process.exit(1);
});

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

  if (command === "scan") return executeWithSiteScanLease(db, args, command, (signal) => scan(db, args, { signal }));
  if (command === "refresh-details") return executeWithSiteScanLease(db, args, command, (signal) => refreshDetails(db, args, { signal }));
  if (command === "refresh-activity") return executeWithSiteScanLease(db, args, command, (signal) => refreshDetails(db, { ...args, "activity-only": true }, { signal }));
  if (command === "profile-create") return createProfile(db, args);
  if (command === "bind-batch") return bindBatch(db, args);
  if (command === "reassess-batch") return reassessBatch(db, args);
  if (command === "rescore-plan") return rescorePlan(db, args);
  if (command === "rebuild-report") return rebuildReport(db, args);
  if (command === "dashboard") return startDashboard(db, args);
  if (command === "feedback-summary") return printFeedbackSummary(db);
  if (command === "batch-summary") return printBatchSummary(db, args);
  if (command === "mark-applied") return mark(db, args, "applied");
  if (command === "mark-skipped") return mark(db, args, "skipped");
  if (command === "mark-no-reply") return mark(db, args, "no_reply");
  throw new Error(`未知命令：${command}`);
}

async function executeWithSiteScanLease(db, args, command, run) {
  if (command === "scan" && args.input) return run(null);
  const planRecord = args.plan ? getSearchPlan(db, args.plan) : null;
  const site = String(args.site || planRecord?.plan?.platform?.site || "boss").trim().toLowerCase();
  const scanKind = resolveScanKind(command, args);
  const runId = String(args["run-id"] || "").trim();
  const owner = `${runId || crypto.randomUUID()}:${process.pid}`;
  return runWithSiteScanLease({
    acquire(input) {
      const lease = acquireSiteScanLease(db, input);
      logger.info("site_scan_lease_acquired", { site, scanKind, planId: lease.planId, owner, expiresAt: lease.expiresAt, runId: runId || null });
      return lease;
    },
    renew(input) {
      const expiresAt = renewSiteScanLease(db, { site, owner });
      logger.info("site_scan_lease_renewed", { site, scanKind, owner, expiresAt, runId: runId || null });
      return { site, owner, expiresAt };
    },
    release(input) {
      const released = releaseSiteScanLease(db, input);
      logger.info("site_scan_lease_released", { site, scanKind, owner, released, runId: runId || null });
      return released;
    }
  }, {
    site,
    owner,
    command: scanKind,
    planId: Number(args.plan || 0) || null
  }, run);
}

async function scan(db, args, { signal = null } = {}) {
  assertScanActive(signal);
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
  const analyzeJob = createJobAnalysisRunner(configs, keywordPlan, { db, logger });
  const analysisConcurrency = resolveAnalysisConcurrency(args);
  const site = String(args.site || planRecord?.plan?.platform?.site || "boss").trim().toLowerCase();
  const browser = createBrowser(args);
  const adapter = createSiteAdapter(site, { browser, logger });
  const cityScopes = resolveCityScopes(args, planRecord, configs);
  let browserState = null;
  if (!args.input) {
    try {
      browserState = await adapter.preflight();
      assertScanActive(signal);
      const priorRuntimeState = getSiteRuntimeState(db, site);
      if (priorRuntimeState?.status === "blocked") {
        clearSiteRuntimeState(db, site);
        logger.info("site_runtime_block_cleared", { site, priorReasonCode: priorRuntimeState.reasonCode });
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
      await resolveBossPlatformFilters({ db, adapter, args, plan: planRecord?.plan, cityScopes, keyword: keywords[0], tabId: browserState.tabId }),
      scanPolicy
    );
  if (!args.input) console.error(`[platform] BOSS 预筛：${formatNativeFilterSummary(nativeFilterSnapshot) || "未命中可用原生条件"}`);
  const reusableDetails = new Map((args.input ? [] : listReusableJobDetails(db, {
    site,
    profileId: planRecord?.profileId,
    maxAgeDays: PRODUCT_POLICY.operations.detailCacheMaxAgeDays
  })).map((item) => [item.sourceId, item]));
  if (reusableDetails.size) logger.info("boss_reusable_details_loaded", { count: reusableDetails.size, maxAgeDays: PRODUCT_POLICY.operations.detailCacheMaxAgeDays });
  const batchId = createBatch(db, site, keywords.join(", "), args.input ? `json-input:${source}` : `browser:${args.browser || "none"}:${source}`, {
    profileId: planRecord?.profileId,
    searchPlanId: planRecord?.id,
    filterSnapshot: { ...nativeFilterSnapshot, runtimePolicy: scanPolicy.snapshot, runtimePolicyHash: scanPolicy.policyHash }
  });
  for (const keyword of keywords) upsertKeywordSource(db, keyword, source);
  logger.info("scan_started", {
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
    scanLimits: {
      maxCards: resolveScanLimit(args, "max-cards", scanPolicy.maxCards, scanPolicy.maxCards),
      maxDetailTotal: resolveScanLimit(args, "max-detail-total", scanPolicy.maxDetailTotal, scanPolicy.maxDetailTotal),
      browserPageBudget: resolveScanLimit(args, "browser-page-budget", scanPolicy.browserPageBudget, scanPolicy.browserPageBudget)
    },
    modelProvider: configs.model?.provider || "mock",
    model: configs.model?.providers?.[configs.model?.provider || "mock"]?.model || ""
  });

  let checkpointed = 0;
  const onTargetComplete = args.input ? null : async (result) => {
    assertScanActive(signal);
    recordScanTargetResult(db, {
      batchId,
      targetKey: result.targetKey,
      city: result.city,
      keyword: result.keyword,
      laneId: result.laneId,
      status: result.status,
      jobCount: result.jobCount,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      details: result.details,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt
    });
    for (const raw of result.jobs || []) {
      upsertJob(db, checkpointScannedJob(raw, configs), batchId);
      checkpointed += 1;
    }
    logger.info("scan_target_checkpointed", {
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
    browserPageBudget: resolveScanLimit(args, "browser-page-budget", scanPolicy.browserPageBudget, scanPolicy.browserPageBudget),
    maxCards: resolveScanLimit(args, "max-cards", scanPolicy.maxCards, scanPolicy.maxCards),
    maxDetailTotal: resolveScanLimit(args, "max-detail-total", scanPolicy.maxDetailTotal, scanPolicy.maxDetailTotal),
    detailLimits: scanPolicy.detailLimits,
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
    },
    onTargetComplete,
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
  if (detailCoverage) logger.info("boss_detail_coverage", { batchId, ...detailCoverage });
  logger.info("job_analysis_started", { batchId, jobCount: rawJobs.length, analysisConcurrency });
  const analyzedJobs = await mapWithConcurrency(rawJobs, analysisConcurrency, (raw) => {
    assertScanActive(signal);
    return analyzeScannedJob(raw, { configs, analyzeJob });
  });
  assertScanActive(signal);
  let saved = 0;
  for (const job of analyzedJobs) {
    upsertJob(db, job, batchId);
    saved += 1;
  }
  logger.info("job_analysis_completed", { batchId, jobCount: analyzedJobs.length, analysisConcurrency });
  const report = renderReports(listReportJobs(db, { batchId }), path.join(ROOT, "reports"));
  logger.info("scan_completed", { batchId, saved, reportMarkdown: path.basename(report.mdPath), reportHtml: path.basename(report.htmlPath) });
  console.log(`导入 ${saved} 个岗位`);
  if (detailCoverage) {
    console.log(`详情覆盖：应读 ${detailCoverage.detailRequired}，成功 ${detailCoverage.detailRead}，待补 ${detailCoverage.detailPending}；左栏明确排除 ${detailCoverage.hardFiltered}`);
  }
  console.log(`Markdown: ${report.mdPath}`);
  console.log(`HTML: ${report.htmlPath}`);
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

async function refreshDetails(db, args, { signal = null } = {}) {
  assertScanActive(signal);
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
  const adapter = createSiteAdapter("boss", { browser, logger });
  const browserState = await adapter.preflight();
  assertScanActive(signal);

  let configs = loadConfigs(ROOT);
  configs.model = resolveRuntimeModelConfig({ root: ROOT, fallbackModelConfig: configs.model }).modelConfig;
  configs = profileToRuntimeConfigs(configs, profileRecord.profile, planRecord.plan, listCandidateResumeVersions(db, profileRecord.id));
  const keywordPlan = (planRecord.plan.keywords || []).map((item) => ({ ...item }));
  const analyzeJob = createJobAnalysisRunner(configs, keywordPlan, { db, logger });
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
      if (activityOnly) return isActivityProbeDue(job);
      return tags.has("detail_unverified") || tags.has("activity_unverified");
    })
    .sort((a, b) => Number((a.qualityTags || []).includes("detail_unverified")) - Number((b.qualityTags || []).includes("detail_unverified")))
    .slice(0, limit);
  if (!pending.length) {
    console.log(activityOnly ? "当前没有超过 3 天有效期、需要更新活跃状态的历史岗位。" : "当前没有需要补读的岗位详情。");
    return;
  }

  const refreshKind = activityOnly ? "activity-probe" : "detail-refresh";
  const batchId = createBatch(db, "boss", refreshKind, `browser:${args.browser || "none"}:${refreshKind}:plan:${planId}`, {
    profileId: planRecord.profileId,
    searchPlanId: planId,
    filterSnapshot: { mode: refreshKind, requested: pending.length }
  });
  logger.info(activityOnly ? "activity_probe_started" : "detail_refresh_started", { batchId, planId, requested: pending.length, browser: args.browser, analysisConcurrency });
  const refreshMethod = activityOnly ? adapter.probeActivities.bind(adapter) : adapter.refreshDetails.bind(adapter);
  const rawJobs = await refreshMethod(pending, {
    limit,
    tabId: browserState.tabId,
    signal,
    onAttempt: async (attempt) => {
      assertScanActive(signal);
      const nextRetryAt = attempt.result === "failed"
        ? refreshRetryAt(attempt.errorCode)
        : activityOnly ? new Date(Date.now() + PRODUCT_POLICY.operations.activityRefreshDays * 24 * 60 * 60 * 1000).toISOString() : "";
      recordJobRefreshAttempt(db, {
        jobId: attempt.job.id,
        result: attempt.result,
        errorCode: attempt.errorCode,
        errorMessage: attempt.errorMessage,
        nextRetryAt
      });
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
  logger.info(activityOnly ? "activity_probe_completed" : "detail_refresh_completed", { batchId, planId, requested: pending.length, refreshed: analyzedJobs.length });
  console.log(`${activityOnly ? "活跃状态更新" : "补读"}完成：请求 ${pending.length} 条，成功 ${analyzedJobs.length} 条`);
  console.log(`Markdown: ${report.mdPath}`);
  console.log(`HTML: ${report.htmlPath}`);
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

function resolveScanLimit(args, key, plannedValue, fallback, { allowZero = false } = {}) {
  const raw = args[key] ?? plannedValue;
  const value = Number(raw);
  if (Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)) return value;
  return fallback;
}

async function resolveBossPlatformFilters({ db, adapter, args, plan, cityScopes, keyword, tabId }) {
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
  logger.info("platform_filters_resolved", {
    site: "boss",
    refreshed: shouldRefresh,
    catalogVersion: snapshot.catalogVersion,
    params: snapshot.params,
    labels: snapshot.labels
  });
  for (const warning of snapshot.warnings || []) logger.warn("platform_filter_remapped", { site: "boss", ...warning });
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
  run.ps1 mark-applied --job-id <id> --note "人工确认已沟通"
  run.ps1 mark-skipped --job-id <id> --reason "地点不合适"
  run.ps1 mark-no-reply --job-id <id> --note "已投递，暂未回复"

安全边界：只读岗位信息，不自动点“立即沟通”，不自动发送消息。`);
}
