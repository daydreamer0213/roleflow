# Batch Communication Acceptance Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the already verified BOSS communication policy to `accepted`, ship `0.1.0-beta.4.5`, preserve batch `#1`, and expose the existing full serial resume path for the remaining nine immutable items.

**Architecture:** Change the single static product-policy value and reuse the existing full-batch application, dashboard, CLI, executor, pacing, and safety paths. Update default-policy tests to cover full start/resume while preserving the `e2e_pending` single-item guard through existing dependency injection and view-model fixtures. Do not add runtime configuration, database state, migrations, or browser behavior.

**Tech Stack:** Node.js 22, CommonJS, built-in `node:assert`, SQLite, PowerShell, Inno Setup.

## Global Constraints

- Default calibration acceptance becomes exactly `accepted`.
- Keep `e2e_pending` single-item guard code and regression coverage.
- Do not change click, result, pacing, quota, login/risk, fixed-tab, or search-return behavior.
- Do not access BOSS during implementation, tests, build, or installation.
- Do not enable `search_page_api`, use `standalone_detail`, or start Wave 5.
- Version is exactly `0.1.0-beta.4.5`.
- Preserve batch `#1` remaining-scope SHA-256 `50980336b44b898ac75dc5ce8fe07fe0dad0201b3c26d296f68c9c79309f22b0`.
- Do not push, tag, or publish.

---

### Task 1: Promote the default communication policy

**Files:**
- Modify: `tests/communication_calibration_gate_smoke.js`
- Modify: `tests/communication_application_smoke.js`
- Modify: `tests/dashboard_communication_batch_smoke.js`
- Modify: `src/core/product_policy.js`

**Interfaces:**
- Consumes: `communicationCalibrationStatus()`, `controlCommunicationBatch()`, and the existing dashboard communication control route.
- Produces: default calibration `{ implementation: "implemented", calibration: "calibrated", acceptance: "accepted", executionEnabled: true }`.

- [ ] **Step 1: Change the policy smoke to require accepted full-batch execution**

In `tests/communication_calibration_gate_smoke.js`, require:

```js
assert.deepStrictEqual(communicationCalibrationStatus(), {
  implementation: "implemented",
  calibration: "calibrated",
  acceptance: "accepted",
  executionEnabled: true
});
```

Submit the existing batch with:

```js
const response = await postJson(baseUrl, "/api/communication-control", {
  batchId: batch.id,
  action: "start"
});
```

Assert the spawned argument tail does not contain `--single-item`:

```js
assert.strictEqual(spawns[0].args.includes("--single-item"), false);
```

- [ ] **Step 2: Update application smoke defaults and retain an injected pending gate**

In `tests/communication_application_smoke.js`, change default status assertions to
`acceptance: "accepted"`. Change the primary normal start request from `start_one`
to `start` and assert:

```js
assert.deepStrictEqual(
  spawns[0].args.slice(spawns[0].args.indexOf("communicate")),
  ["communicate", "--db", dbPath, "--batch", String(batchId), "--browser", "portable", "--cdp-port", "9222"]
);
```

Before that normal start, preserve the unaccepted-policy guard with the existing
application dependency seam:

```js
assert.throws(
  () => controlCommunicationBatch({
    db,
    input: { batchId, action: "start" },
    deps: {
      communicationCalibrationReader: () => ({
        implementation: "implemented",
        calibration: "calibrated",
        acceptance: "e2e_pending",
        executionEnabled: true
      }),
      spawnCommunication() {}
    }
  }),
  (error) => error.code === "COMMUNICATION_E2E_SINGLE_ITEM_REQUIRED"
);
```

Keep direct `start_one` mismatch tests; accepted policy still permits explicit
single-item controls, so those tests continue covering exact-item validation.

- [ ] **Step 3: Update dashboard integration expectations to the accepted path**

In `tests/dashboard_communication_batch_smoke.js`:

- keep `communicationStatus()` defaulting to `e2e_pending` so the pure view-model
  test still covers the single-item UI;
- change live server page/status assertions to `accepted`;
- require normal `start` / `resume` controls and remove item-ID assertions from
  those full-batch forms;
- change normal process-argument assertions to omit `--single-item`;
- change Edge rebind-order tests from `resume_one` to `resume`;
- keep ambiguity, scope, runtime, and no-browser-mutation assertions unchanged;
- after manual ambiguity resolution, resume with `action: "resume"`.

The accepted page assertions must include:

```js
assert.match(review.body, /端到端验收：accepted/);
assert.match(review.body, /name="action" value="start"/);
assert.doesNotMatch(review.body, /验收这个岗位并自动暂停/);
```

- [ ] **Step 4: Run the focused test and verify RED**

Run:

```powershell
E:\RoleFlow\runtime\node\node.exe --disable-warning=ExperimentalWarning tests\communication_calibration_gate_smoke.js
```

Expected: FAIL because the production policy still returns `e2e_pending`.

- [ ] **Step 5: Apply the one-line production change**

In `src/core/product_policy.js`:

```js
acceptance: "accepted",
```

Do not add another setting, branch, helper, or database field.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
E:\RoleFlow\runtime\node\node.exe --disable-warning=ExperimentalWarning tests\communication_calibration_gate_smoke.js
E:\RoleFlow\runtime\node\node.exe --disable-warning=ExperimentalWarning tests\communication_application_smoke.js
E:\RoleFlow\runtime\node\node.exe --disable-warning=ExperimentalWarning tests\dashboard_communication_batch_smoke.js
E:\RoleFlow\runtime\node\node.exe --disable-warning=ExperimentalWarning tests\communication_cli_authority_smoke.js
E:\RoleFlow\runtime\node\node.exe --disable-warning=ExperimentalWarning tests\communication_executor_smoke.js
```

Expected: all five exit 0.

- [ ] **Step 7: Commit**

```powershell
git add -- src/core/product_policy.js tests/communication_calibration_gate_smoke.js tests/communication_application_smoke.js tests/dashboard_communication_batch_smoke.js
git commit -m "feat: accept calibrated BOSS communication"
```

---

### Task 2: Prepare and build beta.4.5

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Create: `docs/releases/v0.1.0-beta.4.5.md`

**Interfaces:**
- Consumes: accepted policy from Task 1 and the existing installer pipeline.
- Produces: `dist/RoleFlow-Setup-0.1.0-beta.4.5.exe` and matching `.sha256`.

- [ ] **Step 1: Bump package metadata**

Set all root package versions to:

```json
"version": "0.1.0-beta.4.5"
```

- [ ] **Step 2: Update release-facing documentation**

Update the README badge, current-version paragraph, download filename, and
portable filename to beta.4.5. Create `docs/releases/v0.1.0-beta.4.5.md` stating:

- one real beta.4.4 single-job E2E passed with one click and accepted
  `friend_add` response;
- beta.4.5 promotes calibration to accepted and exposes existing full serial
  execution;
- all safety stops and no-retry behavior remain;
- real continuous-batch and message-discovery acceptance are still pending
  until this run completes;
- installer is unsigned.

- [ ] **Step 3: Verify metadata consistency**

Run:

```powershell
rg -n "0\.1\.0-beta\.4\.4|v0\.1\.0-beta\.4\.4" package.json package-lock.json README.md docs/releases/v0.1.0-beta.4.5.md
```

Expected: no matches.

- [ ] **Step 4: Run the full offline suite**

Run:

```powershell
E:\RoleFlow\runtime\node\node.exe --disable-warning=ExperimentalWarning tests\run_all.js
```

Expected: `All 97 offline checks passed.`

- [ ] **Step 5: Build the canonical installer**

Run from Windows PowerShell with the utility module loaded:

```powershell
Import-Module Microsoft.PowerShell.Utility
& .\scripts\build-installer.ps1
```

Expected:

- full offline suite passes inside the build;
- Inno Setup exits 0;
- `dist\RoleFlow-Setup-0.1.0-beta.4.5.exe` exists;
- its `.sha256` sidecar matches;
- stage is `D:\DevData\RoleFlow-installer\stage\0.1.0-beta.4.5`;
- stage contains no database, secrets, reports, tests, logs, `.runtime`, or Edge
  bridge/profile files.

- [ ] **Step 6: Commit**

```powershell
git add -- package.json package-lock.json README.md docs/releases/v0.1.0-beta.4.5.md
git commit -m "chore: prepare v0.1.0-beta.4.5"
```

---

### Task 3: Integrate, install, and preserve the immutable batch

**Files:**
- No source edits expected.
- Runtime installation target: `E:\RoleFlow`
- Operational database: `E:\RoleFlow\data\jobs.sqlite`

**Interfaces:**
- Consumes: verified beta.4.5 installer and batch scope hash.
- Produces: installed beta.4.5 with the same batch `#1` remaining nine items.

- [ ] **Step 1: Run final branch verification**

Run focused tests, the full suite, `git diff --check`, and `git status`.
Review the exact diff; it must not touch browser execution behavior.

- [ ] **Step 2: Fast-forward local main and rebuild from main**

Use the existing finishing workflow. Do not push. Rebuild the installer from
the exact clean main HEAD so stage and installer identify the integrated source.

- [ ] **Step 3: Record the pre-install operational snapshot**

Read batch `#1` and compute the pending scope hash. Require:

```text
pendingCount=9
scopeHash=50980336b44b898ac75dc5ce8fe07fe0dad0201b3c26d296f68c9c79309f22b0
```

Each pending item must have `click_count=0`.

- [ ] **Step 4: Cover-install beta.4.5**

Stop RoleFlow local processes safely, run the beta.4.5 installer silently into
`E:\RoleFlow`, and do not start or navigate the browser during installation.

- [ ] **Step 5: Verify installation and data preservation**

Require:

- registry and installed `package.json` both report `0.1.0-beta.4.5`;
- installer self-check reports `SELF_CHECK_OK`;
- installed policy reports `acceptance: "accepted"`;
- pending count, item order, click counts, and scope hash are unchanged;
- the communication page exposes normal `resume`, not `resume_one`.

- [ ] **Step 6: Restore hidden local services and re-run read-only browser preflight**

Start dashboard and Edge bridge without opening or focusing pages. Re-read
numeric tab IDs and confirm login/risk/page identities. Do not submit the
communication control form.

---

### Task 4: Perform the authorized real acceptance

**Files:**
- No source edits.

**Interfaces:**
- Consumes: current immutable batch `#1`, accepted policy, and the user's
  authorization for all nine pending items.
- Produces: a terminal batch result or the first safety stop, followed by
  read-only message-discovery evidence.

- [ ] **Step 1: User starts the full serial batch from RoleFlow**

The user clicks the normal full-batch resume action once. Codex does not click
the control.

- [ ] **Step 2: Monitor serial execution**

Observe logs, database state, bridge status, fixed-tab identity, and risk/login
signals. Do not issue browser actions. Stop analysis at the first ambiguous,
risk, login, page-loss, target-mismatch, or bridge-loss result.

- [ ] **Step 3: Verify the batch result**

For every clicked item, require `click_count=1` and stored outcome evidence.
Require untouched later items to remain `pending`, `click_count=0` if the batch
stops early. Do not retry.

- [ ] **Step 4: Inspect message discovery read-only**

Open or read the existing `/messages?planId=1` page and fixed BOSS communication
tab without sending anything. Verify counts, discovered rows, local job
association, error copy, login/risk state, and browser console/request errors.

- [ ] **Step 5: Report**

Separate:

- verified batch outcomes;
- safety stops or unresolved results;
- message-discovery findings;
- issues requiring code changes;
- claims that remain unverified.
