const assert = require("assert");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const {
  openDb,
  getSearchPlan,
  getActiveSearchPlan,
  getCandidateProfile,
  listCandidateProfiles,
  getSearchPlanDependency,
  getCandidateMatchingContext,
  getActiveMatchingCard,
  listMatchingCards,
  listCandidateResumeVersions,
  listMatchingResumeVersions,
  saveCandidateResumeVersion,
  saveProfileAnalysis,
  listResumeParseAttempts,
  listReportJobs
} = require("../src/core/storage");
const { matchingCardRevision } = require("../src/core/matching_card");
const { loadConfigs } = require("../src/config");
const { profileToRuntimeConfigs } = require("../src/core/search_plan");
const { resolveAnalysisConcurrency } = require("../src/cli");

const root = path.resolve(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `onboarding-${Date.now()}.sqlite`);
const browserProfilePath = path.join(smokeDir, `onboarding-browser-profile-${process.pid}-${Date.now()}`);
let dashboard;
let success = false;
const generatedReports = [];

(async () => {
  fs.mkdirSync(smokeDir, { recursive: true });
  const port = await getFreePort();
  dashboard = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.js", "dashboard", "--db", dbPath, "--port", String(port), "--browser", "portable", "--cdp-port", "9222", "--browser-profile", browserProfilePath, "--allow-offline-mock", "--force-mock"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/health`);

  const home = await fetch(`${baseUrl}/`, { redirect: "manual" });
  assert.strictEqual(home.status, 303);
  assert.strictEqual(home.headers.get("location"), "/onboarding");
  const onboardingPage = await fetch(`${baseUrl}/onboarding`);
  const onboardingHtml = await onboardingPage.text();
  assert.strictEqual(onboardingPage.status, 200);
  assert(onboardingHtml.includes('id="resume-text"'));
  assert(onboardingHtml.includes("使用模板"));
  assert(onboardingHtml.includes("预览发送内容"));
  assert(onboardingHtml.includes("姓名、手机号、邮箱、住址和身份证号会在本地遮盖后再发送模型"));

  const previewForm = new FormData();
  previewForm.set("resumeText", `${fs.readFileSync(path.join(root, "data", "sample_resume.txt"), "utf8")}\n手机：13800138000\n邮箱：candidate@example.com\n现住址：广州市天河区测试路 18 号`);
  const previewResponse = await fetch(`${baseUrl}/api/resume/preview`, { method: "POST", body: previewForm });
  const preview = await previewResponse.json();
  assert.strictEqual(previewResponse.status, 200);
  assert(!preview.text.includes("13800138000"));
  assert(!preview.text.includes("candidate@example.com"));
  assert(!preview.text.includes("测试路 18 号"));
  assert(preview.text.includes("KnowledgeFlow"));
  const filePreviewForm = new FormData();
  filePreviewForm.set("resume", new Blob([[
    "项目经历",
    "测试候选人参与 Example Project",
    "公司：示例科技",
    "技能：Python、RAG",
    "求职意向：AI应用开发",
    "项目说明：使用 Python 和 RAG 构建 Example Project",
    "时间：2024.03-2025.01"
  ].join("\n")], { type: "text/plain" }), "测试候选人-AI应用开发 (1).txt");
  const filePreviewResponse = await fetch(`${baseUrl}/api/resume/preview`, { method: "POST", body: filePreviewForm });
  const filePreview = await filePreviewResponse.json();
  assert.strictEqual(filePreviewResponse.status, 200);
  assert(!filePreview.text.includes("测试候选人"));
  assert.strictEqual(filePreview.redactions.name, 1);
  assert(filePreview.text.includes("Example Project"));
  assert(filePreview.text.includes("示例科技"));
  const settingsPage = await fetch(`${baseUrl}/settings`);
  const settingsHtml = await settingsPage.text();
  assert.strictEqual(settingsPage.status, 200);
  assert(settingsHtml.includes("DeepSeek"));
  assert(settingsHtml.includes("通义千问"));
  assert(settingsHtml.includes('name="apiKey"'));
  const cliSource = fs.readFileSync(path.join(root, "src", "cli.js"), "utf8");
  assert(
    (cliSource.match(/taskProfile:\s*"batch_screening"/g) || []).length >= 3,
    "scan, refresh and batch reassessment must explicitly use batch_screening"
  );
  assert(
    (cliSource.match(/taskProfile:\s*"deep_analysis"/g) || []).length >= 1,
    "profile creation must explicitly use deep_analysis"
  );
  assert.doesNotMatch(
    cliSource,
    /resolveRuntimeModelConfig\(\{\s*root:\s*ROOT,\s*fallbackModelConfig:\s*configs\.model\s*\}\)/,
    "CLI model routing must not rely on the default deep_analysis profile"
  );
  assert.strictEqual(resolveAnalysisConcurrency({}, 1), 1);
  assert.strictEqual(resolveAnalysisConcurrency({ "analysis-concurrency": 8 }, 1), 1);
  assert.strictEqual(resolveAnalysisConcurrency({ "analysis-concurrency": 1 }, 2), 1);
  assert.strictEqual(resolveAnalysisConcurrency({ "analysis-concurrency": 8 }, 2), 2);
  const scanSource = cliSource.slice(
    cliSource.indexOf("async function scan("),
    cliSource.indexOf("async function refreshDetails(")
  );
  assert(scanSource.indexOf("isModelReady(primaryState") >= 0);
  assert(
    scanSource.indexOf("isModelReady(primaryState") < scanSource.indexOf("createBrowser(args)"),
    "scan must reject an unready batch profile before creating or probing a browser"
  );
  const refreshSource = cliSource.slice(
    cliSource.indexOf("async function refreshDetails("),
    cliSource.indexOf("async function analyzeActivityProbe(")
  );
  assert(refreshSource.indexOf("isModelReady(batchModelState") >= 0);
  assert(
    refreshSource.indexOf("isModelReady(batchModelState") < refreshSource.indexOf("createBrowser(args)"),
    "refresh-details/activity must reject an unready batch profile before creating or probing a browser"
  );

  const sampleResumeText = fs.readFileSync(path.join(root, "data", "sample_resume.txt"), "utf8");
  const privateFileNameContacts = ["13987654321", "上海市浦东新区默认文件名路88号"];
  const identityFileName = `测试候选人-${privateFileNameContacts[0]}-联系地址${privateFileNameContacts[1]}.txt`;
  const upload = await uploadResume(baseUrl, identityFileName, fs.readFileSync(path.join(root, "data", "sample_resume.txt")), "text/plain");
  assert.strictEqual(upload.status, 303);
  const parsedLog = latestLogEvent(root, "resume_parsed");
  assert(parsedLog, "successful resume parsing must emit a diagnostic event");
  assert.strictEqual(parsedLog.source, "file");
  assert.strictEqual(parsedLog.format, "txt");
  assert(!Object.hasOwn(parsedLog, "fileName"), "resume parsing logs must not retain an uploaded filename field");
  assert(!JSON.stringify(parsedLog).includes(identityFileName));
  assert(!JSON.stringify(parsedLog).includes("测试候选人"));
  const matchCardLocation = upload.headers.get("location");
  assert(matchCardLocation?.startsWith("/match-card?profileId="), `resume upload must open the matching card page, got ${matchCardLocation}`);
  const matchCardQuery = new URL(`${baseUrl}${matchCardLocation}`).searchParams;
  const profileId = Number(matchCardQuery.get("profileId"));
  const cardId = Number(matchCardQuery.get("cardId"));
  assert(profileId > 0 && cardId > 0, "match-card redirect must carry profileId and cardId");

  const defaultPrivacyContacts = [
    "13912345678",
    "default-privacy-contact@example.com",
    "上海市浦东新区默认脱敏路 88 号"
  ];
  const defaultPrivacyResume = [
    "隐私回归候选人",
    `手机：${defaultPrivacyContacts[0]}`,
    `邮箱：${defaultPrivacyContacts[1]}`,
    `联系地址：${defaultPrivacyContacts[2]}`,
    "求职意向：AI 应用开发",
    "项目经历：KnowledgeFlow，负责 RAG 检索服务与评估。",
    "专业技能：Python、FastAPI、RAG、SQLite。",
    "工作经历：Example Labs，负责知识库问答产品。"
  ].join("\n");
  const defaultPrivacyUpload = await uploadResumeText(baseUrl, defaultPrivacyResume);
  assert.strictEqual(defaultPrivacyUpload.status, 303, await defaultPrivacyUpload.text());
  const defaultPrivacyLocation = defaultPrivacyUpload.headers.get("location");
  const defaultPrivacyProfileId = Number(new URL(`${baseUrl}${defaultPrivacyLocation}`).searchParams.get("profileId"));
  assert(defaultPrivacyProfileId > 0, "privacy fixture upload must create a profile");
  const defaultPrivacyReupload = await uploadResumeText(baseUrl, defaultPrivacyResume, defaultPrivacyProfileId);
  assert.strictEqual(defaultPrivacyReupload.status, 303, await defaultPrivacyReupload.text());
  const privacyProfilePage = await fetch(`${baseUrl}/profile?profileId=${defaultPrivacyProfileId}`);
  const privacyProfileHtml = await privacyProfilePage.text();
  assert.strictEqual(privacyProfilePage.status, 200);
  const privacyDb = openDb(dbPath);
  const privacyAttempts = listResumeParseAttempts(privacyDb, defaultPrivacyProfileId);
  privacyDb.close();
  for (const secret of defaultPrivacyContacts) {
    assert(!privacyProfileHtml.includes(secret), `default profile diagnostics must not expose ${secret}`);
    assert(!JSON.stringify(privacyAttempts).includes(secret), `stored parse diagnostics must not expose ${secret}`);
  }
  assert(privacyProfileHtml.includes("手机:[已隐藏]"));
  assert(privacyProfileHtml.includes("邮箱:[邮箱已隐藏]"));
  assert(privacyProfileHtml.includes("联系地址:[已隐藏]"));
  const defaultDiagnosticsResponse = await fetch(`${baseUrl}/diagnostics`);
  const defaultDiagnosticsHtml = await defaultDiagnosticsResponse.text();
  assert.strictEqual(defaultDiagnosticsResponse.status, 200);
  for (const secret of defaultPrivacyContacts) {
    assert(!defaultDiagnosticsHtml.includes(secret), `default diagnostics logs must not expose ${secret}`);
  }

  const docxPath = path.join(smokeDir, `onboarding-${Date.now()}.docx`);
  const docxFixture = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "tests", "make_docx_fixture.ps1"), "-Path", docxPath], { encoding: "utf8", windowsHide: true });
  assert.strictEqual(docxFixture.status, 0, docxFixture.stderr || docxFixture.stdout);
  let pastedProfileId = 0;
  let pastedCardId = 0;
  try {
    const docxUpload = await uploadResume(baseUrl, "sample-resume.docx", fs.readFileSync(docxPath), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.strictEqual(docxUpload.status, 303, await docxUpload.text());
    assert(docxUpload.headers.get("location")?.startsWith("/match-card?profileId="), "docx upload must also open a matching card draft");
    const pdfUpload = await uploadResume(baseUrl, "sample-resume.pdf", makePdfFixture("Test Candidate Python FastAPI RAG Agent project experience for upload endpoint verification."), "application/pdf");
    assert.strictEqual(pdfUpload.status, 303, await pdfUpload.text());
    const pastedUpload = await uploadResumeText(baseUrl, sampleResumeText);
    assert.strictEqual(pastedUpload.status, 303, await pastedUpload.text());
    const pastedLocation = pastedUpload.headers.get("location");
    assert(pastedLocation?.startsWith("/match-card?profileId="), "pasted upload must open a matching card draft");
    const pastedQuery = new URL(`${baseUrl}${pastedLocation}`).searchParams;
    pastedProfileId = Number(pastedQuery.get("profileId"));
    pastedCardId = Number(pastedQuery.get("cardId"));
    assert(pastedProfileId > 0 && pastedCardId > 0 && pastedProfileId !== profileId);
    const rejectedIdentityValues = ["测试候选人", "13800138000", "candidate@example.com"];
    const rejectedFileName = "测试候选人-AI应用开发.txt";
    const rejectedText = [
      "姓名：测试候选人",
      "手机：13800138000",
      "邮箱：candidate@example.com"
    ].join("\n");
    const rejectedUpload = await uploadResume(baseUrl, rejectedFileName, Buffer.from(rejectedText, "utf8"), "text/plain");
    const rejectedBody = await rejectedUpload.text();
    assert.strictEqual(rejectedUpload.status, 400, rejectedBody);
    assert(rejectedBody.includes("简历文件解析失败"));
    assert(rejectedBody.includes("未能读到足够的简历文字"));
    assert(rejectedBody.includes("RESUME_TEXT_TOO_SHORT"));
    for (const secret of [rejectedFileName, ...rejectedIdentityValues]) {
      assert(!rejectedBody.includes(secret), `上传错误页面不得泄露身份值：${secret}`);
    }
    const failedLog = latestLogEvent(root, "resume_upload_failed");
    assert(failedLog, "failed resume parsing must emit a diagnostic event");
    assert.strictEqual(failedLog.error?.details?.diagnostics?.preview, "[REDACTED]");
    for (const secret of [rejectedFileName, ...rejectedIdentityValues]) {
      assert(!JSON.stringify(failedLog).includes(secret), `上传错误日志不得泄露身份值：${secret}`);
    }
    const shortText = await uploadResumeText(baseUrl, "too short");
    const shortTextBody = await shortText.text();
    assert.strictEqual(shortText.status, 400, shortTextBody);
    assert(shortTextBody.includes("解析失败"));
    assert(shortTextBody.includes("RESUME_TEXT_TOO_SHORT"));
    const diagnostics = await fetch(`${baseUrl}/diagnostics`);
    const diagnosticsHtml = await diagnostics.text();
    assert.strictEqual(diagnostics.status, 200);
    assert(diagnosticsHtml.includes("resume_upload_failed"));
    assert(diagnosticsHtml.includes("RESUME_TEXT_TOO_SHORT"));
  } finally {
    fs.rmSync(docxPath, { force: true });
  }

  const db = openDb(dbPath);
  const automaticVersion = listCandidateResumeVersions(db, profileId)
    .find((version) => Number(version.resumeDocumentId) > 0);
  assert(automaticVersion, "automatic resume version must be stored");
  assert.strictEqual(automaticVersion.name, "基础简历");
  assert.strictEqual(automaticVersion.fileName, "简历文件.txt");
  for (const secret of privateFileNameContacts) {
    assert(!JSON.stringify(automaticVersion).includes(secret), `candidate storage DTO must not expose filename contact: ${secret}`);
  }
  const originalResumeFile = await fetch(`${baseUrl}/resume-file?id=${automaticVersion.resumeDocumentId}`);
  assert.strictEqual(originalResumeFile.status, 200);
  assert(originalResumeFile.headers.get("content-disposition").includes(encodeURIComponent(identityFileName)), "explicit source-file action must keep the original filename");

  const planId = getActiveSearchPlan(db, profileId)?.id;
  assert(planId, "upload must still recommend a search plan, but it is not user confirmation");
  db.prepare("UPDATE search_plans SET is_active = 0 WHERE id = ?").run(planId);
  assert.strictEqual(getActiveSearchPlan(db, profileId), null, "没有 is_active=1 的方案时不得把历史 inactive 方案冒充活动方案");
  assert.strictEqual(listCandidateProfiles(db).find((item) => item.id === profileId)?.activePlanId, null, "候选人列表同样不得把 inactive 方案标为活动方案");
  db.prepare("UPDATE search_plans SET is_active = 1 WHERE id = ?").run(planId);

  const unconfirmedScan = runCliScan(planId);
  assert.notStrictEqual(unconfirmedScan.status, 0, "scan must refuse to run before the matching card is confirmed");
  const unconfirmedOutput = `${unconfirmedScan.stderr}\n${unconfirmedScan.stdout}`;
  assert(unconfirmedOutput.includes("MATCHING_CARD_CONFIRMATION_REQUIRED"), unconfirmedOutput);
  assert(unconfirmedOutput.includes("请在工作台确认现有匹配偏好卡"), unconfirmedOutput);
  assert(unconfirmedOutput.includes(`profileId=${profileId}`), unconfirmedOutput);
  assert(unconfirmedOutput.includes(`cardId=${cardId}`), unconfirmedOutput);
  assert(!unconfirmedOutput.includes("重新上传"), "recovery guidance must not ask for a resume re-upload");

  const matchCardPage = await fetch(`${baseUrl}/match-card?profileId=${profileId}&cardId=${cardId}`);
  const matchCardHtml = await matchCardPage.text();
  assert.strictEqual(matchCardPage.status, 200);
  for (const secret of privateFileNameContacts) {
    assert(!matchCardHtml.includes(secret), `matching-card page must not expose filename contact: ${secret}`);
  }
  assert(matchCardHtml.includes("目标方向"));
  assert(matchCardHtml.includes("强证据"));
  assert(matchCardHtml.includes("可迁移能力"));
  assert(matchCardHtml.includes("需谨慎转向"));
  assert(matchCardHtml.includes("保存草稿"));
  assert(matchCardHtml.includes("确认匹配偏好卡"));
  assert(matchCardHtml.includes("当前扫描使用"));
  assert(matchCardHtml.includes("尚无已确认的匹配偏好卡"), "page must offer existing drafts when nothing is confirmed");

  const confirmed = await fetch(`${baseUrl}/api/match-card/confirm`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ profileId: String(profileId), cardId: String(cardId) }),
    redirect: "manual"
  });
  assert.strictEqual(confirmed.status, 303);
  const confirmedLocation = confirmed.headers.get("location");
  assert(confirmedLocation.startsWith(`/plan?profileId=${profileId}`), confirmedLocation);
  assert(confirmedLocation.includes("matchCardConfirmed=1"), confirmedLocation);
  const confirmedQuery = new URL(`${baseUrl}${confirmedLocation}`).searchParams;
  assert.strictEqual(Number(confirmedQuery.get("planId")), planId);

  const planPage = await fetch(`${baseUrl}${confirmedLocation}`);
  const planHtml = await planPage.text();
  assert.strictEqual(planPage.status, 200);
  assert(planHtml.includes("可直接开始扫描"));
  assert(planHtml.includes("筛选方案"));
  assert(planHtml.includes("搜索关键词"));
  assert(planHtml.includes("广泛扫描预算"));
  assert(planHtml.includes("右栏详情安全上限"));
  assert(planHtml.includes("日常扫描"));
  assert(planHtml.includes("广泛扫描"));
  assert(planHtml.includes('name="scanKind" value="daily"'));
  assert(planHtml.includes('name="scanKind" value="broad"'));
  assert(planHtml.includes("补读缺失详情"));
  assert(planHtml.includes("更新过期活跃状态"));
  assert(planHtml.includes("单标签串行、随机等待和风控即停"));

  const plan = getSearchPlan(db, planId);
  assert(plan?.plan?.keywords?.length, "generated search plan had no keywords");
  assert.strictEqual(getSearchPlanDependency(db, planId).stale, false);
  assert(listResumeParseAttempts(db, profileId).some((attempt) => attempt.status === "succeeded"), "successful parse attempt was not recorded");

  const profilePage = await fetch(`${baseUrl}/profile?profileId=${profileId}`);
  const profileHtml = await profilePage.text();
  assert.strictEqual(profilePage.status, 200);
  assert(profileHtml.includes("name=\"skills\""));
  const profileSaved = await fetch(`${baseUrl}/api/profile`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      profileId: String(profileId),
      name: "Smoke Candidate",
      city: "Guangzhou",
      targetTitles: "AI Application Engineer,Python Backend",
      expectedSalary: "9-14K",
      adjustableSalary: "8-12K,9-13K",
      education: "Smoke University | 本科 | 电子信息 | 2020 | 2024 | 已毕业 |",
      experiences: "Smoke Company | AI Intern | 实习 | 2025.01 | 2025.04 | 参与 RAG 接口 | 接口联调 | Python,RAG",
      skills: "Python | API\nRAG | retrieval",
      projects: "KnowledgeFlow | 2025 | knowledge workflow | independent project | LangGraph,tests | Python,RAG | 336 tests | do not overclaim",
      credentials: "英语四级 | 已通过",
      strengths: "独立完成 Agent 项目"
    }),
    redirect: "manual"
  });
  assert.strictEqual(profileSaved.status, 303);
  const locallyRenamed = getCandidateProfile(db, profileId);
  assert.strictEqual(locallyRenamed.displayName, "Smoke Candidate");
  assert.strictEqual(
    locallyRenamed.profile.candidate.name,
    "候选人",
    "local display name edits must not restore identity into model-safe profile_json"
  );
  assert.strictEqual(profileSaved.status, 303);
  assert.strictEqual(getCandidateProfile(db, profileId).profile.education[0].degree, "本科");
  assert.strictEqual(getSearchPlanDependency(db, planId).stale, false, "画像编辑不产生新匹配卡时，已确认卡仍是方案依据");

  const versionForm = new FormData();
  versionForm.set("profileId", String(profileId));
  versionForm.set("name", "AI Resume Variant");
  versionForm.set("targetRoles", "AI Application Engineer,RAG Engineer");
  versionForm.set("keywords", "Python,RAG,FastAPI");
  versionForm.set("primaryProjects", "KnowledgeFlow");
  versionForm.set("summary", "Smoke test resume variant");
  versionForm.set("isActive", "on");
  versionForm.set("resumeVersion", new Blob([fs.readFileSync(path.join(root, "data", "sample_resume.txt"))], { type: "text/plain" }), "resume-ai.txt");
  const versionSaved = await fetch(`${baseUrl}/api/resume-version`, { method: "POST", body: versionForm, redirect: "manual" });
  assert.strictEqual(versionSaved.status, 303, await versionSaved.text());
  const versionsPage = await fetch(`${baseUrl}/resumes?profileId=${profileId}`);
  const versionsHtml = await versionsPage.text();
  assert.strictEqual(versionsPage.status, 200);
  assert(versionsHtml.includes("AI Resume Variant"));
  assert(versionsHtml.includes("打开原文件"));
  assert(versionsHtml.includes("不会改变基础候选人画像"), "resume versions page must state it never rewrites the base profile");
  assert(versionsHtml.includes("不会替换当前匹配偏好卡"), "resume versions page must state it never replaces the active matching card");
  for (const secret of privateFileNameContacts) {
    assert(!versionsHtml.includes(secret), `resume versions page must not expose filename contact: ${secret}`);
  }
  const savedVersion = listCandidateResumeVersions(db, profileId).find((version) => version.name === "AI Resume Variant");
  assert(savedVersion?.resumeTextExcerpt.includes("测试候选人"));
  assert(savedVersion?.storedFilePath.includes(path.join(".runtime", "resumes")));
  const sourceFile = await fetch(`${baseUrl}/resume-file?id=${savedVersion.resumeDocumentId}`);
  assert.strictEqual(sourceFile.status, 200);
  assert(Buffer.from(await sourceFile.arrayBuffer()).toString("utf8").includes("测试候选人"));
  assert(savedVersion?.analysis?.candidate, "新增简历版本必须独立分析并保存结构化事实");

  const planFormBody = {
    profileId: String(profileId),
    planId: String(planId),
    name: "广州 AI 筛选计划",
    acquisitionMode: "generated",
    cities: "广州",
    bossCityCode: "101280100",
    salaryMinK: "9",
    salaryMaxK: "14",
    experience: "经验不限,0-3年,1-3年",
    allowExperienceStretch: "on",
    bossActiveDays: "3",
    directions: "AI应用开发,RAG,Python后端",
    keywords: plan.plan.keywords.map((item) => `${item.word}|${item.priority}|${item.reason}`).join("\n"),
    excludeWords: "销售,培训,讲师",
    hardExcludes: "培训贷",
    maxCards: "40",
    maxDetailTotal: "80"
  };
  const saved = await fetch(`${baseUrl}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(planFormBody),
    redirect: "manual"
  });
  assert.strictEqual(saved.status, 303);
  assert.strictEqual(getSearchPlan(db, planId).plan.source, "user-confirmed");
  assert.strictEqual(getSearchPlan(db, planId).plan.schemaVersion, 2);
  assert.strictEqual(getSearchPlan(db, planId).plan.acquisitionMode, "generated");
  assert.deepStrictEqual(getSearchPlan(db, planId).plan.platform.generated.cities, ["广州"]);
  const storedPlanAfterSave = JSON.parse(db.prepare("SELECT plan_json FROM search_plans WHERE id = ?").get(planId).plan_json);
  assert.strictEqual(Object.hasOwn(storedPlanAfterSave, "cities"), false);
  assert.strictEqual(Object.hasOwn(storedPlanAfterSave.platform, "salaryLanes"), false);
  assert.strictEqual(getSearchPlanDependency(db, planId).stale, false, "保存方案后应绑定当前匹配卡版本");
  assert.strictEqual(getSearchPlan(db, planId).plan.allowExperienceStretch, true);

  const scan = runCliScan(planId);
  assert.strictEqual(scan.status, 0, scan.stderr || scan.stdout);
  collectGeneratedReports(scan.stdout);

  const jobs = await fetch(`${baseUrl}/jobs?planId=${planId}&batch=latest&status=pending`);
  const jobsHtml = await jobs.text();
  const scanned = listReportJobs(db, { planId, batch: "latest" });
  assert(scanned.length, "scan did not save jobs");
  const outcome = await fetch(`${baseUrl}/api/mark`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ jobId: String(scanned[0].id), profileId: String(profileId), planId: String(planId), status: "interview", note: "smoke interview" }),
    redirect: "manual"
  });
  assert.strictEqual(outcome.status, 303);
  const interviewJobs = await fetch(`${baseUrl}/jobs?planId=${planId}&batch=latest&outcome=interview`);
  const interviewHtml = await interviewJobs.text();
  assert.strictEqual(interviewJobs.status, 200);
  assert(interviewHtml.includes("smoke interview"));
  assert.strictEqual(jobs.status, 200);
  assert(jobsHtml.includes("投递操作台"));
  assert(jobsHtml.includes("岗位"));

  // 相同内容重新上传的三种情形：不新增画像版本、不调用模型解析。
  const cardsBeforeReupload = listMatchingCards(db, profileId).length;
  const reuploadConfirmed = await uploadResume(baseUrl, "sample-resume.txt", fs.readFileSync(path.join(root, "data", "sample_resume.txt")), "text/plain", profileId);
  assert.strictEqual(reuploadConfirmed.status, 303);
  const reuploadConfirmedLocation = reuploadConfirmed.headers.get("location");
  assert(reuploadConfirmedLocation?.startsWith(`/plan?profileId=${profileId}`), `confirmed card must short-circuit to the plan, got ${reuploadConfirmedLocation}`);
  assert.strictEqual(listMatchingCards(db, profileId).length, cardsBeforeReupload, "same content with a confirmed card must not create cards");

  const reuploadDraft = await uploadResumeText(baseUrl, sampleResumeText, pastedProfileId);
  assert.strictEqual(reuploadDraft.status, 303);
  const reuploadDraftLocation = reuploadDraft.headers.get("location");
  assert(reuploadDraftLocation?.startsWith(`/match-card?profileId=${pastedProfileId}`), `draft card must reopen, got ${reuploadDraftLocation}`);
  assert.strictEqual(Number(new URL(`${baseUrl}${reuploadDraftLocation}`).searchParams.get("cardId")), pastedCardId, "same content must reopen the existing draft card");

  db.prepare("DELETE FROM candidate_matching_cards WHERE profile_id = ?").run(pastedProfileId);
  const legacyUpload = await uploadResumeText(baseUrl, sampleResumeText, pastedProfileId);
  assert.strictEqual(legacyUpload.status, 303);
  const legacyLocation = legacyUpload.headers.get("location");
  assert(legacyLocation?.startsWith(`/match-card?profileId=${pastedProfileId}`), `legacy profile must get a deterministic draft, got ${legacyLocation}`);
  const legacyCardId = Number(new URL(`${baseUrl}${legacyLocation}`).searchParams.get("cardId"));
  const legacyCards = listMatchingCards(db, pastedProfileId);
  assert.strictEqual(legacyCards.length, 1, "legacy profile must get exactly one deterministic draft card");
  assert.strictEqual(legacyCards[0].id, legacyCardId);
  assert.strictEqual(legacyCards[0].status, "draft");
  assert.strictEqual(legacyCards[0].source, "migration");
  assert(legacyCards[0].card.targetDirections.length > 0, "deterministic card must reuse the saved profile facts");
  const legacyReupload = await uploadResumeText(baseUrl, sampleResumeText, pastedProfileId);
  assert.strictEqual(legacyReupload.status, 303);
  assert.strictEqual(Number(new URL(`${baseUrl}${legacyReupload.headers.get("location")}`).searchParams.get("cardId")), legacyCardId, "deterministic draft must be created only once");

  // 上传不同内容：新卡为草稿，旧确认卡继续作为扫描依据，直到用户确认新卡。
  const changedResumeText = `${sampleResumeText}\n补充：负责企业知识库二期，引入重排与评测，掌握 SecretNewSkill 技能。`;
  const changedUpload = await uploadResumeText(baseUrl, changedResumeText, profileId);
  assert.strictEqual(changedUpload.status, 303);
  const changedLocation = changedUpload.headers.get("location");
  assert(changedLocation?.startsWith(`/match-card?profileId=${profileId}`), `new content must open a new draft card, got ${changedLocation}`);
  const changedCardId = Number(new URL(`${baseUrl}${changedLocation}`).searchParams.get("cardId"));
  assert(changedCardId && changedCardId !== cardId, "new content must produce a new draft card");
  const changedCard = listMatchingCards(db, profileId).find((card) => card.id === changedCardId);
  assert.strictEqual(changedCard?.status, "draft");
  assert.strictEqual(getCandidateMatchingContext(db, profileId)?.matchingCardId, cardId, "old confirmed card must stay the active matching context");
  assert.strictEqual(getActiveSearchPlan(db, profileId)?.id, planId, "上传不同内容只生成草稿卡，不得停用或替换当前有效方案");
  assert.strictEqual(getSearchPlanDependency(db, planId).stale, false, "新卡确认前，当前方案必须保持可用");
  const activePlanPage = await fetch(`${baseUrl}/plan?profileId=${profileId}`);
  const activePlanHtml = await activePlanPage.text();
  assert.strictEqual(activePlanPage.status, 200);
  assert(!activePlanHtml.includes("方案需要重新确认"), "仅有待确认草稿时，方案页不得要求重新确认");
  assert(activePlanHtml.includes('value="daily">日常扫描</button>'), "仅有待确认草稿时，方案页扫描按钮不得被禁用");

  const changedCardPage = await fetch(`${baseUrl}${changedLocation}`);
  const changedCardHtml = await changedCardPage.text();
  assert.strictEqual(changedCardPage.status, 200);
  assert(changedCardHtml.includes("新简历待确认，不会自动替换当前匹配依据"));
  assert(changedCardHtml.includes("当前扫描使用"));
  assert(changedCardHtml.includes("会用于岗位匹配"), "用户补充偏好说明必须与模型语义一致");
  assert(changedCardHtml.includes("不能代替简历证据"), "用户补充偏好不得被描述成简历证据");
  assert(!changedCardHtml.includes("只给自己看"), "不得再把参与匹配的 userNotes 描述成只给自己看");

  // 未确认的新简历版本不得进入模型输入：草稿卡绑定的版本被安全入口排除，确认后才恢复参与。
  const changedDocumentId = changedCard?.resumeDocumentId;
  assert(changedDocumentId, "新草稿卡必须绑定新简历文档");
  const alternateUpload = await uploadResumeText(baseUrl, `${sampleResumeText}\n另一草稿：负责会员增长分析，掌握 SecretAlternateSkill。`, profileId);
  assert.strictEqual(alternateUpload.status, 303);
  const documentsBeforeRepeat = db.prepare("SELECT COUNT(*) AS count FROM resume_documents WHERE profile_id = ?").get(profileId).count;
  const repeatedChangedUpload = await uploadResumeText(baseUrl, changedResumeText, profileId);
  assert.strictEqual(repeatedChangedUpload.status, 303);
  assert.strictEqual(
    Number(new URL(`${baseUrl}${repeatedChangedUpload.headers.get("location")}`).searchParams.get("cardId")),
    changedCardId,
    "B→C→B 交替上传必须重开历史 B 草稿"
  );
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS count FROM resume_documents WHERE profile_id = ?").get(profileId).count,
    documentsBeforeRepeat,
    "已有 draft/confirmed 哈希的重复上传必须在模型分析和保存新文档前短路"
  );
  const activeProfileSnapshot = getCandidateProfile(db, profileId).profile;
  const duplicateAutomatic = saveProfileAnalysis(db, {
    profileId,
    profile: activeProfileSnapshot,
    document: {
      originalFileName: "duplicate-automatic.txt",
      format: "text",
      contentHash: changedCard.resumeContentHash,
      text: changedResumeText,
      diagnostics: {}
    },
    searchPlan: null
  });
  assert(
    !listMatchingResumeVersions(db, profileId).some((version) => Number(version.resumeDocumentId) === Number(duplicateAutomatic.resumeDocumentId)),
    "共享安全入口必须按 draft 内容哈希排除历史异常或并发产生的重复自动版本"
  );
  const allVersions = listCandidateResumeVersions(db, profileId);
  assert(allVersions.some((version) => Number(version.resumeDocumentId) === Number(changedDocumentId)), "管理视图仍保留全部活动简历版本");
  const matchingVersions = listMatchingResumeVersions(db, profileId);
  assert(!matchingVersions.some((version) => Number(version.resumeDocumentId) === Number(changedDocumentId)), "草稿卡绑定的简历版本不得进入匹配输入");
  assert(!matchingVersions.some((version) => (version.resumeTextExcerpt || "").includes("SecretNewSkill")), "未确认简历正文不得进入匹配输入");
  const oldMatchingContext = getCandidateMatchingContext(db, profileId);
  const runtimeConfigs = profileToRuntimeConfigs(loadConfigs(root), oldMatchingContext.candidateProfile, getSearchPlan(db, planId).plan, matchingVersions, oldMatchingContext.matchingCard);
  assert(!JSON.stringify(runtimeConfigs.resumeVersions || {}).includes("SecretNewSkill"), "运行时简历版本输入不得包含未确认内容");
  assert(!JSON.stringify(runtimeConfigs.candidateProfile || {}).includes("SecretNewSkill"), "运行时候选人画像必须是旧确认卡对应版本");
  assert(!JSON.stringify(runtimeConfigs.matchingCard || {}).includes("SecretNewSkill"), "运行时匹配卡必须仍是旧确认卡");

  // 用户主动管理、未绑定待确认卡的活动投递版简历始终可以进入输入。
  saveCandidateResumeVersion(db, {
    profileId,
    document: { originalFileName: "user-managed.txt", format: "text", contentHash: changedCard.resumeContentHash, text: changedResumeText },
    version: { name: "投递版-店铺运营", targetRoles: ["电商运营"], keywords: ["店铺运营"], primaryProjects: ["店铺投放复盘"], summary: "用户主动管理" }
  });
  assert(listMatchingResumeVersions(db, profileId).some((version) => version.name === "投递版-店铺运营"), "用户主动管理的活动版本即使与 draft 内容相同也不得被误排除");

  const oldContextScan = runCliScan(planId);
  assert.strictEqual(oldContextScan.status, 0, oldContextScan.stderr || oldContextScan.stdout);
  collectGeneratedReports(oldContextScan.stdout);

  // 重评/重算与扫描共用同一套已确认匹配上下文：新简历未确认时仍使用旧确认卡，不得碰未确认的新画像。
  const reassess = runCliCommand(["reassess-batch", "--plan", String(planId)]);
  assert.strictEqual(reassess.status, 0, reassess.stderr || reassess.stdout);
  const reassessedJobs = listReportJobs(db, { planId, batch: "latest" });
  assert(reassessedJobs.length > 0, "重评后必须有可检查的岗位分析");
  const confirmedCardRevision = matchingCardRevision(getActiveMatchingCard(db, profileId).card);
  const revisionedJobs = reassessedJobs.filter((job) => job.analysis?.revision);
  assert(revisionedJobs.length > 0, "重评后必须有带修订指纹的分析可检查");
  for (const job of revisionedJobs) {
    assert.strictEqual(job.analysis.revision.matchingCardVersion, confirmedCardRevision, "重评必须使用已确认匹配卡的版本指纹，不得使用未确认的新画像");
  }
  const rescore = runCliCommand(["rescore-plan", "--plan", String(planId)]);
  assert.strictEqual(rescore.status, 0, rescore.stderr || rescore.stdout);

  const confirmChanged = await fetch(`${baseUrl}/api/match-card/confirm`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ profileId: String(profileId), cardId: String(changedCardId) }),
    redirect: "manual"
  });
  assert.strictEqual(confirmChanged.status, 303);
  assert.strictEqual(getCandidateMatchingContext(db, profileId)?.matchingCardId, changedCardId);
  assert.strictEqual(getSearchPlanDependency(db, planId).stale, true, "确认新卡后旧方案必须标记为待确认");

  // 已被替换的历史卡：不得重新确认，页面必须标明历史状态而不是冒充当前依据。
  const reconfirmOld = await fetch(`${baseUrl}/api/match-card/confirm`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ profileId: String(profileId), cardId: String(cardId) }),
    redirect: "manual"
  });
  assert.notStrictEqual(reconfirmOld.status, 303, "已被替换的历史卡不得重新确认成功");
  assert.strictEqual(getCandidateMatchingContext(db, profileId)?.matchingCardId, changedCardId, "拒绝重新激活历史卡后活动卡不得变化");
  assert.strictEqual(listMatchingCards(db, profileId).filter((item) => item.status === "confirmed").length, 1, "任何时刻只能有一张已确认卡");
  const supersededCardPage = await fetch(`${baseUrl}/match-card?profileId=${profileId}&cardId=${cardId}`);
  const supersededCardHtml = await supersededCardPage.text();
  assert.strictEqual(supersededCardPage.status, 200);
  assert(supersededCardHtml.includes("已被替换"), "历史卡页面必须标明已被替换");
  assert(!supersededCardHtml.includes("（已确认）"), "历史卡页面不得显示为已确认或当前匹配依据");

  const staleScan = runCliScan(planId);
  assert.notStrictEqual(staleScan.status, 0, "stale plan must refuse to scan until saved again");
  assert(`${staleScan.stderr}\n${staleScan.stdout}`.includes("画像已更新"));

  const staleReassess = runCliCommand(["reassess-batch", "--plan", String(planId)]);
  assert.notStrictEqual(staleReassess.status, 0, "stale 方案必须拒绝重评");
  assert(`${staleReassess.stderr}\n${staleReassess.stdout}`.includes("画像已更新"), "stale 重评的失败原因必须与扫描一致");
  const staleRescore = runCliCommand(["rescore-plan", "--plan", String(planId)]);
  assert.notStrictEqual(staleRescore.status, 0, "stale 方案必须拒绝重算");
  assert(`${staleRescore.stderr}\n${staleRescore.stdout}`.includes("画像已更新"), "stale 重算的失败原因必须与扫描一致");

  // 已有 confirmed 卡时，即使活动方案已 stale，新上传也只产生草稿：
  // 不自动停用、替换或重绑该方案；确认新卡后仍 stale，直到用户明确保存。
  const thirdUpload = await uploadResumeText(baseUrl, `${sampleResumeText}\n第三版：增加 SecretThirdSkill 与会员增长复盘。`, profileId);
  assert.strictEqual(thirdUpload.status, 303);
  const thirdLocation = thirdUpload.headers.get("location");
  assert(thirdLocation?.startsWith(`/match-card?profileId=${profileId}`), `third upload must open a new draft card, got ${thirdLocation}`);
  const thirdCardId = Number(new URL(`${baseUrl}${thirdLocation}`).searchParams.get("cardId"));
  assert(thirdCardId && thirdCardId !== changedCardId, "第三份不同简历必须产生新草稿卡");
  assert.strictEqual(getActiveSearchPlan(db, profileId)?.id, planId, "stale 活动方案不得被新草稿自动替换");
  assert.strictEqual(getSearchPlanDependency(db, planId).stale, true, "stale 方案在新草稿后继续保持 stale");
  const thirdCard = listMatchingCards(db, profileId).find((card) => card.id === thirdCardId);
  assert(!listMatchingResumeVersions(db, profileId).some((version) => Number(version.resumeDocumentId) === Number(thirdCard?.resumeDocumentId)), "第三版草稿卡绑定的简历版本同样不得进入匹配输入");

  const confirmThird = await fetch(`${baseUrl}/api/match-card/confirm`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ profileId: String(profileId), cardId: String(thirdCardId) }),
    redirect: "manual"
  });
  assert.strictEqual(confirmThird.status, 303);
  assert.strictEqual(getActiveMatchingCard(db, profileId)?.id, thirdCardId);
  assert.strictEqual(getSearchPlanDependency(db, planId).stale, true, "确认第三张卡后旧方案仍 stale，必须用户明确保存");

  const resaved = await fetch(`${baseUrl}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(planFormBody),
    redirect: "manual"
  });
  assert.strictEqual(resaved.status, 303);
  assert.strictEqual(getSearchPlanDependency(db, planId).stale, false, "保存方案后应重新绑定新确认卡的画像版本");

  // 确认新卡并保存方案后，新简历版本恢复参与匹配输入。
  const confirmedVersions = listMatchingResumeVersions(db, profileId);
  assert(confirmedVersions.some((version) => Number(version.resumeDocumentId) === Number(changedDocumentId)), "确认新卡后对应简历版本必须恢复参与");
  assert(confirmedVersions.some((version) => (version.resumeTextExcerpt || "").includes("SecretNewSkill")), "确认后新简历内容可以进入匹配输入");

  const finalScan = runCliScan(planId);
  assert.strictEqual(finalScan.status, 0, finalScan.stderr || finalScan.stdout);
  collectGeneratedReports(finalScan.stdout);

  db.close();

  success = true;
  console.log("onboarding_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (dashboard) {
    dashboard.kill();
    await new Promise((resolve) => dashboard.once("close", resolve));
  }
  if (success) cleanup();
});

function runCliScan(planId) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.js", "scan", "--db", dbPath, "--plan", String(planId), "--input", path.join("data", "sample_jobs.json"), "--force-mock"], { cwd: root, encoding: "utf8" });
}

function runCliCommand(cliArgs) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.js", ...cliArgs, "--db", dbPath], { cwd: root, encoding: "utf8" });
}

async function uploadResume(baseUrl, fileName, fileData, type, profileId = 0) {
  const form = new FormData();
  if (profileId) form.set("profileId", String(profileId));
  form.set("resume", new Blob([fileData], { type }), fileName);
  return settleResumeUpload(
    baseUrl,
    await fetch(`${baseUrl}/api/resume`, { method: "POST", body: form, redirect: "manual" })
  );
}

async function uploadResumeText(baseUrl, resumeText, profileId = 0) {
  const form = new FormData();
  if (profileId) form.set("profileId", String(profileId));
  form.set("resumeText", resumeText);
  return settleResumeUpload(
    baseUrl,
    await fetch(`${baseUrl}/api/resume`, { method: "POST", body: form, redirect: "manual" })
  );
}

async function settleResumeUpload(baseUrl, response) {
  const location = response.headers.get("location") || "";
  if (response.status !== 303 || !location.startsWith("/onboarding/progress?runId=")) {
    return response;
  }
  const runId = new URL(`${baseUrl}${location}`).searchParams.get("runId");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const statusResponse = await fetch(
      `${baseUrl}/api/onboarding-status?runId=${encodeURIComponent(runId)}`
    );
    const state = await statusResponse.json();
    if (state.status === "completed" && state.nextHref) {
      return new Response("", { status: 303, headers: { location: state.nextHref } });
    }
    if (state.status === "failed") {
      return new Response(state.errorMessage || "onboarding failed", { status: 500 });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return new Response("onboarding timed out", { status: 504 });
}

function collectGeneratedReports(stdout) {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = line.match(/^(Markdown|HTML):\s*(.+)$/);
    if (match) generatedReports.push(match[2].trim());
  }
}

function latestLogEvent(projectRoot, event) {
  const logDir = path.join(projectRoot, ".runtime", "logs");
  if (!fs.existsSync(logDir)) return null;
  const entries = [];
  for (const file of fs.readdirSync(logDir).filter((name) => name.endsWith(".jsonl")).sort()) {
    for (const line of fs.readFileSync(path.join(logDir, file), "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.event === event) entries.push(entry);
      } catch {
        // Ignore an incomplete log line.
      }
    }
  }
  return entries.sort((left, right) => String(left.time).localeCompare(String(right.time))).at(-1) || null;
}

function cleanup() {
  for (const report of generatedReports) {
    try { fs.rmSync(report, { force: true }); } catch { /* Windows can release reports late. */ }
  }
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* Windows can release SQLite handles late. */ }
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

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("dashboard health check timed out");
}
