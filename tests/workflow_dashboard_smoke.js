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
  beginScanRun,
  finishScanRun,
  attachWorkflowScan,
  createBatch,
  transitionWorkflowRun,
  upsertJob,
  insertWorkflowJobTaskRow,
  setSiteRuntimeState,
  getSiteRuntimeState,
  clearSiteRuntimeState,
  recordCandidateJobEvent,
  recordSiteAccessEvent
} = require("../src/core/storage");
const { matchingCardFromProfile } = require("../src/core/matching_card");
const { listWorkflowReviewCandidates } = require("../src/core/workflow_inventory");
const { buildScanExecutionSnapshot } = require("../src/core/scan_snapshot");
const { finalizeWorkflowControl, requestWorkflowStop } = require("../src/core/workflow_control");
const {
  createCommunicationBatch,
  listCommunicationBatchItems,
  setCommunicationBatchStatus,
  transitionCommunicationItem
} = require("../src/core/communication_batches");
const {
  createDashboardServer,
  inspectDashboardBossBrowserReadiness,
  resolveLiveInheritedContext
} = require("../src/dashboard/server");
const boss = require("../src/adapters/sites/boss");
const { renderWorkflowHealthPanel } = require("../src/dashboard/workflow_health_view");
const {
  BUDGET: workflowStatusReadBudget,
  STALE_BUDGET: workflowStatusStaleReadBudget,
  measureWorkflowStatusRead,
  measureLegacyWorkflowStatusRead
} = require("../scripts/benchmark-workflow-status-read-model");

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
    action: "login",
    checkedAt: "2099-01-01T00:00:00.000Z"
  };
  const browserReadinessInputs = [];
  const acquisitionContextResolver = async ({ plan, matchingContext, browserMode, cdpPort }) => {
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
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
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
    acquisitionContextResolver,
    inheritedPreviewResolver: acquisitionContextResolver,
    browserReadinessProbe: async (authority) => {
      browserReadinessInputs.push(authority);
      return { ...browserReadiness };
    },
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
      assert.strictEqual(args.includes("--data-root"), false, "developer child commands must retain repository-root fallback");
      if (args.includes("--workflow-run")) {
        const workflowRunId = args[args.indexOf("--workflow-run") + 1];
        const scanRunId = args[args.indexOf("--run-id") + 1];
        const workflow = getWorkflowRun(db, workflowRunId);
        const scan = getScanRun(db, scanRunId);
        assert(workflow, "workflow must be persisted before spawn");
        assert(scan, "scan run must be persisted before spawn");
        assert.strictEqual(scan.status, "running");
        assert.strictEqual(scan.planId, workflow.planId);
        assert.strictEqual(
          workflow.scanRunId,
          scan.id,
          "workflow must be bound to the persisted scan before spawn"
        );
        if (args.includes("--resume-batch")) {
          assert.strictEqual(
            String(workflow.scanBatchId),
            args[args.indexOf("--resume-batch") + 1],
            "resume batch must be bound to the workflow before spawn"
          );
        }
        if (args.includes("--analysis-only")) assert(!args.includes("--resume-batch"));
      }
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

  await testDashboardFixedTabReadinessAndInheritedContext({ db, logger, saved });

  const health = await getJson(baseUrl, "/health");
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.body.ok, true);
  assert.strictEqual(health.body.projectRoot, path.resolve(root));
  assert.strictEqual(health.body.pid, process.pid);

  const loginReadiness = await getJson(baseUrl, "/api/browser-readiness");
  assert.strictEqual(loginReadiness.status, 200);
  assert.deepStrictEqual(loginReadiness.body, browserReadiness);
  assert.deepStrictEqual(browserReadinessInputs.at(-1), { browserMode: "edge", cdpPort: null });

  const portableReadiness = await getJson(baseUrl, "/api/browser-readiness?browserMode=portable&cdpPort=9222");
  assert.strictEqual(portableReadiness.status, 409);
  assert.match(JSON.stringify(portableReadiness.body), /DASHBOARD_BROWSER_AUTHORITY_MISMATCH/);
  assert.deepStrictEqual(browserReadinessInputs.at(-1), { browserMode: "edge", cdpPort: null });

  const gatedPlanPage = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.match(gatedPlanPage.body, /data-browser-readiness-button/);
  assert.match(gatedPlanPage.body, /data-browser-base-disabled="false"/);
  assert.match(gatedPlanPage.body, /id="browser-readiness-status"/);
  assert.match(gatedPlanPage.body, /\/api\/browser-readiness/);
  assert.match(gatedPlanPage.body, /5000/);
  assert.match(gatedPlanPage.body, /disabled[^>]*>开始一轮岗位发现/);
  assert.match(gatedPlanPage.body, /name="browserMode" value="edge"/);
  assert.doesNotMatch(gatedPlanPage.body, /value="portable"/);
  const inheritedPreview = await getJson(baseUrl, `/api/acquisition-preview?planId=${saved.planId}`);
  assert.strictEqual(inheritedPreview.status, 200);
  assert.strictEqual(inheritedPreview.body.mode, "inherited");
  assert.deepStrictEqual(inheritedPreview.body.filters, ["地点：全国", "薪资：10-20K"]);
  assert.strictEqual(JSON.stringify(inheritedPreview.body).includes("https://www.zhipin.com"), false);
  assert.strictEqual(JSON.stringify(inheritedPreview.body).includes("securityId"), false);
  const previewCallsBeforeDrift = inheritedResolutionCount;
  const driftedPreview = await getJson(baseUrl, `/api/acquisition-preview?planId=${saved.planId}&browserMode=portable&cdpPort=9222`);
  assert.strictEqual(driftedPreview.status, 409);
  assert.match(JSON.stringify(driftedPreview.body), /DASHBOARD_BROWSER_AUTHORITY_MISMATCH/);
  assert.strictEqual(inheritedResolutionCount, previewCallsBeforeDrift, "preview drift must fail before BOSS access");
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
    action: "login",
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
    action: "none",
    checkedAt: "2099-01-01T00:00:05.000Z"
  };
  const readyReadiness = await getJson(baseUrl, "/api/browser-readiness");
  assert.deepStrictEqual(readyReadiness.body, browserReadiness);

  const unconfirmed = seedProfile(db, { confirmCard: false });
  const blockedPage = await getText(baseUrl, `/plan?planId=${unconfirmed.planId}`);
  assert.match(blockedPage.body, /data-today-primary="true"[^>]*href="\/match-card\?profileId=\d+&amp;cardId=\d+"/);
  assert.doesNotMatch(blockedPage.body, /data-browser-readiness-button/);

  const planBefore = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.match(planBefore.body, /今日成功沟通<\/span><strong class="metric-value">0\s*<small>\/\s*70/);
  assert.match(planBefore.body, /下一轮目标 35/);
  assert.match(planBefore.body, /<button[^>]*data-browser-readiness-button[^>]*disabled>/);
  assert.match(planBefore.body, /data-browser-readiness-button/);
  assert.match(planBefore.body, /data-browser-base-disabled="false"/);
  assert.match(planBefore.body, /data-scan-button name="scanKind" value="daily"/);
  assert.doesNotMatch(planBefore.body, /data-scan-button name="scanKind" value="daily" disabled/);
  assert.match(planBefore.body, /name="browserMode" value="edge"/);
  assert.doesNotMatch(planBefore.body, /value="portable"/);
  assert.doesNotMatch(
    planBefore.body,
    /BOSS 暂不支持这些城市：测试未映射城市/,
    "inherited mode must not show generated-search city validation as a blocker"
  );
  assert.doesNotMatch(planBefore.body, /上午|下午/);
  assert.match(planBefore.body, /高级信息与维护/);

  const portableScanSaved = seedProfile(db);
  const portableScanPlan = db.prepare("SELECT plan_json FROM search_plans WHERE id = ?").get(portableScanSaved.planId);
  const portableScanPlanJson = JSON.parse(portableScanPlan.plan_json);
  portableScanPlanJson.cities = ["广州"];
  db.prepare("UPDATE search_plans SET plan_json = ? WHERE id = ?")
    .run(JSON.stringify(portableScanPlanJson), portableScanSaved.planId);
  const scanSpawnCountBeforeInvalidPortable = spawns.length;
  const scanRowsBeforeInvalidPortable = Number(db.prepare("SELECT COUNT(*) AS count FROM scan_runs WHERE plan_id = ?").get(portableScanSaved.planId).count);
  const workflowRowsBeforeInvalidPortable = listWorkflowRuns(db, { planId: portableScanSaved.planId }).length;
  const invalidPortableScan = await postForm(baseUrl, "/api/scan", {
    planId: portableScanSaved.planId,
    browserMode: "portable",
    cdpPort: 9223,
    scanKind: "daily"
  });
  assert.strictEqual(invalidPortableScan.status, 409);
  assert.match(invalidPortableScan.body, /DASHBOARD_BROWSER_AUTHORITY_MISMATCH/);
  assert.strictEqual(spawns.length, scanSpawnCountBeforeInvalidPortable);
  assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM scan_runs WHERE plan_id = ?").get(portableScanSaved.planId).count), scanRowsBeforeInvalidPortable);
  assert.strictEqual(listWorkflowRuns(db, { planId: portableScanSaved.planId }).length, workflowRowsBeforeInvalidPortable);

  batchModelReady = false;
  const resolutionCountBeforeModelGate = inheritedResolutionCount;
  const modelBlockedStart = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
    browserMode: "edge",
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
    const scanRunCountBeforeRejectedStart = Number(db.prepare("SELECT COUNT(*) AS count FROM scan_runs").get().count);
    inheritedFailureCode = code;
    const rejected = await postForm(baseUrl, "/api/workflow-run", {
      planId: saved.planId,
      browserMode: "edge",
      action: "start"
    });
    assert.strictEqual(rejected.status, 409);
    assert.strictEqual(listWorkflowRuns(db, { planId: saved.planId }).length, 0);
    assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM scan_runs").get().count), scanRunCountBeforeRejectedStart);
    assert.strictEqual(spawns.length, 0);
  }
  inheritedFailureCode = "";

  const initialBindingFailure = seedProfile(db);
  const initialBindingTrigger = "workflow_initial_scan_binding_failure";
  db.exec(`
    CREATE TRIGGER ${initialBindingTrigger}
    BEFORE UPDATE OF scan_run_id ON workflow_runs
    WHEN OLD.plan_id = ${Number(initialBindingFailure.planId)}
      AND OLD.scan_batch_id IS NULL
      AND NEW.scan_run_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'WORKFLOW_INITIAL_SCAN_BINDING_FAILED');
    END
  `);
  const spawnCountBeforeInitialBindingFailure = spawns.length;
  let rejectedInitialBinding;
  try {
    rejectedInitialBinding = await postForm(baseUrl, "/api/workflow-run", {
      planId: initialBindingFailure.planId,
      browserMode: "edge",
      action: "start"
    });
    assert.strictEqual(rejectedInitialBinding.status, 400);
    assert.strictEqual(rejectedInitialBinding.location, null);
    assert.match(rejectedInitialBinding.body, /ERR_SQLITE_ERROR/);
    assert.match(rejectedInitialBinding.body, /WORKFLOW_INITIAL_SCAN_BINDING_FAILED/);
    assert.match(rejectedInitialBinding.body, /workflow-dashboard-smoke/);
    assert.strictEqual(spawns.length, spawnCountBeforeInitialBindingFailure);
    const rejectedWorkflow = listWorkflowRuns(db, { planId: initialBindingFailure.planId })[0];
    const rejectedScan = getLatestScanRun(db, { planId: initialBindingFailure.planId, site: "boss" });
    assert(rejectedWorkflow);
    assert(rejectedScan);
    assert.strictEqual(rejectedScan.status, "failed");
    assert.strictEqual(rejectedScan.stopCode, "ERR_SQLITE_ERROR");
    assert.match(rejectedScan.stopMessage, /WORKFLOW_INITIAL_SCAN_BINDING_FAILED/);
    assert.strictEqual(rejectedWorkflow.status, "interrupted");
    assert.strictEqual(rejectedWorkflow.errorCode, "ERR_SQLITE_ERROR");
    assert.match(rejectedWorkflow.errorMessage, /WORKFLOW_INITIAL_SCAN_BINDING_FAILED/);
  } finally {
    db.exec(`DROP TRIGGER IF EXISTS ${initialBindingTrigger}`);
  }

  const started = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
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
  assert.deepStrictEqual(inheritedResolutionInput, { browserMode: "edge", cdpPort: null });
  assert.strictEqual(workflow.planner.browserMode, "edge");
  assert.strictEqual(workflow.planner.cdpPort, null);
  assert.strictEqual(workflow.planner.searchScope.key, `boss:${saved.profileId}:fixture-scope`);
  assert.strictEqual(workflow.planner.platformPolicy.hash, "fixture-policy");
  assert.deepStrictEqual(
    workflow.keywords.map((item) => item.word),
    ["AI应用开发工程师", "大模型应用开发工程师", "Agent开发工程师"]
  );
  assert.strictEqual(spawns.length, 1);
  assert.strictEqual(spawns[0].file, process.execPath);
  assert.deepStrictEqual(
    spawns[0].args.slice(0, 3),
    ["--disable-warning=ExperimentalWarning", "src/cli.js", "scan"]
  );
  assert.deepStrictEqual(spawns[0].options, {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert(spawns[0].args.includes("--workflow-run"));
  assert(spawns[0].args.includes(workflow.id));
  assert.deepStrictEqual(
    spawns[0].args.slice(spawns[0].args.indexOf("--browser"), spawns[0].args.indexOf("--browser") + 2),
    ["--browser", "edge"]
  );
  assert(!spawns[0].args.includes("--cdp-port"));

  const scanningPage = await getText(baseUrl, started.location);
  assert.match(scanningPage.body, /正在筛选岗位/);
  assert.match(scanningPage.body, /<section class="workflow-run-metrics"><h2>本轮统计<\/h2><dl><div><dt>本轮目标<\/dt><dd>35<\/dd>/);
  assert.doesNotMatch(scanningPage.body, /上午|下午/);
  for (const text of [
    "筛选来源：BOSS 当前页面",
    "地点：全国",
    "薪资：10-20K",
    "范围：fixture-sc",
    "关键词来源：Search Plan",
    "AI应用开发工程师",
    "大模型应用开发工程师",
    "Agent开发工程师",
    "方案候选词：6 个",
    "方案后续修改不会影响本轮",
    "方案指纹"
  ]) {
    assert.match(scanningPage.body, new RegExp(text));
  }
  assert.doesNotMatch(scanningPage.body, /本轮实际关键词：[^<]*RAG工程师/);
  assert.doesNotMatch(scanningPage.body, /广州 AI.*目标城市/);
  assert.doesNotMatch(scanningPage.body, /https:\/\/www\.zhipin\.com\/web\/geek\/jobs\?/);

  const unresolvedPlanner = {
    ...workflow.planner,
    platformPolicy: {
      ...workflow.planner.platformPolicy,
      filters: { location: { mode: "specific", cities: ["Guangzhou"], districts: ["Tianhe"] } },
      unresolvedParams: [{ param: "industry", codes: ["100020"] }, { param: "multiBusinessDistrict", codes: ["510108"] }]
    },
    browserState: {
      cookie: "raw-authenticated-browser-state"
    }
  };
  db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
    .run(JSON.stringify(unresolvedPlanner), workflow.id);
  const unresolvedPage = await getText(baseUrl, started.location);
  assert.match(unresolvedPage.body, /未解析平台筛选：industry/);
  const unresolvedPrimary = unresolvedPage.body.slice(
    unresolvedPage.body.indexOf('class="workflow-primary"'),
    unresolvedPage.body.indexOf('class="workflow-technical"')
  );
  const unresolvedTechnical = unresolvedPage.body.slice(unresolvedPage.body.indexOf('class="workflow-technical"'));
  assert.doesNotMatch(unresolvedPrimary, /industry|multiBusinessDistrict/);
  assert.match(unresolvedTechnical, /multiBusinessDistrict/);
  assert.match(unresolvedTechnical, /地点：广州、天河/);
  assert.doesNotMatch(unresolvedPage.body, /100020/);
  assert.doesNotMatch(unresolvedPage.body, /raw-authenticated-browser-state/);
  db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
    .run(JSON.stringify(workflow.planner), workflow.id);

  spawns[0].child.emit("error", new Error("spawn failed"));
  const interruptedWorkflow = getWorkflowRun(db, workflow.id);
  assert.strictEqual(interruptedWorkflow.status, "interrupted");
  assert.strictEqual(interruptedWorkflow.sequence, 1);
  assert.strictEqual(interruptedWorkflow.errorCode, "SCAN_PROCESS_ERROR");

  const portableSaved = seedProfile(db);
  const workflowRowsBeforePortableDrift = listWorkflowRuns(db, { planId: portableSaved.planId }).length;
  const scanRowsBeforePortableDrift = Number(db.prepare("SELECT COUNT(*) AS count FROM scan_runs WHERE plan_id = ?").get(portableSaved.planId).count);
  const spawnCountBeforePortableDrift = spawns.length;
  const rejectedPortableStart = await postForm(baseUrl, "/api/workflow-run", {
    planId: portableSaved.planId,
    browserMode: "portable",
    cdpPort: 9222,
    action: "start"
  });
  assert.strictEqual(rejectedPortableStart.status, 409);
  assert.match(rejectedPortableStart.body, /DASHBOARD_BROWSER_AUTHORITY_MISMATCH/);
  assert.strictEqual(listWorkflowRuns(db, { planId: portableSaved.planId }).length, workflowRowsBeforePortableDrift);
  assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM scan_runs WHERE plan_id = ?").get(portableSaved.planId).count), scanRowsBeforePortableDrift);
  assert.strictEqual(spawns.length, spawnCountBeforePortableDrift);
  const portableStarted = await postForm(baseUrl, "/api/workflow-run", {
    planId: portableSaved.planId,
    browserMode: "edge",
    action: "start"
  });
  assert.strictEqual(portableStarted.status, 303);
  let portableWorkflow = listWorkflowRuns(db, { planId: portableSaved.planId })[0];
  db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?").run(JSON.stringify({
    ...portableWorkflow.planner,
    browserMode: "portable",
    cdpPort: 9222
  }), portableWorkflow.id);
  portableWorkflow = getWorkflowRun(db, portableWorkflow.id);
  assert.strictEqual(portableWorkflow.planner.browserMode, "portable");
  assert.strictEqual(portableWorkflow.planner.cdpPort, 9222);
  const portableSpawn = spawns.at(-1);
  portableSpawn.child.emit("error", new Error("portable workflow fixture"));
  const portableInterruptedPage = await getText(baseUrl, portableStarted.location);
  assert.match(portableInterruptedPage.body, /<input type="hidden" name="cdpPort" value="9222">/);
  assert.match(portableInterruptedPage.body, /<input type="hidden" name="browserMode" value="portable">/);

  const inheritedInterruptedPage = await getText(baseUrl, started.location);
  assert.match(inheritedInterruptedPage.body, /<input type="hidden" name="browserMode" value="edge">/);
  assert.match(inheritedInterruptedPage.body, /使用当前 Edge（高级，需要浏览器连接组件）/);
  assert.doesNotMatch(inheritedInterruptedPage.body, /<input type="hidden" name="cdpPort" value="9222">/);
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
      browserMode: "edge"
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
    assert.deepStrictEqual(resumeBrowserProbeInputs.at(-1), { browserMode: "edge", cdpPort: null });
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
    browserMode: "edge"
  });
  assert.strictEqual(rejectedNoScanResume.status, 409);
  assert.deepStrictEqual(
    db.prepare("SELECT status, updated_at FROM workflow_runs WHERE id = ?").get(noScanInherited.id),
    noScanRowBefore,
    "read-only browser preflight must happen before a no-scan workflow changes state"
  );
  db.prepare("DELETE FROM workflow_runs WHERE id = ?").run(noScanInherited.id);

  resumeBrowserReadinessStatus = "ready";
  const spawnCountBeforeEdgeResume = spawns.length;
  const edgeResume = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: workflow.id,
    browserMode: "edge"
  });
  assert.strictEqual(edgeResume.status, 303);
  assert.strictEqual(edgeResume.location, `/workflow?runId=${workflow.id}`);
  assert.strictEqual(spawns.length, spawnCountBeforeEdgeResume + 1);
  spawns.at(-1).child.emit("error", new Error("edge resume fixture"));

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
      browserMode: "edge"
    });
    assert.strictEqual(malformedResume.status, 409);
    assert.match(malformedResume.body, /WORKFLOW_ACQUISITION_MODE_INVALID/);
    assert.strictEqual(spawns.length, spawnCountBeforeMalformedResume);
    assert.strictEqual(inheritedResolutionCount, resolutionCountBeforeMalformedResume);
  }
  db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
    .run(JSON.stringify(frozenPlanner), workflow.id);

  db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
    .run(JSON.stringify({ ...frozenPlanner, planHash: "tampered" }), workflow.id);
  const invalidPlanHashResume = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: workflow.id,
    browserMode: "edge"
  });
  assert.strictEqual(invalidPlanHashResume.status, 409);
  assert.match(invalidPlanHashResume.body, /WORKFLOW_PLAN_SNAPSHOT_INVALID/);
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
      browserMode: "edge"
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
      browserMode: "edge"
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

  const bindingFailureBatchId = createBatch(db, "boss", "binding-failure", "resume binding failure", {
    profileId: saved.profileId,
    searchPlanId: saved.planId,
    status: "interrupted",
    filterSnapshot: { execution: validInheritedResumeSnapshot }
  });
  attachInterruptedScanBatch(bindingFailureBatchId, "binding-failure");
  const bindingFailureScanId = getWorkflowRun(db, workflow.id).scanRunId;
  db.prepare("UPDATE scan_runs SET plan_id = NULL WHERE id = ?").run(bindingFailureScanId);
  const spawnCountBeforeBindingFailure = spawns.length;
  const bindingFailureResume = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: workflow.id,
    browserMode: "edge"
  });
  assert.strictEqual(bindingFailureResume.status, 400);
  assert.match(bindingFailureResume.body, /WORKFLOW_SCAN_LINK_MISMATCH/);
  assert.strictEqual(spawns.length, spawnCountBeforeBindingFailure);
  assert.strictEqual(getLatestScanRun(db, { planId: saved.planId, site: "boss" }).status, "failed");
  assert.strictEqual(getWorkflowRun(db, workflow.id).status, "interrupted");

  const validInheritedResumeBatchId = createBatch(db, "boss", "valid-resume", "valid attached resume", {
    profileId: saved.profileId,
    searchPlanId: saved.planId,
    status: "interrupted",
    filterSnapshot: { execution: validInheritedResumeSnapshot }
  });
  attachInterruptedScanBatch(validInheritedResumeBatchId, "valid");
  const resumed = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: workflow.id,
    browserMode: "edge"
  });
  assert.strictEqual(resumed.status, 303);
  assert.strictEqual(resumed.location, `/workflow?runId=${workflow.id}`);
  assert.strictEqual(spawns.length, 4);
  assert.strictEqual(getWorkflowRun(db, workflow.id).status, "scanning");
  const resumedScan = getLatestScanRun(db, { planId: saved.planId, site: "boss" });
  assert.strictEqual(getWorkflowRun(db, workflow.id).scanRunId, resumedScan.id);
  assert.strictEqual(
    spawns.at(-1).args[spawns.at(-1).args.indexOf("--resume-batch") + 1],
    String(validInheritedResumeBatchId)
  );
  assert(!spawns.at(-1).args.includes("--analysis-only"));
  const liveResumedStatus = await getJson(
    baseUrl,
    `/api/workflow-status?runId=${encodeURIComponent(workflow.id)}`
  );
  assert.strictEqual(liveResumedStatus.status, 200);
  assert.strictEqual(liveResumedStatus.body.workflow.status, "scanning");
  assert.deepStrictEqual(
    spawns.at(-1).args.slice(spawns.at(-1).args.indexOf("--browser"), spawns.at(-1).args.indexOf("--browser") + 2),
    ["--browser", "edge"]
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
  assert.match(legacyPage.body, /使用当前 Edge（高级，需要浏览器连接组件）/);
  resumeBrowserReadinessStatus = "login_required";
  const spawnCountBeforeLegacyPreflight = spawns.length;
  const rejectedLegacyResume = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: legacyInherited.id,
    browserMode: "edge"
  });
  assert.strictEqual(rejectedLegacyResume.status, 409);
  assert.match(rejectedLegacyResume.body, /BOSS_LOGIN_REQUIRED/);
  assert.strictEqual(spawns.length, spawnCountBeforeLegacyPreflight);
  assert.deepStrictEqual(resumeBrowserProbeInputs.at(-1), { browserMode: "edge", cdpPort: null });
  resumeBrowserReadinessStatus = "ready";
  transitionWorkflowRun(db, { id: legacyInherited.id, status: "stopped" });

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
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
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
    assert.match(failedReadinessPlan.body, /data-today-primary="true"[^>]*href="\/match-card\?profileId=\d+&amp;cardId=\d+"/);
    assert.doesNotMatch(failedReadinessPlan.body, /data-browser-readiness-button/);
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

  const historicalStoppedJobId = listWorkflowReviewCandidates(db, workflow.id)[0].id;
  const historicalStoppedBatch = createCommunicationBatch(db, {
    planId: saved.planId,
    jobIds: [historicalStoppedJobId],
    browserMode: "edge"
  });
  const historicalStoppedItem = listCommunicationBatchItems(db, historicalStoppedBatch.id)[0];
  transitionCommunicationItem(db, { itemId: historicalStoppedItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: historicalStoppedItem.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(db, {
    itemId: historicalStoppedItem.id,
    expectedStatus: "verified",
    status: "click_dispatched",
    audit: {
      eventType: "communication_click",
      payload: {
        batchId: historicalStoppedItem.batchId,
        itemId: historicalStoppedItem.id,
        jobId: historicalStoppedItem.jobId,
        state: "click_dispatched"
      }
    }
  });
  transitionCommunicationItem(db, { itemId: historicalStoppedItem.id, expectedStatus: "click_dispatched", status: "stopped" });
  setCommunicationBatchStatus(db, { batchId: historicalStoppedBatch.id, status: "stopped" });

  const workflowBeforeRefillProbe = getWorkflowRun(db, workflow.id);
  db.prepare("UPDATE workflow_runs SET target_success_count = 1, planner_json = ? WHERE id = ?").run(
    JSON.stringify({ ...workflowBeforeRefillProbe.planner, replacementBuffer: 0 }),
    workflow.id
  );
  const refillPage = await getText(baseUrl, started.location);
  assert.doesNotMatch(refillPage.body, new RegExp(`name="jobIds" value="${historicalStoppedJobId}"`));
  assert.strictEqual((refillPage.body.match(/<input[^>]*name="jobIds"[^>]*checked/g) || []).length, 1);
  assert.doesNotMatch(refillPage.body, /id="workflow-confirm" disabled/);
  assert.match(refillPage.body, /<dt>可用推荐<\/dt><dd[^>]*>1<\/dd>/);
  db.prepare("UPDATE workflow_runs SET target_success_count = ?, planner_json = ? WHERE id = ?").run(
    workflowBeforeRefillProbe.targetSuccessCount,
    JSON.stringify(workflowBeforeRefillProbe.planner),
    workflow.id
  );

  const reviewPage = await getText(baseUrl, started.location);
  assert.match(reviewPage.body, /确认本轮沟通清单/);
  assert.match(reviewPage.body, new RegExp(`name="workflowRunId" value="${workflow.id}"`));
  assert.match(reviewPage.body, /name="browserMode" value="edge"/);
  assert.doesNotMatch(reviewPage.body, new RegExp(`name="jobIds" value="${historicalStoppedJobId}"`));
  assert.strictEqual((reviewPage.body.match(/<input[^>]*name="jobIds"[^>]*checked/g) || []).length, 5);
  assert.match(reviewPage.body, /本轮成功目标\s*35/);
  assert.match(reviewPage.body, /<dt>可用推荐<\/dt><dd[^>]*>5<\/dd>/);
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

  const selectedIds = [...reviewPage.body.matchAll(/name="jobIds" value="(\d+)" checked/g)]
    .map((match) => Number(match[1]));
  const staleWorkflowForm = await postForm(baseUrl, "/api/communication-batch", {
    workflowRunId: workflow.id,
    planId: saved.planId,
    browserMode: "edge",
    jobIds: historicalStoppedJobId
  });
  assert.strictEqual(staleWorkflowForm.status, 400);
  assert.match(staleWorkflowForm.body, new RegExp(`href="/workflow\\?runId=${workflow.id}"`));
  assert.doesNotMatch(staleWorkflowForm.body, new RegExp(`href="/communication/new\\?planId=${saved.planId}"`));
  const confirmed = await postForm(baseUrl, "/api/communication-batch", {
    workflowRunId: workflow.id,
    planId: saved.planId,
    browserMode: "edge",
    jobIds: selectedIds
  });
  assert.strictEqual(confirmed.status, 303);
  assert.strictEqual(confirmed.location, `/workflow?runId=${workflow.id}`);

  const confirmedPage = await getText(baseUrl, confirmed.location);
  assert.match(confirmedPage.body, /清单已确认/);
  assert.match(confirmedPage.body, /name="action" value="start"/);
  const communicationBatchId = getWorkflowRun(db, workflow.id).communicationBatchId;
  const ambiguousCommunicationItem = db.prepare(`
    SELECT id, batch_id, job_id FROM communication_batch_items WHERE batch_id = ? ORDER BY position LIMIT 1
  `).get(communicationBatchId);
  setCommunicationBatchStatus(db, { batchId: communicationBatchId, status: "running" });
  transitionCommunicationItem(db, { itemId: ambiguousCommunicationItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: ambiguousCommunicationItem.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(db, {
    itemId: ambiguousCommunicationItem.id,
    expectedStatus: "verified",
    status: "click_dispatched",
    audit: {
      eventType: "communication_click",
      payload: {
        batchId: communicationBatchId,
        itemId: ambiguousCommunicationItem.id,
        jobId: ambiguousCommunicationItem.job_id,
        state: "click_dispatched"
      }
    }
  });
  transitionCommunicationItem(db, { itemId: ambiguousCommunicationItem.id, expectedStatus: "click_dispatched", status: "ambiguous" });
  transitionWorkflowRun(db, { id: workflow.id, status: "communicating" });
  setCommunicationBatchStatus(db, {
    batchId: communicationBatchId,
    status: "interrupted",
    stopCode: "COMMUNICATION_RESULT_AMBIGUOUS",
    stopMessage: "manual review required"
  });
  transitionWorkflowRun(db, {
    id: workflow.id,
    status: "interrupted",
    errorCode: "COMMUNICATION_RESULT_AMBIGUOUS",
    errorMessage: "manual review required"
  });
  const ambiguityWorkflowPage = await getText(baseUrl, confirmed.location);
  assert.doesNotMatch(ambiguityWorkflowPage.body, /name="action" value="resume"/);
  assert.doesNotMatch(ambiguityWorkflowPage.body, /action="\/api\/communication-control"/);
  assert.match(ambiguityWorkflowPage.body, /处理不明确结果/);
  assert.match(ambiguityWorkflowPage.body, new RegExp(`/communication\\?batchId=${communicationBatchId}#communication-item-${ambiguousCommunicationItem.id}`));
  assert.match(confirmedPage.body, /开始沟通/);

  transitionWorkflowRun(db, { id: workflow.id, status: "communicating" });
  transitionWorkflowRun(db, { id: workflow.id, status: "completed", successfulCount: 30, shortfallCode: "WORKFLOW_SUPPLY_EXHAUSTED" });
  for (const action of ["list_navigation", "list_navigation", "pane_detail_read", "pane_detail_read", "pane_detail_read", "job_detail_fetch", "detail_open"]) {
    recordSiteAccessEvent(db, { site: "boss", action, runId: resumedScan.id });
  }
  const completedPage = await getText(baseUrl, confirmed.location);
  assert.match(completedPage.body, /本轮已完成/);
  assert.match(completedPage.body, /今日进度<\/dt><dd>30\s*\/\s*70/);
  assert.match(completedPage.body, /本轮成功<\/dt><dd>30<\/dd>/);

  const planAfter = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.match(planAfter.body, /今日成功沟通<\/span><strong class="metric-value">30\s*<small>\/\s*70/);
  assert.match(planAfter.body, /下一轮目标 40/);
  assert.match(planAfter.body, /详情读取预算剩余 355，搜索页面预算剩余 58/);
  assert.strictEqual((planAfter.body.match(/name="action" value="start"/g) || []).length, 0);
  assert.match(planAfter.body, /两轮扫描至少间隔 2 小时/);

  const rejectedWhileScanExists = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
    browserMode: "edge",
    action: "start"
  });
  assert.strictEqual(rejectedWhileScanExists.status, 409);
  assert.strictEqual(listWorkflowRuns(db, { planId: saved.planId }).length, 2);

  const {
    planSnapshotVersion: _legacyPlanSnapshotVersion,
    planSnapshot: _legacyPlanSnapshot,
    planHash: _legacyPlanHash,
    ...legacyFrozenPlanner
  } = frozenPlanner;
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
      planner: { ...legacyFrozenPlanner, browserMode: "portable", cdpPort }
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
    assert.match(wrongPortResume.body, /DASHBOARD_BROWSER_AUTHORITY_MISMATCH/);
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
  const historicalGeneratedSnapshot = buildScanExecutionSnapshot({
    site: "boss",
    scanKind: "daily",
    detailMode: "trusted_pane",
    runtimePolicyHash: "historical-generated-policy",
    searchTemplate: { mode: "generated", url: "", cityCode: "" },
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    keywordPlan: [{ word: "AI应用开发工程师", priority: "A" }],
    nativeFilters: { site: "boss", params: {}, labels: {}, lanes: [{ id: "default", rank: 0, params: {}, labels: {} }] },
    limits: { maxCards: 20, maxDetailTotal: 20, browserPageBudget: 5 }
  });
  const historicalGeneratedBatchId = createBatch(db, "boss", "AI应用开发工程师", "historical generated resume", {
    profileId: saved.profileId,
    searchPlanId: saved.planId,
    status: "interrupted",
    filterSnapshot: { execution: historicalGeneratedSnapshot }
  });
  const historicalGeneratedScan = createScanRun(db, {
    runId: "workflow-generated-portable-scan",
    site: "boss",
    command: "daily",
    planId: saved.planId,
    batchId: historicalGeneratedBatchId
  });
  beginScanRun(db, { runId: historicalGeneratedScan.id, batchId: historicalGeneratedBatchId, processId: process.pid });
  attachWorkflowScan(db, {
    id: generatedWorkflow.id,
    scanRunId: historicalGeneratedScan.id,
    scanBatchId: historicalGeneratedBatchId
  });
  finishScanRun(db, { runId: historicalGeneratedScan.id, status: "interrupted" });
  const generatedInterruptedPage = await getText(baseUrl, `/workflow?runId=${generatedWorkflow.id}`);
  assert.match(generatedInterruptedPage.body, /<select name="browserMode">/);
  assert.match(generatedInterruptedPage.body, /<option value="edge">使用当前 Edge（高级，需要浏览器连接组件）<\/option>/);
  assert.match(generatedInterruptedPage.body, /<option value="portable" selected>RoleFlow 专用 Edge（推荐）<\/option>/);
  assert.doesNotMatch(generatedInterruptedPage.body, /<input type="hidden" name="browserMode" value="edge">/);

  const generatedBeforeInvalidMode = getWorkflowRun(db, generatedWorkflow.id);
  const spawnCountBeforeInvalidGeneratedMode = spawns.length;
  const invalidGeneratedMode = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: generatedWorkflow.id,
    browserMode: "chromium",
    cdpPort: 9333
  });
  assert.strictEqual(invalidGeneratedMode.status, 409);
  assert.match(invalidGeneratedMode.body, /DASHBOARD_BROWSER_AUTHORITY_MISMATCH/);
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
  assert.match(modelBlockedResume.body, /DASHBOARD_BROWSER_AUTHORITY_MISMATCH/);
  assert.strictEqual(resumeBrowserProbeInputs.length, browserProbeCountBeforeModelBlockedResume);
  assert.strictEqual(spawns.length, spawnCountBeforeInvalidGeneratedMode);
  assert.strictEqual(getWorkflowRun(db, generatedWorkflow.id).status, "interrupted");
  batchModelReady = true;

  const rejectedGeneratedPortablePort = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: generatedWorkflow.id,
    browserMode: "portable",
    cdpPort: 9333
  });
  assert.strictEqual(rejectedGeneratedPortablePort.status, 409);
  assert.match(rejectedGeneratedPortablePort.body, /DASHBOARD_BROWSER_AUTHORITY_MISMATCH/);
  assert.strictEqual(spawns.length, spawnCountBeforeInvalidGeneratedMode);
  assert.strictEqual(getWorkflowRun(db, generatedWorkflow.id).status, "interrupted");

  const generatedPortableResume = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: generatedWorkflow.id,
    browserMode: "portable",
    cdpPort: 9222
  });
  assert.strictEqual(generatedPortableResume.status, 409);
  assert.match(generatedPortableResume.body, /DASHBOARD_BROWSER_AUTHORITY_MISMATCH/);
  assert.strictEqual(spawns.length, spawnCountBeforeInvalidGeneratedMode);
  assert.strictEqual(getWorkflowRun(db, generatedWorkflow.id).status, "interrupted");

  for (const spawned of spawns) spawned.child.emit("close", 0, null);
  testWorkflowStatusReadBudget();
  const progressPanelFixture = await testWorkflowStatusApi(baseUrl, db, saved);
  await testWorkflowProgressPanel(baseUrl, db, progressPanelFixture);
  await testPerJobWorkflowProgressPanel(baseUrl, db, saved);
  await testWorkflowControlApi(
    baseUrl,
    db,
    saved,
    spawns,
    resumeBrowserProbeInputs,
    workflowControlTimers,
    (value) => { batchModelReady = value; }
  );
  const spawnCountBeforeControlledApiScan = spawns.length;
  const controlledApiScan = await postForm(baseUrl, "/api/scan", {
    planId: portableScanSaved.planId,
    browserMode: "edge",
    scanKind: "broad",
    detailMode: "search_page_api"
  });
  assert.strictEqual(controlledApiScan.status, 409);
  assert.match(controlledApiScan.body, /PRODUCT_DETAIL_MODE_UNSUPPORTED/);
  assert.match(controlledApiScan.body, /trusted_pane/);
  assert.strictEqual(spawns.length, spawnCountBeforeControlledApiScan, "HTTP 拒绝后不得启动子进程");

  await testModelTaskRouting({
    baseUrl,
    modelAccesses,
    setBatchReady(value) { batchModelReady = value; }
  });
  await testPortableDashboardBinding({ database: db, acquisitionContextResolver });

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

async function testDashboardFixedTabReadinessAndInheritedContext({ db: database, logger, saved }) {
  assert.strictEqual(typeof inspectDashboardBossBrowserReadiness, "function");
  const tabs = [
    { id: 31, windowId: 7, url: "https://www.zhipin.com/web/geek/jobs" },
    { id: 32, windowId: 7, url: "https://www.zhipin.com/web/geek/chat" },
    { id: 33, windowId: 7, url: "https://example.invalid/notes" }
  ];
  const originalPreflight = boss.BossSiteAdapter.prototype.preflight;
  const originalInspect = boss.BossSiteAdapter.prototype.inspectInheritedSearchPage;
  try {
    const edgePreflightCalls = [];
    boss.BossSiteAdapter.prototype.preflight = async function preflight(options) {
      edgePreflightCalls.push(options);
      return options?.tabId === 31
        ? { tabId: 31, url: "https://www.zhipin.com/web/geek/jobs", isSearchPage: true }
        : { tabId: 32, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false };
    };
    const readiness = await inspectDashboardBossBrowserReadiness({
      browserMode: "edge",
      cdpPort: null,
      logger,
      browserFactory() {
        return { async listTabs() { return tabs; } };
      }
    });
    assert.strictEqual(readiness.status, "ready");
    assert.deepStrictEqual(edgePreflightCalls, [{ tabId: 32 }, { tabId: 31 }]);

    boss.BossSiteAdapter.prototype.preflight = async function preflight(options) {
      return options?.tabId === 31
        ? { tabId: 31, url: "https://www.zhipin.com/web/geek/jobs", isSearchPage: true }
        : { tabId: 32, url: "https://www.zhipin.com/web/geek/jobs", isSearchPage: true };
    };
    const communicationDriftReadiness = await inspectDashboardBossBrowserReadiness({
      browserMode: "edge",
      cdpPort: null,
      logger,
      browserFactory() {
        return { async listTabs() { return tabs; } };
      }
    });
    assert.strictEqual(communicationDriftReadiness.status, "communication_page_required");
    assert.strictEqual(communicationDriftReadiness.ready, false);

    const portablePreflightCalls = [];
    const portableTabs = [
      { id: "CDP-dashboard-search", windowId: 51, url: "https://www.zhipin.com/web/geek/jobs" },
      { id: "CDP-dashboard-chat", windowId: 51, url: "https://www.zhipin.com/web/geek/chat" }
    ];
    let portableListCalls = 0;
    boss.BossSiteAdapter.prototype.preflight = async function preflight(options) {
      portablePreflightCalls.push(options);
      return options?.tabId === "CDP-dashboard-search"
        ? { tabId: options.tabId, url: portableTabs[0].url, isSearchPage: true }
        : { tabId: options?.tabId, url: portableTabs[1].url, isSearchPage: false };
    };
    const portableReadiness = await inspectDashboardBossBrowserReadiness({
      browserMode: "portable",
      cdpPort: 9222,
      logger,
      browserFactory() {
        return { async listTabs() { portableListCalls += 1; return portableTabs; } };
      }
    });
    assert.strictEqual(portableReadiness.status, "ready");
    assert.strictEqual(portableListCalls, 2);
    assert.deepStrictEqual(portablePreflightCalls, [
      { tabId: "CDP-dashboard-chat" },
      { tabId: "CDP-dashboard-search" }
    ]);

    const inheritedPreflightCalls = [];
    boss.BossSiteAdapter.prototype.preflight = async function preflight(options) {
      inheritedPreflightCalls.push(options);
      return options?.tabId === 31
        ? { tabId: 31, url: "https://www.zhipin.com/web/geek/jobs", isSearchPage: true }
        : { tabId: 32, url: "https://www.zhipin.com/web/geek/chat", isSearchPage: false };
    };
    boss.BossSiteAdapter.prototype.inspectInheritedSearchPage = async function inspectInheritedSearchPage() {
      const error = new Error("fixture risk control");
      error.code = "BOSS_RISK_CONTROL";
      throw error;
    };
    await assert.rejects(
      () => resolveLiveInheritedContext({
        db: database,
        plan: { profileId: saved.profileId },
        matchingContext: {},
        logger,
        browserMode: "edge",
        cdpPort: null,
        browserFactory() {
          return { async listTabs() { return tabs; } };
        }
      }),
      (error) => error?.code === "BOSS_RISK_CONTROL"
    );
    assert.deepStrictEqual(inheritedPreflightCalls, [{ tabId: 32 }, { tabId: 31 }]);
    assert.deepStrictEqual(getSiteRuntimeState(database, "boss"), {
      site: "boss",
      status: "blocked",
      reasonCode: "BOSS_RISK_CONTROL",
      message: "fixture risk control",
      details: { phase: "inherited_context" },
      updatedAt: getSiteRuntimeState(database, "boss").updatedAt
    });
    clearSiteRuntimeState(database, "boss");

    boss.BossSiteAdapter.prototype.preflight = async function preflight() {
      const error = new Error("fixture disconnected");
      error.code = "BROWSER_DISCONNECTED";
      throw error;
    };
    await assert.rejects(
      () => resolveLiveInheritedContext({
        db: database,
        plan: { profileId: saved.profileId },
        matchingContext: {},
        logger,
        browserMode: "edge",
        cdpPort: null,
        browserFactory() {
          return { async listTabs() { return tabs; } };
        }
      }),
      (error) => error?.code === "BROWSER_UNAVAILABLE" && /Edge Control|桥接/.test(error.message)
    );
  } finally {
    boss.BossSiteAdapter.prototype.preflight = originalPreflight;
    boss.BossSiteAdapter.prototype.inspectInheritedSearchPage = originalInspect;
  }
}

async function testModelTaskRouting({ baseUrl, modelAccesses, setBatchReady }) {
  const assertRoute = async ({ pathname, method = "POST", taskProfile, runtime, singleRuntimeState = false }) => {
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
    if (singleRuntimeState) {
      assert.strictEqual(modelAccesses.filter((entry) => entry.kind === "runtime").length, 1,
        `${pathname} must resolve one reusable runtime model state`);
      assert.strictEqual(modelAccesses.filter((entry) => entry.kind === "public").length, 0,
        `${pathname} must not decrypt the same credential again through public settings`);
    }
  };

  await assertRoute({ pathname: "/onboarding", method: "GET", taskProfile: "deep_analysis", runtime: false });
  await assertRoute({ pathname: "/api/communication", taskProfile: "deep_analysis", runtime: true });
  await assertRoute({ pathname: "/api/resume", taskProfile: "deep_analysis", runtime: true });
  await assertRoute({ pathname: "/api/resume-version", taskProfile: "deep_analysis", runtime: true });
  await assertRoute({ pathname: "/api/plan/recommend", taskProfile: "deep_analysis", runtime: true });
  await assertRoute({ pathname: "/api/analyze-job", taskProfile: "batch_screening", runtime: true });
  await assertRoute({ pathname: "/api/analyze-jobs", taskProfile: "batch_screening", runtime: true });
  await assertRoute({ pathname: "/api/workflow-run", taskProfile: "batch_screening", runtime: true, singleRuntimeState: true });
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
  database.prepare("UPDATE workflow_runs SET successful_count = 2 WHERE id = ?").run(fixture.workflowId);
  const before = getWorkflowRun(database, fixture.workflowId);
  const response = await getJson(baseUrl, `/api/workflow-status?runId=${encodeURIComponent(fixture.workflowId)}`);
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(Object.keys(response.body).sort(), [
    "communication",
    "controls",
    "progress",
    "recentActivity",
    "workflow"
  ]);
  assert.strictEqual(response.body.workflow.id, fixture.workflowId);
  assert.strictEqual(response.body.workflow.status, "analyzing");
  assert.strictEqual(response.body.workflow.successfulCount, 2);
  assert.strictEqual(response.body.progress.analysis.total, 2);
  assert.strictEqual(response.body.progress.analysis.succeeded, 1);
  assert.strictEqual(response.body.progress.analysis.pending, 1);
  assert.strictEqual(response.body.progress.stageIndex, 3);
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
  const missingCommunication = seedWorkflowApiFixture(database, saved, {
    localDay: "2099-02-09",
    resumePhase: "analyzing"
  });
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.prepare("UPDATE workflow_runs SET communication_batch_id = ? WHERE id = ?")
      .run(999999, missingCommunication.workflowId);
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
  const missingCommunicationResponse = await getJson(
    baseUrl,
    `/api/workflow-status?runId=${encodeURIComponent(missingCommunication.workflowId)}`
  );
  assert.strictEqual(missingCommunicationResponse.status, 404);
  assert.deepStrictEqual(missingCommunicationResponse.body, {
    error: "本轮沟通批次不存在。",
    errorCode: "COMMUNICATION_BATCH_NOT_FOUND"
  });
  return fixture;
}

function testWorkflowStatusReadBudget() {
  const forbiddenTables = new Set([
    "candidate_job_events", "candidate_job_states", "candidate_progress_cards",
    "events", "job_refresh_attempts", "jobs", "search_plans", "site_runtime_states"
  ]);
  for (const [label, options] of [["active", {}], ["communication", { communication: true }]]) {
    const { metrics, result } = measureWorkflowStatusRead(options);
    const legacy = measureLegacyWorkflowStatusRead(options);
    assert.strictEqual(result.statusCode, 200, `${label} read must return the current workflow`);
    assert(
      legacy.metrics.statements > workflowStatusReadBudget.statements || legacy.metrics.rows > workflowStatusReadBudget.rows,
      `${label} legacy read must exceed the lightweight budget`
    );
    assert(metrics.statements <= workflowStatusReadBudget.statements,
      `${label} status read used ${metrics.statements} statements; budget is ${workflowStatusReadBudget.statements}`);
    assert(metrics.rows <= workflowStatusReadBudget.rows,
      `${label} status read returned ${metrics.rows} rows; budget is ${workflowStatusReadBudget.rows}`);
    assert(!metrics.tables.some((table) => forbiddenTables.has(table)),
      `${label} status read touched plan-wide/history tables: ${metrics.tables.join(", ")}`);
    assert(metrics.tables.includes("batches") && metrics.tables.includes("scan_target_results"),
      `${label} status read must derive target progress from the current frozen batch`);
    if (label === "active") {
      assert(!metrics.tables.includes("communication_batch_items"), "non-communication status reads must not load communication items");
    }
  }
  const stale = measureWorkflowStatusRead({ stale: true });
  assert.strictEqual(stale.result.statusCode, 200);
  assert.strictEqual(stale.result.body.workflow.status, "interrupted", "status reads must reconcile stale runs before responding");
  assert.strictEqual(stale.result.body.workflow.progressRevision, 7, "recovery response must retain the progress revision");
  assert(stale.metrics.statements <= workflowStatusStaleReadBudget.statements,
    `stale status read used ${stale.metrics.statements} statements; budget is ${workflowStatusStaleReadBudget.statements}`);
  assert(stale.metrics.rows <= workflowStatusStaleReadBudget.rows,
    `stale status read returned ${stale.metrics.rows} rows; budget is ${workflowStatusStaleReadBudget.rows}`);
  assert(stale.metrics.executed.run >= 1, "stale status read must execute recovery writes");
  assert(!stale.metrics.tables.some((table) => forbiddenTables.has(table)),
    `stale status read touched plan-wide/history tables: ${stale.metrics.tables.join(", ")}`);
}

async function testWorkflowProgressPanel(baseUrl, database, fixture) {
  const page = await getText(
    baseUrl,
    `/workflow?runId=${encodeURIComponent(fixture.workflowId)}`
  );
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /class="[^"]*workflow-focus/);
  assert.match(page.body, /class="[^"]*workflow-result-list/);
  assert.match(page.body, />运行详情<\/summary>/);
  assert.match(page.body, /data-workflow-panel/);
  // Break caught: moving technical diagnostics into the first view or hiding user-facing acquisition progress again.
  const primaryStart = page.body.indexOf('class="workflow-primary"');
  const primaryEnd = page.body.indexOf("</section>", primaryStart) + "</section>".length;
  const technicalStart = page.body.indexOf('class="workflow-technical"');
  assert(primaryStart >= 0, "workflow must expose a semantic primary summary region");
  assert(primaryEnd > primaryStart, "workflow primary summary must have a section boundary");
  assert(technicalStart > primaryStart, "technical details must follow the primary summary");
  const primary = page.body.slice(primaryStart, primaryEnd);
  assert.match(primary, /role="region"[^>]*aria-labelledby="workflow-primary-title"/);
  assert.strictEqual(
    (primary.match(/data-workflow-primary-field/g) || []).length,
    9,
    "the primary summary must contain the nine user-facing decision and progress fields"
  );
  for (const label of ["当前阶段", "整体进度", "采集进度", "完整 JD", "可用推荐", "剩余工作", "预计继续时间", "暂停/阻塞原因", "下一步"]) {
    assert(primary.includes(label), `primary summary must identify ${label}`);
  }
  for (const hook of ["phase", "progress", "acquisition", "jd", "recommendations", "remaining", "eta", "blocker", "next-action"]) {
    assert.match(primary, new RegExp(`data-overview-${hook}`), `primary summary must expose the ${hook} update hook`);
  }
  assert.doesNotMatch(primary, /data-stop-|data-workflow-control|data-action="stop/, "primary summary must contain fields only, not stop diagnostics or controls");
  assert.doesNotMatch(primary, /任务 #|最近活动|已检查岗位|未解析平台筛选/);
  const technical = page.body.slice(technicalStart);
  assert.match(technical, /^class="workflow-technical"/);
  assert.match(page.body, /<details class="workflow-technical">/);
  assert.doesNotMatch(page.body, /<details class="workflow-technical" open>/);
  assert.match(technical, /data-recent-activity/);
  assert.match(technical, /data-analysis-timeouts/);
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
    "data-scan-wait",
    "data-recent-activity",
    "data-stop-collected",
    "data-stop-slot",
    "data-workflow-error"
  ]) {
    assert.match(page.body, new RegExp(hook), `workflow panel must expose ${hook}`);
  }
  assert.match(page.body, /第 3 阶段\s*\/\s*共 4 阶段/);
  assert.match(page.body, /分析岗位/);
  assert.match(page.body, /data-analysis-succeeded[^>]*>1</);
  assert.match(page.body, /data-analysis-failed[^>]*>0</);
  assert.match(page.body, /data-analysis-remaining[^>]*>1</);
  assert.match(page.body, /当前恢复周期最终超时\s*0\s*\/\s*10/);
  assert.match(page.body, /本轮累计超时\s*0/);
  assert.match(page.body, /正在估算/);
  assert.match(page.body, /data-action="pause"/);
  assert.match(page.body, /name="action" value="pause"/);
  assert.match(page.body, /name="action" value="resume"/);
  assert.doesNotMatch(page.body, /data-action="pause" name="action"/);
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

  assert.match(page.body, /<script src="\/assets\/workflow\.js"><\/script>/);
  assert.doesNotMatch(page.body, /data-workflow-progress-client/);

  const waitingMetrics = {
    ...getWorkflowRun(database, fixture.workflowId).metrics,
    scanWait: {
      runId: fixture.scanRunId,
      action: "detail_open",
      delayMs: 600000,
      retryAt: "2099-02-01T00:10:00.000Z"
    }
  };
  database.prepare("UPDATE workflow_runs SET status = 'scanning', metrics_json = ? WHERE id = ?")
    .run(JSON.stringify(waitingMetrics), fixture.workflowId);
  const cooldownPage = await getText(baseUrl, `/workflow?runId=${encodeURIComponent(fixture.workflowId)}`);
  assert.strictEqual(cooldownPage.status, 200);
  const cooldownPrimary = cooldownPage.body.slice(
    cooldownPage.body.indexOf('class="workflow-primary"'),
    cooldownPage.body.indexOf('class="workflow-technical"')
  );
  assert.match(cooldownPrimary, /data-cooldown[^>]*data-retry-at="2099-02-01T00:10:00\.000Z"/);
  assert.match(cooldownPrimary, /data-cooldown-reason[^>]*>正在读取岗位详情</);
  assert.match(cooldownPrimary, /data-cooldown-retry-time/);
  assert.match(cooldownPrimary, /data-cooldown-countdown[^>]*aria-hidden="true"/);
  await assertWorkflowCooldownClient();
  await assertWorkflowLocalProgressClient();
  await assertWorkflowNonPollingClient();

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

async function testPortableDashboardBinding({ database, acquisitionContextResolver }) {
  const saved = seedProfile(database);
  const portableSpawns = [];
  const readinessInputs = [];
  const workspaceCalls = [];
  let previewResolutionCount = 0;
  let browserRuntime = {
    status: "ready",
    ready: true,
    message: "portable runtime ready",
    action: "none",
    checkedAt: "2099-01-01T00:00:00.000Z"
  };
  const browserSupervisor = {
    getSnapshot() { return { ...browserRuntime }; },
    close() {}
  };
  const trackedPreviewResolver = async (input) => {
    previewResolutionCount += 1;
    return acquisitionContextResolver(input);
  };
  const portableServer = createDashboardServer({
    db: database,
    browserAuthority: {
      browserMode: "portable",
      cdpPort: 9222,
      profilePath: path.join(root, ".runtime", "portable-dashboard-profile")
    },
    root,
    dbPath,
    forceMock: true,
    logger,
    browserSupervisor,
    workspaceReconciler: async (input) => {
      workspaceCalls.push({ ...input });
      return { status: "ready", bossTabId: "portable-search", communicationTabId: "portable-chat" };
    },
    acquisitionContextResolver,
    inheritedPreviewResolver: trackedPreviewResolver,
    browserReadinessProbe: async (authority) => {
      readinessInputs.push(authority);
      return { status: "ready", ready: true, message: "portable fixture ready", checkedAt: "2099-01-01T00:00:00.000Z" };
    },
    workflowResumeBrowserReadinessProbe: async (authority) => {
      readinessInputs.push(authority);
      return { status: "ready", ready: true, message: "portable resume fixture ready", checkedAt: "2099-01-01T00:00:00.000Z" };
    },
    spawnProcess(_file, args) {
      const child = new EventEmitter();
      child.pid = 8800 + portableSpawns.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      portableSpawns.push({ args, child });
      return child;
    }
  });
  const portableBaseUrl = await listen(portableServer);
  try {
    const page = await getText(portableBaseUrl, `/plan?planId=${saved.planId}`);
    assert.match(page.body, /当前浏览器：RoleFlow 专用 Edge（推荐）/);
    assert.match(page.body, /name="browserMode" value="portable"/);
    assert.match(page.body, /name="cdpPort" value="9222"/);
    const readiness = await getJson(portableBaseUrl, "/api/browser-readiness");
    assert.strictEqual(readiness.status, 200);
    assert.deepStrictEqual(readinessInputs, [{ browserMode: "portable", cdpPort: 9222 }]);
    const preview = await getJson(portableBaseUrl, `/api/acquisition-preview?planId=${saved.planId}`);
    assert.strictEqual(preview.status, 200);
    assert.strictEqual(previewResolutionCount, 1);
    browserRuntime = {
      status: "unavailable",
      ready: false,
      message: "portable runtime unavailable",
      action: "recover",
      checkedAt: "2099-01-01T00:00:01.000Z"
    };
    const blockedPreview = await getJson(portableBaseUrl, `/api/acquisition-preview?planId=${saved.planId}`);
    assert.strictEqual(blockedPreview.status, 409);
    assert.strictEqual(blockedPreview.body.errorCode, "BROWSER_RUNTIME_NOT_READY");
    assert.strictEqual(previewResolutionCount, 1, "runtime gate must stop inherited preview before browser resolution");
    browserRuntime = {
      status: "ready",
      ready: true,
      message: "portable runtime ready",
      action: "none",
      checkedAt: "2099-01-01T00:00:02.000Z"
    };
    const started = await postForm(portableBaseUrl, "/api/workflow-run", { planId: saved.planId, action: "start" });
    assert.strictEqual(started.status, 303, started.body);
    assert.deepStrictEqual(workspaceCalls, [{ startupGuidance: false, reason: "workflow_start" }]);
    const workflow = listWorkflowRuns(database, { planId: saved.planId })[0];
    assert.deepStrictEqual(
      { browserMode: workflow.planner.browserMode, cdpPort: workflow.planner.cdpPort },
      { browserMode: "portable", cdpPort: 9222 }
    );
    assert.deepStrictEqual(
      portableSpawns[0].args.slice(portableSpawns[0].args.indexOf("--browser"), portableSpawns[0].args.indexOf("--browser") + 4),
      ["--browser", "portable", "--cdp-port", "9222"]
    );

    portableSpawns[0].child.emit("close", 1, null);
    assert.strictEqual(getWorkflowRun(database, workflow.id).status, "interrupted");
    const resumed = await postForm(portableBaseUrl, "/api/workflow-run/resume", {
      workflowRunId: workflow.id,
      browserMode: "portable",
      cdpPort: 9222
    });
    assert.strictEqual(resumed.status, 303, resumed.body);
    assert.deepStrictEqual(workspaceCalls, [
      { startupGuidance: false, reason: "workflow_start" },
      { startupGuidance: false, reason: "workflow_resume" }
    ]);
    assert.strictEqual(portableSpawns.length, 2);
  } finally {
    for (const spawned of portableSpawns) spawned.child.emit("close", 0, null);
    await new Promise((resolve) => portableServer.close(resolve));
  }
}

async function testPerJobWorkflowProgressPanel(baseUrl, database, saved) {
  const fixture = seedWorkflowApiFixture(database, saved, {
    localDay: "2099-02-11",
    resumePhase: "analyzing"
  });
  const existing = database.prepare(`
    SELECT t.id AS task_id, t.position, o.id AS observation_id
    FROM workflow_job_tasks t
    JOIN job_observations o ON o.id = t.observation_id
    WHERE t.workflow_run_id = ?
    ORDER BY t.position
  `).all(fixture.workflowId);
  for (const row of existing) {
    database.prepare("UPDATE job_observations SET title = ?, company = ? WHERE id = ?").run(
      `Workflow Progress Job ${row.position}`,
      `Workflow Progress Company ${row.position}`,
      row.observation_id
    );
  }
  for (let position = 3; position <= 6; position += 1) {
    const jobId = upsertJob(database, {
      ...job(`workflow-progress-${position}`),
      sourceId: `workflow-progress-${position}`,
      title: `Workflow Progress Job ${position}`,
      company: `Workflow Progress Company ${position}`,
      description: "Complete local workflow progress JD. ".repeat(8)
    }, fixture.batchId);
    const observationId = Number(database.prepare(`
      SELECT id FROM job_observations WHERE batch_id = ? AND job_id = ?
    `).get(fixture.batchId, jobId).id);
    insertWorkflowJobTaskRow(database, {
      workflowRunId: fixture.workflowId,
      batchId: fixture.batchId,
      jobId,
      observationId,
      position,
      status: "pending",
      recoveryGeneration: 0,
      modelConfigRevision: "fixture-batch-revision",
      now: "2099-02-11T00:00:01.000Z"
    });
  }
  const statuses = ["pending", "running", "retry_pending", "succeeded", "skipped", "failed"];
  const tasks = database.prepare(`
    SELECT id FROM workflow_job_tasks WHERE workflow_run_id = ? ORDER BY position
  `).all(fixture.workflowId);
  tasks.forEach((task, index) => database.prepare(`
    UPDATE workflow_job_tasks
    SET status = ?, last_error_code = ?, finished_at = ?
    WHERE id = ?
  `).run(
    statuses[index],
    index === 4 ? "DETAIL_REQUIRED" : null,
    ["succeeded", "skipped", "failed"].includes(statuses[index])
      ? "2099-02-11T00:00:02.000Z"
      : null,
    task.id
  ));
  const retryBatchId = createBatch(database, "boss", "analysis-retry", "resolved workflow failure", {
    profileId: saved.profileId,
    searchPlanId: saved.planId
  });
  upsertJob(database, {
    ...job("workflow-progress-6"),
    sourceId: "workflow-progress-6",
    title: "Workflow Progress Job 6",
    company: "Workflow Progress Company 6",
    description: "Complete local workflow progress JD. ".repeat(8),
    analysis: {
      semanticStatus: "complete",
      decisionStatus: "decided",
      decisionSource: "model",
      recommendation: "apply"
    }
  }, retryBatchId);

  const page = await getText(baseUrl, `/workflow?runId=${encodeURIComponent(fixture.workflowId)}`);
  assert.strictEqual(page.status, 200);
  for (const track of ["scan", "jd", "analysis", "communication"]) {
    assert.match(page.body, new RegExp(`data-progress-track="${track}"`));
    assert.match(page.body, new RegExp(`data-track-meter="${track}"`));
    assert.match(page.body, new RegExp(`data-track-fraction="${track}"`));
  }
  assert.strictEqual((page.body.match(/data-analysis-task-id=/g) || []).length, 6);
  assert.match(page.body, /<progress[^>]+aria-describedby="workflow-track-scan-description"/);
  assert.match(page.body, /aria-live="polite"[^>]*data-current-activity/);
  assert.doesNotMatch(page.body, /data-overall-percentage/);
  for (let position = 1; position <= 6; position += 1) {
    assert(page.body.includes(`Workflow Progress Job ${position}`));
    assert(page.body.includes(`Workflow Progress Company ${position}`));
  }
  assert.match(page.body, /详情待补/);
  for (const label of ["本轮直接完成", "失败后已解决", "当前未解决"]) {
    assert(page.body.includes(label), `workflow progress must show ${label}`);
  }
  assert.match(page.body, /data-analysis-direct-succeeded[^>]*>1</);
  assert.match(page.body, /data-analysis-resolved-after-failure[^>]*>1</);
  assert.match(page.body, /data-analysis-unresolved-failed[^>]*>0</);
  assert.match(page.body, /data-analysis-historical-failed[^>]*>1</);
  assert.match(
    page.body,
    new RegExp(`data-analysis-task-id="${tasks[5].id}"[\\s\\S]*?首次失败，后续已解决[\\s\\S]*?</article>`)
  );
  const response = await getJson(baseUrl, `/api/workflow-status?runId=${encodeURIComponent(fixture.workflowId)}`);
  const serialized = JSON.stringify(response.body);
  assert(!serialized.includes("Workflow Progress Job"));
  assert(!serialized.includes("Workflow Progress Company"));
  assert.match(
    fs.readFileSync(path.join(root, "src", "dashboard", "assets", "roleflow.css"), "utf8"),
    /@media\s*\(prefers-reduced-motion:\s*reduce\)/
  );
}

async function assertWorkflowLocalProgressClient() {
  const script = fs.readFileSync(path.join(root, "src", "dashboard", "assets", "workflow.js"), "utf8");
  let timerId = 0;
  let reloads = 0;
  let fetches = 0;
  let concurrentFetches = 0;
  let maxConcurrentFetches = 0;
  const timeouts = new Map();
  const intervals = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const element = (textContent = "") => ({
    textContent,
    hidden: false,
    disabled: false,
    dataset: {},
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
    hasAttribute(name) { return this.attributes.has(name); },
    getAttribute(name) { return this.attributes.get(name) ?? null; }
  });
  const scanFraction = element("0 / 5");
  const jdFraction = element("0 / 7");
  const analysisFraction = element("0 / 6");
  const communicationFraction = element("0 / 0");
  const scanMeter = element();
  const jdMeter = element();
  const analysisMeter = element();
  const communicationMeter = element();
  const taskStatus = element("分析中");
  const directSucceeded = element("0");
  const resolvedAfterFailure = element("0");
  const unresolvedFailed = element("0");
  const historicalFailed = element("0");
  const taskRow = element();
  taskRow.setAttribute("aria-current", "step");
  taskRow.querySelector = (selector) => selector === "[data-analysis-task-status]" ? taskStatus : null;
  const currentActivity = element("旧动作");
  const errorNode = element("无法读取任务状态");
  errorNode.hidden = true;
  const controls = [element(), element()];
  const panel = element();
  const nodes = new Map([
    ['[data-workflow-panel]', panel],
    ['[data-track-fraction="scan"]', scanFraction],
    ['[data-track-fraction="jd"]', jdFraction],
    ['[data-track-fraction="analysis"]', analysisFraction],
    ['[data-track-fraction="communication"]', communicationFraction],
    ['[data-track-meter="scan"]', scanMeter],
    ['[data-track-meter="jd"]', jdMeter],
    ['[data-track-meter="analysis"]', analysisMeter],
    ['[data-track-meter="communication"]', communicationMeter],
    ['[data-current-activity]', currentActivity],
    ['[data-workflow-error]', errorNode],
    ['[data-analysis-task-id="11"]', taskRow],
    ['[data-analysis-direct-succeeded]', directSucceeded],
    ['[data-analysis-resolved-after-failure]', resolvedAfterFailure],
    ['[data-analysis-unresolved-failed]', unresolvedFailed],
    ['[data-analysis-historical-failed]', historicalFailed]
  ]);
  const page = {
    dataset: {
      pollingKind: "progress",
      workflowRunId: "local-progress-fixture",
      pollingInterval: "2500",
      terminalStates: "review_required,interrupted,completed,failed,stopped",
      workflowStatus: "analyzing",
      workflowControlState: "none",
      workflowPhaseKey: "analysis"
    },
    querySelector(selector) { return nodes.get(selector) || null; },
    querySelectorAll(selector) {
      if (selector === "[data-workflow-control]") return controls;
      return [];
    }
  };
  const snapshot = ({ phaseKey = "analysis", taskStatusValue = "failed", resolved = true } = {}) => ({
    workflow: {
      status: phaseKey === "review" ? "review_required" : "analyzing",
      controlState: "none",
      progressRevision: 2,
      lastActivityAt: new Date().toISOString()
    },
    progress: {
      phaseKey,
      stage: phaseKey === "review" ? "确认清单与执行沟通" : "分析岗位",
      stageIndex: phaseKey === "review" ? 4 : 3,
      stageCount: 4,
      scan: {
        activity: "reading_detail",
        targetKey: "target-2",
        targetLabel: "广州 · RAG",
        targetPosition: 2,
        targetTotal: 5,
        targetDiscovered: 7,
        detailPosition: 4,
        detailTotal: 7
      },
      scanWait: null,
      eta: { status: "estimating" },
      scanTargets: { total: 5, processed: 2, completed: 1, partial: 1, failed: 0, pending: 3 },
      details: { collected: 9, required: 7, read: 4, pending: 3, notRequired: 2, growing: false },
      tracks: {
        scan: { value: 2, max: 5, indeterminate: false },
        jd: { value: 4, max: 7, indeterminate: false, growing: false },
        analysis: { value: 3, max: 6, indeterminate: false },
        communication: { value: 0, max: 0, indeterminate: false }
      },
      remainingWorkLabel: "还有 3 个岗位待分析；0 个岗位待补详情",
      analysis: {
        total: 6, terminal: 3, pending: 2, running: 0, retryPending: 1,
        succeeded: 2, skipped: 0, failed: 1, stopped: 0, detailRequired: 0,
        historicalFailed: 1, resolvedAfterFailure: 1, unresolvedFailed: 0,
        tasks: [{ id: 11, position: 1, status: taskStatusValue, lastErrorCode: null, resolvedAfterFailure: resolved }]
      }
    },
    controls: { canPause: true, canResume: false, canStop: true, stopConsumesRunSlot: true },
    recentActivity: []
  });
  const responses = [
    { ok: true, json: async () => snapshot() },
    { ok: true, json: async () => snapshot() },
    { ok: false, json: async () => ({}) },
    { ok: true, json: async () => snapshot({ phaseKey: "review" }) }
  ];
  const document = {
    hidden: false,
    querySelector(selector) { return selector === "[data-workflow-page]" ? page : null; },
    getElementById() { return null; },
    addEventListener(event, callback) { documentListeners.set(event, callback); }
  };
  const context = vm.createContext({
    document,
    window: { addEventListener(event, callback) { windowListeners.set(event, callback); } },
    Date,
    fetch: async () => {
      fetches += 1;
      concurrentFetches += 1;
      maxConcurrentFetches = Math.max(maxConcurrentFetches, concurrentFetches);
      const response = responses.shift() || { ok: true, json: async () => snapshot({ phaseKey: "review" }) };
      await Promise.resolve();
      concurrentFetches -= 1;
      return response;
    },
    setTimeout(callback, delay) { timerId += 1; timeouts.set(timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(callback, delay) { timerId += 1; intervals.set(timerId, { callback, delay }); return timerId; },
    clearInterval(id) { intervals.delete(id); },
    encodeURIComponent,
    location: { reload() { reloads += 1; } }
  });
  const fireTimeout = async () => {
    const [id, timer] = timeouts.entries().next().value || [];
    assert(timer, "expected one scheduled polling request");
    timeouts.delete(id);
    await timer.callback();
    await flushPromises();
  };

  new vm.Script(script).runInContext(context);
  assert.strictEqual(timeouts.size, 1);
  await fireTimeout();
  assert.strictEqual(scanFraction.textContent, "2 / 5");
  assert.strictEqual(jdFraction.textContent, "4 / 7");
  assert.strictEqual(analysisFraction.textContent, "3 / 6");
  assert.strictEqual(taskStatus.textContent, "首次失败，后续已解决");
  assert.strictEqual(directSucceeded.textContent, "2");
  assert.strictEqual(resolvedAfterFailure.textContent, "1");
  assert.strictEqual(unresolvedFailed.textContent, "0");
  assert.strictEqual(historicalFailed.textContent, "1");
  assert.strictEqual(taskRow.hasAttribute("aria-current"), false);
  assert.strictEqual(reloads, 0);
  assert.strictEqual(fetches, 1);
  assert.strictEqual(timeouts.size, 1);

  document.hidden = true;
  documentListeners.get("visibilitychange")();
  documentListeners.get("visibilitychange")();
  assert.strictEqual(timeouts.size, 0);
  const fetchesWhileHidden = fetches;
  document.hidden = false;
  documentListeners.get("visibilitychange")();
  documentListeners.get("visibilitychange")();
  assert.strictEqual(timeouts.size, 1);
  await fireTimeout();
  assert.strictEqual(fetches - fetchesWhileHidden, 1);
  assert.strictEqual(maxConcurrentFetches, 1);
  assert.strictEqual(timeouts.size, 1);

  await fireTimeout();
  assert.strictEqual(errorNode.hidden, false);
  assert.strictEqual(scanFraction.textContent, "2 / 5");
  assert(controls.every((control) => control.disabled));
  assert.strictEqual(timeouts.size, 1);

  await fireTimeout();
  assert.strictEqual(reloads, 1);
  assert.strictEqual(timeouts.size, 0);
  windowListeners.get("pageshow")();
  assert.strictEqual(reloads, 1);
  assert.strictEqual(timeouts.size, 0);
}

async function assertWorkflowNonPollingClient() {
  const script = fs.readFileSync(path.join(root, "src", "dashboard", "assets", "workflow.js"), "utf8");
  let timerId = 0;
  let fetches = 0;
  let reloads = 0;
  const timeouts = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const page = {
    dataset: {
      pollingKind: "none",
      workflowRunId: "review-fixture",
      pollingInterval: "2500",
      terminalStates: "",
      workflowStatus: "review_required",
      workflowPhaseKey: "review"
    },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const document = {
    hidden: false,
    querySelector(selector) { return selector === "[data-workflow-page]" ? page : null; },
    getElementById() { return null; },
    addEventListener(event, callback) { documentListeners.set(event, callback); }
  };
  const context = vm.createContext({
    document,
    window: { addEventListener(event, callback) { windowListeners.set(event, callback); } },
    Date,
    fetch: async () => { fetches += 1; return { ok: true, json: async () => ({}) }; },
    setTimeout(callback, delay) { timerId += 1; timeouts.set(timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval() { throw new Error("non-polling pages must not start a local interval"); },
    clearInterval() {},
    encodeURIComponent,
    location: { reload() { reloads += 1; } }
  });
  new vm.Script(script).runInContext(context);
  windowListeners.get("pageshow")();
  windowListeners.get("pageshow")();
  documentListeners.get("visibilitychange")();
  documentListeners.get("visibilitychange")();
  assert.strictEqual(timeouts.size, 0, "review pages must never schedule workflow status polling");
  assert.strictEqual(fetches, 0);
  assert.strictEqual(reloads, 0);
}

async function assertWorkflowCooldownClient() {
  const script = fs.readFileSync(path.join(root, "src", "dashboard", "assets", "workflow.js"), "utf8");
  let clock = Date.parse("2099-02-01T00:09:57.000Z");
  let timerId = 0;
  let fetches = 0;
  const timeouts = new Map();
  const intervals = new Map();
  const countdown = { dataset: { retryAt: "2099-02-01T00:10:00.000Z" }, textContent: "" };
  const cooldown = { dataset: { retryAt: "2099-02-01T00:10:00.000Z" }, hidden: false };
  const panel = { dataset: {} };
  const page = {
    dataset: { pollingKind: "progress", workflowRunId: "cooldown-fixture", pollingInterval: "2500", terminalStates: "", workflowStatus: "scanning", workflowControlState: "", workflowPhaseKey: "acquisition" },
    querySelector(selector) {
      return {
        "[data-workflow-panel]": panel,
        "[data-cooldown]": cooldown,
        "[data-cooldown-countdown]": countdown
      }[selector] || null;
    },
    querySelectorAll() { return []; }
  };
  class ClockDate extends Date {
    constructor(value) { super(value === undefined ? clock : value); }
    static now() { return clock; }
  }
  const document = {
    hidden: false,
    querySelector(selector) { return selector === "[data-workflow-page]" ? page : null; },
    getElementById() { return null; },
    addEventListener() {}
  };
  const context = vm.createContext({
    document,
    window: { addEventListener() {} },
    Date: ClockDate,
    fetch: async () => { fetches += 1; return { ok: true, json: async () => validWorkflowSnapshot() }; },
    setTimeout(callback, delay) { timerId += 1; timeouts.set(timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(callback, interval) { timerId += 1; intervals.set(timerId, { callback, interval }); return timerId; },
    clearInterval(id) { intervals.delete(id); },
    encodeURIComponent,
    location: { reload() {} }
  });
  new vm.Script(script).runInContext(context);
  assert.strictEqual(intervals.size, 1, "cooldown must use one local one-second interval");
  assert.strictEqual([...intervals.values()][0].interval, 1000);
  assert.strictEqual(timeouts.size, 1, "progress polling must use one separate timeout");
  assert.strictEqual([...timeouts.values()][0].delay, 0, "the first visible status read should start immediately");
  assert.strictEqual(countdown.textContent, "3 秒", "countdown must be calculated from the server retry timestamp");
  clock += 1000;
  [...intervals.values()][0].callback();
  assert.strictEqual(countdown.textContent, "2 秒", "the local tick must progress without a new server timestamp");
  clock += 3000;
  [...intervals.values()][0].callback();
  assert.strictEqual(countdown.textContent, "0 秒", "a completed cooldown must wait for polling rather than trigger an action");
  assert.strictEqual(fetches, 0, "local cooldown ticks must not trigger HTTP requests");
  const [timeoutId, timeout] = timeouts.entries().next().value;
  timeouts.delete(timeoutId);
  await timeout.callback();
  await flushPromises();
  assert.strictEqual(fetches, 1, "the scheduled progress poll must remain independent from the countdown");
  assert.strictEqual(timeouts.size, 1);
  assert.strictEqual([...timeouts.values()][0].delay, 2500);
}

function validWorkflowSnapshot() {
  return {
    workflow: { status: "scanning", controlState: "", progressRevision: 1, lastActivityAt: "2099-02-01T00:09:57.000Z" },
    progress: {
      phaseKey: "acquisition",
      stage: "扫描岗位并读取详情",
      stageIndex: 2,
      stageCount: 4,
      scan: null,
      scanWait: null,
      eta: { status: "estimating" },
      scanTargets: { total: 5, processed: 2, completed: 2, pending: 3, partial: 0, failed: 0 },
      details: { collected: 12, required: 12, read: 5, pending: 7, notRequired: 0, growing: false },
      tracks: {
        scan: { value: 2, max: 5, indeterminate: false },
        jd: { value: 5, max: 12, indeterminate: false, growing: false },
        analysis: { value: 0, max: 12, indeterminate: false },
        communication: { value: 0, max: 0, indeterminate: false }
      },
      remainingWorkLabel: "还需完成 3 个搜索目标；7 个岗位详情待读取",
      analysis: { total: 12, terminal: 0, pending: 12, running: 0, retryPending: 0, succeeded: 0, skipped: 0, failed: 0, stopped: 0, detailRequired: 0, tasks: [] }
    },
    controls: { canPause: true, canResume: false, canStop: true },
    recentActivity: []
  };
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
  const rejectedFrozenPortableResume = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: interruptedAnalysis.workflowId,
    browserMode: "portable"
  });
  assert.strictEqual(rejectedFrozenPortableResume.status, 409);
  assert.match(rejectedFrozenPortableResume.body, /DASHBOARD_BROWSER_AUTHORITY_MISMATCH/);
  const interruptedAnalysisResume = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: interruptedAnalysis.workflowId,
    browserMode: "edge"
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
  const { freezeWorkflowPlan } = require("../src/core/workflow_acquisition");
  const savedPlan = database.prepare("SELECT plan_json FROM search_plans WHERE id = ?").get(saved.planId);
  const planSnapshot = {
    ...JSON.parse(savedPlan.plan_json),
    acquisitionMode: "generated",
    platform: {
      site: "boss",
      generated: { cities: ["广州"], salaryLanes: [], experience: [], jobTypes: [], degrees: [] }
    }
  };
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
      ...freezeWorkflowPlan(planSnapshot),
      acquisitionMode: "generated",
      browserMode: "edge",
      cdpPort: null,
      searchTemplate: { mode: "generated", url: "", cityCode: "" },
      cityScopes: [{ city: "广州", cityCode: "101280100" }],
      nativeFilters: { site: "boss", catalogVersion: "fixture-catalog", params: {}, labels: {}, lanes: [{ id: "default", rank: 0, params: {}, labels: {} }] },
      nativeFilterCatalogRevision: "fixture-catalog",
      keywordSource: {
        searchPlanId: saved.planId,
        profileVersionId: saved.profileVersionId,
        matchingCardRevision: "fixture-card",
        catalogHash: "fixture-keywords",
        keywords: [{ word: "workflow-api", priority: "A", reason: "fixture" }]
      },
      platformPolicy: {
        site: "boss",
        hash: "fixture-generated-policy",
        filters: { location: { mode: "specific", codes: ["101280100"], cities: ["广州"], districts: [] }, salary: { codes: [], labels: [], ranges: [] }, experience: { codes: [], labels: [] }, degree: { codes: [], labels: [] }, jobType: { codes: [], labels: [] }, acquisitionOnly: {} },
        unresolvedParams: [],
        filterSummary: ["地点：广州"]
      },
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
  const match = String(page).match(/<script>\s*(\(function\(\)\{[\s\S]*?setInterval\(refreshReadiness, 5000\);[\s\S]*?正在启动本轮任务[\s\S]*?\}\)\(\);)\s*<\/script>/);
  assert(match, "expected rendered plan page to include the browser-readiness polling script");
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
    },
    URLSearchParams
  });
  new vm.Script(readinessScript).runInContext(context);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(typeof intervalCallback, "function");
  assert.strictEqual(intervalMs, 5000);
  assert.strictEqual(button.disabled, expectedDisabled);
  assert.strictEqual(formSubmitCalls, 0);
}

async function assertBrowserReadinessModeSelection(readinessScript) {
  const requests = [];
  const listeners = new Map();
  const button = { dataset: { browserBaseDisabled: "false" }, disabled: true };
  const browserMode = {
    value: "edge",
    addEventListener(event, callback) { listeners.set(event, callback); }
  };
  const statusNode = { textContent: "", dataset: {} };
  const context = vm.createContext({
    document: {
      getElementById(id) { return id === "browser-readiness-status" ? statusNode : null; },
      querySelector(selector) {
        if (selector === "[data-browser-readiness-button]") return button;
        if (selector === "select[name=browserMode]") return browserMode;
        return null;
      }
    },
    fetch(url) {
      requests.push(url);
      const portable = String(url).includes("browserMode=portable") && String(url).includes("cdpPort=9222");
      return Promise.resolve({
        ok: true,
        json: async () => ({ status: portable ? "ready" : "login_required", message: "fixture mode" })
      });
    },
    setInterval() { return 1; },
    URLSearchParams
  });
  new vm.Script(readinessScript).runInContext(context);
  await flushPromises();
  assert.deepStrictEqual(requests, ["/api/browser-readiness?browserMode=edge"]);
  assert.strictEqual(button.disabled, true);
  browserMode.value = "portable";
  await listeners.get("change")();
  await flushPromises();
  assert.deepStrictEqual(requests, [
    "/api/browser-readiness?browserMode=edge",
    "/api/browser-readiness?browserMode=portable&cdpPort=9222"
  ]);
  assert.strictEqual(button.disabled, false);
}

async function assertBrowserReadinessModeSwitchRace(readinessScript) {
  const requests = [];
  const listeners = new Map();
  const button = { dataset: { browserBaseDisabled: "false" }, disabled: true };
  const browserMode = {
    value: "edge",
    addEventListener(event, callback) { listeners.set(event, callback); }
  };
  const statusNode = { textContent: "", dataset: {} };
  const context = vm.createContext({
    document: {
      getElementById(id) { return id === "browser-readiness-status" ? statusNode : null; },
      querySelector(selector) {
        if (selector === "[data-browser-readiness-button]") return button;
        if (selector === "select[name=browserMode]") return browserMode;
        return null;
      }
    },
    fetch(url) {
      const request = deferred();
      requests.push({ url, request });
      return request.promise;
    },
    setInterval() { return 1; },
    URLSearchParams
  });
  new vm.Script(readinessScript).runInContext(context);
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].url, "/api/browser-readiness?browserMode=edge");

  browserMode.value = "portable";
  await listeners.get("change")();
  requests[0].request.resolve(readinessResponse("ready"));
  await flushPromises();
  assert.notStrictEqual(statusNode.dataset.status, "ready", "a stale Edge response must not update portable readiness");
  assert.strictEqual(button.disabled, true, "a stale Edge response must not enable the portable selection");
  assert.strictEqual(requests.length, 2, "finishing a stale Edge request must immediately launch portable readiness");
  assert.strictEqual(requests[1].url, "/api/browser-readiness?browserMode=portable&cdpPort=9222");
  requests[1].request.resolve(readinessResponse("ready"));
  await flushPromises();
  assert.strictEqual(statusNode.dataset.status, "ready");
  assert.strictEqual(button.disabled, false);

  browserMode.value = "edge";
  await listeners.get("change")();
  browserMode.value = "portable";
  await listeners.get("change")();
  requests[2].request.reject(new Error("stale edge failure"));
  await flushPromises();
  assert.notStrictEqual(statusNode.dataset.status, "browser_unavailable", "a stale Edge failure must not replace portable readiness");
  assert.strictEqual(requests.length, 4, "a stale Edge failure must immediately launch portable readiness");
  assert.strictEqual(requests[3].url, "/api/browser-readiness?browserMode=portable&cdpPort=9222");
  requests[3].request.resolve(readinessResponse("ready"));
  await flushPromises();
  assert.strictEqual(button.disabled, false);
}

async function assertSerializedSlowBrowserReadinessGate(readinessScript) {
  const requests = [];
  let intervalCallback = null;
  let intervalMs = null;
  let clearedInterval = null;
  const formListeners = new Map();
  const form = {
    addEventListener(event, callback) { formListeners.set(event, callback); }
  };
  const button = {
    dataset: { browserBaseDisabled: "false" },
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
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
    setInterval(callback, interval) {
      intervalCallback = callback;
      intervalMs = interval;
      return 1;
    },
    clearInterval(id) { clearedInterval = id; },
    URLSearchParams
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
  assert.strictEqual(typeof formListeners.get("submit"), "function");
  formListeners.get("submit")();
  assert.strictEqual(clearedInterval, 1, "workflow submission must stop the readiness timer");
  await intervalCallback();
  assert.strictEqual(requests.length, 1, "readiness polling must remain stopped after workflow submission");
  assert.strictEqual(statusNode.textContent, "正在启动本轮任务…");
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
