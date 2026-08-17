const { PAGE_HELPERS } = require("./boss");
const { assertBossOperatorTabs } = require("../../core/workspace_tabs");

const DETAIL_READY_ATTEMPTS = 60;
const DETAIL_READY_DELAY_MS = 250;
const MESSAGE_DETAIL_SNAPSHOT_EXPRESSION = `(function __bossMessageDetailSnapshot() {
  const decode = window.__bossDecode || ((value) => String(value || "").replace(/\\s+/g, " ").trim());
  const roots = Array.from(document.querySelectorAll(".job-box > .inner.home-inner > .job-detail"));
  const root = roots.length === 1 ? roots[0] : null;
  const header = document.querySelector(".job-banner .job-primary.detail-box");
  const description = root?.querySelector(".job-sec-text")
    || root?.querySelector(".job-detail-body .desc")
    || root?.querySelector("p.desc")
    || root?.querySelector(".job-detail-section .text")
    || root?.querySelector("[class*='job-sec-text']");
  const metadata = (window.__bossJobMetadata || (() => ({})))(decode(header?.innerText || ""));
  return {
    currentJobId: (location.pathname.match(/\\/job_detail\\/([^/?#]+)\\.html/i) || [])[1] || "",
    rootCount: roots.length,
    hasRoot: Boolean(root),
    title: decode(header?.querySelector("h1")?.innerText || ""),
    company: decode(document.querySelector(".sider-company .company-info")?.innerText || ""),
    description: decode(description?.innerText || "").slice(0, 12000),
    bossActiveText: decode(document.querySelector(".job-boss-info .boss-active-time")?.innerText || ""),
    ...metadata
  };
})()`;

function detailError(code, message) {
  return Object.assign(new Error(message), { code });
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason || detailError("MESSAGE_DISCOVERY_STOPPED", "message discovery stopped");
  }
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || detailError("MESSAGE_DISCOVERY_STOPPED", "message discovery stopped"));
    }, { once: true });
  });
}

function createBossMessageDetailReader({
  browser,
  messageReader,
  beforeOpen = async () => {},
  afterIssuedAttempt = async () => {},
  sleepFn = defaultSleep
} = {}) {
  assertDependencies(browser, messageReader, beforeOpen, afterIssuedAttempt, sleepFn);
  let busy = false;

  return {
    async readSelectedJobDetail(input = {}) {
      if (busy) throw detailError("BOSS_MESSAGE_DETAIL_BUSY", "message detail reader is busy");
      busy = true;
      try {
        return await readSelectedJobDetail(input);
      } catch (error) {
        throw sanitizedDetailError(error);
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
    let createReturned = false;
    let detailTabId = null;
    let result;
    let primaryError = null;
    let cleanupError = null;
    let afterError = null;

    try {
      throwIfAborted(signal);
      issued = true;
      const returnedTabId = await browser.createTab(communicationTabId, target.navigationUrl);
      createReturned = true;
      if (Number.isInteger(returnedTabId)) detailTabId = returnedTabId;
      const created = await waitForCreatedTargetTab({
        beforeTabs,
        binding,
        returnedTabId,
        target,
        signal
      });
      detailTabId = created.id;
      await browser.evalValue(detailTabId, PAGE_HELPERS);
      result = await readReadyDetail(detailTabId, selected, target, signal);
      assertLiveDetailBinding(await browser.listTabs(), binding, detailTabId, target);
    } catch (error) {
      primaryError = error;
    } finally {
      if (issued && detailTabId === null) {
        try {
          const tabs = await browser.listTabs();
          const candidate = optionalCreatedTargetTab(beforeTabs, tabs, target);
          if (candidate) detailTabId = candidate.id;
        } catch (error) {
          cleanupError = error;
        }
      }
      if (detailTabId !== null) {
        try {
          await browser.closeTab(detailTabId);
        } catch (error) {
          cleanupError ||= detailError("BOSS_MESSAGE_DETAIL_CLOSE_FAILED", "background detail tab could not be closed");
        }
      }
      if (issued) {
        try {
          await assertRestoredBaseline(await browser.listTabs(), binding);
          if (createReturned) {
            const currentTarget = await messageReader.readSelectedJobTarget(selected, null);
            if (currentTarget.jobId !== target.jobId) {
              throw detailError("BOSS_MESSAGE_DETAIL_TARGET_MISMATCH", "message detail identity changed");
            }
          }
        } catch (error) {
          cleanupError ||= error;
        }
        try {
          await afterIssuedAttempt({ jobId: target.jobId, signal, assertTabBindings: assertBaseline });
        } catch (error) {
          afterError = error;
        }
      }
    }

    if (cleanupError) throw cleanupError;
    if (afterError) throw afterError;
    if (primaryError) throw primaryError;
    return result;
  }

  async function readReadyDetail(tabId, selected, target, signal) {
    let sawPage = false;
    for (let attempt = 0; attempt < DETAIL_READY_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      const communication = await browser.evalValue(tabId, "(() => window.__bossCommunicationSnapshot())()");
      if (communication?.risk) throw detailError("BOSS_RISK_CONTROL", "BOSS requires security verification");
      if (communication?.login) throw detailError("BOSS_LOGIN_REQUIRED", "BOSS login is required");
      const detail = await browser.evalValue(tabId, MESSAGE_DETAIL_SNAPSHOT_EXPRESSION);
      if (communication?.documentReadyState === "complete" && communication?.pageReady && detail?.currentJobId) {
        sawPage = true;
        assertDetailIdentity(communication, detail, selected, target);
        const description = normalizedText(detail.description).slice(0, 12000);
        if (description.length >= 120) {
          const experience = normalizedText(detail.experience);
          const education = normalizedText(detail.education);
          return {
            sourceId: target.jobId,
            canonicalUrl: target.canonicalUrl,
            title: normalizedText(communication.title || detail.title),
            company: normalizedText(communication.company),
            location: normalizedText(selected?.city),
            salary: normalizedText(detail.salary || communication.salary || selected?.salary),
            experience,
            education,
            bossActiveText: normalizedText(detail.bossActiveText || communication.bossActiveText),
            tags: [...new Set([experience, education].filter(Boolean))],
            description
          };
        }
      }
      if (attempt + 1 < DETAIL_READY_ATTEMPTS) await sleepFn(DETAIL_READY_DELAY_MS, signal);
    }
    throw detailError(
      sawPage ? "BOSS_MESSAGE_DETAIL_INCOMPLETE" : "BOSS_MESSAGE_DETAIL_READ_TIMEOUT",
      sawPage ? "background job detail is incomplete" : "background job detail did not become ready"
    );
  }

  async function waitForCreatedTargetTab({ beforeTabs, binding, returnedTabId, target, signal }) {
    for (let attempt = 0; attempt < DETAIL_READY_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      const afterCreate = await browser.listTabs();
      const created = assertBackgroundCreation({
        returnedTabId,
        beforeTabs,
        afterCreate,
        binding
      });
      if (isTargetDetailTab(created, target)) return created;
      if (!isPendingTabUrl(created) || attempt + 1 >= DETAIL_READY_ATTEMPTS) {
        throw detailError("BOSS_MESSAGE_DETAIL_NOT_BACKGROUND", "background detail tab target could not be proven");
      }
      await sleepFn(DETAIL_READY_DELAY_MS, signal);
    }
    throw detailError("BOSS_MESSAGE_DETAIL_NOT_BACKGROUND", "background detail tab target could not be proven");
  }
}

function assertDependencies(browser, messageReader, beforeOpen, afterIssuedAttempt, sleepFn) {
  for (const name of ["listTabs", "createTab", "evalValue", "closeTab"]) {
    if (typeof browser?.[name] !== "function") {
      throw detailError("BOSS_MESSAGE_BROWSER_INVALID", `browser.${name} is required`);
    }
  }
  if (typeof messageReader?.readSelectedJobTarget !== "function") {
    throw detailError("BOSS_MESSAGE_BROWSER_INVALID", "message reader target verification is required");
  }
  for (const [name, value] of [["beforeOpen", beforeOpen], ["afterIssuedAttempt", afterIssuedAttempt], ["sleepFn", sleepFn]]) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  }
}

function trustedJobTarget(value) {
  const jobId = String(value?.jobId || "").trim();
  if (!/^[A-Za-z0-9_-]{6,160}$/.test(jobId)) {
    throw detailError("BOSS_MESSAGE_JOB_TARGET_UNAVAILABLE", "selected job target is unavailable");
  }
  let navigation;
  let canonical;
  try {
    navigation = new URL(String(value.navigationUrl || ""));
    canonical = new URL(String(value.canonicalUrl || ""));
  } catch {
    throw detailError("BOSS_MESSAGE_JOB_TARGET_UNAVAILABLE", "selected job target is unavailable");
  }
  const expectedPath = `/job_detail/${jobId}.html`;
  if (navigation.origin !== "https://www.zhipin.com"
    || canonical.origin !== "https://www.zhipin.com"
    || navigation.pathname !== expectedPath
    || canonical.pathname !== expectedPath
    || !navigation.searchParams.get("securityId")
    || [...navigation.searchParams.keys()].some((key) => key !== "securityId")
    || [...navigation.searchParams.keys()].length !== 1
    || navigation.hash
    || canonical.search
    || canonical.hash
    || navigation.username
    || navigation.password
    || canonical.username
    || canonical.password) {
    throw detailError("BOSS_MESSAGE_JOB_TARGET_UNAVAILABLE", "selected job target is unavailable");
  }
  return { jobId, navigationUrl: navigation.toString(), canonicalUrl: canonical.toString() };
}

function captureBinding(tabs, communicationTabId) {
  const fixed = assertBossOperatorTabs(tabs);
  const expectedCommunicationTabId = communicationTabId === undefined
    ? fixed.communicationTab.id
    : communicationTabId;
  if (!Number.isInteger(expectedCommunicationTabId)
    || !Number.isInteger(fixed.searchTab.id)
    || !Number.isInteger(fixed.communicationTab.id)
    || fixed.communicationTab.id !== expectedCommunicationTabId) {
    throw detailError("BOSS_MESSAGE_DETAIL_BINDING_INVALID", "numeric fixed BOSS tab binding is required");
  }
  const bossTabs = tabs.filter(isBossTab);
  if (bossTabs.length !== 2) {
    throw detailError("BOSS_MESSAGE_DETAIL_BASELINE_INVALID", "BOSS fixed-tab baseline is not at rest");
  }
  const activeTabId = activeTabIdInWindow(tabs, fixed.windowId);
  return {
    searchTabId: fixed.searchTab.id,
    communicationTabId: fixed.communicationTab.id,
    windowId: fixed.windowId,
    activeTabId,
    bossTabIds: bossTabs.map((tab) => tab.id).sort((a, b) => a - b),
    tabIds: numericTabIds(tabs)
  };
}

function assertRestoredBaseline(tabs, binding) {
  const fixed = assertBossOperatorTabs(tabs);
  const bossTabs = tabs.filter(isBossTab);
  const bossTabIds = bossTabs.map((tab) => tab.id).sort((a, b) => a - b);
  if (bossTabs.length !== 2
    || fixed.searchTab.id !== binding.searchTabId
    || fixed.communicationTab.id !== binding.communicationTabId
    || fixed.windowId !== binding.windowId
    || activeTabIdInWindow(tabs, binding.windowId) !== binding.activeTabId
    || bossTabIds.some((id, index) => id !== binding.bossTabIds[index])
    || !sameIds(numericTabIds(tabs), binding.tabIds)) {
    throw detailError("BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED", "BOSS fixed-tab baseline was not restored");
  }
  return fixed;
}

function optionalCreatedTargetTab(before, after, target) {
  const beforeIds = new Set(before.map((tab) => tab.id));
  const candidates = after.filter((tab) => !beforeIds.has(tab.id)
    && Number.isInteger(tab.id)
    && isTargetDetailTab(tab, target));
  if (candidates.length > 1) {
    throw detailError("BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED", "background detail cleanup is ambiguous");
  }
  return candidates[0] || null;
}

function assertBackgroundCreation({ returnedTabId, beforeTabs, afterCreate, binding }) {
  const beforeIds = new Set(beforeTabs.map((tab) => tab.id));
  const newTabs = afterCreate.filter((tab) => !beforeIds.has(tab.id));
  const created = newTabs[0];
  if (!Number.isInteger(returnedTabId)
    || newTabs.length !== 1
    || !Number.isInteger(created?.id)
    || returnedTabId !== created.id
    || created.windowId !== binding.windowId
    || created.active === true
    || activeTabIdInWindow(afterCreate, binding.windowId) !== binding.activeTabId) {
    throw detailError("BOSS_MESSAGE_DETAIL_NOT_BACKGROUND", "background detail tab safety could not be proven");
  }
  assertFixedTabsPresent(afterCreate, binding);
  return created;
}

function assertLiveDetailBinding(tabs, binding, detailTabId, target) {
  const detailTabs = tabs.filter((tab) => isTargetDetailTab(tab, target));
  if (detailTabs.length !== 1
    || detailTabs[0].id !== detailTabId
    || detailTabs[0].windowId !== binding.windowId
    || detailTabs[0].active === true
    || activeTabIdInWindow(tabs, binding.windowId) !== binding.activeTabId) {
    throw detailError("BOSS_MESSAGE_DETAIL_NOT_BACKGROUND", "background detail tab safety changed during read");
  }
  assertFixedTabsPresent(tabs, binding);
}

function assertFixedTabsPresent(tabs, binding) {
  const search = tabs.find((tab) => tab.id === binding.searchTabId);
  const communication = tabs.find((tab) => tab.id === binding.communicationTabId);
  if (!search || !communication
    || search.windowId !== binding.windowId
    || communication.windowId !== binding.windowId
    || bossPath(search) !== "/web/geek/jobs"
    || bossPath(communication) !== "/web/geek/chat") {
    throw detailError("BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED", "BOSS fixed tabs changed during detail read");
  }
}

function activeTabIdInWindow(tabs, windowId) {
  const active = tabs.filter((tab) => tab.windowId === windowId && tab.active === true);
  if (active.length !== 1 || !Number.isInteger(active[0].id)) {
    throw detailError("BOSS_MESSAGE_DETAIL_NOT_BACKGROUND", "active Edge tab identity is unavailable");
  }
  return active[0].id;
}

function assertDetailIdentity(communication, detail, selected, target) {
  if (String(communication.jobId || "").trim() !== target.jobId
    || String(detail.currentJobId || "").trim() !== target.jobId
    || Number(detail.rootCount) !== 1
    || detail.hasRoot !== true
    || !sameText(communication.title || detail.title, selected?.positionName)
    || !sameText(detail.title || communication.title, selected?.positionName)
    || !compatibleCompany(communication.company, selected?.companyName)
    || !compatibleCompany(detail.company, selected?.companyName)) {
    throw detailError("BOSS_MESSAGE_DETAIL_TARGET_MISMATCH", "background job detail identity did not match");
  }
}

function sameText(first, second) {
  const left = normalizedText(first).toLowerCase();
  const right = normalizedText(second).toLowerCase();
  return Boolean(left && right && left === right);
}

function compatibleCompany(first, second) {
  const left = normalizedText(first).toLowerCase();
  const right = normalizedText(second).toLowerCase();
  return Boolean(left && right && (left === right || left.startsWith(right) || right.startsWith(left)));
}

function normalizedText(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function isBossTab(tab) {
  try {
    return new URL(String(tab?.url || "")).hostname === "www.zhipin.com";
  } catch {
    return false;
  }
}

function bossPath(tab) {
  try {
    const url = new URL(String(tab?.url || ""));
    return url.hostname === "www.zhipin.com" ? url.pathname : "";
  } catch {
    return "";
  }
}

function isTargetDetailTab(tab, target) {
  try {
    const url = new URL(String(tab?.url || ""));
    return url.origin === "https://www.zhipin.com"
      && url.pathname === `/job_detail/${target.jobId}.html`;
  } catch {
    return false;
  }
}

function isPendingTabUrl(tab) {
  const value = String(tab?.url || "").trim();
  return value === "" || value === "about:blank";
}

function numericTabIds(tabs) {
  return tabs.map((tab) => tab.id).filter(Number.isInteger).sort((left, right) => left - right);
}

function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sanitizedDetailError(error) {
  const code = String(error?.code || "");
  const allowed = /^BOSS_MESSAGE_[A-Z0-9_]+$/.test(code)
    || /^BOSS_ACCESS_[A-Z0-9_]+$/.test(code)
    || [
      "BOSS_RISK_CONTROL",
      "BOSS_LOGIN_REQUIRED",
      "MESSAGE_DISCOVERY_STOPPED",
      "SCAN_ABORTED",
      "WORKFLOW_PAUSE_REQUESTED"
    ].includes(code);
  return detailError(
    allowed ? code : "BOSS_MESSAGE_DETAIL_BROWSER_FAILED",
    allowed ? `message detail stopped safely (${code})` : "background message detail browser operation failed"
  );
}

module.exports = {
  assertRestoredBaseline,
  captureBinding,
  createBossMessageDetailReader
};
