const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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
const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-windows-installer-suite-"));
const suiteLocalAppData = path.join(suiteRoot, "local-app-data");
const selfCheckProjectRoot = path.join(suiteRoot, "installed-self-check-project");
const reservedProbePorts = new Set([8787, 9222]);
fs.mkdirSync(suiteLocalAppData, { recursive: true });
createSelfCheckProjectFixture();

try {
  runSuite();
} finally {
  removeUniqueChild(suiteRoot, os.tmpdir());
}

function runSuite() {
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
  assert.doesNotMatch(inno, /migrate-browser-profile\.ps1/i);
  assert.doesNotMatch(inno, /\[UninstallDelete\][\s\S]*BrowserProfile/i);
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

  const checks = [
    ["installer metadata keeps browser deletion separate", () => assert.match(inno, /-PromptDeleteBrowserProfile/)],
    ["default uninstall preserves app data and browser login", assertUninstallPreservesUserDataByDefault],
    ["app-data deletion preserves browser login", assertUninstallDeletesOnlyApprovedChildren],
    ["browser-profile deletion is separately confirmed", assertUninstallDeletesBrowserProfileSeparately],
    ["browser-profile guard runs before any deletion", assertUninstallGuardPrecedesEveryDeletion],
    ["browser-profile root junction is rejected", assertUninstallRejectsBrowserProfileRootReparsePoint],
    ["browser-profile nested junction is rejected", assertUninstallRejectsBrowserProfileNestedReparsePoint],
    ["migration is explicit, copy-only, and race-safe", assertBrowserProfileMigrationBoundaries],
    ["migration source-tree junction is rejected", assertMigrationRejectsSourceTreeReparsePoint],
    ["migration target-parent junction is rejected", assertMigrationRejectsTargetParentReparsePoint],
    ["installed self-check keeps authority while probing temporary ports", assertInstalledSelfCheckUsesSafeProbePorts],
    ["installer stage contains maintenance only", assertStandardInstallerStageBoundary],
    ["packaged PowerShell scripts parse", assertPackagedPowerShellScriptsParse]
  ];
  const failures = [];
  for (const [name, check] of checks) {
    try {
      check();
    } catch (error) {
      failures.push(new Error(`${name}: ${error.stack || error.message}`));
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, `${failures.length} windows installer smoke checks failed`);
  }
  console.log("windows_installer_smoke ok");
}

function assertUninstallPreservesUserDataByDefault() {
  const fixture = createUninstallFixture();
  try {
    const result = runPowerShell([
      "-File", fixture.scriptPath,
      "-InstallRoot", fixture.installRoot,
      "-SkipDashboardStop"
    ], { localAppData: fixture.localAppData });
    assert.strictEqual(result.status, 0, combined(result));
    assert(fs.existsSync(fixture.database), "default uninstall preparation must preserve local data");
    assert(fs.existsSync(fixture.browserProfileSentinel), "default uninstall must preserve browser login data");
    assert(fs.existsSync(fixture.outsideSentinel), "uninstall preparation must not touch sibling paths");
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function assertUninstallDeletesOnlyApprovedChildren() {
  const fixture = createUninstallFixture();
  try {
    const result = runPowerShell([
      "-File", fixture.scriptPath,
      "-InstallRoot", fixture.installRoot,
      "-SkipDashboardStop",
      "-DeleteUserData",
      "-ConfirmDelete"
    ], { localAppData: fixture.localAppData });
    assert.strictEqual(result.status, 0, combined(result));
    for (const relativePath of ["data", ".runtime", "reports", "logs", "profiles"]) {
      assert(
        !fs.existsSync(path.join(fixture.installRoot, relativePath)),
        `confirmed cleanup must remove ${relativePath}`
      );
    }
    assert(fs.existsSync(fixture.browserProfileSentinel), "application-data deletion must preserve browser login data");
    assert(fs.existsSync(fixture.outsideSentinel), "confirmed cleanup must stay inside the install root");
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function assertUninstallDeletesBrowserProfileSeparately() {
  const fixture = createUninstallFixture();
  try {
    const partial = runPowerShell([
      "-File", fixture.scriptPath,
      "-InstallRoot", fixture.installRoot,
      "-SkipDashboardStop",
      "-DeleteBrowserProfile"
    ], { localAppData: fixture.localAppData });
    assert.notStrictEqual(partial.status, 0, "browser-profile deletion must require its separate confirmation");
    assert(fs.existsSync(fixture.browserProfileSentinel), "an unconfirmed browser-profile deletion must preserve data");

    const result = runPowerShell([
      "-File", fixture.scriptPath,
      "-InstallRoot", fixture.installRoot,
      "-SkipDashboardStop",
      "-DeleteBrowserProfile",
      "-ConfirmDeleteBrowserProfile"
    ], { localAppData: fixture.localAppData });
    assert.strictEqual(result.status, 0, combined(result));
    assert(!fs.existsSync(fixture.browserProfile), "separately confirmed cleanup must remove BrowserProfile");
    assert(fs.existsSync(fixture.localAppDataSiblingSentinel), "browser cleanup must preserve LOCALAPPDATA siblings");
    assert(fs.existsSync(fixture.installRoot), "browser cleanup must preserve the install root");
    assert(fs.existsSync(fixture.database), "browser-only cleanup must preserve application data");
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function assertUninstallGuardPrecedesEveryDeletion() {
  const fixture = createUninstallFixture({ helperMode: "in-use" });
  try {
    const result = runPowerShell([
      "-File", fixture.scriptPath,
      "-InstallRoot", fixture.installRoot,
      "-SkipDashboardStop",
      "-DeleteUserData",
      "-ConfirmDelete",
      "-DeleteBrowserProfile",
      "-ConfirmDeleteBrowserProfile"
    ], { localAppData: fixture.localAppData });
    assert.notStrictEqual(result.status, 0, "an in-use browser profile must block the whole deletion transaction");
    assert.match(combined(result), /ROLEFLOW_BROWSER_PROFILE_IN_USE/);
    assert(fs.existsSync(fixture.database), "profile guard failure must happen before application-data deletion");
    assert(fs.existsSync(fixture.browserProfileSentinel), "profile guard failure must preserve browser data");
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function assertUninstallRejectsBrowserProfileRootReparsePoint() {
  const profileJunction = createUninstallFixture();
  try {
    fs.rmSync(profileJunction.browserProfile, { recursive: true, force: true });
    const externalProfile = path.join(profileJunction.fixtureRoot, "external-browser-profile");
    const externalSentinel = path.join(externalProfile, "Default", "external.txt");
    fs.mkdirSync(path.dirname(externalSentinel), { recursive: true });
    fs.writeFileSync(externalSentinel, "external", "utf8");
    createJunction(externalProfile, profileJunction.browserProfile);
    const preserveResult = runPowerShell([
      "-File", profileJunction.scriptPath,
      "-InstallRoot", profileJunction.installRoot,
      "-SkipDashboardStop",
      "-SkipDeletePrompt"
    ], { localAppData: profileJunction.localAppData });
    assert.strictEqual(preserveResult.status, 0, combined(preserveResult));
    assert(fs.existsSync(profileJunction.database), "default uninstall preparation must preserve application data");
    assert(fs.lstatSync(profileJunction.browserProfile).isSymbolicLink(), "default uninstall preparation must preserve a profile junction");
    assert(fs.existsSync(externalSentinel));
    const result = runPowerShell([
      "-File", profileJunction.scriptPath,
      "-InstallRoot", profileJunction.installRoot,
      "-SkipDashboardStop",
      "-DeleteUserData",
      "-ConfirmDelete",
      "-DeleteBrowserProfile",
      "-ConfirmDeleteBrowserProfile"
    ], { localAppData: profileJunction.localAppData });
    const observed = {
      status: result.status,
      databaseExists: fs.existsSync(profileJunction.database),
      junctionExists: fs.existsSync(profileJunction.browserProfile),
      externalSentinelExists: fs.existsSync(externalSentinel)
    };
    assert(
      result.status !== 0 && /ROLEFLOW_REPARSE_POINT_BLOCKED/.test(combined(result)),
      `BrowserProfile junction was not rejected before deletion: ${JSON.stringify(observed)}\n${combined(result)}`
    );
    assert(fs.existsSync(profileJunction.database), "reparse rejection must precede application-data deletion");
    assert(fs.lstatSync(profileJunction.browserProfile).isSymbolicLink(), "BrowserProfile junction must remain intact");
    assert(fs.existsSync(externalSentinel), "BrowserProfile junction target must remain intact");
    assert(fs.existsSync(profileJunction.localAppDataSiblingSentinel));
  } finally {
    fs.rmSync(profileJunction.fixtureRoot, { recursive: true, force: true });
  }
}

function assertUninstallRejectsBrowserProfileNestedReparsePoint() {
  const nestedJunction = createUninstallFixture();
  try {
    const externalDirectory = path.join(nestedJunction.fixtureRoot, "external-browser-child");
    const externalSentinel = path.join(externalDirectory, "external.txt");
    fs.mkdirSync(externalDirectory, { recursive: true });
    fs.writeFileSync(externalSentinel, "external", "utf8");
    const linkPath = path.join(nestedJunction.browserProfile, "Default", "LinkedData");
    createJunction(externalDirectory, linkPath);
    const result = runPowerShell([
      "-File", nestedJunction.scriptPath,
      "-InstallRoot", nestedJunction.installRoot,
      "-SkipDashboardStop",
      "-DeleteUserData",
      "-ConfirmDelete",
      "-DeleteBrowserProfile",
      "-ConfirmDeleteBrowserProfile"
    ], { localAppData: nestedJunction.localAppData });
    const observed = {
      status: result.status,
      databaseExists: fs.existsSync(nestedJunction.database),
      profileExists: fs.existsSync(nestedJunction.browserProfile),
      nestedJunctionExists: fs.existsSync(linkPath),
      externalSentinelExists: fs.existsSync(externalSentinel)
    };
    assert(
      result.status !== 0 && /ROLEFLOW_REPARSE_POINT_BLOCKED/.test(combined(result)),
      `nested BrowserProfile junction was not rejected before deletion: ${JSON.stringify(observed)}\n${combined(result)}`
    );
    assert(fs.existsSync(nestedJunction.database));
    assert(fs.lstatSync(linkPath).isSymbolicLink(), "nested browser junction must remain intact");
    assert(fs.existsSync(externalSentinel));
  } finally {
    fs.rmSync(nestedJunction.fixtureRoot, { recursive: true, force: true });
  }
}

function assertBrowserProfileMigrationBoundaries() {
  assertMigrationRequiresExplicitConfirmation();
  assertMigrationCopiesWithoutChangingSource();
  assertMigrationRejectsExistingTarget();
  assertMigrationRejectsMissingLocalState();
  assertMigrationRejectsRelatedPaths();
  assertMigrationCleansStagingAfterCopyFailure();
  assertMigrationGuardRunsBeforeCopy();
  assertMigrationPreservesRaceCreatedTarget();
}

function assertMigrationRequiresExplicitConfirmation() {
  const fixture = createMigrationFixture();
  try {
    const before = snapshotTree(fixture.source);
    const result = invokeMigration(fixture, []);
    assert.notStrictEqual(result.status, 0, "migration must require -ConfirmMigration");
    assert.match(combined(result), /ROLEFLOW_PROFILE_MIGRATION_CONFIRMATION_REQUIRED/);
    assert.deepStrictEqual(snapshotTree(fixture.source), before);
    assert(!fs.existsSync(fixture.target));
    assertNoMigrationStaging(fixture);
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function assertMigrationCopiesWithoutChangingSource() {
  const fixture = createMigrationFixture();
  try {
    const before = snapshotTree(fixture.source);
    const result = invokeMigration(fixture, ["-ConfirmMigration"]);
    assert.strictEqual(result.status, 0, combined(result));
    assert.match(combined(result), /PROFILE_MIGRATION_OK/);
    assert.deepStrictEqual(snapshotTree(fixture.source), before, "migration must retain the source byte-for-byte");
    assert.deepStrictEqual(snapshotTree(fixture.target), before, "migration target must contain the copied inventory");
    assertNoMigrationStaging(fixture);
    assert(fs.existsSync(fixture.siblingSentinel), "migration must preserve source siblings");
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function assertMigrationRejectsExistingTarget() {
  const fixture = createMigrationFixture();
  try {
    fs.mkdirSync(fixture.target, { recursive: true });
    const before = snapshotTree(fixture.source);
    const result = invokeMigration(fixture, ["-ConfirmMigration"]);
    assert.notStrictEqual(result.status, 0, "even an empty formal target must block migration");
    assert.match(combined(result), /ROLEFLOW_PROFILE_TARGET_EXISTS/);
    assert.deepStrictEqual(snapshotTree(fixture.source), before);
    assert.deepStrictEqual(snapshotTree(fixture.target), []);
    assertNoMigrationStaging(fixture);
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function assertMigrationRejectsMissingLocalState() {
  const fixture = createMigrationFixture();
  try {
    fs.rmSync(path.join(fixture.source, "Local State"));
    const before = snapshotTree(fixture.source);
    const result = invokeMigration(fixture, ["-ConfirmMigration"]);
    assert.notStrictEqual(result.status, 0);
    assert.match(combined(result), /ROLEFLOW_PROFILE_LOCAL_STATE_REQUIRED/);
    assert.deepStrictEqual(snapshotTree(fixture.source), before);
    assert(!fs.existsSync(fixture.target));
    assertNoMigrationStaging(fixture);
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function assertMigrationRejectsRelatedPaths() {
  const same = createMigrationFixture();
  try {
    fs.mkdirSync(same.target, { recursive: true });
    fs.copyFileSync(path.join(same.source, "Local State"), path.join(same.target, "Local State"));
    const result = invokeMigration(same, ["-SourceProfileDir", same.target, "-ConfirmMigration"], true);
    assert.notStrictEqual(result.status, 0);
    assert.match(combined(result), /ROLEFLOW_PROFILE_PATH_RELATION_INVALID/);
  } finally {
    fs.rmSync(same.fixtureRoot, { recursive: true, force: true });
  }

  const sourceContainsTarget = createMigrationFixture();
  try {
    const source = sourceContainsTarget.localAppData;
    fs.writeFileSync(path.join(source, "Local State"), "source-parent", "utf8");
    const before = snapshotTree(source);
    const result = invokeMigration(sourceContainsTarget, ["-SourceProfileDir", source, "-ConfirmMigration"], true);
    assert.notStrictEqual(result.status, 0);
    assert.match(combined(result), /ROLEFLOW_PROFILE_PATH_RELATION_INVALID/);
    assert.deepStrictEqual(snapshotTree(source), before, "a rejected ancestor source must not gain a staging parent");
  } finally {
    fs.rmSync(sourceContainsTarget.fixtureRoot, { recursive: true, force: true });
  }

  const targetContainsSource = createMigrationFixture();
  try {
    const nestedSource = path.join(targetContainsSource.target, "legacy-profile");
    fs.mkdirSync(path.join(nestedSource, "Default"), { recursive: true });
    fs.writeFileSync(path.join(nestedSource, "Local State"), "nested", "utf8");
    fs.writeFileSync(path.join(nestedSource, "Default", "sentinel.txt"), "nested", "utf8");
    const before = snapshotTree(targetContainsSource.target);
    const result = invokeMigration(targetContainsSource, ["-SourceProfileDir", nestedSource, "-ConfirmMigration"], true);
    assert.notStrictEqual(result.status, 0);
    assert.match(combined(result), /ROLEFLOW_PROFILE_PATH_RELATION_INVALID/);
    assert.deepStrictEqual(snapshotTree(targetContainsSource.target), before);
  } finally {
    fs.rmSync(targetContainsSource.fixtureRoot, { recursive: true, force: true });
  }
}

function assertMigrationCleansStagingAfterCopyFailure() {
  const fixture = createMigrationFixture({ helperMode: "copy-failure" });
  try {
    const before = snapshotTree(fixture.source);
    const result = invokeMigration(fixture, ["-ConfirmMigration"]);
    assert.notStrictEqual(result.status, 0);
    assert.match(combined(result), /ROLEFLOW_TEST_COPY_FAILURE/);
    assert.deepStrictEqual(snapshotTree(fixture.source), before);
    assert(!fs.existsSync(fixture.target), "copy failure must not expose a partial formal target");
    assertNoMigrationStaging(fixture);
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function assertMigrationGuardRunsBeforeCopy() {
  const fixture = createMigrationFixture({ helperMode: "in-use" });
  try {
    const before = snapshotTree(fixture.source);
    const result = invokeMigration(fixture, ["-ConfirmMigration"]);
    assert.notStrictEqual(result.status, 0);
    assert.match(combined(result), /ROLEFLOW_BROWSER_PROFILE_IN_USE/);
    assert.deepStrictEqual(snapshotTree(fixture.source), before);
    assert(!fs.existsSync(fixture.target));
    assertNoMigrationStaging(fixture);
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function assertMigrationPreservesRaceCreatedTarget() {
  const fixture = createMigrationFixture({ helperMode: "rename-race" });
  try {
    const before = snapshotTree(fixture.source);
    const result = invokeMigration(fixture, ["-ConfirmMigration"]);
    assert.notStrictEqual(result.status, 0, "a target created before final rename must win the race safely");
    assert.deepStrictEqual(snapshotTree(fixture.source), before);
    assert(fs.existsSync(path.join(fixture.target, "race-owner.txt")), "migration must preserve the race-created target");
    assert(!fs.existsSync(path.join(fixture.target, "Default", "RoleFlowProfileSentinel.txt")));
    const nestedStaging = snapshotTree(fixture.target).filter((entry) => /BrowserProfile-migration-/i.test(entry));
    assert.deepStrictEqual(nestedStaging, [], "Directory.Move must not nest staging under an existing target");
    assertNoMigrationStaging(fixture);
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function assertMigrationRejectsSourceTreeReparsePoint() {
  const fixture = createMigrationFixture();
  try {
    const externalDirectory = path.join(fixture.fixtureRoot, "external-profile-data");
    const externalSentinel = path.join(externalDirectory, "external.txt");
    fs.mkdirSync(externalDirectory, { recursive: true });
    fs.writeFileSync(externalSentinel, "external", "utf8");
    const linkPath = path.join(fixture.source, "Default", "LinkedData");
    createJunction(externalDirectory, linkPath);
    const before = snapshotTree(fixture.source);
    const result = invokeMigration(fixture, ["-ConfirmMigration"]);
    const observed = {
      status: result.status,
      targetExists: fs.existsSync(fixture.target),
      junctionExists: fs.existsSync(linkPath),
      externalSentinelExists: fs.existsSync(externalSentinel)
    };
    assert(
      result.status !== 0 && /ROLEFLOW_REPARSE_POINT_BLOCKED/.test(combined(result)),
      `source-tree junction was not rejected before migration: ${JSON.stringify(observed)}\n${combined(result)}`
    );
    assert.deepStrictEqual(snapshotTree(fixture.source), before, "reparse rejection must preserve the source tree");
    assert(fs.lstatSync(linkPath).isSymbolicLink(), "source-tree junction must remain intact");
    assert(fs.existsSync(externalSentinel), "source-tree junction target must remain intact");
    assert(!fs.existsSync(fixture.target), "reparse rejection must not expose a migration target");
    assert(fs.existsSync(fixture.siblingSentinel));
    assertNoMigrationStaging(fixture);
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function assertMigrationRejectsTargetParentReparsePoint() {
  const fixture = createMigrationFixture();
  try {
    const externalRoleFlow = path.join(fixture.fixtureRoot, "external-roleflow");
    const externalSentinel = path.join(externalRoleFlow, "external.txt");
    fs.mkdirSync(externalRoleFlow, { recursive: true });
    fs.writeFileSync(externalSentinel, "external", "utf8");
    const roleFlowLink = path.join(fixture.localAppData, "RoleFlow");
    createJunction(externalRoleFlow, roleFlowLink);
    const before = snapshotTree(fixture.source);
    const result = invokeMigration(fixture, ["-ConfirmMigration"]);
    const observed = {
      status: result.status,
      targetExists: fs.existsSync(fixture.target),
      roleFlowJunctionExists: fs.existsSync(roleFlowLink),
      externalSentinelExists: fs.existsSync(externalSentinel)
    };
    assert(
      result.status !== 0 && /ROLEFLOW_REPARSE_POINT_BLOCKED/.test(combined(result)),
      `target-parent junction was not rejected before migration: ${JSON.stringify(observed)}\n${combined(result)}`
    );
    assert.deepStrictEqual(snapshotTree(fixture.source), before);
    assert(fs.lstatSync(roleFlowLink).isSymbolicLink(), "target-parent junction must remain intact");
    assert(fs.existsSync(externalSentinel), "target-parent junction target must remain intact");
    assert(!fs.existsSync(path.join(externalRoleFlow, "BrowserProfile")));
    assert(fs.existsSync(fixture.siblingSentinel));
    assertNoMigrationStaging(fixture);
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function assertInstalledSelfCheckUsesSafeProbePorts() {
  const repositoryArtifactsBefore = repositorySelfCheckFingerprint();
  const wrongRootPort = reserveFreePort();
  const wrongRootCdpPort = reserveFreePort();
  const wrongRoot = startHealthFixture(wrongRootPort, {
    projectRoot: path.join(selfCheckProjectRoot, "different-install-root"),
    browserAuthority: {
      browserMode: "portable",
      cdpPort: 9222,
      profilePath: path.join(suiteLocalAppData, "RoleFlow", "BrowserProfile")
    }
  });
  try {
    const result = invokeSelfCheck(wrongRootPort, wrongRootCdpPort);
    assert.notStrictEqual(result.status, 0, "a Dashboard conflict from another install root must be rejected");
  } finally {
    stopFixtureProcess(wrongRoot);
  }

  const dashboardProbePort = reserveFreePort();
  const cdpProbePort = reserveFreePort();
  const wrongAuthority = startHealthFixture(dashboardProbePort, {
    projectRoot: selfCheckProjectRoot,
    browserAuthority: {
      browserMode: "portable",
      cdpPort: 9333,
      profilePath: path.join(suiteLocalAppData, "RoleFlow", "BrowserProfile")
    }
  });
  try {
    const result = invokeSelfCheck(dashboardProbePort, cdpProbePort);
    assert.notStrictEqual(result.status, 0, "a Dashboard conflict with the wrong authority must be rejected");
  } finally {
    stopFixtureProcess(wrongAuthority);
  }

  const acceptedDashboardPort = reserveFreePort();
  const acceptedCdpPort = reserveFreePort();
  const accepted = startHealthFixture(acceptedDashboardPort, {
    projectRoot: selfCheckProjectRoot,
    browserAuthority: {
      browserMode: "portable",
      cdpPort: 9222,
      profilePath: path.join(suiteLocalAppData, "RoleFlow", "BrowserProfile")
    }
  });
  try {
    const result = invokeSelfCheck(acceptedDashboardPort, acceptedCdpPort);
    assert.strictEqual(result.status, 0, combined(result));
    assert.match(combined(result), /SELF_CHECK_OK/);
  } finally {
    stopFixtureProcess(accepted);
  }

  const freeDashboardPort = reserveFreePort();
  const ambiguousCdpPort = reserveFreePort();
  const ambiguous = startHealthFixture(ambiguousCdpPort, { projectRoot: selfCheckProjectRoot, browserAuthority: {} });
  try {
    const result = invokeSelfCheck(freeDashboardPort, ambiguousCdpPort);
    assert.notStrictEqual(result.status, 0, "a non-Edge CDP probe-port listener must be rejected");
  } finally {
    stopFixtureProcess(ambiguous);
  }
  assert.deepStrictEqual(
    repositorySelfCheckFingerprint(),
    repositoryArtifactsBefore,
    "installed self-check smoke must not write repository .runtime artifacts"
  );
}

function invokeSelfCheck(dashboardProbePort, cdpProbePort) {
  return runPowerShell([
    "-File", path.join(root, "scripts", "installed-self-check.ps1"),
    "-ProjectRoot", selfCheckProjectRoot,
    "-NodePath", process.execPath,
    "-SkipEdgeCheck",
    "-DashboardProbePort", String(dashboardProbePort),
    "-CdpProbePort", String(cdpProbePort)
  ], { timeout: 30_000, localAppData: suiteLocalAppData });
}

function assertStandardInstallerStageBoundary() {
  const fixture = createLargeStageFixture();
  try {
    const result = runPowerShell([
      "-File", path.join(root, "scripts", "build-installer.ps1"),
      "-BuildRoot", path.join(fixture.fixtureRoot, "build"),
      "-OutputDir", path.join(fixture.fixtureRoot, "dist"),
      "-PortableNodeRoot", path.dirname(process.execPath),
      "-SkipTests",
      "-StageOnly"
    ], { timeout: 60_000, localAppData: suiteLocalAppData });
    assert.strictEqual(result.status, 0, combined(result));
    const stageMatch = combined(result).match(/Installer stage:\s*(.+)\r?$/m);
    assert(stageMatch, `missing installer stage path:\n${combined(result)}`);
    const stageDir = stageMatch[1].trim();
    assert(fs.existsSync(path.join(stageDir, "scripts", "migrate-browser-profile.ps1")), "installer stage must include explicit profile migration");
    for (const relativePath of [
      "Install.bat",
      "Start.bat",
      "ScanPortable.bat",
      "StartPortableEdge.bat",
      "tests",
      "BrowserProfile",
      path.join(".runtime", "edge-profile"),
      path.join("vendor", "edge-control-bridge")
    ]) {
      assert(!fs.existsSync(path.join(stageDir, relativePath)), `standard installer must exclude ${relativePath}`);
    }
    const forbidden = listTree(stageDir).filter((relativePath) =>
      /(^|[\\/])BrowserProfile([\\/]|$)/i.test(relativePath)
      || /(^|[\\/])edge-profile([\\/]|$)/i.test(relativePath)
      || /(^|[\\/])tests?([\\/]|$)/i.test(relativePath)
      || /(^|[\\/])vendor[\\/]edge-control-bridge([\\/]|$)/i.test(relativePath)
      || /^reports?([\\/]|$)/i.test(relativePath)
      || /^logs?([\\/]|$)/i.test(relativePath)
      || /(^|[\\/])\.runtime([\\/]|$)/i.test(relativePath)
      || /jobs\.sqlite|\.sqlite(?:-(?:wal|shm))?$|\.key$|(^|[\\/])\.env(?:\.|$)|(^|[\\/])secrets?([\\/]|$)/i.test(relativePath)
    );
    assert.deepStrictEqual(forbidden, [], `installer stage contains forbidden paths:\n${forbidden.join("\n")}`);
  } finally {
    removeUniqueChild(fixture.fixtureRoot, fixture.testRoot);
  }
}

function assertPackagedPowerShellScriptsParse() {
  const command = [
    "$failures = @()",
    "Get-ChildItem -LiteralPath $env:ROLEFLOW_SCRIPT_ROOT -Recurse -File -Filter '*.ps1' | ForEach-Object {",
    "  $tokens = $null",
    "  $errors = $null",
    "  [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors) | Out-Null",
    "  if ($errors.Count) { $failures += ('{0}: {1}' -f $_.FullName, $errors[0].Message) }",
    "}",
    "if ($failures.Count) { Write-Error ($failures -join [Environment]::NewLine); exit 1 }"
  ].join("; ");
  const result = runPowerShell(["-Command", command], {
    timeout: 30_000,
    localAppData: suiteLocalAppData,
    env: { ROLEFLOW_SCRIPT_ROOT: path.join(root, "scripts") }
  });
  assert.strictEqual(result.status, 0, combined(result));
}

function createSelfCheckProjectFixture() {
  for (const relativePath of ["src", "scripts", "node_modules/pdfjs-dist/legacy/build"]) {
    fs.mkdirSync(path.join(selfCheckProjectRoot, relativePath), { recursive: true });
  }
  fs.writeFileSync(path.join(selfCheckProjectRoot, "package.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(selfCheckProjectRoot, "LICENSE"), "fixture\n", "utf8");
  fs.writeFileSync(path.join(selfCheckProjectRoot, "NOTICE"), "fixture\n", "utf8");
  fs.writeFileSync(path.join(selfCheckProjectRoot, "scripts", "start-workspace.ps1"), "# fixture\n", "utf8");
  fs.writeFileSync(path.join(selfCheckProjectRoot, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs"), "export {};\n", "utf8");
  fs.writeFileSync(path.join(selfCheckProjectRoot, "src", "cli.js"), String.raw`
const http = require("node:http");
const path = require("node:path");

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : "";
}

const port = Number(valueAfter("--port"));
const server = http.createServer((request, response) => {
  response.writeHead(request.url === "/health" ? 200 : 404, { "content-type": "application/json" });
  response.end(JSON.stringify({
    ok: true,
    pid: process.pid,
    projectRoot: path.resolve(__dirname, ".."),
    browserAuthority: {
      browserMode: valueAfter("--browser"),
      cdpPort: Number(valueAfter("--cdp-port")),
      profilePath: valueAfter("--browser-profile")
    }
  }));
});
server.listen(port, "127.0.0.1");
`, "utf8");
}

function repositorySelfCheckFingerprint() {
  const logPath = path.join(root, ".runtime", "logs", "install-self-check.log");
  const selfCheckDir = path.join(root, ".runtime", "self-check");
  return {
    log: fileFingerprint(logPath),
    selfCheck: fs.existsSync(selfCheckDir) ? snapshotTree(selfCheckDir) : null
  };
}

function fileFingerprint(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  return {
    bytes: stat.size,
    modified: stat.mtimeMs,
    contents: fs.readFileSync(filePath).toString("base64")
  };
}

function createUninstallFixture({ helperMode = "safe" } = {}) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-uninstall-"));
  const installRoot = path.join(fixtureRoot, "Programs", "RoleFlow");
  const scriptRoot = path.join(fixtureRoot, "maintenance", "scripts");
  const localAppData = path.join(fixtureRoot, "local-app-data");
  for (const relativePath of ["data", ".runtime/settings", "reports", "logs", "profiles"]) {
    fs.mkdirSync(path.join(installRoot, relativePath), { recursive: true });
  }
  const database = path.join(installRoot, "data", "jobs.sqlite");
  fs.writeFileSync(database, "fixture", "utf8");
  fs.writeFileSync(path.join(installRoot, ".runtime", "settings", "model.json"), "{}", "utf8");
  fs.writeFileSync(path.join(installRoot, "reports", "result.html"), "fixture", "utf8");
  fs.writeFileSync(path.join(installRoot, "logs", "roleflow.log"), "fixture", "utf8");
  fs.writeFileSync(path.join(installRoot, "profiles", "private.json"), "fixture", "utf8");
  const browserProfile = path.join(localAppData, "RoleFlow", "BrowserProfile");
  fs.mkdirSync(path.join(browserProfile, "Default"), { recursive: true });
  const browserProfileSentinel = path.join(browserProfile, "Default", "RoleFlowProfileSentinel.txt");
  fs.writeFileSync(browserProfileSentinel, "browser-login", "utf8");
  const localAppDataSiblingSentinel = path.join(localAppData, "keep.txt");
  fs.writeFileSync(localAppDataSiblingSentinel, "keep", "utf8");
  const outsideSentinel = path.join(fixtureRoot, "keep.txt");
  fs.writeFileSync(outsideSentinel, "keep", "utf8");
  const scriptPath = copyMaintenanceScript("prepare-uninstall.ps1", scriptRoot, helperMode);
  return {
    fixtureRoot,
    installRoot,
    scriptPath,
    localAppData,
    database,
    browserProfile,
    browserProfileSentinel,
    localAppDataSiblingSentinel,
    outsideSentinel
  };
}

function createMigrationFixture({ helperMode = "safe" } = {}) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-profile-migration-"));
  const scriptRoot = path.join(fixtureRoot, "maintenance", "scripts");
  const localAppData = path.join(fixtureRoot, "local-app-data");
  const source = path.join(fixtureRoot, "legacy-profile");
  fs.mkdirSync(path.join(source, "Default"), { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.writeFileSync(path.join(source, "Local State"), "local-state", "utf8");
  fs.writeFileSync(path.join(source, "Default", "RoleFlowProfileSentinel.txt"), "browser-login", "utf8");
  const siblingSentinel = path.join(fixtureRoot, "keep.txt");
  fs.writeFileSync(siblingSentinel, "keep", "utf8");
  const scriptPath = copyMaintenanceScript("migrate-browser-profile.ps1", scriptRoot, helperMode);
  return {
    fixtureRoot,
    scriptPath,
    localAppData,
    source,
    siblingSentinel,
    target: path.join(localAppData, "RoleFlow", "BrowserProfile")
  };
}

function copyMaintenanceScript(name, scriptRoot, helperMode) {
  fs.mkdirSync(path.join(scriptRoot, "lib"), { recursive: true });
  const source = path.join(root, "scripts", name);
  assert(fs.existsSync(source), `missing maintenance script: scripts/${name}`);
  const destination = path.join(scriptRoot, name);
  fs.copyFileSync(source, destination);
  fs.writeFileSync(path.join(scriptRoot, "lib", "startup-identity.ps1"), startupIdentityStub(helperMode), "utf8");
  return destination;
}

function startupIdentityStub(mode) {
  const common = read("scripts/lib/startup-identity.ps1") + String.raw`
function Get-RoleFlowEdgeProcessSnapshot {
  return [pscustomobject]@{ querySucceeded = $true; processes = @() }
}
function Assert-RoleFlowBrowserProfileNotInUse {
  param([Parameter(Mandatory = $true)][string]$ProfilePath, [Parameter(Mandatory = $true)]$ProcessQuerySnapshot)
  return $true
}
`;
  if (mode === "in-use") {
    return common + String.raw`
function Assert-RoleFlowBrowserProfileNotInUse {
  param([Parameter(Mandatory = $true)][string]$ProfilePath, [Parameter(Mandatory = $true)]$ProcessQuerySnapshot)
  throw "ROLEFLOW_BROWSER_PROFILE_IN_USE"
}
`;
  }
  if (mode === "copy-failure") {
    return common + String.raw`
function Copy-Item {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$LiteralPath, [Parameter(Mandatory = $true)][string]$Destination, [switch]$Recurse, [switch]$Force)
  $stagingPath = Split-Path -Parent $Destination
  New-Item -ItemType File -Force -Path (Join-Path $stagingPath "copy-failure-marker.txt") | Out-Null
  throw "ROLEFLOW_TEST_COPY_FAILURE"
}
`;
  }
  if (mode === "rename-race") {
    return common + String.raw`
function Copy-Item {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$LiteralPath, [Parameter(Mandatory = $true)][string]$Destination, [switch]$Recurse, [switch]$Force)
  Microsoft.PowerShell.Management\Copy-Item @PSBoundParameters
  $target = Join-Path $env:LOCALAPPDATA "RoleFlow\BrowserProfile"
  if (-not (Test-Path -LiteralPath $target)) {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Set-Content -LiteralPath (Join-Path $target "race-owner.txt") -Value "race-owner" -Encoding utf8
  }
}
`;
  }
  return common;
}

function createJunction(targetPath, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(path.resolve(targetPath), linkPath, "junction");
  assert(fs.lstatSync(linkPath).isSymbolicLink(), `failed to create junction fixture: ${linkPath}`);
}

function invokeMigration(fixture, extraArgs, replacesSource = false) {
  const sourceArgs = replacesSource ? [] : ["-SourceProfileDir", fixture.source];
  return runPowerShell([
    "-File", fixture.scriptPath,
    ...sourceArgs,
    ...extraArgs
  ], { localAppData: fixture.localAppData });
}

function assertNoMigrationStaging(fixture) {
  const parent = path.join(fixture.localAppData, "RoleFlow");
  if (!fs.existsSync(parent)) return;
  const staging = fs.readdirSync(parent).filter((name) => /^\.BrowserProfile-migration-[0-9a-f]+$/i.test(name));
  assert.deepStrictEqual(staging, [], `migration staging leaked: ${staging.join(", ")}`);
}

function snapshotTree(directory) {
  if (!fs.existsSync(directory)) return null;
  return listTree(directory).map((relativePath) => {
    const fullPath = path.join(directory, relativePath);
    const stat = fs.statSync(fullPath);
    return stat.isDirectory()
      ? `D:${relativePath.replaceAll("\\", "/")}`
      : `F:${relativePath.replaceAll("\\", "/")}:${fs.readFileSync(fullPath).toString("base64")}`;
  });
}

function listTree(directory) {
  const entries = [];
  function visit(current, prefix) {
    for (const dirent of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = prefix ? path.join(prefix, dirent.name) : dirent.name;
      entries.push(relativePath);
      if (dirent.isDirectory()) visit(path.join(current, dirent.name), relativePath);
    }
  }
  visit(directory, "");
  return entries;
}

function createLargeStageFixture() {
  const requestedRoot = process.env.ROLEFLOW_INSTALLER_TEST_ROOT
    ? path.resolve(process.env.ROLEFLOW_INSTALLER_TEST_ROOT)
    : fs.existsSync("D:\\")
      ? "D:\\DevData\\RoleFlow-tests"
      : path.join(os.tmpdir(), "RoleFlow-tests");
  fs.mkdirSync(requestedRoot, { recursive: true });
  const fixtureRoot = fs.mkdtempSync(path.join(requestedRoot, "windows-installer-"));
  const testRoot = fs.realpathSync.native(requestedRoot);
  const resolvedFixture = fs.realpathSync.native(fixtureRoot);
  assertPathIsUniqueChild(resolvedFixture, testRoot);
  return { fixtureRoot: resolvedFixture, testRoot };
}

function removeUniqueChild(child, selectedRoot) {
  if (!fs.existsSync(child)) return;
  const resolvedRoot = fs.realpathSync.native(selectedRoot);
  const resolvedChild = fs.realpathSync.native(child);
  assertPathIsUniqueChild(resolvedChild, resolvedRoot);
  fs.rmSync(resolvedChild, { recursive: true, force: true });
}

function assertPathIsUniqueChild(child, selectedRoot) {
  const relative = path.relative(selectedRoot, child);
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `unsafe recursive cleanup target: ${child}`);
}

function reserveFreePort() {
  const command = [
    "$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)",
    "$listener.Start()",
    "try { ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }"
  ].join("; ");
  const result = runPowerShell(["-Command", command], { localAppData: suiteLocalAppData });
  assert.strictEqual(result.status, 0, combined(result));
  const port = Number(String(result.stdout).trim());
  assert(Number.isInteger(port) && port > 0);
  if (reservedProbePorts.has(port)) return reserveFreePort();
  reservedProbePorts.add(port);
  return port;
}

function startHealthFixture(port, health) {
  const readyPath = path.join(suiteRoot, `health-ready-${port}-${Date.now()}.txt`);
  const helper = String.raw`
const fs = require("node:fs");
const http = require("node:http");
const base = JSON.parse(process.env.ROLEFLOW_TEST_HEALTH);
const server = http.createServer((request, response) => {
  response.writeHead(request.url === "/health" ? 200 : 404, { "content-type": "application/json" });
  response.end(JSON.stringify({ ...base, ok: true, pid: process.pid }));
});
server.listen(Number(process.env.ROLEFLOW_TEST_PORT), "127.0.0.1", () => {
  fs.writeFileSync(process.env.ROLEFLOW_TEST_READY, "ready", "utf8");
});
setInterval(() => {}, 1000);
`;
  const child = spawn(process.execPath, ["-e", helper], {
    cwd: root,
    env: {
      ...process.env,
      LOCALAPPDATA: suiteLocalAppData,
      ROLEFLOW_TEST_HEALTH: JSON.stringify(health),
      ROLEFLOW_TEST_PORT: String(port),
      ROLEFLOW_TEST_READY: readyPath
    },
    stdio: "ignore",
    windowsHide: true
  });
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(readyPath) && Date.now() < deadline && child.exitCode === null) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert(fs.existsSync(readyPath), `health fixture did not bind temporary port ${port}`);
  fs.rmSync(readyPath, { force: true });
  return child;
}

function stopFixtureProcess(child) {
  if (child && child.exitCode === null) child.kill();
}

function runPowerShell(args, options = {}) {
  const timeout = typeof options === "number" ? options : options.timeout || 15_000;
  const localAppData = typeof options === "number" ? suiteLocalAppData : options.localAppData || suiteLocalAppData;
  fs.mkdirSync(localAppData, { recursive: true });
  return spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    ...args
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(typeof options === "object" ? options.env : {}),
      LOCALAPPDATA: localAppData
    },
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
