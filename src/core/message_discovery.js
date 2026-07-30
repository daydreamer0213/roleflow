const {
  listMessageDiscoveryCandidates,
  recordDiscoveredMessageClassification
} = require("./candidate_progress");
const { safeDigest, messageKey } = require("../adapters/sites/boss_message_dom");

async function runBossMessageDiscovery({
  db,
  profileId,
  reader,
  classifyMessage,
  logger = null,
  signal = null,
  now = () => new Date().toISOString(),
  sleepFn = abortableSleep,
  randomFn = Math.random,
  onStatus = () => {}
}) {
  const candidates = listMessageDiscoveryCandidates(db, { profileId });
  let queue;
  try {
    throwIfAborted(signal);
    ({ queue } = await reader.scanUnread());
  } catch (error) {
    if (shouldInterrupt(error, signal)) throw error;
    return emitStopped(errorCode(error), 0, [], logger, onStatus);
  }
  if (!Array.isArray(queue)) {
    return emitStopped("BOSS_MESSAGE_QUEUE_INVALID", 0, [], logger, onStatus);
  }

  const results = [];
  emitStatus(safeStatus("running", { queued: queue.length }), logger, onStatus);
  for (const target of queue) {
    throwIfAborted(signal);
    let selected;
    try {
      selected = await reader.openQueuedConversation(target, signal);
    } catch (error) {
      if (shouldInterrupt(error, signal)) throw error;
      return emitStopped(errorCode(error), queue.length, results, logger, onStatus);
    }
    if (selected?.skipped) continue;

    const resolved = resolveUniqueCandidate(candidates, selected);
    if (!resolved.ok) {
      clearSelectedSnapshot(selected);
      return emitStopped(resolved.reasonCode, queue.length, results, logger, onStatus);
    }
    let incoming;
    try {
      incoming = selectSingleUnprocessedFriendMessage(
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
      if (incoming.skipped) continue;
      return emitStopped(incoming.reasonCode, queue.length, results, logger, onStatus);
    }

    let classification;
    try {
      classification = await classifyMessage({
        card: resolved.card,
        job: resolved.job,
        hrMessage: incoming.text
      });
    } finally {
      incoming.text = "";
      clearSelectedSnapshot(selected);
    }
    const card = recordDiscoveredMessageClassification(db, {
      cardId: resolved.cardId,
      platform: "boss",
      threadKey: resolved.threadKey,
      messageKey: incoming.messageKey,
      messageCategory: classification.messageCategory,
      missingFactKey: classification.missingFact?.key || "",
      progressUpdate: classification.progressUpdate,
      occurredAt: now()
    });
    results.push(safeResult(card, classification));
    emitStatus(
      safeStatus("running", { queued: queue.length, processed: results.length, results }),
      logger,
      onStatus
    );
    if (results.length < queue.length) {
      await sleepFn(randomBetween(1500, 2500, randomFn), signal);
      if (results.length % 10 === 0) await sleepFn(15_000, signal);
    }
  }
  const completed = safeStatus("completed", {
    queued: queue.length,
    processed: results.length,
    results
  });
  emitStatus(completed, logger, onStatus);
  return completed;
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
      profileId: null,
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

function selectSingleUnprocessedFriendMessage(db, cardId, selected, threadKey) {
  const messages = Array.isArray(selected?.messages) ? selected.messages : [];
  let lastMyself = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.direction === "myself") lastMyself = index;
  }
  const unprocessed = [];
  for (let index = lastMyself + 1; index < messages.length; index += 1) {
    const item = messages[index];
    if (item?.direction !== "friend") continue;
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
    if (exists) {
      item.text = "";
      continue;
    }
    unprocessed.push({
      messageKey: digest,
      text: String(item.text || ""),
      source: item
    });
    item.text = "";
  }
  for (const item of messages) {
    item.messageId = "";
    if (!unprocessed.some((candidate) => candidate.source === item)) item.text = "";
  }
  if (unprocessed.length > 1) {
    for (const item of unprocessed) item.text = "";
    return { ok: false, reasonCode: "BOSS_MESSAGE_MULTIPLE_UNPROCESSED" };
  }
  if (unprocessed.length === 0) {
    return { ok: false, skipped: true, reasonCode: "BOSS_MESSAGE_ALREADY_PROCESSED" };
  }
  const incoming = unprocessed[0];
  delete incoming.source;
  return { ok: true, ...incoming };
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
    reasonCode: String(value.reasonCode || ""),
    results: Array.isArray(value.results)
      ? value.results.map((item) => ({
        ...item,
        messages: Array.isArray(item.messages) ? [...item.messages] : []
      }))
      : []
  };
}

function stoppedSummary(reasonCode, queued, results) {
  return safeStatus("needs_user_action", {
    reasonCode,
    queued,
    processed: results.length,
    results
  });
}

function emitStopped(reasonCode, queued, results, logger, onStatus) {
  const stopped = stoppedSummary(reasonCode, queued, results);
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
      reasonCode: status.reasonCode
    });
  }
}

function clearSelectedIdentity(selected) {
  if (!selected || typeof selected !== "object") return;
  selected.headerText = "";
  selected.positionName = "";
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
    || ["MESSAGE_DISCOVERY_STOPPED", "MESSAGE_DISCOVERY_LEASE_LOST"].includes(error?.code);
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

module.exports = {
  runBossMessageDiscovery,
  abortableSleep,
  randomBetween
};
