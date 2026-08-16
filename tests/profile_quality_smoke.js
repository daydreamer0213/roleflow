const assert = require("node:assert");
const { normalizeCandidateProfile, normalizeSearchPlan } = require("../src/core/profile_schema");
const { profileToRuntimeConfigs, resolveScanPolicy, applyScanPolicyToFilters } = require("../src/core/search_plan");
const { resolveNativeFilterSnapshot } = require("../src/core/platform_filters");
const { validateSearchPlan, assertSearchPlanReady } = require("../src/core/plan_validation");
const { OpenAICompatibleAdapter } = require("../src/adapters/models/openai_compatible");
const { prepareResumeTextForModel, buildCandidateMatchCard } = require("../src/core/profile_onboarding");
const { validateModelResult, ModelContractError } = require("../src/core/model_contract");
const { PRODUCT_POLICY_VERSION, PRODUCT_POLICY } = require("../src/core/product_policy");

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
assert(!preparedResume.text.includes("测试候选人"));
assert(preparedResume.text.includes("Python RAG 知识库开发"));
assert.deepStrictEqual(preparedResume.redactions, { phone: 1, email: 1, idCard: 1, address: 1, name: 1 });

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
assert.strictEqual(plan.scan.maxDetailTotal, 300);
assert.strictEqual(plan.scan.maxCards, PRODUCT_POLICY.searchPlan.broadScanDefaults.maxCards);
assert.strictEqual(Object.hasOwn(plan.scan, "detailLimit"), false);
const defaultSalaryModePlan = normalizeSearchPlan({}, profile);
assert.strictEqual(defaultSalaryModePlan.salaryMode, "strict");
assert.strictEqual(normalizeSearchPlan({ salaryMode: "invalid" }, profile).salaryMode, "strict");
assert.strictEqual(normalizeSearchPlan({ salaryMode: "wide" }, profile).salaryMode, "wide");
assert.strictEqual(normalizeSearchPlan({ salaryMode: "strict" }, profile).salaryMode, "strict");
assert.strictEqual(normalizeSearchPlan({ scan: { maxDetailTotal: 500 } }, profile).scan.maxDetailTotal, 500);
const modePlan = {
  ...plan,
  keywords: [
    { word: "AI application", priority: "A" },
    { word: "RAG", priority: "A" },
    { word: "Agent", priority: "B" },
    { word: "Python backend", priority: "C" }
  ],
  scan: { maxCards: 90, maxDetailTotal: 300, browserPageBudget: 90 }
};
const dailyPolicy = resolveScanPolicy(modePlan, "daily");
assert.deepStrictEqual(dailyPolicy.keywordPlan.map((item) => item.word), ["AI application", "RAG", "Agent"]);
assert.strictEqual(dailyPolicy.maxCards, 50);
assert.strictEqual(dailyPolicy.maxDetailTotal, 240);
assert.deepStrictEqual(dailyPolicy.detailLimits, { A: 45, B: 30 });
assert.strictEqual(dailyPolicy.browserPageBudget, 40);
assert.strictEqual(dailyPolicy.salaryLaneLimit, 2);
assert.strictEqual(dailyPolicy.supplementalSalaryLaneKeywordLimit, 1);
assert.strictEqual(dailyPolicy.supplementalSalaryLaneCardLimit, 20);
assert.strictEqual(dailyPolicy.supplementalSalaryLaneDetailLimit, 10);
assert.strictEqual(dailyPolicy.policyVersion, PRODUCT_POLICY_VERSION);
assert.match(dailyPolicy.policyHash, /^[a-f0-9]{64}$/);
assert.strictEqual(resolveScanPolicy(modePlan, "daily").policyHash, dailyPolicy.policyHash);
const lowBudgetPlan = {
  ...modePlan,
  scan: { maxCards: 10, maxDetailTotal: 1, browserPageBudget: 20 }
};
const dailyWithLowBroadBudget = resolveScanPolicy(lowBudgetPlan, "daily");
assert.strictEqual(dailyWithLowBroadBudget.maxCards, 50);
assert.strictEqual(dailyWithLowBroadBudget.maxDetailTotal, 240);
assert.strictEqual(dailyWithLowBroadBudget.browserPageBudget, 40);
const broadPolicy = resolveScanPolicy(modePlan, "broad");
assert.strictEqual(broadPolicy.keywordPlan.length, 4);
assert.strictEqual(broadPolicy.maxCards, 90);
assert.strictEqual(broadPolicy.maxDetailTotal, 300);
assert.notStrictEqual(broadPolicy.policyHash, dailyPolicy.policyHash);
const lowBroadPolicy = resolveScanPolicy(lowBudgetPlan, "broad");
assert.strictEqual(lowBroadPolicy.maxCards, 10);
assert.strictEqual(lowBroadPolicy.maxDetailTotal, 1);
assert.strictEqual(lowBroadPolicy.browserPageBudget, 20);
const filteredLanes = applyScanPolicyToFilters({
  params: { salary: ["405"] },
  labels: { salary: ["10-20K"] },
  lanes: [
    { id: "salary-405", params: { salary: ["405"] }, labels: { salary: ["10-20K"] } },
    { id: "salary-404", params: { salary: ["404"] }, labels: { salary: ["5-10K"] } }
  ]
}, dailyPolicy);
assert.strictEqual(filteredLanes.lanes.length, 2);
assert.deepStrictEqual(filteredLanes.params.salary, ["405"]);
assert.strictEqual(applyScanPolicyToFilters({ lanes: filteredLanes.lanes }, broadPolicy).lanes.length, 2);
const targetSalaryPlan = normalizeSearchPlan({
  ...modePlan,
  salaryMinK: 9,
  salaryMaxK: 14,
  platform: { site: "boss", salaryLanes: ["10-20K"] }
}, profile);
const targetSalaryFilter = resolveNativeFilterSnapshot({
  site: "boss",
  catalog: {
    site: "boss",
    fields: {
      salary: {
        urlParam: "salary",
        selection: "single",
        options: [
          { code: "404", label: "5-10K" },
          { code: "405", label: "10-20K" }
        ]
      }
    }
  },
  plan: targetSalaryPlan
});
assert.deepStrictEqual(targetSalaryPlan.salary, { minK: 9, maxK: 14 });
assert.deepStrictEqual(targetSalaryFilter.params.salary, ["405"]);
const unsupportedCity = validateSearchPlan({ ...plan, cities: ["惠州"] }, profile, { acquisitionMode: "generated" });
assert.strictEqual(unsupportedCity.valid, false);
assert(unsupportedCity.errors.some((item) => item.includes("惠州")));
assert.throws(
  () => assertSearchPlanReady({ plan: { ...plan, cities: ["惠州"] } }, profile, {}, { acquisitionMode: "generated" }),
  /惠州/
);
const noCityPlan = { ...plan, cities: [] };
assert.strictEqual(
  validateSearchPlan(noCityPlan, profile).valid,
  true,
  "legacy plans default to inherited acquisition"
);
assert.strictEqual(
  validateSearchPlan(noCityPlan, profile, { acquisitionMode: "inherited" }).valid,
  true,
  "inherited acquisition reads location from the verified BOSS search page"
);
assert.deepStrictEqual(
  validateSearchPlan(noCityPlan, profile, { acquisitionMode: "generated" }).errors,
  ["至少选择一个目标城市。"],
  "generated acquisition must retain the city requirement"
);
assert.strictEqual(
  validateSearchPlan({
    ...noCityPlan,
    keywords: [{ word: "Python后端", priority: "A" }]
  }, profile, { acquisitionMode: "inherited" }).valid,
  false,
  "inherited acquisition must retain shared keyword safety checks"
);
const generatedV2Plan = {
  ...modePlan,
  acquisitionMode: "generated",
  platform: {
    site: "boss",
    generated: {
      cities: ["深圳"],
      salaryLanes: ["10-20K"],
      experience: ["3-5年（可冲）"],
      jobTypes: ["全职"],
      degrees: ["本科"]
    }
  }
};
assert.strictEqual(validateSearchPlan(generatedV2Plan, profile).valid, true);
assert.deepStrictEqual(resolveScanPolicy(generatedV2Plan, "broad").snapshot.platform, {
  site: "boss",
  generated: generatedV2Plan.platform.generated
});
assert.strictEqual(resolveScanPolicy(generatedV2Plan, "broad").snapshot.acquisitionMode, "generated");
assert.throws(() => assertSearchPlanReady({ plan }, profile, { stale: true }), /旧画像/);
assert.strictEqual(assertSearchPlanReady({ plan }, profile).valid, true);
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
}, profile, { ...plan, acquisitionMode: "generated", bossActiveDays: 30, allowExperienceStretch: false });
assert.strictEqual(runtime.scoring.boss_activity.max_active_days, 3);
assert.strictEqual(runtime.scoring.allowExperienceStretch, false);
assert(!runtime.scoring.risk_rules.some((item) => item.word === "模型训练"), "通用运行时不应继承单一候选人的硬编码技术排除规则");
assert.deepStrictEqual(runtime.scoring.experience.selected, ["0-3年", "1-3年"]);
assert.strictEqual(runtime.scoring.salary.mode, "strict");
const generatedRuntime = profileToRuntimeConfigs({
  profile: { location: {} },
  scoring: {},
  resumeVersions: { versions: [] }
}, profile, generatedV2Plan);
assert.deepStrictEqual(generatedRuntime.profile.location.target_cities, ["深圳"]);
assert.strictEqual(generatedRuntime.profile.location.default_city, "深圳");
assert.deepStrictEqual(generatedRuntime.scoring.experience.selected, ["3-5年（可冲）"]);

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

  const ecommerceProfile = {
    candidate: { name: "运营候选人", city: "广州", targetTitles: ["电商运营"] },
    education: [],
    experiences: [{ organization: "示例电商公司", role: "店铺运营", type: "全职", highlights: ["负责淘宝店铺活动和投放 ROI 复盘"] }],
    skills: [{ name: "活动复盘", level: "resume" }],
    projects: [],
    credentials: [],
    strengths: []
  };
  let cardInput = null;
  const cardAdapter = {
    async buildCandidateMatchCard(input) {
      cardInput = input;
      return {
        targetDirections: ["电商运营"],
        strongEvidence: [{ label: "店铺活动与 ROI 复盘", evidence: "简历：负责淘宝店铺活动和投放 ROI 复盘" }],
        transferableCapabilities: [{ label: "平台运营数据分析", evidence: "简历：按周复盘店铺转化数据", limitation: "未证明抖音投流经验" }],
        cautionTransitions: [{ direction: "直播操盘", reason: "简历未证明直播间统筹" }]
      };
    }
  };
  const card = await buildCandidateMatchCard({ modelConfig: { provider: "mock", providers: { mock: {} } }, profile: ecommerceProfile, adapter: cardAdapter });
  assert(cardInput && cardInput.candidateProfile, "buildCandidateMatchCard 必须收到 candidateProfile");
  assert.strictEqual(cardInput.resumeText, undefined, "buildCandidateMatchCard 不得收到原始简历正文");
  assert.deepStrictEqual(card.targetDirections, ["电商运营"]);
  assert.deepStrictEqual(card.strongEvidence, [{
    label: "店铺活动与 ROI 复盘",
    evidence: "简历：负责淘宝店铺活动和投放 ROI 复盘"
  }]);
  assert.strictEqual(card.transferableCapabilities[0].limitation, "未证明抖音投流经验");
  assert.strictEqual(card.source, "model");
  assert.throws(() => validateModelResult("buildCandidateMatchCard", {
    targetDirections: ["电商运营"], strongEvidence: [{ label: "虚构", evidence: "" }]
  }), ModelContractError);

  const mockCard = await buildCandidateMatchCard({ modelConfig: { provider: "mock", providers: { mock: {} } }, profile: ecommerceProfile });
  assert.deepStrictEqual(mockCard.targetDirections, ["电商运营"]);
  assert(mockCard.strongEvidence.length >= 1, "mock 必须从候选人已有事实产生证据");
  assert(JSON.stringify(mockCard).includes("淘宝"), "mock 证据必须来自候选人事实");
  assert(!/Python|RAG|Agent|后端/.test(JSON.stringify(mockCard)), "mock 不得默认添加技术方向");
  const emptyCard = await buildCandidateMatchCard({ modelConfig: { provider: "mock", providers: { mock: {} } }, profile: {} });
  assert.deepStrictEqual(emptyCard.targetDirections, []);
  assert.deepStrictEqual(emptyCard.strongEvidence, []);
  console.log("profile_quality_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
