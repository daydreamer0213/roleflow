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
        description: "Sensitive Company Ltd is hiring. Recruiter Secret Recruiter requires Node.js and reliable delivery.",
        contentHash: "a".repeat(64),
        analysis: analysis({ recruiter: "Secret Recruiter" }),
        qualityTags: []
      },
      {
        sourceId: "salary-boundary-source-id",
        title: "Platform Engineer",
        company: "Boundary Company",
        description: "Boundary Company requires platform engineering, Node.js and a carefully bounded salary range.",
        contentHash: "c".repeat(64),
        analysis: analysis({ recommendation: "apply", fixedSalaryBoundary: true }),
        qualityTags: ["salary_out_of_range"]
      },
      {
        sourceId: "technical-bucket-source-id",
        title: "Cross stack Engineer",
        company: "Technical Company",
        description: "Technical Company requires Node.js work while a cross stack promotion must be reviewed.",
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
    operational: { after: { jobs: 0, batches: 0, job_observations: 0 } },
    ...reportPatch
  });
  writeJson(receiptPath, {
    artifact: "gate-d-baseline-receipt",
    complete: true,
    archivePath,
    baselinePath: DB_PATH,
    schemaVersion: 11,
    sourceCommit: SOURCE_COMMIT,
    scanTerminal: true,
    freshBatchIds: [batchId],
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
  return { testOnly: { baselineRoot: BASELINE_ROOT } };
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
  assert.strictEqual(fixture.cases.find((item) => item.technicalBucket === "analysis_pending").productionMatrixTier, null);
  assert.strictEqual(manifest.technicalBucketCounts.analysis_pending, 1, "technical buckets must not be forced into tiers");
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

  const second = exportEvaluation(options(path.join(TEST_ROOT, "second"), artifacts), testSeam());
  assert.strictEqual(fs.readFileSync(second.fixture, "utf8"), fixtureBytes, "fixture must be byte-deterministic across output roots");
  assert.strictEqual(fs.readFileSync(second.labels, "utf8"), labelsBytes, "labels must be byte-deterministic across output roots");

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
  }), /bundle changed/i, "a concurrent source mutation must reject publication");
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
  assert.throws(() => exportEvaluation(options(historyRoot, artifacts), testSeam()), /fresh batch|historical/i, "historical batches must not enter the fresh denominator");
  assertNoOutput(historyRoot);
  historyDb = new DatabaseSync(DB_PATH);
  historyDb.prepare("DELETE FROM batches WHERE keyword = 'old'").run();
  historyDb.prepare(`INSERT INTO jobs(source, source_id, title, first_seen_at, last_seen_at)
    VALUES ('boss', 'orphan-source-id', 'Orphan job', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')`).run();
  historyDb.close();
  const orphanRoot = path.join(TEST_ROOT, "orphan");
  assert.throws(() => exportEvaluation(options(orphanRoot, artifacts), testSeam()), /without a fresh observation/i, "orphan jobs must be rejected");
  assertNoOutput(orphanRoot);

  console.log("gate_d_evaluation_export_smoke ok");
} finally {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
}
