const PREVIEW_KINDS = new Set([
  "self_delivered",
  "self_read",
  "platform_notice",
  "possible_hr_reply",
  "unsupported",
  "unknown"
]);
const UNRESOLVED_REASON_CODES = new Set([
  "BOSS_MESSAGE_CARD_NOT_FOUND",
  "BOSS_MESSAGE_CARD_AMBIGUOUS",
  "BOSS_MESSAGE_SALARY_MISMATCH",
  "BOSS_MESSAGE_CITY_MISMATCH",
  "BOSS_MESSAGE_COMPANY_MISMATCH",
  "BOSS_MESSAGE_THREAD_MISMATCH"
]);

function listPreviewStates(db, { profileId } = {}) {
  const id = positiveInteger(profileId, "profileId");
  return db.prepare(`SELECT * FROM message_preview_states
    WHERE profile_id = ?
    ORDER BY updated_at DESC, conversation_key ASC`)
    .all(id)
    .map(mapPreviewState);
}

function recordPreviewState(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const platform = shortText(input.platform, 40);
  const conversationKey = digestKey(input.conversationKey, "conversationKey");
  const previewDigest = digestKey(input.previewDigest, "previewDigest");
  const previewKind = previewKindValue(input.previewKind);
  const observedAt = isoText(input.observedAt);
  if (!platform) throw previewError("PREVIEW_PLATFORM_REQUIRED", "preview platform is required");
  db.prepare(`INSERT INTO message_preview_states(
    profile_id, platform, conversation_key, preview_digest, preview_kind, observed_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(profile_id, platform, conversation_key) DO UPDATE SET
    preview_digest = excluded.preview_digest,
    preview_kind = excluded.preview_kind,
    observed_at = excluded.observed_at,
    updated_at = excluded.updated_at`)
    .run(profileId, platform, conversationKey, previewDigest, previewKind, observedAt, observedAt);
  const row = db.prepare(`SELECT * FROM message_preview_states
    WHERE profile_id = ? AND platform = ? AND conversation_key = ?`)
    .get(profileId, platform, conversationKey);
  return mapPreviewState(row);
}

function listUnresolvedMessageDiscoveryItems(db, { profileId } = {}) {
  const id = positiveInteger(profileId, "profileId");
  return db.prepare(`SELECT * FROM message_discovery_unresolved_items
    WHERE profile_id = ?
    ORDER BY last_observed_at DESC, conversation_key ASC`)
    .all(id)
    .map(mapUnresolvedItem);
}

function recordUnresolvedMessageDiscoveryItem(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const platform = shortText(input.platform, 40);
  const conversationKey = digestKey(input.conversationKey, "conversationKey");
  const previewDigest = digestKey(input.previewDigest, "previewDigest");
  const previewKind = previewKindValue(input.previewKind);
  const reasonCode = safeReasonCode(input.reasonCode);
  const observedAt = isoText(input.observedAt);
  if (!platform) throw previewError("PREVIEW_PLATFORM_REQUIRED", "preview platform is required");
  db.prepare(`INSERT INTO message_discovery_unresolved_items(
    profile_id, platform, conversation_key, preview_digest, preview_kind, reason_code,
    first_observed_at, last_observed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(profile_id, platform, conversation_key) DO UPDATE SET
    preview_digest = excluded.preview_digest,
    preview_kind = excluded.preview_kind,
    reason_code = excluded.reason_code,
    last_observed_at = excluded.last_observed_at`)
    .run(profileId, platform, conversationKey, previewDigest, previewKind, reasonCode, observedAt, observedAt);
  return mapUnresolvedItem(db.prepare(`SELECT * FROM message_discovery_unresolved_items
    WHERE profile_id = ? AND platform = ? AND conversation_key = ?`)
    .get(profileId, platform, conversationKey));
}

function clearUnresolvedMessageDiscoveryItem(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const platform = shortText(input.platform, 40);
  const conversationKey = digestKey(input.conversationKey, "conversationKey");
  if (!platform) throw previewError("PREVIEW_PLATFORM_REQUIRED", "preview platform is required");
  return db.prepare(`DELETE FROM message_discovery_unresolved_items
    WHERE profile_id = ? AND platform = ? AND conversation_key = ?`)
    .run(profileId, platform, conversationKey).changes > 0;
}

function planMessageDiscoveryQueue({ rows = [], baselines = new Map(), unresolved = new Map() } = {}) {
  const unreadQueue = [];
  const unresolvedQueue = [];
  const previewChangedQueue = [];
  const baselineWrites = [];
  for (const row of rows || []) {
    if (!row || typeof row !== "object") continue;
    const conversationKey = String(row.conversationKey || "").trim();
    const previewDigest = String(row.previewDigest || "").trim();
    const previewKind = previewKindValue(row.previewKind || "unknown");
    if (row.unread === true) {
      unreadQueue.push(queueTarget("unread", row, conversationKey, previewDigest, previewKind));
      continue;
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(conversationKey)) continue;
    if (unresolved.get(conversationKey)) {
      unresolvedQueue.push(queueTarget("durable_unresolved", row, conversationKey, previewDigest, previewKind));
      continue;
    }
    const baseline = baselines.get(conversationKey);
    if (!baseline) {
      baselineWrites.push(baselineWrite(conversationKey, previewDigest, previewKind));
      continue;
    }
    if (baseline.previewDigest === previewDigest) continue;
    if (previewKind === "possible_hr_reply" || previewKind === "unsupported") {
      previewChangedQueue.push(queueTarget("preview_changed", row, conversationKey, previewDigest, previewKind));
      continue;
    }
    baselineWrites.push(baselineWrite(conversationKey, previewDigest, previewKind));
  }
  return {
    queue: Object.freeze([...unreadQueue, ...unresolvedQueue, ...previewChangedQueue]),
    baselineWrites: Object.freeze(baselineWrites)
  };
}

function commitProcessedPreview(db, input = {}) {
  return recordPreviewState(db, input);
}

function queueTarget(operation, row, conversationKey, previewDigest, previewKind) {
  return Object.freeze({
    operation,
    rowIndex: row.rowIndex,
    conversationKey,
    previewDigest,
    previewKind,
    transientSignature: row.transientSignature || ""
  });
}

function baselineWrite(conversationKey, previewDigest, previewKind) {
  return Object.freeze({ conversationKey, previewDigest, previewKind });
}

function mapPreviewState(row) {
  return row ? {
    profileId: Number(row.profile_id),
    platform: row.platform,
    conversationKey: row.conversation_key,
    previewDigest: row.preview_digest,
    previewKind: row.preview_kind,
    observedAt: row.observed_at,
    updatedAt: row.updated_at
  } : null;
}

function mapUnresolvedItem(row) {
  return row ? {
    profileId: Number(row.profile_id),
    platform: row.platform,
    conversationKey: row.conversation_key,
    previewDigest: row.preview_digest,
    previewKind: row.preview_kind,
    reasonCode: row.reason_code,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at
  } : null;
}

function previewKindValue(value) {
  const kind = String(value || "").trim();
  if (!PREVIEW_KINDS.has(kind)) throw previewError("PREVIEW_KIND_INVALID", "preview kind is invalid");
  return kind;
}

function digestKey(value, name) {
  const key = String(value || "").trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(key)) {
    throw previewError("PREVIEW_DIGEST_INVALID", `${name} must be a SHA-256 digest`);
  }
  return key;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw previewError("PREVIEW_PROFILE_INVALID", `${name} must be a positive integer`);
  }
  return number;
}

function isoText(value) {
  const text = String(value || "").trim();
  if (!Number.isFinite(Date.parse(text))) throw previewError("PREVIEW_TIME_INVALID", "preview time must be ISO-compatible");
  return text;
}

function shortText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function safeReasonCode(value) {
  const code = String(value || "").trim();
  if (!UNRESOLVED_REASON_CODES.has(code)) {
    throw previewError("PREVIEW_REASON_INVALID", "unresolved reason code is invalid");
  }
  return code;
}

function previewError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  PREVIEW_KINDS,
  UNRESOLVED_REASON_CODES,
  listPreviewStates,
  recordPreviewState,
  listUnresolvedMessageDiscoveryItems,
  recordUnresolvedMessageDiscoveryItem,
  clearUnresolvedMessageDiscoveryItem,
  planMessageDiscoveryQueue,
  commitProcessedPreview
};
