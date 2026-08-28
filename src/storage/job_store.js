const crypto = require("node:crypto");
const { getSearchPlan } = require("./candidate_store");
const { ensureFunnelEntry } = require("./funnel_store");
const { nowIso, parseJson, OUTCOME_STATUSES, storageError, optionalPositiveInteger, immediateTransaction } = require("./storage_shared");
const { scoreJob, decisionState } = require("../core/scoring");
const { parseBossActivityText } = require("../core/activity_status");
const { mergeJobMetadata } = require("../core/job_metadata");
const { NEGATIVE_FEEDBACK_STATUSES, normalizeFeedbackReason } = require("../core/feedback");
const { buildAnalysisRevision, analysisStaleReasons } = require("../core/analysis_revision");
const { decisionHardBlockers } = require("../core/model_contract");
const { RECOMMENDATION_SCHEMA_VERSION, normalizeRecommendationTier } = require("../core/decision_policy");
const { buildOutcomeAnalytics } = require("../core/outcome_analytics");

const VALID_CANDIDATE_STATUSES = new Set(OUTCOME_STATUSES);

function listDecisionPool(db, { planId } = {}) {
  const plan = getSearchPlan(db, planId);
  if (!plan) return [];
  return listReportJobs(db, { planId: plan.id, batch: "all", profileId: plan.profileId, limit: 10000 });
}

function outcomeAnalyticsPlanName(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function getOutcomeAnalyticsSnapshot(db, { planId } = {}) {
  const plan = getSearchPlan(db, planId);
  if (!plan) return { ...buildOutcomeAnalytics([]), context: { planName: "" } };
  const rows = listDecisionPool(db, { planId: plan.id }).map((job) => ({
    decisionBucket: job.decisionBucket,
    applicationStatus: job.applicationStatus || "pending",
    keyword: job.keyword || ""
  }));
  return { ...buildOutcomeAnalytics(rows), context: { planName: outcomeAnalyticsPlanName(plan.name) } };
}

function listDecisionQueue(db, { planId, limit = 15, buckets = null } = {}) {
  const plan = getSearchPlan(db, planId);
  if (!plan) return [];
  const now = new Date().toISOString();
  const wantedBuckets = Array.isArray(buckets) && buckets.length ? new Set(buckets) : null;
  return listDecisionPool(db, { planId: plan.id })
    .filter((job) => isJobAwaitingAction(job, now) && decisionState(job) === "ready" && (!wantedBuckets || wantedBuckets.has(job.decisionBucket)))
    .sort((a, b) => queueRank(a) - queueRank(b) || compareReportJobs(a, b))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 15)));
}

function getModelCache(db, cacheKey) {
  const row = db.prepare("SELECT * FROM model_cache WHERE cache_key = ?").get(String(cacheKey));
  return row ? {
    kind: row.kind, provider: row.provider, model: row.model || "", inputHash: row.input_hash,
    result: parseJson(row.result_json, {}), createdAt: row.created_at
  } : null;
}

function saveModelCache(db, { cacheKey, kind, provider, model, inputHash, result }) {
  db.prepare(`
    INSERT INTO model_cache(cache_key, kind, provider, model, input_hash, result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET result_json=excluded.result_json, created_at=excluded.created_at
  `).run(String(cacheKey), String(kind), String(provider), String(model || ""), String(inputHash), JSON.stringify(result || {}), nowIso());
}

function upsertKeywordSource(db, keyword, source = "cli") {
  if (!keyword) return;
  db.prepare(`
    INSERT INTO keyword_sources(keyword, source, created_at) VALUES (?, ?, ?)
    ON CONFLICT(keyword) DO UPDATE SET source = excluded.source
  `).run(keyword, source, nowIso());
}

function upsertJob(db, job, batchId) {
  const existing = db.prepare("SELECT id, first_seen_at FROM jobs WHERE source = ? AND source_id = ?").get(job.source, job.sourceId);
  const now = nowIso();
  const params = [
    job.keyword || null, job.title, job.company || null, job.location || null, job.salary || null,
    job.experience || null, job.education || null, job.bossActiveText || null, job.bossActiveDays ?? null,
    job.url || null, JSON.stringify(job.tags || []), job.description || null, job.score || 0, job.level || null,
    JSON.stringify(job.matches || []), JSON.stringify(job.risks || []), JSON.stringify(job.qualityTags || []),
    job.greeting || null, JSON.stringify(job.analysis || {}), now, batchId || null
  ];
  if (existing) {
    db.prepare(`
      UPDATE jobs SET keyword=?, title=?, company=?, location=?, salary=?, experience=?, education=?,
      boss_active_text=?, boss_active_days=?, url=?, tags_json=?, description=?, score=?, level=?,
      matches_json=?, risks_json=?, quality_tags_json=?, greeting=?, analysis_json=?, last_seen_at=?, batch_id=? WHERE id=?
    `).run(...params, existing.id);
    if (batchId) recordJobObservation(db, existing.id, batchId, job, now);
    return Number(existing.id);
  }
  const result = db.prepare(`
    INSERT INTO jobs(source, source_id, keyword, title, company, location, salary, experience, education,
      boss_active_text, boss_active_days, url, tags_json, description, score, level, matches_json,
      risks_json, quality_tags_json, greeting, analysis_json, first_seen_at, last_seen_at, batch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(job.source, job.sourceId, ...params.slice(0, -1), now, batchId || null);
  const id = Number(result.lastInsertRowid);
  if (batchId) recordJobObservation(db, id, batchId, job, now);
  return id;
}

function recordJobObservation(db, jobId, batchId, job, seenAt) {
  const contentHash = sourceContentHash(job);
  const values = [
    jobId, batchId, job.keyword || null, job.title || "", job.company || null, job.location || null,
    job.salary || null, job.experience || null, job.education || null, job.bossActiveText || null,
    job.bossActiveDays ?? null, job.url || null, JSON.stringify(job.tags || []), job.description || null,
    job.score || 0, job.level || null, JSON.stringify(job.matches || []), JSON.stringify(job.risks || []),
    JSON.stringify(job.qualityTags || []), job.greeting || null, JSON.stringify(job.analysis || {}), contentHash, 1, seenAt
  ];
  db.prepare(`
    INSERT INTO job_observations(
      job_id, batch_id, keyword, title, company, location, salary, experience, education,
      boss_active_text, boss_active_days, url, tags_json, description, score, level,
      matches_json, risks_json, quality_tags_json, greeting, analysis_json, content_hash, content_hash_version, seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(batch_id, job_id) DO UPDATE SET
      keyword=excluded.keyword, title=excluded.title, company=excluded.company, location=excluded.location,
      salary=excluded.salary, experience=excluded.experience, education=excluded.education,
      boss_active_text=excluded.boss_active_text, boss_active_days=excluded.boss_active_days, url=excluded.url,
      tags_json=excluded.tags_json, description=excluded.description, score=excluded.score, level=excluded.level,
      matches_json=excluded.matches_json, risks_json=excluded.risks_json, quality_tags_json=excluded.quality_tags_json,
      greeting=excluded.greeting, analysis_json=excluded.analysis_json, content_hash=excluded.content_hash,
      content_hash_version=excluded.content_hash_version, seen_at=excluded.seen_at
  `).run(...values);
}

function resolveProfileId(db, options = {}, batchId = null) {
  if (options.profileId) return Number(options.profileId);
  const planId = Number(options.planId || 0);
  if (planId) return Number(db.prepare("SELECT profile_id FROM search_plans WHERE id = ?").get(planId)?.profile_id || 0) || null;
  if (batchId) return Number(db.prepare("SELECT profile_id FROM batches WHERE id = ?").get(batchId)?.profile_id || 0) || null;
  return null;
}

function resolveBatchId(db, options = {}) {
  if (options.batchId && options.batchId !== "all") return Number(options.batchId);
  if (options.batch === "latest" || options.latestBatch) return getLatestBatchId(db, options);
  return null;
}

function getLatestBatchId(db, options = {}) {
  const planId = Number(options.planId || options.searchPlanId || 0);
  const row = planId
    ? db.prepare("SELECT id FROM batches WHERE search_plan_id = ? ORDER BY started_at DESC, id DESC LIMIT 1").get(planId)
    : db.prepare("SELECT id FROM batches ORDER BY started_at DESC, id DESC LIMIT 1").get();
  return row ? Number(row.id) : null;
}

function getLatestMainScanBatchId(db, options = {}) {
  const planId = Number(options.planId || options.searchPlanId || 0);
  const rows = planId
    ? db.prepare("SELECT b.id, b.filter_snapshot_json FROM batches b WHERE b.search_plan_id = ? AND EXISTS (SELECT 1 FROM job_observations o WHERE o.batch_id = b.id) ORDER BY b.started_at DESC, b.id DESC").all(planId)
    : db.prepare("SELECT b.id, b.filter_snapshot_json FROM batches b WHERE EXISTS (SELECT 1 FROM job_observations o WHERE o.batch_id = b.id) ORDER BY b.started_at DESC, b.id DESC").all();
  const row = rows.find((candidate) => {
    const execution = parseJson(candidate.filter_snapshot_json, {}).execution;
    return execution && typeof execution === "object" && !Array.isArray(execution);
  });
  return row ? Number(row.id) : null;
}

function isJobAwaitingAction(job, now = new Date().toISOString()) {
  const status = job.applicationStatus || "pending";
  if (status === "pending" || status === "review") return true;
  if (status !== "later") return false;
  const dueAt = job.reviewAt || legacyLaterDueAt(job.applicationUpdatedAt);
  return Boolean(dueAt && dueAt <= now);
}

function legacyLaterDueAt(updatedAt) {
  const timestamp = Date.parse(updatedAt || "");
  return Number.isFinite(timestamp) ? new Date(timestamp + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) : "";
}

function listReportJobs(db, options = {}) {
  const batchId = resolveBatchId(db, options);
  const planId = Number(options.planId || 0);
  const profileId = resolveProfileId(db, { ...options, planId }, batchId);
  const latestPerPlan = !batchId && planId > 0;
  const cte = latestPerPlan ? `
    WITH ranked_observations AS (
      SELECT o0.*, ROW_NUMBER() OVER (PARTITION BY o0.job_id ORDER BY o0.seen_at DESC, o0.id DESC) AS plan_rank
      FROM job_observations o0 JOIN batches b0 ON b0.id = o0.batch_id WHERE b0.search_plan_id = ?
    )
  ` : "";
  const observationSource = latestPerPlan ? "ranked_observations o" : "job_observations o";
  const where = batchId ? "o.batch_id = ?" : latestPerPlan ? "o.plan_rank = 1" : "1 = 1";
  const params = latestPerPlan ? [planId] : batchId ? [batchId] : [];
  const limit = Math.max(1, Math.min(10000, Number(options.limit) || 200));
  const scopedObservation = profileId ? ` AND b2.profile_id = ${Number(profileId)}` : "";
  const stateSelect = profileId ? `
      states.status AS application_status, states.note AS application_note, states.updated_at AS application_updated_at,
      states.reason_code AS application_reason_code, states.review_at AS review_at,
      (SELECT json_extract(payload_json, '$.note') FROM candidate_job_events ce WHERE ce.profile_id = ${Number(profileId)} AND ce.job_id = jobs.id AND ce.event_type = 'follow_up' ORDER BY ce.created_at DESC, ce.id DESC LIMIT 1) AS follow_up_note,
      (SELECT created_at FROM candidate_job_events ce WHERE ce.profile_id = ${Number(profileId)} AND ce.job_id = jobs.id AND ce.event_type = 'follow_up' ORDER BY ce.created_at DESC, ce.id DESC LIMIT 1) AS follow_up_updated_at
  ` : `
      (SELECT status FROM applications WHERE applications.job_id = jobs.id ORDER BY updated_at DESC, id DESC LIMIT 1) AS application_status,
      (SELECT note FROM applications WHERE applications.job_id = jobs.id ORDER BY updated_at DESC, id DESC LIMIT 1) AS application_note,
      (SELECT updated_at FROM applications WHERE applications.job_id = jobs.id ORDER BY updated_at DESC, id DESC LIMIT 1) AS application_updated_at,
      '' AS application_reason_code, '' AS review_at,
      (SELECT json_extract(payload_json, '$.note') FROM events WHERE events.job_id = jobs.id AND event_type = 'follow_up' ORDER BY created_at DESC, id DESC LIMIT 1) AS follow_up_note,
      (SELECT created_at FROM events WHERE events.job_id = jobs.id AND event_type = 'follow_up' ORDER BY created_at DESC, id DESC LIMIT 1) AS follow_up_updated_at
  `;
  const stateJoin = profileId ? `LEFT JOIN candidate_job_states states ON states.profile_id = ${Number(profileId)} AND states.job_id = jobs.id` : "";
  const stmt = db.prepare(`
    ${cte}
    SELECT jobs.id AS id, jobs.source AS source, jobs.source_id AS source_id,
      o.id AS observation_id, o.batch_id AS batch_id, b.profile_id AS profile_id, b.search_plan_id AS search_plan_id,
      o.keyword, o.title, o.company, o.location, o.salary, o.experience, o.education,
      o.boss_active_text, o.boss_active_days, o.url, o.tags_json, o.description, o.score, o.level,
      o.matches_json, o.risks_json, o.quality_tags_json, o.greeting, o.analysis_json,
      (SELECT MIN(o2.seen_at) FROM job_observations o2 JOIN batches b2 ON b2.id = o2.batch_id WHERE o2.job_id = jobs.id${scopedObservation}) AS first_seen_at,
      (SELECT MAX(o2.seen_at) FROM job_observations o2 JOIN batches b2 ON b2.id = o2.batch_id WHERE o2.job_id = jobs.id${scopedObservation}) AS last_seen_at,
      (SELECT o2.batch_id FROM job_observations o2 JOIN batches b2 ON b2.id = o2.batch_id WHERE o2.job_id = jobs.id${scopedObservation} ORDER BY o2.seen_at ASC, o2.id ASC LIMIT 1) AS first_batch_id,
      (SELECT o2.batch_id FROM job_observations o2 JOIN batches b2 ON b2.id = o2.batch_id WHERE o2.job_id = jobs.id${scopedObservation} AND COALESCE(b2.keyword, '') NOT IN ('detail-refresh', 'activity-probe', 'analysis-retry') ORDER BY o2.seen_at DESC, o2.id DESC LIMIT 1) AS latest_scan_batch_id,
      (SELECT o2.content_hash FROM job_observations o2 JOIN batches b2 ON b2.id = o2.batch_id WHERE o2.job_id = jobs.id AND o2.id <> o.id${scopedObservation} ORDER BY o2.seen_at DESC, o2.id DESC LIMIT 1) AS previous_content_hash,
      (SELECT result FROM job_refresh_attempts ra WHERE ra.job_id = jobs.id ORDER BY ra.created_at DESC, ra.id DESC LIMIT 1) AS refresh_result,
      (SELECT error_code FROM job_refresh_attempts ra WHERE ra.job_id = jobs.id ORDER BY ra.created_at DESC, ra.id DESC LIMIT 1) AS refresh_error_code,
      (SELECT attempt_number FROM job_refresh_attempts ra WHERE ra.job_id = jobs.id ORDER BY ra.created_at DESC, ra.id DESC LIMIT 1) AS refresh_attempt_number,
      (SELECT next_retry_at FROM job_refresh_attempts ra WHERE ra.job_id = jobs.id ORDER BY ra.created_at DESC, ra.id DESC LIMIT 1) AS refresh_next_retry_at,
      (SELECT created_at FROM job_refresh_attempts ra WHERE ra.job_id = jobs.id ORDER BY ra.created_at DESC, ra.id DESC LIMIT 1) AS refresh_attempted_at,
      ${stateSelect}
    FROM ${observationSource} JOIN jobs ON jobs.id = o.job_id JOIN batches b ON b.id = o.batch_id ${stateJoin}
    WHERE ${where} ORDER BY o.seen_at DESC, o.id DESC LIMIT ?
  `);
  const feedbackSummary = options.feedbackSummary || buildFeedbackSummary(db, { profileId });
  const jobs = stmt.all(...params, limit).map(rowToJob).map((job) => withFeedback(job, feedbackSummary));
  return applyJobQualityGovernance(jobs).sort(compareReportJobs).slice(0, limit);
}

function storedDetailFlags(row = {}) {
  const tags = parseJson(row.quality_tags_json, []);
  const description = String(row.description || "");
  const wasDetailRequired = tags.includes("detail_unverified") || (String(row.source || "") === "boss" && description.length >= 120);
  if (!wasDetailRequired) return {};
  return { detailRequired: true, detailRead: !tags.includes("detail_unverified") };
}

function buildFeedbackSummary(db, options = {}) {
  const profileId = Number(options.profileId || 0);
  const rows = profileId ? db.prepare(`
    SELECT jobs.*, states.status AS application_status, states.reason_code AS application_reason_code,
      (SELECT o.keyword FROM job_observations o JOIN batches b ON b.id = o.batch_id WHERE o.job_id = jobs.id AND b.profile_id = ? ORDER BY o.seen_at DESC, o.id DESC LIMIT 1) AS observed_keyword,
      (SELECT o.risks_json FROM job_observations o JOIN batches b ON b.id = o.batch_id WHERE o.job_id = jobs.id AND b.profile_id = ? ORDER BY o.seen_at DESC, o.id DESC LIMIT 1) AS observed_risks_json,
      (SELECT o.analysis_json FROM job_observations o JOIN batches b ON b.id = o.batch_id WHERE o.job_id = jobs.id AND b.profile_id = ? ORDER BY o.seen_at DESC, o.id DESC LIMIT 1) AS observed_analysis_json
    FROM candidate_job_states states JOIN jobs ON jobs.id = states.job_id WHERE states.profile_id = ?
  `).all(profileId, profileId, profileId, profileId) : db.prepare(`
    SELECT jobs.*, (SELECT status FROM applications WHERE applications.job_id = jobs.id ORDER BY updated_at DESC, id DESC LIMIT 1) AS application_status,
      '' AS application_reason_code FROM jobs
  `).all();
  const summary = {
    totals: Object.fromEntries(OUTCOME_STATUSES.map((status) => [status, 0])), companies: {}, keywords: {}, risks: {},
    resumeVersions: {}, skipReasons: {}, reasonCounts: {}, companyReasons: {}, keywordReasons: {}
  };
  for (const row of rows) {
    const status = row.application_status;
    if (!OUTCOME_STATUSES.includes(status)) continue;
    summary.totals[status] += 1;
    addStat(summary.companies, row.company, status);
    addStat(summary.keywords, row.observed_keyword || row.keyword, status);
    for (const risk of parseJson(row.observed_risks_json || row.risks_json, [])) addStat(summary.risks, risk, status);
    const analysis = parseJson(row.observed_analysis_json || row.analysis_json, {});
    addStat(summary.resumeVersions, analysis.recommendedResumeVersion, status);
    if (NEGATIVE_FEEDBACK_STATUSES.has(status)) {
      const reason = normalizeFeedbackReason(row.application_reason_code, status);
      addStat(summary.skipReasons, reason, status);
      if (reason) {
        summary.reasonCounts[reason] = (summary.reasonCounts[reason] || 0) + 1;
        addReasonStat(summary.companyReasons, row.company, reason);
        addReasonStat(summary.keywordReasons, row.observed_keyword || row.keyword, reason);
      }
    }
  }
  if (profileId) {
    const feedbackEvents = db.prepare(`
      SELECT e.payload_json, jobs.company, (SELECT o.keyword FROM job_observations o JOIN batches b ON b.id = o.batch_id WHERE o.job_id = e.job_id AND b.profile_id = e.profile_id ORDER BY o.seen_at DESC, o.id DESC LIMIT 1) AS observed_keyword
      FROM candidate_job_events e JOIN jobs ON jobs.id = e.job_id WHERE e.profile_id = ? AND e.event_type = 'recommendation_feedback'
    `).all(profileId);
    for (const event of feedbackEvents) {
      const reason = normalizeFeedbackReason(parseJson(event.payload_json, {}).reasonCode);
      if (!reason) continue;
      summary.reasonCounts[reason] = (summary.reasonCounts[reason] || 0) + 1;
      addReasonStat(summary.companyReasons, event.company, reason);
      addReasonStat(summary.keywordReasons, event.observed_keyword, reason);
    }
  }
  return summary;
}

function buildBatchSummary(db, options = {}) {
  const allBatches = options.batch === "all" && !options.batchId;
  const batchId = allBatches ? null : (resolveBatchId(db, options) || getLatestBatchId(db, options));
  const listOptions = { ...options, limit: Math.max(1, Math.min(500, Number(options.limit) || 500)) };
  const jobs = allBatches ? listReportJobs(db, { ...listOptions, batch: "all" }) : (batchId ? listReportJobs(db, { ...listOptions, batchId }) : listReportJobs(db, listOptions));
  const summary = {
    batchId: allBatches ? "all" : batchId, imported: jobs.length, pending: 0, ...Object.fromEntries(OUTCOME_STATUSES.map((status) => [status, 0])),
    newJobs: 0, repeated: 0, nonGuangzhou: 0, inactiveOrUnknown: 0, duplicateJobs: 0, weakDuplicates: 0, needsRecheck: 0, detailChanged: 0, riskTop: []
  };
  const risks = {};
  for (const job of jobs) {
    const status = job.applicationStatus || "pending";
    if (summary[status] !== undefined) summary[status] += 1;
    if (job.firstSeenAt && job.lastSeenAt && job.firstSeenAt !== job.lastSeenAt) { summary.repeated += 1; summary.duplicateJobs += 1; } else summary.newJobs += 1;
    const tags = new Set(job.qualityTags || []);
    if (tags.has("location_mismatch")) summary.nonGuangzhou += 1;
    if (tags.has("inactive_boss") || tags.has("stale_or_unknown_active")) summary.inactiveOrUnknown += 1;
    if (tags.has("possible_duplicate")) summary.weakDuplicates += 1;
    if (tags.has("needs_recheck")) summary.needsRecheck += 1;
    if (tags.has("detail_changed")) summary.detailChanged += 1;
    for (const risk of job.risks || []) risks[risk] = (risks[risk] || 0) + 1;
  }
  summary.riskTop = Object.entries(risks).map(([risk, count]) => ({ risk, count })).sort((a, b) => b.count - a.count || a.risk.localeCompare(b.risk, "zh-CN")).slice(0, 8);
  return summary;
}

function markApplication(db, jobId, status, note, context = {}) {
  if (context.profileId) return markCandidateJob(db, { ...context, jobId, status, note });
  const now = nowIso();
  db.prepare("INSERT INTO applications(job_id, status, note, updated_at) VALUES (?, ?, ?, ?)").run(jobId, status, note || null, now);
  db.prepare("INSERT INTO events(job_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)").run(jobId, status, JSON.stringify({ note: note || "" }), now);
}

function bindBatchToPlan(db, { batchId, planId }) {
  const batch = db.prepare("SELECT id, profile_id, search_plan_id FROM batches WHERE id = ?").get(Number(batchId));
  const plan = getSearchPlan(db, planId);
  if (!batch) throw new Error("batch not found");
  if (!plan) throw new Error("search plan not found");
  if (batch.search_plan_id && Number(batch.search_plan_id) !== plan.id) throw new Error("batch is already bound to another search plan");
  if (batch.profile_id && Number(batch.profile_id) !== plan.profileId) throw new Error("batch belongs to another candidate profile");
  const now = nowIso();
  const jobIds = db.prepare("SELECT job_id FROM job_observations WHERE batch_id = ?").all(Number(batchId)).map((row) => Number(row.job_id));
  const updateState = db.prepare("UPDATE candidate_job_states SET plan_id = ?, updated_at = ? WHERE profile_id = ? AND job_id = ? AND plan_id IS NULL");
  const existingState = db.prepare("SELECT 1 AS present FROM candidate_job_states WHERE profile_id = ? AND job_id = ?");
  const latestApplication = db.prepare("SELECT status, note, updated_at FROM applications WHERE job_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1");
  const insertState = db.prepare("INSERT INTO candidate_job_states(profile_id, job_id, plan_id, status, reason_code, note, review_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)");
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE batches SET profile_id = ?, search_plan_id = ? WHERE id = ?").run(plan.profileId, plan.id, Number(batchId));
    let migratedStates = 0;
    for (const jobId of jobIds) {
      const updated = updateState.run(plan.id, now, plan.profileId, jobId);
      if (updated.changes) { migratedStates += 1; continue; }
      if (existingState.get(plan.profileId, jobId)) continue;
      const application = latestApplication.get(jobId);
      if (!application) continue;
      insertState.run(plan.profileId, jobId, plan.id, application.status, application.note || null, application.updated_at || now);
      migratedStates += 1;
    }
    db.exec("COMMIT");
    return { batchId: Number(batchId), planId: plan.id, profileId: plan.profileId, migratedStates };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function rescorePlanObservations(db, { planId, configs }) {
  const plan = getSearchPlan(db, planId);
  if (!plan) throw new Error("search plan not found");
  const rows = db.prepare(`
    SELECT o.id AS observation_id, j.source, j.source_id, o.keyword, o.title, o.company, o.location,
      o.salary, o.experience, o.education, o.boss_active_text, o.url, o.tags_json, o.quality_tags_json, o.description, o.analysis_json
    FROM job_observations o JOIN jobs j ON j.id = o.job_id JOIN batches b ON b.id = o.batch_id WHERE b.search_plan_id = ?
  `).all(plan.id);
  const update = db.prepare(`
    UPDATE job_observations SET salary = ?, experience = ?, education = ?, score = ?, level = ?, matches_json = ?, risks_json = ?, quality_tags_json = ?, analysis_json = ? WHERE id = ?
  `);
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const metadata = mergeJobMetadata({ salary: row.salary || "", experience: row.experience || "", education: row.education || "", tags: parseJson(row.tags_json, []) }, row.description || "");
      const raw = {
        source: row.source, sourceId: row.source_id, keyword: row.keyword || "", title: row.title || "", company: row.company || "", location: row.location || "",
        salary: metadata.salary, experience: metadata.experience, education: metadata.education, bossActiveText: row.boss_active_text || "",
        url: row.url || "", tags: parseJson(row.tags_json, []), description: row.description || "", ...storedDetailFlags(row)
      };
      const scored = scoreJob(raw, configs);
      const previousAnalysis = parseJson(row.analysis_json, {});
      const expectedRevision = buildAnalysisRevision(configs, sourceContentHash(raw));
      const staleReasons = analysisStaleReasons(previousAnalysis, expectedRevision);
      const modelBacked = ["complete", "partial"].includes(previousAnalysis.semanticStatus)
        || (!previousAnalysis.semanticStatus && !["rule-only", "rule-gate", "scan-checkpoint", "rule-fallback"].includes(previousAnalysis.provider));
      const analysis = {
        ...previousAnalysis, workSchedule: scored.workSchedule, workScheduleEvidence: scored.workScheduleEvidence, technicalFit: scored.technicalFit,
        ...(modelBacked && staleReasons.length ? { semanticStatus: "stale", decisionSource: "analysis_pending", recommendation: null, decisionStatus: "needs_retry", staleReasons, expectedRevision } : {})
      };
      update.run(raw.salary, raw.experience, raw.education, scored.score, scored.level, JSON.stringify(scored.matches), JSON.stringify(scored.risks), JSON.stringify(scored.qualityTags), JSON.stringify(analysis), row.observation_id);
    }
    db.exec("COMMIT");
    return { planId: plan.id, rescored: rows.length };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

async function reassessBatchObservations(db, { batchId, planId, configs, analyzeJob, cleanDescription = (value) => value } = {}) {
  const normalizedBatchId = optionalPositiveInteger(batchId, "batchId");
  const normalizedPlanId = optionalPositiveInteger(planId, "planId");
  if (!normalizedBatchId) throw storageError("BATCH_ID_REQUIRED", "batchId is required");
  if (!normalizedPlanId) throw storageError("PLAN_ID_REQUIRED", "planId is required");
  const batch = db.prepare("SELECT id, search_plan_id FROM batches WHERE id = ?").get(normalizedBatchId);
  if (!batch) throw new Error("batch not found");
  if (Number(batch.search_plan_id || 0) !== normalizedPlanId) throw storageError("BATCH_PLAN_MISMATCH", "batch does not belong to the requested search plan");
  if (typeof analyzeJob !== "function") throw new Error("analyzeJob is required");
  const rows = db.prepare(`
    SELECT o.id AS observation_id, o.job_id, o.keyword, o.title, o.company, o.location, o.salary, o.experience, o.education,
      o.boss_active_text, o.url, o.tags_json, o.quality_tags_json, o.description, o.greeting, j.source, j.source_id
    FROM job_observations o JOIN jobs j ON j.id = o.job_id WHERE o.batch_id = ? ORDER BY o.id
  `).all(normalizedBatchId);
  const reassessed = [];
  for (const row of rows) {
    const description = cleanDescription(row.description || "");
    const detailActivity = parseBossActivityText(row.description || "");
    const metadata = mergeJobMetadata({ salary: row.salary || "", experience: row.experience || "", education: row.education || "", tags: parseJson(row.tags_json, []) }, description);
    const raw = {
      source: row.source, sourceId: row.source_id, keyword: row.keyword || "", title: row.title || "", company: row.company || "", location: row.location || "",
      salary: metadata.salary, experience: metadata.experience, education: metadata.education, bossActiveText: detailActivity || row.boss_active_text || "",
      url: row.url || "", tags: parseJson(row.tags_json, []), description, ...storedDetailFlags(row)
    };
    const scored = scoreJob(raw, configs);
    const gate = decisionState(scored);
    const base = gate === "ready" ? await analyzeJob({ ...raw, ...scored, greeting: row.greeting || "", preserveGreeting: Boolean(row.greeting) }) : reassessmentGateAnalysis(scored, gate);
    const analysis = { ...base, roleKind: scored.roleKind, roleEvidence: scored.roleEvidence, workSchedule: scored.workSchedule, workScheduleEvidence: scored.workScheduleEvidence, technicalFit: scored.technicalFit };
    reassessed.push({ row, raw, scored, analysis, greeting: analysis.greeting || row.greeting || "" });
  }
  const updateObservation = db.prepare(`UPDATE job_observations SET salary = ?, experience = ?, education = ?, boss_active_text = ?, boss_active_days = ?, description = ?, score = ?, level = ?, matches_json = ?, risks_json = ?, quality_tags_json = ?, greeting = ?, analysis_json = ?, content_hash = ?, content_hash_version = 1 WHERE id = ?`);
  const updateCurrentJob = db.prepare(`UPDATE jobs SET salary = ?, experience = ?, education = ?, boss_active_text = ?, boss_active_days = ?, description = ?, score = ?, level = ?, matches_json = ?, risks_json = ?, quality_tags_json = ?, greeting = ?, analysis_json = ? WHERE id = ? AND batch_id = ?`);
  db.exec("BEGIN");
  try {
    for (const item of reassessed) {
      const snapshot = { ...item.raw, ...item.scored, analysis: item.analysis };
      const values = [item.raw.salary, item.raw.experience, item.raw.education, item.raw.bossActiveText, item.scored.bossActiveDays, item.raw.description, item.scored.score, item.scored.level, JSON.stringify(item.scored.matches), JSON.stringify(item.scored.risks), JSON.stringify(item.scored.qualityTags), item.greeting, JSON.stringify(item.analysis), observationContentHash(snapshot)];
      updateObservation.run(...values, item.row.observation_id);
      updateCurrentJob.run(...values.slice(0, 13), item.row.job_id, normalizedBatchId);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { batchId: normalizedBatchId, planId: normalizedPlanId, reassessed: reassessed.length };
}

function reassessmentGateAnalysis(scored, gate) {
  const blocked = gate === "blocked";
  return {
    provider: "rule-gate", model: "", semanticStatus: blocked ? "blocked" : "refresh", decisionSource: blocked ? "hard_boundary" : "source_refresh",
    recommendation: blocked ? "not_recommended" : null, decisionStatus: blocked ? "decided" : "needs_retry", recommendationSchemaVersion: RECOMMENDATION_SCHEMA_VERSION,
    fitLevel: blocked ? "no_fit" : null, confidence: null, recommendedResumeVersion: "", recommendedResumeVersionName: "", primaryProjects: [],
    fitReasons: [blocked ? "基础岗位条件不符合当前投递范围。" : "招聘方活跃状态待刷新。"], hardBlockers: [], softGaps: [], questionsToVerify: scored.risks || [], missingPoints: [], blockingGaps: [], riskQuestions: scored.risks || [], evidence: { jd: [], resume: [] }, greetingAngle: "", greeting: ""
  };
}

function markCandidateJob(db, { profileId, jobId, status, note = "", reasonCode = "", reviewAt = "", planId = null }) {
  const profile = Number(profileId);
  const job = Number(jobId);
  if (!Number.isInteger(profile) || profile <= 0) throw new Error("candidate profile is required");
  if (!Number.isInteger(job) || job <= 0) throw new Error("job is required");
  if (!VALID_CANDIDATE_STATUSES.has(status)) throw new Error("invalid candidate job status");
  if (!db.prepare("SELECT id FROM jobs WHERE id = ?").get(job)) throw new Error("job not found");
  const now = nowIso();
  const normalizedReason = NEGATIVE_FEEDBACK_STATUSES.has(status) ? normalizeFeedbackReason(reasonCode, status) : "";
  const work = () => {
    db.prepare(`
      INSERT INTO candidate_job_states(profile_id, job_id, plan_id, status, reason_code, note, review_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, job_id) DO UPDATE SET plan_id=excluded.plan_id, status=excluded.status, reason_code=excluded.reason_code, note=excluded.note, review_at=excluded.review_at, updated_at=excluded.updated_at
    `).run(profile, job, planId || null, status, normalizedReason || null, note || null, reviewAt || null, now);
    db.prepare("INSERT INTO candidate_job_events(profile_id, job_id, plan_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(profile, job, planId || null, status, JSON.stringify({ note: note || "", reasonCode: normalizedReason, reviewAt: reviewAt || "" }), now);
    if (status === "applied") {
      ensureFunnelEntry(db, {
        profileId: profile,
        planId,
        jobId: job,
        sourceKind: "applied",
        startedAt: now
      });
    }
  };
  return db.isTransaction ? work() : immediateTransaction(db, work);
}

function addFollowUpNote(db, jobId, note, context = {}) {
  const value = String(note || "").trim();
  if (!value) throw new Error("follow-up note is required");
  if (!db.prepare("SELECT id FROM jobs WHERE id = ?").get(jobId)) throw new Error("job not found");
  if (context.profileId) {
    db.prepare("INSERT INTO candidate_job_events(profile_id, job_id, plan_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(Number(context.profileId), Number(jobId), context.planId || null, "follow_up", JSON.stringify({ note: value }), nowIso());
    return;
  }
  db.prepare("INSERT INTO events(job_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)").run(jobId, "follow_up", JSON.stringify({ note: value }), nowIso());
}

function recordCandidateJobEvent(db, { profileId, jobId, planId = null, eventType, payload = {} }) {
  const profile = Number(profileId);
  const job = Number(jobId);
  const type = String(eventType || "").trim();
  if (!profile || !job || !type) throw new Error("profileId, jobId and eventType are required");
  if (!db.prepare("SELECT id FROM candidate_profiles WHERE id = ?").get(profile)) throw new Error("candidate profile not found");
  if (!db.prepare("SELECT id FROM jobs WHERE id = ?").get(job)) throw new Error("job not found");
  db.prepare("INSERT INTO candidate_job_events(profile_id, job_id, plan_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(profile, job, Number(planId || 0) || null, type, JSON.stringify(payload || {}), nowIso());
}

function listCandidateJobEvents(db, { profileId, jobId = null, planId = null, eventType = "", limit = 30 }) {
  const clauses = ["profile_id = ?"];
  const params = [Number(profileId)];
  if (jobId) { clauses.push("job_id = ?"); params.push(Number(jobId)); }
  if (planId) {
    clauses.push(`(
      plan_id = ? OR (plan_id IS NULL AND EXISTS (
        SELECT 1 FROM job_observations legacy_observation JOIN batches legacy_batch ON legacy_batch.id = legacy_observation.batch_id
        WHERE legacy_observation.job_id = candidate_job_events.job_id AND legacy_batch.search_plan_id = ? AND legacy_batch.profile_id = ?
      ))
    )`);
    params.push(Number(planId), Number(planId), Number(profileId));
  }
  if (eventType) { clauses.push("event_type = ?"); params.push(String(eventType)); }
  params.push(Math.max(1, Math.min(200, Number(limit) || 30)));
  return db.prepare(`SELECT * FROM candidate_job_events WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params).map((row) => ({
    id: Number(row.id), profileId: Number(row.profile_id), jobId: Number(row.job_id), planId: row.plan_id || null,
    eventType: row.event_type, payload: parseJson(row.payload_json, {}), createdAt: row.created_at
  }));
}

function recordRecommendationFeedback(db, { profileId, jobId, planId = null, reasonCode, note = "" }) {
  const reason = normalizeFeedbackReason(reasonCode);
  if (!reason) throw new Error("invalid feedback reason");
  recordCandidateJobEvent(db, { profileId, jobId, planId, eventType: "recommendation_feedback", payload: { reasonCode: reason, note: String(note || "").trim() } });
  return reason;
}

function rowToJob(row) {
  const analysis = normalizeAnalysisForRead(parseJson(row.analysis_json, {}));
  return {
    id: row.id, observationId: row.observation_id || null, profileId: row.profile_id || null, searchPlanId: row.search_plan_id || null,
    source: row.source, sourceId: row.source_id, keyword: row.keyword, title: row.title, company: row.company, location: row.location,
    salary: row.salary, experience: row.experience, education: row.education, bossActiveText: row.boss_active_text, bossActiveDays: row.boss_active_days,
    url: row.url, tags: JSON.parse(row.tags_json || "[]"), description: row.description, score: row.score, level: row.level,
    matches: JSON.parse(row.matches_json || "[]"), risks: JSON.parse(row.risks_json || "[]"), qualityTags: parseJson(row.quality_tags_json, []),
    greeting: row.greeting, analysis, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
    firstBatchId: Number(row.first_batch_id || 0) || null, latestScanBatchId: Number(row.latest_scan_batch_id || 0) || null,
    previousContentHash: row.previous_content_hash || "", refreshResult: row.refresh_result || "", refreshErrorCode: row.refresh_error_code || "",
    refreshAttemptNumber: Number(row.refresh_attempt_number || 0), refreshNextRetryAt: row.refresh_next_retry_at || "", refreshAttemptedAt: row.refresh_attempted_at || "",
    batchId: row.batch_id, applicationStatus: row.application_status || "", applicationNote: row.application_note || "",
    applicationReasonCode: row.application_reason_code || "", applicationUpdatedAt: row.application_updated_at || "", reviewAt: row.review_at || "",
    followUpNote: row.follow_up_note || "", followUpUpdatedAt: row.follow_up_updated_at || ""
  };
}

function applyJobQualityGovernance(jobs, options = {}) {
  const groups = new Map();
  for (const job of jobs) {
    const key = [job.company, job.title, job.location].map(normalizeDedupeText).join("|");
    if (key === "||") continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  const configuredNow = Date.parse(options.now || "");
  const now = Number.isFinite(configuredNow) ? configuredNow : Date.now();
  const maxActiveDays = Number.isFinite(Number(options.maxActiveDays)) ? Math.max(0, Number(options.maxActiveDays)) : 3;
  return jobs.map((job) => {
    const qualityTags = [...(job.qualityTags || [])];
    const key = [job.company, job.title, job.location].map(normalizeDedupeText).join("|");
    const duplicates = groups.get(key) || [];
    if (duplicates.length > 1 && !qualityTags.includes("possible_duplicate")) qualityTags.push("possible_duplicate");
    const changed = Boolean(job.previousContentHash && job.previousContentHash !== observationContentHash(job));
    if (changed && !qualityTags.includes("detail_changed")) qualityTags.push("detail_changed");
    const seenAt = Date.parse(job.lastSeenAt || "");
    const daysSinceLastSeen = Number.isFinite(seenAt) ? Math.floor((now - seenAt) / (24 * 60 * 60 * 1000)) : null;
    const hasActivitySnapshot = job.bossActiveDays !== null && job.bossActiveDays !== undefined && job.bossActiveDays !== "" && Number.isFinite(Number(job.bossActiveDays));
    const effectiveBossActiveDays = hasActivitySnapshot && daysSinceLastSeen !== null ? Math.max(0, Number(job.bossActiveDays) + Math.max(0, daysSinceLastSeen)) : (hasActivitySnapshot ? Number(job.bossActiveDays) : null);
    if (hasActivitySnapshot && daysSinceLastSeen > 0 && !qualityTags.includes("activity_snapshot_aged")) qualityTags.push("activity_snapshot_aged");
    if (effectiveBossActiveDays !== null && effectiveBossActiveDays > maxActiveDays && !qualityTags.includes("stale_or_unknown_active")) qualityTags.push("stale_or_unknown_active");
    if (daysSinceLastSeen !== null && daysSinceLastSeen >= 14 && !qualityTags.includes("needs_recheck")) qualityTags.push("needs_recheck");
    const enriched = { ...job, qualityTags, weakDuplicateCount: duplicates.length, detailChanged: changed, daysSinceLastSeen, activityObservedAt: hasActivitySnapshot ? job.lastSeenAt : "", effectiveBossActiveDays };
    return { ...enriched, decisionBucket: decisionBucket(enriched) };
  });
}

function isActivityProbeDue(job, { now = Date.now(), maxActiveDays = 3 } = {}) {
  const observedDays = Number(job?.bossActiveDays);
  const effectiveDays = Number(job?.effectiveBossActiveDays);
  if (!Number.isFinite(observedDays) || !Number.isFinite(effectiveDays)) return false;
  if (observedDays > maxActiveDays || effectiveDays <= maxActiveDays) return false;
  if ((job.qualityTags || []).includes("detail_unverified")) return false;
  const nextRetryAt = Date.parse(job.refreshNextRetryAt || "");
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.parse(now);
  return !Number.isFinite(nextRetryAt) || nextRetryAt <= nowMs;
}

function decisionBucket(job) {
  const state = decisionState(job);
  if (state === "blocked") return "not_recommended";
  if (state === "refresh") return "refresh";
  const analysis = job.analysis || {};
  const semanticStatus = analysis.semanticStatus || "";
  const recommendation = recommendationTierForAnalysis(analysis);
  if (["pending", "failed", "stale"].includes(semanticStatus)) return "analysis_pending";
  if (semanticStatus === "refresh") return "refresh";
  if (semanticStatus === "partial") return "analysis_pending";
  if (decisionHardBlockers(analysis).length) return "not_recommended";
  if (semanticStatus === "blocked") return "not_recommended";
  if (semanticStatus === "complete") return analysis.jobQuality?.level === "risk" ? "not_recommended" : (recommendation || "analysis_pending");
  return "analysis_pending";
}

function recommendationTierForAnalysis(analysis = {}) {
  const raw = analysis.recommendation;
  if (!raw) return "";
  return normalizeRecommendationTier(raw, Number(analysis.recommendationSchemaVersion || 1));
}

function normalizeAnalysisForRead(analysis = {}) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) return {};
  const recommendation = recommendationTierForAnalysis(analysis);
  if (!recommendation) return { ...analysis, recommendation: null };
  if (Number(analysis.recommendationSchemaVersion || 0) >= RECOMMENDATION_SCHEMA_VERSION) return { ...analysis, recommendation };
  return { ...analysis, legacyRecommendation: analysis.recommendation, recommendation, recommendationSchemaVersion: RECOMMENDATION_SCHEMA_VERSION };
}

function observationContentHash(job) { return sourceContentHash(job); }

function sourceContentHash(job) {
  return crypto.createHash("sha256").update(JSON.stringify({
    title: job.title || "", company: job.company || "", location: job.location || "", salary: job.salary || "", experience: job.experience || "", education: job.education || "",
    tags: Array.isArray(job.tags) ? job.tags : parseJson(job.tags_json, []), description: job.description || ""
  })).digest("hex");
}

function normalizeDedupeText(value) { return String(value || "").toLowerCase().replace(/[\s\-_/()（）]/g, ""); }

function addStat(map, key, status) {
  const name = String(key || "").trim();
  if (!name) return;
  if (!map[name]) map[name] = Object.fromEntries(OUTCOME_STATUSES.map((item) => [item, 0]));
  if (!Number.isFinite(map[name][status])) map[name][status] = 0;
  map[name][status] += 1;
}

function addReasonStat(map, key, reason) {
  const name = String(key || "").trim();
  if (!name || !reason) return;
  if (!map[name]) map[name] = {};
  map[name][reason] = (map[name][reason] || 0) + 1;
}

function withFeedback(job, summary) {
  const notes = [];
  const qualityTags = [...(job.qualityTags || [])];
  if (job.firstSeenAt && job.lastSeenAt && job.firstSeenAt !== job.lastSeenAt && !qualityTags.includes("duplicate_seen")) qualityTags.push("duplicate_seen");
  const companyReasons = summary.companyReasons?.[job.company] || {};
  const keywordReasons = summary.keywordReasons?.[job.keyword] || {};
  const companyFeedback = Object.entries(companyReasons).filter(([, count]) => count > 0).map(([reason, count]) => `${reason} ${count} 次`);
  const keywordFeedback = Object.entries(keywordReasons).filter(([, count]) => count > 0).map(([reason, count]) => `${reason} ${count} 次`);
  if (companyFeedback.length) notes.push(`同公司已有反馈：${companyFeedback.join("；")}`);
  if (keywordFeedback.length) notes.push(`同关键词已有反馈：${keywordFeedback.join("；")}`);
  return { ...job, qualityTags, feedback: { penalty: 0, bonus: 0, notes }, feedbackRank: 0 };
}

function compareReportJobs(a, b) {
  return statusRank(a) - statusRank(b)
    || decisionBucketRank(a.decisionBucket) - decisionBucketRank(b.decisionBucket)
    || salaryPreferenceRank(a) - salaryPreferenceRank(b)
    || modelConfidenceRank(a) - modelConfidenceRank(b)
    || workScheduleRank(a) - workScheduleRank(b)
    || (a.feedbackRank || 0) - (b.feedbackRank || 0)
    || qualityRank(a) - qualityRank(b)
    || (a.risks || []).length - (b.risks || []).length
    || activeRank(a.effectiveBossActiveDays ?? a.bossActiveDays) - activeRank(b.effectiveBossActiveDays ?? b.bossActiveDays)
    || String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || ""));
}

function salaryPreferenceRank(job) {
  const tags = new Set(job.qualityTags || []);
  if (tags.has("salary_target_core")) return 0;
  if (tags.has("salary_target_stretch")) return 1;
  if (tags.has("salary_target_high")) return 3;
  return 2;
}

function statusRank(job) { return job.applicationStatus ? 1 : 0; }
function decisionBucketRank(bucket) { return { primary: 0, apply: 1, caution: 2, analysis_pending: 3, refresh: 4, not_recommended: 5 }[bucket] ?? 9; }
function modelConfidenceRank(job) { const confidence = Number(job.analysis?.confidence); return Number.isFinite(confidence) ? -confidence : 0; }
function activeRank(days) { return days === null || days === undefined ? 99 : Number(days); }

function qualityRank(job) {
  const tags = new Set(job.qualityTags || []);
  let value = 0;
  if (tags.has("low_value_risk")) value += 20;
  if (tags.has("location_mismatch")) value += 12;
  if (tags.has("inactive_boss")) value += 10;
  if (tags.has("stale_or_unknown_active")) value += 5;
  if (tags.has("missing_link")) value += 4;
  if (tags.has("needs_recheck")) value += 8;
  if (tags.has("possible_duplicate")) value += 6;
  if (tags.has("duplicate_seen")) value += 2;
  if (tags.has("experience_stretch")) value += 1;
  if (tags.has("salary_unverified")) value += 2;
  if (tags.has("experience_unverified")) value += 2;
  if (tags.has("core_stack_mismatch")) value += 12;
  if (tags.has("java_backend_heavy")) value += 6;
  if (tags.has("senior_engineering_heavy")) value += 6;
  return value;
}

function workScheduleRank(job) {
  const tags = new Set(job.qualityTags || []);
  if (tags.has("work_schedule_low_priority")) return 4;
  if (tags.has("work_schedule_single")) return 3;
  if (tags.has("work_schedule_alternating")) return 2;
  if (tags.has("work_schedule_unknown")) return 1;
  return 0;
}

function queueRank(job) {
  const status = job.applicationStatus || "pending";
  if (status === "review") return 0;
  if (status === "pending") return 1;
  return 2;
}

module.exports = {
  upsertKeywordSource, upsertJob, listReportJobs, markApplication, bindBatchToPlan, rescorePlanObservations,
  reassessBatchObservations, addFollowUpNote, recordCandidateJobEvent, listCandidateJobEvents, recordRecommendationFeedback,
  markCandidateJob, buildFeedbackSummary, buildBatchSummary, getLatestBatchId, getLatestMainScanBatchId, listDecisionPool,
  getOutcomeAnalyticsSnapshot, listDecisionQueue, isJobAwaitingAction, decisionBucket, applyJobQualityGovernance,
  isActivityProbeDue, sourceContentHash, getModelCache, saveModelCache
};
