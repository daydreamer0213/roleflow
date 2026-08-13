const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { openDb } = require("../src/core/storage");
const { parseResumeText } = require("../src/core/resume_parser");
const {
  createOnboardingRun,
  getOnboardingRun
} = require("../src/storage/onboarding_store");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-onboarding-cli-"));
const dbPath = path.join(temp, "jobs.sqlite");
let db = openDb(dbPath);

try {
  const document = parseResumeText({
    text: [
      "姓名：CLI 候选人",
      "求职意向：AI 应用开发工程师",
      "项目经历：KnowledgeFlow 项目，使用 Python、FastAPI 和 RAG。",
      "工作经历：参与企业知识检索服务开发并负责接口联调。",
      "专业技能：Python、FastAPI、RAG、SQLite、Docker。"
    ].join("\n")
  });
  const created = createOnboardingRun(db, {
    displayName: "CLI 候选人",
    document
  });
  db.close();
  db = null;

  const result = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "src/cli.js",
    "onboarding-process",
    "--db", dbPath,
    "--run", created.run.id,
    "--force-mock"
  ], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  db = openDb(dbPath);
  const run = getOnboardingRun(db, created.run.id);
  assert.strictEqual(run.status, "completed");
  assert.strictEqual(run.stage, "ready");
  assert(run.profileVersionId > 0);
  assert(run.matchingCardId > 0);
  assert(run.searchPlanId > 0);
  assert.match(result.stdout, /Onboarding run .* completed/);
  console.log("onboarding_cli_smoke ok");
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
}
