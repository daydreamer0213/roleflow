"use strict";

const { assessMessageDraftQuality } = require("../../core/message_draft_quality");

async function generateQualityCheckedDraft({ generate, input = {}, recentTexts = [], evidenceTexts = [] } = {}) {
  if (typeof generate !== "function") throw new TypeError("generate is required");
  const first = await generate(input);
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

module.exports = { generateQualityCheckedDraft, assessResult, revisionInput };
