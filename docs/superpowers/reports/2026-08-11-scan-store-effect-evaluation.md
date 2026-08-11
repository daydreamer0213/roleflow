# Task 4.3 scan-store effect evaluation

## Reproducibility

- Baseline blob: `b63b1798b856c2ff786ed82663009208623f05aa`.
- Scan-storage source snapshot: `9bddbf458e3fbd1a0ba14bb825a088e8eba92470`.
- This fix round changes only `tests/scan_store_contract_smoke.js` and this report; `src` is intentionally unchanged.
- Line measurements use Git blobs; physical lines include the terminal line and nonblank lines exclude whitespace-only lines.

| Scope | Baseline physical/nonblank | Scan-storage snapshot physical/nonblank |
|---|---:|---:|
| `src/core/storage.js` | 3482 / 3295 | 2552 / 2436 |
| `src/storage/scan_store.js` | absent | 949 / 892 |
| `src/storage/storage_shared.js` | 35 / 29 | 46 / 38 |
| `src/storage/job_store.js` | 710 / 661 | 710 / 661 |
| `src/storage/candidate_store.js` | 570 / 531 | 570 / 531 |
| all `src/**/*.js` | 34231 / 32201 | 34261 / 32243 |

## Brief evidence map

| Brief item | Executed evidence and assertions |
|---:|---|
| 1 | `contract01ExportsAndReferences` asserts 136 facade keys, 29 candidate keys, 26 job keys, the exact 34 scan operations plus `SCAN_RUN_STATUSES`, all facade/store references by identity, and the exact eight shared exports. |
| 2 | `contract02LoadGraphAndCircularWarnings` starts a child Node process, loads facade/candidate/job/scan modules, asserts zero exit and no circular-dependency warning, then asserts scan-store direct dependencies are exactly `crypto`, `job_store.js`, `product_policy.js`, and `storage_shared.js`. |
| 3 | `contract03BatchAndResumable` asserts the complete default batch row shape and values, every allowed explicit status, plan/site filtering, terminal resumability, and the existing truthy `filterSnapshot.execution` behavior. |
| 4 | `contract04CreateAndBind` injects a trigger after `scan_runs.batch_id` changes, asserts the trigger hit, observes `BEGIN IMMEDIATE` then `ROLLBACK`, and compares complete `batches`, `scan_runs`, and `site_scan_leases` snapshots. Its success case observes `BEGIN IMMEDIATE` then `COMMIT`; its table-driven gates assert coded failures and unchanged snapshots. |
| 5 | `contract05Lifecycle` asserts the complete scan-run shape; begin observes `BEGIN IMMEDIATE`/`COMMIT`; heartbeat persists; finish synchronizes the batch; equal terminal repetition is accepted and a different terminal state returns `SCAN_RUN_ALREADY_FINISHED`. |
| 6 | `contract06ProcessExit` asserts nonzero exit becomes `failed` with process fields, zero exit follows completed/partial/failed target summaries, and a running rebound preserves its batch. A trigger after terminal batch synchronization must hit, produces `BEGIN IMMEDIATE`/`ROLLBACK`, and restores complete run/batch/target snapshots. |
| 7 | `contract07Orphans` asserts a fresh run remains running, a stale run with an active matching lease remains running, an expired matching lease is removed while its run is interrupted, and an old run interrupted beside a running rebound leaves the shared batch running. |
| 8 | `contract08Checkpoints` injects failure after progress job/observation writes and heartbeat, and after target job/observation/heartbeat/target insert. Both must hit, observe `BEGIN IMMEDIATE`/`ROLLBACK`, and restore complete `jobs`, `job_observations`, `scan_runs`, `scan_target_results`, `batches`, and `site_scan_leases` snapshots; success cases observe `BEGIN IMMEDIATE`/`COMMIT`. Both checkpoint operations table-drive and snapshot missing/unknown/finished run, missing batch/owner, wrong batch/owner/site/plan, missing batch row, non-running batch, and expired lease gates. |
| 9 | `contract09TargetHistoryAndSummary` asserts empty running summary, complete target-result row shape, repeated target attempts, latest-per-target ordering, and completed/failed-derived partial aggregate counts and job total. |
| 10 | `contract10RuntimeAndAccess` asserts complete runtime/access row shapes, runtime upsert/read/clear, access payload normalization, site/action/since filtering, ascending order, limit, and a 10,001-row fixture capped at 10,000 results. |
| 11 | `contract11TwoHandleLease` opens two handles on one project-local temporary SQLite database and asserts mapped lease shape, `SCAN_ALREADY_RUNNING` with `.lease`, renewal ownership loss, release ownership, site isolation, and expired-lease cleanup. |
| 12 | `contract12ReuseRefreshAndCatalog` asserts profile/site isolation, latest reusable observation, 120/119 description behavior, 3-day activity freshness, default/1-day/30-day max-age clamping, refresh numbering/reverse order/limit/error fields, and complete catalog shape, conflict update, and invalid-JSON fallback. |
| 13 | `contract13FacadeConsumers` executes the existing focused CLI, site-budget, workflow, workflow-health, and dashboard scan-lifecycle smoke tests as child processes and asserts each exits zero; it does not use source-text matching as consumer evidence. |

## Verification

The 14 required focused commands all exited 0 after the contract fix.

| Command | ms |
|---|---:|
| scan-store contract | 4055 |
| candidate contract | 129 |
| job contract | 187 |
| batch consistency | 123 |
| scan recovery | 239 |
| scan CLI lifecycle | 421 |
| scan end-to-end recovery | 4925 |
| site access budget | 481 |
| source acquisition | 389 |
| workflow scan | 1920 |
| workflow recovery | 411 |
| workflow health | 244 |
| dashboard scan lifecycle | 302 |
| storage migration | 990 |

Focused total: 14,816 ms.

A fresh `node tests/run_all.js` exited 0 with `All 87 offline checks passed` in 134,029 ms. The previous controller verification remains recorded: 87/87 offline checks in 136.8 seconds.

The worktree `node_modules` remains an untracked D:-drive junction at `D:\DevData\RoleFlow-worktrees\wave-4-3-scan-store\node_modules` to `D:\Guo\ZhiPing\node_modules`; it reused existing dependencies without an install, copy, network request, or source change.

## Boundary

This fix round adds behavior evidence only. Scan storage remains the owner of the 34-operation boundary; no workflow, communication, migration, schema, browser, dashboard, CLI, or BOSS behavior is changed. Task 4.4 remains the later workflow/communication ownership boundary.
