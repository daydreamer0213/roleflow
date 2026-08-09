# Inherited-Scope Resume-Hardening Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把分支 `codex/strict-transferable-evidence` 上 13 个文件、约 470 行未提交的"继承搜索范围收尾"改动，经过一个真实缺口修复（dashboard 409 错误码映射）、切片提交和文档同步后，收敛为可审查的已提交状态。

**Architecture:** 改动本身已完成并通过 52 项离线检查（`npm.cmd test` 全绿，`git diff --check` 干净）。本计划不写新功能逻辑，只做四件事：(1) 按 repo 提交风格把工作树切片成 3 个逻辑提交；(2) TDD 修复一个真实缺口——`resolveLiveInheritedContext` 的 409 映射表仍引用已删除的旧错误码 `INHERITED_SCOPE_FILTER_REQUIRED`，新码 `INHERITED_SCOPE_INVALID` 未映射，未映射的继承范围错误会变成 500 而不是 409；(3) 同步当前产品文档（错误码表、离线检查数）与设计/计划/交接文档状态；(4) 终验。用户侧 rollout（关键词数据编辑、真实 BOSS 只读预检）不在本计划内，需要单独授权。

**Tech Stack:** Node.js 22.5+（CommonJS、`node:sqlite`）、plain `node:assert` 测试、PowerShell 5.1。

## Global Constraints

- 全部离线：不访问 BOSS、不调用真实模型；测试是 plain `node:assert` 脚本，成功打印 `<name> ok`（CLAUDE.md）。
- 每个提交前必须跑完整离线回归 `npm.cmd test`，期望 `All 52 offline checks passed.`；提交前 `git diff --check` 必须无输出。
- 提交消息使用仓库短前缀风格：`feat:` / `fix:` / `docs:`（参照 `git log`，如 `feat: freeze inherited workflow execution`）。
- 不修改 `src/core/storage.js` 的 schema；不新增依赖（唯一 npm 依赖 `pdf-parse`）。
- 错误用带 `code` 的 Error；日志不得包含 Key/Cookie/简历/JD/候选人身份；错误码表见 `docs/operations.md`。
- 不合并分支、不推送、不修改 `data/jobs.sqlite`、不启动 8787 工作台、不碰真实 BOSS（AGENTS.md/PROJECT_HANDOFF.md）。
- Windows 下 `LF will be replaced by CRLF` 警告是 `core.autocrlf` 的正常现象，不是错误。
- 事实优先级：自动化测试与实际运行 > 当前源码 > 当前产品文档 > 历史文件（docs/README.md）。

---

### Task 1: 提交"读取 BOSS 当前选中筛选选项"切片

工作树里 `src/adapters/sites/boss.js` 的 `currentOptions`（用 `ka="sel-job-rec-{param}-{code}"` 读取 `.condition-filter-select` 中已选选项，并与 URL 参数核对后并入 `urlOptions`）是独立于其余改动的完整特性，配套 fixture 与测试已就位。本任务只做验证与提交，不改代码。

**Files:**
- Commit: `src/adapters/sites/boss.js`
- Commit: `tests/fixtures/boss_inherited_filter_dom.json`
- Commit: `tests/source_acquisition_smoke.js`

- [ ] **Step 1: 跑本切片相关测试**

Run: `node tests/source_acquisition_smoke.js`
Expected: `source_acquisition_smoke ok`（结尾）。

- [ ] **Step 2: 跑完整离线回归确认当前工作树全绿**

Run: `npm.cmd test`
Expected: 结尾 `All 52 offline checks passed.`

- [ ] **Step 3: 只暂存本切片的三个文件并提交**

```powershell
git add src/adapters/sites/boss.js tests/fixtures/boss_inherited_filter_dom.json tests/source_acquisition_smoke.js
git diff --check
git commit -m "feat: read selected BOSS filter options from the live page"
```

Expected: 提交成功，`git status --porcelain` 只剩其余 10 个文件仍为 ` M`。

---

### Task 2: TDD 修复 dashboard 409 错误码映射，然后提交收尾批次

**背景事实（已核实）**：`src/dashboard/server.js:1042` 的 409 映射表仍含 `INHERITED_SCOPE_FILTER_REQUIRED`，而该码已在 `src/core/inherited_search_scope.js` 的重写中被 `INHERITED_SCOPE_INVALID` / `INHERITED_SCOPE_PROFILE_INVALID` 取代。`resolveLiveInheritedContext` 的 catch 块（server.js:1036-1048）只把表中代码转为 409；新码未映射时会 `throw error` 落到通用错误处理（`publicError` 默认非 409），页面拿到 500 而不是 409。

**Interfaces:**
- Consumes: 现有 `createDashboardServer({ inheritedContextResolver })` 注入机制（`tests/workflow_dashboard_smoke.js:42-92`）。
- Produces: 无新接口；`server.js:1037-1046` 的映射表新增两个错误码。

- [ ] **Step 1: 写失败测试**

修改 `tests/workflow_dashboard_smoke.js`：

(a) 把假 resolver 的抛错改为不带 `statusCode`（真实 `resolveLiveInheritedContext` 抛出的错误没有 statusCode，走映射表；原三个码本就在映射表中，去掉 statusCode 后仍应 409）：

```js
    if (inheritedFailureCode) {
      throw Object.assign(new Error(`blocked by ${inheritedFailureCode}`), {
        code: inheritedFailureCode
      });
    }
```

(b) 把 409 循环（当前为 `["BOSS_RISK_CONTROL", "BOSS_LOGIN_REQUIRED", "BOSS_SEARCH_PAGE_INVALID"]`）扩展：

```js
  for (const code of [
    "BOSS_RISK_CONTROL",
    "BOSS_LOGIN_REQUIRED",
    "BOSS_SEARCH_PAGE_INVALID",
    "INHERITED_SCOPE_INVALID",
    "INHERITED_SCOPE_PROFILE_INVALID"
  ]) {
```

- [ ] **Step 2: 运行测试验证 RED**

Run: `node tests/workflow_dashboard_smoke.js`
Expected: 失败在 `assert.strictEqual(rejected.status, 409)`——`INHERITED_SCOPE_INVALID` 注入后返回 500（`statusCode` 未映射），断言抛出 `AssertionError [ERR_ASSERTION]`。前三个码仍通过映射得到 409。

- [ ] **Step 3: 最小修复**

修改 `src/dashboard/server.js:1041-1042`，把 `"INHERITED_SCOPE_FILTER_REQUIRED"` 替换为两个新码：

```js
      "BOSS_SEARCH_PAGE_INVALID",
      "INHERITED_SCOPE_INVALID",
      "INHERITED_SCOPE_PROFILE_INVALID"
    ].includes(error?.code)
```

- [ ] **Step 4: 运行测试验证 GREEN**

Run: `node tests/workflow_dashboard_smoke.js`
Expected: `workflow_dashboard_smoke ok`。

- [ ] **Step 5: 跑完整离线回归**

Run: `npm.cmd test`
Expected: `All 52 offline checks passed.`

- [ ] **Step 6: 暂存收尾批次全部文件并提交**

收尾批次文件（10 个，即 Step 2 的修复 + 剩余未提交内容）：

```powershell
git add src/cli.js src/core/inherited_search_scope.js src/core/plan_validation.js src/core/platform_runtime_policy.js src/dashboard/server.js tests/inherited_search_scope_smoke.js tests/scan_end_to_end_recovery_smoke.js tests/workflow_dashboard_smoke.js tests/workflow_end_to_end_smoke.js tests/workflow_scan_smoke.js
git diff --check
git commit -m "feat: harden inherited scope semantics and resume snapshots"
```

Expected: 提交成功；`git status --porcelain` 为空（除后续 docs 外无未提交改动）。

> 注：`tests/workflow_end_to_end_smoke.js` 也在此批次（为 dashboard 测试注入离线继承上下文 resolver），不要遗漏；`tests/run_all.js` 无改动，测试计数保持 52。

---

### Task 3: 同步文档并提交

按仓库约定（"新的实施工作应更新对应计划的任务状态"、"当前产品文档须与代码同步"）更新四处文档。

**Files:**
- Modify: `docs/operations.md`
- Modify: `docs/daily_workflow.md`
- Modify: `docs/superpowers/plans/2026-08-04-platform-inherited-search-scopes.md`
- Modify: `docs/superpowers/specs/2026-08-04-platform-inherited-search-scope-design.md`
- Modify: `docs/PROJECT_HANDOFF.md`

- [ ] **Step 1: 更新 `docs/operations.md` 错误码表**

(a) 第 25 行 `当前 41 项离线检查不访问 BOSS。` → `当前 52 项离线检查不访问 BOSS。`

(b) 在常见错误码列表 `- \`BOSS_PANE_SWITCH_TIMEOUT\`：点击左侧卡片后右侧详情未正常切换。` 之后追加：

```markdown
- `INHERITED_SCOPE_INVALID`：继承范围数据不完整或 URL 不是规范化的 BOSS 搜索页；平台默认筛选条件（没有任何筛选）不是错误。
- `SCAN_RESUME_BATCH_MISMATCH`：恢复批次不属于当前站点和 Search Plan，或在浏览器创建前被拒绝。
- `SCAN_RESUME_ACQUISITION_MODE_INVALID`：批次采集模式不是 generated/inherited，不能恢复。
- `SCAN_RESUME_INHERITED_SNAPSHOT_INVALID` / `WORKFLOW_INHERITED_SNAPSHOT_INVALID`：继承模式快照不完整（模板、范围、关键词来源或平台策略缺失），拒绝恢复。
```

- [ ] **Step 2: 更新 `docs/daily_workflow.md` 恢复说明**

在第 58 行（"如果当前页面不是有效搜索页……不会中途漂移。"）所在段落末尾追加一句：

```markdown
恢复前先校验冻结快照的 schema、哈希、采集模式和继承上下文完整性；任何一项不通过都会在创建浏览器之前拒绝恢复，不访问 BOSS。
```

- [ ] **Step 3: 更新实施计划勾选状态**

`docs/superpowers/plans/2026-08-04-platform-inherited-search-scopes.md`：

- Task 1（第 54 行起）至 Task 6（第 1997 行止）的每个 `- [ ] **Step` 改为 `- [x] **Step`（实现已完成并通过全部离线检查）。
- Task 7（第 2008 行起）的 rollout 步骤（数据编辑、live 预检、继承工作流启动等）保持 `- [ ]` 不动——它们需要用户授权后在真实 BOSS/主库上执行。
- 在 Task 7 标题行下追加一行：

```markdown
> 代码侧任务 1-6 已于 2026-08-05 在 `codex/strict-transferable-evidence` 提交完成；Task 7 的数据编辑与真实只读验收待用户授权后执行。
```

- [ ] **Step 4: 更新设计文档状态**

`docs/superpowers/specs/2026-08-04-platform-inherited-search-scope-design.md` 第 4 行：

```markdown
Status: approved design
```
→
```markdown
Status: implemented on codex/strict-transferable-evidence (offline suite green); live acceptance pending user approval
```

- [ ] **Step 5: 更新 `docs/PROJECT_HANDOFF.md` 交接索引**

- 在"已完成且已提交的内容"表格追加一行：

```markdown
| 平台继承搜索范围（含恢复快照安全加固） | 设计 2026-08-04 · 计划 2026-08-04 | 代码在 `codex/strict-transferable-evidence` 提交完成，52 项离线检查通过；Task 7 数据编辑与真实只读验收待用户执行 |
```

- 把第 39 行 `本文件的更新时间：2026-07-24` 改为 `本文件的更新时间：2026-08-05`。

- [ ] **Step 6: 提交文档**

```powershell
git add docs/operations.md docs/daily_workflow.md docs/superpowers/plans/2026-08-04-platform-inherited-search-scopes.md docs/superpowers/specs/2026-08-04-platform-inherited-search-scope-design.md docs/PROJECT_HANDOFF.md
git diff --check
git commit -m "docs: sync inherited-scope error codes, test count, and plan status"
```

Expected: 提交成功。

---

### Task 4: 终验与交接报告

- [ ] **Step 1: 完整回归**

Run: `npm.cmd test`
Expected: `All 52 offline checks passed.`

- [ ] **Step 2: 工作树与提交历史核验**

```powershell
git status --porcelain
git log --oneline -5
git diff --check
```

Expected: `git status --porcelain` 为空；`git log -5` 显示本计划产生的 3 个提交（`feat: read selected BOSS filter options...`、`feat: harden inherited scope semantics and resume snapshots`、`docs: sync inherited-scope...`）；`git diff --check` 无输出。

- [ ] **Step 3: 向用户报告并列出后续**

报告内容：3 个提交的文件与消息、52 项检查结果、未解决的缺口（`DEV_HANDOFF.md` 中文损坏不可用——是否重建需用户决定）、以及需要用户授权的后续项（计划 Task 7：备份并编辑当前关键词目录、最小只读 live 预检、启动一轮继承工作流验收、生成模式回归；分支合并/推送决策）。

## Self-Review

**1. 覆盖检查（对设计文档 §11-16 与本批改动）：**
- §8.3 恢复使用冻结快照：cli.js `validateResumeBatchPreflight` + `assertScanSnapshotCompatible` 重建哈希校验 ✓（已有测试 scan_end_to_end_recovery_smoke）。
- §11 "缺失平台筛选不是错误"：`assertInheritedAcquisitionScope` 重写允许空 `filterParams` ✓。
- §11 停止时机（导航前失败）：`prevalidateDirectScanResume` 在浏览器创建前执行 ✓（e2e `reject-browser-create` 模式验证）。
- 409 映射缺口：本计划 Task 2 修复 ✓。
- 错误码文档：Task 3 Step 1 ✓。
- 计划/设计/交接文档状态：Task 3 Step 3-5 ✓。
- 用户侧 rollout（§14、计划 Task 7）：明确排除，列为后续 ✓。

**2. 占位符扫描：** 无 TBD/TODO；所有代码块均为可粘贴的实际内容；预期输出均有具体值（错误码、测试名、提交消息）。

**3. 类型/命名一致性：** 测试循环、resolver 抛错、server.js 映射表引用的错误码与 `inherited_search_scope.js` 实际抛出值（`INHERITED_SCOPE_INVALID`、`INHERITED_SCOPE_PROFILE_INVALID`，见 tests/inherited_search_scope_smoke.js:85-90）一致；提交文件清单与 Task 1-3 一致，`workflow_end_to_end_smoke.js` 已包含在 Task 2 批次中。
