const fs = require("node:fs");
const path = require("node:path");
const {
  DECISION_POLICY,
  RECOMMENDATION_TIERS,
  assertDecisionPolicy,
  decisionPolicyHash
} = require("../src/core/decision_policy");
const { fixtureLabelSource, loadLabelsFile, mergeLabels } = require("./lib/gate_d_labels");
const {
  SCALAR_SHADOW_POLICY,
  SCALAR_SHADOW_SCORECARD_VERSION,
  buildScalarShadowScorecard
} = require("./lib/scalar_shadow_scorecard");
const {
  evaluatedGitCommit,
  readFixture,
  sameFileIdentity
} = require("./compare-shadow-scorecard");

const REPORT_VERSION = "scalar-shadow-comparison-v1";
const EVALUATION_NAME = "matrix-vs-scalar-shadow";

function main(argv = process.argv.slice(2)) {
  const { inputPath, outputPath, labelsPath } = parseArgs(argv);
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);
  if (sameFileIdentity(resolvedInput, resolvedOutput)) {
    throw new Error("input and output must refer to different files");
  }
  const { fixture, inputFixtureSha256 } = readFixture(resolvedInput);
  let evaluatedFixture = fixture;
  let labelSource = null;
  if (labelsPath) {
    const resolvedLabels = path.resolve(labelsPath);
    if (sameFileIdentity(resolvedLabels, resolvedInput)
      || sameFileIdentity(resolvedLabels, resolvedOutput)) {
      throw new Error("input, labels and output must refer to different files");
    }
    const merged = mergeLabels(fixture, loadLabelsFile(resolvedLabels));
    evaluatedFixture = merged.fixture;
    labelSource = merged.labelSource;
  }
  const report = buildScalarShadowReport(evaluatedFixture, {
    inputFixtureSha256,
    evaluatedGitCommit: evaluatedGitCommit(),
    labelSource
  });
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function buildScalarShadowReport(fixture, metadata = {}) {
  assertFixture(fixture);
  const decisionPolicy = fixture.policy || DECISION_POLICY;
  assertDecisionPolicy(decisionPolicy);
  const rows = buildRows(fixture.cases, decisionPolicy);
  const qualityRows = rows.filter((row) => !row.technicalBucket);
  const changedRows = qualityRows.filter((row) => row.productionMatrixTier !== row.scalarCandidateTier);
  const hardBoundaryEscapes = qualityRows.filter((row) => (
    (row.verifiedHardBoundary || row.verifiedSevereRisk)
      && row.scalarCandidateTier !== "not_recommended"
  ));
  const confirmedRows = qualityRows.filter((row) => row.humanLabel?.status === "confirmed");
  return {
    version: REPORT_VERSION,
    evaluation: EVALUATION_NAME,
    productionInfluence: "none",
    inputFixtureSha256: String(metadata.inputFixtureSha256 || ""),
    evaluatedGitCommit: String(metadata.evaluatedGitCommit || ""),
    labelSource: metadata.labelSource || fixtureLabelSource(fixture),
    decisionPolicyVersion: String(decisionPolicy.version),
    decisionPolicyHash: decisionPolicyHash(decisionPolicy),
    scalarScorecardVersion: SCALAR_SHADOW_SCORECARD_VERSION,
    scalarPolicy: SCALAR_SHADOW_POLICY,
    rawTotal: rows.length,
    qualityEligibleCaseCount: qualityRows.length,
    technicalBucketCounts: bucketCounts(rows),
    matrixTierCounts: tierCounts(qualityRows, "productionMatrixTier"),
    scalarTierCounts: tierCounts(qualityRows, "scalarCandidateTier"),
    matrixVsScalar: comparisonSummary(qualityRows),
    changedTierCount: changedRows.length,
    changedRows: changedRows.map(changedRow),
    hardBoundaryEscapeCount: hardBoundaryEscapes.length,
    hardBoundaryEscapes: hardBoundaryEscapes.map((row) => ({
      id: row.id,
      scalarCandidateTier: row.scalarCandidateTier,
      verifiedHardBoundary: row.verifiedHardBoundary,
      verifiedSevereRisk: row.verifiedSevereRisk
    })),
    coverageBands: coverageBands(qualityRows, decisionPolicy),
    correctness: correctness(confirmedRows),
    stability: stability(qualityRows),
    rows
  };
}

function buildRows(cases, decisionPolicy) {
  const seen = new Set();
  return cases.map((item) => {
    const id = String(item?.id || "").trim();
    if (!id) throw new Error("every fixture case must have a non-empty id");
    if (seen.has(id)) throw new Error(`duplicate fixture case id: ${id}`);
    seen.add(id);
    const technicalBucket = String(item?.technicalBucket || "").trim();
    if (technicalBucket) {
      return {
        id,
        technicalBucket,
        repeatGroup: String(item?.repeatGroup || "").trim() || null,
        humanLabel: normalizeHumanLabel(item?.humanLabel),
        productionMatrixTier: null,
        scalarRawTier: null,
        scalarCandidateTier: null,
        scalarScore: null,
        responsibilityCoverage: null,
        requirementCoverage: null,
        guardrailCodes: [],
        verifiedHardBoundary: false,
        verifiedSevereRisk: false
      };
    }
    if (!item?.input || typeof item.input !== "object" || Array.isArray(item.input)) {
      throw new Error(`case ${id} input must be a non-array object`);
    }
    const scorecard = buildScalarShadowScorecard(item.input, decisionPolicy);
    return {
      id,
      technicalBucket: null,
      repeatGroup: String(item.repeatGroup || "").trim() || null,
      humanLabel: normalizeHumanLabel(item.humanLabel),
      productionMatrixTier: scorecard.productionMatrixTier,
      scalarRawTier: scorecard.rawTier,
      scalarCandidateTier: scorecard.candidateTier,
      scalarScore: scorecard.score.value,
      responsibilityScore: scorecard.score.responsibilities,
      requirementScore: scorecard.score.requirements,
      responsibilityCoverage: scorecard.evidenceCoverage.responsibilities,
      requirementCoverage: scorecard.evidenceCoverage.requirements,
      guardrailCodes: scorecard.guardrails.map((guardrail) => guardrail.code),
      verifiedHardBoundary: scorecard.hardBoundary.blocked,
      verifiedSevereRisk: scorecard.hardBoundary.severeRisk
    };
  });
}

function normalizeHumanLabel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = String(value.status || "").trim();
  const expectedTier = value.expectedTier == null ? null : String(value.expectedTier).trim();
  if (status === "confirmed" && !RECOMMENDATION_TIERS.includes(expectedTier)) {
    throw new Error("confirmed human labels must define a canonical expectedTier");
  }
  return { status, expectedTier };
}

function changedRow(row) {
  return {
    id: row.id,
    productionMatrixTier: row.productionMatrixTier,
    scalarRawTier: row.scalarRawTier,
    scalarCandidateTier: row.scalarCandidateTier,
    scalarScore: row.scalarScore,
    responsibilityCoverage: row.responsibilityCoverage,
    requirementCoverage: row.requirementCoverage,
    guardrailCodes: row.guardrailCodes
  };
}

function comparisonSummary(rows) {
  const confusion = Object.fromEntries(RECOMMENDATION_TIERS.map((matrixTier) => [
    matrixTier,
    Object.fromEntries(RECOMMENDATION_TIERS.map((scalarTier) => [scalarTier, 0]))
  ]));
  for (const row of rows) confusion[row.productionMatrixTier][row.scalarCandidateTier] += 1;
  const agreements = rows.filter((row) => row.productionMatrixTier === row.scalarCandidateTier).length;
  return {
    total: rows.length,
    agreements,
    agreementRate: rate(agreements, rows.length),
    confusion
  };
}

function correctness(rows) {
  if (!rows.length) {
    return {
      status: "insufficient_labels",
      confirmedLabelCount: 0,
      matrix: null,
      scalar: null
    };
  }
  const matrixMatches = rows.filter((row) => row.productionMatrixTier === row.humanLabel.expectedTier).length;
  const scalarMatches = rows.filter((row) => row.scalarCandidateTier === row.humanLabel.expectedTier).length;
  return {
    status: "available",
    confirmedLabelCount: rows.length,
    matrix: { matches: matrixMatches, rate: rate(matrixMatches, rows.length) },
    scalar: { matches: scalarMatches, rate: rate(scalarMatches, rows.length) }
  };
}

function stability(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!row.repeatGroup) continue;
    const group = grouped.get(row.repeatGroup) || [];
    group.push(row);
    grouped.set(row.repeatGroup, group);
  }
  const groups = [...grouped.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([repeatGroup, group]) => {
      const scores = group.map((row) => row.scalarScore).filter(Number.isFinite);
      return {
        repeatGroup,
        sampleCount: group.length,
        matrixTierCount: new Set(group.map((row) => row.productionMatrixTier)).size,
        scalarTierCount: new Set(group.map((row) => row.scalarCandidateTier)).size,
        scalarScoreRange: scores.length ? rounded(Math.max(...scores) - Math.min(...scores)) : null
      };
    })
    .sort((left, right) => left.repeatGroup.localeCompare(right.repeatGroup));
  if (!groups.length) {
    return {
      status: "insufficient_repeats",
      repeatGroupCount: 0,
      matrix: null,
      scalar: null,
      groups: []
    };
  }
  const matrixVariable = groups.filter((group) => group.matrixTierCount > 1).length;
  const scalarVariable = groups.filter((group) => group.scalarTierCount > 1).length;
  return {
    status: "available",
    repeatGroupCount: groups.length,
    matrix: { variableGroupCount: matrixVariable, variationRate: rate(matrixVariable, groups.length) },
    scalar: { variableGroupCount: scalarVariable, variationRate: rate(scalarVariable, groups.length) },
    groups
  };
}

function coverageBands(rows, decisionPolicy) {
  return {
    responsibilities: bandCounts(
      rows.map((row) => row.responsibilityCoverage),
      decisionPolicy.responsibilityAlignment.minimumKnownCoverage
    ),
    requirements: bandCounts(
      rows.map((row) => row.requirementCoverage),
      decisionPolicy.minEvidenceCoverageForAutoSelect
    )
  };
}

function bandCounts(values, minimum) {
  return {
    belowMinimum: values.filter((value) => Number.isFinite(value) && value < minimum).length,
    atOrAboveMinimum: values.filter((value) => Number.isFinite(value) && value >= minimum).length,
    unavailable: values.filter((value) => !Number.isFinite(value)).length,
    minimum
  };
}

function tierCounts(rows, field) {
  return Object.fromEntries(RECOMMENDATION_TIERS.map((tier) => [
    tier,
    rows.filter((row) => row[field] === tier).length
  ]));
}

function bucketCounts(rows) {
  const buckets = [...new Set(rows.map((row) => row.technicalBucket).filter(Boolean))].sort();
  return Object.fromEntries(buckets.map((bucket) => [
    bucket,
    rows.filter((row) => row.technicalBucket === bucket).length
  ]));
}

function assertFixture(fixture) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)
    || !Array.isArray(fixture.cases)) {
    throw new Error("fixture must be an object with a cases array");
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--input", "--output", "--labels"].includes(flag)) {
      throw new Error("usage: node scripts/compare-scalar-shadow.js --input <fixture.json> --output <report.json> [--labels <labels.json>]");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (values[flag.slice(2)]) throw new Error(`duplicate ${flag} argument`);
    values[flag.slice(2)] = value;
    index += 1;
  }
  if (!values.input || !values.output) {
    throw new Error("usage: node scripts/compare-scalar-shadow.js --input <fixture.json> --output <report.json> [--labels <labels.json>]");
  }
  return { inputPath: values.input, outputPath: values.output, labelsPath: values.labels || null };
}

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function rounded(value) {
  return Math.round(value * 1e12) / 1e12;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  EVALUATION_NAME,
  REPORT_VERSION,
  buildScalarShadowReport,
  main,
  parseArgs
};
