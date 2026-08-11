const crypto = require("crypto");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  DECISION_POLICY,
  RECOMMENDATION_TIERS,
  assertDecisionPolicy,
  decisionPolicyHash
} = require("./../src/core/decision_policy");
const { buildShadowScorecard, SHADOW_SCORECARD_VERSION } = require("./lib/shadow_scorecard");

const REPORT_VERSION = "shadow-scorecard-report-v1";
const REPORT_SCHEMA_VERSION = "shadow-scorecard-report-v2";
const EVALUATION_NAME = "matrix-vs-guarded-scorecard";

function main(argv = process.argv.slice(2)) {
  const { inputPath, outputPath } = parseArgs(argv);
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);
  if (sameFileIdentity(resolvedInput, resolvedOutput)) {
    throw new Error("input and output must refer to different files");
  }
  const { fixture, inputFixtureSha256 } = readFixture(resolvedInput);
  const report = buildShadowReport(fixture, {
    inputFixtureSha256,
    evaluatedGitCommit: evaluatedGitCommit()
  });
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function readFixture(inputPath) {
  const bytes = fs.readFileSync(inputPath);
  const fixture = JSON.parse(bytes.toString("utf8"));
  assertFixture(fixture);
  return {
    fixture,
    inputFixtureSha256: crypto.createHash("sha256").update(bytes).digest("hex")
  };
}

function buildShadowReport(fixture, metadata = {}) {
  assertFixture(fixture);
  const policy = fixture.policy || DECISION_POLICY;
  assertDecisionPolicy(policy);
  const rows = buildRows(fixture.cases, policy);
  const matrixTierCounts = tierCounts(rows, "productionMatrixTier");
  const candidateTierCounts = tierCounts(rows, "candidateTier");
  const comparableRows = rows.filter((row) => typeof row.finalRecommendation === "string" && row.finalRecommendation.trim());
  const confirmedRows = rows.filter((row) => isConfirmedLabel(row.humanLabel));
  const pendingRows = rows.filter((row) => row.humanLabel && !isConfirmedLabel(row.humanLabel));
  const matrixVsGuardedScorecard = comparisonSummary(rows);
  const rankingUsefulness = confirmedRows.length ? rankingMetrics(confirmedRows) : null;
  return {
    version: REPORT_VERSION,
    schemaVersion: REPORT_SCHEMA_VERSION,
    evaluation: EVALUATION_NAME,
    scorecardVersion: SHADOW_SCORECARD_VERSION,
    inputFixtureSha256: String(metadata.inputFixtureSha256 || ""),
    evaluatedGitCommit: String(metadata.evaluatedGitCommit || ""),
    policyVersion: String(policy.version),
    policyHash: decisionPolicyHash(policy),
    total: rows.length,
    matrixTierCounts,
    candidateTierCounts,
    comparedFinalRecommendations: comparableRows.length,
    changedCandidateTierCount: comparableRows.filter((row) => row.candidateTier !== row.finalRecommendation).length,
    matrixVsGuardedScorecard,
    agreementRate: matrixVsGuardedScorecard.agreementRate,
    verifiedHardBoundaryViolations: tierViolations(rows, "verifiedHardBoundary"),
    independentEvidenceViolations: tierViolations(rows, "missingIndependentEvidence"),
    explanationCoverage: explanationCoverage(rows),
    evidenceCoverage: evidenceCoverage(rows),
    confirmedLabelCount: confirmedRows.length,
    pendingLabelCount: pendingRows.length,
    unlabeledCount: rows.length - confirmedRows.length - pendingRows.length,
    rankingUsefulness,
    rows
  };
}

function assertFixture(fixture) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture) || !Array.isArray(fixture.cases)) {
    throw new Error("fixture must be an object with a cases array");
  }
}

function buildRows(cases, policy) {
  const seen = new Set();
  return cases.map((item) => {
    const id = String(item?.id || "").trim();
    if (!id) throw new Error("every fixture case must have a non-empty id");
    if (seen.has(id)) throw new Error(`duplicate fixture case id: ${id}`);
    seen.add(id);
    if (!item.input || typeof item.input !== "object" || Array.isArray(item.input)) {
      throw new Error(`case ${id} input must be a non-array object`);
    }
    const scorecard = buildShadowScorecard(item.input, policy);
    const productionMatrixTier = scorecard.score.productionMatrixTier;
    const independentEvidence = hasIndependentEvidence(item.input);
    return {
      id,
      finalRecommendation: item.finalRecommendation ?? null,
      decisionBucket: item.decisionBucket ?? null,
      defaultSelectedForBatch: item.defaultSelectedForBatch ?? null,
      humanLabel: normalizedHumanLabel(item.humanLabel),
      fixedSalaryBoundary: hasFixedSalaryBoundary(item),
      productionMatrixTier,
      candidateTier: scorecard.candidateTier,
      verifiedHardBoundary: scorecard.hardBoundary.blocked || scorecard.hardBoundary.severeRisk,
      missingIndependentEvidence: !independentEvidence,
      scorecard
    };
  }).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function normalizedHumanLabel(label) {
  if (!label || typeof label !== "object" || Array.isArray(label)) return null;
  const status = String(label.status || "").trim();
  const expectedTier = String(label.expectedTier || "").trim();
  return { status, expectedTier };
}

function hasFixedSalaryBoundary(item) {
  return item.fixedSalaryBoundary === true
    || item.input?.fixedSalaryBoundary === true
    || asItems(item.input?.boundaries).some((boundary) => boundary?.fixedSalaryBoundary === true);
}

function hasIndependentEvidence(input) {
  return [
    ...asItems(input.requirementMatches),
    ...asItems(input.responsibilityMatches)
  ].some((item) => {
    const jdEvidence = String(item?.jdEvidence || "").trim();
    const resumeEvidence = String(item?.resumeEvidence || "").trim();
    return Boolean(jdEvidence) && Boolean(resumeEvidence) && jdEvidence !== resumeEvidence;
  });
}

function asItems(value) {
  return Array.isArray(value) ? value : [];
}

function tierCounts(rows, field) {
  return Object.fromEntries(RECOMMENDATION_TIERS.map((tier) => [
    tier,
    rows.filter((row) => row[field] === tier).length
  ]));
}

function comparisonSummary(rows) {
  const confusion = Object.fromEntries(RECOMMENDATION_TIERS.map((matrixTier) => [
    matrixTier,
    Object.fromEntries(RECOMMENDATION_TIERS.map((scorecardTier) => [scorecardTier, 0]))
  ]));
  for (const row of rows) confusion[row.productionMatrixTier][row.candidateTier] += 1;
  const agreements = rows.filter((row) => row.productionMatrixTier === row.candidateTier).length;
  return {
    tiers: RECOMMENDATION_TIERS,
    total: rows.length,
    agreements,
    agreementRate: rate(agreements, rows.length),
    confusion
  };
}

function tierViolations(rows, field) {
  const result = { matrix: [], guardedScorecard: [] };
  const eligibleTiers = field === "missingIndependentEvidence"
    ? new Set(["primary", "apply"])
    : new Set(RECOMMENDATION_TIERS.filter((tier) => tier !== "not_recommended"));
  for (const row of rows) {
    if (!row[field]) continue;
    if (eligibleTiers.has(row.productionMatrixTier)) {
      result.matrix.push({ id: row.id, tier: row.productionMatrixTier });
    }
    if (eligibleTiers.has(row.candidateTier)) {
      result.guardedScorecard.push({ id: row.id, tier: row.candidateTier });
    }
  }
  result.scorecard = result.guardedScorecard;
  return result;
}

function explanationCoverage(rows) {
  return {
    matrix: coverage(rows, (row) => Boolean(row.scorecard.score.fitBand && row.scorecard.score.effectiveRoleAlignment)),
    guardedScorecard: coverage(rows, (row) => row.scorecard.reasons.length > 0)
  };
}

function evidenceCoverage(rows) {
  const matrix = coverage(rows, (row) => row.scorecard.score.weightedFit !== null);
  const guardedScorecard = coverage(rows, (row) => row.scorecard.evidenceCoverage.overall >= 0);
  return {
    matrix: { ...matrix, mean: mean(rows.map((row) => row.scorecard.evidenceCoverage.overall)) },
    guardedScorecard: { ...guardedScorecard, mean: mean(rows.map((row) => row.scorecard.evidenceCoverage.overall)) }
  };
}

function coverage(rows, predicate) {
  const covered = rows.filter(predicate).length;
  return { covered, total: rows.length, rate: rate(covered, rows.length) };
}

function rankingMetrics(rows) {
  const k = Math.min(5, rows.length);
  const matrix = rankMetrics(rows, "productionMatrixTier", k);
  const guardedScorecard = rankMetrics(rows, "candidateTier", k);
  return {
    confirmedLabelCount: rows.length,
    k,
    matrix,
    guardedScorecard,
    ndcgAtK: guardedScorecard.ndcgAtK,
    pairwiseConcordance: guardedScorecard.pairwiseConcordance
  };
}

function rankMetrics(rows, field, k) {
  const sorted = [...rows].sort((left, right) => tierValue(right[field]) - tierValue(left[field]) || compareIds(left, right));
  const ideal = [...rows].sort((left, right) => tierValue(right.humanLabel.expectedTier) - tierValue(left.humanLabel.expectedTier) || compareIds(left, right));
  const dcg = discountedGain(sorted.slice(0, k));
  const idealDcg = discountedGain(ideal.slice(0, k));
  let concordant = 0;
  let comparablePairs = 0;
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      const expectedDifference = tierValue(rows[left].humanLabel.expectedTier) - tierValue(rows[right].humanLabel.expectedTier);
      if (expectedDifference === 0) continue;
      comparablePairs += 1;
      const observedDifference = tierValue(rows[left][field]) - tierValue(rows[right][field]);
      if (observedDifference !== 0 && Math.sign(observedDifference) === Math.sign(expectedDifference)) concordant += 1;
    }
  }
  return {
    ndcgAtK: idealDcg === 0 ? null : dcg / idealDcg,
    pairwiseConcordance: comparablePairs ? concordant / comparablePairs : null,
    comparablePairCount: comparablePairs
  };
}

function discountedGain(rows) {
  return rows.reduce((total, row, index) => total + ((2 ** tierValue(row.humanLabel.expectedTier)) - 1) / Math.log2(index + 2), 0);
}

function tierValue(tier) {
  return RECOMMENDATION_TIERS.length - RECOMMENDATION_TIERS.indexOf(tier);
}

function compareIds(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function isConfirmedLabel(label) {
  return label?.status === "confirmed" && RECOMMENDATION_TIERS.includes(label.expectedTier);
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + Number(value || 0), 0) / values.length : 0;
}

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function evaluatedGitCommit() {
  return childProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8"
  }).trim();
}

function sameFileIdentity(leftPath, rightPath) {
  if (samePlatformPath(leftPath, rightPath)) return true;
  if (!fs.existsSync(leftPath) || !fs.existsSync(rightPath)) return false;
  const leftRealPath = fs.realpathSync.native(leftPath);
  const rightRealPath = fs.realpathSync.native(rightPath);
  if (samePlatformPath(leftRealPath, rightRealPath)) return true;
  const leftStat = fs.statSync(leftRealPath);
  const rightStat = fs.statSync(rightRealPath);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

function samePlatformPath(leftPath, rightPath) {
  const left = path.normalize(leftPath);
  const right = path.normalize(rightPath);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--input" && flag !== "--output") throw new Error("usage: node scripts/compare-shadow-scorecard.js --input <fixture.json> --output <report.json>");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (values[flag.slice(2)]) throw new Error(`duplicate ${flag} argument`);
    values[flag.slice(2)] = value;
    index += 1;
  }
  if (!values.input || !values.output) throw new Error("usage: node scripts/compare-shadow-scorecard.js --input <fixture.json> --output <report.json>");
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

module.exports = {
  EVALUATION_NAME,
  REPORT_VERSION,
  REPORT_SCHEMA_VERSION,
  buildShadowReport,
  evaluatedGitCommit,
  main,
  parseArgs,
  readFixture,
  sameFileIdentity
};
