# Wave 4.5 workflow-store effect evaluation

Date: 2026-08-11
Base: `96087de2c495398808da9d2ed03b25697b23a284`
Worktree branch: `codex/roleflow-wave-4-5-workflow-store`

## Status

- Implemented: yes. The existing workflow persistence owner was moved to `src/storage/workflow_store.js` without a schema, migration, backfill, caller, policy, or behavior redesign.
- Regression-safe: verified by the focused contract, the direct required-child set, and `npm.cmd test` (89/89 offline checks).
- Architecture effect evaluated: yes; details and measured ownership evidence are below.
- Technically accepted after independent review: pending controller independent review. This worker makes no independent-review acceptance claim.
- Human/live acceptance pending: yes. No live acceptance is needed or performed for this storage-only move.
- Deferred: Wave 5. The next planned work is the consolidated Wave 0 evaluation.

## Measured source and blob inventory

| File | Base blob / lines | Final blob / lines | Effect |
| --- | --- | --- | --- |
| `src/core/storage.js` | `1bd0af2ea471329b1bd14707fccf3a9423c5dbc5`; 2,552 physical / 2,436 nonblank | `d1cbbde87c5a5a65ea8c6863e024a6fba6fd9176`; 1,438 / 1,369 | Facade and schema owner retained; workflow owner removed. |
| `src/storage/workflow_store.js` | absent | `728a9343bbbb72a3693dbad9a76d1537ca87db43`; 1,186 / 1,137 | New owner: 37 functions and 2 public constants. |
| `src/storage/storage_shared.js` | `92ce3dfa40a40c5057e53d148337018eb0a13481`; 46 / 38 | `e2758f0d373d4343d0a9b526520d440ea109d949`; 58 / 49 | Owns the unchanged `immediateTransaction` body. |
| `src/storage/communication_store.js` | `230f9b4b5c7f82f0053ae644a85592b2c10c837b`; 613 / 585 | `80f84d815a0936a7573f08c8e15587cdd0bc788a`; 613 / 585 | Only its three workflow imports were repointed. |

The former `storage.js` owner and new workflow store total 2,624 physical / 2,506 nonblank lines, versus 2,552 / 2,436 in the former facade alone. The small mechanical increase is the explicit store imports and 39-export facade destructure, not duplicated workflow bodies: the contract normalizes and compares every moved definition to the frozen Git-base definition. `immediateTransaction` is separately body-compared to base and has exactly one production function body.

## Export, identity, and dependency result

`workflow_store` exports exactly these 39 values: the 37 functions `createWorkflowRun`, `getWorkflowRun`, `getWorkflowRunByCommunicationBatch`, `listWorkflowRuns`, `getActiveWorkflowRun`, `transitionWorkflowRun`, `attachWorkflowScan`, `attachWorkflowScanRun`, `attachWorkflowCommunication`, `requestWorkflowRunConfigurationPause`, `recordWorkflowScanWait`, `recordWorkflowPlatformAccess`, `workflowJobTaskRow`, `jobAnalysisAttemptRow`, `countWorkflowJobTasks`, `insertWorkflowJobTaskRow`, `reactivateWorkflowDetailRequiredTaskRow`, `selectReadyWorkflowJobEntries`, `isWorkflowJobTaskObservationReady`, `settleIncompleteWorkflowJobTaskRows`, `selectClaimableWorkflowJobTaskRow`, `claimWorkflowJobTaskRow`, `insertJobAnalysisAttemptRow`, `incrementWorkflowRunActivity`, `getWorkflowObservationJob`, `listWorkflowJobTaskRows`, `listJobAnalysisAttemptRows`, `getWorkflowJobTaskRow`, `getRunningJobAnalysisAttemptRow`, `finishJobAnalysisAttemptRow`, `failWorkflowJobTaskRow`, `incrementWorkflowTimeoutCounters`, `countWorkflowJobTaskStatuses`, `selectEarliestRetryAvailableAt`, `markWorkflowJobTasksStopped`, `selectExpiredLeaseWorkflowJobTaskRows`, and `completeWorkflowJobTaskRow`; plus `WORKFLOW_RUN_STATUSES` and `WORKFLOW_TIMEOUT_CIRCUIT_OPEN_CODE`.

Fresh static/runtime evidence confirmed export counts `storage/workflow/candidate/job/scan/communication/shared = 136/39/29/26/35/14/9`. Each of the 39 facade values is the same reference as its workflow-store export; `storage.immediateTransaction === storageShared.immediateTransaction`; and `core/communication_batches` remains the identical communication-store object.

```text
existing callers -> core/storage facade -> workflow_store -> storage_shared
                                      -> workflow_store -> core/job_description_readiness
                                      -> workflow_store -> node:crypto
communication_store -> workflow_store  (getWorkflowRun, attachWorkflowCommunication, transitionWorkflowRun)
core/storage.getWorkflowHealthSnapshot -> workflowStore.listWorkflowRuns
```

The store has only the three permitted dependency classes; it does not import `core/storage`, a business store, adapter, application, dashboard, HTTP, CLI, browser, or BOSS module. Loading storage, workflow store, and communication store emitted no circular-dependency warning. There is exactly one `function immediateTransaction(` production body, in `storage_shared`.

## Ownership decisions

- `storage.js` remains the sole schema, migration, backfill, `openDb`, and compatibility-facade owner.
- `workflow_store.js` owns all workflow rows, validation, transitions, SQL readiness fragments, task/attempt/lease persistence, and both public workflow constants.
- `getWorkflowHealthSnapshot` remains in `storage.js` because it is the cross-domain read joining candidate, job, workflow, scan, and communication state; it now directly calls `workflowStore.listWorkflowRuns` and retains all frozen links, limits, row shapes, truncation flags, and read-only behavior.
- The transaction primitive moved unchanged to `storage_shared`; no second database handle or duplicate `BEGIN IMMEDIATE` helper was introduced.

## Transaction-owner inventory

| Site | Frozen base | Final | Evidence |
| --- | --- | --- | --- |
| Workflow scan-link helper | `core/storage.immediateTransaction` | `storage_shared.immediateTransaction`, re-exported by `core/storage` | The normalized helper body is identical; facade and shared references are identical; exactly one `function immediateTransaction(` exists. |
| Workflow store | Helper from the facade | Imports the shared helper | No `function immediateTransaction(` or `BEGIN IMMEDIATE` appears in `workflow_store.js`. |
| Schema migrations | Direct `BEGIN IMMEDIATE` in `core/storage.js` | Direct `BEGIN IMMEDIATE` remains in `core/storage.js` | This pre-existing schema-owner transaction is distinct from the moved helper and remains unchanged. |

## Evidence map

| Evidence type | What it proves |
| --- | --- |
| Direct `workflow_store_contract_smoke.js` | Exact exports/counts/reference identity; store load graph and no circular warning; allowed dependencies; normalized base/current bodies for every moved function/helper/constant; shared transaction identity and single owner; run row shape; invalid transition code/message; and COMMIT-time full-row rollback for both scan-link functions. |
| Required child tests | Existing behavior remains exercised directly: run/link/state behavior (`workflow_storage`); JD readiness, task/attempt/lease/retry/timeouts (`workflow_task_storage` and executor); controls/progress/recovery; health snapshot domains/link issues/read-only behavior; scan and communication integration; migration and communication storage/application contracts. |
| Body-equivalence-only evidence | Private helpers/constants and branches already comprehensively covered by child tests but not independently observable at a public API boundary: `workflowRunRow`, `workflowObservationJobRow`, `nonNegativeInteger`, `workflowRunError`, active/terminal/control sets, detail-required constants, readiness SQL fragments, and transition map. These are explicitly marked as equivalence evidence, not new direct branch coverage. |

Error-code/message evidence remains frozen by normalized body equivalence and existing behavioral contracts: creation/owner/slot errors (`WORKFLOW_RUN_ID_REQUIRED`, `WORKFLOW_OWNER_REQUIRED`, `WORKFLOW_LOCAL_DAY_INVALID`, `WORKFLOW_SEQUENCE_INVALID`, `WORKFLOW_PLAN_PROFILE_MISMATCH`, `WORKFLOW_RUN_SLOT_EXISTS`); state/control/resume errors (`WORKFLOW_RUN_NOT_FOUND`, `WORKFLOW_STATUS_INVALID`, `WORKFLOW_TRANSITION_INVALID`, `WORKFLOW_CONTROL_INVALID`, `WORKFLOW_RESUME_PHASE_INVALID`); scan-link errors (`WORKFLOW_SCAN_LINK_REQUIRED`, `WORKFLOW_SCAN_RUN_REQUIRED`, `WORKFLOW_SCAN_LINK_INVALID`, `WORKFLOW_SCAN_EXECUTION_OWNED`, `WORKFLOW_SCAN_LINK_MISMATCH`); communication-link errors (`WORKFLOW_COMMUNICATION_LINK_REQUIRED`, `WORKFLOW_COMMUNICATION_LINK_INVALID`, `WORKFLOW_COMMUNICATION_LINK_MISMATCH`); and task readiness/batch evidence including `DETAIL_REQUIRED` and `WORKFLOW_TASK_BATCH_MISMATCH`.

## Verification record

| Command | Result | Duration |
| --- | --- | --- |
| Baseline `workflow_health_smoke`, `workflow_storage_smoke`, `workflow_task_storage_smoke` | 3/3 passed | 0.702s |
| Final direct owner contract | passed | 16.802s |
| Direct required-child set (16 files named by the brief) | 16/16 passed | 16.447s |
| Final foreground `npm.cmd test` | 89/89 offline checks passed, exit 0 | 163.399s |
| Static export/dependency/transaction checks | passed: exact 136/39/29/26/35/14/9 exports, 39 facade identities, permitted dependency graph, body inventory, one shared transaction-helper body, and the retained schema-migration transaction | completed after this report update |
| `git diff --check` | passed | completed before report; rerun after report before commit |

SQLite experimental warnings were emitted by Node during offline tests; they are pre-existing runtime warnings and no test reported an assertion failure.

## Weaknesses and next improvements

1. High impact/risk: independent controller review is still required before merge; this report does not replace it.
2. Medium: `tests/communication_store_contract_smoke.js` also updates its exact shared-export count from 8 to 9. Although the brief explicitly names the scan-store assertion, this matching exact architecture assertion needed the same narrowly scoped correction.
3. Low: source ownership remains a large pure move. Future cleanup of the private, currently unused `TERMINAL_WORKFLOW_RUN_STATUSES` must be a separate evidence-backed task.

No real BOSS, browser session, external network, communication, application, or live acceptance action occurred. The offline suite uses local fixtures, temporary databases, and local test HTTP servers only. Communication technical acceptance remains `e2e_pending`. Wave 5 is explicitly deferred; the next task is the consolidated Wave 0 evaluation.
