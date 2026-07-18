# BOSS Standalone Detail Read-Only Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add evidence-based, read-only inspection for saved BOSS standalone job-detail links without enabling any communication click.

**Architecture:** Keep search-page capture in the existing `BossSiteAdapter`, but add a separate standalone-detail DOM helper and adapter methods for the communication phase. Reuse exactly one non-search BOSS tab, navigate saved job URLs serially, classify a sanitized page snapshot with pure JavaScript, and fail closed for every unobserved state.

**Tech Stack:** Node.js 22 CommonJS, existing Edge Control adapter, `node:assert`, existing smoke-test runner.

## Global Constraints

- Automated regression tests must be fully offline. A necessary live DOM check may use one serial read-only page action at a time, with random pacing and an immediate stop on login or risk signals.
- Do not reload BOSS or create another BOSS tab merely to increase test coverage. Any further live navigation must answer a specific unresolved page question; communication/application clicks remain separately approval-gated.
- Use one fixed `BOSS-SEARCH` tab and one fixed `BOSS-COMMUNICATION` tab; never create a per-job tab or run browser work in parallel.
- A stored job URL opens `/job_detail/<job-id>.html`, whose DOM is different from `/web/geek/jobs`.
- The observed standalone ready action is one visible `a.btn.btn-startchat` with exact text `立即沟通` inside `.job-primary`; no other communication state is calibrated.
- Verify target identity from URL job ID, title, and company. Do not use the action element's `ka` attribute as job identity.
- Risk, login, missing identity, duplicate action, unknown action, and structure drift must fail closed.
- Keep `PRODUCT_POLICY.operations.bossCommunication.calibration.executionEnabled` set to `false`.
- Do not add production CLI/dashboard execution wiring and do not add dependencies.
- Do not commit real job IDs, recruiter names, company names, resume data, screenshots, raw HTML, or browser credentials.

---

### Task 1: Define Standalone Detail Classification With Failing Tests

**Files:**
- Create: `tests/boss_communication_page_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: `BossSiteAdapter` and `classifyBossCommunicationSnapshot` exported by `src/adapters/sites/boss.js` in Task 2.
- Produces: offline behavioral coverage for ready, mismatch, unavailable, ambiguous structure, risk/login, fixed-tab reuse, and disabled click phases.

- [x] **Step 1: Create the pure-classification failing cases**

Create sanitized snapshots with fake values only:

```js
const readySnapshot = {
  url: "https://www.zhipin.com/job_detail/fake123.html",
  jobId: "fake123",
  pageReady: true,
  risk: false,
  login: false,
  jobStatus: "招聘中",
  title: "AI应用开发工程师",
  company: "示例科技",
  salary: "10-15K",
  bossActiveText: "今日活跃",
  actions: [{ label: "立即沟通", x: 320, y: 120, width: 150, height: 45 }]
};

assert.deepStrictEqual(
  classifyBossCommunicationSnapshot(readySnapshot, {
    url: readySnapshot.url,
    title: "AI应用开发工程师",
    company: "示例科技"
  }),
  {
    state: "ready",
    jobId: "fake123",
    title: "AI应用开发工程师",
    company: "示例科技",
    salary: "10-15K",
    bossActiveText: "今日活跃",
    actionLabel: "立即沟通",
    clickPoint: { x: 395, y: 142.5 }
  }
);
```

Add separate assertions for:

```js
assert.strictEqual(classifyBossCommunicationSnapshot({ ...readySnapshot, jobId: "other" }, expected).state, "target_mismatch");
assert.strictEqual(classifyBossCommunicationSnapshot({ ...readySnapshot, title: "Java开发工程师" }, expected).state, "target_mismatch");
assert.strictEqual(classifyBossCommunicationSnapshot({ ...readySnapshot, company: "另一家公司" }, expected).state, "target_mismatch");
assert.strictEqual(classifyBossCommunicationSnapshot({ ...readySnapshot, jobStatus: "停止招聘", actions: [] }, expected).state, "job_unavailable");
assert.strictEqual(classifyBossCommunicationSnapshot({ ...readySnapshot, actions: [] }, expected).state, "action_unavailable");
assert.strictEqual(classifyBossCommunicationSnapshot({ ...readySnapshot, actions: [readySnapshot.actions[0], readySnapshot.actions[0]] }, expected).state, "action_unavailable");
assert.throws(() => classifyBossCommunicationSnapshot({ ...readySnapshot, risk: true }, expected), error => error.code === "BOSS_RISK_CONTROL");
assert.throws(() => classifyBossCommunicationSnapshot({ ...readySnapshot, login: true }, expected), error => error.code === "BOSS_LOGIN_REQUIRED");
```

- [x] **Step 2: Add fake-browser adapter cases**

Create a fake browser that records `listTabs`, `createTab`, `bringToFront`, `navigate`, `evalValue`, and `clickAt`. Assert that `prepareCommunicationTab(searchTabId)` reuses an existing non-search BOSS detail tab, creates at most one blank tab when none exists, and reuses the stored tab ID on the next job. With two valid search tabs, bind `search-1` first and assert a later explicit `search-2` call rejects with `BOSS_SEARCH_PAGE_LOST` without increasing assertion, create, bring-to-front, navigation, or click counts. Assert a valid search URL without `windowId` rejects with `BOSS_COMMUNICATION_TAB_WINDOW_UNKNOWN` without any page action, and stored/reusable communication detail tabs without `windowId` are not reused. A new tab is allowed only when no reusable candidate exists or every reusable candidate has a provable different window; any reusable candidate with an unknown window fails closed.

Assert `inspectCommunicationJob(job)` performs exactly one navigation to the normalized stored detail URL, only DOM reads after navigation, and zero `clickAt` calls. Assert `dispatchCommunication()` and `verifyCommunicationResult()` reject with `BOSS_COMMUNICATION_CALIBRATION_REQUIRED`.

- [x] **Step 3: Register the test and verify RED**

Add `boss_communication_page_smoke.js` after `source_acquisition_smoke.js` in `tests/run_all.js`.

Run:

```powershell
node tests/boss_communication_page_smoke.js
```

Expected: FAIL because the classifier and read-only communication methods are not implemented.

---

### Task 2: Implement The Minimum Evidence-Based Detail Adapter

**Files:**
- Modify: `src/adapters/sites/boss.js`
- Test: `tests/boss_communication_page_smoke.js`

**Interfaces:**
- Produces: `classifyBossCommunicationSnapshot(snapshot, expectedJob) -> CommunicationInspection`.
- Produces: `BossSiteAdapter.prepareCommunicationTab(searchTabId?) -> tabId`.
- Produces: `BossSiteAdapter.inspectCommunicationJob(job, signal?) -> CommunicationInspection`.
- Produces: disabled `BossSiteAdapter.dispatchCommunication()` and `BossSiteAdapter.verifyCommunicationResult()` methods that always throw the calibration error.

- [x] **Step 1: Add a standalone-detail DOM helper**

Add `window.__bossCommunicationSnapshot` to `PAGE_HELPERS`. It must read only the standalone detail page:

```js
const header = document.querySelector(".job-primary.detail-box")
  || document.querySelector(".job-primary")
  || document.querySelector(".job-banner");
const actionRoot = header?.querySelector(".job-op") || header;
const actions = Array.from(actionRoot?.querySelectorAll("a, button, [role='button']") || [])
  .filter(isVisibleAndEnabled)
  .map(toActionSnapshot)
  .filter((item) => item.label.includes("沟通"));
```

Return only serializable fields: current URL/job ID, risk/login flags, `pageReady`, `.job-status`, `.job-primary h1`, `.sider-company .company-info` text, `.job-primary .salary`, `.job-boss-info .boss-active-time`, and visible action rectangles. Do not return DOM nodes, HTML, recruiter names, or JD text.

- [x] **Step 2: Add the pure fail-closed classifier**

Implement this decision order:

```js
if (snapshot.risk) throw bossError("BOSS_RISK_CONTROL", "BOSS 当前要求安全验证，已停止沟通页面检查。");
if (snapshot.login) throw bossError("BOSS_LOGIN_REQUIRED", "BOSS 登录状态已失效，已停止沟通页面检查。");
if (!snapshot.pageReady) return { state: "action_unavailable" };
if (!sameJobId(snapshot, expectedJob) || !sameTitle(snapshot, expectedJob) || !sameCompany(snapshot, expectedJob)) return { state: "target_mismatch" };
if (!snapshot.jobStatus) return { state: "action_unavailable" };
if (snapshot.jobStatus !== "招聘中") return { state: "job_unavailable" };
if (snapshot.actions.length !== 1) return { state: "action_unavailable" };
return readyInspection(snapshot);
```

Normalize whitespace and punctuation for title/company comparison. Require exact URL job-ID equality. Allow company containment only when both normalized names have at least four characters, so a legal-name/brand-name difference does not create a false mismatch.

- [x] **Step 3: Add fixed-tab preparation and read-only inspection**

`prepareCommunicationTab` must:

1. Cache the first verified `communicationSearchTabId` as an immutable fixed search ID. If a later explicit `searchTabId` differs, throw `BOSS_SEARCH_PAGE_LOST` before asserting a page, bringing a tab forward, navigating, or creating a tab.
2. Require the fixed search tab to have a non-empty, reliable `windowId`; otherwise throw `BOSS_COMMUNICATION_TAB_WINDOW_UNKNOWN` without asserting, creating, navigating, or clicking.
3. Reuse `this.communicationTabId` only when that tab still exists, remains a standalone detail/chat tab, and has the same known `windowId` as the fixed search tab. If a stored or reusable communication candidate lacks `windowId`, throw `BOSS_COMMUNICATION_TAB_WINDOW_UNKNOWN` before any fallback.
4. Otherwise reuse one non-search BOSS `/job_detail/` or chat tab only when it has the same known `windowId`. Create one inactive `about:blank` tab from the verified search tab only when no reusable candidate exists or all candidates have known, different `windowId` values.
5. Bring only that fixed communication tab to the front and store its ID. Never close the search tab, create a per-job tab, or inspect two tabs concurrently; `communicationTabPreparationPromise` and `communicationInspectionInFlight` remain the preparation and inspection concurrency guards.

`inspectCommunicationJob` must validate a trusted `https://www.zhipin.com/job_detail/<id>.html` URL, prepare the fixed communication tab, navigate exactly once with `browser.navigate`, wait through existing `detail` pacing, and poll only DOM state up to four times with existing `retry` pacing. It must not call `navigateWithPacing`, because the executor already reserves one `communication_visit` and double-counting `detail_open` would be incorrect.

- [x] **Step 4: Keep every action phase disabled**

Implement both methods as hard failures:

```js
async dispatchCommunication() {
  throw bossError("BOSS_COMMUNICATION_CALIBRATION_REQUIRED", "BOSS 沟通点击尚未完成真实页面校准。");
}

async verifyCommunicationResult() {
  throw bossError("BOSS_COMMUNICATION_CALIBRATION_REQUIRED", "BOSS 沟通结果尚未完成真实页面校准。");
}
```

Do not change product policy, CLI, dashboard controls, or the generic executor.

- [x] **Step 5: Verify GREEN and commit**

Run:

```powershell
node tests/boss_communication_page_smoke.js
node tests/source_acquisition_smoke.js
node tests/communication_calibration_gate_smoke.js
```

Expected: all three pass and no BOSS network access occurs.

Commit:

```powershell
git add src/adapters/sites/boss.js tests/boss_communication_page_smoke.js tests/run_all.js
git commit -m "feat: inspect BOSS detail pages read-only"
```

---

### Task 3: Record Calibration Boundary And Run Full Offline Verification

**Files:**
- Create: `docs/communication_live_acceptance.md`
- Modify: `docs/superpowers/plans/2026-07-18-boss-detail-readonly-inspection.md`

**Interfaces:**
- Produces: a sanitized record of observed evidence and explicit remaining live-calibration work.

- [x] **Step 1: Record only sanitized observed evidence**

Document the 2026-07-18 read-only sample:

- standalone URL shape `/job_detail/<job-id>.html`;
- header `.job-primary.detail-box`;
- status `.job-status` with observed text `招聘中`;
- title `.job-primary h1`;
- salary `.job-primary .salary`;
- company `.sider-company .company-info`;
- ready action `a.btn.btn-startchat` with exact text `立即沟通`;
- activity `.job-boss-info .boss-active-time`;
- one navigation, zero reloads, zero clicks, and no risk signal.

State clearly that `already_communicated`, unavailable-page layout, post-click detail state, and active-chat identity remain uncalibrated. Keep execution disabled.

- [x] **Step 2: Run syntax and full offline regression**

Run:

```powershell
node --check src/adapters/sites/boss.js
npm test
```

Expected: syntax passes and all 33 offline checks pass.

- [ ] **Step 3: Review the complete branch**

Review the branch against these exact requirements: no BOSS requests from tests, one fixed communication tab, one navigation per inspected job, strict identity verification, duplicate/unknown action failure, no click implementation, and unchanged `executionEnabled: false`.

- [ ] **Step 4: Commit documentation**

```powershell
git add docs/communication_live_acceptance.md docs/superpowers/plans/2026-07-18-boss-detail-readonly-inspection.md
git commit -m "docs: record BOSS detail calibration boundary"
```

## Deferred Live Acceptance

On the next explicitly approved low-frequency test day, collect one state at a time with cooling between navigations. Do not enable execution until real evidence exists for already-communicated, unavailable, post-click detail, and active-chat identity, and the user separately approves one single click.
