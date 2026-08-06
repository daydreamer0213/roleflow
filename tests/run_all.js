const path = require("node:path");
const { spawnSync } = require("node:child_process");

const tests = [
  "self_check.js",
  "startup_scripts_smoke.js",
  "background_process_visibility_smoke.js",
  "scoring_url_smoke.js",
  "browser_transport_smoke.js",
  "browser_readiness_smoke.js",
  "workspace_tabs_smoke.js",
  "scan_execution_smoke.js",
  "site_access_budget_smoke.js",
  "workflow_planner_smoke.js",
  "inherited_search_scope_smoke.js",
  "scoped_keyword_stats_smoke.js",
  "scan_snapshot_smoke.js",
  "scan_recovery_smoke.js",
  "batch_state_consistency_smoke.js",
  "scan_cli_lifecycle_smoke.js",
  "workflow_scan_smoke.js",
  "scan_end_to_end_recovery_smoke.js",
  "storage_migration_smoke.js",
  "matching_card_smoke.js",
  "workflow_storage_smoke.js",
  "workflow_inventory_smoke.js",
  "workflow_health_smoke.js",
  "workflow_communication_smoke.js",
  "communication_cli_authority_smoke.js",
  "workflow_dashboard_smoke.js",
  "workflow_recovery_smoke.js",
  "workflow_end_to_end_smoke.js",
  "communication_batch_storage_smoke.js",
  "communication_executor_smoke.js",
  "dashboard_communication_batch_smoke.js",
  "communication_calibration_gate_smoke.js",
  "dashboard_scan_lifecycle_smoke.js",
  "model_adapter_smoke.js",
  "model_parser_resilience_smoke.js",
  "resume_parser_pdf_order_smoke.js",
  "resume_privacy_smoke.js",
  "analyzer_initialization_smoke.js",
  "model_settings_smoke.js",
  "model_task_profiles_smoke.js",
  "model_settings_ui_smoke.js",
  "observability_smoke.js",
  "observability_context_smoke.js",
  "profile_quality_smoke.js",
  "semantic_pipeline_smoke.js",
  "four_tier_pipeline_smoke.js",
  "outcome_analytics_smoke.js",
  "four_tier_product_surface_smoke.js",
  "outcome_analytics_dashboard_smoke.js",
  "four_tier_benchmark_metrics_smoke.js",
  "generic_evidence_matching_smoke.js",
  "source_acquisition_smoke.js",
  "boss_communication_page_smoke.js",
  "activity_status_smoke.js",
  "data_visibility_smoke.js",
  "screening_quality_smoke.js",
  "onboarding_smoke.js",
  "communication_smoke.js",
  "flow_smoke.js",
  "job_match_benchmark.js",
  "private_full_chain_runner_smoke.js"
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
