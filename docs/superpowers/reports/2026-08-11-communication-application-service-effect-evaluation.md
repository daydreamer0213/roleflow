# Communication application service effect evaluation

Date: 2026-08-11

## Decision

Implemented and regression-safe for this extraction. It is evaluated by offline integration coverage, but is not accepted as live E2E communication evidence: the public calibration DTO remains `implementation=implemented`, `calibration=calibrated`, `acceptance=e2e_pending`, and `executionEnabled=true`.

## Measured extraction effect

| Measure | Before | After | Effect |
| --- | ---: | ---: | --- |
| `src/dashboard/server.js` lines | 3925 | 3873 | -52 lines |
| `src/cli.js` lines | 2391 | 2391 | unchanged; `communicate` remains the worker adapter |
| Communication application module lines | 0 | 130 | one CommonJS module, core/storage-only imports |
| Batch handler direct communication core/storage/launcher calls | 5 | 0 | one application-boundary call remains |
| Control handler direct communication core/storage/launcher calls | 15 | 0 | launch seam is passed through composition, not called by the handler |
| Resolve handler direct communication core/storage/launcher calls | 3 | 0 | one application-boundary call remains |
| Status handler direct communication core/storage/launcher calls | 0 | 0 | one application-boundary call remains |

The moved code is removed from the four HTTP handlers rather than retained there. The new module owns create, control, status, and ambiguous-resolution orchestration; the existing server process launcher remains a seam and retains child-process pipes, close/error settlement, logging, and exact CLI argv construction.

## Import direction and safety checks

`src/application/communication/index.js` imports only existing `core/storage`, `core/communication_batches`, `core/communication_calibration`, and `core/observability`. It imports no dashboard/HTTP/rendering, `process.argv`, BOSS adapter, DOM, or HTML module.

The extracted paths retain the existing immutable item snapshots, workflow linkage, quota/reservation policy (including 30/60/150), technical execution gate independent of `e2e_pending`, portable CDP port 9222 validation, runtime blocking, interrupted resume repair, ambiguous review stop/no-retry behavior, discard protection, spawn failure settlement, and worker argv/options. Executor pacing, locks, fixed tabs, click limit, risk-control stop, browser handling, storage schema, and CLI behavior were not changed.

## Test evidence

RED was recorded before production code: `node tests/communication_application_smoke.js` failed with `MODULE_NOT_FOUND` for `../src/application/communication`. A second RED proved control responses incorrectly included `quota`; the application result was narrowed back to the original `{ batch, summary, items }` DTO. A final RED proved a missing launcher seam left a batch running; validation now occurs before the state transition.

Focused commands completed successfully on 2026-08-11:

```text
communication_application_smoke.js 0.50s
dashboard_communication_batch_smoke.js 1.35s
communication_batch_storage_smoke.js 0.69s
communication_calibration_gate_smoke.js 0.24s
communication_executor_smoke.js 0.38s
communication_cli_authority_smoke.js 0.43s
boss_communication_page_smoke.js 0.19s
workspace_tabs_smoke.js 0.18s
workflow_communication_smoke.js 0.23s
workflow_recovery_smoke.js 0.39s
```

`node tests/run_all.js` completed with exit code 0 in 126.1 seconds (82 registered offline checks). `git diff --check` completed cleanly. The new smoke uses real HTTP requests, a temporary project-local SQLite database, the real dashboard server route path, and real persistence/state assertions. Its only stub is child-process spawn; it never starts a browser, BOSS, model, network request, or communication action.

## Remaining coupling and next safe improvement

`server.js` still owns process-launch mechanics and the shared runtime-block helper used by non-communication routes; the application receives only `spawnCommunication`. This keeps child lifecycle and HTTP logging at their current owners. The next safe improvement, if separately scoped, is to place the shared runtime-block reader behind a core query helper used by both scan and communication paths; it must not change browser/executor safety semantics.
