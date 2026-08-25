const assert = require("node:assert/strict");
const { deriveMatrixDecision } = require("../src/core/four_tier_decision");
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

console.log("scalar_shadow_scorecard_smoke ok");
