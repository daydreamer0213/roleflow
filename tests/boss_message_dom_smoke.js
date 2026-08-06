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
const { createBossMessageDomFixture, FixtureElement } = require("./fixtures/boss_message_dom_fixture");

const documentLike = createBossMessageDomFixture();
const snapshot = snapshotBossMessagePage(documentLike, "https://www.zhipin.com/web/geek/chat");

assert.strictEqual(snapshot.path, "/web/geek/chat");
assert.strictEqual(snapshot.companyName, "Fixture Company");
assert.deepStrictEqual(snapshot.rows.map((row) => row.unread), [true, false, true]);
assert.match(snapshot.rows[0].conversationKey, /^sha256:[a-f0-9]{64}$/);
assert.strictEqual(snapshot.rows[0].previewKind, "possible_hr_reply");

const statusDocument = createBossMessageDomFixture();
statusDocument.querySelectorAll(".friend-content-warp")[0].children[".status-read"] = new FixtureElement({ classes: ["status-read"] });
const statusSnapshot = snapshotBossMessagePage(statusDocument, "https://www.zhipin.com/web/geek/chat");
assert.strictEqual(
  statusSnapshot.rows[0].previewKind,
  "self_read",
  "a live-calibrated .status-read row must classify as self_read"
);
const deliveredDocument = createBossMessageDomFixture();
deliveredDocument.querySelectorAll(".friend-content-warp")[0].children[".status-delivery"] = new FixtureElement({ classes: ["status-delivery"] });
const deliveredSnapshot = snapshotBossMessagePage(deliveredDocument, "https://www.zhipin.com/web/geek/chat");
assert.strictEqual(
  deliveredSnapshot.rows[0].previewKind,
  "self_delivered",
  "a live-calibrated .status-delivery row must classify as self_delivered"
);

const liveRowDocument = createBossMessageDomFixture();
const liveRow = liveRowDocument.querySelectorAll(".friend-content-warp")[0];
liveRow.innerText = "10:30\nAlex Example\nPlease share availability";
delete liveRow.attributes["data-conversation-id"];
delete liveRow.attributes["data-recruiter-id"];
const liveRowSnapshot = snapshotBossMessagePage(liveRowDocument, "https://www.zhipin.com/web/geek/chat");
assert.strictEqual(
  liveRowSnapshot.rows[0].recruiterLabel,
  "Alex Example",
  "a live row with time on its first line must use .title-box for the recruiter label"
);
assert.strictEqual(
  liveRowSnapshot.rows[0].conversationKey,
  safeDigest(["conversation", "label:Alex Example"]),
  "conversationKey must use the .title-box label, not the time line"
);
assert.strictEqual(
  liveRowSnapshot.rows[0].previewDigest,
  safeDigest(["preview", "Please share availability"]),
  "previewDigest must use .last-msg-text, not the last innerText line"
);
assert.deepStrictEqual(snapshot.rows.map((row) => row.transientSignature), [
  safeDigest([0, "Alex Example", "Please share availability", true]),
  safeDigest([1, "Blair Example", "Thanks for the update", false]),
  safeDigest([2, "Casey Example", "Interview details attached", true])
]);
assert.deepStrictEqual(snapshot.messages.map((item) => item.direction), ["friend", "myself", "system"]);
assert.deepStrictEqual(snapshot.messages.map((item) => item.contentKind), ["text", "voice", "text"]);
assert(snapshot.messages.every((item) => /^\d{15}$/.test(item.messageId)));
assert.deepStrictEqual(snapshot.writeTargetsPresent, { editor: true, send: true });

const queue = buildUnreadConversationQueue(snapshot);
assert.deepStrictEqual(queue.map((item) => item.rowIndex), [0, 2]);
assert(Object.isFrozen(queue));
assert(queue.every(Object.isFrozen));
assert.throws(() => queue.push({}), TypeError);
const forgedQueue = buildUnreadConversationQueue({
  rows: [{ ...snapshot.rows[0], transientSignature: `sha256:${"f".repeat(64)}` }]
});
assert.strictEqual(forgedQueue[0].transientSignature, safeDigest([0, "Alex Example", "Please share availability", true]));
const staleQueue = buildUnreadConversationQueue({
  rows: [{ ...snapshot.rows[2], previewText: "Changed preview", transientSignature: snapshot.rows[2].transientSignature }]
});
assert.strictEqual(staleQueue[0].transientSignature, safeDigest([2, "Casey Example", "Changed preview", true]));
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
const queryRiskDocument = createBossMessageDomFixture();
assert.strictEqual(
  snapshotBossMessagePage(queryRiskDocument, "https://www.zhipin.com/web/geek/chat?code=32").risk,
  true,
  "code=32 must be read from the supplied locationHref, not documentLike.location"
);
const loginDocument = createBossMessageDomFixture();
loginDocument.body.innerText = "\u767b\u5f55\u540e\u53ef\u67e5\u770b";
assert.strictEqual(snapshotBossMessagePage(loginDocument, "https://www.zhipin.com/web/geek/chat").login, true);
const brokenQueryDocument = createBossMessageDomFixture();
brokenQueryDocument.querySelectorAll = () => { throw new Error("fixture selector failure"); };
assert.throws(
  () => snapshotBossMessagePage(brokenQueryDocument, "https://www.zhipin.com/web/geek/chat"),
  (error) => error.code === "BOSS_MESSAGE_STRUCTURE_CHANGED"
);
const noSelectionDocument = createBossMessageDomFixture();
noSelectionDocument.querySelectorAll(".friend-content-warp")[1].classes.delete("selected");
const optionalQuerySelector = noSelectionDocument.querySelector;
noSelectionDocument.querySelector = (selector) => [
  ".top-info-content",
  ".chat-position-content .position-name",
  ".salary",
  ".city"
].includes(selector) ? null : optionalQuerySelector.call(noSelectionDocument, selector);
const noSelectionSnapshot = snapshotBossMessagePage(noSelectionDocument, "https://www.zhipin.com/web/geek/chat");
assert(noSelectionSnapshot.rows.every((row) => row.selected === false));
assert.deepStrictEqual({
  headerText: noSelectionSnapshot.headerText,
  positionName: noSelectionSnapshot.positionName,
  salary: noSelectionSnapshot.salary,
  city: noSelectionSnapshot.city
}, { headerText: "", positionName: "", salary: "", city: "" });
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
