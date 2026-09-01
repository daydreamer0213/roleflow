const crypto = require("node:crypto");
const { immediateTransaction, nowIso, parseJson } = require("./storage_shared");
const {
  maskResumeContacts,
  maskResumeDiagnostics,
  maskResumeFileName
} = require("../core/resume_privacy");

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const INITIAL_SEARCH_PREPARATION_EVENT = "onboarding_initial_search_prepared";

function createOnboardingRun(db, {
  profileId = null,
  displayName = "候选人",
  document
} = {}) {
  const requestedProfileId = Number(profileId || 0) || null;
  const hash = String(document?.contentHash || "").trim();
  if (!hash || !String(document?.text || "").trim()) {
    throw new Error("onboarding run requires a parsed resume document");
  }
  const duplicate = findDuplicateRun(db, requestedProfileId, hash);
  if (duplicate) return { created: false, run: onboardingRunRow(duplicate) };

  return immediateTransaction(db, () => {
    const now = nowIso();
    let candidateId = requestedProfileId;
    if (candidateId) {
      const existing = db.prepare(
        "SELECT id FROM candidate_profiles WHERE id = ? AND is_ready = 1"
      ).get(candidateId);
      if (!existing) throw new Error("candidate profile not found");
    } else {
      candidateId = Number(db.prepare(`
        INSERT INTO candidate_profiles(
          display_name, profile_json, source_hash, is_ready, created_at, updated_at
        ) VALUES (?, '{}', ?, 0, ?, ?)
      `).run(safeDisplayName(displayName), hash, now, now).lastInsertRowid);
    }

    const resumeDocumentId = Number(db.prepare(`
      INSERT INTO resume_documents(
        profile_id, original_file_name, format, content_hash, resume_text,
        text_truncated, diagnostics_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidateId,
      String(document.originalFileName || "resume"),
      String(document.format || "text"),
      hash,
      String(document.text),
      document.textTruncated ? 1 : 0,
      JSON.stringify(maskResumeDiagnostics(document.diagnostics || {})),
      now
    ).lastInsertRowid);
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO onboarding_runs(
        id, profile_id, resume_document_id, status, stage, progress_revision,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', 'parsed', 0, ?, ?)
    `).run(id, candidateId, resumeDocumentId, now, now);
    recordParseAttempt(db, { profileId: candidateId, document, now });
    return { created: true, run: getOnboardingRun(db, id) };
  });
}

function findDuplicateRun(db, profileId, contentHash) {
  const profileClause = profileId
    ? "AND runs.profile_id = ?"
    : "AND runs.status IN ('queued','running','failed')";
  return db.prepare(`
    SELECT runs.*
    FROM onboarding_runs runs
    JOIN resume_documents documents ON documents.id = runs.resume_document_id
    WHERE documents.content_hash = ? ${profileClause}
    ORDER BY runs.created_at DESC
    LIMIT 1
  `).get(...(profileId ? [contentHash, profileId] : [contentHash]));
}

function recordParseAttempt(db, { profileId, document, now }) {
  const diagnostics = maskResumeDiagnostics(document.diagnostics || {});
  db.prepare(`
    INSERT INTO resume_parse_attempts(
      profile_id, original_file_name, format, input_bytes, extraction_method,
      char_count, preview, diagnostics_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', ?)
  `).run(
    profileId,
    maskResumeFileName(document.originalFileName || "resume"),
    String(document.format || ""),
    Number(document.diagnostics?.inputBytes || 0),
    String(document.diagnostics?.extractionMethod || ""),
    Number(document.charCount || diagnostics.charCount || 0),
    String(diagnostics.preview || "").slice(0, 600),
    JSON.stringify(diagnostics),
    now
  );
}

function getOnboardingRun(db, id) {
  return onboardingRunRow(db.prepare(
    "SELECT * FROM onboarding_runs WHERE id = ?"
  ).get(String(id || "")));
}

function getOnboardingRunContext(db, id) {
  const row = db.prepare(`
    SELECT runs.*, profiles.display_name, profiles.is_ready,
      documents.original_file_name, documents.format, documents.content_hash,
      documents.resume_text, documents.text_truncated, documents.diagnostics_json,
      documents.stored_file_path
    FROM onboarding_runs runs
    JOIN candidate_profiles profiles ON profiles.id = runs.profile_id
    JOIN resume_documents documents ON documents.id = runs.resume_document_id
    WHERE runs.id = ?
  `).get(String(id || ""));
  if (!row) return null;
  return {
    run: onboardingRunRow(row),
    displayName: safeDisplayName(row.display_name),
    profileReady: Boolean(row.is_ready),
    document: {
      id: Number(row.resume_document_id),
      profileId: Number(row.profile_id),
      originalFileName: row.original_file_name,
      format: row.format,
      contentHash: row.content_hash,
      text: row.resume_text,
      textTruncated: Boolean(row.text_truncated),
      diagnostics: parseJson(row.diagnostics_json, {}),
      storedFilePath: row.stored_file_path || ""
    }
  };
}

function claimOnboardingRun(db, id) {
  const now = nowIso();
  const result = db.prepare(`
    UPDATE onboarding_runs
    SET status = 'running', heartbeat_at = ?, updated_at = ?,
      progress_revision = progress_revision + 1, finished_at = NULL
    WHERE id = ? AND status = 'queued'
  `).run(now, now, String(id || ""));
  return { claimed: Boolean(result.changes), run: getOnboardingRun(db, id) };
}

function checkpointOnboardingRun(db, {
  id,
  status,
  stage,
  profileVersionId,
  matchingCardId,
  searchPlanId,
  errorCode,
  errorMessage,
  finished = false
}) {
  const current = getOnboardingRun(db, id);
  if (!current) throw new Error("onboarding run not found");
  const now = nowIso();
  db.prepare(`
    UPDATE onboarding_runs SET
      status = ?,
      stage = ?,
      profile_version_id = ?,
      matching_card_id = ?,
      search_plan_id = ?,
      error_code = ?,
      error_message = ?,
      heartbeat_at = ?,
      finished_at = ?,
      updated_at = ?,
      progress_revision = progress_revision + 1
    WHERE id = ?
  `).run(
    status || current.status,
    stage || current.stage,
    optionalId(profileVersionId, current.profileVersionId),
    optionalId(matchingCardId, current.matchingCardId),
    optionalId(searchPlanId, current.searchPlanId),
    errorCode === undefined ? current.errorCode || null : nullable(errorCode, 100),
    errorMessage === undefined ? current.errorMessage || null : nullable(maskResumeContacts(errorMessage), 500),
    now,
    finished ? now : null,
    now,
    current.id
  );
  return getOnboardingRun(db, current.id);
}

function heartbeatOnboardingRun(db, id) {
  const now = nowIso();
  return db.prepare(`
    UPDATE onboarding_runs SET heartbeat_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running'
  `).run(now, now, String(id || "")).changes > 0;
}

function retryOnboardingRun(db, id) {
  const current = getOnboardingRun(db, id);
  if (!current) throw new Error("onboarding run not found");
  const retryablePartial = current.status === "completed"
    && Boolean(current.matchingCardId)
    && !current.searchPlanId
    && Boolean(current.errorCode);
  if (current.status !== "failed" && !retryablePartial) {
    throw new Error("当前简历处理不需要重试。");
  }
  const now = nowIso();
  db.prepare(`
    UPDATE onboarding_runs SET
      status = 'queued', error_code = NULL, error_message = NULL,
      heartbeat_at = NULL, finished_at = NULL, updated_at = ?,
      progress_revision = progress_revision + 1
    WHERE id = ?
  `).run(now, current.id);
  return getOnboardingRun(db, current.id);
}

function failOnboardingRun(db, id, error, stage = "") {
  const current = getOnboardingRun(db, id);
  if (!current) throw new Error("onboarding run not found");
  return checkpointOnboardingRun(db, {
    id,
    status: "failed",
    stage: stage || current.stage,
    errorCode: String(error?.code || "ONBOARDING_RUN_FAILED"),
    errorMessage: String(error?.message || "简历处理失败。"),
    finished: true
  });
}

function recoverStaleOnboardingRuns(db, {
  now = nowIso(),
  staleAfterMs = 180_000
} = {}) {
  const cutoff = new Date(Date.parse(now) - Math.max(1, Number(staleAfterMs) || 180_000)).toISOString();
  const result = db.prepare(`
    UPDATE onboarding_runs SET
      status = 'failed',
      error_code = 'ONBOARDING_RUN_ORPHANED',
      error_message = '后台处理已中断，可从已完成步骤继续重试。',
      finished_at = ?, updated_at = ?,
      progress_revision = progress_revision + 1
    WHERE status IN ('queued','running')
      AND COALESCE(heartbeat_at, updated_at) < ?
  `).run(now, now, cutoff);
  return { interrupted: Number(result.changes || 0) };
}

function getLatestActiveOnboardingRun(db) {
  return onboardingRunRow(db.prepare(`
    SELECT * FROM onboarding_runs
    WHERE (
      status IN ('queued','running','failed')
      OR (status = 'completed' AND error_code IS NOT NULL AND search_plan_id IS NULL)
    )
      AND (
        status IN ('queued','running')
        OR NOT EXISTS (
          SELECT 1 FROM profile_versions
          WHERE profile_versions.profile_id = onboarding_runs.profile_id
        )
      )
    ORDER BY created_at DESC LIMIT 1
  `).get());
}

function getInitialSearchCatchUpCandidate(db) {
  return onboardingRunRow(db.prepare(`
    WITH latest_completed AS (
      SELECT * FROM onboarding_runs
      WHERE status = 'completed'
      ORDER BY COALESCE(finished_at, updated_at) DESC, created_at DESC
      LIMIT 1
    )
    SELECT runs.*
    FROM latest_completed runs
    JOIN candidate_profiles profiles
      ON profiles.id = runs.profile_id AND profiles.is_ready = 1
    JOIN search_plans plans
      ON plans.id = runs.search_plan_id
      AND plans.profile_id = runs.profile_id
      AND plans.profile_version_id = runs.profile_version_id
      AND plans.is_active = 1
    WHERE NOT EXISTS (
      SELECT 1 FROM workflow_runs workflows
      WHERE workflows.profile_id = runs.profile_id
        AND workflows.plan_id = runs.search_plan_id
    )
      AND NOT EXISTS (
        SELECT 1 FROM events markers
        WHERE markers.event_type = ?
          AND json_valid(markers.payload_json)
          AND json_extract(markers.payload_json, '$.runId') = runs.id
      )
  `).get(INITIAL_SEARCH_PREPARATION_EVENT));
}

function recordInitialSearchPreparationHandled(db, { run, source, result } = {}) {
  const status = String(result?.status || "").trim();
  const reason = String(result?.reason || "").trim();
  const handled = status === "prepared"
    || (status === "skipped" && ["query_present", "keyword_missing"].includes(reason));
  if (!handled) return false;
  const runId = String(run?.id || "").trim();
  const profileId = Number(run?.profileId || 0);
  const planId = Number(run?.searchPlanId || 0);
  if (!runId || !profileId || !planId) return false;
  const existing = db.prepare(`SELECT id FROM events
    WHERE event_type = ?
      AND json_valid(payload_json)
      AND json_extract(payload_json, '$.runId') = ?
    LIMIT 1`).get(INITIAL_SEARCH_PREPARATION_EVENT, runId);
  if (existing) return false;
  db.prepare(`INSERT INTO events(job_id, event_type, payload_json, created_at)
    VALUES (NULL, ?, ?, ?)`)
    .run(INITIAL_SEARCH_PREPARATION_EVENT, JSON.stringify({
      runId,
      profileId,
      planId,
      source: String(source || "onboarding_completion").trim() || "onboarding_completion",
      status,
      reason
    }), nowIso());
  return true;
}

function onboardingRunRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    profileId: Number(row.profile_id),
    resumeDocumentId: Number(row.resume_document_id),
    status: String(row.status),
    stage: String(row.stage),
    progressRevision: Number(row.progress_revision || 0),
    profileVersionId: optionalNumber(row.profile_version_id),
    matchingCardId: optionalNumber(row.matching_card_id),
    searchPlanId: optionalNumber(row.search_plan_id),
    errorCode: String(row.error_code || ""),
    errorMessage: maskResumeContacts(row.error_message || ""),
    heartbeatAt: row.heartbeat_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || null
  };
}

function safeDisplayName(value) {
  const name = String(value || "").trim();
  return name && !/姓名已隐藏|姓名已遮盖|已隐藏/i.test(name) ? name : "候选人";
}

function optionalId(value, fallback) {
  if (value === undefined) return fallback || null;
  return optionalNumber(value);
}

function optionalNumber(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nullable(value, limit) {
  const text = String(value || "").trim();
  return text ? text.slice(0, limit) : null;
}

module.exports = {
  ACTIVE_STATUSES,
  createOnboardingRun,
  getOnboardingRun,
  getOnboardingRunContext,
  claimOnboardingRun,
  checkpointOnboardingRun,
  heartbeatOnboardingRun,
  retryOnboardingRun,
  failOnboardingRun,
  recoverStaleOnboardingRuns,
  getLatestActiveOnboardingRun,
  getInitialSearchCatchUpCandidate,
  recordInitialSearchPreparationHandled
};
