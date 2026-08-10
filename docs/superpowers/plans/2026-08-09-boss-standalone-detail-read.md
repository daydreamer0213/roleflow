# BOSS Standalone Detail Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unreliable BOSS left-card activation with identity-verified visible-pane reuse plus serial standalone-detail navigation, preserving access budgets, resumable checkpoints, and no-communication safety.

**Architecture:** `BossSiteAdapter` freezes each search target's card URLs before leaving the list page. It may reuse the already-visible pane once when the pane exposes the exact expected job ID; every other selected job is opened serially in the same fixed `BOSS-SEARCH` tab through the existing standalone-detail path. Access accounting distinguishes `visible_pane` from `standalone_detail`, and budget exhaustion checkpoints unfinished jobs without misclassifying them as failed.

**Tech Stack:** Node.js 22+ CommonJS, built-in `node:assert`, existing fake-browser smoke tests, Node SQLite, Git worktrees, Microsoft Edge CDP.

## Global Constraints

- Work only in `D:\DevData\RoleFlow-readonly-scan-20260809-v1` on `codex/boss-pane-switch-repair`.
- The implementation baseline is `main@109d6acd5f10ea27a139ee9a4d4fd6d0c79f15c1`; the approved design commit is `75d373c`.
- Do not execute BOSS communication, application, send, apply, or first-conversation-row actions.
- Continue using one logged-in Edge session, one window, and exactly two fixed BOSS tabs.
- Do not create per-job tabs, a second BOSS session, or parallel browser work.
- Do not use `BOSS-COMMUNICATION` for detail acquisition.
- Do not increase or relabel the existing `detail_open` access budgets.
- Do not reduce keyword, card, JD, or recommendation-quality targets; preserve unfinished work for resume.
- Every accepted detail must have an exact URL-derived job ID match. A title match alone never authorizes reuse.
- Standalone detail URLs must use HTTPS and normalize to `www.zhipin.com` or another `zhipin.com` subdomain before navigation.
- Risk, login loss, target mismatch, checkpoint loss, lease loss, browser timeout, and browser disconnect remain fail-closed.
- Offline tests must not access BOSS, a browser, a real model endpoint, or formal model credentials.
- Never read or write `D:\Guo\ZhiPing\data\jobs.sqlite*`.
- Do not modify matching rules, prompts, model selection, recommendation thresholds, or communication code.
- Project tab grouping remains a separate follow-up plan; this plan does not add an extension or browser-tab UI automation.
- Before every commit, run the focused tests and `git diff --check`.
- Before completion or merge, use `requesting-code-review` and `verification-before-completion`.

## File Structure

- `src/adapters/sites/boss.js`
  - Owns visible-pane extraction, strict standalone-detail navigation, scan routing, fatal error handling, and detail result mode.
- `src/core/site_access_usage.js`
  - Defines the shared classification of BOSS detail-access actions so CLI and Dashboard cannot drift.
- `src/cli.js`
  - Aggregates workflow access usage and persists privacy-safe detail outcome fields.
- `src/dashboard/server.js`
  - Uses the shared detail-action classification for daily workflow budget display.
- `tests/source_acquisition_smoke.js`
  - Covers exact pane identity, no-click routing, strict standalone loading, serial navigation, fatal stops, and budget-resumable target output.
- `tests/site_access_usage_smoke.js`
  - Covers shared action classification without browser or database access.
- `tests/workflow_scan_smoke.js`
  - Covers CLI usage totals and privacy-safe `accessMode` persistence.
- `tests/workflow_dashboard_smoke.js`
  - Protects Dashboard daily usage aggregation from omitting standalone detail opens.
- `tests/run_all.js`
  - Registers the new shared-usage smoke test.

---

### Task 1: Make visible-pane and standalone-detail readers fail closed

**Files:**
- Modify: `src/adapters/sites/boss.js:147-213`
- Modify: `src/adapters/sites/boss.js:1072-1205`
- Modify: `tests/source_acquisition_smoke.js:74-105`
- Modify: `tests/source_acquisition_smoke.js:426-540`

**Interfaces:**
- Produces: `BossSiteAdapter.readVisiblePaneDetail(tabId, job, signal = null): Promise<Detail|null>`.
- Produces: `BossSiteAdapter.readDetail(tabId, url, signal = null): Promise<Detail>`.
- `Detail` is `{ description, bossActiveText, salary, experience, education }`.
- `readVisiblePaneDetail` returns `null` for missing/mismatched job ID or an incomplete pane after bounded retries.
- `readDetail` throws `BOSS_DETAIL_LOAD_TIMEOUT` after bounded retries; it never returns an empty detail object.
- Consumed by: Task 2 scan routing.

- [ ] **Step 1: Replace the click-oriented pane smoke tests with failing identity tests**

In the top-level async test sequence, replace:

```js
await paneSwitchSmoke();
await leftCardMetadataAvoidsPaneScrollSmoke();
```

with:

```js
await visiblePaneIdentitySmoke();
await visiblePaneMissingIdentitySmoke();
await standaloneDetailTimeoutSmoke();
```

Replace the two old functions with these focused tests:

```js
async function visiblePaneIdentitySmoke() {
  const accessActions = [];
  let paneReads = 0;
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) {
        return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      }
      if (expression.includes("window.__bossPaneState()")) {
        paneReads += 1;
        return {
          currentJobId: "pane-job",
          title: "AI application developer",
          description: "Complete Python RAG Agent job description ".repeat(12),
          bossActiveText: "今日活跃",
          salary: "10-15K",
          experience: "1-3年",
          education: "本科",
          canScroll: false
        };
      }
      return true;
    }
  };
  const adapter = new BossSiteAdapter({
    browser,
    sleepFn: async () => {},
    randomFn: () => 0,
    accessController: {
      reserve: async (action, details) => accessActions.push({ action, details })
    }
  });
  const detail = await adapter.readVisiblePaneDetail("pane-tab", {
    title: "AI application developer",
    url: "https://www.zhipin.com/job_detail/pane-job.html"
  });
  assert(detail.description.length >= 120);
  assert.strictEqual(paneReads, 1);
  assert.deepStrictEqual(accessActions.map((item) => item.action), ["pane_detail_read"]);
}

async function visiblePaneMissingIdentitySmoke() {
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) {
        return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      }
      if (expression.includes("window.__bossPaneState()")) {
        return {
          currentJobId: "",
          title: "pane-job",
          description: "Complete Python RAG Agent job description ".repeat(12),
          canScroll: false
        };
      }
      return true;
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  const detail = await adapter.readVisiblePaneDetail("pane-tab", {
    title: "pane-job",
    url: "https://www.zhipin.com/job_detail/pane-job.html"
  });
  assert.strictEqual(detail, null, "title-only identity must not authorize pane reuse");
}

async function standaloneDetailTimeoutSmoke() {
  const navigations = [];
  const browser = {
    async navigate(_tabId, url) { navigations.push(url); },
    async evalValue(_tabId, expression) {
      if (expression.includes("const currentJobId")) {
        return {
          currentJobId: "strict-timeout",
          description: "short",
          bossActiveText: "",
          salary: "",
          experience: "",
          education: ""
        };
      }
      return true;
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertDetailPage = async () => ({ jobId: "strict-timeout" });
  await assert.rejects(
    () => adapter.readDetail("detail-tab", "https://www.zhipin.com/job_detail/strict-timeout.html"),
    (error) => error.code === "BOSS_DETAIL_LOAD_TIMEOUT"
  );
  assert.deepStrictEqual(navigations, ["https://www.zhipin.com/job_detail/strict-timeout.html"]);
  await assert.rejects(
    () => adapter.readDetail("detail-tab", "https://example.invalid/job_detail/external.html"),
    (error) => error.code === "BOSS_DETAIL_URL_INVALID"
  );
  await assert.rejects(
    () => adapter.readDetail("detail-tab", "http://www.zhipin.com/job_detail/insecure.html"),
    (error) => error.code === "BOSS_DETAIL_URL_INVALID"
  );
  assert.deepStrictEqual(
    navigations,
    ["https://www.zhipin.com/job_detail/strict-timeout.html"],
    "an external host must be rejected before browser navigation"
  );
}
```

- [ ] **Step 2: Run the focused source test and confirm RED**

Run:

```powershell
node tests/source_acquisition_smoke.js
```

Expected: FAIL because `readVisiblePaneDetail` does not exist, `readDetail` still returns an empty object after timeout, and `normalizeBossUrl` still accepts an external host.

- [ ] **Step 3: Remove card activation and implement strict readers**

Delete `window.__bossOpenCard` from `PAGE_HELPERS`. Keep `__bossPaneState` and `__bossScrollPane` because the exact already-visible pane can still be read without a click.

Replace `readCardDetail` with:

```js
async readVisiblePaneDetail(tabId, job, signal = null) {
  throwIfAborted(signal);
  await this.assertSearchPage(tabId);
  await this.browser.evalValue(tabId, PAGE_HELPERS);
  const expectedJobId = (normalizeBossUrl(job?.url || "")
    .match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
  if (!expectedJobId) return null;
  await this.reserveAccess("pane_detail_read", {
    jobId: expectedJobId,
    title: job?.title || "",
    url: job?.url || ""
  });
  let scrolled = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    throwIfAborted(signal);
    await this.assertSearchPage(tabId);
    await this.browser.evalValue(tabId, PAGE_HELPERS);
    const detail = await this.browser.evalValue(tabId, "(() => window.__bossPaneState())()");
    if (!detail?.currentJobId || detail.currentJobId !== expectedJobId) return null;
    const titleMatches = normalizedComparableText(detail.title)
      .includes(normalizedComparableText(job?.title));
    if (!titleMatches) return null;
    if (detail.description?.length >= 120) {
      await this.browser.evalValue(tabId, "(() => window.__bossScrollPane(true))()");
      return {
        description: cleanDetailText(detail.description),
        bossActiveText: parseBossActivityText(detail.bossActiveText),
        salary: detail.salary || "",
        experience: detail.experience || "",
        education: detail.education || ""
      };
    }
    if (!scrolled && detail.canScroll) {
      scrolled = true;
      await this.browser.evalValue(tabId, "(() => window.__bossScrollPane(false))()");
    }
    await this.waitWithPacing("card_retry");
  }
  await this.browser.evalValue(tabId, "(() => window.__bossScrollPane(true))()");
  return null;
}
```

Change `readDetail` to accept `signal`, call `throwIfAborted(signal)` before navigation and each retry, retain exact `assertDetailPage(tabId, expectedJobId)`, and replace its final empty return with:

```js
throw bossError(
  "BOSS_DETAIL_LOAD_TIMEOUT",
  `BOSS standalone detail did not become complete for ${expectedJobId || "unknown"}`
);
```

Tighten `normalizeBossUrl` before using it for navigation or identity:

```js
const parsed = new URL(value, "https://www.zhipin.com");
if (parsed.protocol !== "https:" || !/(^|\.)zhipin\.com$/i.test(parsed.hostname)) return "";
```

At the beginning of `readDetail`, navigate only the normalized value:

```js
const normalizedUrl = normalizeBossNavigationUrl(url);
const expectedJobId = (normalizeBossUrl(normalizedUrl)
  .match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
if (!normalizedUrl || !expectedJobId) {
  throw bossError("BOSS_DETAIL_URL_INVALID", "BOSS standalone detail URL is invalid.");
}
await this.navigateWithPacing(tabId, normalizedUrl, "detail");
```

Do not weaken `assertDetailPage`; an ID mismatch remains `BOSS_DETAIL_PAGE_LOST`.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
node tests/source_acquisition_smoke.js
git diff --check
```

Expected: `source_acquisition_smoke ok`; `git diff --check` returns no output.

- [ ] **Step 5: Commit the reader task**

Run:

```powershell
git add src/adapters/sites/boss.js tests/source_acquisition_smoke.js
git commit -m "fix: make BOSS detail readers identity strict"
```

---

### Task 2: Route frozen scan jobs through the strict readers

**Files:**
- Modify: `src/adapters/sites/boss.js:629-895`
- Modify: `tests/source_acquisition_smoke.js:74-105`
- Modify: `tests/source_acquisition_smoke.js:1035-1165`

**Interfaces:**
- Consumes: Task 1 `readVisiblePaneDetail` and `readDetail`.
- Produces: `onDetailResult({ outcome, errorCode, accessMode })`.
- `accessMode` is exactly `visible_pane` or `standalone_detail`.
- Behavior: one visible-pane probe at most per search target; all remaining selected jobs use serial standalone navigation.

- [ ] **Step 1: Add a failing scan-routing test**

Add this call to the top-level sequence immediately after the Task 1 tests:

```js
await standaloneDetailRoutingSmoke();
```

Add:

```js
async function standaloneDetailRoutingSmoke() {
  const listNavigations = [];
  const detailUrls = [];
  const outcomes = [];
  let visiblePaneReads = 0;
  const browser = {
    async navigate(_tabId, url) { listNavigations.push(url); }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [card("direct-1"), card("direct-2")];
  adapter.readVisiblePaneDetail = async () => {
    visiblePaneReads += 1;
    return null;
  };
  adapter.readDetail = async (_tabId, url) => {
    detailUrls.push(url);
    return {
      description: `Complete standalone detail ${url} `.repeat(12),
      bossActiveText: "今日活跃",
      salary: "10-15K",
      experience: "1-3年",
      education: "本科"
    };
  };
  adapter.readCardDetail = async () => {
    throw new Error("legacy card activation must not run");
  };
  const jobs = await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["direct"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 2,
    onDetailResult: async (result) => outcomes.push(result)
  });
  assert.strictEqual(visiblePaneReads, 1);
  assert.deepStrictEqual(detailUrls, [
    "https://www.zhipin.com/job_detail/direct-1.html",
    "https://www.zhipin.com/job_detail/direct-2.html"
  ]);
  assert.strictEqual(listNavigations.filter((url) => url.includes("/web/geek/jobs")).length, 1);
  assert.strictEqual(jobs.filter((job) => job.detailRead).length, 2);
  assert.deepStrictEqual(outcomes, [
    { outcome: "succeeded", errorCode: "", accessMode: "standalone_detail" },
    { outcome: "succeeded", errorCode: "", accessMode: "standalone_detail" }
  ]);
}
```

Update the existing detail dedupe and audit tests to stub `readVisiblePaneDetail` and `readDetail`, not `readCardDetail`. Their expected nonfatal timeout code becomes `BOSS_DETAIL_LOAD_TIMEOUT`, and every expected outcome includes `accessMode`.

- [ ] **Step 2: Run the source test and confirm RED**

Run:

```powershell
node tests/source_acquisition_smoke.js
```

Expected: FAIL because `scanBrowser` still calls legacy `readCardDetail` and does not emit `accessMode`.

- [ ] **Step 3: Implement one-probe-per-target serial routing**

Immediately before the detail-entry loop, initialize:

```js
let visiblePaneProbeAvailable = true;
```

Replace the detail read inside the loop with this shape:

```js
let accessMode = "standalone_detail";
let detailOutcome = {
  outcome: "succeeded",
  errorCode: "",
  accessMode
};
try {
  let detail = null;
  if (visiblePaneProbeAvailable) {
    visiblePaneProbeAvailable = false;
    accessMode = "visible_pane";
    detail = await this.readVisiblePaneDetail(tabId, entry.job, options.signal);
  }
  if (!detail) {
    accessMode = "standalone_detail";
    detail = await this.readDetail(tabId, entry.job.url, options.signal);
  }
  throwIfAborted(options.signal);
  detailOutcome = { outcome: "succeeded", errorCode: "", accessMode };
  const detailedJob = normalizeBossJob({
    ...entry.job,
    description: detail.description,
    salary: detail.salary || entry.job.salary || "",
    experience: detail.experience || entry.job.experience || "",
    education: detail.education || entry.job.education || "",
    bossActiveText: detail.bossActiveText || entry.job.bossActiveText || "",
    detailRequired: true,
    detailRead: true
  });
  detailedJob.detailRequired = true;
  mergeScanCandidate(candidates, { ...entry, job: detailedJob });
  detailsRead += 1;
  await this.waitAfterDetailAction();
} catch (error) {
  // Task 3 adds the budget-pending distinction here.
  detailsFailed += 1;
  const failedJob = {
    ...entry.job,
    detailRequired: true,
    detailRead: false,
    detailErrorCode: error?.code || "BOSS_DETAIL_LOAD_TIMEOUT"
  };
  mergeScanCandidate(candidates, { ...entry, job: failedJob });
  const failedOutcome = {
    outcome: "failed",
    errorCode: error?.code || "BOSS_DETAIL_LOAD_TIMEOUT",
    accessMode
  };
  if (isFatalBrowserError(error)) {
    try {
      await emitDetailResult(options.onDetailResult, failedOutcome);
    } catch {
      // Audit failure must not replace a fatal browser/access error.
    }
    throw error;
  }
  await this.waitAfterDetailAction();
  detailOutcome = failedOutcome;
}
await emitDetailResult(options.onDetailResult, detailOutcome);
```

Change user-facing scan text from “读右栏” to “读详情”. Delete the now-unused `readCardDetail` method and ensure `rg "__bossOpenCard|readCardDetail" src tests` returns no production call.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
node tests/source_acquisition_smoke.js
rg -n "__bossOpenCard|readCardDetail" src tests
git diff --check
```

Expected:

- `source_acquisition_smoke ok`;
- `rg` returns no matches, with exit code 1 because the legacy names are gone;
- `git diff --check` returns no output.

- [ ] **Step 5: Commit the routing task**

Run:

```powershell
git add src/adapters/sites/boss.js tests/source_acquisition_smoke.js
git commit -m "fix: read frozen BOSS jobs through standalone details"
```

---

### Task 3: Preserve budget-exhausted jobs as resumable pending work

**Files:**
- Modify: `src/adapters/sites/boss.js:747-895`
- Modify: `tests/source_acquisition_smoke.js:74-105`
- Modify: `tests/source_acquisition_smoke.js:660-730`

**Interfaces:**
- Consumes: Task 2 scan routing.
- Produces: failed target checkpoints whose unvisited jobs remain `detailRead: false` with no false per-job failure code.
- Produces: scan summary `fatalErrorCode: "BOSS_ACCESS_BUDGET_EXHAUSTED"`.
- Preserves: `error.retryAt` on the fatal error object and its existing retry time in `error.message`, which the tracked scan stores as its stop message.

- [ ] **Step 1: Add a failing budget-resume checkpoint test**

Add to the top-level sequence:

```js
await detailBudgetCheckpointSmoke();
```

Add:

```js
async function detailBudgetCheckpointSmoke() {
  const checkpoints = [];
  const summaries = [];
  const outcomes = [];
  let detailCalls = 0;
  const browser = {
    async navigate() {}
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [
    card("budget-complete"),
    card("budget-pending"),
    card("budget-unvisited")
  ];
  adapter.readVisiblePaneDetail = async () => null;
  adapter.readDetail = async () => {
    detailCalls += 1;
    if (detailCalls === 1) {
      return {
        description: "Complete detail before budget stop ".repeat(12),
        bossActiveText: "今日活跃"
      };
    }
    throw Object.assign(new Error("daily detail budget exhausted; resume at 2026-08-10T00:00:00.000Z"), {
      code: "BOSS_ACCESS_BUDGET_EXHAUSTED",
      retryAt: "2026-08-10T00:00:00.000Z"
    });
  };
  await assert.rejects(() => adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["budget"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 3,
    onTargetComplete: async (result) => checkpoints.push(result),
    onDetailResult: async (result) => outcomes.push(result),
    onScanComplete: async (summary) => summaries.push(summary)
  }), (error) => error.code === "BOSS_ACCESS_BUDGET_EXHAUSTED"
    && error.retryAt === "2026-08-10T00:00:00.000Z");

  assert.strictEqual(detailCalls, 2);
  assert.strictEqual(checkpoints.length, 1);
  assert.strictEqual(checkpoints[0].status, "failed");
  const byTitle = new Map(checkpoints[0].jobs.map((job) => [job.title, job]));
  assert.strictEqual(byTitle.get("budget-complete").detailRead, true);
  assert.strictEqual(byTitle.get("budget-pending").detailRead, false);
  assert.strictEqual(byTitle.get("budget-pending").detailErrorCode || "", "");
  assert.strictEqual(byTitle.get("budget-unvisited").detailRead, false);
  assert.strictEqual(byTitle.get("budget-unvisited").detailErrorCode || "", "");
  assert.strictEqual(summaries[0].fatalErrorCode, "BOSS_ACCESS_BUDGET_EXHAUSTED");
  assert.match(summaries[0].fatalErrorMessage, /2026-08-10T00:00:00\.000Z/);
  assert.deepStrictEqual(outcomes.at(-1), {
    outcome: "failed",
    errorCode: "BOSS_ACCESS_BUDGET_EXHAUSTED",
    accessMode: "standalone_detail"
  });
}
```

- [ ] **Step 2: Run the source test and confirm RED**

Run:

```powershell
node tests/source_acquisition_smoke.js
```

Expected: FAIL because the current catch path increments `detailsFailed` and stores `BOSS_ACCESS_BUDGET_EXHAUSTED` as a per-job detail failure.

- [ ] **Step 3: Distinguish access-pending from actual detail failure**

In the Task 2 catch block:

```js
const accessPending = error?.code === "BOSS_ACCESS_BUDGET_EXHAUSTED";
if (!accessPending) {
  detailsFailed += 1;
  const failedJob = {
    ...entry.job,
    detailRequired: true,
    detailRead: false,
    detailErrorCode: error?.code || "BOSS_DETAIL_LOAD_TIMEOUT"
  };
  mergeScanCandidate(candidates, { ...entry, job: failedJob });
}
const failedOutcome = {
  outcome: "failed",
  errorCode: error?.code || "BOSS_DETAIL_LOAD_TIMEOUT",
  accessMode
};
```

Do not wrap or replace the fatal error; its `retryAt`, `action`, `limit`, and usage fields must reach the caller unchanged. Keep `onTargetComplete` before the fatal loop break so the CLI's existing `checkpointScanTarget` callback persists the current target and its jobs.

- [ ] **Step 4: Run focused recovery tests and confirm GREEN**

Run:

```powershell
node tests/source_acquisition_smoke.js
node tests/scan_recovery_smoke.js
node tests/scan_end_to_end_recovery_smoke.js
git diff --check
```

Expected: all four commands succeed; no browser or network access occurs.

- [ ] **Step 5: Commit the recovery task**

Run:

```powershell
git add src/adapters/sites/boss.js tests/source_acquisition_smoke.js
git commit -m "fix: preserve budget-limited BOSS detail work"
```

---

### Task 4: Unify detail usage accounting and privacy-safe outcome audit

**Files:**
- Create: `src/core/site_access_usage.js`
- Modify: `src/cli.js:1715-1740`
- Modify: `src/dashboard/server.js:1406-1421`
- Create: `tests/site_access_usage_smoke.js`
- Modify: `tests/workflow_scan_smoke.js:83-110`
- Modify: `tests/workflow_dashboard_smoke.js:895-903`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces: `isBossDetailAccessAction(action): boolean`.
- Accepted detail actions: `pane_detail_read`, `detail_open`.
- Produces: persisted detail result fields `{ batchId, outcome, errorCode, accessMode }`.
- Accepted result modes: `visible_pane`, `standalone_detail`; all other values persist as `unknown`.
- Consumed by: CLI workflow metrics and Dashboard daily workflow metrics.

- [ ] **Step 1: Add failing shared-classification and persistence tests**

Create `tests/site_access_usage_smoke.js`:

```js
const assert = require("node:assert/strict");
const { isBossDetailAccessAction } = require("../src/core/site_access_usage");

assert.strictEqual(isBossDetailAccessAction("pane_detail_read"), true);
assert.strictEqual(isBossDetailAccessAction("detail_open"), true);
assert.strictEqual(isBossDetailAccessAction("pane_detail_result"), false);
assert.strictEqual(isBossDetailAccessAction("communication_visit"), false);
assert.strictEqual(isBossDetailAccessAction(""), false);

console.log("site_access_usage_smoke ok");
```

Add `"site_access_usage_smoke.js"` to `tests/run_all.js` immediately after `site_access_budget_smoke.js`.

In `tests/workflow_scan_smoke.js`, seed one `detail_open` event in addition to the existing two `pane_detail_read` events and change the expected usage to:

```js
{ details: 3, pages: 1, scrolls: 1 }
```

Pass:

```js
accessMode: "standalone_detail"
```

to `persistDetailOutcome`, and expect the stored event to include:

```js
accessMode: "standalone_detail"
```

Then persist a second result with `accessMode: "must-not-persist"` and private fields. Assert its stored mode is `unknown` and neither event JSON contains the private values.

In `tests/workflow_dashboard_smoke.js`, replace one of the four seeded `pane_detail_read` actions with `detail_open` so the existing daily budget/render flow proves both action types remain counted.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```powershell
node tests/site_access_usage_smoke.js
node tests/workflow_scan_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected:

- the new module import fails;
- workflow usage still reports 2 details instead of 3;
- persisted outcome lacks `accessMode`.

- [ ] **Step 3: Add the shared classifier and wire both consumers**

Create `src/core/site_access_usage.js`:

```js
const BOSS_DETAIL_ACCESS_ACTIONS = new Set([
  "pane_detail_read",
  "detail_open"
]);

function isBossDetailAccessAction(action) {
  return BOSS_DETAIL_ACCESS_ACTIONS.has(String(action || ""));
}

module.exports = {
  isBossDetailAccessAction
};
```

Import `isBossDetailAccessAction` in `src/cli.js` and `src/dashboard/server.js`.

In `workflowAccessUsage` and `workflowRunsWithAccessUsage`, replace direct
`event.action === "pane_detail_read"` checks with:

```js
if (isBossDetailAccessAction(event.action)) usage.details += 1;
```

Allow `detail_open` through the Dashboard event-action filter.

Sanitize result mode in `persistDetailOutcome`:

```js
const accessMode = ["visible_pane", "standalone_detail"].includes(result?.accessMode)
  ? result.accessMode
  : "unknown";
```

Persist only:

```js
{
  batchId: Number(batchId),
  outcome: succeeded ? "succeeded" : "failed",
  errorCode: succeeded ? "" : String(result?.errorCode || "BOSS_DETAIL_LOAD_TIMEOUT"),
  accessMode
}
```

Do not persist title, company, URL, JD, `errorMessage`, or arbitrary result fields.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
node tests/site_access_usage_smoke.js
node tests/workflow_scan_smoke.js
node tests/workflow_dashboard_smoke.js
git diff --check
```

Expected: all tests report `ok`; diff check is silent.

- [ ] **Step 5: Commit the accounting task**

Run:

```powershell
git add src/core/site_access_usage.js src/cli.js src/dashboard/server.js tests/site_access_usage_smoke.js tests/workflow_scan_smoke.js tests/workflow_dashboard_smoke.js tests/run_all.js
git commit -m "fix: count standalone BOSS detail access"
```

---

### Task 5: Verify offline behavior, review the branch, and run bounded read-only acceptance

**Files:**
- Verify: all files modified by Tasks 1-4

**Interfaces:**
- Consumes: complete repair branch from Tasks 1-4.
- Produces: aggregate verification evidence in the task handoff: commit IDs, command results, tab counts, access-mode counts, error-code counts, and database integrity results.
- The handoff includes no job titles, companies, URLs, JD text, resume text, prompt text, model output, API keys, cookies, or browser credentials.

- [ ] **Step 1: Run the complete offline verification gate**

Run serially:

```powershell
git status --short --branch
git diff --check main...HEAD
node tests/source_acquisition_smoke.js
node tests/site_access_usage_smoke.js
node tests/workflow_scan_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/scan_recovery_smoke.js
node tests/scan_end_to_end_recovery_smoke.js
npm.cmd test
```

Expected:

- worktree is clean;
- diff check is silent;
- focused tests report `ok`;
- full suite reports every offline check passing.

- [ ] **Step 2: Request independent code review**

Use `requesting-code-review` against:

```text
base: main@109d6acd5f10ea27a139ee9a4d4fd6d0c79f15c1
head: git rev-parse HEAD
spec: docs/superpowers/specs/2026-08-09-boss-standalone-detail-read-and-tab-group-design.md
plan: docs/superpowers/plans/2026-08-09-boss-standalone-detail-read.md
```

Review must explicitly check:

- no BOSS communication/application path changed;
- no title-only identity fallback;
- no per-job tabs or parallel detail access;
- `detail_open` is not relabeled as pane access;
- budget exhaustion preserves pending jobs and `retryAt`;
- fatal browser/risk errors remain fail-closed;
- outcome audit stores only allowlisted fields;
- tests prove old card-click routing fails.

Resolve every Critical or Important finding, rerun Step 1, and commit each remediation before live acceptance.

- [ ] **Step 3: Create isolated database and Git checkpoints**

Record formal DB hashes without opening the database:

```powershell
$formalFiles = @(
  'D:\Guo\ZhiPing\data\jobs.sqlite',
  'D:\Guo\ZhiPing\data\jobs.sqlite-wal',
  'D:\Guo\ZhiPing\data\jobs.sqlite-shm'
)
$formalBefore = $formalFiles | ForEach-Object {
  if (Test-Path -LiteralPath $_) {
    [pscustomobject]@{ Path = $_; Hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }
  }
}
$formalBefore | ConvertTo-Json -Compress
```

Create a new acceptance database from the pre-broad-scan checkpoint:

```powershell
$acceptanceRoot = 'D:\DevData\RoleFlow-boss-detail-acceptance-20260809-v1'
if (Test-Path -LiteralPath $acceptanceRoot) {
  throw "Acceptance root already exists: $acceptanceRoot"
}
New-Item -ItemType Directory -Path $acceptanceRoot | Out-Null
Copy-Item -LiteralPath 'D:\DevData\RoleFlow-fresh-baseline-20260809-v1\checkpoint-04-pre-broad-scan\jobs.sqlite' -Destination (Join-Path $acceptanceRoot 'jobs.sqlite')
```

Create the pre-live branch checkpoint:

```powershell
$repairHead = git rev-parse HEAD
$checkpoint = 'checkpoint/pre-live-boss-detail-acceptance-20260809'
if (git show-ref --verify --quiet "refs/tags/$checkpoint") {
  throw "Checkpoint already exists: $checkpoint"
}
git tag -a $checkpoint $repairHead -m 'Checkpoint before standalone BOSS detail live acceptance'
```

- [ ] **Step 4: Verify the fixed browser boundary before scanning**

Use the current logged-in portable Edge without creating or closing tabs:

```powershell
node -e "const {CdpBrowserAdapter}=require('./src/adapters/browser/cdp'); (async()=>{const tabs=(await new CdpBrowserAdapter({port:9222}).listTabs()).filter(t=>/zhipin\\.com/i.test(t.url)); console.log(tabs.map(t=>({id:t.id,windowId:t.windowId,path:new URL(t.url).pathname}))); if(tabs.length!==2||new Set(tabs.map(t=>t.windowId)).size!==1)process.exit(2)})().catch(e=>{console.error(e.code||e.message);process.exit(1)})"
```

Expected:

- exactly two BOSS tabs;
- both have the same reliable `windowId`;
- one path is `/web/geek/jobs`;
- no login, risk-control, or page-loss signal is present.

Do not click, communicate, apply, send, create a tab, or open another window.

- [ ] **Step 5: Run the bounded read-only scan**

From the repair worktree:

```powershell
$acceptanceDb = 'D:\DevData\RoleFlow-boss-detail-acceptance-20260809-v1\jobs.sqlite'
node src/cli.js scan --db $acceptanceDb --plan 1 --site boss --browser portable --cdp-port 9222 --scan-mode broad --keywords "RAG,Agent" --max-cards 10 --max-detail-total 6 --browser-page-budget 20 --model-settings-root D:\Guo\ZhiPing
```

Expected:

- scan remains serial and read-only;
- at least one non-default job succeeds through `standalone_detail`;
- no new BOSS tab or window appears;
- no communication or application action is reserved or executed;
- any login, risk, target mismatch, or page-loss signal stops the run immediately.

- [ ] **Step 6: Verify aggregate acceptance evidence**

Read only aggregate, redacted counters from the acceptance database:

```powershell
node -e "const {openDb}=require('./src/core/storage'); const db=openDb('D:/DevData/RoleFlow-boss-detail-acceptance-20260809-v1/jobs.sqlite'); const q=(sql)=>db.prepare(sql).all(); console.log({integrity:db.prepare('pragma quick_check').get(),actions:q('select action,count(*) count from site_access_events group by action order by action'),outcomes:q(\"select json_extract(details_json,'$.accessMode') access_mode,json_extract(details_json,'$.outcome') outcome,json_extract(details_json,'$.errorCode') error_code,count(*) count from site_access_events where action='pane_detail_result' group by access_mode,outcome,error_code order by access_mode,outcome,error_code\")}); db.close();"
```

Re-run the Step 4 tab check. Recompute `$formalBefore` using the Step 3 script and compare every path/hash pair for exact equality.

Acceptance passes only when:

- `quick_check` is `ok`;
- `standalone_detail/succeeded` count is at least 1;
- non-default details are no longer systematically all failed;
- risk/login/page-loss counts are zero;
- exactly two same-window BOSS tabs remain;
- formal DB hashes are unchanged.

- [ ] **Step 7: Merge with a new main checkpoint and verify again**

In `D:\Guo\ZhiPing`:

```powershell
git status --short --branch
$mainHead = git rev-parse HEAD
$checkpoint = 'checkpoint/pre-merge-phase-2-boss-detail-20260809'
if (git show-ref --verify --quiet "refs/tags/$checkpoint") {
  throw "Checkpoint already exists: $checkpoint"
}
git tag -a $checkpoint $mainHead -m 'Checkpoint before phase 2 BOSS detail repair merge'
git merge --no-ff codex/boss-pane-switch-repair -m "merge: repair BOSS standalone detail reads"
npm.cmd test
git status --short --branch
```

Expected:

- checkpoint tag points to the pre-merge `main`;
- merge completes without conflicts;
- full offline suite passes on merged `main`;
- `main` is clean and ahead of `origin/main`;
- repair worktree remains registered and is not deleted in this task.

## Post-Merge Broad Baseline

After the phase-2 merge, restore a new database copy from
`D:\DevData\RoleFlow-fresh-baseline-20260809-v1\checkpoint-04-pre-broad-scan`
and run the original five-keyword broad plan. If `detail_open` reaches its unchanged safety limit, preserve
the checkpoint and resume after `retryAt`; do not raise the limit or lower card/JD coverage. The broad
baseline is complete only when every planned job has a verified detail, an explicit stable failure, or a
documented safety-limit terminal state.
