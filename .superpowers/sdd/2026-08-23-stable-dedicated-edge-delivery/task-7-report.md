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

## Fix Round 1: Overlap and Reparse Identity

### RED

- A pure process snapshot with an explicit `--user-data-dir=C:\Profiles\Dedicated` was incorrectly accepted when the requested maintenance path was either `C:\Profiles` or `C:\Profiles\Dedicated\Default`.
- A pure ordinary-Edge snapshot without `--user-data-dir` was incorrectly accepted for the exact, parent, and child paths of the fixture `%LOCALAPPDATA%\Microsoft\Edge\User Data`. The independent fixture `%LOCALAPPDATA%\RoleFlow\BrowserProfile` remained an accepted non-overlap case.
- With `BrowserProfile` itself as a junction, current Windows PowerShell uninstall returned success, deleted the application database and the junction, but preserved the junction target sentinel.
- With a nested junction inside `BrowserProfile`, uninstall likewise deleted the database and containing profile tree while preserving the external junction target sentinel.
- With a junction in the migration source tree, migration entered the copy phase and then failed with `ROLEFLOW_PROFILE_STAGING_INVENTORY_MISMATCH`; source, link target, sibling, and formal-target absence were preserved, but rejection did not precede staging/copy.
- With `%LOCALAPPDATA%\RoleFlow` as a junction, migration returned `PROFILE_MIGRATION_OK` and published `BrowserProfile` inside the junction target.

The observed Windows behavior therefore did **not** show `Remove-Item -Recurse` traversing these junctions and deleting their external targets. The defect was the missing reparse identity refusal and the resulting deletion/publication outside the intended lexical identity, including application data being deleted before a browser-profile identity failure could occur.

### GREEN

- `node tests/startup_scripts_smoke.js` — exit 0, `startup_scripts_smoke ok`.
- `node tests/windows_installer_smoke.js` — exit 0, `windows_installer_smoke ok`.
- `node tests/self_check.js` — exit 0, `self_check ok` (with the existing Node experimental SQLite warning).
- Final fix-round StageOnly build — exit 0 at:
  - `D:\DevData\RoleFlow-installer\stage-b53da2447e504581bea75b4a82185004\stage\1.0.0`
- Independent stage inspection found the migration script and zero forbidden browser-profile, legacy edge-profile, database, secret, test, or Edge-Control paths.
- `git diff --check` — exit 0.

The shared guard now treats ordinary Edge without `--user-data-dir` as using the current fixture `LOCALAPPDATA\Microsoft\Edge\User Data`, rejects explicit or implicit profile overlap in either direction, and retains conservative query/incomplete/ambiguous failures. Migration and uninstall reject reparse points in all relevant existing path segments and deletion/copy trees before staging, copying, final rename, or removal. Lexical equality and ancestor checks remain a second layer after reparse identity validation.

The interactive prompt only resolves the exact current profile path for display. Reparse/deletion validation runs after the separate opt-in, so the default-No path remains non-blocking and preserves even a reparse-backed profile identity.

### Isolation and Risk Self-review

- All PowerShell children used fixture `LOCALAPPDATA`; no command read or modified the real `%LOCALAPPDATA%\RoleFlow\BrowserProfile`.
- Edge tests used serialized process snapshots only. No `msedge.exe` was manufactured, renamed, copied, executed, or queried, and Edge/BOSS was not started.
- Network fixtures used temporary ports selected while explicitly excluding 8787 and 9222; neither production port was bound or probed.
- The successful installed-self-check smoke used a minimal temporary project root. A before/after fingerprint proves it did not write repository `.runtime` logs or self-check artifacts.
- The first unbatched startup regression exceeded its fixture timeout and left one fixture PowerShell/Node pair on temporary port 49292. Their exact command lines were revalidated against the unique startup-smoke path before stopping them; the unique fixture directory and the earlier Task 7 self-check test log were then removed. No unrelated process or runtime artifact was touched.
- Junction failure assertions prove the source, application database, link, external link target, and siblings remain intact, and that no staging or formal migration target is exposed.
- Cleanup retains the safer failure mode: if staging identity becomes a reparse point, cleanup refuses to call `Remove-Item` rather than risk crossing the identity boundary.
- The D-drive StageOnly artifact is intentionally retained as evidence. No real installer or uninstaller was built, installed, or run.

## Fix Round 2: Missing Process Name Identity

### RED

The batch-only process snapshot added one complete Edge-shaped record with `querySucceeded=true`, an empty `ProcessName`, a populated Edge executable path and command line, and the exact requested `--user-data-dir`. `node tests/startup_scripts_smoke.js` exited 1 because that record returned `{ accepted: true }` instead of the literal expected `false`.

The root cause was ordering in `Assert-RoleFlowBrowserProfileNotInUse`: it compared `GetFileName(ProcessName)` with `msedge.exe` and skipped nonmatches before checking whether the name was missing. An empty name was therefore treated as a confirmed non-Edge process rather than an incomplete process identity.

### GREEN

- `node tests/startup_scripts_smoke.js` — exit 0, `startup_scripts_smoke ok`.
- `node tests/windows_installer_smoke.js` — exit 0, `windows_installer_smoke ok`.
- `node tests/self_check.js` — exit 0, `self_check ok` (with the existing Node experimental SQLite warning).
- `git diff --check` — exit 0.

The production change is limited to validating the snapshot process name before the confirmed-non-Edge skip. Empty or whitespace-only names now fail conservatively; a populated name that is clearly not `msedge.exe` is still ignored. Existing query failure, missing executable/command line, ambiguous profile, default-profile overlap, and explicit-profile overlap decisions remain covered in the same pure snapshot batch.

### Safety Self-review

- The regression is a serialized data snapshot only; it does not manufacture, start, query, or stop Edge.
- All test PowerShell children continue to receive fixture `LOCALAPPDATA`, and neither 8787 nor 9222 is bound or probed.
- The change adds no process control, port access, migration, installation, or deletion behavior.
- Post-test audit found zero startup fixture directories, zero startup fixture processes, and no repository `install-self-check.log`.
