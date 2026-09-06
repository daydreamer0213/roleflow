# Task 2 report — platform conditions, salary, analysis isolation

## Status

Implemented in code commit `3b74233` (`feat: isolate zhaopin platform workflow state`).

## Red / green evidence

Red checks observed before the matching implementation:

1. `D:/hermes/node/node.exe tests/platform_search_context_smoke.js`
   - Failed with `Cannot find module '../src/storage/platform_search_context_store'`.
2. `D:/hermes/node/node.exe tests/zhaopin_analysis_smoke.js`
   - Failed with `ZHAOPIN_SEARCH_PARAM_UNSUPPORTED` for the newly observed `we` condition.
3. The same test then failed against `salaryRangeK('1.5-1.6万·13薪')`, returning nulls because the annual-payment suffix was counted as a range value.
4. `tests/platform_search_context_smoke.js` then failed because `listWorkflowRuns(..., {site:'zhaopin'})` still returned the BOSS row.
5. The migration regression initially failed on the expected v29 migration record; after updating that expectation it exposed a real FK failure during the old workflow-table rebuild. The migration now stages workflow task/attempt children, rebuilds the parent, restores children and indexes, and the migration smoke passes.

Fresh green command (Node runtime and Playwright requirement supplied by the task):

```powershell
$env:NODE_PATH='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'; $env:ROLEFLOW_REQUIRE_PLAYWRIGHT='1'; $env:PATH='D:/hermes/node;' + $env:PATH; $tests = @('tests/platform_search_context_smoke.js','tests/zhaopin_analysis_smoke.js','tests/zhaopin_readonly_smoke.js','tests/inherited_search_scope_smoke.js','tests/workflow_acquisition_smoke.js','tests/scan_snapshot_smoke.js','tests/scoring_url_smoke.js','tests/screening_preferences_smoke.js','tests/job_store_contract_smoke.js','tests/storage_migration_smoke.js'); foreach ($test in $tests) { & 'D:/hermes/node/node.exe' $test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
```

Output: all ten checks printed `... ok`; exit code 0. Node emitted only its existing experimental SQLite warning.

`git diff --check` also exited 0.

## Changes

- Added `search_plan_platform_contexts`, keyed by `(plan_id, site)`, with direct `savePlatformSearchContext` / `getPlatformSearchContext` APIs. It never rewrites `search_plans.plan_json`.
- Added migration v29. Existing workflow rows receive `site='boss'`; the run-slot unique key is now `(profile_id, local_day, site, sequence)`. The migration preserves workflow task and analysis-attempt child records and SQLite foreign keys.
- `listWorkflowRuns` returns all sites when no `site` filter is supplied; an explicit `boss` or `zhaopin` filter is strict. `zhaopin` alone may legally transition `analyzing → completed`.
- BOSS and 智联 leases are mutually exclusive inside one database. Renew/release remain scoped to the actual `site + owner`.
- Added explicit inherited-scope platform dispatch. Old missing-site contexts default to BOSS; a declared context site that conflicts with its scope is rejected.
- 智联 frozen runtime policy comes from `compileZhaopinPlatformRuntimePolicy({searchScope, filterSummary=[]})`. It preserves observed native values (`jl/sl/el/we/ct/cs/et`) as native codes, does not create BOSS city or salary-lane mappings, and keeps `location.cities` empty.
- 智联 scan targets use the common target shape with `laneId: 'native'`; no BOSS target builder or city mapping is used.
- Added observed parameters `we`, `ct`, `cs`, and `et` to the safe 智联 template allowlist; unknown parameters are still rejected.
- `salaryRangeK` now compares monthly Chinese 万/千/元 values, preserves raw salary text, and rejects hourly/day/year/negotiated values as non-monthly.
- BOSS activity scoring only applies to BOSS (including missing-source legacy semantics), not 智联.
- `clientCompany` is stored in jobs and observations, returned in reports and workflow analysis facts, and changes the content hash only when non-empty. Empty/missing legacy BOSS values preserve both hash and model-input JSON shape.

## Risks / boundaries

- The lease is only a same-SQLite-database browser-task mutex; it does not claim to lock another database or manual browser actions.
- 智联 native filters are frozen/read back but are intentionally not turned into semantic local hard filters. In particular `jl=548` remains an observed Guangdong native value, not a BOSS city mapping or a hard comparison against Guangzhou.
- No live browser, real model/data, install, push, merge, release, or full strict baseline was run for this task.
