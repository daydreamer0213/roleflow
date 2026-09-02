# RoleFlow Workflow Pause, Filter Recovery, and Error Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pause settle before any new BOSS browser action, prevent scan progress from exceeding its frozen target, let a user safely restart the same logical round after changing search filters, and replace technical-first failures with clear user guidance.

**Architecture:** Keep the existing workflow, scan, access-budget, and dashboard boundaries. The BOSS adapter caps accepted cards and validates the active target before accepting each fresh list read; the existing access controller checks workflow control before every reservation. Resume performs a read-only live-scope comparison, while one workflow-store transaction installs an explicitly confirmed replacement snapshot and detaches only terminal historical scan links. A small dashboard presentation mapper turns stable error codes into user-facing title, impact, and next action without changing diagnostic codes or adding a new framework.

**Tech Stack:** Node.js CommonJS, built-in `node:sqlite`, server-rendered HTML, browser-native JavaScript, existing fake-browser and temporary-database smoke tests.

## Global Constraints

- Preserve BOSS read-only defaults, fixed BOSS-SEARCH/BOSS-COMMUNICATION tabs, background execution, random pacing, access budgets, checkpoints, and immediate stop on login/risk/page-loss ambiguity.
- A pause request may finish an already-issued read, but no new navigation, list scroll, detail read, or access reservation may start afterward.
- Never weaken storage bounds to accommodate an oversized in-memory card set.
- Never mix jobs from different search scopes in one scan batch.
- Scope replacement is allowed only for paused or recoverable interrupted scanning with no analysis tasks, no communication batch, no active scan process, and no active BOSS lease.
- Scope replacement keeps the same workflow id, local day, and sequence; the old batch remains historical but is detached from current result/analysis/communication paths.
- Do not add a database table, schema migration, dependency, UI library, global error framework, automatic retry, or a second confirmation dialog.
- All automated tests use fake browsers and temporary databases. Do not access or click the real BOSS page during implementation verification.

---

### Task 1: Enforce the card limit and stop before every new browser action

**Files:**
- Modify: `src/adapters/sites/boss.js:1607-1700,2785-2796`
- Modify: `src/core/site_access_budget.js:31-171`
- Test: `tests/source_acquisition_smoke.js:396-454`
- Test: `tests/site_access_budget_smoke.js`

**Interfaces:**
- Change `mergeUniqueCards(found, cards, limit = Infinity)` to return only cards actually admitted before the frozen limit.
- Keep `collectCards(..., onCards)` callback shape `{ cards, total }`; both values must stay within `maxCards`.
- Keep `createSiteAccessController({ assertActive })`; call `assertActive()` immediately before every reservation attempt and after any wait, before reopening the transaction loop.

- [x] **Step 1: Add a failing over-limit card checkpoint regression**

Extend `cardGrowthCheckpointSmoke` with a fake extraction that jumps from 2 visible cards to 7 while `maxCards` is 4:

```js
const batches = [];
const result = await adapter.collectCards("tab", 4, null, null, ({ cards, total }) => {
  batches.push({ ids: cards.map((entry) => entry.title), total });
});
assert.deepStrictEqual(batches, [
  { ids: ["limit-1", "limit-2"], total: 2 },
  { ids: ["limit-3", "limit-4"], total: 4 }
]);
assert.strictEqual(result.cards.length, 4);
assert(batches.every((entry) => entry.total <= 4));
```

- [x] **Step 2: Add a failing immediate workflow-control regression**

In `tests/site_access_budget_smoke.js`, create a controller with no active cooldown and an `assertActive` spy that throws `WORKFLOW_PAUSE_REQUESTED`. Assert `reserve("list_scroll")` rejects before `recordSiteAccessEvent` writes any ledger row.

```js
await assert.rejects(
  controller.reserve("list_scroll"),
  (error) => error.code === "WORKFLOW_PAUSE_REQUESTED"
);
assert.strictEqual(listSiteAccessEvents(db, { site: "boss", action: "list_scroll" }).length, 0);
```

- [x] **Step 3: Run both tests and verify RED**

Run: `node tests/source_acquisition_smoke.js`  
Expected: FAIL because the final callback contains more than four cards or reports `total > 4`.

Run: `node tests/site_access_budget_smoke.js`  
Expected: FAIL because a normal reservation does not call `assertActive` before writing the access event.

- [x] **Step 4: Implement the minimal bounds and control checks**

Use the remaining capacity when merging:

```js
function mergeUniqueCards(found, cards, limit = Number.POSITIVE_INFINITY) {
  const added = [];
  for (const card of cards || []) {
    if (found.size >= limit) break;
    const key = bossSourceId(card) || `${card.company}|${card.title}|${card.salary}|${card.cardText}`;
    if (found.has(key)) continue;
    found.set(key, card);
    added.push(card);
  }
  return added;
}
```

Pass `maxCards` at all three `collectCards`/`waitForCardGrowth` merge sites. In `reserve`, check the existing callback before the transaction:

```js
while (true) {
  if (typeof assertActive === "function") assertActive();
  throwIfAborted(signal);
  // existing transaction and wait logic
}
```

- [x] **Step 5: Run both tests and verify GREEN**

Run: `node tests/source_acquisition_smoke.js`  
Expected: `source_acquisition_smoke ok`.

Run: `node tests/site_access_budget_smoke.js`  
Expected: `site_access_budget_smoke ok`.

- [x] **Step 6: Commit the browser-boundary fix**

```powershell
git add -- src/adapters/sites/boss.js src/core/site_access_budget.js tests/source_acquisition_smoke.js tests/site_access_budget_smoke.js
git commit -m "fix: stop workflow scans at safe browser boundaries"
```

---

### Task 2: Reject live search-scope drift before accepting new cards

**Files:**
- Modify: `src/core/inherited_search_scope.js:11-39,159-166`
- Modify: `src/adapters/sites/boss.js:1120-1215,1607-1689,2960-2980`
- Modify: `src/cli.js:1320-1470`
- Test: `tests/source_acquisition_smoke.js`
- Test: `tests/workflow_scan_smoke.js`

**Interfaces:**
- Add `canonicalizeBossTargetUrl(rawUrl)` beside the existing template canonicalizer. It preserves the normalized `query` keyword but removes page, tracking, and transient parameters.
- Add optional adapter callback `assertSearchScope({ tabId, expectedUrl, targetKey, phase })`.
- Add `BOSS_SEARCH_SCOPE_CHANGED` to the existing fatal, recoverable scan-stop set.

- [x] **Step 1: Write canonicalization and drift RED tests**

Add assertions proving parameter order/encoding/tracking differences are equal, while keyword, city, subway, salary, experience, education, job type, and unknown platform-filter differences are not.

Create a fake target scan where the first read matches `expectedUrl`, then the URL changes before the next read. Assert:

```js
await assert.rejects(
  () => adapter.scan({
    ...fixture,
    assertSearchScope: async ({ expectedUrl }) => {
      if (currentUrl !== canonicalizeBossTargetUrl(expectedUrl).url) {
        throw bossError("BOSS_SEARCH_SCOPE_CHANGED", "当前搜索条件已经变化。");
      }
    },
    onProgressCheckpoint: (entry) => checkpoints.push(entry)
  }),
  (error) => error.code === "BOSS_SEARCH_SCOPE_CHANGED"
);
assert.deepStrictEqual(checkpointJobs(checkpoints), ["before-change"]);
```

- [x] **Step 2: Run the acquisition test and verify RED**

Run: `node tests/source_acquisition_smoke.js`  
Expected: FAIL because the adapter does not validate the target URL between fresh list reads.

- [x] **Step 3: Implement target canonicalization without changing template semantics**

Keep `canonicalizeBossSearchTemplate` behavior unchanged. Share a private URL-normalization helper and expose a second function that preserves `query`:

```js
function canonicalizeBossTargetUrl(rawUrl) {
  return canonicalizeBossSearchUrl(rawUrl, { keepQuery: true });
}
```

Do not treat `page`, `ka`, `source`, `from`, `src`, `trackId`, `lid`, `_`, `timestamp`, or `utm_*` as scope.

- [x] **Step 4: Validate immediately before card acceptance**

Compute the exact target URL once in `scanBrowser` and pass it through `collectCards`. Call the scope assertion after page identity checks and before each `__bossExtractCards` result is merged. This ordering ensures changed-page cards never enter `found` or a progress callback.

The CLI callback reads the bound search tab URL through the existing browser/adapter path, canonicalizes both URLs, and throws:

```js
const error = new Error("当前 BOSS 搜索条件与本轮目标不同，已停止以避免混合岗位。");
error.code = "BOSS_SEARCH_SCOPE_CHANGED";
throw error;
```

Existing login, risk, tab-loss, and browser failures remain higher priority because page identity is checked first.

- [x] **Step 5: Prove the checkpoint and stop reason**

Run: `node tests/source_acquisition_smoke.js`  
Expected: `source_acquisition_smoke ok`.

Run: `node tests/workflow_scan_smoke.js`  
Expected: `workflow_scan_smoke ok`, including a fake-browser interruption whose persisted stop code is `BOSS_SEARCH_SCOPE_CHANGED` and whose checkpoint contains only pre-change jobs.

- [x] **Step 6: Commit scope-drift protection**

```powershell
git add -- src/core/inherited_search_scope.js src/adapters/sites/boss.js src/cli.js tests/source_acquisition_smoke.js tests/workflow_scan_smoke.js
git commit -m "fix: stop scans when BOSS search scope changes"
```

---

### Task 3: Atomically replace the current scan scope inside the same logical round

**Files:**
- Modify: `src/storage/workflow_store.js:272-370,1178-1220`
- Modify: `src/core/storage.js` export facade only
- Modify: `src/application/workflow/index.js:162-290`
- Modify: `src/dashboard/server.js:560-580,1225-1240,2625-2667,3103-3285`
- Test: `tests/workflow_storage_smoke.js`
- Test: `tests/workflow_application_smoke.js`
- Test: `tests/workflow_dashboard_smoke.js`
- Test: `tests/workflow_store_contract_smoke.js`

**Interfaces:**
- Add store function `replaceWorkflowScanContext(db, input)`.
- Extend resume input with exact action `scopeChoice: "new" | "original" | ""`.
- Inject `resolveCurrentSearchContext` into `resumeWorkflow`; it performs one serialized read-only inspection of the current fixed search tab.
- Return `{ workflow, scopeChange }`, where `scopeChange` is `null` or a plain choice view; no process is spawned when a choice is returned.

- [x] **Step 1: Write the transaction RED tests**

Seed a paused/interrupted scanning workflow with a terminal scan run and batch, then call:

```js
const replaced = replaceWorkflowScanContext(db, {
  workflowRunId,
  expectedUpdatedAt: before.updatedAt,
  planner: nextPlanner,
  replacedAt: "2099-02-02T00:00:00.000Z"
});
assert.strictEqual(replaced.id, before.id);
assert.strictEqual(replaced.localDay, before.localDay);
assert.strictEqual(replaced.sequence, before.sequence);
assert.strictEqual(replaced.scanRunId, "");
assert.strictEqual(replaced.scanBatchId, null);
assert.strictEqual(replaced.resumePhase, "scanning");
assert.strictEqual(replaced.recoveryGeneration, before.recoveryGeneration + 1);
assert.strictEqual(replaced.planner.searchScope.key, nextPlanner.searchScope.key);
assert.deepStrictEqual(replaced.planner.scopeReplacements.at(-1), {
  replacedAt: "2099-02-02T00:00:00.000Z",
  oldScopeKey: before.planner.searchScope.key,
  oldBatchId: before.scanBatchId,
  newScopeKey: nextPlanner.searchScope.key
});
```

Add rollback cases for active scan run/lease, non-scanning resume phase, existing analysis task, existing communication batch, terminal workflow, stale `expectedUpdatedAt`, and invalid new planner. Assert the workflow row is byte-for-byte unchanged and no scan run is created.

- [x] **Step 2: Run storage tests and verify RED**

Run: `node tests/workflow_storage_smoke.js`  
Expected: FAIL because `replaceWorkflowScanContext` does not exist.

- [x] **Step 3: Implement one `BEGIN IMMEDIATE` replacement transaction**

Inside `replaceWorkflowScanContext`, re-read all preconditions and update only the existing workflow row:

```sql
UPDATE workflow_runs SET
  status = 'interrupted',
  planner_json = ?,
  control_state = 'none',
  resume_phase = 'scanning',
  recovery_generation = recovery_generation + 1,
  scan_run_id = NULL,
  scan_batch_id = NULL,
  error_code = NULL,
  error_message = NULL,
  updated_at = ?
WHERE id = ? AND updated_at = ?
```

The new planner is the complete frozen context plus an append-only, metadata-only `scopeReplacements` entry. Do not delete or edit the old scan run, batch, jobs, observations, or access ledger.

Export the new owner function through `src/core/storage.js`. Update the owner-contract expected export list and facade count; exclude this post-split function from the historical body-equivalence list rather than weakening the equivalence checks for existing functions.

- [x] **Step 4: Write application RED tests for read-only comparison and explicit replacement**

Cover three resume outcomes:

```js
// Same live scope: existing batch is resumed.
assert.strictEqual(sameScopeResult.scopeChange, null);
assert.strictEqual(spawns.length, 1);

// Changed scope, no choice: no persistence and no spawn.
assert.deepStrictEqual(changedResult.scopeChange.kind, "search_scope_changed");
assert.deepStrictEqual(getWorkflowRun(db, id), before);
assert.strictEqual(spawns.length, 0);

// Explicit new choice: replacement commits before the new spawn.
assert.strictEqual(events.indexOf("replace-context") < events.indexOf("spawn"), true);
assert.strictEqual(result.workflow.sequence, before.sequence);
```

Also prove `scopeChoice: "new"` is refused if the live page changed again between the comparison and transaction input, or if any replacement precondition is no longer true. `scopeChoice: "original"` follows the existing frozen-plan resume path and never rewrites the planner.

- [x] **Step 5: Implement resume orchestration and the serialized live resolver**

For scan-phase resume only:

1. Complete existing frozen-plan and browser-readiness validation.
2. Read the current fixed search page once through `runBrowserRead`.
3. Compare its canonical scope and query against the frozen scan target/workflow keywords.
4. If changed and no choice, return `scopeChange` without persistence or process launch.
5. If `scopeChoice === "new"`, build and validate a complete inherited acquisition context from the live page, call `replaceWorkflowScanContext`, then launch with no `resumeBatchId` so `startPlanScan` creates and attaches a fresh scan run/batch.
6. If launch fails after commit, call existing `settleFailedWorkflowLaunch`; never reconnect the old batch.

Keep analysis-only resume unchanged and do not require a BOSS scope comparison for local analysis.

- [x] **Step 6: Run application, dashboard, storage, and contract tests**

Run: `node tests/workflow_storage_smoke.js`  
Expected: `workflow storage smoke passed` or the file's existing success marker.

Run: `node tests/workflow_application_smoke.js`  
Expected: `workflow application smoke passed`.

Run: `node tests/workflow_dashboard_smoke.js`  
Expected: `workflow_dashboard_smoke ok`.

Run: `node tests/workflow_store_contract_smoke.js`  
Expected: `workflow_store_contract_smoke ok (5 owner contracts)`.

- [x] **Step 7: Commit same-round scope replacement**

```powershell
git add -- src/storage/workflow_store.js src/core/storage.js src/application/workflow/index.js src/dashboard/server.js tests/workflow_storage_smoke.js tests/workflow_application_smoke.js tests/workflow_dashboard_smoke.js tests/workflow_store_contract_smoke.js
git commit -m "feat: restart a workflow with updated search filters"
```

---

### Task 4: Show pause settling and the changed-scope choice in the workflow page

**Files:**
- Modify: `src/dashboard/view_models/workflow.js:208-280`
- Modify: `src/dashboard/pages/workflow.js:63-110`
- Modify: `src/dashboard/assets/workflow.js:160-180`
- Test: `tests/workflow_page_migration_smoke.js`
- Test: `tests/workflow_dashboard_smoke.js`

**Interfaces:**
- Extend controls with `pauseRequestedVisible` and keep resume available only for true `paused`.
- Extend interrupted phase with optional `scopeChange` containing `newScopeAction` and `originalScopeAction`; both post to the existing resume endpoint with an exact hidden `scopeChoice` value.

- [x] **Step 1: Write the pause-state RED regression**

Render a scanning workflow with `controlState: "pause_requested"` and assert:

```js
assert.match(html, /正在暂停/);
assert.match(html, /显示“本轮已暂停”后再修改 BOSS 搜索条件/);
assert.doesNotMatch(html, /data-action="resume"/);
assert.doesNotMatch(html, />本轮已暂停</);
```

Render the same row as `status: "paused", controlState: "none"` and assert the existing resume button appears.

- [x] **Step 2: Write the changed-scope choice RED regression**

Render the read-only resume result and assert user-first copy and exact actions:

```js
assert.match(html, /搜索条件已经变化/);
assert.match(html, /旧结果不会与新结果混合/);
assert.match(html, /name="scopeChoice" value="new"/);
assert.match(html, /按新条件重新开始本轮/);
assert.match(html, /name="scopeChoice" value="original"/);
assert.match(html, /继续开始时的条件/);
```

- [x] **Step 3: Run page tests and verify RED**

Run: `node tests/workflow_page_migration_smoke.js`  
Expected: FAIL because `pause_requested` still renders as ordinary running state and no scope-choice view exists.

- [x] **Step 4: Implement server-rendered states and client refresh behavior**

Use one explicit control-state branch:

```js
const pauseRequested = running && workflow.controlState === "pause_requested";
return {
  runningVisible: running && !pauseRequested,
  pauseRequestedVisible: pauseRequested,
  pausedVisible: status === "paused"
};
```

Render a non-interactive “正在暂停” group with stop still available if current rules allow it. Update the polling client so a `controlState` change updates the visible group without briefly exposing resume.

Render changed-scope forms from the view model; do not infer authorization in client JavaScript and do not add a second confirmation.

- [x] **Step 5: Run both page/dashboard tests and verify GREEN**

Run: `node tests/workflow_page_migration_smoke.js`  
Expected: `workflow_page_migration_smoke ok`.

Run: `node tests/workflow_dashboard_smoke.js`  
Expected: `workflow_dashboard_smoke ok`.

- [x] **Step 6: Commit the recovery UX**

```powershell
git add -- src/dashboard/view_models/workflow.js src/dashboard/pages/workflow.js src/dashboard/assets/workflow.js tests/workflow_page_migration_smoke.js tests/workflow_dashboard_smoke.js
git commit -m "feat: guide paused workflow filter recovery"
```

---

### Task 5: Present actionable errors while preserving technical diagnostics

**Files:**
- Create: `src/dashboard/user_facing_errors.js`
- Modify: `src/dashboard/view_models/workflow.js:208-252`
- Modify: `src/dashboard/pages/workflow.js:80-105`
- Modify: `src/dashboard/server.js:5231-5340`
- Modify: `src/dashboard/assets/runtime.js:72-118`
- Test: `tests/workflow_page_migration_smoke.js`
- Test: `tests/dashboard_runtime_smoke.js`
- Test: `tests/workflow_dashboard_smoke.js`

**Interfaces:**
- Add `userFacingError(errorOrCode, context = {}) -> { code, title, impact, nextAction, technicalMessage }`.
- Keep API fields `error`, `errorCode`, and `requestId`; `error` becomes directly displayable user text.
- Put `errorCode`, `requestId`, and sanitized technical message inside a native `<details>` block.

- [x] **Step 1: Write mapping and rendering RED regressions**

Table-drive at least:

```js
[
  ["SCAN_CHECKPOINT_FAILED", "采集进度没有继续保存", "已经保存的岗位仍然保留"],
  ["BOSS_SEARCH_SCOPE_CHANGED", "搜索条件已经变化", "旧结果不会与新结果混合"],
  ["BROWSER_TIMEOUT", "BOSS 页面响应较慢", "页面加载完成后重新检查"],
  ["BOSS_WORKSPACE_NOT_READY", "BOSS 页面还没有准备好", "检查搜索页和消息页"],
  ["UNKNOWN_PRIVATE_CODE", "操作没有完成", "当前进度已保留"]
]
```

Assert the primary interrupted card does not print `UNKNOWN_PRIVATE_CODE · private stack/message`, while a closed `<details>` contains the stable code and request id.

For `runtime.js`, simulate a non-2xx JSON response `{ error: "请先等待专用 Edge 准备完成。", errorCode, requestId }` and assert the visible message uses `payload.error` instead of the fixed fallback.

- [x] **Step 2: Run UI/runtime tests and verify RED**

Run: `node tests/workflow_page_migration_smoke.js`  
Run: `node tests/dashboard_runtime_smoke.js`  
Expected: FAIL because technical codes are primary and the runtime client discards the server response body.

- [x] **Step 3: Implement the small presentation mapper**

Keep the map local to dashboard presentation. Example entry:

```js
BROWSER_TIMEOUT: {
  title: "BOSS 页面响应较慢",
  impact: "本次检查已经停止，RoleFlow 不会在后台自动重试。",
  nextAction: "等 BOSS 页面加载完成后，回到这里重新检查。"
}
```

Use the conservative fallback from the approved design. Reuse existing communication/login/risk/model labels where already present instead of duplicating their state machines.

- [x] **Step 4: Preserve API payload details in the runtime client**

Throw the parsed payload, not only its code:

```js
if (!response.ok) throw Object.assign(new Error(String(payload?.error || "请求没有完成。")), { payload });
```

In `catch (error)`, render `error.payload?.error || error.message || fallback`. Do not auto-retry an action POST; normal status polling may continue under existing rules.

- [x] **Step 5: Run targeted error tests and verify GREEN**

Run: `node tests/workflow_page_migration_smoke.js`  
Expected: `workflow_page_migration_smoke ok`.

Run: `node tests/dashboard_runtime_smoke.js`  
Expected: `dashboard_runtime_smoke ok`.

Run: `node tests/workflow_dashboard_smoke.js`  
Expected: `workflow_dashboard_smoke ok`.

- [x] **Step 6: Commit user-facing errors**

```powershell
git add -- src/dashboard/user_facing_errors.js src/dashboard/view_models/workflow.js src/dashboard/pages/workflow.js src/dashboard/server.js src/dashboard/assets/runtime.js tests/workflow_page_migration_smoke.js tests/dashboard_runtime_smoke.js tests/workflow_dashboard_smoke.js
git commit -m "fix: explain workflow failures in user language"
```

---

### Task 6: Run the full offline gate and record the acceptance boundary

**Files:**
- Modify if evidence changes: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/superpowers/plans/2026-09-02-workflow-pause-filter-recovery-error-guidance.md` checkboxes only

- [x] **Step 1: Run the combined high-risk regressions**

Run in this order:

```powershell
node tests/source_acquisition_smoke.js
node tests/site_access_budget_smoke.js
node tests/workflow_scan_smoke.js
node tests/workflow_storage_smoke.js
node tests/workflow_application_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/workflow_page_migration_smoke.js
node tests/dashboard_runtime_smoke.js
node tests/workflow_store_contract_smoke.js
node tests/scan_end_to_end_recovery_smoke.js
```

Expected: every command exits 0 with its existing success marker. No test may connect to a real BOSS page.

- [x] **Step 2: Perform a read-only risk review**

Inspect the final diff against the approved design and explicitly verify:

- changed-page cards cannot reach a checkpoint;
- pause is checked before every reserved browser action;
- replacement transaction refuses active scan/lease, analysis, communication, or stale version;
- old batch remains stored but is detached from current workflow analysis;
- same workflow id/day/sequence remain unchanged;
- original-scope resume never rewrites the planner;
- technical codes remain available in diagnostics but are not primary user copy;
- no external-write permission or communication path changed.

- [x] **Step 3: Run the fresh full offline gate**

Run: `npm test`  
Expected: `All <fresh-count> offline checks passed.` Record the actual count from this run; do not reuse the previous release count.

- [x] **Step 4: Run repository hygiene checks**

Run: `git diff --check`  
Expected: no output and exit 0.

Run: `git status --short --branch`  
Expected: only intentional plan/handoff checkbox changes remain before the final evidence commit.

- [x] **Step 5: Commit final evidence**

```powershell
git add -- docs/PROJECT_HANDOFF.md docs/superpowers/plans/2026-09-02-workflow-pause-filter-recovery-error-guidance.md
git commit -m "docs: record workflow filter recovery verification"
```

- [ ] **Step 6: Verify the exact final commit**

Run the high-risk regressions again on exact `HEAD`, then:

```powershell
git rev-parse HEAD
git status --short --branch
```

Expected: exact final SHA recorded, worktree clean except that the local branch is ahead of `origin/main`. Do not push, merge, package, release, install, or run real-page acceptance without a new explicit user request.
