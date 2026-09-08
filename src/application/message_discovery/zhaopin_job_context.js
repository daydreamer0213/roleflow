"use strict";

const { getActiveSearchPlan } = require("../../core/storage");
const {
  ensureProgressCard,
  bindProgressCardThread,
  findMessageDiscoveryJobContext
} = require("../../core/candidate_progress");

function createZhaopinMessageJobContextResolver({ db, profileId, now = () => new Date().toISOString() } = {}) {
  const normalizedProfileId = positiveInteger(profileId, "profileId");
  if (!db) throw new TypeError("db is required");
  return async function resolveZhaopinMessageJobContext({ target } = {}) {
    const plan = getActiveSearchPlan(db, normalizedProfileId);
    if (!plan) throw contextError("MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE", "an active search plan is required");
    const sourceId = zhaopinSourceId(target?.sourceJobId);
    const context = findMessageDiscoveryJobContext(db, {
      profileId: normalizedProfileId,
      planId: plan.id,
      sourceId,
      platform: "zhaopin"
    });
    if (!context?.contextComplete || context.source !== "zhaopin") {
      throw contextError("MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE", "zhaopin job context is unavailable");
    }
    let card = ensureProgressCard(db, {
      profileId: normalizedProfileId,
      planId: context.planId,
      jobId: context.jobId,
      source: "zhaopin",
      now: now()
    });
    card = bindProgressCardThread(db, { cardId: card.id, threadKey: target?.conversationKey, now: now() });
    return { cardId: card.id, card, job: contextJob(context), threadKey: card.threadKey, contextSource: "local_cache" };
  };
}

function zhaopinSourceId(value) {
  const sourceId = String(value || "").trim();
  if (!/^zhaopin:[A-Za-z0-9]{1,160}$/.test(sourceId)) {
    throw contextError("MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE", "zhaopin job identity is invalid");
  }
  return sourceId;
}

function contextJob(context) {
  return {
    id: context.jobId, source: context.source, sourceId: context.sourceId,
    title: context.title, company: context.company, salary: context.salary,
    location: context.city, experience: context.experience, education: context.education,
    bossActiveText: context.bossActiveText, url: context.url, tags: context.tags,
    description: context.description, qualityTags: context.qualityTags,
    analysis: context.analysis, observationId: context.observationId, batchId: context.batchId
  };
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer`);
  return number;
}

function contextError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { createZhaopinMessageJobContextResolver };
