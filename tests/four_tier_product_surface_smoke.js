const assert = require("node:assert/strict");
const { decisionBucket } = require("../src/core/storage");
const { workflowEligibility } = require("../src/core/workflow_inventory");
const { renderMarkdown } = require("../src/reports/render");

function job(recommendation, overrides = {}) {
  const { analysis: analysisOverrides = {}, ...jobOverrides } = overrides;
  return {
    source: "boss",
    url: "https://www.zhipin.com/job_detail/abc123.html",
    description: "完整岗位描述".repeat(24),
    bossActiveDays: 1,
    effectiveBossActiveDays: 1,
    qualityTags: [],
    risks: [],
    analysis: {
      semanticStatus: "complete",
      recommendation,
      roleAlignment: "aligned",
      requirementMatches: [],
      hardBlockers: [],
      ...analysisOverrides
    },
    ...jobOverrides
  };
}

assert.equal(decisionBucket(job("apply")), "primary",
  "历史 apply 必须在读取时解释为新主投");
assert.equal(decisionBucket(job("caution")), "apply",
  "历史 caution 必须在读取时解释为新可投");
assert.equal(decisionBucket(job("review")), "caution",
  "历史 review 必须在读取时解释为新慎投");
assert.equal(decisionBucket(job("skip")), "not_recommended",
  "历史 skip 必须在读取时解释为新不推荐");
assert.equal(decisionBucket(job("apply", {
  analysis: { recommendationSchemaVersion: 2 }
})), "apply",
  "新 schema 的 apply 必须保持可投，不能误升为主投");

assert.equal(decisionBucket(job(null, {
  analysis: { semanticStatus: "failed", decisionStatus: "needs_retry" }
})), "analysis_pending");

for (const tier of ["primary", "apply"]) {
  const result = workflowEligibility(job(tier, {
    analysis: { recommendationSchemaVersion: 2 }
  }), { now: "2026-08-01T00:00:00.000Z" });
  assert.equal(result.eligible, true, `${tier} 必须进入默认沟通候选池`);
  assert.equal(result.tier, tier);
}
const caution = workflowEligibility(job("caution", {
  analysis: { recommendationSchemaVersion: 2 }
}), { now: "2026-08-01T00:00:00.000Z" });
assert.equal(caution.eligible, false,
  "慎投不得计入默认沟通库存");
assert.equal(caution.reasonCode, "WORKFLOW_DECISION_CAUTION",
  "慎投必须保留明确的人工选择原因");

const markdown = renderMarkdown([{
  ...job("apply", { analysis: { recommendationSchemaVersion: 2 } }),
  score: 80,
  level: "可投",
  title: "测试岗位",
  company: "测试公司",
  location: "广州",
  salary: "面议",
  firstSeenAt: "2026-08-01",
  lastSeenAt: "2026-08-01"
}]);
assert(markdown.includes("可投"));
assert(!markdown.includes("|apply|"),
  "面向用户的报告必须显示中文四档，而不是内部枚举");

console.log("four_tier_product_surface_smoke ok");
