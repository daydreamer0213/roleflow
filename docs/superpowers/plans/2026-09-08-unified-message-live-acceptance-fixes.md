# Unified message live acceptance fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for the bounded implementation and independent review. Main owns real browser acceptance and final evidence.

**Goal:** Read the actual logged-in Zhaopin IM URL and stop historical BOSS pending records from misrepresenting the current run.

**Architecture:** Keep the current reader/controller/view. Identify the IM page by exact HTTPS origin and `/im` path, not the optional query or fragment. Keep tab/window/session/job identity checks. Separate a live run's status and unresolved count from the durable pending list without deleting either.

**Tech Stack:** Existing CommonJS JavaScript, native URL, SQLite and installed Playwright/Edge. No dependencies.

## Global Constraints

- Worktree `D:/DevData/RoleFlow-worktrees/zhaopin-readonly`, branch `codex/zhaopin-readonly`; baseline `74721302b2bc1f38d2bc0fc417bae2d5470c5c29` was clean.
- User requests assistant-led browser acceptance before their final acceptance. This is a correction within the approved unified-message design, not a new platform capability.
- All actual platform work remains background, serial and read-only. No focus, send, apply or resume consent; do not remove account/target/abort/pacing guards.
- Main's live read-only premise: actual URL origin `https://i.zhaopin.com`, path `/im`, query keys `refcode` and `sessionId`, 21 session rows, main/header DOM present, `hasFocus:false`. Current public reader throws `ZHAOPIN_MESSAGE_TAB_MISSING`. Do not store live IDs or message text in Git.
- Main's live Dashboard evidence: both sources reported not_connected; live run unresolved=0, but rendered page showed unresolved=3 and BOSS city mismatch recovery. Those three durable rows are BOSS observations from August 25/30, not this Zhaopin run. They remain retained.
- Do not alter jobs/cache policy, model quality, old BOSS history, installed app, version, push/merge/release state or evidence directories.
- Workers use local synthetic tests only; main runs real acceptance and any final full gate.

### Task 1: Correct IM page recognition and historical/current status composition

**Ownership:** `src/adapters/sites/zhaopin_message_reader.js`, `src/dashboard/message_discovery_controller.js`, `src/dashboard/message_discovery_view.js`; existing `tests/zhaopin_message_reader_smoke.js`, `tests/dashboard_unified_messages_journey.js` and only necessary existing `tests/dashboard_message_discovery_smoke.js` assertions. No new production module or API.

**Interfaces:** Keep `createZhaopinMessageReader`, snapshot export and controller/public status schema compatible. A small exported `isZhaopinMessageUrl(value)` predicate in the reader may be shared by controller and embedded page expressions; no duplicate independently evolving URL policy. Existing `startedAt` distinguishes a current in-memory run from restored durable status.

- [ ] **Step 1: Write and run failing behavioral regressions.** Use the actual public reader against mounted synthetic DOM with a URL like `https://i.zhaopin.com/im?refcode=4089&sessionId=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#conversation`. Scan and open the bound target must succeed, returning the same real fixture content and zero sender/resume/focus/navigation calls. Keep the plain URL case and reject HTTP, another origin, another path and multiple matching IM tabs. Tests must cover snapshot and selection expressions, not merely the pure predicate.

```js
const scanned = await reader.scanConversationRows();
const selected = await reader.openQueuedConversation({ ...scanned.rows[0], tabId: scanned.tabId });
assert.equal(selected.sourceJobId, 'zhaopin:CCL1234567890J00123456789');
assert.equal(selected.messages[0].text, '你好');
```

Extend the real HTTP/SQLite/controller journey to use a parameterized IM tab. Save one old BOSS unresolved row before a successful Zhaopin-only run. The page's current status must remain completed with the run's unresolved=0; the old BOSS row remains visible under all/BOSS and hidden under Zhaopin, with an explicit source label and its own recovery explanation. Refresh must preserve the row and filter behavior. A current stopped/needs_user_action reason must not be replaced by an older BOSS reason. Assert browser-visible state, API state and retained DB row; no source-text tests.

- [ ] **Step 2: Apply minimal production corrections.** Accept only exact `url.origin === 'https://i.zhaopin.com' && url.pathname === '/im'`; query/fragment do not establish conversation identity. Reuse this same predicate in inventory, resolveMessageTab, snapshot and selection guard. Retain exact numeric tab/window bindings, one matching IM page, current DOM session/job matching and preview drift checks.

```js
function isZhaopinMessageUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://i.zhaopin.com' && url.pathname === '/im';
  } catch { return false; }
}
```

For a current run, preserve its status/reason/unresolved instead of overriding them with durableUnresolved[0]. Show durable pending count separately as retained records, label BOSS pending cards by source, and render each record's reason within its own card. Retain normal before-first-run/restart restoration and all source-filter/save/stop behavior. Do not clear history to make the test pass.

- [ ] **Step 3: Run focused strict GREEN, self-review and commit only owned files.**

```powershell
$env:NODE_PATH='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
$env:ROLEFLOW_REQUIRE_PLAYWRIGHT='1'
$env:PATH='D:/hermes/node;'+$env:PATH
$env:TEMP='D:/DevData/RoleFlow-tests'
$env:TMP=$env:TEMP
node tests/zhaopin_message_reader_smoke.js
node tests/dashboard_unified_messages_journey.js
node tests/dashboard_message_discovery_smoke.js
node tests/zhaopin_message_discovery_smoke.js
node tests/dashboard_message_reply_send_smoke.js
git diff --check
```

Report actual RED/GREEN outputs and commit SHA, then freeze. Main separately reviews the fix and runs final acceptance; do not launch the whole suite or access real accounts from worker.

## Main acceptance and delivery

- [ ] Independent task review, resolve any blocking findings and verify focused regressions on a static code commit.
- [ ] Browser-driven local UI start → real background Zhaopin reader → original text/manual request or explicit pending context → source filter → reload/stop. Use isolated acceptance data only. Real-model draft quality is only claimed if actually reached; no complete trusted Zhaopin job cache means original/pending is the expected boundary, not invented test data in the live store.
- [ ] Fresh appropriate final gate, handoff and exact SHA receipt; no push/merge/release. Preserve failed evidence and all data.
