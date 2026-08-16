const assert = require("node:assert/strict");
const {
  freezeWorkflowPlan,
  buildGeneratedAcquisitionContext,
  assertCompleteGeneratedContext,
  assertFrozenWorkflowPlan,
  assertAcquisitionContext
} = require("../src/core/workflow_acquisition");

const planRecord = {
  id: 7,
  profileVersionId: 9,
  plan: {
    schemaVersion: 2,
    acquisitionMode: "generated",
    platform: {
      site: "boss",
      generated: {
        cities: ["广州"],
        salaryLanes: ["10-20K"],
        experience: ["1-3年"],
        jobTypes: ["全职"],
        degrees: ["本科"]
      }
    },
    directions: ["AI 应用开发"],
    keywords: [{ word: "RAG", priority: "A", reason: "核心" }],
    salary: { minK: 12, maxK: 20 },
    scan: { maxCards: 60, maxDetailTotal: 300, browserPageBudget: 90 }
  }
};

const context = buildGeneratedAcquisitionContext({
  planRecord,
  catalog: fixtureBossCatalog(),
  matchingCardRevision: "card-r1"
});
assert.strictEqual(context.acquisitionMode, "generated");
assert.deepStrictEqual(context.cityScopes, [{ city: "广州", cityCode: "101280100" }]);
assert.strictEqual(context.searchTemplate.mode, "generated");
assert(context.nativeFilters.catalogVersion);
assert.strictEqual(assertCompleteGeneratedContext(context, { planId: 7 }), context);
assert.strictEqual(assertAcquisitionContext(context, { planId: 7 }), context);

const frozen = { ...freezeWorkflowPlan(planRecord.plan), ...context };
assert.strictEqual(assertFrozenWorkflowPlan(frozen), frozen);
const changed = { ...planRecord.plan, directions: ["后端开发"] };
assert.notStrictEqual(freezeWorkflowPlan(changed).planHash, frozen.planHash);
assert.throws(
  () => assertFrozenWorkflowPlan({ ...frozen, planHash: "tampered" }),
  (error) => error.code === "WORKFLOW_PLAN_SNAPSHOT_INVALID"
);

console.log("workflow_acquisition_smoke ok");

function fixtureBossCatalog() {
  return {
    site: "boss",
    source: "fixture",
    discoveredAt: "2026-08-16T00:00:00.000Z",
    fields: {
      salary: {
        urlParam: "salary",
        selection: "single",
        semantic: "salary_range",
        options: [
          { code: "405", label: "10-20K" },
          { code: "406", label: "20-30K" }
        ]
      },
      experience: {
        urlParam: "experience",
        selection: "multiple",
        semantic: "experience",
        options: [
          { code: "101", label: "经验不限" },
          { code: "104", label: "1-3年" }
        ]
      },
      jobType: {
        urlParam: "jobType",
        selection: "multiple",
        semantic: "choice",
        options: [{ code: "1901", label: "全职" }]
      },
      degree: {
        urlParam: "degree",
        selection: "multiple",
        semantic: "choice",
        options: [{ code: "203", label: "本科" }]
      }
    }
  };
}
