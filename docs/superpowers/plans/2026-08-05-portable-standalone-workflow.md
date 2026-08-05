# Portable Standalone Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RoleFlow's primary inherited workflow run entirely through the project-owned Edge/CDP session so a user can complete scanning and confirmed communication without Codex, Edge Control, or an Edge Control bridge.

**Architecture:** Keep `Start.bat` as the single launcher and use the existing project-local Edge profile on CDP port `9222`. Add fail-closed CDP window identity, persist the browser authority in existing workflow and communication JSON, route new inherited workflows through `portable`, and retain `edge` only for legacy workflow recovery and explicit advanced entry points.

**Tech Stack:** Windows batch and PowerShell, Node.js 22 CommonJS, Microsoft Edge CDP over loopback HTTP/WebSocket, built-in Node test fixtures, SQLite JSON columns.

## Global Constraints

- New primary inherited workflows use `browserMode=portable` and `cdpPort=9222`.
- `Start.bat` must not require or start Edge Control.
- Keep Edge Control CLI and advanced UI compatibility; do not auto-fallback between browser transports.
- Keep BOSS access serial, read-only until the user confirms a communication batch and separately clicks “开始沟通”.
- Search and communication tabs must have real, equal CDP `windowId` values before communication can proceed.
- Do not weaken login, risk-control, target-identity, one-click, or ambiguous-result guards.
- Do not change model prompts, recommendation logic, keyword selection, budgets, quotas, candidate data, or job data.
- Do not add a database column or migration; use existing workflow `planner_json` and communication `policy_json`.
- Legacy inherited workflows without `planner.browserMode` continue to resolve as `edge`.
- The project-owned Edge profile remains `.runtime\edge-profile`, and CDP remains bound to `127.0.0.1:9222`.

---

## File Map

- Modify `src/adapters/browser/cdp.js`: expose trustworthy tab `windowId` values and verify newly created communication tabs stay in the opener window.
- Modify `src/adapters/sites/boss.js`: keep window-identity failures closed and give a direct project-Edge recovery instruction.
- Modify `tests/browser_transport_smoke.js`: prove CDP window identity, same-window tab creation, and fail-closed behavior.
- Modify `src/dashboard/server.js`: choose the portable browser for new inherited workflows, persist/restore browser authority, render portable controls, and pass portable authority into communication.
- Modify `tests/workflow_dashboard_smoke.js`: cover portable start, portable resume, legacy edge resume, and portable communication form state.
- Modify `tests/observability_context_smoke.js`: inject a portable browser factory so inherited preflight no longer constructs Edge Control.
- Modify `src/core/communication_batches.js`: bind a workflow communication batch to the workflow's stored browser authority and persist port `9222` in `policy_json`.
- Modify `tests/communication_batch_storage_smoke.js`: cover browser-authority persistence and mismatch rejection.
- Modify `tests/dashboard_communication_batch_smoke.js`: prove portable communication child arguments include the CDP port.
- Modify `scripts/start-portable-edge.ps1`: bind CDP explicitly to loopback and open the BOSS search route.
- Modify `scripts/start-workspace.ps1`: print the exact standalone next action.
- Modify `tests/self_check.js`: make the standalone startup contract executable.
- Modify `README.md`: document extension-free one-click operation.
- Modify `docs/daily_workflow.md`: make project-owned Edge the primary workflow authority.

---

### Task 1: Add Fail-Closed CDP Window Identity

**Files:**
- Modify: `src/adapters/browser/cdp.js:1-250`
- Modify: `src/adapters/sites/boss.js:1225-1278`
- Test: `tests/browser_transport_smoke.js:6-317`
- Test: `tests/boss_communication_page_smoke.js:391-434`

**Interfaces:**
- Consumes: CDP `/json/list`, `/json/version`, `Browser.getWindowForTarget`, `Target.createTarget`, and `Target.closeTarget`.
- Produces: `CdpBrowserAdapter.listTabs(): Promise<Array<{id,title,url,active,windowId,webSocketDebuggerUrl}>>`.
- Produces: `CdpBrowserAdapter.createTab(openerTabId, url): Promise<string>` that returns only a same-window target ID.

- [ ] **Step 1: Write failing window-identity tests**

In `tests/browser_transport_smoke.js`, extend the successful CDP block immediately after installing `FakeWebSocket`:

```js
    websocket.mode = "respond";
    const identifiedTabs = await cdp.listTabs();
    assert.strictEqual(identifiedTabs.length, 1);
    assert.strictEqual(identifiedTabs[0].id, "cdp-tab");
    assert.strictEqual(identifiedTabs[0].windowId, 42);
    assert.strictEqual(countMethod(websocket.messages, "Browser.getWindowForTarget"), 1);

    websocket.mode = "window-identity-missing";
    await rejectsWithCode(() => cdp.listTabs(), "BROWSER_COMMAND_FAILED");

    websocket.mode = "respond";
```

After the existing successful `createTab` assertion, add:

```js
    assert.strictEqual(countMethod(websocket.messages, "Browser.getWindowForTarget") >= 2, true);

    websocket.mode = "created-window-mismatch";
    websocket.messages.length = 0;
    await rejectsWithCode(
      () => cdp.createTab("cdp-tab", "https://example.test/wrong-window"),
      "BROWSER_COMMAND_FAILED"
    );
    assert.strictEqual(countMethod(websocket.messages, "Target.createTarget"), 1);
    assert.strictEqual(countMethod(websocket.messages, "Target.closeTarget"), 1);
```

In the three unknown-window assertions in `tests/boss_communication_page_smoke.js`, require the actionable message as well as the code:

```js
    (error) => error.code === "BOSS_COMMUNICATION_TAB_WINDOW_UNKNOWN"
      && /重新运行 Start\.bat/.test(error.message)
```

Replace the entire `FakeWebSocket.send()` method with this complete method-aware response:

```js
    send(message) {
      const payload = JSON.parse(message);
      control.messages.push(payload);
      queueMicrotask(() => {
        const dispatchCount = control.messages.filter((item) => item.method === "Input.dispatchMouseEvent").length;
        let result = {};
        let error = null;
        if (payload.method === "Browser.getWindowForTarget") {
          if (control.mode === "window-identity-missing") result = {};
          else if (control.mode === "created-window-mismatch" && payload.params.targetId === "cdp-created-tab") result = { windowId: 99 };
          else result = { windowId: 42 };
        } else if (payload.method === "Target.createTarget") {
          result = { targetId: "cdp-created-tab" };
        } else if (control.mode === "fail-third-dispatch"
          && payload.method === "Input.dispatchMouseEvent"
          && dispatchCount === 3) {
          error = { message: "dispatch failed" };
        } else if (control.mode === "disconnect") {
          this.emit("close", { code: 1006, reason: "test disconnect" });
          return;
        } else if (control.mode === "timeout") {
          return;
        }
        this.emit("message", {
          data: JSON.stringify(error ? { id: payload.id, error } : { id: payload.id, result })
        });
      });
    }
```

Change the successful create assertion from `state.versionRequests === 1` to:

```js
    assert.strictEqual(state.versionRequests, 3);
```

- [ ] **Step 2: Run the transport test and verify RED**

Run:

```powershell
node tests/browser_transport_smoke.js
```

Expected: FAIL because `identifiedTabs[0].windowId` is `undefined`.

- [ ] **Step 3: Implement browser-level CDP commands and real window IDs**

In `src/adapters/browser/cdp.js`, replace `listTabs()` with:

```js
  async listTabs() {
    const pages = await this.requestJson("/json/list");
    if (!Array.isArray(pages)) {
      throw browserError("BROWSER_COMMAND_FAILED", "CDP tab list response is not an array.");
    }
    const pageTabs = pages.filter((page) => page.type === "page" && page.webSocketDebuggerUrl);
    return Promise.all(pageTabs.map(async (page, index) => ({
      id: page.id,
      title: page.title || "",
      url: page.url || "",
      active: index === 0,
      windowId: await this.windowIdForTarget(page.id),
      webSocketDebuggerUrl: page.webSocketDebuggerUrl
    })));
  }
```

In `src/adapters/sites/boss.js`, replace both `BOSS_COMMUNICATION_TAB_WINDOW_UNKNOWN` messages with:

```js
"无法确认项目专用 Edge 标签页所属窗口。请关闭多余的项目专用 Edge 窗口后重新运行 Start.bat。"
```

Add these methods before `activeTabId()`:

```js
  async browserCommand(method, params = {}) {
    const version = await this.requestJson("/json/version");
    if (!version?.webSocketDebuggerUrl) {
      throw browserError("BROWSER_COMMAND_FAILED", "CDP browser version response has no browser websocket URL.");
    }
    return sendCdp(version.webSocketDebuggerUrl, method, params, this.timeoutMs);
  }

  async windowIdForTarget(targetId) {
    const result = await this.browserCommand("Browser.getWindowForTarget", {
      targetId: String(targetId || "")
    });
    if (!Number.isInteger(result?.windowId)) {
      throw browserError("BROWSER_COMMAND_FAILED", `CDP target has no reliable browser window identity: ${targetId}`);
    }
    return result.windowId;
  }
```

Replace `createTab()` with:

```js
  async createTab(openerTabId, url = "about:blank") {
    const opener = await this.findTab(openerTabId);
    const result = await this.browserCommand("Target.createTarget", {
      url: String(url || "about:blank"),
      newWindow: false,
      background: true
    });
    if (!result?.targetId) throw browserError("BROWSER_COMMAND_FAILED", "Browser did not return a new tab id.");
    const createdWindowId = await this.windowIdForTarget(result.targetId);
    if (String(createdWindowId) !== String(opener.windowId)) {
      try {
        await this.browserCommand("Target.closeTarget", { targetId: result.targetId });
      } catch {
        // The target was created by this call; preserve the primary window-mismatch error.
      }
      throw browserError("BROWSER_COMMAND_FAILED", "CDP created the communication tab in a different browser window.");
    }
    return result.targetId;
  }
```

- [ ] **Step 4: Run transport and communication-page tests and verify GREEN**

Run:

```powershell
node tests/browser_transport_smoke.js
node tests/boss_communication_page_smoke.js
```

Expected:

```text
browser_transport_smoke ok
boss_communication_page_smoke ok
```

- [ ] **Step 5: Commit CDP window identity**

```powershell
git add -- src/adapters/browser/cdp.js src/adapters/sites/boss.js tests/browser_transport_smoke.js tests/boss_communication_page_smoke.js
git commit -m "feat: add portable Edge window identity"
```

---

### Task 2: Route New Inherited Workflows Through Portable Edge

**Files:**
- Modify: `src/dashboard/server.js:108-1306,2433-2601`
- Test: `tests/workflow_dashboard_smoke.js:41-380,525-624`
- Test: `tests/observability_context_smoke.js:115-153`

**Interfaces:**
- Consumes: `CdpBrowserAdapter({port})`, form fields `browserMode` and `cdpPort`, and persisted `workflow.planner`.
- Produces: new inherited planners containing `{browserMode:"portable", cdpPort:9222}`.
- Produces: legacy inherited planners without `browserMode` resolving to `{browserMode:"edge", cdpPort:9222}`.
- Produces: `resolveLiveInheritedContext({db,plan,matchingContext,logger,browserMode,cdpPort,browserFactory})`.

- [ ] **Step 1: Rewrite workflow dashboard expectations to portable and add legacy recovery coverage**

In `tests/workflow_dashboard_smoke.js`:

1. Capture inherited resolver authority:

```js
  let inheritedResolutionInput = null;
  const inheritedContextResolver = async ({ plan, matchingContext, browserMode, cdpPort }) => {
    inheritedResolutionCount += 1;
    inheritedResolutionInput = { browserMode, cdpPort };
```

2. Change the preflight rejection requests at lines 137-141 to:

```js
    const rejected = await postForm(baseUrl, "/api/workflow-run", {
      planId: saved.planId,
      browserMode: "portable",
      cdpPort: 9222,
      action: "start"
    });
```

3. Replace the old portable-rejection block with:

```js
  const edgeStart = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
    browserMode: "edge",
    action: "start"
  });
  assert.strictEqual(edgeStart.status, 409);
  assert.match(edgeStart.body, /INHERITED_PORTABLE_REQUIRED/);
```

4. Start the accepted workflow with:

```js
  const started = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
    browserMode: "portable",
    cdpPort: 9222,
    action: "start"
  });
```

5. After reading the created workflow, add:

```js
  assert.deepStrictEqual(inheritedResolutionInput, { browserMode: "portable", cdpPort: 9222 });
  assert.strictEqual(workflow.planner.browserMode, "portable");
  assert.strictEqual(workflow.planner.cdpPort, 9222);
  assert.deepStrictEqual(
    spawns[0].args.slice(spawns[0].args.indexOf("--browser"), spawns[0].args.indexOf("--browser") + 4),
    ["--browser", "portable", "--cdp-port", "9222"]
  );
```

6. Change inherited resume forms and accepted resume requests from `edge` to `portable`, and assert:

```js
  assert.match(inheritedInterruptedPage.body, /<input type="hidden" name="browserMode" value="portable">/);
  assert.match(inheritedInterruptedPage.body, /项目专用 Edge 的 BOSS 搜索页/);
  assert.doesNotMatch(inheritedInterruptedPage.body, /<select name="browserMode">/);
```

7. Add a legacy inherited workflow fixture after the accepted portable resume:

```js
  const legacyInherited = createWorkflowRun(db, {
    id: "workflow-legacy-inherited-edge",
    profileId: saved.profileId,
    planId: saved.planId,
    localDay: "2099-01-02",
    sequence: 1,
    targetSuccessCount: 1,
    candidateGap: 1,
    scanNeeded: true,
    keywords: [{ word: "RAG工程师", priority: "A", maxCards: 10 }],
    budget: { maxDetailTotal: 10, browserPageBudget: 2 },
    planner: {
      ...frozenPlanner,
      browserMode: undefined,
      cdpPort: undefined
    }
  });
  transitionWorkflowRun(db, { id: legacyInherited.id, status: "scanning" });
  transitionWorkflowRun(db, {
    id: legacyInherited.id,
    status: "interrupted",
    errorCode: "LEGACY_EDGE_RECOVERY",
    errorMessage: "legacy inherited browser authority"
  });
  const legacyPage = await getText(baseUrl, `/workflow?runId=${legacyInherited.id}`);
  assert.match(legacyPage.body, /name="browserMode" value="edge"/);
  assert.match(legacyPage.body, /旧版当前 Edge/);
```

In `tests/observability_context_smoke.js`, pass a browser factory and assert portable authority without reading Edge Control configuration:

```js
      const browserFactoryCalls = [];
      await resolveLiveInheritedContext({
        db: {
          prepare() {
            return { get() { return null; } };
          }
        },
        plan: {
          id: 9,
          profileId: 7,
          profileVersionId: 11,
          plan: {
            keywords: [{ word: "RAG工程师", priority: "A", reason: "fixture" }]
          }
        },
        matchingContext: { matchingCard: {} },
        browserMode: "portable",
        cdpPort: 9222,
        browserFactory(input) {
          browserFactoryCalls.push(input);
          return {};
        },
        logger: {
          info(event, fields = {}) { diagnosticEvents.push({ event, fields }); },
          warn(event, fields = {}) { diagnosticEvents.push({ event, fields }); }
        }
      });
      assert.deepStrictEqual(browserFactoryCalls, [{ browserMode: "portable", cdpPort: 9222 }]);
```

Add a disconnected portable-browser assertion outside the patched `BossSiteAdapter` block:

```js
    await assert.rejects(
      () => resolveLiveInheritedContext({
        db: {},
        plan: {},
        matchingContext: {},
        logger: { info() {}, warn() {} },
        browserMode: "portable",
        cdpPort: 9222,
        browserFactory() {
          const error = new Error("fixture portable browser is stopped");
          error.code = "BROWSER_DISCONNECTED";
          throw error;
        }
      }),
      (error) => error.code === "PORTABLE_EDGE_REQUIRED"
        && /Start\.bat/.test(error.message)
    );
```

- [ ] **Step 2: Run dashboard tests and verify RED**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
node tests/observability_context_smoke.js
```

Expected: `workflow_dashboard_smoke.js` FAILS because portable inherited start still returns `INHERITED_EDGE_REQUIRED`.

- [ ] **Step 3: Add portable browser construction and inherited start authority**

At the imports in `src/dashboard/server.js`, add:

```js
const { CdpBrowserAdapter } = require("../adapters/browser/cdp");
```

After `VALID_STATUSES`, add:

```js
const PORTABLE_CDP_PORT = 9222;

function normalizeCdpPort(value, fallback = PORTABLE_CDP_PORT) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw appError("INVALID_SCAN_INPUT", "CDP 端口必须是 1 到 65535 之间的整数。", { statusCode: 409 });
  }
  return port;
}

function createDashboardBrowser({ browserMode, cdpPort }) {
  if (browserMode === "portable") return new CdpBrowserAdapter({ port: normalizeCdpPort(cdpPort) });
  if (browserMode === "edge") return new EdgeControlAdapter();
  throw appError("WORKFLOW_BROWSER_MODE_INVALID", "浏览器模式必须是当前 Edge 或项目专用 Edge。", { statusCode: 409 });
}

function resolveNewInheritedBrowser(input = {}) {
  const browserMode = String(input.browserMode || "portable").trim().toLowerCase();
  if (browserMode !== "portable") {
    throw appError(
      "INHERITED_PORTABLE_REQUIRED",
      "新的继承模式必须使用项目专用 Edge。",
      { statusCode: 409 }
    );
  }
  const cdpPort = normalizeCdpPort(input.cdpPort);
  if (cdpPort !== PORTABLE_CDP_PORT) {
    throw appError(
      "INHERITED_PORTABLE_PORT_REQUIRED",
      "新的继承模式固定使用项目专用 Edge 的 9222 端口。",
      { statusCode: 409 }
    );
  }
  return {
    browserMode,
    cdpPort
  };
}
```

Extend `resolveLiveInheritedContext` parameters and browser construction:

```js
async function resolveLiveInheritedContext({
  db,
  plan,
  matchingContext,
  logger,
  browserMode = "portable",
  cdpPort = PORTABLE_CDP_PORT,
  browserFactory = createDashboardBrowser
}) {
  try {
    const adapter = new boss.BossSiteAdapter({
      browser: browserFactory({ browserMode, cdpPort }),
      logger
    });
```

Change the invalid-search-page message to:

```js
"请先在项目专用 Edge 打开 BOSS 岗位搜索结果页。"
```

At the start of the `resolveLiveInheritedContext` catch block, add:

```js
    if (error?.code === "BROWSER_DISCONNECTED") {
      throw appError(
        "PORTABLE_EDGE_REQUIRED",
        "项目专用 Edge 未启动或已经断开。请重新运行 Start.bat。",
        { statusCode: 409, cause: error }
      );
    }
    if (error?.code === "BOSS_LOGIN_REQUIRED") {
      throw appError(
        "BOSS_LOGIN_REQUIRED",
        "请先在项目专用 Edge 登录 BOSS。",
        { statusCode: 409, cause: error }
      );
    }
```

At the beginning of `handleWorkflowRunStart`, replace the old edge-only check with:

```js
    const browserAuthority = resolveNewInheritedBrowser(params);
```

Pass authority to the resolver:

```js
    const inheritedContext = await inheritedContextResolver({
      db,
      plan,
      matchingContext,
      logger,
      browserMode: browserAuthority.browserMode,
      cdpPort: browserAuthority.cdpPort
    });
```

Persist it in `planner`:

```js
        browserMode: browserAuthority.browserMode,
        cdpPort: browserAuthority.cdpPort,
        acquisitionMode: inheritedContext.acquisitionMode,
```

Use it for the child scan:

```js
        cdpPort: browserAuthority.cdpPort,
        browserMode: browserAuthority.browserMode,
```

- [ ] **Step 4: Preserve portable authority on resume while keeping legacy edge**

Replace the inherited branch of `resolveWorkflowResumeBrowserMode` with:

```js
  if (acquisitionMode === "inherited") {
    const stored = String(workflow?.planner?.browserMode || "edge").trim().toLowerCase();
    if (!["edge", "portable"].includes(stored)) {
      throw appError(
        "WORKFLOW_BROWSER_MODE_INVALID",
        "本轮保存的浏览器模式无效。",
        { statusCode: 409 }
      );
    }
    if (requested && requested !== stored) {
      throw appError(
        "WORKFLOW_BROWSER_MODE_MISMATCH",
        `本轮已固定使用 ${stored}，不能切换浏览器。`,
        { statusCode: 409 }
      );
    }
    return stored;
  }
```

In `handleWorkflowRunResume`, resolve the port without accepting an override for stored portable inherited workflows:

```js
    const browserMode = resolveWorkflowResumeBrowserMode(workflow, params.browserMode);
    const cdpPort = acquisitionMode === "inherited" && browserMode === "portable"
      ? normalizeCdpPort(workflow.planner?.cdpPort)
      : normalizeCdpPort(params.cdpPort);
```

Pass `cdpPort` directly to `startPlanScan`.

Replace the inherited branch of `renderWorkflowResumeForm` with:

```js
  if (workflow.planner?.acquisitionMode === "inherited") {
    const browserMode = resolveWorkflowResumeBrowserMode(workflow);
    const label = browserMode === "portable"
      ? "使用项目专用 Edge 的 BOSS 搜索页"
      : "使用旧版当前 Edge 的 BOSS-SEARCH 标签页";
    return `<form method="post" action="/api/workflow-run/resume">${identity}<input type="hidden" name="browserMode" value="${browserMode}"><span class="hint">${label}</span><button>继续本轮</button></form>`;
  }
```

Change `renderWorkflowLaunchPanel` hidden values and hint to:

```html
<input type="hidden" name="cdpPort" value="9222">
<input type="hidden" name="browserMode" value="portable">
<span class="hint">使用项目专用 Edge 的 BOSS 搜索页</span>
```

- [ ] **Step 5: Run focused workflow tests and verify GREEN**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
node tests/observability_context_smoke.js
node tests/workflow_scan_smoke.js
node tests/scan_execution_smoke.js
```

Expected: all four scripts print their `ok` line.

- [ ] **Step 6: Commit portable inherited workflow**

```powershell
git add -- src/dashboard/server.js tests/workflow_dashboard_smoke.js tests/observability_context_smoke.js
git commit -m "feat: run inherited workflow in portable Edge"
```

---

### Task 3: Bind Confirmed Communication to Portable Browser Authority

**Files:**
- Modify: `src/core/communication_batches.js:33-126,480-500`
- Modify: `src/dashboard/server.js:1748-1842,2590-2601,2987-3009`
- Test: `tests/communication_batch_storage_smoke.js:25-180`
- Test: `tests/dashboard_communication_batch_smoke.js:28-165`
- Test: `tests/workflow_dashboard_smoke.js:525-541`

**Interfaces:**
- Consumes: `workflow.planner.browserMode`, `workflow.planner.cdpPort`, and `communication_batches.policy_json`.
- Produces: `batch.policySnapshot.browser = {mode:"portable", cdpPort:9222}` for portable batches.
- Produces: portable communication process arguments `--browser portable --cdp-port 9222`.

- [ ] **Step 1: Write failing browser-authority persistence and process tests**

In `tests/communication_batch_storage_smoke.js`, change the existing `safeStop` batch to portable and add its policy assertion:

```js
  const safeStop = createCommunicationBatch(db, {
    planId,
    jobIds: [alreadyCommunicatedId],
    browserMode: "portable"
  });
  assert.deepStrictEqual(safeStop.policySnapshot.browser, {
    mode: "portable",
    cdpPort: 9222
  });
```

In the existing workflow-linked fixture in `tests/workflow_communication_smoke.js`, create the workflow planner with:

```js
    planner: {
      acquisitionMode: "inherited",
      browserMode: "portable",
      cdpPort: 9222,
      replacementBuffer: 2
    }
```

Before creating the successful batch, add:

```js
  assert.throws(
    () => createCommunicationBatch(db, {
      workflowRunId: workflow.id,
      planId,
      jobIds: selectedIds,
      browserMode: "edge"
    }),
    (error) => error.code === "WORKFLOW_COMMUNICATION_BROWSER_MISMATCH"
  );
```

Change the successful workflow batch to:

```js
    const batch = createCommunicationBatch(db, {
      workflowRunId: workflow.id,
      planId,
      jobIds: selectedIds,
      browserMode: "portable",
      now
    });
```

In `tests/dashboard_communication_batch_smoke.js`, make the main successful batch portable:

```js
  const created = await postJson(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: [fixture.primaryId, fixture.backupId],
    browserMode: "portable"
  });
```

After starting it, assert:

```js
  assert.deepStrictEqual(
    spawns[0].args.slice(spawns[0].args.indexOf("--browser")),
    ["--browser", "portable", "--cdp-port", "9222"]
  );
```

In `tests/workflow_dashboard_smoke.js`, change the confirmed browser mode to `portable` and assert the review form contains:

```js
  assert.match(reviewPage.body, /name="browserMode" value="portable"/);
```

- [ ] **Step 2: Run communication tests and verify RED**

Run:

```powershell
node tests/communication_batch_storage_smoke.js
node tests/workflow_communication_smoke.js
node tests/dashboard_communication_batch_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: FAIL because `policySnapshot.browser` is missing and the child process lacks `--cdp-port`.

- [ ] **Step 3: Persist and enforce communication browser authority**

In `createCommunicationBatch()` after validating `browserMode`, add:

```js
  const workflowBrowserMode = workflow
    ? String(workflow.planner?.browserMode
      || (workflow.planner?.acquisitionMode === "inherited" ? "edge" : "")
    ).trim().toLowerCase()
    : "";
  if (workflowBrowserMode && browserMode !== workflowBrowserMode) {
    throw codedError(
      "WORKFLOW_COMMUNICATION_BROWSER_MISMATCH",
      "communication browser mode differs from the workflow browser authority"
    );
  }
  const browserPolicy = {
    mode: browserMode,
    ...(browserMode === "portable"
      ? { cdpPort: normalizeCdpPort(workflow?.planner?.cdpPort) }
      : {})
  };
```

Add this local helper near the numeric validation helpers in `src/core/communication_batches.js`:

```js
function normalizeCdpPort(value) {
  const port = Number(value || 9222);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw codedError("COMMUNICATION_CDP_PORT_INVALID", "portable communication requires a valid CDP port");
  }
  return port;
}
```

Include browser authority in `policyJson`:

```js
  const policyJson = JSON.stringify({
    ...(input.policySnapshot || {}),
    browser: browserPolicy,
    ...(workflow ? {
      workflowRunId: workflow.id,
      targetSuccessCount: workflow.targetSuccessCount,
      replacementBuffer
    } : {})
  });
```

- [ ] **Step 4: Pass portable CDP authority to the communication child**

In `startCommunicationProcess()`, build arguments before calling `spawnProcess`:

```js
  const commandArgs = [
    "--disable-warning=ExperimentalWarning",
    "src/cli.js",
    "communicate",
    "--db", dbPath,
    "--batch", String(batch.id),
    "--browser", batch.browserMode
  ];
  if (batch.browserMode === "portable") {
    commandArgs.push(
      "--cdp-port",
      String(batch.policySnapshot?.browser?.cdpPort || 9222)
    );
  }
```

Pass `commandArgs` as the second `spawnProcess` argument.

In `renderWorkflowReview()`, derive the hidden mode from the frozen planner:

```js
  const browserMode = String(
    workflow.planner?.browserMode
      || (workflow.planner?.acquisitionMode === "inherited" ? "edge" : "portable")
  ).trim().toLowerCase();
```

Render:

```html
<input type="hidden" name="browserMode" value="${escapeAttr(browserMode)}">
```

In `renderCommunicationBuilderPage()`, make the project-owned browser the normal default while keeping the advanced route:

```html
<label>浏览器 <select name="browserMode"><option value="portable">项目专用 Edge</option><option value="edge">当前 Edge（高级）</option></select></label>
```

- [ ] **Step 5: Run communication and workflow tests and verify GREEN**

Run:

```powershell
node tests/communication_batch_storage_smoke.js
node tests/workflow_communication_smoke.js
node tests/dashboard_communication_batch_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/communication_executor_smoke.js
node tests/boss_communication_page_smoke.js
```

Expected: all six scripts print their `ok` line.

- [ ] **Step 6: Commit portable communication authority**

```powershell
git add -- src/core/communication_batches.js src/dashboard/server.js tests/communication_batch_storage_smoke.js tests/workflow_communication_smoke.js tests/dashboard_communication_batch_smoke.js tests/workflow_dashboard_smoke.js
git commit -m "feat: keep workflow communication in portable Edge"
```

---

### Task 4: Make the One-Click Startup Contract Explicit

**Files:**
- Modify: `scripts/start-portable-edge.ps1:1-92`
- Modify: `scripts/start-workspace.ps1:1-52`
- Modify: `tests/self_check.js:1-55`
- Modify: `README.md:24-45,122-150`
- Modify: `docs/daily_workflow.md:1-90`

**Interfaces:**
- Consumes: `Start.bat`, system Edge, project `.runtime\edge-profile`, port `9222`.
- Produces: a dashboard on `127.0.0.1:8787` and a project-owned Edge CDP endpoint on `127.0.0.1:9222`.

- [ ] **Step 1: Write failing standalone startup assertions**

In `tests/self_check.js`, add:

```js
const workspaceLauncher = fs.readFileSync(path.join(root, "scripts", "start-workspace.ps1"), "utf8");
const portableEdgeLauncher = fs.readFileSync(path.join(root, "scripts", "start-portable-edge.ps1"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

assert(workspaceLauncher.includes('start-portable-edge.ps1'));
assert(!workspaceLauncher.includes('start-edge-control.ps1'));
assert(workspaceLauncher.includes("项目专用 Edge"));
assert(portableEdgeLauncher.includes("--remote-debugging-address=127.0.0.1"));
assert(portableEdgeLauncher.includes("https://www.zhipin.com/web/geek/jobs"));
assert(readme.includes("不需要 Edge Control 扩展"));
assert(readme.includes("项目专用 Edge"));
```

- [ ] **Step 2: Run self-check and verify RED**

Run:

```powershell
node tests/self_check.js
```

Expected: FAIL because the launcher does not yet set `--remote-debugging-address=127.0.0.1` and the README lacks the standalone statement.

- [ ] **Step 3: Harden and clarify project-owned Edge startup**

In `scripts/start-portable-edge.ps1`, change the default URL:

```powershell
  [string]$StartUrl = "https://www.zhipin.com/web/geek/jobs",
```

Add the explicit loopback argument immediately before the port argument:

```powershell
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$Port",
```

Replace the final first-use message with:

```powershell
Write-Host "Project Edge is ready. First use: log in to BOSS once, then keep a BOSS search-results tab open."
```

In `scripts/start-workspace.ps1`, add after the ready URL:

```powershell
Write-Host "浏览器：项目专用 Edge（不需要 Edge Control 扩展）"
Write-Host "下一步：在项目专用 Edge 登录 BOSS、打开岗位搜索结果页并设置筛选，然后在工作台点击“执行一轮”。"
```

- [ ] **Step 4: Update current user documentation**

In `README.md`, make the quick-start browser steps say:

```markdown
6. 在自动打开的项目专用 Edge 中登录 BOSS，并打开岗位搜索结果页；登录状态保存在项目的 `.runtime\edge-profile`。
7. 项目专用 Edge 由本机 CDP 直接控制，不需要 Codex、Edge Control 扩展或 Edge Control 桥接服务。
8. 在“今日求职任务”点击“执行一轮”。扫描和模型分析完成后检查默认勾选清单，确认后再点击“开始沟通”。
```

Replace the primary-path search-condition paragraph in `docs/daily_workflow.md` with:

```markdown
启动主工作流时，RoleFlow 使用 `Start.bat` 打开的项目专用 Edge。当前项目专用 Edge 停在有效 BOSS 搜索结果页时，RoleFlow 继承该页面的城市、区域、薪资、经验、学历、行业等 URL 参数，只删除页码并逐次替换 `query` 关键词。首次使用只需在这个 Edge 中登录一次，后续登录状态保存在 `.runtime\edge-profile`。

主工作流不会自动切换到日常 Edge，也不依赖 Edge Control。高级扫描入口仍可显式选择“当前 Edge”，用于兼容已有环境。
```

Document the normal daily sequence:

```markdown
双击 `Start.bat` -> 在项目专用 Edge 设置 BOSS 搜索条件 -> 点击“执行一轮” -> 审核并确认清单 -> 点击“开始沟通”。
```

- [ ] **Step 5: Run startup contract tests and verify GREEN**

Run:

```powershell
node tests/self_check.js
node tests/browser_transport_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: all three scripts print their `ok` line.

- [ ] **Step 6: Commit standalone startup and docs**

```powershell
git add -- scripts/start-portable-edge.ps1 scripts/start-workspace.ps1 tests/self_check.js README.md docs/daily_workflow.md
git commit -m "docs: make portable startup the normal path"
```

---

### Task 5: Full Regression and Extension-Free Readiness Check

**Files:**
- Verify: all changed files from Tasks 1-4
- Preserve: `docs/superpowers/plans/2026-08-05-inherited-scope-resume-hardening-completion.md`

**Interfaces:**
- Consumes: committed portable workflow implementation.
- Produces: fresh offline evidence and a local extension-free startup readiness report.

- [ ] **Step 1: Run all offline checks**

Run:

```powershell
npm.cmd test
```

Expected: exit code `0` and every test in `tests/run_all.js` prints `ok`.

- [ ] **Step 2: Check patch integrity**

Run:

```powershell
git diff --check
git status --short --branch
```

Expected: `git diff --check` exits `0`; the only unrelated untracked file remains:

```text
?? docs/superpowers/plans/2026-08-05-inherited-scope-resume-hardening-completion.md
```

- [ ] **Step 3: Start the standalone workspace without Edge Control**

Confirm the Edge Control bridge is not running:

```powershell
try {
  $config = Get-Content -Raw (Join-Path $env:APPDATA "CodexEdgeControl\config.json") | ConvertFrom-Json
  $token = $config.authToken
  if (-not $token) { $token = $config.token }
  Invoke-RestMethod -Uri "http://$($config.host):$($config.port)/api/status" -Headers @{ "x-edge-control-token" = $token } -TimeoutSec 2 | Out-Null
  $bridgeRunning = $true
} catch {
  $bridgeRunning = $false
}
if ($bridgeRunning) { throw "Edge Control bridge must remain stopped for this acceptance check." }
Write-Host "Edge Control bridge is stopped."
```

Start RoleFlow:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-workspace.ps1
```

Expected: a project-owned Edge window and the local dashboard open without starting the Edge Control bridge.

- [ ] **Step 4: Verify local services**

Run:

```powershell
$dashboard = Invoke-RestMethod -Uri "http://127.0.0.1:8787/health" -TimeoutSec 3
$cdp = Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 3
if (-not $dashboard.ok) { throw "Dashboard health check failed." }
if (-not $cdp.webSocketDebuggerUrl) { throw "Portable Edge CDP health check failed." }
Write-Host "Standalone RoleFlow services are ready."
```

Expected:

```text
Standalone RoleFlow services are ready.
```

- [ ] **Step 5: Present the user acceptance checkpoint**

Tell the user:

```text
项目已在不启动 Edge Control 的情况下就绪。请在项目专用 Edge 登录 BOSS（如果尚未登录），打开岗位搜索结果页并设置本轮筛选，然后告诉我“搜索页已准备好”。接下来只进行只读继承范围检查；真正沟通仍由你确认清单并再次点击“开始沟通”。
```

Do not navigate, scan, communicate, or resolve ambiguous outcomes before the corresponding user-controlled checkpoint.
