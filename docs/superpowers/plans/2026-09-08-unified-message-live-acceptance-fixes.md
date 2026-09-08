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

- [x] **Step 1: Write and run failing behavioral regressions.** Use the actual public reader against mounted synthetic DOM with a URL like `https://i.zhaopin.com/im?refcode=4089&sessionId=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#conversation`. Scan and open the bound target must succeed, returning the same real fixture content and zero sender/resume/focus/navigation calls. Keep the plain URL case and reject HTTP, another origin, another path and multiple matching IM tabs. Tests must cover snapshot and selection expressions, not merely the pure predicate.

```js
const scanned = await reader.scanConversationRows();
const selected = await reader.openQueuedConversation({ ...scanned.rows[0], tabId: scanned.tabId });
assert.equal(selected.sourceJobId, 'zhaopin:CCL1234567890J00123456789');
assert.equal(selected.messages[0].text, '你好');
```

Extend the real HTTP/SQLite/controller journey to use a parameterized IM tab. Save one old BOSS unresolved row before a successful Zhaopin-only run. The page's current status must remain completed with the run's unresolved=0; the old BOSS row remains visible under all/BOSS and hidden under Zhaopin, with an explicit source label and its own recovery explanation. Refresh must preserve the row and filter behavior. A current stopped/needs_user_action reason must not be replaced by an older BOSS reason. Assert browser-visible state, API state and retained DB row; no source-text tests.

- [x] **Step 2: Apply minimal production corrections.** Accept only exact `url.origin === 'https://i.zhaopin.com' && url.pathname === '/im'`; query/fragment do not establish conversation identity. Reuse this same predicate in inventory, resolveMessageTab, snapshot and selection guard. Retain exact numeric tab/window bindings, one matching IM page, current DOM session/job matching and preview drift checks.

```js
function isZhaopinMessageUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://i.zhaopin.com' && url.pathname === '/im';
  } catch { return false; }
}
```

For a current run, preserve its status/reason/unresolved instead of overriding them with durableUnresolved[0]. Show durable pending count separately as retained records, label BOSS pending cards by source, and render each record's reason within its own card. Retain normal before-first-run/restart restoration and all source-filter/save/stop behavior. Do not clear history to make the test pass.

- [x] **Step 3: Run focused strict GREEN, self-review and commit only owned files.**

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

### Task 2: Do not mistake normal IM header links for an authentication challenge

**New live evidence, within the same assistant acceptance:** On frozen `9e24f7c`, the UI correctly finds Zhaopin but stops with `ZHAOPIN_MESSAGE_LOGIN_REQUIRED`, current unresolved 0. Main inspected the exact matched DOM: two visible anchors, `a.home-header__b-login` (我要招人) and `a.home-header__c-no-login` (登录/注册), both direct children of `.home-header__right`. At the same time there are 21 session rows, the expected SidePanelThreeColumns/MainPanelThreeColumns components and a header session. The two broad `[class*='login']` guards treat these normal header entries as authentication loss. No actual login challenge or account loss was observed. A background crop capture timed out; do not focus or repeat screenshots to overcome it.

**Ownership:** `src/adapters/sites/zhaopin_message_reader.js` and `tests/zhaopin_message_reader_smoke.js` only. Main owns docs, running service and real account checks. Continue from `9e24f7c728ef4b78574a5a1a2cfe3f52ba3b718f`; no concurrent writer.

- [x] First add the exact observed synthetic header links to the mounted fixture and show the public reader scan/open fails with LOGIN_REQUIRED. Do not count a missing helper or harness error as RED.
- [x] Exempt only the observed ordinary header anchors from the login challenge check in snapshot and selection; keep one consistent small DOM predicate if sharing avoids duplication. Do not ignore all links, all header content, arbitrary login markers or real login panels. No new module/dependency or authentication framework.
- [x] Add behavioral regressions: valid IM with those links scans and opens; a visible real login panel still stops scan and a panel appearing between scan and selection prevents the row click; no send/resume/focus/navigation actions. Preserve URL, identity, loading, abort and risk-control checks.
- [x] Run the existing reader smoke and unified Dashboard journey with strict Playwright; self-review, commit only owned files, report real RED/GREEN and freeze. Do not access real pages or restart main's service.
- [x] Main independently reviews this delta, restarts its managed service, and resumes the actual UI acceptance. This is a newly surfaced pre-existing bug, not a regression caused by Task 1; preserve Task 1's review evidence.

### Main copy correction discovered during actual acceptance

The real page successfully shows 21 incoming conversations, but its label `HR 新回复 0` actually reflects replies that reached classification (the existing `newReplies` counter increments only after that stage). After the static full gate finishes, main will change this label to `已分析回复` and update the one existing rendering assertion. This is a copy correction only: no counter/schema/history or job-linking semantics change, no new prose-only test. Verify the existing Dashboard smoke and journey, refresh the actual service, and review this tiny delta before handoff.

- [x] Accurate reply-counter label and existing checks verified; no invented data or altered statistics.

## Main acceptance and delivery

- [x] Independent task review, resolve any blocking findings and verify focused regressions on a static code commit.
- [x] Browser-driven local UI start → real background Zhaopin reader → original text/manual request or explicit pending context → source filter → reload/stop. Use isolated acceptance data only. Real-model draft quality is only claimed if actually reached; no complete trusted Zhaopin job cache means original/pending is the expected boundary, not invented test data in the live store.
- [x] Fresh appropriate final gate, handoff and exact SHA receipt; no push/merge/release. Preserve failed evidence and all data.
