const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadConfigs } = require("../src/config");
const { createJobAnalysisRunner, cachedModelCall } = require("../src/core/job_analysis");
const { validateModelResult, ModelContractError, effectiveHardBlockers } = require("../src/core/model_contract");
const { runtimeAnalysisContext } = require("../src/core/analysis_revision");
const { profileToRuntimeConfigs } = require("../src/core/search_plan");
const { scoreJob } = require("../src/core/scoring");
const {
  openDb,
  createBatch,
  upsertJob,
  decisionBucket,
  saveProfileAnalysis,
  saveSearchPlan,
  rescorePlanObservations,
  listReportJobs
} = require("../src/core/storage");

const root = path.resolve(__dirname, "..");
const dbPath = path.join(root, ".runtime", "smoke", `semantic-pipeline-${Date.now()}.sqlite`);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

(async () => {
  try {
    await stableUnderstandingAndCandidateMatchSmoke();
    await contractRepairAndFailureSmoke();
    await pipelineVersionCacheSmoke();
    await roleIntentGuardSmoke();
    matchBoundaryContractSmoke();
    genericPolicySmoke();
    staleAnalysisSmoke();
    assert.strictEqual(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    console.log("semantic_pipeline_smoke ok");
  } finally {
    db.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* no-op */ }
    }
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function stableUnderstandingAndCandidateMatchSmoke() {
  const calls = { understandJob: 0, matchJob: 0, analyzeResume: 0, draftCommunication: 0 };
  let sanitizedSourceSeen = false;
  const analyzer = {
    analyzeResume: async () => { calls.analyzeResume += 1; throw new Error("must not run"); },
    draftCommunication: async () => { calls.draftCommunication += 1; throw new Error("must not run"); },
    understandJob: async (input) => {
      calls.understandJob += 1;
      assert(input.job);
      assert.strictEqual(input.candidateProfile, undefined);
      assert.strictEqual(input.job.score, undefined);
      assert.strictEqual(input.job.risks, undefined);
      assert.strictEqual(input.job.qualityTags, undefined);
      return understanding(input.job.sourceId);
    },
    matchJob: async (input) => {
      calls.matchJob += 1;
      assert(input.candidateProfile);
      assert.strictEqual(input.candidateProfile.candidate.expectedSalary, undefined);
      assert.strictEqual(input.candidateProfile.candidate.adjustableSalary, undefined);
      assert.strictEqual(input.candidateProfile.resumeVersions, undefined);
      if (input.resumeVersions.versions[0].sourceDocument) {
        assert(input.resumeVersions.versions[0].sourceDocument.textExcerpt.includes("广州大学"));
        sanitizedSourceSeen = true;
      }
      assert(!JSON.stringify({ candidateProfile: input.candidateProfile, resumeVersions: input.resumeVersions }).includes("8-12K"));
      assert.strictEqual(Object.hasOwn(input.searchPreferences, "salary"), false);
      assert(input.jobUnderstanding);
      assert(input.jobEvidence);
      assert.strictEqual(input.ruleMatch, undefined);
      assert.strictEqual(input.job, undefined);
      const javaCandidate = input.candidateProfile.skills.some((skill) => (skill.name || skill) === "Java");
      return decision(javaCandidate ? "caution" : "apply", javaCandidate ? "C" : "A", input.candidateProfile.skills[0]?.name || "Python");
    }
  };
  const job = completeJob("shared-understanding");
  const pythonConfigs = configFor(["Python", "RAG"]);
  pythonConfigs.candidateProfile.candidate.expectedSalary = "8-12K";
  pythonConfigs.candidateProfile.resumeVersions = [{ summary: "期望薪资 8-12K" }];
  pythonConfigs.resumeVersions.versions[0].resumeFacts = {
    candidate: { expectedSalary: "8-12K" },
    resumeVersions: [{ summary: "薪资 8-12K" }],
    skills: [{ name: "Python" }]
  };
  pythonConfigs.resumeVersions.versions[0].sourceDocument = { textExcerpt: "广州大学本科，德勤 AI 实习。期望薪资：8-12K" };
  const pythonRunner = createJobAnalysisRunner(pythonConfigs, [], { db, analyzer });
  const javaRunner = createJobAnalysisRunner(configFor(["Java", "Spring Boot"]), [], { db, analyzer });
  const pythonResult = await pythonRunner(job);
  const javaResult = await javaRunner(job);
  assert.strictEqual(calls.understandJob, 1, "同一 JD 的岗位理解应跨候选人复用");
  assert.strictEqual(calls.matchJob, 2, "不同候选人的匹配结论必须分别计算");
  assert.strictEqual(calls.analyzeResume, 0, "岗位扫描不得重新解析空简历");
  assert.strictEqual(calls.draftCommunication, 0, "批量扫描不得生成招呼语");
  assert.strictEqual(sanitizedSourceSeen, true);
  assert.strictEqual(pythonResult.semanticStatus, "complete");
  assert.strictEqual(decisionBucket({ ...job, analysis: pythonResult, qualityTags: [], risks: [] }), "primary");
  assert.strictEqual(decisionBucket({ ...job, analysis: javaResult, qualityTags: [], risks: [] }), "talk");
}

async function contractRepairAndFailureSmoke() {
  let matchCalls = 0;
  const repairing = createJobAnalysisRunner(configFor(["Python", "RAG"]), [], {
    db,
    analyzer: {
      understandJob: async ({ job }) => understanding(job.sourceId),
      matchJob: async (input) => {
        matchCalls += 1;
        if (!input.contractRepair) return { recommendation: "apply", fitLevel: "A", confidence: 0.9 };
        return decision("apply", "A", "Python");
      }
    }
  });
  const repaired = await repairing(completeJob("contract-repair"));
  assert.strictEqual(matchCalls, 2, "证据契约不完整时只允许一次修复请求");
  assert.strictEqual(repaired.semanticStatus, "complete");

  const failing = createJobAnalysisRunner(configFor(["Python"]), [], {
    db,
    analyzer: {
      understandJob: async ({ job }) => understanding(job.sourceId),
      matchJob: async () => { throw Object.assign(new Error("timeout"), { code: "MODEL_TIMEOUT" }); }
    }
  });
  const failed = await failing(completeJob("model-failure"));
  assert.strictEqual(failed.semanticStatus, "failed");
  assert.strictEqual(failed.recommendation, "review");
  assert.strictEqual(decisionBucket({ ...completeJob("model-failure"), analysis: failed, qualityTags: [], risks: [] }), "analysis_pending");

  assert.throws(() => validateModelResult("matchJob", { recommendation: "apply", fitLevel: "A", confidence: 0.9 }), ModelContractError);
}

async function pipelineVersionCacheSmoke() {
  const configs = configFor(["Python"]);
  let runs = 0;
  const run = async () => { runs += 1; return understanding("pipeline-cache"); };
  const input = { job: { sourceId: "pipeline-cache", description: "Python RAG" } };
  await cachedModelCall({ db, configs, kind: "understandJob", pipelineVersion: "test-v1", input, run });
  await cachedModelCall({ db, configs, kind: "understandJob", pipelineVersion: "test-v1", input, run });
  await cachedModelCall({ db, configs, kind: "understandJob", pipelineVersion: "test-v2", input, run });
  assert.strictEqual(runs, 2, "pipelineVersion 变化必须使旧缓存失效");
}

async function roleIntentGuardSmoke() {
  const analyzer = {
    understandJob: async ({ job }) => ({
      ...understanding(job.sourceId),
      realRoleType: "implementation_presales",
      businessScenario: "企业 AI 方案交付"
    }),
    matchJob: async () => decision("apply", "A", "Python/RAG 项目")
  };
  const job = completeJob("solution-role");
  const developerResult = await createJobAnalysisRunner(configFor(["Python", "RAG"]), [], { db, analyzer })(job);
  assert.strictEqual(developerResult.recommendation, "caution");
  assert.strictEqual(developerResult.decisionSource, "candidate_direction_guard");

  const solutionConfigs = configFor(["Python", "RAG"]);
  solutionConfigs.candidateProfile = profile(["Python", "RAG"], ["AI解决方案工程师"]);
  solutionConfigs.searchPlan = plan(["AI解决方案工程师"]);
  solutionConfigs.analysisContext = runtimeAnalysisContext(solutionConfigs.candidateProfile, solutionConfigs.searchPlan);
  const solutionResult = await createJobAnalysisRunner(solutionConfigs, [], { db, analyzer })(job);
  assert.strictEqual(solutionResult.recommendation, "apply");

  const stretchAnalyzer = {
    understandJob: async ({ job: sourceJob }) => understanding(sourceJob.sourceId),
    matchJob: async () => decision("apply", "A", "Python/RAG 项目")
  };
  const stretchResult = await createJobAnalysisRunner(configFor(["Python", "RAG"]), [], { db, analyzer: stretchAnalyzer })(completeJob("experience-stretch", {
    experience: "3-5年",
    qualityTags: ["experience_stretch"]
  }));
  assert.strictEqual(stretchResult.recommendation, "caution");
  assert.strictEqual(stretchResult.decisionSource, "experience_stretch_guard");

  const riskAnalyzer = {
    understandJob: async ({ job: sourceJob }) => ({
      ...understanding(sourceJob.sourceId),
      hiddenRisks: [{ type: "outsourcing", severity: "high", evidence: "由技术服务公司派驻客户项目" }]
    }),
    matchJob: async () => decision("apply", "A", "Python/RAG 项目")
  };
  const riskResult = await createJobAnalysisRunner(configFor(["Python", "RAG"]), [], { db, analyzer: riskAnalyzer })(completeJob("outsourcing-risk"));
  assert.strictEqual(riskResult.recommendation, "caution");
  assert.strictEqual(riskResult.decisionSource, "semantic_risk_guard");
}

function matchBoundaryContractSmoke() {
  const soft = validateModelResult("matchJob", {
    recommendation: "caution",
    fitLevel: "B",
    confidence: 0.8,
    fitReasons: ["核心职责与 Python/RAG 项目匹配"],
    hardBlockers: [],
    softGaps: ["岗位写 3-5 年，候选人企业经历年限较短"],
    questionsToVerify: ["确认年限要求是否可放宽"],
    evidence: { jd: ["负责 RAG 应用开发，要求 3-5 年"], resume: ["具备 Python/RAG 项目经验"] }
  });
  assert.deepStrictEqual(soft.hardBlockers, []);
  assert.strictEqual(soft.blockingGaps.length, 0);
  assert.strictEqual(soft.missingPoints.length, 1);
  assert.throws(() => validateModelResult("matchJob", {
    recommendation: "skip",
    fitLevel: "D",
    confidence: 0.7,
    fitReasons: ["经验年限存在差距"],
    hardBlockers: [],
    softGaps: ["未达到 3-5 年"],
    evidence: { jd: ["要求 3-5 年"], resume: ["企业经历较短"] }
  }), ModelContractError);
  const hard = validateModelResult("matchJob", {
    recommendation: "skip",
    fitLevel: "D",
    confidence: 0.9,
    fitReasons: ["岗位核心语言与候选人主栈不一致"],
    hardBlockers: ["岗位核心要求 C++，候选人无 C++ 项目证据"],
    softGaps: [],
    questionsToVerify: [],
    evidence: { jd: ["必须熟练掌握 C++"], resume: ["候选人主栈为 Python/FastAPI"] }
  });
  assert.strictEqual(hard.hardBlockers.length, 1);
  const downgraded = validateModelResult("matchJob", {
    recommendation: "skip",
    fitLevel: "D",
    confidence: 0.8,
    fitReasons: ["岗位年限要求高于候选人当前企业经历"],
    hardBlockers: ["岗位要求 3-5 年经验，候选人当前企业经验年限不足"],
    softGaps: [],
    questionsToVerify: ["确认年限要求是否可放宽"],
    evidence: { jd: ["要求 3-5 年经验"], resume: ["候选人具备相关实习与独立项目经验"] }
  });
  assert.strictEqual(downgraded.recommendation, "caution");
  assert.strictEqual(downgraded.fitLevel, "C");
  assert.deepStrictEqual(downgraded.hardBlockers, []);
  assert.strictEqual(downgraded.softGaps.length, 1);
  assert.deepStrictEqual(effectiveHardBlockers({ hardBlockers: ["岗位要求 3-5 年经验，候选人经验不足"] }), []);
  assert.deepStrictEqual(effectiveHardBlockers({ blockingGaps: ["3-5年经验不足", "学历偏好为 985", "未提供 RPA 经验"] }), []);
  assert.deepStrictEqual(effectiveHardBlockers({ blockingGaps: ["完全缺少岗位核心 Java/Spring 经历"] }), ["完全缺少岗位核心 Java/Spring 经历"]);
}

function genericPolicySmoke() {
  const base = loadConfigs(root);
  const javaProfile = profile(["Java", "Spring Boot"], ["Java后端工程师"]);
  const javaConfigs = profileToRuntimeConfigs(base, javaProfile, plan(["Java后端工程师"]), []);
  const javaScore = scoreJob(completeJob("java-generic", {
    title: "Java后端工程师",
    tags: ["Java", "Spring Boot"],
    description: "任职要求：熟练掌握 Java 和 Spring Boot，负责后端服务开发。".repeat(4)
  }), javaConfigs);
  assert(!javaScore.qualityTags.includes("java_backend_heavy"));
  assert(!javaScore.risks.some((risk) => /Java占比|Spring占比/.test(risk)));

  const algorithmProfile = profile(["Python", "PyTorch"], ["算法工程师"]);
  const algorithmConfigs = profileToRuntimeConfigs(base, algorithmProfile, plan(["算法工程师"]), []);
  const algorithmScore = scoreJob(completeJob("algorithm-generic", {
    title: "NLP算法工程师",
    tags: ["Python", "PyTorch", "模型训练"],
    description: "负责自然语言处理算法、模型训练和算法工程化。".repeat(5)
  }), algorithmConfigs);
  assert(!algorithmScore.qualityTags.includes("algorithm_role"));

  const internPlan = { ...plan(["Python开发工程师"]), jobTypes: ["实习"] };
  const internConfigs = profileToRuntimeConfigs(base, profile(["Python"], ["Python开发工程师"]), internPlan, []);
  const internScore = scoreJob(completeJob("intern-generic", { title: "Python开发实习生" }), internConfigs);
  assert(!internScore.qualityTags.includes("internship_role"));
}

function staleAnalysisSmoke() {
  const candidate = profile(["Python", "RAG"], ["AI应用开发"]);
  const initialPlan = plan(["AI应用开发"]);
  const { profileId, planId } = saveProfileAnalysis(db, {
    profile: candidate,
    document: { originalFileName: "semantic.txt", format: "text", contentHash: "semantic-profile", text: "semantic profile", diagnostics: {} },
    searchPlan: initialPlan
  });
  const configs = profileToRuntimeConfigs(loadConfigs(root), candidate, initialPlan, []);
  const source = completeJob("stale-analysis");
  const analysis = {
    ...decision("apply", "A", "Python"),
    provider: "openai_compatible",
    model: "test-model",
    semanticStatus: "complete",
    decisionSource: "model",
    revision: {
      ...runtimeAnalysisContext(candidate, initialPlan),
      sourceContentHash: require("../src/core/storage").sourceContentHash(source),
      pipelineVersions: require("../src/core/analysis_revision").PIPELINE_VERSIONS
    }
  };
  const batchId = createBatch(db, "boss", "stale", "stale-test", { profileId, searchPlanId: planId });
  upsertJob(db, { ...source, score: 20, level: "优先", matches: [], risks: [], qualityTags: [], analysis }, batchId);
  const changedPlan = { ...initialPlan, salary: { minK: 15, maxK: 25 } };
  saveSearchPlan(db, { id: planId, profileId, plan: changedPlan });
  const changedConfigs = profileToRuntimeConfigs(loadConfigs(root), candidate, changedPlan, []);
  rescorePlanObservations(db, { planId, configs: changedConfigs });
  const salaryChanged = listReportJobs(db, { planId, limit: 100 }).find((job) => job.sourceId === "stale-analysis");
  assert.strictEqual(salaryChanged.analysis.semanticStatus, "complete");
  assert.notStrictEqual(salaryChanged.decisionBucket, "analysis_pending");
  assert.deepStrictEqual(configs.analysisContext, changedConfigs.analysisContext);

  const directionPlan = { ...changedPlan, directions: ["AI解决方案"] };
  saveSearchPlan(db, { id: planId, profileId, plan: directionPlan });
  const directionConfigs = profileToRuntimeConfigs(loadConfigs(root), candidate, directionPlan, []);
  rescorePlanObservations(db, { planId, configs: directionConfigs });
  const directionChanged = listReportJobs(db, { planId, limit: 100 }).find((job) => job.sourceId === "stale-analysis");
  assert.strictEqual(directionChanged.analysis.semanticStatus, "stale");
  assert(directionChanged.analysis.staleReasons.includes("search_plan_changed"));
  assert.strictEqual(directionChanged.decisionBucket, "analysis_pending");
  assert.notDeepStrictEqual(configs.analysisContext, directionConfigs.analysisContext);
}

function configFor(skills) {
  const candidateProfile = profile(skills, ["AI应用开发"]);
  const searchPlan = plan(["AI应用开发"]);
  return {
    model: { provider: "openai_compatible", providers: { openai_compatible: { model: "test-model" } } },
    candidateProfile,
    searchPlan,
    analysisContext: runtimeAnalysisContext(candidateProfile, searchPlan),
    resumeVersions: { versions: [{ id: "main", name: "主简历", primaryProjects: ["KnowledgeFlow"], keywords: skills }] },
    profile: { location: { target_cities: ["广州"] } },
    scoring: { boss_activity: { max_active_days: 3 }, salary: {}, experience: {}, risk_rules: [], exclude_words: [] }
  };
}

function profile(skills, targetTitles) {
  return {
    candidate: { name: "Semantic Candidate", city: "广州", targetTitles, expectedSalary: "10-20K" },
    skills: skills.map((name) => ({ name, level: "resume", evidence: [name] })),
    projects: [{ name: "KnowledgeFlow", roleBoundary: "独立项目", canSay: skills, avoidSaying: [] }]
  };
}

function plan(directions) {
  return {
    name: "Semantic Plan",
    cities: ["广州"],
    salary: { minK: 10, maxK: 20 },
    experience: ["经验不限", "1-3年", "3-5年（可冲）"],
    jobTypes: ["全职"],
    directions,
    keywords: directions.map((word) => ({ word, priority: "A", reason: "test" })),
    bossActiveDays: 3
  };
}

function completeJob(sourceId, overrides = {}) {
  return {
    source: "boss",
    sourceId,
    title: "AI应用开发工程师",
    company: "Semantic Corp",
    location: "广州",
    salary: "10-18K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
    tags: ["Python", "RAG", "Agent"],
    description: "任职要求：熟练使用 Python，负责 RAG 知识库和 Agent 应用开发；需要完成接口联调、检索优化与质量评估。".repeat(4),
    detailRead: true,
    detailRequired: true,
    qualityTags: [],
    risks: [],
    ...overrides
  };
}

function understanding(jobId) {
  return {
    jobId,
    realRoleType: "ai_application",
    businessScenario: "企业知识库",
    coreRequirements: ["Python", "RAG"],
    niceToHave: ["Agent"],
    senioritySignal: "junior",
    hiddenRisks: [],
    evidenceSnippets: ["熟练使用 Python，负责 RAG 知识库和 Agent 应用开发"]
  };
}

function decision(recommendation, fitLevel, resumeEvidence) {
  return {
    recommendation,
    fitLevel,
    confidence: 0.88,
    fitReasons: ["岗位核心职责与候选人的 Python/RAG 项目经验对应"],
    missingPoints: [],
    riskQuestions: [],
    recommendedResumeVersion: "main",
    primaryProjects: ["KnowledgeFlow"],
    greetingAngle: "围绕 RAG 项目切入",
    evidence: {
      jd: ["负责 RAG 知识库和 Agent 应用开发"],
      resume: [resumeEvidence]
    }
  };
}
