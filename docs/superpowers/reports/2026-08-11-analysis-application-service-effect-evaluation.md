# Analysis application service effect evaluation

Date: 2026-08-11
Scope: Task 3.3 dashboard semantic-analysis retry extraction only.

## Decision

Accepted for this extraction. The dashboard retry orchestration now lives in a small CommonJS application boundary. Route contracts, task-profile routing, selection/persistence order and offline safety are preserved by the focused smoke fixture and the full offline suite.

## Implemented and dependency direction

- Added `src/application/analysis/index.js` with `retryOneJobAnalysis({ db, input, deps })` and `retryPendingJobAnalyses({ db, input, deps })`.
- The module imports configuration and existing core/storage primitives only: config loading, plan/matching context, pool, runner, scoring, concurrency pool, batches, upsert, and workflow-inventory reconciliation. It imports no dashboard, HTTP, HTML/rendering, CLI, `process.argv`, BOSS or browser module.
- `handleJobAnalysisRetry` now parses the request, calls the service, logs the returned business event, maps a single semantic failure, and redirects/renders its existing HTTP response.
- The prior retry orchestration was removed from that handler rather than retained beside the service. `reconcilePlanWorkflowInventory` now has one core owner in `src/core/workflow_inventory.js`; the application retry path and the server's separate workflow rendering path import that same export.

## Reproducible size measurement

Method: Node reads each UTF-8 file (or `git show 39550b1f27c987d566c5055de317a7b3b9d8f90b:<path>`), splits on CRLF/LF, drops only the terminal separator, and counts all remaining physical lines and trimmed nonblank lines.

| File | Before physical / nonblank | After physical / nonblank | Delta |
| --- | ---: | ---: | ---: |
| `src/dashboard/server.js` | 4061 / 3860 | 4001 / 3801 | -60 / -59 |
| `src/cli.js` | 2471 / 2391 | 2471 / 2391 | 0 / 0 |
| `src/application/analysis/index.js` | 0 / 0 | 102 / 98 | +102 / +98 |

The server/application net is +42 physical / +39 nonblank lines. The authorized core owner adds one small shared reconciliation function; `src/cli.js` has no diff.

## Handler and ownership checks

The retry handler is 35 physical lines when counted from its declaration through its closing brace (the following blank separator is not part of the function). Direct calls in that handler to each of the following are zero: plan/context/dependency lookup, decision-pool selection, config construction, runner creation, batch creation, scoring/decision gate, concurrency pool, upsert, and retry inventory reconciliation.

The application service keeps the original order:

1. model-ready gate; plan and confirmed matching context;
2. frozen one-job or ordered/capped pending pool selection;
3. `batch_screening` runtime config, runner seam and retry batch snapshot;
4. score/readiness gate, bounded analysis and ordered persistence;
5. completed/failed/source-pending aggregation and inventory reconciliation.

No CLI, workflow task/attempt/lease, schema, scoring, model-provider, BOSS/browser, communication or rendering source file has a diff. `src/core/workflow_inventory.js` is the single, explicitly authorized shared core-owner change.

## Fixture evidence

`tests/analysis_application_smoke.js` uses a temporary SQLite database under the project `.runtime` directory and real storage, application and dashboard HTTP paths. Its only double is a controlled runner supplied at the runner seam; selection, ordering, cap, persistence, batch snapshot, real upsert observations, inventory reconciliation and concurrency are asserted from the database and returned service result.

- One-job: fixed concurrency `1`, retry batch keyword/snapshot, persisted complete analysis revision, and workflow inventory update.
- Bulk: real decision-pool order, `isJobAwaitingAction` filter, `maxRetryJobs` cap, product-policy concurrency, plus independent complete/partial/failed/source-pending outcomes.
- Source-pending: no runner invocation and no retry-batch observation write.
- Error gates: model not ready, missing plan/card/job and empty bulk reject before runner execution with current public errors.
- HTTP: offline `batch_screening` runtime routing remains fixed even when the runner seam is supplied; the seam receives that route model config but cannot replace route model readiness/profile resolution. The fixture proves a single `MODEL_TIMEOUT` renders its original code as HTTP 400 with request ID/back-link; mixed bulk failed/source-pending keeps the `303` pending-pool location; and missing plan/job/empty bulk render HTTP 400 `JOB_ANALYSIS_RETRY_FAILED` with the preserved home or queue back-link and request ID.

## Verification evidence

- Initial extraction RED/GREEN: `node tests/analysis_application_smoke.js` failed before production edits with `Cannot find module '../src/application/analysis'`, then passed after extraction.
- Fix round 1 RED/GREEN: the new HTTP assertion first failed with `303 !== 400`; after the narrow runner seam it reached the second RED, `reconcilePlanWorkflowInventory is not a function`; after the core export it exposed a circular-dependency warning, which the warning assertion rejected. The final focused smoke passes with no circular-dependency warning.
- Fresh focused suite: 9 commands passed in 26.290 seconds: analysis application, communication, workflow dashboard, model task profiles, onboarding, semantic pipeline, screening quality, workflow analysis executor and workflow recovery.
- Fresh full offline suite: `node tests/run_all.js` completed with `All 84 offline checks passed.` in 129.675 seconds. No live-model command was run.

These are concrete historical measurements from this worktree run, not a performance guarantee: wall time varies with machine load, process startup and filesystem conditions.

## Remaining coupling and next safe improvement

The service deliberately retains direct use of existing storage/core functions; a repository or generic retry abstraction would add indirection without a second use case. The reconciliation duplication is removed. The next safe improvement, if another retry caller appears, is to decide whether that caller shares the dashboard synchronous semantics before generalizing the application service.
