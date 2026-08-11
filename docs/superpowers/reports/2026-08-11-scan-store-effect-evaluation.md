# Task 4.3 scan-store effect evaluation

## Reproducibility

- Baseline blob: `b63b1798b856c2ff786ed82663009208623f05aa`
- Implementation commit: `5fe034c024b56116752829923fd90212752e2925`
- Report correction commit: recorded in Git history after this verification.
- All measurements below use `git show <sha>:<path>` blobs; physical lines include blank lines and nonblank lines exclude them.

| Scope | Baseline physical/nonblank | Current physical/nonblank |
|---|---:|---:|
| `src/core/storage.js` | 3482 / 3295 | 2552 / 2436 |
| `src/storage/scan_store.js` | — | 949 / 892 |
| `src/storage/storage_shared.js` | 35 / 29 | 46 / 38 |
| `src/storage/job_store.js` | 710 / 661 | 710 / 661 |
| `src/storage/candidate_store.js` | 570 / 531 | 570 / 531 |
| all `src/**/*.js` | 34231 / 32201 | 34261 / 32243 |

## Ownership and compatibility

- Facade keys: 136 exactly.
- Candidate store: 29 exports; every facade reference is identical.
- Job store: 26 exports; every facade reference is identical.
- Scan store: exactly 34 operations plus `SCAN_RUN_STATUSES` (35 keys); every operation and the status-array reference are identical from the facade.
- Shared exports are exactly: `nowIso`, `parseJson`, `OUTCOME_STATUSES`, `storageError`, `optionalInteger`, `optionalPositiveInteger`, `nullableText`, `validDate`.
- `scan_store.js` imports only Node `crypto`, `storage_shared`, `job_store`, and `product_policy`; it does not import the facade, schema/openDb owners, workflow/communication/candidate stores, browser, dashboard, CLI, or application modules.
- Candidate/job implementations and schema/migration/dashboard/CLI/application/BOSS/browser/communication/workflow behavior were not changed.

## Contract evidence

`tests/scan_store_contract_smoke.js` exercises all 13 brief contracts with real in-memory SQLite and a temporary project-local two-handle database: export/reference identity; loading/dependency direction; batch/resumable truthy execution; create-and-bind late rollback; lifecycle and terminal idempotency; process-exit inference and rebound protection; orphan/lease handling; progress/target checkpoint atomic rollback; target history/latest/summary; runtime/access isolation and limits; two-handle lease conflict/renew/release/expiry/site isolation; reusable detail threshold/profile/latest/7-day clamp/3-day activity plus refresh attempts; catalog conflict-update/JSON fallback; and facade consumers.

The checkpoint late-failure fixture snapshots `jobs`, `job_observations`, `scan_target_results`, and `scan_runs` before an injected SQLite trigger failure and asserts the complete snapshot is restored. Create-and-bind uses an injected batch trigger and asserts both batch absence and unbound run state.

## Transaction and recovery boundary

The moved operations retain direct `BEGIN IMMEDIATE`/`COMMIT`/defensive direct `ROLLBACK` for binding, run lifecycle, process exit, orphan interruption, checkpoints, and lease acquisition. Checkpoints call `jobStore.upsertJob` inside the outer transaction. Non-transactional read/write operations retain their prior boundary. Error codes and mapped lease payloads are covered by the contract and existing recovery/budget suites.

## Verification

The focused suite was run after implementation and all 14 commands exited 0:

| Command | ms |
|---|---:|
| scan-store contract | 272 |
| candidate contract | 124 |
| job contract | 189 |
| batch consistency | 118 |
| scan recovery | 241 |
| scan CLI lifecycle | 435 |
| scan end-to-end recovery | 4758 |
| site access budget | 444 |
| source acquisition | 346 |
| workflow scan | 1917 |
| workflow recovery | 406 |
| workflow health | 209 |
| dashboard scan lifecycle | 274 |
| storage migration | 957 |

Focused total: approximately 10.8 seconds (PowerShell loop reported 11 seconds).

After the worktree dependency junction was established, a fresh `node tests/run_all.js` completed with exit code 0: `All 87 offline checks passed` in 136.8 seconds, including `scan_store_contract_smoke ok (13 behavior contracts)`. The junction is a local, untracked D: drive reuse of `D:\Guo\ZhiPing\node_modules` at `D:\DevData\RoleFlow-worktrees\wave-4-3-scan-store\node_modules`; it involved no package installation, copying, network access, or source-code change. `git diff --check b63b179..HEAD` is clean.

Validation after `01d652c` confirmed `git diff 01d652c..HEAD -- src tests` is empty: no production or test files changed for this report correction.

## Boundary / remaining work

Scan storage is now a single implementation owner. Workflow, communication, and remaining cross-cutting code stay in the facade as required. Task 4.4 should handle any later workflow/communication ownership move; it is not implemented here.
