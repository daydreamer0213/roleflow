const DEFAULT_TIMEOUT_MS = 15000;
const { sameBrowserTabId, sortedBrowserTabIds } = require("../../core/browser_tab_identity");
const { CdpNetworkLog } = require("./cdp_network_log");
const BROWSER_ERROR_CODES = new Set([
  "BROWSER_TIMEOUT",
  "BROWSER_DISCONNECTED",
  "BROWSER_COMMAND_FAILED"
]);

class CdpBrowserAdapter {
  constructor({ host = "127.0.0.1", port = 9222, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.host = host;
    this.port = Number(port || 9222);
    this.timeoutMs = positiveTimeout(timeoutMs);
    this.networkObservers = new Map();
    this.focusScopes = new Map();
  }

  async listTabs({ scope = "all" } = {}) {
    const pages = await this.requestJson("/json/list");
    if (!Array.isArray(pages)) {
      throw browserError("BROWSER_COMMAND_FAILED", "CDP tab list response is not an array.");
    }
    if (!new Set(["all", "boss"]).has(scope)) {
      throw browserError("BROWSER_COMMAND_FAILED", `Unsupported CDP tab scope: ${scope}`);
    }
    const pageTabs = pages.filter((page) => page.type === "page"
      && page.webSocketDebuggerUrl
      && (scope !== "boss" || isBossPageTarget(page)));
    let firstError = null;
    const listedTabs = await Promise.all(pageTabs.map(async (page) => {
      try {
        const windowId = await this.windowIdForTarget(page.id);
        const visibilityState = await this.visibilityStateForPage(page);
        return {
          id: page.id,
          title: page.title || "",
          url: page.url || "",
          active: visibilityState === "visible",
          windowId,
          webSocketDebuggerUrl: page.webSocketDebuggerUrl
        };
      } catch (error) {
        if (isWindowlessEdgeInternalTarget(page, error)) return null;
        firstError ||= error;
        return null;
      }
    }));
    if (firstError) throw firstError;
    return listedTabs.filter(Boolean);
  }

  async inspectTransport() {
    const [version, pages] = await Promise.all([
      this.requestJson("/json/version"),
      this.requestJson("/json/list")
    ]);
    if (!version?.webSocketDebuggerUrl || !Array.isArray(pages)) {
      throw browserError("BROWSER_COMMAND_FAILED", "CDP readiness response is incomplete.");
    }
    await this.browserCommand("Browser.getVersion");
    return {
      browser: String(version.Browser || ""),
      pageCount: pages.filter((page) => page.type === "page").length
    };
  }

  async browserCommand(method, params = {}) {
    const version = await this.requestJson("/json/version");
    if (!version?.webSocketDebuggerUrl) {
      throw browserError("BROWSER_COMMAND_FAILED", "CDP browser version response has no browser websocket URL.");
    }
    return sendCdp(version.webSocketDebuggerUrl, method, params, this.timeoutMs);
  }

  async windowIdForTarget(targetId) {
    const result = await this.browserCommand("Browser.getWindowForTarget", {
      targetId
    });
    if (!Number.isInteger(result?.windowId)) {
      throw browserError("BROWSER_COMMAND_FAILED", `CDP target has no reliable browser window identity: ${targetId}`);
    }
    return result.windowId;
  }

  async visibilityStateForPage(page) {
    let result;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await sendCdp(
          page.webSocketDebuggerUrl,
          "Runtime.evaluate",
          { expression: "document.visibilityState", returnByValue: true },
          this.timeoutMs
        );
        break;
      } catch (error) {
        if (attempt === 1 || !isRetryableReadError(error)) throw error;
        await retryReadDelay();
      }
    }
    const state = result?.result?.value;
    if (!new Set(["visible", "hidden"]).has(state)) {
      throw browserError("BROWSER_COMMAND_FAILED", `CDP page visibility is unavailable: ${page.id}`);
    }
    return state;
  }

  async activeTabId() {
    const tabs = await this.listTabs();
    const tab = tabs.find((item) => item.active && /zhipin\.com\/web\/geek\/jobs/i.test(item.url))
      || tabs.find((item) => /zhipin\.com\/web\/geek\/jobs/i.test(item.url))
      || tabs.find((item) => item.active && /zhipin\.com/i.test(item.url))
      || tabs.find((item) => /zhipin\.com/i.test(item.url))
      || tabs[0];
    if (!tab) throw browserError("BROWSER_COMMAND_FAILED", "CDP browser has no controllable page. Start portable Edge first.");
    return tab.id;
  }

  async navigate(tabId, url) {
    return this.cdp(tabId, "Page.navigate", { url });
  }

  async setPageLifecycleActive(tabId) {
    return this.cdp(tabId, "Page.setWebLifecycleState", { state: "active" });
  }

  async createTab(openerTabId, url = "about:blank") {
    const beforeTabs = await this.listTabs();
    const opener = beforeTabs.find((tab) => sameBrowserTabId(tab.id, openerTabId));
    if (!opener) throw browserError("BROWSER_COMMAND_FAILED", `CDP tab not found: ${openerTabId}`);
    const visibleBefore = sortedBrowserTabIds(beforeTabs
      .filter((tab) => tab.windowId === opener.windowId && tab.active)
      .map((tab) => tab.id));
    if (visibleBefore.length > 1) {
      throw browserError("BROWSER_COMMAND_FAILED", "CDP tab creation requires at most one visible page in the opener window.");
    }
    const result = await this.browserCommand("Target.createTarget", {
      url: String(url || "about:blank"),
      newWindow: false,
      background: true
    });
    if (!result?.targetId) throw browserError("BROWSER_COMMAND_FAILED", "Browser did not return a new tab id.");
    const targetId = result.targetId;
    try {
      const afterTabs = await this.listTabs();
      const created = afterTabs.find((tab) => sameBrowserTabId(tab.id, targetId));
      if (!created) {
        throw browserError("BROWSER_COMMAND_FAILED", "CDP created tab could not be verified.");
      }
      if (created.windowId !== opener.windowId) {
        throw browserError("BROWSER_COMMAND_FAILED", "CDP created the tab in a different browser window.");
      }
      if (created.active) {
        throw browserError("BROWSER_COMMAND_FAILED", "CDP created tab unexpectedly became visible.");
      }
      const visibleAfter = sortedBrowserTabIds(afterTabs
        .filter((tab) => tab.windowId === opener.windowId && tab.active)
        .map((tab) => tab.id));
      if (!sameBrowserTabIdList(visibleAfter, visibleBefore)) {
        throw browserError("BROWSER_COMMAND_FAILED", "CDP tab creation changed the visible page.");
      }
      return targetId;
    } catch (error) {
      let closeError = null;
      try {
        await this.closeTab(targetId);
        const restoredTabs = await this.listTabs();
        const restoredIds = sortedBrowserTabIds(restoredTabs.map((tab) => tab.id));
        const beforeIds = sortedBrowserTabIds(beforeTabs.map((tab) => tab.id));
        const restoredVisible = sortedBrowserTabIds(restoredTabs
          .filter((tab) => tab.windowId === opener.windowId && tab.active)
          .map((tab) => tab.id));
        if (!sameBrowserTabIdList(restoredIds, beforeIds)
          || !sameBrowserTabIdList(restoredVisible, visibleBefore)) {
          throw browserError("BROWSER_COMMAND_FAILED", "CDP cleanup did not restore the original typed tab baseline.");
        }
      } catch (cleanupError) {
        closeError = cleanupError;
      }
      if (closeError) appendTargetCleanupFailure(error, { targetId, closeError });
      throw error;
    }
  }

  async closeTab(tabId) {
    this.releaseFocusScope(tabId);
    await this.stopNetworkLog(tabId);
    const result = await this.browserCommand("Target.closeTarget", { targetId: tabId });
    if (result?.success !== true) {
      throw browserError("BROWSER_COMMAND_FAILED", "CDP did not confirm that the tab was closed.");
    }
    return result;
  }

  async bringToFront(tabId) {
    return this.cdp(tabId, "Page.bringToFront");
  }

  async clickAt(tabId, { x, y }) {
    const point = { x: Number(x), y: Number(y) };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw browserError("BROWSER_COMMAND_FAILED", "Click coordinates must be finite numbers.");
    }
    await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    return this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  }

  async startNetworkLog(tabId, options = {}) {
    await this.stopNetworkLog(tabId);
    const tab = await this.findTab(tabId);
    let observer;
    observer = new CdpNetworkLog({
      wsUrl: tab.webSocketDebuggerUrl,
      timeoutMs: this.timeoutMs,
      options,
      onFatal: () => {
        if (this.networkObservers.get(tabId) === observer) this.networkObservers.delete(tabId);
      }
    });
    this.networkObservers.set(tabId, observer);
    try {
      return await observer.start();
    } catch (error) {
      if (this.networkObservers.get(tabId) === observer) this.networkObservers.delete(tabId);
      throw error;
    }
  }

  async getNetworkLogMark(tabId) {
    return this.requireNetworkObserver(tabId).getMark();
  }

  async readNetworkLog(tabId, options = {}) {
    return this.requireNetworkObserver(tabId).read(options);
  }

  async stopNetworkLog(tabId) {
    const observer = this.networkObservers.get(tabId);
    if (!observer) return { stopped: true };
    this.networkObservers.delete(tabId);
    return observer.stop();
  }

  requireNetworkObserver(tabId) {
    const observer = this.networkObservers.get(tabId);
    if (!observer) throw browserError("BROWSER_COMMAND_FAILED", "CDP network observer is not active.");
    return observer;
  }

  async cdp(tabId, method, params = {}) {
    let tab;
    try {
      tab = await this.findTab(tabId);
    } catch (error) {
      this.releaseFocusScope(tabId);
      throw error;
    }
    const isFocusCommand = method === "Emulation.setFocusEmulationEnabled";
    const isFocusEnable = isFocusCommand && params?.enabled === true;
    const isFocusDisable = isFocusCommand && params?.enabled === false;
    let scope = this.focusScopes.get(tab.id);
    if (scope?.failure) {
      if (isFocusDisable) {
        this.releaseFocusScope(tab.id, scope);
        return {};
      }
      throw scope.failure;
    }
    if (isFocusEnable && !scope) {
      scope = await openCdpConnection(tab.webSocketDebuggerUrl, this.timeoutMs, method);
      this.focusScopes.set(tab.id, scope);
    }
    if (!scope) return sendCdp(tab.webSocketDebuggerUrl, method, params, this.timeoutMs);
    try {
      return await scope.command(method, params);
    } catch (error) {
      scope.fail(error);
      throw error;
    } finally {
      if (isFocusDisable) this.releaseFocusScope(tab.id, scope);
    }
  }

  releaseFocusScope(tabId, expectedScope = null) {
    const entry = expectedScope
      ? [tabId, expectedScope]
      : [...this.focusScopes].find(([id]) => sameBrowserTabId(id, tabId));
    if (!entry) return;
    const [id, scope] = entry;
    if (this.focusScopes.get(id) === scope) this.focusScopes.delete(id);
    scope.close();
  }

  async evalValue(tabId, expression) {
    const result = await this.cdp(tabId, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw browserError("BROWSER_COMMAND_FAILED", JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
  }

  async findTab(tabId) {
    const pages = await this.requestJson("/json/list");
    if (!Array.isArray(pages)) {
      throw browserError("BROWSER_COMMAND_FAILED", "CDP tab list response is not an array.");
    }
    const tab = pages.find((page) => page.type === "page"
      && page.webSocketDebuggerUrl
      && sameBrowserTabId(page.id, tabId));
    if (!tab) throw browserError("BROWSER_COMMAND_FAILED", `CDP tab not found: ${tabId}`);
    return {
      id: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      webSocketDebuggerUrl: tab.webSocketDebuggerUrl
    };
  }

  async requestJson(path) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.requestJsonOnce(path);
      } catch (error) {
        if (attempt === 1 || !isRetryableReadError(error)) throw error;
        await retryReadDelay();
      }
    }
  }

  async requestJsonOnce(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`http://${this.host}:${this.port}${path}`, {
        signal: controller.signal
      });
      const text = await res.text();
      if (!res.ok) {
        const error = browserError("BROWSER_COMMAND_FAILED", `CDP request failed: ${res.status} ${text}`);
        error.status = res.status;
        throw error;
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        throw browserError("BROWSER_COMMAND_FAILED", "CDP request returned invalid JSON.", error);
      }
    } catch (error) {
      if (BROWSER_ERROR_CODES.has(error?.code)) throw error;
      if (controller.signal.aborted || isTimeoutError(error)) {
        throw browserError("BROWSER_TIMEOUT", `CDP request timed out after ${this.timeoutMs}ms.`, error);
      }
      throw browserError("BROWSER_DISCONNECTED", `CDP browser is not available on ${this.host}:${this.port}: ${error?.message || error}`, error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function isBossPageTarget(page) {
  try {
    const url = new URL(String(page?.url || ""));
    return url.protocol === "https:" && /(^|\.)zhipin\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

async function sendCdp(wsUrl, method, params, timeoutMs) {
  const connection = await openCdpConnection(wsUrl, timeoutMs, method);
  try {
    return await connection.command(method, params);
  } finally {
    connection.close();
  }
}

async function openCdpConnection(wsUrl, timeoutMs, method) {
  const connection = new CdpConnection(wsUrl, timeoutMs);
  try {
    await connection.open(method);
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

class CdpConnection {
  constructor(wsUrl, timeoutMs) {
    this.wsUrl = wsUrl;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.opened = false;
    this.closed = false;
    this.commandId = 0;
    this.pending = new Map();
    this.listeners = [];
    this.failure = null;
  }

  open(method) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(browserError(
        "BROWSER_TIMEOUT",
        `${method} timed out after ${this.timeoutMs}ms.`
      )), this.timeoutMs);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      try {
        this.socket = new WebSocket(this.wsUrl);
        this.listen("open", () => {
          this.opened = true;
          finish();
        });
        this.listen("message", (event) => {
          Promise.resolve(readMessageData(event.data)).then(
            (text) => this.handleMessage(text),
            (error) => this.fail(browserError("BROWSER_COMMAND_FAILED", "CDP websocket response could not be read.", error))
          );
        });
        this.listen("error", (event) => {
          const error = browserError("BROWSER_DISCONNECTED", "CDP websocket error.", event?.error);
          this.fail(error);
          finish(error);
        });
        this.listen("close", (event) => {
          const detail = event?.code ? ` (code ${event.code}${event.reason ? `: ${event.reason}` : ""})` : "";
          const error = browserError("BROWSER_DISCONNECTED", `CDP websocket closed before a response${detail}.`);
          this.fail(error);
          finish(error);
        });
      } catch (error) {
        const connectionError = browserError("BROWSER_DISCONNECTED", `${method} websocket could not connect.`, error);
        this.fail(connectionError);
        finish(connectionError);
      }
    });
  }

  command(method, params) {
    if (!this.opened || this.closed || !this.socket) {
      return Promise.reject(browserError("BROWSER_DISCONNECTED", `${method} websocket is not available.`));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.commandId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(browserError("BROWSER_TIMEOUT", `${method} timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.fail(browserError("BROWSER_DISCONNECTED", `${method} could not be sent because the browser disconnected.`, error));
      }
    });
  }

  handleMessage(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      this.fail(browserError("BROWSER_COMMAND_FAILED", "CDP websocket returned invalid JSON.", error));
      return;
    }
    const pending = this.pending.get(data.id);
    if (!pending) return;
    this.pending.delete(data.id);
    if (data.error) {
      pending.reject(browserError("BROWSER_COMMAND_FAILED", `${pending.method} failed: ${JSON.stringify(data.error)}`));
    } else {
      pending.resolve(data.result ?? data);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.opened = false;
    this.rejectPending(browserError("BROWSER_DISCONNECTED", "CDP websocket was closed."));
    this.removeListeners();
    tryClose(this.socket);
  }

  fail(error) {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.opened = false;
    this.rejectPending(error);
    this.removeListeners();
    tryClose(this.socket);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  listen(type, listener) {
    this.socket.addEventListener(type, listener);
    this.listeners.push([type, listener]);
  }

  removeListeners() {
    for (const [type, listener] of this.listeners) this.socket?.removeEventListener?.(type, listener);
    this.listeners = [];
  }
}

async function readMessageData(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (data?.arrayBuffer) return Buffer.from(await data.arrayBuffer()).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function tryClose(ws) {
  try {
    ws?.close();
  } catch {
    // Ignore close races.
  }
}

function browserError(code, message, cause) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function appendTargetCleanupFailure(primaryError, {
  targetId,
  closeResult = null,
  closeError = null,
  confirmationError = null
}) {
  const detail = confirmationError
    ? `无法确认残留标签页是否已关闭：${confirmationError.message || confirmationError}`
    : closeError
      ? `Target.closeTarget 失败：${closeError.message || closeError}`
      : `Target.closeTarget 返回 success=${String(closeResult?.success)}`;
  const guidance = "请在 RoleFlow 专用 Edge（推荐）中手动关闭本次残留标签页；如出现额外窗口，也请关闭多余窗口后重新运行 Start.bat。";
  primaryError.message = `${primaryError.message}\n\n清理失败：${detail}。${guidance}`;
  primaryError.cleanupError = {
    code: "BROWSER_TARGET_CLEANUP_FAILED",
    targetId: String(targetId || ""),
    message: detail
  };
}

function sameBrowserTabIdList(left, right) {
  return left.length === right.length
    && left.every((value, index) => sameBrowserTabId(value, right[index]));
}

function positiveTimeout(value) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

function isRetryableReadError(error) {
  return error?.code === "BROWSER_TIMEOUT"
    || error?.code === "BROWSER_DISCONNECTED"
    || error?.status === 408
    || error?.status === 429
    || error?.status >= 500;
}

function isWindowlessEdgeInternalTarget(page, error) {
  return /^edge:/i.test(String(page?.url || ""))
    && error?.code === "BROWSER_COMMAND_FAILED"
    && /Browser window not found/i.test(String(error.message || ""));
}

function isTimeoutError(error) {
  const name = error?.name || error?.cause?.name || "";
  const code = error?.code || error?.cause?.code || "";
  return name === "AbortError"
    || name === "TimeoutError"
    || ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code);
}

function retryReadDelay() {
  return new Promise((resolve) => setTimeout(resolve, 40 + Math.floor(Math.random() * 41)));
}

module.exports = { CdpBrowserAdapter };
