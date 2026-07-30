const {
  BOSS_MESSAGE_SNAPSHOT_EXPRESSION,
  buildUnreadConversationQueue,
  safeDigest
} = require("./boss_message_dom");

const CHAT_PATH = "/web/geek/chat";
const GUARDED_OPERATION = "__bossGuardedMessageConversationClick";
const GUARDED_REASONS = new Set([
  "page_lost",
  "snapshot_helper_missing",
  "risk_control",
  "login_required",
  "row_drifted",
  "no_longer_unread",
  "row_not_clickable"
]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizedText(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function conversationSignature(row) {
  return safeDigest([
    row.rowIndex,
    normalizedText(row.recruiterLabel),
    normalizedText(row.previewText),
    Boolean(row.unread)
  ]);
}

function requireSnapshotField(value, predicate) {
  if (!predicate(value)) throw codedError("BOSS_MESSAGE_STRUCTURE_CHANGED", "message page structure changed");
  return value;
}

function normalizeBrowserSnapshot(value) {
  const snapshot = requireSnapshotField(value, (item) => item && typeof item === "object" && !Array.isArray(item));
  requireSnapshotField(snapshot.path, (item) => item === CHAT_PATH);
  requireSnapshotField(snapshot.rows, Array.isArray);
  requireSnapshotField(snapshot.messages, Array.isArray);
  const rows = snapshot.rows.map((item) => {
    const row = requireSnapshotField(item, (entry) => entry && typeof entry === "object" && !Array.isArray(entry));
    requireSnapshotField(row.rowIndex, Number.isInteger);
    requireSnapshotField(row.unread, (entry) => typeof entry === "boolean");
    requireSnapshotField(row.selected, (entry) => typeof entry === "boolean");
    requireSnapshotField(row.recruiterLabel, (entry) => typeof entry === "string");
    requireSnapshotField(row.previewText, (entry) => typeof entry === "string");
    requireSnapshotField(row.transientSignature, (entry) => /^sha256:[a-f0-9]{64}$/.test(entry));
    const normalized = {
      rowIndex: row.rowIndex,
      unread: row.unread,
      selected: row.selected,
      recruiterLabel: normalizedText(row.recruiterLabel),
      previewText: normalizedText(row.previewText)
    };
    if (row.transientSignature !== conversationSignature(normalized)) {
      throw codedError("BOSS_MESSAGE_STRUCTURE_CHANGED", "message page structure changed");
    }
    return { ...normalized, transientSignature: row.transientSignature };
  });
  const messages = snapshot.messages.map((item) => {
    const message = requireSnapshotField(item, (entry) => entry && typeof entry === "object" && !Array.isArray(entry));
    requireSnapshotField(message.direction, (entry) => ["friend", "myself", "system"].includes(entry));
    requireSnapshotField(message.messageId, (entry) => /^\d{15}$/.test(entry));
    requireSnapshotField(message.text, (entry) => typeof entry === "string");
    return { direction: message.direction, messageId: message.messageId, text: normalizedText(message.text) };
  });
  for (const field of ["headerText", "positionName", "salary", "city"]) {
    requireSnapshotField(snapshot[field], (entry) => typeof entry === "string");
  }
  requireSnapshotField(snapshot.risk, (entry) => typeof entry === "boolean");
  requireSnapshotField(snapshot.login, (entry) => typeof entry === "boolean");
  return {
    path: snapshot.path,
    rows,
    headerText: normalizedText(snapshot.headerText),
    positionName: normalizedText(snapshot.positionName),
    salary: normalizedText(snapshot.salary),
    city: normalizedText(snapshot.city),
    risk: snapshot.risk,
    login: snapshot.login,
    messages,
    writeTargetsPresent: {
      editor: Boolean(snapshot.writeTargetsPresent?.editor),
      send: Boolean(snapshot.writeTargetsPresent?.send)
    }
  };
}

function assertSafeSnapshot(snapshot) {
  if (snapshot.risk) throw codedError("BOSS_RISK_CONTROL", "BOSS requires security verification");
  if (snapshot.login) throw codedError("BOSS_LOGIN_REQUIRED", "BOSS login is required");
  return snapshot;
}

function buildGuardedConversationClickExpression(target) {
  const expected = JSON.stringify({ rowIndex: target.rowIndex, transientSignature: target.transientSignature });
  return `(() => {
    const operation = "${GUARDED_OPERATION}";
    const expected = ${expected};
    const fail = (reason) => ({ clicked: false, operation, reason });
    if (location.pathname !== "${CHAT_PATH}") return fail("page_lost");
    if (typeof window.__bossMessageSnapshot !== "function") return fail("snapshot_helper_missing");
    const snapshot = window.__bossMessageSnapshot();
    if (snapshot.risk === true) return fail("risk_control");
    if (snapshot.login === true) return fail("login_required");
    const rows = Array.from(document.querySelectorAll(".friend-content-warp"));
    const row = rows[expected.rowIndex];
    const snapshotRow = Array.isArray(snapshot.rows) ? snapshot.rows[expected.rowIndex] : null;
    if (!row || !row.isConnected || !snapshotRow || snapshotRow.rowIndex !== expected.rowIndex) return fail("row_drifted");
    if (snapshotRow.transientSignature !== expected.transientSignature) return fail("row_drifted");
    const unread = Boolean(row.querySelector(".notice-badge"));
    if (!unread) return fail("no_longer_unread");
    const rect = row.getBoundingClientRect();
    const style = getComputedStyle(row);
    if (rect.width <= 0 || rect.height <= 0
      || style.display === "none"
      || style.visibility === "hidden"
      || style.opacity === "0"
      || style.pointerEvents === "none") return fail("row_not_clickable");
    row.click();
    return { clicked: true, operation, rowIndex: expected.rowIndex };
  })()`;
}

function normalizeGuardedClickResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.operation !== GUARDED_OPERATION || typeof value.clicked !== "boolean") {
    throw codedError("BOSS_MESSAGE_GUARD_RESULT_INVALID", "message selection guard returned an invalid result");
  }
  if (value.clicked === true && Number.isInteger(value.rowIndex)) {
    return { clicked: true, rowIndex: value.rowIndex };
  }
  if (value.clicked === false && GUARDED_REASONS.has(value.reason)) {
    return { clicked: false, reason: value.reason };
  }
  throw codedError("BOSS_MESSAGE_GUARD_RESULT_INVALID", "message selection guard returned an invalid result");
}

function guardedResultError(reason) {
  const codes = {
    page_lost: "BOSS_MESSAGE_PAGE_LOST",
    snapshot_helper_missing: "BOSS_MESSAGE_STRUCTURE_CHANGED",
    risk_control: "BOSS_RISK_CONTROL",
    login_required: "BOSS_LOGIN_REQUIRED",
    row_drifted: "BOSS_MESSAGE_ROW_DRIFTED",
    row_not_clickable: "BOSS_MESSAGE_ROW_NOT_CLICKABLE"
  };
  return codedError(codes[reason] || "BOSS_MESSAGE_GUARD_RESULT_INVALID", "message selection guard stopped");
}

function selectedTargetMatches(snapshot, target) {
  const selected = snapshot.rows.filter((row) => row.selected);
  return selected.length === 1
    && selected[0].rowIndex === target.rowIndex
    && selected[0].transientSignature === target.transientSignature
    && Boolean(snapshot.headerText)
    && Boolean(snapshot.positionName)
    && snapshot.messages.every((item) => /^\d{15}$/.test(item.messageId));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || codedError("MESSAGE_DISCOVERY_STOPPED", "message discovery stopped");
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

function assertBrowser(browser) {
  for (const name of ["listTabs", "evalValue"]) {
    if (typeof browser?.[name] !== "function") throw codedError("BOSS_MESSAGE_BROWSER_INVALID", `browser.${name} is required`);
  }
}

function createBossMessageReader({ browser, sleepFn = sleep } = {}) {
  assertBrowser(browser);
  return {
    async scanUnread() {
      const tabs = (await browser.listTabs()).filter((tab) => {
        try {
          return new URL(String(tab.url || "")).pathname === CHAT_PATH;
        } catch {
          return false;
        }
      });
      if (tabs.length === 0) throw codedError("BOSS_MESSAGE_TAB_MISSING", "open the fixed BOSS message page");
      if (tabs.length !== 1) throw codedError("BOSS_MESSAGE_TAB_AMBIGUOUS", "exactly one BOSS message tab is required");
      const tabId = tabs[0].id;
      const snapshot = assertSafeSnapshot(normalizeBrowserSnapshot(await browser.evalValue(tabId, BOSS_MESSAGE_SNAPSHOT_EXPRESSION)));
      const queue = Object.freeze(buildUnreadConversationQueue(snapshot).map((target) => Object.freeze({ ...target, tabId })));
      return { tabId, queue };
    },
    async openQueuedConversation(target, signal) {
      throwIfAborted(signal);
      const guarded = normalizeGuardedClickResult(await browser.evalValue(target.tabId, buildGuardedConversationClickExpression(target)));
      if (!guarded.clicked) {
        if (guarded.reason === "no_longer_unread") return { skipped: true, reasonCode: "BOSS_MESSAGE_NO_LONGER_UNREAD" };
        throw guardedResultError(guarded.reason);
      }
      if (guarded.rowIndex !== target.rowIndex) throw codedError("BOSS_MESSAGE_GUARD_RESULT_INVALID", "message selection guard returned an invalid result");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt) await sleepFn(250, signal);
        const after = assertSafeSnapshot(normalizeBrowserSnapshot(await browser.evalValue(target.tabId, BOSS_MESSAGE_SNAPSHOT_EXPRESSION)));
        if (selectedTargetMatches(after, target)) return after;
      }
      throw codedError("BOSS_MESSAGE_TARGET_MISMATCH", "selected conversation identity did not match");
    }
  };
}

module.exports = {
  buildGuardedConversationClickExpression,
  createBossMessageReader
};
