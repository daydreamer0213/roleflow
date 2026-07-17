# BOSS Batch Communication V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-confirmed, resumable, serial BOSS batch communication to RoleFlow without rewriting the existing scan, resume-analysis, or matching pipelines.

**Architecture:** Extend the existing SQLite, Edge/CDP, BOSS adapter, access ledger, site lease, CLI-child, and server-rendered Dashboard patterns. A communication batch is an immutable snapshot of selected jobs; a dedicated executor navigates one communication tab, verifies each job, dispatches at most one browser-level click, validates the resulting UI state, and checkpoints every transition.

**Tech Stack:** Node.js 22.5+, CommonJS, `node:sqlite`, built-in HTTP server, existing Edge Control/CDP adapters, existing structured logger. No new runtime dependency and no frontend framework.

## Global Constraints

- Preserve `docs/data_baseline.md`, `docs/session_checkpoint.md`, and `logs/`; they are user-owned untracked files.
- Keep resume parsing, search planning, scanning, semantic matching, recommendation ranking, and model prompts behaviorally unchanged.
- V1 uses the BOSS generic greeting and makes no LLM call.
- Default candidates are primary and talk jobs; backup jobs are opt-in; not-recommended jobs are rejected server-side.
- The browser uses one fixed search tab and one fixed communication tab in the same real Edge profile; tasks remain strictly serial.
- Delay 15-20 seconds between communication jobs; allow at most 30 attempts per rolling 10 minutes, 60 per rolling 30 minutes, and 150 per rolling 24 hours.
- Recent scan `detail_open` events count toward the 10-minute and 30-minute communication density, but not the 24-hour communication quota.
- Never retry a click automatically. Risk page, login loss, browser loss, target ambiguity, or post-click ambiguity stops the batch.
- Do not add mouse-path simulation, fingerprint spoofing, proxy/account rotation, CAPTCHA handling, or any mechanism intended to bypass platform controls.
- No live BOSS write test before the recorded restriction expires, and no live click without the user's explicit per-test approval.

---

### Task 1: Communication Batch Persistence And Idempotency

**Files:**
- Modify: `src/core/storage.js`
- Create: `src/core/communication_batches.js`
- Modify: `tests/storage_migration_smoke.js`
- Create: `tests/communication_batch_storage_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces: `createCommunicationBatch(db, input) -> CommunicationBatch`
- Produces: `getCommunicationBatch(db, batchId) -> CommunicationBatch | null`
- Produces: `listCommunicationBatchItems(db, batchId) -> CommunicationItem[]`
- Produces: `setCommunicationBatchStatus(db, input) -> CommunicationBatch`
- Produces: `transitionCommunicationItem(db, input) -> CommunicationItem`
- Produces: `resolveAmbiguousCommunicationItem(db, input) -> CommunicationItem`
- Produces: `communicationBatchSummary(db, batchId) -> object`

- [ ] **Step 1: Add a failing migration assertion**

Append assertions to `tests/storage_migration_smoke.js` that both fresh and upgraded databases contain the two tables and that the schema version advances:

```js
assert.strictEqual(
  db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='communication_batches'").get().n,
  1
);
assert.strictEqual(
  db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='communication_batch_items'").get().n,
  1
);
assert(SCHEMA_VERSION >= 2);
```

Update the fresh-database migration history assertion to expect both rows in order: version `1` named `stable_scan_runtime`, followed by version `2` named `communication_batches_v1`. The first row keeps `backup_path: null`; the second row also has `backup_path: null` for a new database.

- [ ] **Step 2: Run the migration test and verify the expected failure**

Run: `node tests/storage_migration_smoke.js`

Expected: FAIL because `communication_batches` does not exist or `SCHEMA_VERSION` is still `1`.

- [ ] **Step 3: Add schema migration v2**

Add the following schema to `SCHEMA` and a `communication_batches_v1` migration to `MIGRATIONS`:

```sql
CREATE TABLE IF NOT EXISTS communication_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL DEFAULT 'boss',
  profile_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  browser_mode TEXT NOT NULL CHECK(browser_mode IN ('edge', 'portable')),
  status TEXT NOT NULL CHECK(status IN ('confirmed','running','paused','stopping','completed','stopped','interrupted','failed')),
  policy_json TEXT NOT NULL DEFAULT '{}',
  confirmed_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  stop_code TEXT,
  stop_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(plan_id) REFERENCES search_plans(id)
);

CREATE TABLE IF NOT EXISTS communication_batch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  job_url TEXT NOT NULL,
  title_snapshot TEXT NOT NULL,
  company_snapshot TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('pending','opening','verified','click_dispatched','succeeded','already_communicated','job_unavailable','target_mismatch','action_unavailable','ambiguous','stopped')),
  click_count INTEGER NOT NULL DEFAULT 0 CHECK(click_count BETWEEN 0 AND 1),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  clicked_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id, job_id),
  FOREIGN KEY(batch_id) REFERENCES communication_batches(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_communication_batches_plan ON communication_batches(plan_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_communication_items_batch ON communication_batch_items(batch_id, position);
CREATE INDEX IF NOT EXISTS idx_communication_items_job ON communication_batch_items(job_id, status);
```

Use migration version `2`; its `apply(db)` must run only the communication schema, while migration version `1` continues to build the full base schema for new databases.

- [ ] **Step 4: Write the failing batch lifecycle test**

Create `tests/communication_batch_storage_smoke.js` with an in-memory profile, plan, scan batch, and four jobs. Assert these cases:

```js
const selected = createCommunicationBatch(db, {
  planId,
  jobIds: [primaryId, talkId, backupId],
  browserMode: "edge",
  policySnapshot: { delayMs: [15000, 20000] }
});
assert.strictEqual(selected.status, "confirmed");
assert.deepStrictEqual(
  listCommunicationBatchItems(db, selected.id).map((item) => item.status),
  ["pending", "pending", "pending"]
);
assert.throws(
  () => createCommunicationBatch(db, { planId, jobIds: [notRecommendedId], browserMode: "edge" }),
  (error) => error.code === "COMMUNICATION_JOB_INELIGIBLE"
);
```

Also assert that an already-applied job is excluded, `verified -> click_dispatched` increments `clickCount` exactly once, a second dispatch fails with `COMMUNICATION_CLICK_ALREADY_DISPATCHED`, and an ambiguous item can only be resolved to `succeeded` or `stopped`.

- [ ] **Step 5: Implement the minimal persistence module**

In `src/core/communication_batches.js`, define and export these exact constants and functions:

```js
const BATCH_STATUSES = new Set(["confirmed", "running", "paused", "stopping", "completed", "stopped", "interrupted", "failed"]);
const ITEM_STATUSES = new Set(["pending", "opening", "verified", "click_dispatched", "succeeded", "already_communicated", "job_unavailable", "target_mismatch", "action_unavailable", "ambiguous", "stopped"]);
const TERMINAL_ITEM_STATUSES = new Set(["succeeded", "already_communicated", "job_unavailable", "target_mismatch", "action_unavailable", "ambiguous", "stopped"]);
const ALLOWED_BUCKETS = new Set(["primary", "talk", "backup"]);

module.exports = {
  BATCH_STATUSES,
  ITEM_STATUSES,
  TERMINAL_ITEM_STATUSES,
  createCommunicationBatch,
  getCommunicationBatch,
  listCommunicationBatchItems,
  setCommunicationBatchStatus,
  transitionCommunicationItem,
  resolveAmbiguousCommunicationItem,
  communicationBatchSummary
};
```

Use `listDecisionPool(db, { planId })` to validate selected jobs. Reject missing jobs, non-BOSS URLs, `not_recommended`, `refresh`, and `analysis_pending`. Reject jobs with contacted states `applied`, `no_reply`, `interview`, or `rejected`, and jobs with `click_dispatched` or `ambiguous` items in another batch. Wrap batch and item insertion in `BEGIN IMMEDIATE` / `COMMIT` with rollback on error.

`transitionCommunicationItem` must use an optimistic `WHERE id=? AND status=?` update. Only the `verified -> click_dispatched` transition may set `click_count=1` and `clicked_at`; if zero rows change, throw a coded transition error.

- [ ] **Step 6: Run focused tests and register the new check**

Add `communication_batch_storage_smoke.js` immediately after `storage_migration_smoke.js` in `tests/run_all.js`.

Run:

```powershell
node tests/storage_migration_smoke.js
node tests/communication_batch_storage_smoke.js
```

Expected: both print their `ok` line and exit `0`.

- [ ] **Step 7: Commit Task 1**

```powershell
git add src/core/storage.js src/core/communication_batches.js tests/storage_migration_smoke.js tests/communication_batch_storage_smoke.js tests/run_all.js
git commit -m "feat: persist communication batches"
```

---

### Task 2: Combined Communication Access Budget

**Files:**
- Modify: `src/core/product_policy.js`
- Modify: `src/core/site_access_budget.js`
- Modify: `tests/site_access_budget_smoke.js`

**Interfaces:**
- Consumes: existing `recordSiteAccessEvent` and `listSiteAccessEvents`
- Produces: `createSiteAccessController(...).reserve("communication_visit", details)`
- Produces: `PRODUCT_POLICY.operations.bossCommunication`

- [ ] **Step 1: Write failing rolling-window tests**

Add three tests to `tests/site_access_budget_smoke.js`. The 10-minute test first proves that 8 scan details plus 21 communication visits consume 29 shared slots, then proves the next reservation waits:

```js
for (let index = 0; index < 8; index += 1) {
  recordSiteAccessEvent(db, { site: "boss", action: "detail_open", createdAt: new Date(now - 60_000 + index).toISOString() });
}
for (let index = 0; index < 21; index += 1) {
  recordSiteAccessEvent(db, { site: "boss", action: "communication_visit", createdAt: new Date(now - 30_000 + index).toISOString() });
}
const first = await controller.reserve("communication_visit", { batchId: 1, jobId: 9 });
assert.strictEqual(first.usage["10m"], 30);
assert.strictEqual(sleeps.length, 0);
await controller.reserve("communication_visit", { batchId: 1, jobId: 10 });
assert.strictEqual(sleeps.length, 1);
```

Seed 60 mixed `detail_open` and `communication_visit` events in 30 minutes and assert one wait. Seed 150 `communication_visit` plus 500 `detail_open` events in 24 hours and assert the daily error is triggered by 150 communication attempts, not by detail events alone.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node tests/site_access_budget_smoke.js`

Expected: FAIL because `30m` and combined-action accounting do not exist.

- [ ] **Step 3: Add the central policy values**

Increment `PRODUCT_POLICY_VERSION` and add:

```js
bossCommunication: Object.freeze({
  delayMs: Object.freeze([15000, 20000]),
  limits: Object.freeze({ "10m": 30, "30m": 60, "24h": 150 }),
  combinedUsage: Object.freeze({
    "10m": Object.freeze(["detail_open", "communication_visit"]),
    "30m": Object.freeze(["detail_open", "communication_visit"]),
    "24h": Object.freeze(["communication_visit"])
  })
})
```

Add `"30m": 30 * 60_000` to `bossAccessBudget.windowsMs`. Add identical `communication_visit` limits to both normal and recovery modes; a still-active block is handled by site runtime state, not by silently shrinking the user-confirmed communication quota.

- [ ] **Step 4: Extend usage calculation without duplicating the controller**

Change `readUsage` and `nextAvailableAt` to obtain the action set for each window:

```js
function actionsForWindow(action, window) {
  if (action !== "communication_visit") return [action];
  return PRODUCT_POLICY.operations.bossCommunication.combinedUsage[window]
    || [action];
}
```

Read site events once from the longest relevant window and count only actions in the returned set. For `24h`, this must exclude `detail_open`. Extend `accessBudgetError` labels with `communication_visit: "岗位沟通"`.

- [ ] **Step 5: Run focused and existing access tests**

Run:

```powershell
node tests/site_access_budget_smoke.js
node tests/scan_cli_lifecycle_smoke.js
```

Expected: both pass; existing scan budgets remain unchanged.

- [ ] **Step 6: Commit Task 2**

```powershell
git add src/core/product_policy.js src/core/site_access_budget.js tests/site_access_budget_smoke.js
git commit -m "feat: budget BOSS communication visits"
```

---

### Task 3: Minimal Browser Tab And Trusted Click Primitives

**Files:**
- Modify: `src/adapters/browser/cdp.js`
- Modify: `src/adapters/browser/edge_control.js`
- Modify: `tests/browser_transport_smoke.js`

**Interfaces:**
- Produces: `browser.createTab(openerTabId, url) -> tabId`
- Produces: `browser.bringToFront(tabId) -> Promise`
- Produces: `browser.clickAt(tabId, { x, y }) -> Promise`

- [ ] **Step 1: Write failing transport assertions**

Extend `tests/browser_transport_smoke.js` to assert these exact CDP methods and ordering:

```js
await cdp.clickAt("cdp-tab", { x: 120, y: 48 });
assert.deepStrictEqual(
  websocket.messages.slice(-3).map((message) => message.method),
  ["Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]
);
assert.deepStrictEqual(
  websocket.messages.slice(-3).map((message) => message.params.type),
  ["mouseMoved", "mousePressed", "mouseReleased"]
);
```

Assert `Target.createTarget` is called once and its `targetId` is returned. Repeat the assertions against `EdgeControlAdapter` by checking `send_cdp` commands. Assert failed click dispatch is never retried.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node tests/browser_transport_smoke.js`

Expected: FAIL because `clickAt` and `createTab` are undefined.

- [ ] **Step 3: Implement identical primitives in both adapters**

Add these methods to `CdpBrowserAdapter` and `EdgeControlAdapter`:

```js
async createTab(openerTabId, url = "about:blank") {
  const result = await this.cdp(openerTabId, "Target.createTarget", { url: String(url || "about:blank") });
  if (!result?.targetId) throw browserError("BROWSER_COMMAND_FAILED", "Browser did not return a new tab id.");
  return result.targetId;
}

async bringToFront(tabId) {
  return this.cdp(tabId, "Page.bringToFront");
}

async clickAt(tabId, { x, y }) {
  const point = { x: Number(x), y: Number(y) };
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw browserError("BROWSER_COMMAND_FAILED", "Click coordinates must be finite numbers.");
  }
  await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  return this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
}
```

Do not add curved paths, randomized pointer movement, retry loops, or a general browser automation framework.

- [ ] **Step 4: Run browser transport tests**

Run: `node tests/browser_transport_smoke.js`

Expected: `browser_transport_smoke ok`.

- [ ] **Step 5: Commit Task 3**

```powershell
git add src/adapters/browser/cdp.js src/adapters/browser/edge_control.js tests/browser_transport_smoke.js
git commit -m "feat: add browser click primitives"
```

---

### Task 4: BOSS Communication Page Adapter

**Files:**
- Modify: `src/adapters/sites/boss.js`
- Create: `tests/boss_communication_action_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: `browser.createTab`, `browser.bringToFront`, `browser.clickAt`
- Produces: `BossSiteAdapter.prepareCommunicationTab(searchTabId) -> tabId`
- Produces: `BossSiteAdapter.inspectCommunicationJob(tabId, job, signal) -> CommunicationInspection`
- Produces: `BossSiteAdapter.dispatchCommunication(tabId, inspection, signal) -> void`
- Produces: `BossSiteAdapter.verifyCommunicationResult(tabId, job, signal) -> CommunicationVerification`

- [ ] **Step 1: Build a fake-browser test for all visible states**

Create `tests/boss_communication_action_smoke.js`. The fake browser must return controlled results for tab listing, navigation, DOM inspection, clicking, and post-click verification. Assert:

```js
assert.deepStrictEqual(await adapter.inspectCommunicationJob("action-tab", job), {
  state: "ready",
  jobId: "abc123",
  title: "AI 应用开发工程师",
  company: "示例公司",
  actionLabel: "立即沟通",
  clickPoint: { x: 500, y: 120 }
});
```

Add cases for `already_communicated`, `job_unavailable`, `target_mismatch`, and `action_unavailable`. Assert two exact matching visible buttons return `action_unavailable`, not the first element. Assert risk and login states throw `BOSS_RISK_CONTROL` and `BOSS_LOGIN_REQUIRED`.

- [ ] **Step 2: Run the new test and verify failure**

Run: `node tests/boss_communication_action_smoke.js`

Expected: FAIL because the communication adapter methods are undefined.

- [ ] **Step 3: Add communication DOM state extraction**

Extend `PAGE_HELPERS` with `window.__bossCommunicationState`. It must:

```js
const labels = new Set(["立即沟通", "继续沟通", "已沟通"]);
const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"))
  .map((element) => ({ element, label: window.__bossDecode(element.innerText || element.textContent || "").replace(/\s+/g, "").trim() }))
  .filter(({ element, label }) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return labels.has(label)
      && rect.width > 0
      && rect.height > 0
      && style.display !== "none"
      && style.visibility !== "hidden"
      && !element.disabled
      && element.getAttribute("aria-disabled") !== "true";
  });
```

Limit candidates to the detail header or detail root. Return the current job ID, title, company, unavailable text signal, exact candidate count, label, and viewport-center coordinates. Do not click from this helper.

- [ ] **Step 4: Implement tab preparation and the three adapter phases**

`prepareCommunicationTab` must reuse a non-search BOSS detail/chat tab when one exists; otherwise create one from the verified search tab. Bring the communication tab to front but never close the search tab.

`inspectCommunicationJob` must navigate to the normalized stored job URL, call existing risk/login/detail assertions, compare job ID plus normalized title/company, and return one of the specified states. `dispatchCommunication` must call `browser.clickAt` exactly once. `verifyCommunicationResult` may poll DOM state up to four times without reloading; return `succeeded` only when the action changes to a verified already-communicated state or a BOSS chat surface for the expected job appears. Otherwise return `ambiguous`.

- [ ] **Step 5: Run BOSS adapter regressions**

Add `boss_communication_action_smoke.js` after `source_acquisition_smoke.js` in `tests/run_all.js`.

Run:

```powershell
node tests/boss_communication_action_smoke.js
node tests/source_acquisition_smoke.js
```

Expected: both pass and the existing read-only selectors remain unchanged.

- [ ] **Step 6: Commit Task 4**

```powershell
git add src/adapters/sites/boss.js tests/boss_communication_action_smoke.js tests/run_all.js
git commit -m "feat: inspect and verify BOSS communication"
```

---

### Task 5: Resumable Communication Executor And CLI

**Files:**
- Create: `src/core/communication_executor.js`
- Modify: `src/cli.js`
- Create: `tests/communication_executor_smoke.js`
- Create: `tests/communication_cli_lifecycle_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: Task 1 persistence, Task 2 access controller, Task 4 BOSS adapter
- Produces: `runCommunicationBatch(context) -> CommunicationBatchSummary`
- Produces CLI example: `communicate --batch 1 --browser edge`
- Produces CLI example: `inspect-communication --job-id 1 --plan 1 --browser edge`

- [ ] **Step 1: Write a failing executor state-machine test**

Create `tests/communication_executor_smoke.js` with an in-memory batch and a fake adapter. Assert the call order and outcomes:

```js
assert.deepStrictEqual(calls, [
  "reserve:communication_visit:job-1",
  "inspect:job-1",
  "dispatch:job-1",
  "verify:job-1",
  "sleep:15000"
]);
assert.strictEqual(items[0].status, "succeeded");
assert.strictEqual(items[0].clickCount, 1);
assert.strictEqual(markedJobs[0].status, "applied");
```

Add cases proving `already_communicated` marks applied without dispatch, `job_unavailable` continues, `ambiguous` stops the batch, a thrown `BOSS_RISK_CONTROL` interrupts the batch, and a resumed batch processes only `pending` items.

- [ ] **Step 2: Run the executor test and verify failure**

Run: `node tests/communication_executor_smoke.js`

Expected: FAIL because `communication_executor.js` does not exist.

- [ ] **Step 3: Implement the executor loop**

Create `runCommunicationBatch` with this exact dependency shape:

```js
async function runCommunicationBatch({
  db,
  batchId,
  adapter,
  accessController,
  logger,
  sleepFn = sleep,
  randomFn = Math.random,
  signal = null
})
```

Before each item, reload the batch. Exit cleanly on `paused`; convert remaining pending items to `stopped` on `stopping`. Reserve `communication_visit` before `opening`. Persist every state before the next browser action. Call `markCandidateJob` with `status: "applied"` and note `RoleFlow 批量沟通 #${batchId}` only for `succeeded` and `already_communicated`.

After each non-fatal terminal item, wait a random integer from `PRODUCT_POLICY.operations.bossCommunication.delayMs`. Implement the wait as one-second abortable slices so pause and stop become visible without waiting the full 20 seconds. Do not sleep after the final item.

Record `communication_click` immediately before the single dispatch attempt and `communication_result` after verification by calling `recordSiteAccessEvent`; these are audit events and do not consume another communication quota slot. Include batch ID, item ID, job ID, and final state, but no resume content or browser credentials.

Treat `BOSS_RISK_CONTROL`, `BOSS_LOGIN_REQUIRED`, `BROWSER_TIMEOUT`, `BROWSER_DISCONNECTED`, `BOSS_DETAIL_PAGE_LOST`, `BOSS_COMMUNICATION_STRUCTURE_CHANGED`, and `ambiguous` as batch-stopping outcomes. A single `target_mismatch` item is recorded and skipped. Never call dispatch twice for one item.

- [ ] **Step 4: Write a failing CLI lifecycle test**

Create `tests/communication_cli_lifecycle_smoke.js` that spawns the CLI against a temporary SQLite database with fake browser injection following the existing CLI lifecycle test pattern. Assert the site lease command is `communicate`, the lease is released on success and failure, and batch status persists after process exit.

- [ ] **Step 5: Add the two CLI commands**

In `src/cli.js`, route:

```js
if (command === "communicate") return communicate(db, args);
if (command === "inspect-communication") return inspectCommunication(db, args);
```

`communicate` must validate the batch and browser mode, acquire the existing site lease with `command: "communicate"`, heartbeat it, build the existing browser and BOSS adapter, create the shared access controller, prepare the communication tab, execute the batch, and release the lease in `finally`.

Before acquiring the lease, read `site_runtime_states`. If the BOSS state is blocked and `details.blockedUntil` is still in the future, throw `BOSS_RISK_CONTROL_ACTIVE` with the exact recovery time and do not open a page.

`inspect-communication` is read-only: it loads one selected job, prepares the communication tab, runs only `inspectCommunicationJob`, prints JSON evidence, and never calls dispatch.

- [ ] **Step 6: Run focused executor and CLI tests**

Register both files in `tests/run_all.js`, then run:

```powershell
node tests/communication_executor_smoke.js
node tests/communication_cli_lifecycle_smoke.js
node tests/scan_cli_lifecycle_smoke.js
```

Expected: all pass; scan lease behavior has no regression.

- [ ] **Step 7: Commit Task 5**

```powershell
git add src/core/communication_executor.js src/cli.js tests/communication_executor_smoke.js tests/communication_cli_lifecycle_smoke.js tests/run_all.js
git commit -m "feat: execute resumable BOSS communication"
```

---

### Task 6: Dashboard Batch Builder, Progress, And Controls

**Files:**
- Modify: `src/dashboard/server.js`
- Create: `tests/dashboard_communication_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: Task 1 batch APIs and Task 5 CLI command
- Produces page example: `GET /communication/new?planId=1`
- Produces page example: `GET /communication?batchId=1`
- Produces API: `POST /api/communication-batch`
- Produces API example: `GET /api/communication-status?batchId=1`
- Produces API: `POST /api/communication-control`
- Produces API: `POST /api/communication-resolve`

- [ ] **Step 1: Write a failing Dashboard flow test**

Create `tests/dashboard_communication_smoke.js` using `createDashboardServer` and a fake `spawnProcess`. Assert:

```js
assert(builderHtml.includes('name="jobIds"'));
assert(builderHtml.includes('value="' + primaryId + '" checked'));
assert(builderHtml.includes('value="' + talkId + '" checked'));
assert(builderHtml.includes('value="' + backupId + '"'));
assert(!builderHtml.includes('value="' + backupId + '" checked'));
assert(!builderHtml.includes('value="' + notRecommendedId + '"'));
```

Post selected IDs and assert one child process starts with `communicate --batch`. Assert a second start is rejected while the site lease or local communication child is active. Assert status JSON contains totals, current item, remaining quota, and next action time. Assert pause, resume, stop, and ambiguous resolution update storage correctly.

Seed a future `blockedUntil` site state and assert the page renders the recovery time with a disabled start button, while a forged POST is rejected server-side without spawning a process.

- [ ] **Step 2: Run the Dashboard test and verify failure**

Run: `node tests/dashboard_communication_smoke.js`

Expected: FAIL with `404` or missing communication markup.

- [ ] **Step 3: Add the batch builder page**

Render all eligible primary and talk jobs checked by default and backup jobs unchecked. Use native checkboxes and a sticky summary bar. The form posts only checked `jobIds`, `planId`, `browserMode`, and `cdpPort`.

The server must re-read the jobs and call `createCommunicationBatch`; it must not trust client-provided title, company, bucket, or URL. Reject an empty selection and selections exceeding the remaining 24-hour communication quota.

Read the current site runtime state and communication quota before rendering and again before starting. An active block disables the action with its recovery time; it is not a client-only guard.

- [ ] **Step 4: Add child lifecycle and control endpoints**

Maintain a `communicationRuns` map keyed by batch ID, parallel to but separate from `scanRuns`. Spawn:

```js
spawnProcess(process.execPath, [
  "--disable-warning=ExperimentalWarning",
  "src/cli.js",
  "communicate",
  "--db", dbPath,
  "--batch", String(batchId),
  "--browser", browserMode === "edge" ? "edge" : "portable",
  "--cdp-port", String(cdpPort)
], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
```

Pause and stop write the requested batch status; the executor observes it through one-second wait slices. Resume starts a new child only after the old child exits and the site lease is free. `communication-resolve` accepts only `succeeded` or `stopped` for an ambiguous item and never triggers a click.

- [ ] **Step 5: Render progress and ambiguity controls**

The progress page must display batch state, selected count, succeeded, already communicated, skipped categories, ambiguous count, remaining count, quota usage, current job, and countdown. Poll `/api/communication-status` every two seconds while running. Show Pause, Continue, and Safe Stop according to current state.

For an ambiguous item, render only “确认已沟通” and “标记跳过”; do not render “重试点击”.

- [ ] **Step 6: Run Dashboard regressions**

Register the test in `tests/run_all.js`, then run:

```powershell
node tests/dashboard_communication_smoke.js
node tests/dashboard_scan_lifecycle_smoke.js
node tests/flow_smoke.js
```

Expected: all pass and existing queue navigation remains available.

- [ ] **Step 7: Commit Task 6**

```powershell
git add src/dashboard/server.js tests/dashboard_communication_smoke.js tests/run_all.js
git commit -m "feat: add batch communication dashboard"
```

---

### Task 7: Documentation, Product Boundaries, And Full Offline Verification

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/operations.md`
- Modify: `docs/release_boundary.md`
- Modify: `docs/product_spec.md`
- Modify: `docs/completion_audit.md`

**Interfaces:**
- Documents the user-visible workflow and the exact write-action boundary.
- Replaces the obsolete one-tab/read-only statements with two role-specific tabs and explicit user-confirmed communication.

- [ ] **Step 1: Update user and operator documentation**

Document this exact lifecycle:

```text
主投 + 可沟通 -> 批量沟通预览（默认全选，可取消，备选手动加入）
-> 用户一次确认 -> 固定沟通标签页串行打开详情
-> 核验岗位 -> 点击一次立即沟通 -> 验证结果 -> 保存进度
```

State clearly that BOSS automation may violate platform terms and can trigger account restrictions; the software provides no evasion guarantee. Explain the 15-20 second delay, 30/10m, 60/30m, 150/24h windows, pause/resume, and no automatic click retry.

Update `AGENTS.md` to require two fixed role tabs with only one BOSS task active at a time. Keep the existing evidence-before-conclusions and smallest-live-probe requirements.

- [ ] **Step 2: Run the complete offline suite**

Run:

```powershell
npm.cmd test
```

Expected: every test listed by `tests/run_all.js` passes, followed by `All 32 offline checks passed.`.

- [ ] **Step 3: Run database and repository checks**

Run:

```powershell
node --check src/core/communication_batches.js
node --check src/core/communication_executor.js
node --check src/adapters/sites/boss.js
node --check src/dashboard/server.js
git diff --check
git status --short
```

Expected: all syntax checks exit `0`, `git diff --check` prints nothing, and status contains only Task 7 documentation plus the pre-existing user-owned untracked files.

- [ ] **Step 4: Commit Task 7**

```powershell
git add README.md AGENTS.md docs/operations.md docs/release_boundary.md docs/product_spec.md docs/completion_audit.md
git commit -m "docs: document confirmed BOSS communication"
```

---

### Task 8: Gated Real BOSS Calibration

**Files:**
- Inspect and modify only after reproduced evidence: `src/adapters/sites/boss.js`
- Extend only with an observed fixture: `tests/boss_communication_action_smoke.js`
- Create: `docs/communication_live_acceptance.md`

**Interfaces:**
- Consumes the completed offline feature.
- Produces evidence for one read-only inspection, one explicitly approved click, and one explicitly approved three-job batch.

- [ ] **Step 1: Verify the account is eligible for a live probe**

Confirm the current time is after the recorded `blockedUntil`, the BOSS page shows no access restriction, and the user is logged in. Do not clear or falsify site risk records. If any restriction remains, stop this task.

- [ ] **Step 2: Run one read-only communication inspection**

Choose one job from the user-visible batch builder and run the implemented `inspect-communication` CLI with its numeric job and plan IDs. Confirm the printed job ID, title, company, action label, and candidate count match the visible page. Do not click.

- [ ] **Step 3: Create a saved fixture from observed state**

Add only the minimal observed labels/selectors to `tests/boss_communication_action_smoke.js`. If existing selectors already match, make no production edit. Run:

```powershell
node tests/boss_communication_action_smoke.js
```

Expected: PASS with the observed real structure represented by the fixture.

- [ ] **Step 4: Request explicit approval for one real communication**

Show the user the exact company, title, and URL. Proceed only after the user explicitly approves that one job. Create a one-item batch through the Dashboard and start it once.

- [ ] **Step 5: Verify the one-item outcome**

Check the visible BOSS result and the SQLite batch item. Success requires expected job identity plus a verified chat/continued-communication UI state. A transport-level click result alone is insufficient. Confirm `click_count=1` and candidate status `applied` only after UI evidence.

- [ ] **Step 6: Request approval and run a three-job batch**

After the one-item calibration passes, show the three exact jobs and request approval. Verify serial ordering, 15-20 second delays, no duplicate click, accurate progress, and correct final summary.

- [ ] **Step 7: Record acceptance evidence and commit only evidence-backed selector changes**

Write `docs/communication_live_acceptance.md` with timestamps, batch IDs, counts, observed UI states, errors, and whether production selectors changed. Run `npm.cmd test` again. If code or fixtures changed, commit:

```powershell
git add src/adapters/sites/boss.js tests/boss_communication_action_smoke.js docs/communication_live_acceptance.md
git commit -m "test: calibrate BOSS communication flow"
```

If no code changed, commit only the acceptance document with the same message.
