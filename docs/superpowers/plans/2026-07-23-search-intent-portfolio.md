# 搜索意图组合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Replace the flat SearchPlan keyword list with an editable, evidence-backed four-category query portfolio while preserving existing scan limits and legacy plans.

**Architecture:** Keep the portfolio inside the existing search_plans.plan_json record; no database migration is required for the initial schema change. Normalize legacy keywords into an in-memory portfolio, then make every runtime consumer call one canonical projection function. The model proposes structured items, the dashboard confirms them, and scan snapshots preserve the category with the actual phrase.

**Tech Stack:** Node.js CommonJS, SQLite JSON plan records, server-rendered dashboard, Node assert smoke tests, existing model adapter contract.

## Global Constraints

- Work only in the isolated worktree and temporary/test SQLite databases.
- Do not access real BOSS, D:\Guo\ZhiPing\data\jobs.sqlite, or port 8787.
- No career template library, market-driven direction guessing, or silent reduction of confirmed coverage.
- target_role, related_role, scenario, and exploratory are semantic categories; A/B/C remain scan frequency only.
- Preserve existing city, salary lane, dedupe, scan-budget, browser pacing, and inherited-URL behavior.
- The model may propose only evidence-backed items; the user remains the final confirmer.

---

### Task 1: Normalize and project the query portfolio

**Files:**

- Modify: src/core/profile_schema.js
- Modify: src/core/search_plan.js
- Create: tests/search_plan_portfolio_smoke.js
- Modify: tests/run_all.js

**Interfaces:**

- Produces normalizeQueryPortfolio(input, candidateProfile) -> QueryItem[].
- Produces planQueryItems(plan, { enabledOnly = true } = {}) -> QueryItem[].
- Keeps planKeywords(plan) -> string[] as the legacy phrase projection.
- QueryItem = { id, phrase, category, priority, enabled, source, reason, evidence }.

- [ ] **Step 1: Write the failing normalization test**

Create tests/search_plan_portfolio_smoke.js with an AI-application profile and this assertion:

~~~
const plan = normalizeSearchPlan({
  directions: ["AI 应用工程师"],
  queryPortfolio: [
    { phrase: "AI 应用工程师", category: "target_role", priority: "A", enabled: true, source: "user" },
    { phrase: "大模型应用工程师", category: "related_role", priority: "B", enabled: true },
    { phrase: "RAG 工程师", category: "scenario", priority: "C", enabled: true },
    { phrase: "算法工程师", category: "exploratory", priority: "C", enabled: false }
  ]
}, profile);
assert.deepStrictEqual(planQueryItems(plan).map((item) => item.phrase), ["AI 应用工程师", "大模型应用工程师", "RAG 工程师"]);
assert.deepStrictEqual(planKeywords(plan), ["AI 应用工程师", "大模型应用工程师", "RAG 工程师"]);
assert.strictEqual(plan.queryPortfolio[3].category, "exploratory");
~~~

Add one legacy assertion: keywords containing Python 后端 with priority A becomes one enabled migrated item and retains A.

- [ ] **Step 2: Run the test to verify it fails**

Run: node tests/search_plan_portfolio_smoke.js

Expected: failure because planQueryItems and queryPortfolio normalization do not exist.

- [ ] **Step 3: Implement the canonical normalizer and legacy projection**

In src/core/profile_schema.js, add only these legal categories and sources:

~~~
const QUERY_CATEGORIES = new Set(["target_role", "related_role", "scenario", "exploratory"]);
const QUERY_SOURCES = new Set(["model", "user", "migrated"]);
~~~

Implement normalizeQueryPortfolio to prefer a nonempty input.queryPortfolio, otherwise convert legacy keywords. It must normalize a phrase, permit only A/B/C, set enabled to item.enabled !== false, assign a deterministic category-plus-phrase ID, dedupe by category plus lowercased phrase, and cap the list at 18. normalizeSearchPlan stores queryPortfolio and writes its enabled phrase projection to the compatibility keywords field.

In src/core/search_plan.js, add:

~~~
function planQueryItems(plan, { enabledOnly = true } = {}) {
  const items = Array.isArray(plan?.queryPortfolio) && plan.queryPortfolio.length
    ? plan.queryPortfolio
    : legacyPlanQueryItems(plan);
  return items.filter((item) => item.phrase && (!enabledOnly || item.enabled !== false));
}
~~~

Change buildPositiveKeywords, planKeywords, and resolveScanPolicy to use this canonical function and retain category in the returned scan plan and policy snapshot.

- [ ] **Step 4: Run focused regressions**

Run: node tests/search_plan_portfolio_smoke.js && node tests/profile_quality_smoke.js

Expected: both exit 0; daily scanning still excludes C items and legacy keyword tests preserve their result.

- [ ] **Step 5: Commit the normalization slice**

~~~
git add src/core/profile_schema.js src/core/search_plan.js tests/search_plan_portfolio_smoke.js tests/profile_quality_smoke.js tests/run_all.js
git commit -m "feat: normalize search query portfolio"
~~~

### Task 2: Make model recommendation generic and evidence-backed

**Files:**

- Modify: src/core/model_contract.js
- Modify: src/adapters/models/openai_compatible.js
- Modify: src/adapters/models/mock.js
- Modify: tests/model_contract_smoke.js
- Modify: tests/profile_quality_smoke.js

**Interfaces:**

- Extends recommendSearchPlan model output with queryPortfolio.
- Each model item contains phrase, category, priority, reason, and evidence.
- recommendPlanForProfile keeps returning a normalized SearchPlan.

- [ ] **Step 1: Write failing model-contract tests**

Add this case to tests/model_contract_smoke.js:

~~~
const result = validateModelResult("recommendSearchPlan", {
  directions: ["AI 应用开发"],
  queryPortfolio: [{
    phrase: "智能体工程师", category: "related_role", priority: "B",
    reason: "目标名称近似", evidence: ["Agent 项目"]
  }]
});
assert.strictEqual(result.queryPortfolio[0].category, "related_role");
~~~

Also assert a portfolio with only exploratory entries is rejected, and a nontechnical profile can receive target_role, related_role, and scenario suggestions without a Python/RAG requirement.

- [ ] **Step 2: Run the test to verify it fails**

Run: node tests/model_contract_smoke.js

Expected: failure because the current contract ignores queryPortfolio and accepts the flat-only shape.

- [ ] **Step 3: Update contract, prompt, and mock**

Update validateSearchPlan to validate queryPortfolio, with legacy keywords only as a fallback. Require at least one target_role or related_role. A model-proposed scenario or exploratory item requires both a nonempty reason and evidence.

Replace the OpenAI-compatible prompt’s flat keyword requirement with:

~~~
queryPortfolio[{phrase,category(target_role/related_role/scenario/exploratory),priority(A/B/C),reason,evidence[]}]
~~~

The prompt must state that target direction comes from confirmed titles, technical tools are matching evidence rather than default standalone queries, and an exploratory role is not a strong-match claim. Replace the mock’s RAG/Python-only regex selection with deterministic conversion of target titles, project contexts, and skills into the same generic categories.

- [ ] **Step 4: Run model regressions**

Run: node tests/model_contract_smoke.js && node tests/profile_quality_smoke.js && node tests/search_plan_portfolio_smoke.js

Expected: all exit 0; AI fixtures remain valid and nontechnical fixtures do not receive a technical-only fallback.

- [ ] **Step 5: Commit the model slice**

~~~
git add src/core/model_contract.js src/adapters/models/openai_compatible.js src/adapters/models/mock.js tests/model_contract_smoke.js tests/profile_quality_smoke.js tests/search_plan_portfolio_smoke.js
git commit -m "feat: recommend evidence-backed search intents"
~~~

### Task 3: Preserve intent through scan runtime and cache snapshots

**Files:**

- Modify: src/cli.js
- Modify: src/core/search_plan.js
- Modify: src/core/analysis_revision.js
- Modify: tests/scan_execution_smoke.js
- Modify: tests/workflow_planner_smoke.js
- Modify: tests/job_analysis_cache_smoke.js

**Interfaces:**

- resolveScanPolicy(...).keywordPlan contains { phrase, category, priority, ... }.
- Site adapters continue to receive only a phrase string.
- Analysis revision and scan snapshots include category and priority.

- [ ] **Step 1: Write failing policy and cache assertions**

Add assertions that daily returns the target/related categories while broad additionally returns scenario, and that changing a phrase from C to B changes the analysis/scan revision snapshot.

- [ ] **Step 2: Run the tests to verify they fail**

Run: node tests/search_plan_portfolio_smoke.js && node tests/job_analysis_cache_smoke.js

Expected: failure because current snapshots reduce each item to word and priority.

- [ ] **Step 3: Carry metadata to the platform boundary without changing URL syntax**

Replace direct plan.keywords reads in src/cli.js with planQueryItems(plan). Include phrase, category, priority, and source in scanPolicy.snapshot and analysis-revision input. Only map item.phrase to a string where a site adapter forms a URL. Preserve all existing city, salary-lane, browser and dedupe logic.

- [ ] **Step 4: Run scan and workflow regressions**

Run: node tests/scan_execution_smoke.js && node tests/workflow_planner_smoke.js && node tests/job_analysis_cache_smoke.js && node tests/search_plan_portfolio_smoke.js

Expected: all exit 0; no test opens a browser.

- [ ] **Step 5: Commit the runtime slice**

~~~
git add src/cli.js src/core/search_plan.js src/core/analysis_revision.js tests/scan_execution_smoke.js tests/workflow_planner_smoke.js tests/job_analysis_cache_smoke.js tests/search_plan_portfolio_smoke.js
git commit -m "feat: preserve query intent in scan snapshots"
~~~

### Task 4: Replace the flat editor and document user-facing behavior

**Files:**

- Modify: src/dashboard/server.js
- Modify: tests/data_visibility_smoke.js
- Modify: docs/onboarding_workflow.md
- Modify: docs/daily_workflow.md
- Modify: docs/llm_contracts.md
- Modify: tests/run_all.js

**Interfaces:**

- POST /api/plan accepts indexed query phrase, category, priority, enabled and reason fields.
- renderPlanPage shows the four category groups plus resolved daily/broad phrase lists.

- [ ] **Step 1: Write the failing dashboard test**

Save a plan containing all four categories. Assert HTML contains 目标岗位, 相近岗位, 业务场景, 延伸尝试, the item reason, and separate 每日扫描/广泛扫描 summaries. Submit a disabled exploratory item and assert it remains stored but is absent from the scan policy.

- [ ] **Step 2: Run the UI test to verify it fails**

Run: node tests/data_visibility_smoke.js

Expected: failure because the page only renders flat keyword fields.

- [ ] **Step 3: Implement explicit form parsing and rendering**

In handlePlanSave, parse indexed fields into queryPortfolio; do not infer category from arbitrary text. Render phrase, category, A/B/C, enabled switch and reason for every item. Under exploratory items render: 用于扩展搜索，不代表与主目标同等匹配。 Render summaries solely from resolveScanPolicy so the UI has no independent scheduling rule.

- [ ] **Step 4: Run the complete relevant regression set**

Run: node tests/search_plan_portfolio_smoke.js; node tests/model_contract_smoke.js; node tests/profile_quality_smoke.js; node tests/data_visibility_smoke.js; node tests/scan_execution_smoke.js; node tests/workflow_planner_smoke.js; node tests/job_analysis_cache_smoke.js; git diff --check

Expected: every Node command exits 0 and git diff --check is silent.

- [ ] **Step 5: Commit the dashboard and documentation slice**

~~~
git add src/dashboard/server.js tests/data_visibility_smoke.js docs/onboarding_workflow.md docs/daily_workflow.md docs/llm_contracts.md tests/run_all.js
git commit -m "feat: edit search query portfolio"
~~~

## Self-review

- Spec coverage: Tasks 1-2 cover data, compatibility, model evidence and generic categories; Task 3 covers snapshots without an adapter rewrite; Task 4 covers user confirmation, visibility, docs and regressions.
- Placeholder scan: no task contains an unresolved placeholder or unspecified error handling.
- Type consistency: all tasks use QueryItem, normalizeQueryPortfolio, planQueryItems, and queryPortfolio consistently.
