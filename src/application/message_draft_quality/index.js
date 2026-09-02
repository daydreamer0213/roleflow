"use strict";

const { assessMessageDraftQuality } = require("../../core/message_draft_quality");
const { listCandidateFacts, listCandidateAnswerMemories } = require("../../core/storage");

async function generateQualityCheckedDraft({
  generate,
  input = {},
  recentTexts = [],
  evidenceTexts = [],
  shouldAssess = () => true
} = {}) {
  if (typeof generate !== "function") throw new TypeError("generate is required");
  const first = await generate(input);
  if (!shouldAssess(first)) return checkedResult(first, skippedAssessment(), 1);
  const firstAssessment = assessResult(first, recentTexts, evidenceTexts);
  if (!needsRevision(firstAssessment)) return checkedResult(first, firstAssessment, 1);
  try {
    const second = await generate({
      ...input,
      draftQualityRevision: revisionInput(firstAssessment)
    });
    return checkedResult(second, assessResult(second, recentTexts, evidenceTexts), 2);
  } catch (error) {
    return checkedResult(first, firstAssessment, 1, error);
  }
}

function buildMessageDraftQualityContext(db, { profileId, job = {}, messageTexts = [] } = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("db is required");
  const profile = positiveInteger(profileId, "profileId");
  const memories = listCandidateAnswerMemories(db, { profileId: profile, activeOnly: false, limit: 500 });
  const recentTexts = memories
    .filter((memory) => ["copied", "sent"].includes(memory.completionKind))
    .slice(0, 20)
    .map((memory) => String(memory.finalText || "").trim())
    .filter(Boolean);
  const activeResume = db.prepare(`SELECT documents.resume_text
    FROM candidate_resume_versions versions
    JOIN resume_documents documents ON documents.id = versions.resume_document_id
    WHERE versions.profile_id = ? AND versions.is_active = 1
    ORDER BY versions.updated_at DESC, versions.id DESC LIMIT 1`).get(profile);
  const facts = listCandidateFacts(db, profile);
  const activeMemories = listCandidateAnswerMemories(db, {
    profileId: profile,
    activeOnly: true,
    source: "user_edited_reply",
    limit: 100
  });
  const evidenceTexts = [String(activeResume?.resume_text || "").trim()]
    .concat(facts.map(factEvidenceText))
    .concat(activeMemories
      .filter((memory) => memoryMatchesQualityContext(memory, job, messageTexts))
      .map((memory) => String(memory.finalText || "").trim()))
    .filter(Boolean);
  return { recentTexts, evidenceTexts };
}

function assessResult(result, recentTexts, evidenceTexts) {
  const messages = Array.isArray(result?.messages)
    ? result.messages.filter((message) => typeof message === "string" && message.trim())
    : [];
  if (!messages.length) {
    return {
      valid: false,
      sendable: false,
      errors: [{ code: "MESSAGE_DRAFT_EMPTY", kind: "empty", value: "" }],
      warnings: [],
      matchedOpening: ""
    };
  }
  const assessments = messages.map((text) => assessMessageDraftQuality({ text, recentTexts, evidenceTexts }));
  const errors = assessments.flatMap((assessment, messageIndex) => assessment.errors
    .map((error) => ({ ...error, messageIndex })));
  const warnings = uniqueWarnings(assessments.flatMap((assessment, messageIndex) => assessment.warnings
    .map((warning) => ({ ...warning, messageIndex }))));
  return {
    valid: errors.length === 0,
    sendable: errors.length === 0,
    errors,
    warnings,
    matchedOpening: assessments.map((assessment) => assessment.matchedOpening).find(Boolean) || ""
  };
}

function needsRevision(assessment) {
  return assessment.errors.length > 0 || assessment.warnings.length > 0;
}

function skippedAssessment() {
  return { valid: true, sendable: true, errors: [], warnings: [], matchedOpening: "", skipped: true };
}

function factEvidenceText(fact = {}) {
  const key = String(fact.factKey || fact.key || "").trim();
  const value = String(fact.factValue ?? fact.value ?? "").trim();
  if (!value) return "";
  const label = {
    expected_salary: "期望薪资",
    salary: "期望薪资",
    phone: "手机号",
    mobile: "手机号",
    email: "邮箱",
    availability_date: "到岗时间",
    overtime_acceptance: "加班安排",
    travel_acceptance: "出差安排",
    relocation_acceptance: "异地搬迁"
  }[key] || key;
  return label ? `${label}：${value}` : value;
}

function memoryMatchesQualityContext(memory, job, messageTexts) {
  const scope = memory?.scope && typeof memory.scope === "object" ? memory.scope : { kind: "global", key: "" };
  const key = String(scope.key || "").trim();
  if (scope.kind === "global") return true;
  if (scope.kind === "job") {
    return [job?.id, job?.sourceId].map((value) => String(value || "").trim()).filter(Boolean).includes(key);
  }
  if (scope.kind === "company") return scopeText(key) === scopeText(job?.company);
  if (scope.kind === "experience") {
    const texts = Array.isArray(messageTexts) ? messageTexts : [];
    return scopeText(texts.join(" ")).includes(scopeText(key));
  }
  return false;
}

function scopeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer`);
  return number;
}

function revisionInput(assessment) {
  return {
    reasonCodes: [...new Set([...assessment.errors, ...assessment.warnings].map((item) => item.code))],
    matchedOpening: String(assessment.matchedOpening || "").slice(0, 40),
    unsupportedClaims: assessment.errors
      .filter((item) => item.code === "MESSAGE_DRAFT_FACT_UNSUPPORTED")
      .slice(0, 4)
      .map(({ kind, value }) => ({ kind, value }))
  };
}

function checkedResult(result, assessment, attempts, revisionError = null) {
  return {
    result,
    assessment,
    attempts,
    sendable: assessment.errors.length === 0,
    ...(revisionError ? { revisionError } : {})
  };
}

function uniqueWarnings(warnings) {
  const seen = new Set();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.messageIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  generateQualityCheckedDraft,
  buildMessageDraftQualityContext,
  assessResult,
  revisionInput
};
