const crypto = require("node:crypto");

const CHAT_PATH = "/web/geek/chat";
const VERIFY_ATTEMPTS = 3;
const VERIFY_INTERVAL_MS = 250;

function createBossMessageReplySender({ browser, reader, sleepFn = sleep } = {}) {
  assertDependencies(browser, reader);
  const inspections = new WeakMap();
  const preparations = new WeakMap();

  return {
    inspectReplyTarget,
    fillReply,
    dispatchReply,
    verifyReplyResult,
    clearPreparedReply
  };

  async function inspectReplyTarget(rawItem, signal) {
    const item = normalizeFrozenItem(rawItem);
    throwIfAborted(signal);
    const scan = await reader.scanConversationRows();
    const matches = scan.rows.filter((row) => row.identityVerified === true
      && row.conversationKey === item.conversationKey
      && row.sourceJobId === item.sourceJobId
      && row.lastMessageId === item.expectedLastMessageId
      && row.lastMessageDirection === "friend");
    if (matches.length !== 1) throw targetMismatch();
    const row = matches[0];
    const target = {
      ...row,
      tabId: scan.tabId,
      operation: "authorized_reply"
    };
    const selected = await reader.openQueuedConversation(target, signal);
    if (!selected || selected.skipped) throw targetMismatch();
    assertSelectedSnapshot(selected, item);
    const selectedJob = await reader.readSelectedJobTarget(selected, signal);
    if (`boss:${selectedJob.jobId}` !== item.sourceJobId) throw targetMismatch();
    const token = Object.freeze({ kind: "boss_message_reply_inspection" });
    inspections.set(token, {
      item,
      tabId: scan.tabId,
      selected,
      preparationCreated: false
    });
    return token;
  }

  async function fillReply(inspection, replyText, signal) {
    const inspected = inspections.get(inspection);
    if (!inspected || inspected.preparationCreated) {
      throw senderError("BOSS_MESSAGE_REPLY_INSPECTION_INVALID", "reply inspection is invalid or already used");
    }
    const exactText = normalizedReplyText(replyText);
    if (exactText !== inspected.item.replyText || replyDigest(exactText) !== inspected.item.replyDigest) {
      throw senderError("BOSS_MESSAGE_REPLY_TEXT_MISMATCH", "reply text differs from the confirmed batch snapshot");
    }
    throwIfAborted(signal);
    await reader.assertActiveBindings();
    const preflight = normalizeProbe(await browser.evalValue(
      inspected.tabId,
      buildEditorPreflightExpression(inspected.item)
    ));
    assertReadyProbe(preflight);
    if (preflight.editorCount !== 1 || preflight.contentEditable !== true) {
      throw senderError("BOSS_MESSAGE_REPLY_EDITOR_INVALID", "reply editor is unavailable or not editable");
    }
    if (foldWhitespace(preflight.editorText)) {
      throw senderError("BOSS_MESSAGE_REPLY_EDITOR_NOT_EMPTY", "reply editor already contains text");
    }

    let inserted = false;
    try {
      await reader.assertActiveBindings();
      await browser.cdp(inspected.tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
      try {
        const focus = normalizeProbe(await browser.evalValue(
          inspected.tabId,
          buildEditorFocusExpression(inspected.item)
        ));
        assertReadyProbe(focus);
        if (focus.focused !== true) {
          throw senderError("BOSS_MESSAGE_REPLY_EDITOR_INVALID", "reply editor could not be focused safely");
        }
        throwIfAborted(signal);
        await browser.cdp(inspected.tabId, "Input.insertText", { text: exactText });
        inserted = true;
      } finally {
        await browser.cdp(inspected.tabId, "Emulation.setFocusEmulationEnabled", { enabled: false });
      }

      await reader.assertActiveBindings();
      const readback = normalizeProbe(await browser.evalValue(
        inspected.tabId,
        buildEditorReadbackExpression(inspected.item)
      ));
      assertReadyProbe(readback);
      if (replyDigest(readback.editorText) !== inspected.item.replyDigest) {
        throw senderError("BOSS_MESSAGE_REPLY_READBACK_MISMATCH", "reply editor read-back did not match the confirmed text");
      }
    } catch (error) {
      if (inserted) await clearOwnedEditor(inspected.tabId, inspected.item).catch(() => {});
      throw error;
    }
    inspected.preparationCreated = true;
    const token = Object.freeze({ kind: "boss_message_reply_preparation" });
    preparations.set(token, {
      item: inspected.item,
      tabId: inspected.tabId,
      state: "filled",
      result: null
    });
    return token;
  }

  async function dispatchReply(preparation, signal) {
    const prepared = requirePreparation(preparation);
    if (prepared.state === "cleared") {
      throw senderError("BOSS_MESSAGE_REPLY_PREPARATION_CLEARED", "reply preparation was cleared");
    }
    if (prepared.state !== "filled") {
      throw senderError("BOSS_MESSAGE_REPLY_ALREADY_DISPATCHED", "reply send click was already dispatched");
    }
    throwIfAborted(signal);
    await reader.assertActiveBindings();
    const guard = normalizeProbe(await browser.evalValue(
      prepared.tabId,
      buildDispatchExpression(prepared.item)
    ));
    assertReadyProbe(guard);
    if (!guard.point || !Number.isFinite(guard.point.x) || !Number.isFinite(guard.point.y)) {
      throw senderError("BOSS_MESSAGE_REPLY_SEND_BUTTON_INVALID", "reply send button is unavailable");
    }

    await reader.assertActiveBindings();
    await browser.cdp(prepared.tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
    prepared.state = "dispatched";
    try {
      await browser.clickAt(prepared.tabId, guard.point);
    } catch (cause) {
      throw Object.assign(
        senderError("BOSS_MESSAGE_REPLY_CLICK_AMBIGUOUS", "reply send click outcome is ambiguous"),
        { cause }
      );
    } finally {
      await browser.cdp(prepared.tabId, "Emulation.setFocusEmulationEnabled", { enabled: false });
    }
    return preparation;
  }

  async function verifyReplyResult(preparation, signal) {
    const prepared = requirePreparation(preparation);
    if (prepared.result) return prepared.result;
    if (prepared.state !== "dispatched") {
      throw senderError("BOSS_MESSAGE_REPLY_NOT_DISPATCHED", "reply send click was not dispatched");
    }
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt) await sleepFn(VERIFY_INTERVAL_MS, signal);
      throwIfAborted(signal);
      await reader.assertActiveBindings();
      const probe = normalizeProbe(await browser.evalValue(
        prepared.tabId,
        buildVerifyExpression(prepared.item)
      ));
      if (probe.state === "target_mismatch") {
        prepared.result = Object.freeze({ state: "target_mismatch", evidence: { verification: "target_mismatch" } });
        return prepared.result;
      }
      if (probe.state !== "ready") continue;
      const exact = (Array.isArray(probe.outgoing) ? probe.outgoing : []).filter((message) => (
        /^\d{15}$/.test(String(message?.messageId || ""))
        && !prepared.item.priorMessageIds.has(String(message.messageId))
        && replyDigest(message.text) === prepared.item.replyDigest
      ));
      if (exact.length !== 1) continue;
      const message = exact[0];
      const state = message.failed === true ? "platform_rejected" : "succeeded";
      prepared.result = Object.freeze({
        state,
        evidence: Object.freeze({
          verification: message.failed === true ? "outgoing_message_rejected" : "new_outgoing_message",
          outgoingMessageId: String(message.messageId),
          replyDigest: prepared.item.replyDigest
        })
      });
      return prepared.result;
    }
    prepared.result = Object.freeze({ state: "ambiguous", evidence: { verification: "outgoing_message_unverified" } });
    return prepared.result;
  }

  async function clearPreparedReply(preparation) {
    const prepared = requirePreparation(preparation);
    if (prepared.state === "cleared") return { cleared: true };
    if (prepared.state !== "filled") return { cleared: false };
    await reader.assertActiveBindings();
    const result = await clearOwnedEditor(prepared.tabId, prepared.item);
    if (result?.state !== "cleared") return { cleared: false };
    prepared.state = "cleared";
    return { cleared: true };
  }

  async function clearOwnedEditor(tabId, item) {
    return browser.evalValue(tabId, buildClearExpression(item));
  }

  function requirePreparation(value) {
    const prepared = preparations.get(value);
    if (!prepared) {
      throw senderError("BOSS_MESSAGE_REPLY_PREPARATION_INVALID", "reply preparation is invalid");
    }
    return prepared;
  }
}

function assertDependencies(browser, reader) {
  for (const name of ["evalValue", "cdp", "clickAt"]) {
    if (typeof browser?.[name] !== "function") throw senderError("BOSS_MESSAGE_REPLY_BROWSER_INVALID", `browser.${name} is required`);
  }
  for (const name of ["scanConversationRows", "openQueuedConversation", "readSelectedJobTarget", "assertActiveBindings"]) {
    if (typeof reader?.[name] !== "function") throw senderError("BOSS_MESSAGE_REPLY_READER_INVALID", `reader.${name} is required`);
  }
}

function normalizeFrozenItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw targetMismatch();
  const replyText = normalizedReplyText(value.replyText);
  const item = {
    conversationKey: String(value.conversationKey || ""),
    sourceJobId: String(value.sourceJobId || ""),
    expectedLastMessageId: String(value.expectedLastMessageId || ""),
    replyText,
    replyDigest: String(value.replyDigest || "")
  };
  if (!/^sha256:[a-f0-9]{64}$/.test(item.conversationKey)
    || !/^boss:[A-Za-z0-9_-]{6,160}$/.test(item.sourceJobId)
    || !/^\d{15}$/.test(item.expectedLastMessageId)
    || !/^sha256:[a-f0-9]{64}$/.test(item.replyDigest)
    || replyDigest(replyText) !== item.replyDigest) throw targetMismatch();
  return item;
}

function assertSelectedSnapshot(snapshot, item) {
  const rows = snapshot.rows.filter((row) => row.selected);
  const friendMessages = snapshot.messages.filter((message) => message.direction === "friend");
  if (rows.length !== 1
    || rows[0].conversationKey !== item.conversationKey
    || rows[0].sourceJobId !== item.sourceJobId
    || rows[0].lastMessageId !== item.expectedLastMessageId
    || rows[0].lastMessageDirection !== "friend"
    || friendMessages.at(-1)?.messageId !== item.expectedLastMessageId) throw targetMismatch();
  item.priorMessageIds = new Set(snapshot.messages.map((message) => message.messageId));
}

function buildEditorPreflightExpression(item) {
  return buildPageExpression("__roleflowReplyEditorPreflight", item, String.raw`
    const editors = Array.from(document.querySelectorAll("#chat-input"));
    if (editors.length !== 1) return { state: "editor_invalid", editorCount: editors.length };
    const editor = editors[0];
    const editable = editor.isContentEditable === true || ["", "true"].includes(String(editor.getAttribute("contenteditable")));
    if (!visible(editor)) return { state: "editor_invalid", editorCount: 1 };
    return { state: "ready", editorCount: 1, contentEditable: editable, editorText: String(editor.innerText || editor.textContent || "") };
  `);
}

function buildEditorFocusExpression(item) {
  return buildPageExpression("__roleflowReplyEditorFocus", item, String.raw`
    const editors = Array.from(document.querySelectorAll("#chat-input"));
    if (editors.length !== 1) return { state: "editor_invalid", operation };
    const editor = editors[0];
    const editable = editor.isContentEditable === true || ["", "true"].includes(String(editor.getAttribute("contenteditable")));
    if (!editable || !visible(editor) || fold(editor.innerText || editor.textContent)) return { state: "editor_invalid", operation };
    editor.focus({ preventScroll: true });
    return { state: "ready", operation, focused: document.activeElement === editor };
  `);
}

function buildEditorReadbackExpression(item) {
  return buildPageExpression("__roleflowReplyEditorReadback", item, String.raw`
    const editors = Array.from(document.querySelectorAll("#chat-input"));
    if (editors.length !== 1) return { state: "editor_invalid", operation };
    const editor = editors[0];
    const editable = editor.isContentEditable === true || ["", "true"].includes(String(editor.getAttribute("contenteditable")));
    if (!editable || !visible(editor)) return { state: "editor_invalid", operation };
    return { state: "ready", operation, editorText: String(editor.innerText || editor.textContent || "") };
  `);
}

function buildClearExpression(item) {
  return buildPageExpression("__roleflowReplyClear", item, String.raw`
    const editors = Array.from(document.querySelectorAll("#chat-input"));
    if (editors.length !== 1) return { state: "not_owned", operation };
    const editor = editors[0];
    if (fold(editor.innerText || editor.textContent) !== fold(expected.replyText)) return { state: "not_owned", operation };
    editor.textContent = "";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
    return { state: fold(editor.innerText || editor.textContent) ? "not_owned" : "cleared", operation };
  `);
}

function buildDispatchExpression(item) {
  return buildPageExpression("__roleflowReplyDispatch", item, String.raw`
    const editors = Array.from(document.querySelectorAll("#chat-input"));
    if (editors.length !== 1 || fold(editors[0].innerText || editors[0].textContent) !== fold(expected.replyText)) return { state: "text_mismatch" };
    const buttons = Array.from(document.querySelectorAll(".btn-send")).filter(visible);
    if (buttons.length !== 1 || buttons[0].disabled === true || buttons[0].getAttribute("aria-disabled") === "true") return { state: "send_button_invalid" };
    const rect = buttons[0].getBoundingClientRect();
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const hit = document.elementFromPoint(point.x, point.y);
    if (point.x < 0 || point.y < 0 || point.x > innerWidth || point.y > innerHeight
      || !(hit === buttons[0] || buttons[0].contains(hit))) return { state: "send_button_invalid" };
    return { state: "ready", point };
  `);
}

function buildVerifyExpression(item) {
  return buildPageExpression("__roleflowReplyVerify", item, String.raw`
    const outgoing = Array.from(document.querySelectorAll(".message-item.item-myself")).map((message) => ({
      messageId: String(message.getAttribute("data-mid") || ""),
      text: String(message.innerText || message.textContent || ""),
      failed: Boolean(message.querySelector(".message-failed, .send-failed, .status-failed"))
    }));
    return { state: "ready", outgoing };
  `, { allowLastMessageChange: true });
}

function buildPageExpression(operation, item, body, { allowLastMessageChange = false } = {}) {
  const expected = JSON.stringify({
    conversationKey: item.conversationKey,
    sourceJobId: item.sourceJobId,
    lastMessageId: item.expectedLastMessageId,
    replyText: item.replyText
  });
  return String.raw`(() => {
    const operation = "${operation}";
    const expected = ${expected};
    const fold = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0"; };
    if (location.pathname !== "${CHAT_PATH}" || typeof window.__bossMessageSnapshot !== "function") return { state: "page_lost", operation };
    const snapshot = window.__bossMessageSnapshot();
    if (snapshot.risk === true) return { state: "risk_control", operation };
    if (snapshot.login === true) return { state: "login_required", operation };
    const selected = snapshot.rows.filter((row) => row.selected === true);
    const friendMessages = snapshot.messages.filter((message) => message.direction === "friend");
    if (selected.length !== 1
      || selected[0].conversationKey !== expected.conversationKey
      || selected[0].sourceJobId !== expected.sourceJobId
      || friendMessages.at(-1)?.messageId !== expected.lastMessageId
      || (!${allowLastMessageChange} && (selected[0].lastMessageId !== expected.lastMessageId || selected[0].lastMessageDirection !== "friend"))) {
      return { state: "target_mismatch", operation };
    }
    ${body}
  })()`;
}

function normalizeProbe(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.state !== "string") {
    throw senderError("BOSS_MESSAGE_REPLY_PROBE_INVALID", "reply page probe returned an invalid result");
  }
  return value;
}

function assertReadyProbe(probe) {
  if (probe.state === "ready") return;
  const map = {
    target_mismatch: "BOSS_MESSAGE_REPLY_TARGET_MISMATCH",
    page_lost: "BOSS_MESSAGE_PAGE_LOST",
    risk_control: "BOSS_RISK_CONTROL",
    login_required: "BOSS_LOGIN_REQUIRED",
    text_mismatch: "BOSS_MESSAGE_REPLY_READBACK_MISMATCH",
    editor_invalid: "BOSS_MESSAGE_REPLY_EDITOR_INVALID",
    send_button_invalid: "BOSS_MESSAGE_REPLY_SEND_BUTTON_INVALID"
  };
  throw senderError(map[probe.state] || "BOSS_MESSAGE_REPLY_PROBE_INVALID", "reply page verification stopped");
}

function normalizedReplyText(value) {
  const text = String(value == null ? "" : value).replace(/\r\n?/g, "\n").trim();
  if (!text || text.length > 4000) throw senderError("BOSS_MESSAGE_REPLY_TEXT_INVALID", "reply text is invalid");
  return text;
}

function foldWhitespace(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function replyDigest(value) {
  return `sha256:${crypto.createHash("sha256").update(foldWhitespace(value)).digest("hex")}`;
}

function targetMismatch() {
  return senderError("BOSS_MESSAGE_REPLY_TARGET_MISMATCH", "confirmed reply target does not match the current BOSS conversation");
}

function senderError(code, message) {
  return Object.assign(new Error(message), { code });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || senderError("MESSAGE_REPLY_SEND_STOPPED", "message reply send stopped");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || senderError("MESSAGE_REPLY_SEND_STOPPED", "message reply send stopped"));
    }, { once: true });
  });
}

module.exports = {
  createBossMessageReplySender
};
