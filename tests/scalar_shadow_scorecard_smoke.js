const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { deriveMatrixDecision } = require("../src/core/four_tier_decision");
const {
  buildScalarShadowReport,
  main: compareScalarShadow
} = require("../scripts/compare-scalar-shadow");
const {
  buildScalarShadowScorecard
} = require("../scripts/lib/scalar_shadow_scorecard");

function responsibility(state, index) {
  return {
    state,
    jdEvidence: `JD duty ${index}`,
    resumeEvidence: `resume duty ${index}`
  };
}

function requirement(state, index, overrides = {}) {
  return {
    state,
    requirement: `requirement ${index}`,
    jdEvidence: `JD requirement ${index}`,
    resumeEvidence: `resume requirement ${index}`,
    ...overrides
  };
}

function strongInput() {
  return {
    roleAlignment: "aligned",
    responsibilityMatches: [responsibility("matched", 1), responsibility("matched", 2)],
    requirementMatches: [
      requirement("matched", 1, { foundation: true }),
      requirement("matched", 2)
    ],
    boundaries: [],
    risks: []
  };
}

const stableInput = strongInput();
const before = JSON.parse(JSON.stringify(stableInput));
const first = buildScalarShadowScorecard(stableInput);
const second = buildScalarShadowScorecard(stableInput);
assert.deepStrictEqual(first, second, "same semantic evidence must produce the same scalar result");
assert.deepStrictEqual(stableInput, before, "scalar evaluation must not mutate frozen semantic evidence");
assert.strictEqual(first.version, "scalar-shadow-scorecard-v1");
assert.strictEqual(first.score.formula, "responsibilities:0.4+requirements:0.6");
assert.strictEqual(first.score.value, 1);
assert.strictEqual(first.rawTier, "primary");
assert.strictEqual(first.candidateTier, "primary");

const continuousDifferenceInput = {
  ...strongInput(),
  responsibilityMatches: [responsibility("transferable", 1), responsibility("transferable", 2)],
  requirementMatches: [
    requirement("transferable", 1, { foundation: true }),
    requirement("transferable", 2)
  ]
};
const matrixDifference = deriveMatrixDecision(continuousDifferenceInput);
const scalarDifference = buildScalarShadowScorecard(continuousDifferenceInput);
assert.strictEqual(matrixDifference.matrixRecommendation, "primary");
assert.strictEqual(scalarDifference.score.value, 0.5);
assert.strictEqual(scalarDifference.candidateTier, "apply");

const hardBoundary = buildScalarShadowScorecard({
  ...strongInput(),
  boundaries: [{ verified: true, blocked: true, reason: "verified incompatibility" }]
});
assert.strictEqual(hardBoundary.rawTier, "primary");
assert.strictEqual(hardBoundary.candidateTier, "not_recommended");
assert(hardBoundary.guardrails.some((item) => item.code === "verified_hard_boundary"));

const severeRisk = buildScalarShadowScorecard({
  ...strongInput(),
  risks: [{ verified: true, severity: "severe" }]
});
assert.strictEqual(severeRisk.candidateTier, "not_recommended");
assert(severeRisk.guardrails.some((item) => item.code === "verified_severe_risk"));

const wrongDirection = buildScalarShadowScorecard({
  ...strongInput(),
  roleAlignment: "misaligned",
  responsibilityMatches: [responsibility("missing", 1), responsibility("missing", 2)]
});
assert.strictEqual(wrongDirection.score.value, 0.6);
assert.strictEqual(wrongDirection.rawTier, "apply");
assert.strictEqual(wrongDirection.candidateTier, "not_recommended");
assert(wrongDirection.guardrails.some((item) => item.code === "role_direction_misaligned"));

const lowCoverage = buildScalarShadowScorecard({
  ...strongInput(),
  requirementMatches: [
    requirement("matched", 1, { foundation: true }),
    { state: "unknown", requirement: "unverified core", foundation: true }
  ]
});
assert.strictEqual(lowCoverage.rawTier, "primary");
assert.strictEqual(lowCoverage.candidateTier, "caution");
assert(lowCoverage.guardrails.some((item) => item.code === "low_requirement_coverage"));

const unknownCore = buildScalarShadowScorecard({
  ...strongInput(),
  requirementMatches: [
    { state: "unknown", requirement: "unknown core", foundation: true },
    requirement("matched", 2)
  ]
});
assert.strictEqual(unknownCore.rawTier, "primary");
assert.strictEqual(unknownCore.candidateTier, "caution");
assert(unknownCore.guardrails.some((item) => item.code === "unknown_core_requirements"));

const foundationGap = buildScalarShadowScorecard({
  ...strongInput(),
  roleAlignment: "partially_aligned",
  requirementMatches: [
    requirement("matched", 1, { foundation: true }),
    requirement("matched", 2, { central: true }),
    requirement("missing", 3, { foundation: true }),
    requirement("matched", 4)
  ]
});
assert.strictEqual(foundationGap.rawTier, "primary");
assert.strictEqual(foundationGap.candidateTier, "caution");
assert(foundationGap.guardrails.some((item) => item.code === "confirmed_foundation_gap"));

const insufficientReport = buildScalarShadowReport({
  cases: [
    { id: "strong", input: strongInput() },
    { id: "matrix-scalar-difference", input: continuousDifferenceInput },
    {
      id: "hard-boundary",
      input: {
        ...strongInput(),
        boundaries: [{ verified: true, blocked: true, reason: "verified boundary" }]
      }
    },
    { id: "technical-contract-failure", technicalBucket: "contract_failure" }
  ]
});
assert.strictEqual(insufficientReport.evaluation, "matrix-vs-scalar-shadow");
assert.strictEqual(insufficientReport.productionInfluence, "none");
assert.strictEqual(insufficientReport.rawTotal, 4);
assert.strictEqual(insufficientReport.qualityEligibleCaseCount, 3);
assert.strictEqual(insufficientReport.changedTierCount, 2);
assert.strictEqual(insufficientReport.hardBoundaryEscapeCount, 0);
assert.strictEqual(insufficientReport.correctness.status, "insufficient_labels");
assert.strictEqual(insufficientReport.stability.status, "insufficient_repeats");
assert(!Object.hasOwn(insufficientReport, "winner"));
assert(!Object.hasOwn(insufficientReport, "recommendedRoute"));

const evidenceReport = buildScalarShadowReport({
  cases: [
    {
      id: "repeat-strong",
      repeatGroup: "same-job",
      input: strongInput(),
      humanLabel: { status: "confirmed", expectedTier: "primary" }
    },
    {
      id: "repeat-transferable",
      repeatGroup: "same-job",
      input: continuousDifferenceInput,
      humanLabel: { status: "confirmed", expectedTier: "primary" }
    }
  ]
});
assert.strictEqual(evidenceReport.correctness.status, "available");
assert.deepStrictEqual(evidenceReport.correctness.matrix, { matches: 2, rate: 1 });
assert.deepStrictEqual(evidenceReport.correctness.scalar, { matches: 1, rate: 0.5 });
assert.strictEqual(evidenceReport.stability.status, "available");
assert.strictEqual(evidenceReport.stability.repeatGroupCount, 1);
assert.strictEqual(evidenceReport.stability.matrix.variableGroupCount, 0);
assert.strictEqual(evidenceReport.stability.scalar.variableGroupCount, 1);
assert.strictEqual(evidenceReport.stability.groups[0].scalarScoreRange, 0.5);

const tempRoot = fs.mkdtempSync(path.join("D:\\DevData", "RoleFlow-scalar-shadow-test-"));
try {
  const inputPath = path.join(tempRoot, "fixture.json");
  const firstOutputPath = path.join(tempRoot, "report-one.json");
  const secondOutputPath = path.join(tempRoot, "report-two.json");
  fs.writeFileSync(inputPath, `${JSON.stringify({ cases: [
    { id: "strong", input: strongInput() },
    { id: "difference", input: continuousDifferenceInput }
  ] }, null, 2)}\n`, "utf8");
  compareScalarShadow(["--input", inputPath, "--output", firstOutputPath]);
  compareScalarShadow(["--input", inputPath, "--output", secondOutputPath]);
  assert.strictEqual(
    fs.readFileSync(firstOutputPath, "utf8"),
    fs.readFileSync(secondOutputPath, "utf8"),
    "same fixture and commit must produce byte-identical scalar reports"
  );
  const cliReport = JSON.parse(fs.readFileSync(firstOutputPath, "utf8"));
  assert.match(cliReport.inputFixtureSha256, /^[a-f0-9]{64}$/);
  assert.match(cliReport.evaluatedGitCommit, /^[a-f0-9]{40}$/);
  assert.strictEqual(cliReport.productionInfluence, "none");

  assert.throws(
    () => compareScalarShadow(["--input", inputPath, "--output", inputPath]),
    /different|same file|same path/i
  );
  assert.throws(
    () => compareScalarShadow(["--input", inputPath, "--labels", inputPath, "--output", firstOutputPath]),
    /different|same file|same path/i
  );
  assert.throws(
    () => buildScalarShadowReport({ cases: [
      { id: "duplicate", input: strongInput() },
      { id: "duplicate", input: strongInput() }
    ] }),
    /duplicate/i
  );
  assert.throws(
    () => buildScalarShadowReport({ cases: [{ id: "missing-input" }] }),
    /input/i
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("scalar_shadow_scorecard_smoke ok");
