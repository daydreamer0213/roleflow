# Scan Target Completion Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** The normal workflow overview must not present attempted-but-incomplete search directions as completed.

**Architecture:** Reuse the existing latest per-target result statuses. `remainingTargetKeys` already resumes every status other than completed. Align the read model and both initial/live views with that contract; preserve `processed` as the attempted-result diagnostic count. No new schema or execution behavior.

**Tech Stack:** Existing CommonJS, SQLite, server-rendered page, vanilla browser updates and smoke tests.

## Global Constraints

- Proven live Sep9: batch46 has two completed targets and a partial third with zero jobs after quota rejection; the page showed 3/3 and zero remaining. This is a display defect, not lost work.
- Read root AGENTS.md. Work ONLY in D:/DevData/RoleFlow-worktrees/zhaopin-readonly. You are not alone; preserve others' edits. Main owns live services/browser/DB and temporary authorized quota configuration outside Git.
- No real browser, live DB reads/writes, service restarts, push/merge/package/release, dependency changes, or changes to scanning, matching, access policy, retries, target coverage or resume selection.
- Do not reopen closed phase reviews. Current BASE is c4dd63583d32a89d74db8191d45f46099f301a61; full 157 gate at its unchanged product source already passed. Main owns final full gate after this new source change.

## Task 1: Truthful target completion on initial and live workflow views

**Owned files:** src/core/workflow_progress.js, src/dashboard/view_models/workflow.js, src/dashboard/assets/workflow.js; tests/workflow_progress_smoke.js, tests/workflow_page_migration_smoke.js and narrowly tests/workflow_dashboard_smoke.js if its browser assertions cover live updates. Do not modify other files without reporting the required dependency.

**Interfaces:** Keep snapshot keys and processed/completed/partial/failed diagnostic counts. `scanTargets.pending` means targets still needing completion, including partial/failed/no result. `tracks.scan.value` and overview acquisition fraction use completed. Initial VM and live asset use identical meaning. A completed run can still show pending short JD separately; do not change job counts or workflow state.

- [ ] RED: extend existing synthetic cases to assert statuses completed/completed/partial/failed/no result -> total5, processed4, completed2, partial1, failed1, pending3; track2/5 and remaining3. Add current live-shape case completed/completed/partial for a paused/interrupted scanning-phase Zhaopin workflow -> completed2/3, pending1, rather than 3/3 and zero. Assert newest result completing the partial item clears that remainder. Exercise both initial rendered overview and normal client update using the existing browser test harness; no source-text assertions.

```js
assert.equal(snapshot.progress.scanTargets.processed, 3);
assert.equal(snapshot.progress.scanTargets.completed, 2);
assert.equal(snapshot.progress.scanTargets.pending, 1);
assert.equal(snapshot.progress.tracks.scan.value, 2);
assert.match(snapshot.progress.remainingWorkLabel, /1 个搜索目标/);
```

- [ ] Run the changed focused test before production edits and record actual assertion failure, not missing module or syntax error.
- [ ] Minimal implementation: counts.pending = Math.max(0, counts.total - counts.completed); tracks.scan.value = scanTargets.completed; use completed in initial/live overview fractions. Preserve processed in explicitly labelled processed diagnostics. If caption currently implies completed while showing processed, make the minimum consistent correction. Do not invent another counter or a new generic progress layer.
- [ ] GREEN: run all three named smokes plus changed JS syntax and git diff --check. Runtime D:/hermes/node/node.exe; NODE_PATH=C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules; TEMP/TMP=D:/DevData/RoleFlow-tests; ROLEFLOW_REQUIRE_PLAYWRIGHT=1. Do not run full npm test; main will run it once frozen.
- [ ] Self-review, commit only owned code/tests, and write report with RED/GREEN command and result, exact SHA, files and remaining concerns. Main owns plan checkboxes and final scoped independent review.
