const { createHash } = require("node:crypto");
const { immediateTransaction, nowIso, parseJson, storageError } = require("./storage_shared");

const MAX_DRAFT_TEXT = 4000;
const MAX_FACT_VALUE = 2000;
const VALID_COMPLETION_KINDS = new Set(["copied", "sent", "profile_edit"]);
const VALID_SCOPE_KINDS = new Set(["global", "job", "company", "experience"]);

function recordMessageReplyDrafts(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const cardId = positiveInteger(input.cardId, "cardId");
  const jobId = positiveInteger(input.jobId, "jobId");
  const groupKey = digestKey(input.messageGroupKey, "messageGroupKey");
  const questionSummary = inlineText(input.questionSummary, 160);
  const messageIntent = inlineText(input.messageIntent, 80);
  const messageCategory = inlineText(input.messageCategory, 80);
  const createdAt = isoText(input.createdAt || nowIso(), "createdAt");
  const messages = Array.isArray(input.messages)
    ? input.messages.slice(0, 2).map((message) => draftText(message)).filter(Boolean)
    : [];
  assertDraftOwner(db, { profileId, cardId, jobId });
  if (!messages.length) return [];
  return immediateTransaction(db, () => {
    const insert = db.prepare(`INSERT INTO message_reply_drafts(
      profile_id, card_id, job_id, message_group_key, draft_index,
      question_summary, message_intent, message_category,
      original_text, current_text, revision, closed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
    ON CONFLICT(profile_id, message_group_key, draft_index) DO NOTHING`);
    for (const [index, message] of messages.entries()) {
      insert.run(
        profileId, cardId, jobId, groupKey, index,
        questionSummary, messageIntent, messageCategory,
        message, message, createdAt, createdAt
      );
    }
    return db.prepare(`SELECT * FROM message_reply_drafts
      WHERE profile_id = ? AND message_group_key = ?
      ORDER BY draft_index`).all(profileId, groupKey).map(mapDraft);
  });
}

function getMessageReplyDraft(db, { profileId, draftId } = {}) {
  const row = db.prepare(`SELECT * FROM message_reply_drafts
    WHERE id = ? AND profile_id = ?`).get(
    positiveInteger(draftId, "draftId"),
    positiveInteger(profileId, "profileId")
  );
  return row ? mapDraft(row) : null;
}

function listOpenMessageReplyDrafts(db, { profileId, cardId = null, limit = 100 } = {}) {
  const profile = positiveInteger(profileId, "profileId");
  const card = optionalPositiveInteger(cardId, "cardId");
  const bounded = boundedLimit(limit, 100, 500);
  const rows = card
    ? db.prepare(`SELECT * FROM message_reply_drafts
        WHERE profile_id = ? AND card_id = ? AND closed_at IS NULL
        ORDER BY updated_at DESC, id DESC LIMIT ?`).all(profile, card, bounded)
    : db.prepare(`SELECT * FROM message_reply_drafts
        WHERE profile_id = ? AND closed_at IS NULL
        ORDER BY updated_at DESC, id DESC LIMIT ?`).all(profile, bounded);
  return rows.map(mapDraft);
}

function saveMessageReplyDraftEdit(db, {
  profileId,
  draftId,
  text,
  updatedAt = nowIso()
} = {}) {
  const profile = positiveInteger(profileId, "profileId");
  const draft = requireDraft(db, profile, draftId);
  const currentText = draftText(text, { allowEmpty: true });
  const occurredAt = isoText(updatedAt, "updatedAt");
  if (draft.closedAt) return draft;
  if (draft.currentText === currentText) return draft;
  db.prepare(`UPDATE message_reply_drafts
    SET current_text = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND profile_id = ?`).run(currentText, occurredAt, draft.id, profile);
  return requireDraft(db, profile, draft.id);
}

function completeMessageReplyDraft(db, input = {}) {
  return completeDraft(db, input, { forceEdited: false });
}

function reviseCandidateAnswerMemory(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const memoryId = positiveInteger(input.memoryId, "memoryId");
  const current = db.prepare(`SELECT * FROM candidate_answer_memories
    WHERE id = ? AND profile_id = ?`).get(memoryId, profileId);
  if (!current) throw storageError("CANDIDATE_ANSWER_MEMORY_NOT_FOUND", "candidate answer memory was not found");
  return completeDraft(db, {
    ...input,
    profileId,
    draftId: current.draft_id,
    completionKind: "profile_edit",
    supersedesMemoryId: current.id,
    questionSummary: current.question_summary,
    messageIntent: current.message_intent,
    messageCategory: current.message_category,
    scope: parseJson(current.scope_json, { kind: "global", key: "" })
  }, { forceEdited: true });
}

function completeDraft(db, input, { forceEdited }) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const draft = requireDraft(db, profileId, input.draftId);
  const finalText = draftText(input.finalText);
  const completionKind = String(input.completionKind || "").trim();
  if (!VALID_COMPLETION_KINDS.has(completionKind)) {
    throw storageError("MESSAGE_REPLY_COMPLETION_KIND_INVALID", "completionKind is invalid");
  }
  const completedAt = isoText(input.completedAt || nowIso(), "completedAt");
  const finalDigest = sha256(normalizeDigestText(finalText));
  const changed = forceEdited || comparableText(draft.originalText) !== comparableText(finalText);
  const source = changed ? "user_edited_reply" : "draft_adopted";
  const changedText = changed ? draftText(input.changedText || finalText) : "";
  const scope = normalizeScope(input.scope);
  const extractedFacts = changed ? normalizedExtractedFacts(input.extractedFacts) : [];
  return immediateTransaction(db, () => {
    const existing = db.prepare(`SELECT * FROM candidate_answer_memories
      WHERE draft_id = ? AND final_digest = ?`).get(draft.id, finalDigest)
      || db.prepare(`SELECT * FROM candidate_answer_memories
        WHERE draft_id = ? ORDER BY updated_at DESC, id DESC`).all(draft.id)
        .find((memory) => comparableText(memory.final_text) === comparableText(finalText));
    if (existing) {
      const active = db.prepare(`SELECT id FROM candidate_answer_memories
        WHERE profile_id = ? AND draft_id = ? AND withdrawn_at IS NULL
        ORDER BY updated_at DESC, id DESC LIMIT 1`).get(profileId, draft.id);
      const affectedKeys = new Set(db.prepare(`SELECT DISTINCT fact_key FROM candidate_fact_revisions
        WHERE answer_memory_id IN (?, ?)`).all(existing.id, active?.id || existing.id).map((row) => row.fact_key));
      const strongerKind = completionKind === "sent" || existing.completion_kind === "sent" ? "sent" : existing.completion_kind;
      db.prepare(`UPDATE candidate_answer_memories
        SET final_digest = ?, completion_kind = ?, withdrawn_at = NULL, updated_at = ? WHERE id = ?`)
        .run(finalDigest, strongerKind, completedAt, existing.id);
      for (const factKey of affectedKeys) projectCandidateFact(db, profileId, factKey, completedAt);
      updateDraftOnCompletion(db, draft, finalText, completionKind, completedAt);
      const result = { ...mapMemory(db.prepare("SELECT * FROM candidate_answer_memories WHERE id = ?").get(existing.id)), changed };
      input.afterComplete?.(result);
      return result;
    }
    if (draft.closedAt && completionKind !== "profile_edit") {
      throw storageError("MESSAGE_REPLY_DRAFT_CLOSED", "message reply draft is already closed");
    }
    const previous = input.supersedesMemoryId
      ? db.prepare(`SELECT * FROM candidate_answer_memories
          WHERE id = ? AND profile_id = ? AND draft_id = ?`).get(
        positiveInteger(input.supersedesMemoryId, "supersedesMemoryId"), profileId, draft.id
      )
      : db.prepare(`SELECT * FROM candidate_answer_memories
          WHERE profile_id = ? AND draft_id = ? AND withdrawn_at IS NULL
          ORDER BY updated_at DESC, id DESC LIMIT 1`).get(profileId, draft.id);
    const questionSummary = inlineText(input.questionSummary || draft.questionSummary, 160);
    const messageIntent = inlineText(input.messageIntent || draft.messageIntent, 80);
    const messageCategory = inlineText(input.messageCategory || draft.messageCategory, 80);
    const memoryId = Number(db.prepare(`INSERT INTO candidate_answer_memories(
      profile_id, draft_id, final_digest, question_summary, message_intent, message_category,
      original_text, final_text, changed_text, scope_json, source, completion_kind,
      supersedes_memory_id, withdrawn_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(
        profileId, draft.id, finalDigest, questionSummary, messageIntent, messageCategory,
        draft.originalText, finalText, changedText, JSON.stringify(scope), source, completionKind,
        previous?.id || null, completedAt, completedAt
      ).lastInsertRowid);
    const affectedKeys = new Set();
    for (const fact of extractedFacts) {
      affectedKeys.add(fact.factKey);
      db.prepare(`INSERT INTO candidate_fact_revisions(
        profile_id, fact_key, fact_value, operation, source,
        answer_memory_id, evidence_text, withdrawn_at, created_at
      ) VALUES (?, ?, ?, 'set', 'user_edited_reply', ?, ?, NULL, ?)`)
        .run(profileId, fact.factKey, fact.factValue, memoryId, fact.evidenceText, completedAt);
    }
    for (const factKey of affectedKeys) projectCandidateFact(db, profileId, factKey, completedAt);
    updateDraftOnCompletion(db, draft, finalText, completionKind, completedAt);
    const result = { ...mapMemory(db.prepare("SELECT * FROM candidate_answer_memories WHERE id = ?").get(memoryId)), changed };
    input.afterComplete?.(result);
    return result;
  });
}

function listCandidateAnswerMemories(db, {
  profileId,
  activeOnly = true,
  source = "",
  limit = 100
} = {}) {
  const profile = positiveInteger(profileId, "profileId");
  const sourceText = String(source || "").trim();
  const conditions = ["m.profile_id = ?"];
  const args = [profile];
  if (activeOnly) {
    conditions.push("m.withdrawn_at IS NULL");
    conditions.push(`m.id = (SELECT m2.id FROM candidate_answer_memories m2
      WHERE m2.profile_id = m.profile_id AND m2.draft_id = m.draft_id AND m2.withdrawn_at IS NULL
      ORDER BY m2.updated_at DESC, m2.id DESC LIMIT 1)`);
  }
  if (sourceText) {
    conditions.push("m.source = ?");
    args.push(sourceText);
  }
  args.push(boundedLimit(limit, 100, 500));
  return db.prepare(`SELECT m.* FROM candidate_answer_memories m
    WHERE ${conditions.join(" AND ")}
    ORDER BY m.updated_at DESC, m.id DESC LIMIT ?`).all(...args).map(mapMemory);
}

function withdrawCandidateAnswerMemory(db, {
  profileId,
  memoryId,
  withdrawnAt = nowIso()
} = {}) {
  const profile = positiveInteger(profileId, "profileId");
  const id = positiveInteger(memoryId, "memoryId");
  const occurredAt = isoText(withdrawnAt, "withdrawnAt");
  return immediateTransaction(db, () => {
    const row = db.prepare(`SELECT * FROM candidate_answer_memories
      WHERE id = ? AND profile_id = ?`).get(id, profile);
    if (!row) throw storageError("CANDIDATE_ANSWER_MEMORY_NOT_FOUND", "candidate answer memory was not found");
    if (row.withdrawn_at) return mapMemory(row);
    db.prepare(`UPDATE candidate_answer_memories
      SET withdrawn_at = ?, updated_at = ? WHERE id = ?`).run(occurredAt, occurredAt, id);
    const keys = db.prepare("SELECT DISTINCT fact_key FROM candidate_fact_revisions WHERE answer_memory_id = ?")
      .all(id).map((item) => item.fact_key);
    for (const key of keys) projectCandidateFact(db, profile, key, occurredAt);
    return mapMemory(db.prepare("SELECT * FROM candidate_answer_memories WHERE id = ?").get(id));
  });
}

function listCandidateFactRevisions(db, { profileId, factKey = "", limit = 500 } = {}) {
  const profile = positiveInteger(profileId, "profileId");
  const key = factKey ? normalizeFactKey(factKey) : "";
  const rows = key
    ? db.prepare(`SELECT * FROM candidate_fact_revisions
        WHERE profile_id = ? AND fact_key = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`).all(profile, key, boundedLimit(limit, 500, 2000))
    : db.prepare(`SELECT * FROM candidate_fact_revisions
        WHERE profile_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`).all(profile, boundedLimit(limit, 500, 2000));
  return rows.map(mapFactRevision);
}

function recordCandidateFactValue(db, {
  profileId,
  factKey,
  factValue,
  source = "user_provided",
  occurredAt = nowIso()
} = {}) {
  const profile = positiveInteger(profileId, "profileId");
  assertProfile(db, profile);
  const key = normalizeFactKey(factKey);
  const value = factValueText(factValue);
  const sourceText = inlineText(source || "user_provided", 80);
  const at = isoText(occurredAt, "occurredAt");
  return immediateTransaction(db, () => {
    const current = db.prepare(`SELECT fact_value, source FROM candidate_facts
      WHERE profile_id = ? AND fact_key = ?`).get(profile, key);
    if (current?.fact_value === value && current?.source === sourceText) {
      return { factKey: key, factValue: value, source: sourceText };
    }
    db.prepare(`INSERT INTO candidate_fact_revisions(
      profile_id, fact_key, fact_value, operation, source,
      answer_memory_id, evidence_text, withdrawn_at, created_at
    ) VALUES (?, ?, ?, 'set', ?, NULL, '', NULL, ?)`)
      .run(profile, key, value, sourceText, at);
    projectCandidateFact(db, profile, key, at);
    return { factKey: key, factValue: value, source: sourceText };
  });
}

function deleteCandidateFact(db, {
  profileId,
  factKey,
  source = "user_provided",
  occurredAt = nowIso()
} = {}) {
  const profile = positiveInteger(profileId, "profileId");
  assertProfile(db, profile);
  const key = normalizeFactKey(factKey);
  const at = isoText(occurredAt, "occurredAt");
  return immediateTransaction(db, () => {
    const current = db.prepare("SELECT id FROM candidate_facts WHERE profile_id = ? AND fact_key = ?")
      .get(profile, key);
    if (!current) return false;
    db.prepare(`INSERT INTO candidate_fact_revisions(
      profile_id, fact_key, fact_value, operation, source,
      answer_memory_id, evidence_text, withdrawn_at, created_at
    ) VALUES (?, ?, '', 'delete', ?, NULL, '', NULL, ?)`)
      .run(profile, key, inlineText(source || "user_provided", 80), at);
    projectCandidateFact(db, profile, key, at);
    return true;
  });
}

function closeMessageReplyDrafts(db, {
  profileId,
  cardId,
  closedAt = nowIso()
} = {}) {
  const profile = positiveInteger(profileId, "profileId");
  const card = positiveInteger(cardId, "cardId");
  const at = isoText(closedAt, "closedAt");
  return immediateTransaction(db, () => {
    const changes = Number(db.prepare(`UPDATE message_reply_drafts
      SET closed_at = COALESCE(closed_at, ?), updated_at = ?
      WHERE profile_id = ? AND card_id = ? AND closed_at IS NULL`)
      .run(at, at, profile, card).changes);
    purgeClosedInboundContexts(db, { profileId: profile, cardId: card });
    return changes;
  });
}

function projectCandidateFact(db, profileId, factKey, projectedAt) {
  const revision = db.prepare(`SELECT r.*
    FROM candidate_fact_revisions r
    LEFT JOIN candidate_answer_memories m ON m.id = r.answer_memory_id
    WHERE r.profile_id = ? AND r.fact_key = ? AND r.withdrawn_at IS NULL
      AND (r.answer_memory_id IS NULL OR (
        m.withdrawn_at IS NULL AND
        m.id = (SELECT m2.id FROM candidate_answer_memories m2
          JOIN candidate_fact_revisions r2
            ON r2.answer_memory_id = m2.id
            AND r2.fact_key = r.fact_key
            AND r2.withdrawn_at IS NULL
          WHERE m2.profile_id = m.profile_id AND m2.draft_id = m.draft_id AND m2.withdrawn_at IS NULL
          ORDER BY m2.updated_at DESC, m2.id DESC LIMIT 1)
      ))
    ORDER BY CASE WHEN r.answer_memory_id IS NULL THEN r.created_at ELSE m.updated_at END DESC, r.id DESC
    LIMIT 1`).get(profileId, factKey);
  if (!revision || revision.operation === "delete") {
    db.prepare("DELETE FROM candidate_facts WHERE profile_id = ? AND fact_key = ?")
      .run(profileId, factKey);
    return;
  }
  db.prepare(`INSERT INTO candidate_facts(
    profile_id, fact_key, fact_value, source, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(profile_id, fact_key) DO UPDATE SET
    fact_value = excluded.fact_value,
    source = excluded.source,
    updated_at = excluded.updated_at`)
    .run(
      profileId,
      factKey,
      revision.fact_value,
      revision.source,
      revision.created_at,
      projectedAt
    );
}

function updateDraftOnCompletion(db, draft, finalText, completionKind, at) {
  const changedCurrent = draft.currentText !== finalText;
  db.prepare(`UPDATE message_reply_drafts SET
    current_text = ?,
    revision = revision + ?,
    closed_at = CASE WHEN ? = 'sent' THEN COALESCE(closed_at, ?) ELSE closed_at END,
    updated_at = ?
    WHERE id = ?`).run(finalText, changedCurrent ? 1 : 0, completionKind, at, at, draft.id);
  if (completionKind === "sent") {
    purgeClosedInboundContexts(db, {
      profileId: draft.profileId,
      cardId: draft.cardId,
      messageGroupKey: draft.messageGroupKey
    });
  }
}

function purgeClosedInboundContexts(db, { profileId, cardId, messageGroupKey = "" }) {
  const groupClause = messageGroupKey ? "AND message_group_key = ?" : "";
  const values = messageGroupKey ? [profileId, cardId, messageGroupKey] : [profileId, cardId];
  db.prepare(`DELETE FROM message_inbound_contexts
    WHERE profile_id = ? AND card_id = ? ${groupClause}
      AND NOT EXISTS (
        SELECT 1 FROM message_reply_drafts drafts
        WHERE drafts.profile_id = message_inbound_contexts.profile_id
          AND drafts.card_id = message_inbound_contexts.card_id
          AND drafts.message_group_key = message_inbound_contexts.message_group_key
          AND drafts.closed_at IS NULL
      )`).run(...values);
}

function requireDraft(db, profileId, draftId) {
  const draft = getMessageReplyDraft(db, { profileId, draftId });
  if (!draft) throw storageError("MESSAGE_REPLY_DRAFT_NOT_FOUND", "message reply draft was not found");
  return draft;
}

function assertDraftOwner(db, { profileId, cardId, jobId }) {
  const row = db.prepare(`SELECT id FROM candidate_progress_cards
    WHERE id = ? AND profile_id = ? AND job_id = ?`).get(cardId, profileId, jobId);
  if (!row) throw storageError("MESSAGE_REPLY_DRAFT_OWNER_INVALID", "message reply draft owner is invalid");
}

function assertProfile(db, profileId) {
  if (!db.prepare("SELECT id FROM candidate_profiles WHERE id = ?").get(profileId)) {
    throw storageError("CANDIDATE_PROFILE_NOT_FOUND", "candidate profile was not found");
  }
}

function normalizedExtractedFacts(value) {
  const facts = Array.isArray(value) ? value : [];
  const byKey = new Map();
  for (const item of facts) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    let factKey;
    let factValue;
    try {
      factKey = normalizeFactKey(item.factKey);
      factValue = factValueText(item.factValue);
    } catch {
      continue;
    }
    byKey.set(factKey, {
      factKey,
      factValue,
      evidenceText: draftText(item.evidenceText || "", { allowEmpty: true }).slice(0, 2000)
    });
  }
  return [...byKey.values()];
}

function normalizeScope(value) {
  const scope = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const kind = VALID_SCOPE_KINDS.has(scope.kind) ? scope.kind : "global";
  return { kind, key: inlineText(scope.key || "", 160) };
}

function mapDraft(row) {
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    cardId: Number(row.card_id),
    jobId: Number(row.job_id),
    messageGroupKey: row.message_group_key,
    draftIndex: Number(row.draft_index),
    questionSummary: row.question_summary,
    messageIntent: row.message_intent,
    messageCategory: row.message_category,
    originalText: row.original_text,
    currentText: row.current_text,
    revision: Number(row.revision),
    closedAt: row.closed_at || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMemory(row) {
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    draftId: Number(row.draft_id),
    finalDigest: row.final_digest,
    questionSummary: row.question_summary,
    messageIntent: row.message_intent,
    messageCategory: row.message_category,
    originalText: row.original_text,
    finalText: row.final_text,
    changedText: row.changed_text,
    scope: parseJson(row.scope_json, { kind: "global", key: "" }),
    source: row.source,
    completionKind: row.completion_kind,
    supersedesMemoryId: Number(row.supersedes_memory_id || 0) || null,
    withdrawnAt: row.withdrawn_at || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapFactRevision(row) {
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    factKey: row.fact_key,
    factValue: row.fact_value,
    operation: row.operation,
    source: row.source,
    answerMemoryId: Number(row.answer_memory_id || 0) || null,
    evidenceText: row.evidence_text || "",
    withdrawnAt: row.withdrawn_at || "",
    createdAt: row.created_at
  };
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

function optionalPositiveInteger(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return positiveInteger(value, label);
}

function boundedLimit(value, fallback, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function normalizeFactKey(value) {
  const key = String(value || "").trim().replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80);
  if (!key) throw new TypeError("factKey is required");
  return key;
}

function factValueText(value) {
  const text = String(value || "").trim().slice(0, MAX_FACT_VALUE);
  if (!text) throw new TypeError("factValue is required");
  return text;
}

function draftText(value, { allowEmpty = false } = {}) {
  const text = String(value == null ? "" : value).replace(/\r\n?/g, "\n").trim().slice(0, MAX_DRAFT_TEXT);
  if (!allowEmpty && !text) throw new TypeError("draft text is required");
  return text;
}

function inlineText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function comparableText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function digestKey(value, label) {
  const text = String(value || "").trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(text)) throw new TypeError(`${label} must be a sha256 digest`);
  return text;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function normalizeDigestText(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, MAX_DRAFT_TEXT);
}

function isoText(value, label) {
  const text = String(value || "");
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${label} must be an ISO timestamp`);
  return new Date(text).toISOString();
}

module.exports = {
  recordMessageReplyDrafts,
  getMessageReplyDraft,
  listOpenMessageReplyDrafts,
  saveMessageReplyDraftEdit,
  completeMessageReplyDraft,
  listCandidateAnswerMemories,
  reviseCandidateAnswerMemory,
  withdrawCandidateAnswerMemory,
  listCandidateFactRevisions,
  recordCandidateFactValue,
  deleteCandidateFact,
  closeMessageReplyDrafts
};
