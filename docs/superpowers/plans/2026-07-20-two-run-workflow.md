# Two-Run Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one persisted `run once` workflow that the user can manually execute at most twice per China-local day, with each run completing scan, model analysis, review, communication, reconciliation, and shutdown.

**Architecture:** Add a small workflow coordinator around the existing scan and communication subsystems. Keep BOSS acquisition, model analysis, candidate storage, and communication execution intact; link them through a persisted workflow-run record, pure target/budget planning, centralized inventory eligibility, and run-scoped dashboard pages.

**Tech Stack:** Node.js 22 CommonJS, built-in `node:sqlite`, server-rendered HTML, existing smoke-test harness and Edge/BOSS adapters.

## Global Constraints

- Both daily executions call the same workflow. Do not add morning or afternoon modes.
- Runs are user-triggered and stop completely after completion; no scheduler, background waiting, or automatic third run.
- Daily success target is 70, maximum run target is 40, maximum completed/active slots per China-local day is 2.
- Run target is `min(40, ceil(remainingDailyTarget / remainingRunSlots))`.
- Both runs share existing BOSS daily access limits; the first run cannot consume the second run's fair share.
- Applied, invalid, future-later, ambiguous, stale, incomplete, or stale-analysis jobs cannot enter automatic inventory.
- Default review includes primary, talk, and eligible low-risk backups; high-salary backups stay unchecked.
- Existing BOSS single-tab serial behavior and fail-closed risk controls remain intact.
- No anti-detection behavior, new recruitment platform, self-modifying recommendation rule, or new dependency.
- Do not modify `docs/data_baseline.md`, `docs/session_checkpoint.md`, `logs/`, or a user's live database while developing in the worktree.
- Write a failing focused test before each production behavior change; run the full suite once at final verification.

---

### Task 1: Pure Workflow Target and Budget Planner

**Files:**
- Create: `src/core/workflow_run.js`
- Create: `tests/workflow_planner_smoke.js`
- Modify: `src/core/product_policy.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces: `chinaLocalDay(now): string`.
- Produces: `planWorkflowRun(input): { localDay, sequence, targetSuccessCount, remainingDailyTarget, remainingRunSlots, scanNeeded, inventoryCount, budget, selectedKeywords, projectedCandidates, shortfallReason }`.
- Consumes: active plan keywords, completed run summaries, valid inventory count, daily used access counts, and per-keyword yield statistics.

- [ ] **Step 1: Add failing planner tests**

Cover these exact cases in `tests/workflow_planner_smoke.js`:

```js
assert.strictEqual(chinaLocalDay("2026-07-20T16:30:00.000Z"), "2026-07-21");
assert.strictEqual(planWorkflowRun(fixture({ successfulToday: 0, completedRuns: 0 })).targetSuccessCount, 35);
assert.strictEqual(planWorkflowRun(fixture({ successfulToday: 30, completedRuns: 1 })).targetSuccessCount, 40);
assert.strictEqual(planWorkflowRun(fixture({ successfulToday: 38, completedRuns: 1 })).targetSuccessCount, 32);
assert.strictEqual(planWorkflowRun(fixture({ completedRuns: 2 })).errorCode, "WORKFLOW_DAILY_RUN_LIMIT");
assert.strictEqual(planWorkflowRun(fixture({ inventoryCount: 35 })).scanNeeded, false);
```

Also assert that six A/A/A/A/B/B keywords split into no more than three unused keywords for the first run, preserve at least three for the second run, and that a known higher-yield keyword ranks before a lower-yield keyword without changing its A/B priority value.

- [ ] **Step 2: Run RED**

Run: `node tests/workflow_planner_smoke.js`

Expected: FAIL because `src/core/workflow_run.js` does not exist.

- [ ] **Step 3: Implement policy and pure planner**

Add to `PRODUCT_POLICY.operations.workflow`:

```js
Object.freeze({
  dailyTarget: 70,
  maxRunsPerDay: 2,
  maxRunTarget: 40,
  replacementBuffer: 5,
  fallbackYield: 0.2,
  minimumYieldSample: 20
})
```

Implement the planner without database or browser dependencies. Allocate detail and page budget using integer fair share of the remaining existing daily limits. Select unused keywords first; use yield only after the minimum sample, otherwise priority and plan order.

- [ ] **Step 4: Run GREEN**

Run: `node tests/workflow_planner_smoke.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/workflow_run.js src/core/product_policy.js tests/workflow_planner_smoke.js tests/run_all.js
git commit -m "feat: plan two daily workflow runs"
```

---

### Task 2: Persisted Workflow Run Lifecycle

**Files:**
- Modify: `src/core/storage.js`
- Create: `tests/workflow_storage_smoke.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces: `createWorkflowRun(db, input)`.
- Produces: `getWorkflowRun(db, id)`, `listWorkflowRuns(db, filters)`, `getActiveWorkflowRun(db, filters)`.
- Produces: `transitionWorkflowRun(db, input)` and `attachWorkflowScan(db, input)` / `attachWorkflowCommunication(db, input)`.
- Consumes: the pure plan returned by Task 1.

- [ ] **Step 1: Add failing lifecycle and migration tests**

Assert:

```js
const first = createWorkflowRun(db, input({ localDay: "2026-07-20", sequence: 1 }));
assert.strictEqual(first.status, "created");
assert.throws(() => transitionWorkflowRun(db, { id: first.id, status: "communicating" }), /WORKFLOW_TRANSITION_INVALID/);
assert.strictEqual(transitionWorkflowRun(db, { id: first.id, status: "scanning" }).status, "scanning");
assert.throws(() => createWorkflowRun(db, input({ localDay: "2026-07-20", sequence: 1 })), /WORKFLOW_RUN_SLOT_EXISTS/);
```

Migration coverage must open a v2 fixture and verify the new table and indexes exist without changing candidate/job counts.

- [ ] **Step 2: Run RED**

Run: `node tests/workflow_storage_smoke.js`

Expected: FAIL because workflow storage functions are missing.

- [ ] **Step 3: Add schema and lifecycle functions**

Add `workflow_runs` with text UUID primary key, profile/plan/day/sequence, status check, target and progress columns, JSON snapshots, linked IDs, error fields, timestamps, and `UNIQUE(profile_id, local_day, sequence)`. Add migration v3 and indexes for active lookup and daily progress.

Allow only:

```text
created -> scanning | review_required | stopped
scanning -> analyzing | interrupted | failed | stopped
analyzing -> review_required | interrupted | failed | stopped
review_required -> communicating | stopped
communicating -> completed | interrupted | failed | stopped
interrupted -> scanning | review_required | communicating | stopped
```

- [ ] **Step 4: Run GREEN**

Run: `node tests/workflow_storage_smoke.js && node tests/storage_migration_smoke.js`

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/storage.js tests/workflow_storage_smoke.js tests/storage_migration_smoke.js tests/run_all.js
git commit -m "feat: persist workflow run lifecycle"
```

---

### Task 3: Centralized Inventory and Communication Outcome Reconciliation

**Files:**
- Create: `src/core/workflow_inventory.js`
- Create: `tests/workflow_inventory_smoke.js`
- Modify: `src/core/communication_executor.js`
- Modify: `src/core/communication_batches.js`
- Modify: `src/core/storage.js`
- Modify: `tests/communication_executor_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces: `workflowEligibility(job, context): { eligible, tier, reasonCode }`.
- Produces: `listWorkflowInventory(db, { planId, localDay, now })`.
- Produces: `reconcileCommunicationOutcome(db, { batch, item, status, now })`.

- [ ] **Step 1: Add failing inventory tests**

Seed primary, talk, core-salary experience-overlap backup, high-salary backup, applied, invalid, future-later, ambiguous, stale-activity, missing-detail, and stale-analysis fixtures. Assert only the first three are eligible and tiers are `primary`, `talk`, `low_risk_backup`.

Add executor assertions:

```js
assert.strictEqual(stateFor(jobUnavailableId).status, "invalid");
assert.strictEqual(stateFor(targetMismatchId).status, "review");
assert.strictEqual(stateFor(actionUnavailableId).status, "later");
assert(Date.parse(stateFor(actionUnavailableId).review_at) > Date.parse(now));
```

- [ ] **Step 2: Run RED**

Run: `node tests/workflow_inventory_smoke.js`

Expected: FAIL because eligibility and reconciliation are missing.

- [ ] **Step 3: Implement one eligibility predicate and reconciliation path**

Move automatic-selection rules out of dashboard filtering into `workflow_inventory.js`. Reuse `decisionBucket`, activity evidence, analysis revision, and candidate state already returned by `listDecisionPool`; do not duplicate scoring.

Call `reconcileCommunicationOutcome()` from every terminal communication path. Add an idempotent migration helper that converts historical `job_unavailable` items to candidate `invalid` unless the same job already has a stronger applied/interview state.

- [ ] **Step 4: Run GREEN**

Run: `node tests/workflow_inventory_smoke.js && node tests/communication_executor_smoke.js`

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/workflow_inventory.js src/core/communication_executor.js src/core/communication_batches.js src/core/storage.js tests/workflow_inventory_smoke.js tests/communication_executor_smoke.js tests/run_all.js
git commit -m "fix: reconcile workflow candidate inventory"
```

---

### Task 4: Run-Specific Keyword and Scan Budgets

**Files:**
- Modify: `src/core/scan_execution.js`
- Modify: `src/cli.js`
- Modify: `src/dashboard/server.js`
- Create: `tests/workflow_scan_smoke.js`
- Modify: `tests/scan_execution_smoke.js`
- Modify: `tests/scan_cli_lifecycle_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Extends: `buildScanCliArgs({ ..., workflowRunId, keywords, maxCards, maxDetailTotal, browserPageBudget })`.
- Consumes: persisted workflow plan snapshot from Tasks 1-2.
- Produces: scan/analyze phase transitions and linked scan/batch identifiers.

- [ ] **Step 1: Add failing CLI and lifecycle tests**

Assert exact CLI arguments include:

```js
["--workflow-run", runId, "--keywords", "Agent开发工程师,AI知识库开发", "--max-cards", "50", "--max-detail-total", "120", "--browser-page-budget", "20"]
```

Assert a completed fake scan moves its workflow run through `scanning`, `analyzing`, and `review_required`; an interrupted scan preserves the same workflow slot and resume batch.

- [ ] **Step 2: Run RED**

Run: `node tests/workflow_scan_smoke.js`

Expected: FAIL because scan execution has no workflow link.

- [ ] **Step 3: Pass persisted run inputs into the existing scan**

Validate workflow arguments in `scan_execution.js`. In `cli.js`, load the workflow run, reject mismatched plan IDs, use only persisted selected keywords and limits, attach the created scan run/batch, transition to `analyzing` immediately before model analysis, and transition to `review_required` only after analyzed jobs and metrics are saved.

Do not change BOSS adapter pacing, DOM selectors, single-tab behavior, or risk-control handling.

- [ ] **Step 4: Run GREEN**

Run: `node tests/workflow_scan_smoke.js && node tests/scan_execution_smoke.js && node tests/scan_cli_lifecycle_smoke.js`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/scan_execution.js src/cli.js src/dashboard/server.js tests/workflow_scan_smoke.js tests/scan_execution_smoke.js tests/scan_cli_lifecycle_smoke.js tests/run_all.js
git commit -m "feat: run scans with workflow budgets"
```

---

### Task 5: Run-Scoped Review and Success-Targeted Communication

**Files:**
- Modify: `src/core/communication_batches.js`
- Modify: `src/core/communication_executor.js`
- Modify: `src/core/storage.js`
- Create: `tests/workflow_communication_smoke.js`
- Modify: `tests/dashboard_communication_batch_smoke.js`
- Modify: `tests/communication_batch_storage_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Extends: `createCommunicationBatch(db, { workflowRunId, jobIds, ... })`.
- Produces: `listWorkflowReviewCandidates(db, workflowRunId)` ordered by tier and existing report comparator.
- Executor invariant: stop after `targetSuccessCount` successful/already-communicated items; transition later replacements to batch status `stopped` with zero click attempts and no candidate outcome.

- [ ] **Step 1: Add failing selection and stop tests**

For target 3 with five selected candidates and outcomes success/unavailable/success/success, assert four visits, three applied states, one invalid state, and the fifth batch item is `stopped` with zero clicks and no candidate state. Assert that job remains available inventory. Assert high-salary backup is rendered unchecked while low-risk backup is checked.

- [ ] **Step 2: Run RED**

Run: `node tests/workflow_communication_smoke.js`

Expected: FAIL because batches are not workflow-scoped and executor does not stop at success target.

- [ ] **Step 3: Link batch, scope review, and stop on success**

Store the communication batch link on the workflow run in the same transaction as batch creation. Limit default checked candidates to `target + replacementBuffer`. Count `succeeded` and `already_communicated` as success. When target is reached, transition untouched replacement items to batch status `stopped` without writing a candidate outcome; they remain normal inventory after the run completes.

- [ ] **Step 4: Run GREEN**

Run: `node tests/workflow_communication_smoke.js && node tests/communication_batch_storage_smoke.js && node tests/dashboard_communication_batch_smoke.js`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/communication_batches.js src/core/communication_executor.js src/core/storage.js tests/workflow_communication_smoke.js tests/communication_batch_storage_smoke.js tests/dashboard_communication_batch_smoke.js tests/run_all.js
git commit -m "feat: execute workflow communication targets"
```

---

### Task 6: Primary Dashboard Run Experience

**Files:**
- Modify: `src/dashboard/server.js`
- Create: `tests/workflow_dashboard_smoke.js`
- Modify: `tests/dashboard_scan_lifecycle_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces routes: `POST /api/workflow-run`, `GET /workflow`, `POST /api/workflow-run/resume`.
- Consumes: planner, workflow storage, inventory, scan launcher, and communication APIs from Tasks 1-5.

- [ ] **Step 1: Add failing page and route tests**

Assert the primary plan page displays today's success progress, slots used, next target, valid inventory, remaining budgets, and exactly one primary `Start new run` or `Resume run` command. Assert no morning/afternoon text exists. Assert the active workflow page renders phase-specific controls and run-scoped candidates.

- [ ] **Step 2: Run RED**

Run: `node tests/workflow_dashboard_smoke.js`

Expected: FAIL because workflow routes and page are absent.

- [ ] **Step 3: Add the unified interaction flow**

Create a workflow run and start its scan from one POST. Redirect to `/workflow?runId=...`. Poll only the persisted child status while scanning/analyzing. At `review_required`, render the run-scoped checklist and explicit confirmation. At completion, render final metrics and `todaySuccess / 70`. Move legacy scan/refresh controls into an advanced `<details>` section without removing them.

- [ ] **Step 4: Run GREEN**

Run: `node tests/workflow_dashboard_smoke.js && node tests/dashboard_scan_lifecycle_smoke.js`

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.js tests/workflow_dashboard_smoke.js tests/dashboard_scan_lifecycle_smoke.js tests/run_all.js
git commit -m "feat: add run-once dashboard workflow"
```

---

### Task 7: Recovery, Metrics, and Structured Diagnostics

**Files:**
- Modify: `src/core/workflow_run.js`
- Modify: `src/core/storage.js`
- Modify: `src/core/observability.js`
- Modify: `src/dashboard/server.js`
- Create: `tests/workflow_recovery_smoke.js`
- Modify: `tests/observability_context_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces: `recoverWorkflowRuns(db, input)` and daily/keyword metrics snapshots.
- Log context fields: `workflowRunId`, `scanRunId`, `scanBatchId`, `communicationBatchId`.

- [ ] **Step 1: Add failing restart and metrics tests**

Seed orphaned scanning, review-required, interrupted communication, and completed runs. Assert restart interrupts only genuinely orphaned child work, preserves review state, resumes the same sequence, and never creates a third slot. Assert metrics distinguish collected, detail read/reused/pending, analyzed, eligible, selected, succeeded, unavailable, and duration.

- [ ] **Step 2: Run RED**

Run: `node tests/workflow_recovery_smoke.js`

Expected: FAIL because workflow recovery and metrics are absent.

- [ ] **Step 3: Implement deterministic recovery and context propagation**

Reconcile workflow state from linked persisted scan/communication records at dashboard startup and workflow-page load. Store metrics snapshots at phase boundaries. Add all available IDs to child loggers and audit events. Never resume browser access automatically.

- [ ] **Step 4: Run GREEN**

Run: `node tests/workflow_recovery_smoke.js && node tests/observability_context_smoke.js`

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/workflow_run.js src/core/storage.js src/core/observability.js src/dashboard/server.js tests/workflow_recovery_smoke.js tests/observability_context_smoke.js tests/run_all.js
git commit -m "feat: recover and observe workflow runs"
```

---

### Task 8: End-to-End Offline Verification and Real Validation Preparation

**Files:**
- Create: `tests/workflow_end_to_end_smoke.js`
- Modify: `tests/run_all.js`
- Create: `docs/two-run-workflow-validation.md`
- Modify: `README.md`

**Interfaces:**
- Verifies the public dashboard/API flow with fake browser and fake model dependencies.
- Produces a manual low-volume validation checklist; it does not access BOSS during automated tests.

- [ ] **Step 1: Add an end-to-end fake workflow test**

Exercise two same-day runs through start, fake scan, fake analysis, review, communication, and completion. Assert targets 35 then 40 when first success is 30, cross-run dedupe, invalid-job exclusion, keyword non-reuse, daily progress, and third-run rejection.

- [ ] **Step 2: Run the new end-to-end test**

Run: `node tests/workflow_end_to_end_smoke.js`

Expected: PASS after Tasks 1-7; any failure is fixed before proceeding.

- [ ] **Step 3: Document operation and low-volume real validation**

Document one-run startup, review, resume, shutdown, diagnostics, and the exact live checklist:

```text
1 keyword only
maximum 10 cards
maximum 3 right-pane details
zero automatic communication clicks for acquisition validation
one separately confirmed communication item only after acquisition evidence is reviewed
stop immediately on login, risk-control, page-drift, or identity mismatch evidence
```

- [ ] **Step 4: Run focused integration checks, then one full suite**

Run:

```bash
node tests/workflow_end_to_end_smoke.js
npm test
```

Expected: all existing 33 checks plus all new workflow checks pass. Do not rerun the full suite after documentation-only edits.

- [ ] **Step 5: Inspect final diff and commit**

```bash
git diff --check
git status --short
git add tests/workflow_end_to_end_smoke.js tests/run_all.js docs/two-run-workflow-validation.md README.md
git commit -m "test: verify two-run workflow end to end"
```

- [ ] **Step 6: Final review evidence**

Review the complete branch diff against `docs/superpowers/specs/2026-07-20-two-run-workflow-design.md`, confirm every acceptance criterion has direct test or current-state evidence, and record any real-page-only criterion as pending live validation rather than claiming it passed.
