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
const MESSAGE_CATEGORIES = new Set([
  "project_fact",
  "qualification",
  "salary",
  "availability",
  "interview_invitation",
  "other",
  "identity_uncertain"
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
  "source",
  "platform",
  "threadKey",
  "messageKey",
  "messageGroupKey"
]);
const TRANSITIONS = new Map([
  ["contact_started", new Set(["waiting_reply", "needs_user_action", "reply_ready", "interview_invited", "closed"])],
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
  const owner = db.prepare("SELECT profile_id FROM search_plans WHERE id = ?").get(planId);
  if (!owner || Number(owner.profile_id) !== profileId) {
    throw progressError("PROGRESS_PLAN_PROFILE_MISMATCH", "progress plan does not belong to the profile");
  }
  const job = db.prepare("SELECT source FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw progressError("PROGRESS_JOB_NOT_FOUND", "progress job was not found");
  const now = isoText(input.now);
  const existing = getProgressCardForJob(db, { profileId, jobId });
  if (existing) return existing;
  const result = db.prepare(`INSERT INTO candidate_progress_cards(
      profile_id, plan_id, job_id, source, stage, last_event_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'contact_started', ?, ?, ?)
    ON CONFLICT(profile_id, job_id) DO NOTHING`)
    .run(profileId, planId, jobId, source, now, now, now);
  if (Number(result.changes) === 1) return getProgressCard(db, Number(result.lastInsertRowid));
  return getProgressCardForJob(db, { profileId, jobId });
}

function recordProgressEvent(db, input = {}) {
  return persistProgressEvent(db, input).event;
}

function persistProgressEvent(db, input = {}, { keyKind = "external" } = {}) {
  const cardId = positiveInteger(input.cardId, "cardId");
  if (!getProgressCard(db, cardId)) throw progressError("PROGRESS_CARD_NOT_FOUND", "progress card was not found");
  const idempotencyKey = keyKind === "communication"
    ? communicationIdempotencyKey(input.idempotencyKey)
    : keyKind === "message"
      ? messageIdempotencyKey(input.platform, input.messageKey)
      : keyKind === "message-group"
        ? messageGroupIdempotencyKey(input.platform, input.messageGroupKey)
      : progressIdempotencyKey(input.idempotencyKey);
  const type = shortText(input.type, 80);
  const actor = shortText(input.actor, 40);
  if (!type || !actor) throw progressError("PROGRESS_EVENT_INVALID", "progress event type and actor are required");
  const summary = shortText(input.summary, 240);
  const metadata = sanitizeMetadata(input.metadata);
  const occurredAt = isoText(input.occurredAt);
  const result = db.prepare(`INSERT OR IGNORE INTO candidate_progress_events(
    card_id, idempotency_key, type, actor, summary, metadata_json, occurred_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(cardId, idempotencyKey, type, actor, summary, JSON.stringify(metadata), occurredAt, occurredAt);
  if (Number(result.changes) !== 1) {
    const existing = db.prepare(`SELECT * FROM candidate_progress_events
      WHERE card_id = ? AND idempotency_key = ?`).get(cardId, idempotencyKey);
    if (!existing) throw progressError("PROGRESS_EVENT_CONFLICT", "progress event could not be persisted");
    const event = mapEvent(existing);
    assertEventIntent(event, { type, actor, summary, metadata });
    return { event, inserted: false };
  }
  db.prepare(`UPDATE candidate_progress_cards
    SET last_event_at = ?, updated_at = ? WHERE id = ?`)
    .run(occurredAt, occurredAt, cardId);
  return {
    event: mapEvent(db.prepare("SELECT * FROM candidate_progress_events WHERE id = ?").get(Number(result.lastInsertRowid))),
    inserted: true
  };
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
  const idempotencyKey = progressIdempotencyKey(input.idempotencyKey);
  const expectedStage = legalStage(input.expectedStage);
  const toStage = legalStage(input.toStage);
  const card = getProgressCard(db, cardId);
  if (!card) throw progressError("PROGRESS_CARD_NOT_FOUND", "progress card was not found");
  const existingEvent = getProgressEventByKey(db, cardId, idempotencyKey);
  if (existingEvent) {
    assertEventIntent(existingEvent, {
      type: "manual_correction",
      actor: "user",
      summary: reason,
      metadata: { fromStage: expectedStage, toStage }
    }, ["fromStage", "toStage"]);
    return card;
  }
  if (card.stage !== expectedStage) {
    throw progressError("PROGRESS_STAGE_CONFLICT", `expected ${expectedStage}, found ${card.stage}`);
  }
  if (expectedStage === "closed" && toStage !== "needs_user_action") {
    throw progressError("PROGRESS_STAGE_TRANSITION_INVALID", "closed progress can only reopen to needs_user_action");
  }
  const now = isoText(input.now);
  db.exec("BEGIN IMMEDIATE");
  try {
    const persisted = persistProgressEvent(db, {
      cardId,
      idempotencyKey,
      type: "manual_correction",
      actor: "user",
      summary: reason,
      metadata: { fromStage: expectedStage, toStage },
      occurredAt: now
    });
    if (!persisted.inserted) {
      db.exec("COMMIT");
      return getProgressCard(db, cardId);
    }
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
  db.exec("SAVEPOINT candidate_progress_verified");
  try {
    let card = ensureProgressCard(db, {
      profileId: batch.profileId,
      planId: batch.planId,
      jobId,
      source: batch.site || "boss",
      now
    });
    const eventType = outcome === "already_communicated" ? "contact_already_exists" : "contact_started";
    const persisted = persistProgressEvent(db, {
      cardId: card.id,
      idempotencyKey: `communication:${batchId}:${itemId}:${outcome}`,
      type: eventType,
      actor: "system",
      summary: outcome === "already_communicated" ? "平台显示已发起沟通" : "已验证发起沟通",
      metadata: { batchId, itemId, jobId, outcome },
      occurredAt: now
    }, { keyKind: "communication" });
    if (persisted.inserted && card.stage === "contact_started") {
      card = transitionProgressCard(db, {
        cardId: card.id,
        expectedStage: "contact_started",
        stage: "waiting_reply",
        nextAction: "等待招聘方回复",
        now
      });
    }
    db.exec("RELEASE candidate_progress_verified");
    return card;
  } catch (error) {
    try {
      db.exec("ROLLBACK TO candidate_progress_verified");
      db.exec("RELEASE candidate_progress_verified");
    } catch {}
    throw error;
  }
}

function recordIncomingMessageClassification(db, input = {}) {
  const cardId = positiveInteger(input.cardId, "cardId");
  const idempotencyKey = progressIdempotencyKey(input.idempotencyKey);
  const messageCategory = String(input.messageCategory || "").trim();
  if (!MESSAGE_CATEGORIES.has(messageCategory)) {
    throw progressError("PROGRESS_MESSAGE_CATEGORY_INVALID", "message category is invalid");
  }
  const progressUpdate = input.progressUpdate && typeof input.progressUpdate === "object"
    ? input.progressUpdate
    : {};
  const stage = legalStage(progressUpdate.stage);
  const missingFactKey = shortText(input.missingFactKey, 80);
  const summary = sanitizedMessageSummary(messageCategory, { missingFactKey });
  const card = getProgressCard(db, cardId);
  if (!card) throw progressError("PROGRESS_CARD_NOT_FOUND", "progress card was not found");
  const classificationMetadata = { messageCategory, missingFactKey, stage };
  const existingEvent = getProgressEventByKey(db, cardId, idempotencyKey);
  if (existingEvent) {
    assertEventIntent(existingEvent, {
      type: "incoming_message_classified",
      actor: "system",
      summary,
      metadata: classificationMetadata
    });
    return card;
  }
  const occurredAt = isoText(input.occurredAt);
  db.exec("BEGIN IMMEDIATE");
  try {
    const persisted = persistProgressEvent(db, {
      cardId,
      idempotencyKey,
      type: "incoming_message_classified",
      actor: "system",
      summary,
      metadata: classificationMetadata,
      occurredAt
    });
    if (!persisted.inserted) {
      db.exec("COMMIT");
      return getProgressCard(db, cardId);
    }
    transitionProgressCard(db, {
      cardId,
      expectedStage: card.stage,
      stage,
      nextAction: shortText(progressUpdate.nextAction, 240),
      now: occurredAt
    });
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return getProgressCard(db, cardId);
}

function recordDiscoveredMessageClassification(db, input = {}) {
  const cardId = positiveInteger(input.cardId, "cardId");
  const card = getProgressCard(db, cardId);
  if (!card) throw progressError("PROGRESS_CARD_NOT_FOUND", "progress card was not found");
  const platform = String(input.platform || "").trim().toLowerCase();
  const threadKey = safeDigestKey(input.threadKey, "threadKey");
  const messageKey = safeDigestKey(input.messageKey, "messageKey");
  const idempotencyKey = messageIdempotencyKey(platform, messageKey);
  const messageCategory = String(input.messageCategory || "").trim();
  if (!MESSAGE_CATEGORIES.has(messageCategory)) {
    throw progressError("PROGRESS_MESSAGE_CATEGORY_INVALID", "message category is invalid");
  }
  const progressUpdate = input.progressUpdate && typeof input.progressUpdate === "object"
    ? input.progressUpdate
    : {};
  const stage = legalStage(progressUpdate.stage);
  const missingFactKey = safeMissingFactKey(input.missingFactKey);
  const summary = sanitizedMessageSummary(messageCategory, { missingFactKey });
  const classificationMetadata = {
    platform,
    threadKey,
    messageKey,
    messageCategory,
    missingFactKey,
    stage
  };
  const existingEvent = getProgressEventByKey(db, cardId, idempotencyKey);
  if (existingEvent) {
    assertEventIntent(existingEvent, {
      type: "incoming_message_classified",
      actor: "system",
      summary,
      metadata: classificationMetadata
    });
    return getProgressCard(db, cardId);
  }
  const occurredAt = isoText(input.occurredAt);
  db.exec("BEGIN IMMEDIATE");
  try {
    const binding = db.prepare(`UPDATE candidate_progress_cards
      SET thread_key = ?, updated_at = ?
      WHERE id = ? AND thread_key = ''`)
      .run(threadKey, occurredAt, cardId);
    if (Number(binding.changes) !== 1) {
      const current = getProgressCard(db, cardId);
      if (!current || current.threadKey !== threadKey) {
        throw progressError("PROGRESS_THREAD_CONFLICT", "progress card is bound to a different thread");
      }
    }
    const persisted = persistProgressEvent(db, {
      cardId,
      platform,
      messageKey,
      type: "incoming_message_classified",
      actor: "system",
      summary,
      metadata: classificationMetadata,
      occurredAt
    }, { keyKind: "message" });
    if (!persisted.inserted) {
      db.exec("COMMIT");
      return getProgressCard(db, cardId);
    }
    transitionProgressCard(db, {
      cardId,
      expectedStage: card.stage,
      stage,
      nextAction: safeDiscoveredNextAction(stage),
      now: occurredAt
    });
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return getProgressCard(db, cardId);
}

function recordDiscoveredMessageGroupClassification(db, input = {}) {
  const cardId = positiveInteger(input.cardId, "cardId");
  const card = getProgressCard(db, cardId);
  if (!card) throw progressError("PROGRESS_CARD_NOT_FOUND", "progress card was not found");
  const platform = String(input.platform || "").trim().toLowerCase();
  const threadKey = safeDigestKey(input.threadKey, "threadKey");
  const messageKeys = normalizedMessageKeys(input.messageKeys);
  const messageGroupKey = safeDigestKey(input.messageGroupKey, "messageGroupKey");
  const messageCategory = String(input.messageCategory || "").trim();
  if (!MESSAGE_CATEGORIES.has(messageCategory)) {
    throw progressError("PROGRESS_MESSAGE_CATEGORY_INVALID", "message category is invalid");
  }
  const progressUpdate = input.progressUpdate && typeof input.progressUpdate === "object"
    ? input.progressUpdate
    : {};
  const stage = legalStage(progressUpdate.stage);
  const missingFactKey = safeMissingFactKey(input.missingFactKey);
  const summary = sanitizedMessageSummary(messageCategory, { missingFactKey });
  const classificationMetadata = {
    platform,
    threadKey,
    messageGroupKey,
    messageCategory,
    missingFactKey,
    stage
  };
  const groupIdempotencyKey = messageGroupIdempotencyKey(platform, messageGroupKey);
  const existingGroup = getProgressEventByKey(db, cardId, groupIdempotencyKey);
  if (existingGroup) {
    assertEventIntent(existingGroup, {
      type: "message_group_classified",
      actor: "system",
      summary,
      metadata: classificationMetadata
    });
    return getProgressCard(db, cardId);
  }
  const occurredAt = isoText(input.occurredAt);
  db.exec("BEGIN IMMEDIATE");
  try {
    const binding = db.prepare(`UPDATE candidate_progress_cards
      SET thread_key = ?, updated_at = ?
      WHERE id = ? AND thread_key = ''`)
      .run(threadKey, occurredAt, cardId);
    if (Number(binding.changes) !== 1) {
      const current = getProgressCard(db, cardId);
      if (!current || current.threadKey !== threadKey) {
        throw progressError("PROGRESS_THREAD_CONFLICT", "progress card is bound to a different thread");
      }
    }
    for (const messageKey of messageKeys) {
      persistProgressEvent(db, {
        cardId,
        platform,
        messageKey,
        type: "incoming_message_classified",
        actor: "system",
        summary,
        metadata: {
          platform,
          threadKey,
          messageKey,
          messageCategory,
          missingFactKey,
          stage
        },
        occurredAt
      }, { keyKind: "message" });
    }
    persistProgressEvent(db, {
      cardId,
      platform,
      messageGroupKey,
      type: "message_group_classified",
      actor: "system",
      summary,
      metadata: classificationMetadata,
      occurredAt
    }, { keyKind: "message-group" });
    transitionProgressCard(db, {
      cardId,
      expectedStage: card.stage,
      stage,
      nextAction: safeDiscoveredNextAction(stage),
      now: occurredAt
    });
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return getProgressCard(db, cardId);
}

function recordManualProgressAction(db, input = {}) {
  const cardId = positiveInteger(input.cardId, "cardId");
  const idempotencyKey = progressIdempotencyKey(input.idempotencyKey);
  const card = getProgressCard(db, cardId);
  if (!card) throw progressError("PROGRESS_CARD_NOT_FOUND", "progress card was not found");
  const stage = legalStage(input.stage);
  const eventType = shortText(input.eventType, 80);
  const summary = shortText(input.summary, 240);
  if (!eventType || !summary) throw progressError("PROGRESS_ACTION_INVALID", "progress action event and summary are required");
  const scheduledAt = nullableText(input.scheduledAt, 80);
  if (scheduledAt && !Number.isFinite(Date.parse(scheduledAt))) {
    throw progressError("PROGRESS_TIME_INVALID", "scheduled time must be ISO-compatible");
  }
  const actionMetadata = { stage, ...(scheduledAt ? { scheduledAt } : {}) };
  const existingEvent = getProgressEventByKey(db, cardId, idempotencyKey);
  if (existingEvent) {
    assertEventIntent(existingEvent, {
      type: eventType,
      actor: "user",
      summary,
      metadata: actionMetadata
    });
    return card;
  }
  const closedReopen = card.stage === "closed"
    && stage === "needs_user_action"
    && eventType === "opportunity_reopened";
  if (card.stage === "closed" && !closedReopen) {
    throw progressError("PROGRESS_STAGE_TRANSITION_INVALID", "closed progress can only be reopened");
  }
  const now = isoText(input.now);
  db.exec("BEGIN IMMEDIATE");
  try {
    const persisted = persistProgressEvent(db, {
      cardId,
      idempotencyKey,
      type: eventType,
      actor: "user",
      summary,
      metadata: actionMetadata,
      occurredAt: now
    });
    if (!persisted.inserted) {
      db.exec("COMMIT");
      return getProgressCard(db, cardId);
    }
    if (closedReopen) {
      const result = db.prepare(`UPDATE candidate_progress_cards
        SET stage = 'needs_user_action', next_action = ?, scheduled_at = NULL, updated_at = ?
        WHERE id = ? AND stage = 'closed'`)
        .run(shortText(input.nextAction, 240), now, cardId);
      if (Number(result.changes) !== 1) throw progressError("PROGRESS_STAGE_CONFLICT", "progress stage changed concurrently");
    } else {
      transitionProgressCard(db, {
        cardId,
        expectedStage: card.stage,
        stage,
        nextAction: shortText(input.nextAction, 240),
        scheduledAt,
        now
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return getProgressCard(db, cardId);
}

function sanitizedMessageSummary(messageCategory, { missingFactKey = "" } = {}) {
  const category = String(messageCategory || "").trim();
  return {
    project_fact: "项目事实确认",
    qualification: "资格条件确认",
    salary: "薪资问题确认",
    availability: "到岗时间确认",
    interview_invitation: "收到面试邀约",
    identity_uncertain: "岗位或线程关联待确认",
    other: missingFactKey ? "需要补充用户确认事实" : "招聘方问题已分类"
  }[category] || "招聘方问题已分类";
}

function getProgressCardForJob(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const jobId = positiveInteger(input.jobId, "jobId");
  return mapCard(db.prepare(`SELECT * FROM candidate_progress_cards
    WHERE profile_id = ? AND job_id = ?`).get(profileId, jobId));
}

function getProgressCardById(db, cardId) {
  return getProgressCard(db, positiveInteger(cardId, "cardId"));
}

function listProgressCards(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const stages = Array.isArray(input.stages) ? [...new Set(input.stages.map(legalStage))] : [];
  const stageClause = stages.length ? ` AND stage IN (${stages.map(() => "?").join(", ")})` : "";
  return db.prepare(`SELECT * FROM candidate_progress_cards
    WHERE profile_id = ?${stageClause}
    ORDER BY updated_at DESC, id DESC`)
    .all(profileId, ...stages)
    .map(mapCard);
}

function listMessageDiscoveryCandidates(db, { profileId } = {}) {
  return db.prepare(`SELECT
      cards.id AS card_id,
      cards.profile_id,
      cards.job_id,
      cards.plan_id,
      cards.source,
      cards.stage,
      cards.thread_key,
      jobs.title,
      jobs.company,
      jobs.salary,
      jobs.location AS city
    FROM candidate_progress_cards cards
    JOIN jobs ON jobs.id = cards.job_id
    WHERE cards.profile_id = ?
      AND cards.source = 'boss'
      AND cards.stage NOT IN ('rejected', 'closed')
    ORDER BY cards.updated_at DESC, cards.id DESC`)
    .all(positiveInteger(profileId, "profileId"))
    .map(mapDiscoveryCandidate);
}

function listProgressCardsWithEvents(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const rows = db.prepare(`SELECT
      cards.*,
      events.id AS event_id,
      events.type AS event_type,
      events.actor AS event_actor,
      events.summary AS event_summary,
      events.metadata_json AS event_metadata_json,
      events.occurred_at AS event_occurred_at,
      events.created_at AS event_created_at
    FROM candidate_progress_cards cards
    LEFT JOIN candidate_progress_events events ON events.card_id = cards.id
    WHERE cards.profile_id = ?
    ORDER BY cards.updated_at DESC, cards.id DESC, events.occurred_at ASC, events.id ASC`)
    .all(profileId);
  const cards = new Map();
  for (const row of rows) {
    let card = cards.get(Number(row.id));
    if (!card) {
      card = { ...mapCard(row), events: [] };
      cards.set(card.id, card);
    }
    if (row.event_id) {
      card.events.push(mapEvent({
        id: row.event_id,
        card_id: row.id,
        type: row.event_type,
        actor: row.event_actor,
        summary: row.event_summary,
        metadata_json: row.event_metadata_json,
        occurred_at: row.event_occurred_at,
        created_at: row.event_created_at
      }));
    }
  }
  return [...cards.values()];
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

function getProgressEventByKey(db, cardId, idempotencyKey) {
  return mapEvent(db.prepare(`SELECT * FROM candidate_progress_events
    WHERE card_id = ? AND idempotency_key = ?`).get(cardId, idempotencyKey));
}

function assertEventIntent(event, expected, metadataKeys = null) {
  const scalarMatch = event.type === expected.type
    && event.actor === expected.actor
    && event.summary === expected.summary;
  const actualMetadata = event.metadata || {};
  const expectedMetadata = expected.metadata || {};
  const metadataMatch = metadataKeys
    ? metadataKeys.every((key) => actualMetadata[key] === expectedMetadata[key])
    : stableMetadata(actualMetadata) === stableMetadata(expectedMetadata);
  if (!scalarMatch || !metadataMatch) {
    throw progressError(
      "PROGRESS_IDEMPOTENCY_CONFLICT",
      "progress idempotency key was already used for a different operation"
    );
  }
}

function stableMetadata(value) {
  return JSON.stringify(Object.fromEntries(Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right))));
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

function mapDiscoveryCandidate(row) {
  return {
    cardId: Number(row.card_id),
    profileId: Number(row.profile_id),
    jobId: Number(row.job_id),
    planId: Number(row.plan_id),
    source: row.source,
    stage: row.stage,
    threadKey: row.thread_key || "",
    title: row.title || "",
    company: row.company || "",
    salary: row.salary || "",
    city: row.city || ""
  };
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

function progressIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!/^progress:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw progressError("PROGRESS_IDEMPOTENCY_KEY_INVALID", "progress idempotency key is required");
  }
  return key;
}

function communicationIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!/^communication:[1-9]\d*:[1-9]\d*:(succeeded|already_communicated)$/.test(key)) {
    throw progressError("PROGRESS_IDEMPOTENCY_KEY_INVALID", "communication idempotency key is invalid");
  }
  return key;
}

function safeDigestKey(value, name) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) {
    throw progressError("PROGRESS_SAFE_IDENTIFIER_INVALID", `${name} must be a SHA-256 digest`);
  }
  return normalized;
}

function safeMissingFactKey(value) {
  const key = String(value || "").trim();
  if (key && !/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
    throw progressError(
      "PROGRESS_MISSING_FACT_KEY_INVALID",
      "missing fact key must be a safe identifier"
    );
  }
  return key;
}

function safeDiscoveredNextAction(stage) {
  return {
    contact_started: "Review communication status",
    waiting_reply: "Wait for recruiter reply",
    needs_user_action: "Provide required information",
    reply_ready: "Review draft before manual send",
    interview_invited: "Review interview invitation",
    interview_scheduled: "Review interview schedule",
    resume_submitted: "Wait for recruiter reply",
    rejected: "Opportunity rejected",
    closed: "Opportunity closed"
  }[stage];
}

function messageIdempotencyKey(platform, messageKey) {
  if (platform !== "boss") {
    throw progressError("PROGRESS_PLATFORM_INVALID", "message platform is invalid");
  }
  return `message:boss:${safeDigestKey(messageKey, "messageKey").slice(7)}`;
}

function messageGroupIdempotencyKey(platform, messageGroupKey) {
  if (platform !== "boss") {
    throw progressError("PROGRESS_PLATFORM_INVALID", "message platform is invalid");
  }
  return `message-group:boss:${safeDigestKey(messageGroupKey, "messageGroupKey").slice(7)}`;
}

function normalizedMessageKeys(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw progressError("PROGRESS_MESSAGE_KEYS_REQUIRED", "message keys are required");
  }
  return [...new Set(value.map((item) => safeDigestKey(item, "messageKey")))];
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function progressError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  PROGRESS_STAGES,
  MESSAGE_CATEGORIES,
  TERMINAL_PROGRESS_STAGES,
  ensureProgressCard,
  recordProgressEvent,
  transitionProgressCard,
  correctProgressStage,
  recordVerifiedCommunicationStart,
  recordIncomingMessageClassification,
  recordDiscoveredMessageClassification,
  recordDiscoveredMessageGroupClassification,
  recordManualProgressAction,
  sanitizedMessageSummary,
  getProgressCardForJob,
  getProgressCardById,
  listMessageDiscoveryCandidates,
  listProgressCards,
  listProgressCardsWithEvents,
  listProgressEvents
};
