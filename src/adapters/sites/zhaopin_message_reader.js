const { safeDigest } = require("./boss_message_dom");
const { isBrowserTabId } = require("../../core/browser_tab_identity");

function isZhaopinMessageUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://i.zhaopin.com" && url.pathname === "/im";
  } catch { return false; }
}

function isVisibleZhaopinLoginChallenge(node) {
  if (!node || node.hidden || node.getAttribute?.("aria-hidden") === "true" || node.getClientRects?.().length === 0) return false;
  const style = getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const ordinaryHeaderLink = node.matches?.("a.home-header__b-login, a.home-header__c-no-login")
    && node.parentElement?.matches?.(".home-header__right");
  const ordinaryAccountHeader = node.closest?.(".home-header__c-login");
  const ordinaryHomeAccountNode = ordinaryAccountHeader?.parentElement?.matches?.(".home-header__right") && (
    node === ordinaryAccountHeader
    || node.matches?.(".home-header__c-login, .c-login__top, .c-login__name, .c-login__photo, .c-login__img, .c-login__top__name, .c-login__top__photo, .c-login__top__img, .c-login__ul")
  );
  const detailHeader = node.closest?.(".header-nav__login");
  const ordinaryDetailHeaderNode = detailHeader?.parentElement?.matches?.(".header-nav__main") && (
    node === detailHeader
    || node.matches?.("a.header-nav__b-login, .header-nav__c-login, .c-login__top, .c-login__name, .c-login__photo, .c-login__img, .c-login__top__name, .c-login__top__photo, .c-login__top__img")
  );
  return !(ordinaryHeaderLink || ordinaryHomeAccountNode || ordinaryDetailHeaderNode);
}

const ZHAOPIN_MESSAGE_SNAPSHOT_EXPRESSION = String.raw`(() => {
  const isZhaopinMessageUrl = ${isZhaopinMessageUrl.toString()};
  const isVisibleZhaopinLoginChallenge = ${isVisibleZhaopinLoginChallenge.toString()};
  const text = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  const numeric = (value) => /^\d+$/.test(String(value == null ? "" : value).trim());
  const failed = (state) => ({ state });
  try {
    if (!isZhaopinMessageUrl(location.href)) return failed("page_lost");
    const bodyText = text(document.body?.innerText).slice(0, 3000);
    if (/安全验证|访问异常|行为验证|访问受限/.test(text(document.title)) || /安全验证|访问异常|行为验证|访问受限/.test(bodyText)) return failed("risk_control");
    if (Array.from(document.querySelectorAll(".login, .login-panel, [class*='login']")).some(isVisibleZhaopinLoginChallenge)) return failed("login_required");
    const side = document.querySelector(".im-side-panel");
    const main = document.querySelector(".im-main-panel");
    const header = document.querySelector(".im-chat-header");
    const sideVm = side?.__vue__;
    const mainVm = main?.__vue__;
    if (sideVm?.$options?.name !== "SidePanelThreeColumns" || !Array.isArray(sideVm.sessions)
      || mainVm?.$options?.name !== "MainPanelThreeColumns" || !Array.isArray(mainVm.activeTimeline)
      || !header?.__vue__?.$props?.session) return failed("structure_changed");
    const rows = Array.from(document.querySelectorAll(".im-session-item")).map((node, rowIndex) => {
      const vm = node.__vue__;
      const item = vm?.$options?.name === "ImSessionItem" ? vm.$props?.session : null;
      if (!item) return null;
      return {
        rowIndex,
        selected: node.classList.contains("is-active"),
        sessionId: String(item.sessionId == null ? "" : item.sessionId),
        jobNumber: String(item.jobNumber == null ? "" : item.jobNumber),
        peerPartnerId: numeric(item.peerPartnerId) ? String(item.peerPartnerId) : "",
        senderId: numeric(item.senderId) ? String(item.senderId) : "",
        userId: numeric(item.userId) ? String(item.userId) : "",
        unreadCount: numeric(item.unreadCount) ? Number(item.unreadCount) : 0,
        unreadBadge: text(node.querySelector(".im-session-item__badge")?.textContent),
        previewText: text(node.querySelector(".im-session-item__preview-text")?.textContent),
        positionName: text(node.querySelector(".im-session-item__job")?.textContent),
        companyName: text(node.querySelector(".im-session-item__company-name")?.textContent),
        salary: text(node.querySelector(".im-session-item__salary")?.textContent)
      };
    });
    if (rows.some((row) => !row)) return failed("structure_changed");
    const messages = Array.from(document.querySelectorAll(".im-message")).flatMap((node) => {
      const vm = node.__vue__;
      if (vm?.$options?.name !== "ImMessageRow") return [];
      const msg = vm.$props?.msg;
      const session = vm.$props?.session;
      if (!msg || !session) return [{ invalid: true }];
      return [{
        sessionId: String(session.sessionId == null ? "" : session.sessionId),
        jobNumber: String(session.jobNumber == null ? "" : session.jobNumber),
        idServer: String(msg.idServer == null ? "" : msg.idServer),
        flow: String(msg.flow == null ? "" : msg.flow),
        fromMe: typeof msg.fromMe === "boolean" ? msg.fromMe : null,
        from: numeric(msg.from) ? String(msg.from) : "",
        type: String(msg.type == null ? "" : msg.type),
        cardType: String(msg.cardType == null ? "" : msg.cardType),
        body: typeof msg.body === "string" ? msg.body : "",
        hasText: Boolean(node.querySelector(".im-msg-text")),
        text: node.querySelector(".im-msg-text")?.textContent ?? "",
        hasRichText: Boolean(node.querySelector(".im-msg-rich")),
        richText: node.querySelector(".im-msg-rich")?.textContent ?? "",
        resumeTitle: text(node.querySelector(".im-msg-11-wrap")?.textContent),
        resumeRefuse: text(node.querySelector(".im-msg-11__btn--refuse")?.textContent),
        resumeAgree: text(node.querySelector(".im-msg-11__btn--agree")?.textContent),
        tip: node.classList.contains("im-message--tip"),
        hasFallback: Boolean(node.querySelector(".im-msg-255-fallback")),
        fallbackText: node.querySelector(".im-msg-255-fallback")?.textContent ?? ""
      }];
    });
    const active = mainVm.activeSession;
    return {
      state: "ready",
      listLoading: sideVm.listLoading === true,
      listError: text(sideVm.listError),
      rows,
      activeSessionId: String(mainVm.activeSessionId == null ? "" : mainVm.activeSessionId),
      activeSessionIdFromObject: String(active?.sessionId == null ? "" : active.sessionId),
      activeJobNumber: String(active?.jobNumber == null ? "" : active.jobNumber),
      headerSessionId: String(header.__vue__.$props.session?.sessionId == null ? "" : header.__vue__.$props.session.sessionId),
      headerJobNumber: String(header.__vue__.$props.session?.jobNumber == null ? "" : header.__vue__.$props.session.jobNumber),
      jobDetailHref: String(header.querySelector(".im-chat-header__detail")?.href || ""),
      jobOffline: header.classList.contains("is-offline") || Boolean(header.querySelector(".is-offline")),
      positionName: text(header.querySelector(".im-chat-header__job-title")?.textContent),
      salary: text(header.querySelector(".im-chat-header__salary")?.textContent),
      city: text(header.querySelector(".im-chat-header__city")?.textContent),
      timelineLoading: mainVm.timelineLoading === true,
      timelineError: text(mainVm.timelineError),
      messages
    };
  } catch {
    return failed("structure_changed");
  }
})()`;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function text(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function numericId(value) {
  const normalized = String(value == null ? "" : value).trim();
  return /^\d+$/.test(normalized) ? normalized : "";
}

function validSessionId(value) {
  return /^[a-f0-9]{32}$/i.test(String(value || ""));
}

function validJobNumber(value) {
  return /^[A-Za-z0-9]+$/.test(String(value || ""));
}

function validMessageId(value) {
  return /^\d{1,32}$/.test(String(value || ""));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw codedError("ZHAOPIN_MESSAGE_ABORTED", "zhaopin message read was cancelled");
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    function onAbort() {
      clearTimeout(timer);
      cleanup();
      reject(codedError("ZHAOPIN_MESSAGE_ABORTED", "zhaopin message read was cancelled"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function assertBrowser(browser) {
  for (const name of ["listTabs", "evalValue", "setPageLifecycleActive"]) {
    if (typeof browser?.[name] !== "function") throw codedError("ZHAOPIN_MESSAGE_BROWSER_INVALID", `browser.${name} is required`);
  }
}

function resolveMessageTab(tabs) {
  const matches = (tabs || []).filter((tab) => isZhaopinMessageUrl(tab?.url));
  if (!matches.length) throw codedError("ZHAOPIN_MESSAGE_TAB_MISSING", "zhaopin message tab is missing");
  if (matches.length !== 1) throw codedError("ZHAOPIN_MESSAGE_TAB_AMBIGUOUS", "zhaopin message tab is ambiguous");
  const tab = matches[0];
  if (!isBrowserTabId(tab.id) || !Number.isInteger(tab.windowId) || tab.windowId <= 0) {
    throw codedError("ZHAOPIN_MESSAGE_TAB_INVALID", "zhaopin message tab binding is invalid");
  }
  return { tabId: tab.id, windowId: tab.windowId };
}

function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw codedError("ZHAOPIN_MESSAGE_STRUCTURE_CHANGED", "zhaopin message structure changed");
  const failure = {
    page_lost: ["ZHAOPIN_MESSAGE_PAGE_LOST", "zhaopin message page changed"],
    risk_control: ["ZHAOPIN_MESSAGE_RISK_CONTROL", "zhaopin requires security verification"],
    login_required: ["ZHAOPIN_MESSAGE_LOGIN_REQUIRED", "zhaopin login is required"],
    structure_changed: ["ZHAOPIN_MESSAGE_STRUCTURE_CHANGED", "zhaopin message structure changed"]
  }[raw.state];
  if (failure) throw codedError(...failure);
  if (raw.state !== "ready" || !Array.isArray(raw.rows) || !Array.isArray(raw.messages)) {
    throw codedError("ZHAOPIN_MESSAGE_STRUCTURE_CHANGED", "zhaopin message structure changed");
  }
  return raw;
}

function rowFromSnapshot(raw, row) {
  if (!row || typeof row !== "object" || !Number.isInteger(row.rowIndex)) {
    throw codedError("ZHAOPIN_MESSAGE_STRUCTURE_CHANGED", "zhaopin message row changed");
  }
  const sessionId = String(row.sessionId || "");
  const jobNumber = String(row.jobNumber || "");
  const peerPartnerId = numericId(row.peerPartnerId);
  const senderId = numericId(row.senderId);
  const identityVerified = validSessionId(sessionId) && validJobNumber(jobNumber) && Boolean(peerPartnerId);
  const incoming = Boolean(peerPartnerId && senderId && peerPartnerId === senderId);
  const previewText = text(row.previewText);
  return {
    rowIndex: row.rowIndex,
    conversationKey: safeDigest(["zhaopin", sessionId]),
    previewDigest: safeDigest(["zhaopin", "preview", previewText]),
    previewKind: previewText ? "possible_hr_reply" : "unknown",
    unread: Number(row.unreadCount) > 0 || Boolean(text(row.unreadBadge)),
    identityVerified,
    friendKey: peerPartnerId ? safeDigest(["zhaopin", "friend", peerPartnerId]) : "",
    sourceJobId: validJobNumber(jobNumber) ? `zhaopin:${jobNumber}` : "",
    lastMessageDirection: incoming ? "friend" : "unknown",
    lastMessageStatus: "unknown",
    lastMessageId: "",
    _raw: { sessionId, jobNumber, previewText, peerPartnerId, userId: numericId(row.userId), positionName: text(row.positionName), companyName: text(row.companyName), salary: text(row.salary), city: text(raw.city) }
  };
}

function publicRow(row) {
  const { _raw, ...safe } = row;
  return Object.freeze(safe);
}

function targetKey(tabId, target) {
  return `${tabId}:${target.rowIndex}:${target.conversationKey}`;
}

function buildSelectionExpression(target) {
  const expected = JSON.stringify({ sessionId: target.sessionId, jobNumber: target.jobNumber, previewText: target.previewText });
  return String.raw`(() => {
    const expected = ${expected};
    const isZhaopinMessageUrl = ${isZhaopinMessageUrl.toString()};
    const isVisibleZhaopinLoginChallenge = ${isVisibleZhaopinLoginChallenge.toString()};
    const text = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    const fail = (reason) => ({ clicked: false, reason });
    if (!isZhaopinMessageUrl(location.href)) return fail("page_lost");
    const bodyText = text(document.body?.innerText).slice(0, 3000);
    if (/安全验证|访问异常|行为验证|访问受限/.test(text(document.title)) || /安全验证|访问异常|行为验证|访问受限/.test(bodyText)) return fail("risk_control");
    if (Array.from(document.querySelectorAll(".login, .login-panel, [class*='login']")).some(isVisibleZhaopinLoginChallenge)) return fail("login_required");
    const rows = [...document.querySelectorAll('.im-session-item')];
    const row = rows.find(el => el.__vue__?.$props?.session?.sessionId === expected.sessionId);
    const session = row?.__vue__?.$props?.session;
    if (!row || !session || String(session.jobNumber || "") !== expected.jobNumber) return fail("target_mismatch");
    if (text(row.querySelector('.im-session-item__preview-text')?.textContent) !== expected.previewText) return fail("preview_drifted");
    row.click();
    return { clicked: true };
  })()`;
}

function guardedSelectionError(reason) {
  const code = {
    page_lost: "ZHAOPIN_MESSAGE_PAGE_LOST",
    risk_control: "ZHAOPIN_MESSAGE_RISK_CONTROL",
    login_required: "ZHAOPIN_MESSAGE_LOGIN_REQUIRED",
    preview_drifted: "ZHAOPIN_MESSAGE_PREVIEW_DRIFTED",
    target_mismatch: "ZHAOPIN_MESSAGE_TARGET_MISMATCH"
  }[reason] || "ZHAOPIN_MESSAGE_STRUCTURE_CHANGED";
  return codedError(code, "zhaopin message selection stopped");
}

function selectedIdentityMatches(snapshot, raw) {
  const selected = snapshot.rows.filter((row) => row?.selected === true);
  return selected.length === 1
    && selected[0].sessionId === raw.sessionId
    && selected[0].jobNumber === raw.jobNumber
    && snapshot.activeSessionId === raw.sessionId
    && snapshot.activeSessionIdFromObject === raw.sessionId
    && snapshot.activeJobNumber === raw.jobNumber
    && snapshot.headerSessionId === raw.sessionId
    && snapshot.headerJobNumber === raw.jobNumber;
}

function parseMessages(messages, raw) {
  let lastMessageId = "";
  const parsed = messages.map((item) => {
    if (item?.invalid === true || item?.sessionId !== raw.sessionId || item?.jobNumber !== raw.jobNumber) {
      throw codedError("ZHAOPIN_MESSAGE_TARGET_MISMATCH", "zhaopin message row belongs to another conversation");
    }
    const validId = validMessageId(item?.idServer);
    const messageId = validId ? String(item.idServer) : "";
    const platformNotice = item?.type === "custom" && item?.cardType === "255" && item?.tip === true && item?.hasFallback === true && typeof item?.fallbackText === "string";
    const direction = platformNotice ? "platform"
      : item?.flow === "in" && item?.fromMe === false && numericId(item?.from) === raw.peerPartnerId ? "friend"
        : item?.flow === "out" && item?.fromMe === true && numericId(item?.from) === raw.userId ? "myself" : "unknown";
    let contentKind = "unsupported";
    let messageText = "";
    if (validId && (direction !== "unknown" || platformNotice)) {
      if (item.type === "text" && item.hasText === true && typeof item.text === "string" && item.text === item.body) {
        contentKind = "text";
        messageText = text(item.text);
      } else if (item.type === "custom" && item.cardType === "131" && item.hasRichText === true && typeof item.richText === "string" && item.richText === item.body) {
        contentKind = "text";
        messageText = text(item.richText);
      } else if (item.type === "custom" && item.cardType === "11" && /简历/.test(item.resumeTitle || "") && item.resumeRefuse === "拒绝" && item.resumeAgree === "同意") {
        contentKind = "resume_request";
        messageText = "HR 邀请你发送简历";
      } else if (platformNotice) {
        contentKind = "platform_notice";
        messageText = text(item.fallbackText);
      }
    }
    if (["text", "resume_request", "platform_notice"].includes(contentKind)) lastMessageId = messageId;
    return { messageId, direction, contentKind, text: messageText };
  });
  return { messages: parsed, lastMessageId };
}

function hasZhaopinOutgoingTextSnapshot(snapshot, { sessionId, jobNumber } = {}) {
  snapshot = normalizeSnapshot(snapshot);
  sessionId = String(sessionId || "");
  jobNumber = String(jobNumber || "");
  if (!validSessionId(sessionId)
    || !validJobNumber(jobNumber)
    || snapshot.listLoading === true
    || text(snapshot.listError)
    || snapshot.timelineLoading === true
    || text(snapshot.timelineError)
    || !selectedIdentityMatches(snapshot, { sessionId, jobNumber })) return false;
  const selectedRow = snapshot.rows.find((row) => row?.selected === true);
  const normalizedRow = rowFromSnapshot(snapshot, selectedRow);
  if (!normalizedRow.identityVerified
    || normalizedRow._raw.sessionId !== sessionId
    || normalizedRow._raw.jobNumber !== jobNumber) return false;
  try {
    return parseMessages(snapshot.messages, normalizedRow._raw).messages.some((message) => message.direction === "myself"
      && message.contentKind === "text"
      && validMessageId(message.messageId)
      && Boolean(text(message.text)));
  } catch (error) {
    if (error?.code === "ZHAOPIN_MESSAGE_TARGET_MISMATCH") return false;
    throw error;
  }
}

function selectedResult(snapshot, target) {
  const selectedRow = snapshot.rows.find((row) => String(row.sessionId || "") === target.sessionId && String(row.jobNumber || "") === target.jobNumber);
  if (!selectedRow) throw codedError("ZHAOPIN_MESSAGE_TARGET_MISMATCH", "selected zhaopin row changed");
  const parsed = parseMessages(snapshot.messages, target);
  return Object.freeze({
    platform: "zhaopin",
    conversationKey: target.conversationKey,
    sourceJobId: target.sourceJobId,
    lastMessageId: parsed.lastMessageId,
    positionName: text(snapshot.positionName) || text(selectedRow.positionName),
    companyName: text(selectedRow.companyName),
    salary: text(snapshot.salary) || text(selectedRow.salary),
    city: text(snapshot.city),
    messages: Object.freeze(parsed.messages.map((item) => Object.freeze(item)))
  });
}

function selectedJobTarget(snapshot, target) {
  if (!selectedIdentityMatches(snapshot, target)) {
    throw codedError("ZHAOPIN_MESSAGE_TARGET_MISMATCH", "zhaopin selected conversation changed");
  }
  const jobId = String(target.jobNumber || "").trim();
  let navigation;
  try { navigation = new URL(String(snapshot.jobDetailHref || "")); }
  catch { throw codedError("ZHAOPIN_MESSAGE_JOB_TARGET_UNAVAILABLE", "selected zhaopin job target is unavailable"); }
  if (!validJobNumber(jobId)
    || navigation.origin !== "https://www.zhaopin.com"
    || ![`/jobdetail/${jobId}.htm`, `/jobdetail/${jobId}.html`].includes(navigation.pathname)
    || navigation.search || navigation.hash || navigation.username || navigation.password) {
    throw codedError("ZHAOPIN_MESSAGE_JOB_TARGET_UNAVAILABLE", "selected zhaopin job target is unavailable");
  }
  return Object.freeze({
    jobId,
    navigationUrl: navigation.toString(),
    canonicalUrl: `https://www.zhaopin.com/jobdetail/${jobId}.htm`,
    availability: snapshot.jobOffline === true ? "offline" : "unknown"
  });
}

function createZhaopinMessageReader({ browser, sleepFn = defaultSleep, nowFn = Date.now, timeoutMs = 120000, pollIntervalMs = 500 } = {}) {
  assertBrowser(browser);
  if (typeof sleepFn !== "function" || typeof nowFn !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw codedError("ZHAOPIN_MESSAGE_OPTIONS_INVALID", "zhaopin message reader options are invalid");
  }
  let binding = null;
  let targetMap = new Map();
  let activeSelectedResult = null;
  let activeSelectedTarget = null;
  let busy = false;

  async function exclusive(operation) {
    if (busy) throw codedError("ZHAOPIN_MESSAGE_READER_BUSY", "zhaopin message reader is busy");
    busy = true;
    try { return await operation(); } finally { busy = false; }
  }

  async function assertActiveBindings(signal) {
    if (!binding) throw codedError("ZHAOPIN_MESSAGE_TARGET_INVALID", "zhaopin message reader has no active binding");
    throwIfAborted(signal);
    const current = resolveMessageTab(await browser.listTabs());
    throwIfAborted(signal);
    if (current.tabId !== binding.tabId || current.windowId !== binding.windowId) {
      throw codedError("ZHAOPIN_MESSAGE_TAB_BINDING_LOST", "zhaopin message tab binding changed");
    }
    return current;
  }

  async function readSnapshot(tabId, signal) {
    throwIfAborted(signal);
    const snapshot = normalizeSnapshot(await browser.evalValue(tabId, ZHAOPIN_MESSAGE_SNAPSHOT_EXPRESSION));
    throwIfAborted(signal);
    return snapshot;
  }

  return {
    scanConversationRows(signal) {
      return exclusive(async () => {
        binding = null;
        targetMap = new Map();
        activeSelectedResult = null;
        activeSelectedTarget = null;
        throwIfAborted(signal);
        const next = resolveMessageTab(await browser.listTabs());
        throwIfAborted(signal);
        await browser.setPageLifecycleActive(next.tabId);
        throwIfAborted(signal);
        const confirmed = resolveMessageTab(await browser.listTabs());
        throwIfAborted(signal);
        if (confirmed.tabId !== next.tabId || confirmed.windowId !== next.windowId) {
          throw codedError("ZHAOPIN_MESSAGE_TAB_BINDING_LOST", "zhaopin message tab binding changed");
        }
        binding = next;
        const deadline = nowFn() + timeoutMs;
        let snapshot;
        while (true) {
          await assertActiveBindings(signal);
          snapshot = await readSnapshot(next.tabId, signal);
          if (snapshot.listError) throw codedError("ZHAOPIN_MESSAGE_LIST_FAILED", "zhaopin conversation list failed");
          if (!snapshot.listLoading) break;
          if (nowFn() >= deadline) throw codedError("ZHAOPIN_MESSAGE_CONTENT_PENDING", "zhaopin conversation list is not ready");
          await sleepFn(pollIntervalMs, signal);
        }
        const internalRows = snapshot.rows.map((row) => rowFromSnapshot(snapshot, row));
        const rows = internalRows.map(publicRow);
        binding = next;
        targetMap = new Map(internalRows.map((row) => [targetKey(next.tabId, row), row]));
        return Object.freeze({ tabId: next.tabId, platform: "zhaopin", scope: "loaded_conversations", rows: Object.freeze(rows) });
      });
    },
    assertActiveBindings(signal) { return exclusive(() => assertActiveBindings(signal)); },
    readSelectedJobTarget(selected, signal) {
      return exclusive(async () => {
        if (!activeSelectedResult || selected !== activeSelectedResult || !activeSelectedTarget) {
          throw codedError("ZHAOPIN_MESSAGE_TARGET_INVALID", "selected zhaopin message target is not active");
        }
        await assertActiveBindings(signal);
        await browser.setPageLifecycleActive(binding.tabId);
        await assertActiveBindings(signal);
        const snapshot = await readSnapshot(binding.tabId, signal);
        const result = selectedJobTarget(snapshot, activeSelectedTarget);
        await assertActiveBindings(signal);
        return result;
      });
    },
    openQueuedConversation(target, signal) {
      return exclusive(async () => {
        throwIfAborted(signal);
        if (!binding || target?.tabId !== binding.tabId) throw codedError("ZHAOPIN_MESSAGE_TARGET_INVALID", "zhaopin target is not active");
        const internal = targetMap.get(targetKey(binding.tabId, target));
        if (!internal || target.previewDigest !== internal.previewDigest || target.sourceJobId !== internal.sourceJobId) {
          throw codedError("ZHAOPIN_MESSAGE_TARGET_INVALID", "zhaopin target is not from the active scan");
        }
        if (!validJobNumber(internal._raw.jobNumber) || !internal.sourceJobId) {
          throw codedError("ZHAOPIN_MESSAGE_JOB_ID_INVALID", "zhaopin message job identity is invalid");
        }
        await assertActiveBindings(signal);
        throwIfAborted(signal);
        await browser.setPageLifecycleActive(binding.tabId);
        throwIfAborted(signal);
        await assertActiveBindings(signal);
        throwIfAborted(signal);
        const guarded = await browser.evalValue(binding.tabId, buildSelectionExpression(internal._raw));
        throwIfAborted(signal);
        if (!guarded || guarded.clicked !== true) throw guardedSelectionError(guarded?.reason);
        const deadline = nowFn() + timeoutMs;
        let identityMismatch = false;
        while (true) {
          throwIfAborted(signal);
          await assertActiveBindings(signal);
          const snapshot = await readSnapshot(binding.tabId, signal);
          if (!selectedIdentityMatches(snapshot, internal._raw)) {
            identityMismatch = true;
          } else if (snapshot.timelineError) {
            throw codedError("ZHAOPIN_MESSAGE_TIMELINE_FAILED", "zhaopin conversation timeline failed");
          } else if (!snapshot.timelineLoading && snapshot.messages.length > 0) {
            activeSelectedTarget = { ...internal, ...internal._raw };
            activeSelectedResult = selectedResult(snapshot, activeSelectedTarget);
            return activeSelectedResult;
          }
          if (nowFn() >= deadline) {
            if (identityMismatch) throw codedError("ZHAOPIN_MESSAGE_TARGET_MISMATCH", "zhaopin selected conversation changed");
            throw codedError("ZHAOPIN_MESSAGE_CONTENT_PENDING", "zhaopin conversation content is not ready");
          }
          await sleepFn(pollIntervalMs, signal);
        }
      });
    }
  };
}

module.exports = {
  createZhaopinMessageReader,
  ZHAOPIN_MESSAGE_SNAPSHOT_EXPRESSION,
  hasZhaopinOutgoingTextSnapshot,
  isVisibleZhaopinLoginChallenge,
  isZhaopinMessageUrl
};
