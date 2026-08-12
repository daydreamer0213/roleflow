# BOSS Background-Silent Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 BOSS 只读详情扫描在不激活 Edge、不中断用户前台工作的条件下安全运行。

**Architecture:** 保留现有精确坐标 CDP 点击和全部身份校验，只从扫描详情路径删除 `Page.bringToFront`。复用 Dashboard 已有的隐藏子进程生命周期，不新增守护框架；正式运行仅通过 SQLite 监控。

**Tech Stack:** Node.js 22、CommonJS、Edge Control/CDP、SQLite、现有 assert smoke tests

## Global Constraints

- 不执行沟通、消息发送或投递。
- 不新开 Edge 窗口或标签，不激活 Edge，不弹出终端。
- 后台点击失败时失败关闭，不回退到 `bringToFront()`、DOM 合成点击、独立详情页或接口直读。
- 不降低岗位覆盖、JD 完整性、访问安全、限速或身份校验。
- 不新增依赖或通用抽象。
- Wave 5 保持暂停。

---

### Task 1: Make pane-detail card switching background-silent

**Files:**
- Modify: `src/adapters/sites/boss.js:1488-1510`
- Modify: `tests/source_acquisition_smoke.js:625-675`
- Test: `tests/source_acquisition_smoke.js`

**Interfaces:**
- Consumes: `browser.clickAt(tabId, { x, y })`, `window.__bossCardActivationPoint(jobId)`, `window.__bossPaneState()`
- Produces: unchanged `readVisiblePaneDetail(tabId, job, signal, assertTabBindings)` return contract

- [ ] **Step 1: Write the failing regression**

Update `visiblePaneTrustedClickOrderSmoke()` so its browser has a `bringToFront()` method that records an unexpected call, but does not use focus as a prerequisite for locating coordinates. Assert:

```js
assert.strictEqual(events.filter((event) => event.type === "bring_to_front").length, 0);
assert.deepStrictEqual(
  events.filter((event) => ["locate", "click_at"].includes(event.type)).map((event) => event.type),
  ["locate", "click_at"]
);
```

Keep the existing assertions that the click occurs once, uses the exact target ID and coordinates, and only succeeds after the pane reports the exact target identity and complete JD.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
& '.runtime\node\node.exe' tests\source_acquisition_smoke.js
```

Expected: FAIL because the production path still calls `bringToFront()`.

- [ ] **Step 3: Implement the minimum production change**

In the `stableOtherSelection && !activationAttempted` branch:

```js
if (typeof this.browser.clickAt !== "function") return null;
```

Delete only:

```js
await this.browser.bringToFront(tabId);
```

Do not change the activation-point validation, single-click rule, post-click tab/search-page checks, identity matching, timeout, pacing, access reservation or outcome recording.

- [ ] **Step 4: Run focused and adjacent tests**

Run:

```powershell
& '.runtime\node\node.exe' tests\source_acquisition_smoke.js
& '.runtime\node\node.exe' tests\browser_transport_smoke.js
& '.runtime\node\node.exe' tests\boss_safe_pacing_smoke.js
```

Expected: all three exit 0.

- [ ] **Step 5: Review the diff**

Verify:

```powershell
git diff --check
git diff -- src/adapters/sites/boss.js tests/source_acquisition_smoke.js
```

Expected: no whitespace errors; no fallback, pacing, identity or communication behavior changed.

- [ ] **Step 6: Commit**

```powershell
git add src/adapters/sites/boss.js tests/source_acquisition_smoke.js
git commit -m "fix: keep BOSS detail scans in background"
```

### Task 2: Verify the hidden process contract and full offline suite

**Files:**
- Modify only if the regression exposes a defect: `tests/dashboard_scan_lifecycle_smoke.js`
- Verify: `src/dashboard/server.js:2227-2242`

**Interfaces:**
- Consumes: `startPlanScan(scanRuns, input)`
- Produces: child spawn options with `windowsHide: true` and piped output

- [ ] **Step 1: Run the existing lifecycle contract**

Run:

```powershell
& '.runtime\node\node.exe' tests\dashboard_scan_lifecycle_smoke.js
```

Expected: PASS. Inspect the harness call and confirm production options contain:

```js
{
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
}
```

- [ ] **Step 2: Add a regression only if the existing test does not assert the options**

If `dashboard_scan_lifecycle_smoke.js` does not currently assert those two fields, add:

```js
assert.strictEqual(call.options.windowsHide, true);
assert.deepStrictEqual(call.options.stdio, ["ignore", "pipe", "pipe"]);
```

Run the test first against a temporary deliberately invalid expectation to prove the assertion executes, restore the exact expectation above, and rerun to PASS. Do not change production code if it already satisfies the contract.

- [ ] **Step 3: Run the full offline suite**

Run:

```powershell
npm.cmd test
```

Expected: all registered offline checks pass.

- [ ] **Step 4: Run final verification**

Run:

```powershell
git diff --check
git status --short
```

Expected: only intentional test changes remain, or the tree is clean if no new test was needed.

- [ ] **Step 5: Commit any test-only strengthening**

If Step 2 changed the lifecycle test:

```powershell
git add tests/dashboard_scan_lifecycle_smoke.js
git commit -m "test: lock hidden scan process options"
```

If no file changed, do not create an empty commit.

### Task 3: Run one silent live calibration before the formal Gate D baseline

**Files:**
- No source changes expected
- Record: `.superpowers/sdd/2026-08-11-wave4-acceptance-remediation/progress.md`
- Update after success: `docs/superpowers/reports/2026-08-11-wave-0-4-live-manual-acceptance-addendum.md`

**Interfaces:**
- Consumes: ordinary logged-in Edge fixed `BOSS-SEARCH` tab, hidden scan lifecycle, SQLite scan records
- Produces: aggregate-only evidence that one background card switch completed without foreground activation

- [ ] **Step 1: Confirm no concurrent scan**

Read process list, `site_scan_leases`, latest `scan_runs` and Dashboard scan state. Do not touch Edge.

Expected: no active BOSS scan and no live lease.

- [ ] **Step 2: Create a disposable one-target calibration baseline**

Use the existing Gate D baseline preparation tool and preserved profile/plan. The calibration database must be separate from the later formal baseline.

Expected: receipt complete, archive hash matches, `quick_check=ok`, foreign-key violations 0, operational tables empty before approved risk-state carryover.

- [ ] **Step 3: Start through the hidden product lifecycle**

Start one target with `windowsHide: true`. Do not use a foreground shell, Codex task loop, new Edge tab/window or `Page.bringToFront`.

- [ ] **Step 4: Monitor only SQLite**

Read heartbeat, target state, observation count and pane-detail result. Do not send messages to another running task and do not inspect Edge while the scan owns it.

Expected: terminal state is recorded by the project; one exact target has a complete JD of at least 120 characters.

- [ ] **Step 5: Apply the foreground-silence gate**

If Edge or Codex is activated, stop and mark the calibration interrupted. If the background click is not accepted, record the exact error and keep Gate D blocked; do not restore `bringToFront()`.

- [ ] **Step 6: Proceed to the formal Gate D scan only after calibration passes**

Create a new empty formal baseline. Do not reuse the calibration database or any interrupted database. Run the complete read-only scan, export once after terminal success, then continue the existing Gate D comparison and final Edge acceptance plan.

