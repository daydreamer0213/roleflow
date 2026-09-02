# Message Follow-up Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为满足现有 48 小时成熟规则的主投/可投无回复岗位提供只读准备、可编辑草稿和不可变单条/批量确认发送。

**Architecture:** 用新的纯函数从现有漏斗投影筛选跟进资格，用应用服务把岗位、进度卡、会话快照与现有消息草稿表连接起来。浏览器准备由独立 Dashboard 控制器复用固定消息页、共享租约和现有 BOSS 消息读取器；真正发送继续使用现有 `message_reply_send_batches`，不建立第二套发送器。

**Tech Stack:** Node.js 22.5+、CommonJS、`node:sqlite`、服务端 HTML/CSS/原生浏览器脚本、现有 BOSS CDP 适配器。

## Global Constraints

- BOSS 默认只读；真实跟进发送只接受用户本次点击形成的不可变批次授权。
- 只使用固定 `BOSS-COMMUNICATION` 页，后台运行，不调用 `Page.bringToFront`。
- 48 小时、周末顺延和新已读重新等待全部复用 `projectFunnelEntry()`。
- 只自动列出 `primary` 和 `apply`；已回复、面试、拒绝、关闭、无效、归档和会话身份不唯一均排除。
- 跟进不新建漏斗样本，不移动原策略轮次。
- 不增加依赖、后台调度器、自动重试或自动发送。
- 自动化测试只使用 fixture、假浏览器和临时数据库，不访问真实 BOSS。

---

### Task 1: 跟进资格纯投影

**Files:**
- Create: `src/core/message_follow_up.js`
- Create: `tests/message_follow_up_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: `projectFunnelEntry(entry, events, { now })` from `src/core/funnel_maturity.js`.
- Produces: `projectMessageFollowUpCandidate(input) -> { eligible, reasonCode, matureAt, waitingSince, waitedHours }`.

- [x] **Step 1: Write the failing eligibility test**

```js
const projection = projectMessageFollowUpCandidate({
  entry,
  events: deliveredEvents,
  job: { decisionBucket: "primary", archived: false },
  card: { stage: "waiting_reply", threadKey: conversationKey },
  hasSentFollowUp: false,
  hasActiveFollowUp: false,
  now: "2026-09-03T08:00:00.000Z"
});
assert.equal(projection.eligible, true);
assert.equal(projectMessageFollowUpCandidate({ ...input, job: { decisionBucket: "caution" } }).reasonCode, "tier_ineligible");
assert.equal(projectMessageFollowUpCandidate({ ...input, hasSentFollowUp: true }).reasonCode, "already_followed_up");
```

Add cases for the original 48-hour wait, weekend deferral, a new read that restarts the wait, an HR reply, terminal cards, missing thread identity, archived jobs and active/succeeded follow-up items.

- [x] **Step 2: Run the new test and verify RED**

Run: `node tests/message_follow_up_smoke.js`

Expected: FAIL because `src/core/message_follow_up.js` does not exist.

- [x] **Step 3: Implement the minimal pure projection**

```js
function projectMessageFollowUpCandidate(input = {}) {
  const funnel = projectFunnelEntry(input.entry, input.events, { now: input.now });
  const tier = String(input.job?.decisionBucket || "");
  if (!new Set(["primary", "apply"]).has(tier)) return rejected("tier_ineligible", funnel);
  if (input.job?.archived) return rejected("archived", funnel);
  if (!input.card?.threadKey) return rejected("conversation_unresolved", funnel);
  if (String(input.card?.stage || "") !== "waiting_reply") return rejected("stage_ineligible", funnel);
  if (["review", "later", "skipped", "interview", "rejected", "invalid", "salary_mismatch"].includes(String(input.job?.applicationStatus || ""))) return rejected("outcome_ineligible", funnel);
  if (input.hasSentFollowUp) return rejected("already_followed_up", funnel);
  if (input.hasActiveFollowUp) return rejected("follow_up_active", funnel);
  if (!funnel.mature || funnel.replyWindowWaiting) return rejected("feedback_waiting", funnel);
  if (funnel.replied.value !== false || funnel.terminalCurrent) return rejected("not_unanswered", funnel);
  return accepted(funnel, input.now);
}
```

Export only `projectMessageFollowUpCandidate`; keep database queries out of this file.

- [x] **Step 4: Run the test and verify GREEN**

Run: `node tests/message_follow_up_smoke.js`

Expected: `message_follow_up_smoke ok`.

- [x] **Step 5: Commit the projection**

```powershell
git add src/core/message_follow_up.js tests/message_follow_up_smoke.js tests/run_all.js
git commit -m "feat: project eligible message follow-ups"
```

### Task 2: 查询候选项并保存跟进草稿

**Files:**
- Create: `src/application/message_follow_up/index.js`
- Modify: `src/storage/message_learning_store.js`
- Modify: `src/core/storage.js`
- Create: `tests/message_follow_up_service_smoke.js`
- Modify: `tests/message_learning_store_smoke.js`
- Modify: `tests/scan_store_contract_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: `listFunnelEntries`, `listFunnelProgressEvents`, `listDecisionPool`, `listOpenMessageReplyDrafts`, `saveMessageInboundContext`, `recordMessageReplyDrafts`.
- Produces: `closeOpenMessageReplyDraftsByIntent(db, { profileId, cardId, messageIntent, closedAt }) -> number`.
- Produces: `createMessageFollowUpService({ db, generateDraft, now })` with `listCandidates({ profileId, planId })`, `requireCandidate(...)`, and async `savePreparedDraft({ profileId, planId, jobId, snapshot })`.

- [x] **Step 1: Write failing storage and service tests**

```js
const service = createMessageFollowUpService({
  db,
  now: () => NOW,
  generateDraft: async () => ({ messages: ["您好，想再确认一下这个岗位目前是否仍在推进。"], missingFact: null })
});
assert.deepEqual(service.listCandidates({ profileId, planId }).map((item) => item.jobId), [jobId]);
const saved = await service.savePreparedDraft({
  profileId,
  planId,
  jobId,
  snapshot: { conversationKey, sourceJobId, lastMessageId, lastMessageDirection: "myself", previousOutboundText: "您好，想了解这个岗位。" }
});
assert.equal(saved.draft.messageIntent, "follow_up");
assert.equal(saved.context.lastMessageId, lastMessageId);
```

Verify a second preparation returns the same open draft, a changed last-message baseline closes only the old `follow_up` draft, and ordinary inbound reply drafts on the same card remain open.

- [x] **Step 2: Run tests and verify RED**

Run: `node tests/message_learning_store_smoke.js && node tests/message_follow_up_service_smoke.js`

Expected: FAIL because the intent-scoped close helper and service are absent.

- [x] **Step 3: Add the intent-scoped store helper**

```js
function closeOpenMessageReplyDraftsByIntent(db, { profileId, cardId, messageIntent, closedAt = nowIso() } = {}) {
  const result = db.prepare(`UPDATE message_reply_drafts
    SET closed_at = ?, updated_at = ?
    WHERE profile_id = ? AND card_id = ? AND message_intent = ? AND closed_at IS NULL`)
    .run(closedAt, closedAt, profileId, cardId, messageIntent);
  return Number(result.changes);
}
```

Export it through `message_learning_store.js` and the existing `core/storage.js` facade. Update only the exact facade counts asserted by contract tests.

- [x] **Step 4: Implement the application service**

Use `projectMessageFollowUpCandidate()` for every row. Derive the group key from the immutable baseline:

```js
function followUpGroupKey({ profileId, cardId, conversationKey, lastMessageId }) {
  return `sha256:${createHash("sha256")
    .update(["follow_up", profileId, cardId, conversationKey, lastMessageId].join("\0"))
    .digest("hex")}`;
}
```

Before the async model call, require eligibility. After the model call, enter one `immediateTransaction`, require eligibility again, close an older follow-up baseline only, save `message_inbound_contexts`, and save exactly one draft with `messageIntent: "follow_up"`. Reject `lastMessageDirection !== "myself"` as `FOLLOW_UP_CONVERSATION_CHANGED`.

- [x] **Step 5: Run service and facade tests**

Run: `node tests/message_learning_store_smoke.js && node tests/message_follow_up_service_smoke.js && node tests/scan_store_contract_smoke.js`

Expected: all three print `ok` and exit 0.

- [x] **Step 6: Commit service and storage**

```powershell
git add src/application/message_follow_up/index.js src/storage/message_learning_store.js src/core/storage.js tests/message_follow_up_service_smoke.js tests/message_learning_store_smoke.js tests/scan_store_contract_smoke.js tests/run_all.js
git commit -m "feat: persist prepared follow-up drafts"
```

### Task 3: 后台只读会话准备控制器

**Files:**
- Modify: `src/adapters/sites/boss_message_reader.js`
- Create: `src/dashboard/message_follow_up_controller.js`
- Modify: `tests/boss_message_reader_smoke.js`
- Create: `tests/dashboard_message_follow_up_controller_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: `createBossMessageReader`, `acquireSiteScanLease`, `releaseSiteScanLease`, `createSiteAccessController`, and `messageFollowUpService.savePreparedDraft()`.
- Produces: `createMessageFollowUpController(deps)` with async `prepare({ profileId, planId, jobId })` and async `close()`.

- [x] **Step 1: Write failing reader and controller tests**

The reader fixture must accept this exact guarded target:

```js
const target = { ...row, tabId: scan.tabId, operation: "follow_up" };
const selected = await reader.openQueuedConversation(target);
assert.equal(selected.messages.at(-1).direction, "myself");
```

The controller test must prove: it uses one BOSS lease, finds the row by both `threadKey` and `sourceJobId`, never calls a foreground method, passes the latest own message to the service, disconnects the browser, and does not call the model when the row now belongs to HR.

- [x] **Step 2: Run tests and verify RED**

Run: `node tests/boss_message_reader_smoke.js && node tests/dashboard_message_follow_up_controller_smoke.js`

Expected: FAIL because `follow_up` is not an allowed reader operation and the controller is absent.

- [x] **Step 3: Extend the guarded reader operation**

Add only `"follow_up"` to `ALLOWED_OPERATIONS`. Do not weaken row signature, source job, last-message or selected-conversation checks.

- [x] **Step 4: Implement the controller**

```js
const exact = rows.filter((row) => row.identityVerified
  && row.conversationKey === candidate.card.threadKey
  && row.sourceJobId === candidate.job.sourceId);
if (exact.length !== 1) throw followUpError("FOLLOW_UP_CONVERSATION_UNRESOLVED");
if (exact[0].lastMessageDirection !== "myself") throw followUpError("FOLLOW_UP_CONVERSATION_CHANGED");
const selected = await reader.openQueuedConversation({ ...exact[0], tabId, operation: "follow_up" }, signal);
```

Reserve one existing `communication_visit` action immediately before the guarded selection. Recheck fixed tabs before and after selection through the reader. Always release the lease and disconnect in `finally`.

- [x] **Step 5: Run controller tests**

Run: `node tests/boss_message_reader_smoke.js && node tests/dashboard_message_follow_up_controller_smoke.js`

Expected: both print `ok` and exit 0.

- [x] **Step 6: Commit the controller**

```powershell
git add src/adapters/sites/boss_message_reader.js src/dashboard/message_follow_up_controller.js tests/boss_message_reader_smoke.js tests/dashboard_message_follow_up_controller_smoke.js tests/run_all.js
git commit -m "feat: prepare follow-ups from the fixed message page"
```

### Task 4: 跟进页面、今日入口和发送复用

**Files:**
- Create: `src/dashboard/pages/message_follow_up.js`
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/view_models/today.js`
- Modify: `src/dashboard/pages/today.js`
- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `src/dashboard/assets/components.css`
- Create: `tests/dashboard_message_follow_up_smoke.js`
- Modify: `tests/dashboard_today_page_smoke.js`
- Modify: `tests/dashboard_message_reply_send_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: `messageFollowUpService.listCandidates()`, `messageFollowUpController.prepare()`, existing `/api/message-reply-draft`, `/api/message-reply-send-batch`, `/api/message-reply-send-status`, and `/api/message-reply-send-control`.
- Produces: GET `/follow-ups?profileId=&planId=` and POST `/api/message-follow-up/prepare`.

- [x] **Step 1: Write failing HTTP and rendering tests**

```js
const today = await request(base, `/plan?profileId=${profileId}&planId=${planId}`);
assert.match(today.body, /有 2 个岗位可以考虑跟进/);
const page = await request(base, `/follow-ups?profileId=${profileId}&planId=${planId}`);
assert.match(page.body, /已等待 48 小时/);
assert.match(page.body, /准备跟进草稿/);
assert.doesNotMatch(emptyToday.body, /可以考虑跟进/);
```

After preparation, assert the page contains an editable autosave textarea, single-send control, batch selection, the exact confirmed previous outbound text when available, and the same local action token used by the existing reply sender.

- [x] **Step 2: Run tests and verify RED**

Run: `node tests/dashboard_today_page_smoke.js && node tests/dashboard_message_follow_up_smoke.js`

Expected: FAIL because the count, route and page do not exist.

- [x] **Step 3: Extract only the reusable draft controls**

Export focused helpers from `message_discovery_view.js`:

```js
function renderMessageDraftCard({ draft, alternative, sendable, escapeHtml }) { }
function messageReplyClientScript(scriptState) { }
```

Keep the existing message page output byte-compatible except for the renamed internal helper call. Do not move unrelated discovery rendering.

- [x] **Step 4: Add the page and routes**

Render one compact card per candidate. Unprepared rows submit `profileId`, `planId`, and `jobId` to `/api/message-follow-up/prepare`. Prepared rows use the shared editor/send controls. The API obtains profile and plan from server-side ownership checks; request fields cannot supply conversation identifiers or message text.

Pass `{ count, href }` into `buildTodayViewModel` and render the card only when `count > 0`:

```js
followUp: count > 0 ? { count, href: `/follow-ups?profileId=${profileId}&planId=${planId}` } : null
```

- [x] **Step 5: Verify direct-edit and immutable-send behavior**

Run: `node tests/dashboard_message_follow_up_smoke.js && node tests/dashboard_message_reply_send_smoke.js && node tests/dashboard_today_page_smoke.js`

Expected: all tests pass; client test proves autosaves complete before confirmation and only `{ draftId, revision }` reaches the confirmation API.

- [x] **Step 6: Commit the user flow**

```powershell
git add src/dashboard/pages/message_follow_up.js src/dashboard/server.js src/dashboard/view_models/today.js src/dashboard/pages/today.js src/dashboard/message_discovery_view.js src/dashboard/assets/components.css tests/dashboard_message_follow_up_smoke.js tests/dashboard_today_page_smoke.js tests/dashboard_message_reply_send_smoke.js tests/run_all.js
git commit -m "feat: add the message follow-up workspace"
```

### Task 5: 跟进完成语义与回归门禁

**Files:**
- Modify: `src/application/message_reply_sending/index.js`
- Modify: `src/core/candidate_progress.js`
- Modify: `tests/message_reply_learning_smoke.js`
- Modify: `tests/dashboard_message_reply_send_smoke.js`
- Modify: `docs/NEXT_PHASE.md`
- Modify: `docs/PROJECT_HANDOFF.md`

**Interfaces:**
- Consumes: a sent draft with `messageIntent === "follow_up"`.
- Produces: idempotent `follow_up_sent` progress event without a new funnel entry.

- [x] **Step 1: Write the failing completion test**

```js
await service.completeVerifiedItem({ batchId, itemId });
assert.equal(countProgressEvents(db, cardId, "follow_up_sent"), 1);
assert.equal(countFunnelEntries(db, profileId, jobId), 1);
await service.completeVerifiedItem({ batchId, itemId });
assert.equal(countProgressEvents(db, cardId, "follow_up_sent"), 1);
```

- [x] **Step 2: Run tests and verify RED**

Run: `node tests/dashboard_message_reply_send_smoke.js && node tests/message_reply_learning_smoke.js`

Expected: FAIL because completion records only generic `reply_confirmed_sent`.

- [x] **Step 3: Record the intent-specific event in the existing completion transaction**

Load the draft intent before `learningService.completeDraft()`. Inside its existing `afterComplete()` callback, record `follow_up_sent` for follow-up drafts and keep `reply_confirmed_sent` for normal HR replies. Reuse `message-reply-send:${batch}:${item}` as the idempotency base and do not call `ensureFunnelEntry()`.

- [x] **Step 4: Run targeted and full gates**

Run:

```powershell
node tests/message_follow_up_smoke.js
node tests/message_follow_up_service_smoke.js
node tests/dashboard_message_follow_up_controller_smoke.js
node tests/dashboard_message_follow_up_smoke.js
node tests/dashboard_message_reply_send_smoke.js
npm test
git diff --check
git status --short
```

Expected: targeted tests print `ok`; the full suite prints the current exact offline-check total; `git diff --check` has no output.

- [x] **Step 5: Update current documentation and commit**

Record the implemented user flow, exact tests, real-platform non-access, remaining real DOM assumption and exact commit sequence. Do not claim real follow-up sending was accepted.

```powershell
git add src/application/message_reply_sending/index.js src/core/candidate_progress.js tests/message_reply_learning_smoke.js tests/dashboard_message_reply_send_smoke.js docs/NEXT_PHASE.md docs/PROJECT_HANDOFF.md
git commit -m "docs: record message follow-up delivery"
```
