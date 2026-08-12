# BOSS Explicit Dual Detail Mode Implementation Plan

> **For agentic workers:** Use subagent-driven development with strict TDD, independent review, and verification before completion.

**Goal:** 保留默认可信右栏链路，增加显式、不可自动回退的 `search_page_api` 静默详情模式，并在通过校准后完成正式全量 Gate D。

**Architecture:** CLI/Dashboard 生命周期传递 `detailMode`，扫描执行快照绑定模式；BOSS 详情循环在单一选择点调用右栏或页面同源 API 读取器。API token 留在页面闭包，访问预算、节奏、检查点和审计复用现有合同。

**Constraints:** 不执行沟通、发送或投递；不降低覆盖和 JD 完整性；不启动 Wave 5；真实校准失败时不进入正式全量。

---

## Task 1：页面 API 状态机和显式详情选择

**Files**

- Modify: `src/adapters/sites/boss.js`
- Modify: `tests/source_acquisition_smoke.js`

1. 先写 RED：
   - API helper 身份/JD/状态机；
   - 每岗位一次、不同岗位并发拒绝；
   - timeout/abort 清理；
   - `search_page_api` 下 0 次详情激活、点击、导航和建标签；
   - API 失败不调用 `readVisiblePaneDetail`。
2. 实现页面闭包和 `readSearchPageApiDetail()`。
3. 在详情循环单点按 `options.detailMode` 选择读取器。
4. 保持 `readVisiblePaneDetail()` 原实现不变。
5. 运行 focused tests 和 `git diff --check`。

## Task 2：模式传递、恢复快照和审计

**Files**

- Modify: `src/core/scan_execution.js`
- Modify: `src/core/scan_snapshot.js`
- Modify: `src/cli.js`
- Modify: `src/dashboard/server.js`
- Modify: `tests/scan_execution_smoke.js`
- Modify: `tests/scan_snapshot_smoke.js`
- Modify: `tests/dashboard_scan_lifecycle_smoke.js`
- Modify as needed: `tests/scan_recovery_smoke.js`
- Modify: `tests/workflow_scan_smoke.js`

1. 先写 RED：
   - `--detail-mode` 仅允许 `trusted_pane|search_page_api`；
   - 新扫描默认 `trusted_pane`；
   - Dashboard 受控请求可显式传递；
   - 恢复沿用快照模式，冲突拒绝；
   - 快照哈希包含模式；
   - `pane_detail_result` 保留 `search_page_api`。
2. 将扫描快照 schema 升级并加入 `detailMode`。
3. 普通 Dashboard 表单不展示实验开关。
4. 旧 snapshot fail-closed，不做隐式迁移。
5. 运行相关恢复、CLI、Dashboard 和审计测试。

## Task 3：访问预算和节奏

**Files**

- Modify: `src/core/product_policy.js`
- Modify: `src/core/site_access_budget.js`
- Modify: `src/core/site_access_usage.js`
- Modify: `tests/site_access_budget_smoke.js`
- Modify: `tests/site_access_usage_smoke.js`
- Modify: `tests/boss_safe_pacing_smoke.js`

1. 先写 RED，证明当前新动作无限额/未统计/未净化。
2. `job_detail_fetch` 逐窗口复制 `pane_detail_read` 的 normal/recovery 额度。
3. reservation 只保留 `{ jobId }`。
4. 纳入详情用量，复用原 8–14 秒等待和详情冷却。
5. 运行 focused tests。

## Task 4：独立审查和完整离线验证

1. 每个实现任务做 spec/quality review。
2. 做全分支隐私、安全、恢复和无回退审查。
3. 运行全部注册离线检查。
4. 合并后在 main 再运行同一完整套件。
5. 恢复隐藏 Dashboard；不启动真实扫描。

## Task 5：真实静默校准

1. 确认两个固定 Edge 标签、无并发扫描和无活跃租约。
2. 创建新的 D: 校准基线。
3. 从项目隐藏生命周期显式启动 `search_page_api`，2 个关键词、最多 3 个详情。
4. 只通过进程和 SQLite 监控；独立监控 Windows 前台。
5. 要求 3/3 成功、JD≥120、页面选择不变、无前台抢占、无新增 token 落盘。
6. 任一失败即精确停止、收口 run/batch/lease，并排除该数据库。

## Task 6：正式全量 Gate D 和第一阶段收口

仅 Task 5 通过后：

1. 创建另一份全新正式基线。
2. 显式使用 `search_page_api` 跑完整 daily 扫描。
3. 等待真实终态并固定导出一次。
4. 评测覆盖、JD、失败码、技术状态、分析状态和影子积分卡。
5. 使用 Edge 完成 Dashboard、自动沟通入口和消息只读页人工验收；不执行新沟通。
6. 发布 Wave 0–4 第一阶段收口报告；Wave 5 不启动。

