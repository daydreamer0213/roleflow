const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  DECISION_POLICY,
  decisionPolicyHash
} = require("../src/core/decision_policy");
const { deriveMatrixDecision } = require("../src/core/four_tier_decision");
const { buildShadowReport, main: compareShadowScorecard } = require("../scripts/compare-shadow-scorecard");
const { loadLabelsFile } = require("../scripts/lib/gate_d_labels");
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

function gateDLabelRow(evaluationId, overrides = {}) {
  return {
    evaluationId,
    status: "pending-human",
    directionFit: null,
    hardBoundaryPass: null,
    expectedTier: null,
    evidenceSufficiency: null,
    rationale: "",
    labeler: "",
    labeledAt: null,
    aiProvisional: {
      productionMatrixTier: null,
      guardedTier: null
    },
    ...overrides
  };
}

function gateDLabels(rows, overrides = {}) {
  return {
    schemaVersion: "gate-d-evaluation-labels-v2",
    confirmedMetrics: "deferred: merge confirmed worksheet labels before confirmed metrics",
    rows,
    ...overrides
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
        id: "technical-contract-failure",
        technicalBucket: "contract_failure",
        humanLabel: { status: "confirmed", expectedTier: "primary" },
        fixedSalaryBoundary: true
      },
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
  assert.strictEqual(evaluationReport.total, 6, "top-level total must count only quality-eligible rows");
  assert.strictEqual(evaluationReport.rawTotal, 7);
  assert.strictEqual(evaluationReport.qualityEligibleCaseCount, 6);
  assert.deepStrictEqual(evaluationReport.technicalBucketCounts, { contract_failure: 1 });
  assert.strictEqual(evaluationReport.matrixVsGuardedScorecard.total, 6);
  const technicalRow = evaluationReport.rows.find((row) => row.id === "technical-contract-failure");
  assert.strictEqual(technicalRow.technicalBucket, "contract_failure");
  assert.strictEqual(technicalRow.productionMatrixTier, null);
  assert.strictEqual(technicalRow.candidateTier, null);
  assert.strictEqual(technicalRow.scorecard, null);
  assert(!evaluationReport.fixedSalaryBoundaryEscapes.matrixPreGuardRisk.some((row) => row.id === technicalRow.id));
  assert(!evaluationReport.baselineSafetyCeilings.some((row) => row.id === technicalRow.id));
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

  const denominatorCounterexample = buildShadowReport({
    cases: [
      evaluationFixture.cases.find((item) => item.id === "technical-contract-failure"),
      evaluationFixture.cases.find((item) => item.id === "fixed-salary-boundary")
    ]
  });
  assert.strictEqual(denominatorCounterexample.rawTotal, 2);
  assert.strictEqual(denominatorCounterexample.total, 1);
  assert.strictEqual(denominatorCounterexample.qualityEligibleCaseCount, 1);
  assert.deepStrictEqual(denominatorCounterexample.technicalBucketCounts, { contract_failure: 1 });

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
  assert.strictEqual(variantsReport.rawTotal, 7);
  assert.strictEqual(variantsReport.qualityEligibleCaseCount, 6);
  assert.deepStrictEqual(variantsReport.technicalBucketCounts, { contract_failure: 1 });
  assert.strictEqual(variantsReport.variants.length, 4);
  assert(variantsReport.variants.every((variant) => variant.rawTotal === 7
    && variant.qualityEligibleCaseCount === 6
    && variant.technicalBucketCounts.contract_failure === 1));
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

  const labelFixture = {
    cases: [
      {
        id: "label-a",
        evaluationId: "label-a-evaluation-id",
        input: fullyBoundInput({ sameEvidence: true, explanation: true }),
        humanLabel: { status: "pending-human" }
      },
      {
        id: "label-b",
        evaluationId: "label-b-evaluation-id",
        input: fullyBoundInput({ sameEvidence: true, explanation: true }),
        humanLabel: { status: "pending-human" }
      },
      {
        id: "label-c",
        evaluationId: "label-c-evaluation-id",
        input: applyTierInput(),
        humanLabel: { status: "pending-human" }
      }
    ]
  };
  const labelRows = [
    gateDLabelRow("label-a-evaluation-id", {
      status: "confirmed",
      directionFit: true,
      hardBoundaryPass: true,
      expectedTier: "primary",
      evidenceSufficiency: true,
      labeler: "human-reviewer",
      rationale: "audit-secret-rationale-marker",
      labeledAt: "2026-08-12T01:00:00.000Z",
      aiProvisional: { productionMatrixTier: "primary", guardedTier: "primary" }
    }),
    gateDLabelRow("label-b-evaluation-id", {
      status: "confirmed",
      directionFit: true,
      hardBoundaryPass: true,
      expectedTier: "caution",
      evidenceSufficiency: true,
      labeler: "human-reviewer",
      rationale: "confirmed caution",
      labeledAt: "2026-08-12T01:01:00.000Z",
      aiProvisional: { productionMatrixTier: "primary", guardedTier: "primary" }
    }),
    gateDLabelRow("label-c-evaluation-id", {
      status: "confirmed",
      directionFit: false,
      hardBoundaryPass: true,
      expectedTier: "not_recommended",
      evidenceSufficiency: true,
      labeler: "human-reviewer",
      rationale: "confirmed rejection",
      labeledAt: "2026-08-12T01:02:00.000Z",
      aiProvisional: { productionMatrixTier: "caution", guardedTier: "caution" }
    })
  ];
  const labelFixturePath = path.join(tempDir, "label-fixture.json");
  const labelsPath = path.join(tempDir, "gate-d-evaluation-labels.json");
  fs.writeFileSync(labelFixturePath, `${JSON.stringify(labelFixture, null, 2)}\n`, "utf8");
  fs.writeFileSync(labelsPath, `${JSON.stringify(gateDLabels(labelRows), null, 2)}\n`, "utf8");
  const labelFixtureBytes = fs.readFileSync(labelFixturePath);
  const labelsFileBytes = fs.readFileSync(labelsPath);
  const labelsSha256 = crypto.createHash("sha256").update(labelsFileBytes).digest("hex");

  const labelNoLabelsReportPath = path.join(tempDir, "label-no-labels-report.json");
  const labelNoLabelsResult = spawnSync(process.execPath, [
    "scripts/compare-shadow-scorecard.js", "--input", labelFixturePath, "--output", labelNoLabelsReportPath
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.strictEqual(labelNoLabelsResult.status, 0, labelNoLabelsResult.stderr || labelNoLabelsResult.stdout);
  const labelNoLabelsReport = JSON.parse(fs.readFileSync(labelNoLabelsReportPath, "utf8"));
  assert.strictEqual(labelNoLabelsReport.confirmedLabelCount, 0,
    "fixture pending labels must not count as confirmed without --labels");
  assert.strictEqual(labelNoLabelsReport.rankingUsefulness.status, "insufficient_sample");
  assert.deepStrictEqual(labelNoLabelsReport.labelSource, {
    source: "fixture",
    sha256: null,
    schemaVersion: null,
    rowCount: null,
    confirmedCount: 0,
    pendingCount: 3
  }, "without --labels the report must expose an explicit fixture-source audit block");

  const labelReportPath = path.join(tempDir, "label-report.json");
  const labelResult = spawnSync(process.execPath, [
    "scripts/compare-shadow-scorecard.js", "--input", labelFixturePath, "--labels", labelsPath, "--output", labelReportPath
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.strictEqual(labelResult.status, 0, labelResult.stderr || labelResult.stdout);
  const labelReport = JSON.parse(fs.readFileSync(labelReportPath, "utf8"));
  assert.strictEqual(labelReport.confirmedLabelCount, 3,
    "labels file confirmations must enter confirmedLabelCount");
  assert.strictEqual(labelReport.pendingLabelCount, 0);
  assert.strictEqual(labelReport.rankingUsefulness.status, "available",
    "merged labels must activate ranking metrics that were unavailable without them");
  assert.notStrictEqual(labelReport.rankingUsefulness.ndcgAtK, null);
  assert.deepStrictEqual(labelReport.labelSource, {
    source: "labels",
    sha256: labelsSha256,
    schemaVersion: "gate-d-evaluation-labels-v2",
    rowCount: 3,
    confirmedCount: 3,
    pendingCount: 0
  });
  assert.strictEqual(labelReport.labelSource.sha256, loadLabelsFile(labelsPath).sha256);
  assert(labelReport.rows.every((row) => Object.keys(row.humanLabel).every((key) => ["status", "expectedTier"].includes(key))),
    "report rows must not leak extra label fields");
  assert.strictEqual(JSON.stringify(labelReport).includes("audit-secret-rationale-marker"), false,
    "report must not leak label rationale text");
  assert.strictEqual(JSON.stringify(labelReport).includes("human-reviewer"), false,
    "report must not leak labeler identity");
  assert.deepStrictEqual(fs.readFileSync(labelFixturePath), labelFixtureBytes,
    "canonical fixture bytes must not change");
  assert.deepStrictEqual(fs.readFileSync(labelsPath), labelsFileBytes,
    "canonical labels bytes must not change");

  const exporterInitialLabelsPath = path.join(tempDir, "labels-exporter-initial.json");
  fs.writeFileSync(exporterInitialLabelsPath, JSON.stringify(gateDLabels([
    gateDLabelRow("exporter-initial-evaluation-id")
  ])), "utf8");
  assert.doesNotThrow(() => loadLabelsFile(exporterInitialLabelsPath),
    "the strict consumer must accept the exporter's unchanged v2 initial labels shape");

  const missingLabelsPath = path.join(tempDir, "labels-missing.json");
  fs.writeFileSync(missingLabelsPath, JSON.stringify(gateDLabels(labelRows.slice(0, 2))), "utf8");
  assert.throws(
    () => compareShadowScorecard(["--input", labelFixturePath, "--labels", missingLabelsPath, "--output", path.join(tempDir, "missing-report.json")]),
    /fixture cases count .* labels rows count/i,
    "labels rows missing a fixture evaluationId must fail closed"
  );
  const extraLabelsPath = path.join(tempDir, "labels-extra.json");
  fs.writeFileSync(extraLabelsPath, JSON.stringify(gateDLabels([
    ...labelRows,
    gateDLabelRow("label-unknown-evaluation-id")
  ])), "utf8");
  assert.throws(
    () => compareShadowScorecard(["--input", labelFixturePath, "--labels", extraLabelsPath, "--output", path.join(tempDir, "extra-report.json")]),
    /fixture cases count .* labels rows count/i,
    "labels rows without a fixture case must fail closed"
  );
  const unknownLabelsPath = path.join(tempDir, "labels-unknown-id.json");
  fs.writeFileSync(unknownLabelsPath, JSON.stringify(gateDLabels([
    labelRows[0],
    labelRows[1],
    gateDLabelRow("label-unknown-evaluation-id")
  ])), "utf8");
  assert.throws(
    () => compareShadowScorecard(["--input", labelFixturePath, "--labels", unknownLabelsPath, "--output", path.join(tempDir, "unknown-report.json")]),
    /unknown evaluationId/i,
    "equal-sized labels with a foreign evaluationId must fail closed"
  );
  const duplicateLabelsPath = path.join(tempDir, "labels-duplicate.json");
  fs.writeFileSync(duplicateLabelsPath, JSON.stringify(gateDLabels([
    labelRows[0],
    labelRows[1],
    { ...labelRows[0] }
  ])), "utf8");
  assert.throws(
    () => compareShadowScorecard(["--input", labelFixturePath, "--labels", duplicateLabelsPath, "--output", path.join(tempDir, "duplicate-report.json")]),
    /duplicate labels evaluationId/i,
    "duplicate labels evaluationIds must fail closed"
  );
  const invalidTierLabelsPath = path.join(tempDir, "labels-invalid-tier.json");
  fs.writeFileSync(invalidTierLabelsPath, JSON.stringify(gateDLabels(
    labelRows.map((row, index) => index === 0 ? { ...row, expectedTier: "invalid-tier" } : row)
  )), "utf8");
  assert.throws(
    () => compareShadowScorecard(["--input", labelFixturePath, "--labels", invalidTierLabelsPath, "--output", path.join(tempDir, "invalid-tier-report.json")]),
    /canonical expectedTier/i,
    "confirmed labels with an invalid expectedTier must fail closed"
  );

  const validLabelDocument = gateDLabels(labelRows);
  const { confirmedMetrics: _omittedConfirmedMetrics, ...labelsWithoutConfirmedMetrics } = validLabelDocument;
  const { labeler: _omittedLabeler, ...rowWithoutLabeler } = labelRows[0];
  const {
    guardedTier: _omittedGuardedTier,
    ...aiProvisionalWithoutGuardedTier
  } = labelRows[0].aiProvisional;
  const invalidLabelDocuments = [
    ["wrong-schema", { ...validLabelDocument, schemaVersion: "gate-d-evaluation-labels-v1" }, /schemaVersion/i],
    ["numeric-schema", { ...validLabelDocument, schemaVersion: 2 }, /schemaVersion/i],
    ["numeric-confirmed-metrics", { ...validLabelDocument, confirmedMetrics: 1 }, /confirmedMetrics must be a string/i],
    ["missing-top-field", labelsWithoutConfirmedMetrics, /labels fields/i],
    ["non-array-rows", { ...validLabelDocument, rows: {} }, /rows array/i],
    ["unknown-top-field", { ...validLabelDocument, unknownTop: true }, /unknown labels field/i],
    ["unknown-row-field", gateDLabels([{ ...labelRows[0], unknownRow: true }, ...labelRows.slice(1)]), /unknown labels row field/i],
    ["missing-row-field", gateDLabels([rowWithoutLabeler, ...labelRows.slice(1)]), /labels row fields/i],
    ["numeric-evaluation-id", gateDLabels([{ ...labelRows[0], evaluationId: 1 }, ...labelRows.slice(1)]), /evaluationId must be a non-empty string/i],
    ["numeric-status", gateDLabels([{ ...labelRows[0], status: 1 }, ...labelRows.slice(1)]), /status must be a string/i],
    ["ai-status", gateDLabels([{ ...labelRows[0], status: "ai-provisional" }, ...labelRows.slice(1)]), /status must be pending-human or confirmed/i],
    ["string-direction-fit", gateDLabels([{ ...labelRows[0], directionFit: "yes" }, ...labelRows.slice(1)]), /directionFit must be boolean or null/i],
    ["string-boundary-pass", gateDLabels([{ ...labelRows[0], hardBoundaryPass: "yes" }, ...labelRows.slice(1)]), /hardBoundaryPass must be boolean or null/i],
    ["string-evidence-sufficiency", gateDLabels([{ ...labelRows[0], evidenceSufficiency: "yes" }, ...labelRows.slice(1)]), /evidenceSufficiency must be boolean or null/i],
    ["pending-tier", gateDLabels([gateDLabelRow("label-a-evaluation-id", { expectedTier: "primary" }), ...labelRows.slice(1)]), /pending-human expectedTier must be null/i],
    ["null-confirmed-tier", gateDLabels([{ ...labelRows[0], expectedTier: null }, ...labelRows.slice(1)]), /confirmed labels must define a canonical expectedTier/i],
    ["null-rationale", gateDLabels([{ ...labelRows[0], rationale: null }, ...labelRows.slice(1)]), /rationale must be a string/i],
    ["null-labeler", gateDLabels([{ ...labelRows[0], labeler: null }, ...labelRows.slice(1)]), /labeler must be a string/i],
    ["numeric-labeled-at", gateDLabels([{ ...labelRows[0], labeledAt: 1 }, ...labelRows.slice(1)]), /labeledAt must be a string or null/i],
    ["null-ai-provisional", gateDLabels([{ ...labelRows[0], aiProvisional: null }, ...labelRows.slice(1)]), /aiProvisional must be a non-array object/i],
    ["unknown-ai-field", gateDLabels([{
      ...labelRows[0],
      aiProvisional: { ...labelRows[0].aiProvisional, unknownAi: "primary" }
    }, ...labelRows.slice(1)]), /unknown aiProvisional field/i],
    ["missing-ai-field", gateDLabels([{
      ...labelRows[0],
      aiProvisional: aiProvisionalWithoutGuardedTier
    }, ...labelRows.slice(1)]), /aiProvisional fields/i],
    ["numeric-ai-tier", gateDLabels([{
      ...labelRows[0],
      aiProvisional: { ...labelRows[0].aiProvisional, guardedTier: 1 }
    }, ...labelRows.slice(1)]), /aiProvisional guardedTier must be a canonical tier or null/i],
    ["invalid-ai-tier", gateDLabels([{
      ...labelRows[0],
      aiProvisional: { ...labelRows[0].aiProvisional, productionMatrixTier: "invalid-tier" }
    }, ...labelRows.slice(1)]), /aiProvisional productionMatrixTier must be a canonical tier or null/i]
  ];
  invalidLabelDocuments.forEach(([name, document, expected]) => {
    const invalidPath = path.join(tempDir, `labels-${name}.json`);
    fs.writeFileSync(invalidPath, JSON.stringify(document), "utf8");
    assert.throws(() => loadLabelsFile(invalidPath), expected, `${name} labels must fail closed`);
  });

  const missingEvaluationIdPath = path.join(tempDir, "fixture-missing-evaluation-id.json");
  fs.writeFileSync(missingEvaluationIdPath, JSON.stringify({
    cases: [{ id: "no-eval-id", input: fullyBoundInput(), humanLabel: { status: "pending-human" } }]
  }), "utf8");
  const singleRowLabelsPath = path.join(tempDir, "labels-single.json");
  fs.writeFileSync(singleRowLabelsPath, JSON.stringify(gateDLabels([
    gateDLabelRow("no-eval-id")
  ])), "utf8");
  assert.throws(
    () => compareShadowScorecard(["--input", missingEvaluationIdPath, "--labels", singleRowLabelsPath, "--output", path.join(tempDir, "missing-eval-report.json")]),
    /missing evaluationId/i,
    "fixture cases must expose evaluationId when labels are provided"
  );

  const duplicateFixturePath = path.join(tempDir, "fixture-duplicate-evaluation-id.json");
  fs.writeFileSync(duplicateFixturePath, JSON.stringify({
    ...labelFixture,
    cases: labelFixture.cases.map((item, index) => (
      index === 1 ? { ...item, evaluationId: labelFixture.cases[0].evaluationId } : item
    ))
  }), "utf8");
  for (const [script, outputName] of [
    ["scripts/compare-shadow-scorecard.js", "duplicate-fixture-compare-report.json"],
    ["scripts/evaluate-shadow-variants.js", "duplicate-fixture-variants-report.json"]
  ]) {
    const duplicateFixtureResult = spawnSync(process.execPath, [
      script, "--input", duplicateFixturePath, "--labels", labelsPath, "--output", path.join(tempDir, outputName)
    ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
    assert.notStrictEqual(duplicateFixtureResult.status, 0,
      `${script} must reject duplicate fixture evaluationIds`);
    assert.match(duplicateFixtureResult.stderr, /duplicate fixture evaluationId/i,
      `${script} must identify the duplicate fixture evaluationId`);
  }

  const labelVariantsReportPath = path.join(tempDir, "label-variants-report.json");
  const labelVariantsResult = spawnSync(process.execPath, [
    "scripts/evaluate-shadow-variants.js", "--input", labelFixturePath, "--labels", labelsPath, "--output", labelVariantsReportPath
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.strictEqual(labelVariantsResult.status, 0, labelVariantsResult.stderr || labelVariantsResult.stdout);
  const labelVariantsReport = JSON.parse(fs.readFileSync(labelVariantsReportPath, "utf8"));
  assert.deepStrictEqual(labelVariantsReport.labelSource, labelReport.labelSource,
    "variants must preserve the same labels audit block");
  assert(labelVariantsReport.variants.every((variant) => variant.confirmedLabelCount === 3
    && variant.rankingUsefulness.status === "available"
    && variant.rankingUsefulness.confirmedLabelCount === 3),
  "every variant must consume the same merged labels");
  const labelVariantsNoLabelsPath = path.join(tempDir, "label-variants-no-labels-report.json");
  const labelVariantsNoLabelsResult = spawnSync(process.execPath, [
    "scripts/evaluate-shadow-variants.js", "--input", labelFixturePath, "--output", labelVariantsNoLabelsPath
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.strictEqual(labelVariantsNoLabelsResult.status, 0, labelVariantsNoLabelsResult.stderr || labelVariantsNoLabelsResult.stdout);
  const labelVariantsNoLabels = JSON.parse(fs.readFileSync(labelVariantsNoLabelsPath, "utf8"));
  assert.strictEqual(labelVariantsNoLabels.labelSource.source, "fixture");
  assert(labelVariantsNoLabels.variants.every((variant) => variant.confirmedLabelCount === 0),
    "variants without --labels must keep fixture labels");
  assert.deepStrictEqual(fs.readFileSync(labelFixturePath), labelFixtureBytes,
    "variants must not modify the canonical fixture");
  assert.deepStrictEqual(fs.readFileSync(labelsPath), labelsFileBytes,
    "variants must not modify the canonical labels file");

  const hardLinkCases = [
    {
      script: "scripts/compare-shadow-scorecard.js",
      source: labelFixturePath,
      output: path.join(tempDir, "compare-input-output-hard-link.json"),
      args: (output) => ["--input", labelFixturePath, "--output", output],
      message: "compare must reject hard-linked input/output files"
    },
    {
      script: "scripts/compare-shadow-scorecard.js",
      source: labelsPath,
      output: path.join(tempDir, "compare-labels-output-hard-link.json"),
      args: (output) => ["--input", labelFixturePath, "--labels", labelsPath, "--output", output],
      message: "compare must reject hard-linked labels/output files"
    },
    {
      script: "scripts/evaluate-shadow-variants.js",
      source: labelFixturePath,
      output: path.join(tempDir, "variants-input-output-hard-link.json"),
      args: (output) => ["--input", labelFixturePath, "--output", output],
      message: "variants must reject hard-linked input/output files"
    },
    {
      script: "scripts/evaluate-shadow-variants.js",
      source: labelsPath,
      output: path.join(tempDir, "variants-labels-output-hard-link.json"),
      args: (output) => ["--input", labelFixturePath, "--labels", labelsPath, "--output", output],
      message: "variants must reject hard-linked labels/output files"
    }
  ];
  let hardLinksSupported = true;
  try {
    for (const item of hardLinkCases) fs.linkSync(item.source, item.output);
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(error.code)) throw error;
    hardLinksSupported = false;
    console.warn(`SKIP hard-link same-file tests: ${error.code}`);
  }
  if (hardLinksSupported) {
    for (const item of hardLinkCases) {
      const result = spawnSync(process.execPath, [
        item.script, ...item.args(item.output)
      ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
      assert.notStrictEqual(result.status, 0, item.message);
      assert.match(result.stderr, /different files/i, item.message);
    }
  }

  const labelsSamePathResult = spawnSync(process.execPath, [
    "scripts/compare-shadow-scorecard.js", "--input", labelFixturePath, "--labels", labelsPath, "--output", labelsPath
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.notStrictEqual(labelsSamePathResult.status, 0,
    "labels must not be overwritten by the output report");
  const labelsSameInputResult = spawnSync(process.execPath, [
    "scripts/compare-shadow-scorecard.js", "--input", labelFixturePath, "--labels", labelFixturePath, "--output", path.join(tempDir, "labels-same-input-report.json")
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.notStrictEqual(labelsSameInputResult.status, 0,
    "labels and input must refer to different files");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("shadow_scorecard_smoke ok");
