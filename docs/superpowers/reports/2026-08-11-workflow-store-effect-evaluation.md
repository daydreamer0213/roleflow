# Wave 4.5 workflow-store effect evaluation

Date: 2026-08-11
Base: `96087de2c495398808da9d2ed03b25697b23a284`
Worktree branch: `codex/roleflow-wave-4-5-workflow-store`

## Status

- Implemented: yes. The existing workflow persistence owner was moved to `src/storage/workflow_store.js` without a schema, migration, backfill, caller, policy, or behavior redesign.
- Regression-safe: verified by the focused contract, the direct required-child set, and `npm.cmd test` (89/89 offline checks).
- Architecture effect evaluated: yes; details and measured ownership evidence are below.
- Technically accepted after independent review: production architecture was independently reviewed as strong; fix-round-1 evidence findings are addressed here, but controller re-review is still pending. This report does not claim final independent acceptance.
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
| Direct `workflow_store_contract_smoke.js` | Exact exports/counts/reference identity; store load graph and no circular warning; allowed dependencies; normalized base/current bodies for every moved function/helper/constant; shared transaction identity and single owner; run row shape; exact owner errors listed below; COMMIT-time full-row rollback for both scan-link functions; and a direct in-memory health fixture covering jobs, workflow runs, candidate events, all three link issues, simultaneous truncation, exact row shapes, and an all-table row-content read-only snapshot. |
| Required child tests | Existing behavior exercised by the named child itself: remaining run/link/state paths (`workflow_storage`); JD readiness, task/attempt/lease/retry/timeouts (`workflow_task_storage`, `workflow_scan_analysis`, and executor); controls/progress/recovery; the established health child; scan and communication integration; migration and communication storage/application contracts. A passing child process is regression evidence for that child, not direct evidence inside the owner contract and not exact-message evidence unless the child asserts the message. |
| Body-equivalence-only evidence | The contract normalizes every moved definition against the frozen base. For branches marked B below, that source equivalence is the only evidence for the exact wording; it is not represented as direct runtime coverage. Private helpers/constants remain in this class unless a public direct assertion observes their effect. |

### Exact workflow error evidence

Evidence classes: **D** = direct owner-contract assertion of the exact trigger, code, and message; **C** = named child exercises the behavior but does not prove the exact message unless stated; **B** = normalized frozen-base/current body equivalence only for the exact wording. The inventory covers errors thrown or persisted by the 37 workflow-store functions; health-query validation remains owned by `core/storage` and is outside this moved-owner error inventory.

| Code | Triggering condition | Exact message | Evidence |
| --- | --- | --- | --- |
| `WORKFLOW_RUN_ID_REQUIRED` | Generated/provided run ID trims to empty | `workflow run id is required` | B (`createWorkflowRun` supplies a UUID for ordinary empty input, so no direct trigger is claimed) |
| `WORKFLOW_OWNER_REQUIRED` | Profile or plan is absent after normalization | `workflow run profile and plan are required` | D `workflow_store_contract_smoke` |
| `WORKFLOW_LOCAL_DAY_INVALID` | Local day is not `YYYY-MM-DD` | `workflow local day must use YYYY-MM-DD` | D `workflow_store_contract_smoke` |
| `WORKFLOW_SEQUENCE_INVALID` | Sequence is not 1, 2, or 3 | `workflow run sequence must be 1, 2, or 3` | D `workflow_store_contract_smoke`; C `workflow_storage_smoke` |
| `WORKFLOW_PLAN_PROFILE_MISMATCH` | Plan is missing or belongs to another profile | `workflow plan does not belong to the selected profile` | D `workflow_store_contract_smoke` |
| `WORKFLOW_RUN_SLOT_EXISTS` | Profile/local-day/sequence unique slot already exists | `workflow run slot already exists for this local day` | D `workflow_store_contract_smoke`; C `workflow_storage_smoke` |
| `WORKFLOW_RUN_NOT_FOUND` | Transition or link target does not exist | `workflow run was not found` | D `workflow_store_contract_smoke` (transition path); B for identical link-path wording |
| `WORKFLOW_STATUS_INVALID` | Requested status is outside `WORKFLOW_RUN_STATUSES` | `workflow run status is invalid` | D `workflow_store_contract_smoke` |
| `WORKFLOW_TRANSITION_INVALID` | Requested edge is absent from the transition graph | ``workflow run cannot transition from ${current.status} to ${nextStatus}`` | D `workflow_store_contract_smoke` for `scanning` → `communicating`; C `workflow_storage_smoke`; B for all other interpolated edges |
| `WORKFLOW_CONTROL_INVALID` | Control state is not `none`, `pause_requested`, or `stop_requested` | `workflow run control state is invalid` | D `workflow_store_contract_smoke` |
| `WORKFLOW_RESUME_PHASE_INVALID` | Non-null resume phase is not `scanning` or `analyzing` | `workflow run resume phase is invalid` | D `workflow_store_contract_smoke` |
| `WORKFLOW_SCAN_LINK_INVALID` | Scan link attempted outside scanning/analyzing/interrupted | `workflow execution can only be attached during scanning, analyzing, or interruption` | D `workflow_store_contract_smoke` |
| `WORKFLOW_SCAN_LINK_REQUIRED` | Full scan link lacks scan-run ID or batch ID | `scan run and batch are required` | D `workflow_store_contract_smoke` |
| `WORKFLOW_SCAN_RUN_REQUIRED` | Run-only scan link lacks scan-run ID | `scan run is required` | D `workflow_store_contract_smoke` |
| `WORKFLOW_SCAN_EXECUTION_OWNED` | Scan-run ID is attached to another workflow | `scan execution is already attached to another workflow run` | D `workflow_store_contract_smoke`; C `workflow_storage_smoke` |
| `WORKFLOW_SCAN_LINK_MISMATCH` | Existing scan-batch ID differs | `workflow run is already attached to another scan` | D `workflow_store_contract_smoke` |
| `WORKFLOW_SCAN_LINK_MISMATCH` | Rebinding while prior scan is missing/running/wrong-plan/wrong-batch | `workflow run is already attached to another active scan` | D for prior-running case in `workflow_store_contract_smoke`; B for the other predicates |
| `WORKFLOW_SCAN_LINK_MISMATCH` | Full scan run/batch is missing, non-running, cross-plan, or mutually mismatched | `scan run or batch does not belong to this workflow plan` | B |
| `WORKFLOW_SCAN_LINK_MISMATCH` | Run-only scan is missing, non-running, or cross-plan | `scan run does not belong to this workflow plan` | B |
| `WORKFLOW_COMMUNICATION_LINK_INVALID` | Communication link attempted before review/interruption | `communication can only be attached after review` | D `workflow_store_contract_smoke` |
| `WORKFLOW_COMMUNICATION_LINK_REQUIRED` | Communication batch ID is absent | `communication batch is required` | D `workflow_store_contract_smoke` |
| `WORKFLOW_COMMUNICATION_LINK_MISMATCH` | Existing communication batch differs | `workflow run is already attached to another communication batch` | D `workflow_store_contract_smoke` |
| `WORKFLOW_COMMUNICATION_LINK_MISMATCH` | Batch is missing or has a different profile/plan owner | `communication batch does not belong to this workflow run` | D `workflow_store_contract_smoke` |
| `WORKFLOW_TASK_BATCH_MISMATCH` | Entry observation/job does not belong to the requested batch | ``job ${jobId} (observation ${observationId}) does not belong to batch ${batchId}`` | C `workflow_task_storage_smoke` and `workflow_scan_analysis_smoke` for code/rollback; B for exact interpolated wording |
| `DETAIL_REQUIRED` | Incomplete/unverified JD is settled as skipped | No thrown message; persisted with kind `waiting_for_detail` | C `workflow_task_storage_smoke` and `workflow_scan_analysis_smoke`; B for constants/SQL |
| `MODEL_TIMEOUT_CIRCUIT_OPEN` | Timeout count reaches configured circuit threshold | No thrown message; persisted as workflow `error_code` | C `workflow_task_storage_smoke`, `workflow_analysis_executor_smoke`, and `workflow_recovery_smoke`; B for constant/update body |

### Exact plain validation evidence

| Triggering condition | Exact message | Evidence |
| --- | --- | --- |
| Non-integer `profileId` in create/list | `profileId must be an integer` | B (shared validator and moved call sites) |
| Non-positive `profileId` in create/list | `profileId must be a positive integer` | B |
| Non-integer `planId` in create/list | `planId must be an integer` | B |
| Non-positive `planId` in create/list | `planId must be a positive integer` | B |
| Non-integer `sequence` in create | `sequence must be an integer` | B |
| Non-positive `sequence` in create | `sequence must be a positive integer` | B |
| Non-integer `scanBatchId` in full scan link | `scanBatchId must be an integer` | B |
| Non-positive `scanBatchId` in full scan link | `scanBatchId must be a positive integer` | B |
| Non-integer `communicationBatchId` in lookup/link | `communicationBatchId must be an integer` | B |
| Non-positive `communicationBatchId` in lookup/link | `communicationBatchId must be a positive integer` | B |
| Non-positive/non-integer task ID in attempt listing | ``listJobAnalysisAttemptRows requires a positive integer taskId, got ${taskId}`` | D `workflow_store_contract_smoke` for `0`; B for other interpolated values |

## Verification record

| Command | Result | Duration |
| --- | --- | --- |
| Baseline `workflow_health_smoke`, `workflow_storage_smoke`, `workflow_task_storage_smoke` | 3/3 passed | 0.702s |
| Fix-round RED: direct health contract sentinel | failed as intended because direct health evidence was not implemented, exit 1 | 0.322s |
| Final direct owner contract (5 contracts, including direct health) | passed, exit 0 | 18.060s |
| Standalone `workflow_health_smoke.js` child | passed, exit 0 | 0.213s |
| Direct required-child set (16 files named by the brief) | 16/16 passed, exit 0 | 18.623s |
| Final foreground `npm.cmd test` | 89/89 offline checks passed, exit 0 | 186.764s |
| Static export/dependency/transaction checks | passed: exact 136/39/29/26/35/14/9 exports, 39 facade identities, permitted dependency graph, body inventory, one shared transaction-helper body, and the retained schema-migration transaction | completed after this report update |
| `git diff --check` | passed | completed before report; rerun after report before commit |

SQLite experimental warnings were emitted by Node during offline tests; they are pre-existing runtime warnings and no test reported an assertion failure. The unrelated private full-chain smoke took its documented `public prepare deferred until clean worktree` branch because this fix round had an intentional test/report diff; its offline gates passed.

## Weaknesses and next improvements

1. High impact/risk: controller re-review of fix round 1 is still required before merge; this report does not declare its own final independent acceptance.
2. Medium: rows marked B in the error map preserve exact wording through frozen-base/current body equivalence but do not have direct runtime trigger coverage. Add direct fixtures only if independent review requires stronger branch evidence; no production behavior depends on this report classification.
3. Low: `workflow_page_migration_smoke` skipped its Playwright browser/evaluator checks because Playwright was unavailable in `NODE_PATH`; the storage-only contract and all 89 offline checks still passed.
4. Low: source ownership remains a large pure move. Future cleanup of the private, currently unused `TERMINAL_WORKFLOW_RUN_STATUSES` must be a separate evidence-backed task.

No real BOSS, browser session, external network, communication, application, or live acceptance action occurred. The offline suite uses local fixtures, temporary databases, and local test HTTP servers only. Communication technical acceptance remains `e2e_pending`. Wave 5 is explicitly deferred; the next task is the consolidated Wave 0 evaluation.
