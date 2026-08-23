const assert = require("node:assert");
const { appError } = require("../src/core/observability");
const { acquisitionModeOf } = require("../src/core/search_plan_schema");
const { freezeWorkflowPlan } = require("../src/core/workflow_acquisition");
const {
  startWorkflow,
  resumeWorkflow,
  controlWorkflow,
  getWorkflowStatus
} = require("../src/application/workflow");
const { resolveNewWorkflowBrowser } = require("../src/dashboard/server");

async function main() {
  dashboardAuthorityResolverRejectsRequestDrift();
  exportsAndPlainData();
  await validationPrecedesPersistenceAndLaunch();
  await activeWorkflowSkipsPreparation();
  await directApplicationContract();
  await portableWorkflowPersistsDashboardAuthority();
  await portableRecoveryKeepsFrozenAuthority();
  await resumeControlAndStatusContracts();
  console.log("workflow application smoke passed");
}

function exportsAndPlainData() {
  for (const fn of [startWorkflow, resumeWorkflow, controlWorkflow, getWorkflowStatus]) {
    assert.strictEqual(typeof fn, "function");
  }

  const result = getWorkflowStatus({
    db: {},
    workflowRunId: "workflow-1",
    deps: statusDeps([])
  });
  assertPlain(result);
  assert.strictEqual(result.statusCode, 200);
}

async function validationPrecedesPersistenceAndLaunch() {
  const events = [];
  await assert.rejects(
    startWorkflow({
      db: {},
      input: { planId: 41, modelReady: true },
      deps: {
        ...startDeps(events),
        getSearchPlan() {
          events.push("validation");
          return null;
        }
      }
    }),
    (error) => error.code === "WORKFLOW_PROFILE_NOT_FOUND" && error.statusCode === 404
  );
  assert.deepStrictEqual(events, ["validation"]);
}

async function directApplicationContract() {
  const events = [];
  let launch = null;
  let persistedPlanner = null;
  const result = await startWorkflow({
    db: {},
    input: {
      planId: 41,
      browserMode: "edge",
      modelReady: true,
      modelState: modelState(),
      requestId: "request-1"
    },
    deps: startDeps(events, (value) => { launch = value; }, (value) => { persistedPlanner = value; })
  });

  assert.deepStrictEqual(events, [
    "plan-load",
    "active-check",
    "rescore",
    "planning",
    "acquisition-resolve",
    "scan-availability",
    "workflow-persistence",
    "launcher"
  ]);
  assert.strictEqual(result.workflow.id, "workflow-1");
  assert.strictEqual(launch.runId, "scan-7");
  assert.strictEqual(launch.batchId, 91);
  assert.strictEqual(launch.workflowRunId, result.workflow.id);
  assert.notStrictEqual(result.workflow.id, launch.runId);
  assert.notStrictEqual(launch.runId, String(launch.batchId));
  assert.deepStrictEqual(launch.input, {
    planId: 41,
    browserMode: "edge",
    cdpPort: null,
    scanKind: "daily",
    workflowRunId: "workflow-1"
  });
  assert.strictEqual(persistedPlanner.planSnapshotVersion, 2);
  assert.strictEqual(persistedPlanner.planSnapshot.acquisitionMode, "generated");
  assert.deepStrictEqual(persistedPlanner.planSnapshot.directions, ["AI 应用开发"]);
  assert.deepStrictEqual(persistedPlanner.cityScopes, [{ city: "广州", cityCode: "101280100" }]);
  assert.deepStrictEqual(persistedPlanner.nativeFilters.labels, { experience: ["1-3年"] });
  assert.strictEqual(result.workflow.planner.planHash, persistedPlanner.planHash);
  assert.deepStrictEqual(result.workflow.planner.planSnapshot.directions, ["AI 应用开发"]);
  assertPlain(result);
}

async function portableWorkflowPersistsDashboardAuthority() {
  const events = [];
  let launch = null;
  let persistedPlanner = null;
  const deps = startDeps(events, (value) => { launch = value; }, (value) => { persistedPlanner = value; });
  deps.resolveNewWorkflowBrowser = () => ({ browserMode: "portable", cdpPort: 9222 });
  await startWorkflow({
    db: {},
    input: { planId: 41, modelReady: true, modelState: modelState() },
    deps
  });
  assert.deepStrictEqual(
    { browserMode: persistedPlanner.browserMode, cdpPort: persistedPlanner.cdpPort },
    { browserMode: "portable", cdpPort: 9222 }
  );
  assert.deepStrictEqual(
    { browserMode: launch.input.browserMode, cdpPort: launch.input.cdpPort },
    { browserMode: "portable", cdpPort: 9222 }
  );
}

async function portableRecoveryKeepsFrozenAuthority() {
  const events = [];
  const launches = [];
  const resumed = await resumeWorkflow({
    db: {},
    input: { workflowRunId: "workflow-2", batchModelReady: true },
    deps: resumeDeps(events, { browserMode: "portable", cdpPort: 9222 }, launches)
  });
  assert.strictEqual(resumed.workflow.id, "workflow-2");
  assert.deepStrictEqual(
    { browserMode: launches[0].browserMode, cdpPort: launches[0].cdpPort },
    { browserMode: "portable", cdpPort: 9222 }
  );
}

function dashboardAuthorityResolverRejectsRequestDrift() {
  const portableAuthority = {
    browserMode: "portable",
    cdpPort: 9222,
    profilePath: "C:\\test\\BrowserProfile"
  };
  assert.deepStrictEqual(resolveNewWorkflowBrowser({}, portableAuthority), {
    browserMode: "portable",
    cdpPort: 9222
  });
  assert.deepStrictEqual(resolveNewWorkflowBrowser({ browserMode: "portable", cdpPort: "9222" }, portableAuthority), {
    browserMode: "portable",
    cdpPort: 9222
  });
  assert.throws(
    () => resolveNewWorkflowBrowser({ browserMode: "edge" }, portableAuthority),
    (error) => error.code === "DASHBOARD_BROWSER_AUTHORITY_MISMATCH"
  );
  const edgeAuthority = { browserMode: "edge", cdpPort: null, profilePath: "" };
  assert.deepStrictEqual(resolveNewWorkflowBrowser({ cdpPort: null }, edgeAuthority), {
    browserMode: "edge",
    cdpPort: null
  });
  assert.throws(
    () => resolveNewWorkflowBrowser({ cdpPort: 9222 }, edgeAuthority),
    (error) => error.code === "DASHBOARD_BROWSER_AUTHORITY_MISMATCH"
  );
}

async function activeWorkflowSkipsPreparation() {
  const events = [];
  const deps = startDeps(events);
  deps.getActiveWorkflow = () => {
    events.push("active-check");
    return { id: "already-running", planner: {} };
  };
  const result = await startWorkflow({
    db: {},
    input: { planId: 41, browserMode: "edge", modelReady: true, modelState: modelState() },
    deps
  });
  assert.strictEqual(result.alreadyActive, true);
  assert.strictEqual(result.workflow.id, "already-running");
  assert.deepStrictEqual(events, ["plan-load", "active-check"]);
}

async function resumeControlAndStatusContracts() {
  const resumeEvents = [];
  const resumed = await resumeWorkflow({
    db: {},
    input: {
      workflowRunId: "workflow-2",
      batchModelReady: true,
      requestId: "request-2"
    },
    deps: resumeDeps(resumeEvents)
  });
  assert.strictEqual(resumed.workflow.id, "workflow-2");
  assert.deepStrictEqual(resumeEvents, ["analysis-batch", "transition", "scan-run-creation", "workflow-scan-binding", "spawn"]);
  assertPlain(resumed);

  const controlEvents = [];
  const controlled = await controlWorkflow({
    db: {},
    input: { workflowRunId: "workflow-3", action: "pause", requestId: "request-3" },
    deps: controlDeps(controlEvents)
  });
  assert.deepStrictEqual(controlEvents, ["pause", "finalize"]);
  assert.deepStrictEqual(controlled, { workflowRunId: "workflow-3", action: "pause", workflow: controlWorkflowFixture() });
  assertPlain(controlled);

  const statusEvents = [];
  const status = getWorkflowStatus({
    db: {},
    workflowRunId: "workflow-4",
    deps: statusDeps(statusEvents)
  });
  assert.deepStrictEqual(statusEvents, ["recover", "snapshot"]);
  assert.strictEqual(status.body.workflow.id, "workflow-4");
  assertPlain(status);
}

function startDeps(events, captureLaunch = () => {}, capturePlanner = () => {}) {
  const plan = planFixture();
  let dashboardReads = 0;
  return {
    appError,
    resolveNewWorkflowBrowser: () => ({ browserMode: "edge", cdpPort: null }),
    getSearchPlan() {
      events.push("plan-load");
      return plan;
    },
    getCandidateProfile: () => ({ id: plan.profileId }),
    getCandidateMatchingContext: () => ({ candidateProfile: {} }),
    getSearchPlanDependency: () => ({}),
    assertSearchPlanReady: (_plan, _profile, _dependency, options) => assert.strictEqual(options.acquisitionMode, "generated"),
    acquisitionModeOf,
    freezeWorkflowPlan,
    getActiveWorkflow: () => {
      events.push("active-check");
      return null;
    },
    buildDashboardState: () => {
      dashboardReads += 1;
      if (dashboardReads === 1) events.push("planning");
      return dashboardState();
    },
    preparePlanForNewWorkflow: () => events.push("rescore"),
    acquisitionContextResolver: () => {
      events.push("acquisition-resolve");
      return {
        acquisitionMode: "generated",
        searchTemplate: { mode: "generated", url: "", cityCode: "" },
        searchScope: {},
        keywordSource: { searchPlanId: 41 },
        platformPolicy: { hash: "generated-policy" },
        cityScopes: [{ city: "广州", cityCode: "101280100" }],
        nativeFilters: { site: "boss", labels: { experience: ["1-3年"] }, lanes: [] },
        nativeFilterCatalogRevision: "catalog-r1"
      };
    },
    assertAcquisitionContext: (value) => value,
    scanAvailability: () => events.push("scan-availability"),
    workflowModelProfilesSnapshot: () => ({ batch_screening: { revision: "revision-1" } }),
    createWorkflowRun(_db, input) {
      events.push("workflow-persistence");
      capturePlanner(input.planner);
      plan.plan.directions = ["后端开发"];
      return { id: "workflow-1", sequence: 1, scanNeeded: true, metrics: input.metrics, planner: input.planner };
    },
    spawnScan(_scanRuns, input) {
      events.push("launcher");
      const launch = { runId: "scan-7", batchId: 91, workflowRunId: input.workflowRunId, input: selectLaunchInput(input) };
      captureLaunch(launch);
      return launch;
    },
    logger: silentLogger(),
    now: () => new Date("2026-08-11T00:00:00.000Z")
  };
}

function resumeDeps(events, browserAuthority = { browserMode: "edge", cdpPort: null }, launches = []) {
  const workflow = {
    id: "workflow-2",
    planId: 41,
    profileId: 9,
    status: "interrupted",
    resumePhase: "analyzing",
    scanNeeded: true,
    scanBatchId: 91,
    planner: { acquisitionMode: "generated", planSnapshotVersion: 2, browserMode: browserAuthority.browserMode, cdpPort: browserAuthority.cdpPort }
  };
  return {
    appError,
    getWorkflowRun: () => workflow,
    workflowResumeNeedsBatchModel: () => false,
    assertFrozenWorkflowPlan: (value) => value,
    assertCompleteGeneratedContext: (value) => value,
    resolveWorkflowResumeBrowserMode: () => browserAuthority.browserMode,
    normalizeCdpPort: (value) => Number(value),
    portableCdpPort: 9222,
    workflowResumeRequiresBrowser: () => false,
    assertWorkflowAnalysisBatch: () => events.push("analysis-batch"),
    transitionWorkflowRun(_db, input) {
      events.push("transition");
      return { ...workflow, status: input.status, resumePhase: input.resumePhase };
    },
    spawnScan(_scanRuns, input) {
      launches.push(input);
      events.push("scan-run-creation");
      events.push("workflow-scan-binding");
      events.push("spawn");
      return { runId: "scan-8", batchId: 91, workflowRunId: input.workflowRunId, input: selectLaunchInput(input) };
    },
    logger: silentLogger()
  };
}

function controlDeps(events) {
  return {
    appError,
    getWorkflowRun: () => controlWorkflowFixture(),
    exactActiveWorkflowRun: () => null,
    exactPersistedWorkflowRunIsRunning: () => false,
    requestWorkflowPause: () => events.push("pause"),
    finalizeWorkflowControl: () => events.push("finalize"),
    logger: silentLogger(),
    now: () => "2026-08-11T00:00:00.000Z"
  };
}

function statusDeps(events) {
  const workflow = { ...controlWorkflowFixture(), id: "workflow-4", planId: 41, communicationBatchId: null, errorCode: "" };
  return {
    recover() {
      events.push("recover");
      return { scanRunsInterrupted: 0, workflowRunsInterrupted: 0, workflowRunsCompleted: 0 };
    },
    progressSnapshot() {
      events.push("snapshot");
      return { workflow, progress: { stage: "scanning" }, model: {}, controls: {}, recentActivity: [] };
    },
    getWorkflowRun: () => workflow,
    getSearchPlan: () => planFixture(),
    buildDashboardState: () => ({ successfulToday: 3, dailyTarget: 5, slotsUsed: 1 }),
    communicationStatus: () => null,
    publicCommunicationStatus: (value) => value,
    publicWorkflow: (value) => ({ id: value.id, status: value.status, controlState: value.controlState, lastActivityAt: null, progressRevision: 0, errorCode: value.errorCode || null }),
    logger: silentLogger()
  };
}

function dashboardState() {
  return {
    localDay: "2026-08-11",
    runs: [],
    inventory: [],
    activeRun: null,
    nextPlan: {
      targetSuccessCount: 5,
      inventoryCount: 0,
      candidateGap: 5,
      scanNeeded: true,
      selectedKeywords: [{ word: "RAG", maxCards: 20 }],
      budget: { maxDetailTotal: 20, browserPageBudget: 4 },
      projectedNewCandidates: 5
    }
  };
}

function planFixture() {
  return {
    id: 41,
    profileId: 9,
    profileVersionId: 3,
    plan: {
      schemaVersion: 2,
      acquisitionMode: "generated",
      platform: { site: "boss", generated: { cities: ["广州"], salaryLanes: [], experience: ["1-3年"], jobTypes: [], degrees: [] } },
      directions: ["AI 应用开发"],
      keywords: [{ word: "RAG", priority: "A", reason: "核心" }],
      salary: { minK: 12, maxK: 20 },
      salaryMode: "wide",
      bossActiveDays: 7,
      workSchedulePreference: "prefer_double_weekend",
      scan: { maxCards: 60, maxDetailTotal: 300, browserPageBudget: 90 }
    }
  };
}
function modelState() { return { settings: { taskProfiles: { batch_screening: { revision: "revision-1" } } } }; }
function controlWorkflowFixture() { return { id: "workflow-3", planId: 41, status: "scanning", controlState: "none", progressRevision: 0 }; }
function silentLogger() { return { info: (...args) => { if (args[0] === "inherited-context") return; }, warn() {}, error() {} }; }
function selectLaunchInput(input) { return Object.fromEntries(Object.entries(input).filter(([key]) => ["planId", "browserMode", "cdpPort", "scanKind", "workflowRunId"].includes(key))); }
function assertPlain(value) { assert.deepStrictEqual(JSON.parse(JSON.stringify(value)), value); }

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
