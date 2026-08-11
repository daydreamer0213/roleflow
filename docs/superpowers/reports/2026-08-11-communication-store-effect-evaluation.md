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

## Evidence classes

- **Direct contract (`D`)** means `communication_store_contract_smoke.js` performs the assertion itself against the storage owner and real SQLite behavior.
- **Child test (`C`)** means the direct contract launches an unchanged existing consumer test through the core compatibility path and requires its process to exit zero. Child coverage is not described as a direct assertion by the new contract.
- **Baseline body equivalence (`B`)** means the production body from the first `const BATCH_STATUSES` through `module.exports` is byte-normalized with LF and SHA-256 compared. Baseline core and current store both hash to `7bd73727cdbdcada79064f0e657fb316e91a9c30676b25423f81fcadebae76b9`. This proves the moved state-machine body is unchanged; it does not replace behavior tests. Imports are intentionally excluded because their ownership paths changed.

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

- immutable policy/job snapshots, including portable browser `{ mode: "portable", cdpPort: 9222 }` and a real `communicationCalibrationStatus()` snapshot with `acceptance: "e2e_pending"` and `executionEnabled: true`;
- creation success `BEGIN IMMEDIATE -> COMMIT`, and injected late commit failure `BEGIN IMMEDIATE -> ROLLBACK` with every SQLite table count restored;
- China-day quota (`limit`, `used`, `reserved`, `remaining`), two-handle recheck, and persistent pending reservation;
- empty/duplicate/invalid URL/already-applied selection errors without partial rows;
- batch/item aliases, state guards, row keys/conversions, summary shape, terminal and optimistic-CAS behavior;
- click audit exact payload, click count zero-to-one, injected audit rollback, and cross-batch duplicate-click rejection;
- reservation rollback, interrupted resume/requires-review, and ambiguous resolver validation/evidence/audit;
- late manual-resolution failure from a fixture-targeted TEMP trigger on `candidate_progress_events` insert. Its condition requires the referenced target `candidate_progress_cards` row to exist, proving `ensureProgressCard` already wrote inside `SAVEPOINT candidate_progress_verified`. The observed sequence is `BEGIN IMMEDIATE`, `SAVEPOINT`, `ROLLBACK TO`, `RELEASE`, outer `ROLLBACK`; full row-content equality holds for `communication_batch_items`, `events`, `candidate_progress_cards`, and `candidate_progress_events`. The item remains ambiguous, no manual-resolution audit survives, candidate progress is unchanged, and the trigger is dropped in `finally` without entering the production schema.

Child-process evidence covers unchanged core-facade consumers in `communication_batch_storage_smoke.js`, `communication_executor_smoke.js`, `communication_calibration_gate_smoke.js`, `communication_cli_authority_smoke.js`, `communication_application_smoke.js`, `dashboard_communication_batch_smoke.js`, `workflow_communication_smoke.js`, `workflow_end_to_end_smoke.js`, `workflow_recovery_smoke.js`, and `storage_migration_smoke.js`.

The five direct transaction owners remain in the store: `createCommunicationBatch`, `pauseCommunicationBatchAfterReservationFailure`, click-dispatch `transitionCommunicationItem`, `resumeInterruptedCommunicationBatch`, and `resolveAmbiguousCommunicationItem`. Each retains direct `BEGIN IMMEDIATE`, `COMMIT`, and defensive `ROLLBACK`; successful manual resolution additionally retains the pre-existing `candidate_progress_verified` savepoint.

## Error mapping

`D` is the direct contract; `CBS`, `WCS`, `DCBS`, and `CAS` are respectively `communication_batch_storage_smoke.js`, `workflow_communication_smoke.js`, `dashboard_communication_batch_smoke.js`, and `communication_application_smoke.js`; `B` is baseline body equivalence with no dedicated exact owner assertion.

| Code | Condition and exact message | Test/evidence |
| --- | --- | --- |
| `WORKFLOW_RUN_NOT_FOUND` | Missing workflow ID — `workflow run was not found` | `B` |
| `WORKFLOW_COMMUNICATION_LINK_MISMATCH` | Plan/profile differs from workflow — `communication plan does not belong to this workflow run` | `B` |
| `WORKFLOW_COMMUNICATION_LINK_INVALID` | Workflow is not in review — `workflow communication can only be confirmed during review` | `B` |
| `WORKFLOW_COMMUNICATION_ALREADY_LINKED` | Workflow already has a batch — `workflow run already has a communication batch` | `B` |
| `WORKFLOW_COMMUNICATION_BROWSER_MISMATCH` | Browser authority differs — `communication browser mode differs from the workflow browser authority` | `WCS` |
| `WORKFLOW_COMMUNICATION_SELECTION_LIMIT` | Selection exceeds target plus buffer — `workflow selection exceeds target and replacement buffer` | `B` |
| `WORKFLOW_COMMUNICATION_PORTABLE_CDP_PORT_INVALID` | Portable workflow port is not integer 9222 — `portable workflow communication requires fixed CDP port 9222` | `WCS` |
| `COMMUNICATION_PLAN_INVALID` | `planId` is not positive — `planId is required` | `D` |
| `COMMUNICATION_PLAN_NOT_FOUND` | Plan row missing — `communication plan not found` | `B` |
| `COMMUNICATION_BROWSER_MODE_INVALID` | Mode is not edge/portable — `browserMode must be edge or portable` | `D` |
| `COMMUNICATION_QUOTA_EXHAUSTED` | Selection exceeds remaining quota — `communication selection exceeds the remaining daily quota` | `D`, `CBS`, `DCBS` |
| `COMMUNICATION_JOB_INELIGIBLE` | Empty/invalid/duplicate or filtered job — `at least one jobId is required`, `invalid jobId`, `jobIds must not contain duplicates`, or `job <id> is not eligible for communication` | `D`, `CBS`, `DCBS` |
| `COMMUNICATION_BATCH_INVALID` | Batch ID is not positive — `batchId is required` | `B` |
| `COMMUNICATION_BATCH_NOT_FOUND` | Batch row missing — `communication batch not found` | `B` |
| `COMMUNICATION_BATCH_STATUS_INVALID` | Unknown status or resume target not interrupted — `invalid communication batch status` / `resume requires an interrupted communication batch` | `B` |
| `COMMUNICATION_BATCH_TERMINAL` | Transition from terminal batch — `terminal communication batch cannot resume` | `D`, `CBS` |
| `COMMUNICATION_BATCH_TRANSITION_INVALID` | Edge absent from batch graph — `invalid communication batch transition` | `D`, `CBS` |
| `COMMUNICATION_BATCH_ITEMS_UNFINISHED` | Complete requested with nonterminal items — `communication batch cannot complete while items remain unfinished` | `D`, `CBS` |
| `COMMUNICATION_BATCH_TRANSITION_CONFLICT` | Batch CAS/resume CAS loses — `communication batch status changed before transition` / `communication batch changed before resume` | `CBS` |
| `COMMUNICATION_RESERVATION_ROLLBACK_CONFLICT` | Batch/item reservation state or item CAS changed — `communication reservation rollback state changed` / `communication item changed before reservation rollback` | `D` |
| `COMMUNICATION_ITEM_INVALID` | Item ID is not positive — `itemId is required` | `B` |
| `COMMUNICATION_ITEM_NOT_FOUND` | Item missing or belongs to another batch — `communication item not found` / `communication item not found in batch` | `B` |
| `COMMUNICATION_ITEM_STATUS_INVALID` | Expected/target status unknown — `valid expectedStatus and status are required` | `B` |
| `COMMUNICATION_ITEM_TERMINAL` | Transition from non-ambiguous terminal item — `terminal communication item cannot transition` | `B` |
| `COMMUNICATION_ITEM_TRANSITION_INVALID` | Edge absent from item graph — `invalid communication item transition` | `CBS` |
| `COMMUNICATION_ITEM_TRANSITION_CONFLICT` | Item CAS loses — `communication item status changed before transition` | `D` |
| `COMMUNICATION_AMBIGUOUS_RESOLUTION_REQUIRED` | Generic transition used for ambiguous item — `ambiguous items must use the resolver` / `terminal communication item cannot transition` | `D` |
| `COMMUNICATION_AMBIGUOUS_RESOLUTION_INVALID` | Resolution is not succeeded/stopped — `ambiguous items can only resolve to succeeded or stopped` | `CBS`, `DCBS` |
| `COMMUNICATION_AMBIGUOUS_EVIDENCE_REQUIRED` | Manual note empty — `manual resolution evidence is required` | `D`, `CBS`, `CAS`, `DCBS` |
| `COMMUNICATION_CLICK_TRANSITION_INVALID` | Non-verified path targets click dispatch — `only verified items can dispatch a click` | `B` |
| `COMMUNICATION_CLICK_ALREADY_DISPATCHED` | Same item/job already clicked — `communication click was already dispatched` | `D`, `CBS` |
| `COMMUNICATION_CLICK_AUDIT_REQUIRED` | Audit object missing — `click dispatch requires an audit event` | `CBS` |
| `COMMUNICATION_CLICK_AUDIT_INVALID` | Event type/keys/context mismatch — `invalid click audit event` / `invalid click audit workflow context` | `B` |

The direct store contract now persists the real calibration object in the immutable batch policy and asserts:

```js
batch.policySnapshot.calibration.acceptance === "e2e_pending"
batch.policySnapshot.calibration.executionEnabled === true
```

The calibration child test independently checks the full calibration API shape. `e2e_pending` is neither converted to accepted nor used to disable the calibrated path.

## Verification

| Command | Result | Duration |
| --- | --- | ---: |
| 14 focused offline checks listed in Task 4.4 | pass | 21,029 ms |
| `node tests/run_all.js` | `All 88 offline checks passed.` | 142,598 ms |
| Review-fix focused contract plus 10 explicit child tests | 11/11 pass | 15,637 ms |
| Review-fix `npm.cmd test` | exit 0; 88 offline checks pass | 154.2 s |
| Review-fix round 2 RED with old three-statement expectation | expected fail; actual adds `ROLLBACK TO` and `RELEASE` | 0.4 s |
| Review-fix round 2 focused contract | pass | 7,904 ms |
| Review-fix round 2 relevant child set | 10/10 pass | 7,530 ms |
| Review-fix round 2 `npm.cmd test` | exit 0; 88 offline checks pass | 141.3 s |

The full suite emitted Node's known experimental SQLite warning. Its workflow-page smoke also reported Playwright unavailable and skipped only its optional browser checks; the test itself passed. No real BOSS page, browser control, communication, application, network request, or production database was used.

## Scope and limitations

Changed implementation scope is limited to the facade move, new owner, contract registration, and this report. `src/core/storage.js`, its schema/migration/backfill behavior, all caller/executor/application/dashboard/CLI/adapter/browser files, storage shared, candidate/job/scan stores, workflow operations, and policy/calibration settings are unchanged.

No human E2E communication acceptance is claimed. `acceptance` remains `e2e_pending`; Task 4.5 has not been implemented.
