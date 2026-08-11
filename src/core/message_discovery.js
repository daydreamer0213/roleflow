const {
  listMessageDiscoveryCandidates,
  recordDiscoveredMessageGroupClassification
} = require("./candidate_progress");
const { getCandidateProfile, listCandidateFacts } = require("./storage");
const { safeDigest, messageKey } = require("../adapters/sites/boss_message_dom");
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

async function runBossMessageDiscovery({
  db,
  profileId,
  reader,
  classifyMessageGroup,
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
      return emitStopped("BOSS_MESSAGE_CONTENT_UNSUPPORTED", queue.length, results, logger, onStatus, retained);
    }
    let selected;
    try {
      openedCount += 1;
      selected = await reader.openQueuedConversation(target, signal);
    } catch (error) {
      if (shouldInterrupt(error, signal)) throw error;
      return emitStopped(errorCode(error), queue.length, results, logger, onStatus, retained);
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

    const resolved = resolveUniqueCandidate(candidates, selected);
    if (!resolved.ok) {
      clearSelectedSnapshot(selected);
      recordUnresolvedMessageDiscoveryItem(db, {
        profileId,
        platform: "boss",
        conversationKey: target.conversationKey,
        previewDigest: target.previewDigest,
        previewKind: target.previewKind,
        reasonCode: resolved.reasonCode,
        observedAt: now()
      });
      retained = unresolvedSummary(db, profileId);
      emitStatus(safeStatus("running", {
        queued: queue.length,
        processed,
        unresolved: retained.count,
        reasonCode: retained.reasonCode,
        results
      }), logger, onStatus);
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
      return emitStopped(incoming.reasonCode, queue.length, results, logger, onStatus, retained);
    }

    let classification;
    try {
      classification = await classifyMessageGroup({
        profile,
        card: resolved.card,
        job: resolved.job,
        messages: incoming.messages,
        facts
      });
    } finally {
      for (const item of incoming.messages) item.text = "";
      clearSelectedSnapshot(selected);
    }
    throwIfAborted(signal);
    const card = recordDiscoveredMessageGroupClassification(db, {
      cardId: resolved.cardId,
      platform: "boss",
      threadKey: resolved.threadKey,
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
    results.push(safeResult(card, classification));
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

function resolveUniqueCandidate(candidates, selected) {
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
  const threadKey = safeDigest(["boss", selected.headerText, selected.positionName]);
  if (candidate.threadKey && candidate.threadKey !== threadKey) {
    return { ok: false, reasonCode: "BOSS_MESSAGE_THREAD_MISMATCH" };
  }
  return {
    ok: true,
    cardId: candidate.cardId,
    threadKey,
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
      title: candidate.title,
      company: candidate.company,
      salary: candidate.salary,
      location: candidate.city
    }
  };
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

function safeResult(card, result) {
  const missingFactKey = String(result.missingFact?.key || "").trim().slice(0, 80);
  const messages = result.messageCategory === "interview_invitation" || missingFactKey
    ? []
    : Array.isArray(result.messages)
      ? result.messages.slice(0, 2).map((item) => String(item))
      : [];
  return {
    cardId: card.id,
    jobId: card.jobId,
    stage: card.stage,
    messageCategory: String(result.messageCategory || ""),
    missingFactKey,
    messages
  };
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

function stoppedSummary(reasonCode, queued, results, retained = {}) {
  return safeStatus("needs_user_action", {
    reasonCode,
    queued,
    processed: 0,
    unresolved: retained.count,
    results
  });
}

function emitStopped(reasonCode, queued, results, logger, onStatus, retained) {
  const stopped = stoppedSummary(reasonCode, queued, results, retained);
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
  selectUnprocessedFriendMessageGroup,
  abortableSleep,
  randomBetween
};
