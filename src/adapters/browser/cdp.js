const DEFAULT_TIMEOUT_MS = 15000;
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
  }

  async listTabs() {
    const pages = await this.requestJson("/json/list");
    if (!Array.isArray(pages)) {
      throw browserError("BROWSER_COMMAND_FAILED", "CDP tab list response is not an array.");
    }
    return pages
      .filter((page) => page.type === "page" && page.webSocketDebuggerUrl)
      .map((page, index) => ({
        id: page.id,
        title: page.title || "",
        url: page.url || "",
        active: index === 0,
        webSocketDebuggerUrl: page.webSocketDebuggerUrl
      }));
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
    const tab = await this.findTab(tabId);
    return sendCdp(tab.webSocketDebuggerUrl, method, params, this.timeoutMs);
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
    const tabs = await this.listTabs();
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) throw browserError("BROWSER_COMMAND_FAILED", `CDP tab not found: ${tabId}`);
    return tab;
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

function sendCdp(wsUrl, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = 1;
    let settled = false;
    let timer;
    let ws;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tryClose(ws);
      if (error) reject(error);
      else resolve(value);
    };

    try {
      ws = new WebSocket(wsUrl);
      timer = setTimeout(() => {
        finish(browserError("BROWSER_TIMEOUT", `${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      ws.addEventListener("open", () => {
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          finish(browserError("BROWSER_DISCONNECTED", `${method} could not be sent because the browser disconnected.`, error));
        }
      });

      ws.addEventListener("message", (event) => {
        Promise.resolve(readMessageData(event.data)).then((text) => {
          let data;
          try {
            data = JSON.parse(text);
          } catch (error) {
            finish(browserError("BROWSER_COMMAND_FAILED", `${method} returned invalid JSON.`, error));
            return;
          }
          if (data.id !== id) return;
          if (data.error) {
            finish(browserError("BROWSER_COMMAND_FAILED", `${method} failed: ${JSON.stringify(data.error)}`));
          } else {
            finish(null, data.result ?? data);
          }
        }, (error) => {
          finish(browserError("BROWSER_COMMAND_FAILED", `${method} response could not be read.`, error));
        });
      });

      ws.addEventListener("error", (event) => {
        finish(browserError("BROWSER_DISCONNECTED", `${method} websocket error.`, event?.error));
      });

      ws.addEventListener("close", (event) => {
        const detail = event?.code ? ` (code ${event.code}${event.reason ? `: ${event.reason}` : ""})` : "";
        finish(browserError("BROWSER_DISCONNECTED", `${method} websocket closed before a response${detail}.`));
      });
    } catch (error) {
      finish(browserError("BROWSER_DISCONNECTED", `${method} websocket could not connect.`, error));
    }
  });
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

module.exports = { CdpBrowserAdapter };
