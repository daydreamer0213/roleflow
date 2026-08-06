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
    requireSnapshotField(row.recruiterKey, (entry) => /^sha256:[a-f0-9]{64}$/.test(entry));
    requireSnapshotField(row.conversationKey, (entry) => /^sha256:[a-f0-9]{64}$/.test(entry));
    requireSnapshotField(row.previewDigest, (entry) => /^sha256:[a-f0-9]{64}$/.test(entry));
    requireSnapshotField(row.previewKind, (entry) => ["self_delivered", "self_read", "platform_notice", "possible_hr_reply", "unsupported", "unknown"].includes(entry));
    requireSnapshotField(row.transientSignature, (entry) => /^sha256:[a-f0-9]{64}$/.test(entry));
    const normalized = {
      rowIndex: row.rowIndex,
      unread: row.unread,
      selected: row.selected,
      recruiterLabel: normalizedText(row.recruiterLabel),
      previewText: normalizedText(row.previewText),
      recruiterKey: row.recruiterKey,
      conversationKey: row.conversationKey,
      previewDigest: row.previewDigest,
      previewKind: row.previewKind
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
    requireSnapshotField(message.contentKind, (entry) => ["text", "image", "voice", "attachment", "unknown"].includes(entry));
    return { direction: message.direction, messageId: message.messageId, text: normalizedText(message.text), contentKind: message.contentKind };
  });
  for (const field of ["headerText", "positionName", "companyName", "salary", "city"]) {
    requireSnapshotField(snapshot[field], (entry) => typeof entry === "string");
  }
  requireSnapshotField(snapshot.risk, (entry) => typeof entry === "boolean");
  requireSnapshotField(snapshot.login, (entry) => typeof entry === "boolean");
  return {
    path: snapshot.path,
    rows,
    headerText: normalizedText(snapshot.headerText),
    positionName: normalizedText(snapshot.positionName),
    companyName: normalizedText(snapshot.companyName),
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
  const expected = JSON.stringify({ rowIndex: target.rowIndex, transientSignature: target.transientSignature, conversationKey: target.conversationKey });
  return `(() => {
    const operation = "${GUARDED_OPERATION}";
    const expected = ${expected};
    const fail = (reason) => ({ clicked: false, operation, reason });
    const normalize = (value) => String(value == null ? "" : value).replace(/\\s+/g, " ").trim();
    const lines = (value) => String(value == null ? "" : value).split(/\\r?\\n/).map(normalize).filter(Boolean);
    const canonical = (parts) => parts.map((item) => String(item == null ? "" : item).trim()).join("\0");
    const sha256 = (value) => {
      const mask = 0xffffffffn, word = (number) => BigInt.asUintN(32, BigInt(number)), rotateRight = (number, amount) => ((number >> BigInt(amount)) | (number << BigInt(32 - amount))) & mask;
      const constants = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2].map(word);
      const bytes = Array.from(unescape(encodeURIComponent(value)), (character) => character.charCodeAt(0));
      const bitLength = BigInt(bytes.length) * 8n;
      bytes.push(128); while (bytes.length % 64 !== 56) bytes.push(0);
      for (let shift = 56; shift >= 0; shift -= 8) bytes.push(Number((bitLength >> BigInt(shift)) & 255n));
      const hash = [1779033703, -1150833019, 1013904242, -1521486534, 1359893119, -1694144372, 528734635, 1541459225].map(word);
      for (let offset = 0; offset < bytes.length; offset += 64) {
        const block = Array(64).fill(0n);
        for (let index = 0; index < 16; index += 1) for (let byte = 0; byte < 4; byte += 1) block[index] = (block[index] << 8n) | BigInt(bytes[offset + index * 4 + byte]);
        for (let index = 16; index < 64; index += 1) block[index] = (block[index - 16] + (rotateRight(block[index - 15], 7) ^ rotateRight(block[index - 15], 18) ^ (block[index - 15] >> 3n)) + block[index - 7] + (rotateRight(block[index - 2], 17) ^ rotateRight(block[index - 2], 19) ^ (block[index - 2] >> 10n))) & mask;
        let [a, b, c, d, e, f, g, h] = hash;
        for (let index = 0; index < 64; index += 1) {
          const first = (h + (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) + ((e & f) ^ ((~e & mask) & g)) + constants[index] + block[index]) & mask;
          const second = ((rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) & mask;
          h = g; g = f; f = e; e = (d + first) & mask; d = c; c = b; b = a; a = (first + second) & mask;
        }
        hash[0] = (hash[0] + a) & mask; hash[1] = (hash[1] + b) & mask; hash[2] = (hash[2] + c) & mask; hash[3] = (hash[3] + d) & mask;
        hash[4] = (hash[4] + e) & mask; hash[5] = (hash[5] + f) & mask; hash[6] = (hash[6] + g) & mask; hash[7] = (hash[7] + h) & mask;
      }
      return hash.map((number) => number.toString(16).padStart(8, "0")).join("");
    };
    if (location.pathname !== "${CHAT_PATH}") return fail("page_lost");
    if (typeof window.__bossMessageSnapshot !== "function") return fail("snapshot_helper_missing");
    const snapshot = window.__bossMessageSnapshot();
    if (snapshot.risk === true) return fail("risk_control");
    if (snapshot.login === true) return fail("login_required");
    const rows = Array.from(document.querySelectorAll(".friend-content-warp"));
    const row = rows[expected.rowIndex];
    if (!row || !row.isConnected) return fail("row_drifted");
    const unread = Boolean(row.querySelector(".notice-badge"));
    if (!unread) return fail("no_longer_unread");
    const visible = lines(row.innerText);
    const rowTitle = normalize(row.querySelector(".title-box")?.textContent) || visible[0] || "";
    const preview = normalize(row.querySelector(".last-msg-text")?.textContent) || visible[visible.length - 1] || "";
    const actualSignature = "sha256:" + sha256(canonical([expected.rowIndex, rowTitle, preview, unread]));
    if (actualSignature !== expected.transientSignature) return fail("row_drifted");
    const conversationId = String(row.getAttribute("data-conversation-id") || row.getAttribute("data-encid") || "").trim();
    const actualConversationKey = "sha256:" + sha256(canonical(["conversation", conversationId ? "id:" + conversationId : "label:" + rowTitle]));
    if (actualConversationKey !== expected.conversationKey) return fail("row_drifted");
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
    && selected[0].conversationKey === target.conversationKey
    && conversationSignature({ ...selected[0], unread: true }) === target.transientSignature
    && Boolean(snapshot.headerText)
    && Boolean(snapshot.positionName)
    && snapshot.messages.length > 0
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
  let activeTabId = null;
  let activeTargets = new Set();
  let readerBusy = false;
  async function runExclusive(operation) {
    if (readerBusy) throw codedError("BOSS_MESSAGE_READER_BUSY", "message reader is busy");
    readerBusy = true;
    try {
      return await operation();
    } finally {
      readerBusy = false;
    }
  }
  return {
    async scanUnread() {
      return runExclusive(async () => {
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
        activeTabId = tabId;
        activeTargets = new Set(queue);
        return { tabId, queue };
      });
    },
    async openQueuedConversation(target, signal) {
      return runExclusive(async () => {
        if (!activeTargets.has(target) || target?.tabId !== activeTabId) {
          throw codedError("BOSS_MESSAGE_TARGET_INVALID", "message target is not from the active unread queue");
        }
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
      });
    }
  };
}

module.exports = {
  buildGuardedConversationClickExpression,
  createBossMessageReader
};
