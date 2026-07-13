const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadConfigs } = require("../src/config");
const { scoreJob } = require("../src/core/scoring");
const { createGreeting } = require("../src/core/llm");
const { buildKeywordPlan, resolvePlannedKeywords, adjustKeywordPlanWithFeedback } = require("../src/core/keyword_planner");
const { explainJobMatch } = require("../src/core/match_explainer");
const { createLlmAnalyzer } = require("../src/core/llm_analyzer");
const { ModelContractError } = require("../src/core/model_contract");
const { createJobAnalysisRunner } = require("../src/core/job_analysis");
const { parseResumeUpload } = require("../src/core/resume_parser");
const { analyzeResumeToPlan } = require("../src/core/profile_onboarding");
const { planKeywords, profileToRuntimeConfigs } = require("../src/core/search_plan");
const { openDb, createBatch, upsertJob, listReportJobs, markApplication, markCandidateJob, addFollowUpNote, buildFeedbackSummary, buildBatchSummary, getLatestBatchId, saveProfileAnalysis, updateCandidateProfile, saveCandidateResumeVersion, listCandidateResumeVersions, recordResumeParseAttempt, listResumeParseAttempts, getCandidateProfile, getSearchPlan, compareProfileVersions, listDecisionQueue, getModelCache, saveModelCache } = require("../src/core/storage");
const { handleMarkApi, handleFollowUpApi, getDashboardData, filterJobs } = require("../src/dashboard/server");
const { parseBossActivityText, normalizeBossUrl, bossSourceId } = require("../src/adapters/sites/boss");
const { CdpBrowserAdapter } = require("../src/adapters/browser/cdp");

const root = path.resolve(__dirname, "..");
const selfCheckDir = path.join(root, ".runtime", "self-check");
fs.mkdirSync(selfCheckDir, { recursive: true });
const configs = loadConfigs(root, { profile: "profiles/example_profile.json", resumeVersions: "profiles/example_resume_versions.json" });
assert.strictEqual(configs.candidateProfile.candidate.name, "示例候选人");
const sample = JSON.parse(fs.readFileSync(path.join(root, "data", "sample_jobs.json"), "utf8"));
assert.strictEqual(typeof new CdpBrowserAdapter({ port: 9222 }).listTabs, "function");
assert.strictEqual(configs.candidateProfile.candidate.name, "示例候选人");
assert((configs.resumeVersions.versions || []).some((version) => version.id === "ai_rag_agent"));

const keywordPlan = buildKeywordPlan(configs.candidateProfile, configs.resumeVersions, configs.keywords);
assert(keywordPlan.some((item) => item.word === "RAG" && item.resumeVersion === "ai_rag_agent"));
assert(keywordPlan.every((item) => item.priority && item.reason && Array.isArray(item.avoidTerms)));
assert(resolvePlannedKeywords({ keywords: "手动词" }, configs).keywords.includes("手动词"));

const good = scoreJob(sample[0], configs);
assert(good.score > 0);
const explained = explainJobMatch({ ...sample[0], ...good }, configs, keywordPlan);
assert.strictEqual(explained.provider, "rule-mock");
assert(explained.llmReady);
assert(explained.recommendedResumeVersion);
assert(good.canStretch, "3-5年 + 18K以内 + AI应用，应标记可冲");

const risky = scoreJob(sample[1], configs);
assert(risky.score < good.score);
assert(risky.risks.length > 0);
assert.strictEqual(parseBossActivityText("HR 今日活跃，欢迎沟通"), "今日活跃");
assert.strictEqual(normalizeBossUrl("https://www.zhipin.com/job_detail/abc123.html?ka=search_list"), "https://www.zhipin.com/job_detail/abc123.html");
assert.strictEqual(bossSourceId({ url: "https://www.zhipin.com/job_detail/abc123.html?x=1" }), "boss:abc123");

const trainer = scoreJob({
  ...sample[0],
  title: "AI Agent 课程讲师",
  description: `${sample[0].description} 负责课程设计和培训交付。`
}, configs);
assert.strictEqual(trainer.level, "不建议");
assert(trainer.score < good.score);

const selfCheckDbPath = path.join(selfCheckDir, `self-check-${Date.now()}.sqlite`);
const db = openDb(selfCheckDbPath);
const batchId = createBatch(db, "boss", "self-check");
const greeting = createGreeting(sample[0], configs.profile);
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
  assert.strictEqual(configs.model.provider, "mock");
  const analyzer = createLlmAnalyzer({ modelConfig: configs.model });
  const candidateProfile = await analyzer.analyzeResume({
    resumeText: "",
    profileHints: configs.candidateProfile
  });
  assert.strictEqual(candidateProfile.candidate.name, configs.candidateProfile.candidate.name);
  assert(Array.isArray(candidateProfile.skills));

  const jobUnderstanding = await analyzer.understandJob({
    job: sample[0],
    candidateProfile
  });
  assert(jobUnderstanding.jobId);
  assert(Array.isArray(jobUnderstanding.coreRequirements));
  assert(Array.isArray(jobUnderstanding.hiddenRisks));

  const matchDecision = await analyzer.matchJob({
    candidateProfile: configs.candidateProfile,
    resumeVersions: configs.resumeVersions,
    jobUnderstanding
  });
  assert(["apply", "caution", "skip"].includes(matchDecision.recommendation));
  assert(matchDecision.recommendedResumeVersion);
  assert(Array.isArray(matchDecision.primaryProjects));

  const communication = await analyzer.draftCommunication({
    candidateProfile: configs.candidateProfile,
    jobUnderstanding,
    matchDecision
  });
  assert(communication.greeting);
  assert(communication.hrReplies.gap);

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
  assert.strictEqual(getCandidateProfile(db, savedProfile.profileId).profile.candidate.name, "测试候选人");
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
  const docxFixture = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "tests", "make_docx_fixture.ps1"), "-Path", docxPath], { encoding: "utf8" });
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
  assert.strictEqual(riskyAnalysis.recommendation, "skip");

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
  assert(feedbackJob.feedback.penalty > 0);
  assert(feedbackJob.feedback.notes.some((note) => note.includes("低效关键词")));

  const adjustedPlan = adjustKeywordPlanWithFeedback([{ word: "低效关键词", priority: "A" }], feedbackSummary);
  assert.strictEqual(adjustedPlan[0].priority, "B");
  assert(adjustedPlan[0].feedbackNote);

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
    understandJob: async ({ job }) => { calls.understandJob += 1; return { jobId: job.sourceId, realRoleType: "ai_application", coreRequirements: ["Python"], evidenceSnippets: [job.title] }; },
    matchJob: async () => { calls.matchJob += 1; return { recommendation: "apply", fitLevel: "B", confidence: 0.9, primaryProjects: [], evidence: { jd: ["Python"], resume: ["Python"] } }; },
    draftCommunication: async () => { calls.draftCommunication += 1; return { greeting: "Hello", hrReplies: {} }; }
  };
  const cachedRunner = createJobAnalysisRunner(configs, keywordPlan, { db, analyzer: fakeAnalyzer });
  const cacheJob = { ...sample[0], ...good, sourceId: "model-cache-regression", title: "Cache test", greeting };
  await cachedRunner(cacheJob);
  await cachedRunner(cacheJob);
  assert.deepStrictEqual(calls, { analyzeResume: 1, understandJob: 1, matchJob: 1, draftCommunication: 1 });
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
