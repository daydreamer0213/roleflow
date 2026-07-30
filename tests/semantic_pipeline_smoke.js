const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadConfigs } = require("../src/config");
const { createJobAnalysisRunner, cachedModelCall, applyRuleGuard, compactAnalysis, createRuleOnlyAnalysis } = require("../src/core/job_analysis");
const { createLlmAnalyzer } = require("../src/core/llm_analyzer");
const { MockModelAdapter } = require("../src/adapters/models/mock");
const {
  validateModelResult: validateModelResultRaw,
  ModelContractError,
  effectiveHardBlockers,
  decisionHardBlockers,
  roleCoreEvidenceState,
  roleEvidenceDecisionState,
  requirementsForTrack
} = require("../src/core/model_contract");

function legacyFullTestContext(value) {
  const requirements = Array.isArray(value?.requirementMatches)
    ? value.requirementMatches.map((item) => ({
      label: item?.requirement || "测试核心要求",
      foundation: Boolean(item?.foundation),
      central: typeof item?.central === "boolean" ? item.central : Boolean(item?.indispensable),
      indispensable: Boolean(item?.indispensable),
      evidence: item?.jdEvidence || "JD：测试核心要求"
    }))
    : [];
  return {
    roleSummary: "测试单轨岗位",
    responsibilityEvidence: ["JD：测试岗位职责"],
    coreRequirements: requirements,
    jobQuality: value?.jobQuality || { level: "normal", concerns: [] }
  };
}

function validateModelResult(kind, value, context) {
  const evidenceShape = Object.prototype.hasOwnProperty.call(value || {}, "matches")
    || Object.prototype.hasOwnProperty.call(value || {}, "eligibility")
    || Object.prototype.hasOwnProperty.call(value || {}, "certainty");
  if (kind !== "matchJob" || context !== undefined || evidenceShape) {
    return validateModelResultRaw(kind, value, context);
  }
  return validateModelResultRaw(kind, value, { jobUnderstanding: legacyFullTestContext(value) });
}
const { runtimeAnalysisContext, analysisStaleReasons, PIPELINE_VERSIONS } = require("../src/core/analysis_revision");
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
    await initialFailureProvenanceSmoke();
    await pipelineVersionCacheSmoke();
    await compactRoleEvidencePersistenceSmoke();
    await ruleGuardSmoke();
    await localEvidenceGuardSmoke();
    await matchingCardContractSmoke();
    await mockResponsibilityEvidenceNormalizationSmoke();
    await mockRoleAlignmentSmoke();
    await genericEvidenceContractSmoke();
    matchGenericContractSmoke();
    matchBoundaryContractSmoke();
    genericPolicySmoke();
    staleAnalysisSmoke();
    matchingCardStaleSmoke();
    runtimeResumeVersionEntrySmoke();
    understandingContractSmoke();
    matchUnderstandingAlignmentSmoke();
    compactResponsibilityFoundationContractSmoke();
    compactCentralRequirementSmoke();
    roleCentralBucketSmoke();
    roleEvidenceDecisionStateSmoke();
    await compactMatchEvidenceContractSmoke();
    roleAlignmentEvidenceContractSmoke();
    await understandingContractRepairSmoke();
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

function runtimeResumeVersionEntrySmoke() {
  // 源码级约束：扫描、补读、工作流、分析重试、reassess、rescore 必须共用安全简历版本入口；
  // 未过滤的完整列表只允许出现在沟通草稿与简历版本管理界面。
  for (const relative of ["src/cli.js", "src/dashboard/server.js"]) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert(source.includes("listMatchingResumeVersions"), `${relative} 必须使用安全简历版本入口`);
    assert(!/profileToRuntimeConfigs\([^;]*listCandidateResumeVersions/.test(source), `${relative} 的运行时 configs 不得直接使用未过滤的简历版本列表`);
  }
}

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
      assert.strictEqual(Object.hasOwn(input, "resumeVersions"), false, "matchJob input must not repeat resume versions");
      assert.strictEqual(Object.hasOwn(input, "jobEvidence"), false, "matchJob input must not repeat raw JD evidence");
      assert(!JSON.stringify(input.candidateProfile).includes("8-12K"));
      assert.strictEqual(Object.hasOwn(input.searchPreferences, "salary"), false);
      assert(input.jobUnderstanding);
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
  assert.strictEqual(sanitizedSourceSeen, false);
  assert.strictEqual(pythonResult.semanticStatus, "complete");
  assert.strictEqual(decisionBucket({ ...job, analysis: pythonResult, qualityTags: [], risks: [] }), "primary");
  assert.strictEqual(decisionBucket({ ...job, analysis: javaResult, qualityTags: [], risks: [] }), "talk");
}

async function mockResponsibilityEvidenceNormalizationSmoke() {
  const rawUnderstanding = await new MockModelAdapter().understandJob({
    job: {
      sourceId: "mock-responsibility-evidence",
      title: "企业系统开发",
      description: "负责企业业务系统前后端开发、联调与上线。"
    }
  });
  assert(rawUnderstanding.responsibilityEvidence.length > 0, "Mock 必须先输出职责证据");

  const normalized = validateModelResult("understandJob", rawUnderstanding);
  assert.deepStrictEqual(normalized.responsibilityEvidence, rawUnderstanding.responsibilityEvidence,
    "Mock 的职责证据必须在历史 JobUnderstanding 归一化后保留");
}

async function mockRoleAlignmentSmoke() {
  const adapter = new MockModelAdapter();
  const decision = await adapter.matchJob({
    resumeVersions: [],
    jobUnderstanding: {
      responsibilityEvidence: ["JD：负责企业系统交付"],
      coreRequirements: [],
      jobQuality: { level: "normal", concerns: [] }
    }
  });
  assert.strictEqual(decision.roleAlignment, "insufficient_evidence");
  assert.deepStrictEqual(decision.roleResumeEvidence, []);
  assert(decision.roleGaps[0].includes("Mock"), "offline Mock must label the deterministic evidence gap");
}

async function genericEvidenceContractSmoke() {
  let seenMatchInput = null;
  const analyzer = {
    understandJob: async (input) => {
      assert(input.job, "understandJob 输入仍应只有 JD facts");
      assert.strictEqual(input.candidateProfile, undefined);
      assert.strictEqual(input.candidateMatchCard, undefined);
      return {
        jobId: input.job.sourceId,
        roleSummary: "负责抖音店铺经营、活动与投放复盘",
        coreResponsibilities: [{ label: "店铺活动运营", evidence: "JD：负责抖音店铺活动与投放复盘" }],
        coreRequirements: [{ label: "投放与 ROI 分析", indispensable: true, evidence: "JD：必须独立完成投放 ROI 复盘" }],
        preferredRequirements: [{ label: "抖音店铺经验", evidence: "JD：有抖音店铺经验优先" }],
        outcomeExpectations: [],
        jobQuality: { level: "caution", concerns: [{ type: "responsibility_sprawl", evidence: "JD 同时要求直播、拍摄、剪辑" }] },
        hiddenRisks: [],
        evidenceSnippets: ["JD：负责抖音店铺投放与复盘"]
      };
    },
    matchJob: async (input) => {
      seenMatchInput = input;
      assert(input.candidateMatchCard, "matchJob 输入必须携带已确认匹配卡");
      assert.strictEqual(input.candidateMatchCard.targetDirections[0], "电商运营");
      return {
        recommendation: "apply",
        fitLevel: "A",
        confidence: 0.84,
        fitReasons: ["投放 ROI 复盘经验可从淘宝店铺迁移到抖音店铺"],
        requirementMatches: [{
          requirement: "投放与 ROI 分析",
          state: "transferable",
          indispensable: true,
          jdEvidence: "JD：负责抖音店铺投放与复盘",
          resumeEvidence: "简历：负责淘宝店铺投放 ROI 复盘"
        }],
        jobQuality: { level: "caution", concerns: [{ type: "responsibility_sprawl", evidence: "JD 同时要求直播、拍摄、剪辑" }] },
        hardBlockers: [],
        softGaps: [],
        questionsToVerify: [],
        recommendedResumeVersion: "main",
        primaryProjects: ["店铺投放复盘"],
        greetingAngle: "",
        evidence: {
          jd: ["JD：负责抖音店铺投放与复盘"],
          resume: ["简历：负责淘宝店铺投放 ROI 复盘"]
        }
      };
    }
  };
  const configs = configFor(["店铺运营", "投放复盘"]);
  configs.candidateProfile = {
    candidate: { name: "电商候选人", city: "广州", targetTitles: ["电商运营"] },
    experiences: [{ organization: "示例店铺", role: "店铺运营", highlights: ["负责淘宝店铺投放 ROI 复盘"] }],
    skills: [{ name: "店铺运营", level: "resume", evidence: ["示例店铺"] }],
    projects: []
  };
  configs.matchingCard = {
    targetDirections: ["电商运营"],
    strongEvidence: [{ label: "店铺投放复盘", evidence: "简历：负责淘宝店铺投放 ROI 复盘" }],
    transferableCapabilities: [{ label: "跨平台投放", evidence: "简历：负责淘宝店铺投放 ROI 复盘", limitation: "未证明抖音投流经验" }],
    cautionTransitions: [],
    userNotes: [],
    source: "user"
  };
  configs.analysisContext = runtimeAnalysisContext(configs.candidateProfile, configs.searchPlan, configs.matchingCard);
  const runner = createJobAnalysisRunner(configs, [], { db, analyzer });
  const result = await runner(completeJob("douyin-shop", {
    title: "抖音店铺运营",
    tags: ["电商运营"],
    description: "负责抖音店铺投放与复盘，同时要求直播、拍摄、剪辑。".repeat(4)
  }));
  assert(seenMatchInput, "matchJob 未被调用");
  assert.strictEqual(result.requirementMatches[0].state, "transferable");
  assert.strictEqual(result.jobQuality.level, "caution");
  assert.strictEqual(result.recommendation, "caution", "transferable 核心项与 caution 岗位质量必须把 apply 降为 caution");
  assert.deepStrictEqual(result.evidence, {
    jd: ["JD：负责抖音店铺投放与复盘"],
    resume: ["简历：负责淘宝店铺投放 ROI 复盘"]
  });
  assert.strictEqual(result.semanticStatus, "complete");
}

function matchGenericContractSmoke() {
  const validApply = {
    recommendation: "apply",
    fitLevel: "A",
    confidence: 0.86,
    fitReasons: ["核心要求与简历证据对应"],
    requirementMatches: [{
      requirement: "投放与 ROI 分析",
      state: "matched",
      indispensable: true,
      jdEvidence: "JD：必须独立完成投放 ROI 复盘",
      resumeEvidence: "简历：负责淘宝店铺投放 ROI 复盘"
    }],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [],
    softGaps: [],
    questionsToVerify: [],
    evidence: { jd: ["JD：必须独立完成投放 ROI 复盘"], resume: ["简历：负责淘宝店铺投放 ROI 复盘"] }
  };
  const applyValidated = validateModelResult("matchJob", validApply);
  assert.strictEqual(applyValidated.recommendation, "apply");
  assert.strictEqual(applyValidated.requirementMatches[0].state, "matched");

  assert.throws(() => validateModelResult("matchJob", {
    ...validApply,
    requirementMatches: [{ ...validApply.requirementMatches[0], jdEvidence: "" }]
  }), (error) => error instanceof ModelContractError && /候选人证据|JD 与候选人证据|双侧证据|逐项匹配/.test(error.message));

  assert.throws(() => validateModelResult("matchJob", {
    ...validApply,
    evidence: { jd: ["JD：必须独立完成投放 ROI 复盘"], resume: [] }
  }), ModelContractError);
  assert.throws(() => validateModelResult("matchJob", {
    ...validApply,
    evidence: { jd: [{}], resume: [{}] }
  }), (error) => error instanceof ModelContractError && /evidence/.test(error.message),
  "对象不得被转成 [object Object] 伪装成双侧证据");

  assert.throws(() => validateModelResult("matchJob", {
    ...validApply,
    requirementMatches: [{ ...validApply.requirementMatches[0], state: "missing" }]
  }), (error) => error instanceof ModelContractError && /apply/.test(error.message));

  assert.throws(() => validateModelResult("matchJob", {
    ...validApply,
    jobQuality: { level: "risk", concerns: [{ type: "fee_fraud", evidence: "JD 要求先交培训费" }] }
  }), ModelContractError);

  // 契约收紧：非法 state、非法或缺失的 jobQuality.level、越界 confidence 一律抛 ModelContractError 走契约修复，不再静默修正。
  assert.throws(() => validateModelResult("matchJob", {
    ...validApply,
    requirementMatches: [{ ...validApply.requirementMatches[0], state: "partially_matched" }]
  }), (error) => error instanceof ModelContractError && /state/.test(error.message), "非法 requirementMatches.state 不得静默改成 unknown");

  assert.throws(() => validateModelResult("matchJob", {
    ...validApply,
    jobQuality: { level: "cautionn", concerns: [] }
  }), (error) => error instanceof ModelContractError && /jobQuality\.level/.test(error.message), "拼错的 jobQuality.level 不得默认 normal");

  assert.throws(() => validateModelResult("matchJob", {
    ...validApply,
    jobQuality: { concerns: [] }
  }), (error) => error instanceof ModelContractError && /jobQuality\.level/.test(error.message), "缺失 jobQuality.level 不得默认 normal");

  for (const outOfRange of [-0.1, 1.1]) {
    assert.throws(() => validateModelResult("matchJob", { ...validApply, confidence: outOfRange }),
      (error) => error instanceof ModelContractError && /confidence/.test(error.message), `confidence=${outOfRange} 越界必须抛错，不得 clamp`);
  }

  // apply 的每一条核心必备项都必须是 matched：unknown/not_applicable 不得保持 apply，transferable 仍自动降为 caution。
  assert.throws(() => validateModelResult("matchJob", {
    ...validApply,
    requirementMatches: [{ ...validApply.requirementMatches[0], state: "unknown" }]
  }), (error) => error instanceof ModelContractError && /apply/.test(error.message), "核心必备项 unknown 不得保持 apply");

  assert.throws(() => validateModelResult("matchJob", {
    ...validApply,
    requirementMatches: [{ ...validApply.requirementMatches[0], state: "not_applicable" }]
  }), (error) => error instanceof ModelContractError && /apply/.test(error.message), "核心必备项 not_applicable 不得保持 apply");

  const demoted = validateModelResult("matchJob", {
    ...validApply,
    requirementMatches: [{ ...validApply.requirementMatches[0], state: "transferable" }]
  });
  assert.strictEqual(demoted.recommendation, "caution", "transferable 核心项必须把 apply 降为 caution");
  assert.strictEqual(demoted.fitLevel, "B");

  const demotedByQuality = validateModelResult("matchJob", {
    ...validApply,
    jobQuality: { level: "caution", concerns: [{ type: "responsibility_sprawl", evidence: "JD 同时要求直播、拍摄、剪辑" }] }
  });
  assert.strictEqual(demotedByQuality.recommendation, "caution", "caution 岗位质量必须把 apply 降为 caution");

  const validSkip = {
    recommendation: "skip",
    fitLevel: "D",
    confidence: 0.9,
    fitReasons: ["候选人明确拒绝岗位核心技术方向"],
    requirementMatches: [{
      requirement: "JAVA 核心开发",
      state: "missing",
      indispensable: true,
      jdEvidence: "JD：必须精通 Java 与 Spring Boot",
      resumeEvidence: "简历：候选人明确不接受 Java 开发岗位"
    }],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [{
      kind: "indispensable_core",
      requirement: "JAVA 核心开发",
      jdEvidence: "JD：必须精通 Java 与 Spring Boot",
      resumeEvidence: "简历：候选人明确不接受 Java 开发岗位"
    }],
    softGaps: [],
    questionsToVerify: [],
    evidence: { jd: ["JD：必须精通 Java 与 Spring Boot"], resume: ["简历：候选人明确不接受 Java 开发岗位"] }
  };
  const skipValidated = validateModelResult("matchJob", validSkip);
  assert.strictEqual(skipValidated.recommendation, "skip");
  assert.strictEqual(skipValidated.hardBlockers[0].kind, "indispensable_core");
  const missingIndispensableWithoutBlocker = {
    ...validSkip,
    recommendation: "caution",
    requirementMatches: [{
      requirement: "Core platform development",
      state: "missing",
      indispensable: true,
      jdEvidence: "",
      resumeEvidence: ""
    }],
    hardBlockers: [],
    evidence: { jd: ["JD: requires core platform development"], resume: ["Resume: no related experience"] }
  };
  assert.throws(() => validateModelResult("matchJob", missingIndispensableWithoutBlocker),
    (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID",
    "missing indispensable core requirement must have an indispensable_core blocker");

  const repairedMissingIndispensable = validateModelResult("matchJob", {
    ...missingIndispensableWithoutBlocker,
    recommendation: "skip",
    requirementMatches: missingIndispensableWithoutBlocker.requirementMatches.map((item) => ({
      ...item,
      resumeEvidence: "简历：候选人明确不接受核心平台开发"
    })),
    hardBlockers: [{
      kind: "indispensable_core",
      requirement: "Core platform development",
      jdEvidence: "JD: requires core platform development",
      resumeEvidence: "简历：候选人明确不接受核心平台开发"
    }]
  });
  assert.strictEqual(repairedMissingIndispensable.recommendation, "skip");
  assert.throws(() => validateModelResult("matchJob", {
    ...validSkip,
    hardBlockers: [{ ...validSkip.hardBlockers[0], requirement: {}, jdEvidence: 1, resumeEvidence: {} }]
  }), (error) => error instanceof ModelContractError && /hardBlockers/.test(error.message),
  "对象和数字不得被字符串化后伪装成完整 hardBlocker");

  // indispensable_core 阻断必须精确对应同名 missing + indispensable 核心项。
  assert.throws(() => validateModelResult("matchJob", {
    ...validSkip,
    hardBlockers: [{ ...validSkip.hardBlockers[0], requirement: "不存在的核心要求" }]
  }), (error) => error instanceof ModelContractError && /硬性阻断/.test(error.message), "无对应核心项的 indispensable_core 必须拒绝");
  assert.throws(() => validateModelResult("matchJob", {
    ...validSkip,
    requirementMatches: [{ ...validSkip.requirementMatches[0], state: "matched" }]
  }), (error) => error instanceof ModelContractError && /硬性阻断/.test(error.message), "对应项为 matched 时 indispensable_core 必须拒绝");
  assert.throws(() => validateModelResult("matchJob", {
    ...validSkip,
    requirementMatches: [{ ...validSkip.requirementMatches[0], state: "unknown" }]
  }), (error) => error instanceof ModelContractError && /硬性阻断/.test(error.message), "对应项为 unknown 时 indispensable_core 必须拒绝");

  assert.throws(() => validateModelResult("matchJob", {
    ...validSkip,
    requirementMatches: [{ ...validSkip.requirementMatches[0], indispensable: false }]
  }), (error) => error instanceof ModelContractError && /非核心|硬性阻断/.test(error.message));

  assert.throws(() => validateModelResult("matchJob", {
    ...validSkip,
    hardBlockers: [{ ...validSkip.hardBlockers[0], kind: "salary_mismatch" }]
  }), (error) => error instanceof ModelContractError && /kind/.test(error.message));

  assert.throws(() => validateModelResult("matchJob", {
    ...validSkip,
    hardBlockers: [{ ...validSkip.hardBlockers[0], resumeEvidence: "" }]
  }), (error) => error instanceof ModelContractError && /证据/.test(error.message));

  assert.throws(() => validateModelResult("matchJob", {
    ...validSkip,
    hardBlockers: ["岗位要求 Java，候选人无 Java 项目证据"]
  }), (error) => error instanceof ModelContractError && /结构化|对象/.test(error.message));

  assert.throws(() => validateModelResult("matchJob", {
    recommendation: "review",
    fitLevel: "C",
    confidence: 0.5,
    fitReasons: [],
    requirementMatches: [{
      requirement: "投放与 ROI 分析",
      state: "matched",
      indispensable: true,
      jdEvidence: "JD：必须独立完成投放 ROI 复盘",
      resumeEvidence: "简历：负责淘宝店铺投放 ROI 复盘"
    }],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [],
    softGaps: [],
    questionsToVerify: [],
    evidence: { jd: ["JD：必须独立完成投放 ROI 复盘"], resume: ["简历：负责淘宝店铺投放 ROI 复盘"] }
  }), (error) => error instanceof ModelContractError && /review/.test(error.message));

  const reviewValidated = validateModelResult("matchJob", {
    recommendation: "review",
    fitLevel: "C",
    confidence: 0.5,
    fitReasons: [],
    requirementMatches: [{
      requirement: "投放与 ROI 分析",
      state: "unknown",
      indispensable: true,
      jdEvidence: "JD：必须独立完成投放 ROI 复盘",
      resumeEvidence: ""
    }],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [],
    softGaps: ["JD 未说明投放平台与考核口径"],
    questionsToVerify: [],
    evidence: { jd: ["JD：必须独立完成投放 ROI 复盘"], resume: [] }
  });
  assert.strictEqual(reviewValidated.recommendation, "review");
}

function matchingCardStaleSmoke() {
  const candidate = profile(["Python", "RAG"], ["AI应用开发"]);
  const searchPlan = plan(["AI应用开发"]);
  const cardV1 = {
    targetDirections: ["电商运营"],
    strongEvidence: [{ label: "店铺复盘", evidence: "简历：负责淘宝店铺复盘" }],
    transferableCapabilities: [],
    cautionTransitions: [],
    userNotes: [],
    source: "user"
  };
  const cardV2 = { ...cardV1, targetDirections: ["内容运营"] };
  const ctxV1 = runtimeAnalysisContext(candidate, searchPlan, cardV1);
  const ctxV2 = runtimeAnalysisContext(candidate, searchPlan, cardV2);
  assert(ctxV1.matchingCardVersion, "带卡上下文必须产出 matchingCardVersion");
  assert.notStrictEqual(ctxV1.matchingCardVersion, ctxV2.matchingCardVersion);
  const reasons = analysisStaleReasons({
    revision: { ...ctxV1, sourceContentHash: "hash-x", pipelineVersions: PIPELINE_VERSIONS }
  }, { ...ctxV2, sourceContentHash: "hash-x", pipelineVersions: PIPELINE_VERSIONS });
  assert.deepStrictEqual(reasons, ["matching_card_changed"], "卡修订变化只能使 matchJob 分析陈旧");
  const legacyReasons = analysisStaleReasons({
    revision: { profileVersion: ctxV1.profileVersion, searchPlanVersion: ctxV1.searchPlanVersion, sourceContentHash: "hash-x", pipelineVersions: PIPELINE_VERSIONS }
  }, { ...ctxV1, sourceContentHash: "hash-x", pipelineVersions: PIPELINE_VERSIONS });
  assert(!legacyReasons.includes("matching_card_changed"), "历史无卡修订记录不得被误判为卡变化");
}

async function matchingCardContractSmoke() {
  const invalidCard = {
    targetDirections: ["电商运营"],
    strongEvidence: [{ label: "虚构经历", evidence: "" }]
  };
  const analyzer = createLlmAnalyzer({ adapter: { buildCandidateMatchCard: async () => invalidCard } });
  await assert.rejects(
    analyzer.buildCandidateMatchCard({
      candidateProfile: {
        candidate: { name: "脱敏候选人", city: "广州", targetTitles: ["电商运营"] },
        experiences: [{ organization: "示例公司", role: "店铺运营", highlights: ["负责店铺活动复盘"] }]
      }
    }),
    (error) => {
      assert.strictEqual(error.code, "MODEL_CONTRACT_INVALID");
      assert.strictEqual(error.invalidOutput, invalidCard);
      const exposed = `${error.message}\n${error.stack || ""}`;
      assert(!exposed.includes("13800138000"), "契约错误不得包含手机号");
      assert(!exposed.includes("candidate@example.com"), "契约错误不得包含邮件地址");
      assert(!exposed.includes("示例公司"), "契约错误不得在消息中复述候选人事实正文");
      return true;
    }
  );
}

async function contractRepairAndFailureSmoke() {
  const adapterDecision = { recommendation: "apply", fitLevel: "A", confidence: 0.9 };
  const validatingAnalyzer = createLlmAnalyzer({ adapter: { matchJob: async () => adapterDecision } });
  await assert.rejects(
    validatingAnalyzer.matchJob({}),
    (error) => error.code === "MODEL_CONTRACT_INVALID" && error.invalidOutput === adapterDecision
  );

  let matchCalls = 0;
  const invalidDecision = {
    recommendation: "apply",
    fitLevel: "A",
    confidence: 0.9,
    fitReasons: [],
    requirementMatches: [
      { requirement: "Python", state: "matched", indispensable: true, jdEvidence: "JD：熟练使用 Python", resumeEvidence: "简历：德勤 AI 实习使用 Python" },
      { requirement: "RAG", state: "matched", indispensable: true, jdEvidence: "JD：负责 RAG 知识库建设", resumeEvidence: "简历：负责企业知识库项目" }
    ],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [],
    softGaps: [],
    questionsToVerify: [],
    evidence: { jd: ["Build RAG knowledge bases"], resume: ["Improved a RAG retrieval pipeline"] }
  };
  const repairing = createJobAnalysisRunner(configFor(["Python", "RAG"]), [], {
    db,
    analyzer: {
      understandJob: async ({ job }) => understanding(job.sourceId),
      matchJob: async (input) => {
        matchCalls += 1;
        if (!input.contractRepair) return invalidDecision;
        assert.deepStrictEqual(input.contractRepair.invalidOutput, invalidDecision);
        assert.match(input.contractRepair.reason, /apply\/caution/);
        return decision("apply", "A", "Python");
      }
    }
  });
  const repaired = await repairing(completeJob("contract-repair"));
  assert.strictEqual(matchCalls, 2, "证据契约不完整时只允许一次修复请求");
  assert.strictEqual(repaired.semanticStatus, "complete");

  // 与 JobUnderstanding 跨字段不一致同样进入一次契约修复，而不是在最终 compact 后被静默接受。
  const fullDecision = decision("apply", "A", "Python");
  const missingRequirementDecision = { ...fullDecision, requirementMatches: fullDecision.requirementMatches.slice(0, 1) };
  let alignmentCalls = 0;
  const aligning = createJobAnalysisRunner(configFor(["Python", "RAG"]), [], {
    db,
    analyzer: {
      understandJob: async ({ job }) => understanding(job.sourceId),
      matchJob: async (input) => {
        alignmentCalls += 1;
        if (!input.contractRepair) return missingRequirementDecision;
        assert.match(input.contractRepair.reason, /requirementMatches/, "漏掉核心要求时修复原因必须指向 requirementMatches");
        return decision("apply", "A", "Python");
      }
    }
  });
  const alignedResult = await aligning(completeJob("contract-alignment-repair"));
  assert.strictEqual(alignmentCalls, 2, "跨字段不一致只允许一次修复请求");
  assert.strictEqual(alignedResult.semanticStatus, "complete");

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
  assert.strictEqual(failed.errorCode, "MODEL_TIMEOUT");
  assert.strictEqual(failed.errorStage, "matchJob");
  assert.strictEqual(failed.errorPhase, "initial");
  assert.strictEqual(decisionBucket({ ...completeJob("model-failure"), analysis: failed, qualityTags: [], risks: [] }), "analysis_pending");

  assert.throws(() => validateModelResult("matchJob", { recommendation: "apply", fitLevel: "A", confidence: 0.9 }), ModelContractError);
}

async function initialFailureProvenanceSmoke() {
  const cases = [
    {
      sourceId: "understanding-initial-failure",
      expectedStage: "understandJob",
      expectedCode: "MODEL_INVALID_RESPONSE",
      expectedResponseFailureKind: "missing_content",
      expectedHttpStatus: 200,
      expectedJsonModeApplied: false,
      analyzer: {
        understandJob: async () => {
          throw Object.assign(new Error("synthetic initial understanding failure"), {
            code: "MODEL_INVALID_RESPONSE",
            responseFailureKind: "missing_content",
            requestedMaxTokens: 8192,
            httpStatus: 200,
            jsonModeApplied: false,
            contentLength: 37,
            responseContentTypeKind: "html",
            responseEnvelopeKind: "html",
            responseParseFailureKind: "unexpected_token",
            responseHadUtf8Bom: false
          });
        },
        matchJob: async () => {
          throw new Error("matchJob must not run after understandJob fails");
        }
      }
    },
    {
      sourceId: "matching-initial-failure",
      expectedStage: "matchJob",
      expectedCode: "MODEL_OUTPUT_TRUNCATED",
      expectedResponseFailureKind: "truncated_content",
      expectedHttpStatus: 200,
      expectedJsonModeApplied: true,
      analyzer: {
        understandJob: async ({ job }) => understanding(job.sourceId),
        matchJob: async () => {
          throw Object.assign(new Error("synthetic initial matching failure"), {
            code: "MODEL_OUTPUT_TRUNCATED",
            responseFailureKind: "truncated_content",
            requestedMaxTokens: 4096,
            httpStatus: 200,
            jsonModeApplied: true
          });
        }
      }
    }
  ];

  for (const testCase of cases) {
    const analyze = createJobAnalysisRunner(configFor(["Python", "RAG"]), [], { db, analyzer: testCase.analyzer });
    const failed = await analyze(completeJob(testCase.sourceId));
    assert.strictEqual(failed.semanticStatus, "failed");
    assert.strictEqual(failed.errorCode, testCase.expectedCode);
    assert.strictEqual(failed.errorStage, testCase.expectedStage);
    assert.strictEqual(failed.errorPhase, "initial");
    assert.strictEqual(failed.errorResponseKind, testCase.expectedResponseFailureKind);
    assert.strictEqual(failed.errorRequestedMaxTokens, testCase.expectedCode === "MODEL_INVALID_RESPONSE" ? 8192 : 4096);
    assert.strictEqual(failed.errorHttpStatus, testCase.expectedHttpStatus);
    assert.strictEqual(failed.errorJsonModeApplied, testCase.expectedJsonModeApplied);
    if (testCase.expectedCode === "MODEL_INVALID_RESPONSE") {
      assert.strictEqual(failed.errorContentLength, 37);
      assert.strictEqual(failed.errorContentTypeKind, "html");
      assert.strictEqual(failed.errorEnvelopeKind, "html");
      assert.strictEqual(failed.errorParseFailureKind, "unexpected_token");
      assert.strictEqual(failed.errorHadUtf8Bom, false);
    }
  }
}

async function pipelineVersionCacheSmoke() {
  assert.strictEqual(PIPELINE_VERSIONS.understandJob, "job-understanding-v14");
  assert.strictEqual(PIPELINE_VERSIONS.matchJob, "match-decision-v27");
  assert.strictEqual(PIPELINE_VERSIONS.decisionRules, "role-direction-requirements-v2");
  const currentRevision = {
    profileVersion: "profile",
    searchPlanVersion: "plan",
    matchingCardVersion: "card",
    sourceContentHash: "job",
    pipelineVersions: PIPELINE_VERSIONS
  };
  assert.deepStrictEqual(
    analysisStaleReasons({
      revision: {
        ...currentRevision,
        pipelineVersions: {
          ...PIPELINE_VERSIONS,
          matchJob: "match-decision-v23",
          decisionRules: "role-direction-requirements-v1"
        }
      }
    }, currentRevision),
    ["match_pipeline_changed", "decision_rules_changed"],
    "岗位族提示词与要求权重变化必须使旧匹配缓存和旧分析结论失效"
  );
  assert(
    analysisStaleReasons({
      revision: {
        ...currentRevision,
        pipelineVersions: { ...PIPELINE_VERSIONS, understandJob: "job-understanding-v12" }
      }
    }, currentRevision).includes("job_understanding_pipeline_changed"),
    "主体行业与主体工作分离后必须使 v12 岗位理解缓存失效"
  );
  assert(
    analysisStaleReasons({
      revision: {
        ...currentRevision,
        pipelineVersions: { ...PIPELINE_VERSIONS, matchJob: "match-decision-v24" }
      }
    }, currentRevision).includes("match_pipeline_changed"),
    "行业边界提示词变更后必须使 v24 岗位匹配缓存失效"
  );
  assert(
    analysisStaleReasons({
      revision: {
        ...currentRevision,
        pipelineVersions: { ...PIPELINE_VERSIONS, understandJob: "job-understanding-v13" }
      }
    }, currentRevision).includes("job_understanding_pipeline_changed"),
    "主体工作抽象层级变更后必须使 v13 岗位理解缓存失效"
  );
  assert(
    analysisStaleReasons({
      revision: {
        ...currentRevision,
        pipelineVersions: { ...PIPELINE_VERSIONS, matchJob: "match-decision-v25" }
      }
    }, currentRevision).includes("match_pipeline_changed"),
    "业务系统维护边界变更后必须使 v25 岗位匹配缓存失效"
  );
  assert(
    analysisStaleReasons({
      revision: {
        ...currentRevision,
        pipelineVersions: { ...PIPELINE_VERSIONS, matchJob: "match-decision-v26" }
      }
    }, currentRevision).includes("match_pipeline_changed"),
    "行业外壳剥离顺序变更后必须使 v26 岗位匹配缓存失效"
  );
  const configs = configFor(["Python"]);
  let runs = 0;
  const run = async () => { runs += 1; return understanding("pipeline-cache"); };
  const input = { job: { sourceId: "pipeline-cache", description: "Python RAG" } };
  await cachedModelCall({ db, configs, kind: "understandJob", pipelineVersion: "test-v1", input, run });
  await cachedModelCall({ db, configs, kind: "understandJob", pipelineVersion: "test-v1", input, run });
  await cachedModelCall({ db, configs, kind: "understandJob", pipelineVersion: "test-v2", input, run });
  assert.strictEqual(runs, 2, "pipelineVersion 变化必须使旧缓存失效");
}

function understandingContractSmoke() {
  // JobUnderstanding 契约收紧：字符串、缺失 evidence、非法枚举一律抛 ModelContractError 进入契约修复，不静默升级。
  const validUnderstanding = {
    jobId: "u-1",
    roleSummary: "负责店铺运营",
    coreResponsibilities: [{ label: "店铺活动运营", evidence: "JD：负责店铺活动运营" }],
    coreRequirements: [{ label: "投放 ROI 复盘", indispensable: true, evidence: "JD：必须独立完成投放 ROI 复盘" }],
    preferredRequirements: [{ label: "熟悉直通车", evidence: "JD：熟悉直通车优先" }],
    outcomeExpectations: [],
    hiddenRisks: [],
    jobQuality: { level: "normal", concerns: [] },
    evidenceSnippets: ["JD：负责店铺活动运营"]
  };
  const understood = validateModelResult("understandJob", validUnderstanding);
  assert.strictEqual(understood.coreRequirements[0].indispensable, true, "合法对象结构必须保留");

  const normalizedEligibility = validateModelResult("understandJob", {
    ...validUnderstanding,
    eligibilityConstraints: ["JD：可接受应届毕业生", "JD：本科及以上学历"]
  });
  assert.deepStrictEqual(normalizedEligibility.eligibilityConstraints, ["JD：本科及以上学历"],
    "包容性届别措辞不得进入硬资格，明确学历资格必须保留");
  const mixedEligibility = validateModelResult("understandJob", {
    ...validUnderstanding,
    eligibilityConstraints: ["JD：本科及以上学历，硕士优先"]
  });
  assert.deepStrictEqual(mixedEligibility.eligibilityConstraints, ["JD：本科及以上学历，硕士优先"],
    "同一句同时包含明确学历资格和软偏好时，不得连同硬资格一起丢弃");
  const conjunctiveEligibility = validateModelResult("understandJob", {
    ...validUnderstanding,
    eligibilityConstraints: ["JD：可接受应届毕业生且本科及以上学历"]
  });
  assert.deepStrictEqual(conjunctiveEligibility.eligibilityConstraints, ["JD：可接受应届毕业生且本科及以上学历"],
    "软硬条件用连接词组合时，明确学历资格仍必须保留");
  const parentheticalEligibility = validateModelResult("understandJob", {
    ...validUnderstanding,
    eligibilityConstraints: ["JD：本科及以上学历（可接受应届毕业生）"]
  });
  assert.deepStrictEqual(parentheticalEligibility.eligibilityConstraints, ["JD：本科及以上学历（可接受应届毕业生）"],
    "软偏好放在括号中时，不得把括号外的明确学历资格一起过滤");
  const exclusiveEligibility = validateModelResult("understandJob", {
    ...validUnderstanding,
    eligibilityConstraints: ["JD：仅限 2027 届应届毕业生"]
  });
  assert.deepStrictEqual(exclusiveEligibility.eligibilityConstraints, ["JD：仅限 2027 届应届毕业生"],
    "明确限定届别仍必须保留为硬资格");

  const sparse = validateModelResult("understandJob", {
    ...validUnderstanding,
    coreResponsibilities: [], coreRequirements: [], preferredRequirements: [], outcomeExpectations: [], hiddenRisks: []
  });
  assert.deepStrictEqual(sparse.coreRequirements, [], "空数组本身合法");

  assert.throws(() => validateModelResult("understandJob", { ...validUnderstanding, coreRequirements: ["Java"] }),
    (error) => error instanceof ModelContractError && /coreRequirements/.test(error.message), "字符串型 coreRequirements 必须拒绝");
  assert.throws(() => validateModelResult("understandJob", {
    ...validUnderstanding,
    coreRequirements: [
      validUnderstanding.coreRequirements[0],
      { ...validUnderstanding.coreRequirements[0], evidence: "JD：重复描述同一项要求" }
    ]
  }), (error) => error instanceof ModelContractError && /coreRequirements|重复/.test(error.message),
  "JobUnderstanding 不得用重复 label 把同一条匹配记录伪装成逐项覆盖");
  assert.throws(() => validateModelResult("understandJob", { ...validUnderstanding, coreResponsibilities: ["负责店铺运营"] }),
    (error) => error instanceof ModelContractError && /coreResponsibilities/.test(error.message), "字符串数组不得静默升级为对象");
  assert.throws(() => validateModelResult("understandJob", { ...validUnderstanding, coreRequirements: [{ label: "投放 ROI 复盘", indispensable: true }] }),
    (error) => error instanceof ModelContractError && /evidence/.test(error.message), "缺失 JD evidence 必须拒绝");
  assert.throws(() => validateModelResult("understandJob", { ...validUnderstanding, coreRequirements: [{ label: "投放 ROI 复盘", indispensable: "false", evidence: "JD：必须独立完成复盘" }] }),
    (error) => error instanceof ModelContractError && /indispensable/.test(error.message), "indispensable 必须是 boolean，不得强制转换");
  assert.throws(() => validateModelResult("understandJob", { ...validUnderstanding, jobQuality: { level: "nromal", concerns: [] } }),
    (error) => error instanceof ModelContractError && /jobQuality\.level/.test(error.message), "非法 jobQuality.level 必须拒绝");
  assert.throws(() => validateModelResult("understandJob", { ...validUnderstanding, jobQuality: { concerns: [] } }),
    (error) => error instanceof ModelContractError && /jobQuality\.level/.test(error.message), "缺失 jobQuality.level 必须拒绝");
  assert.throws(() => validateModelResult("understandJob", { ...validUnderstanding, jobQuality: { level: "caution", concerns: [{ type: "responsibility_sprawl" }] } }),
    (error) => error instanceof ModelContractError && /concerns|evidence/.test(error.message), "concern 缺 evidence 必须拒绝");
  assert.throws(() => validateModelResult("understandJob", { ...validUnderstanding, hiddenRisks: [{ type: "outsourcing", severity: "critical", evidence: "JD：疑似外包驻场" }] }),
    (error) => error instanceof ModelContractError && /severity/.test(error.message), "非法 severity 必须拒绝");
  assert.throws(() => validateModelResult("understandJob", { ...validUnderstanding, hiddenRisks: [{ type: "outsourcing", severity: "medium" }] }),
    (error) => error instanceof ModelContractError && /evidence/.test(error.message), "hiddenRisks 缺 evidence 必须拒绝");
}

function compactResponsibilityFoundationContractSmoke() {
  const validCompactUnderstanding = {
    industryContext: "企业服务",
    roleSummary: "企业业务系统全栈交付",
    responsibilityEvidence: ["JD：完成企业业务系统前后端开发、联调与上线"],
    requirements: [{
      label: "后端开发能力",
      foundation: true,
      central: false,
      indispensable: false,
      evidence: "JD：后端熟悉 Python 或 Node.js"
    }],
    eligibility: [],
    riskSignals: []
  };

  assert.throws(
    () => validateModelResult("understandJob", {
      industryContext: validCompactUnderstanding.industryContext,
      roleSummary: validCompactUnderstanding.roleSummary,
      requirements: [],
      eligibility: [],
      riskSignals: []
    }),
    (error) => error.code === "MODEL_CONTRACT_INVALID" && /responsibilityEvidence/.test(error.message)
  );
  assert.throws(
    () => validateModelResult("understandJob", {
      ...validCompactUnderstanding,
      responsibilityEvidence: ["负责企业系统开发"]
    }),
    (error) => error.code === "MODEL_CONTRACT_INVALID" && /JD：/.test(error.message)
  );
  assert.throws(
    () => validateModelResult("understandJob", {
      ...validCompactUnderstanding,
      requirements: [{
        label: "后端开发能力",
        central: false,
        indispensable: false,
        evidence: "JD：熟悉 Python"
      }]
    }),
    (error) => error.code === "MODEL_CONTRACT_INVALID" && /foundation/.test(error.message)
  );
  for (const responsibilityEvidence of [[""], ["JD：" + "a".repeat(121)], [42]]) {
    assert.throws(
      () => validateModelResult("understandJob", { ...validCompactUnderstanding, responsibilityEvidence }),
      (error) => error.code === "MODEL_CONTRACT_INVALID" && /responsibilityEvidence/.test(error.message)
    );
  }
  assert.throws(
    () => validateModelResult("understandJob", {
      ...validCompactUnderstanding,
      requirements: [{ ...validCompactUnderstanding.requirements[0], foundation: "true" }]
    }),
    (error) => error.code === "MODEL_CONTRACT_INVALID" && /foundation/.test(error.message)
  );

  const emptyResponsibilities = validateModelResult("understandJob", {
    ...validCompactUnderstanding,
    responsibilityEvidence: []
  });
  assert.deepStrictEqual(emptyResponsibilities.responsibilityEvidence, []);

  const normalized = validateModelResult("understandJob", {
    ...validCompactUnderstanding,
    responsibilityEvidence: ["JD：职责一", "JD：职责二", "JD：职责三", "JD：职责四", "JD：职责五"]
  });
  assert.deepStrictEqual(normalized.responsibilityEvidence, ["JD：职责一", "JD：职责二", "JD：职责三", "JD：职责四"]);
  assert.strictEqual(normalized.coreRequirements[0].foundation, true);
}

function matchUnderstandingAlignmentSmoke() {
  // MatchDecision 必须与本次 JobUnderstanding 一一核对：漏项、重复、虚构、改 indispensable 全部进入契约修复。
  const jobUnderstanding = {
    roleSummary: "店铺投放运营",
    responsibilityEvidence: ["JD：负责店铺投放与 ROI 复盘"],
    coreRequirements: [
      { label: "投放 ROI 复盘", indispensable: true, evidence: "JD：必须独立完成投放 ROI 复盘" },
      { label: "店铺活动运营", indispensable: false, evidence: "JD：负责店铺活动运营" }
    ],
    jobQuality: { level: "normal", concerns: [] }
  };
  const baseDecision = {
    recommendation: "caution",
    fitLevel: "B",
    confidence: 0.8,
    fitReasons: ["核心要求有证据支撑，活动运营待确认"],
    requirementMatches: [
      { requirement: "投放 ROI 复盘", state: "matched", indispensable: true, jdEvidence: "JD：必须独立完成投放 ROI 复盘", resumeEvidence: "简历：负责淘宝店铺投放 ROI 复盘" },
      { requirement: "店铺活动运营", state: "unknown", indispensable: false, jdEvidence: "JD：负责店铺活动运营", resumeEvidence: "" }
    ],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [],
    softGaps: ["店铺活动运营经验待确认"],
    questionsToVerify: [],
    evidence: { jd: ["JD：必须独立完成投放 ROI 复盘"], resume: ["简历：负责淘宝店铺投放 ROI 复盘"] }
  };
  const aligned = validateModelResult("matchJob", baseDecision, { jobUnderstanding });
  assert.strictEqual(aligned.requirementMatches.length, 2, "与理解一致的核心项必须全部保留");

  assert.throws(() => validateModelResult("matchJob", { ...baseDecision, requirementMatches: [baseDecision.requirementMatches[0]] }, { jobUnderstanding }),
    (error) => error instanceof ModelContractError && /requirementMatches/.test(error.message), "漏掉核心要求必须拒绝");
  assert.throws(() => validateModelResult("matchJob", {
    ...baseDecision,
    requirementMatches: [{ ...baseDecision.requirementMatches[0], indispensable: false }, baseDecision.requirementMatches[1]]
  }, { jobUnderstanding }),
    (error) => error instanceof ModelContractError && /indispensable/.test(error.message), "模型不得修改 indispensable");
  for (const invalidIndispensable of ["false", 0, null]) {
    assert.throws(() => validateModelResult("matchJob", {
      ...baseDecision,
      requirementMatches: [{ ...baseDecision.requirementMatches[0], indispensable: invalidIndispensable }, baseDecision.requirementMatches[1]]
    }, { jobUnderstanding }),
      (error) => error instanceof ModelContractError && /indispensable/.test(error.message),
      `indispensable=${String(invalidIndispensable)} 必须因类型错误被拒绝，不得 Boolean 强转`);
  }
  assert.throws(() => validateModelResult("matchJob", { ...baseDecision, requirementMatches: [...baseDecision.requirementMatches, baseDecision.requirementMatches[0]] }, { jobUnderstanding }),
    (error) => error instanceof ModelContractError && /requirementMatches|重复/.test(error.message), "重复核心项必须拒绝");
  assert.throws(() => validateModelResult("matchJob", {
    ...baseDecision,
    requirementMatches: [baseDecision.requirementMatches[0]]
  }, {
    jobUnderstanding: {
      roleSummary: jobUnderstanding.roleSummary,
      responsibilityEvidence: jobUnderstanding.responsibilityEvidence,
      coreRequirements: [
        jobUnderstanding.coreRequirements[0],
        { ...jobUnderstanding.coreRequirements[0], evidence: "JD：重复描述同一项要求" }
      ]
    }
  }), (error) => error instanceof ModelContractError && /coreRequirements|重复/.test(error.message),
  "防御性校验不得让一条 match 同时覆盖两个同名核心要求");
  assert.throws(() => validateModelResult("matchJob", {
    ...baseDecision,
    requirementMatches: [...baseDecision.requirementMatches, { requirement: "虚构核心要求", state: "matched", indispensable: false, jdEvidence: "JD：虚构", resumeEvidence: "简历：虚构" }]
  }, { jobUnderstanding }),
    (error) => error instanceof ModelContractError && /requirementMatches|虚构/.test(error.message), "虚构核心项必须拒绝");
  assert.throws(() => validateModelResult("matchJob", {
    ...baseDecision,
    requirementMatches: [baseDecision.requirementMatches[0], { requirement: "  ", state: "matched", indispensable: false, jdEvidence: "JD：占位", resumeEvidence: "简历：占位" }]
  }, { jobUnderstanding }),
    (error) => error instanceof ModelContractError && /requirement/.test(error.message), "空 requirement 必须抛错，不得过滤消失");
  assert.throws(() => validateModelResult("matchJob", {
    ...baseDecision,
    requirementMatches: [{ ...baseDecision.requirementMatches[0], requirement: {} }, baseDecision.requirementMatches[1]]
  }, { jobUnderstanding }),
    (error) => error instanceof ModelContractError && /requirement/.test(error.message),
    "对象 requirement 不得被字符串化后参与一一核对");

  const cautionUnderstanding = {
    ...jobUnderstanding,
    jobQuality: { level: "caution", concerns: [{ type: "responsibility_sprawl", evidence: "JD：同时要求投放、直播与拍摄" }] }
  };
  assert.throws(() => validateModelResult("matchJob", baseDecision, { jobUnderstanding: cautionUnderstanding }),
    (error) => error instanceof ModelContractError && /jobQuality/.test(error.message),
    "matchJob 不得把 understandJob 的 caution 降成 normal");
  const cautionAligned = validateModelResult("matchJob", {
    ...baseDecision,
    jobQuality: {
      level: "caution",
      concerns: [
        ...cautionUnderstanding.jobQuality.concerns,
        { type: "unclear_scope", evidence: "JD：汇报关系未说明" }
      ]
    }
  }, { jobUnderstanding: cautionUnderstanding });
  assert.strictEqual(cautionAligned.jobQuality.concerns.length, 2, "允许保留既有 concern 后补充新的 JD 质量关注点");
  assert.throws(() => validateModelResult("matchJob", {
    ...baseDecision,
    jobQuality: { level: "caution", concerns: [] }
  }, { jobUnderstanding: cautionUnderstanding }),
    (error) => error instanceof ModelContractError && /jobQuality/.test(error.message),
    "matchJob 不得删除 understandJob 已识别的 concern");

  const riskUnderstanding = {
    ...jobUnderstanding,
    jobQuality: { level: "risk", concerns: [{ type: "fee_fraud", evidence: "JD：入职前需支付培训费" }] }
  };
  assert.throws(() => validateModelResult("matchJob", baseDecision, { jobUnderstanding: riskUnderstanding }),
    (error) => error instanceof ModelContractError && /jobQuality/.test(error.message),
    "matchJob 不得把 understandJob 的 risk 降成 normal");

  // JD 没有可核对的核心要求时不得 apply，只能 review。
  assert.throws(() => validateModelResult("matchJob", {
    recommendation: "apply",
    fitLevel: "A",
    confidence: 0.9,
    fitReasons: ["有理由"],
    requirementMatches: [],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [],
    softGaps: [],
    questionsToVerify: [],
    evidence: { jd: ["JD：岗位职责面议"], resume: ["简历：店铺运营经历"] }
  }, { jobUnderstanding: { roleSummary: "未知岗位", responsibilityEvidence: [], coreRequirements: [] } }),
    (error) => error instanceof ModelContractError && /apply/.test(error.message), "没有可核对核心要求时 recommendation 不能为 apply");
  const reviewNoCore = validateModelResult("matchJob", {
    recommendation: "review",
    fitLevel: "C",
    confidence: 0.4,
    fitReasons: [],
    requirementMatches: [],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [],
    softGaps: ["JD 未提供可核对的核心要求"],
    questionsToVerify: [],
    evidence: { jd: [], resume: [] }
  }, { jobUnderstanding: { roleSummary: "未知岗位", responsibilityEvidence: [], coreRequirements: [] } });
  assert.strictEqual(reviewNoCore.recommendation, "review", "没有核心要求时 review 是合法结论");
}

async function ruleGuardSmoke() {
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

async function localEvidenceGuardSmoke() {
  const dualEvidence = { jd: ["JD：必须独立完成投放 ROI 复盘"], resume: ["简历：负责淘宝店铺投放 ROI 复盘"] };
  const samples = [
    {
      sourceId: "guard-transferable-core",
      title: "抖音店铺运营",
      matchState: "transferable",
      jobQuality: { level: "normal", concerns: [] },
      confidence: 0.82,
      expected: "caution"
    },
    {
      sourceId: "guard-caution-quality",
      title: "全能电商运营",
      matchState: "matched",
      jobQuality: { level: "caution", concerns: [{ type: "responsibility_sprawl", evidence: "JD 同时要求直播、拍摄、剪辑" }] },
      confidence: 0.86,
      expected: "caution"
    },
    {
      sourceId: "guard-primary-apply",
      title: "电商运营专员",
      matchState: "matched",
      jobQuality: { level: "normal", concerns: [] },
      confidence: 0.9,
      expected: "apply",
      expectedBucket: "primary"
    }
  ];
  for (const sample of samples) {
    const modelDecision = {
      recommendation: "apply",
      fitLevel: "A",
      confidence: sample.confidence,
      fitReasons: ["核心要求与店铺运营证据对应"],
      requirementMatches: [{
        requirement: "投放与 ROI 分析",
        state: sample.matchState,
        indispensable: true,
        jdEvidence: dualEvidence.jd[0],
        resumeEvidence: dualEvidence.resume[0]
      }],
      jobQuality: sample.jobQuality,
      hardBlockers: [],
      softGaps: [],
      questionsToVerify: [],
      evidence: dualEvidence
    };
    const analyzer = {
      understandJob: async ({ job }) => ({
        jobId: job.sourceId,
        roleSummary: sample.title,
        coreResponsibilities: [{ label: "店铺投放复盘", evidence: dualEvidence.jd[0] }],
        coreRequirements: [{ label: "投放与 ROI 分析", indispensable: true, evidence: dualEvidence.jd[0] }],
        preferredRequirements: [],
        outcomeExpectations: [],
        jobQuality: sample.jobQuality,
        hiddenRisks: [],
        evidenceSnippets: dualEvidence.jd
      }),
      matchJob: async () => modelDecision
    };
    const configs = configFor(["店铺运营", "投放复盘"]);
    configs.candidateProfile = {
      candidate: { name: "电商候选人", city: "广州", targetTitles: ["电商运营"] },
      experiences: [{ organization: "示例店铺", role: "店铺运营", highlights: ["负责淘宝店铺投放 ROI 复盘"] }],
      skills: [{ name: "店铺运营", level: "resume", evidence: ["示例店铺"] }],
      projects: []
    };
    configs.analysisContext = runtimeAnalysisContext(configs.candidateProfile, configs.searchPlan);
    const runner = createJobAnalysisRunner(configs, [], { db, analyzer });
    const sourceJob = completeJob(sample.sourceId, {
      title: sample.title,
      tags: ["电商运营"],
      description: `${dualEvidence.jd[0]}，负责店铺日常经营与活动复盘。`.repeat(4)
    });
    const result = await runner(sourceJob);
    assert.strictEqual(result.semanticStatus, "complete", `${sample.sourceId} 应保持完整语义状态`);
    assert.strictEqual(result.recommendation, sample.expected, `${sample.sourceId} 本地守卫结论错误`);
    if (sample.expectedBucket) {
      assert.strictEqual(
        decisionBucket({ ...sourceJob, analysis: result, qualityTags: [], risks: [] }),
        sample.expectedBucket,
        `${sample.sourceId} 分桶结果错误`
      );
    }
  }
}

function matchBoundaryContractSmoke() {
  assert.throws(() => validateModelResult("matchJob", {
    recommendation: "skip",
    fitLevel: "D",
    confidence: 0.9,
    fitReasons: ["The required core language does not match the candidate stack"],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [{ reason: "Core C++ requirement is missing", evidence: "Must know C++" }],
    softGaps: [],
    questionsToVerify: [],
    evidence: { jd: ["Must know C++"], resume: ["Candidate stack is Python/FastAPI"] }
  }), (error) => error instanceof ModelContractError && /kind/.test(error.message), "新的模型输出不得产生旧式对象 blocker");

  assert.throws(() => validateModelResult("matchJob", {
    recommendation: "skip",
    fitLevel: "D",
    confidence: 0.9,
    fitReasons: [],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [{ kind: "indispensable_core", requirement: "", jdEvidence: "Must know C++", resumeEvidence: "Candidate stack is Python" }],
    softGaps: [],
    questionsToVerify: [],
    evidence: { jd: ["Must know C++"], resume: ["Candidate stack is Python/FastAPI"] }
  }), ModelContractError);

  assert.throws(() => validateModelResult("matchJob", {
    recommendation: "caution",
    fitLevel: "B",
    confidence: 0.78,
    fitReasons: [],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [],
    softGaps: ["Experience should be confirmed"],
    questionsToVerify: [],
    evidence: { jd: ["Build RAG knowledge bases"], resume: ["Improved a RAG retrieval pipeline"] }
  }), ModelContractError);

  const soft = validateModelResult("matchJob", {
    recommendation: "caution",
    fitLevel: "B",
    confidence: 0.8,
    fitReasons: ["核心职责与 Python/RAG 项目匹配"],
    jobQuality: { level: "normal", concerns: [] },
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
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [],
    softGaps: ["未达到 3-5 年"],
    evidence: { jd: ["要求 3-5 年"], resume: ["企业经历较短"] }
  }), ModelContractError);
  const unsupportedHardBlocker = {
    recommendation: "skip",
    fitLevel: "D",
    confidence: 0.9,
    fitReasons: ["岗位核心语言与候选人主栈不一致"],
    jobQuality: { level: "normal", concerns: [] },
    requirementMatches: [{
      requirement: "C++ 核心开发",
      state: "missing",
      indispensable: true,
      jdEvidence: "JD：必须熟练掌握 C++",
      resumeEvidence: "简历：候选人主栈为 Python/FastAPI"
    }],
    hardBlockers: [{
      kind: "indispensable_core",
      requirement: "C++ 核心开发",
      jdEvidence: "JD：必须熟练掌握 C++",
      resumeEvidence: "简历：候选人主栈为 Python/FastAPI"
    }],
    softGaps: [],
    questionsToVerify: [],
    evidence: { jd: ["必须熟练掌握 C++"], resume: ["候选人主栈为 Python/FastAPI"] }
  };
  assert.throws(() => validateModelResult("matchJob", unsupportedHardBlocker), ModelContractError,
    "旧 MatchDecision 也不得把另一技术栈当作候选人明确不兼容");
  assert.throws(() => validateModelResult("matchJob", {
    ...unsupportedHardBlocker,
    requirementMatches: unsupportedHardBlocker.requirementMatches.map((item) => ({
      ...item,
      resumeEvidence: "简历：候选人仅参与过项目中的接口开发"
    })),
    hardBlockers: unsupportedHardBlocker.hardBlockers.map((item) => ({
      ...item,
      resumeEvidence: "简历：候选人仅参与过项目中的接口开发"
    })),
    evidence: { jd: ["必须熟练掌握 C++"], resume: ["候选人仅参与过项目中的接口开发"] }
  }), ModelContractError, "过去仅参与某部分工作是经历边界，不是候选人明确拒绝或不能");
  const hard = validateModelResult("matchJob", {
    ...unsupportedHardBlocker,
    requirementMatches: unsupportedHardBlocker.requirementMatches.map((item) => ({
      ...item,
      resumeEvidence: "简历：候选人明确不接受 C++ 岗位"
    })),
    hardBlockers: unsupportedHardBlocker.hardBlockers.map((item) => ({
      ...item,
      resumeEvidence: "简历：候选人明确不接受 C++ 岗位"
    })),
    evidence: { jd: ["必须熟练掌握 C++"], resume: ["候选人明确不接受 C++ 岗位"] }
  });
  assert.strictEqual(hard.hardBlockers.length, 1, "候选人明确拒绝的核心边界仍可硬排除");
  assert.deepStrictEqual(hard.blockingGaps, ["C++ 核心开发"], "旧渲染仍读取字符串化的阻断摘要");
  const eligibility = validateModelResult("matchJob", {
    recommendation: "skip",
    fitLevel: "D",
    confidence: 0.9,
    fitReasons: ["岗位限定 2024 届在校，候选人不符合"],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [{
      kind: "eligibility",
      requirement: "2024 届在校学生",
      jdEvidence: "JD：仅面向 2024 届在校生",
      resumeEvidence: "简历：候选人 2020 年已毕业"
    }],
    softGaps: [],
    questionsToVerify: [],
    evidence: { jd: ["仅面向 2024 届在校生"], resume: ["候选人 2020 年已毕业"] }
  });
  assert.strictEqual(eligibility.recommendation, "skip");
  assert.strictEqual(eligibility.hardBlockers[0].kind, "eligibility");
  assert.throws(() => validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      resumeEvidence: "简历：未提供学历信息"
    })),
    evidence: { jd: eligibility.evidence.jd, resume: ["未提供学历信息"] }
  }), ModelContractError, "旧 MatchDecision 不得把资格信息缺失当作明确冲突");
  assert.throws(() => validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "本科及以上学历",
      jdEvidence: "JD：本科及以上学历",
      resumeEvidence: "简历：学历似乎不符合要求"
    })),
    evidence: { jd: ["本科及以上学历"], resume: ["学历似乎不符合要求"] }
  }), ModelContractError, "旧 MatchDecision 不得把不确定的学历判断当作明确资格冲突");
  assert.throws(() => validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "本科及以上学历",
      jdEvidence: "JD：本科及以上学历",
      resumeEvidence: "简历：本科学历"
    })),
    evidence: { jd: ["本科及以上学历"], resume: ["本科学历"] }
  }), ModelContractError, "同等学历满足门槛时，即使模型声称 conflict 也不得硬排除");
  assert.throws(() => validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "硕士优先，本科及以上学历",
      jdEvidence: "JD：硕士优先，本科及以上学历",
      resumeEvidence: "简历：本科学历"
    })),
    evidence: { jd: ["硕士优先，本科及以上学历"], resume: ["本科学历"] }
  }), ModelContractError, "学历偏好不得覆盖同一句中的较低硬门槛");
  assert.throws(() => validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "硕士及以上学历优先，本科及以上学历",
      jdEvidence: "JD：硕士及以上学历优先，本科及以上学历",
      resumeEvidence: "简历：本科学历"
    })),
    evidence: { jd: ["硕士及以上学历优先，本科及以上学历"], resume: ["本科学历"] }
  }), ModelContractError, "带“及以上”的学历偏好也不得覆盖较低硬门槛");
  const lowerDegreeConflict = validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "本科及以上学历",
      jdEvidence: "JD：本科及以上学历",
      resumeEvidence: "简历：最高学历为大专"
    })),
    evidence: { jd: ["本科及以上学历"], resume: ["最高学历为大专"] }
  });
  assert.strictEqual(lowerDegreeConflict.recommendation, "skip", "明确低于学历门槛的事实仍可硬排除");
  const cohortMatchedDegreeConflict = validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "仅限 2025 届，本科及以上学历",
      jdEvidence: "JD：仅限 2025 届，本科及以上学历",
      resumeEvidence: "简历：2025 届毕业，最高学历大专"
    })),
    evidence: { jd: ["仅限 2025 届，本科及以上学历"], resume: ["2025 届毕业，最高学历大专"] }
  });
  assert.strictEqual(cohortMatchedDegreeConflict.recommendation, "skip", "届别满足后仍须继续核对同一句中的学历硬门槛");
  assert.throws(() => validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "本科及以上学历",
      jdEvidence: "JD：本科及以上学历",
      resumeEvidence: "简历：本科学历，硕士尚未取得"
    })),
    evidence: { jd: ["本科及以上学历"], resume: ["本科学历，硕士尚未取得"] }
  }), ModelContractError, "已经满足最低学历时，未取得更高学历不得反向触发冲突");
  const nonStudentConflict = validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "仅限在校学生",
      jdEvidence: "JD：仅限在校学生",
      resumeEvidence: "简历：当前为非在校生"
    })),
    evidence: { jd: ["仅限在校学生"], resume: ["当前为非在校生"] }
  });
  assert.strictEqual(nonStudentConflict.recommendation, "skip", "明确的非在校事实仍可硬排除");
  assert.throws(() => validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "仅限非在校人员",
      jdEvidence: "JD：仅限非在校人员",
      resumeEvidence: "简历：已毕业"
    })),
    evidence: { jd: ["仅限非在校人员"], resume: ["已毕业"] }
  }), ModelContractError, "非在校要求不得因字符串中包含“在校”而反向误判");
  assert.throws(() => validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "不要求为在校生",
      jdEvidence: "JD：不要求为在校生",
      resumeEvidence: "简历：已毕业"
    })),
    evidence: { jd: ["不要求为在校生"], resume: ["已毕业"] }
  }), ModelContractError, "明确不要求在校时不得反向误判");
  assert.throws(() => validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "可接受在校生，本科及以上学历",
      jdEvidence: "JD：可接受在校生，本科及以上学历",
      resumeEvidence: "简历：已毕业，本科学历"
    })),
    evidence: { jd: ["可接受在校生，本科及以上学历"], resume: ["已毕业，本科学历"] }
  }), ModelContractError, "混合资格句中的在校软条件不得触发硬排除");
  const negativeDegreeConflict = validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "本科及以上学历",
      jdEvidence: "JD：本科及以上学历",
      resumeEvidence: "简历：未取得本科学历"
    })),
    evidence: { jd: ["本科及以上学历"], resume: ["未取得本科学历"] }
  });
  assert.strictEqual(negativeDegreeConflict.recommendation, "skip", "明确未取得最低学历仍可硬排除");
  const trailingNegativeDegreeConflict = validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "本科及以上学历",
      jdEvidence: "JD：本科及以上学历",
      resumeEvidence: "简历：本科学历尚未取得"
    })),
    evidence: { jd: ["本科及以上学历"], resume: ["本科学历尚未取得"] }
  });
  assert.strictEqual(trailingNegativeDegreeConflict.recommendation, "skip", "学历词后的明确否定仍应识别为资格冲突");
  const certificateConflict = validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "必须持有教师资格证",
      jdEvidence: "JD：必须持有教师资格证",
      resumeEvidence: "简历：未持有教师资格证"
    })),
    evidence: { jd: ["必须持有教师资格证"], resume: ["未持有教师资格证"] }
  });
  assert.strictEqual(certificateConflict.recommendation, "skip", "明确缺少岗位要求的同名资格证仍可硬排除");
  const trailingCertificateConflict = validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "必须持有教师资格证",
      jdEvidence: "JD：必须持有教师资格证",
      resumeEvidence: "简历：教师资格证尚未取得"
    })),
    evidence: { jd: ["必须持有教师资格证"], resume: ["教师资格证尚未取得"] }
  });
  assert.strictEqual(trailingCertificateConflict.recommendation, "skip", "否定词位于证书名之后时仍应识别明确冲突");
  const combinedQualificationConflict = validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "本科及以上学历，必须持有教师资格证",
      jdEvidence: "JD：本科及以上学历，必须持有教师资格证",
      resumeEvidence: "简历：本科学历，未持有教师资格证"
    })),
    evidence: { jd: ["本科及以上学历，必须持有教师资格证"], resume: ["本科学历，未持有教师资格证"] }
  });
  assert.strictEqual(combinedQualificationConflict.recommendation, "skip", "满足学历不得遮住同一句中的明确证书冲突");
  assert.throws(() => validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "教师资格证优先，本科及以上学历",
      jdEvidence: "JD：教师资格证优先，本科及以上学历",
      resumeEvidence: "简历：本科学历，未持有教师资格证"
    })),
    evidence: { jd: ["教师资格证优先，本科及以上学历"], resume: ["本科学历，未持有教师资格证"] }
  }), ModelContractError, "证书优先是软条件，不得因同句另有学历硬门槛而升级为硬排除");
  for (const inSchoolRequirement of ["硬性要求：在校学生", "要求为在校生", "需为在校生", "需要是在校生"]) {
    const inSchoolConflict = validateModelResult("matchJob", {
      ...eligibility,
      hardBlockers: eligibility.hardBlockers.map((item) => ({
        ...item,
        requirement: inSchoolRequirement,
        jdEvidence: `JD：${inSchoolRequirement}`,
        resumeEvidence: "简历：已毕业，当前非在校"
      })),
      evidence: { jd: [inSchoolRequirement], resume: ["已毕业，当前非在校"] }
    });
    assert.strictEqual(inSchoolConflict.recommendation, "skip", `${inSchoolRequirement} 是明确在校硬门槛`);
  }
  assert.throws(() => validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "必须持有教师资格证",
      jdEvidence: "JD：必须持有教师资格证",
      resumeEvidence: "简历：已持有教师资格证"
    })),
    evidence: { jd: ["必须持有教师资格证"], resume: ["已持有教师资格证"] }
  }), ModelContractError, "已经持有同名资格证时，即使模型声称 conflict 也不得硬排除");
  for (const certificateRequirement of ["须持教师资格证", "必须持有有效的教师资格证", "教师资格证为必备项"]) {
    const normalizedCertificateConflict = validateModelResult("matchJob", {
      ...eligibility,
      hardBlockers: eligibility.hardBlockers.map((item) => ({
        ...item,
        requirement: certificateRequirement,
        jdEvidence: `JD：${certificateRequirement}`,
        resumeEvidence: "简历：未持有教师资格证"
      })),
      evidence: { jd: [certificateRequirement], resume: ["未持有教师资格证"] }
    });
    assert.strictEqual(normalizedCertificateConflict.recommendation, "skip", `${certificateRequirement} 应识别为同名证书硬门槛`);
  }
  const fullTimeDegreeConflict = validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "要求全日制本科及以上学历",
      jdEvidence: "JD：要求全日制本科及以上学历",
      resumeEvidence: "简历：非全日制本科学历"
    })),
    evidence: { jd: ["要求全日制本科及以上学历"], resume: ["非全日制本科学历"] }
  });
  assert.strictEqual(fullTimeDegreeConflict.recommendation, "skip", "全日制硬门槛与明确非全日制学历是资格冲突");
  assert.throws(() => validateModelResult("matchJob", {
    ...eligibility,
    hardBlockers: eligibility.hardBlockers.map((item) => ({
      ...item,
      requirement: "全日制本科优先，本科及以上学历",
      jdEvidence: "JD：全日制本科优先，本科及以上学历",
      resumeEvidence: "简历：非全日制本科学历"
    })),
    evidence: { jd: ["全日制本科优先，本科及以上学历"], resume: ["非全日制本科学历"] }
  }), ModelContractError, "全日制偏好不得升级为硬门槛");

  // 历史字符串 blocker 仅用于展示旧分析；effectiveHardBlockers 保持展示兼容读取，但绝不参与新决策。
  assert.deepStrictEqual(effectiveHardBlockers({ hardBlockers: ["岗位要求 3-5 年经验，候选人经验不足"] }), []);
  assert.deepStrictEqual(effectiveHardBlockers({ blockingGaps: ["3-5年经验不足", "学历偏好为 985", "未提供 RPA 经验"] }), []);
  assert.deepStrictEqual(effectiveHardBlockers({ blockingGaps: ["完全缺少岗位核心 Java/Spring 经历"] }), ["完全缺少岗位核心 Java/Spring 经历"], "展示兼容仍保留历史硬缺口字符串");
  assert.deepStrictEqual(
    effectiveHardBlockers({ hardBlockers: [{ kind: "safety", requirement: "收费培训", jdEvidence: "JD：先交培训费", resumeEvidence: "简历：无此经历" }] }).map((item) => item.requirement || item),
    ["收费培训"]
  );

  // 决策路径只认结构化三类 kind：字符串、blockingGaps、非法 kind 一律不得形成硬阻断。
  assert.deepStrictEqual(decisionHardBlockers({ blockingGaps: ["Java核心栈不匹配"] }), [], "blockingGaps 字符串不得进入决策");
  assert.deepStrictEqual(decisionHardBlockers({ hardBlockers: ["完全缺少岗位核心 Java/Spring 经历"] }), [], "旧式字符串 hardBlockers 不得进入决策");
  assert.deepStrictEqual(decisionHardBlockers({ hardBlockers: [{ kind: "core_stack", requirement: "Java 核心栈", jdEvidence: "JD：必须 Java", resumeEvidence: "简历：无" }] }), [], "非法 kind 的结构化对象不得硬阻断");
  assert.strictEqual(
    decisionHardBlockers({ hardBlockers: [{ kind: "safety", requirement: "收费培训", jdEvidence: "JD：先交培训费", resumeEvidence: "简历：无此经历" }] }).length,
    1,
    "合法结构化 blocker 仍然阻断"
  );

  // 决策 blocker 必须结构完整：合法 kind + 非空 requirement + 双侧证据，缺一不可；
  // 不完整对象只能展示或忽略，不得参与 skip 与分桶。
  assert.deepStrictEqual(decisionHardBlockers({ hardBlockers: [{ kind: "safety" }] }), [], "只有 kind 的不完整对象不得参与决策");
  assert.deepStrictEqual(decisionHardBlockers({ hardBlockers: [{ kind: "safety", requirement: "  " }] }), [], "空 requirement 不得参与决策");
  assert.deepStrictEqual(decisionHardBlockers({ hardBlockers: [{ kind: "safety", requirement: "收费培训", jdEvidence: "JD：先交培训费" }] }), [], "缺候选人证据不得参与决策");
  assert.deepStrictEqual(decisionHardBlockers({ hardBlockers: [{ kind: "safety", requirement: "收费培训", resumeEvidence: "简历：无相关约定" }] }), [], "缺 JD 证据不得参与决策");
  assert.deepStrictEqual(decisionHardBlockers({ hardBlockers: [{ kind: "unknown_kind", requirement: "收费培训", jdEvidence: "JD：先交培训费", resumeEvidence: "简历：无相关约定" }] }), [], "字段齐全的非法 kind 也不得参与决策");
  assert.deepStrictEqual(decisionHardBlockers({ hardBlockers: [{ kind: "safety", requirement: {}, jdEvidence: 1, resumeEvidence: {} }] }), [], "对象和数字字段不得被字符串化后参与决策");
  assert.deepStrictEqual(decisionHardBlockers({ hardBlockers: [{
    kind: "indispensable_core", requirement: "C++ 核心开发", jdEvidence: "JD：必须熟练掌握 C++", resumeEvidence: "简历：候选人主栈为 Python"
  }] }), [], "另一技术栈不是候选人明确不兼容，不得进入历史决策路径");
  assert.deepStrictEqual(decisionHardBlockers({ hardBlockers: [{
    kind: "indispensable_core", requirement: "独立交付", jdEvidence: "JD：必须独立交付", resumeEvidence: "简历：候选人仅参与过项目中的接口开发"
  }] }), [], "历史职责边界也不得被当成明确拒绝或不能");
  assert.deepStrictEqual(decisionHardBlockers({ hardBlockers: [{
    kind: "eligibility", requirement: "本科及以上学历", jdEvidence: "JD：本科及以上学历", resumeEvidence: "简历：未提供学历信息"
  }] }), [], "资格信息缺失不得进入历史决策路径");
  assert.deepStrictEqual(decisionHardBlockers({ hardBlockers: [{
    kind: "eligibility", requirement: "本科及以上学历", jdEvidence: "JD：本科及以上学历", resumeEvidence: "简历：学历似乎不符合要求"
  }] }), [], "不确定学历判断不得进入历史决策路径");
  assert.deepStrictEqual(decisionHardBlockers({ hardBlockers: [{
    kind: "eligibility", requirement: "本科及以上学历", jdEvidence: "JD：本科及以上学历", resumeEvidence: "简历：本科学历"
  }] }), [], "满足学历门槛的历史 blocker 不得进入决策");
  assert.strictEqual(decisionHardBlockers({ hardBlockers: [{
    kind: "eligibility", requirement: "本科及以上学历", jdEvidence: "JD：本科及以上学历", resumeEvidence: "简历：最高学历为大专"
  }] }).length, 1, "明确低于学历门槛的历史 blocker 仍须生效");
  const incompleteBlockerAnalysis = {
    semanticStatus: "complete",
    recommendation: "review",
    fitLevel: "C",
    confidence: 0.4,
    fitReasons: [],
    requirementMatches: [],
    hardBlockers: [{ kind: "safety" }],
    jobQuality: { level: "normal", concerns: [] },
    evidence: { jd: [], resume: [] }
  };
  assert.strictEqual(
    decisionBucket({ ...completeJob("incomplete-blocker"), analysis: incompleteBlockerAnalysis, qualityTags: [], risks: [] }),
    "talk",
    "不完整 blocker 不得造成 not_recommended"
  );

  const legacyStringAnalysis = {
    semanticStatus: "complete",
    recommendation: "apply",
    fitLevel: "A",
    confidence: 0.9,
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: ["Java核心栈不匹配"],
    blockingGaps: ["Java核心栈不匹配"],
    evidence: { jd: ["JD：负责店铺运营与投放复盘"], resume: ["简历：负责店铺运营与投放复盘"] }
  };
  const legacyGuarded = applyRuleGuard(legacyStringAnalysis, completeJob("legacy-string-blocker"));
  assert.notStrictEqual(legacyGuarded.recommendation, "skip", "历史字符串 blocker 不得触发自动 skip");
  assert.notStrictEqual(
    decisionBucket({ ...completeJob("legacy-string-blocker"), analysis: legacyStringAnalysis, qualityTags: [], risks: [] }),
    "not_recommended",
    "历史字符串 blocker 不得触发 not_recommended"
  );

  const structuredBlockerAnalysis = {
    ...legacyStringAnalysis,
    hardBlockers: [{ kind: "safety", requirement: "收费培训", jdEvidence: "JD：先交培训费", resumeEvidence: "简历：无此经历" }],
    blockingGaps: ["收费培训"]
  };
  assert.strictEqual(applyRuleGuard(structuredBlockerAnalysis, completeJob("structured-blocker")).recommendation, "skip", "合法结构化 blocker 仍触发 skip");
  assert.strictEqual(
    decisionBucket({ ...completeJob("structured-blocker"), analysis: structuredBlockerAnalysis, qualityTags: [], risks: [] }),
    "not_recommended",
    "合法结构化 blocker 仍触发 not_recommended"
  );
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

async function compactRoleEvidencePersistenceSmoke() {
  const configs = { model: { provider: "test", providers: { test: { model: "test-model" } } }, resumeVersions: { versions: [] } };
  const jobUnderstanding = understanding("persist-role-evidence");
  const matchDecision = decision("apply", "A", "Python");
  const compact = compactAnalysis(configs, { job: completeJob("persist-role-evidence"), jobUnderstanding, matchDecision, revision: {} });
  assert.deepStrictEqual(
    {
      industryContext: compact.industryContext,
      roleSummary: compact.roleSummary,
      responsibilityEvidence: compact.responsibilityEvidence,
      roleAlignment: compact.roleAlignment,
      roleResumeEvidence: compact.roleResumeEvidence,
      roleGaps: compact.roleGaps,
      requirementMatches: compact.requirementMatches
    },
    {
      industryContext: jobUnderstanding.industryContext,
      roleSummary: jobUnderstanding.roleSummary,
      responsibilityEvidence: jobUnderstanding.responsibilityEvidence,
      roleAlignment: matchDecision.roleAlignment,
      roleResumeEvidence: matchDecision.roleResumeEvidence,
      roleGaps: matchDecision.roleGaps,
      requirementMatches: matchDecision.requirementMatches
    },
    "compact analysis must preserve role evidence and authoritative requirement flags"
  );
  assert.strictEqual(compact.requirementMatches[0].foundation, true);

  const ruleOnly = createRuleOnlyAnalysis(configs, completeJob("rule-only-role-evidence"), {}, {});
  const failed = await createJobAnalysisRunner({ ...configs, candidateProfile: null }, [], { analyzer: {} })(completeJob("failed-role-evidence"));
  for (const analysis of [ruleOnly, failed]) {
    assert.strictEqual(analysis.industryContext, "");
    assert.strictEqual(analysis.roleSummary, "");
    assert.strictEqual(analysis.roleAlignment, "");
    assert.deepStrictEqual(analysis.responsibilityEvidence, []);
    assert.deepStrictEqual(analysis.roleResumeEvidence, []);
    assert.deepStrictEqual(analysis.roleGaps, []);
    assert.deepStrictEqual(analysis.requirementMatches, []);
  }
}

function staleAnalysisSmoke() {
  const oldPipelineRevision = {
    profileVersion: "profile",
    searchPlanVersion: "plan",
    matchingCardVersion: "card",
    sourceContentHash: "source",
    pipelineVersions: { understandJob: "job-understanding-v5", matchJob: "match-decision-v12" }
  };
  const currentPipelineRevision = { ...oldPipelineRevision, pipelineVersions: PIPELINE_VERSIONS };
  const contractUpgradeReasons = analysisStaleReasons({ revision: oldPipelineRevision }, currentPipelineRevision);
  assert(contractUpgradeReasons.includes("decision_rules_changed"), "old revisions without local decision rules must be stale");
  assert.deepStrictEqual(PIPELINE_VERSIONS, {
    understandJob: "job-understanding-v14",
    matchJob: "match-decision-v27",
    decisionRules: "role-direction-requirements-v2",
    communication: "communication-v2"
  });
  const decisionRulesOnlyChanged = analysisStaleReasons({
    revision: { ...oldPipelineRevision, pipelineVersions: { ...PIPELINE_VERSIONS, decisionRules: "previous-rules" } }
  }, { ...oldPipelineRevision, pipelineVersions: PIPELINE_VERSIONS });
  assert.deepStrictEqual(decisionRulesOnlyChanged, ["decision_rules_changed"]);
  assert.deepStrictEqual(
    analysisStaleReasons({ revision: { ...oldPipelineRevision, pipelineVersions: PIPELINE_VERSIONS } }, { ...oldPipelineRevision, pipelineVersions: PIPELINE_VERSIONS }),
    [],
    "current revisions must not be stale"
  );
  assert(contractUpgradeReasons.includes("job_understanding_pipeline_changed"), "理解提示词升级后必须使 v5 持久化分析 stale");
  assert(contractUpgradeReasons.includes("match_pipeline_changed"), "匹配语义升级后必须使 v12 持久化分析 stale");

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

async function understandingContractRepairSmoke() {
  // 真实模型回归（live-v2-20260725-01）：DeepSeek 常把 eligibilityConstraints 输出为对象数组。
  // 契约保持严格（不静默接受对象），但修复请求必须携带可执行的形状说明，让一次修复可以收敛。
  const invalidUnderstanding = { ...understanding("understanding-repair"), eligibilityConstraints: [{ type: "学历", value: "本科" }] };
  let calls = 0;
  const runner = createJobAnalysisRunner(configFor(["Python", "RAG"]), [], {
    db,
    analyzer: {
      understandJob: async (input) => {
        calls += 1;
        if (!input.contractRepair) return invalidUnderstanding;
        assert.match(input.contractRepair.reason, /eligibilityConstraints/, "修复原因必须指出违规字段");
        assert.match(input.contractRepair.reason, /字符串数组/, "修复原因必须说明目标形状是字符串数组");
        assert.match(input.contractRepair.reason, /空数组/, "修复原因必须说明无内容时的合法输出");
        assert.deepStrictEqual(input.contractRepair.invalidOutput, invalidUnderstanding);
        return understanding("understanding-repair");
      },
      matchJob: async () => decision("apply", "A", "Python")
    }
  });
  const result = await runner(completeJob("understanding-repair"));
  assert.strictEqual(calls, 2, "对象形式的资格约束只允许一次契约修复");
  assert.strictEqual(result.semanticStatus, "complete");

  const incompleteCompactUnderstanding = {
    industryContext: "通用软件",
    roleSummary: "交付应用",
    responsibilityEvidence: ["JD：负责交付应用"],
    requirements: [
      { label: "Python", foundation: true, indispensable: true, evidence: "JD：熟练使用 Python" },
      { label: "RAG", foundation: true, indispensable: true, evidence: "JD：负责 RAG 知识库建设" }
    ],
    eligibility: []
  };
  let compactRepairCalls = 0;
  const compactRepairRunner = createJobAnalysisRunner(configFor(["Python", "RAG"]), [], {
    db,
    analyzer: {
      understandJob: async (input) => {
        compactRepairCalls += 1;
        if (!input.contractRepair) return incompleteCompactUnderstanding;
        assert.match(input.contractRepair.reason, /riskSignals/, "紧凑字段缺失的修复原因必须指出 riskSignals");
        assert.deepStrictEqual(input.contractRepair.invalidOutput, incompleteCompactUnderstanding);
        return { ...incompleteCompactUnderstanding, riskSignals: [] };
      },
      matchJob: async () => decision("apply", "A", "Python")
    }
  });
  const compactRepairResult = await compactRepairRunner(completeJob("understanding-compact-repair"));
  assert.strictEqual(compactRepairCalls, 2, "紧凑字段缺失必须触发一次既有契约修复");
  assert.strictEqual(compactRepairResult.semanticStatus, "complete");

  const whitespaceRoleSummary = { ...incompleteCompactUnderstanding, roleSummary: "   ", riskSignals: [] };
  let whitespaceRoleRepairCalls = 0;
  const whitespaceRoleRepairRunner = createJobAnalysisRunner(configFor(["Python", "RAG"]), [], {
    db,
    analyzer: {
      understandJob: async (input) => {
        whitespaceRoleRepairCalls += 1;
        if (!input.contractRepair) return whitespaceRoleSummary;
        assert.match(input.contractRepair.reason, /roleSummary/, "空白 roleSummary 的修复原因必须指出 roleSummary");
        assert.deepStrictEqual(input.contractRepair.invalidOutput, whitespaceRoleSummary);
        return { ...whitespaceRoleSummary, roleSummary: "交付应用" };
      },
      matchJob: async () => decision("apply", "A", "Python")
    }
  });
  const whitespaceRoleRepairResult = await whitespaceRoleRepairRunner(completeJob("understanding-whitespace-role-repair"));
  assert.strictEqual(whitespaceRoleRepairCalls, 2, "空白 roleSummary 必须触发一次既有契约修复");
  assert.strictEqual(whitespaceRoleRepairResult.semanticStatus, "complete");

  // 修复后仍非法：最多再尝试一次修复，随后进入现有失败路径，不得无限重试。
  const stillInvalid = {
    ...understanding("understanding-repair-fails"),
    eligibilityConstraints: [{ type: "学历", value: "本科" }]
  };
  let failedRepairCalls = 0;
  const failingRunner = createJobAnalysisRunner(configFor(["Python", "RAG"]), [], {
    db,
    analyzer: {
      understandJob: async (input) => {
        failedRepairCalls += 1;
        assert(failedRepairCalls <= 2, "understandJob 契约修复最多调用两次");
        if (failedRepairCalls === 2) assert(input.contractRepair, "第二次调用必须携带 contractRepair");
        return stillInvalid;
      },
      matchJob: async () => {
        throw new Error("understandJob 未通过时不得调用 matchJob");
      }
    }
  });
  const failedRepair = await failingRunner(completeJob("understanding-repair-fails"));
  assert.strictEqual(failedRepairCalls, 2, "首次非法输出后只允许一次修复");
  assert.strictEqual(failedRepair.semanticStatus, "failed");
  assert.strictEqual(failedRepair.recommendation, "review");
  assert.strictEqual(failedRepair.errorCode, "MODEL_CONTRACT_INVALID");
  assert.strictEqual(failedRepair.errorStage, "understandJob");
  assert.strictEqual(failedRepair.errorPhase, "contract_repair");
}

function compactCentralRequirementSmoke() {
  const understanding = validateModelResult("understandJob", {
    industryContext: "基础设施",
    roleSummary: "负责大模型推理部署与硬件性能优化",
    responsibilityEvidence: ["JD：负责推理框架部署与硬件性能优化"],
    requirements: [
      {
        label: "推理框架与硬件适配",
        foundation: true,
        central: true,
        indispensable: false,
        evidence: "JD：负责推理框架部署与硬件性能优化"
      },
      {
        label: "基础开发能力",
        foundation: false,
        central: false,
        indispensable: true,
        evidence: "JD：具备一定基础开发能力"
      }
    ],
    eligibility: [],
    riskSignals: []
  });
  assert.strictEqual(understanding.coreRequirements[0].central, true);
  assert.strictEqual(understanding.coreRequirements[1].central, false);

  const legacy = validateModelResult("understandJob", {
    industryContext: "通用软件",
    roleSummary: "负责通用应用开发",
    responsibilityEvidence: ["JD：负责通用应用开发"],
    requirements: [{
      label: "基础开发能力",
      foundation: true,
      indispensable: true,
      evidence: "JD：具备基础开发能力"
    }],
    eligibility: [],
    riskSignals: []
  });
  assert.strictEqual(legacy.coreRequirements[0].central, true);

  const decision = validateModelResult("matchJob", {
    roleAlignment: "partially_aligned",
    roleResumeEvidence: ["简历：完成过企业级 RAG 后端开发"],
    roleGaps: [],
    matches: [{
      id: "R2",
      state: "matched",
      resumeEvidence: "简历：完成过企业级 RAG 后端开发"
    }],
    eligibility: []
  }, { jobUnderstanding: understanding });
  assert.strictEqual(decision.requirementMatches[0].central, true);
  assert.strictEqual(decision.requirementMatches[1].central, false);

  const revalidated = validateModelResult("matchJob", decision, { jobUnderstanding: understanding });
  assert.strictEqual(revalidated.requirementMatches[0].central, true);
  assert.strictEqual(revalidated.requirementMatches[1].central, false);

  const legacyCompact = validateModelResult("matchJob", {
    matches: [
      { id: "R1", state: "unknown", resumeEvidence: "" },
      { id: "R2", state: "matched", resumeEvidence: "简历：完成过企业级 RAG 后端开发" }
    ],
    eligibility: [],
    uncertainties: ["推理部署经验待确认"],
    cautions: [],
    certainty: "low"
  }, { jobUnderstanding: understanding });
  assert.strictEqual(legacyCompact.requirementMatches[0].central, true);
  assert.strictEqual(legacyCompact.requirementMatches[1].central, false);
}

function roleCentralBucketSmoke() {
  const analysis = {
    semanticStatus: "complete",
    recommendation: "review",
    fitLevel: "C",
    confidence: 0.45,
    fitReasons: ["基础开发能力：有直接简历证据"],
    requirementMatches: [
      {
        requirement: "推理框架与硬件适配",
        state: "unknown",
        central: true,
        indispensable: false,
        jdEvidence: "JD：负责推理框架部署与硬件适配",
        resumeEvidence: ""
      },
      {
        requirement: "基础开发能力",
        state: "matched",
        central: false,
        indispensable: true,
        jdEvidence: "JD：具备基础开发能力",
        resumeEvidence: "简历：完成过企业级 RAG 后端开发"
      }
    ],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [],
    evidence: {
      jd: ["JD：具备基础开发能力"],
      resume: ["简历：完成过企业级 RAG 后端开发"]
    }
  };
  assert.deepStrictEqual(roleCoreEvidenceState(analysis), {
    centralRequirementCount: 1,
    centralEvidenceCount: 0,
    unproven: true
  });
  assert.strictEqual(roleCoreEvidenceState({
    requirementMatches: [{
      requirement: "旧格式核心要求",
      state: "unknown",
      indispensable: true,
      jdEvidence: "JD：旧缓存没有 central 字段",
      resumeEvidence: ""
    }]
  }).unproven, true, "旧分析缺少 central 时必须回退到 indispensable");
  assert.strictEqual(
    decisionBucket({ ...completeJob("role-core-unproven"), analysis, qualityTags: [], risks: [] }),
    "backup"
  );
  const guarded = applyRuleGuard(analysis, completeJob("role-core-unproven"));
  assert.strictEqual(guarded.decisionSource, "role_evidence_backup_guard");
  assert.match(guarded.fitReasons[0], /岗位主线.*备选/);

  const riskGuarded = applyRuleGuard({
    ...analysis,
    jobQuality: { level: "risk", concerns: [{ type: "fee_fraud", evidence: "JD：要求付费培训" }] }
  }, completeJob("role-core-risk"));
  assert.strictEqual(riskGuarded.decisionSource, "job_quality_risk_guard");
  assert(!riskGuarded.fitReasons.some((reason) => /岗位主线.*备选/.test(reason)));

  const partialGuarded = applyRuleGuard({
    ...analysis,
    semanticStatus: "partial"
  }, completeJob("role-core-partial"));
  assert.strictEqual(partialGuarded.decisionSource, "model_partial");
  assert(!partialGuarded.fitReasons.some((reason) => /岗位主线.*备选/.test(reason)));

  const transferable = {
    ...analysis,
    requirementMatches: analysis.requirementMatches.map((item, index) => (
      index === 0
        ? { ...item, state: "transferable", resumeEvidence: "简历：完成过模型服务部署与接口集成" }
        : item
    ))
  };
  assert.strictEqual(roleCoreEvidenceState(transferable).unproven, false);
  assert.strictEqual(
    decisionBucket({ ...completeJob("role-core-transferable"), analysis: transferable, qualityTags: [], risks: [] }),
    "talk"
  );
}

function roleEvidenceDecisionStateSmoke() {
  assert.strictEqual(typeof roleEvidenceDecisionState, "function", "shared role evidence decision helper must be exported");
  const matrix = [
    ["aligned", ["matched", "matched"], "primary"],
    ["aligned", ["matched", "unknown"], "talk"],
    ["aligned", ["transferable", "matched"], "talk"],
    ["aligned", ["unknown", "missing"], "backup"],
    ["mostly_aligned", ["matched", "matched"], "talk"],
    ["mostly_aligned", ["matched", "unknown"], "talk"],
    ["mostly_aligned", ["unknown", "missing"], "backup"],
    ["partially_aligned", ["matched"], "backup"],
    ["misaligned", ["matched"], "backup"],
    ["insufficient_evidence", ["matched"], "backup"]
  ];
  for (const [alignment, states, expected] of matrix) {
    assert.strictEqual(
      roleEvidenceDecisionState(layeredRoleAnalysis(alignment, states)).bucketCeiling,
      expected,
      `${alignment} + ${states.join("/")} should have ${expected} ceiling`
    );
  }

  assert.deepStrictEqual(
    roleEvidenceDecisionState(layeredRoleAnalysis("mostly_aligned", ["matched", "unknown", "matched"])),
    {
      semantics: "layered",
      alignment: "mostly_aligned",
      foundationState: "partial",
      foundationRequirementCount: 3,
      foundationPositiveCount: 2,
      hasTransferableFoundation: false,
      bucketCeiling: "talk",
      reasonCode: "role_mostly_aligned"
    }
  );
  const noFoundation = layeredRoleAnalysis("aligned", []);
  assert.strictEqual(roleEvidenceDecisionState(noFoundation).bucketCeiling, "backup");
  assert.strictEqual(
    decisionBucket({ ...completeJob("role-no-foundation"), analysis: noFoundation }),
    "backup",
    "new layered analyses without foundation requirements must stay backup"
  );

  const misaligned = layeredRoleAnalysis("misaligned", ["matched"]);
  assert.strictEqual(
    decisionBucket({ ...completeJob("role-misaligned"), analysis: misaligned }),
    "backup",
    "role misalignment alone must never become not_recommended"
  );
  const blocked = {
    ...misaligned,
    recommendation: "skip",
    fitLevel: "D",
    hardBlockers: [{
      kind: "safety",
      requirement: "No paid onboarding",
      jdEvidence: "JD: paid onboarding required",
      resumeEvidence: "Resume: candidate does not accept paid onboarding"
    }]
  };
  assert.strictEqual(
    decisionBucket({ ...completeJob("role-hard-blocker"), analysis: blocked }),
    "not_recommended",
    "valid structured hard blockers retain priority over the shared ceiling"
  );

  const legacy = {
    requirementMatches: [{
      state: "unknown",
      central: true,
      indispensable: false,
      resumeEvidence: ""
    }]
  };
  const legacyCore = roleCoreEvidenceState(legacy);
  const legacyDecision = roleEvidenceDecisionState(legacy);
  assert.strictEqual(legacyDecision.semantics, "legacy");
  assert.strictEqual(legacyDecision.foundationState, legacyCore.unproven ? "unproven" : "none");
  assert.strictEqual(legacyDecision.bucketCeiling, legacyCore.unproven ? "backup" : "primary");

  const frontend = roleEvidenceDecisionState(layeredRoleAnalysis("misaligned", ["unknown", "missing"]));
  assert.deepStrictEqual(
    {
      roleAlignment: frontend.alignment,
      foundationState: frontend.foundationState,
      bucket: frontend.bucketCeiling
    },
    { roleAlignment: "misaligned", foundationState: "unproven", bucket: "backup" }
  );
  const fullStack = roleEvidenceDecisionState(layeredRoleAnalysis("mostly_aligned", ["matched", "unknown"]));
  assert.deepStrictEqual(
    {
      roleAlignment: fullStack.alignment,
      foundationState: fullStack.foundationState,
      bucket: fullStack.bucketCeiling
    },
    { roleAlignment: "mostly_aligned", foundationState: "partial", bucket: "talk" }
  );

  for (const recommendation of ["review", "caution"]) {
    const original = layeredRoleAnalysis("mostly_aligned", ["matched", "unknown"], { recommendation });
    assert.strictEqual(
      applyRuleGuard(original, completeJob(`role-no-promotion-${recommendation}`)).recommendation,
      recommendation,
      "the shared ceiling must not promote an existing recommendation"
    );
  }

  const lowConfidenceTalk = applyRuleGuard({
    ...layeredRoleAnalysis("mostly_aligned", ["matched", "unknown"]),
    confidence: 0.5
  }, completeJob("role-talk-low-confidence"));
  assert.strictEqual(lowConfidenceTalk.recommendation, "review");
  assert.strictEqual(
    lowConfidenceTalk.decisionSource,
    "model_low_confidence",
    "talk ceiling must not bypass the existing low-confidence review guard"
  );

  const backupGuardCases = [
    [layeredRoleAnalysis("misaligned", ["matched"], { recommendation: "skip" }), {}],
    [layeredRoleAnalysis("misaligned", ["transferable"]), {}],
    [{ ...layeredRoleAnalysis("misaligned", ["matched"]), jobQuality: { level: "caution", concerns: [] } }, {}],
    [{
      ...layeredRoleAnalysis("misaligned", ["matched"]),
      hiddenRisks: [{ severity: "medium", evidence: "JD: confirm delivery ownership" }]
    }, {}],
    [layeredRoleAnalysis("misaligned", ["matched"]), { qualityTags: ["experience_stretch"] }]
  ];
  for (const [analysis, jobOverrides] of backupGuardCases) {
    const guarded = applyRuleGuard(analysis, completeJob("role-backup-precedence", jobOverrides));
    assert.strictEqual(guarded.recommendation, "review", "backup ceiling must cap every non-hard caution guard");
    assert.strictEqual(guarded.decisionSource, "role_evidence_backup_guard");
  }
}

function layeredRoleAnalysis(roleAlignment, states, { recommendation = "apply" } = {}) {
  return {
    semanticStatus: "complete",
    recommendation,
    fitLevel: recommendation === "apply" ? "A" : "C",
    confidence: 0.9,
    roleAlignment,
    requirementMatches: states.map((state, index) => ({
      requirement: `Foundation ${index + 1}`,
      state,
      foundation: true,
      central: false,
      indispensable: true,
      jdEvidence: `JD: Foundation ${index + 1}`,
      resumeEvidence: ["matched", "transferable"].includes(state) ? `Resume: Foundation ${index + 1}` : ""
    })),
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [],
    hiddenRisks: [],
    evidence: { jd: ["JD evidence"], resume: ["Resume evidence"] }
  };
}

async function compactMatchEvidenceContractSmoke() {
  const multiTrackUnderstandingInput = {
    industryContext: "企业 AI 应用",
    hiringTracks: [
      {
        id: "T1",
        label: "大模型应用开发",
        roleSummary: "使用 Python、Agent 与 RAG 交付 AI 应用",
        responsibilityEvidence: ["JD：负责大模型应用和 Agent 工作流落地"]
      },
      {
        id: "T2",
        label: "Python 全栈开发",
        roleSummary: "维护和扩展 Python 全栈业务系统",
        responsibilityEvidence: ["JD：负责 Python 前后端模块开发与上线"]
      },
      {
        id: "T3",
        label: "Python 算法开发",
        roleSummary: "研发并交付深度学习算法",
        responsibilityEvidence: ["JD：负责深度学习算法研发与优化"]
      }
    ],
    requirements: [
      {
        label: "Agent 与 RAG 应用交付",
        trackIds: ["T1"],
        foundation: true,
        central: true,
        indispensable: false,
        evidence: "JD：熟悉 Agent 搭建并有 RAG 项目经验"
      },
      {
        label: "Python 编程",
        trackIds: ["T1", "T2", "T3"],
        foundation: false,
        central: false,
        indispensable: false,
        evidence: "JD：熟练使用 Python"
      },
      {
        label: "前后端模块开发",
        trackIds: ["T2"],
        foundation: true,
        central: true,
        indispensable: false,
        evidence: "JD：负责前后端模块开发"
      },
      {
        label: "深度学习算法研发",
        trackIds: ["T3"],
        foundation: true,
        central: true,
        indispensable: false,
        evidence: "JD：负责深度学习算法研发"
      }
    ],
    eligibility: [],
    riskSignals: []
  };
  const multiTrack = validateModelResult("understandJob", multiTrackUnderstandingInput);
  assert.deepStrictEqual(multiTrack.hiringTracks.map((track) => track.id), ["T1", "T2", "T3"]);
  assert.deepStrictEqual(multiTrack.coreRequirements.map((item) => item.trackIds), [
    ["T1"], ["T1", "T2", "T3"], ["T2"], ["T3"]
  ]);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(multiTrack, "roleSummary"), false,
    "多分支理解不得用第一个分支冒充整个岗位主体");
  assert.deepStrictEqual(
    requirementsForTrack(multiTrack, "T1").map((item) => item.label),
    ["Agent 与 RAG 应用交付", "Python 编程"]
  );

  const selectedT1 = validateModelResult("matchJob", {
    selectedTrackId: "T1",
    roleAlignment: "aligned",
    roleResumeEvidence: ["简历：交付过 Agentic RAG 与 Python API"],
    roleGaps: [],
    matches: [
      { id: "R1", state: "matched", resumeEvidence: "简历：交付过 Agentic RAG" },
      { id: "R2", state: "matched", resumeEvidence: "简历：使用 Python 开发 API" }
    ],
    eligibility: []
  }, { jobUnderstanding: multiTrack });
  assert.strictEqual(selectedT1.selectedTrackId, "T1");
  assert.strictEqual(selectedT1.selectedTrackLabel, "大模型应用开发");
  assert.strictEqual(selectedT1.roleSummary, "使用 Python、Agent 与 RAG 交付 AI 应用");
  assert.deepStrictEqual(
    selectedT1.requirementMatches.map((item) => item.requirement),
    ["Agent 与 RAG 应用交付", "Python 编程"]
  );
  assert(!selectedT1.requirementMatches.some((item) =>
    ["前后端模块开发", "深度学习算法研发"].includes(item.requirement)
  ));

  for (const invalid of [
    {
      selectedTrackId: "T9",
      roleAlignment: "aligned",
      roleResumeEvidence: ["简历：交付过 Agent"],
      roleGaps: [],
      matches: [],
      eligibility: []
    },
    {
      selectedTrackId: "T1",
      roleAlignment: "aligned",
      roleResumeEvidence: ["简历：交付过 Agent"],
      roleGaps: [],
      matches: [{ id: "R3", state: "missing", resumeEvidence: "简历：没有前端经历" }],
      eligibility: []
    }
  ]) {
    assert.throws(
      () => validateModelResult("matchJob", invalid, { jobUnderstanding: multiTrack }),
      (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID"
    );
  }

  const scopedWithEligibility = validateModelResult("understandJob", {
    ...multiTrackUnderstandingInput,
    eligibility: ["JD：本科及以上学历"]
  });
  const selectedWithUnknowns = validateModelResult("matchJob", {
    selectedTrackId: "T1",
    roleAlignment: "mostly_aligned",
    roleResumeEvidence: ["简历：交付过 Agentic RAG"],
    roleGaps: [],
    matches: [{ id: "R2", state: "matched", resumeEvidence: "简历：使用 Python 开发 API" }],
    eligibility: []
  }, { jobUnderstanding: scopedWithEligibility });
  assert.strictEqual(
    selectedWithUnknowns.requirementMatches.find((item) => item.requirement === "Agent 与 RAG 应用交付").state,
    "unknown"
  );
  assert.deepStrictEqual(selectedWithUnknowns.questionsToVerify, [
    "Agent 与 RAG 应用交付的信息待确认",
    "JD：本科及以上学历的资格信息待确认"
  ]);

  const legacyT1Decision = {
    selectedTrackId: "T1",
    recommendation: "apply",
    fitLevel: "A",
    confidence: 0.9,
    fitReasons: ["Agent 与 RAG 应用交付已有简历证据"],
    requirementMatches: [
      { requirement: "Agent 与 RAG 应用交付", state: "matched", indispensable: false, jdEvidence: "JD：熟悉 Agent 搭建并有 RAG 项目经验", resumeEvidence: "简历：交付过 Agentic RAG" },
      { requirement: "Python 编程", state: "matched", indispensable: false, jdEvidence: "JD：熟练使用 Python", resumeEvidence: "简历：使用 Python 开发 API" }
    ],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [],
    softGaps: [],
    questionsToVerify: [],
    evidence: { jd: ["JD：熟悉 Agent 搭建并有 RAG 项目经验"], resume: ["简历：交付过 Agentic RAG"] }
  };
  const compactT1Decision = {
    selectedTrackId: "T1",
    roleAlignment: "aligned",
    roleResumeEvidence: ["简历：交付过 Agentic RAG 与 Python API"],
    roleGaps: [],
    matches: [
      { id: "R1", state: "matched", resumeEvidence: "简历：交付过 Agentic RAG" },
      { id: "R2", state: "matched", resumeEvidence: "简历：使用 Python 开发 API" }
    ],
    eligibility: [],
    uncertainties: [],
    cautions: [],
    certainty: "high"
  };
  for (const legacyPayload of [legacyT1Decision, compactT1Decision]) {
    assert.throws(
      () => validateModelResult("matchJob", legacyPayload, { jobUnderstanding: multiTrack }),
      (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID",
      "多轨岗位不得接受可携带非选中分支自由文本的旧式匹配形状"
    );
  }
  assert.throws(
    () => validateModelResultRaw("matchJob", legacyT1Decision),
    (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID",
    "没有 jobUnderstanding 的旧式完整匹配不得合成 T1"
  );

  const singleTrackInput = {
    industryContext: "企业服务",
    hiringTracks: [{
      id: "T1",
      label: "应用开发",
      roleSummary: "交付应用",
      responsibilityEvidence: ["JD：独立交付应用"]
    }],
    requirements: [{
      label: "独立交付",
      trackIds: ["T1"],
      foundation: true,
      central: true,
      indispensable: true,
      evidence: "JD：独立交付应用"
    }],
    eligibility: [],
    riskSignals: []
  };
  const singleTrack = validateModelResult("understandJob", singleTrackInput);
  assert.strictEqual(singleTrack.roleSummary, "交付应用");
  assert.deepStrictEqual(singleTrack.responsibilityEvidence, ["JD：独立交付应用"]);
  const singleTrackCompact = validateModelResult("matchJob", {
    matches: [{ id: "R1", state: "matched", resumeEvidence: "简历：独立交付过应用" }],
    eligibility: [],
    uncertainties: [],
    cautions: [],
    certainty: "high"
  }, { jobUnderstanding: singleTrack });
  assert.strictEqual(singleTrackCompact.selectedTrackId, "T1");
  const singleTrackFull = validateModelResult("matchJob", {
    recommendation: "apply",
    fitLevel: "A",
    confidence: 0.9,
    fitReasons: ["独立交付已有简历证据"],
    requirementMatches: [{ requirement: "独立交付", state: "matched", indispensable: true, jdEvidence: "JD：独立交付应用", resumeEvidence: "简历：独立交付过应用" }],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [],
    softGaps: [],
    questionsToVerify: [],
    evidence: { jd: ["JD：独立交付应用"], resume: ["简历：独立交付过应用"] }
  }, { jobUnderstanding: singleTrack });
  assert.strictEqual(singleTrackFull.selectedTrackId, "T1");

  const invalidTrackOutputs = [
    { ...multiTrackUnderstandingInput, hiringTracks: [] },
    { ...multiTrackUnderstandingInput, hiringTracks: null },
    { ...multiTrackUnderstandingInput, hiringTracks: [...multiTrackUnderstandingInput.hiringTracks, {
      id: "T4", label: "第四分支", roleSummary: "第四分支交付", responsibilityEvidence: ["JD：第四分支"]
    }, {
      id: "T5", label: "第五分支", roleSummary: "第五分支交付", responsibilityEvidence: ["JD：第五分支"]
    }] },
    { ...multiTrackUnderstandingInput, hiringTracks: [
      multiTrackUnderstandingInput.hiringTracks[0],
      { ...multiTrackUnderstandingInput.hiringTracks[1], id: "T1" }
    ] },
    { ...multiTrackUnderstandingInput, hiringTracks: [
      { ...multiTrackUnderstandingInput.hiringTracks[0], id: "A1" }
    ] },
    { ...multiTrackUnderstandingInput, hiringTracks: [
      { ...multiTrackUnderstandingInput.hiringTracks[0], responsibilityEvidence: [] }
    ] },
    { ...multiTrackUnderstandingInput, requirements: [
      { ...multiTrackUnderstandingInput.requirements[0], trackIds: ["T9"] }
    ] },
    { ...multiTrackUnderstandingInput, requirements: [
      { ...multiTrackUnderstandingInput.requirements[0], trackIds: [] }
    ] }
  ];
  assert.throws(
    () => validateModelResult("understandJob", { ...multiTrackUnderstandingInput, hiringTracks: null }),
    (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID"
  );
  for (const invalid of invalidTrackOutputs) {
    assert.throws(
      () => validateModelResult("understandJob", invalid),
      (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID"
    );
  }
  assert.throws(
    () => validateModelResult("understandJob", {
      ...multiTrackUnderstandingInput,
      requirements: Array.from({ length: 17 }, (_, index) => ({
        ...multiTrackUnderstandingInput.requirements[0],
        label: `超限要求 ${index + 1}`
      }))
    }),
    (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID",
    "新版紧凑 requirements 超过 16 条必须拒绝，不能静默截断"
  );
  for (const [field, fieldValue] of [["jobId", "compact-1"], ["arbitraryField", true]]) {
    assert.throws(
      () => validateModelResult("understandJob", { ...multiTrackUnderstandingInput, [field]: fieldValue }),
      (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID",
      `新版紧凑 understandJob 不得包含顶层 ${field}`
    );
  }

  const compactInput = {
    ...singleTrackInput,
    eligibility: ["JD：本科及以上"]
  };
  const compact = validateModelResult("understandJob", compactInput);
  assert.strictEqual(compact.industryContext, "企业服务");
  assert.strictEqual(compact.coreRequirements[0].id, "R1");
  assert.strictEqual(compact.eligibilityItems[0].id, "E1");
  assert.deepStrictEqual(compact.preferredRequirements, []);
  assert.deepStrictEqual(compact.jobQuality, { level: "normal", concerns: [] });
  assert.doesNotThrow(() => validateModelResult("understandJob", {
    industryContext: "未明确",
    roleSummary: "交付应用",
    responsibilityEvidence: [],
    requirements: [],
    eligibility: [],
    riskSignals: []
  }), "紧凑 understandJob 的空数组仍是合法输出");

  for (const field of ["industryContext", "hiringTracks", "requirements", "eligibility", "riskSignals"]) {
    const missing = { ...compactInput };
    delete missing[field];
    assert.throws(
      () => validateModelResult("understandJob", missing),
      (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID",
      `紧凑 understandJob 缺少 ${field} 必须触发契约修复，不能静默归一化`
    );
  }
  for (const [field, invalidValue] of [["industryContext", []], ["requirements", {}], ["eligibility", "JD：本科及以上"], ["riskSignals", {}]]) {
    assert.throws(
      () => validateModelResult("understandJob", { ...compactInput, [field]: invalidValue }),
      (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID" && error.message.includes(field),
      `紧凑 understandJob 的 ${field} 必须使用正确类型`
    );
  }
  assert.throws(
    () => validateModelResult("understandJob", { ...compactInput, industryContext: "   " }),
    (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID" && /industryContext/.test(error.message),
    "紧凑 industryContext 不能只包含空白字符"
  );
  assert.throws(
    () => validateModelResult("understandJob", {
      ...compactInput,
      hiringTracks: [{ ...compactInput.hiringTracks[0], roleSummary: "   " }]
    }),
    (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID" && /roleSummary/.test(error.message),
    "紧凑 hiringTracks.roleSummary 不能只包含空白字符"
  );
  assert.throws(
    () => validateModelResult("understandJob", { ...compactInput, roleSummary: "交付应用" }),
    (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID" && /roleSummary/.test(error.message),
    "新的紧凑 understandJob 不得混用顶层 roleSummary"
  );
  for (const invalidOutput of [
    { ...compactInput, requirements: [{ ...compactInput.requirements[0], evidence: "JD：" }] },
    { ...compactInput, requirements: [{ ...compactInput.requirements[0], evidence: "JD: 独立交付应用" }] },
    { ...compactInput, requirements: [{ ...compactInput.requirements[0], evidence: `JD：${"x".repeat(118)}` }] },
    { ...compactInput, riskSignals: [{ type: "fee_fraud", severity: "high", evidence: "JD：   " }] },
    { ...compactInput, riskSignals: [{ type: "fee_fraud", severity: "high", evidence: " JD：要求缴纳培训费" }] },
    { ...compactInput, riskSignals: [{ type: "fee_fraud", severity: "high", evidence: `JD：${"x".repeat(118)}` }] }
  ]) {
    assert.throws(
      () => validateModelResult("understandJob", invalidOutput),
      (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID" && /evidence/.test(error.message),
      "无内容的紧凑 evidence 必须在进入 apply 或风险决策前被拒绝；其余 evidence 必须以 JD：开头且最多 120 个 JavaScript 字符"
    );
  }

  const jobUnderstanding = validateModelResult("understandJob", {
    jobId: "compact-1",
    roleSummary: "负责应用交付",
    coreResponsibilities: [],
    responsibilityEvidence: ["JD：负责应用交付"],
    coreRequirements: [
      { label: "独立交付应用", indispensable: true, evidence: "JD：独立完成应用交付" },
      { label: "客户需求沟通", indispensable: false, evidence: "JD：与客户确认需求" }
    ],
    preferredRequirements: [],
    outcomeExpectations: [],
    eligibilityConstraints: ["仅限 2027 届应届生"],
    hiddenRisks: [],
    jobQuality: { level: "normal", concerns: [] },
    evidenceSnippets: ["JD：独立完成应用交付"]
  });
  assert.deepStrictEqual(jobUnderstanding.coreRequirements.map((item) => item.id), ["R1", "R2"]);
  assert.deepStrictEqual(jobUnderstanding.hiringTracks.map((track) => track.id), ["T1"]);
  assert.deepStrictEqual(jobUnderstanding.coreRequirements.map((item) => item.trackIds), [["T1"], ["T1"]]);
  assert.deepStrictEqual(jobUnderstanding.eligibilityItems, [
    { id: "E1", label: "仅限 2027 届应届生" }
  ]);

  const compactDirectPayload = {
    matches: [
      { id: "R1", state: "matched", resumeEvidence: "简历：独立交付过知识库应用" },
      { id: "R2", state: "matched", resumeEvidence: "简历：参与客户需求访谈" }
    ],
    eligibility: [
      { id: "E1", state: "satisfied", resumeEvidence: "简历：2027 届应届生" }
    ],
    uncertainties: [],
    cautions: [],
    certainty: "high"
  };
  const direct = validateModelResult("matchJob", compactDirectPayload, { jobUnderstanding });
  assert.strictEqual(direct.recommendation, "apply");
  assert.strictEqual(direct.fitLevel, "A");
  assert.strictEqual(direct.confidence, 0.9);
  assert.deepStrictEqual(direct.jobQuality, jobUnderstanding.jobQuality);
  assert.strictEqual(direct.requirementMatches[0].requirement, "独立交付应用");
  assert.strictEqual(direct.requirementMatches[0].jdEvidence, "JD：独立完成应用交付");
  assert.deepStrictEqual(direct.hardBlockers, []);
  assert(direct.evidence.jd.includes("JD：独立完成应用交付"));
  assert(direct.evidence.resume.includes("简历：独立交付过知识库应用"));
  const compactNonCoreGap = validateModelResult("matchJob", {
    ...compactDirectPayload,
    matches: [
      compactDirectPayload.matches[0],
      { id: "R2", state: "missing", resumeEvidence: "简历：没有客户需求沟通经历" }
    ]
  }, { jobUnderstanding });
  assert.strictEqual(compactNonCoreGap.recommendation, "apply",
    "旧紧凑路径中的普通附带要求缺口也不得单独阻止主投或可投");
  assert(compactNonCoreGap.softGaps.includes("客户需求沟通未找到直接简历证据"),
    "旧紧凑路径仍必须保留普通附带缺口解释");
  const compactFoundationOnlyUnderstanding = {
    ...jobUnderstanding,
    coreRequirements: [
      { ...jobUnderstanding.coreRequirements[0], foundation: true, central: false, indispensable: false },
      { ...jobUnderstanding.coreRequirements[1], foundation: false, central: false, indispensable: false }
    ]
  };
  const compactFoundationGap = validateModelResult("matchJob", {
    ...compactDirectPayload,
    matches: [
      { id: "R1", state: "missing", resumeEvidence: "简历：没有独立交付应用经历" },
      compactDirectPayload.matches[1]
    ]
  }, { jobUnderstanding: compactFoundationOnlyUnderstanding });
  assert.strictEqual(compactFoundationGap.requirementMatches[0].foundation, true,
    "旧紧凑路径必须继承岗位理解中的 foundation 标记");
  assert.strictEqual(compactFoundationGap.recommendation, "caution",
    "foundation 缺口即使不是 central 或 indispensable，也必须继续影响排序");
  for (const invalidLegacyEvidence of ["简历：", "简历：   ", `简历：${"x".repeat(118)}`]) {
    assert.throws(() => validateModelResult("matchJob", {
      ...compactDirectPayload,
      matches: [{ ...compactDirectPayload.matches[0], resumeEvidence: invalidLegacyEvidence }, compactDirectPayload.matches[1]]
    }, { jobUnderstanding }), ModelContractError,
    "legacy compact evidence must reject an empty or overlong 简历： value before it can reach apply");
  }
  const sparseRoleEvidence = {
    roleAlignment: "mostly_aligned",
    roleResumeEvidence: ["简历：独立交付过知识库应用"],
    roleGaps: []
  };
  const sparse = validateModelResult("matchJob", {
    ...sparseRoleEvidence,
    matches: [{ id: "R1", state: "matched", resumeEvidence: "简历：独立交付过知识库应用" }],
    eligibility: []
  }, { jobUnderstanding });
  assert.strictEqual(sparse.requirementMatches.find((item) => item.requirement === "客户需求沟通").state, "unknown");
  assert.strictEqual(sparse.recommendation, "review", "omitted evidence rows must stay conservative");
  const sparseDirect = validateModelResult("matchJob", {
    ...sparseRoleEvidence,
    matches: compactDirectPayload.matches,
    eligibility: compactDirectPayload.eligibility
  }, { jobUnderstanding });
  assert.strictEqual(sparseDirect.recommendation, "apply");
  assert.strictEqual(sparseDirect.confidence, 0.9);
  const sparseNonCoreGap = validateModelResult("matchJob", {
    ...sparseRoleEvidence,
    matches: [
      compactDirectPayload.matches[0],
      { id: "R2", state: "missing", resumeEvidence: "简历：没有客户需求沟通经历" }
    ],
    eligibility: compactDirectPayload.eligibility
  }, { jobUnderstanding });
  assert.strictEqual(sparseNonCoreGap.requirementMatches.find((item) => item.requirement === "客户需求沟通").state, "missing");
  assert.strictEqual(sparseNonCoreGap.recommendation, "apply",
    "普通附带要求缺口必须保留说明，但不得单独阻止主投或可投");
  assert(sparseNonCoreGap.softGaps.includes("客户需求沟通缺少直接简历证据"),
    "普通附带要求缺口仍必须保留在解释中");
  assert.strictEqual(sparseNonCoreGap.confidence, 0.9);
  assert.deepStrictEqual(sparseNonCoreGap.hardBlockers, []);
  for (const invalidSparse of [
    { matches: [{ id: "R9", state: "matched", resumeEvidence: "简历：虚构" }], eligibility: [] },
    { matches: [{ id: "R1", state: "matched", resumeEvidence: "简历：事实" }, { id: "R1", state: "matched", resumeEvidence: "简历：重复" }], eligibility: [] },
    { matches: [{ id: "R1", state: "invalid", resumeEvidence: "简历：事实" }], eligibility: [] },
    { matches: [{ id: "R1", state: "matched", resumeEvidence: "没有前缀" }], eligibility: [] },
    { matches: [{ id: "R1", state: "matched", resumeEvidence: "简历：   " }], eligibility: [] }
  ]) {
    assert.throws(() => validateModelResult("matchJob", invalidSparse, { jobUnderstanding }), ModelContractError,
      "sparse evidence must keep ID, enum, duplicate, and concrete-evidence guards");
  }
  const transferable = validateModelResult("matchJob", {
    matches: [
      { id: "R1", state: "transferable", resumeEvidence: "简历：独立交付过内部工具" },
      { id: "R2", state: "unknown", resumeEvidence: "" }
    ],
    eligibility: [{ id: "E1", state: "unknown", resumeEvidence: "" }],
    uncertainties: ["客户沟通深度待确认"],
    cautions: [],
    certainty: "medium"
  }, { jobUnderstanding });
  assert.strictEqual(transferable.recommendation, "review", "unknown 信息优先进入 review，不得因可迁移证据直接放行");

  const transferableOnly = validateModelResult("matchJob", {
    matches: [
      { id: "R1", state: "transferable", resumeEvidence: "简历：独立交付过内部工具" },
      { id: "R2", state: "matched", resumeEvidence: "简历：参与客户需求访谈" }
    ],
    eligibility: [{ id: "E1", state: "satisfied", resumeEvidence: "简历：2027 届应届生" }],
    uncertainties: [],
    cautions: [],
    certainty: "medium"
  }, { jobUnderstanding });
  assert.strictEqual(transferableOnly.recommendation, "caution");
  assert.strictEqual(transferableOnly.fitLevel, "B");

  const hardMissing = validateModelResult("matchJob", {
    matches: [
      { id: "R1", state: "unknown", resumeEvidence: "" },
      { id: "R2", state: "not_applicable", resumeEvidence: "" }
    ],
    eligibility: [{ id: "E1", state: "satisfied", resumeEvidence: "简历：2027 届应届生" }],
    uncertainties: [],
    cautions: [],
    certainty: "high"
  }, { jobUnderstanding });
  assert.notStrictEqual(hardMissing.recommendation, "skip", "没有候选人事实证据时不得把 missing 提升为硬淘汰");
  assert.deepStrictEqual(hardMissing.hardBlockers, []);
  assert.doesNotThrow(() => validateModelResult("matchJob", hardMissing, { jobUnderstanding }), "紧凑结果归一化后必须仍能通过既有 MatchDecision 边界");

  for (const inferredAbsence of [
    "简历：未体现独立交付应用的经历",
    "简历：现有项目技术栈为 Python 和 Node.js",
    "简历：不能确认是否有独立交付经验",
    "简历：候选人仅参与过项目中的接口开发"
  ]) {
    const absenceOnly = validateModelResult("matchJob", {
      ...compactDirectPayload,
      matches: [
        { id: "R1", state: "missing", resumeEvidence: inferredAbsence },
        compactDirectPayload.matches[1]
      ]
    }, { jobUnderstanding });
    assert.notStrictEqual(absenceOnly.recommendation, "skip",
      "未写某项能力或只列出其他技术栈，不是候选人明确不兼容的证据");
    assert.strictEqual(absenceOnly.requirementMatches[0].state, "unknown");
    assert.deepStrictEqual(absenceOnly.hardBlockers, []);
  }

  const eligibilityConflict = validateModelResult("matchJob", {
    matches: [
      { id: "R1", state: "matched", resumeEvidence: "简历：独立交付过知识库应用" },
      { id: "R2", state: "matched", resumeEvidence: "简历：参与客户需求访谈" }
    ],
    eligibility: [{ id: "E1", state: "conflict", resumeEvidence: "简历：2025 届毕业" }],
    uncertainties: [],
    cautions: [],
    certainty: "high"
  }, { jobUnderstanding });
  assert.strictEqual(eligibilityConflict.recommendation, "skip");
  assert.strictEqual(eligibilityConflict.hardBlockers[0].kind, "eligibility");
  assert.doesNotThrow(() => validateModelResult("matchJob", eligibilityConflict, { jobUnderstanding }), "有双侧证据的资格冲突必须兼容既有下游契约");
  const shortCohortConflict = validateModelResult("matchJob", {
    ...compactDirectPayload,
    eligibility: [{ id: "E1", state: "conflict", resumeEvidence: "简历：25 届毕业" }]
  }, { jobUnderstanding });
  assert.strictEqual(shortCohortConflict.recommendation, "skip", "两位数届别的明确冲突仍可硬排除");
  for (const [label, resumeEvidence] of [
    ["仅限 2025 届或 2026 届", "简历：2026 届毕业"],
    ["仅限 2025、2026 届", "简历：2025 届毕业"],
    ["仅限 25/26 届", "简历：25 届毕业"],
    ["仅限 2025-2027 届", "简历：2026 届毕业"],
    ["仅限 2025 届及以后", "简历：2026 届毕业"],
    ["仅限 2025 届以前", "简历：2024 届毕业"]
  ]) {
    const allowedCohortUnderstanding = {
      ...jobUnderstanding,
      eligibilityConstraints: [label],
      eligibilityItems: [{ id: "E1", label }]
    };
    const allowedCohort = validateModelResult("matchJob", {
      ...compactDirectPayload,
      eligibility: [{ id: "E1", state: "conflict", resumeEvidence }]
    }, { jobUnderstanding: allowedCohortUnderstanding });
    assert.notStrictEqual(allowedCohort.recommendation, "skip", `${label} 范围内的届别不得硬排除`);
    assert.deepStrictEqual(allowedCohort.hardBlockers, []);
  }
  const entryYearMustNotMaskGraduationConflict = validateModelResult("matchJob", {
    ...compactDirectPayload,
    eligibility: [{ id: "E1", state: "conflict", resumeEvidence: "简历：2027 年入学，2031 届毕业" }]
  }, { jobUnderstanding });
  assert.strictEqual(entryYearMustNotMaskGraduationConflict.recommendation, "skip",
    "入学年份不得冒充毕业届别，遮住明确的毕业届别冲突");
  const eligibilityUnknown = validateModelResult("matchJob", {
    ...compactDirectPayload,
    eligibility: [{ id: "E1", state: "conflict", resumeEvidence: "简历：未提供届别或学历信息" }]
  }, { jobUnderstanding });
  assert.notStrictEqual(eligibilityUnknown.recommendation, "skip",
    "资格信息缺失只能进入待确认，不能作为明确资格冲突");
  assert.deepStrictEqual(eligibilityUnknown.hardBlockers, []);
  const eligibilityUncertain = validateModelResult("matchJob", {
    ...compactDirectPayload,
    eligibility: [{ id: "E1", state: "conflict", resumeEvidence: "简历：候选人可能为 2025 届" }]
  }, { jobUnderstanding });
  assert.notStrictEqual(eligibilityUncertain.recommendation, "skip",
    "带有可能、似乎等不确定措辞的资格判断只能进入待确认");
  assert.deepStrictEqual(eligibilityUncertain.hardBlockers, []);

  for (const invalid of [
    { ...compactDirectPayload, matches: compactDirectPayload.matches.slice(0, 1) },
    {
      matches: [
        { id: "R1", state: "matched", resumeEvidence: "简历：证据" },
        { id: "R1", state: "matched", resumeEvidence: "简历：重复" }
      ],
      eligibility: [{ id: "E1", state: "satisfied", resumeEvidence: "简历：2027 届应届生" }],
      uncertainties: [],
      cautions: [],
      certainty: "high"
    },
    {
      matches: [
        { id: "R1", state: "matched", resumeEvidence: "简历：证据" },
        { id: "R9", state: "matched", resumeEvidence: "简历：虚构" }
      ],
      eligibility: [{ id: "E1", state: "satisfied", resumeEvidence: "简历：2027 届应届生" }],
      uncertainties: [],
      cautions: [],
      certainty: "high"
    }
  ]) {
    assert.throws(
      () => validateModelResult("matchJob", invalid, { jobUnderstanding }),
      (error) => error instanceof ModelContractError && /matches|R/.test(error.message)
    );
  }

  assert.throws(() => validateModelResult("matchJob", {
    matches: [
      { id: "R1", state: "matched", resumeEvidence: "" },
      { id: "R2", state: "unknown", resumeEvidence: "" }
    ],
    eligibility: [{ id: "E1", state: "unknown", resumeEvidence: "" }],
    uncertainties: [],
    cautions: [],
    certainty: "high"
  }, { jobUnderstanding }), (error) => error instanceof ModelContractError && /resumeEvidence/.test(error.message));

  for (const invalid of [
    { ...compactDirectPayload, eligibility: [] },
    {
      ...compactDirectPayload,
      eligibility: [
        { id: "E1", state: "satisfied", resumeEvidence: "" },
        { id: "E1", state: "unknown", resumeEvidence: "" }
      ]
    },
    {
      ...compactDirectPayload,
      eligibility: [{ id: "E9", state: "unknown", resumeEvidence: "" }]
    },
    {
      ...compactDirectPayload,
      eligibility: [{ id: "E1", state: "conflict", resumeEvidence: "" }]
    },
    {
      ...compactDirectPayload,
      eligibility: [{ id: "E1", state: "satisfied", resumeEvidence: "" }]
    },
    { ...compactDirectPayload, certainty: "certain" }
  ]) {
    assert.throws(
      () => validateModelResult("matchJob", invalid, { jobUnderstanding }),
      (error) => error instanceof ModelContractError
    );
  }

  const unresolved = validateModelResult("matchJob", {
    ...compactDirectPayload,
    uncertainties: ["实际工作制待确认"]
  }, { jobUnderstanding });
  assert.strictEqual(unresolved.recommendation, "review", "仍有待确认问题时不得进入主投");

  const preferredGap = validateModelResult("matchJob", {
    ...compactDirectPayload,
    cautions: [{ kind: "preferred_gap", detail: "加分项中的行业经验没有直接简历证据" }]
  }, { jobUnderstanding });
  assert(preferredGap.softGaps.includes("加分项中的行业经验没有直接简历证据"));
  assert.strictEqual(preferredGap.recommendation, "apply", "普通加分项缺口不得单独阻止主投");

  const transitionRisk = validateModelResult("matchJob", {
    ...compactDirectPayload,
    cautions: [{ kind: "candidate_transition", detail: "该方向仅属于用户确认的谨慎转向" }]
  }, { jobUnderstanding });
  assert.strictEqual(transitionRisk.recommendation, "caution", "用户确认的谨慎转向仍必须降为先沟通");

  const evidencedCoreConflict = validateModelResult("matchJob", {
    ...compactDirectPayload,
    matches: [
      { id: "R1", state: "missing", resumeEvidence: "简历：现有项目只承担辅助配置工作，未独立交付应用" },
      compactDirectPayload.matches[1]
    ]
  }, { jobUnderstanding });
  assert.notStrictEqual(evidencedCoreConflict.recommendation, "skip", "过去职责有限或未曾独立交付仍是经历缺口，不是明确拒绝或不能");
  assert.deepStrictEqual(evidencedCoreConflict.hardBlockers, []);
  assert.doesNotThrow(() => validateModelResult("matchJob", evidencedCoreConflict, { jobUnderstanding }));
  const explicitCoreConflict = validateModelResult("matchJob", {
    ...compactDirectPayload,
    matches: [
      { id: "R1", state: "missing", resumeEvidence: "简历：候选人明确不接受独立交付职责" },
      compactDirectPayload.matches[1]
    ]
  }, { jobUnderstanding });
  assert.strictEqual(explicitCoreConflict.recommendation, "skip", "候选人明确拒绝核心职责时仍可硬淘汰");
  assert.strictEqual(explicitCoreConflict.hardBlockers[0].resumeEvidence, "简历：候选人明确不接受独立交付职责");
  assert.doesNotThrow(() => validateModelResult("matchJob", explicitCoreConflict, { jobUnderstanding }));

  const riskyUnderstanding = {
    ...jobUnderstanding,
    hiddenRisks: [{ type: "fee_fraud", severity: "high", evidence: "JD：入职前需要支付培训费" }],
    jobQuality: { level: "risk", concerns: [{ type: "fee_fraud", evidence: "JD：入职前需要支付培训费" }] }
  };
  const risky = validateModelResult("matchJob", compactDirectPayload, { jobUnderstanding: riskyUnderstanding });
  assert.strictEqual(risky.recommendation, "review", "模型传输层只保留证据，安全风险由最终本地规则做 skip");
  assert.doesNotThrow(() => validateModelResult("matchJob", risky, { jobUnderstanding: riskyUnderstanding }));

  const sparseUnderstanding = validateModelResult("understandJob", {
    ...jobUnderstanding,
    coreRequirements: [],
    eligibilityConstraints: []
  });
  const sparseDecision = validateModelResult("matchJob", {
    matches: [],
    eligibility: [],
    uncertainties: [],
    cautions: [],
    certainty: "low"
  }, { jobUnderstanding: sparseUnderstanding });
  assert.strictEqual(sparseDecision.recommendation, "review");
  assert(sparseDecision.softGaps.some((item) => item.includes("信息不足")));
  assert.doesNotThrow(
    () => validateModelResult("matchJob", sparseDecision, { jobUnderstanding: sparseUnderstanding }),
    "稀疏 JD 的紧凑结果归一化后必须能通过既有 review 契约"
  );

  const tenureUnderstanding = validateModelResult("understandJob", {
    ...jobUnderstanding,
    coreRequirements: [{ label: "3 年以上相关经验", indispensable: true, evidence: "JD：要求 3 年以上相关经验" }],
    eligibilityConstraints: []
  });
  const tenureGap = validateModelResult("matchJob", {
    matches: [{ id: "R1", state: "missing", resumeEvidence: "" }],
    eligibility: [],
    uncertainties: [],
    cautions: [],
    certainty: "high"
  }, { jobUnderstanding: tenureUnderstanding });
  assert.notStrictEqual(tenureGap.recommendation, "skip", "经验年限即使被误标 indispensable 也不得成为硬淘汰");
  assert.deepStrictEqual(tenureGap.hardBlockers, []);

  const evidencedTenureGap = validateModelResult("matchJob", {
    matches: [{ id: "R1", state: "missing", resumeEvidence: "简历：仅有 1 年相关经验" }],
    eligibility: [],
    uncertainties: [],
    cautions: [],
    certainty: "high"
  }, { jobUnderstanding: tenureUnderstanding });
  assert.notStrictEqual(evidencedTenureGap.recommendation, "skip", "有真实简历证据的经验年限差距仍不得成为硬淘汰");
  assert.deepStrictEqual(evidencedTenureGap.hardBlockers, []);
  assert.doesNotThrow(
    () => validateModelResult("matchJob", evidencedTenureGap, { jobUnderstanding: tenureUnderstanding }),
    "经验年限软差距归一化后必须兼容既有 MatchDecision 契约"
  );

  const workHistoryUnderstanding = validateModelResult("understandJob", {
    ...jobUnderstanding,
    coreRequirements: [{ label: "3 年以上相关工作经历", indispensable: true, evidence: "JD：要求 3 年以上相关工作经历" }],
    eligibilityConstraints: []
  });
  const workHistoryGap = validateModelResult("matchJob", {
    matches: [{ id: "R1", state: "missing", resumeEvidence: "简历：仅有 1 年相关工作经历" }],
    eligibility: [],
    uncertainties: [],
    cautions: [],
    certainty: "high"
  }, { jobUnderstanding: workHistoryUnderstanding });
  assert.notStrictEqual(workHistoryGap.recommendation, "skip", "工作经历写法的年限差距不得成为硬淘汰");
  assert.deepStrictEqual(workHistoryGap.hardBlockers, []);

  const chineseYearsUnderstanding = validateModelResult("understandJob", {
    ...jobUnderstanding,
    coreRequirements: [{ label: "两年以上工作经验", indispensable: true, evidence: "JD：要求两年以上工作经验" }],
    eligibilityConstraints: []
  });
  const chineseYearsGap = validateModelResult("matchJob", {
    matches: [{ id: "R1", state: "missing", resumeEvidence: "简历：仅有 1 年相关工作经历" }],
    eligibility: [],
    uncertainties: [],
    cautions: [],
    certainty: "high"
  }, { jobUnderstanding: chineseYearsUnderstanding });
  assert.notStrictEqual(chineseYearsGap.recommendation, "skip", "中文“两年”写法的年限差距不得成为硬淘汰");
  assert.deepStrictEqual(chineseYearsGap.hardBlockers, []);
}

function roleAlignmentEvidenceContractSmoke() {
  const jobUnderstanding = {
    roleSummary: "企业系统交付",
    responsibilityEvidence: ["JD：负责企业系统前后端交付"],
    coreRequirements: [{
      id: "R1",
      label: "企业系统交付",
      foundation: true,
      central: true,
      indispensable: false,
      evidence: "JD：负责企业系统前后端交付"
    }],
    eligibilityItems: [],
    jobQuality: { level: "normal", concerns: [] }
  };
  const sparse = {
    roleAlignment: "mostly_aligned",
    roleResumeEvidence: ["简历：使用 Python/FastAPI 参与业务系统后端开发"],
    roleGaps: ["前端交付尚未证明"],
    matches: [{
      id: "R1",
      state: "matched",
      foundation: false,
      central: false,
      indispensable: true,
      resumeEvidence: "简历：使用 Python 开发接口"
    }],
    eligibility: []
  };
  const normalized = validateModelResult("matchJob", sparse, { jobUnderstanding });
  assert.strictEqual(normalized.roleAlignment, "mostly_aligned");
  assert.deepStrictEqual(normalized.roleResumeEvidence, sparse.roleResumeEvidence);
  assert.deepStrictEqual(normalized.roleGaps, sparse.roleGaps);
  assert.deepStrictEqual(
    normalized.requirementMatches.map(({ foundation, central, indispensable }) => ({ foundation, central, indispensable })),
    [{ foundation: true, central: true, indispensable: false }],
    "normalized requirement matches must inherit every role flag from jobUnderstanding"
  );

  for (const invalid of [
    (() => { const value = { ...sparse }; delete value.roleAlignment; return value; })(),
    { ...sparse, roleAlignment: "close_enough" },
    { ...sparse, roleResumeEvidence: "简历：使用 Python/FastAPI 参与业务系统后端开发" },
    { ...sparse, roleGaps: "前端交付尚未证明" },
    { ...sparse, roleResumeEvidence: ["使用 Python/FastAPI 参与业务系统后端开发"] },
    { ...sparse, roleAlignment: "aligned", roleResumeEvidence: [] },
    { ...sparse, roleAlignment: "mostly_aligned", roleResumeEvidence: [] },
    { ...sparse, roleAlignment: "partially_aligned", roleResumeEvidence: [] },
    { ...sparse, roleAlignment: "misaligned", roleResumeEvidence: [], roleGaps: ["前端交付尚未证明"] },
    { ...sparse, roleAlignment: "misaligned", roleGaps: [] },
    { ...sparse, roleAlignment: "insufficient_evidence", roleGaps: [] }
  ]) {
    assert.throws(
      () => validateModelResult("matchJob", invalid, { jobUnderstanding }),
      (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID",
      "sparse role alignment fields must be strict evidence-bearing contract fields"
    );
  }
  assert.throws(
    () => validateModelResult("matchJob", sparse, {
      jobUnderstanding: { ...jobUnderstanding, responsibilityEvidence: [] }
    }),
    ModelContractError,
    "empty responsibility evidence may only return insufficient_evidence"
  );
  assert.throws(
    () => validateModelResult("matchJob", {
      ...sparse,
      roleAlignment: "misaligned"
    }, { jobUnderstanding: { ...jobUnderstanding, responsibilityEvidence: [] } }),
    ModelContractError,
    "misaligned cannot replace missing responsibility evidence"
  );
  assert.doesNotThrow(() => validateModelResult("matchJob", {
    ...sparse,
    roleAlignment: "insufficient_evidence",
    roleResumeEvidence: [],
    roleGaps: ["JD 未提供可核对的具体职责"]
  }, { jobUnderstanding: { ...jobUnderstanding, responsibilityEvidence: [] } }));

  const historicalDecision = decision("apply", "A", "Python");
  delete historicalDecision.roleAlignment;
  delete historicalDecision.roleResumeEvidence;
  delete historicalDecision.roleGaps;
  const historical = validateModelResult("matchJob", historicalDecision);
  assert.deepStrictEqual(
    {
      roleAlignment: historical.roleAlignment,
      roleResumeEvidence: historical.roleResumeEvidence,
      roleGaps: historical.roleGaps
    },
    { roleAlignment: "", roleResumeEvidence: [], roleGaps: [] },
    "legacy normalized decisions without role alignment retain historical semantics"
  );
}

function understanding(jobId) {
  return {
    jobId,
    industryContext: "企业服务",
    realRoleType: "ai_application",
    roleSummary: "Enterprise knowledge-base application development",
    responsibilityEvidence: ["JD：负责 RAG 知识库与 Agent 应用开发"],
    businessScenario: "企业知识库",
    coreResponsibilities: [{ label: "企业知识库应用开发", evidence: "JD：负责 RAG 知识库和 Agent 应用开发" }],
    coreRequirements: [
      { label: "Python", foundation: true, indispensable: true, evidence: "JD：熟练使用 Python" },
      { label: "RAG", indispensable: true, evidence: "JD：负责 RAG 知识库建设" }
    ],
    preferredRequirements: [],
    outcomeExpectations: [],
    niceToHave: ["Agent"],
    senioritySignal: "junior",
    hiddenRisks: [],
    jobQuality: { level: "normal", concerns: [] },
    evidenceSnippets: ["熟练使用 Python，负责 RAG 知识库和 Agent 应用开发"]
  };
}

function decision(recommendation, fitLevel, resumeEvidence) {
  return {
    recommendation,
    fitLevel,
    roleAlignment: "aligned",
    roleResumeEvidence: [`简历：${resumeEvidence}`],
    roleGaps: [],
    confidence: 0.88,
    fitReasons: ["岗位核心职责与候选人的 Python/RAG 项目经验对应"],
    requirementMatches: [
      { requirement: "Python", state: "matched", foundation: true, indispensable: true, jdEvidence: "JD：熟练使用 Python", resumeEvidence: `简历：${resumeEvidence}` },
      { requirement: "RAG", state: "matched", indispensable: true, jdEvidence: "JD：负责 RAG 知识库建设", resumeEvidence: `简历：${resumeEvidence}` }
    ],
    jobQuality: { level: "normal", concerns: [] },
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
