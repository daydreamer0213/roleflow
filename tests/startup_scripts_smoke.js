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
  testStartupIdentityHelpers();

  await assertPortFree(dashboardPort);
  if (cleanupProbe === "processes") {
    await runIntentionalCleanupProcessProbe();
    return;
  }
  testRunScriptFromOutsideCwd();
  await testWorkspaceStartupFromSpacePath();
  testPortableModeRejectsInvalidCdpPort();
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
    path.join(root, "scripts", "start-portable-edge.ps1"),
    path.join(projectRoot, "scripts", "start-portable-edge.ps1")
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
  const result = runPowerShell([
    "-File", path.join(projectRoot, "scripts", "start-workspace.ps1"),
    "-Port", String(dashboardPort),
    "-NoBrowser"
  ], {
    cwd: outsideCwd,
    env: fixtureEnv({ ROLEFLOW_STARTUP_RECORD: recordPath }),
    timeout: 30000
  });
  assert.strictEqual(result.status, 0, combinedOutput(result));
  const records = readJsonLines(recordPath);
  const dashboard = records.find((item) => item.command === "dashboard");
  const workspaceTabs = records.find((item) => item.command === "workspace-tabs");
  assert(dashboard, "dashboard command did not reach the fixture project CLI");
  registerProcess(dashboard.pid, {
    kind: "dashboard",
    expectedCommandFragment: path.join(projectRoot, "src", "cli.js")
  });
  assert(workspaceTabs, "workspace-tabs command did not reach the fixture project CLI");
  assert.strictEqual(normalizePath(dashboard.cwd), normalizePath(projectRoot));
  assert.strictEqual(normalizePath(dashboard.projectRoot), normalizePath(projectRoot));
  assert.strictEqual(normalizePath(workspaceTabs.projectRoot), normalizePath(projectRoot));
  assert.deepStrictEqual(
    workspaceTabs.args.slice(
      workspaceTabs.args.indexOf("--browser"),
      workspaceTabs.args.indexOf("--browser") + 2
    ),
    ["--browser", "edge"]
  );
  assert(!workspaceTabs.args.includes("--cdp-port"));
  await stopRegisteredProcess(dashboard.pid);
  await waitForPortClosed(dashboardPort);

  const portableRecordPath = path.join(tempRoot, "workspace-portable.jsonl");
  const portable = runPowerShell([
    "-File", path.join(projectRoot, "scripts", "start-workspace.ps1"),
    "-Port", String(dashboardPort),
    "-BrowserMode", "portable",
    "-NoBrowser"
  ], {
    cwd: outsideCwd,
    env: fixtureEnv({ ROLEFLOW_STARTUP_RECORD: portableRecordPath }),
    timeout: 30000
  });
  assert.strictEqual(portable.status, 0, combinedOutput(portable));
  const portableRecords = readJsonLines(portableRecordPath);
  const portableDashboard = portableRecords.find((item) => item.command === "dashboard");
  const portableTabs = portableRecords.find((item) => item.command === "workspace-tabs");
  assert(portableDashboard);
  registerProcess(portableDashboard.pid, {
    kind: "dashboard",
    expectedCommandFragment: path.join(projectRoot, "src", "cli.js")
  });
  assert(portableTabs);
  assert(portableTabs.args.includes("--browser"));
  assert(portableTabs.args.includes("portable"));
  assert(portableTabs.args.includes("--cdp-port"));
  assert(portableTabs.args.includes("9222"));
  await stopRegisteredProcess(portableDashboard.pid);
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
  for (const mode of ["other-project", "missing-identity", "pid-mismatch"]) {
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
    assert.match(combinedOutput(result), /identity|current project|listener PID/i);
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
  const profileA = invokeStartupHelper("Resolve-RoleFlowBrowserProfilePath", {
    ProjectRoot: path.join(tempRoot, "project-a"),
    ProfileDir: "",
    LocalAppDataPath: localAppDataPath
  });
  const profileB = invokeStartupHelper("Resolve-RoleFlowBrowserProfilePath", {
    ProjectRoot: path.join(tempRoot, "project-b"),
    ProfileDir: "",
    LocalAppDataPath: localAppDataPath
  });
  assert.strictEqual(normalizePath(profileA), normalizePath(profileB));
  assert.strictEqual(
    normalizePath(profileA),
    normalizePath(path.join(localAppDataPath, "RoleFlow", "BrowserProfile"))
  );
  const relativeProfile = invokeStartupHelper("Resolve-RoleFlowBrowserProfilePath", {
    ProjectRoot: path.join(tempRoot, "project-a"),
    ProfileDir: "profiles\\dedicated",
    LocalAppDataPath: localAppDataPath
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
      LocalAppDataPath: localAppDataPath
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
    { ...acceptedSnapshot, CommandLine: `${acceptedSnapshot.CommandLine} --remote-debugging-address=0.0.0.0` },
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
}

function assertPureSnapshotAccepted(snapshot) {
  assert.strictEqual(invokeStartupHelper("Assert-RoleFlowPortableEdgeProcessSnapshot", snapshot), true);
}

function assertPureSnapshotRejected(snapshot, pattern) {
  assert.throws(
    () => invokeStartupHelper("Assert-RoleFlowPortableEdgeProcessSnapshot", snapshot),
    pattern
  );
}

function assertListenerSnapshotAccepted(listenerSnapshot, processQuerySnapshot) {
  assert.strictEqual(invokeStartupHelper("Assert-RoleFlowPortableEdgeListenerSnapshot", {
    ListenerSnapshot: listenerSnapshot,
    ProcessQuerySnapshot: processQuerySnapshot,
    EdgePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    Port: 9222,
    ProfilePath: "C:\\RoleFlow Profile"
  }), 4242);
}

function assertListenerSnapshotRejected(listenerSnapshot, processQuerySnapshot) {
  assert.throws(() => invokeStartupHelper("Assert-RoleFlowPortableEdgeListenerSnapshot", {
    ListenerSnapshot: listenerSnapshot,
    ProcessQuerySnapshot: processQuerySnapshot,
    EdgePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    Port: 9222,
    ProfilePath: "C:\\RoleFlow Profile"
  }));
}

function assertProfileInUseRejected(profilePath, processQuerySnapshot) {
  assert.throws(() => invokeStartupHelper("Assert-RoleFlowBrowserProfileNotInUse", {
    ProfilePath: profilePath,
    ProcessQuerySnapshot: processQuerySnapshot
  }));
}

function assertProfileQueryRejected(processQuerySnapshot) {
  assertProfileInUseRejected("C:\\RoleFlow Profile", processQuerySnapshot);
}

function assertProfileInUseAccepted(profilePath, processQuerySnapshot) {
  assert.strictEqual(invokeStartupHelper("Assert-RoleFlowBrowserProfileNotInUse", {
    ProfilePath: profilePath,
    ProcessQuerySnapshot: processQuerySnapshot
  }), true);
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

function invokeStartupHelper(functionName, parameters) {
  const payloadPath = path.join(tempRoot, `startup-helper-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify({ functionName, parameters }), "utf8");
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
    result.stdout || "",
    result.stderr || ""
  ].filter(Boolean).join("\n");
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
    "  [pscustomobject]@{ executablePath = [string]$item.ExecutablePath; commandLine = [string]$item.CommandLine } | ConvertTo-Json -Compress",
    "}"
  ].join("\n");
  const result = spawnSync(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script
  ], {
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
if (command !== "dashboard") process.exit(0);
const portIndex = args.indexOf("--port");
const port = Number(args[portIndex + 1]);
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true, projectRoot, pid: process.pid }));
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
  const body = mode === "missing-identity"
    ? { ok: true }
    : mode === "pid-mismatch"
      ? { ok: true, projectRoot, pid: process.pid + 1000 }
      : { ok: true, projectRoot: "D:\\Other\\RoleFlow", pid: process.pid };
  res.end(JSON.stringify(body));
}).listen(port, "127.0.0.1");
`;
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
$parameters = @{}
$payload.parameters.psobject.Properties | ForEach-Object { $parameters[$_.Name] = $_.Value }
$result = & ([string]$payload.functionName) @parameters
$result | ConvertTo-Json -Compress -Depth 10
`;
}
