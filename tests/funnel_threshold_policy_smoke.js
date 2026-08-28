const assert = require("node:assert/strict");
const {
  DEFAULT_PRELIMINARY_SAMPLE_TARGET,
  DEFAULT_COMPARABLE_SAMPLE_TARGET,
  DEFAULT_FORMAL_SAMPLE_TARGET,
  normalizeFunnelSamplePolicy,
  diagnosisStrength
} = require("../src/core/funnel_maturity");

assert.equal(DEFAULT_PRELIMINARY_SAMPLE_TARGET, 30);
assert.equal(DEFAULT_COMPARABLE_SAMPLE_TARGET, 50);
assert.equal(DEFAULT_FORMAL_SAMPLE_TARGET, 70);

const defaults = normalizeFunnelSamplePolicy();
assert.deepEqual(defaults, {
  preliminarySampleTarget: 30,
  comparableSampleTarget: 50,
  formalSampleTarget: 70
});
assert.equal(diagnosisStrength(29, defaults), "facts");
assert.equal(diagnosisStrength(30, defaults), "preliminary");
assert.equal(diagnosisStrength(49, defaults), "preliminary");
assert.equal(diagnosisStrength(50, defaults), "comparable");
assert.equal(diagnosisStrength(69, defaults), "comparable");
assert.equal(diagnosisStrength(70, defaults), "formal");

const custom = normalizeFunnelSamplePolicy({
  preliminarySampleTarget: 40,
  comparableSampleTarget: 60,
  formalSampleTarget: 80
});
assert.equal(diagnosisStrength(39, custom), "facts");
assert.equal(diagnosisStrength(40, custom), "preliminary");
assert.equal(diagnosisStrength(60, custom), "comparable");
assert.equal(diagnosisStrength(80, custom), "formal");
assert.throws(() => normalizeFunnelSamplePolicy({
  preliminarySampleTarget: 50,
  comparableSampleTarget: 50,
  formalSampleTarget: 70
}), /strictly increase/);

console.log("funnel_threshold_policy_smoke: ok");
