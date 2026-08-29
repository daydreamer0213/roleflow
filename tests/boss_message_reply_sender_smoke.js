const assert = require("node:assert");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { createBossMessageReader } = require("../src/adapters/sites/boss_message_reader");
const { createBossMessageReplySender } = require("../src/adapters/sites/boss_message_reply_sender");
const { safeDigest } = require("../src/adapters/sites/boss_message_dom");

const CHAT_URL = "https://www.zhipin.com/web/geek/chat";
const SEARCH_URL = "https://www.zhipin.com/web/geek/jobs";
const COMMUNICATION_TAB_ID = 502;
const EXPECTED_MESSAGE_ID = "378917037748737";
const OUTGOING_MESSAGE_ID = "378917037748738";

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value).replace(/\s+/g, " ").trim()).digest("hex")}`;
}

function verifiedRow(overrides = {}) {
  const value = {
    rowIndex: 0,
    unread: true,
    selected: true,
    recruiterLabel: "Fixture HR",
    previewText: "请问什么时候方便沟通？",
    conversationKey: safeDigest(["conversation", "id:reply-conversation-a"]),
    sourceJobId: "boss:encrypt-job-a",
    lastMessageId: EXPECTED_MESSAGE_ID,
    lastMessageDirection: "friend",
    lastMessageStatus: "unknown",
    identityVerified: true,
    ...overrides
  };
  return {
    ...value,
    recruiterKey: safeDigest(["recruiter", "label:Fixture HR"]),
    previewDigest: safeDigest(["preview", value.previewText]),
    previewKind: "possible_hr_reply",
    transientSignature: safeDigest([value.rowIndex, value.recruiterLabel, value.previewText, value.unread])
  };
}

function snapshot({ rows = [verifiedRow()], messages, selectedJobId = "encrypt-job-a" } = {}) {
  return {
    path: "/web/geek/chat",
    rows,
    headerText: "Fixture HR",
    positionName: "内容运营",
    companyName: "示例公司",
    salary: "15-20K",
    city: "上海",
    risk: false,
    login: false,
    messages: messages || [{
      direction: "friend",
      messageId: EXPECTED_MESSAGE_ID,
      text: "请问什么时候方便沟通？",
      contentKind: "text"
    }],
    writeTargetsPresent: { editor: true, send: true },
    selectedJobId
  };
}

function frozenItem(overrides = {}) {
  const replyText = "您好，  我周三下午可以沟通。";
  return {
    id: 91,
    batchId: 17,
    position: 0,
    draftId: 33,
    cardId: 44,
    jobId: 55,
    conversationKey: verifiedRow().conversationKey,
    sourceJobId: "boss:encrypt-job-a",
    expectedLastMessageId: EXPECTED_MESSAGE_ID,
    draftRevision: 2,
    replyText,
    replyDigest: digest(replyText),
    status: "pending",
    clickCount: 0,
    ...overrides
  };
}

function fakeBrowser({
  rows = [verifiedRow()],
  detailMessages,
  selectedJobId = "encrypt-job-a",
  editorText = "",
  contentEditable = true,
  readbackText = null,
  dispatchState = "ready",
  verifyState = "ready",
  outgoingText = null,
  outgoingFailed = false,
  clearRows = null
} = {}) {
  const calls = [];
  let insertedText = "";
  let clicked = false;
  const pageSnapshot = snapshot({ rows, messages: detailMessages, selectedJobId });
  const tabs = [
    { id: 501, windowId: 12, active: false, url: SEARCH_URL },
    { id: COMMUNICATION_TAB_ID, windowId: 12, active: false, url: CHAT_URL },
    { id: 503, windowId: 12, active: true, url: "http://127.0.0.1:3000/messages" }
  ];
  const evaluateReplyExpression = (expression, phase) => {
    const phaseRows = phase === "dispatch" && dispatchState === "target_mismatch"
      ? [verifiedRow({ conversationKey: safeDigest(["conversation", "id:dispatch-drift"]) })]
      : phase === "clear" && clearRows ? clearRows : rows;
    const phaseSnapshot = snapshot({ rows: phaseRows, messages: detailMessages, selectedJobId });
    let editorValue = phase === "preflight" || phase === "focus"
      ? editorText
      : phase === "dispatch" ? insertedText
        : readbackText === null ? insertedText : readbackText;
    const document = {
      activeElement: null,
      querySelectorAll(selector) {
        if (selector === "#chat-input") return [editor];
        if (selector === ".btn-send") return [sendButton];
        if (selector === ".message-item.item-myself") return clicked ? [outgoingMessage] : [];
        return [];
      },
      elementFromPoint() { return sendButton; }
    };
    const editor = {
      isContentEditable: contentEditable,
      getAttribute(name) { return name === "contenteditable" ? String(contentEditable) : null; },
      getBoundingClientRect() { return { width: 500, height: 80, left: 20, top: 600 }; },
      focus() { document.activeElement = editor; },
      dispatchEvent() {},
      get innerText() { return editorValue; },
      set innerText(value) { editorValue = String(value); insertedText = editorValue; },
      get textContent() { return editorValue; },
      set textContent(value) { editorValue = String(value); insertedText = editorValue; }
    };
    const sendButton = {
      disabled: false,
      getAttribute() { return null; },
      getBoundingClientRect() { return { width: 90, height: 36, left: 600, top: 700 }; },
      contains(value) { return value === sendButton; }
    };
    const outgoingMessage = {
      getAttribute(name) { return name === "data-mid" ? OUTGOING_MESSAGE_ID : null; },
      get innerText() { return outgoingText === null ? insertedText : outgoingText; },
      get textContent() { return outgoingText === null ? insertedText : outgoingText; },
      querySelector() { return outgoingFailed ? {} : null; }
    };
    return vm.runInNewContext(expression, {
      location: { pathname: "/web/geek/chat" },
      window: { __bossMessageSnapshot: () => phaseSnapshot },
      document,
      InputEvent: class InputEvent {},
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      innerWidth: 1280,
      innerHeight: 800
    });
  };
  return {
    calls,
    get insertedText() { return insertedText; },
    get clicked() { return clicked; },
    async listTabs() {
      calls.push(["listTabs"]);
      return tabs;
    },
    async evalValue(tabId, expression) {
      calls.push(["evalValue", tabId, expression]);
      if (expression.includes("__bossGuardedMessageConversationClick")) {
        return { clicked: true, operation: "__bossGuardedMessageConversationClick", rowIndex: 0 };
      }
      if (expression.includes("ConversationPositionInfo")) {
        return { state: "ready", jobId: selectedJobId, securityId: "fixture-security" };
      }
      if (expression.includes("__roleflowReplyEditorPreflight")) {
        return evaluateReplyExpression(expression, "preflight");
      }
      if (expression.includes("__roleflowReplyEditorFocus")) return evaluateReplyExpression(expression, "focus");
      if (expression.includes("__roleflowReplyEditorReadback")) {
        return evaluateReplyExpression(expression, "readback");
      }
      if (expression.includes("__roleflowReplyClear")) {
        return evaluateReplyExpression(expression, "clear");
      }
      if (expression.includes("__roleflowReplyDispatch")) {
        return evaluateReplyExpression(expression, "dispatch");
      }
      if (expression.includes("__roleflowReplyVerify")) {
        if (verifyState !== "ready") return { state: verifyState };
        return evaluateReplyExpression(expression, "verify");
      }
      return pageSnapshot;
    },
    async cdp(tabId, method, params) {
      calls.push(["cdp", tabId, method, params]);
      if (method === "Input.insertText") insertedText = String(params?.text || "");
      return {};
    },
    async clickAt(tabId, point) {
      calls.push(["clickAt", tabId, point]);
      clicked = true;
    }
  };
}

function setup(options = {}) {
  const browser = fakeBrowser(options);
  const reader = createBossMessageReader({ browser, sleepFn: async () => {} });
  const sender = createBossMessageReplySender({ browser, reader, sleepFn: async () => {} });
  return { browser, sender };
}

(async () => {
  const item = frozenItem();
  const foldedReply = "您好， 我周三下午可以沟通。";
  const { browser, sender } = setup({ readbackText: foldedReply, outgoingText: foldedReply });
  const inspection = await sender.inspectReplyTarget(item);
  assert.deepStrictEqual(inspection, { kind: "boss_message_reply_inspection" });
  assert(!JSON.stringify(inspection).includes(item.replyText));

  const preparation = await sender.fillReply(inspection, item.replyText);
  assert.deepStrictEqual(preparation, { kind: "boss_message_reply_preparation" });
  assert.strictEqual(browser.insertedText, item.replyText);
  assert.deepStrictEqual(
    browser.calls.filter((call) => call[0] === "cdp").map((call) => [call[2], call[3]]),
    [
      ["Emulation.setFocusEmulationEnabled", { enabled: true }],
      ["Input.insertText", { text: item.replyText }],
      ["Emulation.setFocusEmulationEnabled", { enabled: false }]
    ]
  );

  const dispatched = await sender.dispatchReply(preparation);
  assert.strictEqual(dispatched, preparation);
  assert.strictEqual(browser.calls.filter((call) => call[0] === "clickAt").length, 1);
  const outcome = await sender.verifyReplyResult(preparation);
  assert.deepStrictEqual(outcome, {
    state: "succeeded",
    evidence: {
      verification: "new_outgoing_message",
      outgoingMessageId: OUTGOING_MESSAGE_ID,
      replyDigest: item.replyDigest
    }
  });
  assert(!browser.calls.some((call) => JSON.stringify(call).includes("Page.bringToFront")));
  for (const [, , expression] of browser.calls.filter((call) => call[0] === "evalValue")) {
    assert.doesNotThrow(() => new vm.Script(expression), "every injected browser expression must compile");
  }

  await assert.rejects(
    () => sender.dispatchReply(preparation),
    (error) => error.code === "BOSS_MESSAGE_REPLY_ALREADY_DISPATCHED"
  );
  assert.strictEqual(browser.calls.filter((call) => call[0] === "clickAt").length, 1);
  assert.deepStrictEqual(await sender.clearPreparedReply(preparation), { cleared: false },
    "text must never be cleared after a send click was dispatched");

  const unmatched = setup({ rows: [verifiedRow({ conversationKey: safeDigest(["conversation", "id:other"]) })] });
  await assert.rejects(
    () => unmatched.sender.inspectReplyTarget(item),
    (error) => error.code === "BOSS_MESSAGE_REPLY_TARGET_MISMATCH"
  );
  assert.strictEqual(unmatched.browser.calls.filter((call) => call[0] === "clickAt").length, 0);

  const duplicate = setup({ rows: [verifiedRow(), verifiedRow({ rowIndex: 1 })] });
  await assert.rejects(
    () => duplicate.sender.inspectReplyTarget(item),
    (error) => error.code === "BOSS_MESSAGE_REPLY_TARGET_MISMATCH"
  );

  const wrongJob = setup({ selectedJobId: "encrypt-job-other" });
  await assert.rejects(
    () => wrongJob.sender.inspectReplyTarget(item),
    (error) => error.code === "BOSS_MESSAGE_REPLY_TARGET_MISMATCH"
  );

  const wrongLastMessage = setup({ detailMessages: [{
    direction: "friend",
    messageId: "378917037748739",
    text: "新的 HR 消息",
    contentKind: "text"
  }] });
  await assert.rejects(
    () => wrongLastMessage.sender.inspectReplyTarget(item),
    (error) => error.code === "BOSS_MESSAGE_REPLY_TARGET_MISMATCH"
  );

  for (const options of [{ editorText: "已有文字" }, { contentEditable: false }]) {
    const attempt = setup(options);
    const inspected = await attempt.sender.inspectReplyTarget(item);
    await assert.rejects(
      () => attempt.sender.fillReply(inspected, item.replyText),
      (error) => error.code === "BOSS_MESSAGE_REPLY_EDITOR_NOT_EMPTY"
        || error.code === "BOSS_MESSAGE_REPLY_EDITOR_INVALID"
    );
    assert.strictEqual(attempt.browser.calls.filter((call) => call[0] === "clickAt").length, 0);
    assert.strictEqual(attempt.browser.calls.filter((call) => call[0] === "cdp" && call[2] === "Input.insertText").length, 0);
  }

  const readbackMismatch = setup({ readbackText: "被页面改写" });
  const readbackInspection = await readbackMismatch.sender.inspectReplyTarget(item);
  await assert.rejects(
    () => readbackMismatch.sender.fillReply(readbackInspection, item.replyText),
    (error) => error.code === "BOSS_MESSAGE_REPLY_READBACK_MISMATCH"
  );
  assert.strictEqual(readbackMismatch.browser.calls.filter((call) => call[0] === "clickAt").length, 0);

  const dispatchDrift = setup({ dispatchState: "target_mismatch" });
  const driftInspection = await dispatchDrift.sender.inspectReplyTarget(item);
  const driftPreparation = await dispatchDrift.sender.fillReply(driftInspection, item.replyText);
  await assert.rejects(
    () => dispatchDrift.sender.dispatchReply(driftPreparation),
    (error) => error.code === "BOSS_MESSAGE_REPLY_TARGET_MISMATCH"
  );
  assert.strictEqual(dispatchDrift.browser.calls.filter((call) => call[0] === "clickAt").length, 0);

  const ambiguous = setup({ outgoingText: "不一致的文本" });
  const ambiguousInspection = await ambiguous.sender.inspectReplyTarget(item);
  const ambiguousPreparation = await ambiguous.sender.fillReply(ambiguousInspection, item.replyText);
  await ambiguous.sender.dispatchReply(ambiguousPreparation);
  assert.strictEqual((await ambiguous.sender.verifyReplyResult(ambiguousPreparation)).state, "ambiguous");

  const rejected = setup({ outgoingFailed: true });
  const rejectedInspection = await rejected.sender.inspectReplyTarget(item);
  const rejectedPreparation = await rejected.sender.fillReply(rejectedInspection, item.replyText);
  await rejected.sender.dispatchReply(rejectedPreparation);
  assert.strictEqual((await rejected.sender.verifyReplyResult(rejectedPreparation)).state, "platform_rejected");

  const clearable = setup();
  const clearableInspection = await clearable.sender.inspectReplyTarget(item);
  const clearablePreparation = await clearable.sender.fillReply(clearableInspection, item.replyText);
  assert.deepStrictEqual(await clearable.sender.clearPreparedReply(clearablePreparation), { cleared: true });
  assert.strictEqual(clearable.browser.insertedText, "");
  await assert.rejects(
    () => clearable.sender.dispatchReply(clearablePreparation),
    (error) => error.code === "BOSS_MESSAGE_REPLY_PREPARATION_CLEARED"
  );

  const clearDrift = setup({
    clearRows: [verifiedRow({ conversationKey: safeDigest(["conversation", "id:other-clear-target"]) })]
  });
  const clearDriftInspection = await clearDrift.sender.inspectReplyTarget(item);
  const clearDriftPreparation = await clearDrift.sender.fillReply(clearDriftInspection, item.replyText);
  assert.deepStrictEqual(await clearDrift.sender.clearPreparedReply(clearDriftPreparation), { cleared: false },
    "prepared text must not be cleared after the selected conversation drifts");
  assert.strictEqual(clearDrift.browser.insertedText, item.replyText);

  console.log("boss_message_reply_sender_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
