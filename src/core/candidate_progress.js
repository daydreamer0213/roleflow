const PROGRESS_STAGES = new Set([
  "contact_started",
  "waiting_reply",
  "needs_user_action",
  "reply_ready",
  "interview_invited",
  "interview_scheduled",
  "resume_submitted",
  "rejected",
  "closed"
]);

const TERMINAL_PROGRESS_STAGES = new Set(["rejected", "closed"]);
const FORBIDDEN_METADATA_KEYS = new Set(["message", "body", "text", "html", "draft", "screenshot"]);
const ALLOWED_METADATA_KEYS = new Set([
  "batchId",
  "itemId",
  "jobId",
  "profileId",
  "planId",
  "category",
  "messageCategory",
  "factKey",
  "missingFactKey",
  "stage",
  "fromStage",
  "toStage",
  "scheduledAt",
  "outcome",
  "reasonCode",
  "source"
]);
const TRANSITIONS = new Map([
  ["contact_started", new Set(["waiting_reply", "needs_user_action", "closed"])],
  ["waiting_reply", new Set(["needs_user_action", "reply_ready", "interview_invited", "resume_submitted", "rejected", "closed"])],
  ["needs_user_action", new Set(["waiting_reply", "reply_ready", "interview_invited", "interview_scheduled", "resume_submitted", "rejected", "closed"])],
  ["reply_ready", new Set(["waiting_reply", "needs_user_action", "interview_invited", "rejected", "closed"])],
  ["interview_invited", new Set(["needs_user_action", "interview_scheduled", "rejected", "closed"])],
  ["interview_scheduled", new Set(["needs_user_action", "resume_submitted", "rejected", "closed"])],
  ["resume_submitted", new Set(["waiting_reply", "needs_user_action", "interview_invited", "interview_scheduled", "rejected", "closed"])],
  ["rejected", new Set(["closed"])],
  ["closed", new Set()]
]);

function ensureProgressCard(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const planId = positiveInteger(input.planId, "planId");
  const jobId = positiveInteger(input.jobId, "jobId");
  const source = shortText(input.source, 80);
  if (!source) throw progressError("PROGRESS_SOURCE_REQUIRED", "progress source is required");
  const existing = getProgressCardForJob(db, { profileId, jobId });
  if (existing) return existing;
  const owner = db.prepare("SELECT profile_id FROM search_plans WHERE id = ?").get(planId);
  if (!owner || Number(owner.profile_id) !== profileId) {
    throw progressError("PROGRESS_PLAN_PROFILE_MISMATCH", "progress plan does not belong to the profile");
  }
  const job = db.prepare("SELECT source FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw progressError("PROGRESS_JOB_NOT_FOUND", "progress job was not found");
  const now = isoText(input.now);
  const result = db.prepare(`INSERT INTO candidate_progress_cards(
      profile_id, plan_id, job_id, source, stage, last_event_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'contact_started', ?, ?, ?)
    ON CONFLICT(profile_id, job_id) DO NOTHING`)
    .run(profileId, planId, jobId, source, now, now, now);
  if (Number(result.changes) === 1) return getProgressCard(db, Number(result.lastInsertRowid));
  return getProgressCardForJob(db, { profileId, jobId });
}

function recordProgressEvent(db, input = {}) {
  const cardId = positiveInteger(input.cardId, "cardId");
  if (!getProgressCard(db, cardId)) throw progressError("PROGRESS_CARD_NOT_FOUND", "progress card was not found");
  const type = shortText(input.type, 80);
  const actor = shortText(input.actor, 40);
  if (!type || !actor) throw progressError("PROGRESS_EVENT_INVALID", "progress event type and actor are required");
  const summary = shortText(input.summary, 240);
  const metadata = sanitizeMetadata(input.metadata);
  const occurredAt = isoText(input.occurredAt);
  const result = db.prepare(`INSERT INTO candidate_progress_events(
    card_id, type, actor, summary, metadata_json, occurred_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(cardId, type, actor, summary, JSON.stringify(metadata), occurredAt, occurredAt);
  db.prepare(`UPDATE candidate_progress_cards
    SET last_event_at = ?, updated_at = ? WHERE id = ?`)
    .run(occurredAt, occurredAt, cardId);
  return mapEvent(db.prepare("SELECT * FROM candidate_progress_events WHERE id = ?").get(Number(result.lastInsertRowid)));
}

function transitionProgressCard(db, input = {}) {
  const cardId = positiveInteger(input.cardId, "cardId");
  const expectedStage = legalStage(input.expectedStage);
  const stage = legalStage(input.stage);
  const card = getProgressCard(db, cardId);
  if (!card) throw progressError("PROGRESS_CARD_NOT_FOUND", "progress card was not found");
  if (card.stage !== expectedStage) {
    throw progressError("PROGRESS_STAGE_CONFLICT", `expected ${expectedStage}, found ${card.stage}`);
  }
  if (stage !== expectedStage && !TRANSITIONS.get(expectedStage).has(stage)) {
    throw progressError("PROGRESS_STAGE_TRANSITION_INVALID", `cannot transition progress from ${expectedStage} to ${stage}`);
  }
  const now = isoText(input.now);
  const result = db.prepare(`UPDATE candidate_progress_cards
    SET stage = ?, next_action = ?, scheduled_at = ?, updated_at = ?
    WHERE id = ? AND stage = ?`)
    .run(stage, shortText(input.nextAction, 240), nullableText(input.scheduledAt, 80), now, cardId, expectedStage);
  if (Number(result.changes) !== 1) throw progressError("PROGRESS_STAGE_CONFLICT", "progress stage changed concurrently");
  return getProgressCard(db, cardId);
}

function correctProgressStage(db, input = {}) {
  const reason = shortText(input.reason, 240);
  if (!reason) throw progressError("PROGRESS_CORRECTION_REASON_REQUIRED", "progress correction reason is required");
  const cardId = positiveInteger(input.cardId, "cardId");
  const expectedStage = legalStage(input.expectedStage);
  const toStage = legalStage(input.toStage);
  const card = getProgressCard(db, cardId);
  if (!card) throw progressError("PROGRESS_CARD_NOT_FOUND", "progress card was not found");
  if (card.stage !== expectedStage) {
    throw progressError("PROGRESS_STAGE_CONFLICT", `expected ${expectedStage}, found ${card.stage}`);
  }
  if (expectedStage === "closed" && toStage !== "needs_user_action") {
    throw progressError("PROGRESS_STAGE_TRANSITION_INVALID", "closed progress can only reopen to needs_user_action");
  }
  const now = isoText(input.now);
  db.exec("BEGIN IMMEDIATE");
  try {
    recordProgressEvent(db, {
      cardId,
      type: "manual_correction",
      actor: "user",
      summary: reason,
      metadata: { fromStage: expectedStage, toStage },
      occurredAt: now
    });
    const result = db.prepare(`UPDATE candidate_progress_cards
      SET stage = ?, next_action = '', scheduled_at = NULL, updated_at = ?
      WHERE id = ? AND stage = ?`)
      .run(toStage, now, cardId, expectedStage);
    if (Number(result.changes) !== 1) throw progressError("PROGRESS_STAGE_CONFLICT", "progress stage changed concurrently");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return getProgressCard(db, cardId);
}

function recordVerifiedCommunicationStart(db, input = {}) {
  const { batch = {}, item = {} } = input;
  const outcome = String(input.outcome || input.status || "").trim();
  if (!["succeeded", "already_communicated"].includes(outcome)) {
    throw progressError("PROGRESS_COMMUNICATION_OUTCOME_INVALID", "verified communication outcome is required");
  }
  const batchId = positiveInteger(batch.id, "batch.id");
  const itemId = positiveInteger(item.id, "item.id");
  const jobId = positiveInteger(item.jobId, "item.jobId");
  const now = isoText(input.now);
  let card = ensureProgressCard(db, {
    profileId: batch.profileId,
    planId: batch.planId,
    jobId,
    source: batch.site || "boss",
    now
  });
  const eventType = outcome === "already_communicated" ? "contact_already_exists" : "contact_started";
  const duplicate = db.prepare(`SELECT id FROM candidate_progress_events
    WHERE card_id = ? AND type = ?
      AND json_extract(metadata_json, '$.batchId') = ?
      AND json_extract(metadata_json, '$.itemId') = ?
      AND json_extract(metadata_json, '$.outcome') = ?
    LIMIT 1`).get(card.id, eventType, batchId, itemId, outcome);
  if (!duplicate) {
    recordProgressEvent(db, {
      cardId: card.id,
      type: eventType,
      actor: "system",
      summary: outcome === "already_communicated" ? "平台显示已发起沟通" : "已验证发起沟通",
      metadata: { batchId, itemId, jobId, outcome },
      occurredAt: now
    });
  }
  if (card.stage === "contact_started") {
    card = transitionProgressCard(db, {
      cardId: card.id,
      expectedStage: "contact_started",
      stage: "waiting_reply",
      nextAction: "等待招聘方回复",
      now
    });
  }
  return card;
}

function getProgressCardForJob(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const jobId = positiveInteger(input.jobId, "jobId");
  return mapCard(db.prepare(`SELECT * FROM candidate_progress_cards
    WHERE profile_id = ? AND job_id = ?`).get(profileId, jobId));
}

function listProgressCards(db, input = {}) {
  const planId = positiveInteger(input.planId, "planId");
  const stages = Array.isArray(input.stages) ? [...new Set(input.stages.map(legalStage))] : [];
  const stageClause = stages.length ? ` AND stage IN (${stages.map(() => "?").join(", ")})` : "";
  return db.prepare(`SELECT * FROM candidate_progress_cards
    WHERE plan_id = ?${stageClause}
    ORDER BY updated_at DESC, id DESC`)
    .all(planId, ...stages)
    .map(mapCard);
}

function listProgressEvents(db, cardId) {
  return db.prepare(`SELECT * FROM candidate_progress_events
    WHERE card_id = ? ORDER BY occurred_at ASC, id ASC`)
    .all(positiveInteger(cardId, "cardId"))
    .map(mapEvent);
}

function getProgressCard(db, cardId) {
  return mapCard(db.prepare("SELECT * FROM candidate_progress_cards WHERE id = ?").get(cardId));
}

function sanitizeMetadata(value) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw progressError("PROGRESS_EVENT_METADATA_INVALID", "progress event metadata must be an object");
  }
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (FORBIDDEN_METADATA_KEYS.has(String(key).toLowerCase())) {
      throw progressError("PROGRESS_EVENT_METADATA_FORBIDDEN", `progress event metadata cannot contain ${key}`);
    }
    if (!ALLOWED_METADATA_KEYS.has(key)) {
      throw progressError("PROGRESS_EVENT_METADATA_INVALID", `progress event metadata key ${key} is not allowed`);
    }
    if (raw !== null && !["string", "number", "boolean"].includes(typeof raw)) {
      throw progressError("PROGRESS_EVENT_METADATA_INVALID", `progress event metadata ${key} must be scalar`);
    }
    result[key] = typeof raw === "string" ? raw.trim().slice(0, 240) : raw;
  }
  return result;
}

function mapCard(row) {
  return row ? {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    planId: Number(row.plan_id),
    jobId: Number(row.job_id),
    source: row.source,
    recruiterName: row.recruiter_name || "",
    threadKey: row.thread_key || "",
    stage: row.stage,
    nextAction: row.next_action || "",
    scheduledAt: row.scheduled_at || null,
    lastEventAt: row.last_event_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

function mapEvent(row) {
  return row ? {
    id: Number(row.id),
    cardId: Number(row.card_id),
    type: row.type,
    actor: row.actor,
    summary: row.summary || "",
    metadata: parseJson(row.metadata_json, {}),
    occurredAt: row.occurred_at,
    createdAt: row.created_at
  } : null;
}

function legalStage(value) {
  const stage = String(value || "").trim();
  if (!PROGRESS_STAGES.has(stage)) throw progressError("PROGRESS_STAGE_INVALID", `unknown progress stage ${stage}`);
  return stage;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw progressError("PROGRESS_ID_INVALID", `${name} must be a positive integer`);
  }
  return number;
}

function isoText(value) {
  const text = String(value || new Date().toISOString()).trim();
  if (!Number.isFinite(Date.parse(text))) throw progressError("PROGRESS_TIME_INVALID", "progress time must be ISO-compatible");
  return text;
}

function shortText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function nullableText(value, maxLength) {
  const text = shortText(value, maxLength);
  return text || null;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function progressError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  PROGRESS_STAGES,
  TERMINAL_PROGRESS_STAGES,
  ensureProgressCard,
  recordProgressEvent,
  transitionProgressCard,
  correctProgressStage,
  recordVerifiedCommunicationStart,
  getProgressCardForJob,
  listProgressCards,
  listProgressEvents
};
