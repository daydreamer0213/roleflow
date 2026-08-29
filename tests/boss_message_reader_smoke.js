const assert = require("node:assert");
const vm = require("node:vm");
const {
  createBossMessageReader,
  buildGuardedConversationClickExpression
} = require("../src/adapters/sites/boss_message_reader");
const { safeDigest } = require("../src/adapters/sites/boss_message_dom");

const chatUrl = "https://www.zhipin.com/web/geek/chat";
const searchUrl = "https://www.zhipin.com/web/geek/jobs";
const SEARCH_TAB_ID = 101;
const COMMUNICATION_TAB_ID = 102;
const DASHBOARD_TAB_ID = 103;
const WINDOW_ID = 7;

function operatorTabs() {
  return [
    { id: SEARCH_TAB_ID, windowId: WINDOW_ID, active: false, url: searchUrl },
    { id: COMMUNICATION_TAB_ID, windowId: WINDOW_ID, active: false, url: chatUrl },
    { id: DASHBOARD_TAB_ID, windowId: WINDOW_ID, active: true, url: "http://127.0.0.1:3000/messages" }
  ];
}

function row(rowIndex, {
  unread = false,
  selected = false,
  recruiterLabel,
  previewText,
  previewKind = "possible_hr_reply",
  conversationId = "",
  sourceJobId = "",
  lastMessageId = "",
  lastMessageDirection = "unknown",
  lastMessageStatus = "unknown",
  identityVerified = false
} = {}) {
  const value = {
    rowIndex,
    unread,
    selected,
    recruiterLabel: recruiterLabel || (rowIndex === 0 ? "Alex Example" : "Blair Example"),
    previewText: previewText || (rowIndex === 0 ? "Please share availability" : "Thanks for the update")
  };
  return {
    ...value,
    recruiterKey: safeDigest(["recruiter", `label:${value.recruiterLabel}`]),
    conversationKey: safeDigest(["conversation", conversationId ? `id:${conversationId}` : `label:${value.recruiterLabel}`]),
    previewDigest: safeDigest(["preview", value.previewText]),
    previewKind,
    sourceJobId,
    lastMessageId,
    lastMessageDirection,
    lastMessageStatus,
    identityVerified,
    transientSignature: safeDigest([value.rowIndex, value.recruiterLabel, value.previewText, value.unread])
  };
}

function snapshot({ rows = [row(0, { unread: true }), row(1)], selectedRowIndex = 0, risk = false, login = false, path = "/web/geek/chat", messages = null } = {}) {
  return {
    path,
    rows: rows.map((item) => ({ ...item, selected: item.rowIndex === selectedRowIndex })),
    headerText: "Alex Example",
    positionName: "Java Engineer",
    companyName: "Fixture Company",
    salary: "20-30K",
    city: "Shenzhen",
    risk,
    login,
    messages: messages === null ? [{ direction: "friend", messageId: "123456789012345", text: "Hello", contentKind: "text" }] : messages,
    writeTargetsPresent: { editor: true, send: true }
  };
}

function fakeBrowser({ tabs = operatorTabs(), snapshots = [] } = {}) {
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

function runGuardedExpression(expression, { innerText, unread = true, snapshotResult, titleBox = null, lastMsg = null, interactiveChild = null }) {
  let clicks = 0;
  let childClicks = 0;
  const child = interactiveChild || null;
  const row = {
    isConnected: true,
    innerText,
    getAttribute: () => null,
    querySelector(selector) {
      if (selector === ".notice-badge") return unread ? {} : null;
      if (selector === ".title-box") return titleBox ? { textContent: titleBox } : null;
      if (selector === ".last-msg-text") return lastMsg ? { textContent: lastMsg } : null;
      if (selector === ".friend-content" || selector === ".friend-top") return child;
      throw new Error(`unexpected selector: ${selector}`);
    },
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    click: () => { clicks += 1; }
  };
  if (child) {
    child.getBoundingClientRect = () => ({ width: 100, height: 40 });
    child.click = () => {
      childClicks += 1;
      child.selected = true;
    };
  }
  const context = {
    document: { querySelectorAll: (selector) => selector === ".friend-content-warp" ? [row] : [] },
    location: { pathname: "/web/geek/chat" },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto" }),
    unescape,
    encodeURIComponent
  };
  context.window = { __bossMessageSnapshot: () => snapshotResult };
  return { result: vm.runInNewContext(expression, context), clicks, childClicks, child };
}

(async () => {
  const initialSnapshot = snapshot();
  const guardedSuccess = { clicked: true, operation: "__bossGuardedMessageConversationClick", rowIndex: 0 };
  const selectedSnapshot = snapshot();
  const browser = fakeBrowser({ snapshots: [initialSnapshot, guardedSuccess, selectedSnapshot] });
  const { reader, scan: unread } = await scan(browser);
  assert.strictEqual(unread.tabId, COMMUNICATION_TAB_ID);
  assert(Object.isFrozen(unread.queue));
  assert(Object.isFrozen(unread.queue[0]));
  assert.strictEqual(unread.queue[0].tabId, COMMUNICATION_TAB_ID);
  const selected = await reader.openQueuedConversation(unread.queue[0]);
  assert.strictEqual(selected.positionName, "Java Engineer");
  assert.strictEqual(browser.guardedDomClicks, 1);
  for (const forbidden of ["clickAt", "navigate", "createTab", "bringToFront"]) {
    assert.strictEqual(browser.calls.filter(([name]) => name === forbidden).length, 0);
  }

  const structuredMessages = [
    { direction: "friend", messageId: "123456789012350", text: "岗位竞争情况", contentKind: "platform_notice" },
    { direction: "friend", messageId: "123456789012351", text: "请问你的英语和粤语水平如何？", contentKind: "text" },
    { direction: "friend", messageId: "123456789012352", text: "附件简历请求", contentKind: "resume_request" }
  ];
  const structuredBrowser = fakeBrowser({
    snapshots: [
      snapshot({ messages: structuredMessages }),
      guardedSuccess,
      snapshot({ messages: structuredMessages })
    ]
  });
  const structuredReader = createBossMessageReader({ browser: structuredBrowser, sleepFn: async () => {} });
  const structuredQueue = await structuredReader.scanUnread();
  const structuredSelected = await structuredReader.openQueuedConversation(structuredQueue.queue[0]);
  assert.deepStrictEqual(
    structuredSelected.messages.map((item) => item.contentKind),
    ["platform_notice", "text", "resume_request"],
    "the reader must retain the two verified structured message kinds"
  );

  const unverifiedKindBrowser = fakeBrowser({
    snapshots: [snapshot({
      messages: [{
        direction: "friend",
        messageId: "123456789012353",
        text: "位置确认",
        contentKind: "location_confirmation"
      }]
    })]
  });
  await assert.rejects(
    () => createBossMessageReader({ browser: unverifiedKindBrowser }).scanUnread(),
    (error) => error.code === "BOSS_MESSAGE_STRUCTURE_CHANGED",
    "unverified structured kinds must not widen the reader contract"
  );

  const targetBrowser = fakeBrowser({
    snapshots: [
      snapshot(),
      guardedSuccess,
      snapshot(),
      snapshot(),
      { state: "ready", jobId: "abcDEF123", securityId: "secret-token" },
      snapshot()
    ]
  });
  const targetReader = createBossMessageReader({ browser: targetBrowser, sleepFn: async () => {} });
  const targetQueue = await targetReader.scanUnread();
  const targetSelected = await targetReader.openQueuedConversation(targetQueue.queue[0]);
  assert.deepStrictEqual(await targetReader.readSelectedJobTarget(targetSelected), {
    jobId: "abcDEF123",
    navigationUrl: "https://www.zhipin.com/job_detail/abcDEF123.html?securityId=secret-token",
    canonicalUrl: "https://www.zhipin.com/job_detail/abcDEF123.html"
  });

  for (const rawTarget of [
    { state: "unavailable", jobId: "", securityId: "" },
    { state: "ready", jobId: "../web/geek/chat", securityId: "secret-token" },
    { state: "ready", jobId: "abcDEF123", securityId: "" }
  ]) {
    const invalidBrowser = fakeBrowser({
      snapshots: [snapshot(), guardedSuccess, snapshot(), snapshot(), rawTarget, snapshot()]
    });
    const invalidReader = createBossMessageReader({ browser: invalidBrowser, sleepFn: async () => {} });
    const invalidQueue = await invalidReader.scanUnread();
    const invalidSelected = await invalidReader.openQueuedConversation(invalidQueue.queue[0]);
    const error = await assert.rejects(
      () => invalidReader.readSelectedJobTarget(invalidSelected),
      (received) => received.code === "BOSS_MESSAGE_JOB_TARGET_UNAVAILABLE"
    );
    assert.doesNotMatch(String(error?.message || ""), /secret-token/);
  }

  await assert.rejects(
    () => targetReader.readSelectedJobTarget({ ...targetSelected }),
    (error) => error.code === "BOSS_MESSAGE_TARGET_INVALID",
    "only the selected snapshot returned by this reader may resolve a job target"
  );

  const rowsBrowser = fakeBrowser({ snapshots: [snapshot()] });
  const rowsReader = createBossMessageReader({ browser: rowsBrowser, sleepFn: async () => {} });
  const rowsScan = await rowsReader.scanConversationRows();
  assert.strictEqual(rowsScan.tabId, COMMUNICATION_TAB_ID);
  assert.strictEqual(rowsScan.path, "/web/geek/chat");
  assert.strictEqual(rowsScan.rows[0].conversationKey, initialSnapshot.rows[0].conversationKey);

  const verifiedRow = row(0, {
    unread: true,
    conversationId: "conversation-a",
    sourceJobId: "boss:encrypt-job-a",
    lastMessageId: "378917037748737",
    lastMessageDirection: "friend",
    lastMessageStatus: "unknown",
    identityVerified: true
  });
  const verifiedRowsReader = createBossMessageReader({
    browser: fakeBrowser({ snapshots: [snapshot({ rows: [verifiedRow] })] })
  });
  const verifiedRowsScan = await verifiedRowsReader.scanConversationRows();
  assert.strictEqual(verifiedRowsScan.rows[0].sourceJobId, "boss:encrypt-job-a");
  assert.strictEqual(verifiedRowsScan.rows[0].lastMessageId, "378917037748737");
  assert.strictEqual(verifiedRowsScan.rows[0].lastMessageDirection, "friend");
  assert.strictEqual(verifiedRowsScan.rows[0].lastMessageStatus, "unknown");
  assert.strictEqual(verifiedRowsScan.rows[0].identityVerified, true);

  const mismatchedStatusRow = row(0, {
    previewKind: "self_delivered",
    conversationId: "conversation-b",
    sourceJobId: "boss:encrypt-job-b",
    lastMessageId: "378917037748738",
    lastMessageDirection: "myself",
    lastMessageStatus: "read",
    identityVerified: true
  });
  await assert.rejects(
    () => createBossMessageReader({
      browser: fakeBrowser({ snapshots: [snapshot({ rows: [mismatchedStatusRow] })] })
    }).scanConversationRows(),
    (error) => error.code === "BOSS_MESSAGE_STRUCTURE_CHANGED",
    "inconsistent Vue and visible statuses must stop before a guarded click"
  );

  const previewChangedSnapshot = snapshot({ rows: [row(0, { unread: false, previewText: "Changed preview" })] });
  const previewBrowser = fakeBrowser({
    snapshots: [
      previewChangedSnapshot,
      guardedSuccess,
      snapshot({ rows: [row(0, { unread: false, previewText: "Changed preview" })] })
    ]
  });
  const previewReader = createBossMessageReader({ browser: previewBrowser, sleepFn: async () => {} });
  const previewScan = await previewReader.scanConversationRows();
  const previewOpened = await previewReader.openQueuedConversation({
    ...previewScan.rows[0],
    operation: "preview_changed",
    tabId: previewScan.tabId
  });
  assert.strictEqual(previewOpened.positionName, "Java Engineer");
  assert.strictEqual(previewBrowser.guardedDomClicks, 1);

  const previewDriftBrowser = fakeBrowser({
    snapshots: [
      previewChangedSnapshot,
      { clicked: false, operation: "__bossGuardedMessageConversationClick", reason: "preview_drifted" }
    ]
  });
  const previewDriftReader = createBossMessageReader({ browser: previewDriftBrowser, sleepFn: async () => {} });
  const previewDriftScan = await previewDriftReader.scanConversationRows();
  await assert.rejects(
    () => previewDriftReader.openQueuedConversation({
      ...previewDriftScan.rows[0],
      operation: "preview_changed",
      previewDigest: safeDigest(["preview", "drifted"]),
      tabId: previewDriftScan.tabId
    }),
    (error) => error.code === "BOSS_MESSAGE_PREVIEW_DRIFTED"
  );
  assert.strictEqual(previewDriftBrowser.guardedDomClicks, 0);

  for (const [tabs, code] of [
    [[], "BOSS_TAB_REQUIRED"],
    [[{ id: "one", url: chatUrl }, { id: "two", url: chatUrl }], "BOSS_TAB_REQUIRED"]
  ]) {
    await assert.rejects(
      () => createBossMessageReader({ browser: fakeBrowser({ tabs }), sleepFn: async () => {} }).scanUnread(),
      (error) => error.code === code
    );
  }

  for (const tabs of [
    operatorTabs().filter((tab) => tab.id !== SEARCH_TAB_ID),
    operatorTabs().map((tab) => tab.id === COMMUNICATION_TAB_ID ? { ...tab, windowId: WINDOW_ID + 1 } : tab),
    [...operatorTabs(), { id: 104, windowId: WINDOW_ID, active: false, url: "https://www.zhipin.com/job_detail/abcDEF123.html" }],
    operatorTabs().map((tab) => [SEARCH_TAB_ID, COMMUNICATION_TAB_ID].includes(tab.id) ? { ...tab, id: String(tab.id) } : tab)
  ]) {
    const invalidBindingBrowser = fakeBrowser({ tabs, snapshots: [snapshot()] });
    await assert.rejects(
      () => createBossMessageReader({ browser: invalidBindingBrowser, sleepFn: async () => {} }).scanUnread()
    );
    assert.strictEqual(
      invalidBindingBrowser.calls.filter(([name]) => name === "evalValue").length,
      0,
      "an invalid fixed-tab baseline must stop before reading the message DOM"
    );
  }

  const driftTabs = operatorTabs();
  const bindingDriftBrowser = fakeBrowser({ tabs: driftTabs, snapshots: [snapshot(), guardedSuccess, snapshot()] });
  const bindingDriftReader = createBossMessageReader({ browser: bindingDriftBrowser, sleepFn: async () => {} });
  const bindingDriftQueue = await bindingDriftReader.scanUnread();
  driftTabs.find((tab) => tab.id === COMMUNICATION_TAB_ID).id = 202;
  await assert.rejects(
    () => bindingDriftReader.openQueuedConversation(bindingDriftQueue.queue[0])
  );
  assert.strictEqual(bindingDriftBrowser.guardedDomClicks, 0, "binding drift must stop before the guarded click");

  const targetDriftTabs = operatorTabs();
  const targetDriftBrowser = fakeBrowser({
    tabs: targetDriftTabs,
    snapshots: [snapshot(), guardedSuccess, snapshot()]
  });
  const targetDriftReader = createBossMessageReader({ browser: targetDriftBrowser, sleepFn: async () => {} });
  const targetDriftQueue = await targetDriftReader.scanUnread();
  const targetDriftSelected = await targetDriftReader.openQueuedConversation(targetDriftQueue.queue[0]);
  targetDriftTabs.find((tab) => tab.id === SEARCH_TAB_ID).id = 201;
  const targetEvalCalls = targetDriftBrowser.calls.filter(([name]) => name === "evalValue").length;
  await assert.rejects(() => targetDriftReader.readSelectedJobTarget(targetDriftSelected));
  assert.strictEqual(
    targetDriftBrowser.calls.filter(([name]) => name === "evalValue").length,
    targetEvalCalls,
    "job-target DOM must not be read after a fixed-tab binding drift"
  );

  const expression = buildGuardedConversationClickExpression({ rowIndex: 0, transientSignature: initialSnapshot.rows[0].transientSignature, conversationKey: initialSnapshot.rows[0].conversationKey });
  for (const expected of [
    'location.pathname !== "/web/geek/chat"',
    "snapshot.risk === true",
    "snapshot.login === true",
    "rows[expected.rowIndex]",
    "transientSignature",
    ".notice-badge",
    ".title-box",
    ".last-msg-text"
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
  const liveRowShape = runGuardedExpression(expression, {
    innerText: "10:30\nAlex Example\nPlease share availability",
    titleBox: "Alex Example",
    lastMsg: "Please share availability",
    snapshotResult: forgedHelperResult
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(liveRowShape.result)), guardedSuccess);
  assert.strictEqual(liveRowShape.clicks, 1, "a live row with time on its first line must still match title-box and last-msg-text");

  const interactiveChildRow = runGuardedExpression(expression, {
    innerText: "10:30\nAlex Example\nPlease share availability",
    titleBox: "Alex Example",
    lastMsg: "Please share availability",
    snapshotResult: forgedHelperResult,
    interactiveChild: { selected: false }
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(interactiveChildRow.result)), guardedSuccess);
  assert.strictEqual(
    interactiveChildRow.childClicks,
    1,
    "the guarded click must target the real interactive .friend-content child, not only the wrapper row"
  );
  assert.strictEqual(
    interactiveChildRow.child.selected,
    true,
    "clicking the interactive child must enter the selected state"
  );

  const driftBrowser = fakeBrowser({ snapshots: [snapshot(), { clicked: false, operation: "__bossGuardedMessageConversationClick", reason: "row_drifted" }] });
  const drift = await scan(driftBrowser);
  await assert.rejects(() => drift.reader.openQueuedConversation(drift.scan.queue[0]), (error) => error.code === "BOSS_MESSAGE_ROW_DRIFTED");
  assert.strictEqual(driftBrowser.guardedDomClicks, 0);

  const unreadGoneBrowser = fakeBrowser({ snapshots: [snapshot(), { clicked: false, operation: "__bossGuardedMessageConversationClick", reason: "no_longer_unread" }] });
  const unreadGone = await scan(unreadGoneBrowser);
  assert.deepStrictEqual(await unreadGone.reader.openQueuedConversation(unreadGone.scan.queue[0]), { skipped: true, reasonCode: "BOSS_MESSAGE_NO_LONGER_UNREAD" });
  assert.strictEqual(unreadGoneBrowser.guardedDomClicks, 0);

  const readAfterClickBrowser = fakeBrowser({
    snapshots: [
      snapshot(),
      guardedSuccess,
      snapshot({ rows: [row(0, { unread: false }), row(1)] }),
      snapshot({ rows: [row(0, { unread: false }), row(1)] }),
      snapshot({ rows: [row(0, { unread: false }), row(1)] })
    ]
  });
  const readAfterClick = await scan(readAfterClickBrowser);
  const readAfterClickSelected = await readAfterClick.reader.openQueuedConversation(readAfterClick.scan.queue[0]);
  assert.strictEqual(readAfterClickSelected.rows[0].unread, false, "reading the selected row must not invalidate its identity");

  const durableRow = row(0, { unread: false });
  const durableBrowser = fakeBrowser({
    snapshots: [
      snapshot({ rows: [durableRow, row(1)] }),
      guardedSuccess,
      snapshot({ rows: [durableRow, row(1)] }),
      snapshot({ rows: [durableRow, row(1)] }),
      snapshot({ rows: [durableRow, row(1)] })
    ]
  });
  const durableReader = createBossMessageReader({ browser: durableBrowser, sleepFn: async () => {} });
  const durableScan = await durableReader.scanConversationRows();
  const durableSelected = await durableReader.openQueuedConversation({
    ...durableScan.rows[0],
    tabId: durableScan.tabId,
    operation: "durable_unresolved"
  });
  assert.strictEqual(durableSelected.rows[0].unread, false,
    "a durable unresolved item must keep the exact already-read conversation identity");

  const messageLoadWaits = [];
  const messageLoadBrowser = fakeBrowser({
    snapshots: [
      snapshot(),
      guardedSuccess,
      snapshot({ messages: [] }),
      snapshot()
    ]
  });
  const messageLoadReader = createBossMessageReader({
    browser: messageLoadBrowser,
    sleepFn: async (ms) => messageLoadWaits.push(ms)
  });
  const messageLoadQueue = await messageLoadReader.scanUnread();
  await messageLoadReader.openQueuedConversation(messageLoadQueue.queue[0]);
  assert.deepStrictEqual(messageLoadWaits, [250], "an empty first snapshot must wait for message loading");

  const slowMessageLoadWaits = [];
  const slowMessageLoadBrowser = fakeBrowser({
    snapshots: [
      snapshot(),
      guardedSuccess,
      snapshot({ messages: [] }),
      snapshot({ messages: [] }),
      snapshot({ messages: [] }),
      snapshot({ messages: [] }),
      snapshot()
    ]
  });
  const slowMessageLoadReader = createBossMessageReader({
    browser: slowMessageLoadBrowser,
    sleepFn: async (ms) => slowMessageLoadWaits.push(ms)
  });
  const slowMessageLoadQueue = await slowMessageLoadReader.scanUnread();
  await slowMessageLoadReader.openQueuedConversation(slowMessageLoadQueue.queue[0]);
  assert.deepStrictEqual(slowMessageLoadWaits, [250, 250, 250, 250],
    "a selected conversation may need more than 500ms before its messages become ready");

  const emptyMessagesBrowser = fakeBrowser({
    snapshots: [
      snapshot(),
      guardedSuccess,
      ...Array.from({ length: 21 }, () => snapshot({ messages: [] }))
    ]
  });
  const emptyMessages = await scan(emptyMessagesBrowser);
  await assert.rejects(
    () => emptyMessages.reader.openQueuedConversation(emptyMessages.scan.queue[0]),
    (error) => error.code === "BOSS_MESSAGE_TARGET_MISMATCH"
  );

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
    await scanScanGate.promise;
    return operatorTabs();
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
    return operatorTabs();
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

  const invalidOperationBrowser = fakeBrowser({ snapshots: [snapshot()] });
  const invalidOperationReader = createBossMessageReader({ browser: invalidOperationBrowser, sleepFn: async () => {} });
  const invalidOperationScan = await invalidOperationReader.scanConversationRows();
  await assert.rejects(
    () => invalidOperationReader.openQueuedConversation({
      ...invalidOperationScan.rows[0],
      tabId: invalidOperationScan.tabId,
      operation: "untrusted_write"
    }),
    (error) => error.code === "BOSS_MESSAGE_OPERATION_INVALID"
  );
  assert.strictEqual(invalidOperationBrowser.guardedDomClicks, 0);

  console.log("boss_message_reader_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
