# Detail-read outcome audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a sanitized outcome for every reserved BOSS pane-detail read so later acceptance can distinguish successful reads from stable failure codes without exposing job content.

**Architecture:** `BossSiteAdapter.scanBrowser()` emits an optional result callback after each reserved detail attempt. The CLI persists it as an existing `site_access` event named `pane_detail_result`; no schema migration is required.

**Tech Stack:** Node.js CommonJS, `node:sqlite`, existing smoke-test harness.

## Global Constraints

- Do not access BOSS, a browser, network services, or live acceptance databases while implementing or testing.
- Do not change BOSS navigation, click selectors, pacing, cooldowns, browser-page budgets, card/detail limits, matching, recommendation, or communication behavior.
- A persisted outcome event may contain only `site`, `action`, `runId`, `batchId`, `outcome`, and `errorCode`. It must not contain job IDs, source IDs, titles, companies, URLs, JD text, DOM, error messages, recruiter data, or credentials.
- `pane_detail_result` is audit-only: it must not call `createSiteAccessController.reserve()` or consume access budget.
- Preserve existing failed-job `detailErrorCode`, fatal-browser handling, checkpoint behavior, and scan counts.
- Work only in `C:\Users\Administrator\.codex\worktrees\a9d9\ZhiPing`; do not run a live BOSS retest.

---

### Task 1: Emit sanitized detail outcomes from the adapter

**Files:**

- Modify: `src/adapters/sites/boss.js:745-780`
- Test: `tests/source_acquisition_smoke.js`

**Interfaces:**

- Add optional `scanBrowser(options).onDetailResult`.
- Invoke it exactly once after every reserved `pane_detail_read` with:

```js
{ outcome: "succeeded" | "failed", errorCode: "" | "BOSS_*" }
```

- [ ] **Step 1: Add a failing source-acquisition test**

Add `detailOutcomeAuditSmoke()`, invoke it from the top-level async sequence after `detailFailureDedupeSmoke()`, and use a fake adapter with two cards. Make one `readCardDetail` return `"Complete detail Python RAG ".repeat(12)` and make the other throw `Object.assign(new Error("pane timeout"), { code: "BOSS_PANE_SWITCH_TIMEOUT" })`.

Assert:

```js
assert.deepStrictEqual(outcomes, [
  { outcome: "succeeded", errorCode: "" },
  { outcome: "failed", errorCode: "BOSS_PANE_SWITCH_TIMEOUT" }
]);
assert.strictEqual(jobs.find((job) => job.title === "audit-failure").detailErrorCode, "BOSS_PANE_SWITCH_TIMEOUT");
assert(!JSON.stringify(outcomes).includes("audit-failure"));
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
node tests/source_acquisition_smoke.js
```

Expected: the new assertion fails because current code never calls `onDetailResult`.

- [ ] **Step 3: Implement the minimal adapter callback**

Add a local helper:

```js
async function emitDetailResult(callback, { outcome, errorCode = "" } = {}) {
  if (typeof callback !== "function") return;
  const succeeded = outcome === "succeeded";
  await callback({
    outcome: succeeded ? "succeeded" : "failed",
    errorCode: succeeded ? "" : String(errorCode || "BOSS_CARD_DETAIL_READ_FAILED")
  });
}
```

Refactor only the inner `for (const entry of detailEntries)` block. Capture the read outcome in its existing success/failure paths, then call `await emitDetailResult(options.onDetailResult, outcome)` once outside the inner `try/catch`. Keep the existing merge, logger, failed-job state, fatal-error rethrow, and pacing behavior. Never pass job data or `error.message` to the callback.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```powershell
node tests/source_acquisition_smoke.js
git add -- src/adapters/sites/boss.js tests/source_acquisition_smoke.js
git commit -m "feat: emit detail read audit outcomes"
```

Expected: `source_acquisition_smoke ok`; one focused implementation commit.

---

### Task 2: Persist only the approved outcome fields

**Files:**

- Modify: `src/cli.js:934-1003` and its `module.exports`
- Test: `tests/workflow_scan_smoke.js`

**Interfaces:**

- Add and export `persistDetailOutcome(db, { site, runId, batchId, result })`.
- It writes one `recordSiteAccessEvent` record with action `pane_detail_result`.

- [ ] **Step 1: Add a failing persistence/privacy test**

Import `persistDetailOutcome` into `tests/workflow_scan_smoke.js`. After existing `workflowAccessUsage` assertions, call it with a failed result containing permitted `outcome` and `errorCode` plus decoy `title`, `url`, and `errorMessage` fields.

Use `listSiteAccessEvents(db, { site: "boss", action: "pane_detail_result" })` and assert the sole event details equal:

```js
{
  site: "boss",
  action: "pane_detail_result",
  runId: "usage-probe",
  batchId: 42,
  outcome: "failed",
  errorCode: "BOSS_PANE_SWITCH_TIMEOUT"
}
```

Then assert `workflowAccessUsage(db, "usage-probe")` remains `{ details: 2, pages: 1, scrolls: 1 }`.

- [ ] **Step 2: Verify RED**

Run:

```powershell
node tests/workflow_scan_smoke.js
```

Expected: failure because `persistDetailOutcome` is not exported.

- [ ] **Step 3: Implement the helper and wire it into the scan**

Add and export:

```js
function persistDetailOutcome(db, { site, runId = "", batchId, result = {} } = {}) {
  const succeeded = result?.outcome === "succeeded";
  return recordSiteAccessEvent(db, {
    site,
    action: "pane_detail_result",
    runId,
    details: {
      batchId: Number(batchId),
      outcome: succeeded ? "succeeded" : "failed",
      errorCode: succeeded ? "" : String(result?.errorCode || "BOSS_CARD_DETAIL_READ_FAILED")
    }
  });
}
```

Pass this callback to the existing `adapter.scan({...})` call:

```js
onDetailResult: args.input ? null : async (result) => persistDetailOutcome(db, {
  site,
  runId: execution?.runId || "",
  batchId,
  result
}),
```

Do not reserve access or add `onReserved` handling.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```powershell
node tests/workflow_scan_smoke.js
git add -- src/cli.js tests/workflow_scan_smoke.js
git commit -m "feat: persist detail read audit outcomes"
```

Expected: `workflow_scan_smoke ok`; one focused implementation commit.

---

### Task 3: Focused regression and Flash review

**Files:**

- Verify: `tests/source_acquisition_smoke.js`
- Verify: `tests/workflow_scan_smoke.js`
- Verify: `tests/site_access_budget_smoke.js`
- Verify: `tests/browser_transport_smoke.js`
- Verify: `tests/browser_readiness_smoke.js`

- [ ] **Step 1: Run the regression gate**

Run:

```powershell
node tests/source_acquisition_smoke.js
node tests/workflow_scan_smoke.js
node tests/site_access_budget_smoke.js
node tests/browser_transport_smoke.js
node tests/browser_readiness_smoke.js
git diff --check
```

Expected: every smoke test prints its `... ok` line and `git diff --check` has no output.

- [ ] **Step 2: Flash review**

Dispatch a `deepseek/deepseek-v4-flash` reviewer with the implementation diff. Require a verdict on: one outcome per reserved read; privacy allowlist; no access-budget impact; no BOSS behavior change; and adequate success/failure/privacy tests.

- [ ] **Step 3: Record durable progress**

Only after review has no Critical or Important findings, update `.superpowers/sdd/progress.md` with the implementation commit IDs, focused test results, review verdict, and the fact that no live BOSS retest ran.
