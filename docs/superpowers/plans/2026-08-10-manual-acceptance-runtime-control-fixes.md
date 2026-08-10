# Manual Acceptance Runtime Control Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workflow pause reliable, expose safe scan cooldowns without false stale warnings, and preserve each successfully read JD before a long wait can be interrupted.

**Architecture:** Keep the existing dashboard, scan process, access-budget controller, and target-level recovery model. Add a small workflow wait record in `metrics_json`, combine scan heartbeat with workflow activity in the public snapshot, poll workflow control during long budget sleeps, and add a job-only scan checkpoint that does not mark a target complete.

**Tech Stack:** Node.js CommonJS, built-in Node SQLite, server-rendered HTML/JavaScript, existing smoke-test scripts.

## Global Constraints

- Do not change BOSS access limits, pacing, random delays, cooldown duration, fixed-tab rules, JD coverage, or recommendation quality.
- Do not resume the currently paused live workflow as part of implementation.
- Add only regression assertions that directly cover the observed defects.
- Persist a partial JD without inserting `scan_target_results`; an interrupted target must remain resumable.
- Keep the dashboard's existing three-minute process termination as a hard-failure fallback.

---

### Task 1: Reliable workflow controls and truthful cooldown status

**Files:**
- Modify: `src/dashboard/server.js`
- Modify: `src/core/workflow_progress.js`
- Modify: `src/core/storage.js`
- Test: `tests/workflow_dashboard_smoke.js`
- Test: `tests/workflow_progress_smoke.js`

**Interfaces:**
- Produces: `recordWorkflowScanWait(db, { workflowRunId, runId, action, delayMs, retryAt, now })`
- Changes: `recordWorkflowPlatformAccess(...)` always advances activity and removes `metrics.scanWait`
- Changes: `getWorkflowProgressSnapshot(...)` returns `progress.scanWait` and a heartbeat-aware `workflow.lastActivityAt`

- [ ] **Step 1: Write failing dashboard form assertions**

Add assertions beside the existing pause form checks:

```js
assert.match(page.body, /name="action" value="pause"/);
assert.match(page.body, /name="action" value="resume"/);
assert.doesNotMatch(page.body, /data-action="pause" name="action"/);
```

- [ ] **Step 2: Run the dashboard smoke test and verify RED**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
```

Expected: FAIL because pause/resume still carry `name="action"` on the buttons.

- [ ] **Step 3: Render hidden action fields**

Change the two forms to this pattern:

```js
<form method="post" action="/api/workflow-control" data-workflow-control-form>
  ${controlIdentity}
  <input type="hidden" name="action" value="pause">
  <button data-workflow-control data-action="pause">暂停本轮</button>
</form>
```

Use `value="resume"` for the resume form. Keep the existing disabled-state expressions on the buttons.

- [ ] **Step 4: Run the dashboard smoke test and verify GREEN**

Run `node tests/workflow_dashboard_smoke.js`.

Expected: `workflow_dashboard_smoke ok`.

- [ ] **Step 5: Write failing workflow wait and heartbeat assertions**

In `tests/workflow_progress_smoke.js`, seed a workflow whose `last_activity_at` is old, whose bound scan run has a newer `heartbeat_at`, and whose metrics contain:

```js
{
  scanWait: {
    runId: scenario.scanRunId,
    action: "detail_open",
    retryAt: "2026-08-15T00:10:00.000Z",
    delayMs: 600000
  }
}
```

Assert:

```js
assert.strictEqual(snapshot.workflow.lastActivityAt, "2026-08-15T00:00:20.000Z");
assert.deepStrictEqual(snapshot.progress.scanWait, {
  action: "detail_open",
  retryAt: "2026-08-15T00:10:00.000Z",
  delayMs: 600000
});
```

Also call `recordWorkflowPlatformAccess` at a later clock and assert `lastActivityAt` advances and `metrics.scanWait` is removed.

- [ ] **Step 6: Run the workflow progress smoke test and verify RED**

Run `node tests/workflow_progress_smoke.js`.

Expected: FAIL because the snapshot ignores scan heartbeat/wait state and platform access does not advance activity.

- [ ] **Step 7: Implement wait persistence and heartbeat-aware snapshots**

In `src/core/storage.js`, add and export:

```js
function recordWorkflowScanWait(db, {
  workflowRunId,
  runId,
  action,
  delayMs,
  retryAt,
  now
}) {
  const id = String(workflowRunId || "").trim();
  if (!id) return null;
  const clock = String(now || nowIso());
  const wait = JSON.stringify({
    runId: String(runId || ""),
    action: String(action || ""),
    delayMs: Math.max(0, Number(delayMs || 0)),
    retryAt: String(retryAt || "")
  });
  const result = db.prepare(`
    UPDATE workflow_runs SET
      metrics_json = json_set(COALESCE(metrics_json, '{}'), '$.scanWait', json(?)),
      last_activity_at = ?,
      updated_at = ?,
      progress_revision = progress_revision + 1
    WHERE id = ?
  `).run(wait, clock, clock, id);
  return Number(result.changes || 0) > 0 ? getWorkflowRun(db, id) : null;
}
```

Update `recordWorkflowPlatformAccess` atomically:

```sql
platform_access_started_at = COALESCE(platform_access_started_at, ?),
metrics_json = json_remove(COALESCE(metrics_json, '{}'), '$.scanWait'),
last_activity_at = ?,
updated_at = ?,
progress_revision = progress_revision + 1
```

In `src/core/workflow_progress.js`, select `scan_run_id`, read the bound scan heartbeat, choose the later valid ISO time, and expose only a current wait that belongs to the active scan run:

```js
const scanWait = status === "scanning"
  && metrics.scanWait?.runId === workflow.scan_run_id
  && Date.parse(metrics.scanWait.retryAt) > Date.parse(clock)
  ? {
      action: String(metrics.scanWait.action || ""),
      retryAt: metrics.scanWait.retryAt,
      delayMs: Math.max(0, Number(metrics.scanWait.delayMs || 0))
    }
  : null;
```

- [ ] **Step 8: Render and poll the cooldown message**

Add a `data-scan-wait` paragraph to the workflow panel. Initial rendering and the 2.5-second poll should display:

```text
安全冷却中，预计 N 分钟后继续（HH:MM:SS）
```

Hide it when `progress.scanWait` is null or expired. Call the cooldown renderer on every successful poll, even when `progressRevision` is unchanged, so the countdown advances.

- [ ] **Step 9: Run Task 1 tests and commit**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
node tests/workflow_progress_smoke.js
```

Expected: both print `ok`.

Commit:

```powershell
git add src/dashboard/server.js src/core/workflow_progress.js src/core/storage.js tests/workflow_dashboard_smoke.js tests/workflow_progress_smoke.js
git commit -m "fix: report workflow cooldown and activity"
```

---

### Task 2: Interruptible access-budget cooldown

**Files:**
- Modify: `src/core/site_access_budget.js`
- Modify: `src/cli.js`
- Test: `tests/site_access_budget_smoke.js`
- Test: `tests/scan_cli_lifecycle_smoke.js`

**Interfaces:**
- Consumes: `recordWorkflowScanWait(...)` from Task 1
- Changes: `createSiteAccessController({ ..., onWait, assertActive, controlPollIntervalMs })`

- [ ] **Step 1: Write a failing segmented-wait test**

Fill a short-window budget, then create a controller with:

```js
const sleeps = [];
const waits = [];
let checks = 0;
const controller = createSiteAccessController({
  db,
  site: "boss",
  nowFn: () => now,
  sleepFn: async (ms) => {
    sleeps.push(ms);
    now += ms;
  },
  controlPollIntervalMs: 1000,
  onWait: (wait) => waits.push(wait),
  assertActive: () => {
    checks += 1;
    if (checks === 3) {
      const error = new Error("pause");
      error.code = "WORKFLOW_PAUSE_REQUESTED";
      throw error;
    }
  }
});
```

Assert the reserve rejects with `WORKFLOW_PAUSE_REQUESTED`, `onWait` reports a future `retryAt`, and no sleep exceeds 1000ms.

- [ ] **Step 2: Run the budget smoke test and verify RED**

Run `node tests/site_access_budget_smoke.js`.

Expected: FAIL because the controller does not support `onWait` or control polling.

- [ ] **Step 3: Implement condition-based cooldown waiting**

Add optional controller inputs:

```js
onWait = null,
assertActive = null,
controlPollIntervalMs = 1000
```

Before sleeping:

```js
const wait = {
  site,
  action: normalizedAction,
  delayMs,
  retryAt: new Date(nowMs + delayMs).toISOString(),
  waitedMs,
  usage,
  limits,
  windows: blockers.map((item) => item.window)
};
if (typeof onWait === "function") await onWait(wait);
await controlledSleep(delayMs, {
  signal,
  sleepFn,
  assertActive,
  intervalMs: controlPollIntervalMs
});
```

`controlledSleep` must keep the existing one-shot behavior when `assertActive` is absent. When present, check before and after each slice and sleep at most `intervalMs`.

- [ ] **Step 4: Run the budget smoke test and verify GREEN**

Run `node tests/site_access_budget_smoke.js`.

Expected: `site_access_budget_smoke ok`.

- [ ] **Step 5: Wire workflow control and wait persistence in CLI**

Import `recordWorkflowScanWait`. In the workflow scan controller options add:

```js
assertActive: workflowRun
  ? () => assertWorkflowScanControl(db, workflowRun.id)
  : null,
onWait: workflowRun
  ? (wait) => recordWorkflowScanWait(db, {
      workflowRunId: workflowRun.id,
      runId: execution?.runId || "",
      action: wait.action,
      delayMs: wait.delayMs,
      retryAt: wait.retryAt
    })
  : null
```

Keep the existing signal and `onReserved` hook.

- [ ] **Step 6: Add one CLI lifecycle assertion and run tests**

Use the existing exported `assertWorkflowScanControl` fixture to confirm `pause_requested` still throws `WORKFLOW_PAUSE_REQUESTED`; do not duplicate broader scan lifecycle coverage.

Run:

```powershell
node tests/site_access_budget_smoke.js
node tests/scan_cli_lifecycle_smoke.js
```

Expected: both print `ok`.

- [ ] **Step 7: Commit**

```powershell
git add src/core/site_access_budget.js src/cli.js tests/site_access_budget_smoke.js tests/scan_cli_lifecycle_smoke.js
git commit -m "fix: interrupt workflow cooldown waits"
```

---

### Task 3: Preserve each successfully read JD

**Files:**
- Modify: `src/core/storage.js`
- Modify: `src/adapters/sites/boss.js`
- Modify: `src/cli.js`
- Test: `tests/scan_recovery_smoke.js`
- Test: `tests/source_acquisition_smoke.js`

**Interfaces:**
- Produces: `checkpointScanProgress(db, { runId, batchId, leaseOwner, jobs })`
- Changes: BOSS scan option `onDetailCheckpoint({ targetKey, city, cityCode, keyword, laneId, job })`

- [ ] **Step 1: Write a failing storage checkpoint test**

Start a scan run and call:

```js
const checkpoint = checkpointScanProgress(database, {
  runId,
  batchId,
  leaseOwner: context.owner,
  jobs: [job("partial-detail", "Partial Detail")]
});
```

Assert:

```js
assert.strictEqual(checkpoint.jobCount, 1);
assert.strictEqual(count(database, "SELECT COUNT(*) AS count FROM job_observations WHERE batch_id = ?", batchId), 1);
assert.strictEqual(listScanTargetResults(database, batchId).length, 0);
```

- [ ] **Step 2: Run the recovery smoke test and verify RED**

Run `node tests/scan_recovery_smoke.js`.

Expected: FAIL because `checkpointScanProgress` is not exported.

- [ ] **Step 3: Implement the job-only transactional checkpoint**

Add `checkpointScanProgress` beside `checkpointScanTarget`. It must perform the same run/batch/owner/lease checks, call `upsertJob` for each input job, update `scan_runs.heartbeat_at`, commit, and return `{ runId, batchId, jobCount, jobIds }`. It must never call `recordScanTargetResult`.

- [ ] **Step 4: Run the recovery smoke test and verify GREEN**

Run `node tests/scan_recovery_smoke.js`.

Expected: `scan_recovery_smoke ok`.

- [ ] **Step 5: Write failing adapter assertions**

In a focused existing source-acquisition scenario, collect `onDetailCheckpoint` calls and assert the successful detailed job has `detailRead === true` and the complete description.

Add one pause scenario where detail pacing throws:

```js
const pause = new Error("pause");
pause.code = "WORKFLOW_PAUSE_REQUESTED";
```

Assert the scan rejects with that code and `onTargetComplete` receives no failed target.

- [ ] **Step 6: Run source acquisition smoke and verify RED**

Run `node tests/source_acquisition_smoke.js`.

Expected: FAIL because the adapter does not emit incremental detail checkpoints and treats workflow control errors as target failures.

- [ ] **Step 7: Emit detail checkpoints and preserve control errors**

Immediately after merging a successful `detailedJob` and before `waitAfterDetailAction`, call:

```js
if (typeof options.onDetailCheckpoint === "function") {
  await options.onDetailCheckpoint({
    targetKey,
    city: city.city || "",
    cityCode: city.cityCode,
    keyword,
    laneId,
    job: detailedJob
  });
}
```

Add:

```js
function isWorkflowControlError(error) {
  return ["WORKFLOW_PAUSE_REQUESTED", "WORKFLOW_STOP_REQUESTED"]
    .includes(String(error?.code || ""));
}
```

Rethrow these errors before detail failure handling and before the outer target catch writes `onTargetComplete({ status: "failed" })`.

- [ ] **Step 8: Wire the CLI job-only checkpoint**

Import `checkpointScanProgress` and provide:

```js
onDetailCheckpoint: args.input ? null : async (result) => {
  const job = checkpointScannedJob(result.job, configs);
  checkpointScanProgress(db, {
    runId: execution.runId,
    batchId,
    leaseOwner: execution.leaseOwner,
    jobs: [job]
  });
}
```

Wrap non-lease errors as `SCAN_CHECKPOINT_FAILED`, matching `onTargetComplete`.

- [ ] **Step 9: Run Task 3 tests and commit**

Run:

```powershell
node tests/scan_recovery_smoke.js
node tests/source_acquisition_smoke.js
node tests/scan_cli_lifecycle_smoke.js
```

Expected: all print `ok`.

Commit:

```powershell
git add src/core/storage.js src/adapters/sites/boss.js src/cli.js tests/scan_recovery_smoke.js tests/source_acquisition_smoke.js
git commit -m "fix: checkpoint successful job details"
```

---

### Task 4: Review, full verification, checkpoint, and merge

**Files:**
- Verify: all modified source, tests, spec, and plan files
- Update only if verification exposes a defect

**Interfaces:**
- Produces: a reviewed branch, a pre-merge checkpoint tag, and a verified merge on `main`

- [ ] **Step 1: Review only the branch diff**

Run:

```powershell
git diff --check main...HEAD
git diff --stat main...HEAD
git diff main...HEAD -- src tests docs/superpowers
```

Confirm no safety limit, coverage, fixed-tab, or unrelated UI changes.

- [ ] **Step 2: Run focused regression tests**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
node tests/workflow_progress_smoke.js
node tests/site_access_budget_smoke.js
node tests/scan_recovery_smoke.js
node tests/source_acquisition_smoke.js
node tests/scan_cli_lifecycle_smoke.js
```

Expected: all six print `ok`.

- [ ] **Step 3: Run the full suite**

Run:

```powershell
npm.cmd test
```

Expected: exit code 0 with every test passing.

- [ ] **Step 4: Create a pre-merge checkpoint**

From the main checkout:

```powershell
git tag -a checkpoint/pre-manual-acceptance-runtime-fixes-20260810 -m "Checkpoint before manual acceptance runtime control fixes"
```

Confirm the tag points to the pre-merge `main` commit.

- [ ] **Step 5: Merge the reviewed branch**

From the clean main checkout:

```powershell
git merge --no-ff codex/manual-acceptance-runtime-fixes -m "merge: fix manual acceptance runtime controls"
```

- [ ] **Step 6: Verify merged main**

Run `npm.cmd test` from the main checkout.

Expected: exit code 0 with every test passing.

- [ ] **Step 7: Restart only the dashboard**

Stop the existing local dashboard process and start it from merged `main`. Do not resume the workflow scan. Verify the workflow page still shows the existing run as paused and the continue button remains enabled.

---

### Task 5: Bind a resumed scan before the workflow page can recover it

**Files:**
- Modify: `src/dashboard/server.js`
- Test: `tests/workflow_dashboard_smoke.js`
- Document: `docs/superpowers/specs/2026-08-10-manual-acceptance-runtime-control-fixes-design.md`

**Interfaces:**
- Consumes: `startPlanScan(scanRuns, options)`, `createScanRun(db, input)`, and `attachWorkflowScan(db, input)`
- Produces: a resumed scan whose new `scan_run_id` is persisted before the child process starts or the redirected workflow page is queried

- [ ] **Step 1: Write the failing regression assertion**

Immediately after the existing valid scanning-resume request, capture the newly created scan run and assert:

```js
const resumedScan = getLatestScanRun(db, { planId: saved.planId, site: "boss" });
assert.strictEqual(getWorkflowRun(db, workflow.id).scanRunId, resumedScan.id);

const liveResumedStatus = await getJson(
  baseUrl,
  `/api/workflow-status?runId=${encodeURIComponent(workflow.id)}`
);
assert.strictEqual(liveResumedStatus.body.workflow.status, "scanning");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
```

Expected: FAIL because the workflow still points to the previous interrupted scan when the resume response returns.

- [ ] **Step 3: Implement the minimal pre-spawn binding**

In `startPlanScan`, after `createScanRun` and before `spawnProcess`, call `attachWorkflowScan` whenever the workflow has a persisted resume batch:

```js
if (workflowRun && persistedResumeBatchId) {
  attachWorkflowScan(db, {
    id: workflowRun.id,
    scanRunId: runId,
    scanBatchId: persistedResumeBatchId
  });
}
```

Keep the existing failure settlement around this operation so a rejected bind marks the new scan run failed and does not spawn a child.

- [ ] **Step 4: Run focused verification**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
node tests/dashboard_scan_lifecycle_smoke.js
node tests/workflow_recovery_smoke.js
```

Expected: all three print `ok`.

- [ ] **Step 5: Run full verification and integrate**

Run `npm.cmd test`, review `git diff --check`, commit the branch, create a new pre-merge checkpoint tag on `main`, merge with `--no-ff`, and run `npm.cmd test` again from merged `main`.

- [ ] **Step 6: Restart manual acceptance**

Restart only the dashboard from merged `main`. Preserve the two fixed logged-in BOSS tabs. Reopen the current workflow page and continue from the interrupted run only after confirming the new scan binding is visible.
