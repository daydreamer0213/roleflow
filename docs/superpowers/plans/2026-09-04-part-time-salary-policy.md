# 兼职选择与空薪资筛选 Implementation Plan

> **For agentic workers:** Use executing-plans to implement the following tasks, with a read-only code review after implementation.

**Goal:** 默认排除兼职、新方案薪资留空，用户显式选择才能影响筛选。

**Architecture:** 扩展现有 SearchPlan JSON 与共用资格/评分函数，不添加平行筛选器。初次推荐和常规保存分开处理；本地筛选与继承平台范围保持分离。

**Tech Stack:** Node.js、原生 HTML 表单、SQLite、现有 smoke checks；无新依赖。

## Global Constraints

按已确认设计 `../specs/2026-09-04-part-time-salary-policy-design.md`；只用离线数据，不改真实用户保存值，不推送/合并/打包。

### Task 1: 资格与薪资规则

**Files:** `src/core/job_eligibility.js`, `scoring.js`, `search_plan.js`, `search_plan_schema.js`, `profile_schema.js`, `profile_onboarding.js`, `analysis_revision.js`, `job_analysis.js`, `src/storage/communication_store.js`; 回归放入现有 `tests/job_eligibility_smoke.js`, `search_plan_modes_smoke.js`, `screening_quality_smoke.js`。

**Interfaces:** `allowPartTime: boolean` 从方案传到 `targetPolicy`，共用资格函数生成 `part_time_role`；`salary.minK/maxK` 的 0 表示未设置。

- [ ] 检查干净基线：`npm test`。
- [ ] 增加并运行失败用例：`evaluateJobEligibility({title:'运营兼职'}).status === 'blocked'`；开启后 eligible；混合、否定、职责提及不阻断。
- [ ] 增加并运行失败用例：无薪资方案下 `scoreJob({...job,salary:'8-12K'}, configs).score === scoreJob({...job,salary:'50-60K'}, configs).score`；生成、保留、清空和单边薪资覆盖。
- [ ] 实现方案字段、资格与硬边界、初次空薪资、运行阈值和版本失效；不修改 JD/浏览器读取路径。
- [ ] 运行 `node tests/job_eligibility_smoke.js`、`node tests/search_plan_modes_smoke.js`、`node tests/screening_quality_smoke.js`、`node tests/communication_batch_storage_smoke.js`。

### Task 2: 保存与用户页面

**Files:** `src/dashboard/server.js`, `src/dashboard/pages/today.js`, `tests/today_dashboard_smoke.js`，初次推荐用例纳入 Task 1 的方案回归。

**Interfaces:** 表单 `allowPartTime=on` 保存 true，未勾选 false；空薪资字段保存 0，渲染为空字符串。

- [ ] 为 `/api/plan` 保存→刷新增加失败回归：勾选与取消、保存范围后清空；渲染薪资输入空白及单边摘要。
- [ ] 复用已有 checkbox 样式，加入接受兼职、简短薪资占位说明和不误导的摘要。通用模式避免重复兼职控制；继承范围不变。
- [ ] 运行 `node tests/today_dashboard_smoke.js`、`node tests/onboarding_smoke.js`、`node tests/profile_quality_smoke.js`、`node tests/inherited_search_scope_smoke.js`。

### Task 3: 交付验证

- [ ] 独立只读复审；修正 Important/Critical 并补对应行为回归。
- [ ] 新鲜 `npm test`、`git diff --check`；本地页面模拟检查，不访问真实平台。
- [ ] 更新交接/本计划实际证据，提交候选；在精确提交重跑风险相关检查。
- [ ] 报告用户变化、验证、未验证范围、提交和后续验收入口；保留隔离分支。
