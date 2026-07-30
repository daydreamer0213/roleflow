# BOSS Message Read Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在一个已存在的 BOSS 消息标签页中后台串行发现未读 HR 消息，可靠关联进展卡后复用现有分类/草稿流程，同时保持人工发送和严格隐私边界。

**Architecture:** 新增纯 DOM 快照模块、受保护的单标签页读取器和串行发现执行器。执行器复用现有候选人全局进展卡、模型通信合同和 BOSS 站点互斥租约；dashboard 只在内存保存草稿，SQLite 只保存安全摘要和净化进展事件。

**Tech Stack:** Node.js 22 CommonJS、原生 `node:crypto`、原生 `node:sqlite`、现有 `EdgeControlAdapter`、原生 HTTP dashboard、assert-based smoke tests。

## Global Constraints

- 只使用一个已经打开的 `/web/geek/chat` 标签页；不得创建标签页、导航或调用 `bringToFront`。
- 只扫描 `.notice-badge`，首次快照生成不可变队列，串行 guarded click。
- 只允许 `listTabs`、`evalValue` 和对目标会话行的一次 `clickAt`；永不触碰 `.chat-input`、`.btn-send`。
- 禁止重放 `getGeekFriendList.json`、`getBossData`、`historyMsg`，禁止读取 Cookie/localStorage。
- 只有唯一匹配当前 profile 的现有非终态进展卡时才分类；映射不可靠立即停止且不生成草稿。
- HR 正文只在内存中传入现有模型流程，禁止日志和数据库；模型草稿也禁止持久化。
- 持久化仅允许 platform、线程安全摘要、消息安全摘要、分类、时间、缺失事实键和用户确认短摘要。
- 面试邀请只进入 `interview_invited`，返回空草稿，不自动确认时间。
- 不自动填写、不自动发送；保留人工粘贴和“已手动发送”。
- 风控、登录、页面丢失、身份漂移或租约丢失立即停止。
- 每条成功处理的会话间隔 1.5 至 2.5 秒，每 10 次会话点击冷却 15 秒；等待可被停止信号中断。
- 测试只使用脱敏 DOM fixture、假浏览器、假模型和临时数据库。
- 不新增第三方依赖，不直接调用平台 API。
- 每个任务先 RED、再最小 GREEN、再针对性回归、再小 commit。

---

## File Map

**Create:**

- `src/adapters/sites/boss_message_dom.js`：纯 DOM 快照、规范化、安全摘要和不可变未读队列。
- `src/adapters/sites/boss_message_reader.js`：查找固定消息标签页、点击前后 guard、后台单次点击。
- `src/core/message_discovery.js`：串行执行、唯一岗位关联、模型调用、停止策略。
- `tests/fixtures/boss_message_dom_fixture.js`：脱敏的 document-like DOM fixture。
- `tests/boss_message_dom_smoke.js`：选择器、方向、消息 ID、队列纯逻辑测试。
- `tests/boss_message_reader_smoke.js`：假浏览器、单击、漂移和停止测试。
- `tests/message_discovery_smoke.js`：临时 DB、假模型、幂等、隐私和阶段测试。
- `tests/dashboard_message_discovery_smoke.js`：本地 HTTP 启停、状态、内存草稿和人工兜底测试。

**Modify:**

- `src/core/candidate_progress.js`：发现候选卡查询、线程绑定、消息内部幂等事件。
- `src/dashboard/server.js`：`/messages` 页面、启停/状态 API、内存运行状态和站点租约。
- `tests/run_all.js`：注册四个新离线 smoke。
- `README.md`：说明自动发现仍是只读、人工发送。
- `docs/daily_workflow.md`：加入消息发现操作步骤和人工兜底。
- `docs/operations.md`：加入固定标签页、租约、停止和恢复。
- `docs/llm_contracts.md`：说明正文仅在内存进入现有通信合同。

**Do not modify:**

- `src/core/communication_executor.js` 的真实沟通点击路径。
- BOSS 内部 API、Cookie、localStorage 或真实聊天数据。
- 主工作树或真实 `data/jobs.sqlite`。

---

### Task 1: Pure DOM Snapshot And Immutable Unread Queue

**Files:**

- Create: `src/adapters/sites/boss_message_dom.js`
- Create: `tests/fixtures/boss_message_dom_fixture.js`
- Create: `tests/boss_message_dom_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

- Produces: `snapshotBossMessagePage(documentLike, locationHref) -> BossMessageSnapshot`
- Produces: `buildUnreadConversationQueue(snapshot) -> ReadonlyArray<UnreadQueueItem>`
- Produces: `safeDigest(parts) -> "sha256:<64 hex>"`
- Produces: `messageKey({ platform, threadKey, messageId }) -> "sha256:<64 hex>"`
- Produces: `BOSS_MESSAGE_SNAPSHOT_EXPRESSION -> string`
- Consumes: only the confirmed selectors from the design spec.

- [ ] **Step 1: Write the failing DOM smoke test**

Create a document-like fixture with 3 conversation rows: two unread, one selected, and messages in all three directions. The fixture must contain fake names and text only.

```js
const assert = require("node:assert");
const {
  snapshotBossMessagePage,
  buildUnreadConversationQueue,
  messageKey
} = require("../src/adapters/sites/boss_message_dom");
const { createBossMessageDomFixture } = require("./fixtures/boss_message_dom_fixture");

const documentLike = createBossMessageDomFixture();
const snapshot = snapshotBossMessagePage(documentLike, "https://www.zhipin.com/web/geek/chat");

assert.strictEqual(snapshot.path, "/web/geek/chat");
assert.deepStrictEqual(snapshot.rows.map((row) => row.unread), [true, false, true]);
assert.deepStrictEqual(snapshot.messages.map((item) => item.direction), ["friend", "myself", "system"]);
assert(snapshot.messages.every((item) => /^\d{15}$/.test(item.messageId)));

const queue = buildUnreadConversationQueue(snapshot);
assert.deepStrictEqual(queue.map((item) => item.rowIndex), [0, 2]);
assert(Object.isFrozen(queue));
assert(queue.every(Object.isFrozen));
assert.throws(() => queue.push({}), TypeError);
assert.match(messageKey({
  platform: "boss",
  threadKey: `sha256:${"a".repeat(64)}`,
  messageId: "123456789012345"
}), /^sha256:[a-f0-9]{64}$/);
```

Add negative cases for:

```js
assert.throws(
  () => snapshotBossMessagePage(documentLike, "https://www.zhipin.com/web/geek/jobs"),
  (error) => error.code === "BOSS_MESSAGE_PAGE_LOST"
);
assert.throws(
  () => messageKey({ platform: "boss", threadKey: "raw-name", messageId: "bad" }),
  (error) => error.code === "BOSS_MESSAGE_ID_INVALID"
);
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node tests/boss_message_dom_smoke.js
```

Expected: FAIL with `Cannot find module '../src/adapters/sites/boss_message_dom'`.

- [ ] **Step 3: Implement the minimum pure DOM module**

Implement these constants and functions:

```js
const crypto = require("node:crypto");

const SELECTORS = Object.freeze({
  row: ".friend-content-warp",
  unread: ".notice-badge",
  selected: ".selected, .friend-top",
  header: ".top-info-content",
  position: ".chat-position-content .position-name",
  salary: ".salary",
  city: ".city",
  message: ".message-item",
  editor: ".chat-input",
  send: ".btn-send"
});

function safeDigest(parts) {
  const value = parts.map((item) => String(item || "").trim()).join("\0");
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function messageKey({ platform, threadKey, messageId }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(String(threadKey || ""))) {
    throw codedError("BOSS_MESSAGE_THREAD_INVALID", "thread digest is invalid");
  }
  if (!/^\d{15}$/.test(String(messageId || ""))) {
    throw codedError("BOSS_MESSAGE_ID_INVALID", "message id is invalid");
  }
  return safeDigest([platform, threadKey, messageId]);
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function visibleLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map(normalizedText)
    .filter(Boolean);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
```

`snapshotBossMessagePage` must:

```js
function snapshotBossMessagePage(documentLike, locationHref) {
  const path = new URL(locationHref).pathname;
  if (path !== "/web/geek/chat") {
    throw codedError("BOSS_MESSAGE_PAGE_LOST", "fixed BOSS message page is not available");
  }
  const rows = [...documentLike.querySelectorAll(SELECTORS.row)].map((row, rowIndex) => {
    const rect = row.getBoundingClientRect();
    return {
      rowIndex,
      unread: Boolean(row.querySelector(SELECTORS.unread)),
      selected: row.matches(SELECTORS.selected) || Boolean(row.querySelector(SELECTORS.selected)),
      recruiterLabel: visibleLines(row.innerText)[0] || "",
      previewText: visibleLines(row.innerText).at(-1) || "",
      point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    };
  });
  const messages = [...documentLike.querySelectorAll(SELECTORS.message)].map((item) => ({
    direction: item.matches(".item-friend") ? "friend"
      : item.matches(".item-myself") ? "myself"
      : "system",
    messageId: String(item.getAttribute("data-mid") || ""),
    text: normalizedText(item.textContent)
  }));
  return {
    path,
    rows,
    headerText: visibleLines(documentLike.querySelector(SELECTORS.header)?.innerText)[0] || "",
    positionName: normalizedText(documentLike.querySelector(SELECTORS.position)?.textContent),
    salary: normalizedText(documentLike.querySelector(SELECTORS.salary)?.textContent),
    city: normalizedText(documentLike.querySelector(SELECTORS.city)?.textContent),
    messages,
    writeTargetsPresent: {
      editor: Boolean(documentLike.querySelector(SELECTORS.editor)),
      send: Boolean(documentLike.querySelector(SELECTORS.send))
    }
  };
}
```

`buildUnreadConversationQueue` must compute `transientSignature` and `previewDigest` in Node, keep raw recruiter/preview only in memory, filter only `unread === true`, and deep-freeze the result. Do not export selectors for write actions as callable helpers.

Do not invent unconfirmed `data-recruiter`, `data-preview` or hidden application-state attributes.

Build `BOSS_MESSAGE_SNAPSHOT_EXPRESSION` from a self-contained browser function that returns the same plain object. It may read `.chat-input` and `.btn-send` only as boolean sentinels; it must not focus, click, assign, dispatch events or return element references.

- [ ] **Step 4: Run Task 1 GREEN and regressions**

Run:

```powershell
node tests/boss_message_dom_smoke.js
node tests/data_visibility_smoke.js
```

Expected: both pass. `data_visibility_smoke.js` confirms no forbidden communication content has become persistent.

- [ ] **Step 5: Register and commit Task 1**

Add `boss_message_dom_smoke.js` to `tests/run_all.js` immediately before existing communication smoke tests.

```powershell
git add src/adapters/sites/boss_message_dom.js tests/fixtures/boss_message_dom_fixture.js tests/boss_message_dom_smoke.js tests/run_all.js
git commit -m "feat: parse unread BOSS message DOM"
```

---

### Task 2: Single-Tab Read-Only Guarded Reader

**Files:**

- Create: `src/adapters/sites/boss_message_reader.js`
- Create: `tests/boss_message_reader_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

- Consumes: `BOSS_MESSAGE_SNAPSHOT_EXPRESSION`, `buildUnreadConversationQueue`, `safeDigest`.
- Consumes browser methods: `listTabs`, `evalValue`, `clickAt`.
- Produces: `createBossMessageReader({ browser, sleepFn })`.
- Produces: `reader.scanUnread() -> { tabId, queue }`.
- Produces: `reader.openQueuedConversation(target, signal) -> SelectedConversationSnapshot`.

- [ ] **Step 1: Write the failing fake-browser test**

Use a fake browser that records every method:

```js
const browser = {
  calls: [],
  snapshots: [initialSnapshot, preClickSnapshot, selectedSnapshot],
  async listTabs() {
    this.calls.push(["listTabs"]);
    return [{ id: "chat-tab", url: "https://www.zhipin.com/web/geek/chat" }];
  },
  async evalValue(tabId) {
    this.calls.push(["evalValue", tabId]);
    return this.snapshots.shift();
  },
  async clickAt(tabId, point) {
    this.calls.push(["clickAt", tabId, point]);
  },
  async navigate() { throw new Error("navigate must never be called"); },
  async createTab() { throw new Error("createTab must never be called"); },
  async bringToFront() { throw new Error("bringToFront must never be called"); }
};
```

Assert:

```js
const reader = createBossMessageReader({ browser, sleepFn: async () => {} });
const scan = await reader.scanUnread();
assert.strictEqual(scan.tabId, "chat-tab");
assert(Object.isFrozen(scan.queue));

const selected = await reader.openQueuedConversation(scan.queue[0]);
assert.strictEqual(selected.positionName, "Java Engineer");
assert.strictEqual(browser.calls.filter(([name]) => name === "clickAt").length, 1);
assert.strictEqual(browser.calls.some(([name]) => ["navigate", "createTab", "bringToFront"].includes(name)), false);
```

Add cases proving:

- Zero chat tabs throws `BOSS_MESSAGE_TAB_MISSING`.
- Two chat tabs throws `BOSS_MESSAGE_TAB_AMBIGUOUS`.
- Row reorder/signature drift throws `BOSS_MESSAGE_ROW_DRIFTED` before click.
- Badge disappears before click returns `skipped` without clicking.
- Wrong selected row/header after click throws `BOSS_MESSAGE_TARGET_MISMATCH`.
- Risk/login/page-loss snapshot throws before any further queue item.
- Abort signal stops before click.

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node tests/boss_message_reader_smoke.js
```

Expected: FAIL with `Cannot find module '../src/adapters/sites/boss_message_reader'`.

- [ ] **Step 3: Implement the guarded reader**

Implement:

```js
function createBossMessageReader({ browser, sleepFn = sleep } = {}) {
  assertBrowser(browser);
  return {
    async scanUnread() {
      const tabs = (await browser.listTabs())
        .filter((tab) => new URL(String(tab.url || "")).pathname === "/web/geek/chat");
      if (tabs.length === 0) throw codedError("BOSS_MESSAGE_TAB_MISSING", "open the fixed BOSS message page");
      if (tabs.length !== 1) throw codedError("BOSS_MESSAGE_TAB_AMBIGUOUS", "exactly one BOSS message tab is required");
      const snapshot = normalizeBrowserSnapshot(await browser.evalValue(tabs[0].id, BOSS_MESSAGE_SNAPSHOT_EXPRESSION));
      return { tabId: tabs[0].id, queue: buildUnreadConversationQueue(snapshot) };
    },
    async openQueuedConversation(target, signal) {
      throwIfAborted(signal);
      const before = normalizeBrowserSnapshot(await browser.evalValue(target.tabId, BOSS_MESSAGE_SNAPSHOT_EXPRESSION));
      const row = before.rows[target.rowIndex];
      if (!row?.unread) return { skipped: true, reasonCode: "BOSS_MESSAGE_NO_LONGER_UNREAD" };
      if (conversationSignature(row) !== target.transientSignature) {
        throw codedError("BOSS_MESSAGE_ROW_DRIFTED", "conversation row changed before selection");
      }
      throwIfAborted(signal);
      await browser.clickAt(target.tabId, row.point);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt) await sleepFn(250, signal);
        const after = normalizeBrowserSnapshot(await browser.evalValue(target.tabId, BOSS_MESSAGE_SNAPSHOT_EXPRESSION));
        if (selectedTargetMatches(after, target)) return after;
      }
      throw codedError("BOSS_MESSAGE_TARGET_MISMATCH", "selected conversation identity did not match");
    }
  };
}

function assertBrowser(browser) {
  for (const name of ["listTabs", "evalValue", "clickAt"]) {
    if (typeof browser?.[name] !== "function") {
      throw codedError("BOSS_MESSAGE_BROWSER_INVALID", `browser.${name} is required`);
    }
  }
}

function conversationSignature(row) {
  return safeDigest([
    row.rowIndex,
    row.recruiterLabel,
    row.previewText,
    row.unread ? "unread" : "read"
  ]);
}

function selectedTargetMatches(snapshot, target) {
  const selected = snapshot.rows.filter((row) => row.selected);
  return selected.length === 1
    && selected[0].rowIndex === target.rowIndex
    && conversationSignature({ ...selected[0], unread: true }) === target.transientSignature
    && Boolean(snapshot.headerText)
    && Boolean(snapshot.positionName)
    && snapshot.messages.every((item) => /^\d{15}$/.test(item.messageId));
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason || codedError("MESSAGE_DISCOVERY_STOPPED", "message discovery stopped");
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || codedError("MESSAGE_DISCOVERY_STOPPED", "message discovery stopped"));
    }, { once: true });
  });
}
```

When `scanUnread` builds the queue, attach `tabId` by creating a new frozen object; do not mutate Task 1 output. `selectedTargetMatches` must require selected row index/signature plus non-empty header and position. It must validate all message IDs before returning.

`normalizeBrowserSnapshot` must call the same field validators used by Task 1 and reject unknown paths, non-array rows/messages, non-finite click coordinates and invalid directions with `BOSS_MESSAGE_STRUCTURE_CHANGED`. It must return a newly created plain object and must never log the rejected raw value.

Do not import or call `BossSiteAdapter.prepareCommunicationTab`; that method may create or navigate tabs and violates this design.

- [ ] **Step 4: Run Task 2 GREEN and browser regressions**

Run:

```powershell
node tests/boss_message_reader_smoke.js
node tests/boss_communication_action_smoke.js
node tests/communication_calibration_gate_smoke.js
```

Expected: all pass; existing communication safety calibration remains unchanged.

- [ ] **Step 5: Register and commit Task 2**

```powershell
git add src/adapters/sites/boss_message_reader.js tests/boss_message_reader_smoke.js tests/run_all.js
git commit -m "feat: guard read-only message selection"
```

---

### Task 3: Idempotent Progress Integration And Serial Discovery

**Files:**

- Modify: `src/core/candidate_progress.js`
- Create: `src/core/message_discovery.js`
- Create: `tests/message_discovery_smoke.js`
- Modify: `tests/candidate_progress_storage_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

- Produces: `listMessageDiscoveryCandidates(db, { profileId })`.
- Produces: `recordDiscoveredMessageClassification(db, input) -> CandidateProgressCard`.
- Produces: `runBossMessageDiscovery(context) -> MessageDiscoverySummary`.
- Consumes: `reader.scanUnread`, `reader.openQueuedConversation`.
- Consumes: `classifyMessage({ card, job, hrMessage }) -> validated communication result`.
- Reuses: existing progress stages and fixed sanitized summaries.

- [ ] **Step 1: Write failing storage and executor tests**

In `tests/candidate_progress_storage_smoke.js`, create one progress card and assert:

```js
const candidates = listMessageDiscoveryCandidates(db, { profileId });
assert.deepStrictEqual(candidates.map((item) => item.cardId), [card.id]);
assert.strictEqual(candidates[0].title, "Java Engineer");

const recorded = recordDiscoveredMessageClassification(db, {
  cardId: card.id,
  platform: "boss",
  threadKey: `sha256:${"a".repeat(64)}`,
  messageKey: `sha256:${"b".repeat(64)}`,
  messageCategory: "qualification",
  missingFactKey: "",
  progressUpdate: { stage: "reply_ready", nextAction: "请用户复制后手动发送" },
  occurredAt: "2026-07-30T01:00:00.000Z"
});
assert.strictEqual(recorded.stage, "reply_ready");
assert.strictEqual(recorded.threadKey, `sha256:${"a".repeat(64)}`);
```

Call it again with the same input and assert one event only. Change category under the same message key and assert `PROGRESS_IDEMPOTENCY_CONFLICT`. Force the stage update to fail and assert both `thread_key` and event insert roll back.

In `tests/message_discovery_smoke.js`, build temporary DB fixtures and assert:

```js
const summary = await runBossMessageDiscovery({
  db,
  profileId,
  reader: fakeReader,
  classifyMessage: async ({ hrMessage }) => {
    assert.strictEqual(hrMessage, "脱敏测试问题");
    return {
      kind: "hr_reply",
      messageCategory: "qualification",
      missingFact: null,
      progressUpdate: { stage: "reply_ready", nextAction: "请用户复制后手动发送" },
      messages: ["脱敏草稿一"]
    };
  },
  logger: collectingLogger
});
assert.strictEqual(summary.processed, 1);
assert.deepStrictEqual(summary.results[0].messages, ["脱敏草稿一"]);
```

Query every text column in `candidate_progress_cards` and `candidate_progress_events` and stringify collected logs. Assert neither contains `脱敏测试问题`, conversation preview, recruiter name or `脱敏草稿一`.

Add cases for:

- Unique active card succeeds.
- No card or multiple title matches stops without model call.
- Salary/city conflict stops.
- Existing different `thread_key` stops.
- Multiple unprocessed friend messages stops without model call.
- Existing message key skips classification idempotently.
- Missing fact enters `needs_user_action` with no draft.
- Interview invitation enters `interview_invited` with `messages: []`.
- Reader risk/login/page error stops the whole immutable queue.
- Between-item waits use injected fixed randomness, and the 10th click adds a 15-second cooldown.
- Abort or lease loss interrupts both normal pacing and periodic cooldown.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
node tests/candidate_progress_storage_smoke.js
node tests/message_discovery_smoke.js
```

Expected: FAIL because the new exports and `message_discovery.js` do not exist.

- [ ] **Step 3: Add strict discovery persistence**

Extend allowed metadata keys with only:

```js
"platform",
"threadKey",
"messageKey"
```

Add internal validation:

```js
function safeDigestKey(value, name) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) {
    throw progressError("PROGRESS_SAFE_IDENTIFIER_INVALID", `${name} must be a SHA-256 digest`);
  }
  return normalized;
}

function messageIdempotencyKey(platform, messageKey) {
  if (platform !== "boss") {
    throw progressError("PROGRESS_PLATFORM_INVALID", "message platform is invalid");
  }
  return `message:boss:${safeDigestKey(messageKey, "messageKey").slice(7)}`;
}
```

`recordDiscoveredMessageClassification` must:

1. Load the card.
2. Validate safe thread/message digests.
3. Look up `card_id + idempotency_key` before checking the current stage.
4. Return the current card when the existing intent matches.
5. Start `BEGIN IMMEDIATE`.
6. Bind `thread_key` only when empty; reject a different existing digest.
7. Insert the sanitized classification event with internal message idempotency.
8. Transition the stage.
9. Commit, or roll back all three writes.

Use the existing `assertEventIntent`, `sanitizedMessageSummary` and transition rules. Do not add message text, recruiter text or drafts to function arguments.

Extend the existing persistence selector instead of inserting around it:

```js
const idempotencyKey = keyKind === "communication"
  ? communicationIdempotencyKey(input.idempotencyKey)
  : keyKind === "message"
    ? messageIdempotencyKey(input.platform, input.messageKey)
    : progressIdempotencyKey(input.idempotencyKey);
```

Call `persistProgressEvent(..., { keyKind: "message" })`. The event insert continues to use the existing unique `(card_id, idempotency_key)` index and `assertEventIntent`.

Add:

```js
function listMessageDiscoveryCandidates(db, { profileId } = {}) {
  return db.prepare(`SELECT
      cards.id AS card_id,
      cards.job_id,
      cards.plan_id,
      cards.source,
      cards.stage,
      cards.thread_key,
      jobs.title,
      jobs.company,
      jobs.salary,
      jobs.location AS city
    FROM candidate_progress_cards cards
    JOIN jobs ON jobs.id = cards.job_id
    WHERE cards.profile_id = ?
      AND cards.source = 'boss'
      AND cards.stage NOT IN ('rejected', 'closed')
    ORDER BY cards.updated_at DESC, cards.id DESC`)
    .all(positiveInteger(profileId, "profileId"))
    .map(mapDiscoveryCandidate);
}
```

- [ ] **Step 4: Implement the serial executor**

Create:

```js
async function runBossMessageDiscovery({
  db,
  profileId,
  reader,
  classifyMessage,
  logger = null,
  signal = null,
  now = () => new Date().toISOString(),
  sleepFn = abortableSleep,
  randomFn = Math.random,
  onStatus = () => {}
}) {
  const candidates = listMessageDiscoveryCandidates(db, { profileId });
  const { queue } = await reader.scanUnread();
  const results = [];
  onStatus(safeStatus("running", { queued: queue.length, processed: 0 }));

  for (const target of queue) {
    throwIfAborted(signal);
    const selected = await reader.openQueuedConversation(target, signal);
    if (selected.skipped) continue;
    const resolved = resolveUniqueCandidate(candidates, selected);
    if (!resolved.ok) return stoppedSummary(resolved.reasonCode, queue.length, results);
    const incoming = selectSingleUnprocessedFriendMessage(db, resolved.cardId, selected);
    if (!incoming.ok) return stoppedSummary(incoming.reasonCode, queue.length, results);
    const result = await classifyMessage({
      card: resolved.card,
      job: resolved.job,
      hrMessage: incoming.text
    });
    incoming.text = "";
    const card = recordDiscoveredMessageClassification(db, {
      cardId: resolved.cardId,
      platform: "boss",
      threadKey: resolved.threadKey,
      messageKey: incoming.messageKey,
      messageCategory: result.messageCategory,
      missingFactKey: result.missingFact?.key || "",
      progressUpdate: result.progressUpdate,
      occurredAt: now()
    });
    results.push(safeResult(card, result));
    onStatus(safeStatus("running", { queued: queue.length, processed: results.length, results }));
    if (results.length < queue.length) {
      await sleepFn(randomBetween(1500, 2500, randomFn), signal);
      if (results.length % 10 === 0) await sleepFn(15_000, signal);
    }
  }
  return safeStatus("completed", { queued: queue.length, processed: results.length, results });
}

function randomBetween(min, max, randomFn) {
  return Math.floor(min + randomFn() * (max - min + 1));
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || discoveryError("MESSAGE_DISCOVERY_STOPPED", "message discovery stopped"));
    }, { once: true });
  });
}

function safeStatus(status, value = {}) {
  return {
    status,
    queued: Number(value.queued || 0),
    processed: Number(value.processed || 0),
    reasonCode: String(value.reasonCode || ""),
    results: Array.isArray(value.results) ? value.results.map((item) => ({ ...item })) : []
  };
}

function stoppedSummary(reasonCode, queued, results) {
  return safeStatus("needs_user_action", {
    reasonCode,
    queued,
    processed: results.length,
    results
  });
}

function discoveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
```

`resolveUniqueCandidate` must normalize whitespace/case and require exactly one title match. Salary/city are rejection checks when both local and page values are non-empty. Compute:

```js
const threadKey = safeDigest(["boss", selected.headerText, selected.positionName]);
```

`selectSingleUnprocessedFriendMessage` must use message safe digests and existing progress events. If more than one unprocessed friend message appears after the latest `myself` message, return `BOSS_MESSAGE_MULTIPLE_UNPROCESSED`. It must never join messages.

`safeResult` may return:

```js
{
  cardId,
  jobId,
  stage,
  messageCategory,
  missingFactKey,
  messages: result.messageCategory === "interview_invitation" ? [] : result.messages.slice(0, 2)
}
```

It must not return HR text, preview, recruiter label, thread raw material or browser snapshot.

- [ ] **Step 5: Run Task 3 GREEN and regressions**

Run:

```powershell
node tests/candidate_progress_storage_smoke.js
node tests/message_discovery_smoke.js
node tests/storage_migration_smoke.js
node tests/communication_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/data_visibility_smoke.js
```

Expected: all pass. Existing manual paste, interview empty-draft rule and v5/v6 migration stay intact.

- [ ] **Step 6: Register and commit Task 3**

```powershell
git add src/core/candidate_progress.js src/core/message_discovery.js tests/candidate_progress_storage_smoke.js tests/message_discovery_smoke.js tests/run_all.js
git commit -m "feat: classify discovered messages safely"
```

---

### Task 4: Dashboard Trigger, Status And In-Memory Drafts

**Files:**

- Modify: `src/dashboard/server.js`
- Create: `tests/dashboard_message_discovery_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

- Produces page: `GET /messages?profileId=<id>`.
- Produces API: `POST /api/message-discovery`.
- Produces API: `GET /api/message-discovery-status?profileId=<id>`.
- Consumes: `EdgeControlAdapter`, `createBossMessageReader`, `runBossMessageDiscovery`.
- Reuses: `acquireSiteScanLease`, `renewSiteScanLease`, `releaseSiteScanLease`.
- Reuses: existing `createLlmAnalyzer(...).draftCommunication(...)`.

- [ ] **Step 1: Write the failing dashboard smoke test**

Construct `createDashboardServer` with injected fakes:

```js
server = createDashboardServer({
  db,
  root,
  dbPath,
  forceMock: true,
  messageDiscoveryDependencies: {
    createBrowser: () => fakeBrowser,
    createReader: () => fakeReader,
    runDiscovery: fakeRunDiscovery,
    leaseHeartbeatMs: 5
  }
});
```

Assert:

```js
const page = await request("/messages?profileId=" + profileId);
assert.strictEqual(page.status, 200);
assert(page.body.includes("开始只读发现"));
assert(page.body.includes("人工粘贴"));
assert(!page.body.includes("自动发送"));

const started = await post("/api/message-discovery", {
  action: "start",
  profileId
});
assert.strictEqual(started.status, 202);

const status = await waitForStatus(profileId, "completed");
assert.deepStrictEqual(status.results[0].messages, ["脱敏草稿一"]);
assert(!JSON.stringify(status).includes("脱敏测试问题"));
```

Add assertions:

- An active BOSS lease returns 409 before browser creation.
- A second start while running returns 409.
- Lease command is `discover-messages`.
- Lease renews while running and releases in `finally`.
- `stop` aborts before the next click.
- `dismiss` removes in-memory drafts.
- Starting a new run clears old drafts.
- Results expire after 30 minutes using an injected clock.
- “已手动发送” uses existing `/api/progress` and clears the matching in-memory draft.
- The rendered page has no input bound to `.chat-input`, no send action, and no HR body field.
- Manual `/api/communication` paste flow still returns a draft.

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node tests/dashboard_message_discovery_smoke.js
```

Expected: FAIL because `/messages` and `/api/message-discovery` return 404.

- [ ] **Step 3: Add injected dependencies and in-memory state**

Extend the server signature:

```js
function createDashboardServer({
  db,
  root = path.resolve(__dirname, "../.."),
  dbPath = "",
  modelConfig = DEFAULT_MODEL_CONFIG,
  allowOfflineMock = false,
  forceMock = false,
  connectionTester = testModelConnection,
  logger = createLogger({ root, component: "dashboard" }),
  spawnProcess = spawn,
  messageDiscoveryDependencies = {}
}) {
```

Create one global map inside the server:

```js
const messageDiscoveryRuns = new Map();
```

Each entry is safe for API output:

```js
{
  profileId,
  status,
  queued,
  processed,
  reasonCode,
  results,
  startedAt,
  updatedAt,
  expiresAt,
  abortController
}
```

`abortController` must be removed before serializing. Never store HR text, DOM snapshots, recruiter labels or conversation previews in this map.

- [ ] **Step 4: Add start/stop/dismiss lifecycle with the existing lease**

Route:

```js
if (req.method === "GET" && url.pathname === "/messages") {
  return sendHtml(res, renderMessageDiscoveryPage({ db, searchParams: url.searchParams, messageDiscoveryRuns }));
}
if (req.method === "GET" && url.pathname === "/api/message-discovery-status") {
  return handleMessageDiscoveryStatus(res, messageDiscoveryRuns, url.searchParams.get("profileId"));
}
if (req.method === "POST" && url.pathname === "/api/message-discovery") {
  return handleMessageDiscovery(req, res, { db, logger, messageDiscoveryRuns, getRuntimeModelConfig, dependencies: messageDiscoveryDependencies });
}
```

On `start`:

```js
const owner = randomUUID();
const lease = acquireSiteScanLease(db, {
  site: "boss",
  owner,
  command: "discover-messages",
  planId: null
});
const abortController = new AbortController();
const heartbeat = setInterval(() => {
  try {
    renewSiteScanLease(db, { site: "boss", owner });
  } catch (error) {
    const issue = new Error("BOSS lease was lost");
    issue.code = "MESSAGE_DISCOVERY_LEASE_LOST";
    abortController.abort(issue);
  }
}, leaseHeartbeatMs);
```

Run asynchronously in the same dashboard process so drafts remain memory-only. In `finally`:

```js
clearInterval(heartbeat);
releaseSiteScanLease(db, { site: "boss", owner });
```

Create the model callback by reusing the exact data preparation from `handleCommunication`: candidate profile without `riskMessaging`, active resume versions, job understanding, match decision, job evidence and user-confirmed facts. Call:

```js
analyzer.draftCommunication({
  mode: "hr_reply",
  candidateProfile,
  resumeVersions,
  jobUnderstanding,
  matchDecision,
  jobEvidence,
  hrMessage,
  userProvidedFacts
});
```

Do not log `hrMessage` or the model result. Log only IDs, counts, category, stage and fixed error code.

Return `202` after start is accepted. `stop` only calls `abortController.abort()`; it does not click or clear progress. `dismiss` removes result drafts and marks the entry dismissed.

- [ ] **Step 5: Render the local page**

Render:

- Start and safe-stop buttons.
- Status/counts and fixed reason text.
- Up to two readonly draft textareas with local clipboard buttons.
- Existing `/api/progress` “已手动发送” form using a fresh `progress:<UUID>`.
- “放弃本次草稿” button.
- Link back to existing manual paste form.

Poll status every 2 seconds only while `running`. The JSON renderer must explicitly select allowed fields instead of spreading the internal run object.

Do not render HR original text. Do not create any form that targets BOSS or any element named after `.chat-input`/`.btn-send`.

- [ ] **Step 6: Run Task 4 GREEN and dashboard regressions**

Run:

```powershell
node tests/dashboard_message_discovery_smoke.js
node tests/communication_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/dashboard_communication_batch_smoke.js
node tests/communication_executor_smoke.js
```

Expected: all pass. Manual paste, progress actions, batch communication safety and executor failure paths remain unchanged.

- [ ] **Step 7: Register and commit Task 4**

```powershell
git add src/dashboard/server.js tests/dashboard_message_discovery_smoke.js tests/run_all.js
git commit -m "feat: add message discovery dashboard"
```

---

### Task 5: Documentation, Regression And Independent Review

**Files:**

- Modify: `README.md`
- Modify: `docs/daily_workflow.md`
- Modify: `docs/operations.md`
- Modify: `docs/llm_contracts.md`

**Interfaces:**

- Documents the exact user workflow and fixed-tab requirement.
- Documents that “后台自动点开” is read-only discovery, not automatic reply.
- Documents stop/recovery behavior and privacy retention.

- [ ] **Step 1: Update user and operator documentation**

Document this exact lifecycle:

```text
打开一个固定 BOSS-COMMUNICATION 消息页
-> RoleFlow 后台扫描未读并固化队列
-> 串行点开、复核岗位和线程
-> 内存分类/草稿
-> 用户复制并手动发送
-> 用户确认“已手动发送”
```

State plainly:

- Do not run scan, detail inspection, batch communication and message discovery concurrently.
- Discovery never calls internal BOSS APIs.
- Drafts disappear after dismissal, a new run, 30 minutes or server restart.
- Mapping uncertainty stops the run and leaves manual paste available.
- Interview invitations never produce a reply draft.

- [ ] **Step 2: Run the complete affected smoke set**

Run:

```powershell
node tests/boss_message_dom_smoke.js
node tests/boss_message_reader_smoke.js
node tests/message_discovery_smoke.js
node tests/dashboard_message_discovery_smoke.js
node tests/candidate_progress_storage_smoke.js
node tests/storage_migration_smoke.js
node tests/communication_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/data_visibility_smoke.js
node tests/workflow_inventory_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/dashboard_communication_batch_smoke.js
node tests/communication_executor_smoke.js
node tests/communication_calibration_gate_smoke.js
node tests/boss_communication_action_smoke.js
```

Expected: all 15 commands pass using fixtures, fake browser/model and temporary databases only.

- [ ] **Step 3: Run syntax, diff and complete offline verification**

Run:

```powershell
node --check src/adapters/sites/boss_message_dom.js
node --check src/adapters/sites/boss_message_reader.js
node --check src/core/message_discovery.js
node --check src/core/candidate_progress.js
node --check src/dashboard/server.js
git diff --check
npm.cmd test
```

Expected:

- Every syntax check exits 0.
- `git diff --check` prints nothing.
- `npm.cmd test` ends with `All 46 offline checks passed.` after the four new smoke files are registered.

- [ ] **Step 4: Perform an independent read-only review**

Give a fresh reviewer the base commit and current HEAD. Require review of:

- Every path that can call `clickAt`.
- Proof that `navigate`, `createTab`, `bringToFront`, `.chat-input` and `.btn-send` are unreachable.
- Queue immutability and click-before/click-after identity checks.
- Unique profile/card/job association.
- Thread/message digest validation and event idempotency.
- Transaction rollback for thread binding + event + stage.
- HR body, preview, recruiter text and drafts absent from DB/logs/status API.
- Interview invitation empty drafts.
- Lease acquisition, renewal, loss and release.
- Preservation of manual paste and communication calibration/failure paths.

The reviewer must not edit files, access a browser, use a real database or inspect real chat.

- [ ] **Step 5: Fix review findings with TDD if necessary**

For every accepted finding:

1. Add the smallest failing offline assertion to the owning smoke test.
2. Run that test and observe the intended failure.
3. Apply the minimum production fix.
4. Re-run the owning test and affected regressions.
5. Commit one focused fix.

Do not weaken identity, privacy, idempotency, lease or stop guards merely to make a test pass.

- [ ] **Step 6: Commit Task 5 documentation**

```powershell
git add README.md docs/daily_workflow.md docs/operations.md docs/llm_contracts.md
git commit -m "docs: document read-only message discovery"
```

- [ ] **Step 7: Final clean-state report**

Run:

```powershell
git status --short
git log --oneline 5d320fd..HEAD
```

Expected: clean status. Report:

- Worktree and branch.
- New HEAD and all task commits.
- 15 affected smoke commands.
- Complete offline suite count.
- Independent review result.
- No real browser/database/chat access during implementation.
- No automatic fill/send path.
- Whether the branch was pushed, only according to the execution task's explicit Git instruction.

---

## Plan Self-Review Checklist

- [ ] Every design requirement maps to a task and concrete test.
- [ ] No task reads Cookie/localStorage or replays internal APIs.
- [ ] No task creates, navigates or foregrounds a BOSS tab.
- [ ] Every browser click has a pre-click and post-click identity guard.
- [ ] HR text is absent from persistence, logs and status output.
- [ ] Message idempotency and thread binding are one transaction.
- [ ] Dashboard drafts are memory-only and expire.
- [ ] Manual paste and manual send confirmation remain available.
- [ ] Full suite and independent review are mandatory before completion.
