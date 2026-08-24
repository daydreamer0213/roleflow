# RoleFlow Cross-Machine Runtime Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通 Windows 用户安装后始终先得到可用的 RoleFlow 工作台，再由产品统一准备、监测和恢复专用 Edge，而不是因浏览器或 BOSS 工作区暂未就绪而整机启动失败。

**Architecture:** 保留真实 Microsoft Edge、稳定专用 profile 和现有 CDP 适配器，在 Dashboard 进程内新增单一浏览器监督器；PowerShell 只负责 Windows 进程发现与一次性启动，监督器负责状态、稳定就绪和恢复。`workspace_tabs` 降为可重入的工作区协调步骤，具体业务入口继续执行自己的 BOSS 安全准入。

**Tech Stack:** Node.js 22 CommonJS、Windows PowerShell 5.1、原生 HTTP/CDP/WebSocket、SQLite、Inno Setup；不新增 Playwright、Puppeteer、Selenium 或 WebView2 依赖。

## Global Constraints

- 支持 Windows 10/11 x64 普通用户；运行时不得依赖源码目录、开发工具、Node 全局安装或 Edge Control。
- 普通用户使用真实 Microsoft Edge 和 `%LOCALAPPDATA%\RoleFlow\BrowserProfile`，安装包不包含浏览器 profile。
- 第一阶段继续使用 9222，但除浏览器监督器/适配器外的业务代码不得自行假定该端口。
- Dashboard 启动成功与浏览器/BOSS 就绪彻底分离；只有 Dashboard 自身不可用才显示“RoleFlow 启动失败”。
- 扫描和常规 JD 主线仍只使用 `trusted_pane`；不修、不验、不删 `search_page_api`；不恢复通用 `standalone_detail`。
- 消息发现的详情例外仍只允许一个同窗、`active: false`、串行、共享预算和冷却且保证关闭的后台临时页。
- 除用户主动启动/恢复工作区的一次引导外，任何流程都不得调用 `Page.bringToFront`。
- 本地确定性检查可以有限重试；导航、DOM 动作、消息发送和申请等不确定 BOSS 操作不得自动重试。
- 真实沟通或申请仍需针对当前不可变样本的明确授权；本计划不执行任何真实外部写入。
- 测试不得创建、改名或执行假 `msedge.exe`，不得占用或探测真实 9222，较大测试产物优先放在 `D:\DevData\RoleFlow-tests`。
- 所有功能改动先跑最小回归，再跑全部离线检查；每个任务单独提交，不推送、不合并、不发布。

---

## File Map

**新增文件：**

- `src/core/browser_supervisor.js`：浏览器状态、并发合并、稳定探测、监测和有限本地恢复。
- `src/adapters/browser/portable_edge_runtime.js`：调用 Windows 启动脚本、读取机器结果、写会话描述。
- `src/core/runtime_paths.js`：安装目录与稳定用户数据目录的唯一解析入口。
- `src/dashboard/assets/runtime.js`：全站运行状态条、恢复按钮和无刷新的状态轮询。
- `scripts/prepare-user-data.ps1`：把旧安装目录中的业务数据一次性复制到稳定用户数据根，不覆盖目标。
- `tests/browser_supervisor_smoke.js`：监督器状态机与恢复边界。
- `tests/portable_edge_runtime_smoke.js`：运行时适配器、会话描述和稳定就绪。
- `tests/runtime_paths_smoke.js`：跨路径、中文路径和数据根规则。
- `tests/dashboard_runtime_smoke.js`：Dashboard 降级启动、状态 API 和恢复入口。
- `tests/cross_machine_runtime_smoke.js`：离线安装/启动/升级/异常矩阵。
- `docs/acceptance/cross-machine-runtime-matrix.md`：真实 Windows 10/11 验收记录模板。

**主要修改文件：**

- `scripts/lib/startup-identity.ps1`、`scripts/start-portable-edge.ps1`：真实 Edge 身份、所需启动能力和机器可读结果。
- `src/adapters/browser/cdp.js`：无页面副作用的传输就绪检查。
- `src/cli.js`、`src/dashboard/server.js`：创建监督器、启动后异步准备、状态/恢复 API 和关闭清理。
- `scripts/start-workspace.ps1`、`scripts/launch-installed.ps1`：Dashboard 优先、单实例启动和非致命浏览器失败。
- `src/core/workspace_tabs.js`：从本地 Dashboard 起步的一次 BOSS 导航、可重入协调及唯一启动引导。
- `src/core/browser_readiness.js`：监督器状态与 BOSS 工作区状态的用户可见映射。
- `src/dashboard/ui/shell.js`、`src/dashboard/assets/roleflow.css`：全站运行状态条。
- `src/cli.js`、`src/dashboard/server.js` 中现有的日志、模型设置、简历、报告调用点：显式传入稳定数据根；底层文件模块继续复用现有 `root` 参数。
- `scripts/installed-self-check.ps1`、`scripts/build-installer.ps1`、`scripts/prepare-uninstall.ps1`、`installer/RoleFlow.iss`：部署检查、数据保留和卸载范围。
- `tests/run_all.js` 及现有相关 smoke 文件：注册并补充回归。

## Task 1: Browser Supervisor State Contract

**Files:**

- Create: `src/core/browser_supervisor.js`
- Create: `tests/browser_supervisor_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

- Consumes: `ensureBrowser({ dashboardUrl }) -> Promise<{ sessionId, pid, cdpUrl, profilePath, edgePath }>` and `inspectBrowser(session) -> Promise<{ ready: true, browser, pageCount }>` supplied by the runtime adapter.
- Produces: `createBrowserSupervisor(options)` returning `{ start, ensure, inspect, getSnapshot, close }`.
- `getSnapshot()` returns only `{ status, ready, message, action, checkedAt, failureCount, sessionId }`; it must never expose Cookies, command lines or full private paths.

- [ ] **Step 1: Write the failing supervisor state tests**

```js
const supervisor = createBrowserSupervisor({
  ensureBrowser: async () => ({ sessionId: "session-1", pid: 42, cdpUrl: "http://127.0.0.1:9222" }),
  inspectBrowser: async () => ({ ready: true, browser: "Edge/140", pageCount: 1 }),
  schedule: () => 1,
  cancelSchedule: () => {},
  now: () => "2099-01-01T00:00:00.000Z"
});
assert.strictEqual(supervisor.getSnapshot().status, "unknown");
await Promise.all([supervisor.ensure({ dashboardUrl: "http://127.0.0.1:8787/" }), supervisor.ensure({ dashboardUrl: "http://127.0.0.1:8787/" })]);
assert.strictEqual(ensureCalls, 1, "parallel ensure calls must share one local attempt");
assert.deepStrictEqual(supervisor.getSnapshot(), {
  status: "ready", ready: true, message: "RoleFlow 专用 Edge 已准备好。", action: "none",
  checkedAt: "2099-01-01T00:00:00.000Z", failureCount: 0, sessionId: "session-1"
});
```

Also cover `starting`, missing Edge → `unavailable/install_edge`, identity mismatch → `conflict/view_help`, post-ready disconnect → `stopped/recover`, unexpected local failure → `needs_attention/view_diagnostics`, and `close()` cancelling the monitor. Assert that a failed inspect never calls `ensureBrowser` automatically while a task may be in progress.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node tests/browser_supervisor_smoke.js`

Expected: FAIL with `Cannot find module '../src/core/browser_supervisor'`.

- [ ] **Step 3: Implement the smallest stateful supervisor**

```js
function createBrowserSupervisor({ ensureBrowser, inspectBrowser, schedule = setTimeout, cancelSchedule = clearTimeout, now = () => new Date().toISOString(), logger = null, monitorIntervalMs = 5000 }) {
  let snapshot = publicSnapshot("unknown", now);
  let session = null;
  let pendingEnsure = null;
  let timer = null;
  let closed = false;

  async function ensure({ dashboardUrl, reason = "startup" } = {}) {
    if (pendingEnsure) return pendingEnsure;
    snapshot = publicSnapshot("starting", now, snapshot.failureCount);
    pendingEnsure = Promise.resolve()
      .then(() => ensureBrowser({ dashboardUrl, reason }))
      .then(async (nextSession) => {
        await inspectBrowser(nextSession);
        session = nextSession;
        snapshot = publicSnapshot("ready", now, 0, nextSession.sessionId);
        scheduleMonitor();
        return getSnapshot();
      })
      .catch((error) => {
        snapshot = snapshotFromError(error, now, snapshot.failureCount + 1);
        return getSnapshot();
      })
      .finally(() => { pendingEnsure = null; });
    return pendingEnsure;
  }

  return { start: ensure, ensure, inspect, getSnapshot, close };
}
```

Keep the status mapping in the same file. Do not add an event bus: Dashboard polls one local API.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node tests/browser_supervisor_smoke.js`

Expected: `browser_supervisor_smoke ok`.

- [ ] **Step 5: Register and run adjacent checks**

Add `browser_supervisor_smoke.js` immediately after `browser_transport_smoke.js` in `tests/run_all.js`.

Run: `node tests/browser_supervisor_smoke.js; node tests/browser_readiness_smoke.js`

Expected: both print `ok`.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- src/core/browser_supervisor.js tests/browser_supervisor_smoke.js tests/run_all.js
git diff --cached --check
git commit -m "feat: add browser supervisor state contract"
```

## Task 2: Portable Edge Runtime and Stable Readiness

**Files:**

- Create: `src/adapters/browser/portable_edge_runtime.js`
- Create: `tests/portable_edge_runtime_smoke.js`
- Modify: `scripts/lib/startup-identity.ps1`
- Modify: `scripts/start-portable-edge.ps1`
- Modify: `src/adapters/browser/cdp.js`
- Modify: `tests/startup_scripts_smoke.js`
- Modify: `tests/browser_transport_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

- Consumes: `CdpBrowserAdapter.inspectTransport()` and PowerShell JSON from `start-portable-edge.ps1 -OutputJson`.
- Produces: `createPortableEdgeRuntime({ projectRoot, profilePath, cdpPort, runPowerShell, cdpFactory, sessionFile, now, randomUUID })` with `ensure({ dashboardUrl })` and `inspect(session)`.
- Session descriptor schema: `{ schemaVersion: 1, sessionId, pid, edgePath, profilePath, cdpUrl, startedAt, inspectedAt }`.

- [ ] **Step 1: Add failing PowerShell argument/identity tests**

Extend `tests/startup_scripts_smoke.js` so `New-RoleFlowPortableEdgeArguments` must produce:

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=9222
--disable-features=CalculateNativeWinOcclusion
--user-data-dir=C:\Users\Example\AppData\Local\RoleFlow\BrowserProfile
--no-first-run
--no-default-browser-check
http://127.0.0.1:8787/
```

Also assert `Assert-RoleFlowPortableEdgeProcessSnapshot` rejects an otherwise matching Edge process that lacks `--disable-features=CalculateNativeWinOcclusion`. Use only synthetic process snapshots; never create an executable.

- [ ] **Step 2: Add failing transport readiness tests**

In `tests/browser_transport_smoke.js`, call `cdp.inspectTransport()` and require exactly these side-effect-free commands:

```js
assert.deepStrictEqual(await cdp.inspectTransport(), {
  browser: "Edge/140",
  pageCount: 1
});
assert.strictEqual(countMethod(websocket.messages, "Browser.getVersion"), 1);
assert.strictEqual(countMethod(websocket.messages, "Page.navigate"), 0);
assert.strictEqual(countMethod(websocket.messages, "Page.bringToFront"), 0);
```

- [ ] **Step 3: Add failing runtime adapter tests**

In `tests/portable_edge_runtime_smoke.js`, inject a fake `runPowerShell` and fake CDP adapter. Assert:

- the start URL is the local Dashboard, never BOSS;
- readiness requires two consecutive successful `inspectTransport()` calls;
- the returned listener PID, Edge path, profile and loopback CDP URL are validated;
- session JSON is written through a sibling temporary file then renamed;
- an existing descriptor is discovery evidence only: `ensure()` still invokes the identity-verifying PowerShell check;
- invalid JSON, non-loopback CDP, wrong profile, missing PID and timeout produce stable error codes;
- no retry calls `Page.navigate`, `Runtime.evaluate` or any BOSS URL.

- [ ] **Step 4: Run the three focused tests and verify RED**

Run: `node tests/startup_scripts_smoke.js; node tests/browser_transport_smoke.js; node tests/portable_edge_runtime_smoke.js`

Expected: at least the new assertions fail because required Edge capability, `inspectTransport()` and runtime adapter do not exist.

- [ ] **Step 5: Implement the required Edge capability and JSON result**

Update `New-RoleFlowPortableEdgeArguments` with the occlusion feature switch. In `start-portable-edge.ps1` add `-OutputJson`; retain human-readable output when absent. Use `Start-Process -PassThru` only as launch evidence, then use the verified listener PID as the authoritative PID.

```powershell
$Result = [ordered]@{
  schemaVersion = 1
  pid = [int]$VerifiedListenerPid
  edgePath = $ResolvedEdgePath
  profilePath = $ProfilePath
  cdpUrl = "http://127.0.0.1:$Port"
  browser = [string]$Version.Browser
}
if ($OutputJson) { $Result | ConvertTo-Json -Compress; exit 0 }
```

Keep the direct-script default URL for developer compatibility, but the runtime adapter must always pass the local Dashboard URL.

- [ ] **Step 6: Implement side-effect-free CDP readiness**

```js
async inspectTransport() {
  const [version, pages] = await Promise.all([
    this.requestJson("/json/version"),
    this.requestJson("/json/list")
  ]);
  if (!version?.webSocketDebuggerUrl || !Array.isArray(pages)) {
    throw browserError("BROWSER_COMMAND_FAILED", "CDP readiness response is incomplete.");
  }
  await this.browserCommand("Browser.getVersion");
  return { browser: String(version.Browser || ""), pageCount: pages.filter((page) => page.type === "page").length };
}
```

This method must not call `listTabs()`, because readiness must not depend on page visibility or BOSS DOM.

- [ ] **Step 7: Implement the runtime adapter and atomic session descriptor**

Use `child_process.spawn` with an argument array and `windowsHide: true`; do not build a shell command string. Validate all PowerShell output before persisting it. Two consecutive readiness probes may retry only transport reads with a bounded delay; process launch runs once per `ensure()`.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run: `node tests/startup_scripts_smoke.js; node tests/browser_transport_smoke.js; node tests/portable_edge_runtime_smoke.js`

Expected: all three print `ok` and no real Edge process is created.

- [ ] **Step 9: Commit Task 2**

```powershell
git add -- scripts/lib/startup-identity.ps1 scripts/start-portable-edge.ps1 src/adapters/browser/cdp.js src/adapters/browser/portable_edge_runtime.js tests/startup_scripts_smoke.js tests/browser_transport_smoke.js tests/portable_edge_runtime_smoke.js tests/run_all.js
git diff --cached --check
git commit -m "feat: supervise dedicated Edge readiness"
```

## Task 3: Dashboard-First Runtime Integration

**Files:**

- Create: `tests/dashboard_runtime_smoke.js`
- Modify: `src/cli.js`
- Modify: `src/dashboard/server.js`
- Modify: `tests/dashboard_shell_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

- Consumes: Task 1 `browserSupervisor` and Task 2 `portableEdgeRuntime`.
- Produces: `GET /api/runtime-status`, `POST /api/runtime/browser/recover`, and an extended `/health` containing `applicationStatus: "ready"` plus public `browserRuntime` state.
- `createDashboardServer` accepts injected `browserSupervisor`; tests may use a fake object.

- [ ] **Step 1: Write failing Dashboard degraded-start tests**

Create a fake supervisor whose first snapshot is `starting` and whose recovery becomes `ready`. Assert:

```js
const health = await getJson(base, "/health");
assert.strictEqual(health.body.ok, true);
assert.strictEqual(health.body.applicationStatus, "ready");
assert.strictEqual(health.body.browserRuntime.status, "starting");

const status = await getJson(base, "/api/runtime-status");
assert.deepStrictEqual(status.body.browser, fakeSupervisor.getSnapshot());

const recovered = await postJson(base, "/api/runtime/browser/recover", {});
assert.strictEqual(recovered.status, 200);
assert.strictEqual(recovered.body.browser.status, "ready");
```

Also assert an `unavailable` or `login_required` browser state does not change `/health` to failure and all local pages still return 200.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node tests/dashboard_runtime_smoke.js`

Expected: FAIL because the runtime endpoints are not present.

- [ ] **Step 3: Wire one supervisor into the Dashboard process**

In `startDashboard`, construct `portableEdgeRuntime` and `browserSupervisor` only for `browser=portable`; pass the supervisor to `createDashboardServer`. Start listening first, then invoke without awaiting:

```js
server.listen(port, "127.0.0.1", () => {
  const dashboardUrl = `http://127.0.0.1:${port}/`;
  void browserSupervisor?.start({ dashboardUrl, reason: "dashboard_started" });
  console.log(`Dashboard: ${dashboardUrl}`);
});
```

For `--no-browser`, inject no supervisor and report a stable `unavailable` snapshot. Do not auto-fallback to Edge Control.

- [ ] **Step 4: Add public status and explicit recovery routes**

`GET /api/runtime-status` returns only public snapshots. `POST /api/runtime/browser/recover` calls `ensure()` exactly once and returns 200 even when the resulting state is `unavailable`; malformed requests return the normal safe 4xx structure. It must not run workspace navigation yet.

- [ ] **Step 5: Close the supervisor with the server**

Extend the existing `dashboardServer.close` wrapper so `browserSupervisor.close()` and `messageDiscovery.close()` both settle before the callback. A supervisor cleanup error is logged but never discards the HTTP server error.

- [ ] **Step 6: Run Dashboard and adjacent tests**

Run: `node tests/dashboard_runtime_smoke.js; node tests/dashboard_shell_smoke.js; node tests/browser_readiness_smoke.js`

Expected: all print `ok`.

- [ ] **Step 7: Commit Task 3**

```powershell
git add -- src/cli.js src/dashboard/server.js tests/dashboard_runtime_smoke.js tests/dashboard_shell_smoke.js tests/run_all.js
git diff --cached --check
git commit -m "feat: start dashboard before browser readiness"
```

## Task 4: Single-Instance Installed Launcher

**Files:**

- Modify: `scripts/start-workspace.ps1`
- Modify: `scripts/launch-installed.ps1`
- Modify: `tests/startup_scripts_smoke.js`
- Modify: `tests/windows_installer_smoke.js`

**Interfaces:**

- Consumes: Dashboard `/health` identity from Task 3.
- Produces: one bootstrap owner at a time; successful installed launch means the matching Dashboard is reachable, regardless of browser runtime state.

- [ ] **Step 1: Write failing Dashboard-first script tests**

Assert source and fixture behavior prove this order:

1. dependency check;
2. create or reuse Dashboard;
3. verify `/health` identity;
4. return success;
5. browser preparation remains inside Dashboard and is absent from the fatal startup path.

The test must reject scripts that invoke `start-portable-edge.ps1` before a successful Dashboard health response, and must assert `workspace-tabs` is no longer executed synchronously by `start-workspace.ps1`.

- [ ] **Step 2: Write failing concurrent-launch tests**

Start two fixture launchers against one temporary Dashboard port. Require:

- both launch commands exit 0;
- exactly one Dashboard fixture process is created;
- the second launcher waits for/reuses the first identity;
- a listener whose `/health.projectRoot` differs is never reused;
- mutex timeout produces `ROLEFLOW_STARTUP_ALREADY_IN_PROGRESS`, not a browser/BOSS error.

- [ ] **Step 3: Run focused script tests and verify RED**

Run: `node tests/startup_scripts_smoke.js; node tests/windows_installer_smoke.js`

Expected: new ordering and concurrency assertions fail.

- [ ] **Step 4: Reorder `start-workspace.ps1`**

Remove the synchronous Edge and `workspace-tabs` block from the installed startup path. Preserve explicit developer commands and `-NoBrowser`; pass `--no-browser` into Dashboard instead of treating it as an application failure.

`Test-Dashboard` continues to prove PID, project root and frozen browser authority. Its success no longer depends on `/api/browser-readiness`.

- [ ] **Step 5: Add a bounded named startup mutex**

In `launch-installed.ps1`, acquire a per-user named mutex derived from normalized install root and port, wait at most 30 seconds, and always release it in `finally`. After acquiring, recheck `/health` before starting anything.

```powershell
$Mutex = [System.Threading.Mutex]::new($false, $MutexName)
$Acquired = $Mutex.WaitOne([TimeSpan]::FromSeconds(30))
if (-not $Acquired) { throw "ROLEFLOW_STARTUP_ALREADY_IN_PROGRESS" }
try { & $StartScript -Port $Port } finally { $Mutex.ReleaseMutex(); $Mutex.Dispose() }
```

Only a Dashboard installation/identity failure may call `Show-RoleFlowError`. Browser/BOSS states are written to the log and shown in Dashboard.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `node tests/startup_scripts_smoke.js; node tests/windows_installer_smoke.js`

Expected: both print `ok`; the tests use temporary ports and never 8787/9222.

- [ ] **Step 7: Commit Task 4**

```powershell
git add -- scripts/start-workspace.ps1 scripts/launch-installed.ps1 tests/startup_scripts_smoke.js tests/windows_installer_smoke.js
git diff --cached --check
git commit -m "fix: decouple installed launch from browser state"
```

## Task 5: Reentrant Workspace Reconciliation

**Files:**

- Modify: `src/core/workspace_tabs.js`
- Modify: `src/cli.js`
- Modify: `src/dashboard/server.js`
- Modify: `tests/workspace_tabs_smoke.js`
- Modify: `tests/dashboard_runtime_smoke.js`

**Interfaces:**

- Consumes: a ready supervisor session and `CdpBrowserAdapter` whose managed Edge includes the required occlusion capability.
- Produces: `prepareWorkspaceTabs({ ..., bootstrapDedicatedTabs: true, allowStartupGuidance })` that can start from one local Dashboard tab or an existing valid BOSS baseline.
- Produces: `POST /api/runtime/workspace/reconcile` returning `{ browser, workspace }` without converting a workspace failure into application failure.

- [ ] **Step 1: Add failing local-Dashboard bootstrap tests**

Add these exact cases to `tests/workspace_tabs_smoke.js`:

- one selected local Dashboard tab, no BOSS tabs: create one background `/web/geek/jobs` tab;
- login required: keep the Dashboard, make no second BOSS request, and use the one permitted startup `bringToFront` only when `allowStartupGuidance=true`;
- logged in: create one background communication tab, prove same window, then guide to Dashboard at most once;
- repeated reconciliation over the completed topology creates no tab and performs no navigation;
- all tabs report hidden: return an ambiguous workspace error before issuing `Target.createTarget`;
- two BOSS candidates or two windows: preserve all tabs and return `ambiguous`;
- cleanup after a failed create restores the typed ID/visibility baseline and never retries creation.

- [ ] **Step 2: Add failing Dashboard reconcile API tests**

Inject a fake `workspaceReconciler` and assert:

```js
const response = await postJson(base, "/api/runtime/workspace/reconcile", { startupGuidance: true });
assert.strictEqual(response.status, 200);
assert.strictEqual(response.body.workspace.status, "ready");
assert.strictEqual(reconcileCalls, 1);
```

If the supervisor is not ready, return 409 with `BROWSER_RUNTIME_NOT_READY` and do not call the reconciler. If reconciliation returns `login_required`, return 200 with an actionable state, not a fatal error.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node tests/workspace_tabs_smoke.js; node tests/dashboard_runtime_smoke.js`

Expected: local-Dashboard bootstrap and reconcile endpoint assertions fail.

- [ ] **Step 4: Extend workspace bootstrap without weakening topology checks**

When there is no BOSS tab and exactly one verified local Dashboard tab, use it as the opener for a single background search-page create. Re-list and verify target ID, path, window ID and background state before inspecting BOSS. Continue to reject extra BOSS pages, extra windows or unknown window IDs.

The only foreground helper remains:

```js
if (allowStartupGuidance) await guideStartupTab(browser, targetTab);
```

No retry/recovery path may call this helper implicitly.

- [ ] **Step 5: Wire explicit initial and user recovery reconciliation**

After the initial `browserSupervisor.start()` resolves `ready`, invoke reconciliation once with `startupGuidance: true`. The recovery API performs `ensure()` and then reconciliation only for the current explicit user request. A monitor reconnect never runs reconciliation automatically.

- [ ] **Step 6: Run focused and browser safety tests**

Run: `node tests/workspace_tabs_smoke.js; node tests/dashboard_runtime_smoke.js; node tests/browser_transport_smoke.js; node tests/boss_message_detail_reader_smoke.js`

Expected: all print `ok`; assertions show no new `Page.bringToFront` outside startup reconciliation.

- [ ] **Step 7: Commit Task 5**

```powershell
git add -- src/core/workspace_tabs.js src/cli.js src/dashboard/server.js tests/workspace_tabs_smoke.js tests/dashboard_runtime_smoke.js
git diff --cached --check
git commit -m "feat: reconcile dedicated Edge workspace safely"
```

## Task 6: Operation Gates and User-Facing Runtime State

**Files:**

- Create: `src/dashboard/assets/runtime.js`
- Modify: `src/core/browser_readiness.js`
- Modify: `src/dashboard/ui/shell.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Modify: `src/dashboard/server.js`
- Modify: `tests/browser_readiness_smoke.js`
- Modify: `tests/dashboard_runtime_smoke.js`
- Modify: `tests/dashboard_shell_smoke.js`
- Modify: `tests/dashboard_scan_lifecycle_smoke.js`
- Modify: `tests/dashboard_message_discovery_smoke.js`
- Modify: `tests/dashboard_communication_batch_smoke.js`

**Interfaces:**

- Consumes: `/api/runtime-status`, recovery/reconcile APIs and existing operation-specific preflights.
- Produces: a shared `<section data-runtime-status>` in every framed page and one local polling script.
- `inspectBossBrowserReadiness` accepts an optional public supervisor snapshot and never creates/launches a browser.

- [ ] **Step 1: Write failing readiness mapping tests**

Add mappings for `starting`, `unavailable`, `conflict`, `stopped`, `needs_attention`, `login_required`, `search_page_required`, `communication_page_required`, `risk_control` and `ready`. Assert user messages contain an action but omit `CDP`, `9222`, `authority`, raw paths and stack text.

- [ ] **Step 2: Write failing shared UI tests**

Every framed page must contain one live region:

```html
<section class="runtime-status" data-runtime-status aria-live="polite">
  <strong data-runtime-title>正在准备专用 Edge…</strong>
  <span data-runtime-message></span>
  <button type="button" data-runtime-recover hidden>恢复专用 Edge</button>
</section>
```

The asset must poll only localhost, keep one request in flight, use a 5-second interval, stop polling when the document is hidden, resume on `visibilitychange`, and require a click before POSTing recovery/reconcile.

- [ ] **Step 3: Write failing operation-isolation tests**

Require all of the following:

- local queue, analysis results, settings and saved drafts remain readable while browser is unavailable;
- starting a scan while supervisor is not ready returns 409 before spawning a process;
- message discovery while not ready does not acquire a BOSS lease or create a tab;
- communication batch building/local drafts remain available;
- communication execution retains immutable-batch authorization and fails closed when runtime is not ready;
- an analysis-only resume does not require browser readiness;
- no operation failure calls supervisor `ensure()` automatically.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `node tests/browser_readiness_smoke.js; node tests/dashboard_runtime_smoke.js; node tests/dashboard_shell_smoke.js; node tests/dashboard_scan_lifecycle_smoke.js; node tests/dashboard_message_discovery_smoke.js; node tests/dashboard_communication_batch_smoke.js`

Expected: new state/UI/gate assertions fail.

- [ ] **Step 5: Implement public state mapping and shell banner**

Reuse existing `renderDashboardFrame`; insert one status section under the top bar and load `/assets/runtime.js` through `renderFramedPage`. Do not add a frontend framework or separate state store.

- [ ] **Step 6: Gate only browser-dependent actions**

Before existing BOSS preflight, check `browserSupervisor.getSnapshot().ready`. Return a stable 409 if false. Once true, keep every existing DOM identity, risk-control, pacing and authorization check unchanged.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the six commands from Step 4.

Expected: all print `ok`.

- [ ] **Step 8: Commit Task 6**

```powershell
git add -- src/dashboard/assets/runtime.js src/core/browser_readiness.js src/dashboard/ui/shell.js src/dashboard/assets/roleflow.css src/dashboard/server.js tests/browser_readiness_smoke.js tests/dashboard_runtime_smoke.js tests/dashboard_shell_smoke.js tests/dashboard_scan_lifecycle_smoke.js tests/dashboard_message_discovery_smoke.js tests/dashboard_communication_batch_smoke.js
git diff --cached --check
git commit -m "feat: expose recoverable browser runtime state"
```

## Task 7: Stable Installed User Data Root

**Files:**

- Create: `src/core/runtime_paths.js`
- Create: `scripts/prepare-user-data.ps1`
- Create: `tests/runtime_paths_smoke.js`
- Modify: `src/cli.js`
- Modify: `src/dashboard/server.js`
- Modify: `scripts/start-workspace.ps1`
- Modify: `scripts/prepare-uninstall.ps1`
- Modify: `tests/windows_installer_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

- Consumes: explicit CLI `--data-root`; developer commands without it retain the repository root behavior.
- Produces: installed data root `%LOCALAPPDATA%\RoleFlow\Data` with `data/`, `.runtime/settings/`, `.runtime/resumes/`, `.runtime/logs/`, `reports/` and `profiles/`.
- `resolveRuntimePaths({ appRoot, dataRoot }) -> { appRoot, dataRoot, dbPath, reportRoot }`.

- [ ] **Step 1: Write failing path resolver tests**

Cover absolute paths, spaces, Chinese usernames, missing `LOCALAPPDATA`, relative/UNC/reparse-point rejection, developer fallback, and proof that app root and data root cannot overlap unexpectedly.

```js
assert.deepStrictEqual(resolveRuntimePaths({ appRoot: "C:\\Programs\\RoleFlow", dataRoot: "C:\\Users\\测试 用户\\AppData\\Local\\RoleFlow\\Data" }), {
  appRoot: path.resolve("C:\\Programs\\RoleFlow"),
  dataRoot: path.resolve("C:\\Users\\测试 用户\\AppData\\Local\\RoleFlow\\Data"),
  dbPath: path.resolve("C:\\Users\\测试 用户\\AppData\\Local\\RoleFlow\\Data\\data\\jobs.sqlite"),
  reportRoot: path.resolve("C:\\Users\\测试 用户\\AppData\\Local\\RoleFlow\\Data\\reports")
});
```

- [ ] **Step 2: Write failing migration tests**

Use a temporary fixture containing only approved legacy paths. Require:

- empty target: copy to a sibling staging directory, verify, atomically rename to `Data`;
- existing target: do not merge or overwrite;
- copy failure: remove only the verified staging child and preserve source/target/siblings;
- source containing junctions/reparse points: stop before recursive copy;
- never copy `.runtime/node`, BrowserProfile, installers, source, tests or secrets outside approved runtime settings;
- source remains as recovery evidence after successful copy.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node tests/runtime_paths_smoke.js; node tests/windows_installer_smoke.js`

Expected: resolver and migration entry do not exist.

- [ ] **Step 4: Implement explicit app/data path separation**

Keep `ROOT` as code/install root. Resolve `DATA_ROOT` from `--data-root || ROOT`; use it for DB, runtime model settings, resume files, logs and reports. Continue loading static `configs/` and source code from `ROOT`. Every spawned scan/workflow command receives the same absolute `--data-root`.

- [ ] **Step 5: Implement safe installed migration**

`start-workspace.ps1` calls `prepare-user-data.ps1` before Dashboard start, then passes the stable data root. The script is idempotent and returns machine-readable status `created`, `migrated` or `existing`; it never deletes legacy data.

- [ ] **Step 6: Update uninstall scope**

Default uninstall preserves both `%LOCALAPPDATA%\RoleFlow\Data` and BrowserProfile. Explicit deletion shows both exact directories, validates they are strict children of `%LOCALAPPDATA%\RoleFlow`, rejects reparse points, and deletes only the selected verified targets.

- [ ] **Step 7: Run focused and storage tests**

Run: `node tests/runtime_paths_smoke.js; node tests/windows_installer_smoke.js; node tests/storage_migration_smoke.js; node tests/model_settings_smoke.js; node tests/resume_privacy_smoke.js; node tests/observability_smoke.js`

Expected: all print `ok`; source legacy fixture remains after migration.

- [ ] **Step 8: Commit Task 7**

```powershell
git add -- src/core/runtime_paths.js scripts/prepare-user-data.ps1 src/cli.js src/dashboard/server.js scripts/start-workspace.ps1 scripts/prepare-uninstall.ps1 tests/runtime_paths_smoke.js tests/windows_installer_smoke.js tests/run_all.js
git diff --cached --check
git commit -m "feat: separate installed data from program files"
```

## Task 8: Installer, Diagnostics, and Shortcut Contract

**Files:**

- Create: `tests/cross_machine_runtime_smoke.js`
- Modify: `scripts/installed-self-check.ps1`
- Modify: `scripts/build-installer.ps1`
- Modify: `scripts/launch-installed.ps1`
- Modify: `installer/RoleFlow.iss`
- Modify: `src/dashboard/server.js`
- Modify: `tests/windows_installer_smoke.js`
- Modify: `tests/dashboard_runtime_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

- Consumes: stable paths, Dashboard-first launch and public supervisor state.
- Produces: installer prerequisite result, `GET /api/runtime-diagnostics`, “复制诊断摘要” and “打开日志文件夹” actions.

- [ ] **Step 1: Write failing packaging and prerequisite tests**

The staged installer must include every new runtime/script asset and exclude tests, profile, user data, logs, cached Node stores and Edge Control. The self-check must:

- verify packaged Node and production files;
- locate real Edge without launching it;
- verify stable data/profile parents can be created;
- launch a fixture Dashboard on a temporary port and verify `/health`;
- never require 9222, BOSS, a browser login or workspace tabs.

- [ ] **Step 2: Write failing shortcut tests**

Parse `RoleFlow.iss` and require:

- Start menu RoleFlow shortcut;
- optional desktop shortcut selected once by default;
- both target `launch-installed.ps1` with the installed working directory;
- post-install launch is non-blocking;
- uninstall preserves data by default.

- [ ] **Step 3: Write failing diagnostics tests**

`GET /api/runtime-diagnostics` must return a redacted object with launch session ID, application/browser/workspace states, versions and log folder. Assert it omits command line, profile absolute path, Cookies, BOSS text, resume text and secrets.

The “打开日志文件夹” endpoint may shell-open only the already-resolved local log directory after a click. Tests inject the opener and assert no arbitrary request path reaches it.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `node tests/windows_installer_smoke.js; node tests/dashboard_runtime_smoke.js; node tests/cross_machine_runtime_smoke.js`

Expected: new packaging/diagnostic assertions fail.

- [ ] **Step 5: Update installer/self-check with no online dependency**

Keep `PrivilegesRequired=lowest`. Missing Edge produces a concrete installation prerequisite message; it must not silently download software. Use the existing Inno shortcut entries and add tests rather than introducing a custom shortcut manager.

- [ ] **Step 6: Implement redacted diagnostics**

Build the summary from existing logger and supervisor public snapshots. Reuse `observability.sanitize`; do not add a second redaction system. Browser failure remains visible in Dashboard and launcher log but does not trigger a fatal popup.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the three commands from Step 4.

Expected: all print `ok` and no real Edge/BOSS access occurs.

- [ ] **Step 8: Commit Task 8**

```powershell
git add -- scripts/installed-self-check.ps1 scripts/build-installer.ps1 scripts/launch-installed.ps1 installer/RoleFlow.iss src/dashboard/server.js tests/windows_installer_smoke.js tests/dashboard_runtime_smoke.js tests/cross_machine_runtime_smoke.js tests/run_all.js
git diff --cached --check
git commit -m "feat: harden installed runtime diagnostics"
```

## Task 9: Full Offline Lifecycle Verification

**Files:**

- Modify: any test/implementation file required only by failures traced to Tasks 1-8
- Do not modify: `search_page_api` code or evidence

**Interfaces:**

- Consumes: all prior tasks.
- Produces: one clean offline verification record at the exact commit under test.

- [ ] **Step 1: Parse every packaged PowerShell file**

Run: `node tests/windows_installer_smoke.js`

Expected: `windows_installer_smoke ok`, including PowerShell parser checks.

- [ ] **Step 2: Run the runtime-focused suite twice**

Run:

```powershell
node tests/browser_supervisor_smoke.js
node tests/portable_edge_runtime_smoke.js
node tests/dashboard_runtime_smoke.js
node tests/workspace_tabs_smoke.js
node tests/cross_machine_runtime_smoke.js
```

Run the same block a second time. Expected: every test prints `ok` both times, proving no stale lock/session fixture dependence.

- [ ] **Step 3: Run all offline checks**

Run: `npm test`

Expected: every registered offline check passes and the final line reports the exact total. No test launches real Edge or contacts BOSS.

- [ ] **Step 4: Inspect branch scope**

Run:

```powershell
git status --short
git diff --check HEAD~8..HEAD
git log --oneline --decorate -12
```

Expected: clean worktree, no whitespace errors, one focused commit per completed task, no merge/release commit.

- [ ] **Step 5: Fix only evidence-backed regressions**

For each failure, reproduce the smallest failing smoke, trace it to the changed path, add or tighten the regression assertion, then change the minimum implementation. Do not loosen BOSS safety assertions to make the suite pass.

- [ ] **Step 6: Commit verification-only corrections if needed**

```powershell
git add -p
git diff --cached --check
git commit -m "fix: close runtime resilience regressions"
```

Skip this commit when no correction is needed.

## Task 10: Documentation and Cross-Machine Acceptance Gate

**Files:**

- Create: `docs/acceptance/cross-machine-runtime-matrix.md`
- Modify: `README.md`
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/NEXT_PHASE.md`
- Modify: `docs/operations.md`

**Interfaces:**

- Consumes: exact verified SHA from Task 9 and the design acceptance matrix.
- Produces: beginner-facing install/recovery instructions and an evidence ledger for Windows 10/11 acceptance.

- [ ] **Step 1: Write the acceptance matrix with immutable fields**

Each row contains:

```text
candidate SHA | installer SHA-256 | Windows version/build | Edge version/path |
fresh/upgrade | first launch | second launch | profile retained | browser closed/recovered |
occluded-window result | shortcut result | diagnostics path | BOSS access count | result | notes
```

Mark every real-machine row `未执行` initially; do not convert planned evidence into a pass.

- [ ] **Step 2: Update beginner-facing docs**

State the normal flow: install → click RoleFlow → Dashboard appears → dedicated Edge prepares → login/recheck if asked. Explain that browser problems no longer close RoleFlow, and give exact button names and log location. Remove instructions that ask ordinary users to manage CDP, 9222, Edge Control or source scripts.

- [ ] **Step 3: Update authoritative handoff/state docs**

Record exact branch/SHA, completed offline checks, remaining real-machine rows, known limitations, no external-write authorization, and the rule that no merge/push/release occurs before user acceptance.

- [ ] **Step 4: Verify documentation consistency**

Run:

```powershell
rg -n "Edge Control|9222|CDP|portable|启动失败|专用 Edge" README.md docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md docs/acceptance/cross-machine-runtime-matrix.md
git diff --check
```

Expected: internal terms occur only in advanced/diagnostic context; ordinary instructions consistently use “RoleFlow 专用 Edge（推荐）”.

- [ ] **Step 5: Commit documentation**

```powershell
git add -- README.md docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md docs/operations.md docs/acceptance/cross-machine-runtime-matrix.md
git diff --cached --check
git commit -m "docs: add cross-machine runtime acceptance gate"
```

- [ ] **Step 6: Build one unsigned candidate after offline verification**

Run the repository installer build command with caches/output on `D:\DevData`. Record the exact output path, bytes, SHA-256 and source commit in the matrix. Do not install automatically, publish, push or merge.

- [ ] **Step 7: Execute real-machine acceptance serially**

Use at least one clean Windows 10 and one clean Windows 11 ordinary-user environment. First complete installation, launch, repeat launch, occlusion, Edge-close recovery, upgrade and uninstall-preserve tests without BOSS. Only then perform one low-volume, read-only BOSS login/workspace check using the user's session.

No real communication/application action is part of this acceptance. If risk control appears, stop immediately and record the row without retry.

- [ ] **Step 8: Final acceptance report**

Report in plain Chinese:

- which machines and scenarios passed;
- which failures remain and whether user data is safe;
- exact candidate SHA and installer hash;
- BOSS actions actually issued;
- whether the branch is ready for the user's merge decision.

Do not claim completion if either Windows environment, profile persistence, occluded-window behavior, browser-close recovery or upgrade preservation remains unverified.

## Execution Order and Checkpoints

1. Tasks 1-4 establish a usable Dashboard-first product without changing BOSS page behavior.
2. Task 5 changes workspace behavior and therefore receives its own browser-safety checkpoint.
3. Task 6 exposes state and gates operations without weakening existing operation checks.
4. Task 7 moves installed user data only after startup behavior is stable and backed by destructive-scope tests.
5. Tasks 8-9 close packaging and offline lifecycle evidence.
6. Task 10 is the only stage that creates an installer candidate and asks for real-machine/BOSS observation.

Implementation will run inline in this existing integration worktree using `executing-plans`; no new branch/worktree is required because the user explicitly chose this branch as the next-version development line. Stop after each task's tests and commit, but only send user-facing reports at the phase checkpoints above unless a genuine architecture decision becomes unavoidable.
