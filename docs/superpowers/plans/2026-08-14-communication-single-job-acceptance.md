# Communication Single-Job Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse the current communication batch safely by authorizing exactly one immutable pending job per `e2e_pending` acceptance run, pausing after that item, and activating and confirming the fixed BOSS search tab before the single browser click.

**Architecture:** Keep the existing database schema, batch, item state machine, CLI process boundary, and fixed-tab browser adapter. Add a fail-closed `start_one` / `resume_one` command carrying the exact next pending item ID through dashboard → application service → hidden CLI → executor; checkpoint the batch and workflow after that item. Reuse the browser adapter's existing `bringToFront()` and tab inventory instead of adding another browser mechanism.

**Tech Stack:** Node.js 22.23.1, CommonJS, built-in `node:assert`, SQLite through the existing storage layer, existing dashboard HTTP server, fake-browser smoke tests, PowerShell/Inno Setup release tooling.

## Global Constraints

- Do not access or manipulate real Edge/BOSS during implementation, tests, build, or verification.
- Keep BOSS read-only unless the user explicitly authorizes the exact immutable communication item in the installed UI.
- Keep `trusted_pane` unchanged; do not enable `search_page_api` or `standalone_detail`.
- Preserve the current profile, resume, model settings, plan, 61 jobs, workflow, 12-item batch, and pending item snapshots.
- Never replay the current first `ambiguous` item; its resolution remains a user-triggered local action with evidence.
- While calibration acceptance is exactly `e2e_pending`, reject ordinary full-batch `start` and `resume`.
- A single-item run may dispatch at most one click and must leave all later items pending.
- Ambiguous outcomes stop immediately and never retry.
- Do not reduce JD coverage, recall, matching quality, or safety validation.
- Add no dependency, database migration, new browser window, new BOSS session, or per-job tab.
- Build generated dependencies, stage data, and installers on `D:`.
- Produce `0.1.0-beta.4.3` locally; do not tag, push, or publish without later authorization.

---

### Task 1: Bind the pending-calibration UI and application service to one exact item

**Files:**

- Modify: `tests/communication_application_smoke.js`
- Modify: `tests/dashboard_communication_batch_smoke.js`
- Modify: `src/application/communication/index.js`
- Modify: `src/dashboard/view_models/communication.js`
- Modify: `src/dashboard/pages/communication.js`
- Modify: `src/dashboard/server.js`

**Interfaces:**

- Consumes: `communicationCalibrationStatus()`, `listCommunicationBatchItems(db, batchId)`, and the existing `spawnCommunication({ batch })` dependency.
- Produces: actions `start_one` and `resume_one`; `controls.singleItemId`, `controls.singleItemTitle`, and `controls.singleItemCompany`; `spawnCommunication({ batch, singleItemId })`; CLI argument `--single-item <positive item ID>`.

- [ ] **Step 1: Write failing application and dashboard tests**

Add application assertions that name the two breaks:

```js
await expectApiError(
  baseUrl,
  "/api/communication-control",
  { batchId, action: "start" },
  "COMMUNICATION_E2E_SINGLE_ITEM_REQUIRED",
  409
);

const first = listCommunicationBatchItems(db, batchId)[0];
const started = await postJson(baseUrl, "/api/communication-control", {
  batchId,
  action: "start_one",
  itemId: first.id
});
assert.strictEqual(started.status, 200);
assert.deepStrictEqual(
  spawns.at(-1).args.slice(spawns.at(-1).args.indexOf("--single-item")),
  ["--single-item", String(first.id)]
);

await expectApiError(
  baseUrl,
  "/api/communication-control",
  { batchId: resumableBatchId, action: "resume_one", itemId: secondItem.id },
  "COMMUNICATION_SINGLE_ITEM_MISMATCH",
  409
);
```

Update the communication-page assertion so the visible form identifies the exact next item:

```js
assert.match(review.body, /name="action" value="start_one"/);
assert.match(review.body, new RegExp(`name="itemId" value="${first.id}"`));
assert.match(review.body, /下一次仅验收 1 个岗位/);
assert.match(review.body, /验收这个岗位并自动暂停/);
assert.doesNotMatch(review.body, /name="action" value="start"/);
```

For an unresolved `ambiguous` item, continue asserting that neither `start_one` nor
`resume_one` is rendered and no process is spawned.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node tests/communication_application_smoke.js
node tests/dashboard_communication_batch_smoke.js
```

Expected: failures show that `start` is still accepted, `start_one` is invalid, the exact item is not passed to the child process, and the old full-batch button is rendered.

- [ ] **Step 3: Implement minimal application validation**

In `controlCommunicationBatch()`:

```js
const requestedAction = String(input.action || "").trim().toLowerCase();
const singleItemAction = requestedAction === "start_one" || requestedAction === "resume_one";
const action = requestedAction.replace(/_one$/, "");
const calibration = (deps.communicationCalibrationReader || communicationCalibrationStatus)();

if (calibration.acceptance === "e2e_pending"
  && (action === "start" || action === "resume")
  && !singleItemAction) {
  throw appError(
    "COMMUNICATION_E2E_SINGLE_ITEM_REQUIRED",
    "端到端验收期间每次只能确认一个岗位。",
    { statusCode: 409 }
  );
}
```

Before changing the batch status, select the first `pending` item in stored position order.
For a `_one` action, require a positive submitted `itemId` equal to that row's ID and
require `clickCount === 0`. Reject missing, stale, or later IDs with
`COMMUNICATION_SINGLE_ITEM_MISMATCH` and status 409.

Call:

```js
deps.spawnCommunication({
  batch: running,
  ...(singleItemAction ? { singleItemId: nextPending.id } : {})
});
```

Retain the existing ambiguity, calibration execution, runtime, batch-status, and process-launcher checks.

- [ ] **Step 4: Render the exact single-item authorization**

In `buildCommunicationViewModel()`, derive the first pending item from the already normalized
item list. While `current.calibration.acceptance === "e2e_pending"`:

```js
const singleItem = items.find((item) => item.status === "pending") || null;
const pendingAcceptance = text(current.calibration?.acceptance) === "e2e_pending";

controls.action = pendingAcceptance
  ? action === "start" ? "start_one" : action === "resume" ? "resume_one" : ""
  : action;
controls.singleItemId = pendingAcceptance ? number(singleItem?.id) : 0;
controls.singleItemTitle = pendingAcceptance ? text(singleItem?.title) : "";
controls.singleItemCompany = pendingAcceptance ? text(singleItem?.company) : "";
```

The control is visible only when the current execution checks pass and a positive
`singleItemId` exists.

In `renderCommunicationPage()`, render the pending-calibration copy and hidden ID:

```html
<p class="section-label">下一次仅验收 1 个岗位</p>
<h2>岗位名称 / 公司名称</h2>
<p class="muted">本次只处理这个岗位，随后自动暂停；结果不明不会重试。</p>
<input type="hidden" name="itemId" value="123">
<button name="action" value="resume_one">验收这个岗位并自动暂停</button>
```

Keep the unresolved-ambiguity page unchanged.

- [ ] **Step 5: Pass the item ID to the hidden CLI**

Change the server dependency and launcher signatures to:

```js
spawnCommunication: ({ batch, singleItemId }) =>
  startCommunicationProcess({
    db, root, dbPath, batch, singleItemId,
    logger, requestId, spawnProcess
  })
```

In `startCommunicationProcess()`, append only a valid positive integer:

```js
if (Number.isInteger(Number(singleItemId)) && Number(singleItemId) > 0) {
  commandArgs.push("--single-item", String(Number(singleItemId)));
}
```

Do not change `windowsHide: true`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
node tests/communication_application_smoke.js
node tests/dashboard_communication_batch_smoke.js
```

Expected: both scripts print their existing `... ok` line and exit 0.

- [ ] **Step 7: Commit**

```powershell
git add tests/communication_application_smoke.js tests/dashboard_communication_batch_smoke.js src/application/communication/index.js src/dashboard/view_models/communication.js src/dashboard/pages/communication.js src/dashboard/server.js
git commit -m "feat: require one communication item during acceptance"
```

---

### Task 2: Stop the executor and workflow at a durable one-item checkpoint

**Files:**

- Modify: `tests/communication_executor_smoke.js`
- Modify: `tests/communication_cli_authority_smoke.js`
- Modify: `tests/workflow_communication_smoke.js`
- Modify: `tests/communication_calibration_gate_smoke.js`
- Modify: `tests/workflow_end_to_end_smoke.js`
- Modify: `src/core/communication_executor.js`
- Modify: `src/cli.js`
- Modify: `src/dashboard/status_labels.js`

**Interfaces:**

- Consumes: CLI `args["single-item"]`, `runCommunicationBatch({ singleItemId })`, existing `setCommunicationBatchStatus()`, `transitionWorkflowRun()`, and `communicationWorkflowMetrics()`.
- Produces: batch/workflow interruption code `COMMUNICATION_SINGLE_ITEM_CHECKPOINT`; summary with the remaining items untouched; Chinese diagnostic label for the controlled checkpoint.

- [ ] **Step 1: Write the failing executor test**

Add a two-item fixture with an attached review workflow:

```js
async function singleItemCheckpointSmoke() {
  const fixture = createFixture(2);
  const workflow = attachReviewWorkflow(fixture);
  const [first, second] = listCommunicationBatchItems(fixture.db, fixture.batch.id);
  let dispatches = 0;

  const summary = await runPermittedBatch({
    db: fixture.db,
    batchId: fixture.batch.id,
    singleItemId: first.id,
    accessController: { async reserve() {} },
    adapter: {
      async inspectCommunicationJob() { return { state: "ready" }; },
      async dispatchCommunication() { dispatches += 1; },
      async verifyCommunicationResult() { return { state: "succeeded" }; }
    },
    sleepFn: async () => { throw new Error("single item must not enter pacing"); }
  });

  assert.strictEqual(dispatches, 1);
  assert.deepStrictEqual(
    listCommunicationBatchItems(fixture.db, fixture.batch.id)
      .map((item) => [item.id, item.status, item.clickCount]),
    [[first.id, "succeeded", 1], [second.id, "pending", 0]]
  );
  assert.strictEqual(summary.batchStatus, "interrupted");
  assert.strictEqual(
    getCommunicationBatch(fixture.db, fixture.batch.id).stopCode,
    "COMMUNICATION_SINGLE_ITEM_CHECKPOINT"
  );
  assert.strictEqual(getWorkflowRun(fixture.db, workflow.id).status, "interrupted");
  assert.strictEqual(
    getWorkflowRun(fixture.db, workflow.id).errorCode,
    "COMMUNICATION_SINGLE_ITEM_CHECKPOINT"
  );
  fixture.close();
}
```

Add a mismatch case passing the second item ID and assert no reservation, inspection, or click
occurs and both rows remain `pending`.

Add the new test to the promise chain before the existing normal multi-item success test, so
the existing default behavior still proves that omitting `singleItemId` executes the full batch.

- [ ] **Step 2: Run the executor test and verify RED**

Run:

```powershell
node tests/communication_executor_smoke.js
```

Expected: the executor processes both rows or lacks the checkpoint code.

- [ ] **Step 3: Implement exact-item validation and checkpoint**

Add `singleItemId = null` to `runCommunicationBatch()`. Normalize it once:

```js
const authorizedItemId = singleItemId == null ? null : Number(singleItemId);
if (authorizedItemId !== null
  && (!Number.isInteger(authorizedItemId) || authorizedItemId <= 0)) {
  throw codedError("COMMUNICATION_SINGLE_ITEM_INVALID", "single communication item id is invalid");
}
```

After selecting the first nonterminal row and before claiming it:

```js
if (authorizedItemId !== null
  && (item.id !== authorizedItemId || item.status !== "pending" || item.clickCount !== 0)) {
  return interruptAndThrow(
    db,
    batchId,
    codedError("COMMUNICATION_SINGLE_ITEM_MISMATCH", "authorized communication item changed"),
    logger
  );
}
```

Immediately after one item reaches a terminal status, before target completion and pacing:

```js
if (authorizedItemId !== null) {
  return checkpointSingleItemRun(db, batchId, logger);
}
```

Implement `checkpointSingleItemRun()` with existing transitions only:

```js
function checkpointSingleItemRun(db, batchId, logger) {
  const code = "COMMUNICATION_SINGLE_ITEM_CHECKPOINT";
  let summary;
  let workflow;
  db.exec("SAVEPOINT communication_single_item_checkpoint");
  try {
    setCommunicationBatchStatus(db, {
      batchId,
      status: "interrupted",
      stopCode: code,
      stopMessage: "single communication item acceptance checkpoint"
    });
    const batch = getCommunicationBatch(db, batchId);
    summary = communicationBatchSummary(db, batchId);
    workflow = getWorkflowRunByCommunicationBatch(db, batchId);
    if (workflow?.status === "communicating") {
      transitionWorkflowRun(db, {
        id: workflow.id,
        status: "interrupted",
        successfulCount: successfulCommunicationCount(db, batchId),
        metrics: communicationWorkflowMetrics(workflow, summary, batch),
        errorCode: code,
        errorMessage: "single communication item acceptance checkpoint"
      });
    }
    db.exec("RELEASE SAVEPOINT communication_single_item_checkpoint");
  } catch (error) {
    try { db.exec("ROLLBACK TO SAVEPOINT communication_single_item_checkpoint"); } catch {}
    try { db.exec("RELEASE SAVEPOINT communication_single_item_checkpoint"); } catch {}
    throw error;
  }
  logger?.info("communication_single_item_checkpoint", {
    batchId,
    workflowRunId: workflow?.id || null
  });
  return summary;
}
```

This checkpoint must run before `workflowTargetReached()` so later pending rows remain pending
even if this one item satisfies the current target.

At the top of the loop, automatic target completion applies only when
`authorizedItemId === null`. A later explicit single-item authorization must process that exact
item even when an earlier accepted item already met the workflow target. Add a target=1,
two-authorizations regression test. The SAVEPOINT test uses a TEMP trigger to force the workflow
update to fail and proves batch/workflow checkpoint state does not partially commit.

- [ ] **Step 4: Pass the CLI argument without broadening normal execution**

In `communicate()`:

```js
const singleItemId = args["single-item"] === undefined
  ? null
  : Number(args["single-item"]);
if (singleItemId !== null
  && (!Number.isInteger(singleItemId) || singleItemId <= 0)) {
  throw codedError("COMMUNICATION_SINGLE_ITEM_INVALID", "需要有效的 --single-item <item ID>");
}
```

Pass `singleItemId` to `runCommunicationBatchFn()`. Before creating a browser, reject a missing
ID with `COMMUNICATION_E2E_SINGLE_ITEM_REQUIRED` while
`communicationCalibrationStatus().acceptance === "e2e_pending"`. A future `accepted` calibration
may still omit the ID for normal full-batch execution.

The CLI catch fallback must update a still-running batch and its communicating workflow inside
one `SAVEPOINT communication_process_failure`. If either update fails, roll both back and leave
the unified running state for existing heartbeat/orphan recovery. Add a `communicate()` integration
test with a TEMP workflow trigger proving the fallback never leaves only the batch interrupted.

Change the final console line only when `summary.batchStatus === "interrupted"` and the stored
batch stop code is `COMMUNICATION_SINGLE_ITEM_CHECKPOINT`, so it says the batch paused after one
item instead of saying the entire batch completed.

Add a Chinese label for `COMMUNICATION_SINGLE_ITEM_CHECKPOINT` in
`src/dashboard/status_labels.js`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
node tests/communication_executor_smoke.js
node tests/communication_application_smoke.js
```

Expected: both exit 0; default multi-item execution remains covered by the existing success flow.

- [ ] **Step 6: Commit**

```powershell
git add tests/communication_executor_smoke.js tests/communication_cli_authority_smoke.js tests/workflow_communication_smoke.js tests/communication_calibration_gate_smoke.js tests/workflow_end_to_end_smoke.js src/core/communication_executor.js src/cli.js src/dashboard/status_labels.js docs/superpowers/specs/2026-08-14-communication-single-job-acceptance-design.md docs/superpowers/plans/2026-08-14-communication-single-job-acceptance.md
git commit -m "feat: checkpoint communication after one authorized item"
```

---

### Task 3: Activate and verify the fixed BOSS tab before dispatch

**Files:**

- Modify: `tests/boss_communication_page_smoke.js`
- Modify: `src/adapters/sites/boss.js`
- Modify: `src/dashboard/status_labels.js`

**Interfaces:**

- Consumes: existing browser methods `bringToFront(tabId)` and `listTabs()`, fixed communication binding, and `assertBoundCommunicationTabs()`.
- Produces: `BOSS_COMMUNICATION_TAB_NOT_ACTIVE` before `clickAt()` if foreground activation cannot be confirmed.

- [ ] **Step 1: Make the fake browser expose real active-tab behavior**

Extend `fakeBrowser()` with `focusSucceeds = true`. Its `bringToFront()` must record the call and,
when enabled, update exactly one tab in that window to `active: true`:

```js
async bringToFront(tabId) {
  calls.bringToFront.push(tabId);
  if (!focusSucceeds) return;
  const target = currentTabs.find((tab) => tab.id === tabId);
  currentTabs = currentTabs.map((tab) => ({
    ...tab,
    active: tab.windowId === target?.windowId ? tab.id === tabId : tab.active
  }));
}
```

Make `clickAt()` throw if its target tab is not active. This means existing successful dispatch
will fail against production code that forgets to focus first.

Add a negative test:

```js
const inactiveBrowser = fakeBrowser({
  tabs: [{ id: "search", url: searchUrl, windowId: "window-1", active: false }],
  focusSucceeds: false
});
const inactiveAdapter = new BossSiteAdapter({ browser: inactiveBrowser, sleepFn: async () => {} });
const inactiveInspection = await inactiveAdapter.inspectCommunicationJob(expectedJob);
await assert.rejects(
  () => inactiveAdapter.dispatchCommunication(inactiveInspection),
  (error) => error.code === "BOSS_COMMUNICATION_TAB_NOT_ACTIVE"
);
assert.deepStrictEqual(inactiveBrowser.calls.bringToFront, ["communication-created"]);
assert.strictEqual(inactiveBrowser.calls.clickAt.length, 0);
```

For the existing success case, assert the focused tab is the same tab passed to `clickAt`.

- [ ] **Step 2: Run the adapter test and verify RED**

Run:

```powershell
node tests/boss_communication_page_smoke.js
```

Expected: successful dispatch fails because `clickAt()` receives an inactive tab, or the new
negative assertion shows no activation attempt.

- [ ] **Step 3: Implement focus and post-focus validation**

Inside `dispatchCommunication()`, after `prepareCommunicationTab()` and before helper injection,
readiness, network logging, click intent registration, and `clickAt()`:

```js
if (typeof this.browser.bringToFront !== "function") {
  throw bossError(
    "BOSS_COMMUNICATION_TAB_NOT_ACTIVE",
    "The BOSS communication tab cannot be activated safely."
  );
}
await this.browser.bringToFront(tabId);
const activeTab = this.communicationTabsBound
  ? (await this.assertBoundCommunicationTabs({ requireSearchPage: false })).searchTab
  : (await this.browser.listTabs()).find((tab) => String(tab.id) === String(tabId));
if (!activeTab || activeTab.active !== true) {
  throw bossError(
    "BOSS_COMMUNICATION_TAB_NOT_ACTIVE",
    "The fixed BOSS search tab did not become active before communication."
  );
}
```

For a bound Edge session, keep numeric binding validation in
`normalizeCommunicationTabBinding()` unchanged. After the active check, retain the existing
stable readiness snapshots, final guarded target expression, single browser click, network
evidence, and no-retry behavior.

After the final guarded target expression succeeds and immediately before `clickAt()`, call the
same active-tab assertion again. Add a fake-browser case that loses focus after guarded target
calculation and proves `clickAt()` remains at zero.

Add a Chinese label for `BOSS_COMMUNICATION_TAB_NOT_ACTIVE`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
node tests/boss_communication_page_smoke.js
node tests/browser_transport_smoke.js
node tests/communication_executor_smoke.js
```

Expected: all print their existing `... ok` line and exit 0.

- [ ] **Step 5: Commit**

```powershell
git add tests/boss_communication_page_smoke.js src/adapters/sites/boss.js src/dashboard/status_labels.js
git commit -m "fix: activate BOSS tab before communication click"
```

---

### Task 4: Prepare and verify the beta.4.3 local acceptance installer

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Create: `docs/releases/v0.1.0-beta.4.3.md`
- Generated outside git: `D:\Guo\ZhiPing\dist\RoleFlow-Setup-0.1.0-beta.4.3.exe`
- Generated outside git: `D:\Guo\ZhiPing\dist\RoleFlow-Setup-0.1.0-beta.4.3.exe.sha256`

**Interfaces:**

- Consumes: verified source tree, `scripts/build-installer.ps1`, pinned Node 22.23.1, and the configured Inno Setup compiler.
- Produces: a beta.4.3 local upgrade installer that preserves installed user data; no remote release.

- [ ] **Step 1: Update version and release documentation**

Set both package manifests to exactly:

```json
"version": "0.1.0-beta.4.3"
```

Update README release badge, download filename, tag text, and user-facing release summary from
beta.4.2 to beta.4.3.

Create `docs/releases/v0.1.0-beta.4.3.md` documenting:

- current data can be reused through upgrade installation;
- unresolved ambiguous items still require local evidence-based resolution;
- `e2e_pending` executes one exact item and pauses;
- the fixed BOSS search tab is activated and confirmed before the one click;
- no result ambiguity is retried;
- tests use fake browser only;
- real single-job E2E remains pending until the user explicitly authorizes it.

- [ ] **Step 2: Verify manifest consistency**

Run:

```powershell
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); if(p.version!=='0.1.0-beta.4.3'||l.version!==p.version||l.packages[''].version!==p.version) process.exit(1); console.log(p.version)"
git diff --check
```

Expected: `0.1.0-beta.4.3`, exit 0, and no whitespace errors.

- [ ] **Step 3: Run focused communication verification**

Run:

```powershell
node tests/communication_application_smoke.js
node tests/dashboard_communication_batch_smoke.js
node tests/communication_executor_smoke.js
node tests/boss_communication_page_smoke.js
node tests/browser_transport_smoke.js
```

Expected: all five scripts exit 0.

- [ ] **Step 4: Run the complete offline suite**

Run:

```powershell
npm test
```

Expected: exit 0 and `All 97 offline checks passed.` No live model or BOSS access is allowed.

- [ ] **Step 5: Build the installer to D drive**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-installer.ps1 -OutputDir D:\Guo\ZhiPing\dist
```

Expected:

- complete offline checks pass inside the builder;
- stage directory is `D:\DevData\RoleFlow-installer\stage\0.1.0-beta.4.3`;
- forbidden database, resume, key, log, report, browser-profile, test, and Edge Control files are absent;
- installer and `.sha256` exist under `D:\Guo\ZhiPing\dist`.

- [ ] **Step 6: Verify installer identity and hash**

Run:

```powershell
$installer = 'D:\Guo\ZhiPing\dist\RoleFlow-Setup-0.1.0-beta.4.3.exe'
Get-Item -LiteralPath $installer | Select-Object FullName,Length,VersionInfo
Get-FileHash -LiteralPath $installer -Algorithm SHA256
Get-Content -LiteralPath "$installer.sha256"
```

Expected: file version identifies `0.1.0-beta.4.3`; computed SHA256 equals the sidecar file.

- [ ] **Step 7: Commit release metadata**

```powershell
git add package.json package-lock.json README.md docs/releases/v0.1.0-beta.4.3.md
git commit -m "docs: prepare beta4.3 communication acceptance release"
```

- [ ] **Step 8: Final source verification**

Run:

```powershell
git status --short
git log --oneline --decorate -6
npm test
```

Expected: clean tracked worktree, feature commits present, and
`All 97 offline checks passed.` Do not tag, push, publish, install, resolve the real ambiguous
item, or click the real acceptance button.
