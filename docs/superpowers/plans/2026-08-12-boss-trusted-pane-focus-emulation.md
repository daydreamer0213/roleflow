# BOSS Trusted Pane Focus Emulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep trusted right-pane detail reads reliable while preventing RoleFlow from bringing Edge to the Windows foreground.

**Architecture:** Reuse the browser adapters' existing generic `cdp()` method. In the one non-current-card branch of `readVisiblePaneDetail()`, replace `Page.bringToFront` with a short `Emulation.setFocusEmulationEnabled` window around exact card location and the existing trusted CDP click, then restore hidden-page behavior in `finally`.

**Tech Stack:** Node.js 22, existing CommonJS adapters, Edge Control/CDP, assertion-based smoke tests.

## Global Constraints

- Calibration, formal Gate D, and the current product mainline use only `trusted_pane`.
- Do not pass, enable, repair, validate, optimize, remove, or fall back to `search_page_api`.
- Do not use or fall back to `standalone_detail`.
- Keep the five formal keywords, `maxDetailTotal=220`, JD coverage, identity checks, random pacing, cooldowns, access budgets, checkpoints, and risk stops unchanged.
- Do not communicate, send a message, apply, or perform any other external BOSS write action.
- Keep the fixed numeric Edge tab/window identities and run BOSS operations serially.
- Failed or interrupted calibration/formal databases are permanently excluded from quality evaluation.
- Wave 5 remains paused.

---

### Task 1: Protect the trusted-pane activation contract

**Files:**
- Modify: `tests/source_acquisition_smoke.js`
- Modify: `src/adapters/sites/boss.js`

**Interfaces:**
- Consumes: `browser.cdp(tabId, method, params)`, `browser.clickAt(tabId, point)`, and the existing `readVisiblePaneDetail(tabId, job, signal, assertTabBindings)`.
- Produces: unchanged `readVisiblePaneDetail(...)` return shape with a new internal focus-emulation activation sequence.

- [ ] **Step 1: Write the failing regression expectations**

Update the pane-browser fixture so `cdp()` records
`Emulation.setFocusEmulationEnabled` calls and tracks the emulated focus state.
Keep `bringToFront()` as a trap/recorder so the test can prove it is not used.

Change the trusted-click order expectation to:

```text
focus_enabled
assert_bindings
assert_search
locate
assert_bindings
assert_search
click_at
focus_disabled
assert_bindings
assert_search
```

Assert one enable, one click, one disable, zero `bring_to_front`, and zero
navigation. Update invalid-point and identity-drift checks to require cleanup.
Update the fatal transport cases to cover focus-enable failure, click failure,
focus-disable failure, and click failure followed by successful cleanup.

- [ ] **Step 2: Run the focused suite and verify RED**

Run:

```powershell
& .\.runtime\node\node.exe tests\source_acquisition_smoke.js
```

Expected: FAIL because the production path still calls `bringToFront()` and
does not issue focus-emulation CDP commands.

- [ ] **Step 3: Implement the minimum production change**

In the stable-other-selection branch:

```js
if (typeof this.browser.cdp !== "function"
  || typeof this.browser.clickAt !== "function") {
  return null;
}
try {
  await this.browser.cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
  // Existing binding/page checks, exact point lookup, validation, and click.
} finally {
  await this.browser.cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false });
}
// Existing post-click binding/page checks and pane polling.
```

Do not add an adapter method, fallback, retry, configuration option, or change
outside this activation branch.

- [ ] **Step 4: Verify GREEN and nearby behavior**

Run:

```powershell
& .\.runtime\node\node.exe tests\source_acquisition_smoke.js
& .\.runtime\node\node.exe tests\browser_transport_smoke.js
& .\.runtime\node\node.exe tests\boss_safe_pacing_smoke.js
```

Expected: all exit 0.

- [ ] **Step 5: Run the full offline suite and inspect the diff**

Run:

```powershell
& .\.runtime\node\node.exe tests\run_all.js
git diff --check
git diff -- src/adapters/sites/boss.js tests/source_acquisition_smoke.js
```

Expected: all offline checks pass; the diff contains only the focus-emulation
activation and behavior-level regression updates.

- [ ] **Step 6: Commit**

```powershell
git add src/adapters/sites/boss.js tests/source_acquisition_smoke.js
git commit -m "fix: keep trusted BOSS pane activation in background"
```

### Task 2: Rehearse the product lifecycle on a fresh calibration baseline

**Files:**
- Runtime artifacts only under a new directory in `D:\DevData\RoleFlow-gate-d\calibration`.

**Interfaces:**
- Consumes: the verified source commit, fixed Edge tabs, existing baseline preparation and hidden scan lifecycle.
- Produces: calibration-only database/logs and a foreground-monitor record.

- [ ] **Step 1: Recheck live preconditions**

Verify bridge health, exactly the fixed `BOSS-SEARCH` and
`BOSS-COMMUNICATION` tabs, search login/no-risk state, no scan process, no port
8787 listener, no lease, and no leftover monitor.

- [ ] **Step 2: Create a new empty operational baseline**

Use `scripts/prepare-gate-d-baseline.js` with a new calibration directory.
Confirm `quick_check=ok`, zero foreign-key violations, zero operational job
history, and preserved profile/search-plan/model configuration.

- [ ] **Step 3: Run the smallest product-lifecycle scan**

Start through the project's hidden child-process lifecycle with default
`trusted_pane`, two keywords, and at most three details. Do not pass a
`search_page_api` mode, dispatch a subtask, send task messages, or operate Edge
concurrently. Monitor Windows foreground independently.

- [ ] **Step 4: Accept or stop**

Require complete JD reads, successful trusted-pane outcomes, fixed-tab
integrity, no login/risk/page-loss signal, no new tab/window, zero
`Page.bringToFront`, and no Edge foreground transition. Mark this database
calibration-only regardless of success.

### Task 3: Complete formal Gate D and Wave 4 acceptance

**Files:**
- Runtime/evaluation artifacts under a separate new directory in `D:\DevData\RoleFlow-gate-d\baseline`.
- Final report under `docs/superpowers/reports/`.

**Interfaces:**
- Consumes: passed Task 2 evidence, five-keyword daily plan, current profile/model settings, and the existing Gate D exporter.
- Produces: one terminal formal baseline, one evaluation export, read-only UI acceptance evidence, and the final Wave 4 closeout report.

- [ ] **Step 1: Create a separate fresh formal baseline**

Never reuse a calibration, pre-baseline, failed, or interrupted database.

- [ ] **Step 2: Run complete daily Gate D**

Use only `trusted_pane`, all five formal keywords, and
`maxDetailTotal=220`. Run serially through the hidden project lifecycle and
monitor the exact process/SQLite state without touching Edge.

- [ ] **Step 3: Confirm a real terminal state**

Verify run, batch, and every target terminal state; process exit; lease
release; database integrity; raw/unique job totals; complete JD count; detail
success/failure codes; and analysis status distribution.

- [ ] **Step 4: Export once and evaluate**

After terminal confirmation, run `scripts/export-gate-d-evaluation.js` exactly
once. Evaluate job coverage, complete JD coverage, trusted-pane outcomes,
analysis states, the formal two-dimensional matrix, and shadow scorecard
distribution. Do not mix any other database into the sample.

- [ ] **Step 5: Perform read-only Edge acceptance**

Inspect Dashboard, automatic-communication entry, and message page. Verify the
known UI corrections and current states without clicking communication,
sending, or applying.

- [ ] **Step 6: Publish and verify the closeout**

Record only currently reproducible defects that affect results, safety, or
experience; keep deferred improvements separate; record the unresolved license
choice without blocking other work; run final verification; and keep Wave 5
paused.
