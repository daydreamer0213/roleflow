class CdpBrowserAdapter {
  constructor({ host = "127.0.0.1", port = 9222 } = {}) {
    this.host = host;
    this.port = Number(port || 9222);
  }

  async listTabs() {
    const pages = await this.requestJson("/json/list");
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
    const tab = tabs.find((item) => /zhipin\.com/.test(item.url)) || tabs[0];
    if (!tab) throw new Error("CDP browser has no controllable page. Start portable Edge first.");
    return tab.id;
  }

  async navigate(tabId, url) {
    return this.cdp(tabId, "Page.navigate", { url });
  }

  async cdp(tabId, method, params = {}) {
    const tab = await this.findTab(tabId);
    return sendCdp(tab.webSocketDebuggerUrl, method, params);
  }

  async evalValue(tabId, expression) {
    const result = await this.cdp(tabId, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
  }

  async findTab(tabId) {
    const tabs = await this.listTabs();
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) throw new Error(`CDP tab not found: ${tabId}`);
    return tab;
  }

  async requestJson(path) {
    let res;
    try {
      res = await fetch(`http://${this.host}:${this.port}${path}`);
    } catch (error) {
      throw new Error(`CDP browser is not available on ${this.host}:${this.port}: ${error.message}`);
    }
    if (!res.ok) {
      throw new Error(`CDP request failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }
}

function sendCdp(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const id = 1;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      tryClose(ws);
      reject(new Error(`${method} timed out`));
    }, 15000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, method, params }));
    });

    ws.addEventListener("message", async (event) => {
      const text = await readMessageData(event.data);
      const data = JSON.parse(text);
      if (data.id !== id) return;
      clearTimeout(timer);
      tryClose(ws);
      if (data.error) {
        reject(new Error(`${method} failed: ${JSON.stringify(data.error)}`));
      } else {
        resolve(data.result ?? data);
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${method} websocket error`));
    });
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
    ws.close();
  } catch {
    // Ignore close races.
  }
}

module.exports = { CdpBrowserAdapter };
