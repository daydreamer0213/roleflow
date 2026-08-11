const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { openDb } = require("../src/core/storage");
const { buildShadowReport } = require("../scripts/compare-shadow-scorecard");
const { exportEvaluation } = require("../scripts/export-gate-d-evaluation");

const ROOT = path.resolve(__dirname, "..");
const TEST_ROOT = fs.mkdtempSync(path.join("D:\\DevData", "RoleFlow-gate-d-evaluation-test-"));
const BASELINE_ROOT = path.join(TEST_ROOT, "baseline");
const DB_PATH = path.join(BASELINE_ROOT, "jobs.sqlite");
const SOURCE_COMMIT = "b".repeat(40);
process.env.NODE_ENV = "test";
const OPERATIONAL_TABLES = [
  "resume_parse_attempts", "keyword_sources", "platform_filter_catalogs", "model_cache", "site_runtime_states", "site_scan_leases",
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
    const batchId = Number(insert(db, `INSERT INTO batches(site, keyword, started_at, status, finished_at)
      VALUES ('boss', 'node', ?, 'completed', ?)`, now, now).lastInsertRowid);
    insert(db, `INSERT INTO scan_runs(id, site, batch_id, status, created_at, started_at, finished_at)
      VALUES ('fresh-scan', 'boss', ?, 'completed', ?, ?, ?)`, batchId, now, now, now);
    const rows = [
      {
        sourceId: "platform-source-id-must-not-leak",
        title: "Node.js Engineer",
        company: "Sensitive Company Ltd",
        description: "Sensitive Company Ltd is hiring. Recruiter Secret Recruiter requires Node.js and reliable delivery; recruiter@example.test, 13800138000 and 微信secretwx are private. This detailed job description is intentionally longer than one hundred and twenty characters for the production readiness predicate.",
        contentHash: "a".repeat(64),
        analysis: analysis({ recruiter: "Secret Recruiter" }),
        qualityTags: []
      },
      {
        sourceId: "salary-boundary-source-id",
        title: "Platform Engineer",
        company: "Boundary Company",
        description: "Boundary Company requires platform engineering, Node.js and a carefully bounded salary range. This detailed job description is intentionally longer than one hundred and twenty characters for the production readiness predicate.",
        contentHash: "c".repeat(64),
        analysis: analysis({ recommendation: "apply", fixedSalaryBoundary: true }),
        qualityTags: ["salary_out_of_range"]
      },
      {
        sourceId: "technical-bucket-source-id",
        title: "Cross stack Engineer",
        company: "Technical Company",
        description: "Technical Company requires Node.js work while a cross stack promotion must be reviewed. This detailed job description is intentionally longer than one hundred and twenty characters for the production readiness predicate.",
        contentHash: "d".repeat(64),
        analysis: analysis({ semanticStatus: "failed", decisionSource: "analysis_pending", recommendation: null, errorCode: "MODEL_TIMEOUT", crossStackPromotion: true }),
        qualityTags: []
      }
    ];
    for (const row of rows) {
      const jobId = Number(insert(db, `INSERT INTO jobs(source, source_id, title, company, url, description, analysis_json, first_seen_at, last_seen_at, batch_id)
        VALUES ('boss', ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.sourceId, row.title, row.company,
      `https://private.example/${row.sourceId}`, row.description, JSON.stringify(row.analysis), now, now, batchId).lastInsertRowid);
      insert(db, `INSERT INTO job_observations(job_id, batch_id, title, company, url, description, analysis_json, quality_tags_json, content_hash, seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, jobId, batchId, row.title, row.company,
      `https://private.example/${row.sourceId}`, row.description, JSON.stringify(row.analysis), JSON.stringify(row.qualityTags), row.contentHash, now);
    }
    insert(db, `INSERT INTO scan_target_results(batch_id, target_key, status, started_at, finished_at)
      VALUES (?, 'fresh-target', 'completed', ?, ?)`, batchId, now, now);
    return batchId;
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
    schemaVersion: 11
  });
  writeJson(reportPath, {
    artifact: "gate-d-baseline",
    sourcePath: path.join(TEST_ROOT, "production-source.sqlite"),
    archivePath,
    baselinePath: DB_PATH,
    schemaVersion: 11,
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
  const batchId = seedDb();
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
  assert.strictEqual(fixture.cases.length, 3, "every fresh job must enter the denominator");
  assert.deepStrictEqual(fixture.cases.map((item) => item.id), [...fixture.cases.map((item) => item.id)].sort());
  assert(fixture.cases.every((item) => /^[a-f0-9]{64}$/.test(item.id)), "evaluation IDs must be non-reversible hashes");
  assert.strictEqual(fixture.cases.find((item) => item.technicalBucket === "semantic_failed").productionMatrixTier, null);
  assert.strictEqual(manifest.technicalBucketCounts.semantic_failed, 1, "technical buckets must not be forced into tiers");
  assert.deepStrictEqual(labels.rows.map((row) => row.status), ["pending-human", "pending-human", "pending-human"]);
  assert(labels.rows.every((row) => row.directionFit === null && row.expectedTier === null && row.labeledAt === null));
  assert(labels.rows.every((row) => Object.hasOwn(row, "aiProvisional")), "AI suggestions must stay in a separate field");
  assert(manifest.mandatoryReviewIds.length === 2, "salary-boundary and cross-stack promotions must require review");
  for (const privateValue of ["platform-source-id-must-not-leak", "private.example", "Sensitive Company Ltd", "Secret Recruiter", "Resume evidence must stay private", "Resume Node.js"]) {
    assert.strictEqual(fixtureBytes.includes(privateValue), false, `fixture leaked private value: ${privateValue}`);
    assert.strictEqual(labelsBytes.includes(privateValue), false, `labels leaked private value: ${privateValue}`);
  }
  assert.strictEqual(fixtureBytes.includes("Node.js and reliable delivery"), true, "redacted JD text must remain available locally");
  assert.strictEqual(buildShadowReport(fixture).total, 3, "fixture must feed the existing scorecard directly");
  assert.strictEqual(fixture.cases.find((item) => item.technicalBucket === "semantic_failed").scanEvidence.completeJd, true,
    "complete JD must use the production readiness predicate rather than semantic status");
  const allArtifacts = [exported.fixture, exported.labels, exported.manifest, exported.receipt].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  for (const privateValue of ["platform-source-id-must-not-leak", "private.example", "Sensitive Company Ltd", "Secret Recruiter", "Resume evidence must stay private", "recruiter@example.test", "13800138000", "微信secretwx"]) {
    assert.strictEqual(allArtifacts.includes(privateValue), false, `every artifact must omit ${privateValue}`);
  }
  assert.deepStrictEqual(manifest.counts, { rawObservations: 3, uniqueJobs: 3, collapsedObservations: 0 });
  assert.strictEqual(manifest.qualityEligible, 2);

  const second = exportEvaluation(options(path.join(TEST_ROOT, "second"), artifacts), testSeam());
  assert.strictEqual(fs.readFileSync(second.fixture, "utf8"), fixtureBytes, "fixture must be byte-deterministic across output roots");
  assert.strictEqual(fs.readFileSync(second.labels, "utf8"), labelsBytes, "labels must be byte-deterministic across output roots");

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
