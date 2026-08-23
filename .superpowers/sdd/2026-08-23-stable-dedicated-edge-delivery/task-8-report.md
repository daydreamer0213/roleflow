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
