# Communication store effect evaluation

Base: `cfd826f4bcbf0b2c0ff2bc9cbff590476e058f5e`.

## Result

The complete runtime communication batch/item state machine has one owner: `src/storage/communication_store.js`. `src/core/communication_batches.js` is exactly:

```js
module.exports = require("../storage/communication_store");
```

The core facade and storage owner are the same exported object. The contract verifies the exact 14 keys and strict reference identity for every Set and function.

## Git-blob metrics

Metrics were calculated from `git show <base>:<path>` and the staged index blobs (`git show :<path>`), counting physical and nonblank lines.

| Blob | Physical | Nonblank |
| --- | ---: | ---: |
| Baseline `src/core/communication_batches.js` | 613 | 585 |
| Current core compatibility facade | 1 | 1 |
| Current `src/storage/communication_store.js` | 613 | 585 |
| Baseline all `src/**/*.js` (90 files) | 34,261 | 32,243 |
| Current all `src/**/*.js` (91 files) | 34,262 | 32,244 |

The one-line facade accounts for the all-source delta. The state-machine body remains single-copy in the storage owner.

## Boundary and dependency evidence

The contract checks these unchanged boundaries: core storage 136 exports, candidate store 29, job store 26, scan store 35 (34 operations plus `SCAN_RUN_STATUSES`), and shared store 8. It also checks the direct stable facade references for `getSearchPlan`, `listDecisionPool`, and `listSiteAccessEvents`, and captures no circular-dependency warning during module load.

```text
callers -> core/communication_batches facade -> storage/communication_store
communication_store -> candidate_store.getSearchPlan
communication_store -> job_store.listDecisionPool
communication_store -> scan_store.listSiteAccessEvents
communication_store -> core/storage.{getWorkflowRun,attachWorkflowCommunication,transitionWorkflowRun}
```

The final line is the intentional temporary Task 4.4 dependency. Task 4.5 must repoint it to `workflow_store`. The moved owner imports current policy/helpers from core, not the communication facade. The unused `reconcileCommunicationOutcome` import was removed.

## Runtime contract evidence

`tests/communication_store_contract_smoke.js` uses in-memory SQLite and a temporary SQLite file below `D:\DevData`; it sends no request and opens no browser. It proves:

- immutable policy/job snapshots, including portable browser `{ mode: "portable", cdpPort: 9222 }`;
- creation success `BEGIN IMMEDIATE -> COMMIT`, and injected late commit failure `BEGIN IMMEDIATE -> ROLLBACK` with every SQLite table count restored;
- China-day quota (`limit`, `used`, `reserved`, `remaining`), two-handle recheck, and persistent pending reservation;
- empty/duplicate/invalid URL/already-applied selection errors without partial rows;
- batch/item aliases, state guards, row keys/conversions, summary shape, terminal and optimistic-CAS behavior;
- click audit exact payload, click count zero-to-one, injected audit rollback, and cross-batch duplicate-click rejection;
- reservation rollback, interrupted resume/requires-review, ambiguous resolver validation/evidence/audit, and candidate-progress savepoint;
- unchanged real core-facade consumers as child tests: storage, executor, calibration, CLI, application, dashboard, workflow and migration.

The five direct transaction owners remain in the store: `createCommunicationBatch`, `pauseCommunicationBatchAfterReservationFailure`, click-dispatch `transitionCommunicationItem`, `resumeInterruptedCommunicationBatch`, and `resolveAmbiguousCommunicationItem`. Each retains direct `BEGIN IMMEDIATE`, `COMMIT`, and defensive `ROLLBACK`; successful manual resolution additionally retains the pre-existing `candidate_progress_verified` savepoint.

The frozen coded-error surface exercised by the state machine remains:

```text
WORKFLOW_RUN_NOT_FOUND
WORKFLOW_COMMUNICATION_LINK_MISMATCH
WORKFLOW_COMMUNICATION_LINK_INVALID
WORKFLOW_COMMUNICATION_ALREADY_LINKED
WORKFLOW_COMMUNICATION_BROWSER_MISMATCH
WORKFLOW_COMMUNICATION_SELECTION_LIMIT
WORKFLOW_COMMUNICATION_PORTABLE_CDP_PORT_INVALID
COMMUNICATION_PLAN_INVALID
COMMUNICATION_PLAN_NOT_FOUND
COMMUNICATION_BROWSER_MODE_INVALID
COMMUNICATION_QUOTA_EXHAUSTED
COMMUNICATION_JOB_INELIGIBLE
COMMUNICATION_BATCH_INVALID
COMMUNICATION_BATCH_NOT_FOUND
COMMUNICATION_BATCH_STATUS_INVALID
COMMUNICATION_BATCH_TERMINAL
COMMUNICATION_BATCH_TRANSITION_INVALID
COMMUNICATION_BATCH_ITEMS_UNFINISHED
COMMUNICATION_BATCH_TRANSITION_CONFLICT
COMMUNICATION_RESERVATION_ROLLBACK_CONFLICT
COMMUNICATION_ITEM_INVALID
COMMUNICATION_ITEM_NOT_FOUND
COMMUNICATION_ITEM_STATUS_INVALID
COMMUNICATION_ITEM_TERMINAL
COMMUNICATION_ITEM_TRANSITION_INVALID
COMMUNICATION_ITEM_TRANSITION_CONFLICT
COMMUNICATION_AMBIGUOUS_RESOLUTION_REQUIRED
COMMUNICATION_AMBIGUOUS_RESOLUTION_INVALID
COMMUNICATION_AMBIGUOUS_EVIDENCE_REQUIRED
COMMUNICATION_CLICK_TRANSITION_INVALID
COMMUNICATION_CLICK_ALREADY_DISPATCHED
COMMUNICATION_CLICK_AUDIT_REQUIRED
COMMUNICATION_CLICK_AUDIT_INVALID
```

`communication_calibration_gate_smoke.js` continues to prove the separate technical/human states:

```js
{ implementation: "implemented", calibration: "calibrated", acceptance: "e2e_pending", executionEnabled: true }
```

`e2e_pending` is neither converted to accepted nor used to disable the calibrated path.

## Verification

| Command | Result | Duration |
| --- | --- | ---: |
| 14 focused offline checks listed in Task 4.4 | pass | 21,029 ms |
| `node tests/run_all.js` | `All 88 offline checks passed.` | 142,598 ms |

The full suite emitted Node's known experimental SQLite warning. Its workflow-page smoke also reported Playwright unavailable and skipped only its optional browser checks; the test itself passed. No real BOSS page, browser control, communication, application, network request, or production database was used.

## Scope and limitations

Changed implementation scope is limited to the facade move, new owner, contract registration, and this report. `src/core/storage.js`, its schema/migration/backfill behavior, all caller/executor/application/dashboard/CLI/adapter/browser files, storage shared, candidate/job/scan stores, workflow operations, and policy/calibration settings are unchanged.

No human E2E communication acceptance is claimed. `acceptance` remains `e2e_pending`; Task 4.5 has not been implemented.
