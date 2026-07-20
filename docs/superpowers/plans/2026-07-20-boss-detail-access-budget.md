# BOSS Detail Access Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate search-page pane reads from standalone detail navigation and allow one daily scan to inspect up to 240 job details without weakening existing fail-closed controls.

**Architecture:** Add `pane_detail_read` as a first-class site-access action used only by `readCardDetail()`. Keep `detail_open` for standalone detail navigation. Centralize all normal/recovery limits in `product_policy.js` and keep the existing controller, checkpoint, pacing, and communication paths unchanged.

**Tech Stack:** Node.js 22, built-in `node:sqlite`, CommonJS, existing smoke-test runner.

## Global Constraints

- Normal pane budget: 45 per 10 minutes, 240 per hour, 280 per 24 hours.
- Recovery pane budget: 20 per 10 minutes, 80 per hour, 120 per 24 hours.
- Normal standalone detail budget: 8 per 10 minutes, 25 per hour, 60 per 24 hours.
- Recovery standalone detail budget: 5 per 10 minutes, 15 per hour, 30 per 24 hours.
- Daily scan detail total: 240; A target limit 45; B target limit 30.
- Do not change communication budgets or enable the production communication gate.
- Preserve random pacing, checkpoints, cache reuse, and immediate stop on risk/login/page-loss signals.

---

### Task 1: Access action and policy budgets

**Files:**
- Modify: `src/core/product_policy.js`
- Modify: `src/adapters/sites/boss.js`
- Modify: `tests/site_access_budget_smoke.js`
- Modify: `tests/source_acquisition_smoke.js`

**Interfaces:**
- Consumes: `createSiteAccessController().reserve(action, details)` and `BossSiteAdapter.reserveAccess(action, details)`.
- Produces: access events named `pane_detail_read` for search-page card clicks; standalone navigation remains `detail_open`.

- [ ] **Step 1: Add failing policy and adapter tests**

Assert that normal/recovery policies expose the exact new windows, daily scan limits are 240/45/30, `readCardDetail()` reserves `pane_detail_read`, and `readDetail()` continues to reserve `detail_open`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node tests/site_access_budget_smoke.js && node tests/source_acquisition_smoke.js`

Expected: at least one assertion fails because `pane_detail_read` and the new limits do not exist yet.

- [ ] **Step 3: Implement the policy and action split**

Update `PRODUCT_POLICY.dailyScan` and both access modes with the exact values in Global Constraints. Change only the reservation inside `readCardDetail()` from `detail_open` to `pane_detail_read`; leave `navigateWithPacing(..., "detail")` unchanged.

- [ ] **Step 4: Run focused tests and verify success**

Run: `node tests/site_access_budget_smoke.js && node tests/source_acquisition_smoke.js`

Expected: both smoke files pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/core/product_policy.js src/adapters/sites/boss.js tests/site_access_budget_smoke.js tests/source_acquisition_smoke.js
git commit -m "fix: align BOSS detail access budgets"
```

### Task 2: Regression verification

**Files:**
- Verify: `src/core/product_policy.js`
- Verify: `src/adapters/sites/boss.js`
- Verify: `src/core/communication_executor.js`
- Verify: `tests/run_all.js`

**Interfaces:**
- Consumes: Task 1 policy and action names.
- Produces: an offline-verified build ready for a user-approved limited live scan.

- [ ] **Step 1: Run syntax checks**

Run: `node --check src/core/product_policy.js && node --check src/adapters/sites/boss.js`

Expected: both commands exit 0.

- [ ] **Step 2: Run the full offline suite**

Run: `npm.cmd test`

Expected: every offline check passes and communication remains gated off.

- [ ] **Step 3: Check scope and sensitive files**

Run: `git diff --check && git status --short --branch`

Expected: no whitespace errors; user-owned `docs/data_baseline.md`, `docs/session_checkpoint.md`, and `logs/` remain untracked and untouched.

- [ ] **Step 4: Push verified commits**

Run: `git push origin main`

Expected: `origin/main` contains the design, plan, and implementation commits.
