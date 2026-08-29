# RoleFlow 用户旅程验收修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** 修复消息、求职体检、定向简历和模拟面试中已经复现的数据回退、输入丢失、异步崩溃与结果不可见问题，并保持既有阶段设计和 BOSS 安全边界不变。

**Architecture:** 继续使用当前服务端渲染页面、SQLite 持久化和页面内原生 JavaScript。消息草稿由 SQLite 覆盖已完成运行的内存快照；面试未提交文字只保存在浏览器本地；异步路由统一进入现有服务端错误边界；成功结果用 URL 锚点定位，不引入新状态层。

**Tech Stack:** Node.js、内置 SQLite、服务端 HTML、原生浏览器 JavaScript、现有离线 smoke 测试。

## 全局约束

- 不访问真实 BOSS，不执行填写、粘贴、发送、投递或申请。
- 不修改 30/50/70 样本档位、48 小时与周末顺延算法、策略轮次归属。
- 不增加依赖、数据库迁移、前端框架、微服务或新的外部写入口。
- 保留消息发送的不可变批次、后台串行执行、身份核验、访问额度和遇风险即停。
- 每项行为改动先补会在旧实现失败的回归，再做最小实现。

---

### Task 1：异步失败不再终止 Dashboard

**Files:**
- Modify: `src/dashboard/server.js`
- Modify: `tests/dashboard_resume_optimization_smoke.js`
- Modify: `tests/dashboard_mock_interview_smoke.js`

- [x] 在定向简历和模拟面试的测试中加入“服务层 Promise 拒绝时返回受控错误、随后页面仍可访问”的回归。
- [x] 运行新增定向回归，确认旧实现失败且失败原因是异步拒绝越过外层错误边界。
- [x] 将对应异步路由改为由外层处理器 `await`，不改变成功响应、事务或幂等语义。
- [x] 重跑两个页面测试并提交：`fix: keep dashboard alive on workflow errors`。

### Task 2：消息草稿刷新后使用当前持久化版本

**Files:**
- Modify: `src/dashboard/message_discovery_controller.js`
- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `tests/dashboard_message_discovery_smoke.js`
- Modify: `tests/dashboard_communication_profile_smoke.js`

- [x] 增加回归：已完成发现运行中编辑草稿后，`pageState` 返回 SQLite 最新文字和修订号。
- [x] 增加回归：同一运行快照中的草稿关闭后不会在刷新时重新出现。
- [x] 运行定向测试，确认旧实现分别返回旧文字和重新出现的草稿。
- [x] 在页面状态生成时，以当前开放草稿覆盖终态运行快照；公开状态接口仍不返回正文。
- [x] 为每条草稿增加独立保存状态，并把“已手动发送”改为“我已在 BOSS 手动发送”。
- [x] 收敛消息卡片默认信息层级，把公司业务、资料来源和补充信息放入原生折叠区，不改发送授权逻辑。
- [x] 重跑消息发现、沟通资料和回复学习定向测试并提交：`fix: render authoritative message drafts`。

### Task 3：模拟面试保留未提交回答并定位结果

**Files:**
- Modify: `src/dashboard/pages/mock_interview.js`
- Modify: `src/dashboard/server.js`
- Modify: `tests/dashboard_mock_interview_smoke.js`

- [x] 增加页面回归：进行中逐题记录只显示已回答题，当前题只在回答区出现一次。
- [x] 增加脚本行为回归：当前回答与重答按会话、题号和用途恢复；失败保留；成功清除。
- [x] 增加重定向回归：开始/回答定位当前步骤，结束定位复盘，重答定位对应题目。
- [x] 运行新增回归并确认旧实现失败。
- [x] 用 `localStorage` 实现输入即保存和同题恢复；未提交文字不进入 SQLite、模型上下文或候选人事实。
- [x] 表单提交改为页面内请求：失败就地显示、恢复按钮并保留文字，成功沿服务端最终 URL 跳转。
- [x] 增加稳定锚点，过滤未回答题；将“面试类型”改为“题目侧重”，“通用沟通”改为“自我介绍与沟通”。
- [x] 重跑模拟面试页面、服务和存储测试并提交：`fix: preserve interview input and results`。

### Task 4：定向简历失败留在原位、成功直达结果

**Files:**
- Modify: `src/dashboard/pages/resume_optimization.js`
- Modify: `src/dashboard/server.js`
- Modify: `tests/dashboard_resume_optimization_smoke.js`

- [x] 增加脚本行为回归：生成、保存和启用失败时页面不离开、按钮恢复、当前文字保留并显示错误。
- [x] 增加重定向回归：生成定位新草稿，启用定位已启用结果。
- [x] 运行新增回归并确认旧实现失败。
- [x] 复用现有自动保存串行链拦截表单；成功按服务端最终 URL 跳转，失败就地提示，不增加二次确认。
- [x] 增加稳定结果锚点，不改变原子启用和失败回滚。
- [x] 重跑定向简历页面、服务和存储测试并提交：`fix: keep resume workflow feedback visible`。

### Task 5：求职体检文案与策略表单校验

**Files:**
- Modify: `src/dashboard/pages/funnel.js`
- Modify: `tests/dashboard_funnel_smoke.js`

- [x] 增加回归：页面显示“等待反馈成熟”和“至少 48 小时；周末顺延”。
- [x] 增加脚本行为回归：招呼语和求职策略均未选中时阻止提交并提示，选择任一项后允许提交。
- [x] 运行新增回归并确认旧实现失败。
- [x] 使用原生表单校验完成最小实现，保留服务端兜底校验和现有策略轮次写入。
- [x] 重跑求职体检、漏斗成熟与策略轮次测试并提交：`fix: clarify funnel maturity controls`。

### Task 6：完整本地验收与交付记录

**Files:**
- Modify: `docs/superpowers/specs/2026-08-29-user-journey-acceptance-fixes-design.md`
- Modify: `docs/NEXT_PHASE.md`（仅当实际交付状态需要同步）
- Modify: `docs/PROJECT_HANDOFF.md`（仅当实际交付状态需要同步）

- [x] 运行消息、求职体检、定向简历、模拟面试的全部定向回归。
- [x] 使用本地假数据在 1440×980 与 375×812 下重走用户流程，验证刷新恢复、失败留页、成功定位、消息卡片操作和无横向溢出。
- [x] 运行新鲜完整 `npm test`，记录实际检查总数。
- [x] 运行 `git diff --check`、检查工作树和提交历史；在精确最终 SHA 上再次运行与风险相称的最终门禁。
- [x] 把设计状态与交付证据写入文档并提交：`docs: record user journey acceptance fixes`。
- [x] 不推送、不合并、不打包、不改版本号、不创建 Release。
