# RoleFlow Branch Consolidation and Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely merge durable workflow progress and candidate message discovery into `main` with remote rollback checkpoints, then reduce branch/worktree clutter without deleting benchmark evidence.

**Architecture:** Merge the direct v4 continuation first, then integrate the 16 message commits on a new branch based on the updated `main`. Preserve source branches, renumber colliding migrations to v7-v9, require fresh tests and independent review at every `main` boundary, and remove only branches proven reachable from `origin/main`.

**Tech Stack:** Git worktrees and annotated tags, PowerShell 5.1, Node.js 22.5+, CommonJS, built-in `node:sqlite`, plain `node:assert` smoke tests.

## Global Constraints

- Do not access real BOSS, real models, cookies, browser credentials, or the real `data/jobs.sqlite`.
- Keep BOSS communication/application behavior unchanged; this plan authorizes repository integration only.
- Never force-push `main` or an existing shared feature branch.
- Push each pre-merge checkpoint tag before updating `main`.
- Use only D-drive locations for new worktrees, caches, and generated review packages.
- Preserve private benchmark, diagnostic, live-eval, and model A/B branches unless they are separately proven redundant.
- Do not remove Codex-managed worktrees under `C:\Users\Administrator\.codex\worktrees`.
- Do not remove dirty worktrees.
- Every `main` update requires a fresh full offline suite on the resulting `main`.
- Critical and Important review findings must be fixed and re-reviewed before merge.

---

### Task 1: Finalize the durable v4 merge candidate

**Files:**
- Modify: `docs/superpowers/specs/2026-08-09-frontend-ux-roadmap-design.md`
- Create: `docs/superpowers/specs/2026-08-09-branch-consolidation-design.md`
- Create: `docs/superpowers/plans/2026-08-09-branch-consolidation-and-merge.md`

**Interfaces:**
- Consumes: `codex/durable-workflow-progress-v4@e20ed02`, its progress ledger, and the approved branch consolidation design.
- Produces: one clean, reviewed v4 tip ready for checkpointing and fast-forward merge.

- [ ] **Step 1: Confirm the worktree is clean and synchronized**

Run:

```powershell
git status --short --branch
git rev-list --left-right --count origin/codex/durable-workflow-progress-v4...HEAD
```

Expected: no file changes before documentation edits and `0 0` remote comparison.

- [ ] **Step 2: Fix documentation format and add the approved consolidation documents**

Remove trailing whitespace from the UX roadmap. Add the approved design and this execution plan without changing product behavior.

- [ ] **Step 3: Run document and repository checks**

Run:

```powershell
git diff --check
git status --short
```

Expected: `git diff --check` has no output; exactly the three documentation paths are modified/added.

- [ ] **Step 4: Commit the audit documents**

```powershell
git add docs/superpowers/specs/2026-08-09-frontend-ux-roadmap-design.md docs/superpowers/specs/2026-08-09-branch-consolidation-design.md docs/superpowers/plans/2026-08-09-branch-consolidation-and-merge.md
git commit -m "docs: plan staged branch consolidation"
```

- [ ] **Step 5: Run the full v4 offline suite**

```powershell
$env:NODE_PATH = 'D:\Guo\ZhiPing\node_modules'
npm.cmd test
```

Expected: `All 67 offline checks passed.`

- [ ] **Step 6: Run independent whole-branch review**

Review `main..HEAD`, including durable workflow recovery, model task profiles, read-only model settings, detail outcome audit, documentation accuracy, and the merge plan. Critical/Important findings block Task 2.

---

### Task 2: Checkpoint and merge durable v4 into main

**Files:**
- No product file changes expected.
- Git refs: `main`, three `checkpoint/*` tags.

**Interfaces:**
- Consumes: reviewed v4 tip from Task 1.
- Produces: updated `origin/main` and remote rollback points.

- [ ] **Step 1: Record exact SHAs**

```powershell
$mainBefore = git rev-parse main
$v4Tip = git rev-parse codex/durable-workflow-progress-v4
git merge-base --is-ancestor main codex/durable-workflow-progress-v4
```

Expected: ancestor check exits `0`.

- [ ] **Step 2: Create and push pre-merge checkpoints**

```powershell
git tag -a checkpoint/2026-08-09-pre-durable-v4-main $mainBefore -m "main before durable workflow v4 merge"
git tag -a checkpoint/2026-08-09-durable-v4-tip $v4Tip -m "verified durable workflow v4 merge candidate"
git push origin checkpoint/2026-08-09-pre-durable-v4-main checkpoint/2026-08-09-durable-v4-tip
```

- [ ] **Step 3: Check out main in a D-drive integration worktree**

Use `D:\DevData\RoleFlow-worktrees\main-integration`. Verify it is not already registered and create it with:

```powershell
git worktree add D:\DevData\RoleFlow-worktrees\main-integration main
```

- [ ] **Step 4: Fast-forward main**

```powershell
git merge --ff-only codex/durable-workflow-progress-v4
```

Expected: fast-forward only; no merge commit and no conflict.

- [ ] **Step 5: Verify merged main**

```powershell
$env:NODE_PATH = 'D:\Guo\ZhiPing\node_modules'
git diff --check checkpoint/2026-08-09-pre-durable-v4-main..HEAD
npm.cmd test
```

Expected: diff check clean and all 67 offline checks pass.

- [ ] **Step 6: Push main and post-merge checkpoint**

```powershell
git push origin main
git tag -a checkpoint/2026-08-09-post-durable-v4-main HEAD -m "main after verified durable workflow v4 merge"
git push origin checkpoint/2026-08-09-post-durable-v4-main
```

---

### Task 3: Create the message integration branch and preserve source refs

**Files:**
- New worktree: `D:\DevData\RoleFlow-worktrees\durable-message-integration`
- New branch: `codex/integrate-durable-and-message-flow`

**Interfaces:**
- Consumes: updated `main` and `codex/integrate-candidate-progress-message-flow@da2a2cf`.
- Produces: an isolated integration branch without rewriting either source branch.

- [ ] **Step 1: Create and push source checkpoints**

```powershell
git tag -a checkpoint/2026-08-09-pre-message-integration-main main -m "main before candidate message integration"
git tag -a checkpoint/2026-08-09-message-source-tip codex/integrate-candidate-progress-message-flow -m "candidate message integration source tip"
git push origin checkpoint/2026-08-09-pre-message-integration-main checkpoint/2026-08-09-message-source-tip
```

- [ ] **Step 2: Create the integration branch and worktree**

```powershell
git worktree add D:\DevData\RoleFlow-worktrees\durable-message-integration -b codex/integrate-durable-and-message-flow main
```

- [ ] **Step 3: Verify the baseline**

```powershell
git status --short --branch
$env:NODE_PATH = 'D:\Guo\ZhiPing\node_modules'
npm.cmd test
```

Expected: clean branch and all 67 durable-main checks pass.

- [ ] **Step 4: Record the ordered source commits**

```powershell
git rev-list --reverse c013140..codex/integrate-candidate-progress-message-flow
```

Expected: exactly 16 commits ending at `da2a2cf`.

---

### Task 4: Port candidate progress and message discovery onto durable main

**Files:**
- Modify/Create: the files carried by the 16 source commits.
- High-risk overlap: `src/core/storage.js`, `src/core/workflow_inventory.js`, `src/dashboard/server.js`, `tests/storage_migration_smoke.js`.

**Interfaces:**
- Consumes: 16 ordered commits from Task 3.
- Produces: candidate progress, guarded message reading, preview-change discovery, grouped recruiter messages, reply validation, and dashboard integration on the durable-main baseline.

- [ ] **Step 1: Cherry-pick the 16 commits in source order**

Apply one source commit at a time. On conflict, preserve both durable workflow behavior and the message commit's named responsibility. Do not use `ours` or `theirs` for whole files.

- [ ] **Step 2: Add the combined migration expectation before changing migration versions**

Update `tests/storage_migration_smoke.js` to require consecutive migration versions 1 through 9 with:

```text
v6 durable_workflow_progress_v1
v7 candidate_progress_v1
v8 candidate_progress_event_idempotency
v9 message_preview_states_v1
```

- [ ] **Step 3: Run the migration smoke and observe RED**

```powershell
node tests/storage_migration_smoke.js
```

Expected: failure because the imported message migrations still collide with or stop before the required v9 sequence.

- [ ] **Step 4: Renumber only the message migrations**

Keep durable `version: 6`. Set candidate progress to versions 7 and 8, and message preview state to version 9. Do not rewrite migrations 1 through 6.

- [ ] **Step 5: Run migration and owning tests GREEN**

```powershell
node tests/storage_migration_smoke.js
node tests/candidate_progress_storage_smoke.js
node tests/message_preview_state_smoke.js
```

Expected: all three print `ok`.

- [ ] **Step 6: Reconcile every overlapping file**

Inspect all 12 files changed on both branches:

```text
README.md
docs/daily_workflow.md
docs/operations.md
src/adapters/models/openai_compatible.js
src/core/storage.js
src/core/workflow_inventory.js
src/dashboard/server.js
tests/model_adapter_smoke.js
tests/run_all.js
tests/semantic_pipeline_smoke.js
tests/storage_migration_smoke.js
tests/workflow_inventory_smoke.js
```

The combined `tests/run_all.js` must contain 74 unique test filenames.

- [ ] **Step 7: Run focused integration tests**

```powershell
node tests/storage_migration_smoke.js
node tests/workflow_task_storage_smoke.js
node tests/workflow_control_smoke.js
node tests/workflow_progress_smoke.js
node tests/workflow_recovery_smoke.js
node tests/candidate_progress_storage_smoke.js
node tests/message_discovery_smoke.js
node tests/message_reply_contract_smoke.js
node tests/dashboard_message_discovery_smoke.js
node tests/model_adapter_smoke.js
node tests/data_visibility_smoke.js
node tests/communication_smoke.js
```

Expected: every smoke prints `ok`.

- [ ] **Step 8: Commit conflict resolution if cherry-pick sequencing leaves an integration delta**

```powershell
git add -A
git commit -m "fix: reconcile durable and message workflows"
```

Do not create an empty commit.

---

### Task 5: Verify, review, and merge the combined integration

**Files:**
- No new product scope beyond Task 4.
- Git refs: integration branch, `main`, post-message checkpoint.

**Interfaces:**
- Consumes: combined integration branch.
- Produces: verified `origin/main` containing both product lines.

- [ ] **Step 1: Verify repository shape**

```powershell
git status --short --branch
git diff --check main..HEAD
```

Expected: clean worktree and no diff-check output.

- [ ] **Step 2: Run the complete combined suite**

```powershell
$env:NODE_PATH = 'D:\Guo\ZhiPing\node_modules'
npm.cmd test
```

Expected: `All 74 offline checks passed.`

- [ ] **Step 3: Run independent whole-branch review**

Review `main..HEAD` for migration safety, workflow/message state interaction, task-specific model routing, public API privacy, fixed-tab BOSS authority, forbidden browser operations, and preservation of manual communication confirmation.

- [ ] **Step 4: Push the integration branch**

```powershell
git push -u origin codex/integrate-durable-and-message-flow
```

- [ ] **Step 5: Merge into main**

In the main integration worktree:

```powershell
git merge --no-ff codex/integrate-durable-and-message-flow -m "merge: integrate candidate message workflow"
```

- [ ] **Step 6: Re-run the complete suite on merged main**

```powershell
$env:NODE_PATH = 'D:\Guo\ZhiPing\node_modules'
npm.cmd test
```

Expected: `All 74 offline checks passed.`

- [ ] **Step 7: Push main and post-merge checkpoint**

```powershell
git push origin main
git tag -a checkpoint/2026-08-09-post-message-integration-main HEAD -m "main after verified durable and message workflow integration"
git push origin checkpoint/2026-08-09-post-message-integration-main
```

---

### Task 6: Archive the untracked legacy plan and inventory every branch

**Files:**
- Create: `docs/branch-inventory-2026-08-09.md`
- Preserve by tag: `docs/superpowers/plans/2026-08-05-inherited-scope-resume-hardening-completion.md`

**Interfaces:**
- Consumes: all local/remote refs and worktree states after both main merges.
- Produces: an auditable inventory and a tagged archive commit for the untracked legacy plan.

- [ ] **Step 1: Preserve the untracked legacy plan outside main history**

Create a temporary archive branch from `codex/durable-workflow-progress`, commit only the legacy plan, tag that commit as `archive/2026-08-09/inherited-scope-completion-plan`, and push the tag. Keep the repository root on the temporary archive branch while `main` is checked out in `D:\DevData\RoleFlow-worktrees\main-integration`.

- [ ] **Step 2: Generate the inventory**

For every local and remote branch record:

```text
branch
tip
upstream
relation to origin/main
worktree path
dirty state
decision: active / merged-delete / archive-keep / benchmark-keep
```

- [ ] **Step 3: Commit the inventory on main**

```powershell
git add docs/branch-inventory-2026-08-09.md
git commit -m "docs: inventory consolidated branches"
```

- [ ] **Step 4: Verify and push the inventory commit**

Run the full offline suite only if product/runtime files changed after Task 5; otherwise run `git diff --check HEAD^..HEAD` and verify the commit contains only the inventory document. Push `main`.

---

### Task 7: Remove only proven redundant branches and worktrees

**Files:**
- Git refs/worktrees only.

**Interfaces:**
- Consumes: committed inventory and updated `origin/main`.
- Produces: a smaller active workspace with benchmark evidence preserved.

- [ ] **Step 1: Build the deletion allowlist**

A branch is eligible only when:

```powershell
git merge-base --is-ancestor <branch> origin/main
```

exits `0`, the branch is not `main`, and any attached worktree is clean.

- [ ] **Step 2: Remove eligible D-drive worktrees**

Resolve and verify each absolute path is under `D:\DevData` before calling:

```powershell
git worktree remove <exact-path>
```

Do not remove Codex-managed C-drive worktrees.

- [ ] **Step 3: Delete eligible local merged branches**

Use `git branch -d`, never `-D`.

- [ ] **Step 4: Delete eligible remote merged branches**

Delete only remote branches listed as `merged-delete` in the committed inventory and still proven ancestors of `origin/main`.

- [ ] **Step 5: Prune stale worktree registrations**

```powershell
git worktree prune
```

- [ ] **Step 6: Return the repository root to main**

After all main verification and pushes finish:

1. Remove the clean worktree `D:\DevData\RoleFlow-worktrees\main-integration`.
2. Switch `D:\Guo\ZhiPing` from the temporary archive branch to `main`.
3. Verify the archive tag resolves to the preserved document commit.
4. Delete the temporary archive branch with `git branch -d`; the pushed tag remains the recovery ref.

- [ ] **Step 7: Final verification**

```powershell
git fetch --prune origin
git status --short --branch
git branch -vv
git worktree list
git fsck --no-reflogs --unreachable
```

Report remaining branches by active, archive, and benchmark groups. Do not delete unreachable objects; report them only.
