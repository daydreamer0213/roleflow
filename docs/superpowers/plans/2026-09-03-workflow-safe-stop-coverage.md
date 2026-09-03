# Workflow Safe Stop Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让岗位发现本轮在进入真实沟通前始终可以安全结束，并让扫描进度冻结边界异常留下可定位、去敏的本地诊断。

**Architecture:** 复用现有 `/api/workflow-control`、`stop_requested`、`finalizeWorkflowControl()` 和 `stopped` 终态，只扩展视图模型与页面对停止能力的展示覆盖。扫描进度仍由 `normalizeScanProgress()` 拒绝越界，但错误增加结构化边界详情，并在 CLI 的现有工作流日志上下文中记录后再中断。

**Tech Stack:** Node.js CommonJS、原生 HTML/CSS/JavaScript、SQLite（better-sqlite3）、Node `assert` 离线 smoke tests。

## Global Constraints

- 不新增数据库状态、数据库迁移或 HTTP 接口。
- 不重写工作流状态机；复用 `stop_requested`、`stopped` 和现有租约释放逻辑。
- 真实沟通继续使用沟通页的“安全撤回”和结果不确定处理；岗位流程停止入口不得覆盖已关联沟通批次的本轮。
- 用户确认一次即可结束，不增加第二层确认。
- 已保存岗位和分析结果必须保留，未完成任务必须结清为停止，本轮不得误记为完成。
- 冻结边界校验必须保留；诊断不得包含岗位正文、聊天内容、简历内容、Cookie 或页面凭证。
- 不自动修改当前真实验收遗留的本轮，不使用真实 BOSS 页面做常规测试。

---

### Task 1: 补齐中断与复核状态的结束入口

**Files:**
- Modify: `src/dashboard/view_models/workflow.js:229-242`
- Modify: `src/dashboard/pages/workflow.js:63-70`
- Test: `tests/workflow_page_migration_smoke.js:172-223`

**Interfaces:**
- Consumes: `progressSnapshot.controls.canStop: boolean`、`workflow.communicationBatchId: number|null`、现有 `/api/workflow-control` 表单。
- Produces: `controls.stopOnlyVisible: boolean`；页面上的 `data-control-group="stop-only"`，复用现有 `data-action="stop-preview"` 和确认表单。

- [ ] **Step 1: 为缺失入口写失败回归**

在 `tests/workflow_page_migration_smoke.js` 增加与真实服务端一致的控制快照辅助函数：

```js
function progressSnapshotFor(status, { canStop = true } = {}) {
  const snapshot = fixture().progressSnapshot;
  return {
    ...snapshot,
    workflow: { ...snapshot.workflow, status, controlState: "none" },
    controls: { ...snapshot.controls, canPause: false, canResume: false, canStop }
  };
}
```

复核、中断和沟通场景都显式传入 `progressSnapshotFor(status)`，再加入精确断言：

```js
assert.match(review, /data-control-group="stop-only"/);
assert.match(review, /data-action="stop-preview"/);

assert.doesNotMatch(confirmed, /data-control-group="stop-only"/);
assert.doesNotMatch(confirmed, /data-action="stop-preview"/);

assert.match(resumable, /data-control-group="stop-only"/);
assert.match(resumable, /name="action" value="stop"/);

assert.doesNotMatch(interrupted, /data-control-group="stop-only"/);
assert.doesNotMatch(interrupted, /data-action="stop-preview"/);
```

这样同时证明：无沟通批次时后端允许停止就展示入口；即使控制快照允许停止，已关联沟通批次的页面也不会展示通用入口。

- [ ] **Step 2: 运行页面回归并确认它按预期失败**

Run: `node tests/workflow_page_migration_smoke.js`

Expected: FAIL，因为无沟通批次的 `review_required` 和 `interrupted` 页面尚未渲染 `stop-only` 操作组。

- [ ] **Step 3: 在视图模型中计算单独结束入口**

在 `controlView()` 中以当前权威快照和沟通边界计算展示字段：

```js
const canStop = Boolean(snapshot?.controls?.canStop);
const stopOnlyVisible = canStop
  && !workflow.communicationBatchId
  && ["review_required", "interrupted"].includes(status);

return {
  canPause: Boolean(snapshot?.controls?.canPause),
  canResume: Boolean(snapshot?.controls?.canResume),
  canStop,
  stopOnlyVisible,
  // 保留其余现有字段
};
```

`created`、`scanning`、`analyzing` 和 `paused` 继续使用现有运行/暂停操作组，不重复显示 `stop-only`。

- [ ] **Step 4: 复用现有确认面板渲染停止专用操作组**

放宽 `renderPrimaryCommand()` 的早退条件，并在三个现有操作组之后添加：

```js
const controlVisible = controls.runningVisible
  || controls.pauseRequestedVisible
  || controls.pausedVisible
  || controls.stopOnlyVisible;
if (!controlVisible) return "";
```

```html
<div class="workflow-control-group" data-control-group="stop-only">
  <button class="workflow-stop" type="button"
    data-workflow-control data-action="stop-preview">结束本轮…</button>
</div>
```

仅在 `controls.stopOnlyVisible` 为真时输出该节点。按钮继续打开现有 `data-stop-confirmation`，确认表单继续提交 `action=stop` 和 `confirmStop=1`。

- [ ] **Step 5: 运行页面回归并确认通过**

Run: `node tests/workflow_page_migration_smoke.js`

Expected: PASS；扫描、暂停、复核、中断、已确认沟通和沟通执行页面的主操作断言全部保持成立。

- [ ] **Step 6: 提交页面入口改动**

```powershell
git add src/dashboard/view_models/workflow.js src/dashboard/pages/workflow.js tests/workflow_page_migration_smoke.js
git commit -m "fix: keep workflow stop available before communication"
```

### Task 2: 锁定中断本轮的正常结清语义

**Files:**
- Test: `tests/workflow_control_smoke.js:32-46, 645-665`
- Modify only if the regression exposes a defect: `src/core/workflow_control.js:130-212`

**Interfaces:**
- Consumes: `requestWorkflowStop(db, { workflowRunId, confirmStop: true, now })` 与 `finalizeWorkflowControl(db, { workflowRunId, now })`。
- Produces: 中断且遗留 `pause_requested` 的本轮最终为 `{ status: "stopped", controlState: "none" }`；保留已完成任务，将未完成任务标记为 `stopped`。

- [ ] **Step 1: 增加中断本轮停止的状态回归**

在 `tests/workflow_control_smoke.js` 新增并调用 `testStopSupersedesInterruptedPauseRequest()`：

```js
function testStopSupersedesInterruptedPauseRequest() {
  const { profileId, planId } = seedPlan(db);
  const scenario = seedAnalyzingWorkflow(db, {
    profileId,
    planId,
    localDay: "2026-09-03",
    taskStates: [
      { status: "succeeded", attempts: 1, totalAttempts: 1 },
      { status: "pending" }
    ]
  });
  transitionWorkflowRun(db, {
    id: scenario.workflow.id,
    status: "interrupted",
    controlState: "pause_requested",
    resumePhase: "scanning",
    errorCode: "SCAN_CHECKPOINT_FAILED"
  });
  db.prepare("UPDATE workflow_runs SET platform_access_started_at = ? WHERE id = ?")
    .run("2026-09-03T01:00:00.000Z", scenario.workflow.id);

  const requested = requestWorkflowStop(db, {
    workflowRunId: scenario.workflow.id,
    confirmStop: true,
    now: "2026-09-03T02:00:00.000Z"
  });
  assert.strictEqual(requested.workflow.controlState, "stop_requested");
  assert.strictEqual(requested.stopConsumesRunSlot, true);

  const stopped = finalizeWorkflowControl(db, {
    workflowRunId: scenario.workflow.id,
    now: "2026-09-03T02:00:01.000Z"
  });
  assert.strictEqual(stopped.status, "stopped");
  assert.strictEqual(stopped.controlState, "none");
  assert.deepStrictEqual(workflowTasks(db, stopped.id).map((task) => task.status), ["succeeded", "stopped"]);
  assert.strictEqual(getActiveWorkflowRun(db, { profileId, planId }), null);
}
```

- [ ] **Step 2: 运行控制层回归**

Run: `node tests/workflow_control_smoke.js`

Expected: PASS，因为现有后端链路已经支持用停止请求替换遗留暂停请求；若失败，只在 `workflow_control.js` 修复暴露出的具体状态结清缺陷，不增加新状态或新接口。

- [ ] **Step 3: 运行相关执行与恢复回归**

Run: `node tests/scan_cli_lifecycle_smoke.js; node tests/workflow_analysis_executor_smoke.js; node tests/workflow_recovery_smoke.js`

Expected: 三项 PASS，证明活动扫描仍协作式停止、暂停恢复不倒退、精确租约结清不影响其他本轮。

- [ ] **Step 4: 提交状态语义回归**

```powershell
git add tests/workflow_control_smoke.js src/core/workflow_control.js
git commit -m "test: cover stopping interrupted workflow runs"
```

如果 `src/core/workflow_control.js` 没有变化，只提交测试文件。

### Task 3: 为冻结边界失败保存去敏诊断

**Files:**
- Modify: `src/storage/scan_store.js:640-668`
- Modify: `src/cli.js:1369-1461`
- Test: `tests/scan_recovery_smoke.js:150-237`

**Interfaces:**
- Consumes: `normalizeScanProgress(value, execution)` 内的规范化计数器和冻结目标。
- Produces: `SCAN_PROGRESS_INVALID` 的 `error.details`，形状为 `{ category, violations, counters, bounds }`；CLI 日志事件 `scan_checkpoint_rejected`。

- [ ] **Step 1: 为每类边界错误写失败回归**

将 `tests/scan_recovery_smoke.js` 的越界循环改为具名场景，并断言错误详情：

```js
const invalidProgressCases = [
  {
    name: "target_discovered_exceeds_card_limit",
    progress: { ...runtime.scanProgress, targetDiscovered: 7 },
    actual: 7,
    limit: 6
  },
  {
    name: "detail_position_exceeds_detail_total",
    progress: { ...runtime.scanProgress, detailPosition: 5, detailTotal: 4 },
    actual: 5,
    limit: 4
  }
];
for (const scenario of invalidProgressCases) {
  assert.throws(() => checkpointScanProgress(database, {
    runId,
    batchId,
    leaseOwner: context.owner,
    jobs: [],
    runtime: { scanProgress: scenario.progress }
  }), (error) => {
    assert.strictEqual(error.code, "SCAN_PROGRESS_INVALID");
    assert.strictEqual(error.details.category, "scan_progress_bounds");
    assert.ok(error.details.violations.some((item) =>
      item.name === scenario.name && item.actual === scenario.actual && item.limit === scenario.limit
    ));
    assert.ok(!JSON.stringify(error.details).includes(targetKey));
    return true;
  });
}
```

继续保留无效时间戳与事务完整回滚断言。

- [ ] **Step 2: 运行扫描恢复回归并确认它按预期失败**

Run: `node tests/scan_recovery_smoke.js`

Expected: FAIL，因为 `SCAN_PROGRESS_INVALID` 当前没有 `details`。

- [ ] **Step 3: 在边界校验点生成结构化去敏详情**

在 `normalizeScanProgress()` 中建立所有已触发的不变量列表：

```js
const cardLimit = integer(target.cardLimit);
const violations = [
  targetPosition !== frozenPosition
    ? { name: "target_position_mismatch", actual: targetPosition, limit: frozenPosition }
    : null,
  targetTotal !== targets.length
    ? { name: "target_total_mismatch", actual: targetTotal, limit: targets.length }
    : null,
  targetDiscovered > cardLimit
    ? { name: "target_discovered_exceeds_card_limit", actual: targetDiscovered, limit: cardLimit }
    : null,
  detailPosition > detailTotal
    ? { name: "detail_position_exceeds_detail_total", actual: detailPosition, limit: detailTotal }
    : null,
  detailTotal > targetDiscovered
    ? { name: "detail_total_exceeds_target_discovered", actual: detailTotal, limit: targetDiscovered }
    : null
].filter(Boolean);
if (violations.length) {
  const error = scanRunError("SCAN_PROGRESS_INVALID", "scan progress counters exceed the frozen target bounds");
  error.details = {
    category: "scan_progress_bounds",
    violations,
    counters: { targetPosition, targetTotal, targetDiscovered, detailPosition, detailTotal },
    bounds: { frozenPosition, frozenTargetTotal: targets.length, cardLimit }
  };
  throw error;
}
```

不在 `details` 中加入 `targetKey`、关键词、岗位内容或页面内容。

- [ ] **Step 4: 在现有工作流日志上下文中记录拒绝原因**

在 `onTargetComplete` 和 `onProgressCheckpoint` 的 catch 中，包装为 `SCAN_CHECKPOINT_FAILED` 前加入：

```js
scanLogger.warn("scan_checkpoint_rejected", {
  batchId,
  checkpointKind: "progress",
  error: errorMeta(error)
});
```

目标完成检查点使用 `checkpointKind: "target_complete"`。`scanLogger` 已绑定 `workflowRunId`、`scanRunId` 和 `scanBatchId`，`errorMeta()` 会经过现有日志去敏器。

- [ ] **Step 5: 运行诊断与事务回归**

Run: `node tests/scan_recovery_smoke.js; node tests/scan_store_contract_smoke.js; node tests/scan_cli_lifecycle_smoke.js; node tests/observability_smoke.js; node tests/observability_context_smoke.js`

Expected: 五项 PASS；越界写入仍回滚，错误详情不含目标键或用户内容，现有日志去敏契约保持成立。

- [ ] **Step 6: 提交诊断改动**

```powershell
git add src/storage/scan_store.js src/cli.js tests/scan_recovery_smoke.js
git commit -m "fix: diagnose rejected scan progress checkpoints"
```

### Task 4: 文档收口与完整离线门禁

**Files:**
- Modify: `docs/superpowers/specs/2026-09-03-workflow-safe-stop-coverage-design.md`
- Modify: `docs/superpowers/plans/2026-09-03-workflow-safe-stop-coverage.md`
- Modify: `docs/PROJECT_HANDOFF.md`

**Interfaces:**
- Consumes: Tasks 1-3 的精确提交与测试结果。
- Produces: 已完成状态、可复核的测试证据和最终 Git 状态；不产生发布包或真实平台访问。

- [ ] **Step 1: 运行风险相关定向门禁**

Run: `node tests/workflow_page_migration_smoke.js; node tests/workflow_dashboard_smoke.js; node tests/workflow_control_smoke.js; node tests/workflow_progress_smoke.js; node tests/workflow_recovery_smoke.js; node tests/scan_recovery_smoke.js; node tests/scan_cli_lifecycle_smoke.js`

Expected: 七项 PASS。

- [ ] **Step 2: 运行完整离线测试**

Run: `npm test`

Expected: 所有离线检查通过；记录本次实际通过总数，不复用旧版本的 `142` 项结果。

- [ ] **Step 3: 更新状态和交接证据**

将设计文档状态改为“已实现”，勾选本计划已经执行的复选框，并在 `docs/PROJECT_HANDOFF.md` 记录：

```markdown
- 用户变化：进入真实沟通前，中断或等待复核的本轮也可以安全结束；已有结果保留。
- 根因：停止能力已存在，但页面只为 active 阶段渲染控制区。
- 诊断：冻结边界异常现在记录具体不变量、当前值和上限，不记录岗位或用户正文。
- 真实平台：本次开发和自动测试未访问 BOSS，当前验收遗留本轮未被自动修改。
```

同时写入本次实际测试总数和实现提交 SHA；不得把未运行项目写成通过。

- [ ] **Step 4: 检查文档和工作树**

Run: `git diff --check; git status --short --branch`

Expected: `git diff --check` 无输出；状态只包含本任务预期的文档改动。

- [ ] **Step 5: 提交最终文档**

```powershell
git add docs/superpowers/specs/2026-09-03-workflow-safe-stop-coverage-design.md docs/superpowers/plans/2026-09-03-workflow-safe-stop-coverage.md docs/PROJECT_HANDOFF.md
git commit -m "docs: close workflow safe stop fix"
```

- [ ] **Step 6: 在精确最终提交上复跑最终门禁**

Run: `npm test; git diff --check; git status --short --branch; git rev-parse HEAD`

Expected: 完整离线测试再次全部通过，`git diff --check` 无输出，工作树干净，并记录精确最终 SHA。不推送、不打包、不发布，除非用户之后明确授权。
