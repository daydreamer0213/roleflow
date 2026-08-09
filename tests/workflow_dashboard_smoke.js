const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const {
  openDb,
  saveProfileAnalysis,
  createMatchingCardDraft,
  confirmMatchingCard,
  createWorkflowRun,
  listWorkflowRuns,
  getWorkflowRun,
  getScanRun,
  getLatestScanRun,
  createScanRun,
  finishScanRun,
  attachWorkflowScan,
  createBatch,
  transitionWorkflowRun,
  upsertJob,
  insertWorkflowJobTaskRow,
  setSiteRuntimeState,
  clearSiteRuntimeState,
  recordCandidateJobEvent,
  recordSiteAccessEvent
} = require("../src/core/storage");
const { matchingCardFromProfile } = require("../src/core/matching_card");
const { listWorkflowReviewCandidates } = require("../src/core/workflow_inventory");
const { buildScanExecutionSnapshot } = require("../src/core/scan_snapshot");
const { finalizeWorkflowControl, requestWorkflowStop } = require("../src/core/workflow_control");
const { createDashboardServer } = require("../src/dashboard/server");
const { renderWorkflowHealthPanel } = require("../src/dashboard/workflow_health_view");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `workflow-dashboard-${Date.now()}.sqlite`);
const logger = {
  info() {}, warn() {}, error() {},
  requestId() { return "workflow-dashboard-smoke"; },
  listRecent() { return []; }
};

let db;
let server;

(async () => {
  fs.mkdirSync(smokeDir, { recursive: true });
  db = openDb(dbPath);
  const saved = seedProfile(db);
  const spawns = [];
  const workflowControlTimers = [];
  const modelAccesses = [];
  let batchModelReady = true;
  const routingModelState = {
    source: "runtime",
    settings: {
      schemaVersion: 2,
      credentialMode: "shared",
      sharedCredential: { preset: "mock", provider: "mock", baseUrl: "" },
      taskProfiles: {
        deep_analysis: {
          model: "deep-analysis-model",
          timeoutMs: 120000,
          thinkingMode: "disabled",
          reasoningEffort: "high",
          concurrency: 1,
          credentialRef: "shared",
          revision: "deep-analysis-revision",
          connection: {
            status: "verified",
            checkedAt: "2099-01-01T00:00:00.000Z",
            latencyMs: 1,
            httpStatus: 200,
            fingerprint: "deep-analysis-revision"
          }
        },
        batch_screening: {
          model: "batch-screening-model",
          timeoutMs: 90000,
          thinkingMode: "disabled",
          reasoningEffort: "high",
          concurrency: 2,
          credentialRef: "shared",
          revision: "batch-screening-revision",
          connection: {
            status: "verified",
            checkedAt: "2099-01-01T00:00:00.000Z",
            latencyMs: 1,
            httpStatus: 200,
            fingerprint: "batch-screening-revision"
          }
        }
      },
      independentCredentials: { deep_analysis: null, batch_screening: null },
      batchBackup: {
        enabled: false,
        credentialRef: "shared",
        preset: "mock",
        provider: "mock",
        baseUrl: "",
        model: "batch-backup-model",
        timeoutMs: 90000,
        thinkingMode: "disabled",
        reasoningEffort: "high",
        revision: "batch-backup-revision",
        connection: {
          status: "unverified",
          checkedAt: "",
          latencyMs: null,
          httpStatus: null,
          fingerprint: "batch-backup-revision"
        }
      },
      revision: "whole-model-settings-revision",
      preset: "mock",
      provider: "mock",
      baseUrl: "",
      model: "deep-analysis-model",
      timeoutMs: 120000,
      thinkingMode: "disabled",
      reasoningEffort: "high",
      connection: {
        status: "verified",
        checkedAt: "2099-01-01T00:00:00.000Z",
        latencyMs: 1,
        httpStatus: 200,
        fingerprint: "deep-analysis-revision"
      }
    },
    keyStored: false,
    keyConfigured: false,
    keyReadable: false,
    keyErrorCode: "",
    connectionStatus: "verified",
    modelConfig: {
      provider: "mock",
      providers: { mock: { model: "deep-analysis-model" } }
    }
  };
  let inheritedFailureCode = "";
  let inheritedResolutionCount = 0;
  let inheritedResolutionInput = null;
  let resumeBrowserReadinessStatus = "ready";
  const resumeBrowserProbeInputs = [];
  let browserReadiness = {
    status: "login_required",
    ready: false,
    message: "等待登录：请在 BOSS 标签页完成登录。",
    checkedAt: "2099-01-01T00:00:00.000Z"
  };
  const inheritedContextResolver = async ({ plan, matchingContext, browserMode, cdpPort }) => {
    inheritedResolutionCount += 1;
    inheritedResolutionInput = { browserMode, cdpPort };
    if (inheritedFailureCode) {
      throw Object.assign(new Error(`blocked by ${inheritedFailureCode}`), {
        code: inheritedFailureCode,
        statusCode: 409
      });
    }
    const context = {
      acquisitionMode: "inherited",
      searchTemplate: {
        mode: "inherited",
        url: "https://www.zhipin.com/web/geek/jobs?city=100010000&salary=405",
        cityCode: "100010000"
      },
      searchScope: {
        key: `boss:${plan.profileId}:fixture-scope`,
        site: "boss",
        templateHash: "fixture-scope",
        templateUrl: "https://www.zhipin.com/web/geek/jobs?city=100010000&salary=405",
        filterParams: { city: ["100010000"], salary: ["405"] }
      },
      keywordSource: {
        searchPlanId: plan.id,
        profileVersionId: plan.profileVersionId,
        matchingCardRevision: "fixture-card",
        catalogHash: "fixture-catalog",
        keywords: [
          ...plan.plan.keywords.map(({ word, priority, reason = "" }) => ({ word, priority, reason })),
          { word: "Agent工程师", priority: "B", reason: "测试继承关键词展示" }
        ]
      },
      platformPolicy: {
        hash: "fixture-policy",
        site: "boss",
        templateHash: "fixture-scope",
        filters: {
          location: { mode: "nationwide", codes: ["100010000"], cities: [], districts: [] },
          salary: { codes: ["405"], labels: ["10-20K"], ranges: [{ minK: 10, maxK: 20 }] },
          experience: { codes: [], labels: [] },
          degree: { codes: [], labels: [] },
          jobType: { codes: [], labels: [] },
          acquisitionOnly: {}
        },
        unresolvedParams: [],
        filterSummary: ["地点：全国", "薪资：10-20K"]
      },
      matchingContext
    };
    return context;
  };
  server = createDashboardServer({
    db,
    root,
    dbPath,
    forceMock: true,
    allowOfflineMock: false,
    modelSettingsLoader() {
      modelAccesses.push({ kind: "public" });
      return routingModelState;
    },
    runtimeModelResolver({ taskProfile }) {
      modelAccesses.push({ kind: "runtime", taskProfile });
      return {
        ...routingModelState,
        revision: routingModelState.settings.taskProfiles[taskProfile].revision,
        concurrency: routingModelState.settings.taskProfiles[taskProfile].concurrency,
        modelConfig: {
          provider: "mock",
          providers: { mock: { model: `${taskProfile}-model` } }
        }
      };
    },
    modelReadinessChecker(_state, { taskProfile } = {}) {
      modelAccesses.push({ kind: "ready", taskProfile });
      return taskProfile === "batch_screening" ? batchModelReady : taskProfile === "deep_analysis";
    },
    logger,
    inheritedContextResolver,
    browserReadinessProbe: async () => ({ ...browserReadiness }),
    workflowResumeBrowserReadinessProbe: async ({ browserMode, cdpPort }) => {
      resumeBrowserProbeInputs.push({ browserMode, cdpPort });
      return {
        status: resumeBrowserReadinessStatus,
        ready: resumeBrowserReadinessStatus === "ready",
        message: `fixture resume ${resumeBrowserReadinessStatus}`,
        checkedAt: "2099-01-01T00:00:06.000Z"
      };
    },
    workflowControlGraceMs: 1234,
    workflowControlSchedule(callback, delayMs) {
      const timer = { callback, delayMs, unrefCalled: false };
      timer.handle = { unref() { timer.unrefCalled = true; } };
      workflowControlTimers.push(timer);
      return timer.handle;
    },
    spawnProcess(file, args, options) {
      const child = new EventEmitter();
      child.pid = 6100 + spawns.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killCalls = [];
      child.kill = (signal) => {
        child.killCalls.push(signal || "SIGTERM");
        return true;
      };
      spawns.push({ file, args, options, child });
      return child;
    }
  });
  const baseUrl = await listen(server);

  const health = await getJson(baseUrl, "/health");
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.body.ok, true);
  assert.strictEqual(health.body.projectRoot, path.resolve(root));
  assert.strictEqual(health.body.pid, process.pid);

  const loginReadiness = await getJson(baseUrl, "/api/browser-readiness");
  assert.strictEqual(loginReadiness.status, 200);
  assert.deepStrictEqual(loginReadiness.body, browserReadiness);

  const gatedPlanPage = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.match(gatedPlanPage.body, /data-browser-readiness-button/);
  assert.match(gatedPlanPage.body, /data-browser-base-disabled="false"/);
  assert.match(gatedPlanPage.body, /id="browser-readiness-status"/);
  assert.match(gatedPlanPage.body, /\/api\/browser-readiness/);
  assert.match(gatedPlanPage.body, /5000/);
  assert.match(gatedPlanPage.body, /disabled[^>]*>执行一轮/);
  const readinessScript = extractBrowserReadinessScript(gatedPlanPage.body);
  await assertBrowserReadinessGate({ readinessScript, status: "login_required", baseDisabled: false, expectedDisabled: true });
  await assertBrowserReadinessGate({ readinessScript, status: "ready", baseDisabled: false, expectedDisabled: false });
  await assertBrowserReadinessGate({ readinessScript, status: "ready", baseDisabled: true, expectedDisabled: true });
  await assertBrowserReadinessGate({ readinessScript, responseOk: false, expectedDisabled: true });
  await assertBrowserReadinessGate({ readinessScript, fetchError: new Error("fixture readiness request failure"), expectedDisabled: true });
  await assertSerializedSlowBrowserReadinessGate(readinessScript);

  const publicReadiness = {
    status: "login_required",
    ready: false,
    message: "等待登录：请在 BOSS 标签页完成登录。",
    checkedAt: "2099-01-01T00:00:01.000Z"
  };
  browserReadiness = {
    ...publicReadiness,
    url: "https://www.zhipin.com/web/geek/jobs?city=100010000",
    dom: "<main>private fixture DOM</main>",
    account: "fixture-account",
    cookie: "session=private",
    extra: { internal: true }
  };
  const sanitizedReadiness = await getJson(baseUrl, "/api/browser-readiness");
  assert.strictEqual(sanitizedReadiness.status, 200);
  assert.deepStrictEqual(sanitizedReadiness.body, publicReadiness);

  browserReadiness = { ...publicReadiness, status: "unsupported_fixture_status" };
  const unknownReadiness = await getText(baseUrl, "/api/browser-readiness");
  assert.strictEqual(unknownReadiness.status, 500);

  browserReadiness = {
    status: "ready",
    ready: true,
    message: "继承模式已就绪，可以执行一轮。",
    checkedAt: "2099-01-01T00:00:05.000Z"
  };
  const readyReadiness = await getJson(baseUrl, "/api/browser-readiness");
  assert.deepStrictEqual(readyReadiness.body, browserReadiness);

  const unconfirmed = seedProfile(db, { confirmCard: false });
  const blockedPage = await getText(baseUrl, `/plan?planId=${unconfirmed.planId}`);
  assert.match(blockedPage.body, /data-browser-base-disabled="true"/);

  const planBefore = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.match(planBefore.body, /今日进度<\/span><strong>0\s*\/\s*70/);
  assert.match(planBefore.body, /下一轮目标<\/span><strong>35/);
  assert.match(planBefore.body, /<button[^>]*data-browser-readiness-button[^>]*disabled>/);
  assert.match(planBefore.body, /data-browser-readiness-button/);
  assert.match(planBefore.body, /data-browser-base-disabled="false"/);
  assert.match(planBefore.body, /data-scan-button name="scanKind" value="daily" disabled/);
  assert.match(planBefore.body, /BOSS 暂不支持这些城市：测试未映射城市/);
  assert.doesNotMatch(planBefore.body, /上午|下午/);
  assert.match(planBefore.body, /高级扫描与维护/);

  batchModelReady = false;
  const resolutionCountBeforeModelGate = inheritedResolutionCount;
  const modelBlockedStart = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
    browserMode: "portable",
    cdpPort: 9222,
    action: "start"
  });
  assert.strictEqual(modelBlockedStart.status, 409);
  assert.match(modelBlockedStart.body, /href="\/settings#model-profile-batch_screening"/);
  assert.strictEqual(
    inheritedResolutionCount,
    resolutionCountBeforeModelGate,
    "batch readiness must block before any BOSS/inherited-context inspection"
  );
  batchModelReady = true;

  for (const code of [
    "BOSS_RISK_CONTROL",
    "BOSS_LOGIN_REQUIRED",
    "BOSS_SEARCH_PAGE_INVALID"
  ]) {
    inheritedFailureCode = code;
    const rejected = await postForm(baseUrl, "/api/workflow-run", {
      planId: saved.planId,
      browserMode: "portable",
      cdpPort: 9222,
      action: "start"
    });
    assert.strictEqual(rejected.status, 409);
    assert.strictEqual(listWorkflowRuns(db, { planId: saved.planId }).length, 0);
    assert.strictEqual(spawns.length, 0);
  }
  inheritedFailureCode = "";

  const edgeStart = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
    browserMode: "edge",
    action: "start"
  });
  assert.strictEqual(edgeStart.status, 409);
  assert.match(edgeStart.body, /INHERITED_PORTABLE_REQUIRED/);

  const started = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
    browserMode: "portable",
    cdpPort: 9222,
    action: "start"
  });
  assert.strictEqual(started.status, 303);
  assert.match(started.location, /^\/workflow\?runId=/);
  const workflow = listWorkflowRuns(db, { planId: saved.planId })[0];
  assert.strictEqual(workflow.status, "scanning");
  assert.strictEqual(workflow.targetSuccessCount, 35);
  assert.strictEqual(workflow.modelConfigRevision, "batch-screening-revision");
  assert.strictEqual(workflow.planner.modelProfiles.batch_screening.model, "batch-screening-model");
  assert.strictEqual(workflow.planner.modelProfiles.batch_screening.revision, "batch-screening-revision");
  assert.strictEqual(workflow.planner.modelProfiles.batch_screening.concurrency, 2);
  assert.strictEqual(workflow.planner.modelProfiles.batch_backup, null);
  assert(!JSON.stringify(workflow.planner.modelProfiles).includes("apiKey"));
  assert(!JSON.stringify(workflow.planner.modelProfiles).includes("baseUrl"));
  assert.strictEqual(workflow.planner.acquisitionMode, "inherited");
  assert.deepStrictEqual(inheritedResolutionInput, { browserMode: "portable", cdpPort: 9222 });
  assert.strictEqual(workflow.planner.browserMode, "portable");
  assert.strictEqual(workflow.planner.cdpPort, 9222);
  assert.strictEqual(workflow.planner.searchScope.key, `boss:${saved.profileId}:fixture-scope`);
  assert.strictEqual(workflow.planner.platformPolicy.hash, "fixture-policy");
  assert.deepStrictEqual(
    workflow.keywords.map((item) => item.word),
    ["AI应用开发工程师", "大模型应用开发工程师", "Agent开发工程师"]
  );
  assert.strictEqual(spawns.length, 1);
  assert(spawns[0].args.includes("--workflow-run"));
  assert(spawns[0].args.includes(workflow.id));
  assert.deepStrictEqual(
    spawns[0].args.slice(spawns[0].args.indexOf("--browser"), spawns[0].args.indexOf("--browser") + 4),
    ["--browser", "portable", "--cdp-port", "9222"]
  );

  const scanningPage = await getText(baseUrl, started.location);
  assert.match(scanningPage.body, /正在筛选岗位/);
  assert.match(scanningPage.body, /本轮目标\s*<strong>35/);
  assert.doesNotMatch(scanningPage.body, /上午|下午/);
  for (const text of [
    "筛选来源：BOSS 当前页面",
    "地点：全国",
    "薪资：10-20K",
    "范围：fixture-sc",
    "关键词来源：Search Plan",
    "AI应用开发工程师",
    "RAG工程师",
    "Agent工程师",
    "修改 BOSS 筛选会创建新的统计范围"
  ]) {
    assert.match(scanningPage.body, new RegExp(text));
  }
  assert.doesNotMatch(scanningPage.body, /广州 AI.*目标城市/);
  assert.doesNotMatch(scanningPage.body, /https:\/\/www\.zhipin\.com\/web\/geek\/jobs\?/);

  const unresolvedPlanner = {
    ...workflow.planner,
    platformPolicy: {
      ...workflow.planner.platformPolicy,
      unresolvedParams: [{ param: "industry", codes: ["100020"] }]
    },
    browserState: {
      cookie: "raw-authenticated-browser-state"
    }
  };
  db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
    .run(JSON.stringify(unresolvedPlanner), workflow.id);
  const unresolvedPage = await getText(baseUrl, started.location);
  assert.match(unresolvedPage.body, /未解析平台筛选：industry/);
  assert.doesNotMatch(unresolvedPage.body, /100020/);
  assert.doesNotMatch(unresolvedPage.body, /raw-authenticated-browser-state/);
  db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
    .run(JSON.stringify(workflow.planner), workflow.id);

  spawns[0].child.emit("error", new Error("spawn failed"));
  const interruptedWorkflow = getWorkflowRun(db, workflow.id);
  assert.strictEqual(interruptedWorkflow.status, "interrupted");
  assert.strictEqual(interruptedWorkflow.sequence, 1);
  assert.strictEqual(interruptedWorkflow.errorCode, "SCAN_PROCESS_ERROR");
  const inheritedInterruptedPage = await getText(baseUrl, started.location);
  assert.match(inheritedInterruptedPage.body, /<input type="hidden" name="browserMode" value="portable">/);
  assert.match(inheritedInterruptedPage.body, /项目专用 Edge 的 BOSS 搜索页/);
  assert.doesNotMatch(inheritedInterruptedPage.body, /<select name="browserMode">/);

  const frozenPlanner = workflow.planner;
  for (const status of [
    "browser_unavailable",
    "login_required",
    "search_page_required",
    "risk_control"
  ]) {
    resumeBrowserReadinessStatus = status;
    const workflowRowBefore = db.prepare(
      "SELECT status, updated_at, scan_run_id, scan_batch_id, planner_json FROM workflow_runs WHERE id = ?"
    ).get(workflow.id);
    const scanRunCountBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM scan_runs").get().count);
    const spawnCountBeforeRejectedResume = spawns.length;
    const rejectedResume = await postForm(baseUrl, "/api/workflow-run/resume", {
      workflowRunId: workflow.id,
      browserMode: "portable"
    });
    assert.strictEqual(rejectedResume.status, 409);
    assert.match(rejectedResume.body, new RegExp({
      browser_unavailable: "BROWSER_UNAVAILABLE",
      login_required: "BOSS_LOGIN_REQUIRED",
      search_page_required: "BOSS_SEARCH_PAGE_INVALID",
      risk_control: "BOSS_RISK_CONTROL"
    }[status]));
    assert.strictEqual(spawns.length, spawnCountBeforeRejectedResume);
    assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM scan_runs").get().count), scanRunCountBefore);
    assert.deepStrictEqual(
      db.prepare("SELECT status, updated_at, scan_run_id, scan_batch_id, planner_json FROM workflow_runs WHERE id = ?").get(workflow.id),
      workflowRowBefore
    );
    assert.deepStrictEqual(resumeBrowserProbeInputs.at(-1), { browserMode: "portable", cdpPort: 9222 });
  }

  const noScanInherited = createWorkflowRun(db, {
    id: "workflow-inherited-no-scan-preflight",
    profileId: saved.profileId,
    planId: saved.planId,
    localDay: "2099-01-03",
    sequence: 1,
    targetSuccessCount: 1,
    candidateGap: 0,
    scanNeeded: false,
    keywords: workflow.keywords,
    budget: workflow.budget,
    planner: frozenPlanner
  });
  resumeBrowserReadinessStatus = "login_required";
  const noScanRowBefore = db.prepare("SELECT status, updated_at FROM workflow_runs WHERE id = ?").get(noScanInherited.id);
  const rejectedNoScanResume = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: noScanInherited.id,
    browserMode: "portable"
  });
  assert.strictEqual(rejectedNoScanResume.status, 409);
  assert.deepStrictEqual(
    db.prepare("SELECT status, updated_at FROM workflow_runs WHERE id = ?").get(noScanInherited.id),
    noScanRowBefore,
    "read-only browser preflight must happen before a no-scan workflow changes state"
  );
  db.prepare("DELETE FROM workflow_runs WHERE id = ?").run(noScanInherited.id);

  resumeBrowserReadinessStatus = "ready";
  const spawnCountBeforePortableResume = spawns.length;
  const portableResume = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: workflow.id,
    browserMode: "portable"
  });
  assert.strictEqual(portableResume.status, 303);
  assert.strictEqual(portableResume.location, `/workflow?runId=${workflow.id}`);
  assert.strictEqual(spawns.length, spawnCountBeforePortableResume + 1);
  spawns.at(-1).child.emit("error", new Error("portable resume fixture"));

  const resolutionCountBeforeMalformedResume = inheritedResolutionCount;
  for (const acquisitionMode of [undefined, "future-mode"]) {
    const malformedPlanner = { ...frozenPlanner };
    if (acquisitionMode === undefined) delete malformedPlanner.acquisitionMode;
    else malformedPlanner.acquisitionMode = acquisitionMode;
    db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
      .run(JSON.stringify(malformedPlanner), workflow.id);
    const spawnCountBeforeMalformedResume = spawns.length;
    const malformedResume = await postForm(baseUrl, "/api/workflow-run/resume", {
      workflowRunId: workflow.id,
      browserMode: "portable"
    });
    assert.strictEqual(malformedResume.status, 409);
    assert.match(malformedResume.body, /WORKFLOW_ACQUISITION_MODE_INVALID/);
    assert.strictEqual(spawns.length, spawnCountBeforeMalformedResume);
    assert.strictEqual(inheritedResolutionCount, resolutionCountBeforeMalformedResume);
  }
  db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
    .run(JSON.stringify(frozenPlanner), workflow.id);

  for (const plannerPatch of [
    { searchScope: {} },
    { keywordSource: {} },
    { platformPolicy: {} }
  ]) {
    db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...frozenPlanner, ...plannerPatch }), workflow.id);
    const spawnCountBeforeCorruptInheritedResume = spawns.length;
    const corruptInheritedResume = await postForm(baseUrl, "/api/workflow-run/resume", {
      workflowRunId: workflow.id,
      browserMode: "portable"
    });
    assert.strictEqual(corruptInheritedResume.status, 409);
    assert.match(corruptInheritedResume.body, /WORKFLOW_INHERITED_SNAPSHOT_INVALID/);
    assert.strictEqual(spawns.length, spawnCountBeforeCorruptInheritedResume);
    assert.strictEqual(inheritedResolutionCount, resolutionCountBeforeMalformedResume);
    assert.strictEqual(getWorkflowRun(db, workflow.id).status, "interrupted");
  }
  db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
    .run(JSON.stringify(frozenPlanner), workflow.id);

  const validInheritedResumeSnapshot = buildScanExecutionSnapshot({
    site: "boss",
    scanKind: "daily",
    runtimePolicyHash: "fixture-inherited-runtime",
    searchTemplate: frozenPlanner.searchTemplate,
    searchScope: frozenPlanner.searchScope,
    keywordSource: frozenPlanner.keywordSource,
    platformPolicy: frozenPlanner.platformPolicy,
    cityScopes: [{ city: "", cityCode: "100010000" }],
    keywordPlan: workflow.keywords,
    nativeFilters: { site: "boss", params: {}, lanes: [] },
    limits: {
      maxCards: Math.max(...workflow.keywords.map((item) => Number(item.maxCards) || 0)),
      maxDetailTotal: workflow.budget.maxDetailTotal,
      browserPageBudget: workflow.budget.browserPageBudget,
      detailLimits: { A: 40, B: 30, C: 20 }
    }
  });
  const invalidAttachedBatches = [
    {
      expectedCode: "SCAN_RESUME_SNAPSHOT_MISSING",
      filterSnapshot: {}
    },
    {
      expectedCode: "SCAN_SNAPSHOT_MISMATCH",
      filterSnapshot: {
        execution: {
          ...validInheritedResumeSnapshot,
          runtimePolicyHash: "tampered-without-rehash"
        }
      }
    }
  ];
  const attachInterruptedScanBatch = (scanBatchId, label) => {
    db.prepare("UPDATE workflow_runs SET scan_run_id = NULL, scan_batch_id = NULL WHERE id = ?")
      .run(workflow.id);
    const scan = createScanRun(db, {
      runId: `workflow-invalid-resume-${label}`,
      site: "boss",
      command: "daily",
      planId: saved.planId,
      batchId: scanBatchId
    });
    attachWorkflowScan(db, {
      id: workflow.id,
      scanRunId: scan.id,
      scanBatchId
    });
    finishScanRun(db, {
      runId: scan.id,
      status: "interrupted",
      stopCode: "INJECTED_RESUME_FIXTURE"
    });
  };
  let invalidBatchIndex = 0;
  for (const invalid of invalidAttachedBatches) {
    invalidBatchIndex += 1;
    const invalidBatchId = createBatch(db, "boss", "invalid-resume", "invalid attached resume", {
      profileId: saved.profileId,
      searchPlanId: saved.planId,
      status: "interrupted",
      filterSnapshot: invalid.filterSnapshot
    });
    attachInterruptedScanBatch(invalidBatchId, invalidBatchIndex);
    const workflowRowBefore = db.prepare(
      "SELECT status, updated_at, scan_run_id, scan_batch_id FROM workflow_runs WHERE id = ?"
    ).get(workflow.id);
    const scanRunCountBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM scan_runs").get().count);
    const spawnCountBeforeInvalidBatchResume = spawns.length;
    const invalidBatchResume = await postForm(baseUrl, "/api/workflow-run/resume", {
      workflowRunId: workflow.id,
      browserMode: "portable"
    });
    assert.strictEqual(invalidBatchResume.status, 409);
    assert.match(invalidBatchResume.body, new RegExp(invalid.expectedCode));
    assert.strictEqual(spawns.length, spawnCountBeforeInvalidBatchResume);
    assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM scan_runs").get().count), scanRunCountBefore);
    assert.deepStrictEqual(
      db.prepare("SELECT status, updated_at, scan_run_id, scan_batch_id FROM workflow_runs WHERE id = ?").get(workflow.id),
      workflowRowBefore
    );
  }

  const validInheritedResumeBatchId = createBatch(db, "boss", "valid-resume", "valid attached resume", {
    profileId: saved.profileId,
    searchPlanId: saved.planId,
    status: "interrupted",
    filterSnapshot: { execution: validInheritedResumeSnapshot }
  });
  attachInterruptedScanBatch(validInheritedResumeBatchId, "valid");
  const resumed = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: workflow.id,
    browserMode: "portable"
  });
  assert.strictEqual(resumed.status, 303);
  assert.strictEqual(resumed.location, `/workflow?runId=${workflow.id}`);
  assert.strictEqual(spawns.length, 3);
  assert.strictEqual(getWorkflowRun(db, workflow.id).status, "scanning");
  assert.deepStrictEqual(
    spawns.at(-1).args.slice(spawns.at(-1).args.indexOf("--browser"), spawns.at(-1).args.indexOf("--browser") + 4),
    ["--browser", "portable", "--cdp-port", "9222"]
  );
  const legacyInherited = createWorkflowRun(db, {
    id: "workflow-legacy-inherited-edge",
    profileId: saved.profileId,
    planId: saved.planId,
    localDay: "2099-01-02",
    sequence: 1,
    targetSuccessCount: 1,
    candidateGap: 1,
    scanNeeded: true,
    keywords: [{ word: "RAG工程师", priority: "A", maxCards: 10 }],
    budget: { maxDetailTotal: 10, browserPageBudget: 2 },
    planner: {
      ...frozenPlanner,
      browserMode: "edge",
      cdpPort: undefined
    }
  });
  transitionWorkflowRun(db, { id: legacyInherited.id, status: "scanning" });
  transitionWorkflowRun(db, {
    id: legacyInherited.id,
    status: "interrupted",
    errorCode: "LEGACY_EDGE_RECOVERY",
    errorMessage: "legacy inherited browser authority"
  });
  const legacyPage = await getText(baseUrl, `/workflow?runId=${legacyInherited.id}`);
  assert.match(legacyPage.body, /name="browserMode" value="edge"/);
  assert.match(legacyPage.body, /旧版当前 Edge/);
  resumeBrowserReadinessStatus = "login_required";
  const spawnCountBeforeLegacyPreflight = spawns.length;
  const rejectedLegacyResume = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: legacyInherited.id,
    browserMode: "edge"
  });
  assert.strictEqual(rejectedLegacyResume.status, 409);
  assert.match(rejectedLegacyResume.body, /BOSS_LOGIN_REQUIRED/);
  assert.strictEqual(spawns.length, spawnCountBeforeLegacyPreflight);
  assert.deepStrictEqual(resumeBrowserProbeInputs.at(-1), { browserMode: "edge", cdpPort: 9222 });
  resumeBrowserReadinessStatus = "ready";
  const resumedScan = getLatestScanRun(db, { planId: saved.planId, site: "boss" });

  const batchId = validInheritedResumeBatchId;
  attachWorkflowScan(db, { id: workflow.id, scanRunId: resumedScan.id, scanBatchId: batchId });
  for (let index = 0; index < 6; index += 1) {
    const seededJob = index === 0 ? layeredTalkJob() : job(index + 1);
    if (index === 1) seededJob.title = "<script>health-xss</script>";
    upsertJob(db, seededJob, batchId);
  }
  upsertJob(db, lowRiskBackupJob(), batchId);
  upsertJob(db, layeredBackupJob(), batchId);
  transitionWorkflowRun(db, { id: workflow.id, status: "analyzing" });
  transitionWorkflowRun(db, { id: workflow.id, status: "review_required", inventoryCount: 6 });

  recordCandidateJobEvent(db, {
    profileId: saved.profileId,
    planId: saved.planId,
    jobId: listWorkflowReviewCandidates(db, workflow.id)[0].id,
    eventType: "review",
    payload: {}
  });
  const workflowBeforeHealthPage = listWorkflowRuns(db, {
    planId: saved.planId
  }).map((run) => ({ ...run }));
  const healthPage = await getText(
    baseUrl,
    `/workflow?runId=${encodeURIComponent(workflow.id)}`
  );

  assert.strictEqual(healthPage.status, 200);
  assert.match(healthPage.body, /\u6d41\u7a0b\u4f53\u68c0/);
  assert.match(healthPage.body, /\u5df2\u68c0\u67e5\u5c97\u4f4d/);
  assert.match(healthPage.body, /\u6700\u8fd1\u72b6\u6001\u53d8\u5316/);
  assert.match(healthPage.body, /\u5c97\u4f4d\u7f3a\u5c11\u5b8c\u6574 JD|\u5f53\u524d\u672a\u53d1\u73b0\u6d41\u7a0b\u6570\u636e\u95ee\u9898/);
  assert.deepStrictEqual(
    listWorkflowRuns(db, { planId: saved.planId }),
    workflowBeforeHealthPage,
    "鎵撳紑浣撴鍖哄潡涓嶈兘鎺ㄨ繘鎴栦慨澶嶅伐浣滄祦"
  );
  assert(!healthPage.body.includes("<script>health-xss</script>"));
  assert(healthPage.body.includes("&lt;script&gt;health-xss&lt;/script&gt;"));
  const healthPanel = healthPage.body.match(/<section class="panel workflow-health">[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(healthPanel, /\u5f85\u590d\u6838/);
  assert.match(healthPanel, /\u5c97\u4f4d #\d+/);

  const unsafePanel = renderWorkflowHealthPanel({
    status: "attention",
    summary: { jobsChecked: 0, issueCount: 1 },
    issues: [{
      severity: "warning",
      title: "unsafe href",
      message: "fixture",
      actionHref: "//external.example"
    }],
    recentEvents: [],
    truncated: {}
  });
  assert(unsafePanel.includes('href="#"'));
  assert(!unsafePanel.includes('href="//external.example"'));

  const backslashPanel = renderWorkflowHealthPanel({
    status: "attention",
    summary: { jobsChecked: 0, issueCount: 1 },
    issues: [{
      severity: "warning",
      title: "backslash href",
      message: "fixture",
      actionHref: "/\\external.example"
    }],
    recentEvents: [],
    truncated: {}
  });
  assert(backslashPanel.includes('href="#"'));
  assert(!backslashPanel.includes('href="/\\external.example"'));

  const truncatedPanel = renderWorkflowHealthPanel({
    status: "attention",
    summary: { jobsChecked: 51, issueCount: 51 },
    issues: Array.from({ length: 51 }, (_, index) => ({
      severity: "warning",
      title: `Issue ${index}`,
      message: "fixture",
      actionHref: "/queue"
    })),
    recentEvents: Array.from({ length: 21 }, (_, index) => ({
      eventType: "review",
      jobId: index + 1,
      createdAt: "2026-08-03T08:00:00.000Z"
    })),
    truncated: { issues: true, recentEvents: true }
  });
  assert.match(truncatedPanel, /记录数量超过页面上限/);

  const failOpenWarnings = [];
  const failOpenServer = createDashboardServer({
    db,
    root,
    dbPath,
    forceMock: true,
    allowOfflineMock: true,
    logger: {
      ...logger,
      warn(event, metadata) { failOpenWarnings.push({ event, metadata }); }
    },
    workflowHealth: {
      getSnapshot() {
        const error = new Error("health fixture failure");
        error.code = "C:\\Users\\Administrator\\secret.txt";
        throw error;
      }
    },
    browserReadinessProbe: async () => {
      throw Object.assign(new Error("fixture unexpected readiness failure"), {
        code: "UNEXPECTED_READINESS_FAILURE"
      });
    }
  });
  const failOpenBaseUrl = await listen(failOpenServer);
  try {
    const failedReadiness = await getText(failOpenBaseUrl, "/api/browser-readiness");
    assert.strictEqual(failedReadiness.status, 500);
    const failedReadinessPlan = await getText(failOpenBaseUrl, `/plan?planId=${unconfirmed.planId}`);
    assert.match(failedReadinessPlan.body, /data-browser-readiness-button[^>]*disabled/);
    const failOpenPage = await getText(failOpenBaseUrl, started.location);
    assert.strictEqual(failOpenPage.status, 200);
    assert.match(failOpenPage.body, /\u786e\u8ba4\u672c\u8f6e\u6c9f\u901a\u6e05\u5355/);
    assert.doesNotMatch(failOpenPage.body, /\u6d41\u7a0b\u4f53\u68c0/);
    assert.strictEqual(failOpenWarnings.length, 1);
    assert.deepStrictEqual(failOpenWarnings[0], {
      event: "workflow_health_render_failed",
      metadata: {
        workflowRunId: workflow.id,
        planId: saved.planId,
        errorCode: "WORKFLOW_HEALTH_FAILED"
      }
    });
    assert(!JSON.stringify(failOpenWarnings[0]).includes("health fixture failure"));
    assert(!JSON.stringify(failOpenWarnings[0]).includes("secret.txt"));
  } finally {
    await new Promise((resolve) => failOpenServer.close(resolve));
  }

  const reviewPage = await getText(baseUrl, started.location);
  assert.match(reviewPage.body, /确认本轮沟通清单/);
  assert.match(reviewPage.body, new RegExp(`name="workflowRunId" value="${workflow.id}"`));
  assert.match(reviewPage.body, /name="browserMode" value="portable"/);
  assert.strictEqual((reviewPage.body.match(/<input[^>]*name="jobIds"[^>]*checked/g) || []).length >= 6, true);
  assert.match(reviewPage.body, /本轮成功目标\s*35/);
  assert.match(reviewPage.body, /有效候选\s*<strong>/);
  assert.strictEqual(getWorkflowRun(db, workflow.id).inventoryCount >= 6, true);
  for (const label of ["匹配分支", "大模型应用开发", "岗位主体", "主体匹配", "基本一致", "已覆盖根基", "待确认根基"]) {
    assert.match(reviewPage.body, new RegExp(label));
  }
  assert.match(reviewPage.body, /硬性限制：岗位方向需谨慎/);
  assert.match(reviewPage.body, /workflow-tier/);
  for (const tier of ["主投", "可投", "慎投"]) assert.match(reviewPage.body, new RegExp(tier));
  const jobsPage = await getText(baseUrl, `/jobs?planId=${saved.planId}&batch=latest`);
  for (const label of ["匹配分支", "大模型应用开发", "岗位主体", "主体匹配", "基本一致", "已覆盖根基", "待确认根基"]) {
    assert.match(jobsPage.body, new RegExp(label));
  }
  assert.doesNotMatch(jobsPage.body, /简历：完成 RAG 应用交付/);

  const selectedIds = listWorkflowReviewCandidates(db, workflow.id)
    .filter((candidate) => candidate.defaultChecked)
    .map((candidate) => candidate.id);
  const confirmed = await postForm(baseUrl, "/api/communication-batch", {
    workflowRunId: workflow.id,
    planId: saved.planId,
    browserMode: "portable",
    jobIds: selectedIds
  });
  assert.strictEqual(confirmed.status, 303);
  assert.strictEqual(confirmed.location, `/workflow?runId=${workflow.id}`);

  const confirmedPage = await getText(baseUrl, confirmed.location);
  assert.match(confirmedPage.body, /清单已确认/);
  assert.match(confirmedPage.body, /name="action" value="start"/);
  assert.match(confirmedPage.body, /开始沟通/);

  transitionWorkflowRun(db, { id: workflow.id, status: "communicating" });
  transitionWorkflowRun(db, { id: workflow.id, status: "completed", successfulCount: 30, shortfallCode: "WORKFLOW_SUPPLY_EXHAUSTED" });
  for (const action of ["list_navigation", "list_navigation", "pane_detail_read", "pane_detail_read", "pane_detail_read", "pane_detail_read"]) {
    recordSiteAccessEvent(db, { site: "boss", action, runId: resumedScan.id });
  }
  const completedPage = await getText(baseUrl, confirmed.location);
  assert.match(completedPage.body, /本轮已完成/);
  assert.match(completedPage.body, /今日进度\s*<strong>30\s*\/\s*70/);
  assert.match(completedPage.body, /本轮成功\s*<strong>30/);

  const planAfter = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.match(planAfter.body, /今日进度<\/span><strong>30\s*\/\s*70/);
  assert.match(planAfter.body, /下一轮目标<\/span><strong>40/);
  assert.match(planAfter.body, /剩余详情读取预算 356 · 剩余搜索页预算 58/);
  assert.strictEqual((planAfter.body.match(/name="action" value="start"/g) || []).length, 0);
  assert.match(planAfter.body, /两轮扫描至少间隔 2 小时/);

  const rejectedWhileScanExists = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
    browserMode: "edge",
    action: "start"
  });
  assert.strictEqual(rejectedWhileScanExists.status, 409);
  assert.strictEqual(listWorkflowRuns(db, { planId: saved.planId }).length, 2);

  for (const [index, { label, cdpPort }] of [
    { label: "wrong-port", cdpPort: 9333 },
    { label: "zero-port", cdpPort: 0 },
    { label: "null-port", cdpPort: null }
  ].entries()) {
    const corruptedPortableInherited = createWorkflowRun(db, {
      id: `workflow-portable-inherited-${label}`,
      profileId: saved.profileId,
      planId: saved.planId,
      localDay: `2099-01-${String(3 + index).padStart(2, "0")}`,
      sequence: 1,
      targetSuccessCount: 1,
      candidateGap: 1,
      scanNeeded: true,
      keywords: [{ word: "RAG工程师", priority: "A", maxCards: 10 }],
      budget: { maxDetailTotal: 10, browserPageBudget: 2 },
      planner: { ...frozenPlanner, browserMode: "portable", cdpPort }
    });
    transitionWorkflowRun(db, { id: corruptedPortableInherited.id, status: "scanning" });
    transitionWorkflowRun(db, {
      id: corruptedPortableInherited.id,
      status: "interrupted",
      errorCode: "CORRUPTED_PORTABLE_PORT",
      errorMessage: "stored portable port does not match project Edge"
    });
    const spawnCountBeforeWrongPortResume = spawns.length;
    const wrongPortResume = await postForm(baseUrl, "/api/workflow-run/resume", {
      workflowRunId: corruptedPortableInherited.id,
      browserMode: "portable",
      cdpPort: 9222
    });
    assert.strictEqual(wrongPortResume.status, 409);
    assert.match(wrongPortResume.body, /INHERITED_PORTABLE_PORT_REQUIRED/);
    assert.strictEqual(spawns.length, spawnCountBeforeWrongPortResume);
    assert.strictEqual(getWorkflowRun(db, corruptedPortableInherited.id).status, "interrupted");
  }

  spawns.at(-1).child.emit("close", 0, null);
  const generatedWorkflow = createWorkflowRun(db, {
    id: "workflow-generated-portable-resume",
    profileId: saved.profileId,
    planId: saved.planId,
    localDay: "2099-01-01",
    sequence: 1,
    targetSuccessCount: 5,
    candidateGap: 5,
    scanNeeded: true,
    keywords: [{ word: "AI应用开发工程师", priority: "A", maxCards: 20 }],
    budget: { maxDetailTotal: 20, browserPageBudget: 5 },
    planner: {
      acquisitionMode: "generated",
      browserMode: "portable"
    }
  });
  transitionWorkflowRun(db, { id: generatedWorkflow.id, status: "scanning" });
  transitionWorkflowRun(db, {
    id: generatedWorkflow.id,
    status: "interrupted",
    errorCode: "INJECTED_GENERATED_INTERRUPTION",
    errorMessage: "generated portable resume fixture"
  });
  const generatedInterruptedPage = await getText(baseUrl, `/workflow?runId=${generatedWorkflow.id}`);
  assert.match(generatedInterruptedPage.body, /<select name="browserMode">/);
  assert.match(generatedInterruptedPage.body, /<option value="edge">当前已登录 Edge<\/option>/);
  assert.match(generatedInterruptedPage.body, /<option value="portable" selected>项目专用 Edge<\/option>/);
  assert.doesNotMatch(generatedInterruptedPage.body, /<input type="hidden" name="browserMode" value="edge">/);

  const generatedBeforeInvalidMode = getWorkflowRun(db, generatedWorkflow.id);
  const spawnCountBeforeInvalidGeneratedMode = spawns.length;
  const invalidGeneratedMode = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: generatedWorkflow.id,
    browserMode: "chromium",
    cdpPort: 9333
  });
  assert.strictEqual(invalidGeneratedMode.status, 409);
  assert.match(invalidGeneratedMode.body, /WORKFLOW_BROWSER_MODE_INVALID/);
  assert.strictEqual(spawns.length, spawnCountBeforeInvalidGeneratedMode);
  assert.deepStrictEqual(getWorkflowRun(db, generatedWorkflow.id), generatedBeforeInvalidMode);

  batchModelReady = false;
  const browserProbeCountBeforeModelBlockedResume = resumeBrowserProbeInputs.length;
  const modelBlockedResume = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: generatedWorkflow.id,
    browserMode: "portable",
    cdpPort: 9333
  });
  assert.strictEqual(modelBlockedResume.status, 409);
  assert.match(modelBlockedResume.body, /href="\/settings#model-profile-batch_screening"/);
  assert.strictEqual(resumeBrowserProbeInputs.length, browserProbeCountBeforeModelBlockedResume);
  assert.strictEqual(spawns.length, spawnCountBeforeInvalidGeneratedMode);
  assert.strictEqual(getWorkflowRun(db, generatedWorkflow.id).status, "interrupted");
  batchModelReady = true;

  const generatedPortableResume = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: generatedWorkflow.id,
    browserMode: "portable",
    cdpPort: 9333
  });
  assert.strictEqual(generatedPortableResume.status, 303);
  assert.strictEqual(generatedPortableResume.location, `/workflow?runId=${generatedWorkflow.id}`);
  assert.strictEqual(spawns.length, spawnCountBeforeInvalidGeneratedMode + 1);
  assert.deepStrictEqual(
    spawns.at(-1).args.slice(spawns.at(-1).args.indexOf("--browser"), spawns.at(-1).args.indexOf("--browser") + 4),
    ["--browser", "portable", "--cdp-port", "9333"]
  );
  assert.strictEqual(getWorkflowRun(db, generatedWorkflow.id).status, "scanning");

  for (const spawned of spawns) spawned.child.emit("close", 0, null);
  const progressPanelFixture = await testWorkflowStatusApi(baseUrl, db, saved);
  await testWorkflowProgressPanel(baseUrl, db, progressPanelFixture);
  await testWorkflowControlApi(
    baseUrl,
    db,
    saved,
    spawns,
    resumeBrowserProbeInputs,
    workflowControlTimers,
    (value) => { batchModelReady = value; }
  );
  await testModelTaskRouting({
    baseUrl,
    modelAccesses,
    setBatchReady(value) { batchModelReady = value; }
  });

  console.log("workflow_dashboard_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
  }
});

async function testModelTaskRouting({ baseUrl, modelAccesses, setBatchReady }) {
  const assertRoute = async ({ pathname, method = "POST", taskProfile, runtime }) => {
    modelAccesses.length = 0;
    if (method === "GET") await getText(baseUrl, pathname);
    else await postForm(baseUrl, pathname, {});
    const profiled = modelAccesses.filter((entry) => entry.taskProfile);
    assert(profiled.length, `${pathname} must use an explicit model task profile`);
    assert(
      profiled.every((entry) => entry.taskProfile === taskProfile),
      `${pathname} routed through ${JSON.stringify(profiled)} instead of ${taskProfile}`
    );
    if (runtime) {
      assert(profiled.some((entry) => entry.kind === "runtime"), `${pathname} must resolve ${taskProfile} runtime`);
    }
    assert(profiled.some((entry) => entry.kind === "ready"), `${pathname} must check ${taskProfile} readiness`);
  };

  await assertRoute({ pathname: "/onboarding", method: "GET", taskProfile: "deep_analysis", runtime: false });
  await assertRoute({ pathname: "/api/communication", taskProfile: "deep_analysis", runtime: true });
  await assertRoute({ pathname: "/api/resume", taskProfile: "deep_analysis", runtime: true });
  await assertRoute({ pathname: "/api/resume-version", taskProfile: "deep_analysis", runtime: true });
  await assertRoute({ pathname: "/api/plan/recommend", taskProfile: "deep_analysis", runtime: true });
  await assertRoute({ pathname: "/api/analyze-job", taskProfile: "batch_screening", runtime: true });
  await assertRoute({ pathname: "/api/analyze-jobs", taskProfile: "batch_screening", runtime: true });
  await assertRoute({ pathname: "/api/workflow-run", taskProfile: "batch_screening", runtime: false });
  await assertRoute({ pathname: "/api/workflow-run/resume", taskProfile: "batch_screening", runtime: false });

  setBatchReady(false);
  for (const pathname of ["/api/analyze-job", "/api/analyze-jobs"]) {
    const rejectedRetry = await postForm(baseUrl, pathname, {});
    assert.strictEqual(rejectedRetry.status, 409);
    assert.match(rejectedRetry.body, /href="\/settings#model-profile-batch_screening"/);
  }
  modelAccesses.length = 0;
  const rejectedScan = await postForm(baseUrl, "/api/scan", {});
  const profiled = modelAccesses.filter((entry) => entry.taskProfile);
  assert(profiled.some((entry) => entry.kind === "ready" && entry.taskProfile === "batch_screening"));
  assert.match(rejectedScan.body, /href="\/settings#model-profile-batch_screening"/);
  setBatchReady(true);
}

function seedProfile(database, { confirmCard = true } = {}) {
  const profile = {
    candidate: { name: "Workflow Candidate", city: "广州", targetTitles: ["AI应用开发工程师"], expectedSalary: "10-20K" },
    education: [{ school: "Test University", degree: "本科", major: "电子信息工程" }],
    experiences: [],
    skills: [{ name: "Python", evidence: ["KnowledgeFlow"] }, { name: "RAG", evidence: ["KnowledgeFlow"] }],
    projects: [{ name: "KnowledgeFlow", roleBoundary: "独立项目", canSay: ["LangGraph workflow"] }],
    credentials: [],
    strengths: []
  };
  const saved = saveProfileAnalysis(database, {
    profile,
    document: {
      originalFileName: "workflow-resume.txt",
      format: "text",
      contentHash: "workflow-dashboard-resume",
      text: "Python RAG LangGraph project experience. ".repeat(10),
      diagnostics: {}
    },
    searchPlan: {
      name: "Inherited platform-default AI",
      cities: ["测试未映射城市"],
      directions: ["AI应用开发"],
      keywords: [
        { word: "AI应用开发工程师", priority: "A", reason: "主方向" },
        { word: "大模型应用开发工程师", priority: "A", reason: "主方向" },
        { word: "Agent开发工程师", priority: "A", reason: "主方向" },
        { word: "RAG工程师", priority: "B", reason: "补充方向" },
        { word: "AI知识库开发", priority: "B", reason: "补充方向" }
      ],
      salary: { minK: 10, maxK: 20 },
      experience: ["经验不限", "1-3年"],
      jobTypes: ["全职"],
      degrees: [],
      bossActiveDays: 3,
      platform: { site: "boss" }
    }
  });
  // 工作流启动以已确认匹配偏好卡为前提；离线种子用确定性映射直接确认。
  const draft = createMatchingCardDraft(database, {
    profileId: saved.profileId,
    profileVersionId: saved.profileVersionId,
    resumeDocumentId: saved.resumeDocumentId,
    resumeContentHash: "workflow-dashboard-resume",
    card: matchingCardFromProfile(profile),
    source: "migration"
  });
  if (confirmCard) confirmMatchingCard(database, { profileId: saved.profileId, cardId: draft.id });
  return saved;
}

async function testWorkflowStatusApi(baseUrl, database, saved) {
  const fixture = seedWorkflowApiFixture(database, saved, {
    localDay: "2099-02-01",
    resumePhase: "analyzing"
  });
  seedSensitiveCommunicationFixture(database, fixture);
  const before = getWorkflowRun(database, fixture.workflowId);
  const response = await getJson(baseUrl, `/api/workflow-status?runId=${encodeURIComponent(fixture.workflowId)}`);
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(Object.keys(response.body).sort(), [
    "communication",
    "controls",
    "model",
    "progress",
    "recentActivity",
    "today",
    "workflow"
  ]);
  assert.strictEqual(response.body.workflow.id, fixture.workflowId);
  assert.strictEqual(response.body.workflow.status, "analyzing");
  assert.strictEqual(response.body.progress.analysis.total, 2);
  assert.strictEqual(response.body.progress.analysis.succeeded, 1);
  assert.strictEqual(response.body.progress.analysis.pending, 1);
  assert.strictEqual(response.body.progress.stageIndex, 4);
  assert.strictEqual(response.body.model.profile, "batch_screening");
  assert.strictEqual(response.body.model.model, "fixture-batch-model");
  assert.strictEqual(response.body.controls.stopConsumesRunSlot, true);
  assert(Array.isArray(response.body.recentActivity));
  assert.deepStrictEqual(Object.keys(response.body.communication).sort(), ["batch", "summary"]);
  assert.deepStrictEqual(Object.keys(response.body.communication.batch).sort(), ["id", "status"]);
  const serialized = JSON.stringify(response.body);
  for (const secret of [
    "private-workflow-error-message",
    "private-planner-secret",
    "Workflow API Job",
    "private workflow API JD",
    "https://www.zhipin.com/job_detail/workflow-api",
    "private-communication-title",
    "private-communication-company",
    "https://www.zhipin.com/job_detail/private-communication.html",
    "private-communication-evidence",
    "private-communication-error",
    "private-communication-policy",
    "private-communication-stop-message"
  ]) {
    assert(!serialized.includes(secret), `workflow status must not expose ${secret}`);
  }
  assert.deepStrictEqual(getWorkflowRun(database, fixture.workflowId), before);

  const unknown = await getJson(baseUrl, "/api/workflow-status?runId=missing-workflow-api-run");
  assert.strictEqual(unknown.status, 404);
  assert.strictEqual(unknown.body.errorCode, "WORKFLOW_RUN_NOT_FOUND");
  return fixture;
}

async function testWorkflowProgressPanel(baseUrl, database, fixture) {
  const page = await getText(
    baseUrl,
    `/workflow?runId=${encodeURIComponent(fixture.workflowId)}`
  );
  assert.strictEqual(page.status, 200);
  for (const hook of [
    "data-workflow-panel",
    "data-progress-revision",
    "data-stage-label",
    "data-stage-name",
    "data-analysis-succeeded",
    "data-analysis-detail-required",
    "data-analysis-failed",
    "data-analysis-remaining",
    "data-analysis-timeouts",
    "data-eta",
    "data-recent-activity",
    "data-stop-collected",
    "data-stop-slot",
    "data-workflow-error"
  ]) {
    assert.match(page.body, new RegExp(hook), `workflow panel must expose ${hook}`);
  }
  assert.match(page.body, /第 4 阶段\s*\/\s*共 5 阶段/);
  assert.match(page.body, /分析岗位/);
  assert.match(page.body, /data-analysis-succeeded[^>]*>1</);
  assert.match(page.body, /data-analysis-failed[^>]*>0</);
  assert.match(page.body, /data-analysis-remaining[^>]*>1</);
  assert.match(page.body, /当前恢复周期最终超时\s*0\s*\/\s*10/);
  assert.match(page.body, /本轮累计超时\s*0/);
  assert.match(page.body, /正在估算/);
  assert.match(page.body, /data-action="pause"/);
  assert.match(page.body, /data-action="stop-preview"/);
  assert.match(page.body, /action="\/api\/workflow-control"/);
  assert.match(
    page.body,
    new RegExp(`name="workflowRunId" value="${fixture.workflowId}"`)
  );
  assert.match(page.body, /data-stop-confirmation[^>]*hidden/);
  assert.match(page.body, /data-stop-collected>2</);
  assert.match(page.body, /data-stop-analyzed>1</);
  assert.match(page.body, /data-stop-unfinished>1</);
  assert.match(page.body, /会占用今天一轮/);
  assert.match(page.body, /name="confirmStop" value="1"/);
  const livePanelAndClient = page.body.slice(page.body.indexOf("data-workflow-panel"));
  for (const sensitive of [
    "Workflow API Job",
    "Private Workflow API Company",
    "private workflow API JD",
    "private-workflow-error-message",
    "private-planner-secret"
  ]) {
    assert(!livePanelAndClient.includes(sensitive), `live progress panel must not expose ${sensitive}`);
  }

  const script = extractWorkflowProgressScript(page.body);
  assert.match(script, /\/api\/workflow-status\?runId=/);
  assert.match(script, /cache:\s*["']no-store["']/);
  assert.match(script, /2500/);
  assert.match(script, /progressRevision/);
  assert.match(script, /renderWorkflowProgress/);
  assert.match(script, /renderWorkflowControls/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /innerHTML/);
  assert.doesNotMatch(script, /location\.reload/);
  assert.match(script, /无法读取任务状态/);
  assert.match(script, /setControlsDisabled\(true\)/);
  assert.match(script, /renderWorkflowControls\(snapshot\).*if\(nextKey===lastKey\)return/);
  assert.match(script, /clearInterval/);

  transitionWorkflowRun(database, {
    id: fixture.workflowId,
    status: "paused",
    resumePhase: "analyzing",
    errorCode: "MODEL_TIMEOUT_CIRCUIT_OPEN"
  });
  const pausedPage = await getText(
    baseUrl,
    `/workflow?runId=${encodeURIComponent(fixture.workflowId)}`
  );
  assert.strictEqual(pausedPage.status, 200);
  assert.match(pausedPage.body, /本轮已暂停/);
  assert.match(pausedPage.body, /MODEL_TIMEOUT_CIRCUIT_OPEN/);
  assert.match(pausedPage.body, /测试批量模型连接/);
  assert.match(pausedPage.body, /调整批量模型/);
  assert.match(pausedPage.body, /data-action="resume"/);
  assert.match(pausedPage.body, /继续本轮/);
  assert.match(pausedPage.body, /结束本轮…/);
}

function seedSensitiveCommunicationFixture(database, fixture) {
  const workflow = getWorkflowRun(database, fixture.workflowId);
  const jobId = Number(database.prepare(`
    SELECT job_id
    FROM job_observations
    WHERE batch_id = ?
    ORDER BY id
    LIMIT 1
  `).get(fixture.batchId).job_id);
  const now = "2099-02-01T00:00:02.000Z";
  const communicationBatchId = Number(database.prepare(`
    INSERT INTO communication_batches(
      site, profile_id, plan_id, browser_mode, status, policy_json,
      confirmed_at, stop_message, created_at, updated_at
    ) VALUES ('boss', ?, ?, 'portable', 'confirmed', ?, ?, ?, ?, ?)
  `).run(
    workflow.profileId,
    workflow.planId,
    JSON.stringify({ secret: "private-communication-policy" }),
    now,
    "private-communication-stop-message",
    now,
    now
  ).lastInsertRowid);
  database.prepare(`
    INSERT INTO communication_batch_items(
      batch_id, job_id, position, job_url, title_snapshot, company_snapshot,
      status, evidence_json, error_code, error_message, updated_at
    ) VALUES (?, ?, 1, ?, ?, ?, 'pending', ?, 'PRIVATE_CODE', ?, ?)
  `).run(
    communicationBatchId,
    jobId,
    "https://www.zhipin.com/job_detail/private-communication.html",
    "private-communication-title",
    "private-communication-company",
    JSON.stringify({ raw: "private-communication-evidence" }),
    "private-communication-error",
    now
  );
  database.prepare("UPDATE workflow_runs SET communication_batch_id = ? WHERE id = ?")
    .run(communicationBatchId, fixture.workflowId);
}

async function testWorkflowControlApi(
  baseUrl,
  database,
  saved,
  spawns,
  resumeBrowserProbeInputs,
  workflowControlTimers,
  setBatchReady
) {
  const detachedPause = seedWorkflowApiFixture(database, saved, {
    localDay: "2099-02-06",
    resumePhase: "analyzing"
  });
  const detachedPauseResponse = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: detachedPause.workflowId,
    action: "pause"
  });
  assert.strictEqual(detachedPauseResponse.status, 303);
  assert.strictEqual(getWorkflowRun(database, detachedPause.workflowId).status, "analyzing");
  assert.strictEqual(getWorkflowRun(database, detachedPause.workflowId).controlState, "pause_requested");
  assert.strictEqual(getScanRun(database, detachedPause.scanRunId).status, "running");
  finishScanRun(database, {
    runId: detachedPause.scanRunId,
    status: "interrupted",
    stopCode: "WORKFLOW_PAUSE_REQUESTED"
  });
  finalizeWorkflowControl(database, {
    workflowRunId: detachedPause.workflowId,
    now: "2099-02-06T00:00:03.000Z"
  });
  assert.strictEqual(getWorkflowRun(database, detachedPause.workflowId).status, "paused");

  const detachedStop = seedWorkflowApiFixture(database, saved, {
    localDay: "2099-02-07",
    resumePhase: "scanning"
  });
  const detachedStopResponse = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: detachedStop.workflowId,
    action: "stop",
    confirmStop: 1
  });
  assert.strictEqual(detachedStopResponse.status, 303);
  assert.strictEqual(getWorkflowRun(database, detachedStop.workflowId).status, "scanning");
  assert.strictEqual(getWorkflowRun(database, detachedStop.workflowId).controlState, "stop_requested");
  assert.strictEqual(getScanRun(database, detachedStop.scanRunId).status, "running");
  finishScanRun(database, {
    runId: detachedStop.scanRunId,
    status: "interrupted",
    stopCode: "WORKFLOW_STOP_REQUESTED"
  });
  finalizeWorkflowControl(database, {
    workflowRunId: detachedStop.workflowId,
    now: "2099-02-07T00:00:03.000Z"
  });
  assert.strictEqual(getWorkflowRun(database, detachedStop.workflowId).status, "stopped");

  const analyzing = seedWorkflowApiFixture(database, saved, {
    localDay: "2099-02-02",
    resumePhase: "analyzing"
  });
  finishScanRun(database, {
    runId: analyzing.scanRunId,
    status: "completed",
    stopCode: "WORKFLOW_API_SCAN_COMPLETE"
  });

  const pause = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: analyzing.workflowId,
    action: "pause"
  });
  assert.strictEqual(pause.status, 303);
  assert.strictEqual(pause.location, `/workflow?runId=${analyzing.workflowId}`);
  assert.strictEqual(getWorkflowRun(database, analyzing.workflowId).status, "paused");

  setBatchReady(false);
  const spawnCountBeforeModelBlockedControlResume = spawns.length;
  const modelBlockedControlResume = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: analyzing.workflowId,
    action: "resume"
  });
  assert.strictEqual(modelBlockedControlResume.status, 409);
  assert.match(modelBlockedControlResume.body, /MODEL_CONFIGURATION_REQUIRED/);
  assert.strictEqual(spawns.length, spawnCountBeforeModelBlockedControlResume);
  assert.strictEqual(getWorkflowRun(database, analyzing.workflowId).status, "paused");
  setBatchReady(true);

  const browserProbeCountBeforeAnalysisResume = resumeBrowserProbeInputs.length;
  const spawnCountBeforeAnalysisResume = spawns.length;
  setSiteRuntimeState(database, "boss", {
    status: "blocked",
    reasonCode: "BOSS_RISK_CONTROL",
    message: "fixture block must not affect local analysis",
    details: { blockedUntil: "2099-12-31T23:59:59.000Z" }
  });
  const resume = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: analyzing.workflowId,
    action: "resume"
  });
  assert.strictEqual(resume.status, 303, resume.body);
  assert.strictEqual(resume.location, `/workflow?runId=${analyzing.workflowId}`);
  assert.strictEqual(resumeBrowserProbeInputs.length, browserProbeCountBeforeAnalysisResume);
  assert.strictEqual(spawns.length, spawnCountBeforeAnalysisResume + 1);
  assert(spawns.at(-1).args.includes("--workflow-run"));
  assert(spawns.at(-1).args.includes(analyzing.workflowId));
  assert(spawns.at(-1).args.includes("--analysis-only"));
  assert.strictEqual(getWorkflowRun(database, analyzing.workflowId).status, "analyzing");
  const liveAnalysisStatus = await getJson(
    baseUrl,
    `/api/workflow-status?runId=${encodeURIComponent(analyzing.workflowId)}`
  );
  assert.strictEqual(liveAnalysisStatus.status, 200);
  assert.strictEqual(liveAnalysisStatus.body.workflow.status, "analyzing");
  clearSiteRuntimeState(database, "boss");

  const repeatedResume = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: analyzing.workflowId,
    action: "resume"
  });
  assert.strictEqual(repeatedResume.status, 303);
  assert.strictEqual(spawns.length, spawnCountBeforeAnalysisResume + 1);

  const activePause = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: analyzing.workflowId,
    action: "pause"
  });
  assert.strictEqual(activePause.status, 303);
  assert.strictEqual(getWorkflowRun(database, analyzing.workflowId).controlState, "pause_requested");
  const pauseTimer = workflowControlTimers.at(-1);
  assert.strictEqual(pauseTimer.delayMs, 1234);
  assert.strictEqual(pauseTimer.unrefCalled, true);
  assert.strictEqual(spawns.at(-1).child.killCalls.length, 0);
  await pauseTimer.callback();
  assert.deepStrictEqual(spawns.at(-1).child.killCalls, ["SIGTERM"]);
  spawns.at(-1).child.emit("close", null, "SIGTERM");
  assert.strictEqual(getWorkflowRun(database, analyzing.workflowId).status, "paused");
  assert.strictEqual(getWorkflowRun(database, analyzing.workflowId).controlState, "none");

  const resumedAfterForcedSettle = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: analyzing.workflowId,
    action: "resume"
  });
  assert.strictEqual(resumedAfterForcedSettle.status, 303);
  assert.strictEqual(spawns.length, spawnCountBeforeAnalysisResume + 2);
  const secondActivePause = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: analyzing.workflowId,
    action: "pause"
  });
  assert.strictEqual(secondActivePause.status, 303);
  finalizeWorkflowControl(database, {
    workflowRunId: analyzing.workflowId,
    now: "2099-02-02T00:00:04.000Z"
  });
  const settlingResume = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: analyzing.workflowId,
    action: "resume"
  });
  assert.strictEqual(settlingResume.status, 409);
  assert.match(settlingResume.body, /WORKFLOW_CONTROL_SETTLING/);
  assert.strictEqual(getWorkflowRun(database, analyzing.workflowId).status, "paused");

  spawns.at(-1).child.emit("close", 0, null);
  const settledResume = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: analyzing.workflowId,
    action: "resume"
  });
  assert.strictEqual(settledResume.status, 303, settledResume.body);
  assert.strictEqual(spawns.length, spawnCountBeforeAnalysisResume + 3);
  assert.strictEqual(getWorkflowRun(database, analyzing.workflowId).status, "analyzing");
  spawns.at(-1).child.emit("close", 0, null);

  const interruptedAnalysis = seedWorkflowApiFixture(database, saved, {
    localDay: "2099-02-08",
    resumePhase: "analyzing"
  });
  finishScanRun(database, {
    runId: interruptedAnalysis.scanRunId,
    status: "interrupted",
    stopCode: "ANALYSIS_CHILD_INTERRUPTED"
  });
  transitionWorkflowRun(database, {
    id: interruptedAnalysis.workflowId,
    status: "interrupted",
    errorCode: "ANALYSIS_CHILD_INTERRUPTED"
  });
  const probeCountBeforeInterruptedAnalysisResume = resumeBrowserProbeInputs.length;
  const spawnCountBeforeInterruptedAnalysisResume = spawns.length;
  setSiteRuntimeState(database, "boss", {
    status: "blocked",
    reasonCode: "BOSS_RISK_CONTROL",
    message: "fixture block must not affect interrupted local analysis",
    details: { blockedUntil: "2099-12-31T23:59:59.000Z" }
  });
  const interruptedAnalysisResume = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: interruptedAnalysis.workflowId,
    browserMode: "portable"
  });
  assert.strictEqual(interruptedAnalysisResume.status, 303, interruptedAnalysisResume.body);
  assert.strictEqual(
    resumeBrowserProbeInputs.length,
    probeCountBeforeInterruptedAnalysisResume,
    "interrupted analysis resume must not probe BOSS browser readiness"
  );
  assert.strictEqual(spawns.length, spawnCountBeforeInterruptedAnalysisResume + 1);
  assert(spawns.at(-1).args.includes("--analysis-only"));
  assert(!spawns.at(-1).args.includes("--resume-batch"));
  const resumedInterruptedAnalysis = getWorkflowRun(database, interruptedAnalysis.workflowId);
  assert.strictEqual(resumedInterruptedAnalysis.status, "analyzing");
  assert.strictEqual(resumedInterruptedAnalysis.resumePhase, null);
  clearSiteRuntimeState(database, "boss");
  spawns.at(-1).child.emit("close", 0, null);

  const invalidScanningResume = seedWorkflowApiFixture(database, saved, {
    localDay: "2099-02-04",
    resumePhase: "scanning"
  });
  finishScanRun(database, {
    runId: invalidScanningResume.scanRunId,
    status: "completed",
    stopCode: "WORKFLOW_API_SCAN_COMPLETE"
  });
  const scanningPause = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: invalidScanningResume.workflowId,
    action: "pause"
  });
  assert.strictEqual(scanningPause.status, 303);
  assert.strictEqual(getWorkflowRun(database, invalidScanningResume.workflowId).status, "paused");
  const probeCountBeforeScanningResume = resumeBrowserProbeInputs.length;
  const rejectedScanningResume = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: invalidScanningResume.workflowId,
    action: "resume"
  });
  assert.strictEqual(rejectedScanningResume.status, 409);
  assert.match(rejectedScanningResume.body, /SCAN_RESUME_STATUS_INVALID/);
  assert.strictEqual(resumeBrowserProbeInputs.length, probeCountBeforeScanningResume + 1);
  assert.strictEqual(getWorkflowRun(database, invalidScanningResume.workflowId).status, "paused");

  const stopping = seedWorkflowApiFixture(database, saved, {
    localDay: "2099-02-03",
    resumePhase: "analyzing"
  });
  const missingConfirmation = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: stopping.workflowId,
    action: "stop"
  });
  assert.strictEqual(missingConfirmation.status, 409);
  assert.match(missingConfirmation.body, /WORKFLOW_STOP_CONFIRMATION_REQUIRED/);
  assert.notStrictEqual(getWorkflowRun(database, stopping.workflowId).status, "stopped");

  finishScanRun(database, {
    runId: stopping.scanRunId,
    status: "completed",
    stopCode: "WORKFLOW_API_SCAN_COMPLETE"
  });
  const stop = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: stopping.workflowId,
    action: "stop",
    confirmStop: 1
  });
  assert.strictEqual(stop.status, 303);
  assert.strictEqual(getWorkflowRun(database, stopping.workflowId).status, "stopped");
  const repeatedStop = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: stopping.workflowId,
    action: "stop",
    confirmStop: 1
  });
  assert.strictEqual(repeatedStop.status, 303);
  assert.strictEqual(getWorkflowRun(database, stopping.workflowId).status, "stopped");

  const scanning = seedWorkflowApiFixture(database, saved, {
    localDay: "2099-02-05",
    resumePhase: "scanning"
  });
  requestWorkflowStop(database, {
    workflowRunId: scanning.workflowId,
    confirmStop: true,
    now: "2099-02-05T00:00:02.000Z"
  });
  finalizeWorkflowControl(database, {
    workflowRunId: scanning.workflowId,
    now: "2099-02-05T00:00:03.000Z"
  });
  const terminalResume = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: scanning.workflowId,
    action: "resume"
  });
  assert.strictEqual(terminalResume.status, 409);
  assert.match(terminalResume.body, /WORKFLOW_RUN_TERMINAL/);

  const unknown = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: "missing-workflow-control-run",
    action: "pause"
  });
  assert.strictEqual(unknown.status, 409);
  assert.match(unknown.body, /WORKFLOW_CONTROL_TARGET_MISMATCH/);

  const invalid = await postForm(baseUrl, "/api/workflow-control", {
    workflowRunId: analyzing.workflowId,
    action: "explode"
  });
  assert.strictEqual(invalid.status, 409);
  assert.match(invalid.body, /WORKFLOW_CONTROL_ACTION_INVALID/);
}

function seedWorkflowApiFixture(database, saved, {
  localDay,
  resumePhase
}) {
  const batchId = createBatch(database, "boss", "workflow-api", "workflow API fixture", {
    profileId: saved.profileId,
    searchPlanId: saved.planId
  });
  for (let index = 1; index <= 2; index += 1) {
    upsertJob(database, {
      ...job(`api-${localDay}-${index}`),
      sourceId: `workflow-api-${localDay}-${index}`,
      title: `Workflow API Job ${index}`,
      company: `Private Workflow API Company ${index}`,
      url: `https://www.zhipin.com/job_detail/workflow-api-${localDay}-${index}.html`,
      description: `private workflow API JD ${index}`
    }, batchId);
  }
  const workflow = createWorkflowRun(database, {
    profileId: saved.profileId,
    planId: saved.planId,
    localDay,
    sequence: 1,
    targetSuccessCount: 35,
    inventoryCount: 2,
    candidateGap: 33,
    scanNeeded: true,
    keywords: [{ word: "workflow-api", priority: "A" }],
    budget: { maxDetailTotal: 20, browserPageBudget: 4 },
    modelConfigRevision: "fixture-batch-revision",
    planner: {
      acquisitionMode: "generated",
      browserMode: "portable",
      cdpPort: 9222,
      privateSecret: "private-planner-secret",
      modelProfiles: {
        batch_screening: {
          provider: "mock",
          model: "fixture-batch-model",
          revision: "fixture-batch-revision",
          concurrency: 2
        }
      }
    },
    metrics: { access: { details: 2, pages: 1, scrolls: 0 } }
  });
  const scan = createScanRun(database, {
    runId: `workflow-api-scan-${localDay}`,
    site: "boss",
    command: "daily",
    planId: saved.planId,
    batchId
  });
  transitionWorkflowRun(database, { id: workflow.id, status: "scanning" });
  attachWorkflowScan(database, {
    id: workflow.id,
    scanRunId: scan.id,
    scanBatchId: batchId
  });
  transitionWorkflowRun(database, {
    id: workflow.id,
    status: "analyzing",
    platformAccessStartedAt: `${localDay}T00:00:01.000Z`,
    modelConfigRevision: "fixture-batch-revision"
  });
  if (resumePhase === "scanning") {
    database.prepare("UPDATE workflow_runs SET status = 'scanning' WHERE id = ?").run(workflow.id);
  }
  const observations = database.prepare(`
    SELECT id AS observation_id, job_id
    FROM job_observations
    WHERE batch_id = ?
    ORDER BY id
  `).all(batchId);
  observations.forEach((row, index) => {
    insertWorkflowJobTaskRow(database, {
      workflowRunId: workflow.id,
      batchId,
      jobId: Number(row.job_id),
      observationId: Number(row.observation_id),
      position: index + 1,
      status: index === 0 ? "succeeded" : "pending",
      recoveryGeneration: 0,
      modelConfigRevision: "fixture-batch-revision",
      now: `${localDay}T00:00:01.000Z`
    });
  });
  database.prepare("UPDATE workflow_runs SET error_message = ? WHERE id = ?")
    .run("private-workflow-error-message", workflow.id);
  if (resumePhase) {
    database.prepare("UPDATE workflow_runs SET resume_phase = ? WHERE id = ?")
      .run(resumePhase, workflow.id);
  }
  return {
    workflowId: workflow.id,
    batchId,
    scanRunId: scan.id
  };
}

function job(index) {
  return {
    source: "boss",
    sourceId: `workflow-dashboard-${index}`,
    keyword: "AI应用开发工程师",
    title: `AI应用开发工程师 ${index}`,
    company: `Company ${index}`,
    location: "广州",
    salary: "10-15K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/workflow-dashboard-${index}.html`,
    tags: ["Python", "RAG"],
    description: "负责 Python RAG 应用开发、检索优化、接口联调、测试与线上问题排查。".repeat(6),
    score: 28 - index,
    level: "优先",
    matches: ["Python", "RAG"],
    risks: [],
    qualityTags: ["salary_target_core"],
    analysis: {
      provider: "openai_compatible",
      semanticStatus: "complete",
      recommendation: "primary",
      recommendationSchemaVersion: 2,
      fitLevel: "fit",
      confidence: 0.9,
      evidence: { jd: ["Python RAG"], resume: ["Python RAG"] },
      hardBlockers: []
    }
  };
}

function layeredBackupJob() {
  return {
    ...job("layered-backup"),
    analysis: {
      ...job("layered-backup").analysis,
      recommendation: "caution",
      fitLevel: "mostly_fit",
      roleSummary: "负责 RAG 应用交付与持续优化",
      responsibilityEvidence: ["JD：负责 RAG 应用交付"],
      roleAlignment: "misaligned",
      roleResumeEvidence: ["简历：完成 RAG 应用交付"],
      roleGaps: ["生产环境部署经验待确认"],
      hardBlockers: ["岗位方向需谨慎"],
      requirementMatches: [
        { requirement: "RAG 应用交付", foundation: true, state: "matched" },
        { requirement: "生产环境部署", foundation: true, state: "unknown" }
      ]
    }
  };
}

function lowRiskBackupJob() {
  return {
    ...job("low-risk-backup"),
    analysis: {
      ...job("low-risk-backup").analysis,
      recommendation: "caution",
      fitLevel: "mostly_fit"
    },
    qualityTags: ["salary_target_core", "experience_salary_overlap"]
  };
}

function layeredTalkJob() {
  return {
    ...job("layered-talk"),
    analysis: {
      ...job("layered-talk").analysis,
      recommendation: "apply",
      fitLevel: "mostly_fit",
      selectedTrackId: "T1",
      selectedTrackLabel: "大模型应用开发",
      roleSummary: "负责 RAG 应用交付与持续优化",
      responsibilityEvidence: ["JD：负责 RAG 应用交付"],
      roleAlignment: "mostly_aligned",
      roleResumeEvidence: ["简历：完成 RAG 应用交付"],
      roleGaps: ["生产环境部署经验待确认"],
      requirementMatches: [
        { requirement: "RAG 应用交付", foundation: true, state: "matched" },
        { requirement: "生产环境部署", foundation: true, state: "unknown" }
      ]
    }
  };
}

async function listen(target) {
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${target.address().port}`;
}

async function getText(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.text() };
}

async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.json() };
}

function extractBrowserReadinessScript(page) {
  const match = String(page).match(/<script>\s*(\(function\(\)\{[\s\S]*?setInterval\(refreshReadiness, 5000\);[\s\S]*?\}\)\(\);)\s*<\/script>/);
  assert(match, "expected rendered plan page to include the browser-readiness polling script");
  return match[1];
}

function extractWorkflowProgressScript(page) {
  const match = String(page).match(/<script data-workflow-progress-client>([\s\S]*?)<\/script>/);
  assert(match, "expected rendered workflow page to include the incremental progress script");
  return match[1];
}

async function assertBrowserReadinessGate({ readinessScript, status = "login_required", baseDisabled = false, responseOk = true, fetchError = null, expectedDisabled }) {
  let intervalCallback = null;
  let intervalMs = null;
  let formSubmitCalls = 0;
  const form = {
    submit() { formSubmitCalls += 1; },
    requestSubmit() { formSubmitCalls += 1; }
  };
  const button = {
    dataset: { browserBaseDisabled: String(baseDisabled) },
    disabled: true,
    form
  };
  const statusNode = { textContent: "", dataset: {} };
  const context = vm.createContext({
    document: {
      getElementById(id) { return id === "browser-readiness-status" ? statusNode : null; },
      querySelector(selector) { return selector === "[data-browser-readiness-button]" ? button : null; }
    },
    fetch() {
      if (fetchError) return Promise.reject(fetchError);
      return Promise.resolve({
        ok: responseOk,
        json: async () => ({ status, message: `fixture ${status}` })
      });
    },
    setInterval(callback, interval) {
      intervalCallback = callback;
      intervalMs = interval;
      return 1;
    }
  });
  new vm.Script(readinessScript).runInContext(context);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(typeof intervalCallback, "function");
  assert.strictEqual(intervalMs, 5000);
  assert.strictEqual(button.disabled, expectedDisabled);
  assert.strictEqual(formSubmitCalls, 0);
}

async function assertSerializedSlowBrowserReadinessGate(readinessScript) {
  const requests = [];
  let intervalCallback = null;
  let intervalMs = null;
  const button = {
    dataset: { browserBaseDisabled: "false" },
    disabled: true
  };
  const statusNode = { textContent: "", dataset: {} };
  const context = vm.createContext({
    document: {
      getElementById(id) { return id === "browser-readiness-status" ? statusNode : null; },
      querySelector(selector) { return selector === "[data-browser-readiness-button]" ? button : null; }
    },
    fetch() {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
    setInterval(callback, interval) {
      intervalCallback = callback;
      intervalMs = interval;
      return 1;
    }
  });
  new vm.Script(readinessScript).runInContext(context);
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(button.disabled, true);
  assert.strictEqual(intervalMs, 5000);

  const overlappingTick = intervalCallback();
  assert.strictEqual(
    requests.length,
    1,
    "a 5000ms timer tick must not start another readiness request while the first is still in flight"
  );
  await overlappingTick;

  requests[0].resolve(readinessResponse("ready"));
  await flushPromises();
  assert.strictEqual(statusNode.dataset.status, "ready", "a slow first response must still update the status");
  assert.strictEqual(button.disabled, false, "a slow ready response must still enable an otherwise eligible workflow");

  const nextRequest = intervalCallback();
  assert.strictEqual(requests.length, 2, "the next timer tick may start only after the first request completes");
  assert.strictEqual(button.disabled, true, "each readiness request must fail closed before awaiting its response");
  requests[1].resolve(readinessResponse("risk_control"));
  await nextRequest;
  assert.strictEqual(statusNode.dataset.status, "risk_control");
  assert.strictEqual(button.disabled, true);
}

function readinessResponse(status) {
  return {
    ok: true,
    json: async () => ({ status, message: `fixture ${status}` })
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function postForm(baseUrl, pathname, body) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
    redirect: "manual"
  });
  return { status: response.status, location: response.headers.get("location"), body: await response.text() };
}
