# Outcome Analytics and Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add a read-only, deterministic outcome-summary panel that compares the four recommendation tiers and search-keyword groups without changing matching policy or workflow behavior.

**Architecture:** Reuse listDecisionPool(db, { planId }) as the local source, project every job to three safe fields, aggregate those fields in a new pure core module, then render the aggregate on the existing queue page. No analytics data is persisted; no schema migration, model request, BOSS operation, or auto-tuning is allowed.

**Tech Stack:** Node.js CommonJS, built-in node:assert/strict, existing SQLite storage adapter, existing dashboard server and smoke-test conventions.

## Global Constraints

- Keep exactly four recommendation rows: primary, apply, caution, not_recommended.
- Treat analysis_pending and refresh as diagnostic states, not recommendation rows.
- Input/output contracts contain only decisionBucket, applicationStatus, and keyword. Never emit job ID, title, company, URL, JD, resume, raw model output, prompt, secret, or Cookie.
- Every database path is read-only. Do not add a migration, cache, event, status, batch, or observation write.
- Metrics are descriptive counts only. Do not calculate or label causal success rates. Never auto-adjust the decision matrix, thresholds, prompt, ordering, or default communication selection.
- Use synthetic fixtures in tests. Do not access real BOSS, real browser state, real model API, or private benchmark artifacts.

---

## File Map

- Create: src/core/outcome_analytics.js - pure aggregate contract and bounded keyword grouping.
- Create: tests/outcome_analytics_smoke.js - pure and storage read-only regression coverage.
- Modify: src/core/storage.js near listDecisionPool and its module exports - safe snapshot adapter.
- Modify: src/dashboard/server.js near renderCompactQueuePage and storage imports - queue-page panel and fail-open wrapper.
- Create: tests/outcome_analytics_dashboard_smoke.js - actual SQLite/dashboard integration regression.
- Modify: tests/run_all.js - register the two new offline smoke checks.
- Create: docs/outcome_analytics.md - user-facing metric definitions and non-automation rule.
- Modify: docs/operations.md - operational boundary and manual interpretation guidance.

## Public Interfaces

~~~js
// src/core/outcome_analytics.js
const RECOMMENDATION_TIERS = ["primary", "apply", "caution", "not_recommended"];
const DIAGNOSTIC_BUCKETS = ["analysis_pending", "refresh"];

function buildOutcomeAnalytics(rows, { maxKeywordGroups = 12 } = {}) {
  // rows only use decisionBucket, applicationStatus, keyword.
  // returns { totals, tiers, diagnostics, keywords, unclassified }.
}

// src/core/storage.js
function getOutcomeAnalyticsSnapshot(db, { planId } = {}) {
  // Validates the plan, reads listDecisionPool, projects only safe fields,
  // and returns buildOutcomeAnalytics(projectedRows).
}
~~~

Each tiers entry has this stable shape:

~~~js
{
  tier: "primary",
  total: 0,
  unresolvedCount: 0,
  recordedOutcomeCount: 0,
  outcomes: {
    pending: 0, review: 0, later: 0, applied: 0, skipped: 0, no_reply: 0,
    interview: 0, rejected: 0, invalid: 0, salary_mismatch: 0
  }
}
~~~

### Task 1: Create the Pure Four-Tier Aggregator

**Files:**
- Create: src/core/outcome_analytics.js
- Create: tests/outcome_analytics_smoke.js

**Consumes:** Synthetic safe rows with only decisionBucket, applicationStatus, and keyword.

**Produces:** A deterministic aggregate with four tier rows, isolated diagnostic rows, bounded keyword rows, and an explicit unclassified count.

- [ ] **Step 1: Write the failing pure regression**

Create tests/outcome_analytics_smoke.js with this mixed fixture and assertions:

~~~js
const assert = require("node:assert/strict");
const { buildOutcomeAnalytics } = require("../src/core/outcome_analytics");

const analytics = buildOutcomeAnalytics([
  { decisionBucket: "primary", applicationStatus: "interview", keyword: "RAG" },
  { decisionBucket: "primary", applicationStatus: "pending", keyword: "RAG" },
  { decisionBucket: "apply", applicationStatus: "applied", keyword: "Agent" },
  { decisionBucket: "caution", applicationStatus: "review", keyword: "Agent" },
  { decisionBucket: "not_recommended", applicationStatus: "skipped", keyword: null },
  { decisionBucket: "analysis_pending", applicationStatus: "pending", keyword: "RAG" },
  { decisionBucket: "refresh", applicationStatus: "later", keyword: "Python" },
  { decisionBucket: "unknown_bucket", applicationStatus: "mystery", keyword: "Other" }
]);

assert.deepStrictEqual(analytics.tiers.map((row) => row.tier), ["primary", "apply", "caution", "not_recommended"]);
assert.strictEqual(analytics.tiers[0].total, 2);
assert.strictEqual(analytics.tiers[0].outcomes.interview, 1);
assert.strictEqual(analytics.tiers[0].unresolvedCount, 1);
assert.strictEqual(analytics.tiers[3].outcomes.skipped, 1);
assert.strictEqual(analytics.diagnostics.total, 2);
assert.strictEqual(analytics.unclassified.total, 1);
assert.strictEqual(analytics.keywords.find((row) => row.keyword === "RAG").total, 3);
assert.strictEqual(JSON.stringify(analytics).includes("title"), false);
console.log("outcome_analytics_smoke ok");
~~~

- [ ] **Step 2: Run the new test to verify red**

Run:

~~~powershell
node tests/outcome_analytics_smoke.js
~~~

Expected: failure because the outcome analytics module does not exist.

- [ ] **Step 3: Implement the minimal pure module**

Create src/core/outcome_analytics.js with constants, an empty outcome factory, and one aggregate function:

~~~js
const RECOMMENDATION_TIERS = ["primary", "apply", "caution", "not_recommended"];
const DIAGNOSTIC_BUCKETS = new Set(["analysis_pending", "refresh"]);
const OUTCOMES = ["pending", "review", "later", "applied", "skipped", "no_reply", "interview", "rejected", "invalid", "salary_mismatch"];
const UNRESOLVED = new Set(["pending", "review", "later"]);

function emptyOutcomes() {
  return Object.fromEntries(OUTCOMES.map((status) => [status, 0]));
}

function buildOutcomeAnalytics(rows = [], { maxKeywordGroups = 12 } = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const tiers = RECOMMENDATION_TIERS.map((tier) => ({
    tier, total: 0, unresolvedCount: 0, recordedOutcomeCount: 0, outcomes: emptyOutcomes()
  }));
  const tierByName = new Map(tiers.map((row) => [row.tier, row]));
  const diagnostics = { total: 0, outcomes: emptyOutcomes() };
  const unclassified = { total: 0, outcomes: emptyOutcomes() };
  const keywords = new Map();

  for (const item of source) {
    const bucket = String(item && item.decisionBucket || "");
    const status = OUTCOMES.includes(item && item.applicationStatus) ? item.applicationStatus : "pending";
    const keyword = String(item && item.keyword || "").trim() || "未记录关键词";
    const target = tierByName.get(bucket) || (DIAGNOSTIC_BUCKETS.has(bucket) ? diagnostics : unclassified);
    target.total += 1;
    target.outcomes[status] += 1;
    if (tierByName.has(bucket)) {
      if (UNRESOLVED.has(status)) target.unresolvedCount += 1;
      else target.recordedOutcomeCount += 1;
    }
    const group = keywords.get(keyword) || { keyword, total: 0, outcomes: emptyOutcomes() };
    group.total += 1;
    group.outcomes[status] += 1;
    keywords.set(keyword, group);
  }

  const keywordRows = [...keywords.values()]
    .sort((a, b) => b.total - a.total || a.keyword.localeCompare(b.keyword));
  return {
    totals: { total: source.length, fourTierTotal: tiers.reduce((sum, row) => sum + row.total, 0) },
    tiers,
    diagnostics,
    keywords: keywordRows.slice(0, maxKeywordGroups),
    unclassified
  };
}

module.exports = { RECOMMENDATION_TIERS, DIAGNOSTIC_BUCKETS, OUTCOMES, buildOutcomeAnalytics };
~~~

Do not import storage, model, browser, dashboard, or external code in this module.

- [ ] **Step 4: Run the pure regression and confirm green**

Run:

~~~powershell
node tests/outcome_analytics_smoke.js
~~~

Expected: outcome_analytics_smoke ok.

- [ ] **Step 5: Commit the self-contained task**

~~~powershell
git add src/core/outcome_analytics.js tests/outcome_analytics_smoke.js
git commit -m "feat: add four-tier outcome analytics"
~~~

### Task 2: Expose a Read-Only Analytics Snapshot from Existing Storage

**Files:**
- Modify: src/core/storage.js near listDecisionPool and module exports.
- Modify: tests/outcome_analytics_smoke.js.

**Consumes:** listDecisionPool(db, { planId }), getSearchPlan(db, planId), and buildOutcomeAnalytics from Task 1.

**Produces:** getOutcomeAnalyticsSnapshot(db, { planId }) with no persistence side effects.

- [ ] **Step 1: Extend the failing regression with a real SQLite read-only assertion**

Use existing temporary SQLite fixture helpers to seed one confirmed profile, plan, batch, and safe synthetic jobs. Record schema version plus row counts before the snapshot, then assert:

~~~js
const before = {
  schema: db.prepare("PRAGMA user_version").get().user_version,
  jobs: db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count,
  states: db.prepare("SELECT COUNT(*) AS count FROM candidate_job_states").get().count,
  events: db.prepare("SELECT COUNT(*) AS count FROM candidate_job_events").get().count
};

const snapshot = getOutcomeAnalyticsSnapshot(db, { planId });
assert.deepStrictEqual(snapshot.tiers.map((row) => row.tier), ["primary", "apply", "caution", "not_recommended"]);

assert.deepStrictEqual({
  schema: db.prepare("PRAGMA user_version").get().user_version,
  jobs: db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count,
  states: db.prepare("SELECT COUNT(*) AS count FROM candidate_job_states").get().count,
  events: db.prepare("SELECT COUNT(*) AS count FROM candidate_job_events").get().count
}, before);
~~~

- [ ] **Step 2: Run the test to verify red**

Run:

~~~powershell
node tests/outcome_analytics_smoke.js
~~~

Expected: failure because getOutcomeAnalyticsSnapshot is not exported.

- [ ] **Step 3: Add the minimal storage adapter**

At the storage-module import section, add:

~~~js
const { buildOutcomeAnalytics } = require("./outcome_analytics");
~~~

Near listDecisionPool, add:

~~~js
function getOutcomeAnalyticsSnapshot(db, { planId } = {}) {
  const plan = getSearchPlan(db, planId);
  if (!plan) return buildOutcomeAnalytics([]);
  const rows = listDecisionPool(db, { planId: plan.id }).map((job) => ({
    decisionBucket: job.decisionBucket,
    applicationStatus: job.applicationStatus || "pending",
    keyword: job.keyword || ""
  }));
  return buildOutcomeAnalytics(rows);
}
~~~

Export this function with the existing storage public API. Do not call markCandidateJob, recordCandidateJobEvent, upsertJob, saveModelCache, or any migration helper.

- [ ] **Step 4: Run the storage regression and confirm green**

Run:

~~~powershell
node tests/outcome_analytics_smoke.js
~~~

Expected: outcome_analytics_smoke ok with unchanged schema and row counts.

- [ ] **Step 5: Commit the read-only snapshot**

~~~powershell
git add src/core/storage.js tests/outcome_analytics_smoke.js
git commit -m "feat: expose read-only outcome analytics snapshot"
~~~

### Task 3: Render the Summary on the Existing Queue Page

**Files:**
- Modify: src/dashboard/server.js near renderCompactQueuePage and storage imports.
- Create: tests/outcome_analytics_dashboard_smoke.js.

**Consumes:** getOutcomeAnalyticsSnapshot(db, { planId }) and its aggregate-only return value.

**Produces:** renderOutcomeAnalyticsPanel(analytics) and a fail-open queue-page integration.

- [ ] **Step 1: Write a failing dashboard integration test**

Create a temporary SQLite database using the existing dashboard smoke pattern. Seed a plan with one primary job marked interview, one apply job marked no_reply, one caution job pending, one not_recommended job skipped, and one analysis_pending job. Request /queue?planId=<planId> and assert:

~~~js
assert.strictEqual(page.status, 200);
assert.match(page.body, /结果统计（只读）/);
assert.match(page.body, /主投/);
assert.match(page.body, /可投/);
assert.match(page.body, /慎投/);
assert.match(page.body, /不推荐/);
assert.match(page.body, /待分析或待刷新（不纳入四档比较）/);
assert.doesNotMatch(page.body, /模型准确率|自动调整二维表|成功率/);
~~~

Inject an analytics reader that throws once. Assert that /queue still returns 200, preserves its existing queue heading, omits the analytics panel, and emits one outcome_analytics_render_failed warning containing only a fixed error code.

- [ ] **Step 2: Run the dashboard test to verify red**

Run:

~~~powershell
node tests/outcome_analytics_dashboard_smoke.js
~~~

Expected: failure because the queue has no outcome analytics panel.

- [ ] **Step 3: Add a safe renderer and fail-open integration**

Import getOutcomeAnalyticsSnapshot into src/dashboard/server.js. Add a renderer that accepts only aggregate data and escapes all labels. The tier table must include these columns: recommendation tier, total, unresolved, applied, no_reply, interview, rejected_or_invalid.

The renderer must:
- use outcomeTierLabel to translate only the four stable keys;
- show a no-records row when tiers are absent;
- show a bounded keyword table with the heading 搜索方向（关键词）;
- show the diagnostics summary as 待分析或待刷新（不纳入四档比较）：<count>;
- include the fixed notice that matrix, weight, and prompt changes require user confirmation.

The tier table must expose these columns: recommendation tier, total, unresolved, applied, skipped, no_reply, interview, rejected_or_invalid.

In renderCompactQueuePage, call the new snapshot after the plan is resolved. Wrap only this new call in try/catch. On error call:

~~~js
logger.warn("outcome_analytics_render_failed", { code: "OUTCOME_ANALYTICS_UNAVAILABLE" });
~~~

Set the panel to an empty string and leave all existing queue behavior unchanged. Render the panel after queue counters and before job cards.

- [ ] **Step 4: Run the dashboard regression and confirm green**

Run:

~~~powershell
node tests/outcome_analytics_dashboard_smoke.js
~~~

Expected: outcome_analytics_dashboard_smoke ok.

- [ ] **Step 5: Commit the visible summary**

~~~powershell
git add src/dashboard/server.js tests/outcome_analytics_dashboard_smoke.js
git commit -m "feat: show read-only outcome analytics"
~~~

### Task 4: Document, Register, and Verify the Offline Feature

**Files:**
- Modify: tests/run_all.js.
- Create: docs/outcome_analytics.md.
- Modify: docs/operations.md.

**Consumes:** Completed pure, storage, and dashboard contracts from Tasks 1 through 3.

**Produces:** Discoverable operations guidance and complete offline regression coverage.

- [ ] **Step 1: Register the two new smoke checks**

Insert these exact filenames near the existing core/dashboard smoke checks in tests/run_all.js:

~~~js
"outcome_analytics_smoke.js",
"outcome_analytics_dashboard_smoke.js",
~~~

- [ ] **Step 2: Extend user-facing documentation**

Create docs/outcome_analytics.md with these required statements:

~~~markdown
# 结果统计（只读）

四档表只显示主投、可投、慎投、不推荐。待分析或待刷新不属于推荐档，单独显示。

统计是本地历史记录的计数，不代表平台实时状态、模型准确率或因果关系。它不会自动修改二维表、权重、提示词、岗位排序或默认沟通勾选。

如需依据统计调整规则，先查看具体偏差，再由用户确认调整内容。
~~~

Add a short docs/operations.md section linking to this guide and restating that the panel performs no model call, BOSS operation, or database write.

- [ ] **Step 3: Run focused checks**

Run:

~~~powershell
node tests/outcome_analytics_smoke.js
node tests/outcome_analytics_dashboard_smoke.js
~~~

Expected: both commands exit 0 and print their ok lines.

- [ ] **Step 4: Run the full offline suite and format check**

Run:

~~~powershell
npm.cmd test
git diff --check
~~~

Expected: all offline checks pass and git diff --check prints nothing.

- [ ] **Step 5: Commit the documentation and runner registration**

~~~powershell
git add tests/run_all.js docs/outcome_analytics.md docs/operations.md
git commit -m "docs: explain outcome analytics boundaries"
~~~

## Review Gates

After each completed task, request an independent read-only review. Critical or Important findings must be fixed and re-reviewed before the next task. Before pushing the branch, run a whole-range review from this plan's first commit to the final commit and require Spec PASS plus Code quality APPROVED.
