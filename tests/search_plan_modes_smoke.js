const assert = require("node:assert");
const {
  SEARCH_PLAN_SCHEMA_VERSION,
  acquisitionModeOf,
  generatedPlatformOf,
  canonicalSearchPlanV2
} = require("../src/core/search_plan_schema");
const { resolveCityScopes } = require("../src/cli");
const { normalizeSearchPlan } = require("../src/core/profile_schema");

const legacy = {
  name: "旧方案",
  cities: ["广州"],
  experience: ["1-3年"],
  jobTypes: ["全职"],
  degrees: ["本科"],
  platform: { site: "boss", salaryLanes: ["10-20K"] },
  keywords: [{ word: "RAG", priority: "A", reason: "核心方向" }],
  directions: ["AI 应用开发"],
  salary: { minK: 12, maxK: 20 },
  scan: { maxCards: 60, maxDetailTotal: 300, browserPageBudget: 90 }
};

assert.strictEqual(acquisitionModeOf(legacy), "inherited");
assert.deepStrictEqual(generatedPlatformOf(legacy), {
  cities: ["广州"],
  salaryLanes: ["10-20K"],
  experience: ["1-3年"],
  jobTypes: ["全职"],
  degrees: ["本科"]
});

const v2 = canonicalSearchPlanV2({ ...legacy, acquisitionMode: "generated" });
assert.strictEqual(v2.schemaVersion, SEARCH_PLAN_SCHEMA_VERSION);
assert.strictEqual(v2.acquisitionMode, "generated");
assert.deepStrictEqual(v2.platform.generated, generatedPlatformOf(legacy));
for (const key of ["cities", "experience", "jobTypes", "degrees", "bossCityCode"]) {
  assert.strictEqual(Object.hasOwn(v2, key), false, `${key} must not be persisted at top level`);
}
assert.strictEqual(Object.hasOwn(v2.platform, "salaryLanes"), false);
assert.throws(() => acquisitionModeOf({ acquisitionMode: "future-mode" }), /采集模式/);
assert.deepStrictEqual(resolveCityScopes({}, { plan: v2 }, { profile: { location: {} } }), [
  { city: "广州", cityCode: "101280100" }
]);
const normalized = normalizeSearchPlan(legacy, { candidate: { city: "深圳" } });
assert.strictEqual(normalized.schemaVersion, SEARCH_PLAN_SCHEMA_VERSION);
assert.strictEqual(normalized.acquisitionMode, "inherited");
assert.deepStrictEqual(normalized.platform.generated, generatedPlatformOf(legacy));
const emptyGenerated = normalizeSearchPlan({
  acquisitionMode: "generated",
  platform: {
    site: "boss",
    generated: { cities: ["广州"], salaryLanes: [], experience: [], jobTypes: [], degrees: [] }
  },
  directions: ["AI 应用开发"],
  keywords: [{ word: "RAG", priority: "A" }, { word: "Agent", priority: "B" }]
});
assert.deepStrictEqual(emptyGenerated.platform.generated, {
  cities: ["广州"], salaryLanes: [], experience: [], jobTypes: [], degrees: []
});

console.log("search_plan_modes_smoke ok");
