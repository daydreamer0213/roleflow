const crypto = require("node:crypto");
const { nowIso, parseJson, immediateTransaction, storageError } = require("./storage_shared");
const { maskResumeContacts } = require("../core/resume_privacy");
const { getActiveFunnelStrategyRound, startFunnelStrategyRound } = require("./funnel_store");

function sha256(text) {
  return crypto.createHash("sha256").update(String(text ?? "")).digest("hex");
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new TypeError(`${label} must be a positive integer`);
  return id;
}

function stringList(value, limit) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(items.map((item) => String(item ?? "").trim()).filter(Boolean))].slice(0, limit);
}

function jobIds(value) {
  const ids = [...new Set((Array.isArray(value) ? value : []).map((item) => positiveId(item, "targetJobId")))].sort((a, b) => a - b);
  if (ids.length < 1 || ids.length > 5) throw new Error("定向简历必须绑定 1-5 个目标岗位");
  return ids;
}

function boundedText(value, maxLength, label) {
  const text = String(value ?? "");
  if (!text.trim()) throw new Error(`${label}不能为空`);
  if (text.length > maxLength) throw new Error(`${label}过长`);
  return text;
}

function comparableText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function optimizationRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    planId: row.plan_id == null ? null : Number(row.plan_id),
    sourceResumeVersionId: Number(row.source_resume_version_id),
    sourceResumeDocumentId: Number(row.source_resume_document_id),
    sourceContentHash: row.source_content_hash,
    sourceText: row.source_text,
    targetDirection: row.target_direction || "",
    targetJobIds: parseJson(row.target_job_ids_json, []),
    contextHash: row.context_hash,
    evidenceCatalog: parseJson(row.evidence_json, []),
    headline: row.headline || "",
    changeLedger: parseJson(row.suggestions_json, []),
    suggestions: parseJson(row.suggestions_json, []),
    generatedText: row.generated_text || "",
    finalText: row.final_text || "",
    draftFormat: row.draft_format || "legacy_suggestions",
    userEditedAt: row.user_edited_at || null,
    status: row.status,
    resultResumeDocumentId: row.result_resume_document_id == null ? null : Number(row.result_resume_document_id),
    resultResumeVersionId: row.result_resume_version_id == null ? null : Number(row.result_resume_version_id),
    modelIdentity: parseJson(row.model_identity_json, {}),
    strategyRoundId: row.strategy_round_id == null ? null : Number(row.strategy_round_id),
    activatedAt: row.activated_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createResumeOptimization(db, input = {}) {
  const profileId = positiveId(input.profileId, "profileId");
  const planId = positiveId(input.planId, "planId");
  const plan = db.prepare("SELECT id FROM search_plans WHERE id = ? AND profile_id = ?").get(planId, profileId);
  if (!plan) throw storageError("RESUME_OPTIMIZATION_PLAN_NOT_OWNED", "搜索计划不存在或不属于当前候选人");
  const sourceResumeVersionId = positiveId(input.sourceResumeVersionId, "sourceResumeVersionId");
  const source = db.prepare(`SELECT rv.id, rv.resume_document_id, rd.content_hash, rd.resume_text
    FROM candidate_resume_versions rv
    JOIN resume_documents rd ON rd.id = rv.resume_document_id
    WHERE rv.id = ? AND rv.profile_id = ?`).get(sourceResumeVersionId, profileId);
  if (!source) throw storageError("RESUME_OPTIMIZATION_SOURCE_NOT_FOUND", "源简历不存在或不属于当前候选人");

  const targetJobIds = jobIds(input.targetJobIds);
  const targetDirection = boundedText(input.targetDirection, 160, "目标投递方向").trim();
  const generatedText = boundedText(input.generatedText, 200_000, "完整简历草稿");
  const evidenceCatalog = Array.isArray(input.evidenceCatalog) ? input.evidenceCatalog : [];
  const suggestions = Array.isArray(input.suggestions) ? input.suggestions : [];
  const sourceText = String(source.resume_text || "");
  if (!sourceText.trim()) throw new Error("源简历文字为空");
  const sourceContentHash = String(source.content_hash || sha256(sourceText));
  const contextHash = sha256(JSON.stringify({
    profileId,
    planId,
    sourceResumeVersionId,
    sourceContentHash,
    targetDirection,
    targetJobIds,
    evidenceCatalog
  }));
  const now = nowIso();
  const result = db.prepare(`INSERT INTO resume_optimizations(
    profile_id, plan_id, source_resume_version_id, source_resume_document_id,
    source_content_hash, source_text, target_direction, target_job_ids_json, context_hash,
    evidence_json, headline, suggestions_json, generated_text, final_text, draft_format, status,
    result_resume_document_id, result_resume_version_id, model_identity_json,
    strategy_round_id, activated_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'whole_draft', 'draft', NULL, NULL, ?, NULL, NULL, ?, ?)`).run(
    profileId,
    planId,
    sourceResumeVersionId,
    Number(source.resume_document_id),
    sourceContentHash,
    sourceText,
    targetDirection,
    JSON.stringify(targetJobIds),
    contextHash,
    JSON.stringify(evidenceCatalog),
    String(input.headline || "").trim().slice(0, 300),
    JSON.stringify(suggestions),
    generatedText,
    generatedText,
    JSON.stringify(input.modelIdentity || {}),
    now,
    now
  );
  return getResumeOptimization(db, { profileId, optimizationId: Number(result.lastInsertRowid) });
}

function getResumeOptimization(db, { profileId, optimizationId }) {
  const row = db.prepare("SELECT * FROM resume_optimizations WHERE id = ? AND profile_id = ?")
    .get(positiveId(optimizationId, "optimizationId"), positiveId(profileId, "profileId"));
  return optimizationRow(row);
}

function listResumeOptimizations(db, profileId, limit = 30) {
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  return db.prepare(`SELECT * FROM resume_optimizations
    WHERE profile_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(positiveId(profileId, "profileId"), boundedLimit)
    .map(optimizationRow);
}

function saveResumeOptimizationDraft(db, input = {}) {
  const profileId = positiveId(input.profileId, "profileId");
  const optimizationId = positiveId(input.optimizationId, "optimizationId");
  const finalText = boundedText(input.finalText, 200_000, "最终简历文字");
  return immediateTransaction(db, () => {
    const existing = db.prepare("SELECT status, generated_text FROM resume_optimizations WHERE id = ? AND profile_id = ?")
      .get(optimizationId, profileId);
    if (!existing) throw storageError("RESUME_OPTIMIZATION_NOT_FOUND", "定向简历草稿不存在");
    if (existing.status !== "draft") throw storageError("RESUME_OPTIMIZATION_CLOSED", "已启用的定向简历不能继续保存");
    const updatedAt = String(input.updatedAt || nowIso());
    const userEditedAt = comparableText(finalText) === comparableText(existing.generated_text) ? null : updatedAt;
    db.prepare(`UPDATE resume_optimizations
      SET final_text = ?, user_edited_at = ?, updated_at = ?
      WHERE id = ? AND profile_id = ? AND status = 'draft'`).run(
      finalText,
      userEditedAt,
      updatedAt,
      optimizationId,
      profileId
    );
    return optimizationRow(db.prepare("SELECT * FROM resume_optimizations WHERE id = ?").get(optimizationId));
  });
}

function activateResumeOptimization(db, input = {}) {
  const profileId = positiveId(input.profileId, "profileId");
  const planId = positiveId(input.planId, "planId");
  const optimizationId = positiveId(input.optimizationId, "optimizationId");
  const requestedFinalText = boundedText(input.finalText, 200_000, "最终简历文字");
  return immediateTransaction(db, () => {
    const row = db.prepare("SELECT * FROM resume_optimizations WHERE id = ? AND profile_id = ?")
      .get(optimizationId, profileId);
    if (!row) throw storageError("RESUME_OPTIMIZATION_NOT_FOUND", "定向简历草稿不存在");
    if (Number(row.plan_id || 0) !== planId) {
      throw storageError("RESUME_OPTIMIZATION_PLAN_MISMATCH", "这份定向简历不属于当前投递方案，请返回原方案启用");
    }
    if (row.status === "activated") {
      if (row.final_text !== requestedFinalText) {
        throw storageError("RESUME_OPTIMIZATION_CLOSED", "已启用的定向简历不能再修改");
      }
      return optimizationRow(row);
    }
    if (row.status !== "draft") throw storageError("RESUME_OPTIMIZATION_CLOSED", "当前定向简历不能启用");
    const finalText = requestedFinalText;

    const sourceVersion = db.prepare("SELECT * FROM candidate_resume_versions WHERE id = ? AND profile_id = ?")
      .get(Number(row.source_resume_version_id), profileId);
    if (!sourceVersion) throw storageError("RESUME_OPTIMIZATION_SOURCE_NOT_FOUND", "冻结的源简历版本不存在");
    const now = nowIso();
    const userEditedAt = comparableText(finalText) === comparableText(row.generated_text)
      ? null
      : (row.user_edited_at || now);
    db.prepare(`UPDATE resume_optimizations
      SET final_text = ?, user_edited_at = ?, updated_at = ?
      WHERE id = ? AND profile_id = ? AND status = 'draft'`).run(
      finalText,
      userEditedAt,
      now,
      optimizationId,
      profileId
    );
    const documentId = Number(db.prepare(`INSERT INTO resume_documents(
      profile_id, original_file_name, format, content_hash, resume_text,
      text_truncated, diagnostics_json, stored_file_path, created_at
    ) VALUES (?, ?, 'text', ?, ?, 0, ?, NULL, ?)`).run(
      profileId,
      `targeted-resume-${optimizationId}.txt`,
      sha256(finalText),
      finalText,
      JSON.stringify({ source: "resume_optimization", optimizationId }),
      now
    ).lastInsertRowid);

    const version = input.version || {};
    const analysis = {
      source: "resume_optimization",
      optimizationId,
      sourceResumeVersionId: Number(row.source_resume_version_id),
      targetDirection: row.target_direction || "",
      targetJobIds: parseJson(row.target_job_ids_json, []),
      modelIdentity: parseJson(row.model_identity_json, {})
    };
    const versionId = Number(db.prepare(`INSERT INTO candidate_resume_versions(
      profile_id, resume_document_id, version_key, name, target_roles_json,
      keywords_json, primary_projects_json, summary, analysis_json,
      is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
      profileId,
      documentId,
      `resume_optimization_${optimizationId}`,
      maskResumeContacts(version.name || "定向简历"),
      JSON.stringify(stringList(version.targetRoles ?? parseJson(sourceVersion.target_roles_json, []), 8)),
      JSON.stringify(stringList(version.keywords ?? parseJson(sourceVersion.keywords_json, []), 16)),
      JSON.stringify(stringList(version.primaryProjects ?? parseJson(sourceVersion.primary_projects_json, []), 6)),
      String(version.summary ?? sourceVersion.summary ?? ""),
      JSON.stringify(analysis),
      now,
      now
    ).lastInsertRowid);

    const fromRound = getActiveFunnelStrategyRound(db, { profileId, planId });
    const strategyRound = startFunnelStrategyRound(db, {
      profileId,
      planId,
      fromRoundId: fromRound?.id || null,
      sourceKey: `resume_optimization:${optimizationId}`,
      changeKinds: ["resume"],
      changeNote: "启用定向简历",
      resumeVersionId: versionId,
      startedAt: now
    });

    db.prepare(`UPDATE resume_optimizations
      SET status = 'activated', result_resume_document_id = ?, result_resume_version_id = ?,
        strategy_round_id = ?, activated_at = ?, updated_at = ?
      WHERE id = ? AND profile_id = ? AND status = 'draft'`).run(
      documentId,
      versionId,
      strategyRound.id,
      now,
      now,
      optimizationId,
      profileId
    );
    return optimizationRow(db.prepare("SELECT * FROM resume_optimizations WHERE id = ?").get(optimizationId));
  });
}

module.exports = {
  createResumeOptimization,
  getResumeOptimization,
  listResumeOptimizations,
  saveResumeOptimizationDraft,
  activateResumeOptimization
};
