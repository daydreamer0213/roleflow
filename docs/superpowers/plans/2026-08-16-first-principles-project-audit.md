# RoleFlow 第一性原则项目审计与精简 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从已确认设计提交 `e8d3eb2` 出发，封闭正式产品中的实验详情模式入口，恢复扫描状态文字，删除逐项证明无现行职责的代码，并把孤立测试的独有薪资边界覆盖迁入正式测试入口。

**Architecture:** 保留 `search_page_api` 的内部研究实现和历史快照结构，在 `scan_execution` 的产品边界增加一个窄校验器，由 CLI 参数组装、CLI 扫描入口和恢复校验复用；Dashboard 在进入子进程前使用同一校验器。扫描状态文字移入已有 today view model，不新建模块。死代码按已确认语义清单原地删除，不拆分 Dashboard、CLI 或 BOSS 适配器。

**Tech Stack:** Node.js CommonJS、`node:assert` 离线 smoke tests、`node:sqlite`、PowerShell、Git。

## Global Constraints

- `e8d3eb2` 必须是实施分支的祖先，其父提交是 `d50874166dde550e3fda2fe1b8eb235efecc7677`；允许其上只有本实施计划及其基线纠正文档提交。发现其他提交或未提交修改时先停止并核对归属。
- 执行前使用 `using-git-worktrees` 检查或建立独立的 `codex/first-principles-audit` 分支/worktree；不得直接在 `main` 上实施。
- 不访问真实 BOSS，不读取现有登录页面，不执行任何沟通、发送、申请或其他外部写。
- 正式岗位详情路径只允许 `trusted_pane`；保留 `search_page_api` 的研究实现、历史快照识别和失败证据，但不修复、不优化、不校准、不进入其适配器分支。
- 不使用或重新引入 `standalone_detail`。
- 保留用户主动运行 `start-workspace.ps1` 且未指定 `-NoOpen` 时的一次性 `Page.bringToFront` 引导；扫描、JD、分析、消息、沟通、轮询、重试和恢复路径调用次数必须为 0。
- 保留 BOSS 随机节奏、周期冷却、访问预算、checkpoint、风控即停、页面丢失即停和不确定结果不重试。
- 不降低卡片覆盖、JD 覆盖、召回、推荐质量或恢复语义；不使用旧数据库评价筛选质量。
- 不删除存储兼容门面、迁移、恢复、发布、安装、诊断、安全或质量基准代码。
- 不新增依赖、框架、通用抽象层或大文件拆分；只修改本计划列出的文件。
- 当前机器安装了 360；`tests/startup_scripts_smoke.js` 会动态生成未签名的 `msedge.exe` 测试桩并被安全软件拦截。本轮不得运行、放行或绕过该测试，不得修改其阈值或削弱启动身份校验。执行其余 96 项注册离线检查，并保留更早 beta.4.x 的完整 97 项通过记录作为历史证据；报告中必须明确区分 97 项注册、96 项本轮通过和 1 项安全软件阻断。
- 每个任务先运行对应离线检查，再提交；不自动推送、合并、发布。

---

## File Map

### 会修改

- `src/core/scan_execution.js`：保留研究模式解析，同时增加正式产品只允许 `trusted_pane` 的校验接口。
- `src/core/scan_resume.js`：在读取历史执行快照时拒绝恢复 `search_page_api`。
- `src/cli.js`：正式 CLI 扫描在读取模型、计划或浏览器前拒绝实验详情模式；删除旧关键词解析死代码。
- `src/dashboard/server.js`：Dashboard 扫描入口拒绝实验详情模式；删除已迁移的遗留 helper 和无用 import。
- `src/dashboard/view_models/today.js`：接管扫描状态文字职责。
- `src/adapters/models/mock.js`：删除已被 hiring-track 契约替代的级别猜测函数。
- `src/adapters/sites/boss.js`：删除两个已被当前合并/沟通核验流程替代的函数及其孤立常量；不触碰 `search_page_api` 实现。
- `src/core/job_analysis.js`：删除不再进入稀疏模型输入的简历版本转换及其专用清洗 helper。
- `src/core/profile_schema.js`：删除模型画像中已禁用的简历版本归一化及其专用 slug helper。
- `src/reports/render.js`：删除四档推荐上线后不再显示的数值置信度 formatter。
- `tests/self_check.js`：用本地固定 greeting fixture 取代旧 `src/core/llm.js`。
- `tests/scan_execution_smoke.js`：覆盖研究模式仍可识别、产品模式明确拒绝。
- `tests/scan_recovery_smoke.js`：覆盖历史 `search_page_api` 批次不可恢复且原快照不被改写。
- `tests/cli_model_settings_root_smoke.js`：覆盖 CLI 在浏览器 seam 之前拒绝实验模式。
- `tests/dashboard_scan_lifecycle_smoke.js`：覆盖 Dashboard 子进程组装层不生成实验模式命令。
- `tests/workflow_dashboard_smoke.js`：覆盖 HTTP 入口返回 409 且不启动子进程。
- `tests/today_dashboard_smoke.js`：覆盖所有扫描状态文字和页面输出。
- `tests/screening_quality_smoke.js`：接收六个独有低薪硬边界用例。
- `docs/PROJECT_HANDOFF.md`：在全部验证通过后记录本地主线、课题 1 完成状态和下一课题。
- `docs/NEXT_PHASE.md`：把课题 1 标为已完成，把逐岗位进度标为下一份设计。

### 会删除

- `src/adapters/browser/index.js`：从初始提交起没有生产、测试、脚本或静态入口。
- `src/core/llm.js`：早期通用招呼语模板，仅剩旧自检消费者，生产沟通已经使用双侧证据契约。
- `tests/analysis_revision_smoke.js`：未注册、未间接加载；迁移六个独有薪资断言后无剩余独有价值。

### 明确保留

- `src/adapters/browser/edge_control.js`、`src/adapters/browser/cdp.js`、`src/core/workspace_tabs.js`：保留启动引导能力。
- `src/adapters/sites/boss.js` 中的 `search_page_api` 研究分支和失败证据。
- `src/dashboard/assets/workflow.js`：HTTP 静态资源，不按 CommonJS 依赖图删除。
- `tests/four_tier_decision_smoke.js`：由 `tests/self_check.js` 间接执行。
- `src/core/storage.js` 和各 storage facade/migration。

---

### Task 1: 封闭正式产品的 `search_page_api` 入口

**Files:**

- Modify: `src/core/scan_execution.js:9-15,29-50,247-252`
- Modify: `src/core/scan_resume.js:1-76`
- Modify: `src/cli.js:100,748-770,909-917`
- Modify: `src/dashboard/server.js:149,1385-1444`
- Test: `tests/scan_execution_smoke.js:1-137`
- Test: `tests/scan_recovery_smoke.js:84-111`
- Test: `tests/cli_model_settings_root_smoke.js:1-170`
- Test: `tests/dashboard_scan_lifecycle_smoke.js:49-160`
- Test: `tests/workflow_dashboard_smoke.js:1336-1351`

**Interfaces:**

- Consumes: existing `resolveDetailMode(value)` compatibility parser, existing `buildScanCliArgs(input)`, `validateResumeBatch(input)`, `scan(db, args, deps)`.
- Produces: `resolveProductDetailMode(value): "trusted_pane"`; throws `PRODUCT_DETAIL_MODE_UNSUPPORTED` with HTTP-compatible `statusCode = 409` for `search_page_api`; preserves `resolveDetailMode("search_page_api") === "search_page_api"` for historical/research evidence.

- [ ] **Step 1: Write the failing core boundary tests**

Update the import and add `productDetailModeSmoke()` to `tests/scan_execution_smoke.js`:

```js
const {
  resolveScanKind,
  resolveDetailMode,
  resolveProductDetailMode,
  buildScanCliArgs,
  withSiteScanLease
} = require("../src/core/scan_execution");

function productDetailModeSmoke() {
  assert.strictEqual(resolveDetailMode("search_page_api"), "search_page_api", "研究/历史模式标识必须保留");
  assert.strictEqual(resolveProductDetailMode(undefined), "trusted_pane");
  assert.strictEqual(resolveProductDetailMode("trusted_pane"), "trusted_pane");
  assert.throws(
    () => resolveProductDetailMode("search_page_api"),
    (error) => error.code === "PRODUCT_DETAIL_MODE_UNSUPPORTED"
      && error.statusCode === 409
      && /trusted_pane/.test(error.message)
  );
}
```

Call `productDetailModeSmoke()` immediately after `scanKindSmoke()`. Replace the existing successful `buildScanCliArgs(... detailMode: "search_page_api")` assertion with:

```js
assert.throws(
  () => buildScanCliArgs({ ...common, kind: "daily", browserMode: "edge", detailMode: "search_page_api" }),
  (error) => error.code === "PRODUCT_DETAIL_MODE_UNSUPPORTED" && error.statusCode === 409
);
```

- [ ] **Step 2: Write the failing CLI, Dashboard, and recovery tests**

In `tests/cli_model_settings_root_smoke.js`, immediately after the existing `stubDb` definition and before the force-mock browser-seam assertion, add:

```js
let unsupportedModeBrowserCalls = 0;
await assert.rejects(
  () => cli.scan(stubDb, {
    input: "synthetic-input.json",
    "force-mock": true,
    keywords: "test-keyword",
    "detail-mode": "search_page_api"
  }, {
    createBrowser() {
      unsupportedModeBrowserCalls += 1;
      throw new Error("browser seam must not be reached");
    }
  }),
  (error) => error.code === "PRODUCT_DETAIL_MODE_UNSUPPORTED" && /trusted_pane/.test(error.message)
);
assert.strictEqual(unsupportedModeBrowserCalls, 0, "CLI 必须在初始化浏览器前拒绝研究模式");
```

In `tests/dashboard_scan_lifecycle_smoke.js`, replace the controlled pass-through block with:

```js
const controlledCalls = [];
assert.throws(
  () => startPlanScan(new Map(), {
    db: database,
    root,
    dbPath,
    planId: 152,
    scanKind: "daily",
    detailMode: "search_page_api",
    logger,
    requestId: "request-controlled-detail-mode",
    spawnProcess: spawnHarness(database, 152, controlledCalls)
  }),
  (error) => error.code === "PRODUCT_DETAIL_MODE_UNSUPPORTED" && error.statusCode === 409
);
assert.strictEqual(controlledCalls.length, 0, "研究模式不得生成扫描子进程");
```

In `tests/workflow_dashboard_smoke.js`, replace the 303/pass-through expectation with:

```js
const spawnCountBeforeControlledApiScan = spawns.length;
const controlledApiScan = await postForm(baseUrl, "/api/scan", {
  planId: portableScanSaved.planId,
  browserMode: "edge",
  scanKind: "broad",
  detailMode: "search_page_api"
});
assert.strictEqual(controlledApiScan.status, 409);
assert.match(controlledApiScan.body, /PRODUCT_DETAIL_MODE_UNSUPPORTED/);
assert.match(controlledApiScan.body, /trusted_pane/);
assert.strictEqual(spawns.length, spawnCountBeforeControlledApiScan, "HTTP 拒绝后不得启动子进程");
```

In `tests/scan_recovery_smoke.js`, import `validateResumeBatch` and extend `detailModeSnapshotRecoverySmoke()` after building the historical API snapshot:

```js
assert.throws(
  () => validateResumeBatch({
    resumeBatchId: 88,
    resumedBatch: {
      id: 88,
      site: "boss",
      searchPlanId: 77,
      status: "interrupted",
      filterSnapshot: { execution: snapshot }
    },
    site: "boss",
    planId: 77
  }),
  (error) => error.code === "PRODUCT_DETAIL_MODE_UNSUPPORTED"
    && error.statusCode === 409
    && /新建 trusted_pane 扫描/.test(error.message)
);
assert.strictEqual(snapshot.detailMode, "search_page_api", "拒绝恢复不得改写历史证据");
```

- [ ] **Step 3: Run the focused tests and verify the new assertions fail**

Run:

```powershell
node tests/scan_execution_smoke.js
node tests/cli_model_settings_root_smoke.js
node tests/dashboard_scan_lifecycle_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/scan_recovery_smoke.js
```

Expected: at least the first command fails because `resolveProductDetailMode` is not exported; the remaining changed tests fail on the former pass-through behavior. No command may open BOSS.

- [ ] **Step 4: Implement the central product-mode guard**

Add this next to `resolveDetailMode` in `src/core/scan_execution.js`:

```js
function resolveProductDetailMode(value) {
  const normalized = resolveDetailMode(value);
  if (normalized === "trusted_pane") return normalized;
  throw scanExecutionError(
    "PRODUCT_DETAIL_MODE_UNSUPPORTED",
    "search_page_api 是保留的研究模式，正式扫描不能使用；请新建 trusted_pane 扫描。",
    409
  );
}
```

Change the invalid-mode throw to pass `409`, change `buildScanCliArgs` to call `resolveProductDetailMode(detailMode)`, export the new function, and extend the error helper without changing other callers:

```js
function scanExecutionError(code, message, statusCode = null) {
  const error = new Error(message);
  error.code = code;
  if (statusCode !== null) error.statusCode = statusCode;
  return error;
}
```

- [ ] **Step 5: Wire the guard into recovery, CLI, and Dashboard**

In `src/core/scan_resume.js`, import `resolveProductDetailMode` and call it inside the existing `try` before acquisition-mode validation:

```js
resolveProductDetailMode(storedSnapshot.detailMode);
```

In `src/cli.js`, import `resolveProductDetailMode` instead of `resolveDetailMode`. At the beginning of `scan()`, immediately after `assertScanActive(signal)`, add:

```js
const requestedDetailMode = Object.hasOwn(args, "detail-mode")
  ? resolveProductDetailMode(args["detail-mode"])
  : null;
```

Remove the later redeclaration and resolve stored snapshots defensively:

```js
const detailMode = storedExecution
  ? resolveProductDetailMode(storedExecution.detailMode)
  : (requestedDetailMode || "trusted_pane");
```

In `src/dashboard/server.js`, import `resolveProductDetailMode` beside `buildScanCliArgs` and replace the ternary parser with:

```js
const detailMode = params.detailMode
  ? resolveProductDetailMode(params.detailMode)
  : null;
```

Do not modify `src/core/scan_snapshot.js`, the historical snapshot assertions in `tests/scan_snapshot_smoke.js`, or any `search_page_api` adapter code.

- [ ] **Step 6: Run the focused boundary tests**

Run the five commands from Step 3 plus:

```powershell
node tests/scan_snapshot_smoke.js
node tests/workspace_tabs_smoke.js
```

Expected: all pass. `scan_snapshot_smoke` proves the historical mode remains representable; `workspace_tabs_smoke` proves the startup focus exception remains intact.

- [ ] **Step 7: Commit the boundary change**

```powershell
git add -- src/core/scan_execution.js src/core/scan_resume.js src/cli.js src/dashboard/server.js tests/scan_execution_smoke.js tests/scan_recovery_smoke.js tests/cli_model_settings_root_smoke.js tests/dashboard_scan_lifecycle_smoke.js tests/workflow_dashboard_smoke.js
git commit -m "fix: enforce trusted pane product scans"
```

---

### Task 2: 恢复扫描状态文字职责

**Files:**

- Modify: `src/dashboard/view_models/today.js:1-127`
- Modify: `src/dashboard/server.js:4124-4145`
- Test: `tests/today_dashboard_smoke.js:1-120`

**Interfaces:**

- Consumes: existing scan run shape `{ state, kind, error }` and `plan.bossActiveDays`.
- Produces: `scanLabel(run, bossActiveDays): string`, exported by `view_models/today.js`; `buildTodayViewModel(input).run.label` always derives from `input.run` and no longer depends on an unpassed `input.runLabel`.

- [ ] **Step 1: Add the failing status matrix and page assertion**

Import `scanLabel` in `tests/today_dashboard_smoke.js`, call `assertScanStatusLabels()` before creating the database, and add:

```js
function assertScanStatusLabels() {
  const cases = [
    [{ state: "running", kind: "daily" }, "正在执行日常扫描"],
    [{ state: "completed", kind: "daily" }, "日常扫描已完成"],
    [{ state: "running", kind: "broad" }, "正在执行广泛扫描"],
    [{ state: "completed", kind: "broad" }, "广泛扫描已完成"],
    [{ state: "running", kind: "refresh" }, "正在补读待刷新岗位"],
    [{ state: "completed", kind: "refresh" }, "待刷新岗位补读完成"],
    [{ state: "running", kind: "activity" }, "正在更新超过 3 天有效期的招聘方活跃状态"],
    [{ state: "completed", kind: "activity" }, "招聘方活跃状态更新完成"],
    [{ state: "partial" }, "本次扫描部分完成，可查看诊断后继续"],
    [{ state: "failed" }, "扫描失败，请查看错误"],
    [{ state: "interrupted" }, "扫描已中断，可重新启动"],
    [{ state: "idle" }, "尚未运行"]
  ];
  for (const [run, expected] of cases) assert.strictEqual(scanLabel(run, 3), expected);

  const viewModel = buildTodayViewModel({
    plan: { bossActiveDays: 3 },
    run: { state: "running", kind: "daily", error: "" }
  });
  assert.strictEqual(viewModel.run.label, "正在执行日常扫描");
  assert.match(renderTodayPage(viewModel), /扫描状态：<\/strong>正在执行日常扫描/);
}
```

Extend the storage import with `createScanRun` and `finishScanRun`. After `assertReadyTodayPage(...)`, persist a completed daily run and verify the real HTTP page uses that state:

```js
const persistedRun = createScanRun(db, {
  runId: "today-persisted-scan",
  site: "boss",
  command: "daily",
  planId: ready.planId
});
finishScanRun(db, { runId: persistedRun.runId, status: "completed" });
await assertPersistedScanStatusPage(baseUrl, ready);
```

Add the integration assertion:

```js
async function assertPersistedScanStatusPage(baseUrl, saved) {
  const page = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /扫描状态：<\/strong>日常扫描已完成/);
  assert.doesNotMatch(page.body, /扫描状态：<\/strong>尚未运行/);
}
```

- [ ] **Step 2: Run the test and verify it fails on the missing export**

Run: `node tests/today_dashboard_smoke.js`

Expected: FAIL because `scanLabel` is not exported from the view model; before implementation, `buildTodayViewModel(...).run.label` also remains `尚未运行`.

- [ ] **Step 3: Move the exact responsibility into the view model**

Import `PRODUCT_POLICY` in `src/dashboard/view_models/today.js`, replace the `run` output with:

```js
run: {
  state: String(input.run?.state || "idle"),
  label: scanLabel(input.run, plan.bossActiveDays),
  error: String(input.run?.error || "")
},
```

Move the existing server logic into this pure view-model helper and export it:

```js
function scanLabel(run = {}, bossActiveDays = PRODUCT_POLICY.searchPlan.defaultBossActiveDays) {
  if (run.state === "running" && run.kind === "daily") return "正在执行日常扫描";
  if (run.state === "completed" && run.kind === "daily") return "日常扫描已完成";
  if (run.state === "running" && run.kind === "broad") return "正在执行广泛扫描";
  if (run.state === "completed" && run.kind === "broad") return "广泛扫描已完成";
  if (run.state === "running" && run.kind === "refresh") return "正在补读待刷新岗位";
  if (run.state === "completed" && run.kind === "refresh") return "待刷新岗位补读完成";
  if (run.state === "running" && run.kind === "activity") return `正在更新超过 ${bossActiveDays} 天有效期的招聘方活跃状态`;
  if (run.state === "completed" && run.kind === "activity") return "招聘方活跃状态更新完成";
  return {
    idle: "尚未运行",
    running: "扫描中",
    completed: "本次扫描已完成",
    partial: "本次扫描部分完成，可查看诊断后继续",
    failed: "扫描失败，请查看错误",
    interrupted: "扫描已中断，可重新启动"
  }[run.state] || "尚未运行";
}
```

Delete only the old `scanLabel` definition from `src/dashboard/server.js`. Do not change `scanStatus`, scan state values, persistence, polling, budgets, or execution code.

- [ ] **Step 4: Run focused Dashboard tests**

```powershell
node tests/today_dashboard_smoke.js
node tests/dashboard_scan_lifecycle_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: all pass, and the today-page test proves a completed persisted daily scan no longer renders as `尚未运行`.

- [ ] **Step 5: Commit the responsibility migration**

```powershell
git add -- src/dashboard/view_models/today.js src/dashboard/server.js tests/today_dashboard_smoke.js
git commit -m "fix: restore scan status labels"
```

---

### Task 3: 删除完成语义证明的死代码

**Files:**

- Delete: `src/adapters/browser/index.js`
- Delete: `src/core/llm.js`
- Modify: `tests/self_check.js:7,157-162`
- Modify: `src/adapters/models/mock.js:392-397`
- Modify: `src/adapters/sites/boss.js:2678-2688,2877,2897-2903`
- Modify: `src/cli.js:2633-2644`
- Modify: `src/core/job_analysis.js:737-759`
- Modify: `src/core/profile_schema.js:145-156,208`
- Modify: `src/dashboard/server.js:96,866-883,3975-3996,4062,4124-4126`
- Modify: `src/reports/render.js:138-140`

**Interfaces:**

- Consumes: Task 1 product boundary and Task 2 `scanLabel` migration already committed.
- Produces: no new runtime interface; all supported imports and exports stay unchanged. `tests/self_check.js` owns a fixed local greeting string instead of importing a production module.

- [ ] **Step 1: Reconfirm the exact deletion boundary before editing**

Run this occurrence audit:

```powershell
$checks = @(
  @('inferSeniority','src/adapters/models/mock.js'),
  @('dedupeJobs','src/adapters/sites/boss.js'),
  @('sanitizeCommunicationObservation','src/adapters/sites/boss.js'),
  @('resolveKeywords','src/cli.js'),
  @('resumeVersionsForJobMatch','src/core/job_analysis.js'),
  @('normalizeResumeVersion','src/core/profile_schema.js'),
  @('createUploadedMatchingCardDraft','src/dashboard/server.js'),
  @('workflowStatusLabel','src/dashboard/server.js'),
  @('workflowShortfallLabel','src/dashboard/server.js'),
  @('hardBlockerLabels','src/dashboard/server.js'),
  @('keywordLines','src/dashboard/server.js'),
  @('formatConfidence','src/reports/render.js')
)
foreach ($check in $checks) {
  $hits = @(rg -n -w $check[0] $check[1])
  if ($hits.Count -ne 1) { throw "$($check[1])::$($check[0]) changed: $($hits.Count) occurrences" }
}
rg -n 'adapters/browser/index|core/llm|createGreeting|BrowserAdapter|PlaywrightAdapter' src tests scripts package.json
```

Expected: each function name appears once in its owning file; `src/core/llm.js` is referenced only by `tests/self_check.js`; `src/adapters/browser/index.js` has no consumer. If any count differs, stop this task and reclassify that candidate rather than broadening the deletion.

- [ ] **Step 2: Establish the existing characterization-test baseline**

```powershell
node tests/self_check.js
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/source_acquisition_smoke.js
node tests/communication_executor_smoke.js
node tests/onboarding_run_smoke.js
node tests/today_dashboard_smoke.js
node tests/screening_quality_smoke.js
```

Expected: all pass before deletion. These are characterization tests; this refactor does not need source-text-presence tests.

- [ ] **Step 3: Replace the obsolete self-check dependency and delete the two modules**

Remove `createGreeting` from `tests/self_check.js` and replace its call with a neutral, local fixture:

```js
const greeting = "您好，我想进一步了解该岗位的职责和团队情况。";
```

Delete `src/core/llm.js` and `src/adapters/browser/index.js` with `apply_patch`. Do not delete `llm_analyzer.js`, `edge_control.js`, `cdp.js`, or either concrete adapter's `bringToFront` method.

- [ ] **Step 4: Delete only the approved function bodies and their proven cascades**

Apply these exact deletions:

| File | Delete | Companion cleanup after occurrence check |
|---|---|---|
| `src/adapters/models/mock.js` | `inferSeniority` | none; keep shared `hasAny` and `sameText` |
| `src/adapters/sites/boss.js` | `dedupeJobs`, `sanitizeCommunicationObservation` | delete `COMMUNICATION_OUTCOME_STATES`; keep `communicationOutcomeEvidence`, current classifiers, `mergeUniqueCards`, `mergeScanCandidate`, `mergeBossJobFacts` |
| `src/cli.js` | `resolveKeywords` | delete its now-isolated local `splitList`; keep `resolvePlannedKeywords` from `keyword_planner` |
| `src/core/job_analysis.js` | `resumeVersionsForJobMatch` | delete now-isolated `withoutSalaryPreference`; keep `candidateProfileForJobMatch` and matching-card input |
| `src/core/profile_schema.js` | `normalizeResumeVersion` | delete now-isolated `slug`; keep `resumeVersions: []` and candidate-store persistence |
| `src/dashboard/server.js` | `createUploadedMatchingCardDraft`, `workflowStatusLabel`, `workflowShortfallLabel`, `hardBlockerLabels`, `keywordLines` | remove only `buildCandidateMatchCard` from the `profile_onboarding` import; keep `createMatchingCardDraft`, `matchingCardFromProfile`, onboarding and today view-model imports |
| `src/reports/render.js` | `formatConfidence` | keep `recommendationLabel` and four-tier report output |

Do not touch any other pre-existing unused-import candidate in this task; the approved proof applies only to the table above.

- [ ] **Step 5: Run syntax and focused regression checks**

```powershell
$changedJs = @(
  'tests/self_check.js',
  'src/adapters/models/mock.js',
  'src/adapters/sites/boss.js',
  'src/cli.js',
  'src/core/job_analysis.js',
  'src/core/profile_schema.js',
  'src/dashboard/server.js',
  'src/reports/render.js'
)
foreach ($file in $changedJs) { node --check $file; if ($LASTEXITCODE -ne 0) { throw "syntax failed: $file" } }
node tests/self_check.js
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/source_acquisition_smoke.js
node tests/communication_executor_smoke.js
node tests/onboarding_run_smoke.js
node tests/today_dashboard_smoke.js
node tests/screening_quality_smoke.js
```

Expected: all pass. Also run:

```powershell
rg -n 'inferSeniority|dedupeJobs|sanitizeCommunicationObservation|resolveKeywords|resumeVersionsForJobMatch|normalizeResumeVersion|createUploadedMatchingCardDraft|hardBlockerLabels|formatConfidence' src
$serverHelpers = @(rg -n -w 'workflowStatusLabel|workflowShortfallLabel|keywordLines|scanLabel' src/dashboard/server.js)
if ($serverHelpers.Count) { throw "migrated helpers remain in server.js: $($serverHelpers -join '; ')" }
rg -n -w 'workflowStatusLabel|workflowShortfallLabel|keywordLines|scanLabel' src/dashboard/view_models src/dashboard/pages
```

Expected: the first search and `$serverHelpers` produce no stale definitions; the last search shows `workflowStatusLabel`, `workflowShortfallLabel`, `keywordLines`, and `scanLabel` only in their current view-model/page owners.

- [ ] **Step 6: Commit the proven deletions**

```powershell
git add -- src/adapters/browser/index.js src/core/llm.js tests/self_check.js src/adapters/models/mock.js src/adapters/sites/boss.js src/cli.js src/core/job_analysis.js src/core/profile_schema.js src/dashboard/server.js src/reports/render.js
git commit -m "refactor: remove proven dead code"
```

---

### Task 4: 迁移孤立测试的六个独有薪资边界

**Files:**

- Modify: `tests/screening_quality_smoke.js:421-430`
- Delete: `tests/analysis_revision_smoke.js`
- Verify only: `tests/semantic_pipeline_smoke.js`
- Verify only: `tests/inherited_search_scope_smoke.js`
- Verify only: `tests/self_check.js`

**Interfaces:**

- Consumes: existing `scoreJob`, `decisionState`, `decisionBucket`, `scopedConfigs`, `job()` and `completeApplyAnalysis()` in `screening_quality_smoke.js`.
- Produces: six registered strict-low-salary cases proving `5-6K`, `5-7K`, `6-7K`, `6-8K`, `7-8K`, and `8-8K` cannot enter `primary`、`apply` or `caution`.

- [ ] **Step 1: Establish both current test baselines**

```powershell
node tests/analysis_revision_smoke.js
node tests/screening_quality_smoke.js
```

Expected: both pass; the first is nevertheless absent from `tests/run_all.js` and has no external loader.

- [ ] **Step 2: Replace the single low-salary assertion with the six compact cases**

Replace the existing `strictLowSalary` block in `tests/screening_quality_smoke.js` with:

```js
for (const salary of ["5-6K", "5-7K", "6-7K", "6-8K", "7-8K", "8-8K"]) {
  const strictLowSalary = scoreJob(job({ experience: "0-3年", salary }), scopedConfigs);
  assert.strictEqual(decisionState(strictLowSalary), "blocked", `${salary} 低于期望下限时必须阻断`);
  assert(strictLowSalary.qualityTags.includes("salary_out_of_range"), `${salary} 必须保留低薪硬边界标签`);
  assert(!["primary", "apply", "caution"].includes(decisionBucket({
    ...strictLowSalary,
    analysis: completeApplyAnalysis()
  })), `${salary} 即使语义分析给出 apply 也不得进入候选清单`);
}
```

- [ ] **Step 3: Run the registered quality test before deleting the orphan**

Run: `node tests/screening_quality_smoke.js`

Expected: PASS with all six cases now owned by a registered test.

- [ ] **Step 4: Delete the orphan and verify remaining invariant owners**

Delete `tests/analysis_revision_smoke.js` with `apply_patch`, then run:

```powershell
node tests/screening_quality_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/inherited_search_scope_smoke.js
node tests/self_check.js
```

Expected: all pass. Revision staleness remains in `semantic_pipeline_smoke.js`; recommendation/acquisition hash separation remains in `inherited_search_scope_smoke.js`; four-tier indirect coverage remains in `self_check.js`.

- [ ] **Step 5: Audit all top-level test entries**

Run this read-only dependency audit:

```powershell
@'
const fs = require("node:fs");
const path = require("node:path");
const root = process.cwd();
const testDir = path.join(root, "tests");
const all = fs.readdirSync(testDir).filter((name) => name.endsWith(".js") && name !== "run_all.js");
const runAll = fs.readFileSync(path.join(testDir, "run_all.js"), "utf8");
const queue = [...runAll.matchAll(/"([^"]+\.js)"/g)].map((match) => match[1]);
const reached = new Set();
while (queue.length) {
  const name = queue.shift();
  if (reached.has(name)) continue;
  reached.add(name);
  const file = path.join(testDir, name);
  if (!fs.existsSync(file)) throw new Error(`missing registered test: ${name}`);
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/require\(["']\.\/([^"']+)["']\)/g)) {
    const dependency = match[1].endsWith(".js") ? match[1] : `${match[1]}.js`;
    if (fs.existsSync(path.join(testDir, dependency))) queue.push(dependency);
  }
}
const orphaned = all.filter((name) => !reached.has(name));
if (orphaned.length) throw new Error(`orphaned tests: ${orphaned.join(", ")}`);
if (!reached.has("four_tier_decision_smoke.js")) throw new Error("four-tier indirect entry missing");
console.log(`test-entry-audit ok: ${all.length} files`);
'@ | node
```

Expected: `test-entry-audit ok` and no orphan list.

- [ ] **Step 6: Commit the test consolidation**

```powershell
git add -- tests/screening_quality_smoke.js tests/analysis_revision_smoke.js
git commit -m "test: consolidate salary boundary coverage"
```

---

### Task 5: 全量离线验证和停止线检查

**Files:**

- Verify: all files changed by Tasks 1-4.
- Modify after full verification: `docs/PROJECT_HANDOFF.md:5-13,38-47`
- Modify after full verification: `docs/NEXT_PHASE.md:3,13-38,111-118`
- No new source, test, dependency, report, cache, or generated artifact is added.

**Interfaces:**

- Consumes: four verified task commits.
- Produces: a fifth documentation commit, a clean working tree, and concrete verification evidence for the phase-end report.

- [ ] **Step 1: Verify baseline ancestry, commit separation, and clean diff**

```powershell
git log --oneline --decorate -6
git diff --check e8d3eb2..HEAD
git status --short --branch
```

Expected: the implementation-plan documentation commits and four implementation commits follow `e8d3eb2`; `git diff --check` is empty; no unrelated working-tree changes exist.

- [ ] **Step 2: Syntax-check every JavaScript file**

```powershell
$files = @(rg --files src tests scripts -g '*.js')
foreach ($file in $files) {
  node --check $file
  if ($LASTEXITCODE -ne 0) { throw "node --check failed: $file" }
}
Write-Output "node-check ok: $($files.Count) files"
```

Expected: every file passes; no package installation is performed.

- [ ] **Step 3: Regenerate the production CommonJS reachability proof**

```powershell
@'
const fs = require("node:fs");
const path = require("node:path");
const root = process.cwd();
const srcRoot = path.join(root, "src");
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.isFile() && entry.name.endsWith(".js") ? [full] : [];
  });
}
const files = walk(srcRoot).map((file) => path.resolve(file));
const known = new Set(files);
function localDependency(from, request) {
  if (!request.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), request);
  return [base, `${base}.js`, path.join(base, "index.js")].find((candidate) => known.has(candidate)) || null;
}
const reached = new Set();
const queue = [path.join(srcRoot, "cli.js")];
while (queue.length) {
  const file = path.resolve(queue.shift());
  if (reached.has(file)) continue;
  reached.add(file);
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const dependency = localDependency(file, match[1]);
    if (dependency) queue.push(dependency);
  }
}
const relative = (file) => path.relative(root, file).split(path.sep).join("/");
const unreachable = files.filter((file) => !reached.has(file)).map(relative).sort();
const expected = ["src/dashboard/assets/workflow.js"];
if (JSON.stringify(unreachable) !== JSON.stringify(expected)) {
  throw new Error(`unexpected unreachable modules: ${JSON.stringify(unreachable)}`);
}
console.log(`reachability ok: ${reached.size}/${files.length}; HTTP asset=${unreachable[0]}`);
'@ | node
```

Expected after deleting the two modules: `97/98`; the only non-CommonJS-reachable source is the confirmed HTTP asset.

- [ ] **Step 4: Recheck the browser focus and product detail-mode boundaries**

```powershell
$focusCalls = @(rg -n 'browser\.bringToFront\(' src)
if ($focusCalls.Count -ne 1 -or $focusCalls[0] -notmatch 'src[\\/]core[\\/]workspace_tabs\.js') {
  throw "unexpected production bringToFront calls: $($focusCalls -join '; ')"
}
$forbiddenPass = @(rg -n '"--detail-mode"\s*,\s*"search_page_api"|detailMode\s*:\s*"search_page_api"' src/core/scan_execution.js src/core/scan_resume.js src/cli.js src/dashboard/server.js)
if ($forbiddenPass.Count) { throw "product search_page_api pass-through remains: $($forbiddenPass -join '; ')" }
Write-Output $focusCalls[0]
```

Then run:

```powershell
node tests/workspace_tabs_smoke.js
node tests/background_process_visibility_smoke.js
node tests/scan_execution_smoke.js
node tests/scan_recovery_smoke.js
node tests/dashboard_scan_lifecycle_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: all pass; startup guidance still works once, while background/product paths neither focus BOSS nor pass the research detail mode.

- [ ] **Step 5: Run all 96 checks permitted by the current security environment**

Run this one-off driver; it reuses the registered list and refuses to continue unless the repository still contains exactly 97 entries and exactly one excluded entry:

```powershell
@'
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = process.cwd();
const source = fs.readFileSync(path.join(root, "tests", "run_all.js"), "utf8");
const registered = [...source.matchAll(/^\s*"([^"]+\.js)",?\s*$/gm)].map((match) => match[1]);
if (registered.length !== 97) throw new Error(`expected 97 registered checks, got ${registered.length}`);
const blocked = registered.filter((file) => file === "startup_scripts_smoke.js");
const permitted = registered.filter((file) => file !== "startup_scripts_smoke.js");
if (blocked.length !== 1 || permitted.length !== 96) throw new Error("unexpected 360 exclusion set");
for (const file of permitted) {
  console.log(`\n> ${file}`);
  const result = spawnSync(process.execPath, [path.join(root, "tests", file)], {
    cwd: root,
    stdio: "inherit",
    timeout: 180_000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log("\nAll 96 permitted offline checks passed; startup_scripts_smoke.js not run because 360 blocks its unsigned msedge.exe fixture.");
'@ | node
```

Expected final line: `All 96 permitted offline checks passed; startup_scripts_smoke.js not run because 360 blocks its unsigned msedge.exe fixture.` No real BOSS page, real model call, external message, application, push, merge, or release occurs. Do not run `node tests/run_all.js` on this machine and do not claim a fresh 97/97 result.

- [ ] **Step 6: Update the two canonical handoff documents and commit them**

In `docs/PROJECT_HANDOFF.md`, split the currently inaccurate combined main/origin bullet into these exact facts:

```markdown
- 本地 `main` 基线：`d50874166dde550e3fda2fe1b8eb235efecc7677`（`docs: establish v1 architecture handoff`）。
- `origin/main`：`940ca721efdc8e2d29e107ceb9822ff33cb49263`（已发布 `v1.0.0`）。
```

Under the four-topic section, replace the stale “当前会话只负责固化交接” sentence with:

```markdown
课题 1 的详细设计已经确认并完成实施：正式产品只允许 `trusted_pane`，启动时的一次性前台引导保留，扫描状态文字已恢复，且只删除了完成语义证明的代码。课题 2-4 尚未实施；下一份设计是“扫描/JD/分析/沟通的逐岗位进度和明确进度条”。
```

In `docs/NEXT_PHASE.md`, add this status block below topic 1's goal:

```markdown
### 状态

- 详细设计已经确认：`docs/superpowers/specs/2026-08-16-first-principles-project-audit-design.md`。
- 当前注册 97 项离线检查；本轮通过安全环境允许的 96 项，`startup_scripts_smoke.js` 因 360 拦截其未签名 `msedge.exe` 测试桩而未运行；真实 BOSS 读写为 0。更早 beta.4.x 的完整 97 项通过记录保持为历史证据。
- 正式扫描只允许 `trusted_pane`；`search_page_api` 的研究实现和历史证据仍保留。
- 启动期一次性 `Page.bringToFront` 引导保留；后台路径仍为 0 次调用。
- `scanLabel` 的有效职责已迁入 today view model；其余删除项均完成原用途、接替者和回归证明。
```

Change the first two recommended-order entries to:

```markdown
1. 第一性原则项目审计与精简：已完成设计、实施和离线验收。
2. 逐岗位进度与明确进度条：下一份设计；外部平台风险最低，并改善后续验收可观测性。
```

Verify and commit:

```powershell
git diff --check
rg -n '本地 `main` 基线|课题 1 的详细设计已经确认并完成实施|本轮通过安全环境允许的 96 项|下一份设计' docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md
git add -- docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md
git commit -m "docs: record project audit completion"
```

- [ ] **Step 7: Record the final delivery evidence**

Run:

```powershell
git diff --stat e8d3eb2..HEAD
git log --format='%H %s' e8d3eb2..HEAD
git status --short --branch
```

The phase-end report must state: changed/deleted files, 97 registered / 96 freshly passed / `startup_scripts_smoke.js` blocked by 360, the historical complete-97 evidence, reachability result, startup focus result, `search_page_api` preservation/rejection result, real BOSS read/write count `0`, commit hashes, and that nothing was pushed, merged, or released. Stop after this report; do not continue deleting code to improve a line-count number.
