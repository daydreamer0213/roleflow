const fs = require("fs");
const path = require("path");
const {
  DECISION_POLICY,
  assertDecisionPolicy,
  decisionPolicyHash
} = require("./../src/core/decision_policy");
const {
  buildShadowReport,
  evaluatedGitCommit,
  readFixture,
  sameFileIdentity
} = require("./compare-shadow-scorecard");
const { fixtureLabelSource, loadLabelsFile, mergeLabels } = require("./lib/gate_d_labels");

function main(argv = process.argv.slice(2)) {
  const { inputPath, outputPath, labelsPath } = parseArgs(argv);
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);
  if (sameFileIdentity(resolvedInput, resolvedOutput)) {
    throw new Error("input and output must refer to different files");
  }
  const { fixture, inputFixtureSha256 } = readFixture(resolvedInput);
  let labels = null;
  if (labelsPath) {
    const resolvedLabels = path.resolve(labelsPath);
    if (sameFileIdentity(resolvedLabels, resolvedInput) || sameFileIdentity(resolvedLabels, resolvedOutput)) {
      throw new Error("input, labels and output must refer to different files");
    }
    labels = mergeLabels(fixture, loadLabelsFile(resolvedLabels));
  }
  const baseFixture = labels ? labels.fixture : fixture;
  const metadata = {
    inputFixtureSha256,
    evaluatedGitCommit: evaluatedGitCommit(),
    labelSource: labels ? labels.labelSource : null
  };
  const variants = variantPolicies(baseFixture);
  const evaluatedVariants = variants.map((variant) => evaluateVariant(baseFixture, variant, metadata));
  const report = {
    version: "shadow-scorecard-variants-report-v1",
    evaluation: "matrix-vs-guarded-scorecard-variants",
    inputFixtureSha256,
    evaluatedGitCommit: metadata.evaluatedGitCommit,
    labelSource: metadata.labelSource || fixtureLabelSource(baseFixture),
    variantCount: variants.length,
    rawTotal: evaluatedVariants[0]?.rawTotal || 0,
    qualityEligibleCaseCount: evaluatedVariants[0]?.qualityEligibleCaseCount || 0,
    technicalBucketCounts: evaluatedVariants[0]?.technicalBucketCounts || {},
    variants: evaluatedVariants
  };
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function variantPolicies(fixture) {
  const explicit = fixture.variants === undefined ? [] : fixture.variants;
  if (!Array.isArray(explicit)) throw new Error("fixture variants must be an array");
  const variants = [{ id: "default", policy: fixture.policy || DECISION_POLICY }, ...explicit];
  const ids = new Set();
  return variants.map((variant) => {
    if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
      throw new Error("every variant must be an object");
    }
    const id = String(variant.id || "").trim();
    if (!id) throw new Error("every variant must have a non-empty id");
    if (ids.has(id)) throw new Error(`duplicate variant id: ${id}`);
    ids.add(id);
    assertDecisionPolicy(variant.policy);
    return { id, policy: variant.policy };
  });
}

function evaluateVariant(fixture, variant, metadata) {
  const comparison = buildShadowReport({ ...fixture, policy: variant.policy }, metadata);
  const rejectionReasons = [];
  addViolationReason(rejectionReasons, "verified_hard_boundary_guarded_scorecard", comparison.verifiedHardBoundaryViolations.guardedScorecard);
  addViolationReason(rejectionReasons, "verified_severe_risk_guarded_scorecard", comparison.verifiedSevereRiskViolations.guardedScorecard);
  addViolationReason(rejectionReasons, "below_production_evidence_floor_guarded_scorecard", comparison.guardedEvidenceSafetyViolations);
  addViolationReason(rejectionReasons, "guarded_production_safety_ceiling", comparison.guardedProductionSafetyCeilingViolations);
  const fixedSalaryEscapes = comparison.fixedSalaryBoundaryEscapes.guardedScorecard.map((violation) => ({
    id: violation.id,
    candidateTier: violation.tier
  }));
  addViolationReason(rejectionReasons, "fixed_salary_boundary_escape", fixedSalaryEscapes);
  return {
    id: variant.id,
    rawTotal: comparison.rawTotal,
    qualityEligibleCaseCount: comparison.qualityEligibleCaseCount,
    technicalBucketCounts: comparison.technicalBucketCounts,
    policyVersion: String(variant.policy.version),
    policyHash: decisionPolicyHash(variant.policy),
    tierDistribution: {
      matrix: comparison.matrixTierCounts,
      guardedScorecard: comparison.candidateTierCounts
    },
    confusion: comparison.matrixVsGuardedScorecard.confusion,
    agreementRate: comparison.agreementRate,
    explanationCoverage: comparison.explanationCoverage,
    evidenceCoverage: comparison.evidenceCoverage,
    confirmedLabelCount: comparison.confirmedLabelCount,
    pendingLabelCount: comparison.pendingLabelCount,
    rankingUsefulness: comparison.rankingUsefulness,
    matrixPreGuardRisk: comparison.matrixPreGuardRisk,
    rejected: rejectionReasons.length > 0,
    rejectionReasons
  };
}

function addViolationReason(reasons, code, violations) {
  if (violations.length) reasons.push({ code, caseIds: violations.map((violation) => violation.id) });
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--input", "--output", "--labels"].includes(flag)) {
      throw new Error("usage: node scripts/evaluate-shadow-variants.js --input <fixture.json> --output <report.json> [--labels <labels.json>]");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (values[flag.slice(2)]) throw new Error(`duplicate ${flag} argument`);
    values[flag.slice(2)] = value;
    index += 1;
  }
  if (!values.input || !values.output) {
    throw new Error("usage: node scripts/evaluate-shadow-variants.js --input <fixture.json> --output <report.json> [--labels <labels.json>]");
  }
  return { inputPath: values.input, outputPath: values.output, labelsPath: values.labels || null };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { evaluateVariant, main, parseArgs, variantPolicies };
