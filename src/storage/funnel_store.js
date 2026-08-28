const crypto = require("node:crypto");
const {
  feedbackMaturesAt,
  normalizeFunnelSamplePolicy
} = require("../core/funnel_maturity");
const { immediateTransaction, parseJson } = require("./storage_shared");

const SOURCE_KINDS = new Set(["applied", "communication", "reply_sent"]);

function getFunnelPolicy(db, { profileId } = {}) {
  const profile = ownedProfile(db, profileId);
  const row = db.prepare("SELECT * FROM candidate_funnel_policies WHERE profile_id = ?").get(profile);
  return row ? mapPolicy(row) : {
    profileId: profile,
    ...normalizeFunnelSamplePolicy(),
    updatedAt: null
  };
}

function saveFunnelPolicy(db, input = {}) {
  const profileId = ownedProfile(db, input.profileId);
  const policy = normalizeFunnelSamplePolicy(input);
  const updatedAt = isoText(input.updatedAt, "updatedAt");
  return inTransaction(db, () => {
    db.prepare(`INSERT INTO candidate_funnel_policies(
      profile_id, preliminary_sample_target, comparable_sample_target,
      formal_sample_target, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET
      preliminary_sample_target = excluded.preliminary_sample_target,
      comparable_sample_target = excluded.comparable_sample_target,
      formal_sample_target = excluded.formal_sample_target,
      updated_at = excluded.updated_at`)
      .run(
        profileId,
        policy.preliminarySampleTarget,
        policy.comparableSampleTarget,
        policy.formalSampleTarget,
        updatedAt
      );
    return getFunnelPolicy(db, { profileId });
  });
}

function ensureFunnelEntry(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const jobId = positiveInteger(input.jobId, "jobId");
  const existing = getFunnelEntry(db, { profileId, jobId });
  if (existing) return existing;
  const sourceKind = String(input.sourceKind || "").trim();
  if (!SOURCE_KINDS.has(sourceKind)) throw new Error("funnel source kind is invalid");
  const startedAt = isoText(input.startedAt, "startedAt");

  return inTransaction(db, () => {
    ownedProfile(db, profileId);
    if (!db.prepare("SELECT id FROM jobs WHERE id = ?").get(jobId)) throw new Error("funnel job not found");
    const card = optionalCard(db, input.cardId, { profileId, jobId });
    const planId = resolvePlanId(db, input.planId || card?.plan_id, profileId);
    const context = contactContext(db, { profileId, planId, jobId, startedAt });
    const result = db.prepare(`INSERT OR IGNORE INTO candidate_funnel_entries(
      profile_id, job_id, card_id, cohort_id, plan_id, source_kind,
      started_at, mature_at, direction_key, decision_bucket,
      resume_version_id, greeting_key, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        profileId,
        jobId,
        card ? Number(card.id) : null,
        planId,
        sourceKind,
        startedAt,
        feedbackMaturesAt(startedAt),
        context.directionKey,
        context.decisionBucket,
        context.resumeVersionId,
        context.greetingKey,
        startedAt,
        startedAt
      );
    if (Number(result.changes) !== 1) {
      const repeated = getFunnelEntry(db, { profileId, jobId });
      if (repeated) return repeated;
      throw new Error("funnel entry could not be persisted");
    }
    return getFunnelEntry(db, { profileId, jobId });
  });
}

function getFunnelEntry(db, { profileId, jobId } = {}) {
  const profile = positiveInteger(profileId, "profileId");
  const job = positiveInteger(jobId, "jobId");
  return mapEntry(db.prepare(`SELECT * FROM candidate_funnel_entries
    WHERE profile_id = ? AND job_id = ?`).get(profile, job));
}

function listFunnelEntries(db, { profileId, cohortId, unassignedOnly = false } = {}) {
  const clauses = ["profile_id = ?"];
  const params = [positiveInteger(profileId, "profileId")];
  if (cohortId !== undefined && cohortId !== null && cohortId !== "") {
    clauses.push("cohort_id = ?");
    params.push(positiveInteger(cohortId, "cohortId"));
  } else if (unassignedOnly) {
    clauses.push("cohort_id IS NULL");
  }
  return db.prepare(`SELECT * FROM candidate_funnel_entries
    WHERE ${clauses.join(" AND ")}
    ORDER BY started_at, id`).all(...params).map(mapEntry);
}

function freezeReadyFunnelCohort(db, { profileId, now = new Date().toISOString() } = {}) {
  const profile = ownedProfile(db, profileId);
  const frozenAt = isoText(now, "now");
  return inTransaction(db, () => {
    const policy = getFunnelPolicy(db, { profileId: profile });
    const entries = db.prepare(`SELECT * FROM candidate_funnel_entries
      WHERE profile_id = ? AND cohort_id IS NULL AND mature_at <= ?
      ORDER BY started_at, id`).all(profile, frozenAt);
    if (entries.length < policy.formalSampleTarget) return null;
    const result = db.prepare(`INSERT INTO candidate_funnel_cohorts(
      profile_id, preliminary_sample_target, comparable_sample_target,
      formal_sample_target, sample_count, started_at, ended_at, frozen_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        profile,
        policy.preliminarySampleTarget,
        policy.comparableSampleTarget,
        policy.formalSampleTarget,
        entries.length,
        entries[0].started_at,
        entries[entries.length - 1].started_at,
        frozenAt,
        frozenAt
      );
    const cohortId = Number(result.lastInsertRowid);
    const attach = db.prepare(`UPDATE candidate_funnel_entries
      SET cohort_id = ?, updated_at = ?
      WHERE id = ? AND profile_id = ? AND cohort_id IS NULL`);
    for (const entry of entries) {
      if (Number(attach.run(cohortId, frozenAt, entry.id, profile).changes) !== 1) {
        throw new Error("funnel cohort membership changed concurrently");
      }
    }
    return getFunnelCohort(db, { profileId: profile, cohortId });
  });
}

function listFunnelCohorts(db, { profileId, limit = 20 } = {}) {
  const profile = positiveInteger(profileId, "profileId");
  const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 20));
  return db.prepare(`SELECT * FROM candidate_funnel_cohorts
    WHERE profile_id = ? ORDER BY frozen_at DESC, id DESC LIMIT ?`)
    .all(profile, boundedLimit).map(mapCohort);
}

function getFunnelCohort(db, { profileId, cohortId } = {}) {
  const profile = positiveInteger(profileId, "profileId");
  const id = positiveInteger(cohortId, "cohortId");
  const cohort = mapCohort(db.prepare(`SELECT * FROM candidate_funnel_cohorts
    WHERE id = ? AND profile_id = ?`).get(id, profile));
  return cohort ? {
    ...cohort,
    entries: listFunnelEntries(db, { profileId: profile, cohortId: id })
  } : null;
}

function listFunnelProgressEvents(db, { profileId, entryIds = [] } = {}) {
  const profile = positiveInteger(profileId, "profileId");
  const ids = [...new Set(entryIds.map((value) => positiveInteger(value, "entryId")))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const owners = db.prepare(`SELECT id FROM candidate_funnel_entries
    WHERE profile_id = ? AND id IN (${placeholders})`).all(profile, ...ids);
  if (owners.length !== ids.length) throw new Error("funnel entry does not belong to the profile");

  const progress = db.prepare(`SELECT entries.id AS entry_id, events.*
    FROM candidate_funnel_entries entries
    JOIN candidate_progress_events events ON events.card_id = entries.card_id
    WHERE entries.profile_id = ? AND entries.id IN (${placeholders})
      AND events.occurred_at >= entries.started_at`)
    .all(profile, ...ids).map((row) => ({
      entryId: Number(row.entry_id),
      eventId: `progress:${Number(row.id)}`,
      type: row.type,
      actor: row.actor,
      metadata: parseJson(row.metadata_json, {}),
      occurredAt: row.occurred_at
    }));
  const jobEvents = db.prepare(`SELECT entries.id AS entry_id, events.id, events.event_type, events.created_at
    FROM candidate_funnel_entries entries
    JOIN candidate_job_events events
      ON events.profile_id = entries.profile_id AND events.job_id = entries.job_id
    WHERE entries.profile_id = ? AND entries.id IN (${placeholders})
      AND events.created_at >= entries.started_at`)
    .all(profile, ...ids).map((row) => ({
      entryId: Number(row.entry_id),
      eventId: `job:${Number(row.id)}`,
      type: candidateJobEventType(row.event_type),
      actor: "user",
      metadata: { source: "user_record" },
      occurredAt: row.created_at
    }));
  return [...progress, ...jobEvents]
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
      || left.eventId.localeCompare(right.eventId));
}

function contactContext(db, { profileId, planId, jobId, startedAt }) {
  const observation = db.prepare(`SELECT observations.keyword, observations.analysis_json, observations.greeting
    FROM job_observations observations
    JOIN batches ON batches.id = observations.batch_id
    WHERE observations.job_id = ? AND batches.profile_id = ? AND observations.seen_at <= ?
      AND (? IS NULL OR batches.search_plan_id = ?)
    ORDER BY observations.seen_at DESC, observations.id DESC LIMIT 1`)
    .get(jobId, profileId, startedAt, planId, planId);
  const plan = planId
    ? db.prepare("SELECT plan_json FROM search_plans WHERE id = ? AND profile_id = ?").get(planId, profileId)
    : db.prepare(`SELECT plan_json FROM search_plans
      WHERE profile_id = ? AND is_active = 1
      ORDER BY updated_at DESC, id DESC LIMIT 1`).get(profileId);
  const planJson = parseJson(plan?.plan_json, {});
  const source = observation || { keyword: planJson.directions?.[0] };
  const resume = db.prepare(`SELECT id FROM candidate_resume_versions
    WHERE profile_id = ? AND is_active = 1 AND created_at <= ? AND updated_at <= ?
    ORDER BY updated_at DESC, id DESC LIMIT 1`).get(profileId, startedAt, startedAt);
  return {
    directionKey: shortText(source.keyword || planJson.directions?.[0], 160),
    decisionBucket: decisionBucket(parseJson(source.analysis_json, {})),
    resumeVersionId: resume ? Number(resume.id) : null,
    greetingKey: digestText(source.greeting)
  };
}

function optionalCard(db, cardId, { profileId, jobId }) {
  if (cardId === undefined || cardId === null || cardId === "") return null;
  const card = db.prepare(`SELECT id, profile_id, plan_id, job_id FROM candidate_progress_cards
    WHERE id = ?`).get(positiveInteger(cardId, "cardId"));
  if (!card || Number(card.profile_id) !== profileId || Number(card.job_id) !== jobId) {
    throw new Error("funnel card does not belong to the profile and job");
  }
  return card;
}

function resolvePlanId(db, value, profileId) {
  if (value === undefined || value === null || value === "") return null;
  const planId = positiveInteger(value, "planId");
  const plan = db.prepare("SELECT profile_id FROM search_plans WHERE id = ?").get(planId);
  if (!plan || Number(plan.profile_id) !== profileId) throw new Error("funnel plan does not belong to the profile");
  return planId;
}

function ownedProfile(db, value) {
  const profileId = positiveInteger(value, "profileId");
  if (!db.prepare("SELECT id FROM candidate_profiles WHERE id = ?").get(profileId)) {
    throw new Error("funnel profile not found");
  }
  return profileId;
}

function mapPolicy(row) {
  return {
    profileId: Number(row.profile_id),
    preliminarySampleTarget: Number(row.preliminary_sample_target),
    comparableSampleTarget: Number(row.comparable_sample_target),
    formalSampleTarget: Number(row.formal_sample_target),
    updatedAt: row.updated_at
  };
}

function mapEntry(row) {
  return row ? {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    jobId: Number(row.job_id),
    cardId: Number(row.card_id || 0) || null,
    cohortId: Number(row.cohort_id || 0) || null,
    planId: Number(row.plan_id || 0) || null,
    sourceKind: row.source_kind,
    startedAt: row.started_at,
    matureAt: row.mature_at,
    directionKey: row.direction_key || "",
    decisionBucket: row.decision_bucket || "",
    resumeVersionId: Number(row.resume_version_id || 0) || null,
    greetingKey: row.greeting_key || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

function mapCohort(row) {
  return row ? {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    preliminarySampleTarget: Number(row.preliminary_sample_target),
    comparableSampleTarget: Number(row.comparable_sample_target),
    formalSampleTarget: Number(row.formal_sample_target),
    sampleCount: Number(row.sample_count),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    frozenAt: row.frozen_at,
    createdAt: row.created_at
  } : null;
}

function decisionBucket(analysis) {
  const value = String(analysis?.decisionBucket || analysis?.recommendation || "").trim().toLowerCase();
  if (["primary", "main", "strong_recommend"].includes(value)) return "primary";
  if (["apply", "recommended", "recommend"].includes(value)) return "apply";
  if (["caution", "conditional"].includes(value)) return "caution";
  if (["not_recommended", "reject", "blocked"].includes(value)) return "not_recommended";
  return "";
}

function candidateJobEventType(value) {
  return {
    applied: "application_recorded",
    interview: "interview_invited",
    rejected: "rejected",
    invalid: "opportunity_closed"
  }[String(value || "")] || `job_status_${shortText(value, 40)}`;
}

function digestText(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text ? `sha256:${crypto.createHash("sha256").update(text).digest("hex")}` : "";
}

function inTransaction(db, work) {
  return db.isTransaction ? work() : immediateTransaction(db, work);
}

function isoText(value, name) {
  const text = String(value || "").trim();
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${name} must be ISO-compatible`);
  return new Date(Date.parse(text)).toISOString();
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function shortText(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

module.exports = {
  getFunnelPolicy,
  saveFunnelPolicy,
  ensureFunnelEntry,
  getFunnelEntry,
  listFunnelEntries,
  freezeReadyFunnelCohort,
  listFunnelCohorts,
  getFunnelCohort,
  listFunnelProgressEvents
};
