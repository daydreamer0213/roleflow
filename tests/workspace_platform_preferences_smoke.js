const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SCHEMA_VERSION,
  openDb,
  getWorkspacePlatformPreference,
  saveWorkspacePlatformPreference
} = require("../src/core/storage");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-workspace-platforms-"));
const dbPath = path.join(root, "jobs.sqlite");
const db = openDb(dbPath);
try {
  assert.strictEqual(SCHEMA_VERSION, 31);
  assert.strictEqual(getWorkspacePlatformPreference(db), null, "fresh users must choose a platform");
  assert.throws(
    () => saveWorkspacePlatformPreference(db, []),
    (error) => error?.code === "WORKSPACE_PLATFORM_REQUIRED"
  );
  assert.throws(
    () => saveWorkspacePlatformPreference(db, ["boss", "unsupported"]),
    (error) => error?.code === "WORKSPACE_PLATFORM_INVALID"
  );

  let saved = saveWorkspacePlatformPreference(db, ["zhaopin", "boss", "zhaopin"], {
    now: "2026-09-10T13:00:00.000Z"
  });
  assert.deepStrictEqual(saved.platforms, ["boss", "zhaopin"]);
  assert.strictEqual(saved.selectedAt, "2026-09-10T13:00:00.000Z");

  saved = saveWorkspacePlatformPreference(db, ["zhaopin"], {
    now: "2026-09-10T13:01:00.000Z"
  });
  assert.deepStrictEqual(saved.platforms, ["zhaopin"]);
  assert.strictEqual(saved.selectedAt, "2026-09-10T13:00:00.000Z");
  assert.strictEqual(saved.updatedAt, "2026-09-10T13:01:00.000Z");
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("workspace_platform_preferences_smoke ok");
