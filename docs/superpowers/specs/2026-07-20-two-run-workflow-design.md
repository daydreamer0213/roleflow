# Two-Run Workflow Design

## Goal

Turn RoleFlow into one user-triggered `run once` workflow that a candidate can execute at most twice per China-local calendar day. Each run must acquire jobs, analyze them, present a reviewable communication list, execute only the user-confirmed list, persist the outcome, and then stop completely.

## Confirmed Product Model

- There are no morning and afternoon modes. Both daily runs execute the same algorithm.
- The user starts each run manually. RoleFlow does not wait in the background, schedule the second run, or keep a browser worker alive after a phase finishes.
- The default daily successful-communication target is 70.
- At most two workflow run slots exist per candidate profile and local day. An interrupted slot is resumed instead of creating a third slot.
- The run target is `min(40, ceil(remainingDailyTarget / remainingRunSlots))`.
- A first run starts at 35 when the daily target is 70. If it succeeds for 30 jobs, the second run targets 40; if it succeeds for 38, the second targets 32.
- Both runs share the existing daily BOSS access budgets. A run receives a fair share of the remaining card and detail budget so the first run cannot consume the second run's allocation.
- Target counts are goals, not guarantees. RoleFlow reports supply shortfalls instead of checking high-salary or clearly mismatched jobs to fill a number.

## Run Lifecycle

`created -> scanning -> analyzing -> review_required -> communicating -> completed`

`interrupted`, `failed`, and `stopped` are terminal or resumable states with explicit error evidence. A run in `review_required` has no active browser or child scan process; the user may close RoleFlow and return later.

Every run persists:

- profile, plan, China-local day, and sequence number 1 or 2;
- target success count and daily progress at creation;
- reserved card/detail/navigation budgets and selected keywords;
- linked scan run, scan batch, and communication batch identifiers;
- phase status, timestamps, stop code, and stop message;
- cards collected, details read/reused/pending, model analysis counts, candidate counts, selected count, and communication outcomes.

## Candidate Inventory

A job is usable inventory only when all of these are true:

- no candidate application status exists;
- the source is a valid BOSS job URL;
- the latest activity evidence is at most three days old;
- required details are present;
- semantic analysis is current and complete enough for a decision;
- the decision bucket is `primary`, `talk`, or an explicitly eligible low-risk backup;
- no previous communication outcome proves the job unavailable or unsafe to retry.

An eligible low-risk backup has core target salary and an experience-overlap reason, but no `salary_target_high`, `senior_engineering_heavy`, `core_stack_mismatch`, inactive, missing-detail, or hard-blocker tag.

Communication terminal outcomes update candidate inventory:

- `succeeded` and `already_communicated` -> `applied`;
- `job_unavailable` -> `invalid` and excluded from later runs;
- `target_mismatch` -> `review` and excluded from automatic selection;
- `action_unavailable` -> `later` with a retry date, excluded until due;
- `ambiguous` remains blocked until manual resolution.

The existing eight `job_unavailable` items must be migrated into invalid candidate state so they no longer inflate backlog counts.

## Target and Budget Planning

Before browser access, the planner calculates:

1. successful communications already recorded for the local day;
2. remaining run slots;
3. the run target;
4. valid fresh inventory available now;
5. the number of new candidates needed;
6. the fair share of remaining daily access budgets;
7. keyword order and per-keyword card/detail allocation.

The first implementation uses measured keyword yield only for ordering and budget prediction. Recommendation rules do not self-modify from feedback.

When enough valid inventory already exists, the run may skip scanning and enter `review_required`. When projected supply is below target, the run still executes within its budget and records a shortfall reason.

## Keyword Scheduling

- The scheduler consumes the active Search Plan keywords and their A/B priority.
- It prefers keywords not used by an earlier completed run on the same local day.
- Within unused keywords, it sorts by rolling low-risk yield after a minimum sample threshold, then by configured priority and plan order.
- It balances known high-yield keywords across the two available run slots instead of assigning time-based keyword groups.
- Reusing a same-day keyword is allowed only when unused keywords are exhausted and the run still has both target gap and access budget.
- Exact BOSS job identity remains deduplicated by `source + source_id`; same-company/title/location reposts remain visible as weak duplicates but are unchecked after a recent applied record.

## Scan and Analysis Integration

The workflow coordinator reuses the existing BOSS adapter, scan lease, checkpoint, detail cache, model analyzer, and report storage. It passes a selected keyword subset and run-specific card/detail limits into the existing scan CLI.

Browser acquisition remains single-tab and serial. No parallel tabs, fingerprint spoofing, mouse-trajectory simulation, automatic risk-control retries, or background waiting are added. Model analysis runs locally after browser acquisition using the existing bounded concurrency.

## Review and Communication

The review page is scoped to one workflow run, not the entire historical pool.

- Primary, talk, and eligible low-risk backup jobs are checked by default.
- High-salary and other backups remain visible but unchecked.
- The user may uncheck any job before confirming.
- The list may include at most five checked replacement candidates above the success target.
- The communication executor processes the confirmed list serially and stops after reaching the run success target or exhausting selected candidates.
- When the success target is reached, unvisited replacements are marked `stopped` inside that communication batch with zero click attempts and no candidate outcome. They remain pending inventory for the next run.

The run completes only after every communication-batch item is terminal. Dispatched items must have reconciled candidate states; unvisited `stopped` replacements must not write a candidate outcome.

## Dashboard

The main path shows:

- today's successful progress, for example `27 / 70`;
- completed or active run slots, for example `1 / 2`;
- one primary command: `Start new run` or `Resume run`;
- the next run target, valid inventory, estimated new scan requirement, and remaining BOSS budgets;
- the latest run phase and concise diagnostics.

Existing daily, broad, detail-refresh, and activity-probe controls remain available under an advanced operations section. They are not the primary product workflow.

## Error and Recovery Behavior

- Starting a third run for the same profile and local day fails with a stable error code.
- Starting while another run or BOSS scan lease is active fails closed.
- A process restart reconstructs the active run from persisted workflow, scan, and communication state.
- Login loss, risk control, page drift, model failure, or communication ambiguity preserves the run phase and evidence.
- No automatic retry performs additional BOSS access. The user explicitly resumes the same run.
- Logs include `workflowRunId`, `scanRunId`, `scanBatchId`, and `communicationBatchId` when available.

## Scope

### Included

- Workflow-run persistence and lifecycle.
- Two-run daily target and fair-share budget planning.
- Keyword scheduling and yield metrics.
- Unified candidate eligibility and communication-outcome reconciliation.
- Run-scoped review and target-aware communication execution.
- Dashboard entry, progress, resume, logs, migrations, and offline tests.
- A low-volume real validation checklist that does not perform a full production scan automatically.

### Excluded

- Background scheduling or an all-day worker.
- A third automatic supplemental run.
- New recruitment platforms in this implementation.
- Self-modifying match rules.
- Anti-detection or platform-control bypass features.
- A promise that BOSS alone supplies 60-80 suitable unique jobs every day.

## Acceptance Criteria

- The same `start run` operation creates sequence 1 and sequence 2 regardless of clock time.
- A 70 target produces run targets 35/35 when the first run succeeds for 35, 35/40 when it succeeds for 30, and 35/32 when it succeeds for 38.
- A third same-day run is rejected; interrupted work resumes its existing slot.
- The first run cannot reserve more than its fair share of remaining daily card/detail budgets.
- Applied, invalid, future-later, ambiguous, stale-activity, incomplete-detail, and stale-analysis jobs are absent from automatic inventory.
- Existing `job_unavailable` communication items no longer appear as pending inventory after migration.
- Same-day keyword ordering prefers unused keywords and uses yield only as a scheduling signal.
- A completed scan transitions its workflow run to `review_required` without a background browser process.
- Review defaults include eligible low-risk backups but exclude high-salary backups.
- Communication stops at the success target, reconciles every terminal outcome, and leaves unvisited replacements available.
- Restarting the dashboard preserves and can resume the active workflow run.
- Focused tests pass after each task; the final 33-test baseline plus new workflow tests pass once before merge.
- No real BOSS access occurs during offline tests.
