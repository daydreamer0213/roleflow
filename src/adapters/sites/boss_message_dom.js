const crypto = require("node:crypto");

const SELECTORS = Object.freeze({
  row: ".friend-content-warp", unread: ".notice-badge", selected: ".selected, .friend-top",
  header: ".top-info-content", position: ".chat-position-content .position-name", company: ".company-name",
  salary: ".salary", city: ".city", message: ".message-item",
  editor: ".chat-input", send: ".btn-send"
});

function canonicalParts(parts) {
  return parts.map((item) => String(item == null ? "" : item).trim()).join("\0");
}

function safeDigest(parts) {
  return `sha256:${crypto.createHash("sha256").update(canonicalParts(parts), "utf8").digest("hex")}`;
}

function messageKey({ platform, threadKey, messageId }) {
  if (!/^\d{15}$/.test(String(messageId == null ? "" : messageId))) {
    throw codedError("BOSS_MESSAGE_ID_INVALID", "message id is invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(threadKey == null ? "" : threadKey))) {
    throw codedError("BOSS_MESSAGE_THREAD_INVALID", "thread digest is invalid");
  }
  return safeDigest([platform, threadKey, messageId]);
}

function normalizedText(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function visibleLines(value) {
  return String(value == null ? "" : value).split(/\r?\n/).map(normalizedText).filter(Boolean);
}

function recruiterKey(row, label) {
  const id = String(row.getAttribute?.("data-recruiter-id") || row.getAttribute?.("data-geek-id") || "").trim();
  return safeDigest(["recruiter", id ? `id:${id}` : `label:${normalizedText(label)}`]);
}

function conversationKey(row, label) {
  const id = String(row.getAttribute?.("data-conversation-id") || row.getAttribute?.("data-encid") || "").trim();
  return safeDigest(["conversation", id ? `id:${id}` : `label:${normalizedText(label)}`]);
}

function previewKind(value) {
  const text = normalizedText(value);
  if (/^\[送达\]/.test(text)) return "self_delivered";
  if (/^\[已读\]/.test(text)) return "self_read";
  if (/对方已同意|附件简历已发送|已投递成功/.test(text)) return "platform_notice";
  if (/\[语音\]|\[图片\]|\[文件\]/.test(text)) return "unsupported";
  return text ? "possible_hr_reply" : "unknown";
}

function messageContentKind(item) {
  if (item.matches(".item-voice")) return "voice";
  if (item.matches(".item-image")) return "image";
  if (item.matches(".item-attachment")) return "attachment";
  return "text";
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readExistingBossRiskSignal(documentLike, path, search) {
  const bodyText = normalizedText(documentLike.body.innerText).slice(0, 3000);
  return /\/web\/passport\/zp\/(?:verify|403)/i.test(path)
    || new URLSearchParams(search).get("code") === "32"
    || /\u5b89\u5168\u9a8c\u8bc1|\u8bbf\u95ee\u5f02\u5e38|\u884c\u4e3a\u9a8c\u8bc1|\u8bbf\u95ee\u53d7\u9650/.test(documentLike.title || "")
    || /\u8d26\u6237\u5b58\u5728\u5f02\u5e38\u884c\u4e3a|\u6682\u65f6\u65e0\u6cd5\u8bbf\u95ee\u6b64\u9875\u9762|\u8bf7\u52ff\u9891\u7e41\u63d0\u4ea4\u5237\u65b0\u8bf7\u6c42/.test(bodyText);
}

function readExistingBossLoginSignal(documentLike, path) {
  const bodyText = normalizedText(documentLike.body.innerText).slice(0, 3000);
  const loginForm = [...documentLike.querySelectorAll(".sign-form, .login-register, [class*='login-form']")].some(isVisible);
  return /\/web\/user\//i.test(path)
    || loginForm
    || /\u6ca1\u6709\u66f4\u591a\u804c\u4f4d.{0,20}\u767b\u5f55\u67e5\u770b\u5168\u90e8\u804c\u4f4d|\u767b\u5f55\u540e\u53ef\u67e5\u770b/.test(bodyText);
}

function isVisible(element) {
  if (!element?.getBoundingClientRect) return Boolean(element);
  const rect = element.getBoundingClientRect();
  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  return rect.width > 0 && rect.height > 0 && style?.display !== "none" && style?.visibility !== "hidden";
}

function transientSignature(row) {
  return safeDigest([row.rowIndex, row.recruiterLabel, row.previewText, row.unread]);
}

function snapshotBossMessagePage(documentLike, locationHref) {
  const url = new URL(locationHref);
  const path = url.pathname;
  if (path !== "/web/geek/chat") throw codedError("BOSS_MESSAGE_PAGE_LOST", "fixed BOSS message page is not available");
  try {
    if (!documentLike?.body || typeof documentLike.querySelector !== "function" || typeof documentLike.querySelectorAll !== "function") {
      throw codedError("BOSS_MESSAGE_STRUCTURE_CHANGED", "message document is invalid");
    }
    const rows = [...documentLike.querySelectorAll(SELECTORS.row)].map((row, rowIndex) => {
      const lines = visibleLines(row.innerText);
      const snapshotRow = {
        rowIndex,
        unread: Boolean(row.querySelector(SELECTORS.unread)),
        selected: row.matches(SELECTORS.selected) || Boolean(row.querySelector(SELECTORS.selected)),
        recruiterLabel: lines[0] || "",
        previewText: lines.at(-1) || "",
        recruiterKey: recruiterKey(row, lines[0] || ""),
        conversationKey: conversationKey(row, lines[0] || ""),
        previewDigest: safeDigest(["preview", lines.at(-1) || ""]),
        previewKind: previewKind(lines.at(-1) || "")
      };
      return { ...snapshotRow, transientSignature: transientSignature(snapshotRow) };
    });
    const messages = [...documentLike.querySelectorAll(SELECTORS.message)].map((item) => {
      const messageId = String(item.getAttribute("data-mid") == null ? "" : item.getAttribute("data-mid"));
      if (!/^\d{15}$/.test(messageId)) throw codedError("BOSS_MESSAGE_ID_INVALID", "message id is invalid");
      return {
        direction: item.matches(".item-friend") ? "friend" : item.matches(".item-myself") ? "myself" : "system",
        messageId,
        text: normalizedText(item.textContent),
        contentKind: messageContentKind(item)
      };
    });
    return {
      path,
      rows,
      headerText: visibleLines(documentLike.querySelector(SELECTORS.header)?.innerText)[0] || "",
      positionName: normalizedText(documentLike.querySelector(SELECTORS.position)?.textContent),
      companyName: normalizedText(documentLike.querySelector(SELECTORS.company)?.textContent),
      salary: normalizedText(documentLike.querySelector(SELECTORS.salary)?.textContent),
      city: normalizedText(documentLike.querySelector(SELECTORS.city)?.textContent),
      risk: readExistingBossRiskSignal(documentLike, path, url.search),
      login: readExistingBossLoginSignal(documentLike, path),
      messages,
      writeTargetsPresent: { editor: Boolean(documentLike.querySelector(SELECTORS.editor)), send: Boolean(documentLike.querySelector(SELECTORS.send)) }
    };
  } catch (error) {
    if (error?.code === "BOSS_MESSAGE_ID_INVALID" || error?.code === "BOSS_MESSAGE_STRUCTURE_CHANGED") throw error;
    throw codedError("BOSS_MESSAGE_STRUCTURE_CHANGED", "message page structure changed");
  }
}

function buildUnreadConversationQueue(snapshot) {
  return Object.freeze((snapshot?.rows || []).filter((row) => row.unread === true)
    .map((row) => Object.freeze({
      rowIndex: row.rowIndex,
      transientSignature: transientSignature(row),
      conversationKey: row.conversationKey
    })));
}

const BOSS_MESSAGE_PAGE_HELPERS_EXPRESSION = String.raw`(() => {
  const selectors = { row: ".friend-content-warp", unread: ".notice-badge", selected: ".selected, .friend-top", header: ".top-info-content", position: ".chat-position-content .position-name", company: ".company-name", salary: ".salary", city: ".city", message: ".message-item", editor: ".chat-input", send: ".btn-send" };
  const coded = (code, message) => { const error = new Error(message); error.code = code; return error; };
  const text = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  const lines = (value) => String(value == null ? "" : value).split(/\r?\n/).map(text).filter(Boolean);
  const canonical = (parts) => parts.map((item) => String(item == null ? "" : item).trim()).join("\0");
  const sha256 = (value) => {
    const mask = 0xffffffffn, word = (number) => BigInt.asUintN(32, BigInt(number)), rotateRight = (number, amount) => ((number >> BigInt(amount)) | (number << BigInt(32 - amount))) & mask;
    const constants = [1116352408, 1899447441, -1245643825, -373957723, 961987163, 1508970993, -1841331548, -1424204075, -670586216, 310598401, 607225278, 1426881987, 1925078388, -2132889090, -1680079193, -1046744716, -459576895, -272742522, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, -1740746414, -1473132947, -1341970488, -1084653625, -958395405, -710438585, 113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, -2117940946, -1838011259, -1564481375, -1474664885, -1035236496, -949202525, -778901479, -694614492, -200395387, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474, -1538233109, -1090935817, -965641998].map(word);
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
  const rowKey = (prefix, names, row, label) => { const id = String(names.map((name) => row.getAttribute(name)).find((value) => value != null && String(value).trim()) || "").trim(); return "sha256:" + sha256(canonical([prefix, id ? "id:" + id : "label:" + text(label)])); }; const recruiterKey = (row, label) => rowKey("recruiter", ["data-recruiter-id", "data-geek-id"], row, label); const conversationKey = (row, label) => rowKey("conversation", ["data-conversation-id", "data-encid"], row, label); const previewKind = (value) => { const textValue = text(value); if (/^\[送达\]/.test(textValue)) return "self_delivered"; if (/^\[已读\]/.test(textValue)) return "self_read"; if (/对方已同意|附件简历已发送|已投递成功/.test(textValue)) return "platform_notice"; if (/\[语音\]|\[图片\]|\[文件\]/.test(textValue)) return "unsupported"; return textValue ? "possible_hr_reply" : "unknown"; }; const contentKind = (item) => { if (item.matches(".item-voice")) return "voice"; if (item.matches(".item-image")) return "image"; if (item.matches(".item-attachment")) return "attachment"; return "text"; }; const signature = (row) => "sha256:" + sha256(canonical([row.rowIndex, row.recruiterLabel, row.previewText, row.unread]));
  const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"; };
  window.__bossMessageSnapshot = function() {
    const path = location.pathname;
    if (path !== "/web/geek/chat") return { state: "snapshot_helper_missing" };
    try {
      const bodyText = text(document.body.innerText).slice(0, 3000);
      const risk = /\/web\/passport\/zp\/(?:verify|403)/i.test(path) || new URLSearchParams(location.search).get("code") === "32" || /\u5b89\u5168\u9a8c\u8bc1|\u8bbf\u95ee\u5f02\u5e38|\u884c\u4e3a\u9a8c\u8bc1|\u8bbf\u95ee\u53d7\u9650/.test(document.title || "") || /\u8d26\u6237\u5b58\u5728\u5f02\u5e38\u884c\u4e3a|\u6682\u65f6\u65e0\u6cd5\u8bbf\u95ee\u6b64\u9875\u9762|\u8bf7\u52ff\u9891\u7e41\u63d0\u4ea4\u5237\u65b0\u8bf7\u6c42/.test(bodyText);
      const login = /\/web\/user\//i.test(path) || Array.from(document.querySelectorAll(".sign-form, .login-register, [class*='login-form']")).some(visible) || /\u6ca1\u6709\u66f4\u591a\u804c\u4f4d.{0,20}\u767b\u5f55\u67e5\u770b\u5168\u90e8\u804c\u4f4d|\u767b\u5f55\u540e\u53ef\u67e5\u770b/.test(bodyText);
      const rows = Array.from(document.querySelectorAll(selectors.row)).map((row, rowIndex) => { const rowLines = lines(row.innerText); const value = { rowIndex, unread: Boolean(row.querySelector(selectors.unread)), selected: row.matches(selectors.selected) || Boolean(row.querySelector(selectors.selected)), recruiterLabel: rowLines[0] || "", previewText: rowLines.at(-1) || "", recruiterKey: recruiterKey(row, rowLines[0] || ""), conversationKey: conversationKey(row, rowLines[0] || ""), previewDigest: "sha256:" + sha256(canonical(["preview", rowLines.at(-1) || ""])), previewKind: previewKind(rowLines.at(-1) || "") }; return { ...value, transientSignature: signature(value) }; });
      const messages = Array.from(document.querySelectorAll(selectors.message)).map((item) => { const messageId = String(item.getAttribute("data-mid") == null ? "" : item.getAttribute("data-mid")); if (!/^\d{15}$/.test(messageId)) throw coded("BOSS_MESSAGE_ID_INVALID", "message id is invalid"); return { direction: item.matches(".item-friend") ? "friend" : item.matches(".item-myself") ? "myself" : "system", messageId, text: text(item.textContent), contentKind: contentKind(item) }; });
      return { path, rows, headerText: lines(document.querySelector(selectors.header)?.innerText)[0] || "", positionName: text(document.querySelector(selectors.position)?.textContent), companyName: text(document.querySelector(selectors.company)?.textContent), salary: text(document.querySelector(selectors.salary)?.textContent), city: text(document.querySelector(selectors.city)?.textContent), risk, login, messages, writeTargetsPresent: { editor: Boolean(document.querySelector(selectors.editor)), send: Boolean(document.querySelector(selectors.send)) } };
    } catch (error) {
      if (error && (error.code === "BOSS_MESSAGE_ID_INVALID" || error.code === "BOSS_MESSAGE_STRUCTURE_CHANGED")) throw error;
      throw coded("BOSS_MESSAGE_STRUCTURE_CHANGED", "message page structure changed");
    }
  };
})()`;

const BOSS_MESSAGE_SNAPSHOT_EXPRESSION = String.raw`(() => {
  if (!window.__bossMessageSnapshot) ${BOSS_MESSAGE_PAGE_HELPERS_EXPRESSION}
  return window.__bossMessageSnapshot ? window.__bossMessageSnapshot() : { state: "snapshot_helper_missing" };
})()`;

module.exports = { snapshotBossMessagePage, buildUnreadConversationQueue, safeDigest, messageKey, BOSS_MESSAGE_PAGE_HELPERS_EXPRESSION, BOSS_MESSAGE_SNAPSHOT_EXPRESSION };
