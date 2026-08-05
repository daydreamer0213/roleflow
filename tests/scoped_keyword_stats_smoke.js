const assert = require("node:assert/strict");
const {
  openDb,
  saveProfileAnalysis,
  createBatch,
  upsertJob,
  createWorkflowRun
} = require("../src/core/storage");
const { listScopedKeywordStats } = require("../src/core/scoped_keyword_stats");

const db = openDb(":memory:");
const saved = saveProfileAnalysis(db, {
  profile: {
    candidate: { name: "Scope Fixture", city: "广州", targetTitles: ["AI应用开发"] },
    education: [], experiences: [], skills: [], projects: [], credentials: [], strengths: []
  },
  document: {
    originalFileName: "scope.txt",
    format: "text",
    contentHash: "scope-fixture",
    text: "scope fixture ".repeat(20),
    diagnostics: {}
  },
  searchPlan: {
    name: "Scope",
    cities: ["广州"],
    directions: ["AI应用开发"],
    keywords: [
      { word: "AI应用开发", priority: "A" },
      { word: "RAG开发", priority: "B" }
    ],
    salary: { minK: 10, maxK: 20 },
    experience: ["1-3年"],
    jobTypes: ["全职"],
    platform: { site: "boss" }
  }
});

function eligibleJob(sourceId, keyword, overrides = {}) {
  return {
    source: "boss",
    sourceId,
    keyword,
    title: "AI应用开发工程师",
    company: "Fixture",
    location: "广州",
    salary: "10-20K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
    tags: ["全职"],
    description: "负责 AI 应用开发、测试、交付和线上优化。".repeat(10),
    score: 20,
    level: "可投",
    matches: ["AI应用"],
    risks: [],
    qualityTags: [],
    analysis: {
      semanticStatus: "complete",
      recommendation: "apply",
      recommendationSchemaVersion: 2,
      hardBlockers: []
    },
    ...overrides
  };
}

function scopedBatch(scopeKey, keyword) {
  return createBatch(db, "boss", keyword, "scope fixture", {
    profileId: saved.profileId,
    searchPlanId: saved.planId,
    filterSnapshot: {
      execution: { searchScope: { key: scopeKey } }
    }
  });
}

const scopeA = "boss:1:scope-a";
const scopeB = "boss:1:scope-b";
upsertJob(db, eligibleJob("same", "AI应用开发"), scopedBatch(scopeA, "AI应用开发"));
upsertJob(db, eligibleJob("same", "AI应用开发"), scopedBatch(scopeA, "AI应用开发"));
upsertJob(db, eligibleJob("same", "RAG开发"), scopedBatch(scopeA, "RAG开发"));
upsertJob(db, eligibleJob("bad", "AI应用开发", {
  analysis: { semanticStatus: "complete", recommendation: "not_recommended", recommendationSchemaVersion: 2 }
}), scopedBatch(scopeA, "AI应用开发"));
upsertJob(db, eligibleJob("other-scope", "AI应用开发"), scopedBatch(scopeB, "AI应用开发"));
upsertJob(db, eligibleJob("legacy", "AI应用开发"), createBatch(db, "boss", "AI应用开发", "legacy", {
  profileId: saved.profileId,
  searchPlanId: saved.planId
}));

createWorkflowRun(db, {
  profileId: saved.profileId,
  planId: saved.planId,
  localDay: "2026-08-04",
  sequence: 1,
  targetSuccessCount: 1,
  inventoryCount: 0,
  candidateGap: 1,
  scanNeeded: true,
  keywords: [{ word: "RAG开发", priority: "B" }],
  budget: { maxDetailTotal: 1, browserPageBudget: 1 },
  planner: { searchScope: { key: scopeA } }
});

const stats = listScopedKeywordStats(db, {
  profileId: saved.profileId,
  scopeKey: scopeA,
  localDay: "2026-08-04",
  now: "2026-08-04T04:00:00.000Z"
});
assert.deepStrictEqual(stats.get("AI应用开发"), {
  sampleSize: 2,
  eligibleCount: 1,
  usedToday: false
});
assert.deepStrictEqual(stats.get("RAG开发"), {
  sampleSize: 1,
  eligibleCount: 1,
  usedToday: true
});
assert.strictEqual(listScopedKeywordStats(db, {
  profileId: saved.profileId,
  scopeKey: "boss:1:fresh-scope",
  localDay: "2026-08-04",
  now: "2026-08-04T04:00:00.000Z"
}).size, 0);
db.close();

console.log("scoped_keyword_stats_smoke ok");
