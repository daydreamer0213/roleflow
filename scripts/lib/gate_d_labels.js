const crypto = require("crypto");
const fs = require("fs");
const { RECOMMENDATION_TIERS } = require("../../src/core/decision_policy");

const LABELS_SCHEMA_VERSION = "gate-d-evaluation-labels-v2";
const HUMAN_LABEL_STATUSES = ["pending-human", "confirmed"];

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
  if (labels.schemaVersion !== LABELS_SCHEMA_VERSION) {
    throw new Error(`labels schemaVersion must be ${LABELS_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(labels.rows)) {
    throw new Error("labels must define a rows array");
  }
  const seen = new Set();
  for (const row of labels.rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("every labels row must be a non-array object");
    }
    const evaluationId = String(row.evaluationId || "").trim();
    if (!evaluationId) throw new Error("every labels row must have a non-empty evaluationId");
    if (seen.has(evaluationId)) throw new Error(`duplicate labels evaluationId: ${evaluationId}`);
    seen.add(evaluationId);
    const status = String(row.status || "").trim();
    if (!HUMAN_LABEL_STATUSES.includes(status)) {
      throw new Error(`labels status must be pending-human or confirmed (${evaluationId})`);
    }
    if (status === "confirmed") {
      const expectedTier = String(row.expectedTier || "").trim();
      if (!RECOMMENDATION_TIERS.includes(expectedTier)) {
        throw new Error(`confirmed labels must define a canonical expectedTier (${evaluationId})`);
      }
    }
  }
  return true;
}

function mergeLabels(fixture, labelsFile) {
  assertFixtureCases(fixture);
  const labelsByEvaluationId = new Map(labelsFile.rows.map((row) => [String(row.evaluationId).trim(), row]));
  const cases = fixture.cases.map((item) => {
    const evaluationId = String(item?.evaluationId || "").trim();
    if (!evaluationId) throw new Error(`fixture case ${item?.id || "<unknown>"} is missing evaluationId required by labels`);
    const row = labelsByEvaluationId.get(evaluationId);
    if (!row) throw new Error(`labels must cover every fixture case (missing evaluationId: ${evaluationId})`);
    return {
      ...item,
      humanLabel: {
        status: String(row.status).trim(),
        expectedTier: String(row.expectedTier || "").trim() || null
      }
    };
  });
  const fixtureEvaluationIds = new Set(cases.map((item) => String(item.evaluationId).trim()));
  for (const evaluationId of labelsByEvaluationId.keys()) {
    if (!fixtureEvaluationIds.has(evaluationId)) {
      throw new Error(`labels rows must correspond to fixture cases one-to-one (unknown evaluationId: ${evaluationId})`);
    }
  }
  return {
    fixture: { ...fixture, cases },
    labelSource: {
      source: "labels",
      sha256: labelsFile.sha256,
      schemaVersion: labelsFile.schemaVersion,
      rowCount: labelsFile.rows.length,
      confirmedCount: labelsFile.rows.filter((row) => String(row.status).trim() === "confirmed").length,
      pendingCount: labelsFile.rows.filter((row) => String(row.status).trim() === "pending-human").length
    }
  };
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
