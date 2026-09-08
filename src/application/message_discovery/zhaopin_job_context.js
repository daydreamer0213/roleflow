"use strict";

const { createBatch, upsertJob, getActiveSearchPlan, immediateTransaction } = require("../../core/storage");
const { ensureProgressCard, bindProgressCardThread, findMessageDiscoveryJobContext } = require("../../core/candidate_progress");
const { retryOneJobAnalysis } = require("../analysis");

function createZhaopinMessageJobContextResolver({
  db, profileId, messageReader = null, detailReader = null, analyzeJob = retryOneJobAnalysis,
  modelConfig = null, root = process.cwd(), logger = null, analysisDeps = {}, now = () => new Date().toISOString()
} = {}) {
  const normalizedProfileId = positiveInteger(profileId, "profileId");
  if (!db) throw new TypeError("db is required");
  const liveReaders = Boolean(messageReader || detailReader);
  if (liveReaders && (typeof messageReader?.readSelectedJobTarget !== "function"
    || typeof detailReader?.readSelectedJobDetail !== "function")) {
    throw new TypeError("zhaopin message and detail readers are required together");
  }
  if (typeof analyzeJob !== "function") throw new TypeError("analyzeJob is required");

  return async function resolveZhaopinMessageJobContext({ target, selected, signal = null } = {}) {
    const plan = activePlan();
    const sourceId = zhaopinSourceId(target?.sourceJobId);
    let jobTarget = liveReaders ? await verifySelectedTarget(sourceId, selected, signal) : null;
    let context = findContext(plan.id, sourceId);
    if (context?.contextComplete && context.source === "zhaopin") {
      if (liveReaders) {
        assertSameActivePlan(plan.id);
        jobTarget = await verifySelectedTarget(sourceId, selected, signal);
        assertSameActivePlan(plan.id);
        annotateAvailability(context, jobTarget.availability);
        context = findContext(plan.id, sourceId);
      }
      throwIfAborted(signal);
      return bindContext(context, target?.conversationKey, "local_cache", signal);
    }
    if (!liveReaders) throw contextError("MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE", "zhaopin job context is unavailable");

    const detail = trustedDetail(await detailReader.readSelectedJobDetail({
      communicationTabId: target?.tabId, selected, jobTarget, signal
    }), jobTarget);
    throwIfAborted(signal);
    assertSameActivePlan(plan.id);
    jobTarget = await verifySelectedTarget(sourceId, selected, signal);
    assertSameActivePlan(plan.id);
    throwIfAborted(signal);
    const availability = detail.availability === "offline" || jobTarget.availability === "offline" ? "offline" : "unknown";
    const batchId = createBatch(db, "zhaopin", "message-discovery-detail", "message discovery detail", {
      profileId: normalizedProfileId,
      searchPlanId: plan.id,
      filterSnapshot: { mode: "message-discovery-detail", sourceId: detail.sourceId }
    });
    throwIfAborted(signal);
    const jobId = upsertJob(db, {
      ...detail,
      source: "zhaopin",
      keyword: "message-discovery-detail",
      url: detail.canonicalUrl,
      qualityTags: [],
      analysis: {
        provider: "message-discovery-detail",
        semanticStatus: "pending",
        decisionSource: "analysis_pending",
        recommendation: null,
        sourceAvailability: availability
      }
    }, batchId);
    throwIfAborted(signal);
    await analyzeJob({
      db,
      input: { planId: plan.id, jobId },
      deps: { root, logger, modelReady: Boolean(modelConfig), modelConfig, ...analysisDeps, messageContextAnalysis: true, signal }
    });
    throwIfAborted(signal);
    assertSameActivePlan(plan.id);
    jobTarget = await verifySelectedTarget(sourceId, selected, signal);
    assertSameActivePlan(plan.id);
    throwIfAborted(signal);
    context = findContext(plan.id, detail.sourceId);
    if (!context?.contextComplete || context.source !== "zhaopin") {
      throw contextError("MESSAGE_DISCOVERY_JOB_ANALYSIS_INCOMPLETE", "zhaopin job analysis is incomplete");
    }
    annotateAvailability(context, availability === "offline" || jobTarget.availability === "offline" ? "offline" : "unknown");
    context = findContext(plan.id, detail.sourceId);
    throwIfAborted(signal);
    return bindContext(context, target?.conversationKey, "message_discovery_detail", signal);
  };

  function activePlan() {
    const plan = getActiveSearchPlan(db, normalizedProfileId);
    if (!plan) throw contextError("MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE", "an active search plan is required");
    return plan;
  }

  function assertSameActivePlan(planId) {
    const current = getActiveSearchPlan(db, normalizedProfileId);
    if (!current || current.id !== planId) {
      throw contextError("MESSAGE_DISCOVERY_ACTIVE_PLAN_CHANGED", "active search plan changed during zhaopin context resolution");
    }
  }

  async function verifySelectedTarget(expectedSourceId, selected, signal) {
    throwIfAborted(signal);
    const value = trustedJobTarget(await messageReader.readSelectedJobTarget(selected, signal));
    if (value.jobId !== expectedSourceId) {
      throw contextError("MESSAGE_DISCOVERY_JOB_TARGET_MISMATCH", "selected zhaopin job identity changed");
    }
    return value;
  }

  function findContext(planId, sourceId) {
    return findMessageDiscoveryJobContext(db, { profileId: normalizedProfileId, planId, sourceId, platform: "zhaopin" });
  }

  function annotateAvailability(context, availability) {
    const value = availability === "offline" ? "offline" : "unknown";
    if (context.analysis?.sourceAvailability === value) return;
    immediateTransaction(db, () => {
      db.prepare(`UPDATE job_observations
        SET analysis_json = json_set(CASE WHEN json_valid(analysis_json) THEN analysis_json ELSE '{}' END, '$.sourceAvailability', ?)
        WHERE id = ? AND job_id = ? AND EXISTS (
          SELECT 1 FROM batches WHERE batches.id = job_observations.batch_id
            AND batches.profile_id = ? AND batches.search_plan_id = ?
        )`).run(value, context.observationId, context.jobId, normalizedProfileId, context.planId);
      db.prepare(`UPDATE jobs
        SET analysis_json = json_set(CASE WHEN json_valid(analysis_json) THEN analysis_json ELSE '{}' END, '$.sourceAvailability', ?)
        WHERE id = ? AND source = 'zhaopin' AND source_id = ?`).run(value, context.jobId, context.sourceId);
    });
  }

  function bindContext(context, threadKey, contextSource, signal) {
    throwIfAborted(signal);
    const occurredAt = now();
    let card = ensureProgressCard(db, {
      profileId: normalizedProfileId, planId: context.planId, jobId: context.jobId, source: "zhaopin", now: occurredAt
    });
    throwIfAborted(signal);
    card = bindProgressCardThread(db, { cardId: card.id, threadKey, now: occurredAt });
    return { cardId: card.id, card, job: contextJob(context), threadKey: card.threadKey, contextSource };
  }
}

function zhaopinSourceId(value) {
  const sourceId = String(value || "").trim();
  if (!/^zhaopin:[A-Za-z0-9]{1,160}$/.test(sourceId)) {
    throw contextError("MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE", "zhaopin job identity is invalid");
  }
  return sourceId.slice("zhaopin:".length);
}

function trustedJobTarget(value) {
  const jobId = String(value?.jobId || "").trim();
  let navigation;
  let canonical;
  try { navigation = new URL(String(value?.navigationUrl || "")); canonical = new URL(String(value?.canonicalUrl || "")); }
  catch { throw contextError("MESSAGE_DISCOVERY_JOB_TARGET_INVALID", "zhaopin job target is invalid"); }
  if (!/^[A-Za-z0-9]{1,160}$/.test(jobId)
    || navigation.origin !== "https://www.zhaopin.com" || canonical.origin !== "https://www.zhaopin.com"
    || ![`/jobdetail/${jobId}.htm`, `/jobdetail/${jobId}.html`].includes(navigation.pathname)
    || canonical.pathname !== `/jobdetail/${jobId}.htm`
    || navigation.search || navigation.hash || canonical.search || canonical.hash
    || navigation.username || navigation.password || canonical.username || canonical.password) {
    throw contextError("MESSAGE_DISCOVERY_JOB_TARGET_INVALID", "zhaopin job target is invalid");
  }
  return { jobId, navigationUrl: navigation.toString(), canonicalUrl: canonical.toString(), availability: value.availability === "offline" ? "offline" : "unknown" };
}

function trustedDetail(value, target) {
  const sourceId = String(value?.sourceId || "").trim();
  const description = String(value?.description || "").replace(/\s+/g, " ").trim();
  if (value?.source !== "zhaopin" || sourceId !== target.jobId) {
    throw contextError("MESSAGE_DISCOVERY_JOB_TARGET_MISMATCH", "zhaopin job detail target does not match");
  }
  const expectedUrl = `https://www.zhaopin.com/jobdetail/${sourceId}.htm`;
  if (String(value?.canonicalUrl || "") !== expectedUrl) {
    throw contextError("MESSAGE_DISCOVERY_JOB_URL_INVALID", "zhaopin job detail URL is invalid");
  }
  if (!boundedText(value.title, 240) || !boundedText(value.company, 240) || description.length < 120) {
    throw contextError("MESSAGE_DISCOVERY_JOB_DETAIL_INCOMPLETE", "zhaopin job detail is incomplete");
  }
  return {
    source: "zhaopin", sourceId, canonicalUrl: expectedUrl,
    title: boundedText(value.title, 240), company: boundedText(value.company, 240),
    location: boundedText(value.location, 120), salary: boundedText(value.salary, 120),
    experience: boundedText(value.experience, 120), education: boundedText(value.education, 120),
    tags: Array.isArray(value.tags) ? [...new Set(value.tags.map((item) => boundedText(item, 120)).filter(Boolean))].slice(0, 40) : [],
    description: description.slice(0, 12000), availability: value.availability === "offline" ? "offline" : "unknown"
  };
}

function contextJob(context) {
  return {
    id: context.jobId, source: context.source, sourceId: context.sourceId,
    title: context.title, company: context.company, salary: context.salary,
    location: context.city, experience: context.experience, education: context.education,
    bossActiveText: context.bossActiveText, url: context.url, tags: context.tags,
    description: context.description, qualityTags: context.qualityTags, analysis: context.analysis,
    availability: context.analysis?.sourceAvailability === "offline" ? "offline" : "unknown",
    observationId: context.observationId, batchId: context.batchId
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || contextError("MESSAGE_DISCOVERY_STOPPED", "message discovery stopped");
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer`);
  return number;
}

function boundedText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function contextError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { createZhaopinMessageJobContextResolver };
