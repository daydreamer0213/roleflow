const { nowIso, parseJson, storageError } = require("./storage_shared");

const SUPPORTED_WORKSPACE_PLATFORMS = Object.freeze(["boss", "zhaopin"]);

function getWorkspacePlatformPreference(db) {
  const row = db.prepare(`SELECT platforms_json, selected_at, updated_at
    FROM workspace_platform_preferences WHERE id = 1`).get();
  if (!row) return null;
  const platforms = normalizeWorkspacePlatforms(parseJson(row.platforms_json, []), { allowEmpty: false });
  return {
    platforms,
    selectedAt: row.selected_at,
    updatedAt: row.updated_at
  };
}

function saveWorkspacePlatformPreference(db, platforms, { now = nowIso() } = {}) {
  const normalized = normalizeWorkspacePlatforms(platforms, { allowEmpty: false });
  db.prepare(`INSERT INTO workspace_platform_preferences(
      id, platforms_json, selected_at, updated_at
    ) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      platforms_json = excluded.platforms_json,
      updated_at = excluded.updated_at`).run(JSON.stringify(normalized), now, now);
  return getWorkspacePlatformPreference(db);
}

function normalizeWorkspacePlatforms(value, { allowEmpty = true } = {}) {
  const input = Array.isArray(value) ? value : value == null ? [] : [value];
  const normalized = [...new Set(input.map((item) => String(item || "").trim().toLowerCase()))]
    .filter(Boolean);
  if (normalized.some((site) => !SUPPORTED_WORKSPACE_PLATFORMS.includes(site))) {
    throw storageError("WORKSPACE_PLATFORM_INVALID", "请选择 RoleFlow 当前支持的招聘平台。");
  }
  const ordered = SUPPORTED_WORKSPACE_PLATFORMS.filter((site) => normalized.includes(site));
  if (!allowEmpty && !ordered.length) {
    throw storageError("WORKSPACE_PLATFORM_REQUIRED", "请至少选择一个招聘平台。");
  }
  return ordered;
}

module.exports = {
  SUPPORTED_WORKSPACE_PLATFORMS,
  getWorkspacePlatformPreference,
  saveWorkspacePlatformPreference,
  normalizeWorkspacePlatforms
};
