# 跨平台通用筛选 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add strict, platform-neutral region and company-size filters to generated Search Plans, with platform-and-city-specific native mapping, without changing inherited-search behavior or silently relaxing a selected condition.

**Architecture:** Store only semantic region names and controlled company-size bands in SearchPlan. Reuse the existing platform filter catalog store, but key every catalog by site plus city and let adapters supply native codes. Before a generated scan starts, resolve every selected condition to an exact native code; if any mapping is absent, reject that site/city target before browser access.

**Tech Stack:** Node.js CommonJS, SQLite filter-catalog storage, existing platform_filters core, BOSS adapter DOM fixture tests, server-rendered dashboard, Node assert smoke tests.

## Global Constraints

- Work only in an isolated worktree with temporary/test SQLite data, fixture DOM and fake browser adapters.
- Do not access real BOSS, any real recruitment site, D:\Guo\ZhiPing\data\jobs.sqlite, or port 8787.
- Scope is generated mode only. Inherit mode preserves each platform template untouched and never applies these fields over it.
- Support only region and company-size in this plan. Industry, financing stage and other platform-specific filters remain unrestricted in generated mode.
- A selected condition must map exactly for the target site and city; no nearest-match, deletion, default substitution or fallback scan is allowed.
- Preserve existing salary, experience, degree, job type, keyword, dedupe, budget, pacing and BOSS safety behavior.

---

### Task 1: Normalize semantic region and company-size fields in SearchPlan

**Files:**

- Modify: src/core/profile_schema.js
- Modify: src/core/plan_validation.js
- Modify: src/core/search_plan.js
- Create: tests/common_filters_plan_smoke.js
- Modify: tests/profile_quality_smoke.js

**Interfaces:**

- SearchPlan gains regionByCity: { [city]: string }.
- SearchPlan gains companySize: string.
- Legal company-size values are "", "lt20", "20_99", "100_499", "500_999", "1000_9999", and "10000_plus".
- Produces selectedCommonFilters(plan, city) -> { region, companySize }.

- [ ] **Step 1: Write the failing normalization tests**

Create tests/common_filters_plan_smoke.js and assert:

~~~
const plan = normalizeSearchPlan({
  cities: ["上海", "深圳"],
  regionByCity: { "上海": "浦东新区", "深圳": "南山区" },
  companySize: "100_499"
}, profile);
assert.deepStrictEqual(selectedCommonFilters(plan, "上海"), {
  region: "浦东新区", companySize: "100_499"
});
assert.deepStrictEqual(selectedCommonFilters(plan, "深圳"), {
  region: "南山区", companySize: "100_499"
});
assert.throws(() => validateSearchPlan({
  ...plan, regionByCity: { "广州": "天河区" }
}, profile), /不属于已选城市/);
~~~

Also assert omitted region/company size produces empty values and does not change legacy plans.

- [ ] **Step 2: Run the test to verify it fails**

Run: node tests/common_filters_plan_smoke.js && node tests/profile_quality_smoke.js

Expected: failure because SearchPlan has no semantic region or company-size fields.

- [ ] **Step 3: Add bounded semantic normalization and validation**

In profile_schema.js, normalize regionByCity only for selected cities and normalize companySize to the legal controlled values. Do not accept BOSS native codes in SearchPlan. In plan_validation.js, reject a region keyed by an unselected city, a non-string region, or an invalid company-size band. In search_plan.js, add selectedCommonFilters and include its semantic values in the scan-policy snapshot and analysis revision input.

- [ ] **Step 4: Run plan regressions**

Run: node tests/common_filters_plan_smoke.js && node tests/profile_quality_smoke.js && node tests/scan_snapshot_smoke.js

Expected: all exit 0; changing a semantic common filter changes the scan snapshot, while absent fields preserve legacy behavior.

- [ ] **Step 5: Commit the plan-schema slice**

~~~
git add src/core/profile_schema.js src/core/plan_validation.js src/core/search_plan.js tests/common_filters_plan_smoke.js tests/profile_quality_smoke.js tests/scan_snapshot_smoke.js
git commit -m "feat: store common search filters"
~~~

### Task 2: Store native catalogs by platform and city, then require exact mapping

**Files:**

- Modify: src/core/platform_filters.js
- Modify: src/core/storage.js
- Create: tests/platform_filter_catalog_smoke.js
- Modify: tests/storage_migration_smoke.js

**Interfaces:**

- getPlatformFilterCatalog(db, site, city) -> catalog | null.
- savePlatformFilterCatalog(db, { site, city, fields, source, capturedAt }) -> catalog.
- resolveNativeFilterSnapshot({ site, city, catalog, plan }) -> snapshot.
- A catalog field option has label, semanticValue, nativeCode, and availability.

- [ ] **Step 1: Write failing catalog-isolation tests**

Create tests/platform_filter_catalog_smoke.js. Save an 上海 BOSS catalog and a 深圳 BOSS catalog with different region codes. Assert:

~~~
assert.strictEqual(getPlatformFilterCatalog(db, "boss", "上海").fields.region[0].nativeCode, "pudong-code");
assert.strictEqual(getPlatformFilterCatalog(db, "boss", "深圳").fields.region[0].nativeCode, "nanshan-code");
assert.throws(() => resolveNativeFilterSnapshot({
  site: "boss", city: "上海", catalog: shanghaiCatalog,
  plan: { regionByCity: { "上海": "南山区" }, companySize: "100_499" }
}), /PLATFORM_FILTER_MAPPING_REQUIRED/);
~~~

Assert an unselected companySize creates no native scale parameter, and a missing exact scale code blocks before a target is returned.

- [ ] **Step 2: Run the test to verify it fails**

Run: node tests/platform_filter_catalog_smoke.js && node tests/storage_migration_smoke.js

Expected: failure because current catalog lookup is not independently keyed and validated by city for these semantic fields.

- [ ] **Step 3: Implement catalog keying and strict resolution**

Extend platform filter catalog persistence to include city in the unique lookup/index. Preserve existing catalog data by treating legacy cityless records as unusable for a city-specific region request. Normalize only region and company-size field options in this task.

In platform_filters.js, resolve selectedCommonFilters(plan, city) first. If a selected semantic value lacks exactly one available native option, throw an error with code PLATFORM_FILTER_MAPPING_REQUIRED and details site, city, field, semanticValue. If nothing is selected, omit that field entirely. Return a snapshot containing both semantic selections and the resolved native codes for audit/recovery.

- [ ] **Step 4: Run catalog and storage regressions**

Run: node tests/platform_filter_catalog_smoke.js && node tests/storage_migration_smoke.js && node tests/common_filters_plan_smoke.js

Expected: all exit 0; 上海 data never maps 深圳 region names or codes.

- [ ] **Step 5: Commit the catalog slice**

~~~
git add src/core/platform_filters.js src/core/storage.js tests/platform_filter_catalog_smoke.js tests/storage_migration_smoke.js tests/common_filters_plan_smoke.js
git commit -m "feat: map common filters by site and city"
~~~

### Task 3: Add BOSS fixture extraction and generated URL mapping without touching inherit mode

**Files:**

- Modify: src/adapters/sites/boss.js
- Modify: src/core/platform_filters.js
- Create: tests/boss_common_filters_smoke.js
- Modify: tests/screening_quality_smoke.js
- Modify: tests/source_acquisition_smoke.js

**Interfaces:**

- BossSiteAdapter exposes readNativeFilterCatalog({ city, browser }) -> catalog.
- BOSS generated target resolution accepts resolved region and scale native codes.
- BOSS inherited target resolution ignores regionByCity and companySize from SearchPlan.

- [ ] **Step 1: Write failing BOSS fixture tests**

Create tests/boss_common_filters_smoke.js with separate 上海 and 深圳 DOM fixtures. Assert each produces an independent catalog and that a generated 上海 target includes the fixture’s Pudong native code plus the selected company-size code.

Add an inherit-mode test:

~~~
const target = resolveBossSearchContext({
  mode: "inherited",
  template: { url: "https://www.zhipin.com/web/geek/jobs?city=101020100&industry=100020&query=旧词" },
  keyword: "AI 应用工程师",
  plan: { regionByCity: { "上海": "浦东新区" }, companySize: "100_499" }
});
assert.match(target.url, /industry=100020/);
assert.doesNotMatch(target.url, /scale=/);
~~~

- [ ] **Step 2: Run the tests to verify they fail**

Run: node tests/boss_common_filters_smoke.js && node tests/screening_quality_smoke.js && node tests/source_acquisition_smoke.js

Expected: failure because BOSS extraction/mapping has no semantic region/company-size route.

- [ ] **Step 3: Implement BOSS catalog extraction and target mapping**

In boss.js, add a fixture-tested extractor for visible, enabled region and company-scale options. It must collect label and native code only; do not collect message text or account data. Extend generated target building to add the resolved native region/scale parameters. Do not let generated fields modify a target resolved through the existing inherit path. Keep existing salary, experience, degree and job-type URL logic untouched.

- [ ] **Step 4: Run BOSS read-only regressions**

Run: node tests/boss_common_filters_smoke.js && node tests/screening_quality_smoke.js && node tests/source_acquisition_smoke.js && node tests/boss_communication_page_smoke.js

Expected: all exit 0; no test dispatches a BOSS communication action.

- [ ] **Step 5: Commit the BOSS mapping slice**

~~~
git add src/adapters/sites/boss.js src/core/platform_filters.js tests/boss_common_filters_smoke.js tests/screening_quality_smoke.js tests/source_acquisition_smoke.js
git commit -m "feat: apply BOSS common filters"
~~~

### Task 4: Gate generated scans, render controls, and preserve inherit templates

**Files:**

- Modify: src/cli.js
- Modify: src/dashboard/server.js
- Modify: src/core/scan_snapshot.js
- Modify: tests/scan_execution_smoke.js
- Modify: tests/data_visibility_smoke.js
- Modify: tests/dashboard_scan_lifecycle_smoke.js

**Interfaces:**

- Generated site/city scan targets carry resolved native filter snapshots.
- A mapping failure prevents that site/city target before browser acquisition.
- Plan page renders region controls for selected cities and one company-size select.
- Inherit-mode UI renders a read-only template summary instead of generated common controls.

- [ ] **Step 1: Write failing gate and UI tests**

In tests/scan_execution_smoke.js, request a generated 上海 scan with an unmapped region and assert no browser/acquisition function is called and the error code is PLATFORM_FILTER_MAPPING_REQUIRED. Add a multiple-city case where 深圳 mapping succeeds and 上海 mapping fails; assert the execution reports the named failing target rather than silently scanning either relaxed target.

In tests/data_visibility_smoke.js, assert the plan page renders a region field for each selected city, the six company-size options, and plain-language text that blank means unrestricted. For an inherit platform template, assert the page shows the captured summary and no generated region/scale override is posted.

- [ ] **Step 2: Run the tests to verify they fail**

Run: node tests/scan_execution_smoke.js && node tests/data_visibility_smoke.js && node tests/dashboard_scan_lifecycle_smoke.js

Expected: failure because generated scans do not yet strictly resolve these semantic filters.

- [ ] **Step 3: Resolve before browser work and render explicit controls**

In cli.js and scan_snapshot.js, load the catalog and call resolveNativeFilterSnapshot for every generated site/city target before acquiring a site lease or browser page. Store the successful semantic/native snapshot in the batch/run context. If any selected condition fails, surface site, city, field and value; do not call the adapter list/detail methods.

In dashboard/server.js, parse regionByCity and companySize explicitly, render the controls, and show each platform/city mapping status. For inherit mode, show the template’s captured filter summary and omit generated controls from the scan payload.

- [ ] **Step 4: Run scan and dashboard regressions**

Run: node tests/common_filters_plan_smoke.js && node tests/platform_filter_catalog_smoke.js && node tests/boss_common_filters_smoke.js && node tests/scan_execution_smoke.js && node tests/dashboard_scan_lifecycle_smoke.js && node tests/data_visibility_smoke.js

Expected: all exit 0; mapping failure happens before browser work and inherit behavior is unchanged.

- [ ] **Step 5: Commit the execution/UI slice**

~~~
git add src/cli.js src/dashboard/server.js src/core/scan_snapshot.js tests/scan_execution_smoke.js tests/data_visibility_smoke.js tests/dashboard_scan_lifecycle_smoke.js
git commit -m "feat: validate common filters before scan"
~~~

### Task 5: Document strict mapping and run the complete relevant regression set

**Files:**

- Modify: docs/daily_workflow.md
- Modify: docs/onboarding_workflow.md
- Modify: docs/llm_contracts.md
- Modify: docs/PROJECT_HANDOFF.md
- Modify: tests/run_all.js

- [ ] **Step 1: Update documentation**

Document the two supported semantic filters, city-specific catalog rule, exact-mapping rejection, inherit-mode preservation, and the fact that industry remains unrestricted in generated mode. Add the new common-filter smoke tests to tests/run_all.js.

- [ ] **Step 2: Run all relevant verification**

Run: node tests/common_filters_plan_smoke.js; node tests/platform_filter_catalog_smoke.js; node tests/boss_common_filters_smoke.js; node tests/storage_migration_smoke.js; node tests/screening_quality_smoke.js; node tests/source_acquisition_smoke.js; node tests/scan_execution_smoke.js; node tests/dashboard_scan_lifecycle_smoke.js; node tests/data_visibility_smoke.js; node tests/boss_communication_page_smoke.js; git diff --check

Expected: every Node command exits 0 and git diff --check is silent. No command opens a real site.

- [ ] **Step 3: Commit documentation and test registration**

~~~
git add docs/daily_workflow.md docs/onboarding_workflow.md docs/llm_contracts.md docs/PROJECT_HANDOFF.md tests/run_all.js
git commit -m "docs: explain strict common filters"
~~~

## Self-review

- Spec coverage: Task 1 stores semantic choices; Task 2 guarantees city/site catalog isolation; Task 3 implements only BOSS read-only mapping; Task 4 enforces the pre-browser gate and UI; Task 5 documents and verifies the boundary.
- Placeholder scan: no task contains an unresolved placeholder or unspecified error handling.
- Type consistency: all tasks use regionByCity, companySize, selectedCommonFilters, resolveNativeFilterSnapshot, and PLATFORM_FILTER_MAPPING_REQUIRED consistently.
