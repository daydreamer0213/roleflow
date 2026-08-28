const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const candidateStore = require("../storage/candidate_store");
const jobStore = require("../storage/job_store");
const { nowIso, parseJson, OUTCOME_STATUSES, storageError, optionalInteger, optionalPositiveInteger, nullableText, validDate, immediateTransaction } = require("../storage/storage_shared");
const scanStore = require("../storage/scan_store");
const messageLearningStore = require("../storage/message_learning_store");
const funnelStore = require("../storage/funnel_store");
const {
  recordMessageReplyDrafts,
  getMessageReplyDraft,
  listOpenMessageReplyDrafts,
  saveMessageReplyDraftEdit,
  completeMessageReplyDraft,
  listCandidateAnswerMemories,
  reviseCandidateAnswerMemory,
  withdrawCandidateAnswerMemory,
  listCandidateFactRevisions,
  deleteCandidateFact,
  closeMessageReplyDrafts
} = messageLearningStore;
const workflowStore = require("../storage/workflow_store");
const {
  createWorkflowRun,
  getWorkflowRun,
  getWorkflowRunByCommunicationBatch,
  listWorkflowRuns,
  getActiveWorkflowRun,
  transitionWorkflowRun,
  attachWorkflowScan,
  attachWorkflowScanRun,
  attachWorkflowCommunication,
  requestWorkflowRunConfigurationPause,
  recordWorkflowScanWait,
  recordWorkflowPlatformAccess,
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
  countWorkflowJobTaskStatuses,
  selectEarliestRetryAvailableAt,
  markWorkflowJobTasksStopped,
  selectExpiredLeaseWorkflowJobTaskRows,
  completeWorkflowJobTaskRow,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_TIMEOUT_CIRCUIT_OPEN_CODE
} = workflowStore;
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
  RECOMMENDATION_SCHEMA_VERSION,
  normalizeRecommendationTier
} = require("./decision_policy");const { buildOutcomeAnalytics } = require("./outcome_analytics");


const VALID_CANDIDATE_STATUSES = new Set(OUTCOME_STATUSES);

const COMMUNICATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS communication_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL DEFAULT 'boss',
  profile_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  browser_mode TEXT NOT NULL CHECK(browser_mode IN ('edge', 'portable')),
  status TEXT NOT NULL CHECK(status IN ('confirmed','running','paused','stopping','completed','stopped','interrupted','failed')),
  policy_json TEXT NOT NULL DEFAULT '{}',
  runtime_json TEXT NOT NULL DEFAULT '{}',
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
  status TEXT NOT NULL CHECK(status IN ('pending','opening','verified','click_dispatched','succeeded','already_communicated','job_unavailable','target_mismatch','action_unavailable','platform_rejected','transport_failed','ambiguous','stopped')),
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

const MESSAGE_DISCOVERY_UNRESOLVED_ITEMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_discovery_unresolved_items (
  profile_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  preview_digest TEXT NOT NULL,
  preview_kind TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  position_title TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  salary TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  identity_digest TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(profile_id, platform, conversation_key),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);
`;

const MESSAGE_DISCOVERY_RUNTIME_STATES_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_discovery_runtime_states (
  profile_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  pacing_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, platform),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);
`;

const SHARED_SITE_PACING_STATES_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_discovery_runtime_states (
  platform TEXT PRIMARY KEY,
  pacing_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
`;

const ONBOARDING_RUN_SCHEMA = `
CREATE TABLE IF NOT EXISTS onboarding_runs (
  id TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL,
  resume_document_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
  stage TEXT NOT NULL CHECK(stage IN (
    'parsed','analyzing_profile','building_match_card','building_plan','ready'
  )),
  progress_revision INTEGER NOT NULL DEFAULT 0 CHECK(progress_revision >= 0),
  profile_version_id INTEGER,
  matching_card_id INTEGER,
  search_plan_id INTEGER,
  error_code TEXT,
  error_message TEXT,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(profile_id, resume_document_id),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(resume_document_id) REFERENCES resume_documents(id),
  FOREIGN KEY(profile_version_id) REFERENCES profile_versions(id) ON DELETE SET NULL,
  FOREIGN KEY(matching_card_id) REFERENCES candidate_matching_cards(id) ON DELETE SET NULL,
  FOREIGN KEY(search_plan_id) REFERENCES search_plans(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_onboarding_runs_status
  ON onboarding_runs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_onboarding_runs_profile
  ON onboarding_runs(profile_id, created_at);
`;

const MESSAGE_REPLY_LEARNING_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_reply_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  message_group_key TEXT NOT NULL,
  draft_index INTEGER NOT NULL CHECK(draft_index IN (0, 1)),
  question_summary TEXT NOT NULL DEFAULT '',
  message_intent TEXT NOT NULL DEFAULT '',
  message_category TEXT NOT NULL DEFAULT '',
  original_text TEXT NOT NULL,
  current_text TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, message_group_key, draft_index),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(card_id) REFERENCES candidate_progress_cards(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_message_reply_drafts_open
  ON message_reply_drafts(profile_id, closed_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_message_reply_drafts_card
  ON message_reply_drafts(profile_id, card_id, draft_index);

CREATE TABLE IF NOT EXISTS candidate_answer_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  draft_id INTEGER NOT NULL,
  final_digest TEXT NOT NULL,
  question_summary TEXT NOT NULL DEFAULT '',
  message_intent TEXT NOT NULL DEFAULT '',
  message_category TEXT NOT NULL DEFAULT '',
  original_text TEXT NOT NULL,
  final_text TEXT NOT NULL,
  changed_text TEXT NOT NULL DEFAULT '',
  scope_json TEXT NOT NULL DEFAULT '{"kind":"global","key":""}',
  source TEXT NOT NULL CHECK(source IN ('draft_adopted', 'user_edited_reply')),
  completion_kind TEXT NOT NULL CHECK(completion_kind IN ('copied', 'sent', 'profile_edit')),
  supersedes_memory_id INTEGER,
  withdrawn_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(draft_id, final_digest),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(draft_id) REFERENCES message_reply_drafts(id),
  FOREIGN KEY(supersedes_memory_id) REFERENCES candidate_answer_memories(id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_answer_memories_active
  ON candidate_answer_memories(profile_id, source, withdrawn_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_candidate_answer_memories_draft
  ON candidate_answer_memories(draft_id, withdrawn_at, created_at);

CREATE TABLE IF NOT EXISTS candidate_fact_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL CHECK(operation IN ('set', 'delete')),
  source TEXT NOT NULL,
  answer_memory_id INTEGER,
  evidence_text TEXT NOT NULL DEFAULT '',
  withdrawn_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(answer_memory_id) REFERENCES candidate_answer_memories(id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_fact_revisions_key
  ON candidate_fact_revisions(profile_id, fact_key, created_at, id);
CREATE INDEX IF NOT EXISTS idx_candidate_fact_revisions_memory
  ON candidate_fact_revisions(answer_memory_id, fact_key);
`;

const JOB_SEARCH_FUNNEL_SCHEMA = `
CREATE TABLE IF NOT EXISTS candidate_funnel_policies (
  profile_id INTEGER PRIMARY KEY,
  preliminary_sample_target INTEGER NOT NULL CHECK(preliminary_sample_target BETWEEN 10 AND 500),
  comparable_sample_target INTEGER NOT NULL CHECK(comparable_sample_target BETWEEN 10 AND 500),
  formal_sample_target INTEGER NOT NULL CHECK(formal_sample_target BETWEEN 10 AND 500),
  updated_at TEXT NOT NULL,
  CHECK(preliminary_sample_target < comparable_sample_target),
  CHECK(comparable_sample_target < formal_sample_target),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);

CREATE TABLE IF NOT EXISTS candidate_funnel_cohorts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  preliminary_sample_target INTEGER NOT NULL CHECK(preliminary_sample_target BETWEEN 10 AND 500),
  comparable_sample_target INTEGER NOT NULL CHECK(comparable_sample_target BETWEEN 10 AND 500),
  formal_sample_target INTEGER NOT NULL CHECK(formal_sample_target BETWEEN 10 AND 500),
  sample_count INTEGER NOT NULL CHECK(sample_count > 0),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(preliminary_sample_target < comparable_sample_target),
  CHECK(comparable_sample_target < formal_sample_target),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_funnel_cohorts_profile
  ON candidate_funnel_cohorts(profile_id, frozen_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS candidate_funnel_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  card_id INTEGER,
  cohort_id INTEGER,
  plan_id INTEGER,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('applied', 'communication', 'reply_sent')),
  started_at TEXT NOT NULL,
  mature_at TEXT NOT NULL,
  direction_key TEXT NOT NULL DEFAULT '',
  decision_bucket TEXT NOT NULL DEFAULT '',
  resume_version_id INTEGER,
  greeting_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, job_id),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id),
  FOREIGN KEY(card_id) REFERENCES candidate_progress_cards(id),
  FOREIGN KEY(cohort_id) REFERENCES candidate_funnel_cohorts(id),
  FOREIGN KEY(plan_id) REFERENCES search_plans(id),
  FOREIGN KEY(resume_version_id) REFERENCES candidate_resume_versions(id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_funnel_entries_pool
  ON candidate_funnel_entries(profile_id, cohort_id, mature_at, id);
CREATE INDEX IF NOT EXISTS idx_candidate_funnel_entries_cohort
  ON candidate_funnel_entries(cohort_id, started_at, id);
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
  },
  {
    version: 10,
    name: "communication_outcome_statuses_v1",
    apply(db) {
      migrateCommunicationOutcomeStatuses(db);
    }
  },
  {
    version: 11,
    name: "message_discovery_unresolved_items_v1",
    apply(db) {
      db.exec(MESSAGE_DISCOVERY_UNRESOLVED_ITEMS_SCHEMA);
    }
  },
  {
    version: 12,
    name: "communication_runtime_binding_v1",
    apply(db) {
      const columns = db.prepare(
        "PRAGMA table_info(communication_batches)"
      ).all();
      if (!columns.some((column) => column.name === "runtime_json")) {
        db.exec(
          "ALTER TABLE communication_batches ADD COLUMN runtime_json TEXT NOT NULL DEFAULT '{}'"
        );
      }
    }
  },
  {
    version: 13,
    name: "message_discovery_safe_identity_v1",
    apply(db) {
      const columns = new Set(db.prepare(
        "PRAGMA table_info(message_discovery_unresolved_items)"
      ).all().map((column) => column.name));
      for (const [name, sql] of [
        ["position_title", "TEXT NOT NULL DEFAULT ''"],
        ["company", "TEXT NOT NULL DEFAULT ''"],
        ["salary", "TEXT NOT NULL DEFAULT ''"],
        ["city", "TEXT NOT NULL DEFAULT ''"],
        ["identity_digest", "TEXT NOT NULL DEFAULT ''"]
      ]) {
        if (!columns.has(name)) {
          db.exec(`ALTER TABLE message_discovery_unresolved_items ADD COLUMN ${name} ${sql}`);
        }
      }
    }
  },
  {
    version: 14,
    name: "onboarding_runs_v1",
    apply(db) {
      const columns = new Set(db.prepare(
        "PRAGMA table_info(candidate_profiles)"
      ).all().map((column) => column.name));
      if (!columns.has("is_ready")) {
        db.exec(
          "ALTER TABLE candidate_profiles ADD COLUMN is_ready INTEGER NOT NULL DEFAULT 1 CHECK(is_ready IN (0, 1))"
        );
      }
      db.exec(ONBOARDING_RUN_SCHEMA);
    }
  },
  {
    version: 15,
    name: "message_discovery_runtime_states_v1",
    apply(db) {
      db.exec(MESSAGE_DISCOVERY_RUNTIME_STATES_SCHEMA);
    }
  },
  {
    version: 16,
    name: "shared_boss_pacing_v1",
    apply(db) {
      migrateSharedSitePacingStates(db);
    }
  },
  {
    version: 17,
    name: "message_reply_learning_v1",
    apply(db) {
      db.exec(MESSAGE_REPLY_LEARNING_SCHEMA);
      backfillCandidateFactRevisions(db);
    }
  },
  {
    version: 18,
    name: "job_search_funnel_v1",
    apply(db) {
      db.exec(JOB_SEARCH_FUNNEL_SCHEMA);
    }
  }
];

function backfillCandidateFactRevisions(db) {
  db.exec(`INSERT INTO candidate_fact_revisions(
    profile_id, fact_key, fact_value, operation, source,
    answer_memory_id, evidence_text, withdrawn_at, created_at
  )
  SELECT profile_id, fact_key, fact_value, 'set', source,
    NULL, '', NULL, updated_at
  FROM candidate_facts
  WHERE NOT EXISTS (
    SELECT 1 FROM candidate_fact_revisions r
    WHERE r.profile_id = candidate_facts.profile_id
      AND r.fact_key = candidate_facts.fact_key
  )`);
}

function migrateSharedSitePacingStates(db) {
  const bySite = new Map();
  const add = (siteValue, pacingValue, updatedAtValue) => {
    const site = String(siteValue || "").trim().toLowerCase();
    const pacing = scanStore.normalizeBossPacing(pacingValue);
    if (!site || !pacing) return;
    const entries = bySite.get(site) || [];
    entries.push(pacing);
    bySite.set(site, entries);
    const timestamp = String(updatedAtValue || "");
    if (Number.isFinite(Date.parse(timestamp))) {
      const previous = bySite.get(`${site}:updatedAt`) || "";
      if (!previous || Date.parse(timestamp) > Date.parse(previous)) bySite.set(`${site}:updatedAt`, timestamp);
    }
  };
  for (const row of db.prepare(`SELECT platform, pacing_json, updated_at
    FROM message_discovery_runtime_states`).all()) {
    add(row.platform, parseJson(row.pacing_json, null), row.updated_at);
  }
  for (const row of db.prepare(`SELECT site, filter_snapshot_json, COALESCE(finished_at, started_at) AS updated_at
    FROM batches WHERE lower(site) = 'boss'`).all()) {
    add(row.site, parseJson(row.filter_snapshot_json, {})?.runtime?.bossPacing, row.updated_at);
  }
  db.exec(`
    ALTER TABLE message_discovery_runtime_states RENAME TO message_discovery_runtime_states_v15;
    ${SHARED_SITE_PACING_STATES_SCHEMA}
  `);
  const insert = db.prepare(`INSERT INTO message_discovery_runtime_states(platform, pacing_json, updated_at)
    VALUES (?, ?, ?)`);
  for (const [site, states] of bySite) {
    if (site.endsWith(":updatedAt")) continue;
    const pacing = scanStore.mergeBossPacingStates(...states);
    if (pacing) insert.run(site, JSON.stringify(pacing), bySite.get(`${site}:updatedAt`) || nowIso());
  }
  db.exec("DROP TABLE message_discovery_runtime_states_v15");
}
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

function migrateCommunicationOutcomeStatuses(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'communication_batch_items'").get();
  if (!table) {
    db.exec(COMMUNICATION_SCHEMA);
    return;
  }
  const sql = String(table.sql || "");
  if (sql.includes("platform_rejected") && sql.includes("transport_failed")) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_communication_items_batch;
    DROP INDEX IF EXISTS idx_communication_items_job;
    ALTER TABLE communication_batch_items RENAME TO communication_batch_items_v9;
  `);
  db.exec(COMMUNICATION_SCHEMA);
  db.exec(`
    INSERT INTO communication_batch_items(
      id, batch_id, job_id, position, job_url, title_snapshot, company_snapshot,
      status, click_count, evidence_json, error_code, error_message,
      started_at, clicked_at, finished_at, updated_at
    ) SELECT
      id, batch_id, job_id, position, job_url, title_snapshot, company_snapshot,
      status, click_count, evidence_json, error_code, error_message,
      started_at, clicked_at, finished_at, updated_at
    FROM communication_batch_items_v9;
    DROP TABLE communication_batch_items_v9;
  `);
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
    const summary = scanStore.summarizeScanTargets(db, batch.id);
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
  const workflowRuns = workflowStore.listWorkflowRuns(db, { profileId, planId, limit: workflowLimit + 1 });
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
  SCAN_RUN_STATUSES: scanStore.SCAN_RUN_STATUSES,
  WORKFLOW_RUN_STATUSES,
  openDb,
  immediateTransaction,
  recordMessageReplyDrafts,
  getMessageReplyDraft,
  listOpenMessageReplyDrafts,
  saveMessageReplyDraftEdit,
  completeMessageReplyDraft,
  listCandidateAnswerMemories,
  reviseCandidateAnswerMemory,
  withdrawCandidateAnswerMemory,
  listCandidateFactRevisions,
  deleteCandidateFact,
  closeMessageReplyDrafts,
  getFunnelPolicy: funnelStore.getFunnelPolicy,
  saveFunnelPolicy: funnelStore.saveFunnelPolicy,
  ensureFunnelEntry: funnelStore.ensureFunnelEntry,
  getFunnelEntry: funnelStore.getFunnelEntry,
  listFunnelEntries: funnelStore.listFunnelEntries,
  freezeReadyFunnelCohort: funnelStore.freezeReadyFunnelCohort,
  listFunnelCohorts: funnelStore.listFunnelCohorts,
  getFunnelCohort: funnelStore.getFunnelCohort,
  listFunnelProgressEvents: funnelStore.listFunnelProgressEvents,
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
  createBatch: scanStore.createBatch,

  createAndBindScanBatch: scanStore.createAndBindScanBatch,
  getBatch: scanStore.getBatch,
  getLatestResumableBatch: scanStore.getLatestResumableBatch,
  createScanRun: scanStore.createScanRun,
  getScanRun: scanStore.getScanRun,
  getLatestScanRun: scanStore.getLatestScanRun,
  beginScanRun: scanStore.beginScanRun,
  claimScanRun: scanStore.claimScanRun,
  heartbeatScanRun: scanStore.heartbeatScanRun,
  finishScanRun: scanStore.finishScanRun,
  recordScanRunProcessExit: scanStore.recordScanRunProcessExit,
  interruptOrphanedScanRuns: scanStore.interruptOrphanedScanRuns,
  checkpointScanProgress: scanStore.checkpointScanProgress,
  getSitePacingState: scanStore.getSitePacingState,
  setSitePacingState: scanStore.setSitePacingState,
  mergeBossPacingStates: scanStore.mergeBossPacingStates,
  checkpointScanTarget: scanStore.checkpointScanTarget,
  recordScanTargetResult: scanStore.recordScanTargetResult,
  listScanTargetResults: scanStore.listScanTargetResults,
  listLatestScanTargetResults: scanStore.listLatestScanTargetResults,
  summarizeScanTargets: scanStore.summarizeScanTargets,
  getSiteRuntimeState: scanStore.getSiteRuntimeState,
  setSiteRuntimeState: scanStore.setSiteRuntimeState,
  clearSiteRuntimeState: scanStore.clearSiteRuntimeState,
  recordSiteAccessEvent: scanStore.recordSiteAccessEvent,
  listSiteAccessEvents: scanStore.listSiteAccessEvents,
  acquireSiteScanLease: scanStore.acquireSiteScanLease,
  renewSiteScanLease: scanStore.renewSiteScanLease,
  releaseSiteScanLease: scanStore.releaseSiteScanLease,
  getSiteScanLease: scanStore.getSiteScanLease,
  listReusableJobDetails: scanStore.listReusableJobDetails,
  recordJobRefreshAttempt: scanStore.recordJobRefreshAttempt,
  listJobRefreshAttempts: scanStore.listJobRefreshAttempts,
  getLatestJobRefreshAttempt: scanStore.getLatestJobRefreshAttempt,
  getPlatformFilterCatalog: scanStore.getPlatformFilterCatalog,
  savePlatformFilterCatalog: scanStore.savePlatformFilterCatalog,
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
