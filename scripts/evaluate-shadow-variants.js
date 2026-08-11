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

function main(argv = process.argv.slice(2)) {
  const { inputPath, outputPath } = parseArgs(argv);
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);
  if (sameFileIdentity(resolvedInput, resolvedOutput)) {
    throw new Error("input and output must refer to different files");
  }
  const { fixture, inputFixtureSha256 } = readFixture(resolvedInput);
  const metadata = { inputFixtureSha256, evaluatedGitCommit: evaluatedGitCommit() };
  const variants = variantPolicies(fixture);
  const report = {
    version: "shadow-scorecard-variants-report-v1",
    evaluation: "matrix-vs-guarded-scorecard-variants",
    inputFixtureSha256,
    evaluatedGitCommit: metadata.evaluatedGitCommit,
    variantCount: variants.length,
    variants: variants.map((variant) => evaluateVariant(fixture, variant, metadata))
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
  addViolationReason(rejectionReasons, "missing_bound_evidence_guarded_scorecard", comparison.independentEvidenceViolations.guardedScorecard);
  const fixedSalaryEscapes = comparison.fixedSalaryBoundaryEscapes.guardedScorecard.map((violation) => ({
    id: violation.id,
    candidateTier: violation.tier
  }));
  addViolationReason(rejectionReasons, "fixed_salary_boundary_escape", fixedSalaryEscapes);
  return {
    id: variant.id,
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
    if (flag !== "--input" && flag !== "--output") {
      throw new Error("usage: node scripts/evaluate-shadow-variants.js --input <fixture.json> --output <report.json>");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (values[flag.slice(2)]) throw new Error(`duplicate ${flag} argument`);
    values[flag.slice(2)] = value;
    index += 1;
  }
  if (!values.input || !values.output) {
    throw new Error("usage: node scripts/evaluate-shadow-variants.js --input <fixture.json> --output <report.json>");
  }
  return { inputPath: values.input, outputPath: values.output };
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
