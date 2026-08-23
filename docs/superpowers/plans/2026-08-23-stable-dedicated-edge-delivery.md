# Stable Dedicated Edge Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RoleFlow use a stable, real Microsoft Edge profile by default and carry that one browser authority through startup, scanning, message discovery, and communication without weakening BOSS safety.

**Architecture:** Keep the existing `portable` internal transport and `CdpBrowserAdapter`; do not build another browser bridge. Resolve the stable profile once in the PowerShell startup helper, freeze `{ browserMode, cdpPort, profilePath }` in the Dashboard process, and reject any later request that disagrees with it. Reuse the existing two-tab BOSS lifecycle for both Edge Control and CDP, while extending tab identity validation to preserve numeric Edge IDs and string CDP target IDs in their original types.

**Tech Stack:** Node.js 22 CommonJS, Windows PowerShell 5.1, Microsoft Edge CDP, SQLite, Inno Setup 6, built-in `node:test`-style smoke scripts using `node:assert`.

## Global Constraints

- Default browser profile is exactly `%LOCALAPPDATA%\RoleFlow\BrowserProfile`; an explicit `-ProfileDir` remains an override, and a relative override remains project-relative.
- Ordinary startup freezes internal mode `portable`, CDP port `9222`, and the resolved absolute profile path. Edge Control remains an explicit advanced mode and is never an automatic fallback.
- The two fixed BOSS baseline tabs remain one search page and one communication page in the same browser window. Message discovery may add only one same-window background detail tab, serially, and must close it before continuing.
- Never call `Page.bringToFront` outside the existing user-invoked workspace startup helper. Scanning, JD reading, analysis, message discovery, communication, polling, retry, and recovery stay in the background.
- Preserve BOSS pacing, shared cooldowns, access budgets, checkpoints, login/risk/page-loss stops, immutable communication authorization, and ambiguous-result no-retry behavior.
- Production scanning remains `trusted_pane` only. Do not repair, validate, delete, or enable `search_page_api`; do not reintroduce general `standalone_detail`.
- Tests must not generate, copy, rename, or execute a fake `msedge.exe`, must not start real Edge, and must not read, write, or delete the real `%LOCALAPPDATA%\RoleFlow\BrowserProfile`.
- Installer build data stays under `D:\DevData\RoleFlow-installer` when practical. The public application cannot assume that a user has a `D:` drive.
- No automatic BOSS communication, application, push, merge, release, or deletion of browser login data.
- Keep the internal compatibility name `portable`; user-facing copy says “RoleFlow 专用 Edge（推荐）” and calls Edge Control “使用当前 Edge（高级，需要浏览器连接组件）”.

---

## File and Interface Map

### PowerShell startup boundary

- `scripts/lib/startup-identity.ps1` owns profile resolution, Edge launch arguments, listener/process identity, and profile-in-use checks.
- `scripts/start-portable-edge.ps1` discovers the installed Edge, consumes the shared helpers, and starts or verifies one dedicated Edge.
- `scripts/start-workspace.ps1` freezes the resolved browser authority, verifies an existing Dashboard against it, starts the Dashboard, and invokes the sole foreground-guidance helper.
- `scripts/migrate-browser-profile.ps1` is the separate opt-in copy-only migration entry point.

### Node browser authority

The Dashboard freezes this exact internal shape for its lifetime:

```js
{
  browserMode: "portable", // or "edge" only for the explicit advanced entry
  cdpPort: 9222,           // null for edge
  profilePath: "C:\\Users\\<user>\\AppData\\Local\\RoleFlow\\BrowserProfile" // "" for edge
}
```

- `src/cli.js::startDashboard()` passes it to `createDashboardServer()`.
- `src/dashboard/server.js` returns it from `/health`, injects it into all new work, and rejects mismatches.
- Workflow and communication records continue to persist `browserMode` and, for `portable`, `cdpPort` in their existing snapshots.

### Browser tab identity

Create `src/core/browser_tab_identity.js` with these exact exports:

```js
function isBrowserTabId(value) {}
function sameBrowserTabId(left, right) {}
function sortedBrowserTabIds(values) {}
```

`isBrowserTabId` accepts either a positive integer or a non-empty string. `sameBrowserTabId` requires equal type and value. `sortedBrowserTabIds` returns the original typed values in deterministic number-before-string order; it never rewrites a numeric ID as a string.

---

### Task 1: Remove the 360 Trigger and Establish the Stable Profile Boundary

**Files:**
- Modify: `tests/startup_scripts_smoke.js:1-963`
- Modify: `tests/background_process_visibility_smoke.js:1-66`
- Modify: `scripts/lib/startup-identity.ps1:1-132`
- Modify: `scripts/start-portable-edge.ps1:1-95`
- Modify: `scripts/scan-portable.ps1:1-45`

**Interfaces:**
- Produces: `Resolve-RoleFlowBrowserProfilePath(ProjectRoot, ProfileDir, LocalAppDataPath) -> absolute string`
- Produces: `New-RoleFlowPortableEdgeArguments(Port, ProfilePath, StartUrl) -> string[]`
- Produces: `Assert-RoleFlowPortableEdgeProcessSnapshot(ProcessName, ExecutablePath, CommandLine, EdgePath, Port, ProfilePath) -> $true or throws`
- Produces: `Get-RoleFlowTcpListenerSnapshot(Port) -> { querySucceeded, listeners: [{ localAddress, owningProcess }] }`
- Produces: `Get-RoleFlowEdgeProcessSnapshot() -> { querySucceeded, processes: [...] }`
- Produces: `Assert-RoleFlowPortableEdgeListenerSnapshot(ListenerSnapshot, ProcessQuerySnapshot, EdgePath, Port, ProfilePath) -> listener PID or throws`
- Produces: `Assert-RoleFlowPortableEdgeListenerIdentity(Port, ProfilePath, EdgePath) -> listener PID or throws`
- Produces: `Assert-RoleFlowBrowserProfileNotInUse(ProfilePath, ProcessQuerySnapshot) -> $true or throws`

- [ ] **Step 1: Replace the executable stub with safe failing tests before running anything**

Delete `compileEdgeStub`, `startEdgeStub`, `edgeCompileSource`, `testForeignCdpIdentityRejected`, `testPortableEdgeProfileArgumentWithSpaces`, every fake-Edge cleanup branch, every `waitForPortClosed(9222)`/`assertPortFree(9222)` probe, and every `Add-Type -OutputAssembly` path from `tests/startup_scripts_smoke.js`. Keep the Dashboard process-cleanup coverage, but make it Dashboard-only. Delete `assertFakeEdgeBuildIsWindowed` and its fixture from `tests/background_process_visibility_smoke.js`.

Make `fixtureEnv()` set `LOCALAPPDATA` to `path.join(tempRoot, "local app data")` for every child process. Add test-side PowerShell invocations that dot-source only the copied `startup-identity.ps1`, call the named pure helper with fixture values, and parse its stdout/exit status; no helper probe may invoke `start-portable-edge.ps1`. Cover these exact cases:

```js
const profileA = invokeStartupHelper("Resolve-RoleFlowBrowserProfilePath", {
  ProjectRoot: path.join(tempRoot, "project-a"),
  ProfileDir: "",
  LocalAppDataPath: path.join(tempRoot, "local app data")
});
const profileB = invokeStartupHelper("Resolve-RoleFlowBrowserProfilePath", {
  ProjectRoot: path.join(tempRoot, "project-b"),
  ProfileDir: "",
  LocalAppDataPath: path.join(tempRoot, "local app data")
});
assert.strictEqual(normalizePath(profileA), normalizePath(profileB));
assert.strictEqual(
  normalizePath(profileA),
  normalizePath(path.join(tempRoot, "local app data", "RoleFlow", "BrowserProfile"))
);
const relativeProfile = invokeStartupHelper("Resolve-RoleFlowBrowserProfilePath", {
  ProjectRoot: path.join(tempRoot, "project-a"),
  ProfileDir: "profiles\\dedicated",
  LocalAppDataPath: path.join(tempRoot, "local app data")
});
assert.strictEqual(
  normalizePath(relativeProfile),
  normalizePath(path.join(tempRoot, "project-a", "profiles", "dedicated"))
);
const absoluteProfile = path.join(tempRoot, "explicit profile");
assert.strictEqual(
  normalizePath(invokeStartupHelper("Resolve-RoleFlowBrowserProfilePath", {
    ProjectRoot: path.join(tempRoot, "project-a"),
    ProfileDir: absoluteProfile,
    LocalAppDataPath: path.join(tempRoot, "local app data")
  })),
  normalizePath(absoluteProfile)
);

assert.deepStrictEqual(
  invokeStartupHelper("New-RoleFlowPortableEdgeArguments", {
    Port: 9222,
    ProfilePath: "C:\\RoleFlow Profile",
    StartUrl: "https://www.zhipin.com/web/geek/jobs"
  }),
  [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9222",
    "--remote-allow-origins=*",
    '"--user-data-dir=C:\\RoleFlow Profile"',
    "--no-first-run",
    "--no-default-browser-check",
    "https://www.zhipin.com/web/geek/jobs"
  ]
);

const acceptedSnapshot = {
  ProcessName: "msedge.exe",
  ExecutablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  CommandLine: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 "--user-data-dir=C:\\RoleFlow Profile"',
  EdgePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  Port: 9222,
  ProfilePath: "C:\\RoleFlow Profile"
};
assertPureSnapshotAccepted(acceptedSnapshot);
assertPureSnapshotRejected(
  { ...acceptedSnapshot, ExecutablePath: "C:\\fixture\\msedge.exe" },
  /different executable/i
);
assertPureSnapshotRejected(
  { ...acceptedSnapshot, ProfilePath: "C:\\wrong profile" },
  /different profile/i
);
assertPureSnapshotRejected(
  { ...acceptedSnapshot, CommandLine: acceptedSnapshot.CommandLine.replace("127.0.0.1", "0.0.0.0") },
  /loopback address/i
);
assertPureSnapshotRejected(
  { ...acceptedSnapshot, CommandLine: acceptedSnapshot.CommandLine.replace("9222", "9333") },
  /different port/i
);
assertListenerSnapshotAccepted({
  querySucceeded: true,
  listeners: [{ localAddress: "127.0.0.1", owningProcess: 4242 }]
}, { querySucceeded: true, processes: [{ ...acceptedSnapshot, ProcessId: 4242 }] });
for (const listenerSnapshot of [
  { querySucceeded: false, listeners: [] },
  { querySucceeded: true, listeners: [{ localAddress: "0.0.0.0", owningProcess: 4242 }] },
  { querySucceeded: true, listeners: [{ localAddress: "::", owningProcess: 4242 }] },
  {
    querySucceeded: true,
    listeners: [
      { localAddress: "127.0.0.1", owningProcess: 4242 },
      { localAddress: "127.0.0.1", owningProcess: 4343 }
    ]
  }
]) assertListenerSnapshotRejected(listenerSnapshot, {
  querySucceeded: true,
  processes: [{ ...acceptedSnapshot, ProcessId: 4242 }]
});
assertListenerSnapshotRejected(
  { querySucceeded: true, listeners: [{ localAddress: "127.0.0.1", owningProcess: 4242 }] },
  { querySucceeded: true, processes: [{ ...acceptedSnapshot, ProcessId: 4242, CommandLine: "" }] }
);
assertListenerSnapshotRejected(
  { querySucceeded: true, listeners: [{ localAddress: "127.0.0.1", owningProcess: 4242 }] },
  { querySucceeded: false, processes: [] }
);
assertProfileInUseRejected("C:\\RoleFlow Profile", {
  querySucceeded: true,
  processes: [acceptedSnapshot]
});
assertProfileQueryRejected({ querySucceeded: false, processes: [] });
assertProfileQueryRejected({
  querySucceeded: true,
  processes: [{ ...acceptedSnapshot, ExecutablePath: "" }]
});
assertProfileQueryRejected({
  querySucceeded: true,
  processes: [{ ...acceptedSnapshot, CommandLine: "" }]
});
assertProfileInUseAccepted("C:\\RoleFlow Profile", {
  querySucceeded: true,
  processes: [
    { ...acceptedSnapshot, ProcessName: "node.exe" },
    {
      ...acceptedSnapshot,
      CommandLine: acceptedSnapshot.CommandLine.replace("C:\\RoleFlow Profile", "C:\\Other Profile")
    }
  ]
});
```

- [ ] **Step 2: Prove the rewritten test is safe and fails for the missing helpers**

Run:

```powershell
$hazards = rg -n 'OutputAssembly|function (edgeCompileSource|compileEdgeStub|startEdgeStub)' tests/startup_scripts_smoke.js tests/background_process_visibility_smoke.js
if ($LASTEXITCODE -eq 0) { $hazards; throw "unsafe executable test fixture remains" }
if ($LASTEXITCODE -gt 1) { exit $LASTEXITCODE }
node tests/startup_scripts_smoke.js
```

Expected: the hazard check emits no matches; the smoke test fails because the new helper functions do not exist. It must not create an executable, start Edge, bind or probe port 9222, or use the real `LOCALAPPDATA`.

- [ ] **Step 3: Add the pure profile, argument, and process-snapshot helpers**

Implement the shared PowerShell functions in `scripts/lib/startup-identity.ps1` with this contract:

```powershell
function Resolve-RoleFlowBrowserProfilePath {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$ProfileDir = "",
    [string]$LocalAppDataPath = $env:LOCALAPPDATA
  )
  if ($ProfileDir) {
    $Candidate = if ([System.IO.Path]::IsPathRooted($ProfileDir)) {
      $ProfileDir
    } else {
      Join-Path $ProjectRoot $ProfileDir
    }
    return Resolve-RoleFlowNormalizedPath -Path $Candidate
  }
  if ([string]::IsNullOrWhiteSpace($LocalAppDataPath)) {
    throw "RoleFlow browser profile requires LOCALAPPDATA or an explicit -ProfileDir."
  }
  return Resolve-RoleFlowNormalizedPath -Path (
    Join-Path $LocalAppDataPath "RoleFlow\BrowserProfile"
  )
}

function New-RoleFlowPortableEdgeArguments {
  param([int]$Port, [string]$ProfilePath, [string]$StartUrl)
  @(
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$Port",
    "--remote-allow-origins=*",
    ('"--user-data-dir={0}"' -f (Resolve-RoleFlowNormalizedPath -Path $ProfilePath)),
    "--no-first-run",
    "--no-default-browser-check",
    $StartUrl
  )
}
```

`Assert-RoleFlowPortableEdgeProcessSnapshot` must require the exact normalized `ExecutablePath`, one loopback address argument, one exact port argument, and one exact profile argument. `Get-RoleFlowTcpListenerSnapshot` enumerates every address/PID bound to the requested port and distinguishes a successful empty result from enumeration failure. The pure listener assertion accepts only one `127.0.0.1` listener with one matching readable process snapshot; `0.0.0.0`, IPv6/wildcard, multiple rows/PIDs, missing executable path/command line, and enumeration failure all throw. The production listener wrapper reads the port and CIM/WMI snapshots once and delegates to the pure assertion.

`Get-RoleFlowEdgeProcessSnapshot` distinguishes a successful empty query from failure. Both listener identity and `Assert-RoleFlowBrowserProfileNotInUse` consume that structured snapshot; query failure or any potentially relevant `msedge.exe` with a missing executable path/command line throws. The not-in-use assertion checks the exact `--user-data-dir`; it never deletes a lock or stops a process. Startup, migration, and uninstall all reuse this same production query and assertion.

For ordinary startup, resolve Edge only from the standard Microsoft Edge installation paths derived from `${env:ProgramFiles(x86)}` and `$env:ProgramFiles`; remove the implicit `Get-Command msedge`/`PATH` fallback. Keep `-EdgePath` as an explicit developer override, and describe it as caller-trusted rather than part of the ordinary-user guarantee.

- [ ] **Step 4: Make production launchers consume the one shared profile resolver**

Change `start-portable-edge.ps1` and `scan-portable.ps1` so their parameter default is empty:

```powershell
[string]$ProfileDir = ""
```

Resolve the profile through `Resolve-RoleFlowBrowserProfilePath`. Resolve the real Edge executable before validating an existing listener, pass that exact path into `Assert-RoleFlowPortableEdgeListenerIdentity`, and build launch arguments only with `New-RoleFlowPortableEdgeArguments`.

Before starting Edge, obtain the complete listener snapshot. Stop with a named error if enumeration fails, any address/PID already owns the port but `/json/version` is not a valid CDP responder, or the exact profile is already used by another Edge process without the expected listener. When `/json/version` responds, accept it only after the exact one-listener/one-process identity assertion passes. Do not switch ports, start a second profile, stop any process, or remove Chromium lock files.

- [ ] **Step 5: Run the safe startup checks**

Run:

```powershell
node tests/startup_scripts_smoke.js
node tests/background_process_visibility_smoke.js
node tests/self_check.js
git diff --check
```

Expected: all four commands pass; a recursive search of the test tree finds no disk executable compilation path.

- [ ] **Step 6: Commit the safe profile foundation**

```powershell
git add scripts/lib/startup-identity.ps1 scripts/start-portable-edge.ps1 scripts/scan-portable.ps1 tests/startup_scripts_smoke.js tests/background_process_visibility_smoke.js
git commit -m "fix: make dedicated Edge profile stable and testable"
```

### Task 2: Freeze Browser Authority in Workspace Startup and Dashboard Health

**Files:**
- Modify: `scripts/start-workspace.ps1:1-94`
- Modify: `scripts/launch-installed.ps1:1-48`
- Modify: `src/cli.js:2623-2640`
- Modify: `src/dashboard/server.js:285-395, 501-568`
- Modify: `tests/startup_scripts_smoke.js`
- Modify: `tests/dashboard_shell_smoke.js`
- Modify: `tests/self_check.js`
- Modify: every current smoke test that directly calls `createDashboardServer`: `tests/analysis_application_smoke.js`, `tests/communication_application_smoke.js`, `tests/communication_calibration_gate_smoke.js`, `tests/communication_smoke.js`, `tests/dashboard_asset_failure_smoke.js`, `tests/dashboard_communication_batch_smoke.js`, `tests/dashboard_message_discovery_smoke.js`, `tests/dashboard_scan_lifecycle_smoke.js`, `tests/model_settings_ui_smoke.js`, `tests/onboarding_progress_ui_smoke.js`, `tests/outcome_analytics_dashboard_smoke.js`, `tests/today_dashboard_smoke.js`, `tests/workflow_dashboard_smoke.js`, `tests/workflow_end_to_end_smoke.js`, and `tests/workflow_recovery_smoke.js`

**Interfaces:**
- Consumes: `Resolve-RoleFlowBrowserProfilePath`
- Produces: `normalizeDashboardBrowserAuthority(input) -> frozen { browserMode, cdpPort, profilePath }`
- Produces: `/health.browserAuthority` with the exact frozen object
- Produces: `createDashboardServer({ browserAuthority })`

- [ ] **Step 1: Write failing authority propagation tests**

Extend the safe startup fixture and Dashboard smoke test to require:

```js
assert.deepStrictEqual(health.browserAuthority, {
  browserMode: "portable",
  cdpPort: 9222,
  profilePath: expectedStableProfile
});
assert.deepStrictEqual(recordedDashboard.args.slice(browserIndex), [
  "--browser", "portable",
  "--cdp-port", "9222",
  "--browser-profile", expectedStableProfile
]);
```

Add cases proving that default workspace startup records `portable/9222`, `-BrowserMode edge` still records advanced `edge` with no CDP/profile fields, and an already-running Dashboard with a different mode, port, profile, PID, or project root is rejected before `workspace-tabs` runs. Direct `run.ps1 dashboard` without `--browser` must stop; `edge` is accepted only when explicitly supplied. Both `-BrowserMode edge -ProfileDir <path>` and an explicitly supplied `-BrowserMode edge -CdpPort <port>` must stop through `$PSBoundParameters`; direct `dashboard --browser edge --cdp-port 9222`/`--browser-profile <path>` must likewise stop instead of silently discarding extra authority fields.

At the same time, remove the obsolete `BrowserMode = "edge"` and old README sentence assertions from `tests/self_check.js`; do not replace them with new source-text checks. The startup behavior tests above become the evidence.

- [ ] **Step 2: Run the focused tests and observe authority failures**

Run:

```powershell
node tests/startup_scripts_smoke.js
node tests/dashboard_shell_smoke.js
```

Expected: assertions fail because the default is still `edge` and `/health` has no browser authority.

- [ ] **Step 3: Pass and freeze authority in the Dashboard process**

Add a local `normalizeDashboardBrowserAuthority` in `src/dashboard/server.js`:

```js
function normalizeDashboardBrowserAuthority(input) {
  const browserMode = String(input?.browserMode || "").trim().toLowerCase();
  if (!new Set(["edge", "portable"]).has(browserMode)) {
    throw appError("WORKFLOW_BROWSER_MODE_INVALID", "浏览器模式无效。", { statusCode: 409 });
  }
  if (browserMode === "edge") {
    if ((input.cdpPort !== null && input.cdpPort !== undefined && String(input.cdpPort).trim() !== "")
      || String(input.profilePath || "").trim()) {
      throw appError("DASHBOARD_BROWSER_AUTHORITY_INVALID", "当前 Edge 高级模式不能携带专用 Edge 身份。", { statusCode: 409 });
    }
    return Object.freeze({ browserMode, cdpPort: null, profilePath: "" });
  }
  const cdpPort = Number(input.cdpPort);
  const profilePath = String(input.profilePath || "").trim();
  if (cdpPort !== 9222 || !path.isAbsolute(profilePath)) {
    throw appError("DASHBOARD_BROWSER_AUTHORITY_INVALID", "RoleFlow 专用 Edge 启动身份无效。", { statusCode: 409 });
  }
  return Object.freeze({ browserMode, cdpPort, profilePath: path.resolve(profilePath) });
}
```

Normalize it once in `createDashboardServer`, use it for all later tasks, return it unchanged as `browserAuthority` from `/health`, and export `normalizeDashboardBrowserAuthority` for its focused smoke tests. Missing authority is invalid; it must never mean Edge Control. Update `startDashboard()` to pass the raw explicit values and let the normalizer reject omissions:

```js
browserAuthority: {
  browserMode: args.browser,
  cdpPort: args["cdp-port"],
  profilePath: args["browser-profile"] || ""
}
```

Update every existing `createDashboardServer` smoke fixture to pass an explicit authority. Existing Edge Control cases use `{ browserMode: "edge", cdpPort: null, profilePath: "" }`; dedicated-Edge cases use their fixture's absolute temporary profile path. Do not add a test-only default in production code.

- [ ] **Step 4: Change ordinary workspace startup to the dedicated Edge**

In `start-workspace.ps1`:

```powershell
[string]$BrowserMode = "portable",
[string]$ProfileDir = ""
```

Resolve the profile once. Start or verify the browser with that profile, pass the exact authority to the Dashboard command, and make `Test-Dashboard` compare `/health.browserAuthority` with the requested mode, port, and normalized profile. Any mismatch throws `DASHBOARD_BROWSER_AUTHORITY_MISMATCH`; it must not reuse the process or switch to Edge Control.

Before doing any work, use `$PSBoundParameters.ContainsKey('CdpPort')` and `$PSBoundParameters.ContainsKey('ProfileDir')` to reject those explicit dedicated-Edge fields when `BrowserMode` is `edge`. The parameter defaults themselves must not make the advanced entry contradictory.

Keep `-BrowserMode edge` as the explicit advanced entry. Preserve the original failure reason in `launch-installed.ps1`; append a close-and-retry action only for named Dashboard/profile/port identity conflicts, and never describe Edge-missing or dependency failures as browser conflicts. Remove the blanket “浏览器连接组件” requirement from the ordinary default path.

- [ ] **Step 5: Verify and commit Dashboard identity**

Run:

```powershell
node tests/startup_scripts_smoke.js
node tests/dashboard_shell_smoke.js
node tests/background_process_visibility_smoke.js
node tests/self_check.js
git diff --check
```

Expected: all pass.

```powershell
git add scripts/start-workspace.ps1 scripts/launch-installed.ps1 src/cli.js src/dashboard/server.js tests/startup_scripts_smoke.js tests/dashboard_shell_smoke.js tests/self_check.js tests/analysis_application_smoke.js tests/communication_application_smoke.js tests/communication_calibration_gate_smoke.js tests/communication_smoke.js tests/dashboard_asset_failure_smoke.js tests/dashboard_communication_batch_smoke.js tests/dashboard_message_discovery_smoke.js tests/dashboard_scan_lifecycle_smoke.js tests/model_settings_ui_smoke.js tests/onboarding_progress_ui_smoke.js tests/outcome_analytics_dashboard_smoke.js tests/today_dashboard_smoke.js tests/workflow_dashboard_smoke.js tests/workflow_end_to_end_smoke.js tests/workflow_recovery_smoke.js
git commit -m "feat: freeze dedicated Edge authority in dashboard"
```

### Task 3: Give Dedicated Edge the Full Fixed-Tab Safety Lifecycle

**Files:**
- Create: `src/core/browser_tab_identity.js`
- Modify: `src/adapters/browser/cdp.js:15-37`
- Modify: `src/core/workspace_tabs.js:1-271`
- Modify: `src/core/browser_readiness.js:1-60`
- Modify: `src/cli.js:193-241, 985-1011, 1800-1836, 2302-2342`
- Modify: `src/dashboard/server.js:309-335, 1584-1615`
- Modify: `tests/browser_transport_smoke.js`
- Modify: `tests/workspace_tabs_smoke.js`
- Modify: `tests/browser_readiness_smoke.js`
- Modify: `tests/scan_cli_lifecycle_smoke.js`

**Interfaces:**
- Produces: typed tab-ID helpers from `src/core/browser_tab_identity.js`
- Produces: a CDP `active` field derived from each page's observed `document.visibilityState`, never from `/json/list` order
- Produces: `CdpBrowserAdapter.closeTab(tabId) -> verified Target.closeTarget result`
- Produces: `prepareWorkspaceTabs({ browser, dashboardUrl, inspectReadiness, requireFixedBossTabs, bootstrapDedicatedTabs })`, where `inspectReadiness({ guidanceTab, fixedTabs })` always receives the exact typed tab identity being inspected
- Produces: fixed search/communication tab inspection for both `edge` and `portable`

- [ ] **Step 1: Write failing typed-ID and dedicated-tab bootstrap tests**

Cover all of these behaviors in the existing smoke files:

```js
assert.strictEqual(isBrowserTabId(42), true);
assert.strictEqual(isBrowserTabId("CDP-target-42"), true);
assert.strictEqual(sameBrowserTabId(42, "42"), false);
assert.deepStrictEqual(sortedBrowserTabIds(["b", 2, "a", 1]), [1, 2, "a", "b"]);
```

For `prepareWorkspaceTabs`:

- a dedicated Edge that is still on the BOSS login page returns `login_required`, brings only that BOSS tab forward, and creates neither chat nor Dashboard;
- `risk_control`, `search_page_required`, and any unrecognized/not-ready result create no chat or Dashboard and make zero foreground calls; only `login_required` may guide to BOSS, and only a proved `ready` search page may bootstrap and then guide to Dashboard;
- after login, exactly one search page causes one background `/web/geek/chat` tab to be created in the same window, then one Dashboard tab;
- duplicate search pages, duplicate communication pages, any additional unmanaged BOSS page in the same or another window, duplicate Dashboard pages, missing reliable window identity, or a foreground-created tab stop the startup;
- a bootstrap failure closes only the chat/Dashboard tab created by that invocation, re-proves the original typed baseline, and never closes an unrelated user page;
- `Page.bringToFront` remains exactly one startup-guidance call, followed only by a read-only re-list that proves the intended typed tab became active; failure stops without a second focus attempt.

For CDP transport, return `/json/list` in an order that disagrees with the visible page and prove `listTabs()` marks only the page whose `document.visibilityState` is `visible` as active. Test `createTab()` with zero pre-create visible pages, a hidden new page, a visible new page, visibility-unavailable, and cleanup-failure responses: zero-visible stops before issuing `Target.createTarget`; only one-visible-before plus hidden-new succeeds; every post-issue failure closes the target once and stops without `Page.bringToFront`. Also test `closeTab()` success plus false, missing, disconnected, and ambiguous results, with no retry. For scan CLI, use string CDP target IDs and assert both fixed tabs are checked before the first scan action.

- [ ] **Step 2: Run focused tests and observe the portable safety gap**

```powershell
node tests/browser_transport_smoke.js
node tests/workspace_tabs_smoke.js
node tests/browser_readiness_smoke.js
node tests/scan_cli_lifecycle_smoke.js
```

Expected: portable cases fail because they currently use the weaker single-tab path, tab identity is compared through string coercion, and CDP guesses the active page from list order.

- [ ] **Step 3: Replace CDP's list-order active guess with observed page visibility**

In `CdpBrowserAdapter.listTabs()`, remove `active: index === 0`. After a target's reliable window identity is known, query that target websocket directly:

```js
async visibilityStateForPage(page) {
  const result = await sendCdp(
    page.webSocketDebuggerUrl,
    "Runtime.evaluate",
    { expression: "document.visibilityState", returnByValue: true },
    this.timeoutMs
  );
  const state = result?.result?.value;
  if (!new Set(["visible", "hidden"]).has(state)) {
    throw browserError("BROWSER_COMMAND_FAILED", `CDP page visibility is unavailable: ${page.id}`);
  }
  return state;
}
```

Set `active: visibilityState === "visible"`. In `createTab()`, first require the opener window's pre-create visible-ID set to contain exactly one typed ID; zero or multiple stops before `Target.createTarget`. After issuing, require the new target to report `hidden` after its same-window identity check and before returning its ID; `visible` or unavailable evidence enters the existing one-shot target cleanup path and then throws. Do not infer focus from `/json/list` order and do not call `Page.bringToFront`.

A minimized/background Edge window may legitimately have zero visible pages, so fixed-tab reads that create nothing may snapshot and preserve a zero-or-one visible-ID set; two or more is always invalid. Any path that creates a tab requires exactly one visible page before the request, because an all-hidden window cannot prove which tab remained selected. Background creation and cleanup must leave that one-ID set unchanged, and the new target itself must always be `hidden`.

Add the fail-closed public cleanup method now so startup can restore a partially bootstrapped topology:

```js
async closeTab(tabId) {
  const result = await this.browserCommand("Target.closeTarget", { targetId: tabId });
  if (result?.success !== true) {
    throw browserError("BROWSER_COMMAND_FAILED", "CDP did not confirm that the tab was closed.");
  }
  return result;
}
```

This command is never retried. After any startup cleanup, re-list the tabs and require the exact pre-create typed IDs and visible-ID set before reporting a safe stop.

- [ ] **Step 4: Implement typed tab identities and startup-only bootstrapping**

Implement the helper exactly as follows:

```js
function isBrowserTabId(value) {
  return (Number.isInteger(value) && value > 0)
    || (typeof value === "string" && value.trim().length > 0);
}
function sameBrowserTabId(left, right) {
  return isBrowserTabId(left) && isBrowserTabId(right)
    && typeof left === typeof right && left === right;
}
function sortedBrowserTabIds(values = []) {
  return [...values].filter(isBrowserTabId).sort((left, right) => {
    if (typeof left !== typeof right) return typeof left === "number" ? -1 : 1;
    if (typeof left === "number") return left - right;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
module.exports = { isBrowserTabId, sameBrowserTabId, sortedBrowserTabIds };
```

Replace `String(tab.id) === String(expectedId)` comparisons in `workspace_tabs.js` with `sameBrowserTabId`.

Add `bootstrapDedicatedTabs: false` to `prepareWorkspaceTabs`. Change the callback to `inspectReadiness({ guidanceTab, fixedTabs })`. Only when bootstrapping is enabled may the user-invoked startup helper:

1. choose exactly one BOSS guidance page from the current list and retain its original typed ID;
2. call `adapter.preflight({ tabId: guidanceTab.id })` for that exact page;
3. for `login_required`, create nothing, call `bringToFront(guidanceTab.id)` once, then re-list and prove that typed ID is the single active page in its window; for `risk_control`, `search_page_required`, every other result, or an exception, create nothing and make zero foreground calls;
4. only after the exact guidance page is proved to be a ready search page and the window has exactly one visible typed ID may it create one background chat tab with `browser.createTab(guidanceTab.id, chatUrl)`; when the visible set is empty, create nothing and tell the user to restore RoleFlow 专用 Edge before retrying;
5. re-list tabs, prove the original search ID plus new communication ID, path, background state, and same-window identity, then reuse Dashboard or create it only while the window still has exactly one visible ID; if any required page is missing while the visible set is empty, create nothing and ask the user to restore the window;
6. call `bringToFront(dashboardTab.id)` once after the complete topology is proved, then re-list and prove that typed ID is the single active page in its window without retrying focus.

An unrecognized readiness result or inspection exception stops with no foreground call. If a tab created by this invocation fails later verification, close only that typed ID and prove the pre-create baseline, including its original one-ID visible set, before returning the original failure. Outside the one controlled message-detail operation, any BOSS tab beyond the single guidance page or the exact search/communication pair is invalid regardless of window.

Require zero or one matching Dashboard tab before creation; two or more throw `WORKSPACE_DASHBOARD_TAB_AMBIGUOUS` and are never closed automatically.

No scan, message, communication, retry, or recovery path receives this bootstrap option.

- [ ] **Step 5: Apply the fixed-tab preflight to both transports**

In `prepareWorkspaceTabsCommand`, require fixed BOSS tabs for both modes and set `bootstrapDedicatedTabs: browserMode === "portable"`.

In `inspectDashboardBossBrowserReadiness`, `resolveLiveInheritedContext`, `scan`, `refreshDetails`, `preflightBossScanBrowser`, and `runWithBoundBossScanBrowser`, treat both `edge` and `portable` as fixed-tab transports. Save typed tab IDs without conversion and re-list them before each guarded action.

Change readiness copy to derive from the actual mode:

```js
const label = browserMode === "edge"
  ? "当前 Edge（高级）"
  : "RoleFlow 专用 Edge";
```

Keep error codes stable while removing claims that every mode is “普通 Edge”.

- [ ] **Step 6: Verify the lifecycle and commit**

```powershell
node tests/browser_transport_smoke.js
node tests/workspace_tabs_smoke.js
node tests/browser_readiness_smoke.js
node tests/scan_cli_lifecycle_smoke.js
node tests/source_acquisition_smoke.js
git diff --check
```

Expected: all pass and only `prepareWorkspaceTabs` calls `bringToFront`.

```powershell
git add src/core/browser_tab_identity.js src/adapters/browser/cdp.js src/core/workspace_tabs.js src/core/browser_readiness.js src/cli.js src/dashboard/server.js tests/browser_transport_smoke.js tests/workspace_tabs_smoke.js tests/browser_readiness_smoke.js tests/scan_cli_lifecycle_smoke.js
git commit -m "fix: enforce fixed BOSS tabs in dedicated Edge"
```

### Task 4: Carry Dashboard Authority Through Workflows, Recovery, and Manual Scans

**Files:**
- Modify: `src/dashboard/server.js:349-359, 540-568, 1395-1453, 1710-1748, 1904-2025, 2388-2425, 4168-4219`
- Modify: `src/application/workflow/index.js:1-410`
- Modify: `src/dashboard/view_models/today.js:1-115`
- Modify: `src/dashboard/pages/today.js:1-180`
- Modify: `src/dashboard/pages/workflow.js:95-105`
- Modify: `tests/workflow_application_smoke.js`
- Modify: `tests/workflow_control_smoke.js`
- Modify: `tests/dashboard_scan_lifecycle_smoke.js`
- Modify: `tests/today_dashboard_smoke.js`
- Modify: `tests/workflow_dashboard_smoke.js`

**Interfaces:**
- Consumes: frozen Dashboard authority
- Produces: `resolveNewWorkflowBrowser(input, frozenAuthority) -> { browserMode, cdpPort } or throws`
- Persists: `workflow.planner.browserMode` and `workflow.planner.cdpPort`

- [ ] **Step 1: Write failing portable workflow and request-drift tests**

Add tests proving:

```js
const authority = { browserMode: "portable", cdpPort: 9222, profilePath: "C:\\test\\BrowserProfile" };
assert.deepStrictEqual(resolveNewWorkflowBrowser({}, authority), {
  browserMode: "portable",
  cdpPort: 9222
});
assert.throws(
  () => resolveNewWorkflowBrowser({ browserMode: "edge" }, authority),
  (error) => error.code === "DASHBOARD_BROWSER_AUTHORITY_MISMATCH"
);
```

Also prove an explicit advanced-Edge authority accepts only `cdpPort: null|undefined`; a persisted or requested Edge snapshot carrying `9222` is invalid. At the application level, a new workflow must persist and spawn `portable/9222`; pause/resume and crash recovery must keep it; an `edge` request against a portable Dashboard must fail before a workflow row or child process is created. Manual scan and inherited-preview posts must also reject transport drift.

- [ ] **Step 2: Run focused tests and observe the current hard-coded Edge failures**

```powershell
node tests/workflow_application_smoke.js
node tests/workflow_control_smoke.js
node tests/dashboard_scan_lifecycle_smoke.js
node tests/today_dashboard_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: portable new-workflow and UI assertions fail.

- [ ] **Step 3: Bind every Dashboard workflow entry to its frozen authority**

Implement and export `resolveNewWorkflowBrowser(input, frozenAuthority)` so omitted client fields use the frozen authority, equal supplied fields are accepted, and any different mode or port throws `DASHBOARD_BROWSER_AUTHORITY_MISMATCH`.

Pass a bound resolver into `startWorkflow`. Inject the frozen authority into:

- `/api/browser-readiness`;
- `/api/acquisition-preview`;
- `/api/workflow-run`;
- `/api/workflow-run/resume`;
- `/api/workflow-control`;
- `/api/scan`.

Do not trust hidden form values as the final authority. They may echo the frozen mode, but the server performs the equality check and supplies the canonical values.

- [ ] **Step 4: Remove the remaining portable recovery blockers**

In `resumeWorkflow`, replace the hard-coded new-snapshot `edge` requirement with:

```js
const frozenMode = String(workflow.planner?.browserMode || "").trim().toLowerCase();
const frozenPort = Number(workflow.planner?.cdpPort);
if (!["edge", "portable"].includes(frozenMode)
  || (frozenMode === "portable" && frozenPort !== 9222)
  || (frozenMode === "edge" && workflow.planner?.cdpPort != null)) {
  throw appError("WORKFLOW_BROWSER_AUTHORITY_INVALID", "本轮保存的浏览器身份无效。", { statusCode: 409 });
}
```

When `controlWorkflow` resumes an analysis phase that does not access BOSS, carry the workflow's saved authority instead of synthesizing `{ portable, 9222 }`. Browser-free analysis remains browser-free; the saved identity is preserved for later phases and audit.

- [ ] **Step 5: Make the user interface reflect, not choose, the authority**

Pass `runtime.browserMode`, `runtime.cdpPort`, and a plain-language `runtime.browserLabel` through `buildTodayViewModel`.

Use the runtime mode in hidden workflow/scan fields, call `/api/browser-readiness` without a transport selector, and show:

```text
正在检查 RoleFlow 专用 Edge 与固定 BOSS 页面状态…
```

For an explicit advanced Edge Dashboard, show “当前 Edge（高级）”. Workflow recovery text describes the stored authority but never offers a selector for new-version frozen workflows.

- [ ] **Step 6: Verify and commit the workflow chain**

```powershell
node tests/workflow_application_smoke.js
node tests/workflow_control_smoke.js
node tests/dashboard_scan_lifecycle_smoke.js
node tests/today_dashboard_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/workflow_end_to_end_smoke.js
git diff --check
```

Expected: all pass.

```powershell
git add src/dashboard/server.js src/application/workflow/index.js src/dashboard/view_models/today.js src/dashboard/pages/today.js src/dashboard/pages/workflow.js tests/workflow_application_smoke.js tests/workflow_control_smoke.js tests/dashboard_scan_lifecycle_smoke.js tests/today_dashboard_smoke.js tests/workflow_dashboard_smoke.js
git commit -m "feat: carry dedicated Edge authority through workflows"
```

### Task 5: Make Message Discovery Fully CDP-Compatible Without Weakening Safety

**Files:**
- Modify: `src/adapters/sites/boss_message_detail_reader.js:55-445`
- Modify: `src/dashboard/server.js:501-512`
- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `tests/boss_message_detail_reader_smoke.js`
- Modify: `tests/dashboard_message_discovery_smoke.js`

**Interfaces:**
- Consumes: typed tab-ID helpers and the fail-closed `CdpBrowserAdapter.closeTab(tabId)` completed in Task 3
- Preserves: one background same-window detail tab, the pre-create zero-or-one visible-tab set, shared pacing/budget, and guaranteed cleanup

- [ ] **Step 1: Write failing string-target message tests**

Run the full message-detail scenarios using string IDs for search, communication, visible Dashboard, and detail targets. Retain assertions that the created detail is `active: false`, is in the fixed window, is the only new target, is closed exactly once, and leaves both the typed baseline and original one-ID visible set unchanged. Add a minimized-window fixture where every original page is hidden and assert it throws the existing `BOSS_MESSAGE_DETAIL_NOT_BACKGROUND` before `beforeOpen`, leaves the item pending, calls `createTab` zero times, consumes no issued browser-attempt budget, and tells the user to restore the dedicated Edge window before retrying.

In Dashboard discovery, assert the browser factory receives the frozen `{ browserMode: "portable", cdpPort: 9222 }` and is not called before the lease, model, runtime, and cooldown gates pass.

- [ ] **Step 2: Run focused tests and observe the missing CDP capabilities**

```powershell
node tests/browser_transport_smoke.js
node tests/boss_message_detail_reader_smoke.js
node tests/dashboard_message_discovery_smoke.js
```

Expected: string target IDs are rejected before the Task 5 production changes.

- [ ] **Step 3: Preserve typed IDs through the detail reader**

Replace every `Number.isInteger(tab.id)` gate and numeric sort in `captureBinding`, `optionalCreatedTargetTab`, `assertBackgroundCreation`, and `numericTabIds` with `isBrowserTabId`, `sameBrowserTabId`, and `sortedBrowserTabIds`. Replace `activeTabIdInWindow` with `visibleTabIdsInWindow`: it returns a sorted typed array and rejects two or more. `captureBinding` requires exactly one visible ID before `beforeOpen` or any issued attempt; zero throws `BOSS_MESSAGE_DETAIL_NOT_BACKGROUND`. During a created-detail read and after cleanup, compare the exact original one-ID array. Update that existing public recovery message so it truthfully covers both “not issued because the window was minimized” and “issued tab was cleaned after background proof failed.”

Keep strict type equality: numeric `42` and string `"42"` are different targets. Do not relax window identity, foreground identity, URL identity, cleanup, pacing, or access accounting.

- [ ] **Step 4: Inject the frozen Dashboard browser into discovery**

Change only the server factory wiring:

```js
browserFactory: () => browserFactory({
  browserMode: dashboardBrowserAuthority.browserMode,
  cdpPort: dashboardBrowserAuthority.cdpPort
})
```

Do not rewrite `createMessageDiscoveryController`, `createMessageDiscoveryDetailSafety`, `createBossMessageReader`, or the local-draft path.

- [ ] **Step 5: Verify the complete read-only message chain and commit**

```powershell
node tests/browser_transport_smoke.js
node tests/boss_message_detail_reader_smoke.js
node tests/boss_message_reader_smoke.js
node tests/message_discovery_smoke.js
node tests/message_discovery_job_context_smoke.js
node tests/dashboard_message_discovery_smoke.js
git diff --check
```

Expected: all pass; no test calls a real browser.

```powershell
git add src/adapters/sites/boss_message_detail_reader.js src/dashboard/server.js src/dashboard/message_discovery_view.js tests/boss_message_detail_reader_smoke.js tests/dashboard_message_discovery_smoke.js
git commit -m "fix: support dedicated Edge message detail cleanup"
```

### Task 6: Unify Communication Binding and Recovery Across Both Transports

**Files:**
- Modify: `src/storage/communication_store.js:35-205, 636-700`
- Modify: `src/application/communication/index.js:132-157`
- Modify: `src/adapters/sites/boss.js:1987-2091, 3322-3355`
- Modify: `src/cli.js:244-330, 418-458`
- Modify: `src/dashboard/server.js:3181-3448, 4549-4570`
- Modify: `src/dashboard/view_models/communication.js`
- Modify: `tests/communication_batch_storage_smoke.js`
- Modify: `tests/communication_store_contract_smoke.js`
- Modify: `tests/communication_application_smoke.js`
- Modify: `tests/communication_cli_authority_smoke.js`
- Modify: `tests/dashboard_communication_batch_smoke.js`
- Modify: `tests/boss_communication_page_smoke.js`
- Modify: `tests/workflow_communication_smoke.js`

**Interfaces:**
- Consumes: frozen Dashboard authority and typed tab-ID helpers
- Persists: `{ mode, windowId, searchTabId, messageTabId, searchReturnUrl, searchScrollTop, bindingGeneration }`
- Preserves: immutable batch mode/port, explicit authorization, per-item verification, no ambiguous retry

- [ ] **Step 1: Write failing portable binding tests before changing production code**

Add storage cases with string target IDs:

```js
const binding = {
  mode: "portable",
  windowId: 17,
  searchTabId: "CDP-search",
  messageTabId: "CDP-chat",
  searchReturnUrl: "https://www.zhipin.com/web/geek/jobs?query=java",
  searchScrollTop: 120,
  bindingGeneration: 1
};
```

Assert it round-trips without type conversion. A binding whose `mode` differs from the batch must fail atomically. Add application and Dashboard tests proving portable paused/interrupted batches may rebind only before any ambiguous/clicked item, and that forged client `edge` values cannot change a portable Dashboard or batch.

For `POST /api/communication-batch`, prove an omitted browser value uses the frozen Dashboard authority, while a forged different mode/port fails before a batch row, event, quota reservation, or workflow link is written. For a workflow-linked batch, require the workflow snapshot, Dashboard authority, and new batch authority to agree; test each mismatch independently.

At CLI level, run the complete fixed-tab session with string IDs: inspect both tabs, capture search URL/scroll, persist binding, begin session, execute the authorized item fixture, restore the search page, and recheck both typed IDs.

- [ ] **Step 2: Run focused tests and observe the ordinary-Edge-only guards**

```powershell
node tests/communication_batch_storage_smoke.js
node tests/communication_store_contract_smoke.js
node tests/communication_application_smoke.js
node tests/communication_cli_authority_smoke.js
node tests/dashboard_communication_batch_smoke.js
node tests/boss_communication_page_smoke.js
node tests/workflow_communication_smoke.js
```

Expected: portable runtime binding and rebind tests fail before any external action fixture executes.

- [ ] **Step 3: Generalize the persisted binding without weakening mode checks**

Change `validateBrowserBinding` to accept an `expectedMode` and enforce:

```js
if (!["edge", "portable"].includes(browser.mode)
  || (expectedMode && browser.mode !== expectedMode)) {
  throw codedError("COMMUNICATION_BROWSER_BINDING_INVALID", "runtime browser binding mode mismatch");
}
for (const field of ["searchTabId", "messageTabId"]) {
  if (!isBrowserTabId(browser[field])) {
    throw codedError(
      "COMMUNICATION_BROWSER_BINDING_INVALID",
      `${field} must be a valid browser tab identifier`
    );
  }
}
if (sameBrowserTabId(browser.searchTabId, browser.messageTabId)) {
  throw codedError(
    "COMMUNICATION_BROWSER_BINDING_INVALID",
    "fixed search and message tabs must be different"
  );
}
```

Keep `windowId` and `bindingGeneration` positive integers, and return `mode: browser.mode` instead of hard-coding `edge`. In `bindCommunicationBatchRuntime`, pass `batch.browserMode` when validating both requested and stored bindings.

- [ ] **Step 4: Reuse the complete BOSS communication lifecycle for portable**

In `BossSiteAdapter`, allow typed tab IDs and `mode` values `edge|portable` in `captureCommunicationSearchState` and `normalizeCommunicationTabBinding`. Keep strict same-window, search URL, scroll, message path, search restoration, and binding-generation checks.

In `communicate`, remove the weaker portable branch. Both modes execute:

```js
inspectBossOperatorTabs
  -> captureCommunicationSearchState
  -> bindCommunicationBatchRuntime
  -> bindCommunicationTabs
  -> beginCommunicationSession
  -> runCommunicationBatch
  -> restoreCommunicationSearchPage
```

Persist `mode: browserMode`; keep `resolveCommunicationBrowserAuthority` as the port/mode drift gate.

- [ ] **Step 5: Bind Dashboard batch creation and controls to the same authority**

In `handleCommunicationBatch`, resolve the request against `dashboardBrowserAuthority` before calling `createCommunicationBatch`. Missing client mode/port means the frozen authority; equal explicit values are accepted only for compatibility; any mismatch throws `DASHBOARD_BROWSER_AUTHORITY_MISMATCH` before storage. When `workflowRunId` is present, load its frozen planner authority and require exact agreement with the Dashboard first. Pass only the server-canonical `browserMode` into batch creation. Hidden fields are display transport, not authority.

Allow `rebindCommunicationBrowser` for both frozen modes. In `inspectAndBindCommunicationBrowser`, create the adapter from `batch.browserMode` and `portableCommunicationCdpPort(batch)`, then save the actual mode and typed IDs.

Before start/resume/rebind, require the batch mode/port to equal the Dashboard frozen authority. Extend the automatic read-only rebind condition from only `edge` to both modes; preserve the existing ambiguity and clicked-item blocks.

Replace the ordinary-user browser `<select>` in `renderCommunicationBuilderPage` with a server-derived label and hidden frozen `browserMode`. `src/dashboard/view_models/communication.js` exposes rebind for both modes. No UI or authority change grants permission to send.

- [ ] **Step 6: Verify the communication chain and commit**

```powershell
node tests/communication_batch_storage_smoke.js
node tests/communication_store_contract_smoke.js
node tests/communication_application_smoke.js
node tests/communication_cli_authority_smoke.js
node tests/dashboard_communication_batch_smoke.js
node tests/boss_communication_page_smoke.js
node tests/communication_executor_smoke.js
node tests/workflow_communication_smoke.js
git diff --check
```

Expected: all pass with zero live browser or BOSS access.

```powershell
git add src/storage/communication_store.js src/application/communication/index.js src/adapters/sites/boss.js src/cli.js src/dashboard/server.js src/dashboard/view_models/communication.js tests/communication_batch_storage_smoke.js tests/communication_store_contract_smoke.js tests/communication_application_smoke.js tests/communication_cli_authority_smoke.js tests/dashboard_communication_batch_smoke.js tests/boss_communication_page_smoke.js tests/workflow_communication_smoke.js
git commit -m "feat: unify communication browser authority"
```

### Task 7: Add Explicit Profile Migration and Safe Installer/Uninstaller Behavior

**Files:**
- Create: `scripts/migrate-browser-profile.ps1`
- Modify: `scripts/installed-self-check.ps1`
- Modify: `scripts/prepare-uninstall.ps1`
- Modify: `scripts/build-installer.ps1:98-185`
- Modify: `scripts/package-release.ps1:1-85`
- Modify: `installer/RoleFlow.iss`
- Modify: `tests/windows_installer_smoke.js`

**Interfaces:**
- Consumes: shared stable-profile and profile-in-use helpers
- Produces: explicit copy-only `migrate-browser-profile.ps1 -SourceProfileDir <exact path> -ConfirmMigration`
- Produces: `installed-self-check.ps1 -DashboardProbePort <port> -CdpProbePort <port>`; these inspect conflicts only and never change the frozen product authority `portable/9222/<stable profile>`
- Produces: uninstall switches `-PromptDeleteBrowserProfile`, `-DeleteBrowserProfile`, and `-ConfirmDeleteBrowserProfile`
- Produces: independent browser-profile deletion confirmation; default and silent uninstall preserve it

- [ ] **Step 1: Write failing installer, migration, and deletion-boundary tests**

Run every PowerShell child with a temporary overridden `LOCALAPPDATA`. Cover:

```js
// Default uninstall preserves both application data and external profile.
assert(fs.existsSync(fixture.database));
assert(fs.existsSync(fixture.browserProfileSentinel));

// Confirmed application-data deletion still preserves the browser profile.
assert(!fs.existsSync(fixture.database));
assert(fs.existsSync(fixture.browserProfileSentinel));

// A separately confirmed browser-profile deletion removes only BrowserProfile.
assert(!fs.existsSync(fixture.browserProfile));
assert(fs.existsSync(fixture.localAppDataSiblingSentinel));
assert(fs.existsSync(fixture.installRoot));
```

For migration, create a source containing `Local State` and a neutral `Default\RoleFlowProfileSentinel.txt`, leave the stable target absent, and create a sibling sentinel. Assert copy success, source retention, target content, and removal of the invocation's staging directory. Assert an already-existing target (even empty), missing `Local State`, same/ancestor-related source and target, a copy failure, an in-use guard, or a target created immediately before final rename all stop with no source change or partial formal target.

Do not manufacture a running `msedge.exe`. Copy each maintenance script plus a deterministic test `scripts\lib\startup-identity.ps1` into its temporary fixture: one stub implements safe path resolution and accepts the guard, while a second throws `ROLEFLOW_BROWSER_PROFILE_IN_USE`. Prove the throwing stub is called before migration copies or uninstall deletes anything. For the mid-copy failure case, the fixture helper shadows unqualified `Copy-Item` only inside that copied test process, creates a marker in staging, and throws; assert the formal target is absent and the invocation-owned staging path is cleaned. For the rename race, another fixture `Copy-Item` delegates to the real cmdlet and then creates the formal target with its own sentinel; assert `[System.IO.Directory]::Move` fails, the race-created target/sentinel remains untouched, staging is cleaned, and no nested staging directory appears under the target. The production guard itself is covered by Task 1's pure process snapshots; do not add a bypassable `-ProcessSnapshots` or failure-injection option to production scripts.

Assert installer stage includes `migrate-browser-profile.ps1` but contains no `BrowserProfile`, `.runtime\edge-profile`, database, secret, test tree, or Edge Control bundle.

For the large stage fixture, resolve its root in this order: explicit `ROLEFLOW_INSTALLER_TEST_ROOT`, a unique child of `D:\DevData\RoleFlow-tests` when `D:` exists, then a unique system-temp directory for CI machines without `D:`. Before recursive cleanup, resolve the absolute unique child and prove it is beneath the selected test root. Small migration/uninstall fixtures may use system temp.

- [ ] **Step 2: Run focused tests and observe the missing maintenance boundaries**

```powershell
node tests/windows_installer_smoke.js
```

Expected: the new migration and independent profile-delete cases fail; no test touches the real browser profile, starts Edge, or binds 8787/9222.

- [ ] **Step 3: Implement the separate copy-only migration entry**

The new script must:

```powershell
param(
  [Parameter(Mandatory = $true)][string]$SourceProfileDir,
  [switch]$ConfirmMigration
)
```

It resolves the target through `Resolve-RoleFlowBrowserProfilePath`, requires `-ConfirmMigration`, validates exact distinct non-root paths, rejects either path containing the other and rejects a source that contains the target/staging parent, requires source `Local State`, requires the formal target to be completely absent, and proves neither source nor target is in use by Edge.

Create one unique staging directory beside `BrowserProfile`, prove that exact path is a new child of `%LOCALAPPDATA%\RoleFlow`, copy the source children there, and verify at least `Local State` plus the copied file inventory before `[System.IO.Directory]::Move($StagingPath, $TargetPath)` performs the same-volume final rename. Do not use `Move-Item`, because an already-created directory could turn the operation into a nested move. A race that creates the target therefore fails. On any failure, remove only the exact staging directory created by this invocation after rechecking its parent/name identity; never remove or edit the source, and never leave a partial formal target.

Do not call this script from startup, install, upgrade, or uninstall.

- [ ] **Step 4: Extend install self-check without starting Edge or BOSS**

Import `startup-identity.ps1`. Resolve the stable profile, create and remove a small write probe in its parent, verify Microsoft Edge exists at one of the ordinary standard installation paths, and inspect configured Dashboard/CDP probe ports.

- Dashboard port conflict is accepted only when `/health` proves the exact install root and requested authority; installation normally stops the old Dashboard first.
- CDP probe-port conflict is accepted only when the listener is the exact installed Edge executable with the exact stable profile and that probe port; Task 1's pure tests prove the accepted identity without starting or faking Edge.
- Any ambiguous listener stops self-check. No port is changed and no process is killed.

Keep the isolated random-port Dashboard self-check, but start it with explicit health authority `{ portable, 9222, <stable profile> }`; it does not connect to BOSS or CDP. Add `-DashboardProbePort` and `-CdpProbePort` inputs only for conflict inspection so offline tests can use ephemeral listeners. Never feed a random probe port into `normalizeDashboardBrowserAuthority` and never relax the production `portable/9222` rule.

- [ ] **Step 5: Separate application-data and browser-login deletion**

Keep `Remove-ApprovedUserData` limited to install-root children. Add a separate browser-profile path that is always re-derived from current `LOCALAPPDATA`, must equal the normalized `%LOCALAPPDATA%\RoleFlow\BrowserProfile`, must not be in use, and deletes only that exact `BrowserProfile` directory.

Interactive uninstall shows a second Yes/No dialog with the exact path and “删除后需要重新登录 BOSS”; default is No. Silent uninstall, upgrade preparation, ordinary uninstall, and ordinary application-data deletion preserve the profile.

Order the operation atomically with respect to validation: first collect both choices; then normalize and validate every requested deletion target; if profile deletion was requested, prove its process query and not-in-use guard; only after all checks pass may either application data or browser data be deleted. Thus a blocked profile deletion cannot occur after application data was already removed. The explicit noninteractive delete path requires both `-DeleteBrowserProfile` and `-ConfirmDeleteBrowserProfile`; the prompt path sets both only after the user chooses Yes.

Inno Setup passes both prompt switches only for interactive uninstall. Silent uninstall and upgrade preparation pass none of `-PromptDeleteBrowserProfile`, `-DeleteBrowserProfile`, or `-ConfirmDeleteBrowserProfile`. Do not add an `[UninstallDelete]` rule for the external directory.

- [ ] **Step 6: Package the maintenance script and verify the stage on D**

Add the migration script to the installer stage list. Update the green-package completion text so it states that browser login data is external and never packaged.

Run:

```powershell
node tests/windows_installer_smoke.js
node tests/self_check.js
$stageRoot = Join-Path 'D:\DevData\RoleFlow-installer' ('stage-' + [guid]::NewGuid().ToString('N'))
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-installer.ps1 -StageOnly -SkipTests -BuildRoot $stageRoot -OutputDir (Join-Path $stageRoot 'dist')
git diff --check
```

Expected: tests pass and the stage is clean.

- [ ] **Step 7: Commit the distribution boundary**

```powershell
git add scripts/migrate-browser-profile.ps1 scripts/installed-self-check.ps1 scripts/prepare-uninstall.ps1 scripts/build-installer.ps1 scripts/package-release.ps1 installer/RoleFlow.iss tests/windows_installer_smoke.js
git commit -m "feat: preserve dedicated Edge login across installs"
```

### Task 8: Align Product Copy, Authoritative Docs, and the Full Offline Gate

**Files:**
- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `docs/product_spec.md`
- Modify: `docs/daily_workflow.md`
- Modify: `docs/onboarding_workflow.md`
- Modify: `docs/operations.md`
- Modify: `docs/release_boundary.md`
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/NEXT_PHASE.md`
- Inspect only: `tests/self_check.js`
- Revisit for user-visible copy only: `scripts/start-portable-edge.ps1`, `scripts/start-workspace.ps1`, `src/core/browser_readiness.js`, `src/dashboard/server.js`, `src/dashboard/pages/today.js`, and `src/dashboard/pages/workflow.js`

**Interfaces:**
- Documents: dedicated Edge default, stable profile, advanced Edge Control, migration, uninstall, safety, and current branch state
- Verifies: all 101 offline checks through the normal runner

- [ ] **Step 1: Update behavior tests instead of preserving brittle prose assertions**

Confirm the obsolete README/default-mode assertions were already removed in Task 2 and that no new profile-path or hazardous-token source regex was added. Do not edit the test merely to restate those facts. `tests/startup_scripts_smoke.js` executes the PowerShell boundary and verifies the default mode, stable path, relative/absolute overrides, and quoted arguments; the independent hazard gate below proves no executable fixture remains.

- [ ] **Step 2: Update only current product and authority documentation**

First run a non-test user-visible copy audit:

```powershell
rg -n "Portable Edge CDP|CDP URL|项目专用 Edge（手动备用）|当前已登录 Edge（推荐）|普通 Edge" scripts src/dashboard src/core
```

Inspect every match rather than making the search itself a test. Ordinary paths must say “RoleFlow 专用 Edge（推荐）”; the explicit advanced path must say “使用当前 Edge（高级，需要浏览器连接组件）”. Internal logs, hidden fields, and developer-only diagnostics may retain `portable`, CDP, and 9222. Then make these facts explicit and consistent in current documentation:

- current source candidate defaults to RoleFlow 专用 Edge and needs no Edge Control;
- first login is saved under `%LOCALAPPDATA%\RoleFlow\BrowserProfile` across upgrades and program-directory changes;
- only the browser login profile is stable across install roots; the database and other RoleFlow data do not silently migrate to a different install root;
- advanced current-Edge mode requires the existing local browser connection component and never becomes fallback;
- startup can guide the foreground once; all product work stays background;
- two fixed BOSS tabs remain the baseline, with one guarded transient message-detail exception;
- migration is explicit, copy-only, and source-preserving;
- ordinary and silent uninstall preserve browser login; browser-profile deletion is separate and explicit;
- tests no longer create fake `msedge.exe`.

Do not rewrite `docs/releases/v1.0.0.md`: it is historical. In the root README, distinguish the already-published v1.0.0 download from this not-yet-released source candidate. Before the full gate runs, current docs may say only “待验证”; do not write a 101/101 success claim yet.

- [ ] **Step 3: Run the entire safe offline suite**

First prove no hazardous fixture remains:

```powershell
$hazards = rg -n 'OutputAssembly|function (edgeCompileSource|compileEdgeStub|startEdgeStub)' tests
if ($LASTEXITCODE -eq 0) { $hazards; throw "unsafe executable test fixture remains" }
if ($LASTEXITCODE -gt 1) { exit $LASTEXITCODE }
```

Expected: no hazardous matches.

Then run:

```powershell
node tests/run_all.js
```

Expected final line:

```text
All 101 offline checks passed.
```

- [ ] **Step 4: Record only the verification result actually observed**

After the command above succeeds, replace “待验证” in `docs/PROJECT_HANDOFF.md` and `docs/NEXT_PHASE.md` with the exact observed command, count, and date. Describe it only as the verified working tree based on the current HEAD; do not invent the Task 8 commit hash before that commit exists. If the count or result differs, record the difference and keep the task incomplete; never copy the expected line into documentation as evidence. Task 9 will require a clean tree and record the resulting committed candidate source SHA.

- [ ] **Step 5: Run release-stage and repository hygiene checks**

```powershell
$stageRoot = Join-Path 'D:\DevData\RoleFlow-installer' ('offline-gate-' + [guid]::NewGuid().ToString('N'))
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-installer.ps1 -StageOnly -SkipTests -BuildRoot $stageRoot -OutputDir (Join-Path $stageRoot 'dist')
git diff --check
git status --short
```

Expected: stage succeeds on `D:`, diff check is clean, and status shows only the intended implementation/document changes before commit.

- [ ] **Step 6: Commit the documented offline-complete candidate**

```powershell
git add README.md docs/README.md docs/product_spec.md docs/daily_workflow.md docs/onboarding_workflow.md docs/operations.md docs/release_boundary.md docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md scripts/start-portable-edge.ps1 scripts/start-workspace.ps1 src/core/browser_readiness.js src/dashboard/server.js src/dashboard/pages/today.js src/dashboard/pages/workflow.js
git commit -m "docs: describe stable dedicated Edge workflow"
```

### Task 9: Build and Perform User-Assisted Real Acceptance

**Files:**
- Modify after evidence exists: `docs/PROJECT_HANDOFF.md`
- Modify after evidence exists: `docs/NEXT_PHASE.md`

**Interfaces:**
- Consumes: offline-clean implementation branch and configured Inno Setup compiler
- Produces: an unpublished installer candidate, observed login-persistence evidence, and a final acceptance record

- [ ] **Step 1: Build an unpublished candidate on D**

```powershell
$dirty = @(git status --porcelain)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw "candidate build requires a clean committed worktree" }
$sourceSha = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceSha -notmatch '^[0-9a-f]{40}$') { throw "candidate source SHA unavailable" }
$candidateRoot = Join-Path 'D:\DevData\RoleFlow-installer\candidates' $sourceSha.Substring(0, 12)
if ((Test-Path -LiteralPath $candidateRoot) -and (Get-ChildItem -LiteralPath $candidateRoot -Force | Select-Object -First 1)) {
  throw "candidate directory already contains files: $candidateRoot"
}
$buildRoot = Join-Path 'D:\DevData\RoleFlow-installer\builds' ($sourceSha.Substring(0, 12) + '-' + [guid]::NewGuid().ToString('N'))
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-installer.ps1 -BuildRoot $buildRoot -OutputDir $candidateRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$installer = @(Get-ChildItem -LiteralPath $candidateRoot -Filter '*.exe')
$checksum = @(Get-ChildItem -LiteralPath $candidateRoot -Filter '*.sha256')
if ($installer.Count -ne 1 -or $checksum.Count -ne 1) { throw "candidate artifact set is ambiguous" }
$actualHash = (Get-FileHash -LiteralPath $installer[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$declaredHash = ((Get-Content -LiteralPath $checksum[0].FullName -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
if ($actualHash -ne $declaredHash) { throw "candidate checksum mismatch" }
```

Expected: one installer and SHA-256 file under the SHA-specific candidate directory. Record the full source SHA, installer SHA-256, build time, and exact local candidate path; the filename may still contain the historical package version, so the directory and hashes are its identity. Do not upload or publish it.

Do not disable 360, add a global whitelist, or ignore quarantine. If 360 blocks the candidate, record the available file hash and alert category without sensitive local details, stop installation, and treat acceptance as incomplete.

- [ ] **Step 2: Choose the one-time login setup at the manual gate**

Record one of these explicit choices before touching browser profile data:

1. run `scripts/migrate-browser-profile.ps1` against the exact user-confirmed legacy source while all dedicated Edge processes are closed; or
2. leave the legacy source untouched and log in once in the new stable profile.

Migration copies only and preserves the source. If the user does not choose migration, continue with re-login; this does not block the feature.

- [ ] **Step 3: Verify startup and login persistence on the 360-protected computer**

With the user observing:

1. install the unpublished candidate;
2. start RoleFlow and prove `/health.browserAuthority` is `portable/9222/<stable profile>`;
3. use read-only process information to prove the listener executable is the resolved standard Microsoft Edge, then use `Get-AuthenticodeSignature` to require `Status=Valid` and a Microsoft signer;
4. if login is required, let the user log in and run the startup helper again;
5. prove one search tab, one communication tab, and one Dashboard tab share one window;
6. close the dedicated Edge completely and restart RoleFlow;
7. prove BOSS is still logged in;
8. overlay-install the exact same SHA candidate and prove login remains.

The live checklist may compare the full absolute profile path, but committed acceptance evidence writes `%LOCALAPPDATA%\RoleFlow\BrowserProfile` or a redacted equivalent. Do not store Cookies, browser command lines, Windows usernames, keys, resume contents, or message text.

- [ ] **Step 4: Verify background read-only behavior**

Before each pass, re-read `/health.browserAuthority` and prove it still names the dedicated Edge rather than Edge Control. Run one user-started read-only scan and one message discovery pass. Verify only behavior actually exercised:

- startup guidance may focus Dashboard or BOSS once;
- scan, JD, analysis, discovery, and any naturally reached cooldown never change the active tab;
- the baseline has exactly two fixed BOSS tabs;
- if an already-eligible new conversation lacks a trusted local JD, it creates at most one same-window `active: false` detail tab, closes it, and restores the typed baseline; otherwise record this case as not observed and rely on the offline regression rather than manufacturing extra BOSS requests;
- no input is filled, no message is sent, and no application is made.

Stop immediately on login loss, risk control, page loss, target mismatch, foreground change caused by product code, or ambiguous cleanup.

Do not deliberately trigger retry or recovery against BOSS merely to fill the checklist. Their no-focus behavior remains an offline regression requirement; record them as live-observed only if they occur naturally.

- [ ] **Step 5: Verify ordinary uninstall preservation only**

Before uninstall, create one uniquely named, non-sensitive text sentinel under the exact old install root's `data` directory and record its full path. Perform ordinary interactive uninstall and choose “否” for both deletion prompts. Confirm both `%LOCALAPPDATA%\RoleFlow\BrowserProfile` and that exact sentinel remain; the database itself need not be opened or copied. After recording the result, revalidate the sentinel is the exact file created by this acceptance and delete only that sentinel. Do not exercise destructive browser-profile deletion unless the user separately authorizes that exact directory at the time.

Then reinstall the exact same SHA candidate into a different, explicit user-writable install directory. Confirm `/health` uses the same stable profile and BOSS remains logged in. Also confirm the old install-root data stayed at the old path rather than claiming it migrated. Do not run two Dashboards concurrently. Leave the accepted install in place unless the user explicitly asks for cleanup.

- [ ] **Step 6: Rerun the final gate before writing acceptance claims**

Run:

```powershell
node tests/run_all.js
git diff --check
git status --short --branch
```

Expected: all 101 offline checks pass again.

- [ ] **Step 7: Record and verify acceptance evidence**

Update `docs/PROJECT_HANDOFF.md` and `docs/NEXT_PHASE.md` with the candidate source SHA/installer SHA, observed facts, explicitly unobserved cases, any unresolved manual decision, sanitized profile identity, and the fact that nothing was pushed or published. Then run:

```powershell
node tests/self_check.js
git diff --check
git status --short --branch
```

- [ ] **Step 8: Commit acceptance evidence without integrating or publishing**

```powershell
git add docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md
git commit -m "docs: record dedicated Edge acceptance"
```

Stop on `codex/stable-dedicated-edge`. Do not merge to `main`, push, tag, or publish until the user reviews the real effect and explicitly chooses the integration action.
