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
  const variantsReportPath = path.join(tempDir, "variants-report.json");
  const evaluationFixture = {
    cases: [
      {
        id: "confirmed-primary",
        input: baseInput(),
        humanLabel: { status: "confirmed", expectedTier: "primary" }
      },
      {
        id: "fixed-salary-boundary",
        fixedSalaryBoundary: true,
        input: {
          ...baseInput(),
          boundaries: [{ verified: true, blocked: true, reason: "fixed salary boundary" }]
        },
        humanLabel: { status: "pending-human" }
      },
      {
        id: "missing-independent-evidence",
        input: {
          ...baseInput(),
          responsibilityMatches: [
            { state: "matched", jdEvidence: "same evidence", resumeEvidence: "same evidence" },
            { state: "matched", jdEvidence: "same evidence 2", resumeEvidence: "same evidence 2" }
          ]
        },
        humanLabel: { status: "ai-provisional", expectedTier: "primary" }
      }
    ],
    variants: [{
      id: "alternate-weights",
      policy: {
        ...DECISION_POLICY,
        requirementWeights: { core: 0.6, supporting: 0.4 }
      }
    }]
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
  assert.strictEqual(evaluationReport.matrixVsGuardedScorecard.confusion.primary.primary, 2);
  assert.strictEqual(evaluationReport.verifiedHardBoundaryViolations.matrix[0].id, "fixed-salary-boundary");
  assert.deepStrictEqual(evaluationReport.verifiedHardBoundaryViolations.scorecard, []);
  assert.strictEqual(evaluationReport.independentEvidenceViolations.matrix[0].id, "missing-independent-evidence");
  assert.strictEqual(evaluationReport.confirmedLabelCount, 1);
  assert.strictEqual(evaluationReport.pendingLabelCount, 2);
  assert.strictEqual(evaluationReport.rankingUsefulness.confirmedLabelCount, 1);
  assert.strictEqual(evaluationReport.rankingUsefulness.ndcgAtK, 1);

  const samePathResult = spawnSync(process.execPath, [
    "scripts/compare-shadow-scorecard.js", "--input", evaluationFixturePath, "--output", evaluationFixturePath
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.notStrictEqual(samePathResult.status, 0, "CLI must fail closed when input and output are identical");

  const variantsResult = spawnSync(process.execPath, [
    "scripts/evaluate-shadow-variants.js", "--input", evaluationFixturePath, "--output", variantsReportPath
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.strictEqual(variantsResult.status, 0, variantsResult.stderr || variantsResult.stdout);
  const variantsReport = JSON.parse(fs.readFileSync(variantsReportPath, "utf8"));
  assert.strictEqual(variantsReport.variants.length, 2);
  assert(variantsReport.variants.every((variant) => /^[a-f0-9]{64}$/.test(variant.policyHash)));
  assert(variantsReport.variants.every((variant) => variant.rejected === true));
  assert(variantsReport.variants.every((variant) => variant.rejectionReasons.some((reason) => reason.code === "fixed_salary_boundary_escape")));

  const invalidVariantsPath = path.join(tempDir, "invalid-variants.json");
  fs.writeFileSync(invalidVariantsPath, JSON.stringify({
    cases: evaluationFixture.cases,
    variants: [{ id: "invalid", policy: { ...DECISION_POLICY, modelRecommendationMode: "invalid" } }]
  }), "utf8");
  const invalidVariantsResult = spawnSync(process.execPath, [
    "scripts/evaluate-shadow-variants.js", "--input", invalidVariantsPath, "--output", variantsReportPath
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.notStrictEqual(invalidVariantsResult.status, 0, "variants must assert their decision policy before evaluation");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("shadow_scorecard_smoke ok");
