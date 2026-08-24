# Acceptance Flow Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate duplicate model-setting work, prevent onboarding from advancing before its search plan exists, and serialize competing Dashboard browser reads that caused the 15-second CDP timeout.

**Architecture:** Keep the existing Dashboard and storage boundaries. Add one in-memory single-flight map for identical model submissions and one Promise tail for Dashboard browser reads; tighten the existing onboarding view-model condition; remove redundant CDP tab enumeration for already-known targets. No new dependency or background service is introduced.

**Tech Stack:** Node.js 22 CommonJS, native HTTP server, native WebSocket/CDP, SQLite, existing assert-based smoke tests.

## Global Constraints

- BOSS remains read-only; no real communication or application action is authorized.
- Browser work remains background-only; never call `Page.bringToFront` outside the existing user-invoked startup guidance exception.
- Production JD acquisition remains `trusted_pane`; do not enable, repair, validate, or delete `search_page_api` and do not introduce general `standalone_detail`.
- Preserve fixed-tab identity checks, serial work, pacing, cooldowns, access budgets, checkpoints, and immediate stop signals.
- Do not increase the 15000ms CDP timeout as a substitute for fixing duplicate work.
- Do not add dependencies or write secrets, BOSS content, local paths, or resume data to logs.

---

### Task 1: Gate onboarding on the completed plan

**Files:**
- Modify: `tests/onboarding_progress_ui_smoke.js`
- Modify: `src/dashboard/server.js`

**Interfaces:**
- Consumes: persisted onboarding run fields `status`, `stage`, `matchingCardId`, and `searchPlanId`.
- Produces: `publicOnboardingRun(run).nextHref` only when the complete run is ready.

- [ ] **Step 1: Write the failing test**

Pause the injected `recommendPlan` Promise after the matching-card checkpoint. Assert that `/api/onboarding-status` returns `stage: "building_plan"` with an empty `nextHref`, and that the progress page has no actionable matching-card link.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/onboarding_progress_ui_smoke.js`

Expected: FAIL because the current implementation exposes `/match-card?...` as soon as `matchingCardId` exists.

- [ ] **Step 3: Write minimal implementation**

Change the `nextHref` condition in `publicOnboardingRun` to require:

```js
const canReviewMatchingCard = run.status === "completed"
  && run.stage === "ready"
  && Boolean(run.matchingCardId)
  && Boolean(run.searchPlanId);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/onboarding_progress_ui_smoke.js`

Expected: PASS.

### Task 2: Make model-setting submission single-flight and visibly pending

**Files:**
- Modify: `tests/model_settings_ui_smoke.js`
- Modify: `src/dashboard/server.js`

**Interfaces:**
- Consumes: parsed model settings form fields.
- Produces: one shared Promise per identical in-flight request and a settings form that prevents repeated native submission.

- [ ] **Step 1: Write the failing server test**

Use a deferred `connectionTester`, send two identical concurrent `/api/settings/model` requests, release the tester, and assert both responses are 303 while `connectionTester` ran exactly once for `deep_analysis` and once for `batch_screening`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/model_settings_ui_smoke.js`

Expected: FAIL with four connection-test calls.

- [ ] **Step 3: Implement the minimal server single-flight**

Inside `createDashboardServer`, keep a `Map` from a SHA-256 form fingerprint to the active Promise. Refactor `handleModelSettingsSave` so the side-effecting save block runs through that map; remove the map entry in `finally`. Never log or return the fingerprint.

- [ ] **Step 4: Add visible native-form pending state**

In `modelSettingsClientScript`, attach a submit handler to model-setting forms. On first submit, set `data-submitting`, set `aria-busy`, change the submitter label to `正在测试并保存…`, and prevent later submits. Preserve the original submitter so `action` remains in the form body.

- [ ] **Step 5: Avoid repeated settings loads on GET**

Load the public settings state once in the `/settings` route and compute both primary readiness flags from that state where they share credentials. For independent credentials, resolve each distinct profile once. Do not cache decrypted keys beyond the Dashboard process lifetime.

- [ ] **Step 6: Run test to verify it passes**

Run: `node tests/model_settings_ui_smoke.js`

Expected: PASS; concurrent requests share work and secrets remain absent from output.

### Task 3: Serialize Dashboard browser reads and remove redundant tab enumeration

**Files:**
- Modify: `tests/workflow_dashboard_smoke.js`
- Modify: `tests/browser_transport_smoke.js`
- Modify: `src/dashboard/pages/today.js`
- Modify: `src/dashboard/server.js`
- Modify: `src/adapters/browser/cdp.js`
- Modify: `src/adapters/sites/boss.js`

**Interfaces:**
- Consumes: existing `browserReadinessProbe`, `inheritedPreviewResolver`, `acquisitionContextResolver`, and known tab IDs.
- Produces: a Dashboard-local `runBrowserRead` function and a raw-target lookup for known tab IDs.

- [ ] **Step 1: Write failing serialization tests**

Start a deferred readiness request and an acquisition-preview request at the same time. Assert the preview dependency does not start until readiness resolves. Extend the client-script fixture so a form submit stops later interval callbacks from issuing fetches.

- [ ] **Step 2: Write the failing CDP transport test**

Configure two fake page targets, call `evalValue` for one known target, and assert no `Runtime.evaluate` with expression `document.visibilityState` is sent to the unrelated target.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```text
node tests/workflow_dashboard_smoke.js
node tests/browser_transport_smoke.js
```

Expected: the route dependencies overlap, submit does not stop polling, and known-target evaluation performs visibility reads for every tab.

- [ ] **Step 4: Implement the minimal Promise serial runner**

Add a small closure in `createDashboardServer` whose tail always settles before the next task starts. Wrap readiness, acquisition preview, workflow acquisition context, and browser-required workflow-resume readiness. Coalesce simultaneous readiness requests by sharing one active Promise.

- [ ] **Step 5: Stop readiness polling on submit**

In the existing readiness script, retain the interval handle and a `stopped` flag. On the workflow form's `submit`, set `stopped`, clear the interval, and disable the button. The current request may finish but must not schedule another.

- [ ] **Step 6: Remove redundant known-tab enumeration**

In `CdpBrowserAdapter.findTab`, read `/json/list`, select the exact page target, and return its debugger URL without invoking full `listTabs()`. In `BossSiteAdapter.preflight`, skip `browser.listTabs()` when `tabId` is explicitly supplied.

- [ ] **Step 7: Run focused tests**

Run:

```text
node tests/workflow_dashboard_smoke.js
node tests/browser_transport_smoke.js
node tests/source_acquisition_smoke.js
node tests/workspace_tabs_smoke.js
```

Expected: PASS.

### Task 4: Verify and package the acceptance fix

**Files:**
- Modify only files required by failures found in this task.

**Interfaces:**
- Consumes: all changes from Tasks 1-3.
- Produces: a committed candidate suitable for another local installation and continued manual acceptance.

- [ ] **Step 1: Run all offline checks**

Run: `npm test`

Expected: `All 106 offline checks passed.` or the updated total with all checks passing.

- [ ] **Step 2: Perform local UI verification**

Use a local mock Dashboard and headless Chromium. Verify model-setting pending text, onboarding gate behavior, desktop layout, narrow layout, and absence of console errors. Do not connect to port 9222 or BOSS.

- [ ] **Step 3: Review the diff**

Run `git diff --check`, inspect the exact changed files, and obtain an independent correctness/safety review. Address all Critical and Important findings.

- [ ] **Step 4: Commit**

Stage only the spec, plan, implementation, and regression checks, then commit with:

```text
fix: harden first-run and browser task coordination
```

- [ ] **Step 5: Build the next installer candidate**

Build to `D:\DevData\RoleFlow-installer\dist\acceptance-flow-<commit>` using the pinned Node and Inno Setup compiler. Verify SHA-256 and packaged self-check, then launch the interactive installer for the user. Do not push, merge, or publish.
