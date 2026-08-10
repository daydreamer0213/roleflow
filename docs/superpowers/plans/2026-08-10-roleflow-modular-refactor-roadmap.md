# RoleFlow Modular Refactor Orchestration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `brainstorming` for behavior or visual decisions, `test-driven-development` for behavior changes, `systematic-debugging` for unexpected failures, and `verification-before-completion` before completion claims. Use Ponytail full: reuse existing code, avoid new dependencies, and keep the smallest quality-preserving change.

**Goal:** Gradually modularize RoleFlow, improve the dashboard, validate a scorecard alternative, clarify communication acceptance, and prepare a future platform boundary without changing current safety or recommendation behavior prematurely.

**Architecture:** Keep one Node.js/CommonJS application, one SQLite database, server-side HTML, and existing adapters. Migrate one touched responsibility at a time from the four concentration files into focused modules, with explicit merge gates and rollback tags.

**Tech Stack:** Node.js 22.5+, CommonJS, built-in `node:http`, built-in `node:sqlite`, vanilla HTML/CSS/JavaScript, existing `pdf-parse`; no new production dependencies.

## Global Constraints

- Baseline is `main` commit `e36bee8`.
- Do not access real BOSS pages unless the user separately requests a read-only or communication acceptance action.
- Do not perform real communication or application actions in implementation tasks.
- Preserve one Edge profile, two fixed BOSS tabs, serial work, pacing, cooldowns, checkpoints, and risk-stop behavior.
- Do not lower card coverage, JD coverage, matching quality, recall, or recovery behavior.
- Do not use pre-baseline job history to validate a changed screening policy.
- Do not add React, Vue, Express, an ORM, an injection framework, or a CSS framework.
- Do not install large dependency stores on `C:`. Reuse project/runtime dependencies on `D:` where possible.
- Each implementation task uses its own Codex worktree and branch.
- Each task commits its own work and reports exact commits, changed files, tests, and remaining risks.

## Effect evaluation gate

Passing regression tests proves compatibility; it does not prove that a module is useful or better. Every completed module must therefore produce a short evaluation report before its wave is accepted:

1. Restate the intended user or architecture outcome in measurable terms.
2. Compare the new result with the last valid baseline using the same inputs.
3. Record correctness, safety, recovery, usability, and maintainability evidence separately.
4. List observed weaknesses and rank the next improvements by impact and risk.
5. Distinguish “implemented”, “regression-safe”, “evaluated”, and “accepted”; never collapse them into one completion state.

Evaluation surfaces by module:

| Module | Required effect evidence |
| --- | --- |
| Dashboard | Exact viewport screenshots plus DOM geometry, focus, contrast, reduced-motion, console/network, primary-action visibility, and existing form/API contract checks |
| BOSS detail reading | Fresh-run complete-JD coverage, identity mismatch rate, pause/resume checkpoint behavior, and read-only page evidence |
| Shadow scorecard | Fresh post-baseline precision/recall, tier disagreement, threshold-near stability, repeated-analysis variance, and evidence traceability; no production switch from fixture-only results |
| Communication | Offline contract and ambiguity coverage, then a separately authorized human end-to-end run; technical calibration is not user acceptance |
| Application/storage extraction | Behavior parity, failure/recovery parity, dependency direction, changed responsibility ownership, and concentration-file reduction without line-count gaming |
| Platform boundary | Fake-adapter contract parity first, then per-platform read-only evidence, independent budgets/checkpoints, and no BOSS quality regression |

The repository-scoped `webapp-testing` skill under `.agents/skills/` is a trial tool for dashboard evaluation. Keep it project-local until at least the Wave 2 dashboard acceptance is complete. Retain or promote it only if it catches reproducible issues or materially improves the acceptance workflow; otherwise remove it instead of accumulating unused skills.

---

## Wave 0: Confirmed baseline

### Task 0.1: Preserve current acquisition baseline

**Evidence:**

- `main`: `e36bee8`
- Full checks: 75/75 passed before and after merge
- Design: `docs/superpowers/specs/2026-08-10-boss-search-pane-detail-reuse-design.md`
- Plan: `docs/superpowers/plans/2026-08-10-boss-search-pane-detail-reuse.md`

**No implementation work remains.**

- [x] Search-pane detail activation is merged.
- [x] Exact card/component/pane identity is enforced.
- [x] Normal scan no longer opens standalone detail pages.
- [x] Detail checkpoints and pause/resume fixes are merged.
- [ ] User performs one separate manual “continue current run” acceptance.

The unchecked acceptance item is not delegated because it depends on the user’s logged-in browser and explicit action.

---

## Wave 1: Parallel low-conflict tasks

Run Tasks 1.1, 1.2, and 1.3 concurrently. They have disjoint production write scopes.

### Task 1.1: Dashboard visual system and production-ready prototype

**Owner scope:**

- Create: `docs/superpowers/specs/2026-08-10-roleflow-dashboard-visual-system-design.md`
- Create: `docs/prototypes/roleflow-dashboard/today.html`
- Create: `docs/prototypes/roleflow-dashboard/workflow.html`
- Create: `docs/prototypes/roleflow-dashboard/queue.html`
- Create: `docs/prototypes/roleflow-dashboard/roleflow-dashboard.css`
- Create: `docs/prototypes/roleflow-dashboard/verify.mjs`
- Create: screenshot evidence under `docs/prototypes/roleflow-dashboard/screenshots/`
- Create: machine-readable viewport audit under `docs/prototypes/roleflow-dashboard/screenshots/`

**Do not modify:**

- `src/**`
- `tests/**`
- `data/**`
- any BOSS page or browser state

**Required output:**

- A RoleFlow-specific design system with named colors, typography, spacing, density, status semantics, buttons, forms, tables, cards, focus, and reduced-motion behavior.
- Desktop and narrow-screen layouts using real Chinese product states.
- One clear primary action per page.
- Exact mapping from prototype sections to existing `/plan`, `/workflow`, and `/queue` data.
- No invented backend capability.

**Verification:**

```powershell
git diff --check
```

Render or open all three static prototypes and capture:

- 1440×900
- 1024×768
- 768×1024
- 375×812

**Completion gate:**

The main controller reviews the screenshots and data mapping. No production UI work starts before approval.
The screenshot and DOM checks must run in the same browser page and exact emulated viewport. Persist the verification script and structured results so the claim is independently repeatable.

### Task 1.2: Read-only shadow scorecard

**Owner scope:**

- Create: `scripts/lib/shadow_scorecard.js`
- Create: `scripts/compare-shadow-scorecard.js`
- Create or modify focused offline benchmark tests under `tests/`
- Create: `docs/superpowers/specs/2026-08-10-shadow-scorecard-design.md`
- Create: `docs/superpowers/reports/2026-08-10-shadow-scorecard-offline-baseline.md`

**Do not modify:**

- `src/dashboard/server.js`
- `src/core/decision_policy.js`
- `src/core/four_tier_decision.js`
- `src/core/analysis_revision.js`
- `src/core/storage.js`
- `src/cli.js`
- `src/adapters/**`
- formal recommendation values
- default batch selection
- live database or private benchmark data

**Required interface:**

```js
buildShadowScorecard({
  roleAlignment,
  responsibilityMatches,
  requirementMatches,
  boundaries,
  risks
}, policy)
```

Returns a versioned, read-only object containing:

```js
{
  version,
  dimensions,
  evidenceCoverage,
  hardBoundary,
  score,
  candidateTier,
  reasons
}
```

The exact numeric weights must begin by re-expressing current approved values rather than inventing a new product policy. A candidate score must not overwrite `finalRecommendation`, `decisionBucket`, or `defaultSelectedForBatch`.

The comparison CLI accepts only an explicit offline JSON fixture path and writes its report to an explicit output path. It must not open the live SQLite database, call a model, scan a default project directory, or mutate the input fixture.

**Required checks:**

- Same semantic input always returns the same scorecard.
- Hard boundaries cannot be compensated by points.
- Low evidence coverage cannot become an auto-selected candidate.
- Existing matrix and final recommendation outputs are unchanged.
- No model or browser call occurs.
- No production module imports the new scorecard in Wave 1.

**Verification:**

```powershell
node tests/<existing-or-new-focused-shadow-scorecard-test>.js
npm.cmd test
git diff --check
```

The worker must choose one concrete test filename before implementation and record the exact command in its design/plan. Reuse the current Node assertion style; do not create a parallel test framework.

### Task 1.3: Communication acceptance-state model

**Owner scope:**

- Modify: `src/core/communication_calibration.js`
- Modify: `src/core/product_policy.js`
- Modify: focused communication calibration tests under `tests/`
- Modify: `docs/communication_live_acceptance.md`
- Modify: `docs/boss-communication-calibration.md`
- Create: `docs/superpowers/specs/2026-08-10-communication-e2e-acceptance-state-design.md`

**Do not modify:**

- `src/dashboard/server.js`
- `src/cli.js`
- `src/core/communication_executor.js`
- `src/adapters/**`
- communication selectors, click logic, limits, pacing, or batches
- any real browser or database state

**Required interface:**

Expose a public status that distinguishes:

```js
{
  implementation: "implemented",
  calibration: "calibrated",
  acceptance: "e2e_pending" | "accepted",
  executionEnabled: boolean
}
```

Current state must be:

```js
{
  implementation: "implemented",
  calibration: "calibrated",
  acceptance: "e2e_pending",
  executionEnabled: true
}
```

`executionEnabled` remains the technical gate. It must not imply `accepted`. Existing execution assertions and current batch behavior must remain unchanged.

**Required checks:**

- Current execution gate remains compatible.
- Public status reports `e2e_pending`.
- No call path treats `e2e_pending` as a disabled technical calibration.
- No call path presents `e2e_pending` as full user acceptance.
- Existing calibration error codes remain stable.

**Verification:**

```powershell
node tests/communication_calibration_gate_smoke.js
node tests/communication_executor_smoke.js
node tests/dashboard_communication_batch_smoke.js
npm.cmd test
git diff --check
```

No real communication action is part of this task.

---

## Wave 1 merge gate

The controller merges completed branches one at a time:

1. Communication acceptance state.
2. Shadow scorecard.
3. Dashboard prototype documentation.

Before each merge:

```powershell
git status --short
git diff --check
npm.cmd test
```

After all merges:

```powershell
git status --short
npm.cmd test
```

Create an annotated checkpoint before the first merge and another after Wave 1.

---

## Wave 2: Production dashboard foundation

Start only after Task 1.1 visual review passes and Wave 1 is merged.

### Task 2.1: Extract dashboard shell and local assets

**Files:**

- Create: `src/dashboard/http/response.js`
- Create: `src/dashboard/ui/shell.js`
- Create: `src/dashboard/ui/navigation.js`
- Create: `src/dashboard/assets/roleflow.css`
- Modify: `src/dashboard/server.js`
- Modify: focused dashboard smoke tests

**Interfaces:**

```js
renderPage({ title, currentPath, planId, body, scripts = [] })
renderNavigation({ currentPath, planId })
sendHtml(res, html, statusCode = 200)
sendJson(res, statusCode, body)
escapeHtml(value)
escapeAttr(value)
```

**Behavior constraints:**

- Existing URLs and form fields remain unchanged.
- Assets are served only from a fixed allowlist; no arbitrary file path input.
- Current API responses and error codes remain unchanged.
- No page directly loads an external CDN.
- Existing inline workflow polling may remain inline until its own page migration.

**Verification:**

- Existing dashboard, workflow, queue, communication, settings, onboarding, and startup smoke checks.
- Full offline suite.
- Reproducible browser evaluation using the project-local `webapp-testing` workflow.
- Manual desktop and narrow-screen screenshot comparison.
- A Wave 2 dashboard effect report covering task clarity, first-screen primary action, responsive geometry, accessibility, console/network errors, contract parity, and concrete follow-up improvements.

### Task 2.2: Migrate “Today” page

**Files:**

- Create: `src/dashboard/pages/today.js`
- Create: `src/dashboard/view_models/today.js`
- Modify: `src/dashboard/server.js`
- Modify: focused workflow/dashboard tests

**Interface:**

```js
buildTodayViewModel({ db, planId, scanRuns, modelState, workflowHealth })
renderTodayPage(viewModel)
```

The view model contains only display-ready data and action permissions. The page renderer must not query SQLite or inspect browser state.

**Acceptance:**

- Shows current phase, data-safety statement, blocking reason, progress, and one primary action.
- Advanced scan controls remain available but visually secondary.
- All existing scan and workflow actions still submit the same fields.

### Task 2.3: Migrate workflow page

**Files:**

- Create: `src/dashboard/pages/workflow.js`
- Create: `src/dashboard/view_models/workflow.js`
- Create: `src/dashboard/assets/workflow.js`
- Modify: `src/dashboard/server.js`
- Modify: existing workflow dashboard tests

Preserve pause, resume, stop, polling, immutable communication review, and the recently fixed cooldown/detail checkpoint behavior.

### Task 2.4: Frontend acceptance

Run full offline checks, then perform local dashboard-only visual acceptance. Save the reproducible browser audit and the effect report; a visually appealing screenshot alone is not acceptance. This task must not resume the BOSS workflow.

The user separately decides when to perform the logged-in BOSS “continue current run” acceptance.

---

## Wave 3: Application-use-case extraction

These tasks are sequential because they share `server.js`, `cli.js`, and storage calls.

### Task 3.1: Workflow application service

Create `src/application/workflow/` modules for start, resume, control, and status queries. Route handlers and CLI commands call these modules. Preserve request fields, error codes, transactions, spawned process arguments, scan-run binding, and recovery.

### Task 3.2: Communication application service

Create `src/application/communication/` modules for batch creation, execution control, status, and ambiguous-result resolution. Preserve immutable snapshots, technical execution gate, pacing, safety locks, and user confirmation.

### Task 3.3: Analysis-retry application service

Create `src/application/analysis/` modules for one-job and bulk retry. Preserve model task profile, concurrency, stale-revision checks, complete-JD requirement, and failure states.

Each task must include focused regression, full suite, independent review, and a separate commit.

---

## Wave 4: Storage decomposition

Start after Wave 3 is merged.

Keep `openDatabase` and schema/migrations in `src/core/storage.js` initially. Move only exported operation groups:

1. `src/storage/workflow_store.js`
2. `src/storage/scan_store.js`
3. `src/storage/job_store.js`
4. `src/storage/communication_store.js`
5. `src/storage/candidate_store.js`

Each store accepts an existing SQLite database handle. No store opens a second production database, owns a separate transaction system, or changes schema.

Migrate one store per branch. Do not run these branches in parallel.

---

## Wave 5: Platform capability boundary

### Task 5.1: Registry and fake platform

Create a platform registry and capability declaration without touching real sites. Add a fake second platform that supports only list/detail/template read operations.

### Task 5.2: Route BOSS through registry

Move only adapter selection and capability checks. Preserve BOSS DOM helpers, fixed-tab topology, pacing, limits, checkpoints, and right-pane detail behavior.

### Task 5.3: Decide real second platform

The user selects the platform. A new design requires one separately approved minimum read-only probe before selectors or filter mappings are implemented.

---

## Final completion criteria

- Production dashboard is visually consistent and understandable on desktop and narrow screens.
- `server.js`, `cli.js`, and `storage.js` are smaller because real responsibilities moved, not because code was duplicated.
- Formal recommendation remains protected until a fresh-baseline comparison is approved.
- Communication clearly reports `e2e_pending` until manual end-to-end acceptance succeeds.
- BOSS acquisition behavior from `e36bee8` remains intact.
- All automated tests remain offline.
- Every merged wave has rollback tags and post-merge full-suite evidence.
