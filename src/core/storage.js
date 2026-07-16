const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { scoreJob, decisionState, parseWorkSchedule } = require("./scoring");
const { parseBossActivityText } = require("../adapters/sites/boss");
const { mergeJobMetadata } = require("./job_metadata");
const { NEGATIVE_FEEDBACK_STATUSES, normalizeFeedbackReason } = require("./feedback");
const { buildAnalysisRevision, analysisStaleReasons } = require("./analysis_revision");
const { effectiveHardBlockers } = require("./model_contract");

const OUTCOME_STATUSES = ["applied", "skipped", "no_reply", "review", "later", "interview", "rejected", "invalid", "salary_mismatch"];
const VALID_CANDIDATE_STATUSES = new Set(OUTCOME_STATUSES);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL,
  keyword TEXT,
  started_at TEXT NOT NULL,
  note TEXT,
  profile_id INTEGER,
  search_plan_id INTEGER,
  filter_snapshot_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS candidate_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  source_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resume_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  original_file_name TEXT NOT NULL,
  format TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  resume_text TEXT NOT NULL,
  text_truncated INTEGER NOT NULL DEFAULT 0,
  diagnostics_json TEXT NOT NULL DEFAULT '{}',
  stored_file_path TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);

CREATE TABLE IF NOT EXISTS resume_parse_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER,
  original_file_name TEXT NOT NULL,
  format TEXT,
  input_bytes INTEGER NOT NULL DEFAULT 0,
  extraction_method TEXT,
  char_count INTEGER NOT NULL DEFAULT 0,
  preview TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);

CREATE TABLE IF NOT EXISTS candidate_resume_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  resume_document_id INTEGER,
  version_key TEXT NOT NULL,
  name TEXT NOT NULL,
  target_roles_json TEXT NOT NULL DEFAULT '[]',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  primary_projects_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  analysis_json TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, version_key),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(resume_document_id) REFERENCES resume_documents(id)
);

CREATE TABLE IF NOT EXISTS search_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  profile_version_id INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  keyword TEXT,
  title TEXT NOT NULL,
  company TEXT,
  location TEXT,
  salary TEXT,
  experience TEXT,
  education TEXT,
  boss_active_text TEXT,
  boss_active_days INTEGER,
  url TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  level TEXT,
  matches_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  quality_tags_json TEXT NOT NULL DEFAULT '[]',
  greeting TEXT,
  analysis_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  batch_id INTEGER,
  UNIQUE(source, source_id)
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keyword_sources (
  keyword TEXT PRIMARY KEY,
  source TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_filter_catalogs (
  site TEXT PRIMARY KEY,
  catalog_json TEXT NOT NULL,
  source TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  batch_id INTEGER NOT NULL,
  keyword TEXT,
  title TEXT NOT NULL,
  company TEXT,
  location TEXT,
  salary TEXT,
  experience TEXT,
  education TEXT,
  boss_active_text TEXT,
  boss_active_days INTEGER,
  url TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  level TEXT,
  matches_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  quality_tags_json TEXT NOT NULL DEFAULT '[]',
  greeting TEXT,
  analysis_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  content_hash_version INTEGER NOT NULL DEFAULT 1,
  seen_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id),
  FOREIGN KEY(batch_id) REFERENCES batches(id),
  UNIQUE(batch_id, job_id)
);

CREATE TABLE IF NOT EXISTS candidate_job_states (
  profile_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  plan_id INTEGER,
  status TEXT NOT NULL,
  reason_code TEXT,
  note TEXT,
  review_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, job_id),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS candidate_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  plan_id INTEGER,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS profile_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  resume_document_id INTEGER,
  profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(resume_document_id) REFERENCES resume_documents(id)
);

CREATE TABLE IF NOT EXISTS candidate_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user_provided',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, fact_key),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);

CREATE TABLE IF NOT EXISTS model_cache (
  cache_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_target_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  target_key TEXT NOT NULL,
  city TEXT,
  keyword TEXT,
  lane_id TEXT,
  status TEXT NOT NULL,
  job_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  FOREIGN KEY(batch_id) REFERENCES batches(id)
);

CREATE TABLE IF NOT EXISTS site_runtime_states (
  site TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  reason_code TEXT,
  message TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_refresh_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  result TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  attempt_number INTEGER NOT NULL,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_job_observations_batch ON job_observations(batch_id, job_id);
CREATE INDEX IF NOT EXISTS idx_candidate_job_states_profile ON candidate_job_states(profile_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_candidate_job_events_profile_job ON candidate_job_events(profile_id, job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_profile_versions_profile ON profile_versions(profile_id, created_at);
CREATE INDEX IF NOT EXISTS idx_candidate_facts_profile ON candidate_facts(profile_id, fact_key);
CREATE INDEX IF NOT EXISTS idx_resume_parse_attempts_profile ON resume_parse_attempts(profile_id, created_at);
CREATE INDEX IF NOT EXISTS idx_candidate_resume_versions_profile ON candidate_resume_versions(profile_id, is_active, updated_at);
CREATE INDEX IF NOT EXISTS idx_platform_filter_catalogs_updated ON platform_filter_catalogs(updated_at);
CREATE INDEX IF NOT EXISTS idx_scan_target_results_batch ON scan_target_results(batch_id, target_key, attempt_number);
CREATE INDEX IF NOT EXISTS idx_job_refresh_attempts_job ON job_refresh_attempts(job_id, created_at);
`;

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function migrate(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name));
  if (!columns.has("analysis_json")) {
    db.exec("ALTER TABLE jobs ADD COLUMN analysis_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!columns.has("quality_tags_json")) {
    db.exec("ALTER TABLE jobs ADD COLUMN quality_tags_json TEXT NOT NULL DEFAULT '[]'");
  }
  const batchColumns = new Set(db.prepare("PRAGMA table_info(batches)").all().map((column) => column.name));
  if (!batchColumns.has("profile_id")) db.exec("ALTER TABLE batches ADD COLUMN profile_id INTEGER");
  if (!batchColumns.has("search_plan_id")) db.exec("ALTER TABLE batches ADD COLUMN search_plan_id INTEGER");
  if (!batchColumns.has("filter_snapshot_json")) db.exec("ALTER TABLE batches ADD COLUMN filter_snapshot_json TEXT NOT NULL DEFAULT '{}'");
  const resumeColumns = new Set(db.prepare("PRAGMA table_info(resume_documents)").all().map((column) => column.name));
  if (!resumeColumns.has("diagnostics_json")) db.exec("ALTER TABLE resume_documents ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '{}'");
  if (!resumeColumns.has("stored_file_path")) db.exec("ALTER TABLE resume_documents ADD COLUMN stored_file_path TEXT");
  const resumeVersionColumns = new Set(db.prepare("PRAGMA table_info(candidate_resume_versions)").all().map((column) => column.name));
  if (!resumeVersionColumns.has("analysis_json")) db.exec("ALTER TABLE candidate_resume_versions ADD COLUMN analysis_json TEXT NOT NULL DEFAULT '{}'");
  const planColumns = new Set(db.prepare("PRAGMA table_info(search_plans)").all().map((column) => column.name));
  if (!planColumns.has("profile_version_id")) db.exec("ALTER TABLE search_plans ADD COLUMN profile_version_id INTEGER");
  const observationColumns = new Set(db.prepare("PRAGMA table_info(job_observations)").all().map((column) => column.name));
  if (!observationColumns.has("content_hash_version")) db.exec("ALTER TABLE job_observations ADD COLUMN content_hash_version INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    INSERT OR IGNORE INTO job_observations(
      job_id, batch_id, keyword, title, company, location, salary, experience, education,
      boss_active_text, boss_active_days, url, tags_json, description, score, level,
      matches_json, risks_json, quality_tags_json, greeting, analysis_json, content_hash, content_hash_version, seen_at
    )
    SELECT id, batch_id, keyword, title, company, location, salary, experience, education,
      boss_active_text, boss_active_days, url, tags_json, description, score, level,
      matches_json, risks_json, quality_tags_json, greeting, analysis_json, 'legacy:' || id, 0, last_seen_at
    FROM jobs WHERE batch_id IS NOT NULL
  `);
  db.exec(`
    UPDATE candidate_resume_versions
    SET analysis_json = COALESCE((SELECT profile_json FROM candidate_profiles WHERE id = candidate_resume_versions.profile_id), '{}')
    WHERE analysis_json IS NULL OR analysis_json = '{}'
  `);
  db.exec(`
    UPDATE search_plans
    SET profile_version_id = (SELECT id FROM profile_versions WHERE profile_id = search_plans.profile_id ORDER BY created_at DESC, id DESC LIMIT 1)
    WHERE profile_version_id IS NULL
  `);
  db.exec(`
    INSERT OR IGNORE INTO candidate_job_states(profile_id, job_id, plan_id, status, reason_code, note, review_at, updated_at)
    SELECT batches.profile_id, jobs.id, batches.search_plan_id, applications.status, NULL, applications.note, NULL, applications.updated_at
    FROM applications
    JOIN jobs ON jobs.id = applications.job_id
    JOIN batches ON batches.id = jobs.batch_id
    WHERE batches.profile_id IS NOT NULL
      AND applications.id = (SELECT id FROM applications a2 WHERE a2.job_id = applications.job_id ORDER BY a2.updated_at DESC, a2.id DESC LIMIT 1)
  `);
  db.exec(`
    INSERT INTO profile_versions(profile_id, resume_document_id, profile_json, created_at)
    SELECT candidate_profiles.id, NULL, candidate_profiles.profile_json, candidate_profiles.updated_at
    FROM candidate_profiles
    WHERE NOT EXISTS (SELECT 1 FROM profile_versions pv WHERE pv.profile_id = candidate_profiles.id)
  `);
  db.exec(`
    INSERT OR IGNORE INTO candidate_resume_versions(
      profile_id, resume_document_id, version_key, name, target_roles_json, keywords_json,
      primary_projects_json, summary, is_active, created_at, updated_at
    )
    SELECT rd.profile_id, rd.id, 'document_' || rd.id, rd.original_file_name, '[]', '[]', '[]', '', 1, rd.created_at, rd.created_at
    FROM resume_documents rd
    WHERE NOT EXISTS (SELECT 1 FROM candidate_resume_versions rv WHERE rv.resume_document_id = rd.id)
  `);
  backfillObservationContentHashes(db);
  backfillWorkSchedules(db);
}

function backfillObservationContentHashes(db) {
  const rows = db.prepare(`
    SELECT id, title, company, location, salary, experience, education, tags_json, description
    FROM job_observations
    WHERE content_hash_version < 1
  `).all();
  const update = db.prepare("UPDATE job_observations SET content_hash = ?, content_hash_version = 1 WHERE id = ?");
  for (const row of rows) update.run(sourceContentHash({ ...row, tags: parseJson(row.tags_json, []) }), row.id);
}

function backfillWorkSchedules(db) {
  const rows = db.prepare(`
    SELECT id, description, quality_tags_json, analysis_json
    FROM job_observations
    WHERE quality_tags_json NOT LIKE '%work_schedule_%'
  `).all();
  const update = db.prepare("UPDATE job_observations SET quality_tags_json = ?, analysis_json = ? WHERE id = ?");
  for (const row of rows) {
    const schedule = parseWorkSchedule(row.description || "");
    const qualityTags = (parseJson(row.quality_tags_json, []) || []).filter((tag) => !String(tag).startsWith("work_schedule_"));
    qualityTags.push(workScheduleQualityTag(schedule.kind));
    const analysis = {
      ...parseJson(row.analysis_json, {}),
      workSchedule: schedule.kind,
      workScheduleEvidence: schedule.evidence
    };
    update.run(JSON.stringify([...new Set(qualityTags)]), JSON.stringify(analysis), row.id);
  }
}

function workScheduleQualityTag(kind) {
  return {
    double_weekend: "work_schedule_double",
    alternating_weekend: "work_schedule_alternating",
    single_weekend: "work_schedule_single",
    unknown: "work_schedule_unknown"
  }[kind] || "work_schedule_unknown";
}

function nowIso() {
  return new Date().toISOString();
}

function createBatch(db, site, keyword, note = "", context = {}) {
  const started = nowIso();
  const stmt = db.prepare("INSERT INTO batches(site, keyword, started_at, note, profile_id, search_plan_id, filter_snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const result = stmt.run(site, keyword || null, started, note, context.profileId || null, context.searchPlanId || null, JSON.stringify(context.filterSnapshot || {}));
  return Number(result.lastInsertRowid);
}

function recordScanTargetResult(db, input = {}) {
  const batchId = Number(input.batchId || 0);
  const targetKey = String(input.targetKey || "").trim();
  if (!Number.isInteger(batchId) || batchId <= 0) throw new Error("scan target batchId is required");
  if (!targetKey) throw new Error("scan target key is required");
  const attemptNumber = Number(db.prepare("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM scan_target_results WHERE batch_id = ? AND target_key = ?").get(batchId, targetKey)?.n || 1);
  const finishedAt = String(input.finishedAt || nowIso());
  const startedAt = String(input.startedAt || finishedAt);
  db.prepare(`INSERT INTO scan_target_results(
    batch_id, target_key, city, keyword, lane_id, status, job_count, error_code, error_message,
    attempt_number, started_at, finished_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      batchId,
      targetKey,
      String(input.city || "") || null,
      String(input.keyword || "") || null,
      String(input.laneId || "") || null,
      String(input.status || "failed"),
      Math.max(0, Number(input.jobCount || 0)),
      String(input.errorCode || "") || null,
      String(input.errorMessage || "").slice(0, 1000) || null,
      attemptNumber,
      startedAt,
      finishedAt
    );
  return attemptNumber;
}

function listScanTargetResults(db, batchId) {
  return db.prepare("SELECT * FROM scan_target_results WHERE batch_id = ? ORDER BY id").all(Number(batchId)).map((row) => ({
    id: Number(row.id),
    batchId: Number(row.batch_id),
    targetKey: row.target_key,
    city: row.city || "",
    keyword: row.keyword || "",
    laneId: row.lane_id || "",
    status: row.status,
    jobCount: Number(row.job_count || 0),
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    attemptNumber: Number(row.attempt_number || 1),
    startedAt: row.started_at,
    finishedAt: row.finished_at
  }));
}

function getSiteRuntimeState(db, site) {
  const row = db.prepare("SELECT * FROM site_runtime_states WHERE site = ?").get(String(site || "").trim().toLowerCase());
  return row ? {
    site: row.site,
    status: row.status,
    reasonCode: row.reason_code || "",
    message: row.message || "",
    details: parseJson(row.details_json, {}),
    updatedAt: row.updated_at
  } : null;
}

function setSiteRuntimeState(db, site, input = {}) {
  const normalizedSite = String(site || "").trim().toLowerCase();
  if (!normalizedSite) throw new Error("site runtime state requires a site");
  db.prepare(`
    INSERT INTO site_runtime_states(site, status, reason_code, message, details_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(site) DO UPDATE SET status=excluded.status, reason_code=excluded.reason_code,
      message=excluded.message, details_json=excluded.details_json, updated_at=excluded.updated_at
  `).run(
    normalizedSite,
    String(input.status || "ready"),
    String(input.reasonCode || "") || null,
    String(input.message || "").slice(0, 1000) || null,
    JSON.stringify(input.details || {}),
    nowIso()
  );
  return getSiteRuntimeState(db, normalizedSite);
}

function clearSiteRuntimeState(db, site) {
  db.prepare("DELETE FROM site_runtime_states WHERE site = ?").run(String(site || "").trim().toLowerCase());
}

function listReusableJobDetails(db, { site = "boss", profileId = 0, maxAgeDays = 7 } = {}) {
  const parsedDays = Number(maxAgeDays);
  const days = Number.isFinite(parsedDays) ? Math.max(1, Math.min(30, parsedDays)) : 7;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const normalizedProfileId = Number(profileId || 0);
  const rows = db.prepare(`
    WITH reusable AS (
      SELECT jobs.source_id, o.salary, o.experience, o.education, o.boss_active_text,
        o.description, o.seen_at,
        ROW_NUMBER() OVER (PARTITION BY jobs.source_id ORDER BY o.seen_at DESC, o.id DESC) AS detail_rank
      FROM job_observations o
      JOIN jobs ON jobs.id = o.job_id
      JOIN batches b ON b.id = o.batch_id
      WHERE jobs.source = ?
        AND LENGTH(TRIM(COALESCE(o.description, ''))) >= 120
        AND o.seen_at >= ?
        AND (? <= 0 OR b.profile_id = ?)
    )
    SELECT * FROM reusable WHERE detail_rank = 1
  `).all(String(site || "boss"), cutoff, normalizedProfileId, normalizedProfileId);
  return rows.map((row) => ({
    sourceId: row.source_id,
    salary: row.salary || "",
    experience: row.experience || "",
    education: row.education || "",
    bossActiveText: Date.parse(row.seen_at) >= Date.now() - 3 * 24 * 60 * 60 * 1000 ? (row.boss_active_text || "") : "",
    description: row.description || "",
    seenAt: row.seen_at
  }));
}

function recordJobRefreshAttempt(db, input = {}) {
  const jobId = Number(input.jobId || 0);
  if (!Number.isInteger(jobId) || jobId <= 0) throw new Error("refresh attempt jobId is required");
  const exists = db.prepare("SELECT id FROM jobs WHERE id = ?").get(jobId);
  if (!exists) throw new Error("refresh attempt job not found");
  const attemptNumber = Number(db.prepare("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM job_refresh_attempts WHERE job_id = ?").get(jobId)?.n || 1);
  db.prepare(`INSERT INTO job_refresh_attempts(
    job_id, result, error_code, error_message, attempt_number, next_retry_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      jobId,
      String(input.result || "failed"),
      String(input.errorCode || "") || null,
      String(input.errorMessage || "").slice(0, 1000) || null,
      attemptNumber,
      String(input.nextRetryAt || "") || null,
      String(input.createdAt || nowIso())
    );
  return attemptNumber;
}

function listJobRefreshAttempts(db, jobId, { limit = 20 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  return db.prepare("SELECT * FROM job_refresh_attempts WHERE job_id = ? ORDER BY id DESC LIMIT ?").all(Number(jobId), safeLimit).map((row) => ({
    id: Number(row.id),
    jobId: Number(row.job_id),
    result: row.result,
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    attemptNumber: Number(row.attempt_number),
    nextRetryAt: row.next_retry_at || "",
    createdAt: row.created_at
  }));
}

function getLatestJobRefreshAttempt(db, jobId) {
  return listJobRefreshAttempts(db, jobId, { limit: 1 })[0] || null;
}

function getPlatformFilterCatalog(db, site) {
  const row = db.prepare("SELECT * FROM platform_filter_catalogs WHERE site = ?").get(String(site || "").trim());
  if (!row) return null;
  return {
    site: row.site,
    catalog: parseJson(row.catalog_json, {}),
    source: row.source || "",
    discoveredAt: row.discovered_at || "",
    updatedAt: row.updated_at || ""
  };
}

function savePlatformFilterCatalog(db, { site, catalog, source = "live_dom", discoveredAt = nowIso() } = {}) {
  const normalizedSite = String(site || "").trim();
  if (!normalizedSite) throw new Error("platform filter catalog site is required");
  const now = nowIso();
  db.prepare(`INSERT INTO platform_filter_catalogs(site, catalog_json, source, discovered_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(site) DO UPDATE SET catalog_json=excluded.catalog_json, source=excluded.source,
      discovered_at=excluded.discovered_at, updated_at=excluded.updated_at`
  ).run(normalizedSite, JSON.stringify(catalog || {}), String(source || "live_dom"), String(discoveredAt || now), now);
  return getPlatformFilterCatalog(db, normalizedSite);
}

function saveProfileAnalysis(db, { profileId = null, profile, document, searchPlan }) {
  const now = nowIso();
  const displayName = profile?.candidate?.name || "候选人";
  db.exec("BEGIN");
  try {
    let id = Number(profileId || 0);
    if (id && db.prepare("SELECT id FROM candidate_profiles WHERE id = ?").get(id)) {
      db.prepare("UPDATE candidate_profiles SET display_name = ?, profile_json = ?, source_hash = ?, updated_at = ? WHERE id = ?")
        .run(displayName, JSON.stringify(profile), document.contentHash, now, id);
    } else {
      id = Number(db.prepare("INSERT INTO candidate_profiles(display_name, profile_json, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(displayName, JSON.stringify(profile), document.contentHash, now, now).lastInsertRowid);
    }
    const documentId = insertResumeDocument(db, id, document, now);
    const profileVersionId = Number(db.prepare("INSERT INTO profile_versions(profile_id, resume_document_id, profile_json, created_at) VALUES (?, ?, ?, ?)")
      .run(id, documentId, JSON.stringify(profile), now).lastInsertRowid);
    const resumeVersionId = createCandidateResumeVersion(db, {
      profileId: id,
      resumeDocumentId: documentId,
      version: { ...resumeVersionDefaults(profile, document), analysis: profile },
      now
    });
    const planId = searchPlan ? saveSearchPlan(db, { profileId: id, profileVersionId, plan: searchPlan, now }) : null;
    db.exec("COMMIT");
    return { profileId: id, profileVersionId, resumeVersionId, resumeDocumentId: documentId, planId };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function insertResumeDocument(db, profileId, document, now = nowIso()) {
  const result = db.prepare(`INSERT INTO resume_documents(
    profile_id, original_file_name, format, content_hash, resume_text, text_truncated, diagnostics_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    Number(profileId),
    String(document.originalFileName || "resume"),
    String(document.format || "text"),
    String(document.contentHash || ""),
    String(document.text || ""),
    document.textTruncated ? 1 : 0,
    JSON.stringify(document.diagnostics || {}),
    now
  );
  return Number(result.lastInsertRowid);
}

function attachResumeDocumentFile(db, documentId, storedFilePath) {
  const result = db.prepare("UPDATE resume_documents SET stored_file_path = ? WHERE id = ?")
    .run(String(storedFilePath || "") || null, Number(documentId));
  if (!result.changes) throw new Error("resume document not found");
}

function getResumeDocument(db, documentId) {
  const row = db.prepare("SELECT * FROM resume_documents WHERE id = ?").get(Number(documentId));
  if (!row) return null;
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    originalFileName: row.original_file_name,
    format: row.format,
    contentHash: row.content_hash,
    storedFilePath: row.stored_file_path || "",
    createdAt: row.created_at
  };
}

function resumeVersionDefaults(profile = {}, document = {}) {
  const candidate = profile.candidate || {};
  return {
    name: document.originalFileName || "基础简历",
    targetRoles: candidate.targetTitles || [],
    keywords: (profile.skills || []).map((item) => item.name || item).filter(Boolean).slice(0, 12),
    primaryProjects: (profile.projects || []).map((item) => item.name || item).filter(Boolean).slice(0, 4),
    summary: "从本次简历解析创建，可按投递方向编辑。",
    isActive: true
  };
}

function createCandidateResumeVersion(db, { profileId, resumeDocumentId = null, version = {}, now = nowIso() }) {
  const documentId = Number(resumeDocumentId || 0) || null;
  const versionKey = documentId ? `resume_${documentId}` : `resume_manual_${crypto.randomUUID()}`;
  const result = db.prepare(`
    INSERT INTO candidate_resume_versions(
      profile_id, resume_document_id, version_key, name, target_roles_json, keywords_json,
      primary_projects_json, summary, analysis_json, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(profileId), documentId, versionKey, String(version.name || "简历版本"),
    JSON.stringify(stringList(version.targetRoles, 8)),
    JSON.stringify(stringList(version.keywords, 16)),
    JSON.stringify(stringList(version.primaryProjects, 6)),
    String(version.summary || ""),
    JSON.stringify(version.analysis || {}),
    version.isActive === false ? 0 : 1, now, now
  );
  return Number(result.lastInsertRowid);
}

function stringList(value, limit) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

function saveSearchPlan(db, { id = null, profileId, profileVersionId = null, plan, now = nowIso() }) {
  const name = String(plan?.name || "岗位筛选计划").trim() || "岗位筛选计划";
  const currentId = Number(id || 0);
  const boundProfileVersionId = Number(profileVersionId || getLatestProfileVersionId(db, profileId) || 0) || null;
  db.prepare("UPDATE search_plans SET is_active = 0, updated_at = ? WHERE profile_id = ?").run(now, profileId);
  if (currentId && db.prepare("SELECT id FROM search_plans WHERE id = ? AND profile_id = ?").get(currentId, profileId)) {
    db.prepare("UPDATE search_plans SET name = ?, plan_json = ?, profile_version_id = ?, is_active = 1, updated_at = ? WHERE id = ?")
      .run(name, JSON.stringify(plan), boundProfileVersionId, now, currentId);
    return currentId;
  }
  return Number(db.prepare(`INSERT INTO search_plans(profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)`)
    .run(profileId, name, JSON.stringify(plan), boundProfileVersionId, now, now).lastInsertRowid);
}

function getCandidateProfile(db, profileId) {
  const row = db.prepare("SELECT * FROM candidate_profiles WHERE id = ?").get(Number(profileId));
  return row ? profileRow(row) : null;
}

function listCandidateProfiles(db) {
  return db.prepare(`SELECT candidate_profiles.*, (
    SELECT id FROM search_plans WHERE profile_id = candidate_profiles.id ORDER BY is_active DESC, updated_at DESC, id DESC LIMIT 1
  ) AS active_plan_id FROM candidate_profiles ORDER BY updated_at DESC, id DESC`).all().map((row) => ({ ...profileRow(row), activePlanId: row.active_plan_id || null }));
}

function saveCandidateResumeVersion(db, { profileId, versionId = null, document = null, version = {} }) {
  const profile = Number(profileId);
  if (!db.prepare("SELECT id FROM candidate_profiles WHERE id = ?").get(profile)) throw new Error("candidate profile not found");
  const now = nowIso();
  db.exec("BEGIN");
  try {
    let documentId = null;
    if (document) documentId = insertResumeDocument(db, profile, document, now);
    const existingId = Number(versionId || 0);
    if (existingId) {
      const existing = db.prepare("SELECT id, resume_document_id, analysis_json FROM candidate_resume_versions WHERE id = ? AND profile_id = ?").get(existingId, profile);
      if (!existing) throw new Error("resume version not found");
      db.prepare(`UPDATE candidate_resume_versions SET
        resume_document_id = ?, name = ?, target_roles_json = ?, keywords_json = ?, primary_projects_json = ?,
        summary = ?, analysis_json = ?, is_active = ?, updated_at = ? WHERE id = ?`).run(
        documentId || existing.resume_document_id || null, String(version.name || "简历版本"),
        JSON.stringify(stringList(version.targetRoles, 8)), JSON.stringify(stringList(version.keywords, 16)),
        JSON.stringify(stringList(version.primaryProjects, 6)), String(version.summary || ""),
        JSON.stringify(version.analysis || parseJson(existing.analysis_json, {})),
        version.isActive === false ? 0 : 1, now, existingId
      );
      db.exec("COMMIT");
      return { versionId: existingId, resumeDocumentId: documentId || existing.resume_document_id || null };
    }
    const createdId = createCandidateResumeVersion(db, { profileId: profile, resumeDocumentId: documentId, version, now });
    db.exec("COMMIT");
    return { versionId: createdId, resumeDocumentId: documentId };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function listCandidateResumeVersions(db, profileId) {
  return db.prepare(`
    SELECT rv.*, rd.original_file_name, rd.format, rd.content_hash, rd.resume_text, rd.diagnostics_json, rd.stored_file_path
    FROM candidate_resume_versions rv
    LEFT JOIN resume_documents rd ON rd.id = rv.resume_document_id
    WHERE rv.profile_id = ?
    ORDER BY rv.is_active DESC, rv.updated_at DESC, rv.id DESC
  `).all(Number(profileId)).map((row) => ({
    id: Number(row.id),
    versionKey: row.version_key,
    name: row.name,
    targetRoles: parseJson(row.target_roles_json, []),
    keywords: parseJson(row.keywords_json, []),
    primaryProjects: parseJson(row.primary_projects_json, []),
    summary: row.summary || "",
    analysis: parseJson(row.analysis_json, {}),
    isActive: Boolean(row.is_active),
    resumeDocumentId: row.resume_document_id || null,
    fileName: row.original_file_name || "",
    format: row.format || "",
    contentHash: row.content_hash || "",
    storedFilePath: row.stored_file_path || "",
    resumeTextExcerpt: String(row.resume_text || "").slice(0, 6000),
    diagnostics: parseJson(row.diagnostics_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function recordResumeParseAttempt(db, { profileId = null, document = null, fileName = "resume", format = "", inputBytes = 0, error = null }) {
  const diagnostics = document?.diagnostics || error?.details?.diagnostics || {};
  db.prepare(`INSERT INTO resume_parse_attempts(
    profile_id, original_file_name, format, input_bytes, extraction_method, char_count, preview,
    diagnostics_json, status, error_code, error_message, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    Number(profileId || 0) || null,
    String(document?.originalFileName || fileName || "resume"),
    String(document?.format || format || ""),
    Number(document?.diagnostics?.inputBytes || inputBytes || 0),
    String(document?.diagnostics?.extractionMethod || diagnostics.extractionMethod || ""),
    Number(document?.charCount || diagnostics.charCount || 0),
    String(document?.diagnostics?.preview || diagnostics.preview || "").slice(0, 600),
    JSON.stringify(diagnostics),
    error ? "failed" : "succeeded",
    error?.code || null,
    error ? String(error.message || "parse failed").slice(0, 500) : null,
    nowIso()
  );
}

function listResumeParseAttempts(db, profileId, limit = 12) {
  return db.prepare(`SELECT * FROM resume_parse_attempts
    WHERE profile_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(
    Number(profileId), Math.max(1, Math.min(50, Number(limit) || 12))
  ).map((row) => ({
    id: Number(row.id), fileName: row.original_file_name, format: row.format || "", inputBytes: Number(row.input_bytes || 0),
    extractionMethod: row.extraction_method || "", charCount: Number(row.char_count || 0), preview: row.preview || "",
    diagnostics: parseJson(row.diagnostics_json, {}), status: row.status, errorCode: row.error_code || "",
    errorMessage: row.error_message || "", createdAt: row.created_at
  }));
}

function updateCandidateProfile(db, { profileId, profile }) {
  const id = Number(profileId);
  const existing = getCandidateProfile(db, id);
  if (!existing) throw new Error("candidate profile not found");
  const now = nowIso();
  const displayName = profile?.candidate?.name || existing.displayName || "候选人";
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE candidate_profiles SET display_name = ?, profile_json = ?, updated_at = ? WHERE id = ?")
      .run(displayName, JSON.stringify(profile), now, id);
    db.prepare("INSERT INTO profile_versions(profile_id, resume_document_id, profile_json, created_at) VALUES (?, NULL, ?, ?)")
      .run(id, JSON.stringify(profile), now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getCandidateProfile(db, id);
}

function getSearchPlan(db, planId) {
  const row = db.prepare("SELECT * FROM search_plans WHERE id = ?").get(Number(planId));
  return row ? planRow(row) : null;
}

function getActiveSearchPlan(db, profileId) {
  const row = db.prepare("SELECT * FROM search_plans WHERE profile_id = ? ORDER BY is_active DESC, updated_at DESC, id DESC LIMIT 1").get(Number(profileId));
  return row ? planRow(row) : null;
}

function listSearchPlans(db, profileId) {
  return db.prepare("SELECT * FROM search_plans WHERE profile_id = ? ORDER BY is_active DESC, updated_at DESC, id DESC").all(Number(profileId)).map(planRow);
}

function listProfileVersions(db, profileId, limit = 12) {
  return db.prepare(`
    SELECT profile_versions.*, resume_documents.original_file_name, resume_documents.format
    FROM profile_versions
    LEFT JOIN resume_documents ON resume_documents.id = profile_versions.resume_document_id
    WHERE profile_versions.profile_id = ?
    ORDER BY profile_versions.created_at DESC, profile_versions.id DESC
    LIMIT ?
  `).all(Number(profileId), Math.max(1, Math.min(50, Number(limit) || 12))).map((row) => ({
    id: Number(row.id),
    profileId: Number(row.profile_id),
    resumeDocumentId: row.resume_document_id || null,
    profile: parseJson(row.profile_json, {}),
    fileName: row.original_file_name || "",
    format: row.format || "",
    createdAt: row.created_at
  }));
}

function getLatestProfileVersionId(db, profileId) {
  return Number(db.prepare("SELECT id FROM profile_versions WHERE profile_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(Number(profileId))?.id || 0) || null;
}

function getSearchPlanDependency(db, planId) {
  const plan = getSearchPlan(db, planId);
  if (!plan) return { stale: false, planProfileVersionId: null, currentProfileVersionId: null };
  const currentProfileVersionId = getLatestProfileVersionId(db, plan.profileId);
  return {
    stale: Boolean(currentProfileVersionId && plan.profileVersionId !== currentProfileVersionId),
    planProfileVersionId: plan.profileVersionId || null,
    currentProfileVersionId
  };
}

function compareProfileVersions(db, profileId) {
  const [current, previous] = listProfileVersions(db, profileId, 2);
  if (!current || !previous) return { current, previous, changes: [] };
  const changes = [];
  const currentCandidate = current.profile?.candidate || {};
  const previousCandidate = previous.profile?.candidate || {};
  compareValue(changes, "目标岗位", previousCandidate.targetTitles || [], currentCandidate.targetTitles || []);
  compareValue(changes, "所在城市", previousCandidate.city || "", currentCandidate.city || "");
  compareValue(changes, "期望薪资", previousCandidate.expectedSalary || "", currentCandidate.expectedSalary || "");
  compareSet(changes, "技能", previous.profile?.skills || [], current.profile?.skills || [], (item) => item.name || item);
  compareSet(changes, "项目", previous.profile?.projects || [], current.profile?.projects || [], (item) => item.name || item);
  return { current, previous, changes };
}

function listDecisionPool(db, { planId } = {}) {
  const plan = getSearchPlan(db, planId);
  if (!plan) return [];
  return listReportJobs(db, { planId: plan.id, batch: "all", profileId: plan.profileId, limit: 10000 });
}

function listDecisionQueue(db, { planId, limit = 15, buckets = null } = {}) {
  const plan = getSearchPlan(db, planId);
  if (!plan) return [];
  const now = new Date().toISOString();
  const wantedBuckets = Array.isArray(buckets) && buckets.length ? new Set(buckets) : null;
  return listDecisionPool(db, { planId: plan.id })
    .filter((job) => {
      return isJobAwaitingAction(job, now)
        && decisionState(job) === "ready"
        && (!wantedBuckets || wantedBuckets.has(job.decisionBucket));
    })
    .sort((a, b) => queueRank(a) - queueRank(b) || compareReportJobs(a, b))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 15)));
}

function getModelCache(db, cacheKey) {
  const row = db.prepare("SELECT * FROM model_cache WHERE cache_key = ?").get(String(cacheKey));
  return row ? {
    kind: row.kind,
    provider: row.provider,
    model: row.model || "",
    inputHash: row.input_hash,
    result: parseJson(row.result_json, {}),
    createdAt: row.created_at
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
    job.keyword || null,
    job.title,
    job.company || null,
    job.location || null,
    job.salary || null,
    job.experience || null,
    job.education || null,
    job.bossActiveText || null,
    job.bossActiveDays ?? null,
    job.url || null,
    JSON.stringify(job.tags || []),
    job.description || null,
    job.score || 0,
    job.level || null,
    JSON.stringify(job.matches || []),
    JSON.stringify(job.risks || []),
    JSON.stringify(job.qualityTags || []),
    job.greeting || null,
    JSON.stringify(job.analysis || {}),
    now,
    batchId || null
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

function listReportJobs(db, options = {}) {
  const batchId = resolveBatchId(db, options);
  const planId = Number(options.planId || 0);
  const profileId = resolveProfileId(db, { ...options, planId }, batchId);
  const latestPerPlan = !batchId && planId > 0;
  const cte = latestPerPlan ? `
    WITH ranked_observations AS (
      SELECT o0.*, ROW_NUMBER() OVER (
        PARTITION BY o0.job_id ORDER BY o0.seen_at DESC, o0.id DESC
      ) AS plan_rank
      FROM job_observations o0
      JOIN batches b0 ON b0.id = o0.batch_id
      WHERE b0.search_plan_id = ?
    )
  ` : "";
  const observationSource = latestPerPlan ? "ranked_observations o" : "job_observations o";
  const where = batchId ? "o.batch_id = ?" : latestPerPlan ? "o.plan_rank = 1" : "1 = 1";
  const params = latestPerPlan ? [planId] : batchId ? [batchId] : [];
  const limit = Math.max(1, Math.min(10000, Number(options.limit) || 200));
  const scopedObservation = profileId ? ` AND b2.profile_id = ${Number(profileId)}` : "";
  const stateSelect = profileId ? `
      states.status AS application_status,
      states.note AS application_note,
      states.updated_at AS application_updated_at,
      states.reason_code AS application_reason_code,
      states.review_at AS review_at,
      (SELECT json_extract(payload_json, '$.note') FROM candidate_job_events ce WHERE ce.profile_id = ${Number(profileId)} AND ce.job_id = jobs.id AND ce.event_type = 'follow_up' ORDER BY ce.created_at DESC, ce.id DESC LIMIT 1) AS follow_up_note,
      (SELECT created_at FROM candidate_job_events ce WHERE ce.profile_id = ${Number(profileId)} AND ce.job_id = jobs.id AND ce.event_type = 'follow_up' ORDER BY ce.created_at DESC, ce.id DESC LIMIT 1) AS follow_up_updated_at
  ` : `
      (SELECT status FROM applications WHERE applications.job_id = jobs.id ORDER BY updated_at DESC, id DESC LIMIT 1) AS application_status,
      (SELECT note FROM applications WHERE applications.job_id = jobs.id ORDER BY updated_at DESC, id DESC LIMIT 1) AS application_note,
      (SELECT updated_at FROM applications WHERE applications.job_id = jobs.id ORDER BY updated_at DESC, id DESC LIMIT 1) AS application_updated_at,
      '' AS application_reason_code,
      '' AS review_at,
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
      (SELECT o2.batch_id FROM job_observations o2 JOIN batches b2 ON b2.id = o2.batch_id
        WHERE o2.job_id = jobs.id${scopedObservation}
        ORDER BY o2.seen_at ASC, o2.id ASC LIMIT 1) AS first_batch_id,
      (SELECT o2.batch_id FROM job_observations o2 JOIN batches b2 ON b2.id = o2.batch_id
        WHERE o2.job_id = jobs.id${scopedObservation} AND COALESCE(b2.keyword, '') NOT IN ('detail-refresh', 'activity-probe', 'analysis-retry')
        ORDER BY o2.seen_at DESC, o2.id DESC LIMIT 1) AS latest_scan_batch_id,
      (SELECT o2.content_hash FROM job_observations o2 JOIN batches b2 ON b2.id = o2.batch_id
        WHERE o2.job_id = jobs.id AND o2.id <> o.id${scopedObservation}
        ORDER BY o2.seen_at DESC, o2.id DESC LIMIT 1) AS previous_content_hash,
      (SELECT result FROM job_refresh_attempts ra WHERE ra.job_id = jobs.id ORDER BY ra.created_at DESC, ra.id DESC LIMIT 1) AS refresh_result,
      (SELECT error_code FROM job_refresh_attempts ra WHERE ra.job_id = jobs.id ORDER BY ra.created_at DESC, ra.id DESC LIMIT 1) AS refresh_error_code,
      (SELECT attempt_number FROM job_refresh_attempts ra WHERE ra.job_id = jobs.id ORDER BY ra.created_at DESC, ra.id DESC LIMIT 1) AS refresh_attempt_number,
      (SELECT next_retry_at FROM job_refresh_attempts ra WHERE ra.job_id = jobs.id ORDER BY ra.created_at DESC, ra.id DESC LIMIT 1) AS refresh_next_retry_at,
      (SELECT created_at FROM job_refresh_attempts ra WHERE ra.job_id = jobs.id ORDER BY ra.created_at DESC, ra.id DESC LIMIT 1) AS refresh_attempted_at,
      ${stateSelect}
    FROM ${observationSource}
    JOIN jobs ON jobs.id = o.job_id
    JOIN batches b ON b.id = o.batch_id
    ${stateJoin}
    WHERE ${where}
    ORDER BY o.seen_at DESC, o.id DESC
    LIMIT ?
  `);
  const feedbackSummary = options.feedbackSummary || buildFeedbackSummary(db, { profileId });
  const jobs = stmt.all(...params, limit)
    .map(rowToJob)
    .map((job) => withFeedback(job, feedbackSummary));
  return applyJobQualityGovernance(jobs)
    .sort(compareReportJobs)
    .slice(0, limit);
}

function storedDetailFlags(row = {}) {
  const tags = parseJson(row.quality_tags_json, []);
  const description = String(row.description || "");
  const wasDetailRequired = tags.includes("detail_unverified")
    || (String(row.source || "") === "boss" && description.length >= 120);
  if (!wasDetailRequired) return {};
  return { detailRequired: true, detailRead: !tags.includes("detail_unverified") };
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
  const row = planId
    ? db.prepare(`SELECT b.id FROM batches b
        WHERE b.search_plan_id = ? AND COALESCE(b.keyword, '') NOT IN ('detail-refresh', 'activity-probe', 'analysis-retry')
          AND EXISTS (SELECT 1 FROM job_observations o WHERE o.batch_id = b.id)
        ORDER BY b.started_at DESC, b.id DESC LIMIT 1`).get(planId)
    : db.prepare(`SELECT b.id FROM batches b
        WHERE COALESCE(b.keyword, '') NOT IN ('detail-refresh', 'activity-probe', 'analysis-retry')
          AND EXISTS (SELECT 1 FROM job_observations o WHERE o.batch_id = b.id)
        ORDER BY b.started_at DESC, b.id DESC LIMIT 1`).get();
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

function buildFeedbackSummary(db, options = {}) {
  const profileId = Number(options.profileId || 0);
  const rows = profileId ? db.prepare(`
    SELECT jobs.*,
      states.status AS application_status,
      states.reason_code AS application_reason_code,
      (SELECT o.keyword FROM job_observations o JOIN batches b ON b.id = o.batch_id WHERE o.job_id = jobs.id AND b.profile_id = ? ORDER BY o.seen_at DESC, o.id DESC LIMIT 1) AS observed_keyword,
      (SELECT o.risks_json FROM job_observations o JOIN batches b ON b.id = o.batch_id WHERE o.job_id = jobs.id AND b.profile_id = ? ORDER BY o.seen_at DESC, o.id DESC LIMIT 1) AS observed_risks_json,
      (SELECT o.analysis_json FROM job_observations o JOIN batches b ON b.id = o.batch_id WHERE o.job_id = jobs.id AND b.profile_id = ? ORDER BY o.seen_at DESC, o.id DESC LIMIT 1) AS observed_analysis_json
    FROM candidate_job_states states
    JOIN jobs ON jobs.id = states.job_id
    WHERE states.profile_id = ?
  `).all(profileId, profileId, profileId, profileId) : db.prepare(`
    SELECT jobs.*,
      (SELECT status FROM applications WHERE applications.job_id = jobs.id ORDER BY updated_at DESC, id DESC LIMIT 1) AS application_status,
      '' AS application_reason_code
    FROM jobs
  `).all();
  const summary = {
    totals: Object.fromEntries(OUTCOME_STATUSES.map((status) => [status, 0])),
    companies: {},
    keywords: {},
    risks: {},
    resumeVersions: {},
    skipReasons: {},
    reasonCounts: {},
    companyReasons: {},
    keywordReasons: {}
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
      SELECT e.payload_json, jobs.company,
        (SELECT o.keyword FROM job_observations o JOIN batches b ON b.id = o.batch_id
          WHERE o.job_id = e.job_id AND b.profile_id = e.profile_id ORDER BY o.seen_at DESC, o.id DESC LIMIT 1) AS observed_keyword
      FROM candidate_job_events e
      JOIN jobs ON jobs.id = e.job_id
      WHERE e.profile_id = ? AND e.event_type = 'recommendation_feedback'
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
    batchId: allBatches ? "all" : batchId,
    imported: jobs.length,
    pending: 0,
    ...Object.fromEntries(OUTCOME_STATUSES.map((status) => [status, 0])),
    newJobs: 0,
    repeated: 0,
    nonGuangzhou: 0,
    inactiveOrUnknown: 0,
    duplicateJobs: 0,
    weakDuplicates: 0,
    needsRecheck: 0,
    detailChanged: 0,
    riskTop: []
  };
  const risks = {};
  for (const job of jobs) {
    const status = job.applicationStatus || "pending";
    if (summary[status] !== undefined) summary[status] += 1;
    if (job.firstSeenAt && job.lastSeenAt && job.firstSeenAt !== job.lastSeenAt) {
      summary.repeated += 1;
      summary.duplicateJobs += 1;
    } else {
      summary.newJobs += 1;
    }
    const tags = new Set(job.qualityTags || []);
    if (tags.has("location_mismatch")) summary.nonGuangzhou += 1;
    if (tags.has("inactive_boss") || tags.has("stale_or_unknown_active")) summary.inactiveOrUnknown += 1;
    if (tags.has("possible_duplicate")) summary.weakDuplicates += 1;
    if (tags.has("needs_recheck")) summary.needsRecheck += 1;
    if (tags.has("detail_changed")) summary.detailChanged += 1;
    for (const risk of job.risks || []) risks[risk] = (risks[risk] || 0) + 1;
  }
  summary.riskTop = Object.entries(risks)
    .map(([risk, count]) => ({ risk, count }))
    .sort((a, b) => b.count - a.count || a.risk.localeCompare(b.risk, "zh-CN"))
    .slice(0, 8);
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
  if (batch.search_plan_id && Number(batch.search_plan_id) !== plan.id) {
    throw new Error("batch is already bound to another search plan");
  }
  if (batch.profile_id && Number(batch.profile_id) !== plan.profileId) {
    throw new Error("batch belongs to another candidate profile");
  }

  const now = nowIso();
  const jobIds = db.prepare("SELECT job_id FROM job_observations WHERE batch_id = ?").all(Number(batchId)).map((row) => Number(row.job_id));
  const updateState = db.prepare("UPDATE candidate_job_states SET plan_id = ?, updated_at = ? WHERE profile_id = ? AND job_id = ? AND plan_id IS NULL");
  const existingState = db.prepare("SELECT 1 AS present FROM candidate_job_states WHERE profile_id = ? AND job_id = ?");
  const latestApplication = db.prepare("SELECT status, note, updated_at FROM applications WHERE job_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1");
  const insertState = db.prepare(
    "INSERT INTO candidate_job_states(profile_id, job_id, plan_id, status, reason_code, note, review_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)"
  );

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE batches SET profile_id = ?, search_plan_id = ? WHERE id = ?").run(plan.profileId, plan.id, Number(batchId));
    let migratedStates = 0;
    for (const jobId of jobIds) {
      const updated = updateState.run(plan.id, now, plan.profileId, jobId);
      if (updated.changes) {
        migratedStates += 1;
        continue;
      }
      if (existingState.get(plan.profileId, jobId)) continue;
      const application = latestApplication.get(jobId);
      if (!application) continue;
      insertState.run(plan.profileId, jobId, plan.id, application.status, application.note || null, application.updated_at || now);
      migratedStates += 1;
    }
    db.exec("COMMIT");
    return { batchId: Number(batchId), planId: plan.id, profileId: plan.profileId, migratedStates };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function rescorePlanObservations(db, { planId, configs }) {
  const plan = getSearchPlan(db, planId);
  if (!plan) throw new Error("search plan not found");
  const rows = db.prepare(`
    SELECT
      o.id AS observation_id, j.source, j.source_id, o.keyword, o.title, o.company, o.location,
      o.salary, o.experience, o.education, o.boss_active_text, o.url, o.tags_json, o.quality_tags_json, o.description,
      o.analysis_json
    FROM job_observations o
    JOIN jobs j ON j.id = o.job_id
    JOIN batches b ON b.id = o.batch_id
    WHERE b.search_plan_id = ?
  `).all(plan.id);
  const update = db.prepare(`
    UPDATE job_observations
    SET salary = ?, experience = ?, education = ?, score = ?, level = ?, matches_json = ?, risks_json = ?, quality_tags_json = ?, analysis_json = ?
    WHERE id = ?
  `);
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const metadata = mergeJobMetadata({
        salary: row.salary || "",
        experience: row.experience || "",
        education: row.education || "",
        tags: parseJson(row.tags_json, [])
      }, row.description || "");
      const raw = {
        source: row.source,
        sourceId: row.source_id,
        keyword: row.keyword || "",
        title: row.title || "",
        company: row.company || "",
        location: row.location || "",
        salary: metadata.salary,
        experience: metadata.experience,
        education: metadata.education,
        bossActiveText: row.boss_active_text || "",
        url: row.url || "",
        tags: parseJson(row.tags_json, []),
        description: row.description || "",
        ...storedDetailFlags(row)
      };
      const scored = scoreJob(raw, configs);
      const previousAnalysis = parseJson(row.analysis_json, {});
      const expectedRevision = buildAnalysisRevision(configs, sourceContentHash(raw));
      const staleReasons = analysisStaleReasons(previousAnalysis, expectedRevision);
      const modelBacked = ["complete", "partial"].includes(previousAnalysis.semanticStatus)
        || (!previousAnalysis.semanticStatus && !["rule-only", "rule-gate", "scan-checkpoint", "rule-fallback"].includes(previousAnalysis.provider));
      const analysis = {
        ...previousAnalysis,
        workSchedule: scored.workSchedule,
        workScheduleEvidence: scored.workScheduleEvidence,
        technicalFit: scored.technicalFit,
        ...(modelBacked && staleReasons.length ? {
          semanticStatus: "stale",
          decisionSource: "analysis_pending",
          recommendation: "review",
          staleReasons,
          expectedRevision
        } : {})
      };
      update.run(
        raw.salary,
        raw.experience,
        raw.education,
        scored.score,
        scored.level,
        JSON.stringify(scored.matches),
        JSON.stringify(scored.risks),
        JSON.stringify(scored.qualityTags),
        JSON.stringify(analysis),
        row.observation_id
      );
    }
    db.exec("COMMIT");
    return { planId: plan.id, rescored: rows.length };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function reassessBatchObservations(db, { batchId, configs, analyzeJob, cleanDescription = (value) => value } = {}) {
  const batch = db.prepare("SELECT id, search_plan_id FROM batches WHERE id = ?").get(Number(batchId));
  if (!batch) throw new Error("batch not found");
  if (typeof analyzeJob !== "function") throw new Error("analyzeJob is required");
  const rows = db.prepare(`
    SELECT o.id AS observation_id, o.job_id, o.keyword, o.title, o.company, o.location, o.salary,
      o.experience, o.education, o.boss_active_text, o.url, o.tags_json, o.quality_tags_json, o.description, o.greeting,
      j.source, j.source_id
    FROM job_observations o
    JOIN jobs j ON j.id = o.job_id
    WHERE o.batch_id = ?
    ORDER BY o.id
  `).all(Number(batchId));
  const reassessed = [];
  for (const row of rows) {
    const description = cleanDescription(row.description || "");
    const detailActivity = parseBossActivityText(row.description || "");
    const metadata = mergeJobMetadata({
      salary: row.salary || "",
      experience: row.experience || "",
      education: row.education || "",
      tags: parseJson(row.tags_json, [])
    }, description);
    const raw = {
      source: row.source,
      sourceId: row.source_id,
      keyword: row.keyword || "",
      title: row.title || "",
      company: row.company || "",
      location: row.location || "",
      salary: metadata.salary,
      experience: metadata.experience,
      education: metadata.education,
      bossActiveText: detailActivity || row.boss_active_text || "",
      url: row.url || "",
      tags: parseJson(row.tags_json, []),
      description,
      ...storedDetailFlags(row)
    };
    const scored = scoreJob(raw, configs);
    const gate = decisionState(scored);
    const base = gate === "ready"
      ? await analyzeJob({ ...raw, ...scored, greeting: row.greeting || "", preserveGreeting: Boolean(row.greeting) })
      : reassessmentGateAnalysis(scored, gate);
    const analysis = {
      ...base,
      roleKind: scored.roleKind,
      roleEvidence: scored.roleEvidence,
      workSchedule: scored.workSchedule,
      workScheduleEvidence: scored.workScheduleEvidence,
      technicalFit: scored.technicalFit
    };
    reassessed.push({ row, raw, scored, analysis, greeting: analysis.greeting || row.greeting || "" });
  }

  const updateObservation = db.prepare(`
    UPDATE job_observations
    SET salary = ?, experience = ?, education = ?, boss_active_text = ?, boss_active_days = ?, description = ?, score = ?, level = ?, matches_json = ?, risks_json = ?, quality_tags_json = ?,
      greeting = ?, analysis_json = ?, content_hash = ?, content_hash_version = 1
    WHERE id = ?
  `);
  const updateCurrentJob = db.prepare(`
    UPDATE jobs
    SET salary = ?, experience = ?, education = ?, boss_active_text = ?, boss_active_days = ?, description = ?, score = ?, level = ?, matches_json = ?, risks_json = ?, quality_tags_json = ?,
      greeting = ?, analysis_json = ?
    WHERE id = ? AND batch_id = ?
  `);
  db.exec("BEGIN");
  try {
    for (const item of reassessed) {
      const snapshot = { ...item.raw, ...item.scored, analysis: item.analysis };
      const values = [
        item.raw.salary,
        item.raw.experience,
        item.raw.education,
        item.raw.bossActiveText,
        item.scored.bossActiveDays,
        item.raw.description,
        item.scored.score,
        item.scored.level,
        JSON.stringify(item.scored.matches),
        JSON.stringify(item.scored.risks),
        JSON.stringify(item.scored.qualityTags),
        item.greeting,
        JSON.stringify(item.analysis),
        observationContentHash(snapshot)
      ];
      updateObservation.run(...values, item.row.observation_id);
      updateCurrentJob.run(...values.slice(0, 13), item.row.job_id, Number(batchId));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { batchId: Number(batchId), reassessed: reassessed.length };
}

function reassessmentGateAnalysis(scored, gate) {
  const blocked = gate === "blocked";
  return {
    provider: "rule-gate",
    model: "",
    semanticStatus: blocked ? "blocked" : "refresh",
    decisionSource: blocked ? "hard_boundary" : "source_refresh",
    recommendation: blocked ? "skip" : "review",
    fitLevel: blocked ? "D" : "C",
    confidence: null,
    recommendedResumeVersion: "",
    recommendedResumeVersionName: "",
    primaryProjects: [],
    fitReasons: [blocked ? "基础岗位条件不符合当前投递范围。" : "招聘方活跃状态待刷新。"],
    hardBlockers: [],
    softGaps: [],
    questionsToVerify: scored.risks || [],
    missingPoints: [],
    blockingGaps: [],
    riskQuestions: scored.risks || [],
    evidence: { jd: [], resume: [] },
    greetingAngle: "",
    greeting: ""
  };
}

function markCandidateJob(db, { profileId, jobId, status, note = "", reasonCode = "", reviewAt = "", planId = null }) {
  const profile = Number(profileId);
  const job = Number(jobId);
  if (!Number.isInteger(profile) || profile <= 0) throw new Error("candidate profile is required");
  if (!Number.isInteger(job) || job <= 0) throw new Error("job is required");
  if (!VALID_CANDIDATE_STATUSES.has(status)) throw new Error("invalid candidate job status");
  const exists = db.prepare("SELECT id FROM jobs WHERE id = ?").get(job);
  if (!exists) throw new Error("job not found");
  const now = nowIso();
  const normalizedReason = NEGATIVE_FEEDBACK_STATUSES.has(status) ? normalizeFeedbackReason(reasonCode, status) : "";
  db.prepare(`
    INSERT INTO candidate_job_states(profile_id, job_id, plan_id, status, reason_code, note, review_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, job_id) DO UPDATE SET
      plan_id=excluded.plan_id, status=excluded.status, reason_code=excluded.reason_code,
      note=excluded.note, review_at=excluded.review_at, updated_at=excluded.updated_at
  `).run(profile, job, planId || null, status, normalizedReason || null, note || null, reviewAt || null, now);
  db.prepare("INSERT INTO candidate_job_events(profile_id, job_id, plan_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(profile, job, planId || null, status, JSON.stringify({ note: note || "", reasonCode: normalizedReason, reviewAt: reviewAt || "" }), now);
}

function addFollowUpNote(db, jobId, note, context = {}) {
  const value = String(note || "").trim();
  if (!value) throw new Error("follow-up note is required");
  const exists = db.prepare("SELECT id FROM jobs WHERE id = ?").get(jobId);
  if (!exists) throw new Error("job not found");
  if (context.profileId) {
    db.prepare("INSERT INTO candidate_job_events(profile_id, job_id, plan_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(Number(context.profileId), Number(jobId), context.planId || null, "follow_up", JSON.stringify({ note: value }), nowIso());
    return;
  }
  db.prepare("INSERT INTO events(job_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)")
    .run(jobId, "follow_up", JSON.stringify({ note: value }), nowIso());
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

function listCandidateJobEvents(db, { profileId, jobId = null, eventType = "", limit = 30 }) {
  const clauses = ["profile_id = ?"];
  const params = [Number(profileId)];
  if (jobId) { clauses.push("job_id = ?"); params.push(Number(jobId)); }
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

function saveCandidateFact(db, { profileId, factKey, factValue, source = "user_provided" }) {
  const profile = Number(profileId);
  const key = String(factKey || "").trim().replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80);
  const value = String(factValue || "").trim().slice(0, 2000);
  if (!profile || !key || !value) throw new Error("profileId, factKey and factValue are required");
  if (!db.prepare("SELECT id FROM candidate_profiles WHERE id = ?").get(profile)) throw new Error("candidate profile not found");
  const now = nowIso();
  db.prepare(`INSERT INTO candidate_facts(profile_id, fact_key, fact_value, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, fact_key) DO UPDATE SET fact_value=excluded.fact_value, source=excluded.source, updated_at=excluded.updated_at`)
    .run(profile, key, value, String(source || "user_provided"), now, now);
  return { factKey: key, factValue: value, source: String(source || "user_provided") };
}

function listCandidateFacts(db, profileId) {
  return db.prepare("SELECT fact_key, fact_value, source, updated_at FROM candidate_facts WHERE profile_id = ? ORDER BY fact_key").all(Number(profileId)).map((row) => ({
    factKey: row.fact_key, factValue: row.fact_value, source: row.source, updatedAt: row.updated_at
  }));
}

function rowToJob(row) {
  return {
    id: row.id,
    observationId: row.observation_id || null,
    profileId: row.profile_id || null,
    searchPlanId: row.search_plan_id || null,
    source: row.source,
    sourceId: row.source_id,
    keyword: row.keyword,
    title: row.title,
    company: row.company,
    location: row.location,
    salary: row.salary,
    experience: row.experience,
    education: row.education,
    bossActiveText: row.boss_active_text,
    bossActiveDays: row.boss_active_days,
    url: row.url,
    tags: JSON.parse(row.tags_json || "[]"),
    description: row.description,
    score: row.score,
    level: row.level,
    matches: JSON.parse(row.matches_json || "[]"),
    risks: JSON.parse(row.risks_json || "[]"),
    qualityTags: parseJson(row.quality_tags_json, []),
    greeting: row.greeting,
    analysis: parseJson(row.analysis_json, {}),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    firstBatchId: Number(row.first_batch_id || 0) || null,
    latestScanBatchId: Number(row.latest_scan_batch_id || 0) || null,
    previousContentHash: row.previous_content_hash || "",
    refreshResult: row.refresh_result || "",
    refreshErrorCode: row.refresh_error_code || "",
    refreshAttemptNumber: Number(row.refresh_attempt_number || 0),
    refreshNextRetryAt: row.refresh_next_retry_at || "",
    refreshAttemptedAt: row.refresh_attempted_at || "",
    batchId: row.batch_id,
    applicationStatus: row.application_status || "",
    applicationNote: row.application_note || "",
    applicationReasonCode: row.application_reason_code || "",
    applicationUpdatedAt: row.application_updated_at || "",
    reviewAt: row.review_at || "",
    followUpNote: row.follow_up_note || "",
    followUpUpdatedAt: row.follow_up_updated_at || ""
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
  const maxActiveDays = Number.isFinite(Number(options.maxActiveDays))
    ? Math.max(0, Number(options.maxActiveDays))
    : 3;
  return jobs.map((job) => {
    const qualityTags = [...(job.qualityTags || [])];
    const key = [job.company, job.title, job.location].map(normalizeDedupeText).join("|");
    const duplicates = groups.get(key) || [];
    if (duplicates.length > 1 && !qualityTags.includes("possible_duplicate")) qualityTags.push("possible_duplicate");
    const changed = Boolean(job.previousContentHash && job.previousContentHash !== observationContentHash(job));
    if (changed && !qualityTags.includes("detail_changed")) qualityTags.push("detail_changed");
    const seenAt = Date.parse(job.lastSeenAt || "");
    const daysSinceLastSeen = Number.isFinite(seenAt) ? Math.floor((now - seenAt) / (24 * 60 * 60 * 1000)) : null;
    const hasActivitySnapshot = job.bossActiveDays !== null
      && job.bossActiveDays !== undefined
      && job.bossActiveDays !== ""
      && Number.isFinite(Number(job.bossActiveDays));
    const effectiveBossActiveDays = hasActivitySnapshot && daysSinceLastSeen !== null
      ? Math.max(0, Number(job.bossActiveDays) + Math.max(0, daysSinceLastSeen))
      : (hasActivitySnapshot ? Number(job.bossActiveDays) : null);
    if (hasActivitySnapshot && daysSinceLastSeen > 0 && !qualityTags.includes("activity_snapshot_aged")) {
      qualityTags.push("activity_snapshot_aged");
    }
    if (effectiveBossActiveDays !== null
      && effectiveBossActiveDays > maxActiveDays
      && !qualityTags.includes("stale_or_unknown_active")) {
      qualityTags.push("stale_or_unknown_active");
    }
    if (daysSinceLastSeen !== null && daysSinceLastSeen >= 14 && !qualityTags.includes("needs_recheck")) qualityTags.push("needs_recheck");
    const enriched = {
      ...job,
      qualityTags,
      weakDuplicateCount: duplicates.length,
      detailChanged: changed,
      daysSinceLastSeen,
      activityObservedAt: hasActivitySnapshot ? job.lastSeenAt : "",
      effectiveBossActiveDays
    };
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
  const tags = new Set(job.qualityTags || []);
  const state = decisionState(job);
  if (state === "blocked") return "not_recommended";
  if (state === "refresh") return "refresh";
  const analysis = job.analysis || {};
  const semanticStatus = analysis.semanticStatus || "";
  const recommendation = analysis.recommendation || "";
  if (effectiveHardBlockers(analysis).length) return "not_recommended";
  if (["pending", "failed", "stale"].includes(semanticStatus)) return "analysis_pending";
  if (semanticStatus === "blocked") return "not_recommended";
  if (semanticStatus === "refresh") return "refresh";
  if (semanticStatus === "partial") return "talk";
  if (semanticStatus === "complete") {
    if (tags.has("experience_salary_overlap")) return "backup";
    if (recommendation === "skip") return "talk";
    if (recommendation === "apply") {
      const evidence = analysis.evidence || {};
      const needsConversation = analysis.realRoleType === "implementation_presales"
        || tags.has("experience_stretch")
        || tags.has("experience_overrange")
        || (analysis.hiddenRisks || []).some((risk) => ["medium", "high"].includes(risk?.severity));
      return !needsConversation && Number(analysis.confidence || 0) >= 0.62 && (evidence.jd || []).length && (evidence.resume || []).length ? "primary" : "talk";
    }
    if (recommendation === "caution" || recommendation === "review") return "talk";
    return "analysis_pending";
  }
  if (analysis.provider && !["mock", "rule-only", "rule-gate", "scan-checkpoint", "rule-fallback"].includes(analysis.provider)) return "analysis_pending";
  if ((job.risks || []).some((risk) => /薪资低于期望下限/.test(String(risk)))) return "backup";
  if (tags.has("experience_out_of_scope") || tags.has("experience_overrange") || tags.has("experience_salary_overlap") || tags.has("core_stack_mismatch") || tags.has("java_backend_heavy") || tags.has("senior_engineering_heavy")) return "backup";
  if (tags.has("salary_unverified") || tags.has("experience_unverified")) return "talk";
  const requiresConversation = tags.has("algorithm_hybrid")
    || tags.has("experience_stretch")
    || (job.risks || []).some((risk) => /偏训练|算法框架|Java占比|Spring占比|全栈|顾问|实施|应届|学历|经验门槛/.test(String(risk)));
  if (["优先", "可投"].includes(job.level || "") && !requiresConversation && !(job.risks || []).length) return "talk";
  if (["优先", "可投", "可冲"].includes(job.level || "")) return "talk";
  return "backup";
}

function observationContentHash(job) {
  return sourceContentHash(job);
}

function sourceContentHash(job) {
  return crypto.createHash("sha256").update(JSON.stringify({
    title: job.title || "", company: job.company || "", location: job.location || "", salary: job.salary || "",
    experience: job.experience || "", education: job.education || "",
    tags: Array.isArray(job.tags) ? job.tags : parseJson(job.tags_json, []),
    description: job.description || ""
  })).digest("hex");
}

function normalizeDedupeText(value) {
  return String(value || "").toLowerCase().replace(/[\s\-_/()（）]/g, "");
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text || "");
  } catch {
    return fallback;
  }
}

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
  if (job.firstSeenAt && job.lastSeenAt && job.firstSeenAt !== job.lastSeenAt && !qualityTags.includes("duplicate_seen")) {
    qualityTags.push("duplicate_seen");
  }

  const companyReasons = summary.companyReasons?.[job.company] || {};
  const keywordReasons = summary.keywordReasons?.[job.keyword] || {};
  const companyFeedback = Object.entries(companyReasons).filter(([, count]) => count > 0).map(([reason, count]) => `${reason} ${count} 次`);
  const keywordFeedback = Object.entries(keywordReasons).filter(([, count]) => count > 0).map(([reason, count]) => `${reason} ${count} 次`);
  if (companyFeedback.length) notes.push(`同公司已有反馈：${companyFeedback.join("；")}`);
  if (keywordFeedback.length) notes.push(`同关键词已有反馈：${keywordFeedback.join("；")}`);

  return {
    ...job,
    qualityTags,
    feedback: { penalty: 0, bonus: 0, notes },
    feedbackRank: 0
  };
}

function compareReportJobs(a, b) {
  return statusRank(a) - statusRank(b)
    || decisionBucketRank(a.decisionBucket) - decisionBucketRank(b.decisionBucket)
    || modelConfidenceRank(a) - modelConfidenceRank(b)
    || workScheduleRank(a) - workScheduleRank(b)
    || (a.feedbackRank || 0) - (b.feedbackRank || 0)
    || qualityRank(a) - qualityRank(b)
    || (a.risks || []).length - (b.risks || []).length
    || activeRank(a.effectiveBossActiveDays ?? a.bossActiveDays) - activeRank(b.effectiveBossActiveDays ?? b.bossActiveDays)
    || String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || ""));
}

function statusRank(job) {
  return job.applicationStatus ? 1 : 0;
}

function levelRank(level) {
  return { "优先": 0, "可投": 1, "可冲": 2, "谨慎": 3, "不建议": 4 }[level] ?? 9;
}

function decisionBucketRank(bucket) {
  return { primary: 0, talk: 1, backup: 2, analysis_pending: 3, refresh: 4, not_recommended: 5 }[bucket] ?? 9;
}

function modelConfidenceRank(job) {
  const confidence = Number(job.analysis?.confidence);
  return Number.isFinite(confidence) ? -confidence : 0;
}

function activeRank(days) {
  return days === null || days === undefined ? 99 : Number(days);
}

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

function hardRiskRank(job) {
  return (job.risks || []).some((risk) => /产品方向|测试方向|讲师\/培训方向|课程方向/.test(risk)) ? 1 : 0;
}

function queueRank(job) {
  const status = job.applicationStatus || "pending";
  if (status === "review") return 0;
  if (status === "pending") return 1;
  return 2;
}

function compareValue(changes, label, previous, current) {
  const before = Array.isArray(previous) ? previous.join("、") : String(previous || "");
  const after = Array.isArray(current) ? current.join("、") : String(current || "");
  if (before !== after) changes.push({ label, before, after });
}

function compareSet(changes, label, previous, current, pick) {
  const before = new Set(previous.map(pick).filter(Boolean));
  const after = new Set(current.map(pick).filter(Boolean));
  const added = [...after].filter((value) => !before.has(value));
  const removed = [...before].filter((value) => !after.has(value));
  if (added.length || removed.length) changes.push({ label, added, removed });
}

function profileRow(row) {
  return {
    id: Number(row.id),
    displayName: row.display_name,
    profile: parseJson(row.profile_json, {}),
    sourceHash: row.source_hash || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function planRow(row) {
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    name: row.name,
    plan: parseJson(row.plan_json, {}),
    profileVersionId: Number(row.profile_version_id || 0) || null,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = {
  SCHEMA,
  OUTCOME_STATUSES,
  openDb,
  createBatch,
  recordScanTargetResult,
  listScanTargetResults,
  getSiteRuntimeState,
  setSiteRuntimeState,
  clearSiteRuntimeState,
  listReusableJobDetails,
  recordJobRefreshAttempt,
  listJobRefreshAttempts,
  getLatestJobRefreshAttempt,
  getPlatformFilterCatalog,
  savePlatformFilterCatalog,
  upsertKeywordSource,
  upsertJob,
  listReportJobs,
  markApplication,
  bindBatchToPlan,
  rescorePlanObservations,
  reassessBatchObservations,
  addFollowUpNote,
  recordCandidateJobEvent,
  listCandidateJobEvents,
  recordRecommendationFeedback,
  saveCandidateFact,
  listCandidateFacts,
  markCandidateJob,
  buildFeedbackSummary,
  buildBatchSummary,
  getLatestBatchId,
  getLatestMainScanBatchId,
  saveProfileAnalysis,
  attachResumeDocumentFile,
  getResumeDocument,
  updateCandidateProfile,
  saveCandidateResumeVersion,
  listCandidateResumeVersions,
  recordResumeParseAttempt,
  listResumeParseAttempts,
  saveSearchPlan,
  getCandidateProfile,
  listCandidateProfiles,
  getSearchPlan,
  getActiveSearchPlan,
  listSearchPlans,
  listProfileVersions,
  compareProfileVersions,
  getLatestProfileVersionId,
  getSearchPlanDependency,
  listDecisionPool,
  listDecisionQueue,
  isJobAwaitingAction,
  decisionBucket,
  applyJobQualityGovernance,
  isActivityProbeDue,
  sourceContentHash,
  getModelCache,
  saveModelCache
};
