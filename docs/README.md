# RoleFlow 文档导航

## 新会话必读

按以下顺序读取，不要先加载历史聊天或整个 `superpowers` 目录：

1. [`../AGENTS.md`](../AGENTS.md)：长期安全、质量、浏览器和数据边界。
2. [`PROJECT_HANDOFF.md`](PROJECT_HANDOFF.md)：当前未发布 source candidate 的状态和交接协议。
3. [`NEXT_PHASE.md`](NEXT_PHASE.md)：当前候选的后续门禁、发布边界和待办。
4. 当前任务直接涉及的源码、测试和一份对应设计。

## 当前产品文档

以下文档需要与当前代码持续保持一致：

- [`../README.md`](../README.md)：项目定位、安装方式、主要能力和快速开始。
- [`releases/v1.3.1.md`](releases/v1.3.1.md)：本次 v1.3.1 的用户变化、验证边界和下载文件说明；公开状态以 Release 页面为准。
- [`releases/v1.3.0.md`](releases/v1.3.0.md)：上一正式版的用户变化与验证记录。
- [`releases/v1.2.2.md`](releases/v1.2.2.md)：已发布 v1.2.2 的历史版本说明；不代表当前正式版。
- [`releases/v1.2.1.md`](releases/v1.2.1.md)：已发布 v1.2.1 的历史版本说明；不代表当前正式版。
- [`releases/v1.2.0.md`](releases/v1.2.0.md)：已发布 v1.2.0 的历史版本说明；不代表当前 source candidate。
- [`releases/v1.0.0.md`](releases/v1.0.0.md)：已发布 v1.0.0 的历史版本说明；不代表当前 source candidate。
- [`product_spec.md`](product_spec.md)：产品边界、用户流程和功能规格。
- [`daily_workflow.md`](daily_workflow.md)：每日扫描、模型分析、清单确认和批量沟通逻辑。
- [`onboarding_workflow.md`](onboarding_workflow.md)：模型配置、简历解析、画像与筛选方案首次使用流程。
- [`llm_contracts.md`](llm_contracts.md)：简历、岗位理解、匹配和沟通草稿的模型契约。
- [`operations.md`](operations.md)：日志、错误码、恢复和排错方法。
- [`release_boundary.md`](release_boundary.md)：安装包、隐私数据和外部操作边界。

## 历史记录

以下内容保留当时的设计、计划与验收证据，不代表当前版本状态：

- `runtime_flow_review.md`
- `remediation_plan.md`
- `resilience_audit.md`
- `completion_audit.md`
- `two-run-workflow-validation.md`
- `boss-communication-calibration.md`
- `communication_live_acceptance.md`
- `superpowers/plans/`
- `superpowers/specs/`
- `superpowers/reports/`

历史文件不回写后续结论。若历史文档与当前权威文档冲突，以当前代码、测试、`AGENTS.md`、`PROJECT_HANDOFF.md` 和 `NEXT_PHASE.md` 为准。

## 事实优先级

1. 当前自动化测试、实际运行结果和 Git 状态。
2. `src/core/product_policy.js` 等当前源码。
3. 本页列出的当前权威和产品文档。
4. 历史报告、设计、计划和聊天记录。

数据库、真实简历、日志、浏览器登录态、本机密钥和真实消息正文不属于项目文档，不得提交到公共仓库。
