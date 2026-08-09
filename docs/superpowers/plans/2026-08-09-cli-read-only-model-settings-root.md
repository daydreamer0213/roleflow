# CLI Read-only Model Settings Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the current candidate CLI run a real model scan using an explicitly supplied external settings root without copying or writing credentials.

**Architecture:** Keep model-path safety in `src/core/model_settings.js`: it resolves a canonical external project root and rejects unsafe locations, while a `readOnly` flag prevents legacy credential migration. `src/cli.js` uses this only for `scan` runtime model resolution; all dashboard and settings-save paths retain the candidate code root.

**Tech Stack:** Node.js CommonJS, built-in `fs`/`path`/`os`, existing smoke-test runner.

## Global Constraints

- Run all work in `C:\Users\Administrator\.codex\worktrees\a9d9\ZhiPing`; it is an isolated worktree.
- Never copy, move, print, commit, or write a model setting, endpoint, API key, DPAPI file, prompt, JD, resume, or model response.
- `--model-settings-root` is explicit and scan-only; no environment-variable fallback and no dashboard wiring.
- An external root must be an existing local absolute directory outside the current worktree, user home, and system temp; it must contain `.runtime/settings/model.json`.
- External-root loading must never migrate legacy settings or secrets. It must fail with a stable error code instead.
- Tests are offline and must not access BOSS, a browser, or a real model endpoint.

---

### Task 1: Make external model settings loading safely read-only

**Files:**
- Modify: `src/core/model_settings.js`
- Modify: `tests/model_settings_smoke.js`

**Interfaces:**
- Produces: `resolveReadOnlyModelSettingsRoot(rawRoot, { worktreeRoot, homeRoot, tempRoot })`, returning a canonical external root or throwing a stable `MODEL_SETTINGS_ROOT_*` error.
- Extends: `loadModelSettings({ root, fallbackModelConfig, readOnly })`, `resolveRuntimeModelConfig({ ..., readOnly })`, and `resolveRuntimeBatchBackup({ ..., readOnly })`.
- Consumed by: Task 2's scan-only CLI context resolver.

- [ ] **Step 1: Write the failing smoke assertions**

Add assertions that a valid external fixture root resolves, while a relative path, URL, current worktree, configured home/temp roots, and a root without `.runtime/settings/model.json` reject. Add a schema-v1 fixture assertion that `loadModelSettings({ readOnly: true })` throws `MODEL_SETTINGS_READ_ONLY_MIGRATION_REQUIRED` and leaves the fixture file hash unchanged.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node tests/model_settings_smoke.js`

Expected: failure because `resolveReadOnlyModelSettingsRoot` is not exported and read-only legacy loading does not yet reject.

- [ ] **Step 3: Implement the smallest safe loader changes**

Add canonical-path validation using existing Node modules. Resolve only existing directories, reject unsafe locations and missing `.runtime/settings/model.json`, and expose no setting content. In `loadModelSettings`, when `readOnly === true` and a stored setting needs legacy migration, throw `MODEL_SETTINGS_READ_ONLY_MIGRATION_REQUIRED` before `migrateLegacySecret`. Pass the flag through both runtime resolver functions. Preserve all default, writable current-root behavior.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `node tests/model_settings_smoke.js`

Expected: `model_settings_smoke ok` and no warnings or network access.

- [ ] **Step 5: Commit the isolated task**

Run:

```powershell
git add src/core/model_settings.js tests/model_settings_smoke.js
git commit -m "feat: add read-only model settings root guard"
```

### Task 2: Route scan model resolution through the explicit root

**Files:**
- Modify: `src/cli.js`
- Create: `tests/cli_model_settings_root_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: `resolveReadOnlyModelSettingsRoot` from Task 1.
- Produces: `resolveScanModelSettingsContext(args, { root = ROOT, pathPolicy = {} } = {})`, returning `{ root, readOnly: false }` without the flag and a validated external `{ root, readOnly: true }` with it. `pathPolicy` is only an injectable test seam passed to Task 1's validator; production calls use no override.
- Behavior: `scan` passes this context to both `resolveRuntimeModelConfig` and `resolveRuntimeBatchBackup`; no other command changes its runtime root.

- [ ] **Step 1: Write a failing CLI-context smoke test**

Create `tests/cli_model_settings_root_smoke.js`. It must import the exported context resolver, construct a temporary fixture containing only a schema-v2 mock `.runtime/settings/model.json`, and use the explicit `pathPolicy` test seam so that the fixture itself is not treated as the real OS temp root. Assert: default context uses the candidate `ROOT` with `readOnly: false`; explicit external context uses the canonical fixture with `readOnly: true`; an unsafe root throws the Task 1 stable error. Add this test to `tests/run_all.js`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node tests/cli_model_settings_root_smoke.js`

Expected: failure because the CLI context resolver is absent.

- [ ] **Step 3: Implement the scan-only routing**

Implement and export `resolveScanModelSettingsContext(args)`. Call it in `scan` immediately before primary/backup runtime model resolution, forwarding its `root` and `readOnly` values to both existing resolver calls. Add one help line documenting `--model-settings-root <external-root>` as a scan-only, read-only option. Do not pass it to `dashboard`, any save API, logs, SQLite, or workflow planner.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
node tests/model_settings_smoke.js
node tests/cli_model_settings_root_smoke.js
```

Expected: both report success; no network or browser access.

- [ ] **Step 5: Commit the isolated task**

Run:

```powershell
git add src/cli.js tests/cli_model_settings_root_smoke.js tests/run_all.js
git commit -m "feat: allow scan to use external model settings"
```

### Task 3: Verify the candidate before the live V4 retest

**Files:**
- Verify only: `src/core/model_settings.js`, `src/cli.js`, their focused smoke tests, and `tests/run_all.js`

- [ ] **Step 1: Review the diff against the design**

Confirm that the only new external path consumer is `scan`, every external-root load has `readOnly: true`, and no dashboard or save route receives the root.

- [ ] **Step 2: Run the full offline suite serially**

Run: `node tests/run_all.js`

Expected: every offline check passes, including `cli_model_settings_root_smoke.js`; run it alone to avoid the known local port collision from concurrent suites.

- [ ] **Step 3: Record the exact tested commit and resume V4**

Record the commit hash and test summary in `.superpowers/sdd/progress.md`. Then use the explicit external root only for the bounded V4 BOSS-SEARCH scan, preserving all existing read-only, serial pacing, no-communication rules.
