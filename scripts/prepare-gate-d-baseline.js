const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
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
const REQUIRED_NONZERO_PRESERVED = PRESERVED_TABLES.filter((table) => table !== "candidate_facts");
const OPERATIONAL_TABLES = [
  "resume_parse_attempts", "keyword_sources", "platform_filter_catalogs", "model_cache", "site_runtime_states", "site_scan_leases",
  "job_analysis_attempts", "workflow_job_tasks", "workflow_runs", "candidate_progress_events", "candidate_progress_cards",
  "message_preview_states", "message_discovery_unresolved_items", "communication_batch_items", "communication_batches",
  "candidate_job_events", "candidate_job_states", "applications", "events", "job_refresh_attempts", "job_observations",
  "scan_target_results", "scan_runs", "batches", "jobs"
];
const KNOWN_TABLES = new Set([...PRESERVED_TABLES, ...OPERATIONAL_TABLES]);

function parseArgs(argv) {
  const args = { protectedDbs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--source", "--source-commit", "--archive", "--baseline", "--protected-db"]).has(flag)) throw new Error(`unknown argument: ${flag}`);
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (flag === "--protected-db") args.protectedDbs.push(value);
    else args[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  if (!args.source || !args.sourceCommit || !args.protectedDbs.length) {
    throw new Error("usage: node scripts/prepare-gate-d-baseline.js --source <sqlite> --source-commit <40hex> --protected-db <main.sqlite> [--protected-db <other.sqlite>] [--archive <sqlite>] [--baseline <sqlite>]");
  }
  return args;
}

function normalizeComparePath(file) {
  const normalized = path.normalize(file);
  return (normalized.length > path.parse(normalized).root.length ? normalized.replace(/[\\/]+$/, "") : normalized).toLowerCase();
}

function canonicalExisting(file, label) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  const real = fs.realpathSync.native(resolved);
  return { path: real, key: normalizeComparePath(real) };
}

function canonicalTarget(file, label) {
  const resolved = path.resolve(file);
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync.native(resolved);
    return { path: real, key: normalizeComparePath(real) };
  }
  const tail = [];
  let parent = resolved;
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error(`cannot resolve ${label} parent: ${resolved}`);
    tail.unshift(path.basename(parent));
    parent = next;
  }
  if (!fs.statSync(parent).isDirectory()) throw new Error(`${label} parent is not a directory: ${parent}`);
  const realParent = fs.realpathSync.native(parent);
  const canonical = path.join(realParent, ...tail);
  return { path: canonical, key: normalizeComparePath(canonical) };
}

function requireDDrive(target, label) {
  if (path.parse(target.path).root.toLowerCase() !== "d:\\") throw new Error(`${label} must be on D:: ${target.path}`);
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
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

function stableFileFingerprint(file, name) {
  const before = fs.statSync(file);
  if (!before.isFile()) throw new Error(`source bundle member is not a file: ${file}`);
  const bytes = fs.readFileSync(file);
  const after = fs.statSync(file);
  if (before.size !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`source bundle member changed while reading: ${file}`);
  }
  return { name, path: file, size: before.size, sha256: sha256Buffer(bytes) };
}

function fingerprintBundle(source) {
  const files = [stableFileFingerprint(source, "database")];
  for (const suffix of ["-wal", "-shm"]) {
    const file = `${source}${suffix}`;
    try {
      files.push(stableFileFingerprint(file, suffix.slice(1)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { algorithm: "sha256", files };
}

function inspectSource(source) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    const schemaVersion = Number(db.prepare("PRAGMA user_version").get().user_version || 0);
    if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) throw new Error(`unsupported schema version: expected v${SUPPORTED_SCHEMA_VERSION}, got v${schemaVersion}`);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    const missing = [...KNOWN_TABLES].filter((table) => !tables.includes(table));
    if (missing.length) throw new Error(`unsupported v11 schema missing required tables: ${missing.join(", ")}`);
    const preserved = counts(db, PRESERVED_TABLES);
    const emptyRequired = REQUIRED_NONZERO_PRESERVED.filter((table) => preserved[table] === 0);
    if (emptyRequired.length) throw new Error(`required preserved tables are empty: ${emptyRequired.join(", ")}`);
    const unknownWithData = tables.filter((table) => !KNOWN_TABLES.has(table) && count(db, table) > 0);
    if (unknownWithData.length) throw new Error(`unknown populated tables fail closed: ${unknownWithData.join(", ")}`);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("source foreign_key_check failed");
    if (checkResult(db.prepare("PRAGMA quick_check").get()) !== "ok") throw new Error("source quick_check failed");
    return { schemaVersion, preserved, operational: counts(db, OPERATIONAL_TABLES), unknownEmptyTables: tables.filter((table) => !KNOWN_TABLES.has(table)) };
  } finally {
    db.close();
  }
}

function assertCountsEqual(label, expected, actual) {
  for (const table of Object.keys(expected)) {
    if (expected[table] !== actual[table]) throw new Error(`${label} changed unexpectedly for ${table}: ${expected[table]} -> ${actual[table]}`);
  }
}

function validateArchive(archive, expectedPreserved, expectedOperational) {
  const db = new DatabaseSync(archive, { readOnly: true });
  try {
    const preserved = counts(db, PRESERVED_TABLES);
    const operational = counts(db, OPERATIONAL_TABLES);
    assertCountsEqual("archive preserved table", expectedPreserved, preserved);
    assertCountsEqual("archive operational table", expectedOperational, operational);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("archive foreign_key_check failed");
    if (checkResult(db.prepare("PRAGMA quick_check").get()) !== "ok") throw new Error("archive quick_check failed");
    return { foreignKeyCheck: "ok", quickCheck: "ok" };
  } finally {
    db.close();
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
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("baseline foreign_key_check failed");
    if (checkResult(db.prepare("PRAGMA quick_check").get()) !== "ok") throw new Error("baseline quick_check failed");
    return { before, after, checks: { foreignKeyCheck: "ok", quickCheck: "ok" } };
  } finally {
    db.close();
  }
}

function toolCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    throw new Error("unable to record tool worktree commit");
  }
}

function partialPath(finalPath) {
  return path.join(path.dirname(finalPath), `.partial-${randomUUID()}-${path.basename(finalPath)}`);
}

function removeFiles(files) {
  const failures = [];
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") {
        error.file = file;
        failures.push(error);
      }
    }
  }
  return failures.length ? new AggregateError(failures, "failed to remove one or more Gate D artifacts") : null;
}

function publish(partial, finalPath, published, unlinkPartial) {
  fs.linkSync(partial, finalPath);
  published.push(finalPath);
  unlinkPartial(partial, finalPath);
}

function prepare(options, hooks = {}) {
  const sourceCommit = String(options.sourceCommit || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("source commit must be an explicit 40-character hexadecimal hash");
  const source = canonicalExisting(options.source, "source");
  if (!fs.statSync(source.path).isFile()) throw new Error(`source SQLite path is not a file: ${source.path}`);
  const commit = toolCommit();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archive = canonicalTarget(options.archive || path.join(DEFAULT_ROOT, "archive", `jobs-${stamp}-${sourceCommit.slice(0, 12)}.sqlite`), "archive target");
  const baseline = canonicalTarget(options.baseline || path.join(DEFAULT_ROOT, "baseline", `jobs-${stamp}-${sourceCommit.slice(0, 12)}.sqlite`), "baseline target");
  requireDDrive(archive, "archive target");
  requireDDrive(baseline, "baseline target");
  const protectedDbs = [canonicalTarget(PRODUCTION_DB, "worktree production database"), ...(options.protectedDbs || []).map((file) => canonicalTarget(file, "protected database"))];
  if (source.key === archive.key || source.key === baseline.key || archive.key === baseline.key) throw new Error("source, archive, and baseline paths must all be different");
  if (protectedDbs.some((protectedDb) => archive.key === protectedDb.key || baseline.key === protectedDb.key)) throw new Error("refusing to target a protected database");

  const archiveManifest = `${archive.path}.manifest.json`;
  const baselineReport = `${baseline.path}.report.json`;
  const receipt = `${baseline.path}.receipt.json`;
  const finals = [archive.path, baseline.path, archiveManifest, baselineReport, receipt];
  for (const file of finals) if (fs.existsSync(file)) throw new Error(`refusing to overwrite existing artifact: ${file}`);

  const partials = finals.map(partialPath);
  const [partialArchive, partialBaseline, partialManifest, partialReport, partialReceipt] = partials;
  const published = [];
  try {
    const sourceInfo = inspectSource(source.path);
    const sourceBefore = fingerprintBundle(source.path);
    fs.mkdirSync(path.dirname(archive.path), { recursive: true });
    const sourceDb = new DatabaseSync(source.path, { readOnly: true });
    try {
      sourceDb.exec(`VACUUM INTO '${quotePath(partialArchive)}'`);
    } finally {
      sourceDb.close();
    }
    const archiveChecks = validateArchive(partialArchive, sourceInfo.preserved, sourceInfo.operational);
    if (hooks.afterArchiveSnapshot) hooks.afterArchiveSnapshot();
    if (hooks.beforeSourceAfterFingerprint) hooks.beforeSourceAfterFingerprint();
    const sourceAfter = fingerprintBundle(source.path);
    if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter)) throw new Error("source SQLite bundle changed during archive snapshot");

    fs.mkdirSync(path.dirname(baseline.path), { recursive: true });
    fs.copyFileSync(partialArchive, partialBaseline, fs.constants.COPYFILE_EXCL);
    const cleaned = clearClone(partialBaseline, sourceInfo.preserved, sourceInfo.operational);
    const archiveSnapshot = {
      path: archive.path,
      size: fs.statSync(partialArchive).size,
      sha256: sha256File(partialArchive),
      checks: archiveChecks,
      note: "canonical SQLite snapshot generated by VACUUM INTO; not a byte-for-byte source bundle copy"
    };
    const manifest = {
      artifact: "gate-d-archive",
      createdAtUtc: new Date().toISOString(),
      sourcePath: source.path,
      sourceCommit,
      toolCommit: commit,
      schemaVersion: sourceInfo.schemaVersion,
      sourceBundle: { before: sourceBefore, after: sourceAfter },
      archiveSnapshot
    };
    const report = {
      artifact: "gate-d-baseline",
      createdAtUtc: new Date().toISOString(),
      sourcePath: source.path,
      archivePath: archive.path,
      baselinePath: baseline.path,
      schemaVersion: sourceInfo.schemaVersion,
      preserved: { before: cleaned.before.preserved, after: cleaned.after.preserved },
      operational: { before: cleaned.before.operational, after: cleaned.after.operational },
      checks: cleaned.checks,
      externalModelSettings: "not stored in SQLite v11; no external configuration was modified",
      unknownEmptyTables: sourceInfo.unknownEmptyTables
    };
    fs.writeFileSync(partialManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(partialReport, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(partialReceipt, `${JSON.stringify({ artifact: "gate-d-baseline-receipt", complete: true, createdAtUtc: new Date().toISOString(), archivePath: archive.path, baselinePath: baseline.path, archiveSha256: archiveSnapshot.sha256 }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

    for (const [partial, finalPath] of [[partialArchive, archive.path], [partialBaseline, baseline.path], [partialManifest, archiveManifest], [partialReport, baselineReport], [partialReceipt, receipt]]) {
      publish(partial, finalPath, published, hooks.unlinkPartial || fs.unlinkSync);
    }
    return { archive: archive.path, archiveManifest, baseline: baseline.path, baselineReport, receipt };
  } catch (error) {
    const cleanupErrors = [removeFiles(partials), removeFiles(published)].filter(Boolean);
    if (cleanupErrors.length) error.cleanupError = new AggregateError(cleanupErrors, "Gate D artifact cleanup failed");
    throw error;
  }
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(prepare(parseArgs(process.argv.slice(2)))));
  } catch (error) {
    console.error(`prepare-gate-d-baseline: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { prepare };
