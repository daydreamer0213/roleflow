"use strict";

const { isBrowserTabId, sameBrowserTabId } = require("../../core/browser_tab_identity");
const { isZhaopinMessageUrl } = require("./zhaopin_message_reader");

const ZHAOPIN_MESSAGE_DETAIL_SNAPSHOT_EXPRESSION = String.raw`(() => {
  const text = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  const visible = (node) => Boolean(node && !node.hidden && getComputedStyle(node).display !== "none" && getComputedStyle(node).visibility !== "hidden");
  const loginChallenge = (node) => visible(node) && !(node.matches?.("a.home-header__b-login, a.home-header__c-no-login") && node.parentElement?.matches?.(".home-header__right"));
  const bodyText = text(document.body?.innerText).slice(0, 3000);
  if (/安全验证|访问异常|行为验证|访问受限/.test(text(document.title)) || /安全验证|访问异常|行为验证|访问受限/.test(bodyText)) return { state: "risk_control" };
  if ([...document.querySelectorAll(".login, .login-panel, [class*='login']")].some(loginChallenge)) return { state: "login_required" };
  const title = text(document.querySelector(".summary-planes__title")?.textContent);
  const company = text(document.querySelector(".company-info__name")?.textContent)
    || text(document.querySelector(".company-summary__name-link")?.textContent);
  const info = [...document.querySelectorAll(".summary-planes__info li")].map((node) => text(node.textContent)).filter(Boolean);
  const description = text(document.querySelector(".describtion-card__detail-content")?.innerText).slice(0, 12000);
  const loading = [...document.querySelectorAll(".skeleton, .loading, [class*='skeleton']")].some(visible);
  const currentJobId = (location.pathname.match(/^\/jobdetail\/([A-Za-z0-9]+)\.html?$/i) || [])[1] || "";
  return {
    state: "ready",
    documentReadyState: document.readyState,
    currentJobId,
    title,
    company,
    location: info[0] || "",
    experience: info[1] || "",
    education: info[2] || "",
    salary: text(document.querySelector(".summary-planes__salary")?.textContent),
    tags: [...document.querySelectorAll(".describtion-card__skills-item")].map((node) => text(node.textContent)).filter(Boolean),
    description,
    availability: visible(document.querySelector(".summary-planes__invalid-text")) ? "offline" : "unknown",
    loading
  };
})()`;

function detailError(code, message) {
  return Object.assign(new Error(message), { code });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || detailError("MESSAGE_DISCOVERY_STOPPED", "message discovery stopped");
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || detailError("MESSAGE_DISCOVERY_STOPPED", "message discovery stopped"));
    }, { once: true });
  });
}

function createZhaopinMessageDetailReader({
  browser,
  messageReader,
  beforeOpen = async () => {},
  afterIssuedAttempt = async () => {},
  sleepFn = defaultSleep,
  nowFn = Date.now,
  timeoutMs = 120000,
  pollIntervalMs = 500
} = {}) {
  assertDependencies(browser, messageReader, beforeOpen, afterIssuedAttempt, sleepFn, nowFn, timeoutMs, pollIntervalMs);
  let busy = false;

  return {
    async readSelectedJobDetail(input = {}) {
      if (busy) throw detailError("ZHAOPIN_MESSAGE_DETAIL_BUSY", "zhaopin message detail reader is busy");
      busy = true;
      try {
        return await readSelectedJobDetail(input);
      } catch (error) {
        throw sanitizeError(error);
      } finally {
        busy = false;
      }
    }
  };

  async function readSelectedJobDetail({ communicationTabId, selected, jobTarget, signal } = {}) {
    const target = trustedJobTarget(jobTarget);
    const beforeTabs = await browser.listTabs();
    const binding = captureBinding(beforeTabs, communicationTabId);
    const assertBaseline = async () => assertRestoredBaseline(await browser.listTabs(), binding);
    await beforeOpen({ jobId: target.jobId, signal, assertTabBindings: assertBaseline });

    let issued = false;
    let returnedTabId = null;
    let detailTabId = null;
    let primaryError = null;
    let cleanupError = null;
    let afterError = null;
    let result;
    try {
      throwIfAborted(signal);
      issued = true;
      returnedTabId = await browser.createTab(communicationTabId, target.navigationUrl);
      const created = await waitForCreatedTab(beforeTabs, binding, returnedTabId, target, signal);
      detailTabId = created.id;
      await browser.setPageLifecycleActive(detailTabId);
      assertLiveBinding(await browser.listTabs(), binding, detailTabId, target);
      result = await readStableDetail(detailTabId, binding, selected, target, signal);
      assertLiveBinding(await browser.listTabs(), binding, detailTabId, target);
    } catch (error) {
      primaryError = error;
    } finally {
      if (issued && primaryError && detailTabId === null) {
        try {
          const tabs = await browser.listTabs();
          detailTabId = optionalReportedCreatedTab(beforeTabs, tabs, returnedTabId)?.id
            ?? optionalCreatedTargetTab(beforeTabs, tabs, binding, target)?.id
            ?? null;
        }
        catch (error) { cleanupError = error; }
      }
      if (detailTabId !== null) {
        try { await browser.closeTab(detailTabId); }
        catch { cleanupError ||= detailError("ZHAOPIN_MESSAGE_DETAIL_CLOSE_FAILED", "background zhaopin detail tab could not be closed"); }
      }
      if (issued) {
        try {
          await waitForRestoredBaseline(binding);
          const current = await messageReader.readSelectedJobTarget(selected, null);
          if (String(current?.jobId || "") !== target.jobId) {
            throw detailError("ZHAOPIN_MESSAGE_DETAIL_TARGET_MISMATCH", "selected zhaopin job identity changed");
          }
        } catch (error) {
          cleanupError ||= error;
        }
        try { await afterIssuedAttempt({ jobId: target.jobId, signal, assertTabBindings: assertBaseline }); }
        catch (error) { afterError = error; }
      }
    }
    if (cleanupError) throw cleanupError;
    if (primaryError) throw primaryError;
    if (afterError) throw afterError;
    return result;
  }

  async function waitForCreatedTab(beforeTabs, binding, returnedTabId, target, signal) {
    const deadline = nowFn() + timeoutMs;
    while (true) {
      throwIfAborted(signal);
      const tabs = await browser.listTabs();
      const newTabs = tabs.filter((tab) => !beforeTabs.some((item) => sameBrowserTabId(item.id, tab.id)));
      const created = newTabs[0];
      if (newTabs.length === 1 && isBrowserTabId(returnedTabId) && isBrowserTabId(created?.id)
        && sameCreatedTabId(returnedTabId, created.id)) {
        if (created.windowId !== binding.windowId || created.active === true || !sameActiveTabs(tabs, binding.activeTabIds)) {
          throw detailError("ZHAOPIN_MESSAGE_DETAIL_NOT_BACKGROUND", "zhaopin detail tab was not opened safely in the background");
        }
        assertBaselineTabs(tabs, binding);
        if (isTargetDetailTab(created, target)) return created;
        if (!isPendingTabUrl(created)) throw detailError("ZHAOPIN_MESSAGE_DETAIL_NOT_BACKGROUND", "zhaopin detail target could not be proven");
      } else if (newTabs.length || nowFn() >= deadline) {
        throw detailError("ZHAOPIN_MESSAGE_DETAIL_NOT_BACKGROUND", "zhaopin background detail tab identity is ambiguous");
      }
      if (nowFn() >= deadline) throw detailError("ZHAOPIN_MESSAGE_DETAIL_NOT_BACKGROUND", "zhaopin background detail tab did not appear");
      await sleepFn(pollIntervalMs, signal);
    }
  }

  async function readStableDetail(tabId, binding, selected, target, signal) {
    const deadline = nowFn() + timeoutMs;
    let previous = "";
    let sawIncomplete = false;
    while (true) {
      throwIfAborted(signal);
      assertLiveBinding(await browser.listTabs(), binding, tabId, target);
      const raw = await browser.evalValue(tabId, ZHAOPIN_MESSAGE_DETAIL_SNAPSHOT_EXPRESSION);
      const state = String(raw?.state || "");
      if (state === "risk_control") throw detailError("ZHAOPIN_MESSAGE_RISK_CONTROL", "zhaopin requires security verification");
      if (state === "login_required") throw detailError("ZHAOPIN_MESSAGE_LOGIN_REQUIRED", "zhaopin login is required");
      if (state !== "ready") throw detailError("ZHAOPIN_MESSAGE_DETAIL_PAGE_LOST", "zhaopin detail page changed");
      assertSnapshotIdentity(raw, selected, target);
      let detail = null;
      try { detail = parseZhaopinMessageDetailSnapshot(raw); }
      catch (error) {
        if (error.code !== "ZHAOPIN_MESSAGE_DETAIL_INCOMPLETE") throw error;
        sawIncomplete = true;
      }
      if (detail && raw.loading !== true) {
        const digest = JSON.stringify(detail);
        if (digest === previous) return detail;
        previous = digest;
      } else {
        previous = "";
      }
      if (nowFn() >= deadline) {
        throw detailError(sawIncomplete ? "ZHAOPIN_MESSAGE_DETAIL_INCOMPLETE" : "ZHAOPIN_MESSAGE_DETAIL_READ_TIMEOUT", "zhaopin job detail did not become complete and stable");
      }
      await sleepFn(pollIntervalMs, signal);
    }
  }

  async function waitForRestoredBaseline(binding) {
    let lastError;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try { return assertRestoredBaseline(await browser.listTabs(), binding); }
      catch (error) { lastError = error; }
      if (attempt < 7) await sleepFn(pollIntervalMs, null);
    }
    throw lastError;
  }
}

function parseZhaopinMessageDetailSnapshot(raw) {
  const sourceId = normalizedText(raw?.currentJobId);
  const title = normalizedText(raw?.title);
  const company = normalizedText(raw?.company);
  const description = normalizedText(raw?.description).slice(0, 12000);
  if (!/^[A-Za-z0-9]{1,160}$/.test(sourceId) || !title || !company || description.length < 120) {
    throw detailError("ZHAOPIN_MESSAGE_DETAIL_INCOMPLETE", "zhaopin job detail is incomplete");
  }
  return {
    source: "zhaopin",
    sourceId,
    canonicalUrl: `https://www.zhaopin.com/jobdetail/${sourceId}.htm`,
    title: title.slice(0, 240),
    company: company.slice(0, 240),
    location: normalizedText(raw.location).slice(0, 120),
    salary: normalizedText(raw.salary).slice(0, 120),
    experience: normalizedText(raw.experience).slice(0, 120),
    education: normalizedText(raw.education).slice(0, 120),
    tags: [...new Set((Array.isArray(raw.tags) ? raw.tags : []).map(normalizedText).filter(Boolean))].slice(0, 40),
    description,
    availability: raw.availability === "offline" ? "offline" : "unknown"
  };
}

function trustedJobTarget(value) {
  const jobId = normalizedText(value?.jobId);
  let navigation;
  let canonical;
  try {
    navigation = new URL(String(value?.navigationUrl || ""));
    canonical = new URL(String(value?.canonicalUrl || ""));
  } catch {
    throw detailError("ZHAOPIN_MESSAGE_JOB_TARGET_UNAVAILABLE", "selected zhaopin job target is unavailable");
  }
  const allowedNavigation = [`/jobdetail/${jobId}.htm`, `/jobdetail/${jobId}.html`];
  if (!/^[A-Za-z0-9]{1,160}$/.test(jobId)
    || navigation.origin !== "https://www.zhaopin.com"
    || canonical.origin !== "https://www.zhaopin.com"
    || !allowedNavigation.includes(navigation.pathname)
    || canonical.pathname !== `/jobdetail/${jobId}.htm`
    || navigation.search || navigation.hash || canonical.search || canonical.hash
    || navigation.username || navigation.password || canonical.username || canonical.password) {
    throw detailError("ZHAOPIN_MESSAGE_JOB_TARGET_UNAVAILABLE", "selected zhaopin job target is unavailable");
  }
  return { jobId, navigationUrl: navigation.toString(), canonicalUrl: canonical.toString(), availability: value.availability === "offline" ? "offline" : "unknown" };
}

function captureBinding(tabs, communicationTabId) {
  const communication = (tabs || []).find((tab) => sameBrowserTabId(tab.id, communicationTabId));
  const messageTabs = (tabs || []).filter((tab) => isZhaopinMessageUrl(tab?.url));
  if (messageTabs.length !== 1 || !communication || !isBrowserTabId(communication.id)
    || communication.windowId <= 0 || !sameBrowserTabId(messageTabs[0].id, communication.id)) {
    throw detailError("ZHAOPIN_MESSAGE_DETAIL_BINDING_INVALID", "zhaopin message tab binding is invalid");
  }
  return {
    windowId: communication.windowId,
    tabSnapshots: tabs.map((tab) => ({ id: tab.id, windowId: tab.windowId, active: tab.active === true, url: String(tab.url || "") })),
    activeTabIds: tabs.filter((tab) => tab.active === true).map((tab) => tab.id)
  };
}

function assertBaselineTabs(tabs, binding) {
  for (const expected of binding.tabSnapshots) {
    const current = tabs.find((tab) => sameBrowserTabId(tab.id, expected.id));
    if (!current || current.windowId !== expected.windowId || current.active !== expected.active || String(current.url || "") !== expected.url) {
      throw detailError("ZHAOPIN_MESSAGE_DETAIL_BASELINE_NOT_RESTORED", "browser baseline changed during zhaopin detail read");
    }
  }
}

function assertRestoredBaseline(tabs, binding) {
  assertBaselineTabs(tabs, binding);
  if (tabs.length !== binding.tabSnapshots.length || !sameActiveTabs(tabs, binding.activeTabIds)) {
    throw detailError("ZHAOPIN_MESSAGE_DETAIL_BASELINE_NOT_RESTORED", "browser baseline was not restored after zhaopin detail read");
  }
}

function assertLiveBinding(tabs, binding, detailTabId, target) {
  assertBaselineTabs(tabs, binding);
  const extras = tabs.filter((tab) => !binding.tabSnapshots.some((item) => sameBrowserTabId(item.id, tab.id)));
  if (extras.length !== 1 || !sameBrowserTabId(extras[0].id, detailTabId)
    || extras[0].windowId !== binding.windowId || extras[0].active === true
    || !isTargetDetailTab(extras[0], target) || !sameActiveTabs(tabs, binding.activeTabIds)) {
    throw detailError("ZHAOPIN_MESSAGE_DETAIL_NOT_BACKGROUND", "zhaopin detail tab safety changed during read");
  }
}

function optionalCreatedTargetTab(beforeTabs, tabs, binding, target) {
  const candidates = tabs.filter((tab) => !beforeTabs.some((item) => sameBrowserTabId(item.id, tab.id))
    && tab.windowId === binding.windowId && tab.active !== true && isTargetDetailTab(tab, target));
  if (candidates.length > 1) throw detailError("ZHAOPIN_MESSAGE_DETAIL_BASELINE_NOT_RESTORED", "zhaopin detail cleanup is ambiguous");
  return candidates[0] || null;
}

function optionalReportedCreatedTab(beforeTabs, tabs, returnedTabId) {
  if (!isBrowserTabId(returnedTabId)) return null;
  const candidates = tabs.filter((tab) => !beforeTabs.some((item) => sameBrowserTabId(item.id, tab.id))
    && sameCreatedTabId(returnedTabId, tab.id));
  return candidates.length === 1 ? candidates[0] : null;
}

function assertSnapshotIdentity(raw, selected, target) {
  const title = normalizedText(raw?.title);
  const company = normalizedText(raw?.company);
  if (normalizedText(raw?.currentJobId) !== target.jobId
    || (title && !sameText(title, selected?.positionName))
    || (company && !compatibleCompany(company, selected?.companyName))) {
    throw detailError("ZHAOPIN_MESSAGE_DETAIL_TARGET_MISMATCH", "zhaopin detail identity did not match the selected conversation");
  }
}

function sameText(left, right) {
  const first = normalizedText(left).toLowerCase();
  const second = normalizedText(right).toLowerCase();
  return Boolean(first && second && first === second);
}

function compatibleCompany(left, right) {
  const first = normalizedText(left).toLowerCase();
  const second = normalizedText(right).toLowerCase();
  if (!first || !second) return false;
  if (first === second) return true;
  const suffixes = ["有限责任公司", "股份有限公司", "有限公司"];
  return suffixes.some((suffix) => first === `${second}${suffix}` || second === `${first}${suffix}`);
}

function isTargetDetailTab(tab, target) {
  try {
    const url = new URL(String(tab?.url || ""));
    return url.origin === "https://www.zhaopin.com"
      && [`/jobdetail/${target.jobId}.htm`, `/jobdetail/${target.jobId}.html`].includes(url.pathname)
      && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

function isPendingTabUrl(tab) {
  const value = String(tab?.url || "").trim();
  return !value || value === "about:blank";
}

function sameActiveTabs(tabs, expectedIds) {
  const active = tabs.filter((tab) => tab.active === true).map((tab) => tab.id);
  return active.length === expectedIds.length && active.every((id, index) => sameBrowserTabId(id, expectedIds[index]));
}

function sameCreatedTabId(returnedId, listedId) {
  if (sameBrowserTabId(returnedId, listedId)) return true;
  if (typeof returnedId === "string" && Number.isSafeInteger(listedId) && /^\d+$/.test(returnedId.trim())) {
    return Number(returnedId) === listedId;
  }
  return false;
}

function normalizedText(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function assertDependencies(browser, messageReader, beforeOpen, afterIssuedAttempt, sleepFn, nowFn, timeoutMs, pollIntervalMs) {
  for (const name of ["listTabs", "createTab", "setPageLifecycleActive", "evalValue", "closeTab"]) {
    if (typeof browser?.[name] !== "function") throw detailError("ZHAOPIN_MESSAGE_BROWSER_INVALID", `browser.${name} is required`);
  }
  if (typeof messageReader?.readSelectedJobTarget !== "function") throw detailError("ZHAOPIN_MESSAGE_BROWSER_INVALID", "zhaopin message target verification is required");
  for (const [name, value] of [["beforeOpen", beforeOpen], ["afterIssuedAttempt", afterIssuedAttempt], ["sleepFn", sleepFn], ["nowFn", nowFn]]) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw detailError("ZHAOPIN_MESSAGE_OPTIONS_INVALID", "zhaopin detail reader options are invalid");
  }
}

function sanitizeError(error) {
  const code = String(error?.code || "");
  const allowed = /^ZHAOPIN_MESSAGE_[A-Z0-9_]+$/.test(code)
    || /^ZHAOPIN_ACCESS_[A-Z0-9_]+$/.test(code)
    || ["ZHAOPIN_RISK_CONTROL", "MESSAGE_DISCOVERY_STOPPED", "SCAN_ABORTED", "WORKFLOW_PAUSE_REQUESTED"].includes(code);
  return detailError(allowed ? code : "ZHAOPIN_MESSAGE_DETAIL_BROWSER_FAILED", allowed ? `zhaopin message detail stopped safely (${code})` : "zhaopin background detail browser operation failed");
}

module.exports = {
  createZhaopinMessageDetailReader,
  parseZhaopinMessageDetailSnapshot,
  ZHAOPIN_MESSAGE_DETAIL_SNAPSHOT_EXPRESSION
};
