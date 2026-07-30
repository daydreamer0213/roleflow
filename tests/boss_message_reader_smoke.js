const assert = require("node:assert");
const vm = require("node:vm");
const {
  createBossMessageReader,
  buildGuardedConversationClickExpression
} = require("../src/adapters/sites/boss_message_reader");
const { safeDigest } = require("../src/adapters/sites/boss_message_dom");

const chatUrl = "https://www.zhipin.com/web/geek/chat";

function row(rowIndex, { unread = false, selected = false, recruiterLabel, previewText } = {}) {
  const value = {
    rowIndex,
    unread,
    selected,
    recruiterLabel: recruiterLabel || (rowIndex === 0 ? "Alex Example" : "Blair Example"),
    previewText: previewText || (rowIndex === 0 ? "Please share availability" : "Thanks for the update")
  };
  return { ...value, transientSignature: safeDigest([value.rowIndex, value.recruiterLabel, value.previewText, value.unread]) };
}

function snapshot({ rows = [row(0, { unread: true }), row(1)], selectedRowIndex = 0, risk = false, login = false, path = "/web/geek/chat" } = {}) {
  return {
    path,
    rows: rows.map((item) => ({ ...item, selected: item.rowIndex === selectedRowIndex })),
    headerText: "Alex Example",
    positionName: "Java Engineer",
    salary: "20-30K",
    city: "Shenzhen",
    risk,
    login,
    messages: [{ direction: "friend", messageId: "123456789012345", text: "Hello" }],
    writeTargetsPresent: { editor: true, send: true }
  };
}

function fakeBrowser({ tabs = [{ id: "chat-tab", url: chatUrl }], snapshots = [] } = {}) {
  return {
    calls: [],
    snapshots: [...snapshots],
    guardedDomClicks: 0,
    async listTabs() {
      this.calls.push(["listTabs"]);
      return tabs;
    },
    async evalValue(tabId, expression) {
      this.calls.push(["evalValue", tabId, expression]);
      const result = this.snapshots.shift();
      if (result?.operation === "__bossGuardedMessageConversationClick" && result.clicked) this.guardedDomClicks += 1;
      return result;
    },
    async clickAt() { this.calls.push(["clickAt"]); throw new Error("clickAt must never be called"); },
    async navigate() { this.calls.push(["navigate"]); throw new Error("navigate must never be called"); },
    async createTab() { this.calls.push(["createTab"]); throw new Error("createTab must never be called"); },
    async bringToFront() { this.calls.push(["bringToFront"]); throw new Error("bringToFront must never be called"); }
  };
}

async function scan(browser) {
  const reader = createBossMessageReader({ browser, sleepFn: async () => {} });
  return { reader, scan: await reader.scanUnread() };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function runGuardedExpression(expression, { innerText, unread = true, snapshotResult }) {
  let clicks = 0;
  const row = {
    isConnected: true,
    innerText,
    querySelector(selector) {
      if (selector === ".notice-badge") return unread ? {} : null;
      throw new Error(`unexpected selector: ${selector}`);
    },
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    click: () => { clicks += 1; }
  };
  const context = {
    document: { querySelectorAll: (selector) => selector === ".friend-content-warp" ? [row] : [] },
    location: { pathname: "/web/geek/chat" },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto" }),
    unescape,
    encodeURIComponent
  };
  context.window = { __bossMessageSnapshot: () => snapshotResult };
  return { result: vm.runInNewContext(expression, context), clicks };
}

(async () => {
  const initialSnapshot = snapshot();
  const guardedSuccess = { clicked: true, operation: "__bossGuardedMessageConversationClick", rowIndex: 0 };
  const selectedSnapshot = snapshot();
  const browser = fakeBrowser({ snapshots: [initialSnapshot, guardedSuccess, selectedSnapshot] });
  const { reader, scan: unread } = await scan(browser);
  assert.strictEqual(unread.tabId, "chat-tab");
  assert(Object.isFrozen(unread.queue));
  assert(Object.isFrozen(unread.queue[0]));
  assert.strictEqual(unread.queue[0].tabId, "chat-tab");
  const selected = await reader.openQueuedConversation(unread.queue[0]);
  assert.strictEqual(selected.positionName, "Java Engineer");
  assert.strictEqual(browser.guardedDomClicks, 1);
  for (const forbidden of ["clickAt", "navigate", "createTab", "bringToFront"]) {
    assert.strictEqual(browser.calls.filter(([name]) => name === forbidden).length, 0);
  }

  for (const [tabs, code] of [
    [[], "BOSS_MESSAGE_TAB_MISSING"],
    [[{ id: "one", url: chatUrl }, { id: "two", url: chatUrl }], "BOSS_MESSAGE_TAB_AMBIGUOUS"]
  ]) {
    await assert.rejects(
      () => createBossMessageReader({ browser: fakeBrowser({ tabs }), sleepFn: async () => {} }).scanUnread(),
      (error) => error.code === code
    );
  }

  const expression = buildGuardedConversationClickExpression({ rowIndex: 0, transientSignature: initialSnapshot.rows[0].transientSignature });
  for (const expected of [
    'location.pathname !== "/web/geek/chat"',
    "snapshot.risk === true",
    "snapshot.login === true",
    "rows[expected.rowIndex]",
    "transientSignature",
    ".notice-badge"
  ]) assert(expression.includes(expected), `guard must recheck ${expected}`);
  assert.strictEqual((expression.match(/\.click\(\)/g) || []).length, 1);
  assert.doesNotMatch(expression, /chat-input|btn-send|querySelectorAll\(["'](?:button|a)["']/);
  assert.doesNotMatch(expression, /await|Promise|setTimeout|setInterval|MutationObserver|addEventListener/);

  const forgedHelperResult = {
    risk: false,
    login: false,
    rows: [{ rowIndex: 0, transientSignature: initialSnapshot.rows[0].transientSignature }]
  };
  const directDomDrift = runGuardedExpression(expression, {
    innerText: "Alex Example\nChanged preview text",
    snapshotResult: forgedHelperResult
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(directDomDrift.result)), {
    clicked: false,
    operation: "__bossGuardedMessageConversationClick",
    reason: "row_drifted"
  });
  assert.strictEqual(directDomDrift.clicks, 0, "a forged helper signature must never permit a DOM click");
  const directDomMatch = runGuardedExpression(expression, {
    innerText: "  Alex Example  \n\n  Please share availability  ",
    snapshotResult: forgedHelperResult
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(directDomMatch.result)), guardedSuccess);
  assert.strictEqual(directDomMatch.clicks, 1, "a matching Task1 signature must click the target row exactly once");

  const driftBrowser = fakeBrowser({ snapshots: [snapshot(), { clicked: false, operation: "__bossGuardedMessageConversationClick", reason: "row_drifted" }] });
  const drift = await scan(driftBrowser);
  await assert.rejects(() => drift.reader.openQueuedConversation(drift.scan.queue[0]), (error) => error.code === "BOSS_MESSAGE_ROW_DRIFTED");
  assert.strictEqual(driftBrowser.guardedDomClicks, 0);

  const unreadGoneBrowser = fakeBrowser({ snapshots: [snapshot(), { clicked: false, operation: "__bossGuardedMessageConversationClick", reason: "no_longer_unread" }] });
  const unreadGone = await scan(unreadGoneBrowser);
  assert.deepStrictEqual(await unreadGone.reader.openQueuedConversation(unreadGone.scan.queue[0]), { skipped: true, reasonCode: "BOSS_MESSAGE_NO_LONGER_UNREAD" });
  assert.strictEqual(unreadGoneBrowser.guardedDomClicks, 0);

  const mismatchBrowser = fakeBrowser({ snapshots: [snapshot(), guardedSuccess, snapshot({ selectedRowIndex: 1 }), snapshot({ selectedRowIndex: 1 }), snapshot({ selectedRowIndex: 1 })] });
  const mismatch = await scan(mismatchBrowser);
  await assert.rejects(() => mismatch.reader.openQueuedConversation(mismatch.scan.queue[0]), (error) => error.code === "BOSS_MESSAGE_TARGET_MISMATCH");

  for (const blockedSnapshot of [
    snapshot({ risk: true }),
    snapshot({ login: true }),
    snapshot({ path: "/web/geek/jobs" })
  ]) {
    const blockedBrowser = fakeBrowser({ snapshots: [blockedSnapshot] });
    await assert.rejects(() => createBossMessageReader({ browser: blockedBrowser }).scanUnread());
    assert.strictEqual(blockedBrowser.calls.filter(([name]) => name === "evalValue").length, 1);
  }

  const abortedBrowser = fakeBrowser({ snapshots: [snapshot()] });
  const aborted = await scan(abortedBrowser);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => aborted.reader.openQueuedConversation(aborted.scan.queue[0], controller.signal), (error) => error?.name === "AbortError");
  assert.strictEqual(abortedBrowser.guardedDomClicks, 0);
  assert.strictEqual(abortedBrowser.calls.filter(([name]) => name === "evalValue").length, 1);

  let releaseGuard;
  const lockBrowser = fakeBrowser({ snapshots: [snapshot(), snapshot()] });
  const originalEvalValue = lockBrowser.evalValue.bind(lockBrowser);
  lockBrowser.evalValue = async function(tabId, expressionToRun) {
    if (expressionToRun.includes("__bossGuardedMessageConversationClick")) {
      return new Promise((resolve) => { releaseGuard = resolve; });
    }
    return originalEvalValue(tabId, expressionToRun);
  };
  const locked = await scan(lockBrowser);
  const firstOpen = locked.reader.openQueuedConversation(locked.scan.queue[0]);
  await assert.rejects(
    () => locked.reader.openQueuedConversation(locked.scan.queue[0]),
    (error) => error.code === "BOSS_MESSAGE_READER_BUSY"
  );
  assert.strictEqual(lockBrowser.guardedDomClicks, 0);
  releaseGuard(guardedSuccess);
  await firstOpen;

  const scanScanGate = deferred();
  const scanScanBrowser = fakeBrowser({ snapshots: [snapshot()] });
  scanScanBrowser.listTabs = async function() {
    this.calls.push(["listTabs"]);
    if (this.calls.filter(([name]) => name === "listTabs").length > 1) throw new Error("second scan must not list tabs");
    await scanScanGate.promise;
    return [{ id: "chat-tab", url: chatUrl }];
  };
  const scanScanReader = createBossMessageReader({ browser: scanScanBrowser, sleepFn: async () => {} });
  const firstScan = scanScanReader.scanUnread();
  await assert.rejects(() => scanScanReader.scanUnread(), (error) => error.code === "BOSS_MESSAGE_READER_BUSY");
  assert.strictEqual(scanScanBrowser.calls.filter(([name]) => name === "listTabs").length, 1);
  assert.strictEqual(scanScanBrowser.calls.filter(([name]) => name === "evalValue").length, 0);
  scanScanGate.resolve();
  await firstScan;

  const scanOpenGate = deferred();
  const scanOpenBrowser = fakeBrowser({ snapshots: [snapshot(), snapshot()] });
  const scanOpenReader = createBossMessageReader({ browser: scanOpenBrowser, sleepFn: async () => {} });
  const savedQueue = await scanOpenReader.scanUnread();
  scanOpenBrowser.listTabs = async function() {
    this.calls.push(["listTabs"]);
    await scanOpenGate.promise;
    return [{ id: "chat-tab", url: chatUrl }];
  };
  const heldScan = scanOpenReader.scanUnread();
  await assert.rejects(
    () => scanOpenReader.openQueuedConversation(savedQueue.queue[0]),
    (error) => error.code === "BOSS_MESSAGE_READER_BUSY"
  );
  assert.strictEqual(scanOpenBrowser.calls.filter(([name]) => name === "evalValue").length, 1);
  assert.strictEqual(scanOpenBrowser.guardedDomClicks, 0);
  scanOpenGate.resolve();
  await heldScan;

  const provenanceBrowser = fakeBrowser({ snapshots: [snapshot(), snapshot()] });
  const provenanceReader = createBossMessageReader({ browser: provenanceBrowser, sleepFn: async () => {} });
  const firstRound = await provenanceReader.scanUnread();
  const originalTarget = firstRound.queue[0];
  const forgedTarget = { ...originalTarget };
  const unknownTabTarget = { ...originalTarget, tabId: "unknown-chat-tab" };
  const secondRound = await provenanceReader.scanUnread();
  assert.notStrictEqual(secondRound.queue[0], originalTarget);
  for (const target of [forgedTarget, unknownTabTarget, originalTarget]) {
    await assert.rejects(
      () => provenanceReader.openQueuedConversation(target),
      (error) => error.code === "BOSS_MESSAGE_TARGET_INVALID"
    );
  }
  assert.strictEqual(provenanceBrowser.guardedDomClicks, 0);
  assert.strictEqual(provenanceBrowser.calls.filter(([name]) => name === "evalValue").length, 2);

  console.log("boss_message_reader_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
