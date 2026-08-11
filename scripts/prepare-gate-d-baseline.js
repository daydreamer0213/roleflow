const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const PRODUCTION_DB = path.join(ROOT, "data", "jobs.sqlite");
const DEFAULT_ROOT = "D:\\DevData\\RoleFlow-gate-d";
const SUPPORTED_SCHEMA_VERSION = 11;

const PRESERVED_TABLES = [
  "schema_migrations",
  "candidate_profiles",
  "resume_documents",
  "candidate_resume_versions",
  "profile_versions",
  "search_plans",
  "candidate_facts",
  "candidate_matching_cards"
];

const OPERATIONAL_TABLES = [
  "resume_parse_attempts",
  "keyword_sources",
  "platform_filter_catalogs",
  "model_cache",
  "site_runtime_states",
  "site_scan_leases",
  "job_analysis_attempts",
  "workflow_job_tasks",
  "workflow_runs",
  "candidate_progress_events",
  "candidate_progress_cards",
  "message_preview_states",
  "message_discovery_unresolved_items",
  "communication_batch_items",
  "communication_batches",
  "candidate_job_events",
  "candidate_job_states",
  "applications",
  "events",
  "job_refresh_attempts",
  "job_observations",
  "scan_target_results",
  "scan_runs",
  "batches",
  "jobs"
];

const KNOWN_TABLES = new Set([...PRESERVED_TABLES, ...OPERATIONAL_TABLES]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (!new Set(["--source", "--archive", "--baseline"]).has(flag)) throw new Error(`unknown argument: ${flag}`);
    args[flag.slice(2)] = value;
    index += 1;
  }
  if (!args.source) throw new Error("usage: node scripts/prepare-gate-d-baseline.js --source <sqlite> [--archive <sqlite>] [--baseline <sqlite>]");
  return args;
}

function absolute(file) {
  return path.resolve(file);
}

function requireDDrive(file, label) {
  if (path.parse(file).root.toLowerCase() !== "d:\\") throw new Error(`${label} must be on D:: ${file}`);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function quotePath(file) {
  return file.replace(/'/g, "''");
}

function count(db, table) {
  return Number(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n);
}

function counts(db, tables) {
  return Object.fromEntries(tables.map((table) => [table, count(db, table)]));
}

function checkResult(row) {
  return row ? Object.values(row)[0] : "";
}

function inspectSource(source) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    const schemaVersion = Number(db.prepare("PRAGMA user_version").get().user_version || 0);
    if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      throw new Error(`unsupported schema version: expected v${SUPPORTED_SCHEMA_VERSION}, got v${schemaVersion}`);
    }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    const missing = [...KNOWN_TABLES].filter((table) => !tables.includes(table));
    if (missing.length) throw new Error(`unsupported v11 schema missing required tables: ${missing.join(", ")}`);
    const unknownWithData = tables.filter((table) => !KNOWN_TABLES.has(table) && count(db, table) > 0);
    if (unknownWithData.length) throw new Error(`unknown populated tables fail closed: ${unknownWithData.join(", ")}`);
    const foreignKeyRows = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyRows.length) throw new Error("source foreign_key_check failed");
    if (checkResult(db.prepare("PRAGMA quick_check").get()) !== "ok") throw new Error("source quick_check failed");
    return {
      schemaVersion,
      preserved: counts(db, PRESERVED_TABLES),
      operational: counts(db, OPERATIONAL_TABLES),
      unknownEmptyTables: tables.filter((table) => !KNOWN_TABLES.has(table))
    };
  } finally {
    db.close();
  }
}

function assertCountsEqual(label, expected, actual) {
  for (const table of Object.keys(expected)) {
    if (expected[table] !== actual[table]) throw new Error(`${label} changed unexpectedly for ${table}: ${expected[table]} -> ${actual[table]}`);
  }
}

function clearClone(baseline, expectedPreserved, expectedOperational) {
  const db = new DatabaseSync(baseline);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const before = { preserved: counts(db, PRESERVED_TABLES), operational: counts(db, OPERATIONAL_TABLES) };
    assertCountsEqual("archive preserved table", expectedPreserved, before.preserved);
    assertCountsEqual("archive operational table", expectedOperational, before.operational);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of OPERATIONAL_TABLES) db.exec(`DELETE FROM "${table}"`);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    const after = { preserved: counts(db, PRESERVED_TABLES), operational: counts(db, OPERATIONAL_TABLES) };
    assertCountsEqual("baseline preserved table", before.preserved, after.preserved);
    const remaining = Object.entries(after.operational).filter(([, value]) => value !== 0).map(([table]) => table);
    if (remaining.length) throw new Error(`operational tables still contain data: ${remaining.join(", ")}`);
    const foreignKeyRows = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyRows.length) throw new Error("baseline foreign_key_check failed");
    if (checkResult(db.prepare("PRAGMA quick_check").get()) !== "ok") throw new Error("baseline quick_check failed");
    return { before, after, checks: { foreignKeyCheck: "ok", quickCheck: "ok" } };
  } finally {
    db.close();
  }
}

function sourceCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    throw new Error("unable to record source commit from this checkout");
  }
}

function prepare(options) {
  const source = absolute(options.source);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`source SQLite file does not exist: ${source}`);
  const commit = sourceCommit();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archive = absolute(options.archive || path.join(DEFAULT_ROOT, "archive", `jobs-${stamp}-${commit.slice(0, 12)}.sqlite`));
  const baseline = absolute(options.baseline || path.join(DEFAULT_ROOT, "baseline", `jobs-${stamp}-${commit.slice(0, 12)}.sqlite`));
  requireDDrive(archive, "archive target");
  requireDDrive(baseline, "baseline target");
  if (source === archive || source === baseline || archive === baseline) throw new Error("source, archive, and baseline paths must all be different");
  if (archive === PRODUCTION_DB || baseline === PRODUCTION_DB) throw new Error("refusing to target project data/jobs.sqlite");
  const archiveManifest = `${archive}.manifest.json`;
  const baselineReport = `${baseline}.report.json`;
  for (const file of [archive, baseline, archiveManifest, baselineReport]) {
    if (fs.existsSync(file)) throw new Error(`refusing to overwrite existing artifact: ${file}`);
  }

  const sourceInfo = inspectSource(source);
  const sourceStat = fs.statSync(source);
  const sourceSha256 = sha256(source);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  try {
    sourceDb.exec(`VACUUM INTO '${quotePath(archive)}'`);
  } finally {
    sourceDb.close();
  }
  const manifest = {
    artifact: "gate-d-archive",
    createdAtUtc: new Date().toISOString(),
    sourcePath: source,
    sourceCommit: commit,
    schemaVersion: sourceInfo.schemaVersion,
    sourceSize: sourceStat.size,
    sourceSha256,
    archivePath: archive,
    archiveSize: fs.statSync(archive).size,
    archiveSha256: sha256(archive)
  };
  fs.writeFileSync(archiveManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  fs.mkdirSync(path.dirname(baseline), { recursive: true });
  fs.copyFileSync(archive, baseline, fs.constants.COPYFILE_EXCL);
  const cleaned = clearClone(baseline, sourceInfo.preserved, sourceInfo.operational);
  const report = {
    artifact: "gate-d-baseline",
    createdAtUtc: new Date().toISOString(),
    sourcePath: source,
    archivePath: archive,
    baselinePath: baseline,
    schemaVersion: sourceInfo.schemaVersion,
    preserved: { before: cleaned.before.preserved, after: cleaned.after.preserved },
    operational: { before: cleaned.before.operational, after: cleaned.after.operational },
    checks: cleaned.checks,
    externalModelSettings: "not stored in SQLite v11; no external configuration was modified",
    unknownEmptyTables: sourceInfo.unknownEmptyTables
  };
  fs.writeFileSync(baselineReport, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { archive, archiveManifest, baseline, baselineReport };
}

if (require.main === module) {
  try {
    const result = prepare(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`prepare-gate-d-baseline: ${error.message}`);
    process.exitCode = 1;
  }
}
