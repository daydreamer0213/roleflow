# Job Analysis User View and Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task with two-stage review (spec compliance, then code quality).

**Goal:** Make the job view lead with useful conclusions and make workflow progress distinguish historical analysis failures from failures that remain unresolved now.

**Architecture:** Keep the existing semantic analysis and production decision engine unchanged. Extend the workflow read model by joining each original task to the latest analysis observation under the same frozen search plan, then project that distinction through the existing Dashboard view model, server-rendered page, and polling client. Build the job narrative only at the existing Dashboard rendering boundary from already stored analysis fields.

**Tech Stack:** Node.js 22, built-in `node:sqlite`, CommonJS, server-rendered HTML, vanilla browser JavaScript, existing offline smoke-test harness.

**Global Constraints:** No BOSS access, model calls, external writes, schema migration, production decision change, company intelligence system, new dependency, or framework migration. Preserve immutable workflow tasks and analysis-attempt history. Use `apply_patch` for edits and TDD for each behavior change.

---

### Task 1: Separate historical task failure from current analysis resolution

**Files:**
- Modify: `tests/workflow_progress_smoke.js`
- Modify: `src/core/workflow_progress.js`

- [ ] **Step 1: Add the failing workflow read-model regression**

  Extend `testTruthfulFourTrackReadModel()` or add a focused sibling test that creates two terminal `failed` workflow tasks. Write a later observation under the same `planId` with a complete model analysis for one job and leave the other unresolved.

  Assert this interface:

  ```js
  assert.strictEqual(snapshot.progress.analysis.historicalFailed, 2);
  assert.strictEqual(snapshot.progress.analysis.resolvedAfterFailure, 1);
  assert.strictEqual(snapshot.progress.analysis.unresolvedFailed, 1);
  assert.strictEqual(snapshot.progress.analysis.failed, 2); // compatibility: immutable historical count
  assert.strictEqual(snapshot.progress.analysis.tasks[0].resolvedAfterFailure, true);
  assert.strictEqual(snapshot.progress.analysis.tasks[1].resolvedAfterFailure, false);
  ```

  Also assert that `listWorkflowProgressJobs()` exposes `resolvedAfterFailure` without exposing `analysis_json` or raw error messages.

- [ ] **Step 2: Run the focused test and confirm the intended failure**

  Run: `node tests/workflow_progress_smoke.js`

  Expected: FAIL because the new three counts and per-task resolution flag do not exist.

- [ ] **Step 3: Implement the minimum read-model change**

  In `src/core/workflow_progress.js`:

  - load workflow task rows together with the latest `job_observations.analysis_json` whose batch belongs to the same `workflow_runs.plan_id`;
  - treat analysis as currently resolved only when `semanticStatus === "complete"`, or when it is a decided blocked `not_recommended` result, matching workflow health semantics;
  - aggregate `historicalFailed`, `resolvedAfterFailure`, and `unresolvedFailed` while retaining `failed` as the historical compatibility field;
  - return only the boolean resolution flag through the status API and the title/company display query.

  Prefer one task-row query and a pure aggregation helper over adding per-job queries.

- [ ] **Step 4: Re-run the focused test**

  Run: `node tests/workflow_progress_smoke.js`

  Expected: `workflow_progress_smoke ok`.

- [ ] **Step 5: Commit the read-model checkpoint**

  ```powershell
  git add tests/workflow_progress_smoke.js src/core/workflow_progress.js
  git commit -m "fix: distinguish resolved analysis failures"
  ```

### Task 2: Show the distinction consistently in the workflow page and polling updates

**Files:**
- Modify: `tests/workflow_dashboard_smoke.js`
- Modify: `src/dashboard/view_models/workflow.js`
- Modify: `src/dashboard/pages/workflow.js`
- Modify: `src/dashboard/assets/workflow.js`

- [ ] **Step 1: Add failing Dashboard assertions**

  Extend the existing workflow progress-page fixture with a failed task whose latest same-plan observation is complete. Assert the server-rendered page contains the three user-facing facts:

  ```text
  本轮直接完成
  失败后已解决
  当前未解决
  ```

  Assert that the resolved row says `首次失败，后续已解决`, the unresolved row still says `分析失败`, and the page retains a historical-failure hook for technical inspection.

  Extend the local polling-client test so an API task with `status: "failed", resolvedAfterFailure: true` updates the row to the resolved label and updates the resolved/unresolved counts.

- [ ] **Step 2: Run the focused Dashboard test and confirm failure**

  Run: `node tests/workflow_dashboard_smoke.js`

  Expected: FAIL on the missing labels/hooks or the old `分析失败` row text.

- [ ] **Step 3: Project the new status fields in the view model**

  In `progressView()` return:

  ```js
  analysis: {
    directSucceeded,
    historicalFailed,
    resolvedAfterFailure,
    unresolvedFailed,
    // existing fields remain
  }
  ```

  Map each display row to `首次失败，后续已解决` only when its immutable status is `failed` and the latest analysis is resolved. Keep `DETAIL_REQUIRED` and all other status labels unchanged.

- [ ] **Step 4: Update server-rendered stats and the polling client**

  Replace the ambiguous visible `分析失败` statistic with visible `本轮直接完成`, `失败后已解决`, and `当前未解决` statistics. Retain `historicalFailed` in a hidden technical hook and in the analysis-track description.

  Update `src/dashboard/assets/workflow.js` to render the same task label and count semantics after polling. Do not expose title, company, analysis JSON, or error messages in the lightweight status API.

- [ ] **Step 5: Re-run the Dashboard test**

  Run: `node tests/workflow_dashboard_smoke.js`

  Expected: `workflow_dashboard_smoke ok`.

- [ ] **Step 6: Commit the Dashboard status checkpoint**

  ```powershell
  git add tests/workflow_dashboard_smoke.js src/dashboard/view_models/workflow.js src/dashboard/pages/workflow.js src/dashboard/assets/workflow.js
  git commit -m "feat: show current analysis resolution"
  ```

### Task 3: Guard workflow health against historical failures

**Files:**
- Modify: `tests/workflow_health_smoke.js`

- [ ] **Step 1: Add the storage-level regression fixture**

  In the existing temporary database, create or reuse a job whose original workflow task and `job_analysis_attempts` retain a failed record, then write a later same-plan observation with a complete analysis.

  Assert all of the following together:

  ```js
  assert.strictEqual(failedAttemptCount, 1);
  assert.strictEqual(progress.analysis.resolvedAfterFailure, 1);
  assert.strictEqual(
    health.issues.some((issue) => issue.code === HEALTH_ISSUE_CODES.ANALYSIS_INCOMPLETE),
    false
  );
  ```

  Also retain the existing assertion that a genuinely pending latest analysis does produce `analysis_incomplete`.

- [ ] **Step 2: Run the health and progress tests**

  Run: `node tests/workflow_health_smoke.js`

  Expected after Task 1: `workflow_health_smoke ok`. If it fails, fix only the current-state selection root cause; never delete the failed attempt.

- [ ] **Step 3: Commit the regression evidence**

  ```powershell
  git add tests/workflow_health_smoke.js
  git commit -m "test: preserve resolved analysis failure history"
  ```

### Task 4: Reorder the compact job card around the user's decision

**Files:**
- Modify: `tests/data_visibility_smoke.js`
- Modify: `src/dashboard/server.js`

- [ ] **Step 1: Add a failing compact-card regression**

  Add a dedicated complete job containing `roleSummary`, `industryContext`, `businessScenario`, `fitReasons`, `jobQuality`, salary, and risks. Render it through `renderQueuePage()` and isolate its `<article class="job">`.

  Assert the main card contains these labels in order before `<details>`:

  ```text
  结论
  岗位
  公司与机会
  匹配
  薪资
  需要确认
  ```

  Assert `决策来源` remains inside `<details>` and is absent from the main-card slice. Add a second job without `businessScenario` or meaningful `industryContext` and assert the fallback does not invent company business.

- [ ] **Step 2: Run the focused test and confirm failure**

  Run: `node tests/data_visibility_smoke.js`

  Expected: FAIL because the current compact card only renders a raw fit reason and risk in the main slice.

- [ ] **Step 3: Add a narrow Dashboard narrative projection**

  Add local helpers next to `renderCompactJobBase()` in `src/dashboard/server.js`:

  ```js
  function compactJobNarrative(job) {
    return { conclusion, role, companyOpportunity, fit, salary, risk };
  }
  ```

  Requirements:

  - conclusion derives from the existing `decisionBucket`, not a new score;
  - role prefers `analysis.roleSummary`, then falls back to the job title;
  - company opportunity uses company name plus meaningful `businessScenario` or `industryContext`, and otherwise says only what the current job material supports;
  - fit uses existing `fitReasons` or stored matches;
  - salary uses the original range/fallback already shown by the card;
  - risk uses current refresh failure, analysis error, and visible risks;
  - every value continues through `escapeHtml()`.

  Do not move or delete the technical detail block.

- [ ] **Step 4: Re-run the focused test**

  Run: `node tests/data_visibility_smoke.js`

  Expected: `data_visibility_smoke ok`.

- [ ] **Step 5: Commit the job-card checkpoint**

  ```powershell
  git add tests/data_visibility_smoke.js src/dashboard/server.js
  git commit -m "feat: lead job cards with user conclusions"
  ```

### Task 5: Validate the combined user-view and status change

**Files:**
- Verify only

- [ ] **Step 1: Run the targeted regression set**

  ```powershell
  node tests/workflow_progress_smoke.js
  node tests/workflow_health_smoke.js
  node tests/workflow_dashboard_smoke.js
  node tests/data_visibility_smoke.js
  ```

  Expected: every test prints its `ok` marker.

- [ ] **Step 2: Run repository hygiene checks**

  ```powershell
  git diff --check
  git status --short
  ```

  Expected: no whitespace errors; only intentional work remains.

