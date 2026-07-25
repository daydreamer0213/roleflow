const assert = require("node:assert");
const {
  prepareResumeTextForModel,
  assertResumeIdentityRedacted
} = require("../src/core/resume_privacy");
const { analyzeResumeProfile } = require("../src/core/profile_onboarding");
const { parseResumeText } = require("../src/core/resume_parser");
const { errorMeta } = require("../src/core/observability");

const input = [
  "测试候选人",
  "男 | 年龄：26岁 | 13800138000 | candidate@example.com",
  "求职意向：AI应用开发",
  "项目经历",
  "Example Project"
].join("\n");

const identity = {
  names: ["测试候选人"],
  phones: ["13800138000"],
  emails: ["candidate@example.com"]
};

const prepared = prepareResumeTextForModel(input, {
  originalFileName: "测试候选人-AI应用开发.pdf",
  identity,
  strict: true
});

assert(!prepared.text.includes("测试候选人"));
assert(!prepared.text.includes("13800138000"));
assert(!prepared.text.includes("candidate@example.com"));
assert(prepared.text.includes("Example Project"));
assert.strictEqual(prepared.redactions.name, 1);
assert(!JSON.stringify(prepared).includes("测试候选人"));
assert(!JSON.stringify(prepared).includes("13800138000"));
assert(!JSON.stringify(prepared).includes("candidate@example.com"));

const labeled = prepareResumeTextForModel([
  "个人简历",
  "姓名：测试候选人",
  "技能：Python",
  "项目：Example Project"
].join("\n"), { strict: true });
assert(!labeled.text.includes("测试候选人"));
assert.strictEqual(labeled.redactions.name, 1);

const firstLine = prepareResumeTextForModel([
  "",
  "测试候选人",
  "女 | 年龄：26岁 | candidate@example.com",
  "公司：示例科技"
].join("\n"), { strict: true });
assert(!firstLine.text.includes("测试候选人"));
assert(firstLine.text.includes("示例科技"));

const fileName = prepareResumeTextForModel([
  "项目经历",
  "测试候选人参与 Example Project",
  "技能：Python",
  "时间：2024.03-2025.01"
].join("\n"), {
  originalFileName: "测试候选人-AI应用开发 (1).pdf",
  strict: true
});
assert(!fileName.text.includes("测试候选人"));
assert(fileName.text.includes("Example Project"));
assert(fileName.text.includes("Python"));
assert(fileName.text.includes("2024.03-2025.01"));

const literalIdentity = prepareResumeTextForModel("姓名：测试(候选)+人\n项目：Example Project", {
  identity: { names: [" 测试(候选)+人 ", "测试(候选)+人", ""] },
  strict: true
});
assert(!literalIdentity.text.includes("测试(候选)+人"));
assert.strictEqual(literalIdentity.redactions.name, 1);

assert.throws(
  () => prepareResumeTextForModel(input, { identity: "测试候选人", strict: true }),
  (error) => error.code === "RESUME_PRIVACY_REDACTION_FAILED"
    && !String(error.message).includes("测试候选人")
);

assert.throws(
  () => prepareResumeTextForModel("项目经历\nExample Project".repeat(10), {
    originalFileName: "resume.pdf",
    identity: { names: ["", "  "] },
    strict: true
  }),
  (error) => error.code === "RESUME_PRIVACY_REDACTION_FAILED"
);

for (const leakedValue of ["测试候选人", "13800138000", "candidate@example.com"]) {
  assert.throws(
    () => assertResumeIdentityRedacted(leakedValue, identity),
    (error) => error.code === "RESUME_PRIVACY_REDACTION_FAILED"
      && !String(error.message).includes(leakedValue)
      && !JSON.stringify(error).includes(leakedValue)
  );
}

const ordinaryFacts = prepareResumeTextForModel([
  "项目经历",
  "星河项目",
  "公司：示例科技",
  "技能：Python、RAG",
  "时间：2024.03-2025.01"
].join("\n"), {
  identity: { names: ["测试候选人"] },
  strict: true
});
for (const fact of ["星河项目", "示例科技", "Python", "RAG", "2024.03-2025.01"]) {
  assert(ordinaryFacts.text.includes(fact), `普通简历事实不得被遮盖：${fact}`);
}

(async () => {
  let analyzerFactoryCalls = 0;
  await assert.rejects(
    () => analyzeResumeProfile({
      modelConfig: { provider: "openai_compatible" },
      resume: { text: "项目经历足够长但没有可识别姓名。".repeat(10), originalFileName: "resume.pdf" },
      strictPrivacy: true,
      identity: { names: [] },
      analyzerFactory() {
        analyzerFactoryCalls += 1;
        throw new Error("不得到达模型初始化");
      }
    }),
    (error) => error.code === "RESUME_PRIVACY_REDACTION_FAILED"
  );
  assert.strictEqual(analyzerFactoryCalls, 0);

  let modelResumeText = "";
  const downstreamLogs = [];
  const logger = {
    info(event, fields) {
      downstreamLogs.push({ event, ...fields });
    }
  };
  const resume = parseResumeText({
    text: input,
    fileName: "测试候选人-AI应用开发.txt"
  });
  assert(resume.diagnostics.preview.includes("测试候选人"), "production parser fixture must start with an identity-bearing preview");
  const profile = await analyzeResumeProfile({
    modelConfig: { provider: "mock" },
    resume,
    logger,
    identity,
    strictPrivacy: true,
    analyzerFactory() {
      analyzerFactoryCalls += 1;
      return {
        async analyzeResume({ resumeText }) {
          modelResumeText = resumeText;
          logger.info("model_resume_received", { resumeText });
          return { candidate: { name: "候选人" } };
        }
      };
    }
  });
  assert.strictEqual(analyzerFactoryCalls, 1);
  const safeError = errorMeta(Object.assign(new Error("模型边界处理失败。"), {
    code: "MODEL_BOUNDARY_FAILED",
    details: { modelResumeText }
  }));
  for (const secret of ["测试候选人", "13800138000", "candidate@example.com"]) {
    assert(!modelResumeText.includes(secret));
    assert(!JSON.stringify(resume.diagnostics).includes(secret));
    assert(!JSON.stringify(profile).includes(secret));
    assert(!JSON.stringify(downstreamLogs).includes(secret));
    assert(!JSON.stringify(safeError).includes(secret));
  }
  assert(resume.diagnostics.preview.includes("[姓名已隐藏]"));
  assert.strictEqual(resume.diagnostics.modelInput.preview, resume.diagnostics.preview);

  console.log("resume_privacy_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
