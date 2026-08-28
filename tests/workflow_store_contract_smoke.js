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
contract04DirectHealthSnapshot();
contract05RegressionChildren();
console.log("workflow_store_contract_smoke ok (5 owner contracts)");

function contract01ExportsAndFacadeIdentity() {
  assert.deepEqual(Object.keys(workflowStore).sort(), WORKFLOW_EXPORTS);
  assert.equal(Object.keys(storage).length, 150);
  assert.equal(Object.keys(candidateStore).length, 29);
  assert.equal(Object.keys(jobStore).length, 26);
  assert.equal(Object.keys(scanStore).length, 39);
  assert.equal(Object.keys(communicationStore).length, 16);
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
    const other = seedPlan(db);
    assertWorkflowFailure(
      () => workflowStore.createWorkflowRun(db, {
        id: "missing-owner", localDay: "2030-01-02", sequence: 1
      }),
      "WORKFLOW_OWNER_REQUIRED",
      "workflow run profile and plan are required"
    );
    assertWorkflowFailure(
      () => workflowStore.createWorkflowRun(db, {
        id: "bad-day", profileId, planId, localDay: "20300102", sequence: 1
      }),
      "WORKFLOW_LOCAL_DAY_INVALID",
      "workflow local day must use YYYY-MM-DD"
    );
    assertWorkflowFailure(
      () => workflowStore.createWorkflowRun(db, {
        id: "bad-sequence", profileId, planId, localDay: "2030-01-02", sequence: 4
      }),
      "WORKFLOW_SEQUENCE_INVALID",
      "workflow run sequence must be 1, 2, or 3"
    );
    assertWorkflowFailure(
      () => workflowStore.createWorkflowRun(db, {
        id: "bad-plan-owner", profileId, planId: other.planId, localDay: "2030-01-02", sequence: 1
      }),
      "WORKFLOW_PLAN_PROFILE_MISMATCH",
      "workflow plan does not belong to the selected profile"
    );
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
    assertWorkflowFailure(
      () => workflowStore.createWorkflowRun(db, {
        id: "duplicate-slot", profileId, planId, localDay: "2030-01-02", sequence: 1
      }),
      "WORKFLOW_RUN_SLOT_EXISTS",
      "workflow run slot already exists for this local day"
    );
    assertWorkflowFailure(
      () => workflowStore.transitionWorkflowRun(db, { id: "missing-run", status: "scanning" }),
      "WORKFLOW_RUN_NOT_FOUND",
      "workflow run was not found"
    );
    assertWorkflowFailure(
      () => workflowStore.transitionWorkflowRun(db, { id: run.id, status: "not-a-status" }),
      "WORKFLOW_STATUS_INVALID",
      "workflow run status is invalid"
    );
    assert.equal(workflowStore.transitionWorkflowRun(db, { id: run.id, status: "scanning" }).status, "scanning");
    assertWorkflowFailure(
      () => workflowStore.transitionWorkflowRun(db, { id: run.id, status: "communicating" }),
      "WORKFLOW_TRANSITION_INVALID",
      "workflow run cannot transition from scanning to communicating"
    );
    assertWorkflowFailure(
      () => workflowStore.transitionWorkflowRun(db, {
        id: run.id, status: "scanning", controlState: "invalid-control"
      }),
      "WORKFLOW_CONTROL_INVALID",
      "workflow run control state is invalid"
    );
    assertWorkflowFailure(
      () => workflowStore.transitionWorkflowRun(db, {
        id: run.id, status: "scanning", resumePhase: "review_required"
      }),
      "WORKFLOW_RESUME_PHASE_INVALID",
      "workflow run resume phase is invalid"
    );
    assertWorkflowFailure(
      () => workflowStore.attachWorkflowScan(db, { id: run.id }),
      "WORKFLOW_SCAN_LINK_REQUIRED",
      "scan run and batch are required"
    );
    assertWorkflowFailure(
      () => workflowStore.attachWorkflowScanRun(db, { id: run.id }),
      "WORKFLOW_SCAN_RUN_REQUIRED",
      "scan run is required"
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
    const alternateBatchId = storage.createBatch(db, "boss", "alternate", "workflow store alternate", {
      profileId, searchPlanId: planId
    });
    assertWorkflowFailure(
      () => workflowStore.attachWorkflowScan(db, {
        id: run.id, scanRunId: scanRun.id, scanBatchId: alternateBatchId
      }),
      "WORKFLOW_SCAN_LINK_MISMATCH",
      "workflow run is already attached to another scan"
    );
    assertWorkflowFailure(
      () => workflowStore.attachWorkflowScan(db, {
        id: run.id, scanRunId: "different-active-scan", scanBatchId: batchId
      }),
      "WORKFLOW_SCAN_LINK_MISMATCH",
      "workflow run is already attached to another active scan"
    );

    const runOnly = workflowStore.createWorkflowRun(db, {
      id: "workflow-store-contract-run-only", profileId, planId, localDay: "2030-01-02", sequence: 2,
      targetSuccessCount: 2, inventoryCount: 0, candidateGap: 2
    });
    assertWorkflowFailure(
      () => workflowStore.attachWorkflowScanRun(db, {
        id: runOnly.id, scanRunId: "not-eligible-yet"
      }),
      "WORKFLOW_SCAN_LINK_INVALID",
      "workflow execution can only be attached during scanning, analyzing, or interruption"
    );
    workflowStore.transitionWorkflowRun(db, { id: runOnly.id, status: "scanning" });
    assertWorkflowFailure(
      () => workflowStore.attachWorkflowScanRun(db, {
        id: runOnly.id, scanRunId: scanRun.id
      }),
      "WORKFLOW_SCAN_EXECUTION_OWNED",
      "scan execution is already attached to another workflow run"
    );
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

    const communicationRun = workflowStore.createWorkflowRun(db, {
      id: "workflow-store-contract-communication", profileId, planId, localDay: "2030-01-03", sequence: 1,
      targetSuccessCount: 1, inventoryCount: 1, candidateGap: 0
    });
    assertWorkflowFailure(
      () => workflowStore.attachWorkflowCommunication(db, {
        id: communicationRun.id, communicationBatchId: 1
      }),
      "WORKFLOW_COMMUNICATION_LINK_INVALID",
      "communication can only be attached after review"
    );
    workflowStore.transitionWorkflowRun(db, { id: communicationRun.id, status: "review_required" });
    assertWorkflowFailure(
      () => workflowStore.attachWorkflowCommunication(db, { id: communicationRun.id }),
      "WORKFLOW_COMMUNICATION_LINK_REQUIRED",
      "communication batch is required"
    );
    const otherCommunicationBatchId = seedCommunicationBatch(db, other);
    assertWorkflowFailure(
      () => workflowStore.attachWorkflowCommunication(db, {
        id: communicationRun.id, communicationBatchId: otherCommunicationBatchId
      }),
      "WORKFLOW_COMMUNICATION_LINK_MISMATCH",
      "communication batch does not belong to this workflow run"
    );
    const communicationBatchId = seedCommunicationBatch(db, { profileId, planId });
    workflowStore.attachWorkflowCommunication(db, {
      id: communicationRun.id, communicationBatchId
    });
    assertWorkflowFailure(
      () => workflowStore.attachWorkflowCommunication(db, {
        id: communicationRun.id,
        communicationBatchId: seedCommunicationBatch(db, { profileId, planId })
      }),
      "WORKFLOW_COMMUNICATION_LINK_MISMATCH",
      "workflow run is already attached to another communication batch"
    );
    assert.throws(
      () => workflowStore.listJobAnalysisAttemptRows(db, {
        workflowRunId: run.id, taskId: 0
      }),
      (error) => error instanceof Error
        && error.code === undefined
        && error.message === "listJobAnalysisAttemptRows requires a positive integer taskId, got 0"
    );
  } finally {
    db.close();
  }
}

function contract04DirectHealthSnapshot() {
  const db = storage.openDb(":memory:");
  try {
    const owner = seedPlan(db);
    const other = seedPlan(db);
    const batchId = storage.createBatch(db, "boss", "health", "workflow health contract", {
      profileId: owner.profileId, searchPlanId: owner.planId
    });
    const jobIds = ["health-a", "health-b"].map((sourceId) => storage.upsertJob(db, {
      source: "boss", sourceId, keyword: "health", title: `Health ${sourceId}`,
      company: "Health Company", location: "Guangzhou", salary: "10-15K",
      experience: "1-3 years", education: "Bachelor", bossActiveText: "Active today",
      bossActiveDays: 0, url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
      tags: ["Node.js"], description: "Complete health contract job description. ".repeat(4),
      score: 20, level: "recommended", matches: ["Node.js"], risks: [], qualityTags: [],
      greeting: "", analysis: { semanticStatus: "complete", recommendation: "apply" }
    }, batchId));
    for (const jobId of jobIds) {
      storage.recordCandidateJobEvent(db, {
        profileId: owner.profileId, planId: owner.planId, jobId, eventType: "review", payload: { source: "health-contract" }
      });
    }
    workflowStore.createWorkflowRun(db, {
      id: "health-contract-older", profileId: owner.profileId, planId: owner.planId,
      localDay: "2030-01-01", sequence: 1, targetSuccessCount: 2, inventoryCount: 2, candidateGap: 0
    });
    workflowStore.createWorkflowRun(db, {
      id: "health-contract-linked", profileId: owner.profileId, planId: owner.planId,
      localDay: "2030-01-02", sequence: 1, targetSuccessCount: 2, inventoryCount: 2, candidateGap: 0
    });
    const otherBatchId = storage.createBatch(db, "boss", "other", "workflow health mismatch", {
      profileId: other.profileId, searchPlanId: other.planId
    });
    const otherScan = storage.createScanRun(db, {
      runId: "health-contract-other-scan", planId: other.planId, batchId: otherBatchId
    });
    const otherCommunicationBatchId = seedCommunicationBatch(db, other);
    db.prepare(`UPDATE workflow_runs
      SET scan_run_id = ?, scan_batch_id = ?, communication_batch_id = ?
      WHERE id = ?`).run(otherScan.id, otherBatchId, otherCommunicationBatchId, "health-contract-linked");

    const rowsBefore = databaseRows(db);
    const changesBefore = db.prepare("SELECT total_changes() AS count").get().count;
    const snapshot = storage.getWorkflowHealthSnapshot(db, {
      profileId: owner.profileId, planId: owner.planId, now: "2030-01-02T12:00:00.000Z",
      jobLimit: 1, workflowLimit: 1, eventLimit: 1
    });

    assert.deepEqual(Object.keys(snapshot).sort(), [
      "candidateEvents", "generatedAt", "jobs", "linkIssues", "planId", "profileId",
      "truncated", "workflowRuns"
    ]);
    assert.equal(snapshot.generatedAt.toISOString(), "2030-01-02T12:00:00.000Z");
    assert.equal(snapshot.profileId, owner.profileId);
    assert.equal(snapshot.planId, owner.planId);
    assert.equal(snapshot.jobs.length, 1);
    assert.equal(snapshot.workflowRuns.length, 1);
    assert.equal(snapshot.candidateEvents.length, 1);
    assert.deepEqual(snapshot.truncated, { jobs: true, workflowRuns: true, candidateEvents: true });
    assert.deepEqual(snapshot.linkIssues, [
      { workflowId: "health-contract-linked", reason: "scan_plan_mismatch" },
      { workflowId: "health-contract-linked", reason: "scan_batch_owner_mismatch" },
      { workflowId: "health-contract-linked", reason: "communication_batch_owner_mismatch" }
    ]);
    assert.deepEqual(Object.keys(snapshot.jobs[0]).sort(), [
      "activityObservedAt", "analysis", "applicationNote", "applicationReasonCode", "applicationStatus",
      "applicationUpdatedAt", "batchId", "bossActiveDays", "bossActiveText", "company",
      "daysSinceLastSeen", "decisionBucket", "description", "detailChanged", "education",
      "effectiveBossActiveDays", "experience", "feedback", "feedbackRank", "firstBatchId",
      "firstSeenAt", "followUpNote", "followUpUpdatedAt", "greeting", "id", "keyword",
      "lastSeenAt", "latestScanBatchId", "level", "location", "matches", "observationId",
      "previousContentHash", "profileId", "qualityTags", "refreshAttemptNumber",
      "refreshAttemptedAt", "refreshErrorCode", "refreshNextRetryAt", "refreshResult", "reviewAt",
      "risks", "salary", "score", "searchPlanId", "source", "sourceId", "tags", "title", "url",
      "weakDuplicateCount"
    ].sort());
    assert.deepEqual(Object.keys(snapshot.workflowRuns[0]).sort(), [
      "budget", "candidateGap", "circuitTimeoutJobCount", "communicationBatchId", "controlState", "createdAt",
      "errorCode", "errorMessage", "finishedAt", "id", "inventoryCount", "keywords", "lastActivityAt",
      "lifetimeTimeoutJobCount", "localDay", "metrics", "modelConfigRevision", "planId", "planner",
      "platformAccessStartedAt", "profileId", "progressRevision", "recoveryGeneration", "resumePhase",
      "reviewReadyAt", "scanBatchId", "scanNeeded", "scanRunId", "sequence", "shortfallCode", "startedAt",
      "status", "successfulCount", "targetSuccessCount", "updatedAt"
    ]);
    assert.deepEqual(Object.keys(snapshot.candidateEvents[0]).sort(), [
      "createdAt", "eventType", "id", "jobId", "payload", "planId", "profileId"
    ]);
    assert.deepEqual(Object.keys(snapshot.linkIssues[0]).sort(), ["reason", "workflowId"]);
    assert.equal(db.prepare("SELECT total_changes() AS count").get().count, changesBefore);
    assert.deepEqual(databaseRows(db), rowsBefore, "health snapshot must preserve every database row");
  } finally {
    db.close();
  }
}

function contract05RegressionChildren() {
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

function seedCommunicationBatch(db, { profileId, planId }) {
  const now = "2030-01-02T00:00:00.000Z";
  return Number(db.prepare(`INSERT INTO communication_batches(
    site, profile_id, plan_id, browser_mode, status, policy_json,
    confirmed_at, created_at, updated_at
  ) VALUES ('boss', ?, ?, 'edge', 'confirmed', '{}', ?, ?, ?)`)
    .run(profileId, planId, now, now, now).lastInsertRowid);
}

function databaseRows(db) {
  return Object.fromEntries(db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(({ name }) => [
    name,
    db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()
  ]));
}

function assertWorkflowFailure(action, code, message) {
  assert.throws(
    action,
    (error) => error.code === code && error.message === message,
    `${code} must retain its exact message`
  );
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
