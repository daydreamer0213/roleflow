# 多平台只读搜索与继承模板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Let one Search Plan run serial, read-only searches across enabled platforms using per-platform inherited templates or strictly generated common filters, while preserving existing BOSS behavior and excluding all new platform actions.

**Architecture:** Add a platform-template record and normalized platform list to SearchPlan, then move site construction behind a registry with explicit capabilities. Refactor the generic scan snapshot and execution entry points to ask the adapter for its targets instead of importing BOSS logic. Prove the architecture with a fixture-only second platform; actual 智联 DOM parsing is deliberately a later, evidence-backed plan.

**Tech Stack:** Node.js CommonJS, SQLite migrations in src/core/storage.js, existing BOSS adapter, server-rendered dashboard, Node assert smoke tests, fake browsers and DOM fixtures.

## Global Constraints

- Work only in a fresh isolated worktree and a new task branch; do not modify the active main project directory.
- Use temporary/test SQLite databases, fake browsers, fixture HTML and mock model adapters only.
- Do not access real BOSS, 智联, other job sites, D:\Guo\ZhiPing\data\jobs.sqlite, or port 8787.
- Do not add automatic application, chat, inbox, login, captcha, calendar or message-sending behavior.
- Preserve BOSS fixed-tab, serial pacing, calibration, budget, identity verification and interruption behavior exactly.
- Run enabled platforms serially. A template failure stops only that platform and preserves its checkpoint; it must not silently relax filters.
- Do not save cookies, credentials, message text, screenshots, or opaque browser state in templates.
- A real 智联 adapter is out of scope until a separately authorized read-only DOM evidence task produces fixtures and an adapter-specific plan.

---

### Task 1: Persist platform search templates and a backward-compatible platform list

**Files:**

- Modify: src/core/storage.js
- Create: src/core/platform_search_templates.js
- Modify: src/core/profile_schema.js
- Modify: src/core/plan_validation.js
- Create: tests/platform_search_templates_smoke.js
- Modify: tests/storage_migration_smoke.js
- Modify: tests/run_all.js

**Interfaces:**

- Produces savePlatformSearchTemplate(db, input) -> PlatformSearchTemplate.
- Produces getPlatformSearchTemplate(db, { id, profileId, site }) -> PlatformSearchTemplate | null.
- Produces invalidatePlatformSearchTemplate(db, { id, reasonCode }) -> PlatformSearchTemplate.
- SearchPlan gains platforms: [{ site, enabled, mode, templateId }].
- Legal modes are inherit, generated, and disabled.

- [ ] **Step 1: Write failing storage and compatibility tests**

Create tests/platform_search_templates_smoke.js. Insert a profile and assert:

~~~
const template = savePlatformSearchTemplate(db, {
  profileId,
  site: "fixture_two",
  name: "广州 AI",
  canonicalContext: { path: "/jobs", params: { city: "gz", industry: "ai", query: "" } },
  filterSummary: ["广州", "AI", "15-25K"],
  keywordKey: "query"
});
assert.strictEqual(template.site, "fixture_two");
assert.deepStrictEqual(template.filterSummary, ["广州", "AI", "15-25K"]);
assert.throws(() => savePlatformSearchTemplate(db, {
  profileId, site: "fixture_two",
  canonicalContext: { cookie: "secret" }
}), /PLATFORM_TEMPLATE_SENSITIVE_FIELD/);
~~~

Also assert normalizeSearchPlan converts a legacy platform.site value into one enabled platform entry without deleting legacy plan fields, rejects inherit without a positive templateId, and permits generated without a template.

- [ ] **Step 2: Run the tests to verify they fail**

Run: node tests/platform_search_templates_smoke.js && node tests/storage_migration_smoke.js

Expected: failure because platform template storage and normalized platforms do not exist.

- [ ] **Step 3: Add the migration, storage service, and normalization**

Add the next numbered storage migration with a platform_search_templates table:

~~~
CREATE TABLE platform_search_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  site TEXT NOT NULL,
  name TEXT NOT NULL,
  context_json TEXT NOT NULL,
  filter_summary_json TEXT NOT NULL DEFAULT '[]',
  keyword_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  invalid_reason_code TEXT NOT NULL DEFAULT '',
  captured_at TEXT NOT NULL,
  validated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);
~~~

Add an index on profile_id, site, status, updated_at. In platform_search_templates.js, recursively reject context keys matching cookie, credential, password, token, authorization, message, chat, screenshot, or html before serializing. Store only normalized URL path, allowed query parameters, visible filter labels, keyword key, and a stable fingerprint.

In profile_schema.js, normalize platforms from input.platforms. For a legacy plan with platform.site, synthesize one enabled entry with the same site and generated mode, leaving the legacy platform object intact for compatibility. In plan_validation.js, require an existing template only when mode is inherit.

- [ ] **Step 4: Run persistence regressions**

Run: node tests/platform_search_templates_smoke.js && node tests/storage_migration_smoke.js && node tests/profile_quality_smoke.js

Expected: all exit 0; legacy BOSS plans remain readable.

- [ ] **Step 5: Commit the persistence slice**

~~~
git add src/core/storage.js src/core/platform_search_templates.js src/core/profile_schema.js src/core/plan_validation.js tests/platform_search_templates_smoke.js tests/storage_migration_smoke.js tests/run_all.js
git commit -m "feat: store platform search templates"
~~~

### Task 2: Introduce a capability-based site registry without changing BOSS behavior

**Files:**

- Create: src/adapters/sites/index.js
- Modify: src/cli.js
- Modify: src/core/scan_snapshot.js
- Modify: src/adapters/sites/boss.js
- Create: tests/multi_platform_adapter_smoke.js
- Modify: tests/boss_communication_page_smoke.js
- Modify: tests/scan_snapshot_smoke.js

**Interfaces:**

- Produces createSiteAdapter(site, context) -> adapter.
- Produces siteCapabilities(site) -> capability object.
- Every scan adapter implements resolveSearchTargets(input) and normalizeListedJob(raw).
- BOSS remains the only adapter exposing communication capability.

- [ ] **Step 1: Write failing registry tests**

Create tests/multi_platform_adapter_smoke.js with a fixture_two adapter registered only in the test. Assert:

~~~
assert.deepStrictEqual(siteCapabilities("fixture_two"), {
  search: true, detail: true, inheritTemplate: true,
  generatedFilters: false, employerActivity: false,
  communication: false, application: false, inbox: false
});
assert.throws(() => createSiteAdapter("missing", {}), /SITE_NOT_REGISTERED/);
assert.strictEqual(createSiteAdapter("boss", fakeBossContext).capabilities().communication, true);
assert.strictEqual(createSiteAdapter("fixture_two", {}).capabilities().communication, false);
~~~

Add a BOSS regression asserting its current inherited target URL remains byte-for-byte unchanged for the same template and keyword.

- [ ] **Step 2: Run the test to verify it fails**

Run: node tests/multi_platform_adapter_smoke.js && node tests/scan_snapshot_smoke.js && node tests/boss_communication_page_smoke.js

Expected: failure because CLI owns a BOSS-only factory and scan_snapshot imports BOSS target construction directly.

- [ ] **Step 3: Move site selection behind one registry**

Create src/adapters/sites/index.js with a registry whose production entry is BOSS. Export createSiteAdapter and siteCapabilities. Move the BOSS-only factory from cli.js into this registry; unknown sites must fail with SITE_NOT_REGISTERED.

Add capabilities() and resolveSearchTargets(input) to BossSiteAdapter as a wrapper around existing BOSS URL/context functions, not a rewrite. Refactor scan_snapshot.js to receive an adapter target resolver through its input instead of importing buildBossScanTargets. The registry capability object must explicitly mark BOSS communication true and fixture_two communication false.

- [ ] **Step 4: Run adapter and BOSS regressions**

Run: node tests/multi_platform_adapter_smoke.js && node tests/scan_snapshot_smoke.js && node tests/source_acquisition_smoke.js && node tests/boss_communication_page_smoke.js && node tests/communication_executor_smoke.js

Expected: all exit 0; BOSS communication code is still called only through its existing BOSS path.

- [ ] **Step 5: Commit the registry slice**

~~~
git add src/adapters/sites/index.js src/adapters/sites/boss.js src/cli.js src/core/scan_snapshot.js tests/multi_platform_adapter_smoke.js tests/scan_snapshot_smoke.js tests/boss_communication_page_smoke.js
git commit -m "refactor: register site adapters by capability"
~~~

### Task 3: Resolve inherited and generated targets per platform, then scan platforms serially

**Files:**

- Create: src/core/platform_search_context.js
- Modify: src/core/search_plan.js
- Modify: src/core/scan_execution.js
- Modify: src/cli.js
- Modify: src/core/workflow_run.js
- Create: tests/multi_platform_scan_smoke.js
- Modify: tests/scan_execution_smoke.js
- Modify: tests/workflow_scan_smoke.js

**Interfaces:**

- Produces resolvePlatformSearchContext({ adapter, plan, platform, template, keyword, city }) -> { mode, targets, filterSnapshot }.
- Produces resolveEnabledPlanPlatforms(plan) -> PlatformPlan[].
- A multi-platform run returns one child scan result per site in deterministic platform-list order.
- Template mismatch throws PLATFORM_TEMPLATE_INVALID with site and template ID.

- [ ] **Step 1: Write failing serial scan tests**

Create tests/multi_platform_scan_smoke.js using BOSS and fixture_two fake adapters. Assert:

~~~
const result = await runMultiPlatformScan({ plan, adapters, executeSiteScan });
assert.deepStrictEqual(result.sites.map((site) => site.site), ["boss", "fixture_two"]);
assert.deepStrictEqual(callOrder, ["boss:start", "boss:complete", "fixture_two:start", "fixture_two:complete"]);
assert.strictEqual(result.sites[1].mode, "inherit");
~~~

Add a template-mismatch case where fixture_two throws PLATFORM_TEMPLATE_INVALID; assert BOSS completes, fixture_two records an interrupted/blocked site result, no generated fallback starts, and no communication executor is invoked.

- [ ] **Step 2: Run the tests to verify they fail**

Run: node tests/multi_platform_scan_smoke.js && node tests/scan_execution_smoke.js

Expected: failure because the current scan command resolves one site and one BOSS-specific filter context.

- [ ] **Step 3: Implement strict context resolution and serial orchestration**

In platform_search_context.js, resolve inherit by loading the matching profile/site template, asking the adapter to validate and replace only the keyword, then returning a filter snapshot that includes the template ID and fingerprint. Resolve generated by using only the existing exact-mapping filter facilities. Do not use a template from another site and do not merge inherited filters with generated filters.

In scan_execution.js, add a pure runMultiPlatformScan coordinator that iterates enabled platforms in plan order and awaits each site scan before starting the next. Preserve the existing one-site execution API for explicit --site use. In cli.js, use one child scan run/batch/lease per site and attach every child result to the parent workflow summary. BOSS continues to use its existing budget controller; fixture_two has no BOSS access budget or communication path.

- [ ] **Step 4: Run scan and recovery regressions**

Run: node tests/multi_platform_scan_smoke.js && node tests/scan_execution_smoke.js && node tests/scan_cli_lifecycle_smoke.js && node tests/workflow_scan_smoke.js && node tests/workflow_recovery_smoke.js

Expected: all exit 0; a failed site preserves its own checkpoint and never changes BOSS scan pacing.

- [ ] **Step 5: Commit the orchestration slice**

~~~
git add src/core/platform_search_context.js src/core/search_plan.js src/core/scan_execution.js src/cli.js src/core/workflow_run.js tests/multi_platform_scan_smoke.js tests/scan_execution_smoke.js tests/workflow_scan_smoke.js
git commit -m "feat: scan enabled platforms serially"
~~~

### Task 4: Expose platform/template state and preserve source visibility in the dashboard

**Files:**

- Modify: src/dashboard/server.js
- Modify: src/reports/render.js
- Modify: src/core/storage.js
- Modify: tests/data_visibility_smoke.js
- Modify: tests/workflow_dashboard_smoke.js
- Create: tests/platform_template_dashboard_smoke.js

**Interfaces:**

- Adds GET /platform-templates and POST /api/platform-template for adapter-validated template capture/save.
- Plan page renders each site, mode, template summary, validation state, and enabled switch.
- Queue/report rows show source and may show possible cross-platform duplicate hints.
- New-platform jobs never appear in a BOSS communication selection unless its capability explicitly allows the future action.

- [ ] **Step 1: Write failing dashboard tests**

Create tests/platform_template_dashboard_smoke.js. With a BOSS and fixture_two template, assert rendered HTML contains both platform names, inherit mode, captured filter summaries, and an invalid-template warning. Seed same-company/same-title jobs from two sources and assert both remain visible with a possible duplicate hint.

In tests/workflow_dashboard_smoke.js, assert a fixture_two job is excluded from the existing BOSS communication review even when its matching score is high.

- [ ] **Step 2: Run the tests to verify they fail**

Run: node tests/platform_template_dashboard_smoke.js && node tests/data_visibility_smoke.js && node tests/workflow_dashboard_smoke.js

Expected: failure because the plan page has one platform field and the workflow assumes BOSS-only candidates without an explicit capability check.

- [ ] **Step 3: Implement explicit platform controls and source-aware display**

Add template list/capture routes that delegate validation to the relevant adapter; production capture must refuse an unsupported site rather than accepting pasted opaque state. Render one platform row per normalized plan entry with a mode select, enable switch, template summary and validation status. Explain inherit in plain language: 保留你在该平台的筛选，只替换岗位词.

Keep source and sourceId as the dedupe key. Add a non-destructive possible-duplicate hint based on normalized title/company/location comparison; do not merge rows. Update report filenames and labels so a multi-source result is not called boss_shortlist. In workflow inventory and dashboard communication selection, require source capability communication; only BOSS passes in this plan.

- [ ] **Step 4: Run dashboard, report, and communication regressions**

Run: node tests/platform_template_dashboard_smoke.js && node tests/data_visibility_smoke.js && node tests/workflow_dashboard_smoke.js && node tests/communication_executor_smoke.js && node tests/communication_calibration_gate_smoke.js

Expected: all exit 0; fixture_two is visible as a source but cannot reach BOSS communication controls.

- [ ] **Step 5: Commit the dashboard slice**

~~~
git add src/dashboard/server.js src/reports/render.js src/core/storage.js tests/platform_template_dashboard_smoke.js tests/data_visibility_smoke.js tests/workflow_dashboard_smoke.js
git commit -m "feat: manage platform search templates"
~~~

### Task 5: Document handoff, validate the complete foundation, and stop before real 智联 code

**Files:**

- Modify: docs/PROJECT_HANDOFF.md
- Modify: docs/README.md
- Modify: docs/daily_workflow.md
- Modify: tests/run_all.js

- [ ] **Step 1: Update operational documentation**

Document the three per-platform modes, template privacy rules, serial execution, source visibility, template failure behavior and the fact that this plan does not add real 智联 selectors or platform actions. Add the three new smoke tests to tests/run_all.js.

- [ ] **Step 2: Run all relevant verification**

Run: node tests/platform_search_templates_smoke.js; node tests/multi_platform_adapter_smoke.js; node tests/multi_platform_scan_smoke.js; node tests/platform_template_dashboard_smoke.js; node tests/storage_migration_smoke.js; node tests/scan_snapshot_smoke.js; node tests/scan_execution_smoke.js; node tests/scan_cli_lifecycle_smoke.js; node tests/workflow_scan_smoke.js; node tests/workflow_recovery_smoke.js; node tests/workflow_dashboard_smoke.js; node tests/communication_executor_smoke.js; node tests/communication_calibration_gate_smoke.js; git diff --check

Expected: every Node command exits 0 and git diff --check is silent. No command opens a real browser or external website.

- [ ] **Step 3: Commit documentation and test registration**

~~~
git add docs/PROJECT_HANDOFF.md docs/README.md docs/daily_workflow.md tests/run_all.js
git commit -m "docs: describe multi-platform read-only search"
~~~

## Self-review

- Spec coverage: Task 1 covers templates and legacy plans; Task 2 removes BOSS-only registry/snapshot coupling; Task 3 provides strict per-platform context and serial scans; Task 4 covers user visibility, source retention and action isolation; Task 5 verifies and documents the safe boundary.
- Placeholder scan: no task contains an unresolved placeholder or unspecified error handling.
- Type consistency: all tasks use PlatformSearchTemplate, PlatformPlan, inherit/generated/disabled, resolvePlatformSearchContext, and capability-based action checks consistently.
