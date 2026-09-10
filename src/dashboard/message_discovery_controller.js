const { randomUUID } = require("node:crypto");
const { createBossMessageReader } = require("../adapters/sites/boss_message_reader");
const { createZhaopinMessageReader, isZhaopinMessageUrl } = require("../adapters/sites/zhaopin_message_reader");
const { createZhaopinMessageJobContextResolver } = require("../application/message_discovery/zhaopin_job_context");
const { findMessageDiscoveryJobContext } = require("../core/candidate_progress");
const { createBossMessageDetailReader } = require("../adapters/sites/boss_message_detail_reader");
const { createZhaopinMessageDetailReader } = require("../adapters/sites/zhaopin_message_detail_reader");
const { BossSiteAdapter } = require("../adapters/sites/boss");
const { createMessageDiscoveryJobContextResolver } = require("../application/message_discovery/job_context");
const { runBossMessageDiscovery, projectMessageDecisionCard } = require("../core/message_discovery");
const { createMessageReplyAnalyzer } = require("../core/message_reply_analyzer");
const {
  listUnresolvedMessageDiscoveryItems
} = require("../core/message_preview_state");
const { createSiteAccessController } = require("../core/site_access_budget");
const { communicationRuntimeBlock, scanRuntimeBlock } = require("../core/communication_runtime");
const { resolveBossRiskWindow } = require("../core/boss_risk_window");
const {
  getSitePacingState,
  setSitePacingState,
  setSiteRuntimeState,
  recordSiteAccessEvent,
  listOpenMessageReplyDrafts,
  listMessageInboundContexts,
  deleteMessageInboundContext,
  getActiveSearchPlan,
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
    assertRuntimeAvailable = (input) => assertMessageDiscoveryRuntimeAvailable(db, now, input),
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
    createReader = ({ browser, platform }) => platform === "zhaopin"
      ? createZhaopinMessageReader({ browser }) : createBossMessageReader({ browser }),
    createDetailSafety = (options) => createMessageDiscoveryDetailSafety(options),
    createDetailReader = (options) => options.platform === "zhaopin"
      ? createZhaopinMessageDetailReader(options) : createBossMessageDetailReader(options),
    createJobContextResolver = (options) => options.platform === "zhaopin"
      ? createZhaopinMessageJobContextResolver(options) : createMessageDiscoveryJobContextResolver(options),
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
      platformRuns: [],
      phase: "starting",
      waitUntil: "",
      startedAt: startedAt.toISOString(),
      updatedAt: startedAt.toISOString(),
      expiresAt: "",
      abortController,
      cleanupTimer: null,
      clearedCardIds: new Set(),
      closed: false,
      riskRecorded: new Set(),
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
      browser = await createBrowser();
      if (abortController.signal.aborted) throw abortController.signal.reason;
      const tabs = await browser.listTabs();
      run.platformRuns = ["boss", "zhaopin"].map((platform) => {
        const matches = tabs.filter((tab) => {
          try {
            const url = new URL(tab.url);
            return platform === "boss"
              ? url.hostname === "www.zhipin.com" && url.pathname === "/web/geek/chat"
              : isZhaopinMessageUrl(tab.url);
          } catch { return false; }
        });
        return { platform, status: matches.length === 1 ? "pending" : matches.length ? "needs_user_action" : "not_connected",
          reasonCode: matches.length > 1 ? (platform === "boss" ? "BOSS_MESSAGE_TAB_AMBIGUOUS" : "ZHAOPIN_MESSAGE_TAB_AMBIGUOUS") : "", counters: safeCounters(null, platform) };
      });
      for (const entry of run.platformRuns) {
        if (abortController.signal.aborted) break;
        if (entry.status !== "pending") continue;
        const platform = entry.platform;
        const earlier = { queued: run.queued, processed: run.processed, unresolved: run.unresolved, counters: run.counters, results: run.results };
        const checkpoint = (summary = {}) => {
          entry.status = ALLOWED_RUN_STATUSES.has(summary.status) ? summary.status : "running";
          entry.reasonCode = safeCode(summary.reasonCode);
          entry.counters = safeCounters(summary.counters, entry.platform);
          const counters = { ...earlier.counters };
          for (const key of ["visible", "newReplies", "unbound"]) counters[key] += entry.counters[key];
          if (platform === "boss") {
            counters.currentRead = entry.counters.currentRead;
            counters.currentDelivered = entry.counters.currentDelivered;
          }
          const results = new Map(earlier.results.map(item => [item.cardId, item]));
          for (const item of sanitizeResults(summary.results || [])) results.set(item.cardId, item);
          updateRun(run, { ...summary, status: "running", queued: earlier.queued + (Number(summary.queued) || 0), processed: earlier.processed + (Number(summary.processed) || 0), unresolved: earlier.unresolved + (Number(summary.unresolved) || 0), counters, results: [...results.values()] });
        };
        let readingStarted = false;
        try {
          entry.status = "running";
          if (platform === "boss") assertRuntimeAvailable({ profileId, platform });
          else assertMessageDiscoveryRuntimeAvailable(db, now, { platform });
          readingStarted = true;
          setDetailPhase(run, "reading_messages", now);
          const reader = createReader({ browser, platform });
          const safety = createDetailSafety({ db, profileId, owner, run, logger, signal: abortController.signal, now, sleepFn: pacingSleepFn, randomFn: pacingRandomFn, platform });
          const detailOptions = { browser, messageReader: reader, logger, beforeOpen: safety.beforeOpen, afterIssuedAttempt: safety.afterIssuedAttempt, sleepFn: detailSleepFn, platform };
          let actualDetailReader = platform === "boss" || Object.hasOwn(deps, "createDetailReader")
            ? createDetailReader(detailOptions)
            : null;
          const detailReader = actualDetailReader || {
            readSelectedJobDetail(input) {
              actualDetailReader ||= createDetailReader(detailOptions);
              return actualDetailReader.readSelectedJobDetail(input);
            }
          };
          const resolverOptions = { platform, db, profileId, modelConfig, root, logger };
          if (platform !== "zhaopin" || typeof reader.readSelectedJobTarget === "function") {
            resolverOptions.messageReader = reader;
            resolverOptions.detailReader = detailReader;
          }
          const resolveJobContext = createJobContextResolver(resolverOptions);
          const summary = await runDiscovery({ platform, db, profileId, reader, signal: abortController.signal, logger,
            classifyMessageGroup: createAnalyzer({ modelConfig, logger }), resolveJobContext, onStatus: checkpoint });
          checkpoint(summary);
          if (isPlatformRiskControl(platform, summary?.reasonCode)) {
            recordRiskOnce(run, platform, summary.reasonCode, `${platform} requires security verification`);
          }
        } catch (error) {
          entry.reasonCode = messageDiscoveryErrorCode(error);
          entry.status = /RISK_CONTROL|RUNTIME_BLOCKED|LOGIN_REQUIRED|PAGE_LOST|TAB_|BINDING/.test(entry.reasonCode) ? "needs_user_action" : "stopped";
          if (readingStarted && isPlatformRiskControl(platform, entry.reasonCode)) {
            recordRiskOnce(run, platform, entry.reasonCode, error.message);
          }
        }
      }
      for (const entry of run.platformRuns) if (entry.status === "pending") entry.status = "stopped";
      const issue = run.platformRuns.find(entry => entry.status === "needs_user_action" || entry.status === "stopped");
      const stopped = abortController.signal.aborted || run.platformRuns.some(entry => entry.status === "stopped");
      updateRun(run, { ...run, status: stopped ? "stopped" : issue || !run.platformRuns.some(entry => entry.status === "completed") ? "needs_user_action" : "completed",
        reasonCode: abortController.signal.aborted ? messageDiscoveryErrorCode(abortController.signal.reason) : issue?.reasonCode || "" });
    }).catch((error) => {
      const code = messageDiscoveryErrorCode(error);
      if (code === "BOSS_RISK_CONTROL") recordRiskOnce(run, "boss", code, error?.message);
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
      const results = durableStatus(profileId).results;
      if (!results.length) throw messageDiscoveryError("MESSAGE_DISCOVERY_NOT_FOUND", "message discovery run was not found", 404);
      clearProcessedCards(profileId, results.map(result => result.cardId));
      return { statusCode: 200, body: { ...emptyStatus(profileId), status: "dismissed" } };
    }
    if (run.status === "running") {
      throw messageDiscoveryError("MESSAGE_DISCOVERY_RUNNING", "stop message discovery before dismissing drafts", 409);
    }
    clearProcessedCards(profileId, run.results.map(item => item.cardId));
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
      clearProcessedCards(profileId, [cardId]);
    }
    const run = runs.get(profileId);
    if (!run) return;
    const result = run.results.find((item) => Number(item.cardId) === cardId);
    if (!result) return;
    run.clearedCardIds.add(cardId);
    run.results = run.results.filter(item => Number(item.cardId) !== cardId || !item.drafts?.length).map((item) => Number(item.cardId) === cardId
      ? { ...item, inboundMessages: [], drafts: [], messages: [] }
      : item);
  }

  function clearProcessedCards(profileId, cardIds) {
    const targets = [...new Set(cardIds.map(Number).filter(id => id > 0))];
    for (const cardId of targets) {
      if (db.prepare(`SELECT 1 FROM message_reply_send_items items
        JOIN message_reply_drafts drafts ON drafts.id = items.draft_id
        WHERE drafts.profile_id = ? AND drafts.card_id = ?
        AND items.status IN ('pending','selecting','verified','filled','click_dispatched','ambiguous') LIMIT 1`).get(profileId, cardId)) {
        throw messageDiscoveryError("MESSAGE_REPLY_SEND_DRAFT_BUSY", "正在发送或结果待核对的草稿不能清除。", 409);
      }
    }
    for (const cardId of targets) {
      closeMessageReplyDrafts(db, { profileId, cardId, closedAt: nowDate().toISOString() });
      for (const context of listMessageInboundContexts(db, { profileId, cardId, limit: 500 })) {
        deleteMessageInboundContext(db, { profileId, cardId, messageGroupKey: context.messageGroupKey });
      }
    }
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

  function recordRiskOnce(run, platform, errorCode, message) {
    if (run.riskRecorded.has(platform)) return;
    recordRiskControl({
      platform,
      profileId: run.profileId,
      errorCode,
      message: String(message || ""),
      occurredAt: nowDate().toISOString()
    });
    run.riskRecorded.add(platform);
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
      const persisted = db.prepare(`SELECT j.source, j.source_id FROM candidate_progress_cards c
        JOIN jobs j ON j.id = c.job_id WHERE c.id = ? AND c.job_id = ? AND c.source = j.source`).get(Number(item?.cardId) || 0, Number(item?.jobId) || 0);
      const context = db.prepare(`SELECT message_group_key, conversation_key
        FROM message_inbound_contexts WHERE card_id = ?
        ORDER BY updated_at DESC, id DESC LIMIT 1`).get(Number(item?.cardId) || 0) || {};
      const platform = ["boss", "zhaopin"].includes(persisted?.source) ? persisted.source : "";
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
        platform,
        sourceJobId: safeText(persisted?.source_id, 180),
        messageGroupKey: safeDigest(item?.messageGroupKey) || safeDigest(context.message_group_key),
        conversationKey: safeDigest(item?.conversationKey) || safeDigest(context.conversation_key),
        stage: String(item?.stage || "").slice(0, 80),
        messageIntent: MESSAGE_INTENTS.has(item?.messageIntent) ? item.messageIntent : "manual_review",
        messageCategory: String(item?.messageCategory || "").slice(0, 80),
        messageSummary: safeInlineText(item?.messageSummary, 160),
        missingFactKey: String(item?.missingFactKey || "").slice(0, 80),
        manualActionReason: safeText(item?.manualActionReason, 240),
        manualActions: sanitizeManualActions(item?.manualActions, platform),
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

  function sanitizeManualActions(value, platform = "boss") {
    return Array.isArray(value) && value.some((item) => item?.kind === "resume_request")
      ? [{
        kind: "resume_request",
        title: `需要在${platform === "zhaopin" ? "智联" : " BOSS "}人工处理附件简历请求`,
        instruction: platform === "zhaopin" ? "请自行到智联原始会话处理这条简历请求。" : "请在 BOSS 消息卡片中人工选择“同意”或“拒绝”。"
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
      platformRuns: visiblePlatformRuns(run),
      reasonCode: run.reasonCode,
      results: sanitizeResults(run.results).map((item) => ({
        cardId: item.cardId,
        jobId: item.jobId,
        platform: item.platform,
        sourceJobId: item.sourceJobId,
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
      platformRuns: visiblePlatformRuns(run),
      reasonCode: run.reasonCode,
      results: run.status === "running" ? results : overlayOpenDrafts(run.profileId, results),
      phase: safePhase(run.phase),
      waitUntil: safeTimestamp(run.waitUntil),
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      expiresAt: run.expiresAt
    };
  }

  function visiblePlatformRuns(run) {
    return (run.platformRuns || []).map(entry => ({ ...entry,
      status: entry.status === "pending" ? "running" : entry.status,
      reasonCode: entry.status === "pending" ? "MESSAGE_DISCOVERY_WAITING_TURN" : entry.reasonCode
    }));
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
      if (!openDrafts.length) return null;
      const drafts = openDrafts
        .sort((left, right) => left.draftIndex - right.draftIndex)
        .slice(0, 2)
        .map((draft) => ({ id: draft.id, text: draft.currentText, revision: draft.revision }));
      return { ...result, drafts, messages: drafts.map((draft) => draft.text) };
    }).filter(Boolean);
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

  function safeCounters(value, platform = "boss") {
    const input = value && typeof value === "object" ? value : {};
    return Object.fromEntries(Object.keys(emptyCounters()).map((key) => [
      key,
      platform === "zhaopin" && ["currentRead", "currentDelivered"].includes(key)
        ? null : Math.max(0, Number(input[key]) || 0)
    ]));
  }

  function durableStatus(profileId) {
    const drafts = listOpenMessageReplyDrafts(db, { profileId, limit: 500 })
      .filter((draft) => draft.messageIntent !== "follow_up");
    const inboundContexts = listMessageInboundContexts(db, { profileId, limit: 500 }).filter(context =>
      drafts.some(draft => draft.cardId === context.cardId && draft.messageGroupKey === context.messageGroupKey)
      || !db.prepare("SELECT 1 FROM message_reply_drafts WHERE profile_id = ? AND card_id = ? AND message_group_key = ?").get(profileId, context.cardId, context.messageGroupKey));
    const unresolved = listUnresolvedMessageDiscoveryItems(db, { profileId, platform: null });
    if (!drafts.length && !inboundContexts.length && unresolved.length === 0) return emptyStatus(profileId);
    const byCard = new Map();
    for (const draft of drafts) {
      const values = byCard.get(draft.cardId) || [];
      values.push(draft);
      byCard.set(draft.cardId, values);
    }
    const contextsByCard = new Map();
    for (const context of inboundContexts) {
      if (!byCard.has(context.cardId)) byCard.set(context.cardId, []);
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
        platform: item.platform,
        sourceJobId: item.sourceJobId,
        stage: item.stage,
        messageCategory: item.messageCategory,
        missingFactKey: item.missingFactKey
      }))
    };
  }

  function durableDraftResult(profileId, cardId, drafts, contexts = []) {
    const row = db.prepare(`SELECT c.id AS card_id, c.job_id, c.plan_id, c.stage,
      j.title, j.company, j.salary, j.description, j.analysis_json, j.quality_tags_json, j.risks_json,
      j.source, j.source_id, c.source AS card_source
      FROM candidate_progress_cards c
      JOIN jobs j ON j.id = c.job_id
      WHERE c.id = ? AND c.profile_id = ?`).get(cardId, profileId);
    if (!row) throw messageDiscoveryError("MESSAGE_DISCOVERY_CONTEXT_INVALID", "durable draft context is missing", 500);
    const platform = row.source === row.card_source && ["boss", "zhaopin"].includes(row.source) ? row.source : "";
    const first = drafts[0] || contexts[0] || {};
    const openGroupKeys = new Set(drafts.map((draft) => draft.messageGroupKey));
    const activeContexts = contexts.filter((context) => openGroupKeys.has(context.messageGroupKey)
      || !db.prepare("SELECT 1 FROM message_reply_drafts WHERE profile_id = ? AND card_id = ? AND message_group_key = ?").get(profileId, cardId, context.messageGroupKey));
    const inboundMessages = sanitizeInboundMessages(activeContexts.flatMap((context) => context.inboundMessages));
    const safeDrafts = drafts.sort((left, right) => left.draftIndex - right.draftIndex).slice(0, 2).map((draft) => ({
      id: draft.id,
      text: draft.currentText,
      revision: draft.revision
    }));
    const activePlan = getActiveSearchPlan(db, profileId);
    const contextPlanId = row.source === "zhaopin" ? activePlan?.id : row.plan_id;
    const trusted = platform && contextPlanId ? findMessageDiscoveryJobContext(db, { profileId, planId: contextPlanId, sourceId: row.source_id, platform }) : null;
    const job = projectMessageDecisionCard(trusted || (row.source === "zhaopin" ? { title: row.title, company: row.company, salary: row.salary } : {
      title: row.title,
      company: row.company,
      salary: row.salary,
      description: row.description,
      qualityTags: parseArray(row.quality_tags_json),
      risks: parseArray(row.risks_json),
      analysis: parseObject(row.analysis_json)
    }));
    return {
      cardId: Number(row.card_id),
      jobId: Number(row.job_id),
      platform,
      sourceJobId: row.source_id,
      messageGroupKey: safeDigest(first.messageGroupKey) || safeDigest(activeContexts[0]?.messageGroupKey),
      conversationKey: safeDigest(first.conversationKey) || safeDigest(activeContexts[0]?.conversationKey),
      stage: String(row.stage || "reply_ready"),
      messageIntent: MESSAGE_INTENTS.has(first.messageIntent) ? first.messageIntent : "manual_review",
      messageCategory: String(first.messageCategory || "other"),
      messageSummary: safeInlineText(first.questionSummary, 160),
      missingFactKey: "",
      manualActionReason: "",
      manualActions: sanitizeManualActions(activeContexts.flatMap((context) => context.manualActions), row.source),
      contextSource: "local_cache",
      contextComplete: row.source === "zhaopin" ? trusted?.contextComplete === true : Boolean(row.description),
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
  createPacingAdapter = (options) => new BossSiteAdapter(options),
  platform = "boss"
} = {}) {
  const site = ["boss", "zhaopin"].includes(platform) ? platform : "boss";
  let assertActiveBindings = null;
  const onWait = ({ durationMs }) => setDetailWait(run, durationMs, now);
  const checkpointPacing = async (state) => setSitePacingState(db, {
    site,
    pacing: state,
    updatedAt: safeNow(now).toISOString()
  });
  const accessController = createAccessController({
    db,
    auditDb: db,
    site,
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
  pacing.restorePacing(getSitePacingState(db, site).pacing);

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
    opportunitySummary: safeInlineText(job.opportunitySummary, 180),
    availability: job.availability === "offline" ? "offline" : "unknown"
  };
}

function safeDigest(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^sha256:[a-f0-9]{64}$/.test(text) ? text : "";
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

function parseArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isPlatformRiskControl(platform, code) {
  return platform === "zhaopin"
    ? ["ZHAOPIN_RISK_CONTROL", "ZHAOPIN_MESSAGE_RISK_CONTROL"].includes(code)
    : code === "BOSS_RISK_CONTROL";
}

function messageDiscoveryError(code, message, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function assertMessageDiscoveryRuntimeAvailable(db, now, { platform = "boss" } = {}) {
  const nowValue = typeof now === "function" ? now() : new Date();
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
  const site = platform === "zhaopin" ? "zhaopin" : "boss";
  const block = site === "boss"
    ? communicationRuntimeBlock(db, { nowMs })
    : scanRuntimeBlock(db, { nowMs, site });
  if (!block) return;
  throw messageDiscoveryError(
    block.reasonCode,
    `${site} access is paused by the central runtime safety guard`,
    409
  );
}

function persistMessageDiscoveryRiskControl(db, {
  platform = "boss",
  profileId,
  errorCode = "BOSS_RISK_CONTROL",
  message = "",
  occurredAt = new Date().toISOString()
} = {}) {
  const site = platform === "zhaopin" ? "zhaopin" : "boss";
  const riskWindow = resolveBossRiskWindow({ nowMs: Date.parse(occurredAt) });
  setSiteRuntimeState(db, site, {
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
    site,
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
