"use strict";
const assert = require("node:assert/strict");
const {
  openDb,
  createBatch,
  createScanRun,
  createWorkflowRun,
  attachWorkflowScan,
  transitionWorkflowRun,
  upsertJob,
  getWorkflowRun,
  listReportJobs
} = require("../src/core/storage");
const { createJobAnalysisRunner, runWorkflowAnalysisPhase } = require("../src/core/job_analysis");
const { listWorkflowJobTasks } = require("../src/core/workflow_analysis_tasks");

(async () => {
  try {
    await crashPreservesIncrementalResultsSmoke();
    await resumedBatchClaimsOnlyPendingSmoke();
    await reportOnlyAfterDrainedReviewSmoke();
    await runnerErrorModeSmoke();
    console.log("workflow_scan_analysis_smoke ok");
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();

async function crashPreservesIncrementalResultsSmoke() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      localDay: "2026-08-30",
      analyses: [
        { semanticStatus: "pending", decisionSource: "analysis_pending" },
        { semanticStatus: "pending", decisionSource: "analysis_pending" },
        { semanticStatus: "pending", decisionSource: "analysis_pending" },
        { semanticStatus: "pending", decisionSource: "analysis_pending" },
        { semanticStatus: "pending", decisionSource: "analysis_pending" }
      ],
      modelConfigRevision: "phase-crash"
    });
    const renderCalls = [];
    const result = await runWorkflowAnalysisPhase(db, {
      workflowRun: getWorkflowRun(db, scenario.workflowId),
      batchId: scenario.batchId,
      jobsToAnalyze: reportJobsAscending(db, scenario.batchId),
      configs: {},
      keywordPlan: [],
      logger: silentLogger(),
      signal: null,
      modelRuntimes: { primary: { ...primaryRuntime(), concurrency: 1 }, backup: null },
      createAnalyzeJob: () => async (job) => {
        if (job.sourceId === scenario.sourceIds[2]) {
          throw Object.assign(new Error("executor crashed"), {
            code: "WORKFLOW_EXECUTOR_CRASH",
            stage: "execute"
          });
        }
        return analyzedJob(job);
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      now: fixedClock("2026-08-30T00:05:00.000Z"),
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {},
      renderReports: () => renderCalls.push("render")
    });
    assert.strictEqual(result.status, "interrupted");
    assert.strictEqual(result.claimed, 3);
    assert.strictEqual(result.succeeded, 2);
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.deepStrictEqual(
      tasks.map((task) => task.status),
      ["succeeded", "succeeded", "running", "pending", "pending"]
    );
    for (const jobId of [scenario.jobIds[0], scenario.jobIds[1]]) {
      const saved = db.prepare(
        "SELECT analysis_json FROM job_observations WHERE job_id = ? AND batch_id = ?"
      ).get(jobId, scenario.batchId);
      assert.strictEqual(JSON.parse(saved.analysis_json).semanticStatus, "complete");
    }
    assert.strictEqual(getWorkflowRun(db, scenario.workflowId).status, "interrupted");
    assert.deepStrictEqual(renderCalls, []);
  } finally {
    db.close();
  }
}

async function resumedBatchClaimsOnlyPendingSmoke() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      localDay: "2026-08-31",
      analyses: [
        { semanticStatus: "complete", decisionSource: "model" },
        { semanticStatus: "rule_only", decisionSource: "local_rules" },
        { semanticStatus: "pending", decisionSource: "analysis_pending" },
        { semanticStatus: "failed", decisionSource: "analysis_pending" }
      ],
      modelConfigRevision: "phase-resume"
    });
    const called = [];
    const result = await runWorkflowAnalysisPhase(db, {
      workflowRun: getWorkflowRun(db, scenario.workflowId),
      batchId: scenario.batchId,
      jobsToAnalyze: reportJobsAscending(db, scenario.batchId),
      configs: {},
      keywordPlan: [],
      logger: silentLogger(),
      signal: null,
      modelRuntimes: { primary: { ...primaryRuntime(), concurrency: 1 }, backup: null },
      createAnalyzeJob: () => async (job) => {
        called.push(job.sourceId);
        return analyzedJob(job);
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      now: fixedClock("2026-08-31T00:05:00.000Z"),
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    assert.strictEqual(result.status, "drained");
    assert.strictEqual(result.claimed, 2);
    assert.strictEqual(result.succeeded, 2);
    assert.deepStrictEqual(called, [scenario.sourceIds[2], scenario.sourceIds[3]]);
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.deepStrictEqual(
      tasks.map((task) => task.status),
      ["succeeded", "skipped", "succeeded", "succeeded"]
    );
  } finally {
    db.close();
  }
}

async function reportOnlyAfterDrainedReviewSmoke() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      localDay: "2026-09-01",
      analyses: [
        { semanticStatus: "pending", decisionSource: "analysis_pending" },
        { semanticStatus: "pending", decisionSource: "analysis_pending" },
        { semanticStatus: "pending", decisionSource: "analysis_pending" }
      ],
      modelConfigRevision: "phase-report"
    });

    let renderCalls = 0;
    let renderedJobs = [];
    let statusAtRender = "";
    const result = await runWorkflowAnalysisPhase(db, {
      workflowRun: getWorkflowRun(db, scenario.workflowId),
      batchId: scenario.batchId,
      jobsToAnalyze: reportJobsAscending(db, scenario.batchId),
      configs: {},
      keywordPlan: [],
      logger: silentLogger(),
      signal: null,
      modelRuntimes: { primary: { ...primaryRuntime(), concurrency: 1 }, backup: null },
      createAnalyzeJob: () => async (job) => analyzedJob(job),
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      now: fixedClock("2026-09-01T00:05:00.000Z"),
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {},
      renderReports: (phaseDb, phaseBatchId, { workflow }) => {
        renderCalls += 1;
        statusAtRender = workflow.status;
        renderedJobs = listReportJobs(phaseDb, { batchId: phaseBatchId, limit: 10000 });
      }
    });
    assert.strictEqual(result.status, "drained");
    assert.strictEqual(renderCalls, 1);
    assert.strictEqual(statusAtRender, "review_required");
    assert.strictEqual(renderedJobs.length, 3);

    const pausedScenario = seedWorkflow(db, {
      localDay: "2026-09-02",
      analyses: [
        { semanticStatus: "pending", decisionSource: "analysis_pending" },
        { semanticStatus: "pending", decisionSource: "analysis_pending" }
      ],
      modelConfigRevision: "phase-report-paused"
    });
    const pausedRenderCalls = [];
    const drainedWithoutReview = await runWorkflowAnalysisPhase(db, {
      workflowRun: getWorkflowRun(db, pausedScenario.workflowId),
      batchId: pausedScenario.batchId,
      jobsToAnalyze: reportJobsAscending(db, pausedScenario.batchId),
      configs: {},
      keywordPlan: [],
      logger: silentLogger(),
      signal: null,
      modelRuntimes: { primary: { ...primaryRuntime(), concurrency: 1 }, backup: null },
      createAnalyzeJob: () => async (job) => analyzedJob(job),
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      now: fixedClock("2026-09-02T00:05:00.000Z"),
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {},
      reviewIfDrained: false,
      renderReports: () => pausedRenderCalls.push("render")
    });
    assert.strictEqual(drainedWithoutReview.status, "drained");
    assert.deepStrictEqual(pausedRenderCalls, []);
    assert.strictEqual(getWorkflowRun(db, pausedScenario.workflowId).status, "analyzing");

    const crashScenario = seedWorkflow(db, {
      localDay: "2026-09-03",
      analyses: [
        { semanticStatus: "pending", decisionSource: "analysis_pending" },
        { semanticStatus: "pending", decisionSource: "analysis_pending" }
      ],
      modelConfigRevision: "phase-report-crash"
    });
    const crashRenderCalls = [];
    await runWorkflowAnalysisPhase(db, {
      workflowRun: getWorkflowRun(db, crashScenario.workflowId),
      batchId: crashScenario.batchId,
      jobsToAnalyze: reportJobsAscending(db, crashScenario.batchId),
      configs: {},
      keywordPlan: [],
      logger: silentLogger(),
      signal: null,
      modelRuntimes: { primary: { ...primaryRuntime(), concurrency: 1 }, backup: null },
      createAnalyzeJob: () => async (job) => {
        throw Object.assign(new Error("executor crashed"), {
          code: "WORKFLOW_EXECUTOR_CRASH",
          stage: "execute"
        });
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      now: fixedClock("2026-09-03T00:05:00.000Z"),
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {},
      renderReports: () => crashRenderCalls.push("render")
    });
    assert.deepStrictEqual(crashRenderCalls, []);
    assert.strictEqual(getWorkflowRun(db, crashScenario.workflowId).status, "interrupted");
  } finally {
    db.close();
  }
}

async function runnerErrorModeSmoke() {
  const db = openDb(":memory:");
  try {
    const configs = configFor();
    const timeoutAnalyzer = {
      understandJob: async () => {
        throw Object.assign(new Error("model timeout"), {
          code: "MODEL_TIMEOUT",
          modelStage: "understandJob",
          modelPhase: "initial",
          statusCode: 504
        });
      },
      matchJob: async () => {
        throw new Error("matchJob must not run");
      }
    };
    const warned = [];
    const logger = {
      warn: (event, context) => warned.push({ event, context }),
      info: () => {},
      error: () => {}
    };

    const defaultRunner = createJobAnalysisRunner(configs, [], { db, analyzer: timeoutAnalyzer, logger });
    const failed = await defaultRunner(completeJob("mode-result"));
    assert.strictEqual(failed.semanticStatus, "failed");
    assert.strictEqual(failed.errorCode, "MODEL_TIMEOUT");

    const throwRunner = createJobAnalysisRunner(configs, [], {
      db,
      analyzer: timeoutAnalyzer,
      logger,
      errorMode: "throw"
    });
    await assert.rejects(
      () => throwRunner(completeJob("mode-throw")),
      (error) => error.code === "MODEL_TIMEOUT"
        && error.stage === "understandJob"
        && error.phase === "initial"
    );
    assert(warned.some((entry) => entry.event === "job_analysis_failed"
      && entry.context.errorCode === "MODEL_TIMEOUT"));

    const noProfileRunner = createJobAnalysisRunner(
      { ...configs, candidateProfile: null },
      [],
      { db, analyzer: timeoutAnalyzer, logger, errorMode: "throw" }
    );
    await assert.rejects(
      () => noProfileRunner(completeJob("mode-no-profile")),
      (error) => error.code === "CANDIDATE_PROFILE_REQUIRED"
    );

    let calls = 0;
    const repairingAnalyzer = {
      understandJob: async (input) => {
        calls += 1;
        if (!input.contractRepair) {
          return { ...understanding("repair-throw"), eligibilityConstraints: [{ type: "学历", value: "本科" }] };
        }
        return understanding("repair-throw");
      },
      matchJob: async () => decision("apply", "A", "Python")
    };
    const repairRunner = createJobAnalysisRunner(configs, [], {
      db,
      analyzer: repairingAnalyzer,
      logger,
      errorMode: "throw"
    });
    const repaired = await repairRunner(completeJob("repair-throw"));
    assert.strictEqual(calls, 2);
    assert.strictEqual(repaired.semanticStatus, "complete");

    let repairCalls = 0;
    const failingRepairAnalyzer = {
      understandJob: async (input) => {
        repairCalls += 1;
        return { ...understanding("repair-fail"), eligibilityConstraints: [{ type: "学历", value: "本科" }] };
      },
      matchJob: async () => decision("apply", "A", "Python")
    };
    const failingRepairRunner = createJobAnalysisRunner(configs, [], {
      db,
      analyzer: failingRepairAnalyzer,
      logger,
      errorMode: "throw"
    });
    await assert.rejects(
      () => failingRepairRunner(completeJob("repair-fail")),
      (error) => error.phase === "contract_repair"
    );
  } finally {
    db.close();
  }
}

function seedWorkflow(database, { analyses, localDay, modelConfigRevision }) {
  const now = new Date().toISOString();
  const profileId = Number(database.prepare(`
    INSERT INTO candidate_profiles(display_name, profile_json, source_hash, created_at, updated_at)
    VALUES ('Workflow Scan Analysis Candidate', '{}', NULL, ?, ?)
  `).run(now, now).lastInsertRowid);
  const planId = Number(database.prepare(`
    INSERT INTO search_plans(profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at)
    VALUES (?, 'Workflow Scan Analysis Plan', '{}', NULL, 1, ?, ?)
  `).run(profileId, now, now).lastInsertRowid);
  const batchId = createBatch(database, "boss", "RAG", "workflow scan analysis smoke", {
    profileId,
    searchPlanId: planId
  });
  const sourceIds = [];
  const jobIds = [];
  analyses.forEach((analysis, index) => {
    const sourceId = `${localDay}-job-${index + 1}`;
    const jobId = upsertJob(database, {
      source: "boss",
      sourceId,
      title: `Job ${index + 1} (${localDay})`,
      analysis
    }, batchId);
    sourceIds.push(sourceId);
    jobIds.push(Number(jobId));
  });
  const workflowId = createWorkflowRun(database, {
    profileId,
    planId,
    localDay,
    sequence: 1,
    targetSuccessCount: 35,
    inventoryCount: 0,
    candidateGap: 35,
    scanNeeded: true,
    keywords: [{ word: "RAG", priority: "A" }],
    budget: { maxDetailTotal: 120, browserPageBudget: 20 },
    planner: { remainingDailyTarget: 70, remainingRunSlots: 2 },
    modelConfigRevision
  }).id;
  const scanRun = createScanRun(database, {
    runId: `scan-${localDay}-${profileId}`,
    planId,
    batchId
  });
  transitionWorkflowRun(database, { id: workflowId, status: "scanning" });
  attachWorkflowScan(database, {
    id: workflowId,
    scanRunId: scanRun.id,
    scanBatchId: batchId
  });
  transitionWorkflowRun(database, { id: workflowId, status: "analyzing" });
  return { workflowId, batchId, profileId, planId, jobIds, sourceIds };
}

function primaryRuntime() {
  return {
    revision: "primary-rev-1",
    concurrency: 2,
    modelConfig: {
      provider: "openai_compatible",
      providers: {
        openai_compatible: {
          model: "deepseek-v4-flash",
          thinkingMode: "disabled",
          reasoningEffort: "high"
        }
      }
    }
  };
}

function reportJobsAscending(db, batchId) {
  return listReportJobs(db, { batchId, limit: 10000 }).sort((a, b) => a.id - b.id);
}

function analyzedJob(job) {
  return {
    ...job,
    analysis: {
      semanticStatus: "complete",
      decisionSource: "model",
      recommendation: "apply",
      revision: "test-rev",
      note: "ok"
    }
  };
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, child: () => silentLogger() };
}

function fixedClock(iso) {
  return () => iso;
}

function configFor() {
  return {
    model: { provider: "openai_compatible", providers: { openai_compatible: { model: "test-model" } } },
    candidateProfile: profile(),
    searchPlan: plan(),
    analysisContext: {},
    resumeVersions: { versions: [] },
    profile: { location: { target_cities: ["广州"] } },
    scoring: {
      boss_activity: { max_active_days: 3 },
      salary: {},
      experience: {},
      risk_rules: [],
      exclude_words: []
    }
  };
}

function profile() {
  return {
    candidate: { name: "Scan Analysis Candidate", city: "广州", targetTitles: ["AI应用开发"], expectedSalary: "10-20K" },
    skills: [{ name: "Python", level: "resume", evidence: ["Python"] }],
    projects: [{ name: "KnowledgeFlow", roleBoundary: "独立项目", canSay: ["Python", "RAG"], avoidSaying: [] }]
  };
}

function plan() {
  return {
    name: "Scan Analysis Plan",
    cities: ["广州"],
    salary: { minK: 10, maxK: 20 },
    experience: ["1-3年"],
    jobTypes: ["全职"],
    directions: ["AI应用开发"],
    keywords: [{ word: "RAG", priority: "A", reason: "test" }],
    bossActiveDays: 3
  };
}

function completeJob(sourceId) {
  return {
    source: "boss",
    sourceId,
    title: "AI应用开发工程师",
    company: "Scan Analysis Corp",
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
    greeting: ""
  };
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
      { label: "Python", foundation: true, indispensable: true, evidence: "JD：必须熟练使用 Python" },
      { label: "RAG", indispensable: true, evidence: "JD：必须具备 RAG 知识库建设能力" }
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
      {
        requirement: "Python",
        state: "matched",
        foundation: true,
        indispensable: true,
        jdEvidence: "JD：必须熟练使用 Python",
        resumeEvidence: `简历：${resumeEvidence}`
      },
      {
        requirement: "RAG",
        state: "matched",
        indispensable: true,
        jdEvidence: "JD：必须具备 RAG 知识库建设能力",
        resumeEvidence: `简历：${resumeEvidence}`
      }
    ],
    jobQuality: { level: "normal", concerns: [] },
    missingPoints: [],
    riskQuestions: [],
    recommendedResumeVersion: "",
    primaryProjects: ["KnowledgeFlow"],
    greetingAngle: "围绕 RAG 项目切入",
    evidence: {
      jd: ["负责 RAG 知识库和 Agent 应用开发"],
      resume: [resumeEvidence]
    }
  };
}
