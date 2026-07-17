const fs = require("fs");
const path = require("path");

const DEFAULT_TIMEOUT_MS = 15000;
const BROWSER_ERROR_CODES = new Set([
  "BROWSER_TIMEOUT",
  "BROWSER_DISCONNECTED",
  "BROWSER_COMMAND_FAILED"
]);

class EdgeControlAdapter {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const cfgPath = path.join(process.env.APPDATA || "", "CodexEdgeControl", "config.json");
    if (!fs.existsSync(cfgPath)) {
      throw browserError("BROWSER_DISCONNECTED", `Edge Control 配置不存在：${cfgPath}。JSON input 模式不受影响。`);
    }
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
      throw browserError("BROWSER_COMMAND_FAILED", `Edge Control 配置无法读取：${cfgPath}。`, error);
    }
    this.port = cfg.port || 47173;
    this.token = cfg.token || cfg.authToken || cfg.edgeControlToken;
    this.timeoutMs = positiveTimeout(timeoutMs);
    if (!this.token) {
      throw browserError("BROWSER_COMMAND_FAILED", "Edge Control config.json 缺少 token。JSON input 模式不受影响。");
    }
  }

  async command(command, args = {}) {
    const maxAttempts = command === "list_tabs" ? 2 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.requestCommand(command, args);
      } catch (error) {
        if (attempt + 1 >= maxAttempts || !isRetryableReadError(error)) throw error;
        await retryReadDelay();
      }
    }
  }

  async requestCommand(command, args) {
    let body;
    try {
      body = JSON.stringify({ command, args });
    } catch (error) {
      throw browserError("BROWSER_COMMAND_FAILED", `${command} arguments are not serializable.`, error);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/api/command`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-edge-control-token": this.token
        },
        signal: controller.signal,
        body
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      if (!res.ok || data.ok === false || data.error) {
        const error = browserError("BROWSER_COMMAND_FAILED", `${command} failed: ${text || `HTTP ${res.status}`}`);
        error.status = res.status;
        throw error;
      }
      return data.result ?? data;
    } catch (error) {
      if (BROWSER_ERROR_CODES.has(error?.code)) throw error;
      if (controller.signal.aborted || isTimeoutError(error)) {
        throw browserError("BROWSER_TIMEOUT", `${command} timed out after ${this.timeoutMs}ms.`, error);
      }
      throw browserError("BROWSER_DISCONNECTED", `Edge Control bridge 不可用：${error?.message || error}`, error);
    } finally {
      clearTimeout(timer);
    }
  }

  async listTabs() {
    const tabs = await this.command("list_tabs");
    if (!Array.isArray(tabs)) {
      throw browserError("BROWSER_COMMAND_FAILED", "Edge Control 标签页响应不是数组。");
    }
    return tabs;
  }

  async activeTabId() {
    const tabs = await this.listTabs();
    const tab = chooseAutomationTab(tabs);
    if (!tab) throw browserError("BROWSER_COMMAND_FAILED", "Edge Control 未发现可用标签页。");
    return tab.id;
  }

  async navigate(tabId, url) {
    return this.command("navigate", { tabId, url });
  }

  async createTab(openerTabId, url = "about:blank") {
    const result = await this.cdp(openerTabId, "Target.createTarget", { url: String(url || "about:blank") });
    if (!result?.targetId) throw browserError("BROWSER_COMMAND_FAILED", "Browser did not return a new tab id.");
    return result.targetId;
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

  async cdp(tabId, method, params = {}) {
    const result = await this.command("send_cdp", { tabId, method, params });
    return result.result ?? result;
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
}

function chooseAutomationTab(tabs = []) {
  return tabs.find((item) => item.active && /zhipin\.com\/web\/geek\/jobs/i.test(String(item.url || "")))
    || tabs.find((item) => /zhipin\.com\/web\/geek\/jobs/i.test(String(item.url || "")))
    || tabs.find((item) => item.active && /zhipin\.com\//i.test(String(item.url || "")))
    || tabs.find((item) => /zhipin\.com\//i.test(String(item.url || "")))
    || tabs.find((item) => item.active)
    || tabs[0]
    || null;
}

function browserError(code, message, cause) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
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

module.exports = { EdgeControlAdapter, chooseAutomationTab };
