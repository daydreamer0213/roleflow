const {
  ModelContractError,
  requirementsForTrack
} = require("./model_contract");
const { DECISION_POLICY } = require("./decision_policy");

const RESPONSIBILITY_STATES = new Set([
  "matched",
  "transferable",
  "missing",
  "unknown"
]);
const REQUIREMENT_STATES = new Set([
  "matched",
  "transferable",
  "missing",
  "unknown"
]);
const ELIGIBILITY_STATES = new Set([
  "satisfied",
  "conflict",
  "unknown"
]);
const GAP_DIMENSIONS = new Set([
  "work_object",
  "main_action",
  "deliverable"
]);

function combineSplitMatchEvidence({
  jobUnderstanding,
  responsibilityOutput,
  requirementOutput
}) {
  const responsibilities = normalizeResponsibilityOutput(
    responsibilityOutput,
    jobUnderstanding
  );
  const requirements = normalizeRequirementOutput(
    requirementOutput,
    jobUnderstanding,
    responsibilities.selectedTrackId
  );
  const role = deriveRoleAlignment(responsibilities.matches);
  const roleResumeEvidence = [...new Set(responsibilities.matches
    .filter((item) => item.state !== "unknown" && item.resumeEvidence)
    .map((item) => item.resumeEvidence))].slice(0, 4);
  const confirmedGaps = responsibilities.matches
    .filter((item) => item.state === "missing")
    .map((item) => `${item.id}|${item.gapDimension}`)
    .slice(0, 4);
  const centralTransferableGaps = requirements.matches
    .filter((item) => item.state === "transferable")
    .map((item) => requirements.requirements.find((entry) => entry.id === item.id))
    .filter((item) => item?.central === true)
    .map((item) => `${item.label}尚未证明指定范围`)
    .slice(0, 4);
  const evidenceGaps = [...new Set([
    ...confirmedGaps,
    ...centralTransferableGaps
  ])].slice(0, 4);
  const roleGaps = evidenceGaps.length
    ? evidenceGaps
    : role.roleAlignment === "insufficient_evidence"
      ? [role.total
        ? "所选招聘方向的职责匹配信息待确认"
        : "所选招聘方向缺少可核对的职责证据"]
      : [];

  return {
    selectedTrackId: responsibilities.selectedTrackId,
    roleAlignment: role.roleAlignment,
    roleResumeEvidence,
    roleGaps,
    responsibilityMatches: responsibilities.matches.map((item) => ({
      id: item.id,
      state: item.state,
      resumeEvidence: item.resumeEvidence
    })),
    matches: requirements.matches,
    eligibility: requirements.eligibility
  };
}

function normalizeResponsibilityOutput(raw, jobUnderstanding) {
  exactKeys(raw, ["selectedTrackId", "matches"], "responsibility");
  const tracks = hiringTracks(jobUnderstanding);
  const selectedTrackId = requiredString(
    raw.selectedTrackId,
    "responsibility.selectedTrackId"
  );
  const track = tracks.find((item) => item.id === selectedTrackId);
  if (!track) fail(`responsibility selectedTrackId ${selectedTrackId} does not exist`);
  const expected = (track.responsibilityEvidence || []).map((jdEvidence, index) => ({
    id: `D${index + 1}`,
    jdEvidence
  }));
  const sparse = normalizeSparseRows(raw.matches, {
    field: "responsibility.matches",
    expectedIds: expected.map((item) => item.id),
    states: RESPONSIBILITY_STATES,
    requireGapDimension: true
  });
  const byId = new Map(sparse.map((item) => [item.id, item]));
  return {
    selectedTrackId,
    track,
    matches: expected.map((item) => {
      const match = byId.get(item.id);
      return {
        id: item.id,
        state: match?.state || "unknown",
        jdEvidence: item.jdEvidence,
        resumeEvidence: match?.resumeEvidence || "",
        gapDimension: match?.gapDimension || ""
      };
    })
  };
}

function normalizeRequirementOutput(raw, jobUnderstanding, selectedTrackId) {
  exactKeys(raw, ["matches", "eligibility"], "requirement");
  const requirements = requirementsForTrack(jobUnderstanding, selectedTrackId);
  const eligibility = eligibilityItems(jobUnderstanding);
  return {
    requirements,
    matches: normalizeSparseRows(raw.matches, {
      field: "requirement.matches",
      expectedIds: requirements.map((item) => item.id),
      states: REQUIREMENT_STATES
    }),
    eligibility: normalizeSparseRows(raw.eligibility, {
      field: "requirement.eligibility",
      expectedIds: eligibility.map((item) => item.id),
      states: ELIGIBILITY_STATES
    })
  };
}

function normalizeSparseRows(raw, {
  field,
  expectedIds,
  states,
  requireGapDimension = false
}) {
  if (!Array.isArray(raw)) fail(`${field} must be an array`);
  const allowedIds = new Set(expectedIds);
  const seen = new Set();
  return raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail(`${field} item must be an object`);
    }
    const id = requiredString(item.id, `${field}.id`);
    const state = requiredString(item.state, `${field}.state`);
    const expectedKeys = requireGapDimension && state === "missing"
      ? ["gapDimension", "id", "resumeEvidence", "state"]
      : ["id", "resumeEvidence", "state"];
    exactKeys(item, expectedKeys, `${field} item`);
    if (typeof item.resumeEvidence !== "string") {
      fail(`${field}.resumeEvidence must be a string`);
    }
    const resumeEvidence = item.resumeEvidence.trim();
    if (!allowedIds.has(id)) fail(`${field} contains unknown id ${id}`);
    if (seen.has(id)) fail(`${field} contains duplicate id ${id}`);
    if (!states.has(state)) fail(`${field} contains invalid state ${state}`);
    if (state === "unknown") {
      if (resumeEvidence) fail(`${field}.unknown must use empty resumeEvidence`);
    } else if (!resumeEvidence) {
      fail(`${field}.${state} requires resumeEvidence`);
    } else if (!resumeEvidence.startsWith("简历：")
      || !resumeEvidence.slice("简历：".length).trim()) {
      fail(`${field}.resumeEvidence must start with 简历： and contain evidence`);
    }
    let gapDimension = "";
    if (requireGapDimension && state === "missing") {
      gapDimension = requiredString(
        item.gapDimension,
        `${field}.gapDimension`
      );
      if (!GAP_DIMENSIONS.has(gapDimension)) {
        fail(`${field}.gapDimension must be work_object, main_action, or deliverable`);
      }
    }
    seen.add(id);
    return {
      id,
      state,
      resumeEvidence: resumeEvidence.slice(0, 120),
      ...(gapDimension ? { gapDimension } : {})
    };
  });
}

function deriveRoleAlignment(responsibilityMatches) {
  const matches = Array.isArray(responsibilityMatches)
    ? responsibilityMatches
    : [];
  const values = DECISION_POLICY.responsibilityAlignment.stateValues;
  let known = 0;
  let points = 0;
  for (const item of matches) {
    if (item.state === "unknown" || !item.resumeEvidence) continue;
    known += 1;
    points += values[item.state] || 0;
  }
  const total = matches.length;
  const coverage = total ? known / total : 0;
  const score = known ? points / known : null;
  const alignment = DECISION_POLICY.responsibilityAlignment;
  const enoughKnown = known >= alignment.minimumKnownCount
    && coverage >= alignment.minimumKnownCoverage;
  let roleAlignment = "insufficient_evidence";
  if (enoughKnown && score >= alignment.thresholds.aligned) {
    roleAlignment = "aligned";
  } else if (enoughKnown && score >= alignment.thresholds.mostlyAligned) {
    roleAlignment = "mostly_aligned";
  } else if (known > 0 && score > 0) {
    roleAlignment = "partially_aligned";
  } else if (total > 0 && known === total) {
    roleAlignment = "misaligned";
  }
  return { roleAlignment, total, known, coverage, score };
}

function buildSplitRequirementInput(input, selectedTrackId) {
  const jobUnderstanding = input?.jobUnderstanding || {};
  const track = hiringTracks(jobUnderstanding)
    .find((item) => item.id === selectedTrackId);
  if (!track) fail(`selectedTrackId ${selectedTrackId} does not exist`);
  const result = {
    candidateProfile: input?.candidateProfile || {},
    candidateMatchCard: input?.candidateMatchCard || null,
    searchPreferences: input?.searchPreferences || {},
    selectedTrack: {
      id: track.id,
      label: track.label,
      roleSummary: track.roleSummary
    },
    requirements: requirementsForTrack(jobUnderstanding, selectedTrackId),
    eligibility: eligibilityItems(jobUnderstanding)
  };
  if (input?.contractRepair) result.contractRepair = input.contractRepair;
  return result;
}

function buildSplitResponsibilityInput(input) {
  const result = {
    candidateProfile: input?.candidateProfile || {},
    candidateMatchCard: input?.candidateMatchCard || null,
    searchPreferences: input?.searchPreferences || {},
    hiringTracks: hiringTracks(input?.jobUnderstanding).map((track) => ({
      id: track.id,
      label: track.label,
      roleSummary: track.roleSummary,
      responsibilityEvidence: track.responsibilityEvidence || []
    }))
  };
  if (input?.contractRepair) result.contractRepair = input.contractRepair;
  return result;
}

function hiringTracks(jobUnderstanding) {
  if (Array.isArray(jobUnderstanding?.hiringTracks)
    && jobUnderstanding.hiringTracks.length) {
    return jobUnderstanding.hiringTracks;
  }
  return [{
    id: "T1",
    label: "默认招聘方向",
    roleSummary: jobUnderstanding?.roleSummary || "",
    responsibilityEvidence: jobUnderstanding?.responsibilityEvidence || []
  }];
}

function eligibilityItems(jobUnderstanding) {
  if (Array.isArray(jobUnderstanding?.eligibilityItems)) {
    return jobUnderstanding.eligibilityItems;
  }
  const values = Array.isArray(jobUnderstanding?.eligibilityConstraints)
    ? jobUnderstanding.eligibilityConstraints
    : [];
  return values.map((label, index) => ({
    id: `E${index + 1}`,
    label
  }));
}

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${field} must contain exactly ${wanted.join(",")}`);
  }
}

function requiredString(value, field) {
  const result = String(value || "").trim();
  if (!result) fail(`${field} must be a non-empty string`);
  return result;
}

function fail(reason) {
  throw new ModelContractError("matchJob", reason);
}

module.exports = {
  buildSplitRequirementInput,
  buildSplitResponsibilityInput,
  combineSplitMatchEvidence,
  deriveRoleAlignment,
  normalizeRequirementOutput,
  normalizeResponsibilityOutput
};
