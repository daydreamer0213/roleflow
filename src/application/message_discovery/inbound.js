"use strict";

const crypto = require("node:crypto");
const {
  immediateTransaction,
  getActiveSearchPlan,
  getCandidateProfile,
  upsertJob
} = require("../../core/storage");
const {
  ensureProgressCard,
  transitionProgressCard,
  bindProgressCardThread,
  recordProgressEvent,
  getProgressCardForJob
} = require("../../core/candidate_progress");
const {
  listUnresolvedMessageDiscoveryItems,
  clearUnresolvedMessageDiscoveryItem,
  commitProcessedPreview
} = require("../../core/message_preview_state");

function resolveInboundOpportunity({ db, input = {}, now = () => new Date().toISOString() }) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const conversationKey = digest(input.conversationKey, "conversationKey");
  const previewDigest = digest(input.previewDigest, "previewDigest");
  const action = String(input.action || "").trim().toLowerCase();
  if (!["link", "create", "ignore"].includes(action)) {
    throw inboundError("INBOUND_ACTION_INVALID", "inbound action must be link, create, or ignore");
  }
  const unresolved = listUnresolvedMessageDiscoveryItems(db, { profileId })
    .find((item) => item.conversationKey === conversationKey);
  if (!unresolved) throw inboundError("INBOUND_ITEM_NOT_FOUND", "unresolved inbound item not found");
  if (unresolved.previewDigest !== previewDigest) {
    throw inboundError("INBOUND_PREVIEW_CHANGED", "inbound preview changed before resolution");
  }
  if ((action === "link" || action === "create")
    && (!normalized(unresolved.positionTitle) || !normalized(unresolved.company))) {
    throw inboundError("INBOUND_IDENTITY_INCOMPLETE", "inbound title and company are required");
  }
  const observedAt = iso(now());
  return immediateTransaction(db, () => {
    const current = listUnresolvedMessageDiscoveryItems(db, { profileId })
      .find((item) => item.conversationKey === conversationKey);
    if (!current) throw inboundError("INBOUND_ITEM_NOT_FOUND", "unresolved inbound item not found");
    if (current.previewDigest !== previewDigest || current.identityDigest !== unresolved.identityDigest) {
      throw inboundError("INBOUND_PREVIEW_CHANGED", "inbound identity changed before resolution");
    }
    if (action === "ignore") {
      settleInbound(db, { profileId, current, conversationKey, previewDigest, observedAt });
      db.prepare(`INSERT INTO events(job_id, event_type, payload_json, created_at)
        VALUES (NULL, 'message_inbound_ignored', ?, ?)`)
        .run(JSON.stringify({ profileId, conversationKey, previewDigest }), observedAt);
      return { profileId, action, unresolved: current, settled: true };
    }

    const profile = getCandidateProfile(db, profileId);
    if (!profile) throw inboundError("INBOUND_PROFILE_NOT_FOUND", "candidate profile was not found");
    const plan = getActiveSearchPlan(db, profileId);
    if (!plan) throw inboundError("INBOUND_ACTIVE_PLAN_REQUIRED", "an active plan is required for inbound opportunities");

    const job = action === "create"
      ? createInboundJob(db, current, conversationKey)
      : loadLinkableJob(db, { profileId, planId: plan.id, jobId: input.jobId, unresolved: current });
    let card = ensureProgressCard(db, {
      profileId,
      planId: plan.id,
      jobId: job.id,
      source: "boss",
      now: observedAt
    });
    card = bindProgressCardThread(db, {
      cardId: card.id,
      threadKey: conversationKey,
      now: observedAt
    });
    if (card.stage !== "needs_user_action") {
      card = transitionProgressCard(db, {
        cardId: card.id,
        expectedStage: card.stage,
        stage: "needs_user_action",
        nextAction: "核对 HR 主动联系并决定是否回复",
        now: observedAt
      });
    }
    recordProgressEvent(db, {
      cardId: card.id,
      idempotencyKey: `progress:${resolutionUuid(conversationKey, previewDigest)}`,
      type: action === "create" ? "inbound_opportunity_created" : "inbound_opportunity_linked",
      actor: "user",
      summary: action === "create" ? "保存 HR 主动机会" : "关联 HR 主动联系",
      metadata: {
        source: "message_discovery",
        platform: "boss",
        jobId: job.id,
        profileId,
        planId: plan.id,
        threadKey: conversationKey
      },
      occurredAt: observedAt
    });
    return { profileId, action, job, card, unresolved: current, settled: false };
  });
}

function createInboundJob(db, unresolved, conversationKey) {
  const sourceId = `inbound:${conversationKey.slice(7)}`;
  const id = upsertJob(db, {
    source: "boss",
    sourceId,
    keyword: "HR 主动联系",
    title: unresolved.positionTitle,
    company: unresolved.company,
    location: unresolved.city,
    salary: unresolved.salary,
    url: "",
    tags: ["hr_inbound"],
    description: "",
    score: 0,
    matches: [],
    risks: [],
    qualityTags: ["inbound_unassessed"],
    analysis: {}
  }, null);
  return mapJob(db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
}

function loadLinkableJob(db, { profileId, planId, jobId, unresolved }) {
  const id = positiveInteger(jobId, "jobId");
  const row = db.prepare(`SELECT jobs.*
    FROM jobs
    WHERE jobs.id = ?
      AND (
        EXISTS (
          SELECT 1 FROM candidate_progress_cards cards
          WHERE cards.profile_id = ? AND cards.job_id = jobs.id
        )
        OR EXISTS (
          SELECT 1 FROM job_observations observations
          JOIN batches ON batches.id = observations.batch_id
          WHERE observations.job_id = jobs.id
            AND batches.profile_id = ?
            AND batches.search_plan_id = ?
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM candidate_progress_cards cards
        WHERE cards.profile_id = ? AND cards.job_id = jobs.id
          AND cards.stage IN ('rejected', 'closed')
      )`)
    .get(id, profileId, profileId, planId, profileId);
  if (!row) throw inboundError("INBOUND_JOB_NOT_LINKABLE", "selected job is not linkable to this profile");
  if (normalized(row.title) !== normalized(unresolved.positionTitle)
    || normalized(row.company) !== normalized(unresolved.company)) {
    throw inboundError("INBOUND_JOB_IDENTITY_MISMATCH", "selected job does not match the inbound title and company");
  }
  const existing = getProgressCardForJob(db, { profileId, jobId: id });
  if (existing && ["rejected", "closed"].includes(existing.stage)) {
    throw inboundError("INBOUND_JOB_NOT_LINKABLE", "closed or rejected job cannot be linked");
  }
  return mapJob(row);
}

function settleInbound(db, { profileId, current, conversationKey, previewDigest, observedAt }) {
  commitProcessedPreview(db, {
    profileId,
    platform: "boss",
    conversationKey,
    previewDigest,
    previewKind: current.previewKind,
    observedAt
  });
  const cleared = clearUnresolvedMessageDiscoveryItem(db, {
    profileId,
    platform: "boss",
    conversationKey
  });
  if (!cleared) throw inboundError("INBOUND_ITEM_NOT_FOUND", "unresolved inbound item changed before completion");
}

function mapJob(row) {
  return {
    id: Number(row.id),
    source: row.source,
    sourceId: row.source_id,
    title: row.title,
    company: row.company || "",
    salary: row.salary || "",
    location: row.location || "",
    url: row.url || "",
    batchId: Number(row.batch_id || 0) || null
  };
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw inboundError("INBOUND_INPUT_INVALID", `${name} must be a positive integer`);
  }
  return number;
}

function digest(value, name) {
  const text = String(value || "").trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(text)) {
    throw inboundError("INBOUND_INPUT_INVALID", `${name} must be a SHA-256 digest`);
  }
  return text;
}

function resolutionUuid(conversationKey, previewDigest) {
  const hex = crypto.createHash("sha256")
    .update(`${digest(conversationKey, "conversationKey")}\0${digest(previewDigest, "previewDigest")}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function normalized(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function iso(value) {
  const text = String(value || "").trim();
  if (!Number.isFinite(Date.parse(text))) throw inboundError("INBOUND_TIME_INVALID", "inbound time must be ISO-compatible");
  return text;
}

function inboundError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { resolveInboundOpportunity };
