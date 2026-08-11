const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { hasCompleteJobDescription } = require("../src/core/job_description_readiness");
const { DECISION_POLICY, RECOMMENDATION_TIERS, decisionPolicyHash } = require("../src/core/decision_policy");
const { deriveMatrixDecision } = require("../src/core/four_tier_decision");
const { buildShadowScorecard, SHADOW_SCORECARD_VERSION } = require("./lib/shadow_scorecard");

const ROOT = path.resolve(__dirname, "..");
const BASELINE_ROOT = "D:\\DevData\\RoleFlow-gate-d\\baseline";
const ARCHIVE_ROOT = "D:\\DevData\\RoleFlow-gate-d\\archive";
const PRODUCTION_DB = path.join(ROOT, "data", "jobs.sqlite");
const SCHEMA_VERSION = 11;
const OPERATIONAL_TABLES = [
  "resume_parse_attempts", "keyword_sources", "platform_filter_catalogs", "model_cache", "site_runtime_states", "site_scan_leases",
  "job_analysis_attempts", "workflow_job_tasks", "workflow_runs", "candidate_progress_events", "candidate_progress_cards",
  "message_preview_states", "message_discovery_unresolved_items", "communication_batch_items", "communication_batches",
  "candidate_job_events", "candidate_job_states", "applications", "events", "job_refresh_attempts", "job_observations",
  "scan_target_results", "scan_runs", "batches", "jobs"
];

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!new Set(["--db", "--report", "--receipt", "--output-root"]).has(flag)) throw new Error("usage: node scripts/export-gate-d-evaluation.js --db <baseline.sqlite> [--report <baseline.report.json>] [--receipt <baseline.receipt.json>] --output-root <baseline-root>");
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (result[key]) throw new Error(`duplicate ${flag}`);
    result[key] = value;
    i += 1;
  }
  if (!result.db || !result.outputRoot) throw new Error("usage: node scripts/export-gate-d-evaluation.js --db <baseline.sqlite> [--report <baseline.report.json>] [--receipt <baseline.receipt.json>] --output-root <baseline-root>");
  return result;
}

function normalizedPath(file) { return (process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file)); }
function samePath(left, right) { return normalizedPath(left) === normalizedPath(right); }
function inside(child, parent) { const relative = path.relative(parent, child); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function existing(file, label) { const resolved = path.resolve(file); if (!fs.existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`); return fs.realpathSync.native(resolved); }
function target(file, label) {
  const resolved = path.resolve(file);
  if (fs.existsSync(resolved)) return fs.realpathSync.native(resolved);
  const tail = []; let parent = resolved;
  while (!fs.existsSync(parent)) { const next = path.dirname(parent); if (next === parent) throw new Error(`cannot resolve ${label}`); tail.unshift(path.basename(parent)); parent = next; }
  if (!fs.statSync(parent).isDirectory()) throw new Error(`${label} parent is not a directory`);
  return path.join(fs.realpathSync.native(parent), ...tail);
}
function text(value) { return String(value || "").trim(); }
function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fileSha(file) { return sha(fs.readFileSync(file)); }
function parseJson(value, fallback) { try { const parsed = JSON.parse(String(value || "")); return parsed && typeof parsed === "object" ? parsed : fallback; } catch { return fallback; } }
function list(value) { return Array.isArray(value) ? value : []; }

function fingerprint(dbPath) {
  const files = [];
  for (const [name, file] of [["database", dbPath], ["wal", `${dbPath}-wal`], ["shm", `${dbPath}-shm`]]) {
    if (!fs.existsSync(file)) continue;
    const before = fs.statSync(file); const bytes = fs.readFileSync(file); const after = fs.statSync(file);
    if (!before.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`source bundle member changed while reading: ${name}`);
    files.push({ name, size: bytes.length, sha256: sha(bytes) });
  }
  if (!files.some((item) => item.name === "database")) throw new Error("source database bundle is missing database");
  return { algorithm: "sha256", files };
}

function samePersistentBundle(before, after) {
  const databaseBefore = before.files.find((item) => item.name === "database");
  const databaseAfter = after.files.find((item) => item.name === "database");
  if (JSON.stringify(databaseBefore) !== JSON.stringify(databaseAfter)) return false;
  const walBefore = before.files.find((item) => item.name === "wal");
  const walAfter = after.files.find((item) => item.name === "wal");
  if (walBefore || walAfter?.size) return JSON.stringify(walBefore || null) === JSON.stringify(walAfter || null);
  return true; // SHM is SQLite reader coordination state and may be created/changed by a read-only reader.
}

function quote(file) { return file.replace(/'/g, "''"); }
function sourceSnapshot(source, tempRoot, hooks) {
  const directory = fs.mkdtempSync(path.join(tempRoot, "roleflow-gate-d-evaluation-snapshot-"));
  const snapshot = path.join(directory, "snapshot.sqlite");
  try {
    const reader = new DatabaseSync(source, { readOnly: true });
    try { reader.exec(`VACUUM INTO '${quote(snapshot)}'`); } finally { reader.close(); }
    if (typeof hooks.afterSourceSnapshot === "function") hooks.afterSourceSnapshot();
    return { directory, snapshot };
  } catch (error) {
    removeAll([snapshot]); removeDirs([directory]);
    throw error;
  }
}

function assertTask13({ dbPath, reportPath, receiptPath, root }) {
  const report = parseJson(fs.readFileSync(reportPath, "utf8"), null);
  const receipt = parseJson(fs.readFileSync(receiptPath, "utf8"), null);
  if (!report || !receipt || receipt.complete !== true) throw new Error("Task 13 report/complete receipt is required");
  if (!samePath(report.baselinePath, dbPath) || !samePath(receipt.baselinePath, dbPath)) throw new Error("Task 13 report/receipt baseline path does not match --db");
  if (!samePath(report.archivePath, receipt.archivePath)) throw new Error("Task 13 report/receipt archive path does not match");
  if (Number(report.schemaVersion) !== SCHEMA_VERSION) throw new Error(`Task 13 report must use schema v${SCHEMA_VERSION}`);
  const after = report.operational?.after;
  if (!after || typeof after !== "object" || Array.isArray(after)
    || Object.keys(after).length !== OPERATIONAL_TABLES.length
    || OPERATIONAL_TABLES.some((name) => !Object.hasOwn(after, name) || Number(after[name]) !== 0)) {
    throw new Error("Task 13 report operational.after must be the complete zeroed operational-table set");
  }
  const archive = existing(report.archivePath, "Task 13 archive");
  if (!/^[a-f0-9]{64}$/i.test(text(receipt.archiveSha256)) || fileSha(archive) !== receipt.archiveSha256.toLowerCase()) throw new Error("Task 13 receipt archive SHA-256 does not match");
  const archiveManifest = parseJson(fs.readFileSync(`${archive}.manifest.json`, "utf8"), null);
  const sourceCommit = text(archiveManifest?.sourceCommit).toLowerCase();
  if (!archiveManifest || Number(archiveManifest.schemaVersion) !== SCHEMA_VERSION || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Task 13 archive manifest source commit/schema lineage is invalid");
  if (!samePath(report.sourcePath, archiveManifest.sourcePath)) throw new Error("Task 13 report/archive source path lineage does not match");
  if (!inside(dbPath, root)) throw new Error("baseline database is outside the approved Gate D baseline root");
  return { sourceCommit };
}

function assertCompletedCohort(db) {
  const batches = db.prepare("SELECT id, status FROM batches ORDER BY id").all();
  const runs = db.prepare("SELECT id, batch_id, status FROM scan_runs ORDER BY id").all();
  const targets = db.prepare("SELECT batch_id, status FROM scan_target_results ORDER BY id").all();
  if (!batches.length) throw new Error("fresh baseline has no batches");
  if (batches.some((row) => row.status !== "completed")) throw new Error("formal evaluation requires every batch to be completed");
  if (!runs.length || runs.some((row) => row.status !== "completed" || !Number.isInteger(Number(row.batch_id)))) throw new Error("formal evaluation requires every scan_run to be completed");
  for (const batch of batches) {
    if (!runs.some((run) => Number(run.batch_id) === Number(batch.id))) throw new Error("every fresh batch requires a completed scan_run");
    const batchTargets = targets.filter((row) => Number(row.batch_id) === Number(batch.id));
    if (!batchTargets.length || batchTargets.some((row) => row.status !== "completed")) throw new Error("every fresh batch requires completed scan targets");
  }
  const distribution = (rows) => Object.fromEntries([...new Set(rows.map((row) => row.status))].sort().map((status) => [status, rows.filter((row) => row.status === status).length]));
  return { batchIds: batches.map((row) => Number(row.id)), batchStatusDistribution: distribution(batches), scanRunStatusDistribution: distribution(runs), targetStatusDistribution: distribution(targets) };
}

function redact(value, secrets) {
  let result = text(value);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) result = result.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[REDACTED]");
  return result.replace(/https?:\/\/\S+/gi, "[REDACTED-URL]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[REDACTED-EMAIL]")
    .replace(/(?<!\d)1\d{10}(?!\d)/g, "[REDACTED-PHONE]")
    .replace(/(?:微信|wechat|weixin)\s*[:：]?\s*[\w-]+/gi, "[REDACTED-CONTACT]");
}

function matchProjection(item, secrets) {
  const value = item && typeof item === "object" && !Array.isArray(item) ? item : {};
  const output = { id: redact(value.id, secrets), state: text(value.state) || "unknown", text: redact(value.text, secrets), jdEvidence: redact(value.jdEvidence, secrets), resumeEvidence: text(value.resumeEvidence) ? "[resume-evidence-present]" : "" };
  for (const key of ["requirement", "label", "name"]) if (text(value[key])) output[key] = redact(value[key], secrets);
  for (const key of ["foundation", "central", "indispensable", "soft"]) if (typeof value[key] === "boolean") output[key] = value[key];
  if (text(value.explanation) || text(value.rationale)) output.explanation = "[analysis-explanation-present]";
  return output;
}

function frozenInput(analysis, secrets) {
  return {
    roleAlignment: text(analysis.roleAlignment) || "insufficient_evidence",
    responsibilityMatches: list(analysis.responsibilityMatches).map((item) => matchProjection(item, secrets)),
    requirementMatches: list(analysis.requirementMatches).map((item) => matchProjection(item, secrets)),
    boundaries: [...list(analysis.boundaries), ...list(analysis.hardBlockers)].map((item) => ({ verified: item?.verified !== false, blocked: item?.blocked !== false, reason: "[boundary-evidence-present]" })),
    risks: [...list(analysis.risks), ...list(analysis.hiddenRisks)].map((item) => ({ verified: item?.verified === true, severity: text(item?.severity) || "unknown", reason: "[risk-evidence-present]" }))
  };
}

function technicalBucket(analysis, completeJd) {
  if (!completeJd) return "incomplete_jd";
  if (text(analysis.errorCode) === "MODEL_CONTRACT_INVALID") return "contract_failure";
  if (text(analysis.semanticStatus) !== "complete") return `semantic_${text(analysis.semanticStatus) || "unknown"}`;
  if (!list(analysis.requirementMatches).length || !list(analysis.responsibilityMatches).length || !text(analysis.roleAlignment)) return "decision_evidence_missing";
  return null;
}

function safeTier(value) { return RECOMMENDATION_TIERS.includes(value) ? value : null; }
function identityKey(hooks) {
  const test = hooks.testOnly;
  if (test) {
    if (process.env.NODE_ENV !== "test" || test.enabled !== true) throw new Error("testOnly seam is restricted to NODE_ENV=test wrappers");
    return text(test.identityKey);
  }
  return text(process.env.ROLEFLOW_GATE_D_EVALUATION_IDENTITY_KEY);
}
function evaluationId(key, hash) { if (key.length < 24) throw new Error("an external evaluation identity key is required"); return crypto.createHmac("sha256", key).update(`gate-d-evaluation-v2\0${hash}`).digest("hex"); }
function counts(items, field) { return Object.fromEntries([...new Set(items.map((item) => item[field]).filter(Boolean))].sort().map((value) => [value, items.filter((item) => item[field] === value).length])); }
function toolCommit() { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); }

function createdDirectories(directories, made, mkdir) {
  for (const directory of directories) {
    const missing = []; let parent = directory;
    while (!fs.existsSync(parent)) { missing.unshift(parent); const next = path.dirname(parent); if (next === parent) throw new Error("cannot create evaluation output directory"); parent = next; }
    for (const item of missing) { mkdir(item); made.push(item); }
  }
}
function removeAll(files) { const errors = []; for (const file of files) try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") errors.push(error); } return errors; }
function removeDirs(directories) { const errors = []; for (const directory of [...directories].reverse()) try { fs.rmdirSync(directory); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) errors.push(error); } return errors; }
function partial(file) { return path.join(path.dirname(file), `.partial-${randomUUID()}-${path.basename(file)}`); }
function publish(partialFile, finalFile, published, hooks) { (hooks.link || fs.linkSync)(partialFile, finalFile); published.push(finalFile); (hooks.unlinkPartial || fs.unlinkSync)(partialFile); }

function exportEvaluation(options, hooks = {}) {
  const test = hooks.testOnly;
  const root = existing(test?.baselineRoot || BASELINE_ROOT, "approved Gate D baseline root");
  const requested = path.resolve(options.db || "");
  if (samePath(requested, PRODUCTION_DB)) throw new Error("project production database is forbidden");
  if (inside(requested, ARCHIVE_ROOT)) throw new Error("archive database is forbidden");
  const dbPath = existing(options.db, "baseline database");
  if (!inside(dbPath, root)) throw new Error("baseline database is outside the approved Gate D baseline root");
  const reportPath = existing(options.report || `${dbPath}.report.json`, "Task 13 report");
  const receiptPath = existing(options.receipt || `${dbPath}.receipt.json`, "Task 13 receipt");
  const outputRoot = target(options.outputRoot, "output root");
  if (!test && !samePath(outputRoot, root)) throw new Error("output root must be the approved Gate D baseline root");
  const lineage = assertTask13({ dbPath, reportPath, receiptPath, root });
  const key = identityKey(hooks);
  const before = fingerprint(dbPath);
  const snapshot = sourceSnapshot(dbPath, "D:\\DevData", hooks);
  let rawObservations; let cohort; let attemptsByJob;
  try {
    const db = new DatabaseSync(snapshot.snapshot, { readOnly: true });
    try {
      if (Number(db.prepare("PRAGMA user_version").get().user_version || 0) !== SCHEMA_VERSION) throw new Error(`baseline database schema must be v${SCHEMA_VERSION}`);
      cohort = assertCompletedCohort(db);
      rawObservations = db.prepare(`SELECT o.*, j.id AS job_id FROM job_observations o JOIN jobs j ON j.id=o.job_id ORDER BY o.job_id, o.seen_at, o.id`).all();
      attemptsByJob = new Map(db.prepare(`SELECT job_id, count(*) AS attempt_count, max(error_code) AS final_error_code
        FROM job_analysis_attempts GROUP BY job_id`).all().map((row) => [Number(row.job_id), row]));
      const jobs = db.prepare("SELECT id FROM jobs").all();
      const observed = new Set(rawObservations.map((row) => Number(row.job_id)));
      if (jobs.some((job) => !observed.has(Number(job.id)))) throw new Error("fresh baseline contains an orphan job without an observation");
    } finally { db.close(); }
  } finally { removeAll([snapshot.snapshot]); removeDirs([snapshot.directory]); }
  if (typeof hooks.beforeAfterFingerprint === "function") hooks.beforeAfterFingerprint();
  const after = fingerprint(dbPath);
  if (!samePersistentBundle(before, after)) throw new Error("source database/WAL changed during read-only snapshot export");
  const selected = new Map();
  for (const row of rawObservations) selected.set(Number(row.job_id), row);
  const cases = [...selected.values()].map((row) => {
    const analysis = parseJson(row.analysis_json, {});
    const attempt = attemptsByJob.get(Number(row.job_id)) || {};
    const secrets = [text(row.company), text(analysis.recruiter), text(analysis.recruiterName), text(analysis.contactName)];
    const input = frozenInput(analysis, secrets);
    const completeJd = hasCompleteJobDescription({ description: row.description, quality_tags_json: row.quality_tags_json });
    const technical = technicalBucket(analysis, completeJd);
    const matrixTier = technical ? null : safeTier(deriveMatrixDecision(input, DECISION_POLICY).matrixRecommendation);
    const guardedTier = technical ? null : safeTier(buildShadowScorecard(input, DECISION_POLICY).candidateTier);
    const sourceContentHash = text(row.content_hash);
    return {
      id: evaluationId(key, sourceContentHash), evaluationId: evaluationId(key, sourceContentHash), sourceContentHash,
      selectedObservationId: Number(row.id), observationSelectionRule: "latest-fresh-observation-by-seen_at,id",
      scanEvidence: { completeJd, detailRead: !list(parseJson(row.quality_tags_json, [])).includes("detail_unverified") },
      modelContract: { semanticStatus: text(analysis.semanticStatus) || "unknown", invalidField: text(analysis.invalidField || analysis.contractInvalidField) || null, repairResult: text(analysis.repairResult || analysis.contractRepairResult) || null, finalFailure: text(analysis.errorCode || attempt.final_error_code) || null, attemptCount: Number(attempt.attempt_count || 0) },
      jd: { title: redact(row.title, secrets), location: redact(row.location, secrets), salary: redact(row.salary, secrets), experience: redact(row.experience, secrets), education: redact(row.education, secrets), text: redact(row.description, secrets) },
      input, technicalBucket: technical, productionMatrixTier: matrixTier, guardedTier,
      analysisPolicyHash: text(analysis.decisionPolicyHash) || null, evaluationMatrixPolicyHash: decisionPolicyHash(DECISION_POLICY), shadowPolicyHash: decisionPolicyHash(DECISION_POLICY), shadowVersion: SHADOW_SCORECARD_VERSION,
      fixedSalaryBoundary: analysis.fixedSalaryBoundary === true || list(parseJson(row.quality_tags_json, [])).includes("salary_out_of_range"), crossStackPromotion: analysis.crossStackPromotion === true || list(parseJson(row.quality_tags_json, [])).includes("cross_stack_promotion"),
      finalRecommendation: safeTier(analysis.recommendation), humanLabel: { status: "pending-human", directionFit: null, hardBoundaryPass: null, expectedTier: null, evidenceSufficiency: null, rationale: "", labeler: "", labeledAt: null }
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const fixture = { schemaVersion: "gate-d-evaluation-fixture-v2", artifactIdentity: "external-hmac-v1", policy: DECISION_POLICY, cases };
  const labels = { schemaVersion: "gate-d-evaluation-labels-v2", confirmedMetrics: "deferred: merge confirmed worksheet labels before confirmed metrics", rows: cases.map((item) => ({ evaluationId: item.evaluationId, status: "pending-human", directionFit: null, hardBoundaryPass: null, expectedTier: null, evidenceSufficiency: null, rationale: "", labeler: "", labeledAt: null, aiProvisional: { productionMatrixTier: item.productionMatrixTier, guardedTier: item.guardedTier } })) };
  const fixtureBytes = `${JSON.stringify(fixture, null, 2)}\n`; const labelsBytes = `${JSON.stringify(labels, null, 2)}\n`;
  const fixtureSha256 = sha(fixtureBytes); const labelsSha256 = sha(labelsBytes); const qualityEligible = cases.filter((item) => !item.technicalBucket).length;
  const manifest = { artifact: "gate-d-evaluation-export", createdAtUtc: new Date().toISOString(), sourceCommit: lineage.sourceCommit, evaluatedCommit: toolCommit(), schemaVersion: SCHEMA_VERSION, databaseSha256: before.files.find((item) => item.name === "database").sha256, sourceBundle: { before, after }, freshBatchIds: cohort.batchIds, counts: { rawObservations: rawObservations.length, uniqueJobs: cases.length, collapsedObservations: rawObservations.length - cases.length }, qualityEligible, runStatusDistribution: { batches: cohort.batchStatusDistribution, scanRuns: cohort.scanRunStatusDistribution, targets: cohort.targetStatusDistribution }, fixtureSha256, labelsSha256, analysisPolicyHashes: counts(cases, "analysisPolicyHash"), evaluationMatrixPolicyHash: decisionPolicyHash(DECISION_POLICY), shadow: { version: SHADOW_SCORECARD_VERSION, policyHash: decisionPolicyHash(DECISION_POLICY) }, matrixTierCounts: counts(cases, "productionMatrixTier"), guardedTierCounts: counts(cases, "guardedTier"), technicalBucketCounts: counts(cases, "technicalBucket"), mandatoryReviewIds: cases.filter((item) => item.fixedSalaryBoundary || item.crossStackPromotion).map((item) => item.evaluationId).sort(), confirmedMetrics: "deferred until confirmed worksheet labels are merged; labels are the sole editable human source" };
  const finals = [path.join(outputRoot, "fixtures", "gate-d-evaluation-fixture.json"), path.join(outputRoot, "labels", "gate-d-evaluation-labels.json"), path.join(outputRoot, "reports", "gate-d-evaluation-manifest.json"), path.join(outputRoot, "reports", "gate-d-evaluation-receipt.json")];
  if (finals.some(fs.existsSync)) throw new Error("refusing to overwrite an existing evaluation artifact");
  const partials = finals.map(partial); const published = []; let made = [];
  try {
    createdDirectories([...new Set(finals.map(path.dirname))], made, hooks.mkdir || fs.mkdirSync);
    const write = hooks.writeFile || fs.writeFileSync;
    write(partials[0], fixtureBytes, { encoding: "utf8", flag: "wx" }); write(partials[1], labelsBytes, { encoding: "utf8", flag: "wx" }); write(partials[2], `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); write(partials[3], `${JSON.stringify({ artifact: "gate-d-evaluation-receipt", complete: true, createdAtUtc: new Date().toISOString(), fixtureSha256, labelsSha256, qualityEligible, runStatusDistribution: manifest.runStatusDistribution }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    if (typeof hooks.beforePublish === "function") hooks.beforePublish();
    for (let i = 0; i < finals.length; i += 1) publish(partials[i], finals[i], published, hooks);
    return { fixture: finals[0], labels: finals[1], manifest: finals[2], receipt: finals[3] };
  } catch (error) {
    const cleanup = [...removeAll(partials), ...removeAll(published), ...removeDirs(made)];
    if (cleanup.length) error.cleanupError = new AggregateError(cleanup, "evaluation artifact cleanup failed");
    throw error;
  }
}

if (require.main === module) { try { console.log(JSON.stringify(exportEvaluation(parseArgs(process.argv.slice(2))))); } catch (error) { console.error(`export-gate-d-evaluation: ${error.message}`); process.exitCode = 1; } }
module.exports = { exportEvaluation, parseArgs };
