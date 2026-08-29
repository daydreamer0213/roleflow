# Message Discovery And Confirmed Reply Sending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the current visible BOSS message rows into truthful reply/read/delivered projections, show pending HR content beside the existing job analysis and editable draft, and send only a user-confirmed immutable single-item or batch reply through the fixed background message tab.

**Architecture:** Extend the existing message DOM snapshot instead of adding another scraper. Keep discovery, durable inbound display context, immutable reply-send batches, BOSS page mutation, serial execution, and Dashboard composition as separate small owners; reuse the existing SQLite, candidate progress, learning service, fixed-tab guard, access controller, pacing policy, and server-rendered UI.

**Tech Stack:** Node.js 22+, CommonJS, `node:sqlite`, server-rendered Dashboard HTML/JavaScript, existing Edge Control/CDP adapter, assertion-based offline smoke checks.

## Global Constraints

- Discovery remains read-only. No real BOSS text is filled or sent during implementation or automated verification.
- A real reply can occur only after the final user clicks the single-item or batch confirmation for an immutable set of draft revisions.
- Keep exactly one `BOSS-SEARCH` and one `BOSS-COMMUNICATION` in one Edge window; never call `Page.bringToFront` during discovery or reply execution.
- Reply execution is serial and keeps the existing random pacing, cooldown, access budget, checkpoint, login/risk/page-loss stop rules.
- Never automatically retry an item after `click_dispatched` or an ambiguous result.
- Read and delivered rows remain counts plus funnel evidence; they do not render per-job cards.
- Plain HR text may persist only in local open inbound context and must not enter public status, diagnostics, answer memories, facts, or ordinary logs.
- Do not automate résumé accept/reject, attachment upload, application, interview acceptance, or any other BOSS action.
- Reuse the modular monolith. Add no dependency, ORM, queue service, frontend framework, microservice, or model call.
- Preserve current copy and manual-sent flows.
- Do not push, merge, package, change the version, or create a release.

---

## File Structure

- `src/adapters/sites/boss_message_dom.js`: one live page snapshot contract for row identity, job identity, last-message direction/status, detail messages, editor, and send button.
- `src/adapters/sites/boss_message_reader.js`: fixed-tab guarded row scan and conversation selection; no reply mutation.
- `src/adapters/sites/boss_message_reply_sender.js`: the only owner of editor fill, guarded send click, and post-click DOM verification.
- `src/core/message_preview_state.js`: discovery queue and first-run/changed-preview rules.
- `src/core/funnel_observation.js`: map list-row status directly to the correct local progress card and record idempotent observations.
- `src/core/message_discovery.js`: orchestrate counts, HR detail reads, safe model input, inbound display context, and draft creation.
- `src/storage/message_reply_send_store.js`: durable inbound contexts plus reply batch/item persistence and transitions.
- `src/core/message_reply_send_batches.js`: validation and state-machine rules over the storage owner.
- `src/core/message_reply_send_executor.js`: serial orchestration and stop/no-retry behavior; no HTML or raw DOM.
- `src/application/message_reply_sending/index.js`: create authorized batches, compose verified success with the existing learning service, and expose local status/control.
- `src/dashboard/message_reply_send_controller.js`: in-process run ownership, browser composition, and public-safe status.
- `src/dashboard/message_discovery_controller.js`: include durable inbound display contexts and discovery counts in page-only state.
- `src/dashboard/message_discovery_view.js`: HR original/summary, job analysis, draft controls, batch bar, and status polling.
- `src/dashboard/server.js`: local APIs and controller composition only.

---

### Task 1: Calibrate The Message Row Contract And Three-Way Counts

**Files:**
- Modify: `tests/fixtures/boss_message_dom_fixture.js`
- Modify: `tests/boss_message_dom_smoke.js`
- Modify: `tests/boss_message_reader_smoke.js`
- Modify: `tests/message_preview_state_smoke.js`
- Modify: `tests/funnel_message_observation_smoke.js`
- Modify: `tests/message_discovery_smoke.js`
- Modify: `src/adapters/sites/boss_message_dom.js`
- Modify: `src/adapters/sites/boss_message_reader.js`
- Modify: `src/core/message_preview_state.js`
- Modify: `src/core/funnel_observation.js`
- Modify: `src/core/message_discovery.js`

**Interfaces:**
- Produces each snapshot row with `sourceJobId`, `lastMessageId`, `lastMessageDirection`, `lastMessageStatus`, and `identityVerified` in addition to the current digest fields.
- Produces discovery counters `{ visible, newReplies, currentRead, currentDelivered, unbound }`.
- Keeps `scanConversationRows()` and `openQueuedConversation(target)` as the read-only browser interface consumed by later tasks.

- [x] **Step 1: Extend the real-structure fixture and write failing DOM/reader assertions**

Add a `source` object to each fixture `boss-item` Vue component and assert the wished-for normalized row shape:

```js
assert.equal(snapshot.rows[0].sourceJobId, "boss:encrypt-job-a");
assert.equal(snapshot.rows[0].lastMessageId, "378917037748737");
assert.equal(snapshot.rows[0].lastMessageDirection, "friend");
assert.equal(snapshot.rows[0].lastMessageStatus, "unknown");
assert.equal(snapshot.rows[0].identityVerified, true);
assert.match(snapshot.rows[0].conversationKey, /^sha256:[a-f0-9]{64}$/);
assert.equal(snapshot.rows[1].lastMessageDirection, "myself");
assert.equal(snapshot.rows[1].lastMessageStatus, "delivered");
assert.equal(snapshot.rows[2].lastMessageStatus, "read");
```

Assert that a mismatch between Vue `lastMsgStatus` and the visible `.status-read` / `.status-delivery` class returns `BOSS_MESSAGE_STRUCTURE_CHANGED` before any guarded click.

- [x] **Step 2: Run the row tests and verify RED**

Run:

```powershell
node tests/boss_message_dom_smoke.js
node tests/boss_message_reader_smoke.js
```

Expected: failure because the five new row fields do not exist and the current conversation digest still falls back to the visible title.

- [x] **Step 3: Implement the smallest verified row projection**

Inside `BOSS_MESSAGE_PAGE_HELPERS_EXPRESSION`, read `row.__vue__?.source` or `row.__vue__?.$props?.source`; require a non-empty `uniqueId`, a safe `encryptJobId`, and a 15-digit `lastMsgId` for `identityVerified: true`. Derive:

```js
const sourceJobId = source.encryptJobId ? `boss:${source.encryptJobId}` : "";
const lastMessageDirection = source.lastIsSelf === true ? "myself"
  : source.lastIsSelf === false ? "friend" : "unknown";
const lastMessageStatus = lastMessageDirection !== "myself" ? "unknown"
  : Number(source.lastMsgStatus) === 2 ? "read"
  : Number(source.lastMsgStatus) === 1 ? "delivered" : "unknown";
const conversationKey = source.uniqueId
  ? rowKey("conversation", [], row, `id:${source.uniqueId}`)
  : legacyConversationKey(row, recruiterLabel);
```

Keep the legacy digest only for read-only discovery compatibility and set `identityVerified: false`; later send code must reject it.

- [x] **Step 4: Write failing discovery/funnel assertions**

Add cases proving:

```js
assert.deepStrictEqual(planMessageDiscoveryQueue({ rows: [firstFriendRow], baselines: new Map() }).queue
  .map((item) => item.operation), ["initial_incoming"]);
assert.deepStrictEqual(status.counters, {
  visible: 3,
  newReplies: 1,
  currentRead: 1,
  currentDelivered: 1,
  unbound: 0
});
```

In `funnel_message_observation_smoke.js`, create a card with no `thread_key` but a job whose `source_id` equals the row `sourceJobId`; expect the row to bind the thread and record `outbound_read_observed`. Repeating the same message/status must remain idempotent, while the same message changing delivered to read must record the second state.

- [x] **Step 5: Run the discovery tests and verify RED**

Run:

```powershell
node tests/message_preview_state_smoke.js
node tests/funnel_message_observation_smoke.js
node tests/message_discovery_smoke.js
```

Expected: the first incoming row is currently baselined, source-job mapping is unavailable, and discovery has no counters.

- [x] **Step 6: Implement first-run incoming, direct job binding, and counters**

Make `planMessageDiscoveryQueue()` queue a verified first-run friend row as `initial_incoming`; continue baselining first-run self-read/self-delivered rows. In `recordFunnelRowObservations()`, resolve exactly one card by `(profile_id, jobs.source='boss', jobs.source_id=row.sourceJobId)` before the existing thread fallback, bind an empty thread with `bindProgressCardThread()`, and skip conflicting/multiple mappings.

Count the visible row snapshot in `runBossMessageDiscovery()` and increment `newReplies` only after a previously unprocessed HR group is recorded. Return the counters from running, completed, stopped, public-safe, and durable status without returning row text or recruiter labels.

- [x] **Step 7: Run the focused tests and commit**

Run:

```powershell
node tests/boss_message_dom_smoke.js
node tests/boss_message_reader_smoke.js
node tests/message_preview_state_smoke.js
node tests/funnel_message_observation_smoke.js
node tests/message_discovery_smoke.js
```

Commit:

```powershell
git add src/adapters/sites/boss_message_dom.js src/adapters/sites/boss_message_reader.js src/core/message_preview_state.js src/core/funnel_observation.js src/core/message_discovery.js tests/fixtures/boss_message_dom_fixture.js tests/boss_message_dom_smoke.js tests/boss_message_reader_smoke.js tests/message_preview_state_smoke.js tests/funnel_message_observation_smoke.js tests/message_discovery_smoke.js
git commit -m "feat: classify visible message outcomes"
```

---

### Task 2: Persist Open HR Display Context And Immutable Reply Batches

**Files:**
- Create: `src/storage/message_reply_send_store.js`
- Create: `tests/message_reply_send_store_smoke.js`
- Modify: `src/core/storage.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/candidate_store_contract_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces `saveMessageInboundContext`, `getMessageInboundContext`, `listMessageInboundContexts`, and `deleteMessageInboundContext`.
- Produces `createMessageReplySendBatch`, `getMessageReplySendBatch`, `listMessageReplySendItems`, `transitionMessageReplySendBatch`, `transitionMessageReplySendItem`, and `stopPendingMessageReplySendItems`.
- Migration version is exactly `22`, named `message_reply_sending_v1`.

- [x] **Step 1: Write the failing migration and storage contract**

Add version 22 to the expected migration ledger and assert the fresh schema contains these tables:

```sql
CREATE TABLE message_inbound_contexts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  message_group_key TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  last_message_id TEXT NOT NULL,
  message_intent TEXT NOT NULL,
  message_category TEXT NOT NULL,
  display_json TEXT NOT NULL,
  manual_actions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, card_id, message_group_key)
);
CREATE TABLE message_reply_send_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('confirmed','running','completed','stopped','interrupted')),
  stop_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE message_reply_send_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  draft_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  conversation_key TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  expected_last_message_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL,
  reply_text TEXT NOT NULL,
  reply_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','selecting','verified','filled','click_dispatched','succeeded','target_mismatch','platform_rejected','ambiguous','stopped')),
  click_count INTEGER NOT NULL DEFAULT 0 CHECK(click_count IN (0,1)),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id, position),
  UNIQUE(batch_id, draft_id)
);
```

Add a partial unique index preventing one draft from appearing in two nonterminal items.

- [x] **Step 2: Run migration/storage tests and verify RED**

Run:

```powershell
node tests/storage_migration_smoke.js
node tests/message_reply_send_store_smoke.js
```

Expected: schema version remains 21 and the new store module/tables do not exist.

- [x] **Step 3: Implement migration 22 and the store owner**

Use one `MESSAGE_REPLY_SENDING_SCHEMA` constant in `src/core/storage.js`, append migration 22, and keep all SQL row mapping/transition compare-and-set logic in `src/storage/message_reply_send_store.js`.

Validate inbound display entries to only allow:

```js
{ kind: "text", text: "non-empty up to 4000 chars" }
{ kind: "resume_request", text: "HR 邀请你发送简历" }
```

Validate every digest, 15-digit message ID, positive owner ID, draft revision, reply length, state edge, and `click_count` invariant. Store error/evidence values only after length-limiting and JSON normalization.

- [x] **Step 4: Prove immutable batch rows and privacy behavior**

Create two open drafts plus inbound contexts, call:

```js
const batch = createMessageReplySendBatch(db, {
  profileId,
  items: [
    { draftId: first.id, revision: first.revision },
    { draftId: second.id, revision: second.revision }
  ],
  createdAt: now
});
```

Assert order, frozen text/digests/targets, duplicate-open rejection, revision conflict, terminal transition release, compare-and-set conflicts, click count never exceeding one, and that list/get mappers do not expose raw inbound display context.

- [x] **Step 5: Export the exact store facade and register the test**

Expose the ten interfaces listed above through `src/core/storage.js`. Update the existing storage facade contract to the new exact export set rather than weakening it to a lower-bound assertion. Add `message_reply_send_store_smoke.js` to `tests/run_all.js` beside the existing message learning store check.

- [x] **Step 6: Run focused tests and commit**

Run:

```powershell
node tests/storage_migration_smoke.js
node tests/message_reply_send_store_smoke.js
node tests/candidate_store_contract_smoke.js
```

Commit:

```powershell
git add src/core/storage.js src/storage/message_reply_send_store.js tests/storage_migration_smoke.js tests/message_reply_send_store_smoke.js tests/candidate_store_contract_smoke.js tests/run_all.js
git commit -m "feat: persist authorized reply batches"
```

---

### Task 3: Retain HR Original Only For Open Work And Render The Complete Card

**Files:**
- Modify: `src/core/message_discovery.js`
- Modify: `src/dashboard/message_discovery_controller.js`
- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `src/storage/message_learning_store.js`
- Modify: `src/application/message_learning/index.js`
- Modify: `tests/message_discovery_smoke.js`
- Modify: `tests/message_learning_store_smoke.js`
- Modify: `tests/dashboard_message_discovery_smoke.js`
- Modify: `tests/dashboard_communication_profile_smoke.js`

**Interfaces:**
- `runBossMessageDiscovery()` saves display messages before clearing model input text.
- Page-only result property is `inboundMessages: Array<{kind:'text'|'resume_request', text:string}>`.
- Public `/api/message-discovery-status` continues to omit `inboundMessages` and all draft text.
- Draft completion/dismissal deletes inbound context when no open draft in that message group remains.

- [x] **Step 1: Write failing privacy and rendering assertions**

Assert a normal HR group renders its exact text under “HR 消息”, while a verified resume card renders only `HR 邀请你发送简历`. Assert the current safe `messageSummary` remains deterministic and the original text is absent from:

```js
assert(!JSON.stringify(controller.status(profileId)).includes(hrText));
assert(!diagnosticsResponseBody.includes(hrText));
assert(!JSON.stringify(listCandidateAnswerMemories(db, {
  profileId,
  activeOnly: false
})).includes(hrText));
```

In the server smoke test, obtain `diagnosticsResponseBody` by calling the existing runtime-diagnostics endpoint through the test HTTP client before making the assertion.

Refresh the page through `controller.pageState(profileId)` and expect the inbound content to remain until its last draft is completed or dismissed.

- [x] **Step 2: Run the message/card tests and verify RED**

Run:

```powershell
node tests/message_discovery_smoke.js
node tests/message_learning_store_smoke.js
node tests/dashboard_message_discovery_smoke.js
```

Expected: current discovery clears the HR text before durable storage and the view has no HR-message section.

- [x] **Step 3: Save a narrow display projection before clearing model input**

Immediately before the existing `finally` block clears selected message text, build:

```js
const inboundMessages = incoming.messages.map((message) => ({ kind: "text", text: message.text }));
for (const action of incoming.manualActions) {
  if (action.kind === "resume_request") inboundMessages.push({
    kind: "resume_request",
    text: "HR 邀请你发送简历"
  });
}
```

Save it with the canonical conversation key, BOSS source job ID, last incoming message ID, classification, and safe manual actions. Do not save recruiter label, security ID, preview text, or platform card raw text.

- [x] **Step 4: Load and purge contexts with open drafts**

Make `durableStatus()` merge `listMessageInboundContexts()` with open drafts and the existing job projection. After `completeDraft()` closes a message group, call a store helper inside the same completion transaction to delete the context only when no open sibling draft remains. Make discovery dismiss delete the displayed contexts it closes.

- [x] **Step 5: Render original, job analysis, and send-ready controls**

Update each HR result card to this order:

```html
<section class="message-inbound"><h3>HR 消息</h3><p>方便介绍一下跨境电商项目吗？</p></section>
<section class="message-job-understanding"><h3>岗位理解</h3><p>跨境电商运营；工作安排未确认；系统评价：可投。</p></section>
<section class="message-draft"><h3>回复草稿</h3><textarea>我负责过跨境电商项目，可以具体介绍。</textarea></section>
```

Show explicit JD-backed work-schedule text if the existing analysis supplies it; otherwise show `工作安排未确认`. Add `data-send-single`, `data-send-select`, and `data-draft-revision` attributes only for editable, non-manual-only drafts. Keep copy and manual-sent buttons.

- [x] **Step 6: Run focused tests and commit**

Run:

```powershell
node tests/message_discovery_smoke.js
node tests/message_learning_store_smoke.js
node tests/dashboard_message_discovery_smoke.js
node tests/dashboard_communication_profile_smoke.js
```

Commit:

```powershell
git add src/core/message_discovery.js src/dashboard/message_discovery_controller.js src/dashboard/message_discovery_view.js src/storage/message_learning_store.js src/application/message_learning/index.js tests/message_discovery_smoke.js tests/message_learning_store_smoke.js tests/dashboard_message_discovery_smoke.js tests/dashboard_communication_profile_smoke.js
git commit -m "feat: show pending HR message context"
```

---

### Task 4: Create The Reply Batch Application Contract

**Files:**
- Create: `src/core/message_reply_send_batches.js`
- Create: `src/application/message_reply_sending/index.js`
- Create: `tests/message_reply_send_service_smoke.js`
- Modify: `src/application/message_learning/index.js`
- Modify: `tests/message_reply_learning_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- `createMessageReplySendingService({db, learningService, now, executeBatch})`.
- `confirmBatch({profileId, items:Array<{draftId:number, revision:number}>})` returns the immutable batch snapshot and starts only the injected executor callback.
- `status({profileId,batchId})` returns batch/item local state without `replyText`.
- `stop({profileId,batchId})` stops only undispatched items.
- `completeVerifiedItem({batchId,itemId})` completes learning with the frozen reply and `completionKind:'sent'`.

- [x] **Step 1: Write the failing service contract**

Create two open drafts and assert:

```js
const confirmed = service.confirmBatch({
  profileId,
  items: [{ draftId: draft.id, revision: draft.revision }]
});
assert.equal(confirmed.batch.status, "confirmed");
assert(!JSON.stringify(service.status({ profileId, batchId: confirmed.batch.id })).includes(finalText));
```

Add rejection checks for closed drafts, another profile, stale revision, missing inbound context, missing verified row identity, empty text, duplicate draft, and more than 50 items.

- [x] **Step 2: Run the service tests and verify RED**

Run:

```powershell
node tests/message_reply_send_service_smoke.js
```

Expected: application service and batch state owner do not exist.

- [x] **Step 3: Implement state edges and immutable confirmation**

Define explicit state edges in `message_reply_send_batches.js`; reject every unlisted edge. `confirmBatch()` accepts only IDs/revisions, loads current text and target context server-side, creates one transactionally frozen batch, and invokes `executeBatch(batch.id)` only after commit. It must not accept client-supplied reply text, conversation key, source job ID, or last message ID.

- [x] **Step 4: Compose verified success with current learning semantics**

Expose a transaction-capable path from the learning service so `completeVerifiedItem()` uses the frozen text and runs all three local mutations in its existing `afterComplete` SQLite transaction: record the same confirmed-sent progress event used by the manual path with idempotency key `message-reply-send:${batch.id}:${item.id}`; move this exact item from `click_dispatched` to `succeeded`; query the open drafts for the same message group and call `deleteMessageInboundContext()` only when none remain. Pass the concrete `batch.id`, `item.id`, `item.cardId`, `item.draftId`, `batch.profileId`, and completion timestamp to those current store functions—do not introduce a second progress-event implementation.

If fact extraction fails, preserve the existing behavior: the complete user answer is retained, extraction status is reported, and the verified external send is not rolled back or retried.

- [x] **Step 5: Prove idempotency and atomicity**

Assert duplicate `completeVerifiedItem()` returns the existing success without a second memory/progress event. Inject a failure in `afterComplete` and assert the local draft, memory, progress event, and item success all roll back while the item remains non-retryable.

- [x] **Step 6: Run focused tests and commit**

Run:

```powershell
node tests/message_reply_send_service_smoke.js
node tests/message_reply_learning_smoke.js
```

Commit:

```powershell
git add src/core/message_reply_send_batches.js src/application/message_reply_sending/index.js src/application/message_learning/index.js tests/message_reply_send_service_smoke.js tests/message_reply_learning_smoke.js tests/run_all.js
git commit -m "feat: authorize immutable message replies"
```

---

### Task 5: Implement The Background BOSS Reply Sender

**Files:**
- Create: `src/adapters/sites/boss_message_reply_sender.js`
- Create: `tests/boss_message_reply_sender_smoke.js`
- Modify: `src/adapters/sites/boss_message_reader.js`
- Modify: `tests/boss_message_reader_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- `createBossMessageReplySender({browser, reader, sleepFn})`.
- `inspectReplyTarget(item, signal)` returns an opaque inspection bound to the exact live row/detail/editor state.
- `fillReply(inspection, replyText, signal)` returns an opaque filled preparation after exact read-back.
- `dispatchReply(preparation, signal)` performs at most one guarded send-button click.
- `verifyReplyResult(preparation, signal)` returns `{state:'succeeded'|'target_mismatch'|'platform_rejected'|'ambiguous', evidence}`.
- `clearPreparedReply(preparation)` clears only text proven to have been inserted by this preparation and only before click dispatch.

- [x] **Step 1: Write a fake-browser RED suite around the desired sender API**

Cover exact conversation/job/last-message matching, selected detail matching, empty editor requirement, contenteditable availability, no `Page.bringToFront`, exact whitespace-folded read-back, one click, new outgoing 15-digit message ID, and matching reply digest.

Assert the production change that makes each check fail: removing the identity recheck, changing the text after fill, clicking twice, accepting the old message ID, or using the wrong conversation must make the test fail.

- [x] **Step 2: Run the sender test and verify RED**

Run:

```powershell
node tests/boss_message_reply_sender_smoke.js
```

Expected: module not found.

- [x] **Step 3: Add a guarded reply-target selector without widening discovery clicks**

Reuse `scanConversationRows()` and the reader's provenance set. Match exactly one verified row by all of:

```js
row.conversationKey === item.conversationKey
row.sourceJobId === item.sourceJobId
row.lastMessageId === item.expectedLastMessageId
row.lastMessageDirection === "friend"
row.identityVerified === true
```

Call `openQueuedConversation({ conversationKey: row.conversationKey, sourceJobId: row.sourceJobId, lastMessageId: row.lastMessageId, rowIndex: row.rowIndex, operation: 'authorized_reply' })`, then confirm the selected detail source job and last HR message again.

- [x] **Step 4: Fill through CDP without foreground activation**

Require `browser.cdp` and `browser.clickAt`. Use `Emulation.setFocusEmulationEnabled`, focus only `#chat-input`, call `Input.insertText`, then immediately disable focus emulation. Read back `innerText`, normalize with the existing folded-whitespace digest, and return no public raw text.

Do not use `Page.bringToFront`, clipboard paste, keyboard shortcuts, or direct Vue method calls.

- [x] **Step 5: Guard the single click and verify DOM success**

`dispatchReply()` must re-evaluate selected conversation identity, expected last HR message, editor digest, editor visibility, send-button uniqueness, and risk/login state, then return a click point. The method calls `browser.clickAt()` exactly once.

`verifyReplyResult()` accepts success only when the same selected conversation contains a new `.message-item.item-myself` with a new 15-digit `data-mid` and a folded-whitespace digest equal to the authorized reply. Without this proof return `ambiguous`; do not guess a network endpoint.

- [x] **Step 6: Run focused tests and commit**

Run:

```powershell
node tests/boss_message_reader_smoke.js
node tests/boss_message_reply_sender_smoke.js
node tests/boss_communication_page_smoke.js
```

Commit:

```powershell
git add src/adapters/sites/boss_message_reader.js src/adapters/sites/boss_message_reply_sender.js tests/boss_message_reader_smoke.js tests/boss_message_reply_sender_smoke.js tests/run_all.js
git commit -m "feat: add guarded background reply sender"
```

---

### Task 6: Execute Confirmed Replies Serially And Stop Safely

**Files:**
- Create: `src/core/message_reply_send_executor.js`
- Create: `tests/message_reply_send_executor_smoke.js`
- Modify: `src/core/product_policy.js`
- Modify: `tests/site_access_budget_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- `runMessageReplySendBatch({db,batchId,sender,accessController,onVerifiedSuccess,sleepFn,randomFn,signal,logger})`.
- Uses the Task 4 batch/item state owner and Task 5 sender interfaces exactly.
- Returns public-safe batch summary; never returns reply text.

- [x] **Step 1: Write executor RED cases**

Cover:

```js
pending -> selecting -> verified -> filled -> click_dispatched -> succeeded
```

and assert fixed order, one reservation per item, random inter-item wait, user stop before click, target drift before fill, existing editor text, risk/login/page loss, explicit rejection, post-click ambiguity, process abort, stale nonterminal restart, and local verified-success failure.

For every post-click failure assert later items remain undispatched and the current item is never returned to `pending`.

- [x] **Step 2: Run executor tests and verify RED**

Run:

```powershell
node tests/message_reply_send_executor_smoke.js
node tests/site_access_budget_smoke.js
```

Expected: executor and the reply-send access action do not exist.

- [x] **Step 3: Implement the serial state machine**

Reserve a dedicated `message_reply_send` action through the existing BOSS access controller. Before every read, fill, state transition, and click, re-read batch control and abort state. Persist `click_dispatched` and `click_count=1` before calling `sender.dispatchReply()`.

Stop the whole batch on target mismatch, platform rejection, ambiguous result, risk, login, browser/page loss, structure change, or verified-success local failure. Pending/fill-before-click items become `stopped`; click-dispatched items become or remain `ambiguous`.

- [x] **Step 4: Reuse current communication pacing instead of adding a scheduler**

Add only the access action definition needed for budgets and use `PRODUCT_POLICY.operations.bossCommunication.delayMs` for inter-item delay. Reuse the shared BOSS pacing checkpoint owner; do not create a reply-specific timer service or poller.

- [x] **Step 5: Run focused tests and commit**

Run:

```powershell
node tests/message_reply_send_executor_smoke.js
node tests/site_access_budget_smoke.js
node tests/boss_safe_pacing_smoke.js
```

Commit:

```powershell
git add src/core/message_reply_send_executor.js src/core/product_policy.js tests/message_reply_send_executor_smoke.js tests/site_access_budget_smoke.js tests/run_all.js
git commit -m "feat: execute confirmed replies serially"
```

---

### Task 7: Connect The Dashboard APIs, Runtime, And Batch UI

**Files:**
- Create: `src/dashboard/message_reply_send_controller.js`
- Create: `tests/dashboard_message_reply_send_smoke.js`
- Modify: `src/dashboard/message_discovery_controller.js`
- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `src/dashboard/server.js`
- Modify: `tests/dashboard_message_discovery_smoke.js`
- Modify: `tests/dashboard_runtime_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- `createMessageReplySendController({db, browserFactory, learningService, logger, now})` exposes `confirm`, `status`, `stop`, and `close`.
- HTTP `POST /api/message-reply-send-batch` accepts `{profileId,items:[{draftId,revision}]}`.
- HTTP `GET /api/message-reply-send-status?profileId=&batchId=` returns local public-safe state.
- HTTP `POST /api/message-reply-send-control` accepts only `{profileId,batchId,action:'stop'}`.

- [x] **Step 1: Write failing API and UI assertions**

Assert action-token enforcement, JSON shape/ownership validation, at most one active batch per profile, and public status without reply or HR text. Render two editable cards and assert:

```html
<button data-send-single="draft-41">确认发送</button>
<input type="checkbox" data-send-select checked>
<button data-send-batch>确认并串行发送 2 条</button>
```

Assert read/delivered appear only in the top counts and never render `.message-result` cards.

- [x] **Step 2: Run Dashboard tests and verify RED**

Run:

```powershell
node tests/dashboard_message_reply_send_smoke.js
node tests/dashboard_message_discovery_smoke.js
```

Expected: routes, controller, send controls, counts, and batch polling do not exist.

- [x] **Step 3: Compose the in-process controller**

Follow the existing message discovery controller lifetime pattern: keep one promise/abort controller per active batch, build a fresh fixed-tab browser binding for the run, and clear only local runtime references after terminal status. On server close, abort and wait for active runs; never auto-resume a historical `click_dispatched` item.

- [x] **Step 4: Add strict local APIs**

Parse only the fields in the interfaces above, cap batches at 50, require the local action token on POSTs, return `409` for stale revisions/active batch/conflicts, and return `202` after a confirmed batch starts. Keep all browser and frozen target values server-owned.

- [x] **Step 5: Serialize current text before confirmation**

Extend the existing `draftWrites` queue. Single and batch handlers must:

```js
await Promise.all(selectedFields.map(saveDraft));
const items = selectedFields.map((field) => ({
  draftId: Number(field.dataset.draftId),
  revision: Number(field.dataset.revision)
}));
await postReplyBatch(items);
```

Use the revision returned by each save response before posting the batch. Disable selected editors and send controls once the server confirms the immutable batch; do not display a second confirmation dialog.

- [x] **Step 6: Poll local state and keep fallback flows**

Poll only `/api/message-reply-send-status`; update each card's local status and the batch bar. Stop polling at completed/stopped/interrupted. Keep copy and manual-sent handlers unchanged for drafts not owned by an active batch.

- [x] **Step 7: Run focused Dashboard tests and commit**

Run:

```powershell
node tests/dashboard_message_reply_send_smoke.js
node tests/dashboard_message_discovery_smoke.js
node tests/dashboard_runtime_smoke.js
node tests/dashboard_communication_profile_smoke.js
```

Commit:

```powershell
git add src/dashboard/message_reply_send_controller.js src/dashboard/message_discovery_controller.js src/dashboard/message_discovery_view.js src/dashboard/server.js tests/dashboard_message_reply_send_smoke.js tests/dashboard_message_discovery_smoke.js tests/dashboard_runtime_smoke.js tests/run_all.js
git commit -m "feat: confirm replies from message cards"
```

---

### Task 8: Close Documentation, Visual Checks, Review, And Exact-SHA Gates

**Files:**
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/NEXT_PHASE.md`
- Modify: `docs/resume_and_feedback_workflow.md`
- Modify: `docs/superpowers/plans/2026-08-29-message-discovery-confirmed-reply-sending.md`
- Create: `docs/superpowers/reports/2026-08-29-message-discovery-confirmed-reply-sending-review.md`

**Interfaces:**
- Produces one exact feature SHA with fresh focused and full offline evidence.
- Records that real BOSS was read only during calibration and that no real reply send was executed.

- [x] **Step 1: Run the complete focused gate**

Run:

```powershell
node tests/storage_migration_smoke.js
node tests/boss_message_dom_smoke.js
node tests/boss_message_reader_smoke.js
node tests/boss_message_reply_sender_smoke.js
node tests/message_preview_state_smoke.js
node tests/funnel_message_observation_smoke.js
node tests/message_discovery_smoke.js
node tests/message_reply_learning_smoke.js
node tests/message_reply_send_store_smoke.js
node tests/message_reply_send_service_smoke.js
node tests/message_reply_send_executor_smoke.js
node tests/dashboard_message_discovery_smoke.js
node tests/dashboard_message_reply_send_smoke.js
node tests/dashboard_communication_profile_smoke.js
```

Expected: every listed test exits 0 and none opens BOSS.

- [x] **Step 2: Run local visual acceptance without a real platform write**

Start the Dashboard against a temporary database and fake-browser fixture. Check 1440px and 390px views for HR message, job analysis, editable draft, checked count, single/batch buttons, running status, stopped/ambiguous result, keyboard focus, and absence of horizontal overflow. Record console errors and external network calls; both must be zero.

- [x] **Step 3: Perform a read-only correctness and simplicity review**

Review one normal two-item batch, one stale-target counterexample, and one post-click ambiguous failure across storage, service, browser sender, executor, and UI. Confirm:

- no client-controlled target or reply text enters a frozen batch;
- no `Page.bringToFront`, parallel item execution, guessed network endpoint, external retry, or raw HR text leak;
- no duplicate batch/executor abstraction beyond the dedicated reply semantics;
- copy/manual-sent, discovery pacing, funnel counts, and other stages remain intact.

Write only concrete findings and resolutions to the review report.

- [x] **Step 4: Run the fresh full offline gate**

Run:

```powershell
npm test
```

Expected: exit 0 and the final line reports the fresh registered test total; do not reuse the earlier 124-check result.

- [x] **Step 5: Update authoritative docs and plan checkboxes**

Document the user-visible flow, schema version 22, selectors backed by current DOM, immutable authorization, no-real-send boundary, actual test total, and remaining single-message live-acceptance prerequisite. Do not describe résumé acceptance, application, or real bulk sending as completed.

- [x] **Step 6: Check and commit the final documentation**

Run:

```powershell
git diff --check
git status --short
```

Commit:

```powershell
git add docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md docs/resume_and_feedback_workflow.md docs/superpowers/plans/2026-08-29-message-discovery-confirmed-reply-sending.md docs/superpowers/reports/2026-08-29-message-discovery-confirmed-reply-sending-review.md
git commit -m "docs: close confirmed reply sending"
```

- [x] **Step 7: Verify the exact final SHA**

Run at the final commit:

```powershell
git rev-parse HEAD
node tests/boss_message_reply_sender_smoke.js
node tests/message_reply_send_executor_smoke.js
node tests/dashboard_message_reply_send_smoke.js
git diff --check HEAD^ HEAD
git status --short --branch
```

Record the exact SHA, focused outputs, full test total, dirty/clean state, real BOSS read/write facts, and unverified live-send prerequisite in the final handoff.
