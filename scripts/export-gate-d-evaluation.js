const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { hasCompleteJobDescription } = require("../src/core/job_description_readiness");
const { DECISION_POLICY, RECOMMENDATION_TIERS, decisionPolicyHash } = require("../src/core/decision_policy");
const { deriveMatrixDecision } = require("../src/core/four_tier_decision");
const { SCHEMA_VERSION } = require("../src/core/storage");
const { buildShadowScorecard, SHADOW_SCORECARD_VERSION } = require("./lib/shadow_scorecard");

const ROOT = path.resolve(__dirname, "..");
const BASELINE_ROOT = "D:\\DevData\\RoleFlow-gate-d\\baseline";
const ARCHIVE_ROOT = "D:\\DevData\\RoleFlow-gate-d\\archive";
const PRODUCTION_DB = path.join(ROOT, "data", "jobs.sqlite");
const OPERATIONAL_TABLES = [
  "onboarding_runs", "resume_parse_attempts", "keyword_sources", "platform_filter_catalogs", "model_cache", "site_runtime_states", "site_scan_leases",
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
    const cleanupErrors = cleanupSnapshot({ snapshot, directory }, hooks);
    if (cleanupErrors.length) error.cleanupError = new AggregateError(cleanupErrors, "snapshot cleanup failed");
    throw error;
  }
}

function cleanupSnapshot({ snapshot, directory }, hooks) {
  return [
    ...removeAll([snapshot], hooks.snapshotUnlink || fs.unlinkSync),
    ...removeSnapshotDirs([directory], hooks.snapshotRmdir || fs.rmdirSync)
  ];
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
  const batches = db.prepare("SELECT id, keyword, status FROM batches ORDER BY id").all();
  const runs = db.prepare("SELECT id, command, batch_id, status FROM scan_runs ORDER BY id").all();
  const targets = db.prepare("SELECT batch_id, status FROM scan_target_results ORDER BY id").all();
  if (!batches.length) throw new Error("fresh baseline has no batches");
  if (batches.some((row) => row.status !== "completed")) throw new Error("formal evaluation requires every batch to be completed");
  if (runs.some((row) => !["daily", "broad"].includes(text(row.command).toLowerCase()))) {
    throw new Error("formal full-scan cohort requires scan_runs.command daily|broad; maintenance commands are unsupported");
  }
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
  return result
    .replace(/(?:^|\r?\n)\s*(?:联系人|招聘负责人|招聘经理|HR(?:姓名)?|人事(?:联系人)?|Hiring Manager)\s*[:：].*(?=\r?\n|$)/gim, "\n[REDACTED-CONTACT-LINE]")
    .replace(/(?:^|\r?\n)\s*(?:办公地址|公司地址|工作地址|详细地址)\s*[:：].*(?=\r?\n|$)/gim, "\n[REDACTED-ADDRESS-LINE]")
    .replace(/https?:\/\/\S+/gi, "[REDACTED-URL]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[REDACTED-EMAIL]")
    .replace(/(?<!\d)1\d{10}(?!\d)/g, "[REDACTED-PHONE]")
    .replace(/(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?:-\d{1,6})?(?!\d)/g, "[REDACTED-LANDLINE]")
    .replace(/(?:微信|wechat|weixin|QQ|钉钉|DingTalk|Telegram)\s*[:：]?\s*@?[\w-]+/gi, "[REDACTED-CONTACT]")
    .replace(/[\u4e00-\u9fff]{2,}(?:路|街|大道|巷|弄)\d*(?:号)?(?:[\u4e00-\u9fffA-Za-z0-9-]*(?:大厦|中心|园区|栋|座|楼|室))?/g, "[REDACTED-ADDRESS]");
}

function coarseLocation(value, secrets) {
  const raw = text(value);
  const district = raw.match(/^(?:.+?市)?[^市]+?(?:区|县)/);
  if (district) return redact(district[0], secrets);
  const city = raw.match(/^.+?市/);
  return city ? redact(city[0], secrets) : redact(raw, secrets);
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

function technicalBucket(analysis, completeJd, attempt) {
  if (!completeJd) return "incomplete_jd";
  if (attempt.latestStatus === "running") return "analysis_running";
  if (attempt.latestStatus === "failed" && attempt.latestErrorCode === "MODEL_CONTRACT_INVALID") return "contract_failure";
  if (attempt.latestStatus === "failed") return "analysis_failed";
  if (!attempt.latestStatus && text(analysis.errorCode) === "MODEL_CONTRACT_INVALID") return "contract_failure";
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
function evaluationId(key, hash, jobId) { if (key.length < 24) throw new Error("an external evaluation identity key is required"); return crypto.createHmac("sha256", key).update(`gate-d-evaluation-v2\0${hash}\0${jobId}`).digest("hex"); }
function counts(items, field) { return Object.fromEntries([...new Set(items.map((item) => item[field]).filter(Boolean))].sort().map((value) => [value, items.filter((item) => item[field] === value).length])); }
function toolCommit() { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); }

function createdDirectories(directories, made, mkdir) {
  for (const directory of directories) {
    const missing = []; let parent = directory;
    while (!fs.existsSync(parent)) { missing.unshift(parent); const next = path.dirname(parent); if (next === parent) throw new Error("cannot create evaluation output directory"); parent = next; }
    for (const item of missing) { mkdir(item); made.push(item); }
  }
}
function removeAll(files, unlink = fs.unlinkSync) {
  const errors = [];
  for (const file of files) {
    try {
      unlink(file);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      errors.push(error);
      if (unlink !== fs.unlinkSync) {
        try { fs.unlinkSync(file); } catch (fallbackError) { if (fallbackError.code !== "ENOENT") errors.push(fallbackError); }
      }
    }
  }
  return errors;
}
function removeDirs(directories, rmdir = fs.rmdirSync) {
  const errors = [];
  for (const directory of [...directories].reverse()) {
    try {
      rmdir(directory);
    } catch (error) {
      if (["ENOENT", "ENOTEMPTY"].includes(error.code)) continue;
      errors.push(error);
      if (rmdir !== fs.rmdirSync) {
        try { fs.rmdirSync(directory); } catch (fallbackError) { if (!["ENOENT", "ENOTEMPTY"].includes(fallbackError.code)) errors.push(fallbackError); }
      }
    }
  }
  return errors;
}
function removeSnapshotDirs(directories, rmdir = fs.rmdirSync) {
  const errors = [];
  for (const directory of [...directories].reverse()) {
    try {
      rmdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      errors.push(error);
      if (rmdir !== fs.rmdirSync) {
        try { fs.rmdirSync(directory); } catch (fallbackError) { if (fallbackError.code !== "ENOENT") errors.push(fallbackError); }
      }
    }
  }
  return errors;
}
function partial(file) { return path.join(path.dirname(file), `.partial-${randomUUID()}-${path.basename(file)}`); }
function publish(partialFile, finalFile, published, hooks) { (hooks.link || fs.linkSync)(partialFile, finalFile); published.push(finalFile); (hooks.unlinkPartial || fs.unlinkSync)(partialFile); }

const CONTRACT_FAILURE_STAGES = new Map([
  ["understandjob", "understand_job"],
  ["matchjob", "match_job"],
  ["matchresponsibilities", "match_responsibilities"],
  ["matchrequirements", "match_requirements"],
  ["analyze", "analysis"],
  ["analysis", "analysis"],
  ["input", "input"],
  ["execution", "execution"]
]);
const CONTRACT_TELEMETRY_COVERAGE = Object.freeze({
  finalFailures: "analysis_json",
  workflowAttempts: "job_analysis_attempts",
  sameCallInternalRepairs: `not_persisted_by_schema_v${SCHEMA_VERSION}`,
  fieldLevel: `not_persisted_by_schema_v${SCHEMA_VERSION}`
});

function contractFailureStage(value) {
  return CONTRACT_FAILURE_STAGES.get(text(value).toLowerCase().replace(/[^a-z]/g, "")) || null;
}

function attemptSummaries(db) {
  const rows = db.prepare(`SELECT id, job_id, status, error_code, error_stage, finished_at, updated_at, created_at
    FROM job_analysis_attempts
    ORDER BY job_id ASC,
      (COALESCE(finished_at, updated_at, created_at) IS NULL) ASC,
      COALESCE(finished_at, updated_at, created_at) DESC,
      updated_at DESC,
      id DESC`).all();
  const grouped = new Map();
  for (const row of rows) {
    const jobId = Number(row.job_id);
    const items = grouped.get(jobId) || [];
    items.push(row);
    grouped.set(jobId, items);
  }
  return new Map([...grouped].map(([jobId, items]) => {
    const latest = items[0];
    const priorFailure = items.slice(1).some((item) => item.status === "failed");
    const recoveryOutcome = latest.status === "succeeded"
      ? (priorFailure ? "recovered" : "succeeded")
      : latest.status === "running" ? "in_progress" : "unrecovered_failure";
    const contractFailures = items.filter((item) => text(item.error_code) === "MODEL_CONTRACT_INVALID");
    const contractFailureStages = [...new Set(contractFailures.map((item) => contractFailureStage(item.error_stage)).filter(Boolean))].sort();
    const contractRecoveryOutcome = contractFailures.length === 0
      ? "not_applicable"
      : latest.status === "running"
        ? "in_progress"
        : latest.status === "succeeded" ? "recovered" : "unrecovered";
    return [jobId, {
      attemptCount: items.length,
      latestStatus: text(latest.status),
      latestErrorCode: latest.status === "failed" ? text(latest.error_code) : "",
      recoveryOutcome,
      hadContractFailure: contractFailures.length > 0,
      contractFailureCount: contractFailures.length,
      contractFailureStages,
      contractRecoveryOutcome
    }];
  }));
}

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
  let snapshotReadError = null;
  try {
    const db = new DatabaseSync(snapshot.snapshot, { readOnly: true });
    try {
      if (Number(db.prepare("PRAGMA user_version").get().user_version || 0) !== SCHEMA_VERSION) throw new Error(`baseline database schema must be v${SCHEMA_VERSION}`);
      cohort = assertCompletedCohort(db);
      rawObservations = db.prepare(`SELECT o.*, j.id AS job_id FROM job_observations o JOIN jobs j ON j.id=o.job_id ORDER BY o.job_id, o.seen_at, o.id`).all();
      attemptsByJob = attemptSummaries(db);
      const jobs = db.prepare("SELECT id FROM jobs").all();
      const observed = new Set(rawObservations.map((row) => Number(row.job_id)));
      if (jobs.some((job) => !observed.has(Number(job.id)))) throw new Error("fresh baseline contains an orphan job without an observation");
    } finally { db.close(); }
  } catch (error) {
    snapshotReadError = error;
  }
  const snapshotCleanupErrors = cleanupSnapshot(snapshot, hooks);
  if (snapshotReadError) {
    if (snapshotCleanupErrors.length) snapshotReadError.cleanupError = new AggregateError(snapshotCleanupErrors, "snapshot cleanup failed");
    throw snapshotReadError;
  }
  if (snapshotCleanupErrors.length) throw new AggregateError(snapshotCleanupErrors, "snapshot cleanup failed");
  if (typeof hooks.beforeAfterFingerprint === "function") hooks.beforeAfterFingerprint();
  const after = fingerprint(dbPath);
  if (!samePersistentBundle(before, after)) throw new Error("source database/WAL changed during read-only snapshot export");
  const selected = new Map();
  for (const row of rawObservations) selected.set(Number(row.job_id), row);
  const cases = [...selected.values()].map((row) => {
    const analysis = parseJson(row.analysis_json, {});
    const attempt = attemptsByJob.get(Number(row.job_id)) || {
      attemptCount: 0,
      latestStatus: "",
      latestErrorCode: "",
      recoveryOutcome: "not_recorded",
      hadContractFailure: false,
      contractFailureCount: 0,
      contractFailureStages: [],
      contractRecoveryOutcome: "not_applicable"
    };
    const analysisContractFailure = attempt.attemptCount === 0 && text(analysis.errorCode) === "MODEL_CONTRACT_INVALID";
    const analysisContractStage = analysisContractFailure ? contractFailureStage(analysis.errorStage) : null;
    const secrets = [text(row.company), text(analysis.recruiter), text(analysis.recruiterName), text(analysis.contactName)];
    const input = frozenInput(analysis, secrets);
    const completeJd = hasCompleteJobDescription({ description: row.description, quality_tags_json: row.quality_tags_json });
    const technical = technicalBucket(analysis, completeJd, attempt);
    const matrixTier = technical ? null : safeTier(deriveMatrixDecision(input, DECISION_POLICY).matrixRecommendation);
    const guardedTier = technical ? null : safeTier(buildShadowScorecard(input, DECISION_POLICY).candidateTier);
    const sourceContentHash = text(row.content_hash);
    return {
      id: evaluationId(key, sourceContentHash, row.job_id), evaluationId: evaluationId(key, sourceContentHash, row.job_id),
      selectedObservationId: Number(row.id), observationSelectionRule: "latest-fresh-observation-by-seen_at,id",
      scanEvidence: { completeJd, detailRead: !list(parseJson(row.quality_tags_json, [])).includes("detail_unverified") },
      modelContract: {
        semanticStatus: text(analysis.semanticStatus) || "unknown",
        hadContractFailure: attempt.hadContractFailure || analysisContractFailure,
        contractFailureCount: attempt.contractFailureCount + Number(analysisContractFailure),
        contractFailureStages: analysisContractStage ? [analysisContractStage] : attempt.contractFailureStages,
        contractRecoveryOutcome: analysisContractFailure ? "unrecovered" : attempt.contractRecoveryOutcome,
        invalidFieldCategory: `not_persisted_by_schema_v${SCHEMA_VERSION}`,
        repairResult: text(analysis.repairResult || analysis.contractRepairResult) || null,
        finalFailure: attempt.latestStatus ? (attempt.latestErrorCode || null) : (text(analysis.errorCode) || null),
        attemptCount: attempt.attemptCount,
        finalAttemptStatus: attempt.latestStatus || null,
        recoveryOutcome: attempt.recoveryOutcome,
        attemptSelectionRule: "latest-by-coalesced-finished-updated-created-desc-id"
      },
      jd: { title: redact(row.title, secrets), location: coarseLocation(row.location, secrets), salary: redact(row.salary, secrets), experience: redact(row.experience, secrets), education: redact(row.education, secrets), text: redact(row.description, secrets) },
      input, technicalBucket: technical, productionMatrixTier: matrixTier, guardedTier,
      analysisPolicyHash: text(analysis.decisionPolicyHash) || null, evaluationMatrixPolicyHash: decisionPolicyHash(DECISION_POLICY), shadowPolicyHash: decisionPolicyHash(DECISION_POLICY), shadowVersion: SHADOW_SCORECARD_VERSION,
      fixedSalaryBoundary: analysis.fixedSalaryBoundary === true || list(parseJson(row.quality_tags_json, [])).includes("salary_out_of_range"), crossStackPromotion: analysis.crossStackPromotion === true || list(parseJson(row.quality_tags_json, [])).includes("cross_stack_promotion"),
      finalRecommendation: safeTier(analysis.recommendation), humanLabel: { status: "pending-human", directionFit: null, hardBoundaryPass: null, expectedTier: null, evidenceSufficiency: null, rationale: "", labeler: "", labeledAt: null }
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const fixture = { schemaVersion: "gate-d-evaluation-fixture-v2", artifactIdentity: "external-hmac-v1", policy: DECISION_POLICY, cases };
  const labels = { schemaVersion: "gate-d-evaluation-labels-v2", confirmedMetrics: "deferred: merge confirmed worksheet labels before confirmed metrics", rows: cases.map((item) => ({ evaluationId: item.evaluationId, status: "pending-human", directionFit: null, hardBoundaryPass: null, expectedTier: null, evidenceSufficiency: null, rationale: "", labeler: "", labeledAt: null, aiProvisional: { productionMatrixTier: item.productionMatrixTier, guardedTier: item.guardedTier } })) };
  const fixtureBytes = `${JSON.stringify(fixture, null, 2)}\n`; const labelsBytes = `${JSON.stringify(labels, null, 2)}\n`;
  const fixtureSha256 = sha(fixtureBytes);
  const labelsSha256 = sha(labelsBytes);
  const qualityEligibleCaseCount = cases.filter((item) => !item.technicalBucket).length;
  const runStatusDistribution = {
    batches: cohort.batchStatusDistribution,
    scanRuns: cohort.scanRunStatusDistribution,
    targets: cohort.targetStatusDistribution
  };
  const manifest = {
    artifact: "gate-d-evaluation-export",
    createdAtUtc: new Date().toISOString(),
    sourceCommit: lineage.sourceCommit,
    evaluatedCommit: toolCommit(),
    schemaVersion: SCHEMA_VERSION,
    databaseSha256: before.files.find((item) => item.name === "database").sha256,
    sourceBundle: { before, after },
    cohortContract: "formal-full-scan-only-v1",
    maintenanceBatchesSupported: false,
    freshBatchIds: cohort.batchIds,
    counts: {
      rawObservations: rawObservations.length,
      uniqueJobs: cases.length,
      collapsedObservations: rawObservations.length - cases.length,
      technicalCases: cases.length - qualityEligibleCaseCount
    },
    cohortComplete: true,
    qualityEligible: qualityEligibleCaseCount > 0,
    qualityEligibleCaseCount,
    runStatusDistribution,
    fixtureSha256,
    labelsSha256,
    privacy: {
      artifactClass: "private-local",
      redactionPolicyVersion: "gate-d-private-redaction-v2",
      limitation: "pattern-based redaction reduces known identifiers but cannot guarantee perfect entity recognition"
    },
    analysisPolicyHashes: counts(cases, "analysisPolicyHash"),
    evaluationMatrixPolicyHash: decisionPolicyHash(DECISION_POLICY),
    shadow: { version: SHADOW_SCORECARD_VERSION, policyHash: decisionPolicyHash(DECISION_POLICY) },
    matrixTierCounts: counts(cases, "productionMatrixTier"),
    guardedTierCounts: counts(cases, "guardedTier"),
    technicalBucketCounts: counts(cases, "technicalBucket"),
    mandatoryReviewIds: cases.filter((item) => item.fixedSalaryBoundary || item.crossStackPromotion).map((item) => item.evaluationId).sort(),
    contractTelemetryCoverage: CONTRACT_TELEMETRY_COVERAGE,
    confirmedMetrics: "deferred until confirmed worksheet labels are merged; labels are the sole editable human source"
  };
  const receipt = {
    artifact: "gate-d-evaluation-receipt",
    complete: true,
    createdAtUtc: new Date().toISOString(),
    fixtureSha256,
    labelsSha256,
    cohortComplete: true,
    qualityEligible: qualityEligibleCaseCount > 0,
    qualityEligibleCaseCount,
    contractTelemetryCoverage: CONTRACT_TELEMETRY_COVERAGE,
    runStatusDistribution
  };
  const finals = [path.join(outputRoot, "fixtures", "gate-d-evaluation-fixture.json"), path.join(outputRoot, "labels", "gate-d-evaluation-labels.json"), path.join(outputRoot, "reports", "gate-d-evaluation-manifest.json"), path.join(outputRoot, "reports", "gate-d-evaluation-receipt.json")];
  if (finals.some(fs.existsSync)) throw new Error("refusing to overwrite an existing evaluation artifact");
  const partials = finals.map(partial); const published = []; let made = [];
  try {
    createdDirectories([...new Set(finals.map(path.dirname))], made, hooks.mkdir || fs.mkdirSync);
    const write = hooks.writeFile || fs.writeFileSync;
    write(partials[0], fixtureBytes, { encoding: "utf8", flag: "wx" });
    write(partials[1], labelsBytes, { encoding: "utf8", flag: "wx" });
    write(partials[2], `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    if (typeof hooks.beforePublish === "function") hooks.beforePublish();
    for (let i = 0; i < 3; i += 1) publish(partials[i], finals[i], published, hooks);
    write(partials[3], `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    (hooks.renameReceipt || fs.renameSync)(partials[3], finals[3]);
    return { fixture: finals[0], labels: finals[1], manifest: finals[2], receipt: finals[3] };
  } catch (error) {
    const cleanup = [
      ...removeAll([...partials, ...published, finals[3]], hooks.cleanupUnlink || fs.unlinkSync),
      ...removeDirs(made, hooks.cleanupRmdir || fs.rmdirSync)
    ];
    if (cleanup.length) error.cleanupError = new AggregateError(cleanup, "evaluation artifact cleanup failed");
    throw error;
  }
}

if (require.main === module) { try { console.log(JSON.stringify(exportEvaluation(parseArgs(process.argv.slice(2))))); } catch (error) { console.error(`export-gate-d-evaluation: ${error.message}`); process.exitCode = 1; } }
module.exports = { exportEvaluation, parseArgs };
