const {
  createMessageReplySendBatch,
  stopPendingMessageReplySendItems,
  getMessageReplyDraft,
  getMessageInboundContext
} = require("../../core/storage");
const {
  loadReplySendBatch,
  transitionReplySendBatch,
  transitionReplySendItem,
  publicReplySendBatch
} = require("../../core/message_reply_send_batches");
const { recordReplyConfirmedSent, recordFollowUpSent } = require("../../core/candidate_progress");
const { replyDraftWasEdited } = require("../../core/message_reply_learning");
const { assessMessageDraftQuality } = require("../../core/message_draft_quality");
const { buildMessageDraftQualityContext } = require("../message_draft_quality");

const TERMINAL_BATCH_STATUSES = new Set(["completed", "stopped", "interrupted"]);

function createMessageReplySendingService({
  db,
  learningService,
  now = () => new Date().toISOString(),
  executeBatch = () => {},
  onExecutionError = () => {}
} = {}) {
  if (!db) throw new Error("message reply sending service requires db");
  if (!learningService || typeof learningService.completeDraft !== "function") {
    throw new Error("message reply sending service requires learningService.completeDraft");
  }
  if (typeof executeBatch !== "function") throw new TypeError("executeBatch must be a function");

  return {
    confirmBatch,
    status,
    stop,
    completeVerifiedItem
  };

  function confirmBatch(input = {}) {
    const profileId = positiveInteger(input.profileId, "profileId");
    const items = confirmItems(input.items);
    assertCurrentModelDraftFacts(profileId, items);
    const snapshot = createMessageReplySendBatch(db, {
      profileId,
      items,
      createdAt: nowIso(now())
    });
    Promise.resolve()
      .then(() => executeBatch(snapshot.batch.id))
      .catch((error) => {
        try { onExecutionError(error, snapshot.batch.id); } catch {}
      });
    return snapshot;
  }

  function assertCurrentModelDraftFacts(profileId, items) {
    for (const item of items) {
      const draft = getMessageReplyDraft(db, { profileId, draftId: item.draftId });
      if (!draft || draft.closedAt || draft.revision !== item.revision
        || replyDraftWasEdited(draft.originalText, draft.currentText)) continue;
      const job = db.prepare("SELECT id, source_id, company FROM jobs WHERE id = ?").get(draft.jobId) || {};
      const context = getMessageInboundContext(db, {
        profileId,
        cardId: draft.cardId,
        messageGroupKey: draft.messageGroupKey
      });
      const { evidenceTexts } = buildMessageDraftQualityContext(db, {
        profileId,
        job: { id: Number(job.id || draft.jobId), sourceId: job.source_id || "", company: job.company || "" },
        messageTexts: (context?.inboundMessages || [])
          .filter((message) => message?.kind === "text")
          .map((message) => String(message.text || ""))
      });
      const assessment = assessMessageDraftQuality({
        text: draft.currentText,
        recentTexts: [],
        evidenceTexts
      });
      if (assessment.errors.some((error) => error.code === "MESSAGE_DRAFT_FACT_UNSUPPORTED")) {
        throw sendingError(
          "MESSAGE_DRAFT_FACT_UNSUPPORTED",
          "草稿里有系统找不到依据的个人信息，请修改后再发送。"
        );
      }
    }
  }

  function status({ profileId, batchId } = {}) {
    return publicReplySendBatch(loadReplySendBatch(db, {
      profileId: positiveInteger(profileId, "profileId"),
      batchId: positiveInteger(batchId, "batchId")
    }));
  }

  function stop({ profileId, batchId } = {}) {
    const profile = positiveInteger(profileId, "profileId");
    const batch = positiveInteger(batchId, "batchId");
    let snapshot = loadReplySendBatch(db, { profileId: profile, batchId: batch });
    if (TERMINAL_BATCH_STATUSES.has(snapshot.batch.status)) return publicReplySendBatch(snapshot);
    const stoppedAt = nowIso(now());
    stopPendingMessageReplySendItems(db, {
      profileId: profile,
      batchId: batch,
      errorCode: "MESSAGE_REPLY_SEND_STOPPED",
      errorMessage: "user stopped later reply sends",
      updatedAt: stoppedAt
    });
    snapshot = loadReplySendBatch(db, { profileId: profile, batchId: batch });
    const hasDispatched = snapshot.items.some((item) => [
      "click_dispatched", "platform_rejected", "ambiguous"
    ].includes(item.status));
    transitionReplySendBatch(db, {
      profileId: profile,
      batchId: batch,
      expectedStatus: snapshot.batch.status,
      status: hasDispatched ? "interrupted" : "stopped",
      stopCode: "MESSAGE_REPLY_SEND_STOPPED",
      completedAt: stoppedAt,
      updatedAt: stoppedAt
    });
    return publicReplySendBatch(loadReplySendBatch(db, { profileId: profile, batchId: batch }));
  }

  async function completeVerifiedItem({ batchId, itemId } = {}) {
    const batch = positiveInteger(batchId, "batchId");
    const item = positiveInteger(itemId, "itemId");
    const owner = db.prepare("SELECT profile_id FROM message_reply_send_batches WHERE id = ?").get(batch);
    if (!owner) throw sendingError("MESSAGE_REPLY_SEND_BATCH_NOT_FOUND", "message reply send batch was not found");
    const profileId = Number(owner.profile_id);
    let snapshot = loadReplySendBatch(db, { profileId, batchId: batch });
    let current = snapshot.items.find((entry) => entry.id === item);
    if (!current) throw sendingError("MESSAGE_REPLY_SEND_ITEM_NOT_FOUND", "message reply send item was not found");
    if (current.status === "succeeded") {
      return {
        item: publicReplySendBatch({ batch: snapshot.batch, items: [current] }).items[0],
        learning: { draftId: current.draftId, alreadyCompleted: true }
      };
    }
    if (current.status !== "click_dispatched" || current.clickCount !== 1) {
      throw sendingError("MESSAGE_REPLY_SEND_ITEM_NOT_VERIFIED", "message reply send item is not awaiting verified completion");
    }
    const draft = getMessageReplyDraft(db, { profileId, draftId: current.draftId });
    if (!draft) throw sendingError("MESSAGE_REPLY_SEND_DRAFT_NOT_FOUND", "message reply draft was not found");
    const completedAt = nowIso(now());
    const learning = await learningService.completeDraft({
      profileId,
      draftId: current.draftId,
      finalText: current.replyText,
      completionKind: "sent",
      afterComplete() {
        transitionReplySendItem(db, {
          profileId,
          batchId: batch,
          itemId: item,
          expectedStatus: "click_dispatched",
          status: "succeeded",
          clickCount: 1,
          updatedAt: completedAt
        });
        const recordSent = draft.messageIntent === "follow_up" ? recordFollowUpSent : recordReplyConfirmedSent;
        recordSent(db, {
          cardId: current.cardId,
          idempotencyKey: `message-reply-send:${batch}:${item}`,
          summary: draft.messageIntent === "follow_up" ? "已发送首次跟进" : "用户确认已手动发送",
          occurredAt: completedAt
        });
      }
    });
    snapshot = loadReplySendBatch(db, { profileId, batchId: batch });
    current = snapshot.items.find((entry) => entry.id === item);
    return {
      item: publicReplySendBatch({ batch: snapshot.batch, items: [current] }).items[0],
      learning
    };
  }
}

function confirmItems(value) {
  if (!Array.isArray(value)) {
    throw sendingError("MESSAGE_REPLY_SEND_ITEMS_INVALID", "message reply send items must be an array");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw sendingError("MESSAGE_REPLY_SEND_INPUT_INVALID", "message reply send item is invalid");
    }
    const keys = Object.keys(item);
    if (keys.some((key) => !["draftId", "revision"].includes(key))) {
      throw sendingError("MESSAGE_REPLY_SEND_INPUT_INVALID", "message reply confirmation accepts only draftId and revision");
    }
    return {
      draftId: positiveInteger(item.draftId, "draftId"),
      revision: nonnegativeInteger(item.revision, "revision")
    };
  });
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

function nowIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("now must return a valid timestamp");
  return date.toISOString();
}

function sendingError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  createMessageReplySendingService
};
