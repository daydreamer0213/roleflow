# Workflow Progress and Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有工作流页面增加只读的求职进度与系统体检报告，复用已有岗位、状态事件、工作流和分析结果，发现缺失 JD、待分析、分析过期、逾期跟进、疑似重复和工作流关联异常。

**Architecture:** `src/core/storage.js` 只负责从现有表读取一个有界、不可变的健康快照；新的 `src/core/workflow_health.js` 使用确定性代码把快照转换为健康报告；新的视图模块只负责转义并渲染报告。整个功能不新增数据库表、不调用模型、不访问 BOSS，也不改变四档决策和默认沟通选择。

**Tech Stack:** Node.js 22.5+、CommonJS、`node:sqlite`、现有无框架 HTML 仪表盘、现有 smoke test runner。

## Global Constraints

- 补充为主，覆盖为例外；复用现有数据，扩展现有界面，不建立第二套系统。
- `主投`、`可投`、`慎投`、`不推荐`继续是唯一四档推荐。
- 不修改模型提示词、结构化输出契约、二维表、核心权重或严重偏差定义。
- 不新增模型调用，不访问 BOSS，不读取 Cookie 或 Token，不调用 BOSS 内部接口。
- 不修改默认沟通勾选规则，不扩大真实沟通权限。
- 不新增数据库迁移；`SCHEMA_VERSION` 保持不变。
- 状态历史继续以 `candidate_job_events` 为权威来源，不复制到新表。
- 健康报告是只读派生结果，不反向修改岗位、工作流、缓存或四档建议。
- 页面查询必须有数量上限，并显示结果是否被截断。
- 新功能失败时只隐藏体检报告并记录脱敏错误，不阻断工作流页面。

---

## File Map

| 文件 | 职责 |
|---|---|
| `src/core/workflow_health.js` | 纯函数规则：把只读快照转换为健康状态、问题列表和最近状态历史 |
| `src/core/storage.js` | 新增有界的只读 `getWorkflowHealthSnapshot()`，复用现有表和读取函数 |
| `src/dashboard/workflow_health_view.js` | 把健康报告安全渲染为现有仪表盘区块 |
| `src/dashboard/server.js` | 在现有 `/workflow` 页面组装快照、报告和视图区块 |
| `tests/workflow_health_smoke.js` | 规则、存储只读性、数量上限和事件历史测试 |
| `tests/workflow_dashboard_smoke.js` | 页面集成、HTML 转义和不改变工作流状态测试 |
| `tests/run_all.js` | 注册新的离线检查 |
| `docs/workflow_health.md` | 用户可读的体检项、含义和处理办法 |
| `docs/operations.md` | 增加体检文档入口和“不会自动修复”的边界说明 |

## Public Interfaces

```js
// src/core/storage.js
getWorkflowHealthSnapshot(db, {
  profileId,
  planId,
  now = new Date().toISOString(),
  jobLimit = 1000,
  workflowLimit = 100,
  eventLimit = 100
}) => {
  generatedAt,
  profileId,
  planId,
  jobs,
  workflowRuns,
  candidateEvents,
  linkIssues,
  truncated: { jobs, workflowRuns, candidateEvents }
}

// src/core/workflow_health.js
buildWorkflowHealthReport(snapshot, {
  now = snapshot.generatedAt,
  minimumJdCharacters = 120,
  runningWorkflowStaleMs = 6 * 60 * 60 * 1000
}) => {
  status: "healthy" | "attention" | "blocked",
  generatedAt,
  summary,
  issues,
  recentEvents,
  truncated
}

// src/dashboard/workflow_health_view.js
renderWorkflowHealthPanel(report) => string
```

### Health Issue Contract

```js
{
  code: "job_missing_jd",
  severity: "critical" | "warning" | "info",
  entityType: "job" | "workflow",
  entityId: "123",
  title: "岗位缺少完整 JD",
  message: "岗位名称 · 公司名称",
  actionHref: "/queue?planId=7&jobId=123",
  details: {
    descriptionCharacters: 42
  }
}
```

问题代码固定为：

```js
const HEALTH_ISSUE_CODES = Object.freeze({
  JOB_MISSING_JD: "job_missing_jd",
  ANALYSIS_INCOMPLETE: "analysis_incomplete",
  ANALYSIS_OUTDATED: "analysis_outdated",
  FOLLOW_UP_OVERDUE: "follow_up_overdue",
  POSSIBLE_DUPLICATE: "possible_duplicate",
  WORKFLOW_STALLED: "workflow_stalled",
  WORKFLOW_LINK_MISMATCH: "workflow_link_mismatch"
});
```

---

### Task 1: Add the Deterministic Health Evaluator

**Files:**
- Create: `src/core/workflow_health.js`
- Create: `tests/workflow_health_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: The snapshot shape documented in `Public Interfaces`.
- Produces: `HEALTH_ISSUE_CODES`, `buildWorkflowHealthReport(snapshot, options)`.

- [ ] **Step 1: Write the failing pure-rule tests**

Create `tests/workflow_health_smoke.js` with deterministic fixtures. This first section must not open SQLite:

```js
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
  "等待用户确认的 review_required 不能被误报为卡死"
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
```

- [ ] **Step 2: Register and run the failing test**

Add `"workflow_health_smoke.js"` immediately after `"workflow_inventory_smoke.js"` in `tests/run_all.js`.

Run:

```powershell
node tests/workflow_health_smoke.js
```

Expected: FAIL with `Cannot find module '../src/core/workflow_health'`.

- [ ] **Step 3: Implement the pure evaluator**

Create `src/core/workflow_health.js`:

```js
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
```

- [ ] **Step 4: Run the pure-rule test**

Run:

```powershell
node tests/workflow_health_smoke.js
```

Expected: the pure-rule assertions pass. The file does not print final success yet because the storage assertions are added in Task 2.

- [ ] **Step 5: Commit the evaluator checkpoint**

```powershell
git add src/core/workflow_health.js tests/workflow_health_smoke.js tests/run_all.js
git commit -m "feat: add deterministic workflow health rules"
```

---

### Task 2: Build a Bounded Read-Only Snapshot from Existing Tables

**Files:**
- Modify: `src/core/storage.js`
- Modify: `tests/workflow_health_smoke.js`

**Interfaces:**
- Consumes: Existing `getSearchPlan()`, `listReportJobs()`, `listWorkflowRuns()`, and `listCandidateJobEvents()`.
- Produces: `getWorkflowHealthSnapshot(db, options)` exported from `src/core/storage.js`.
- Extends: `listCandidateJobEvents()` accepts an optional `planId` filter while preserving existing callers.
- Must not change: `SCHEMA`, `SCHEMA_VERSION`, migration list, or any persisted row.

- [ ] **Step 1: Add failing storage assertions**

Append to `tests/workflow_health_smoke.js`. Use the existing storage helpers to seed one profile, plan, matching card, job observation, candidate state and workflow. The assertions that specifically define this task are:

```js
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
  createWorkflowRun,
  getWorkflowHealthSnapshot
} = require("../src/core/storage");
const { matchingCardFromProfile } = require("../src/core/matching_card");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-workflow-health-"));
const dbPath = path.join(root, "jobs.sqlite");
let db;

try {
  db = openDb(dbPath);
  const profile = {
    candidate: { name: "Health Candidate", city: "广州", targetTitles: ["产品运营"] },
    education: [],
    experiences: [],
    skills: [],
    projects: [],
    credentials: [],
    strengths: []
  };
  const saved = saveProfileAnalysis(db, {
    profile,
    document: {
      originalFileName: "health.txt",
      format: "text",
      contentHash: "health-resume",
      text: "用户提供的离线测试简历内容。".repeat(20),
      diagnostics: {}
    },
    searchPlan: {
      name: "健康检查方案",
      cities: ["广州"],
      directions: ["产品运营"],
      keywords: [{ word: "产品运营", priority: "A", reason: "测试" }],
      salary: { minK: 8, maxK: 15 },
      experience: ["1-3年"],
      jobTypes: ["全职"],
      degrees: [],
      bossActiveDays: 3,
      platform: { site: "boss" }
    }
  });
  const card = createMatchingCardDraft(db, {
    profileId: saved.profileId,
    profileVersionId: saved.profileVersionId,
    resumeDocumentId: saved.resumeDocumentId,
    resumeContentHash: "health-resume",
    card: matchingCardFromProfile(profile),
    source: "migration"
  });
  confirmMatchingCard(db, { profileId: saved.profileId, cardId: card.id });

  const batchId = createBatch(db, "boss", "产品运营", "health fixture", {
    profileId: saved.profileId,
    searchPlanId: saved.planId
  });
  const jobId = upsertJob(db, {
    source: "boss",
    sourceId: "health-job-1",
    keyword: "产品运营",
    title: "产品运营",
    company: "测试公司",
    location: "广州",
    salary: "8-12K",
    experience: "1-3年",
    education: "本科",
    url: "https://example.test/job/health-job-1",
    description: "短 JD",
    tags: [],
    matches: [],
    risks: [],
    qualityTags: [],
    analysis: { semanticStatus: "pending", recommendation: "caution" }
  }, batchId);
  markCandidateJob(db, {
    profileId: saved.profileId,
    planId: saved.planId,
    jobId,
    status: "later",
    reviewAt: "2026-08-02"
  });
  createWorkflowRun(db, {
    id: "health-workflow",
    profileId: saved.profileId,
    planId: saved.planId,
    localDay: "2026-08-03",
    sequence: 1,
    targetSuccessCount: 10,
    successfulCount: 0,
    inventoryCount: 1,
    candidateGap: 9,
    scanNeeded: true,
    keywords: [],
    budget: {},
    planner: {},
    metrics: {},
    createdAt: "2026-08-03T07:00:00.000Z"
  });

  const changesBefore = db.prepare("SELECT total_changes() AS count").get().count;
  const storedSchemaVersion = db.prepare("PRAGMA user_version").get().user_version;
  const storedJobAnalysis = db.prepare(
    "SELECT analysis_json FROM job_observations WHERE job_id = ? ORDER BY id DESC LIMIT 1"
  ).get(jobId).analysis_json;

  const healthSnapshot = getWorkflowHealthSnapshot(db, {
    profileId: saved.profileId,
    planId: saved.planId,
    now,
    jobLimit: 1,
    workflowLimit: 1,
    eventLimit: 1
  });

  const changesAfter = db.prepare("SELECT total_changes() AS count").get().count;
  assert.strictEqual(changesAfter, changesBefore, "健康快照必须完全只读");
  assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.strictEqual(storedSchemaVersion, SCHEMA_VERSION);
  assert.strictEqual(
    db.prepare(
      "SELECT analysis_json FROM job_observations WHERE job_id = ? ORDER BY id DESC LIMIT 1"
    ).get(jobId).analysis_json,
    storedJobAnalysis,
    "健康快照不得修改匹配分析"
  );
  assert.strictEqual(healthSnapshot.profileId, saved.profileId);
  assert.strictEqual(healthSnapshot.planId, saved.planId);
  assert.strictEqual(healthSnapshot.jobs.length, 1);
  assert.strictEqual(healthSnapshot.workflowRuns.length, 1);
  assert.strictEqual(healthSnapshot.candidateEvents.length, 1);
  assert.strictEqual(healthSnapshot.candidateEvents[0].eventType, "later");
  assert.deepStrictEqual(
    healthSnapshot.truncated,
    { jobs: false, workflowRuns: false, candidateEvents: false }
  );

  const storedReport = buildWorkflowHealthReport(healthSnapshot, { now });
  assert(storedReport.issues.some((item) =>
    item.code === HEALTH_ISSUE_CODES.JOB_MISSING_JD
  ));
  assert(storedReport.issues.some((item) =>
    item.code === HEALTH_ISSUE_CODES.FOLLOW_UP_OVERDUE
  ));
  assert.throws(
    () => getWorkflowHealthSnapshot(db, {
      profileId: saved.profileId + 1,
      planId: saved.planId
    }),
    /does not belong to the selected profile/
  );

  console.log("workflow_health_smoke ok");
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the test and confirm the missing export**

Run:

```powershell
node tests/workflow_health_smoke.js
```

Expected: FAIL because `getWorkflowHealthSnapshot` is not exported.

- [ ] **Step 3: Implement the bounded read-only snapshot**

Extend the existing event reader so the current plan does not lose events when the same profile has several plans:

```js
function listCandidateJobEvents(db, {
  profileId,
  jobId = null,
  planId = null,
  eventType = "",
  limit = 30
}) {
  const clauses = ["profile_id = ?"];
  const params = [Number(profileId)];
  if (jobId) {
    clauses.push("job_id = ?");
    params.push(Number(jobId));
  }
  if (planId) {
    clauses.push("(plan_id = ? OR plan_id IS NULL)");
    params.push(Number(planId));
  }
  if (eventType) {
    clauses.push("event_type = ?");
    params.push(String(eventType));
  }
  params.push(Math.max(1, Math.min(200, Number(limit) || 30)));
  return db.prepare(`
    SELECT * FROM candidate_job_events
    WHERE ${clauses.join(" AND ")}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...params).map((row) => ({
    id: Number(row.id),
    profileId: Number(row.profile_id),
    jobId: Number(row.job_id),
    planId: row.plan_id || null,
    eventType: row.event_type,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at
  }));
}
```

Add this function near `buildBatchSummary()` in `src/core/storage.js`:

```js
function getWorkflowHealthSnapshot(db, options = {}) {
  const planId = optionalPositiveInteger(options.planId, "planId");
  if (!planId) throw new Error("planId is required");
  const plan = getSearchPlan(db, planId);
  if (!plan) throw new Error("search plan not found");
  const profileId = optionalPositiveInteger(
    options.profileId || plan.profileId,
    "profileId"
  );
  if (Number(plan.profileId) !== profileId) {
    throw new Error("search plan does not belong to the selected profile");
  }

  const generatedAt = validDate(options.now || nowIso(), "now");
  // Existing readers cap results at 10000, 500 and 200. Keep one slot free
  // so requesting limit + 1 can reliably detect truncation.
  const jobLimit = boundedHealthLimit(options.jobLimit, 1000, 9999);
  const workflowLimit = boundedHealthLimit(options.workflowLimit, 100, 499);
  const eventLimit = boundedHealthLimit(options.eventLimit, 100, 199);

  const jobs = listReportJobs(db, {
    profileId,
    planId,
    limit: jobLimit + 1
  });
  const workflowRuns = listWorkflowRuns(db, {
    profileId,
    planId,
    limit: workflowLimit + 1
  });
  const candidateEvents = listCandidateJobEvents(db, {
    profileId,
    planId,
    limit: eventLimit + 1
  });
  const linkRows = db.prepare(`
    SELECT
      w.id AS workflow_id,
      w.plan_id AS workflow_plan_id,
      w.profile_id AS workflow_profile_id,
      w.scan_run_id,
      sr.plan_id AS scan_plan_id,
      w.scan_batch_id,
      sb.search_plan_id AS scan_batch_plan_id,
      sb.profile_id AS scan_batch_profile_id,
      w.communication_batch_id,
      cb.plan_id AS communication_plan_id,
      cb.profile_id AS communication_profile_id
    FROM workflow_runs w
    LEFT JOIN scan_runs sr ON sr.id = w.scan_run_id
    LEFT JOIN batches sb ON sb.id = w.scan_batch_id
    LEFT JOIN communication_batches cb ON cb.id = w.communication_batch_id
    WHERE w.profile_id = ? AND w.plan_id = ?
  `).all(profileId, planId);

  return Object.freeze({
    generatedAt,
    profileId,
    planId,
    jobs: Object.freeze(jobs.slice(0, jobLimit)),
    workflowRuns: Object.freeze(workflowRuns.slice(0, workflowLimit)),
    candidateEvents: Object.freeze(candidateEvents.slice(0, eventLimit)),
    linkIssues: Object.freeze(linkRows.flatMap(workflowLinkIssues)),
    truncated: Object.freeze({
      jobs: jobs.length > jobLimit,
      workflowRuns: workflowRuns.length > workflowLimit,
      candidateEvents: candidateEvents.length > eventLimit
    })
  });
}

function boundedHealthLimit(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(number, maximum);
}

function workflowLinkIssues(row) {
  const issues = [];
  if (row.scan_run_id && Number(row.scan_plan_id || 0) !== Number(row.workflow_plan_id)) {
    issues.push({ workflowId: row.workflow_id, reason: "scan_plan_mismatch" });
  }
  if (row.scan_batch_id
    && (Number(row.scan_batch_plan_id || 0) !== Number(row.workflow_plan_id)
      || Number(row.scan_batch_profile_id || 0) !== Number(row.workflow_profile_id))) {
    issues.push({ workflowId: row.workflow_id, reason: "scan_batch_owner_mismatch" });
  }
  if (row.communication_batch_id
    && (Number(row.communication_plan_id || 0) !== Number(row.workflow_plan_id)
      || Number(row.communication_profile_id || 0) !== Number(row.workflow_profile_id))) {
    issues.push({
      workflowId: row.workflow_id,
      reason: "communication_batch_owner_mismatch"
    });
  }
  return issues;
}
```

Export `getWorkflowHealthSnapshot` from the existing `module.exports`.

- [ ] **Step 4: Run the storage and existing migration tests**

Run:

```powershell
node tests/workflow_health_smoke.js
node tests/storage_migration_smoke.js
```

Expected:

```text
workflow_health_smoke ok
storage_migration_smoke ok
```

- [ ] **Step 5: Commit the snapshot checkpoint**

```powershell
git add src/core/storage.js tests/workflow_health_smoke.js
git commit -m "feat: expose read-only workflow health snapshot"
```

---

### Task 3: Render Health and Recent Progress on the Existing Workflow Page

**Files:**
- Create: `src/dashboard/workflow_health_view.js`
- Modify: `src/dashboard/server.js`
- Modify: `tests/workflow_dashboard_smoke.js`

**Interfaces:**
- Consumes: `getWorkflowHealthSnapshot()`, `buildWorkflowHealthReport()`.
- Produces: `renderWorkflowHealthPanel(report)`.
- Must not create: a second home page, a write endpoint, a model call, or a BOSS operation.

- [ ] **Step 1: Add failing dashboard assertions**

In `tests/workflow_dashboard_smoke.js`, after a workflow and at least one candidate status event have been seeded, capture persisted state before the GET:

```js
const workflowBeforeHealthPage = listWorkflowRuns(db, {
  planId: saved.planId
}).map((run) => ({ ...run }));
const healthChangesBefore = db.prepare("SELECT total_changes() AS count").get().count;

const healthPage = await getText(
  baseUrl,
  `/workflow?runId=${encodeURIComponent(workflowBeforeHealthPage[0].id)}`
);

assert.strictEqual(healthPage.status, 200);
assert.match(healthPage.body, /流程体检/);
assert.match(healthPage.body, /已检查岗位/);
assert.match(healthPage.body, /最近状态变化/);
assert.match(healthPage.body, /岗位缺少完整 JD|当前未发现流程数据问题/);
assert.strictEqual(
  db.prepare("SELECT total_changes() AS count").get().count,
  healthChangesBefore,
  "打开体检区块不能写数据库"
);
assert.deepStrictEqual(
  listWorkflowRuns(db, { planId: saved.planId }),
  workflowBeforeHealthPage,
  "打开体检区块不能推进或修复工作流"
);
```

Seed one job title as `"<script>health-xss</script>"`, then assert:

```js
assert(!healthPage.body.includes("<script>health-xss</script>"));
assert(healthPage.body.includes("&lt;script&gt;health-xss&lt;/script&gt;"));
```

- [ ] **Step 2: Run the dashboard test and confirm the panel is absent**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
```

Expected: FAIL because the page does not contain `流程体检`.

- [ ] **Step 3: Implement the isolated view module**

Create `src/dashboard/workflow_health_view.js`:

```js
function renderWorkflowHealthPanel(report = {}) {
  const statusLabel = {
    healthy: "正常",
    attention: "需要处理",
    blocked: "存在关联异常"
  }[report.status] || "尚未检查";
  const summary = report.summary || {};
  const issues = Array.isArray(report.issues) ? report.issues : [];
  const recentEvents = Array.isArray(report.recentEvents) ? report.recentEvents : [];
  const truncated = report.truncated || {};
  const issueRows = issues.slice(0, 50).map((item) => `
    <tr>
      <td>${escapeHtml(severityLabel(item.severity))}</td>
      <td>${escapeHtml(item.title)}</td>
      <td>${escapeHtml(item.message)}</td>
      <td><a href="${escapeAttr(item.actionHref)}">查看</a></td>
    </tr>
  `).join("");
  const eventRows = recentEvents.slice(0, 20).map((event) => `
    <tr>
      <td>${escapeHtml(String(event.createdAt || "").replace("T", " ").slice(0, 19))}</td>
      <td>${escapeHtml(eventLabel(event.eventType))}</td>
      <td>${escapeHtml(`岗位 #${event.jobId || ""}`)}</td>
    </tr>
  `).join("");
  const truncatedNote = Object.values(truncated).some(Boolean)
    ? `<p class="hint">记录数量超过页面上限，本次只显示最近一部分；完整数据仍保留在本地数据库中。</p>`
    : "";

  return `<section class="panel workflow-health">
    <details${report.status === "blocked" ? " open" : ""}>
      <summary><strong>流程体检：${escapeHtml(statusLabel)}</strong>
        · 已检查岗位 ${Number(summary.jobsChecked || 0)}
        · 问题 ${Number(summary.issueCount || 0)}
      </summary>
      <p class="hint">这里只读取现有记录，不会自动修复、重新分析、扫描或沟通。</p>
      ${truncatedNote}
      <h2>需要关注</h2>
      <table class="diagnostics">
        <thead><tr><th>级别</th><th>问题</th><th>对象</th><th>操作</th></tr></thead>
        <tbody>${issueRows || "<tr><td colspan=\"4\">当前未发现流程数据问题</td></tr>"}</tbody>
      </table>
      <h2>最近状态变化</h2>
      <table class="diagnostics">
        <thead><tr><th>时间</th><th>状态</th><th>岗位</th></tr></thead>
        <tbody>${eventRows || "<tr><td colspan=\"3\">暂无状态变化记录</td></tr>"}</tbody>
      </table>
    </details>
  </section>`;
}

function severityLabel(value) {
  return {
    critical: "严重",
    warning: "注意",
    info: "提示"
  }[value] || "提示";
}

function eventLabel(value) {
  return {
    pending: "待处理",
    review: "待复核",
    later: "稍后处理",
    applied: "已投递",
    skipped: "已跳过",
    no_reply: "无回复",
    follow_up: "新增跟进",
    recommendation_feedback: "推荐反馈"
  }[value] || String(value || "未知状态");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  const text = String(value || "");
  if (!text.startsWith("/")) return "#";
  return escapeHtml(text);
}

module.exports = { renderWorkflowHealthPanel };
```

- [ ] **Step 4: Integrate the panel with fail-open behavior**

At the top of `src/dashboard/server.js`, import:

```js
const { getWorkflowHealthSnapshot } = require("../core/storage");
const { buildWorkflowHealthReport } = require("../core/workflow_health");
const { renderWorkflowHealthPanel } = require("./workflow_health_view");
```

If `getWorkflowHealthSnapshot` is added to an existing destructured storage import, do not add a second `require("../core/storage")`.

Inside `renderWorkflowPage({ db, searchParams, logger })`, after `workflow`, `plan` and `phase` are available, add:

```js
let healthPanel = "";
try {
  const snapshot = getWorkflowHealthSnapshot(db, {
    profileId: plan.profileId,
    planId: plan.id,
    now: new Date().toISOString()
  });
  healthPanel = renderWorkflowHealthPanel(buildWorkflowHealthReport(snapshot));
} catch (error) {
  logger?.warn("workflow_health_render_failed", {
    workflowRunId: workflow.id,
    planId: plan.id,
    errorCode: String(error.code || "WORKFLOW_HEALTH_FAILED")
  });
}
```

Render `${healthPanel}` immediately after the existing workflow progress summary and before `${phase}`. Do not call any write method from this block.

- [ ] **Step 5: Run focused dashboard tests**

Run:

```powershell
node tests/workflow_health_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/observability_smoke.js
```

Expected:

```text
workflow_health_smoke ok
workflow_dashboard_smoke ok
observability_smoke ok
```

- [ ] **Step 6: Commit the dashboard checkpoint**

```powershell
git add src/dashboard/workflow_health_view.js src/dashboard/server.js tests/workflow_dashboard_smoke.js
git commit -m "feat: show workflow health on existing dashboard"
```

---

### Task 4: Document the Feature and Run the Offline Regression Gates

**Files:**
- Create: `docs/workflow_health.md`
- Modify: `docs/operations.md`

**Interfaces:**
- Documents the issue codes and manual handling.
- Does not add an automatic repair command.

- [ ] **Step 1: Write the user-facing health guide**

Create `docs/workflow_health.md`:

```markdown
# 流程体检

工作流页面中的“流程体检”只读取本地已有记录，不会自动扫描、调用模型、修改推荐或执行沟通。

## 体检状态

- 正常：没有发现需要处理的问题。
- 需要处理：存在缺少 JD、待分析、分析内容变化、逾期复查、疑似重复或长时间未更新。
- 存在关联异常：工作流与扫描批次或沟通批次的归属不一致。不要继续执行该轮，先查看诊断日志。

## 检查项目

| 项目 | 含义 | 建议处理 |
|---|---|---|
| 岗位缺少完整 JD | 当前保存的岗位描述少于 120 个字符 | 以后在只读扫描中重新读取详情 |
| 岗位尚未完成语义分析 | 模型分析没有形成完整契约结果 | 模型可用后手动重试分析 |
| 岗位内容变化 | 新观察与原分析依据不同 | 查看差异后手动重新分析 |
| 已到复查时间 | “稍后处理”的日期已经到期 | 打开岗位记录并人工决定 |
| 可能重复 | 现有质量规则发现相似岗位 | 查看公司、标题、URL 和岗位 ID |
| 工作流长时间未更新 | 运行状态超过 6 小时没有变化 | 查看诊断日志，按现有恢复流程处理 |
| 工作流关联不一致 | 工作流与批次的方案或候选人不一致 | 停止该轮，不要绕过门禁 |

## 安全边界

体检不会自动修复数据。它不会访问 BOSS、读取 Cookie、调用模型、修改四档建议、调整二维表或改变默认沟通勾选。

页面最多读取 1000 个岗位、100 个工作流和 100 条状态事件。超过上限时会提示“只显示最近一部分”，但不会删除历史数据。
```

- [ ] **Step 2: Link the guide from operations documentation**

Append this section to `docs/operations.md`:

```markdown
## 流程体检

工作流页面会显示只读的流程体检摘要。体检结果不会自动修复、重新分析、扫描或沟通。各检查项和人工处理方式见 [流程体检](workflow_health.md)。
```

- [ ] **Step 3: Run all focused offline tests**

Run:

```powershell
node tests/workflow_health_smoke.js
node tests/workflow_inventory_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/workflow_storage_smoke.js
node tests/storage_migration_smoke.js
node tests/observability_smoke.js
```

Expected: all six commands print their corresponding `ok` line and exit with code `0`.

- [ ] **Step 4: Run the complete offline suite**

Run:

```powershell
npm.cmd test
```

Expected:

```text
All 51 offline checks passed.
```

No real model, BOSS page, Cookie, Token, port `8787`, or `data/jobs.sqlite` may be used by this suite.

- [ ] **Step 5: Confirm the frozen matching fixture did not change**

Run:

```powershell
node tests/job_match_benchmark.js
```

Expected:

```text
31 fixtures passed
```

This is an offline regression only. Do not run a live model benchmark for this subproject because it does not change matching behavior.

- [ ] **Step 6: Commit the documentation and verified checkpoint**

```powershell
git add docs/workflow_health.md docs/operations.md
git commit -m "docs: explain read-only workflow health checks"
git push
```

---

## Final Review Checklist

- [ ] `SCHEMA_VERSION` is unchanged.
- [ ] No migration or new table was added.
- [ ] `candidate_job_events` remains the only new-style candidate status history.
- [ ] Opening `/workflow` causes zero SQLite changes.
- [ ] Opening `/workflow` causes zero model or BOSS calls.
- [ ] `review_required` is not reported as a stalled workflow.
- [ ] Health failures do not block the existing workflow page.
- [ ] All user-controlled text is HTML-escaped.
- [ ] Truncated snapshots are clearly labeled.
- [ ] The panel does not change four-tier recommendations or default communication selections.
- [ ] `npm.cmd test` passes all 51 offline checks.
- [ ] The 31-fixture matching benchmark remains unchanged.

## Deferred Work

The following items are intentionally outside this plan:

- Automatic repair.
- Database `PRAGMA quick_check` on every page load.
- Outcome-rate analytics by recommendation tier.
- Job legitimacy or ghost-job analysis.
- STAR interview stories.
- Job-specific resume drafts.
- Safe `@ref` aliases.
- CSV or JSONL export.
- Public ATS sources.
- Any BOSS write-path change.
