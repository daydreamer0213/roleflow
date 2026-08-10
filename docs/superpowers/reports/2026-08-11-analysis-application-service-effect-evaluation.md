# Analysis application service effect evaluation

Date: 2026-08-11
Scope: Task 3.3 dashboard semantic-analysis retry extraction only.

## Decision

Accepted for this extraction. The dashboard retry orchestration now lives in a small CommonJS application boundary. Route contracts, task-profile routing, selection/persistence order and offline safety are preserved by the focused smoke fixture and the full offline suite.

## Implemented and dependency direction

- Added `src/application/analysis/index.js` with `retryOneJobAnalysis({ db, input, deps })` and `retryPendingJobAnalyses({ db, input, deps })`.
- The module imports configuration and existing core/storage primitives only: config loading, plan/matching context, pool, runner, scoring, concurrency pool, batches, upsert, and workflow-inventory reconciliation. It imports no dashboard, HTTP, HTML/rendering, CLI, `process.argv`, BOSS or browser module.
- `handleJobAnalysisRetry` now parses the request, calls the service, logs the returned business event, maps a single semantic failure, and redirects/renders its existing HTTP response.
- The prior retry orchestration was removed from that handler rather than retained beside the service. The server's separate workflow route retains its pre-existing local inventory helper; the retry flow uses the application module's private equivalent because core workflow files are explicitly out of scope.

## Reproducible size measurement

Method: Node reads each UTF-8 file (or `git show 39550b1f27c987d566c5055de317a7b3b9d8f90b:<path>`), splits on CRLF/LF, drops only the terminal separator, and counts all remaining physical lines and trimmed nonblank lines.

| File | Before physical / nonblank | After physical / nonblank | Delta |
| --- | ---: | ---: | ---: |
| `src/dashboard/server.js` | 4061 / 3860 | 4013 / 3812 | -48 / -48 |
| `src/cli.js` | 2471 / 2391 | 2471 / 2391 | 0 / 0 |
| `src/application/analysis/index.js` | 0 / 0 | 118 / 113 | +118 / +113 |

The net source movement is +70 physical / +65 nonblank lines. This is an extraction cost: the application boundary has explicit imports and a plain result contract, while the HTTP adapter sheds 48 lines of direct retry orchestration. `src/cli.js` has no diff.

## Handler and ownership checks

The retry handler is 36 physical lines. Direct calls in that handler to each of the following are zero: plan/context/dependency lookup, decision-pool selection, config construction, runner creation, batch creation, scoring/decision gate, concurrency pool, upsert, and retry inventory reconciliation.

The application service keeps the original order:

1. model-ready gate; plan and confirmed matching context;
2. frozen one-job or ordered/capped pending pool selection;
3. `batch_screening` runtime config, runner seam and retry batch snapshot;
4. score/readiness gate, bounded analysis and ordered persistence;
5. completed/failed/source-pending aggregation and inventory reconciliation.

No CLI, workflow task/attempt/lease, schema, scoring, model-provider, BOSS/browser, communication or rendering source file has a diff.

## Fixture evidence

`tests/analysis_application_smoke.js` uses a temporary SQLite database under the project `.runtime` directory and real storage, application and dashboard HTTP paths. Its only double is a controlled runner supplied at the runner seam; selection, ordering, cap, persistence, batch snapshot, real upsert observations, inventory reconciliation and concurrency are asserted from the database and returned service result.

- One-job: fixed concurrency `1`, retry batch keyword/snapshot, persisted complete analysis revision, and workflow inventory update.
- Bulk: real decision-pool order, `isJobAwaitingAction` filter, `maxRetryJobs` cap, product-policy concurrency, plus independent complete/partial/failed/source-pending outcomes.
- Source-pending: no runner invocation and no retry-batch observation write.
- Error gates: model not ready, missing plan/card/job and empty bulk reject before runner execution with current public errors.
- HTTP: offline `batch_screening` runtime routing, unchanged `303` queue location, and `409` HTML status/error code/back-link/request-ID behavior.

## Verification evidence

- RED: `node tests/analysis_application_smoke.js` failed before production edits with `Cannot find module '../src/application/analysis'`.
- GREEN: the same command passed after extraction.
- Focused suite: 9 commands passed in 26.607 seconds: analysis application, communication, workflow dashboard, model task profiles, onboarding, semantic pipeline, screening quality, workflow analysis executor and workflow recovery.
- Full offline suite: `node tests/run_all.js` completed with `All 84 offline checks passed.` The persisted runner log started at 05:26:52 and last wrote at 05:29:03 (131 seconds). No live-model command was run.

## Remaining coupling and next safe improvement

The service deliberately retains direct use of existing storage/core functions; a repository or generic retry abstraction would add indirection without a second use case. The only remaining nearby duplication is the small workflow-inventory reconciliation helper still required by a separate server workflow path. A future, separately scoped workflow refactor can move that shared helper into a workflow-owned core module after preserving its route coverage; it is not part of this extraction.
