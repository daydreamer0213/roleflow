# 兼职选择与空薪资筛选 Implementation Plan

> **For agentic workers:** Use executing-plans to implement the following tasks, with a read-only code review after implementation.

**Goal:** 默认排除兼职、新方案薪资留空，用户显式选择才能影响筛选。

**Architecture:** 扩展现有 SearchPlan JSON 与共用资格/评分函数，不添加平行筛选器。初次推荐和常规保存分开处理；本地筛选与继承平台范围保持分离。

**Tech Stack:** Node.js、原生 HTML 表单、SQLite、现有 smoke checks；无新依赖。

## Global Constraints

按已确认设计 `../specs/2026-09-04-part-time-salary-policy-design.md`；只用离线数据，不改真实用户保存值，不推送/合并/打包。

### Task 1: 资格与薪资规则

**Files:** `src/core/job_eligibility.js`, `job_metadata.js`, `scoring.js`, `search_plan.js`, `search_plan_schema.js`, `profile_schema.js`, `profile_onboarding.js`, `analysis_revision.js`, `job_analysis.js`, `platform_filters.js`, `platform_runtime_policy.js`, `src/storage/communication_store.js`, `job_store.js`；新增集中行为回归 `tests/screening_preferences_smoke.js`，并复用已有资格、方案、评分与沟通检查。

**Interfaces:** `allowPartTime: boolean` 从方案传到 `targetPolicy`，共用资格函数生成 `part_time_role`；`salary.minK/maxK` 的 0 表示未设置。

- [x] 检查干净基线：安装缺失依赖后 `npm test`，142/142 通过。
- [x] 增加并运行失败用例：`evaluateJobEligibility({title:'运营兼职'}).status === 'blocked'`；开启后 eligible；混合、否定、职责提及不阻断。
- [x] 增加并运行失败用例：无薪资方案下 `scoreJob({...job,salary:'8-12K'}, configs).score === scoreJob({...job,salary:'50-60K'}, configs).score`；生成、保留、清空和单边薪资覆盖。
- [x] 实现方案字段、资格与硬边界、初次空薪资、运行阈值和版本失效；不修改 JD/浏览器读取路径。
- [x] 运行 `node tests/job_eligibility_smoke.js`、`node tests/search_plan_modes_smoke.js`、`node tests/screening_quality_smoke.js`、`node tests/communication_batch_storage_smoke.js`。

### Task 2: 保存与用户页面

**Files:** `src/dashboard/server.js`, `src/dashboard/pages/today.js`, `tests/today_dashboard_smoke.js`，初次推荐用例纳入 Task 1 的方案回归。

**Interfaces:** 表单 `allowPartTime=on` 保存 true，未勾选 false；空薪资字段保存 0，渲染为空字符串。

- [x] 为 `/api/plan` 保存→刷新增加失败回归：勾选与取消、保存范围后清空；渲染薪资输入空白及单边摘要。
- [x] 复用已有 checkbox 样式，加入接受兼职、简短薪资占位说明和不误导的摘要。平台原选项保留，避免旧仅兼职方案读取或保存后扩大范围；继承范围不变。
- [x] 运行 `node tests/today_dashboard_smoke.js`、`node tests/onboarding_smoke.js`、`node tests/profile_quality_smoke.js`、`node tests/inherited_search_scope_smoke.js`。

### Task 3: 交付验证

- [x] 独立只读复审；修正 Important/Critical 并补对应行为回归。最终复核无剩余阻塞。
- [x] 新鲜 `npm test`、`git diff --check`；本地页面模拟检查，不访问真实平台。
- [x] 更新交接/本计划实际证据，提交候选；在精确提交重跑风险相关检查。
- [x] 整理用户变化、验证、未验证范围、提交和后续验收入口；保留隔离分支供用户验收。

## 实际验证记录

- 干净实现基线：安装缺失的现有依赖（D 盘缓存）后完整 `npm test` 为 142/142；不能代替变更后的门禁。
- 集中回归先验证失败，再实现修复；覆盖兼职/小时工资、归一化后的加班费用、独立实习限制、全兼均可、否定和招聘职责、旧仅兼职范围、开关开启后撤销的单选参数、初次空薪资、保存清空及单边限制。
- 独立只读复审收口完成。严格本地 headless Edge 用现有 Playwright 检查中文标签、默认未选、开关交互、薪资空值与 1024px 展开表单无溢出；`today_dashboard_smoke` 通过，没有跳过布局检查。
- 实现提交 `c7733c2fdfa7af30bb42a1df89a88ef3cac4506e` 对应代码树的新鲜完整 `npm test` 退出码 0，实际末行为 `All 143 offline checks passed.`，启用 `ROLEFLOW_REQUIRE_PLAYWRIGHT=1`，没有跳过今日任务页布局检查。完整门禁期间仅更新交接文档，产品代码与测试没有改变。
- 在精确实现提交 `c7733c2` 上再次运行 `screening_preferences_smoke`、`today_dashboard_smoke`（严格本地 Edge）、`communication_batch_storage_smoke`、`search_plan_modes_smoke`、`inherited_search_scope_smoke`、`semantic_pipeline_smoke`、`four_tier_pipeline_smoke`，7/7 通过；`git diff --check` 通过。
- 验证只使用离线 fixture、临时数据库和本地假页面。没有访问真实 BOSS、调用真实模型、修改用户方案或读写真实简历；给定 URL 仅匹配本机已存岗位记录，不能代表当前线上页面。

## 下一入口

候选尚未推送、合并或打包，已安装版本不变。用户可在候选版“今日任务 → 调整筛选条件 → RoleFlow 本地精筛”检查开关及清空薪资再保存；当前旧方案的已保存薪资不会自动删除。真实 BOSS 复验和发布须使用后续明确授权。
