# RoleFlow 文档导航

- [`PROJECT_HANDOFF.md`](PROJECT_HANDOFF.md)：跨会话、跨编辑器和跨代理的项目交接入口；开始开发前先读。

本目录同时保存当前产品文档和历史整改记录。阅读时应先确认文档类型，避免把旧方案中的参数当成当前行为。

## 当前产品文档

以下文档需要与当前代码持续保持一致：

- [`../README.md`](../README.md)：项目定位、安装方式、主要能力和快速开始。
- [`product_spec.md`](product_spec.md)：产品边界、用户流程和功能规格。
- [`daily_workflow.md`](daily_workflow.md)：每日扫描、模型分析、清单确认和批量沟通的当前执行逻辑。
- [`onboarding_workflow.md`](onboarding_workflow.md)：模型配置、简历解析、画像与 Search Plan 首次使用流程。
- [`llm_contracts.md`](llm_contracts.md)：简历、岗位理解、匹配和沟通草稿的模型契约。
- [`operations.md`](operations.md)：日志、错误码、恢复和排错方法。
- [`release_boundary.md`](release_boundary.md)：绿色包、隐私数据和外部操作边界。

## 历史记录

以下文件用于保留当时的分析、设计与验收证据，不代表当前参数：

- `runtime_flow_review.md`
- `remediation_plan.md`
- `resilience_audit.md`
- `completion_audit.md`
- `two-run-workflow-validation.md`
- `boss-communication-calibration.md`
- `communication_live_acceptance.md`
- `superpowers/plans/`
- `superpowers/specs/`

其中“双轮工作流”已经被三轮上限与条件式第三轮取代。历史文件不回写新结论，当前逻辑统一查看 [`daily_workflow.md`](daily_workflow.md)。

## 事实优先级

出现不一致时，按以下顺序判断：

1. 自动化测试和实际运行结果。
2. `src/core/product_policy.js`、`src/core/workflow_run.js`、`src/core/site_access_budget.js` 等当前源码。
3. 本节列出的当前产品文档。
4. 历史审计、设计稿和实施计划。

数据库、真实简历、日志、浏览器登录态和本机密钥不属于项目文档，不得提交到公共仓库。
