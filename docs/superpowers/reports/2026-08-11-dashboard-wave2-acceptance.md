# RoleFlow Wave 2.4 dashboard acceptance evidence

## Current status

Wave 2.4 has been implemented, regression-tested, and evaluated locally at code commit `901a508c15ff78c8b1657b3d30ba0d3d779bca2e`. It is **not accepted yet**: this report is the strict, reproducible evidence package for the independent review.

The run was offline and local-only. It used temporary SQLite data, `forceMock`, a mocked ready browser probe, and headless Edge. It did not open a real BOSS page, call a model, parse a real resume, resume a workflow, start communication, discard a batch, or send anything.

Communication remains `e2e_pending`. The review page preserves these facts: implementation is `implemented`, calibration is `calibrated`, E2E acceptance is `e2e_pending`, and the technical execution gate is enabled. `开始沟通` remains the sole solid teal primary; `安全撤回` remains a red-outline secondary. No execution behavior changed.

## Code checkpoints

- `3c3e3b9d17a2cfa4dbdaf6fdb6606f031687d5e3` — strict evaluator, shared legacy-page frame wrapper, shell/communication tests.
- `28af7010c9cdc27eca266aeed5e7ebaccc835d9a` — excludes compact choice controls from standalone touch targets.
- `18c83ea81f25f45d835c6c724e803214f5015dcf` — keeps Jobs filters inside the shared-shell width.
- `e2db6f1296efa78d68d3a462ab233d6e27ca7572` — makes the existing Onboarding primary visible in the first viewport without changing its form contract.
- `901a508c15ff78c8b1657b3d30ba0d3d779bca2e` — audits keyboard focus on read-only pages through the primary navigation.

## Canonical evidence

Directory: [evidence/2026-08-11-dashboard-wave2-acceptance](evidence/2026-08-11-dashboard-wave2-acceptance/)

- Exactly 33 files: 32 PNG screenshots and one valid UTF-8 `current.json` manifest.
- Eight route/state samples × four viewports (1440×900, 1024×768, 768×1024, 375×812).
- The strict run started on clean revision `901a508…`; its manifest records `strict: true`, `targetCleanAtStart: true`, 32/32 shared frames, 32/32 single primary navs, zero horizontal overflow, and zero console/page/request/external errors.
- For every page the JSON order is `scrollTop=0 → screenshot → keyboard-focus → client-only-interaction`; the saved PNG is therefore captured before synthetic focus outlines or interactions.

I inspected Queue, Jobs, Communication, Settings, Onboarding, and Diagnostics at 1440×900 and 375×812. All six show the common rail/topbar shell, one active primary-navigation entry, and no duplicate inner navigation.

## Explicit policies

| Family | Primary policy | Interaction policy |
| --- | --- | --- |
| Today | required | read-only-none |
| Workflow | required | exercised (stop-preview/cancel) |
| Queue | none-expected: several local record actions | exercised (details only) |
| Jobs | none-expected: filters and local record actions | exercised (details only) |
| Communication | required | safety-not-executed |
| Settings | none-expected: save can test a model connection | safety-not-executed |
| Onboarding | required | safety-not-executed |
| Diagnostics | none-expected: read-only log surface | read-only-none |

`none-expected` now fails strict evaluation when a page-level primary marker appears. Required pages must have exactly one visible, first-viewport marker. There is no undeclared-primary auto-pass.

## Touch and accessibility evidence

The strict 44px gate applies to primary-nav links, a defined required primary, and relevant standalone form controls. It deliberately does not claim every action or every inline link is 44px: the manifest separately records **25 undersized inline links** across the 32 screenshots. Compact checkboxes/radios are also excluded from the standalone-action touch gate.

Keyboard focus, reduced motion, heading order, labels, shell geometry, and the safe client-only interactions all passed their strict gates. The default `tests/run_all.js` now remains portable: `dashboard_wave2_acceptance_smoke.js` is pure/synthetic and does not require Playwright, Edge, `NODE_PATH`, or the 32-page browser run. Playwright is lazy-loaded only by the explicit evaluator command below.

## Reproduce

```powershell
$env:NODE_PATH='C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:ROLEFLOW_REQUIRE_PLAYWRIGHT='1'
node scripts/evaluate-dashboard-wave2.js `
  --target-root . `
  --label current `
  --output-dir docs\superpowers\reports\evidence\2026-08-11-dashboard-wave2-acceptance
```

The evaluator rejects unknown arguments including `--no-strict`, a dirty target revision, unavailable Playwright, missing/duplicate shared shell, missing active navigation, undeclared primary policy, invalid primary placement, overflow, touch-gate failures, focus failures, errors, or an invalid artifact set.

## Verification recorded for this round

- Default offline suite without `NODE_PATH`: `All 81 offline checks passed.` in 126.549 seconds.
- Focused pure checks after the final code work: `dashboard_wave2_acceptance_smoke`, `dashboard_shell_smoke`, and `dashboard_communication_batch_smoke` passed.
- Strict explicit evaluator against clean code commit `901a508…`: passed in 30.399 seconds.

The next state change is independent review; a real BOSS or communication E2E acceptance still requires separate explicit approval.
