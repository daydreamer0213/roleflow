# Zhaopin Live Search Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复真实用户路径中“准备搜索页”抢先判错，以及新版智联搜索页明明有完整 JD 却无法读出身份字段的问题。

**Architecture:** 仅按已见真实结构扩展现有智联搜索快照；等待导航/关闭的实际结果，不以一次旧 tab 列表认定失败。保留原路径、筛选条件与完整身份核验。

**Tech Stack:** 原生 Node.js、既有 Edge/CDP contract、Playwright 合成页面与 HTTP 测试。

## Global Constraints

- 基于当前真实 DOM 补兼容，不放宽岗位身份、完整 JD、平台条件和同窗后台边界。
- 不引入依赖，不访问真实平台进行常规测试，不改 BOSS 行为或固定页规则。
- 默认保留用户已设原生条件；已有非空关键词不静默改写；准备空搜索时使用当前方案第一个关键词。
- 任何导航最多发出一次；后续等待只能只读检查状态。页面丢失/错窗/活动页改变/风控或登录立即停止。
- 不推送、合并、打包、发布、更改版本，保留并适配其他任务修改。

## Task 1: 新版搜索结构与导航就绪

**Files:**
- Modify: `src/adapters/sites/zhaopin.js`
- Modify narrowly: `src/dashboard/server.js` (`prepareZhaopinSearch`, plus its `/api/platform-search/open` caller solely to propagate request cancellation)
- Modify: `tests/zhaopin_readonly_smoke.js`, `tests/dashboard_zhaopin_smoke.js`
- Create fixture: `tests/fixtures/zhaopin/search-current.html`

**Evidence:** 主控用产品“准备智联搜索页”按钮从推荐页发起导航，页面立刻提示不是有效搜索页；稍后真实原 tab 已到 `jobs/?pageMode=search&kw=AI应用开发`。实际 `readSearchState` 返回 20 cards 和正文，却 keyword/title/company/salary/location/url 为空。当前 `.job-detail-summary` 在 `.job-detail-panel .job-detail-modules` 下、位于 `.job-detail-card` 外；输入框 `.query-sug__input`；meta 为 `.job-detail-summary__tags li`；公司 `.job-detail-summary__company-name` 或同面板 `.job-company-info__name`；岗位链接 `.job-company-info__view-all`。正文仍在该面板的“职位描述”卡片 `.job-detail-card__body`，页面同时有多张同类卡，必须限定描述卡而非任意拼接。

**Interfaces:** Existing `readSearchState`, `waitForSearchReady`, `readVisiblePaneDetail`, `prepareZhaopinSearch` return contracts unchanged. Snapshot may carry structural readiness fields internally; adapters continue enforcing keyword/template/selected-card identity. Browser ids accept existing adapter's supported numeric or string type consistently (no hardcoded numeric conversion in generic scan path).

- [x] **Step 1: Add RED regressions reproducing both real failures.** New fixture represents current sibling summary + multiple JD cards, synthetic data, current keyword input and tags/company/url. Real reader must produce correct title/company/salary/location/experience/education/description and exact sourceId; a decoy related job/title/company/link in a separate panel must not be included. Preserve old fixture coverage for previous supported layout. Full-card location “合成市 甲区” versus summary “合成市·甲区” is equivalent punctuation only, not a license to accept another city.

```js
const state = await adapter.readSearchState('ZHAOPIN-SEARCH');
assert.equal(state.keyword, '合成关键词');
assert.equal(state.detail.title, '当前结构合成岗位');
assert.equal(state.detail.company, '合成甲公司');
assert.equal(state.detail.location, '合成市·甲区');
assert.equal(state.detail.sourceId, 'CCSYNTH001J00000000001');
```

In HTTP fake browser, `navigate` returns while `listTabs` still gives old URL for two reads, then desired URL. POST open succeeds after observing matching background target, and navigation call count is 1. Also cover created tab returning string identifier from Edge adapter where listTabs supplies numeric id, delayed visibility/closing, wrong window/active tab, actual same-host wrong keyword, old URL never changes -> specific timeout (inject sleep/time if needed, not real long sleep). No duplicate tab creation or attempted foreground recovery.

- [x] **Step 2: Implement minimal compatibility.** For current layout read one `.job-detail-panel` tied to selected card; fall back to legacy `.job-detail-card` only when no current panel exists. Read title/salary/meta and company from the same panel. In current meta map first location tag + identifiable experience/education. Client company semantics remain distinct; don't swap publisher/client fields. The same panel's trusted detail link must match selected position data (where the actual current component exposes it) and title/salary/company/location checks remain effective.

```js
const panel = document.querySelector('.job-detail-panel');
const root = panel || document.querySelector('.job-detail-card');
const keywordInput = document.querySelector('.query-sug__input, .search-keyword-input, input[aria-label*="搜索"]');
```

Readiness uses actual list/pane data and visible loaders, not the global document `complete` flag or existence of hidden loading nodes. Preserve skeleton/content-drift rejection; add a narrow bounded ready check rather than changing pacing to accelerate access. Bump the injected helper version so a previous session's `window.__zhaopinReadSearchState` does not silently retain stale selectors after service update. Do not put selectors or page JS in server.js.

Fresh read-only evidence also confirms current `JobCard.$props.job.number`, `job.name`, `job.companyName` and summary `JobDetailSummary.$props.jobDetail.detailedPosition` / computed `position.number`. Expose a validated alphanumeric `card.sourceId` when present, and require the selected current card's sourceId and summary's sourceId (when supplied by this observed current layout) to equal the trusted link's id. Legacy fixtures without Vue state retain the existing title/company/salary/location + trusted link contract; do not fake a sourceId from list position or title. Add a current-layout mismatch fixture that fails even with equal titles. Read only these whitelisted fields; never serialize the entire platform job object.

After one navigate/create in `prepareZhaopinSearch`, poll the existing browser for that target committing to the expected canonical URL/keyword while checking same-window and unchanged active baseline. Target may be about:blank/previous URL transiently; an unrelated committed URL fails. Use bounded cancellation-friendly shared wait conventions; requested deadline 120000 ms, read interval 500 ms; injectable clock/sleep for tests. A failed create must clean only an attributable new tab and verify closure; never close an existing user search tab on timeout. Preserve all recognized native filters and reject unsupported params.

Cancellation must originate from the open request and reach this wait. Use the existing local request/response lifecycle or a native AbortController, not a new queue/controller framework. Normal completion of a POST request body must not be mistaken for cancellation. Check cancellation before browser work and before/after waits; if it occurs after creating an owned tab, perform only the required bounded ownership-checked cleanup. Keep `/save` behavior and unrelated browser operations unchanged.

- [x] **Step 3: Run focused GREEN regression.**

```powershell
$env:NODE_PATH='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
$env:ROLEFLOW_REQUIRE_PLAYWRIGHT='1'
$env:TEMP='D:/DevData/RoleFlow-tests'; $env:TMP=$env:TEMP
D:/hermes/node/node.exe tests/zhaopin_readonly_smoke.js
D:/hermes/node/node.exe tests/dashboard_zhaopin_smoke.js
D:/hermes/node/node.exe tests/zhaopin_workflow_smoke.js
D:/hermes/node/node.exe tests/zhaopin_analysis_smoke.js
git diff --check
```

Expected exit 0. Known SQLite ExperimentalWarning retained. Main runs full suite after all phase work; don't repeat it here.

- [x] **Step 4: Commit and independent review.** Stage owned files only, report RED/GREEN commands/output, exact SHA, remaining live assumptions. Main rechecks product prepare/save/start against real search after code freeze; successful synthetic fixture isn't real account acceptance.

Task review complete at `6163af63e19cd04a76a0838bcdf58d9998331884`: original 4 focused checks passed; fix round 1 added RED/GREEN for target disappearance, ownership conflict, hidden ancestor loader and request cancellation. Scoped re-review closed all four findings with no new Critical/Important. Full-phase gate and actual prepare/save/start remain pending.
