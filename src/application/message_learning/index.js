const {
  getMessageReplyDraft,
  saveMessageReplyDraftEdit,
  completeMessageReplyDraft,
  listCandidateAnswerMemories,
  reviseCandidateAnswerMemory,
  withdrawCandidateAnswerMemory,
  listCandidateFactRevisions,
  saveCandidateFact,
  listCandidateFacts,
  deleteCandidateFact
} = require("../../core/storage");
const {
  replyDraftDigest,
  replyDraftWasEdited,
  deriveUserChangedText,
  validateReplyEditFactExtraction
} = require("../../core/message_reply_learning");

function createMessageReplyLearningService({
  db,
  adapter = null,
  logger = null,
  now = () => new Date().toISOString()
} = {}) {
  if (!db) throw new Error("message reply learning service requires db");

  return {
    saveDraft,
    completeDraft,
    listCommunicationProfile,
    reviseMemory,
    withdrawMemory,
    saveFact,
    deleteFact
  };

  function saveDraft({ profileId, draftId, text }) {
    return saveMessageReplyDraftEdit(db, {
      profileId,
      draftId,
      text,
      updatedAt: nowIso(now())
    });
  }

  async function completeDraft({ profileId, draftId, finalText, completionKind, afterComplete }) {
    const draft = requiredDraft(profileId, draftId);
    const existing = listCandidateAnswerMemories(db, {
      profileId,
      activeOnly: false,
      limit: 500
    }).find((memory) => memory.draftId === draft.id && (
      memory.finalDigest === replyDraftDigest(finalText)
      || !replyDraftWasEdited(memory.finalText, finalText)
    ));
    if (existing) {
      const memory = completeMessageReplyDraft(db, {
        profileId,
        draftId,
        finalText,
        completionKind,
        afterComplete,
        completedAt: nowIso(now())
      });
      return completionResult(memory, requiredDraft(profileId, draftId), 0, "not_needed");
    }
    if (draft.closedAt) {
      throw serviceError("MESSAGE_REPLY_DRAFT_CLOSED", "message reply draft is already closed");
    }
    const changed = replyDraftWasEdited(draft.originalText, finalText);
    const changedText = changed ? deriveUserChangedText(draft.originalText, finalText) : "";
    const extraction = changed
      ? await extractFacts({ draft, finalText, changedText })
      : { scope: { kind: "global", key: "" }, facts: [], status: "not_needed" };
    const memory = completeMessageReplyDraft(db, {
      profileId,
      draftId,
      finalText,
      changedText,
      completionKind,
      afterComplete,
      scope: extraction.scope,
      extractedFacts: extraction.facts,
      completedAt: nowIso(now())
    });
    return completionResult(
      memory,
      requiredDraft(profileId, draftId),
      extraction.facts.length,
      extraction.status
    );
  }

  function listCommunicationProfile({ profileId }) {
    return {
      facts: listCandidateFacts(db, profileId),
      answers: listCandidateAnswerMemories(db, {
        profileId,
        activeOnly: true,
        source: "user_edited_reply",
        limit: 100
      }),
      revisions: listCandidateFactRevisions(db, { profileId, limit: 500 })
    };
  }

  async function reviseMemory({ profileId, memoryId, finalText }) {
    const current = listCandidateAnswerMemories(db, { profileId, activeOnly: false, limit: 500 })
      .find((memory) => memory.id === Number(memoryId));
    if (!current) throw serviceError("CANDIDATE_ANSWER_MEMORY_NOT_FOUND", "candidate answer memory was not found");
    const draft = requiredDraft(profileId, current.draftId);
    const changedText = deriveUserChangedText(current.finalText, finalText) || String(finalText || "").trim();
    const extraction = await extractFacts({ draft, finalText, changedText });
    const memory = reviseCandidateAnswerMemory(db, {
      profileId,
      memoryId,
      finalText,
      changedText,
      scope: extraction.scope,
      extractedFacts: extraction.facts,
      completedAt: nowIso(now())
    });
    return completionResult(memory, requiredDraft(profileId, current.draftId), extraction.facts.length, extraction.status);
  }

  function withdrawMemory({ profileId, memoryId }) {
    const memories = listCandidateAnswerMemories(db, { profileId, activeOnly: false, limit: 500 });
    const selected = memories.find((memory) => memory.id === Number(memoryId));
    if (!selected) throw serviceError("CANDIDATE_ANSWER_MEMORY_NOT_FOUND", "candidate answer memory was not found");
    const withdrawnAt = nowIso(now());
    let result = selected;
    for (const memory of memories.filter((item) => item.draftId === selected.draftId && !item.withdrawnAt)) {
      result = withdrawCandidateAnswerMemory(db, {
        profileId,
        memoryId: memory.id,
        withdrawnAt
      });
    }
    return result;
  }

  function saveFact({ profileId, factKey, factValue }) {
    return saveCandidateFact(db, { profileId, factKey, factValue, source: "user_provided" });
  }

  function deleteFact({ profileId, factKey }) {
    return deleteCandidateFact(db, {
      profileId,
      factKey,
      source: "user_provided",
      occurredAt: nowIso(now())
    });
  }

  async function extractFacts({ draft, finalText, changedText }) {
    if (!adapter || typeof adapter.extractReplyEditFacts !== "function") {
      return { scope: defaultScope(draft), facts: [], status: "unavailable" };
    }
    try {
      const value = await adapter.extractReplyEditFacts({
        originalText: draft.originalText,
        finalText: String(finalText || "").trim().slice(0, 4000),
        changedText,
        questionSummary: draft.questionSummary,
        messageIntent: draft.messageIntent,
        messageCategory: draft.messageCategory,
        scope: defaultScope(draft)
      });
      const validated = validateReplyEditFactExtraction(value, { changedText, scope: defaultScope(draft) });
      return { ...validated, status: "succeeded" };
    } catch (error) {
      logger?.warn?.("message_reply_fact_extraction_failed", {
        code: String(error?.code || "MESSAGE_REPLY_FACT_EXTRACTION_FAILED")
      });
      return {
        scope: defaultScope(draft),
        facts: [],
        status: error?.code === "MESSAGE_REPLY_FACT_EXTRACTION_UNAVAILABLE" ? "unavailable" : "failed"
      };
    }
  }

  function requiredDraft(profileId, draftId) {
    const draft = getMessageReplyDraft(db, { profileId, draftId });
    if (!draft) throw serviceError("MESSAGE_REPLY_DRAFT_NOT_FOUND", "message reply draft was not found");
    return draft;
  }
}

function completionResult(memory, draft, learnedFactCount, extractionStatus) {
  return {
    memoryId: memory.id,
    draftId: draft.id,
    revision: draft.revision,
    changed: memory.changed === true || memory.source === "user_edited_reply",
    learnedFactCount,
    extractionStatus
  };
}

function defaultScope(draft) {
  return { kind: draft?.jobId ? "job" : "global", key: draft?.jobId ? String(draft.jobId) : "" };
}

function nowIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("now must return a valid timestamp");
  return date.toISOString();
}

function serviceError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  createMessageReplyLearningService
};
