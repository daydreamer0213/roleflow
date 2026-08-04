const { decisionBucket } = require("./storage");
const { workflowEligibility } = require("./workflow_inventory");

function listScopedKeywordStats(db, {
  profileId,
  scopeKey,
  localDay,
  now = new Date().toISOString()
} = {}) {
  const normalizedProfileId = Number(profileId);
  const normalizedScopeKey = String(scopeKey || "").trim();
  if (!Number.isInteger(normalizedProfileId) || normalizedProfileId <= 0 || !normalizedScopeKey) {
    return new Map();
  }
  const rows = db.prepare(`WITH ranked AS (
      SELECT jobs.source, jobs.source_id, o.keyword, o.url, o.boss_active_days,
        o.description, o.quality_tags_json, o.analysis_json,
        ROW_NUMBER() OVER (
          PARTITION BY jobs.source, jobs.source_id, o.keyword
          ORDER BY o.seen_at DESC, o.id DESC
        ) AS observation_rank
      FROM job_observations o
      JOIN jobs ON jobs.id = o.job_id
      JOIN batches b ON b.id = o.batch_id
      WHERE b.profile_id = ?
        AND json_extract(b.filter_snapshot_json, '$.execution.searchScope.key') = ?
    )
    SELECT * FROM ranked WHERE observation_rank = 1`)
    .all(normalizedProfileId, normalizedScopeKey);
  const usedRows = /^\d{4}-\d{2}-\d{2}$/.test(String(localDay || ""))
    ? db.prepare(`SELECT keywords_json FROM workflow_runs
        WHERE profile_id = ? AND local_day = ?
          AND json_extract(planner_json, '$.searchScope.key') = ?`)
      .all(normalizedProfileId, String(localDay), normalizedScopeKey)
    : [];
  const usedToday = new Set(usedRows.flatMap((row) =>
    parseJson(row.keywords_json, []).map((item) => String(item?.word || item || "").trim())
  ).filter(Boolean));
  const stats = new Map();
  for (const row of rows) {
    const word = String(row.keyword || "").trim();
    if (!word) continue;
    const qualityTags = parseJson(row.quality_tags_json, []);
    const analysis = parseJson(row.analysis_json, {});
    const job = {
      source: row.source,
      sourceId: row.source_id,
      keyword: word,
      url: row.url || "",
      bossActiveDays: row.boss_active_days,
      description: row.description || "",
      qualityTags,
      analysis,
      applicationStatus: "",
      applicationReasonCode: "",
      reviewAt: ""
    };
    job.decisionBucket = decisionBucket(job);
    const current = stats.get(word) || {
      sampleSize: 0,
      eligibleCount: 0,
      usedToday: usedToday.has(word)
    };
    current.sampleSize += 1;
    if (workflowEligibility(job, { now }).eligible) current.eligibleCount += 1;
    stats.set(word, current);
  }
  for (const word of usedToday) {
    if (!stats.has(word)) {
      stats.set(word, { sampleSize: 0, eligibleCount: 0, usedToday: true });
    }
  }
  return stats;
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

module.exports = { listScopedKeywordStats };
