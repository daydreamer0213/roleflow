const assert = require("node:assert");
const { normalizeCandidateProfile, normalizeSearchPlan } = require("../src/core/profile_schema");
const { profileToRuntimeConfigs } = require("../src/core/search_plan");
const { OpenAICompatibleAdapter } = require("../src/adapters/models/openai_compatible");

const profile = normalizeCandidateProfile({
  candidate: { name: "测试候选人", city: "广州", targetTitles: ["AI应用开发工程师"], expectedSalary: "9-14K" },
  skills: Array.from({ length: 20 }, (_, index) => ({ name: "技能" + index, level: "resume" })),
  projects: Array.from({ length: 8 }, (_, index) => ({ name: "项目" + index })),
  evidenceGaps: ["未提供团队规模", "未提供毕业月份", "未提供英语四级分数"]
});

assert.strictEqual(profile.skills.length, 16);
assert.strictEqual(profile.projects.length, 6);
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
assert.deepStrictEqual(normalizeSearchPlan({ experience: ["2-3?", "3-5?"] }, profile).experience, ["2-3年", "3-5年（可冲）"]);

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
assert(runtime.scoring.risk_rules.some((item) => item.word === "模型训练"));
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
  assert(planPrompt.includes("bossActiveDays 固定输出 3"));
  assert(planPrompt.includes("bossCityCode 是系统内部字段"));
  console.log("profile_quality_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
