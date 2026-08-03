const RECOMMENDATION_TIERS = ["primary", "apply", "caution", "not_recommended"];
const DIAGNOSTIC_BUCKETS = new Set(["analysis_pending", "refresh"]);
const OUTCOMES = ["pending", "review", "later", "applied", "skipped", "no_reply", "interview", "rejected", "invalid", "salary_mismatch"];
const UNRESOLVED = new Set(["pending", "review", "later"]);
const MAX_NAMED_KEYWORDS = 12;
const OTHER_KEYWORD = "\u5176\u4ed6\u5173\u952e\u8bcd";
const MISSING_KEYWORD = "\u672a\u8bb0\u5f55\u5173\u952e\u8bcd";

function emptyOutcomes() {
  return Object.fromEntries(OUTCOMES.map((status) => [status, 0]));
}

function addKeywordGroup(target, source) {
  target.total += source.total;
  for (const outcome of OUTCOMES) target.outcomes[outcome] += source.outcomes[outcome];
}

function compareKeywordGroups(left, right) {
  if (left.total !== right.total) return right.total - left.total;
  if (left.keyword < right.keyword) return -1;
  if (left.keyword > right.keyword) return 1;
  return 0;
}

function buildOutcomeAnalytics(rows = []) {
  const source = Array.isArray(rows) ? rows : [];
  const tiers = RECOMMENDATION_TIERS.map((tier) => ({
    tier,
    total: 0,
    unresolvedCount: 0,
    recordedOutcomeCount: 0,
    outcomes: emptyOutcomes()
  }));
  const tierByName = new Map(tiers.map((row) => [row.tier, row]));
  const diagnostics = { total: 0, outcomes: emptyOutcomes() };
  const unclassified = {
    total: 0,
    unknownDecisionBucket: 0,
    unknownApplicationStatus: 0
  };
  const keywords = new Map();

  for (const item of source) {
    const bucket = typeof item?.decisionBucket === "string" ? item.decisionBucket : "";
    const rawStatus = item?.applicationStatus;
    const status = rawStatus == null || rawStatus === "" ? "pending" : rawStatus;
    const validStatus = OUTCOMES.includes(status);
    const keyword = typeof item?.keyword === "string" && item.keyword.trim()
      ? item.keyword.trim()
      : MISSING_KEYWORD;
    const target = tierByName.get(bucket) || (DIAGNOSTIC_BUCKETS.has(bucket) ? diagnostics : null);

    if (!target || !validStatus) unclassified.total += 1;
    if (!target) unclassified.unknownDecisionBucket += 1;
    if (!validStatus) unclassified.unknownApplicationStatus += 1;

    if (target) {
      target.total += 1;
      if (validStatus) {
        target.outcomes[status] += 1;
        if (tierByName.has(bucket)) {
          if (UNRESOLVED.has(status)) target.unresolvedCount += 1;
          else target.recordedOutcomeCount += 1;
        }
      }
    }

    const group = keywords.get(keyword) || { keyword, total: 0, outcomes: emptyOutcomes() };
    group.total += 1;
    if (validStatus) group.outcomes[status] += 1;
    keywords.set(keyword, group);
  }

  const reservedOther = keywords.get(OTHER_KEYWORD);
  const keywordRows = [...keywords.values()]
    .filter((group) => group.keyword !== OTHER_KEYWORD)
    .sort(compareKeywordGroups);
  const boundedKeywords = keywordRows.slice(0, MAX_NAMED_KEYWORDS);
  const overflow = keywordRows.slice(MAX_NAMED_KEYWORDS);
  if (reservedOther || overflow.length) {
    const other = { keyword: OTHER_KEYWORD, total: 0, outcomes: emptyOutcomes() };
    if (reservedOther) addKeywordGroup(other, reservedOther);
    for (const group of overflow) addKeywordGroup(other, group);
    boundedKeywords.push(other);
  }

  return {
    totals: {
      total: source.length,
      fourTierTotal: tiers.reduce((sum, row) => sum + row.total, 0)
    },
    tiers,
    diagnostics,
    keywords: boundedKeywords,
    unclassified
  };
}

module.exports = {
  RECOMMENDATION_TIERS,
  DIAGNOSTIC_BUCKETS,
  OUTCOMES,
  MAX_NAMED_KEYWORDS,
  buildOutcomeAnalytics
};
