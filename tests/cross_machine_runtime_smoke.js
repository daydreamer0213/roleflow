const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
);
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-跨机器 空格-"));

try {
  const installRoot = path.join(fixtureRoot, "普通用户", "Programs", "RoleFlow App");
  const dataRoot = path.join(fixtureRoot, "普通用户", "Local Data", "RoleFlow", "Data");
  createInstalledFixture(installRoot);

  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", path.join(root, "scripts", "installed-self-check.ps1"),
    "-ProjectRoot", installRoot,
    "-DataRoot", dataRoot,
    "-NodePath", process.execPath,
    "-SkipEdgeCheck"
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, LOCALAPPDATA: path.join(fixtureRoot, "普通用户", "Local Data") }
  });
  const selfCheckLog = path.join(dataRoot, ".runtime", "logs", "install-self-check.log");
  const logOutput = fs.existsSync(selfCheckLog) ? fs.readFileSync(selfCheckLog, "utf8") : "missing self-check log";
  assert.strictEqual(result.status, 0, `${combined(result)}\n${logOutput}`);
  assert.match(combined(result), /SELF_CHECK_OK/);
  assert(!fs.existsSync(path.join(installRoot, ".runtime")), "installed self-check must not write into program files");
  assert(fs.existsSync(selfCheckLog));
  const selfCheckRoot = path.join(dataRoot, ".runtime", "self-check");
  assert(
    !fs.existsSync(selfCheckRoot) || fs.readdirSync(selfCheckRoot).length === 0,
    "temporary self-check files must be cleaned"
  );

  const selfCheck = fs.readFileSync(path.join(root, "scripts", "installed-self-check.ps1"), "utf8");
  assert.doesNotMatch(selfCheck, /start-portable-edge|--browser-profile|--cdp-port/i);
  assert.doesNotMatch(selfCheck, /Invoke-WebRequest|Start-BitsTransfer|bitsadmin|curl\.exe/i);
  assert.match(selfCheck, /--no-browser/);
  assert.match(selfCheck, /--force-mock/);
  assert.match(selfCheck, /Get-Random -Minimum 49152 -Maximum 65535/);
  assert.match(selfCheck, /Microsoft Edge is not installed/);
  assert.match(selfCheck, /LOCALAPPDATA[^\r\n]*Microsoft\\Edge\\Application\\msedge\.exe/i);

  const portableEdge = fs.readFileSync(path.join(root, "scripts", "start-portable-edge.ps1"), "utf8");
  assert.match(portableEdge, /LOCALAPPDATA[^\r\n]*Microsoft\\Edge\\Application\\msedge\.exe/i);

  const installer = fs.readFileSync(path.join(root, "installer", "RoleFlow.iss"), "utf8");
  assert.match(installer, /Flags:\s*checkedonce/i);
  assert.match(installer, /Name:\s*"\{autodesktop\}\\RoleFlow"/i);
  assert.match(installer, /WorkingDir:\s*"\{app\}"/i);
  assert.match(installer, /Flags:\s*nowait\s+postinstall/i);

  const builder = fs.readFileSync(path.join(root, "scripts", "build-installer.ps1"), "utf8");
  assert.doesNotMatch(builder, /"(?:data|profiles)\\(?:sample|example|README)/i);
  assert.match(builder, /\^\(tests\|data\|profiles\|vendor/);

  const launcher = fs.readFileSync(path.join(root, "scripts", "launch-installed.ps1"), "utf8");
  assert.match(launcher, /MessageBoxButtons\]::YesNo/);
  assert.match(launcher, /explorer\.exe/);
  assert.match(launcher, /已有用户数据不会被删除或覆盖/);
  assert.doesNotMatch(launcher, /请关闭占用[^\r\n]*9222/);

  console.log("cross_machine_runtime_smoke ok");
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

function createInstalledFixture(installRoot) {
  for (const relativePath of ["src", "scripts", "node_modules/pdfjs-dist/legacy/build"]) {
    fs.mkdirSync(path.join(installRoot, relativePath), { recursive: true });
  }
  for (const [relativePath, contents] of Object.entries({
    "package.json": "{}\n",
    "LICENSE": "fixture\n",
    "NOTICE": "fixture\n",
    "scripts/start-workspace.ps1": "# fixture\n",
    "node_modules/pdfjs-dist/legacy/build/pdf.mjs": "export {};\n"
  })) {
    fs.writeFileSync(path.join(installRoot, relativePath), contents, "utf8");
  }
  fs.writeFileSync(path.join(installRoot, "src", "cli.js"), String.raw`
const http = require("node:http");
const path = require("node:path");
function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : "";
}
for (const flag of ["--no-browser", "--force-mock"]) {
  if (!process.argv.includes(flag)) { console.error("missing", flag, process.argv); process.exit(41); }
}
for (const forbidden of ["--cdp-port", "--browser-profile"]) {
  if (process.argv.includes(forbidden)) { console.error("forbidden", forbidden, process.argv); process.exit(42); }
}
if (valueAfter("--browser") !== "edge") { console.error("browser", process.argv); process.exit(43); }
const receivedDataRoot = valueAfter("--data-root");
if (!path.isAbsolute(receivedDataRoot) || path.basename(receivedDataRoot).toLowerCase() !== "data") { console.error("data-root", process.argv); process.exit(44); }
const port = Number(valueAfter("--port"));
const server = http.createServer((request, response) => {
  response.writeHead(request.url === "/health" ? 200 : 404, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({
    ok: true,
    applicationStatus: "ready",
    pid: process.pid,
    projectRoot: path.resolve(__dirname, "..")
  }));
});
server.listen(port, "127.0.0.1");
`, "utf8");
}

function combined(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}
