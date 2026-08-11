const crypto = require("crypto");
const fs = require("fs");
const { RECOMMENDATION_TIERS } = require("../../src/core/decision_policy");

const LABELS_SCHEMA_VERSION = "gate-d-evaluation-labels-v2";
const HUMAN_LABEL_STATUSES = ["pending-human", "confirmed"];
const LABELS_FIELDS = ["schemaVersion", "confirmedMetrics", "rows"];
const LABEL_ROW_FIELDS = [
  "evaluationId",
  "status",
  "directionFit",
  "hardBoundaryPass",
  "expectedTier",
  "evidenceSufficiency",
  "rationale",
  "labeler",
  "labeledAt",
  "aiProvisional"
];
const AI_PROVISIONAL_FIELDS = ["productionMatrixTier", "guardedTier"];

function loadLabelsFile(labelsPath) {
  const bytes = fs.readFileSync(labelsPath);
  const labels = JSON.parse(bytes.toString("utf8"));
  assertLabelsSchema(labels);
  return {
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    schemaVersion: labels.schemaVersion,
    rows: labels.rows
  };
}

function assertLabelsSchema(labels) {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    throw new Error("labels must be a non-array object");
  }
  assertExactFields(labels, LABELS_FIELDS, "labels");
  if (labels.schemaVersion !== LABELS_SCHEMA_VERSION) {
    throw new Error(`labels schemaVersion must be ${LABELS_SCHEMA_VERSION}`);
  }
  if (typeof labels.confirmedMetrics !== "string") {
    throw new Error("labels confirmedMetrics must be a string");
  }
  if (!Array.isArray(labels.rows)) {
    throw new Error("labels must define a rows array");
  }
  const seen = new Set();
  for (const row of labels.rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("every labels row must be a non-array object");
    }
    assertExactFields(row, LABEL_ROW_FIELDS, "labels row");
    if (typeof row.evaluationId !== "string" || !row.evaluationId.trim()) {
      throw new Error("every labels row evaluationId must be a non-empty string");
    }
    const evaluationId = row.evaluationId;
    if (seen.has(evaluationId)) throw new Error(`duplicate labels evaluationId: ${evaluationId}`);
    seen.add(evaluationId);
    if (typeof row.status !== "string") {
      throw new Error(`labels status must be a string (${evaluationId})`);
    }
    const status = row.status;
    if (!HUMAN_LABEL_STATUSES.includes(status)) {
      throw new Error(`labels status must be pending-human or confirmed (${evaluationId})`);
    }
    assertNullableBoolean(row.directionFit, "directionFit", evaluationId);
    assertNullableBoolean(row.hardBoundaryPass, "hardBoundaryPass", evaluationId);
    assertNullableBoolean(row.evidenceSufficiency, "evidenceSufficiency", evaluationId);
    if (status === "confirmed") {
      if (typeof row.expectedTier !== "string" || !RECOMMENDATION_TIERS.includes(row.expectedTier)) {
        throw new Error(`confirmed labels must define a canonical expectedTier (${evaluationId})`);
      }
    } else if (row.expectedTier !== null) {
      throw new Error(`pending-human expectedTier must be null (${evaluationId})`);
    }
    if (typeof row.rationale !== "string") throw new Error(`labels rationale must be a string (${evaluationId})`);
    if (typeof row.labeler !== "string") throw new Error(`labels labeler must be a string (${evaluationId})`);
    if (row.labeledAt !== null && typeof row.labeledAt !== "string") {
      throw new Error(`labels labeledAt must be a string or null (${evaluationId})`);
    }
    assertAiProvisional(row.aiProvisional, evaluationId);
  }
  return true;
}

function mergeLabels(fixture, labelsFile) {
  assertFixtureCases(fixture);
  const fixtureEvaluationIds = new Set();
  for (const item of fixture.cases) {
    if (typeof item?.evaluationId !== "string" || !item.evaluationId.trim()) {
      throw new Error(`fixture case ${item?.id || "<unknown>"} is missing evaluationId required by labels`);
    }
    if (fixtureEvaluationIds.has(item.evaluationId)) {
      throw new Error(`duplicate fixture evaluationId: ${item.evaluationId}`);
    }
    fixtureEvaluationIds.add(item.evaluationId);
  }
  const fixtureCaseCount = fixture.cases.length;
  const uniqueFixtureEvaluationIdCount = fixtureEvaluationIds.size;
  const labelsRowCount = labelsFile.rows.length;
  if (fixtureCaseCount !== uniqueFixtureEvaluationIdCount || fixtureCaseCount !== labelsRowCount) {
    throw new Error(
      `fixture cases count (${fixtureCaseCount}), unique fixture evaluationId count (${uniqueFixtureEvaluationIdCount}), and labels rows count (${labelsRowCount}) must be equal`
    );
  }
  const labelsByEvaluationId = new Map(labelsFile.rows.map((row) => [row.evaluationId, row]));
  for (const evaluationId of labelsByEvaluationId.keys()) {
    if (!fixtureEvaluationIds.has(evaluationId)) {
      throw new Error(`labels rows must correspond to fixture cases one-to-one (unknown evaluationId: ${evaluationId})`);
    }
  }
  const cases = fixture.cases.map((item) => {
    const evaluationId = item.evaluationId;
    const row = labelsByEvaluationId.get(evaluationId);
    if (!row) throw new Error(`labels must cover every fixture case (missing evaluationId: ${evaluationId})`);
    return {
      ...item,
      humanLabel: {
        status: row.status,
        expectedTier: row.expectedTier
      }
    };
  });
  return {
    fixture: { ...fixture, cases },
    labelSource: {
      source: "labels",
      sha256: labelsFile.sha256,
      schemaVersion: labelsFile.schemaVersion,
      rowCount: labelsFile.rows.length,
      confirmedCount: labelsFile.rows.filter((row) => row.status === "confirmed").length,
      pendingCount: labelsFile.rows.filter((row) => row.status === "pending-human").length
    }
  };
}

function assertExactFields(value, expected, label) {
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  if (unknown.length) throw new Error(`unknown ${label} field: ${unknown[0]}`);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) {
    throw new Error(`${label} fields must match the v2 contract (missing: ${missing.join(", ")})`);
  }
}

function assertNullableBoolean(value, field, evaluationId) {
  if (value !== null && typeof value !== "boolean") {
    throw new Error(`labels ${field} must be boolean or null (${evaluationId})`);
  }
}

function assertAiProvisional(value, evaluationId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`labels aiProvisional must be a non-array object (${evaluationId})`);
  }
  assertExactFields(value, AI_PROVISIONAL_FIELDS, "aiProvisional");
  for (const field of AI_PROVISIONAL_FIELDS) {
    if (value[field] !== null && (typeof value[field] !== "string" || !RECOMMENDATION_TIERS.includes(value[field]))) {
      throw new Error(`aiProvisional ${field} must be a canonical tier or null (${evaluationId})`);
    }
  }
}

function fixtureLabelSource(fixture) {
  const cases = fixture?.cases || [];
  return {
    source: "fixture",
    sha256: null,
    schemaVersion: null,
    rowCount: null,
    confirmedCount: cases.filter((item) => item?.humanLabel?.status === "confirmed").length,
    pendingCount: cases.filter((item) => item?.humanLabel && item.humanLabel.status !== "confirmed").length
  };
}

function assertFixtureCases(fixture) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture) || !Array.isArray(fixture.cases)) {
    throw new Error("fixture must be an object with a cases array");
  }
}

module.exports = {
  fixtureLabelSource,
  loadLabelsFile,
  mergeLabels
};
