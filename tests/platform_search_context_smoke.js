const assert = require("node:assert/strict");
const { openDb, saveProfileAnalysis, createWorkflowRun, getWorkflowRun, listWorkflowRuns } = require("../src/core/storage");
const {
  savePlatformSearchContext,
  getPlatformSearchContext
} = require("../src/storage/platform_search_context_store");
const {
  acquireSiteScanLease,
  releaseSiteScanLease
} = require("../src/storage/scan_store");
const { buildInheritedSearchScope, assertCompleteInheritedContext, freezeKeywordSource } = require("../src/core/inherited_search_scope");

const db = openDb(":memory:");
try {
  const first = saveProfileAnalysis(db, {
    profile: { candidate: { name: "平台隔离", city: "广州", targetTitles: ["AI应用开发"] }, skills: [], projects: [] },
    document: { originalFileName: "platform.txt", format: "text", contentHash: "platform-v1", text: "resume", diagnostics: {} },
    searchPlan: { name: "平台方案", cities: ["广州"], keywords: [{ word: "RAG", priority: "A" }] }
  });
  const second = saveProfileAnalysis(db, {
    profile: { candidate: { name: "另一方案", city: "广州", targetTitles: ["AI应用开发"] }, skills: [], projects: [] },
    document: { originalFileName: "platform-2.txt", format: "text", contentHash: "platform-v2", text: "resume", diagnostics: {} },
    searchPlan: { name: "另一平台方案", cities: ["广州"], keywords: [{ word: "Agent", priority: "A" }] }
  });

  const boss = savePlatformSearchContext(db, {
    planId: first.planId,
    site: "boss",
    searchTemplate: { mode: "inherited", url: "https://www.zhipin.com/web/geek/jobs?city=101280100", cityCode: "101280100" },
    filterSummary: ["广州"]
  });
  const zhaopin = savePlatformSearchContext(db, {
    planId: first.planId,
    site: "zhaopin",
    searchTemplate: { mode: "inherited", url: "https://www.zhaopin.com/jobs/?jl=548&pageMode=search&sl=10001%2C15000", cityCode: "548" },
    filterSummary: ["广州", "10K-15K"]
  });
  assert.equal(getPlatformSearchContext(db, { planId: first.planId, site: "boss" }).searchTemplate.url, boss.searchTemplate.url);
  assert.equal(getPlatformSearchContext(db, { planId: first.planId, site: "zhaopin" }).searchTemplate.url, zhaopin.searchTemplate.url);
  assert.equal(getPlatformSearchContext(db, { planId: second.planId, site: "zhaopin" }), null);
  assert.throws(() => savePlatformSearchContext(db, { planId: first.planId, site: "unknown", searchTemplate: {}, filterSummary: [] }), (error) => error.code === "PLATFORM_SEARCH_CONTEXT_SITE_INVALID");
  assert.throws(() => getPlatformSearchContext(db, { planId: first.planId + second.planId + 99, site: "boss" }), (error) => error.code === "PLATFORM_SEARCH_CONTEXT_PLAN_NOT_FOUND");

  const keywordSource = freezeKeywordSource({ planRecord: { id: first.planId, profileVersionId: first.profileVersionId, plan: { keywords: [{ word: "RAG", priority: "A" }] } }, matchingCardRevision: "card-r1" });
  const legacyBossScope = buildInheritedSearchScope({ profileId: first.profileId, rawUrl: boss.searchTemplate.url });
  assert.doesNotThrow(() => assertCompleteInheritedContext({
    searchTemplate: legacyBossScope.searchTemplate,
    searchScope: legacyBossScope.searchScope,
    keywordSource,
    platformPolicy: { site: "boss", templateHash: legacyBossScope.searchScope.templateHash, hash: "legacy-policy", filters: {}, unresolvedParams: [], filterSummary: [] }
  }, { planId: first.planId }));

  createWorkflowRun(db, { id: "boss-slot", profileId: first.profileId, planId: first.planId, localDay: "2026-09-06", sequence: 1, site: "boss" });
  createWorkflowRun(db, { id: "zhaopin-slot", profileId: first.profileId, planId: first.planId, localDay: "2026-09-06", sequence: 1, site: "zhaopin" });
  assert.equal(getWorkflowRun(db, "boss-slot").site, "boss");
  assert.equal(getWorkflowRun(db, "zhaopin-slot").site, "zhaopin");
  assert.equal(listWorkflowRuns(db, { profileId: first.profileId, localDay: "2026-09-06" }).length, 2, "omitting site retains all historical platforms");
  assert.deepEqual(listWorkflowRuns(db, { profileId: first.profileId, localDay: "2026-09-06", site: "zhaopin" }).map((row) => row.id), ["zhaopin-slot"]);

  acquireSiteScanLease(db, { site: "boss", owner: "boss-owner", ttlMs: 60_000 });
  assert.throws(() => acquireSiteScanLease(db, { site: "zhaopin", owner: "zhaopin-owner", ttlMs: 60_000 }), (error) => error.code === "SCAN_ALREADY_RUNNING");
  assert.equal(releaseSiteScanLease(db, { site: "boss", owner: "boss-owner" }), true);
  acquireSiteScanLease(db, { site: "zhaopin", owner: "zhaopin-owner", ttlMs: 60_000 });
  assert.equal(releaseSiteScanLease(db, { site: "zhaopin", owner: "zhaopin-owner" }), true);
} finally {
  db.close();
}

console.log("platform_search_context_smoke ok");
