const path = require("node:path");
const { spawnSync } = require("node:child_process");

const tests = [
  "self_check.js",
  "browser_transport_smoke.js",
  "model_adapter_smoke.js",
  "model_parser_resilience_smoke.js",
  "model_settings_smoke.js",
  "model_settings_ui_smoke.js",
  "observability_smoke.js",
  "profile_quality_smoke.js",
  "semantic_pipeline_smoke.js",
  "source_acquisition_smoke.js",
  "data_visibility_smoke.js",
  "screening_quality_smoke.js",
  "onboarding_smoke.js",
  "communication_smoke.js",
  "flow_smoke.js",
  "job_match_benchmark.js"
];

for (const file of tests) {
  console.log(`\n> ${file}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    timeout: 120_000
  });
  if (result.error) {
    console.error(`${file}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`\nAll ${tests.length} offline checks passed.`);
