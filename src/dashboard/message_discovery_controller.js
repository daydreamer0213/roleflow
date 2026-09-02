const { randomUUID } = require("node:crypto");
const { createBossMessageReader } = require("../adapters/sites/boss_message_reader");
const { createBossMessageDetailReader } = require("../adapters/sites/boss_message_detail_reader");
const { BossSiteAdapter } = require("../adapters/sites/boss");
const { createMessageDiscoveryJobContextResolver } = require("../application/message_discovery/job_context");
const { runBossMessageDiscovery, projectMessageDecisionCard } = require("../core/message_discovery");
const { createMessageReplyAnalyzer } = require("../core/message_reply_analyzer");
const {
  listUnresolvedMessageDiscoveryItems
} = require("../core/message_preview_state");
const { createSiteAccessController } = require("../core/site_access_budget");
const { communicationRuntimeBlock } = require("../core/communication_runtime");
const { resolveBossRiskWindow } = require("../core/boss_risk_window");
const {
  getSitePacingState,
  setSitePacingState,
  setSiteRuntimeState,
  recordSiteAccessEvent,
  listOpenMessageReplyDrafts,
  listMessageInboundContexts,
  closeMessageReplyDrafts
} = require("../core/storage");

const DEFAULT_CLEANUP_MS = 30 * 60 * 1000;
const ALLOWED_RUN_STATUSES = new Set(["running", "completed", "needs_user_action", "stopped"]);
const MESSAGE_INTENTS = new Set([
  "interview_invitation",
  "interest_check",
  "information_request",
  "information_update",
  "general_communication",
  "manual_review"
]);

function createMessageDiscoveryController(deps = {}) {
  const {
    db,
    root = process.cwd(),
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
    createDetailSafety = (options) => createMessageDiscoveryDetailSafety(options),
    createDetailReader = (options) => createBossMessageDetailReader(options),
    createJobContextResolver = (options) => createMessageDiscoveryJobContextResolver(options),
    createAnalyzer = ({ modelConfig, logger: analyzerLogger }) => createMessageReplyAnalyzer({
      adapter: createMessageModelAdapter(modelConfig, analyzerLogger)
    }),
    runDiscovery = runBossMessageDiscovery,
    pacingSleepFn,
    pacingRandomFn = Math.random,
    detailSleepFn,
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
      counters: emptyCounters(),
      reasonCode: "",
      results: [],
      phase: "starting",
      waitUntil: "",
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
      const detailSafety = createDetailSafety({
        db,
        profileId,
        owner,
        run,
        logger,
        signal: abortController.signal,
        now,
        sleepFn: pacingSleepFn,
        randomFn: pacingRandomFn
      });
      const detailReader = createDetailReader({
        browser,
        messageReader: reader,
        logger,
        beforeOpen: detailSafety.beforeOpen,
        afterIssuedAttempt: detailSafety.afterIssuedAttempt,
        sleepFn: detailSleepFn
      });
      const resolveJobContext = createJobContextResolver({
        db,
        profileId,
        messageReader: reader,
        detailReader,
        modelConfig,
        root,
        logger
      });
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
        resolveJobContext,
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
        counters: run.counters,
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
    if (!run) {
      const openDrafts = listOpenMessageReplyDrafts(db, { profileId, limit: 500 });
      if (!openDrafts.length) throw messageDiscoveryError("MESSAGE_DISCOVERY_NOT_FOUND", "message discovery run was not found", 404);
      for (const cardId of new Set(openDrafts.map((draft) => draft.cardId))) {
        closeMessageReplyDrafts(db, { profileId, cardId, closedAt: nowDate().toISOString() });
      }
      return { statusCode: 200, body: { ...emptyStatus(profileId), status: "dismissed" } };
    }
    if (run.status === "running") {
      throw messageDiscoveryError("MESSAGE_DISCOVERY_RUNNING", "stop message discovery before dismissing drafts", 409);
    }
    clearRunTimer(run);
    for (const cardId of new Set(run.results.map((item) => Number(item.cardId)).filter((id) => id > 0))) {
      closeMessageReplyDrafts(db, { profileId, cardId, closedAt: nowDate().toISOString() });
    }
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
    return run ? publicRun(run) : publicDurableStatus(profileId);
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
    if (Number.isSafeInteger(profileId) && profileId > 0 && Number.isSafeInteger(cardId) && cardId > 0) {
      closeMessageReplyDrafts(db, { profileId, cardId, closedAt: nowDate().toISOString() });
    }
    const run = runs.get(profileId);
    if (!run) return;
    const result = run.results.find((item) => Number(item.cardId) === cardId);
    if (!result) return;
    run.clearedCardIds.add(cardId);
    run.results = run.results.map((item) => Number(item.cardId) === cardId
      ? { ...item, inboundMessages: [], drafts: [], messages: [] }
      : item);
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
    if (statusValue.counters !== undefined) run.counters = safeCounters(statusValue.counters);
    run.reasonCode = safeCode(statusValue.reasonCode);
    if (statusValue.phase !== undefined) run.phase = safePhase(statusValue.phase) || run.phase;
    if (statusValue.waitUntil !== undefined) run.waitUntil = safeTimestamp(statusValue.waitUntil);
    run.results = sanitizeResults(Array.isArray(statusValue.results) ? statusValue.results : [])
      .map((item) => run.clearedCardIds.has(Number(item.cardId))
        ? { ...item, inboundMessages: [], drafts: [], messages: [] }
        : item);
    run.updatedAt = at.toISOString();
    if (run.status === "running") {
      run.expiresAt = "";
      return;
    }
    run.phase = run.status;
    run.waitUntil = "";
    run.closed = true;
    run.expiresAt = new Date(at.getTime() + DEFAULT_CLEANUP_MS).toISOString();
    scheduleCleanup(run);
  }

  function sanitizeResults(results) {
    if (!Array.isArray(results)) return [];
    return results.map((item) => {
      const messages = Array.isArray(item?.messages)
        ? item.messages.slice(0, 2).map((message) => safeText(message, 4000)).filter(Boolean)
        : [];
      const drafts = Array.isArray(item?.drafts)
        ? item.drafts.slice(0, 2).map((draft) => ({
          id: Math.max(0, Number(draft?.id) || 0),
          text: safeText(draft?.text, 4000),
          revision: Math.max(0, Number(draft?.revision) || 0)
        })).filter((draft) => draft.id > 0 && draft.text)
        : [];
      return {
        cardId: Math.max(0, Number(item?.cardId) || 0),
        jobId: Math.max(0, Number(item?.jobId) || 0),
        stage: String(item?.stage || "").slice(0, 80),
        messageIntent: MESSAGE_INTENTS.has(item?.messageIntent) ? item.messageIntent : "manual_review",
        messageCategory: String(item?.messageCategory || "").slice(0, 80),
        messageSummary: safeInlineText(item?.messageSummary, 160),
        missingFactKey: String(item?.missingFactKey || "").slice(0, 80),
        manualActionReason: safeText(item?.manualActionReason, 240),
        manualActions: sanitizeManualActions(item?.manualActions),
        contextSource: ["local_cache", "message_discovery_detail"].includes(item?.contextSource)
          ? item.contextSource
          : "",
        contextComplete: item?.contextComplete === true,
        job: sanitizeJobUnderstanding(item?.job),
        inboundMessages: sanitizeInboundMessages(item?.inboundMessages),
        draftQualityWarnings: sanitizeDraftQualityWarnings(item?.draftQualityWarnings),
        drafts,
        messages
      };
    });
  }

  function sanitizeDraftQualityWarnings(value) {
    return Array.isArray(value) && value.includes("MESSAGE_DRAFT_RECENTLY_SIMILAR")
      ? ["MESSAGE_DRAFT_RECENTLY_SIMILAR"]
      : [];
  }

  function sanitizeManualActions(value) {
    return Array.isArray(value) && value.some((item) => item?.kind === "resume_request")
      ? [{
        kind: "resume_request",
        title: "需要在 BOSS 人工处理附件简历请求",
        instruction: "请在 BOSS 消息卡片中人工选择“同意”或“拒绝”。"
      }]
      : [];
  }

  function sanitizeInboundMessages(value) {
    const result = [];
    for (const item of Array.isArray(value) ? value : []) {
      const kind = String(item?.kind || "");
      const text = safeText(item?.text, 4000).replace(/\r\n?/g, "\n").trim();
      if (kind === "text" && text) result.push({ kind, text });
      else if (kind === "resume_request" && text === "HR 邀请你发送简历") result.push({ kind, text });
      if (result.length >= 5) break;
    }
    return result;
  }

  function publicRun(run) {
    return {
      profileId: run.profileId,
      status: run.status,
      queued: run.queued,
      processed: run.processed,
      unresolved: run.unresolved,
      counters: safeCounters(run.counters),
      reasonCode: run.reasonCode,
      results: sanitizeResults(run.results).map((item) => ({
        cardId: item.cardId,
        jobId: item.jobId,
        stage: item.stage,
        messageCategory: item.messageCategory,
        missingFactKey: item.missingFactKey
      })),
      phase: safePhase(run.phase),
      waitUntil: safeTimestamp(run.waitUntil),
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      expiresAt: run.expiresAt
    };
  }

  function pageRun(run) {
    const results = sanitizeResults(run.results);
    return {
      profileId: run.profileId,
      status: run.status,
      queued: run.queued,
      processed: run.processed,
      unresolved: run.unresolved,
      counters: safeCounters(run.counters),
      reasonCode: run.reasonCode,
      results: run.status === "running" ? results : overlayOpenDrafts(run.profileId, results),
      phase: safePhase(run.phase),
      waitUntil: safeTimestamp(run.waitUntil),
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      expiresAt: run.expiresAt
    };
  }

  function overlayOpenDrafts(profileId, results) {
    const byCard = new Map();
    const persistedDraft = db.prepare("SELECT 1 AS found FROM message_reply_drafts WHERE id = ? AND profile_id = ?");
    for (const draft of listOpenMessageReplyDrafts(db, { profileId, limit: 500 })) {
      if (draft.messageIntent === "follow_up") continue;
      const values = byCard.get(draft.cardId) || [];
      values.push(draft);
      byCard.set(draft.cardId, values);
    }
    return results.map((result) => {
      if (!result.drafts.length) return result;
      const openDrafts = byCard.get(result.cardId) || [];
      if (!openDrafts.length && !result.drafts.some((draft) => persistedDraft.get(draft.id, profileId))) return result;
      const drafts = openDrafts
        .sort((left, right) => left.draftIndex - right.draftIndex)
        .slice(0, 2)
        .map((draft) => ({ id: draft.id, text: draft.currentText, revision: draft.revision }));
      return { ...result, drafts, messages: drafts.map((draft) => draft.text) };
    });
  }

  function emptyStatus(profileId) {
    return {
      profileId,
      status: "idle",
      queued: 0,
      processed: 0,
      unresolved: 0,
      counters: emptyCounters(),
      reasonCode: "",
      results: [],
      phase: "idle",
      waitUntil: "",
      startedAt: "",
      updatedAt: "",
      expiresAt: ""
    };
  }

  function emptyCounters() {
    return { visible: 0, newReplies: 0, currentRead: 0, currentDelivered: 0, unbound: 0 };
  }

  function safeCounters(value) {
    const input = value && typeof value === "object" ? value : {};
    return Object.fromEntries(Object.keys(emptyCounters()).map((key) => [
      key,
      Math.max(0, Number(input[key]) || 0)
    ]));
  }

  function durableStatus(profileId) {
    const drafts = listOpenMessageReplyDrafts(db, { profileId, limit: 500 })
      .filter((draft) => draft.messageIntent !== "follow_up");
    const inboundContexts = listMessageInboundContexts(db, { profileId, limit: 500 });
    const unresolved = listUnresolvedMessageDiscoveryItems(db, { profileId });
    if (!drafts.length && unresolved.length === 0) return emptyStatus(profileId);
    const byCard = new Map();
    for (const draft of drafts) {
      const values = byCard.get(draft.cardId) || [];
      values.push(draft);
      byCard.set(draft.cardId, values);
    }
    const contextsByCard = new Map();
    for (const context of inboundContexts) {
      const values = contextsByCard.get(context.cardId) || [];
      values.push(context);
      contextsByCard.set(context.cardId, values);
    }
    const results = [...byCard.entries()].map(([cardId, cardDrafts]) => durableDraftResult(
      profileId,
      cardId,
      cardDrafts,
      contextsByCard.get(cardId) || []
    ));
    return {
      ...emptyStatus(profileId),
      status: unresolved.length ? "needs_user_action" : "completed",
      unresolved: unresolved.length,
      reasonCode: safeCode(unresolved[0]?.reasonCode),
      processed: results.length,
      results
    };
  }

  function publicDurableStatus(profileId) {
    const value = durableStatus(profileId);
    return {
      ...value,
      results: sanitizeResults(value.results).map((item) => ({
        cardId: item.cardId,
        jobId: item.jobId,
        stage: item.stage,
        messageCategory: item.messageCategory,
        missingFactKey: item.missingFactKey
      }))
    };
  }

  function durableDraftResult(profileId, cardId, drafts, contexts = []) {
    const row = db.prepare(`SELECT c.id AS card_id, c.job_id, c.stage,
      j.title, j.company, j.salary, j.description, j.analysis_json
      FROM candidate_progress_cards c
      JOIN jobs j ON j.id = c.job_id
      WHERE c.id = ? AND c.profile_id = ?`).get(cardId, profileId);
    if (!row) throw messageDiscoveryError("MESSAGE_DISCOVERY_CONTEXT_INVALID", "durable draft context is missing", 500);
    const first = drafts[0];
    const openGroupKeys = new Set(drafts.map((draft) => draft.messageGroupKey));
    const activeContexts = contexts.filter((context) => openGroupKeys.has(context.messageGroupKey));
    const inboundMessages = sanitizeInboundMessages(activeContexts.flatMap((context) => context.inboundMessages));
    const safeDrafts = drafts.sort((left, right) => left.draftIndex - right.draftIndex).slice(0, 2).map((draft) => ({
      id: draft.id,
      text: draft.currentText,
      revision: draft.revision
    }));
    const job = projectMessageDecisionCard({
      title: row.title,
      company: row.company,
      salary: row.salary,
      description: row.description,
      analysis: parseObject(row.analysis_json)
    });
    return {
      cardId: Number(row.card_id),
      jobId: Number(row.job_id),
      stage: String(row.stage || "reply_ready"),
      messageIntent: MESSAGE_INTENTS.has(first.messageIntent) ? first.messageIntent : "manual_review",
      messageCategory: String(first.messageCategory || "other"),
      messageSummary: safeInlineText(first.questionSummary, 160),
      missingFactKey: "",
      manualActionReason: "",
      manualActions: sanitizeManualActions(activeContexts.flatMap((context) => context.manualActions)),
      contextSource: "local_cache",
      contextComplete: Boolean(row.description),
      job,
      inboundMessages,
      drafts: safeDrafts,
      messages: safeDrafts.map((draft) => draft.text)
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

function createMessageDiscoveryDetailSafety({
  db,
  profileId,
  owner = "",
  run = null,
  logger = null,
  signal = null,
  now = () => new Date(),
  sleepFn,
  randomFn = Math.random,
  createAccessController = createSiteAccessController,
  createPacingAdapter = (options) => new BossSiteAdapter(options)
} = {}) {
  let assertActiveBindings = null;
  const onWait = ({ durationMs }) => setDetailWait(run, durationMs, now);
  const checkpointPacing = async (state) => setSitePacingState(db, {
    site: "boss",
    pacing: state,
    updatedAt: safeNow(now).toISOString()
  });
  const accessController = createAccessController({
    db,
    auditDb: db,
    site: "boss",
    runId: owner,
    logger,
    signal,
    sleepFn,
    randomFn,
    onWait,
    assertActive: async () => {
      if (typeof assertActiveBindings === "function") await assertActiveBindings();
    }
  });
  const pacing = createPacingAdapter({ logger, sleepFn, randomFn, accessController });
  pacing.restorePacing(getSitePacingState(db, "boss").pacing);

  return {
    pacing,
    async beforeOpen({ jobId, signal: operationSignal = signal, assertTabBindings } = {}) {
      assertActiveBindings = assertTabBindings;
      setDetailPhase(run, "reading_detail", now);
      try {
        await pacing.waitForPendingDetailCooldown({
          signal: operationSignal,
          assertTabBindings,
          onWait,
          onPacingCheckpoint: checkpointPacing
        });
        await pacing.waitWithPacing("pane_detail_read", {
          signal: operationSignal,
          assertTabBindings,
          onWait
        });
        await pacing.reserveAccess("pane_detail_read", { jobId });
        await pacing.reserveAccess("detail_open", { jobId });
      } finally {
        assertActiveBindings = null;
        setDetailPhase(run, "reading_detail", now);
      }
    },
    async afterIssuedAttempt({ signal: operationSignal = signal, assertTabBindings } = {}) {
      try {
        await pacing.waitAfterDetailAction({
          signal: operationSignal,
          assertTabBindings,
          onWait,
          onPacingCheckpoint: checkpointPacing
        });
      } finally {
        if (!operationSignal?.aborted) setDetailPhase(run, "reading_detail", now);
      }
    }
  };
}

function setDetailWait(run, durationMs, now) {
  if (!run) return;
  const current = safeNow(now);
  const delay = Math.max(0, Math.floor(Number(durationMs) || 0));
  run.phase = "cooldown";
  run.waitUntil = new Date(current.getTime() + delay).toISOString();
  run.updatedAt = current.toISOString();
}

function setDetailPhase(run, phase, now) {
  if (!run) return;
  run.phase = phase;
  run.waitUntil = "";
  run.updatedAt = safeNow(now).toISOString();
}

function safeNow(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function messageDiscoveryProfileId(value) {
  const profileId = Number(value);
  if (!Number.isSafeInteger(profileId) || profileId <= 0) {
    throw messageDiscoveryError("MESSAGE_DISCOVERY_PROFILE_INVALID", "profileId must be a positive integer", 400);
  }
  return profileId;
}

function sanitizeJobUnderstanding(value) {
  const job = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    title: safeInlineText(job.title, 160),
    company: safeInlineText(job.company, 160),
    roleSummary: safeInlineText(job.roleSummary, 300),
    companyBusiness: safeInlineText(job.companyBusiness, 300),
    fitLabel: safeInlineText(job.fitLabel, 20),
    fitSummary: safeInlineText(job.fitSummary, 180),
    workSchedule: safeInlineText(job.workSchedule, 180),
    salary: safeInlineText(job.salary, 80),
    opportunityVerdict: safeInlineText(job.opportunityVerdict, 80),
    opportunitySummary: safeInlineText(job.opportunitySummary, 180)
  };
}

function safeText(value, limit) {
  return ["string", "number"].includes(typeof value) ? String(value).slice(0, limit) : "";
}

function safeInlineText(value, limit) {
  return safeText(value, limit * 2).replace(/\s+/g, " ").trim().slice(0, limit);
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safePhase(value) {
  const phase = String(value || "");
  return new Set([
    "idle",
    "starting",
    "reading_messages",
    "reading_detail",
    "cooldown",
    "analyzing_job",
    "completed",
    "needs_user_action",
    "stopped",
    "dismissed"
  ]).has(phase) ? phase : "";
}

function safeTimestamp(value) {
  if (!value) return "";
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : "";
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
  const nowValue = typeof now === "function" ? now() : new Date();
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
  const block = communicationRuntimeBlock(db, { nowMs });
  if (!block) return;
  throw messageDiscoveryError(
    block.reasonCode,
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
  const riskWindow = resolveBossRiskWindow({ nowMs: Date.parse(occurredAt) });
  setSiteRuntimeState(db, "boss", {
    status: "blocked",
    reasonCode: errorCode,
    message,
    details: {
      phase: "message_discovery",
      profileId: Number(profileId) || null,
      blockedUntil: riskWindow.blockedUntil,
      recovery: true
    }
  });
  recordSiteAccessEvent(db, {
    site: "boss",
    action: "risk_control",
    runId: "",
    details: {
      profileId: Number(profileId) || null,
      errorCode,
      errorMessage: String(message || "").slice(0, 1000),
      blockedUntil: riskWindow.blockedUntil,
      recovery: true
    },
    createdAt: riskWindow.occurredAt
  });
}

function createMessageModelAdapter(modelConfig, logger) {
  const { createModelAdapter } = require("../adapters/models");
  return createModelAdapter(modelConfig || { provider: "mock", providers: { mock: {} } }, { logger });
}

module.exports = {
  createMessageDiscoveryController,
  createMessageDiscoveryDetailSafety
};
