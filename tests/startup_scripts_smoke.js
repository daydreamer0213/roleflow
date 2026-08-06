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
const tempParent = "D:\\DevData";
const tempRoot = fs.mkdtempSync(path.join(tempParent, "RoleFlow startup smoke "));
const projectRoot = path.join(tempRoot, "project with spaces");
const outsideCwd = path.join(tempRoot, "outside cwd");
const children = new Set();
const processRegistry = new Map();

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
  const cleanupProbe = process.env.ROLEFLOW_STARTUP_CLEANUP_PROBE || "";
  if (cleanupProbe === "aggregate") {
    throw new Error("STARTUP_CLEANUP_PROBE_PRIMARY_FAILURE");
  }

  assert(fs.existsSync(powershell), "Windows PowerShell 5.1 is required for startup script tests");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(outsideCwd, { recursive: true });
  createProjectFixture();

  await assertPortFree(8787);
  await assertPortFree(9222);
  if (cleanupProbe === "processes") {
    await runIntentionalCleanupProcessProbe();
    return;
  }
  testRunScriptFromOutsideCwd();
  await testWorkspaceStartupFromSpacePath();
  await testForeignDashboardIdentityRejected();
  await testForeignCdpIdentityRejected();
  await testPortableEdgeProfileArgumentWithSpaces();
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
  fs.writeFileSync(path.join(tempRoot, "foreign-cdp.js"), foreignCdpSource(), "utf8");
}

function testRunScriptFromOutsideCwd() {
  const recordPath = path.join(tempRoot, "direct-run.jsonl");
  const result = runPowerShell([
    "-File", path.join(projectRoot, "run.ps1"),
    "workspace-tabs",
    "--dashboard-url", "http://127.0.0.1:8787/",
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
    "-Port", "8787",
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
  await stopRegisteredProcess(dashboard.pid);
  await waitForPortClosed(8787);
}

async function testForeignDashboardIdentityRejected() {
  for (const mode of ["other-project", "missing-identity", "pid-mismatch"]) {
    const child = startNodeServer(path.join(tempRoot, "foreign-health.js"), [
      "8787",
      mode,
      projectRoot
    ]);
    await waitForHttp("http://127.0.0.1:8787/health");
    const result = runPowerShell([
      "-File", path.join(projectRoot, "scripts", "start-workspace.ps1"),
      "-Port", "8787",
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
    await waitForPortClosed(8787);
  }
}

async function testForeignCdpIdentityRejected() {
  const foreign = startNodeServer(path.join(tempRoot, "foreign-cdp.js"), ["9222"]);
  await waitForHttp("http://127.0.0.1:9222/json/version");
  let result = runPowerShell([
    "-File", path.join(projectRoot, "scripts", "start-portable-edge.ps1"),
    "-Port", "9222",
    "-CheckOnly"
  ], {
    cwd: outsideCwd,
    env: fixtureEnv(),
    timeout: 10000
  });
  assert.notStrictEqual(result.status, 0, "a foreign CDP responder must be rejected");
  assert.match(combinedOutput(result), /msedge|identity|listener PID/i);
  await stopChild(foreign);
  await waitForPortClosed(9222);

  const edgeExe = compileEdgeStub();
  for (const invalidArgs of [
    [
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9222",
      `--user-data-dir=${path.join(tempRoot, "wrong profile")}`
    ],
    [
      "--remote-debugging-port=9222",
      `--user-data-dir=${path.join(projectRoot, ".runtime", "edge-profile")}`
    ]
  ]) {
    const recordPath = path.join(tempRoot, `invalid-edge-${Date.now()}.txt`);
    const edge = startEdgeStub(edgeExe, invalidArgs, recordPath);
    await waitForHttp("http://127.0.0.1:9222/json/version");
    result = runPowerShell([
      "-File", path.join(projectRoot, "scripts", "start-portable-edge.ps1"),
      "-Port", "9222",
      "-CheckOnly"
    ], {
      cwd: outsideCwd,
      env: fixtureEnv(),
      timeout: 10000
    });
    assert.notStrictEqual(result.status, 0, "an msedge listener with incomplete or foreign authority must be rejected");
    assert.match(combinedOutput(result), /profile|address|identity/i);
    await stopChild(edge);
    await waitForPortClosed(9222);
  }
}

async function testPortableEdgeProfileArgumentWithSpaces() {
  const edgeExe = path.join(tempRoot, "edge stub with spaces", "msedge.exe");
  assert(fs.existsSync(edgeExe), "compiled Edge stub is missing");
  const recordPath = path.join(tempRoot, "portable-edge-launch.txt");
  const result = runPowerShell([
    "-File", path.join(projectRoot, "scripts", "start-portable-edge.ps1"),
    "-EdgePath", edgeExe,
    "-Port", "9222",
    "-ProfileDir", ".runtime\\edge-profile",
    "-TimeoutSeconds", "8"
  ], {
    cwd: outsideCwd,
    env: fixtureEnv({ ROLEFLOW_EDGE_STUB_RECORD: recordPath }),
    timeout: 15000
  });
  assert.strictEqual(result.status, 0, combinedOutput(result));
  await waitForFile(recordPath);
  const lines = fs.readFileSync(recordPath, "utf8").split(/\r?\n/).filter(Boolean);
  const pid = Number(lines[0]);
  registerProcess(pid, {
    kind: "edge",
    expectedCommandFragment: edgeExe
  });
  const cwd = lines[1];
  const args = lines.slice(2);
  assert.strictEqual(normalizePath(cwd), normalizePath(projectRoot));
  assert(args.includes("--remote-debugging-address=127.0.0.1"));
  assert(args.includes("--remote-debugging-port=9222"));
  assert(args.includes(`--user-data-dir=${path.join(projectRoot, ".runtime", "edge-profile")}`));
  await stopRegisteredProcess(pid);
  await waitForPortClosed(9222);
}

async function runIntentionalCleanupProcessProbe() {
  const auditPath = process.env.ROLEFLOW_STARTUP_CLEANUP_AUDIT;
  assert(auditPath, "cleanup process probe requires an audit path");

  const dashboardRecord = path.join(tempRoot, "cleanup-probe-dashboard.jsonl");
  const dashboardResult = runPowerShell([
    "-File", path.join(projectRoot, "scripts", "start-workspace.ps1"),
    "-Port", "8787",
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

  const edgeExe = compileEdgeStub();
  const edgeRecord = path.join(tempRoot, "cleanup-probe-edge.txt");
  const edgeResult = runPowerShell([
    "-File", path.join(projectRoot, "scripts", "start-portable-edge.ps1"),
    "-EdgePath", edgeExe,
    "-Port", "9222",
    "-ProfileDir", ".runtime\\edge-profile",
    "-TimeoutSeconds", "8"
  ], {
    cwd: outsideCwd,
    env: fixtureEnv({ ROLEFLOW_EDGE_STUB_RECORD: edgeRecord }),
    timeout: 15000
  });
  assert.strictEqual(edgeResult.status, 0, combinedOutput(edgeResult));
  await waitForFile(edgeRecord);

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
  assert.deepStrictEqual(audited.map((item) => item.kind).sort(), ["dashboard", "edge"]);

  let verificationError = null;
  try {
    for (const entry of audited) {
      await waitForProcessExited(entry.pid, 1500);
    }
    await waitForPortClosed(8787, 1500);
    await waitForPortClosed(9222, 1500);
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
  await waitForPortClosed(8787, 5000).catch((error) => emergencyCleanupErrors.push(error));
  await waitForPortClosed(9222, 5000).catch((error) => emergencyCleanupErrors.push(error));

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

function compileEdgeStub() {
  const outputDir = path.join(tempRoot, "edge stub with spaces");
  const outputPath = path.join(outputDir, "msedge.exe");
  if (fs.existsSync(outputPath)) return outputPath;
  fs.mkdirSync(outputDir, { recursive: true });
  const compileScript = path.join(tempRoot, "compile-edge-stub.ps1");
  fs.writeFileSync(compileScript, edgeCompileSource(), "utf8");
  const result = runPowerShell([
    "-File", compileScript,
    "-OutputPath", outputPath
  ], { cwd: outsideCwd, timeout: 30000 });
  assert.strictEqual(result.status, 0, combinedOutput(result));
  assert(fs.existsSync(outputPath), "PowerShell did not compile the local Edge stub");
  return outputPath;
}

function startEdgeStub(edgeExe, args, recordPath) {
  const child = spawn(edgeExe, args, {
    cwd: outsideCwd,
    env: fixtureEnv({ ROLEFLOW_EDGE_STUB_RECORD: recordPath }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  children.add(child);
  registerProcess(child.pid, {
    kind: "edge",
    expectedCommandFragment: edgeExe,
    child
  });
  return child;
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

function fixtureEnv(extra = {}) {
  return {
    ...process.env,
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
  for (const port of [8787, 9222]) {
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
    if (filename.endsWith(".txt") && filename.includes("edge")) {
      const pid = Number(fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean)[0]);
      if (Number.isInteger(pid) && pid > 0) {
        registerProcess(pid, {
          kind: "edge",
          expectedCommandFragment: path.join(tempRoot, "edge stub with spaces", "msedge.exe")
        });
      }
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

async function waitForFile(filePath, timeoutMs = 5000) {
  await waitFor(() => fs.existsSync(filePath), timeoutMs, `file did not appear: ${filePath}`);
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

function foreignCdpSource() {
  return String.raw`
const http = require("node:http");
const port = Number(process.argv[2]);
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/json/version") {
    res.end(JSON.stringify({
      Browser: "Foreign/1",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/foreign"
    }));
    return;
  }
  res.statusCode = 404;
  res.end("{}");
}).listen(port, "127.0.0.1");
`;
}

function edgeCompileSource() {
  return String.raw`
param([Parameter(Mandatory=$true)][string]$OutputPath)
$source = @'
using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;

public static class Program {
  public static int Main(string[] args) {
    var record = Environment.GetEnvironmentVariable("ROLEFLOW_EDGE_STUB_RECORD");
    if (!String.IsNullOrEmpty(record)) {
      var lines = new[] {
        System.Diagnostics.Process.GetCurrentProcess().Id.ToString(),
        Environment.CurrentDirectory
      }.Concat(args).ToArray();
      File.WriteAllLines(record, lines, Encoding.UTF8);
    }
    var portArg = args.FirstOrDefault(value => value.StartsWith("--remote-debugging-port=", StringComparison.OrdinalIgnoreCase));
    int port;
    if (portArg == null || !Int32.TryParse(portArg.Substring(portArg.IndexOf('=') + 1), out port)) return 2;
    var listener = new TcpListener(IPAddress.Loopback, port);
    listener.Start();
    while (true) {
      using (var client = listener.AcceptTcpClient())
      using (var stream = client.GetStream()) {
        var buffer = new byte[8192];
        stream.Read(buffer, 0, buffer.Length);
        var body = "{\"Browser\":\"Edge/Stub\",\"webSocketDebuggerUrl\":\"ws://127.0.0.1:" + port + "/devtools/browser/stub\"}";
        var payload = Encoding.UTF8.GetBytes(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
          Encoding.UTF8.GetByteCount(body) + "\r\nConnection: close\r\n\r\n" + body
        );
        stream.Write(payload, 0, payload.Length);
      }
    }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $OutputPath -OutputType WindowsApplication
`;
}
