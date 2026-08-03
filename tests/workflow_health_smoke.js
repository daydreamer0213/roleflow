const assert = require("node:assert");
const {
  HEALTH_ISSUE_CODES,
  buildWorkflowHealthReport
} = require("../src/core/workflow_health");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SCHEMA_VERSION,
  openDb,
  saveProfileAnalysis,
  createMatchingCardDraft,
  confirmMatchingCard,
  createBatch,
  upsertJob,
  markCandidateJob,
  recordCandidateJobEvent,
  createWorkflowRun,
  getWorkflowHealthSnapshot
} = require("../src/core/storage");
const { matchingCardFromProfile } = require("../src/core/matching_card");

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-workflow-health-"));
const dbPath = path.join(root, "jobs.sqlite");
let db;

try {
  db = openDb(dbPath);
  const profile = {
    candidate: { name: "Health Candidate", city: "Guangzhou", targetTitles: ["Product Operations"] },
    education: [], experiences: [], skills: [], projects: [], credentials: [], strengths: []
  };
  const saved = saveProfileAnalysis(db, {
    profile,
    document: {
      originalFileName: "health.txt", format: "text", contentHash: "health-resume",
      text: "Offline health smoke resume content.".repeat(20), diagnostics: {}
    },
    searchPlan: {
      name: "Health check plan", cities: ["Guangzhou"], directions: ["Product Operations"],
      keywords: [{ word: "Product Operations", priority: "A", reason: "test" }],
      salary: { minK: 8, maxK: 15 }, experience: ["1-3 years"], jobTypes: ["full-time"],
      degrees: [], bossActiveDays: 3, platform: { site: "boss" }
    }
  });
  const card = createMatchingCardDraft(db, {
    profileId: saved.profileId, profileVersionId: saved.profileVersionId,
    resumeDocumentId: saved.resumeDocumentId, resumeContentHash: "health-resume",
    card: matchingCardFromProfile(profile), source: "migration"
  });
  confirmMatchingCard(db, { profileId: saved.profileId, cardId: card.id });

  const batchId = createBatch(db, "boss", "Product Operations", "health fixture", {
    profileId: saved.profileId, searchPlanId: saved.planId
  });
  const jobId = upsertJob(db, {
    source: "boss", sourceId: "health-job-1", keyword: "Product Operations",
    title: "Product Operations", company: "Test Company", location: "Guangzhou",
    salary: "8-12K", experience: "1-3 years", education: "Bachelor",
    url: "https://example.test/job/health-job-1", description: "Short JD", tags: [],
    matches: [], risks: [], qualityTags: [],
    analysis: { semanticStatus: "pending", recommendation: "caution" }
  }, batchId);
  markCandidateJob(db, {
    profileId: saved.profileId, planId: saved.planId, jobId, status: "later", reviewAt: "2026-08-02"
  });
  createWorkflowRun(db, {
    id: "health-workflow", profileId: saved.profileId, planId: saved.planId,
    localDay: "2026-08-03", sequence: 1, targetSuccessCount: 10, successfulCount: 0,
    inventoryCount: 1, candidateGap: 9, scanNeeded: true, keywords: [], budget: {},
    planner: {}, metrics: {}, createdAt: "2026-08-03T07:00:00.000Z"
  });

  const changesBefore = db.prepare("SELECT total_changes() AS count").get().count;
  const storedSchemaVersion = db.prepare("PRAGMA user_version").get().user_version;
  const storedJobAnalysis = db.prepare(
    "SELECT analysis_json FROM job_observations WHERE job_id = ? ORDER BY id DESC LIMIT 1"
  ).get(jobId).analysis_json;

  const healthSnapshot = getWorkflowHealthSnapshot(db, {
    profileId: saved.profileId, planId: saved.planId, now, jobLimit: 1, workflowLimit: 1, eventLimit: 1
  });

  const changesAfter = db.prepare("SELECT total_changes() AS count").get().count;
  assert.strictEqual(changesAfter, changesBefore, "health snapshot must be read-only");
  assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.strictEqual(storedSchemaVersion, SCHEMA_VERSION);
  assert.strictEqual(db.prepare(
    "SELECT analysis_json FROM job_observations WHERE job_id = ? ORDER BY id DESC LIMIT 1"
  ).get(jobId).analysis_json, storedJobAnalysis, "health snapshot must not modify matching analysis");
  assert.strictEqual(healthSnapshot.profileId, saved.profileId);
  assert.strictEqual(healthSnapshot.planId, saved.planId);
  assert.strictEqual(healthSnapshot.jobs.length, 1);
  assert.strictEqual(healthSnapshot.workflowRuns.length, 1);
  assert.strictEqual(healthSnapshot.candidateEvents.length, 1);
  assert.strictEqual(healthSnapshot.candidateEvents[0].eventType, "later");
  assert.deepStrictEqual(healthSnapshot.truncated, {
    jobs: false, workflowRuns: false, candidateEvents: false
  });

  const storedReport = buildWorkflowHealthReport(healthSnapshot, { now });
  assert(storedReport.issues.some((item) => item.code === HEALTH_ISSUE_CODES.JOB_MISSING_JD));
  assert(storedReport.issues.some((item) => item.code === HEALTH_ISSUE_CODES.FOLLOW_UP_OVERDUE));
  assert.throws(() => getWorkflowHealthSnapshot(db, {
    profileId: saved.profileId + 1, planId: saved.planId
  }), /does not belong to the selected profile/);

  const otherPlanId = Number(db.prepare(`
    INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    saved.profileId,
    "Other health plan",
    JSON.stringify({ name: "Other health plan" }),
    "2026-08-03T08:01:00.000Z",
    "2026-08-03T08:01:00.000Z"
  ).lastInsertRowid);
  const otherBatchId = createBatch(db, "boss", "Other plan", "other plan fixture", {
    profileId: saved.profileId, searchPlanId: otherPlanId
  });
  db.prepare("UPDATE workflow_runs SET scan_batch_id = ? WHERE id = ?")
    .run(otherBatchId, "health-workflow");
  const secondJobId = upsertJob(db, {
    source: "boss", sourceId: "health-job-2", keyword: "Product Operations",
    title: "Product Operations 2", company: "Test Company", location: "Guangzhou",
    salary: "8-12K", experience: "1-3 years", education: "Bachelor",
    url: "https://example.test/job/health-job-2", description: "Complete JD ".repeat(20),
    tags: [], matches: [], risks: [], qualityTags: [], analysis: {}
  }, batchId);
  recordCandidateJobEvent(db, {
    profileId: saved.profileId, planId: saved.planId, jobId: secondJobId,
    eventType: "review", payload: {}
  });
  recordCandidateJobEvent(db, {
    profileId: saved.profileId, planId: null, jobId: secondJobId,
    eventType: "review", payload: { legacy: true }
  });
  recordCandidateJobEvent(db, {
    profileId: saved.profileId, planId: otherPlanId, jobId: secondJobId,
    eventType: "review", payload: { otherPlan: true }
  });
  createWorkflowRun(db, {
    id: "health-workflow-new", profileId: saved.profileId, planId: saved.planId,
    localDay: "2026-08-04", sequence: 1, targetSuccessCount: 10, successfulCount: 0,
    inventoryCount: 2, candidateGap: 8, scanNeeded: true, keywords: [], budget: {},
    planner: {}, metrics: {}, createdAt: "2026-08-03T08:02:00.000Z"
  });

  const boundedSnapshot = getWorkflowHealthSnapshot(db, {
    profileId: saved.profileId, planId: saved.planId, now,
    jobLimit: 1, workflowLimit: 1, eventLimit: 2
  });
  assert.deepStrictEqual(boundedSnapshot.truncated, {
    jobs: true, workflowRuns: true, candidateEvents: true
  });
  assert.strictEqual(boundedSnapshot.jobs.length, 1);
  assert.strictEqual(boundedSnapshot.workflowRuns.length, 1);
  assert.strictEqual(boundedSnapshot.candidateEvents.length, 2);
  assert(boundedSnapshot.candidateEvents.some((event) => event.planId === null));
  assert(boundedSnapshot.candidateEvents.every((event) => event.planId !== otherPlanId));
  const selectedWorkflowIds = new Set(boundedSnapshot.workflowRuns.map((run) => run.id));
  assert(boundedSnapshot.linkIssues.every((issue) => selectedWorkflowIds.has(issue.workflowId)));

  console.log("workflow_health_smoke ok");
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
