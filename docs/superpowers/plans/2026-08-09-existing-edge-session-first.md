# Existing Edge Session First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RoleFlow reuse the user's already logged-in ordinary Edge BOSS tabs by default, while keeping project-owned portable Edge as an explicit manual fallback and preserving all existing scan, recovery, and communication safety gates.

**Architecture:** Reuse the existing `EdgeControlAdapter`, `CdpBrowserAdapter`, workflow `browserMode`, and communication-batch authority chain. Change only startup/default parameter selection, add a focused fixed-tab topology check for ordinary Edge, and keep historical frozen modes unchanged. No database schema or scan-state-machine change is required.

**Tech Stack:** Windows PowerShell 5.1, Node.js 22 CommonJS, existing Edge Control bridge/extension, existing portable CDP adapter, server-rendered Dashboard, built-in smoke-test runner.

## Global Constraints

- Default new browser authority is `edge`.
- `portable` is allowed only when the user explicitly selects it; its CDP port remains exactly `9222`.
- An `edge` readiness failure must stop with an actionable error and must never auto-start or auto-fallback to `portable`.
- Ordinary Edge readiness requires exactly one `/web/geek/jobs` BOSS tab and exactly one `/web/geek/chat` BOSS tab in the same known window.
- Readiness checks are read-only: no BOSS navigation, click, typing, tab creation, tab closing, communication, or application.
- Existing workflow and communication-batch `browserMode` values remain immutable on resume.
- Ordinary direct-scan snapshots remain schema-compatible and do not gain a browser-mode field.
- No database schema, matching rule, recommendation threshold, card target, JD target, communication gate, or execution state is changed.
- No test may access the live BOSS site or external network; existing loopback-only fixtures remain allowed.

## Pre-Execution Checkpoint

Before Task 1 implementation, run:

```powershell
$head = git rev-parse HEAD
$tag = 'checkpoint/pre-existing-edge-default-20260809'
if (git show-ref --verify --quiet "refs/tags/$tag") {
  throw "Checkpoint already exists: $tag"
}
git tag -a $tag $head -m 'Checkpoint before existing Edge default implementation'
```

Expected: the tag points to the approved specification and implementation-plan
head. Do not move or recreate the tag during later fix cycles.

---

### Task 1: Make workspace startup prefer the existing Edge session

**Files:**
- Modify: `src/core/workspace_tabs.js`
- Modify: `src/core/browser_readiness.js`
- Modify: `src/cli.js:166-199`
- Modify: `scripts/start-workspace.ps1`
- Modify: `Start.bat`
- Modify: `tests/workspace_tabs_smoke.js`
- Modify: `tests/browser_readiness_smoke.js`
- Modify: `tests/startup_scripts_smoke.js`

**Interfaces:**
- Produces: `assertBossOperatorTabs(tabs): { searchTab, communicationTab, windowId }`.
- Produces: `prepareWorkspaceTabs({ browser, dashboardUrl, inspectReadiness, requireFixedBossTabs = false })`.
- Produces: `prepareWorkspaceTabsCommand(args)` defaulting to `browser: "edge"`.
- Consumed by: Task 2 Dashboard ordinary-Edge readiness.

- [ ] **Step 1: Add failing fixed-tab and edge-default workspace tests**

In `tests/workspace_tabs_smoke.js`, import the new helper and add:

```js
const {
  prepareWorkspaceTabs,
  assertBossOperatorTabs
} = require("../src/core/workspace_tabs");

const fixedSearch = {
  id: "boss-search",
  url: "https://www.zhipin.com/web/geek/jobs",
  windowId: 42
};
const fixedCommunication = {
  id: "boss-communication",
  url: "https://www.zhipin.com/web/geek/chat",
  windowId: 42
};

assert.deepStrictEqual(
  assertBossOperatorTabs([fixedSearch, fixedCommunication]),
  {
    searchTab: fixedSearch,
    communicationTab: fixedCommunication,
    windowId: 42
  }
);
assert.throws(
  () => assertBossOperatorTabs([fixedSearch]),
  (error) => error.code === "BOSS_TAB_REQUIRED"
);
assert.throws(
  () => assertBossOperatorTabs([
    fixedSearch,
    { ...fixedCommunication, windowId: 99 }
  ]),
  (error) => error.code === "BOSS_WINDOW_MISMATCH"
);

const unrelatedWindow = {
  id: "ordinary-edge-unrelated",
  url: "https://example.invalid/",
  windowId: 99
};
assert.doesNotThrow(
  () => assertBossOperatorTabs([
    fixedSearch,
    fixedCommunication,
    unrelatedWindow
  ]),
  "unrelated ordinary Edge windows must not invalidate the fixed BOSS pair"
);
```

Change the command test so omission defaults to ordinary Edge:

```js
function workspaceCommandDependencies(calls) {
  const browser = { kind: `${calls.label}-browser` };
  return {
    browserFactory: (args) => {
      calls.browser.push(args);
      return browser;
    },
    siteAdapterFactory: (site, context) => {
      calls.adapter.push({ site, context });
      return {
        async preflight() {
          calls.preflight += 1;
          return { isSearchPage: true };
        }
      };
    },
    prepareTabs: async ({
      browser: receivedBrowser,
      dashboardUrl,
      requireFixedBossTabs,
      inspectReadiness
    }) => {
      assert.strictEqual(receivedBrowser, browser);
      assert.strictEqual(dashboardUrl, "http://localhost:8787/workspace");
      calls.requireFixedBossTabs = requireFixedBossTabs;
      assert.strictEqual((await inspectReadiness()).status, "ready");
      return { status: "ready" };
    }
  };
}

const commandCalls = {
  label: "edge",
  browser: [],
  adapter: [],
  preflight: 0,
  requireFixedBossTabs: null
};
const commandResult = await prepareWorkspaceTabsCommand({
  "dashboard-url": "http://localhost:8787/workspace"
}, workspaceCommandDependencies(commandCalls));

assert.deepStrictEqual(commandResult, { status: "ready" });
assert.deepStrictEqual(commandCalls.browser, [{ browser: "edge" }]);
assert.strictEqual(commandCalls.requireFixedBossTabs, true);
```

Add explicit portable compatibility:

```js
const portableCalls = {
  label: "portable",
  browser: [],
  adapter: [],
  preflight: 0,
  requireFixedBossTabs: null
};
await prepareWorkspaceTabsCommand({
  browser: "portable",
  "cdp-port": 9222,
  "dashboard-url": "http://localhost:8787/workspace"
}, workspaceCommandDependencies(portableCalls));
assert.deepStrictEqual(portableCalls.browser, [{
  browser: "portable",
  "cdp-port": 9222
}]);
assert.strictEqual(portableCalls.requireFixedBossTabs, false);

await assert.rejects(
  () => prepareWorkspaceTabsCommand({
    browser: "portable",
    "cdp-port": 9333
  }),
  (error) => error.code === "WORKSPACE_PORTABLE_BROWSER_REQUIRED"
);
```

In `tests/browser_readiness_smoke.js`, add stable ordinary-Edge messages and topology-code mapping:

```js
const unavailable = await inspectBossBrowserReadiness({
  preflight: async () => {
    const error = new Error("bridge unavailable");
    error.code = "BROWSER_DISCONNECTED";
    throw error;
  },
  now
});
assert.strictEqual(unavailable.status, "browser_unavailable");
assert.match(unavailable.message, /Edge Control/);

const topology = await inspectBossBrowserReadiness({
  preflight: async () => {
    const error = new Error("fixed tabs differ");
    error.code = "BOSS_WINDOW_MISMATCH";
    throw error;
  },
  now
});
assert.strictEqual(topology.status, "boss_tab_missing");
assert.match(topology.message, /搜索页.*沟通页.*同一窗口/);
```

In `tests/startup_scripts_smoke.js`, make the existing `-NoBrowser` fixture assert the emitted workspace command:

```js
assert.deepStrictEqual(
  workspaceTabs.args.slice(
    workspaceTabs.args.indexOf("--browser"),
    workspaceTabs.args.indexOf("--browser") + 2
  ),
  ["--browser", "edge"]
);
assert(!workspaceTabs.args.includes("--cdp-port"));
```

Add an explicit portable `-NoBrowser` run:

```js
const portableRecordPath = path.join(tempRoot, "workspace-portable.jsonl");
const portable = runPowerShell([
  "-File", path.join(projectRoot, "scripts", "start-workspace.ps1"),
  "-Port", "8787",
  "-BrowserMode", "portable",
  "-NoBrowser"
], {
  cwd: outsideCwd,
  env: fixtureEnv({ ROLEFLOW_STARTUP_RECORD: portableRecordPath }),
  timeout: 30000
});
assert.strictEqual(portable.status, 0, combinedOutput(portable));
const portableTabs = readJsonLines(portableRecordPath)
  .find((item) => item.command === "workspace-tabs");
assert(portableTabs);
assert(portableTabs.args.includes("--browser"));
assert(portableTabs.args.includes("portable"));
assert(portableTabs.args.includes("--cdp-port"));
assert(portableTabs.args.includes("9222"));
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```powershell
node tests/workspace_tabs_smoke.js
node tests/browser_readiness_smoke.js
node tests/startup_scripts_smoke.js
```

Expected:

- workspace tests fail because `assertBossOperatorTabs` does not exist and `prepareWorkspaceTabsCommand` rejects `edge`;
- readiness message/topology assertions fail;
- startup test sees `portable` as the default workspace command.

- [ ] **Step 3: Implement the fixed-tab helper and edge-default CLI**

In `src/core/workspace_tabs.js`, add:

```js
function bossPath(tab) {
  try {
    const url = new URL(tab?.url || "");
    return /(^|\.)zhipin\.com$/i.test(url.hostname) ? url.pathname : "";
  } catch {
    return "";
  }
}

function assertBossOperatorTabs(tabs = []) {
  const searchTabs = tabs.filter((tab) => bossPath(tab) === "/web/geek/jobs");
  const communicationTabs = tabs.filter((tab) => bossPath(tab) === "/web/geek/chat");
  if (searchTabs.length !== 1 || communicationTabs.length !== 1) {
    throw workspaceError(
      "BOSS_TAB_REQUIRED",
      "普通 Edge 必须正好保留一个 BOSS 搜索页和一个 BOSS 沟通页。"
    );
  }
  const [searchTab] = searchTabs;
  const [communicationTab] = communicationTabs;
  if (!Number.isInteger(searchTab.windowId)
    || !Number.isInteger(communicationTab.windowId)) {
    throw workspaceError(
      "BROWSER_COMMAND_FAILED",
      "固定 BOSS 标签页缺少可靠的窗口身份。"
    );
  }
  if (searchTab.windowId !== communicationTab.windowId) {
    throw workspaceError(
      "BOSS_WINDOW_MISMATCH",
      "BOSS 搜索页和沟通页必须位于同一个普通 Edge 窗口。"
    );
  }
  return {
    searchTab,
    communicationTab,
    windowId: searchTab.windowId
  };
}
```

Change the `prepareWorkspaceTabs` parameter list to:

```js
async function prepareWorkspaceTabs({
  browser,
  dashboardUrl,
  inspectReadiness,
  requireFixedBossTabs = false
})
```

Immediately after the existing dependency validation and
`const tabs = await browser.listTabs();`, insert:

```js
const fixed = requireFixedBossTabs
  ? assertBossOperatorTabs(tabs)
  : null;
```

Replace:

```js
const bossTab = selectBossTab(tabs);
```

with:

```js
const bossTab = fixed?.searchTab || selectBossTab(tabs);
```

Keep the existing “every project-owned tab is in one window” check only for
portable mode. When `requireFixedBossTabs` is true, unrelated ordinary Edge
tabs or windows are allowed; only the two fixed BOSS tabs and any RoleFlow
Dashboard tab must match the fixed BOSS window:

```js
if (!requireFixedBossTabs
  && tabs.some((tab) => !Number.isInteger(tab.windowId)
    || tab.windowId !== bossTab.windowId)) {
  throw workspaceError(
    "WORKSPACE_WINDOW_MISMATCH",
    "项目专用 Edge 包含多个窗口或缺少可靠的窗口身份。"
  );
}
```

Export both functions:

```js
module.exports = {
  prepareWorkspaceTabs,
  assertBossOperatorTabs
};
```

In `src/core/browser_readiness.js`, update messages and mapping:

```js
const BROWSER_READINESS_MESSAGES = Object.freeze({
  browser_unavailable: "Edge Control 未连接到普通 Edge，请启动桥接服务并确认扩展已连接。",
  boss_tab_missing: "请在普通 Edge 的同一窗口保留一个 BOSS 搜索页和一个 BOSS 沟通页。",
  login_required: "等待登录：请在普通 Edge 的 BOSS 标签页完成登录。",
  search_page_required: "请在固定 BOSS 搜索标签打开岗位搜索结果页并设置本轮筛选。",
  risk_control: "BOSS 当前要求安全验证，请完成验证后再继续。",
  ready: "普通 Edge 已登录并就绪，可以执行一轮。"
});

const CODE_TO_STATUS = Object.freeze({
  BROWSER_DISCONNECTED: "browser_unavailable",
  BROWSER_TIMEOUT: "browser_unavailable",
  BROWSER_COMMAND_FAILED: "browser_unavailable",
  BOSS_TAB_REQUIRED: "boss_tab_missing",
  BOSS_LOGIN_REQUIRED: "login_required",
  BOSS_RISK_CONTROL: "risk_control",
  BOSS_SEARCH_PAGE_INVALID: "search_page_required",
  BOSS_SEARCH_PAGE_LOST: "search_page_required",
  BOSS_WINDOW_MISMATCH: "boss_tab_missing",
  BOSS_COMMUNICATION_TAB_WINDOW_MISMATCH: "boss_tab_missing",
  BOSS_COMMUNICATION_TAB_WINDOW_UNKNOWN: "boss_tab_missing"
});
```

In `src/cli.js`, replace the portable-only gate:

```js
const browserMode = String(args.browser || "edge").trim().toLowerCase();
const cdpPort = Number(args["cdp-port"] || 9222);
if (!["edge", "portable"].includes(browserMode)
  || (browserMode === "portable" && cdpPort !== 9222)) {
  const error = new Error(
    "工作台默认复用普通 Edge；项目专用 Edge 仅支持显式 portable/9222。"
  );
  error.code = "WORKSPACE_PORTABLE_BROWSER_REQUIRED";
  throw error;
}
```

Create the browser with only relevant arguments:

```js
const browserArgs = browserMode === "portable"
  ? { browser: "portable", "cdp-port": 9222 }
  : { browser: "edge" };
const browser = browserFactory(browserArgs);
```

Pass the topology requirement only for ordinary Edge:

```js
const result = await prepareTabs({
  browser,
  dashboardUrl: parsedDashboardUrl.toString(),
  requireFixedBossTabs: browserMode === "edge",
  inspectReadiness: () => inspectBossBrowserReadiness({
    preflight: () => adapter.preflight()
  })
});
```

- [ ] **Step 4: Make startup choose Edge Control without auto-fallback**

In `scripts/start-workspace.ps1`, add:

```powershell
[ValidateSet("edge", "portable")]
[string]$BrowserMode = "edge"
```

Replace the unconditional portable launch:

```powershell
if (-not $NoBrowser) {
  if ($BrowserMode -eq "edge") {
    & (Join-Path $PSScriptRoot "start-edge-control.ps1") -Source auto
  } else {
    & (Join-Path $PSScriptRoot "start-portable-edge.ps1") -Port $CdpPort
  }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Build workspace arguments without a silent fallback:

```powershell
$workspaceArgs = @(
  "workspace-tabs",
  "--dashboard-url", $url,
  "--browser", $BrowserMode
)
if ($BrowserMode -eq "portable") {
  $workspaceArgs += @("--cdp-port", [string]$CdpPort)
}
```

Update the status text:

```powershell
if ($BrowserMode -eq "edge") {
  Write-Host "浏览器：复用普通 Edge 中已登录的固定 BOSS 标签页"
} else {
  Write-Host "浏览器：项目专用 Edge（手动备用，需要独立登录）"
}
```

In `Start.bat`, forward explicit fallback arguments:

```bat
@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-workspace.ps1" %*
if errorlevel 1 pause
```

Do not catch an Edge Control failure and invoke `start-portable-edge.ps1`.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run:

```powershell
node tests/workspace_tabs_smoke.js
node tests/browser_readiness_smoke.js
node tests/startup_scripts_smoke.js
git diff --check
```

Expected:

- all three tests print `ok`;
- diff check is silent.

- [ ] **Step 6: Commit Task 1**

Run:

```powershell
git add src/core/workspace_tabs.js src/core/browser_readiness.js src/cli.js scripts/start-workspace.ps1 Start.bat tests/workspace_tabs_smoke.js tests/browser_readiness_smoke.js tests/startup_scripts_smoke.js
git commit -m "feat: prefer existing Edge workspace session"
```

---

### Task 2: Default new Dashboard scans and workflows to ordinary Edge

**Files:**
- Modify: `src/dashboard/server.js`
- Modify: `tests/workflow_dashboard_smoke.js`
- Modify: `tests/dashboard_scan_lifecycle_smoke.js`
- Modify: `tests/dashboard_communication_batch_smoke.js`

**Interfaces:**
- Consumes: Task 1 `assertBossOperatorTabs(tabs)`.
- Produces: new inherited workflow planner `{ browserMode: "edge", cdpPort: null }`.
- Preserves: historical workflow and communication-batch browser modes.

- [ ] **Step 1: Add failing Dashboard default tests**

In `tests/dashboard_scan_lifecycle_smoke.js`, omit `browserMode` in one `startPlanScan` call and assert:

```js
const defaultCalls = [];
startPlanScan(new Map(), {
  db: database,
  root,
  dbPath,
  planId: 151,
  scanKind: "daily",
  logger,
  requestId: "request-default-edge",
  spawnProcess: spawnHarness(database, 151, defaultCalls)
});
const defaultArgs = defaultCalls[0].args.slice(2);
assert.deepStrictEqual(
  defaultArgs.slice(
    defaultArgs.indexOf("--browser"),
    defaultArgs.indexOf("--browser") + 2
  ),
  ["--browser", "edge"]
);
assert(!defaultArgs.includes("--cdp-port"));
defaultCalls[0].child.emit("close", 0, null);
```

In `tests/workflow_dashboard_smoke.js`, change the primary new-workflow start to omit browser parameters:

```js
const started = await postForm(baseUrl, "/api/workflow-run", {
  planId: saved.planId,
  action: "start"
});
```

Expect ordinary Edge authority:

```js
assert.deepStrictEqual(inheritedResolutionInput, {
  browserMode: "edge",
  cdpPort: null
});
assert.strictEqual(workflow.planner.browserMode, "edge");
assert.strictEqual(workflow.planner.cdpPort, null);
assert.deepStrictEqual(
  spawns[0].args.slice(
    spawns[0].args.indexOf("--browser"),
    spawns[0].args.indexOf("--browser") + 2
  ),
  ["--browser", "edge"]
);
assert(!spawns[0].args.includes("--cdp-port"));
```

Update the frozen-mode page expectations:

```js
assert.match(
  inheritedInterruptedPage.body,
  /<input type="hidden" name="browserMode" value="edge">/
);
assert.match(inheritedInterruptedPage.body, /当前已登录 Edge/);
assert.doesNotMatch(inheritedInterruptedPage.body, /<select name="browserMode">/);
```

Update primary resume requests to `browserMode: "edge"` and expect:

```js
assert.deepStrictEqual(
  resumeBrowserProbeInputs.at(-1),
  { browserMode: "edge", cdpPort: 9222 }
);
```

The existing deliberately seeded portable workflows remain portable and must retain their existing assertions.

Add launch-form assertions:

```js
assert.match(planBefore.body, /<option value="edge" selected>/);
assert.match(planBefore.body, /当前已登录 Edge（推荐）/);
assert.match(planBefore.body, /项目专用 Edge（手动备用，需要独立登录）/);
```

Add a separate explicit-portable start on a different seeded plan:

```js
const portableSaved = seedProfile(db);
const portableStarted = await postForm(baseUrl, "/api/workflow-run", {
  planId: portableSaved.planId,
  browserMode: "portable",
  cdpPort: 9222,
  action: "start"
});
assert.strictEqual(portableStarted.status, 303);
const portableWorkflow = listWorkflowRuns(db, {
  planId: portableSaved.planId
})[0];
assert.strictEqual(portableWorkflow.planner.browserMode, "portable");
assert.strictEqual(portableWorkflow.planner.cdpPort, 9222);
const portableSpawn = spawns.at(-1).args;
assert.deepStrictEqual(
  portableSpawn.slice(
    portableSpawn.indexOf("--browser"),
    portableSpawn.indexOf("--browser") + 4
  ),
  ["--browser", "portable", "--cdp-port", "9222"]
);
spawns.at(-1).child.emit("close", 0, null);
```

In `tests/dashboard_communication_batch_smoke.js`, assert the manual communication page renders `edge` first and selected while keeping `portable` available:

```js
assert.match(page.body, /<option value="edge" selected>当前已登录 Edge（推荐）<\/option>/);
assert.match(page.body, /<option value="portable">项目专用 Edge（手动备用）<\/option>/);
```

Do not execute a communication batch in this test.

- [ ] **Step 2: Run focused Dashboard tests and confirm RED**

Run:

```powershell
node tests/dashboard_scan_lifecycle_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/dashboard_communication_batch_smoke.js
```

Expected:

- omitted scan mode still spawns `portable`;
- new inherited workflow rejects or stores `portable`;
- rendered forms still describe project Edge as the default.

- [ ] **Step 3: Change Dashboard defaults without changing stored-mode recovery**

In `src/dashboard/server.js`, import Task 1's helper:

```js
const { assertBossOperatorTabs } = require("../core/workspace_tabs");
```

Change the default readiness probe:

```js
function createDashboardBrowserReadinessProbe({ logger }) {
  return () => inspectDashboardBossBrowserReadiness({
    browserMode: "edge",
    cdpPort: null,
    logger
  });
}
```

For ordinary Edge, verify the fixed topology before the existing adapter preflight:

```js
async function inspectDashboardBossBrowserReadiness({
  browserMode = "edge",
  cdpPort = null,
  logger,
  browserFactory = createDashboardBrowser
}) {
  const browser = browserFactory({ browserMode, cdpPort });
  const adapter = new boss.BossSiteAdapter({ browser, logger });
  return inspectBossBrowserReadiness({
    preflight: async () => {
      if (browserMode === "edge") {
        assertBossOperatorTabs(await browser.listTabs());
      }
      return adapter.preflight();
    }
  });
}
```

Replace `resolveNewInheritedBrowser` with:

```js
function resolveNewInheritedBrowser(input = {}) {
  const browserMode = String(input.browserMode || "edge").trim().toLowerCase();
  if (!["edge", "portable"].includes(browserMode)) {
    throw appError(
      "WORKFLOW_BROWSER_MODE_INVALID",
      "浏览器模式必须是当前已登录 Edge 或项目专用 Edge。",
      { statusCode: 409 }
    );
  }
  if (browserMode === "edge") {
    return { browserMode: "edge", cdpPort: null };
  }
  const cdpPort = normalizeCdpPort(input.cdpPort);
  if (cdpPort !== PORTABLE_CDP_PORT) {
    throw appError(
      "INHERITED_PORTABLE_PORT_REQUIRED",
      "项目专用 Edge 固定使用 9222 端口。",
      { statusCode: 409 }
    );
  }
  return { browserMode: "portable", cdpPort };
}
```

In `resolveLiveInheritedContext`, replace:

```js
browserMode = "portable",
cdpPort = PORTABLE_CDP_PORT,
```

with:

```js
browserMode = "edge",
cdpPort = null,
```

In `startPlanScan`, replace:

```js
browserMode = "portable",
```

with:

```js
browserMode = "edge",
```

Change direct form parsing to fail toward ordinary Edge:

```js
const browserMode = params.browserMode === "portable"
  ? "portable"
  : "edge";
```

Do not change `resolveWorkflowResumeBrowserMode()`; it already freezes inherited workflows and preserves generated/legacy behavior.

- [ ] **Step 4: Update browser selectors and labels**

In `renderWorkflowLaunchPanel`, replace the hidden portable mode with:

```html
<label>浏览器
  <select name="browserMode">
    <option value="edge" selected>当前已登录 Edge（推荐）</option>
    <option value="portable">项目专用 Edge（手动备用，需要独立登录）</option>
  </select>
</label>
<input type="hidden" name="cdpPort" value="9222">
```

Keep frozen workflow resume as a hidden field. For an `edge` workflow its label is:

```text
使用普通 Edge 中已登录的固定 BOSS 搜索页
```

For the direct plan scan selector, use:

```html
<option value="edge" selected>当前已登录 Edge（推荐）</option>
<option value="portable">项目专用 Edge（手动备用，需要独立登录）</option>
```

For the manual communication-batch page, put ordinary Edge first:

```html
<option value="edge" selected>当前已登录 Edge（推荐）</option>
<option value="portable">项目专用 Edge（手动备用）</option>
```

Do not change batch confirmation, calibration, or execution controls.

- [ ] **Step 5: Run focused Dashboard tests and confirm GREEN**

Run:

```powershell
node tests/dashboard_scan_lifecycle_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/dashboard_communication_batch_smoke.js
git diff --check
```

Expected: all tests print `ok`; diff check is silent.

- [ ] **Step 6: Commit Task 2**

Run:

```powershell
git add src/dashboard/server.js tests/workflow_dashboard_smoke.js tests/dashboard_scan_lifecycle_smoke.js tests/dashboard_communication_batch_smoke.js
git commit -m "feat: default new BOSS workflows to existing Edge"
```

---

### Task 3: Document the explicit portable fallback and verify compatibility

**Files:**
- Modify: `README.md`
- Modify: `docs/release_boundary.md`
- Modify: `tests/self_check.js`

**Interfaces:**
- Documents: default `Start.bat` ordinary-Edge behavior.
- Documents: `Start.bat -BrowserMode portable` explicit fallback.
- Preserves: portable/CDP installation and release support.

- [ ] **Step 1: Add failing documentation contract checks**

In `tests/self_check.js`, replace the old default-project-Edge assertions with:

```js
assert(workspaceLauncher.includes('BrowserMode = "edge"'));
assert(workspaceLauncher.includes("start-edge-control.ps1"));
assert(workspaceLauncher.includes("start-portable-edge.ps1"));
assert(readme.includes("当前已登录 Edge（推荐）"));
assert(readme.includes("Start.bat -BrowserMode portable"));
assert(readme.includes("不会自动回退"));
```

Retain the existing checks that `portable`, CDP port `9222`, and the project-local profile remain supported.

- [ ] **Step 2: Run self-check and confirm RED**

Run:

```powershell
node tests/self_check.js
```

Expected: FAIL because README and launcher wording still describe portable Edge as the default.

- [ ] **Step 3: Update user-facing documentation**

Update `README.md` startup instructions to state:

```text
Start.bat 默认复用普通 Edge 中已经登录的 BOSS 页面。
启动前请在同一普通 Edge 窗口保留一个岗位搜索页和一个沟通页。
RoleFlow 通过 Edge Control 只读检查登录、风控、窗口和页面身份；检查失败会停止，不会自动回退到项目专用 Edge。

只有需要独立环境时才运行：

Start.bat -BrowserMode portable

项目专用 Edge 使用 9222 和 .runtime\edge-profile，需要独立登录。
```

Update `docs/release_boundary.md`:

- ordinary Edge requires a healthy Edge Control extension/bridge;
- missing Edge Control stops with guidance;
- the portable fallback remains explicit and supported;
- the release does not silently switch browser authority.

- [ ] **Step 4: Run documentation and full offline gates**

Run:

```powershell
node tests/self_check.js
node tests/workspace_tabs_smoke.js
node tests/browser_readiness_smoke.js
node tests/startup_scripts_smoke.js
node tests/dashboard_scan_lifecycle_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/dashboard_communication_batch_smoke.js
npm.cmd test
git diff --check
```

Expected:

- every focused test prints `ok`;
- full suite reports all offline checks passing;
- diff check is silent.

- [ ] **Step 5: Commit Task 3**

Run:

```powershell
git add README.md docs/release_boundary.md tests/self_check.js
git commit -m "docs: explain existing Edge default"
```

---

### Task 4: Review, clean the temporary portable session, and resume live read-only acceptance

**Files:**
- Verify: all files modified by Tasks 1-3
- Verify: `D:\DevData\RoleFlow-boss-detail-acceptance-20260809-v1\jobs.sqlite`
- Verify only: formal database files under `D:\Guo\ZhiPing\data`

**Interfaces:**
- Consumes: repaired detail branch plus Tasks 1-3.
- Produces: aggregate acceptance evidence with no job title, company, URL, JD, resume, prompt, model output, cookie, token, or credential.

- [ ] **Step 1: Request final independent branch review**

Review:

```text
base: 109d6acd5f10ea27a139ee9a4d4fd6d0c79f15c1
head: git rev-parse HEAD
specs:
  docs/superpowers/specs/2026-08-09-boss-standalone-detail-read-and-tab-group-design.md
  docs/superpowers/specs/2026-08-09-existing-edge-session-first-design.md
plans:
  docs/superpowers/plans/2026-08-09-boss-standalone-detail-read.md
  docs/superpowers/plans/2026-08-09-existing-edge-session-first.md
```

The reviewer must verify:

- no BOSS communication/application path changed;
- no automatic Edge-to-portable fallback;
- new defaults use `edge`;
- explicit portable/9222 remains functional;
- historical frozen modes remain unchanged;
- ordinary Edge readiness is read-only and topology-strict;
- detail identity, serial routing, budget recovery, abort propagation, and privacy fixes remain intact.

Resolve every Critical or Important finding and rerun the full offline gate.

- [ ] **Step 2: Verify and stop only the temporary project-owned Edge**

First verify ordinary Edge through the existing Edge Control adapter:

```powershell
node -e "const {EdgeControlAdapter}=require('./src/adapters/browser/edge_control'); (async()=>{const b=new EdgeControlAdapter(); const tabs=(await b.listTabs()).filter(t=>/zhipin\\.com/i.test(t.url)); const paths=tabs.map(t=>new URL(t.url).pathname); console.log({count:tabs.length,sameWindow:new Set(tabs.map(t=>t.windowId)).size===1,paths:paths.sort()}); if(tabs.length!==2||new Set(tabs.map(t=>t.windowId)).size!==1||!paths.includes('/web/geek/jobs')||!paths.includes('/web/geek/chat'))process.exit(2)})().catch(e=>{console.error(e.code||e.message);process.exit(1)})"
```

Then identify the 9222 listener and inspect its command line. Stop it only when all are true:

- listener executable is `msedge.exe`;
- command line contains `--remote-debugging-port=9222`;
- command line contains the exact repair-worktree `.runtime\edge-profile`;
- ordinary Edge readiness already passed.

After identity verification, close the project-owned browser gracefully through
its verified CDP endpoint:

```powershell
$listener = Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction Stop
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
$expectedProfile = 'D:\DevData\RoleFlow-readonly-scan-20260809-v1\.runtime\edge-profile'
if ($process.Name -ne 'msedge.exe' `
  -or $process.CommandLine -notmatch '--remote-debugging-port=9222' `
  -or $process.CommandLine -notlike "*$expectedProfile*") {
  throw 'Refusing to stop an unverified Edge process'
}
node -e "const {CdpBrowserAdapter}=require('./src/adapters/browser/cdp'); new CdpBrowserAdapter({port:9222}).browserCommand('Browser.close').catch(e=>{console.error(e.code||e.message);process.exit(1)})"
```

Wait for port 9222 to close. If it remains open, stop and report the verified
identity instead of force-killing a process. Do not close or modify ordinary
Edge.

- [ ] **Step 3: Recompute formal database hashes before resume**

Run:

```powershell
$formalFiles = @(
  'D:\Guo\ZhiPing\data\jobs.sqlite',
  'D:\Guo\ZhiPing\data\jobs.sqlite-wal',
  'D:\Guo\ZhiPing\data\jobs.sqlite-shm'
)
$formalBefore = $formalFiles | ForEach-Object {
  [pscustomobject]@{
    Path = $_
    Hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash
    Length = (Get-Item -LiteralPath $_).Length
  }
}
$formalBefore | ConvertTo-Json -Compress
```

Expected: hashes equal the previously recorded values.

- [ ] **Step 4: Resume the existing isolated batch through ordinary Edge**

From the repair worktree:

```powershell
$acceptanceDb = 'D:\DevData\RoleFlow-boss-detail-acceptance-20260809-v1\jobs.sqlite'
node src/cli.js scan `
  --db $acceptanceDb `
  --plan 1 `
  --site boss `
  --browser edge `
  --scan-mode broad `
  --keywords "RAG,Agent" `
  --max-cards 10 `
  --max-detail-total 6 `
  --browser-page-budget 20 `
  --resume-batch 1 `
  --model-settings-root D:\Guo\ZhiPing
```

Stop immediately on login, risk control, page loss, target mismatch, browser loss, checkpoint failure, lease loss, or abort.

Do not click, communicate, apply, create a BOSS tab, close a BOSS tab, or use the fixed communication tab.

- [ ] **Step 5: Verify aggregate acceptance evidence**

Use storage APIs instead of assuming a `site_access_events` SQL table:

```powershell
$acceptanceDb = 'D:\DevData\RoleFlow-boss-detail-acceptance-20260809-v1\jobs.sqlite'
@'
const { openDb, listSiteAccessEvents } = require("./src/core/storage");
const db = openDb(process.argv[2]);
const events = listSiteAccessEvents(db, { site: "boss", limit: 10000 });
const counts = new Map();
for (const event of events) {
  if (event.action !== "pane_detail_result") continue;
  const key = JSON.stringify([
    event.details?.accessMode || "",
    event.details?.outcome || "",
    event.details?.errorCode || ""
  ]);
  counts.set(key, (counts.get(key) || 0) + 1);
}
console.log(JSON.stringify({
  integrity: db.prepare("pragma quick_check").get(),
  outcomes: [...counts].map(([key, count]) => {
    const [accessMode, outcome, errorCode] = JSON.parse(key);
    return { accessMode, outcome, errorCode, count };
  })
}));
db.close();
'@ | node - $acceptanceDb
```

Acceptance passes only when:

- `quick_check` is `ok`;
- `standalone_detail/succeeded` is at least 1;
- login/risk/page-loss counts for the resumed attempt are zero;
- ordinary Edge still has exactly the two same-window fixed BOSS tabs;
- no communication/application access action exists;
- formal database path/hash/length pairs equal `$formalBefore`.

- [ ] **Step 6: Create the main checkpoint, merge, and verify**

In `D:\Guo\ZhiPing`:

```powershell
git status --short --branch
$mainHead = git rev-parse HEAD
$checkpoint = 'checkpoint/pre-merge-phase-2-boss-detail-20260809'
if (git show-ref --verify --quiet "refs/tags/$checkpoint") {
  throw "Checkpoint already exists: $checkpoint"
}
git tag -a $checkpoint $mainHead -m 'Checkpoint before phase 2 BOSS detail and existing Edge merge'
git merge --no-ff codex/boss-pane-switch-repair -m "merge: repair BOSS detail reads and reuse existing Edge"
npm.cmd test
git diff --check
git status --short --branch
```

Expected:

- checkpoint tag points to pre-merge `main`;
- merge has no conflict;
- full offline suite passes on merged `main`;
- `main` is clean and ahead of `origin/main`;
- repair worktree, branches, and checkpoint tags remain available for rollback.
