const assert = require("node:assert/strict");
const { buildOutcomeAnalytics } = require("../src/core/outcome_analytics");

const bait = {
  jobId: "BAIT-JOB-ID",
  title: "BAIT-TITLE",
  company: "BAIT-COMPANY",
  url: "https://bait.example/job",
  JD: "BAIT-JD",
  resume: "BAIT-RESUME",
  rawModelOutput: "BAIT-RAW-MODEL"
};

const rows = [
  { decisionBucket: "primary", applicationStatus: "interview", keyword: "RAG", ...bait },
  { decisionBucket: "primary", applicationStatus: "pending", keyword: "RAG", ...bait },
  { decisionBucket: "apply", applicationStatus: "applied", keyword: "Agent", ...bait },
  { decisionBucket: "caution", applicationStatus: "review", keyword: "Agent", ...bait },
  { decisionBucket: "not_recommended", applicationStatus: "skipped", keyword: null, ...bait },
  { decisionBucket: "analysis_pending", applicationStatus: "pending", keyword: "RAG", ...bait },
  { decisionBucket: "refresh", applicationStatus: "later", keyword: "Python", ...bait },
  { decisionBucket: "unknown_bucket", applicationStatus: "mystery", keyword: "Other", ...bait },
  { decisionBucket: "primary", keyword: "Missing", ...bait },
  { decisionBucket: "apply", applicationStatus: undefined, keyword: "Undefined", ...bait },
  { decisionBucket: "caution", applicationStatus: "", keyword: "Empty", ...bait }
];

for (let index = 1; index <= 13; index += 1) {
  rows.push({
    decisionBucket: "primary",
    applicationStatus: index % 2 ? "applied" : "skipped",
    keyword: `Named-${String(index).padStart(2, "0")}`,
    ...bait
  });
}

const analytics = buildOutcomeAnalytics(rows);

assert.deepStrictEqual(analytics.tiers.map((row) => row.tier), ["primary", "apply", "caution", "not_recommended"]);
assert.strictEqual(analytics.tiers[0].total, 16);
assert.strictEqual(analytics.tiers[0].outcomes.interview, 1);
assert.strictEqual(analytics.tiers[0].outcomes.pending, 2);
assert.strictEqual(analytics.tiers[0].unresolvedCount, 2);
assert.strictEqual(analytics.tiers[0].recordedOutcomeCount, 14);
assert.strictEqual(analytics.tiers[3].outcomes.skipped, 1);
assert.strictEqual(analytics.diagnostics.total, 2);
assert.strictEqual(analytics.diagnostics.outcomes.pending, 1);
assert.strictEqual(analytics.diagnostics.outcomes.later, 1);
assert.strictEqual(analytics.unclassified.total, 1);
assert.strictEqual(analytics.unclassified.unknownDecisionBucket, 1);
assert.strictEqual(analytics.unclassified.unknownApplicationStatus, 1);
assert.strictEqual(analytics.keywords.find((row) => row.keyword === "RAG").total, 3);

const namedKeywords = analytics.keywords.filter((row) => row.keyword !== "\u5176\u4ed6\u5173\u952e\u8bcd");
assert.strictEqual(namedKeywords.length, 12);
const other = analytics.keywords.find((row) => row.keyword === "\u5176\u4ed6\u5173\u952e\u8bcd");
assert.ok(other);
assert.strictEqual(other.total, 9);
assert.strictEqual(other.outcomes.applied, 3);
assert.strictEqual(other.outcomes.skipped, 3);

const inputOutcomeTotals = Object.fromEntries([
  "pending", "review", "later", "applied", "skipped", "no_reply", "interview", "rejected", "invalid", "salary_mismatch"
].map((status) => [status, rows.filter((row) => (row.applicationStatus == null || row.applicationStatus === "") ? status === "pending" : row.applicationStatus === status).length]));
const displayedOutcomeTotals = Object.fromEntries(Object.keys(inputOutcomeTotals).map((status) => [
  status,
  analytics.keywords.reduce((sum, row) => sum + row.outcomes[status], 0)
]));
assert.deepStrictEqual(displayedOutcomeTotals, inputOutcomeTotals);

const snapshot = JSON.stringify(analytics);
for (const value of Object.values(bait)) assert.strictEqual(snapshot.includes(value), false);
assert.strictEqual(snapshot.includes("analysis_pending"), false);
assert.strictEqual(snapshot.includes("refresh"), false);
console.log("outcome_analytics_smoke ok");
