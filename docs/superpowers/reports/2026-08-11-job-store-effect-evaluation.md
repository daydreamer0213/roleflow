# Job Store Effect Evaluation

Date: 2026-08-11
Baseline: `54761dc8de36e358e586f9126ea9b0b5e300ccc0`

## Brief evidence map

| Brief item | Executed evidence |
| --- | --- |
| 1 | `job_store_contract_smoke`: exact 136 facade keys, 29 candidate exports, 26 job-store exports, and direct-reference identity. |
| 2 | `job_store_contract_smoke`: facade, job store, and candidate store load while a warning listener records no circular-dependency warning. |
| 3 | `job_store_contract_smoke`: keyword-source conflict update leaves one updated row; model-cache conflict update and invalid JSON fallback round trip. |
| 4 | `job_store_contract_smoke`: source/sourceId idempotency, observation content hash, and observed outer `BEGIN IMMEDIATE` with no nested begin. |
| 5 | `job_store_contract_smoke`: latest report observation plus profile-specific candidate state versus legacy application state and row fields. |
| 6 | `job_store_contract_smoke`: independent complete/partial/failed/stale/hard-block/risk decision fixtures and ordered quality-governance tags. |
| 7 | `job_store_contract_smoke`: review-before-pending ordering and 55 eligible jobs capped to 50. |
| 8 | `job_store_contract_smoke`: `filterSnapshot.execution` object is selected; array-shaped execution is excluded. |
| 9 | `job_store_contract_smoke`: application, candidate state, recommendation feedback, manual event, event payload, and event-count paths. |
| 10 | `job_store_contract_smoke`: bind/rescore/reassess success `BEGIN`/`COMMIT`; SQLite trigger late failures yield direct `ROLLBACK` and restored atomic snapshots. Rescore uses an isolated two-observation plan and a second-update UDF failure. |
| 11 | `job_store_contract_smoke`: `BATCH_ID_REQUIRED`, `PLAN_ID_REQUIRED`, and `BATCH_PLAN_MISMATCH` reject before analyzer calls and preserve ordered snapshots of all candidate write tables. |
| 12 | Focused `scan_recovery_smoke`, `storage_migration_smoke`, and `workflow_health_smoke` execute facade scan checkpoint, migration hash, and health consumers; the contract also verifies facade/job-store direct references. |

## Structure and dependency result

The facade has 136 exports and direct references to all 26 job-store and 29 candidate-store operations. `job_store.js` owns the moved implementations and imports no facade, schema, migration, openDb, workflow, communication, browser, transport, dashboard, CLI, or application module. The shared module exports only `nowIso`, `parseJson`, `OUTCOME_STATUSES`, `storageError`, `optionalInteger`, and `optionalPositiveInteger`.

Task 4.3 retains `listReusableJobDetails`, `recordJobRefreshAttempt`, `listJobRefreshAttempts`, and `getLatestJobRefreshAttempt`.

## Blob source metrics

All `src/**/*.js` metrics use Git blobs, not the working tree:

- Baseline `54761dc`: **34566 physical / 32519 nonblank**.
- Current: **34231 physical / 32201 nonblank**.

Reproduce with:

```powershell
@'
const { execFileSync } = require('node:child_process');
for (const sha of ['54761dc', 'HEAD']) {
  let physical = 0, nonblank = 0;
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', sha, 'src'], { encoding: 'utf8' })
    .trim().split(/\r?\n/).filter((file) => file.endsWith('.js'));
  for (const file of files) {
    const text = execFileSync('git', ['show', `${sha}:${file}`], { encoding: 'utf8' });
    const lines = text.split(/\r?\n/); if (text.endsWith('\n')) lines.pop();
    physical += lines.length; nonblank += lines.filter((line) => line.trim()).length;
  }
  console.log(sha, physical, nonblank);
}
'@ | node -
```

## Verification

The specified 12 focused offline checks and the 86-check `tests/run_all.js` suite most recently completed with exit code 0. Runtime is environment-dependent; prior full-suite measurements were approximately 135–137 seconds. `git diff --check 54761dc..HEAD` is the required whitespace check.
