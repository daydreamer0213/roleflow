const crypto = require("crypto");

const RECOMMENDATION_SCHEMA_VERSION = 2;
const RECOMMENDATION_TIERS = Object.freeze([
  "primary",
  "apply",
  "caution",
  "not_recommended"
]);
const ROLE_ALIGNMENT_ROWS = Object.freeze([
  "aligned",
  "mostly_aligned",
  "partially_aligned",
  "misaligned"
]);
const FIT_BANDS = Object.freeze([
  "fit",
  "mostly_fit",
  "partial_fit",
  "no_fit"
]);

const DECISION_POLICY = deepFreeze({
  version: "four-tier-weighted-v4.3",
  recommendationSchemaVersion: RECOMMENDATION_SCHEMA_VERSION,
  recommendationTiers: [...RECOMMENDATION_TIERS],
  modelRecommendationMode: "shadow",
  requirementWeights: {
    core: 0.70,
    supporting: 0.30
  },
  stateValues: {
    matched: 1,
    transferable: 0.5,
    missing: 0
  },
  fitThresholds: {
    fit: 0.80,
    mostlyFit: 0.50
  },
  minEvidenceCoverageForAutoSelect: 0.60,
  supportingRescue: {
    minFit: 0.50,
    minCoverage: 0.60
  },
  alignmentConsistency: {
    source: "misaligned",
    target: "partially_aligned",
    requiredEvidenceFlags: ["foundation", "central"],
    positiveStates: ["matched", "transferable"],
    requireBoundEvidence: true,
    recommendationCeiling: "caution"
  },
  responsibilityAlignment: {
    stateValues: {
      matched: 1,
      transferable: 0.5,
      missing: 0,
      unknown: 0
    },
    minimumKnownCount: 2,
    minimumKnownCoverage: 0.5,
    thresholds: {
      aligned: 0.80,
      mostlyAligned: 0.50
    },
    jointFit: {
      responsibilityWeight: 0.40,
      requirementWeight: 0.60,
      promotionThreshold: 0.50,
      heavyDutyMissingRatio: 0.50,
      minimumPositiveDutyCount: 2,
      minimumCorePositiveForHeavyDutyGap: 2,
      heavyDutyRecoveryMinimumRequirementFit: 0.95,
      foundationMissingCeiling: "caution"
    },
    promotionCeiling: "apply",
    contradictionCeiling: "caution"
  },
  defaultBatchSelection: {
    primary: true,
    apply: true,
    caution: false,
    not_recommended: false
  },
  matrix: {
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
  }
});

assertDecisionPolicy(DECISION_POLICY);
const DECISION_POLICY_HASH = decisionPolicyHash(DECISION_POLICY);

function assertDecisionPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("decision policy must be an object");
  }
  if (!["off", "shadow"].includes(policy.modelRecommendationMode)) {
    throw new Error("model recommendation mode must be off or shadow");
  }
  if (!sameValues(policy.recommendationTiers, RECOMMENDATION_TIERS)) {
    throw new Error("decision policy must define the canonical recommendation tiers");
  }

  const coreWeight = finiteUnit(policy.requirementWeights?.core, "core requirement weight");
  const supportingWeight = finiteUnit(policy.requirementWeights?.supporting, "supporting requirement weight");
  if (Math.abs(coreWeight + supportingWeight - 1) > 1e-12) {
    throw new Error("requirement weights must sum to one");
  }

  const fit = finiteUnit(policy.fitThresholds?.fit, "fit threshold");
  const mostlyFit = finiteUnit(policy.fitThresholds?.mostlyFit, "mostly-fit threshold");
  if (mostlyFit >= fit) {
    throw new Error("mostly-fit threshold must be lower than fit threshold");
  }
  finiteUnit(policy.minEvidenceCoverageForAutoSelect, "minimum evidence coverage");
  finiteUnit(policy.supportingRescue?.minFit, "supporting rescue fit");
  finiteUnit(policy.supportingRescue?.minCoverage, "supporting rescue coverage");
  if (!ROLE_ALIGNMENT_ROWS.includes(policy.alignmentConsistency?.source)
    || !ROLE_ALIGNMENT_ROWS.includes(policy.alignmentConsistency?.target)
    || policy.alignmentConsistency.source === policy.alignmentConsistency.target) {
    throw new Error("alignment consistency must define distinct canonical source and target rows");
  }
  if (!sameValues(policy.alignmentConsistency?.requiredEvidenceFlags, ["foundation", "central"])) {
    throw new Error("alignment consistency must require foundation and central evidence");
  }
  if (!sameValues(policy.alignmentConsistency?.positiveStates, ["matched", "transferable"])) {
    throw new Error("alignment consistency must use matched and transferable evidence");
  }
  if (policy.alignmentConsistency?.requireBoundEvidence !== true) {
    throw new Error("alignment consistency must require bound JD and resume evidence");
  }
  if (policy.alignmentConsistency?.recommendationCeiling !== "caution") {
    throw new Error("alignment consistency must stay outside default batch selection");
  }
  for (const state of ["matched", "transferable", "missing", "unknown"]) {
    finiteUnit(policy.responsibilityAlignment?.stateValues?.[state], `${state} responsibility value`);
  }
  const responsibilityValues = policy.responsibilityAlignment.stateValues;
  if (responsibilityValues.matched !== 1
    || responsibilityValues.missing !== 0
    || responsibilityValues.unknown !== 0
    || responsibilityValues.matched < responsibilityValues.transferable) {
    throw new Error("responsibility state values must preserve matched=1, missing=0, unknown=0, and matched>=transferable");
  }
  const minimumKnownCount = policy.responsibilityAlignment?.minimumKnownCount;
  if (!Number.isInteger(minimumKnownCount) || minimumKnownCount < 1) {
    throw new Error("minimum known responsibility count must be a positive integer");
  }
  const minimumKnownCoverage = finiteUnit(
    policy.responsibilityAlignment?.minimumKnownCoverage,
    "minimum known responsibility coverage"
  );
  if (minimumKnownCoverage <= 0) {
    throw new Error("minimum known responsibility coverage must be greater than zero");
  }
  const dutyAligned = finiteUnit(
    policy.responsibilityAlignment?.thresholds?.aligned,
    "aligned responsibility threshold"
  );
  const dutyMostly = finiteUnit(
    policy.responsibilityAlignment?.thresholds?.mostlyAligned,
    "mostly-aligned responsibility threshold"
  );
  if (dutyMostly >= dutyAligned) {
    throw new Error("mostly-aligned responsibility threshold must be lower than aligned");
  }
  const jointFit = policy.responsibilityAlignment?.jointFit;
  const jointResponsibilityWeight = finiteUnit(
    jointFit?.responsibilityWeight,
    "joint responsibility weight"
  );
  const jointRequirementWeight = finiteUnit(
    jointFit?.requirementWeight,
    "joint requirement weight"
  );
  if (Math.abs(jointResponsibilityWeight + jointRequirementWeight - 1) > 1e-12) {
    throw new Error("joint responsibility and requirement weights must sum to one");
  }
  finiteUnit(jointFit?.promotionThreshold, "joint promotion threshold");
  finiteUnit(jointFit?.heavyDutyMissingRatio, "heavy duty missing ratio");
  if (!Number.isInteger(jointFit?.minimumPositiveDutyCount)
    || jointFit.minimumPositiveDutyCount < 2) {
    throw new Error("joint promotion must require at least two positive duties");
  }
  if (!Number.isInteger(jointFit?.minimumCorePositiveForHeavyDutyGap)
    || jointFit.minimumCorePositiveForHeavyDutyGap < 2) {
    throw new Error("heavy duty gap recovery must require at least two positive core requirements");
  }
  const heavyDutyRecoveryMinimumRequirementFit = finiteUnit(
    jointFit?.heavyDutyRecoveryMinimumRequirementFit,
    "heavy duty recovery minimum requirement fit"
  );
  if (heavyDutyRecoveryMinimumRequirementFit < jointFit.promotionThreshold) {
    throw new Error("heavy duty recovery fit must not be lower than the normal promotion threshold");
  }
  if (jointFit?.foundationMissingCeiling !== "caution") {
    throw new Error("a missing foundation must stay outside default batch selection");
  }
  if (policy.responsibilityAlignment?.promotionCeiling !== "apply"
    || policy.responsibilityAlignment?.contradictionCeiling !== "caution") {
    throw new Error("responsibility alignment ceilings must preserve batch safety");
  }

  for (const state of ["matched", "transferable", "missing"]) {
    finiteUnit(policy.stateValues?.[state], `${state} state value`);
  }
  if (policy.stateValues.matched !== 1 || policy.stateValues.missing !== 0) {
    throw new Error("matched and missing state values must remain bounded at one and zero");
  }

  if (!sameValues(Object.keys(policy.matrix || {}), ROLE_ALIGNMENT_ROWS)) {
    throw new Error("decision matrix must define exactly four role-alignment rows");
  }
  for (const roleAlignment of ROLE_ALIGNMENT_ROWS) {
    const row = policy.matrix[roleAlignment];
    if (!sameValues(Object.keys(row || {}), FIT_BANDS)) {
      throw new Error(`decision matrix row ${roleAlignment} must define exactly four fit bands`);
    }
    for (const band of FIT_BANDS) {
      if (!RECOMMENDATION_TIERS.includes(row[band])) {
        throw new Error(`decision matrix cell ${roleAlignment}/${band} has an invalid tier`);
      }
    }
  }

  if (!sameValues(Object.keys(policy.defaultBatchSelection || {}), RECOMMENDATION_TIERS)) {
    throw new Error("default batch selection must define exactly four recommendation tiers");
  }
  if (policy.defaultBatchSelection.primary !== true
    || policy.defaultBatchSelection.apply !== true
    || policy.defaultBatchSelection.caution !== false
    || policy.defaultBatchSelection.not_recommended !== false) {
    throw new Error("default batch selection must select only primary and apply");
  }
  return true;
}

function decisionPolicyHash(policy = DECISION_POLICY) {
  assertDecisionPolicy(policy);
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(policy))).digest("hex");
}

function normalizeRecommendationTier(value, schemaVersion = RECOMMENDATION_SCHEMA_VERSION) {
  const normalized = String(value || "").trim().toLowerCase();
  if (Number(schemaVersion) >= RECOMMENDATION_SCHEMA_VERSION) {
    return RECOMMENDATION_TIERS.includes(normalized) ? normalized : "";
  }
  return {
    apply: "primary",
    caution: "apply",
    review: "caution",
    skip: "not_recommended",
    primary: "primary",
    talk: "apply",
    backup: "caution",
    not_recommended: "not_recommended"
  }[normalized] || "";
}

function defaultSelectedForBatch(tier, policy = DECISION_POLICY) {
  assertDecisionPolicy(policy);
  return policy.defaultBatchSelection[String(tier || "").trim()] === true;
}

function capRecommendationTier(tier, ceiling) {
  const order = ["primary", "apply", "caution", "not_recommended"];
  const tierIndex = order.indexOf(tier);
  const ceilingIndex = order.indexOf(ceiling);
  if (tierIndex < 0 || ceilingIndex < 0) throw new Error("recommendation tier cap is invalid");
  return tierIndex < ceilingIndex ? ceiling : tier;
}

function isExplicitSoftRequirement(item) {
  const content = String(
    typeof item === "string"
      ? item
      : item?.requirement || item?.label || item?.text || ""
  ).trim();
  if (!content) return false;
  return /(?:加分项|加分条件)/i.test(content)
    || /(?:非必须|非必需|不作硬性要求|不是硬性要求|可选项?|nice[\s-]*to[\s-]*have|preferred|bonus)/i.test(content)
    || /(?:有|具有|具备|拥有|熟悉|了解|掌握|精通|擅长|使用|会|能够|持有|经验|能力|技能|背景).{0,48}(?:者)?优先(?:考虑|录用)?[。；;，,！!）)]*\s*$/i.test(content);
}

function finiteUnit(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${label} must be between zero and one`);
  }
  return parsed;
}

function sameValues(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

module.exports = {
  DECISION_POLICY,
  DECISION_POLICY_HASH,
  FIT_BANDS,
  RECOMMENDATION_SCHEMA_VERSION,
  RECOMMENDATION_TIERS,
  ROLE_ALIGNMENT_ROWS,
  assertDecisionPolicy,
  capRecommendationTier,
  decisionPolicyHash,
  defaultSelectedForBatch,
  isExplicitSoftRequirement,
  normalizeRecommendationTier
};
