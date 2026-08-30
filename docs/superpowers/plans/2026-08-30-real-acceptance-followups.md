# 真实全流程验收问题收口实施计划

> 依照 `2026-08-30-real-acceptance-followups-design.md`，按测试先行、最小改动执行。Task 1–4 不访问真实 BOSS；Task 5 是用户另行授权的真实只读验收，不包含消息发送或其他外部写。

## Task 1：纠正“待补详情”误分类

**修改：**
- `tests/workflow_task_storage_smoke.js`
- `tests/workflow_scan_analysis_smoke.js`
- `tests/storage_migration_smoke.js`
- `src/core/workflow_analysis_tasks.js`
- `src/storage/workflow_store.js`
- `src/core/storage.js`

**步骤：**
1. 增加失败测试：无完整 JD 但 `hard_boundary/blocked` 的任务应直接 `skipped`，不带 `DETAIL_REQUIRED`；真正无结论的任务仍为 `DETAIL_REQUIRED`。
2. 增加迁移测试：历史 `skipped/DETAIL_REQUIRED` 中只有确定性排除行被清理。
3. 修改初始化和收尾 SQL，并增加只修正目标历史行的 v26 迁移。
4. 运行上述三个测试，确认通过。

## Task 2：让安全停止取消模型请求

**修改：**
- `tests/message_discovery_job_context_smoke.js`
- `tests/analysis_application_smoke.js`
- `tests/semantic_pipeline_smoke.js`
- `tests/model_adapter_smoke.js`
- `src/application/message_discovery/job_context.js`
- `src/application/analysis/index.js`
- `src/core/job_analysis.js`
- `src/core/llm_analyzer.js`
- `src/adapters/models/openai_compatible.js`

**步骤：**
1. 增加失败测试，证明同一 `AbortSignal` 到达岗位分析 runner 和模型 HTTP 请求。
2. 增加适配器测试：请求中取消保留外部停止原因，取消后不重试；重试等待也可取消。
3. 逐层增加可选 `signal` 参数；缓存读取、模型调用、契约修复和缓存保存前检查取消状态。
4. 运行四个定向测试，确认停止原因和无落库行为正确。

## Task 3：修复长结构化输出截断后的超时

**修改：**
- `tests/model_adapter_smoke.js`
- `src/adapters/models/openai_compatible.js`

**步骤：**
1. 增加失败测试：三个岗位结构化任务首轮 8192，截断后 16384；普通任务仍从配置值开始。
2. 增加请求超时选择测试：输出预算扩大时按比例增加，但不超过 300 秒。
3. 实现长任务集合、16384 上限和有界自适应超时，不改变提示词与契约。
4. 运行模型适配器和语义管线测试。

## Task 4：复审、文档与提交

**修改：**
- `docs/NEXT_PHASE.md`
- `docs/PROJECT_HANDOFF.md`
- `docs/superpowers/reports/2026-08-30-real-user-e2e-acceptance.md`

**步骤：**
1. 只读检查三项修复的错误分类、取消竞态、缓存写入和超时边界。
2. 运行全部相关定向测试和完整 `npm test`，记录实际总数。
3. 运行 `git diff --check` 与 `git status`。
4. 按“代码与迁移 / 最终文档”拆分本地提交；在最终精确 SHA 上重跑风险相称的验证。
5. 不推送、不合并、不打包、不改版本号。

## Task 5：最终消息草稿复验

**修改：**
- `src/adapters/sites/boss_message_dom.js`
- `src/core/message_preview_state.js`
- `src/adapters/models/openai_compatible.js`
- 对应 smoke tests

**步骤：**
1. 增加失败测试，证明每次快照必须替换旧页面残留 helper，且队列必须保留会话 `friendKey`。
2. 用最小真实只读探针区分页面可见性、会话身份和队列字段问题；不放宽后台与身份守卫。
3. 用不含真实招聘内容的合成消息复现模型回复契约失败，再补提示词回归；不放宽事实契约。
4. 停止本地服务，备份正式数据库；严格核对 8 个失败组、25 条分类事件、8 个基线以及 0 草稿/上下文/发送批次后，以单一事务撤销失败记录。
5. 重新运行真实只读消息发现，核对处理结果、草稿、缺失事实、未解决项、数据库完整性和发送批次。
6. 运行定向回归、完整 `npm test`、`git diff --check` 和只读代码复审。

## 完成记录

- 2026-08-30 已按 Task 1–4 完成实现；代码与迁移提交为 `66d89d4`。
- 真实运行库的一致副本迁移前后为：总任务 69，`DETAIL_REQUIRED` 12→4，8 个确定性排除误分类全部清除；原运行库未在验证中修改。
- 关键定向回归、`git diff --check` 和完整 `npm test` 均通过；完整门禁退出码为 0，实际为 131/131，末行为 `All 131 offline checks passed.`。
- 实现和离线门禁没有访问真实 BOSS、调用真实模型、发送消息、投递或申请；没有推送、合并、打包、改版本号或创建 Release。
- 离线收口后已在正式运行库执行迁移 26：69 个任务的 `DETAIL_REQUIRED` 从 12→4，8 个误分类归零，`quick_check=ok`；真实本地页面也显示待补 4、无需详情 8。页面证据保存在 `D:\DevData\RoleFlow-verification\v26-workflow-*`。
- Task 5 已按红绿回归修复陈旧页面 helper、队列身份字段和真实模型回复结构三处问题，代码与回归提交为 `b8e6ccc`；严格会话身份、事实边界和平台写入边界没有放宽。
- 恢复前备份位于 `D:\DevData\RoleFlow-verification\pre-contract-recovery-20260830-2050`。精确撤销 25 条失败分类事件和 8 个预览基线后，真实只读复验处理 8 组消息：6 组生成 12 份开放草稿和 6 份本地消息上下文，2 组缺少用户事实，另保留 3 条城市不匹配；发送批次为 0，`quick_check=ok`。
- 最终消息页显示 8 个结果、12 个可编辑自动保存草稿、2 个缺失事实提示和批量发送面板；没有点击发送、复制、标记已手动发送、简历操作、投递或申请。
- 7 项聚焦回归和新鲜完整 `npm test` 均通过；完整门禁退出码 0，实际为 131/131，末行为 `All 131 offline checks passed.`。
