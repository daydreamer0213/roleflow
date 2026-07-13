const assert = require("assert");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { openDb, getSearchPlan, listCandidateResumeVersions, listResumeParseAttempts, listReportJobs } = require("../src/core/storage");

const root = path.resolve(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `onboarding-${Date.now()}.sqlite`);
let dashboard;
let success = false;
const generatedReports = [];

(async () => {
  fs.mkdirSync(smokeDir, { recursive: true });
  const port = await getFreePort();
  dashboard = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.js", "dashboard", "--db", dbPath, "--port", String(port), "--allow-offline-mock", "--force-mock"], {
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
  const settingsPage = await fetch(`${baseUrl}/settings`);
  const settingsHtml = await settingsPage.text();
  assert.strictEqual(settingsPage.status, 200);
  assert(settingsHtml.includes("DeepSeek"));
  assert(settingsHtml.includes("通义千问"));
  assert(settingsHtml.includes('name="apiKey"'));

  const upload = await uploadResume(baseUrl, "sample-resume.txt", fs.readFileSync(path.join(root, "data", "sample_resume.txt")), "text/plain");
  assert.strictEqual(upload.status, 303);
  const planLocation = upload.headers.get("location");
  assert(planLocation?.startsWith("/plan?profileId="), "resume upload did not open a search plan");

  const docxPath = path.join(smokeDir, `onboarding-${Date.now()}.docx`);
  const docxFixture = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "tests", "make_docx_fixture.ps1"), "-Path", docxPath], { encoding: "utf8" });
  assert.strictEqual(docxFixture.status, 0, docxFixture.stderr || docxFixture.stdout);
  try {
    const docxUpload = await uploadResume(baseUrl, "sample-resume.docx", fs.readFileSync(docxPath), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.strictEqual(docxUpload.status, 303, await docxUpload.text());
    const pdfUpload = await uploadResume(baseUrl, "sample-resume.pdf", makePdfFixture("Test Candidate Python FastAPI RAG Agent project experience for upload endpoint verification."), "application/pdf");
    assert.strictEqual(pdfUpload.status, 303, await pdfUpload.text());
    const pastedUpload = await uploadResumeText(baseUrl, fs.readFileSync(path.join(root, "data", "sample_resume.txt"), "utf8"));
    assert.strictEqual(pastedUpload.status, 303, await pastedUpload.text());
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

  const planPage = await fetch(`${baseUrl}${planLocation}`);
  const planHtml = await planPage.text();
  assert.strictEqual(planPage.status, 200);
  assert(planHtml.includes("可直接开始扫描"));
  assert(planHtml.includes("筛选方案"));
  assert(planHtml.includes("搜索关键词"));

  const query = new URL(`${baseUrl}${planLocation}`).searchParams;
  const planId = Number(query.get("planId"));
  const profileId = Number(query.get("profileId"));
  const db = openDb(dbPath);
  const plan = getSearchPlan(db, planId);
  assert(plan?.plan?.keywords?.length, "generated search plan had no keywords");
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
      skills: "Python | API\nRAG | retrieval",
      projects: "KnowledgeFlow | independent project | LangGraph,tests | do not overclaim"
    }),
    redirect: "manual"
  });
  assert.strictEqual(profileSaved.status, 303);

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
  assert(listCandidateResumeVersions(db, profileId).some((version) => version.name === "AI Resume Variant"));

  const saved = await fetch(`${baseUrl}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      profileId: String(profileId),
      planId: String(planId),
      name: "广州 AI 筛选计划",
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
      detailLimit: "4",
      maxDetailTotal: "80"
    }),
    redirect: "manual"
  });
  assert.strictEqual(saved.status, 303);
  assert.strictEqual(getSearchPlan(db, planId).plan.source, "user-confirmed");
  assert.strictEqual(getSearchPlan(db, planId).plan.allowExperienceStretch, true);
  db.close();

  const scan = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.js", "scan", "--db", dbPath, "--plan", String(planId), "--input", path.join("data", "sample_jobs.json"), "--force-mock"], { cwd: root, encoding: "utf8" });
  assert.strictEqual(scan.status, 0, scan.stderr || scan.stdout);
  collectGeneratedReports(scan.stdout);

  const jobs = await fetch(`${baseUrl}/jobs?planId=${planId}&batch=latest&status=pending`);
  const jobsHtml = await jobs.text();
  const verifyDb = openDb(dbPath);
  const scanned = listReportJobs(verifyDb, { planId, batch: "latest" });
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
  verifyDb.close();
  assert.strictEqual(jobs.status, 200);
  assert(jobsHtml.includes("投递操作台"));
  assert(jobsHtml.includes("岗位"));

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

async function uploadResume(baseUrl, fileName, fileData, type) {
  const form = new FormData();
  form.set("resume", new Blob([fileData], { type }), fileName);
  return fetch(`${baseUrl}/api/resume`, { method: "POST", body: form, redirect: "manual" });
}

async function uploadResumeText(baseUrl, resumeText) {
  const form = new FormData();
  form.set("resumeText", resumeText);
  return fetch(`${baseUrl}/api/resume`, { method: "POST", body: form, redirect: "manual" });
}

function collectGeneratedReports(stdout) {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = line.match(/^(Markdown|HTML):\s*(.+)$/);
    if (match) generatedReports.push(match[2].trim());
  }
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
