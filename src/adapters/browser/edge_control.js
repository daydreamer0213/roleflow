const fs = require("fs");
const path = require("path");

class EdgeControlAdapter {
  constructor() {
    const cfgPath = path.join(process.env.APPDATA || "", "CodexEdgeControl", "config.json");
    if (!fs.existsSync(cfgPath)) {
      throw new Error(`Edge Control 配置不存在：${cfgPath}。JSON input 模式不受影响。`);
    }
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, ""));
    this.port = cfg.port || 47173;
    this.token = cfg.token || cfg.authToken || cfg.edgeControlToken;
    if (!this.token) throw new Error("Edge Control config.json 缺少 token。JSON input 模式不受影响。");
  }

  async command(command, args = {}) {
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${this.port}/api/command`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-edge-control-token": this.token
        },
        body: JSON.stringify({ command, args })
      });
    } catch (error) {
      throw new Error(`Edge Control bridge 不可用：${error.message}`);
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok || data.ok === false || data.error) {
      throw new Error(`${command} 失败：${text}`);
    }
    return data.result ?? data;
  }

  async listTabs() {
    return this.command("list_tabs");
  }

  async activeTabId() {
    const tabs = await this.listTabs();
    const tab = chooseAutomationTab(tabs);
    if (!tab) throw new Error("Edge Control 未发现可用标签页。");
    return tab.id;
  }

  async navigate(tabId, url) {
    return this.command("navigate", { tabId, url });
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
      throw new Error(JSON.stringify(result.exceptionDetails));
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

module.exports = { EdgeControlAdapter, chooseAutomationTab };
