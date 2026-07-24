const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadConfigs } = require("../src/config");
const { createJobAnalysisRunner, cachedModelCall, applyRuleGuard } = require("../src/core/job_analysis");
const { createLlmAnalyzer } = require("../src/core/llm_analyzer");
const { validateModelResult, ModelContractError, effectiveHardBlockers, decisionHardBlockers } = require("../src/core/model_contract");
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
    await pipelineVersionCacheSmoke();
    await ruleGuardSmoke();
    await localEvidenceGuardSmoke();
    await matchingCardContractSmoke();
    await genericEvidenceContractSmoke();
    matchGenericContractSmoke();
    matchBoundaryContractSmoke();
    genericPolicySmoke();
    staleAnalysisSmoke();
    matchingCardStaleSmoke();
    runtimeResumeVersionEntrySmoke();
    understandingContractSmoke();
    matchUnderstandingAlignmentSmoke();
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
    fitReasons: ["核心必备要求完全无证据"],
    requirementMatches: [{
      requirement: "JAVA 核心开发",
      state: "missing",
      indispensable: true,
      jdEvidence: "JD：必须精通 Java 与 Spring Boot",
      resumeEvidence: "简历：候选人为 Python 项目经历"
    }],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [{
      kind: "indispensable_core",
      requirement: "JAVA 核心开发",
      jdEvidence: "JD：必须精通 Java 与 Spring Boot",
      resumeEvidence: "简历：候选人为 Python 项目经历"
    }],
    softGaps: [],
    questionsToVerify: [],
    evidence: { jd: ["JD：必须精通 Java 与 Spring Boot"], resume: ["简历：候选人为 Python 项目经历"] }
  };
  const skipValidated = validateModelResult("matchJob", validSkip);
  assert.strictEqual(skipValidated.recommendation, "skip");
  assert.strictEqual(skipValidated.hardBlockers[0].kind, "indispensable_core");

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

  const sparse = validateModelResult("understandJob", {
    ...validUnderstanding,
    coreResponsibilities: [], coreRequirements: [], preferredRequirements: [], outcomeExpectations: [], hiddenRisks: []
  });
  assert.deepStrictEqual(sparse.coreRequirements, [], "空数组本身合法");

  assert.throws(() => validateModelResult("understandJob", { ...validUnderstanding, coreRequirements: ["Java"] }),
    (error) => error instanceof ModelContractError && /coreRequirements/.test(error.message), "字符串型 coreRequirements 必须拒绝");
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

function matchUnderstandingAlignmentSmoke() {
  // MatchDecision 必须与本次 JobUnderstanding 一一核对：漏项、重复、虚构、改 indispensable 全部进入契约修复。
  const jobUnderstanding = {
    coreRequirements: [
      { label: "投放 ROI 复盘", indispensable: true, evidence: "JD：必须独立完成投放 ROI 复盘" },
      { label: "店铺活动运营", indispensable: false, evidence: "JD：负责店铺活动运营" }
    ]
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
  assert.throws(() => validateModelResult("matchJob", { ...baseDecision, requirementMatches: [...baseDecision.requirementMatches, baseDecision.requirementMatches[0]] }, { jobUnderstanding }),
    (error) => error instanceof ModelContractError && /requirementMatches|重复/.test(error.message), "重复核心项必须拒绝");
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
  }, { jobUnderstanding: { coreRequirements: [] } }),
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
  }, { jobUnderstanding: { coreRequirements: [] } });
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
  const hard = validateModelResult("matchJob", {
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
  });
  assert.strictEqual(hard.hardBlockers.length, 1);
  assert.strictEqual(hard.hardBlockers[0].kind, "indispensable_core");
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
    coreResponsibilities: [{ label: "企业知识库应用开发", evidence: "JD：负责 RAG 知识库和 Agent 应用开发" }],
    coreRequirements: [
      { label: "Python", indispensable: true, evidence: "JD：熟练使用 Python" },
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
    confidence: 0.88,
    fitReasons: ["岗位核心职责与候选人的 Python/RAG 项目经验对应"],
    requirementMatches: [
      { requirement: "Python", state: "matched", indispensable: true, jdEvidence: "JD：熟练使用 Python", resumeEvidence: `简历：${resumeEvidence}` },
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
