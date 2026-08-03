const assert = require("node:assert");
const {
  HEALTH_ISSUE_CODES,
  buildWorkflowHealthReport
} = require("../src/core/workflow_health");

const now = "2026-08-03T08:00:00.000Z";
const snapshot = {
  generatedAt: now,
  profileId: 1,
  planId: 7,
  jobs: [
    {
      id: 11,
      title: "岗位 A",
      company: "公司 A",
      description: "短 JD",
      applicationStatus: "pending",
      reviewAt: "",
      qualityTags: [],
      analysis: { semanticStatus: "complete", recommendation: "apply" }
    },
    {
      id: 12,
      title: "岗位 B",
      company: "公司 B",
      description: "完整岗位职责和任职要求。".repeat(20),
      applicationStatus: "later",
      reviewAt: "2026-08-02",
      qualityTags: ["detail_changed", "possible_duplicate"],
      analysis: { semanticStatus: "pending", recommendation: "primary" }
    }
  ],
  workflowRuns: [
    {
      id: "workflow-stalled",
      status: "analyzing",
      updatedAt: "2026-08-02T20:00:00.000Z"
    },
    {
      id: "workflow-review",
      status: "review_required",
      updatedAt: "2026-08-01T08:00:00.000Z"
    }
  ],
  candidateEvents: [
    {
      id: 91,
      profileId: 1,
      jobId: 12,
      planId: 7,
      eventType: "later",
      payload: { reviewAt: "2026-08-02" },
      createdAt: "2026-08-01T08:00:00.000Z"
    }
  ],
  linkIssues: [
    {
      workflowId: "workflow-link-bad",
      reason: "scan_plan_mismatch"
    }
  ],
  truncated: { jobs: false, workflowRuns: false, candidateEvents: false }
};

const report = buildWorkflowHealthReport(snapshot, { now });
const codes = report.issues.map((issue) => issue.code);

assert.strictEqual(report.status, "blocked");
assert(codes.includes(HEALTH_ISSUE_CODES.JOB_MISSING_JD));
assert(codes.includes(HEALTH_ISSUE_CODES.ANALYSIS_INCOMPLETE));
assert(codes.includes(HEALTH_ISSUE_CODES.ANALYSIS_OUTDATED));
assert(codes.includes(HEALTH_ISSUE_CODES.FOLLOW_UP_OVERDUE));
assert(codes.includes(HEALTH_ISSUE_CODES.POSSIBLE_DUPLICATE));
assert(codes.includes(HEALTH_ISSUE_CODES.WORKFLOW_STALLED));
assert(codes.includes(HEALTH_ISSUE_CODES.WORKFLOW_LINK_MISMATCH));
assert.strictEqual(
  report.issues.some((issue) => issue.entityId === "workflow-review"
    && issue.code === HEALTH_ISSUE_CODES.WORKFLOW_STALLED),
  false,
  "review_required must not be reported as stalled"
);
assert.deepStrictEqual(report.recentEvents.map((event) => event.id), [91]);
assert.deepStrictEqual(report.truncated, snapshot.truncated);

const healthy = buildWorkflowHealthReport({
  generatedAt: now,
  profileId: 1,
  planId: 7,
  jobs: [{
    id: 13,
    title: "岗位 C",
    company: "公司 C",
    description: "完整岗位职责和任职要求。".repeat(20),
    applicationStatus: "pending",
    reviewAt: "",
    qualityTags: [],
    analysis: { semanticStatus: "complete", recommendation: "apply" }
  }],
  workflowRuns: [],
  candidateEvents: [],
  linkIssues: [],
  truncated: { jobs: false, workflowRuns: false, candidateEvents: false }
}, { now });

assert.strictEqual(healthy.status, "healthy");
assert.strictEqual(healthy.issues.length, 0);
assert.strictEqual(healthy.summary.jobsChecked, 1);
