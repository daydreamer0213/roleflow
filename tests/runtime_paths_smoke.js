const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  explicitDataRootForChild,
  resolveInstalledDataRoot,
  resolveRuntimePaths
} = require("../src/core/runtime_paths");

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-runtime-paths-"));

try {
  const appRoot = path.join(fixtureRoot, "Programs", "RoleFlow");
  const localAppData = path.join(fixtureRoot, "用户 空间", "AppData", "Local");
  const dataRoot = path.join(localAppData, "RoleFlow", "Data");
  fs.mkdirSync(appRoot, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });

  assert.deepStrictEqual(resolveRuntimePaths({ appRoot, dataRoot }), {
    appRoot: path.resolve(appRoot),
    dataRoot: path.resolve(dataRoot),
    dbPath: path.resolve(dataRoot, "data", "jobs.sqlite"),
    reportRoot: path.resolve(dataRoot, "reports")
  });

  assert.deepStrictEqual(resolveRuntimePaths({ appRoot }), {
    appRoot: path.resolve(appRoot),
    dataRoot: path.resolve(appRoot),
    dbPath: path.resolve(appRoot, "data", "jobs.sqlite"),
    reportRoot: path.resolve(appRoot, "reports")
  }, "developer commands without --data-root must keep repository-root storage");
  assert.strictEqual(explicitDataRootForChild({ appRoot, dataRoot: appRoot }), null);
  assert.strictEqual(explicitDataRootForChild({ appRoot, dataRoot }), path.resolve(dataRoot));

  assert.strictEqual(
    resolveInstalledDataRoot({ localAppData }),
    path.resolve(localAppData, "RoleFlow", "Data")
  );
  assertCodedFailure(
    () => resolveInstalledDataRoot({ localAppData: "" }),
    "ROLEFLOW_LOCALAPPDATA_REQUIRED"
  );

  assertCodedFailure(
    () => resolveRuntimePaths({ appRoot: "relative-app", dataRoot }),
    "ROLEFLOW_APP_ROOT_ABSOLUTE_REQUIRED"
  );
  assertCodedFailure(
    () => resolveRuntimePaths({ appRoot, dataRoot: "relative-data" }),
    "ROLEFLOW_DATA_ROOT_ABSOLUTE_REQUIRED"
  );
  assertCodedFailure(
    () => resolveRuntimePaths({ appRoot, dataRoot: "\\\\server\\share\\RoleFlow\\Data" }),
    "ROLEFLOW_RUNTIME_UNC_PATH_REJECTED"
  );
  assertCodedFailure(
    () => resolveRuntimePaths({ appRoot, dataRoot: appRoot }),
    "ROLEFLOW_APP_DATA_ROOT_OVERLAP"
  );
  assertCodedFailure(
    () => resolveRuntimePaths({ appRoot, dataRoot: path.join(appRoot, "Data") }),
    "ROLEFLOW_APP_DATA_ROOT_OVERLAP"
  );
  assertCodedFailure(
    () => resolveRuntimePaths({ appRoot, dataRoot: path.dirname(appRoot) }),
    "ROLEFLOW_APP_DATA_ROOT_OVERLAP"
  );

  const external = path.join(fixtureRoot, "external-data");
  const linkedParent = path.join(fixtureRoot, "linked-local-app-data");
  fs.mkdirSync(external, { recursive: true });
  fs.symlinkSync(external, linkedParent, "junction");
  assertCodedFailure(
    () => resolveRuntimePaths({ appRoot, dataRoot: path.join(linkedParent, "RoleFlow", "Data") }),
    "ROLEFLOW_RUNTIME_REPARSE_POINT_BLOCKED"
  );

  assertUserDataMigration();
  assertCliUsesStableDataRoot();

  console.log("runtime_paths_smoke ok");
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

function assertCodedFailure(run, code) {
  assert.throws(run, (error) => error?.code === code, code);
}

function assertUserDataMigration() {
  const scriptPath = path.join(__dirname, "..", "scripts", "prepare-user-data.ps1");
  assert(fs.existsSync(scriptPath), "missing scripts/prepare-user-data.ps1");

  const migrated = createLegacyFixture("migrated");
  const sourceBefore = snapshotTree(migrated.installRoot);
  const migratedResult = runPrepareUserData(scriptPath, migrated.installRoot, migrated.dataRoot);
  assert.strictEqual(migratedResult.status, 0, combined(migratedResult));
  assert.strictEqual(readStatus(migratedResult).status, "migrated");
  assert.deepStrictEqual(snapshotTree(migrated.installRoot), sourceBefore, "migration must preserve legacy recovery evidence");
  for (const relativePath of migrated.approvedFiles) {
    assert(fs.existsSync(path.join(migrated.dataRoot, relativePath)), `missing migrated file: ${relativePath}`);
  }
  for (const relativePath of migrated.forbiddenFiles) {
    assert(!fs.existsSync(path.join(migrated.dataRoot, relativePath)), `forbidden legacy path copied: ${relativePath}`);
  }
  assertDataRootShape(migrated.dataRoot);
  assertNoStaging(migrated.dataRoot);

  const existing = createLegacyFixture("existing");
  const existingSentinel = path.join(existing.dataRoot, "keep.txt");
  fs.mkdirSync(existing.dataRoot, { recursive: true });
  fs.writeFileSync(existingSentinel, "existing-target", "utf8");
  const existingResult = runPrepareUserData(scriptPath, existing.installRoot, existing.dataRoot);
  assert.strictEqual(existingResult.status, 0, combined(existingResult));
  assert.strictEqual(readStatus(existingResult).status, "existing");
  assert.strictEqual(fs.readFileSync(existingSentinel, "utf8"), "existing-target");
  assert(!fs.existsSync(path.join(existing.dataRoot, "data", "jobs.sqlite")), "existing targets must never be merged");
  assertNoStaging(existing.dataRoot);

  const created = createEmptyFixture("created");
  const createdResult = runPrepareUserData(scriptPath, created.installRoot, created.dataRoot);
  assert.strictEqual(createdResult.status, 0, combined(createdResult));
  assert.strictEqual(readStatus(createdResult).status, "created");
  assertDataRootShape(created.dataRoot);
  assertNoStaging(created.dataRoot);

  const linked = createLegacyFixture("linked");
  const external = path.join(linked.fixtureRoot, "external");
  const externalSentinel = path.join(external, "outside.txt");
  fs.mkdirSync(external, { recursive: true });
  fs.writeFileSync(externalSentinel, "outside", "utf8");
  fs.symlinkSync(external, path.join(linked.installRoot, "data", "linked"), "junction");
  const linkedResult = runPrepareUserData(scriptPath, linked.installRoot, linked.dataRoot);
  assert.notStrictEqual(linkedResult.status, 0, "source reparse points must stop migration");
  assert.match(combined(linkedResult), /ROLEFLOW_REPARSE_POINT_BLOCKED/);
  assert(!fs.existsSync(linked.dataRoot));
  assert(fs.existsSync(externalSentinel));
  assertNoStaging(linked.dataRoot);

  const failed = createLegacyFixture("copy-failure");
  const wrapperPath = path.join(failed.fixtureRoot, "fail-copy.ps1");
  fs.writeFileSync(wrapperPath, String.raw`param([string]$ScriptPath,[string]$InstallRoot,[string]$DataRoot)
$script:CopyCount = 0
function Copy-Item {
  [CmdletBinding()]
  param([string]$LiteralPath,[string]$Destination,[switch]$Recurse,[switch]$Force)
  $script:CopyCount += 1
  if ($script:CopyCount -eq 2) { throw "SIMULATED_COPY_FAILURE" }
  Microsoft.PowerShell.Management\Copy-Item @PSBoundParameters
}
& $ScriptPath -InstallRoot $InstallRoot -DataRoot $DataRoot
`, "utf8");
  const failedResult = runPowerShell([
    "-File", wrapperPath,
    "-ScriptPath", scriptPath,
    "-InstallRoot", failed.installRoot,
    "-DataRoot", failed.dataRoot
  ]);
  assert.notStrictEqual(failedResult.status, 0, "copy failure fixture must fail");
  assert.match(combined(failedResult), /SIMULATED_COPY_FAILURE/);
  assert(!fs.existsSync(failed.dataRoot), "copy failure must not publish a partial target");
  assert(fs.existsSync(path.join(failed.installRoot, "data", "jobs.sqlite")));
  assert(fs.existsSync(failed.siblingSentinel));
  assertNoStaging(failed.dataRoot);

  const sourceSwap = createLegacyFixture("source-swap");
  const externalSource = path.join(sourceSwap.fixtureRoot, "external-source");
  const externalSwapSentinel = path.join(externalSource, "outside.txt");
  fs.mkdirSync(externalSource, { recursive: true });
  fs.writeFileSync(externalSwapSentinel, "outside", "utf8");
  const sourceSwapWrapper = path.join(sourceSwap.fixtureRoot, "swap-source.ps1");
  fs.writeFileSync(sourceSwapWrapper, String.raw`param([string]$ScriptPath,[string]$InstallRoot,[string]$DataRoot,[string]$ExternalSource)
$script:CopyCount = 0
function Copy-Item {
  [CmdletBinding()]
  param([string]$LiteralPath,[string]$Destination,[switch]$Recurse,[switch]$Force)
  $script:CopyCount += 1
  if ($script:CopyCount -eq 1) {
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Recurse -Force
    Microsoft.PowerShell.Management\New-Item -ItemType Junction -Path $LiteralPath -Target $ExternalSource | Out-Null
  }
  Microsoft.PowerShell.Management\Copy-Item @PSBoundParameters
}
& $ScriptPath -InstallRoot $InstallRoot -DataRoot $DataRoot
`, "utf8");
  const sourceSwapResult = runPowerShell([
    "-File", sourceSwapWrapper,
    "-ScriptPath", scriptPath,
    "-InstallRoot", sourceSwap.installRoot,
    "-DataRoot", sourceSwap.dataRoot,
    "-ExternalSource", externalSource
  ]);
  assert.notStrictEqual(sourceSwapResult.status, 0, "a source replaced after inventory must stop migration");
  assert.match(combined(sourceSwapResult), /ROLEFLOW_REPARSE_POINT_BLOCKED/);
  assert(!fs.existsSync(sourceSwap.dataRoot), "source replacement must not publish external content");
  assert(fs.existsSync(externalSwapSentinel), "source replacement must preserve the external target");
  assertNoStaging(sourceSwap.dataRoot);

  const destinationSwap = createLegacyFixture("destination-swap");
  const externalDestination = path.join(destinationSwap.fixtureRoot, "external-destination");
  fs.mkdirSync(externalDestination, { recursive: true });
  fs.writeFileSync(path.join(externalDestination, "keep.txt"), "keep", "utf8");
  const externalDestinationBefore = snapshotTree(externalDestination);
  const destinationSwapWrapper = path.join(destinationSwap.fixtureRoot, "swap-destination.ps1");
  fs.writeFileSync(destinationSwapWrapper, String.raw`param([string]$ScriptPath,[string]$InstallRoot,[string]$DataRoot,[string]$ExternalDestination)
$script:Injected = $false
function New-Item {
  [CmdletBinding()]
  param([string]$ItemType,[switch]$Force,[string]$Path,[string]$Target)
  $result = Microsoft.PowerShell.Management\New-Item @PSBoundParameters
  if (-not $script:Injected -and $ItemType -eq "Directory" -and $Path -match '\.staging-[0-9a-f]+$') {
    $script:Injected = $true
    Microsoft.PowerShell.Management\New-Item -ItemType Junction -Path (Join-Path $Path "data") -Target $ExternalDestination | Out-Null
  }
  return $result
}
& $ScriptPath -InstallRoot $InstallRoot -DataRoot $DataRoot
`, "utf8");
  const destinationSwapResult = runPowerShell([
    "-File", destinationSwapWrapper,
    "-ScriptPath", scriptPath,
    "-InstallRoot", destinationSwap.installRoot,
    "-DataRoot", destinationSwap.dataRoot,
    "-ExternalDestination", externalDestination
  ]);
  assert.notStrictEqual(destinationSwapResult.status, 0, "a destination junction must stop before recursive copy");
  assert.match(combined(destinationSwapResult), /ROLEFLOW_REPARSE_POINT_BLOCKED/);
  assert.deepStrictEqual(snapshotTree(externalDestination), externalDestinationBefore, "migration must not write through a staging junction");
  assert(!fs.existsSync(destinationSwap.dataRoot));
  assertNoStaging(destinationSwap.dataRoot);
}

function createLegacyFixture(name) {
  const fixture = createEmptyFixture(name);
  const approvedFiles = [
    "data/jobs.sqlite",
    ".runtime/settings/model.json",
    ".runtime/resumes/1.pdf",
    ".runtime/logs/app.jsonl",
    "reports/result.html",
    "profiles/candidate.json"
  ];
  const forbiddenFiles = [
    ".runtime/node/node.exe",
    "src/private.js",
    "tests/private.js",
    "installer/private.iss",
    ".env"
  ];
  for (const relativePath of [...approvedFiles, ...forbiddenFiles]) {
    const filePath = path.join(fixture.installRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `fixture:${relativePath}`, "utf8");
  }
  return { ...fixture, approvedFiles, forbiddenFiles };
}

function createEmptyFixture(name) {
  const scopedRoot = path.join(fixtureRoot, name);
  const installRoot = path.join(scopedRoot, "Programs", "RoleFlow");
  const localAppData = path.join(scopedRoot, "Local App Data");
  const dataRoot = path.join(localAppData, "RoleFlow", "Data");
  const siblingSentinel = path.join(scopedRoot, "keep.txt");
  fs.mkdirSync(installRoot, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.writeFileSync(siblingSentinel, "keep", "utf8");
  return { fixtureRoot: scopedRoot, installRoot, localAppData, dataRoot, siblingSentinel };
}

function runPrepareUserData(scriptPath, installRoot, dataRoot) {
  return runPowerShell(["-File", scriptPath, "-InstallRoot", installRoot, "-DataRoot", dataRoot]);
}

function runPowerShell(args) {
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  return spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true
  });
}

function readStatus(result) {
  const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

function assertDataRootShape(dataRoot) {
  for (const relativePath of ["data", ".runtime/settings", ".runtime/resumes", ".runtime/logs", "reports", "profiles"]) {
    assert(fs.statSync(path.join(dataRoot, relativePath)).isDirectory(), `missing data directory: ${relativePath}`);
  }
}

function assertNoStaging(dataRoot) {
  const parent = path.dirname(dataRoot);
  if (!fs.existsSync(parent)) return;
  const prefix = `${path.basename(dataRoot)}.staging-`.toLowerCase();
  assert.deepStrictEqual(
    fs.readdirSync(parent).filter((name) => name.toLowerCase().startsWith(prefix)),
    [],
    "migration staging directory must be cleaned"
  );
}

function snapshotTree(directory) {
  if (!fs.existsSync(directory)) return [];
  const rows = [];
  const visit = (current, relative = "") => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const nextRelative = path.join(relative, entry.name);
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) rows.push([nextRelative, "link"]);
      else if (entry.isDirectory()) {
        rows.push([nextRelative, "directory"]);
        visit(fullPath, nextRelative);
      } else rows.push([nextRelative, fs.readFileSync(fullPath).toString("base64")]);
    }
  };
  visit(directory);
  return rows;
}

function combined(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function assertCliUsesStableDataRoot() {
  const cliDataRoot = path.join(fixtureRoot, "cli 用户数据");
  const repositoryDb = path.join(__dirname, "..", "data", "jobs.sqlite");
  const repositoryDbBefore = fileFingerprint(repositoryDb);
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "..", "src", "cli.js"),
    "init-db",
    "--data-root", cliDataRoot
  ], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true
  });
  assert.strictEqual(result.status, 0, combined(result));
  assert(fs.existsSync(path.join(cliDataRoot, "data", "jobs.sqlite")), "CLI must create the database under --data-root");
  assert(fs.existsSync(path.join(cliDataRoot, ".runtime", "logs")), "CLI logs must use --data-root");
  assert.deepStrictEqual(fileFingerprint(repositoryDb), repositoryDbBefore, "installed data-root commands must not touch the repository database");
}

function fileFingerprint(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}
