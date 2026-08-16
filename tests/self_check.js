const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadConfigs } = require("../src/config");
const { scoreJob, decisionState } = require("../src/core/scoring");
const { buildKeywordPlan, resolvePlannedKeywords } = require("../src/core/keyword_planner");
const { explainJobMatch } = require("../src/core/match_explainer");
const { createLlmAnalyzer } = require("../src/core/llm_analyzer");
const { MockModelAdapter } = require("../src/adapters/models/mock");
const { ModelContractError } = require("../src/core/model_contract");
const { createJobAnalysisRunner } = require("../src/core/job_analysis");
const { parseResumeUpload } = require("../src/core/resume_parser");
const { analyzeResumeToPlan } = require("../src/core/profile_onboarding");
const { planKeywords, profileToRuntimeConfigs } = require("../src/core/search_plan");
const { openDb, createBatch, upsertJob, listReportJobs, markApplication, markCandidateJob, addFollowUpNote, buildFeedbackSummary, buildBatchSummary, getLatestBatchId, saveProfileAnalysis, updateCandidateProfile, saveCandidateResumeVersion, listCandidateResumeVersions, recordResumeParseAttempt, listResumeParseAttempts, getCandidateProfile, getSearchPlan, compareProfileVersions, listDecisionQueue, getModelCache, saveModelCache } = require("../src/core/storage");
const { handleMarkApi, handleFollowUpApi, getDashboardData, filterJobs } = require("../src/dashboard/server");
const { parseBossActivityText, normalizeBossUrl, bossSourceId } = require("../src/adapters/sites/boss");
const { CdpBrowserAdapter } = require("../src/adapters/browser/cdp");
const { chooseAutomationTab } = require("../src/adapters/browser/edge_control");
const { mapWithConcurrency } = require("../src/core/async_pool");
require("./four_tier_decision_smoke");

const root = path.resolve(__dirname, "..");
const installer = fs.readFileSync(path.join(root, "scripts", "install.ps1"), "utf8");
const workspaceLauncher = fs.readFileSync(path.join(root, "scripts", "start-workspace.ps1"), "utf8");
const portableEdgeLauncher = fs.readFileSync(path.join(root, "scripts", "start-portable-edge.ps1"), "utf8");
const releasePackager = fs.readFileSync(path.join(root, "scripts", "package-release.ps1"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
assert.strictEqual(workspaceLauncher.charCodeAt(0), 0xFEFF, "start-workspace.ps1 must use a UTF-8 BOM for Windows PowerShell 5.1");
assert(installer.includes("require.resolve('pdfjs-dist/legacy/build/pdf.mjs',"), "installer must resolve the production PDF parser dependency");
assert(!installer.includes("pdf-parse"), "installer must not check the removed pdf-parse dependency");
assert(installer.includes("{ paths: [process.argv[1]] }"), "installer must anchor dependency resolution to its project root");
assert(
  !installer.includes('tests\\run_all.js'),
  "startup dependency checks must not run the full offline suite"
);
assert(workspaceLauncher.includes('BrowserMode = "edge"'));
assert(workspaceLauncher.includes("start-edge-control.ps1"));
assert(workspaceLauncher.includes("start-portable-edge.ps1"));
assert(workspaceLauncher.includes('"workspace-tabs"'));
assert(workspaceLauncher.includes('"--dashboard-url", $url'));
assert(workspaceLauncher.includes('"--cdp-port", [string]$CdpPort'));
assert(!workspaceLauncher.includes("Start-Process $url"));
assert(portableEdgeLauncher.includes("--remote-debugging-address=127.0.0.1"));
assert(portableEdgeLauncher.includes("9222"));
assert(portableEdgeLauncher.includes("https://www.zhipin.com/web/geek/jobs"));
assert(readme.includes("当前已登录 Edge（推荐）"));
assert(readme.includes("Start.bat -BrowserMode portable"));
assert(readme.includes("不会自动回退"));
assert(readme.includes("9222"));
assert(readme.includes(".runtime\\edge-profile"));
assert(readme.includes("默认普通 Edge 模式需要用户已安装并连接健康的 Edge Control 扩展和桥接"));
assert(readme.includes("发布 zip 不内置或自动安装 Edge Control 桥接"));
assert(readme.includes("`Start.bat` 会 fail-closed（停止启动，不自动切换浏览器）"));
assert(readme.includes("无需或不想安装 Edge Control 时，必须显式运行"));
assert(!readme.includes("不依赖 Codex 或浏览器插件"));
assert(!readme.includes("Edge Control 插件模式仅作为兼容入口"));
assert(releasePackager.includes('"LICENSE"'), "release package must include the AGPL license");
assert(releasePackager.includes('"NOTICE"'), "release package must include copyright and third-party notices");
assert(!releasePackager.includes('Copy-Item -LiteralPath (Join-Path $ProjectRoot "docs")'), "release package must not recursively include internal development evidence");
const selfCheckDir = path.join(root, ".runtime", "self-check");
fs.mkdirSync(selfCheckDir, { recursive: true });
const help = spawnSync(process.execPath, [path.join(root, "src", "cli.js"), "--help"], { encoding: "utf8" });
assert.strictEqual(help.status, 0);
for (const script of ["scripts/scan-portable.ps1", "scripts/scan-boss.ps1"]) {
  const source = fs.readFileSync(path.join(root, script), "utf8");
  assert(source.includes('"--plan"'));
  assert(!source.includes('"--keywords"'));
  assert(!/\[int\]\$MaxCards\s*=/.test(source));
  assert(!/\[int\]\$MaxDetailTotal\s*=/.test(source));
}
const portableLauncher = fs.readFileSync(path.join(root, "ScanPortable.bat"), "utf8");
assert(!portableLauncher.includes("DetailLimit"));
assert(!portableLauncher.includes("MaxCards"));
const normalizePowerShellParameterDiagnostic = (output) => String(output).replace(/\s+/g, "");
const wrappedPowerShellDiagnostic = "Cannot bind parameter 'MaxDetail\r\n    Total' because the value is invalid.";
assert.strictEqual(wrappedPowerShellDiagnostic.includes("MaxDetailTotal"), false);
assert(
  normalizePowerShellParameterDiagnostic(wrappedPowerShellDiagnostic).includes("MaxDetailTotal"),
  "the synthetic wrapped diagnostic must still identify MaxDetailTotal"
);
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
for (const script of ["scripts/scan-portable.ps1", "scripts/scan-boss.ps1"]) {
  for (const [parameter, value] of [["MaxCards", "9"], ["MaxDetailTotal", "0"]]) {
    const invalid = spawnSync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, script),
      "-PlanId", "1", `-${parameter}`, value
    ], { encoding: "utf8", windowsHide: true });
    assert.notStrictEqual(invalid.status, 0, `${script} must reject invalid ${parameter}`);
    assert(
      normalizePowerShellParameterDiagnostic(invalid.stdout + invalid.stderr).includes(parameter),
      `${script} must identify invalid ${parameter}`
    );
  }
  const dailyOverride = spawnSync(powershell, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, script),
    "-PlanId", "1", "-ScanMode", "daily", "-MaxCards", "50"
  ], { encoding: "utf8", windowsHide: true });
  assert.notStrictEqual(dailyOverride.status, 0, `${script} must reject daily budget overrides`);
  assert((dailyOverride.stdout + dailyOverride.stderr).includes("only supported in broad mode"));
}
const defaultConfigs = loadConfigs(root);
assert.strictEqual(defaultConfigs.candidateProfile, null);
assert.deepStrictEqual(defaultConfigs.resumeVersions, { versions: [] });
assert.deepStrictEqual(defaultConfigs.keywords, { keywords: [] });
assert.deepStrictEqual(resolvePlannedKeywords({}, defaultConfigs).keywords, []);
const configs = loadConfigs(root, { profile: "profiles/example_profile.json", resumeVersions: "profiles/example_resume_versions.json" });
assert.strictEqual(configs.candidateProfile.candidate.name, "示例候选人");
const sample = JSON.parse(fs.readFileSync(path.join(root, "data", "sample_jobs.json"), "utf8"));
assert.strictEqual(typeof new CdpBrowserAdapter({ port: 9222 }).listTabs, "function");
assert.strictEqual(chooseAutomationTab([
  { id: 1, url: "https://example.com", active: true },
  { id: 2, url: "https://www.zhipin.com/web/geek/jobs?query=RAG", active: false }
]).id, 2);
assert.strictEqual(configs.candidateProfile.candidate.name, "示例候选人");
assert((configs.resumeVersions.versions || []).some((version) => version.id === "ai_rag_agent"));

const keywordPlan = buildKeywordPlan(configs.candidateProfile, configs.resumeVersions, configs.keywords);
assert(keywordPlan.some((item) => item.word === "RAG" && item.resumeVersion === "ai_rag_agent"));
assert(keywordPlan.every((item) => item.priority && item.reason && Array.isArray(item.avoidTerms)));
assert(resolvePlannedKeywords({ keywords: "手动词" }, configs).keywords.includes("手动词"));

const runtimeConfigs = profileToRuntimeConfigs(configs, configs.candidateProfile, {
  cities: ["广州"],
  salary: { minK: 9, maxK: 18 },
  experience: ["经验不限", "0-3年", "1-3年", "3-5年（可冲）"],
  jobTypes: ["全职"],
  directions: configs.candidateProfile.candidate.directions,
  keywords: keywordPlan
});

const good = scoreJob(sample[0], runtimeConfigs);
assert(good.score > 0);
const explained = explainJobMatch({ ...sample[0], ...good }, runtimeConfigs, keywordPlan);
assert.strictEqual(explained.provider, "rule-mock");
assert(explained.llmReady);
assert(explained.recommendedResumeVersion);
assert(good.canStretch, "3-5年 + 18K以内 + AI应用，应标记可冲");

const risky = scoreJob(sample[1], runtimeConfigs);
assert(risky.score < good.score);
assert(risky.risks.length > 0);
assert.strictEqual(parseBossActivityText("HR 今日活跃，欢迎沟通"), "今日活跃");
assert.strictEqual(normalizeBossUrl("https://www.zhipin.com/job_detail/abc123.html?ka=search_list"), "https://www.zhipin.com/job_detail/abc123.html");
assert.strictEqual(bossSourceId({ url: "https://www.zhipin.com/job_detail/abc123.html?x=1" }), "boss:abc123");

const trainer = scoreJob({
  ...sample[0],
  title: "AI Agent 课程讲师",
  description: `${sample[0].description} 负责课程设计和培训交付。`
}, runtimeConfigs);
assert(!trainer.qualityTags.includes("role_mismatch"), "培训类标题不再由本地规则默认拦截，交由语义证据契约判断");
assert.strictEqual(decisionState(trainer), "ready");

const selfCheckDbPath = path.join(selfCheckDir, `self-check-${Date.now()}.sqlite`);
const db = openDb(selfCheckDbPath);
const batchId = createBatch(db, "boss", "self-check");
const greeting = "您好，我想进一步了解该岗位的职责和团队情况。";
upsertJob(db, { ...sample[0], ...good, greeting }, batchId);
assert.strictEqual(listReportJobs(db).length, 1);

checkMockAnalyzer()
  .then(() => {
    closeSelfCheckDb();
    console.log("self_check ok");
  })
  .catch((error) => {
    closeSelfCheckDb();
    console.error(error.stack || error.message);
    process.exit(1);
  });

async function checkMockAnalyzer() {
  let inFlight = 0;
  let peakConcurrency = 0;
  const pooled = await mapWithConcurrency([1, 2, 3, 4, 5], 3, async (value) => {
    inFlight += 1;
    peakConcurrency = Math.max(peakConcurrency, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return value * 2;
  });
  assert.deepStrictEqual(pooled, [2, 4, 6, 8, 10]);
  assert.strictEqual(peakConcurrency, 3);

  assert.strictEqual(configs.model.provider, "mock");
  const mockAdapter = new MockModelAdapter();
  const analyzer = createLlmAnalyzer({ modelConfig: configs.model });
  const candidateProfile = await analyzer.analyzeResume({
    resumeText: "",
    profileHints: configs.candidateProfile
  });
  assert.strictEqual(candidateProfile.candidate.name, configs.candidateProfile.candidate.name);
  assert(Array.isArray(candidateProfile.skills));

  const rawJobUnderstanding = await mockAdapter.understandJob({
    job: sample[0],
    candidateProfile
  });
  assert.deepStrictEqual(
    Object.keys(rawJobUnderstanding).sort(),
    ["eligibility", "hiringTracks", "industryContext", "requirements", "riskSignals"]
  );
  assert.deepStrictEqual(rawJobUnderstanding.hiringTracks.map((track) => track.id), ["T1"]);
  assert(Array.isArray(rawJobUnderstanding.requirements));
  assert(Array.isArray(rawJobUnderstanding.riskSignals));
  const jobUnderstanding = await analyzer.understandJob({
    job: sample[0],
    candidateProfile
  });

  const matchDecision = await analyzer.matchJob({
    candidateProfile: configs.candidateProfile,
    resumeVersions: configs.resumeVersions,
    jobUnderstanding
  });
  assert.strictEqual(matchDecision.selectedTrackId, "T1");
  assert(["apply", "caution", "review", "skip"].includes(matchDecision.recommendation));
  assert(matchDecision.recommendedResumeVersion);
  assert(Array.isArray(matchDecision.primaryProjects));

  const communication = await analyzer.draftCommunication({
    mode: "greeting",
    candidateProfile: configs.candidateProfile,
    jobUnderstanding,
    matchDecision
  });
  assert.strictEqual(communication.kind, "greeting");
  assert.strictEqual(communication.messages.length, 1);
  assert.strictEqual(communication.missingFact, null);
  assert(communication.evidence.jd.length);
  assert(communication.evidence.resume.length);

  const resume = await parseResumeUpload({
    fileName: "sample_resume.txt",
    buffer: fs.readFileSync(path.join(root, "data", "sample_resume.txt")),
    root
  });
  const onboarding = await analyzeResumeToPlan({ modelConfig: configs.model, resume });
  assert.strictEqual(onboarding.profile.candidate.city, "广州");
  assert(onboarding.profile.skills.some((skill) => skill.name === "Python"));
  assert.strictEqual(onboarding.profile.source.inputTrust, "user_provided");
  assert.strictEqual(onboarding.profile.source.inputMethod, "text_utf8");
  assert(planKeywords(onboarding.plan).length > 0);
  const savedProfile = saveProfileAnalysis(db, { profile: onboarding.profile, document: resume, searchPlan: onboarding.plan });
  const savedCandidateName = getCandidateProfile(db, savedProfile.profileId).profile.candidate.name;
  assert(savedCandidateName);
  assert(!savedCandidateName.includes("测试候选人"), "post-onboarding profile surfaces must not restore the original identity");
  assert.strictEqual(getSearchPlan(db, savedProfile.planId).profileId, savedProfile.profileId);
  assert(listCandidateResumeVersions(db, savedProfile.profileId).length >= 1);
  const initialVersions = listCandidateResumeVersions(db, savedProfile.profileId);
  const persistedConfigs = profileToRuntimeConfigs(configs, onboarding.profile, onboarding.plan, initialVersions);
  assert.strictEqual(persistedConfigs.resumeVersions.versions[0].id, initialVersions[0].versionKey);
  const savedVersion = saveCandidateResumeVersion(db, {
    profileId: savedProfile.profileId,
    document: { ...resume, originalFileName: "resume-variant.txt", contentHash: `${resume.contentHash}-variant` },
    version: { name: "Variant", targetRoles: ["AI Engineer"], keywords: ["Python", "RAG"], primaryProjects: ["KnowledgeFlow"], summary: "variant", isActive: true }
  });
  assert(savedVersion.versionId);
  assert(listCandidateResumeVersions(db, savedProfile.profileId).some((version) => version.name === "Variant"));
  recordResumeParseAttempt(db, { profileId: savedProfile.profileId, document: resume });
  assert(listResumeParseAttempts(db, savedProfile.profileId).some((attempt) => attempt.status === "succeeded" && attempt.charCount === resume.charCount));
  const manuallyUpdatedProfile = JSON.parse(JSON.stringify(onboarding.profile));
  manuallyUpdatedProfile.candidate.city = "Shenzhen";
  updateCandidateProfile(db, { profileId: savedProfile.profileId, profile: manuallyUpdatedProfile });
  assert.strictEqual(getCandidateProfile(db, savedProfile.profileId).profile.candidate.city, "Shenzhen");

  const docxPath = path.join(selfCheckDir, `resume-parser-${Date.now()}.docx`);
  const docxFixture = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "tests", "make_docx_fixture.ps1"), "-Path", docxPath], { encoding: "utf8", windowsHide: true });
  assert.strictEqual(docxFixture.status, 0, docxFixture.stderr || docxFixture.stdout);
  try {
    const docx = await parseResumeUpload({ fileName: "fixture.docx", buffer: fs.readFileSync(docxPath), root });
    assert.strictEqual(docx.format, "docx");
    assert(docx.text.includes("Test Candidate"));
  } finally {
    fs.rmSync(docxPath, { force: true });
  }

  const pdf = await parseResumeUpload({
    fileName: "fixture.pdf",
    buffer: makePdfFixture("Test Candidate Python FastAPI RAG Agent project experience for PDF resume parser verification."),
    root
  });
  assert.strictEqual(pdf.format, "pdf");
  assert(pdf.text.includes("Test Candidate"));
  await assert.rejects(
    () => parseResumeUpload({ fileName: "scanned-like.pdf", buffer: makePdfFixture("short"), root }),
    (error) => error.code === "RESUME_TEXT_TOO_SHORT" && error.details?.diagnostics?.ocr?.status === "suggested"
  );

  const analyzeJob = createJobAnalysisRunner(configs, keywordPlan);
  const analysis = await analyzeJob({ ...sample[0], ...good, greeting });
  assert(analysis.recommendedResumeVersion);
  assert(analysis.recommendedResumeVersionName);
  assert(analysis.greeting);
  const riskyAnalysis = await analyzeJob({ ...sample[1], ...risky, greeting });
  assert.strictEqual(riskyAnalysis.recommendation, "not_recommended");

  upsertJob(db, { ...sample[0], ...good, greeting: analysis.greeting, analysis }, batchId);
  const stored = listReportJobs(db, { batchId })[0];
  assert(stored.analysis.recommendedResumeVersion);
  assert(stored.analysis.primaryProjects.length > 0);
  let markResult = handleMarkApi(db, JSON.stringify({ jobId: stored.id, status: "skipped", note: "self-check" }), "application/json");
  assert.strictEqual(markResult.statusCode, 200);
  const withStatus = listReportJobs(db, { batchId })[0];
  assert.strictEqual(withStatus.applicationStatus, "skipped");
  assert.strictEqual(withStatus.applicationNote, "self-check");
  markResult = handleMarkApi(db, new URLSearchParams({ jobId: String(stored.id), status: "no_reply", note: "waiting" }).toString(), "application/x-www-form-urlencoded");
  assert.strictEqual(markResult.statusCode, 200);
  const followResult = handleFollowUpApi(db, new URLSearchParams({ jobId: String(stored.id), note: "HR说明一周内反馈" }).toString(), "application/x-www-form-urlencoded");
  assert.strictEqual(followResult.statusCode, 200);
  addFollowUpNote(db, stored.id, "二次跟进");
  const noReplyStatus = listReportJobs(db, { batchId })[0];
  assert.strictEqual(noReplyStatus.applicationStatus, "no_reply");
  assert.strictEqual(noReplyStatus.applicationNote, "waiting");
  assert.strictEqual(noReplyStatus.followUpNote, "二次跟进");
  assert.strictEqual(handleMarkApi(db, "jobId=bad&status=skipped", "application/x-www-form-urlencoded").statusCode, 400);

  const otherBatchId = createBatch(db, "boss", "other");
  upsertJob(db, { ...sample[1], ...risky, sourceId: "other-batch-only", greeting }, otherBatchId);
  assert.strictEqual(listReportJobs(db, { batchId }).length, 1);
  assert.strictEqual(getLatestBatchId(db), otherBatchId);
  assert.strictEqual(listReportJobs(db, { batch: "latest" })[0].sourceId, "other-batch-only");
  assert.strictEqual(buildBatchSummary(db, { batch: "latest" }).batchId, otherBatchId);
  assert.strictEqual(buildBatchSummary(db, { batch: "all" }).batchId, "all");
  assert.strictEqual(filterJobs(listReportJobs(db, { batch: "all" }), { status: "pending", level: "all", fresh: "all", q: "" }).length, 1);
  assert.strictEqual(getDashboardData(db, new URLSearchParams("status=pending&batch=latest")).jobs.length, 1);

  const feedbackBatchId = createBatch(db, "boss", "feedback");
  const lowValueA = {
    ...sample[0],
    sourceId: "feedback-low-a",
    company: "低效公司",
    keyword: "低效关键词",
    greeting
  };
  const lowValueB = {
    ...sample[0],
    sourceId: "feedback-low-b",
    company: "低效公司",
    keyword: "低效关键词",
    greeting
  };
  const lowValueC = {
    ...sample[0],
    sourceId: "feedback-low-c",
    company: "其他低效公司",
    keyword: "低效关键词",
    greeting
  };
  const lowValueD = {
    ...sample[0],
    sourceId: "feedback-low-d",
    company: "第三低效公司",
    keyword: "低效关键词",
    greeting
  };
  const lowIdA = upsertJob(db, lowValueA, feedbackBatchId);
  const lowIdB = upsertJob(db, lowValueB, feedbackBatchId);
  const lowIdC = upsertJob(db, lowValueC, feedbackBatchId);
  const lowIdD = upsertJob(db, lowValueD, feedbackBatchId);
  markApplication(db, lowIdA, "skipped", "low-value");
  markApplication(db, lowIdB, "skipped", "low-value");
  markApplication(db, lowIdC, "skipped", "low-value");
  markApplication(db, lowIdC, "no_reply", "waiting");
  markApplication(db, lowIdD, "skipped", "low-value");

  const feedbackSummary = buildFeedbackSummary(db);
  assert.strictEqual(feedbackSummary.companies["低效公司"].skipped, 2);
  assert.strictEqual(feedbackSummary.keywords["低效关键词"].skipped, 3);
  assert.strictEqual(feedbackSummary.keywords["低效关键词"].no_reply, 1);

  const newLowBatchId = createBatch(db, "boss", "feedback-new");
  upsertJob(db, { ...sample[0], sourceId: "feedback-new", company: "低效公司", keyword: "低效关键词", greeting }, newLowBatchId);
  const feedbackJob = listReportJobs(db, { batchId: newLowBatchId, feedbackSummary })[0];
  assert.strictEqual(feedbackJob.feedback.penalty, 0);
  assert.strictEqual(feedbackJob.feedbackRank, 0);

  const scopedJob = { ...sample[0], ...good, sourceId: "candidate-state-isolation", title: "Snapshot A", greeting };
  const scopedBatchA = createBatch(db, "boss", "candidate-state-a", "", { profileId: savedProfile.profileId, searchPlanId: savedProfile.planId });
  const scopedJobId = upsertJob(db, scopedJob, scopedBatchA);
  const scopedBatchB = createBatch(db, "boss", "candidate-state-b", "", { profileId: savedProfile.profileId, searchPlanId: savedProfile.planId });
  upsertJob(db, { ...scopedJob, title: "Snapshot B", salary: "12-18K" }, scopedBatchB);
  const deferredJobId = upsertJob(db, { ...sample[0], ...good, sourceId: "older-pending-queue", title: "Older pending job", greeting }, scopedBatchA);
  assert.strictEqual(listReportJobs(db, { batchId: scopedBatchA }).find((job) => job.id === scopedJobId).title, "Snapshot A");
  assert.strictEqual(listReportJobs(db, { batchId: scopedBatchB }).find((job) => job.id === scopedJobId).title, "Snapshot B");
  const detailBatchA = createBatch(db, "boss", "detail-a", "", { profileId: savedProfile.profileId, searchPlanId: savedProfile.planId });
  upsertJob(db, { ...sample[0], ...good, sourceId: "detail-change", company: "Detail Corp", title: "AI Engineer", salary: "10-14K", greeting }, detailBatchA);
  const detailBatchB = createBatch(db, "boss", "detail-b", "", { profileId: savedProfile.profileId, searchPlanId: savedProfile.planId });
  const detailId = upsertJob(db, { ...sample[0], ...good, sourceId: "detail-change", company: "Detail Corp", title: "AI Engineer", salary: "12-16K", greeting }, detailBatchB);
  const changedDetail = listReportJobs(db, { batchId: detailBatchB }).find((job) => job.id === detailId);
  assert(changedDetail.detailChanged);
  assert(changedDetail.qualityTags.includes("detail_changed"));
  markCandidateJob(db, { profileId: savedProfile.profileId, planId: savedProfile.planId, jobId: detailId, status: "interview", note: "interview feedback" });
  const profileFeedback = buildFeedbackSummary(db, { profileId: savedProfile.profileId });
  assert.strictEqual(profileFeedback.totals.interview, 1);
  const duplicateBatch = createBatch(db, "boss", "weak-duplicate", "", { profileId: savedProfile.profileId, searchPlanId: savedProfile.planId });
  upsertJob(db, { ...sample[0], ...good, sourceId: "weak-duplicate-a", company: "Duplicate Corp", title: "Python AI Engineer", location: "Guangzhou", greeting }, duplicateBatch);
  upsertJob(db, { ...sample[0], ...good, sourceId: "weak-duplicate-b", company: "Duplicate Corp", title: "Python AI Engineer", location: "Guangzhou", greeting }, duplicateBatch);
  assert(listReportJobs(db, { batchId: duplicateBatch }).every((job) => job.qualityTags.includes("possible_duplicate")));
  assert(listDecisionQueue(db, { planId: savedProfile.planId }).some((job) => job.id === deferredJobId));
  markCandidateJob(db, { profileId: savedProfile.profileId, planId: savedProfile.planId, jobId: scopedJobId, status: "skipped", reasonCode: "direction_mismatch", note: "candidate one" });
  const firstCandidateJob = listReportJobs(db, { batchId: scopedBatchB })[0];
  assert.strictEqual(firstCandidateJob.applicationStatus, "skipped");
  assert.strictEqual(firstCandidateJob.applicationReasonCode, "direction_mismatch");
  const diagnosticFeedback = buildFeedbackSummary(db, { profileId: savedProfile.profileId });
  assert.strictEqual(diagnosticFeedback.reasonCounts.direction_mismatch, 1);
  assert.strictEqual(diagnosticFeedback.companyReasons[firstCandidateJob.company].direction_mismatch, 1);
  assert.strictEqual(diagnosticFeedback.keywordReasons[firstCandidateJob.keyword].direction_mismatch, 1);

  const reasonBatch = createBatch(db, "boss", "candidate-reason-normalization", "", { profileId: savedProfile.profileId, searchPlanId: savedProfile.planId });
  const reasonJobId = upsertJob(db, { ...sample[0], ...good, sourceId: "candidate-reason-normalization", company: "Reason Corp", keyword: "Reason keyword", greeting }, reasonBatch);
  markCandidateJob(db, { profileId: savedProfile.profileId, planId: savedProfile.planId, jobId: reasonJobId, status: "skipped", reasonCode: "salary" });
  const normalizedReasonJob = listReportJobs(db, { batchId: reasonBatch })[0];
  assert.strictEqual(normalizedReasonJob.applicationReasonCode, "salary_mismatch");
  const normalizedFeedback = buildFeedbackSummary(db, { profileId: savedProfile.profileId });
  assert.strictEqual(normalizedFeedback.reasonCounts.salary_mismatch, 1);
  assert.strictEqual(handleMarkApi(db, JSON.stringify({ jobId: reasonJobId, profileId: savedProfile.profileId, planId: savedProfile.planId, status: "skipped", reasonCode: "not-a-reason" })).statusCode, 400);

  const secondProfile = JSON.parse(JSON.stringify(onboarding.profile));
  secondProfile.candidate.name = "Second Candidate";
  const secondPlan = { ...onboarding.plan, name: "Second candidate plan" };
  const secondDocument = { ...resume, originalFileName: "second_candidate.txt", contentHash: `${resume.contentHash}-second` };
  const secondSaved = saveProfileAnalysis(db, { profile: secondProfile, document: secondDocument, searchPlan: secondPlan });
  const scopedBatchC = createBatch(db, "boss", "candidate-state-c", "", { profileId: secondSaved.profileId, searchPlanId: secondSaved.planId });
  upsertJob(db, { ...scopedJob, title: "Snapshot C" }, scopedBatchC);
  const secondCandidateJob = listReportJobs(db, { batchId: scopedBatchC })[0];
  assert.strictEqual(secondCandidateJob.applicationStatus, "");

  markCandidateJob(db, { profileId: savedProfile.profileId, planId: savedProfile.planId, jobId: scopedJobId, status: "later", reviewAt: "2999-01-01" });
  assert(!listDecisionQueue(db, { planId: savedProfile.planId }).some((job) => job.id === scopedJobId));
  markCandidateJob(db, { profileId: savedProfile.profileId, planId: savedProfile.planId, jobId: scopedJobId, status: "review", note: "needs human check" });
  assert(listDecisionQueue(db, { planId: savedProfile.planId }).some((job) => job.id === scopedJobId));

  const updatedProfile = JSON.parse(JSON.stringify(onboarding.profile));
  updatedProfile.candidate.expectedSalary = "10-14K";
  updatedProfile.skills.push({ name: "MCP", level: "resume", evidence: ["updated resume"] });
  saveProfileAnalysis(db, { profileId: savedProfile.profileId, profile: updatedProfile, document: { ...resume, originalFileName: "updated.txt", contentHash: `${resume.contentHash}-updated` }, searchPlan: { ...onboarding.plan, name: "Updated profile plan" } });
  const profileDiff = compareProfileVersions(db, savedProfile.profileId);
  assert(profileDiff.changes.some((change) => change.label === "期望薪资"));
  assert(profileDiff.changes.some((change) => change.label === "技能"));

  saveModelCache(db, { cacheKey: "self-check-cache", kind: "matchJob", provider: "mock", model: "test", inputHash: "abc", result: { cached: true } });
  assert.deepStrictEqual(getModelCache(db, "self-check-cache").result, { cached: true });
  const invalidAnalyzer = createLlmAnalyzer({ adapter: { analyzeResume: async () => [] } });
  await assert.rejects(() => invalidAnalyzer.analyzeResume({}), ModelContractError);

  const calls = { analyzeResume: 0, understandJob: 0, matchJob: 0, draftCommunication: 0 };
  const fakeAnalyzer = {
    analyzeResume: async () => { calls.analyzeResume += 1; return { candidate: { name: "Cache Candidate", targetTitles: ["AI Engineer"] }, skills: [], projects: [] }; },
    understandJob: async ({ job }) => { calls.understandJob += 1; return { jobId: job.sourceId, realRoleType: "ai_application", roleSummary: "Python application development", responsibilityEvidence: [`JD：${job.title}`], coreRequirements: [{ label: "Python", foundation: true, indispensable: true, evidence: "JD：必须熟练使用 Python" }], jobQuality: { level: "normal", concerns: [] }, hiddenRisks: [], evidenceSnippets: [job.title] }; },
    matchJob: async (input) => {
      calls.matchJob += 1;
      for (const field of ["candidateProfile", "candidateMatchCard", "jobUnderstanding", "searchPreferences"]) {
        assert(Object.hasOwn(input, field), `matchJob input must keep ${field}`);
      }
      for (const field of ["resumeVersions", "jobEvidence", "job", "ruleMatch"]) {
        assert.strictEqual(Object.hasOwn(input, field), false, `matchJob input must omit ${field}`);
      }
      return { recommendation: "apply", fitLevel: "B", confidence: 0.9, roleAlignment: "aligned", roleResumeEvidence: ["简历：Python 项目经验"], roleGaps: [], primaryProjects: [], fitReasons: ["Python 经验与岗位要求匹配"], requirementMatches: [{ requirement: "Python", state: "matched", foundation: true, indispensable: true, jdEvidence: "JD：必须熟练使用 Python", resumeEvidence: "简历：Python 项目经验" }], jobQuality: { level: "normal", concerns: [] }, evidence: { jd: ["Python"], resume: ["Python"] } };
    },
    draftCommunication: async () => { calls.draftCommunication += 1; return { kind: "greeting", messages: ["Hello"], missingFact: null, evidence: { jd: ["JD"], resume: ["resume"] }, tone: "natural" }; }
  };
  const cachedRunner = createJobAnalysisRunner(configs, keywordPlan, { db, analyzer: fakeAnalyzer });
  const cacheJob = { ...sample[0], ...good, sourceId: "model-cache-regression", title: "Cache test", greeting };
  const cachedAnalysis = await cachedRunner(cacheJob);
  assert.deepStrictEqual(cachedAnalysis.responsibilityEvidence, [`JD：${cacheJob.title}`]);
  assert.strictEqual(cachedAnalysis.roleAlignment, "aligned");
  assert.deepStrictEqual(cachedAnalysis.roleResumeEvidence, ["简历：Python 项目经验"]);
  assert.deepStrictEqual(cachedAnalysis.roleGaps, []);
  assert.strictEqual(cachedAnalysis.requirementMatches[0].foundation, true);
  await cachedRunner(cacheJob);
  assert.deepStrictEqual(calls, { analyzeResume: 0, understandJob: 1, matchJob: 1, draftCommunication: 0 });

  const communicationFailureRunner = createJobAnalysisRunner(configs, keywordPlan, {
    db,
    analyzer: {
      analyzeResume: async () => ({ candidate: { name: "Fallback Candidate", targetTitles: ["AI Engineer"] }, skills: [], projects: [] }),
      understandJob: async ({ job }) => ({ jobId: job.sourceId, realRoleType: "ai_application", coreRequirements: [{ label: "Python", indispensable: true, evidence: "JD：必须熟练使用 Python" }], jobQuality: { level: "normal", concerns: [] }, hiddenRisks: [], evidenceSnippets: ["Python"] }),
      matchJob: async () => ({ recommendation: "apply", fitLevel: "B", confidence: 0.81, primaryProjects: [], fitReasons: ["完整 JD 已匹配"], requirementMatches: [{ requirement: "Python", state: "matched", indispensable: true, jdEvidence: "JD：必须熟练使用 Python", resumeEvidence: "简历：Python 项目经验" }], jobQuality: { level: "normal", concerns: [] }, evidence: { jd: ["Python"], resume: ["Python"] } }),
      draftCommunication: async () => { throw new Error("communication contract failed"); }
    }
  });
  const communicationFallback = await communicationFailureRunner({ ...cacheJob, sourceId: "communication-fallback", description: `${cacheJob.description} `.repeat(4), greeting: "保留的招呼语" });
  assert.strictEqual(communicationFallback.realRoleType, "ai_application");
  assert.strictEqual(communicationFallback.recommendation, null);
  assert.strictEqual(communicationFallback.decisionStatus, "needs_retry");
  assert.strictEqual(communicationFallback.greeting, "保留的招呼语");
}

function closeSelfCheckDb() {
  try { db.close(); } catch { /* no-op */ }
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${selfCheckDbPath}${suffix}`, { force: true }); } catch { /* no-op */ }
  }
}

function makePdfFixture(text) {
  const content = `BT /F1 12 Tf 72 720 Td (${String(text).replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, "ascii"));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output, "ascii");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}
