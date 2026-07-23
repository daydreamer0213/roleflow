# 求职进展与人工确认工作流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add privacy-preserving per-job progress cards that distinguish a verified communication start from a resume submission and support manual, fact-grounded HR reply handling.

**Architecture:** Add small SQLite tables for progress cards and sanitized events, with one active card per profile/job. A new core service owns legal stage transitions and idempotent event creation; communication execution records a verified contact_started event instead of calling a successful chat an application. The dashboard renders and manually advances cards; pasted messages are ephemeral model input and are never persisted.

**Tech Stack:** Node.js CommonJS, SQLite migrations in src/core/storage.js, server-rendered dashboard, existing model contracts/fact storage, Node assert smoke tests and fake browser adapters.

## Global Constraints

- Use only isolated-worktree temporary databases, fake models, and fake browsers for development and tests.
- Do not access real BOSS, D:\Guo\ZhiPing\data\jobs.sqlite, port 8787, external inboxes, calendars, or real communication controls.
- Do not weaken the existing BOSS calibration gate, single-tab/serial behavior, identity checks, interruption behavior, or per-click approval boundary.
- Never persist or log HR message bodies, generated reply bodies, browser credentials, or chat screenshots.
- No automatic send, automatic reply, automatic interview acceptance, or automatic calendar write is part of this plan.
- Preserve historical job records; migrate only the minimum sanitized metadata needed to render their actual communication meaning.

---

### Task 1: Persist progress cards and sanitized events

**Files:**

- Modify: src/core/storage.js
- Create: src/core/candidate_progress.js
- Create: tests/candidate_progress_storage_smoke.js
- Modify: tests/storage_migration_smoke.js
- Modify: tests/run_all.js

**Interfaces:**

- Produces ensureProgressCard(db, { profileId, planId, jobId, source, now }) -> ProgressCard.
- Produces recordProgressEvent(db, { cardId, type, actor, summary, metadata, occurredAt }) -> ProgressEvent.
- Produces transitionProgressCard(db, { cardId, expectedStage, stage, nextAction, scheduledAt }) -> ProgressCard.
- Produces getProgressCardForJob(db, { profileId, jobId }) and listProgressCards(db, { planId, stages }).

- [ ] **Step 1: Write the failing storage and privacy tests**

Create tests/candidate_progress_storage_smoke.js with a temporary database, profile, plan, and job. Assert:

~~~
const card = ensureProgressCard(db, { profileId, planId, jobId, source: "boss", now });
assert.strictEqual(card.stage, "contact_started");
recordProgressEvent(db, {
  cardId: card.id, type: "incoming_message_classified", actor: "system",
  summary: "项目事实确认", metadata: { category: "project_fact" }
});
assert.strictEqual(listProgressEvents(db, card.id)[0].summary, "项目事实确认");
assert(!JSON.stringify(listProgressEvents(db, card.id)).includes("HR 原话正文"));
~~~

Assert a second ensureProgressCard returns the same card, illegal contact_started -> interview_scheduled throws PROGRESS_STAGE_TRANSITION_INVALID, and the migration backfills one historical row whose reason code is communication_succeeded without changing its historical application_status.

- [ ] **Step 2: Run the test to verify it fails**

Run: node tests/candidate_progress_storage_smoke.js && node tests/storage_migration_smoke.js

Expected: failure because the tables, migration, and core service do not exist.

- [ ] **Step 3: Add migration and the transition service**

Add a new numbered migration in src/core/storage.js creating these tables:

~~~
CREATE TABLE candidate_progress_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  recruiter_name TEXT NOT NULL DEFAULT '',
  thread_key TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL,
  next_action TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT,
  last_event_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, job_id)
);
CREATE TABLE candidate_progress_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(card_id) REFERENCES candidate_progress_cards(id)
);
~~~

Add indexes on plan_id, stage, updated_at and card_id, occurred_at. In candidate_progress.js, define the legal stages:

~~~
const PROGRESS_STAGES = new Set([
  "contact_started", "waiting_reply", "needs_user_action", "reply_ready",
  "interview_invited", "interview_scheduled", "resume_submitted", "rejected", "closed"
]);
~~~

Reject metadata keys named message, body, text, html, draft, or screenshot; retain only scalar identifiers, categories, fact keys, scheduled timestamps, and user-confirmed short summaries. Backfill historical application_reason_code values communication_succeeded and already_communicated into waiting_reply cards with a sanitized event and leave application_status untouched.

- [ ] **Step 4: Run persistence regressions**

Run: node tests/candidate_progress_storage_smoke.js && node tests/storage_migration_smoke.js && node tests/communication_batch_storage_smoke.js

Expected: all exit 0; migration is idempotent and existing communication tables remain unchanged.

- [ ] **Step 5: Commit the persistence slice**

~~~
git add src/core/storage.js src/core/candidate_progress.js tests/candidate_progress_storage_smoke.js tests/storage_migration_smoke.js tests/run_all.js
git commit -m "feat: persist candidate progress cards"
~~~

### Task 2: Reconcile verified communication without mislabeling it as an application

**Files:**

- Modify: src/core/workflow_inventory.js
- Modify: src/core/communication_executor.js
- Modify: src/core/communication_batches.js
- Modify: tests/communication_executor_smoke.js
- Modify: tests/workflow_inventory_smoke.js

**Interfaces:**

- Produces recordVerifiedCommunicationStart(db, { batch, item, outcome, now }) -> ProgressCard.
- reconcileCommunicationOutcome continues mapping unavailable/mismatch outcomes but no longer writes applicationStatus=applied for succeeded or already_communicated.
- workflowEligibility excludes a job with an active progress card from another initial communication selection.

- [ ] **Step 1: Write failing reconciliation tests**

In tests/communication_executor_smoke.js, after a fake successful verification, assert:

~~~
const job = listReportJobs(db, { planId, profileId })[0];
assert.notStrictEqual(job.applicationStatus, "applied");
const card = getProgressCardForJob(db, { profileId, jobId: job.id });
assert.strictEqual(card.stage, "waiting_reply");
assert.strictEqual(listProgressEvents(db, card.id)[0].type, "contact_started");
~~~

Add a repeated execution/already_communicated assertion that produces no second card and no duplicate contact_started event. In tests/workflow_inventory_smoke.js, assert such a job is ineligible with WORKFLOW_PROGRESS_ACTIVE.

- [ ] **Step 2: Run the tests to verify they fail**

Run: node tests/communication_executor_smoke.js && node tests/workflow_inventory_smoke.js

Expected: failure because successful communication currently marks the job as applied and no progress card exists.

- [ ] **Step 3: Replace the success mapping with an idempotent progress event**

Add recordVerifiedCommunicationStart in candidate_progress.js. It must create/reuse the card, record exactly one contact_started or contact_already_exists event for the batch/item outcome, then transition to waiting_reply with next action 等待招聘方回复.

Call it from both successful paths in src/core/communication_executor.js. Keep job_unavailable, target_mismatch, and action_unavailable mapping through the existing reconcileCommunicationOutcome; ambiguous results remain unresolved and interrupt exactly as today. Change workflowEligibility to call getProgressCardForJob and reject all nonterminal card stages with WORKFLOW_PROGRESS_ACTIVE.

- [ ] **Step 4: Run communication and workflow regressions**

Run: node tests/communication_executor_smoke.js && node tests/communication_batch_storage_smoke.js && node tests/workflow_inventory_smoke.js && node tests/workflow_communication_smoke.js && node tests/communication_calibration_gate_smoke.js

Expected: all exit 0; failures still interrupt and no test performs a real browser action.

- [ ] **Step 5: Commit the reconciliation slice**

~~~
git add src/core/candidate_progress.js src/core/workflow_inventory.js src/core/communication_executor.js src/core/communication_batches.js tests/communication_executor_smoke.js tests/workflow_inventory_smoke.js tests/communication_batch_storage_smoke.js
git commit -m "fix: distinguish communication from application"
~~~

### Task 3: Add manual, fact-grounded reply classification without storing text

**Files:**

- Modify: src/core/model_contract.js
- Modify: src/adapters/models/openai_compatible.js
- Modify: src/adapters/models/mock.js
- Modify: src/dashboard/server.js
- Modify: tests/communication_smoke.js

**Interfaces:**

- Extends CommunicationDraft with messageCategory in project_fact, qualification, salary, availability, interview_invitation, other, or identity_uncertain.
- Extends CommunicationDraft with progressUpdate: { stage, nextAction, summary } containing no message body.
- POST /api/communication receives hrMessage only for the active request; it never stores or logs it.

- [ ] **Step 1: Write failing reply-flow tests**

In tests/communication_smoke.js, create a progress card and post RAG 项目实际上线了吗？. Assert the generated draft has messageCategory equal to project_fact, the progress event summary is 项目事实确认, and database queries across progress tables do not contain the input message string. Add an interview message assertion: it returns interview_invitation, creates no send action, and moves the card only to interview_invited.

- [ ] **Step 2: Run the test to verify it fails**

Run: node tests/communication_smoke.js

Expected: failure because the current draft result lacks category/progress metadata and no card event is written.

- [ ] **Step 3: Extend the safe draft contract and handler**

In validateCommunication, normalize messageCategory and validate a progressUpdate containing only a legal stage, short summary, and next action. Update the model prompt to classify the pasted message before drafting. It must return an empty messages array when identity is uncertain, an answer needs a missing fact, or the message is an interview invitation requiring a user decision.

In handleCommunication, load the job progress card before model invocation. After a valid response, record only messageCategory, missingFact.key, stage, and sanitized summary through candidate_progress.js. Do not include hrMessage in logger fields, event metadata, redirects, error messages, or rendered hidden fields; retain it only in the current request when re-asking for one missing fact.

- [ ] **Step 4: Run privacy and communication regressions**

Run: node tests/communication_smoke.js && node tests/model_contract_smoke.js && node tests/candidate_progress_storage_smoke.js

Expected: all exit 0; no persisted row contains either the HR input or generated reply text.

- [ ] **Step 5: Commit the manual-reply slice**

~~~
git add src/core/model_contract.js src/adapters/models/openai_compatible.js src/adapters/models/mock.js src/dashboard/server.js tests/communication_smoke.js tests/model_contract_smoke.js tests/candidate_progress_storage_smoke.js
git commit -m "feat: track manual communication progress"
~~~

### Task 4: Render progress cards and explicit manual actions

**Files:**

- Modify: src/dashboard/server.js
- Modify: tests/data_visibility_smoke.js
- Modify: tests/workflow_dashboard_smoke.js
- Modify: tests/communication_smoke.js

**Interfaces:**

- Adds POST /api/progress with cardId, action, optional summary, and optional scheduledAt.
- Adds queue pools waiting_reply, needs_user_action, and interview based on progress cards.
- Replaces ambiguous presentation text 已投 after BOSS communication with 已发起沟通.

- [ ] **Step 1: Write failing dashboard tests**

Render a job with a waiting_reply card and assert HTML contains 已发起沟通, 等待招聘方回复, and the new queue pool. Post reply_confirmed_sent, assert the card changes to waiting_reply and no platform send function is called. Post mark_interview_scheduled with an ISO datetime, assert the stage becomes interview_scheduled and the page displays the supplied time.

- [ ] **Step 2: Run the UI tests to verify they fail**

Run: node tests/data_visibility_smoke.js && node tests/workflow_dashboard_smoke.js && node tests/communication_smoke.js

Expected: failure because current UI only exposes job-level application statuses.

- [ ] **Step 3: Implement card rendering and controlled actions**

Decorate decision-pool jobs with progress cards in one storage query, then render a compact progress panel inside existing job details: stage label, sanitized event timeline, next action, and nonautomatic buttons. POST /api/progress must map only these actions:

~~~
const ACTIONS = {
  reply_confirmed_sent: { stage: "waiting_reply", event: "reply_confirmed_sent" },
  mark_needs_user_action: { stage: "needs_user_action", event: "manual_review_requested" },
  mark_interview_invited: { stage: "interview_invited", event: "interview_invited" },
  mark_interview_scheduled: { stage: "interview_scheduled", event: "interview_scheduled" },
  mark_resume_submitted: { stage: "resume_submitted", event: "resume_submitted" },
  close_opportunity: { stage: "closed", event: "closed_by_user" }
};
~~~

Require a nonempty user-entered summary for manual interview scheduling; validate the ISO timestamp when supplied. Keep existing batch review, calibration display, and ambiguous-resolution controls unchanged.

- [ ] **Step 4: Run workflow and UI regressions**

Run: node tests/data_visibility_smoke.js && node tests/workflow_dashboard_smoke.js && node tests/communication_smoke.js && node tests/dashboard_communication_batch_smoke.js && node tests/communication_executor_smoke.js

Expected: all exit 0; UI actions only modify the temporary test database.

- [ ] **Step 5: Commit the dashboard slice**

~~~
git add src/dashboard/server.js tests/data_visibility_smoke.js tests/workflow_dashboard_smoke.js tests/communication_smoke.js tests/dashboard_communication_batch_smoke.js
git commit -m "feat: show candidate progress workflow"
~~~

### Task 5: Document the manual-first boundary and verify full relevant coverage

**Files:**

- Modify: docs/daily_workflow.md
- Modify: docs/llm_contracts.md
- Modify: docs/operations.md
- Modify: README.md
- Modify: tests/run_all.js

- [ ] **Step 1: Update operational documentation**

Document the difference between 已发起沟通 and 已投递简历, the stage meanings, the privacy rule for pasted messages, and that the user must still copy/send every draft and confirm every interview. Add the new progress storage smoke test to tests/run_all.js.

- [ ] **Step 2: Run the complete relevant regression set and inspect the diff**

Run: node tests/candidate_progress_storage_smoke.js; node tests/storage_migration_smoke.js; node tests/communication_smoke.js; node tests/communication_executor_smoke.js; node tests/communication_batch_storage_smoke.js; node tests/communication_calibration_gate_smoke.js; node tests/workflow_inventory_smoke.js; node tests/workflow_dashboard_smoke.js; node tests/dashboard_communication_batch_smoke.js; git diff --check

Expected: all Node commands exit 0 and git diff --check is silent.

- [ ] **Step 3: Commit documentation and test registration**

~~~
git add docs/daily_workflow.md docs/llm_contracts.md docs/operations.md README.md tests/run_all.js
git commit -m "docs: describe manual progress workflow"
~~~

## Self-review

- Spec coverage: Task 1 provides cards/events/privacy and history; Task 2 separates contact from submission without relaxing browser safeguards; Task 3 handles pasted replies and missing facts; Task 4 exposes user-confirmed actions; Task 5 documents the manual-first boundary.
- Placeholder scan: no task contains an unresolved placeholder or delegates unspecified error handling.
- Type consistency: all tasks use ProgressCard, ProgressEvent, candidate_progress.js, legal stage names, and the same action names.
