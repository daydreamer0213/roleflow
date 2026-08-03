const HEALTH_ISSUE_CODES = Object.freeze({
  JOB_MISSING_JD: "job_missing_jd",
  ANALYSIS_INCOMPLETE: "analysis_incomplete",
  ANALYSIS_OUTDATED: "analysis_outdated",
  FOLLOW_UP_OVERDUE: "follow_up_overdue",
  POSSIBLE_DUPLICATE: "possible_duplicate",
  WORKFLOW_STALLED: "workflow_stalled",
  WORKFLOW_LINK_MISMATCH: "workflow_link_mismatch"
});

const RUNNING_WORKFLOW_STATUSES = new Set([
  "created",
  "scanning",
  "analyzing",
  "communicating"
]);

const SEVERITY_ORDER = Object.freeze({
  critical: 0,
  warning: 1,
  info: 2
});

function buildWorkflowHealthReport(snapshot = {}, options = {}) {
  const generatedAt = String(snapshot.generatedAt || options.now || new Date().toISOString());
  const now = validTimestamp(options.now || generatedAt);
  const minimumJdCharacters = positiveInteger(options.minimumJdCharacters, 120);
  const runningWorkflowStaleMs = positiveInteger(
    options.runningWorkflowStaleMs,
    6 * 60 * 60 * 1000
  );
  const jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
  const workflowRuns = Array.isArray(snapshot.workflowRuns) ? snapshot.workflowRuns : [];
  const candidateEvents = Array.isArray(snapshot.candidateEvents)
    ? snapshot.candidateEvents
    : [];
  const linkIssues = Array.isArray(snapshot.linkIssues) ? snapshot.linkIssues : [];
  const issues = [];

  for (const job of jobs) {
    const jobId = String(job.id || "");
    const actionHref = `/queue?planId=${encodeURIComponent(snapshot.planId || "")}`
      + `&jobId=${encodeURIComponent(jobId)}`;
    const descriptionCharacters = String(job.description || "").trim().length;
    if (descriptionCharacters < minimumJdCharacters) {
      issues.push(issue({
        code: HEALTH_ISSUE_CODES.JOB_MISSING_JD,
        severity: "warning",
        entityType: "job",
        entityId: jobId,
        title: "岗位缺少完整 JD",
        message: jobLabel(job),
        actionHref,
        details: { descriptionCharacters }
      }));
    }

    if (String(job.analysis?.semanticStatus || "") !== "complete") {
      issues.push(issue({
        code: HEALTH_ISSUE_CODES.ANALYSIS_INCOMPLETE,
        severity: "warning",
        entityType: "job",
        entityId: jobId,
        title: "岗位尚未完成语义分析",
        message: jobLabel(job),
        actionHref,
        details: { semanticStatus: String(job.analysis?.semanticStatus || "missing") }
      }));
    }

    const qualityTags = new Set(Array.isArray(job.qualityTags) ? job.qualityTags : []);
    if (qualityTags.has("detail_changed") || qualityTags.has("needs_recheck")) {
      issues.push(issue({
        code: HEALTH_ISSUE_CODES.ANALYSIS_OUTDATED,
        severity: "warning",
        entityType: "job",
        entityId: jobId,
        title: "岗位内容变化，需要重新检查分析",
        message: jobLabel(job),
        actionHref,
        details: {
          reasons: [...qualityTags].filter((tag) =>
            ["detail_changed", "needs_recheck"].includes(tag)
          )
        }
      }));
    }

    if (qualityTags.has("possible_duplicate")) {
      issues.push(issue({
        code: HEALTH_ISSUE_CODES.POSSIBLE_DUPLICATE,
        severity: "info",
        entityType: "job",
        entityId: jobId,
        title: "岗位可能与已有记录重复",
        message: jobLabel(job),
        actionHref,
        details: {}
      }));
    }

    if (String(job.applicationStatus || "") === "later"
      && isOverdue(job.reviewAt, now)) {
      issues.push(issue({
        code: HEALTH_ISSUE_CODES.FOLLOW_UP_OVERDUE,
        severity: "warning",
        entityType: "job",
        entityId: jobId,
        title: "岗位已到计划复查时间",
        message: jobLabel(job),
        actionHref,
        details: { reviewAt: String(job.reviewAt || "") }
      }));
    }
  }

  for (const workflow of workflowRuns) {
    const updatedAt = Date.parse(workflow.updatedAt || "");
    if (RUNNING_WORKFLOW_STATUSES.has(String(workflow.status || ""))
      && Number.isFinite(updatedAt)
      && now - updatedAt > runningWorkflowStaleMs) {
      issues.push(issue({
        code: HEALTH_ISSUE_CODES.WORKFLOW_STALLED,
        severity: "warning",
        entityType: "workflow",
        entityId: String(workflow.id || ""),
        title: "工作流长时间没有更新",
        message: `状态：${String(workflow.status || "unknown")}`,
        actionHref: `/workflow?runId=${encodeURIComponent(workflow.id || "")}`,
        details: { updatedAt: String(workflow.updatedAt || "") }
      }));
    }
  }

  for (const linkIssue of linkIssues) {
    issues.push(issue({
      code: HEALTH_ISSUE_CODES.WORKFLOW_LINK_MISMATCH,
      severity: "critical",
      entityType: "workflow",
      entityId: String(linkIssue.workflowId || ""),
      title: "工作流关联记录不一致",
      message: String(linkIssue.reason || "unknown_link_mismatch"),
      actionHref: `/workflow?runId=${encodeURIComponent(linkIssue.workflowId || "")}`,
      details: { reason: String(linkIssue.reason || "") }
    }));
  }

  issues.sort(compareIssues);
  const severityCounts = { critical: 0, warning: 0, info: 0 };
  for (const item of issues) severityCounts[item.severity] += 1;

  return Object.freeze({
    status: severityCounts.critical > 0
      ? "blocked"
      : severityCounts.warning > 0 ? "attention" : "healthy",
    generatedAt,
    summary: Object.freeze({
      jobsChecked: jobs.length,
      workflowRunsChecked: workflowRuns.length,
      issueCount: issues.length,
      ...severityCounts
    }),
    issues: Object.freeze(issues),
    recentEvents: Object.freeze(candidateEvents
      .slice()
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
        || Number(b.id || 0) - Number(a.id || 0))
      .slice(0, 20)),
    truncated: Object.freeze({
      jobs: Boolean(snapshot.truncated?.jobs),
      workflowRuns: Boolean(snapshot.truncated?.workflowRuns),
      candidateEvents: Boolean(snapshot.truncated?.candidateEvents)
    })
  });
}

function issue(value) {
  return Object.freeze({
    code: value.code,
    severity: value.severity,
    entityType: value.entityType,
    entityId: value.entityId,
    title: value.title,
    message: value.message,
    actionHref: value.actionHref,
    details: Object.freeze(value.details || {})
  });
}

function compareIssues(a, b) {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || a.code.localeCompare(b.code)
    || a.entityId.localeCompare(b.entityId);
}

function jobLabel(job) {
  return [job.title, job.company].filter(Boolean).join(" · ") || `岗位 #${job.id}`;
}

function isOverdue(value, now) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw < chinaLocalDay(now);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) && timestamp < now;
}

function chinaLocalDay(timestamp) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(timestamp));
}

function validTimestamp(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) throw new Error("workflow health now is invalid");
  return timestamp;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

module.exports = {
  HEALTH_ISSUE_CODES,
  buildWorkflowHealthReport
};
