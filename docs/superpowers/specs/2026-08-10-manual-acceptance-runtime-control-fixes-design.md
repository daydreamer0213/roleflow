# 人工验收运行控制修复设计

**日期：** 2026-08-10
**状态：** 已批准实施
**范围：** 暂停表单、扫描冷却状态、扫描暂停响应、详情增量检查点

## 目标

修复人工验收中确认的三个核心问题：

1. 点击“暂停本轮”时必须稳定提交 `action=pause`。
2. BOSS 安全访问额度触发冷却时，任务面板必须显示真实等待状态，且不能把健康扫描误报为失活。
3. 冷却期间点击暂停后，扫描应在短时间内安全停下；已经成功读取的完整 JD 必须保留，未完成搜索目标仍可在恢复后继续。

## 不在本次范围

- 不调整 BOSS 访问频率、随机节奏、冷却时间或任何安全上限。
- 不减少岗位卡片、完整 JD 或推荐质量的覆盖目标。
- 不改变固定 `BOSS-SEARCH` / `BOSS-COMMUNICATION` 标签页约束。
- 不自动恢复当前已暂停的人工验收任务。
- 不做非核心 UI 美化和大规模重构。

## 已确认根因

### 暂停操作丢失

暂停和恢复按钮依赖提交按钮自身的 `name="action"`。提交监听器立即禁用所有控制按钮；浏览器构造表单数据时会忽略已禁用的提交按钮，因此服务端收到空 action。

### 冷却期间误报失活

任务面板只读取 `workflow_runs.last_activity_at`。`recordWorkflowPlatformAccess` 使用 `COALESCE`，只在第一次网页访问时设置该字段；持续更新的 `scan_runs.heartbeat_at` 没有参与面板健康判断。

### 暂停慢且详情丢失

访问预算控制器一次睡完整个冷却时间，只检查进程级 AbortSignal。任务面板写入数据库的 `pause_requested` 不会中止该 signal，因此只能等待兜底计时器发送 `SIGTERM`。

扫描只在整个搜索目标结束后调用 `checkpointScanTarget`。目标中已经读到的完整 JD 仍在内存里，强制终止会丢失这些增量结果。

## 设计

### 1. 表单 action 使用隐藏字段

暂停和恢复表单都渲染独立隐藏字段：

```html
<input type="hidden" name="action" value="pause">
```

按钮只负责触发提交和展示状态。即使提交监听器禁用按钮，隐藏字段仍会进入表单数据。停止表单已经采用该模式，保持一致即可。

### 2. 冷却状态进入工作流快照

访问预算控制器新增两个可选回调：

- `onWait(wait)`：开始安全冷却时报告 action、delayMs、retryAt、窗口和额度使用量。
- `assertActive()`：长等待期间定期检查工作流控制状态。

CLI 在工作流扫描中把 `onWait` 连接到持久化函数。持久化函数用 SQLite JSON 操作原子更新 `workflow_runs.metrics_json.scanWait`，并更新 `last_activity_at` 与 `progress_revision`。下一次成功预约网页访问时，`recordWorkflowPlatformAccess` 清除 `scanWait`。

`getWorkflowProgressSnapshot` 返回：

```js
progress: {
  scanWait: {
    action: "detail_open",
    retryAt: "2026-08-10T12:34:56.000Z",
    delayMs: 379293
  }
}
```

仅当工作流仍在扫描、等待尚未到期，并且等待记录属于当前 scan run 时公开该状态。

### 3. 健康时间合并扫描心跳

工作流快照读取当前 `scan_run_id` 对应的 `scan_runs.heartbeat_at`。面板使用工作流活动时间和扫描心跳中较新的时间作为 `lastActivityAt`。

这样任务在安全冷却中仍由现有租约心跳证明存活，不会显示“任务可能失去活动”。不改变孤儿扫描判定和现有超时阈值。

### 4. 冷却等待可响应暂停

只有配置了 `assertActive` 的工作流扫描才把长等待拆成最多 1 秒的小段。每段前后调用 `assertActive()`：

```text
额度不足
  -> 记录冷却状态
  -> 检查 pause/stop
  -> 等待最多 1 秒
  -> 再次检查
  -> 到期后重新预约
```

CLI 的 `assertActive` 调用现有 `assertWorkflowScanControl`。检测到 `pause_requested` 或 `stop_requested` 时抛出现有控制错误，由现有工作流收尾逻辑结算为暂停或停止。三分钟 `SIGTERM` 仍保留为硬故障兜底。

### 5. 完整 JD 增量检查点

新增 `checkpointScanProgress`：

- 校验 scan run、batch、lease owner 和租约有效期；
- 原子 upsert 本次成功读到的岗位与 observation；
- 更新 scan run heartbeat；
- 不写 `scan_target_results`，因此不会把未完成目标误判为已完成。

BOSS 适配器在每个详情成功标准化后、详情节奏等待前调用 `onDetailCheckpoint`。CLI 将单个岗位转换为现有 checkpoint 格式后写入数据库。

工作流控制错误必须直接穿透目标循环，不能进入“目标失败”分支，也不能写失败的 `scan_target_results`。恢复时该目标仍属于待处理目标；此前完整 JD 已在 batch observation 中，可由现有详情复用逻辑避免重复读取。

## 验证范围

只增加与缺陷直接对应的回归断言：

1. 工作流页面暂停/恢复表单包含隐藏 action。
2. 预算控制器报告冷却，并能在分段等待中响应控制错误。
3. 工作流快照采用较新的扫描心跳并公开有效冷却状态。
4. 增量检查点保存岗位但不产生目标完成记录。
5. BOSS 详情成功后触发增量检查点；暂停错误不写失败目标检查点。
6. 相关测试、全量 `npm test` 和合并后验证均通过。

## 回溯与上线

- 修复在独立分支 `codex/manual-acceptance-runtime-fixes` 完成。
- 合并前在 `main` 创建 checkpoint 标签。
- 合并后重启本地 dashboard 进程，使新服务端代码生效。
- 当前暂停的人工验收任务由用户明确开始下一轮验收时再恢复。

## 人工验收补充：扫描恢复启动竞态

### 现场证据

人工点击“继续本轮”后，dashboard 已创建新的 `scan_runs` 记录并启动子进程，但 `workflow_runs.scan_run_id` 仍短暂指向上一条已中断记录。页面重定向随即调用工作流恢复逻辑，旧记录使工作流从 `scanning` 回退到 `interrupted`；新子进程随后在 `prepareWorkflowExecution` 中收到 `WORKFLOW_SCAN_STATUS_INVALID` 并退出。

### 方案比较

1. **推荐：父进程启动前绑定新扫描记录。** 恢复批次已有稳定的 `scan_batch_id`，`startPlanScan` 创建新 `scan_runs` 后可立即调用现有 `attachWorkflowScan`，再启动子进程。页面查询始终看到新的运行记录，且子进程后续重复绑定保持幂等。
2. 恢复时先清空旧 `scan_run_id`。恢复逻辑会依赖孤儿超时窗口等待子进程绑定，仍保留不必要的时间竞态。
3. 让恢复逻辑宽限刚结束的旧扫描记录。该方案会削弱真实故障的即时收敛，且需要引入额外时序规则。

采用方案 1。只对“工作流恢复且已有持久化批次”的启动路径提前绑定；首次扫描仍由子进程在创建批次后绑定，不改变 BOSS 访问、安全节奏、任务覆盖或后续分析流程。

### 最小验证

在现有 `workflow_dashboard_smoke` 恢复场景中，恢复请求返回后立即读取工作流状态，断言：

- 工作流仍为 `scanning`；
- `scan_run_id` 已切换到刚创建的新扫描记录；
- 状态 API 的恢复检查不会把工作流回退为 `interrupted`。

不增加与该竞态无关的边界测试。
