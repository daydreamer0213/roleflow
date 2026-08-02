const {
  DECISION_POLICY,
  assertDecisionPolicy,
  capRecommendationTier,
  decisionPolicyHash,
  isExplicitSoftRequirement
} = require("./decision_policy");

function scoreRequirementGroup(items, stateValues = DECISION_POLICY.stateValues) {
  const requirements = Array.isArray(items) ? items : [];
  const counts = {
    total: requirements.length,
    known: 0,
    matched: 0,
    transferable: 0,
    missing: 0,
    unknown: 0
  };
  let points = 0;
  for (const item of requirements) {
    const state = String(item?.state || "unknown").trim();
    if (state === "unknown") {
      counts.unknown += 1;
      continue;
    }
    if (!Object.hasOwn(stateValues, state)) {
      throw new Error(`unsupported requirement match state: ${state}`);
    }
    counts[state] += 1;
    counts.known += 1;
    points += Number(stateValues[state]);
  }
  return {
    ...counts,
    fit: counts.known ? points / counts.known : null,
    coverage: counts.total ? counts.known / counts.total : 0
  };
}

function groupRequirements(requirementMatches) {
  const groups = {
    core: [],
    supporting: [],
    soft: []
  };
  for (const item of Array.isArray(requirementMatches) ? requirementMatches : []) {
    if (isExplicitSoftRequirement(item)) {
      groups.soft.push(item);
    } else if (item?.foundation === true || item?.central === true || item?.indispensable === true) {
      groups.core.push(item);
    } else {
      groups.supporting.push(item);
    }
  }
  return groups;
}

function computeWeightedRequirementFit(requirementMatches, policy = DECISION_POLICY) {
  assertDecisionPolicy(policy);
  const groups = groupRequirements(requirementMatches);
  const core = scoreRequirementGroup(groups.core, policy.stateValues);
  const supporting = scoreRequirementGroup(groups.supporting, policy.stateValues);
  const hasCore = core.total > 0;
  const hasSupporting = supporting.total > 0;
  let combinedFit = null;
  let combinedCoverage = 0;

  if (hasCore && hasSupporting) {
    combinedCoverage = core.coverage * policy.requirementWeights.core
      + supporting.coverage * policy.requirementWeights.supporting;
    if (core.fit !== null && supporting.fit !== null) {
      combinedFit = core.fit * policy.requirementWeights.core
        + supporting.fit * policy.requirementWeights.supporting;
    } else {
      combinedFit = core.fit !== null ? core.fit : supporting.fit;
    }
  } else if (hasCore) {
    combinedFit = core.fit;
    combinedCoverage = core.coverage;
  } else if (hasSupporting) {
    combinedFit = supporting.fit;
    combinedCoverage = supporting.coverage;
  }

  return {
    groups,
    core,
    supporting,
    combinedFit,
    combinedCoverage,
    hasCore,
    hasSupporting
  };
}

function fitBand(score, policy = DECISION_POLICY) {
  assertDecisionPolicy(policy);
  if (score === null || score === undefined) return "insufficient_evidence";
  const parsed = Number(score);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("weighted fit score must be between zero and one");
  }
  if (parsed >= policy.fitThresholds.fit) return "fit";
  if (parsed >= policy.fitThresholds.mostlyFit) return "mostly_fit";
  if (parsed > 0) return "partial_fit";
  return "no_fit";
}

function matrixRecommendationFor(roleAlignment, band, policy = DECISION_POLICY) {
  assertDecisionPolicy(policy);
  const row = policy.matrix[String(roleAlignment || "").trim()];
  const recommendation = row?.[String(band || "").trim()];
  if (!recommendation) {
    throw new Error(`decision matrix cell is invalid: ${roleAlignment}/${band}`);
  }
  return recommendation;
}

function resolveRoleAlignmentForDecision(analysis = {}, policy = DECISION_POLICY) {
  const reportedRoleAlignment = String(analysis.roleAlignment || "insufficient_evidence").trim();
  const rule = policy.alignmentConsistency;
  const consistencyEvidence = (Array.isArray(analysis.requirementMatches) ? analysis.requirementMatches : [])
    .filter((item) => (
      rule.requiredEvidenceFlags.every((flag) => item?.[flag] === true)
        && rule.positiveStates.includes(item?.state)
        && (!rule.requireBoundEvidence || (
          hasEvidence(item?.jdEvidence)
            && hasEvidence(item?.resumeEvidence)
        ))
    ));
  const alignmentConsistencyAdjusted = reportedRoleAlignment === rule.source
    && consistencyEvidence.length > 0;
  return {
    reportedRoleAlignment,
    effectiveRoleAlignment: alignmentConsistencyAdjusted ? rule.target : reportedRoleAlignment,
    alignmentConsistencyAdjusted,
    alignmentConsistencyReason: alignmentConsistencyAdjusted ? "core_central_positive_evidence" : "",
    alignmentConsistencyEvidenceCount: consistencyEvidence.length
  };
}

function deriveMatrixDecision(analysis = {}, policy = DECISION_POLICY) {
  assertDecisionPolicy(policy);
  const weighted = computeWeightedRequirementFit(analysis.requirementMatches, policy);
  const alignment = resolveRoleAlignmentForDecision(analysis, policy);
  const roleAlignment = alignment.effectiveRoleAlignment;
  let band = fitBand(weighted.combinedFit, policy);
  let rescueApplied = false;
  let rescueEvidence = supportingRescueEvidence(weighted.groups.supporting, policy);

  let recommendation;
  if (roleAlignment === "insufficient_evidence" || band === "insufficient_evidence") {
    recommendation = "caution";
  } else {
    recommendation = matrixRecommendationFor(roleAlignment, band, policy);
  }

  const recommendationBeforeAlignmentCap = recommendation;
  if (alignment.alignmentConsistencyAdjusted) {
    recommendation = capRecommendationTier(
      recommendation,
      policy.alignmentConsistency.recommendationCeiling
    );
  }
  const alignmentConsistencyCapped = recommendation !== recommendationBeforeAlignmentCap;

  const noCoreCapApplied = weighted.core.total === 0 && recommendation === "primary";
  if (weighted.core.total === 0) {
    recommendation = capRecommendationTier(recommendation, "apply");
  }

  const coreUnknownCapApplied = weighted.core.total > 0
    && weighted.core.known === 0
    && ["primary", "apply"].includes(recommendation);
  if (weighted.core.total > 0 && weighted.core.known === 0) {
    recommendation = capRecommendationTier(recommendation, "caution");
  }

  const coverageCapped = weighted.combinedCoverage < policy.minEvidenceCoverageForAutoSelect
    && ["primary", "apply"].includes(recommendation);
  if (weighted.combinedCoverage < policy.minEvidenceCoverageForAutoSelect) {
    recommendation = capRecommendationTier(recommendation, "caution");
  }

  return {
    ...alignment,
    groups: weighted.groups,
    core: weighted.core,
    supporting: weighted.supporting,
    combinedFit: weighted.combinedFit,
    combinedCoverage: weighted.combinedCoverage,
    fitBand: band,
    matrixRecommendation: recommendation,
    alignmentConsistencyCapped,
    coverageCapped,
    coreUnknownCapApplied,
    noCoreCapApplied,
    rescueApplied,
    rescueEvidence,
    policyVersion: policy.version,
    policyHash: decisionPolicyHash(policy)
  };
}

function supportingRescueEvidence(items, policy) {
  const evidenceBound = (Array.isArray(items) ? items : []).map((item) => {
    if (!["matched", "transferable"].includes(item?.state)) return item;
    return hasEvidence(item?.jdEvidence) && hasEvidence(item?.resumeEvidence)
      ? item
      : { ...item, state: "unknown" };
  });
  return scoreRequirementGroup(evidenceBound, policy.stateValues);
}

function hasEvidence(value) {
  if (Array.isArray(value)) return value.some((item) => String(item || "").trim());
  return Boolean(String(value || "").trim());
}

module.exports = {
  computeWeightedRequirementFit,
  deriveMatrixDecision,
  fitBand,
  groupRequirements,
  matrixRecommendationFor,
  scoreRequirementGroup
};
