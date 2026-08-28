const {
  recordProgressEvent,
  derivedProgressIdempotencyKey
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
    const cards = db.prepare(`SELECT id FROM candidate_progress_cards
      WHERE profile_id = ? AND thread_key = ? ORDER BY id`).all(profile, threadKey);
    if (cards.length !== 1) {
      counts.skipped += 1;
      continue;
    }
    const cardId = Number(cards[0].id);
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
