const {
  recordProgressEvent,
  derivedProgressIdempotencyKey,
  bindProgressCardThread
} = require("./candidate_progress");

const OBSERVATION_TYPES = Object.freeze({
  self_read: {
    type: "outbound_read_observed",
    summary: "平台显示最近发出消息已读",
    countKey: "readObserved"
  },
  self_delivered: {
    type: "outbound_delivered_observed",
    summary: "平台显示最近发出消息已送达",
    countKey: "deliveredObserved"
  },
  possible_hr_reply: {
    type: "inbound_reply_observed",
    summary: "平台显示招聘方有新回复",
    countKey: "inboundReplyObserved"
  }
});

function recordFunnelRowObservations(db, {
  profileId,
  platform = "boss",
  rows = [],
  observedAt = new Date().toISOString()
} = {}) {
  const profile = positiveInteger(profileId, "profileId");
  const site = String(platform || "").trim().toLowerCase();
  if (site !== "boss") throw new Error("funnel observation platform is invalid");
  const occurredAt = isoText(observedAt, "observedAt");
  const counts = {
    readObserved: 0,
    deliveredObserved: 0,
    inboundReplyObserved: 0,
    unbound: 0,
    skipped: 0
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    const definition = OBSERVATION_TYPES[row?.previewKind];
    const threadKey = safeDigest(row?.conversationKey);
    const previewDigest = safeDigest(row?.previewDigest);
    if (!definition || !threadKey || !previewDigest) {
      counts.skipped += 1;
      continue;
    }
    const cardId = resolveObservationCard(db, {
      profileId: profile,
      platform: site,
      sourceJobId: row?.sourceJobId,
      threadKey,
      observedAt: occurredAt
    });
    if (!cardId) {
      counts.unbound += 1;
      counts.skipped += 1;
      continue;
    }
    recordProgressEvent(db, {
      cardId,
      idempotencyKey: derivedProgressIdempotencyKey([
        "funnel-row",
        cardId,
        definition.type,
        previewDigest
      ]),
      type: definition.type,
      actor: "system",
      summary: definition.summary,
      metadata: {
        source: "platform_observation",
        platform: site,
        threadKey,
        messageKey: previewDigest
      },
      occurredAt
    });
    counts[definition.countKey] += 1;
  }
  return counts;
}

function resolveObservationCard(db, { profileId, platform, sourceJobId, threadKey, observedAt }) {
  const sourceId = String(sourceJobId || "").trim();
  if (/^boss:[A-Za-z0-9_-]{6,160}$/.test(sourceId)) {
    const direct = db.prepare(`SELECT cards.id, cards.thread_key
      FROM candidate_progress_cards cards
      JOIN jobs ON jobs.id = cards.job_id
      WHERE cards.profile_id = ? AND jobs.source = ? AND jobs.source_id = ?
      ORDER BY cards.id`).all(profileId, platform, sourceId);
    if (direct.length > 1) return 0;
    if (direct.length === 1) {
      const currentThread = safeDigest(direct[0].thread_key);
      if (currentThread && currentThread !== threadKey) return 0;
      const cardId = Number(direct[0].id);
      if (!currentThread) bindProgressCardThread(db, { cardId, threadKey, now: observedAt });
      return cardId;
    }
  }
  const fallback = db.prepare(`SELECT id FROM candidate_progress_cards
    WHERE profile_id = ? AND thread_key = ? ORDER BY id`).all(profileId, threadKey);
  return fallback.length === 1 ? Number(fallback[0].id) : 0;
}

function safeDigest(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^sha256:[a-f0-9]{64}$/.test(text) ? text : "";
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function isoText(value, name) {
  const text = String(value || "").trim();
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${name} must be ISO-compatible`);
  return new Date(Date.parse(text)).toISOString();
}

module.exports = { recordFunnelRowObservations };
