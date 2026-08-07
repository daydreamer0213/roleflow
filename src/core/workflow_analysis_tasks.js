"use strict";

const { PRODUCT_POLICY } = require("./product_policy");
const {
  getWorkflowRun,
  immediateTransaction,
  insertWorkflowJobTaskRow,
  countWorkflowJobTasks,
  selectClaimableWorkflowJobTaskRow,
  claimWorkflowJobTaskRow,
  insertJobAnalysisAttemptRow,
  incrementWorkflowRunActivity,
  getWorkflowObservationJob,
  getWorkflowJobTaskRow,
  getRunningJobAnalysisAttemptRow,
  finishJobAnalysisAttemptRow,
  failWorkflowJobTaskRow,
  incrementWorkflowTimeoutCounters,
  countWorkflowJobTaskStatuses,
  selectEarliestRetryAvailableAt,
  markWorkflowJobTasksStopped,
  requestWorkflowRunConfigurationPause,
  selectExpiredLeaseWorkflowJobTaskRows,
  completeWorkflowJobTaskRow,
  workflowJobTaskRow,
  jobAnalysisAttemptRow,
  listWorkflowJobTaskRows,
  listJobAnalysisAttemptRows,
  upsertJob
} = require("./storage");

const CONFIG_PAUSE_CODES = new Set([
  "MODEL_KEY_REQUIRED",
  "MODEL_AUTH_FAILED",
  "MODEL_ENDPOINT_OR_MODEL_NOT_FOUND",
  "MODEL_CONFIGURATION_REQUIRED"
]);
const WORKFLOW_PAUSE_CODES = new Set([
  "MODEL_AUTH_REQUIRED",
  "MODEL_CONFIGURATION_REQUIRED"
]);
const LEASE_EXPIRED_ERROR_CODE = "LEASE_EXPIRED";
const LEASE_EXPIRED_ERROR_STAGE = "execution";

function initializeWorkflowJobTasks(db, {
  workflowRunId,
  batchId,
  jobs,
  modelConfigRevision,
  now
}) {
  const workflow = getWorkflowRun(db, workflowRunId);
  if (!workflow) {
    throw workflowTaskError(
      "WORKFLOW_TASK_WORKFLOW_NOT_FOUND",
      `工作流 ${workflowRunId} 不存在，无法初始化岗位任务`
    );
  }
  if (Number(workflow.scanBatchId || 0) !== Number(batchId)) {
    throw workflowTaskError(
      "WORKFLOW_TASK_WORKFLOW_BATCH_MISMATCH",
      `工作流 ${workflowRunId} 关联的扫描批次与传入批次 ${batchId} 不匹配`
    );
  }
  const entries = (jobs || []).map((entry, index) => {
    const jobId = Number(entry.jobId);
    const observationId = Number(entry.observationId);
    const observation = db.prepare(`
      SELECT id, job_id, analysis_json
      FROM job_observations
      WHERE id = ? AND job_id = ? AND batch_id = ?
    `).get(observationId, jobId, batchId);
    if (!observation) {
      throw workflowTaskError(
        "WORKFLOW_TASK_BATCH_MISMATCH",
        `岗位 ${jobId}（observation ${observationId}）不属于批次 ${batchId}`
      );
    }
    return {
      jobId,
      observationId,
      position: index + 1,
      status: initialTaskStatus(parseJsonSafe(observation.analysis_json))
    };
  });

  return immediateTransaction(db, () => {
    let inserted = 0;
    for (const entry of entries) {
      const result = insertWorkflowJobTaskRow(db, {
        workflowRunId,
        batchId,
        jobId: entry.jobId,
        observationId: entry.observationId,
        position: entry.position,
        status: entry.status,
        recoveryGeneration: Number(workflow.recoveryGeneration || 0),
        modelConfigRevision,
        now
      });
      inserted += Number(result.changes || 0);
    }
    const total = countWorkflowJobTasks(db, workflowRunId);
    return { inserted, existing: total - inserted, total };
  });
}

function claimWorkflowJobTask(db, {
  workflowRunId,
  leaseOwner,
  leaseTtlMs,
  selectModelIdentity,
  now
}) {
  const owner = String(leaseOwner || "");
  if (!owner) {
    throw workflowTaskError("WORKFLOW_TASK_LEASE_OWNER_REQUIRED", "领取任务必须提供 leaseOwner");
  }
  const ttl = Number(leaseTtlMs);
  if (!Number.isFinite(ttl) || ttl < 0) {
    throw workflowTaskError("WORKFLOW_TASK_LEASE_TTL_INVALID", `leaseTtlMs 无效：${leaseTtlMs}`);
  }
  const clock = String(now || "");
  const clockMs = Date.parse(clock);
  if (!Number.isFinite(clockMs)) {
    throw workflowTaskError("WORKFLOW_TASK_INVALID_TIME", `now 无效：${now}`);
  }
  const normalizedClock = new Date(clockMs).toISOString();
  if (typeof selectModelIdentity !== "function") {
    throw workflowTaskError("WORKFLOW_TASK_MODEL_IDENTITY_REQUIRED", "必须提供 selectModelIdentity");
  }

  return immediateTransaction(db, () => {
    const workflow = getWorkflowRun(db, workflowRunId);
    if (!workflow || workflow.status !== "analyzing" || workflow.controlState !== "none") {
      return null;
    }
    const candidate = selectClaimableWorkflowJobTaskRow(db, { workflowRunId, now: normalizedClock });
    if (!candidate) return null;

    const attemptInGeneration = Number(candidate.attempt_count_in_generation || 0) + 1;
    const totalAttemptNumber = Number(candidate.total_attempt_count || 0) + 1;
    const identity = selectModelIdentity({ attemptInGeneration, totalAttemptNumber });
    if (!identity || typeof identity !== "object") {
      throw workflowTaskError(
        "WORKFLOW_TASK_MODEL_IDENTITY_INVALID",
        "selectModelIdentity 必须返回模型身份对象"
      );
    }
    const {
      provider,
      model,
      modelConfigRevision,
      thinkingMode,
      reasoningEffort
    } = identity;
    if (!provider || !model || !modelConfigRevision || !thinkingMode || !reasoningEffort) {
      throw workflowTaskError(
        "WORKFLOW_TASK_MODEL_IDENTITY_INVALID",
        "模型身份缺少 provider/model/modelConfigRevision/thinkingMode/reasoningEffort"
      );
    }

    const leaseExpiresAt = new Date(clockMs + ttl).toISOString();
    const update = claimWorkflowJobTaskRow(db, {
      taskId: Number(candidate.id),
      leaseOwner: owner,
      leasedAt: normalizedClock,
      leaseExpiresAt,
      attemptCountInGeneration: attemptInGeneration,
      totalAttemptCount: totalAttemptNumber,
      lastAttemptModelRevision: modelConfigRevision,
      now: normalizedClock
    });
    if (Number(update.changes) !== 1) return null;

    insertJobAnalysisAttemptRow(db, {
      workflowRunId,
      taskId: Number(candidate.id),
      jobId: Number(candidate.job_id),
      recoveryGeneration: Number(candidate.recovery_generation || 0),
      attemptInGeneration,
      totalAttemptNumber,
      profileKind: String(identity.profileKind || "batch_screening"),
      modelConfigRevision,
      provider,
      model,
      thinkingMode,
      reasoningEffort,
      backupUsed: Number(identity.backupUsed || 0) === 1,
      startedAt: normalizedClock,
      now: normalizedClock
    });
    incrementWorkflowRunActivity(db, { workflowRunId, now: normalizedClock });

    const taskRow = db.prepare("SELECT * FROM workflow_job_tasks WHERE id = ?").get(candidate.id);
    const attemptRow = db.prepare(`
      SELECT * FROM job_analysis_attempts
      WHERE task_id = ? AND recovery_generation = ? AND attempt_in_generation = ?
    `).get(candidate.id, Number(candidate.recovery_generation || 0), attemptInGeneration);
    return {
      task: workflowJobTaskRow(taskRow),
      attempt: jobAnalysisAttemptRow(attemptRow),
      job: getWorkflowObservationJob(db, Number(candidate.observation_id))
    };
  });
}

function commitWorkflowJobTaskSuccess(db, {
  taskId,
  leaseOwner,
  analyzedJob,
  modelIdentity,
  telemetry,
  startedAt,
  finishedAt
}) {
  const taskIdNum = requiredTaskId(taskId);
  const owner = requiredLeaseOwner(leaseOwner);
  const started = requiredIsoTime(startedAt, "startedAt");
  const finished = requiredIsoTime(finishedAt, "finishedAt");
  const identity = requiredModelIdentity(modelIdentity);
  requireAnalyzedJob(analyzedJob, "commitWorkflowJobTaskSuccess");

  return immediateTransaction(db, () => {
    const taskRow = requireRunningTaskRow(db, taskIdNum, owner);
    requireWorkflowExists(db, taskRow.workflow_run_id);
    const attemptRow = getRunningJobAnalysisAttemptRow(db, taskIdNum);
    if (!attemptRow) {
      throw workflowTaskError(
        "WORKFLOW_TASK_ATTEMPT_NOT_RUNNING",
        `任务 ${taskIdNum} 没有 running 的尝试记录，无法提交成功`
      );
    }
    validateAnalyzedJobIdentity(db, taskRow, analyzedJob, "commitWorkflowJobTaskSuccess");
    validateCommitIdentity(identity, attemptRow);
    validateStartedAtMatchesAttempt(started, attemptRow);

    upsertJob(db, analyzedJob, Number(taskRow.batch_id));

    const usage = normalizeTelemetry(telemetry);
    const latencyMs = latencyBetween(attemptRow.started_at, finished);
    finishJobAnalysisAttemptRow(db, {
      attemptId: Number(attemptRow.id),
      status: "succeeded",
      provider: attemptRow.provider,
      model: attemptRow.model,
      modelConfigRevision: attemptRow.model_config_revision,
      thinkingMode: attemptRow.thinking_mode,
      reasoningEffort: attemptRow.reasoning_effort,
      backupUsed: attemptRow.backup_used,
      modelCallCount: usage.modelCallCount,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      latencyMs,
      finishedAt: finished,
      now: finished
    });

    const taskUpdate = completeWorkflowJobTaskRow(db, {
      taskId: taskIdNum,
      leaseOwner: owner,
      status: "succeeded",
      reasonCode: null,
      reasonKind: null,
      finishedAt: finished,
      now: finished
    });
    if (Number(taskUpdate.changes) !== 1) {
      throw workflowTaskError(
        "WORKFLOW_TASK_NOT_RUNNING",
        `任务 ${taskIdNum} 不再是 running，成功提交未生效`
      );
    }
    incrementWorkflowRunActivity(db, { workflowRunId: taskRow.workflow_run_id, now: finished });

    return {
      task: workflowJobTaskRow(getWorkflowJobTaskRow(db, taskIdNum)),
      workflow: getWorkflowRun(db, taskRow.workflow_run_id)
    };
  });
}

function commitWorkflowJobTaskSkipped(db, {
  taskId,
  leaseOwner,
  analyzedJob,
  reasonCode,
  startedAt,
  finishedAt
}) {
  const taskIdNum = requiredTaskId(taskId);
  const owner = requiredLeaseOwner(leaseOwner);
  const started = requiredIsoTime(startedAt, "startedAt");
  const finished = requiredIsoTime(finishedAt, "finishedAt");
  const reason = String(reasonCode || "").trim();
  if (!reason) {
    throw workflowTaskError("WORKFLOW_TASK_REASON_CODE_REQUIRED", "跳过提交必须提供稳定的 reasonCode");
  }

  return immediateTransaction(db, () => {
    const taskRow = requireRunningTaskRow(db, taskIdNum, owner);
    requireWorkflowExists(db, taskRow.workflow_run_id);
    const attemptRow = getRunningJobAnalysisAttemptRow(db, taskIdNum);
    if (!attemptRow) {
      throw workflowTaskError(
        "WORKFLOW_TASK_ATTEMPT_NOT_RUNNING",
        `任务 ${taskIdNum} 没有 running 的尝试记录，无法提交跳过`
      );
    }
    validateStartedAtMatchesAttempt(started, attemptRow);

    if (analyzedJob) {
      requireAnalyzedJob(analyzedJob, "commitWorkflowJobTaskSkipped");
      validateAnalyzedJobIdentity(db, taskRow, analyzedJob, "commitWorkflowJobTaskSkipped");
      upsertJob(db, analyzedJob, Number(taskRow.batch_id));
    }

    finishJobAnalysisAttemptRow(db, {
      attemptId: Number(attemptRow.id),
      status: "succeeded",
      provider: attemptRow.provider,
      model: attemptRow.model,
      modelConfigRevision: attemptRow.model_config_revision,
      thinkingMode: attemptRow.thinking_mode,
      reasoningEffort: attemptRow.reasoning_effort,
      backupUsed: attemptRow.backup_used,
      modelCallCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: latencyBetween(started, finished),
      finishedAt: finished,
      now: finished
    });

    const taskUpdate = completeWorkflowJobTaskRow(db, {
      taskId: taskIdNum,
      leaseOwner: owner,
      status: "skipped",
      reasonCode: reason,
      reasonKind: "skipped",
      finishedAt: finished,
      now: finished
    });
    if (Number(taskUpdate.changes) !== 1) {
      throw workflowTaskError(
        "WORKFLOW_TASK_NOT_RUNNING",
        `任务 ${taskIdNum} 不再是 running，跳过提交未生效`
      );
    }
    incrementWorkflowRunActivity(db, { workflowRunId: taskRow.workflow_run_id, now: finished });

    return {
      task: workflowJobTaskRow(getWorkflowJobTaskRow(db, taskIdNum)),
      workflow: getWorkflowRun(db, taskRow.workflow_run_id)
    };
  });
}

function commitWorkflowJobTaskFailure(db, {
  taskId,
  leaseOwner,
  errorCode,
  pauseCode,
  retryable,
  retryAt,
  timeoutCircuitThreshold,
  errorStage,
  modelIdentity,
  telemetry,
  startedAt,
  finishedAt
}) {
  const taskIdNum = requiredTaskId(taskId);
  const owner = requiredLeaseOwner(leaseOwner);
  const code = String(errorCode || "").trim();
  if (!code) {
    throw workflowTaskError(
      "WORKFLOW_TASK_ERROR_CODE_REQUIRED",
      "失败提交必须提供稳定的公开 errorCode"
    );
  }
  const started = requiredIsoTime(startedAt, "startedAt");
  const finished = requiredIsoTime(finishedAt, "finishedAt");
  const pauseReason = pauseCode === undefined || pauseCode === null
    ? null
    : String(pauseCode).trim() || null;
  if (pauseReason && !WORKFLOW_PAUSE_CODES.has(pauseReason)) {
    throw workflowTaskError(
      "WORKFLOW_TASK_PAUSE_CODE_INVALID",
      `pauseCode 只允许 MODEL_AUTH_REQUIRED / MODEL_CONFIGURATION_REQUIRED：${pauseReason}`
    );
  }
  const stage = errorStage === undefined || errorStage === null
    ? null
    : String(errorStage).trim() || null;
  const isRetryable = Number(retryable) === 1;
  const identity = modelIdentity ? requiredModelIdentity(modelIdentity) : null;

  return immediateTransaction(db, () => {
    const taskRow = requireRunningTaskRow(db, taskIdNum, owner);
    requireWorkflowExists(db, taskRow.workflow_run_id);
    const attemptRow = getRunningJobAnalysisAttemptRow(db, taskIdNum);
    if (!attemptRow) {
      throw workflowTaskError(
        "WORKFLOW_TASK_ATTEMPT_NOT_RUNNING",
        `任务 ${taskIdNum} 没有 running 的尝试记录，无法提交失败`
      );
    }
    if (identity) validateCommitIdentity(identity, attemptRow);
    validateStartedAtMatchesAttempt(started, attemptRow);

    const attemptInGeneration = Number(taskRow.attempt_count_in_generation || 0);
    const usage = normalizeTelemetry(telemetry);
    const latencyMs = latencyBetween(attemptRow.started_at, finished);
    const isConfigPause = CONFIG_PAUSE_CODES.has(code);

    let outcome;
    let taskStatus;
    let availableAt = null;
    let priority = null;
    let finishedForTask = finished;
    let errorKind;
    if (isConfigPause) {
      outcome = "pause_requested";
      taskStatus = "retry_pending";
      finishedForTask = null;
      errorKind = "configuration";
    } else if (attemptInGeneration <= 1 && isRetryable) {
      const retryMs = Date.parse(retryAt);
      if (!Number.isFinite(retryMs)) {
        throw workflowTaskError(
          "WORKFLOW_TASK_RETRY_AT_REQUIRED",
          "可重试失败必须提供有效的 retryAt 冷却时间"
        );
      }
      outcome = "retry_pending";
      taskStatus = "retry_pending";
      availableAt = new Date(retryMs).toISOString();
      priority = 20;
      finishedForTask = null;
      errorKind = "retryable";
    } else {
      outcome = "failed";
      taskStatus = "failed";
      errorKind = attemptInGeneration >= 2 && isRetryable ? "retryable" : "terminal";
    }

    finishJobAnalysisAttemptRow(db, {
      attemptId: Number(attemptRow.id),
      status: "failed",
      provider: attemptRow.provider,
      model: attemptRow.model,
      modelConfigRevision: attemptRow.model_config_revision,
      thinkingMode: attemptRow.thinking_mode,
      reasoningEffort: attemptRow.reasoning_effort,
      backupUsed: attemptRow.backup_used,
      modelCallCount: usage.modelCallCount,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      latencyMs,
      errorCode: code,
      errorStage: stage,
      retryable: isConfigPause ? 0 : (isRetryable ? 1 : 0),
      finishedAt: finished,
      now: finished
    });

    const taskUpdate = failWorkflowJobTaskRow(db, {
      taskId: taskIdNum,
      leaseOwner: owner,
      status: taskStatus,
      errorCode: code,
      errorStage: stage,
      errorKind,
      priority,
      availableAt,
      finishedAt: finishedForTask,
      now: finished
    });
    if (Number(taskUpdate.changes) !== 1) {
      throw workflowTaskError(
        "WORKFLOW_TASK_NOT_RUNNING",
        `任务 ${taskIdNum} 不再是 running，失败提交未生效`
      );
    }

    if (outcome === "pause_requested") {
      requestWorkflowRunConfigurationPause(db, {
        workflowRunId: taskRow.workflow_run_id,
        now: finished
      });
      if (pauseReason) {
        db.prepare("UPDATE workflow_runs SET error_code = ? WHERE id = ?")
          .run(pauseReason, taskRow.workflow_run_id);
      }
    } else {
      if (outcome === "failed" && code === "MODEL_TIMEOUT" && attemptInGeneration >= 2) {
        incrementWorkflowTimeoutCounters(db, {
          workflowRunId: taskRow.workflow_run_id,
          now: finished,
          circuitThreshold: timeoutCircuitThreshold === undefined || timeoutCircuitThreshold === null
            ? PRODUCT_POLICY.operations.modelAnalysis.timeoutCircuitThreshold
            : Number(timeoutCircuitThreshold)
        });
      }
      incrementWorkflowRunActivity(db, {
        workflowRunId: taskRow.workflow_run_id,
        now: finished
      });
    }

    return {
      task: workflowJobTaskRow(getWorkflowJobTaskRow(db, taskIdNum)),
      workflow: getWorkflowRun(db, taskRow.workflow_run_id),
      outcome
    };
  });
}

function countWorkflowJobTaskStatusesForRun(db, workflowRunId) {
  return countWorkflowJobTaskStatuses(db, workflowRunId);
}

function earliestRetryAvailableAt(db, { workflowRunId, now }) {
  return selectEarliestRetryAvailableAt(db, { workflowRunId, now });
}

function markRemainingWorkflowJobTasksStopped(db, { workflowRunId, now }) {
  const result = markWorkflowJobTasksStopped(db, { workflowRunId, now });
  return { stopped: Number(result.changes || 0) };
}

function recoverExpiredWorkflowJobTasks(db, { workflowRunId, now }) {
  const normalizedNow = requiredIsoTime(now, "now");
  return immediateTransaction(db, () => {
    const workflow = getWorkflowRun(db, workflowRunId);
    if (!workflow || workflow.status !== "analyzing" || workflow.controlState !== "none") {
      return { recovered: 0, failed: 0 };
    }
    const rows = selectExpiredLeaseWorkflowJobTaskRows(db, {
      workflowRunId,
      now: normalizedNow
    });
    let recovered = 0;
    let failed = 0;
    for (const row of rows) {
      const attemptRow = getRunningJobAnalysisAttemptRow(db, row.id);
      if (!attemptRow) continue;
      const attemptInGeneration = Number(row.attemptCountInGeneration || 0);
      const isRetryable = attemptInGeneration < 2;
      const taskStatus = isRetryable ? "retry_pending" : "failed";

      finishJobAnalysisAttemptRow(db, {
        attemptId: Number(attemptRow.id),
        status: "failed",
        provider: attemptRow.provider,
        model: attemptRow.model,
        modelConfigRevision: attemptRow.model_config_revision,
        thinkingMode: attemptRow.thinking_mode,
        reasoningEffort: attemptRow.reasoning_effort,
        backupUsed: attemptRow.backup_used,
        modelCallCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: latencyBetween(attemptRow.started_at, normalizedNow),
        errorCode: LEASE_EXPIRED_ERROR_CODE,
        errorStage: LEASE_EXPIRED_ERROR_STAGE,
        retryable: 1,
        finishedAt: normalizedNow,
        now: normalizedNow
      });

      const taskUpdate = failWorkflowJobTaskRow(db, {
        taskId: row.id,
        leaseOwner: String(row.leaseOwner || ""),
        status: taskStatus,
        errorCode: LEASE_EXPIRED_ERROR_CODE,
        errorStage: LEASE_EXPIRED_ERROR_STAGE,
        errorKind: "lease_expired",
        priority: isRetryable ? 20 : null,
        availableAt: null,
        finishedAt: isRetryable ? null : normalizedNow,
        now: normalizedNow
      });
      if (Number(taskUpdate.changes) !== 1) continue;
      if (isRetryable) recovered += 1;
      else failed += 1;
    }
    // Recovery changes persisted task counts; advance the run snapshot once
    // per batch (never per task) so UI polling refreshes on the next read.
    if (recovered > 0 || failed > 0) {
      incrementWorkflowRunActivity(db, { workflowRunId, now: normalizedNow });
    }
    return { recovered, failed };
  });
}

function listWorkflowJobTasks(db, options = {}) {
  return listWorkflowJobTaskRows(db, {
    workflowRunId: options.workflowRunId,
    statuses: options.statuses,
    limit: options.limit
  });
}

function listJobAnalysisAttempts(db, options = {}) {
  const taskId = Number(options.taskId);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw workflowTaskError(
      "WORKFLOW_TASK_INVALID_TASK_ID",
      `taskId 必须是正整数：${options.taskId}，不允许退化为列出整个 workflow 的 attempts`
    );
  }
  return listJobAnalysisAttemptRows(db, {
    workflowRunId: options.workflowRunId,
    taskId,
    limit: options.limit
  });
}

function requireRunningTaskRow(db, taskId, owner) {
  const row = getWorkflowJobTaskRow(db, taskId);
  if (!row) {
    throw workflowTaskError("WORKFLOW_TASK_NOT_FOUND", `任务 ${taskId} 不存在`);
  }
  if (row.status !== "running") {
    throw workflowTaskError(
      "WORKFLOW_TASK_NOT_RUNNING",
      `任务 ${taskId} 状态为 ${row.status}，无法提交完成`
    );
  }
  if (String(row.lease_owner || "") !== owner) {
    throw workflowTaskError(
      "WORKFLOW_TASK_LEASE_OWNER_MISMATCH",
      `任务 ${taskId} 的租约属于其他 worker，无法提交完成`
    );
  }
  return row;
}

function requireWorkflowExists(db, workflowRunId) {
  const row = db.prepare("SELECT id FROM workflow_runs WHERE id = ?").get(workflowRunId);
  if (!row) {
    throw workflowTaskError("WORKFLOW_TASK_WORKFLOW_NOT_FOUND", `工作流 ${workflowRunId} 不存在`);
  }
}

function requiredTaskId(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw workflowTaskError("WORKFLOW_TASK_ID_INVALID", `taskId 必须是正整数：${value}`);
  }
  return parsed;
}

function requiredLeaseOwner(value) {
  const owner = String(value || "").trim();
  if (!owner) {
    throw workflowTaskError("WORKFLOW_TASK_LEASE_OWNER_REQUIRED", "提交任务必须提供 leaseOwner");
  }
  return owner;
}

function requiredIsoTime(value, label) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw workflowTaskError("WORKFLOW_TASK_INVALID_TIME", `${label} 必须是有效时间：${value}`);
  }
  return new Date(ms).toISOString();
}

function requiredModelIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw workflowTaskError(
      "WORKFLOW_TASK_MODEL_IDENTITY_INVALID",
      "成功提交必须提供 modelIdentity 对象"
    );
  }
  return identity;
}

function requireAnalyzedJob(analyzedJob, caller) {
  if (!analyzedJob || typeof analyzedJob !== "object" || Array.isArray(analyzedJob)) {
    throw workflowTaskError(
      "WORKFLOW_TASK_ANALYZED_JOB_INVALID",
      `${caller} 必须提供 analyzedJob 对象`
    );
  }
  if (!String(analyzedJob.source || "") || !String(analyzedJob.sourceId || "") || !String(analyzedJob.title || "")) {
    throw workflowTaskError(
      "WORKFLOW_TASK_ANALYZED_JOB_INVALID",
      `${caller} 的 analyzedJob 缺少 source/sourceId/title`
    );
  }
}

function validateAnalyzedJobIdentity(db, taskRow, analyzedJob, caller) {
  const authoritative = getWorkflowObservationJob(db, Number(taskRow.observation_id));
  if (!authoritative) {
    throw workflowTaskError(
      "WORKFLOW_TASK_OBSERVATION_NOT_FOUND",
      `任务 ${taskRow.id} 的固定 observation 不存在，无法校验 analyzedJob`
    );
  }
  const source = String(analyzedJob.source || "");
  const sourceId = String(analyzedJob.sourceId || "");
  if (String(authoritative.source || "") !== source || String(authoritative.sourceId || "") !== sourceId) {
    throw workflowTaskError(
      "WORKFLOW_TASK_ANALYZED_JOB_MISMATCH",
      `${caller} 的 analyzedJob source/sourceId 与任务固定 job/observation 不一致`
    );
  }
}

function validateCommitIdentity(identity, attemptRow) {
  const stringFields = [
    ["provider", "provider"],
    ["model", "model"],
    ["modelConfigRevision", "model_config_revision"],
    ["thinkingMode", "thinking_mode"],
    ["reasoningEffort", "reasoning_effort"]
  ];
  for (const [key, column] of stringFields) {
    if (identity[key] !== undefined && String(identity[key]) !== String(attemptRow[column])) {
      throw workflowTaskError(
        "WORKFLOW_TASK_MODEL_IDENTITY_MISMATCH",
        `modelIdentity.${key} 与 running attempt 已持久化的 ${column} 不一致`
      );
    }
  }
  if (identity.backupUsed !== undefined && Number(identity.backupUsed) !== Number(attemptRow.backup_used)) {
    throw workflowTaskError(
      "WORKFLOW_TASK_MODEL_IDENTITY_MISMATCH",
      "modelIdentity.backupUsed 与 running attempt 已持久化的 backup_used 不一致"
    );
  }
}

function validateStartedAtMatchesAttempt(startedAt, attemptRow) {
  if (startedAt !== attemptRow.started_at) {
    throw workflowTaskError(
      "WORKFLOW_TASK_STARTED_AT_MISMATCH",
      `startedAt 与 running attempt 已持久化的 started_at（${attemptRow.started_at}）不一致`
    );
  }
}

function normalizeTelemetry(telemetry) {
  const usage = telemetry && typeof telemetry === "object" ? telemetry : {};
  return {
    modelCallCount: nonNegativeInt(usage.modelCallCount),
    promptTokens: nonNegativeInt(usage.promptTokens),
    completionTokens: nonNegativeInt(usage.completionTokens),
    totalTokens: nonNegativeInt(usage.totalTokens)
  };
}

function nonNegativeInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function latencyBetween(startedAt, finishedAt) {
  return Math.max(0, Math.round(Date.parse(finishedAt) - Date.parse(startedAt)));
}

function initialTaskStatus(analysis) {
  const semantic = String(analysis.semanticStatus || "");
  const source = String(analysis.decisionSource || "");
  if (semantic === "complete" && source === "model") return "succeeded";
  if (source === "local_rules" || semantic === "rule_only") return "skipped";
  return "pending";
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text) || {};
  } catch {
    return {};
  }
}

function workflowTaskError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  initializeWorkflowJobTasks,
  claimWorkflowJobTask,
  commitWorkflowJobTaskSuccess,
  commitWorkflowJobTaskFailure,
  commitWorkflowJobTaskSkipped,
  recoverExpiredWorkflowJobTasks,
  countWorkflowJobTaskStatusesForRun,
  earliestRetryAvailableAt,
  markRemainingWorkflowJobTasksStopped,
  listWorkflowJobTasks,
  listJobAnalysisAttempts
};
