const assert = require("assert");
const {
  DECISION_POLICY,
  DECISION_POLICY_HASH,
  assertDecisionPolicy,
  defaultSelectedForBatch,
  isExplicitSoftRequirement,
  normalizeRecommendationTier
} = require("../src/core/decision_policy");
const {
  computeWeightedRequirementFit,
  deriveMatrixDecision,
  matrixRecommendationFor,
  scoreRequirementGroup
} = require("../src/core/four_tier_decision");

function requirement(state, options = {}) {
  return {
    requirement: options.requirement || "岗位要求",
    state,
    foundation: options.foundation === true,
    central: options.central === true,
    indispensable: options.indispensable === true,
    jdEvidence: options.jdEvidence || "",
    resumeEvidence: options.resumeEvidence || ""
  };
}

function core(state, options = {}) {
  return requirement(state, {
    ...options,
    foundation: options.foundation !== false
  });
}

function supporting(state, options = {}) {
  return requirement(state, options);
}

function decision(roleAlignment, requirementMatches) {
  return deriveMatrixDecision({ roleAlignment, requirementMatches });
}

function nearlyEqual(actual, expected, message) {
  assert(Math.abs(actual - expected) < 1e-12, `${message}: ${actual} !== ${expected}`);
}

assert.strictEqual(DECISION_POLICY.version, "four-tier-weighted-v2");
assert.strictEqual(DECISION_POLICY.recommendationSchemaVersion, 2);
assert.strictEqual(DECISION_POLICY.modelRecommendationMode, "shadow");
assert.strictEqual(DECISION_POLICY.requirementWeights.core, 0.70);
assert.strictEqual(DECISION_POLICY.requirementWeights.supporting, 0.30);
assert.match(DECISION_POLICY_HASH, /^[a-f0-9]{64}$/);
assert.throws(
  () => assertDecisionPolicy({
    ...DECISION_POLICY,
    requirementWeights: { core: 0.7, supporting: 0.4 }
  }),
  /sum to one/
);

assert.strictEqual(normalizeRecommendationTier("apply", 1), "primary");
assert.strictEqual(normalizeRecommendationTier("caution", 1), "apply");
assert.strictEqual(normalizeRecommendationTier("review", 1), "caution");
assert.strictEqual(normalizeRecommendationTier("skip", 1), "not_recommended");
assert.strictEqual(normalizeRecommendationTier("apply", 2), "apply");
assert.strictEqual(normalizeRecommendationTier("unknown", 2), "");

assert.strictEqual(defaultSelectedForBatch("primary"), true);
assert.strictEqual(defaultSelectedForBatch("apply"), true);
assert.strictEqual(defaultSelectedForBatch("caution"), false);
assert.strictEqual(defaultSelectedForBatch("not_recommended"), false);

assert.strictEqual(isExplicitSoftRequirement({ requirement: "有行业经验优先" }), true);
assert.strictEqual(isExplicitSoftRequirement({ requirement: "熟悉某工具者优先考虑" }), true);
assert.strictEqual(isExplicitSoftRequirement({ requirement: "相关证书属于加分项" }), true);
assert.strictEqual(isExplicitSoftRequirement({ requirement: "能够独立完成月度结算" }), false);
assert.strictEqual(isExplicitSoftRequirement({ requirement: "负责事项的优先级管理" }), false);

const matrix = {
  aligned: {
    fit: "primary",
    mostly_fit: "primary",
    partial_fit: "apply",
    no_fit: "caution"
  },
  mostly_aligned: {
    fit: "primary",
    mostly_fit: "apply",
    partial_fit: "apply",
    no_fit: "caution"
  },
  partially_aligned: {
    fit: "apply",
    mostly_fit: "caution",
    partial_fit: "caution",
    no_fit: "not_recommended"
  },
  misaligned: {
    fit: "not_recommended",
    mostly_fit: "not_recommended",
    partial_fit: "not_recommended",
    no_fit: "not_recommended"
  }
};
for (const [roleAlignment, row] of Object.entries(matrix)) {
  for (const [band, expected] of Object.entries(row)) {
    assert.strictEqual(
      matrixRecommendationFor(roleAlignment, band),
      expected,
      `${roleAlignment} + ${band}`
    );
  }
}

assert.deepStrictEqual(
  scoreRequirementGroup([
    requirement("matched"),
    requirement("transferable"),
    requirement("missing"),
    requirement("unknown")
  ]),
  {
    total: 4,
    known: 3,
    matched: 1,
    transferable: 1,
    missing: 1,
    unknown: 1,
    fit: 0.5,
    coverage: 0.75
  }
);

const weighted = computeWeightedRequirementFit([
  core("matched"),
  core("missing"),
  supporting("matched")
]);
nearlyEqual(weighted.core.fit, 0.5, "core fit");
nearlyEqual(weighted.supporting.fit, 1, "supporting fit");
nearlyEqual(weighted.combinedFit, 0.65, "combined 70/30 fit");
nearlyEqual(weighted.combinedCoverage, 1, "combined coverage");

const coreOnly = decision("aligned", [core("matched")]);
assert.strictEqual(coreOnly.matrixRecommendation, "primary");
assert.strictEqual(coreOnly.noCoreCapApplied, false);

const supportingOnly = decision("aligned", [supporting("matched")]);
assert.strictEqual(supportingOnly.matrixRecommendation, "apply");
assert.strictEqual(supportingOnly.noCoreCapApplied, true);

const declaredUnknownCore = decision("aligned", [
  core("unknown"),
  supporting("matched")
]);
assert.strictEqual(declaredUnknownCore.matrixRecommendation, "caution");
assert.strictEqual(declaredUnknownCore.coreUnknownCapApplied, true);

const lowCoverage = decision("aligned", [
  core("matched"),
  core("unknown"),
  core("unknown"),
  core("unknown")
]);
assert.strictEqual(lowCoverage.matrixRecommendation, "caution");
assert.strictEqual(lowCoverage.coverageCapped, true);

const rescued = decision("misaligned", [
  core("missing"),
  supporting("matched", {
    requirement: "完成相关业务流程",
    jdEvidence: "JD：负责相关业务流程",
    resumeEvidence: "简历：完成相邻业务流程"
  }),
  supporting("matched", {
    requirement: "使用相关业务工具",
    jdEvidence: "JD：使用相关业务工具",
    resumeEvidence: "简历：使用同类业务工具"
  }),
  supporting("missing", {
    requirement: "独立负责辅助交付",
    jdEvidence: "JD：独立负责辅助交付"
  })
]);
assert.strictEqual(rescued.matrixRecommendation, "not_recommended",
  "a fully misaligned role must not be rescued by supporting skill overlap");
assert.strictEqual(rescued.rescueApplied, false);

const lowFitNotRescued = decision("misaligned", [
  core("missing"),
  supporting("matched", {
    jdEvidence: "JD：要求 A",
    resumeEvidence: "简历：证据 A"
  }),
  supporting("missing"),
  supporting("missing")
]);
assert.strictEqual(lowFitNotRescued.matrixRecommendation, "not_recommended");
assert.strictEqual(lowFitNotRescued.rescueApplied, false);

const lowCoverageNotRescued = decision("misaligned", [
  core("missing"),
  supporting("matched", {
    jdEvidence: "JD：要求 A",
    resumeEvidence: "简历：证据 A"
  }),
  supporting("unknown"),
  supporting("unknown")
]);
assert.strictEqual(lowCoverageNotRescued.matrixRecommendation, "not_recommended");
assert.strictEqual(lowCoverageNotRescued.rescueApplied, false);

const unsupportedPositiveNotRescued = decision("misaligned", [
  core("missing"),
  supporting("matched"),
  supporting("matched"),
  supporting("missing")
]);
assert.strictEqual(unsupportedPositiveNotRescued.matrixRecommendation, "not_recommended");
assert.strictEqual(unsupportedPositiveNotRescued.rescueApplied, false);

const softItemsExcluded = computeWeightedRequirementFit([
  core("missing"),
  supporting("matched", { requirement: "有相关行业经验优先" }),
  supporting("matched", { requirement: "相关证书属于加分项" })
]);
assert.strictEqual(softItemsExcluded.groups.soft.length, 2);
assert.strictEqual(softItemsExcluded.groups.supporting.length, 0);

const insufficient = decision("insufficient_evidence", [
  core("unknown"),
  supporting("unknown")
]);
assert.strictEqual(insufficient.matrixRecommendation, "caution");
assert.strictEqual(insufficient.fitBand, "insufficient_evidence");

console.log("four_tier_decision_smoke ok");
