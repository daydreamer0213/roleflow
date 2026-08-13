const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { openDb, SCHEMA_VERSION } = require("../src/core/storage");
const { buildShadowReport } = require("../scripts/compare-shadow-scorecard");
const { exportEvaluation } = require("../scripts/export-gate-d-evaluation");

const ROOT = path.resolve(__dirname, "..");
const TEST_ROOT = fs.mkdtempSync(path.join("D:\\DevData", "RoleFlow-gate-d-evaluation-test-"));
const BASELINE_ROOT = path.join(TEST_ROOT, "baseline");
const DB_PATH = path.join(BASELINE_ROOT, "jobs.sqlite");
const SOURCE_COMMIT = "b".repeat(40);
process.env.NODE_ENV = "test";
const OPERATIONAL_TABLES = [
  "onboarding_runs", "resume_parse_attempts", "keyword_sources", "platform_filter_catalogs", "model_cache", "site_runtime_states", "site_scan_leases",
  "job_analysis_attempts", "workflow_job_tasks", "workflow_runs", "candidate_progress_events", "candidate_progress_cards",
  "message_preview_states", "message_discovery_unresolved_items", "communication_batch_items", "communication_batches",
  "candidate_job_events", "candidate_job_states", "applications", "events", "job_refresh_attempts", "job_observations",
  "scan_target_results", "scan_runs", "batches", "jobs"
];

function hash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function json(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function analysis(overrides = {}) {
  return {
    semanticStatus: "complete",
    decisionSource: "model",
    recommendation: "primary",
    roleAlignment: "aligned",
    responsibilityMatches: [
      { state: "matched", jdEvidence: "JD responsibility", resumeEvidence: "Resume evidence must stay private" }
    ],
    requirementMatches: [
      { state: "matched", foundation: true, requirement: "Node.js", jdEvidence: "JD Node.js", resumeEvidence: "Resume Node.js" }
    ],
    hardBlockers: [],
    hiddenRisks: [],
    fitReasons: ["Evidence is sufficient"],
    decisionPolicyHash: "policy-hash-fixture",
    ...overrides
  };
}

function insert(db, sql, ...values) {
  return db.prepare(sql).run(...values);
}

function seedDb() {
  const db = openDb(DB_PATH);
  const now = "2026-08-12T00:00:00.000Z";
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    const batchId = Number(insert(db, `INSERT INTO batches(site, keyword, started_at, status, finished_at)
      VALUES ('boss', 'node', ?, 'completed', ?)`, now, now).lastInsertRowid);
    insert(db, `INSERT INTO scan_runs(id, site, command, batch_id, status, created_at, started_at, finished_at)
      VALUES ('fresh-scan', 'boss', 'daily', ?, 'completed', ?, ?, ?)`, batchId, now, now, now);
    const rows = [
      {
        sourceId: "platform-source-id-must-not-leak",
        title: "Node.js Engineer",
        company: "Sensitive Company Ltd",
        location: "上海市浦东新区张江路88号A座",
        description: "Sensitive Company Ltd is hiring. Recruiter Secret Recruiter requires Node.js and reliable delivery.\n联系人：张三\n招聘负责人：李经理\nHR姓名：王女士\n座机：021-12345678\nQQ：12345678\n钉钉：ding-secret\nTelegram：@tele_secret\n办公地址：上海市浦东新区张江路88号A座\nrecruiter@example.test, 13800138000 and 微信secretwx are private. This detailed job description is intentionally longer than one hundred and twenty characters for the production readiness predicate.",
        contentHash: "a".repeat(64),
        analysis: analysis({ recruiter: "Secret Recruiter" }),
        qualityTags: []
      },
      {
        sourceId: "salary-boundary-source-id",
        title: "Platform Engineer",
        company: "Boundary Company",
        location: "上海市徐汇区",
        description: "Boundary Company requires platform engineering, Node.js and a carefully bounded salary range. This detailed job description is intentionally longer than one hundred and twenty characters for the production readiness predicate.",
        contentHash: "a".repeat(64),
        analysis: analysis({ recommendation: "apply", fixedSalaryBoundary: true }),
        qualityTags: ["salary_out_of_range"]
      },
      {
        sourceId: "technical-bucket-source-id",
        title: "Cross stack Engineer",
        company: "Technical Company",
        location: "上海市静安区",
        description: "Technical Company requires Node.js work while a cross stack promotion must be reviewed. This detailed job description is intentionally longer than one hundred and twenty characters for the production readiness predicate.",
        contentHash: "d".repeat(64),
        analysis: analysis({ semanticStatus: "failed", decisionSource: "analysis_pending", recommendation: null, errorCode: "MODEL_TIMEOUT", crossStackPromotion: true }),
        qualityTags: []
      }
    ];
    const jobIds = [];
    for (const row of rows) {
      const jobId = Number(insert(db, `INSERT INTO jobs(source, source_id, title, company, location, url, description, analysis_json, first_seen_at, last_seen_at, batch_id)
        VALUES ('boss', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.sourceId, row.title, row.company, row.location,
      `https://private.example/${row.sourceId}`, row.description, JSON.stringify(row.analysis), now, now, batchId).lastInsertRowid);
      jobIds.push(jobId);
      insert(db, `INSERT INTO job_observations(job_id, batch_id, title, company, location, url, description, analysis_json, quality_tags_json, content_hash, seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, jobId, batchId, row.title, row.company, row.location,
      `https://private.example/${row.sourceId}`, row.description, JSON.stringify(row.analysis), JSON.stringify(row.qualityTags), row.contentHash, now);
    }
    insert(db, `INSERT INTO scan_target_results(batch_id, target_key, status, started_at, finished_at)
      VALUES (?, 'fresh-target', 'completed', ?, ?)`, batchId, now, now);
    const secondBatchId = Number(insert(db, `INSERT INTO batches(site, keyword, started_at, status, finished_at)
      VALUES ('boss', 'node-tie', ?, 'completed', ?)`, now, now).lastInsertRowid);
    insert(db, `INSERT INTO scan_runs(id, site, command, batch_id, status, created_at, started_at, finished_at)
      VALUES ('fresh-scan-tie', 'boss', 'broad', ?, 'completed', ?, ?, ?)`, secondBatchId, now, now, now);
    insert(db, `INSERT INTO scan_target_results(batch_id, target_key, status, started_at, finished_at)
      VALUES (?, 'fresh-target-tie', 'completed', ?, ?)`, secondBatchId, now, now);
    const selectedObservationId = Number(insert(db, `INSERT INTO job_observations(
      job_id, batch_id, title, company, location, url, description, analysis_json, quality_tags_json, content_hash, seen_at
    ) VALUES (?, ?, 'Node.js Engineer latest tie', ?, ?, 'https://private.example/tie', ?, ?, '[]', ?, ?)`,
    jobIds[0], secondBatchId, rows[0].company, rows[0].location, rows[0].description,
    JSON.stringify(rows[0].analysis), "f".repeat(64), now).lastInsertRowid);

    const addAttempt = ({ taskId, jobId, attempt, status, errorCode = null, errorStage = null, finishedAt, updatedAt }) => insert(db, `INSERT INTO job_analysis_attempts(
      workflow_run_id, task_id, job_id, recovery_generation, attempt_in_generation, total_attempt_number,
      profile_kind, model_config_revision, provider, model, thinking_mode, reasoning_effort,
      status, error_code, error_stage, started_at, finished_at, created_at, updated_at
    ) VALUES ('fixture-workflow', ?, ?, 0, ?, ?, 'batch_screening', 'fixture-revision',
      'fixture-provider', 'fixture-model', 'off', 'low', ?, ?, ?, ?, ?, ?, ?)`,
    taskId, jobId, attempt, attempt, status, errorCode, errorStage,
    `2026-08-12T00:0${attempt}:00.000Z`, finishedAt, now, updatedAt);
    addAttempt({ taskId: 101, jobId: jobIds[0], attempt: 2, status: "succeeded", finishedAt: "2026-08-12T00:02:00.000Z", updatedAt: "2026-08-12T00:02:00.000Z" });
    addAttempt({ taskId: 101, jobId: jobIds[0], attempt: 1, status: "failed", errorCode: "MODEL_CONTRACT_INVALID", errorStage: "matchJob", finishedAt: "2026-08-12T00:01:00.000Z", updatedAt: "2026-08-12T00:01:00.000Z" });
    addAttempt({ taskId: 102, jobId: jobIds[1], attempt: 1, status: "succeeded", finishedAt: "2026-08-12T00:01:00.000Z", updatedAt: "2026-08-12T00:01:00.000Z" });
    addAttempt({ taskId: 102, jobId: jobIds[1], attempt: 2, status: "failed", errorCode: "MODEL_CONTRACT_INVALID", errorStage: "matchResponsibilities", finishedAt: "2026-08-12T00:03:00.000Z", updatedAt: "2026-08-12T00:03:00.000Z" });
    addAttempt({ taskId: 103, jobId: jobIds[2], attempt: 1, status: "failed", errorCode: "MODEL_CONTRACT_INVALID", errorStage: "understandJob", finishedAt: "2026-08-12T00:03:00.000Z", updatedAt: "2026-08-12T00:03:00.000Z" });
    addAttempt({ taskId: 103, jobId: jobIds[2], attempt: 2, status: "running", finishedAt: null, updatedAt: "2026-08-12T00:04:00.000Z" });
    return { batchId, selectedObservationId };
  } finally {
    db.close();
  }
}

function task13Artifacts(batchId, { receiptPatch = {}, reportPatch = {} } = {}) {
  const archivePath = path.join(TEST_ROOT, "archive", "source.sqlite");
  const reportPath = `${DB_PATH}.report.json`;
  const receiptPath = `${DB_PATH}.receipt.json`;
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, "archive evidence", "utf8");
  const archiveSha256 = hash(archivePath);
  writeJson(`${archivePath}.manifest.json`, {
    artifact: "gate-d-archive",
    sourcePath: path.join(TEST_ROOT, "production-source.sqlite"),
    sourceCommit: SOURCE_COMMIT,
    schemaVersion: SCHEMA_VERSION
  });
  writeJson(reportPath, {
    artifact: "gate-d-baseline",
    sourcePath: path.join(TEST_ROOT, "production-source.sqlite"),
    archivePath,
    baselinePath: DB_PATH,
    schemaVersion: SCHEMA_VERSION,
    operational: { after: Object.fromEntries(OPERATIONAL_TABLES.map((name) => [name, 0])) },
    ...reportPatch
  });
  writeJson(receiptPath, {
    artifact: "gate-d-baseline-receipt",
    complete: true,
    archivePath,
    baselinePath: DB_PATH,
    archiveSha256,
    ...receiptPatch
  });
  return { reportPath, receiptPath };
}

function options(outputRoot, artifacts = task13Artifacts(1)) {
  return {
    db: DB_PATH,
    report: artifacts.reportPath,
    receipt: artifacts.receiptPath,
    outputRoot
  };
}

function testSeam() {
  return { testOnly: { enabled: true, baselineRoot: BASELINE_ROOT, identityKey: "test-only-evaluation-key" } };
}

function assertNoOutput(outputRoot) {
  assert.strictEqual(fs.existsSync(outputRoot), false, "failed export must not leave an output root");
}

try {
  const { batchId, selectedObservationId } = seedDb();
  const artifacts = task13Artifacts(batchId);
  const dbHashBefore = hash(DB_PATH);
  const firstRoot = path.join(TEST_ROOT, "first");
  const exported = exportEvaluation(options(firstRoot, artifacts), testSeam());
  assert.strictEqual(hash(DB_PATH), dbHashBefore, "read-only export must leave the SQLite bytes unchanged");
  assert(fs.existsSync(exported.fixture));
  assert(fs.existsSync(exported.labels));
  assert(fs.existsSync(exported.manifest));
  assert(fs.existsSync(exported.receipt));

  const fixtureBytes = fs.readFileSync(exported.fixture, "utf8");
  const labelsBytes = fs.readFileSync(exported.labels, "utf8");
  const fixture = json(exported.fixture);
  const labels = json(exported.labels);
  const manifest = json(exported.manifest);
  const receipt = json(exported.receipt);
  assert.strictEqual(fixture.cases.length, 3, "every fresh job must enter the denominator");
  assert.deepStrictEqual(fixture.cases.map((item) => item.id), [...fixture.cases.map((item) => item.id)].sort());
  assert(fixture.cases.every((item) => /^[a-f0-9]{64}$/.test(item.id)), "evaluation IDs must be non-reversible hashes");
  assert.strictEqual(new Set(fixture.cases.map((item) => item.id)).size, fixture.cases.length, "same-content jobs need distinct artifact-local evaluation IDs");
  assert.deepStrictEqual(manifest.technicalBucketCounts, { analysis_running: 1, contract_failure: 1 },
    "latest failed/running attempts must remain technical");
  const recoveredCase = fixture.cases.find((item) => item.selectedObservationId === selectedObservationId);
  assert(recoveredCase, "seen_at ties must select the higher observation id");
  assert.strictEqual(recoveredCase.modelContract.attemptCount, 2);
  assert.strictEqual(recoveredCase.modelContract.finalAttemptStatus, "succeeded");
  assert.strictEqual(recoveredCase.modelContract.recoveryOutcome, "recovered");
  assert.strictEqual(recoveredCase.modelContract.hadContractFailure, true);
  assert.strictEqual(recoveredCase.modelContract.contractFailureCount, 1);
  assert.deepStrictEqual(recoveredCase.modelContract.contractFailureStages, ["match_job"]);
  assert.strictEqual(recoveredCase.modelContract.contractRecoveryOutcome, "recovered");
  assert.strictEqual(recoveredCase.modelContract.invalidFieldCategory, `not_persisted_by_schema_v${SCHEMA_VERSION}`);
  assert.strictEqual(recoveredCase.technicalBucket, null);
  const contractFailureCase = fixture.cases.find((item) => item.technicalBucket === "contract_failure");
  assert.strictEqual(contractFailureCase.modelContract.finalAttemptStatus, "failed");
  assert.strictEqual(contractFailureCase.modelContract.finalFailure, "MODEL_CONTRACT_INVALID");
  assert.strictEqual(contractFailureCase.modelContract.hadContractFailure, true);
  assert.strictEqual(contractFailureCase.modelContract.contractFailureCount, 1);
  assert.deepStrictEqual(contractFailureCase.modelContract.contractFailureStages, ["match_responsibilities"]);
  assert.strictEqual(contractFailureCase.modelContract.contractRecoveryOutcome, "unrecovered");
  const runningCase = fixture.cases.find((item) => item.technicalBucket === "analysis_running");
  assert.strictEqual(runningCase.modelContract.finalAttemptStatus, "running");
  assert.strictEqual(runningCase.modelContract.attemptCount, 2);
  assert.strictEqual(runningCase.modelContract.hadContractFailure, true);
  assert.strictEqual(runningCase.modelContract.contractFailureCount, 1);
  assert.deepStrictEqual(runningCase.modelContract.contractFailureStages, ["understand_job"]);
  assert.strictEqual(runningCase.modelContract.contractRecoveryOutcome, "in_progress");
  assert.strictEqual(Object.hasOwn(runningCase.modelContract, "invalidField"), false,
    `schema v${SCHEMA_VERSION} does not persist a trustworthy concrete invalid field`);
  assert.strictEqual(runningCase.productionMatrixTier, null);
  assert.deepStrictEqual(labels.rows.map((row) => row.status), ["pending-human", "pending-human", "pending-human"]);
  assert(labels.rows.every((row) => row.directionFit === null && row.expectedTier === null && row.labeledAt === null));
  assert(labels.rows.every((row) => Object.hasOwn(row, "aiProvisional")), "AI suggestions must stay in a separate field");
  assert(manifest.mandatoryReviewIds.length === 2, "salary-boundary and cross-stack promotions must require review");
  for (const privateValue of ["platform-source-id-must-not-leak", "private.example", "Sensitive Company Ltd", "Secret Recruiter", "Resume evidence must stay private", "Resume Node.js"]) {
    assert.strictEqual(fixtureBytes.includes(privateValue), false, `fixture leaked private value: ${privateValue}`);
    assert.strictEqual(labelsBytes.includes(privateValue), false, `labels leaked private value: ${privateValue}`);
  }
  assert.strictEqual(fixtureBytes.includes("Node.js and reliable delivery"), true, "redacted JD text must remain available locally");
  const shadowReport = buildShadowReport(fixture);
  assert.strictEqual(shadowReport.rawTotal, 3, "fixture must feed the existing scorecard directly");
  assert.strictEqual(shadowReport.qualityEligibleCaseCount, 1);
  assert.strictEqual(shadowReport.matrixVsGuardedScorecard.total, 1);
  assert.deepStrictEqual(shadowReport.technicalBucketCounts, { analysis_running: 1, contract_failure: 1 });
  assert.strictEqual(runningCase.scanEvidence.completeJd, true,
    "complete JD must use the production readiness predicate rather than semantic status");
  const allArtifacts = [exported.fixture, exported.labels, exported.manifest, exported.receipt].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  for (const privateValue of [
    "platform-source-id-must-not-leak", "private.example", "Sensitive Company Ltd", "Secret Recruiter",
    "Resume evidence must stay private", "recruiter@example.test", "13800138000", "微信secretwx",
    "张三", "李经理", "王女士", "021-12345678", "12345678", "ding-secret", "@tele_secret", "张江路88号A座"
  ]) {
    assert.strictEqual(allArtifacts.includes(privateValue), false, `every artifact must omit ${privateValue}`);
  }
  for (const rawHash of ["a".repeat(64), "d".repeat(64), "f".repeat(64)]) {
    assert.strictEqual(allArtifacts.includes(rawHash), false, "raw observation content hashes must never leave memory");
  }
  assert.strictEqual(allArtifacts.includes("sourceContentHash"), false);
  assert.deepStrictEqual(manifest.counts, { rawObservations: 4, uniqueJobs: 3, collapsedObservations: 1, technicalCases: 2 });
  assert.strictEqual(manifest.qualityEligible, true);
  assert.strictEqual(manifest.qualityEligibleCaseCount, 1);
  assert.strictEqual(manifest.cohortComplete, true);
  assert.strictEqual(receipt.qualityEligible, true);
  assert.strictEqual(receipt.qualityEligibleCaseCount, 1);
  assert.strictEqual(receipt.cohortComplete, true);
  assert.strictEqual(manifest.cohortContract, "formal-full-scan-only-v1");
  assert.deepStrictEqual(manifest.privacy, {
    artifactClass: "private-local",
    redactionPolicyVersion: "gate-d-private-redaction-v2",
    limitation: "pattern-based redaction reduces known identifiers but cannot guarantee perfect entity recognition"
  });
  assert.strictEqual(recoveredCase.jd.location, "上海市浦东新区");

  const second = exportEvaluation(options(path.join(TEST_ROOT, "second"), artifacts), testSeam());
  assert.strictEqual(fs.readFileSync(second.fixture, "utf8"), fixtureBytes, "fixture must be byte-deterministic across output roots");
  assert.strictEqual(fs.readFileSync(second.labels, "utf8"), labelsBytes, "labels must be byte-deterministic across output roots");

  const telemetryDb = new DatabaseSync(DB_PATH);
  telemetryDb.exec("PRAGMA foreign_keys = OFF");
  const telemetryDescription = "This complete local evaluation job description is deliberately longer than one hundred and twenty characters so contract telemetry fallback behavior is tested without entering the incomplete JD technical bucket.";
  const analysisOnlyFailure = analysis({
    semanticStatus: "failed",
    recommendation: null,
    errorCode: "MODEL_CONTRACT_INVALID",
    errorStage: "matchRequirements"
  });
  const analysisOnlyFailureJobId = Number(telemetryDb.prepare(`INSERT INTO jobs(
      source, source_id, title, description, analysis_json, first_seen_at, last_seen_at, batch_id
    ) VALUES ('boss', 'analysis-only-contract-source', 'Analysis-only contract failure', ?, ?,
      '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', 1)`)
    .run(telemetryDescription, JSON.stringify(analysisOnlyFailure)).lastInsertRowid);
  const analysisOnlyFailureObservationId = Number(telemetryDb.prepare(`INSERT INTO job_observations(
      job_id, batch_id, title, description, analysis_json, quality_tags_json, content_hash, seen_at
    ) VALUES (?, 1, 'Analysis-only contract failure', ?, ?, '[]', ?, '2026-08-12T00:00:00.000Z')`)
    .run(analysisOnlyFailureJobId, telemetryDescription, JSON.stringify(analysisOnlyFailure), "1".repeat(64)).lastInsertRowid);
  const succeededJobId = Number(telemetryDb.prepare(`INSERT INTO jobs(
      source, source_id, title, description, analysis_json, first_seen_at, last_seen_at, batch_id
    ) VALUES ('boss', 'succeeded-contract-coverage-source', 'Succeeded analysis coverage', ?, ?,
      '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', 1)`)
    .run(telemetryDescription, JSON.stringify(analysis())).lastInsertRowid);
  const succeededObservationId = Number(telemetryDb.prepare(`INSERT INTO job_observations(
      job_id, batch_id, title, description, analysis_json, quality_tags_json, content_hash, seen_at
    ) VALUES (?, 1, 'Succeeded analysis coverage', ?, ?, '[]', ?, '2026-08-12T00:00:00.000Z')`)
    .run(succeededJobId, telemetryDescription, JSON.stringify(analysis()), "2".repeat(64)).lastInsertRowid);
  telemetryDb.prepare(`INSERT INTO job_analysis_attempts(
      workflow_run_id, task_id, job_id, recovery_generation, attempt_in_generation, total_attempt_number,
      profile_kind, model_config_revision, provider, model, thinking_mode, reasoning_effort,
      status, started_at, finished_at, created_at, updated_at
    ) VALUES ('fixture-workflow', 104, ?, 0, 1, 1, 'batch_screening', 'fixture-revision',
      'fixture-provider', 'fixture-model', 'off', 'low', 'succeeded',
      '2026-08-12T00:01:00.000Z', '2026-08-12T00:02:00.000Z',
      '2026-08-12T00:00:00.000Z', '2026-08-12T00:02:00.000Z')`).run(succeededJobId);
  telemetryDb.close();

  const telemetryExport = exportEvaluation(options(path.join(TEST_ROOT, "contract-telemetry"), artifacts), testSeam());
  const telemetryFixture = json(telemetryExport.fixture);
  const telemetryManifest = json(telemetryExport.manifest);
  const telemetryReceipt = json(telemetryExport.receipt);
  const analysisOnlyFailureCase = telemetryFixture.cases.find((item) => item.selectedObservationId === analysisOnlyFailureObservationId);
  assert.strictEqual(analysisOnlyFailureCase.modelContract.hadContractFailure, true);
  assert.strictEqual(analysisOnlyFailureCase.modelContract.contractFailureCount, 1);
  assert.deepStrictEqual(analysisOnlyFailureCase.modelContract.contractFailureStages, ["match_requirements"]);
  assert.strictEqual(analysisOnlyFailureCase.modelContract.contractRecoveryOutcome, "unrecovered");
  assert.strictEqual(analysisOnlyFailureCase.modelContract.finalFailure, "MODEL_CONTRACT_INVALID");
  assert.strictEqual(analysisOnlyFailureCase.modelContract.attemptCount, 0);
  const succeededCoverageCase = telemetryFixture.cases.find((item) => item.selectedObservationId === succeededObservationId);
  assert.strictEqual(succeededCoverageCase.modelContract.finalAttemptStatus, "succeeded");
  assert.strictEqual(succeededCoverageCase.modelContract.hadContractFailure, false,
    "a succeeded attempt may report no observed failure without claiming same-call repair visibility");
  assert.strictEqual(succeededCoverageCase.modelContract.contractFailureCount, 0);
  assert.strictEqual(succeededCoverageCase.modelContract.contractRecoveryOutcome, "not_applicable");
  const expectedContractTelemetryCoverage = {
    finalFailures: "analysis_json",
    workflowAttempts: "job_analysis_attempts",
    sameCallInternalRepairs: `not_persisted_by_schema_v${SCHEMA_VERSION}`,
    fieldLevel: `not_persisted_by_schema_v${SCHEMA_VERSION}`
  };
  assert.deepStrictEqual(telemetryManifest.contractTelemetryCoverage, expectedContractTelemetryCoverage);
  assert.deepStrictEqual(telemetryReceipt.contractTelemetryCoverage, expectedContractTelemetryCoverage);

  const telemetryCleanupDb = new DatabaseSync(DB_PATH);
  telemetryCleanupDb.prepare("DELETE FROM job_analysis_attempts WHERE job_id = ?").run(succeededJobId);
  telemetryCleanupDb.prepare("DELETE FROM job_observations WHERE job_id IN (?, ?)").run(analysisOnlyFailureJobId, succeededJobId);
  telemetryCleanupDb.prepare("DELETE FROM jobs WHERE id IN (?, ?)").run(analysisOnlyFailureJobId, succeededJobId);
  telemetryCleanupDb.close();

  const technicalDb = new DatabaseSync(DB_PATH);
  const originalQualityTags = technicalDb.prepare("SELECT id, quality_tags_json FROM job_observations ORDER BY id").all();
  technicalDb.prepare(`UPDATE job_observations SET quality_tags_json = '["detail_unverified"]'`).run();
  technicalDb.close();
  const allTechnical = exportEvaluation(options(path.join(TEST_ROOT, "all-technical"), artifacts), testSeam());
  const allTechnicalManifest = json(allTechnical.manifest);
  const allTechnicalReceipt = json(allTechnical.receipt);
  assert.strictEqual(allTechnicalManifest.qualityEligibleCaseCount, 0);
  assert.strictEqual(allTechnicalManifest.qualityEligible, false,
    "qualityEligible must mean at least one non-technical evaluation case");
  assert.strictEqual(allTechnicalManifest.cohortComplete, true,
    "cohort completeness is independent from evaluation eligibility");
  assert.strictEqual(allTechnicalReceipt.qualityEligibleCaseCount, 0);
  assert.strictEqual(allTechnicalReceipt.qualityEligible, false);
  assert.strictEqual(allTechnicalReceipt.cohortComplete, true);
  const restoreQualityDb = new DatabaseSync(DB_PATH);
  const restoreQuality = restoreQualityDb.prepare("UPDATE job_observations SET quality_tags_json = ? WHERE id = ?");
  for (const row of originalQualityTags) restoreQuality.run(row.quality_tags_json, row.id);
  restoreQualityDb.close();

  const walWriter = new DatabaseSync(DB_PATH);
  walWriter.exec("PRAGMA journal_mode = WAL");
  const walJobId = Number(walWriter.prepare(`INSERT INTO jobs(source, source_id, title, description, analysis_json, first_seen_at, last_seen_at, batch_id)
    VALUES ('boss', 'wal-source-id', 'WAL job', ?, ?, '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', 1)`).run(
    "WAL-only detailed description with more than one hundred and twenty characters so the source snapshot must include committed data held in SQLite WAL before the writer closes.", JSON.stringify(analysis())
  ).lastInsertRowid);
  walWriter.prepare(`INSERT INTO job_observations(job_id, batch_id, title, description, analysis_json, quality_tags_json, content_hash, seen_at)
    VALUES (?, 1, 'WAL job', ?, ?, '[]', ?, '2026-08-12T00:00:00.000Z')`).run(
    walJobId, "WAL-only detailed description with more than one hundred and twenty characters so the source snapshot must include committed data held in SQLite WAL before the writer closes.", JSON.stringify(analysis()), "e".repeat(64)
  );
  assert(fs.existsSync(`${DB_PATH}-wal`), "the regression fixture must retain committed source WAL data");
  const walExport = exportEvaluation(options(path.join(TEST_ROOT, "wal"), artifacts), testSeam());
  assert.strictEqual(json(walExport.fixture).cases.length, 4, "ordinary read-only VACUUM snapshot must include committed WAL rows");
  walWriter.close();

  for (const status of ["partial", "failed", "interrupted", "running"]) {
    const stateDb = new DatabaseSync(DB_PATH);
    stateDb.prepare("UPDATE scan_runs SET status = ?").run(status);
    stateDb.close();
    const stateRoot = path.join(TEST_ROOT, `scan-${status}`);
    assert.throws(() => exportEvaluation(options(stateRoot, artifacts), testSeam()), /scan_run to be completed/i, `${status} scan runs must fail closed`);
    assertNoOutput(stateRoot);
    const resetDb = new DatabaseSync(DB_PATH);
    resetDb.prepare("UPDATE scan_runs SET status = 'completed'").run();
    resetDb.close();
  }
  const targetStateDb = new DatabaseSync(DB_PATH);
  targetStateDb.prepare("UPDATE scan_target_results SET status = 'failed'").run();
  targetStateDb.close();
  assert.throws(() => exportEvaluation(options(path.join(TEST_ROOT, "target-failed"), artifacts), testSeam()), /scan targets/i);
  const targetResetDb = new DatabaseSync(DB_PATH);
  targetResetDb.prepare("UPDATE scan_target_results SET status = 'completed'").run();
  targetResetDb.close();

  for (const hookName of ["snapshotUnlink", "snapshotRmdir"]) {
    const snapshotRoot = path.join(TEST_ROOT, `fault-${hookName}`);
    assert.throws(() => exportEvaluation(options(snapshotRoot, artifacts), {
      ...testSeam(),
      [hookName]() { throw new Error(`injected ${hookName} failure`); }
    }), /snapshot cleanup failed/i);
    assertNoOutput(snapshotRoot);
  }
  const snapshotNotEmptyRoot = path.join(TEST_ROOT, "fault-snapshot-rmdir-enotempty");
  assert.throws(() => exportEvaluation(options(snapshotNotEmptyRoot, artifacts), {
    ...testSeam(),
    snapshotRmdir() {
      const error = new Error("injected snapshot directory ENOTEMPTY");
      error.code = "ENOTEMPTY";
      throw error;
    }
  }), /snapshot cleanup failed/i, "ENOTEMPTY in the dedicated snapshot directory must fail closed");
  assertNoOutput(snapshotNotEmptyRoot);

  for (const [label, hooks] of [
    ["link", { link() { throw new Error("injected link failure"); } }],
    ["unlink", { unlinkPartial() { throw new Error("injected unlink failure"); } }],
    ["receipt", { writeFile(file, value, options) { if (file.endsWith("gate-d-evaluation-receipt.json")) throw new Error("injected receipt write failure"); fs.writeFileSync(file, value, options); } }]
  ]) {
    const faultRoot = path.join(TEST_ROOT, `fault-${label}`);
    assert.throws(() => exportEvaluation(options(faultRoot, artifacts), { ...testSeam(), ...hooks }), /injected .* failure/);
    assertNoOutput(faultRoot);
  }
  let mkdirCalls = 0;
  const mkdirRoot = path.join(TEST_ROOT, "fault-mkdir");
  assert.throws(() => exportEvaluation(options(mkdirRoot, artifacts), {
    ...testSeam(),
    mkdir(directory) { mkdirCalls += 1; if (mkdirCalls === 3) throw new Error("injected mkdir failure"); fs.mkdirSync(directory); }
  }), /injected mkdir failure/);
  assertNoOutput(mkdirRoot);

  const atomicRoot = path.join(TEST_ROOT, "receipt-atomic");
  const linkedFinals = [];
  let receiptRenamed = false;
  const atomic = exportEvaluation(options(atomicRoot, artifacts), {
    ...testSeam(),
    link(partialFile, finalFile) { linkedFinals.push(finalFile); fs.linkSync(partialFile, finalFile); },
    renameReceipt(partialFile, finalFile) {
      assert.strictEqual(linkedFinals.length, 3, "fixture, labels and manifest must publish before receipt");
      assert.strictEqual(fs.existsSync(finalFile), false, "complete-looking receipt must not exist before atomic rename");
      receiptRenamed = true;
      fs.renameSync(partialFile, finalFile);
    }
  });
  assert.strictEqual(receiptRenamed, true);
  assert(fs.existsSync(atomic.receipt));

  const renameRoot = path.join(TEST_ROOT, "receipt-rename-failure");
  assert.throws(() => exportEvaluation(options(renameRoot, artifacts), {
    ...testSeam(),
    renameReceipt() { throw new Error("injected receipt rename failure"); }
  }), /injected receipt rename failure/);
  assertNoOutput(renameRoot);

  const cleanupRoot = path.join(TEST_ROOT, "cleanup-final-failure");
  let cleanupFailureInjected = false;
  let cleanupError;
  try {
    exportEvaluation(options(cleanupRoot, artifacts), {
      ...testSeam(),
      unlinkPartial() { throw new Error("trigger cleanup after final link"); },
      cleanupUnlink(file) {
        if (!cleanupFailureInjected && !file.includes(".partial-")) {
          cleanupFailureInjected = true;
          throw new Error("injected cleanup final failure");
        }
        fs.unlinkSync(file);
      }
    });
    assert.fail("cleanup fault must reject export");
  } catch (error) {
    cleanupError = error;
    assert.match(error.message, /trigger cleanup after final link/);
  }
  assert(cleanupError.cleanupError, "cleanup failures must be attached for audit");
  assertNoOutput(cleanupRoot);

  const existingRoot = path.join(TEST_ROOT, "existing");
  const existingFinal = path.join(existingRoot, "fixtures", "gate-d-evaluation-fixture.json");
  fs.mkdirSync(path.dirname(existingFinal), { recursive: true });
  fs.writeFileSync(existingFinal, "do not overwrite", "utf8");
  assert.throws(() => exportEvaluation(options(existingRoot, artifacts), testSeam()), /overwrite/i);
  const priorEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  assert.throws(() => exportEvaluation(options(path.join(TEST_ROOT, "bad-seam"), artifacts), testSeam()), /testOnly seam/i);
  process.env.NODE_ENV = priorEnvironment;
  const junction = path.join(TEST_ROOT, "baseline-alias");
  try {
    fs.symlinkSync(BASELINE_ROOT, junction, "junction");
    const aliased = exportEvaluation({ ...options(path.join(TEST_ROOT, "junction-output"), artifacts), db: path.join(junction, "jobs.sqlite") }, {
      testOnly: { enabled: true, baselineRoot: junction, identityKey: "test-only-evaluation-key" }
    });
    assert(fs.existsSync(aliased.fixture), "canonicalized junction aliases must remain inside the approved test baseline root");
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) throw error;
  }

  assert.throws(
    () => exportEvaluation({ ...options(path.join(TEST_ROOT, "production"), artifacts), db: path.join(ROOT, "data", "jobs.sqlite") }, testSeam()),
    /production database/i,
    "project production DB must always be rejected"
  );
  const mismatch = task13Artifacts(batchId, { receiptPatch: { baselinePath: path.join(TEST_ROOT, "wrong.sqlite") } });
  const mismatchRoot = path.join(TEST_ROOT, "mismatch");
  assert.throws(() => exportEvaluation(options(mismatchRoot, mismatch), testSeam()), /receipt.*baseline|baseline.*receipt/i);
  assertNoOutput(mismatchRoot);
  task13Artifacts(batchId);

  const changingRoot = path.join(TEST_ROOT, "changing");
  assert.throws(() => exportEvaluation(options(changingRoot, artifacts), {
    ...testSeam(),
    beforeAfterFingerprint() {
      const db = new DatabaseSync(DB_PATH);
      db.prepare("UPDATE jobs SET last_seen_at = '2026-08-12T00:00:01.000Z' WHERE id = 1").run();
      db.close();
    }
  }), /database\/WAL changed/i, "a concurrent source mutation must reject publication");
  assertNoOutput(changingRoot);

  const partialRoot = path.join(TEST_ROOT, "partial");
  assert.throws(() => exportEvaluation(options(partialRoot, artifacts), {
    ...testSeam(),
    beforePublish() { throw new Error("injected partial publish failure"); }
  }), /injected partial publish failure/);
  assertNoOutput(partialRoot);

  for (const command of ["refresh", "activity"]) {
    const maintenanceDb = new DatabaseSync(DB_PATH);
    const maintenanceBatchId = Number(maintenanceDb.prepare(`INSERT INTO batches(site, keyword, started_at, status, finished_at)
      VALUES ('boss', 'forged-full-scan', '2026-08-12T01:00:00.000Z', 'completed', '2026-08-12T01:01:00.000Z')`).run().lastInsertRowid);
    maintenanceDb.prepare(`INSERT INTO scan_runs(id, site, command, batch_id, status, created_at, started_at, finished_at)
      VALUES (?, 'boss', ?, ?, 'completed', '2026-08-12T01:00:00.000Z', '2026-08-12T01:00:00.000Z', '2026-08-12T01:01:00.000Z')`)
      .run(`maintenance-${command}`, command, maintenanceBatchId);
    maintenanceDb.prepare(`INSERT INTO scan_target_results(batch_id, target_key, status, started_at, finished_at)
      VALUES (?, ?, 'completed', '2026-08-12T01:00:00.000Z', '2026-08-12T01:01:00.000Z')`)
      .run(maintenanceBatchId, `forged-${command}-target`);
    maintenanceDb.close();
    const maintenanceRoot = path.join(TEST_ROOT, `maintenance-${command}`);
    assert.throws(() => exportEvaluation(options(maintenanceRoot, artifacts), testSeam()),
      /formal full-scan cohort requires scan_runs\.command daily\|broad; maintenance commands are unsupported/i);
    assertNoOutput(maintenanceRoot);
    const maintenanceCleanupDb = new DatabaseSync(DB_PATH);
    maintenanceCleanupDb.prepare("DELETE FROM scan_target_results WHERE batch_id = ?").run(maintenanceBatchId);
    maintenanceCleanupDb.prepare("DELETE FROM scan_runs WHERE id = ?").run(`maintenance-${command}`);
    maintenanceCleanupDb.prepare("DELETE FROM batches WHERE id = ?").run(maintenanceBatchId);
    maintenanceCleanupDb.close();
  }

  let historyDb = new DatabaseSync(DB_PATH);
  historyDb.prepare("INSERT INTO batches(site, keyword, started_at, status, finished_at) VALUES ('boss', 'old', '2026-01-01T00:00:00.000Z', 'completed', '2026-01-01T00:00:00.000Z')").run();
  historyDb.close();
  const historyRoot = path.join(TEST_ROOT, "history");
  assert.throws(() => exportEvaluation(options(historyRoot, artifacts), testSeam()), /completed scan_run|scan targets/i, "historical batches must not enter the fresh denominator");
  assertNoOutput(historyRoot);
  historyDb = new DatabaseSync(DB_PATH);
  historyDb.prepare("DELETE FROM batches WHERE keyword = 'old'").run();
  historyDb.prepare(`INSERT INTO jobs(source, source_id, title, first_seen_at, last_seen_at)
    VALUES ('boss', 'orphan-source-id', 'Orphan job', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')`).run();
  historyDb.close();
  const orphanRoot = path.join(TEST_ROOT, "orphan");
  assert.throws(() => exportEvaluation(options(orphanRoot, artifacts), testSeam()), /orphan job/i, "orphan jobs must be rejected");
  assertNoOutput(orphanRoot);

  console.log("gate_d_evaluation_export_smoke ok");
} finally {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
}
