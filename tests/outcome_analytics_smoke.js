const assert = require("node:assert/strict");
const { buildOutcomeAnalytics } = require("../src/core/outcome_analytics");

const { openDb, getOutcomeAnalyticsSnapshot } = require("../src/core/storage");

const OTHER_KEYWORD = "\u5176\u4ed6\u5173\u952e\u8bcd";
const MISSING_KEYWORD = "\u672a\u8bb0\u5f55\u5173\u952e\u8bcd";

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

const blankKeywordAnalytics = buildOutcomeAnalytics([
  { decisionBucket: "primary", applicationStatus: "applied", keyword: " " }
]);
assert.strictEqual(blankKeywordAnalytics.keywords[0].keyword, MISSING_KEYWORD);
assert.strictEqual(blankKeywordAnalytics.keywords[0].total, 1);

const unclassifiedTerminalAnalytics = buildOutcomeAnalytics([
  { decisionBucket: "unknown_bucket", applicationStatus: "interview", keyword: "Unknown terminal" }
]);
assert.strictEqual(unclassifiedTerminalAnalytics.totals.total, 1);
assert.strictEqual(unclassifiedTerminalAnalytics.totals.recordedOutcomeCount, 1);
assert.strictEqual(unclassifiedTerminalAnalytics.tiers.reduce((sum, row) => sum + row.recordedOutcomeCount, 0), 0);
assert.deepStrictEqual(unclassifiedTerminalAnalytics.unclassified, {
  total: 1,
  unknownDecisionBucket: 1,
  unknownApplicationStatus: 0
});

const namedKeywords = analytics.keywords.filter((row) => row.keyword !== OTHER_KEYWORD);
assert.strictEqual(namedKeywords.length, 12);
const other = analytics.keywords.find((row) => row.keyword === OTHER_KEYWORD);
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
assert.strictEqual(analytics.keywords.reduce((sum, row) => sum + row.total, 0), rows.length);

const reservedLabelRows = [
  { decisionBucket: "primary", applicationStatus: "applied", keyword: OTHER_KEYWORD },
  { decisionBucket: "primary", applicationStatus: "skipped", keyword: OTHER_KEYWORD }
];
for (let index = 0; index < 13; index += 1) {
  reservedLabelRows.push({
    decisionBucket: "primary",
    applicationStatus: "pending",
    keyword: `tie-${String(index).padStart(2, "0")}`
  });
}

const reservedLabelAnalytics = buildOutcomeAnalytics(reservedLabelRows);
const reservedLabelRowsByName = reservedLabelAnalytics.keywords.filter((row) => row.keyword === OTHER_KEYWORD);
assert.strictEqual(reservedLabelRowsByName.length, 1);
assert.deepStrictEqual(
  reservedLabelAnalytics.keywords.map((row) => row.keyword),
  [...Array.from({ length: 12 }, (_, index) => `tie-${String(index).padStart(2, "0")}`), OTHER_KEYWORD]
);
assert.strictEqual(reservedLabelRowsByName[0].total, 3);
assert.strictEqual(reservedLabelRowsByName[0].outcomes.pending, 1);
assert.strictEqual(reservedLabelRowsByName[0].outcomes.applied, 1);
assert.strictEqual(reservedLabelRowsByName[0].outcomes.skipped, 1);
assert.strictEqual(
  reservedLabelAnalytics.keywords.reduce((sum, row) => sum + row.total, 0),
  reservedLabelRows.length
);
const reservedInputOutcomeTotals = Object.fromEntries(Object.keys(inputOutcomeTotals).map((status) => [
  status,
  reservedLabelRows.filter((row) => row.applicationStatus === status).length
]));
const reservedDisplayedOutcomeTotals = Object.fromEntries(Object.keys(reservedInputOutcomeTotals).map((status) => [
  status,
  reservedLabelAnalytics.keywords.reduce((sum, row) => sum + row.outcomes[status], 0)
]));
assert.deepStrictEqual(reservedDisplayedOutcomeTotals, reservedInputOutcomeTotals);
assert.deepStrictEqual(
  buildOutcomeAnalytics([...reservedLabelRows].reverse()).keywords,
  reservedLabelAnalytics.keywords
);

const snapshot = JSON.stringify(analytics);
for (const value of Object.values(bait)) assert.strictEqual(snapshot.includes(value), false);
assert.strictEqual(snapshot.includes("analysis_pending"), false);
assert.strictEqual(snapshot.includes("refresh"), false);

function outcomeSnapshotFixture() {
  const db = openDb(":memory:");
  const now = "2026-08-03T00:00:00.000Z";
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)`).run("Confirmed candidate", "{}", now, now).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(profile_id, name, plan_json, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)`).run(profileId, "Analytics <plan> & safe", "{}", now, now).lastInsertRowid);
  const batchId = Number(db.prepare(`INSERT INTO batches(site, keyword, started_at, note, profile_id, search_plan_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run("fixture", "Analytics", now, "safe synthetic fixture", profileId, planId).lastInsertRowid);
  const jobId = Number(db.prepare(`INSERT INTO jobs(source, source_id, title, company, url, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run("fixture", "analytics-job", bait.title, bait.company, bait.url, now, now).lastInsertRowid);
  db.prepare(`INSERT INTO job_observations(
    job_id, batch_id, keyword, title, company, url, tags_json, description, score, matches_json,
    risks_json, quality_tags_json, analysis_json, content_hash, seen_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    jobId, batchId, "Analytics", bait.title, bait.company, bait.url, "[]", bait.JD, 100, "[]",
    "[]", "[]", JSON.stringify({ semanticStatus: "complete", recommendation: "primary", recommendationSchemaVersion: 2 }), "fixture-hash", now
  );
  db.prepare(`INSERT INTO candidate_job_states(profile_id, job_id, plan_id, status, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run(profileId, jobId, planId, "", now);
  db.prepare(`INSERT INTO candidate_job_events(profile_id, job_id, plan_id, event_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(profileId, jobId, planId, "fixture", "{}", now);
  return { db, planId };
}

function outcomeSnapshotState(db) {
  return {
    schema: db.prepare("PRAGMA user_version").get().user_version,
    jobs: db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count,
    states: db.prepare("SELECT COUNT(*) AS count FROM candidate_job_states").get().count,
    events: db.prepare("SELECT COUNT(*) AS count FROM candidate_job_events").get().count
  };
}

const fixture = outcomeSnapshotFixture();
const beforeSnapshot = outcomeSnapshotState(fixture.db);
assert.strictEqual(typeof getOutcomeAnalyticsSnapshot, "function");
const outcomeSnapshot = getOutcomeAnalyticsSnapshot(fixture.db, { planId: fixture.planId });
assert.deepStrictEqual(outcomeSnapshot.tiers.map((row) => row.tier), ["primary", "apply", "caution", "not_recommended"]);
assert.strictEqual(outcomeSnapshot.tiers[0].total, 1);
assert.strictEqual(outcomeSnapshot.tiers[0].outcomes.pending, 1);
assert.deepStrictEqual(outcomeSnapshot.context, { planName: "Analytics &lt;plan&gt; &amp; safe" });
assert.deepStrictEqual(Object.keys(outcomeSnapshot.context), ["planName"]);
assert.deepStrictEqual(outcomeSnapshotState(fixture.db), beforeSnapshot);
const outcomeSnapshotJson = JSON.stringify(outcomeSnapshot);
for (const value of Object.values(bait)) assert.strictEqual(outcomeSnapshotJson.includes(value), false);
assert.strictEqual(outcomeSnapshotJson.includes("Analytics <plan> & safe"), false);

const beforeEmptySnapshot = outcomeSnapshotState(fixture.db);
const emptyOutcomeSnapshot = getOutcomeAnalyticsSnapshot(fixture.db, { planId: fixture.planId + 1000 });
assert.deepStrictEqual(emptyOutcomeSnapshot.tiers.map((row) => row.tier), ["primary", "apply", "caution", "not_recommended"]);
assert.strictEqual(emptyOutcomeSnapshot.tiers.reduce((total, row) => total + row.total, 0), 0);
assert.deepStrictEqual(emptyOutcomeSnapshot.context, { planName: "" });
assert.deepStrictEqual(outcomeSnapshotState(fixture.db), beforeEmptySnapshot);
fixture.db.close();
console.log("outcome_analytics_smoke ok");
