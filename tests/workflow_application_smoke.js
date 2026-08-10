const assert = require("node:assert");
const { appError } = require("../src/core/observability");
const {
  startWorkflow,
  resumeWorkflow,
  controlWorkflow,
  getWorkflowStatus
} = require("../src/application/workflow");

async function main() {
  exportsAndPlainData();
  await validationPrecedesPersistenceAndLaunch();
  await directApplicationContract();
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
  const result = await startWorkflow({
    db: {},
    input: {
      planId: 41,
      browserMode: "portable",
      cdpPort: 9222,
      modelReady: true,
      modelState: modelState(),
      requestId: "request-1"
    },
    deps: startDeps(events, (value) => { launch = value; })
  });

  assert.deepStrictEqual(events, [
    "validation",
    "inherited-context",
    "inherited-validation",
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
    browserMode: "portable",
    cdpPort: 9222,
    scanKind: "daily",
    workflowRunId: "workflow-1"
  });
  assertPlain(result);
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

function startDeps(events, captureLaunch = () => {}) {
  const plan = planFixture();
  return {
    appError,
    resolveNewInheritedBrowser: (input) => ({ browserMode: input.browserMode || "edge", cdpPort: input.cdpPort || null }),
    getSearchPlan() {
      events.push("validation");
      return plan;
    },
    getCandidateProfile: () => ({ id: plan.profileId }),
    getCandidateMatchingContext: () => ({ candidateProfile: {} }),
    getSearchPlanDependency: () => ({}),
    assertSearchPlanReady: () => {},
    buildDashboardState: (_db, _plan, _now, inherited) => inherited
      ? dashboardState()
      : dashboardState(),
    inheritedContextResolver: () => {
      events.push("inherited-context");
      return {
        acquisitionMode: "generated",
        searchTemplate: {},
        searchScope: {},
        keywordSource: {},
        platformPolicy: {}
      };
    },
    assertInheritedAcquisitionScope: () => events.push("inherited-validation"),
    scanAvailability: () => events.push("scan-availability"),
    workflowModelProfilesSnapshot: () => ({ batch_screening: { revision: "revision-1" } }),
    createWorkflowRun(_db, input) {
      events.push("workflow-persistence");
      return { id: "workflow-1", sequence: 1, scanNeeded: true, metrics: input.metrics };
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

function resumeDeps(events) {
  const workflow = {
    id: "workflow-2",
    planId: 41,
    profileId: 9,
    status: "interrupted",
    resumePhase: "analyzing",
    scanNeeded: true,
    scanBatchId: 91,
    planner: { acquisitionMode: "generated" }
  };
  return {
    appError,
    getWorkflowRun: () => workflow,
    workflowResumeNeedsBatchModel: () => false,
    resolveWorkflowResumeBrowserMode: () => "edge",
    workflowResumeRequiresBrowser: () => false,
    assertWorkflowAnalysisBatch: () => events.push("analysis-batch"),
    transitionWorkflowRun(_db, input) {
      events.push("transition");
      return { ...workflow, status: input.status, resumePhase: input.resumePhase };
    },
    spawnScan(_scanRuns, input) {
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

function planFixture() { return { id: 41, profileId: 9, plan: {} }; }
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
