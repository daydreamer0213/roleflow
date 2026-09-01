# RoleFlow Single-Use Workflow Cooldown Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the 120-minute scan interval as the default while allowing one explicitly confirmed early workflow start without bypassing any other BOSS protection.

**Architecture:** The planner remains the source of truth for the interval and exposes whether a one-request override was used while preserving the original `nextRunAt`. The workflow application accepts only the exact form confirmation value, passes it through both planning passes, and stores the result in the existing frozen planner JSON. The Today page renders a native `<dialog>` only for `WORKFLOW_SCAN_INTERVAL`; its confirmation form uses the existing browser-readiness and start-request path.

**Tech Stack:** Node.js CommonJS, built-in `node:sqlite`, server-rendered HTML, native `<dialog>`, existing smoke-test runner.

## Global Constraints

- The override applies only when `confirmEarlyScan === "1"` on the current start request.
- Preserve `nextRunAt`; persist `intervalOverrideUsed: true` only in the newly created workflow planner snapshot.
- Do not change `minRunIntervalMinutes: 120`, daily run/scan budgets, random pacing, fixed tabs, serial execution, checkpoints, or risk-stop behavior.
- Do not bypass active workflow/scan, model, browser readiness, login, risk-control, page-loss, or site-access-budget gates.
- Do not add dependencies, a database migration, or a persistent “disable cooldown” setting.
- Do not access or click the real BOSS page during automated verification.

---

### Task 1: Planner supports one-request interval override

**Files:**
- Modify: `src/core/workflow_run.js:36-103`
- Test: `tests/workflow_planner_smoke.js:86-116`

**Interfaces:**
- Consumes: `planWorkflowRun({ allowEarlyScan?: boolean, lastScanStartedAt, now, ... })`
- Produces: existing plan result plus `intervalOverrideUsed: boolean`; `nextRunAt` remains the unmodified 120-minute deadline.

- [x] **Step 1: Write the failing planner regression**

Add a second assertion next to `intervalBlocked`:

```js
const intervalOverridden = planWorkflowRun(fixture({
  completedRuns: 1,
  inventoryCount: 0,
  usedBudget: { details: 94, pages: 3 },
  lastScanStartedAt: "2026-07-21T03:00:01.000Z",
  allowEarlyScan: true
}));
assert.strictEqual(intervalOverridden.errorCode, null);
assert.strictEqual(intervalOverridden.scanNeeded, true);
assert.strictEqual(intervalOverridden.intervalOverrideUsed, true);
assert.strictEqual(intervalOverridden.nextRunAt, "2026-07-21T05:00:01.000Z");
assert.strictEqual(intervalBlocked.intervalOverrideUsed, false);
```

- [x] **Step 2: Run the planner test and verify RED**

Run: `node tests/workflow_planner_smoke.js`  
Expected: FAIL because the interval is still blocked or `intervalOverrideUsed` is absent.

- [x] **Step 3: Implement the minimal planner branch**

Use the already-computed interval; do not mutate policy:

```js
const intervalOverrideUsed = wantsScan && !interval.ready && input.allowEarlyScan === true;
const intervalBlocked = wantsScan && !interval.ready && !intervalOverrideUsed;
```

Return `intervalOverrideUsed` with the existing plan fields. Keep `nextRunAt: interval.nextRunAt`.

- [x] **Step 4: Run the planner test and verify GREEN**

Run: `node tests/workflow_planner_smoke.js`  
Expected: `workflow_planner_smoke ok`.

- [x] **Step 5: Commit planner behavior**

```powershell
git add -- src/core/workflow_run.js tests/workflow_planner_smoke.js
git commit -m "feat: allow one-request workflow interval override"
```

---

### Task 2: Workflow start validates and freezes the confirmation

**Files:**
- Modify: `src/application/workflow/index.js:1-120`
- Modify: `src/dashboard/server.js:1980-2075`
- Test: `tests/workflow_application_smoke.js`
- Test: `tests/workflow_planner_smoke.js`

**Interfaces:**
- Consumes: form field `confirmEarlyScan` and `buildWorkflowDashboardState(db, plan, now, { allowEarlyScan, ...acquisition })`
- Produces: planner snapshot fields `intervalOverrideUsed` and the original `nextRunAt` through the existing `createWorkflowRun(...planner)` JSON.

- [x] **Step 1: Write the failing application regression**

Add a start fixture whose first and second dashboard-state calls return `WORKFLOW_SCAN_INTERVAL` unless their fourth argument contains `allowEarlyScan: true`. Assert:

```js
const started = await startWorkflow({
  db,
  input: { planId, confirmEarlyScan: "1", modelReady: true },
  deps
});
assert.strictEqual(started.workflow.planner.intervalOverrideUsed, true);
assert.strictEqual(started.workflow.planner.nextRunAt, "2026-07-21T05:00:01.000Z");
```

Also call the same fixture with `confirmEarlyScan: "true"` and assert `WORKFLOW_SCAN_INTERVAL`; only the exact value `"1"` is accepted.

- [x] **Step 2: Run the application test and verify RED**

Run: `node tests/workflow_application_smoke.js`  
Expected: FAIL because the confirmation is not passed into dashboard planning.

- [x] **Step 3: Thread the request-local flag through both planning passes**

At the start of `startWorkflow` derive:

```js
const allowEarlyScan = input.confirmEarlyScan === "1";
```

Pass it to both calls:

```js
buildDashboardState(db, plan, new Date(), { allowEarlyScan });
buildDashboardState(db, plan, new Date(), { ...acquisition, allowEarlyScan });
```

Extend `buildWorkflowDashboardState` option destructuring and pass `allowEarlyScan` to `planWorkflowRun`. No handler-specific bypass is added; all existing checks remain in their current order.

- [x] **Step 4: Prove other gates still win**

In the same application smoke, set an active workflow and a runtime/scan availability rejection while sending `confirmEarlyScan: "1"`. Assert no additional workflow or scan process is created and the existing error/already-active behavior remains unchanged.

- [x] **Step 5: Run application and planner tests**

Run: `node tests/workflow_application_smoke.js`  
Run: `node tests/workflow_planner_smoke.js`  
Expected: both pass.

- [x] **Step 6: Commit request plumbing**

```powershell
git add -- src/application/workflow/index.js src/dashboard/server.js tests/workflow_application_smoke.js tests/workflow_planner_smoke.js
git commit -m "feat: confirm early workflow starts server-side"
```

---

### Task 3: Today page offers an accessible one-time confirmation dialog

**Files:**
- Modify: `src/dashboard/view_models/today.js:121-137`
- Modify: `src/dashboard/pages/today.js:19-31,133-210`
- Modify: `src/dashboard/assets/roleflow.css`
- Test: `tests/today_dashboard_smoke.js`
- Test: `tests/workflow_page_migration_smoke.js`

**Interfaces:**
- Consumes: `nextPlan.errorCode === "WORKFLOW_SCAN_INTERVAL"`, `nextPlan.nextRunAt`, existing browser authority fields.
- Produces: primary action type `cooldown_override`; native dialog controls `data-early-scan-open`, `data-early-scan-dialog`, `data-early-scan-cancel`; confirmed POST field `confirmEarlyScan=1`.

- [x] **Step 1: Write the failing view/render regression**

Create a Today view model with an interval-blocked `nextPlan`. Assert the rendered HTML contains:

```js
assert.match(html, /data-early-scan-open/);
assert.match(html, /<dialog[^>]+data-early-scan-dialog/);
assert.match(html, /name="confirmEarlyScan" value="1"/);
assert.match(html, /连续多轮访问 BOSS 可能增加账号触发限制的风险/);
assert.match(html, /data-browser-readiness-button/);
```

For a normal plan, assert none of the early-scan controls are rendered.

- [x] **Step 2: Run the Today test and verify RED**

Run: `node tests/today_dashboard_smoke.js`  
Expected: FAIL because the interval state still renders only a notice.

- [x] **Step 3: Add the cooldown-specific view model**

Return this shape only for the interval error after existing dependency/runtime checks:

```js
{
  type: "cooldown_override",
  label: "提前开始下一轮",
  status: `建议等待至 ${formattedNextRunAt}`,
  detail: "如果本轮结果不足，可以提前开始。"
}
```

Other planner errors remain notices.

- [x] **Step 4: Render the native dialog using the existing start form**

The dialog contains a sibling cancel button and start form. The confirmed form includes normal `planId`, browser inputs, readiness attributes, plus:

```html
<input type="hidden" name="confirmEarlyScan" value="1">
```

The warning must state that pacing, access budget and risk-stop protections remain active. Do not place the full warning in the always-visible primary panel.

- [x] **Step 5: Wire dialog interaction without a dependency**

In `renderClientScripts`, call `showModal()` from the open button and `close()` from cancel. Change the browser-readiness inclusion predicate to include both `form` and `cooldown_override`. Keep the existing fetch submission path attached to the confirmed form.

- [x] **Step 6: Add minimal dialog styling**

Use existing color variables and button styles; add only backdrop, width, padding and button-row spacing. Do not introduce a reusable modal abstraction.

- [x] **Step 7: Run Today and browser-page regressions**

Run: `node tests/today_dashboard_smoke.js`  
Run: `node tests/workflow_page_migration_smoke.js`  
Expected: both pass; Playwright-dependent assertions may report the repository's existing skip message when Playwright is unavailable.

- [x] **Step 8: Commit the UI**

```powershell
git add -- src/dashboard/view_models/today.js src/dashboard/pages/today.js src/dashboard/assets/roleflow.css tests/today_dashboard_smoke.js tests/workflow_page_migration_smoke.js
git commit -m "feat: confirm early scans from today page"
```

---

### Task 4: Update operator guidance and verify the release candidate

**Files:**
- Modify: `docs/operations.md:145-170`
- Modify: `docs/daily_workflow.md:90-105,170-185`
- Modify: `docs/superpowers/plans/2026-09-01-manual-workflow-cooldown-override.md`

**Interfaces:**
- Consumes: completed behavior and test evidence from Tasks 1-3.
- Produces: user-facing operational description that distinguishes the default interval from non-bypassable platform protections.

- [x] **Step 1: Update operational wording**

Replace “must wait two hours” wording with: two hours is the recommended default; the user may explicitly confirm one early next round; access budgets and risk-control blocks remain mandatory. Keep the recommendation not to rerun only to fill a fixed count.

- [x] **Step 2: Run focused regressions together**

```powershell
node tests/workflow_planner_smoke.js
node tests/workflow_application_smoke.js
node tests/today_dashboard_smoke.js
node tests/workflow_page_migration_smoke.js
```

Expected: all pass.

- [x] **Step 3: Run the complete offline gate**

Run: `npm test`  
Expected: all offline checks pass with zero failures. Record the fresh total from the final line; do not reuse the earlier 132-check result.

- [x] **Step 4: Check the exact working tree**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only the intended documentation/plan updates remain before the final commit.

- [x] **Step 5: Commit documentation and plan completion**

```powershell
git add -- docs/operations.md docs/daily_workflow.md docs/superpowers/plans/2026-09-01-manual-workflow-cooldown-override.md
git commit -m "docs: explain optional workflow cooldown"
```

- [x] **Step 6: Build and switch the local acceptance stage**

After the exact commit passes verification, run `scripts/build-installer.ps1 -StageOnly -SkipTests` with a new `D:\DevData\RoleFlow-first-use-acceptance\package-<short-sha>` build root and pinned `D:\hermes\node`. Stop only the verified old Dashboard process, start the new stage hidden on port 8787 with the existing data root and browser profile, and verify `/api/browser-readiness` plus the Today page. Do not start a workflow or click BOSS.
