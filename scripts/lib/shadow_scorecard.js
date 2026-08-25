const {
  DECISION_POLICY,
  assertDecisionPolicy,
  capRecommendationTier,
  decisionPolicyHash
} = require("../../src/core/decision_policy");
const { deriveMatrixDecision } = require("../../src/core/four_tier_decision");

const SHADOW_SCORECARD_VERSION = "shadow-scorecard-v1";

function buildShadowScorecard(input, policy = DECISION_POLICY) {
  assertDecisionPolicy(policy);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("shadow scorecard input must be an object");
  }

  const productionDecision = deriveMatrixDecision({
    roleAlignment: input.roleAlignment,
    responsibilityMatches: input.responsibilityMatches,
    requirementMatches: input.requirementMatches
  }, policy);
  const requirements = productionRequirements(productionDecision);
  const responsibilities = productionResponsibilities(productionDecision);
  const hardBoundary = inspectBoundaries(input.boundaries, input.risks);
  const score = {
    roleAlignment: productionDecision.reportedRoleAlignment,
    effectiveRoleAlignment: productionDecision.effectiveRoleAlignment,
    weightedFit: requirements.weightedFit,
    fitBand: productionDecision.fitBand,
    productionMatrixTier: productionDecision.matrixRecommendation,
    policyVersion: String(policy.version),
    policyHash: decisionPolicyHash(policy)
  };
  const evidenceCoverage = {
    overall: requirements.weightedCoverage,
    requirements: requirements.weightedCoverage,
    responsibilities: responsibilities.coverage,
    roleAlignment: productionDecision.effectiveRoleAlignment === "insufficient_evidence" ? 0 : 1,
    minimumForAutoSelect: policy.minEvidenceCoverageForAutoSelect
  };
  const reasons = [];
  let candidateTier = productionDecision.matrixRecommendation;

  if (hardBoundary.blocked) {
    candidateTier = "not_recommended";
    reasons.push({ code: "verified_hard_boundary", severity: "block" });
  }
  if (hardBoundary.severeRisk) {
    candidateTier = "not_recommended";
    reasons.push({ code: "verified_severe_risk", severity: "block" });
  }
  if (productionDecision.fitBand === "insufficient_evidence"
    || productionDecision.effectiveRoleAlignment === "insufficient_evidence") {
    reasons.push({ code: "insufficient_role_alignment_evidence", severity: "cap" });
  }
  if (productionDecision.combinedCoverage < policy.minEvidenceCoverageForAutoSelect) {
    reasons.push({ code: "low_evidence_coverage", severity: "cap" });
  }
  if (!requirements.hasCore) {
    reasons.push({ code: "no_declared_core_requirement", severity: "cap" });
  } else if (requirements.core.known === 0) {
    reasons.push({ code: "unknown_core_requirements", severity: "cap" });
  }
  if (productionDecision.alignmentConsistencyCapped) {
    reasons.push({ code: "alignment_consistency_cap", severity: "cap" });
  }
  if (productionDecision.responsibilityFoundationCeilingApplied
    || productionDecision.responsibilityConfirmedDutyGapCeilingApplied) {
    reasons.push({ code: "responsibility_safety_cap", severity: "cap" });
  }
  if (productionDecision.responsibilityPromotionFloorApplied) {
    reasons.push({ code: "responsibility_promotion_floor", severity: "promotion" });
  }
  if (hardBoundary.riskCap) {
    candidateTier = capRecommendationTier(candidateTier, "caution");
    reasons.push({ code: "verified_risk_cap", severity: "cap" });
  }
  if (reasons.length === 0) reasons.push({ code: "weighted_matrix_candidate", severity: "diagnostic" });

  return {
    version: SHADOW_SCORECARD_VERSION,
    dimensions: {
      roleAlignment: {
        value: productionDecision.reportedRoleAlignment,
        effectiveValue: productionDecision.effectiveRoleAlignment
      },
      responsibilities,
      requirements: {
        core: requirements.core,
        supporting: requirements.supporting,
        softCount: requirements.softCount,
        weightedFit: requirements.weightedFit,
        weightedCoverage: requirements.weightedCoverage,
        fitBand: score.fitBand
      }
    },
    evidenceCoverage,
    hardBoundary: {
      blocked: hardBoundary.blocked,
      severeRisk: hardBoundary.severeRisk,
      riskCap: hardBoundary.riskCap,
      sources: hardBoundary.sources
    },
    score,
    candidateTier,
    reasons
  };
}

function productionRequirements(decision) {
  return {
    core: decision.core,
    supporting: decision.supporting,
    softCount: decision.groups.soft.length,
    weightedFit: decision.combinedFit,
    weightedCoverage: decision.combinedCoverage,
    hasCore: decision.core.total > 0,
    hasSupporting: decision.supporting.total > 0
  };
}

function productionResponsibilities(decision) {
  return {
    total: decision.responsibilityTotalCount,
    known: decision.responsibilityKnownCount,
    fit: decision.responsibilityScore,
    coverage: decision.responsibilityCoverage
  };
}

function inspectBoundaries(boundaries, risks) {
  const sources = [];
  let blocked = false;
  for (const item of asItems(boundaries)) {
    if (item?.verified === true && (item.blocked === true || item.incompatible === true || item.state === "blocked")) {
      blocked = true;
      sources.push({ type: "boundary", reason: String(item.reason || "verified boundary") });
    }
  }
  let severeRisk = false;
  let riskCap = false;
  for (const item of asItems(risks)) {
    if (item?.verified !== true) continue;
    const severity = String(item.severity || "").trim().toLowerCase();
    if (["critical", "severe"].includes(severity)) {
      severeRisk = true;
      sources.push({ type: "risk", severity });
    } else if (["high", "medium"].includes(severity)) {
      riskCap = true;
      sources.push({ type: "risk", severity });
    }
  }
  return { blocked, severeRisk, riskCap, sources };
}

function asItems(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    return Array.isArray(value.items) ? value.items : [value];
  }
  return [];
}

function hasEvidence(value) {
  return Boolean(String(value || "").trim());
}

module.exports = {
  SHADOW_SCORECARD_VERSION,
  buildShadowScorecard,
  inspectBoundaries
};
