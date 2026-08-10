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

The offline `tests/workflow_application_smoke.js` covers the public functions,
plain-data returns, application-boundary validation and launch delegation,
recovery-before-status snapshot, and representative start/resume/control/status outputs.
The related `tests/workflow_dashboard_smoke.js` uses the real HTTP adapter, temporary
SQLite database, real `startPlanScan`, and only a child-process spawn stub to prove
workflow/scan/batch binding and actual argv/options before spawn.

Focused checks passed (8 checks, 8.55 s total):

- `workflow_application_smoke.js` — 100 ms
- `workflow_dashboard_smoke.js` — 2,011 ms
- `workflow_control_smoke.js` — 204 ms
- `workflow_recovery_smoke.js` — 434 ms
- `dashboard_scan_lifecycle_smoke.js` — 332 ms
- `scan_cli_lifecycle_smoke.js` — 380 ms
- `scan_end_to_end_recovery_smoke.js` — 4,971 ms
- `workflow_page_migration_smoke.js` — 114 ms (existing Playwright checks skipped because unavailable)

Fix-round focused checks passed (8 checks, 8.43 s total), and the default 82-check
offline suite completed with exit code 0 in 123.6 s. The controller also confirmed the
strict `workflow_page_migration_smoke.js` browser/evaluator checks pass with the bundled
Playwright `NODE_PATH`.

## Evaluated

| Metric | Before (`72a775f`) | After | Effect |
| --- | ---: | ---: | --- |
| `src/dashboard/server.js` lines | 4,495 | 4,126 | -369 |
| `src/cli.js` lines | 2,471 | 2,471 | 0 |
| `src/application/workflow/index.js` lines | 0 | 382 | +382 |
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

## Fix round 1/5

Independent review found that the first application smoke recorded scan persistence,
binding, and spawn inside one fake. A real HTTP/SQLite RED then showed the initial
workflow reached the spawn boundary with an empty `scanRunId`, even though the scan run
already existed. `startPlanScan` now reuses the existing transactional
`attachWorkflowScanRun` operation for first launches and retains `attachWorkflowScan`
for resume-batch launches.

The real dashboard spawn hook verifies, before returning a child:

- workflow and scan persistence;
- workflow-to-scan and resume-batch binding;
- initial, resume-batch, and analysis-only argv distinctions;
- executable, `cwd`, `windowsHide`, and stdio options.

Upstream inherited-context rejection still returns the existing `409` contract and now
proves no workflow, scan run, or spawn was created. The focused RED failed in 378 ms;
the first GREEN passed in 508 ms.

## Fix round 2/5

A plan-scoped SQLite trigger forced the real initial workflow-to-scan binding operation
to fail before child spawn. The RED preserved HTTP `400`, public
`ERR_SQLITE_ERROR`, request ID, stable error message, zero spawn, and a failed scan run,
but found the workflow incorrectly remained `scanning`.

`startWorkflow` now uses the same injected `settleFailedWorkflowLaunch` dependency as
resume/control when `spawnScan` throws, then rethrows the original error. No transition
logic was copied into the HTTP adapter or launcher. The workflow reaches the existing
recoverable `interrupted` state immediately with the original code/message, while the
public HTTP mapping remains unchanged. Resume-batch binding continues through
`attachWorkflowScan`.

- RED: `node tests/workflow_dashboard_smoke.js` — expected failure in 1,881 ms
  (`scanning` versus `interrupted`).
- First GREEN: `node tests/workflow_dashboard_smoke.js` — exit 0 in 2,275 ms.
- Final focused checks: 8/8 passed; the seven non-page checks took 8.19 s and strict
  `workflow_page_migration_smoke.js` took 46.48 s.
- Full suite: all 82 checks passed in 165.7 s with bundled Playwright `NODE_PATH`, so
  the workflow page browser/evaluator checks ran without skips.

## Remaining coupling and next safe improvement

The dashboard supplies an explicit dependency bundle because the existing planner,
browser readiness policy, and process launcher still live beside the dashboard adapter.
The next safe improvement is a separately scoped move of the reusable planner/readiness
helpers out of `server.js`; it should retain the same injected shape and add an offline
contract test before moving any browser-facing code.
