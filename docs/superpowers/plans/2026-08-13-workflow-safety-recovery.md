# Workflow Safety and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复继承模式误阻塞、阶段进度失真、普通 Edge 沟通占用消息页、沟通歧义误报失败和 HR 主动入站无法纳入进展的问题，同时保留所有已验证的安全门。

**Architecture:** 继续复用现有 Search Plan、扫描快照、`workflow_job_tasks`、沟通批次和 `communicationAmbiguityState()`，不建立平行状态机。普通 Edge 沟通把运行绑定持久化到 `communication_batches.runtime_json`，只临时使用固定搜索标签打开用户已确认的少量岗位，批次外层统一恢复搜索页；消息页始终保留在聊天页。HR 主动入站只保存已核验的岗位摘要和摘要哈希，由用户执行本地关联、保存或忽略，不调用模型、不触发浏览器写动作。

**Tech Stack:** Node.js 22 CommonJS、`node:sqlite`、原生 HTTP Dashboard、现有 Edge bridge/CDP 适配器、`node:assert/strict` smoke tests。

## Global Constraints

- 当前采集主线只能使用 `trusted_pane`；任何测试、校准、扫描和产品流程都不得传入或启用 `search_page_api`。
- 不修改、不验收、不优化、不删除 `search_page_api`；它保留为后续独立拓展。
- 不启用 `standalone_detail` 作为岗位采集方案；沟通阶段临时打开用户已确认岗位不属于批量详情采集。
- 不执行真实沟通、发送消息、投递或申请；离线测试使用假浏览器，最后的真实验收最多只读导航与恢复。
- 普通 Edge 只能使用同一窗口中的 `BOSS-SEARCH` 和 `BOSS-COMMUNICATION` 两个固定标签；不得创建第三个 BOSS 标签或第二个会话。
- Edge bridge 返回的 `tabId`、`windowId` 必须保持原始数值类型传回桥接层。
- 登录失效、风控、固定标签丢失/换窗、点击后结果不明确、审计不一致必须停止外部动作。
- 自动恢复只允许发生在点击前，并且每个条目最多一次；第二次失败转为暂停或中断。
- 不降低关键词数、详情预算、JD 覆盖率、召回率或匹配质量。
- 不把失败、中断或旧规则数据库纳入 Gate D 质量评测。
- Wave 5 保持暂停。
- 不增加第三方依赖；优先复用现有函数和数据库表。

---

## File Map

### 计划校验与进度

- Modify: `src/core/plan_validation.js` — 显式区分 `inherited` 与 `generated` 采集模式。
- Modify: `src/application/workflow/index.js` — 工作流启动使用同一校验规则。
- Modify: `src/cli.js` — 扫描、恢复和非采集重算传入明确采集语义。
- Modify: `src/dashboard/server.js` — Dashboard 保存、启动和只读状态使用一致规则。
- Modify: `src/core/workflow_progress.js` — 从现有快照、目标结果、JD、分析任务和沟通条目生成分阶段进度。
- Create: `src/dashboard/status_labels.js` — 工作流和沟通状态的统一中文映射。
- Modify: `src/dashboard/view_models/workflow.js` — 生成真实“剩余工作”和正确“下一步”。
- Modify: `src/dashboard/pages/workflow.js` — 展示分阶段数量，暂停按钮降为次要操作。
- Modify: `src/dashboard/assets/workflow.js` — 轮询复用服务端进度文案，不自动聚焦暂停按钮。

### 普通 Edge 沟通绑定与恢复

- Modify: `src/core/storage.js` — 增加 `communication_batches.runtime_json` 迁移。
- Modify: `src/storage/communication_store.js` — 校验、写入、核对和显式更新沟通浏览器绑定。
- Modify: `src/core/communication_batches.js` — 继续作为存储接口转发层。
- Modify: `src/adapters/sites/boss.js` — 已绑定普通 Edge 使用搜索标签打开沟通岗位，消息标签保持聊天页，外层恢复搜索页。
- Modify: `src/core/site_access_budget.js` — 点击前一次恢复产生的额外导航独立计入现有沟通访问预算。
- Modify: `src/core/communication_executor.js` — 只在点击前执行一次可恢复重试。
- Modify: `src/application/communication/index.js` — 拒绝未绑定或存在点击歧义的继续执行，提供显式重绑入口。
- Modify: `src/cli.js` — 串起预检、持久化绑定、执行和一次性搜索页恢复。
- Modify: `src/dashboard/server.js` — 提供“重新检查浏览器页面”的显式只读重绑处理。
- Modify: `src/dashboard/view_models/communication.js` — 把歧义派生为 `needs_resolution`，把绑定恢复状态交给页面。
- Modify: `src/dashboard/pages/communication.js` — 中文状态、歧义说明和显式重绑按钮。

### HR 主动入站

- Modify: `src/core/storage.js` — 为未解决消息增加安全岗位摘要字段。
- Modify: `src/core/message_preview_state.js` — 只存标题、公司、薪资、城市和组合摘要。
- Modify: `src/core/message_discovery.js` — 匹配失败时持久化已经过 reader 核验的岗位摘要。
- Create: `src/application/message_discovery/inbound.js` — 在单个事务中完成关联、保存或忽略。
- Modify: `src/core/candidate_progress.js` — 允许读取带岗位摘要的进展卡并绑定摘要化 thread key。
- Modify: `src/dashboard/message_discovery_view.js` — 显示三种本地处理动作。
- Modify: `src/dashboard/server.js` — 接收本地处理请求。
- Modify: `src/dashboard/server.js` — 求职进展池直接合并无扫描 observation 的入站进展卡。

### 回归测试

- Modify: `tests/profile_quality_smoke.js`
- Modify: `tests/workflow_progress_smoke.js`
- Modify: `tests/workflow_page_migration_smoke.js`
- Modify: `tests/workflow_dashboard_smoke.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/communication_store_contract_smoke.js`
- Modify: `tests/communication_cli_authority_smoke.js`
- Modify: `tests/communication_executor_smoke.js`
- Modify: `tests/boss_communication_page_smoke.js`
- Modify: `tests/dashboard_communication_batch_smoke.js`
- Modify: `tests/message_preview_state_smoke.js`
- Modify: `tests/message_discovery_smoke.js`
- Modify: `tests/dashboard_message_discovery_smoke.js`
- Modify: `tests/data_visibility_smoke.js`

---

### Task 1: Make Search Plan validation acquisition-aware

**Files:**
- Modify: `src/core/plan_validation.js:5-39`
- Modify: `src/application/workflow/index.js:24-35`
- Modify: `src/cli.js:694-723, 885-900, 1547-1559, 2277-2289, 2335-2345`
- Modify: `src/dashboard/server.js:1220-1232, 1264-1271, 3346-3353`
- Test: `tests/profile_quality_smoke.js`
- Test: `tests/workflow_application_smoke.js`
- Test: `tests/workflow_dashboard_smoke.js`

**Interfaces:**
- Consumes: `plan`, confirmed candidate profile and existing dependency snapshot.
- Produces: `validateSearchPlan(plan, candidateProfile, { acquisitionMode })` and `assertSearchPlanReady(..., { acquisitionMode })`.
- Valid values: `"inherited"` and `"generated"`; omitted mode defaults to `"generated"` for backward-safe direct callers.

- [ ] **Step 1: Add failing unit coverage for the two acquisition modes**

```js
const noCityPlan = { ...plan, cities: [] };
assert.strictEqual(
  validateSearchPlan(noCityPlan, profile, { acquisitionMode: "inherited" }).valid,
  true
);
assert.deepStrictEqual(
  validateSearchPlan(noCityPlan, profile, { acquisitionMode: "generated" }).errors,
  ["至少选择一个目标城市。"]
);
assert.strictEqual(
  validateSearchPlan({ ...noCityPlan, keywords: [{ word: "RAG" }] }, profile, {
    acquisitionMode: "inherited"
  }).valid,
  false
);
```

- [ ] **Step 2: Run the focused checks and confirm the inherited case fails first**

Run:

```powershell
node tests/profile_quality_smoke.js
node tests/workflow_application_smoke.js
```

Expected: at least the empty-city inherited assertion fails because the current validator always requires `cities`.

- [ ] **Step 3: Implement the explicit mode rule in the shared validator**

```js
function validateSearchPlan(
  plan = {},
  candidateProfile = {},
  { acquisitionMode = "generated" } = {}
) {
  const errors = [];
  const warnings = [];
  const mode = String(acquisitionMode || "").trim().toLowerCase();
  if (!["generated", "inherited"].includes(mode)) {
    return { valid: false, errors: ["采集模式无效。"], warnings };
  }
  const cities = plan.cities || [];
  if (mode === "generated" && !cities.length) {
    errors.push("至少选择一个目标城市。");
  }
  if (mode === "generated" && (plan.platform?.site || "boss") === "boss") {
    const unsupportedCities = cities.filter((city) => !cityToBossCode(city));
    if (unsupportedCities.length) {
      errors.push(`BOSS 暂不支持这些城市：${unsupportedCities.join("、")}。请从城市选项中选择。`);
    }
  }
  // Existing directions, keyword, salary, exclusion and budget checks remain unchanged.
}
```

Delete the overloaded `validatePlatformCities` meaning after all callers are migrated.

- [ ] **Step 4: Update callers to state their real acquisition semantics**

Use:

```js
{ acquisitionMode: "inherited" }
```

for the current Dashboard workflow start, inherited scan recovery, plan persistence that does not generate platform URLs, detail refresh, reassessment and rescore.

Use:

```js
{ acquisitionMode: "generated" }
```

only where RoleFlow itself constructs platform city URLs from Search Plan cities.

For CLI scan, pass the already resolved `acquisitionMode`:

```js
assertSearchPlanReady(
  planRecord,
  matchingContext?.candidateProfile || {},
  getSearchPlanDependency(db, planRecord.id),
  { acquisitionMode }
);
```

- [ ] **Step 5: Add a Dashboard regression that proves the backend no longer blocks inherited empty-city execution**

```js
const inheritedNoCity = seedProfile(db);
const row = db.prepare("SELECT plan_json FROM search_plans WHERE id = ?").get(inheritedNoCity.planId);
const savedPlan = JSON.parse(row.plan_json);
savedPlan.cities = [];
db.prepare("UPDATE search_plans SET plan_json = ? WHERE id = ?")
  .run(JSON.stringify(savedPlan), inheritedNoCity.planId);

const result = await postForm(baseUrl, "/api/workflow-run", {
  planId: inheritedNoCity.planId,
  browserMode: "edge",
  action: "start"
});
assert.strictEqual(result.status, 303);
```

- [ ] **Step 6: Run focused validation and workflow tests**

Run:

```powershell
node tests/profile_quality_smoke.js
node tests/workflow_application_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: all pass; generated mode still rejects missing/unsupported cities and inherited mode still rejects one keyword, reversed salary bounds and exclusion conflicts.

- [ ] **Step 7: Commit the acquisition-mode fix**

```powershell
git add src/core/plan_validation.js src/application/workflow/index.js src/cli.js src/dashboard/server.js tests/profile_quality_smoke.js tests/workflow_application_smoke.js tests/workflow_dashboard_smoke.js
git commit -m "fix: validate inherited search plans by acquisition mode"
```

---

### Task 2: Build truthful stage-specific workflow progress

**Files:**
- Modify: `src/core/workflow_progress.js:35-148, 298-347`
- Create: `src/dashboard/status_labels.js`
- Modify: `src/dashboard/view_models/workflow.js:5-115, 147-186`
- Modify: `src/dashboard/pages/workflow.js:20-49, 70-76`
- Modify: `src/dashboard/assets/workflow.js:17-98`
- Test: `tests/workflow_progress_smoke.js`
- Test: `tests/workflow_page_migration_smoke.js`
- Test: `tests/workflow_dashboard_smoke.js`

**Interfaces:**
- Consumes: `batches.filter_snapshot_json.execution.targets`, latest `scan_target_results`, current batch observations, `workflow_job_tasks` and `communication_batch_items`.
- Produces:

```js
progress.scanTargets = { total, completed, pending, partial, failed };
progress.details = { collected, read, pending };
progress.analysis = { total, succeeded, running, retryPending, detailRequired, failed, stopped, pending };
progress.communication = { total, pending, ambiguous, succeeded, stopped };
progress.remainingWorkLabel = "阶段对应的中文主待办";
```

- [ ] **Step 1: Add failing snapshot tests for scan targets, pending details and communication ambiguity**

```js
assert.deepStrictEqual(snapshot.progress.scanTargets, {
  total: 5,
  completed: 2,
  pending: 3,
  partial: 1,
  failed: 1
});
assert.deepStrictEqual(snapshot.progress.details, {
  collected: 12,
  read: 5,
  pending: 7
});
assert.match(snapshot.progress.remainingWorkLabel, /7 个岗位详情待读取/);

assert.deepStrictEqual(communicationSnapshot.progress.communication, {
  total: 2,
  pending: 1,
  ambiguous: 1,
  succeeded: 0,
  stopped: 0
});
assert.match(communicationSnapshot.progress.remainingWorkLabel, /1 个结果待人工确认/);
assert.match(communicationSnapshot.progress.remainingWorkLabel, /1 个岗位未执行/);
```

Seed the execution target list in `batches.filter_snapshot_json.execution.targets`; do not infer the total from result rows because unstarted targets have no result row.

- [ ] **Step 2: Run the focused progress test and confirm missing fields**

Run:

```powershell
node tests/workflow_progress_smoke.js
```

Expected: FAIL because `scanTargets`, `details`, `communication` and `remainingWorkLabel` do not exist.

- [ ] **Step 3: Read target totals from the frozen execution snapshot and latest result per target**

Add focused helpers:

```js
function countScanTargets(db, scanBatchId) {
  const batch = db.prepare("SELECT filter_snapshot_json FROM batches WHERE id = ?")
    .get(Number(scanBatchId || 0));
  const execution = parseJson(batch?.filter_snapshot_json, {}).execution;
  const targets = Array.isArray(execution?.targets) ? execution.targets : [];
  const rows = db.prepare(`
    SELECT result.target_key, result.status
    FROM scan_target_results result
    JOIN (
      SELECT target_key, MAX(id) AS id
      FROM scan_target_results
      WHERE batch_id = ?
      GROUP BY target_key
    ) latest ON latest.id = result.id
  `).all(Number(scanBatchId || 0));
  const statusByKey = new Map(rows.map((row) => [row.target_key, row.status]));
  const result = { total: targets.length, completed: 0, pending: 0, partial: 0, failed: 0 };
  for (const target of targets) {
    const status = statusByKey.get(target.targetKey);
    if (status === "completed") result.completed += 1;
    else result.pending += 1;
    if (status === "partial") result.partial += 1;
    if (status === "failed") result.failed += 1;
  }
  return result;
}
```

`partial` and `failed` are `pending` 的解释性子集；页面不得把三者相加。

- [ ] **Step 4: Aggregate communication entries without treating ambiguity as completed work**

```js
function countCommunicationItems(db, communicationBatchId) {
  const counts = Object.fromEntries(db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM communication_batch_items
    WHERE batch_id = ?
    GROUP BY status
  `).all(Number(communicationBatchId || 0))
    .map((row) => [row.status, Number(row.count)]));
  const pendingStatuses = ["pending", "opening", "verified", "click_dispatched"];
  const succeededStatuses = ["succeeded", "already_communicated"];
  const stoppedStatuses = [
    "stopped", "job_unavailable", "target_mismatch", "action_unavailable",
    "platform_rejected", "transport_failed"
  ];
  return {
    total: Object.values(counts).reduce((sum, value) => sum + value, 0),
    pending: pendingStatuses.reduce((sum, key) => sum + (counts[key] || 0), 0),
    ambiguous: counts.ambiguous || 0,
    succeeded: succeededStatuses.reduce((sum, key) => sum + (counts[key] || 0), 0),
    stopped: stoppedStatuses.reduce((sum, key) => sum + (counts[key] || 0), 0)
  };
}
```

- [ ] **Step 5: Produce one server-side remaining-work label and pass it through the polling API**

```js
function workflowRemainingWorkLabel(status, progress) {
  if (status === "scanning") {
    return `还需完成 ${progress.scanTargets.pending} 个搜索目标；${progress.details.pending} 个岗位详情待读取`;
  }
  if (status === "analyzing" || status === "paused") {
    const pending = progress.analysis.pending
      + progress.analysis.running
      + progress.analysis.retryPending;
    return `还有 ${pending} 个岗位待分析；${progress.analysis.detailRequired} 个岗位待补详情`;
  }
  if (status === "review_required") {
    return "岗位已准备完成，等待你确认清单";
  }
  if (status === "communicating" || status === "interrupted") {
    return `还有 ${progress.communication.pending} 个岗位未执行；${progress.communication.ambiguous} 个结果待人工确认`;
  }
  return "本轮没有未完成工作";
}
```

Keep legacy `collected`, `detailsRead` and `detailsPending` fields for one release so existing clients remain readable; set them from the new `details` object.

- [ ] **Step 6: Add the shared Chinese status mapping**

Create:

```js
"use strict";

const COMMUNICATION_STATUS_LABELS = Object.freeze({
  pending: "待执行",
  opening: "正在核对",
  verified: "身份已核验",
  click_dispatched: "已发出操作",
  succeeded: "已核验成功",
  already_communicated: "已确认已沟通",
  ambiguous: "结果待人工确认",
  stopped: "已停止",
  job_unavailable: "岗位不可用",
  target_mismatch: "目标不匹配",
  action_unavailable: "操作不可用",
  platform_rejected: "平台拒绝",
  transport_failed: "传输失败",
  confirmed: "等待确认",
  running: "执行中",
  paused: "已暂停",
  interrupted: "等待处理",
  completed: "已完成",
  failed: "未完成"
});

function communicationStatusLabel(value) {
  return COMMUNICATION_STATUS_LABELS[String(value || "")] || "状态待确认";
}

module.exports = { communicationStatusLabel };
```

Diagnostics may continue showing raw values; product pages may not.

- [ ] **Step 7: Make the initial page and live polling display the same server value**

In the view model:

```js
remainingWork: progress?.visible
  ? progress.remainingWorkLabel
  : phase.kind === "review"
    ? `已准备 ${phase.review.rows.length} 个候选岗位，等待你确认清单`
    : "本轮没有未完成工作"
```

In the browser asset:

```js
setText("[data-overview-remaining]", snapshot.progress.remainingWorkLabel);
```

Do not recompute or sum counts in the browser.

- [ ] **Step 8: Correct “next action” and remove pause autofocus**

In `nextActionLabel()`:

```js
if (phase.kind === "active") {
  return controls.pausedVisible ? "检查暂停原因后继续本轮" : "系统正在继续处理，无需操作";
}
```

In `renderPrimaryCommand()` keep pause visible but remove `data-workflow-primary="true"` from it and apply the existing secondary treatment. In `renderControls()`:

```js
const primary = paused ? resume : null;
nodes('[data-workflow-primary="true"]').forEach((button) => {
  button.removeAttribute("data-workflow-primary");
});
if (primary) primary.dataset.workflowPrimary = "true";
```

Do not call `.focus()` during polling.

- [ ] **Step 9: Update page regressions for truthful copy and no raw English status**

```js
assert.match(scanningHtml, /系统正在继续处理，无需操作/);
assert.doesNotMatch(scanningHtml, /data-workflow-primary="true"[^>]*>暂停本轮/);
assert.doesNotMatch(workflowAsset, /\.focus\(\)/);
assert.match(communicatingHtml, /已发出操作/);
assert.doesNotMatch(communicatingHtml, />click_dispatched</);
assert.match(detailsPendingHtml, /7 个岗位详情待读取/);
```

- [ ] **Step 10: Run focused progress and page checks**

Run:

```powershell
node tests/workflow_progress_smoke.js
node tests/workflow_page_migration_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/dashboard_communication_batch_smoke.js
```

Expected: all pass; scanning with seven unread details never shows “剩余工作 0”.

- [ ] **Step 11: Commit truthful progress**

```powershell
git add src/core/workflow_progress.js src/dashboard/status_labels.js src/dashboard/view_models/workflow.js src/dashboard/pages/workflow.js src/dashboard/assets/workflow.js tests/workflow_progress_smoke.js tests/workflow_page_migration_smoke.js tests/workflow_dashboard_smoke.js tests/dashboard_communication_batch_smoke.js
git commit -m "fix: show truthful workflow stage progress"
```

---

### Task 3: Persist immutable ordinary-Edge communication bindings

**Files:**
- Modify: `src/core/storage.js:97-117, 695-795`
- Modify: `src/storage/communication_store.js:45-160, 483-612`
- Test: `tests/storage_migration_smoke.js`
- Test: `tests/communication_store_contract_smoke.js`

**Interfaces:**
- Produces:

```js
bindCommunicationBatchRuntime(db, {
  batchId,
  browser: {
    mode: "edge",
    windowId: 1995685675,
    searchTabId: 1995685534,
    messageTabId: 1995685619,
    searchReturnUrl: "https://www.zhipin.com/web/geek/jobs?...",
    searchScrollTop: 320,
    bindingGeneration: 1
  },
  rebind: false,
  now
});
```

- First bind: runtime must be empty and generation becomes `1`.
- Normal resume: every field must match the persisted generation.
- Explicit user rebind: allowed only with no `click_dispatched` or `ambiguous` items; generation increases by one.

- [ ] **Step 1: Add migration and contract tests before schema changes**

```js
assert(db.prepare("PRAGMA table_info(communication_batches)").all()
  .some((column) => column.name === "runtime_json"));

const first = bindCommunicationBatchRuntime(db, {
  batchId: batch.id,
  browser: numericBinding({ bindingGeneration: 1 })
});
assert.strictEqual(first.runtime.browser.searchTabId, 1995685534);
assert.strictEqual(typeof first.runtime.browser.searchTabId, "number");

assert.throws(() => bindCommunicationBatchRuntime(db, {
  batchId: batch.id,
  browser: numericBinding({ searchTabId: 123, bindingGeneration: 1 })
}), /COMMUNICATION_BROWSER_BINDING_MISMATCH/);
```

Also assert string IDs are rejected:

```js
assert.throws(() => bindCommunicationBatchRuntime(db, {
  batchId: batch.id,
  browser: { ...numericBinding(), searchTabId: "1995685534" }
}), /COMMUNICATION_BROWSER_BINDING_INVALID/);
```

- [ ] **Step 2: Run the focused tests and confirm the column/interface are absent**

Run:

```powershell
node tests/storage_migration_smoke.js
node tests/communication_store_contract_smoke.js
```

Expected: FAIL on the missing column/export.

- [ ] **Step 3: Add schema version 12**

Add to the current schema:

```sql
runtime_json TEXT NOT NULL DEFAULT '{}',
```

Add migration:

```js
{
  version: 12,
  name: "communication_runtime_binding_v1",
  apply(db) {
    const columns = new Set(db.prepare(
      "PRAGMA table_info(communication_batches)"
    ).all().map((column) => column.name));
    if (!columns.has("runtime_json")) {
      db.exec("ALTER TABLE communication_batches ADD COLUMN runtime_json TEXT NOT NULL DEFAULT '{}'");
    }
  }
}
```

- [ ] **Step 4: Validate trusted search return state**

The validator must require:

```js
Number.isInteger(browser.windowId);
Number.isInteger(browser.searchTabId);
Number.isInteger(browser.messageTabId);
browser.searchTabId !== browser.messageTabId;
Number.isInteger(browser.searchScrollTop) && browser.searchScrollTop >= 0;
Number.isInteger(browser.bindingGeneration) && browser.bindingGeneration > 0;
```

It must also parse `searchReturnUrl`, require `https://www.zhipin.com/web/geek/jobs`, and reject credentials or fragments.

- [ ] **Step 5: Implement atomic initial bind, exact verify and guarded rebind**

```js
function bindCommunicationBatchRuntime(db, input = {}) {
  const batchId = positiveInteger(input.batchId, "COMMUNICATION_BATCH_INVALID", "batchId is required");
  const next = validateBrowserBinding(input.browser);
  const rebind = input.rebind === true;
  db.exec("BEGIN IMMEDIATE");
  try {
    const batch = getCommunicationBatch(db, batchId);
    const current = batch?.runtime?.browser || null;
    if (!current) {
      if (rebind || next.bindingGeneration !== 1) throw codedError(
        "COMMUNICATION_BROWSER_BINDING_INVALID",
        "initial binding must use generation 1"
      );
    } else if (!rebind && JSON.stringify(current) !== JSON.stringify(next)) {
      throw codedError("COMMUNICATION_BROWSER_BINDING_MISMATCH", "browser binding changed");
    } else if (rebind) {
      const unresolved = db.prepare(`
        SELECT 1 FROM communication_batch_items
        WHERE batch_id = ? AND status IN ('click_dispatched','ambiguous')
        LIMIT 1
      `).get(batchId);
      if (unresolved) throw codedError(
        "COMMUNICATION_BROWSER_REBIND_BLOCKED",
        "clicked communication items require manual resolution before rebind"
      );
      next.bindingGeneration = current.bindingGeneration + 1;
    }
    db.prepare("UPDATE communication_batches SET runtime_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify({ browser: next }), timestamp(input.now), batchId);
    if (rebind) recordBindingAudit(db, batchId, current, next, timestamp(input.now));
    db.exec("COMMIT");
    return getCommunicationBatch(db, batchId);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}
```

The audit payload stores only batch ID, generation and boolean “changed” flags; it does not store URLs, page text or account identity.

- [ ] **Step 6: Map runtime data on reads without mutating policy snapshots**

```js
runtime: parseJson(row.runtime_json, {})
```

Add `bindCommunicationBatchRuntime` to the store exports. Keep `policySnapshot` unchanged.

- [ ] **Step 7: Run storage checks**

Run:

```powershell
node tests/storage_migration_smoke.js
node tests/communication_store_contract_smoke.js
node tests/communication_batch_storage_smoke.js
```

Expected: all pass, including migration from version 11 and rollback when a rebind is blocked.

- [ ] **Step 8: Commit runtime binding storage**

```powershell
git add src/core/storage.js src/storage/communication_store.js tests/storage_migration_smoke.js tests/communication_store_contract_smoke.js tests/communication_batch_storage_smoke.js
git commit -m "feat: persist communication browser bindings"
```

---

### Task 4: Make fixed search and message tabs keep their intended roles

**Files:**
- Modify: `src/adapters/sites/boss.js:1888-2145`
- Modify: `tests/boss_communication_page_smoke.js`
- Modify: `tests/workspace_tabs_smoke.js`

**Interfaces:**
- Consumes: persisted numeric binding from Task 3.
- Produces:

```js
adapter.bindCommunicationTabs(binding);
await adapter.beginCommunicationSession();
await adapter.inspectCommunicationJob(job, signal);
await adapter.dispatchCommunication(inspection, signal);
await adapter.verifyCommunicationResult(job, signal);
await adapter.restoreCommunicationSearchPage();
```

- `BOSS-SEARCH` is the communication detail tab for the whole batch.
- `BOSS-COMMUNICATION` remains `/web/geek/chat`.
- Unbound portable-browser behavior remains unchanged.

- [ ] **Step 1: Replace old fake-browser expectations with the approved ordinary Edge contract**

```js
const browser = fakeBrowser({
  tabs: [
    { id: 1995685534, url: searchUrl, windowId: 1995685675 },
    { id: 1995685619, url: chatUrl, windowId: 1995685675 }
  ]
});
const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
adapter.bindCommunicationTabs(numericBinding());
await adapter.beginCommunicationSession();
await adapter.inspectCommunicationJob(expectedJob);
await adapter.inspectCommunicationJob(secondJob);
await adapter.restoreCommunicationSearchPage();

assert.deepStrictEqual(browser.calls.createTab, []);
assert.deepStrictEqual(browser.calls.navigate, [
  [1995685534, jobUrl],
  [1995685534, secondJobUrl],
  [1995685534, searchUrl]
]);
assert.strictEqual(browser.tab(1995685619).url, chatUrl);
```

- [ ] **Step 2: Add terminal restoration variants before changing the adapter**

Cover success, target reached, user stop, pre-click failure and post-click ambiguity with one shared assertion:

```js
assert.strictEqual(
  browser.calls.navigate.filter(([tabId, url]) =>
    tabId === 1995685534 && url === searchUrl
  ).length,
  1
);
```

Assert scroll restoration clamps to the page maximum:

```js
assert.deepStrictEqual(browser.calls.restoreScroll, [{
  tabId: 1995685534,
  requested: 900,
  applied: 640
}]);
```

- [ ] **Step 3: Run the focused adapter test and confirm old behavior fails**

Run:

```powershell
node tests/boss_communication_page_smoke.js
node tests/workspace_tabs_smoke.js
```

Expected: FAIL because the bound path currently returns the chat tab and old unbound tests create a detail tab.

- [ ] **Step 4: Store all binding fields as numeric values in the adapter**

```js
bindCommunicationTabs(binding = {}) {
  for (const field of ["windowId", "searchTabId", "messageTabId", "bindingGeneration"]) {
    if (!Number.isInteger(binding[field])) {
      throw bossError("BOSS_COMMUNICATION_BINDING_REQUIRED", `${field} must be a numeric Edge identifier.`);
    }
  }
  this.communicationBinding = Object.freeze({ ...binding });
  this.communicationSearchTabId = binding.searchTabId;
  this.communicationTabId = binding.searchTabId;
  this.communicationMessageTabId = binding.messageTabId;
  this.communicationTabsBound = true;
}
```

Never convert these IDs with `String()` before calling `browser.navigate()`, `browser.evalValue()` or any other bridge method.

- [ ] **Step 5: Verify the bound tabs without requiring the search tab to remain on the search path between items**

For a bound session:

```js
const searchTab = tabs.find((tab) => tab.id === binding.searchTabId);
const messageTab = tabs.find((tab) => tab.id === binding.messageTabId);
if (!searchTab || !messageTab) throw bossError("BOSS_OPERATOR_TABS_CHANGED", "fixed BOSS tabs changed");
if (searchTab.windowId !== binding.windowId || messageTab.windowId !== binding.windowId) {
  throw bossError("BOSS_WINDOW_MISMATCH", "fixed BOSS tabs moved to another window");
}
if (bossPath(messageTab) !== "/web/geek/chat") {
  throw bossError("BOSS_COMMUNICATION_PAGE_LOST", "fixed message tab left the chat page");
}
if (!["/web/geek/jobs", "job_detail"].includes(boundSearchRole(searchTab))) {
  throw bossError("BOSS_SEARCH_PAGE_LOST", "fixed search tab left its permitted paths");
}
return binding.searchTabId;
```

`beginCommunicationSession()` additionally requires the search path before the first job.

- [ ] **Step 6: Remove tab creation only from the bound ordinary Edge branch**

```js
if (this.communicationTabsBound) {
  await this.assertBoundCommunicationTabs({ requireSearchPage: false });
  return this.communicationBinding.searchTabId;
}
```

Leave the existing portable fallback below this branch. This avoids changing the explicitly selected portable authority while guaranteeing ordinary Edge never calls `createTab()`.

- [ ] **Step 7: Implement one idempotent outer restore**

```js
async restoreCommunicationSearchPage() {
  if (!this.communicationTabsBound || this.communicationSearchRestored) return;
  this.communicationSearchRestored = true;
  const binding = this.communicationBinding;
  await this.browser.navigate(binding.searchTabId, binding.searchReturnUrl);
  await this.waitWithPacing("detail");
  await this.assertSearchPage(binding.searchTabId);
  await this.browser.evalValue(binding.searchTabId, `(() => {
    const requested = ${JSON.stringify(binding.searchScrollTop)};
    const maximum = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const applied = Math.min(maximum, Math.max(0, requested));
    scrollTo(0, applied);
    return { requested, applied };
  })()`);
  await this.assertBoundCommunicationTabs({ requireSearchPage: true });
}
```

Set `communicationSearchRestored` only inside this method so repeated outer cleanup cannot navigate twice.

- [ ] **Step 8: Run fixed-tab adapter tests**

Run:

```powershell
node tests/boss_communication_page_smoke.js
node tests/workspace_tabs_smoke.js
```

Expected: all pass; ordinary Edge uses numeric search tab IDs, never creates a BOSS tab, never navigates the message tab and restores once.

- [ ] **Step 9: Commit fixed-tab roles**

```powershell
git add src/adapters/sites/boss.js tests/boss_communication_page_smoke.js tests/workspace_tabs_smoke.js
git commit -m "fix: keep Edge communication on fixed search tab"
```

---

### Task 5: Integrate one pre-click recovery and guaranteed outer cleanup

**Files:**
- Modify: `src/core/site_access_budget.js:20-130, 200-235`
- Modify: `src/core/communication_executor.js:19-168, 575-583`
- Modify: `src/application/communication/index.js:33-82`
- Modify: `src/cli.js:221-300`
- Modify: `src/dashboard/server.js:544-568, 2649-2750`
- Modify: `src/dashboard/view_models/communication.js:18-64`
- Modify: `src/dashboard/pages/communication.js:18-58`
- Test: `tests/site_access_budget_smoke.js`
- Test: `tests/communication_executor_smoke.js`
- Test: `tests/communication_cli_authority_smoke.js`
- Test: `tests/dashboard_communication_batch_smoke.js`

**Interfaces:**
- Consumes: Task 3 storage binding and Task 4 adapter lifecycle.
- Produces:

```js
await runCommunicationBatch({ ..., beforeReadOnlyRetry });
await inspectAndBindCommunicationBrowser({ db, batch, browser, adapter, rebind });
```

- Recovery allowlist applies only before `dispatchCommunication()`.
- Login, risk control, binding drift and any `click_count > 0` uncertainty are never retried.

- [ ] **Step 1: Add executor tests for exactly one safe retry**

```js
let attempts = 0;
const adapter = {
  async inspectCommunicationJob() {
    attempts += 1;
    if (attempts === 1) throw codedError("BROWSER_TIMEOUT");
    return readyInspection;
  },
  dispatchCommunication,
  verifyCommunicationResult
};

await runCommunicationBatch({
  db,
  batchId,
  adapter,
  accessController,
  beforeReadOnlyRetry: async ({ item }) => {
    await accessController.reserve("communication_visit", {
      batchId,
      itemId: item.id,
      jobId: item.jobId,
      recoveryAttempt: 1
    });
  }
});
assert.strictEqual(attempts, 2);
```

Add negative cases:

```js
for (const code of ["BOSS_LOGIN_REQUIRED", "BOSS_RISK_CONTROL", "BOSS_OPERATOR_TABS_CHANGED"]) {
  await assert.rejects(runWithInspectionError(code), (error) => error.code === code);
  assert.strictEqual(inspectCalls, 1);
}
```

Add a click-dispatched ambiguity case and assert no retry.

- [ ] **Step 2: Add access-ledger coverage for the extra recovery navigation**

```js
await controller.reserve("communication_visit", { batchId: 4, itemId: 8, jobId: 12 });
await controller.reserve("communication_visit", {
  batchId: 4,
  itemId: 8,
  jobId: 12,
  recoveryAttempt: 1
});
assert.strictEqual(listSiteAccessEvents(db, {
  site: "boss",
  action: "communication_visit"
}).length, 2);
```

The same recovery reservation called twice must reuse its own event and remain at two.

- [ ] **Step 3: Run executor and budget tests to establish failure**

Run:

```powershell
node tests/site_access_budget_smoke.js
node tests/communication_executor_smoke.js
```

Expected: FAIL because recovery attempts are currently deduplicated with the first visit and the executor does not retry inspection.

- [ ] **Step 4: Extend the existing communication reservation key minimally**

Allow only:

```js
recoveryAttempt: value === 1 ? 1 : 0
```

in sanitized communication details. Include it in `existingCommunicationReservation()` equality. Do not add a new budget or action type.

- [ ] **Step 5: Wrap inspection in a single allowlisted pre-click retry**

```js
const READ_ONLY_RECOVERY_CODES = new Set([
  "BROWSER_TIMEOUT",
  "BOSS_COMMUNICATION_HELPER_MISSING",
  "BOSS_COMMUNICATION_PAGE_NOT_READY"
]);

async function inspectWithOneRecovery({ adapter, item, signal, beforeReadOnlyRetry }) {
  try {
    return await adapter.inspectCommunicationJob(immutableJob(item), signal);
  } catch (error) {
    if (!READ_ONLY_RECOVERY_CODES.has(errorCode(error)) || item.clickCount !== 0) throw error;
    await beforeReadOnlyRetry({ item, error });
    return adapter.inspectCommunicationJob(immutableJob(item), signal);
  }
}
```

The second error follows the existing unavailable/fatal path; there is no loop.

- [ ] **Step 6: Add CLI failing tests for persisted numeric binding and one restore on every exit**

```js
assert.deepStrictEqual(adapter.bindCalls[0], {
  mode: "edge",
  windowId: 1995685675,
  searchTabId: 1995685534,
  messageTabId: 1995685619,
  searchReturnUrl,
  searchScrollTop: 240,
  bindingGeneration: 1
});
assert.strictEqual(typeof adapter.bindCalls[0].searchTabId, "number");
assert.strictEqual(adapter.restoreCalls, 1);
assert.deepStrictEqual(browser.calls.createTab, []);
```

Run the same assertion for resolved success, thrown pre-click error, ambiguous result and abort.

- [ ] **Step 7: Validate the return URL against the frozen workflow scope before binding**

Use `canonicalizeBossSearchTemplate(searchReturnUrl)` and compare its canonical URL with `workflow.planner.searchScope.templateUrl`. The full original return URL is persisted, but its source/path/filters must canonicalize to the frozen scope.

- [ ] **Step 8: Integrate preflight, binding and cleanup in `communicate()`**

```js
let sessionStarted = false;
let runError = null;
let restoreError = null;
try {
  const inspected = await inspectBossOperatorTabs({ browser, inspectTab: (tabId) => adapter.preflight({ tabId }) });
  const captured = await adapter.captureCommunicationSearchState(inspected.searchTab.id);
  const bound = bindCommunicationBatchRuntime(db, {
    batchId,
    browser: {
      mode: "edge",
      windowId: inspected.windowId,
      searchTabId: inspected.searchTab.id,
      messageTabId: inspected.communicationTab.id,
      searchReturnUrl: captured.url,
      searchScrollTop: captured.scrollTop,
      bindingGeneration: batch.runtime?.browser?.bindingGeneration || 1
    }
  });
  adapter.bindCommunicationTabs(bound.runtime.browser);
  await adapter.beginCommunicationSession();
  sessionStarted = true;
  return await runCommunicationBatchFn({ db, batchId, adapter, accessController, logger: communicationLogger });
} catch (error) {
  runError = error;
  throw error;
} finally {
  if (sessionStarted) {
    try {
      await adapter.restoreCommunicationSearchPage();
    } catch (error) {
      restoreError = error;
      communicationLogger.error("communication_search_restore_failed", { code: error.code });
    }
  }
  stopHeartbeat();
  if (!runError && restoreError) throw restoreError;
}
```

If execution and restore both fail, preserve the execution error as primary and attach the restore code to logs and batch runtime diagnostics. Never print the “批次完成” line when restore fails.

- [ ] **Step 9: Add explicit user-triggered rebind without auto-creating tabs**

Add POST `/api/communication-rebind`. Its handler:

1. Loads the interrupted edge batch.
2. Rejects any `click_dispatched` or `ambiguous` item.
3. Uses the current ordinary Edge browser authority.
4. Runs `inspectBossOperatorTabs()`.
5. Captures and validates the search URL/scroll.
6. Calls `bindCommunicationBatchRuntime(..., { rebind: true })`.
7. Returns to the communication page without starting the batch.

The page button text is:

```html
<button class="secondary">重新检查浏览器页面</button>
```

It appears only for interrupted/paused edge batches with no ambiguity.

- [ ] **Step 10: Keep ambiguity as a recoverable user-resolution state**

Use the existing `communicationAmbiguityState()` and render:

```text
等待人工确认沟通结果
```

Do not label `COMMUNICATION_RESULT_AMBIGUOUS` as “沟通失败”. Keep the existing “确认已沟通” and “标记停止” forms, evidence requirement and `resumeInterruptedCommunicationBatch()` path.

- [ ] **Step 11: Run focused lifecycle checks**

Run:

```powershell
node tests/site_access_budget_smoke.js
node tests/communication_executor_smoke.js
node tests/communication_cli_authority_smoke.js
node tests/dashboard_communication_batch_smoke.js
node tests/communication_application_smoke.js
```

Expected: all pass; message tab never navigates, search restore occurs once, one pre-click retry is counted, and clicked ambiguity blocks rebind/resume.

- [ ] **Step 12: Commit lifecycle integration**

```powershell
git add src/core/site_access_budget.js src/core/communication_executor.js src/application/communication/index.js src/cli.js src/dashboard/server.js src/dashboard/view_models/communication.js src/dashboard/pages/communication.js tests/site_access_budget_smoke.js tests/communication_executor_smoke.js tests/communication_cli_authority_smoke.js tests/dashboard_communication_batch_smoke.js tests/communication_application_smoke.js
git commit -m "fix: recover and settle Edge communication safely"
```

---

### Task 6: Persist only safe identity for unmatched inbound conversations

**Files:**
- Modify: `src/core/storage.js:665-793`
- Modify: `src/core/message_preview_state.js:50-93, 171-193`
- Modify: `src/core/message_discovery.js:98-117`
- Test: `tests/storage_migration_smoke.js`
- Test: `tests/message_preview_state_smoke.js`
- Test: `tests/message_discovery_smoke.js`

**Interfaces:**
- Produces unresolved records with:

```js
{
  positionTitle,
  company,
  salary,
  city,
  identityDigest
}
```

- Must never persist recruiter label/name, message text, full header, DOM, cookies or request data.

- [ ] **Step 1: Add failing safe-storage tests**

```js
const unresolved = recordUnresolvedMessageDiscoveryItem(db, {
  profileId,
  platform: "boss",
  conversationKey,
  previewDigest,
  previewKind: "possible_hr_reply",
  reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
  observedAt: NOW,
  identity: {
    positionTitle: "RAG 应用工程师",
    company: "示例科技",
    salary: "15-25K",
    city: "广州",
    recruiterLabel: "禁止保存",
    messageText: "禁止保存"
  }
});
assert.deepStrictEqual(unresolved, {
  ...baseUnresolved,
  positionTitle: "RAG 应用工程师",
  company: "示例科技",
  salary: "15-25K",
  city: "广州",
  identityDigest: unresolved.identityDigest
});
assert.match(unresolved.identityDigest, /^sha256:[a-f0-9]{64}$/);
```

Scan all unresolved columns and assert forbidden strings are absent.

- [ ] **Step 2: Run storage tests and confirm missing columns**

Run:

```powershell
node tests/storage_migration_smoke.js
node tests/message_preview_state_smoke.js
node tests/message_discovery_smoke.js
```

Expected: FAIL because safe identity fields do not exist.

- [ ] **Step 3: Add schema version 13**

Add columns:

```sql
position_title TEXT NOT NULL DEFAULT '',
company TEXT NOT NULL DEFAULT '',
salary TEXT NOT NULL DEFAULT '',
city TEXT NOT NULL DEFAULT '',
identity_digest TEXT NOT NULL DEFAULT '',
```

Migration 13 adds each missing column independently so version-12 databases migrate safely.

- [ ] **Step 4: Normalize and hash only the approved fields**

```js
function safeUnresolvedIdentity(value = {}) {
  const identity = {
    positionTitle: shortText(value.positionTitle, 160),
    company: shortText(value.company, 160),
    salary: shortText(value.salary, 80),
    city: shortText(value.city, 80)
  };
  return {
    ...identity,
    identityDigest: digestIdentity(identity)
  };
}
```

`digestIdentity()` hashes the four normalized values in fixed order. Ignore every other input key.

- [ ] **Step 5: Capture identity only after the message reader has verified the selected conversation**

Before clearing `selected`, pass:

```js
identity: {
  positionTitle: selected.positionName,
  company: selected.companyName,
  salary: selected.salary,
  city: selected.city
}
```

Do not pass `headerText`, `messages`, `recruiterLabel` or row snapshots.

- [ ] **Step 6: Keep missing/drifted identity unresolved**

Persist an empty title if the reader could not establish it, but do not create or link an opportunity in later tasks. If a later read produces a different `identityDigest`, update the safe fields and keep the record unresolved for a fresh user decision.

- [ ] **Step 7: Run storage and discovery checks**

Run:

```powershell
node tests/storage_migration_smoke.js
node tests/message_preview_state_smoke.js
node tests/message_discovery_smoke.js
```

Expected: all pass and database text scans contain none of the forbidden fixture values.

- [ ] **Step 8: Commit safe inbound identity storage**

```powershell
git add src/core/storage.js src/core/message_preview_state.js src/core/message_discovery.js tests/storage_migration_smoke.js tests/message_preview_state_smoke.js tests/message_discovery_smoke.js
git commit -m "feat: retain safe inbound job identity"
```

---

### Task 7: Add transactional local actions for inbound opportunities

**Files:**
- Create: `src/application/message_discovery/inbound.js`
- Modify: `src/core/candidate_progress.js:58-80, 581-640, 701-716`
- Modify: `src/core/storage.js:1410-1500`
- Test: `tests/message_discovery_smoke.js`
- Test: `tests/candidate_progress_storage_smoke.js`
- Test: `tests/data_visibility_smoke.js`

**Interfaces:**
- Produces:

```js
resolveInboundOpportunity({
  db,
  input: {
    profileId,
    conversationKey,
    previewDigest,
    action: "link" | "create" | "ignore",
    jobId
  }
});
```

- `link` binds to one user-selected matching local job.
- `create` inserts a no-observation BOSS job and a `needs_user_action` progress card.
- `ignore` commits the preview baseline and clears unresolved state.

- [ ] **Step 1: Add failing transaction tests for all three actions**

```js
const created = resolveInboundOpportunity({
  db,
  input: { profileId, conversationKey, previewDigest, action: "create" }
});
assert.strictEqual(created.card.stage, "needs_user_action");
assert.strictEqual(created.job.source, "boss");
assert.strictEqual(created.job.sourceId, `inbound:${conversationKey.slice(7)}`);
assert.strictEqual(created.job.batchId, null);
assert.strictEqual(
  db.prepare("SELECT COUNT(*) AS count FROM job_observations WHERE job_id = ?")
    .get(created.job.id).count,
  0
);
```

Add rollback triggers for job, progress and baseline writes; after each forced failure assert the unresolved record remains and no partial job/card/event survives.

- [ ] **Step 2: Add rejection tests for missing identity, drift and inactive plans**

```js
assert.throws(() => resolveInboundOpportunity({
  db,
  input: { profileId, conversationKey: missingTitleKey, previewDigest, action: "create" }
}), /INBOUND_IDENTITY_INCOMPLETE/);

assert.throws(() => resolveInboundOpportunity({
  db,
  input: { profileId, conversationKey, previewDigest: staleDigest, action: "ignore" }
}), /INBOUND_PREVIEW_CHANGED/);

assert.throws(() => resolveInboundOpportunity({
  db,
  input: { profileId: profileWithoutActivePlan, conversationKey, previewDigest, action: "create" }
}), /INBOUND_ACTIVE_PLAN_REQUIRED/);
```

- [ ] **Step 3: Run focused tests to confirm the application service is absent**

Run:

```powershell
node tests/message_discovery_smoke.js
node tests/candidate_progress_storage_smoke.js
node tests/data_visibility_smoke.js
```

Expected: FAIL on the missing module/functions.

- [ ] **Step 4: Implement strict unresolved-record loading and stale-form protection**

```js
const unresolved = listUnresolvedMessageDiscoveryItems(db, { profileId })
  .find((item) => item.conversationKey === conversationKey);
if (!unresolved) throw inboundError("INBOUND_ITEM_NOT_FOUND", "unresolved inbound item not found");
if (unresolved.previewDigest !== previewDigest) {
  throw inboundError("INBOUND_PREVIEW_CHANGED", "inbound preview changed before resolution");
}
```

Require `positionTitle` and `company` for `link` and `create`; an incomplete record remains unresolved.

- [ ] **Step 5: Implement `create` with the existing job and progress stores**

Inside `immediateTransaction()`:

```js
const sourceId = `inbound:${conversationKey.slice(7)}`;
const jobId = upsertJob(db, {
  source: "boss",
  sourceId,
  keyword: "HR 主动联系",
  title: unresolved.positionTitle,
  company: unresolved.company,
  location: unresolved.city,
  salary: unresolved.salary,
  url: "",
  tags: ["hr_inbound"],
  description: "",
  score: 0,
  matches: [],
  risks: [],
  qualityTags: ["inbound_unassessed"],
  analysis: {}
}, null);
let card = ensureProgressCard(db, {
  profileId,
  planId: activePlan.id,
  jobId,
  source: "boss",
  now
});
card = transitionProgressCard(db, {
  cardId: card.id,
  expectedStage: "contact_started",
  stage: "needs_user_action",
  nextAction: "核对 HR 主动联系并决定是否回复",
  now
});
bindProgressCardThread(db, {
  cardId: card.id,
  threadKey: conversationKey,
  now
});
```

Then write a sanitized progress event, commit the preview baseline and clear the unresolved record in the same transaction.

- [ ] **Step 6: Implement `link` with exact title/company verification**

The selected job must:

- belong to the profile through an existing progress card or a scan batch for the active plan;
- have normalized title and company equal to the unresolved identity;
- not be closed/rejected.

Create or reuse its progress card, bind the digest thread key, record a local event, commit baseline and clear unresolved. Multiple candidates are never auto-selected.

- [ ] **Step 7: Implement `ignore` without a model or browser dependency**

Inside one transaction:

```js
commitProcessedPreview(db, {
  profileId,
  platform: "boss",
  conversationKey,
  previewDigest,
  previewKind: unresolved.previewKind,
  observedAt: now
});
db.prepare(`
  INSERT INTO events(job_id, event_type, payload_json, created_at)
  VALUES (NULL, 'message_inbound_ignored', ?, ?)
`).run(JSON.stringify({
  profileId,
  conversationKey,
  previewDigest
}), now);
clearUnresolvedMessageDiscoveryItem(db, {
  profileId,
  platform: "boss",
  conversationKey
});
```

- [ ] **Step 8: Expose progress cards with their jobs without adding observations**

Extend `listProgressCardsWithEvents()` with a `JOIN jobs` and return:

```js
card.job = {
  id: Number(row.job_id),
  source: row.job_source,
  sourceId: row.job_source_id,
  title: row.job_title,
  company: row.job_company || "",
  salary: row.job_salary || "",
  location: row.job_location || "",
  url: row.job_url || "",
  batchId: Number(row.job_batch_id || 0) || null
};
```

Do not insert `job_observations`, batches, model analyses or recommendation events.

- [ ] **Step 9: Prove inbound jobs stay outside recommendation and Gate D pools**

```js
assert.strictEqual(
  listDecisionPool(db, { planId: activePlan.id })
    .some((job) => job.sourceId === created.job.sourceId),
  false
);
assert.strictEqual(
  getOutcomeAnalyticsSnapshot(db, { planId: activePlan.id }).total,
  priorOutcomeTotal
);
```

- [ ] **Step 10: Run local-action and visibility checks**

Run:

```powershell
node tests/message_discovery_smoke.js
node tests/candidate_progress_storage_smoke.js
node tests/data_visibility_smoke.js
```

Expected: all pass; actions are transactional, local-only and quality-pool neutral.

- [ ] **Step 11: Commit inbound application service**

```powershell
git add src/application/message_discovery/inbound.js src/core/candidate_progress.js src/core/storage.js tests/message_discovery_smoke.js tests/candidate_progress_storage_smoke.js tests/data_visibility_smoke.js
git commit -m "feat: resolve inbound HR opportunities locally"
```

---

### Task 8: Expose inbound resolution and direct progress visibility in Dashboard

**Files:**
- Modify: `src/dashboard/message_discovery_view.js:1-120`
- Modify: `src/dashboard/server.js:500-568, 2450-2505, 3543-3614`
- Test: `tests/dashboard_message_discovery_smoke.js`
- Test: `tests/dashboard_shell_smoke.js`
- Test: `tests/data_visibility_smoke.js`

**Interfaces:**
- Consumes: Task 6 safe unresolved rows and Task 7 local application service.
- Produces: POST `/api/message-discovery-unresolved` and direct progress-pool rows for inbound opportunities.

- [ ] **Step 1: Add failing page tests for three local actions and no private content**

```js
const page = await request(base, `/messages?profileId=${profileId}`);
assert.match(page.body, /RAG 应用工程师/);
assert.match(page.body, /示例科技/);
assert.match(page.body, /关联现有岗位/);
assert.match(page.body, /保存为 HR 主动机会/);
assert.match(page.body, /不纳入 RoleFlow/);
assert.doesNotMatch(page.body, /fixture recruiter name|fixture message body/);
assert.doesNotMatch(page.body, /action="[^"]*communication|发送消息/);
```

- [ ] **Step 2: Add failing endpoint tests proving no browser/model calls**

```js
const calls = { browser: 0, model: 0 };
const response = await postForm(base, "/api/message-discovery-unresolved", {
  profileId,
  conversationKey,
  previewDigest,
  action: "create"
});
assert.strictEqual(response.status, 303);
assert.deepStrictEqual(calls, { browser: 0, model: 0 });
```

Add link, ignore, stale preview and ambiguous-candidate cases.

- [ ] **Step 3: Add failing progress-page coverage for no-observation inbound cards**

```js
const queue = await request(base, `/queue?planId=${planId}&pool=needs_user_action`);
assert.match(queue.body, /RAG 应用工程师/);
assert.match(queue.body, /HR 主动联系/);
```

- [ ] **Step 4: Run Dashboard tests and confirm missing controls/rows**

Run:

```powershell
node tests/dashboard_message_discovery_smoke.js
node tests/dashboard_shell_smoke.js
node tests/data_visibility_smoke.js
```

Expected: FAIL because unresolved items currently expose only a count and progress rows only come from `listDecisionPool()`.

- [ ] **Step 5: Always load durable unresolved rows for the page**

Replace the dismissed-only read with:

```js
const durableUnresolved = listUnresolvedMessageDiscoveryItems(db, { profileId });
const status = durableUnresolved.length
  ? {
      ...pageState,
      status: pageState.status === "running" ? "running" : "needs_user_action",
      unresolved: durableUnresolved.length,
      reasonCode: durableUnresolved[0].reasonCode
    }
  : pageState;
```

- [ ] **Step 6: Render safe cards with immutable stale-form fields**

Each form includes `profileId`, `conversationKey` and `previewDigest`. Display only title, company, salary, city and reason. If title/company is missing, disable link/create and explain “岗位身份仍不完整，请下次只读发现后再处理”.

For candidate links, show exact title/company matches and require a radio selection when more than one exists.

- [ ] **Step 7: Add the local resolution endpoint**

```js
async function handleInboundOpportunityResolution(req, res, db) {
  const params = parseBody(await readBody(req), req.headers["content-type"] || "");
  const result = resolveInboundOpportunity({ db, input: params });
  redirect(res, `/messages?profileId=${encodeURIComponent(result.profileId)}`);
}
```

Map known errors to plain Chinese and HTTP 409; do not call the message controller, model runtime or browser factory.

- [ ] **Step 8: Union direct progress cards into progress-only pools**

```js
const decisionJobs = listDecisionPool(db, { planId: plan.id })
  .map((job) => ({ ...job, progressCard: progressByJob.get(Number(job.id)) || null }));
const known = new Set(decisionJobs.map((job) => Number(job.id)));
const directProgressJobs = progressCards
  .filter((card) => card.planId === plan.id && card.job && !known.has(Number(card.jobId)))
  .map((card) => ({
    ...card.job,
    progressCard: card,
    decisionBucket: "",
    applicationStatus: "",
    qualityTags: [],
    analysis: {},
    inboundOpportunity: true
  }));
const fullPool = [...decisionJobs, ...directProgressJobs];
```

Only progress pools (`waiting_reply`, `needs_user_action`, `interview`) may include these direct rows. Recommendation pools and outcome analytics continue using `decisionJobs`.

- [ ] **Step 9: Run Dashboard and privacy checks**

Run:

```powershell
node tests/dashboard_message_discovery_smoke.js
node tests/dashboard_shell_smoke.js
node tests/data_visibility_smoke.js
```

Expected: all pass; inbound opportunity appears in progress, not recommendations, and no private message/recruiter fixture leaks.

- [ ] **Step 10: Commit Dashboard inbound handling**

```powershell
git add src/dashboard/message_discovery_view.js src/dashboard/server.js tests/dashboard_message_discovery_smoke.js tests/dashboard_shell_smoke.js tests/data_visibility_smoke.js
git commit -m "feat: surface inbound HR opportunities in progress"
```

---

### Task 9: Verify the complete subproject without external writes

**Files:**
- Modify only if a test exposes a real regression in files already listed above.
- Evidence: `D:\DevData\RoleFlow-gate-d\verification\beta4-workflow-safety-recovery.stdout.log`

**Interfaces:**
- Consumes: all prior task commits.
- Produces: offline evidence plus a bounded read-only acceptance record.

- [ ] **Step 1: Search for forbidden mainline regressions**

Run:

```powershell
rg -n "search_page_api|standalone_detail" src tests
rg -n "createTab\\(" src/adapters/sites/boss.js src/cli.js
rg -n "data-workflow-primary=\"true\"[^>]*>暂停本轮|\\.focus\\(\\)" src/dashboard
```

Expected:

- Existing deferred `search_page_api` code/tests may remain, but none of the new workflow/communication call sites enable it.
- `createTab()` may remain in portable/workspace setup paths, but the bound ordinary Edge communication branch cannot reach it.
- No polling code focuses the pause button.

- [ ] **Step 2: Run every focused test once more**

Run:

```powershell
node tests/profile_quality_smoke.js
node tests/workflow_progress_smoke.js
node tests/workflow_page_migration_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/storage_migration_smoke.js
node tests/site_access_budget_smoke.js
node tests/communication_store_contract_smoke.js
node tests/communication_executor_smoke.js
node tests/communication_cli_authority_smoke.js
node tests/boss_communication_page_smoke.js
node tests/dashboard_communication_batch_smoke.js
node tests/message_preview_state_smoke.js
node tests/message_discovery_smoke.js
node tests/dashboard_message_discovery_smoke.js
node tests/data_visibility_smoke.js
```

Expected: every command exits 0.

- [ ] **Step 3: Run the full offline suite and save fresh evidence**

Run:

```powershell
$logDir = 'D:\DevData\RoleFlow-gate-d\verification'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
node tests/run_all.js 2>&1 | Tee-Object -FilePath (Join-Path $logDir 'beta4-workflow-safety-recovery.stdout.log')
```

Expected final line:

```text
All 93 offline checks passed.
```

If the registry count changes because a new standalone test file is added, the final number must equal the actual `tests/run_all.js` list length.

- [ ] **Step 4: Start a local Dashboard against a disposable copied database**

Use a database copy under:

```text
D:\DevData\RoleFlow-gate-d\verification\beta4-workflow-safety-recovery-ui\
```

Do not use a failed/interrupted Gate D database as quality evidence. Verify at desktop and 375px viewport:

- inherited empty-city plan is not blocked;
- running next step says the system continues;
- pause is secondary and not auto-focused;
- pending details prevent “剩余工作 0”;
- communication statuses are Chinese;
- ambiguity says it awaits manual resolution;
- unresolved inbound cards expose only local actions;
- inbound progress card is visible under `needs_user_action`.

- [ ] **Step 5: Perform only the approved bounded live read-only check**

Preconditions:

- one ordinary Edge window;
- exactly one `BOSS-SEARCH` and one `BOSS-COMMUNICATION`;
- both logged in, no risk-control page;
- raw numeric IDs preserved;
- no scan, no model call, no communication click.

Check one already-saved job URL by:

1. Recording the current full search URL and scroll position.
2. Navigating `BOSS-SEARCH` to that saved job URL.
3. Reading only identity fields.
4. Restoring `BOSS-SEARCH` once.
5. Confirming `BOSS-COMMUNICATION` stayed on `/web/geek/chat`.

Then read at most a small number of message rows without sending, typing or generating a reply. Stop immediately on login, risk, tab loss or identity drift.

- [ ] **Step 6: Inspect the final diff and repository state**

Run:

```powershell
git diff --check
git status --short
git log --oneline --decorate -12
```

Expected: no whitespace errors; only intended subproject files changed; commits are task-sized.

- [ ] **Step 7: Commit any verification-only regression fix, if one was required**

Use a specific message naming the observed regression, for example:

```powershell
git add <only-the-verified-files>
git commit -m "fix: preserve communication restore failure state"
```

Skip this step when verification required no code change.

---

## Self-Review Record

### Spec coverage

- Acquisition-aware empty-city validation: Task 1.
- Existing target/detail/analysis/communication ledgers and truthful remaining work: Task 2.
- Running next step and pause focus semantics: Task 2.
- Unified Chinese communication status and unknown fallback: Tasks 2 and 5.
- Existing ambiguity resolver/resume path retained: Task 5.
- Numeric persisted fixed-tab binding and guarded rebind: Tasks 3 and 5.
- Search-tab communication, chat-tab preservation, no third tab and one outer restore: Tasks 4 and 5.
- One pre-click recovery counted in the safety ledger: Task 5.
- Safe unresolved HR identity fields: Task 6.
- Local link/create/ignore with transaction and no model/browser write: Task 7.
- Direct progress visibility without Gate D/recommendation pollution: Tasks 7 and 8.
- Full offline and bounded read-only verification: Task 9.
- `trusted_pane`, no `search_page_api`, no bulk JD degradation and no Wave 5: Global Constraints and Task 9.

### Placeholder scan

The plan contains concrete file paths, signatures, test commands, expected failures and implementations. It contains no deferred implementation marker.

### Type consistency

- Browser IDs are numeric from Task 3 through Tasks 4 and 5.
- Runtime storage shape is consistently `batch.runtime.browser`.
- Safe inbound field names remain `positionTitle`, `company`, `salary`, `city`, `identityDigest` from persistence through UI.
- Workflow progress names remain `scanTargets`, `details`, `analysis`, `communication`, `remainingWorkLabel` from core snapshot through view and polling.
- Ambiguity continues to use the existing `ambiguous` item state and derives `needs_resolution` only in view models.

