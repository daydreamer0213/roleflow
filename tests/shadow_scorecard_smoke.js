const assert = require("assert");
const {
  DECISION_POLICY,
  decisionPolicyHash
} = require("../src/core/decision_policy");
const { buildShadowScorecard } = require("../scripts/lib/shadow_scorecard");

function baseInput() {
  return {
    roleAlignment: "aligned",
    responsibilityMatches: [
      { state: "matched", jdEvidence: "职责证据一", resumeEvidence: "经历证据一" },
      { state: "transferable", jdEvidence: "职责证据二", resumeEvidence: "经历证据二" }
    ],
    requirementMatches: [
      { state: "matched", foundation: true, requirement: "核心要求一" },
      { state: "transferable", central: true, requirement: "核心要求二" },
      { state: "matched", requirement: "支持要求一" }
    ],
    boundaries: [],
    risks: []
  };
}

const stableInput = baseInput();
const before = JSON.parse(JSON.stringify(stableInput));
const first = buildShadowScorecard(stableInput, DECISION_POLICY);
const second = buildShadowScorecard(stableInput, DECISION_POLICY);

assert.deepStrictEqual(first, second, "identical semantic input must produce a deterministic scorecard");
assert.deepStrictEqual(stableInput, before, "scorecard construction must not mutate semantic input");
assert.strictEqual(first.version, "shadow-scorecard-v1");
assert.strictEqual(first.candidateTier, "primary");
assert.strictEqual(first.score.policyVersion, DECISION_POLICY.version);
assert.strictEqual(first.score.policyHash, decisionPolicyHash(DECISION_POLICY));

const hardBoundary = buildShadowScorecard({
  ...baseInput(),
  boundaries: [{ verified: true, blocked: true, reason: "明确不兼容边界" }]
}, DECISION_POLICY);
assert.strictEqual(hardBoundary.score.weightedFit, 0.825);
assert.strictEqual(hardBoundary.hardBoundary.blocked, true);
assert.strictEqual(hardBoundary.candidateTier, "not_recommended",
  "a verified hard boundary must not be compensated by a high score");

const lowCoverage = buildShadowScorecard({
  ...baseInput(),
  requirementMatches: [
    { state: "unknown", foundation: true, requirement: "未核实核心要求" },
    { state: "matched", requirement: "已核实支持要求" }
  ]
}, DECISION_POLICY);
assert.strictEqual(lowCoverage.score.weightedFit, 1);
assert(lowCoverage.evidenceCoverage.overall < DECISION_POLICY.minEvidenceCoverageForAutoSelect);
assert.strictEqual(lowCoverage.candidateTier, "caution",
  "low evidence coverage must cap an otherwise high-scoring candidate");

console.log("shadow_scorecard_smoke ok");
