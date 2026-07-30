const assert = require("node:assert");
const crypto = require("node:crypto");
const vm = require("node:vm");
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
assert.deepStrictEqual(snapshot.rows.map((row) => row.transientSignature), [
  safeDigest([0, "Alex Example", "Please share availability", true]),
  safeDigest([1, "Blair Example", "Thanks for the update", false]),
  safeDigest([2, "Casey Example", "Interview details attached", true])
]);
assert.deepStrictEqual(snapshot.messages.map((item) => item.direction), ["friend", "myself", "system"]);
assert(snapshot.messages.every((item) => /^\d{15}$/.test(item.messageId)));
assert.deepStrictEqual(snapshot.writeTargetsPresent, { editor: true, send: true });

const queue = buildUnreadConversationQueue(snapshot);
assert.deepStrictEqual(queue.map((item) => item.rowIndex), [0, 2]);
assert(Object.isFrozen(queue));
assert(queue.every(Object.isFrozen));
assert.throws(() => queue.push({}), TypeError);
assert.match(safeDigest([" fake ", "value"]), /^sha256:[a-f0-9]{64}$/);
assert.strictEqual(
  safeDigest([0, false]),
  `sha256:${crypto.createHash("sha256").update("0\0false", "utf8").digest("hex")}`,
  "canonicalization must preserve rowIndex zero and boolean false"
);
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
for (const invalidMessageId of [undefined, "not-digits", "12345678901234", "1234567890123456"]) {
  const invalidDocument = createBossMessageDomFixture();
  if (invalidMessageId === undefined) delete invalidDocument.querySelectorAll(".message-item")[0].attributes["data-mid"];
  else invalidDocument.querySelectorAll(".message-item")[0].attributes["data-mid"] = invalidMessageId;
  assert.throws(
    () => snapshotBossMessagePage(invalidDocument, "https://www.zhipin.com/web/geek/chat"),
    (error) => error.code === "BOSS_MESSAGE_ID_INVALID",
    `invalid message id ${String(invalidMessageId)} must stop the snapshot`
  );
}
const riskDocument = createBossMessageDomFixture();
riskDocument.title = "\u5b89\u5168\u9a8c\u8bc1";
assert.strictEqual(snapshotBossMessagePage(riskDocument, "https://www.zhipin.com/web/geek/chat").risk, true);
const loginDocument = createBossMessageDomFixture();
loginDocument.body.innerText = "\u767b\u5f55\u540e\u53ef\u67e5\u770b";
assert.strictEqual(snapshotBossMessagePage(loginDocument, "https://www.zhipin.com/web/geek/chat").login, true);
const missingHeaderDocument = createBossMessageDomFixture();
const originalQuerySelector = missingHeaderDocument.querySelector;
missingHeaderDocument.querySelector = (selector) => selector === ".top-info-content" ? null : originalQuerySelector.call(missingHeaderDocument, selector);
assert.throws(
  () => snapshotBossMessagePage(missingHeaderDocument, "https://www.zhipin.com/web/geek/chat"),
  (error) => error.code === "BOSS_MESSAGE_STRUCTURE_CHANGED"
);
const brokenQueryDocument = createBossMessageDomFixture();
brokenQueryDocument.querySelectorAll = () => { throw new Error("fixture selector failure"); };
assert.throws(
  () => snapshotBossMessagePage(brokenQueryDocument, "https://www.zhipin.com/web/geek/chat"),
  (error) => error.code === "BOSS_MESSAGE_STRUCTURE_CHANGED"
);
assert.match(BOSS_MESSAGE_PAGE_HELPERS_EXPRESSION, /__bossMessageSnapshot/);
assert.match(BOSS_MESSAGE_SNAPSHOT_EXPRESSION, /snapshot_helper_missing/);
assert.doesNotMatch(`${BOSS_MESSAGE_PAGE_HELPERS_EXPRESSION}\n${BOSS_MESSAGE_SNAPSHOT_EXPRESSION}`, /click|focus|dispatchEvent|createTab|navigate|bringToFront/i);
const browserSnapshot = runBrowserSnapshot(documentLike, "https://www.zhipin.com/web/geek/chat");
assert.deepStrictEqual(
  Array.from(browserSnapshot.rows, (row) => row.transientSignature),
  snapshot.rows.map((row) => row.transientSignature),
  "browser and Node snapshots must use the same synchronous transient signature"
);

console.log("boss_message_dom_smoke ok");

function runBrowserSnapshot(documentLike, href) {
  const url = new URL(href);
  const context = {
    document: documentLike,
    location: { href, pathname: url.pathname, search: url.search },
    URLSearchParams,
    getComputedStyle: () => ({ display: "block", visibility: "visible" })
  };
  context.window = context;
  return vm.runInNewContext(BOSS_MESSAGE_SNAPSHOT_EXPRESSION, context);
}
