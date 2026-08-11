const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  DECISION_POLICY,
  decisionPolicyHash
} = require("../src/core/decision_policy");
const { deriveMatrixDecision } = require("../src/core/four_tier_decision");
const { main: compareShadowScorecard } = require("../scripts/compare-shadow-scorecard");
const { buildShadowScorecard } = require("../scripts/lib/shadow_scorecard");

function baseInput() {
  return {
    roleAlignment: "aligned",
    responsibilityMatches: [
      { state: "matched", jdEvidence: "职责证据一", resumeEvidence: "经历证据一" },
      { state: "transferable", jdEvidence: "职责证据二", resumeEvidence: "经历证据二" }
    ],
    requirementMatches: [
      { state: "matched", foundation: true, requirement: "核心要求一" },
      { state: "transferable", central: true, requirement: "核心要求二" },
      { state: "matched", requirement: "支持要求一" }
    ],
    boundaries: [],
    risks: []
  };
}

function fullyBoundInput({ sameEvidence = false, explanation = false } = {}) {
  const input = baseInput();
  input.requirementMatches = input.requirementMatches.map((item, index) => ({
    ...item,
    jdEvidence: sameEvidence ? `shared requirement evidence ${index}` : `JD requirement ${index}`,
    resumeEvidence: sameEvidence ? `shared requirement evidence ${index}` : `resume requirement ${index}`,
    ...(explanation ? { rationale: `requirement rationale ${index}` } : {})
  }));
  input.responsibilityMatches = input.responsibilityMatches.map((item, index) => ({
    ...item,
    jdEvidence: sameEvidence ? `shared responsibility evidence ${index}` : `JD responsibility ${index}`,
    resumeEvidence: sameEvidence ? `shared responsibility evidence ${index}` : `resume responsibility ${index}`,
    ...(explanation ? { explanation: `responsibility explanation ${index}` } : {})
  }));
  return input;
}

function applyTierInput() {
  return {
    roleAlignment: "partially_aligned",
    responsibilityMatches: [
      { state: "transferable", jdEvidence: "JD duty 1", resumeEvidence: "resume duty 1" },
      { state: "transferable", jdEvidence: "JD duty 2", resumeEvidence: "resume duty 2" },
      { state: "transferable", jdEvidence: "JD duty 3", resumeEvidence: "resume duty 3" }
    ],
    requirementMatches: [
      { state: "missing", central: true, requirement: "core", jdEvidence: "JD core", resumeEvidence: "resume core" },
      { state: "transferable", requirement: "support", jdEvidence: "JD support", resumeEvidence: "resume support" }
    ],
    boundaries: [],
    risks: []
  };
}

const stableInput = baseInput();
const before = JSON.parse(JSON.stringify(stableInput));
const first = buildShadowScorecard(stableInput, DECISION_POLICY);
const second = buildShadowScorecard(stableInput, DECISION_POLICY);

assert.deepStrictEqual(first, second, "identical semantic input must produce a deterministic scorecard");
assert.deepStrictEqual(stableInput, before, "scorecard construction must not mutate semantic input");
assert.strictEqual(first.version, "shadow-scorecard-v1");
assert.strictEqual(first.candidateTier, "primary");
assert.strictEqual(first.score.policyVersion, DECISION_POLICY.version);
assert.strictEqual(first.score.policyHash, decisionPolicyHash(DECISION_POLICY));

const hardBoundary = buildShadowScorecard({
  ...baseInput(),
  boundaries: [{ verified: true, blocked: true, reason: "明确不兼容边界" }]
}, DECISION_POLICY);
assert.strictEqual(hardBoundary.score.weightedFit, 0.825);
assert.strictEqual(hardBoundary.hardBoundary.blocked, true);
assert.strictEqual(hardBoundary.candidateTier, "not_recommended",
  "a verified hard boundary must not be compensated by a high score");

const lowCoverage = buildShadowScorecard({
  ...baseInput(),
  requirementMatches: [
    { state: "unknown", foundation: true, requirement: "未核实核心要求" },
    { state: "matched", requirement: "已核实支持要求" }
  ]
}, DECISION_POLICY);
assert.strictEqual(lowCoverage.score.weightedFit, 1);
assert(lowCoverage.evidenceCoverage.overall < DECISION_POLICY.minEvidenceCoverageForAutoSelect);
assert.strictEqual(lowCoverage.candidateTier, "caution",
  "low evidence coverage must cap an otherwise high-scoring candidate");

const productionConsistencyInput = {
  roleAlignment: "partially_aligned",
  responsibilityMatches: [
    { state: "transferable", jdEvidence: "JD职责一", resumeEvidence: "简历职责一" },
    { state: "transferable", jdEvidence: "JD职责二", resumeEvidence: "简历职责二" },
    { state: "transferable", jdEvidence: "JD职责三", resumeEvidence: "简历职责三" }
  ],
  requirementMatches: [
    { state: "missing", central: true, jdEvidence: "JD核心要求", resumeEvidence: "简历核心缺口" },
    { state: "transferable", requirement: "支持要求" }
  ],
  boundaries: [],
  risks: []
};
const productionDecision = deriveMatrixDecision(productionConsistencyInput, DECISION_POLICY);
const consistentShadow = buildShadowScorecard(productionConsistencyInput, DECISION_POLICY);
assert.strictEqual(productionDecision.matrixRecommendation, "apply");
assert.strictEqual(consistentShadow.candidateTier, productionDecision.matrixRecommendation,
  "shadow candidate tier must use the production deterministic decision semantics");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-shadow-scorecard-smoke-"));
try {
  const fixturePath = path.join(tempDir, "fixture.json");
  const aliasPath = path.join(tempDir, "FIXTURE.JSON");
  fs.writeFileSync(fixturePath, JSON.stringify({ cases: [] }), "utf8");
  assert.notStrictEqual(path.resolve(fixturePath), path.resolve(aliasPath));
  assert.strictEqual(fs.realpathSync.native(fixturePath), fs.realpathSync.native(aliasPath));
  assert.throws(
    () => compareShadowScorecard(["--input", fixturePath, "--output", aliasPath]),
    /same file|same path|different/i,
    "case-insensitive path aliases must not overwrite the input fixture"
  );

  for (const [id, input] of [["missing-input"], ["array-input", []], ["string-input", "invalid"]]) {
    const invalidInputPath = path.join(tempDir, `${id}.json`);
    const invalidOutputPath = path.join(tempDir, `${id}-report.json`);
    const item = input === undefined ? { id } : { id, input };
    fs.writeFileSync(invalidInputPath, JSON.stringify({ cases: [item] }), "utf8");
    assert.throws(
      () => compareShadowScorecard(["--input", invalidInputPath, "--output", invalidOutputPath]),
      /input must be a non-array object/i,
      `each CLI case must reject ${id}`
    );
  }

  const evaluationFixturePath = path.join(tempDir, "evaluation-fixture.json");
  const evaluationReportPaths = [1, 2, 3].map((run) => path.join(tempDir, `evaluation-report-${run}.json`));
  const variantsReportPaths = [1, 2, 3].map((run) => path.join(tempDir, `variants-report-${run}.json`));
  const evaluationFixture = {
    cases: [
      {
        id: "confirmed-primary",
        input: fullyBoundInput({ sameEvidence: true, explanation: true }),
        humanLabel: { status: "confirmed", expectedTier: "primary" }
      },
      {
        id: "fixed-salary-boundary",
        fixedSalaryBoundary: true,
        input: {
          ...fullyBoundInput({ explanation: true }),
          boundaries: [{ verified: true, blocked: true, reason: "fixed salary boundary" }]
        },
        humanLabel: { status: "pending-human" }
      },
      {
        id: "verified-severe-risk",
        input: {
          ...fullyBoundInput({ explanation: true }),
          risks: [{ verified: true, severity: "severe" }]
        },
        humanLabel: { status: "ai-provisional", expectedTier: "primary" }
      },
      {
        id: "variant-evidence-escape",
        input: {
          roleAlignment: "aligned",
          responsibilityMatches: [
            { state: "matched", jdEvidence: "JD duty 1", resumeEvidence: "resume duty 1" },
            { state: "matched", jdEvidence: "JD duty 2", resumeEvidence: "resume duty 2" }
          ],
          requirementMatches: [
            { state: "matched", requirement: "known support", jdEvidence: "JD known", resumeEvidence: "resume known" },
            { state: "unknown", requirement: "unbound support", jdEvidence: "", resumeEvidence: "" }
          ],
          boundaries: [],
          risks: []
        },
        humanLabel: { status: "confirmed", expectedTier: "caution" }
      },
      {
        id: "five-bound-one-unknown",
        input: {
          roleAlignment: "aligned",
          responsibilityMatches: [
            { state: "matched", jdEvidence: "JD duty 1", resumeEvidence: "resume duty 1" },
            { state: "matched", jdEvidence: "JD duty 2", resumeEvidence: "resume duty 2" }
          ],
          requirementMatches: [
            { state: "matched", foundation: true, requirement: "core 1", jdEvidence: "JD core 1", resumeEvidence: "resume core 1" },
            { state: "matched", central: true, requirement: "core 2", jdEvidence: "JD core 2", resumeEvidence: "resume core 2" },
            { state: "matched", central: true, requirement: "core 3", jdEvidence: "JD core 3", resumeEvidence: "resume core 3" },
            { state: "matched", central: true, requirement: "core 4", jdEvidence: "JD core 4", resumeEvidence: "resume core 4" },
            { state: "matched", requirement: "support 1", jdEvidence: "JD support 1", resumeEvidence: "resume support 1" },
            { state: "unknown", requirement: "support 2", jdEvidence: "", resumeEvidence: "" }
          ],
          boundaries: [],
          risks: []
        },
        humanLabel: { status: "pending-human" }
      },
      {
        id: "responsibility-ceiling-escape",
        input: {
          roleAlignment: "aligned",
          responsibilityMatches: [
            { state: "matched", jdEvidence: "JD duty 1", resumeEvidence: "resume duty 1" },
            { state: "matched", jdEvidence: "JD duty 2", resumeEvidence: "resume duty 2" },
            { state: "unknown" },
            { state: "unknown" },
            { state: "unknown" }
          ],
          requirementMatches: [
            { state: "matched", foundation: true, requirement: "covered core", jdEvidence: "JD core", resumeEvidence: "resume core" }
          ],
          boundaries: [],
          risks: []
        },
        humanLabel: { status: "pending-human" }
      }
    ],
    variants: [
      {
        id: "safe-weights",
        policy: {
          ...DECISION_POLICY,
          requirementWeights: { core: 0.6, supporting: 0.4 }
        }
      },
      {
        id: "unsafe-evidence-coverage",
        policy: { ...DECISION_POLICY, minEvidenceCoverageForAutoSelect: 0.5 }
      },
      {
        id: "unsafe-responsibility-coverage",
        policy: {
          ...DECISION_POLICY,
          minEvidenceCoverageForAutoSelect: 0,
          responsibilityAlignment: {
            ...DECISION_POLICY.responsibilityAlignment,
            minimumKnownCoverage: 0.4,
            jointFit: {
              ...DECISION_POLICY.responsibilityAlignment.jointFit,
              zeroDutyGapMinimumKnownCoverage: 0.4
            }
          }
        }
      }
    ]
  };
  fs.writeFileSync(evaluationFixturePath, `${JSON.stringify(evaluationFixture, null, 2)}\n`, "utf8");

  for (const outputPath of evaluationReportPaths) {
    const result = spawnSync(process.execPath, [
      "scripts/compare-shadow-scorecard.js", "--input", evaluationFixturePath, "--output", outputPath
    ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  }
  const repeatedReports = evaluationReportPaths.map((reportPath) => fs.readFileSync(reportPath, "utf8"));
  assert.strictEqual(repeatedReports[0], repeatedReports[1], "same fixture and commit must produce byte-identical reports");
  assert.strictEqual(repeatedReports[1], repeatedReports[2], "repeated deterministic comparison must remain byte-identical");
  const evaluationReport = JSON.parse(repeatedReports[0]);
  assert.strictEqual(evaluationReport.version, "shadow-scorecard-report-v1", "existing report version remains compatible");
  assert.strictEqual(evaluationReport.schemaVersion, "shadow-scorecard-report-v2");
  assert.match(evaluationReport.inputFixtureSha256, /^[a-f0-9]{64}$/);
  assert.match(evaluationReport.evaluatedGitCommit, /^[a-f0-9]{40}$/);
  assert.strictEqual(evaluationReport.evaluation, "matrix-vs-guarded-scorecard");
  assert.strictEqual(evaluationReport.sharedDecisionEngine, "deriveMatrixDecision");
  assert.strictEqual(evaluationReport.comparisonInterpretation, "matrix-vs-matrix-plus-guardrails residual");
  assert.strictEqual(evaluationReport.matrixVsGuardedScorecard.confusion.primary.not_recommended, 2);
  assert.strictEqual(evaluationReport.verifiedHardBoundaryViolations.matrixPreGuardRisk[0].id, "fixed-salary-boundary");
  assert.deepStrictEqual(evaluationReport.verifiedHardBoundaryViolations.guardedScorecard, []);
  assert.strictEqual(evaluationReport.verifiedSevereRiskViolations.matrixPreGuardRisk[0].id, "verified-severe-risk");
  assert.deepStrictEqual(evaluationReport.verifiedSevereRiskViolations.guardedScorecard, []);
  assert.strictEqual(evaluationReport.evidenceCoverage.requirements.pairedEvidenceBound, 16,
    "identical JD and resume text still counts as two bound evidence fields");
  assert.strictEqual(evaluationReport.evidenceCoverage.requirements.coverageRate, 16 / 18);
  const fiveBoundOneUnknown = evaluationReport.rows.find((row) => row.id === "five-bound-one-unknown");
  assert.strictEqual(fiveBoundOneUnknown.candidateTier, "primary");
  assert.strictEqual(fiveBoundOneUnknown.scorecard.evidenceCoverage.overall, 0.85);
  assert(!evaluationReport.guardedEvidenceSafetyViolations.some((violation) => violation.id === "five-bound-one-unknown"));
  assert.strictEqual(evaluationReport.explanationCoverage.status, "available");
  assert.strictEqual(evaluationReport.explanationCoverage.requirements.explained, 9);
  assert.strictEqual(evaluationReport.explanationCoverage.requirements.coverageRate, 9 / 18);
  assert.strictEqual(evaluationReport.confirmedLabelCount, 2);
  assert.strictEqual(evaluationReport.pendingLabelCount, 4);
  const responsibilityCeiling = evaluationReport.rows.find((row) => row.id === "responsibility-ceiling-escape").baselineSafetyCeiling;
  assert.strictEqual(responsibilityCeiling.candidateTier, "caution");
  assert(responsibilityCeiling.codes.includes("alignment_consistency_cap"));
  assert.strictEqual(evaluationReport.rankingUsefulness.status, "available");

  const samePathResult = spawnSync(process.execPath, [
    "scripts/compare-shadow-scorecard.js", "--input", evaluationFixturePath, "--output", evaluationFixturePath
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.notStrictEqual(samePathResult.status, 0, "CLI must fail closed when input and output are identical");

  for (const outputPath of variantsReportPaths) {
    const variantsResult = spawnSync(process.execPath, [
      "scripts/evaluate-shadow-variants.js", "--input", evaluationFixturePath, "--output", outputPath
    ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
    assert.strictEqual(variantsResult.status, 0, variantsResult.stderr || variantsResult.stdout);
  }
  const repeatedVariantReports = variantsReportPaths.map((reportPath) => fs.readFileSync(reportPath, "utf8"));
  assert.strictEqual(repeatedVariantReports[0], repeatedVariantReports[1]);
  assert.strictEqual(repeatedVariantReports[1], repeatedVariantReports[2]);
  const variantsReport = JSON.parse(repeatedVariantReports[0]);
  assert.strictEqual(variantsReport.variants.length, 4);
  assert(variantsReport.variants.every((variant) => /^[a-f0-9]{64}$/.test(variant.policyHash)));
  assert.strictEqual(variantsReport.variants[0].id, "default");
  assert.strictEqual(variantsReport.variants[0].policyHash, decisionPolicyHash(DECISION_POLICY));
  assert.strictEqual(variantsReport.variants[0].rejected, false,
    "matrix pre-guard risk alone must not reject the guarded default policy");
  assert.strictEqual(variantsReport.variants[1].rejected, false);
  assert.strictEqual(variantsReport.variants[2].rejected, true);
  assert(variantsReport.variants[2].rejectionReasons.some((reason) => reason.code === "below_production_evidence_floor_guarded_scorecard"));
  assert.strictEqual(variantsReport.variants[3].rejected, true);
  assert(variantsReport.variants[3].rejectionReasons.some((reason) => reason.code === "guarded_production_safety_ceiling"));
  assert(!variantsReport.variants[0].rejectionReasons.some((reason) => reason.code === "guarded_production_safety_ceiling"),
    "the default variant must not reject when it matches the baseline safety ceiling");

  const variantsSamePathResult = spawnSync(process.execPath, [
    "scripts/evaluate-shadow-variants.js", "--input", evaluationFixturePath, "--output", evaluationFixturePath
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.notStrictEqual(variantsSamePathResult.status, 0, "variants CLI must fail closed when input and output are identical");

  const invalidVariantsPath = path.join(tempDir, "invalid-variants.json");
  fs.writeFileSync(invalidVariantsPath, JSON.stringify({
    cases: evaluationFixture.cases,
    variants: [{ id: "invalid", policy: { ...DECISION_POLICY, modelRecommendationMode: "invalid" } }]
  }), "utf8");
  const invalidVariantsResult = spawnSync(process.execPath, [
    "scripts/evaluate-shadow-variants.js", "--input", invalidVariantsPath, "--output", variantsReportPaths[0]
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.notStrictEqual(invalidVariantsResult.status, 0, "variants must assert their decision policy before evaluation");

  const invalidConfirmedLabelPath = path.join(tempDir, "invalid-confirmed-label.json");
  fs.writeFileSync(invalidConfirmedLabelPath, JSON.stringify({
    cases: [{ id: "invalid-confirmed", input: fullyBoundInput(), humanLabel: { status: "confirmed", expectedTier: "invalid" } }]
  }), "utf8");
  const invalidConfirmedLabelResult = spawnSync(process.execPath, [
    "scripts/compare-shadow-scorecard.js", "--input", invalidConfirmedLabelPath, "--output", path.join(tempDir, "invalid-confirmed-report.json")
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.notStrictEqual(invalidConfirmedLabelResult.status, 0, "invalid confirmed labels must fail closed");

  const unexplainedFixturePath = path.join(tempDir, "unexplained.json");
  const unexplainedReportPath = path.join(tempDir, "unexplained-report.json");
  fs.writeFileSync(unexplainedFixturePath, JSON.stringify({ cases: [{ id: "unexplained", input: fullyBoundInput() }] }), "utf8");
  const unexplainedResult = spawnSync(process.execPath, [
    "scripts/compare-shadow-scorecard.js", "--input", unexplainedFixturePath, "--output", unexplainedReportPath
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.strictEqual(unexplainedResult.status, 0, unexplainedResult.stderr || unexplainedResult.stdout);
  const unexplainedReport = JSON.parse(fs.readFileSync(unexplainedReportPath, "utf8"));
  assert.strictEqual(unexplainedReport.explanationCoverage.status, "unavailable");
  assert.strictEqual(unexplainedReport.explanationCoverage.coverageRate, null);

  const noEligibleExplanationPath = path.join(tempDir, "no-eligible-explanation.json");
  const noEligibleExplanationReportPath = path.join(tempDir, "no-eligible-explanation-report.json");
  fs.writeFileSync(noEligibleExplanationPath, JSON.stringify({
    cases: [{
      id: "no-eligible-explanation",
      explanation: "case-level explanation without an evaluable match item",
      input: { roleAlignment: "aligned", responsibilityMatches: [], requirementMatches: [], boundaries: [], risks: [] }
    }]
  }), "utf8");
  const noEligibleExplanationResult = spawnSync(process.execPath, [
    "scripts/compare-shadow-scorecard.js", "--input", noEligibleExplanationPath, "--output", noEligibleExplanationReportPath
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.strictEqual(noEligibleExplanationResult.status, 0, noEligibleExplanationResult.stderr || noEligibleExplanationResult.stdout);
  const noEligibleExplanation = JSON.parse(fs.readFileSync(noEligibleExplanationReportPath, "utf8")).explanationCoverage;
  assert.strictEqual(noEligibleExplanation.status, "unavailable");
  assert.strictEqual(noEligibleExplanation.coverageRate, null);

  const rankingFixture = {
    cases: [
      { id: "rank-a", input: fullyBoundInput(), humanLabel: { status: "confirmed", expectedTier: "primary" } },
      { id: "rank-b", input: fullyBoundInput(), humanLabel: { status: "confirmed", expectedTier: "caution" } },
      { id: "rank-c", input: applyTierInput(), humanLabel: { status: "confirmed", expectedTier: "not_recommended" } }
    ]
  };
  const rankingFixturePath = path.join(tempDir, "ranking.json");
  const renamedRankingFixturePath = path.join(tempDir, "ranking-renamed.json");
  const rankingReportPath = path.join(tempDir, "ranking-report.json");
  const renamedRankingReportPath = path.join(tempDir, "ranking-renamed-report.json");
  fs.writeFileSync(rankingFixturePath, JSON.stringify(rankingFixture), "utf8");
  fs.writeFileSync(renamedRankingFixturePath, JSON.stringify({
    cases: rankingFixture.cases.map((item, index) => ({ ...item, id: `renamed-${index}` }))
  }), "utf8");
  for (const [inputPath, outputPath] of [[rankingFixturePath, rankingReportPath], [renamedRankingFixturePath, renamedRankingReportPath]]) {
    const rankingResult = spawnSync(process.execPath, [
      "scripts/compare-shadow-scorecard.js", "--input", inputPath, "--output", outputPath
    ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
    assert.strictEqual(rankingResult.status, 0, rankingResult.stderr || rankingResult.stdout);
  }
  const rankingUsefulness = JSON.parse(fs.readFileSync(rankingReportPath, "utf8")).rankingUsefulness;
  const renamedRankingUsefulness = JSON.parse(fs.readFileSync(renamedRankingReportPath, "utf8")).rankingUsefulness;
  assert.strictEqual(rankingUsefulness.status, "available");
  assert.notStrictEqual(rankingUsefulness.ndcgAtK, null);
  assert.deepStrictEqual(rankingUsefulness, renamedRankingUsefulness,
    "tie-aware ranking metrics must not depend on fixture IDs");

  const insufficientRankingPath = path.join(tempDir, "insufficient-ranking.json");
  const insufficientRankingReportPath = path.join(tempDir, "insufficient-ranking-report.json");
  fs.writeFileSync(insufficientRankingPath, JSON.stringify({
    cases: [{ id: "only-one", input: fullyBoundInput(), humanLabel: { status: "confirmed", expectedTier: "primary" } }]
  }), "utf8");
  const insufficientRankingResult = spawnSync(process.execPath, [
    "scripts/compare-shadow-scorecard.js", "--input", insufficientRankingPath, "--output", insufficientRankingReportPath
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.strictEqual(insufficientRankingResult.status, 0, insufficientRankingResult.stderr || insufficientRankingResult.stdout);
  const insufficientRanking = JSON.parse(fs.readFileSync(insufficientRankingReportPath, "utf8")).rankingUsefulness;
  assert.strictEqual(insufficientRanking.status, "insufficient_sample");
  assert.strictEqual(insufficientRanking.ndcgAtK, null);
  assert.strictEqual(insufficientRanking.pairwiseConcordance, null);

  const tiedRankingPath = path.join(tempDir, "tied-ranking.json");
  const tiedRankingReportPath = path.join(tempDir, "tied-ranking-report.json");
  fs.writeFileSync(tiedRankingPath, JSON.stringify({
    cases: [
      { id: "tie-a", input: fullyBoundInput(), humanLabel: { status: "confirmed", expectedTier: "primary" } },
      { id: "tie-b", input: fullyBoundInput(), humanLabel: { status: "confirmed", expectedTier: "caution" } }
    ]
  }), "utf8");
  const tiedRankingResult = spawnSync(process.execPath, [
    "scripts/compare-shadow-scorecard.js", "--input", tiedRankingPath, "--output", tiedRankingReportPath
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.strictEqual(tiedRankingResult.status, 0, tiedRankingResult.stderr || tiedRankingResult.stdout);
  const tiedRanking = JSON.parse(fs.readFileSync(tiedRankingReportPath, "utf8")).rankingUsefulness;
  assert.strictEqual(tiedRanking.status, "insufficient_sample", "tied predictions provide no comparable ranking pair");
  assert.strictEqual(tiedRanking.ndcgAtK, null);
  assert.strictEqual(tiedRanking.pairwiseConcordance, null);

  const splitRankingPath = path.join(tempDir, "split-ranking.json");
  const splitRankingReportPath = path.join(tempDir, "split-ranking-report.json");
  fs.writeFileSync(splitRankingPath, JSON.stringify({
    cases: [
      { id: "split-a", input: fullyBoundInput(), humanLabel: { status: "confirmed", expectedTier: "primary" } },
      {
        id: "split-b",
        input: {
          ...fullyBoundInput(),
          boundaries: [{ verified: true, blocked: true, reason: "split ranking boundary" }]
        },
        humanLabel: { status: "confirmed", expectedTier: "not_recommended" }
      }
    ]
  }), "utf8");
  const splitRankingResult = spawnSync(process.execPath, [
    "scripts/compare-shadow-scorecard.js", "--input", splitRankingPath, "--output", splitRankingReportPath
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.strictEqual(splitRankingResult.status, 0, splitRankingResult.stderr || splitRankingResult.stdout);
  const splitRanking = JSON.parse(fs.readFileSync(splitRankingReportPath, "utf8")).rankingUsefulness;
  assert.strictEqual(splitRanking.status, "partial");
  assert.strictEqual(splitRanking.matrix.status, "insufficient_pairs");
  assert.strictEqual(splitRanking.matrix.ndcgAtK, null);
  assert.strictEqual(splitRanking.guardedScorecard.status, "available");
  assert.notStrictEqual(splitRanking.guardedScorecard.ndcgAtK, null);
  assert.notStrictEqual(splitRanking.guardedScorecard.pairwiseConcordance, null);
  assert.strictEqual(splitRanking.ndcgAtK, splitRanking.guardedScorecard.ndcgAtK);
  assert.strictEqual(splitRanking.pairwiseConcordance, splitRanking.guardedScorecard.pairwiseConcordance);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("shadow_scorecard_smoke ok");
