# Communication Background Dispatch And Stable Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop communication clicks from bringing Edge forward and stop the workflow page from entering a full-page reload loop while communication is running.

**Architecture:** Reuse the existing short-lived CDP focus-emulation pattern around the single trusted mouse click, leaving all identity and outcome checks intact. Complete the existing public workflow status projection so the browser and server calculate the same communication polling key.

**Tech Stack:** Node.js 22 CommonJS, built-in `node:sqlite`, server-rendered HTML, existing assert-based smoke tests.

## Global Constraints

- No real BOSS write action during implementation or offline verification.
- No automatic retry or resolution of the current ambiguous item.
- No `Page.bringToFront`, tab activation, or window activation in communication dispatch.
- No new dependency or fallback click path.
- Tests and full verification run before the single implementation commit.

---

### Task 1: Background communication dispatch

**Files:**
- Modify: `tests/boss_communication_page_smoke.js`
- Modify: `src/adapters/sites/boss.js`

**Interfaces:**
- Consumes: `browser.cdp(tabId, method, params)`, `browser.clickAt(tabId, point)`, existing guarded target expression and fixed-tab assertions.
- Produces: `dispatchCommunication(inspection, signal)` with one click, zero foreground activation, and guaranteed focus-emulation cleanup.

- [x] **Step 1: Write the failing test**

Change the hidden bound-tab dispatch case to expect:

```js
assert.deepStrictEqual(browser.calls.bringToFront, []);
assert.deepStrictEqual(browser.calls.focusEmulation, [true, false]);
assert.strictEqual(browser.calls.clickAt.length, 1);
```

Add a guarded-target failure case that expects no click and the same `[true, false]` cleanup pair.
Record the fake-browser call timeline and require no `listTabs` call between the final guarded DOM validation and `clickAt`. Also inject a `clickAt` error and require focus emulation to be disabled in `finally`.

- [x] **Step 2: Run the test and verify RED**

Run: `node tests/boss_communication_page_smoke.js`

Expected: FAIL because the current implementation calls `bringToFront` and requires an active tab.

- [x] **Step 3: Implement the minimal production change**

In `dispatchCommunication()`:

```js
if (typeof this.browser.cdp !== "function" || typeof this.browser.clickAt !== "function") {
  throw bossError("BOSS_COMMUNICATION_TAB_NOT_ACTIVE", "The BOSS communication tab cannot receive a trusted background click.");
}
await this.browser.cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
try {
  // fixed-tab recheck, final guarded target calculation, and one click with no async tab read in between
} finally {
  await this.browser.cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false });
}
```

Delete the now-unused communication-only active-tab assertion. Do not change browser adapters or the trusted-pane flow.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `node tests/boss_communication_page_smoke.js`

Expected: PASS.

---

### Task 2: Stable communication polling key

**Files:**
- Modify: `tests/workflow_dashboard_smoke.js` or the existing server-level workflow status smoke that already calls `/api/workflow-status`
- Modify: `tests/workflow_page_migration_smoke.js`
- Modify: `src/application/workflow/index.js`
- Modify: `src/dashboard/server.js`

**Interfaces:**
- Consumes: persisted `workflow.successfulCount`.
- Produces: public workflow status JSON with numeric `successfulCount`.

- [x] **Step 1: Write the failing test**

For a communicating workflow with a non-zero success count, assert:

```js
assert.strictEqual(status.workflow.successfulCount, 2);
```

Also assert the rendered communication polling key contains the same value.

- [x] **Step 2: Run the test and verify RED**

Run the selected focused workflow dashboard smoke.

Expected: FAIL because `publicWorkflow()` currently omits `successfulCount`.

- [x] **Step 3: Implement the minimal production change**

Add one numeric field to `publicWorkflow()`:

```js
successfulCount: Number(workflow.successfulCount || 0),
```

Pass the persisted `workflow.successfulCount` into that public projection alongside the existing persisted error code.

- [x] **Step 4: Run the focused test and verify GREEN**

Run the selected focused workflow dashboard smoke.

Expected: PASS.

---

### Task 3: Verification before commit

**Files:**
- Verify all modified files and the two new documents.

- [x] **Step 1: Run focused checks**

Run:

```powershell
node tests/boss_communication_page_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/workflow_page_migration_smoke.js
```

Expected: all exit 0.

- [x] **Step 2: Run the complete safe offline suite**

Run every entry in `tests/run_all.js` except `startup_scripts_smoke.js`, which compiles a temporary executable named `msedge.exe` and triggered a 360 warning on this machine.

Result: all 96 safe checks passed. `model_task_profiles_smoke.js` completed successfully in about 146 seconds when rerun without an artificial 120-second wrapper timeout.

- [x] **Step 3: Check the final diff**

Run:

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors and only the scoped files are modified.

- [x] **Step 4: Delay commit until acceptance evidence is ready**

The user-authorized immutable batch completed with 10 succeeded and 2 historical stopped items, with no pending or ambiguous items added. Both BOSS tabs remained inactive, local polling evidence showed no reload loop, and read-only message discovery preserved three unmatched conversations for manual handling. The final post-review click ordering change was covered by fake-browser regression tests and was not used to repeat the exhausted real communication authorization.
