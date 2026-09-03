# RoleFlow First-use Startup and Installer Polish Implementation Plan

> **Required sub-skill:** Use `executing-plans` to implement this plan task by task, and use `test-driven-development` for behavior changes.

**Goal:** 首次启动时自动形成可用的搜索页和消息页，使用当前求职方案准备不覆盖用户筛选条件的搜索关键词，降低用户等待时的困惑，并让安装程序始终提供安装位置选择。

**Architecture:** 保留现有固定 BOSS 搜索页/消息页拓扑和串行浏览器队列。工作区准备阶段只在“已登录但缺少搜索关键词”这一可恢复状态下补齐消息页；搜索准备继续复用 `prepareInitialSearchPage()`，但将候选来源扩展到当前有效 Search Plan，并在准备成功后异步排队一次工作区复检，避免嵌套浏览器队列。安装程序只启用 Inno Setup 的原生目录页，不新增自定义安装器流程。性能部分先做本地冷/热启动测量，不在没有证据时增加 Edge 参数。

**Tech Stack:** Node.js、CommonJS、SQLite、Microsoft Edge CDP、PowerShell、Inno Setup、现有离线 smoke tests。

**Global Constraints:** 不访问真实 BOSS 做常规测试；不产生外部沟通；不删除浏览器资料、缓存、扩展或登录状态；不放宽风控/身份/页面丢失即停边界；不改版本号、不推送、不合并、不打包发布；大型临时数据放在 `D:`。

---

## Task 1: 缺少关键词时仍自动补齐消息页

**Files:**

- Modify: `tests/workspace_tabs_smoke.js`
- Modify: `src/core/workspace_tabs.js`

- [ ] **Step 1: 写失败测试，描述可恢复状态**

  将现有“所有非 ready 状态都不创建页面”的用例拆开：

  - `search_page_required`：已有登录搜索页时，创建缺失的 `/web/geek/chat` 和本地 dashboard，但最终状态仍为 `search_page_required`。
  - `login_required`、`risk_control`、`browser_unavailable`、`not_ready`：仍不创建消息页。
  - 已有消息页时不得重复创建。

- [ ] **Step 2: 运行定向测试，确认 RED**

  Run: `node tests/workspace_tabs_smoke.js`

  Expected: 新增用例失败，显示 `search_page_required` 分支没有创建消息页。

- [ ] **Step 3: 最小实现**

  在 `prepareWorkspaceTabs()` 中把提前返回条件收窄为真正不可继续的状态；`search_page_required` 继续执行固定拓扑补齐，但保留原 readiness 结果：

  ```js
  const canPrepareTopology = readiness.status === "ready"
    || readiness.status === "search_page_required";

  if (!canPrepareTopology) {
    return buildBlockedResult(readiness);
  }
  ```

  页面创建仍走现有 `createPage()`、同窗校验与后台行为，不引入第二套拓扑逻辑。

- [ ] **Step 4: 运行定向测试，确认 GREEN**

  Run: `node tests/workspace_tabs_smoke.js`

  Expected: 全部通过。

- [ ] **Step 5: 提交行为改动**

  ```powershell
  git add tests/workspace_tabs_smoke.js src/core/workspace_tabs.js
  git commit -m "fix: prepare message tab before search query"
  ```

## Task 2: 用当前有效求职方案准备关键词并自动复检

**Files:**

- Modify: `tests/onboarding_progress_ui_smoke.js`
- Modify: `src/dashboard/server.js`
- Reuse without modification unless a test proves otherwise: `src/application/onboarding/initial_search_page.js`
- Reuse: `src/storage/candidate_store.js`
- Reuse: `src/storage/onboarding_store.js`

- [ ] **Step 1: 写失败测试覆盖真实首次使用缺口**

  新增或扩展测试，至少覆盖：

  1. 数据库没有 onboarding run，但有当前 active Search Plan，工作区为 `search_page_required` 且消息页已存在时，调用一次 `initialSearchPreparer`。
  2. 首选刚完成 onboarding 对应的方案；没有时回退当前 active Search Plan。
  3. `prepared` 后异步触发一次 `reason: "initial_search_prepared"` 的工作区复检。
  4. 复检不会再次触发搜索准备，避免循环。
  5. 准备失败不写成功标记，下一次人工刷新仍可重试。
  6. 同一有效方案已得到 `prepared` 或 `query_present` 后不重复处理。

  测试注入一个立即执行但可观测的调度器，避免依赖真实计时。

- [ ] **Step 2: 运行定向测试，确认 RED**

  Run: `node tests/onboarding_progress_ui_smoke.js`

  Expected: 当前实现找不到 onboarding run 时不会准备关键词，且没有自动复检，因此新增断言失败。

- [ ] **Step 3: 最小实现候选选择与单次执行**

  在 `createDashboardServer()` 内复用现有 profile/plan 读取方式：

  ```js
  const profile = listCandidateProfiles(db)[0] || null;
  const activePlan = profile ? getActiveSearchPlan(db, profile.id) : null;
  ```

  将“是否处理过”从进程级单一布尔值改为按 plan id 记录成功结果，并保留一个 in-flight Promise：

  ```js
  const preparedSearchPlanIds = new Set();
  let initialSearchCatchUpInFlight = null;
  ```

  只有工作区为 `ready`，或为 `search_page_required` 且已有 `communicationTabId` 时，才进入准备。异常和失败不加入成功集合。

- [ ] **Step 4: 成功后排队一次工作区复检**

  复用现有 `reconcileWorkspace()`，通过可注入的零延迟调度器在当前浏览器任务完成后调用：

  ```js
  scheduleWorkspaceRecheck(() => {
    void reconcileWorkspace({
      startupGuidance: false,
      reason: "initial_search_prepared"
    });
  });
  ```

  `initial_search_prepared` 不属于 catch-up 触发原因，避免递归；不得在 `runBrowserRead()` 内同步嵌套另一个 `runBrowserRead()`。

- [ ] **Step 5: 保留不覆盖用户选择的既有契约**

  确认 `prepareInitialSearchPage()` 仍满足：

  - URL 已有 `query` 时返回 `query_present`，不覆盖。
  - 只补 query，保留城市、地铁、商圈等现有参数。
  - 关键词按方案内 A/B/C 与原顺序选择第一个非空值。

  如既有用例已覆盖，不重复添加低价值测试。

- [ ] **Step 6: 运行相关测试，确认 GREEN**

  Run:

  ```powershell
  node tests/onboarding_progress_ui_smoke.js
  node tests/initial_search_page_smoke.js
  node tests/dashboard_runtime_smoke.js
  ```

  Expected: 全部通过；准备失败仍能重试，准备成功只复检一次。

- [ ] **Step 7: 提交首次启动编排改动**

  ```powershell
  git add tests/onboarding_progress_ui_smoke.js src/dashboard/server.js
  git commit -m "fix: complete first-use workspace automatically"
  ```

## Task 3: 安装程序始终显示安装位置

**Files:**

- Modify: `installer/RoleFlow.iss`
- Verify: `tests/windows_installer_smoke.js`

- [ ] **Step 1: 修改 Inno Setup 原生配置**

  在 `[Setup]` 中加入：

  ```ini
  DisableDirPage=no
  UsePreviousAppDir=yes
  ```

  默认仍为 `%LOCALAPPDATA%\Programs\RoleFlow`；升级用户默认展示上次路径，但可以点“浏览”修改。

- [ ] **Step 2: 运行安装器离线 smoke**

  Run: `node tests/windows_installer_smoke.js`

  Expected: 现有安装、升级、卸载和路径安全检查全部通过。

  注：目录页是否可见属于 Inno Setup 原生行为，不添加只匹配两行文本的伪行为测试；最终通过编译成功和人工安装页验收确认。

- [ ] **Step 3: 提交安装器配置**

  ```powershell
  git add installer/RoleFlow.iss
  git commit -m "fix: always offer installer location choice"
  ```

## Task 4: 首次加载性能核验与完整门禁

**Files:**

- Modify only if evidence requires: `scripts/lib/startup-identity.ps1`
- Modify only if launch flags change: `tests/portable_edge_runtime_smoke.js`
- Update: `docs/PROJECT_HANDOFF.md`
- Update: `docs/NEXT_PHASE.md`
- Update: `docs/superpowers/specs/2026-09-03-first-use-startup-installer-polish-design.md`
- Update: `docs/superpowers/plans/2026-09-03-first-use-startup-installer-polish.md`

- [ ] **Step 1: 用本地页面和 D 盘测试资料测量冷/热启动**

  使用独立测试 profile 和本地页面记录：

  - dashboard 启动到 browser runtime ready 的时间；
  - Edge 进程数、总工作集和私有内存；
  - 冷启动与第二次热启动差异；
  - 是否存在重复的 Edge 根进程或重复工作区页面。

  不读取真实 BOSS 页面内容，不清理用户 profile。

- [ ] **Step 2: 仅在证据充分时做单变量 A/B**

  保留后台可靠性相关参数。只有某一个候选参数在本地冷/热测试中有稳定、明显收益且不破坏现有 smoke，才修改 `startup-identity.ps1` 并先写失败测试；否则记录“首启浏览器自身冷加载，无代码改动”。

- [ ] **Step 3: 运行关键回归**

  Run:

  ```powershell
  node tests/workspace_tabs_smoke.js
  node tests/onboarding_progress_ui_smoke.js
  node tests/initial_search_page_smoke.js
  node tests/dashboard_runtime_smoke.js
  node tests/portable_edge_runtime_smoke.js
  node tests/windows_installer_smoke.js
  ```

  Expected: 全部通过。

- [ ] **Step 4: 运行新鲜完整门禁**

  Run: `npm test`

  Expected: 所有离线检查通过；记录实际总数，不沿用旧结果。

- [ ] **Step 5: 完成只读复审**

  逐项检查：

  - 搜索页缺关键词时只补齐页面，不把工作区误报为 ready；
  - 自动准备不覆盖 query/筛选项；
  - 无 onboarding run 的 active plan 能工作；
  - 失败可重试，成功不重复，复检不递归；
  - 没有嵌套串行浏览器队列；
  - 风控、登录和浏览器不可用仍停止；
  - 安装升级仍默认上次目录且允许修改；
  - 没有引入无证据的 Edge 参数。

- [ ] **Step 6: 更新权威文档和复选框**

  写清用户可见变化、根因、性能测量、验证总数、未验证前提、真实平台访问情况和后续人工验收入口。

- [ ] **Step 7: 最终静态检查**

  Run:

  ```powershell
  git diff --check
  git status --short --branch
  ```

  Expected: 无空白错误；只有本阶段预期文档改动尚未提交。

- [ ] **Step 8: 提交最终文档**

  ```powershell
  git add docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md docs/superpowers/specs/2026-09-03-first-use-startup-installer-polish-design.md docs/superpowers/plans/2026-09-03-first-use-startup-installer-polish.md
  git commit -m "docs: close first-use startup polish"
  ```

- [ ] **Step 9: 在精确最终 SHA 上复跑风险相称的最终验证**

  Run:

  ```powershell
  node tests/workspace_tabs_smoke.js
  node tests/onboarding_progress_ui_smoke.js
  node tests/windows_installer_smoke.js
  git status --short --branch
  git rev-parse HEAD
  ```

  Expected: 定向检查通过、工作树干净，并记录最终 SHA。未经用户新授权，不推送、不合并、不发布。
