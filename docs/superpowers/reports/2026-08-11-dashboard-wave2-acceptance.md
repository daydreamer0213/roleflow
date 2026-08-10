# RoleFlow Wave 2.4 dashboard acceptance

## Conclusion

Wave 2.4 local dashboard acceptance is accepted for commit `e10098409329088e0c8e7371a18c2fff57eee772`. This is an offline, local-only result: the evaluation used temporary SQLite data, `forceMock`, mocked browser readiness, and headless Edge. It did not open a real BOSS page, call a model, resume a workflow, start communication, or send anything.

Communication remains `e2e_pending`: the review page now states this plainly while preserving the independently enabled technical gate. A real manual communication E2E acceptance remains outside this task and needs separate approval.

## Status

| Status | Result | Evidence |
| --- | --- | --- |
| implemented | yes | Combined evaluator `scripts/evaluate-dashboard-wave2.js`; legacy-shell CSS; active `/jobs` navigation; communication acceptance facts and destructive hierarchy. Code commits: `7ad3e3e`, `723c5a0`, `e26226b`, `9e08226`, `e6f1c4b`, `e100984`. |
| regression-safe | yes | Focused shell, communication, Today, Workflow and combined Playwright smokes passed; `node tests/run_all.js` ended `All 81 offline checks passed.` |
| evaluated | yes | Canonical evidence contains exactly 32 first-screen PNGs plus one JSON manifest, all generated against clean `e100984…`. |
| accepted | yes, local dashboard only | Every strict gate passed. This does not accept real BOSS login state, manual workflow continuation, real model calls, or communication execution. |

## Canonical evidence

Directory: [evidence/2026-08-11-dashboard-wave2-acceptance](evidence/2026-08-11-dashboard-wave2-acceptance/)

- Exact count: **33 files** = `current.json` + **32 PNG** screenshots.
- Eight route/state samples × four viewports (1440×900, 1024×768, 768×1024, 375×812):

| Family | State | PNG count |
| --- | --- | ---: |
| Today | ready | 4 |
| Workflow | scanning | 4 |
| Queue | primary | 4 |
| Jobs | latest-batch | 4 |
| Communication | confirmed-offline | 4 |
| Settings | default | 4 |
| Onboarding | existing-profile | 4 |
| Diagnostics | empty-log | 4 |

The manifest records per page: route, state, revision, viewport, scroll position, document/body widths, overflow elements, stylesheet/frame/nav/main presence, active navigation, visible actions, defined primary control, keyboard focus outline, reduced-motion state, headings/labels/alerts, console/page/request/external errors, and client-only interactions.

Strict summary from `current.json`:

- `targetRevision`: `e10098409329088e0c8e7371a18c2fff57eee772`
- `targetCleanAtStart`: `true`
- horizontal overflow, missing shell/main/nav, missing active navigation, targets below 44px, invalid defined-primary placement/count, weak keyboard focus, reduced-motion failures, captured errors, failed interactions: **0 / 32** each.
- Communication review: four of four pages report exactly one visible start/resume primary, solid teal primary treatment, and red-outline destructive withdrawal treatment.

I visually inspected the final 375×812 communication review screenshot. It shows `开始沟通` as the only solid teal primary, `安全撤回` as a red outline, and separate implementation/calibration/E2E/technical-gate facts. I also inspected representative desktop/mobile Today, Workflow, queue/jobs, settings, onboarding, and diagnostics screenshots while developing the acceptance.

## Reproduce

```powershell
$env:NODE_PATH='C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:ROLEFLOW_REQUIRE_PLAYWRIGHT='1'
node scripts/evaluate-dashboard-wave2.js `
  --target-root . `
  --label current `
  --output-dir docs\superpowers\reports\evidence\2026-08-11-dashboard-wave2-acceptance
```

The evaluator fails closed when Playwright is unavailable, the target revision is dirty at start, or any required visual/accessibility/network invariant fails.

## Verification run

```powershell
node tests/dashboard_communication_batch_smoke.js
node tests/dashboard_wave2_acceptance_smoke.js
node tests/today_dashboard_smoke.js
$env:NODE_PATH='C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:ROLEFLOW_REQUIRE_PLAYWRIGHT='1'
node tests/workflow_page_migration_smoke.js
node tests/run_all.js
git diff --check 99fe9a52ec842489f0a953bbd2287e3cad046040..HEAD
```

Focused checks passed. The full command completed with `All 81 offline checks passed.` The cumulative `git diff --check` command exited 0.

## Remaining improvements

- Perform the separately approved real manual communication E2E only when an operator explicitly authorizes it; until then the UI must retain `e2e_pending`.
- Legacy page renderers still contain route-local inline CSS. They now share the RoleFlow visual identity, but a future, separately scoped cleanup could move those declarations into the shared stylesheet without changing business behavior.
