const crypto = require("node:crypto");
const { stableHash } = require("./analysis_revision");

const BOSS_SEARCH_ORIGIN = "https://www.zhipin.com";
const BOSS_SEARCH_PATH = "/web/geek/jobs";
const REMOVED_PARAMS = new Set([
  "query", "page", "ka", "source", "from", "src",
  "trackId", "lid", "_", "timestamp"
]);
const TARGET_REMOVED_PARAMS = new Set([...REMOVED_PARAMS].filter((name) => name !== "query"));

function canonicalizeBossSearchTemplate(rawUrl) {
  return canonicalizeBossSearchUrl(rawUrl, REMOVED_PARAMS);
}

function canonicalizeBossTargetUrl(rawUrl) {
  return canonicalizeBossSearchUrl(rawUrl, TARGET_REMOVED_PARAMS);
}

function canonicalizeBossSearchUrl(rawUrl, removedParams) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch (cause) {
    throw scopeError("BOSS_SEARCH_PAGE_INVALID", "当前 BOSS 搜索页 URL 无效。", cause);
  }
  if (url.origin !== BOSS_SEARCH_ORIGIN || url.pathname.replace(/\/+$/, "") !== BOSS_SEARCH_PATH) {
    throw scopeError("BOSS_SEARCH_PAGE_INVALID", "当前标签页不是可用的 BOSS 搜索页。");
  }
  const grouped = new Map();
  for (const [name, value] of url.searchParams.entries()) {
    if (removedParams.has(name) || name.startsWith("utm_")) continue;
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(String(value));
  }
  const canonicalParams = new URLSearchParams();
  for (const name of [...grouped.keys()].sort()) {
    for (const value of grouped.get(name).sort()) canonicalParams.append(name, value);
  }
  const canonical = new URL(BOSS_SEARCH_PATH, BOSS_SEARCH_ORIGIN);
  canonical.search = canonicalParams.toString();
  const urlText = canonical.toString().replace(/\?$/, "");
  return {
    mode: "inherited",
    url: urlText,
    cityCode: canonicalParams.get("city") || ""
  };
}

function buildInheritedSearchScope({ profileId, rawUrl } = {}) {
  const normalizedProfileId = Number(profileId);
  if (!Number.isInteger(normalizedProfileId) || normalizedProfileId <= 0) {
    throw scopeError("INHERITED_SCOPE_PROFILE_INVALID", "继承范围需要有效候选人画像。");
  }
  const searchTemplate = canonicalizeBossSearchTemplate(rawUrl);
  const templateHash = crypto.createHash("sha256").update(searchTemplate.url).digest("hex");
  const filterParams = {};
  const url = new URL(searchTemplate.url);
  for (const name of [...new Set(url.searchParams.keys())].sort()) {
    filterParams[name] = url.searchParams.getAll(name);
  }
  const searchScope = {
    key: `boss:${normalizedProfileId}:${templateHash}`,
    site: "boss",
    templateHash,
    templateUrl: searchTemplate.url,
    filterParams
  };
  assertInheritedAcquisitionScope(searchScope);
  return { searchTemplate, searchScope };
}

function assertInheritedAcquisitionScope(searchScope = {}) {
  const templateUrl = String(searchScope?.templateUrl || "");
  const templateHash = String(searchScope?.templateHash || "");
  const key = String(searchScope?.key || "");
  if (
    searchScope?.site !== "boss"
    || !templateUrl
    || !templateHash
    || !key.startsWith("boss:")
    || !key.endsWith(`:${templateHash}`)
    || !Object.hasOwn(searchScope, "filterParams")
    || !searchScope.filterParams
    || typeof searchScope.filterParams !== "object"
    || Array.isArray(searchScope.filterParams)
  ) {
    throw scopeError("INHERITED_SCOPE_INVALID", "继承范围数据不完整或格式无效。");
  }
  const canonical = canonicalizeBossSearchTemplate(templateUrl);
  if (canonical.url !== templateUrl) {
    throw scopeError("INHERITED_SCOPE_INVALID", "继承范围 URL 不是规范化的 BOSS 搜索页。");
  }
  return searchScope;
}

function assertCompleteInheritedContext(context = {}, {
  code = "INHERITED_SNAPSHOT_INVALID",
  message = "继承模式快照不完整，不能安全恢复。",
  planId = null
} = {}) {
  const { searchTemplate, searchScope, keywordSource, platformPolicy } = context || {};
  try {
    assertInheritedAcquisitionScope(searchScope);
  } catch (cause) {
    throw scopeError(code, message, cause);
  }
  const expectedPlanId = planId === null || planId === undefined ? null : Number(planId);
  const keywordPlanId = Number(keywordSource?.searchPlanId || 0);
  if (
    searchTemplate?.mode !== "inherited"
    || String(searchTemplate?.url || "") !== String(searchScope.templateUrl || "")
    || !Number.isInteger(keywordPlanId)
    || keywordPlanId <= 0
    || (expectedPlanId !== null && keywordPlanId !== expectedPlanId)
    || !Number.isInteger(Number(keywordSource?.profileVersionId || 0))
    || Number(keywordSource?.profileVersionId || 0) <= 0
    || !String(keywordSource?.matchingCardRevision || "").trim()
    || !String(keywordSource?.catalogHash || "").trim()
    || !Array.isArray(keywordSource?.keywords)
    || !keywordSource.keywords.length
    || !String(platformPolicy?.hash || "").trim()
    || platformPolicy?.site !== "boss"
    || String(platformPolicy?.templateHash || "") !== String(searchScope.templateHash || "")
    || !platformPolicy?.filters
    || typeof platformPolicy.filters !== "object"
    || Array.isArray(platformPolicy.filters)
    || !Array.isArray(platformPolicy?.unresolvedParams)
    || !Array.isArray(platformPolicy?.filterSummary)
  ) {
    throw scopeError(code, message);
  }
  return context;
}

function freezeKeywordSource({ planRecord, matchingCardRevision = "" } = {}) {
  if (!planRecord?.id || !planRecord?.profileVersionId) {
    throw scopeError("INHERITED_KEYWORD_SOURCE_INVALID", "当前任务缺少已确认的 Search Plan 版本。");
  }
  const keywords = (planRecord.plan?.keywords || []).map((item) => ({
    word: String(typeof item === "string" ? item : item?.word || "").trim(),
    priority: ["A", "B", "C"].includes(item?.priority) ? item.priority : "B",
    reason: String(item?.reason || "").trim()
  })).filter((item) => item.word);
  if (!keywords.length) {
    throw scopeError("INHERITED_KEYWORD_SOURCE_EMPTY", "当前任务的 Search Plan 没有可用关键词。");
  }
  return {
    searchPlanId: Number(planRecord.id),
    profileVersionId: Number(planRecord.profileVersionId),
    matchingCardRevision: String(matchingCardRevision || ""),
    catalogHash: stableHash(keywords),
    keywords
  };
}

function scopeShortId(scopeKey) {
  return String(scopeKey || "").split(":").at(-1)?.slice(0, 10) || "";
}

function scopeError(code, message, cause) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  canonicalizeBossSearchTemplate,
  canonicalizeBossTargetUrl,
  buildInheritedSearchScope,
  assertInheritedAcquisitionScope,
  assertCompleteInheritedContext,
  freezeKeywordSource,
  scopeShortId
};
