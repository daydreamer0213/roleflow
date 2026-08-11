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
const { fixtureLabelSource, loadLabelsFile, mergeLabels } = require("./lib/gate_d_labels");
const { buildShadowScorecard, SHADOW_SCORECARD_VERSION } = require("./lib/shadow_scorecard");

const REPORT_VERSION = "shadow-scorecard-report-v1";
const REPORT_SCHEMA_VERSION = "shadow-scorecard-report-v2";
const EVALUATION_NAME = "matrix-vs-guarded-scorecard";
const BASELINE_SAFETY_CODES = new Set([
  "unknown_core_requirements",
  "insufficient_role_alignment_evidence",
  "alignment_consistency_cap",
  "responsibility_safety_cap",
  "low_evidence_coverage"
]);

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
  const report = buildShadowReport(labels ? labels.fixture : fixture, {
    inputFixtureSha256,
    evaluatedGitCommit: evaluatedGitCommit(),
    labelSource: labels ? labels.labelSource : null
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
  const qualityRows = rows.filter((row) => !row.technicalBucket);
  const matrixTierCounts = tierCounts(rows, "productionMatrixTier");
  const candidateTierCounts = tierCounts(rows, "candidateTier");
  const comparableRows = qualityRows.filter((row) => typeof row.finalRecommendation === "string" && row.finalRecommendation.trim());
  const confirmedRows = qualityRows.filter((row) => isConfirmedLabel(row.humanLabel));
  const pendingRows = qualityRows.filter((row) => row.humanLabel && !isConfirmedLabel(row.humanLabel));
  const matrixVsGuardedScorecard = comparisonSummary(qualityRows);
  const hardBoundaryViolations = tierViolations(qualityRows, "verifiedHardBoundary", nonRejectedTiers());
  const severeRiskViolations = tierViolations(qualityRows, "verifiedSevereRisk", nonRejectedTiers());
  const guardedEvidenceSafetyViolations = qualityRows.filter((row) => (
    ["primary", "apply"].includes(row.candidateTier)
      && row.scorecard.evidenceCoverage.overall < DECISION_POLICY.minEvidenceCoverageForAutoSelect
  )).map((row) => ({
    id: row.id,
    tier: row.candidateTier,
    coverage: row.scorecard.evidenceCoverage.overall,
    minimumCoverage: DECISION_POLICY.minEvidenceCoverageForAutoSelect,
    finalReasons: row.scorecard.reasons.map((reason) => reason.code)
  }));
  const guardedProductionSafetyCeilingViolations = qualityRows.filter((row) => (
    row.baselineSafetyCeiling.codes.length > 0
      && higherRecommendationTier(row.candidateTier, row.baselineSafetyCeiling.candidateTier)
  )).map((row) => ({
    id: row.id,
    tier: row.candidateTier,
    baselineCandidateTier: row.baselineSafetyCeiling.candidateTier,
    baselineSafetyCodes: row.baselineSafetyCeiling.codes
  }));
  const fixedSalaryBoundaryEscapes = tierViolations(qualityRows, "fixedSalaryBoundary", nonRejectedTiers());
  return {
    version: REPORT_VERSION,
    schemaVersion: REPORT_SCHEMA_VERSION,
    evaluation: EVALUATION_NAME,
    sharedDecisionEngine: "deriveMatrixDecision",
    comparisonInterpretation: "matrix-vs-matrix-plus-guardrails residual",
    scorecardVersion: SHADOW_SCORECARD_VERSION,
    inputFixtureSha256: String(metadata.inputFixtureSha256 || ""),
    evaluatedGitCommit: String(metadata.evaluatedGitCommit || ""),
    labelSource: metadata.labelSource || fixtureLabelSource(fixture),
    policyVersion: String(policy.version),
    policyHash: decisionPolicyHash(policy),
    total: qualityRows.length,
    rawTotal: rows.length,
    qualityEligibleCaseCount: qualityRows.length,
    technicalBucketCounts: bucketCounts(rows),
    matrixTierCounts,
    candidateTierCounts,
    comparedFinalRecommendations: comparableRows.length,
    changedCandidateTierCount: comparableRows.filter((row) => row.candidateTier !== row.finalRecommendation).length,
    matrixVsGuardedScorecard,
    agreementRate: matrixVsGuardedScorecard.agreementRate,
    verifiedHardBoundaryViolations: hardBoundaryViolations,
    verifiedSevereRiskViolations: severeRiskViolations,
    guardedEvidenceSafetyViolations,
    guardedProductionSafetyCeilingViolations,
    baselineSafetyCeilings: qualityRows.map((row) => ({ id: row.id, ...row.baselineSafetyCeiling })),
    fixedSalaryBoundaryEscapes,
    matrixPreGuardRisk: {
      verifiedHardBoundaryViolations: hardBoundaryViolations.matrixPreGuardRisk,
      verifiedSevereRiskViolations: severeRiskViolations.matrixPreGuardRisk,
      fixedSalaryBoundaryEscapes: fixedSalaryBoundaryEscapes.matrixPreGuardRisk
    },
    explanationCoverage: explanationCoverage(qualityRows),
    evidenceCoverage: evidenceCoverage(qualityRows),
    confirmedLabelCount: confirmedRows.length,
    pendingLabelCount: pendingRows.length,
    unlabeledCount: qualityRows.length - confirmedRows.length - pendingRows.length,
    rankingUsefulness: rankingMetrics(confirmedRows),
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
    const technicalBucket = String(item?.technicalBucket || "").trim();
    if (technicalBucket) {
      return {
        id,
        technicalBucket,
        finalRecommendation: item.finalRecommendation ?? null,
        decisionBucket: item.decisionBucket ?? technicalBucket,
        defaultSelectedForBatch: item.defaultSelectedForBatch ?? null,
        humanLabel: normalizedHumanLabel(item.humanLabel),
        fixedSalaryBoundary: hasFixedSalaryBoundary(item),
        productionMatrixTier: null,
        candidateTier: null,
        baselineSafetyCeiling: null,
        verifiedHardBoundary: false,
        verifiedSevereRisk: false,
        evidenceBinding: null,
        explanationBinding: null,
        scorecard: null
      };
    }
    if (!item.input || typeof item.input !== "object" || Array.isArray(item.input)) {
      throw new Error(`case ${id} input must be a non-array object`);
    }
    const humanLabel = normalizedHumanLabel(item.humanLabel);
    const scorecard = buildShadowScorecard(item.input, policy);
    const baselineScorecard = buildShadowScorecard(item.input, DECISION_POLICY);
    const productionMatrixTier = scorecard.score.productionMatrixTier;
    return {
      id,
      technicalBucket: null,
      finalRecommendation: item.finalRecommendation ?? null,
      decisionBucket: item.decisionBucket ?? null,
      defaultSelectedForBatch: item.defaultSelectedForBatch ?? null,
      humanLabel,
      fixedSalaryBoundary: hasFixedSalaryBoundary(item),
      productionMatrixTier,
      candidateTier: scorecard.candidateTier,
      baselineSafetyCeiling: {
        candidateTier: baselineScorecard.candidateTier,
        codes: baselineScorecard.reasons
          .map((reason) => reason.code)
          .filter((code) => BASELINE_SAFETY_CODES.has(code))
      },
      verifiedHardBoundary: scorecard.hardBoundary.blocked,
      verifiedSevereRisk: scorecard.hardBoundary.severeRisk,
      evidenceBinding: evidenceBinding(item.input),
      explanationBinding: explanationBinding(item, item.input),
      scorecard
    };
  }).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function bucketCounts(rows) {
  const buckets = [...new Set(rows.map((row) => row.technicalBucket).filter(Boolean))].sort();
  return Object.fromEntries(buckets.map((bucket) => [
    bucket,
    rows.filter((row) => row.technicalBucket === bucket).length
  ]));
}

function normalizedHumanLabel(label) {
  if (!label || typeof label !== "object" || Array.isArray(label)) return null;
  const status = String(label.status || "").trim();
  const expectedTier = String(label.expectedTier || "").trim();
  if (status === "confirmed" && !RECOMMENDATION_TIERS.includes(expectedTier)) {
    throw new Error("confirmed human labels must define a canonical expectedTier");
  }
  return { status, expectedTier };
}

function hasFixedSalaryBoundary(item) {
  return item.fixedSalaryBoundary === true
    || item.input?.fixedSalaryBoundary === true
    || asItems(item.input?.boundaries).some((boundary) => boundary?.fixedSalaryBoundary === true);
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

function tierViolations(rows, field, eligibleTiers) {
  const result = { matrixPreGuardRisk: [], guardedScorecard: [] };
  for (const row of rows) {
    if (!row[field]) continue;
    if (eligibleTiers.has(row.productionMatrixTier)) {
      result.matrixPreGuardRisk.push({ id: row.id, tier: row.productionMatrixTier });
    }
    if (eligibleTiers.has(row.candidateTier)) {
      result.guardedScorecard.push({ id: row.id, tier: row.candidateTier });
    }
  }
  result.scorecard = result.guardedScorecard;
  return result;
}

function explanationCoverage(rows) {
  const requirements = aggregateExplanations(rows.map((row) => row.explanationBinding.requirements));
  const responsibilities = aggregateExplanations(rows.map((row) => row.explanationBinding.responsibilities));
  const hasExplicitExplanation = rows.some((row) => row.explanationBinding.hasExplicitExplanation);
  const overall = aggregateExplanations([requirements, responsibilities]);
  if (!hasExplicitExplanation || overall.eligible === 0) return unavailableCoverage(requirements, responsibilities, overall);
  return { status: "available", requirements, responsibilities, ...overall };
}

function evidenceCoverage(rows) {
  const requirements = aggregateBindings(rows.map((row) => row.evidenceBinding.requirements));
  const responsibilities = aggregateBindings(rows.map((row) => row.evidenceBinding.responsibilities));
  return { requirements, responsibilities, ...aggregateBindings([requirements, responsibilities]) };
}

function evidenceBinding(input) {
  return {
    requirements: bindingStats(asItems(input.requirementMatches)),
    responsibilities: bindingStats(asItems(input.responsibilityMatches))
  };
}

function explanationBinding(item, input) {
  const sourceTexts = explicitExplanationTexts(item, input);
  const matches = [...asItems(input.requirementMatches), ...asItems(input.responsibilityMatches)];
  return {
    hasExplicitExplanation: sourceTexts.length > 0 || matches.some((match) => hasText(match.explanation) || hasText(match.rationale)),
    requirements: explanationStats(asItems(input.requirementMatches), sourceTexts),
    responsibilities: explanationStats(asItems(input.responsibilityMatches), sourceTexts)
  };
}

function bindingStats(items, isBound = (item) => hasText(item.jdEvidence) && hasText(item.resumeEvidence)) {
  const eligible = items.filter(isEvaluableItem);
  const jdEvidenceBound = eligible.filter((item) => hasText(item.jdEvidence)).length;
  const resumeEvidenceBound = eligible.filter((item) => hasText(item.resumeEvidence)).length;
  const pairedEvidenceBound = eligible.filter(isBound).length;
  return {
    eligible: eligible.length,
    jdEvidenceBound,
    resumeEvidenceBound,
    pairedEvidenceBound,
    coverageRate: rate(pairedEvidenceBound, eligible.length)
  };
}

function aggregateBindings(items) {
  const totals = items.reduce((result, item) => ({
    eligible: result.eligible + item.eligible,
    jdEvidenceBound: result.jdEvidenceBound + item.jdEvidenceBound,
    resumeEvidenceBound: result.resumeEvidenceBound + item.resumeEvidenceBound,
    pairedEvidenceBound: result.pairedEvidenceBound + item.pairedEvidenceBound
  }), { eligible: 0, jdEvidenceBound: 0, resumeEvidenceBound: 0, pairedEvidenceBound: 0 });
  return { ...totals, coverageRate: rate(totals.pairedEvidenceBound, totals.eligible) };
}

function explanationStats(items, sourceTexts) {
  const eligible = items.filter(isEvaluableItem);
  const explained = eligible.filter((item) => itemExplanationBound(item, sourceTexts)).length;
  return { eligible: eligible.length, explained, coverageRate: rate(explained, eligible.length) };
}

function aggregateExplanations(items) {
  const totals = items.reduce((result, item) => ({
    eligible: result.eligible + item.eligible,
    explained: result.explained + item.explained
  }), { eligible: 0, explained: 0 });
  return { ...totals, coverageRate: rate(totals.explained, totals.eligible) };
}

function unavailableCoverage(requirements, responsibilities, overall) {
  const unavailable = (item) => ({ ...item, explained: null, coverageRate: null });
  return {
    status: "unavailable",
    requirements: unavailable(requirements),
    responsibilities: unavailable(responsibilities),
    ...unavailable(overall)
  };
}

function explicitExplanationTexts(item, input) {
  const values = [item.explanation, item.rationale, input.explanation, input.rationale];
  for (const key of ["fitReasons", "missingPoints", "blockingGaps", "hiddenRisks"]) {
    values.push(item[key], input[key]);
  }
  return values.flatMap(textValues).filter(hasText);
}

function textValues(value) {
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(textValues);
  return [String(value || "").trim()];
}

function itemExplanationBound(item, sourceTexts) {
  if (hasText(item.explanation) || hasText(item.rationale)) return true;
  const label = String(item.requirement || item.label || item.name || "").trim();
  return Boolean(label) && sourceTexts.some((text) => text.includes(label));
}

function isEvaluableItem(item) {
  return Boolean(item) && typeof item === "object" && !Array.isArray(item);
}

function hasText(value) {
  return Boolean(String(value || "").trim());
}

function nonRejectedTiers() {
  return new Set(RECOMMENDATION_TIERS.filter((tier) => tier !== "not_recommended"));
}

function higherRecommendationTier(candidateTier, baselineTier) {
  return RECOMMENDATION_TIERS.indexOf(candidateTier) < RECOMMENDATION_TIERS.indexOf(baselineTier);
}

function rankingMetrics(rows) {
  const k = Math.min(5, rows.length);
  if (rows.length < 2) return insufficientRanking(rows.length, k);
  const matrix = rankMetrics(rows, "productionMatrixTier", k);
  const guardedScorecard = rankMetrics(rows, "candidateTier", k);
  const matrixResult = rankingSide(matrix);
  const guardedResult = rankingSide(guardedScorecard);
  const availableCount = Number(matrixResult.status === "available") + Number(guardedResult.status === "available");
  return {
    status: availableCount === 2 ? "available" : availableCount === 1 ? "partial" : "insufficient_sample",
    confirmedLabelCount: rows.length,
    k,
    matrix: matrixResult,
    guardedScorecard: guardedResult,
    ndcgAtK: guardedResult.ndcgAtK,
    pairwiseConcordance: guardedResult.pairwiseConcordance
  };
}

function rankMetrics(rows, field, k) {
  const groups = new Map();
  for (const row of rows) {
    const value = tierValue(row[field]);
    const group = groups.get(value) || [];
    group.push(row);
    groups.set(value, group);
  }
  const dcg = [...groups.entries()]
    .sort(([left], [right]) => right - left)
    .reduce((total, [, group], groupIndex, entries) => total + tieAwareDiscountedGain(
      group,
      entries.slice(0, groupIndex).reduce((count, [, prior]) => count + prior.length, 0),
      k
    ), 0);
  const ideal = [...rows].sort((left, right) => tierValue(right.humanLabel.expectedTier) - tierValue(left.humanLabel.expectedTier));
  const idealDcg = discountedGain(ideal.slice(0, k));
  let concordant = 0;
  let comparablePairs = 0;
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      const expectedDifference = tierValue(rows[left].humanLabel.expectedTier) - tierValue(rows[right].humanLabel.expectedTier);
      if (expectedDifference === 0) continue;
      const observedDifference = tierValue(rows[left][field]) - tierValue(rows[right][field]);
      if (observedDifference === 0) continue;
      comparablePairs += 1;
      if (observedDifference !== 0 && Math.sign(observedDifference) === Math.sign(expectedDifference)) concordant += 1;
    }
  }
  return {
    ndcgAtK: idealDcg === 0 ? null : dcg / idealDcg,
    pairwiseConcordance: comparablePairs ? concordant / comparablePairs : null,
    comparablePairCount: comparablePairs
  };
}

function tieAwareDiscountedGain(group, offset, k) {
  const averageGain = group.reduce((total, row) => total + ((2 ** tierValue(row.humanLabel.expectedTier)) - 1), 0) / group.length;
  return group.reduce((total, _row, index) => {
    const rank = offset + index;
    return rank < k ? total + averageGain / Math.log2(rank + 2) : total;
  }, 0);
}

function rankingSide(metrics) {
  if (metrics.comparablePairCount > 0) return { status: "available", ...metrics };
  return {
    status: "insufficient_pairs",
    ndcgAtK: null,
    pairwiseConcordance: null,
    comparablePairCount: 0
  };
}

function insufficientRanking(confirmedLabelCount, k) {
  const unavailable = {
    status: "insufficient_sample",
    ndcgAtK: null,
    pairwiseConcordance: null,
    comparablePairCount: 0
  };
  return {
    status: "insufficient_sample",
    confirmedLabelCount,
    k,
    matrix: unavailable,
    guardedScorecard: unavailable,
    ndcgAtK: null,
    pairwiseConcordance: null
  };
}

function discountedGain(rows) {
  return rows.reduce((total, row, index) => total + ((2 ** tierValue(row.humanLabel.expectedTier)) - 1) / Math.log2(index + 2), 0);
}

function tierValue(tier) {
  return RECOMMENDATION_TIERS.length - RECOMMENDATION_TIERS.indexOf(tier);
}

function isConfirmedLabel(label) {
  return label?.status === "confirmed" && RECOMMENDATION_TIERS.includes(label.expectedTier);
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
  const leftStat = fs.statSync(leftRealPath, { bigint: true });
  const rightStat = fs.statSync(rightRealPath, { bigint: true });
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
    if (!["--input", "--output", "--labels"].includes(flag)) {
      throw new Error("usage: node scripts/compare-shadow-scorecard.js --input <fixture.json> --output <report.json> [--labels <labels.json>]");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (values[flag.slice(2)]) throw new Error(`duplicate ${flag} argument`);
    values[flag.slice(2)] = value;
    index += 1;
  }
  if (!values.input || !values.output) {
    throw new Error("usage: node scripts/compare-shadow-scorecard.js --input <fixture.json> --output <report.json> [--labels <labels.json>]");
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
