const { PAGE_HELPERS } = require("./boss");
const { assertBossOperatorTabs } = require("../../core/workspace_tabs");
const {
  isBrowserTabId,
  sameBrowserTabId,
  sortedBrowserTabIds
} = require("../../core/browser_tab_identity");

const DETAIL_READY_ATTEMPTS = 60;
const DETAIL_READY_DELAY_MS = 250;
const CLEANUP_BASELINE_ATTEMPTS = 8;
const SAFE_COMMUNICATION_SNAPSHOT_EXPRESSION = String.raw`(function __roleflowSafeCommunicationSnapshot() {
  try {
    return { ok: true, value: window.__bossCommunicationSnapshot() };
  } catch (error) {
    const message = String(error?.message || "");
    const member = message.match(/(?:reading|property)\s+['"]([A-Za-z0-9_$.-]{1,80})['"]/i)
      || message.match(/([A-Za-z_$][A-Za-z0-9_$.-]{0,79}) is not a function/i);
    let errorKind = "unknown";
    if (/Cannot read properties of (?:null|undefined)/i.test(message)) errorKind = "null_member";
    else if (/is not a function/i.test(message)) errorKind = "not_function";
    else if (/is not defined/i.test(message)) errorKind = "not_defined";
    else if (/selector|querySelector/i.test(message)) errorKind = "invalid_selector";
    return {
      ok: false,
      error: {
        errorName: String(error?.name || "Error").slice(0, 40),
        errorKind,
        errorMember: member?.[1] || ""
      }
    };
  }
})()`;
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
  logger = null,
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
        const sanitized = sanitizedDetailError(error);
        if (sanitized.code === "BOSS_MESSAGE_DETAIL_BROWSER_FAILED") {
          const fields = {
            phase: detailFailurePhase(error),
            code: sanitized.code,
            causeCode: browserCauseCode(error)
          };
          if (error?.primaryPhase) {
            fields.primaryPhase = detailFailurePhase({ detailPhase: error.primaryPhase });
            fields.primaryCauseCode = /^BROWSER_[A-Z0-9_]+$/.test(String(error.primaryCauseCode || ""))
              ? error.primaryCauseCode
              : "BROWSER_UNKNOWN";
          }
          if (error?.scriptDiagnostic) {
            fields.scriptErrorName = safeDiagnosticToken(error.scriptDiagnostic.errorName, "Error");
            fields.scriptErrorKind = safeDiagnosticToken(error.scriptDiagnostic.errorKind, "unknown");
            fields.scriptErrorMember = safeDiagnosticToken(error.scriptDiagnostic.errorMember, "");
          }
          logger?.warn("boss_message_detail_read_failed", fields);
        }
        throw sanitized;
      } finally {
        busy = false;
      }
    }
  };

  async function readSelectedJobDetail({ communicationTabId, selected, jobTarget, signal } = {}) {
    let phase = "validate_target";
    const target = trustedJobTarget(jobTarget);
    phase = "capture_baseline";
    const beforeTabs = await browser.listTabs();
    const binding = captureBinding(beforeTabs, communicationTabId);
    const assertBaseline = async () => assertRestoredBaseline(await browser.listTabs(), binding);
    phase = "before_open";
    await beforeOpen({ jobId: target.jobId, signal, assertTabBindings: assertBaseline });

    let issued = false;
    let createReturned = false;
    let detailTabId = null;
    let result;
    let primaryError = null;
    let cleanupError = null;
    let afterError = null;
    let primaryPhase = phase;

    try {
      throwIfAborted(signal);
      issued = true;
      phase = "create_tab";
      const returnedTabId = await browser.createTab(communicationTabId, target.navigationUrl);
      createReturned = true;
      if (isBrowserTabId(returnedTabId)) detailTabId = returnedTabId;
      phase = "wait_created_tab";
      const created = await waitForCreatedTargetTab({
        beforeTabs,
        binding,
        returnedTabId,
        target,
        signal
      });
      detailTabId = created.id;
      phase = "wake_detail";
      await browser.setPageLifecycleActive(detailTabId);
      phase = "verify_woken_binding";
      assertLiveDetailBinding(await browser.listTabs(), binding, detailTabId, target);
      phase = "read_detail";
      result = await readReadyDetail(
        detailTabId,
        selected,
        target,
        signal,
        (value) => { phase = value; },
        async () => assertLiveDetailBinding(await browser.listTabs(), binding, detailTabId, target)
      );
      phase = "verify_live_binding";
      assertLiveDetailBinding(await browser.listTabs(), binding, detailTabId, target);
    } catch (error) {
      primaryError = error;
      primaryPhase = phase;
    } finally {
      if (issued && primaryError) {
        phase = "cleanup_attribute_tab";
        try {
          const tabs = await browser.listTabs();
          const attributed = detailTabId !== null && tabs.some((tab) =>
            !beforeTabs.some((item) => sameBrowserTabId(item.id, tab.id))
            && sameBrowserTabId(tab.id, detailTabId));
          if (!attributed) {
            const candidate = optionalCreatedTargetTab(beforeTabs, tabs, target);
            detailTabId = candidate?.id ?? null;
          }
        } catch (error) {
          cleanupError = phasedDetailError(error, phase);
        }
      }
      if (detailTabId !== null) {
        phase = "cleanup_close_tab";
        try {
          await browser.closeTab(detailTabId);
        } catch (error) {
          cleanupError ||= phasedDetailError(
            detailError("BOSS_MESSAGE_DETAIL_CLOSE_FAILED", "background detail tab could not be closed"),
            phase
          );
        }
      }
      if (issued) {
        phase = "cleanup_list_tabs";
        try {
          await waitForRestoredBaseline(binding, detailTabId);
          if (createReturned) {
            phase = "cleanup_recheck_message";
            const currentTarget = await messageReader.readSelectedJobTarget(selected, null);
            if (currentTarget.jobId !== target.jobId) {
              throw detailError("BOSS_MESSAGE_DETAIL_TARGET_MISMATCH", "message detail identity changed");
            }
          }
        } catch (error) {
          cleanupError ||= phasedDetailError(error, phase);
        }
        try {
          phase = "after_issued_attempt";
          await afterIssuedAttempt({ jobId: target.jobId, signal, assertTabBindings: assertBaseline });
        } catch (error) {
          afterError = error;
        }
      }
    }

    if (cleanupError) {
      if (primaryError) {
        cleanupError.primaryPhase = primaryPhase;
        cleanupError.primaryCauseCode = browserCauseCode(primaryError);
        if (primaryError.scriptDiagnostic) cleanupError.scriptDiagnostic = primaryError.scriptDiagnostic;
      }
      throw cleanupError;
    }
    if (afterError) throw phasedDetailError(afterError, "after_issued_attempt");
    if (primaryError) throw phasedDetailError(primaryError, primaryPhase);
    return result;
  }

  async function readReadyDetail(tabId, selected, target, signal, setPhase, assertLiveBinding) {
    let sawPage = false;
    for (let attempt = 0; attempt < DETAIL_READY_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      setPhase("verify_live_binding_before_read");
      await assertLiveBinding();
      setPhase("inject_helpers");
      await browser.evalValue(tabId, PAGE_HELPERS);
      setPhase("read_page_state");
      const communicationResult = await browser.evalValue(tabId, SAFE_COMMUNICATION_SNAPSHOT_EXPRESSION);
      setPhase("verify_live_binding_after_page_state");
      await assertLiveBinding();
      setPhase("read_page_state");
      if (communicationResult?.ok !== true || !communicationResult.value) {
        const diagnostic = safeScriptDiagnostic(communicationResult?.error);
        if (isTransientHelperLoss(diagnostic) && attempt + 1 < DETAIL_READY_ATTEMPTS) {
          setPhase("wait_detail_ready");
          await sleepFn(DETAIL_READY_DELAY_MS, signal);
          continue;
        }
        const error = detailError("BROWSER_COMMAND_FAILED", "message detail page snapshot failed");
        error.scriptDiagnostic = diagnostic;
        throw error;
      }
      const communication = communicationResult.value;
      if (communication?.risk) throw detailError("BOSS_RISK_CONTROL", "BOSS requires security verification");
      if (communication?.login) throw detailError("BOSS_LOGIN_REQUIRED", "BOSS login is required");
      setPhase("read_job_snapshot");
      const detail = await browser.evalValue(tabId, MESSAGE_DETAIL_SNAPSHOT_EXPRESSION);
      setPhase("verify_live_binding_after_job_snapshot");
      await assertLiveBinding();
      setPhase("read_job_snapshot");
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
      if (attempt + 1 < DETAIL_READY_ATTEMPTS) {
        setPhase("wait_detail_ready");
        await sleepFn(DETAIL_READY_DELAY_MS, signal);
      }
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

  async function waitForRestoredBaseline(binding, detailTabId) {
    let lastError = null;
    for (let attempt = 0; attempt < CLEANUP_BASELINE_ATTEMPTS; attempt += 1) {
      try {
        const tabs = await browser.listTabs();
        try {
          return assertRestoredBaseline(tabs, binding);
        } catch (error) {
          if (!isOnlyLingeringClosedTarget(tabs, binding, detailTabId)) throw error;
          lastError = error;
        }
      } catch (error) {
        if (error?.code !== "BROWSER_COMMAND_FAILED") throw error;
        lastError = error;
      }
      if (attempt + 1 < CLEANUP_BASELINE_ATTEMPTS) {
        await sleepFn(DETAIL_READY_DELAY_MS, null);
      }
    }
    throw lastError || detailError(
      "BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED",
      "BOSS fixed-tab baseline was not restored"
    );
  }
}

function phasedDetailError(error, phase) {
  const wrapped = detailError(String(error?.code || ""), "message detail read failed");
  wrapped.detailPhase = phase;
  if (error?.scriptDiagnostic) wrapped.scriptDiagnostic = safeScriptDiagnostic(error.scriptDiagnostic);
  return wrapped;
}

function safeScriptDiagnostic(value) {
  return {
    errorName: safeDiagnosticToken(value?.errorName, "Error"),
    errorKind: safeDiagnosticToken(value?.errorKind, "unknown"),
    errorMember: safeDiagnosticToken(value?.errorMember, "")
  };
}

function isTransientHelperLoss(value) {
  return value?.errorKind === "not_function"
    && value?.errorMember === "window.__bossCommunicationSnapshot";
}

function safeDiagnosticToken(value, fallback) {
  const token = String(value || "");
  return /^[A-Za-z0-9_$.-]{1,80}$/.test(token) ? token : fallback;
}

function detailFailurePhase(error) {
  const phase = String(error?.detailPhase || "unknown");
  return /^[a-z_]{1,40}$/.test(phase) ? phase : "unknown";
}

function browserCauseCode(error) {
  const code = String(error?.code || "");
  return /^BROWSER_[A-Z0-9_]+$/.test(code) ? code : "BROWSER_UNKNOWN";
}

function assertDependencies(browser, messageReader, beforeOpen, afterIssuedAttempt, sleepFn) {
  for (const name of ["listTabs", "createTab", "setPageLifecycleActive", "evalValue", "closeTab"]) {
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
  if (!isBrowserTabId(expectedCommunicationTabId)
    || !isBrowserTabId(fixed.searchTab.id)
    || !isBrowserTabId(fixed.communicationTab.id)
    || !sameBrowserTabId(fixed.communicationTab.id, expectedCommunicationTabId)) {
    throw detailError("BOSS_MESSAGE_DETAIL_BINDING_INVALID", "typed fixed BOSS tab binding is required");
  }
  const tabIds = sortedBrowserTabIds(tabs.map((tab) => tab.id));
  if (tabIds.length !== tabs.length || new Set(tabIds.map((id) => typeof id)).size !== 1) {
    throw detailError("BOSS_MESSAGE_DETAIL_BINDING_INVALID", "browser tab identity transport is inconsistent");
  }
  const bossTabs = tabs.filter(isBossTab);
  if (bossTabs.length !== 2) {
    throw detailError("BOSS_MESSAGE_DETAIL_BASELINE_INVALID", "BOSS fixed-tab baseline is not at rest");
  }
  const visibleTabIds = visibleTabIdsInWindow(tabs, fixed.windowId);
  if (visibleTabIds.length > 1) {
    throw detailError("BOSS_MESSAGE_DETAIL_NOT_BACKGROUND", "visible Edge tab identity is ambiguous");
  }
  return {
    searchTabId: fixed.searchTab.id,
    communicationTabId: fixed.communicationTab.id,
    windowId: fixed.windowId,
    visibleTabIds,
    bossTabIds: sortedBrowserTabIds(bossTabs.map((tab) => tab.id)),
    tabIds
  };
}

function assertRestoredBaseline(tabs, binding) {
  try {
    const fixed = assertBossOperatorTabs(tabs);
    const bossTabs = tabs.filter(isBossTab);
    const bossTabIds = sortedBrowserTabIds(bossTabs.map((tab) => tab.id));
    if (bossTabs.length !== 2
      || !sameBrowserTabId(fixed.searchTab.id, binding.searchTabId)
      || !sameBrowserTabId(fixed.communicationTab.id, binding.communicationTabId)
      || fixed.windowId !== binding.windowId
      || !sameIds(visibleTabIdsInWindow(tabs, binding.windowId), binding.visibleTabIds)
      || !sameIds(bossTabIds, binding.bossTabIds)
      || !sameIds(sortedBrowserTabIds(tabs.map((tab) => tab.id)), binding.tabIds)) {
      throw detailError("BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED", "BOSS fixed-tab baseline was not restored");
    }
    return fixed;
  } catch {
    throw detailError("BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED", "BOSS fixed-tab baseline was not restored");
  }
}

function isOnlyLingeringClosedTarget(tabs, binding, detailTabId) {
  try {
    if (!isBrowserTabId(detailTabId) || tabs.length !== binding.tabIds.length + 1) return false;
    const extra = tabs.filter((tab) => !binding.tabIds.some((id) => sameBrowserTabId(id, tab.id)));
    if (extra.length !== 1
      || !sameBrowserTabId(extra[0].id, detailTabId)
      || extra[0].windowId !== binding.windowId
      || extra[0].active === true
      || !binding.tabIds.every((id) => tabs.some((tab) => sameBrowserTabId(id, tab.id)))
      || !sameIds(visibleTabIdsInWindow(tabs, binding.windowId), binding.visibleTabIds)) return false;
    assertFixedTabsPresent(tabs, binding);
    return true;
  } catch {
    return false;
  }
}

function optionalCreatedTargetTab(before, after, target) {
  const candidates = after.filter((tab) => !before.some((item) => sameBrowserTabId(item.id, tab.id))
    && isBrowserTabId(tab.id)
    && isTargetDetailTab(tab, target));
  if (candidates.length > 1) {
    throw detailError("BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED", "background detail cleanup is ambiguous");
  }
  return candidates[0] || null;
}

function assertBackgroundCreation({ returnedTabId, beforeTabs, afterCreate, binding }) {
  const newTabs = afterCreate.filter((tab) => !beforeTabs.some((item) => sameBrowserTabId(item.id, tab.id)));
  const created = newTabs[0];
  if (!isBrowserTabId(returnedTabId)
    || newTabs.length !== 1
    || !isBrowserTabId(created?.id)
    || !sameBrowserTabId(returnedTabId, created.id)
    || typeof returnedTabId !== typeof binding.communicationTabId
    || created.windowId !== binding.windowId
    || created.active === true
    || !sameIds(visibleTabIdsInWindow(afterCreate, binding.windowId), binding.visibleTabIds)) {
    throw detailError("BOSS_MESSAGE_DETAIL_NOT_BACKGROUND", "background detail tab safety could not be proven");
  }
  assertFixedTabsPresent(afterCreate, binding);
  return created;
}

function assertLiveDetailBinding(tabs, binding, detailTabId, target) {
  const detailTabs = tabs.filter((tab) => isTargetDetailTab(tab, target));
  if (detailTabs.length !== 1
    || !sameBrowserTabId(detailTabs[0].id, detailTabId)
    || detailTabs[0].windowId !== binding.windowId
    || detailTabs[0].active === true
    || !sameIds(visibleTabIdsInWindow(tabs, binding.windowId), binding.visibleTabIds)) {
    throw detailError("BOSS_MESSAGE_DETAIL_NOT_BACKGROUND", "background detail tab safety changed during read");
  }
  assertFixedTabsPresent(tabs, binding);
}

function assertFixedTabsPresent(tabs, binding) {
  const search = tabs.find((tab) => sameBrowserTabId(tab.id, binding.searchTabId));
  const communication = tabs.find((tab) => sameBrowserTabId(tab.id, binding.communicationTabId));
  if (!search || !communication
    || search.windowId !== binding.windowId
    || communication.windowId !== binding.windowId
    || bossPath(search) !== "/web/geek/jobs"
    || bossPath(communication) !== "/web/geek/chat") {
    throw detailError("BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED", "BOSS fixed tabs changed during detail read");
  }
}

function visibleTabIdsInWindow(tabs, windowId) {
  const visible = tabs.filter((tab) => tab.windowId === windowId && tab.active === true);
  const ids = sortedBrowserTabIds(visible.map((tab) => tab.id));
  if (visible.length > 1 || ids.length !== visible.length) {
    throw detailError("BOSS_MESSAGE_DETAIL_NOT_BACKGROUND", "visible Edge tab identity is ambiguous");
  }
  return ids;
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

function sameIds(left, right) {
  return left.length === right.length
    && left.every((id, index) => sameBrowserTabId(id, right[index]));
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
