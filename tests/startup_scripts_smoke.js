const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
);
const tempParent = path.join(root, ".runtime", "startup-smoke");
fs.mkdirSync(tempParent, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(tempParent, "RoleFlow startup smoke "));
const projectRoot = path.join(tempRoot, "project with spaces");
const outsideCwd = path.join(tempRoot, "outside cwd");
const children = new Set();
const processRegistry = new Map();
let dashboardPort = 0;

runSmoke()
  .then(() => console.log("startup_scripts_smoke ok"))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });

async function runSmoke() {
  let primaryError = null;
  try {
    await main();
  } catch (error) {
    primaryError = error;
  }

  let cleanupError = null;
  try {
    await cleanupResources();
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `${primaryError.message}\nCleanup failure: ${cleanupError.message}`,
      { cause: primaryError }
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

async function main() {
  dashboardPort = Number(process.env.ROLEFLOW_STARTUP_DASHBOARD_PORT || 0)
    || await reserveFreePort();
  process.env.ROLEFLOW_STARTUP_DASHBOARD_PORT = String(dashboardPort);
  const cleanupProbe = process.env.ROLEFLOW_STARTUP_CLEANUP_PROBE || "";
  if (cleanupProbe === "aggregate") {
    throw new Error("STARTUP_CLEANUP_PROBE_PRIMARY_FAILURE");
  }

  assert(fs.existsSync(powershell), "Windows PowerShell 5.1 is required for startup script tests");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(outsideCwd, { recursive: true });
  createProjectFixture();
  await assertPortFree(dashboardPort);
  if (cleanupProbe === "processes") {
    await runIntentionalCleanupProcessProbe();
    return;
  }
  testProcessIdentityProbeUsesFixtureLocalAppData();
  testStartupIdentityHelpers();
  testRunScriptFromOutsideCwd();
  await testWorkspaceStartupFromSpacePath();
  await testExistingDashboardRetriesTransientRuntimeStatus();
  await testExistingDashboardRecoversStoppedBrowser();
  await testInstalledLauncherPreservesUtf8Output();
  await testConcurrentInstalledLaunchUsesOneDashboard();
  testPortableModeRejectsInvalidCdpPort();
  testEdgeModeRejectsDedicatedAuthority();
  testDashboardCommandRejectsMissingOrConflictingAuthority();
  await testForeignDashboardIdentityRejected();
  await testFailurePathCleansStartedProcesses();
  testCleanupFailureIsAggregated();
}

function createProjectFixture() {
  fs.mkdirSync(path.join(projectRoot, "scripts", "lib"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.copyFileSync(path.join(root, "run.ps1"), path.join(projectRoot, "run.ps1"));
  fs.copyFileSync(
    path.join(root, "scripts", "start-workspace.ps1"),
    path.join(projectRoot, "scripts", "start-workspace.ps1")
  );
  fs.copyFileSync(
    path.join(root, "scripts", "prepare-user-data.ps1"),
    path.join(projectRoot, "scripts", "prepare-user-data.ps1")
  );
  fs.copyFileSync(
    path.join(root, "scripts", "start-portable-edge.ps1"),
    path.join(projectRoot, "scripts", "start-portable-edge.ps1")
  );
  fs.copyFileSync(
    path.join(root, "scripts", "launch-installed.ps1"),
    path.join(projectRoot, "scripts", "launch-installed.ps1")
  );
  const identityHelper = path.join(root, "scripts", "lib", "startup-identity.ps1");
  if (fs.existsSync(identityHelper)) {
    fs.copyFileSync(
      identityHelper,
      path.join(projectRoot, "scripts", "lib", "startup-identity.ps1")
    );
  }
  fs.writeFileSync(
    path.join(projectRoot, "scripts", "install.ps1"),
    "param([switch]$CheckOnly)\r\nexit 0\r\n",
    "utf8"
  );
  fs.writeFileSync(path.join(projectRoot, "src", "cli.js"), fixtureCliSource(), "utf8");
  fs.writeFileSync(path.join(tempRoot, "foreign-health.js"), foreignHealthSource(), "utf8");
  fs.writeFileSync(path.join(tempRoot, "startup-helper-probe.ps1"), startupHelperProbeSource(), "utf8");
}

function testRunScriptFromOutsideCwd() {
  const recordPath = path.join(tempRoot, "direct-run.jsonl");
  const result = runPowerShell([
    "-File", path.join(projectRoot, "run.ps1"),
    "workspace-tabs",
    "--dashboard-url", `http://127.0.0.1:${dashboardPort}/`,
    "--browser", "portable",
    "--cdp-port", "9222"
  ], {
    cwd: outsideCwd,
    env: fixtureEnv({ ROLEFLOW_STARTUP_RECORD: recordPath })
  });
  assert.strictEqual(result.status, 0, combinedOutput(result));
  const records = readJsonLines(recordPath);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].command, "workspace-tabs");
  assert.strictEqual(
    normalizePath(records[0].scriptPath),
    normalizePath(path.join(projectRoot, "src", "cli.js"))
  );
}

async function testWorkspaceStartupFromSpacePath() {
  const recordPath = path.join(tempRoot, "workspace-start.jsonl");
  const result = runPowerShellUnicode([
    "-File", path.join(projectRoot, "scripts", "start-workspace.ps1"),
    "-Port", String(dashboardPort),
    "-NoBrowser"
  ], {
    cwd: outsideCwd,
    env: fixtureEnv({ ROLEFLOW_STARTUP_RECORD: recordPath }),
    timeout: 30000
  });
  assert.strictEqual(result.status, 0, combinedOutput(result));
  assert.match(combinedOutput(result), /浏览器：RoleFlow 专用 Edge（推荐）/);
  const records = readJsonLines(recordPath);
  const dashboard = records.find((item) => item.command === "dashboard");
  assert(dashboard, "dashboard command did not reach the fixture project CLI");
  registerProcess(dashboard.pid, {
    kind: "dashboard",
    expectedCommandFragment: path.join(projectRoot, "src", "cli.js")
  });
  assert.strictEqual(records.filter((item) => item.command === "workspace-tabs").length, 0, "application startup must not synchronously reconcile BOSS tabs");
  assert.strictEqual(normalizePath(dashboard.cwd), normalizePath(projectRoot));
  assert.strictEqual(normalizePath(dashboard.projectRoot), normalizePath(projectRoot));
  const expectedStableProfile = path.join(tempRoot, "local app data", "RoleFlow", "BrowserProfile");
  const expectedDataRoot = path.join(tempRoot, "local app data", "RoleFlow", "Data");
  for (const relativePath of ["data", ".runtime/settings", ".runtime/resumes", ".runtime/logs", "reports", "profiles"]) {
    assert(fs.statSync(path.join(expectedDataRoot, relativePath)).isDirectory(), `startup must prepare ${relativePath}`);
  }
  assert.deepStrictEqual(dashboard.args.slice(dashboard.args.indexOf("--browser")), [
    "--browser", "portable",
    "--data-root", expectedDataRoot,
    "--cdp-port", "9222",
    "--browser-profile", expectedStableProfile,
    "--no-browser"
  ]);
  const health = await getJson(`http://127.0.0.1:${dashboardPort}/health`);
  assert.deepStrictEqual(health.browserAuthority, {
    browserMode: "portable",
    cdpPort: 9222,
    profilePath: expectedStableProfile
  });
  await stopRegisteredProcess(dashboard.pid);
  await waitForPortClosed(dashboardPort);

  const edgeRecordPath = path.join(tempRoot, "workspace-edge.jsonl");
  const edge = runPowerShellUnicode([
    "-File", path.join(projectRoot, "scripts", "start-workspace.ps1"),
    "-Port", String(dashboardPort),
    "-BrowserMode", "edge",
    "-NoBrowser"
  ], {
    cwd: outsideCwd,
    env: fixtureEnv({ ROLEFLOW_STARTUP_RECORD: edgeRecordPath }),
    timeout: 30000
  });
  assert.strictEqual(edge.status, 0, combinedOutput(edge));
  assert.match(combinedOutput(edge), /浏览器：使用当前 Edge（高级，需要浏览器连接组件）/);
  const edgeRecords = readJsonLines(edgeRecordPath);
  const edgeDashboard = edgeRecords.find((item) => item.command === "dashboard");
  assert(edgeDashboard);
  registerProcess(edgeDashboard.pid, {
    kind: "dashboard",
    expectedCommandFragment: path.join(projectRoot, "src", "cli.js")
  });
  assert.strictEqual(edgeRecords.filter((item) => item.command === "workspace-tabs").length, 0);
  assert.deepStrictEqual(edgeDashboard.args.slice(edgeDashboard.args.indexOf("--browser")), ["--browser", "edge", "--data-root", expectedDataRoot, "--no-browser"]);
  await stopRegisteredProcess(edgeDashboard.pid);
  await waitForPortClosed(dashboardPort);
}

async function testExistingDashboardRecoversStoppedBrowser() {
  const recordPath = path.join(tempRoot, "workspace-recover.jsonl");
  fs.rmSync(recordPath, { force: true });
  const env = fixtureEnv({
    ROLEFLOW_STARTUP_RECORD: recordPath,
    ROLEFLOW_STARTUP_BROWSER_STATUS: "stopped"
  });
  const first = runPowerShellUnicode([
    "-File", path.join(projectRoot, "scripts", "start-workspace.ps1"),
    "-Port", String(dashboardPort),
    "-NoBrowser",
    "-NoOpen"
  ], { cwd: outsideCwd, env, timeout: 30000 });
  assert.strictEqual(first.status, 0, combinedOutput(first));

  const dashboard = readJsonLines(recordPath).find((item) => item.command === "dashboard");
  assert(dashboard, "recovery fixture did not start the Dashboard");
  registerProcess(dashboard.pid, {
    kind: "dashboard",
    expectedCommandFragment: path.join(projectRoot, "src", "cli.js")
  });

  const second = runPowerShellUnicode([
    "-File", path.join(projectRoot, "scripts", "start-workspace.ps1"),
    "-Port", String(dashboardPort),
    "-NoOpen"
  ], { cwd: outsideCwd, env, timeout: 30000 });
  assert.strictEqual(second.status, 0, combinedOutput(second));

  const records = readJsonLines(recordPath);
  assert.strictEqual(records.filter((item) => item.command === "dashboard").length, 1,
    "reopening RoleFlow must reuse the existing Dashboard");
  assert.strictEqual(records.filter((item) => item.command === "browser-recover").length, 1,
    "reopening RoleFlow must request exactly one browser recovery");
  const runtime = await getJson(`http://127.0.0.1:${dashboardPort}/api/runtime-status`);
  assert.strictEqual(runtime.browser.ready, true);

  await stopRegisteredProcess(dashboard.pid);
  await waitForPortClosed(dashboardPort);
}

async function testExistingDashboardRetriesTransientRuntimeStatus() {
  const recordPath = path.join(tempRoot, "workspace-runtime-retry.jsonl");
  fs.rmSync(recordPath, { force: true });
  const env = fixtureEnv({
    ROLEFLOW_STARTUP_RECORD: recordPath,
    ROLEFLOW_STARTUP_RUNTIME_FAILURES: "1",
    ROLEFLOW_STARTUP_RUNTIME_BLOCK_MS: "3500"
  });
  const first = runPowerShellUnicode([
    "-File", path.join(projectRoot, "scripts", "start-workspace.ps1"),
    "-Port", String(dashboardPort),
    "-NoBrowser",
    "-NoOpen"
  ], { cwd: outsideCwd, env, timeout: 30000 });
  assert.strictEqual(first.status, 0, combinedOutput(first));

  const dashboard = readJsonLines(recordPath).find((item) => item.command === "dashboard");
  assert(dashboard, "runtime retry fixture did not start the Dashboard");
  registerProcess(dashboard.pid, {
    kind: "dashboard",
    expectedCommandFragment: path.join(projectRoot, "src", "cli.js")
  });

  const second = runPowerShellUnicode([
    "-File", path.join(projectRoot, "scripts", "start-workspace.ps1"),
    "-Port", String(dashboardPort),
    "-NoOpen"
  ], { cwd: outsideCwd, env, timeout: 30000 });
  assert.strictEqual(second.status, 0, combinedOutput(second));
  assert.strictEqual(readJsonLines(recordPath).filter((item) => item.command === "dashboard").length, 1,
    "a transient runtime-status failure must not start a second Dashboard");

  await stopRegisteredProcess(dashboard.pid);
  await waitForPortClosed(dashboardPort);
}

async function testInstalledLauncherPreservesUtf8Output() {
  const launcherPath = path.join(projectRoot, "scripts", "launch-installed.ps1");
  const launcherSource = fs.readFileSync(launcherPath, "utf8");
  fs.writeFileSync(
    launcherPath,
    launcherSource.replace("[int]$Port = 8787", `[int]$Port = ${dashboardPort}`),
    "utf8"
  );
  const portableEdgePath = path.join(projectRoot, "scripts", "start-portable-edge.ps1");
  const portableEdgeSource = fs.readFileSync(portableEdgePath, "utf8");
  fs.writeFileSync(
    portableEdgePath,
    "param([int]$Port, [string]$ProfileDir)\r\nexit 0\r\n",
    "utf8"
  );
  const launcherLog = path.join(tempRoot, "local app data", "RoleFlow", "Data", ".runtime", "logs", "launcher.log");
  const installRootLauncherLog = path.join(projectRoot, ".runtime", "logs", "launcher.log");
  fs.rmSync(launcherLog, { force: true });
  fs.rmSync(installRootLauncherLog, { force: true });
  const recordPath = path.join(tempRoot, "launcher-unicode.jsonl");
  let dashboard = null;
  try {
    const result = runPowerShellUnicode([
      "-File", launcherPath
    ], {
      cwd: outsideCwd,
      env: fixtureEnv({
        ROLEFLOW_STARTUP_RECORD: recordPath,
        ROLEFLOW_STARTUP_UNICODE_PROBE: "1"
      }),
      timeout: 30000
    });
    if (fs.existsSync(recordPath)) {
      dashboard = readJsonLines(recordPath).find((item) => item.command === "dashboard") || null;
    }
    if (dashboard) {
      registerProcess(dashboard.pid, {
        kind: "dashboard",
        expectedCommandFragment: path.join(projectRoot, "src", "cli.js")
      });
    }
    assert.strictEqual(result.status, 0, combinedOutput(result));
    assert(dashboard, "launcher unicode probe did not start the fixture Dashboard");
    assert.match(
      fs.readFileSync(launcherLog, "utf8"),
      /浏览器：RoleFlow 专用 Edge（推荐）/,
      "installed launcher must preserve UTF-8 output from the workspace child process"
    );
    assert.strictEqual(fs.existsSync(installRootLauncherLog), false, "installed launch must not recreate logs under the program directory");
  } finally {
    fs.writeFileSync(portableEdgePath, portableEdgeSource, "utf8");
    if (dashboard && processRegistry.has(Number(dashboard.pid))) {
      await stopRegisteredProcess(dashboard.pid);
      await waitForPortClosed(dashboardPort);
    }
  }
}

async function testConcurrentInstalledLaunchUsesOneDashboard() {
  const launcherPath = path.join(projectRoot, "scripts", "launch-installed.ps1");
  const recordPath = path.join(tempRoot, "launcher-concurrent.jsonl");
  fs.rmSync(recordPath, { force: true });
  const env = fixtureEnv({ ROLEFLOW_STARTUP_RECORD: recordPath });
  const [first, second] = await Promise.all([
    runPowerShellAsync(["-File", launcherPath], { cwd: outsideCwd, env, timeout: 40000 }),
    runPowerShellAsync(["-File", launcherPath], { cwd: outsideCwd, env, timeout: 40000 })
  ]);
  assert.strictEqual(first.status, 0, combinedOutput(first));
  assert.strictEqual(second.status, 0, combinedOutput(second));

  const records = readJsonLines(recordPath);
  const dashboards = records.filter((item) => item.command === "dashboard");
  assert.strictEqual(dashboards.length, 1, "concurrent launchers must create exactly one Dashboard process");
  const health = await getJson(`http://127.0.0.1:${dashboardPort}/health`);
  assert.strictEqual(health.pid, dashboards[0].pid);
  registerProcess(health.pid, {
    kind: "dashboard",
    expectedCommandFragment: path.join(projectRoot, "src", "cli.js")
  });
  await stopRegisteredProcess(health.pid);
  await waitForPortClosed(dashboardPort);
}

function testPortableModeRejectsInvalidCdpPort() {
  const portableScript = path.join(projectRoot, "scripts", "start-portable-edge.ps1");
  const portableScriptSource = fs.readFileSync(portableScript, "utf8");
  fs.writeFileSync(
    portableScript,
    [
      "param([int]$Port)",
      "if ($env:ROLEFLOW_PORTABLE_EDGE_AUDIT) {",
      "  Add-Content -LiteralPath $env:ROLEFLOW_PORTABLE_EDGE_AUDIT -Value $Port",
      "}",
      "exit 0"
    ].join("\r\n"),
    "utf8"
  );
  const recordPath = path.join(tempRoot, "workspace-invalid-port.jsonl");
  const edgeAuditPath = path.join(tempRoot, "portable-edge-invalid-port.txt");
  try {
    const result = runPowerShell([
      "-File", path.join(projectRoot, "scripts", "start-workspace.ps1"),
      "-Port", String(dashboardPort),
      "-BrowserMode", "portable",
      "-CdpPort", "9333"
    ], {
      cwd: outsideCwd,
      env: fixtureEnv({
        ROLEFLOW_STARTUP_RECORD: recordPath,
        ROLEFLOW_PORTABLE_EDGE_AUDIT: edgeAuditPath
      }),
      timeout: 10000
    });
    assert.notStrictEqual(result.status, 0, "portable mode must reject a non-9222 port");
    assert.match(combinedOutput(result), /WORKSPACE_PORTABLE_BROWSER_REQUIRED/);
    assert(!fs.existsSync(edgeAuditPath), "invalid portable port must not start portable Edge");
    assert(!fs.existsSync(recordPath), "invalid portable port must not invoke workspace-tabs");
  } finally {
    fs.writeFileSync(portableScript, portableScriptSource, "utf8");
  }
}

async function testForeignDashboardIdentityRejected() {
  for (const mode of ["other-project", "missing-identity", "pid-mismatch", "authority-mode", "authority-port", "authority-profile"]) {
    const child = startNodeServer(path.join(tempRoot, "foreign-health.js"), [
      String(dashboardPort),
      mode,
      projectRoot
    ]);
    await waitForHttp(`http://127.0.0.1:${dashboardPort}/health`);
    const result = runPowerShell([
      "-File", path.join(projectRoot, "scripts", "start-workspace.ps1"),
      "-Port", String(dashboardPort),
      "-NoBrowser",
      "-NoOpen"
    ], {
      cwd: outsideCwd,
      env: fixtureEnv(),
      timeout: 10000
    });
    assert.notStrictEqual(result.status, 0, `${mode} health listener must be rejected`);
    assert.match(combinedOutput(result), /identity|current project|listener PID|DASHBOARD_BROWSER_AUTHORITY_MISMATCH/i);
    await stopChild(child);
    await waitForPortClosed(dashboardPort);
  }
}

async function runIntentionalCleanupProcessProbe() {
  const auditPath = process.env.ROLEFLOW_STARTUP_CLEANUP_AUDIT;
  assert(auditPath, "cleanup process probe requires an audit path");

  const dashboardRecord = path.join(tempRoot, "cleanup-probe-dashboard.jsonl");
  const dashboardResult = runPowerShell([
    "-File", path.join(projectRoot, "scripts", "start-workspace.ps1"),
    "-Port", String(dashboardPort),
    "-NoBrowser",
    "-NoOpen"
  ], {
    cwd: outsideCwd,
    env: fixtureEnv({ ROLEFLOW_STARTUP_RECORD: dashboardRecord }),
    timeout: 30000
  });
  assert.strictEqual(dashboardResult.status, 0, combinedOutput(dashboardResult));
  const dashboard = readJsonLines(dashboardRecord).find((item) => item.command === "dashboard");
  assert(dashboard, "cleanup process probe did not record the Dashboard PID");
  registerProcess(dashboard.pid, {
    kind: "dashboard",
    expectedCommandFragment: path.join(projectRoot, "src", "cli.js")
  });

  throw new Error("STARTUP_CLEANUP_PROBE_PRIMARY_FAILURE");
}

function testEdgeModeRejectsDedicatedAuthority() {
  for (const args of [
    ["-BrowserMode", "edge", "-ProfileDir", path.join(tempRoot, "explicit-profile")],
    ["-BrowserMode", "edge", "-CdpPort", "9222"]
  ]) {
    const result = runPowerShell([
      "-File", path.join(projectRoot, "scripts", "start-workspace.ps1"),
      "-Port", String(dashboardPort),
      "-NoBrowser",
      "-NoOpen",
      ...args
    ], { cwd: outsideCwd, env: fixtureEnv(), timeout: 10000 });
    assert.notStrictEqual(result.status, 0, "Edge Control must reject explicitly supplied dedicated Edge fields");
    assert.match(combinedOutput(result), /WORKSPACE_EDGE_BROWSER_AUTHORITY_INVALID/);
  }
}

function testDashboardCommandRejectsMissingOrConflictingAuthority() {
  for (const args of [
    ["dashboard", "--port", String(dashboardPort)],
    ["dashboard", "--port", String(dashboardPort), "--browser", "edge", "--cdp-port", "9222"],
    ["dashboard", "--port", String(dashboardPort), "--browser", "edge", "--browser-profile", path.join(tempRoot, "explicit-profile")]
  ]) {
    const result = runPowerShell([
      "-File", path.join(projectRoot, "run.ps1"),
      ...args
    ], { cwd: outsideCwd, env: fixtureEnv(), timeout: 10000 });
    assert.notStrictEqual(result.status, 0, "dashboard command must require one valid immutable browser authority");
    assert.match(combinedOutput(result), /WORKFLOW_BROWSER_MODE_INVALID|DASHBOARD_BROWSER_AUTHORITY_INVALID/);
  }
}

async function testFailurePathCleansStartedProcesses() {
  const auditPath = path.join(tempRoot, "cleanup-probe-audit.jsonl");
  const result = spawnSync(process.execPath, [__filename], {
    cwd: outsideCwd,
    env: fixtureEnv({
      ROLEFLOW_STARTUP_CLEANUP_PROBE: "processes",
      ROLEFLOW_STARTUP_CLEANUP_AUDIT: auditPath
    }),
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true
  });
  assert.notStrictEqual(result.status, 0, "the intentional cleanup probe must preserve its primary failure");
  assert.match(combinedOutput(result), /STARTUP_CLEANUP_PROBE_PRIMARY_FAILURE/);
  const audited = readJsonLines(auditPath);
  assert.deepStrictEqual(audited.map((item) => item.kind).sort(), ["dashboard"]);

  let verificationError = null;
  try {
    for (const entry of audited) {
      await waitForProcessExited(entry.pid, 1500);
    }
    await waitForPortClosed(dashboardPort, 1500);
  } catch (error) {
    verificationError = error;
  }

  const emergencyCleanupErrors = [];
  for (const entry of audited) {
    registerProcess(entry.pid, {
      kind: entry.kind,
      expectedCommandFragment: entry.expectedCommandFragment,
      audit: false
    });
    await stopRegisteredProcess(entry.pid).catch((error) => emergencyCleanupErrors.push(error));
  }
  for (const entry of audited) {
    await waitForProcessExited(entry.pid, 5000).catch((error) => emergencyCleanupErrors.push(error));
  }
  await waitForPortClosed(dashboardPort, 5000).catch((error) => emergencyCleanupErrors.push(error));

  if (verificationError && emergencyCleanupErrors.length) {
    throw new AggregateError(
      [verificationError, ...emergencyCleanupErrors],
      `${verificationError.message}; emergency cleanup also failed`
    );
  }
  if (verificationError) throw verificationError;
  if (emergencyCleanupErrors.length) {
    throw new AggregateError(emergencyCleanupErrors, "cleanup probe emergency cleanup failed");
  }
}

function testCleanupFailureIsAggregated() {
  const result = spawnSync(process.execPath, [__filename], {
    cwd: outsideCwd,
    env: fixtureEnv({
      ROLEFLOW_STARTUP_CLEANUP_PROBE: "aggregate",
      ROLEFLOW_STARTUP_FORCE_CLEANUP_FAILURE: "1"
    }),
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true
  });
  const output = combinedOutput(result);
  assert.notStrictEqual(result.status, 0);
  assert.match(output, /STARTUP_CLEANUP_PROBE_PRIMARY_FAILURE/);
  assert.match(output, /STARTUP_CLEANUP_FORCED_FAILURE/);
}

function testStartupIdentityHelpers() {
  const localAppDataPath = path.join(tempRoot, "local app data");
  const absoluteProfile = path.join(tempRoot, "explicit profile");
  const acceptedSnapshot = {
    ProcessName: "msedge.exe",
    ExecutablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    CommandLine: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --disable-features=CalculateNativeWinOcclusion "--user-data-dir=C:\\RoleFlow Profile"',
    EdgePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    Port: 9222,
    ProfilePath: "C:\\RoleFlow Profile"
  };
  const explicitNestedSnapshot = {
    ...acceptedSnapshot,
    CommandLine: acceptedSnapshot.CommandLine.replace("C:\\RoleFlow Profile", "C:\\Profiles\\Dedicated")
  };
  const defaultEdgeUserData = path.join(localAppDataPath, "Microsoft", "Edge", "User Data");
  const defaultEdgeSnapshot = {
    ...acceptedSnapshot,
    CommandLine: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --profile-directory=Default'
  };
  const otherProfileSnapshot = {
    querySucceeded: true,
    processes: [
      { ...acceptedSnapshot, ProcessName: "node.exe" },
      {
        ...acceptedSnapshot,
        CommandLine: acceptedSnapshot.CommandLine.replace("C:\\RoleFlow Profile", "C:\\Other Profile")
      }
    ]
  };
  const listenerParameters = (listenerSnapshot, processQuerySnapshot) => ({
    ListenerSnapshot: listenerSnapshot,
    ProcessQuerySnapshot: processQuerySnapshot,
    EdgePath: acceptedSnapshot.EdgePath,
    Port: 9222,
    ProfilePath: "C:\\RoleFlow Profile"
  });
  const loopbackListener = { querySucceeded: true, listeners: [{ localAddress: "127.0.0.1", owningProcess: 4242 }] };
  const edgeProcessQuery = { querySucceeded: true, processes: [{ ...acceptedSnapshot, ProcessId: 4242 }] };
  const cases = [
    {
      name: "unused port is a successful empty listener snapshot",
      functionName: "Get-RoleFlowTcpListenerSnapshot",
      parameters: { Port: dashboardPort },
      expected: { accepted: true, value: { querySucceeded: true, listeners: [] } }
    },
    {
      name: "stable profile is project-independent",
      functionName: "Resolve-RoleFlowBrowserProfilePath",
      parameters: { ProjectRoot: path.join(tempRoot, "project-a"), ProfileDir: "", LocalAppDataPath: localAppDataPath },
      expected: { accepted: true, value: path.join(localAppDataPath, "RoleFlow", "BrowserProfile"), path: true }
    },
    {
      name: "stable profile ignores a second project root",
      functionName: "Resolve-RoleFlowBrowserProfilePath",
      parameters: { ProjectRoot: path.join(tempRoot, "project-b"), ProfileDir: "", LocalAppDataPath: localAppDataPath },
      expected: { accepted: true, value: path.join(localAppDataPath, "RoleFlow", "BrowserProfile"), path: true }
    },
    {
      name: "relative profile resolves from project root",
      functionName: "Resolve-RoleFlowBrowserProfilePath",
      parameters: { ProjectRoot: path.join(tempRoot, "project-a"), ProfileDir: "profiles\\dedicated", LocalAppDataPath: localAppDataPath },
      expected: { accepted: true, value: path.join(tempRoot, "project-a", "profiles", "dedicated"), path: true }
    },
    {
      name: "absolute profile remains absolute",
      functionName: "Resolve-RoleFlowBrowserProfilePath",
      parameters: { ProjectRoot: path.join(tempRoot, "project-a"), ProfileDir: absoluteProfile, LocalAppDataPath: localAppDataPath },
      expected: { accepted: true, value: absoluteProfile, path: true }
    },
    {
      name: "portable Edge arguments preserve frozen authority",
      functionName: "New-RoleFlowPortableEdgeArguments",
      parameters: { Port: 9222, ProfilePath: "C:\\RoleFlow Profile", StartUrl: `http://127.0.0.1:${dashboardPort}/` },
      expected: {
        accepted: true,
        value: [
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=9222",
          "--remote-allow-origins=*",
          "--disable-features=CalculateNativeWinOcclusion",
          '"--user-data-dir=C:\\RoleFlow Profile"',
          "--no-first-run",
          "--no-default-browser-check",
          `http://127.0.0.1:${dashboardPort}/`
        ]
      }
    },
    { name: "portable Edge process accepts exact identity", functionName: "Assert-RoleFlowPortableEdgeProcessSnapshot", parameters: acceptedSnapshot, expected: { accepted: true, value: true } },
    { name: "portable Edge process rejects executable mismatch", functionName: "Assert-RoleFlowPortableEdgeProcessSnapshot", parameters: { ...acceptedSnapshot, ExecutablePath: "C:\\fixture\\msedge.exe" }, expected: { accepted: false, error: /different executable/i } },
    { name: "portable Edge process rejects profile mismatch", functionName: "Assert-RoleFlowPortableEdgeProcessSnapshot", parameters: { ...acceptedSnapshot, ProfilePath: "C:\\wrong profile" }, expected: { accepted: false, error: /different profile/i } },
    { name: "portable Edge process rejects non-loopback address", functionName: "Assert-RoleFlowPortableEdgeProcessSnapshot", parameters: { ...acceptedSnapshot, CommandLine: acceptedSnapshot.CommandLine.replace("127.0.0.1", "0.0.0.0") }, expected: { accepted: false, error: /loopback address/i } },
    { name: "portable Edge process rejects ambiguous address", functionName: "Assert-RoleFlowPortableEdgeProcessSnapshot", parameters: { ...acceptedSnapshot, CommandLine: `${acceptedSnapshot.CommandLine} --remote-debugging-address=0.0.0.0` }, expected: { accepted: false, error: /loopback address/i } },
    { name: "portable Edge process rejects port mismatch", functionName: "Assert-RoleFlowPortableEdgeProcessSnapshot", parameters: { ...acceptedSnapshot, CommandLine: acceptedSnapshot.CommandLine.replace("9222", "9333") }, expected: { accepted: false, error: /different port/i } },
    { name: "portable Edge process rejects missing occlusion capability", functionName: "Assert-RoleFlowPortableEdgeProcessSnapshot", parameters: { ...acceptedSnapshot, CommandLine: acceptedSnapshot.CommandLine.replace(" --disable-features=CalculateNativeWinOcclusion", "") }, expected: { accepted: false, error: /native window occlusion/i } },
    { name: "portable Edge listener accepts exact identity", functionName: "Assert-RoleFlowPortableEdgeListenerSnapshot", parameters: listenerParameters(loopbackListener, edgeProcessQuery), expected: { accepted: true, value: 4242 } },
    { name: "portable Edge listener rejects failed listener query", functionName: "Assert-RoleFlowPortableEdgeListenerSnapshot", parameters: listenerParameters({ querySucceeded: false, listeners: [] }, edgeProcessQuery), expected: { accepted: false, error: /listener enumeration failed/i } },
    { name: "portable Edge listener rejects all-address listener", functionName: "Assert-RoleFlowPortableEdgeListenerSnapshot", parameters: listenerParameters({ querySucceeded: true, listeners: [{ localAddress: "0.0.0.0", owningProcess: 4242 }] }, edgeProcessQuery), expected: { accepted: false, error: /exactly one loopback listener/i } },
    { name: "portable Edge listener rejects IPv6 listener", functionName: "Assert-RoleFlowPortableEdgeListenerSnapshot", parameters: listenerParameters({ querySucceeded: true, listeners: [{ localAddress: "::", owningProcess: 4242 }] }, edgeProcessQuery), expected: { accepted: false, error: /exactly one loopback listener/i } },
    { name: "portable Edge listener rejects ambiguous listener", functionName: "Assert-RoleFlowPortableEdgeListenerSnapshot", parameters: listenerParameters({ querySucceeded: true, listeners: [{ localAddress: "127.0.0.1", owningProcess: 4242 }, { localAddress: "127.0.0.1", owningProcess: 4343 }] }, edgeProcessQuery), expected: { accepted: false, error: /exactly one loopback listener/i } },
    { name: "portable Edge listener rejects incomplete process", functionName: "Assert-RoleFlowPortableEdgeListenerSnapshot", parameters: listenerParameters(loopbackListener, { querySucceeded: true, processes: [{ ...acceptedSnapshot, ProcessId: 4242, CommandLine: "" }] }), expected: { accepted: false, error: /CommandLine/ } },
    { name: "portable Edge listener rejects failed process query", functionName: "Assert-RoleFlowPortableEdgeListenerSnapshot", parameters: listenerParameters(loopbackListener, { querySucceeded: false, processes: [] }), expected: { accepted: false, error: /process enumeration failed/i } }
  ];
  for (const [name, profilePath, processQuerySnapshot, expected] of [
    ["browser profile rejects exact use", "C:\\RoleFlow Profile", { querySucceeded: true, processes: [acceptedSnapshot] }, { accepted: false, error: /already in use/i }],
    ["browser profile rejects actual descendant", "C:\\Profiles", { querySucceeded: true, processes: [explicitNestedSnapshot] }, { accepted: false, error: /already in use/i }],
    ["browser profile rejects expected descendant", "C:\\Profiles\\Dedicated\\Default", { querySucceeded: true, processes: [explicitNestedSnapshot] }, { accepted: false, error: /already in use/i }],
    ["browser profile rejects default authority", defaultEdgeUserData, { querySucceeded: true, processes: [defaultEdgeSnapshot] }, { accepted: false, error: /already in use/i }],
    ["browser profile rejects default child", path.join(defaultEdgeUserData, "Default"), { querySucceeded: true, processes: [defaultEdgeSnapshot] }, { accepted: false, error: /already in use/i }],
    ["browser profile rejects default parent", path.dirname(defaultEdgeUserData), { querySucceeded: true, processes: [defaultEdgeSnapshot] }, { accepted: false, error: /already in use/i }],
    ["browser profile accepts independent stable profile", path.join(localAppDataPath, "RoleFlow", "BrowserProfile"), { querySucceeded: true, processes: [defaultEdgeSnapshot] }, { accepted: true, value: true }],
    ["browser profile rejects failed process query", "C:\\RoleFlow Profile", { querySucceeded: false, processes: [] }, { accepted: false, error: /process enumeration failed/i }],
    ["browser profile rejects missing process name", "C:\\RoleFlow Profile", { querySucceeded: true, processes: [{ ...acceptedSnapshot, ProcessName: "" }] }, { accepted: false, error: /incomplete identity/i }],
    ["browser profile rejects missing executable", "C:\\RoleFlow Profile", { querySucceeded: true, processes: [{ ...acceptedSnapshot, ExecutablePath: "" }] }, { accepted: false, error: /incomplete identity/i }],
    ["browser profile rejects missing command line", "C:\\RoleFlow Profile", { querySucceeded: true, processes: [{ ...acceptedSnapshot, CommandLine: "" }] }, { accepted: false, error: /incomplete identity/i }],
    ["browser profile ignores confirmed non-Edge process", "C:\\RoleFlow Profile", otherProfileSnapshot, { accepted: true, value: true }]
  ]) {
    cases.push({
      name,
      functionName: "Assert-RoleFlowBrowserProfileNotInUse",
      parameters: { ProfilePath: profilePath, ProcessQuerySnapshot: processQuerySnapshot },
      expected
    });
  }

  const results = invokeStartupHelperBatch(cases.map(({ functionName, parameters }) => ({ functionName, parameters })));
  assert.strictEqual(results.length, cases.length, "startup helper batch returned an incomplete result set");
  for (const [index, testCase] of cases.entries()) {
    const actual = results[index];
    assert.strictEqual(actual.accepted, testCase.expected.accepted, `${testCase.name}: ${actual.error}`);
    if (testCase.expected.accepted) {
      assert.strictEqual(actual.error, "", `${testCase.name}: unexpected error`);
      if (testCase.expected.path) {
        assert.strictEqual(normalizePath(actual.value), normalizePath(testCase.expected.value), testCase.name);
      } else {
        assert.deepStrictEqual(actual.value, testCase.expected.value, testCase.name);
      }
    } else {
      assert.strictEqual(actual.value, null, `${testCase.name}: rejected call returned a value`);
      assert.match(actual.error, testCase.expected.error, `${testCase.name}: ${actual.error}`);
    }
  }
}

function testProcessIdentityProbeUsesFixtureLocalAppData() {
  const identity = readWindowsProcessIdentity(process.pid);
  assert.strictEqual(
    normalizePath(identity.localAppData),
    normalizePath(path.join(tempRoot, "local app data")),
    "the direct PowerShell process-identity probe must use fixture LOCALAPPDATA"
  );
}

function startNodeServer(script, args) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: outsideCwd,
    env: fixtureEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  children.add(child);
  registerProcess(child.pid, {
    kind: "node-stub",
    expectedCommandFragment: script,
    child
  });
  return child;
}

function runPowerShell(args, {
  cwd = outsideCwd,
  env = fixtureEnv(),
  timeout = 20000
} = {}) {
  return spawnSync(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    ...args
  ], {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    windowsHide: true
  });
}

function runPowerShellAsync(args, {
  cwd = outsideCwd,
  env = fixtureEnv(),
  timeout = 20000
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      ...args
    ], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell fixture timed out after ${timeout}ms`));
    }, timeout);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function runPowerShellUnicode(args, {
  cwd = outsideCwd,
  env = fixtureEnv(),
  timeout = 20000
} = {}) {
  return spawnSync(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    ...args
  ], {
    cwd,
    env,
    encoding: "buffer",
    timeout,
    windowsHide: true
  });
}

function invokeStartupHelperBatch(calls) {
  const payloadPath = path.join(tempRoot, `startup-helper-batch-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify({ calls }), "utf8");
  try {
    const result = runPowerShell([
      "-File", path.join(tempRoot, "startup-helper-probe.ps1"),
      "-PayloadPath", payloadPath,
      "-HelperPath",
      path.join(projectRoot, "scripts", "lib", "startup-identity.ps1")
    ], { cwd: outsideCwd, timeout: 10000 });
    const output = combinedOutput(result);
    if (result.status !== 0) throw new Error(output);
    return JSON.parse(String(result.stdout || "").trim());
  } finally {
    fs.rmSync(payloadPath, { force: true });
  }
}

function fixtureEnv(extra = {}) {
  return {
    ...process.env,
    LOCALAPPDATA: path.join(tempRoot, "local app data"),
    ZHIPPING_NODE: process.execPath,
    ...extra
  };
}

function readJsonLines(filePath) {
  assert(fs.existsSync(filePath), `missing fixture record: ${filePath}`);
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function combinedOutput(result) {
  return [
    result.error?.message || "",
    decodeWindowsConsoleOutput(result.stdout),
    decodeWindowsConsoleOutput(result.stderr)
  ].filter(Boolean).join("\n");
}

function decodeWindowsConsoleOutput(value) {
  if (!Buffer.isBuffer(value)) return String(value || "");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return new TextDecoder("gb18030").decode(value);
  }
}

function normalizePath(value) {
  return path.resolve(String(value || "")).replace(/[\\/]+$/, "").toLowerCase();
}

function registerProcess(pid, {
  kind,
  expectedCommandFragment,
  child = null,
  audit = true
}) {
  const processId = Number(pid);
  if (!Number.isInteger(processId) || processId <= 0) {
    throw new Error(`cannot register invalid ${kind || "fixture"} PID: ${pid}`);
  }
  const expected = String(expectedCommandFragment || "").trim();
  if (!expected) {
    throw new Error(`cannot register fixture PID ${processId} without an expected command identity`);
  }
  const existing = processRegistry.get(processId);
  if (existing) {
    if (child) existing.child = child;
    return existing;
  }
  const entry = {
    pid: processId,
    kind: String(kind || "fixture"),
    expectedCommandFragment: expected,
    child
  };
  processRegistry.set(processId, entry);
  const auditPath = process.env.ROLEFLOW_STARTUP_CLEANUP_AUDIT;
  if (audit && auditPath) {
    fs.appendFileSync(auditPath, `${JSON.stringify({
      kind: entry.kind,
      pid: entry.pid,
      expectedCommandFragment: entry.expectedCommandFragment
    })}\n`, "utf8");
  }
  return entry;
}

async function stopChild(child) {
  if (!child) return;
  const entry = processRegistry.get(Number(child.pid));
  if (!entry) {
    throw new Error(`direct fixture child ${child.pid} was not registered`);
  }
  await stopRegisteredProcess(entry.pid);
}

async function stopRegisteredProcess(pid) {
  const processId = Number(pid);
  const entry = processRegistry.get(processId);
  if (!entry) throw new Error(`fixture PID ${pid} is not registered`);
  if (!isProcessRunning(processId)) {
    processRegistry.delete(processId);
    if (entry.child) children.delete(entry.child);
    return;
  }

  const identity = readWindowsProcessIdentity(processId);
  if (!identity && !isProcessRunning(processId)) {
    processRegistry.delete(processId);
    if (entry.child) children.delete(entry.child);
    return;
  }
  const identityText = `${identity?.executablePath || ""}\n${identity?.commandLine || ""}`.toLowerCase();
  if (!identityText.includes(entry.expectedCommandFragment.toLowerCase())) {
    throw new Error(
      `refusing to terminate PID ${processId}: process identity does not match registered ${entry.kind} fixture`
    );
  }

  process.kill(processId);
  await waitForProcessExited(processId, 5000);
  processRegistry.delete(processId);
  if (entry.child) children.delete(entry.child);
}

function readWindowsProcessIdentity(pid) {
  const processId = Number(pid);
  const script = [
    `$item = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${processId}" -ErrorAction SilentlyContinue`,
    "if ($null -ne $item) {",
    "  [pscustomobject]@{ executablePath = [string]$item.ExecutablePath; commandLine = [string]$item.CommandLine; localAppData = [string]$env:LOCALAPPDATA } | ConvertTo-Json -Compress",
    "}"
  ].join("\n");
  const result = spawnSync(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script
  ], {
    env: fixtureEnv(),
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true
  });
  if (result.error) {
    throw new Error(`failed to inspect registered fixture PID ${processId}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`failed to inspect registered fixture PID ${processId}: ${combinedOutput(result)}`);
  }
  const output = String(result.stdout || "").trim();
  return output ? JSON.parse(output) : null;
}

async function cleanupResources() {
  const cleanupErrors = [];
  try {
    recoverRecordedProcesses();
  } catch (error) {
    cleanupErrors.push(error);
  }

  for (const child of children) {
    if (processRegistry.has(Number(child.pid))) continue;
    cleanupErrors.push(new Error(`direct fixture child ${child.pid} was not registered`));
  }
  for (const entry of [...processRegistry.values()]) {
    try {
      await stopRegisteredProcess(entry.pid);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const port of [dashboardPort].filter((value) => value > 0)) {
    try {
      await waitForPortClosed(port, 5000);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (process.env.ROLEFLOW_STARTUP_FORCE_CLEANUP_FAILURE === "1") {
    cleanupErrors.push(new Error("STARTUP_CLEANUP_FORCED_FAILURE"));
  }

  try {
    const expectedPrefix = path.join(tempParent, "RoleFlow startup smoke ");
    assert(
      path.resolve(tempRoot).startsWith(path.resolve(expectedPrefix)),
      `refusing to remove unexpected startup smoke directory: ${tempRoot}`
    );
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (cleanupErrors.length) {
    throw new AggregateError(
      cleanupErrors,
      `STARTUP_CLEANUP_FAILED: ${cleanupErrors.map((error) => error.message).join(" | ")}`
    );
  }
}

function recoverRecordedProcesses() {
  if (!fs.existsSync(tempRoot)) return;
  for (const filePath of listFilesRecursively(tempRoot)) {
    const filename = path.basename(filePath).toLowerCase();
    if (filename.endsWith(".jsonl")) {
      for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean)) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.expectedCommandFragment && record.pid) {
          registerProcess(record.pid, {
            kind: record.kind || "recovered-fixture",
            expectedCommandFragment: record.expectedCommandFragment
          });
        } else if (record.command === "dashboard" && record.pid && record.scriptPath) {
          registerProcess(record.pid, {
            kind: "dashboard",
            expectedCommandFragment: record.scriptPath
          });
        }
      }
      continue;
    }
  }
}

function listFilesRecursively(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursively(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

async function assertPortFree(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  }).catch((error) => {
    throw new Error(`NEEDS_CONTEXT: startup smoke requires free port ${port}: ${error.message}`);
  });
  await new Promise((resolve) => server.close(resolve));
}

async function reserveFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = Number(address && typeof address === "object" ? address.port : 0);
  await new Promise((resolve) => server.close(resolve));
  assert(Number.isInteger(port) && port > 0, "could not reserve an isolated dashboard test port");
  return port;
}

async function waitForHttp(url, timeoutMs = 5000) {
  await waitFor(async () => {
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      return true;
    } catch {
      return false;
    }
  }, timeoutMs, `HTTP endpoint did not become ready: ${url}`);
}

async function waitForPortClosed(port, timeoutMs = 5000) {
  await waitFor(async () => {
    const server = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      await new Promise((resolve) => server.close(resolve));
      return true;
    } catch {
      try { server.close(); } catch {}
      return false;
    }
  }, timeoutMs, `port ${port} did not close`);
}

async function waitForProcessExited(pid, timeoutMs = 5000) {
  await waitFor(
    () => !isProcessRunning(pid),
    timeoutMs,
    `process ${pid} did not exit`
  );
}

function isProcessRunning(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs, failureMessage) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(failureMessage);
}

function fixtureCliSource() {
  return String.raw`
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const projectRoot = path.resolve(__dirname, "..");
const command = process.argv[2] || "";
const args = process.argv.slice(3);
const record = process.env.ROLEFLOW_STARTUP_RECORD;
if (record) {
  fs.appendFileSync(record, JSON.stringify({
    pid: process.pid,
    command,
    args,
    cwd: process.cwd(),
    projectRoot,
    scriptPath: __filename
  }) + "\n");
}
if (command === "workspace-tabs" && process.env.ROLEFLOW_STARTUP_UNICODE_PROBE) {
  console.log("后台标签页创建后未能安全确认。");
  process.exit(0);
}
if (command !== "dashboard") process.exit(0);
const browserIndex = args.indexOf("--browser");
const browserMode = browserIndex >= 0 ? args[browserIndex + 1] : "";
const cdpIndex = args.indexOf("--cdp-port");
const profileIndex = args.indexOf("--browser-profile");
const cdpPort = cdpIndex >= 0 ? Number(args[cdpIndex + 1]) : null;
const profilePath = profileIndex >= 0 ? args[profileIndex + 1] : "";
let browserReady = process.env.ROLEFLOW_STARTUP_BROWSER_STATUS !== "stopped";
let runtimeFailuresRemaining = Number(process.env.ROLEFLOW_STARTUP_RUNTIME_FAILURES || 0);
const runtimeFailureBlockMs = Number(process.env.ROLEFLOW_STARTUP_RUNTIME_BLOCK_MS || 0);
if (!["edge", "portable"].includes(browserMode)) {
  throw new Error("WORKFLOW_BROWSER_MODE_INVALID");
}
if (browserMode === "edge" && (cdpIndex >= 0 || profileIndex >= 0)) {
  throw new Error("DASHBOARD_BROWSER_AUTHORITY_INVALID");
}
if (browserMode === "portable" && (cdpPort !== 9222 || !path.isAbsolute(profilePath))) {
  throw new Error("DASHBOARD_BROWSER_AUTHORITY_INVALID");
}
const portIndex = args.indexOf("--port");
const port = Number(args[portIndex + 1]);
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true, projectRoot, pid: process.pid, browserAuthority: { browserMode, cdpPort, profilePath } }));
    return;
  }
  if (req.url === "/api/runtime-status") {
    if (runtimeFailuresRemaining > 0) {
      runtimeFailuresRemaining -= 1;
      const blockedUntil = Date.now() + runtimeFailureBlockMs;
      while (Date.now() < blockedUntil) {}
    }
    res.end(JSON.stringify({
      application: { status: "ready", ready: true },
      browser: browserMode === "portable"
        ? { status: browserReady ? "ready" : "stopped", ready: browserReady, message: browserReady ? "ready" : "stopped", action: browserReady ? "none" : "recover" }
        : null,
      workspace: { status: "unchecked", ready: false, message: "unchecked" }
    }));
    return;
  }
  if (req.url === "/api/runtime/browser/recover" && req.method === "POST") {
    browserReady = true;
    if (record) fs.appendFileSync(record, JSON.stringify({ pid: process.pid, command: "browser-recover", args: [] }) + "\n");
    res.end(JSON.stringify({ browser: { status: "ready", ready: true, message: "ready", action: "none" } }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});
server.listen(port, "127.0.0.1");
`;
}

function foreignHealthSource() {
  return String.raw`
const http = require("node:http");
const path = require("node:path");
const port = Number(process.argv[2]);
const mode = process.argv[3];
const projectRoot = process.argv[4];
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url !== "/health") {
    res.statusCode = 404;
    res.end("{}");
    return;
  }
  const authority = mode === "authority-mode"
    ? { browserMode: "edge", cdpPort: null, profilePath: "" }
    : mode === "authority-port"
      ? { browserMode: "portable", cdpPort: 9333, profilePath: path.join(process.env.LOCALAPPDATA, "RoleFlow", "BrowserProfile") }
      : mode === "authority-profile"
        ? { browserMode: "portable", cdpPort: 9222, profilePath: path.join(process.env.LOCALAPPDATA, "RoleFlow", "OtherProfile") }
        : { browserMode: "portable", cdpPort: 9222, profilePath: path.join(process.env.LOCALAPPDATA, "RoleFlow", "BrowserProfile") };
  const body = mode === "missing-identity"
    ? { ok: true }
    : mode === "pid-mismatch"
      ? { ok: true, projectRoot, pid: process.pid + 1000, browserAuthority: authority }
      : mode === "other-project"
        ? { ok: true, projectRoot: "D:\\Other\\RoleFlow", pid: process.pid, browserAuthority: authority }
        : { ok: true, projectRoot, pid: process.pid, browserAuthority: authority };
  res.end(JSON.stringify(body));
}).listen(port, "127.0.0.1");
`;
}

async function getJson(url) {
  const response = await fetch(url);
  assert.strictEqual(response.status, 200, `expected health response from ${url}`);
  return response.json();
}

function startupHelperProbeSource() {
  return String.raw`
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PayloadPath,
  [Parameter(Mandatory = $true)][string]$HelperPath
)
$ErrorActionPreference = "Stop"
$payload = Get-Content -Raw -LiteralPath $PayloadPath | ConvertFrom-Json
. $HelperPath
if ($null -eq $payload.calls) { throw "Startup helper batch calls are missing." }
$results = @(
  foreach ($call in @($payload.calls)) {
    $parameters = @{}
    $call.parameters.psobject.Properties | ForEach-Object { $parameters[$_.Name] = $_.Value }
    try {
      $value = & ([string]$call.functionName) @parameters
      [pscustomobject]@{ accepted = $true; value = $value; error = "" }
    } catch {
      [pscustomobject]@{ accepted = $false; value = $null; error = $_.Exception.Message }
    }
  }
)
$results | ConvertTo-Json -Compress -Depth 10
`;
}
