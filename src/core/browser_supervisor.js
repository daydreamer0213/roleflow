const STATE_DETAILS = Object.freeze({
  unknown: Object.freeze({ ready: false, message: "尚未检查 RoleFlow 专用 Edge。", action: "none" }),
  starting: Object.freeze({ ready: false, message: "正在准备 RoleFlow 专用 Edge……", action: "none" }),
  ready: Object.freeze({ ready: true, message: "RoleFlow 专用 Edge 已准备好。", action: "none" }),
  unavailable: Object.freeze({ ready: false, message: "RoleFlow 专用 Edge 暂时无法使用。", action: "install_edge" }),
  conflict: Object.freeze({ ready: false, message: "RoleFlow 专用 Edge 存在本地冲突，未改动任何浏览器。", action: "view_help" }),
  stopped: Object.freeze({ ready: false, message: "RoleFlow 专用 Edge 已关闭，已保留当前进度。", action: "recover" }),
  needs_attention: Object.freeze({ ready: false, message: "RoleFlow 专用 Edge 需要处理后才能继续。", action: "view_diagnostics" })
});

const UNAVAILABLE_CODES = new Set([
  "PORTABLE_EDGE_NOT_FOUND",
  "PORTABLE_EDGE_START_FAILED",
  "PORTABLE_EDGE_START_TIMEOUT"
]);

function createBrowserSupervisor({
  ensureBrowser,
  inspectBrowser,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  now = () => new Date().toISOString(),
  logger = null,
  monitorIntervalMs = 5000
} = {}) {
  if (typeof ensureBrowser !== "function" || typeof inspectBrowser !== "function") {
    throw new TypeError("createBrowserSupervisor requires ensureBrowser() and inspectBrowser()");
  }

  let snapshot = makeSnapshot("unknown", now);
  let session = null;
  let pendingEnsure = null;
  let monitor = null;
  let closed = false;

  function getSnapshot() {
    return { ...snapshot };
  }

  function clearMonitor() {
    if (monitor === null) return;
    cancelSchedule(monitor);
    monitor = null;
  }

  function scheduleMonitor() {
    clearMonitor();
    if (closed || !session) return;
    monitor = schedule(() => {
      monitor = null;
      void inspect().then((current) => {
        if (current.ready) scheduleMonitor();
      });
    }, monitorIntervalMs);
  }

  function ensure({ dashboardUrl = "", reason = "startup" } = {}) {
    if (pendingEnsure) return pendingEnsure;
    closed = false;
    clearMonitor();
    snapshot = makeSnapshot("starting", now, {
      failureCount: snapshot.failureCount,
      sessionId: session?.sessionId || ""
    });
    pendingEnsure = (async () => {
      try {
        const nextSession = await ensureBrowser({ dashboardUrl, reason });
        await inspectBrowser(nextSession);
        session = nextSession;
        snapshot = makeSnapshot("ready", now, { sessionId: session?.sessionId || "" });
        logger?.info?.("browser_runtime_ready", { reason, sessionId: snapshot.sessionId });
        scheduleMonitor();
      } catch (error) {
        snapshot = errorSnapshot(error, now, {
          hadSession: Boolean(session),
          failureCount: snapshot.failureCount + 1,
          sessionId: session?.sessionId || ""
        });
        logger?.warn?.("browser_runtime_not_ready", {
          reason,
          status: snapshot.status,
          errorCode: String(error?.code || "BROWSER_RUNTIME_FAILED")
        });
      } finally {
        pendingEnsure = null;
      }
      return getSnapshot();
    })();
    return pendingEnsure;
  }

  async function inspect() {
    if (!session) return getSnapshot();
    try {
      await inspectBrowser(session);
      snapshot = makeSnapshot("ready", now, { sessionId: session.sessionId || "" });
    } catch (error) {
      snapshot = errorSnapshot(error, now, {
        hadSession: true,
        failureCount: snapshot.failureCount + 1,
        sessionId: session.sessionId || ""
      });
      logger?.warn?.("browser_runtime_inspection_failed", {
        status: snapshot.status,
        errorCode: String(error?.code || "BROWSER_RUNTIME_FAILED")
      });
    }
    return getSnapshot();
  }

  function close() {
    closed = true;
    clearMonitor();
  }

  return { start: ensure, ensure, inspect, getSnapshot, close };
}

function makeSnapshot(status, now, { failureCount = 0, sessionId = "" } = {}) {
  const detail = STATE_DETAILS[status];
  if (!detail) throw new TypeError(`Unknown browser runtime status: ${status}`);
  return {
    status,
    ready: detail.ready,
    message: detail.message,
    action: detail.action,
    checkedAt: now(),
    failureCount,
    sessionId: String(sessionId || "")
  };
}

function errorSnapshot(error, now, { hadSession, failureCount, sessionId }) {
  const code = String(error?.code || "");
  if (isTransportError(code)) {
    return makeSnapshot(hadSession ? "stopped" : "unavailable", now, { failureCount, sessionId });
  }
  if (UNAVAILABLE_CODES.has(code)) {
    return makeSnapshot("unavailable", now, { failureCount, sessionId });
  }
  if (isIdentityConflict(code)) {
    return makeSnapshot("conflict", now, { failureCount, sessionId });
  }
  return makeSnapshot("needs_attention", now, { failureCount, sessionId });
}

function isTransportError(code) {
  return ["BROWSER_DISCONNECTED", "BROWSER_TIMEOUT", "BROWSER_COMMAND_FAILED"].includes(code);
}

function isIdentityConflict(code) {
  return code === "ROLEFLOW_BROWSER_PROFILE_IN_USE"
    || code === "DASHBOARD_BROWSER_AUTHORITY_MISMATCH"
    || code.startsWith("PORTABLE_EDGE_PORT_")
    || code.startsWith("PORTABLE_EDGE_LISTENER_")
    || code.startsWith("PORTABLE_EDGE_IDENTITY_");
}

module.exports = { createBrowserSupervisor };
