# Background Message Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow read-only message discovery to open and close one same-window background job-detail tab when the dedicated Edge window has zero visible pages.

**Architecture:** Reuse the existing empty visible-ID baseline already supported by `CdpBrowserAdapter.createTab()`. Relax only the message-detail reader's pre-create cardinality check from exactly one visible page to at most one; keep the existing same-window, single-new-target, hidden-target, identity, exact-baseline-restoration, pacing, access-budget, and stop-on-failure checks.

**Tech Stack:** Node.js CommonJS, built-in `node:assert/strict`, existing offline smoke-test harness.

## Global Constraints

- Do not add dependencies, configuration, browser extensions, retry layers, or new browser sessions.
- Do not call `Page.bringToFront` or weaken login, risk-control, identity, pacing, access-budget, serial-execution, or cleanup checks.
- A zero-visible baseline is valid only while the created target stays hidden and the exact zero-visible/tab-ID baseline is restored after cleanup.
- Real BOSS verification remains read-only; do not send replies, submit applications, or create a new communication batch.

---

### Task 1: Accept a zero-visible background baseline without weakening cleanup

**Files:**
- Modify: `tests/boss_message_detail_reader_smoke.js`
- Modify: `src/adapters/sites/boss_message_detail_reader.js`
- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `tests/dashboard_message_discovery_smoke.js`

**Interfaces:**
- Consumes: `browser.listTabs()`, `browser.createTab(openerTabId, url)`, `browser.closeTab(tabId)`, and the existing typed-tab helpers.
- Produces: `captureBinding()` accepts zero or one visible tab ID; all later checks continue comparing the exact captured visible-ID array.

- [x] **Step 1: Replace the minimized-window rejection assertion with a successful read assertion**

In `tests/boss_message_detail_reader_smoke.js`, replace the existing `minimizedBrowser` rejection block with:

```js
  const minimizedBrowser = fakeBrowser({ minimized: true });
  const minimized = makeReader(minimizedBrowser);
  const minimizedDetail = await read(minimized.reader);
  assert.strictEqual(minimizedDetail.sourceId, jobTarget.jobId);
  assert.deepStrictEqual(minimized.hooks, ["beforeOpen", "recheckMessage", "afterIssuedAttempt"]);
  assert.strictEqual(minimizedBrowser.calls.filter((call) => call.name === "createTab").length, 1);
  assert.strictEqual(minimizedBrowser.calls.filter((call) => call.name === "closeTab").length, 1);
  assert.deepStrictEqual(
    minimizedBrowser.tabs,
    baseTabs().map((tab) => ({ ...tab, active: false })),
    "a zero-visible Edge window must restore the exact hidden typed baseline"
  );
```

Keep the adjacent two-visible fixture unchanged so ambiguous visible state still fails before pacing or creation.

- [x] **Step 2: Update the public-copy expectation**

In `tests/dashboard_message_discovery_smoke.js`, replace the minimized-window wording assertion with:

```js
      assert.doesNotMatch(safeMessage, /还原 RoleFlow 专用 Edge（推荐）窗口/,
        "a zero-visible dedicated Edge window must not be presented as a recovery prerequisite");
      assert.match(safeMessage, /会话已保留/,
        "a genuine background-proof failure must say the pending conversation is preserved");
```

- [x] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
node tests/boss_message_detail_reader_smoke.js
node tests/dashboard_message_discovery_smoke.js
```

Expected: the first test fails with `BOSS_MESSAGE_DETAIL_NOT_BACKGROUND` in the new zero-visible success case; the Dashboard test fails because the current copy still tells the user to restore the Edge window.

- [x] **Step 4: Implement the minimum reader change**

In `captureBinding()` in `src/adapters/sites/boss_message_detail_reader.js`, change only the cardinality guard:

```js
  const visibleTabIds = visibleTabIdsInWindow(tabs, fixed.windowId);
  if (visibleTabIds.length > 1) {
    throw detailError("BOSS_MESSAGE_DETAIL_NOT_BACKGROUND", "visible Edge tab identity is ambiguous");
  }
```

Do not alter `assertBackgroundCreation()`, `assertLiveDetailBinding()`, `assertRestoredBaseline()`, or `CdpBrowserAdapter.createTab()`: they already preserve and compare an empty visible-ID baseline while still requiring one hidden, same-window, uniquely attributable transient target.

- [x] **Step 5: Correct the recovery copy**

In `src/dashboard/message_discovery_view.js`, change `BOSS_MESSAGE_DETAIL_NOT_BACKGROUND` to:

```js
    BOSS_MESSAGE_DETAIL_NOT_BACKGROUND: "岗位详情未能保持后台安全打开；若临时页已创建，系统会先关闭它。该会话已保留，本次只读发现已停止，请保持专用 Edge 的固定标签页不变后重试。",
```

- [x] **Step 6: Run the focused tests and verify GREEN**

Run:

```powershell
node tests/boss_message_detail_reader_smoke.js
node tests/dashboard_message_discovery_smoke.js
node tests/browser_transport_smoke.js
```

Expected: all three commands exit 0 with their existing `ok` messages and no warnings.

- [x] **Step 7: Run the proportional offline gate**

Run:

```powershell
npm test
git diff --check
git status --short
```

Expected: the full offline suite passes, whitespace validation is silent, and only the four planned implementation/test files plus this plan are changed before commit.

- [x] **Step 8: Commit the verified fix**

```powershell
git add tests/boss_message_detail_reader_smoke.js src/adapters/sites/boss_message_detail_reader.js src/dashboard/message_discovery_view.js tests/dashboard_message_discovery_smoke.js docs/superpowers/plans/2026-08-30-background-message-detail.md
git commit -m "fix: allow minimized background message detail reads"
```

- [x] **Step 9: Continue the real read-only acceptance**

With the same dedicated Edge window left in the background/minimized state:

```powershell
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8787/api/message-discovery' -ContentType 'application/json' -Body '{"action":"start","profileId":1}'
```

Poll `/api/message-discovery-status?profileId=1` until terminal. Confirm that no `BOSS_MESSAGE_DETAIL_NOT_BACKGROUND` occurs solely because the baseline has zero visible pages; stop on any login, risk-control, target-mismatch, page-loss, new-window, or cleanup error. Then complete the separate investigation of the 12 `DETAIL_REQUIRED` analysis items.

Outcome: the minimized/hidden baseline no longer triggered `BOSS_MESSAGE_DETAIL_NOT_BACKGROUND`. The real run reached message selection, transient detail reads and model analysis, then exposed a separate hidden-page lifecycle suspension and a transient post-close tab-list failure. The 12-item investigation found 4 genuine pending details and 8 already-determinable exclusions. Full results are recorded in `docs/superpowers/reports/2026-08-30-real-user-e2e-acceptance.md`.

---

### Task 2: Wake verified hidden pages without focusing them

**Files:**
- Modify: `scripts/lib/startup-identity.ps1`
- Modify: `src/adapters/browser/cdp.js`
- Modify: `src/adapters/browser/edge_control.js`
- Modify: `src/adapters/sites/boss_message_reader.js`
- Modify: `src/adapters/sites/boss_message_detail_reader.js`
- Modify: focused browser/message tests

- [x] Add browser-adapter support for `Page.setWebLifecycleState({ state: "active" })`.
- [x] Wake the fixed message page only after its binding is captured, then recheck the binding before reading or selecting.
- [x] Replace the ineffective synthetic DOM click with the observed outer `boss-list.handleClick()` path after exact row, message, job and component checks.
- [x] Freeze a one-way digest of the observed `friendId` during scanning and require an exact match before invoking the outer handler; never expose the raw identifier.
- [x] Wake a transient detail page only after proving its exact hidden same-window identity, then recheck all bindings.
- [x] Recheck the fixed tabs, transient target and visible set during every readiness attempt and after each critical read.
- [x] Reinject page helpers into the final loaded document so navigation cannot discard them.
- [x] After a confirmed close, wait only for the browser target list to stabilize; never reopen or repeat the external detail read.
- [x] Add safe phase-only diagnostics without logging URLs, HR text, security parameters or candidate content.
- [x] Run focused regressions and a fresh full offline gate; record the final exact-SHA gate in the handoff after commit.
