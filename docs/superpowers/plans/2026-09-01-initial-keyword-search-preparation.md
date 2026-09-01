# Initial Keyword Search Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 简历首次处理成功后，在不覆盖用户平台条件的前提下，后台为固定 BOSS 搜索页补上初始推荐关键词。

**Architecture:** 新增一个聚焦的 onboarding 搜索页准备模块，复用固定标签页检查、BOSS URL 构造、访问额度和列表页节奏；Dashboard 只在简历子进程正常完成后异步触发，失败仅记日志，不回滚已完成成果。

**Tech Stack:** Node.js、服务端 Dashboard、CDP/Edge 浏览器适配器、SQLite、现有离线 smoke tests。

## Global Constraints

- 只在隔离分支实现，不修改或运行已发布安装环境中的真实数据。
- 测试全部使用假浏览器、临时数据库和 fixture，不访问真实 BOSS。
- 固定 `BOSS-SEARCH` / `BOSS-COMMUNICATION`、后台运行、访问额度、随机节奏、登录与风控即停等边界不变。
- 当前搜索页已有关键词时绝不覆盖；缺少初始关键词时不导航。
- 搜索页准备失败不得把已完成的简历分析、匹配卡或本地筛选方案标为失败。
- 不新增依赖、服务、前端框架或通用抽象。

---

### Task 1: Initial search-page preparation policy

**Files:**
- Create: `src/application/onboarding/initial_search_page.js`
- Create: `tests/initial_search_page_smoke.js`
- Modify: `tests/run_all.js`

- [x] **Step 1:** 写失败测试，覆盖关键词优先级、保留当前筛选参数、移除翻页参数、已有关键词零导航和固定标签页异常零导航。
- [x] **Step 2:** 实现最小准备模块，复用 `inspectBossOperatorTabs`、`buildBossSearchUrl` 和 `BossSiteAdapter.navigateWithPacing`。
- [x] **Step 3:** 运行新 smoke test，确认只在满足合同的固定搜索页上导航一次。

### Task 2: Onboarding completion wiring

**Files:**
- Modify: `src/dashboard/server.js`
- Modify: `tests/onboarding_progress_ui_smoke.js`

- [x] **Step 1:** 写失败测试，证明简历子进程正常完成后触发一次准备，异常退出不触发，准备失败不改变 onboarding 完成状态。
- [x] **Step 2:** 在 Dashboard 的正常完成回调中读取该 run 的初始方案，串行进入既有浏览器只读队列并调用准备模块。
- [x] **Step 3:** 将准备失败收敛为脱敏 warning；上传和重试入口共用同一回调。
- [x] **Step 4:** 运行 onboarding、浏览器固定页、访问额度和新准备模块的定向回归。

### Task 3: Verification and handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-09-01-initial-keyword-search-preparation.md`
- Modify: `docs/PROJECT_HANDOFF.md`

- [x] **Step 1:** 运行完整 `npm test`，记录当前实际离线检查总数。
- [x] **Step 2:** 运行 `git diff --check` 和 `git status`，复核不含真实用户数据、日志或安装产物。
- [x] **Step 3:** 提交实现与文档；在精确提交上重新运行风险相称的最终验证。
- [x] **Step 4:** 未经用户再次授权不推送、不合并、不重打安装包。
