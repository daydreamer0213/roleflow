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

function decision(roleAlignment, requirementMatches, responsibilityMatches = []) {
  return deriveMatrixDecision({ roleAlignment, requirementMatches, responsibilityMatches });
}

function nearlyEqual(actual, expected, message) {
  assert(Math.abs(actual - expected) < 1e-12, `${message}: ${actual} !== ${expected}`);
}

assert.strictEqual(DECISION_POLICY.version, "four-tier-weighted-v4.1");
assert.strictEqual(DECISION_POLICY.recommendationSchemaVersion, 2);
assert.strictEqual(DECISION_POLICY.modelRecommendationMode, "shadow");
assert.strictEqual(DECISION_POLICY.requirementWeights.core, 0.70);
assert.strictEqual(DECISION_POLICY.requirementWeights.supporting, 0.30);
assert.strictEqual(DECISION_POLICY.alignmentConsistency.recommendationCeiling, "caution");
assert.match(DECISION_POLICY_HASH, /^[a-f0-9]{64}$/);
assert.throws(
  () => assertDecisionPolicy({
    ...DECISION_POLICY,
    requirementWeights: { core: 0.7, supporting: 0.4 }
  }),
  /sum to one/
);
assert.throws(
  () => assertDecisionPolicy({
    ...DECISION_POLICY,
    responsibilityAlignment: {
      ...DECISION_POLICY.responsibilityAlignment,
      stateValues: {
        ...DECISION_POLICY.responsibilityAlignment.stateValues,
        missing: 0.1
      }
    }
  }),
  /responsibility state values must preserve/
);
assert.throws(
  () => assertDecisionPolicy({
    ...DECISION_POLICY,
    responsibilityAlignment: {
      ...DECISION_POLICY.responsibilityAlignment,
      stateValues: {
        ...DECISION_POLICY.responsibilityAlignment.stateValues,
        transferable: 1,
        matched: 0.5
      }
    }
  }),
  /responsibility state values must preserve/
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

const adjacentByCoreCentralEvidence = decision("misaligned", [
  core("transferable", {
    central: true,
    jdEvidence: "JD：核心交付要求",
    resumeEvidence: "简历：相邻交付证据"
  }),
  core("unknown", { central: true })
]);
assert.strictEqual(adjacentByCoreCentralEvidence.reportedRoleAlignment, "misaligned");
assert.strictEqual(adjacentByCoreCentralEvidence.effectiveRoleAlignment, "partially_aligned");
assert.strictEqual(adjacentByCoreCentralEvidence.alignmentConsistencyAdjusted, true);
assert.strictEqual(adjacentByCoreCentralEvidence.alignmentConsistencyReason, "core_central_positive_evidence");
assert.strictEqual(adjacentByCoreCentralEvidence.matrixRecommendation, "caution",
  "evidence-backed foundation-and-central transfer contradicts a fully misaligned direction");

const matchedConsistencyAdjustment = decision("misaligned", [
  core("matched", {
    central: true,
    jdEvidence: "JD：同一核心交付",
    resumeEvidence: "简历：同一核心交付证据"
  })
]);
assert.strictEqual(matchedConsistencyAdjustment.fitBand, "fit");
assert.strictEqual(matchedConsistencyAdjustment.effectiveRoleAlignment, "partially_aligned");
assert.strictEqual(matchedConsistencyAdjustment.matrixRecommendation, "caution",
  "a reported misalignment must never be normalized directly into a default-selected tier");
assert.strictEqual(matchedConsistencyAdjustment.alignmentConsistencyCapped, true);

const foundationOnlyNotAdjusted = decision("misaligned", [
  core("matched", {
    central: false,
    jdEvidence: "JD：基础要求",
    resumeEvidence: "简历：基础证据"
  })
]);
assert.strictEqual(foundationOnlyNotAdjusted.effectiveRoleAlignment, "misaligned");
assert.strictEqual(foundationOnlyNotAdjusted.matrixRecommendation, "not_recommended");

const centralOnlyNotAdjusted = decision("misaligned", [
  requirement("matched", {
    foundation: false,
    central: true,
    jdEvidence: "JD：核心要求",
    resumeEvidence: "简历：核心证据"
  })
]);
assert.strictEqual(centralOnlyNotAdjusted.effectiveRoleAlignment, "misaligned");
assert.strictEqual(centralOnlyNotAdjusted.matrixRecommendation, "not_recommended");

const unboundCoreCentralNotAdjusted = decision("misaligned", [
  core("transferable", {
    central: true,
    jdEvidence: "JD：核心交付要求"
  })
]);
assert.strictEqual(unboundCoreCentralNotAdjusted.effectiveRoleAlignment, "misaligned");
assert.strictEqual(unboundCoreCentralNotAdjusted.matrixRecommendation, "not_recommended");

const dutyEvidenceRecoversAdjacentRole = decision("misaligned", [
  core("unknown", { central: true })
], [
  { id: "D1", state: "transferable", jdEvidence: "JD：相邻主要职责", resumeEvidence: "简历：可迁移职责证据" },
  { id: "D2", state: "unknown", jdEvidence: "JD：另一主要职责", resumeEvidence: "" }
]);
assert.strictEqual(dutyEvidenceRecoversAdjacentRole.effectiveRoleAlignment, "partially_aligned");
assert.strictEqual(dutyEvidenceRecoversAdjacentRole.alignmentAdjustmentSource, "responsibility_evidence");
assert.strictEqual(dutyEvidenceRecoversAdjacentRole.matrixRecommendation, "caution");

const dutyEvidencePromotesPartialRole = decision("partially_aligned", [
  core("matched", { central: true })
], [
  { id: "D1", state: "matched", jdEvidence: "JD：主要职责一", resumeEvidence: "简历：直接职责证据" },
  { id: "D2", state: "transferable", jdEvidence: "JD：主要职责二", resumeEvidence: "简历：可迁移职责证据" }
]);
assert.strictEqual(dutyEvidencePromotesPartialRole.responsibilityAlignment, "mostly_aligned");
assert.strictEqual(dutyEvidencePromotesPartialRole.effectiveRoleAlignment, "mostly_aligned");
assert.strictEqual(dutyEvidencePromotesPartialRole.matrixRecommendation, "apply",
  "responsibility evidence may recover an adjacent role only into a default-selected apply tier");

const knownDutyEvidenceIgnoresUnknownRows = decision("partially_aligned", [
  core("matched", { central: true })
], [
  { id: "D1", state: "transferable", jdEvidence: "JD：主要职责一", resumeEvidence: "简历：可迁移职责证据一" },
  { id: "D2", state: "transferable", jdEvidence: "JD：主要职责二", resumeEvidence: "简历：可迁移职责证据二" },
  { id: "D3", state: "unknown", jdEvidence: "JD：主要职责三", resumeEvidence: "" }
]);
nearlyEqual(knownDutyEvidenceIgnoresUnknownRows.responsibilityScore, 0.5,
  "unknown duties must not be scored as confirmed missing duties");
nearlyEqual(knownDutyEvidenceIgnoresUnknownRows.responsibilityCoverage, 2 / 3,
  "known duty coverage must remain separately observable");
assert.strictEqual(knownDutyEvidenceIgnoresUnknownRows.responsibilityAlignment, "mostly_aligned");
assert.strictEqual(knownDutyEvidenceIgnoresUnknownRows.effectiveRoleAlignment, "mostly_aligned");
assert.strictEqual(knownDutyEvidenceIgnoresUnknownRows.matrixRecommendation, "apply",
  "two known transferable duties with majority coverage may retain a default-selected opportunity");

const dutyEvidenceCapsOverstatedRole = decision("mostly_aligned", [
  core("matched", { central: true })
], [
  { id: "D1", state: "transferable", jdEvidence: "JD：主要职责一", resumeEvidence: "简历：可迁移职责证据" },
  { id: "D2", state: "unknown", jdEvidence: "JD：主要职责二", resumeEvidence: "" }
]);
assert.strictEqual(dutyEvidenceCapsOverstatedRole.responsibilityAlignment, "partially_aligned");
assert.strictEqual(dutyEvidenceCapsOverstatedRole.effectiveRoleAlignment, "partially_aligned");
assert.strictEqual(dutyEvidenceCapsOverstatedRole.matrixRecommendation, "caution");

const confirmedDutyMismatch = decision("misaligned", [
  core("missing", {
    central: true,
    jdEvidence: "JD：核心职责要求",
    resumeEvidence: "简历：明确不同的核心职责"
  })
], [
  { id: "D1", state: "missing", jdEvidence: "JD：主要职责一", resumeEvidence: "简历：明确不同的职责证据" },
  { id: "D2", state: "missing", jdEvidence: "JD：主要职责二", resumeEvidence: "简历：明确不同的交付证据" }
]);
assert.strictEqual(confirmedDutyMismatch.responsibilityAlignment, "misaligned");
assert.strictEqual(confirmedDutyMismatch.effectiveRoleAlignment, "misaligned");
assert.strictEqual(confirmedDutyMismatch.matrixRecommendation, "not_recommended");

const partialClaimWithMissingDuties = decision("partially_aligned", [
  core("matched", {
    central: true,
    jdEvidence: "JD：核心要求",
    resumeEvidence: "简历：核心要求证据"
  })
], [
  { id: "D1", state: "missing", jdEvidence: "JD：主要职责一", resumeEvidence: "简历：明确不同的职责证据" },
  { id: "D2", state: "missing", jdEvidence: "JD：主要职责二", resumeEvidence: "简历：明确不同的交付证据" }
]);
assert.strictEqual(partialClaimWithMissingDuties.responsibilityAlignment, "misaligned");
assert.strictEqual(partialClaimWithMissingDuties.effectiveRoleAlignment, "partially_aligned");
assert.strictEqual(partialClaimWithMissingDuties.matrixRecommendation, "caution",
  "a partial claim with fully mismatched primary duties must stay outside default communication");

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
