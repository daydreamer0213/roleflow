# Communication Recovery Minimal Fix Implementation Plan

> **For Codex:** Execute in order with TDD. Keep all browser work fake/offline; do not connect to the user's Edge session.

**Goal:** Prevent stale Edge bindings from reaching the communication child process, and treat an exact successful BOSS `friend_add` response as success even when a generic dialog is visible.

**Architecture:** Reuse the dashboard's existing read-only rebind function immediately before an Edge resume, then run the unchanged communication control path. In the BOSS adapter, move the accepted-network branch ahead of the generic-dialog branch while preserving login, risk, target and unavailable checks.

**Tech Stack:** Node.js CommonJS, built-in `node:assert`, SQLite, existing smoke-test harness.

---

## Task 1: Refresh Edge binding before resume

**Files:**

- Modify: `tests/dashboard_communication_batch_smoke.js`
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/view_models/communication.js`

### Step 1: Add failing dashboard regression tests

Extend the existing fake Edge batch coverage to prove:

- `resume_one` on a paused/interrupted Edge batch with a stored binding invokes the existing rebind inspection before `spawnProcess`;
- the stored binding generation and numeric tab IDs are refreshed before the spawn;
- a rebind scope failure returns 409, keeps the batch non-running, and does not spawn;
- when the execution control is available, the page does not also render the standalone rebind button.

Run:

```powershell
node tests/dashboard_communication_batch_smoke.js
```

Expected: FAIL because control currently spawns without rebind and the page exposes both controls.

### Step 2: Implement the smallest server/UI change

In `src/dashboard/server.js`:

- pass `browserFactory` and `communicationBrowserRebinder` into `handleCommunicationControl`;
- parse the request once;
- for `resume` / `resume_one` only, when the batch is Edge, paused/interrupted, has a stored browser binding, and is not ambiguity-blocked, call the existing `rebindCommunicationBrowser` before `controlCommunicationBatch`;
- use `communicationApiResultAsync` so rebind failure returns before status transition or process spawn.

In `src/dashboard/view_models/communication.js`:

- suppress the standalone rebind button whenever the normal execution control is already visible.

Do not add database fields, transitions, tokens or browser navigation.

### Step 3: Verify Task 1

Run:

```powershell
node tests/dashboard_communication_batch_smoke.js
node tests/communication_application_smoke.js
node tests/communication_store_contract_smoke.js
```

Expected: PASS.

### Step 4: Commit Task 1

```powershell
git add src/dashboard/server.js src/dashboard/view_models/communication.js tests/dashboard_communication_batch_smoke.js
git commit -m "fix: refresh Edge binding before communication resume"
```

## Task 2: Let exact accepted request outrank generic dialog

**Files:**

- Modify: `tests/boss_communication_page_smoke.js`
- Modify: `src/adapters/sites/boss.js`

### Step 1: Add the failing adapter regression test

Create a fake-browser case with:

- one authorized browser click;
- a visible generic `intermediateDialog` containing arbitrary private text;
- an exact `https://www.zhipin.com/wapi/zpgeek/friend/add.json` response with HTTP 200 and business code `0`;
- no legacy success-dialog wording and no extra navigation.

Assert `succeeded`, one click, zero extra navigation, sanitized endpoint evidence, and no private dialog text.
Keep the existing “dialog but no accepted request” assertion unchanged.

Run:

```powershell
node tests/boss_communication_page_smoke.js
```

Expected: FAIL with `COMMUNICATION_USER_ACTION_REQUIRED`.

### Step 2: Reorder the existing conditions

In `BossSiteAdapter.verifyCommunicationResult()`:

- preserve login/risk exceptions and the existing target/unavailable early return;
- if `network.state === "accepted"`, return `succeeded` for the dispatched job with sanitized evidence;
- only then classify a generic dialog as `COMMUNICATION_USER_ACTION_REQUIRED`;
- leave all rejected, conflicting, missing-request and retry behavior unchanged.

Do not inspect greeting text, navigate, reload, click a dialog or perform a second job inspection.

### Step 3: Verify Task 2

Run:

```powershell
node tests/boss_communication_page_smoke.js
node tests/communication_executor_smoke.js
```

Expected: PASS.

### Step 4: Commit Task 2

```powershell
git add src/adapters/sites/boss.js tests/boss_communication_page_smoke.js
git commit -m "fix: trust accepted BOSS communication response"
```

## Task 3: Full verification and release candidate preparation

### Step 1: Run the full offline suite

```powershell
npm test
```

Expected: all offline checks pass.

### Step 2: Review the branch diff

```powershell
git diff --check main...HEAD
git diff --stat main...HEAD
git status --short
```

Confirm no unrelated files, dependencies, migrations, quality-rule changes, or real-browser scripts were added.

### Step 3: Independent correctness review

Review specifically for:

- any path that can spawn after failed rebind;
- any extra browser navigation/click;
- accepted responses from the wrong origin/path;
- login/risk or target mismatch being bypassed;
- accidental retry or second click.

Address only verified findings and rerun affected tests.

### Step 4: Prepare, but do not publish, the next installer

After code verification, update the local prerelease to `0.1.0-beta.4.4`, add concise release notes, build the Windows installer, and verify:

- package and lockfile versions;
- installer filename and SHA-256;
- install payload version;
- existing mutable acceptance data remains excluded from destructive replacement.

Do not install, tag, push or publish without the user's next explicit instruction.
