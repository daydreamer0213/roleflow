const {
  listMessageDiscoveryCandidates,
  recordDiscoveredMessageGroupClassification
} = require("./candidate_progress");
const { getCandidateProfile, listCandidateFacts } = require("./storage");
const { safeDigest, messageKey } = require("../adapters/sites/boss_message_dom");
const { MANUAL_ONLY_CATEGORIES } = require("./message_reply_contract");
const {
  listPreviewStates,
  recordPreviewState,
  listUnresolvedMessageDiscoveryItems,
  recordUnresolvedMessageDiscoveryItem,
  clearUnresolvedMessageDiscoveryItem,
  planMessageDiscoveryQueue,
  commitProcessedPreview
} = require("./message_preview_state");

const BOSS_MESSAGE_GROUP_LIMIT = 5;
const BOSS_MESSAGE_GROUP_TEXT_LIMIT = 1000;
const TERMINAL_MODEL_OUTPUT_CODES = new Set([
  "MODEL_EMPTY_RESPONSE",
  "MODEL_INVALID_RESPONSE",
  "MODEL_OUTPUT_TRUNCATED",
  "MODEL_INVALID_JSON"
]);
const CONTEXT_TERMINAL_CODES = new Set([
  "BOSS_LOGIN_REQUIRED",
  "BOSS_MESSAGE_PAGE_LOST",
  "BOSS_MESSAGE_STRUCTURE_CHANGED",
  "BOSS_MESSAGE_TAB_AMBIGUOUS",
  "BOSS_MESSAGE_TAB_MISSING",
  "BOSS_MESSAGE_TARGET_MISMATCH",
  "BOSS_MESSAGE_DETAIL_BASELINE_INVALID",
  "BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED",
  "BOSS_MESSAGE_DETAIL_BINDING_INVALID",
  "BOSS_MESSAGE_DETAIL_BROWSER_FAILED",
  "BOSS_MESSAGE_DETAIL_CLOSE_FAILED",
  "BOSS_MESSAGE_DETAIL_NOT_BACKGROUND",
  "BOSS_MESSAGE_DETAIL_TARGET_MISMATCH"
]);

async function runBossMessageDiscovery({
  db,
  profileId,
  reader,
  classifyMessageGroup,
  resolveJobContext = null,
  logger = null,
  signal = null,
  now = () => new Date().toISOString(),
  sleepFn = abortableSleep,
  randomFn = Math.random,
  onStatus = () => {}
}) {
  const candidates = listMessageDiscoveryCandidates(db, { profileId });
  const storedProfile = getCandidateProfile(db, profileId);
  if (!storedProfile) {
    throw discoveryError("MESSAGE_DISCOVERY_PROFILE_NOT_FOUND", "candidate profile was not found");
  }
  const profile = messageReplyProfile(storedProfile.profile);
  const facts = listCandidateFacts(db, profileId);
  let retained = unresolvedSummary(db, profileId);
  let scan;
  try {
    throwIfAborted(signal);
    scan = await reader.scanConversationRows();
  } catch (error) {
    if (shouldInterrupt(error, signal)) throw error;
    return emitStopped(errorCode(error), 0, [], logger, onStatus, retained);
  }
  if (!scan || !Array.isArray(scan.rows)) {
    return emitStopped("BOSS_MESSAGE_QUEUE_INVALID", 0, [], logger, onStatus, retained);
  }
  const baselines = new Map(listPreviewStates(db, { profileId })
    .map((state) => [state.conversationKey, state]));
  const unresolvedByConversation = new Map(listUnresolvedMessageDiscoveryItems(db, { profileId })
    .map((item) => [item.conversationKey, item]));
  const planned = planMessageDiscoveryQueue({ rows: scan.rows, baselines, unresolved: unresolvedByConversation });
  for (const baseline of planned.baselineWrites) {
    recordPreviewState(db, {
      profileId,
      platform: "boss",
      conversationKey: baseline.conversationKey,
      previewDigest: baseline.previewDigest,
      previewKind: baseline.previewKind,
      observedAt: now()
    });
  }
  const queue = planned.queue.map((target) => Object.freeze({ ...target, tabId: scan.tabId }));

  let results = [];
  let processed = 0;
  let openedCount = 0;
  emitStatus(safeStatus("running", { queued: queue.length, unresolved: retained.count, reasonCode: retained.reasonCode }), logger, onStatus);
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const target = queue[queueIndex];
    throwIfAborted(signal);
    if (target.previewKind === "unsupported") {
      return emitStopped("BOSS_MESSAGE_CONTENT_UNSUPPORTED", queue.length, results, logger, onStatus, retained, processed);
    }
    let selected;
    try {
      openedCount += 1;
      selected = await reader.openQueuedConversation(target, signal);
    } catch (error) {
      if (shouldInterrupt(error, signal)) throw error;
      return emitStopped(errorCode(error), queue.length, results, logger, onStatus, retained, processed);
    }
    if (selected?.skipped) {
      await paceBeforeNext({
        queueIndex,
        queueLength: queue.length,
        openedCount,
        sleepFn,
        randomFn,
        signal
      });
      continue;
    }

    let resolved = resolveUniqueCandidate(candidates, selected, target.conversationKey);
    let contextStopCode = "";
    const canResolveContext = resolved.ok
      || ["BOSS_MESSAGE_CARD_NOT_FOUND", "BOSS_MESSAGE_CARD_AMBIGUOUS"].includes(resolved.reasonCode);
    if (canResolveContext && typeof resolveJobContext === "function") {
      try {
        const candidate = resolved.ok ? resolved.candidate : null;
        const context = await resolveJobContext({ target, selected, candidate, signal });
        if (!validResolvedContext(context, target.conversationKey)) {
          throw discoveryError("MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE", "job context is unavailable");
        }
        resolved = { ...context, ok: true };
      } catch (error) {
        if (shouldInterrupt(error, signal)) {
          clearSelectedSnapshot(selected);
          throw error;
        }
        contextStopCode = shouldStopAfterContextFailure(error) ? errorCode(error) : "";
        resolved = { ok: false, reasonCode: contextFailureReason(error) };
      }
    } else if (resolved.ok && !hasCompleteJobContext(resolved.job)) {
      resolved = { ok: false, reasonCode: "MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE" };
    }
    if (!resolved.ok) {
      const identity = {
        positionTitle: selected?.positionName,
        company: selected?.companyName,
        salary: selected?.salary,
        city: selected?.city
      };
      clearSelectedSnapshot(selected);
      recordUnresolvedMessageDiscoveryItem(db, {
        profileId,
        platform: "boss",
        conversationKey: target.conversationKey,
        previewDigest: target.previewDigest,
        previewKind: target.previewKind,
        reasonCode: resolved.reasonCode,
        observedAt: now(),
        identity
      });
      retained = unresolvedSummary(db, profileId);
      emitStatus(safeStatus("running", {
        queued: queue.length,
        processed,
        unresolved: retained.count,
        reasonCode: retained.reasonCode,
        results
      }), logger, onStatus);
      if (contextStopCode) {
        return emitStopped(contextStopCode, queue.length, results, logger, onStatus, retained, processed);
      }
      await paceBeforeNext({
        queueIndex,
        queueLength: queue.length,
        openedCount,
        sleepFn,
        randomFn,
        signal
      });
      continue;
    }
    let incoming;
    try {
      incoming = selectUnprocessedFriendMessageGroup(
        db,
        resolved.cardId,
        selected,
        resolved.threadKey
      );
    } catch (error) {
      clearSelectedSnapshot(selected);
      throw error;
    }
    clearSelectedIdentity(selected);
    if (!incoming.ok) {
      clearSelectedSnapshot(selected);
      if (incoming.skipped) {
        commitBaseline(db, profileId, target, now());
        clearUnresolvedMessageDiscoveryItem(db, {
          profileId,
          platform: "boss",
          conversationKey: target.conversationKey
        });
        retained = unresolvedSummary(db, profileId);
        await paceBeforeNext({
          queueIndex,
          queueLength: queue.length,
          openedCount,
          sleepFn,
          randomFn,
          signal
        });
        continue;
      }
      return emitStopped(incoming.reasonCode, queue.length, results, logger, onStatus, retained, processed);
    }

    let classification;
    try {
      classification = await classifyMessageGroup({
        profile,
        card: resolved.card,
        job: resolved.job,
        messages: incoming.messages,
        facts,
        contextSource: resolved.contextSource || resolved.job.contextSource || ""
      });
    } catch (error) {
      const errorCode = String(error?.code || "");
      if (!/^MESSAGE_REPLY_[A-Z0-9_]+$/.test(errorCode)
        && !TERMINAL_MODEL_OUTPUT_CODES.has(errorCode)) throw error;
      classification = {
        messageCategory: "other",
        missingFact: null,
        messages: [],
        manualActionReason: "model_contract_invalid",
        progressUpdate: { stage: "needs_user_action" }
      };
    } finally {
      for (const item of incoming.messages) item.text = "";
      clearSelectedSnapshot(selected);
    }
    throwIfAborted(signal);
    const card = recordDiscoveredMessageGroupClassification(db, {
      cardId: resolved.cardId,
      platform: "boss",
      threadKey: resolved.threadKey,
      legacyThreadKey: resolved.legacyThreadKey || "",
      messageKeys: incoming.newMessageKeys,
      messageGroupKey: incoming.messageGroupKey,
      messageCategory: classification.messageCategory,
      missingFactKey: classification.missingFact?.key || "",
      progressUpdate: classification.progressUpdate,
      occurredAt: now()
    });
    commitBaseline(db, profileId, target, now());
    clearUnresolvedMessageDiscoveryItem(db, {
      profileId,
      platform: "boss",
      conversationKey: target.conversationKey
    });
    retained = unresolvedSummary(db, profileId);
    results = results.filter((item) => item.cardId !== card.id);
    processed += 1;
    results.push(safeResult(
      card,
      classification,
      resolved.job,
      resolved.contextSource || resolved.job.contextSource || ""
    ));
    emitStatus(
      safeStatus("running", { queued: queue.length, processed, results, unresolved: retained.count, reasonCode: retained.reasonCode }),
      logger,
      onStatus
    );
    await paceBeforeNext({
      queueIndex,
      queueLength: queue.length,
      openedCount,
      sleepFn,
      randomFn,
      signal
    });
  }
  retained = unresolvedSummary(db, profileId);
  const completed = safeStatus(retained.count ? "needs_user_action" : "completed", {
    queued: queue.length,
    processed,
    unresolved: retained.count,
    reasonCode: retained.reasonCode,
    results
  });
  emitStatus(completed, logger, onStatus);
  return completed;
}

async function paceBeforeNext({
  queueIndex,
  queueLength,
  openedCount,
  sleepFn,
  randomFn,
  signal
}) {
  if (queueIndex + 1 >= queueLength) return;
  await sleepFn(randomBetween(1500, 2500, randomFn), signal);
  if (openedCount % 10 === 0) await sleepFn(15_000, signal);
}

function resolveUniqueCandidate(candidates, selected, canonicalThreadKey) {
  const title = normalizedText(selected?.positionName);
  const matches = candidates.filter((candidate) => normalizedText(candidate.title) === title);
  if (matches.length === 0) return { ok: false, reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND" };
  if (matches.length !== 1) return { ok: false, reasonCode: "BOSS_MESSAGE_CARD_AMBIGUOUS" };
  const candidate = matches[0];
  if (conflicts(candidate.salary, selected.salary)) {
    return { ok: false, reasonCode: "BOSS_MESSAGE_SALARY_MISMATCH" };
  }
  if (conflicts(candidate.city, selected.city)) {
    return { ok: false, reasonCode: "BOSS_MESSAGE_CITY_MISMATCH" };
  }
  if (conflicts(candidate.company, selected.companyName)) {
    return { ok: false, reasonCode: "BOSS_MESSAGE_COMPANY_MISMATCH" };
  }
  const legacyThreadKey = safeDigest(["boss", selected.headerText, selected.positionName]);
  if (candidate.threadKey
    && candidate.threadKey !== canonicalThreadKey
    && candidate.threadKey !== legacyThreadKey) {
    return { ok: false, reasonCode: "BOSS_MESSAGE_THREAD_MISMATCH" };
  }
  return {
    ok: true,
    candidate,
    cardId: candidate.cardId,
    threadKey: canonicalThreadKey,
    legacyThreadKey: candidate.threadKey === legacyThreadKey && legacyThreadKey !== canonicalThreadKey
      ? legacyThreadKey
      : "",
    contextSource: candidate.contextSource || "",
    card: {
      id: candidate.cardId,
      profileId: candidate.profileId,
      planId: candidate.planId,
      jobId: candidate.jobId,
      source: candidate.source,
      stage: candidate.stage,
      threadKey: candidate.threadKey
    },
    job: {
      id: candidate.jobId,
      source: candidate.source,
      sourceId: candidate.sourceId,
      title: candidate.title,
      company: candidate.company,
      salary: candidate.salary,
      location: candidate.city,
      experience: candidate.experience,
      education: candidate.education,
      bossActiveText: candidate.bossActiveText,
      url: candidate.url,
      tags: candidate.tags,
      description: candidate.description,
      qualityTags: candidate.qualityTags,
      analysis: candidate.analysis,
      observationId: candidate.observationId,
      batchId: candidate.batchId,
      contextComplete: candidate.contextComplete,
      contextSource: candidate.contextSource
    }
  };
}

function hasCompleteJobContext(job) {
  return String(job?.description || "").trim().length >= 120
    && job?.analysis?.semanticStatus === "complete";
}

function validResolvedContext(value, canonicalThreadKey) {
  return value && typeof value === "object"
    && Number.isInteger(Number(value.cardId))
    && Number(value.cardId) > 0
    && Number(value.card?.id) === Number(value.cardId)
    && value.threadKey === canonicalThreadKey
    && hasCompleteJobContext(value.job);
}

function contextFailureReason(error) {
  const code = errorCode(error);
  return [
    "MESSAGE_DISCOVERY_JOB_DETAIL_INCOMPLETE",
    "MESSAGE_DISCOVERY_JOB_ANALYSIS_INCOMPLETE"
  ].includes(code)
    ? code
    : "MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE";
}

function shouldStopAfterContextFailure(error) {
  return CONTEXT_TERMINAL_CODES.has(errorCode(error));
}

function selectUnprocessedFriendMessageGroup(db, cardId, selected, threadKey) {
  const messages = Array.isArray(selected?.messages) ? selected.messages : [];
  let lastMyself = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.direction === "myself") lastMyself = index;
  }
  const candidates = [];
  for (let index = lastMyself + 1; index < messages.length; index += 1) {
    const item = messages[index];
    if (!item || typeof item !== "object") continue;
    if (String(item.direction || "") !== "friend") {
      item.messageId = "";
      item.text = "";
      continue;
    }
    if (String(item.contentKind || "text") !== "text") {
      clearMessageSources(messages);
      return { ok: false, reasonCode: "BOSS_MESSAGE_CONTENT_UNSUPPORTED" };
    }
    const text = String(item.text || "").replace(/\s+/g, " ").trim();
    if (!text) {
      item.messageId = "";
      item.text = "";
      continue;
    }
    let digest;
    try {
      digest = messageKey({
        platform: "boss",
        threadKey,
        messageId: item.messageId
      });
    } finally {
      item.messageId = "";
    }
    const idempotencyKey = `message:boss:${digest.slice(7)}`;
    const exists = db.prepare(`SELECT 1 AS found FROM candidate_progress_events
      WHERE card_id = ? AND idempotency_key = ?`).get(cardId, idempotencyKey);
    candidates.push({
      messageKey: digest,
      text,
      isNew: !exists
    });
    item.text = "";
  }
  for (const item of messages) {
    item.messageId = "";
    item.text = "";
  }
  const processed = candidates.filter((item) => !item.isNew);
  const unprocessed = candidates.filter((item) => item.isNew);
  const grouped = [...processed, ...unprocessed];
  if (grouped.length > BOSS_MESSAGE_GROUP_LIMIT) {
    return { ok: false, reasonCode: "BOSS_MESSAGE_GROUP_LIMIT" };
  }
  if (grouped.reduce((sum, item) => sum + item.text.length, 0) > BOSS_MESSAGE_GROUP_TEXT_LIMIT) {
    return { ok: false, reasonCode: "BOSS_MESSAGE_GROUP_TEXT_LIMIT" };
  }
  const newMessageKeys = unprocessed.map((item) => item.messageKey);
  if (newMessageKeys.length === 0) {
    return { ok: false, skipped: true, reasonCode: "BOSS_MESSAGE_ALREADY_PROCESSED" };
  }
  return {
    ok: true,
    messages: grouped.map(({ messageKey: itemKey, text }) => ({ messageKey: itemKey, text })),
    messageGroupKey: safeDigest(["message-group", threadKey, ...grouped.map((item) => item.messageKey)]),
    newMessageKeys
  };
}

function commitBaseline(db, profileId, target, occurredAt = new Date().toISOString()) {
  if (!target?.conversationKey || !target?.previewDigest) return;
  commitProcessedPreview(db, {
    profileId,
    platform: "boss",
    conversationKey: target.conversationKey,
    previewDigest: target.previewDigest,
    previewKind: target.previewKind || "unknown",
    observedAt: occurredAt
  });
}

function clearMessageSources(messages) {
  for (const item of messages || []) {
    if (!item || typeof item !== "object") continue;
    item.messageId = "";
    item.text = "";
  }
}

function safeResult(card, result, resolvedJob, contextSource) {
  const missingFactKey = String(result.missingFact?.key || "").trim().slice(0, 80);
  const messages = MANUAL_ONLY_CATEGORIES.has(result.messageCategory) || missingFactKey
    ? []
    : Array.isArray(result.messages)
      ? result.messages.slice(0, 2).map((item) => String(item))
      : [];
  return {
    cardId: card.id,
    jobId: card.jobId,
    stage: card.stage,
    messageCategory: String(result.messageCategory || ""),
    messageSummary: safeProjectionText(result.messageSummary, 160),
    missingFactKey,
    manualActionReason: safeManualActionReason(result, missingFactKey, messages),
    contextSource: ["local_cache", "message_discovery_detail"].includes(contextSource) ? contextSource : "",
    contextComplete: hasCompleteJobContext(resolvedJob),
    job: projectMessageDecisionCard(resolvedJob),
    messages
  };
}

function safeManualActionReason(result, missingFactKey, messages) {
  if (missingFactKey) return "需要先确认候选人事实后再回复";
  if (result.manualActionReason === "model_contract_invalid") {
    return "模型结果未通过安全校验，需要人工处理";
  }
  if (messages.length) return "";
  const categoryReason = {
    interview_invitation: "面试邀请需要人工确认时间和安排",
    salary: "薪资问题需要人工确认口径",
    sensitive: "消息涉及敏感信息，需要人工处理",
    identity_uncertain: "岗位或会话身份仍需人工核对"
  }[String(result.messageCategory || "")];
  return categoryReason || "当前结果需要人工处理";
}

function projectMessageDecisionCard(job = {}) {
  const analysis = job.analysis && typeof job.analysis === "object" && !Array.isArray(job.analysis)
    ? job.analysis
    : {};
  const fitLabel = decisionFitLabel(analysis.fitLevel);
  const fitSummary = decisionFitSummary(analysis, fitLabel);
  const opportunitySummary = decisionOpportunitySummary(analysis, fitSummary);
  return {
    title: safeProjectionText(job.title, 160),
    company: safeProjectionText(job.company, 160),
    roleSummary: safeProjectionText(analysis.roleSummary, 300),
    ...companyDecisionSummary(analysis),
    fitLabel,
    fitSummary,
    salary: safeProjectionText(job.salary, 80),
    opportunityVerdict: opportunityVerdict(analysis.recommendation),
    opportunitySummary
  };
}

function companyDecisionSummary(analysis) {
  const scenario = meaningfulAnalysisText(analysis.businessScenario, 180);
  if (scenario) return { companyBusiness: `JD 显示该岗位服务于${scenario}。` };
  const industry = meaningfulAnalysisText(analysis.industryContext, 120);
  if (industry) return { companyBusiness: `JD 显示该岗位属于${industry}相关业务场景。` };
  return { companyBusiness: "JD 暂未说明公司的具体业务。" };
}

function meaningfulAnalysisText(value, limit) {
  const text = safeProjectionText(value, limit);
  return ["", "未明确", "未知", "无", "暂无", "不明确"].includes(text) ? "" : text;
}

function decisionFitLabel(value) {
  const level = String(value || "").trim();
  if (["fit", "A"].includes(level)) return "高";
  if (["mostly_fit", "partial_fit", "B", "C"].includes(level)) return "中";
  if (["no_fit", "D"].includes(level)) return "低";
  return "待确认";
}

function decisionFitSummary(analysis, fitLabel) {
  if (fitLabel === "高") return safeProjectionList(analysis.fitReasons, 1, 180)[0] || "";
  if (fitLabel === "中") {
    const positive = safeProjectionList(analysis.fitReasons, 1, 89)[0] || "";
    const gap = safeProjectionList(analysis.roleGaps?.length ? analysis.roleGaps : analysis.softGaps, 1, 89)[0] || "";
    return [positive, gap].filter(Boolean).join("；");
  }
  if (fitLabel === "低") {
    const ruleReason = analysis.ruleAdjusted === true
      ? safeProjectionList(analysis.fitReasons, 1, 180)[0] || ""
      : "";
    const blocker = safeProjectionList(analysis.hardBlockers, 1, 180, (item) => item?.requirement ?? item)[0] || "";
    const gap = safeProjectionList(analysis.roleGaps?.length ? analysis.roleGaps : analysis.softGaps, 1, 180)[0] || "";
    const positive = safeProjectionList(analysis.fitReasons, 1, 180)[0] || "";
    return ruleReason || blocker || gap || positive;
  }
  return "";
}

function decisionOpportunitySummary(analysis, fitSummary) {
  const ruleReason = analysis.ruleAdjusted === true
    ? safeProjectionList(analysis.fitReasons, 1, 180)[0] || ""
    : "";
  const qualityRisk = safeProjectionList(
    analysis.jobQuality?.concerns,
    1,
    180,
    (item) => item?.evidence ?? item
  )[0] || "";
  return ruleReason || qualityRisk || fitSummary;
}

function opportunityVerdict(value) {
  return {
    primary: "值得继续聊",
    apply: "值得继续聊",
    caution: "可以了解，但要先确认关键问题",
    not_recommended: "不建议优先投入时间"
  }[String(value || "")] || "信息不足，暂时无法判断";
}

function safeProjectionList(value, limit, textLimit, select = (item) => item) {
  const projected = [];
  for (const item of Array.isArray(value) ? value : []) {
    const text = safeProjectionText(select(item), textLimit);
    if (text && !projected.includes(text)) projected.push(text);
    if (projected.length >= limit) break;
  }
  return projected;
}

function safeProjectionText(value, limit) {
  if (!["string", "number"].includes(typeof value)) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, limit);
}

function randomBetween(min, max, randomFn) {
  return Math.floor(min + randomFn() * (max - min + 1));
}

function abortableSleep(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || discoveryError("MESSAGE_DISCOVERY_STOPPED", "message discovery stopped"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function safeStatus(status, value = {}) {
  return {
    status,
    queued: Number(value.queued || 0),
    processed: Number(value.processed || 0),
    unresolved: Number(value.unresolved || 0),
    reasonCode: String(value.reasonCode || ""),
    results: Array.isArray(value.results)
      ? value.results.map((item) => ({
        ...item,
        messages: Array.isArray(item.messages) ? [...item.messages] : []
      }))
      : []
  };
}

function unresolvedSummary(db, profileId) {
  const items = listUnresolvedMessageDiscoveryItems(db, { profileId });
  return { count: items.length, reasonCode: items[0]?.reasonCode || "" };
}

function stoppedSummary(reasonCode, queued, results, retained = {}, processed = 0) {
  return safeStatus("needs_user_action", {
    reasonCode,
    queued,
    processed,
    unresolved: retained.count,
    results
  });
}

function emitStopped(reasonCode, queued, results, logger, onStatus, retained, processed) {
  const stopped = stoppedSummary(reasonCode, queued, results, retained, processed);
  emitStatus(stopped, logger, onStatus);
  return stopped;
}

function emitStatus(status, logger, onStatus) {
  onStatus(status);
  if (typeof logger?.info === "function") {
    logger.info("boss_message_discovery", {
      status: status.status,
      queued: status.queued,
      processed: status.processed,
      unresolved: status.unresolved,
      reasonCode: status.reasonCode
    });
  }
}

function clearSelectedIdentity(selected) {
  if (!selected || typeof selected !== "object") return;
  selected.headerText = "";
  selected.positionName = "";
  selected.companyName = "";
  selected.salary = "";
  selected.city = "";
  if (Array.isArray(selected.rows)) {
    for (const row of selected.rows) {
      if (!row || typeof row !== "object") continue;
      row.recruiterLabel = "";
      row.previewText = "";
    }
  }
}

function clearSelectedSnapshot(selected) {
  clearSelectedIdentity(selected);
  if (!Array.isArray(selected?.messages)) return;
  for (const item of selected.messages) {
    if (!item || typeof item !== "object") continue;
    item.messageId = "";
    item.text = "";
  }
}

function conflicts(left, right) {
  const local = normalizedText(left);
  const remote = normalizedText(right);
  return Boolean(local && remote && local !== remote);
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason || discoveryError("MESSAGE_DISCOVERY_STOPPED", "message discovery stopped");
  }
}

function shouldInterrupt(error, signal) {
  return Boolean(signal?.aborted)
    || ["MESSAGE_DISCOVERY_STOPPED", "MESSAGE_DISCOVERY_LEASE_LOST", "BOSS_RISK_CONTROL"].includes(error?.code);
}

function errorCode(error) {
  const code = String(error?.code || "");
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : "MESSAGE_DISCOVERY_READER_ERROR";
}

function discoveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function messageReplyProfile(value = {}) {
  const profile = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const candidate = profile.candidate && typeof profile.candidate === "object" ? profile.candidate : {};
  return {
    candidate: {
      city: profileText(candidate.city),
      targetTitles: profileTextList(candidate.targetTitles, 10),
      expectedSalary: profileText(candidate.expectedSalary),
      adjustableSalary: profileTextList(candidate.adjustableSalary, 4)
    },
    education: profileObjectList(profile.education, [
      "degree", "major", "startDate", "endDate", "status", "highlights"
    ], 6),
    experiences: profileObjectList(profile.experiences, [
      "organization", "role", "type", "startDate", "endDate",
      "roleBoundary", "highlights", "technologies"
    ], 12),
    skills: profileObjectList(profile.skills, ["name", "level", "evidence"], 40),
    projects: profileObjectList(profile.projects, [
      "name", "period", "context", "roleBoundary", "canSay",
      "technologies", "results", "avoidSaying"
    ], 10),
    credentials: profileObjectList(profile.credentials, ["name", "details"], 12),
    strengths: profileTextList(profile.strengths, 12)
  };
}

function profileObjectList(value, keys, limit) {
  return (Array.isArray(value) ? value : []).slice(0, limit).map((item) => {
    const source = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    return Object.fromEntries(keys.map((key) => [
      key,
      Array.isArray(source[key]) ? profileTextList(source[key], 20) : profileText(source[key])
    ]));
  });
}

function profileTextList(value, limit) {
  return (Array.isArray(value) ? value : []).slice(0, limit).map(profileText).filter(Boolean);
}

function profileText(value) {
  return String(value == null ? "" : value).trim().slice(0, 2000);
}

module.exports = {
  runBossMessageDiscovery,
  projectMessageDecisionCard,
  selectUnprocessedFriendMessageGroup,
  abortableSleep,
  randomBetween
};
