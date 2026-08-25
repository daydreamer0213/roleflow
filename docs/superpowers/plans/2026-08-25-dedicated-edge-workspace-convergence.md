# Dedicated Edge Workspace Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed RoleFlow application automatically converge its dedicated Edge window to a usable Dashboard + BOSS search + BOSS communication workspace, while leaving login and risk-control actions to the user.

**Architecture:** Keep `prepareWorkspaceTabs()` as the only safe tab-creation primitive, but place it behind one serialized Dashboard workspace coordinator. The coordinator first waits for two identical tab snapshots, then reconciles idempotently. It is reused by startup, a bounded login monitor, the manual endpoint, and browser-dependent workflow gates. The startup script waits for the coordinator's first checked state instead of treating browser-process readiness as complete workspace readiness.

**Tech Stack:** Node.js 22 CommonJS, native HTTP server, native CDP/WebSocket, PowerShell launcher, existing assert-based smoke tests.

## Global Constraints

- BOSS access remains read-only. No communication or application action is authorized by this plan.
- All automatic tab creation is same-window, serial, and background-only. Never call `Page.bringToFront`; only the existing user-invoked startup guidance path may do that once.
- Production JD acquisition remains `trusted_pane`. Do not enable, repair, validate, or delete `search_page_api`, and do not introduce a general `standalone_detail` path.
- Do not navigate or refresh an already-correct BOSS tab. Create only a missing known page, then verify tab identity and window ownership.
- Preserve login/risk-control stops, pacing, access budgets, checkpointing, and the approved message-discovery transient-detail exception.
- Do not add a new process, dependency, browser profile, or second BOSS window.

---

### Task 1: Wait for a stable Edge tab snapshot before reconciling

**Files:**
- Modify: `tests/workspace_tabs_smoke.js`
- Modify: `src/core/workspace_tabs.js`

**Interfaces:**
- Add an internal stable-snapshot helper that repeatedly consumes `browser.listTabs()`.
- Accept injectable timing functions in `prepareWorkspaceTabs()` so offline tests do not sleep.
- Preserve numeric tab IDs and compare only stable identity fields: tab ID, window ID, normalized URL kind, and active state.

- [ ] **Step 1: Write a failing transient-restore regression test**

Create a fake browser whose first snapshots are incomplete or changing and whose final two snapshots are identical. Call `prepareWorkspaceTabs()` with a zero-delay injected sleeper and assert that no tab is created until the identical pair has been observed.

- [ ] **Step 2: Write a failing stability-timeout regression test**

Keep changing the fake snapshot until the injected deadline expires. Assert a typed workspace error/status is returned and that `newPage`, `navigate`, `closeTab`, and `Page.bringToFront` are never called.

- [ ] **Step 3: Run the focused test and confirm RED**

Run: `node tests/workspace_tabs_smoke.js`

Expected: FAIL because the current implementation classifies the first snapshot immediately.

- [ ] **Step 4: Implement the smallest stable-snapshot loop**

Add a helper equivalent to:

```js
async function listStableWorkspaceTabs(browser, {
  intervalMs = 250,
  timeoutMs = 5000,
  sleepFn = wait,
  nowFn = Date.now,
} = {})
```

Sort a typed projection before comparison, require two consecutive equal projections, and return the original latest tab objects. A timeout must stop safely rather than guessing a topology.

- [ ] **Step 5: Use the stable snapshot at the start of `prepareWorkspaceTabs()`**

Do not change the existing supported-topology rules or page-creation proof. Re-list and re-verify after any creation exactly as today.

- [ ] **Step 6: Run the focused test and confirm GREEN**

Run: `node tests/workspace_tabs_smoke.js`

Expected: PASS, including existing background-creation and ambiguity cases.

### Task 2: Centralize workspace reconciliation in the Dashboard process

**Files:**
- Modify: `tests/dashboard_runtime_smoke.js`
- Modify: `src/dashboard/server.js`

**Interfaces:**
- Add one in-memory serialized function, conceptually `reconcileWorkspace({ reason, startupGuidance })`.
- All callers share the same active Promise; state publication occurs only from that function.
- `startupGuidance` defaults to `false` and must be true only for the existing explicit launcher path.

- [ ] **Step 1: Write a failing serialization test**

Send two concurrent `/api/runtime/workspace/reconcile` requests with a deferred fake reconciler. Assert the underlying reconciliation runs once and both callers receive the same final workspace snapshot.

- [ ] **Step 2: Write a failing stale-snapshot replacement test**

Seed the server with `workspace.status: "ambiguous"`, make the next reconciliation return `ready`, and assert the runtime endpoint publishes `ready` after the shared operation rather than retaining the startup snapshot.

- [ ] **Step 3: Run the focused test and confirm RED**

Run: `node tests/dashboard_runtime_smoke.js`

Expected: FAIL because reconciliation is currently route-local/one-shot rather than a shared lifecycle service.

- [ ] **Step 4: Implement the serialized coordinator**

Keep a single active reconciliation Promise inside `createDashboardServer()`. Route startup initialization and the manual reconcile endpoint through it. Normalize all errors to the existing public workspace state without exposing local paths, raw DOM, or browser internals.

- [ ] **Step 5: Run the focused test and confirm GREEN**

Run: `node tests/dashboard_runtime_smoke.js`

Expected: PASS.

### Task 3: Continue automatically after the user logs in

**Files:**
- Modify: `tests/dashboard_runtime_smoke.js`
- Modify: `src/dashboard/server.js`

**Interfaces:**
- When reconciliation returns `login_required`, schedule a read-only recheck after a random 10–15 seconds.
- Stop after 30 minutes, on `ready`, on a non-retryable conflict, or when the server closes.
- Inject scheduler, cancellation, clock, and random functions for deterministic tests.

- [ ] **Step 1: Write failing login-monitor lifecycle tests**

Cover: `login_required -> ready`, repeated `login_required` until the 30-minute deadline, server close, and non-retryable ambiguity. Assert only one timer exists and every automatic call uses `startupGuidance:false`.

- [ ] **Step 2: Write a failing no-focus test**

Use a fake browser that records commands. Assert the login monitor performs DOM/readiness inspection and background creation only, with zero `Page.bringToFront` calls.

- [ ] **Step 3: Run the focused test and confirm RED**

Run: `node tests/dashboard_runtime_smoke.js`

Expected: FAIL because there is no bounded automatic login continuation.

- [ ] **Step 4: Implement the bounded monitor**

Start it only after a checked `login_required` result. Reuse the serialized coordinator, randomize each interval in the inclusive 10–15 second range, and cancel before scheduling the next pass. Do not poll the BOSS page through navigation or search requests.

- [ ] **Step 5: Run the focused test and confirm GREEN**

Run: `node tests/dashboard_runtime_smoke.js`

Expected: PASS.

### Task 4: Reconcile once before browser-dependent workflow rejection

**Files:**
- Modify: `tests/dashboard_runtime_smoke.js`
- Modify: `tests/workflow_recovery_smoke.js` if the existing gate coverage lives there
- Modify: `src/dashboard/server.js`

**Interfaces:**
- Add a small server-local helper that ensures the dedicated browser and then invokes the shared workspace coordinator once before `assertWorkflowResumeBrowserReady()`.
- Apply it only to actions that actually require the managed browser; keep purely local pages and analysis reads browser-free.

- [ ] **Step 1: Write a failing missing-tab self-heal test**

Seed readiness with a missing search or communication page. Start/resume the relevant workflow action and make reconciliation return `ready`. Assert the action proceeds and the user is not told to open a page manually.

- [ ] **Step 2: Write a failing unrecoverable-state test**

Make reconciliation return login/risk-control or an unprovable multi-window conflict. Assert the workflow remains stopped with the existing concrete user guidance and no repeated creation attempt.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```text
node tests/dashboard_runtime_smoke.js
node tests/workflow_recovery_smoke.js
```

Expected: the first test fails because the current gate rejects the stale state without reconciling.

- [ ] **Step 4: Implement the pre-gate reconciliation**

Use the same coordinator from Tasks 2–3. Do not add a parallel preparation path in the workflow module. Re-read the public readiness snapshot after reconciliation and only then invoke the existing gate.

- [ ] **Step 5: Run the focused tests and confirm GREEN**

Run the two commands above. Expected: PASS.

### Task 5: Make the launcher wait for a checked workspace outcome

**Files:**
- Modify: `tests/startup_scripts_smoke.js`
- Modify: `scripts/start-workspace.ps1`

**Interfaces:**
- `Wait-DashboardRuntimeStatus` must consider both browser readiness and `workspace.status`.
- `ready` and `login_required` are successful application starts with different guidance.
- `unchecked` and `converging` continue waiting within the existing bounded startup window.

- [ ] **Step 1: Write failing launcher-status tests**

Use sequenced fake runtime responses to cover browser-ready/workspace-unchecked followed by `ready`, and browser-ready/workspace-`login_required`. Assert the launcher does not prematurely report complete readiness and does not show a launch-failure dialog for `login_required`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node tests/startup_scripts_smoke.js`

Expected: FAIL because the current PowerShell readiness predicate stops at `browser.ready=true`.

- [ ] **Step 3: Implement the workspace-aware predicate**

Keep the Dashboard process as the only reconciliation owner; the script must not run a second synchronous `workspace-tabs` command. Return a small status object that distinguishes `ready`, `login_required`, retryable waiting, and stable conflict.

- [ ] **Step 4: Run focused workspace/startup tests**

Run:

```text
node tests/workspace_tabs_smoke.js
node tests/dashboard_runtime_smoke.js
node tests/startup_scripts_smoke.js
node tests/browser_supervisor_smoke.js
node tests/workflow_recovery_smoke.js
```

Expected: PASS.

### Task 6: Verify and commit the workspace phase

**Files:**
- Modify only files required by failures found above.

- [ ] **Step 1: Run the complete offline suite**

Run: `npm test`

Expected: every offline check passes.

- [ ] **Step 2: Review safety-sensitive calls**

Run source searches for `Page.bringToFront`, `search_page_api`, and `standalone_detail`. Confirm this phase adds no new call outside the documented startup exception and does not alter the deferred paths.

- [ ] **Step 3: Review the exact diff**

Run `git diff --check` and inspect every changed hunk for duplicate reconciliation paths, unbounded timers, foreground changes, or navigation of correct tabs.

- [ ] **Step 4: Commit**

Commit only the workspace implementation and its regression tests with:

```text
fix: converge dedicated edge workspace
```
