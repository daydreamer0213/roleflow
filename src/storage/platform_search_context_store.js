const { nowIso } = require("./storage_shared");

const SITES = new Set(["boss", "zhaopin"]);

function savePlatformSearchContext(db, { planId, site, searchTemplate, filterSummary } = {}) {
  const normalizedPlanId = requirePlan(db, planId);
  const normalizedSite = requireSite(site);
  if (!searchTemplate || typeof searchTemplate !== "object" || Array.isArray(searchTemplate)) {
    throw platformContextError("PLATFORM_SEARCH_CONTEXT_TEMPLATE_INVALID", "platform search context requires a search template");
  }
  if (!Array.isArray(filterSummary)) {
    throw platformContextError("PLATFORM_SEARCH_CONTEXT_FILTER_SUMMARY_INVALID", "platform search context filter summary must be an array");
  }
  const now = nowIso();
  db.prepare(`INSERT INTO search_plan_platform_contexts(
    plan_id, site, search_template_json, filter_summary_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(plan_id, site) DO UPDATE SET
    search_template_json=excluded.search_template_json,
    filter_summary_json=excluded.filter_summary_json,
    updated_at=excluded.updated_at`)
    .run(normalizedPlanId, normalizedSite, JSON.stringify(searchTemplate), JSON.stringify(filterSummary), now, now);
  return getPlatformSearchContext(db, { planId: normalizedPlanId, site: normalizedSite });
}

function getPlatformSearchContext(db, { planId, site } = {}) {
  const normalizedPlanId = requirePlan(db, planId);
  const normalizedSite = requireSite(site);
  const row = db.prepare(`SELECT * FROM search_plan_platform_contexts
    WHERE plan_id = ? AND site = ?`).get(normalizedPlanId, normalizedSite);
  if (!row) return null;
  return {
    planId: Number(row.plan_id), site: row.site,
    searchTemplate: parseJson(row.search_template_json, {}),
    filterSummary: parseJson(row.filter_summary_json, []),
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function requirePlan(db, value) {
  const planId = Number(value);
  if (!Number.isInteger(planId) || planId <= 0 || !db.prepare("SELECT id FROM search_plans WHERE id = ?").get(planId)) {
    throw platformContextError("PLATFORM_SEARCH_CONTEXT_PLAN_NOT_FOUND", "platform search context plan was not found");
  }
  return planId;
}

function requireSite(value) {
  const site = String(value || "").trim().toLowerCase();
  if (!SITES.has(site)) throw platformContextError("PLATFORM_SEARCH_CONTEXT_SITE_INVALID", "platform search context site is invalid");
  return site;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function platformContextError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { savePlatformSearchContext, getPlatformSearchContext };
