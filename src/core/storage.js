const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { scoreJob, decisionState, parseWorkSchedule } = require("./scoring");
const { parseBossActivityText } = require("../adapters/sites/boss");

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
  search_plan_id INTEGER
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

CREATE TABLE IF NOT EXISTS model_cache (
  cache_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_observations_batch ON job_observations(batch_id, job_id);
CREATE INDEX IF NOT EXISTS idx_candidate_job_states_profile ON candidate_job_states(profile_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_candidate_job_events_profile_job ON candidate_job_events(profile_id, job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_profile_versions_profile ON profile_versions(profile_id, created_at);
CREATE INDEX IF NOT EXISTS idx_resume_parse_attempts_profile ON resume_parse_attempts(profile_id, created_at);
CREATE INDEX IF NOT EXISTS idx_candidate_resume_versions_profile ON candidate_resume_versions(profile_id, is_active, updated_at);
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
  const resumeColumns = new Set(db.prepare("PRAGMA table_info(resume_documents)").all().map((column) => column.name));
  if (!resumeColumns.has("diagnostics_json")) db.exec("ALTER TABLE resume_documents ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '{}'");
  db.exec(`
    INSERT OR IGNORE INTO job_observations(
      job_id, batch_id, keyword, title, company, location, salary, experience, education,
      boss_active_text, boss_active_days, url, tags_json, description, score, level,
      matches_json, risks_json, quality_tags_json, greeting, analysis_json, content_hash, seen_at
    )
    SELECT id, batch_id, keyword, title, company, location, salary, experience, education,
      boss_active_text, boss_active_days, url, tags_json, description, score, level,
      matches_json, risks_json, quality_tags_json, greeting, analysis_json, 'legacy:' || id, last_seen_at
    FROM jobs WHERE batch_id IS NOT NULL
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
  backfillWorkSchedules(db);
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
  const stmt = db.prepare("INSERT INTO batches(site, keyword, started_at, note, profile_id, search_plan_id) VALUES (?, ?, ?, ?, ?, ?)");
  const result = stmt.run(site, keyword || null, started, note, context.profileId || null, context.searchPlanId || null);
  return Number(result.lastInsertRowid);
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
    db.prepare("INSERT INTO profile_versions(profile_id, resume_document_id, profile_json, created_at) VALUES (?, ?, ?, ?)")
      .run(id, documentId, JSON.stringify(profile), now);
    createCandidateResumeVersion(db, {
      profileId: id,
      resumeDocumentId: documentId,
      version: resumeVersionDefaults(profile, document),
      now
    });
    const planId = saveSearchPlan(db, { profileId: id, plan: searchPlan, now });
    db.exec("COMMIT");
    return { profileId: id, planId };
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
      primary_projects_json, summary, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(profileId), documentId, versionKey, String(version.name || "简历版本"),
    JSON.stringify(stringList(version.targetRoles, 8)),
    JSON.stringify(stringList(version.keywords, 16)),
    JSON.stringify(stringList(version.primaryProjects, 6)),
    String(version.summary || ""),
    version.isActive === false ? 0 : 1, now, now
  );
  return Number(result.lastInsertRowid);
}

function stringList(value, limit) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

function saveSearchPlan(db, { id = null, profileId, plan, now = nowIso() }) {
  const name = String(plan?.name || "岗位筛选计划").trim() || "岗位筛选计划";
  const currentId = Number(id || 0);
  db.prepare("UPDATE search_plans SET is_active = 0, updated_at = ? WHERE profile_id = ?").run(now, profileId);
  if (currentId && db.prepare("SELECT id FROM search_plans WHERE id = ? AND profile_id = ?").get(currentId, profileId)) {
    db.prepare("UPDATE search_plans SET name = ?, plan_json = ?, is_active = 1, updated_at = ? WHERE id = ?")
      .run(name, JSON.stringify(plan), now, currentId);
    return currentId;
  }
  return Number(db.prepare(`INSERT INTO search_plans(profile_id, name, plan_json, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)`)
    .run(profileId, name, JSON.stringify(plan), now, now).lastInsertRowid);
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
      const existing = db.prepare("SELECT id, resume_document_id FROM candidate_resume_versions WHERE id = ? AND profile_id = ?").get(existingId, profile);
      if (!existing) throw new Error("resume version not found");
      db.prepare(`UPDATE candidate_resume_versions SET
        resume_document_id = ?, name = ?, target_roles_json = ?, keywords_json = ?, primary_projects_json = ?,
        summary = ?, is_active = ?, updated_at = ? WHERE id = ?`).run(
        documentId || existing.resume_document_id || null, String(version.name || "简历版本"),
        JSON.stringify(stringList(version.targetRoles, 8)), JSON.stringify(stringList(version.keywords, 16)),
        JSON.stringify(stringList(version.primaryProjects, 6)), String(version.summary || ""),
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
    SELECT rv.*, rd.original_file_name, rd.format, rd.diagnostics_json
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
    isActive: Boolean(row.is_active),
    resumeDocumentId: row.resume_document_id || null,
    fileName: row.original_file_name || "",
    format: row.format || "",
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
  const latestByJob = new Map();
  for (const job of listReportJobs(db, { planId: plan.id, batch: "all", profileId: plan.profileId })) {
    const previous = latestByJob.get(job.id);
    if (!previous || String(job.lastSeenAt || "").localeCompare(String(previous.lastSeenAt || "")) > 0 || (job.lastSeenAt === previous.lastSeenAt && job.observationId > previous.observationId)) {
      latestByJob.set(job.id, job);
    }
  }
  return [...latestByJob.values()].sort(compareReportJobs);
}

function listDecisionQueue(db, { planId, limit = 15, buckets = null } = {}) {
  const plan = getSearchPlan(db, planId);
  if (!plan) return [];
  const now = new Date().toISOString();
  const wantedBuckets = Array.isArray(buckets) && buckets.length ? new Set(buckets) : null;
  return listDecisionPool(db, { planId: plan.id })
    .filter((job) => {
      const status = job.applicationStatus || "pending";
      const awaitingAction = status === "pending" || status === "review" || (status === "later" && (!job.reviewAt || job.reviewAt <= now));
      return awaitingAction
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
  const contentHash = crypto.createHash("sha256").update(JSON.stringify({
    title: job.title || "", company: job.company || "", location: job.location || "", salary: job.salary || "",
    description: job.description || "", analysis: job.analysis || {}, score: job.score || 0
  })).digest("hex");
  const values = [
    jobId, batchId, job.keyword || null, job.title || "", job.company || null, job.location || null,
    job.salary || null, job.experience || null, job.education || null, job.bossActiveText || null,
    job.bossActiveDays ?? null, job.url || null, JSON.stringify(job.tags || []), job.description || null,
    job.score || 0, job.level || null, JSON.stringify(job.matches || []), JSON.stringify(job.risks || []),
    JSON.stringify(job.qualityTags || []), job.greeting || null, JSON.stringify(job.analysis || {}), contentHash, seenAt
  ];
  db.prepare(`
    INSERT INTO job_observations(
      job_id, batch_id, keyword, title, company, location, salary, experience, education,
      boss_active_text, boss_active_days, url, tags_json, description, score, level,
      matches_json, risks_json, quality_tags_json, greeting, analysis_json, content_hash, seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(batch_id, job_id) DO UPDATE SET
      keyword=excluded.keyword, title=excluded.title, company=excluded.company, location=excluded.location,
      salary=excluded.salary, experience=excluded.experience, education=excluded.education,
      boss_active_text=excluded.boss_active_text, boss_active_days=excluded.boss_active_days, url=excluded.url,
      tags_json=excluded.tags_json, description=excluded.description, score=excluded.score, level=excluded.level,
      matches_json=excluded.matches_json, risks_json=excluded.risks_json, quality_tags_json=excluded.quality_tags_json,
      greeting=excluded.greeting, analysis_json=excluded.analysis_json, content_hash=excluded.content_hash, seen_at=excluded.seen_at
  `).run(...values);
}

function listReportJobs(db, options = {}) {
  const batchId = resolveBatchId(db, options);
  const planId = Number(options.planId || 0);
  const profileId = resolveProfileId(db, { ...options, planId }, batchId);
  const where = batchId ? "o.batch_id = ?" : planId ? "b.search_plan_id = ?" : "1 = 1";
  const params = batchId ? [batchId] : planId ? [planId] : [];
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
    SELECT jobs.id AS id, jobs.source AS source, jobs.source_id AS source_id,
      o.id AS observation_id, o.batch_id AS batch_id, b.profile_id AS profile_id, b.search_plan_id AS search_plan_id,
      o.keyword, o.title, o.company, o.location, o.salary, o.experience, o.education,
      o.boss_active_text, o.boss_active_days, o.url, o.tags_json, o.description, o.score, o.level,
      o.matches_json, o.risks_json, o.quality_tags_json, o.greeting, o.analysis_json,
      (SELECT MIN(o2.seen_at) FROM job_observations o2 JOIN batches b2 ON b2.id = o2.batch_id WHERE o2.job_id = jobs.id${scopedObservation}) AS first_seen_at,
      (SELECT MAX(o2.seen_at) FROM job_observations o2 JOIN batches b2 ON b2.id = o2.batch_id WHERE o2.job_id = jobs.id${scopedObservation}) AS last_seen_at,
      (SELECT o2.content_hash FROM job_observations o2 JOIN batches b2 ON b2.id = o2.batch_id
        WHERE o2.job_id = jobs.id AND o2.id <> o.id${scopedObservation}
        ORDER BY o2.seen_at DESC, o2.id DESC LIMIT 1) AS previous_content_hash,
      ${stateSelect}
    FROM job_observations o
    JOIN jobs ON jobs.id = o.job_id
    JOIN batches b ON b.id = o.batch_id
    ${stateJoin}
    WHERE ${where}
    LIMIT 500
  `);
  const feedbackSummary = options.feedbackSummary || buildFeedbackSummary(db, { profileId });
  const jobs = stmt.all(...params)
    .map(rowToJob)
    .map((job) => withFeedback(job, feedbackSummary))
  return applyJobQualityGovernance(jobs)
    .sort(compareReportJobs)
    .slice(0, 200);
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
    skipReasons: {}
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
    if (["skipped", "invalid", "salary_mismatch"].includes(status)) addStat(summary.skipReasons, row.application_reason_code, status);
  }

  return summary;
}

function buildBatchSummary(db, options = {}) {
  const allBatches = options.batch === "all" && !options.batchId;
  const batchId = allBatches ? null : (resolveBatchId(db, options) || getLatestBatchId(db, options));
  const jobs = allBatches ? listReportJobs(db, { ...options, batch: "all" }) : (batchId ? listReportJobs(db, { ...options, batchId }) : listReportJobs(db, options));
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
      o.salary, o.experience, o.education, o.boss_active_text, o.url, o.tags_json, o.description,
      o.analysis_json
    FROM job_observations o
    JOIN jobs j ON j.id = o.job_id
    JOIN batches b ON b.id = o.batch_id
    WHERE b.search_plan_id = ?
  `).all(plan.id);
  const update = db.prepare(`
    UPDATE job_observations
    SET score = ?, level = ?, matches_json = ?, risks_json = ?, quality_tags_json = ?, analysis_json = ?
    WHERE id = ?
  `);
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const scored = scoreJob({
        source: row.source,
        sourceId: row.source_id,
        keyword: row.keyword || "",
        title: row.title || "",
        company: row.company || "",
        location: row.location || "",
        salary: row.salary || "",
        experience: row.experience || "",
        education: row.education || "",
        bossActiveText: row.boss_active_text || "",
        url: row.url || "",
        tags: parseJson(row.tags_json, []),
        description: row.description || ""
      }, configs);
      const analysis = {
        ...parseJson(row.analysis_json, {}),
        workSchedule: scored.workSchedule,
        workScheduleEvidence: scored.workScheduleEvidence
      };
      update.run(
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
      o.experience, o.education, o.boss_active_text, o.url, o.tags_json, o.description, o.greeting,
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
    const raw = {
      source: row.source,
      sourceId: row.source_id,
      keyword: row.keyword || "",
      title: row.title || "",
      company: row.company || "",
      location: row.location || "",
      salary: row.salary || "",
      experience: row.experience || "",
      education: row.education || "",
      bossActiveText: detailActivity || row.boss_active_text || "",
      url: row.url || "",
      tags: parseJson(row.tags_json, []),
      description
    };
    const scored = scoreJob(raw, configs);
    const gate = decisionState(scored);
    const base = gate === "ready"
      ? await analyzeJob({ ...raw, ...scored, greeting: row.greeting || "" })
      : reassessmentGateAnalysis(scored, gate);
    const analysis = {
      ...base,
      roleKind: scored.roleKind,
      roleEvidence: scored.roleEvidence,
      workSchedule: scored.workSchedule,
      workScheduleEvidence: scored.workScheduleEvidence
    };
    reassessed.push({ row, raw, scored, analysis, greeting: analysis.greeting || row.greeting || "" });
  }

  const updateObservation = db.prepare(`
    UPDATE job_observations
    SET boss_active_text = ?, boss_active_days = ?, description = ?, score = ?, level = ?, matches_json = ?, risks_json = ?, quality_tags_json = ?,
      greeting = ?, analysis_json = ?, content_hash = ?
    WHERE id = ?
  `);
  const updateCurrentJob = db.prepare(`
    UPDATE jobs
    SET boss_active_text = ?, boss_active_days = ?, description = ?, score = ?, level = ?, matches_json = ?, risks_json = ?, quality_tags_json = ?,
      greeting = ?, analysis_json = ?
    WHERE id = ? AND batch_id = ?
  `);
  db.exec("BEGIN");
  try {
    for (const item of reassessed) {
      const snapshot = { ...item.raw, ...item.scored, analysis: item.analysis };
      const values = [
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
      updateCurrentJob.run(...values.slice(0, 10), item.row.job_id, Number(batchId));
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
    recommendation: blocked ? "skip" : "review",
    fitLevel: blocked ? "D" : "C",
    confidence: null,
    recommendedResumeVersion: "",
    recommendedResumeVersionName: "",
    primaryProjects: [],
    fitReasons: [blocked ? "基础岗位条件不符合当前投递范围。" : "招聘方活跃状态待刷新。"],
    missingPoints: [],
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
  db.prepare(`
    INSERT INTO candidate_job_states(profile_id, job_id, plan_id, status, reason_code, note, review_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, job_id) DO UPDATE SET
      plan_id=excluded.plan_id, status=excluded.status, reason_code=excluded.reason_code,
      note=excluded.note, review_at=excluded.review_at, updated_at=excluded.updated_at
  `).run(profile, job, planId || null, status, reasonCode || null, note || null, reviewAt || null, now);
  db.prepare("INSERT INTO candidate_job_events(profile_id, job_id, plan_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(profile, job, planId || null, status, JSON.stringify({ note: note || "", reasonCode: reasonCode || "", reviewAt: reviewAt || "" }), now);
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
    previousContentHash: row.previous_content_hash || "",
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

function applyJobQualityGovernance(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const key = [job.company, job.title, job.location].map(normalizeDedupeText).join("|");
    if (key === "||") continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  const now = Date.now();
  return jobs.map((job) => {
    const qualityTags = [...(job.qualityTags || [])];
    const key = [job.company, job.title, job.location].map(normalizeDedupeText).join("|");
    const duplicates = groups.get(key) || [];
    if (duplicates.length > 1 && !qualityTags.includes("possible_duplicate")) qualityTags.push("possible_duplicate");
    const changed = Boolean(job.previousContentHash && job.previousContentHash !== observationContentHash(job));
    if (changed && !qualityTags.includes("detail_changed")) qualityTags.push("detail_changed");
    const seenAt = Date.parse(job.lastSeenAt || "");
    const daysSinceLastSeen = Number.isFinite(seenAt) ? Math.floor((now - seenAt) / (24 * 60 * 60 * 1000)) : null;
    if (daysSinceLastSeen !== null && daysSinceLastSeen >= 14 && !qualityTags.includes("needs_recheck")) qualityTags.push("needs_recheck");
    const enriched = { ...job, qualityTags, weakDuplicateCount: duplicates.length, detailChanged: changed, daysSinceLastSeen };
    return { ...enriched, decisionBucket: decisionBucket(enriched) };
  });
}

function decisionBucket(job) {
  const tags = new Set(job.qualityTags || []);
  const recommendation = job.analysis?.recommendation || "";
  const modelProvider = job.analysis?.provider || "";
  const realModelSkip = recommendation === "skip" && !["mock", "rule-only", "rule-gate", "rule-fallback"].includes(modelProvider);
  if (decisionState(job) !== "ready" || realModelSkip) return "not_recommended";
  if ((job.risks || []).some((risk) => /薪资低于期望下限/.test(String(risk)))) return "backup";
  if (tags.has("experience_out_of_scope") || tags.has("experience_overrange")) return "backup";
  const requiresConversation = tags.has("algorithm_hybrid")
    || tags.has("experience_stretch")
    || (job.risks || []).some((risk) => /偏训练|算法框架|Java占比|Spring占比|全栈|顾问|实施|应届|学历|经验门槛/.test(String(risk)));
  if (["优先", "可投"].includes(job.level || "") && !requiresConversation && !(job.risks || []).length) return "primary";
  if (["优先", "可投", "可冲"].includes(job.level || "")) return "talk";
  return "backup";
}

function observationContentHash(job) {
  return crypto.createHash("sha256").update(JSON.stringify({
    title: job.title || "", company: job.company || "", location: job.location || "", salary: job.salary || "",
    description: job.description || "", analysis: job.analysis || {}, score: job.score || 0
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

function withFeedback(job, summary) {
  const notes = [];
  let penalty = 0;
  let bonus = 0;
  const qualityTags = [...(job.qualityTags || [])];
  if (job.firstSeenAt && job.lastSeenAt && job.firstSeenAt !== job.lastSeenAt && !qualityTags.includes("duplicate_seen")) {
    qualityTags.push("duplicate_seen");
  }

  const company = summary.companies[job.company];
  if ((company?.invalid || 0) + (company?.salary_mismatch || 0) >= 2 && (company?.interview || 0) === 0) {
    penalty += 14;
    notes.push(`公司历史无效或薪资不匹配 ${(company.invalid || 0) + (company.salary_mismatch || 0)} 次`);
  } else if (company?.skipped >= 2 && company.applied === 0) {
    penalty += 12;
    notes.push(`公司历史跳过 ${company.skipped} 次`);
  }

  const keyword = summary.keywords[job.keyword];
  if ((keyword?.invalid || 0) + (keyword?.salary_mismatch || 0) >= 2 && (keyword?.interview || 0) === 0) {
    penalty += 10;
    notes.push(`关键词历史无效或薪资不匹配：${job.keyword}`);
  } else if (keyword?.skipped >= 3 && keyword.applied === 0) {
    penalty += 8;
    notes.push(`关键词历史低效：${job.keyword}`);
  } else if (keyword?.no_reply >= 5 && keyword.applied === 0) {
    penalty += 4;
    notes.push(`关键词历史无回复偏多：${job.keyword}`);
  } else if ((keyword?.interview || 0) >= 1) {
    bonus += 6;
    notes.push(`关键词曾获得约面：${job.keyword}`);
  } else if (keyword?.applied >= 2 && keyword.skipped === 0) {
    bonus += 3;
    notes.push(`关键词历史有效：${job.keyword}`);
  }

  const version = job.analysis?.recommendedResumeVersion;
  const versionStats = summary.resumeVersions[version];
  if ((versionStats?.interview || 0) >= 1) {
    bonus += 5;
    notes.push("推荐简历版本曾获得约面反馈");
  } else if (versionStats?.applied >= 2 && versionStats.skipped === 0) {
    bonus += 2;
    notes.push("推荐简历版本历史表现较好");
  }

  for (const risk of job.risks || []) {
    const riskStats = summary.risks[risk];
    if (riskStats?.skipped >= 3 && riskStats.applied === 0) {
      penalty += 4;
      notes.push(`风险历史高频跳过：${risk}`);
    }
  }

  return {
    ...job,
    qualityTags,
    feedback: { penalty, bonus, notes },
    feedbackRank: penalty - bonus
  };
}

function compareReportJobs(a, b) {
  return statusRank(a) - statusRank(b)
    || decisionBucketRank(a.decisionBucket) - decisionBucketRank(b.decisionBucket)
    || levelRank(a.level) - levelRank(b.level)
    || hardRiskRank(a) - hardRiskRank(b)
    || workScheduleRank(a) - workScheduleRank(b)
    || (a.feedbackRank || 0) - (b.feedbackRank || 0)
    || qualityRank(a) - qualityRank(b)
    || (a.risks || []).length - (b.risks || []).length
    || b.score - a.score
    || activeRank(a.bossActiveDays) - activeRank(b.bossActiveDays)
    || String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || ""));
}

function statusRank(job) {
  return job.applicationStatus ? 1 : 0;
}

function levelRank(level) {
  return { "优先": 0, "可投": 1, "可冲": 2, "谨慎": 3, "不建议": 4 }[level] ?? 9;
}

function decisionBucketRank(bucket) {
  return { primary: 0, talk: 1, backup: 2, not_recommended: 3 }[bucket] ?? 9;
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
  upsertKeywordSource,
  upsertJob,
  listReportJobs,
  markApplication,
  bindBatchToPlan,
  rescorePlanObservations,
  reassessBatchObservations,
  addFollowUpNote,
  markCandidateJob,
  buildFeedbackSummary,
  buildBatchSummary,
  getLatestBatchId,
  saveProfileAnalysis,
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
  listDecisionPool,
  listDecisionQueue,
  decisionBucket,
  getModelCache,
  saveModelCache
};
