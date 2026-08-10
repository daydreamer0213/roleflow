# Communication application service effect evaluation

Date: 2026-08-11

## Decision

Implemented and regression-safe for this extraction, including fix round 1. It is evaluated by offline integration coverage, but is not accepted as live E2E communication evidence: the public calibration DTO remains `implementation=implemented`, `calibration=calibrated`, `acceptance=e2e_pending`, and `executionEnabled=true`.

## Measured extraction effect

| Measure | Physical lines before/after | Nonblank lines before/after | Effect |
| --- | ---: | ---: | --- |
| `src/dashboard/server.js` lines | 4126 → 4061 | 3925 → 3860 | -65 physical / -65 nonblank |
| `src/cli.js` lines | 2471 → 2471 | 2391 → 2391 | unchanged; `communicate` remains the worker adapter |
| Communication application module lines | 0 → 124 | 0 → 117 | one CommonJS module with core-only imports |
| Batch handler direct communication core/storage/launcher calls | n/a | 5 → 0 | one application-boundary call remains |
| Control handler direct communication core/storage/launcher calls | n/a | 15 → 0 | launch seam is passed through composition, not called by the handler |
| Resolve handler direct communication core/storage/launcher calls | n/a | 3 → 0 | one application-boundary call remains |
| Status handler direct communication core/storage/launcher calls | n/a | 0 → 0 | one application-boundary call remains |

Physical lines are `Get-Content <path>.Count` (or the base Git blob's emitted line array); nonblank lines are the same input filtered with `\S`. The numbers above are reproducible from baseline `b75dc8c77f6708ceb6f9940bd09fb51c1ec512e1` and the final working tree.

The moved code is removed from the four HTTP handlers rather than retained there. The new module owns create, control, status, and ambiguous-resolution orchestration; the existing server process launcher remains a seam and retains child-process pipes, close/error settlement, logging, and exact CLI argv construction.

## Import direction and safety checks

`src/application/communication/index.js` imports only existing core modules: communication batches, calibration, observability, and the shared communication-runtime query. It imports no dashboard/HTTP/rendering, `process.argv`, BOSS adapter, DOM, or HTML module.

The extracted paths retain the existing immutable item snapshots, workflow linkage, quota/reservation policy (including 30/60/150), technical execution gate independent of `e2e_pending`, portable CDP port 9222 validation, runtime blocking, interrupted resume repair, ambiguous review stop/no-retry behavior, discard protection, spawn failure settlement, and worker argv/options. Fix round 1 moved `communicationRuntimeBlock` and `assertBossRuntimeAvailable` into one core query used by both server scan callers and the application layer; its DTO, error code, and expired-block handling are unchanged. Executor pacing, locks, fixed tabs, click limit, risk-control stop, browser handling, storage schema, and CLI behavior were not changed.

## Test evidence

Initial RED evidence: `node tests/communication_application_smoke.js` failed with `MODULE_NOT_FOUND` for `../src/application/communication`. A second RED proved control responses incorrectly included `quota`; the application result was narrowed back to the original `{ batch, summary, items }` DTO. A final initial RED proved a missing launcher seam left a batch running; validation now occurs before the state transition.

Fix round 1 RED: a real HTTP control request served without `dbPath` returned `COMMUNICATION_DB_PATH_REQUIRED` but left the batch `running`. The regression now proves synchronous spawn throws, child `error`, and missing `dbPath` all settle the batch as `interrupted`; missing `dbPath` keeps its original public error code. It also calls `resolveAmbiguousCommunication` directly and asserts the plain `{ item, batch, summary }` DTO.

Focused commands completed successfully on 2026-08-11:

```text
communication_application_smoke.js 0.71s
dashboard_communication_batch_smoke.js 1.32s
communication_batch_storage_smoke.js 0.72s
communication_calibration_gate_smoke.js 0.25s
communication_executor_smoke.js 0.37s
communication_cli_authority_smoke.js 0.40s
boss_communication_page_smoke.js 0.20s
workspace_tabs_smoke.js 0.18s
workflow_communication_smoke.js 0.24s
workflow_recovery_smoke.js 0.41s
```

`node tests/run_all.js` completed with exit code 0 in 127.6 seconds (83 registered offline checks). `git diff --check` completed cleanly. The new smoke uses real HTTP requests, a temporary project-local SQLite database, the real dashboard server route path, and real persistence/state assertions. Its only stub is child-process spawn; it never starts a browser, BOSS, model, network request, or communication action.

## Remaining coupling and next safe improvement

`server.js` still owns process-launch mechanics and the application receives only `spawnCommunication`. This keeps child lifecycle and HTTP logging at their current owners. The next safe improvement, if separately scoped, is to move the process-launch seam out of `server.js` without changing browser/executor safety semantics.
