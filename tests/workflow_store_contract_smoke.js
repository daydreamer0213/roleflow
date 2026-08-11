const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const BASE = "96087de2c495398808da9d2ed03b25697b23a284";
const WORKFLOW_EXPORTS = [
  "createWorkflowRun", "getWorkflowRun", "getWorkflowRunByCommunicationBatch", "listWorkflowRuns",
  "getActiveWorkflowRun", "transitionWorkflowRun", "attachWorkflowScan", "attachWorkflowScanRun",
  "attachWorkflowCommunication", "requestWorkflowRunConfigurationPause", "recordWorkflowScanWait",
  "recordWorkflowPlatformAccess", "workflowJobTaskRow", "jobAnalysisAttemptRow", "countWorkflowJobTasks",
  "insertWorkflowJobTaskRow", "reactivateWorkflowDetailRequiredTaskRow", "selectReadyWorkflowJobEntries",
  "isWorkflowJobTaskObservationReady", "settleIncompleteWorkflowJobTaskRows", "selectClaimableWorkflowJobTaskRow",
  "claimWorkflowJobTaskRow", "insertJobAnalysisAttemptRow", "incrementWorkflowRunActivity",
  "getWorkflowObservationJob", "listWorkflowJobTaskRows", "listJobAnalysisAttemptRows", "getWorkflowJobTaskRow",
  "getRunningJobAnalysisAttemptRow", "finishJobAnalysisAttemptRow", "failWorkflowJobTaskRow",
  "incrementWorkflowTimeoutCounters", "countWorkflowJobTaskStatuses", "selectEarliestRetryAvailableAt",
  "markWorkflowJobTasksStopped", "selectExpiredLeaseWorkflowJobTaskRows", "completeWorkflowJobTaskRow",
  "WORKFLOW_RUN_STATUSES", "WORKFLOW_TIMEOUT_CIRCUIT_OPEN_CODE"
].sort();
const MOVED_DEFINITIONS = [
  ...WORKFLOW_EXPORTS,
  "workflowRunRow", "workflowObservationJobRow", "nonNegativeInteger", "workflowRunError",
  "ACTIVE_WORKFLOW_RUN_STATUSES", "TERMINAL_WORKFLOW_RUN_STATUSES", "WORKFLOW_CONTROL_STATES",
  "WORKFLOW_DETAIL_REQUIRED_CODE", "WORKFLOW_DETAIL_REQUIRED_KIND", "WORKFLOW_OBSERVATION_QUALITY_JSON_SQL",
  "WORKFLOW_OBSERVATION_READY_SQL", "WORKFLOW_TRANSITIONS"
].sort();
const CHILD_TESTS = [
  "workflow_storage_smoke.js", "workflow_task_storage_smoke.js", "workflow_control_smoke.js",
  "workflow_progress_smoke.js", "workflow_analysis_executor_smoke.js", "workflow_inventory_smoke.js",
  "workflow_health_smoke.js", "workflow_communication_smoke.js", "workflow_scan_smoke.js",
  "workflow_scan_analysis_smoke.js", "workflow_recovery_smoke.js", "workflow_end_to_end_smoke.js",
  "communication_store_contract_smoke.js", "communication_batch_storage_smoke.js",
  "communication_application_smoke.js", "storage_migration_smoke.js"
];

const warnings = [];
const onWarning = (warning) => warnings.push(warning);
process.on("warning", onWarning);
const storage = require("../src/core/storage");
const workflowStore = require("../src/storage/workflow_store");
const communicationStore = require("../src/storage/communication_store");
const communicationFacade = require("../src/core/communication_batches");
const candidateStore = require("../src/storage/candidate_store");
const jobStore = require("../src/storage/job_store");
const scanStore = require("../src/storage/scan_store");
const sharedStore = require("../src/storage/storage_shared");
process.removeListener("warning", onWarning);

contract01ExportsAndFacadeIdentity();
contract02LoadGraphAndBodyInventory();
contract03RuntimeOwnershipAndRollback();
contract04RegressionChildren();
console.log("workflow_store_contract_smoke ok (4 owner contracts)");

function contract01ExportsAndFacadeIdentity() {
  assert.deepEqual(Object.keys(workflowStore).sort(), WORKFLOW_EXPORTS);
  assert.equal(Object.keys(storage).length, 136);
  assert.equal(Object.keys(candidateStore).length, 29);
  assert.equal(Object.keys(jobStore).length, 26);
  assert.equal(Object.keys(scanStore).length, 35);
  assert.equal(Object.keys(communicationStore).length, 14);
  assert.equal(Object.keys(sharedStore).length, 9);
  for (const name of WORKFLOW_EXPORTS) assert.strictEqual(storage[name], workflowStore[name], `${name} must retain its owner reference`);
  assert.strictEqual(storage.immediateTransaction, sharedStore.immediateTransaction);
  assert.strictEqual(communicationFacade, communicationStore);
  assert.equal(warnings.filter((warning) => /circular dependency/i.test(warning.message)).length, 0);
}

function contract02LoadGraphAndBodyInventory() {
  const graph = runNode(`
    const Module = require("node:module");
    const path = require("node:path");
    const root = ${JSON.stringify(ROOT)};
    const targets = new Map([
      [path.join(root, "src", "storage", "workflow_store.js"), []],
      [path.join(root, "src", "storage", "communication_store.js"), []]
    ]);
    const original = Module._load;
    Module._load = function(request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (parent && targets.has(path.resolve(parent.filename))) targets.get(path.resolve(parent.filename)).push(resolved);
      return original.apply(this, arguments);
    };
    require(path.join(root, "src", "core", "storage.js"));
    require(path.join(root, "src", "storage", "workflow_store.js"));
    require(path.join(root, "src", "storage", "communication_store.js"));
    process.stdout.write(JSON.stringify([...targets.entries()]));
  `);
  assert.doesNotMatch(graph.stderr, /circular dependency/i);
  const edges = new Map(JSON.parse(graph.stdout));
  const workflowEdges = edges.get(path.join(ROOT, "src", "storage", "workflow_store.js"))
    .map((entry) => entry === "node:crypto" ? entry : path.basename(entry)).sort();
  assert.deepEqual(workflowEdges, ["job_description_readiness.js", "node:crypto", "storage_shared.js"]);
  const communicationEdges = edges.get(path.join(ROOT, "src", "storage", "communication_store.js"));
  assert(communicationEdges.includes(path.join(ROOT, "src", "storage", "workflow_store.js")));
  assert(!communicationEdges.includes(path.join(ROOT, "src", "core", "storage.js")));

  const baseline = gitShow(`${BASE}:src/core/storage.js`);
  const current = fs.readFileSync(path.join(ROOT, "src", "storage", "workflow_store.js"), "utf8");
  for (const name of MOVED_DEFINITIONS) {
    assert.equal(
      normalize(definition(current, name)),
      normalize(definition(baseline, name)),
      `${name} must be body-equivalent to the frozen storage owner`
    );
  }
  const shared = fs.readFileSync(path.join(ROOT, "src", "storage", "storage_shared.js"), "utf8");
  assert.equal(normalize(definition(shared, "immediateTransaction")), normalize(definition(baseline, "immediateTransaction")));
  const transactionOwners = [
    path.join(ROOT, "src", "core", "storage.js"),
    path.join(ROOT, "src", "storage", "workflow_store.js"),
    path.join(ROOT, "src", "storage", "storage_shared.js")
  ].map((file) => (fs.readFileSync(file, "utf8").match(/function immediateTransaction\(/g) || []).length)
    .reduce((sum, count) => sum + count, 0);
  assert.equal(transactionOwners, 1, "BEGIN IMMEDIATE helper body must have one owner");
}

function contract03RuntimeOwnershipAndRollback() {
  const db = storage.openDb(":memory:");
  try {
    const { profileId, planId } = seedPlan(db);
    const run = workflowStore.createWorkflowRun(db, {
      id: "workflow-store-contract", profileId, planId, localDay: "2030-01-02", sequence: 1,
      targetSuccessCount: 2, inventoryCount: 0, candidateGap: 2
    });
    assert.deepEqual(Object.keys(run).sort(), [
      "budget", "candidateGap", "circuitTimeoutJobCount", "communicationBatchId", "controlState", "createdAt",
      "errorCode", "errorMessage", "finishedAt", "id", "inventoryCount", "keywords", "lastActivityAt",
      "lifetimeTimeoutJobCount", "localDay", "metrics", "modelConfigRevision", "planId", "planner",
      "platformAccessStartedAt", "profileId", "progressRevision", "recoveryGeneration", "resumePhase",
      "reviewReadyAt", "scanBatchId", "scanNeeded", "scanRunId", "sequence", "shortfallCode", "startedAt",
      "status", "successfulCount", "targetSuccessCount", "updatedAt"
    ]);
    assert.equal(run.id, "workflow-store-contract");
    assert.equal(run.localDay, "2030-01-02");
    assert.equal(run.sequence, 1);
    assert.equal(workflowStore.transitionWorkflowRun(db, { id: run.id, status: "scanning" }).status, "scanning");
    assert.throws(
      () => workflowStore.transitionWorkflowRun(db, { id: run.id, status: "communicating" }),
      (error) => error.code === "WORKFLOW_TRANSITION_INVALID" && error.message === "workflow run cannot transition from scanning to communicating"
    );
    const batchId = storage.createBatch(db, "boss", "owner", "workflow store contract", { profileId, searchPlanId: planId });
    const scanRun = storage.createScanRun(db, { runId: "workflow-store-contract-scan", planId, batchId });
    const before = tableRows(db, "workflow_runs");
    const originalExec = db.exec.bind(db);
    let commitFailure = false;
    db.exec = (sql) => {
      if (String(sql) === "COMMIT" && !commitFailure) {
        commitFailure = true;
        throw new Error("late workflow scan commit failure");
      }
      return originalExec(sql);
    };
    try {
      assert.throws(
        () => workflowStore.attachWorkflowScan(db, { id: run.id, scanRunId: scanRun.id, scanBatchId: batchId }),
        /late workflow scan commit failure/
      );
    } finally {
      db.exec = originalExec;
    }
    assert.deepEqual(tableRows(db, "workflow_runs"), before, "late scan-link failure must roll back the complete workflow row");
    assert.equal(workflowStore.attachWorkflowScan(db, { id: run.id, scanRunId: scanRun.id, scanBatchId: batchId }).scanRunId, scanRun.id);

    const runOnly = workflowStore.createWorkflowRun(db, {
      id: "workflow-store-contract-run-only", profileId, planId, localDay: "2030-01-02", sequence: 2,
      targetSuccessCount: 2, inventoryCount: 0, candidateGap: 2
    });
    workflowStore.transitionWorkflowRun(db, { id: runOnly.id, status: "scanning" });
    const runOnlyScan = storage.createScanRun(db, { runId: "workflow-store-contract-run-only-scan", planId, batchId });
    const runOnlyBefore = tableRows(db, "workflow_runs");
    let runOnlyCommitFailure = false;
    db.exec = (sql) => {
      if (String(sql) === "COMMIT" && !runOnlyCommitFailure) {
        runOnlyCommitFailure = true;
        throw new Error("late workflow scan-run commit failure");
      }
      return originalExec(sql);
    };
    try {
      assert.throws(
        () => workflowStore.attachWorkflowScanRun(db, { id: runOnly.id, scanRunId: runOnlyScan.id }),
        /late workflow scan-run commit failure/
      );
    } finally {
      db.exec = originalExec;
    }
    assert.deepEqual(tableRows(db, "workflow_runs"), runOnlyBefore, "late scan-run-link failure must roll back the complete workflow row");
    assert.equal(workflowStore.attachWorkflowScanRun(db, { id: runOnly.id, scanRunId: runOnlyScan.id }).scanRunId, runOnlyScan.id);
  } finally {
    db.close();
  }
}

function contract04RegressionChildren() {
  for (const file of CHILD_TESTS) {
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
      cwd: ROOT, encoding: "utf8", timeout: 120000, windowsHide: true
    });
    assert.equal(result.status, 0, `${file} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

function seedPlan(db) {
  const now = "2030-01-02T00:00:00.000Z";
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Workflow Store Contract', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Workflow Store Contract', '{}', NULL, 1, ?, ?)`).run(profileId, now, now).lastInsertRowid);
  return { profileId, planId };
}

function tableRows(db, table) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
}

function runNode(script) {
  const result = spawnSync(process.execPath, ["-e", script], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function gitShow(revision) {
  const result = spawnSync("git", ["show", revision], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function definition(source, name) {
  const functionMarker = `function ${name}(`;
  const functionStart = source.indexOf(functionMarker);
  if (functionStart >= 0) return balancedBlock(source, functionStart, source.indexOf("{", functionStart));
  const constantStart = source.search(new RegExp(`(?:^|\\n)const ${name}\\s*=`));
  assert.notEqual(constantStart, -1, `missing definition for ${name}`);
  const semicolon = source.indexOf(";", constantStart);
  assert.notEqual(semicolon, -1, `unterminated constant ${name}`);
  return source.slice(constantStart, semicolon + 1);
}

function balancedBlock(source, start, brace) {
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function at ${start}`);
}

function normalize(value) {
  return value.replace(/\s+/g, "");
}
