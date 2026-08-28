# Message Reply Learning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. For this repository, use `executing-plans` in the current task; do not spawn subagents unless the user later explicitly asks for delegation.

**Goal:** Make message-discovery reply drafts editable and durable, learn only from the user's final wording when they copy or mark a reply as manually sent, preserve fact history, and reuse active user-edited answers in later drafts without adding any automatic BOSS send behavior.

**Architecture:** Extend the existing SQLite database with durable drafts, answer memories, and append-only fact revisions. Keep pure comparison and validation rules in `src/core`, coordinate storage plus optional low-cost extraction in one application service, and leave the current BOSS reader and message classifier in place. Message discovery persists safe draft metadata after classification; the Dashboard edits and completes those local drafts through narrow local endpoints. Active user-edited memories and current `candidate_facts` are supplied to the existing drafting adapter, while raw HR messages remain ephemeral.

**Tech Stack:** Node.js 22 CommonJS, built-in `node:sqlite`, built-in `node:crypto`, current server-rendered Dashboard and browser JavaScript, existing model-adapter contract, fixture/fake-browser offline smoke tests.

## Global Constraints

- [x] Work only on stage one, “消息学习闭环”. Do not build funnel analytics, résumé optimization, or interview simulation in this plan.
- [x] Do not redesign or replace the existing message discovery, candidate progress, profile, or model configuration paths.
- [x] Treat a user edit as authoritative input. “复制草稿” and “已手动发送” complete learning without a second confirmation.
- [x] Typing/autosave must never update `candidate_facts`; only completion can promote a user edit into answer memory and fact revisions.
- [x] An unchanged adopted model draft may be recorded as quality feedback, but it must not become an authoritative fact or future answer memory.
- [x] Repeating completion with the same draft and final text must be idempotent. A later changed final text creates a new revision.
- [x] If fact extraction fails or cannot classify the change, keep the completed answer memory and let copy/manual-send succeed.
- [x] Keep all BOSS actions read-only. This feature must not fill, paste, click send, or introduce automatic sending.
- [x] Persist only the already-safe HR question summary and digested message-group identity; do not add raw HR message text to storage, logs, or public status JSON.
- [x] Preserve the public message-discovery status response's current privacy property: it must not contain reply text, answer memory text, or candidate facts.
- [x] Use no new heavy framework, vector database, remote memory service, ORM, queue, or frontend migration. Add a dependency only if Task 1 proves it is simpler and measurably better than the local implementation.
- [x] Use fixtures, in-memory SQLite, mock adapters, and fake browser state. Do not access real BOSS for this stage.

---

## Task 1: Evaluate Reusable Memory and Feedback Components

**Files:**

- Create: `docs/superpowers/reports/2026-08-28-message-reply-learning-reuse-evaluation.md`
- Modify only if a direct reusable component wins: `docs/superpowers/plans/2026-08-28-message-reply-learning-loop.md`

- [x] **Step 1: Search current primary sources**

Search official repositories and documentation for maintained open-source components covering: edited-response memory extraction, local user memory, SQLite-backed semantic memory, feedback/adoption tracking, and lightweight text-diff handling. Include at least Mem0, LangMem, and one Node-native/local-first alternative if they are still maintained on the execution date.

Do not copy source or add a package during this step. Record source URL, current license, language/runtime, persistence requirements, whether an external service is mandatory, and the smallest useful integration surface.

- [x] **Step 2: Compare against RoleFlow's fixed acceptance fixtures**

Document whether each candidate can support all six behaviors without taking ownership of RoleFlow data:

1. model draft unchanged → no authoritative fact;
2. user corrects arrival date → edited answer retained and current fact updated;
3. same final text completed twice → one memory/revision;
4. second correction → latest value current and old value retained;
5. extractor unavailable → completed answer retained;
6. withdrawn answer → no longer supplied to later drafting.

Score integration size, local/offline operation, deterministic idempotency, evidence traceability, maintenance, license compatibility with AGPL-3.0-only, model/provider coupling, and testability.

- [x] **Step 3: Write the reuse decision**

The report must end with one of:

- `reference_only`: retain RoleFlow's SQLite/contracts and borrow only proven ideas;
- `local_component`: reuse a narrowly scoped library behind the interfaces defined below;
- `direct_integration`: use a maintained component only if it reduces code and passes all six fixtures without a required external service.

Default to `reference_only` when results are tied. Any selected component must stay behind `createMessageReplyLearningService` and must not change the schema/API/user flow in this plan.

- [x] **Step 4: Verify the report has no placeholders**

Run:

```powershell
rg -n "TODO|TBD|待补充|以后再定|placeholder" docs/superpowers/reports/2026-08-28-message-reply-learning-reuse-evaluation.md
```

Expected: no matches.

- [x] **Step 5: Commit the research checkpoint**

```powershell
git add docs/superpowers/reports/2026-08-28-message-reply-learning-reuse-evaluation.md docs/superpowers/plans/2026-08-28-message-reply-learning-loop.md
git commit -m "docs: evaluate reply memory reuse options"
```

---

## Task 2: Add Durable Draft, Answer Memory, and Fact Revision Storage

**Files:**

- Create: `src/storage/message_learning_store.js`
- Create: `tests/message_learning_store_smoke.js`
- Modify: `src/core/storage.js`
- Modify: `src/storage/candidate_store.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/candidate_store_contract_smoke.js`
- Modify: `tests/run_all.js`

- [x] **Step 1: Write the failing storage tests**

In `tests/message_learning_store_smoke.js`, create an in-memory database and assert:

- `recordMessageReplyDrafts` inserts at most two drafts and is idempotent by `(profile_id, message_group_key, draft_index)`;
- it stores `question_summary`, intent/category, original/current text, card/job scope, and no raw HR message field;
- `saveMessageReplyDraftEdit` changes only the draft text/revision and does not touch `candidate_facts` or answer memories;
- `completeMessageReplyDraft` stores one record for the same `(draft_id, final_digest)`, updates completion kind from `copied` to `sent` when applicable, and creates a second record only after the text changes;
- an unchanged completion is marked `draft_adopted`; an edited completion is marked `user_edited_reply`;
- `listOpenMessageReplyDrafts` survives a new controller/process and excludes closed/dismissed drafts;
- current facts use the newest active revision, while earlier values remain in `candidate_fact_revisions`;
- withdrawing an answer memory withdraws only its derived fact revisions and recomputes `candidate_facts` from the newest remaining revision or removes the current fact when none remains;
- repeated save/complete/withdraw calls are idempotent.

Add the test to `tests/run_all.js` immediately after `candidate_store_contract_smoke.js`.

- [x] **Step 2: Run the new test and confirm the expected failure**

```powershell
node tests/message_learning_store_smoke.js
```

Expected: failure because `src/storage/message_learning_store.js` and schema v17 do not exist.

- [x] **Step 3: Add schema migration 17**

In `src/core/storage.js`, add `MESSAGE_REPLY_LEARNING_SCHEMA` and migration:

```js
{
  version: 17,
  name: "message_reply_learning_v1",
  apply(db) {
    db.exec(MESSAGE_REPLY_LEARNING_SCHEMA);
    backfillCandidateFactRevisions(db);
  }
}
```

Create these tables and indexes:

```text
message_reply_drafts
  id, profile_id, card_id, job_id, message_group_key, draft_index,
  question_summary, message_intent, message_category,
  original_text, current_text, revision, closed_at, created_at, updated_at
  UNIQUE(profile_id, message_group_key, draft_index)

candidate_answer_memories
  id, profile_id, draft_id, final_digest, question_summary,
  message_intent, message_category, original_text, final_text, changed_text,
  scope_json, source, completion_kind, supersedes_memory_id,
  withdrawn_at, created_at, updated_at
  UNIQUE(draft_id, final_digest)

candidate_fact_revisions
  id, profile_id, fact_key, fact_value, operation, source,
  answer_memory_id, evidence_text, withdrawn_at, created_at
```

Required checks:

- `source` on answer memories is `draft_adopted` or `user_edited_reply`;
- `completion_kind` is `copied`, `sent`, or `profile_edit`;
- `operation` is `set` or `delete`;
- all ownership foreign keys reference the existing profile/card/job rows;
- indexes cover open drafts by profile, active memories by profile/update time, and fact revisions by profile/key/time.

`backfillCandidateFactRevisions` creates one `set` revision for each existing `candidate_facts` row without changing that row's current value/source/timestamps.

- [x] **Step 4: Implement the focused store**

Export these exact functions from `src/storage/message_learning_store.js`:

```js
recordMessageReplyDrafts(db, input)
getMessageReplyDraft(db, { profileId, draftId })
listOpenMessageReplyDrafts(db, { profileId, cardId, limit })
saveMessageReplyDraftEdit(db, { profileId, draftId, text, updatedAt })
completeMessageReplyDraft(db, input)
listCandidateAnswerMemories(db, { profileId, activeOnly, source, limit })
reviseCandidateAnswerMemory(db, input)
withdrawCandidateAnswerMemory(db, { profileId, memoryId, withdrawnAt })
listCandidateFactRevisions(db, { profileId, factKey, limit })
deleteCandidateFact(db, { profileId, factKey, source, occurredAt })
closeMessageReplyDrafts(db, { profileId, cardId, closedAt })
```

Use `immediateTransaction` from `src/storage/storage_shared.js`; do not hand-roll a second transaction helper. Validate profile/draft ownership in every mutating function. Normalize draft/final text to 4,000 characters and summaries to 160 characters. Compute `final_digest` with built-in SHA-256.

`completeMessageReplyDraft` accepts already-validated extracted facts and performs, in one transaction:

1. insert or load the idempotent answer memory;
2. append non-duplicate fact revisions only for `user_edited_reply`;
3. project the newest active revision to `candidate_facts`;
4. leave the draft open after `copied`, close it after `sent`.

Do not run a model call inside a database transaction.

- [x] **Step 5: Route every direct fact edit through revision history**

Modify `saveCandidateFact` in `src/storage/candidate_store.js` so a changed value appends a `set` revision and updates `candidate_facts` atomically. Saving the same normalized value/source again is a no-op revision. Keep its current return shape unchanged so existing callers do not break.

Reuse store helpers rather than duplicating projection logic. Do not change fact-key normalization or the 2,000-character value limit.

- [x] **Step 6: Re-export storage functions and update exact export contracts**

Import/re-export the new store functions through `src/core/storage.js`. Update the exact export expectations in `tests/candidate_store_contract_smoke.js` only for intentional new facade exports; keep `candidate_store.js`'s existing public surface stable unless `deleteCandidateFact` must be exposed there.

Update `tests/storage_migration_smoke.js` to assert schema 17 and the three new tables. Replace the stale assertion `SCHEMA_VERSION === SHARED_BOSS_PACING_VERSION` with separate assertions that migration 16 remains the shared pacing migration and migration 17 is the current schema.

- [x] **Step 7: Run targeted storage checks**

```powershell
node tests/message_learning_store_smoke.js
node tests/storage_migration_smoke.js
node tests/candidate_store_contract_smoke.js
```

Expected: all three print their `ok` message and exit 0.

- [x] **Step 8: Commit the storage slice**

```powershell
git add src/core/storage.js src/storage/candidate_store.js src/storage/message_learning_store.js tests/message_learning_store_smoke.js tests/storage_migration_smoke.js tests/candidate_store_contract_smoke.js tests/run_all.js
git commit -m "feat: persist reply learning history"
```

---

## Task 3: Implement the Pure Learning Contract and Completion Service

**Files:**

- Create: `src/core/message_reply_learning.js`
- Create: `src/application/message_learning/index.js`
- Create: `tests/message_reply_learning_smoke.js`
- Modify: `tests/run_all.js`

- [x] **Step 1: Write failing pure-contract and service tests**

Cover these cases in `tests/message_reply_learning_smoke.js`:

- whitespace-only changes are not treated as user edits;
- a corrected phrase produces `changedText` that contains the new wording but not unchanged model wording;
- multiple separated edits may return one conservative span, but never return text absent from the final answer;
- extracted facts are accepted only when the key is already supported by `message_reply_contract`, the evidence occurs in `changedText`, and the value is non-empty;
- invalid/unknown fact keys and evidence copied only from the original model draft are rejected;
- `saveDraft` calls storage only and never calls the extractor;
- `completeDraft` records answer memory even when extraction throws, returning `extractionStatus: "failed"` instead of throwing away the completion;
- unchanged completion does not call the extractor and does not create fact revisions;
- repeated same-text completion returns the existing memory;
- revision/withdraw requests recompute current facts through the store.

- [x] **Step 2: Run the new test and confirm failure**

```powershell
node tests/message_reply_learning_smoke.js
```

Expected: failure because the core contract and application service do not exist.

- [x] **Step 3: Implement pure comparison and extraction validation**

Export from `src/core/message_reply_learning.js`:

```js
normalizeReplyDraftText(value)
replyDraftDigest(value)
replyDraftWasEdited(originalText, finalText)
deriveUserChangedText(originalText, finalText)
validateReplyEditFactExtraction(value, context)
```

Use a longest-common-prefix/longest-common-suffix comparison implemented with standard JavaScript; add no diff dependency. `deriveUserChangedText` returns the conservative final-text span between the unchanged edges, capped at 2,000 characters.

The extraction contract is:

```js
{
  scope: { kind: "global" | "job" | "company" | "experience", key: string },
  facts: [{ factKey, factValue, evidenceText }]
}
```

Only fact keys already accepted by `isKnownFactKey` in `src/core/message_reply_contract.js` may be projected. Export that existing predicate instead of creating a second key registry. `evidenceText` must be a literal substring of `changedText`; invalid entries are dropped. An entirely invalid response returns an empty fact list and a conservative scope, not an exception that blocks completion.

- [x] **Step 4: Implement the application service**

Export this factory from `src/application/message_learning/index.js`:

```js
createMessageReplyLearningService({ db, adapter, logger, now })
```

Return methods:

```js
saveDraft({ profileId, draftId, text })
completeDraft({ profileId, draftId, finalText, completionKind })
listCommunicationProfile({ profileId })
reviseMemory({ profileId, memoryId, finalText })
withdrawMemory({ profileId, memoryId })
saveFact({ profileId, factKey, factValue })
deleteFact({ profileId, factKey })
```

`completeDraft` order is important:

1. load/normalize the durable draft;
2. identify unchanged versus user-edited final text;
3. for an edit, call `adapter.extractReplyEditFacts` outside the transaction;
4. if extraction fails, log only the error code and continue with zero facts;
5. call the storage completion transaction;
6. return `{ memoryId, changed, learnedFactCount, extractionStatus }` with no private answer text.

If the adapter lacks `extractReplyEditFacts`, treat it as an available degradation (`extractionStatus: "unavailable"`), not a configuration failure. The full edited answer still becomes an active answer memory.

- [x] **Step 5: Run the targeted learning checks**

```powershell
node tests/message_reply_learning_smoke.js
node tests/message_learning_store_smoke.js
```

Expected: both pass.

- [x] **Step 6: Commit the learning service slice**

```powershell
git add src/core/message_reply_learning.js src/application/message_learning/index.js tests/message_reply_learning_smoke.js tests/message_learning_store_smoke.js tests/run_all.js
git commit -m "feat: learn from completed reply edits"
```

---

## Task 4: Extract Edited Facts and Reuse Active Answer Memories in Drafting

**Files:**

- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/adapters/models/mock.js`
- Modify: `src/core/message_reply_analyzer.js`
- Modify: `src/core/message_reply_contract.js`
- Modify: `tests/model_adapter_smoke.js`
- Modify: `tests/message_reply_contract_smoke.js`
- Modify: `tests/semantic_pipeline_smoke.js`

- [x] **Step 1: Add failing adapter and contract tests**

Extend the existing tests to prove:

- `extractReplyEditFacts` receives only original/final/changed text plus safe intent/category/scope metadata;
- its OpenAI-compatible prompt says user edits are authoritative, model-originated text is not, evidence must quote the changed span, and unknown facts must remain unclassified;
- mock extraction recognizes at least explicit corrections for current employment status, availability date, current city, expected salary, and travel/relocation/overtime willingness;
- `draftMessageGroup` receives only active `user_edited_reply` memories, not withdrawn or unchanged `draft_adopted` entries;
- a reply output may list `usedMemoryIds`, and the contract rejects IDs that were not supplied;
- existing fact freshness, stable-subject scoping, manual-only categories, and interview-intent protections remain unchanged;
- memory absence remains backward compatible (`usedMemoryIds: []`).

- [x] **Step 2: Run tests and confirm failure**

```powershell
node tests/model_adapter_smoke.js
node tests/message_reply_contract_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: at least the new extraction/memory assertions fail.

- [x] **Step 3: Add the low-cost extraction adapter method**

Implement on both model adapters:

```js
adapter.extractReplyEditFacts(input)
```

The OpenAI-compatible method uses `chatJson(..., { kind: "extractReplyEditFacts" })` and requests only the extraction contract from Task 3. It must not infer facts from `originalText`; each returned `evidenceText` must be copied from `changedText` and will be validated again in core.

The mock method should use small explicit patterns for the five common volatile fact groups above and return no fact when it cannot parse a value. Do not build a general NLP framework.

- [x] **Step 4: Supply bounded active answer memories to the existing analyzer**

In `src/core/message_reply_analyzer.js`:

- accept `answerMemories = []`;
- normalize at most 12 active `user_edited_reply` items;
- include only `id`, safe question summary, intent/category, final answer, scope, and updated time;
- cap total answer-memory text at 8,000 characters;
- clear temporary final-answer strings in `finally` just as incoming message text is cleared.

The drafting prompt may use a memory only when the current recruiter question is semantically the same and the scope matches. It must return `usedMemoryIds` so `validateMessageReply` can verify provenance. Memory-derived text is allowed as a draft source; it does not automatically create a new candidate fact.

- [x] **Step 5: Extend the reply contract without weakening current checks**

Export `isKnownFactKey` from `src/core/message_reply_contract.js`. Normalize `usedMemoryIds` to unique positive integers, verify every used ID exists in the supplied active memory set, and preserve all existing `usedFactKeys`, freshness, missing-fact, category, coverage, and intent validation.

- [x] **Step 6: Run the targeted model/contract checks**

```powershell
node tests/model_adapter_smoke.js
node tests/message_reply_contract_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: all pass.

- [x] **Step 7: Commit the model integration slice**

```powershell
git add src/adapters/models/openai_compatible.js src/adapters/models/mock.js src/core/message_reply_analyzer.js src/core/message_reply_contract.js tests/model_adapter_smoke.js tests/message_reply_contract_smoke.js tests/semantic_pipeline_smoke.js
git commit -m "feat: reuse confirmed reply memories"
```

---

## Task 5: Persist Drafts in the Existing Message Discovery Flow

**Files:**

- Modify: `src/core/message_discovery.js`
- Modify: `src/dashboard/message_discovery_controller.js`
- Modify: `tests/message_discovery_smoke.js`
- Modify: `tests/dashboard_message_discovery_smoke.js`

- [x] **Step 1: Add failing discovery persistence tests**

Extend core and controller tests to assert:

- after `recordDiscoveredMessageGroupClassification`, reply messages are persisted as draft rows before the source objects are cleared;
- safe draft identity uses `messageGroupKey`, card/job/profile, safe `messageSummary`, intent, and category;
- the result sent to `pageState` contains `{ id, text, revision }` draft objects;
- the result sent to public `/api/message-discovery-status` contains neither draft text nor answer memory text;
- rebuilding a controller over the same database restores open drafts without rerunning BOSS discovery;
- dismiss closes visible drafts; marking a card sent closes its drafts; copying does not close them;
- manual-only and missing-fact results create no drafts;
- active answer memories are loaded from storage and supplied to `classifyMessageGroup`;
- raw incoming HR text is still cleared and absent from persistent tables.

- [x] **Step 2: Run tests and confirm failure**

```powershell
node tests/message_discovery_smoke.js
node tests/dashboard_message_discovery_smoke.js
```

Expected: new durable-draft assertions fail.

- [x] **Step 3: Persist drafts immediately after classification**

In `src/core/message_discovery.js`, keep the existing classification and candidate-progress call order. After the progress card is recorded and before `safeResult` is emitted:

```js
const drafts = recordMessageReplyDrafts(db, {
  profileId,
  cardId: card.id,
  jobId: card.jobId,
  messageGroupKey: incoming.messageGroupKey,
  questionSummary: classification.messageSummary,
  messageIntent: classification.messageIntent,
  messageCategory: classification.messageCategory,
  messages: safeDraftMessages(classification),
  createdAt: now()
});
```

Change `safeResult` to expose `drafts`, not a second free-floating `messages` copy. Keep the two-draft limit. The storage schema receives no conversation row text or recruiter identity.

Load active `user_edited_reply` memories once per profile/run and supply them to the analyzer. Refresh the bounded list after each completed browser group only if the run itself can observe a local completion; otherwise the next discovery run loads the new values. Current `candidate_facts` remain the first structured source.

- [x] **Step 4: Make the controller's page state durable and its JSON private**

Update `sanitizeResults`, `pageRun`, `durableStatus`, `dismiss`, and `clearDraftForCard`:

- page-only results may include sanitized draft id/text/revision;
- `publicRun` retains the current metadata-only projection;
- `durableStatus` groups `listOpenMessageReplyDrafts` by card and reconstructs enough safe job understanding from existing local job/progress data to render after a restart; export and reuse the existing `projectMessageDecisionCard` helper rather than duplicating job-analysis wording in the controller;
- dismiss/clear call `closeMessageReplyDrafts` rather than only mutating the in-memory result.

Do not persist whole controller runs or raw browser snapshots.

- [x] **Step 5: Run targeted discovery tests**

```powershell
node tests/message_discovery_smoke.js
node tests/dashboard_message_discovery_smoke.js
node tests/message_preview_state_smoke.js
```

Expected: all pass and the public JSON privacy assertions remain green.

- [x] **Step 6: Commit the discovery slice**

```powershell
git add src/core/message_discovery.js src/dashboard/message_discovery_controller.js tests/message_discovery_smoke.js tests/dashboard_message_discovery_smoke.js
git commit -m "feat: keep message reply drafts across restarts"
```

---

## Task 6: Add Editable Drafts, Completion Triggers, and “我的沟通资料”

**Files:**

- Create: `src/dashboard/communication_profile_view.js`
- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `src/dashboard/server.js`
- Modify: `tests/dashboard_message_discovery_smoke.js`
- Create: `tests/dashboard_communication_profile_smoke.js`
- Modify: `tests/run_all.js`

- [x] **Step 1: Write failing HTTP and client interaction tests**

Use the existing Dashboard fake request/client harnesses to assert:

- draft textareas are editable and identified by durable draft IDs;
- input waits 600 ms and posts the latest text to `/api/message-reply-draft` with action `save`; rapid input sends only the latest value;
- copy writes to the clipboard immediately, then posts action `complete` with `completionKind=copied`;
- a completion/extraction failure does not undo the clipboard copy and shows “已复制；这次修改暂未保存，请稍后重试”; success shows “已记住你这次修改的回答” only when changed;
- “已手动发送” completes the current final text with `completionKind=sent`, records the existing progress event once, then closes the draft;
- neither action sends text to BOSS or calls a browser adapter;
- GET `/communication-profile?profileId=...` shows user-facing answer/fact labels and values but not fact keys, digests, confidence, raw JSON, or model internals;
- editing/removing an answer and editing/removing a current fact updates the local profile and later drafting input;
- profile ownership mismatches return 404/409 without modifying another profile;
- the public discovery status response still excludes all private text.

Add `dashboard_communication_profile_smoke.js` to `tests/run_all.js` next to the message-discovery Dashboard test.

- [x] **Step 2: Run UI/API tests and confirm failure**

```powershell
node tests/dashboard_message_discovery_smoke.js
node tests/dashboard_communication_profile_smoke.js
```

Expected: failures because the endpoints/view/edit behavior do not exist.

- [x] **Step 3: Construct one learning service in the Dashboard server**

In `createDashboardServer`, add an injectable `messageReplyLearningService` for tests. The default creates one service with the current deep-analysis adapter:

```js
const replyLearning = messageReplyLearningService || createMessageReplyLearningService({
  db,
  adapter: createModelAdapter(getRuntimeModel("deep_analysis"), { logger }),
  logger
});
```

Resolve the adapter per completion if runtime model settings can change while the server remains open; do not cache credentials or duplicate the model-settings system. When no verified model is available, use the service's `unavailable` extraction degradation and still save the answer memory.

- [x] **Step 4: Add narrow local routes**

Add:

```text
POST /api/message-reply-draft
  action=save | complete
  profileId, draftId, text
  completionKind=copied | sent (complete only)

GET /communication-profile?profileId=...

POST /api/communication-profile
  action=revise_memory | withdraw_memory | save_fact | delete_fact
```

Return JSON from the draft endpoint:

```js
{ ok: true, draftId, revision, changed, learnedFactCount, extractionStatus }
```

Never return original/final answer text from mutation endpoints. Enforce the same maximum body size already used by other small Dashboard forms.

For `reply_confirmed_sent`, use one server path that completes the selected durable draft and records `recordManualProgressAction` with the existing idempotency key. If extraction fails, keep the progress action and saved answer memory; do not make the user confirm again. Do not reuse historical completion to authorize any BOSS operation.

- [x] **Step 5: Render editable drafts and lightweight feedback**

In `src/dashboard/message_discovery_view.js`:

- replace `readonly` message strings with editable durable draft textareas;
- attach `data-draft-id`, current revision, and one copy button to each draft;
- attach the selected draft's ID/text to the “已手动发送” form;
- add a “管理我的沟通资料” link;
- keep the existing conclusion/job-information-first layout and manual BOSS paste wording.

Client behavior:

1. debounce local save by 600 ms;
2. clipboard copy happens first;
3. completion request follows and updates one `aria-live` message;
4. save failures leave the user's textarea intact;
5. page navigation/submit flushes the latest text once;
6. no extra confirmation dialog.

- [x] **Step 6: Render the communication profile page**

`src/dashboard/communication_profile_view.js` should show:

- “我目前使用的沟通资料”: current candidate fact labels and editable values;
- “我改过并让 RoleFlow 记住的回答”: active user-edited answers with question summary, final wording, scope description, updated time, edit, and “不再使用” action;
- a collapsed or secondary “历史修改” view sourced from fact revisions, using natural labels rather than internal keys.

Do not show unchanged adopted drafts as authoritative answers. They may contribute to future quality statistics but stay out of the main page. A removed/withdrawn answer must no longer be supplied to drafting; its historical row remains for traceability.

- [x] **Step 7: Run UI/API regression checks**

```powershell
node tests/dashboard_message_discovery_smoke.js
node tests/dashboard_communication_profile_smoke.js
node tests/message_reply_learning_smoke.js
```

Expected: all pass.

- [x] **Step 8: Commit the user-facing slice**

```powershell
git add src/dashboard/communication_profile_view.js src/dashboard/message_discovery_view.js src/dashboard/server.js tests/dashboard_message_discovery_smoke.js tests/dashboard_communication_profile_smoke.js tests/run_all.js
git commit -m "feat: learn from edited message drafts"
```

---

## Task 7: Document, Review, and Verify the Completed Stage

**Files:**

- Modify: `docs/resume_and_feedback_workflow.md`
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/NEXT_PHASE.md`
- Modify if actual implementation differs: `docs/superpowers/specs/2026-08-28-roleflow-learning-loop-design.md`
- Modify if actual implementation differs: `docs/superpowers/plans/2026-08-28-message-reply-learning-loop.md`

- [x] **Step 1: Update user and handoff documentation**

Document the exact shipped behavior:

- editable/autosaved local reply drafts;
- completion on copy/manual-send with no second confirmation;
- unchanged model drafts are not authoritative facts;
- edited answers survive extraction failure;
- current facts plus revision history and communication-profile management;
- later drafts reuse only active user-edited memories/current facts;
- real BOSS sending remains manual and was not authorized or added;
- stage two remains separate.

Update authoritative SHA/test counts only after the final commit exists. Do not claim real-platform acceptance.

- [x] **Step 2: Run a focused review of the complete diff**

Review from the stage-one base:

```powershell
git diff 24c41b6..HEAD -- src tests docs
```

Check specifically for:

- raw HR text accidentally persisted/logged/returned;
- draft completion updating facts before user copy/send;
- unchanged model text becoming authoritative;
- a model failure blocking copy/manual-send;
- duplicate memories or revisions;
- withdrawn data still entering model input;
- any browser send/fill/paste action;
- speculative analytics/résumé/interview code;
- new dependencies or abstractions not justified by Task 1.

- [x] **Step 3: Run all targeted checks together**

```powershell
node tests/message_learning_store_smoke.js
node tests/message_reply_learning_smoke.js
node tests/model_adapter_smoke.js
node tests/message_reply_contract_smoke.js
node tests/message_discovery_smoke.js
node tests/dashboard_message_discovery_smoke.js
node tests/dashboard_communication_profile_smoke.js
node tests/storage_migration_smoke.js
```

Expected: every test prints `ok` and exits 0.

- [x] **Step 4: Run the full offline gate**

```powershell
npm test
```

Expected: all registered offline checks pass. Record the actual total; do not reuse an older count.

- [x] **Step 5: Run repository cleanliness checks**

```powershell
git diff --check
git status --short
```

Expected before the documentation commit: `git diff --check` has no output; `git status --short` lists only intentional documentation updates.

- [x] **Step 6: Commit final documentation**

```powershell
git add docs/resume_and_feedback_workflow.md docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md docs/superpowers/specs/2026-08-28-roleflow-learning-loop-design.md docs/superpowers/plans/2026-08-28-message-reply-learning-loop.md
git commit -m "docs: hand off reply learning loop"
```

- [x] **Step 7: Re-run completion evidence on the exact final SHA**

```powershell
git rev-parse HEAD
npm test
git diff --check
git status --short --branch
```

Expected: full gate passes on the reported SHA, no diff-check errors, and the worktree is clean. State explicitly that no real BOSS page was accessed in this stage.

- [x] **Step 8: Stop before external integration**

Do not push, merge, tag, build an installer, or create a Release as part of this plan. Those are later external/integration actions and require a fresh check of the then-current branch, release scope, and user authorization.
