const assert = require("assert");
const { deriveBenchmarkMetrics } = require("../scripts/lib/benchmark_metrics");

function row(id, expectedRecommendation, actualRecommendation, options = {}) {
  const expectedBucket = options.expectedBucket || expectedRecommendation;
  const actualBucket = options.actualBucket || actualRecommendation;
  return {
    id,
    expectedRecommendation,
    actualRecommendation,
    expectedBucket,
    actualBucket,
    semanticStatus: options.semanticStatus || "complete",
    evidenceComplete: options.evidenceComplete !== false,
    pass: actualRecommendation === expectedRecommendation
  };
}

const result = deriveBenchmarkMetrics([
  row("moderate-exclusion-miss", "not_recommended", "caution"),
  row("moderate-opportunity-loss", "caution", "not_recommended"),
  row("severe-exclusion-miss", "not_recommended", "apply"),
  row("severe-opportunity-loss", "apply", "not_recommended"),
  row("apply-without-evidence", "apply", "apply", { evidenceComplete: false }),
  row("technical-retry", "caution", null, {
    actualBucket: "analysis_pending",
    semanticStatus: "failed",
    evidenceComplete: false
  })
]);

assert.strictEqual(result.ok, true);
assert.deepStrictEqual(result.metrics.hardFalsePlacementIds, ["severe-exclusion-miss"]);
assert.deepStrictEqual(result.metrics.falseHardExclusionIds, ["severe-opportunity-loss"]);
assert.strictEqual(result.metrics.primaryWithoutEvidence, 1,
  "primaryWithoutEvidence compatibility metric must cover both auto-selected tiers");
assert.strictEqual(result.metrics.failed, 1);
assert.strictEqual(result.metrics.pending, 0);

console.log("four_tier_benchmark_metrics_smoke ok");
