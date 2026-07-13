const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  listReportJobs,
  markApplication,
  markCandidateJob,
  addFollowUpNote,
  buildBatchSummary,
  buildFeedbackSummary,
  getLatestBatchId,
  getCandidateProfile,
  listCandidateProfiles,
  getSearchPlan,
  getActiveSearchPlan,
  saveProfileAnalysis,
  updateCandidateProfile,
  saveCandidateResumeVersion,
  listCandidateResumeVersions,
  recordResumeParseAttempt,
  listResumeParseAttempts,
  saveSearchPlan,
  rescorePlanObservations,
  compareProfileVersions,
  listDecisionPool,
  listDecisionQueue,
  OUTCOME_STATUSES
} = require("../core/storage");
const { parseResumeUpload, parseResumeText, MAX_UPLOAD_BYTES } = require("../core/resume_parser");
const { analyzeResumeToPlan } = require("../core/profile_onboarding");
const { normalizeCandidateProfile, normalizeSearchPlan } = require("../core/profile_schema");
const { planKeywords, profileToRuntimeConfigs } = require("../core/search_plan");
const { loadConfigs } = require("../config");
const { validateSearchPlan } = require("../core/plan_validation");
const { createLogger, errorMeta, publicError } = require("../core/observability");
const { SECRET_ID, listModelPresets, loadModelSettings, saveModelSettings, resolveRuntimeModelConfig, isModelReady } = require("../core/model_settings");
const { saveSecret, clearSecret } = require("../core/secret_store");

const VALID_STATUSES = new Set(OUTCOME_STATUSES);

function createDashboardServer({ db, root = path.resolve(__dirname, "../.."), dbPath = "", modelConfig = { provider: "mock", providers: { mock: {} } }, allowOfflineMock = false, forceMock = false, logger = createLogger({ root, component: "dashboard" }) }) {
  const scanRuns = new Map();
  const offlineMockState = {
    source: "runtime",
    settings: { preset: "mock", provider: "mock", baseUrl: "", model: "offline-structured-mock", timeoutMs: 30000 },
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
      if (req.method === "GET" && url.pathname === "/") return redirectHome(res, db, modelReady());
      if (req.method === "GET" && url.pathname === "/onboarding" && !modelReady()) return redirect(res, modelSetupPath("/onboarding"));
      if (req.method === "GET" && url.pathname === "/onboarding") return sendHtml(res, renderOnboarding({ profiles: listCandidateProfiles(db), modelConfig: getPublicModelSettings().modelConfig, selectedProfileId: url.searchParams.get("profileId") }));
      if (req.method === "GET" && url.pathname === "/settings") return sendHtml(res, renderModelSettingsPage({ modelState: getPublicModelSettings(), searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/profile") return sendHtml(res, renderProfilePage({ db, searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/resumes") return sendHtml(res, renderResumeVersionsPage({ db, searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/plan") return sendHtml(res, renderPlanPage({ db, searchParams: url.searchParams, modelConfig: getPublicModelSettings().modelConfig, scanRuns }));
      if (req.method === "GET" && url.pathname === "/queue") return sendHtml(res, renderQueuePage({ db, searchParams: url.searchParams }));
      if (req.method === "GET" && url.pathname === "/jobs") return sendHtml(res, renderDashboard(getDashboardData(db, url.searchParams)));
      if (req.method === "GET" && url.pathname === "/diagnostics") return sendHtml(res, renderDiagnosticsPage(logger.listRecent()));
      if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, logging: "enabled" });
      if (req.method === "GET" && url.pathname === "/api/scan-status") return sendJson(res, 200, scanStatus(scanRuns, url.searchParams.get("planId")));
      if (req.method === "POST" && url.pathname === "/api/mark") return handlePost(req, res, (body, type) => handleMarkApi(db, body, type), { logger, requestId, action: "mark_job" });
      if (req.method === "POST" && url.pathname === "/api/follow-up") return handlePost(req, res, (body, type) => handleFollowUpApi(db, body, type), { logger, requestId, action: "add_follow_up" });
      if (req.method === "POST" && url.pathname === "/api/resume") return handleResumeUpload(req, res, { db, root, modelConfig: getRuntimeModelConfig(), modelReady: modelReady(), logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/settings/model") return handleModelSettingsSave(req, res, { root, fallbackModelConfig: modelConfig, logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/profile") return handleProfileSave(req, res, db, { logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/resume-version") return handleResumeVersionSave(req, res, { db, root, logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/plan") return handlePlanSave(req, res, db, { root, logger, requestId });
      if (req.method === "POST" && url.pathname === "/api/scan") return handlePlanScan(req, res, { db, root, dbPath, scanRuns, modelReady: modelReady(), logger, requestId });
      sendText(res, 404, "Not found");
    } catch (error) {
      logger.error("http_unhandled_error", { requestId, method: req.method, path: url?.pathname || req.url, error: errorMeta(error) });
      respondUnexpectedError(res, error, requestId, url?.pathname || req.url);
    }
  });
}

function redirectHome(res, db, modelReady) {
  if (!modelReady) return redirect(res, modelSetupPath("/onboarding"));
  const profile = listCandidateProfiles(db)[0];
  if (!profile) return redirect(res, "/onboarding");
  const plan = getActiveSearchPlan(db, profile.id);
  if (!plan) return redirect(res, `/onboarding?profileId=${profile.id}`);
  return redirect(res, getLatestBatchId(db, { planId: plan.id }) ? `/queue?planId=${plan.id}` : `/plan?profileId=${plan.profileId}&planId=${plan.id}`);
}

async function handleResumeUpload(req, res, { db, root, modelConfig, modelReady, logger, requestId }) {
  let form = { fields: {}, files: {} };
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
    const { profile, plan } = await analyzeResumeToPlan({ modelConfig, resume });
    const saved = saveProfileAnalysis(db, { profileId: form.fields.profileId, profile, document: resume, searchPlan: plan });
    recordResumeParseAttempt(db, { profileId: saved.profileId, document: resume });
    logger.info("resume_profile_created", { requestId, profileId: saved.profileId, planId: saved.planId, modelProvider: modelConfig?.provider || "mock" });
    redirect(res, `/plan?profileId=${saved.profileId}&planId=${saved.planId}&created=1`);
  } catch (error) {
    const failedFile = form.files?.resume;
    try {
      recordResumeParseAttempt(db, {
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

async function handleModelSettingsSave(req, res, { root, fallbackModelConfig, logger, requestId }) {
  try {
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    const settings = saveModelSettings({ root, input: params, fallbackModelConfig });
    const apiKey = String(params.apiKey || "").trim();
    if (params.clearApiKey === "on") clearSecret(root, SECRET_ID);
    if (apiKey) saveSecret(root, SECRET_ID, apiKey);
    const state = loadModelSettings({ root, fallbackModelConfig });
    logger.info("model_settings_saved", {
      requestId,
      preset: settings.preset,
      provider: settings.provider,
      model: settings.model,
      keyConfigured: state.keyConfigured
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

async function handleResumeVersionSave(req, res, { db, root, logger, requestId }) {
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
    const saved = saveCandidateResumeVersion(db, {
      profileId,
      versionId: form.fields.versionId,
      document,
      version: resumeVersionFromForm(form.fields)
    });
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
    skills: parseSkillLines(params.skills),
    projects: parseProjectLines(params.projects),
    source: existing.source || {}
  };
  return normalizeCandidateProfile(profile, {
    provider: existing.source?.provider || "manual",
    model: existing.source?.model || "manual",
    resumeTextLength: existing.source?.resumeTextLength || 0
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
    const [name, roleBoundary, canSay, avoidSaying] = line.split("|").map((item) => item.trim());
    return { name, roleBoundary: roleBoundary || "按实际参与边界表达", canSay: splitTerms(canSay), avoidSaying: splitTerms(avoidSaying) };
  });
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
      cities: splitTerms([params.cities, params.otherCities]),
      salaryMinK: params.salaryMinK,
      salaryMaxK: params.salaryMaxK,
      salaryMode: params.salaryMode,
      experience,
      allowExperienceStretch: true,
      bossActiveDays: 3,
      workSchedulePreference: params.workSchedulePreference,
      directions: splitTerms(params.directions),
      keywords: parseKeywordLines(params.keywords),
      excludeWords: splitTerms(params.excludeWords),
      hardExcludes: splitTerms(params.hardExcludes),
      scan: { maxCards: params.maxCards, detailLimit: params.detailLimit, maxDetailTotal: params.maxDetailTotal },
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

async function handlePlanScan(req, res, { db, root, dbPath, scanRuns, modelReady, logger, requestId }) {
  try {
    if (!modelReady) throw new Error("请先完成模型配置，再启动智能筛选。");
    const params = parseBody(await readBody(req), req.headers["content-type"] || "");
    const plan = getSearchPlan(db, params.planId);
    if (!plan) throw new Error("Search Plan 不存在，请重新确认筛选条件。");
    const profile = getCandidateProfile(db, plan.profileId);
    const validation = validateSearchPlan(plan.plan, profile?.profile || {});
    if (!validation.valid) throw new Error(validation.errors.join("；"));
    const cdpPort = Math.max(1, Math.min(65535, Number(params.cdpPort || 9222)));
    const browserMode = params.browserMode === "edge" ? "edge" : "portable";
    startPlanScan(scanRuns, { root, dbPath, planId: plan.id, cdpPort, browserMode, logger, requestId });
    redirect(res, `/plan?profileId=${plan.profileId}&planId=${plan.id}&scan=started`);
  } catch (error) {
    respondUiError(res, error, "/plan", { logger, requestId, event: "search_plan_scan_rejected", fallbackCode: "SCAN_START_FAILED" });
  }
}

function startPlanScan(scanRuns, { root, dbPath, planId, cdpPort, browserMode = "portable", logger, requestId }) {
  const previous = scanRuns.get(Number(planId));
  if (previous?.state === "running") throw new Error("这个 Search Plan 正在扫描中，请等待当前任务结束。");
  if (!dbPath) throw new Error("扫描数据路径未配置。");
  const run = { state: "running", startedAt: new Date().toISOString(), output: "", error: "", exitCode: null };
  const browserArgs = browserMode === "edge"
    ? ["--browser", "edge"]
    : ["--browser", "portable", "--cdp-port", String(cdpPort)];
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.js", "scan", "--db", dbPath, "--plan", String(planId), "--site", "boss", ...browserArgs], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  scanRuns.set(Number(planId), run);
  logger.info("scan_process_started", { requestId, planId: Number(planId), browserMode, cdpPort: browserMode === "portable" ? cdpPort : null, childPid: child.pid });
  const append = (chunk) => { run.output = `${run.output}${String(chunk)}`.slice(-4000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => {
    run.state = "failed";
    run.error = error.message;
    run.finishedAt = new Date().toISOString();
    logger.error("scan_process_error", { requestId, planId: Number(planId), error: errorMeta(error) });
  });
  child.on("close", (code) => {
    run.exitCode = code;
    run.state = code === 0 ? "completed" : "failed";
    if (code !== 0) run.error = run.output || `扫描进程退出：${code}`;
    run.finishedAt = new Date().toISOString();
    const context = { requestId, planId: Number(planId), exitCode: code, durationMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt) };
    if (code === 0) logger.info("scan_process_completed", context);
    else logger.error("scan_process_failed", { ...context, outputTail: run.output });
  });
}

function scanStatus(scanRuns, planId) {
  const run = scanRuns.get(Number(planId));
  return run || { state: "idle" };
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
  const jobs = filterJobs(listReportJobs(db, batchOptions(filters)), filters);
  return {
    filters,
    jobs,
    latestBatchId: getLatestBatchId(db, batchOptions(filters)),
    summary: summarizeJobs(jobs, buildBatchSummary(db, batchOptions(filters)))
  };
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
  const reasonCode = String(params.reasonCode || "").trim().slice(0, 80);
  const reviewAt = String(params.reviewAt || "").trim();

  if (!Number.isInteger(jobId) || jobId <= 0) return { statusCode: 400, body: { error: "invalid jobId" } };
  if (!VALID_STATUSES.has(status)) return { statusCode: 400, body: { error: "invalid status" } };
  if (reviewAt && !/^\d{4}-\d{2}-\d{2}$/.test(reviewAt)) return { statusCode: 400, body: { error: "invalid reviewAt" } };
  const exists = db.prepare("SELECT id FROM jobs WHERE id = ?").get(jobId);
  if (!exists) return { statusCode: 404, body: { error: "job not found" } };

  if (profileId) {
    if (!getCandidateProfile(db, profileId)) return { statusCode: 404, body: { error: "candidate profile not found" } };
    markCandidateJob(db, { profileId, planId, jobId, status, note, reasonCode, reviewAt });
  } else {
    markApplication(db, jobId, status, note);
  }
  return { statusCode: 200, body: { ok: true, jobId, profileId: profileId || null, status } };
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
  const saved = searchParams.get("saved") ? `<p class="notice">画像已保存。搜索方案不会被静默改写，请在方案页按需确认。</p>` : "";
  return renderPage("画像摘要", `<main>
  <nav>${navLinks(`/profile?profileId=${profile.id}`)}<a href="/resumes?profileId=${profile.id}">简历版本</a><a href="/plan?profileId=${profile.id}">筛选方案</a></nav>
  <h1>画像摘要</h1>
  ${saved}
  <p class="hint">默认按你提供的内容使用；只在需要调整方向、薪资或项目表述时再编辑。</p>
  <form class="panel form-stack" method="post" action="/api/profile">
    <input type="hidden" name="profileId" value="${escapeAttr(profile.id)}">
    <label>姓名<input name="name" value="${escapeAttr(candidate.name || profile.displayName)}"></label>
    <label>优先城市<input name="city" value="${escapeAttr(candidate.city || "")}" placeholder="例如：广州"></label>
    <label>目标方向<input name="targetTitles" value="${escapeAttr((candidate.targetTitles || []).join("、"))}" placeholder="用顿号或逗号分隔"></label>
    <label>期望薪资<input name="expectedSalary" value="${escapeAttr(candidate.expectedSalary || "")}" placeholder="例如：9-14K"></label>
    <label>可调整范围<input name="adjustableSalary" value="${escapeAttr((candidate.adjustableSalary || []).join("、"))}" placeholder="例如：8-12K、9-13K"></label>
    <label>技能（每行：技能 | 佐证）<textarea name="skills">${escapeHtml(profileSkillLines(profile.profile.skills))}</textarea></label>
    <label>项目（每行：项目名 | 贡献边界 | 可讲点 | 不主动讲）<textarea name="projects">${escapeHtml(profileProjectLines(profile.profile.projects))}</textarea></label>
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
    <button>解析并新增版本</button>
  </form>
  ${versions.length ? versions.map((version) => renderResumeVersion(version, profile.id)).join("") : `<section class="panel">暂无可用版本。</section>`}
</main>`);
}

function renderResumeVersion(version, profileId) {
  const file = version.fileName ? `${version.fileName} / ${version.format || "text"}` : "仅元数据版本";
  return `<form class="panel form-stack" method="post" action="/api/resume-version">
    <input type="hidden" name="profileId" value="${escapeAttr(profileId)}"><input type="hidden" name="versionId" value="${escapeAttr(version.id)}">
    <h2>${escapeHtml(version.name)}</h2><p class="hint">${escapeHtml(file)}，更新于 ${escapeHtml(String(version.updatedAt || "").slice(0, 16).replace("T", " "))}</p>
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
  return (projects || []).map((item) => [item.name || item, item.roleBoundary || "", (item.canSay || []).join("、"), (item.avoidSaying || []).join("、")].join(" | ")).join("\n");
}

function renderParseAttempts(attempts) {
  if (!attempts.length) return `<p class="hint">暂无解析记录。</p>`;
  const rows = attempts.map((attempt) => `<tr><td>${escapeHtml(String(attempt.createdAt || "").slice(0, 16).replace("T", " "))}</td><td>${escapeHtml(attempt.status)}</td><td>${escapeHtml(attempt.fileName)}</td><td>${escapeHtml(attempt.extractionMethod || "-")}</td><td>${escapeHtml(attempt.charCount)}</td><td>${escapeHtml(parseOcrLabel(attempt.diagnostics?.ocr))}</td><td>${escapeHtml(attempt.errorCode || "-")}</td><td>${escapeHtml(attempt.preview || attempt.errorMessage || "-")}</td></tr>`).join("");
  return `<table class="diagnostics"><thead><tr><th>时间</th><th>结果</th><th>文件</th><th>提取方式</th><th>字数</th><th>OCR</th><th>错误码</th><th>预览/原因</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderParseDiagnostic(diagnostics = {}) {
  if (!diagnostics || !Object.keys(diagnostics).length) return "";
  return `<div class="line"><strong>解析：</strong>${escapeHtml(diagnostics.extractionMethod || "-")}，${escapeHtml(diagnostics.charCount || 0)} 字，OCR：${escapeHtml(parseOcrLabel(diagnostics.ocr))}</div>`;
}

function parseOcrLabel(ocr = {}) {
  if (!ocr || ocr.status === "not_required") return "不需要";
  if (ocr.status === "suggested") return ocr.available ? "建议使用本地 OCR" : "疑似扫描件，需 OCR 环境";
  if (ocr.status === "available") return "本地 OCR 可用";
  return "本地 OCR 未安装";
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

function renderOnboarding({ profiles, modelConfig, selectedProfileId = "" }) {
  const selectedId = String(selectedProfileId || "");
  const options = profiles.map((profile) => `<option value="${escapeAttr(profile.id)}"${String(profile.id) === selectedId ? " selected" : ""}>更新：${escapeHtml(profile.displayName)}（${escapeHtml(profile.updatedAt.slice(0, 10))}）</option>`).join("");
  const provider = modelConfig?.provider || "mock";
  const model = modelConfig?.providers?.[provider]?.model || "";
  return renderPage("简历分析", `<main>
  <nav>${navLinks()}</nav>
  <h1>简历分析</h1>
  <p class="hint">当前分析模式：${escapeHtml(provider)}${model ? ` · ${escapeHtml(model)}` : ""}</p>
  <form class="panel form-stack" method="post" action="/api/resume" enctype="multipart/form-data">
    <label>候选人画像<select name="profileId"><option value="">新建候选人</option>${options}</select></label>
    <label>上传简历文件<input name="resume" type="file" accept=".txt,.md,.docx,.pdf" onchange="document.getElementById('resume-text').value=''"></label>
    <label>粘贴或填写简历文本<textarea id="resume-text" name="resumeText" placeholder="工作/实习经历、项目经历、专业技能、个人优势" oninput="document.querySelector('[name=resume]').value=''"></textarea></label>
    <div class="inline-form"><button type="button" data-template="${escapeAttr(JSON.stringify(resumeTextTemplate()))}" onclick="const target=document.getElementById(&quot;resume-text&quot;);if(!target.value.trim())target.value=JSON.parse(this.dataset.template);target.focus()">使用模板</button></div>
    <button>解析并生成筛选建议</button>
  </form>
  ${profiles.length ? `<section class="panel"><h2>已有候选人</h2>${profiles.map((profile) => `<p><a href="/plan?profileId=${profile.id}&planId=${profile.activePlanId || ""}">${escapeHtml(profile.displayName)}</a> · 最近更新 ${escapeHtml(profile.updatedAt.slice(0, 16).replace("T", " "))}</p>`).join("")}</section>` : ""}
</main>`);
}

function renderModelSettingsPage({ modelState, searchParams }) {
  const storedSettings = modelState.settings || {};
  const presets = listModelPresets();
  const firstSetup = modelState.source === "legacy" && storedSettings.provider === "mock" && !modelState.keyConfigured;
  const settings = firstSetup
    ? { preset: "deepseek", provider: "openai_compatible", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", timeoutMs: 30000 }
    : storedSettings;
  const selectedPreset = presets.find((item) => item.id === settings.preset) || presets.find((item) => item.id === "custom");
  const presetOptions = presets.map((preset) => {
    const selected = preset.id === selectedPreset.id ? " selected" : "";
    return '<option value="' + escapeAttr(preset.id) + '"' + selected + '>' + escapeHtml(preset.label) + '</option>';
  }).join("");
  const modelOptions = renderModelOptions(selectedPreset, settings.model);
  const required = searchParams.get("required") === "1";
  const saved = searchParams.get("saved") ? '<p class="notice">模型设置已保存。</p>' : "";
  const requiredNotice = required ? '<p class="setup-warning">开始解析简历前，请先保存一个可用模型配置。</p>' : "";
  const keyStatus = modelState.keyConfigured ? "已加密保存" : "尚未保存";
  const next = safeSettingsNext(searchParams.get("next"));
  const customHidden = selectedPreset.id === "custom" ? "" : " hidden";
  const presetJson = JSON.stringify(presets);
  const body = [
    '<style>.settings-page{max-width:960px;padding-top:32px}.settings-header{max-width:720px;margin:34px 0 24px}.settings-header h1{font-size:30px;margin:4px 0 9px}.eyebrow{margin:0;color:#0969da;font-size:13px;font-weight:700}.setup-warning{border-left:4px solid #bf8700;background:#fff8c5;padding:10px 12px;margin:12px 0}.settings-form{max-width:none;padding:24px}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.settings-field{display:grid;gap:7px;font-size:14px;font-weight:600}.settings-field[hidden]{display:none}.settings-field input,.settings-field select{width:100%;box-sizing:border-box}.settings-field small{font-size:12px;line-height:1.45;font-weight:400;color:#57606a}.settings-field-wide{grid-column:1/-1}.settings-security{display:grid;gap:3px;border-top:1px solid #d8dee4;margin-top:22px;padding-top:16px;font-size:13px;color:#57606a}.settings-security strong{color:#1f2328}.settings-clear{margin-top:14px}.settings-actions{display:flex;justify-content:flex-end;margin-top:20px}@media(max-width:760px){.settings-page{padding-top:16px}.settings-header{margin:22px 0 18px}.settings-header h1{font-size:26px}.settings-form{padding:16px}.settings-grid{grid-template-columns:1fr}.settings-field-wide{grid-column:auto}.settings-actions{justify-content:stretch}.settings-actions button{width:100%}}</style>',
    '<main class="settings-page">',
    "  <nav>" + navLinks() + "</nav>",
    '  <header class="settings-header">',
    '    <p class="eyebrow">开始使用前</p>',
    '    <h1>配置模型</h1>',
    '    <p class="hint">模型用于简历解析、岗位匹配、风险判断和招呼语生成。完成配置后再进入简历步骤。</p>',
    "  </header>",
    saved,
    requiredNotice,
    '  <form class="panel settings-form" method="post" action="/api/settings/model">',
    '    <input type="hidden" name="next" value="' + escapeAttr(next) + '">',
    '    <div class="settings-grid">',
    '      <label class="settings-field">模型厂商<select id="model-preset" name="preset">' + presetOptions + "</select><small>已内置 DeepSeek、通义千问和 OpenAI 的兼容接口。</small></label>",
    '      <label class="settings-field">模型名称<select id="model-name" name="model">' + modelOptions + "</select><small>简历首次解析建议优先选择质量更高的 Pro / Plus 模型；Flash 更适合快速测试。</small></label>",
    '      <label class="settings-field settings-field-wide">兼容接口基础地址<input id="model-base-url" name="baseUrl" type="url" value="' + escapeAttr(settings.baseUrl || "") + '" placeholder="https://..."' + (selectedPreset.id === "custom" ? "" : " readonly") + '><small>预设地址会自动填入；只有“自定义兼容接口”需要手动编辑。</small></label>',
    '      <label id="custom-model-row" class="settings-field settings-field-wide"' + customHidden + '>自定义模型名<input name="customModel" maxlength="160" placeholder="例如厂商最新模型名"><small>仅自定义接口使用；填写后优先于上方模型选择。</small></label>',
    '      <label class="settings-field">API Key<input name="apiKey" type="password" autocomplete="new-password" placeholder="' + (modelState.keyConfigured ? "已保存，留空保持不变" : "粘贴 API Key") + '"><small>密钥状态：' + keyStatus + '。</small></label>',
    '      <label class="settings-field">请求超时（毫秒）<input name="timeoutMs" type="number" min="3000" max="120000" value="' + escapeAttr(settings.timeoutMs || 30000) + '"><small>默认 30000，网络较慢时可提高。</small></label>',
    "    </div>",
    '    <div class="settings-security"><strong>本机安全存储</strong><span>API Key 仅按当前 Windows 用户加密保存，不进入配置文件、日志、数据库或绿色发布包。</span></div>',
    '    <label class="checkbox settings-clear"><input name="clearApiKey" type="checkbox">删除本机已保存的 API Key</label>',
    '    <div class="settings-actions"><button>保存并进入简历解析</button></div>',
    "  </form>",
    '  <script id="model-preset-data" type="application/json">' + presetJson + "</script>",
    "  <script>",
    "  (function () {",
    '    const presets = JSON.parse(document.getElementById("model-preset-data").textContent);',
    '    const presetSelect = document.getElementById("model-preset");',
    '    const baseUrl = document.getElementById("model-base-url");',
    '    const modelName = document.getElementById("model-name");',
    '    const customRow = document.getElementById("custom-model-row");',
    "    function currentPreset() { return presets.find(function (item) { return item.id === presetSelect.value; }) || presets[0]; }",
    "    function syncMode() {",
    "      const preset = currentPreset();",
    '      baseUrl.readOnly = preset.id !== "custom";',
    '      customRow.hidden = preset.id !== "custom";',
    "    }",
    "    function updatePreset() {",
    "      const preset = currentPreset();",
    '      baseUrl.value = preset.baseUrl || "";',
    '      modelName.innerHTML = "";',
    "      const names = preset.models.length ? preset.models : (preset.defaultModel ? [preset.defaultModel] : []);",
    "      names.forEach(function (name) {",
    '        const option = document.createElement("option");',
    "        option.value = name;",
    "        option.textContent = name;",
    "        modelName.appendChild(option);",
    "      });",
    "      if (!names.length) {",
    '        const option = document.createElement("option");',
    '        option.value = "";',
    '        option.textContent = "请在下方填写自定义模型名";',
    "        modelName.appendChild(option);",
    "      }",
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

const PLAN_CITY_OPTIONS = ["广州", "深圳", "佛山", "东莞", "珠海", "上海", "杭州", "北京"];
const PLAN_EXPERIENCE_OPTIONS = ["经验不限", "0-1年", "0-3年", "1-3年", "2-3年", "3-5年（可冲）"];

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
  const otherCities = (plan.cities || []).filter((city) => !PLAN_CITY_OPTIONS.includes(city)).join("，");
  const selectedExperience = plan.experience;
  const candidate = profile.profile.candidate || {};
  const run = scanStatus(scanRuns, planRecord.id);
  const validation = validateSearchPlan(plan, profile.profile);
  const versionDiff = compareProfileVersions(db, profile.id);
  const feedback = buildFeedbackSummary(db, { profileId: profile.id });
  const confirmation = searchParams.get("saved") ? "筛选方案已保存。" : searchParams.get("created") ? "已根据你提供的简历生成画像和筛选建议，可直接开始扫描；只有需要调整时再编辑。" : "";
  const planStyle = '<style>.plan-form{max-width:none}.plan-form .choice-section{grid-column:1/-1;display:grid;gap:8px}.choice-list{display:flex;flex-wrap:wrap;gap:8px}.choice-item{display:flex!important;align-items:center;gap:6px;border:1px solid #d8dee4;border-radius:4px;padding:7px 9px;font-size:14px}.choice-item input{width:auto}.plan-note{grid-column:1/-1;margin:0;color:#57606a;font-size:13px}.plan-advanced{grid-column:1/-1;border-top:1px solid #d8dee4;padding-top:14px}.plan-advanced summary{cursor:pointer;font-weight:600}.plan-advanced-body{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:12px}.plan-advanced-body .wide{grid-column:1/-1}@media(max-width:760px){.plan-advanced-body{grid-template-columns:1fr}.plan-advanced-body .wide{grid-column:auto}}</style>';
  return renderPage("筛选方案", `${planStyle}<main>
  <nav>${navLinks(`/plan?profileId=${profile.id}&planId=${planRecord.id}`)}</nav>
  <h1>筛选方案</h1>
  ${confirmation ? `<p class="notice">${escapeHtml(confirmation)}</p>` : ""}
  ${renderPlanValidation(validation)}
  <section class="panel profile-summary">
    <div><a href="/onboarding?profileId=${profile.id}">重新解析简历</a>　<a href="/profile?profileId=${profile.id}">编辑画像</a>　<a href="/resumes?profileId=${profile.id}">管理简历版本</a></div>
    <div><strong>${escapeHtml(candidate.name || profile.displayName)}</strong> · ${escapeHtml(candidate.city || "目标城市待确认")} · ${escapeHtml((candidate.targetTitles || []).join("、") || "目标岗位待确认")}</div>
    <div class="line">技能：${escapeHtml((profile.profile.skills || []).map((item) => item.name || item).join("、") || "待确认")}</div>
    <div class="line">项目：${escapeHtml((profile.profile.projects || []).map((item) => item.name || item).join("、") || "待确认")}</div>
    ${renderProfileDiff(versionDiff)}
    ${renderFeedbackInsight(feedback)}
  </section>
  <form class="panel plan-form" method="post" action="/api/plan">
    <input type="hidden" name="profileId" value="${profile.id}"><input type="hidden" name="planId" value="${planRecord.id}">
    <label class="wide">方案名称<input name="name" value="${escapeAttr(plan.name || "")}" required></label>
    <div class="choice-section"><strong>目标城市</strong><div class="choice-list">${renderPlanChoices("cities", PLAN_CITY_OPTIONS, plan.cities)}</div><input name="otherCities" value="${escapeAttr(otherCities)}" placeholder="其他城市，多个用逗号分隔"></div>
    <div class="choice-section"><strong>工作经验</strong><div class="choice-list">${renderPlanChoices("experience", PLAN_EXPERIENCE_OPTIONS, selectedExperience)}</div></div>
    <label>最低薪资（K）<input type="number" min="0" max="100" name="salaryMinK" value="${escapeAttr(plan.salary?.minK || "")}"></label>
    <label>最高薪资（K）<input type="number" min="0" max="100" name="salaryMaxK" value="${escapeAttr(plan.salary?.maxK || "")}"></label>
    <label>薪资策略<select name="salaryMode"><option value="wide"${plan.salaryMode !== "strict" ? " selected" : ""}>宽松排序，范围外保留</option><option value="strict"${plan.salaryMode === "strict" ? " selected" : ""}>严格范围，范围外不推荐</option></select></label>
    <label>工作节奏<select name="workSchedulePreference"><option value="prefer_double_weekend"${plan.workSchedulePreference !== "no_preference" ? " selected" : ""}>优先双休，其他仍保留</option><option value="no_preference"${plan.workSchedulePreference === "no_preference" ? " selected" : ""}>不作为排序依据</option></select></label>
    <label class="wide">目标方向<input name="directions" value="${escapeAttr((plan.directions || []).join("，"))}" placeholder="例如：AI应用开发、RAG、Python后端"></label>
    <p class="plan-note">岗位质量会自动优先保留招聘方近 3 天活跃的岗位，并对超过经验范围但薪资偏初中级的岗位保留“可冲”标记。</p>
    <label class="wide">搜索关键词<textarea name="keywords" required>${escapeHtml(keywordLines(plan.keywords))}</textarea></label>
    <details class="plan-advanced"><summary>高级筛选项</summary><div class="plan-advanced-body"><label class="wide">排除词<input name="excludeWords" value="${escapeAttr((plan.excludeWords || []).join("，"))}"></label><label class="wide">硬排除词<input name="hardExcludes" value="${escapeAttr((plan.hardExcludes || []).join("，"))}"></label><label>A类每词岗位数<input type="number" min="10" max="200" name="maxCards" value="${escapeAttr(plan.scan?.maxCards || 80)}"></label><label>A类每词详情数<input type="number" min="0" max="30" name="detailLimit" value="${escapeAttr(plan.scan?.detailLimit || 8)}"></label><label>详情总上限<input type="number" min="10" max="500" name="maxDetailTotal" value="${escapeAttr(plan.scan?.maxDetailTotal || 180)}"></label></div></details>
    <div class="wide"><button>保存筛选方案</button></div>
  </form>
  <section class="panel scan-panel">
    <div><strong>扫描状态：</strong>${escapeHtml(scanLabel(run))}</div>
    ${run.error ? `<pre class="scan-error">${escapeHtml(run.error)}</pre>` : ""}
    <form class="inline-form" method="post" action="/api/scan"><input type="hidden" name="planId" value="${planRecord.id}"><input type="hidden" name="cdpPort" value="9222"><select name="browserMode" title="浏览器模式"><option value="portable">项目专用 Edge</option><option value="edge">当前已登录 Edge</option></select><button${run.state === "running" || !validation.valid ? " disabled" : ""}>开始扫描</button><a class="button-link" href="/queue?planId=${planRecord.id}">今日队列</a><a class="button-link" href="/jobs?planId=${planRecord.id}&batch=latest">查看岗位</a></form>
  </section>
</main>${run.state === "running" ? `<script>setTimeout(()=>location.reload(),2500)</script>` : ""}`);
}

function renderErrorPage(message, back, { code = "", requestId = "" } = {}) {
  const diagnostic = code ? `<p class="error-code">错误编号：${escapeHtml(code)}${requestId ? ` · 请求编号：${escapeHtml(requestId)}` : ""}</p><p class="hint">可在“诊断”页面查看对应日志。</p>` : "";
  return renderPage("操作未完成", `<main><nav>${navLinks()}</nav><h1>操作未完成</h1><section class="panel"><p class="risk-text">${escapeHtml(message)}</p>${diagnostic}<p><a href="${escapeAttr(back)}">返回</a></p></section></main>`);
}

function renderDiagnosticsPage(entries = []) {
  const rows = entries.map((entry) => {
    const error = entry.error || {};
    const code = error.code || entry.errorCode || "";
    const message = String(error.message || entry.message || "").slice(0, 240);
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
  const reasonRows = Object.entries(feedback.skipReasons || {})
    .filter(([, value]) => value.skipped > 0)
    .sort((a, b) => b[1].skipped - a[1].skipped)
    .slice(0, 3)
    .map(([reason, value]) => `${reason || "未填写"} ${value.skipped} 次`);
  const keywordRows = Object.entries(feedback.keywords || {})
    .filter(([, value]) => value.skipped >= 2 && value.applied === 0)
    .sort((a, b) => b[1].skipped - a[1].skipped)
    .slice(0, 3)
    .map(([keyword, value]) => `${keyword}（跳过 ${value.skipped}）`);
  if (!reasonRows.length && !keywordRows.length) return "";
  const sections = [
    reasonRows.length ? `高频跳过原因：${reasonRows.join("；")}` : "",
    keywordRows.length ? `将自动降权的关键词：${keywordRows.join("、")}` : ""
  ].filter(Boolean);
  return `<div class="line profile-diff"><strong>历史反馈：</strong>${escapeHtml(sections.join("。"))}</div>`;
}

function renderPage(title, body) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
body{font-family:Segoe UI,Microsoft YaHei,sans-serif;margin:0;background:#f6f7f9;color:#1f2328}main{max-width:1160px;margin:0 auto;padding:24px}nav{display:flex;gap:14px;margin-bottom:18px}nav a{color:#0969da;text-decoration:none}h1{font-size:24px;margin:0 0 8px;letter-spacing:0}h2{font-size:16px;margin:0 0 10px}.hint,.line{color:#57606a;margin:7px 0}.notice{color:#0a6b2b}.risk-text{color:#b42318}.error-code{font-family:Consolas,monospace;color:#57606a}.panel{background:#fff;border:1px solid #d8dee4;border-radius:8px;padding:16px;margin:12px 0}.form-stack{display:grid;gap:12px;max-width:560px}.plan-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.plan-form .wide{grid-column:1/-1}.plan-form label,.form-stack label,.inline-form label{display:grid;gap:5px;font-size:14px}.plan-form .checkbox{display:flex;align-items:center;gap:8px;padding-top:24px}.plan-form .checkbox input{width:auto}input,select,textarea,button{font:inherit}input,select,textarea{min-width:0;padding:8px;border:1px solid #b8c0cc;border-radius:4px;background:#fff}textarea{min-height:118px;resize:vertical}button,.button-link{padding:8px 12px;border:1px solid #0969da;border-radius:4px;background:#0969da;color:#fff;cursor:pointer;text-decoration:none;display:inline-block}.button-link{line-height:20px}.inline-form{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin-top:12px}.inline-form input{width:120px}.scan-error{white-space:pre-wrap;background:#fff1f0;padding:10px;max-height:180px;overflow:auto}.profile-summary{display:grid;gap:3px}.validation{border-left:4px solid #bf8700}.validation-error{border-left-color:#b42318}.validation strong{display:block}.validation ul,.profile-diff ul{margin:7px 0 0;padding-left:20px}.profile-diff{border-top:1px solid #d8dee4;padding-top:8px}.diagnostics{width:100%;border-collapse:collapse;font-size:12px}.diagnostics th,.diagnostics td{border-bottom:1px solid #d8dee4;padding:7px;text-align:left;vertical-align:top;word-break:break-word}@media(max-width:760px){main{padding:16px}.plan-form{grid-template-columns:1fr}.plan-form .wide{grid-column:auto}.plan-form .checkbox{padding-top:0}.inline-form{display:grid;grid-template-columns:1fr}.diagnostics{display:block;overflow-x:auto}}
</style>${body}</html>`;
}

function keywordLines(keywords = []) {
  return keywords.map((item) => `${item.word || item} | ${item.priority || "B"} | ${item.reason || "用户确认的搜索关键词"}`).join("\n");
}

function scanLabel(run) {
  return { idle: "尚未运行", running: "扫描中", completed: "本次扫描已完成", failed: "扫描未完成，请查看错误" }[run.state] || "尚未运行";
}

function navLinks(current = "") {
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
  const { jobs, filters, summary, latestBatchId, title = "投递操作台", hint = "默认看最新批次" } = data;
  const rows = jobs.map((job) => renderJob(job, filters)).join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:Segoe UI,Microsoft YaHei,sans-serif;margin:0;background:#f6f7f9;color:#1f2328}
main{max-width:1160px;margin:0 auto;padding:24px}
h1{font-size:24px;margin:0 0 8px}.hint{color:#57606a;margin:0 0 14px}
.panel,.job{background:#fff;border:1px solid #d8dee4;border-radius:8px;padding:14px;margin:12px 0}
.summary{display:flex;flex-wrap:wrap;gap:8px}.metric,.chip{display:inline-block;border-radius:999px;padding:3px 8px;font-size:12px;background:#eef2ff;border:1px solid #c7d2fe}
.filters{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr)) auto;gap:8px;align-items:end}.filters input,.filters select{padding:7px 8px}
.job{padding:16px}.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.meta,.line{color:#57606a;margin:7px 0}.status{font-weight:600}
.risk{background:#ffebe9;border-color:#ffcecb}.tag{background:#f6f8fa;border-color:#d8dee4}.actions{display:grid;grid-template-columns:minmax(150px,1fr) minmax(120px,.7fr) 130px repeat(5,auto);gap:8px;align-items:end;margin-top:10px}
.follow{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end;margin-top:8px}
.outcome{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:8px;padding-top:8px;border-top:1px solid #d8dee4}.outcome button{background:#fff;color:#24292f;border:1px solid #8c959f}
input,select{min-width:0;padding:7px 8px}button{padding:7px 10px;cursor:pointer}textarea{width:100%;min-height:52px;box-sizing:border-box;margin-top:8px}a{color:#0969da}.evidence{background:#f6f8fa;border-left:3px solid #0969da;padding:8px 10px;margin-top:8px;font-size:13px}.evidence strong{display:block;color:#24292f}.evidence ul{margin:4px 0;padding-left:18px}
@media(max-width:760px){.filters,.actions,.follow{grid-template-columns:1fr}.top{display:block}}
</style>
<main>
<nav><a href="/onboarding">简历</a>${filters.planId ? `<a href="/plan?planId=${escapeAttr(filters.planId)}">筛选方案</a><a href="/queue?planId=${escapeAttr(filters.planId)}">今日队列</a>` : ""}<a href="/diagnostics">诊断</a></nav>
<h1>${escapeHtml(title)}</h1>
<p class="hint">${escapeHtml(hint)}${latestBatchId ? ` #${latestBatchId}` : ""}；只记录本地 SQLite 状态，不会自动投递或发送消息。</p>
${renderSummary(summary)}
${renderOutcomeMetrics(summary)}
${renderFilters(filters)}
${rows || "<p class=\"panel\">暂无符合条件的岗位。调整过滤条件或先运行 scan。</p>"}
</main>
<script>
async function copyGreeting(id){
  const el=document.getElementById(id);
  if(!el) return;
  await navigator.clipboard.writeText(el.value);
}
</script>
</html>`;
}

function renderQueuePage({ db, searchParams }) {
  const requestedPlanId = Number(searchParams.get("planId") || 0);
  const fallbackProfile = listCandidateProfiles(db)[0];
  const fallbackPlan = fallbackProfile ? getActiveSearchPlan(db, fallbackProfile.id) : null;
  const plan = getSearchPlan(db, requestedPlanId) || fallbackPlan;
  if (!plan) return renderErrorPage("还没有可用的筛选方案，请先上传简历并确认方案。", "/onboarding");
  return renderCompactQueuePage({ db, plan, searchParams });
  const filters = { status: "all", level: "all", fresh: "all", q: "", planId: plan.id, batch: "latest", batchId: null };
  const jobs = listDecisionQueue(db, { planId: plan.id, limit: 15 });
  const summary = summarizeJobs(jobs, buildBatchSummary(db, { planId: plan.id, batch: "latest" }));
  return renderDashboard({
    jobs,
    filters,
    summary,
    latestBatchId: getLatestBatchId(db, { planId: plan.id }),
    title: "今日决策队列",
    hint: "只保留待处理、需要人工复核和到期复看的岗位；每次只处理这一小组。"
  });
}

function renderCompactQueuePage({ db, plan, searchParams }) {
  const pool = ["focus", "primary", "talk", "backup", "not_recommended"].includes(searchParams.get("pool")) ? searchParams.get("pool") : "focus";
  const candidates = listDecisionPool(db, { planId: plan.id }).filter(compactAwaitingAction);
  const counts = Object.fromEntries(["primary", "talk", "backup", "not_recommended"].map((key) => [key, candidates.filter((job) => job.decisionBucket === key).length]));
  const wanted = pool === "focus" ? new Set(["primary", "talk"]) : new Set([pool]);
  const jobs = candidates.filter((job) => wanted.has(job.decisionBucket)).slice(0, 30);
  return renderCompactDashboard({
    jobs,
    filters: { status: "all", level: "all", fresh: "all", decision: "all", q: "", planId: plan.id, batch: "latest", batchId: null, queuePool: pool },
    latestBatchId: getLatestBatchId(db, { planId: plan.id }),
    title: "今日决策队列",
    hint: "主投和先聊确认默认显示；备选与不建议岗位保留在单独分组。",
    queue: { pool, counts }
  });
}

function compactAwaitingAction(job) {
  const status = job.applicationStatus || "pending";
  return status === "pending" || status === "review" || (status === "later" && (!job.reviewAt || job.reviewAt <= new Date().toISOString()));
}

function renderCompactDashboard(data) {
  const { jobs = [], filters = {}, latestBatchId, queue = null, title = "投递操作台", hint = "" } = data;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
body{margin:0;background:#f5f7f8;color:#1f2933;font-family:Segoe UI,Microsoft YaHei,sans-serif}main{max-width:1100px;margin:0 auto;padding:22px 18px 48px}nav{display:flex;gap:14px;margin-bottom:20px}a{color:#1265a8;text-decoration:none}a:hover{text-decoration:underline}h1{font-size:24px;margin:0 0 7px}.hint{color:#5b6773;margin:0 0 16px}.panel{background:#fff;border:1px solid #d8e0e6;border-radius:8px;padding:12px 14px;margin:12px 0}.pool-tabs{display:flex;flex-wrap:wrap;gap:8px}.pool-tab{padding:7px 10px;border:1px solid #ccd7df;border-radius:6px;background:#fff;color:#344450}.pool-tab.active{background:#e6f3f0;border-color:#68aa9b;color:#155f54;font-weight:700;text-decoration:none}.filters{display:grid;grid-template-columns:repeat(6,minmax(110px,1fr)) auto;gap:8px}.filters input,.filters select,input,select{box-sizing:border-box;min-width:0;padding:8px;border:1px solid #b9c5ce;border-radius:5px;background:#fff}.job{background:#fff;border:1px solid #d7e0e6;border-radius:8px;padding:14px 16px;margin:10px 0}.job-top{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.job-title{font-size:16px;font-weight:700;line-height:1.35}.job-meta,.job-reason,.job-risk,.line{margin-top:7px;font-size:14px;line-height:1.45;color:#53616d}.job-reason{color:#27604f}.job-risk{color:#9a4b42}.decision{display:inline-block;white-space:nowrap;border:1px solid #d8e0e6;border-radius:999px;padding:4px 8px;font-size:12px;font-weight:700}.primary{background:#e6f3f0;border-color:#86b9ad;color:#155f54}.talk{background:#eef4fa;border-color:#9cbcdc;color:#245b87}.backup{background:#fff6df;border-color:#ead29a;color:#825b13}.not_recommended{background:#f9e9e7;border-color:#e5b3ae;color:#9b3f37}.quick-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}button{padding:7px 10px;cursor:pointer;border:1px solid #aab8c2;border-radius:5px;background:#fff;color:#25313a}.apply{background:#176b5b;border-color:#176b5b;color:#fff}.skip{color:#8a3a33}.details{margin-top:11px;border-top:1px solid #e4e9ed;padding-top:9px}.details summary{cursor:pointer;color:#4f6170;font-size:13px}.detail-body{margin-top:10px}.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.chip{border:1px solid #d8dee4;border-radius:999px;padding:3px 7px;font-size:12px;background:#f6f8fa}.risk{background:#f9e9e7;border-color:#e5b3ae}.jd{white-space:pre-wrap;background:#f7f9fa;border-left:3px solid #2a7185;padding:9px 10px;font-size:13px;line-height:1.55}.detail-actions,.follow{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:10px}.detail-actions input,.follow input{flex:1 1 220px}textarea{box-sizing:border-box;width:100%;min-height:52px;margin-top:8px;padding:8px;border:1px solid #b9c5ce;border-radius:5px;background:#fafcfd}@media(max-width:760px){.filters{grid-template-columns:1fr 1fr}.job-top{display:block}.decision{margin-top:7px}}</style><main>
<nav><a href="/onboarding">简历</a>${filters.planId ? `<a href="/plan?planId=${escapeAttr(filters.planId)}">筛选方案</a><a href="/queue?planId=${escapeAttr(filters.planId)}">今日队列</a>` : ""}<a href="/settings">模型设置</a><a href="/diagnostics">诊断</a></nav><h1>${escapeHtml(title)}</h1><p class="hint">${escapeHtml(hint)}${latestBatchId ? ` 批次 #${latestBatchId}` : ""}</p>
${queue ? renderCompactPoolTabs(queue, filters.planId) : renderCompactFilters(filters)}
${jobs.map((job) => renderCompactJob(job, filters)).join("") || "<section class=\"panel\">这个分组目前没有岗位。</section>"}</main><script>async function copyGreeting(id){const el=document.getElementById(id);if(el)await navigator.clipboard.writeText(el.value);}</script></html>`;
}

function renderCompactPoolTabs(queue, planId) {
  const tabs = [["focus", "主投 + 先聊", (queue.counts.primary || 0) + (queue.counts.talk || 0)], ["primary", "主投", queue.counts.primary || 0], ["talk", "先聊确认", queue.counts.talk || 0], ["backup", "备选", queue.counts.backup || 0], ["not_recommended", "不建议", queue.counts.not_recommended || 0]];
  return `<section class="panel"><div class="pool-tabs">${tabs.map(([key, label, count]) => `<a class="pool-tab ${queue.pool === key ? "active" : ""}" href="/queue?planId=${escapeAttr(planId)}&pool=${escapeAttr(key)}">${escapeHtml(label)} ${count}</a>`).join("")}</div></section>`;
}

function renderCompactFilters(filters) {
  return `<form class="panel filters" method="get" action="/jobs"><input type="hidden" name="planId" value="${escapeAttr(filters.planId || "")}">${select("status", filters.status, [["pending", "未处理"], ["review", "待确认"], ["later", "保留"], ["applied", "已投"], ["skipped", "跳过"], ["all", "全部"]])}${select("decision", filters.decision, [["all", "全部投递池"], ["primary", "主投"], ["talk", "先聊确认"], ["backup", "备选"], ["not_recommended", "不建议"]])}${select("level", filters.level, [["all", "全部级别"], ["优先", "优先"], ["可投", "可投"], ["可冲", "可冲"], ["谨慎", "谨慎"], ["不建议", "不建议"]])}${select("fresh", filters.fresh, [["all", "新增+重复"], ["new", "本批新增"], ["repeated", "重复出现"]])}${select("batch", filters.batchId ? String(filters.batchId) : filters.batch, [["latest", "最新批次"], ["all", "全部历史"]])}<input name="q" value="${escapeAttr(filters.q || "")}" placeholder="搜索标题/公司/地点"><button>过滤</button></form>`;
}

function renderCompactJob(job, filters) {
  const analysis = job.analysis || {};
  const greetingId = `greeting-${job.id}`;
  const query = compactQuery(filters);
  const context = `${job.profileId ? `<input type="hidden" name="profileId" value="${escapeAttr(job.profileId)}">` : ""}${job.searchPlanId ? `<input type="hidden" name="planId" value="${escapeAttr(job.searchPlanId)}">` : ""}`;
  const fitReason = (analysis.fitReasons || []).slice(0, 2).join("；") || "岗位方向与当前简历的匹配信息待补充。";
  const risk = (job.risks || []).slice(0, 2).join("；") || "暂无明显硬风险；工作制与团队情况可在沟通时确认。";
  const status = job.applicationStatus ? ` · ${statusLabel(job)}` : "";
  return `<article class="job"><div class="job-top"><div><div class="job-title">${escapeHtml(job.title)}${job.url ? ` · <a href="${escapeAttr(job.url)}" target="_blank">打开岗位</a>` : ""}</div><div class="job-meta">${escapeHtml(job.company || "")} · ${escapeHtml(job.location || "")} · ${escapeHtml(job.salary || "薪资未说明")} · ${escapeHtml(job.experience || "经验未说明")} · ${escapeHtml(job.bossActiveText || "活跃度待确认")}${escapeHtml(status)}</div></div><span class="decision ${escapeAttr(job.decisionBucket || "backup")}">${escapeHtml(compactDecisionLabel(job.decisionBucket))}</span></div><div class="job-reason">${escapeHtml(fitReason)}</div><div class="job-risk">${escapeHtml(risk)}</div><form class="quick-actions" method="post" action="/api/mark${query}"><input type="hidden" name="jobId" value="${escapeAttr(job.id)}">${context}<button class="apply" name="status" value="applied">已投</button><button name="status" value="review">待确认</button><button name="status" value="later">保留</button><button class="skip" name="status" value="skipped">跳过</button></form><details class="details"><summary>查看 JD、招呼语与完整记录</summary><div class="detail-body"><div class="line">工作节奏：${escapeHtml(compactScheduleLabel(analysis))} · 推荐简历：${escapeHtml(analysis.recommendedResumeVersionName || analysis.recommendedResumeVersion || "待确认")} · 主推项目：${escapeHtml((analysis.primaryProjects || []).join("、") || "待确认")}</div><div class="chips">${chips(job.risks, "risk")}${chips(job.qualityTags, "tag")}</div><div class="jd">${escapeHtml(String(job.description || "暂无完整 JD").slice(0, 1500))}</div><textarea id="${escapeAttr(greetingId)}" readonly>${escapeHtml(analysis.greeting || job.greeting || "")}</textarea><button type="button" onclick="copyGreeting('${escapeAttr(greetingId)}')">复制招呼语</button><form class="detail-actions" method="post" action="/api/mark${query}"><input type="hidden" name="jobId" value="${escapeAttr(job.id)}">${context}<input name="note" placeholder="备注（可选）"><select name="reasonCode"><option value="">跳过原因</option><option value="direction_mismatch">方向不匹配</option><option value="salary">薪资不合适</option><option value="location">地点不合适</option><option value="outsource">外包/驻场风险</option><option value="inactive">招聘方不活跃</option><option value="experience">经验门槛偏高</option><option value="other">其他</option></select><button name="status" value="no_reply">无回复待跟进</button><button name="status" value="interview">约面</button><button name="status" value="rejected">拒绝</button><button name="status" value="invalid">岗位无效</button><button name="status" value="salary_mismatch">薪资不匹配</button></form><form class="follow" method="post" action="/api/follow-up${query}"><input type="hidden" name="jobId" value="${escapeAttr(job.id)}">${context}<input name="note" placeholder="HR 回复 / 跟进备注"><button>记录跟进</button></form></div></details></article>`;
}

function compactDecisionLabel(bucket) {
  return { primary: "主投", talk: "先聊确认", backup: "备选", not_recommended: "不建议" }[bucket] || "备选";
}

function compactScheduleLabel(analysis = {}) {
  return { double_weekend: "双休", alternating_weekend: "大小周/单双休", single_weekend: "单休", unknown: "未说明" }[analysis.workSchedule || "unknown"];
}

function compactQuery(filters) {
  const params = new URLSearchParams();
  if (filters.planId) params.set("planId", String(filters.planId));
  if (filters.queuePool) params.set("pool", filters.queuePool);
  return params.size ? `?${params.toString()}` : "";
}

function renderSummary(summary) {
  const f = summary.filtered || {};
  return `<section class="panel">
  <div class="summary">
    <span class="metric">当前显示 ${f.total || 0}</span>
    <span class="metric">未处理 ${f.pending || 0}</span>
    <span class="metric">已投 ${f.applied || 0}</span>
    <span class="metric">跳过 ${f.skipped || 0}</span>
    <span class="metric">无回复 ${f.no_reply || 0}</span>
    <span class="metric">人工复核 ${f.review || 0}</span>
    <span class="metric">稍后处理 ${f.later || 0}</span>
    <span class="metric">本批新增 ${summary.newJobs || 0}</span>
    <span class="metric">重复出现 ${summary.repeated || 0}</span>
    <span class="metric">非广州 ${summary.nonGuangzhou || 0}</span>
    <span class="metric">非3日内/未知活跃 ${summary.inactiveOrUnknown || 0}</span>
  </div>
</section>`;
}

function renderOutcomeMetrics(summary = {}) {
  const f = summary.filtered || {};
  return `<section class="panel"><div class="summary">
    <span class="metric">约面 ${f.interview || 0}</span>
    <span class="metric">拒绝 ${f.rejected || 0}</span>
    <span class="metric">岗位无效 ${f.invalid || 0}</span>
    <span class="metric">薪资不匹配 ${f.salary_mismatch || 0}</span>
    <span class="metric">疑似重复 ${summary.weakDuplicates || 0}</span>
    <span class="metric">待复核下架 ${summary.needsRecheck || 0}</span>
    <span class="metric">详情变更 ${summary.detailChanged || 0}</span>
  </div></section>`;
}

function renderFilters(filters) {
  return `<form class="panel filters" method="get" action="/jobs">
  ${filters.planId ? `<input type="hidden" name="planId" value="${escapeAttr(filters.planId)}">` : ""}
  ${select("outcome", ["interview", "rejected", "invalid", "salary_mismatch"].includes(filters.status) ? filters.status : "", [["", "结果状态"], ["interview", "已约面"], ["rejected", "已拒绝"], ["invalid", "岗位无效"], ["salary_mismatch", "薪资不匹配"]])}
  ${select("status", filters.status, [["pending", "未处理"], ["review", "人工复核"], ["later", "稍后处理"], ["applied", "已投"], ["skipped", "跳过"], ["no_reply", "无回复"], ["all", "全部"]])}
  ${select("level", filters.level, [["all", "全部级别"], ["优先", "优先"], ["可投", "可投"], ["可冲", "可冲"], ["谨慎", "谨慎"]])}
  ${select("fresh", filters.fresh, [["all", "新增+重复"], ["new", "本批新增"], ["repeated", "重复出现"]])}
  ${select("batch", filters.batchId ? String(filters.batchId) : filters.batch, [["latest", "最新批次"], ["all", "全部历史"]])}
  <input name="q" value="${escapeAttr(filters.q)}" placeholder="搜索标题/公司/地点">
  <button>过滤</button>
</form>`;
}

function select(name, value, options) {
  return `<select name="${escapeAttr(name)}">${options.map(([v, label]) => `<option value="${escapeAttr(v)}"${String(value) === String(v) ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select>`;
}

function renderJob(job, filters) {
  const analysis = job.analysis || {};
  const workSchedule = renderWorkSchedule(analysis);
  const greetingId = `greeting-${job.id}`;
  const query = currentQuery(filters);
  const context = `${job.profileId ? `<input type="hidden" name="profileId" value="${escapeAttr(job.profileId)}">` : ""}${job.searchPlanId ? `<input type="hidden" name="planId" value="${escapeAttr(job.searchPlanId)}">` : ""}`;
  return `<article class="job">
  <div class="top">
    <strong>${escapeHtml(job.score)} · ${escapeHtml(job.level)} · ${job.url ? `<a href="${escapeAttr(job.url)}" target="_blank">打开岗位</a> · ` : ""}${escapeHtml(job.title)}</strong>
    <span class="status">${escapeHtml(statusLabel(job))}</span>
  </div>
  <div class="meta">${escapeHtml(job.company || "")} · ${escapeHtml(job.location || "")} · ${escapeHtml(job.salary || "")} · ${escapeHtml(job.experience || "")} · ${escapeHtml(job.bossActiveText || "")}</div>
  <div class="line">出现：${escapeHtml(seenLabel(job))} · 本次建议：${escapeHtml(analysis.recommendation || "caution")} / ${escapeHtml(analysis.fitLevel || "待确认")}</div>
  <div class="line">推荐简历：${escapeHtml(analysis.recommendedResumeVersionName || analysis.recommendedResumeVersion || "待确认")} · 主推项目：${escapeHtml((analysis.primaryProjects || []).join("、") || "待确认")}</div>
  <div class="line">反馈提示：${escapeHtml(feedbackLabel(job))}</div>
  ${workSchedule}
  <div>${chips(job.risks, "risk")}${chips(job.qualityTags, "tag")}</div>
  ${renderQualityGovernance(job)}
  <div class="line">风险追问：${escapeHtml((analysis.riskQuestions || []).join("；") || (job.risks || []).join("；") || "暂无")}</div>
  ${renderEvidence(analysis.evidence)}
  ${job.followUpNote ? `<div class="line"><strong>HR回复/跟进：</strong>${escapeHtml(job.followUpNote)}</div>` : ""}
  <textarea id="${escapeAttr(greetingId)}" readonly>${escapeHtml(analysis.greeting || job.greeting || "")}</textarea>
  <button type="button" onclick="copyGreeting('${escapeAttr(greetingId)}')">复制招呼语</button>
  <form class="actions" method="post" action="/api/mark${query}">
    <input type="hidden" name="jobId" value="${escapeAttr(job.id)}">
    ${context}
    <input name="note" placeholder="备注，可选" value="">
    <select name="reasonCode"><option value="">跳过原因（可选）</option><option value="direction_mismatch">方向不匹配</option><option value="salary">薪资不合适</option><option value="location">地点不合适</option><option value="outsource">外包/驻场风险</option><option value="inactive">招聘方不活跃</option><option value="experience">经验门槛偏高</option><option value="other">其他</option></select>
    <input type="date" name="reviewAt" title="稍后处理日期">
    <button name="status" value="applied">已投</button>
    <button name="status" value="skipped">跳过</button>
    <button name="status" value="review">人工复核</button>
    <button name="status" value="later">稍后处理</button>
    <button name="status" value="no_reply">无回复/待跟进</button>
  </form>
  <form class="outcome" method="post" action="/api/mark${query}">
    <input type="hidden" name="jobId" value="${escapeAttr(job.id)}">${context}
    <input name="note" placeholder="结果备注（可选）">
    <button name="status" value="interview">约面</button>
    <button name="status" value="rejected">拒绝</button>
    <button name="status" value="invalid">岗位无效</button>
    <button name="status" value="salary_mismatch">薪资不匹配</button>
  </form>
  <form class="follow" method="post" action="/api/follow-up${query}">
    <input type="hidden" name="jobId" value="${escapeAttr(job.id)}">
    ${context}
    <input name="note" placeholder="HR 回复 / 跟进备注">
    <button>记录跟进</button>
  </form>
</article>`;
}

function renderQualityGovernance(job) {
  const details = [];
  if (job.weakDuplicateCount > 1) details.push(`同组候选 ${job.weakDuplicateCount} 条，已弱去重降权`);
  if (job.detailChanged) details.push("相对上次记录，薪资、描述或匹配分析已有变化");
  if (Number.isFinite(job.daysSinceLastSeen) && job.daysSinceLastSeen >= 14) details.push(`已 ${job.daysSinceLastSeen} 天未再次扫描到，需确认是否下架`);
  return details.length ? `<div class="line"><strong>质量治理：</strong>${escapeHtml(details.join("；"))}</div>` : "";
}

function renderEvidence(evidence = {}) {
  const jd = Array.isArray(evidence.jd) ? evidence.jd : [];
  const resume = Array.isArray(evidence.resume) ? evidence.resume : [];
  if (!jd.length && !resume.length) return "";
  const section = (label, values) => values.length ? `<strong>${escapeHtml(label)}</strong><ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>` : "";
  return `<div class="evidence">${section("JD 依据", jd)}${section("简历依据", resume)}</div>`;
}

function currentQuery(filters) {
  const params = new URLSearchParams();
  for (const key of ["status", "level", "fresh", "q", "planId"]) if (filters[key]) params.set(key, filters[key]);
  if (filters.batchId) params.set("batch", String(filters.batchId));
  else if (filters.batch) params.set("batch", filters.batch);
  const text = params.toString();
  return text ? `?${text}` : "";
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

function renderWorkSchedule(analysis = {}) {
  const label = {
    double_weekend: "双休",
    alternating_weekend: "大小周/单双休",
    single_weekend: "单休",
    unknown: "未说明"
  }[analysis.workSchedule || "unknown"];
  const evidence = String(analysis.workScheduleEvidence || "").trim();
  return `<div class="line"><strong>工作节奏：</strong>${escapeHtml(label)}${evidence ? ` · ${escapeHtml(evidence)}` : ""}</div>`;
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
    stale_or_unknown_active: "招聘方活跃状态未知",
    activity_unverified: "招聘方活跃状态待刷新",
    missing_link: "缺少岗位链接",
    invalid_job_link: "岗位链接无效",
    role_mismatch: "岗位明显不属于技术开发或交付",
    internship_role: "实习岗位，不进入当前社招主投池",
    algorithm_role: "纯算法/训练岗位，不进入当前主投池",
    algorithm_hybrid: "算法训练占比待确认",
    hard_exclude: "命中硬排除条件",
    experience_stretch: "经验要求可冲刺",
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

function seenLabel(job) {
  if (!job.firstSeenAt || !job.lastSeenAt) return "未知";
  return job.firstSeenAt === job.lastSeenAt ? "本批新增" : "重复出现";
}

function feedbackLabel(job) {
  const feedback = job.feedback || {};
  if ((feedback.notes || []).length) return feedback.notes.join("；");
  if (feedback.bonus > 0) return "历史反馈略加权";
  if (feedback.penalty > 0) return "历史反馈略降权";
  return "暂无";
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

module.exports = { createDashboardServer, handleMarkApi, handleFollowUpApi, getDashboardData, filterJobs, renderDashboard };
