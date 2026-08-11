const { randomUUID } = require("node:crypto");
const { createBossMessageReader } = require("../adapters/sites/boss_message_reader");
const { runBossMessageDiscovery } = require("../core/message_discovery");
const { createMessageReplyAnalyzer } = require("../core/message_reply_analyzer");
const { listUnresolvedMessageDiscoveryItems } = require("../core/message_preview_state");
const {
  getSiteRuntimeState,
  setSiteRuntimeState,
  recordSiteAccessEvent
} = require("../core/storage");

const DEFAULT_CLEANUP_MS = 30 * 60 * 1000;
const ALLOWED_RUN_STATUSES = new Set(["running", "completed", "needs_user_action", "stopped"]);

function createMessageDiscoveryController(deps = {}) {
  const {
    db,
    logger = null,
    getModelConfig = () => ({ provider: "mock", providers: { mock: {} } }),
    modelReady = () => true,
    assertRuntimeAvailable = () => assertMessageDiscoveryRuntimeAvailable(db, now),
    recordRiskControl = (input) => persistMessageDiscoveryRiskControl(db, input),
    acquireLease,
    renewLease,
    releaseLease,
    browserFactory = null,
    createBrowser = browserFactory,
    cleanupBrowser = async (browser) => {
      if (browser && typeof browser.disconnect === "function") await browser.disconnect();
      else if (browser && typeof browser.cleanup === "function") await browser.cleanup();
    },
    createReader = ({ browser }) => createBossMessageReader({ browser }),
    createAnalyzer = ({ modelConfig, logger: analyzerLogger }) => createMessageReplyAnalyzer({
      adapter: createMessageModelAdapter(modelConfig, analyzerLogger)
    }),
    runDiscovery = runBossMessageDiscovery,
    now = () => new Date(),
    setTimeout: setTimeoutFn = setTimeout,
    clearTimeout: clearTimeoutFn = clearTimeout,
    setInterval: setIntervalFn = setInterval,
    clearInterval: clearIntervalFn = clearInterval
  } = deps;
  const runs = new Map();
  let closePromise = null;

  return {
    start,
    stop,
    dismiss,
    status,
    pageState,
    clearDraftForCard,
    close
  };

  function start(profileIdValue) {
    const profileId = messageDiscoveryProfileId(profileIdValue);
    if (!db) throw messageDiscoveryError("MESSAGE_DISCOVERY_CONTEXT_INVALID", "message discovery controller requires db", 500);
    const profile = db.prepare("SELECT id FROM candidate_profiles WHERE id = ?").get(profileId);
    if (!profile) throw messageDiscoveryError("MESSAGE_DISCOVERY_PROFILE_NOT_FOUND", "candidate profile was not found", 404);
    const previousRun = runs.get(profileId);
    if (previousRun?.status === "running") {
      throw messageDiscoveryError("MESSAGE_DISCOVERY_ALREADY_RUNNING", "message discovery is already running", 409);
    }
    assertRuntimeAvailable({ profileId });
    if (!modelReady()) {
      throw messageDiscoveryError(
        "MESSAGE_DISCOVERY_MODEL_NOT_READY",
        "message discovery requires a verified deep analysis model",
        409
      );
    }
    const modelConfig = getModelConfig();
    const owner = randomUUID();
    try {
      acquireLease(db, { site: "boss", owner, command: "discover-messages", planId: null });
    } catch (error) {
      if (error?.code === "SCAN_ALREADY_RUNNING"
        || /constraint|locked|lease/i.test(String(error?.message || ""))) {
        throw messageDiscoveryError("MESSAGE_DISCOVERY_LEASE_BUSY", "BOSS is already in use", 409);
      }
      throw error;
    }
    if (previousRun) {
      clearRunTimer(previousRun);
      previousRun.results = [];
      previousRun.closed = true;
    }
    const startedAt = nowDate();
    const abortController = new AbortController();
    const run = {
      profileId,
      status: "running",
      queued: 0,
      processed: 0,
      unresolved: 0,
      reasonCode: "",
      results: [],
      startedAt: startedAt.toISOString(),
      updatedAt: startedAt.toISOString(),
      expiresAt: "",
      abortController,
      cleanupTimer: null,
      clearedCardIds: new Set(),
      closed: false,
      riskRecorded: false,
      completion: null
    };
    runs.set(profileId, run);
    const heartbeatMs = Math.max(1, Number(deps.leaseHeartbeatMs) || 30_000);
    const heartbeat = setIntervalFn(() => {
      try {
        renewLease(db, { site: "boss", owner });
      } catch {
        abortController.abort(messageDiscoveryError("MESSAGE_DISCOVERY_LEASE_LOST", "BOSS lease was lost"));
      }
    }, heartbeatMs);

    let browser = null;
    run.completion = Promise.resolve().then(async () => {
      if (typeof createBrowser !== "function") {
        throw messageDiscoveryError(
          "MESSAGE_DISCOVERY_BROWSER_UNAVAILABLE",
          "message discovery requires the dashboard browser authority",
          503
        );
      }
      browser = createBrowser();
      const reader = createReader({ browser });
      const analyzer = createAnalyzer({
        modelConfig,
        logger
      });
      const summary = await runDiscovery({
        db,
        profileId,
        reader,
        signal: abortController.signal,
        logger,
        classifyMessageGroup: analyzer,
        onStatus: (status) => updateRun(run, status)
      });
      if (summary?.reasonCode === "BOSS_RISK_CONTROL") {
        recordRiskOnce(run, summary.reasonCode, "BOSS requires security verification");
      }
      updateRun(run, summary);
    }).catch((error) => {
      const code = messageDiscoveryErrorCode(error);
      if (code === "BOSS_RISK_CONTROL") recordRiskOnce(run, code, error?.message);
      if (runs.get(profileId) !== run) return;
      updateRun(run, {
        status: ["MESSAGE_DISCOVERY_LEASE_LOST", "BOSS_RISK_CONTROL"].includes(code)
          ? "needs_user_action"
          : "stopped",
        queued: run.queued,
        processed: run.processed,
        unresolved: run.unresolved,
        reasonCode: code,
        results: run.results
      });
      logger?.warn("message_discovery_stopped", {
        profileId,
        queued: run.queued,
        processed: run.processed,
        status: run.status,
        reasonCode: code
      });
    }).finally(async () => {
      clearIntervalFn(heartbeat);
      try {
        await cleanupBrowser(browser);
      } catch (error) {
        logger?.warn("message_discovery_browser_cleanup_failed", {
          profileId,
          code: messageDiscoveryErrorCode(error)
        });
      }
      try {
        releaseLease(db, { site: "boss", owner });
      } catch (error) {
        logger?.warn("message_discovery_lease_release_failed", {
          profileId,
          code: messageDiscoveryErrorCode(error)
        });
      }
    });
    return { statusCode: 202, body: publicRun(run) };
  }

  function stop(profileIdValue) {
    const profileId = messageDiscoveryProfileId(profileIdValue);
    clearExpiredRun(profileId);
    const run = runs.get(profileId);
    if (!run) throw messageDiscoveryError("MESSAGE_DISCOVERY_NOT_FOUND", "message discovery run was not found", 404);
    if (run.status !== "running") {
      throw messageDiscoveryError("MESSAGE_DISCOVERY_NOT_RUNNING", "message discovery is not running", 409);
    }
    run.abortController.abort(messageDiscoveryError("MESSAGE_DISCOVERY_STOPPED", "message discovery stopped"));
    return { statusCode: 202, body: publicRun(run) };
  }

  function dismiss(profileIdValue) {
    const profileId = messageDiscoveryProfileId(profileIdValue);
    clearExpiredRun(profileId);
    const run = runs.get(profileId);
    if (!run) throw messageDiscoveryError("MESSAGE_DISCOVERY_NOT_FOUND", "message discovery run was not found", 404);
    if (run.status === "running") {
      throw messageDiscoveryError("MESSAGE_DISCOVERY_RUNNING", "stop message discovery before dismissing drafts", 409);
    }
    clearRunTimer(run);
    run.results = [];
    run.status = run.unresolved > 0 ? "needs_user_action" : "dismissed";
    if (run.unresolved === 0) run.reasonCode = "";
    run.expiresAt = "";
    run.updatedAt = nowDate().toISOString();
    run.closed = true;
    return { statusCode: 200, body: publicRun(run) };
  }

  function status(profileIdValue) {
    const profileId = messageDiscoveryProfileId(profileIdValue);
    clearExpiredRun(profileId);
    const run = runs.get(profileId);
    return run ? publicRun(run) : durableStatus(profileId);
  }

  function pageState(profileIdValue) {
    const profileId = messageDiscoveryProfileId(profileIdValue);
    clearExpiredRun(profileId);
    const run = runs.get(profileId);
    return run ? pageRun(run) : durableStatus(profileId);
  }

  function clearDraftForCard(profileIdValue, cardIdValue) {
    const profileId = Number(profileIdValue);
    const cardId = Number(cardIdValue);
    const run = runs.get(profileId);
    if (!run) return;
    const before = run.results.length;
    run.clearedCardIds.add(cardId);
    run.results = run.results.filter((item) => Number(item.cardId) !== cardId);
    if (run.results.length === before) return;
    clearRunTimer(run);
    if (!run.results.some((item) => item.messages.length)) {
      run.expiresAt = "";
      return;
    }
    scheduleCleanup(run);
  }

  function close() {
    if (closePromise) return closePromise;
    const closingRuns = [...runs.values()];
    for (const run of closingRuns) {
      clearRunTimer(run);
      run.closed = true;
      if (run.status === "running") {
        run.abortController.abort(messageDiscoveryError("MESSAGE_DISCOVERY_STOPPED", "message discovery stopped"));
      }
      run.results = [];
    }
    closePromise = Promise.allSettled(
      closingRuns.map((run) => run.completion).filter((completion) => completion && typeof completion.then === "function")
    ).then(() => {
      runs.clear();
    });
    return closePromise;
  }

  function recordRiskOnce(run, errorCode, message) {
    if (run.riskRecorded) return;
    recordRiskControl({
      profileId: run.profileId,
      errorCode,
      message: String(message || ""),
      occurredAt: nowDate().toISOString()
    });
    run.riskRecorded = true;
  }

  function updateRun(run, statusValue) {
    if (!run || run.closed || runs.get(run.profileId) !== run || !statusValue || typeof statusValue !== "object") return;
    const at = nowDate();
    run.status = ALLOWED_RUN_STATUSES.has(statusValue.status) ? statusValue.status : "needs_user_action";
    run.queued = Math.max(0, Number(statusValue.queued) || 0);
    run.processed = Math.max(0, Number(statusValue.processed) || 0);
    run.unresolved = Math.max(0, Number(statusValue.unresolved) || 0);
    run.reasonCode = safeCode(statusValue.reasonCode);
    run.results = sanitizeResults(Array.isArray(statusValue.results)
      ? statusValue.results.filter((item) => !run.clearedCardIds.has(Number(item?.cardId)))
      : []);
    run.updatedAt = at.toISOString();
    if (run.status === "running") {
      run.expiresAt = "";
      return;
    }
    run.closed = true;
    run.expiresAt = new Date(at.getTime() + DEFAULT_CLEANUP_MS).toISOString();
    scheduleCleanup(run);
  }

  function sanitizeResults(results) {
    if (!Array.isArray(results)) return [];
    let remainingMessages = 2;
    return results.map((item) => {
      const messages = Array.isArray(item?.messages)
        ? item.messages.slice(0, remainingMessages).map((message) => String(message))
        : [];
      remainingMessages -= messages.length;
      return {
        cardId: Math.max(0, Number(item?.cardId) || 0),
        jobId: Math.max(0, Number(item?.jobId) || 0),
        stage: String(item?.stage || "").slice(0, 80),
        messageCategory: String(item?.messageCategory || "").slice(0, 80),
        missingFactKey: String(item?.missingFactKey || "").slice(0, 80),
        messages
      };
    });
  }

  function publicRun(run) {
    return {
      profileId: run.profileId,
      status: run.status,
      queued: run.queued,
      processed: run.processed,
      unresolved: run.unresolved,
      reasonCode: run.reasonCode,
      results: sanitizeResults(run.results).map((item) => ({
        cardId: item.cardId,
        jobId: item.jobId,
        stage: item.stage,
        messageCategory: item.messageCategory,
        missingFactKey: item.missingFactKey
      })),
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      expiresAt: run.expiresAt
    };
  }

  function pageRun(run) {
    return {
      profileId: run.profileId,
      status: run.status,
      queued: run.queued,
      processed: run.processed,
      unresolved: run.unresolved,
      reasonCode: run.reasonCode,
      results: sanitizeResults(run.results),
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      expiresAt: run.expiresAt
    };
  }

  function emptyStatus(profileId) {
    return {
      profileId,
      status: "idle",
      queued: 0,
      processed: 0,
      unresolved: 0,
      reasonCode: "",
      results: [],
      startedAt: "",
      updatedAt: "",
      expiresAt: ""
    };
  }

  function durableStatus(profileId) {
    const unresolved = listUnresolvedMessageDiscoveryItems(db, { profileId });
    if (unresolved.length === 0) return emptyStatus(profileId);
    return {
      ...emptyStatus(profileId),
      status: "needs_user_action",
      unresolved: unresolved.length,
      reasonCode: safeCode(unresolved[0].reasonCode)
    };
  }

  function clearExpiredRun(profileId) {
    const run = runs.get(profileId);
    if (!run || run.status === "running" || !run.expiresAt) return;
    if (Date.parse(run.expiresAt) <= nowDate().getTime()) {
      clearRunTimer(run);
      run.results = [];
      run.closed = true;
      runs.delete(profileId);
    }
  }

  function scheduleCleanup(run) {
    clearRunTimer(run);
    const expiresAt = Date.parse(run.expiresAt);
    const delay = Number.isFinite(expiresAt)
      ? Math.max(0, expiresAt - nowDate().getTime())
      : DEFAULT_CLEANUP_MS;
    const timer = setTimeoutFn(() => {
      if (runs.get(run.profileId) !== run || run.cleanupTimer !== timer) return;
      run.cleanupTimer = null;
      run.results = [];
      run.closed = true;
      runs.delete(run.profileId);
    }, delay);
    run.cleanupTimer = timer;
  }

  function clearRunTimer(run) {
    if (!run || run.cleanupTimer === null || run.cleanupTimer === undefined) return;
    clearTimeoutFn(run.cleanupTimer);
    run.cleanupTimer = null;
  }

  function nowDate() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : new Date();
  }
}

function messageDiscoveryProfileId(value) {
  const profileId = Number(value);
  if (!Number.isSafeInteger(profileId) || profileId <= 0) {
    throw messageDiscoveryError("MESSAGE_DISCOVERY_PROFILE_INVALID", "profileId must be a positive integer", 400);
  }
  return profileId;
}

function safeCode(value) {
  const code = String(value || "");
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : "";
}

function messageDiscoveryErrorCode(error) {
  return safeCode(error?.code) || "MESSAGE_DISCOVERY_FAILED";
}

function messageDiscoveryError(code, message, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function assertMessageDiscoveryRuntimeAvailable(db, now) {
  const state = getSiteRuntimeState(db, "boss");
  if (!state || state.status !== "blocked") return;
  const blockedUntil = state.details?.blockedUntil || "";
  const blockedUntilMs = Date.parse(blockedUntil);
  const nowValue = typeof now === "function" ? now() : new Date();
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
  if (Number.isFinite(blockedUntilMs) && Number.isFinite(nowMs) && blockedUntilMs <= nowMs) return;
  throw messageDiscoveryError(
    state.reasonCode || "BOSS_RUNTIME_BLOCKED",
    "BOSS access is paused by the central runtime safety guard",
    409
  );
}

function persistMessageDiscoveryRiskControl(db, {
  profileId,
  errorCode = "BOSS_RISK_CONTROL",
  message = "",
  occurredAt = new Date().toISOString()
} = {}) {
  setSiteRuntimeState(db, "boss", {
    status: "blocked",
    reasonCode: errorCode,
    message,
    details: { phase: "message_discovery", profileId: Number(profileId) || null }
  });
  recordSiteAccessEvent(db, {
    site: "boss",
    action: "risk_control",
    runId: "",
    details: {
      profileId: Number(profileId) || null,
      errorCode,
      errorMessage: String(message || "").slice(0, 1000)
    },
    createdAt: occurredAt
  });
}

function createMessageModelAdapter(modelConfig, logger) {
  const { createModelAdapter } = require("../adapters/models");
  return createModelAdapter(modelConfig || { provider: "mock", providers: { mock: {} } }, { logger });
}

module.exports = {
  createMessageDiscoveryController
};
