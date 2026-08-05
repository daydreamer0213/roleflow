const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { openDb } = require("../src/core/storage");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `communication-cli-authority-${Date.now()}.sqlite`);
let db;

try {
  fs.mkdirSync(smokeDir, { recursive: true });
  db = openDb(dbPath);
  const now = "2026-08-05T08:00:00.000Z";
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, created_at, updated_at
  ) VALUES (?, '{}', ?, ?)`).run("CLI authority smoke", now, now).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, created_at, updated_at
  ) VALUES (?, ?, '{}', ?, ?)`).run(profileId, "CLI authority smoke", now, now).lastInsertRowid);
  const batchId = Number(db.prepare(`INSERT INTO communication_batches(
    site, profile_id, plan_id, browser_mode, status, policy_json,
    confirmed_at, created_at, updated_at
  ) VALUES ('boss', ?, ?, 'portable', 'confirmed', ?, ?, ?, ?)`)
    .run(
      profileId,
      planId,
      JSON.stringify({ browser: { mode: "portable", cdpPort: 9222 } }),
      now,
      now,
      now
    ).lastInsertRowid);
  db.close();
  db = null;

  const result = spawnSync(process.execPath, [
    path.join(root, "src", "cli.js"),
    "communicate",
    "--db",
    dbPath,
    "--batch",
    String(batchId),
    "--browser",
    "portable",
    "--cdp-port",
    "9333"
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000
  });

  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /COMMUNICATION_PORTABLE_CDP_PORT_MISMATCH/);

  db = openDb(dbPath);
  const persisted = db.prepare("SELECT status, started_at, stop_code FROM communication_batches WHERE id = ?").get(batchId);
  assert.deepStrictEqual({ ...persisted }, {
    status: "confirmed",
    started_at: null,
    stop_code: null
  });

  console.log("communication_cli_authority_smoke ok");
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  db?.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
  }
}
