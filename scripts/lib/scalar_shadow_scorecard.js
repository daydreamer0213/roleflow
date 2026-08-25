const {
  DECISION_POLICY,
  assertDecisionPolicy,
  capRecommendationTier,
  decisionPolicyHash
} = require("../../src/core/decision_policy");
const { deriveMatrixDecision } = require("../../src/core/four_tier_decision");
const { inspectBoundaries } = require("./shadow_scorecard");

const SCALAR_SHADOW_SCORECARD_VERSION = "scalar-shadow-scorecard-v1";
const SCALAR_SHADOW_POLICY = deepFreeze({
  version: "scalar-joint-v1",
  weights: { responsibilities: 0.4, requirements: 0.6 },
  thresholds: { primary: 0.8, apply: 0.5 }
});

function buildScalarShadowScorecard(input, decisionPolicy = DECISION_POLICY) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("scalar shadow scorecard input must be an object");
  }
  assertDecisionPolicy(decisionPolicy);
  const normalized = deriveMatrixDecision({
    roleAlignment: input.roleAlignment,
    responsibilityMatches: input.responsibilityMatches,
    requirementMatches: input.requirementMatches
  }, decisionPolicy);
  const boundaries = inspectBoundaries(input.boundaries, input.risks);
  const responsibilityScore = normalized.responsibilityScore;
  const requirementScore = normalized.combinedFit;
  const score = responsibilityScore == null || requirementScore == null
    ? null
    : rounded(
        responsibilityScore * SCALAR_SHADOW_POLICY.weights.responsibilities
          + requirementScore * SCALAR_SHADOW_POLICY.weights.requirements
      );
  const rawTier = scalarTier(score);
  const guardrails = [];
  let candidateTier = rawTier;

  if (boundaries.blocked) {
    candidateTier = "not_recommended";
    guardrails.push({ code: "verified_hard_boundary", effect: "block" });
  }
  if (boundaries.severeRisk) {
    candidateTier = "not_recommended";
    guardrails.push({ code: "verified_severe_risk", effect: "block" });
  }
  if (normalized.effectiveRoleAlignment === "misaligned") {
    candidateTier = "not_recommended";
    guardrails.push({ code: "role_direction_misaligned", effect: "block" });
  }

  if (score == null || normalized.effectiveRoleAlignment === "insufficient_evidence") {
    candidateTier = capRecommendationTier(candidateTier, "caution");
    guardrails.push({ code: "insufficient_joint_score", effect: "cap" });
  }
  if (normalized.combinedCoverage < decisionPolicy.minEvidenceCoverageForAutoSelect) {
    candidateTier = capRecommendationTier(candidateTier, "caution");
    guardrails.push({ code: "low_requirement_coverage", effect: "cap" });
  }
  if (normalized.responsibilityKnownCount < decisionPolicy.responsibilityAlignment.minimumKnownCount
    || normalized.responsibilityCoverage < decisionPolicy.responsibilityAlignment.minimumKnownCoverage) {
    candidateTier = capRecommendationTier(candidateTier, "caution");
    guardrails.push({ code: "low_responsibility_coverage", effect: "cap" });
  }
  if (normalized.core.total === 0) {
    candidateTier = capRecommendationTier(candidateTier, "caution");
    guardrails.push({ code: "no_declared_core_requirement", effect: "cap" });
  } else if (normalized.core.known === 0) {
    candidateTier = capRecommendationTier(candidateTier, "caution");
    guardrails.push({ code: "unknown_core_requirements", effect: "cap" });
  }
  if (normalized.responsibilityFoundationMissingCount > 0) {
    candidateTier = capRecommendationTier(candidateTier, "caution");
    guardrails.push({ code: "confirmed_foundation_gap", effect: "cap" });
  }
  if (normalized.responsibilityConfirmedDutyGapCeilingApplied) {
    candidateTier = capRecommendationTier(candidateTier, "caution");
    guardrails.push({ code: "confirmed_duty_gap", effect: "cap" });
  }
  if (boundaries.riskCap) {
    candidateTier = capRecommendationTier(candidateTier, "caution");
    guardrails.push({ code: "verified_risk_cap", effect: "cap" });
  }

  return {
    version: SCALAR_SHADOW_SCORECARD_VERSION,
    policy: SCALAR_SHADOW_POLICY,
    decisionPolicyVersion: String(decisionPolicy.version),
    decisionPolicyHash: decisionPolicyHash(decisionPolicy),
    productionMatrixTier: normalized.matrixRecommendation,
    score: {
      value: score,
      responsibilities: responsibilityScore,
      requirements: requirementScore,
      formula: "responsibilities:0.4+requirements:0.6"
    },
    evidenceCoverage: {
      responsibilities: normalized.responsibilityCoverage,
      requirements: normalized.combinedCoverage,
      minimumResponsibilities: decisionPolicy.responsibilityAlignment.minimumKnownCoverage,
      minimumRequirements: decisionPolicy.minEvidenceCoverageForAutoSelect
    },
    effectiveRoleAlignment: normalized.effectiveRoleAlignment,
    hardBoundary: {
      blocked: boundaries.blocked,
      severeRisk: boundaries.severeRisk,
      riskCap: boundaries.riskCap,
      sources: boundaries.sources
    },
    rawTier,
    candidateTier,
    guardrails
  };
}

function scalarTier(score) {
  if (score == null) return "caution";
  if (score >= SCALAR_SHADOW_POLICY.thresholds.primary) return "primary";
  if (score >= SCALAR_SHADOW_POLICY.thresholds.apply) return "apply";
  if (score > 0) return "caution";
  return "not_recommended";
}

function rounded(value) {
  return Math.round(value * 1e12) / 1e12;
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") deepFreeze(child);
  }
  return Object.freeze(value);
}

module.exports = {
  SCALAR_SHADOW_POLICY,
  SCALAR_SHADOW_SCORECARD_VERSION,
  buildScalarShadowScorecard
};
