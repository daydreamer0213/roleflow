# RoleFlow Wave 4 Acceptance Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Wave 4 live-acceptance defects in recommendation correctness, BOSS communication observability, Edge-backed message discovery, and result-oriented dashboard UX before Wave 5 starts.

**Architecture:** Keep the current CommonJS application/storage/view-model extraction and safety state machines. Separate acquisition policy from recommendation policy, route every dashboard browser consumer through one browser authority, observe sanitized BOSS communication outcomes after the existing at-most-once click, and migrate user-facing pages onto small page/view-model modules rather than expanding `server.js`.

**Tech Stack:** Node.js 22 CommonJS, built-in Node SQLite, server-rendered HTML/CSS/JavaScript, Edge Control adapter, existing smoke-test scripts.

## Global Constraints

- Wave 5 remains stopped.
- Implementation and automated verification must not perform real BOSS communication, send messages, or submit applications.
- Real BOSS read-only inspection is allowed and must use the existing logged-in Edge session.
- Preserve one Edge window, fixed `BOSS-SEARCH` and `BOSS-COMMUNICATION` tabs, serial access, random pacing, cooldowns, checkpoints, and immediate stop signals.
- Do not reduce JD coverage, recall, recommendation quality, matching evidence, or account-safety checks.
- Do not replace the formal four-tier matrix with the shadow scorecard in this plan.
- Do not add a frontend framework or another runtime dependency.
- Use isolated worktrees for parallel lanes. Never let two workers edit the same checkout.
- Treat `src/dashboard/server.js` as a serialized integration file.
- Each behavior fix starts with a focused failing regression and ends with the focused tests plus `npm.cmd test`.

---

## Stage 0: Baseline and dispatch

### Task 0: Freeze the remediation baseline

**Files:**

- Read: `docs/superpowers/reports/2026-08-11-wave-0-4-live-manual-acceptance-addendum.md`
- Read: `docs/superpowers/specs/2026-08-11-wave4-acceptance-remediation-ledger-design.md`
- Create during implementation: one controller-owned remediation status report under `docs/superpowers/reports/`

- [ ] Record the starting `main` commit, test status, current database backup reference, and the 104-job evaluation batch identifiers.
- [ ] Confirm the current working tree contains no unowned source changes.
- [ ] Create one annotated pre-remediation checkpoint tag.
- [ ] Create three isolated first-stage worktrees:
  - Lane A: recommendation policy.
  - Lane B: communication safety and observability.
  - Lane C: message browser authority.
- [ ] Give every worker the issue IDs, exact file ownership, focused tests, “fast mode” permission, no-real-write boundary, and required final evidence.

Expected: three non-overlapping branches are ready; no product file has changed in the controller checkout.

---

## Stage 1: Gate A — correctness and external-action safety

### Task 1: Separate acquisition policy from recommendation policy

**Lane:** A
**Issues:** RF-A01

**Files:**

- Modify: `src/core/platform_runtime_policy.js`
- Modify only if required by the new contract: `src/cli.js`
- Modify only if required by the new contract: `src/core/scoring.js`
- Modify only if required by snapshot compatibility: `src/core/scan_snapshot.js`
- Test: `tests/inherited_search_scope_smoke.js`
- Test: `tests/screening_quality_smoke.js`
- Test: `tests/analysis_revision_smoke.js`

**Required contract:**

- Platform inheritance may set acquisition mode, platform policy, search template inputs, platform city scope and display metadata.
- It must preserve the confirmed Search Plan, target policy, scoring risk rules, exclusions, activity policy, schedule preferences and recommendation salary boundary.
- `analysisContext` and analysis revision must derive from the preserved recommendation policy.
- Acquisition and recommendation policy hashes remain separately observable.

- [ ] Add a regression fixture with Search Plan salary 9–14K and inherited BOSS salary 5–10K.
- [ ] Assert the inherited acquisition metadata remains 5–10K while recommendation scoring remains strict 9–14K.
- [ ] Assert risk rules, exclusion words, BOSS activity and work-schedule preferences survive policy application.
- [ ] Run the focused tests and verify they fail on the current implementation.
- [ ] Make the smallest contract change that prevents acquisition fields from overwriting recommendation fields.
- [ ] Preserve frozen inherited scan/resume compatibility and platform boundary diagnostics.
- [ ] Run:

```powershell
node tests/inherited_search_scope_smoke.js
node tests/screening_quality_smoke.js
node tests/analysis_revision_smoke.js
```

- [ ] Run `npm.cmd test`.
- [ ] Produce a machine-readable replay of the 104-job batch without writing formal results; verify the six known salary boundary cases would no longer enter `primary/apply/caution`.
- [ ] Commit only Lane A files.

Acceptance: no strict boundary violation can be introduced by inherited platform filters; acquisition recall remains unchanged.

### Task 2: Observe sanitized BOSS communication outcomes

**Lane:** B
**Issues:** RF-A02, RF-A05

**Files:**

- Modify: `src/adapters/sites/boss.js`
- Modify: `src/core/communication_executor.js`
- Modify only if evidence schema requires it: `src/storage/communication_store.js`
- Modify only if public result mapping requires it: `src/application/communication/index.js`
- Test: `tests/boss_communication_page_smoke.js`
- Test: `tests/communication_executor_smoke.js`
- Test: `tests/communication_store_contract_smoke.js`
- Test: `tests/communication_application_smoke.js`

**Required result vocabulary:**

- `succeeded`
- `platform_rejected`
- `transport_failed`
- `ambiguous`

Existing terminal states such as `already_communicated`, `job_unavailable`, `target_mismatch`, `action_unavailable`, and `stopped` remain compatible.

**Sanitized evidence may contain:**

- endpoint kind: `chat_config` or `friend_add`
- HTTP status
- sanitized business code/category
- elapsed milliseconds
- observed page/result state

It must never contain URLs with query values, `securityId`, chat identity parameters, cookies, headers, request body, complete response body, or personal message content.

- [ ] Add adapter tests for friend-add success, HTTP failure, network rejection, non-zero BOSS business result, timeout and no matching request.
- [ ] Assert sensitive tokens present in fixtures never appear in returned evidence, logs or persisted JSON.
- [ ] Add executor tests proving one item still receives at most one click and no failed/ambiguous result triggers a second dispatch.
- [ ] Add a fixed-tab readiness test that requires stable login and target identity before dispatch; timeout must stop before click.
- [ ] Run focused tests and verify failure on the current implementation.
- [ ] Register a one-shot, endpoint-filtered observer immediately before the guarded click.
- [ ] Keep the already-proven DOM `.click()` path; do not switch input mechanisms without new evidence.
- [ ] Combine observed request result with existing page/message verification.
- [ ] Map explicit failures to `platform_rejected` or `transport_failed`; keep uncertain or conflicting evidence as `ambiguous`.
- [ ] Persist only sanitized evidence and a user-readable reason.
- [ ] Run:

```powershell
node tests/boss_communication_page_smoke.js
node tests/communication_executor_smoke.js
node tests/communication_store_contract_smoke.js
node tests/communication_application_smoke.js
```

- [ ] Run `npm.cmd test`.
- [ ] Commit only Lane B files.

Acceptance: every injected result is explainable, sensitive values are absent, and at-most-once behavior remains intact.

### Task 3: Make ambiguous recovery safe and truthful

**Lane:** B, after Task 2
**Issues:** RF-A04

**Files:**

- Modify: `src/application/communication/index.js`
- Modify: `src/dashboard/view_models/workflow.js`
- Modify: `src/dashboard/pages/workflow.js`
- Modify only for current legacy review page: `src/dashboard/server.js`
- Test: `tests/dashboard_communication_batch_smoke.js`
- Test: `tests/workflow_communication_smoke.js`
- Test: `tests/workflow_dashboard_smoke.js`

- [ ] Add a batch fixture with `batch=interrupted` and one `item=ambiguous`.
- [ ] Assert neither workflow page nor communication review renders a start/resume form.
- [ ] Assert the primary action is “处理不明确结果” and links to the exact item review.
- [ ] Assert the backend continues to reject resume until every ambiguous item has a manual resolution with evidence.
- [ ] Run focused tests and verify the current UI assertion fails.
- [ ] Derive execution action from both batch status and item summary, not batch status alone.
- [ ] Preserve manual resolution choices and no-repeat-click storage constraints.
- [ ] Run:

```powershell
node tests/dashboard_communication_batch_smoke.js
node tests/workflow_communication_smoke.js
node tests/workflow_dashboard_smoke.js
```

- [ ] Run `npm.cmd test`.
- [ ] Commit the Lane B follow-up.

Acceptance: no UI path can suggest or submit resume while unresolved ambiguity exists.

### Task 4: Route message discovery through the dashboard browser authority

**Lane:** C
**Issues:** RF-A03

**Files:**

- Modify: `src/dashboard/message_discovery_controller.js`
- Modify: `src/dashboard/server.js`
- Reuse: `src/adapters/browser/edge_control.js`
- Reuse: `src/adapters/sites/boss_message_reader.js`
- Test: `tests/dashboard_message_discovery_smoke.js`
- Test: `tests/boss_message_reader_smoke.js`

**Required contract:**

- `createMessageDiscoveryController` receives a browser authority/factory from the dashboard composition root.
- Default dashboard mode is Edge Control.
- Portable/CDP is used only when explicitly requested and validated.
- Controller cleanup must not close the user's ordinary Edge browser or destroy fixed tabs.
- Reader remains strictly read-only.

- [ ] Add a dashboard composition test that captures the browser factory used by message discovery and expects Edge mode.
- [ ] Add a test proving the controller no longer constructs port 9222 internally.
- [ ] Keep existing fake reader/controller lifecycle, lease, stop, risk and draft tests.
- [ ] Run focused tests and verify the factory assertion fails.
- [ ] Inject the existing `createDashboardBrowser` authority into the controller.
- [ ] Make cleanup follow adapter ownership: disconnect/cleanup project resources without closing the user browser.
- [ ] Run:

```powershell
node tests/dashboard_message_discovery_smoke.js
node tests/boss_message_reader_smoke.js
```

- [ ] Run `npm.cmd test`.
- [ ] Commit only Lane C files.

Acceptance: the Dashboard product route reaches the same Edge-backed reader that already passed real read-only verification.

### Task 4A: Retain unmatched message-discovery items without blocking later work

**Lane:** C2, after Task 4
**Issues:** RF-A06
**Design:** `docs/superpowers/specs/2026-08-11-message-discovery-unmatched-retention-design.md`

**Files:**

- Modify: `src/core/storage.js`
- Modify: `src/core/message_preview_state.js`
- Modify: `src/core/message_discovery.js`
- Modify: `src/dashboard/message_discovery_controller.js`
- Modify: `src/dashboard/message_discovery_view.js` only for truthful unresolved count/reason
- Test: `tests/storage_migration_smoke.js`
- Test: `tests/message_preview_state_smoke.js`
- Test: `tests/message_discovery_smoke.js`
- Test: `tests/dashboard_message_discovery_smoke.js`

- [ ] Add a transactional forward migration for sanitized unresolved message-discovery items.
- [ ] Add a two-item regression where an unmatched first item does not block a valid second item.
- [ ] Persist only digests, reason code and timestamps; never persist message text or recruiter identity.
- [ ] Requeue a durable unresolved row even when it is no longer unread.
- [ ] Clear the unresolved marker only after successful processing.
- [ ] Keep risk control, page loss, target drift, lease loss and stop as whole-run terminal conditions.
- [ ] Return truthful `processed` and `unresolved` counts.
- [ ] Run focused tests and `npm.cmd test`.

Acceptance: strict identity validation remains unchanged, later valid items continue, and an opened unmatched message cannot be silently absorbed into the next baseline.

### Task 5: Integrate and verify Gate A

**Owner:** controller

- [ ] Review each branch diff for issue scope, sensitive-data leaks and safety-boundary changes.
- [ ] Merge Lane A, run `npm.cmd test`.
- [ ] Merge Lane B Tasks 2–3, resolve only controller-owned integration conflicts, run `npm.cmd test`.
- [ ] Merge Lane C, run `npm.cmd test`.
- [ ] Run `git diff --check` against the pre-remediation checkpoint.
- [ ] Perform real Edge read-only message discovery from `/messages`; verify target identity and that no editor is filled.
- [ ] Do not perform a real communication click. Validate communication failure states using offline injection.
- [ ] Update the remediation status report with evidence and remaining Gate B blockers.

Gate A passes only when Tasks 1–4A and the real read-only message product path pass.

---

## Stage 2: Gate B — result-oriented dashboard

### Task 6: Simplify workflow information architecture

**Lane:** D
**Issues:** RF-B01, RF-B04, RF-B07, RF-B10, RF-B11

**Files:**

- Modify: `src/dashboard/view_models/workflow.js`
- Modify: `src/dashboard/pages/workflow.js`
- Modify: `src/dashboard/workflow_health_view.js`
- Modify: `src/dashboard/ui/shell.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Modify only for data composition: `src/dashboard/server.js`
- Test: `tests/workflow_dashboard_smoke.js`
- Test: `tests/dashboard_shell_smoke.js`
- Test: `tests/dashboard_wave2_acceptance_smoke.js`
- Test: `tests/workflow_health_smoke.js`

**Primary workflow view fields:**

- current phase
- overall progress
- usable recommendations
- remaining work
- estimated continuation time
- blocking/pause reason
- one primary next action

- [ ] Add semantic HTML assertions for the seven primary fields and a collapsed technical-details section.
- [ ] Assert job-title activity streams, raw unresolved parameter names and historical/global counts do not appear in the primary region.
- [ ] Assert `multiBusinessDistrict` remains available only in diagnostics data.
- [ ] Assert the rail label has no 180-degree transform.
- [ ] Assert active cooldown includes reason, retry time and a progressing countdown hook.
- [ ] Run focused tests and verify failures.
- [ ] Reduce the workflow view model to current-run product fields; keep detailed health data behind `<details>`.
- [ ] Map recognized work-region data to Chinese labels and keep unknown raw keys out of user-facing summaries.
- [ ] Fix rail orientation with the smallest CSS change.
- [ ] Run:

```powershell
node tests/workflow_dashboard_smoke.js
node tests/dashboard_shell_smoke.js
node tests/dashboard_wave2_acceptance_smoke.js
node tests/workflow_health_smoke.js
```

- [ ] Capture Edge screenshots at 1440×900, 1024×768, 768×1024 and 375×812 for active, cooldown, blocked and review-required states.
- [ ] Run `npm.cmd test`.

Acceptance: a user can identify result, progress, blocker and next action without opening technical details.

### Task 7: Build the automatic communication center

**Lane:** E, after Gate A Lane B
**Issues:** RF-B02, RF-B08, RF-B09

**Files:**

- Add: `src/dashboard/pages/communication.js`
- Add: `src/dashboard/view_models/communication.js`
- Modify: `src/dashboard/ui/shell.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Modify for route composition only: `src/dashboard/server.js`
- Test: `tests/dashboard_communication_batch_smoke.js`
- Test: `tests/dashboard_shell_smoke.js`

**Required states:**

- pending review
- running
- needs resolution
- completed
- history

- [ ] Add view-model tests for each state.
- [ ] Require salary, location, recommendation tier, key evidence, risks and action explanation on pending review.
- [ ] Separate “安全操作额度” from “成功沟通数”.
- [ ] Put ambiguous items first and remove start/resume while unresolved.
- [ ] Add an “自动沟通” primary-navigation entry without bypassing immutable batch confirmation.
- [ ] Move legacy rendering out of `server.js`; keep route handlers and storage contracts unchanged.
- [ ] Verify desktop, keyboard and narrow-screen behavior in Edge.
- [ ] Run focused tests and `npm.cmd test`.

Acceptance: the complete current batch lifecycle is discoverable and understandable without weakening any execution gate.

### Task 8: Unify the message discovery product page

**Lane:** F, after Gate A Lane C
**Issues:** RF-B03

**Files:**

- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `src/dashboard/ui/shell.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Modify for route composition only: `src/dashboard/server.js`
- Test: `tests/dashboard_message_discovery_smoke.js`
- Test: `tests/dashboard_shell_smoke.js`

- [ ] Add explicit Chinese mappings and recovery actions for disconnected browser, login required, risk control, lease busy/lost, model not ready and generic failure.
- [ ] Make start/stop/dismiss forms process the POST response before refreshing.
- [ ] Keep the current page state visible during request and show the returned error in place.
- [ ] Add the message center to unified navigation.
- [ ] Keep every generated draft read-only and keep manual copy/send confirmation unchanged.
- [ ] Run focused tests and `npm.cmd test`.
- [ ] Re-run real Edge read-only discovery and capture the completed product page.

Acceptance: product-level failure and success are both visible without consulting raw diagnostics.

### Task 9: Apply default privacy masking

**Lane:** G
**Issues:** RF-B06

**Files:**

- Modify: `src/core/resume_privacy.js`
- Modify only where raw diagnostics are rendered: relevant dashboard view/page module
- Test: `tests/resume_privacy_smoke.js`
- Test: nearest dashboard page smoke test

- [ ] Add fixtures for Chinese mobile numbers, email addresses and address-like contact lines.
- [ ] Assert default diagnostics and logs contain masked values.
- [ ] Preserve explicit source-file viewing behind the existing local-file action; do not copy raw contacts into logs or page metadata.
- [ ] Run focused tests and `npm.cmd test`.

Acceptance: ordinary pages and logs never expose complete contact information.

### Task 10: Integrate and verify Gate B

**Owner:** controller

- [ ] Merge Lane D first and run the full suite.
- [ ] Merge Lane E and Lane F serially because both touch shell/server routing.
- [ ] Merge Lane G and run the full suite.
- [ ] Run accessibility smoke checks and Edge screenshot review at all required viewport sizes.
- [ ] Walk the complete local flow: onboarding → plan → workflow → queue → automatic communication review → message discovery.
- [ ] Record every remaining issue; do not silently defer an acceptance failure.

---

## Stage 3: Gate C — performance and consistency

### Task 11: Establish a lightweight dashboard progress read model

**Issues:** RF-B05

**Files:**

- Modify: `src/core/workflow_progress.js`
- Modify only if storage support is required: `src/storage/workflow_store.js`
- Modify: `src/dashboard/server.js`
- Test: `tests/workflow_progress_smoke.js`
- Test: `tests/workflow_dashboard_smoke.js`
- Add or extend a deterministic dashboard latency benchmark script

- [ ] Instrument current test fixtures to count SQL statements and synchronous computations for workflow status/page requests.
- [ ] Set a deterministic fixture threshold before implementation; do not use wall-clock-only assertions in default tests.
- [ ] Move historical/global analytics and detailed health calculations out of the primary progress request.
- [ ] Reuse persisted progress revisions and current workflow identifiers instead of recomputing the entire history.
- [ ] Keep the detailed technical view available on demand.
- [ ] Run focused tests, benchmark, and `npm.cmd test`.
- [ ] Measure the real local dashboard during a controlled offline analysis load.

Acceptance: progress/status remains responsive during analysis and the primary query cost is bounded by current-run data.

### Task 12: Finish shell consistency and diagnostics triage

**Issues:** RF-C01, RF-C02, RF-C03

**Files:**

- Modify: remaining legacy dashboard page modules
- Modify: `src/dashboard/ui/shell.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Modify diagnostics rendering in `src/dashboard/server.js` or extract `src/dashboard/pages/diagnostics.js`
- Test: `tests/dashboard_shell_smoke.js`
- Test: `tests/dashboard_wave2_acceptance_smoke.js`

- [ ] Inventory duplicate navigation entries and duplicate labels.
- [ ] Remove the repeated “筛选方案” destination and one duplicate “版本名称”.
- [ ] Default diagnostics to abnormal/risk/actionable events; put `http_request_completed` behind advanced filtering.
- [ ] Complete shell migration only for pages in the primary user journey.
- [ ] Do not refactor unrelated CLI/report pages for visual consistency.
- [ ] Run focused tests, full tests and Edge desktop/narrow screenshots.

Acceptance: the primary journey is visually consistent and default diagnostics lead with actionable problems.

---

## Stage 4: Gate D — fresh evaluation

### Task 13: Rebuild the recommendation quality baseline

**Issues:** RF-D01

**Files:**

- Reuse existing evaluation scripts and fixtures.
- Add only missing evaluation output under `docs/superpowers/reports/` and project-external generated data under `D:\DevData` when large.

- [ ] Preserve candidate profiles, resumes, Search Plans and model settings.
- [ ] Create a fresh empty operational job-history baseline.
- [ ] Re-run full JD acquisition without lowering coverage or pacing.
- [ ] Report complete JD rate, detail failures, model contract failure rate, recovery rate, decision distribution and boundary violations.
- [ ] Classify every `MODEL_CONTRACT_INVALID` by field and recovery outcome.
- [ ] Human-label the known six salary boundary cases, known cross-stack promotions and a representative sample from every recommendation tier.
- [ ] Do not use pre-fix history as proof of new precision, recall or stability.

Acceptance: quality metrics are based only on the corrected recommendation policy and fresh data.

### Task 14: Evaluate matrix versus shadow scorecard

**Issues:** RF-D02

**Files:**

- Reuse: `src/core/shadow_scorecard.js`
- Reuse: `scripts/compare-shadow-scorecard.js`
- Reuse/extend: `tests/shadow_scorecard_smoke.js`
- Add: a dated evaluation report under `docs/superpowers/reports/`

- [ ] Replay the same fixed semantic inputs through the formal matrix and shadow scorecard.
- [ ] Keep semantic instability separate from deterministic weight/threshold sensitivity.
- [ ] Compare hard-boundary errors, tier agreement, ranking usefulness, repeated-run stability, evidence coverage and explanation quality.
- [ ] Test reasonable weight/threshold variants offline only.
- [ ] Reject any scorecard policy where points compensate for a hard boundary or insufficient evidence.
- [ ] Produce a recommendation: retain matrix, continue shadow, or design a formal migration.
- [ ] Do not change production recommendation or default communication selection in this task.

Acceptance: the scorecard decision is evidence-based and reproducible, not a literal conversion of the user's initial idea.

### Task 15: Final Wave 4 remediation acceptance

**Owner:** controller

- [ ] Run `git diff --check`.
- [ ] Run every focused regression and `npm.cmd test`.
- [ ] Review the complete branch diff for unauthorized external actions, privacy leaks and quality reductions.
- [ ] Re-run the complete local user flow in Microsoft Edge.
- [ ] Re-run real BOSS read-only message discovery.
- [ ] Do not perform another communication click unless the user gives a new one-click authorization.
- [ ] Update the issue ledger with fixed, accepted, deferred or decision-pending status and evidence links.
- [ ] Produce one final consolidated remediation report.
- [ ] Ask the user to decide DEC-01 separately:
  - `AGPL-3.0-only` for standard open source with network-source reciprocity; or
  - noncommercial/dual licensing if third-party commercial use must be prohibited.
- [ ] Keep Wave 5 stopped until the user reviews the final report.

## Suggested merge order

1. Lane A recommendation policy.
2. Lane B communication observer and ambiguity safety.
3. Lane C message browser authority.
4. Lane D workflow information architecture.
5. Lane E automatic communication center.
6. Lane F message center.
7. Lane G privacy masking.
8. Performance and diagnostics.
9. Fresh evaluation reports.

Every merge receives a pre-merge checkpoint and a post-merge full-suite run. Any failure stops only the affected lane; independent lanes may continue when they do not share files or contracts.
