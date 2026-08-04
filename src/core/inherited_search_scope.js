const crypto = require("node:crypto");
const { stableHash } = require("./analysis_revision");

const BOSS_SEARCH_ORIGIN = "https://www.zhipin.com";
const BOSS_SEARCH_PATH = "/web/geek/jobs";
const REMOVED_PARAMS = new Set([
  "query", "page", "ka", "source", "from", "src",
  "trackId", "lid", "_", "timestamp"
]);

function canonicalizeBossSearchTemplate(rawUrl) {
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
    if (REMOVED_PARAMS.has(name) || name.startsWith("utm_")) continue;
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
  const retainedParams = Object.entries(searchScope.filterParams || {}).filter(([name, values]) =>
    String(name || "").trim()
    && (Array.isArray(values) ? values : [values]).some((value) => String(value || "").trim())
  );
  if (!retainedParams.length) {
    throw scopeError(
      "INHERITED_SCOPE_FILTER_REQUIRED",
      "当前 BOSS 搜索页没有可继承的稳定筛选条件，请至少保留一个地点、薪资、经验或其他平台筛选条件。"
    );
  }
  return searchScope;
}

function freezeKeywordSource({ planRecord, matchingCardRevision = "" } = {}) {
  if (!planRecord?.id || !planRecord?.profileVersionId) {
    throw scopeError("INHERITED_KEYWORD_SOURCE_INVALID", "继承模式缺少已确认的 Search Plan 版本。");
  }
  const keywords = (planRecord.plan?.keywords || []).map((item) => ({
    word: String(typeof item === "string" ? item : item?.word || "").trim(),
    priority: ["A", "B", "C"].includes(item?.priority) ? item.priority : "B",
    reason: String(item?.reason || "").trim()
  })).filter((item) => item.word);
  if (!keywords.length) {
    throw scopeError("INHERITED_KEYWORD_SOURCE_EMPTY", "已确认的 Search Plan 没有可用关键词。");
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
  buildInheritedSearchScope,
  assertInheritedAcquisitionScope,
  freezeKeywordSource,
  scopeShortId
};
