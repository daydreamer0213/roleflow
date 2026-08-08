"use strict";

const MIN_COMPLETE_JOB_DESCRIPTION_LENGTH = 120;
const DETAIL_UNVERIFIED_TAG = "detail_unverified";

function hasCompleteJobDescription(job = {}) {
  const description = String(job.description || "").trim();
  const qualityTags = normalizedQualityTags(job);
  if (!qualityTags) return false;
  return description.length >= MIN_COMPLETE_JOB_DESCRIPTION_LENGTH
    && !qualityTags.includes(DETAIL_UNVERIFIED_TAG);
}

function normalizedQualityTags(job) {
  if (job.qualityTags !== undefined) {
    if (job.qualityTags === null) return [];
    return Array.isArray(job.qualityTags) ? job.qualityTags : null;
  }
  if (job.quality_tags_json === undefined || job.quality_tags_json === null) return [];
  if (Array.isArray(job.quality_tags_json)) return job.quality_tags_json;
  if (typeof job.quality_tags_json !== "string") return null;
  try {
    const parsed = JSON.parse(job.quality_tags_json);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = {
  MIN_COMPLETE_JOB_DESCRIPTION_LENGTH,
  DETAIL_UNVERIFIED_TAG,
  hasCompleteJobDescription
};
