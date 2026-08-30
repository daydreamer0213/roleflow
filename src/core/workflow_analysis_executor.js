"use strict";

const { PRODUCT_POLICY } = require("./product_policy");
const { getWorkflowRun, immediateTransaction, transitionWorkflowRun } = require("./storage");
const {
  claimWorkflowJobTask,
  commitWorkflowJobTaskSuccess,
  commitWorkflowJobTaskSkipped,
  commitWorkflowJobTaskFailure,
  countWorkflowJobTaskStatusesForRun,
  earliestRetryAvailableAt,
  markRemainingWorkflowJobTasksStopped,
  skipIncompleteWorkflowJobTasks
} = require("./workflow_analysis_tasks");

const WORKFLOW_ANALYSIS_ERROR_KINDS = Object.freeze({
  RETRYABLE: "retryable",
  CONFIGURATION: "configuration",
  TERMINAL: "terminal",
  CONTROLLED_STOP: "controlled_stop"
});

const WORKFLOW_EXECUTOR_CRASH_CODE = "WORKFLOW_EXECUTOR_CRASH";
const WORKFLOW_EXECUTOR_RUN_NOT_FOUND = "WORKFLOW_EXECUTOR_RUN_NOT_FOUND";
const WORKFLOW_EXECUTOR_RUN_NOT_ANALYZING = "WORKFLOW_EXECUTOR_RUN_NOT_ANALYZING";
const WORKFLOW_EXECUTOR_QUEUE_NOT_DRAINED = "WORKFLOW_EXECUTOR_QUEUE_NOT_DRAINED";
const LOCAL_RULE_SKIP_CODE = "LOCAL_RULE_SKIP";

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
const REDACTED_LABEL = "[REDACTED]";

// Key-based filter applied before forwarding any event context downstream.
// Never rely on the caller having sanitized the payload already.
const FORWARD_SENSITIVE_KEY = /^(input|output|prompt|resume|raw|request|response|errorMessage|message|stack|content|body|text|description|preview|note|payload|invalidOutput|error|cause)$/i;
const FORWARD_SAFE_METRIC_KEY = /^(prompt|completion|total)_tokens$/i;

// Explicit allowlist for non-metric event fields. Unknown keys are not
// forwarded as-is; they are collapsed to [REDACTED] instead.
const FORWARD_SAFE_KEY = new Set([
  "type",
  "kind",
  "stage",
  "phase",
  "attempts",
  "provider",
  "model",
  "modelConfigRevision",
  "profileKind",
  "thinkingMode",
  "reasoningEffort",
  "backupUsed",
  "attemptInGeneration",
  "totalAttemptNumber",
  "taskId",
  "workerId",
  "jobId",
  "position",
  "batchId",
  "workflowRunId",
  "status",
  "code",
  "errorCode",
  "errorKind",
  "pauseCode",
  "retryable",
  "statusCode",
  "httpStatus",
  "latencyMs",
  "latency",
  "time",
  "cacheHit",
  "jsonMode",
  "jsonModeFallback",
  "requestedMaxTokens",
  "contentLength",
  "finishReason",
  "responseFailureKind",
  "responseContentTypeKind",
  "responseEnvelopeKind",
  "responseParseFailureKind",
  "responseHadUtf8Bom",
  "responseJsonModeApplied",
  "providerRequestId",
  "name",
  "usage",
  "revision",
  "reasonCode"
]);

function classifyWorkflowAnalysisError(error) {
  const code = String(error?.code || "").trim();
  const status = httpStatus(error);
  if (code) {
    if (isRetryableCode(code)) {
      return classification(WORKFLOW_ANALYSIS_ERROR_KINDS.RETRYABLE, code, true, null);
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
  }
  // Bare or unrecognized errors fall back to HTTP status only.
  if (status === 401 || status === 403) {
    return classification(
      WORKFLOW_ANALYSIS_ERROR_KINDS.CONFIGURATION,
      "MODEL_AUTH_FAILED",
      false,
      "MODEL_AUTH_REQUIRED"
    );
  }
  if (isRetryableHttp(status)) {
    return classification(WORKFLOW_ANALYSIS_ERROR_KINDS.RETRYABLE, `HTTP_${status}`, true, null);
  }
  return classification(
    WORKFLOW_ANALYSIS_ERROR_KINDS.TERMINAL,
    code || (Number.isFinite(status) ? `HTTP_${status}` : FALLBACK_ERROR_CODE),
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
    if (typeof forward.info === "function") return forward.info(event, sanitizeForwarded(context));
    return undefined;
  }

  return {
    info,
    warn: (event, context) => (typeof forward.warn === "function" ? forward.warn(event, sanitizeForwarded(context)) : undefined),
    error: (event, context) => (typeof forward.error === "function" ? forward.error(event, sanitizeForwarded(context)) : undefined),
    child: (context) => createAttemptTelemetryLogger(
      typeof forward.child === "function"
        ? forward.child(sanitizeForwarded(context))
        : forward,
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

function sanitizeForwarded(value, key = "") {
  if (FORWARD_SAFE_METRIC_KEY.test(key)) return value;
  if (FORWARD_SENSITIVE_KEY.test(key)) return REDACTED_LABEL;
  if (value instanceof Error) {
    return {
      name: String(value.name || "Error"),
      code: String(value.code || ""),
      stage: String(value.stage || ""),
      statusCode: finiteOrNull(value.statusCode),
      status: finiteOrNull(value.status),
      httpStatus: finiteOrNull(value.httpStatus),
      retryable: typeof value.retryable === "boolean" ? value.retryable : null
    };
  }
  if (key && !FORWARD_SAFE_KEY.has(key)) return REDACTED_LABEL;
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeForwarded(item, key));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 50).map(([name, item]) => [name, sanitizeForwarded(item, name)])
    );
  }
  return String(value);
}

async function runWorkflowAnalysis(input) {
  const context = normalizeRunContext(input);
  assertAnalyzingRun(context);
  skipIncompleteWorkflowJobTasks(context.db, {
    workflowRunId: context.workflowRunId,
    now: context.now()
  });
  const summary = { claimed: 0, succeeded: 0, failed: 0, skipped: 0 };
  const workerResults = await Promise.allSettled(
    Array.from({ length: context.workerCount }, (_, index) => workerLoop(context, index, summary))
  );
  const rejections = workerResults.filter((result) => result.status === "rejected");
  if (rejections.length > 0) {
    transitionWorkflowRun(context.db, {
      id: context.workflowRunId,
      status: "interrupted",
      errorCode: WORKFLOW_EXECUTOR_CRASH_CODE,
      errorMessage: "workflow analysis worker crashed; running tasks are recoverable"
    });
    return { ...summary, status: "interrupted", rejected: rejections.length };
  }
  const workflow = getWorkflowRun(context.db, context.workflowRunId);
  const finishedAt = context.now();
  if (!workflow) {
    transitionWorkflowRun(context.db, {
      id: context.workflowRunId,
      status: "interrupted",
      errorCode: WORKFLOW_EXECUTOR_RUN_NOT_FOUND,
      errorMessage: "workflow run disappeared while workers were running"
    });
    return { ...summary, status: "interrupted" };
  }
  if (workflow.controlState === "stop_requested") {
    immediateTransaction(context.db, () => {
      markRemainingWorkflowJobTasksStopped(context.db, {
        workflowRunId: context.workflowRunId,
        now: finishedAt
      });
      transitionWorkflowRun(context.db, {
        id: context.workflowRunId,
        status: "stopped",
        updatedAt: finishedAt
      });
    });
    return { ...summary, status: "stopped" };
  }
  if (workflow.controlState === "pause_requested") {
    transitionWorkflowRun(context.db, {
      id: context.workflowRunId,
      status: "paused",
      resumePhase: workflow.resumePhase || "analyzing",
      updatedAt: finishedAt
    });
    return { ...summary, status: "paused" };
  }
  const controlledStop = workerResults.find(
    (result) => result.status === "fulfilled" && result.value && result.value.controlledStop
  );
  if (controlledStop || signalAborted(context)) {
    const code = String(controlledStop?.value?.controlledStop || controlledAbortCode(context) || "SCAN_ABORTED");
    transitionWorkflowRun(context.db, {
      id: context.workflowRunId,
      status: "interrupted",
      errorCode: code,
      errorMessage: "workflow analysis stopped at a safe boundary; running tasks are recoverable"
    });
    return { ...summary, status: "interrupted", errorCode: code };
  }
  const counts = countWorkflowJobTaskStatusesForRun(context.db, context.workflowRunId);
  if (counts.pending === 0 && counts.running === 0 && counts.retryPending === 0) {
    return { ...summary, status: "drained" };
  }
  // Defensive: all workers exited with control none while unfinished work remains.
  transitionWorkflowRun(context.db, {
    id: context.workflowRunId,
    status: "interrupted",
    errorCode: WORKFLOW_EXECUTOR_QUEUE_NOT_DRAINED,
    errorMessage: "workflow analysis workers exited before the queue was drained"
  });
  return { ...summary, status: "interrupted" };
}

async function workerLoop(context, workerIndex, summary) {
  const leaseOwner = context.workerIdFactory
    ? String(context.workerIdFactory(workerIndex, context.workerCount))
    : `workflow-analysis-worker-${workerIndex + 1}`;
  while (true) {
    const gate = getWorkflowRun(context.db, context.workflowRunId);
    if (!gate || gate.status !== "analyzing" || gate.controlState !== "none" || signalAborted(context)) return;
    const claimed = claimWorkflowJobTask(context.db, {
      workflowRunId: context.workflowRunId,
      leaseOwner,
      leaseTtlMs: context.leaseTtlMs,
      selectModelIdentity: ({ attemptInGeneration }) => selectAttemptRuntime({
        attemptInGeneration,
        primaryRuntime: context.primaryRuntime,
        backupRuntime: context.backupRuntime
      }).identity,
      now: context.now()
    });
    if (!claimed) {
      const counts = countWorkflowJobTaskStatusesForRun(context.db, context.workflowRunId);
      if (counts.pending === 0 && counts.running === 0 && counts.retryPending === 0) return;
      const waitMs = waitMsUntilEarliestRetry(context);
      if (waitMs > 0) {
        await context.sleep(waitMs);
        continue;
      }
      // The only remaining unfinished tasks are leased by sibling workers.
      return;
    }
    summary.claimed += 1;
    try {
      await executeAttempt(context, claimed, leaseOwner, summary);
    } catch (error) {
      if (error && error.workflowControlledStop) {
        return { controlledStop: String(error.code || "SCAN_ABORTED") };
      }
      throw error;
    }
  }
}

async function executeAttempt(context, claimed, leaseOwner, summary) {
  const runtime = runtimeForAttempt(claimed.attempt, context);
  const telemetry = createAttemptTelemetry();
  const attemptLogger = createAttemptTelemetryLogger(context.logger, telemetry);
  const startedAt = claimed.attempt.startedAt;
  try {
    const analyzeJob = context.createAnalyzeJob(runtime, { logger: attemptLogger });
    const analyzedJob = await context.analyzeScannedJob(claimed.job, {
      configs: { model: runtime.modelConfig },
      analyzeJob,
      signal: context.signal
    });
    const finishedAt = context.now();
    if (isLocalRuleSkip(analyzedJob)) {
      commitWorkflowJobTaskSkipped(context.db, {
        taskId: claimed.task.id,
        leaseOwner,
        analyzedJob,
        reasonCode: LOCAL_RULE_SKIP_CODE,
        startedAt,
        finishedAt
      });
      summary.skipped += 1;
      return;
    }
    commitWorkflowJobTaskSuccess(context.db, {
      taskId: claimed.task.id,
      leaseOwner,
      analyzedJob,
      modelIdentity: identityFromAttempt(claimed.attempt),
      telemetry,
      startedAt,
      finishedAt
    });
    summary.succeeded += 1;
  } catch (error) {
    if (isWorkflowFatalError(error)) throw error;
    const classified = classifyWorkflowAnalysisError(error);
    if (classified.kind === WORKFLOW_ANALYSIS_ERROR_KINDS.CONTROLLED_STOP) {
      // A controlled stop is not a task failure: never commit the task as
      // terminal failed. Preserve the running lease so recovery can resume
      // the attempt or settle it under explicit stop semantics.
      throw Object.assign(error, { workflowControlledStop: true });
    }
    const finishedAt = context.now();
    const attemptInGeneration = Number(claimed.attempt.attemptInGeneration || 0);
    const retryAt = classified.retryable && attemptInGeneration < 2
      ? retryAtFromContext(context, attemptInGeneration, finishedAt)
      : null;
    commitWorkflowJobTaskFailure(context.db, {
      taskId: claimed.task.id,
      leaseOwner,
      errorCode: classified.code,
      pauseCode: classified.pauseCode,
      retryable: classified.retryable ? 1 : 0,
      retryAt,
      errorStage: String(error?.stage || error?.phase || "analysis"),
      modelIdentity: identityFromAttempt(claimed.attempt),
      telemetry,
      startedAt,
      finishedAt
    });
    summary.failed += 1;
    if (retryAt) {
      const waitMs = Math.max(0, Date.parse(retryAt) - Date.parse(context.now()));
      if (waitMs > 0) await context.sleep(waitMs);
    }
  }
}

function normalizeRunContext(input = {}) {
  const db = input.db;
  if (!db || typeof db.prepare !== "function") {
    throw contextError("WORKFLOW_EXECUTOR_DB_REQUIRED", "runWorkflowAnalysis requires a sqlite db");
  }
  const workflowRunId = String(input.workflowRunId || "").trim();
  if (!workflowRunId) {
    throw contextError("WORKFLOW_EXECUTOR_RUN_ID_REQUIRED", "runWorkflowAnalysis requires workflowRunId");
  }
  if (typeof input.createAnalyzeJob !== "function") {
    throw contextError("WORKFLOW_EXECUTOR_CREATE_ANALYZE_JOB_REQUIRED", "runWorkflowAnalysis requires createAnalyzeJob");
  }
  if (typeof input.analyzeScannedJob !== "function") {
    throw contextError("WORKFLOW_EXECUTOR_ANALYZE_SCANNED_JOB_REQUIRED", "runWorkflowAnalysis requires analyzeScannedJob");
  }
  const primaryRuntime = input.primaryRuntime && typeof input.primaryRuntime === "object"
    ? input.primaryRuntime
    : {};
  const backupRuntime = input.backupRuntime && typeof input.backupRuntime === "object"
    ? input.backupRuntime
    : null;
  const workerCount = clampConcurrency(Number(primaryRuntime.concurrency ?? 2));
  return {
    db,
    workflowRunId,
    primaryRuntime,
    backupRuntime,
    createAnalyzeJob: input.createAnalyzeJob,
    analyzeScannedJob: input.analyzeScannedJob,
    logger: input.logger && typeof input.logger === "object" ? input.logger : {},
    now: typeof input.now === "function" ? input.now : () => new Date().toISOString(),
    sleep: typeof input.sleep === "function" ? input.sleep : defaultSleep,
    random: typeof input.random === "function" ? input.random : Math.random,
    retryBackoffMs: Array.isArray(input.retryBackoffMs) && input.retryBackoffMs.length > 0
      ? input.retryBackoffMs
      : PRODUCT_POLICY.operations.modelAnalysis.retryBackoffMs,
    workerIdFactory: typeof input.workerIdFactory === "function" ? input.workerIdFactory : null,
    leaseTtlMs: PRODUCT_POLICY.operations.modelAnalysis.taskLeaseTtlMs,
    workerCount,
    signal: input.signal && typeof input.signal === "object" ? input.signal : null
  };
}

function assertAnalyzingRun(context) {
  const workflow = getWorkflowRun(context.db, context.workflowRunId);
  if (!workflow) {
    throw contextError(
      WORKFLOW_EXECUTOR_RUN_NOT_FOUND,
      `workflow run ${context.workflowRunId} does not exist`
    );
  }
  if (workflow.status !== "analyzing") {
    throw contextError(
      WORKFLOW_EXECUTOR_RUN_NOT_ANALYZING,
      `workflow run ${context.workflowRunId} status is ${workflow.status}; only analyzing runs can be executed`
    );
  }
}

function signalAborted(context) {
  return Boolean(context.signal && context.signal.aborted);
}

function controlledAbortCode(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error && String(reason.code || "").trim()) {
    return String(reason.code).trim();
  }
  return "SCAN_ABORTED";
}

function waitMsUntilEarliestRetry(context) {
  const counts = countWorkflowJobTaskStatusesForRun(context.db, context.workflowRunId);
  if (counts.retryPending === 0) return 0;
  const earliest = earliestRetryAvailableAt(context.db, {
    workflowRunId: context.workflowRunId,
    now: context.now()
  });
  if (!earliest) return 0;
  return Math.max(0, Date.parse(earliest) - Date.parse(context.now()));
}

function clampConcurrency(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return 2;
  return Math.max(1, Math.min(2, parsed));
}

function defaultSleep(ms) {
  const wait = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, wait));
}

function runtimeForAttempt(attempt, context) {
  if (Number(attempt?.backupUsed || 0) === 1 && isVerifiedBackupRuntime(context.backupRuntime)) {
    return context.backupRuntime;
  }
  return context.primaryRuntime;
}

function identityFromAttempt(attempt) {
  return {
    profileKind: String(attempt.profileKind || "batch_screening"),
    modelConfigRevision: String(attempt.modelConfigRevision || ""),
    provider: String(attempt.provider || ""),
    model: String(attempt.model || ""),
    thinkingMode: String(attempt.thinkingMode || ""),
    reasoningEffort: String(attempt.reasoningEffort || ""),
    backupUsed: Number(attempt.backupUsed || 0)
  };
}

function retryAtFromContext(context, attemptInGeneration, finishedAt) {
  const range = context.retryBackoffMs;
  const index = Math.min(Math.max(0, attemptInGeneration - 1), range.length - 1);
  const min = Number(range[index]);
  const max = index + 1 < range.length ? Number(range[index + 1]) : min;
  if (!Number.isFinite(min) || min < 0) {
    return new Date(Date.parse(finishedAt) + 1000).toISOString();
  }
  const span = Number.isFinite(max) && max > min ? max - min : 0;
  const jitter = typeof context.random === "function" ? boundedUnit(context.random()) : 0.5;
  const delayMs = Math.max(0, Math.round(min + span * jitter));
  return new Date(Date.parse(finishedAt) + delayMs).toISOString();
}

function boundedUnit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.5;
  return Math.max(0, Math.min(1, parsed));
}

function isLocalRuleSkip(analyzedJob) {
  const analysis = analyzedJob?.analysis && typeof analyzedJob.analysis === "object"
    ? analyzedJob.analysis
    : {};
  return String(analysis.decisionSource || "") === "local_rules"
    || String(analysis.semanticStatus || "") === "rule_only";
}

function isWorkflowFatalError(error) {
  return Boolean(error && (error.workflowFatal === true || String(error.code || "") === WORKFLOW_EXECUTOR_CRASH_CODE));
}

function contextError(code, message) {
  return Object.assign(new Error(message), { code });
}

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
  selectAttemptRuntime,
  runWorkflowAnalysis
};
