# Task 7 Report: Stable Browser Login Distribution Boundary

## Status

Implemented the explicit copy-only browser-profile migration, installer self-check conflict inspection, and independent uninstall deletion boundary. All execution evidence used temporary fixtures. No real installation or uninstall ran, and no real Edge process, BOSS page, `%LOCALAPPDATA%\RoleFlow\BrowserProfile`, or production 8787/9222 listener was read, changed, started, stopped, bound, or probed.

## Implementation

- `scripts/migrate-browser-profile.ps1`
  - Requires `-SourceProfileDir` and explicit `-ConfirmMigration`.
  - Resolves the formal target only through the shared stable-profile helper.
  - Rejects roots, same/ancestor-related paths, missing `Local State`, existing targets (including empty ones), in-use profiles, and target-creation races.
  - Copies into one invocation-owned sibling staging directory, verifies `Local State` and the complete file inventory, then publishes with same-parent `[System.IO.Directory]::Move`.
  - Never moves or edits the source; failure cleanup revalidates and removes only that invocation's staging directory.
- `scripts/installed-self-check.ps1`
  - Resolves the stable profile and verifies its parent is writable without creating or opening the profile itself.
  - Resolves Edge only from standard installation locations.
  - Inspects configurable Dashboard/CDP probe ports without changing a port, killing an existing process, or starting Edge/BOSS.
  - Accepts a Dashboard conflict only for the exact install root and frozen `portable/9222/<stable profile>` authority; delegates accepted CDP identity to the shared exact Edge/profile/port guard.
  - Keeps the isolated random-port Dashboard check while starting it with the frozen production authority.
- `scripts/prepare-uninstall.ps1` and `installer/RoleFlow.iss`
  - Default, silent, upgrade, and ordinary application-data deletion preserve the external browser profile.
  - Interactive uninstall receives a second default-No prompt containing the exact current path and the BOSS re-login warning.
  - Noninteractive profile deletion requires both dedicated switches, re-derives the exact current `LOCALAPPDATA` target, and proves it is not in use.
  - Collects and validates all requested application/profile targets before deleting either set, so a profile guard failure preserves application data too.
  - No external `[UninstallDelete]` rule was added.
- Distribution scripts include the migration entry, reject profile/runtime/database/secret/test/Edge-Control data from the installer stage, and state that external browser login data is never packaged.

## TDD Evidence

### RED

`node tests/windows_installer_smoke.js` exited 1 with six expected missing-boundary failures:

1. Inno Setup lacked the independent browser-profile deletion prompt.
2. Uninstall lacked `DeleteBrowserProfile`/confirmation handling.
3. The profile in-use guard could not run before all requested deletions.
4. `scripts/migrate-browser-profile.ps1` was absent.
5. Self-check lacked Dashboard/CDP probe-port inputs.
6. The installer stage lacked the migration script.

The RED run used only temporary `LOCALAPPDATA` roots, deterministic copied helper stubs, random fixture ports explicitly excluding 8787/9222, and a proven unique child of `D:\DevData\RoleFlow-tests` for the large stage fixture.

### GREEN

- `node tests/windows_installer_smoke.js` — exit 0, `windows_installer_smoke ok`.
- `node tests/self_check.js` — exit 0, `self_check ok` (with Node's existing experimental SQLite warning).
- StageOnly build — exit 0 at:
  - `D:\DevData\RoleFlow-installer\stage-e69a3ab7b68e4e9f87df9d36c1a5e5fa\stage\1.0.0`
- Independent stage inspection confirmed the migration script is present and no forbidden profile/runtime/database/secret/test/Edge-Control path is present.

## Safety Self-review

- Every PowerShell child launched by `windows_installer_smoke` receives a fixture-specific temporary `LOCALAPPDATA`.
- Maintenance tests copy the production script and a deterministic `startup-identity.ps1` stub into the fixture; they never manufacture, rename, copy, or execute `msedge.exe`.
- Conflict tests use short-lived Node fixture listeners on unique temporary ports; 8787 and 9222 are excluded and never inspected.
- Migration tests prove source retention, target absence on failures, staging cleanup, guard-before-copy, and race-owner target preservation.
- Uninstall tests prove default/application-only retention, exact profile-only deletion, sibling/install-root retention, and guard-before-any-delete.
- The large stage fixture and cleanup both resolve real absolute paths and prove the unique child remains beneath the selected test root before recursive removal.
- No migration call was added to install, upgrade, startup, or uninstall paths.

## Risk Notes

- Destructive browser-profile removal remains an explicit opt-in and is intentionally not exercised against real data.
- An existing CDP listener can be accepted only when the shared production identity guard proves the installed Edge executable, requested probe port, and exact stable profile; Task 7 does not weaken or bypass that guard.
- The StageOnly artifact is intentionally left on `D:` as verification evidence; no installer executable was built or run.
