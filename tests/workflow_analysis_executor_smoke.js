"use strict";

const assert = require("node:assert/strict");
const { PRODUCT_POLICY } = require("../src/core/product_policy");
const {
  WORKFLOW_ANALYSIS_ERROR_KINDS,
  classifyWorkflowAnalysisError,
  createAttemptTelemetry,
  createAttemptTelemetryLogger,
  selectAttemptRuntime
} = require("../src/core/workflow_analysis_executor");

try {
  testErrorKindConstants();
  testRetryableCodeMapping();
  testHttpStatusMapping();
  testConfigurationPauseMapping();
  testTerminalAndLocalInputMapping();
  testControlledStopMapping();
  testClassificationNeverReturnsRawMessage();
  testAttemptTelemetryInitialState();
  testTelemetryAggregatesCompletedCallsOnly();
  testTelemetryIgnoresUnrelatedEventsAndFields();
  testTelemetryForwardsEveryEvent();
  testTelemetryChildSharesAccumulator();
  testPrimaryBackupSelection();
  testSelectionDoesNotMutatePrimaryRuntime();
  testProductPolicyModelAnalysisFixedValues();
  console.log("workflow_analysis_executor_smoke ok");
} catch (error) {
  console.error(error);
  process.exit(1);
}

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
  const completed = { attempts: 1, usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }, input: "raw", output: "raw" };
  const failed = { errorMessage: "boom", attempts: 7 };
  logger.info("model_call_completed", completed);
  logger.warn("model_call_failed", failed);
  logger.error("executor_worker_crashed", { message: "unexpected" });
  assert.deepStrictEqual(forwarded, [
    { level: "info", event: "model_call_completed", data: completed },
    { level: "warn", event: "model_call_failed", data: failed },
    { level: "error", event: "executor_worker_crashed", data: { message: "unexpected" } }
  ]);
  assert.deepStrictEqual(telemetry, {
    modelCallCount: 1,
    promptTokens: 3,
    completionTokens: 1,
    totalTokens: 4
  });

  const silent = createAttemptTelemetryLogger(null, createAttemptTelemetry());
  silent.info("model_call_completed", { attempts: 4, usage: { prompt_tokens: 9 } });
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
