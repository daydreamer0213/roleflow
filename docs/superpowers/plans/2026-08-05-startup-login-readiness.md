# RoleFlow 同窗启动与登录就绪门禁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `Start.bat` 在一个项目专用 Edge 窗口中打开 BOSS 与 RoleFlow 工作台，并在登录和搜索页真正就绪前禁用主继承模式。

**Architecture:** 新增纯状态映射器，把现有 `BossSiteAdapter.preflight()` 的结果转换成不含隐私信息的稳定就绪状态；新增同窗标签页准备器，由便携 CDP 复用或创建工作台标签页并选择当前标签页。Dashboard 提供只读状态接口并用前端轮询控制主继承按钮，服务端原有启动预检继续作为不可绕过的最终门禁。

**Tech Stack:** Node.js 22 CommonJS、现有 CDP/BOSS 适配器、原生 `http` Dashboard、Windows PowerShell 5.1、assert-based smoke tests。

## Global Constraints

- `Start.bat` 启动后只允许一个项目专用 Edge 窗口。
- 初始标签页必须是一个承担 `BOSS-SEARCH` 角色的 BOSS 标签页和一个 RoleFlow 工作台标签页。
- 项目专用 Edge 固定使用 `.runtime\edge-profile` 和 `127.0.0.1:9222`。
- 工作台必须通过项目 CDP 在 `BOSS-SEARCH` 所在窗口打开，不得调用系统默认浏览器。
- 就绪状态固定为 `browser_unavailable`、`boss_tab_missing`、`login_required`、`search_page_required`、`risk_control`、`ready`。
- 就绪接口只返回状态码、用户提示、布尔值和检查时间，不返回 URL、筛选参数、DOM 文本、账号、Cookie 或其他登录信息。
- 工作台每 5 秒执行一次只读本地 CDP/DOM 检查，不导航、不点击、不滚动、不刷新 BOSS。
- 未登录、非搜索页、风控、浏览器断开或检查失败时，主继承模式“执行一轮”必须保持禁用。
- 登录和搜索页就绪后只解除门禁，不自动创建工作流或开始扫描。
- 前端门禁不能替代 `POST /api/workflow-run` 的现有服务端预检。
- 不启动 Edge Control，不在便携 CDP 与 Edge Control 之间自动回退。
- 不修改关键词、匹配规则、模型、预算、配额、候选人资料、岗位数据或数据库 schema。
- 通信阶段继续要求确认不可变清单并再次点击“开始沟通”，且 `BOSS-COMMUNICATION` 只能在同一窗口创建。

---

### Task 1: Add a privacy-safe BOSS readiness state mapper

**Files:**
- Create: `src/core/browser_readiness.js`
- Create: `tests/browser_readiness_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: `preflight(): Promise<{isSearchPage:boolean}>`, plus errors carrying existing BOSS/browser `code`.
- Produces: `inspectBossBrowserReadiness({preflight, now}): Promise<{status,ready,message,checkedAt}>`.
- Produces: `BROWSER_READINESS_MESSAGES`, keyed by the six fixed status strings.

- [ ] **Step 1: Write the failing readiness mapper test**

Create `tests/browser_readiness_smoke.js`:

```js
const assert = require("node:assert");
const {
  BROWSER_READINESS_MESSAGES,
  inspectBossBrowserReadiness
} = require("../src/core/browser_readiness");

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function inspect(result) {
  return inspectBossBrowserReadiness({
    now: () => "2099-01-01T00:00:00.000Z",
    preflight: async () => {
      if (result instanceof Error) throw result;
      return result;
    }
  });
}

(async () => {
  const cases = [
    ["BROWSER_DISCONNECTED", "browser_unavailable"],
    ["BROWSER_TIMEOUT", "browser_unavailable"],
    ["BOSS_TAB_REQUIRED", "boss_tab_missing"],
    ["BOSS_LOGIN_REQUIRED", "login_required"],
    ["BOSS_RISK_CONTROL", "risk_control"],
    ["BOSS_SEARCH_PAGE_INVALID", "search_page_required"],
    ["BOSS_SEARCH_PAGE_LOST", "search_page_required"]
  ];
  for (const [code, status] of cases) {
    assert.deepStrictEqual(await inspect(codedError(code)), {
      status,
      ready: false,
      message: BROWSER_READINESS_MESSAGES[status],
      checkedAt: "2099-01-01T00:00:00.000Z"
    });
  }

  assert.strictEqual((await inspect({ isSearchPage: false })).status, "search_page_required");
  assert.deepStrictEqual(await inspect({ isSearchPage: true }), {
    status: "ready",
    ready: true,
    message: BROWSER_READINESS_MESSAGES.ready,
    checkedAt: "2099-01-01T00:00:00.000Z"
  });

  const privateState = await inspect({
    isSearchPage: true,
    url: "https://www.zhipin.com/web/geek/jobs?query=secret",
    account: "private-account",
    cookie: "private-cookie",
    bodyText: "private-dom"
  });
  assert.deepStrictEqual(Object.keys(privateState).sort(), ["checkedAt", "message", "ready", "status"]);

  await assert.rejects(
    () => inspect(codedError("UNEXPECTED_READINESS_FAILURE")),
    (error) => error.code === "UNEXPECTED_READINESS_FAILURE"
  );
  console.log("browser_readiness_smoke ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Add `"browser_readiness_smoke.js"` immediately after `"browser_transport_smoke.js"` in `tests/run_all.js`.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
node tests/browser_readiness_smoke.js
```

Expected: FAIL with `Cannot find module '../src/core/browser_readiness'`.

- [ ] **Step 3: Implement the mapper**

Create `src/core/browser_readiness.js`:

```js
const BROWSER_READINESS_MESSAGES = Object.freeze({
  browser_unavailable: "项目专用 Edge 尚未启动或已经断开。",
  boss_tab_missing: "未找到 BOSS 标签页，请在项目专用 Edge 打开 BOSS。",
  login_required: "等待登录：请在 BOSS 标签页完成登录。",
  search_page_required: "请在 BOSS 标签页打开岗位搜索结果页并设置本轮筛选。",
  risk_control: "BOSS 当前要求安全验证，请完成验证后再继续。",
  ready: "继承模式已就绪，可以执行一轮。"
});

const CODE_TO_STATUS = Object.freeze({
  BROWSER_DISCONNECTED: "browser_unavailable",
  BROWSER_TIMEOUT: "browser_unavailable",
  BOSS_TAB_REQUIRED: "boss_tab_missing",
  BOSS_LOGIN_REQUIRED: "login_required",
  BOSS_RISK_CONTROL: "risk_control",
  BOSS_SEARCH_PAGE_INVALID: "search_page_required",
  BOSS_SEARCH_PAGE_LOST: "search_page_required"
});

async function inspectBossBrowserReadiness({
  preflight,
  now = () => new Date().toISOString()
}) {
  if (typeof preflight !== "function") {
    throw new TypeError("inspectBossBrowserReadiness requires preflight()");
  }
  try {
    const state = await preflight();
    return readinessSnapshot(state?.isSearchPage ? "ready" : "search_page_required", now);
  } catch (error) {
    const status = CODE_TO_STATUS[error?.code];
    if (!status) throw error;
    return readinessSnapshot(status, now);
  }
}

function readinessSnapshot(status, now) {
  return {
    status,
    ready: status === "ready",
    message: BROWSER_READINESS_MESSAGES[status],
    checkedAt: now()
  };
}

module.exports = {
  BROWSER_READINESS_MESSAGES,
  inspectBossBrowserReadiness
};
```

- [ ] **Step 4: Run the mapper test and verify GREEN**

Run:

```powershell
node tests/browser_readiness_smoke.js
```

Expected:

```text
browser_readiness_smoke ok
```

- [ ] **Step 5: Commit the readiness mapper**

```powershell
git add -- src/core/browser_readiness.js tests/browser_readiness_smoke.js tests/run_all.js
git commit -m "feat: classify portable browser readiness"
```

---

### Task 2: Prepare BOSS and dashboard tabs in one Edge window

**Files:**
- Create: `src/core/workspace_tabs.js`
- Create: `tests/workspace_tabs_smoke.js`
- Modify: `src/adapters/browser/cdp.js`
- Modify: `src/cli.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: `browser.listTabs()`, `browser.createTab(openerTabId,url)`, `browser.bringToFront(tabId)`, and `inspectReadiness()`.
- Produces: `prepareWorkspaceTabs({browser,dashboardUrl,inspectReadiness}): Promise<{bossTabId,dashboardTabId,windowId,status}>`.
- Produces: CLI command `workspace-tabs --dashboard-url http://127.0.0.1:8787/ --browser portable --cdp-port 9222`.

- [ ] **Step 1: Write the failing same-window tests**

Create `tests/workspace_tabs_smoke.js`:

```js
const assert = require("node:assert");
const { prepareWorkspaceTabs } = require("../src/core/workspace_tabs");

function fakeBrowser(initialTabs, createdTab = null) {
  const state = {
    tabs: initialTabs.map((tab) => ({ ...tab })),
    createCalls: [],
    frontCalls: []
  };
  return {
    state,
    async listTabs() { return state.tabs.map((tab) => ({ ...tab })); },
    async createTab(openerTabId, url) {
      state.createCalls.push({ openerTabId, url });
      if (!createdTab) throw new Error("unexpected createTab");
      state.tabs.push({ ...createdTab, url });
      return createdTab.id;
    },
    async bringToFront(tabId) { state.frontCalls.push(tabId); }
  };
}

(async () => {
  const boss = {
    id: "boss-search",
    url: "https://www.zhipin.com/web/geek/jobs",
    windowId: 42
  };
  const dashboard = {
    id: "roleflow-dashboard",
    url: "http://127.0.0.1:8787/",
    windowId: 42
  };

  const existing = fakeBrowser([boss, dashboard]);
  const existingResult = await prepareWorkspaceTabs({
    browser: existing,
    dashboardUrl: dashboard.url,
    inspectReadiness: async () => ({ status: "ready" })
  });
  assert.deepStrictEqual(existingResult, {
    bossTabId: boss.id,
    dashboardTabId: dashboard.id,
    windowId: 42,
    status: "ready"
  });
  assert.deepStrictEqual(existing.state.createCalls, []);
  assert.deepStrictEqual(existing.state.frontCalls, [dashboard.id]);

  const created = fakeBrowser([boss], {
    id: "created-dashboard",
    windowId: 42
  });
  const createdResult = await prepareWorkspaceTabs({
    browser: created,
    dashboardUrl: dashboard.url,
    inspectReadiness: async () => ({ status: "login_required" })
  });
  assert.strictEqual(createdResult.dashboardTabId, "created-dashboard");
  assert.deepStrictEqual(created.state.createCalls, [{
    openerTabId: boss.id,
    url: dashboard.url
  }]);
  assert.deepStrictEqual(created.state.frontCalls, [boss.id]);

  const wrongWindow = fakeBrowser([boss, {
    ...dashboard,
    windowId: 99
  }]);
  await assert.rejects(
    () => prepareWorkspaceTabs({
      browser: wrongWindow,
      dashboardUrl: dashboard.url,
      inspectReadiness: async () => ({ status: "ready" })
    }),
    (error) => error.code === "WORKSPACE_DASHBOARD_WINDOW_MISMATCH"
  );

  await assert.rejects(
    () => prepareWorkspaceTabs({
      browser: fakeBrowser([dashboard]),
      dashboardUrl: dashboard.url,
      inspectReadiness: async () => ({ status: "ready" })
    }),
    (error) => error.code === "BOSS_TAB_REQUIRED"
  );

  await assert.rejects(
    () => prepareWorkspaceTabs({
      browser: fakeBrowser([
        boss,
        {
          id: "boss-other-window",
          url: "https://www.zhipin.com/web/geek/chat",
          windowId: 99
        }
      ]),
      dashboardUrl: dashboard.url,
      inspectReadiness: async () => ({ status: "ready" })
    }),
    (error) => error.code === "BOSS_WINDOW_MISMATCH"
  );

  console.log("workspace_tabs_smoke ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Add `"workspace_tabs_smoke.js"` after `"browser_readiness_smoke.js"` in `tests/run_all.js`.

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```powershell
node tests/workspace_tabs_smoke.js
```

Expected: `workspace_tabs_smoke.js` fails because `src/core/workspace_tabs.js` does not exist.

- [ ] **Step 3: Implement the same-window tab preparer**

Create `src/core/workspace_tabs.js`:

```js
function workspaceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isBossTab(tab) {
  try {
    return /(^|\.)zhipin\.com$/i.test(new URL(tab?.url || "").hostname);
  } catch {
    return false;
  }
}

function isDashboardTab(tab, dashboardUrl) {
  try {
    const actual = new URL(tab?.url || "");
    const expected = new URL(dashboardUrl);
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function selectBossTab(tabs) {
  const bossTabs = tabs.filter(isBossTab);
  return bossTabs.find((tab) => /\/web\/geek\/jobs/i.test(new URL(tab.url).pathname))
    || bossTabs[0]
    || null;
}

async function prepareWorkspaceTabs({ browser, dashboardUrl, inspectReadiness }) {
  if (!browser || typeof inspectReadiness !== "function") {
    throw new TypeError("prepareWorkspaceTabs requires browser and inspectReadiness()");
  }
  let tabs = await browser.listTabs();
  const bossTab = selectBossTab(tabs);
  if (!bossTab) {
    throw workspaceError("BOSS_TAB_REQUIRED", "项目专用 Edge 中没有 BOSS 标签页。");
  }
  const bossTabs = tabs.filter(isBossTab);
  if (bossTabs.some((tab) => String(tab.windowId) !== String(bossTab.windowId))) {
    throw workspaceError(
      "BOSS_WINDOW_MISMATCH",
      "BOSS 标签页分布在多个项目 Edge 窗口，请关闭多余窗口后重试。"
    );
  }
  if (!Number.isInteger(bossTab.windowId)) {
    throw workspaceError("BROWSER_COMMAND_FAILED", "BOSS 标签页没有可靠的窗口身份。");
  }

  const dashboardTabs = tabs.filter((tab) => isDashboardTab(tab, dashboardUrl));
  const crossWindow = dashboardTabs.find((tab) =>
    String(tab.windowId) !== String(bossTab.windowId)
  );
  if (crossWindow) {
    throw workspaceError(
      "WORKSPACE_DASHBOARD_WINDOW_MISMATCH",
      "RoleFlow 工作台位于另一个项目 Edge 窗口，请关闭多余窗口后重试。"
    );
  }

  let dashboardTab = dashboardTabs[0] || null;
  if (!dashboardTab) {
    const dashboardTabId = await browser.createTab(bossTab.id, dashboardUrl);
    // CdpBrowserAdapter.createTab() returns only after proving same-window identity.
    dashboardTab = {
      id: dashboardTabId,
      url: dashboardUrl,
      windowId: bossTab.windowId
    };
  }

  const readiness = await inspectReadiness();
  await browser.bringToFront(readiness.status === "ready" ? dashboardTab.id : bossTab.id);
  return {
    bossTabId: bossTab.id,
    dashboardTabId: dashboardTab.id,
    windowId: bossTab.windowId,
    status: readiness.status
  };
}

module.exports = { prepareWorkspaceTabs };
```

- [ ] **Step 4: Make the shared tab-creation error generic**

In `src/adapters/browser/cdp.js`, change:

```js
throw browserError("BROWSER_COMMAND_FAILED", "CDP created the communication tab in a different browser window.");
```

to:

```js
throw browserError("BROWSER_COMMAND_FAILED", "CDP created the tab in a different browser window.");
```

The same method now creates either the local dashboard tab or the communication tab.

- [ ] **Step 5: Add the CLI entry point**

At the imports in `src/cli.js`, add:

```js
const { inspectBossBrowserReadiness } = require("./core/browser_readiness");
const { prepareWorkspaceTabs } = require("./core/workspace_tabs");
```

In `main()`, before `openDb(...)`, add:

```js
  if (command === "workspace-tabs") return prepareWorkspaceTabsCommand(args);
```

Add before `communicate()`:

```js
async function prepareWorkspaceTabsCommand(
  args,
  {
    browserFactory = createBrowser,
    siteAdapterFactory = createSiteAdapter,
    prepareTabs = prepareWorkspaceTabs
  } = {}
) {
  const browserMode = String(args.browser || "portable").trim().toLowerCase();
  const cdpPort = Number(args["cdp-port"] || 9222);
  if (browserMode !== "portable" || cdpPort !== 9222) {
    const error = new Error("工作台同窗启动固定使用项目专用 Edge 的 9222 端口。");
    error.code = "WORKSPACE_PORTABLE_BROWSER_REQUIRED";
    throw error;
  }
  const dashboardUrl = String(args["dashboard-url"] || "http://127.0.0.1:8787/");
  const parsedDashboardUrl = new URL(dashboardUrl);
  if (parsedDashboardUrl.protocol !== "http:"
    || !["127.0.0.1", "localhost"].includes(parsedDashboardUrl.hostname)) {
    const error = new Error("工作台 URL 必须是本机 HTTP 地址。");
    error.code = "WORKSPACE_DASHBOARD_URL_INVALID";
    throw error;
  }
  const browser = browserFactory({ browser: "portable", "cdp-port": 9222 });
  const adapter = siteAdapterFactory("boss", { browser, logger });
  const result = await prepareTabs({
    browser,
    dashboardUrl: parsedDashboardUrl.toString(),
    inspectReadiness: () => inspectBossBrowserReadiness({
      preflight: () => adapter.preflight()
    })
  });
  console.log(`RoleFlow workspace tabs ready: ${result.status}`);
  return result;
}
```

Export `prepareWorkspaceTabsCommand` from `src/cli.js` for offline tests.

- [ ] **Step 6: Run same-window and existing transport tests**

Run:

```powershell
node tests/workspace_tabs_smoke.js
node tests/browser_transport_smoke.js
```

Expected:

```text
workspace_tabs_smoke ok
browser_transport_smoke ok
```

- [ ] **Step 7: Commit same-window preparation**

```powershell
git add -- src/core/workspace_tabs.js src/adapters/browser/cdp.js src/cli.js tests/workspace_tabs_smoke.js tests/run_all.js
git commit -m "feat: keep workspace tabs in portable Edge"
```

---

### Task 3: Add the dashboard readiness API and inherited-mode gate

**Files:**
- Modify: `src/dashboard/server.js`
- Test: `tests/workflow_dashboard_smoke.js`

**Interfaces:**
- Consumes: `inspectBossBrowserReadiness({preflight})`.
- Produces: `GET /api/browser-readiness` returning `{status,ready,message,checkedAt}` with HTTP 200 for all expected browser states.
- Produces: plan-page markup with `data-browser-readiness-button` and five-second local polling.

- [ ] **Step 1: Add failing dashboard readiness API tests**

In `tests/workflow_dashboard_smoke.js`, inject a mutable readiness probe when creating the server:

```js
  let browserReadiness = {
    status: "login_required",
    ready: false,
    message: "等待登录：请在 BOSS 标签页完成登录。",
    checkedAt: "2099-01-01T00:00:00.000Z"
  };
```

Pass:

```js
    browserReadinessProbe: async () => ({ ...browserReadiness })
```

Add this helper beside the existing `getText()` helper:

```js
async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.json() };
}
```

After the server starts, add:

```js
  const loginReadiness = await getJson(baseUrl, "/api/browser-readiness");
  assert.strictEqual(loginReadiness.status, 200);
  assert.deepStrictEqual(loginReadiness.body, browserReadiness);

  const gatedPlanPage = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.match(gatedPlanPage.body, /data-browser-readiness-button/);
  assert.match(gatedPlanPage.body, /data-browser-base-disabled="false"/);
  assert.match(gatedPlanPage.body, /id="browser-readiness-status"/);
  assert.match(gatedPlanPage.body, /\/api\/browser-readiness/);
  assert.match(gatedPlanPage.body, /5000/);
  assert.match(gatedPlanPage.body, /disabled[^>]*>执行一轮/);

  browserReadiness = {
    status: "ready",
    ready: true,
    message: "继承模式已就绪，可以执行一轮。",
    checkedAt: "2099-01-01T00:00:05.000Z"
  };
  const readyReadiness = await getJson(baseUrl, "/api/browser-readiness");
  assert.deepStrictEqual(readyReadiness.body, browserReadiness);
```

For an existing fixture whose plan dependency is stale or matching card is unconfirmed, assert its HTML contains:

```js
assert.match(blockedPage.body, /data-browser-base-disabled="true"/);
```

Add a probe-throws case in the smallest dashboard fixture:

```js
browserReadinessProbe: async () => {
  throw Object.assign(new Error("fixture unexpected readiness failure"), {
    code: "UNEXPECTED_READINESS_FAILURE"
  });
}
```

Expected API response: HTTP 500, while the rendered button remains disabled.

- [ ] **Step 2: Run dashboard tests and verify RED**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
```

Expected: FAIL because `createDashboardServer` ignores `browserReadinessProbe`, the API returns 404, and the plan page lacks readiness markup.

- [ ] **Step 3: Add the default readiness probe and API route**

At the imports in `src/dashboard/server.js`, add:

```js
const { inspectBossBrowserReadiness } = require("../core/browser_readiness");
```

Add:

```js
function createDashboardBrowserReadinessProbe({ logger }) {
  return async () => {
    const browser = new CdpBrowserAdapter({ port: PORTABLE_CDP_PORT });
    const adapter = new boss.BossSiteAdapter({ browser, logger });
    return inspectBossBrowserReadiness({
      preflight: () => adapter.preflight()
    });
  };
}
```

Extend `createDashboardServer(...)` with:

```js
browserReadinessProbe = null
```

Inside the factory, resolve it once:

```js
  const resolvedBrowserReadinessProbe = browserReadinessProbe
    || createDashboardBrowserReadinessProbe({ logger });
```

Add the route immediately after `/health`:

```js
      if (req.method === "GET" && url.pathname === "/api/browser-readiness") {
        return sendJson(res, 200, await resolvedBrowserReadinessProbe());
      }
```

Do not catch expected browser states in the route; the mapper already converts them to HTTP-200 state objects. Unexpected errors continue through the existing 500 error boundary.

- [ ] **Step 4: Add the plan-page readiness gate**

Change the new-workflow action in `renderWorkflowLaunchPanel()` to:

```js
      : `<form class="workflow-start" method="post" action="/api/workflow-run">
          <input type="hidden" name="planId" value="${planRecord.id}">
          <input type="hidden" name="cdpPort" value="9222">
          <input type="hidden" name="browserMode" value="portable">
          <span class="hint">使用项目专用 Edge 的 BOSS 搜索页</span>
          <button
            class="workflow-primary"
            name="action"
            value="start"
            data-browser-readiness-button
            data-browser-base-disabled="${disabled ? "true" : "false"}"
            disabled>执行一轮</button>
        </form>`;
```

Add the readiness status and script to the returned panel:

```html
<div id="browser-readiness-status" class="workflow-budget" role="status">
  正在检查项目专用 Edge 与 BOSS 登录状态……
</div>
<script>
(function(){
  const statusNode = document.getElementById('browser-readiness-status');
  const button = document.querySelector('[data-browser-readiness-button]');
  if (!statusNode || !button) return;
  const baseDisabled = button.dataset.browserBaseDisabled === 'true';
  async function refreshReadiness() {
    try {
      const response = await fetch('/api/browser-readiness', {cache:'no-store'});
      if (!response.ok) throw new Error('readiness request failed');
      const state = await response.json();
      statusNode.textContent = state.message || '浏览器状态未知。';
      statusNode.dataset.status = state.status || 'unknown';
      button.disabled = baseDisabled || state.status !== 'ready';
    } catch {
      statusNode.textContent = '无法确认项目专用 Edge 状态，请检查本地服务。';
      statusNode.dataset.status = 'browser_unavailable';
      button.disabled = true;
    }
  }
  refreshReadiness();
  setInterval(refreshReadiness, 5000);
})();
</script>
```

Keep the current `handleWorkflowRunStart()` call to `inheritedContextResolver(...)` unchanged. It is the authoritative server-side recheck.

- [ ] **Step 5: Run focused dashboard and inherited-context tests**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
node tests/observability_context_smoke.js
node tests/workflow_end_to_end_smoke.js
```

Expected: all three scripts print their `ok` line.

- [ ] **Step 6: Commit the dashboard gate**

```powershell
git add -- src/dashboard/server.js tests/workflow_dashboard_smoke.js
git commit -m "feat: gate inherited workflow on BOSS readiness"
```

---

### Task 4: Route one-click startup into the same Edge window

**Files:**
- Modify: `scripts/start-workspace.ps1`
- Modify: `tests/self_check.js`
- Modify: `README.md`
- Modify: `docs/daily_workflow.md`

**Interfaces:**
- Consumes: `run.ps1 workspace-tabs --dashboard-url <url> --browser portable --cdp-port 9222`.
- Produces: one project-owned Edge window containing the BOSS and dashboard tabs.

- [ ] **Step 1: Strengthen the failing startup contract**

In `tests/self_check.js`, require:

```js
assert(workspaceLauncher.includes('"workspace-tabs"'));
assert(workspaceLauncher.includes('"--dashboard-url", $url'));
assert(workspaceLauncher.includes('"--browser", "portable"'));
assert(workspaceLauncher.includes('"--cdp-port", [string]$CdpPort'));
assert(!workspaceLauncher.includes("Start-Process $url"));
assert(readme.includes("同一个项目专用 Edge 窗口"));
assert(readme.includes("等待登录"));
```

Run:

```powershell
node tests/self_check.js
```

Expected: FAIL because `start-workspace.ps1` still invokes `Start-Process $url`.

- [ ] **Step 2: Replace default-browser launch with the workspace-tabs command**

Replace the final launch block in `scripts/start-workspace.ps1` with:

```powershell
$url = "http://127.0.0.1:$Port/"
Write-Host "RoleFlow is ready: $url"
Write-Host "浏览器：工作台与 BOSS 位于同一个项目专用 Edge 窗口（不需要 Edge Control 扩展）"
Write-Host "未登录时请先在 BOSS 标签页登录；设置好搜索条件后切回工作台。"

if (-not $NoOpen) {
  $workspaceArgs = @(
    "workspace-tabs",
    "--dashboard-url", $url,
    "--browser", "portable",
    "--cdp-port", [string]$CdpPort
  )
  & $RunScript @workspaceArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Do not use `Start-Process` for the URL.

- [ ] **Step 3: Update operator documentation**

In `README.md`, replace the quick-start browser steps with:

```markdown
6. `Start.bat` 会打开一个项目专用 Edge 窗口，并在同一窗口保留 BOSS 与 RoleFlow 工作台标签页。
7. 第一次使用若尚未登录，先在 BOSS 标签页完成登录；工作台会显示“等待登录”，并禁用“执行一轮”。
8. 登录后打开岗位搜索结果页并设置筛选，再切回工作台。状态变为“继承模式已就绪”后，手动点击“执行一轮”。
9. 登录成功不会自动扫描；扫描完成后仍需确认清单并再次点击“开始沟通”。
```

In `docs/daily_workflow.md`, document:

```markdown
双击 `Start.bat` 后，BOSS 与 RoleFlow 工作台位于同一个项目专用 Edge 窗口。工作台每 5 秒只读检查一次现有 BOSS 页面：未登录、非搜索页或安全验证状态都会禁用“执行一轮”。登录并设置好搜索结果页后，切回工作台等待状态变为“继承模式已就绪”，再由用户手动启动。
```

- [ ] **Step 4: Run startup, browser, and dashboard contract tests**

Run:

```powershell
node tests/self_check.js
node tests/workspace_tabs_smoke.js
node tests/browser_readiness_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: all four scripts print their `ok` line.

- [ ] **Step 5: Commit one-click same-window startup**

```powershell
git add -- scripts/start-workspace.ps1 tests/self_check.js README.md docs/daily_workflow.md
git commit -m "docs: make login readiness the startup path"
```

---

### Task 5: Full regression and live login-readiness acceptance

**Files:**
- Verify: all files changed in Tasks 1-4
- Preserve: `D:\Guo\ZhiPing\data\jobs.sqlite`
- Preserve: `D:\Guo\ZhiPing\.runtime\edge-profile`

**Interfaces:**
- Consumes: committed same-window startup implementation.
- Produces: fresh offline evidence and a user-controlled live acceptance checkpoint.

- [ ] **Step 1: Run all offline checks**

Run:

```powershell
$env:npm_config_cache = "D:\DevData\npm-cache"
npm.cmd test
```

Expected: exit code `0`, including the new readiness and workspace-tab checks.

- [ ] **Step 2: Check branch integrity**

Run:

```powershell
git diff --check
git status --short --branch
```

Expected: `git diff --check` exits `0`; the feature worktree has no tracked or untracked implementation files.

- [ ] **Step 3: Confirm the wrong temporary runtime is stopped**

Run:

```powershell
Get-NetTCPConnection -LocalAddress 127.0.0.1 -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 8787, 9222 }
```

Expected: no listener before the acceptance startup.

- [ ] **Step 4: Start the feature worktree without Edge Control**

Before startup, run the existing Edge Control status probe and require it to be stopped. Then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-workspace.ps1
```

Expected:

- one project-owned Edge window;
- one BOSS tab and one RoleFlow dashboard tab in that window;
- dashboard and CDP health endpoints respond;
- Edge Control remains stopped.

- [ ] **Step 5: Verify the login-required state without scanning**

With a fresh/unlogged project profile, inspect only:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/browser-readiness" -TimeoutSec 3
```

Expected:

```text
status: login_required
ready: false
```

Confirm no workflow, scan run, or communication batch is created by readiness polling.

- [ ] **Step 6: Present the user login checkpoint**

Tell the user:

```text
工作台和 BOSS 已位于同一个项目专用 Edge 窗口。当前工作台显示“等待登录”，且“执行一轮”已禁用。请在 BOSS 标签页完成登录，打开岗位搜索结果页并设置筛选，然后切回工作台告诉我“已登录并设置好搜索页”。
```

Do not log in, navigate, scan, communicate, or resolve ambiguity on the user's behalf.

- [ ] **Step 7: Verify ready after the user completes login**

After the user checkpoint, query `/api/browser-readiness` again.

Expected:

```text
status: ready
ready: true
```

Verify the main inherited button is enabled only if all existing non-browser plan gates also pass. Do not click it automatically.

---

## Plan Self-Review

- Spec coverage: Tasks 1-5 cover all six readiness states, privacy-safe output, one-window tabs, startup integration, UI polling, service-side recheck, documentation, offline regression and live acceptance.
- Scope: no schema, matching, model, keyword, data, scan or communication authorization change.
- Type consistency: Tasks 2-4 consume the exact `{status,ready,message,checkedAt}` contract defined in Task 1; the CLI and startup command use the exact `workspace-tabs` name and `--dashboard-url`, `--browser`, `--cdp-port` arguments.
- Safety: every non-ready state disables the front-end button; existing `handleWorkflowRunStart()` remains the authoritative recheck.
- Completeness scan: every implementation step contains concrete paths, interfaces, code, commands and expected results.
