# Unified Message Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将智联消息发现接入现有统一消息页，复用本地草稿和学习，并保留明确的平台隔离及 BOSS 独有发送边界。

**Architecture:** 继续使用已有含 platform 的表及已有岗位 source，不建新存储框架。Task 1 是独立平台隔离基础；真实正文证据在实施期间补齐后，追加 Task 2–4 作为同一已批准设计的读取、处理和用户入口实现合同。

**Tech Stack:** Node.js CommonJS、现有 SQLite、assert smoke tests，无新依赖。

## Global Constraints

- 当前分支 `codex/zhaopin-readonly`；不推送、不合并、不打包、不发布、不改版本号。
- 不访问真实招聘平台、不使用生产数据库、不调用真实模型。真实页面证据由主控处理。
- 复用现有草稿、学习和存储结构，不增加第二套消息产品或通用插件框架。
- BOSS 发送功能保持既有边界；智联不开放发送、投递、简历处理或漏斗扩展。
- 旧 BOSS 调用省略平台时仍按 BOSS 处理；聚合视图必须显式请求全部平台。
- 新增代码只有真实行为回归测试，不写源码字符串、注释、文档措辞测试。
- 项目根 AGENTS.md 优先。真实 DOM 字段合同见本计划 Task 2 及 `docs/superpowers/specs/2026-09-08-unified-message-discovery-design.md`，不发明未观察到的卡片类型。

### Task 1: Explicit platform queries and BOSS-only mutation boundaries

**Files (ownership):**
- Modify: `src/core/message_preview_state.js`
- Modify: `src/core/candidate_progress.js`
- Modify: `src/storage/message_reply_send_store.js`
- Modify: `src/application/message_discovery/inbound.js`
- Tests: `tests/message_preview_state_smoke.js`, `tests/candidate_progress_storage_smoke.js`, `tests/message_reply_send_store_smoke.js`, `tests/message_discovery_smoke.js` (only needed cases)
- Do not modify dashboard, platform readers, schema, facade exports, release or unrelated docs in this task.

**Interfaces:**
- `listPreviewStates(db, {profileId, platform = "boss"})` and `listUnresolvedMessageDiscoveryItems(db, {profileId, platform = "boss"})`: allow `boss`, `zhaopin`, and explicit `null` meaning aggregate. Other values throw `PREVIEW_PLATFORM_INVALID`. Filter inside SQL, preserving order and mapped results.
- `listMessageDiscoveryCandidates(db, {profileId, platform = "boss"})` and `findMessageDiscoveryJobContext(db, {profileId, planId, sourceId, platform = "boss"})`: allow only `boss` or `zhaopin`, reject other values with `PROGRESS_PLATFORM_INVALID`. Match jobs.source and cards.source consistently, never match a foreign-source card; return actual source, retain existing profile/plan/full-JD/completed-analysis conditions.
- Preview record/clear functions continue using their existing explicit platform storage keys; this task need not broaden or redesign write validation.
- `createMessageReplySendBatch`: explicit stored card/job source must be BOSS before freezing a draft, irrespective of source_job_id text. Otherwise throw `MESSAGE_REPLY_SEND_PLATFORM_UNSUPPORTED`; transaction leaves zero new batch/items. Existing BOSS target/message ID validators remain strict and unchanged.
- `resolveInboundOpportunity`: currently BOSS-only. Default-scoped unresolved lookup prevents resolving/ignoring a same-key ZL item; link action additionally requires selected job source BOSS. No new ZL create/link endpoint in this subproject.
- Do not broaden message event idempotency or inbound context validators without the future reader contract.

- [x] **Step 1: Add minimal failing behavior checks in existing smoke tests.**

Use existing test fixtures to insert two platforms with the same conversation digest. Example expected assertions (IDs refer to the fixture's existing profile):

```js
assert.deepStrictEqual(listPreviewStates(db, { profileId }).map(x => x.platform), ["boss"]);
assert.deepStrictEqual(listPreviewStates(db, { profileId, platform: "zhaopin" }).map(x => x.platform), ["zhaopin"]);
assert.strictEqual(listPreviewStates(db, { profileId, platform: null }).length, 2);
assert.throws(() => listPreviewStates(db, { profileId, platform: "other" }), {code: "PREVIEW_PLATFORM_INVALID"});
```

Repeat the meaningful same-key isolation assertion for unresolved items. Seed complete observations for same sourceId in BOSS and ZL within one profile/plan; exact source lookup returns each own job and source, absent/other profile/plan cannot borrow it. Candidate listing excludes a deliberately mismatched card.source/jobs.source row. Use existing owner/draft setup for a ZL-owned draft with a BOSS-looking inbound context; batch creation rejects source mismatch and inserts nothing. A mixed BOSS/ZL batch rejects atomically. Existing valid BOSS send fixture remains green. BOSS inbound manual link cannot select a same-title/company ZL job, and BOSS ignore leaves ZL unresolved untouched.

- [x] **Step 2: Run focused tests and record the expected failing assertions before production edits.**

```powershell
& D:/hermes/node/node.exe tests/message_preview_state_smoke.js
& D:/hermes/node/node.exe tests/candidate_progress_storage_smoke.js
& D:/hermes/node/node.exe tests/message_reply_send_store_smoke.js
& D:/hermes/node/node.exe tests/message_discovery_smoke.js
```

- [x] **Step 3: Implement the minimum source filters and source guards.**

Reuse the existing queries/mappers. Bind the selected source as a SQL argument, not interpolated user input. For aggregate preview queries, use the explicit null branch:

```js
function previewPlatform(value) {
  if (value === null || value === "boss" || value === "zhaopin") return value;
  throw previewError("PREVIEW_PLATFORM_INVALID", "preview platform is invalid");
}
// WHERE profile_id = ? AND (? IS NULL OR platform = ?)
// .all(id, source, source)
```

Candidate queries use `jobs.source = ?` and `cards.source = jobs.source`; the context query selects `jobs.source AS source` and constrains any joined card to the same source. Preserve all current complete-JD conditions. Before send freeze, read draft owner card joined with jobs, check profile/card/job match and both sources. Preserve existing NOT_FOUND/conflict behavior where possible; source mismatch uses the stated error. Existing inbound link SQL adds `jobs.source = 'boss'`.

- [x] **Step 4: Run affected suites and smallest existing integration checks.**

Run Step 2 plus `tests/message_discovery_job_context_smoke.js`, `tests/dashboard_message_discovery_smoke.js`, `tests/dashboard_message_reply_send_smoke.js`. Use installed Node on D; strict browser tests use the existing dependency cache read-only with `ROLEFLOW_REQUIRE_PLAYWRIGHT=1`; TEMP/TMP point to `D:/DevData/RoleFlow-tests`. No new downloads. Record output and warnings honestly. Main controller owns fresh full `npm test` and final exact-SHA checks after integration/review.

- [x] **Step 5: Self-review, diff-check, commit only owned code/tests, and write report.**

```powershell
git diff --check
git add -- src/core/message_preview_state.js src/core/candidate_progress.js src/storage/message_reply_send_store.js src/application/message_discovery/inbound.js tests/message_preview_state_smoke.js tests/candidate_progress_storage_smoke.js tests/message_reply_send_store_smoke.js tests/message_discovery_smoke.js
git commit -m "fix(messages): isolate platform queries and boss-only mutations"
```

Report RED/GREEN commands/results, files, commit and remaining concerns. Task review must verify spec compliance and code quality. The unified inbox itself remains unfinished until live detail evidence enables the next implementation contract.

### Task 2: Native read-only Zhaopin conversation reader

**Files (ownership):** Create `src/adapters/sites/zhaopin_message_reader.js`, `tests/zhaopin_message_reader_smoke.js`; modify `tests/run_all.js` to register the behavioral test. No core/storage/UI changes in this task.

**Interfaces:** Export `createZhaopinMessageReader({browser, sleepFn, nowFn, timeoutMs=120000, pollIntervalMs=500})` and `ZHAOPIN_MESSAGE_SNAPSHOT_EXPRESSION`. Reuse `safeDigest` from `boss_message_dom` (it is generic hashing; do not use its BOSS message ID validator).

Reader exposes `scanConversationRows(signal)`, `openQueuedConversation(target, signal)`, `assertActiveBindings()`. Scan returns `{tabId, platform:"zhaopin", scope:"loaded_conversations", rows}`. Each row has the existing queue planner fields: `rowIndex`, `conversationKey`, `previewDigest`, `previewKind`, `unread`, `identityVerified`, `friendKey`, `sourceJobId`, `lastMessageDirection`, `lastMessageStatus`, `lastMessageId` (empty until detail is read). Additional raw session/preview identity is kept internally, never logged. `sourceJobId` is `zhaopin:<jobNumber>` and conversationKey hashes `['zhaopin', sessionId]`. Confirmed incoming row direction requires numeric senderId equals peerPartnerId; otherwise use unknown; unknown read/delivery state remains unknown. Initial greetings/unread may be queued for detail but never become confirmed HR replies from preview alone.

Selected result supplies existing processing fields: `{platform:"zhaopin", conversationKey, sourceJobId, lastMessageId, positionName, companyName, salary, city, messages}`. Each message is `{messageId, direction, contentKind, text}`; supported content kinds are `text`, `resume_request`, `platform_notice`, `unsupported`. Direction is friend/myself/platform/unknown, not guessed from screen location. Use stable numeric `idServer` (1–32 digits) as messageId. If missing/invalid, the affected content is unsupported, not silently skipped. Return the last meaningful detail message ID separately; do not invent a list-level message ID.

**Actual page contract (no live access by worker):**
- Exact existing URL `https://i.zhaopin.com/im`, unique tab, numeric tabId/windowId, no created tabs/windows. `.im-side-panel` Vue2 `SidePanelThreeColumns` computed `listLoading/listError/sessions`; `.im-session-item` Vue2 `ImSessionItem` `$props.session` contains `sessionId` (hex32), `jobNumber` (alphanumeric, examples CCL…J…/CZ…J…), `peerPartnerId`, `senderId`, `userId`, `sendTime`, `text`, `lastSentenceType`, `unreadCount`. DOM: `.im-session-item__name`, `__company-name`, `__job`, `__salary`, `__preview-text`, `__badge`; selected class `is-active`.
- `.im-main-panel` Vue2 `MainPanelThreeColumns` computed `activeSessionId`, `activeSession`, `activeTimeline`, `timelineLoading`, `timelineError`. Header `.im-chat-header` `$props.session` must agree with selected row/panel session and job; `.im-chat-header__job-title`, `__salary`, `__city` render selected identity.
- Only outer `.im-message` nodes whose mounted component name is `ImMessageRow`; nested ImMessage renderers must not duplicate rows. Each row `$props.msg`: `idServer`, `id`, `idClient`, `from`, `flow`, `fromMe`, `time`, `type`, `cardType`, `body`, `content`; `$props.session` must agree with selected conversation.
- Incoming means flow `in`, fromMe false and `from` equals selected session peerPartnerId/staffId. Actual outgoing means flow `out`, fromMe true and `from` equals session.userId. Any contradictory/unknown identity stops classification as unsupported.
- Text: type `text`, `.im-msg-text`, rendered text equals body. Greeting text: type `custom`, cardType `131`, `.im-msg-rich`, body string equals rendered text; only use textContent, never innerHTML. Resume request: custom/`11`, `.im-msg-11-wrap`, title contains 简历, buttons `.im-msg-11__btn--refuse` text 拒绝 and `--agree` text 同意. Normalize to fixed safe summary `HR 邀请你发送简历`; never click these buttons. Custom/`255` only with outer `im-message--tip` and `.im-msg-255-fallback` becomes platform_notice/direction platform, even when fromMe=true. Other cards are unsupported; don't flatten hidden card text.
- Query current loaded conversation rows only, do not scroll/fetch historical pages. Normal native click is only `row.click()` after immediate sessionId/job/preview recheck; not child links, buttons, mouse events, navigation, focus, or sender input.
- Call existing browser.setPageLifecycleActive before selection without focus, then read page readiness with bounded cancellable polling. Missing/ambiguous tab, changed URL/window/session identity, visible risk/login panel, failed timeline, or unsupported structure produce a typed ZHAOPIN_MESSAGE_* error. Empty/loading timeline is not a successful empty conversation: `ZHAOPIN_MESSAGE_CONTENT_PENDING`. Never access broad store, credentials, or private APIs. Current evidence is in `D:/DevData/RoleFlow-zhaopin-messages-20260908/message-contract.json` if one field needs confirmation; no real names/body there.

- [x] **Step 1: Write realistic synthetic mounted-DOM regression.** Use installed local Playwright and fake browser boundary; execute actual exported expressions against synthetic HTML with Vue2 props. Derive expected output by hand:

```js
assert.deepStrictEqual(selected.messages.map(m => [m.direction, m.contentKind]), [
  ["friend", "text"], ["friend", "resume_request"], ["friend", "text"], ["platform", "platform_notice"]
]);
assert.strictEqual(selected.messages.filter(m => m.contentKind === "text").length, 2);
assert.strictEqual(selected.sourceJobId, "zhaopin:CCL1234567890J00123456789");
```

Also catch same-title/different-session selection, changed preview before click (no click), inner renderer duplicate counting, self/unknown direction, malformed IDs, unknown custom card, timelineLoading followed by ready, permanent empty/timeouts, and abort. Spy on actual browser calls and sender controls: no bringToFront/navigate/createTab/input/resume actions; only intended root row click can happen. Test missing optional known fields as unknown, not invented statuses.

- [x] **Step 2: Run `node tests/zhaopin_message_reader_smoke.js` and capture expected RED, then implement minimal adapter.**

```js
// Never call a site method or application store action to select a row.
const rows = [...document.querySelectorAll('.im-session-item')];
const row = rows.find(el => el.__vue__?.$props?.session?.sessionId === expected.sessionId);
// Compare job identity and current preview with the captured target before row.click().
```

Existing queue planner copies only fixed fields, so reader's internal target map is keyed by tabId + rowIndex + conversationKey; revalidate the row's stored raw identity there. Return source-scoped display fields but no account identifiers in errors/logs. Poll for both correct selected identity and non-loading visible content; use elapsed timeout and AbortSignal, not a fixed sleep presented as success.

- [x] **Step 3: Run GREEN plus `tests/message_preview_state_smoke.js` and `tests/message_discovery_smoke.js`; inspect diff, commit reader/test registration only.** Main owns full gate and documentation; return TDD report as before.

### Task 3: Source-aware processing and durable inbound display

**Files (ownership):** Modify `src/core/message_discovery.js`, `src/core/candidate_progress.js`, `src/core/message_preview_state.js`, `src/core/storage.js`, `src/storage/message_reply_send_store.js`; create `src/application/message_discovery/zhaopin_job_context.js`; tests `tests/message_discovery_smoke.js`, `tests/message_reply_send_store_smoke.js`, `tests/storage_migration_smoke.js`, `tests/message_learning_store_smoke.js`, and a focused `tests/zhaopin_message_discovery_smoke.js` registered in `tests/run_all.js`. No dashboard changes yet.

**Interfaces:** Existing `runBossMessageDiscovery(options)` stays compatible. Add optional `platform="boss"` argument restricted to boss/zhaopin and reuse its shared queue/classification/draft logic (do not copy the entire engine). Existing default callers remain BOSS. `createZhaopinMessageJobContextResolver({db,profileId})` returns an async resolver `({target,selected,candidate,signal}) => resolvedContext`, matching existing context object `{cardId,card,job,threadKey,contextSource:"local_cache"}`. Only complete trusted same-profile active-plan ZL cache is allowed; exact raw sourceId from qualified target, no title/company fallback and no real JD navigation. Create/bind progress card only for a real complete cached ZL job; never create fake jobs to satisfy draft schema. Missing cache throws MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE and preserves inbound display as unresolved.

Durability: migration 30 adds `inbound_json TEXT NOT NULL DEFAULT '[]'`, `source_job_id TEXT NOT NULL DEFAULT ''`, `last_message_id TEXT NOT NULL DEFAULT ''` to message_discovery_unresolved_items. Existing rows migrate without loss. `recordUnresolvedMessageDiscoveryItem` accepts optional `{inboundMessages, sourceJobId, lastMessageId}` only as validated display fields and maps them back. Explicit zhaopin context uses `zhaopin:<alphanumeric job ID>` and numeric message ID (1–32 digits); never accept BOSS-looking identity as ZL. Empty/failed later reads preserve previously saved inbound display AND its source/job identity as a unit rather than replace it with empty data or relabel old text as a new job. Bound inbound contexts derive platform from joined stored card/job sources; `saveMessageInboundContext` additionally accepts explicit platform default boss and validates input/card/job agreement. BOSS validators remain unchanged and Task 1 send guard stays mandatory.

- [ ] **Step 1: Add integration tests with real temporary SQLite and fake reader/model boundaries, observe RED.**

```js
await runBossMessageDiscovery({ ...fixture, platform: "zhaopin", reader, classifyMessageGroup, resolveJobContext });
assert.strictEqual(db.prepare("SELECT count(*) AS n FROM candidate_funnel_entries f JOIN jobs j ON j.id=f.job_id WHERE j.source='zhaopin'").get().n, 0);
assert.strictEqual(listOpenMessageReplyDrafts(db, { profileId }).length, 2);
```

Required behavioral cases: same conversation/message IDs in BOSS and ZL yield separate events and baselines; the custom255 self tip does not erase the three earlier HR items; two texts + resume request yield two editable local drafts plus safe manual action; no complete JD preserves exact supported inbound display after DB reopen with zero fake jobs/drafts/classifications; retry with newly available correct cache processes it and clears only ZL unresolved; late empty/timed-out read retains display and remains unprocessed; repeated discovery is idempotent; same-ID foreign-source cache/profile/plan cannot be borrowed. Inject a SQLite failure during inbound-context save: classification events, drafts and processed preview must roll back together, and retry after removing the test failure succeeds. Copy completion uses existing learning service and edited text, creates no sent/funnel event. Direct ZL/mixed send batch is rejected atomically. Migration 29→30 preserves old draft/preview rows and remains rerunnable. Do not use the production database.

- [ ] **Step 2: Generalize the existing pipeline only at its source-dependent seams.**

```js
const baselineRows = listPreviewStates(db, { profileId, platform });
const observationCounts = platform === "boss"
  ? recordFunnelRowObservations(db, { profileId, platform, rows: scan.rows, observedAt: now() })
  : { unbound: 0 };
// For ZL: currentRead/currentDelivered remain null; stats capability is unsupported.
```

Source-qualify message/group event keys while preserving existing BOSS key bytes. Validate event platform agrees with persisted card/job before any classification transaction. For ZL exact IDs use safeDigest([platform,threadKey,messageId]); do not loosen boss_message_dom.messageKey. Thread identity remains platform-hashed; only actual outgoing text truncates incoming groups, never platform_notice. Ensure new source/summary fields survive safeResult/safeStatus. Current group limits 5 items/1000 text chars remain with explicit pending/stopped reason; don't silently truncate unknown content or mark it processed. Retrieve fresh facts/active answer memories per conversation exactly as before. Reuse existing quality-checked generation and autosaved learning; no new confirmation.

Before discarding a ZL selected snapshot for missing context, extract validated display messages into the unresolved row. Unknown content or too-large groups are marked pending with a clear reason, not replaced by a guessed message. Extend the unresolved reason allowlist for actual ZHAOPIN_MESSAGE_CONTENT_PENDING/CONTENT_UNSUPPORTED/STRUCTURE_CHANGED failures rather than mapping everything to an unrelated BOSS identity error. Empty detail failure records a pending row keyed by target conversation without advancing its preview baseline; preserve any existing inbound display. Bound save works even for manual-only/no-draft results so the request card survives restart; preserve BOSS existing behavior. Persist classification, drafts, inbound display and processed baseline in one synchronous transaction after model work: use the existing immediateTransaction in the engine and existing `progressTransaction` inside recordDiscoveredMessageGroupClassification instead of its standalone BEGIN/COMMIT, so the existing nested-aware storeTransaction/progressTransaction helpers can join the caller transaction. Do not change the shared transaction framework. Update result counters only after commit. Plaintext only in intended display storage, never event summaries/logs.

- [ ] **Step 3: Run focused GREEN and existing message/learning/storage contracts, diff-check and commit owned files.** Main controls final full gate. Report exact actual table fixture used, no prose/source-text assertions.

### Task 4: Unified manual discovery action and inbox

**Files (ownership):** Modify `src/dashboard/message_discovery_controller.js`, `src/dashboard/message_discovery_view.js`, `src/dashboard/server.js` and only necessary existing dashboard CSS; tests `tests/dashboard_message_discovery_smoke.js`, `tests/dashboard_message_reply_send_smoke.js`, `tests/dashboard_communication_profile_smoke.js`, `tests/zhaopin_message_discovery_smoke.js` or one focused local journey registered in `tests/run_all.js`. No new framework or UI dependency.

**Interfaces:** Existing POST `/api/message-discovery` start/stop/dismiss and GET status remain. Start derives connected platforms from frozen browser authority's existing tabs, not `workSite`/today's selection. Add source-aware factory defaults in the existing controller, retaining dependency injection compatibility for existing BOSS tests. One shared lease (existing boss/zhaopin mutually exclusive lease can cover the entire serial operation), one AbortController, one browser lifecycle. `platformRuns` entries `{platform,status,reasonCode,counters}` distinguish not_connected/running/completed/stopped/needs_user_action; overall UI never equates not_connected with success/zero. BOSS-specific runtime/detail safety is evaluated only when BOSS is actually processed. No BOSS readiness helper may auto-open/require BOSS for ZL-only discovery. No new background scheduler or platform mode selector.

Display source comes from persisted jobs/cards (not browser/user-supplied capability flags), and result shaping retains it. Default combined list, source filter `{all,boss,zhaopin}` is a labelled native display control. It must save pending edits before hiding a row; failed save keeps current content visible. Switching source cannot start a scan, clear drafts, switch Today platform, or reload away unsaved text. The selected first visible message updates consistently; empty filtered results have clear text. Keep the existing desktop two-column message layout, existing tokens/typefaces, one primary “开始只读发现” button. Use compact textual source badges, not giant extra platform cards or new decorative panels. Show platform-specific connection/result notices compactly, and BOSS read/delivered counts labelled as BOSS-only; ZL unknown status omitted or labelled “暂不提供已读/送达统计”, never displayed as zero. During ZL reading use a plain-language loading/reading status and keep safe stop available; content-pending explains that messages have not loaded yet and remain retryable. Do not claim a diagnosed network cause, show raw internal codes as the primary explanation, or ask users to foreground the page.

- [ ] **Step 1: Add failing local HTTP/SQLite/headless tests for user outcomes.**

```js
// A ZL-only fake browser with real controller/storage: no BOSS helper invocation.
assert.strictEqual(bossReadCalls, 0);
assert.strictEqual(zhaopinReadCalls, 1);
assert.strictEqual(maxConcurrentBrowserOperations, 1);
// On the rendered ZL draft card, copy/edit exist and send controls do not.
assert.strictEqual(await zhaopinCard.locator('[data-send-single], [data-send-select], [data-sent-draft]').count(), 0);
```

Also verify both-platform deterministic serial operation, stop during second platform retains first platform results/drafts, one unavailable platform does not erase the other's results, source filter after autosave survives refresh and no accidental external action, same-title BOSS/ZL cards distinguish source, unresolved ZL shows supported original text and no BOSS link/create/manual-send form, manual-only resume request survives restart, copied edited answer is learned without sent event, typed API attempt to mark ZL sent is rejected before any learning/progress/funnel write. Existing BOSS send and no-draft old manual flow stay green. Tests use local HTTP, temporary DB, synthetic platform/model, no real browser account.

- [ ] **Step 2: Implement serial source routing in existing controller and concise unified display.**

```js
for (const platform of connectedPlatforms) {
  // Abort check, platform-specific runtime guard, reader/resolver, shared pipeline,
  // platform result checkpoint; concatenate results by persisted cardId, never overwrite.
}
```

Use production tab inventory; reject ambiguity per source with an explicit platform status. Login/risk/page loss stops that platform; global abort/lease loss ends the entire run. Preserve earlier durable data if later work fails. ZL does not inherit BOSS cooldown or detail opening; it still uses randomized serial pacing and stop-on-risk. Do not relax BOSS fixed-tab or transient detail guards. Clear action remains explicit “清除本次结果” across the same run, independent of display filter, and cannot clear unprocessed messages; saved drafts are handled by the existing deliberate dismiss semantics. No hidden source-filter-specific destruction.

Send batch selection/count includes BOSS drafts only; unknown source is non-sendable. Profile/queue/api progress path must reject ZL sent regardless of UI. Copy/save stay shared. Source-aware manual text says 智联 and asks user to handle the original resume request themselves; no resume buttons execute from RoleFlow. Unknown job analysis stays visibly incomplete. Durable page restore includes inbound contexts with open drafts OR with no draft rows (manual-only/missing-fact results); all-closed draft groups must not reappear as active messages. Explicit dismiss removes the processed inbound contexts it dismisses via existing deleteMessageInboundContext, preserving unresolved pending items; no new archive/status system. Reuse current send-busy protections before clearing any associated draft/context. After confirmed BOSS send/clear, the completed context must not resurrect as a no-draft result.

- [ ] **Step 3: Run local user journey and existing message UI gates, inspect desktop/mobile screenshots, diff-check and commit owned files.** Use installed headless Edge, 1440px and 390px, no horizontal overflow/console errors/external requests; verify labels and focus navigation. Main runs fresh complete `npm test` at final static code, final broad review and one fix wave if needed, updates NEXT_PHASE/PROJECT_HANDOFF and records exact SHA. Do not push, merge, package, publish or change version.
