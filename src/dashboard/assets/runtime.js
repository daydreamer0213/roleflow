(() => {
  const region = document.querySelector("[data-runtime-status]");
  const title = document.querySelector("[data-runtime-title]");
  const message = document.querySelector("[data-runtime-message]");
  const actionButton = document.querySelector("[data-runtime-recover]");
  if (!region || !title || !message || !actionButton) return;

  let requestInFlight = false;
  let pollTimer = null;
  let actionEndpoint = "";

  function runtimeView(payload = {}) {
    const browser = payload.browser;
    const workspace = payload.workspace || { status: "unchecked" };
    if (!browser) {
      return {
        state: "local",
        title: "工作台已就绪",
        message: "浏览器会在需要岗位页面时单独检查。",
        button: "",
        endpoint: ""
      };
    }
    if (!browser.ready) {
      const stopped = browser.status === "stopped";
      const recoverable = ["unavailable", "stopped"].includes(browser.status);
      const needsAttention = ["conflict", "needs_attention"].includes(browser.status);
      return {
        state: recoverable ? "attention" : "waiting",
        title: stopped
          ? "专用 Edge 已关闭"
          : recoverable
            ? "专用 Edge 暂时不可用"
            : needsAttention
              ? "专用 Edge 需要处理"
              : "正在准备专用 Edge…",
        message: String(browser.message || "工作台可继续使用，浏览器功能暂时不可用。"),
        button: recoverable ? "恢复专用 Edge" : "",
        endpoint: recoverable ? "/api/runtime/browser/recover" : ""
      };
    }
    if (workspace.status === "ready") {
      return {
        state: "ready",
        title: "专用 Edge 和 BOSS 已就绪",
        message: "需要浏览器的岗位操作现在可以开始。",
        button: "",
        endpoint: ""
      };
    }
    const loginRequired = workspace.status === "login_required";
    return {
      state: loginRequired ? "attention" : "waiting",
      title: loginRequired ? "请在专用 Edge 登录 BOSS" : "专用 Edge 已就绪",
      message: loginRequired
        ? "登录完成后，回到这里重新检查。"
        : String(workspace.message || "BOSS 工作区尚未确认；本地资料仍可正常查看。"),
      button: "重新检查 BOSS 工作区",
      endpoint: "/api/runtime/workspace/reconcile"
    };
  }

  function render(payload) {
    const view = runtimeView(payload);
    region.dataset.state = view.state;
    title.textContent = view.title;
    message.textContent = view.message;
    actionEndpoint = view.endpoint;
    actionButton.textContent = view.button;
    actionButton.hidden = !view.button;
  }

  function schedulePoll() {
    if (document.hidden) return;
    pollTimer = setTimeout(poll, 5000);
  }

  async function request(url, options = {}) {
    if (requestInFlight || document.hidden) return;
    requestInFlight = true;
    actionButton.disabled = true;
    try {
      const response = await fetch(url, {
        ...options,
        headers: { accept: "application/json", ...(options.headers || {}) }
      });
      const payload = await response.json();
      if (!response.ok) throw Object.assign(
        new Error(String(payload?.error || "请求没有完成。")),
        { payload }
      );
      render(payload);
    } catch (error) {
      render({
        browser: {
          status: "needs_attention",
          ready: false,
          message: String(error?.payload?.error || error?.message || "暂时无法读取本地运行状态，请稍后重试。")
        },
        workspace: { status: "unchecked" }
      });
    } finally {
      requestInFlight = false;
      actionButton.disabled = false;
      schedulePoll();
    }
  }

  function poll() {
    pollTimer = null;
    return request("/api/runtime-status");
  }

  actionButton.addEventListener("click", async () => {
    if (!actionEndpoint || requestInFlight) return;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    await request(actionEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
      return;
    }
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    void poll();
  });

  void poll();
})();
