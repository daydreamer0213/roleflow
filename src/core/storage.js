const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const candidateStore = require("../storage/candidate_store");
const jobStore = require("../storage/job_store");
const { nowIso, parseJson, OUTCOME_STATUSES, storageError, optionalInteger, optionalPositiveInteger } = require("../storage/storage_shared");
const {
  saveProfileAnalysis,
  attachResumeDocumentFile,
  getResumeDocument,
  saveSearchPlan,
  getCandidateProfile,
  listCandidateProfiles,
  saveCandidateResumeVersion,
  listCandidateResumeVersions,
  listMatchingResumeVersions,
  recordResumeParseAttempt,
  listResumeParseAttempts,
  updateCandidateProfile,
  getSearchPlan,
  getActiveSearchPlan,
  listSearchPlans,
  listProfileVersions,
  getLatestProfileVersionId,
  getSearchPlanDependency,
  getMatchingCard,
  getActiveMatchingCard,
  listMatchingCards,
  createMatchingCardDraft,
  confirmMatchingCard,
  saveMatchingCardDraftEdit,
  saveConfirmedMatchingCardRevision,
  getCandidateMatchingContext,
  compareProfileVersions,
  saveCandidateFact,
  listCandidateFacts
} = candidateStore;
const { scoreJob, decisionState, parseWorkSchedule } = require("./scoring");
const { parseBossActivityText } = require("./activity_status");
const { mergeJobMetadata } = require("./job_metadata");
const { NEGATIVE_FEEDBACK_STATUSES, normalizeFeedbackReason } = require("./feedback");
const { buildAnalysisRevision, analysisStaleReasons } = require("./analysis_revision");
const { decisionHardBlockers } = require("./model_contract");
const { normalizeMatchingCard, matchingCardRevision, matchingCardFromProfile } = require("./matching_card");
const { PRODUCT_POLICY } = require("./product_policy");
const {
  MIN_COMPLETE_JOB_DESCRIPTION_LENGTH,
  DETAIL_UNVERIFIED_TAG
} = require("./job_description_readiness");
const {
  RECOMMENDATION_SCHEMA_VERSION,
  normalizeRecommendationTier
} = require("./decision_policy");const { buildOutcomeAnalytics } = require("./outcome_analytics");


const VALID_CANDIDATE_STATUSES = new Set(OUTCOME_STATUSES);
const SCAN_RUN_STATUSES = ["running", "completed", "partial", "failed", "interrupted"];
const TERMINAL_SCAN_RUN_STATUSES = new Set(SCAN_RUN_STATUSES.slice(1));
const WORKFLOW_RUN_STATUSES = [
  "created",
  "scanning",
  "analyzing",
  "review_required",
  "communicating",
  "paused",
  "completed",
  "interrupted",
  "failed",
  "stopped"
];
const ACTIVE_WORKFLOW_RUN_STATUSES = ["created", "scanning", "analyzing", "review_required", "communicating", "interrupted", "paused"];
const TERMINAL_WORKFLOW_RUN_STATUSES = new Set(["completed", "failed", "stopped"]);
const WORKFLOW_CONTROL_STATES = new Set(["none", "pause_requested", "stop_requested"]);
const WORKFLOW_TIMEOUT_CIRCUIT_OPEN_CODE = "MODEL_TIMEOUT_CIRCUIT_OPEN";
const WORKFLOW_DETAIL_REQUIRED_CODE = "DETAIL_REQUIRED";
const WORKFLOW_DETAIL_REQUIRED_KIND = "waiting_for_detail";
const WORKFLOW_OBSERVATION_QUALITY_JSON_SQL = `CASE
  WHEN json_valid(COALESCE(o.quality_tags_json, '[]')) THEN CASE
    WHEN json_type(COALESCE(o.quality_tags_json, '[]')) = 'array' THEN COALESCE(o.quality_tags_json, '[]')
    ELSE '["${DETAIL_UNVERIFIED_TAG}"]'
  END
  ELSE '["${DETAIL_UNVERIFIED_TAG}"]'
END`;
const WORKFLOW_OBSERVATION_READY_SQL = `
  length(trim(COALESCE(o.description, ''))) >= ${MIN_COMPLETE_JOB_DESCRIPTION_LENGTH}
  AND NOT EXISTS (
    SELECT 1 FROM json_each(${WORKFLOW_OBSERVATION_QUALITY_JSON_SQL}) quality_tag
    WHERE quality_tag.value = '${DETAIL_UNVERIFIED_TAG}'
  )
`;
const WORKFLOW_TRANSITIONS = Object.freeze({
  created: new Set(["scanning", "review_required", "interrupted", "failed", "stopped"]),
  scanning: new Set(["analyzing", "paused", "interrupted", "failed", "stopped"]),
  analyzing: new Set(["paused", "review_required", "interrupted", "failed", "stopped"]),
  paused: new Set(["scanning", "analyzing", "stopped"]),
  review_required: new Set(["communicating", "completed", "stopped"]),
  communicating: new Set(["completed", "interrupted", "failed", "stopped"]),
  interrupted: new Set(["scanning", "analyzing", "review_required", "communicating", "failed", "stopped"]),
  completed: new Set(),
  failed: new Set(),
  stopped: new Set()
});

const COMMUNICATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS communication_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL DEFAULT 'boss',
  profile_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  browser_mode TEXT NOT NULL CHECK(browser_mode IN ('edge', 'portable')),
  status TEXT NOT NULL CHECK(status IN ('confirmed','running','paused','stopping','completed','stopped','interrupted','failed')),
  policy_json TEXT NOT NULL DEFAULT '{}',
  confirmed_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  stop_code TEXT,
  stop_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(plan_id) REFERENCES search_plans(id)
);

CREATE TABLE IF NOT EXISTS communication_batch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  job_url TEXT NOT NULL,
  title_snapshot TEXT NOT NULL,
  company_snapshot TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('pending','opening','verified','click_dispatched','succeeded','already_communicated','job_unavailable','target_mismatch','action_unavailable','ambiguous','stopped')),
  click_count INTEGER NOT NULL DEFAULT 0 CHECK(click_count BETWEEN 0 AND 1),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  clicked_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id, job_id),
  FOREIGN KEY(batch_id) REFERENCES communication_batches(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_communication_batches_plan ON communication_batches(plan_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_communication_items_batch ON communication_batch_items(batch_id, position);
CREATE INDEX IF NOT EXISTS idx_communication_items_job ON communication_batch_items(job_id, status);
`;

const WORKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  local_day TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 3),
  status TEXT NOT NULL CHECK(status IN ('created','scanning','analyzing','review_required','communicating','paused','completed','interrupted','failed','stopped')),
  target_success_count INTEGER NOT NULL CHECK(target_success_count >= 0),
  successful_count INTEGER NOT NULL DEFAULT 0 CHECK(successful_count >= 0),
  inventory_count INTEGER NOT NULL DEFAULT 0 CHECK(inventory_count >= 0),
  candidate_gap INTEGER NOT NULL DEFAULT 0 CHECK(candidate_gap >= 0),
  scan_needed INTEGER NOT NULL DEFAULT 1 CHECK(scan_needed IN (0, 1)),
  keywords_json TEXT NOT NULL DEFAULT '[]',
  budget_json TEXT NOT NULL DEFAULT '{}',
  planner_json TEXT NOT NULL DEFAULT '{}',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  control_state TEXT NOT NULL DEFAULT 'none' CHECK(control_state IN ('none','pause_requested','stop_requested')),
  resume_phase TEXT CHECK(resume_phase IS NULL OR resume_phase IN ('scanning','analyzing')),
  recovery_generation INTEGER NOT NULL DEFAULT 0 CHECK(recovery_generation >= 0),
  circuit_timeout_job_count INTEGER NOT NULL DEFAULT 0 CHECK(circuit_timeout_job_count >= 0),
  lifetime_timeout_job_count INTEGER NOT NULL DEFAULT 0 CHECK(lifetime_timeout_job_count >= 0),
  progress_revision INTEGER NOT NULL DEFAULT 0 CHECK(progress_revision >= 0),
  last_activity_at TEXT,
  model_config_revision TEXT,
  platform_access_started_at TEXT,
  scan_run_id TEXT,
  scan_batch_id INTEGER,
  communication_batch_id INTEGER,
  shortfall_code TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  review_ready_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, local_day, sequence),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(plan_id) REFERENCES search_plans(id),
  FOREIGN KEY(scan_run_id) REFERENCES scan_runs(id),
  FOREIGN KEY(scan_batch_id) REFERENCES batches(id),
  FOREIGN KEY(communication_batch_id) REFERENCES communication_batches(id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_active
  ON workflow_runs(profile_id, plan_id, local_day, status, sequence);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_daily
  ON workflow_runs(profile_id, local_day, sequence);
`;

const WORKFLOW_TASK_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_job_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_run_id TEXT NOT NULL,
  batch_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  observation_id INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK(position > 0),
  status TEXT NOT NULL CHECK(status IN (
    'pending','running','retry_pending','succeeded','failed','skipped','stopped'
  )),
  recovery_generation INTEGER NOT NULL DEFAULT 0 CHECK(recovery_generation >= 0),
  attempt_count_in_generation INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count_in_generation BETWEEN 0 AND 2),
  total_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(total_attempt_count >= 0),
  priority INTEGER NOT NULL DEFAULT 100,
  available_at TEXT,
  lease_owner TEXT,
  leased_at TEXT,
  lease_expires_at TEXT,
  model_config_revision TEXT,
  last_attempt_model_revision TEXT,
  last_error_code TEXT,
  last_error_stage TEXT,
  last_error_kind TEXT,
  total_latency_ms INTEGER NOT NULL DEFAULT 0 CHECK(total_latency_ms >= 0),
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workflow_run_id, job_id),
  FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id),
  FOREIGN KEY(batch_id) REFERENCES batches(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id),
  FOREIGN KEY(observation_id) REFERENCES job_observations(id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_job_tasks_claim
  ON workflow_job_tasks(workflow_run_id, status, priority, position);
CREATE INDEX IF NOT EXISTS idx_workflow_job_tasks_lease
  ON workflow_job_tasks(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS job_analysis_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_run_id TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  recovery_generation INTEGER NOT NULL CHECK(recovery_generation >= 0),
  attempt_in_generation INTEGER NOT NULL CHECK(attempt_in_generation BETWEEN 1 AND 2),
  total_attempt_number INTEGER NOT NULL CHECK(total_attempt_number > 0),
  profile_kind TEXT NOT NULL CHECK(profile_kind = 'batch_screening'),
  model_config_revision TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking_mode TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  backup_used INTEGER NOT NULL DEFAULT 0 CHECK(backup_used IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
  error_code TEXT,
  error_stage TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0,1)),
  model_call_count INTEGER NOT NULL DEFAULT 0 CHECK(model_call_count >= 0),
  prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK(prompt_tokens >= 0),
  completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK(completion_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(total_tokens >= 0),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  latency_ms INTEGER CHECK(latency_ms IS NULL OR latency_ms >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, recovery_generation, attempt_in_generation),
  FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id),
  FOREIGN KEY(task_id) REFERENCES workflow_job_tasks(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_job_analysis_attempts_progress
  ON job_analysis_attempts(workflow_run_id, model_config_revision, finished_at);
CREATE INDEX IF NOT EXISTS idx_job_analysis_attempts_task
  ON job_analysis_attempts(task_id, recovery_generation, attempt_in_generation);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  backup_path TEXT
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL,
  keyword TEXT,
  started_at TEXT NOT NULL,
  note TEXT,
  profile_id INTEGER,
  search_plan_id INTEGER,
  filter_snapshot_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'partial', 'failed', 'interrupted')),
  finished_at TEXT,
  stop_code TEXT,
  stop_message TEXT
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
  details_json TEXT NOT NULL DEFAULT '{}',
  attempt_number INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  FOREIGN KEY(batch_id) REFERENCES batches(id)
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT 'scan',
  plan_id INTEGER,
  batch_id INTEGER,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'partial', 'failed', 'interrupted')),
  lease_owner TEXT,
  process_id INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  heartbeat_at TEXT,
  finished_at TEXT,
  stop_code TEXT,
  stop_message TEXT,
  process_exit_code INTEGER,
  process_signal TEXT,
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

CREATE TABLE IF NOT EXISTS site_scan_leases (
  site TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  command TEXT NOT NULL,
  plan_id INTEGER,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS idx_scan_runs_status ON scan_runs(status, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_job_refresh_attempts_job ON job_refresh_attempts(job_id, created_at);
${COMMUNICATION_SCHEMA}
${WORKFLOW_SCHEMA}
`;

const MATCHING_CARD_SCHEMA = `
CREATE TABLE IF NOT EXISTS candidate_matching_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  profile_version_id INTEGER NOT NULL,
  resume_document_id INTEGER,
  resume_content_hash TEXT NOT NULL,
  card_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'confirmed', 'superseded')),
  source TEXT NOT NULL CHECK(source IN ('model', 'user', 'migration')),
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(profile_version_id) REFERENCES profile_versions(id),
  FOREIGN KEY(resume_document_id) REFERENCES resume_documents(id)
);
CREATE INDEX IF NOT EXISTS idx_matching_cards_active
  ON candidate_matching_cards(profile_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_matching_cards_resume_hash
  ON candidate_matching_cards(profile_id, resume_content_hash, status);
`;

const CANDIDATE_PROGRESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS candidate_progress_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  recruiter_name TEXT NOT NULL DEFAULT '',
  thread_key TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL,
  next_action TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT,
  last_event_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, job_id),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(plan_id) REFERENCES search_plans(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);
CREATE TABLE IF NOT EXISTS candidate_progress_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(card_id) REFERENCES candidate_progress_cards(id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_progress_cards_plan
  ON candidate_progress_cards(plan_id, stage, updated_at);
CREATE INDEX IF NOT EXISTS idx_candidate_progress_events_card
  ON candidate_progress_events(card_id, occurred_at);
`;

const MESSAGE_PREVIEW_STATES_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_preview_states (
  profile_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  preview_digest TEXT NOT NULL,
  preview_kind TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, platform, conversation_key),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);
`;

const MIGRATIONS = [
  {
    version: 1,
    name: "stable_scan_runtime",
    apply(db) {
      db.exec(SCHEMA);
      migrateLegacySchema(db);
    }
  },
  {
    version: 2,
    name: "communication_batches_v1",
    apply(db) {
      db.exec(COMMUNICATION_SCHEMA);
    }
  },
  {
    version: 3,
    name: "workflow_runs_v1",
    apply(db) {
      db.exec(WORKFLOW_SCHEMA);
      backfillHistoricalCommunicationOutcomes(db);
    }
  },
  {
    version: 4,
    name: "workflow_runs_three_slots",
    apply(db) {
      migrateWorkflowRunSlots(db);
    }
  },
  {
    version: 5,
    name: "candidate_matching_cards_v1",
    apply(db) {
      db.exec(MATCHING_CARD_SCHEMA);
      backfillMigrationMatchingCards(db);
    }
  },
  {
    version: 6,
    name: "durable_workflow_progress_v1",
    apply(db) {
      migrateWorkflowRunDurability(db);
    }
  },
  {
    version: 7,
    name: "candidate_progress_v1",
    apply(db) {
      db.exec(CANDIDATE_PROGRESS_SCHEMA);
      backfillCandidateProgress(db);
    }
  },
  {
    version: 8,
    name: "candidate_progress_event_idempotency",
    apply(db) {
      const columns = db.prepare(
        "PRAGMA table_info(candidate_progress_events)"
      ).all();
      if (!columns.some((column) => column.name === "idempotency_key")) {
        db.exec(
          "ALTER TABLE candidate_progress_events ADD COLUMN idempotency_key TEXT"
        );
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_progress_events_idempotency
          ON candidate_progress_events(card_id, idempotency_key);
        CREATE TRIGGER IF NOT EXISTS candidate_progress_events_require_idempotency
        BEFORE INSERT ON candidate_progress_events
        WHEN NEW.idempotency_key IS NULL OR trim(NEW.idempotency_key) = ''
        BEGIN
          SELECT RAISE(ABORT, 'candidate progress event idempotency required');
        END;
      `);
    }
  },
  {
    version: 9,
    name: "message_preview_states_v1",
    apply(db) {
      db.exec(MESSAGE_PREVIEW_STATES_SCHEMA);
    }
  }
];
const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function openDb(dbPath) {
  const memoryDb = dbPath === ":memory:";
  const existed = memoryDb ? false : fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
  if (!memoryDb) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const fromVersion = Number(db.prepare("PRAGMA user_version").get().user_version || 0);
    if (fromVersion > SCHEMA_VERSION) {
      throw databaseMigrationError(
        "DB_SCHEMA_NEWER_THAN_APP",
        `数据库版本 ${fromVersion} 高于当前程序支持的 ${SCHEMA_VERSION}，请升级 RoleFlow。`
      );
    }
    if (fromVersion < SCHEMA_VERSION) {
      assertDatabaseHealthy(db, "迁移前");
      const backupPath = existed && !memoryDb
        ? createMigrationBackup(db, dbPath, fromVersion, SCHEMA_VERSION)
        : "";
      try {
        db.exec("BEGIN IMMEDIATE");
        for (const migration of MIGRATIONS.filter((item) => item.version > fromVersion)) {
          migration.apply(db);
          db.prepare(`INSERT OR REPLACE INTO schema_migrations(version, name, applied_at, backup_path)
            VALUES (?, ?, ?, ?)`).run(migration.version, migration.name, nowIso(), backupPath || null);
          db.exec(`PRAGMA user_version = ${migration.version}`);
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        const wrapped = databaseMigrationError(
          "DB_MIGRATION_FAILED",
          `数据库从 v${fromVersion} 升级到 v${SCHEMA_VERSION} 失败：${error.message}`,
          error
        );
        wrapped.backupPath = backupPath || null;
        throw wrapped;
      }
      assertDatabaseHealthy(db, "迁移后");
    }
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

function createMigrationBackup(db, dbPath, fromVersion, toVersion) {
  const backupDir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const extension = path.extname(dbPath) || ".sqlite";
  const baseName = path.basename(dbPath, path.extname(dbPath));
  const backupPath = path.join(
    backupDir,
    `${baseName}-before-v${fromVersion}-to-v${toVersion}-${stamp}-${process.pid}${extension}`
  );
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  return backupPath;
}

function assertDatabaseHealthy(db, phase) {
  const row = db.prepare("PRAGMA quick_check").get();
  const result = row?.quick_check || Object.values(row || {})[0];
  if (result !== "ok") {
    throw databaseMigrationError("DB_INTEGRITY_CHECK_FAILED", `${phase}数据库完整性检查失败：${result || "unknown"}`);
  }
}

function databaseMigrationError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function migrateWorkflowRunSlots(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'").get();
  if (!table) {
    db.exec(WORKFLOW_SCHEMA);
    return;
  }
  if (/sequence\s+BETWEEN\s+1\s+AND\s+3/i.test(String(table.sql || ""))) return;

  db.exec(`
    DROP INDEX IF EXISTS idx_workflow_runs_active;
    DROP INDEX IF EXISTS idx_workflow_runs_daily;
    ALTER TABLE workflow_runs RENAME TO workflow_runs_two_slots;
  `);
  db.exec(WORKFLOW_SCHEMA);
  db.exec(`
    INSERT INTO workflow_runs(
      id, profile_id, plan_id, local_day, sequence, status,
      target_success_count, successful_count, inventory_count, candidate_gap, scan_needed,
      keywords_json, budget_json, planner_json, metrics_json,
      scan_run_id, scan_batch_id, communication_batch_id,
      shortfall_code, error_code, error_message,
      created_at, started_at, review_ready_at, finished_at, updated_at
    )
    SELECT
      id, profile_id, plan_id, local_day, sequence, status,
      target_success_count, successful_count, inventory_count, candidate_gap, scan_needed,
      keywords_json, budget_json, planner_json, metrics_json,
      scan_run_id, scan_batch_id, communication_batch_id,
      shortfall_code, error_code, error_message,
      created_at, started_at, review_ready_at, finished_at, updated_at
    FROM workflow_runs_two_slots;
    DROP TABLE workflow_runs_two_slots;
  `);
}

function migrateWorkflowRunDurability(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'").get();
  if (!table) {
    db.exec(WORKFLOW_SCHEMA);
    db.exec(WORKFLOW_TASK_SCHEMA);
    return;
  }
  if (/control_state/i.test(String(table.sql || ""))) {
    db.exec(WORKFLOW_TASK_SCHEMA);
    backfillWorkflowAnalysisTasks(db);
    return;
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_workflow_runs_active;
    DROP INDEX IF EXISTS idx_workflow_runs_daily;
    ALTER TABLE workflow_runs RENAME TO workflow_runs_v5;
  `);
  db.exec(WORKFLOW_SCHEMA);
  db.exec(`
    INSERT INTO workflow_runs(
      id, profile_id, plan_id, local_day, sequence, status,
      target_success_count, successful_count, inventory_count, candidate_gap, scan_needed,
      keywords_json, budget_json, planner_json, metrics_json,
      scan_run_id, scan_batch_id, communication_batch_id,
      shortfall_code, error_code, error_message,
      created_at, started_at, review_ready_at, finished_at, updated_at
    )
    SELECT
      id, profile_id, plan_id, local_day, sequence, status,
      target_success_count, successful_count, inventory_count, candidate_gap, scan_needed,
      keywords_json, budget_json, planner_json, metrics_json,
      scan_run_id, scan_batch_id, communication_batch_id,
      shortfall_code, error_code, error_message,
      created_at, started_at, review_ready_at, finished_at, updated_at
    FROM workflow_runs_v5;
    DROP TABLE workflow_runs_v5;
  `);
  db.exec(WORKFLOW_TASK_SCHEMA);
  backfillWorkflowAnalysisTasks(db);
}

// 旧工作流补建任务：不调用模型、网络或真实平台。只按已有 observation 的分析状态保守推断，
// 不把旧规则结果伪装成新模型成功，也不写入任何 job_analysis_attempts 历史。
function backfillWorkflowAnalysisTasks(db) {
  const workflows = db.prepare(`
    SELECT id, scan_batch_id
    FROM workflow_runs
    WHERE scan_batch_id IS NOT NULL
    ORDER BY created_at, id
  `).all();
  for (const workflow of workflows) {
    const rows = db.prepare(`
      SELECT o.id AS observation_id, o.job_id AS job_id, o.analysis_json AS analysis_json
      FROM job_observations o
      WHERE o.batch_id = ?
      ORDER BY o.seen_at, o.id
    `).all(workflow.scan_batch_id);
    const insertTask = db.prepare(`
      INSERT OR IGNORE INTO workflow_job_tasks(
        workflow_run_id, batch_id, job_id, observation_id, position, status,
        recovery_generation, attempt_count_in_generation, total_attempt_count, priority,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 100, ?, ?)
    `);
    let position = 0;
    for (const row of rows) {
      const analysis = parseJson(row.analysis_json, {});
      const semantic = String(analysis.semanticStatus || "");
      const source = String(analysis.decisionSource || "");
      let status = "pending";
      if (semantic === "complete" && source === "model") status = "succeeded";
      else if (source === "local_rules" || semantic === "rule_only") status = "skipped";
      position += 1;
      const now = nowIso();
      insertTask.run(
        workflow.id,
        workflow.scan_batch_id,
        row.job_id,
        row.observation_id,
        position,
        status,
        now,
        now
      );
    }
  }
}

// 旧数据补卡：不调用模型、网络或真实平台，只为尚无任何 draft/confirmed 卡的候选人，
// 从其最新画像版本与关联简历文档生成 source="migration" 的草稿卡。
function backfillMigrationMatchingCards(db) {
  const candidates = db.prepare("SELECT id, source_hash FROM candidate_profiles").all();
  const existingCard = db.prepare(`SELECT id FROM candidate_matching_cards
    WHERE profile_id = ? AND status IN ('draft', 'confirmed') LIMIT 1`);
  const latestVersion = db.prepare(`SELECT pv.id AS profile_version_id, pv.profile_json, pv.resume_document_id,
      rd.content_hash AS resume_content_hash
    FROM profile_versions pv
    LEFT JOIN resume_documents rd ON rd.id = pv.resume_document_id
    WHERE pv.profile_id = ?
    ORDER BY pv.created_at DESC, pv.id DESC LIMIT 1`);
  const insert = db.prepare(`INSERT INTO candidate_matching_cards(
    profile_id, profile_version_id, resume_document_id, resume_content_hash,
    card_json, status, source, confirmed_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'draft', 'migration', NULL, ?, ?)`);
  for (const candidate of candidates) {
    if (existingCard.get(Number(candidate.id))) continue;
    const version = latestVersion.get(Number(candidate.id));
    if (!version) continue;
    const card = normalizeMatchingCard(matchingCardFromProfile(parseJson(version.profile_json, {})), { source: "migration" });
    const now = nowIso();
    insert.run(
      Number(candidate.id),
      Number(version.profile_version_id),
      version.resume_document_id || null,
      String(version.resume_content_hash || candidate.source_hash || ""),
      JSON.stringify(card),
      now,
      now
    );
  }
}

function recordSiteAccessEvent(db, {
  site,
  action,
  runId = "",
  details = {},
  createdAt = new Date().toISOString()
}) {
  const normalizedSite = String(site || "").trim().toLowerCase();
  const normalizedAction = String(action || "").trim().toLowerCase();
  if (!normalizedSite || !normalizedAction) throw new Error("站点访问事件必须包含 site 和 action。");
  const payload = { ...details, site: normalizedSite, action: normalizedAction, runId: String(runId || "") };
  const result = db.prepare("INSERT INTO events(job_id, event_type, payload_json, created_at) VALUES (NULL, 'site_access', ?, ?)")
    .run(JSON.stringify(payload), String(createdAt));
  return { id: Number(result.lastInsertRowid), site: normalizedSite, action: normalizedAction, createdAt: String(createdAt), details: payload };
}

function listSiteAccessEvents(db, { site, action = "", since = "1970-01-01T00:00:00.000Z", limit = 10000 } = {}) {
  const normalizedSite = String(site || "").trim().toLowerCase();
  const normalizedAction = String(action || "").trim().toLowerCase();
  const actionClause = normalizedAction ? " AND json_extract(payload_json, '$.action') = ?" : "";
  const params = [String(since), normalizedSite];
  if (normalizedAction) params.push(normalizedAction);
  params.push(Math.max(1, Math.min(10000, Number(limit) || 10000)));
  return db.prepare(`SELECT id, payload_json, created_at FROM events
    WHERE event_type = 'site_access' AND created_at >= ?
      AND json_extract(payload_json, '$.site') = ?${actionClause}
    ORDER BY created_at ASC, id ASC LIMIT ?`)
    .all(...params)
    .map((row) => ({ id: Number(row.id), createdAt: row.created_at, details: parseJson(row.payload_json, {}) }))
    .filter((event) => event.details.site === normalizedSite && (!normalizedAction || event.details.action === normalizedAction))
    .map((event) => ({ ...event, site: event.details.site, action: event.details.action }));
}

function migrateLegacySchema(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name));
  if (!columns.has("analysis_json")) {
    db.exec("ALTER TABLE jobs ADD COLUMN analysis_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!columns.has("quality_tags_json")) {
    db.exec("ALTER TABLE jobs ADD COLUMN quality_tags_json TEXT NOT NULL DEFAULT '[]'");
  }
  const batchColumns = new Set(db.prepare("PRAGMA table_info(batches)").all().map((column) => column.name));
  const migratedLegacyBatchStatus = !batchColumns.has("status");
  if (!batchColumns.has("profile_id")) db.exec("ALTER TABLE batches ADD COLUMN profile_id INTEGER");
  if (!batchColumns.has("search_plan_id")) db.exec("ALTER TABLE batches ADD COLUMN search_plan_id INTEGER");
  if (!batchColumns.has("filter_snapshot_json")) db.exec("ALTER TABLE batches ADD COLUMN filter_snapshot_json TEXT NOT NULL DEFAULT '{}'");
  if (!batchColumns.has("status")) db.exec("ALTER TABLE batches ADD COLUMN status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'partial', 'failed', 'interrupted'))");
  if (!batchColumns.has("finished_at")) db.exec("ALTER TABLE batches ADD COLUMN finished_at TEXT");
  if (!batchColumns.has("stop_code")) db.exec("ALTER TABLE batches ADD COLUMN stop_code TEXT");
  if (!batchColumns.has("stop_message")) db.exec("ALTER TABLE batches ADD COLUMN stop_message TEXT");
  const resumeColumns = new Set(db.prepare("PRAGMA table_info(resume_documents)").all().map((column) => column.name));
  if (!resumeColumns.has("diagnostics_json")) db.exec("ALTER TABLE resume_documents ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '{}'");
  if (!resumeColumns.has("stored_file_path")) db.exec("ALTER TABLE resume_documents ADD COLUMN stored_file_path TEXT");
  const resumeVersionColumns = new Set(db.prepare("PRAGMA table_info(candidate_resume_versions)").all().map((column) => column.name));
  if (!resumeVersionColumns.has("analysis_json")) db.exec("ALTER TABLE candidate_resume_versions ADD COLUMN analysis_json TEXT NOT NULL DEFAULT '{}'");
  const planColumns = new Set(db.prepare("PRAGMA table_info(search_plans)").all().map((column) => column.name));
  if (!planColumns.has("profile_version_id")) db.exec("ALTER TABLE search_plans ADD COLUMN profile_version_id INTEGER");
  const observationColumns = new Set(db.prepare("PRAGMA table_info(job_observations)").all().map((column) => column.name));
  if (!observationColumns.has("content_hash_version")) db.exec("ALTER TABLE job_observations ADD COLUMN content_hash_version INTEGER NOT NULL DEFAULT 0");
  const scanTargetColumns = new Set(db.prepare("PRAGMA table_info(scan_target_results)").all().map((column) => column.name));
  if (!scanTargetColumns.has("details_json")) db.exec("ALTER TABLE scan_target_results ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}'");
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
  if (migratedLegacyBatchStatus) backfillLegacyBatchStatuses(db);
}

function backfillLegacyBatchStatuses(db) {
  const batches = db.prepare("SELECT id, started_at FROM batches ORDER BY id").all();
  const targetFinished = db.prepare("SELECT MAX(finished_at) AS value FROM scan_target_results WHERE batch_id = ?");
  const observationFinished = db.prepare("SELECT MAX(seen_at) AS value FROM job_observations WHERE batch_id = ?");
  const update = db.prepare(`UPDATE batches
    SET status = ?, finished_at = ?, stop_code = ?, stop_message = ?
    WHERE id = ?`);
  for (const batch of batches) {
    const summary = summarizeScanTargets(db, batch.id);
    const status = summary.total ? summary.status : "completed";
    const finishedAt = targetFinished.get(batch.id)?.value
      || observationFinished.get(batch.id)?.value
      || batch.started_at;
    const stopCode = status === "completed" ? "LEGACY_STATUS_INFERRED" : "LEGACY_TARGET_STATUS_INFERRED";
    const stopMessage = summary.total
      ? `Migrated from ${summary.total} legacy target checkpoint(s).`
      : "Migrated without legacy target checkpoints; completion was inferred from saved observations.";
    update.run(status, finishedAt, stopCode, stopMessage, batch.id);
  }
}

function backfillObservationContentHashes(db) {
  const rows = db.prepare(`
    SELECT id, title, company, location, salary, experience, education, tags_json, description
    FROM job_observations
    WHERE content_hash_version < 1
  `).all();
  const update = db.prepare("UPDATE job_observations SET content_hash = ?, content_hash_version = 1 WHERE id = ?");
  for (const row of rows) update.run(jobStore.sourceContentHash({ ...row, tags: parseJson(row.tags_json, []) }), row.id);
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

function backfillHistoricalCommunicationOutcomes(db) {
  const result = db.prepare(`WITH ranked AS (
      SELECT batches.profile_id, batches.plan_id, items.job_id, items.status, items.updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY batches.profile_id, items.job_id
          ORDER BY CASE items.status
            WHEN 'succeeded' THEN 0
            WHEN 'already_communicated' THEN 0
            WHEN 'job_unavailable' THEN 1
            WHEN 'target_mismatch' THEN 2
            WHEN 'action_unavailable' THEN 3
            ELSE 9 END,
            items.updated_at DESC, items.id DESC
        ) AS rank
      FROM communication_batch_items items
      JOIN communication_batches batches ON batches.id = items.batch_id
      WHERE items.status IN ('succeeded','already_communicated','job_unavailable','target_mismatch','action_unavailable')
    )
    INSERT OR IGNORE INTO candidate_job_states(
      profile_id, job_id, plan_id, status, reason_code, note, review_at, updated_at
    )
    SELECT profile_id, job_id, plan_id,
      CASE status
        WHEN 'succeeded' THEN 'applied'
        WHEN 'already_communicated' THEN 'applied'
        WHEN 'job_unavailable' THEN 'invalid'
        WHEN 'target_mismatch' THEN 'review'
        WHEN 'action_unavailable' THEN 'later'
      END,
      status,
      'RoleFlow v3 communication outcome backfill',
      CASE WHEN status = 'action_unavailable'
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+1 day') ELSE NULL END,
      updated_at
    FROM ranked WHERE rank = 1`).run();
  return Number(result.changes || 0);
}

function backfillCandidateProgress(db) {
  db.exec(`
    INSERT OR IGNORE INTO candidate_progress_cards(
      profile_id, plan_id, job_id, source, stage, next_action,
      last_event_at, created_at, updated_at
    )
    SELECT states.profile_id, states.plan_id, states.job_id, jobs.source,
      'waiting_reply', 'Wait for recruiter reply',
      states.updated_at, states.updated_at, states.updated_at
    FROM candidate_job_states states
    JOIN jobs ON jobs.id = states.job_id
    JOIN search_plans plans
      ON plans.id = states.plan_id
      AND plans.profile_id = states.profile_id
    WHERE states.reason_code IN ('communication_succeeded', 'succeeded', 'already_communicated')
  `);
  db.exec(`
    INSERT INTO candidate_progress_events(
      card_id, idempotency_key, type, actor, summary,
      metadata_json, occurred_at, created_at
    )
    SELECT cards.id,
      'migration:communication:' || states.profile_id || ':' || states.job_id || ':' || states.reason_code,
      CASE states.reason_code
        WHEN 'already_communicated' THEN 'contact_already_exists'
        ELSE 'contact_started'
      END,
      'system',
      CASE states.reason_code
        WHEN 'already_communicated' THEN 'Historical platform contact preserved'
        ELSE 'Historical verified contact preserved'
      END,
      json_object('source', 'migration', 'outcome', states.reason_code),
      states.updated_at,
      states.updated_at
    FROM candidate_job_states states
    JOIN candidate_progress_cards cards
      ON cards.profile_id = states.profile_id
      AND cards.job_id = states.job_id
    WHERE states.reason_code IN ('communication_succeeded', 'succeeded', 'already_communicated')
      AND NOT EXISTS (
        SELECT 1 FROM candidate_progress_events events
        WHERE events.card_id = cards.id
          AND events.idempotency_key =
            'migration:communication:' || states.profile_id || ':' || states.job_id || ':' || states.reason_code
      )
  `);
}

function createWorkflowRun(db, input = {}) {
  const id = String(input.id || crypto.randomUUID()).trim();
  const profileId = optionalPositiveInteger(input.profileId, "profileId");
  const planId = optionalPositiveInteger(input.planId, "planId");
  const localDay = String(input.localDay || "").trim();
  const sequence = optionalPositiveInteger(input.sequence, "sequence");
  if (!id) throw workflowRunError("WORKFLOW_RUN_ID_REQUIRED", "workflow run id is required");
  if (!profileId || !planId) throw workflowRunError("WORKFLOW_OWNER_REQUIRED", "workflow run profile and plan are required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDay)) {
    throw workflowRunError("WORKFLOW_LOCAL_DAY_INVALID", "workflow local day must use YYYY-MM-DD");
  }
  if (![1, 2, 3].includes(sequence)) {
    throw workflowRunError("WORKFLOW_SEQUENCE_INVALID", "workflow run sequence must be 1, 2, or 3");
  }
  const owner = db.prepare("SELECT profile_id FROM search_plans WHERE id = ?").get(planId);
  if (!owner || Number(owner.profile_id) !== profileId) {
    throw workflowRunError("WORKFLOW_PLAN_PROFILE_MISMATCH", "workflow plan does not belong to the selected profile");
  }
  const now = String(input.createdAt || nowIso());
  try {
    db.prepare(`INSERT INTO workflow_runs(
      id, profile_id, plan_id, local_day, sequence, status,
      target_success_count, successful_count, inventory_count, candidate_gap, scan_needed,
      keywords_json, budget_json, planner_json, metrics_json,
      shortfall_code, error_code, error_message, model_config_revision, last_activity_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        profileId,
        planId,
        localDay,
        sequence,
        nonNegativeInteger(input.targetSuccessCount),
        nonNegativeInteger(input.successfulCount),
        nonNegativeInteger(input.inventoryCount),
        nonNegativeInteger(input.candidateGap),
        input.scanNeeded === false ? 0 : 1,
        JSON.stringify(Array.isArray(input.keywords) ? input.keywords : []),
        JSON.stringify(input.budget || {}),
        JSON.stringify(input.planner || {}),
        JSON.stringify(input.metrics || {}),
        nullableText(input.shortfallCode),
        nullableText(input.errorCode),
        nullableText(input.errorMessage, 2000),
        nullableText(input.modelConfigRevision),
        now,
        now,
        now
      );
  } catch (error) {
    if (/workflow_runs\.profile_id, workflow_runs\.local_day, workflow_runs\.sequence|UNIQUE constraint failed: workflow_runs/i.test(error.message)) {
      throw workflowRunError("WORKFLOW_RUN_SLOT_EXISTS", "workflow run slot already exists for this local day");
    }
    throw error;
  }
  return getWorkflowRun(db, id);
}

function getWorkflowRun(db, id) {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) return null;
  const row = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(normalizedId);
  return row ? workflowRunRow(row) : null;
}

function getWorkflowRunByCommunicationBatch(db, communicationBatchId) {
  const batchId = optionalPositiveInteger(communicationBatchId, "communicationBatchId");
  if (!batchId) return null;
  const row = db.prepare("SELECT * FROM workflow_runs WHERE communication_batch_id = ?").get(batchId);
  return row ? workflowRunRow(row) : null;
}

function listWorkflowRuns(db, filters = {}) {
  const clauses = [];
  const params = [];
  const profileId = optionalPositiveInteger(filters.profileId, "profileId");
  const planId = optionalPositiveInteger(filters.planId, "planId");
  if (profileId) { clauses.push("profile_id = ?"); params.push(profileId); }
  if (planId) { clauses.push("plan_id = ?"); params.push(planId); }
  if (filters.localDay) { clauses.push("local_day = ?"); params.push(String(filters.localDay)); }
  const statuses = (Array.isArray(filters.statuses) ? filters.statuses : [])
    .map((status) => String(status || "").trim())
    .filter((status) => WORKFLOW_RUN_STATUSES.includes(status));
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  const limit = Math.max(1, Math.min(500, Number(filters.limit) || 100));
  params.push(limit);
  return db.prepare(`SELECT * FROM workflow_runs
    ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY local_day DESC, sequence DESC, created_at DESC LIMIT ?`)
    .all(...params)
    .map(workflowRunRow);
}

function getActiveWorkflowRun(db, filters = {}) {
  return listWorkflowRuns(db, {
    ...filters,
    statuses: ACTIVE_WORKFLOW_RUN_STATUSES,
    limit: 1
  })[0] || null;
}

function transitionWorkflowRun(db, input = {}) {
  const id = String(input.id || input.workflowRunId || "").trim();
  const nextStatus = String(input.status || "").trim();
  const current = getWorkflowRun(db, id);
  if (!current) throw workflowRunError("WORKFLOW_RUN_NOT_FOUND", "workflow run was not found");
  if (!WORKFLOW_RUN_STATUSES.includes(nextStatus)) {
    throw workflowRunError("WORKFLOW_STATUS_INVALID", "workflow run status is invalid");
  }
  if (nextStatus !== current.status && !WORKFLOW_TRANSITIONS[current.status]?.has(nextStatus)) {
    throw workflowRunError("WORKFLOW_TRANSITION_INVALID", `workflow run cannot transition from ${current.status} to ${nextStatus}`);
  }
  const now = String(input.updatedAt || nowIso());
  const resumed = (current.status === "interrupted" || current.status === "paused")
    && ["scanning", "analyzing", "review_required", "communicating"].includes(nextStatus);
  const errorCode = resumed ? null
    : Object.hasOwn(input, "errorCode") ? nullableText(input.errorCode)
      : nullableText(current.errorCode);
  const errorMessage = resumed ? null
    : Object.hasOwn(input, "errorMessage") ? nullableText(input.errorMessage, 2000)
      : nullableText(current.errorMessage, 2000);
  const metrics = Object.hasOwn(input, "metrics") ? input.metrics : current.metrics;
  const controlState = Object.hasOwn(input, "controlState")
    ? String(input.controlState || "none")
    : current.controlState || "none";
  if (!WORKFLOW_CONTROL_STATES.has(controlState)) {
    throw workflowRunError("WORKFLOW_CONTROL_INVALID", "workflow run control state is invalid");
  }
  const interruptedResumePhase = nextStatus === "interrupted"
    && ["scanning", "analyzing"].includes(current.status)
    ? current.status
    : null;
  const resumePhase = Object.hasOwn(input, "resumePhase")
    ? (input.resumePhase ? String(input.resumePhase) : null)
    : (resumed ? null : (current.resumePhase || interruptedResumePhase));
  if (resumePhase && !["scanning", "analyzing"].includes(resumePhase)) {
    throw workflowRunError("WORKFLOW_RESUME_PHASE_INVALID", "workflow run resume phase is invalid");
  }
  const progressRevision = Object.hasOwn(input, "progressRevision")
    ? nonNegativeInteger(input.progressRevision)
    : current.progressRevision;
  const recoveryGeneration = Object.hasOwn(input, "recoveryGeneration")
    ? nonNegativeInteger(input.recoveryGeneration)
    : current.recoveryGeneration;
  const circuitTimeoutJobCount = Object.hasOwn(input, "circuitTimeoutJobCount")
    ? nonNegativeInteger(input.circuitTimeoutJobCount)
    : current.circuitTimeoutJobCount;
  const lifetimeTimeoutJobCount = Object.hasOwn(input, "lifetimeTimeoutJobCount")
    ? nonNegativeInteger(input.lifetimeTimeoutJobCount)
    : current.lifetimeTimeoutJobCount;
  const modelConfigRevision = Object.hasOwn(input, "modelConfigRevision")
    ? nullableText(input.modelConfigRevision)
    : nullableText(current.modelConfigRevision);
  const lastActivityAt = Object.hasOwn(input, "lastActivityAt")
    ? String(input.lastActivityAt || now)
    : String(current.lastActivityAt || now);
  const platformAccessStartedAt = Object.hasOwn(input, "platformAccessStartedAt")
    ? (input.platformAccessStartedAt ? String(input.platformAccessStartedAt) : null)
    : String(current.platformAccessStartedAt || "");
  db.prepare(`UPDATE workflow_runs SET
      status = ?,
      successful_count = ?,
      inventory_count = ?,
      metrics_json = ?,
      shortfall_code = ?,
      error_code = ?,
      error_message = ?,
      control_state = ?,
      resume_phase = ?,
      recovery_generation = ?,
      circuit_timeout_job_count = ?,
      lifetime_timeout_job_count = ?,
      progress_revision = ?,
      last_activity_at = ?,
      model_config_revision = ?,
      platform_access_started_at = ?,
      started_at = CASE WHEN ? IN ('scanning','review_required') THEN COALESCE(started_at, ?) ELSE started_at END,
      review_ready_at = CASE WHEN ? = 'review_required' THEN COALESCE(review_ready_at, ?) ELSE review_ready_at END,
      finished_at = CASE WHEN ? IN ('completed','failed','stopped') THEN COALESCE(finished_at, ?) ELSE finished_at END,
      updated_at = ?
    WHERE id = ?`)
    .run(
      nextStatus,
      Object.hasOwn(input, "successfulCount") ? nonNegativeInteger(input.successfulCount) : current.successfulCount,
      Object.hasOwn(input, "inventoryCount") ? nonNegativeInteger(input.inventoryCount) : current.inventoryCount,
      JSON.stringify(metrics || {}),
      Object.hasOwn(input, "shortfallCode") ? nullableText(input.shortfallCode) : nullableText(current.shortfallCode),
      errorCode,
      errorMessage,
      controlState,
      resumePhase,
      recoveryGeneration,
      circuitTimeoutJobCount,
      lifetimeTimeoutJobCount,
      progressRevision,
      lastActivityAt,
      modelConfigRevision,
      platformAccessStartedAt || null,
      nextStatus,
      now,
      nextStatus,
      now,
      nextStatus,
      now,
      now,
      id
    );
  return getWorkflowRun(db, id);
}

function attachWorkflowScan(db, input = {}) {
  return immediateTransaction(db, () => {
    const id = String(input.id || input.workflowRunId || "").trim();
    const run = getWorkflowRun(db, id);
    if (!run) throw workflowRunError("WORKFLOW_RUN_NOT_FOUND", "workflow run was not found");
    if (!["scanning", "analyzing", "interrupted"].includes(run.status)) {
      throw workflowRunError(
        "WORKFLOW_SCAN_LINK_INVALID",
        "workflow execution can only be attached during scanning, analyzing, or interruption"
      );
    }
    const scanRunId = String(input.scanRunId || "").trim();
    const scanBatchId = optionalPositiveInteger(input.scanBatchId, "scanBatchId");
    if (!scanRunId || !scanBatchId) throw workflowRunError("WORKFLOW_SCAN_LINK_REQUIRED", "scan run and batch are required");
    const owner = db.prepare(`
      SELECT id
      FROM workflow_runs
      WHERE scan_run_id = ? AND id <> ?
      LIMIT 1
    `).get(scanRunId, id);
    if (owner) {
      throw workflowRunError(
        "WORKFLOW_SCAN_EXECUTION_OWNED",
        "scan execution is already attached to another workflow run"
      );
    }
    if (run.scanBatchId && run.scanBatchId !== scanBatchId) {
      throw workflowRunError("WORKFLOW_SCAN_LINK_MISMATCH", "workflow run is already attached to another scan");
    }
    if (run.scanRunId && run.scanRunId !== scanRunId) {
      const previous = db.prepare("SELECT status, batch_id, plan_id FROM scan_runs WHERE id = ?").get(run.scanRunId);
      if (!previous
        || previous.status === "running"
        || Number(previous.plan_id || 0) !== run.planId
        || (previous.batch_id && Number(previous.batch_id) !== scanBatchId)) {
        throw workflowRunError("WORKFLOW_SCAN_LINK_MISMATCH", "workflow run is already attached to another active scan");
      }
    }
    const scan = db.prepare("SELECT plan_id, batch_id, status FROM scan_runs WHERE id = ?").get(scanRunId);
    const batch = db.prepare("SELECT search_plan_id FROM batches WHERE id = ?").get(scanBatchId);
    if (!scan || !batch || Number(scan.plan_id || 0) !== run.planId || Number(batch.search_plan_id || 0) !== run.planId
      || scan.status !== "running" || (scan.batch_id && Number(scan.batch_id) !== scanBatchId)) {
      throw workflowRunError("WORKFLOW_SCAN_LINK_MISMATCH", "scan run or batch does not belong to this workflow plan");
    }
    db.prepare("UPDATE workflow_runs SET scan_run_id = ?, scan_batch_id = ?, updated_at = ? WHERE id = ?")
      .run(scanRunId, scanBatchId, nowIso(), id);
    return getWorkflowRun(db, id);
  });
}

function attachWorkflowScanRun(db, input = {}) {
  return immediateTransaction(db, () => {
    const id = String(input.id || input.workflowRunId || "").trim();
    const run = getWorkflowRun(db, id);
    if (!run) throw workflowRunError("WORKFLOW_RUN_NOT_FOUND", "workflow run was not found");
    if (!["scanning", "analyzing", "interrupted"].includes(run.status)) {
      throw workflowRunError(
        "WORKFLOW_SCAN_LINK_INVALID",
        "workflow execution can only be attached during scanning, analyzing, or interruption"
      );
    }
    const scanRunId = String(input.scanRunId || "").trim();
    if (!scanRunId) throw workflowRunError("WORKFLOW_SCAN_RUN_REQUIRED", "scan run is required");
    const owner = db.prepare(`
      SELECT id
      FROM workflow_runs
      WHERE scan_run_id = ? AND id <> ?
      LIMIT 1
    `).get(scanRunId, id);
    if (owner) {
      throw workflowRunError(
        "WORKFLOW_SCAN_EXECUTION_OWNED",
        "scan execution is already attached to another workflow run"
      );
    }
    if (run.scanRunId && run.scanRunId !== scanRunId) {
      const previous = db.prepare("SELECT status, plan_id FROM scan_runs WHERE id = ?").get(run.scanRunId);
      if (!previous || previous.status === "running" || Number(previous.plan_id || 0) !== run.planId) {
        throw workflowRunError("WORKFLOW_SCAN_LINK_MISMATCH", "workflow run is already attached to another active scan");
      }
    }
    const scan = db.prepare("SELECT plan_id, status FROM scan_runs WHERE id = ?").get(scanRunId);
    if (!scan || Number(scan.plan_id || 0) !== run.planId || scan.status !== "running") {
      throw workflowRunError("WORKFLOW_SCAN_LINK_MISMATCH", "scan run does not belong to this workflow plan");
    }
    db.prepare("UPDATE workflow_runs SET scan_run_id = ?, updated_at = ? WHERE id = ?")
      .run(scanRunId, nowIso(), id);
    return getWorkflowRun(db, id);
  });
}

function attachWorkflowCommunication(db, input = {}) {
  const id = String(input.id || input.workflowRunId || "").trim();
  const run = getWorkflowRun(db, id);
  if (!run) throw workflowRunError("WORKFLOW_RUN_NOT_FOUND", "workflow run was not found");
  if (!["review_required", "communicating", "interrupted"].includes(run.status)) {
    throw workflowRunError("WORKFLOW_COMMUNICATION_LINK_INVALID", "communication can only be attached after review");
  }
  const communicationBatchId = optionalPositiveInteger(input.communicationBatchId, "communicationBatchId");
  if (!communicationBatchId) throw workflowRunError("WORKFLOW_COMMUNICATION_LINK_REQUIRED", "communication batch is required");
  if (run.communicationBatchId && run.communicationBatchId !== communicationBatchId) {
    throw workflowRunError("WORKFLOW_COMMUNICATION_LINK_MISMATCH", "workflow run is already attached to another communication batch");
  }
  const batch = db.prepare("SELECT profile_id, plan_id FROM communication_batches WHERE id = ?").get(communicationBatchId);
  if (!batch || Number(batch.profile_id) !== run.profileId || Number(batch.plan_id) !== run.planId) {
    throw workflowRunError("WORKFLOW_COMMUNICATION_LINK_MISMATCH", "communication batch does not belong to this workflow run");
  }
  db.prepare("UPDATE workflow_runs SET communication_batch_id = ?, updated_at = ? WHERE id = ?")
    .run(communicationBatchId, nowIso(), id);
  return getWorkflowRun(db, id);
}

function workflowRunRow(row) {
  return {
    id: row.id,
    profileId: Number(row.profile_id),
    planId: Number(row.plan_id),
    localDay: row.local_day,
    sequence: Number(row.sequence),
    status: row.status,
    targetSuccessCount: Number(row.target_success_count),
    successfulCount: Number(row.successful_count),
    inventoryCount: Number(row.inventory_count),
    candidateGap: Number(row.candidate_gap),
    scanNeeded: Boolean(row.scan_needed),
    keywords: parseJson(row.keywords_json, []),
    budget: parseJson(row.budget_json, {}),
    planner: parseJson(row.planner_json, {}),
    metrics: parseJson(row.metrics_json, {}),
    scanRunId: row.scan_run_id || "",
    scanBatchId: Number(row.scan_batch_id || 0) || null,
    communicationBatchId: Number(row.communication_batch_id || 0) || null,
    shortfallCode: row.shortfall_code || "",
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    controlState: row.control_state || "none",
    resumePhase: row.resume_phase || null,
    recoveryGeneration: Number(row.recovery_generation || 0),
    circuitTimeoutJobCount: Number(row.circuit_timeout_job_count || 0),
    lifetimeTimeoutJobCount: Number(row.lifetime_timeout_job_count || 0),
    progressRevision: Number(row.progress_revision || 0),
    lastActivityAt: row.last_activity_at || null,
    modelConfigRevision: row.model_config_revision || "",
    platformAccessStartedAt: row.platform_access_started_at || null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    reviewReadyAt: row.review_ready_at || null,
    finishedAt: row.finished_at || null,
    updatedAt: row.updated_at
  };
}

function immediateTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function workflowJobTaskRow(row) {
  return {
    id: Number(row.id),
    workflowRunId: row.workflow_run_id,
    batchId: Number(row.batch_id),
    jobId: Number(row.job_id),
    observationId: Number(row.observation_id),
    position: Number(row.position),
    status: row.status,
    recoveryGeneration: Number(row.recovery_generation || 0),
    attemptCountInGeneration: Number(row.attempt_count_in_generation || 0),
    totalAttemptCount: Number(row.total_attempt_count || 0),
    priority: Number(row.priority || 100),
    availableAt: row.available_at || null,
    leaseOwner: row.lease_owner || null,
    leasedAt: row.leased_at || null,
    leaseExpiresAt: row.lease_expires_at || null,
    modelConfigRevision: row.model_config_revision || null,
    lastAttemptModelRevision: row.last_attempt_model_revision || null,
    lastErrorCode: row.last_error_code || null,
    lastErrorStage: row.last_error_stage || null,
    lastErrorKind: row.last_error_kind || null,
    totalLatencyMs: Number(row.total_latency_ms || 0),
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function jobAnalysisAttemptRow(row) {
  return {
    id: Number(row.id),
    workflowRunId: row.workflow_run_id,
    taskId: Number(row.task_id),
    jobId: Number(row.job_id),
    recoveryGeneration: Number(row.recovery_generation || 0),
    attemptInGeneration: Number(row.attempt_in_generation),
    totalAttemptNumber: Number(row.total_attempt_number),
    profileKind: row.profile_kind,
    modelConfigRevision: row.model_config_revision,
    provider: row.provider,
    model: row.model,
    thinkingMode: row.thinking_mode,
    reasoningEffort: row.reasoning_effort,
    backupUsed: Number(row.backup_used || 0),
    status: row.status,
    errorCode: row.error_code || null,
    errorStage: row.error_stage || null,
    retryable: Number(row.retryable || 0),
    modelCallCount: Number(row.model_call_count || 0),
    promptTokens: Number(row.prompt_tokens || 0),
    completionTokens: Number(row.completion_tokens || 0),
    totalTokens: Number(row.total_tokens || 0),
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function workflowObservationJobRow(row) {
  return {
    id: Number(row.job_id),
    source: row.source,
    sourceId: row.source_id,
    observationId: Number(row.id),
    batchId: Number(row.batch_id),
    keyword: row.keyword || null,
    title: row.title,
    company: row.company || null,
    location: row.location || null,
    salary: row.salary || null,
    experience: row.experience || null,
    education: row.education || null,
    bossActiveText: row.boss_active_text || null,
    bossActiveDays: row.boss_active_days ?? null,
    url: row.url || null,
    tags: parseJson(row.tags_json, []),
    description: row.description || null,
    score: Number(row.score || 0),
    level: row.level || null,
    matches: parseJson(row.matches_json, []),
    risks: parseJson(row.risks_json, []),
    qualityTags: parseJson(row.quality_tags_json, []),
    greeting: row.greeting || null,
    analysis: parseJson(row.analysis_json, {})
  };
}

function countWorkflowJobTasks(db, workflowRunId) {
  return Number(db.prepare(
    "SELECT count(*) AS n FROM workflow_job_tasks WHERE workflow_run_id = ?"
  ).get(workflowRunId).n);
}

function insertWorkflowJobTaskRow(db, {
  workflowRunId,
  batchId,
  jobId,
  observationId,
  position,
  status,
  recoveryGeneration,
  modelConfigRevision,
  now
}) {
  return db.prepare(`
    INSERT INTO workflow_job_tasks(
      workflow_run_id, batch_id, job_id, observation_id, position, status,
      recovery_generation, attempt_count_in_generation, total_attempt_count, priority,
      model_config_revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 100, ?, ?, ?)
    ON CONFLICT(workflow_run_id, job_id) DO NOTHING
  `).run(
    workflowRunId,
    batchId,
    jobId,
    observationId,
    position,
    status,
    recoveryGeneration,
    modelConfigRevision || null,
    now,
    now
  );
}

function reactivateWorkflowDetailRequiredTaskRow(db, {
  workflowRunId,
  batchId,
  jobId,
  observationId,
  modelConfigRevision,
  now
}) {
  return db.prepare(`
    UPDATE workflow_job_tasks SET
      observation_id = ?,
      status = CASE
        WHEN attempt_count_in_generation > 0 THEN 'retry_pending'
        ELSE 'pending'
      END,
      priority = CASE WHEN attempt_count_in_generation > 0 THEN 20 ELSE 100 END,
      available_at = NULL,
      lease_owner = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      model_config_revision = ?,
      last_error_code = NULL,
      last_error_stage = NULL,
      last_error_kind = NULL,
      finished_at = NULL,
      updated_at = ?
    WHERE workflow_run_id = ?
      AND batch_id = ?
      AND job_id = ?
      AND status = 'skipped'
      AND last_error_code = ?
      AND attempt_count_in_generation < 2
      AND EXISTS (
        SELECT 1
        FROM job_observations o
        WHERE o.id = workflow_job_tasks.observation_id
          AND o.job_id = workflow_job_tasks.job_id
          AND o.batch_id = workflow_job_tasks.batch_id
          AND ${WORKFLOW_OBSERVATION_READY_SQL}
      )
  `).run(
    observationId,
    modelConfigRevision || null,
    now,
    workflowRunId,
    batchId,
    jobId,
    WORKFLOW_DETAIL_REQUIRED_CODE
  );
}

function selectReadyWorkflowJobEntries(db, { batchId, entries }) {
  const selectObservation = db.prepare(`
    SELECT id, job_id
    FROM job_observations
    WHERE id = ? AND job_id = ? AND batch_id = ?
  `);
  const selectReady = db.prepare(`
    SELECT o.id AS observation_id, o.job_id AS job_id
    FROM job_observations o
    WHERE o.id = ?
      AND o.job_id = ?
      AND o.batch_id = ?
      AND ${WORKFLOW_OBSERVATION_READY_SQL}
  `);
  const ready = [];
  for (const entry of entries || []) {
    const jobId = Number(entry.jobId);
    const observationId = Number(entry.observationId);
    const observation = selectObservation.get(observationId, jobId, batchId);
    if (!observation) {
      throw workflowRunError(
        "WORKFLOW_TASK_BATCH_MISMATCH",
        `job ${jobId} (observation ${observationId}) does not belong to batch ${batchId}`
      );
    }
    const row = selectReady.get(observationId, jobId, batchId);
    if (!row) continue;
    ready.push({
      ...entry,
      jobId: Number(row.job_id),
      observationId: Number(row.observation_id)
    });
  }
  return ready;
}

function isWorkflowJobTaskObservationReady(db, { taskId }) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM workflow_job_tasks t
    JOIN job_observations o
      ON o.id = t.observation_id
      AND o.job_id = t.job_id
      AND o.batch_id = t.batch_id
    WHERE t.id = ?
      AND ${WORKFLOW_OBSERVATION_READY_SQL}
  `).get(taskId));
}

function settleIncompleteWorkflowJobTaskRows(db, { workflowRunId, now }) {
  return db.prepare(`
    UPDATE workflow_job_tasks AS t SET
      status = 'skipped',
      priority = 100,
      available_at = NULL,
      lease_owner = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      last_error_code = ?,
      last_error_stage = 'input',
      last_error_kind = ?,
      finished_at = ?,
      updated_at = ?
    WHERE t.workflow_run_id = ?
      AND t.status IN ('pending', 'retry_pending')
      AND EXISTS (
        SELECT 1
        FROM job_observations o
        WHERE o.id = t.observation_id
          AND o.job_id = t.job_id
          AND o.batch_id = t.batch_id
          AND NOT (${WORKFLOW_OBSERVATION_READY_SQL})
      )
  `).run(
    WORKFLOW_DETAIL_REQUIRED_CODE,
    WORKFLOW_DETAIL_REQUIRED_KIND,
    now,
    now,
    workflowRunId
  );
}

function selectClaimableWorkflowJobTaskRow(db, { workflowRunId, now }) {
  return db.prepare(`
    SELECT t.*
    FROM workflow_job_tasks t
    JOIN job_observations o
      ON o.id = t.observation_id
      AND o.job_id = t.job_id
      AND o.batch_id = t.batch_id
    WHERE t.workflow_run_id = ?
      AND t.status IN ('pending', 'retry_pending')
      AND t.attempt_count_in_generation < 2
      AND (t.available_at IS NULL OR t.available_at <= ?)
      AND (t.lease_owner IS NULL OR t.lease_expires_at IS NULL OR t.lease_expires_at <= ?)
      AND ${WORKFLOW_OBSERVATION_READY_SQL}
    ORDER BY t.priority ASC, t.position ASC, t.id ASC
    LIMIT 1
  `).get(workflowRunId, now, now) || null;
}

function claimWorkflowJobTaskRow(db, {
  taskId,
  leaseOwner,
  leasedAt,
  leaseExpiresAt,
  attemptCountInGeneration,
  totalAttemptCount,
  lastAttemptModelRevision,
  now
}) {
  return db.prepare(`
    UPDATE workflow_job_tasks SET
      status = 'running',
      lease_owner = ?,
      leased_at = ?,
      lease_expires_at = ?,
      attempt_count_in_generation = ?,
      total_attempt_count = ?,
      last_attempt_model_revision = ?,
      started_at = ?,
      updated_at = ?
    WHERE id = ?
      AND status IN ('pending', 'retry_pending')
      AND attempt_count_in_generation = ?
      AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
      AND (available_at IS NULL OR available_at <= ?)
  `).run(
    leaseOwner,
    leasedAt,
    leaseExpiresAt,
    attemptCountInGeneration,
    totalAttemptCount,
    lastAttemptModelRevision,
    now,
    now,
    taskId,
    attemptCountInGeneration - 1,
    now,
    now
  );
}

function insertJobAnalysisAttemptRow(db, {
  workflowRunId,
  taskId,
  jobId,
  recoveryGeneration,
  attemptInGeneration,
  totalAttemptNumber,
  profileKind,
  modelConfigRevision,
  provider,
  model,
  thinkingMode,
  reasoningEffort,
  backupUsed,
  startedAt,
  now
}) {
  return db.prepare(`
    INSERT INTO job_analysis_attempts(
      workflow_run_id, task_id, job_id, recovery_generation, attempt_in_generation,
      total_attempt_number, profile_kind, model_config_revision, provider, model,
      thinking_mode, reasoning_effort, backup_used, status, retryable, model_call_count,
      prompt_tokens, completion_tokens, total_tokens, started_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, 0, 0, 0, 0, ?, ?, ?)
  `).run(
    workflowRunId,
    taskId,
    jobId,
    recoveryGeneration,
    attemptInGeneration,
    totalAttemptNumber,
    profileKind,
    modelConfigRevision,
    provider,
    model,
    thinkingMode,
    reasoningEffort,
    backupUsed ? 1 : 0,
    startedAt,
    now,
    now
  );
}

function incrementWorkflowRunActivity(db, { workflowRunId, now }) {
  db.prepare(`
    UPDATE workflow_runs SET
      progress_revision = progress_revision + 1,
      last_activity_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(now, now, workflowRunId);
}

function getWorkflowObservationJob(db, observationId) {
  const row = db.prepare(`
    SELECT o.id, o.job_id, o.batch_id, o.keyword, o.title, o.company, o.location, o.salary,
      o.experience, o.education, o.boss_active_text, o.boss_active_days, o.url, o.tags_json,
      o.description, o.score, o.level, o.matches_json, o.risks_json, o.quality_tags_json,
      o.greeting, o.analysis_json, j.source, j.source_id
    FROM job_observations o
    JOIN jobs j ON j.id = o.job_id
    WHERE o.id = ?
  `).get(observationId);
  return row ? workflowObservationJobRow(row) : null;
}

function listWorkflowJobTaskRows(db, { workflowRunId, statuses, limit }) {
  const cap = Math.max(1, Math.min(10000, Number(limit) || 10000));
  const statusClause = Array.isArray(statuses) && statuses.length > 0
    ? `AND status IN (${statuses.map(() => "?").join(", ")})`
    : "";
  const rows = db.prepare(`
    SELECT * FROM workflow_job_tasks
    WHERE workflow_run_id = ? ${statusClause}
    ORDER BY position ASC, id ASC
    LIMIT ?
  `).all(workflowRunId, ...(Array.isArray(statuses) ? statuses : []), cap);
  return rows.map(workflowJobTaskRow);
}

function getWorkflowJobTaskRow(db, taskId) {
  return db.prepare("SELECT * FROM workflow_job_tasks WHERE id = ?").get(taskId) || null;
}

function getRunningJobAnalysisAttemptRow(db, taskId) {
  return db.prepare(`
    SELECT * FROM job_analysis_attempts
    WHERE task_id = ? AND status = 'running'
    ORDER BY id DESC
    LIMIT 1
  `).get(taskId) || null;
}

function finishJobAnalysisAttemptRow(db, {
  attemptId,
  status,
  provider,
  model,
  modelConfigRevision,
  thinkingMode,
  reasoningEffort,
  backupUsed,
  modelCallCount,
  promptTokens,
  completionTokens,
  totalTokens,
  latencyMs,
  errorCode,
  errorStage,
  retryable,
  finishedAt,
  now
}) {
  return db.prepare(`
    UPDATE job_analysis_attempts SET
      status = ?,
      provider = ?,
      model = ?,
      model_config_revision = ?,
      thinking_mode = ?,
      reasoning_effort = ?,
      backup_used = ?,
      model_call_count = ?,
      prompt_tokens = ?,
      completion_tokens = ?,
      total_tokens = ?,
      error_code = ?,
      error_stage = ?,
      retryable = ?,
      finished_at = ?,
      latency_ms = ?,
      updated_at = ?
    WHERE id = ? AND status = 'running'
  `).run(
    status,
    provider,
    model,
    modelConfigRevision,
    thinkingMode,
    reasoningEffort,
    backupUsed ? 1 : 0,
    modelCallCount,
    promptTokens,
    completionTokens,
    totalTokens,
    errorCode || null,
    errorStage || null,
    retryable ? 1 : 0,
    finishedAt,
    latencyMs,
    now,
    attemptId
  );
}

function failWorkflowJobTaskRow(db, {
  taskId,
  leaseOwner,
  status,
  errorCode,
  errorStage,
  errorKind,
  priority,
  availableAt,
  finishedAt,
  now
}) {
  const hasPriority = priority !== undefined && priority !== null;
  return db.prepare(`
    UPDATE workflow_job_tasks SET
      status = ?,
      lease_owner = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      available_at = ?,
      priority = CASE WHEN ? IS NULL THEN priority ELSE ? END,
      last_error_code = ?,
      last_error_stage = ?,
      last_error_kind = ?,
      finished_at = ?,
      updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_owner = ?
  `).run(
    status,
    availableAt || null,
    hasPriority ? priority : null,
    hasPriority ? priority : null,
    errorCode || null,
    errorStage || null,
    errorKind || null,
    finishedAt || null,
    now,
    taskId,
    leaseOwner
  );
}

function incrementWorkflowTimeoutCounters(db, { workflowRunId, now, circuitThreshold }) {
  db.prepare(`
    UPDATE workflow_runs SET
      circuit_timeout_job_count = circuit_timeout_job_count + 1,
      lifetime_timeout_job_count = lifetime_timeout_job_count + 1,
      updated_at = ?
    WHERE id = ?
  `).run(now, workflowRunId);
  const threshold = Number(circuitThreshold);
  if (Number.isInteger(threshold) && threshold > 0) {
    db.prepare(`
      UPDATE workflow_runs SET
        control_state = 'pause_requested',
        resume_phase = 'analyzing',
        error_code = ?,
        progress_revision = progress_revision + 1,
        last_activity_at = ?,
        updated_at = ?
      WHERE id = ? AND circuit_timeout_job_count >= ? AND control_state = 'none'
    `).run(WORKFLOW_TIMEOUT_CIRCUIT_OPEN_CODE, now, now, workflowRunId, threshold);
  }
}

function requestWorkflowRunConfigurationPause(db, { workflowRunId, now }) {
  db.prepare(`
    UPDATE workflow_runs SET
      control_state = 'pause_requested',
      resume_phase = 'analyzing',
      progress_revision = progress_revision + 1,
      last_activity_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(now, now, workflowRunId);
}

function recordWorkflowScanWait(db, {
  workflowRunId,
  runId,
  action,
  delayMs,
  retryAt,
  now
}) {
  const id = String(workflowRunId || "").trim();
  if (!id) return null;
  const clock = String(now || nowIso());
  const wait = JSON.stringify({
    runId: String(runId || ""),
    action: String(action || ""),
    delayMs: Math.max(0, Number(delayMs || 0)),
    retryAt: String(retryAt || "")
  });
  const result = db.prepare(`
    UPDATE workflow_runs SET
      metrics_json = json_set(COALESCE(metrics_json, '{}'), '$.scanWait', json(?)),
      last_activity_at = ?,
      updated_at = ?,
      progress_revision = progress_revision + 1
    WHERE id = ?
  `).run(wait, clock, clock, id);
  return Number(result.changes || 0) > 0 ? getWorkflowRun(db, id) : null;
}

function recordWorkflowPlatformAccess(db, { workflowRunId, now }) {
  const id = String(workflowRunId || "").trim();
  if (!id) return null;
  const clock = String(now || nowIso());
  const result = db.prepare(`
    UPDATE workflow_runs SET
      platform_access_started_at = COALESCE(platform_access_started_at, ?),
      metrics_json = json_remove(COALESCE(metrics_json, '{}'), '$.scanWait'),
      last_activity_at = ?,
      updated_at = ?,
      progress_revision = progress_revision + 1
    WHERE id = ?
  `).run(clock, clock, clock, id);
  return Number(result.changes || 0) > 0 ? getWorkflowRun(db, id) : null;
}

function countWorkflowJobTaskStatuses(db, workflowRunId) {
  const rows = db.prepare(`
    SELECT status, last_error_code, count(*) AS n
    FROM workflow_job_tasks
    WHERE workflow_run_id = ?
    GROUP BY status, last_error_code
  `).all(workflowRunId);
  const counts = {
    pending: 0,
    running: 0,
    retryPending: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    detailRequired: 0,
    stopped: 0,
    total: 0
  };
  for (const row of rows) {
    const key = row.status === "retry_pending" ? "retryPending" : row.status;
    if (Object.hasOwn(counts, key)) {
      counts[key] += Number(row.n);
      counts.total += Number(row.n);
    }
    if (row.status === "skipped" && row.last_error_code === WORKFLOW_DETAIL_REQUIRED_CODE) {
      counts.detailRequired += Number(row.n);
    }
  }
  return counts;
}

function selectEarliestRetryAvailableAt(db, { workflowRunId, now }) {
  const row = db.prepare(`
    SELECT MIN(available_at) AS earliest
    FROM workflow_job_tasks
    WHERE workflow_run_id = ?
      AND status = 'retry_pending'
      AND available_at IS NOT NULL
      AND available_at > ?
  `).get(workflowRunId, now);
  return row && row.earliest ? row.earliest : null;
}

function markWorkflowJobTasksStopped(db, { workflowRunId, now }) {
  return db.prepare(`
    UPDATE workflow_job_tasks SET
      status = 'stopped',
      lease_owner = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      available_at = NULL,
      finished_at = COALESCE(finished_at, ?),
      updated_at = ?
    WHERE workflow_run_id = ? AND status IN ('pending', 'retry_pending')
  `).run(now, now, workflowRunId);
}

function selectExpiredLeaseWorkflowJobTaskRows(db, { workflowRunId, now }) {
  return db.prepare(`
    SELECT * FROM workflow_job_tasks
    WHERE workflow_run_id = ?
      AND status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= ?
    ORDER BY position ASC, id ASC
  `).all(workflowRunId, now).map(workflowJobTaskRow);
}

function completeWorkflowJobTaskRow(db, {
  taskId,
  leaseOwner,
  status,
  reasonCode,
  reasonKind,
  finishedAt,
  now
}) {
  return db.prepare(`
    UPDATE workflow_job_tasks SET
      status = ?,
      lease_owner = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      available_at = NULL,
      last_error_code = ?,
      last_error_stage = NULL,
      last_error_kind = ?,
      finished_at = ?,
      updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_owner = ?
  `).run(
    status,
    reasonCode || null,
    reasonKind || null,
    finishedAt,
    now,
    taskId,
    leaseOwner
  );
}

function listJobAnalysisAttemptRows(db, { workflowRunId, taskId, limit }) {
  const cap = Math.max(1, Math.min(10000, Number(limit) || 10000));
  const taskIdNum = Number(taskId);
  if (!Number.isInteger(taskIdNum) || taskIdNum <= 0) {
    throw new Error(`listJobAnalysisAttemptRows requires a positive integer taskId, got ${taskId}`);
  }
  const rows = db.prepare(`
    SELECT * FROM job_analysis_attempts
    WHERE workflow_run_id = ? AND task_id = ?
    ORDER BY total_attempt_number ASC, id ASC
    LIMIT ?
  `).all(workflowRunId, taskIdNum, cap);
  return rows.map(jobAnalysisAttemptRow);
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function workflowRunError(code, message) {
  return Object.assign(new Error(message), { code });
}

function createBatch(db, site, keyword, note = "", context = {}) {
  return insertBatch(db, site, keyword, note, context);
}

function createAndBindScanBatch(db, input = {}) {
  const runId = requiredRunId(input);
  const owner = normalizedLeaseOwner(input);
  const site = String(input.site || "").trim().toLowerCase();
  const planId = optionalPositiveInteger(input.searchPlanId, "searchPlanId");
  const processId = optionalPositiveInteger(input.processId ?? input.pid, "processId");
  if (!site) throw scanRunError("SCAN_RUN_SITE_REQUIRED", "scan run site is required");
  const startedAt = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = requireRunningScanRun(db, runId);
    if (run.site !== site) throw scanRunError("SCAN_RUN_BATCH_MISMATCH", "scan run belongs to another site");
    if (run.batch_id) throw scanRunError("SCAN_RUN_BATCH_MISMATCH", "scan run is already bound to a batch");
    if (Number(run.plan_id || 0) !== Number(planId || 0)) {
      throw scanRunError("SCAN_RUN_PLAN_MISMATCH", "scan batch belongs to another search plan");
    }
    if (owner) {
      if (run.lease_owner && run.lease_owner !== owner) {
        throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "scan run lease owner does not match");
      }
      const lease = db.prepare("SELECT owner, plan_id, expires_at FROM site_scan_leases WHERE site = ?").get(site);
      const expiresAt = Date.parse(lease?.expires_at || "");
      if (!lease || lease.owner !== owner || !Number.isFinite(expiresAt) || expiresAt <= Date.parse(startedAt)) {
        throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "active site lease does not belong to the scan run owner");
      }
      if (Number(lease.plan_id || 0) !== Number(planId || 0)) {
        throw scanRunError("SCAN_RUN_PLAN_MISMATCH", "site lease belongs to another search plan");
      }
    } else if (run.lease_owner) {
      throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "scan run is already claimed by a lease owner");
    }
    const batchId = insertBatch(db, site, input.keyword, input.note || "", {
      status: input.status || "running",
      profileId: input.profileId,
      searchPlanId: planId,
      filterSnapshot: input.filterSnapshot,
      startedAt
    });
    db.prepare(`UPDATE scan_runs
      SET batch_id = ?, lease_owner = COALESCE(?, lease_owner), process_id = COALESCE(?, process_id),
        started_at = COALESCE(started_at, ?), heartbeat_at = ?
      WHERE id = ?`)
      .run(batchId, owner || null, processId, startedAt, startedAt, runId);
    db.exec("COMMIT");
    return batchId;
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function insertBatch(db, site, keyword, note, context = {}) {
  const startedAt = String(context.startedAt || nowIso());
  const status = normalizeBatchStatus(context.status);
  const finishedAt = status === "running" ? null : String(context.finishedAt || startedAt);
  const result = db.prepare(`INSERT INTO batches(
    site, keyword, started_at, note, profile_id, search_plan_id, filter_snapshot_json,
    status, finished_at, stop_code, stop_message
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    site,
    keyword || null,
    startedAt,
    note,
    context.profileId || null,
    context.searchPlanId || null,
    JSON.stringify(context.filterSnapshot || {}),
    status,
    finishedAt,
    nullableText(context.stopCode),
    nullableText(context.stopMessage, 1000)
  );
  return Number(result.lastInsertRowid);
}

function normalizeBatchStatus(status) {
  const normalized = String(status || "completed").trim().toLowerCase();
  if (!SCAN_RUN_STATUSES.includes(normalized)) {
    throw scanRunError("SCAN_BATCH_STATUS_INVALID", "scan batch status is invalid");
  }
  return normalized;
}

function getBatch(db, batchId) {
  const id = optionalPositiveInteger(batchId, "batchId");
  if (!id) return null;
  const row = db.prepare(`SELECT id, site, keyword, started_at, note, profile_id, search_plan_id,
    filter_snapshot_json, status, finished_at, stop_code, stop_message
    FROM batches WHERE id = ?`).get(id);
  if (!row) return null;
  return {
    id: Number(row.id),
    site: row.site,
    keyword: row.keyword || "",
    startedAt: row.started_at,
    note: row.note || "",
    profileId: Number(row.profile_id || 0) || null,
    searchPlanId: Number(row.search_plan_id || 0) || null,
    filterSnapshot: parseJson(row.filter_snapshot_json, {}),
    status: row.status,
    finishedAt: row.finished_at || null,
    stopCode: row.stop_code || "",
    stopMessage: row.stop_message || ""
  };
}

function getLatestResumableBatch(db, { planId, site = "boss" } = {}) {
  const normalizedPlanId = optionalPositiveInteger(planId, "planId");
  if (!normalizedPlanId) return null;
  const normalizedSite = String(site || "boss").trim().toLowerCase();
  const rows = db.prepare(`SELECT id FROM batches
    WHERE search_plan_id = ? AND site = ? AND status IN ('partial', 'failed', 'interrupted')
    ORDER BY started_at DESC, id DESC`).all(normalizedPlanId, normalizedSite);
  for (const row of rows) {
    const batch = getBatch(db, row.id);
    if (batch?.filterSnapshot?.execution) return batch;
  }
  return null;
}

function createScanRun(db, input = {}) {
  const runId = String(input.runId || input.id || crypto.randomUUID()).trim();
  const site = String(input.site || "boss").trim().toLowerCase();
  if (!runId) throw scanRunError("SCAN_RUN_ID_REQUIRED", "scan run id is required");
  if (!site) throw scanRunError("SCAN_RUN_SITE_REQUIRED", "scan run site is required");
  const createdAt = String(input.createdAt || nowIso());
  const startedAt = input.startedAt ? String(input.startedAt) : null;
  db.prepare(`INSERT INTO scan_runs(
    id, site, command, plan_id, batch_id, status, lease_owner, process_id,
    created_at, started_at, heartbeat_at
  ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
    .run(
      runId,
      site,
      String(input.command || "scan"),
      optionalPositiveInteger(input.planId, "planId"),
      optionalPositiveInteger(input.batchId, "batchId"),
      normalizedLeaseOwner(input) || null,
      optionalPositiveInteger(input.processId ?? input.pid, "processId"),
      createdAt,
      startedAt,
      input.heartbeatAt ? String(input.heartbeatAt) : startedAt
    );
  return getScanRun(db, runId);
}

function getScanRun(db, runId) {
  const id = String(runId || "").trim();
  if (!id) return null;
  const row = db.prepare("SELECT * FROM scan_runs WHERE id = ?").get(id);
  return row ? scanRunRow(row) : null;
}

function getLatestScanRun(db, { planId, site = "" } = {}) {
  const normalizedPlanId = optionalPositiveInteger(planId, "planId");
  if (!normalizedPlanId) return null;
  const normalizedSite = String(site || "").trim().toLowerCase();
  const row = db.prepare(`SELECT * FROM scan_runs
    WHERE plan_id = ? AND (? = '' OR site = ?)
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1`)
    .get(normalizedPlanId, normalizedSite, normalizedSite);
  return row ? scanRunRow(row) : null;
}

function beginScanRun(db, input = {}) {
  const requestedId = String(input.runId || input.id || "").trim();
  let run = requestedId ? getScanRun(db, requestedId) : null;
  if (!run) {
    run = createScanRun(db, {
      ...input,
      runId: requestedId || undefined,
      startedAt: input.startedAt || nowIso()
    });
  }
  const owner = normalizedLeaseOwner(input);
  if (owner) return claimScanRun(db, { ...input, runId: run.id, leaseOwner: owner });

  const batchId = optionalPositiveInteger(input.batchId, "batchId") || run.batchId;
  const processId = optionalPositiveInteger(input.processId ?? input.pid, "processId");
  const startedAt = String(input.startedAt || nowIso());
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = requireRunningScanRun(db, run.id);
    if (current.batch_id && batchId && Number(current.batch_id) !== batchId) {
      throw scanRunError("SCAN_RUN_BATCH_MISMATCH", "scan run is bound to another batch");
    }
    if (batchId) validateScanRunBatch(db, current, batchId);
    db.prepare(`UPDATE scan_runs
      SET batch_id = COALESCE(?, batch_id), process_id = COALESCE(?, process_id),
        started_at = COALESCE(started_at, ?), heartbeat_at = ?
      WHERE id = ?`)
      .run(batchId, processId, startedAt, startedAt, run.id);
    if (batchId) markBatchRunning(db, batchId);
    db.exec("COMMIT");
    return getScanRun(db, run.id);
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function claimScanRun(db, input = {}) {
  const runId = requiredRunId(input);
  const owner = normalizedLeaseOwner(input);
  if (!owner) throw scanRunError("SCAN_RUN_LEASE_OWNER_REQUIRED", "scan run lease owner is required");
  const heartbeatAt = String(input.heartbeatAt || nowIso());
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = requireRunningScanRun(db, runId);
    if (run.lease_owner && run.lease_owner !== owner) {
      throw scanRunError("SCAN_RUN_CLAIMED", "scan run is claimed by another lease owner");
    }
    const lease = db.prepare("SELECT * FROM site_scan_leases WHERE site = ?").get(run.site);
    if (!lease || lease.owner !== owner || Date.parse(lease.expires_at) <= Date.now()) {
      throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "active site lease does not belong to the scan run owner");
    }
    if (run.plan_id && lease.plan_id && Number(run.plan_id) !== Number(lease.plan_id)) {
      throw scanRunError("SCAN_RUN_PLAN_MISMATCH", "site lease belongs to another search plan");
    }
    const batchId = optionalPositiveInteger(input.batchId, "batchId") || Number(run.batch_id || 0) || null;
    if (run.batch_id && batchId && Number(run.batch_id) !== batchId) {
      throw scanRunError("SCAN_RUN_BATCH_MISMATCH", "scan run is bound to another batch");
    }
    if (batchId) validateScanRunBatch(db, run, batchId);
    db.prepare(`UPDATE scan_runs
      SET batch_id = COALESCE(?, batch_id), lease_owner = ?, process_id = COALESCE(?, process_id),
        started_at = COALESCE(started_at, ?), heartbeat_at = ?
      WHERE id = ?`)
      .run(
        batchId,
        owner,
        optionalPositiveInteger(input.processId ?? input.pid, "processId"),
        String(input.startedAt || heartbeatAt),
        heartbeatAt,
        runId
      );
    if (batchId) markBatchRunning(db, batchId);
    db.exec("COMMIT");
    return getScanRun(db, runId);
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function heartbeatScanRun(db, input = {}) {
  const runId = requiredRunId(input);
  const owner = normalizedLeaseOwner(input);
  const allowUnleased = input.allowUnleased === true;
  if (!owner && !allowUnleased) throw scanRunError("SCAN_RUN_LEASE_OWNER_REQUIRED", "scan run lease owner is required");
  const heartbeatAt = String(input.heartbeatAt || nowIso());
  const processId = optionalPositiveInteger(input.processId ?? input.pid, "processId");
  const result = owner
    ? db.prepare(`UPDATE scan_runs
        SET heartbeat_at = ?, process_id = COALESCE(?, process_id)
        WHERE id = ? AND status = 'running' AND lease_owner = ?`).run(heartbeatAt, processId, runId, owner)
    : db.prepare(`UPDATE scan_runs
        SET heartbeat_at = ?, process_id = COALESCE(?, process_id)
        WHERE id = ? AND status = 'running' AND COALESCE(lease_owner, '') = ''`).run(heartbeatAt, processId, runId);
  if (!Number(result.changes || 0)) {
    const run = getScanRun(db, runId);
    if (!run) throw scanRunError("SCAN_RUN_NOT_FOUND", "scan run not found");
    if (run.status !== "running") throw scanRunError("SCAN_RUN_NOT_RUNNING", "scan run is not running");
    throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "scan run lease owner does not match");
  }
  return getScanRun(db, runId);
}

function finishScanRun(db, input = {}) {
  const runId = requiredRunId(input);
  const status = requireTerminalScanStatus(input.status);
  const owner = normalizedLeaseOwner(input);
  const finishedAt = String(input.finishedAt || nowIso());
  const stopCode = nullableText(input.stopCode);
  const stopMessage = nullableText(input.stopMessage, 1000);
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = db.prepare("SELECT * FROM scan_runs WHERE id = ?").get(runId);
    if (!run) throw scanRunError("SCAN_RUN_NOT_FOUND", "scan run not found");
    if (owner && run.lease_owner && run.lease_owner !== owner) {
      throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "scan run lease owner does not match");
    }
    if (run.status !== "running") {
      if (run.status !== status) {
        throw scanRunError("SCAN_RUN_ALREADY_FINISHED", `scan run already finished as ${run.status}`);
      }
      db.exec("COMMIT");
      return getScanRun(db, runId);
    }
    db.prepare(`UPDATE scan_runs
      SET status = ?, heartbeat_at = ?, finished_at = ?, stop_code = ?, stop_message = ?
      WHERE id = ?`)
      .run(status, finishedAt, finishedAt, stopCode, stopMessage, runId);
    if (run.batch_id) syncBatchTerminalState(db, Number(run.batch_id), status, finishedAt, stopCode, stopMessage);
    db.exec("COMMIT");
    return getScanRun(db, runId);
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function recordScanRunProcessExit(db, input = {}) {
  const runId = requiredRunId(input);
  const exitedAt = String(input.exitedAt || input.finishedAt || nowIso());
  const exitCode = optionalInteger(input.exitCode, "exitCode");
  const signal = nullableText(input.signal);
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = db.prepare("SELECT * FROM scan_runs WHERE id = ?").get(runId);
    if (!run) throw scanRunError("SCAN_RUN_NOT_FOUND", "scan run not found");
    if (run.status !== "running") {
      db.prepare("UPDATE scan_runs SET process_exit_code = ?, process_signal = ? WHERE id = ?")
        .run(exitCode, signal, runId);
      db.exec("COMMIT");
      return getScanRun(db, runId);
    }
    const status = input.status ? requireTerminalScanStatus(input.status) : processExitStatus(db, run, exitCode, signal);
    let stopCode = nullableText(input.stopCode) || run.stop_code || null;
    let stopMessage = nullableText(input.stopMessage, 1000) || run.stop_message || null;
    if (!stopCode && status !== "completed") stopCode = signal ? "SCAN_PROCESS_SIGNAL" : "SCAN_PROCESS_EXIT";
    if (!stopMessage && status !== "completed") {
      stopMessage = signal
        ? `scan process exited with signal ${signal}`
        : `scan process exited with code ${exitCode ?? "unknown"}`;
    }
    db.prepare(`UPDATE scan_runs
      SET status = ?, heartbeat_at = ?, finished_at = COALESCE(finished_at, ?),
        stop_code = ?, stop_message = ?, process_exit_code = ?, process_signal = ?
      WHERE id = ?`)
      .run(status, exitedAt, exitedAt, stopCode, stopMessage, exitCode, signal, runId);
    if (run.batch_id) {
      const batch = db.prepare("SELECT status FROM batches WHERE id = ?").get(run.batch_id);
      const rebound = db.prepare("SELECT 1 FROM scan_runs WHERE batch_id = ? AND id <> ? AND status = 'running' LIMIT 1")
        .get(run.batch_id, runId);
      if (batch?.status === "running" && !rebound) {
        syncBatchTerminalState(db, Number(run.batch_id), status, exitedAt, stopCode, stopMessage);
      }
    }
    db.exec("COMMIT");
    return getScanRun(db, runId);
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function interruptOrphanedScanRuns(db, input = {}) {
  const now = validDate(input.now || Date.now(), "now");
  const staleBefore = input.staleBefore
    ? validDate(input.staleBefore, "staleBefore")
    : new Date(now.getTime() - Math.max(0, Number(input.heartbeatTimeoutMs ?? PRODUCT_POLICY.operations.scanOrphanTimeoutMs)));
  const site = String(input.site || "").trim().toLowerCase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const staleRuns = db.prepare(`SELECT * FROM scan_runs
      WHERE status = 'running'
        AND COALESCE(heartbeat_at, started_at, created_at) <= ?
        AND (? = '' OR site = ?)
      ORDER BY created_at, id`)
      .all(staleBefore.toISOString(), site, site);
    const interruptedRuns = [];
    for (const run of staleRuns) {
      if (run.lease_owner) {
        const lease = db.prepare("SELECT owner, expires_at FROM site_scan_leases WHERE site = ?").get(run.site);
        if (lease?.owner === run.lease_owner) {
          const expiresAt = Date.parse(lease.expires_at);
          if (Number.isFinite(expiresAt) && expiresAt > now.getTime()) continue;
          db.prepare("DELETE FROM site_scan_leases WHERE site = ? AND owner = ?").run(run.site, run.lease_owner);
        }
      }
      const result = db.prepare(`UPDATE scan_runs
        SET status = 'interrupted', heartbeat_at = ?, finished_at = ?,
          stop_code = 'SCAN_RUN_ORPHANED', stop_message = 'scan run heartbeat expired'
        WHERE id = ? AND status = 'running'`)
        .run(now.toISOString(), now.toISOString(), run.id);
      if (!Number(result.changes || 0)) continue;
      interruptedRuns.push(run);
      if (run.batch_id) {
        const batch = db.prepare("SELECT status FROM batches WHERE id = ?").get(run.batch_id);
        const rebound = db.prepare("SELECT 1 FROM scan_runs WHERE batch_id = ? AND id <> ? AND status = 'running' LIMIT 1")
          .get(run.batch_id, run.id);
        if (batch?.status === "running" && !rebound) {
          syncBatchTerminalState(db, Number(run.batch_id), "interrupted", now.toISOString(), "SCAN_RUN_ORPHANED", "scan run heartbeat expired");
        }
      }
    }
    db.exec("COMMIT");
    return { interrupted: interruptedRuns.length, runIds: interruptedRuns.map((run) => run.id) };
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function checkpointScanTarget(db, input = {}) {
  const runId = requiredRunId(input);
  const batchId = optionalPositiveInteger(input.batchId, "batchId");
  const owner = normalizedLeaseOwner(input);
  if (!batchId) throw scanRunError("SCAN_RUN_BATCH_REQUIRED", "scan target batchId is required");
  if (!owner) throw scanRunError("SCAN_RUN_LEASE_OWNER_REQUIRED", "scan target lease owner is required");
  if (!Array.isArray(input.jobs)) throw new TypeError("scan target jobs must be an array");
  const checkpointedAt = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = requireRunningScanRun(db, runId);
    if (Number(run.batch_id || 0) !== batchId) {
      throw scanRunError("SCAN_RUN_BATCH_MISMATCH", "scan run is not bound to the target batch");
    }
    if (run.lease_owner !== owner) {
      throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "scan run lease owner does not match");
    }
    const batch = validateScanRunBatch(db, run, batchId);
    if (batch.status !== "running") {
      throw scanRunError("SCAN_BATCH_NOT_RUNNING", "scan batch is not running");
    }
    const lease = db.prepare("SELECT owner, expires_at FROM site_scan_leases WHERE site = ?").get(run.site);
    const leaseExpiresAt = Date.parse(lease?.expires_at || "");
    if (!lease || lease.owner !== owner || !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.parse(checkpointedAt)) {
      throw scanRunError("SCAN_LEASE_LOST", "scan lease was lost before the checkpoint could be saved");
    }
    const jobIds = input.jobs.map((job) => jobStore.upsertJob(db, job, batchId));
    const target = input.target && typeof input.target === "object" ? { ...input.target, ...input } : input;
    db.prepare("UPDATE scan_runs SET heartbeat_at = ? WHERE id = ?").run(checkpointedAt, runId);
    const attemptNumber = recordScanTargetResult(db, {
      ...target,
      batchId,
      jobCount: target.jobCount === undefined ? input.jobs.length : target.jobCount
    });
    db.exec("COMMIT");
    return {
      runId,
      batchId,
      targetKey: String(target.targetKey || ""),
      attemptNumber,
      jobCount: input.jobs.length,
      jobIds
    };
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function checkpointScanProgress(db, input = {}) {
  const runId = requiredRunId(input);
  const batchId = optionalPositiveInteger(input.batchId, "batchId");
  const owner = normalizedLeaseOwner(input);
  if (!batchId) throw scanRunError("SCAN_RUN_BATCH_REQUIRED", "scan progress batchId is required");
  if (!owner) throw scanRunError("SCAN_RUN_LEASE_OWNER_REQUIRED", "scan progress lease owner is required");
  if (!Array.isArray(input.jobs)) throw new TypeError("scan progress jobs must be an array");
  const checkpointedAt = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = requireRunningScanRun(db, runId);
    if (Number(run.batch_id || 0) !== batchId) {
      throw scanRunError("SCAN_RUN_BATCH_MISMATCH", "scan run is not bound to the progress batch");
    }
    if (run.lease_owner !== owner) {
      throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "scan run lease owner does not match");
    }
    const batch = validateScanRunBatch(db, run, batchId);
    if (batch.status !== "running") {
      throw scanRunError("SCAN_BATCH_NOT_RUNNING", "scan batch is not running");
    }
    const lease = db.prepare("SELECT owner, expires_at FROM site_scan_leases WHERE site = ?").get(run.site);
    const leaseExpiresAt = Date.parse(lease?.expires_at || "");
    if (!lease || lease.owner !== owner || !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.parse(checkpointedAt)) {
      throw scanRunError("SCAN_LEASE_LOST", "scan lease was lost before the checkpoint could be saved");
    }
    const jobIds = input.jobs.map((job) => jobStore.upsertJob(db, job, batchId));
    db.prepare("UPDATE scan_runs SET heartbeat_at = ? WHERE id = ?").run(checkpointedAt, runId);
    db.exec("COMMIT");
    return { runId, batchId, jobCount: input.jobs.length, jobIds };
  } catch (error) {
    rollback(db);
    throw error;
  }
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
    details_json, attempt_number, started_at, finished_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
      JSON.stringify(input.details || {}),
      attemptNumber,
      startedAt,
      finishedAt
    );
  return attemptNumber;
}

function listScanTargetResults(db, batchId) {
  return db.prepare("SELECT * FROM scan_target_results WHERE batch_id = ? ORDER BY id").all(Number(batchId)).map(scanTargetResultRow);
}

function listLatestScanTargetResults(db, batchId) {
  return db.prepare(`
    SELECT result.*
    FROM scan_target_results result
    JOIN (
      SELECT target_key, MAX(id) AS id
      FROM scan_target_results
      WHERE batch_id = ?
      GROUP BY target_key
    ) latest ON latest.id = result.id
    ORDER BY result.id
  `).all(Number(batchId)).map(scanTargetResultRow);
}

function summarizeScanTargets(db, batchId) {
  const results = listLatestScanTargetResults(db, batchId);
  const counts = { completed: 0, partial: 0, failed: 0 };
  let jobCount = 0;
  for (const result of results) {
    if (Object.hasOwn(counts, result.status)) counts[result.status] += 1;
    jobCount += result.jobCount;
  }
  const status = !results.length
    ? "running"
    : counts.completed === results.length
      ? "completed"
      : counts.failed === results.length
        ? "failed"
        : "partial";
  return {
    batchId: Number(batchId),
    status,
    total: results.length,
    completed: counts.completed,
    partial: counts.partial,
    failed: counts.failed,
    jobCount
  };
}

function scanTargetResultRow(row) {
  return {
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
    details: parseJson(row.details_json, {}),
    attemptNumber: Number(row.attempt_number || 1),
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function requiredRunId(input) {
  const runId = String(input.runId || input.id || "").trim();
  if (!runId) throw scanRunError("SCAN_RUN_ID_REQUIRED", "scan run id is required");
  return runId;
}

function normalizedLeaseOwner(input) {
  return String(input.leaseOwner || input.owner || "").trim();
}

function nullableText(value, limit = Infinity) {
  const text = String(value || "").trim();
  return text ? text.slice(0, limit) : null;
}

function requireTerminalScanStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!TERMINAL_SCAN_RUN_STATUSES.has(normalized)) {
    throw scanRunError("SCAN_RUN_STATUS_INVALID", "scan run terminal status is invalid");
  }
  return normalized;
}

function requireRunningScanRun(db, runId) {
  const run = db.prepare("SELECT * FROM scan_runs WHERE id = ?").get(runId);
  if (!run) throw scanRunError("SCAN_RUN_NOT_FOUND", "scan run not found");
  if (run.status !== "running") throw scanRunError("SCAN_RUN_NOT_RUNNING", "scan run is not running");
  return run;
}

function validateScanRunBatch(db, run, batchId) {
  const batch = db.prepare("SELECT id, site, search_plan_id, status FROM batches WHERE id = ?").get(batchId);
  if (!batch) throw scanRunError("SCAN_BATCH_NOT_FOUND", "scan batch not found");
  if (String(batch.site || "").toLowerCase() !== run.site) {
    throw scanRunError("SCAN_RUN_BATCH_MISMATCH", "scan batch belongs to another site");
  }
  if (run.plan_id && Number(batch.search_plan_id || 0) !== Number(run.plan_id)) {
    throw scanRunError("SCAN_RUN_PLAN_MISMATCH", "scan batch belongs to another search plan");
  }
  return batch;
}

function markBatchRunning(db, batchId) {
  const result = db.prepare(`UPDATE batches
    SET status = 'running', finished_at = NULL, stop_code = NULL, stop_message = NULL
    WHERE id = ?`)
    .run(batchId);
  if (!Number(result.changes || 0)) throw scanRunError("SCAN_BATCH_NOT_FOUND", "scan batch not found");
}

function syncBatchTerminalState(db, batchId, status, finishedAt, stopCode, stopMessage) {
  const result = db.prepare(`UPDATE batches
    SET status = ?, finished_at = ?, stop_code = ?, stop_message = ?
    WHERE id = ?`)
    .run(status, finishedAt, stopCode, stopMessage, batchId);
  if (!Number(result.changes || 0)) throw scanRunError("SCAN_BATCH_NOT_FOUND", "scan batch not found");
}

function processExitStatus(db, run, exitCode, signal) {
  if (signal || exitCode === null) return "interrupted";
  if (exitCode !== 0) return "failed";
  if (!run.batch_id) return "completed";
  const summary = summarizeScanTargets(db, Number(run.batch_id));
  return summary.total ? summary.status : "completed";
}

function validDate(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} must be a valid date`);
  return date;
}

function scanRunRow(row) {
  return {
    id: row.id,
    runId: row.id,
    site: row.site,
    command: row.command,
    planId: Number(row.plan_id || 0) || null,
    batchId: Number(row.batch_id || 0) || null,
    status: row.status,
    leaseOwner: row.lease_owner || "",
    processId: Number(row.process_id || 0) || null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    heartbeatAt: row.heartbeat_at || null,
    finishedAt: row.finished_at || null,
    stopCode: row.stop_code || "",
    stopMessage: row.stop_message || "",
    processExitCode: row.process_exit_code === null ? null : Number(row.process_exit_code),
    processSignal: row.process_signal || ""
  };
}

const scanRunError = storageError;

function rollback(db) {
  try { db.exec("ROLLBACK"); } catch { /* no-op */ }
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

function acquireSiteScanLease(db, { site = "boss", owner = crypto.randomUUID(), command = "scan", planId = null, ttlMs = PRODUCT_POLICY.operations.scanLeaseTtlMs } = {}) {
  const normalizedSite = String(site || "").trim().toLowerCase();
  const normalizedOwner = String(owner || "").trim();
  if (!normalizedSite || !normalizedOwner) throw new Error("scan lease site and owner are required");
  const now = new Date();
  const acquiredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + Math.max(PRODUCT_POLICY.operations.scanLeaseMinTtlMs, Number(ttlMs) || 0)).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM site_scan_leases WHERE expires_at <= ?").run(acquiredAt);
    const active = db.prepare("SELECT * FROM site_scan_leases WHERE site = ?").get(normalizedSite);
    if (active) {
      const error = new Error(`${normalizedSite} 已有扫描任务运行中（${active.command}，开始于 ${active.acquired_at}）。`);
      error.code = "SCAN_ALREADY_RUNNING";
      error.lease = mapSiteScanLease(active);
      throw error;
    }
    db.prepare(`INSERT INTO site_scan_leases(site, owner, command, plan_id, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(normalizedSite, normalizedOwner, String(command || "scan"), Number(planId || 0) || null, acquiredAt, expiresAt);
    db.exec("COMMIT");
    return getSiteScanLease(db, normalizedSite);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* no-op */ }
    throw error;
  }
}

function renewSiteScanLease(db, { site = "boss", owner, ttlMs = PRODUCT_POLICY.operations.scanLeaseTtlMs } = {}) {
  const expiresAt = new Date(Date.now() + Math.max(PRODUCT_POLICY.operations.scanLeaseMinTtlMs, Number(ttlMs) || 0)).toISOString();
  const result = db.prepare("UPDATE site_scan_leases SET expires_at = ? WHERE site = ? AND owner = ?")
    .run(expiresAt, String(site || "").trim().toLowerCase(), String(owner || ""));
  if (!Number(result.changes || 0)) {
    const error = new Error("扫描互斥租约已丢失，不能继续保证单实例运行。");
    error.code = "SCAN_LEASE_LOST";
    throw error;
  }
  return expiresAt;
}

function releaseSiteScanLease(db, { site = "boss", owner } = {}) {
  const result = db.prepare("DELETE FROM site_scan_leases WHERE site = ? AND owner = ?")
    .run(String(site || "").trim().toLowerCase(), String(owner || ""));
  return Number(result.changes || 0) > 0;
}

function getSiteScanLease(db, site = "boss") {
  const normalizedSite = String(site || "").trim().toLowerCase();
  const row = db.prepare("SELECT * FROM site_scan_leases WHERE site = ?").get(normalizedSite);
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare("DELETE FROM site_scan_leases WHERE site = ? AND owner = ?").run(normalizedSite, row.owner);
    return null;
  }
  return mapSiteScanLease(row);
}

function mapSiteScanLease(row) {
  return {
    site: row.site,
    owner: row.owner,
    command: row.command,
    planId: Number(row.plan_id || 0) || null,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at
  };
}

function listReusableJobDetails(db, { site = "boss", profileId = 0, maxAgeDays = 7 } = {}) {
  const parsedDays = Number(maxAgeDays);
  const days = Number.isFinite(parsedDays) ? Math.max(1, Math.min(30, parsedDays)) : 7;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const normalizedProfileId = Number(profileId || 0);
  const rows = db.prepare(`
    WITH reusable AS (
      SELECT jobs.source_id, o.title, o.company, o.location, o.salary, o.experience, o.education, o.boss_active_text,
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
    title: row.title || "",
    company: row.company || "",
    location: row.location || "",
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
































function getWorkflowHealthSnapshot(db, options = {}) {
  const planId = optionalPositiveInteger(options.planId, "planId");
  if (!planId) throw new Error("planId is required");
  const plan = getSearchPlan(db, planId);
  if (!plan) throw new Error("search plan not found");
  const profileId = optionalPositiveInteger(options.profileId || plan.profileId, "profileId");
  if (Number(plan.profileId) !== profileId) {
    throw new Error("search plan does not belong to the selected profile");
  }

  const generatedAt = validDate(options.now || nowIso(), "now");
  const jobLimit = boundedHealthLimit(options.jobLimit, 1000, 9999);
  const workflowLimit = boundedHealthLimit(options.workflowLimit, 100, 499);
  const eventLimit = boundedHealthLimit(options.eventLimit, 100, 199);
  const jobs = jobStore.listReportJobs(db, { profileId, planId, limit: jobLimit + 1 });
  const workflowRuns = listWorkflowRuns(db, { profileId, planId, limit: workflowLimit + 1 });
  const candidateEvents = jobStore.listCandidateJobEvents(db, { profileId, planId, limit: eventLimit + 1 });
  const selectedWorkflowRuns = workflowRuns.slice(0, workflowLimit);
  const selectedWorkflowIds = selectedWorkflowRuns.map((workflow) => workflow.id);
  const linkRows = selectedWorkflowIds.length ? db.prepare(`
    SELECT w.id AS workflow_id, w.plan_id AS workflow_plan_id,
      w.profile_id AS workflow_profile_id, w.scan_run_id, sr.plan_id AS scan_plan_id,
      w.scan_batch_id, sb.search_plan_id AS scan_batch_plan_id,
      sb.profile_id AS scan_batch_profile_id, w.communication_batch_id,
      cb.plan_id AS communication_plan_id, cb.profile_id AS communication_profile_id
    FROM workflow_runs w
    LEFT JOIN scan_runs sr ON sr.id = w.scan_run_id
    LEFT JOIN batches sb ON sb.id = w.scan_batch_id
    LEFT JOIN communication_batches cb ON cb.id = w.communication_batch_id
    WHERE w.id IN (${selectedWorkflowIds.map(() => "?").join(", ")})
  `).all(...selectedWorkflowIds) : [];

  return Object.freeze({
    generatedAt, profileId, planId,
    jobs: Object.freeze(jobs.slice(0, jobLimit)),
    workflowRuns: Object.freeze(selectedWorkflowRuns),
    candidateEvents: Object.freeze(candidateEvents.slice(0, eventLimit)),
    linkIssues: Object.freeze(linkRows.flatMap(workflowLinkIssues)),
    truncated: Object.freeze({
      jobs: jobs.length > jobLimit,
      workflowRuns: workflowRuns.length > workflowLimit,
      candidateEvents: candidateEvents.length > eventLimit
    })
  });
}

function boundedHealthLimit(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(number, maximum);
}

function workflowLinkIssues(row) {
  const issues = [];
  if (row.scan_run_id && Number(row.scan_plan_id || 0) !== Number(row.workflow_plan_id)) {
    issues.push({ workflowId: row.workflow_id, reason: "scan_plan_mismatch" });
  }
  if (row.scan_batch_id && (Number(row.scan_batch_plan_id || 0) !== Number(row.workflow_plan_id)
    || Number(row.scan_batch_profile_id || 0) !== Number(row.workflow_profile_id))) {
    issues.push({ workflowId: row.workflow_id, reason: "scan_batch_owner_mismatch" });
  }
  if (row.communication_batch_id && (Number(row.communication_plan_id || 0) !== Number(row.workflow_plan_id)
    || Number(row.communication_profile_id || 0) !== Number(row.workflow_profile_id))) {
    issues.push({ workflowId: row.workflow_id, reason: "communication_batch_owner_mismatch" });
  }
  return issues;
}

module.exports = {
  SCHEMA,
  SCHEMA_VERSION,
  OUTCOME_STATUSES,
  SCAN_RUN_STATUSES,
  WORKFLOW_RUN_STATUSES,
  openDb,
  immediateTransaction,
  workflowJobTaskRow,
  jobAnalysisAttemptRow,
  countWorkflowJobTasks,
  insertWorkflowJobTaskRow,
  reactivateWorkflowDetailRequiredTaskRow,
  selectReadyWorkflowJobEntries,
  isWorkflowJobTaskObservationReady,
  settleIncompleteWorkflowJobTaskRows,
  selectClaimableWorkflowJobTaskRow,
  claimWorkflowJobTaskRow,
  insertJobAnalysisAttemptRow,
  incrementWorkflowRunActivity,
  getWorkflowObservationJob,
  listWorkflowJobTaskRows,
  listJobAnalysisAttemptRows,
  getWorkflowJobTaskRow,
  getRunningJobAnalysisAttemptRow,
  finishJobAnalysisAttemptRow,
  failWorkflowJobTaskRow,
  incrementWorkflowTimeoutCounters,
  WORKFLOW_TIMEOUT_CIRCUIT_OPEN_CODE,
  countWorkflowJobTaskStatuses,
  selectEarliestRetryAvailableAt,
  markWorkflowJobTasksStopped,
  requestWorkflowRunConfigurationPause,
  recordWorkflowScanWait,
  recordWorkflowPlatformAccess,
  selectExpiredLeaseWorkflowJobTaskRows,
  completeWorkflowJobTaskRow,
  backfillHistoricalCommunicationOutcomes,
  createMatchingCardDraft,
  getMatchingCard,
  getActiveMatchingCard,
  listMatchingCards,
  saveMatchingCardDraftEdit,
  confirmMatchingCard,
  saveConfirmedMatchingCardRevision,
  getCandidateMatchingContext,
  createWorkflowRun,
  getWorkflowRun,
  getWorkflowRunByCommunicationBatch,
  listWorkflowRuns,
  getActiveWorkflowRun,
  transitionWorkflowRun,
  attachWorkflowScan,
  attachWorkflowScanRun,
  attachWorkflowCommunication,
  createBatch,
  createAndBindScanBatch,
  getBatch,
  getLatestResumableBatch,
  createScanRun,
  getScanRun,
  getLatestScanRun,
  beginScanRun,
  claimScanRun,
  heartbeatScanRun,
  finishScanRun,
  recordScanRunProcessExit,
  interruptOrphanedScanRuns,
  checkpointScanProgress,
  checkpointScanTarget,
  recordScanTargetResult,
  listScanTargetResults,
  listLatestScanTargetResults,
  summarizeScanTargets,
  getSiteRuntimeState,
  setSiteRuntimeState,
  clearSiteRuntimeState,
  recordSiteAccessEvent,
  listSiteAccessEvents,
  acquireSiteScanLease,
  renewSiteScanLease,
  releaseSiteScanLease,
  getSiteScanLease,
  listReusableJobDetails,
  recordJobRefreshAttempt,
  listJobRefreshAttempts,
  getLatestJobRefreshAttempt,
  getPlatformFilterCatalog,
  savePlatformFilterCatalog,
  upsertKeywordSource: jobStore.upsertKeywordSource,
  upsertJob: jobStore.upsertJob,
  listReportJobs: jobStore.listReportJobs,
  markApplication: jobStore.markApplication,
  bindBatchToPlan: jobStore.bindBatchToPlan,
  rescorePlanObservations: jobStore.rescorePlanObservations,
  reassessBatchObservations: jobStore.reassessBatchObservations,
  addFollowUpNote: jobStore.addFollowUpNote,
  recordCandidateJobEvent: jobStore.recordCandidateJobEvent,
  listCandidateJobEvents: jobStore.listCandidateJobEvents,
  recordRecommendationFeedback: jobStore.recordRecommendationFeedback,
  saveCandidateFact,
  listCandidateFacts,
  markCandidateJob: jobStore.markCandidateJob,
  buildFeedbackSummary: jobStore.buildFeedbackSummary,
  buildBatchSummary: jobStore.buildBatchSummary,
  getWorkflowHealthSnapshot,
  getLatestBatchId: jobStore.getLatestBatchId,
  getLatestMainScanBatchId: jobStore.getLatestMainScanBatchId,
  saveProfileAnalysis,
  attachResumeDocumentFile,
  getResumeDocument,
  updateCandidateProfile,
  saveCandidateResumeVersion,
  listCandidateResumeVersions,
  listMatchingResumeVersions,
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
  listDecisionPool: jobStore.listDecisionPool,
  getOutcomeAnalyticsSnapshot: jobStore.getOutcomeAnalyticsSnapshot,
  listDecisionQueue: jobStore.listDecisionQueue,
  isJobAwaitingAction: jobStore.isJobAwaitingAction,
  decisionBucket: jobStore.decisionBucket,
  applyJobQualityGovernance: jobStore.applyJobQualityGovernance,
  isActivityProbeDue: jobStore.isActivityProbeDue,
  sourceContentHash: jobStore.sourceContentHash,
  getModelCache: jobStore.getModelCache,
  saveModelCache: jobStore.saveModelCache
};
