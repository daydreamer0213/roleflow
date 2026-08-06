"use strict";

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
  workflowJobTaskRow,
  jobAnalysisAttemptRow,
  listWorkflowJobTaskRows,
  listJobAnalysisAttemptRows
} = require("./storage");

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
  if (typeof selectModelIdentity !== "function") {
    throw workflowTaskError("WORKFLOW_TASK_MODEL_IDENTITY_REQUIRED", "必须提供 selectModelIdentity");
  }

  return immediateTransaction(db, () => {
    const workflow = getWorkflowRun(db, workflowRunId);
    if (!workflow || workflow.status !== "analyzing" || workflow.controlState !== "none") {
      return null;
    }
    const candidate = selectClaimableWorkflowJobTaskRow(db, { workflowRunId, now: clock });
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
      leasedAt: clock,
      leaseExpiresAt,
      attemptCountInGeneration: attemptInGeneration,
      totalAttemptCount: totalAttemptNumber,
      lastAttemptModelRevision: modelConfigRevision,
      now: clock
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
      startedAt: clock,
      now: clock
    });
    incrementWorkflowRunActivity(db, { workflowRunId, now: clock });

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

function listWorkflowJobTasks(db, options = {}) {
  return listWorkflowJobTaskRows(db, {
    workflowRunId: options.workflowRunId,
    statuses: options.statuses,
    limit: options.limit
  });
}

function listJobAnalysisAttempts(db, options = {}) {
  return listJobAnalysisAttemptRows(db, {
    workflowRunId: options.workflowRunId,
    taskId: options.taskId,
    limit: options.limit
  });
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
  listWorkflowJobTasks,
  listJobAnalysisAttempts
};
