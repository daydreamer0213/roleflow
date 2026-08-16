# Generic and Inherited Screening Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同一份 RoleFlow 筛选方案明确选择“继承模式”或“通用模式”，并保证新任务与恢复任务始终使用启动时冻结的采集范围和本地精筛条件。

**Architecture:** 在现有 JSON 方案上增加 v2 规范结构和一组 v1/v2 双读访问器，先迁移消费者，再把明确保存写成 v2。工作流启动时由模式解析器生成不可变的 `planner_json`，扫描进程只消费该快照；页面只负责编辑方案、展示当前模式和发起一次不导航的继承范围预览。

**Tech Stack:** Node.js 22 CommonJS、内置 `node:sqlite`、现有 Dashboard 服务端渲染、现有 Edge Control / CDP 适配器、现有 smoke tests；不增加第三方依赖。

## Global Constraints

- 新保存的方案使用 `schemaVersion: 2`；用户界面显示“继承模式”与“通用模式”，内部值分别保持 `inherited` 与 `generated`。
- 没有模式的旧方案读取时默认 `inherited`，不批量改写数据库；只有用户明确保存时才写回 v2。
- 两种模式只有一份关键词和一套 RoleFlow 本地精筛；通用模式的城市、BOSS 薪资档、经验、职位类型和学历保存在 `platform.generated`。
- 新用户与旧方案继续默认继承模式；本计划不改变默认模式。
- 真实 BOSS 浏览器采集只使用当前登录 Edge 和当前绑定的 `BOSS-SEARCH` / `BOSS-COMMUNICATION` 标签页；新任务页面不再提供第二个浏览器会话入口。
- 扫描、预览、恢复和错误处理不得调用 `Page.bringToFront` 或激活 BOSS 标签页；必须保留用户主动运行启动助手时那一次有意义的引导聚焦。
- 岗位详情正式路径保持 `trusted_pane`；不修、不验、不启用、不删除 `search_page_api`，不恢复通用 `standalone_detail`。
- 平台目录刷新和每次搜索跳转必须串行，继续使用访问预算、随机间隔、周期冷却、检查点和风险即停。
- 保存方案不导航 BOSS；通用模式只在新任务确实需要解析缺失或过期目录时执行受控刷新。
- 新任务使用完整 v2 方案快照；方案保存后的修改只影响下一次新任务。
- 历史任务继续以其 `planner_json` 和扫描执行快照为事实；模式缺失或无效时安全阻断。
- 不运行 `tests/startup_scripts_smoke.js`，因为它直接触发 `msedge.exe` 并会招致 360 防护拦截。
- 不访问真实 BOSS 写操作，不自动发送消息、打招呼或投递；不自动推送、合并或发布。
- 浏览器行为改动必须完成必要的真实只读人工验收后才提交。
- 在当前 `codex/first-principles-audit` 发展分支和现有工作树继续，不重建分支或工作树。

---

## File Map

- Create `src/core/search_plan_schema.js`: v1/v2 双读、v2 单写和平台采集字段访问器。
- Create `src/core/workflow_acquisition.js`: 工作流方案快照、通用模式上下文构造及模式化快照校验。
- Modify `src/core/profile_schema.js`: 保留候选人默认值推导，最终输出 v2 方案。
- Modify `src/core/search_plan.js`: 从模式化字段生成运行时配置和扫描策略。
- Modify `src/core/plan_validation.js`: 默认按方案自身模式校验。
- Modify `src/core/platform_filters.js`: 从 `platform.generated` 解析 BOSS 原生筛选并支持严格标签校验。
- Modify `src/core/platform_runtime_policy.js`: 把通用模式冻结的原生筛选编译成与继承模式等价的本地边界检查策略。
- Modify `src/storage/candidate_store.js`: 旧 JSON 惰性读取为 v2，明确保存写 v2。
- Modify `src/application/workflow/index.js`: 按方案模式解析上下文、冻结方案、验证恢复。
- Modify `src/dashboard/server.js`: 保存模式化表单、提供安全预览、构造两种模式的启动上下文。
- Modify `src/dashboard/view_models/today.js`: 提供模式、平台范围、匹配卡和运行中快照视图。
- Modify `src/dashboard/pages/today.js`: 重排模式、平台采集和本地精筛表单。
- Modify `src/dashboard/view_models/workflow.js`: 同时展示继承和通用模式的冻结范围。
- Modify `src/dashboard/assets/roleflow.css`: 只增加模式面板所需的轻量样式。
- Modify `src/adapters/sites/boss.js`: 平台目录刷新不得绕过访问预算。
- Modify `src/cli.js`: 工作流扫描使用冻结方案与冻结通用筛选，直接扫描尊重方案模式。
- Modify `tests/run_all.js`: 注册新增离线测试；执行时仍显式跳过 `startup_scripts_smoke.js`。
- Create `tests/search_plan_modes_smoke.js`: 方案结构、迁移和核心消费者合同。
- Create `tests/workflow_acquisition_smoke.js`: 工作流冻结、通用上下文和恢复合同。
- Modify `tests/profile_quality_smoke.js`, `tests/storage_migration_smoke.js`, `tests/source_acquisition_smoke.js`: 现有方案与筛选回归。
- Modify `tests/today_dashboard_smoke.js`, `tests/workflow_dashboard_smoke.js`, `tests/workflow_application_smoke.js`, `tests/workflow_recovery_smoke.js`: 页面、启动、恢复回归。
- Modify `docs/PROJECT_HANDOFF.md`, `docs/NEXT_PHASE.md`: 只在自动化和人工验收得到真实结果后更新状态。

---

### Task 1: Add v1/v2 Read Accessors Before Changing Storage

**Files:**
- Create: `src/core/search_plan_schema.js`
- Modify: `src/core/search_plan.js`
- Modify: `src/core/plan_validation.js`
- Modify: `src/core/platform_filters.js`
- Modify: `src/cli.js`
- Create: `tests/search_plan_modes_smoke.js`
- Modify: `tests/profile_quality_smoke.js`
- Modify: `tests/source_acquisition_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces: `SEARCH_PLAN_SCHEMA_VERSION`, `acquisitionModeOf(plan)`, `generatedPlatformOf(plan)`, `canonicalSearchPlanV2(plan)`.
- Produces: `assertGeneratedFilterSelections(plan, snapshot)` in `platform_filters.js`.
- Consumers in later tasks must use these functions instead of reading both flat and nested fields themselves.

- [ ] **Step 1: Add failing dual-read tests**

Create `tests/search_plan_modes_smoke.js` with exact v1/v2 expectations:

```js
const assert = require("node:assert");
const {
  SEARCH_PLAN_SCHEMA_VERSION,
  acquisitionModeOf,
  generatedPlatformOf,
  canonicalSearchPlanV2
} = require("../src/core/search_plan_schema");

const legacy = {
  name: "旧方案",
  cities: ["广州"],
  experience: ["1-3年"],
  jobTypes: ["全职"],
  degrees: ["本科"],
  platform: { site: "boss", salaryLanes: ["10-20K"] },
  keywords: [{ word: "RAG", priority: "A", reason: "核心方向" }],
  directions: ["AI 应用开发"],
  salary: { minK: 12, maxK: 20 },
  scan: { maxCards: 60, maxDetailTotal: 300, browserPageBudget: 90 }
};

assert.strictEqual(acquisitionModeOf(legacy), "inherited");
assert.deepStrictEqual(generatedPlatformOf(legacy), {
  cities: ["广州"], salaryLanes: ["10-20K"], experience: ["1-3年"],
  jobTypes: ["全职"], degrees: ["本科"]
});
const v2 = canonicalSearchPlanV2({ ...legacy, acquisitionMode: "generated" });
assert.strictEqual(v2.schemaVersion, SEARCH_PLAN_SCHEMA_VERSION);
assert.strictEqual(v2.acquisitionMode, "generated");
assert.deepStrictEqual(v2.platform.generated, generatedPlatformOf(legacy));
for (const key of ["cities", "experience", "jobTypes", "degrees", "bossCityCode"]) {
  assert.strictEqual(Object.hasOwn(v2, key), false, `${key} must not be persisted at top level`);
}
assert.strictEqual(Object.hasOwn(v2.platform, "salaryLanes"), false);
assert.throws(() => acquisitionModeOf({ acquisitionMode: "future-mode" }), /采集模式/);
console.log("search_plan_modes_smoke ok");
```

- [ ] **Step 2: Run the new test and confirm the missing-module failure**

Run:

```powershell
node tests/search_plan_modes_smoke.js
```

Expected: FAIL because `src/core/search_plan_schema.js` does not exist.

- [ ] **Step 3: Implement the dual-read, v2-write schema boundary**

Create `src/core/search_plan_schema.js` with this public shape:

```js
const SEARCH_PLAN_SCHEMA_VERSION = 2;
const MODES = new Set(["inherited", "generated"]);

function acquisitionModeOf(plan = {}) {
  const raw = String(plan?.acquisitionMode || "inherited").trim().toLowerCase();
  if (!MODES.has(raw)) {
    const error = new Error("采集模式无效。");
    error.code = "SEARCH_PLAN_ACQUISITION_MODE_INVALID";
    throw error;
  }
  return raw;
}

function generatedPlatformOf(plan = {}) {
  const nested = plan?.platform?.generated || {};
  return {
    cities: strings(nested.cities ?? plan.cities),
    salaryLanes: strings(nested.salaryLanes ?? plan?.platform?.salaryLanes),
    experience: strings(nested.experience ?? plan.experience),
    jobTypes: strings(nested.jobTypes ?? plan.jobTypes ?? plan.jobType),
    degrees: strings(nested.degrees ?? plan.degrees ?? plan.degree)
  };
}

function canonicalSearchPlanV2(plan = {}) {
  const generated = generatedPlatformOf(plan);
  return {
    schemaVersion: SEARCH_PLAN_SCHEMA_VERSION,
    name: String(plan.name || "岗位筛选计划").trim() || "岗位筛选计划",
    acquisitionMode: acquisitionModeOf(plan),
    platform: { site: String(plan?.platform?.site || "boss").trim().toLowerCase(), generated },
    salary: clone(plan.salary || {}),
    salaryMode: plan.salaryMode,
    allowExperienceStretch: plan.allowExperienceStretch !== false,
    bossActiveDays: plan.bossActiveDays,
    workSchedulePreference: plan.workSchedulePreference,
    directions: strings(plan.directions),
    keywords: clone(Array.isArray(plan.keywords) ? plan.keywords : []),
    excludeWords: strings(plan.excludeWords),
    hardExcludes: strings(plan.hardExcludes),
    scan: clone(plan.scan || {}),
    source: String(plan.source || "model-recommended")
  };
}

function strings(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))];
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

module.exports = {
  SEARCH_PLAN_SCHEMA_VERSION,
  acquisitionModeOf,
  generatedPlatformOf,
  canonicalSearchPlanV2
};
```

- [ ] **Step 4: Make core consumers read through the boundary**

Apply these exact rules:

```js
const { acquisitionModeOf, generatedPlatformOf } = require("./search_plan_schema");

const acquisitionMode = acquisitionModeOf(plan);
const generated = generatedPlatformOf(plan);
const platformCities = acquisitionMode === "generated" ? generated.cities : [];
const platformExperience = acquisitionMode === "generated" ? generated.experience : [];
```

- In `search_plan.js`, use `platformCities`, `platformExperience`, and `generated.jobTypes`; include `acquisitionMode` and `platform.generated` in the policy snapshot instead of flat aliases.
- In `plan_validation.js`, default the option to the plan value:

```js
function validateSearchPlan(plan = {}, candidateProfile = {}, options = {}) {
  const mode = options.acquisitionMode
    ? acquisitionModeOf({ acquisitionMode: options.acquisitionMode })
    : acquisitionModeOf(plan);
  const generated = generatedPlatformOf(plan);
  const cities = generated.cities;
```

- In `platform_filters.js`, pass `generatedPlatformOf(plan)` to field resolution. For salary, experience, job type, and degree, record every requested label that did not map through the existing deterministic field normalizer in `snapshot.unresolvedSelections`; reject a non-empty list instead of silently remapping it:

```js
function assertGeneratedFilterSelections(plan, snapshot) {
  const unresolved = Array.isArray(snapshot.unresolvedSelections)
    ? snapshot.unresolvedSelections
    : [];
  if (unresolved.length) {
    const labels = unresolved.map((item) => item.label).filter(Boolean);
    const error = new Error(`这些 BOSS 筛选条件无法明确解析：${labels.join("、")}。`);
    error.code = "GENERATED_FILTER_SELECTION_UNRESOLVED";
    throw error;
  }
  return snapshot;
}
```

- In `cli.js`, make direct plan scans start from the saved mode and make `resolveCityScopes` use `generatedPlatformOf(planRecord.plan)`; keep JSON fixture input as `generated`.

```js
let acquisitionMode = workflowAcquisitionMode
  || resumeValidation?.acquisitionMode
  || (planRecord ? acquisitionModeOf(planRecord.plan) : "")
  || (args.input ? "generated" : "");
```

- [ ] **Step 5: Run the focused core tests**

Run:

```powershell
node tests/search_plan_modes_smoke.js
node tests/profile_quality_smoke.js
node tests/source_acquisition_smoke.js
node tests/screening_quality_smoke.js
```

Expected: all four commands print their `ok` line and exit 0.

- [ ] **Step 6: Register the new test and commit the dual-read boundary**

Add `search_plan_modes_smoke.js` next to the other plan/filter tests in `tests/run_all.js`, then run:

```powershell
git diff --check
git add src/core/search_plan_schema.js src/core/search_plan.js src/core/plan_validation.js src/core/platform_filters.js src/cli.js tests/search_plan_modes_smoke.js tests/profile_quality_smoke.js tests/source_acquisition_smoke.js tests/run_all.js
git commit -m "refactor: separate plan acquisition fields"
```

---

### Task 2: Persist v2 Plans With Lazy v1 Compatibility

**Files:**
- Modify: `src/core/profile_schema.js`
- Modify: `src/storage/candidate_store.js`
- Modify: `src/dashboard/server.js`
- Modify: `tests/search_plan_modes_smoke.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/candidate_store_contract_smoke.js`
- Modify: `tests/onboarding_smoke.js`

**Interfaces:**
- Consumes: `canonicalSearchPlanV2(plan)` and `generatedPlatformOf(plan)` from Task 1.
- Produces: every `getSearchPlan`, `getActiveSearchPlan`, and `listSearchPlans` result contains a canonical v2 `plan` object.
- Produces: `saveSearchPlan` serializes only canonical v2 fields.

- [ ] **Step 1: Add failing persistence tests**

Insert a raw v1 row in `tests/storage_migration_smoke.js`, then assert lazy read and explicit write separately:

```js
const legacyJson = JSON.stringify({
  name: "迁移样本", cities: ["广州"], experience: ["1-3年"],
  jobTypes: ["全职"], degrees: ["本科"],
  platform: { site: "boss", salaryLanes: ["10-20K"] },
  directions: ["AI 应用开发"], keywords: [{ word: "RAG", priority: "A" }]
});
const legacyId = Number(db.prepare(`INSERT INTO search_plans(
  profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
) VALUES (?, '迁移样本', ?, ?, 1, ?, ?)`)
  .run(profileId, legacyJson, profileVersionId, now, now).lastInsertRowid);

const lazy = getSearchPlan(db, legacyId);
assert.strictEqual(lazy.plan.schemaVersion, 2);
assert.strictEqual(lazy.plan.acquisitionMode, "inherited");
assert.deepStrictEqual(lazy.plan.platform.generated.cities, ["广州"]);
assert.strictEqual(db.prepare("SELECT plan_json FROM search_plans WHERE id = ?").get(legacyId).plan_json, legacyJson);

saveSearchPlan(db, { id: legacyId, profileId, profileVersionId, plan: lazy.plan, now });
const stored = JSON.parse(db.prepare("SELECT plan_json FROM search_plans WHERE id = ?").get(legacyId).plan_json);
assert.strictEqual(stored.schemaVersion, 2);
assert.strictEqual(Object.hasOwn(stored, "cities"), false);
assert.strictEqual(Object.hasOwn(stored.platform, "salaryLanes"), false);
```

- [ ] **Step 2: Run persistence tests and confirm they fail on v1 output**

Run:

```powershell
node tests/storage_migration_smoke.js
node tests/candidate_store_contract_smoke.js
```

Expected: at least the new `schemaVersion === 2` assertion fails.

- [ ] **Step 3: Make normalization and storage single-write v2**

In `profile_schema.js`, keep its current default inference, build the following normalized object, and pass it to `canonicalSearchPlanV2`:

```js
const platform = object(input.platform);
const generated = object(platform.generated);
const city = strings(generated.cities ?? input.cities ?? input.city ?? candidate.city, 5);
const normalized = {
  name,
  acquisitionMode: input.acquisitionMode,
  platform: {
    site: normalizePlatformSite(platform.site || input.site || "boss"),
    generated: {
      cities: city,
      salaryLanes: strings(platform.generated?.salaryLanes ?? platform.salaryLanes ?? input.platformSalaryLanes, 4),
      experience: normalizeExperience(platform.generated?.experience ?? input.experience ?? policy.defaultExperience),
      jobTypes: strings(platform.generated?.jobTypes ?? input.jobTypes ?? input.jobType ?? policy.defaultJobTypes, 4),
      degrees: strings(platform.generated?.degrees ?? input.degrees ?? input.degree, 8)
    }
  },
  salary: { minK, maxK }, salaryMode,
  allowExperienceStretch: input.allowExperienceStretch !== false,
  bossActiveDays: normalizeBossActiveDays(input.bossActiveDays),
  workSchedulePreference: normalizeWorkSchedulePreference(input.workSchedulePreference),
  directions, keywords: fallbackKeywords, excludeWords, hardExcludes, scan, source
};
return canonicalSearchPlanV2(normalized);
```

In `candidate_store.js`, canonicalize on read without writing and canonicalize again on explicit save:

```js
const { canonicalSearchPlanV2 } = require("../core/search_plan_schema");

const persistedPlan = canonicalSearchPlanV2(plan || {});
const name = persistedPlan.name;
// Use JSON.stringify(persistedPlan) in both existing SQL branches.

function planRow(row) {
  return {
    id: Number(row.id), profileId: Number(row.profile_id), name: row.name,
    plan: canonicalSearchPlanV2(parseJson(row.plan_json, {})),
    profileVersionId: Number(row.profile_version_id || 0) || null,
    isActive: Boolean(row.is_active), createdAt: row.created_at, updatedAt: row.updated_at
  };
}
```

Update `dashboard/server.js` logging to count `generatedPlatformOf(plan).cities.length`; do not restore a flat city alias.

- [ ] **Step 4: Run schema, migration, onboarding, and storage regression tests**

Run:

```powershell
node tests/search_plan_modes_smoke.js
node tests/storage_migration_smoke.js
node tests/candidate_store_contract_smoke.js
node tests/onboarding_smoke.js
node tests/onboarding_run_smoke.js
node tests/profile_quality_smoke.js
```

Expected: all six commands exit 0.

- [ ] **Step 5: Verify raw storage has no v1 aliases and commit**

Run:

```powershell
rg -n "plan\.cities|plan\.experience|plan\.jobTypes|plan\.degrees|platform\?\.salaryLanes|platform\.salaryLanes" src/core src/storage src/dashboard src/cli.js
git diff --check
git add src/core/profile_schema.js src/storage/candidate_store.js src/dashboard/server.js tests/search_plan_modes_smoke.js tests/storage_migration_smoke.js tests/candidate_store_contract_smoke.js tests/onboarding_smoke.js
git commit -m "feat: persist versioned screening modes"
```

Expected: remaining search matches are limited to v1 compatibility inside `search_plan_schema.js` or candidate-profile fields.

---

### Task 3: Expose Mode-Specific Saving and a Clear Dashboard Form

**Files:**
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/view_models/today.js`
- Modify: `src/dashboard/pages/today.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Modify: `tests/today_dashboard_smoke.js`
- Modify: `tests/workflow_dashboard_smoke.js`
- Modify: `tests/onboarding_smoke.js`

**Interfaces:**
- Consumes: canonical v2 plan and `generatedPlatformOf(plan)`.
- Produces: POST `/api/plan` accepts `acquisitionMode` and preserves inactive `platform.generated` fields.
- Produces: `vm.form.acquisition` with `{ mode, generated, inheritedPreview, activeSnapshot }`.
- Produces: `vm.profile.matchingCard` with `{ summary, href }` from the already confirmed matching context.
- Preserves: saving while a workflow is active does not rescore that workflow's observations; the rescore is deferred to the next new-workflow start.

- [ ] **Step 1: Add failing form and save assertions**

Extend `tests/today_dashboard_smoke.js` with these assertions:

```js
const inheritedHtml = renderTodayPage({
  ...viewModel,
  form: {
    ...viewModel.form,
    plan: { ...viewModel.form.plan, acquisitionMode: "inherited" },
    acquisition: {
      mode: "inherited",
      generated: { cities: ["广州"], salaryLanes: ["10-20K"], experience: ["1-3年"], jobTypes: ["全职"], degrees: ["本科"] },
      inheritedPreview: { status: "idle", summary: "读取当前 BOSS 搜索页后显示" },
      activeSnapshot: null
    }
  }
});
assert.match(inheritedHtml, /name="acquisitionMode" value="inherited" checked/);
assert.match(inheritedHtml, /data-acquisition-panel="inherited"/);
assert.match(inheritedHtml, /data-acquisition-panel="generated"/);
assert.match(inheritedHtml, /RoleFlow 本地精筛/);
assert.doesNotMatch(inheritedHtml, /<strong>平台已继承<\/strong>/);
```

Extend the dashboard POST fixture in `tests/onboarding_smoke.js` with `acquisitionMode=generated`; assert the saved row keeps `platform.generated` and omits flat aliases.

Add an active-workflow fixture and assert saving does not call the injected rescore function, while a no-active-workflow save calls it once.

- [ ] **Step 2: Run dashboard tests and confirm the new mode markup is missing**

Run:

```powershell
node tests/today_dashboard_smoke.js
node tests/onboarding_smoke.js
```

Expected: FAIL on missing `acquisitionMode` or acquisition panel markup.

- [ ] **Step 3: Parse and validate the active mode in `handlePlanSave`**

Build the normalization input with nested generated fields:

```js
const plan = normalizeSearchPlan({
  name: params.name,
  acquisitionMode: params.acquisitionMode,
  platform: {
    site: "boss",
    generated: {
      cities: splitTerms(params.cities),
      salaryLanes: splitTerms(params.platformSalaryLanes),
      experience: splitTerms(params.experience),
      jobTypes: splitTerms(params.jobTypes),
      degrees: splitTerms(params.degrees)
    }
  },
  salaryMinK: params.salaryMinK,
  salaryMaxK: params.salaryMaxK,
  salaryMode: params.salaryMode,
  workSchedulePreference: params.workSchedulePreference,
  directions: splitTerms(params.directions),
  keywords: parseKeywordLines(params.keywords),
  excludeWords: splitTerms(params.excludeWords),
  hardExcludes: splitTerms(params.hardExcludes),
  scan: {
    maxCards: params.maxCards,
    maxDetailTotal: params.maxDetailTotal,
    browserPageBudget: params.browserPageBudget
  },
  source: "user-confirmed"
}, profile.profile);
const validation = validateSearchPlan(plan, profile.profile);
```

Do not call a BOSS adapter from the save handler.

Use the same plan-owned mode in the other Dashboard entry points:

```js
const validation = validateSearchPlan(plan, profile.profile);
assertSearchPlanReady(planRecord, matchingContext?.candidateProfile || {}, dependency, {
  acquisitionMode: acquisitionModeOf(planRecord.plan)
});
```

Apply the first line in `renderPlanPage` and the second in `handlePlanScan`; remove the hardcoded generated/inherited validation pair.

Change the handler options to `{ root, logger, requestId, rescore = rescorePlanObservations }`. After saving, protect the active workflow from immediate local-result drift:

```js
const savedPlanRecord = getSearchPlan(db, planId);
const activeWorkflow = buildWorkflowDashboardState(db, savedPlanRecord).activeRun;
const rescoreResult = activeWorkflow
  ? { rescored: 0, deferred: true }
  : rescore(db, { planId, configs: runtimeConfigs });
```

Log `rescoreDeferred: Boolean(rescoreResult.deferred)`. The active-workflow notice must say the new conditions will be applied when the next task starts.

- [ ] **Step 4: Build one mode-aware view model**

In `buildTodayViewModel`, use the plan’s active-mode validation and expose:

```js
const mode = acquisitionModeOf(plan);
const generated = generatedPlatformOf(plan);
const activePlanner = activeRun?.planner || null;

const acquisition = {
  mode,
  generated,
  inheritedPreview: input.inheritedPreview || { status: "idle", summary: "读取当前 BOSS 搜索页后显示" },
  activeSnapshot: activePlanner ? {
    mode: activePlanner.acquisitionMode,
    planHash: activePlanner.planHash || "",
    summary: acquisitionSummary(activePlanner)
  } : null
};
```

Use this deterministic summary helper in the same view-model file:

```js
function acquisitionSummary(planner = {}) {
  if (planner.acquisitionMode === "generated") {
    const cities = (planner.cityScopes || []).map((item) => item.city || item.cityCode).filter(Boolean);
    const filters = Object.values(planner.nativeFilters?.labels || {}).flat();
    return ["通用模式", ...cities, ...filters].join(" · ");
  }
  const filters = (planner.platformPolicy?.filterSummary || []).filter(Boolean);
  return ["继承模式", ...filters].join(" · ");
}
```

Put `acquisition` inside `form`; make `scanBlocked` and `startBlocked` use this single active-mode validation result. In `renderPlanPage`, pass the already loaded matching context to the view model and expose:

```js
matchingCard: {
  summary: matchingContext?.matchingCard ? "已确认，将用于 JD 证据匹配" : "尚未确认",
  href: `/match-card?profileId=${profile.id}`
}
```

- [ ] **Step 5: Render distinct platform and local sections while preserving hidden values**

In `today.js`, render both radio buttons and both platform panels. Use `hidden` only; do not disable inactive inputs:

```html
<fieldset class="mode-picker wide">
  <legend>平台采集方式</legend>
  <label><input type="radio" name="acquisitionMode" value="inherited">继承模式</label>
  <label><input type="radio" name="acquisitionMode" value="generated">通用模式</label>
</fieldset>
<section class="acquisition-panel wide" data-acquisition-panel="inherited">
  <strong>当前 BOSS 搜索页范围</strong>
  <p data-inherited-preview>读取当前 BOSS 搜索页后显示</p>
</section>
<section class="acquisition-panel wide" data-acquisition-panel="generated">
  ${renderChoices("城市", "cities", options.cities, generated.cities)}
  ${renderChoices("BOSS 薪资档", "platformSalaryLanes", options.platformSalaryLanes, generated.salaryLanes)}
  ${renderChoices("工作经验", "experience", options.experience, generated.experience)}
  ${renderChoices("职位类型", "jobTypes", options.jobTypes, generated.jobTypes)}
  ${renderChoices("学历", "degrees", options.degrees, generated.degrees)}
</section>
<section class="local-screening wide">
  <h3>RoleFlow 本地精筛</h3>
  ${renderLocalScreeningFields({ plan, profile: vm.profile, bounds, defaults })}
</section>
```

Use this client-side toggle:

```js
function syncAcquisitionPanels() {
  const mode = form.querySelector('input[name=acquisitionMode]:checked')?.value || 'inherited';
  form.querySelectorAll('[data-acquisition-panel]').forEach(function(panel) {
    const visible = panel.dataset.acquisitionPanel === mode;
    panel.hidden = !visible;
    panel.setAttribute('aria-hidden', visible ? 'false' : 'true');
  });
}
```

Implement `renderLocalScreeningFields` as a focused extraction of existing form fields plus the two local controls that were previously fixed to defaults:

```js
function renderLocalScreeningFields({ plan, profile, bounds, defaults }) {
  return `<div class="plan-form wide">
    <label>最低薪资（K）<input type="number" min="0" max="100" name="salaryMinK" value="${escapeAttr(plan.salary?.minK || "")}"></label>
    <label>最高薪资（K）<input type="number" min="0" max="100" name="salaryMaxK" value="${escapeAttr(plan.salary?.maxK || "")}"></label>
    <label>薪资策略<select name="salaryMode"><option value="wide"${plan.salaryMode !== "strict" ? " selected" : ""}>宽松排序，范围外保留</option><option value="strict"${plan.salaryMode === "strict" ? " selected" : ""}>严格范围</option></select></label>
    <label class="wide">目标方向<input name="directions" value="${escapeAttr((plan.directions || []).join("，"))}"></label>
    <label>招聘方活跃天数<input type="number" name="bossActiveDays" value="${escapeAttr(plan.bossActiveDays || "")}"></label>
    <label><input type="checkbox" name="allowExperienceStretch"${plan.allowExperienceStretch !== false ? " checked" : ""}>允许经验要求适度放宽</label>
    <label>工作节奏<select name="workSchedulePreference"><option value="prefer_double_weekend"${plan.workSchedulePreference !== "no_preference" ? " selected" : ""}>优先双休</option><option value="no_preference"${plan.workSchedulePreference === "no_preference" ? " selected" : ""}>不作为排序依据</option></select></label>
    <a class="button quiet wide" href="${escapeAttr(profile.matchingCard?.href || "#")}">${escapeHtml(profile.matchingCard?.summary || "检查匹配偏好卡")}</a>
    <label class="wide">排除词<input name="excludeWords" value="${escapeAttr((plan.excludeWords || []).join("，"))}"></label>
    <label class="wide">硬排除词<input name="hardExcludes" value="${escapeAttr((plan.hardExcludes || []).join("，"))}"></label>
  </div>`;
}
```

Parse `bossActiveDays` and `allowExperienceStretch: params.allowExperienceStretch === "on"` in `handlePlanSave`; continue to validate active days through the existing product-policy normalizer. Keep the existing shared keyword textarea and scan-budget fields outside this helper.

Remove the portable-browser selector from new workflow and advanced scan forms; submit `<input type="hidden" name="browserMode" value="edge">`. Historical resume rendering remains unchanged.

- [ ] **Step 6: Add only the required CSS**

Append:

```css
.mode-picker{display:flex;flex-wrap:wrap;gap:10px;padding:14px;border:1px solid var(--rf-rule);border-radius:7px}.mode-picker legend{padding:0 6px;font-weight:800}.mode-picker label{display:flex;grid-auto-flow:column;align-items:center;gap:7px}.mode-picker input{width:auto;min-height:auto}.acquisition-panel,.local-screening{display:grid;gap:12px;padding:16px;background:#f8faf9;border:1px solid var(--rf-rule);border-radius:7px}.acquisition-panel[hidden]{display:none}.local-screening h3{margin:0}
```

- [ ] **Step 7: Run page and save tests, then perform local visual QA**

Run:

```powershell
node tests/today_dashboard_smoke.js
node tests/onboarding_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: all three exit 0. Then use the `webapp-testing` skill against a local fixture database and verify desktop plus narrow viewport: the mode selector is visible, only one platform panel is visible, switching twice preserves values, and the active-task snapshot notice remains readable.

- [ ] **Step 8: Commit the local-only UI slice**

Run:

```powershell
git diff --check
git add src/dashboard/server.js src/dashboard/view_models/today.js src/dashboard/pages/today.js src/dashboard/assets/roleflow.css tests/today_dashboard_smoke.js tests/workflow_dashboard_smoke.js tests/onboarding_smoke.js
git commit -m "feat: expose screening acquisition modes"
```

---

### Task 4: Freeze Mode-Specific Workflow Contexts Before Scanning

**Files:**
- Create: `src/core/workflow_acquisition.js`
- Modify: `src/core/inherited_search_scope.js`
- Modify: `src/core/platform_runtime_policy.js`
- Modify: `src/adapters/sites/boss.js`
- Modify: `src/application/workflow/index.js`
- Modify: `src/dashboard/server.js`
- Create: `tests/workflow_acquisition_smoke.js`
- Modify: `tests/workflow_application_smoke.js`
- Modify: `tests/boss_safe_pacing_smoke.js`
- Modify: `tests/site_access_budget_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces: `freezeWorkflowPlan(plan) -> { planSnapshotVersion, planSnapshot, planHash }`.
- Produces: `buildGeneratedAcquisitionContext({ planRecord, catalog, matchingCardRevision })`.
- Produces: `assertCompleteGeneratedContext(context, { planId })`, `assertFrozenWorkflowPlan(planner)`, and `assertAcquisitionContext(context, { planId })`; successful assertions return their validated input.
- Produces: injected `acquisitionContextResolver({ db, plan, matchingContext, logger, browserMode, cdpPort })`.
- Produces: injected `preparePlanForNewWorkflow({ db, plan, matchingContext })`, which applies a deferred local rescore only after confirming no workflow is active.

- [ ] **Step 1: Add failing pure acquisition tests**

Create `tests/workflow_acquisition_smoke.js`:

```js
const assert = require("node:assert");
const {
  freezeWorkflowPlan,
  buildGeneratedAcquisitionContext,
  assertCompleteGeneratedContext,
  assertFrozenWorkflowPlan
} = require("../src/core/workflow_acquisition");

const planRecord = {
  id: 7,
  profileVersionId: 9,
  plan: {
    schemaVersion: 2,
    acquisitionMode: "generated",
    platform: { site: "boss", generated: { cities: ["广州"], salaryLanes: ["10-20K"], experience: ["1-3年"], jobTypes: ["全职"], degrees: ["本科"] } },
    directions: ["AI 应用开发"],
    keywords: [{ word: "RAG", priority: "A", reason: "核心" }],
    salary: { minK: 12, maxK: 20 },
    scan: { maxCards: 60, maxDetailTotal: 300, browserPageBudget: 90 }
  }
};
const catalog = fixtureBossCatalog();
const context = buildGeneratedAcquisitionContext({ planRecord, catalog, matchingCardRevision: "card-r1" });
assert.strictEqual(context.acquisitionMode, "generated");
assert.deepStrictEqual(context.cityScopes, [{ city: "广州", cityCode: "101280100" }]);
assert.strictEqual(context.searchTemplate.mode, "generated");
assert(context.nativeFilters.catalogVersion);
assertCompleteGeneratedContext(context, { planId: 7 });
const frozen = { ...freezeWorkflowPlan(planRecord.plan), ...context };
assertFrozenWorkflowPlan(frozen);
const changed = { ...planRecord.plan, directions: ["后端开发"] };
assert.notStrictEqual(freezeWorkflowPlan(changed).planHash, frozen.planHash);
console.log("workflow_acquisition_smoke ok");
```

Copy the stable catalog fixture values from `tests/source_acquisition_smoke.js` into a local `fixtureBossCatalog()` in this test so it runs independently.

- [ ] **Step 2: Run the new test and confirm the missing-module failure**

Run:

```powershell
node tests/workflow_acquisition_smoke.js
```

Expected: FAIL because `src/core/workflow_acquisition.js` does not exist.

- [ ] **Step 3: Implement immutable plan and generated-context helpers**

Create `workflow_acquisition.js` around existing functions:

```js
const { stableHash } = require("./analysis_revision");
const { canonicalSearchPlanV2, generatedPlatformOf } = require("./search_plan_schema");
const { cityToBossCode } = require("./search_plan");
const { resolveNativeFilterSnapshot, assertGeneratedFilterSelections } = require("./platform_filters");
const { freezeKeywordSource, assertCompleteInheritedContext } = require("./inherited_search_scope");
const { compileGeneratedPlatformRuntimePolicy } = require("./platform_runtime_policy");

function freezeWorkflowPlan(plan) {
  const planSnapshot = canonicalSearchPlanV2(plan);
  return { planSnapshotVersion: 2, planSnapshot, planHash: stableHash(planSnapshot) };
}

function buildGeneratedAcquisitionContext({ planRecord, catalog, matchingCardRevision }) {
  const generated = generatedPlatformOf(planRecord.plan);
  const cityScopes = generated.cities.map((city) => ({ city, cityCode: cityToBossCode(city) }));
  if (!cityScopes.length || cityScopes.some((item) => !item.cityCode)) {
    throw acquisitionError("GENERATED_CITY_UNRESOLVED", "通用模式包含无法解析的 BOSS 城市。");
  }
  const nativeFilters = assertGeneratedFilterSelections(
    planRecord.plan,
    resolveNativeFilterSnapshot({ site: "boss", catalog, plan: planRecord.plan })
  );
  const platformPolicy = compileGeneratedPlatformRuntimePolicy({ cityScopes, nativeFilters });
  return {
    acquisitionMode: "generated",
    searchTemplate: { mode: "generated", url: "", cityCode: "" },
    cityScopes,
    nativeFilters,
    nativeFilterCatalogRevision: nativeFilters.catalogVersion,
    keywordSource: freezeKeywordSource({ planRecord, matchingCardRevision }),
    platformPolicy
  };
}

function acquisitionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
```

`assertCompleteGeneratedContext` must require: generated mode, non-empty unique city codes, generated search template, non-empty keyword source matching `planId`, non-empty catalog revision, and a deterministic native-filter object. `assertFrozenWorkflowPlan` must recompute `stableHash(planner.planSnapshot)` and reject mismatches with `WORKFLOW_PLAN_SNAPSHOT_INVALID`.

Add the mode dispatcher next to those assertions:

```js
function assertAcquisitionContext(context, options = {}) {
  if (context?.acquisitionMode === "inherited") {
    return assertCompleteInheritedContext(context, options);
  }
  if (context?.acquisitionMode === "generated") {
    return assertCompleteGeneratedContext(context, options);
  }
  throw acquisitionError("WORKFLOW_ACQUISITION_MODE_INVALID", "本轮任务的采集模式无效。");
}
```

Rename only the error text of `freezeKeywordSource` so it is mode-neutral; keep the exported function name and existing inherited callers.

In `platform_runtime_policy.js`, reuse `salaryRange`, `formatPolicySummary`, and the existing empty-filter shape to compile an equivalent generated policy:

```js
function compileGeneratedPlatformRuntimePolicy({ cityScopes = [], nativeFilters = {} } = {}) {
  const laneLabels = (nativeFilters.lanes || []).flatMap((lane) => lane.labels?.salary || []);
  const labels = nativeFilters.labels || {};
  const filters = {
    location: {
      mode: cityScopes.length ? "specific" : "unset",
      codes: cityScopes.map((item) => item.cityCode),
      cities: cityScopes.map((item) => item.city).filter(Boolean),
      districts: []
    },
    salary: {
      codes: [],
      labels: [...new Set([...(labels.salary || []), ...laneLabels])],
      ranges: [...new Set([...(labels.salary || []), ...laneLabels])].map(salaryRange).filter(Boolean)
    },
    experience: { codes: [], labels: [...(labels.experience || [])] },
    degree: { codes: [], labels: [...(labels.degree || [])] },
    jobType: { codes: [], labels: [...(labels.jobType || [])] },
    acquisitionOnly: {}
  };
  const payload = { site: "boss", filters, unresolvedParams: [] };
  return { ...payload, filterSummary: formatPolicySummary(filters, []), hash: stableHash(payload) };
}
```

Extend `applyPlatformRuntimePolicy(configs, policy, { acquisitionMode = "inherited" } = {})` and set the projected mode from the argument. Existing inherited callers need no change.

- [ ] **Step 4: Make platform catalog refresh consume the existing budget**

In `BossSiteAdapter.discoverFilterCatalog`, replace the budget bypass:

```js
await this.navigateWithPacing(targetTabId, url, "catalog", { enforceBudget: true });
```

Extend `tests/boss_safe_pacing_smoke.js` with a fake access controller and assert exactly one `list_navigation` reservation for one issued catalog refresh, including a failed refresh.

- [ ] **Step 5: Resolve either mode before creating the workflow**

In `dashboard/server.js`, add `resolveLiveGeneratedContext` and a dispatcher. It must bind the fixed search tab through `inspectBossOperatorTabs`, use the cached catalog when fresh, and create `createSiteAccessController({ db, site: "boss", runId: `workflow-plan:${plan.id}`, logger })` before an actual refresh.

```js
async function resolveLiveAcquisitionContext(input) {
  return acquisitionModeOf(input.plan.plan) === "inherited"
    ? resolveLiveInheritedContext(input)
    : resolveLiveGeneratedContext(input);
}
```

For a new task, accept only the current Edge authority:

```js
function resolveNewWorkflowBrowser(input = {}) {
  const browserMode = String(input.browserMode || "edge").trim().toLowerCase();
  if (browserMode !== "edge") {
    throw appError("WORKFLOW_EDGE_REQUIRED", "新任务只使用当前已登录 Edge 的固定 BOSS 标签页。", { statusCode: 409 });
  }
  return { browserMode: "edge", cdpPort: null };
}
```

Do not change historical portable-workflow resume parsing in this task.

- [ ] **Step 6: Branch `startWorkflow` and freeze the full planner contract**

Replace the inherited-only dependency names with `resolveNewWorkflowBrowser`, `acquisitionContextResolver`, and `assertAcquisitionContext`. The planner write must include:

```js
const frozenPlan = freezeWorkflowPlan(plan.plan);
const initialState = buildDashboardState(db, plan);
if (initialState.activeRun) return { workflow: initialState.activeRun, alreadyActive: true };
assertSearchPlanReady(plan, matchingContext?.candidateProfile || {}, getSearchPlanDependency(db, plan.id), {
  acquisitionMode: acquisitionModeOf(plan.plan)
});
await preparePlanForNewWorkflow({ db, plan, matchingContext });
const preliminaryState = buildDashboardState(db, plan);
const acquisition = await acquisitionContextResolver({
  db, plan, matchingContext, logger,
  browserMode: browserAuthority.browserMode,
  cdpPort: browserAuthority.cdpPort
});
assertAcquisitionContext(acquisition, { planId: plan.id });

const planner = {
  ...state.nextPlan,
  ...frozenPlan,
  browserMode: "edge", cdpPort: null,
  acquisitionMode: acquisition.acquisitionMode,
  searchTemplate: acquisition.searchTemplate,
  searchScope: acquisition.searchScope || {},
  keywordSource: acquisition.keywordSource,
  platformPolicy: acquisition.platformPolicy || {},
  cityScopes: acquisition.cityScopes || [],
  nativeFilters: acquisition.nativeFilters || {},
  nativeFilterCatalogRevision: acquisition.nativeFilterCatalogRevision || "",
  modelProfiles
};
```

The production `preparePlanForNewWorkflow` in `dashboard/server.js` must build runtime configs from the current v2 plan and confirmed matching context, then call `rescorePlanObservations` exactly once. The workflow application test must prove the order `active check -> rescore -> planning -> acquisition resolve -> workflow create`; returning an existing active workflow performs none of the last four operations.

The application test must mutate the stored current plan after `createWorkflowRun` and assert the returned workflow retains its original `planHash`, `planSnapshot.directions`, city scopes, and filters.

- [ ] **Step 7: Run workflow-context and pacing tests**

Run:

```powershell
node tests/workflow_acquisition_smoke.js
node tests/workflow_application_smoke.js
node tests/boss_safe_pacing_smoke.js
node tests/site_access_budget_smoke.js
node tests/inherited_search_scope_smoke.js
```

Expected: all five exit 0, and the generated workflow fixture records one frozen plan and one frozen native-filter context.

- [ ] **Step 8: Register the test, but keep browser behavior uncommitted until Task 5 acceptance**

Add `workflow_acquisition_smoke.js` next to workflow planning tests in `tests/run_all.js`. Run `git diff --check`. Do not commit Task 4 files yet because Task 5 must prove real background behavior and immutable scan consumption first.

---

### Task 5: Consume Frozen Context During Scan and Resume, Then Perform Real Read-Only Acceptance

**Files:**
- Modify: `src/cli.js`
- Modify: `src/core/scan_snapshot.js`
- Modify: `src/application/workflow/index.js`
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/view_models/workflow.js`
- Modify: `tests/scan_cli_lifecycle_smoke.js`
- Modify: `tests/scan_snapshot_smoke.js`
- Modify: `tests/scan_end_to_end_recovery_smoke.js`
- Modify: `tests/workflow_recovery_smoke.js`
- Modify: `tests/workflow_dashboard_smoke.js`

**Interfaces:**
- Consumes: new-workflow `planner.planSnapshot`, `planHash`, `cityScopes`, `nativeFilters`, and existing inherited fields.
- Produces: new workflow scans never use a later `search_plans.plan_json` value for mode-specific execution.
- Preserves: a historical generated task with a valid scan execution snapshot can resume; ambiguous historical tasks remain visible but blocked.

- [ ] **Step 1: Add failing frozen-scan and recovery tests**

In `tests/scan_end_to_end_recovery_smoke.js`, create a generated workflow with this frozen context, then update live `search_plans.plan_json` to深圳与 3-5 年 before invoking the scan fixture:

```js
const frozenCities = [{ city: "广州", cityCode: "101280100" }];
const frozenFilters = {
  site: "boss", catalogVersion: "catalog-r1",
  params: { experience: ["104"] },
  labels: { experience: ["1-3年"] },
  lanes: [{ id: "default", rank: 0, params: { experience: ["104"] }, labels: { experience: ["1-3年"] } }],
  warnings: []
};
assert.strictEqual(execution.searchTemplate.mode, "generated");
assert.deepStrictEqual(execution.cityScopes, frozenCities);
assert.deepStrictEqual(execution.nativeFilters, frozenFilters);
```

In `tests/workflow_recovery_smoke.js`, cover three exact cases: valid new generated snapshot resumes; historical generated workflow plus valid batch execution snapshot resumes; missing mode or invalid hash returns 409.

- [ ] **Step 2: Run scan and recovery tests and confirm current-plan drift**

Run:

```powershell
node tests/scan_end_to_end_recovery_smoke.js
node tests/workflow_recovery_smoke.js
```

Expected: the generated test fails because current `cli.js` rebuilds cities and native filters from the later plan.

- [ ] **Step 3: Select the frozen runtime plan before building configs**

In `cli.js`, after resolving `workflowRun`, choose the runtime plan once:

```js
let runtimePlanRecord = planRecord;
if (workflowRun?.planner?.planSnapshotVersion === 2) {
  assertFrozenWorkflowPlan(workflowRun.planner);
  runtimePlanRecord = { ...planRecord, plan: workflowRun.planner.planSnapshot };
}
const runtimePlan = runtimePlanRecord?.plan || {};
```

Use `runtimePlanRecord` for `assertSearchPlanReady`, `profileToRuntimeConfigs`, `resolveScanPolicy`, site selection, generated city scopes, native filters, and source labels. For a frozen workflow, do not call `getSearchPlanDependency` against the later plan.

Keep a logged compatibility branch for historical generated tasks. It may use the historical plan record only when no v2 planner exists; if a valid stored execution snapshot exists, that snapshot remains authoritative for browser targets.

- [ ] **Step 4: Consume both frozen acquisition contexts without live recomputation**

Build mode context as follows:

```js
const frozenGenerated = workflowAcquisitionMode === "generated"
  && workflowRun.planner?.planSnapshotVersion === 2
  ? assertCompleteGeneratedContext(workflowRun.planner, { planId: runtimePlanRecord.id })
  : null;

if (frozenInherited) {
  searchTemplate = frozenInherited.searchTemplate;
  searchScope = frozenInherited.searchScope;
  keywordSource = frozenInherited.keywordSource;
  platformPolicy = frozenInherited.platformPolicy;
  cityScopes = [{
    city: platformPolicy.filters?.location?.cities?.[0] || "",
    cityCode: searchTemplate.cityCode || "platform-default"
  }];
} else if (frozenGenerated) {
  searchTemplate = frozenGenerated.searchTemplate;
  keywordSource = frozenGenerated.keywordSource;
  cityScopes = frozenGenerated.cityScopes;
  nativeFilterSnapshot = frozenGenerated.nativeFilters;
  platformPolicy = frozenGenerated.platformPolicy;
  configs = applyPlatformRuntimePolicy(configs, platformPolicy, { acquisitionMode: "generated" });
}
```

Skip `resolveBossPlatformFilters` whenever `frozenGenerated` exists. Direct non-workflow scans may resolve the current saved plan at launch; resume with a stored execution snapshot remains governed by `assertScanSnapshotCompatible`.

Extend `buildScanExecutionSnapshot` without breaking historical snapshots: add optional `planHash`, and preserve `nativeFilters.catalogVersion`, top-level labels, and per-lane labels when present. The compatibility comparison ignores `planHash` only when both stored and current snapshots omit it.

```js
const snapshot = {
  schemaVersion: SCHEMA_VERSION,
  createdAt: new Date().toISOString(),
  ...(String(input.planHash || "").trim() ? { planHash: String(input.planHash).trim() } : {}),
  // existing site, scanKind, detailMode, policy, search and target fields
};

function normalizeExecutionFilters(value = {}) {
  return cloneJson({
    site: String(value?.site || ""),
    ...(value?.catalogVersion ? { catalogVersion: String(value.catalogVersion) } : {}),
    params: value?.params || {},
    labels: value?.labels || {},
    lanes: (value?.lanes || []).map((lane, index) => ({
      id: String(lane?.id || `lane-${index + 1}`),
      rank: Number.isFinite(Number(lane?.rank)) ? Number(lane.rank) : index,
      params: lane?.params || {},
      labels: lane?.labels || {}
    }))
  });
}
```

Pass `planHash: workflowRun?.planner?.planHash || ""` from `cli.js`. New workflow tests must assert planner and execution hashes match.

- [ ] **Step 5: Validate browser readiness for either mode on resume**

In `resumeWorkflow`, validate the mode-specific planner and probe readiness whenever browser work remains:

```js
if (acquisitionMode === "generated" && workflow.planner?.planSnapshotVersion === 2) {
  assertFrozenWorkflowPlan(workflow.planner);
  assertCompleteGeneratedContext(workflow.planner, { planId: workflow.planId });
}
if (requiresBrowser) {
  const readiness = publicBrowserReadinessSnapshot(await browserReadinessProbe({ browserMode, cdpPort }));
  assertWorkflowResumeBrowserReady(readiness);
}
```

For new v2 workflows, require stored `browserMode === "edge"`. Preserve the historical portable branch only for old persisted workflows.

- [ ] **Step 6: Show both frozen modes on the workflow page**

In `view_models/workflow.js`, return a visible generated scope:

```js
if (planner.acquisitionMode === "generated") {
  return {
    visible: true,
    mode: "通用模式",
    filters: Object.entries(planner.nativeFilters?.labels || {})
      .flatMap(([name, values]) => values.map((value) => `${name}：${value}`)),
    cities: (planner.cityScopes || []).map((item) => item.city || item.cityCode),
    actualKeywords: planner.keywordSource?.keywords || [],
    unresolved: []
  };
}
```

Keep the existing inherited recognized/unresolved rows. Add a short plan hash and “方案后续修改不会影响本轮”。

- [ ] **Step 7: Run the focused offline regression**

Run:

```powershell
node tests/workflow_acquisition_smoke.js
node tests/workflow_application_smoke.js
node tests/scan_cli_lifecycle_smoke.js
node tests/scan_snapshot_smoke.js
node tests/scan_end_to_end_recovery_smoke.js
node tests/workflow_recovery_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/boss_safe_pacing_smoke.js
node tests/site_access_budget_smoke.js
```

Expected: all nine commands exit 0.

- [ ] **Step 8: Perform the smallest real inherited-context acceptance**

Using the currently logged-in Edge and two operator-labeled tabs:

1. Record the foreground tab and numeric fixed-tab IDs.
2. Start one inherited workflow context read from the local RoleFlow page.
3. Verify returned city/filter summary against redacted DOM and URL evidence.
4. Re-read the foreground tab and fixed-tab IDs.

Pass condition: no BOSS tab became active, no `Page.bringToFront` occurred, no navigation occurred, numeric bindings remained unchanged, and unresolved URL values were not displayed as “不限”。

- [ ] **Step 9: Perform one minimal real generated scan acceptance**

Use a new small通用模式方案 with one city, one A-priority keyword, one salary lane, one experience selection, `maxCards` at the product minimum, and one allowed detail read. Keep the operation serial and let the existing pacing/cooldown controller decide timing.

Pass condition:

- Actual search URL/DOM contains the frozen city and native-filter codes.
- Scan execution snapshot has the same `planHash`, city scopes, keyword, and native filters as `planner_json`.
- The one JD read uses `trusted_pane` and creates a checkpoint.
- Foreground tab does not change and no extra BOSS session/window appears.
- Every issued catalog/search/detail attempt is present in the access ledger, including failed attempts.
- Login, risk-control, page-loss, target mismatch, or ambiguous filter state stops immediately and leaves the target pending.

- [ ] **Step 10: Run forbidden-path scans and commit Tasks 4-5 together**

Run:

```powershell
rg -n "Page\.bringToFront|active:\s*true|search_page_api|standalone_detail" src/application/workflow src/dashboard src/core/workflow_acquisition.js src/cli.js
rg -n "enforceBudget:\s*false" src/adapters/sites/boss.js
git diff --check
```

Expected: no new focus activation; `search_page_api` only appears in existing rejection/retained research contracts; `standalone_detail` is absent from the changed scan path; catalog refresh has no budget bypass. Then commit:

```powershell
git add src/core/workflow_acquisition.js src/core/inherited_search_scope.js src/core/platform_runtime_policy.js src/core/scan_snapshot.js src/adapters/sites/boss.js src/application/workflow/index.js src/dashboard/server.js src/dashboard/view_models/workflow.js src/cli.js tests/workflow_acquisition_smoke.js tests/workflow_application_smoke.js tests/boss_safe_pacing_smoke.js tests/site_access_budget_smoke.js tests/scan_cli_lifecycle_smoke.js tests/scan_snapshot_smoke.js tests/scan_end_to_end_recovery_smoke.js tests/workflow_recovery_smoke.js tests/workflow_dashboard_smoke.js tests/run_all.js
git commit -m "feat: freeze workflow acquisition contexts"
```

---

### Task 6: Add a Sanitized Inherited Preview Endpoint

**Files:**
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/pages/today.js`
- Modify: `src/dashboard/view_models/today.js`
- Modify: `tests/today_dashboard_smoke.js`
- Modify: `tests/workflow_dashboard_smoke.js`

**Interfaces:**
- Produces: GET `/api/acquisition-preview?planId=<id>` returning only `{ mode, status, summary, filters, unresolved, checkedAt }`.
- The endpoint never returns full BOSS URL, `securityId`, Cookie, numeric tab IDs, or Edge bridge response text.

- [ ] **Step 1: Add failing public-preview tests**

Add a fake injected resolver in the dashboard server test:

```js
const preview = await requestJson(`/api/acquisition-preview?planId=${planId}`);
assert.strictEqual(preview.body.mode, "inherited");
assert.deepStrictEqual(preview.body.filters, ["城市：广州", "经验：1-3年"]);
assert.deepStrictEqual(preview.body.unresolved, ["某平台参数未能识别"]);
assert.strictEqual(JSON.stringify(preview.body).includes("securityId"), false);
assert.strictEqual(JSON.stringify(preview.body).includes("https://www.zhipin.com"), false);
```

Add a running-scan fixture and assert the endpoint returns 409 without calling the resolver.

- [ ] **Step 2: Run dashboard tests and confirm the endpoint is absent**

Run:

```powershell
node tests/today_dashboard_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: FAIL with 404 or missing preview output.

- [ ] **Step 3: Implement the sanitized, no-navigation preview endpoint**

Require an inherited plan, no active site scan lease, and no BOSS runtime block. Call the inherited inspector used by Task 4, then map only safe labels:

```js
function publicAcquisitionPreview(context, checkedAt = new Date().toISOString()) {
  return {
    mode: "inherited",
    status: context.platformPolicy?.unresolvedParams?.length ? "partial" : "ready",
    summary: (context.platformPolicy?.filterSummary || []).join("；") || "当前 BOSS 搜索页未识别到额外筛选条件",
    filters: [...(context.platformPolicy?.filterSummary || [])],
    unresolved: (context.platformPolicy?.unresolvedParams || []).map(() => "某平台参数未能识别"),
    checkedAt
  };
}

const context = await inheritedPreviewResolver({ db, plan, matchingContext, logger });
return sendJson(res, 200, publicAcquisitionPreview(context));
```

Map known login, risk, tab, page, and disconnect errors to existing public error messages. Never include raw `error.message` from the Edge bridge in JSON.

- [ ] **Step 4: Fetch the preview once without navigating or polling**

Only when the saved mode is inherited, fetch once on initial page load and once after the user explicitly switches back to inherited:

```js
async function refreshInheritedPreview() {
  const node = form.querySelector('[data-inherited-preview]');
  if (!node || form.querySelector('input[name=acquisitionMode]:checked')?.value !== 'inherited') return;
  const response = await fetch(`/api/acquisition-preview?planId=${encodeURIComponent(planId)}`, { cache: 'no-store' });
  const value = await response.json();
  node.textContent = response.ok ? value.summary : (value.error || '暂时无法读取当前 BOSS 搜索范围。');
}
```

- [ ] **Step 5: Run UI tests and repeat the inherited background acceptance**

Run:

```powershell
node tests/today_dashboard_smoke.js
node tests/workflow_dashboard_smoke.js
```

Then repeat Task 5 Step 8 with the real endpoint. Pass condition remains: one read, no navigation, no focus change, no sensitive URL or identifier in the response.

- [ ] **Step 6: Commit the preview slice**

Run:

```powershell
git diff --check
git add src/dashboard/server.js src/dashboard/pages/today.js src/dashboard/view_models/today.js tests/today_dashboard_smoke.js tests/workflow_dashboard_smoke.js
git commit -m "feat: preview inherited search scope safely"
```

---

### Task 7: Run Offline Regression, Fresh Paired Baselines, and Update Handoff

**Files:**
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/NEXT_PHASE.md`
- Modify: `docs/superpowers/specs/2026-08-16-generic-inherited-screening-modes-design.md`
- Create after measured runs: `docs/superpowers/reports/2026-08-16-generic-inherited-screening-modes-acceptance.md`

**Interfaces:**
- Consumes: committed v2 plan, frozen workflow planner, scan execution snapshots, access ledger, and human labels.
- Produces: a factual acceptance report with separate inherited/generated measurements and an explicit default-mode decision status.

- [ ] **Step 1: Run every offline check except the forbidden Edge-launch test**

Use this PowerShell runner so the list still comes from `tests/run_all.js`:

```powershell
$testFiles = Get-Content tests/run_all.js | ForEach-Object {
  if ($_ -match '^\s*"([^"]+\.js)",?\s*$') { $matches[1] }
} | Where-Object { $_ -ne 'startup_scripts_smoke.js' }
foreach ($testFile in $testFiles) {
  Write-Host "> $testFile"
  node (Join-Path tests $testFile)
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Host "Passed $($testFiles.Count) offline checks; startup_scripts_smoke.js intentionally skipped."
```

Expected: every selected test exits 0. Record the exact count; do not claim `npm test` or `npm run check` passed because they were intentionally not run.

- [ ] **Step 2: Prepare two isolated empty operational baselines on D:**

Resolve the exact commit and prepare distinct immutable targets:

```powershell
$sourceCommit = git rev-parse HEAD
node scripts/prepare-gate-d-baseline.js --source data/jobs.sqlite --source-commit $sourceCommit --protected-db data/jobs.sqlite --archive D:\DevData\RoleFlow-mode-acceptance\archive\inherited-source.sqlite --baseline D:\DevData\RoleFlow-mode-acceptance\baseline\inherited.sqlite
node scripts/prepare-gate-d-baseline.js --source data/jobs.sqlite --source-commit $sourceCommit --protected-db data/jobs.sqlite --archive D:\DevData\RoleFlow-mode-acceptance\archive\generated-source.sqlite --baseline D:\DevData\RoleFlow-mode-acceptance\baseline\generated.sqlite
```

Confirm both `.report.json` files show every operational table at zero and the preserved candidate profile, resume versions, search plan, and matching card remain present. Separately hash the external model-settings file before and after baseline preparation and confirm it did not change. Do not overwrite or delete `data/jobs.sqlite`.

- [ ] **Step 3: Save mode-specific plan snapshots without changing local quality settings**

In the inherited baseline, save the v2 plan with `acquisitionMode: "inherited"`. In the generated baseline, save a v2 plan with `acquisitionMode: "generated"` and platform conditions equivalent to the inherited page as closely as the current catalog allows. Keep these values exactly equal between baselines:

```json
{
  "directions": "same",
  "keywords": "same words, priorities, order and reasons",
  "salary": "same min/max and mode",
  "excludeWords": "same",
  "hardExcludes": "same",
  "bossActiveDays": "same",
  "workSchedulePreference": "same",
  "allowExperienceStretch": "same",
  "scan": "same logical card/detail/page budgets",
  "matchingCardRevision": "same",
  "modelProfiles": "same"
}
```

Record both plan hashes and the actual inherited/generated platform range in the acceptance report before scanning.

- [ ] **Step 4: Run one read-only paired acquisition sample per mode**

Run inherited first, allow its checkpoint and cooldown state to settle, then run generated. Never run the two baselines in parallel. Use the same logged-in Edge profile and a comparable time window. If login, risk, or page loss occurs, stop and record the interruption instead of retrying automatically.

For each mode, copy into the report from `workflow_runs.metrics_json`, `batches.filter_snapshot_json`, `scan_target_results`, `job_observations`, `jobs`, and site-access events:

- discovered and deduplicated jobs;
- jobs requiring full JD, successfully read, pending, failed, reused, and final coverage ratio;
- `primary`, `apply`, `caution`, `not_recommended` counts and ratios;
- list navigation, detail read, and list scroll counts;
- start/finish timestamps, elapsed time, cooldown time, and interruption codes.

- [ ] **Step 5: Human-label the union and calculate relative recall**

Build the union key as `source + ':' + source_id` across both baseline databases. For every union job, record `relevant: true|false` and `hardFalseRecommendation: true|false` after reading its available JD evidence. Calculate:

```text
relevantUnion = count(union rows where relevant = true)
inheritedRecall = inherited relevant keys / relevantUnion
generatedRecall = generated relevant keys / relevantUnion
hardFalseCount = count(recommended rows where hardFalseRecommendation = true)
jdCoverage = successful full JD reads / jobs requiring full JD
```

Label the metric “相对召回率”; do not call it absolute platform recall.

- [ ] **Step 6: Write the factual acceptance report**

Create `docs/superpowers/reports/2026-08-16-generic-inherited-screening-modes-acceptance.md` with this table. Every cell must contain a measured value or the literal `未执行（原因：…）`:

```markdown
| 指标 | 继承模式 | 通用模式 | 差值 |
| --- | ---: | ---: | ---: |
| 发现岗位 |  |  |  |
| 去重岗位 |  |  |  |
| 人工相关并集命中 |  |  |  |
| 相对召回率 |  |  |  |
| 完整 JD 成功/应读 |  |  |  |
| 完整 JD 覆盖率 |  |  |  |
| primary/apply/caution/not_recommended |  |  |  |
| 硬性错误推荐 |  |  |  |
| 页面跳转/详情读取/滚动 |  |  |  |
| 总耗时/冷却耗时 |  |  |  |
| 登录/风控/页面丢失中断 |  |  |  |
```

Below the table, record plan hashes, execution snapshot hashes, redacted fixed-tab evidence, foreground-before/after evidence, unresolved filters, and whether the default mode remains inherited. If quality is lower in either mode, report the exact tradeoff and leave the default unchanged for user decision.

- [ ] **Step 7: Update authoritative handoff documents only with verified facts**

Update:

- `docs/PROJECT_HANDOFF.md`: commits, exact tests, manual acceptance, known limitations, and the next safe action.
- `docs/NEXT_PHASE.md`: mark Topic 3 implemented only if its completion boundary is met; otherwise state the exact remaining gate.
- Design status line: use `状态：已实现并完成自动化验证；真实质量基线见验收报告` only when the report contains both measured modes. If either run is absent, use `状态：实现完成；真实质量基线未完成`.

- [ ] **Step 8: Verify documentation and commit acceptance evidence**

Run:

```powershell
rg -n "T[B]D|T[O]DO|待[定]|待[补]" docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md docs/superpowers/specs/2026-08-16-generic-inherited-screening-modes-design.md docs/superpowers/reports/2026-08-16-generic-inherited-screening-modes-acceptance.md
git diff --check
git status --short
git add docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md docs/superpowers/specs/2026-08-16-generic-inherited-screening-modes-design.md docs/superpowers/reports/2026-08-16-generic-inherited-screening-modes-acceptance.md
git commit -m "docs: hand off screening acquisition modes"
```

Expected: no unresolved markers, unrelated files, secrets, or full BOSS URLs. Do not push, merge, tag, package, or release.
