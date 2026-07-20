const assert = require("node:assert/strict");
const {
  chinaLocalDay,
  planWorkflowRun
} = require("../src/core/workflow_run");

function fixture(overrides = {}) {
  return {
    successfulToday: 0,
    completedRuns: 0,
    inventoryCount: 0,
    usedBudget: { details: 0, pages: 0 },
    dailyBudget: { details: 240, pages: 40 },
    keywords: [
      keyword("AI application", "A", 0),
      keyword("LLM application", "A", 1),
      keyword("Agent engineer", "A", 2),
      keyword("Python AI backend", "A", 3),
      keyword("RAG engineer", "B", 4),
      keyword("AI knowledge base", "B", 5)
    ],
    ...overrides
  };
}

function keyword(word, priority, planOrder, overrides = {}) {
  return {
    word,
    priority,
    planOrder,
    usedToday: false,
    sampleSize: 0,
    eligibleCount: 0,
    ...overrides
  };
}

assert.strictEqual(chinaLocalDay("2026-07-20T16:30:00.000Z"), "2026-07-21");
assert.strictEqual(chinaLocalDay("2026-07-20T15:59:59.999Z"), "2026-07-20");

const first = planWorkflowRun(fixture());
assert.strictEqual(first.targetSuccessCount, 35);
assert.strictEqual(first.remainingRunSlots, 2);
assert.deepStrictEqual(first.budget, { maxDetailTotal: 120, browserPageBudget: 20 });
assert.strictEqual(first.selectedKeywords.length, 3);
assert.strictEqual(new Set(first.selectedKeywords.map((item) => item.word)).size, 3);
assert.strictEqual(first.scanNeeded, true);

assert.strictEqual(
  planWorkflowRun(fixture({ successfulToday: 30, completedRuns: 1 })).targetSuccessCount,
  40
);
assert.strictEqual(
  planWorkflowRun(fixture({ successfulToday: 38, completedRuns: 1 })).targetSuccessCount,
  32
);
assert.strictEqual(
  planWorkflowRun(fixture({ completedRuns: 2 })).errorCode,
  "WORKFLOW_DAILY_RUN_LIMIT"
);
assert.strictEqual(planWorkflowRun(fixture({ inventoryCount: 35 })).scanNeeded, false);

const firstWords = new Set(first.selectedKeywords.map((item) => item.word));
const second = planWorkflowRun(fixture({
  completedRuns: 1,
  keywords: fixture().keywords.map((item) => ({ ...item, usedToday: firstWords.has(item.word) }))
}));
assert.strictEqual(second.selectedKeywords.length, 3);
assert(second.selectedKeywords.every((item) => !firstWords.has(item.word)));
assert.strictEqual(second.selectedKeywords.find((item) => item.priority === "B").maxCards, 33);

const yieldOrdered = planWorkflowRun(fixture({
  keywords: [
    keyword("lower known yield", "A", 0, { sampleSize: 40, eligibleCount: 8 }),
    keyword("higher known yield", "B", 1, { sampleSize: 40, eligibleCount: 16 }),
    keyword("unknown A", "A", 2),
    keyword("unknown B", "B", 3)
  ]
}));
assert.strictEqual(yieldOrdered.selectedKeywords[0].word, "higher known yield");
assert.strictEqual(yieldOrdered.selectedKeywords[0].priority, "B");
assert.strictEqual(yieldOrdered.selectedKeywords[1].word, "lower known yield");
assert.strictEqual(yieldOrdered.selectedKeywords[1].priority, "A");

const partiallyUsedBudget = planWorkflowRun(fixture({
  successfulToday: 30,
  completedRuns: 1,
  usedBudget: { details: 115, pages: 18 }
}));
assert.deepStrictEqual(partiallyUsedBudget.budget, { maxDetailTotal: 125, browserPageBudget: 22 });

console.log("workflow_planner_smoke ok");
