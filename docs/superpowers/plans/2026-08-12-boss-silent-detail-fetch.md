# BOSS Silent Detail Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用固定 BOSS 搜索页的同源只读详情请求替代不可靠的后台 UI 切岗，并保持身份、隐私、访问预算、恢复与检查点合同。

**Architecture:** 页面 helper 在浏览器上下文内持有 `securityId/lid` 并执行一次 GET，Node 只轮询净化状态。扫描仍沿用现有详情公平分配、限速、结果审计和 checkpoint；不提供 UI 或独立详情页自动回退。

**Tech Stack:** Node.js 22、CommonJS、Edge Control/CDP Runtime.evaluate、SQLite、现有 assert smoke tests

## Global Constraints

- 不执行沟通、消息发送或投递。
- 不激活 Edge，不新建窗口/标签，不调用 `bringToFront/clickAt/navigate`。
- `securityId/lid/Cookie/完整请求 URL/原始响应` 不得离开页面上下文。
- 每岗位最多一次详情 GET；失败关闭，不自动重试或回退。
- 不降低卡片覆盖、JD 完整性、身份校验、限速、风控或检查点。
- Wave 5 保持暂停。

---

### Task 1: Add the page-local sanitized detail fetch state machine

**Files:**
- Modify: `src/adapters/sites/boss.js`
- Modify: `tests/source_acquisition_smoke.js`

**Interfaces:**
- Produces page helpers:
  - `__bossStartDetailFetch(jobId)`
  - `__bossDetailFetchState(jobId)`
  - `__bossConsumeDetailFetch(jobId)`
  - `__bossCancelDetailFetch(jobId)`
- Produces adapter method:
  - `readSearchPageApiDetail(tabId, job, signal, assertTabBindings)`

- [ ] Add focused RED coverage proving the current adapter has no sanitized API detail path and still depends on `clickAt`.
- [ ] Add helper-state fake-browser coverage for exact card/Vue/response identity, one request, running de-duplication, terminal consume and abort cleanup.
- [ ] Implement the minimum helper state machine. Keep `securityId/lid` inside the page closure.
- [ ] Implement adapter polling with existing stop/tab/search/login/risk checks.
- [ ] Return only sanitized detail fields; validate HTTP 200, code 0, response ID and JD≥120.
- [ ] Run:

```powershell
& 'D:\Guo\ZhiPing\.runtime\node\node.exe' tests\source_acquisition_smoke.js
& 'D:\Guo\ZhiPing\.runtime\node\node.exe' tests\browser_transport_smoke.js
git diff --check
```

- [ ] Commit:

```powershell
git add src/adapters/sites/boss.js tests/source_acquisition_smoke.js
git commit -m "feat: read BOSS details through sanitized page fetch"
```

### Task 2: Add the independent access action and scan integration

**Files:**
- Modify: `src/core/product_policy.js`
- Modify: `src/core/site_access_budget.js`
- Modify: `src/core/site_access_usage.js`
- Modify: `src/adapters/sites/boss.js`
- Modify: `tests/site_access_budget_smoke.js`
- Modify: `tests/site_access_usage_smoke.js`
- Modify: `tests/boss_safe_pacing_smoke.js`
- Modify: `tests/source_acquisition_smoke.js`

**Interfaces:**
- Produces access action `job_detail_fetch`.
- Produces detail result `accessMode: "search_page_api"`.

- [ ] Write RED tests for the missing action, missing normal/recovery limits and missing detail-usage classification.
- [ ] Copy the exact current `pane_detail_read` normal/recovery limits to `job_detail_fetch`; keep existing pacing wait ranges unchanged.
- [ ] Sanitize reservation details to `{ jobId }` only.
- [ ] Include `job_detail_fetch` in detail-access usage.
- [ ] Route the scan detail loop exclusively to `readSearchPageApiDetail()`.
- [ ] Assert 0 calls to `bringToFront/clickAt/navigate/createTab` in ordinary scans.
- [ ] Preserve success/failure checkpoint, micro/macro cooldown and fatal-stop behavior.
- [ ] Run:

```powershell
& 'D:\Guo\ZhiPing\.runtime\node\node.exe' tests\site_access_budget_smoke.js
& 'D:\Guo\ZhiPing\.runtime\node\node.exe' tests\site_access_usage_smoke.js
& 'D:\Guo\ZhiPing\.runtime\node\node.exe' tests\boss_safe_pacing_smoke.js
& 'D:\Guo\ZhiPing\.runtime\node\node.exe' tests\source_acquisition_smoke.js
git diff --check
```

- [ ] Commit:

```powershell
git add src/core/product_policy.js src/core/site_access_budget.js src/core/site_access_usage.js src/adapters/sites/boss.js tests/site_access_budget_smoke.js tests/site_access_usage_smoke.js tests/boss_safe_pacing_smoke.js tests/source_acquisition_smoke.js
git commit -m "feat: route BOSS scans through silent detail fetch"
```

### Task 3: Full review, verification and live calibration

**Files:**
- Update after evidence: `docs/superpowers/reports/2026-08-11-wave-0-4-live-manual-acceptance-addendum.md`
- Update ignored ledger: `.superpowers/sdd/2026-08-11-wave4-acceptance-remediation/progress.md`

- [ ] Run independent task review after each implementation task.
- [ ] Run final whole-branch privacy/security review.
- [ ] Run `npm.cmd test`; require all registered offline checks.
- [ ] Merge only after review is clean and the merged main suite passes.
- [ ] Create a fresh D-drive calibration baseline.
- [ ] Run 1 keyword with at most 3 detail reads through a hidden process.
- [ ] Require 3/3 exact API IDs, JD≥120, no UI mutation, no Edge foreground activation and no token persistence.
- [ ] If calibration passes, create another fresh formal Gate D baseline and run the complete daily scan.
- [ ] Export the fixed Gate D artifacts exactly once only after a terminal complete scan.

