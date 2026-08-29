const {
  getMessageReplySendBatch,
  listMessageReplySendItems,
  transitionMessageReplySendBatch,
  transitionMessageReplySendItem
} = require("./storage");

const BATCH_EDGES = new Map([
  ["confirmed", new Set(["running", "stopped", "interrupted"])],
  ["running", new Set(["completed", "stopped", "interrupted"])],
  ["completed", new Set()],
  ["stopped", new Set()],
  ["interrupted", new Set()]
]);

const ITEM_EDGES = new Map([
  ["pending", new Set(["selecting", "target_mismatch", "stopped"])],
  ["selecting", new Set(["verified", "target_mismatch", "stopped"])],
  ["verified", new Set(["filled", "target_mismatch", "stopped"])],
  ["filled", new Set(["click_dispatched", "target_mismatch", "stopped"])],
  ["click_dispatched", new Set(["succeeded", "platform_rejected", "ambiguous"])],
  ["succeeded", new Set()],
  ["target_mismatch", new Set()],
  ["platform_rejected", new Set()],
  ["ambiguous", new Set()],
  ["stopped", new Set()]
]);

function loadReplySendBatch(db, { profileId, batchId } = {}) {
  const batch = getMessageReplySendBatch(db, { profileId, batchId });
  if (!batch) throw replySendError("MESSAGE_REPLY_SEND_BATCH_NOT_FOUND", "message reply send batch was not found");
  return {
    batch,
    items: listMessageReplySendItems(db, { profileId, batchId })
  };
}

function transitionReplySendBatch(db, input = {}) {
  assertEdge(BATCH_EDGES, input.expectedStatus, input.status);
  return transitionMessageReplySendBatch(db, input);
}

function transitionReplySendItem(db, input = {}) {
  assertEdge(ITEM_EDGES, input.expectedStatus, input.status);
  return transitionMessageReplySendItem(db, input);
}

function publicReplySendBatch(value = {}) {
  const batch = value.batch || {};
  return {
    batch: {
      id: Number(batch.id || 0),
      profileId: Number(batch.profileId || 0),
      status: String(batch.status || ""),
      stopCode: String(batch.stopCode || ""),
      createdAt: String(batch.createdAt || ""),
      updatedAt: String(batch.updatedAt || ""),
      completedAt: String(batch.completedAt || "")
    },
    items: (Array.isArray(value.items) ? value.items : []).map((item) => ({
      id: Number(item.id || 0),
      batchId: Number(item.batchId || 0),
      position: Number(item.position || 0),
      draftId: Number(item.draftId || 0),
      cardId: Number(item.cardId || 0),
      jobId: Number(item.jobId || 0),
      draftRevision: Number(item.draftRevision || 0),
      status: String(item.status || ""),
      clickCount: Number(item.clickCount || 0),
      evidence: sanitizePublicEvidence(item.evidence),
      errorCode: String(item.errorCode || ""),
      errorMessage: String(item.errorMessage || ""),
      createdAt: String(item.createdAt || ""),
      updatedAt: String(item.updatedAt || "")
    }))
  };
}

function assertEdge(edges, fromValue, toValue) {
  const from = String(fromValue || "");
  const to = String(toValue || "");
  if (!edges.get(from)?.has(to)) {
    throw replySendError("MESSAGE_REPLY_SEND_TRANSITION_INVALID", `cannot transition reply send state from ${from} to ${to}`);
  }
}

function sanitizePublicEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) continue;
    if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) result[key] = item;
    else if (typeof item === "string") result[key] = item.replace(/\s+/g, " ").trim().slice(0, 200);
  }
  return result;
}

function replySendError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  BATCH_EDGES,
  ITEM_EDGES,
  loadReplySendBatch,
  transitionReplySendBatch,
  transitionReplySendItem,
  publicReplySendBatch
};
