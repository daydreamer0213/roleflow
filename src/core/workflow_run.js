const { PRODUCT_POLICY } = require("./product_policy");
const {
  getWorkflowRun,
  listWorkflowRuns,
  getScanRun,
  interruptOrphanedScanRuns,
  transitionWorkflowRun
} = require("./storage");
const {
  getCommunicationBatch,
  setCommunicationBatchStatus,
  communicationBatchSummary
} = require("./communication_batches");

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

function chinaLocalDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw workflowError("WORKFLOW_DATE_INVALID", "Invalid workflow date.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function planWorkflowRun(input = {}) {
  const policy = { ...PRODUCT_POLICY.operations.workflow, ...(input.policy || {}) };
  const successfulToday = nonNegativeInteger(input.successfulToday);
  const completedRuns = nonNegativeInteger(input.completedRuns);
  const remainingRunSlots = Math.max(0, policy.maxRunsPerDay - completedRuns);
  const remainingDailyTarget = Math.max(0, policy.dailyTarget - successfulToday);

  if (!remainingRunSlots) {
    return blockedPlan("WORKFLOW_DAILY_RUN_LIMIT", {
      successfulToday,
      completedRuns,
      remainingRunSlots,
      remainingDailyTarget
    });
  }
  if (!remainingDailyTarget) {
    return blockedPlan("WORKFLOW_DAILY_TARGET_REACHED", {
      successfulToday,
      completedRuns,
      remainingRunSlots,
      remainingDailyTarget
    });
  }

  const targetSuccessCount = Math.min(
    policy.maxRunTarget,
    Math.ceil(remainingDailyTarget / remainingRunSlots)
  );
  const inventoryCount = nonNegativeInteger(input.inventoryCount);
  const candidateGap = Math.max(0, targetSuccessCount - inventoryCount);
  const budget = fairBudget(input, remainingRunSlots);
  const scanNeeded = candidateGap > 0 && budget.maxDetailTotal > 0 && budget.browserPageBudget > 0;
  const selectedKeywords = scanNeeded
    ? selectKeywords(input.keywords, remainingRunSlots, policy, budget.maxDetailTotal)
    : [];
  const projectedNewCandidates = projectedCandidates(selectedKeywords, policy);

  return {
    errorCode: null,
    localDay: input.localDay || chinaLocalDay(input.now || new Date()),
    successfulToday,
    completedRuns,
    remainingRunSlots,
    remainingDailyTarget,
    targetSuccessCount,
    replacementBuffer: policy.replacementBuffer,
    inventoryCount,
    candidateGap,
    scanNeeded: scanNeeded && selectedKeywords.length > 0,
    selectedKeywords,
    budget,
    projectedNewCandidates,
    projectedInventoryCount: inventoryCount + projectedNewCandidates,
    shortfallReason: shortfallReason({ candidateGap, scanNeeded, selectedKeywords, projectedNewCandidates, budget })
  };
}

function fairBudget(input, remainingRunSlots) {
  const daily = input.dailyBudget || {};
  const used = input.usedBudget || {};
  const remainingDetails = Math.max(0, nonNegativeInteger(daily.details ?? PRODUCT_POLICY.dailyScan.maxDetailTotal)
    - nonNegativeInteger(used.details));
  const remainingPages = Math.max(0, nonNegativeInteger(daily.pages ?? PRODUCT_POLICY.dailyScan.browserPageBudget)
    - nonNegativeInteger(used.pages));
  return {
    maxDetailTotal: Math.floor(remainingDetails / remainingRunSlots),
    browserPageBudget: Math.floor(remainingPages / remainingRunSlots)
  };
}

function selectKeywords(keywords = [], remainingRunSlots, policy, detailBudget) {
  const normalized = (Array.isArray(keywords) ? keywords : [])
    .map((item, index) => normalizeKeyword(item, index, policy))
    .filter((item) => item.word);
  const unused = normalized.filter((item) => !item.usedToday);
  const pool = unused.length ? unused : normalized;
  const fairCount = unused.length
    ? Math.ceil(unused.length / remainingRunSlots)
    : policy.maxKeywordsPerRun;
  const selected = pool
    .sort(compareKeywords)
    .slice(0, Math.min(policy.maxKeywordsPerRun, Math.max(1, fairCount)));
  const detailAllocations = allocateDetails(
    Math.max(0, nonNegativeInteger(detailBudget)),
    selected.map((item) => item.detailCap)
  );
  return selected.map((item, index) => ({
    word: item.word,
    priority: item.priority,
    planOrder: item.planOrder,
    usedToday: item.usedToday,
    sampleSize: item.sampleSize,
    eligibleCount: item.eligibleCount,
    measuredYield: item.measuredYield,
    maxCards: item.maxCards,
    maxDetails: detailAllocations[index]
  }));
}

function normalizeKeyword(item, index, policy) {
  const source = typeof item === "string" ? { word: item } : (item || {});
  const priority = ["A", "B", "C"].includes(source.priority) ? source.priority : "B";
  const sampleSize = nonNegativeInteger(source.sampleSize);
  const eligibleCount = Math.min(sampleSize, nonNegativeInteger(source.eligibleCount));
  const measuredYield = sampleSize >= policy.minimumYieldSample ? eligibleCount / sampleSize : null;
  const ratio = PRODUCT_POLICY.searchPlan.priorityCardRatios[priority] || 0;
  return {
    word: String(source.word || "").trim(),
    priority,
    planOrder: Number.isFinite(Number(source.planOrder)) ? Number(source.planOrder) : index,
    usedToday: Boolean(source.usedToday),
    sampleSize,
    eligibleCount,
    measuredYield,
    maxCards: Math.round(PRODUCT_POLICY.dailyScan.maxCards * ratio),
    detailCap: nonNegativeInteger(PRODUCT_POLICY.dailyScan.detailLimits[priority] || 0)
  };
}

function compareKeywords(a, b) {
  const aKnown = a.measuredYield !== null;
  const bKnown = b.measuredYield !== null;
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  if (aKnown && a.measuredYield !== b.measuredYield) return b.measuredYield - a.measuredYield;
  return priorityRank(a.priority) - priorityRank(b.priority)
    || a.planOrder - b.planOrder
    || a.word.localeCompare(b.word, "zh-CN");
}

function allocateDetails(total, caps) {
  const allocations = caps.map(() => 0);
  let remaining = Math.min(total, caps.reduce((sum, value) => sum + value, 0));
  let active = caps.map((_, index) => index).filter((index) => caps[index] > 0);
  while (remaining > 0 && active.length) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    let allocated = 0;
    for (const index of active) {
      const amount = Math.min(share, caps[index] - allocations[index], remaining - allocated);
      allocations[index] += amount;
      allocated += amount;
      if (allocated >= remaining) break;
    }
    if (!allocated) break;
    remaining -= allocated;
    active = active.filter((index) => allocations[index] < caps[index]);
  }
  return allocations;
}

function projectedCandidates(selectedKeywords, policy) {
  return Math.floor(selectedKeywords.reduce((sum, item) => {
    const yieldRate = item.measuredYield === null ? policy.fallbackYield : item.measuredYield;
    return sum + Math.min(item.maxCards, item.maxDetails) * yieldRate;
  }, 0));
}

function shortfallReason({ candidateGap, scanNeeded, selectedKeywords, projectedNewCandidates, budget }) {
  if (!candidateGap) return null;
  if (!scanNeeded) return "WORKFLOW_SCAN_BUDGET_EMPTY";
  if (!selectedKeywords.length) return "WORKFLOW_NO_KEYWORDS";
  if (projectedNewCandidates < candidateGap) return "WORKFLOW_PROJECTED_SUPPLY_SHORTFALL";
  if (!budget.maxDetailTotal || !budget.browserPageBudget) return "WORKFLOW_SCAN_BUDGET_EMPTY";
  return null;
}

function blockedPlan(errorCode, state) {
  return {
    errorCode,
    ...state,
    targetSuccessCount: 0,
    replacementBuffer: 0,
    inventoryCount: 0,
    candidateGap: 0,
    scanNeeded: false,
    selectedKeywords: [],
    budget: { maxDetailTotal: 0, browserPageBudget: 0 },
    projectedNewCandidates: 0,
    projectedInventoryCount: 0,
    shortfallReason: null
  };
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function priorityRank(priority) {
  return { A: 0, B: 1, C: 2 }[priority] ?? 9;
}

function workflowError(code, message) {
  return Object.assign(new Error(message), { code });
}

function recoverWorkflowRuns(db, input = {}) {
  const now = workflowDate(input.now || new Date());
  const orphanTimeoutMs = Math.max(0, Number(
    input.orphanTimeoutMs ?? PRODUCT_POLICY.operations.scanOrphanTimeoutMs
  ));
  const orphaned = interruptOrphanedScanRuns(db, {
    site: input.site || "boss",
    now,
    heartbeatTimeoutMs: orphanTimeoutMs
  });
  const runs = recoverableRuns(db, input);
  const report = {
    inspected: runs.length,
    scanRunsInterrupted: orphaned.interrupted,
    workflowRunsInterrupted: 0,
    workflowRunsCompleted: 0,
    reviewRunsPreserved: 0,
    activeRunsPreserved: 0,
    browserActionsStarted: 0
  };

  for (const run of runs) {
    if (run.status === "created") {
      if (isOlderThan(run.updatedAt, now, orphanTimeoutMs)) {
        transitionWorkflowRun(db, {
          id: run.id,
          status: "interrupted",
          errorCode: "WORKFLOW_CHILD_NOT_STARTED",
          errorMessage: "workflow child process was not started"
        });
        report.workflowRunsInterrupted += 1;
      } else {
        report.activeRunsPreserved += 1;
      }
      continue;
    }
    if (run.status === "review_required") {
      report.reviewRunsPreserved += 1;
      continue;
    }
    if (["scanning", "analyzing"].includes(run.status)) {
      recoverScanWorkflow(db, run, report, { now, orphanTimeoutMs });
      continue;
    }
    if (run.status === "communicating") {
      recoverCommunicationWorkflow(db, run, report, { now, orphanTimeoutMs });
      continue;
    }
    report.activeRunsPreserved += 1;
  }
  return report;
}

function recoverableRuns(db, input) {
  const workflowRunId = String(input.workflowRunId || "").trim();
  if (workflowRunId) {
    const run = getWorkflowRun(db, workflowRunId);
    return run && !["completed", "failed", "stopped"].includes(run.status) ? [run] : [];
  }
  return listWorkflowRuns(db, {
    profileId: input.profileId,
    planId: input.planId,
    statuses: ["created", "scanning", "analyzing", "review_required", "communicating", "interrupted"],
    limit: 500
  });
}

function recoverScanWorkflow(db, run, report, { now, orphanTimeoutMs }) {
  const scan = run.scanRunId ? getScanRun(db, run.scanRunId) : null;
  if (!scan) {
    if (isOlderThan(run.updatedAt, now, orphanTimeoutMs)) {
      transitionWorkflowRun(db, {
        id: run.id,
        status: "interrupted",
        errorCode: "SCAN_RUN_MISSING",
        errorMessage: "workflow scan child record is missing"
      });
      report.workflowRunsInterrupted += 1;
    } else {
      report.activeRunsPreserved += 1;
    }
    return;
  }
  if (scan.status === "running") {
    report.activeRunsPreserved += 1;
    return;
  }
  transitionWorkflowRun(db, {
    id: run.id,
    status: "interrupted",
    errorCode: scan.stopCode || `SCAN_RUN_${String(scan.status).toUpperCase()}`,
    errorMessage: scan.stopMessage || `scan run ended as ${scan.status}`
  });
  report.workflowRunsInterrupted += 1;
}

function recoverCommunicationWorkflow(db, run, report, { now, orphanTimeoutMs }) {
  const batch = run.communicationBatchId ? getCommunicationBatch(db, run.communicationBatchId) : null;
  if (!batch) {
    if (isOlderThan(run.updatedAt, now, orphanTimeoutMs)) {
      transitionWorkflowRun(db, {
        id: run.id,
        status: "interrupted",
        errorCode: "COMMUNICATION_BATCH_MISSING",
        errorMessage: "communication batch link is missing"
      });
      report.workflowRunsInterrupted += 1;
    } else {
      report.activeRunsPreserved += 1;
    }
    return;
  }
  if (batch.status === "completed") {
    const summary = communicationBatchSummary(db, batch.id);
    const succeeded = Number(summary.statusCounts.succeeded || 0)
      + Number(summary.statusCounts.already_communicated || 0);
    transitionWorkflowRun(db, {
      id: run.id,
      status: "completed",
      successfulCount: succeeded,
      shortfallCode: succeeded >= run.targetSuccessCount ? "" : "WORKFLOW_SUPPLY_EXHAUSTED",
      metrics: communicationWorkflowMetrics(run, summary, batch)
    });
    report.workflowRunsCompleted += 1;
    return;
  }
  if (["interrupted", "failed", "stopped"].includes(batch.status)) {
    const summary = communicationBatchSummary(db, batch.id);
    transitionWorkflowRun(db, {
      id: run.id,
      status: batch.status,
      successfulCount: successfulCount(summary),
      metrics: communicationWorkflowMetrics(run, summary, batch),
      errorCode: batch.stopCode || `COMMUNICATION_BATCH_${batch.status.toUpperCase()}`,
      errorMessage: batch.stopMessage || `communication batch ended as ${batch.status}`
    });
    if (batch.status === "interrupted") report.workflowRunsInterrupted += 1;
    return;
  }
  if (["running", "stopping"].includes(batch.status) && isOlderThan(batch.updatedAt, now, orphanTimeoutMs)) {
    const interruptedBatch = setCommunicationBatchStatus(db, {
      batchId: batch.id,
      status: "interrupted",
      now,
      stopCode: "COMMUNICATION_RUN_ORPHANED",
      stopMessage: "communication batch activity expired"
    });
    const summary = communicationBatchSummary(db, batch.id);
    transitionWorkflowRun(db, {
      id: run.id,
      status: "interrupted",
      successfulCount: successfulCount(summary),
      metrics: communicationWorkflowMetrics(run, summary, interruptedBatch),
      errorCode: "COMMUNICATION_RUN_ORPHANED",
      errorMessage: "communication batch activity expired"
    });
    report.workflowRunsInterrupted += 1;
    return;
  }
  report.activeRunsPreserved += 1;
}

function communicationWorkflowMetrics(run, summary, batch) {
  const counts = summary.statusCounts;
  const succeeded = successfulCount(summary);
  const finishedAt = workflowDate(batch.finishedAt || batch.updatedAt || new Date());
  const startedAt = workflowDate(run.startedAt || run.createdAt);
  return {
    ...run.metrics,
    selected: summary.total,
    succeeded,
    unavailable: Number(counts.job_unavailable || 0),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    communication: {
      batchId: batch.id,
      selected: summary.total,
      succeeded,
      alreadyCommunicated: Number(counts.already_communicated || 0),
      unavailable: Number(counts.job_unavailable || 0),
      targetMismatch: Number(counts.target_mismatch || 0),
      actionUnavailable: Number(counts.action_unavailable || 0),
      ambiguous: Number(counts.ambiguous || 0),
      stopped: Number(counts.stopped || 0),
      target: run.targetSuccessCount
    }
  };
}

function successfulCount(summary) {
  return Number(summary.statusCounts.succeeded || 0)
    + Number(summary.statusCounts.already_communicated || 0);
}

function isOlderThan(value, now, timeoutMs) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) && timestamp <= now.getTime() - timeoutMs;
}

function workflowDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw workflowError("WORKFLOW_DATE_INVALID", "Invalid workflow date.");
  return date;
}

module.exports = {
  SHANGHAI_TIME_ZONE,
  chinaLocalDay,
  planWorkflowRun,
  selectKeywords,
  recoverWorkflowRuns,
  communicationWorkflowMetrics
};
