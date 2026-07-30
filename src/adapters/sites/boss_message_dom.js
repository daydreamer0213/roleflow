const crypto = require("node:crypto");

const SELECTORS = Object.freeze({
  row: ".friend-content-warp",
  unread: ".notice-badge",
  selected: ".selected, .friend-top",
  header: ".top-info-content",
  position: ".chat-position-content .position-name",
  salary: ".salary",
  city: ".city",
  message: ".message-item",
  editor: ".chat-input",
  send: ".btn-send"
});

function safeDigest(parts) {
  const value = parts.map((item) => String(item || "").trim()).join("\0");
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function messageKey({ platform, threadKey, messageId }) {
  if (!/^\d{15}$/.test(String(messageId || ""))) {
    throw codedError("BOSS_MESSAGE_ID_INVALID", "message id is invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(threadKey || ""))) {
    throw codedError("BOSS_MESSAGE_THREAD_INVALID", "thread digest is invalid");
  }
  return safeDigest([platform, threadKey, messageId]);
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function visibleLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map(normalizedText)
    .filter(Boolean);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readExistingBossRiskSignal(documentLike, path) {
  const bodyText = normalizedText(documentLike.body?.innerText).slice(0, 3000);
  return /\/web\/passport\/zp\/(?:verify|403)/i.test(path)
    || /\?[^#]*\bcode=32(?:&|$)/i.test(String(documentLike.location?.search || ""))
    || /安全验证|访问异常|行为验证|访问受限/.test(documentLike.title || "")
    || /账户存在异常行为|暂时无法访问此页面|请勿频繁提交刷新请求/.test(bodyText);
}

function readExistingBossLoginSignal(documentLike, path) {
  const bodyText = normalizedText(documentLike.body?.innerText).slice(0, 3000);
  const loginForm = [...documentLike.querySelectorAll(".sign-form, .login-register, [class*='login-form']")]
    .some(isVisible);
  return /\/web\/user\//i.test(path)
    || loginForm
    || /没有更多职位.{0,20}登录查看全部职位|登录后可查看/.test(bodyText);
}

function isVisible(element) {
  if (!element?.getBoundingClientRect) return Boolean(element);
  const rect = element.getBoundingClientRect();
  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  return rect.width > 0 && rect.height > 0 && style?.display !== "none" && style?.visibility !== "hidden";
}

function snapshotBossMessagePage(documentLike, locationHref) {
  const url = new URL(locationHref);
  const path = url.pathname;
  if (path !== "/web/geek/chat") {
    throw codedError("BOSS_MESSAGE_PAGE_LOST", "fixed BOSS message page is not available");
  }
  const rows = [...documentLike.querySelectorAll(SELECTORS.row)].map((row, rowIndex) => ({
    rowIndex,
    unread: Boolean(row.querySelector(SELECTORS.unread)),
    selected: row.matches(SELECTORS.selected) || Boolean(row.querySelector(SELECTORS.selected)),
    recruiterLabel: visibleLines(row.innerText)[0] || "",
    previewText: visibleLines(row.innerText).at(-1) || ""
  }));
  const messages = [...documentLike.querySelectorAll(SELECTORS.message)].map((item) => ({
    direction: item.matches(".item-friend") ? "friend" : item.matches(".item-myself") ? "myself" : "system",
    messageId: String(item.getAttribute("data-mid") || ""),
    text: normalizedText(item.textContent)
  }));
  return {
    path,
    rows,
    headerText: visibleLines(documentLike.querySelector(SELECTORS.header)?.innerText)[0] || "",
    positionName: normalizedText(documentLike.querySelector(SELECTORS.position)?.textContent),
    salary: normalizedText(documentLike.querySelector(SELECTORS.salary)?.textContent),
    city: normalizedText(documentLike.querySelector(SELECTORS.city)?.textContent),
    risk: readExistingBossRiskSignal(documentLike, `${path}${url.search}`),
    login: readExistingBossLoginSignal(documentLike, path),
    messages,
    writeTargetsPresent: {
      editor: Boolean(documentLike.querySelector(SELECTORS.editor)),
      send: Boolean(documentLike.querySelector(SELECTORS.send))
    }
  };
}

function transientSignature(row) {
  return safeDigest([row.rowIndex, row.recruiterLabel, row.previewText, row.unread]);
}

function buildUnreadConversationQueue(snapshot) {
  return Object.freeze((snapshot?.rows || [])
    .filter((row) => row.unread === true)
    .map((row) => Object.freeze({ rowIndex: row.rowIndex, transientSignature: transientSignature(row) })));
}

const BOSS_MESSAGE_PAGE_HELPERS_EXPRESSION = String.raw`(() => {
  const selectors = { row: ".friend-content-warp", unread: ".notice-badge", selected: ".selected, .friend-top", header: ".top-info-content", position: ".chat-position-content .position-name", salary: ".salary", city: ".city", message: ".message-item", editor: ".chat-input", send: ".btn-send" };
  const text = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const lines = (value) => String(value || "").split(/\r?\n/).map(text).filter(Boolean);
  const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"; };
  window.__bossMessageSnapshot = function() {
    const path = location.pathname;
    if (path !== "/web/geek/chat") return { state: "snapshot_helper_missing" };
    const bodyText = text(document.body?.innerText).slice(0, 3000);
    const risk = /\/web\/passport\/zp\/(?:verify|403)/i.test(path)
      || new URLSearchParams(location.search).get("code") === "32"
      || /安全验证|访问异常|行为验证|访问受限/.test(document.title || "")
      || /账户存在异常行为|暂时无法访问此页面|请勿频繁提交刷新请求/.test(bodyText);
    const login = /\/web\/user\//i.test(path)
      || Array.from(document.querySelectorAll(".sign-form, .login-register, [class*='login-form']")).some(visible)
      || /没有更多职位.{0,20}登录查看全部职位|登录后可查看/.test(bodyText);
    const rows = Array.from(document.querySelectorAll(selectors.row)).map((row, rowIndex) => ({ rowIndex, unread: Boolean(row.querySelector(selectors.unread)), selected: row.matches(selectors.selected) || Boolean(row.querySelector(selectors.selected)), recruiterLabel: lines(row.innerText)[0] || "", previewText: lines(row.innerText).at(-1) || "" }));
    const messages = Array.from(document.querySelectorAll(selectors.message)).map((item) => ({ direction: item.matches(".item-friend") ? "friend" : item.matches(".item-myself") ? "myself" : "system", messageId: String(item.getAttribute("data-mid") || ""), text: text(item.textContent) }));
    return { path, rows, headerText: lines(document.querySelector(selectors.header)?.innerText)[0] || "", positionName: text(document.querySelector(selectors.position)?.textContent), salary: text(document.querySelector(selectors.salary)?.textContent), city: text(document.querySelector(selectors.city)?.textContent), risk, login, messages, writeTargetsPresent: { editor: Boolean(document.querySelector(selectors.editor)), send: Boolean(document.querySelector(selectors.send)) } };
  };
})()`;

const BOSS_MESSAGE_SNAPSHOT_EXPRESSION = String.raw`(() => {
  if (!window.__bossMessageSnapshot) ${BOSS_MESSAGE_PAGE_HELPERS_EXPRESSION}
  return window.__bossMessageSnapshot ? window.__bossMessageSnapshot() : { state: "snapshot_helper_missing" };
})()`;

module.exports = {
  snapshotBossMessagePage,
  buildUnreadConversationQueue,
  safeDigest,
  messageKey,
  BOSS_MESSAGE_PAGE_HELPERS_EXPRESSION,
  BOSS_MESSAGE_SNAPSHOT_EXPRESSION
};
