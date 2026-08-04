const assert = require("node:assert/strict");
const {
  canonicalizeBossSearchTemplate,
  buildInheritedSearchScope,
  freezeKeywordSource,
  scopeShortId
} = require("../src/core/inherited_search_scope");

const firstUrl = "https://www.zhipin.com/web/geek/jobs?query=RAG&page=3&city=100010000&salary=405&unknownFilter=9&ka=search&utm_source=test";
const secondUrl = "https://www.zhipin.com/web/geek/jobs?unknownFilter=9&salary=405&city=100010000&query=Agent&page=1";
const first = buildInheritedSearchScope({ profileId: 7, rawUrl: firstUrl });
const second = buildInheritedSearchScope({ profileId: 7, rawUrl: secondUrl });

assert.deepStrictEqual(first.searchTemplate, {
  mode: "inherited",
  url: "https://www.zhipin.com/web/geek/jobs?city=100010000&salary=405&unknownFilter=9",
  cityCode: "100010000"
});
assert.strictEqual(first.searchScope.key, second.searchScope.key);
assert.strictEqual(first.searchScope.templateHash, second.searchScope.templateHash);
assert.deepStrictEqual(first.searchScope.filterParams, {
  city: ["100010000"],
  salary: ["405"],
  unknownFilter: ["9"]
});
assert.match(first.searchScope.key, /^boss:7:[a-f0-9]{64}$/);
assert.strictEqual(scopeShortId(first.searchScope.key), first.searchScope.templateHash.slice(0, 10));

assert.notStrictEqual(
  buildInheritedSearchScope({
    profileId: 7,
    rawUrl: "https://www.zhipin.com/web/geek/jobs?city=101280100&salary=405"
  }).searchScope.key,
  first.searchScope.key
);
assert.notStrictEqual(
  buildInheritedSearchScope({ profileId: 8, rawUrl: firstUrl }).searchScope.key,
  first.searchScope.key
);
assert.throws(
  () => canonicalizeBossSearchTemplate("https://www.zhipin.com/guangzhou/"),
  (error) => error.code === "BOSS_SEARCH_PAGE_INVALID"
);

const keywordSource = freezeKeywordSource({
  planRecord: {
    id: 11,
    profileVersionId: 23,
    plan: {
      keywords: [
        { word: "AI应用开发工程师", priority: "A", reason: "主方向", ignored: "not copied" },
        { word: "RAG开发工程师", priority: "B", reason: "检索增强" }
      ]
    }
  },
  matchingCardRevision: "card-revision-5"
});
assert.deepStrictEqual(keywordSource.keywords, [
  { word: "AI应用开发工程师", priority: "A", reason: "主方向" },
  { word: "RAG开发工程师", priority: "B", reason: "检索增强" }
]);
assert.strictEqual(keywordSource.searchPlanId, 11);
assert.strictEqual(keywordSource.profileVersionId, 23);
assert.strictEqual(keywordSource.matchingCardRevision, "card-revision-5");
assert.match(keywordSource.catalogHash, /^[a-f0-9]{64}$/);

console.log("inherited_search_scope_smoke ok");
