const fs = require("fs");
const path = require("path");
const {
  DECISION_POLICY,
  assertDecisionPolicy,
  decisionPolicyHash
} = require("./../src/core/decision_policy");
const { buildShadowScorecard, SHADOW_SCORECARD_VERSION } = require("./lib/shadow_scorecard");

function main(argv = process.argv.slice(2)) {
  const { inputPath, outputPath } = parseArgs(argv);
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);
  if (resolvedInput === resolvedOutput) throw new Error("input and output paths must be different");

  const fixture = JSON.parse(fs.readFileSync(resolvedInput, "utf8"));
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture) || !Array.isArray(fixture.cases)) {
    throw new Error("fixture must be an object with a cases array");
  }
  const policy = fixture.policy || DECISION_POLICY;
  assertDecisionPolicy(policy);
  const seen = new Set();
  const rows = fixture.cases.map((item) => {
    const id = String(item?.id || "").trim();
    if (!id) throw new Error("every fixture case must have a non-empty id");
    if (seen.has(id)) throw new Error(`duplicate fixture case id: ${id}`);
    seen.add(id);
    const scorecard = buildShadowScorecard(item.input, policy);
    return {
      id,
      finalRecommendation: item.finalRecommendation ?? null,
      decisionBucket: item.decisionBucket ?? null,
      defaultSelectedForBatch: item.defaultSelectedForBatch ?? null,
      candidateTier: scorecard.candidateTier,
      scorecard
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const candidateTierCounts = Object.fromEntries(
    ["primary", "apply", "caution", "not_recommended"].map((tier) => [
      tier,
      rows.filter((row) => row.candidateTier === tier).length
    ])
  );
  const comparableRows = rows.filter((row) => typeof row.finalRecommendation === "string" && row.finalRecommendation.trim());
  const report = {
    version: "shadow-scorecard-report-v1",
    scorecardVersion: SHADOW_SCORECARD_VERSION,
    policyVersion: String(policy.version),
    policyHash: decisionPolicyHash(policy),
    total: rows.length,
    candidateTierCounts,
    comparedFinalRecommendations: comparableRows.length,
    changedCandidateTierCount: comparableRows.filter((row) => row.candidateTier !== row.finalRecommendation).length,
    rows
  };
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--input" && flag !== "--output") throw new Error("usage: node scripts/compare-shadow-scorecard.js --input <fixture.json> --output <report.json>");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (values[flag.slice(2)]) throw new Error(`duplicate ${flag} argument`);
    values[flag.slice(2)] = value;
    index += 1;
  }
  if (!values.input || !values.output) throw new Error("usage: node scripts/compare-shadow-scorecard.js --input <fixture.json> --output <report.json>");
  return { inputPath: values.input, outputPath: values.output };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs };
