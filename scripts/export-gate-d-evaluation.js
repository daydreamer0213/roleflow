const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { DECISION_POLICY, RECOMMENDATION_TIERS, decisionPolicyHash } = require("../src/core/decision_policy");
const { deriveMatrixDecision } = require("../src/core/four_tier_decision");
const { buildShadowScorecard } = require("./lib/shadow_scorecard");

const ROOT = path.resolve(__dirname, "..");
const GATE_D_BASELINE_ROOT = "D:\\DevData\\RoleFlow-gate-d\\baseline";
const PRODUCTION_DB = path.join(ROOT, "data", "jobs.sqlite");
const ARCHIVE_ROOT = "D:\\DevData\\RoleFlow-gate-d\\archive";
const SCHEMA_VERSION = 11;
const TERMINAL_SCAN_STATUSES = new Set(["completed", "partial", "failed", "interrupted"]);
const FIXTURE_NAME = "gate-d-evaluation-fixture.json";
const LABELS_NAME = "gate-d-evaluation-labels.json";
const MANIFEST_NAME = "gate-d-evaluation-manifest.json";
const RECEIPT_NAME = "gate-d-evaluation-receipt.json";

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!new Set(["--db", "--report", "--receipt", "--output-root"]).has(flag)) {
      throw new Error("usage: node scripts/export-gate-d-evaluation.js --db <baseline.sqlite> [--report <baseline.report.json>] [--receipt <baseline.receipt.json>] --output-root <baseline-root>");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (values[key]) throw new Error(`duplicate ${flag}`);
    values[key] = value;
    index += 1;
  }
  if (!values.db || !values.outputRoot) {
    throw new Error("usage: node scripts/export-gate-d-evaluation.js --db <baseline.sqlite> [--report <baseline.report.json>] [--receipt <baseline.receipt.json>] --output-root <baseline-root>");
  }
  return values;
}

function normalizePath(file) {
  const value = path.normalize(file);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function samePath(left, right) {
  return normalizePath(left) === normalizePath(right);
}

function canonicalExisting(file, label) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  return fs.realpathSync.native(resolved);
}

function canonicalTarget(file, label) {
  const resolved = path.resolve(file);
  if (fs.existsSync(resolved)) return fs.realpathSync.native(resolved);
  const missing = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`cannot resolve ${label}: ${resolved}`);
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  if (!fs.statSync(cursor).isDirectory()) throw new Error(`${label} parent is not a directory: ${cursor}`);
  return path.join(fs.realpathSync.native(cursor), ...missing);
}

function isWithin(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashFile(file) {
  return sha256(fs.readFileSync(file));
}

function fingerprintBundle(dbPath) {
  const files = [];
  for (const [name, file] of [["database", dbPath], ["wal", `${dbPath}-wal`], ["shm", `${dbPath}-shm`]]) {
    if (!fs.existsSync(file)) continue;
    const before = fs.statSync(file);
    if (!before.isFile()) throw new Error(`database bundle member is not a file: ${file}`);
    const bytes = fs.readFileSync(file);
    const after = fs.statSync(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`database bundle member changed while reading: ${file}`);
    }
    files.push({ name, size: bytes.length, sha256: sha256(bytes) });
  }
  if (!files.some((item) => item.name === "database")) throw new Error("database bundle is missing its database file");
  return { algorithm: "sha256", files };
}

function immutableReadOnlyUri(dbPath) {
  const normalized = dbPath.replace(/\\/g, "/");
  const encoded = normalized.split("/").map((part, index) => index === 0 ? part : encodeURIComponent(part)).join("/");
  return `file:${encoded}?mode=ro&immutable=1`;
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value || "").trim();
}

function redactor(values) {
  const expressions = values.map(text).filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map((value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));
  return (value) => expressions.reduce((result, expression) => result.replace(expression, "[REDACTED]"), text(value));
}

function evidenceText(value, redact) {
  return text(value) ? redact(value) : "";
}

function matchInput(item, redact) {
  const match = item && typeof item === "object" && !Array.isArray(item) ? item : {};
  const result = {
    state: text(match.state) || "unknown",
    jdEvidence: evidenceText(match.jdEvidence, redact),
    resumeEvidence: text(match.resumeEvidence) ? "[resume-evidence-present]" : ""
  };
  for (const key of ["foundation", "central", "indispensable", "soft"]) {
    if (typeof match[key] === "boolean") result[key] = match[key];
  }
  for (const key of ["requirement", "label", "name"]) {
    if (text(match[key])) result[key] = redact(match[key]);
  }
  if (text(match.explanation) || text(match.rationale)) result.explanation = "[analysis-explanation-present]";
  return result;
}

function boundaryInput(analysis, redact) {
  const explicit = asArray(analysis.boundaries).map((item) => ({
    verified: item?.verified === true,
    blocked: item?.blocked === true,
    reason: text(item?.reason || item?.requirement) ? "[boundary-evidence-present]" : ""
  }));
  const blockers = asArray(analysis.hardBlockers).map((item) => ({
    verified: true,
    blocked: true,
    reason: "[boundary-evidence-present]"
  }));
  return [...explicit, ...blockers];
}

function riskInput(analysis, redact) {
  return [...asArray(analysis.risks), ...asArray(analysis.hiddenRisks)].map((item) => ({
    verified: item?.verified === true,
    severity: text(item?.severity) || "unknown",
    reason: text(typeof item === "string" ? item : (item?.reason || item?.label)) ? "[risk-evidence-present]" : ""
  }));
}

function technicalBucket(analysis, qualityTags) {
  if (["failed", "stale", "pending"].includes(text(analysis.semanticStatus))) return "analysis_pending";
  if (qualityTags.includes("detail_unverified") || qualityTags.includes("activity_unverified")) return "refresh";
  if (text(analysis.errorCode)) return "contract_failure";
  return null;
}

function safeTier(value) {
  return RECOMMENDATION_TIERS.includes(value) ? value : null;
}

function stableEvaluationId(sourceContentHash, jobId) {
  return crypto.createHmac("sha256", "RoleFlow Gate D private evaluation identity v1")
    .update(`${sourceContentHash}\0${jobId}`)
    .digest("hex");
}

function modelContract(analysis, attempts) {
  const finalAttempt = attempts.at(-1) || {};
  return {
    semanticStatus: text(analysis.semanticStatus) || "unknown",
    contractStatus: text(analysis.contractStatus) || (text(analysis.errorCode) ? "failed" : "not_recorded"),
    invalidField: text(analysis.invalidField || analysis.contractInvalidField) || null,
    repairResult: text(analysis.repairResult || analysis.contractRepairResult) || null,
    finalFailure: text(analysis.errorCode || finalAttempt.error_code) || null,
    attemptCount: attempts.length,
    finalAttemptStatus: text(finalAttempt.status) || null
  };
}

function readRows(db, freshBatchIds) {
  const fresh = new Set(freshBatchIds);
  const batches = db.prepare("SELECT id, status FROM batches ORDER BY id").all();
  const actualBatchIds = batches.map((row) => Number(row.id));
  if (actualBatchIds.length !== fresh.size || actualBatchIds.some((id) => !fresh.has(id))) {
    throw new Error("fresh batch set does not exactly match the baseline; historical batches are forbidden");
  }
  if (batches.some((row) => !TERMINAL_SCAN_STATUSES.has(text(row.status)))) {
    throw new Error("fresh baseline contains a non-terminal batch");
  }
  const scanRuns = db.prepare("SELECT batch_id, status FROM scan_runs ORDER BY id").all();
  if (scanRuns.some((row) => fresh.has(Number(row.batch_id)) && !TERMINAL_SCAN_STATUSES.has(text(row.status)))) {
    throw new Error("fresh baseline scan controller is not terminal");
  }
  if (actualBatchIds.some((batchId) => !scanRuns.some((row) => Number(row.batch_id) === batchId && TERMINAL_SCAN_STATUSES.has(text(row.status))))) {
    throw new Error("every fresh batch requires a terminal scan controller record");
  }
  const observations = db.prepare(`SELECT o.*, j.source, j.source_id, j.id AS job_id
    FROM job_observations o JOIN jobs j ON j.id = o.job_id ORDER BY o.job_id, o.id`).all();
  if (observations.some((row) => !fresh.has(Number(row.batch_id)))) {
    throw new Error("historical observations are forbidden in the fresh denominator");
  }
  const observationsByJob = new Map();
  for (const row of observations) {
    const list = observationsByJob.get(Number(row.job_id)) || [];
    list.push(row);
    observationsByJob.set(Number(row.job_id), list);
  }
  const jobs = db.prepare("SELECT id, batch_id FROM jobs ORDER BY id").all();
  if (jobs.some((job) => !observationsByJob.has(Number(job.id)))) {
    throw new Error("fresh baseline contains a job without a fresh observation");
  }
  if (jobs.some((job) => job.batch_id != null && !fresh.has(Number(job.batch_id)))) {
    throw new Error("fresh baseline contains a job linked to a historical batch");
  }
  return [...observationsByJob.entries()].map(([jobId, rows]) => {
    const row = rows.at(-1);
    const attempts = db.prepare("SELECT status, error_code FROM job_analysis_attempts WHERE job_id = ? ORDER BY total_attempt_number, id").all(jobId);
    return { row, attempts };
  });
}

function validateLineage({ dbPath, reportPath, receiptPath, baselineRoot }) {
  const report = parseJson(fs.readFileSync(reportPath, "utf8"), null);
  const receipt = parseJson(fs.readFileSync(receiptPath, "utf8"), null);
  if (!report || !receipt) throw new Error("Task 13 report and receipt must be JSON objects");
  if (receipt.complete !== true) throw new Error("Task 13 receipt is not complete");
  if (!samePath(report.baselinePath, dbPath) || !samePath(receipt.baselinePath, dbPath)) {
    throw new Error("Task 13 report/receipt baseline path does not match --db");
  }
  if (!samePath(report.archivePath, receipt.archivePath)) throw new Error("Task 13 report/receipt archive lineage does not match");
  if (Number(report.schemaVersion) !== SCHEMA_VERSION || (receipt.schemaVersion !== undefined && Number(receipt.schemaVersion) !== SCHEMA_VERSION)) {
    throw new Error(`Task 13 lineage must use schema v${SCHEMA_VERSION}`);
  }
  const after = report.operational?.after;
  if (!after || typeof after !== "object" || Array.isArray(after) || Object.values(after).some((value) => Number(value) !== 0)) {
    throw new Error("Task 13 baseline report operational.after must contain only zeroes");
  }
  if (receipt.scanTerminal !== true) throw new Error("Task 13 receipt does not confirm a terminal fresh scan");
  const archiveManifestPath = `${canonicalExisting(report.archivePath, "Task 13 archive")}.manifest.json`;
  const archive = parseJson(fs.readFileSync(archiveManifestPath, "utf8"), null);
  const sourceCommit = text(archive?.sourceCommit);
  if (!archive || Number(archive.schemaVersion) !== SCHEMA_VERSION || !/^[0-9a-f]{40}$/i.test(sourceCommit)) {
    throw new Error("Task 13 archive manifest lacks schema v11 source-commit lineage");
  }
  if (!samePath(report.sourcePath, archive.sourcePath)) throw new Error("Task 13 source path lineage does not match archive manifest");
  for (const value of [receipt.sourceCommit, report.sourceCommit].filter((item) => item !== undefined)) {
    if (text(value).toLowerCase() !== sourceCommit.toLowerCase()) throw new Error("Task 13 source commit lineage does not match archive manifest");
  }
  const freshBatchIds = [...new Set(asArray(receipt.freshBatchIds).map(Number))].sort((left, right) => left - right);
  if (!freshBatchIds.length || freshBatchIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("Task 13 receipt requires explicit fresh batch IDs");
  }
  if (!isWithin(dbPath, baselineRoot)) throw new Error("baseline database must be under the approved Gate D baseline root");
  return { report, receipt, sourceCommit, freshBatchIds };
}

function createDirectories(directories) {
  const created = [];
  for (const directory of directories) {
    const missing = [];
    let cursor = directory;
    while (!fs.existsSync(cursor)) {
      missing.unshift(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`cannot create output directory: ${directory}`);
      cursor = parent;
    }
    for (const item of missing) {
      fs.mkdirSync(item);
      created.push(item);
    }
  }
  return created;
}

function removeFiles(files) {
  for (const file of files) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function removeEmptyDirectories(directories) {
  for (const directory of [...directories].reverse()) {
    try { fs.rmdirSync(directory); } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; }
  }
}

function partialPath(file) {
  return path.join(path.dirname(file), `.partial-${randomUUID()}-${path.basename(file)}`);
}

function publish(partial, finalPath, published) {
  fs.linkSync(partial, finalPath);
  published.push(finalPath);
  fs.unlinkSync(partial);
}

function toolCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

function exportEvaluation(options, hooks = {}) {
  const testOnly = hooks.testOnly && typeof hooks.testOnly === "object" ? hooks.testOnly : null;
  const baselineRoot = canonicalExisting(testOnly?.baselineRoot || GATE_D_BASELINE_ROOT, "approved Gate D baseline root");
  const requestedDb = path.resolve(options.db || "");
  if (samePath(requestedDb, PRODUCTION_DB)) throw new Error("project production database is forbidden");
  if (isWithin(requestedDb, ARCHIVE_ROOT)) throw new Error("archive database is forbidden");
  const dbPath = canonicalExisting(options.db, "baseline database");
  if (!isWithin(dbPath, baselineRoot)) throw new Error("baseline database must be under the approved Gate D baseline root");
  const reportPath = canonicalExisting(options.report || `${dbPath}.report.json`, "Task 13 baseline report");
  const receiptPath = canonicalExisting(options.receipt || `${dbPath}.receipt.json`, "Task 13 baseline receipt");
  const outputRoot = canonicalTarget(options.outputRoot, "output root");
  if (!testOnly && !samePath(outputRoot, baselineRoot)) throw new Error("output root must be the approved Gate D baseline root");
  const lineage = validateLineage({ dbPath, reportPath, receiptPath, baselineRoot });
  const beforeBundle = fingerprintBundle(dbPath);
  const db = new DatabaseSync(immutableReadOnlyUri(dbPath), { readOnly: true });
  let rows;
  try {
    const schemaVersion = Number(db.prepare("PRAGMA user_version").get().user_version || 0);
    if (schemaVersion !== SCHEMA_VERSION) throw new Error(`baseline database schema must be v${SCHEMA_VERSION}`);
    rows = readRows(db, lineage.freshBatchIds);
  } finally {
    db.close();
  }
  if (typeof hooks.beforeAfterFingerprint === "function") hooks.beforeAfterFingerprint();
  const afterBundle = fingerprintBundle(dbPath);
  if (JSON.stringify(beforeBundle) !== JSON.stringify(afterBundle)) throw new Error("baseline database bundle changed during read-only export");

  const cases = rows.map(({ row, attempts }) => {
    const analysis = parseJson(row.analysis_json, {});
    const qualityTags = asArray(parseJson(row.quality_tags_json, [])).map(text);
    const redact = redactor([row.company, analysis.recruiter, analysis.recruiterName, analysis.contactName]);
    const input = {
      roleAlignment: text(analysis.roleAlignment) || "insufficient_evidence",
      responsibilityMatches: asArray(analysis.responsibilityMatches).map((item) => matchInput(item, redact)),
      requirementMatches: asArray(analysis.requirementMatches).map((item) => matchInput(item, redact)),
      boundaries: boundaryInput(analysis, redact),
      risks: riskInput(analysis, redact)
    };
    const bucket = technicalBucket(analysis, qualityTags);
    const matrix = bucket ? null : safeTier(deriveMatrixDecision(input, DECISION_POLICY).matrixRecommendation);
    const guarded = bucket ? null : safeTier(buildShadowScorecard(input, DECISION_POLICY).candidateTier);
    const fixedSalaryBoundary = analysis.fixedSalaryBoundary === true || qualityTags.includes("salary_out_of_range");
    const crossStackPromotion = analysis.crossStackPromotion === true || qualityTags.includes("cross_stack_promotion");
    return {
      id: stableEvaluationId(row.content_hash, row.job_id),
      evaluationId: stableEvaluationId(row.content_hash, row.job_id),
      sourceContentHash: text(row.content_hash),
      scanEvidence: {
        completeJd: text(analysis.semanticStatus) === "complete" && !qualityTags.includes("detail_unverified"),
        detailRead: !qualityTags.includes("detail_unverified"),
        detailReadEvidence: qualityTags.includes("detail_unverified") ? "detail_unverified_tag" : "stored_detail_evidence"
      },
      modelContract: modelContract(analysis, attempts),
      jd: {
        title: redact(row.title),
        location: redact(row.location),
        salary: redact(row.salary),
        experience: redact(row.experience),
        education: redact(row.education),
        text: redact(row.description)
      },
      input,
      hardBoundary: input.boundaries.some((item) => item.verified && item.blocked),
      risk: input.risks,
      evidence: {
        requirements: input.requirementMatches.map((item) => ({ jd: Boolean(item.jdEvidence), resume: Boolean(item.resumeEvidence) })),
        responsibilities: input.responsibilityMatches.map((item) => ({ jd: Boolean(item.jdEvidence), resume: Boolean(item.resumeEvidence) }))
      },
      decisionBucket: bucket || text(analysis.recommendation) || null,
      technicalBucket: bucket,
      productionMatrixTier: matrix,
      guardedTier: guarded,
      policyHash: text(analysis.decisionPolicyHash) || decisionPolicyHash(DECISION_POLICY),
      fixedSalaryBoundary,
      crossStackPromotion,
      finalRecommendation: safeTier(analysis.recommendation),
      humanLabel: {
        status: "pending-human",
        directionFit: null,
        hardBoundaryPass: null,
        expectedTier: null,
        evidenceSufficiency: null,
        rationale: "",
        labeler: "",
        labeledAt: null
      }
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const labels = {
    schemaVersion: "gate-d-evaluation-labels-v1",
    confirmedMetrics: "deferred: merge confirmed worksheet labels into a comparison fixture before computing confirmed metrics",
    rows: cases.map((item) => ({
      evaluationId: item.evaluationId,
      status: "pending-human",
      directionFit: null,
      hardBoundaryPass: null,
      expectedTier: null,
      evidenceSufficiency: null,
      rationale: "",
      labeler: "",
      labeledAt: null,
      aiProvisional: {
        productionMatrixTier: item.productionMatrixTier,
        guardedTier: item.guardedTier
      }
    }))
  };
  const fixture = {
    schemaVersion: "gate-d-evaluation-fixture-v1",
    policy: DECISION_POLICY,
    cases
  };
  const fixtureBytes = `${JSON.stringify(fixture, null, 2)}\n`;
  const labelsBytes = `${JSON.stringify(labels, null, 2)}\n`;
  const fixtureSha256 = sha256(fixtureBytes);
  const labelsSha256 = sha256(labelsBytes);
  const tierCounts = Object.fromEntries(RECOMMENDATION_TIERS.map((tier) => [tier, cases.filter((item) => item.productionMatrixTier === tier).length]));
  const technicalBucketCounts = Object.fromEntries([...new Set(cases.map((item) => item.technicalBucket).filter(Boolean))]
    .sort().map((bucket) => [bucket, cases.filter((item) => item.technicalBucket === bucket).length]));
  const mandatoryReviewIds = cases.filter((item) => item.fixedSalaryBoundary || item.crossStackPromotion).map((item) => item.evaluationId).sort();
  const manifest = {
    artifact: "gate-d-evaluation-export",
    createdAtUtc: new Date().toISOString(),
    sourceCommit: lineage.sourceCommit,
    evaluatedCommit: toolCommit(),
    schemaVersion: SCHEMA_VERSION,
    databaseSha256: beforeBundle.files.find((item) => item.name === "database").sha256,
    databaseBundle: beforeBundle,
    freshBatchIds: lineage.freshBatchIds,
    fixtureSha256,
    labelsSha256,
    counts: { jobs: cases.length, batches: lineage.freshBatchIds.length, observations: rows.length },
    tierCounts,
    technicalBucketCounts,
    mandatoryReviewIds,
    confirmedMetrics: "deferred until confirmed worksheet labels are merged; labels are the sole editable human source"
  };
  const fixturePath = path.join(outputRoot, "fixtures", FIXTURE_NAME);
  const labelsPath = path.join(outputRoot, "labels", LABELS_NAME);
  const manifestPath = path.join(outputRoot, "reports", MANIFEST_NAME);
  const receiptPathOut = path.join(outputRoot, "reports", RECEIPT_NAME);
  const finals = [fixturePath, labelsPath, manifestPath, receiptPathOut];
  if (finals.some((file) => fs.existsSync(file))) throw new Error("refusing to overwrite an existing evaluation artifact");
  const createdDirectories = createDirectories([...new Set(finals.map((file) => path.dirname(file)))]);
  const partials = finals.map(partialPath);
  const published = [];
  try {
    fs.writeFileSync(partials[0], fixtureBytes, { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(partials[1], labelsBytes, { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(partials[2], `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(partials[3], `${JSON.stringify({ artifact: "gate-d-evaluation-receipt", complete: true, createdAtUtc: new Date().toISOString(), fixtureSha256, labelsSha256 }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    if (typeof hooks.beforePublish === "function") hooks.beforePublish();
    publish(partials[0], fixturePath, published);
    publish(partials[1], labelsPath, published);
    publish(partials[2], manifestPath, published);
    publish(partials[3], receiptPathOut, published);
    return { fixture: fixturePath, labels: labelsPath, manifest: manifestPath, receipt: receiptPathOut };
  } catch (error) {
    removeFiles([...partials, ...published]);
    removeEmptyDirectories(createdDirectories);
    throw error;
  }
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(exportEvaluation(parseArgs(process.argv.slice(2)))));
  } catch (error) {
    console.error(`export-gate-d-evaluation: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { exportEvaluation, parseArgs };
