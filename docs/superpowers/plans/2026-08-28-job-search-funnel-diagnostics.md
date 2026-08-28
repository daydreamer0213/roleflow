# Job Search Funnel Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. For this repository, use `executing-plans` in the current task; do not spawn subagents unless the user later explicitly asks for delegation.

**Goal:** Turn existing local application, communication, and message observations into an explainable job-search funnel that waits for each job's feedback to mature, forms rolling cohorts at a configurable sample threshold, and shows the user where the current search is most likely getting stuck.

**Architecture:** Materialize one immutable funnel entry when the user actually applies or communicates, snapshot the dimensions that were active at that moment, and append only safe outcome observations to the existing candidate progress history. A focused SQLite store manages the configurable policy, unassigned mature pool, and frozen cohort membership. Pure functions calculate China-time feedback deadlines, funnel stages, evidence strength, and deterministic recommendations. A separate server-rendered “求职体检” page reads this local projection; it never performs a BOSS write or independently refreshes the platform.

**Tech Stack:** Node.js 22 CommonJS, built-in `node:sqlite` and `node:crypto`, current server-rendered Dashboard and CSS, existing candidate/job/progress stores, fixture and in-memory SQLite smoke tests.

## Global Constraints

- [ ] Count only a user-confirmed application or an actual communication event. Scanned, viewed, analyzed, recommended, or merely discovered jobs must never enter the funnel.
- [ ] Store 30, 50, and 70 as the default preliminary, comparable, and formal policy thresholds. Require configurable values to be strictly increasing and keep every aggregation independent of the defaults.
- [ ] Mature each entry no earlier than 48 hours after its actual start. If that deadline falls on Saturday or Sunday in China time, move it to Monday at the same local time.
- [ ] Start “已读不回” from the first safe observation of the latest read state, not from application time. A later read observation begins a new 48-hour wait for that message state.
- [ ] Show positive events immediately, but keep immature and unknown entries out of failure denominators and formal cohort formation.
- [ ] When enough unassigned entries are mature, freeze all currently mature entries into one cohort; never truncate the cohort to the policy threshold.
- [ ] Keep cohort membership and contact-time dimensions immutable. Late outcome events may update the cohort's current funnel totals without moving the entry to another cohort.
- [ ] Store only safe identifiers, digests, categories, and timestamps. Do not persist raw HR message text, recruiter labels, screenshots, or reply text in the funnel tables/events.
- [ ] Preserve event provenance: `platform_observation`, `user_record`, `time_inference`, or `unknown`. A user correction wins the current projection but does not erase prior observations.
- [ ] Reuse SQLite, the current progress event log, and existing UI shell. Do not add an analytics service, ORM, chart framework, background queue, or model dependency.
- [ ] Keep all BOSS access read-only. Do not fill, paste, send, agree/refuse a résumé request, apply, or foreground a BOSS tab.
- [ ] Keep the old queue outcome statistics intact. Stage two gets a separate `/funnel` page labeled “求职体检”.

---

## Task 1: Record the Reuse Decision and One Read-only Calibration

**Files:**

- Create: `docs/superpowers/reports/2026-08-28-stage2-funnel-reuse-and-calibration.md`
- Modify only if live evidence contradicts the approved contract: `docs/superpowers/specs/2026-08-28-job-search-funnel-diagnostics-design.md`

- [x] **Step 1: Evaluate the smallest reusable analytics surface**

Compare the current SQLite/event approach with maintained funnel or product-analytics components. Record whether each option supports local/offline storage, immutable event provenance, configurable maturation, frozen cohorts, and deterministic fixture tests without uploading candidate data.

Use the official SQLite aggregate/window-function documentation as the primary implementation reference. The expected decision is `reference_only`: use SQL grouping and JavaScript projection already available in the repository, with no new dependency. Change this only if a component demonstrably removes more code than it adds and preserves all privacy and audit requirements.

- [x] **Step 2: Read the browser-operation instructions before touching the live tab**

Read the complete `edge-browser-ops` skill. Resolve the current numeric fixed-tab IDs from the active browser binding. Use only `BOSS-COMMUNICATION`, keep it in the background, and do not call `Page.bringToFront`.

- [x] **Step 3: Run one minimal read-only calibration**

Without clicking a conversation or changing page state, inspect the currently visible conversation rows and confirm whether the live DOM still provides the fields already represented by `scanConversationRows()`:

```text
conversationKey / safe identity source
unread
previewKind = self_read | self_delivered | possible_hr_reply | platform_notice | unknown
previewDigest
```

Capture redacted DOM evidence and a redacted screenshot only if it can be done without exposing message content. Recheck the fixed tab identity immediately after the read. If login, risk control, page loss, tab ambiguity, or a foreground change is observed, stop calibration and record the exact reason; do not work around it.

- [x] **Step 4: Write the calibration report**

The report must separate:

1. directly observed live fields;
2. existing code/fixture evidence;
3. inferences used by the funnel;
4. unavailable or unknown fields;
5. the dependency decision (`reference_only`, `local_component`, or `direct_integration`).

Do not include raw message text, recruiter names, company names, job titles, URLs with identifiers, cookies, or screenshots containing personal content.

- [x] **Step 5: Verify and commit the evidence checkpoint**

Run:

```powershell
rg -n "[T]ODO|[T]BD|待[补]充|以后再[定]|p[l]aceholder" docs/superpowers/reports/2026-08-28-stage2-funnel-reuse-and-calibration.md
git diff --check
```

Expected: no unfinished-marker matches and no whitespace errors.

```powershell
git add docs/superpowers/reports/2026-08-28-stage2-funnel-reuse-and-calibration.md docs/superpowers/specs/2026-08-28-job-search-funnel-diagnostics-design.md
git commit -m "docs: calibrate funnel observation inputs"
```

---

## Task 2: Implement Feedback Maturity and Funnel Projection Rules

**Files:**

- Create: `src/core/funnel_maturity.js`
- Create: `tests/job_search_funnel_smoke.js`
- Modify: `tests/run_all.js`

- [x] **Step 1: Write the failing pure-rule tests**

Create `tests/job_search_funnel_smoke.js` and register it after `candidate_progress_storage_smoke.js`. Start with assertions equivalent to:

```js
assert.equal(
  feedbackMaturesAt("2026-08-25T02:00:00.000Z"),
  "2026-08-27T02:00:00.000Z"
);
assert.equal(
  feedbackMaturesAt("2026-08-27T02:00:00.000Z"),
  "2026-08-31T02:00:00.000Z"
);
assert.equal(
  feedbackMaturesAt("2026-08-28T02:00:00.000Z"),
  "2026-08-31T02:00:00.000Z"
);
assert.equal(diagnosisStrength(29), "facts");
assert.equal(diagnosisStrength(30), "preliminary");
assert.equal(diagnosisStrength(50), "comparable");
assert.equal(diagnosisStrength(70), "formal");
```

Also cover:

- an explicit positive reply before 48 hours is visible but the entry remains immature for cohort formation;
- a read observation creates its own read-no-reply deadline;
- a newer read digest supersedes the older read state and restarts that deadline;
- waiting and unknown records are never treated as failures;
- system notices and courtesy-only messages do not become effective conversations.

- [x] **Step 2: Run the test and confirm the expected failure**

```powershell
node tests/job_search_funnel_smoke.js
```

Expected: failure because `src/core/funnel_maturity.js` does not exist.

- [x] **Step 3: Implement the pure contract**

Export these exact symbols from `src/core/funnel_maturity.js`:

```js
const DEFAULT_PRELIMINARY_SAMPLE_TARGET = 30;
const DEFAULT_COMPARABLE_SAMPLE_TARGET = 50;
const DEFAULT_FORMAL_SAMPLE_TARGET = 70;

normalizeFunnelSamplePolicy(value)
feedbackMaturesAt(startedAt)
readNoReplyMaturesAt(readObservedAt)
diagnosisStrength(matureCount, samplePolicy)
projectFunnelEntry(entry, events, { now })
buildFunnelSnapshot(entries, eventsByEntry, { now, samplePolicy })
```

Use a fixed China-time offset (`UTC+08:00`) with built-in `Date`; no date library is needed. `feedbackMaturesAt` must add 48 elapsed hours first and then move a China-local Saturday/Sunday deadline to Monday at the same local clock time.

`projectFunnelEntry` returns stable booleans and provenance for:

```text
started, read, replied, effectiveConversation,
resumeRequested, interviewInvited, interviewConfirmed,
rejected, closed, mature, readNoReplyMature,
waitingReason, unknownFields
```

Never infer a missing platform field as false. Use `null` for unknown values and expose the source that supports every positive state.

- [x] **Step 4: Run the pure-rule test**

```powershell
node tests/job_search_funnel_smoke.js
```

Expected: `job_search_funnel_smoke: ok`.

- [x] **Step 5: Commit the deterministic rules**

```powershell
git add src/core/funnel_maturity.js tests/job_search_funnel_smoke.js tests/run_all.js
git commit -m "feat: define funnel maturity rules"
```

---

## Task 3: Add Funnel Policy, Entry, and Cohort Storage

**Files:**

- Create: `src/storage/funnel_store.js`
- Modify: `src/core/storage.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/job_search_funnel_smoke.js`
- Modify only for intentional facade exports: `tests/scan_store_contract_smoke.js`
- Modify only for intentional facade exports: `tests/communication_store_contract_smoke.js`
- Modify only for intentional facade exports: `tests/job_store_contract_smoke.js`
- Modify only for intentional facade exports: `tests/workflow_store_contract_smoke.js`

- [x] **Step 1: Extend the failing storage fixtures**

In `tests/job_search_funnel_smoke.js`, build an in-memory repository database and assert:

- default policy is 30/50/70, custom thresholds must strictly increase, and every value stays within 10–500;
- one `(profile_id, job_id)` creates at most one entry even when application and communication events both exist;
- entry dimensions remain unchanged after the active résumé, plan, job analysis, or greeting changes;
- an inbound-only progress card does not create an entry;
- 69 mature entries do not freeze a 70-target cohort;
- the next refresh with 83 unassigned mature entries creates one 83-entry cohort;
- immature entries stay unassigned for a later cohort;
- late events update a frozen cohort's projection without changing its membership;
- the same job can belong to a different candidate profile without colliding.

- [x] **Step 2: Run the storage test and confirm the expected failure**

```powershell
node tests/job_search_funnel_smoke.js
```

Expected: failure because migration 18 and `src/storage/funnel_store.js` do not exist.

- [x] **Step 3: Add schema migration 18**

Add `JOB_SEARCH_FUNNEL_SCHEMA` and migration `job_search_funnel_v1` to `src/core/storage.js`:

```text
candidate_funnel_policies
  profile_id PRIMARY KEY
  preliminary_sample_target
  comparable_sample_target
  formal_sample_target
  updated_at

candidate_funnel_cohorts
  id PRIMARY KEY
  profile_id
  preliminary_sample_target
  comparable_sample_target
  formal_sample_target
  sample_count
  started_at
  ended_at
  frozen_at
  created_at

candidate_funnel_entries
  id PRIMARY KEY
  profile_id
  job_id
  card_id nullable
  cohort_id nullable
  plan_id nullable
  source_kind CHECK applied | communication | reply_sent
  started_at
  mature_at
  direction_key
  decision_bucket
  resume_version_id nullable
  greeting_key
  created_at
  updated_at
  UNIQUE(profile_id, job_id)
```

Use foreign keys to candidate profile, job, progress card, search plan, resume version, and cohort. Index unassigned entries by `(profile_id, cohort_id, mature_at)` and cohort entries by `(cohort_id, started_at)`.

`direction_key`, `decision_bucket`, and `greeting_key` are contact-time snapshots. `greeting_key` is a SHA-256 digest of the normalized greeting and may be empty when the actual greeting version is unknown. Never store the greeting text in the funnel table.

- [x] **Step 4: Implement the focused store**

Export these exact functions from `src/storage/funnel_store.js`:

```js
getFunnelPolicy(db, { profileId })
saveFunnelPolicy(db, { profileId, preliminarySampleTarget, comparableSampleTarget, formalSampleTarget, updatedAt })
ensureFunnelEntry(db, input)
getFunnelEntry(db, { profileId, jobId })
listFunnelEntries(db, { profileId, cohortId, unassignedOnly })
freezeReadyFunnelCohort(db, { profileId, now })
listFunnelCohorts(db, { profileId, limit })
getFunnelCohort(db, { profileId, cohortId })
listFunnelProgressEvents(db, { profileId, entryIds })
```

`ensureFunnelEntry` validates ownership and snapshots, in one transaction:

1. plan/direction active at contact time;
2. latest job observation at or before `startedAt` when available;
3. decision bucket from that observation/current job;
4. active résumé version at contact time when provable, otherwise `NULL`;
5. normalized greeting digest when available;
6. `matureAt = feedbackMaturesAt(startedAt)`.

On a duplicate job, return the original entry without rewriting any snapshot. Never guess a résumé/greeting version that cannot be supported by stored history.

`freezeReadyFunnelCohort` runs in one immediate transaction. When the unassigned mature count reaches the saved formal target, create one cohort and attach every currently mature unassigned entry. Repeated calls at the same state are idempotent.

- [x] **Step 5: Re-export only the required store surface**

Re-export the funnel store functions through `src/core/storage.js`. Update exact facade-count tests only for real new exports; do not weaken them to “at least N”.

Update `tests/storage_migration_smoke.js` to assert schema version 18, migration name, tables, checks, indexes, and foreign keys.

- [x] **Step 6: Run the storage checks**

```powershell
node tests/job_search_funnel_smoke.js
node tests/storage_migration_smoke.js
node tests/scan_store_contract_smoke.js
node tests/communication_store_contract_smoke.js
node tests/job_store_contract_smoke.js
node tests/workflow_store_contract_smoke.js
```

Expected: all print their `ok` message and exit 0.

- [x] **Step 7: Commit the storage slice**

```powershell
git add src/core/storage.js src/storage/funnel_store.js tests/job_search_funnel_smoke.js tests/storage_migration_smoke.js tests/scan_store_contract_smoke.js tests/communication_store_contract_smoke.js tests/job_store_contract_smoke.js tests/workflow_store_contract_smoke.js
git commit -m "feat: persist rolling funnel cohorts"
```

---

## Task 4: Enroll Only Actual Applications and Communications

**Files:**

- Modify: `src/storage/job_store.js`
- Modify: `src/core/candidate_progress.js`
- Modify: `tests/job_search_funnel_smoke.js`
- Modify: `tests/candidate_progress_storage_smoke.js`

- [x] **Step 1: Add failing enrollment tests**

Assert these exact entry points:

1. `markCandidateJob(... status: "applied")` creates one funnel entry using the event timestamp;
2. `review`, `later`, `skipped`, `no_reply`, `interview`, `rejected`, and analysis/scanning events alone do not create an entry;
3. verified `contact_started` and `contact_already_exists` create an entry only after the communication result is persisted;
4. `reply_confirmed_sent` creates an entry for an inbound opportunity that previously had no actual user contact;
5. repeated or overlapping entry points reuse the original entry, start time, and frozen dimensions;
6. if entry creation fails, the originating state/event and funnel entry roll back together.

- [x] **Step 2: Run and confirm the failure**

```powershell
node tests/job_search_funnel_smoke.js
node tests/candidate_progress_storage_smoke.js
```

Expected: at least the new enrollment assertions fail.

- [x] **Step 3: Hook the three existing authoritative write paths**

Call `ensureFunnelEntry` only inside the transactions that persist:

```text
candidate_job_events.event_type = applied
candidate_progress_events.type = contact_started | contact_already_exists
candidate_progress_events.type = reply_confirmed_sent
```

Do not introduce a general event listener or replay framework. The three direct hooks are the smallest auditable integration.

Wrap `markCandidateJob`'s state update, event insert, and funnel enrollment in `immediateTransaction`. Reuse the existing savepoint/transaction in candidate progress paths so partial enrollment cannot escape.

- [x] **Step 4: Run enrollment regression checks**

```powershell
node tests/job_search_funnel_smoke.js
node tests/candidate_progress_storage_smoke.js
node tests/job_store_contract_smoke.js
node tests/message_learning_store_smoke.js
```

Expected: all pass.

- [x] **Step 5: Commit the authoritative entry hooks**

```powershell
git add src/storage/job_store.js src/core/candidate_progress.js tests/job_search_funnel_smoke.js tests/candidate_progress_storage_smoke.js
git commit -m "feat: enroll real job search activity"
```

---

## Task 5: Append Safe Message Outcome Observations

**Files:**

- Create: `src/core/funnel_observation.js`
- Create: `tests/funnel_message_observation_smoke.js`
- Modify: `src/core/message_discovery.js`
- Modify: `src/core/candidate_progress.js`
- Modify: `tests/message_discovery_smoke.js`
- Modify: `tests/run_all.js`

- [ ] **Step 1: Write failing safe-observation tests**

Use digested fixture rows and assert:

- a bound `self_read` row appends `outbound_read_observed` once for `(card, previewDigest)`;
- a bound `self_delivered` row appends `outbound_delivered_observed` once;
- a bound `possible_hr_reply` row appends `inbound_reply_observed` once, while effective conversation remains unknown until classification;
- unbound, platform-notice, unsupported, and unknown rows create no funnel event;
- the event contains only `platform`, `threadKey`, `messageKey/source`, and safe stage/category fields;
- raw preview text and recruiter labels never appear in `summary`, `metadata_json`, logs, or discovery public status;
- a later read digest creates a later observation and restarts read-no-reply maturity;
- a classified résumé request appends `resume_requested` in the same transaction as the message-group classification;
- `messageIntent = interview_invitation` continues to support the interview stage without a duplicate count.

- [ ] **Step 2: Run and confirm the failure**

```powershell
node tests/funnel_message_observation_smoke.js
```

Expected: failure because `src/core/funnel_observation.js` does not exist.

- [ ] **Step 3: Implement the safe row adapter**

Export:

```js
recordFunnelRowObservations(db, { profileId, platform, rows, observedAt })
```

The function must:

1. accept only already-validated scan rows;
2. match `conversationKey` to a card owned by the same profile via `thread_key`;
3. map only the three proven preview kinds;
4. derive a deterministic UUID-shaped `progress:` idempotency key from `cardId + eventType + previewDigest` using built-in SHA-256;
5. call the existing progress-event sanitizer rather than inserting directly;
6. return safe counts only.

- [ ] **Step 4: Integrate with the existing scan and classification**

Call `recordFunnelRowObservations` once after `scanConversationRows()` is validated and before queue planning. This reuses the current read and adds no refresh, click, pacing bypass, or access-budget consumption.

Pass the already-safe `manualActions` into `recordDiscoveredMessageGroupClassification`. When it contains `resume_request`, append one `resume_requested` event in the same database transaction, keyed by the safe message-group digest.

- [ ] **Step 5: Run message-discovery regressions**

```powershell
node tests/funnel_message_observation_smoke.js
node tests/message_discovery_smoke.js
node tests/candidate_progress_storage_smoke.js
node tests/boss_message_dom_smoke.js
node tests/boss_message_reader_smoke.js
```

Expected: all pass and fixture assertions prove no raw message persistence.

- [ ] **Step 6: Commit the observation slice**

```powershell
git add src/core/funnel_observation.js src/core/message_discovery.js src/core/candidate_progress.js tests/funnel_message_observation_smoke.js tests/message_discovery_smoke.js tests/run_all.js
git commit -m "feat: observe safe funnel outcomes"
```

---

## Task 6: Build Cohort Diagnosis Without Causal Overclaiming

**Files:**

- Create: `src/application/funnel_analysis/index.js`
- Modify: `src/core/funnel_maturity.js`
- Modify: `tests/job_search_funnel_smoke.js`

- [ ] **Step 1: Write failing diagnosis fixtures**

Create deterministic cohorts for these cases:

- 29 mature entries: facts and progress only, no cause claim;
- 35 mature entries: one preliminary observation and one check item;
- 55 mature entries: a comparable stage diagnosis, but not a formal conclusion;
- 83 mature entries with formal target 70: formal funnel, all 83 included;
- many started entries but fewer than target mature: no formal cohort;
- high contact/low read: recommend checking recruiter activity, job choice, timing, or greeting—not résumé rewrite;
- high read/low reply: check job fit and opening expression;
- high reply/low effective conversation: check answer quality and candidate facts;
- high effective conversation/low résumé request or interview: check targeted résumé/project evidence;
- enough interviews but weak later results: point to mock interview;
- unknown/waiting-heavy data: state that evidence is incomplete and avoid selecting a false bottleneck;
- two résumé/greeting versions with adequate comparable samples: keep their rates separate; insufficient versions remain descriptive only.

- [ ] **Step 2: Run and confirm the failure**

```powershell
node tests/job_search_funnel_smoke.js
```

Expected: the new service/diagnosis assertions fail.

- [ ] **Step 3: Implement the application service**

Export from `src/application/funnel_analysis/index.js`:

```js
createFunnelAnalysisService({ db, now })
```

The service exposes:

```js
refresh({ profileId })
getDashboard({ profileId })
savePolicy({ profileId, preliminarySampleTarget, comparableSampleTarget, formalSampleTarget })
```

`refresh` freezes a cohort only when ready, then returns the same dashboard shape as `getDashboard`. Reads must remain deterministic and work without a model.

The dashboard result includes:

```text
policy
currentPool { started, mature, waiting, unknown, target, strength }
latestCohort { id, sampleCount, startedAt, endedAt, frozenAt, strength }
funnel stages with numerator, denominator, unknown, waiting
comparisons by direction, decision bucket, resume version, greeting key
headline
priorityCheck
evidenceNotes
```

Diagnosis wording must use “当前数据显示”“可能”“优先检查”, never “证明”“导致”“准确率”. Do not compare a dimension unless both sides have enough mature, known observations to support the stated rate.

- [ ] **Step 4: Run the diagnosis test**

```powershell
node tests/job_search_funnel_smoke.js
```

Expected: `job_search_funnel_smoke: ok`.

- [ ] **Step 5: Commit the diagnosis service**

```powershell
git add src/application/funnel_analysis/index.js src/core/funnel_maturity.js tests/job_search_funnel_smoke.js
git commit -m "feat: diagnose rolling job search cohorts"
```

---

## Task 7: Add the Separate “求职体检” Dashboard Page

**Files:**

- Create: `src/dashboard/pages/funnel.js`
- Create: `tests/dashboard_funnel_smoke.js`
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/ui/navigation.js`
- Modify: `src/dashboard/ui/styles.js`
- Modify: `tests/dashboard_shell_smoke.js`
- Modify: `tests/run_all.js`

- [ ] **Step 1: Write the failing page test**

Assert that `GET /funnel?planId=<id>`:

- resolves the profile from the owned plan and rejects cross-profile/missing context;
- refreshes only local cohort state and performs no browser/model action;
- shows `成熟样本 / 下一道门槛`, `等待 48 小时`, and `结论强度` first;
- shows the latest cohort headline, one priority check, stage counts/denominators, waiting, unknown, and data-source notes;
- uses “样本不足/初步观察/阶段诊断/正式诊断” wording for the four displayed states created by the three thresholds;
- does not show a formal cause or version comparison below its evidence threshold;
- includes a plan-scoped “求职体检” navigation link on `/plan`, `/queue`, `/messages`, and `/funnel`;
- contains no raw HR text, reply drafts, or hidden automatic-action form;
- renders a useful empty state before the first real application/contact.

- [ ] **Step 2: Run and confirm the failure**

```powershell
node tests/dashboard_funnel_smoke.js
```

Expected: failure because the page and route do not exist.

- [ ] **Step 3: Implement the server-rendered page**

`src/dashboard/pages/funnel.js` exports:

```js
renderFunnelPage({ plan, dashboard, currentPath })
```

Use the existing shell, cards, badges, tables, and CSS variables. Use plain HTML/CSS bars for the funnel; do not add canvas, a chart package, client polling, or a SPA component tree.

Page order:

1. one-sentence current conclusion;
2. mature/target, waiting, unknown, and strength summary cards;
3. latest frozen cohort and funnel stages;
4. safe version/direction comparisons when supported;
5. one recommended next inspection;
6. data maturity and provenance explanation.

Do not add a policy-editing form in the first page version. The policy is configurable through the service/store contract, while the UI displays the current saved target. Add a setting only after real use proves it is needed.

- [ ] **Step 4: Wire the route and navigation**

Construct one funnel service in the Dashboard server's existing dependency setup. Add a read-only GET route for `/funnel`; do not add an API that performs platform work.

Add:

```js
navigationLink(`/funnel?planId=${encodedPlanId}`, "求职体检", currentRoute === "/funnel")
```

Keep “诊断” as the technical runtime diagnostics page; “求职体检” is the candidate-facing funnel page.

- [ ] **Step 5: Run dashboard regressions**

```powershell
node tests/dashboard_funnel_smoke.js
node tests/dashboard_shell_smoke.js
node tests/outcome_analytics_dashboard_smoke.js
node tests/dashboard_message_discovery_smoke.js
node tests/dashboard_communication_profile_smoke.js
```

Expected: all pass and the old queue statistics remain unchanged.

- [ ] **Step 6: Commit the user-facing slice**

```powershell
git add src/dashboard/pages/funnel.js src/dashboard/server.js src/dashboard/ui/navigation.js src/dashboard/ui/styles.js tests/dashboard_funnel_smoke.js tests/dashboard_shell_smoke.js tests/run_all.js
git commit -m "feat: add job search health check"
```

---

## Task 8: Final Integration, Documentation, and Exact-SHA Gate

**Files:**

- Modify: `docs/NEXT_PHASE.md`
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/superpowers/plans/2026-08-28-job-search-funnel-diagnostics.md`
- Modify only if implementation changes the approved contract: `docs/superpowers/specs/2026-08-28-job-search-funnel-diagnostics-design.md`

- [ ] **Step 1: Review the implementation against all design boundaries**

Inspect the diff and prove:

- no scan/analyze-only job enters the sample;
- 30, 50, and 70 are not embedded in SQL, page conditions, or wording except as central defaults and stored policy defaults;
- each entry has its own 48-hour/weekend deadline;
- frozen cohorts take all mature unassigned entries;
- unknown and waiting states are not failures;
- only safe digests/categories/timestamps are persisted;
- no BOSS write path, foregrounding, independent refresh, model requirement, or new dependency exists;
- old queue analytics and stage-one message learning still work.

- [ ] **Step 2: Run focused checks**

```powershell
node tests/job_search_funnel_smoke.js
node tests/funnel_message_observation_smoke.js
node tests/dashboard_funnel_smoke.js
node tests/storage_migration_smoke.js
node tests/candidate_progress_storage_smoke.js
node tests/message_discovery_smoke.js
node tests/message_learning_store_smoke.js
node tests/dashboard_message_discovery_smoke.js
```

Expected: every check prints `ok` and exits 0.

- [ ] **Step 3: Run the complete offline gate**

```powershell
npm test
```

Expected: every check in the fresh `tests/run_all.js` registry passes. Record the actual total from this run; do not reuse the old 111-check phase-one result.

- [ ] **Step 4: Update handoff and route documents**

Document:

- what the user can now see;
- the rolling mature-pool and all-mature cohort rule;
- current default and configurable sample target;
- exact event/provenance boundaries;
- real-page calibration result and any unverified field;
- test total and exact commit SHA;
- stage three, targeted résumé optimization, as the next product entry when stage two points there;
- stage four may start directly when interview samples exist.

Do not reopen the frozen scalar-score decision or list it as upcoming work.

- [ ] **Step 5: Run final repository hygiene checks**

```powershell
rg -n "[T]ODO|[T]BD|待[补]充|以后再[定]|p[l]aceholder" docs/superpowers/plans/2026-08-28-job-search-funnel-diagnostics.md docs/NEXT_PHASE.md docs/PROJECT_HANDOFF.md
git diff --check
git status --short --branch
```

Expected: no unfinished markers, no whitespace errors, and only intentional final documentation changes.

- [ ] **Step 6: Commit final documentation**

```powershell
git add docs/NEXT_PHASE.md docs/PROJECT_HANDOFF.md docs/superpowers/plans/2026-08-28-job-search-funnel-diagnostics.md docs/superpowers/specs/2026-08-28-job-search-funnel-diagnostics-design.md
git commit -m "docs: close funnel diagnostics stage"
```

- [ ] **Step 7: Verify the exact final SHA**

After the documentation commit, rerun at minimum:

```powershell
node tests/job_search_funnel_smoke.js
node tests/funnel_message_observation_smoke.js
node tests/dashboard_funnel_smoke.js
node tests/message_discovery_smoke.js
git diff --check HEAD^
git status --short --branch
git rev-parse HEAD
```

If the final documentation commit changes executable code or test registration, rerun `npm test` on that exact SHA. Do not push, merge, package, change the version, or create a release without new user authorization.
