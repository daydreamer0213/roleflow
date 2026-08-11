const crypto = require("crypto");
const { nowIso, parseJson } = require("./storage_shared");
const { normalizeMatchingCard, matchingCardRevision } = require("../core/matching_card");
const { maskResumeContacts, maskResumeFileName, maskResumeDiagnostics } = require("../core/resume_privacy");

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
      version: { ...resumeVersionDefaults(profile), analysis: profile },
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

function resumeVersionDefaults(profile = {}) {
  const candidate = profile.candidate || {};
  return {
    name: "基础简历",
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
    Number(profileId), documentId, versionKey, maskResumeContacts(version.name || "简历版本"),
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
    SELECT id FROM search_plans WHERE profile_id = candidate_profiles.id AND is_active = 1 ORDER BY updated_at DESC, id DESC LIMIT 1
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
        documentId || existing.resume_document_id || null, maskResumeContacts(version.name || "简历版本"),
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
  `).all(Number(profileId)).map((row) => {
    const automaticName = row.resume_document_id && row.name === row.original_file_name;
    return {
      id: Number(row.id),
      versionKey: row.version_key,
      name: automaticName ? "基础简历" : maskResumeContacts(row.name),
      targetRoles: parseJson(row.target_roles_json, []),
      keywords: parseJson(row.keywords_json, []),
      primaryProjects: parseJson(row.primary_projects_json, []),
      summary: row.summary || "",
      analysis: parseJson(row.analysis_json, {}),
      isActive: Boolean(row.is_active),
      resumeDocumentId: row.resume_document_id || null,
      fileName: row.original_file_name ? maskResumeFileName(row.original_file_name) : "",
      format: row.format || "",
      contentHash: row.content_hash || "",
      storedFilePath: row.stored_file_path || "",
      resumeTextExcerpt: String(row.resume_text || "").slice(0, 6000),
      diagnostics: maskResumeDiagnostics(parseJson(row.diagnostics_json, {})),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}

function listMatchingResumeVersions(db, profileId) {
  const versions = listCandidateResumeVersions(db, profileId);
  const excludedDocumentIds = new Set(db.prepare(`
    SELECT resume_document_id
    FROM candidate_matching_cards
    WHERE profile_id = ? AND status = 'draft' AND resume_document_id IS NOT NULL
    UNION
    SELECT profile_versions.resume_document_id
    FROM profile_versions
    JOIN resume_documents ON resume_documents.id = profile_versions.resume_document_id
    JOIN candidate_matching_cards
      ON candidate_matching_cards.profile_id = profile_versions.profile_id
      AND candidate_matching_cards.status = 'draft'
      AND candidate_matching_cards.resume_content_hash = resume_documents.content_hash
    WHERE profile_versions.profile_id = ? AND profile_versions.resume_document_id IS NOT NULL
  `).all(Number(profileId), Number(profileId)).map((row) => Number(row.resume_document_id)));
  if (!excludedDocumentIds.size) return versions;
  return versions.filter((version) => !version.resumeDocumentId || !excludedDocumentIds.has(Number(version.resumeDocumentId)));
}

function recordResumeParseAttempt(db, { profileId = null, document = null, fileName = "resume", format = "", inputBytes = 0, error = null }) {
  const diagnostics = maskResumeDiagnostics(document?.diagnostics || error?.details?.diagnostics || {});
  db.prepare(`INSERT INTO resume_parse_attempts(
    profile_id, original_file_name, format, input_bytes, extraction_method, char_count, preview,
    diagnostics_json, status, error_code, error_message, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    Number(profileId || 0) || null,
    maskResumeFileName(document?.originalFileName || fileName || "resume"),
    String(document?.format || format || ""),
    Number(document?.diagnostics?.inputBytes || inputBytes || 0),
    String(document?.diagnostics?.extractionMethod || diagnostics.extractionMethod || ""),
    Number(document?.charCount || diagnostics.charCount || 0),
    String(diagnostics.preview || "").slice(0, 600),
    JSON.stringify(diagnostics),
    error ? "failed" : "succeeded",
    error?.code || null,
    error ? maskResumeContacts(error.message || "parse failed").slice(0, 500) : null,
    nowIso()
  );
}

function listResumeParseAttempts(db, profileId, limit = 12) {
  return db.prepare(`SELECT * FROM resume_parse_attempts
    WHERE profile_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(
    Number(profileId), Math.max(1, Math.min(50, Number(limit) || 12))
  ).map((row) => ({
    id: Number(row.id), fileName: maskResumeFileName(row.original_file_name), format: row.format || "", inputBytes: Number(row.input_bytes || 0),
    extractionMethod: row.extraction_method || "", charCount: Number(row.char_count || 0), preview: maskResumeContacts(row.preview || ""),
    diagnostics: maskResumeDiagnostics(parseJson(row.diagnostics_json, {})), status: row.status, errorCode: row.error_code || "",
    errorMessage: maskResumeContacts(row.error_message || ""), createdAt: row.created_at
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
  const row = db.prepare("SELECT * FROM search_plans WHERE profile_id = ? AND is_active = 1 ORDER BY updated_at DESC, id DESC LIMIT 1").get(Number(profileId));
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
    fileName: row.original_file_name ? maskResumeFileName(row.original_file_name) : "",
    format: row.format || "",
    createdAt: row.created_at
  }));
}

function getLatestProfileVersionId(db, profileId) {
  return Number(db.prepare("SELECT id FROM profile_versions WHERE profile_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(Number(profileId))?.id || 0) || null;
}

function getSearchPlanDependency(db, planId) {
  const plan = getSearchPlan(db, planId);
  if (!plan) return { stale: false, planProfileVersionId: null, currentProfileVersionId: null, matchingCardRequired: false, activeProfileVersionId: null, profileId: null, draftCardId: null };
  const currentProfileVersionId = getLatestProfileVersionId(db, plan.profileId);
  const activeCard = getActiveMatchingCard(db, plan.profileId);
  if (!activeCard) {
    const draftCardId = Number(db.prepare(`SELECT id FROM candidate_matching_cards
      WHERE profile_id = ? AND status = 'draft'
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(Number(plan.profileId))?.id || 0) || null;
    return {
      stale: Boolean(currentProfileVersionId && plan.profileVersionId !== currentProfileVersionId),
      planProfileVersionId: plan.profileVersionId || null,
      currentProfileVersionId,
      matchingCardRequired: true,
      activeProfileVersionId: null,
      profileId: plan.profileId,
      draftCardId
    };
  }
  return {
    stale: plan.profileVersionId !== activeCard.profileVersionId,
    planProfileVersionId: plan.profileVersionId || null,
    currentProfileVersionId,
    matchingCardRequired: false,
    activeProfileVersionId: activeCard.profileVersionId,
    matchingCardId: activeCard.id,
    profileId: plan.profileId,
    draftCardId: null
  };
}

function matchingCardRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    profileVersionId: Number(row.profile_version_id),
    resumeDocumentId: row.resume_document_id == null ? null : Number(row.resume_document_id),
    resumeContentHash: row.resume_content_hash || "",
    card: parseJson(row.card_json, {}),
    status: row.status,
    source: row.source,
    confirmedAt: row.confirmed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getMatchingCard(db, cardId) {
  return matchingCardRow(db.prepare("SELECT * FROM candidate_matching_cards WHERE id = ?").get(Number(cardId)));
}

function getActiveMatchingCard(db, profileId) {
  return matchingCardRow(db.prepare(`SELECT * FROM candidate_matching_cards
    WHERE profile_id = ? AND status = 'confirmed'
    ORDER BY confirmed_at DESC, id DESC LIMIT 1`).get(Number(profileId)));
}

function listMatchingCards(db, profileId) {
  return db.prepare(`SELECT * FROM candidate_matching_cards
    WHERE profile_id = ? ORDER BY created_at DESC, id DESC`).all(Number(profileId)).map(matchingCardRow);
}

function createMatchingCardDraft(db, { profileId, profileVersionId, resumeDocumentId = null, resumeContentHash, card, source = "model" }) {
  const profile = Number(profileId);
  const version = Number(profileVersionId);
  const hash = String(resumeContentHash || "").trim();
  if (!profile || !version || !hash) throw new Error("匹配卡草稿必须包含 profileId、profileVersionId 和 resumeContentHash");
  const existing = db.prepare(`SELECT * FROM candidate_matching_cards
    WHERE profile_id = ? AND resume_content_hash = ? AND status IN ('draft', 'confirmed')
    ORDER BY status = 'confirmed' DESC, id DESC LIMIT 1`).get(profile, hash);
  if (existing) return matchingCardRow(existing);
  const normalized = normalizeMatchingCard(card, { source });
  const now = nowIso();
  const result = db.prepare(`INSERT INTO candidate_matching_cards(
    profile_id, profile_version_id, resume_document_id, resume_content_hash,
    card_json, status, source, confirmed_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'draft', ?, NULL, ?, ?)`)
    .run(profile, version, resumeDocumentId == null ? null : Number(resumeDocumentId), hash, JSON.stringify(normalized), normalized.source, now, now);
  return getMatchingCard(db, Number(result.lastInsertRowid));
}

function confirmMatchingCard(db, { profileId, cardId }) {
  const profile = Number(profileId);
  const target = Number(cardId);
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT id, status FROM candidate_matching_cards WHERE id = ? AND profile_id = ?").get(target, profile);
    if (!row) throw new Error("matching card not found");
    if (row.status === "confirmed") {
      db.exec("COMMIT");
      return getMatchingCard(db, target);
    }
    if (row.status !== "draft") {
      const error = new Error("只有草稿卡可以确认；已被替换的历史卡不能重新激活。");
      error.code = "MATCHING_CARD_NOT_CONFIRMABLE";
      throw error;
    }
    db.prepare("UPDATE candidate_matching_cards SET status = 'superseded', updated_at = ? WHERE profile_id = ? AND status = 'confirmed'").run(now, profile);
    db.prepare("UPDATE candidate_matching_cards SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?").run(now, now, target);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getMatchingCard(db, target);
}

function saveMatchingCardDraftEdit(db, { profileId, cardId, card }) {
  const existing = getMatchingCard(db, cardId);
  if (!existing || existing.profileId !== Number(profileId)) throw new Error("matching card not found");
  if (existing.status !== "draft") throw new Error("只有草稿卡可以直接编辑；已确认卡请使用修订。");
  const normalized = normalizeMatchingCard(card, { source: "user", editedByUser: true });
  db.prepare("UPDATE candidate_matching_cards SET card_json = ?, source = 'user', updated_at = ? WHERE id = ?")
    .run(JSON.stringify(normalized), nowIso(), existing.id);
  return getMatchingCard(db, existing.id);
}

function saveConfirmedMatchingCardRevision(db, { profileId, cardId, card }) {
  const profile = Number(profileId);
  const target = Number(cardId);
  const normalized = normalizeMatchingCard(card, { source: "user", editedByUser: true });
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT * FROM candidate_matching_cards WHERE id = ? AND profile_id = ?").get(target, profile);
    if (!existing) throw new Error("matching card not found");
    if (existing.status !== "confirmed") throw new Error("只有已确认卡可以产生确认修订。");
    db.prepare("UPDATE candidate_matching_cards SET status = 'superseded', updated_at = ? WHERE profile_id = ? AND status = 'confirmed'").run(now, profile);
    const result = db.prepare(`INSERT INTO candidate_matching_cards(
      profile_id, profile_version_id, resume_document_id, resume_content_hash,
      card_json, status, source, confirmed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'confirmed', 'user', ?, ?, ?)`)
      .run(profile, Number(existing.profile_version_id), existing.resume_document_id || null,
        existing.resume_content_hash, JSON.stringify(normalized), now, now, now);
    db.exec("COMMIT");
    return getMatchingCard(db, Number(result.lastInsertRowid));
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getCandidateMatchingContext(db, profileId) {
  const activeCard = getActiveMatchingCard(db, profileId);
  if (!activeCard) return null;
  const version = db.prepare("SELECT id, profile_json FROM profile_versions WHERE id = ?").get(activeCard.profileVersionId);
  if (!version) return null;
  return {
    matchingCard: activeCard.card,
    matchingCardId: activeCard.id,
    matchingCardRevision: matchingCardRevision(activeCard.card),
    matchingCardConfirmedAt: activeCard.confirmedAt,
    profileVersionId: activeCard.profileVersionId,
    candidateProfile: parseJson(version.profile_json, {}),
    resumeDocumentId: activeCard.resumeDocumentId
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
};
