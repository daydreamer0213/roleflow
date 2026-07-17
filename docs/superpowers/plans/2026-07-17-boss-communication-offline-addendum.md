# BOSS Batch Communication Offline Addendum

**Decision date:** 2026-07-17

This addendum supersedes the page-dependent portions of Tasks 4-8 in
`2026-07-17-boss-batch-communication.md` until the BOSS access restriction has
expired and a real logged-in page can be inspected.

## Why The Boundary Changed

The job detail action, active chat identity, and post-click success state cannot
be specified reliably from invented DOM selectors. Fake-browser tests are useful
for state-machine contracts, but they are not evidence that the production BOSS
page adapter is correct.

## Offline Work Allowed Now

1. Communication batch persistence and idempotency.
2. Shared access budgets and pacing policy.
3. Browser transport primitives for fixed search and communication tabs.
4. A site-agnostic, resumable communication executor tested only with an
   injected fake adapter.
5. Dashboard batch selection, immutable confirmation snapshots, status display,
   pause/stop data controls, and manual ambiguous resolution.
6. Audit logging, documentation, migration tests, and complete offline regression.

## Work Deferred Until Real-Page Evidence Exists

1. BOSS detail/header DOM selectors and action-button discovery.
2. Click-point visibility, coverage, and immediate pre-click target validation.
3. Active chat identity extraction.
4. Post-click BOSS success and ambiguity evidence.
5. Production `communicate` and `inspect-communication` CLI wiring.
6. Dashboard start/resume execution controls.
7. Any real BOSS click.

## Hard Gate

Until calibration is recorded, RoleFlow may create and inspect communication
batches but must not expose an enabled production start/resume action. The gate
must fail closed before a browser page is opened.

## Revised Offline Tasks

### Offline Task A: Generic Resumable Executor

- Create `src/core/communication_executor.js`.
- Consume an injected adapter contract; do not import `BossSiteAdapter`.
- Persist every transition, enforce one dispatch, stop on ambiguity and fatal
  browser/site errors, and test pause/stop/resume with fake adapters.
- Do not add production communication CLI routes.

### Offline Task B: Batch Builder And Review UI

- Add a batch preview page with primary/talk selected by default, backup opt-in,
  and not-recommended rejected server-side.
- Persist confirmed immutable batches and show item/status summaries.
- Keep production start/resume disabled with an explicit calibration-pending
  state; batch creation and manual ambiguous resolution remain available.

### Offline Task C: Engineering Verification

- Document the calibration procedure and required evidence.
- Verify the hard gate occurs before browser creation.
- Run every offline test and an end-to-end local dashboard flow using fake data.

## Live Calibration Exit Criteria

After access is restored, collect a redacted DOM snapshot and screenshots for:

- a ready `立即沟通` job;
- an already-communicated job;
- an unavailable job;
- the post-click detail state;
- the active chat state.

Only then may the BOSS adapter, production CLI, and enabled dashboard execution
controls be implemented and reviewed. A real click still requires explicit user
approval for that calibration attempt.
