# Job Store Effect Evaluation

Date: 2026-08-11
Baseline: `54761dc8de36e358e586f9126ea9b0b5e300ccc0`

## Fix round 1 evidence map

`tests/job_store_contract_smoke.js` maps brief items 1–6 and 9 directly to SQLite assertions: export/no-cycle; profile and legacy report state; independent complete/partial/failed/stale/hard-block/risk decisions; governance ordering and queue cap; execution-object filtering; application/candidate/feedback/event payloads; and outer `BEGIN IMMEDIATE` upsert. Items 7–8 and 10–12 are exercised by the named focused storage/semantic/scan/health smoke checks. The prior 86/86, 131-second suite result is a historical measurement, not a runtime guarantee.

Reproduce source metrics with `node -e "for (const f of ['src/core/storage.js','src/storage/job_store.js','src/storage/storage_shared.js']) { const a=require('fs').readFileSync(f,'utf8').split(/\r?\n/); console.log(f,a.length,a.filter(x=>x.trim()).length) }"`; run it at the baseline and current SHA for before/after totals.

The contract now executes all transaction evidence directly: `upsertJob` under observed outer `BEGIN IMMEDIATE` has no nested begin; bind and rescore each have observed `BEGIN/COMMIT` and a trigger-induced `BEGIN/ROLLBACK` with pre-state restored; reassess has a successful call plus a trigger-induced write failure after analyzer invocation and restores its observation row. Its three validation codes are separately rejected with analyzer count zero and stable observation count. These are execution assertions, not source-reading claims.

Fix round 2 mapping: 1 exports/direct refs/no cycle; 2 profile and legacy report rows; 3 independent decision precedence; 4 governance order plus review/pending queue ordering and a 55-job cap assertion; 5 execution-object filter; 6 application/state/feedback/event round trips; 7 success transaction sequences; 8 trigger rollback snapshots (rescore has two observations and compares the complete ordered batch snapshot); 9 outer upsert sequence; 10 three gate full-table snapshots with analyzer zero; 11 scan/health/migration remains covered by focused `scan_recovery_smoke`, `workflow_health_smoke`, and `storage_migration_smoke` execution; 12 keyword conflict update, cache, hash and idempotent observation assertions. Reproduce all source totals before/after with `git ls-tree -r --name-only <SHA> src | rg '\.js$' | % { $a=Get-Content $_; $p+=@($a).Count; $n+=@($a|?{$_.Trim()}).Count }; "$p $n"`.

## Structure and ownership

- `src/core/storage.js`: 3482 physical / 3295 nonblank lines; it exports exactly 136 public keys.
- `src/storage/job_store.js`: 710 physical / 661 nonblank lines; it directly exports exactly the required 26 operations.
- `src/storage/candidate_store.js`: unchanged from baseline, remains 570 physical / 531 nonblank lines and its 29 direct facade references are unchanged.
- `src/storage/storage_shared.js`: 35 physical / 29 nonblank lines. Its complete export set is exactly `nowIso`, `parseJson`, `OUTCOME_STATUSES`, `storageError`, `optionalInteger`, and `optionalPositiveInteger`.

The facade reference audit returned `facade=136`, `job=26`, `jobDirect=true`, `candidate=29`, and `candidateDirect=true`. Each moved operation and its job-only helpers have one implementation owner in `job_store.js`; the facade holds direct references only. `levelRank` and `hardRiskRank` had no callers and were not moved.

## Dependency and behavior evidence

`job_store.js` imports only Node crypto, storage shared, the candidate `getSearchPlan` boundary, and existing core policy/normalization modules. It has no `core/storage`, schema, migration, openDb, workflow, communication, browser, transport, dashboard, CLI, or application import. The facade retains schema/migration/scan/health ownership and calls job-store references for observation-hash migration, scan checkpoint job writes, and health report/event reads. No circular-load warning was observed.

The contract and focused smoke checks exercised keyword/cache conflict update plus JSON fallback, job idempotency and outer transaction composition, observation/report row mapping, candidate and legacy application state paths, quality/decision precedence, queue ordering, scan execution filtering, feedback/event payloads, and cross-domain facade consumption. Existing transaction implementations retain deferred `BEGIN`, direct `COMMIT`/`ROLLBACK`, no transaction in `upsertJob`, and the reassessment validation codes `BATCH_ID_REQUIRED`, `PLAN_ID_REQUIRED`, and `BATCH_PLAN_MISMATCH` before analyzer/write work. The full suite also preserves source acquisition refresh behavior because `listReusableJobDetails` and refresh-attempt operations remain in the facade for Task 4.3.

## Verification

- Focused offline checks: 12/12 passed in 7.951 s: job/candidate contracts, data visibility, screening, semantic pipeline, scan recovery, batch consistency, outcome analytics, communication, workflow health, analysis application, and source acquisition.
- Full offline suite: 86/86 passed. `tests/run_all.js` began at 07:00:11 and completed at 07:02:22 (131 s); the previous foreground attempt was stopped only by its 120 s command limit, without a test failure.
- `git diff --check 54761dc8de36e358e586f9126ea9b0b5e300ccc0`: passed before commit.

## Remaining boundary

Task 4.3 remains responsible for `listReusableJobDetails`, `recordJobRefreshAttempt`, `listJobRefreshAttempts`, and `getLatestJobRefreshAttempt`. Scan/workflow/cross-cutting schema, migrations, health and transaction orchestration remain in the facade by design; this task did not change JD coverage, scoring, recommendation policy, models, BOSS/browser, communication, workflow task, or lease behavior.
