# Workflow Application Service Effect Evaluation

## Implemented

`src/application/workflow/index.js` exports four plain CommonJS functions:
`startWorkflow`, `resumeWorkflow`, `controlWorkflow`, and `getWorkflowStatus`.
They own the extracted orchestration and receive the dashboard-specific browser probe,
dashboard planner, process launcher, logger, and local-child map as ordinary function
dependencies. The module has no imports, so it has no dependency on dashboard HTTP,
HTML/rendering, `process.argv`, or browser adapter modules.

`src/dashboard/server.js` retains body parsing, redirects, JSON/UI error translation,
request IDs, and logging. `startPlanScan` remains the existing process-launch wrapper:
it still owns scan-run creation/binding, `spawn` arguments/options, child-pipe handling,
close/error settlement, and local child-map recovery semantics. `src/cli.js` is unchanged
at 2,471 lines; its argv/output/worker-lifetime responsibility was not a workflow
decision migrated by this task.

## Regression-safe

The new offline `tests/workflow_application_smoke.js` covers the public functions,
plain-data returns, validation-before-persistence/lease/spawn, launch ordering and
distinct workflow/scan/batch bindings, recovery-before-status snapshot, representative
start/resume/control/status outputs, and forwarded scan launch input. It is registered
in `tests/run_all.js`.

Focused checks passed (8 checks, 8.55 s total):

- `workflow_application_smoke.js` — 100 ms
- `workflow_dashboard_smoke.js` — 2,011 ms
- `workflow_control_smoke.js` — 204 ms
- `workflow_recovery_smoke.js` — 434 ms
- `dashboard_scan_lifecycle_smoke.js` — 332 ms
- `scan_cli_lifecycle_smoke.js` — 380 ms
- `scan_end_to_end_recovery_smoke.js` — 4,971 ms
- `workflow_page_migration_smoke.js` — 114 ms (existing Playwright checks skipped because unavailable)

The default offline suite completed with exit code 0 in 128.3 s. It contains 82 checks,
including the new application smoke. The earlier 124 s shell limit timed out without a
test failure; the longer controlled rerun completed successfully.

## Evaluated

| Metric | Before (`72a775f`) | After | Effect |
| --- | ---: | ---: | --- |
| `src/dashboard/server.js` lines | 4,495 | 4,117 | -378 |
| `src/cli.js` lines | 2,471 | 2,471 | 0 |
| `src/application/workflow/index.js` lines | 0 | 376 | +376 |
| HTTP workflow handler direct calls to `getWorkflowRun`, `createWorkflowRun`, `transitionWorkflowRun`, `startPlanScan`, `recoverWorkflowRuns` | 14 | 0 | -14 |
| Application-module dashboard/HTTP/render/argv/browser-adapter imports | 0 | 0 | unchanged |

The four HTTP handler bodies are now 13, 11, 14, and 19 lines. Their direct-call counts
for each of the five prohibited orchestration functions are zero. The 441-line removal
from `server.js` contains the prior handler orchestration; the 376-line application
module is smaller because shared response mapping remains in the adapter and launcher
mechanics remain in `startPlanScan`. This is a move, not a second implementation:
the handlers make one application call and no longer contain branch/state-machine/launch
logic. No core, storage, browser, scoring, or communication implementation changed.

## Accepted for the task evidence gate

The requested direct-call, dependency-direction, focused-test, full-suite, and
no-whitespace-error checks pass. Successful HTTP redirects and current failure mapping
remain in the adapter, while the application functions return only ordinary data.
No real BOSS, model, communication, browser, or network operation was executed.

## Remaining coupling and next safe improvement

The dashboard supplies an explicit dependency bundle because the existing planner,
browser readiness policy, and process launcher still live beside the dashboard adapter.
The next safe improvement is a separately scoped move of the reusable planner/readiness
helpers out of `server.js`; it should retain the same injected shape and add an offline
contract test before moving any browser-facing code.
