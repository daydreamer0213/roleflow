const {
  DECISION_POLICY,
  assertDecisionPolicy,
  capRecommendationTier,
  decisionPolicyHash,
  isExplicitSoftRequirement
} = require("../../src/core/decision_policy");

const SHADOW_SCORECARD_VERSION = "shadow-scorecard-v1";
const VALID_REQUIREMENT_STATES = new Set(["matched", "transferable", "missing", "unknown"]);

function buildShadowScorecard(input = {}, policy = DECISION_POLICY) {
  assertDecisionPolicy(policy);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("shadow scorecard input must be an object");
  }

  const roleAlignment = normalizeRoleAlignment(input.roleAlignment);
  const requirements = scoreRequirements(input.requirementMatches, policy);
  const responsibilities = scoreResponsibilities(input.responsibilityMatches, policy);
  const hardBoundary = inspectBoundaries(input.boundaries, input.risks);
  const score = {
    roleAlignment,
    weightedFit: requirements.weightedFit,
    fitBand: fitBand(requirements.weightedFit, policy),
    policyVersion: String(policy.version),
    policyHash: decisionPolicyHash(policy)
  };
  const evidenceCoverage = {
    overall: requirements.weightedCoverage,
    requirements: requirements.weightedCoverage,
    responsibilities: responsibilities.coverage,
    roleAlignment: roleAlignment === "insufficient_evidence" ? 0 : 1,
    minimumForAutoSelect: policy.minEvidenceCoverageForAutoSelect
  };
  const reasons = [];
  let candidateTier = matrixTier(roleAlignment, score.fitBand, policy);

  if (hardBoundary.blocked) {
    candidateTier = "not_recommended";
    reasons.push({ code: "verified_hard_boundary", severity: "block" });
  }
  if (hardBoundary.severeRisk) {
    candidateTier = "not_recommended";
    reasons.push({ code: "verified_severe_risk", severity: "block" });
  }
  if (roleAlignment === "insufficient_evidence") {
    candidateTier = capRecommendationTier(candidateTier, "caution");
    reasons.push({ code: "insufficient_role_alignment_evidence", severity: "cap" });
  }
  if (requirements.weightedCoverage < policy.minEvidenceCoverageForAutoSelect) {
    candidateTier = capRecommendationTier(candidateTier, "caution");
    reasons.push({ code: "low_evidence_coverage", severity: "cap" });
  }
  if (!requirements.hasCore) {
    candidateTier = capRecommendationTier(candidateTier, "apply");
    reasons.push({ code: "no_declared_core_requirement", severity: "cap" });
  } else if (requirements.core.known === 0) {
    candidateTier = capRecommendationTier(candidateTier, "caution");
    reasons.push({ code: "unknown_core_requirements", severity: "cap" });
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
        value: roleAlignment
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

function normalizeRoleAlignment(value) {
  const normalized = String(value || "").trim();
  return ["aligned", "mostly_aligned", "partially_aligned", "misaligned"].includes(normalized)
    ? normalized
    : "insufficient_evidence";
}

function scoreRequirements(items, policy) {
  const groups = { core: [], supporting: [], soft: [] };
  for (const item of asItems(items)) {
    if (isExplicitSoftRequirement(item)) {
      groups.soft.push(item);
    } else if (item?.foundation === true || item?.central === true || item?.indispensable === true) {
      groups.core.push(item);
    } else {
      groups.supporting.push(item);
    }
  }
  const core = scoreGroup(groups.core, policy.stateValues);
  const supporting = scoreGroup(groups.supporting, policy.stateValues);
  const hasCore = core.total > 0;
  const hasSupporting = supporting.total > 0;
  let weightedFit = null;
  let weightedCoverage = 0;
  if (hasCore && hasSupporting) {
    weightedCoverage = core.coverage * policy.requirementWeights.core
      + supporting.coverage * policy.requirementWeights.supporting;
    weightedFit = core.fit === null ? supporting.fit
      : supporting.fit === null ? core.fit
        : core.fit * policy.requirementWeights.core + supporting.fit * policy.requirementWeights.supporting;
  } else if (hasCore) {
    weightedFit = core.fit;
    weightedCoverage = core.coverage;
  } else if (hasSupporting) {
    weightedFit = supporting.fit;
    weightedCoverage = supporting.coverage;
  }
  return {
    core,
    supporting,
    softCount: groups.soft.length,
    weightedFit,
    weightedCoverage,
    hasCore,
    hasSupporting
  };
}

function scoreGroup(items, stateValues) {
  const counts = { total: items.length, known: 0, matched: 0, transferable: 0, missing: 0, unknown: 0 };
  let points = 0;
  for (const item of items) {
    const state = String(item?.state || "unknown").trim();
    if (!VALID_REQUIREMENT_STATES.has(state)) throw new Error(`unsupported requirement match state: ${state}`);
    counts[state] += 1;
    if (state === "unknown") continue;
    counts.known += 1;
    points += Number(stateValues[state]);
  }
  return {
    ...counts,
    fit: counts.known ? points / counts.known : null,
    coverage: counts.total ? counts.known / counts.total : 0
  };
}

function scoreResponsibilities(items, policy) {
  const matches = asItems(items);
  let known = 0;
  let points = 0;
  for (const item of matches) {
    const state = String(item?.state || "unknown").trim();
    if (!Object.hasOwn(policy.responsibilityAlignment.stateValues, state)
      || state === "unknown"
      || !hasEvidence(item?.jdEvidence)
      || !hasEvidence(item?.resumeEvidence)) continue;
    known += 1;
    points += Number(policy.responsibilityAlignment.stateValues[state]);
  }
  return {
    total: matches.length,
    known,
    fit: known ? points / known : null,
    coverage: matches.length ? known / matches.length : 0
  };
}

function fitBand(value, policy) {
  if (value === null || value === undefined) return "insufficient_evidence";
  if (value >= policy.fitThresholds.fit) return "fit";
  if (value >= policy.fitThresholds.mostlyFit) return "mostly_fit";
  if (value > 0) return "partial_fit";
  return "no_fit";
}

function matrixTier(roleAlignment, band, policy) {
  if (roleAlignment === "insufficient_evidence" || band === "insufficient_evidence") return "caution";
  const tier = policy.matrix[roleAlignment]?.[band];
  if (!tier) throw new Error(`decision matrix cell is invalid: ${roleAlignment}/${band}`);
  return tier;
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
  buildShadowScorecard
};
