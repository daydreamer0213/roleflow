"use strict";

const assert = require("node:assert/strict");
const { PRODUCT_POLICY } = require("../src/core/product_policy");
const {
  openDb,
  createBatch,
  createScanRun,
  createWorkflowRun,
  attachWorkflowScan,
  transitionWorkflowRun,
  upsertJob,
  getWorkflowRun
} = require("../src/core/storage");
const {
  initializeWorkflowJobTasks,
  claimWorkflowJobTask,
  commitWorkflowJobTaskFailure,
  listWorkflowJobTasks,
  listJobAnalysisAttempts
} = require("../src/core/workflow_analysis_tasks");
const {
  WORKFLOW_ANALYSIS_ERROR_KINDS,
  classifyWorkflowAnalysisError,
  createAttemptTelemetry,
  createAttemptTelemetryLogger,
  selectAttemptRuntime,
  runWorkflowAnalysis
} = require("../src/core/workflow_analysis_executor");

(async () => {
  try {
  testErrorKindConstants();
  testRetryableCodeMapping();
  testHttpStatusMapping();
  testStableCodeTakesPriorityOverHttpStatus();
  testBareAuthHttpStatusMapsToConfiguration();
  testConfigurationPauseMapping();
  testTerminalAndLocalInputMapping();
  testControlledStopMapping();
  testClassificationNeverReturnsRawMessage();
  testAttemptTelemetryInitialState();
  testTelemetryAggregatesCompletedCallsOnly();
  testTelemetryIgnoresUnrelatedEventsAndFields();
  testTelemetryForwardsEveryEvent();
  testTelemetryForwardingRedactsSensitiveFields();
  testTelemetryChildSharesAccumulator();
  testPrimaryBackupSelection();
  testSelectionDoesNotMutatePrimaryRuntime();
  testProductPolicyModelAnalysisFixedValues();
  await testRunWorkflowAnalysisPrimarySuccessNeverConstructsBackup();
  await testRunWorkflowAnalysisRetryUsesPrimaryOrVerifiedBackup();
  await testRunWorkflowAnalysisWorkflowFatalPreservesIncrementalResults();
  await testRunWorkflowAnalysisPersistsTelemetryOnAttempt();
  await testRunWorkflowAnalysisTwoWorkersClaimDistinctTasks();
  await testRunWorkflowAnalysisRetryCooldownCannotBeBypassed();
  await testRunWorkflowAnalysisConfigurationPauseStopsClaiming();
  await testRunWorkflowAnalysisQueueDrainedCounts();
  await testRunWorkflowAnalysisNineFinalTimeoutsStayAnalyzing();
  await testRunWorkflowAnalysisTenthFinalTimeoutOpensCircuitWithSibling();
  await testRunWorkflowAnalysisPauseRequestedFinalizesPaused();
  await testRunWorkflowAnalysisStopRequestedFinalizesStopped();
  await testRunWorkflowAnalysisStopBeforeStartMarksAllStopped();
  await testRunWorkflowAnalysisAbortsBetweenAttemptsWithoutReview();
  await testControlledStopMidAttemptPreservesRunningTask();
  await testRunWorkflowAnalysisWaitsForFutureRetryNotFalseDrained();
  await testRunWorkflowAnalysisRejectsNonAnalyzingOrMissingRun();
  testAttemptLoggerChildAndUnknownKeysRedacted();
  console.log("workflow_analysis_executor_smoke ok");
} catch (error) {
  console.error(error);
  process.exit(1);
}
})();

function testErrorKindConstants() {
  assert.deepStrictEqual(WORKFLOW_ANALYSIS_ERROR_KINDS, {
    RETRYABLE: "retryable",
    CONFIGURATION: "configuration",
    TERMINAL: "terminal",
    CONTROLLED_STOP: "controlled_stop"
  });
  assert(Object.isFrozen(WORKFLOW_ANALYSIS_ERROR_KINDS));
}

function testRetryableCodeMapping() {
  for (const code of [
    "MODEL_TIMEOUT",
    "MODEL_CONNECTION_FAILED",
    "MODEL_RATE_LIMITED",
    "MODEL_UPSTREAM_UNAVAILABLE"
  ]) {
    const result = classifyWorkflowAnalysisError(Object.assign(new Error("boom"), { code }));
    assert.strictEqual(result.kind, WORKFLOW_ANALYSIS_ERROR_KINDS.RETRYABLE, code);
    assert.strictEqual(result.code, code, code);
    assert.strictEqual(result.retryable, true, code);
    assert.strictEqual(result.pauseCode, null, code);
  }
  const httpCoded = classifyWorkflowAnalysisError(Object.assign(new Error("429"), { code: "HTTP_429" }));
  assert.strictEqual(httpCoded.kind, WORKFLOW_ANALYSIS_ERROR_KINDS.RETRYABLE);
  assert.strictEqual(httpCoded.code, "HTTP_429");
  assert.strictEqual(httpCoded.retryable, true);
}

function testHttpStatusMapping() {
  for (const status of [429, 500, 502, 503, 599]) {
    const result = classifyWorkflowAnalysisError(Object.assign(new Error(`status ${status}`), { status }));
    assert.strictEqual(result.kind, WORKFLOW_ANALYSIS_ERROR_KINDS.RETRYABLE, `status ${status}`);
    assert.strictEqual(result.code, `HTTP_${status}`, `status ${status}`);
    assert.strictEqual(result.retryable, true, `status ${status}`);
  }
  const statusCode = classifyWorkflowAnalysisError(Object.assign(new Error("503"), { statusCode: 503 }));
  assert.strictEqual(statusCode.code, "HTTP_503");
  const httpStatus = classifyWorkflowAnalysisError(Object.assign(new Error("502"), { httpStatus: 502 }));
  assert.strictEqual(httpStatus.code, "HTTP_502");
  const codedWins = classifyWorkflowAnalysisError(Object.assign(new Error("500"), { code: "HTTP_500", status: 500 }));
  assert.strictEqual(codedWins.code, "HTTP_500");
  assert.strictEqual(classifyWorkflowAnalysisError(Object.assign(new Error("404"), { status: 404 })).kind,
    WORKFLOW_ANALYSIS_ERROR_KINDS.TERMINAL);
  assert.strictEqual(classifyWorkflowAnalysisError(Object.assign(new Error("400"), { status: 400 })).retryable, false);
}

function testStableCodeTakesPriorityOverHttpStatus() {
  const contract = classifyWorkflowAnalysisError(Object.assign(new Error("contract"), { code: "MODEL_CONTRACT_INVALID", status: 500 }));
  assert.strictEqual(contract.kind, WORKFLOW_ANALYSIS_ERROR_KINDS.TERMINAL);
  assert.strictEqual(contract.code, "MODEL_CONTRACT_INVALID");
  assert.strictEqual(contract.retryable, false);

  const auth = classifyWorkflowAnalysisError(Object.assign(new Error("auth"), { code: "MODEL_AUTH_FAILED", status: 500 }));
  assert.strictEqual(auth.kind, WORKFLOW_ANALYSIS_ERROR_KINDS.CONFIGURATION);
  assert.strictEqual(auth.code, "MODEL_AUTH_FAILED");
  assert.strictEqual(auth.pauseCode, "MODEL_AUTH_REQUIRED");

  const aborted = classifyWorkflowAnalysisError(Object.assign(new Error("aborted"), { code: "SCAN_ABORTED", status: 500 }));
  assert.strictEqual(aborted.kind, WORKFLOW_ANALYSIS_ERROR_KINDS.CONTROLLED_STOP);
  assert.strictEqual(aborted.code, "SCAN_ABORTED");

  const timeout = classifyWorkflowAnalysisError(Object.assign(new Error("timeout"), { code: "MODEL_TIMEOUT", status: 500 }));
  assert.strictEqual(timeout.kind, WORKFLOW_ANALYSIS_ERROR_KINDS.RETRYABLE);
  assert.strictEqual(timeout.code, "MODEL_TIMEOUT");

  const unknown = classifyWorkflowAnalysisError(Object.assign(new Error("unknown"), { code: "SOME_UNKNOWN_CODE", status: 500 }));
  assert.strictEqual(unknown.kind, WORKFLOW_ANALYSIS_ERROR_KINDS.RETRYABLE);
  assert.strictEqual(unknown.code, "HTTP_500");
  assert.strictEqual(unknown.retryable, true);
}

function testBareAuthHttpStatusMapsToConfiguration() {
  for (const status of [401, 403]) {
    for (const field of ["status", "statusCode", "httpStatus"]) {
      const result = classifyWorkflowAnalysisError(Object.assign(new Error("auth"), { [field]: status }));
      assert.strictEqual(result.kind, WORKFLOW_ANALYSIS_ERROR_KINDS.CONFIGURATION, `${field}=${status}`);
      assert.strictEqual(result.code, "MODEL_AUTH_FAILED", `${field}=${status}`);
      assert.strictEqual(result.pauseCode, "MODEL_AUTH_REQUIRED", `${field}=${status}`);
      assert.strictEqual(result.retryable, false, `${field}=${status}`);
    }
  }
}

function testConfigurationPauseMapping() {
  const authPairs = [
    ["MODEL_KEY_REQUIRED", "MODEL_AUTH_REQUIRED"],
    ["MODEL_AUTH_FAILED", "MODEL_AUTH_REQUIRED"]
  ];
  for (const [code, pauseCode] of authPairs) {
    const result = classifyWorkflowAnalysisError(Object.assign(new Error("auth"), { code }));
    assert.strictEqual(result.kind, WORKFLOW_ANALYSIS_ERROR_KINDS.CONFIGURATION, code);
    assert.strictEqual(result.code, code, code);
    assert.strictEqual(result.retryable, false, code);
    assert.strictEqual(result.pauseCode, pauseCode, code);
  }
  const configPairs = [
    ["MODEL_ENDPOINT_OR_MODEL_NOT_FOUND", "MODEL_CONFIGURATION_REQUIRED"],
    ["MODEL_CONFIGURATION_REQUIRED", "MODEL_CONFIGURATION_REQUIRED"]
  ];
  for (const [code, pauseCode] of configPairs) {
    const result = classifyWorkflowAnalysisError(Object.assign(new Error("config"), { code }));
    assert.strictEqual(result.kind, WORKFLOW_ANALYSIS_ERROR_KINDS.CONFIGURATION, code);
    assert.strictEqual(result.code, code, code);
    assert.strictEqual(result.retryable, false, code);
    assert.strictEqual(result.pauseCode, pauseCode, code);
  }
}

function testTerminalAndLocalInputMapping() {
  for (const code of ["MODEL_CONTRACT_INVALID", "LOCAL_INPUT_INVALID", "CANDIDATE_PROFILE_REQUIRED"]) {
    const result = classifyWorkflowAnalysisError(Object.assign(new Error("terminal"), { code }));
    assert.strictEqual(result.kind, WORKFLOW_ANALYSIS_ERROR_KINDS.TERMINAL, code);
    assert.strictEqual(result.code, code, code);
    assert.strictEqual(result.retryable, false, code);
    assert.strictEqual(result.pauseCode, null, code);
  }
  const unknown = classifyWorkflowAnalysisError(new Error("unknown failure"));
  assert.strictEqual(unknown.kind, WORKFLOW_ANALYSIS_ERROR_KINDS.TERMINAL);
  assert.strictEqual(unknown.retryable, false);
  assert.strictEqual(unknown.pauseCode, null);
}

function testControlledStopMapping() {
  const result = classifyWorkflowAnalysisError(Object.assign(new Error("aborted"), { code: "SCAN_ABORTED" }));
  assert.strictEqual(result.kind, WORKFLOW_ANALYSIS_ERROR_KINDS.CONTROLLED_STOP);
  assert.strictEqual(result.code, "SCAN_ABORTED");
  assert.strictEqual(result.retryable, false);
  assert.strictEqual(result.pauseCode, null);
}

function testClassificationNeverReturnsRawMessage() {
  const error = Object.assign(new Error("raw secret input payload must never be persisted"), {
    code: "MODEL_TIMEOUT",
    input: { resume: "private resume" },
    output: { recommendation: "apply" }
  });
  const result = classifyWorkflowAnalysisError(error);
  assert.deepStrictEqual(Object.keys(result).sort(), ["code", "kind", "pauseCode", "retryable"]);
  assert(!("message" in result));
  assert(!("input" in result));
  assert(!("output" in result));
  assert(!JSON.stringify(result).includes("secret"));
}

function testAttemptTelemetryInitialState() {
  assert.deepStrictEqual(createAttemptTelemetry(), {
    modelCallCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  });
}

function testTelemetryAggregatesCompletedCallsOnly() {
  const telemetry = createAttemptTelemetry();
  const logger = createAttemptTelemetryLogger({ info: () => {} }, telemetry);
  logger.info("model_call_completed", {
    attempts: 2,
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  });
  logger.info("model_call_completed", {
    attempts: 1,
    usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 }
  });
  logger.info("model_call_completed", { attempts: 0, usage: null });
  assert.deepStrictEqual(telemetry, {
    modelCallCount: 3,
    promptTokens: 150,
    completionTokens: 25,
    totalTokens: 175
  });
}

function testTelemetryIgnoresUnrelatedEventsAndFields() {
  const telemetry = createAttemptTelemetry();
  const logger = createAttemptTelemetryLogger({ info: () => {}, warn: () => {}, error: () => {} }, telemetry);
  logger.info("model_call_completed", {
    attempts: "abc",
    usage: { prompt_tokens: -5, completion_tokens: NaN, total_tokens: Infinity }
  });
  logger.info("model_call_completed", { attempts: -1, usage: { prompt_tokens: 10 } });
  logger.info("model_call_completed", { attempts: 1, usage: { prompt_tokens: 10, completion_tokens: "2", total_tokens: 12 } });
  logger.info("model_call_started", { attempts: 99, usage: { prompt_tokens: 999, completion_tokens: 999, total_tokens: 999 } });
  logger.warn("model_call_failed", { attempts: 5, errorMessage: "boom", usage: { prompt_tokens: 50 } });
  logger.info("job_analysis_failed", { input: "raw", output: "raw", message: "raw", usage: { prompt_tokens: 70 } });
  assert.deepStrictEqual(telemetry, {
    modelCallCount: 1,
    promptTokens: 20,
    completionTokens: 2,
    totalTokens: 12
  });
}

function testTelemetryForwardsEveryEvent() {
  const forwarded = [];
  const base = {
    info: (event, data) => forwarded.push({ level: "info", event, data }),
    warn: (event, data) => forwarded.push({ level: "warn", event, data }),
    error: (event, data) => forwarded.push({ level: "error", event, data })
  };
  const telemetry = createAttemptTelemetry();
  const logger = createAttemptTelemetryLogger(base, telemetry);
  const completed = {
    attempts: 1,
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    input: "raw resume input",
    output: "raw model output"
  };
  const failed = { errorMessage: "boom secret", attempts: 7, httpStatus: 500, kind: "matchJob", stage: "analyze" };
  logger.info("model_call_completed", completed);
  logger.warn("model_call_failed", failed);
  logger.error("executor_worker_crashed", { message: "unexpected raw stack", stage: "execute" });
  assert.strictEqual(forwarded.length, 3);
  assert.strictEqual(forwarded[0].event, "model_call_completed");
  assert.strictEqual(forwarded[0].data.attempts, 1);
  assert.deepStrictEqual(forwarded[0].data.usage, { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
  assert.strictEqual(forwarded[0].data.input, "[REDACTED]");
  assert.strictEqual(forwarded[0].data.output, "[REDACTED]");
  assert.strictEqual(forwarded[1].event, "model_call_failed");
  assert.strictEqual(forwarded[1].data.errorMessage, "[REDACTED]");
  assert.strictEqual(forwarded[1].data.attempts, 7);
  assert.strictEqual(forwarded[1].data.httpStatus, 500);
  assert.strictEqual(forwarded[1].data.kind, "matchJob");
  assert.strictEqual(forwarded[1].data.stage, "analyze");
  assert.strictEqual(forwarded[2].event, "executor_worker_crashed");
  assert.strictEqual(forwarded[2].data.message, "[REDACTED]");
  assert.strictEqual(forwarded[2].data.stage, "execute");
  assert(!JSON.stringify(forwarded).includes("raw resume input"));
  assert(!JSON.stringify(forwarded).includes("raw model output"));
  assert(!JSON.stringify(forwarded).includes("boom secret"));
  assert(!JSON.stringify(forwarded).includes("unexpected raw stack"));
  assert.deepStrictEqual(telemetry, {
    modelCallCount: 1,
    promptTokens: 3,
    completionTokens: 1,
    totalTokens: 4
  });

  const silent = createAttemptTelemetryLogger(null, createAttemptTelemetry());
  silent.info("model_call_completed", { attempts: 4, usage: { prompt_tokens: 9 } });
}

function testTelemetryForwardingRedactsSensitiveFields() {
  const forwarded = [];
  const base = {
    info: (event, data) => forwarded.push(data),
    warn: () => {},
    error: () => {}
  };
  const telemetry = createAttemptTelemetry();
  const logger = createAttemptTelemetryLogger(base, telemetry);
  logger.info("model_call_completed", {
    type: "metric",
    kind: "understandJob",
    stage: "analyze",
    attempts: 2,
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    provider: "openai_compatible",
    model: "deepseek-v4-flash",
    httpStatus: 200,
    latencyMs: 150,
    time: "2026-08-06T00:00:00.000Z",
    errorCode: "MODEL_TIMEOUT",
    input: { resume: "private resume" },
    output: { analysis: "private output" },
    prompt: "private prompt",
    resume: "private resume text",
    raw: { response: "private response" },
    request: { body: "private body" },
    response: "private response text",
    errorMessage: "private error"
  });
  assert.strictEqual(forwarded.length, 1);
  const safe = forwarded[0];
  assert.strictEqual(safe.type, "metric");
  assert.strictEqual(safe.kind, "understandJob");
  assert.strictEqual(safe.stage, "analyze");
  assert.strictEqual(safe.attempts, 2);
  assert.deepStrictEqual(safe.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  assert.strictEqual(safe.provider, "openai_compatible");
  assert.strictEqual(safe.model, "deepseek-v4-flash");
  assert.strictEqual(safe.httpStatus, 200);
  assert.strictEqual(safe.latencyMs, 150);
  assert.strictEqual(safe.time, "2026-08-06T00:00:00.000Z");
  assert.strictEqual(safe.errorCode, "MODEL_TIMEOUT");
  for (const key of ["input", "output", "prompt", "resume", "raw", "request", "response", "errorMessage"]) {
    assert.strictEqual(safe[key], "[REDACTED]", key);
  }
  const serialized = JSON.stringify(forwarded);
  assert(!serialized.includes("private"), serialized);
}

function testTelemetryChildSharesAccumulator() {
  const children = [];
  const base = {
    info: () => {},
    child: (context) => {
      children.push(context);
      return { info: (event, data) => base.info(event, data), warn: () => {}, error: () => {} };
    }
  };
  const telemetry = createAttemptTelemetry();
  const logger = createAttemptTelemetryLogger(base, telemetry);
  const child = logger.child({ taskId: 7 });
  child.info("model_call_completed", { attempts: 2, usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
  assert.deepStrictEqual(children, [{ taskId: 7 }]);
  assert.deepStrictEqual(telemetry, {
    modelCallCount: 2,
    promptTokens: 10,
    completionTokens: 3,
    totalTokens: 13
  });
}

function testPrimaryBackupSelection() {
  const primary = primaryRuntime();
  const verifiedBackup = {
    ...backupRuntime(),
    connection: { status: "verified" }
  };
  const first = selectAttemptRuntime({ attemptInGeneration: 1, primaryRuntime: primary, backupRuntime: verifiedBackup });
  assert.strictEqual(first.runtime, primary);
  assert.strictEqual(first.identity.backupUsed, 0);
  assert.strictEqual(first.identity.provider, "openai_compatible");
  assert.strictEqual(first.identity.model, "deepseek-v4-flash");
  assert.strictEqual(first.identity.modelConfigRevision, "primary-rev-1");
  assert.strictEqual(first.identity.thinkingMode, "disabled");
  assert.strictEqual(first.identity.reasoningEffort, "high");

  const second = selectAttemptRuntime({ attemptInGeneration: 2, primaryRuntime: primary, backupRuntime: verifiedBackup });
  assert.strictEqual(second.runtime, verifiedBackup);
  assert.strictEqual(second.identity.backupUsed, 1);
  assert.strictEqual(second.identity.provider, "openai_compatible");
  assert.strictEqual(second.identity.model, "backup-model");
  assert.strictEqual(second.identity.modelConfigRevision, "backup-rev-1");
  assert.strictEqual(second.identity.thinkingMode, "enabled");
  assert.strictEqual(second.identity.reasoningEffort, "max");

  const noBackup = selectAttemptRuntime({ attemptInGeneration: 2, primaryRuntime: primary, backupRuntime: null });
  assert.strictEqual(noBackup.runtime, primary);
  assert.strictEqual(noBackup.identity.backupUsed, 0);
  assert.strictEqual(noBackup.identity.model, "deepseek-v4-flash");

  const unverified = {
    ...backupRuntime(),
    connection: { status: "unverified" }
  };
  assert.strictEqual(
    selectAttemptRuntime({ attemptInGeneration: 2, primaryRuntime: primary, backupRuntime: unverified }).runtime,
    primary
  );
  const disabled = { ...backupRuntime(), enabled: false };
  assert.strictEqual(
    selectAttemptRuntime({ attemptInGeneration: 2, primaryRuntime: primary, backupRuntime: disabled }).runtime,
    primary
  );
  assert.strictEqual(
    selectAttemptRuntime({ attemptInGeneration: undefined, primaryRuntime: primary, backupRuntime: verifiedBackup }).runtime,
    primary
  );
}

function testSelectionDoesNotMutatePrimaryRuntime() {
  const primary = deepFreeze(primaryRuntime());
  const backup = deepFreeze({
    ...backupRuntime(),
    connection: { status: "verified" }
  });
  const before = JSON.parse(JSON.stringify(primary));
  selectAttemptRuntime({ attemptInGeneration: 2, primaryRuntime: primary, backupRuntime: backup });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(primary)), before);
}

function testProductPolicyModelAnalysisFixedValues() {
  assert.deepStrictEqual(PRODUCT_POLICY.operations.modelAnalysis, {
    scanConcurrency: 2,
    retryConcurrency: 2,
    maxRetryJobs: 50,
    maxAttemptsPerGeneration: 2,
    timeoutCircuitThreshold: 10,
    taskLeaseTtlMs: 180000,
    retryBackoffMs: [1000, 3000],
    etaSampleMinimum: 3,
    etaSampleLimit: 10
  });
  assert(Object.isFrozen(PRODUCT_POLICY.operations.modelAnalysis));
  assert(Object.isFrozen(PRODUCT_POLICY.operations.modelAnalysis.retryBackoffMs));
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

function backupRuntime() {
  return {
    revision: "backup-rev-1",
    concurrency: 1,
    modelConfig: {
      provider: "openai_compatible",
      providers: {
        openai_compatible: {
          model: "backup-model",
          thinkingMode: "enabled",
          reasoningEffort: "max"
        }
      }
    }
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

async function testRunWorkflowAnalysisPrimarySuccessNeverConstructsBackup() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: [{ semanticStatus: "pending", decisionSource: "scan" }],
      localDay: "2026-08-20",
      modelConfigRevision: "exec-primary"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-primary",
      now: "2026-08-20T00:00:00.000Z"
    });
    const constructed = [];
    const calls = [];
    const result = await runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: primaryRuntime(),
      backupRuntime: { ...backupRuntime(), connection: { status: "verified" } },
      createAnalyzeJob: (runtime) => {
        constructed.push(runtime.revision);
        return async (job) => {
          calls.push(runtime.revision);
          return analyzedJob(job);
        };
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: fixedClock("2026-08-20T00:05:00.000Z"),
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    assert.deepStrictEqual(constructed, ["primary-rev-1"]);
    assert.deepStrictEqual(calls, ["primary-rev-1"]);
    assert.deepStrictEqual(result, {
      status: "drained",
      claimed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0
    });
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].status, "succeeded");
    const attempts = listJobAnalysisAttempts(db, {
      workflowRunId: scenario.workflowId,
      taskId: tasks[0].id
    });
    assert.strictEqual(attempts.length, 1);
    assert.strictEqual(attempts[0].status, "succeeded");
    assert.strictEqual(attempts[0].backupUsed, 0);
    assert.strictEqual(attempts[0].modelConfigRevision, "primary-rev-1");
  } finally {
    db.close();
  }
}

async function testRunWorkflowAnalysisRetryUsesPrimaryOrVerifiedBackup() {
  await retryScenario({
    label: "backup-disabled-uses-primary",
    localDay: "2026-08-21",
    backupRuntime: { ...backupRuntime(), enabled: false },
    expectedConstructed: ["primary-rev-1", "primary-rev-1"],
    expectedBackupUsed: [0, 0]
  });
  await retryScenario({
    label: "verified-backup-used-on-attempt-two",
    localDay: "2026-08-22",
    backupRuntime: { ...backupRuntime(), connection: { status: "verified" } },
    expectedConstructed: ["primary-rev-1", "backup-rev-1"],
    expectedBackupUsed: [0, 1]
  });
}

async function retryScenario({
  label,
  localDay,
  backupRuntime: scenarioBackup,
  expectedConstructed,
  expectedBackupUsed
}) {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: [{ semanticStatus: "pending", decisionSource: "scan" }],
      localDay,
      modelConfigRevision: `exec-${label}`
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: `exec-${label}`,
      now: `${localDay}T00:00:00.000Z`
    });
    const constructed = [];
    const clock = fakeClock(`${localDay}T00:00:00.000Z`);
    let attempt = 0;
    const result = await runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: primaryRuntime(),
      backupRuntime: scenarioBackup,
      createAnalyzeJob: (runtime) => {
        constructed.push(runtime.revision);
        return async (job) => {
          attempt += 1;
          if (attempt === 1) {
            throw Object.assign(new Error("model timeout"), { code: "MODEL_TIMEOUT" });
          }
          return analyzedJob(job);
        };
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: clock.now,
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [1000, 3000],
      random: () => 0,
      sleep: async (ms) => clock.advance(ms)
    });
    assert.deepStrictEqual(constructed, expectedConstructed, label);
    assert.deepStrictEqual(result, {
      status: "drained",
      claimed: 2,
      succeeded: 1,
      failed: 1,
      skipped: 0
    }, label);
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.strictEqual(tasks.length, 1, label);
    assert.strictEqual(tasks[0].status, "succeeded", label);
    const attempts = listJobAnalysisAttempts(db, {
      workflowRunId: scenario.workflowId,
      taskId: tasks[0].id
    });
    assert.strictEqual(attempts.length, 2, label);
    assert.deepStrictEqual(attempts.map((attemptRow) => attemptRow.backupUsed), expectedBackupUsed, label);
    assert.strictEqual(attempts[0].status, "failed", label);
    assert.strictEqual(attempts[0].errorCode, "MODEL_TIMEOUT", label);
    assert.strictEqual(attempts[1].status, "succeeded", label);
  } finally {
    db.close();
  }
}

async function testRunWorkflowAnalysisWorkflowFatalPreservesIncrementalResults() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: [{}, {}, {}],
      localDay: "2026-08-23",
      modelConfigRevision: "exec-fatal"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-fatal",
      now: "2026-08-23T00:00:00.000Z"
    });
    let callIndex = 0;
    const result = await runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: { ...primaryRuntime(), concurrency: 1 },
      backupRuntime: null,
      createAnalyzeJob: () => async (job) => {
        callIndex += 1;
        if (callIndex === 2) {
          throw Object.assign(new Error("executor crashed"), {
            code: "WORKFLOW_EXECUTOR_CRASH",
            stage: "execute"
          });
        }
        return analyzedJob(job);
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: fixedClock("2026-08-23T00:05:00.000Z"),
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    assert.strictEqual(result.status, "interrupted");
    assert.deepStrictEqual(
      {
        claimed: result.claimed,
        succeeded: result.succeeded,
        failed: result.failed,
        skipped: result.skipped
      },
      { claimed: 2, succeeded: 1, failed: 0, skipped: 0 }
    );
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.strictEqual(tasks.length, 3);
    assert.strictEqual(tasks[0].status, "succeeded");
    const savedObservation = db.prepare(
      "SELECT analysis_json FROM job_observations WHERE job_id = ?"
    ).get(scenario.jobIds[0]);
    assert.strictEqual(JSON.parse(savedObservation.analysis_json).semanticStatus, "complete");
    assert.strictEqual(tasks[1].status, "running");
    assert(tasks[1].leaseOwner);
    assert(tasks[1].leaseExpiresAt);
    assert.strictEqual(tasks[2].status, "pending");
    assert.strictEqual(getWorkflowRun(db, scenario.workflowId).status, "interrupted");
  } finally {
    db.close();
  }
}

async function testRunWorkflowAnalysisPersistsTelemetryOnAttempt() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: [{ semanticStatus: "pending", decisionSource: "scan" }],
      localDay: "2026-08-24",
      modelConfigRevision: "exec-telemetry"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-telemetry",
      now: "2026-08-24T00:00:00.000Z"
    });
    const result = await runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: { ...primaryRuntime(), concurrency: 1 },
      backupRuntime: null,
      createAnalyzeJob: (_runtime, { logger }) => async (job) => {
        logger.info("model_call_completed", {
          attempts: 2,
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
        });
        return analyzedJob(job);
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: fixedClock("2026-08-24T00:05:00.000Z"),
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    assert.deepStrictEqual(result, {
      status: "drained",
      claimed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0
    });
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    const attempts = listJobAnalysisAttempts(db, {
      workflowRunId: scenario.workflowId,
      taskId: tasks[0].id
    });
    assert.strictEqual(attempts.length, 1);
    assert.strictEqual(attempts[0].status, "succeeded");
    assert.strictEqual(attempts[0].modelCallCount, 2);
    assert.strictEqual(attempts[0].promptTokens, 10);
    assert.strictEqual(attempts[0].completionTokens, 3);
    assert.strictEqual(attempts[0].totalTokens, 13);
  } finally {
    db.close();
  }
}

async function testRunWorkflowAnalysisTwoWorkersClaimDistinctTasks() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: [{}, {}],
      localDay: "2026-08-25",
      modelConfigRevision: "exec-two-workers"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-two-workers",
      now: "2026-08-25T00:00:00.000Z"
    });
    const analyzedSourceIds = [];
    const result = await runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: { ...primaryRuntime(), concurrency: 2 },
      backupRuntime: null,
      createAnalyzeJob: () => async (job) => {
        analyzedSourceIds.push(job.sourceId);
        return analyzedJob(job);
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: fixedClock("2026-08-25T00:05:00.000Z"),
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    assert.deepStrictEqual(result, {
      status: "drained",
      claimed: 2,
      succeeded: 2,
      failed: 0,
      skipped: 0
    });
    assert.strictEqual(analyzedSourceIds.length, 2);
    assert.strictEqual(new Set(analyzedSourceIds).size, 2);
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.strictEqual(tasks.length, 2);
    assert.deepStrictEqual(tasks.map((task) => task.status), ["succeeded", "succeeded"]);
    for (const task of tasks) {
      const attempts = listJobAnalysisAttempts(db, {
        workflowRunId: scenario.workflowId,
        taskId: task.id
      });
      assert.strictEqual(attempts.length, 1);
    }
  } finally {
    db.close();
  }
}

async function testRunWorkflowAnalysisRetryCooldownCannotBeBypassed() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: [{ semanticStatus: "pending", decisionSource: "scan" }],
      localDay: "2026-08-26",
      modelConfigRevision: "exec-cooldown"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-cooldown",
      now: "2026-08-26T00:00:00.000Z"
    });
    const clock = fakeClock("2026-08-26T00:00:00.000Z");
    let calls = 0;
    const result = await runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: { ...primaryRuntime(), concurrency: 1 },
      backupRuntime: null,
      createAnalyzeJob: () => async (job) => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("timeout"), { code: "MODEL_TIMEOUT" });
        }
        return analyzedJob(job);
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: clock.now,
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [1000, 3000],
      random: () => 0,
      sleep: async (ms) => clock.advance(ms)
    });
    assert.deepStrictEqual(result, {
      status: "drained",
      claimed: 2,
      succeeded: 1,
      failed: 1,
      skipped: 0
    });
    assert.strictEqual(calls, 2);
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.strictEqual(tasks[0].status, "succeeded");
    assert.strictEqual(tasks[0].attemptCountInGeneration, 2);
    assert.strictEqual(tasks[0].totalAttemptCount, 2);
  } finally {
    db.close();
  }
}

async function testRunWorkflowAnalysisConfigurationPauseStopsClaiming() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: [{}, {}, {}],
      localDay: "2026-08-27",
      modelConfigRevision: "exec-config-pause"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-config-pause",
      now: "2026-08-27T00:00:00.000Z"
    });
    let calls = 0;
    const result = await runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: { ...primaryRuntime(), concurrency: 1 },
      backupRuntime: { ...backupRuntime(), connection: { status: "verified" } },
      createAnalyzeJob: () => async () => {
        calls += 1;
        throw Object.assign(new Error("auth failed"), { code: "MODEL_AUTH_FAILED" });
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: fixedClock("2026-08-27T00:05:00.000Z"),
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    assert.deepStrictEqual(result, {
      status: "paused",
      claimed: 1,
      succeeded: 0,
      failed: 1,
      skipped: 0
    });
    assert.strictEqual(calls, 1);
    const workflow = getWorkflowRun(db, scenario.workflowId);
    assert.strictEqual(workflow.status, "paused");
    assert.strictEqual(workflow.controlState, "pause_requested");
    assert.strictEqual(workflow.errorCode, "MODEL_AUTH_REQUIRED");
    assert.strictEqual(workflow.resumePhase, "analyzing");
    assert.strictEqual(workflow.recoveryGeneration, 0);
    assert.strictEqual(workflow.circuitTimeoutJobCount, 0);
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.deepStrictEqual(tasks.map((task) => task.status), ["retry_pending", "pending", "pending"]);
    const attempts = listJobAnalysisAttempts(db, {
      workflowRunId: scenario.workflowId,
      taskId: tasks[0].id
    });
    assert.strictEqual(attempts.length, 1);
    assert.strictEqual(attempts[0].errorCode, "MODEL_AUTH_FAILED");
  } finally {
    db.close();
  }
}

async function testRunWorkflowAnalysisQueueDrainedCounts() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: [{}, {}, {}, {}],
      localDay: "2026-08-28",
      modelConfigRevision: "exec-drained"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-drained",
      now: "2026-08-28T00:00:00.000Z"
    });
    const result = await runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: { ...primaryRuntime(), concurrency: 2 },
      backupRuntime: null,
      createAnalyzeJob: () => async (job) => {
        const sourceId = String(job.sourceId || "");
        if (sourceId.endsWith("-job-2")) {
          return { ...job, analysis: {
            semanticStatus: "rule_only",
            decisionSource: "local_rules",
            fitReasons: [],
            revision: "test-rev"
          } };
        }
        if (sourceId.endsWith("-job-3")) {
          throw Object.assign(new Error("contract invalid"), { code: "MODEL_CONTRACT_INVALID" });
        }
        return analyzedJob(job);
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: fixedClock("2026-08-28T00:05:00.000Z"),
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    assert.deepStrictEqual(result, {
      status: "drained",
      claimed: 4,
      succeeded: 2,
      failed: 1,
      skipped: 1
    });
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.deepStrictEqual(tasks.map((task) => task.status), ["succeeded", "skipped", "failed", "succeeded"]);
    const skippedObservation = db.prepare(
      "SELECT analysis_json FROM job_observations WHERE job_id = ?"
    ).get(scenario.jobIds[1]);
    assert.strictEqual(JSON.parse(skippedObservation.analysis_json).decisionSource, "local_rules");
  } finally {
    db.close();
  }
}

async function testRunWorkflowAnalysisNineFinalTimeoutsStayAnalyzing() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: Array.from({ length: 9 }, () => ({})),
      localDay: "2026-08-28",
      modelConfigRevision: "exec-circuit-nine"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-circuit-nine",
      now: "2026-08-28T00:00:00.000Z"
    });
    const result = await runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: { ...primaryRuntime(), concurrency: 2 },
      backupRuntime: null,
      createAnalyzeJob: () => async () => {
        throw timeoutError();
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: fixedClock("2026-08-28T00:05:00.000Z"),
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    assert.deepStrictEqual(result, {
      status: "drained",
      claimed: 18,
      succeeded: 0,
      failed: 18,
      skipped: 0
    });
    const workflow = getWorkflowRun(db, scenario.workflowId);
    assert.strictEqual(workflow.status, "analyzing");
    assert.strictEqual(workflow.controlState, "none");
    assert.strictEqual(workflow.errorCode, "");
    assert.strictEqual(workflow.circuitTimeoutJobCount, 9);
    assert.strictEqual(workflow.lifetimeTimeoutJobCount, 9);
    assert.strictEqual(workflow.recoveryGeneration, 0);
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.deepStrictEqual(tasks.map((task) => task.status), Array.from({ length: 9 }, () => "failed"));
  } finally {
    db.close();
  }
}

async function testRunWorkflowAnalysisTenthFinalTimeoutOpensCircuitWithSibling() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: Array.from({ length: 11 }, () => ({})),
      localDay: "2026-08-28",
      modelConfigRevision: "exec-circuit-sibling"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-circuit-sibling",
      now: "2026-08-28T00:00:00.000Z"
    });
    const callCounts = new Map();
    const gates = [];
    const running = runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: { ...primaryRuntime(), concurrency: 2 },
      backupRuntime: null,
      createAnalyzeJob: () => async (job) => {
        const sourceId = String(job.sourceId || "");
        const n = (callCounts.get(sourceId) || 0) + 1;
        callCounts.set(sourceId, n);
        const isJob10SecondAttempt = sourceId.endsWith("-job-10") && n === 2;
        const isJob11FirstAttempt = sourceId.endsWith("-job-11") && n === 1;
        if (isJob10SecondAttempt || isJob11FirstAttempt) {
          const gate = deferredGate();
          gates.push({ sourceId, n, job, gate });
          return gate.promise;
        }
        throw timeoutError();
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: fixedClock("2026-08-28T00:05:00.000Z"),
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    await waitFor(() => gates.length === 2);
    const job10 = gates.find((entry) => entry.sourceId.endsWith("-job-10"));
    const job11 = gates.find((entry) => entry.sourceId.endsWith("-job-11"));
    assert(job10, "job 10 second attempt must be in flight");
    assert(job11, "job 11 sibling must be in flight");
    let mid = getWorkflowRun(db, scenario.workflowId);
    assert.strictEqual(mid.status, "analyzing");
    assert.strictEqual(mid.controlState, "none");
    assert.strictEqual(mid.circuitTimeoutJobCount, 9);
    assert.strictEqual(mid.errorCode, "");

    // The 10th unique final timeout opens the circuit atomically with the commit.
    job10.gate.reject(timeoutError());
    await waitFor(() => getWorkflowRun(db, scenario.workflowId).controlState === "pause_requested");
    mid = getWorkflowRun(db, scenario.workflowId);
    assert.strictEqual(mid.status, "analyzing");
    assert.strictEqual(mid.errorCode, "MODEL_TIMEOUT_CIRCUIT_OPEN");
    assert.strictEqual(mid.circuitTimeoutJobCount, 10);
    assert.strictEqual(mid.lifetimeTimeoutJobCount, 10);
    assert.strictEqual(mid.recoveryGeneration, 0);

    // The already-running sibling finishes its current attempt and persists.
    job11.gate.resolve(analyzedJob(job11.job));
    const result = await running;
    assert.deepStrictEqual(result, {
      status: "paused",
      claimed: 21,
      succeeded: 1,
      failed: 20,
      skipped: 0
    });
    const workflow = getWorkflowRun(db, scenario.workflowId);
    assert.strictEqual(workflow.status, "paused");
    assert.strictEqual(workflow.controlState, "pause_requested");
    assert.strictEqual(workflow.resumePhase, "analyzing");
    assert.strictEqual(workflow.errorCode, "MODEL_TIMEOUT_CIRCUIT_OPEN");
    assert.strictEqual(workflow.recoveryGeneration, 0);
    assert.strictEqual(workflow.circuitTimeoutJobCount, 10);
    assert.strictEqual(workflow.lifetimeTimeoutJobCount, 10);
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.strictEqual(tasks.length, 11);
    assert.deepStrictEqual(
      tasks.map((task) => task.status),
      Array.from({ length: 10 }, () => "failed").concat(["succeeded"])
    );
    const job11Task = tasks.find((task) => String(task.jobId) === String(scenario.jobIds[10]));
    const attempts = listJobAnalysisAttempts(db, {
      workflowRunId: scenario.workflowId,
      taskId: job11Task.id
    });
    assert.strictEqual(attempts.length, 1);
    assert.strictEqual(attempts[0].status, "succeeded");
  } finally {
    db.close();
  }
}

async function testRunWorkflowAnalysisPauseRequestedFinalizesPaused() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: [{}, {}, {}],
      localDay: "2026-08-29",
      modelConfigRevision: "exec-manual-pause"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-manual-pause",
      now: "2026-08-29T00:00:00.000Z"
    });
    const gates = [];
    const running = runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: { ...primaryRuntime(), concurrency: 1 },
      backupRuntime: null,
      createAnalyzeJob: () => async (job) => {
        const gate = deferredGate();
        gates.push({ job, gate });
        return gate.promise;
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: fixedClock("2026-08-29T00:05:00.000Z"),
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    await waitFor(() => gates.length === 1);
    db.prepare("UPDATE workflow_runs SET control_state = 'pause_requested' WHERE id = ?").run(scenario.workflowId);
    gates[0].gate.resolve(analyzedJob(gates[0].job));
    const result = await running;
    assert.deepStrictEqual(result, {
      status: "paused",
      claimed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0
    });
    const workflow = getWorkflowRun(db, scenario.workflowId);
    assert.strictEqual(workflow.status, "paused");
    assert.strictEqual(workflow.controlState, "pause_requested");
    assert.strictEqual(workflow.resumePhase, "analyzing");
    assert.strictEqual(workflow.errorCode, "");
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.deepStrictEqual(tasks.map((task) => task.status), ["succeeded", "pending", "pending"]);
  } finally {
    db.close();
  }
}

async function testRunWorkflowAnalysisStopRequestedFinalizesStopped() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: [{}, {}, {}],
      localDay: "2026-08-29",
      modelConfigRevision: "exec-manual-stop"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-manual-stop",
      now: "2026-08-29T00:00:00.000Z"
    });
    db.prepare(`
      UPDATE workflow_job_tasks SET
        status = 'retry_pending',
        attempt_count_in_generation = 1,
        total_attempt_count = 1,
        priority = 20,
        available_at = '2026-08-29T01:00:00.000Z',
        last_error_code = 'MODEL_TIMEOUT',
        last_error_kind = 'retryable',
        updated_at = '2026-08-29T00:00:00.000Z'
      WHERE workflow_run_id = ? AND position = 3
    `).run(scenario.workflowId);
    const gates = [];
    const running = runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: { ...primaryRuntime(), concurrency: 1 },
      backupRuntime: null,
      createAnalyzeJob: () => async (job) => {
        const gate = deferredGate();
        gates.push({ job, gate });
        return gate.promise;
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: fixedClock("2026-08-29T00:05:00.000Z"),
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    await waitFor(() => gates.length === 1);
    db.prepare("UPDATE workflow_runs SET control_state = 'stop_requested' WHERE id = ?").run(scenario.workflowId);
    gates[0].gate.resolve(analyzedJob(gates[0].job));
    const result = await running;
    assert.deepStrictEqual(result, {
      status: "stopped",
      claimed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0
    });
    const workflow = getWorkflowRun(db, scenario.workflowId);
    assert.strictEqual(workflow.status, "stopped");
    assert.strictEqual(workflow.controlState, "stop_requested");
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.deepStrictEqual(tasks.map((task) => task.status), ["succeeded", "stopped", "stopped"]);
    const stoppedRetry = tasks.find((task) => task.position === 3);
    assert.strictEqual(stoppedRetry.availableAt, null);
    assert.strictEqual(stoppedRetry.leaseOwner, null);
    assert.strictEqual(stoppedRetry.finishedAt, "2026-08-29T00:05:00.000Z");
  } finally {
    db.close();
  }
}

async function testRunWorkflowAnalysisStopBeforeStartMarksAllStopped() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: [{}, {}],
      localDay: "2026-08-29",
      modelConfigRevision: "exec-stop-preset"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-stop-preset",
      now: "2026-08-29T00:00:00.000Z"
    });
    db.prepare("UPDATE workflow_runs SET control_state = 'stop_requested' WHERE id = ?").run(scenario.workflowId);
    const result = await runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: { ...primaryRuntime(), concurrency: 2 },
      backupRuntime: null,
      createAnalyzeJob: () => async (job) => analyzedJob(job),
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: fixedClock("2026-08-29T00:05:00.000Z"),
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    assert.deepStrictEqual(result, {
      status: "stopped",
      claimed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0
    });
    const workflow = getWorkflowRun(db, scenario.workflowId);
    assert.strictEqual(workflow.status, "stopped");
    assert.strictEqual(workflow.controlState, "stop_requested");
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.deepStrictEqual(tasks.map((task) => task.status), ["stopped", "stopped"]);
  } finally {
    db.close();
  }
}

async function testRunWorkflowAnalysisAbortsBetweenAttemptsWithoutReview() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: [{}, {}],
      localDay: "2026-09-04",
      modelConfigRevision: "exec-abort"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-abort",
      now: "2026-09-04T00:00:00.000Z"
    });
    const controller = new AbortController();
    const gates = [];
    const running = runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: { ...primaryRuntime(), concurrency: 1 },
      backupRuntime: null,
      createAnalyzeJob: () => async (job) => {
        const gate = deferredGate();
        gates.push({ job, gate });
        return gate.promise;
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: fixedClock("2026-09-04T00:05:00.000Z"),
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {},
      signal: controller.signal
    });
    await waitFor(() => gates.length === 1);
    controller.abort();
    gates[0].gate.resolve(analyzedJob(gates[0].job));
    const result = await withTimeout(running, 5000, "analysis did not converge after abort");
    assert.deepStrictEqual(result, {
      status: "interrupted",
      errorCode: "SCAN_ABORTED",
      claimed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0
    });
    const workflow = getWorkflowRun(db, scenario.workflowId);
    assert.strictEqual(workflow.status, "interrupted");
    assert.strictEqual(workflow.controlState, "none");
    assert.strictEqual(workflow.errorCode, "SCAN_ABORTED");
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.deepStrictEqual(tasks.map((task) => task.status), ["succeeded", "pending"]);
    assert.strictEqual(tasks[1].leaseOwner, null);
  } finally {
    db.close();
  }
}

async function testControlledStopMidAttemptPreservesRunningTask() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: [{}, {}],
      localDay: "2026-09-06",
      modelConfigRevision: "exec-controlled-stop"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-controlled-stop",
      now: "2026-09-06T00:00:00.000Z"
    });
    const result = await runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: { ...primaryRuntime(), concurrency: 1 },
      backupRuntime: null,
      createAnalyzeJob: () => async () => {
        throw Object.assign(new Error("aborted"), { code: "SCAN_ABORTED" });
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: fixedClock("2026-09-06T00:05:00.000Z"),
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    });
    assert.deepStrictEqual(result, {
      status: "interrupted",
      errorCode: "SCAN_ABORTED",
      claimed: 1,
      succeeded: 0,
      failed: 0,
      skipped: 0
    });
    const workflow = getWorkflowRun(db, scenario.workflowId);
    assert.strictEqual(workflow.status, "interrupted");
    assert.strictEqual(workflow.errorCode, "SCAN_ABORTED");
    const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
    assert.deepStrictEqual(tasks.map((task) => task.status), ["running", "pending"]);
    assert.strictEqual(tasks[0].leaseOwner, "worker-1");
    assert.strictEqual(tasks[0].lastErrorCode, null);

    // The preserved running task is recoverable on the production resume path.
    await runWorkflowAnalysisPhaseResumeDrains(db, scenario);
  } finally {
    db.close();
  }
}

async function runWorkflowAnalysisPhaseResumeDrains(db, scenario) {
  const { runWorkflowAnalysisPhase } = require("../src/core/job_analysis");
  const reportJobs = db.prepare(`
    SELECT o.job_id AS jobId, o.id AS observationId
    FROM job_observations o
    WHERE o.batch_id = ?
    ORDER BY o.job_id ASC
  `).all(scenario.batchId);
  const resumed = await runWorkflowAnalysisPhase(db, {
    workflowRun: getWorkflowRun(db, scenario.workflowId),
    batchId: scenario.batchId,
    jobsToAnalyze: reportJobs,
    configs: {},
    keywordPlan: [],
    logger: silentLogger(),
    signal: null,
    modelRuntimes: { primary: { ...primaryRuntime(), concurrency: 1 }, backup: null },
    createAnalyzeJob: () => async (job) => analyzedJob(job),
    analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
    now: fixedClock("2026-09-06T00:20:00.000Z"),
    retryBackoffMs: [0, 0],
    random: () => 0,
    sleep: async () => {}
  });
  assert.strictEqual(resumed.status, "drained");
  const tasks = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId });
  assert.deepStrictEqual(tasks.map((task) => task.status), ["succeeded", "succeeded"]);
}

async function testRunWorkflowAnalysisWaitsForFutureRetryNotFalseDrained() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: [{ semanticStatus: "pending", decisionSource: "scan" }],
      localDay: "2026-08-30",
      modelConfigRevision: "exec-future-retry"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-future-retry",
      now: "2026-08-30T00:00:00.000Z"
    });
    const claimNow = "2026-08-30T00:01:00.000Z";
    const claimed = claimWorkflowJobTask(db, {
      workflowRunId: scenario.workflowId,
      leaseOwner: "pre-worker-future",
      leaseTtlMs: 60_000,
      selectModelIdentity: ({ attemptInGeneration }) => selectAttemptRuntime({
        attemptInGeneration,
        primaryRuntime: primaryRuntime(),
        backupRuntime: null
      }).identity,
      now: claimNow
    });
    commitWorkflowJobTaskFailure(db, {
      taskId: claimed.task.id,
      leaseOwner: "pre-worker-future",
      errorCode: "MODEL_TIMEOUT",
      retryable: true,
      retryAt: "2026-08-30T00:01:30.000Z",
      errorStage: "analyze",
      modelIdentity: selectAttemptRuntime({
        attemptInGeneration: 1,
        primaryRuntime: primaryRuntime(),
        backupRuntime: null
      }).identity,
      startedAt: claimNow,
      finishedAt: claimNow
    });
    const clock = fakeClock("2026-08-30T00:01:00.000Z");
    let secondAttemptCalls = 0;
    const result = await runWorkflowAnalysis({
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: { ...primaryRuntime(), concurrency: 1 },
      backupRuntime: null,
      createAnalyzeJob: () => async (job) => {
        secondAttemptCalls += 1;
        return analyzedJob(job);
      },
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: clock.now,
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async (ms) => clock.advance(ms)
    });
    assert.deepStrictEqual(result, {
      status: "drained",
      claimed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0
    });
    assert.strictEqual(secondAttemptCalls, 1);
    const task = listWorkflowJobTasks(db, { workflowRunId: scenario.workflowId })[0];
    assert.strictEqual(task.status, "succeeded");
    assert.strictEqual(task.attemptCountInGeneration, 2);
  } finally {
    db.close();
  }
}

async function testRunWorkflowAnalysisRejectsNonAnalyzingOrMissingRun() {
  const db = openDb(":memory:");
  try {
    const scenario = seedWorkflow(db, {
      analyses: [{}],
      localDay: "2026-08-31",
      modelConfigRevision: "exec-entry"
    });
    initializeWorkflowJobTasks(db, {
      workflowRunId: scenario.workflowId,
      batchId: scenario.batchId,
      jobs: observationEntries(db, scenario.batchId),
      modelConfigRevision: "exec-entry",
      now: "2026-08-31T00:00:00.000Z"
    });
    const options = {
      db,
      workflowRunId: scenario.workflowId,
      primaryRuntime: { ...primaryRuntime(), concurrency: 1 },
      backupRuntime: null,
      createAnalyzeJob: () => async () => analyzedJob({ source: "boss", sourceId: "x", title: "x" }),
      analyzeScannedJob: async (raw, { analyzeJob }) => analyzeJob(raw),
      logger: silentLogger(),
      now: fixedClock("2026-08-31T00:05:00.000Z"),
      workerIdFactory: (index) => `worker-${index + 1}`,
      retryBackoffMs: [0, 0],
      random: () => 0,
      sleep: async () => {}
    };
    await assert.rejects(
      runWorkflowAnalysis({ ...options, workflowRunId: "missing-workflow-run" }),
      (error) => error.code === "WORKFLOW_EXECUTOR_RUN_NOT_FOUND"
    );
    db.prepare("UPDATE workflow_runs SET status = 'scanning' WHERE id = ?").run(scenario.workflowId);
    await assert.rejects(
      runWorkflowAnalysis(options),
      (error) => error.code === "WORKFLOW_EXECUTOR_RUN_NOT_ANALYZING"
    );
    transitionWorkflowRun(db, { id: scenario.workflowId, status: "analyzing" });
    transitionWorkflowRun(db, { id: scenario.workflowId, status: "paused" });
    await assert.rejects(
      runWorkflowAnalysis(options),
      (error) => error.code === "WORKFLOW_EXECUTOR_RUN_NOT_ANALYZING"
    );
  } finally {
    db.close();
  }
}

function testAttemptLoggerChildAndUnknownKeysRedacted() {
  const childContexts = [];
  const forwarded = [];
  const base = {
    info: (event, data) => forwarded.push({ event, data }),
    warn: () => {},
    error: () => {},
    child: (context) => {
      childContexts.push(context);
      return { info: (event, data) => forwarded.push({ event, data }), warn: () => {}, error: () => {} };
    }
  };
  const logger = createAttemptTelemetryLogger(base, createAttemptTelemetry());
  logger.child({ taskId: 7, resume: "private resume", unknownKey: "x" });
  assert.deepStrictEqual(childContexts, [{
    taskId: 7,
    resume: "[REDACTED]",
    unknownKey: "[REDACTED]"
  }]);
  logger.info("executor_event", { attempts: 1, company: "Acme", prompt: "private prompt" });
  assert.strictEqual(forwarded.length, 1);
  assert.strictEqual(forwarded[0].event, "executor_event");
  assert.strictEqual(forwarded[0].data.attempts, 1);
  assert.strictEqual(forwarded[0].data.company, "[REDACTED]");
  assert.strictEqual(forwarded[0].data.prompt, "[REDACTED]");
  assert(!JSON.stringify(forwarded).includes("Acme"));
  assert(!JSON.stringify(forwarded).includes("private prompt"));
}

function seedWorkflow(database, { analyses, localDay, modelConfigRevision, titleOverride = "" }) {
  const now = new Date().toISOString();
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Workflow Executor Candidate', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Workflow Executor Plan', '{}', NULL, 1, ?, ?)`).run(profileId, now, now).lastInsertRowid);
  const batchId = createBatch(database, "boss", "RAG", "workflow executor smoke", {
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
      title: titleOverride || `Job ${index + 1} (${localDay})`,
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

function observationEntries(database, batchId) {
  return database.prepare(`
    SELECT id AS observationId, job_id AS jobId
    FROM job_observations
    WHERE batch_id = ?
    ORDER BY id
  `).all(batchId).map((row) => ({
    jobId: Number(row.jobId),
    observationId: Number(row.observationId)
  }));
}

function analyzedJob(job) {
  return {
    ...job,
    analysis: {
      semanticStatus: "complete",
      decisionSource: "model",
      recommendation: "yes",
      revision: "test-rev",
      note: "ok"
    }
  };
}

function silentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => silentLogger()
  };
}

function fixedClock(iso) {
  return () => iso;
}

function fakeClock(startIso) {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current).toISOString(),
    advance: (ms) => {
      current += ms;
      return new Date(current).toISOString();
    }
  };
}

function deferredGate() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} (${timeoutMs}ms)`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function timeoutError() {
  return Object.assign(new Error("model timeout"), { code: "MODEL_TIMEOUT" });
}
