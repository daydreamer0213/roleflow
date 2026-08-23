# Task 8 Report: Product Copy, Authority Docs, and Full Offline Gate

## Status

Completed the current source-candidate copy and documentation alignment, the hazardous-fixture audit, the normal 101-check offline gate, and the installer `StageOnly` boundary on 2026-08-23. The verified tree was based on HEAD `9fcd4c7ee423709632f581341bb0153a57bd396b` plus the Task 8 working-tree changes; no Task 8 commit SHA was invented before commit.

This result is not a release or real-platform acceptance. No installer or uninstaller ran, Edge was not started, BOSS was not accessed, real ports 8787/9222 were not probed, and no message, communication, application, push, merge, or publication occurred.

## Product Copy and Current Documentation

- Ordinary product paths now use “RoleFlow 专用 Edge（推荐）”.
- The explicit advanced path now uses “使用当前 Edge（高级，需要浏览器连接组件）”.
- The remaining `Portable Edge CDP` and `CDP URL` matches are the three developer diagnostic lines in `scripts/start-portable-edge.ps1`; they are not ordinary product copy.
- `scripts/start-portable-edge.ps1` has no content diff. Its index and working-tree blob are both `bcefebee5536249a29810a45493a331dc0333d88`.
- Current documents distinguish the published v1.0.0 download from this not-yet-released source candidate. Historical `docs/releases/v1.0.0.md` was neither read nor changed.
- The current source candidate defaults to the dedicated Edge and does not require Edge Control. Edge Control remains an explicit advanced dependency and is excluded from ordinary distribution.
- The first dedicated-Edge login is stored under `%LOCALAPPDATA%\RoleFlow\BrowserProfile` and survives upgrades or install-root changes. Only browser login data has that stable location; databases, resumes, model settings, logs, and reports do not silently migrate between install roots.
- Startup may guide the foreground once when the user runs the workspace helper without `-NoOpen`. Scanning, JD reads, analysis, message discovery, communication, polling, retries, and recovery remain background-only.
- The same-window `BOSS-SEARCH` and `BOSS-COMMUNICATION` tabs remain the fixed baseline. Message discovery may use at most one serial `active: false` transient detail tab only when a newly discovered conversation lacks a complete trusted local JD.
- Profile migration remains explicit, copy-only, and source-preserving. Ordinary and silent uninstall retain the stable profile; browser-profile deletion requires a separate confirmation.
- Current test documentation records that startup tests no longer manufacture a fake `msedge.exe`.

## Existing Test and Fixture Migrations

No new prose/source-regex test was added and production behavior was not loosened. During the normal full gate, existing consumers exposed stale expectations from the earlier browser-authority migration. With the main controller's explicit file-by-file approval, Task 8 updated only the affected existing assertions and offline fixtures:

- `tests/browser_readiness_smoke.js`, `tests/dashboard_communication_batch_smoke.js`, `tests/today_dashboard_smoke.js`, and `tests/workflow_dashboard_smoke.js` now expect the two approved user-facing labels.
- `tests/observability_context_smoke.js` now supplies the current fixed-tab contract: numeric search/communication tab IDs, one positive window ID, jobs/chat URLs, at most one active tab, exact pair enumeration, and tab-specific preflight identity.
- `tests/onboarding_smoke.js` and `tests/flow_smoke.js` now start their fixture Dashboard with immutable offline authority: `portable`, port identity `9222`, and an absolute isolated profile path under `.runtime\smoke`. The fixture Dashboard does not connect to or probe port 9222 and does not start Edge.
- No timeout or retry was increased, no test was added or removed, and no production path was weakened to accept an obsolete fixture.

Focused verification included the affected copy smokes, the communication store consumer, `observability_context_smoke`, two consecutive passing runs each of `onboarding_smoke` and `flow_smoke`, Dashboard child-cleanup checks, and `tests/self_check.js`.

## Offline Gate Evidence

Hazard command:

```powershell
$hazards = rg -n 'OutputAssembly|function (edgeCompileSource|compileEdgeStub|startEdgeStub)' tests
```

Observed result: `HAZARD_SCAN_OK: no matches`.

Normal full-suite command:

```powershell
node tests/run_all.js
```

Observed exit code: `0`.

Observed final line:

```text
All 101 offline checks passed.
```

`README.md`, `docs/product_spec.md`, `docs/operations.md`, `docs/PROJECT_HANDOFF.md`, and `docs/NEXT_PHASE.md` were updated to the actual 2026-08-23 result only after that exact line was observed. The authority documents say explicitly that the evidence belongs to the then-current HEAD plus working tree and is not a predeclared Task 8 commit SHA.

## Installer Stage and Repository Hygiene

Final `StageOnly` command succeeded without compiling or running an installer. The unique offline-gate root is:

```text
D:\DevData\RoleFlow-installer\offline-gate-5e2587006b1a43d0832fa3d3dd75b695
```

The staged product is:

```text
D:\DevData\RoleFlow-installer\offline-gate-5e2587006b1a43d0832fa3d3dd75b695\stage\1.0.0
```

An independent scan inspected 3,145 staged entries and returned `FORBIDDEN_STAGE_SCAN_OK`. It found no BrowserProfile/edge-profile, tests, SQLite/WAL/SHM, Key, `.env`, secrets, `.runtime`, reports/logs, or `vendor\edge-control-bridge` content. The parent directory contained exactly one `offline-gate-*` child.

`git diff --check` completed with exit code 0. Its only output was Git's existing LF-to-CRLF working-copy warning. Pre-commit `git status --short` listed only the approved current docs, user-visible copy, and explicitly authorized stale-test-fixture migrations; it did not list `scripts/start-portable-edge.ps1`, `scripts/start-workspace.ps1`, `tests/startup_scripts_smoke.js`, `tests/self_check.js`, or `progress.md`.

## Warnings and Non-acceptance Notes

- The full suite reported that optional Playwright runtime/evaluator checks were unavailable and skipped; their pure strict-gate portions ran, and the registered normal runner still exited 0 with the exact 101-check final line.
- Node printed its existing experimental SQLite warning in multiple smokes. The private full-chain fixture also printed its existing Git default-branch/line-ending diagnostics and a recoverable `fatal: Needed a single revision`; that smoke concluded `offline gates ok`, and the overall normal runner exited 0.
- One focused onboarding run reached the Dashboard but returned a transient `database is locked` at a later resume upload. It left no Dashboard child, did not reproduce in two consecutive focused reruns, and the later full suite passed `onboarding_smoke`.
- The direct child-error diagnosis created ignored `.runtime\smoke\flow-authority-probe.sqlite`. After the worker's precise cleanup attempt was rejected by execution policy, the controller revalidated the exact workspace-relative identity, removed that single file through the file API, and confirmed zero same-prefix remnants. No unrelated file or process was touched.
- The stage directory is intentionally retained on `D:` as offline evidence. No actual installer executable was built or executed.

## Fix Round 1: Expanded User-copy Audit and Final Candidate Record

### Scope and Root Cause

The 2026-08-23 audit searched only `scripts`, `src/dashboard`, and `src/core`. A repository-wide `scripts`/`src` audit on 2026-08-24 found additional user-visible legacy names in the CLI, installed launcher, workspace startup, workflow application, BOSS/CDP adapters, message-discovery recovery copy, and one Dashboard authority error. The implementation behavior, error codes, variables, browser parsing, and authority defaults were already correct; the defect was incomplete copy-audit scope.

The fix changes only user-facing strings and one existing copy assertion:

- Ordinary paths consistently say “RoleFlow 专用 Edge（推荐）”.
- The explicit advanced path consistently says “使用当前 Edge（高级，需要浏览器连接组件）”.
- The CLI invalid-authority message now distinguishes the raw `workspace-tabs` compatibility default from the daily `Start.bat` product default. Its validation condition, raw CLI default arguments, error code, and parsing behavior are unchanged.
- `scripts/launch-installed.ps1`, `scripts/start-workspace.ps1`, `src/core/workspace_tabs.js`, `src/application/workflow/index.js`, `src/adapters/sites/boss.js`, `src/adapters/browser/cdp.js`, `src/dashboard/message_discovery_view.js`, and `src/dashboard/server.js` use the approved product labels in their recovery and identity messages.
- `tests/dashboard_message_discovery_smoke.js` was the only focused test with a stale copy assertion. Its existing assertion was updated to the exact approved dedicated-Edge label; no new prose test, timeout, or behavior change was added.

The final strict audit across all `scripts` and `src` returned:

```text
EXPANDED_COPY_AUDIT_OK: no user-visible legacy labels
```

The three developer diagnostics in `scripts/start-portable-edge.ps1` may still say `Portable Edge CDP` and `CDP URL`; internal `portable`, CDP, and `9222` identifiers also remain intentionally unchanged.

### Focused Verification

- Node syntax — 7 changed JavaScript production files checked, `NODE_SYNTAX_OK files=7`.
- Windows PowerShell 5.1 parser — `scripts/start-workspace.ps1` and `scripts/launch-installed.ps1`, `PS51_PARSE_OK files=2`.
- `node tests/workspace_tabs_smoke.js` — `workspace_tabs_smoke ok`.
- `node tests/workflow_application_smoke.js` — `workflow application smoke passed`.
- `node tests/boss_communication_page_smoke.js` — `boss_communication_page_smoke ok`.
- `node tests/browser_transport_smoke.js` — `browser_transport_smoke ok`.
- `node tests/dashboard_message_discovery_smoke.js` — `dashboard_message_discovery_smoke ok` after the approved existing-assertion migration.
- `node tests/windows_installer_smoke.js` — `windows_installer_smoke ok`.
- `node tests/startup_scripts_smoke.js` — `startup_scripts_smoke ok` under its unchanged timeout.

The first PowerShell parser invocation was itself malformed because the outer shell expanded its variables before Windows PowerShell received the command. It did not parse or execute either target script. The corrected escaped invocation then parsed both files successfully.

### Fresh Full Offline Gate

The hazardous-fixture audit again found no `OutputAssembly`, `edgeCompileSource`, `compileEdgeStub`, or `startEdgeStub` match:

```text
HAZARD_SCAN_OK: no matches
```

On 2026-08-24, from HEAD `e5916ce56eb4d0f88fbbcdf1a1fa8494f68d5da2` plus the fix-round working tree, the normal command `node tests/run_all.js` exited 0. Its exact final line was:

```text
All 101 offline checks passed.
```

`docs/PROJECT_HANDOFF.md` and `docs/NEXT_PHASE.md` now record that actual date, base HEAD, working-tree basis, command, exit status, count, and final line. They do not invent the not-yet-created fix commit SHA. `NEXT_PHASE.md` also records the completed original Task 8 StageOnly, 3,145-entry forbidden scan, hygiene checks, and intermediate candidate commit `e5916ce56eb4d0f88fbbcdf1a1fa8494f68d5da2`; it states explicitly that Task 9 must read the true candidate source SHA from the clean post-fix HEAD.

### Fresh Installer Stage and Hygiene

The fix-round `StageOnly` command succeeded without compiling or running an installer. Its unique root and stage are:

```text
D:\DevData\RoleFlow-installer\offline-gate-fix-aa6e82be310344cab73b84b1291bf214
D:\DevData\RoleFlow-installer\offline-gate-fix-aa6e82be310344cab73b84b1291bf214\stage\1.0.0
```

The independent scan returned `FORBIDDEN_STAGE_SCAN_OK entries=3145`; there was exactly one `offline-gate-fix-*` directory. The stage contains no profile, test, SQLite/WAL/SHM, Key, `.env`, secret, `.runtime`, report/log, or Edge Control bridge content.

Residual inspection returned:

```text
DASHBOARD_CHILD_REMNANTS=0
FLOW_AUTHORITY_PROBE_REMNANTS=0
STARTUP_SMOKE_DIR_REMNANTS=0
REPO_INSTALL_SELF_CHECK_LOG=0
```

`git diff --check` exited 0 with only the existing LF-to-CRLF warnings, and the working-tree status contained only the approved fix-round documents, user-copy files, and the one migrated existing assertion. The full runner repeated its existing optional Playwright skips, Node experimental SQLite warnings, and private-fixture Git diagnostics, then completed all 101 registered offline checks.

No Edge or BOSS session was started or inspected, no real 8787/9222 listener was probed, no installer or uninstaller ran, and no external write, push, merge, or publication occurred.

## Fix Round 2: Dedicated Edge Entry-point Clarification

### Copy and Encoding Correction

The raw `workspace-tabs` CLI and the daily installed entry point have different defaults. The CLI keeps its existing compatibility default when `--browser` is omitted: `edge`, the explicit advanced current-Edge path. The daily `Start.bat` product path continues to pass the dedicated browser authority and therefore defaults to “RoleFlow 专用 Edge（推荐）”. The invalid-authority message now states both facts and that `portable` accepts only port `9222`; no parser, default, validation condition, error code, or behavior changed.

The direct successful-start output in `scripts/start-portable-edge.ps1` now says “RoleFlow 专用 Edge（推荐）已就绪”. The file was changed with `apply_patch` first and then mechanically prefixed with the UTF-8 BOM required by Windows PowerShell 5.1. Byte-level verification showed:

```text
BOM=EF BB BF
RESTORED_FILTERED_HASH=bcefebee5536249a29810a45493a331dc0333d88
HEAD_BLOB_HASH=bcefebee5536249a29810a45493a331dc0333d88
CRLF_BEFORE_AFTER=40/40
LF_BEFORE_AFTER=51/51
TARGET_OCCURRENCES=1
```

The broad `scripts`/`src` legacy-label audit returned `COPY_AUDIT_LEGACY_MATCHES=0`. The three allowed developer diagnostics containing `Portable Edge CDP` or `CDP URL` remain unchanged. `git diff` shows only the BOM and the intended direct output in that script; startup guidance and the sole allowed startup `Page.bringToFront` route were not moved or removed.

### Focused and Full Verification

- `node --check src/cli.js` — exit 0.
- Windows PowerShell 5.1 static parser — `PS51_PARSE_OK` for `scripts/start-portable-edge.ps1` and `scripts/start-workspace.ps1`.
- `node tests/workspace_tabs_smoke.js` — `workspace_tabs_smoke ok`; this retains the raw omitted-`--browser` `edge` assertion and the explicit `portable/9222` assertion.
- `node tests/startup_scripts_smoke.js` — `startup_scripts_smoke ok` under its unchanged timeout.
- `node tests/windows_installer_smoke.js` — `windows_installer_smoke ok`.
- The hazardous test-fixture scan returned `HAZARD_TEST_FIXTURE_MATCHES=0` for `OutputAssembly`, `edgeCompileSource`, `compileEdgeStub`, and `startEdgeStub`.

On 2026-08-24, from HEAD `f384896227948926f9e3af515804ce8df9e04ab3` plus the fix-round-2 working tree, the normal command `node tests/run_all.js` exited 0. Its exact final line was:

```text
All 101 offline checks passed.
```

`docs/PROJECT_HANDOFF.md` and `docs/NEXT_PHASE.md` record this actual base HEAD and working-tree basis; they do not invent the not-yet-created fix-round-2 commit SHA.

### Fresh Fix-round-2 Installer Stage

The unique `StageOnly` command completed without compiling or running an installer:

```text
D:\DevData\RoleFlow-installer\offline-gate-fix2-8bfec9db83ae4a13b1341c53f644a563
D:\DevData\RoleFlow-installer\offline-gate-fix2-8bfec9db83ae4a13b1341c53f644a563\stage\1.0.0
```

The staged tree contains 3,145 entries and the independent forbidden-content scan returned `FORBIDDEN_STAGE_SCAN_OK entries=3145`. There was exactly one `offline-gate-fix2-*` directory. No browser profile, edge-profile, test tree, SQLite/WAL/SHM data, profile Key, environment file, secret artifact, runtime/report/log artifact, or Edge Control bridge was staged.

The first residual check found one ignored startup-smoke directory created on 2026-08-23, before this fix-round-2 run. The worker's removal attempt was rejected by execution policy without changing it. The controller then revalidated the exact workspace parent, ordinary-directory type, leaf name, and absence of reparse points before removing only that test artifact. The final residual check returned:

```text
DASHBOARD_CHILD_REMNANTS=0
FLOW_AUTHORITY_PROBE_REMNANTS=0
STARTUP_SMOKE_DIR_REMNANTS=0
REPO_INSTALL_SELF_CHECK_LOG=0
```

`git diff --check` exited 0 with only the existing LF-to-CRLF working-copy warnings. Before staging, `git status --short` contained exactly the five approved fix-round-2 files: this report, `docs/PROJECT_HANDOFF.md`, `docs/NEXT_PHASE.md`, `scripts/start-portable-edge.ps1`, and `src/cli.js`. No test, behavior implementation, `progress.md`, or unrelated file was changed.

No Edge or BOSS session was started or inspected, no real 8787/9222 listener was probed, no installer or uninstaller ran, and no external write, push, merge, or publication occurred.
