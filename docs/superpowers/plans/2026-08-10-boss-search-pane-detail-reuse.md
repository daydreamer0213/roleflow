# BOSS Search Pane Detail Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make normal BOSS scans activate each exact search-page card and wait for the matching right-pane JD without automatically opening standalone detail pages.

**Architecture:** Extend the existing page helpers with one exact-ID Vue activation function and split active-card, component-current, and pane DOM identities. Extend `readVisiblePaneDetail()` to activate once and poll existing pane state, then route every normal scan detail through that method with no standalone fallback.

**Tech Stack:** Node.js CommonJS, existing Edge/CDP browser adapter, existing smoke-test runner, no new dependencies.

## Global Constraints

- Keep one fixed `BOSS-SEARCH` tab; create no tabs or windows.
- Do not perform any additional real BOSS click during implementation.
- Use exact job IDs for activation and pane authorization; title/index are not activation fallbacks.
- A target receives at most one component activation call.
- Keep `readDetail()` for explicit recovery and communication flows, but never call it automatically from normal scan routing.
- Preserve login, risk-control, tab-binding, checkpoint, JD coverage, and matching-quality behavior.
- Use only `src/adapters/sites/boss.js` and `tests/source_acquisition_smoke.js` for implementation.
- Add no dependencies, test framework, source-text assertions, or unrelated refactors.

---

### Task 1: Exact card activation and condition-based pane wait

**Files:**
- Modify: `tests/source_acquisition_smoke.js:460-595`
- Modify: `src/adapters/sites/boss.js:55-190`
- Modify: `src/adapters/sites/boss.js:1115-1157`

**Interfaces:**
- Consumes: existing `window.__bossCards()`, `window.__bossScrollPane()`, `assertSearchPage()`, `waitWithPacing("card_retry")`, and `pane_detail_read` access reservation.
- Produces: `window.__bossActivateCard(jobId) -> { activated, jobId, reason }`.
- Produces: `window.__bossPaneState() -> { activeJobId, componentCurrentJobId, paneJobId, currentJobId, jobDetailLoading, title, description, ... }`.
- Preserves: `readVisiblePaneDetail(tabId, job, signal, assertTabBindings) -> detail | null`.

- [ ] **Step 1: Add a slow right-pane regression test**

Add `visiblePaneActivationWaitSmoke()` beside the current visible-pane tests and invoke it from `main()`:

```js
async function visiblePaneActivationWaitSmoke() {
  let paneReads = 0;
  let activations = 0;
  let navigations = 0;
  const accessActions = [];
  const browser = {
    async navigate() { navigations += 1; },
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) {
        return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      }
      if (expression.includes("window.__bossActivateCard")) {
        activations += 1;
        return { activated: true, jobId: "slow-pane-job", reason: "" };
      }
      if (expression.includes("window.__bossPaneState()")) {
        paneReads += 1;
        if (paneReads <= 12) {
          return {
            activeJobId: paneReads === 1 ? "old-job" : "slow-pane-job",
            componentCurrentJobId: paneReads === 1 ? "old-job" : "slow-pane-job",
            paneJobId: "old-job",
            currentJobId: "old-job",
            jobDetailLoading: paneReads > 1,
            title: "Old job",
            description: "Old detail",
            canScroll: false
          };
        }
        return {
          activeJobId: "slow-pane-job",
          componentCurrentJobId: "slow-pane-job",
          paneJobId: "slow-pane-job",
          currentJobId: "slow-pane-job",
          jobDetailLoading: false,
          title: "Slow pane job",
          description: "Complete Python RAG Agent job description ".repeat(12),
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
    title: "Slow pane job",
    url: "https://www.zhipin.com/job_detail/slow-pane-job.html"
  });
  assert(detail.description.length >= 120);
  assert(paneReads > 8, "must survive the old eight-poll timeout");
  assert.strictEqual(activations, 1);
  assert.strictEqual(navigations, 0);
  assert.deepStrictEqual(accessActions, [{
    action: "pane_detail_read",
    details: { jobId: "slow-pane-job" }
  }]);
}
```

- [ ] **Step 2: Add a fail-closed component test**

Replace the obsolete source-string test with a behavioral test:

```js
async function componentActivationUnavailableSmoke() {
  let activations = 0;
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) {
        return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      }
      if (expression.includes("window.__bossPaneState()")) {
        return {
          activeJobId: "old-job",
          componentCurrentJobId: "old-job",
          paneJobId: "old-job",
          currentJobId: "old-job",
          title: "Old job",
          description: "Old detail",
          canScroll: false
        };
      }
      if (expression.includes("window.__bossActivateCard")) {
        activations += 1;
        return { activated: false, jobId: "", reason: "component_unavailable" };
      }
      return true;
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  const detail = await adapter.readVisiblePaneDetail("pane-tab", {
    title: "Target job",
    url: "https://www.zhipin.com/job_detail/target-job.html"
  });
  assert.strictEqual(detail, null);
  assert.strictEqual(activations, 1);
}
```

- [ ] **Step 3: Run the focused test and confirm RED**

Run:

```powershell
node tests/source_acquisition_smoke.js
```

Expected: FAIL because `__bossActivateCard` is never requested and the old method returns `null` before the twelfth pane state.

- [ ] **Step 4: Add exact Vue component activation**

Add this helper after `__bossCards()`:

```js
window.__bossActivateCard = function(jobId) {
  const expectedJobId = String(jobId || "").trim();
  if (!expectedJobId) return { activated: false, jobId: "", reason: "job_id_missing" };
  const card = window.__bossCards().find((item) => {
    const href = (item.querySelector('a[href*="/job_detail/"]') || item.querySelector("a"))?.href || "";
    const id = (href.match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
    return id === expectedJobId;
  });
  if (!card) return { activated: false, jobId: "", reason: "card_not_found" };
  const wrap = card.closest(".job-card-wrap") || card;
  const component = wrap.__vue__ || card.__vue__ || null;
  const componentJobId = String(component?.data?.encryptJobId || "").trim();
  if (componentJobId !== expectedJobId) {
    return { activated: false, jobId: componentJobId, reason: "component_job_mismatch" };
  }
  if (typeof component?.clickJobCard !== "function") {
    return { activated: false, jobId: componentJobId, reason: "component_unavailable" };
  }
  wrap.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
  component.clickJobCard();
  return { activated: true, jobId: componentJobId, reason: "" };
};
```

- [ ] **Step 5: Separate active, component, and pane identities**

Refactor `__bossPaneState()` so it computes card/component identity before the right-pane root:

```js
const activeWrap = document.querySelector(".job-card-wrap.active");
const activeCard = activeWrap?.querySelector(".job-card-box")
  || document.querySelector(".job-card-box.active, .job-card-wrapper.active, li.active[class*='job']");
const activeLink = activeCard?.querySelector('a[href*="job_detail"]');
const activeJobId = (activeLink?.href?.match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
let pageComponent = activeWrap?.__vue__ || activeCard?.__vue__ || null;
for (let depth = 0; pageComponent && depth < 8; depth += 1) {
  if (String(pageComponent.$options?.name || "") === "PageJobs") break;
  pageComponent = pageComponent.$parent || null;
}
const componentCurrentJobId = String(pageComponent?.currentJob?.encryptJobId || "");
const jobDetailLoading = typeof pageComponent?.jobDetailLoading === "boolean"
  ? pageComponent.jobDetailLoading
  : null;
const paneLink = root?.querySelector('a[href*="job_detail"]');
const paneJobId = (paneLink?.href?.match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
```

Return `currentJobId: paneJobId` only as a compatibility alias. Never use `activeLink` as the source of `paneJobId`.

- [ ] **Step 6: Extend `readVisiblePaneDetail()`**

Replace the current method with this implementation. It waits without clicking when the card/component already selects the target, calls `__bossActivateCard()` at most once otherwise, and fails closed on post-activation identity mismatch:

```js
async readVisiblePaneDetail(tabId, job, signal = null, assertTabBindings = null) {
  throwIfAborted(signal);
  await assertRuntimeTabBindings(assertTabBindings);
  await this.assertSearchPage(tabId);
  await this.browser.evalValue(tabId, PAGE_HELPERS);
  const expectedJobId = (normalizeBossUrl(job?.url || "")
    .match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
  const expectedTitle = normalizedComparableText(job?.title);
  if (!expectedJobId || !expectedTitle) return null;
  await this.reserveAccess("pane_detail_read", { jobId: expectedJobId });
  let activationAttempted = false;
  let scrolled = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    throwIfAborted(signal);
    await assertRuntimeTabBindings(assertTabBindings);
    await this.assertSearchPage(tabId);
    await this.browser.evalValue(tabId, PAGE_HELPERS);
    const detail = await this.browser.evalValue(tabId, "(() => window.__bossPaneState())()");
    const paneJobId = detail?.paneJobId || detail?.currentJobId || "";
    const activeIds = [detail?.activeJobId, detail?.componentCurrentJobId]
      .map((value) => String(value || ""))
      .filter(Boolean);
    const selectionHasTarget = activeIds.includes(expectedJobId);
    if (activationAttempted
      && activeIds.length > 0
      && !selectionHasTarget) {
      return null;
    }
    if (paneJobId === expectedJobId) {
      const actualTitle = normalizedComparableText(detail?.title);
      if (!actualTitle || !actualTitle.includes(expectedTitle)) return null;
      if (detail?.description?.length >= 120) {
        await this.browser.evalValue(tabId, "(() => window.__bossScrollPane(true))()");
        return {
          description: cleanDetailText(detail.description),
          bossActiveText: parseBossActivityText(detail.bossActiveText),
          salary: detail.salary || "",
          experience: detail.experience || "",
          education: detail.education || ""
        };
      }
      if (!scrolled && detail?.canScroll) {
        scrolled = true;
        await this.browser.evalValue(tabId, "(() => window.__bossScrollPane(false))()");
      }
    } else if (!selectionHasTarget && !activationAttempted) {
      const activation = await this.browser.evalValue(
        tabId,
        `(() => window.__bossActivateCard(${JSON.stringify(expectedJobId)}))()`
      );
      if (!activation?.activated || activation.jobId !== expectedJobId) return null;
      activationAttempted = true;
    }
    await this.waitWithPacing("card_retry", { signal, assertTabBindings });
  }
  await this.browser.evalValue(tabId, "(() => window.__bossScrollPane(true))()");
  return null;
}
```

- [ ] **Step 7: Run the focused test and confirm GREEN**

Run:

```powershell
node tests/source_acquisition_smoke.js
```

Expected: PASS, including `paneReads > 8`, exactly one activation, and zero standalone navigation.

- [ ] **Step 8: Commit Task 1**

```powershell
git add src/adapters/sites/boss.js tests/source_acquisition_smoke.js
git commit -m "fix: activate exact BOSS search pane cards"
```

---

### Task 2: Remove standalone fallback from normal scan routing

**Files:**
- Modify: `tests/source_acquisition_smoke.js:596-690`
- Modify: `tests/source_acquisition_smoke.js:1260-1465`
- Modify: `src/adapters/sites/boss.js:749-790`

**Interfaces:**
- Consumes: Task 1 `readVisiblePaneDetail() -> detail | null`.
- Produces: normal scan detail outcomes using only `accessMode: "visible_pane"`.
- Preserves: explicit `readDetail()` callers outside the normal scan loop.

- [ ] **Step 1: Change routing tests to require pane-only scans**

Rename `standaloneDetailRoutingSmoke()` to `searchPaneDetailRoutingSmoke()` and make both cards return complete pane details. Set `adapter.readDetail` to throw if called:

```js
adapter.readVisiblePaneDetail = async (tabId, job) => {
  events.push({ type: "visible_pane", tabId, url: job.url });
  return {
    description: `Complete pane detail ${job.url} `.repeat(12),
    bossActiveText: "active",
    salary: "10-15K",
    experience: "1-3 years",
    education: "bachelor"
  };
};
adapter.readDetail = async () => {
  throw new Error("normal scan must not open standalone detail");
};
```

Assert the event sequence is `["list", "visible_pane", "visible_pane"]` and both outcomes use `visible_pane`.

- [ ] **Step 2: Update failure, audit, and budget fixtures**

Update only existing scenarios that model the normal scan fallback:

- `scanNullPaneOutcomeSmoke`: expect `detailRead === false`, `BOSS_PANE_SWITCH_TIMEOUT`, and failed `visible_pane` outcome.
- `detailFailureDedupeSmoke`: make `readVisiblePaneDetail` throw `BOSS_PANE_SWITCH_TIMEOUT`; expect one attempt across duplicate keywords.
- `detailOutcomeAuditSmoke`: make the failing pane throw `BOSS_PANE_SWITCH_TIMEOUT`; both outcomes use `visible_pane`.
- `fatalBudgetAfterCompletedTargetSmoke`: keep the same fatal checkpoint behavior but use `action: "pane_detail_read"` and the pane recovery limits.
- `detailBudgetCheckpointSmoke`: make the second `readVisiblePaneDetail` call throw the existing budget error with `action: "pane_detail_read"`; keep checkpoint assertions.

Leave `refreshDetails()`, `probeActivities()`, communication tests, and their explicit `readDetail()` stubs unchanged.

- [ ] **Step 3: Run the focused test and confirm RED**

Run:

```powershell
node tests/source_acquisition_smoke.js
```

Expected: FAIL because `scanBrowser()` still calls `readDetail()` when pane detail is null and still reports `standalone_detail`.

- [ ] **Step 4: Make normal scan pane-only**

Delete the `visiblePaneProbeAvailable` declaration. Inside the existing `try` block, replace the code from `let detail = null` through the standalone `readDetail()` fallback with:

```js
const detail = await this.readVisiblePaneDetail(
  tabId,
  entry.job,
  options.signal,
  options.assertTabBindings
);
if (!detail) {
  throw bossError(
    "BOSS_PANE_SWITCH_TIMEOUT",
    `BOSS search pane did not become complete for ${entry.job.sourceId || "unknown"}`
  );
}
```

Initialize `accessMode` as `"visible_pane"` before `detailOutcome`. Keep the existing normalization, merge, detail checkpoint, counters, catch block, fatal-error handling, and `onDetailResult` call byte-for-byte except that every outcome now receives this fixed `accessMode`. Do not modify the `readDetail()` method.

- [ ] **Step 5: Run the focused test and confirm GREEN**

Run:

```powershell
node tests/source_acquisition_smoke.js
```

Expected: PASS with no normal-scan standalone routing.

- [ ] **Step 6: Run the non-startup offline suite**

Run the same 74-test loop used for the clean baseline while port 8787 remains occupied. Expected: `BASELINE_NON_STARTUP_PASSED=74`.

- [ ] **Step 7: Commit Task 2**

```powershell
git add src/adapters/sites/boss.js tests/source_acquisition_smoke.js
git commit -m "fix: keep BOSS scan details in search pane"
```

---

### Task 3: Final verification and branch checkpoint

**Files:**
- Verify: `AGENTS.md`
- Verify: `docs/superpowers/specs/2026-08-10-boss-search-pane-detail-reuse-design.md`
- Verify: `docs/superpowers/plans/2026-08-10-boss-search-pane-detail-reuse.md`
- Verify: `src/adapters/sites/boss.js`
- Verify: `tests/source_acquisition_smoke.js`

**Interfaces:**
- Consumes: completed Task 1 and Task 2 commits.
- Produces: a clean, reviewable feature branch ready for manual acceptance.

- [ ] **Step 1: Run targeted verification**

```powershell
node tests/source_acquisition_smoke.js
```

Expected: `source_acquisition_smoke ok`.

- [ ] **Step 2: Verify no automatic standalone route remains**

Inspect the normal scan loop and confirm:

- every `detailEntries` item calls `readVisiblePaneDetail`;
- the loop has no `readDetail` call;
- normal scan outcomes use `visible_pane`;
- explicit recovery and communication `readDetail` callers remain.

- [ ] **Step 3: Run diff and whitespace checks**

```powershell
git diff --check checkpoint/pre-search-pane-detail-reuse-20260810...HEAD
git status --short
git diff --stat checkpoint/pre-search-pane-detail-reuse-20260810...HEAD
```

Expected: no whitespace errors, no uncommitted changes, and only the five scoped files listed above.

- [ ] **Step 4: Record the feature checkpoint**

```powershell
git tag -a checkpoint/search-pane-detail-reuse-ready-20260810 -m "Search pane detail reuse ready for manual acceptance"
```

- [ ] **Step 5: Leave real-page validation for the user-led acceptance pass**

Do not click BOSS again in this implementation session. Report that the branch is offline-verified and that the next step is a user-led, separately approved manual acceptance run.
