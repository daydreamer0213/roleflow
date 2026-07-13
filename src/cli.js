#!/usr/bin/env node
const path = require("path");
const { loadConfigs } = require("./config");
const { EdgeControlAdapter } = require("./adapters/browser/edge_control");
const { CdpBrowserAdapter } = require("./adapters/browser/cdp");
const { BossSiteAdapter, cleanDetailText } = require("./adapters/sites/boss");
const { scoreJob, decisionState } = require("./core/scoring");
const { createGreeting } = require("./core/llm");
const { resolvePlannedKeywords, adjustKeywordPlanWithFeedback } = require("./core/keyword_planner");
const { createJobAnalysisRunner } = require("./core/job_analysis");
const { analyzeResumeToPlan } = require("./core/profile_onboarding");
const { cityToBossCode, profileToRuntimeConfigs, planKeywords } = require("./core/search_plan");
const {
  openDb,
  createBatch,
  buildFeedbackSummary,
  buildBatchSummary,
  upsertKeywordSource,
  upsertJob,
  listReportJobs,
  markApplication,
  getCandidateProfile,
  getSearchPlan,
  getLatestBatchId,
  listCandidateResumeVersions,
  saveProfileAnalysis,
  bindBatchToPlan,
  reassessBatchObservations
} = require("./core/storage");
const { parseResumeUpload } = require("./core/resume_parser");
const { renderReports } = require("./reports/render");
const { createDashboardServer } = require("./dashboard/server");
const { createLogger, errorMeta } = require("./core/observability");
const { resolveRuntimeModelConfig } = require("./core/model_settings");

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
  if (command === "help" || args.help) return printHelp();
  logger.info("cli_command_started", { command, argKeys: Object.keys(args).sort() });

  const db = openDb(path.resolve(args.db || DEFAULT_DB));
  if (command === "init-db") {
    console.log(`SQLite ready: ${path.resolve(args.db || DEFAULT_DB)}`);
    return;
  }

  if (command === "scan") return scan(db, args);
  if (command === "profile-create") return createProfile(db, args);
  if (command === "bind-batch") return bindBatch(db, args);
  if (command === "reassess-batch") return reassessBatch(db, args);
  if (command === "rebuild-report") return rebuildReport(db);
  if (command === "dashboard") return startDashboard(db, args);
  if (command === "feedback-summary") return printFeedbackSummary(db);
  if (command === "batch-summary") return printBatchSummary(db, args);
  if (command === "mark-applied") return mark(db, args, "applied");
  if (command === "mark-skipped") return mark(db, args, "skipped");
  if (command === "mark-no-reply") return mark(db, args, "no_reply");
  throw new Error(`未知命令：${command}`);
}

async function scan(db, args) {
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
    configs = profileToRuntimeConfigs(configs, profileRecord.profile, planRecord.plan, listCandidateResumeVersions(db, profileRecord.id));
  }
  const feedbackSummary = buildFeedbackSummary(db, { profileId: planRecord?.profileId });
  const planned = planRecord && !args.keywords && !args.keyword
    ? (() => {
      const keywordPlan = adjustKeywordPlanWithFeedback(planRecord.plan.keywords || [], feedbackSummary);
      return { keywords: keywordPlan.map((item) => item.word), keywordPlan, source: `search-plan:${planRecord.id}:feedback-aware` };
    })()
    : resolvePlannedKeywords(args, configs, feedbackSummary);
  if (!planned.keywords.length) throw new Error("Search Plan 没有可用关键词，请先在页面补充后再扫描。");
  const { keywords, keywordPlan, source } = planned;
  const analyzeJob = createJobAnalysisRunner(configs, keywordPlan, { db, logger });
  const browser = createBrowser(args);
  const adapter = new BossSiteAdapter({ browser, logger });
  if (!args.input) await browser.activeTabId();
  const batchId = createBatch(db, args.site || "boss", keywords.join(", "), args.input ? `json-input:${source}` : `browser:${args.browser || "none"}:${source}`, {
    profileId: planRecord?.profileId,
    searchPlanId: planRecord?.id
  });
  for (const keyword of keywords) upsertKeywordSource(db, keyword, source);
  logger.info("scan_started", {
    batchId,
    planId: planRecord?.id || null,
    keywordCount: keywords.length,
    source,
    browser: args.browser || "input",
    hasInput: Boolean(args.input),
    modelProvider: configs.model?.provider || "mock",
    model: configs.model?.providers?.[configs.model?.provider || "mock"]?.model || ""
  });

  const rawJobs = await adapter.scan({
    input: args.input,
    keywords,
    keywordPlan,
    cityScopes: resolveCityScopes(args, planRecord, configs),
    maxCards: resolveScanLimit(args, "max-cards", planRecord?.plan?.scan?.maxCards, 60),
    detailLimit: resolveScanLimit(args, "detail-limit", planRecord?.plan?.scan?.detailLimit, 5, { allowZero: true }),
    maxDetailTotal: resolveScanLimit(args, "max-detail-total", planRecord?.plan?.scan?.maxDetailTotal, 150),
    scoreQuick: (job) => scoreJob(job, configs).score
  });

  let saved = 0;
  for (const raw of rawJobs) {
    const scored = scoreJob(raw, configs);
    const baseGreeting = createGreeting(raw, configs.profile);
    const gate = decisionState(scored);
    const baseAnalysis = gate === "ready"
      ? await analyzeJob({ ...raw, ...scored, greeting: baseGreeting })
      : ruleGateAnalysis({ ...raw, ...scored, greeting: baseGreeting }, gate);
    const analysis = {
      ...baseAnalysis,
      workSchedule: scored.workSchedule,
      workScheduleEvidence: scored.workScheduleEvidence
    };
    const job = { ...raw, ...scored, analysis, greeting: analysis.greeting || baseGreeting };
    upsertJob(db, job, batchId);
    saved += 1;
  }
  const report = renderReports(listReportJobs(db, { batchId }), path.join(ROOT, "reports"));
  logger.info("scan_completed", { batchId, saved, reportMarkdown: path.basename(report.mdPath), reportHtml: path.basename(report.htmlPath) });
  console.log(`导入 ${saved} 个岗位`);
  console.log(`Markdown: ${report.mdPath}`);
  console.log(`HTML: ${report.htmlPath}`);
}

function resolveScanLimit(args, key, plannedValue, fallback, { allowZero = false } = {}) {
  const raw = args[key] ?? plannedValue;
  const value = Number(raw);
  if (Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)) return value;
  return fallback;
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
    missingPoints: [],
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
  const feedbackSummary = buildFeedbackSummary(db, { profileId: planRecord.profileId });
  const keywordPlan = adjustKeywordPlanWithFeedback(planRecord.plan.keywords || [], feedbackSummary);
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

function offlineMockModelConfig() {
  return {
    provider: "mock",
    providers: { mock: { model: "offline-structured-mock" } }
  };
}

function rebuildReport(db) {
  const report = renderReports(listReportJobs(db), path.join(ROOT, "reports"));
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
  run.ps1 scan --site boss --input data\\sample_jobs.json
  run.ps1 scan --site boss --browser edge --plan <Search Plan ID>
  run.ps1 scan --input data\\sample_jobs.json --profile profiles\\guo_mingfu.json --resume-versions profiles\\resume_versions.json
  run.ps1 dashboard --port 8787
  run.ps1 rebuild-report
  run.ps1 feedback-summary
  run.ps1 batch-summary --batch latest
  run.ps1 mark-applied --job-id <id> --note "人工确认已沟通"
  run.ps1 mark-skipped --job-id <id> --reason "地点不合适"
  run.ps1 mark-no-reply --job-id <id> --note "已投递，暂未回复"

安全边界：只读岗位信息，不自动点“立即沟通”，不自动发送消息。`);
}
