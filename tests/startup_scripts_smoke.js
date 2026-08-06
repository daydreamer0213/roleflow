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

main()
  .then(() => console.log("startup_scripts_smoke ok"))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const child of children) stopChild(child);
    await waitForPortClosed(8787, 5000).catch(() => {});
    await waitForPortClosed(9222, 5000).catch(() => {});
    const expectedPrefix = path.join(tempParent, "RoleFlow startup smoke ");
    assert(
      path.resolve(tempRoot).startsWith(path.resolve(expectedPrefix)),
      `refusing to remove unexpected startup smoke directory: ${tempRoot}`
    );
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

async function main() {
  assert(fs.existsSync(powershell), "Windows PowerShell 5.1 is required for startup script tests");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(outsideCwd, { recursive: true });
  createProjectFixture();

  await assertPortFree(8787);
  await assertPortFree(9222);
  testRunScriptFromOutsideCwd();
  await testWorkspaceStartupFromSpacePath();
  await testForeignDashboardIdentityRejected();
  await testForeignCdpIdentityRejected();
  await testPortableEdgeProfileArgumentWithSpaces();
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
  assert(workspaceTabs, "workspace-tabs command did not reach the fixture project CLI");
  assert.strictEqual(normalizePath(dashboard.cwd), normalizePath(projectRoot));
  assert.strictEqual(normalizePath(dashboard.projectRoot), normalizePath(projectRoot));
  assert.strictEqual(normalizePath(workspaceTabs.projectRoot), normalizePath(projectRoot));
  stopPid(dashboard.pid);
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
    stopChild(child);
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
  stopChild(foreign);
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
    stopChild(edge);
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
  const cwd = lines[1];
  const args = lines.slice(2);
  assert.strictEqual(normalizePath(cwd), normalizePath(projectRoot));
  assert(args.includes("--remote-debugging-address=127.0.0.1"));
  assert(args.includes("--remote-debugging-port=9222"));
  assert(args.includes(`--user-data-dir=${path.join(projectRoot, ".runtime", "edge-profile")}`));
  stopPid(pid);
  await waitForPortClosed(9222);
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

function stopChild(child) {
  if (!child || child.exitCode !== null) {
    if (child) children.delete(child);
    return;
  }
  try {
    child.kill();
  } catch {}
  children.delete(child);
}

function stopPid(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return;
  try {
    process.kill(Number(pid));
  } catch {}
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
Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $OutputPath -OutputType ConsoleApplication
`;
}
