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

const requiredFiles = [
  "BuildInstaller.bat",
  "installer/RoleFlow.iss",
  "scripts/build-installer.ps1",
  "scripts/installed-self-check.ps1",
  "scripts/launch-installed.ps1",
  "scripts/prepare-uninstall.ps1"
];
for (const relativePath of requiredFiles) {
  assert(fs.existsSync(path.join(root, relativePath)), `missing installer file: ${relativePath}`);
}

const inno = read("installer/RoleFlow.iss");
assert.match(inno, /PrivilegesRequired=lowest/);
assert.match(inno, /DefaultDirName=\{localappdata\}\\Programs\\RoleFlow/);
assert.match(inno, /AppId=\{\{[0-9A-F-]+\}/i);
assert.match(inno, /\[Icons\]/);
assert.match(inno, /\{autodesktop\}/);
assert.match(inno, /\{uninstallexe\}/);
assert.match(inno, /launch-installed\.ps1/);
assert.match(inno, /prepare-uninstall\.ps1/);
assert.match(inno, /installed-self-check\.ps1/);
assert.doesNotMatch(inno, /vendor\\edge-control-bridge/i);

const build = read("scripts/build-installer.ps1");
assert.match(build, /D:\\DevData\\RoleFlow-installer/);
assert.match(build, /tests\\run_all\.js/);
assert.match(build, /installer\\RoleFlow\.iss/);
assert.match(build, /Get-FileHash/);
assert.match(build, /runtime\\node/);
assert.match(build, /\[switch\]\$StageOnly/);
assert.doesNotMatch(build, /vendor\\edge-control-bridge/i);

const install = read("scripts/install.ps1");
assert.doesNotMatch(
  install,
  /tests\\run_all\.js/,
  "developer/portable installation must not run the complete offline suite"
);
const edgeControl = read("scripts/start-edge-control.ps1");
assert(
  edgeControl.indexOf("$ExistingConfig = Read-EdgeControlConfig")
    < edgeControl.indexOf("$Resolved = Resolve-EdgeControlRoot"),
  "an installed app must reuse a healthy existing bridge before requiring plugin source files"
);

assertUninstallPreservesUserDataByDefault();
assertUninstallDeletesOnlyApprovedChildren();
assertInstalledSelfCheckStartsOnAnIsolatedPort();
assertStandardInstallerStageExcludesLegacyEntrypoints();

console.log("windows_installer_smoke ok");

function assertUninstallPreservesUserDataByDefault() {
  const fixture = createUninstallFixture();
  try {
    const result = runPowerShell([
      "-File", path.join(root, "scripts", "prepare-uninstall.ps1"),
      "-InstallRoot", fixture.installRoot,
      "-SkipDashboardStop"
    ]);
    assert.strictEqual(result.status, 0, combined(result));
    assert(fs.existsSync(fixture.database), "default uninstall preparation must preserve local data");
    assert(fs.existsSync(fixture.outsideSentinel), "uninstall preparation must not touch sibling paths");
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function assertUninstallDeletesOnlyApprovedChildren() {
  const fixture = createUninstallFixture();
  try {
    const result = runPowerShell([
      "-File", path.join(root, "scripts", "prepare-uninstall.ps1"),
      "-InstallRoot", fixture.installRoot,
      "-SkipDashboardStop",
      "-DeleteUserData",
      "-ConfirmDelete"
    ]);
    assert.strictEqual(result.status, 0, combined(result));
    for (const relativePath of ["data", ".runtime", "reports", "logs", "profiles"]) {
      assert(
        !fs.existsSync(path.join(fixture.installRoot, relativePath)),
        `confirmed cleanup must remove ${relativePath}`
      );
    }
    assert(fs.existsSync(fixture.outsideSentinel), "confirmed cleanup must stay inside the install root");
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function assertInstalledSelfCheckStartsOnAnIsolatedPort() {
  const result = runPowerShell([
    "-File", path.join(root, "scripts", "installed-self-check.ps1"),
    "-ProjectRoot", root,
    "-NodePath", process.execPath,
    "-SkipEdgeCheck"
  ], 30_000);
  assert.strictEqual(result.status, 0, combined(result));
  assert.match(combined(result), /SELF_CHECK_OK/);
}

function assertStandardInstallerStageExcludesLegacyEntrypoints() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-installer-stage-"));
  try {
    const result = runPowerShell([
      "-File", path.join(root, "scripts", "build-installer.ps1"),
      "-BuildRoot", path.join(fixtureRoot, "build"),
      "-OutputDir", path.join(fixtureRoot, "dist"),
      "-PortableNodeRoot", path.dirname(process.execPath),
      "-SkipTests",
      "-StageOnly"
    ], 60_000);
    assert.strictEqual(result.status, 0, combined(result));
    const stageMatch = combined(result).match(/Installer stage:\s*(.+)\r?$/m);
    assert(stageMatch, `missing installer stage path:\n${combined(result)}`);
    const stageDir = stageMatch[1].trim();
    for (const relativePath of [
      "Install.bat",
      "Start.bat",
      "ScanPortable.bat",
      "StartPortableEdge.bat"
    ]) {
      assert(
        !fs.existsSync(path.join(stageDir, relativePath)),
        `standard installer must exclude ${relativePath}`
      );
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function createUninstallFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-uninstall-"));
  const installRoot = path.join(fixtureRoot, "RoleFlow");
  for (const relativePath of ["data", ".runtime/settings", "reports", "logs", "profiles"]) {
    fs.mkdirSync(path.join(installRoot, relativePath), { recursive: true });
  }
  const database = path.join(installRoot, "data", "jobs.sqlite");
  fs.writeFileSync(database, "fixture", "utf8");
  fs.writeFileSync(path.join(installRoot, ".runtime", "settings", "model.json"), "{}", "utf8");
  fs.writeFileSync(path.join(installRoot, "reports", "result.html"), "fixture", "utf8");
  fs.writeFileSync(path.join(installRoot, "logs", "roleflow.log"), "fixture", "utf8");
  fs.writeFileSync(path.join(installRoot, "profiles", "private.json"), "fixture", "utf8");
  const outsideSentinel = path.join(fixtureRoot, "keep.txt");
  fs.writeFileSync(outsideSentinel, "keep", "utf8");
  return { fixtureRoot, installRoot, database, outsideSentinel };
}

function runPowerShell(args, timeout = 15_000) {
  return spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    ...args
  ], {
    cwd: root,
    encoding: "utf8",
    timeout,
    windowsHide: true
  });
}

function combined(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}
