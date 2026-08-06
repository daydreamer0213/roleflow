"use strict";

const WORKFLOW_ANALYSIS_ERROR_KINDS = Object.freeze({
  RETRYABLE: "retryable",
  CONFIGURATION: "configuration",
  TERMINAL: "terminal",
  CONTROLLED_STOP: "controlled_stop"
});

const RETRYABLE_ERROR_CODES = new Set([
  "MODEL_TIMEOUT",
  "MODEL_CONNECTION_FAILED",
  "MODEL_RATE_LIMITED",
  "MODEL_UPSTREAM_UNAVAILABLE"
]);

// Configuration errors pause the workflow with a user-visible pause reason
// that is separate from the attempt/task error code.
const CONFIGURATION_PAUSE_CODES = new Map([
  ["MODEL_KEY_REQUIRED", "MODEL_AUTH_REQUIRED"],
  ["MODEL_AUTH_FAILED", "MODEL_AUTH_REQUIRED"],
  ["MODEL_ENDPOINT_OR_MODEL_NOT_FOUND", "MODEL_CONFIGURATION_REQUIRED"],
  ["MODEL_CONFIGURATION_REQUIRED", "MODEL_CONFIGURATION_REQUIRED"]
]);

const LOCAL_INPUT_ERROR_CODES = new Set([
  "LOCAL_INPUT_INVALID",
  "CANDIDATE_PROFILE_REQUIRED",
  "JOB_INPUT_INVALID"
]);

const FALLBACK_ERROR_CODE = "MODEL_ANALYSIS_FAILED";

function classifyWorkflowAnalysisError(error) {
  const code = String(error?.code || "").trim();
  const status = httpStatus(error);
  if (isRetryableCode(code) || isRetryableHttp(status)) {
    return classification(WORKFLOW_ANALYSIS_ERROR_KINDS.RETRYABLE, stableCode(code, status), true, null);
  }
  if (code === "SCAN_ABORTED") {
    return classification(WORKFLOW_ANALYSIS_ERROR_KINDS.CONTROLLED_STOP, "SCAN_ABORTED", false, null);
  }
  if (CONFIGURATION_PAUSE_CODES.has(code)) {
    return classification(
      WORKFLOW_ANALYSIS_ERROR_KINDS.CONFIGURATION,
      code,
      false,
      CONFIGURATION_PAUSE_CODES.get(code)
    );
  }
  if (isTerminalCode(code)) {
    return classification(WORKFLOW_ANALYSIS_ERROR_KINDS.TERMINAL, code, false, null);
  }
  return classification(
    WORKFLOW_ANALYSIS_ERROR_KINDS.TERMINAL,
    code || FALLBACK_ERROR_CODE,
    false,
    null
  );
}

function classification(kind, code, retryable, pauseCode) {
  return { kind, code, retryable, pauseCode };
}

function httpStatus(error) {
  const candidates = [error?.status, error?.statusCode, error?.httpStatus];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isRetryableHttp(status) {
  return status === 429 || (Number.isFinite(status) && status >= 500 && status <= 599);
}

function isRetryableCode(code) {
  return RETRYABLE_ERROR_CODES.has(code) || /^HTTP_(429|5\d{2})$/.test(code);
}

function isTerminalCode(code) {
  return code === "MODEL_CONTRACT_INVALID" || LOCAL_INPUT_ERROR_CODES.has(code);
}

function stableCode(code, status) {
  if (code) return code;
  if (Number.isFinite(status)) return `HTTP_${status}`;
  return FALLBACK_ERROR_CODE;
}

function createAttemptTelemetry() {
  return {
    modelCallCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  };
}

function createAttemptTelemetryLogger(logger, telemetry) {
  const aggregate = telemetry && typeof telemetry === "object" ? telemetry : createAttemptTelemetry();
  const forward = logger && typeof logger === "object" ? logger : {};

  function info(event, context) {
    observeCompletedEvent(event, context, aggregate);
    if (typeof forward.info === "function") return forward.info(event, context);
    return undefined;
  }

  return {
    info,
    warn: (event, context) => (typeof forward.warn === "function" ? forward.warn(event, context) : undefined),
    error: (event, context) => (typeof forward.error === "function" ? forward.error(event, context) : undefined),
    child: (context) => createAttemptTelemetryLogger(
      typeof forward.child === "function" ? forward.child(context) : forward,
      aggregate
    )
  };
}

function observeCompletedEvent(event, context, telemetry) {
  if (event !== "model_call_completed") return;
  const data = context && typeof context === "object" && !Array.isArray(context) ? context : {};
  const usage = data.usage && typeof data.usage === "object" && !Array.isArray(data.usage) ? data.usage : {};
  telemetry.modelCallCount += nonNegativeFinite(data.attempts);
  telemetry.promptTokens += nonNegativeFinite(usage.prompt_tokens);
  telemetry.completionTokens += nonNegativeFinite(usage.completion_tokens);
  telemetry.totalTokens += nonNegativeFinite(usage.total_tokens);
}

function nonNegativeFinite(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function selectAttemptRuntime({ attemptInGeneration, primaryRuntime, backupRuntime }) {
  const attempt = Number(attemptInGeneration);
  const useBackup = Number.isInteger(attempt) && attempt >= 2 && isVerifiedBackupRuntime(backupRuntime);
  const runtime = useBackup ? backupRuntime : primaryRuntime;
  const modelConfig = runtime && typeof runtime.modelConfig === "object" && !Array.isArray(runtime.modelConfig)
    ? runtime.modelConfig
    : {};
  const provider = String(modelConfig.provider || "mock");
  const providerConfig = modelConfig.providers && typeof modelConfig.providers === "object"
    ? modelConfig.providers[provider]
    : null;
  return {
    runtime,
    identity: {
      profileKind: "batch_screening",
      modelConfigRevision: String(runtime && runtime.revision ? runtime.revision : ""),
      provider,
      model: String((providerConfig && providerConfig.model) || modelConfig.model || ""),
      thinkingMode: String((providerConfig && providerConfig.thinkingMode) || modelConfig.thinkingMode || "disabled"),
      reasoningEffort: String((providerConfig && providerConfig.reasoningEffort) || modelConfig.reasoningEffort || "high"),
      backupUsed: useBackup ? 1 : 0
    }
  };
}

function isVerifiedBackupRuntime(backupRuntime) {
  if (!backupRuntime || typeof backupRuntime !== "object") return false;
  if (backupRuntime.enabled === false) return false;
  const connection = backupRuntime.connection || backupRuntime.settings?.batchBackup?.connection;
  if (connection && String(connection.status || "") !== "verified") return false;
  return Boolean(backupRuntime.modelConfig && typeof backupRuntime.modelConfig === "object");
}

module.exports = {
  WORKFLOW_ANALYSIS_ERROR_KINDS,
  classifyWorkflowAnalysisError,
  createAttemptTelemetry,
  createAttemptTelemetryLogger,
  selectAttemptRuntime
};
