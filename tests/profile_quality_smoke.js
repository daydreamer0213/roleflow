const assert = require("node:assert");
const { normalizeCandidateProfile, normalizeSearchPlan } = require("../src/core/profile_schema");
const { profileToRuntimeConfigs } = require("../src/core/search_plan");
const { validateSearchPlan } = require("../src/core/plan_validation");
const { OpenAICompatibleAdapter } = require("../src/adapters/models/openai_compatible");
const { prepareResumeTextForModel } = require("../src/core/profile_onboarding");

const preparedResume = prepareResumeTextForModel(`姓名：测试候选人
手机：13800138000
邮箱：candidate@example.com
身份证号：44010119900101123X
现住址：广州市天河区某街道 18 号
项目经历：Python RAG 知识库开发`);
assert(!preparedResume.text.includes("13800138000"));
assert(!preparedResume.text.includes("candidate@example.com"));
assert(!preparedResume.text.includes("44010119900101123X"));
assert(!preparedResume.text.includes("某街道 18 号"));
assert(preparedResume.text.includes("Python RAG 知识库开发"));
assert.deepStrictEqual(preparedResume.redactions, { phone: 1, email: 1, idCard: 1, address: 1 });

const profile = normalizeCandidateProfile({
  candidate: { name: "测试候选人", city: "广州", targetTitles: ["AI应用开发工程师"], expectedSalary: "9-14K" },
  education: [{ school: "测试大学", degree: "本科", major: "电子信息", startDate: "2020", endDate: "2024" }],
  experiences: [{ organization: "测试公司", role: "AI实习生", type: "实习", roleBoundary: "参与 RAG 检索优化", highlights: ["参与接口联调"] }],
  skills: Array.from({ length: 20 }, (_, index) => ({ name: "技能" + index, level: "resume" })),
  projects: Array.from({ length: 8 }, (_, index) => ({ name: "项目" + index })),
  credentials: ["英语四级"],
  strengths: ["可独立完成 Agent 项目"],
  riskMessaging: { gap: "模型不应从简历生成" },
  evidenceGaps: ["未提供团队规模", "未提供毕业月份", "未提供英语四级分数"]
});

assert.strictEqual(profile.skills.length, 20);
assert.strictEqual(profile.projects.length, 8);
assert.strictEqual(profile.education[0].degree, "本科");
assert.strictEqual(profile.experiences[0].roleBoundary, "参与 RAG 检索优化");
assert.deepStrictEqual(profile.credentials, [{ name: "英语四级", details: "" }]);
assert.deepStrictEqual(profile.strengths, ["可独立完成 Agent 项目"]);
assert.deepStrictEqual(profile.riskMessaging, {});
assert.deepStrictEqual(profile.evidenceGaps, []);

const plan = normalizeSearchPlan({
  cities: ["广州"],
  experience: ["0-3年", "1-3年"],
  salaryMode: "strict",
  bossActiveDays: 30,
  keywords: ["AI应用开发工程师", "RAG工程师"],
  directions: ["AI应用开发"]
}, profile);
assert.strictEqual(plan.bossActiveDays, 3);
assert.deepStrictEqual(plan.jobTypes, ["全职"]);
assert.deepStrictEqual(plan.degrees, []);
const unsupportedCity = validateSearchPlan({ ...plan, cities: ["惠州"] }, profile);
assert.strictEqual(unsupportedCity.valid, false);
assert(unsupportedCity.errors.some((item) => item.includes("惠州")));
assert.deepStrictEqual(normalizeSearchPlan({ experience: ["2-3?", "3-5?"] }, profile).experience, ["2-3年", "3-5年（可冲）"]);
const locationlessProfile = normalizeCandidateProfile({ candidate: { name: "无地点候选人", targetTitles: ["Python后端"] } });
assert.deepStrictEqual(normalizeSearchPlan({ keywords: ["Python后端"] }, locationlessProfile).cities, []);

const runtime = profileToRuntimeConfigs({
  profile: { location: {} },
  scoring: {
    boss_activity: { max_active_days: 30 },
    risk_rules: [{ word: "模型训练", penalty: 8, risk: "偏训练" }]
  },
  resumeVersions: { versions: [] }
}, profile, { ...plan, bossActiveDays: 30, allowExperienceStretch: false });
assert.strictEqual(runtime.scoring.boss_activity.max_active_days, 3);
assert.strictEqual(runtime.scoring.allowExperienceStretch, false);
assert(!runtime.scoring.risk_rules.some((item) => item.word === "模型训练"), "通用运行时不应继承单一候选人的硬编码技术排除规则");
assert.deepStrictEqual(runtime.scoring.experience.selected, ["0-3年", "1-3年"]);
assert.strictEqual(runtime.scoring.salary.mode, "strict");

const adapter = new OpenAICompatibleAdapter({});
let resumePrompt = "";
let planPrompt = "";
adapter.chatJson = async (prompt) => {
  if (!resumePrompt) resumePrompt = prompt;
  else planPrompt = prompt;
  return {};
};

(async () => {
  await adapter.analyzeResume({});
  await adapter.recommendSearchPlan({});
  assert(resumePrompt.includes("不要评价简历质量"));
  assert(resumePrompt.includes("不要输出 evidenceGaps"));
  assert(resumePrompt.includes("未知字段直接留空或省略"));
  assert(resumePrompt.includes("不要从简历推断或生成 GAP"));
  assert(resumePrompt.includes("education"));
  assert(planPrompt.includes("bossActiveDays 固定输出 3"));
  assert(planPrompt.includes("bossCityCode 是系统内部字段"));
  assert(planPrompt.includes("没有明确地点时 cities 输出空数组"));
  console.log("profile_quality_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
