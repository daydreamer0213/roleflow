const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  openDb,
  listCandidateProfiles,
  getCandidateProfile,
  getMatchingCard,
  getSearchPlan
} = require("../src/core/storage");
const { parseResumeText } = require("../src/core/resume_parser");
const { inferCandidateDisplayName } = require("../src/core/resume_privacy");
const {
  createOnboardingRun,
  getOnboardingRun,
  getOnboardingRunContext,
  retryOnboardingRun,
  recoverStaleOnboardingRuns,
  getLatestActiveOnboardingRun,
  getInitialSearchCatchUpCandidate,
  recordInitialSearchPreparationHandled
} = require("../src/storage/onboarding_store");
const { processOnboardingRun } = require("../src/core/onboarding_run");
const { createWorkflowRun } = require("../src/storage/workflow_store");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-onboarding-run-"));
const dbPath = path.join(root, "jobs.sqlite");
const db = openDb(dbPath);

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function main() {
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='onboarding_runs'").get().n,
    1
  );

  const resume = parseResumeText({
    fileName: "王小明-AI应用开发.txt",
    text: [
      "姓名：王小明",
      "手机：13800138000",
      "求职意向：AI 应用开发工程师",
      "项目经历：KnowledgeFlow 知识库项目，使用 Python、FastAPI 和 RAG。",
      "工作经历：参与企业知识检索服务开发并负责接口联调。",
      "专业技能：Python、FastAPI、RAG、SQLite、Docker。"
    ].join("\n")
  });
  assert.strictEqual(inferCandidateDisplayName(resume.text, resume.originalFileName), "王小明");

  const created = createOnboardingRun(db, {
    displayName: "王小明",
    document: resume
  });
  assert.strictEqual(created.created, true);
  assert.strictEqual(created.run.status, "queued");
  assert.strictEqual(created.run.stage, "parsed");
  assert.strictEqual(listCandidateProfiles(db).length, 0, "placeholder profile must stay out of normal profile lists");
  assert(!JSON.stringify(created.run).includes(resume.text), "public run DTO must not contain resume text");
  assert(!JSON.stringify(created.run).includes("13800138000"), "public run DTO must not contain contact details");

  const duplicate = createOnboardingRun(db, {
    displayName: "王小明",
    document: resume
  });
  assert.strictEqual(duplicate.created, false);
  assert.strictEqual(duplicate.run.id, created.run.id, "double submit must reuse the unfinished run");

  const calls = { analyze: 0, card: 0, plan: 0 };
  const modelInputs = [];
  const result = await processOnboardingRun({
    db,
    runId: created.run.id,
    modelConfig: { provider: "test", providers: { test: { model: "fixture" } } },
    logger: quietLogger(),
    analyzeResume: async ({ resume: input }) => {
      calls.analyze += 1;
      modelInputs.push(input.text);
      return {
        candidate: {
          name: "[姓名已隐藏]",
          city: "广州",
          targetTitles: ["AI 应用开发工程师"],
          expectedSalary: "10-18K"
        },
        education: [],
        experiences: [],
        skills: [{ name: "Python", level: "resume", evidence: ["KnowledgeFlow"] }],
        projects: [{ name: "KnowledgeFlow", roleBoundary: "参与接口开发", canSay: ["参与知识检索服务开发"] }],
        credentials: [],
        strengths: [],
        resumeVersions: [],
        riskMessaging: {},
        source: {}
      };
    },
    buildMatchingCard: async ({ profile }) => {
      calls.card += 1;
      modelInputs.push(JSON.stringify(profile));
      return {
        targetDirections: ["AI 应用开发工程师"],
        strongEvidence: [{ label: "Python", evidence: "简历：参与知识检索服务开发" }],
        transferableCapabilities: [],
        cautionTransitions: []
      };
    },
    recommendPlan: async ({ profile }) => {
      calls.plan += 1;
      modelInputs.push(JSON.stringify(profile));
      return {
        name: "本地筛选方案",
        cities: ["广州"],
        salary: { minK: 10, maxK: 18 },
        experience: ["经验不限"],
        allowExperienceStretch: true,
        bossActiveDays: 3,
        directions: ["AI 应用开发工程师"],
        keywords: [{ word: "AI 应用开发", priority: "A", reason: "目标岗位" }],
        excludeWords: [],
        hardExcludes: []
      };
    }
  });

  assert.strictEqual(result.status, "completed");
  assert.strictEqual(result.stage, "ready");
  assert(result.profileVersionId > 0);
  assert(result.matchingCardId > 0);
  assert(result.searchPlanId > 0);
  assert.deepStrictEqual(calls, { analyze: 1, card: 1, plan: 1 });
  assert(modelInputs.every((input) => !input.includes("王小明")));
  assert(modelInputs.every((input) => !input.includes("13800138000")));

  const profile = getCandidateProfile(db, result.profileId);
  assert.strictEqual(profile.displayName, "王小明", "local UI must retain the locally extracted name");
  assert.strictEqual(profile.profile.candidate.name, "候选人", "model-safe profile must retain a neutral name");
  assert.strictEqual(listCandidateProfiles(db).length, 1);
  assert(getMatchingCard(db, result.matchingCardId));
  assert(getSearchPlan(db, result.searchPlanId));

  assert.strictEqual(typeof getInitialSearchCatchUpCandidate, "function");
  assert.strictEqual(typeof recordInitialSearchPreparationHandled, "function");
  assert.strictEqual(
    getInitialSearchCatchUpCandidate(db)?.id,
    result.id,
    "the latest completed onboarding must be eligible before its first workflow"
  );
  db.prepare("UPDATE search_plans SET profile_version_id = profile_version_id + 1 WHERE id = ?")
    .run(result.searchPlanId);
  assert.strictEqual(
    getInitialSearchCatchUpCandidate(db),
    null,
    "a plan from another profile version must never drive upgrade catch-up"
  );
  db.prepare("UPDATE search_plans SET profile_version_id = ? WHERE id = ?")
    .run(result.profileVersionId, result.searchPlanId);
  createWorkflowRun(db, {
    id: "catch-up-blocking-workflow",
    profileId: result.profileId,
    planId: result.searchPlanId,
    localDay: "2026-09-01",
    sequence: 1,
    targetSuccessCount: 1
  });
  assert.strictEqual(
    getInitialSearchCatchUpCandidate(db),
    null,
    "an onboarding plan with any workflow history must not be changed by catch-up"
  );
  db.prepare("DELETE FROM workflow_runs WHERE id = 'catch-up-blocking-workflow'").run();
  assert.strictEqual(recordInitialSearchPreparationHandled(db, {
    run: result,
    source: "upgrade_catch_up",
    result: { status: "skipped", reason: "query_present" }
  }), true);
  assert.strictEqual(recordInitialSearchPreparationHandled(db, {
    run: result,
    source: "upgrade_catch_up",
    result: { status: "skipped", reason: "query_present" }
  }), false, "the durable preparation marker must be idempotent");
  assert.strictEqual(getInitialSearchCatchUpCandidate(db), null);
  const preparationMarker = db.prepare(`SELECT payload_json FROM events
    WHERE event_type = 'onboarding_initial_search_prepared'`).get();
  assert.deepStrictEqual(JSON.parse(preparationMarker.payload_json), {
    runId: result.id,
    profileId: result.profileId,
    planId: result.searchPlanId,
    source: "upgrade_catch_up",
    status: "skipped",
    reason: "query_present"
  });
  assert(!preparationMarker.payload_json.includes("AI 应用开发"), "the marker must not persist the keyword");

  await processOnboardingRun({
    db,
    runId: result.id,
    modelConfig: {},
    logger: quietLogger(),
    analyzeResume: async () => { calls.analyze += 1; throw new Error("must not rerun"); },
    buildMatchingCard: async () => { calls.card += 1; throw new Error("must not rerun"); },
    recommendPlan: async () => { calls.plan += 1; throw new Error("must not rerun"); }
  });
  assert.deepStrictEqual(calls, { analyze: 1, card: 1, plan: 1 }, "completed checkpoints must be idempotent");

  const updateResume = parseResumeText({
    text: `${resume.text}\n补充经历：负责知识库评估体系建设与线上问题排查。`
  });
  const update = createOnboardingRun(db, {
    profileId: profile.id,
    displayName: profile.displayName,
    document: updateResume
  });
  assert.strictEqual(
    getLatestActiveOnboardingRun(db)?.id,
    update.run.id,
    "an update that is still running must remain visible from home"
  );
  let failPlan = true;
  const retryCalls = { analyze: 0, card: 0, plan: 0 };
  const partial = await processOnboardingRun({
    db,
    runId: update.run.id,
    modelConfig: {},
    logger: quietLogger(),
    analyzeResume: async () => {
      retryCalls.analyze += 1;
      return profile.profile;
    },
    buildMatchingCard: async () => {
      retryCalls.card += 1;
      return getMatchingCard(db, result.matchingCardId).card;
    },
    recommendPlan: async () => {
      retryCalls.plan += 1;
      if (failPlan) throw Object.assign(new Error("temporary plan failure"), { code: "MODEL_TIMEOUT" });
      return getSearchPlan(db, result.searchPlanId).plan;
    }
  });
  assert.strictEqual(partial.status, "completed");
  assert.strictEqual(partial.errorCode, "MODEL_TIMEOUT");
  assert(partial.profileVersionId > 0);
  assert(partial.matchingCardId > 0);
  assert.strictEqual(partial.searchPlanId, null);

  failPlan = false;
  const queued = retryOnboardingRun(db, partial.id);
  assert.strictEqual(queued.status, "queued");
  const retried = await processOnboardingRun({
    db,
    runId: partial.id,
    modelConfig: {},
    logger: quietLogger(),
    analyzeResume: async () => { retryCalls.analyze += 1; return profile.profile; },
    buildMatchingCard: async () => { retryCalls.card += 1; return getMatchingCard(db, result.matchingCardId).card; },
    recommendPlan: async () => {
      retryCalls.plan += 1;
      return getSearchPlan(db, result.searchPlanId).plan;
    }
  });
  assert.strictEqual(retried.status, "completed");
  assert(retried.searchPlanId > 0);
  assert.deepStrictEqual(retryCalls, { analyze: 1, card: 1, plan: 2 }, "retry must resume from the plan checkpoint");

  db.prepare(`
    UPDATE onboarding_runs
    SET status = 'running', stage = 'analyzing_profile',
      heartbeat_at = '2026-01-01T00:00:00.000Z', updated_at = '2026-01-01T00:00:00.000Z'
    WHERE id = ?
  `).run(retried.id);
  const recovered = recoverStaleOnboardingRuns(db, {
    now: "2026-08-13T00:00:00.000Z",
    staleAfterMs: 60_000
  });
  assert.strictEqual(recovered.interrupted, 1);
  assert.strictEqual(getOnboardingRun(db, retried.id).status, "failed");
  assert.strictEqual(getOnboardingRun(db, retried.id).errorCode, "ONBOARDING_RUN_ORPHANED");
  assert.strictEqual(
    getLatestActiveOnboardingRun(db),
    null,
    "a failed update must not permanently hijack home from the existing usable profile"
  );
  assert(!JSON.stringify(getOnboardingRunContext(db, retried.id).run).includes(resume.text));

  console.log("onboarding_run_smoke ok");
}

function quietLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    child() { return this; }
  };
}
