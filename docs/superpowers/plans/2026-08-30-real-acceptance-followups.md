# 真实全流程验收问题收口实施计划

> 依照 `2026-08-30-real-acceptance-followups-design.md`，按测试先行、最小改动执行。全程不访问真实 BOSS。

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

