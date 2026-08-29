const { createHash } = require("node:crypto");
const { immediateTransaction, nowIso, parseJson, storageError } = require("./storage_shared");

const BATCH_STATUSES = new Set(["confirmed", "running", "completed", "stopped", "interrupted"]);
const ITEM_STATUSES = new Set([
  "pending", "selecting", "verified", "filled", "click_dispatched", "succeeded",
  "target_mismatch", "platform_rejected", "ambiguous", "stopped"
]);
const BLOCKING_ITEM_STATUSES = ["pending", "selecting", "verified", "filled", "click_dispatched", "ambiguous"];
const CLICKED_ITEM_STATUSES = new Set(["click_dispatched", "succeeded", "platform_rejected", "ambiguous"]);
const TERMINAL_BATCH_STATUSES = new Set(["completed", "stopped", "interrupted"]);
const MAX_TEXT = 4000;

function saveMessageInboundContext(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const cardId = positiveInteger(input.cardId, "cardId");
  const messageGroupKey = digestKey(input.messageGroupKey, "messageGroupKey");
  const conversationKey = digestKey(input.conversationKey, "conversationKey");
  const sourceJobId = sourceJobKey(input.sourceJobId);
  const lastMessageId = messageId(input.lastMessageId);
  const messageIntent = inlineText(input.messageIntent, 80);
  const messageCategory = inlineText(input.messageCategory, 80);
  const inboundMessages = normalizeInboundMessages(input.inboundMessages);
  const manualActions = normalizeManualActions(input.manualActions);
  const createdAt = isoText(input.createdAt || nowIso(), "createdAt");
  const updatedAt = isoText(input.updatedAt || createdAt, "updatedAt");
  assertCardOwner(db, profileId, cardId);
  db.prepare(`INSERT INTO message_inbound_contexts(
    profile_id, card_id, message_group_key, conversation_key, source_job_id,
    last_message_id, message_intent, message_category, display_json,
    manual_actions_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(profile_id, card_id, message_group_key) DO UPDATE SET
    conversation_key = excluded.conversation_key,
    source_job_id = excluded.source_job_id,
    last_message_id = excluded.last_message_id,
    message_intent = excluded.message_intent,
    message_category = excluded.message_category,
    display_json = excluded.display_json,
    manual_actions_json = excluded.manual_actions_json,
    updated_at = excluded.updated_at`)
    .run(
      profileId, cardId, messageGroupKey, conversationKey, sourceJobId,
      lastMessageId, messageIntent, messageCategory, JSON.stringify(inboundMessages),
      JSON.stringify(manualActions), createdAt, updatedAt
    );
  return getMessageInboundContext(db, { profileId, cardId, messageGroupKey });
}

function getMessageInboundContext(db, { profileId, cardId, messageGroupKey } = {}) {
  const row = db.prepare(`SELECT * FROM message_inbound_contexts
    WHERE profile_id = ? AND card_id = ? AND message_group_key = ?`).get(
    positiveInteger(profileId, "profileId"),
    positiveInteger(cardId, "cardId"),
    digestKey(messageGroupKey, "messageGroupKey")
  );
  return row ? mapInboundContext(row) : null;
}

function listMessageInboundContexts(db, { profileId, cardId = null, limit = 100 } = {}) {
  const profile = positiveInteger(profileId, "profileId");
  const card = cardId === null || cardId === undefined || cardId === ""
    ? null
    : positiveInteger(cardId, "cardId");
  const bounded = boundedLimit(limit, 100, 500);
  const rows = card
    ? db.prepare(`SELECT * FROM message_inbound_contexts
        WHERE profile_id = ? AND card_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(profile, card, bounded)
    : db.prepare(`SELECT * FROM message_inbound_contexts
        WHERE profile_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(profile, bounded);
  return rows.map(mapInboundContext);
}

function deleteMessageInboundContext(db, { profileId, cardId, messageGroupKey } = {}) {
  return Number(db.prepare(`DELETE FROM message_inbound_contexts
    WHERE profile_id = ? AND card_id = ? AND message_group_key = ?`).run(
    positiveInteger(profileId, "profileId"),
    positiveInteger(cardId, "cardId"),
    digestKey(messageGroupKey, "messageGroupKey")
  ).changes) > 0;
}

function createMessageReplySendBatch(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const createdAt = isoText(input.createdAt || nowIso(), "createdAt");
  const requested = normalizeBatchItems(input.items);
  try {
    return immediateTransaction(db, () => {
      const frozen = requested.map((item) => freezeDraft(db, profileId, item));
      const batchId = Number(db.prepare(`INSERT INTO message_reply_send_batches(
        profile_id, status, stop_code, created_at, updated_at, completed_at
      ) VALUES (?, 'confirmed', '', ?, ?, NULL)`).run(profileId, createdAt, createdAt).lastInsertRowid);
      const insert = db.prepare(`INSERT INTO message_reply_send_items(
        batch_id, position, draft_id, card_id, job_id, conversation_key,
        source_job_id, expected_last_message_id, draft_revision, reply_text,
        reply_digest, status, click_count, evidence_json, error_code,
        error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, '{}', '', '', ?, ?)`);
      frozen.forEach((item, position) => insert.run(
        batchId, position, item.draftId, item.cardId, item.jobId, item.conversationKey,
        item.sourceJobId, item.expectedLastMessageId, item.draftRevision,
        item.replyText, item.replyDigest, createdAt, createdAt
      ));
      return {
        batch: getMessageReplySendBatch(db, { profileId, batchId }),
        items: listMessageReplySendItems(db, { profileId, batchId })
      };
    });
  } catch (error) {
    if (/UNIQUE constraint failed: message_reply_send_items\.draft_id/i.test(String(error?.message || ""))) {
      throw storageError("MESSAGE_REPLY_SEND_DRAFT_BUSY", "message reply draft already belongs to an unfinished send item");
    }
    throw error;
  }
}

function getMessageReplySendBatch(db, { profileId, batchId } = {}) {
  const row = db.prepare(`SELECT * FROM message_reply_send_batches
    WHERE id = ? AND profile_id = ?`).get(
    positiveInteger(batchId, "batchId"),
    positiveInteger(profileId, "profileId")
  );
  return row ? mapBatch(row) : null;
}

function listMessageReplySendItems(db, { profileId, batchId } = {}) {
  return db.prepare(`SELECT items.* FROM message_reply_send_items items
    JOIN message_reply_send_batches batches ON batches.id = items.batch_id
    WHERE items.batch_id = ? AND batches.profile_id = ?
    ORDER BY items.position, items.id`).all(
    positiveInteger(batchId, "batchId"),
    positiveInteger(profileId, "profileId")
  ).map(mapItem);
}

function transitionMessageReplySendBatch(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const batchId = positiveInteger(input.batchId, "batchId");
  const expectedStatus = batchStatus(input.expectedStatus);
  const status = batchStatus(input.status);
  const updatedAt = isoText(input.updatedAt || nowIso(), "updatedAt");
  const stopCode = errorCode(input.stopCode);
  const completedAt = TERMINAL_BATCH_STATUSES.has(status)
    ? isoText(input.completedAt || updatedAt, "completedAt")
    : null;
  const result = db.prepare(`UPDATE message_reply_send_batches
    SET status = ?, stop_code = ?, updated_at = ?, completed_at = ?
    WHERE id = ? AND profile_id = ? AND status = ?`)
    .run(status, stopCode, updatedAt, completedAt, batchId, profileId, expectedStatus);
  if (Number(result.changes) !== 1) {
    throw storageError("MESSAGE_REPLY_SEND_BATCH_CONFLICT", "message reply send batch changed concurrently");
  }
  return getMessageReplySendBatch(db, { profileId, batchId });
}

function transitionMessageReplySendItem(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const batchId = positiveInteger(input.batchId, "batchId");
  const itemId = positiveInteger(input.itemId, "itemId");
  const expectedStatus = itemStatus(input.expectedStatus);
  const status = itemStatus(input.status);
  const current = getOwnedItemRow(db, { profileId, batchId, itemId });
  if (!current || current.status !== expectedStatus) {
    throw storageError("MESSAGE_REPLY_SEND_ITEM_CONFLICT", "message reply send item changed concurrently");
  }
  const clickCount = input.clickCount === undefined
    ? Number(current.click_count)
    : Number(input.clickCount);
  if (![0, 1].includes(clickCount) || clickCount < Number(current.click_count)
    || (CLICKED_ITEM_STATUSES.has(status) && clickCount !== 1)) {
    throw storageError("MESSAGE_REPLY_SEND_CLICK_COUNT_INVALID", "message reply send click count is invalid");
  }
  const evidence = input.evidence === undefined
    ? current.evidence_json
    : JSON.stringify(normalizeEvidence(input.evidence));
  const updatedAt = isoText(input.updatedAt || nowIso(), "updatedAt");
  const result = db.prepare(`UPDATE message_reply_send_items
    SET status = ?, click_count = ?, evidence_json = ?, error_code = ?,
      error_message = ?, updated_at = ?
    WHERE id = ? AND batch_id = ? AND status = ?`)
    .run(
      status, clickCount, evidence, errorCode(input.errorCode),
      inlineText(input.errorMessage, 500), updatedAt,
      itemId, batchId, expectedStatus
    );
  if (Number(result.changes) !== 1) {
    throw storageError("MESSAGE_REPLY_SEND_ITEM_CONFLICT", "message reply send item changed concurrently");
  }
  return mapItem(getOwnedItemRow(db, { profileId, batchId, itemId }));
}

function stopPendingMessageReplySendItems(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const batchId = positiveInteger(input.batchId, "batchId");
  if (!getMessageReplySendBatch(db, { profileId, batchId })) {
    throw storageError("MESSAGE_REPLY_SEND_BATCH_NOT_FOUND", "message reply send batch was not found");
  }
  const updatedAt = isoText(input.updatedAt || nowIso(), "updatedAt");
  const code = errorCode(input.errorCode || "MESSAGE_REPLY_SEND_STOPPED");
  const message = inlineText(input.errorMessage || "reply send stopped", 500);
  const placeholders = ["pending", "selecting", "verified", "filled"].map(() => "?").join(",");
  return Number(db.prepare(`UPDATE message_reply_send_items
    SET status = 'stopped', error_code = ?, error_message = ?, updated_at = ?
    WHERE batch_id = ? AND status IN (${placeholders})`)
    .run(code, message, updatedAt, batchId, "pending", "selecting", "verified", "filled").changes);
}

function freezeDraft(db, profileId, item) {
  const blocking = db.prepare(`SELECT id FROM message_reply_send_items
    WHERE draft_id = ? AND status IN (${BLOCKING_ITEM_STATUSES.map(() => "?").join(",")}) LIMIT 1`)
    .get(item.draftId, ...BLOCKING_ITEM_STATUSES);
  if (blocking) {
    throw storageError("MESSAGE_REPLY_SEND_DRAFT_BUSY", "message reply draft already belongs to an unfinished send item");
  }
  const draft = db.prepare(`SELECT * FROM message_reply_drafts
    WHERE id = ? AND profile_id = ?`).get(item.draftId, profileId);
  if (!draft) throw storageError("MESSAGE_REPLY_SEND_DRAFT_NOT_FOUND", "message reply draft was not found");
  if (draft.closed_at) throw storageError("MESSAGE_REPLY_SEND_DRAFT_CLOSED", "message reply draft is closed");
  if (Number(draft.revision) !== item.revision) {
    throw storageError("MESSAGE_REPLY_SEND_REVISION_CONFLICT", "message reply draft revision changed");
  }
  const context = db.prepare(`SELECT * FROM message_inbound_contexts
    WHERE profile_id = ? AND card_id = ? AND message_group_key = ?`).get(
    profileId, draft.card_id, draft.message_group_key
  );
  if (!context) {
    throw storageError("MESSAGE_REPLY_SEND_CONTEXT_REQUIRED", "message inbound context is required");
  }
  const replyText = replyTextValue(draft.current_text);
  return {
    draftId: Number(draft.id),
    cardId: Number(draft.card_id),
    jobId: Number(draft.job_id),
    conversationKey: digestKey(context.conversation_key, "conversationKey"),
    sourceJobId: sourceJobKey(context.source_job_id),
    expectedLastMessageId: messageId(context.last_message_id),
    draftRevision: Number(draft.revision),
    replyText,
    replyDigest: digest(foldWhitespace(replyText))
  };
}

function normalizeBatchItems(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw storageError("MESSAGE_REPLY_SEND_ITEMS_INVALID", "message reply send items must contain 1 to 50 drafts");
  }
  const seen = new Set();
  return value.map((item) => {
    const draftId = positiveInteger(item?.draftId, "draftId");
    const revision = nonnegativeInteger(item?.revision, "revision");
    if (seen.has(draftId)) {
      throw storageError("MESSAGE_REPLY_SEND_DRAFT_DUPLICATE", "message reply draft is duplicated in the batch");
    }
    seen.add(draftId);
    return { draftId, revision };
  });
}

function normalizeInboundMessages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw storageError("MESSAGE_INBOUND_CONTEXT_INVALID", "inbound messages must contain 1 to 5 display entries");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw storageError("MESSAGE_INBOUND_CONTEXT_INVALID", "inbound display entry is invalid");
    }
    const kind = String(item.kind || "");
    const text = exactText(item.text);
    if (kind === "text" && text) return { kind, text };
    if (kind === "resume_request" && text === "HR 邀请你发送简历") return { kind, text };
    throw storageError("MESSAGE_INBOUND_CONTEXT_INVALID", "inbound display entry is invalid");
  });
}

function normalizeManualActions(value) {
  const actions = Array.isArray(value) ? value : [];
  if (actions.some((item) => item?.kind !== "resume_request")) {
    throw storageError("MESSAGE_INBOUND_CONTEXT_INVALID", "manual action is invalid");
  }
  return actions.length ? [{ kind: "resume_request" }] : [];
}

function normalizeEvidence(value, depth = 0) {
  if (depth > 3) throw storageError("MESSAGE_REPLY_SEND_EVIDENCE_INVALID", "reply send evidence is too deep");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => normalizeEvidence(item, depth + 1));
  if (!value || typeof value !== "object") {
    throw storageError("MESSAGE_REPLY_SEND_EVIDENCE_INVALID", "reply send evidence is invalid");
  }
  const entries = Object.entries(value);
  if (entries.length > 40 || entries.some(([key]) => !/^[A-Za-z0-9_.-]{1,80}$/.test(key))) {
    throw storageError("MESSAGE_REPLY_SEND_EVIDENCE_INVALID", "reply send evidence is invalid");
  }
  const normalized = Object.fromEntries(entries.map(([key, item]) => [key, normalizeEvidence(item, depth + 1)]));
  if (JSON.stringify(normalized).length > 8000) {
    throw storageError("MESSAGE_REPLY_SEND_EVIDENCE_INVALID", "reply send evidence is too large");
  }
  return normalized;
}

function getOwnedItemRow(db, { profileId, batchId, itemId }) {
  return db.prepare(`SELECT items.* FROM message_reply_send_items items
    JOIN message_reply_send_batches batches ON batches.id = items.batch_id
    WHERE items.id = ? AND items.batch_id = ? AND batches.profile_id = ?`)
    .get(itemId, batchId, profileId);
}

function assertCardOwner(db, profileId, cardId) {
  if (!db.prepare("SELECT id FROM candidate_progress_cards WHERE id = ? AND profile_id = ?").get(cardId, profileId)) {
    throw storageError("MESSAGE_INBOUND_CONTEXT_OWNER_INVALID", "message inbound context owner is invalid");
  }
}

function mapInboundContext(row) {
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    cardId: Number(row.card_id),
    messageGroupKey: row.message_group_key,
    conversationKey: row.conversation_key,
    sourceJobId: row.source_job_id,
    lastMessageId: row.last_message_id,
    messageIntent: row.message_intent,
    messageCategory: row.message_category,
    inboundMessages: normalizeStoredInboundMessages(row.display_json),
    manualActions: normalizeStoredManualActions(row.manual_actions_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapBatch(row) {
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    status: row.status,
    stopCode: row.stop_code || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || ""
  };
}

function mapItem(row) {
  return {
    id: Number(row.id),
    batchId: Number(row.batch_id),
    position: Number(row.position),
    draftId: Number(row.draft_id),
    cardId: Number(row.card_id),
    jobId: Number(row.job_id),
    conversationKey: row.conversation_key,
    sourceJobId: row.source_job_id,
    expectedLastMessageId: row.expected_last_message_id,
    draftRevision: Number(row.draft_revision),
    replyText: row.reply_text,
    replyDigest: row.reply_digest,
    status: row.status,
    clickCount: Number(row.click_count),
    evidence: parseJson(row.evidence_json, {}),
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeStoredInboundMessages(value) {
  try { return normalizeInboundMessages(parseJson(value, [])); } catch { return []; }
}

function normalizeStoredManualActions(value) {
  try { return normalizeManualActions(parseJson(value, [])); } catch { return []; }
}

function exactText(value) {
  const text = String(value == null ? "" : value).replace(/\r\n?/g, "\n").trim();
  if (!text || text.length > MAX_TEXT) {
    throw storageError("MESSAGE_INBOUND_CONTEXT_INVALID", "inbound display text is invalid");
  }
  return text;
}

function replyTextValue(value) {
  const text = String(value == null ? "" : value).replace(/\r\n?/g, "\n").trim();
  if (!text || text.length > MAX_TEXT) {
    throw storageError("MESSAGE_REPLY_SEND_TEXT_INVALID", "message reply text is invalid");
  }
  return text;
}

function foldWhitespace(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function digest(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function digestKey(value, label) {
  const text = String(value || "").trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(text)) {
    throw storageError("MESSAGE_INBOUND_CONTEXT_INVALID", `${label} must be a sha256 digest`);
  }
  return text;
}

function sourceJobKey(value) {
  const text = String(value || "").trim();
  if (!/^boss:[A-Za-z0-9_-]{6,160}$/.test(text)) {
    throw storageError("MESSAGE_INBOUND_CONTEXT_INVALID", "sourceJobId is invalid");
  }
  return text;
}

function messageId(value) {
  const text = String(value || "");
  if (!/^\d{15}$/.test(text)) {
    throw storageError("MESSAGE_INBOUND_CONTEXT_INVALID", "lastMessageId is invalid");
  }
  return text;
}

function batchStatus(value) {
  const status = String(value || "");
  if (!BATCH_STATUSES.has(status)) throw storageError("MESSAGE_REPLY_SEND_STATUS_INVALID", "batch status is invalid");
  return status;
}

function itemStatus(value) {
  const status = String(value || "");
  if (!ITEM_STATUSES.has(status)) throw storageError("MESSAGE_REPLY_SEND_STATUS_INVALID", "item status is invalid");
  return status;
}

function errorCode(value) {
  const code = String(value || "").trim();
  if (code && !/^[A-Z][A-Z0-9_]{2,80}$/.test(code)) {
    throw storageError("MESSAGE_REPLY_SEND_ERROR_INVALID", "reply send error code is invalid");
  }
  return code;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

function nonnegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${label} must be a nonnegative integer`);
  return number;
}

function boundedLimit(value, fallback, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function inlineText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function isoText(value, label) {
  const text = String(value || "");
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${label} must be an ISO timestamp`);
  return new Date(text).toISOString();
}

module.exports = {
  saveMessageInboundContext,
  getMessageInboundContext,
  listMessageInboundContexts,
  deleteMessageInboundContext,
  createMessageReplySendBatch,
  getMessageReplySendBatch,
  listMessageReplySendItems,
  transitionMessageReplySendBatch,
  transitionMessageReplySendItem,
  stopPendingMessageReplySendItems
};
