"use strict";

const { createHash } = require("node:crypto");
const {
  getSearchPlan,
  listFunnelEntries,
  listFunnelProgressEvents,
  listDecisionPool,
  listOpenMessageReplyDrafts,
  listMessageInboundContexts,
  closeOpenMessageReplyDraftsByIntent,
  saveMessageInboundContext,
  recordMessageReplyDrafts
} = require("../../core/storage");
const { getProgressCardForJob } = require("../../core/candidate_progress");
const { canonicalBossJobSourceId } = require("../../core/boss_job_identity");
const { projectMessageFollowUpCandidate } = require("../../core/message_follow_up");
const { immediateTransaction } = require("../../storage/storage_shared");
const {
  generateQualityCheckedDraft,
  buildMessageDraftQualityContext
} = require("../message_draft_quality");

const ACTIVE_SEND_STATUSES = ["pending", "selecting", "verified", "filled", "click_dispatched", "ambiguous"];
const MAX_TEXT = 4000;

function createMessageFollowUpService({ db, generateDraft, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("db is required");
  if (typeof generateDraft !== "function") throw new TypeError("generateDraft is required");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const qualityWarnings = new Map();

  function listCandidates({ profileId, planId } = {}) {
    const owner = ownedPlan(db, profileId, planId);
    const entries = listFunnelEntries(db, { profileId: owner.profileId, planId: owner.planId });
    if (!entries.length) return [];
    const events = listFunnelProgressEvents(db, {
      profileId: owner.profileId,
      entryIds: entries.map((entry) => entry.id)
    });
    const eventsByEntry = grouped(events, (event) => event.entryId);
    const jobsById = new Map(listDecisionPool(db, { planId: owner.planId })
      .map((job) => [Number(job.id), normalizeJob(job)]));
    const draftsByCard = grouped(
      listOpenMessageReplyDrafts(db, { profileId: owner.profileId, limit: 500 })
        .filter((draft) => draft.messageIntent === "follow_up"),
      (draft) => draft.cardId
    );
    const contextsByGroup = new Map(listMessageInboundContexts(db, {
      profileId: owner.profileId,
      limit: 500
    }).map((context) => [context.messageGroupKey, context]));
    const sentCards = queryCardIds(db, `SELECT DISTINCT cards.id
      FROM candidate_progress_cards cards
      JOIN candidate_progress_events events ON events.card_id = cards.id
      WHERE cards.profile_id = ? AND events.type = 'follow_up_sent'`, [owner.profileId]);
    const activeCards = queryCardIds(db, `SELECT DISTINCT drafts.card_id AS id
      FROM message_reply_drafts drafts
      JOIN message_reply_send_items items ON items.draft_id = drafts.id
      JOIN message_reply_send_batches batches ON batches.id = items.batch_id
      WHERE drafts.profile_id = ? AND batches.profile_id = ?
        AND drafts.message_intent = 'follow_up'
        AND items.status IN (${ACTIVE_SEND_STATUSES.map(() => "?").join(",")})`,
    [owner.profileId, owner.profileId, ...ACTIVE_SEND_STATUSES]);
    const currentTime = isoText(now(), "now");
    const candidates = [];
    for (const entry of entries) {
      const job = jobsById.get(entry.jobId);
      const card = job ? getProgressCardForJob(db, { profileId: owner.profileId, jobId: entry.jobId }) : null;
      if (!job || !card || card.planId !== owner.planId) continue;
      const entryEvents = eventsByEntry.get(entry.id) || [];
      const followUpDrafts = draftsByCard.get(card.id) || [];
      const draft = followUpDrafts[0] || null;
      const projection = projectMessageFollowUpCandidate({
        entry,
        events: entryEvents,
        job,
        card,
        hasSentFollowUp: sentCards.has(card.id),
        hasActiveFollowUp: activeCards.has(card.id),
        now: currentTime
      });
      if (!projection.eligible) continue;
      candidates.push({
        profileId: owner.profileId,
        planId: owner.planId,
        jobId: entry.jobId,
        entry,
        events: entryEvents,
        job,
        card,
        projection,
        draft,
        context: draft ? contextsByGroup.get(draft.messageGroupKey) || null : null,
        followUpDrafts,
        draftQualityWarnings: qualityWarnings.get(qualityKey(owner.profileId, entry.jobId)) || []
      });
    }
    return candidates.sort((left, right) => right.projection.waitedHours - left.projection.waitedHours
      || left.entry.id - right.entry.id);
  }

  function requireCandidate(input = {}) {
    const jobId = positiveInteger(input.jobId, "jobId");
    const candidate = listCandidates(input).find((item) => item.jobId === jobId);
    if (!candidate) {
      throw followUpError("FOLLOW_UP_NOT_ELIGIBLE", "当前岗位不再满足首次跟进条件");
    }
    return candidate;
  }

  async function savePreparedDraft({ profileId, planId, jobId, snapshot } = {}) {
    const candidate = requireCandidate({ profileId, planId, jobId });
    const baseline = normalizeSnapshot(candidate, snapshot);
    const existing = matchingDraft(candidate, baseline);
    if (existing) return preparedResult(
      candidate,
      existing.draft,
      existing.context,
      baseline.previousOutboundText,
      qualityWarnings.get(qualityKey(candidate.profileId, candidate.jobId)) || []
    );

    const checked = await generateQualityCheckedDraft({
      generate: (qualityInput) => generateDraft({
        candidate,
        previousOutboundText: baseline.previousOutboundText,
        ...(qualityInput.draftQualityRevision
          ? { draftQualityRevision: qualityInput.draftQualityRevision }
          : {})
      }),
      shouldAssess: (result) => !result?.missingFact,
      ...buildMessageDraftQualityContext(db, {
        profileId: candidate.profileId,
        job: candidate.job,
        messageTexts: []
      })
    });
    if (!checked.sendable) {
      throw followUpError("FOLLOW_UP_DRAFT_FACT_REQUIRED", "草稿里有系统找不到依据的个人信息，请修改后再发送");
    }
    const message = generatedMessage(checked.result);
    const warningCodes = qualityWarningCodes(checked.assessment);
    const preparedAt = isoText(now(), "now");

    const prepared = immediateTransaction(db, () => {
      const current = requireCandidate({ profileId, planId, jobId });
      normalizeSnapshot(current, baseline);
      const repeated = matchingDraft(current, baseline);
      if (repeated) return preparedResult(
        current,
        repeated.draft,
        repeated.context,
        baseline.previousOutboundText,
        qualityWarnings.get(qualityKey(current.profileId, current.jobId)) || []
      );
      closeOpenMessageReplyDraftsByIntent(db, {
        profileId: current.profileId,
        cardId: current.card.id,
        messageIntent: "follow_up",
        closedAt: preparedAt
      });
      const messageGroupKey = followUpGroupKey({
        profileId: current.profileId,
        cardId: current.card.id,
        conversationKey: baseline.conversationKey,
        lastMessageId: baseline.lastMessageId
      });
      const context = saveMessageInboundContext(db, {
        profileId: current.profileId,
        cardId: current.card.id,
        messageGroupKey,
        conversationKey: baseline.conversationKey,
        sourceJobId: baseline.sourceJobId,
        lastMessageId: baseline.lastMessageId,
        messageIntent: "follow_up",
        messageCategory: "other",
        inboundMessages: [{ kind: "text", text: baseline.previousOutboundText }],
        manualActions: [],
        createdAt: preparedAt,
        updatedAt: preparedAt
      });
      const draft = recordMessageReplyDrafts(db, {
        profileId: current.profileId,
        cardId: current.card.id,
        jobId: current.jobId,
        messageGroupKey,
        questionSummary: "该岗位已等待回复，可以礼貌跟进。",
        messageIntent: "follow_up",
        messageCategory: "other",
        messages: [message],
        createdAt: preparedAt
      })[0];
      return preparedResult(current, draft, context, baseline.previousOutboundText, warningCodes);
    });
    qualityWarnings.set(qualityKey(candidate.profileId, candidate.jobId), prepared.draftQualityWarnings);
    return prepared;
  }

  return { listCandidates, requireCandidate, savePreparedDraft };
}

function matchingDraft(candidate, baseline) {
  for (const draft of candidate.followUpDrafts || []) {
    const context = candidate.context?.messageGroupKey === draft.messageGroupKey
      ? candidate.context
      : null;
    if (context
      && context.conversationKey === baseline.conversationKey
      && context.sourceJobId === baseline.sourceJobId
      && context.lastMessageId === baseline.lastMessageId) {
      return { draft, context };
    }
  }
  return null;
}

function preparedResult(candidate, draft, context, previousOutboundText, draftQualityWarnings = []) {
  return { candidate, draft, context, previousOutboundText, draftQualityWarnings };
}

function qualityKey(profileId, jobId) {
  return `${Number(profileId)}:${Number(jobId)}`;
}

function qualityWarningCodes(assessment = {}) {
  return Array.isArray(assessment.warnings)
    && assessment.warnings.some((warning) => warning?.code === "MESSAGE_DRAFT_RECENTLY_SIMILAR")
    ? ["MESSAGE_DRAFT_RECENTLY_SIMILAR"]
    : [];
}

function normalizeSnapshot(candidate, value) {
  const snapshot = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const conversationKey = digestKey(snapshot.conversationKey, "conversationKey");
  const sourceJobId = canonicalBossJobSourceId(snapshot.sourceJobId);
  const lastMessageId = String(snapshot.lastMessageId || "");
  const previousOutboundText = exactText(snapshot.previousOutboundText, "previousOutboundText");
  if (snapshot.lastMessageDirection !== "myself"
    || conversationKey !== candidate.card.threadKey
    || !sourceJobId
    || sourceJobId !== candidate.job.sourceId
    || !/^\d{15}$/.test(lastMessageId)) {
    throw followUpError("FOLLOW_UP_CONVERSATION_CHANGED", "会话出现变化，请先重新读取消息");
  }
  return { conversationKey, sourceJobId, lastMessageId, lastMessageDirection: "myself", previousOutboundText };
}

function generatedMessage(result) {
  if (result?.missingFact) {
    throw followUpError("FOLLOW_UP_DRAFT_FACT_REQUIRED", "缺少生成跟进草稿所需的候选人事实");
  }
  const message = exactText(Array.isArray(result?.messages) ? result.messages[0] : "", "generated message");
  return message;
}

function followUpGroupKey({ profileId, cardId, conversationKey, lastMessageId }) {
  return `sha256:${createHash("sha256")
    .update(["follow_up", profileId, cardId, conversationKey, lastMessageId].join("\0"))
    .digest("hex")}`;
}

function normalizeJob(job) {
  return { ...job, sourceId: canonicalBossJobSourceId(job.sourceId), archived: job.archived === true };
}

function ownedPlan(db, profileId, planId) {
  const profile = positiveInteger(profileId, "profileId");
  const plan = positiveInteger(planId, "planId");
  const stored = getSearchPlan(db, plan);
  if (!stored || Number(stored.profileId) !== profile) {
    throw followUpError("FOLLOW_UP_NOT_ELIGIBLE", "当前求职方案不属于所选候选人");
  }
  return { profileId: profile, planId: plan };
}

function grouped(items, keyOf) {
  const result = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(item);
  }
  return result;
}

function queryCardIds(db, sql, params) {
  return new Set(db.prepare(sql).all(...params).map((row) => Number(row.id)));
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw followUpError("FOLLOW_UP_NOT_ELIGIBLE", `${label} 无效`);
  }
  return number;
}

function digestKey(value, label) {
  const text = String(value || "").trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(text)) {
    throw followUpError("FOLLOW_UP_CONVERSATION_CHANGED", `${label} 无效`);
  }
  return text;
}

function exactText(value, label) {
  const text = String(value == null ? "" : value).replace(/\r\n?/g, "\n").trim();
  if (!text || text.length > MAX_TEXT) {
    throw followUpError("FOLLOW_UP_DRAFT_UNAVAILABLE", `${label} 无效`);
  }
  return text;
}

function isoText(value, label) {
  const text = String(value || "").trim();
  if (!Number.isFinite(Date.parse(text))) {
    throw followUpError("FOLLOW_UP_TIME_INVALID", `${label} 必须是有效时间`);
  }
  return new Date(Date.parse(text)).toISOString();
}

function followUpError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { createMessageFollowUpService, followUpGroupKey };
