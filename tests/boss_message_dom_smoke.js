const assert = require("node:assert");
const {
  snapshotBossMessagePage,
  buildUnreadConversationQueue,
  safeDigest,
  messageKey,
  BOSS_MESSAGE_PAGE_HELPERS_EXPRESSION,
  BOSS_MESSAGE_SNAPSHOT_EXPRESSION
} = require("../src/adapters/sites/boss_message_dom");
const { createBossMessageDomFixture } = require("./fixtures/boss_message_dom_fixture");

const documentLike = createBossMessageDomFixture();
const snapshot = snapshotBossMessagePage(documentLike, "https://www.zhipin.com/web/geek/chat");

assert.strictEqual(snapshot.path, "/web/geek/chat");
assert.deepStrictEqual(snapshot.rows.map((row) => row.unread), [true, false, true]);
assert.deepStrictEqual(snapshot.messages.map((item) => item.direction), ["friend", "myself", "system"]);
assert(snapshot.messages.every((item) => /^\d{15}$/.test(item.messageId)));
assert.deepStrictEqual(snapshot.writeTargetsPresent, { editor: true, send: true });

const queue = buildUnreadConversationQueue(snapshot);
assert.deepStrictEqual(queue.map((item) => item.rowIndex), [0, 2]);
assert(Object.isFrozen(queue));
assert(queue.every(Object.isFrozen));
assert.throws(() => queue.push({}), TypeError);
assert.match(safeDigest([" fake ", "value"]), /^sha256:[a-f0-9]{64}$/);
assert.match(messageKey({
  platform: "boss",
  threadKey: `sha256:${"a".repeat(64)}`,
  messageId: "123456789012345"
}), /^sha256:[a-f0-9]{64}$/);
assert.throws(
  () => snapshotBossMessagePage(documentLike, "https://www.zhipin.com/web/geek/jobs"),
  (error) => error.code === "BOSS_MESSAGE_PAGE_LOST"
);
assert.throws(
  () => messageKey({ platform: "boss", threadKey: "raw-name", messageId: "bad" }),
  (error) => error.code === "BOSS_MESSAGE_ID_INVALID"
);
assert.match(BOSS_MESSAGE_PAGE_HELPERS_EXPRESSION, /__bossMessageSnapshot/);
assert.match(BOSS_MESSAGE_SNAPSHOT_EXPRESSION, /snapshot_helper_missing/);
assert.doesNotMatch(`${BOSS_MESSAGE_PAGE_HELPERS_EXPRESSION}\n${BOSS_MESSAGE_SNAPSHOT_EXPRESSION}`, /click|focus|dispatchEvent|createTab|navigate|bringToFront/i);

console.log("boss_message_dom_smoke ok");
