# RoleFlow Four-Tier Weighted Decision Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split four-recommendation/three-bucket matching flow with one canonical four-tier product decision, a code-computed 70/30 core/supporting fit axis, shadow-only model advice, versioned compatibility, and severity-aware private acceptance.

**Architecture:** The model remains responsible for occupation-neutral semantic facts. New focused policy and scoring modules compute fit, coverage, matrix tier, and workflow selection deterministically. Existing analysis, storage, workflow, dashboard, and benchmark call sites migrate to canonical `primary/apply/caution/not_recommended` values while legacy JSON and frozen labels are converted only at read boundaries.

**Tech Stack:** Node.js CommonJS, built-in `crypto`, existing OpenAI-compatible model adapter, existing SQLite storage, PowerShell on Windows, existing smoke-test runner, existing private full-chain harness.

## Global Constraints

- Work only on `codex/multi-track-recall-continuation`; do not modify or merge `main`.
- Start implementation from the committed design checkpoint `9c34056fbcab7e783eb7918c76be9da3fb58ea6b`.
- The approved initial policy is core/supporting `0.70/0.30`, match values `1/0.5/0`, fit thresholds `0.80/0.50`, auto-selection evidence coverage `0.60`, and misaligned zero-core rescue thresholds `0.50/0.60`.
- Do not change a weight, threshold, matrix cell, state value, rescue condition, matrix override, batch-selection rule, or model-recommendation mode without first showing affected rows and receiving user approval.
- The model performs no arithmetic. All percentages, coverage, matrix lookup, and workflow selection are deterministic code.
- The first implementation supports model recommendation modes `off` and `shadow`; the default is `shadow`. Do not implement an outcome-affecting `guarded` mode.
- Do not add a model semantic field unless approved tuning proves the current contract cannot express the required distinction and the user approves the field.
- Do not add an occupation-specific keyword dictionary.
- Do not add a model call or iterative model self-check.
- Do not modify `D:\Guo\ZhiPing`, read or write its `data\jobs.sqlite`, access Cookie data, start or operate port 8787, or operate real BOSS pages.
- Private model settings may be read only by the authorized private runner during live acceptance and must never be printed or copied.
- Private outputs remain under `D:\DevData\RoleFlow-private-benchmark`.
- Preserve every earlier private result, including the prepared but superseded v7 root. Never reuse its cache.
- Frozen jobs SHA-256 must remain `612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b`.
- Frozen labels SHA-256 must remain `97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39`.
- The fixed candidate worktree must return to `codex/claude-generic-evidence-matching-live-fix` at `1fc49dac3670a71c720bfcaed943fa29204d93c5` and be clean after every preparation or live run.

---

## File Structure

### New focused files

- `src/core/decision_policy.js`: canonical tiers, approved matrix, numeric policy, policy validation/hash, legacy tier conversion, and batch-selection derivation.
- `src/core/four_tier_decision.js`: pure requirement grouping, fit/coverage arithmetic, fit-band lookup, rescue boundary, and matrix decision.
- `tests/four_tier_decision_smoke.js`: exhaustive policy and pure scoring coverage.
- `scripts/private-policy-replay.js`: private-root-only, no-model candidate-policy comparison that never mutates the approved policy.
- `tests/private_policy_replay_smoke.js`: replay privacy, immutability, and metric tests.

### Existing production files

- `src/core/model_contract.js`: remove `adjacent_misaligned`, validate canonical shadow advice, and preserve strict evidence contracts.
- `src/adapters/models/openai_compatible.js`: make holistic recommendation conditional on `off/shadow`, use canonical tier values, and remove the temporary adjacent direction.
- `src/adapters/models/mock.js`: emit the new contract shape for deterministic tests.
- `src/core/job_analysis.js`: store model shadow advice separately, call the pure decision engine, and apply only approved hard/guard precedence.
- `src/core/analysis_revision.js`: bind model-contract changes separately from decision-policy changes.
- `src/core/storage.js`: normalize legacy analysis JSON on read, expose canonical tier helpers, and stop using three buckets as authoritative decisions.
- `src/core/workflow_inventory.js`: make `primary/apply` default-eligible, `caution` review-only, and `not_recommended` ineligible.
- `src/core/communication_batches.js`: permit explicit manual `caution` selection while rejecting `not_recommended`.
- `src/dashboard/server.js`: render four product groups and derive checkbox defaults from canonical tiers.

### Existing benchmark and harness files

- `tests/job_match_benchmark.js`: convert frozen legacy labels in memory and report model/matrix/final values.
- `scripts/lib/benchmark_metrics.js`: severity-aware metrics and structural row recomputation.
- `scripts/private-full-chain-runner.js`: produce the new row schema and policy binding without exposing private inputs.
- `tests/private_full_chain_runner_smoke.js`: tamper, row-schema, and policy-binding coverage.
- `tests/model_adapter_smoke.js`
- `tests/semantic_pipeline_smoke.js`
- `tests/screening_quality_smoke.js`
- `tests/storage_migration_smoke.js`
- `tests/workflow_inventory_smoke.js`
- `tests/workflow_communication_smoke.js`
- `tests/communication_batch_storage_smoke.js`
- `tests/dashboard_communication_batch_smoke.js`
- `tests/workflow_dashboard_smoke.js`
- `tests/self_check.js`

### Documentation

- `docs/roleflow-terminology.md`
- `docs/roleflow-decision-matrix.md`
- `DEV_HANDOFF.md`
- `docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md`
- `docs/superpowers/plans/2026-08-01-decision-matrix-v2-plan.md`
- `docs/superpowers/plans/2026-08-01-four-tier-weighted-decision-architecture.md`

---

### Task 1: Canonical Policy and Pure Weighted Decision Engine

**Files:**
- Create: `src/core/decision_policy.js`
- Create: `src/core/four_tier_decision.js`
- Create: `tests/four_tier_decision_smoke.js`
- Modify: `tests/self_check.js`

**Interfaces:**
- Produces: `RECOMMENDATION_SCHEMA_VERSION`, `DECISION_POLICY`, `DECISION_POLICY_HASH`, `normalizeRecommendationTier(value, schemaVersion)`, `defaultSelectedForBatch(tier)`, and `assertDecisionPolicy(policy)`.
- Produces: `isExplicitSoftRequirement(item)`,
  `scoreRequirementGroup(items)`,
  `computeWeightedRequirementFit(requirementMatches, policy)`,
  `fitBand(score)`,
  `matrixRecommendationFor(roleAlignment, band, policy)`, and
  `deriveMatrixDecision(analysis, policy)`.
- `deriveMatrixDecision` returns `{ groups, core, supporting, combinedFit, combinedCoverage, fitBand, matrixRecommendation, coverageCapped, rescueApplied, policyVersion, policyHash }`.

- [ ] **Step 1: Write the failing canonical-policy tests**

Add assertions equivalent to:

```javascript
const {
  DECISION_POLICY,
  DECISION_POLICY_HASH,
  normalizeRecommendationTier,
  defaultSelectedForBatch
} = require("../src/core/decision_policy");

assert.strictEqual(DECISION_POLICY.requirementWeights.core, 0.70);
assert.strictEqual(DECISION_POLICY.requirementWeights.supporting, 0.30);
assert.match(DECISION_POLICY_HASH, /^[a-f0-9]{64}$/);
assert.strictEqual(normalizeRecommendationTier("apply", 1), "primary");
assert.strictEqual(normalizeRecommendationTier("review", 1), "caution");
assert.strictEqual(normalizeRecommendationTier("apply", 2), "apply");
assert.strictEqual(defaultSelectedForBatch("primary"), true);
assert.strictEqual(defaultSelectedForBatch("apply"), true);
assert.strictEqual(defaultSelectedForBatch("caution"), false);
assert.strictEqual(defaultSelectedForBatch("not_recommended"), false);
```

- [ ] **Step 2: Write failing tests for all 16 approved matrix cells**

Use the exact matrix:

```javascript
const expected = {
  aligned: {
    fit: "primary",
    mostly_fit: "primary",
    partial_fit: "apply",
    no_fit: "caution"
  },
  mostly_aligned: {
    fit: "primary",
    mostly_fit: "apply",
    partial_fit: "apply",
    no_fit: "caution"
  },
  partially_aligned: {
    fit: "apply",
    mostly_fit: "caution",
    partial_fit: "caution",
    no_fit: "not_recommended"
  },
  misaligned: {
    fit: "caution",
    mostly_fit: "caution",
    partial_fit: "caution",
    no_fit: "not_recommended"
  }
};
```

Loop over all entries and require `deriveMatrixDecision` to return the exact
cell when supplied a synthetic score in the corresponding band.

- [ ] **Step 3: Write failing fit, coverage, empty-group, and rescue tests**

Cover these exact cases:

```javascript
// matched=1, transferable=.5, missing=0, unknown excluded from fit denominator
assert.deepStrictEqual(
  scoreRequirementGroup([
    { state: "matched" },
    { state: "transferable" },
    { state: "missing" },
    { state: "unknown" }
  ]),
  { total: 4, known: 3, fit: 0.5, coverage: 0.75 }
);

// Supporting absence does not cap a complete core-only result.
// No declared core caps a supporting-only result at apply.
// Declared but all-unknown core caps the result at caution.
// Combined coverage below .60 caps at caution.
// misaligned + zero core needs supporting fit >=.50 and coverage >=.60.
// Explicit soft items do not enter either scored pool.
```

- [ ] **Step 4: Run the focused test and verify it fails**

Run:

```powershell
node tests/four_tier_decision_smoke.js
```

Expected: failure because the policy and engine modules do not exist.

- [ ] **Step 5: Implement the immutable policy**

`src/core/decision_policy.js` must define:

```javascript
const RECOMMENDATION_SCHEMA_VERSION = 2;

const DECISION_POLICY = deepFreeze({
  version: "four-tier-weighted-v1",
  recommendationSchemaVersion: RECOMMENDATION_SCHEMA_VERSION,
  recommendationTiers: ["primary", "apply", "caution", "not_recommended"],
  modelRecommendationMode: "shadow",
  requirementWeights: { core: 0.70, supporting: 0.30 },
  stateValues: { matched: 1, transferable: 0.5, missing: 0 },
  fitThresholds: { fit: 0.80, mostlyFit: 0.50 },
  minEvidenceCoverageForAutoSelect: 0.60,
  supportingRescue: { minFit: 0.50, minCoverage: 0.60 },
  defaultBatchSelection: {
    primary: true,
    apply: true,
    caution: false,
    not_recommended: false
  },
  matrix: {
    aligned: {
      fit: "primary",
      mostly_fit: "primary",
      partial_fit: "apply",
      no_fit: "caution"
    },
    mostly_aligned: {
      fit: "primary",
      mostly_fit: "apply",
      partial_fit: "apply",
      no_fit: "caution"
    },
    partially_aligned: {
      fit: "apply",
      mostly_fit: "caution",
      partial_fit: "caution",
      no_fit: "not_recommended"
    },
    misaligned: {
      fit: "caution",
      mostly_fit: "caution",
      partial_fit: "caution",
      no_fit: "not_recommended"
    }
  }
});
```

`assertDecisionPolicy` must reject:

- weights that do not sum to one;
- missing or extra matrix rows/cells;
- unsupported model recommendation mode;
- thresholds outside `[0,1]`;
- a policy that default-selects `caution` or `not_recommended`.

Hash a stable key-sorted serialization with SHA-256.

- [ ] **Step 6: Implement pure scoring**

`src/core/four_tier_decision.js` must:

- classify `foundation || central || indispensable` as core;
- use the exported `isExplicitSoftRequirement` helper for the existing
  occupation-neutral soft/bonus normalization;
- classify remaining requirements as supporting;
- score known states and compute coverage separately;
- avoid divide-by-zero;
- apply the approved 70/30 formula;
- cap incomplete evidence at `caution`;
- enforce the approved supporting rescue boundary;
- return diagnostics without mutating `analysis`.

- [ ] **Step 7: Run the focused test**

Run:

```powershell
node tests/four_tier_decision_smoke.js
```

Expected: `four_tier_decision_smoke ok`.

- [ ] **Step 8: Register the test and run the offline suite**

Run:

```powershell
npm.cmd test
```

Expected: all existing checks plus `four_tier_decision_smoke` pass.

- [ ] **Step 9: Commit the pure engine checkpoint**

```powershell
git add -- src/core/decision_policy.js src/core/four_tier_decision.js tests/four_tier_decision_smoke.js tests/self_check.js
git commit -m "feat: add weighted four-tier decision engine"
git push
```

---

### Task 2: Model Contract and Shadow Advice

**Files:**
- Modify: `src/core/model_contract.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/adapters/models/mock.js`
- Modify: `tests/model_adapter_smoke.js`
- Modify: `tests/semantic_pipeline_smoke.js`

**Interfaces:**
- Consumes: `DECISION_POLICY.modelRecommendationMode`.
- Produces model match facts with `roleAlignment` in
  `aligned/mostly_aligned/partially_aligned/misaligned/insufficient_evidence`.
- Produces optional canonical `modelRecommendation` only in `shadow`.
- Does not emit or accept `adjacent_misaligned` in the new schema.

- [ ] **Step 1: Add failing direction-contract tests**

Add tests that require:

```javascript
const invalidAdjacent = structuredClone(validCompleteMatchDecision);
invalidAdjacent.roleAlignment = "adjacent_misaligned";
assert.throws(
  () => validateModelResult("matchJob", invalidAdjacent),
  /roleAlignment/
);
```

In the test, define `validCompleteMatchDecision` as the existing complete,
passing multi-track decision fixture before cloning it. Retain positive tests
for strict `partially_aligned` and `misaligned` evidence binding.

- [ ] **Step 2: Add failing shadow/off adapter tests**

For `shadow`, assert that the request contract:

- lists canonical `primary/apply/caution/not_recommended`;
- requires `modelRecommendation`;
- contains no `adjacent_misaligned`;
- contains no arithmetic instructions for 70/30, percentages, or matrix cells.

For `off`, assert that `modelRecommendation` is absent from the requested
schema and prompt.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: failures against the current adjacent state and legacy
recommendation values.

- [ ] **Step 4: Update the model contract**

Implement an explicit schema branch:

```javascript
function matchJobContract({ modelRecommendationMode = "shadow" } = {}) {
  const properties = {
    roleAlignment: { enum: [
      "aligned",
      "mostly_aligned",
      "partially_aligned",
      "misaligned",
      "insufficient_evidence"
    ] }
  };
  if (modelRecommendationMode === "shadow") {
    properties.modelRecommendation = {
      enum: ["primary", "apply", "caution", "not_recommended"]
    };
  }
  return properties;
}
```

Keep current evidence validation and strict direction-gap validation. Remove
only the temporary adjacent-state branches.

- [ ] **Step 5: Shorten and condition the adapter prompt**

The prompt must say:

- classify semantic facts;
- do not calculate scores;
- use `partially_aligned` for substantive adjacent-role overlap;
- use `misaligned` when main work object/action/deliverable differs and overlap
  is only generic;
- emit canonical holistic advice only in `shadow`.

Do not add occupation examples or another model request.

- [ ] **Step 6: Update mock output**

The mock adapter must emit schema-version-2 facts and canonical shadow advice
without changing call count.

- [ ] **Step 7: Run focused tests**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: both pass.

- [ ] **Step 8: Run the full offline suite**

Run:

```powershell
npm.cmd test
```

Expected: all registered checks pass.

- [ ] **Step 9: Commit the model-contract checkpoint**

```powershell
git add -- src/core/model_contract.js src/adapters/models/openai_compatible.js src/adapters/models/mock.js tests/model_adapter_smoke.js tests/semantic_pipeline_smoke.js
git commit -m "refactor: separate shadow advice from model facts"
git push
```

---

### Task 3: Integrate the Four-Tier Engine into Job Analysis

**Files:**
- Modify: `src/core/job_analysis.js`
- Modify: `src/core/analysis_revision.js`
- Modify: `tests/screening_quality_smoke.js`
- Modify: `tests/semantic_pipeline_smoke.js`

**Interfaces:**
- Consumes: `deriveMatrixDecision(analysis, DECISION_POLICY)`.
- Produces analysis JSON with
  `recommendationSchemaVersion`, `modelRecommendation`,
  `matrixRecommendation`, `finalRecommendation`, `decisionPolicyVersion`,
  `decisionPolicyHash`, fit/coverage diagnostics, and existing evidence.
- Keeps `semanticStatus` as the operational analysis status.

- [ ] **Step 1: Add failing compact-analysis schema tests**

Require a complete analysis to include:

```javascript
assert.strictEqual(result.recommendationSchemaVersion, 2);
assert.strictEqual(result.modelRecommendation, "apply");
assert.ok(["primary", "apply", "caution", "not_recommended"].includes(result.matrixRecommendation));
assert.ok(["primary", "apply", "caution", "not_recommended"].includes(result.finalRecommendation));
assert.match(result.decisionPolicyHash, /^[a-f0-9]{64}$/);
assert.strictEqual(Object.hasOwn(result, "recommendation"), false);
```

- [ ] **Step 2: Add failing precedence tests**

Cover:

- verified gate `blocked` -> `not_recommended`;
- verified severe safety risk -> `not_recommended`;
- experience stretch: `primary -> apply`;
- indispensable transferable-only: `primary -> apply`;
- material risk: maximum `caution`;
- missing either-side total evidence: complete result maximum `caution` plus
  retry/review reason;
- count of ordinary non-core missing items does not cause a second downgrade;
- shadow advice never changes `finalRecommendation`.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```powershell
node tests/screening_quality_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: failures because analysis still writes legacy `recommendation` and
uses legacy rule guards.

- [ ] **Step 4: Integrate the pure engine**

Inside `compactAnalysis`:

```javascript
const matrix = deriveMatrixDecision(baseAnalysis, DECISION_POLICY);
const result = {
  ...baseAnalysis,
  recommendationSchemaVersion: RECOMMENDATION_SCHEMA_VERSION,
  modelRecommendation: DECISION_POLICY.modelRecommendationMode === "shadow"
    ? decision.modelRecommendation
    : null,
  matrixRecommendation: matrix.matrixRecommendation,
  finalRecommendation: matrix.matrixRecommendation,
  decisionPolicyVersion: matrix.policyVersion,
  decisionPolicyHash: matrix.policyHash,
  requirementFit: {
    core: matrix.core,
    supporting: matrix.supporting,
    combinedFit: matrix.combinedFit,
    combinedCoverage: matrix.combinedCoverage,
    band: matrix.fitBand
  }
};
```

Apply approved guards to `finalRecommendation`, never to shadow advice.

- [ ] **Step 5: Remove duplicate ordinary-missing downgrade**

Delete the count-based non-central missing guard from production decision
precedence. Preserve soft-item normalization used by requirement grouping.

- [ ] **Step 6: Separate revision invalidation**

Advance the model pipeline revision for the contract/prompt change and include
`DECISION_POLICY_HASH` in decision revision metadata. A policy-only change
must invalidate deterministic decisions but must not force a new semantic
model response.

- [ ] **Step 7: Run focused and full tests**

Run:

```powershell
node tests/screening_quality_smoke.js
node tests/semantic_pipeline_smoke.js
npm.cmd test
```

Expected: all pass.

- [ ] **Step 8: Commit the analysis checkpoint**

```powershell
git add -- src/core/job_analysis.js src/core/analysis_revision.js tests/screening_quality_smoke.js tests/semantic_pipeline_smoke.js
git commit -m "feat: produce canonical four-tier job decisions"
git push
```

---

### Task 4: Legacy Read Compatibility and Canonical Storage Access

**Files:**
- Modify: `src/core/storage.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/data_visibility_smoke.js`

**Interfaces:**
- Consumes: `normalizeRecommendationTier`, `defaultSelectedForBatch`.
- Produces: `normalizeStoredAnalysis(analysis)`, `decisionTier(job)`, and a
  deprecated read-only `decisionBucket(job)` compatibility wrapper.
- Does not add or migrate a database column; new values remain inside
  versioned `analysis_json`.

- [ ] **Step 1: Add failing legacy normalization tests**

Cover exactly:

```javascript
assert.strictEqual(normalizeStoredAnalysis({ recommendation: "apply" }).finalRecommendation, "primary");
assert.strictEqual(normalizeStoredAnalysis({ recommendation: "caution" }).finalRecommendation, "apply");
assert.strictEqual(normalizeStoredAnalysis({ recommendation: "review" }).finalRecommendation, "caution");
assert.strictEqual(normalizeStoredAnalysis({ recommendation: "skip" }).finalRecommendation, "not_recommended");
assert.strictEqual(
  normalizeStoredAnalysis({
    recommendationSchemaVersion: 2,
    finalRecommendation: "apply"
  }).finalRecommendation,
  "apply"
);
```

- [ ] **Step 2: Add failing no-migration tests**

Open a legacy fixture database and assert:

- no four-tier column is added;
- raw historical `analysis_json` remains byte-for-byte unchanged after read;
- returned job objects expose normalized canonical analysis;
- new upserts write schema-version-2 JSON.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```powershell
node tests/storage_migration_smoke.js
node tests/data_visibility_smoke.js
```

Expected: failures because current readers expose legacy values directly.

- [ ] **Step 4: Implement read-boundary normalization**

Implement:

```javascript
function normalizeStoredAnalysis(input = {}) {
  const analysis = { ...input };
  if (Number(analysis.recommendationSchemaVersion) === 2) return analysis;
  return {
    ...analysis,
    recommendationSchemaVersion: 2,
    modelRecommendation: null,
    matrixRecommendation: normalizeRecommendationTier(analysis.recommendation, 1),
    finalRecommendation: normalizeRecommendationTier(analysis.recommendation, 1),
    legacyRecommendation: analysis.recommendation || ""
  };
}
```

Use it only after parsing `analysis_json`. Do not write the normalized object
back during read.

- [ ] **Step 5: Add canonical tier access**

Implement `decisionTier(job)` for completed analysis and operational gate
states. Keep `decisionBucket` only as a documented compatibility projection
for unported external readers; no new product call site may use it after Task
5.

- [ ] **Step 6: Run focused and full tests**

Run:

```powershell
node tests/storage_migration_smoke.js
node tests/data_visibility_smoke.js
npm.cmd test
```

Expected: all pass and no live database is opened.

- [ ] **Step 7: Commit storage compatibility**

```powershell
git add -- src/core/storage.js tests/storage_migration_smoke.js tests/data_visibility_smoke.js
git commit -m "refactor: normalize legacy recommendations on read"
git push
```

---

### Task 5: Four-Tier Workflow, Communication Selection, and Dashboard

**Files:**
- Modify: `src/core/workflow_inventory.js`
- Modify: `src/core/communication_batches.js`
- Modify: `src/dashboard/server.js`
- Modify: `tests/workflow_inventory_smoke.js`
- Modify: `tests/workflow_communication_smoke.js`
- Modify: `tests/communication_batch_storage_smoke.js`
- Modify: `tests/dashboard_communication_batch_smoke.js`
- Modify: `tests/workflow_dashboard_smoke.js`

**Interfaces:**
- Consumes: canonical `decisionTier(job)` and
  `defaultSelectedForBatch(tier)`.
- Produces default inventory from `primary/apply`, a review inventory
  containing `caution`, and batch validation that rejects
  `not_recommended`.

- [ ] **Step 1: Add failing workflow-tier tests**

Require:

```javascript
assert.deepStrictEqual(workflowEligibility(primaryJob), {
  eligible: true,
  tier: "primary",
  reasonCode: ""
});
assert.deepStrictEqual(workflowEligibility(applyJob), {
  eligible: true,
  tier: "apply",
  reasonCode: ""
});
assert.strictEqual(workflowEligibility(cautionJob).eligible, false);
assert.strictEqual(workflowEligibility(cautionJob).reasonCode, "WORKFLOW_DECISION_CAUTION");
assert.strictEqual(workflowEligibility(notRecommendedJob).eligible, false);
```

- [ ] **Step 2: Add failing communication-batch tests**

Cover:

- default candidate list selects `primary` and `apply`;
- `caution` is unselected by default;
- an explicitly supplied, user-selected `caution` job may enter an immutable
  draft snapshot;
- `not_recommended` is rejected even when supplied;
- no communication action is executed by the test.

- [ ] **Step 3: Add failing dashboard tests**

Require four Chinese labels and checkbox behavior:

```text
主投 -> checked
可投 -> checked
慎投 -> unchecked but enabled
不推荐 -> unchecked and disabled/absent from batch candidate list
```

Assert that `talk` and `backup` are not rendered as authoritative product
groups.

- [ ] **Step 4: Run focused tests and verify failure**

Run:

```powershell
node tests/workflow_inventory_smoke.js
node tests/workflow_communication_smoke.js
node tests/communication_batch_storage_smoke.js
node tests/dashboard_communication_batch_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: failures against current bucket eligibility and labels.

- [ ] **Step 5: Migrate product call sites**

Replace product decisions based on `decisionBucket` with canonical tiers.
Keep activity, detail, risk-control, application-state, and communication-state
guards unchanged.

- [ ] **Step 6: Implement explicit caution selection**

`createCommunicationBatch` must distinguish:

```javascript
const automaticallySelected = ["primary", "apply"].includes(tier);
const manuallyAllowed = tier === "caution" && selectedJobIds.has(job.id);
if (!automaticallySelected && !manuallyAllowed) reject(job);
```

Do not weaken immutable snapshot, identity verification, or communication
safety checks.

- [ ] **Step 7: Render canonical groups**

Dashboard grouping and checkbox defaults derive from
`finalRecommendation`. Technical failure remains a separate retry state.

- [ ] **Step 8: Run focused and full tests**

Run:

```powershell
node tests/workflow_inventory_smoke.js
node tests/workflow_communication_smoke.js
node tests/communication_batch_storage_smoke.js
node tests/dashboard_communication_batch_smoke.js
node tests/workflow_dashboard_smoke.js
npm.cmd test
```

Expected: all pass.

- [ ] **Step 9: Commit workflow migration**

```powershell
git add -- src/core/workflow_inventory.js src/core/communication_batches.js src/dashboard/server.js tests/workflow_inventory_smoke.js tests/workflow_communication_smoke.js tests/communication_batch_storage_smoke.js tests/dashboard_communication_batch_smoke.js tests/workflow_dashboard_smoke.js
git commit -m "feat: unify four-tier communication workflow"
git push
```

---

### Task 6: Severity-Aware Benchmark and Private Harness

**Files:**
- Modify: `scripts/lib/benchmark_metrics.js`
- Modify: `scripts/private-full-chain-runner.js`
- Modify: `tests/job_match_benchmark.js`
- Modify: `tests/private_full_chain_runner_smoke.js`

**Interfaces:**
- Produces `normalizeReviewedTier`, `recommendationDeviationSeverity`, and
  new row-derived metrics.
- Every row contains reviewed, shadow, matrix, final, fit/coverage, policy,
  workflow-selection, status, and severity fields.
- Frozen label files are never rewritten.

- [ ] **Step 1: Add failing legacy-label conversion tests**

Require in-memory mapping:

```javascript
assert.strictEqual(normalizeReviewedTier("apply"), "primary");
assert.strictEqual(normalizeReviewedTier("caution"), "apply");
assert.strictEqual(normalizeReviewedTier("review"), "caution");
assert.strictEqual(normalizeReviewedTier("skip"), "not_recommended");
```

- [ ] **Step 2: Add failing severity tests**

Require:

```javascript
assert.strictEqual(recommendationDeviationSeverity("primary", "apply"), "light");
assert.strictEqual(recommendationDeviationSeverity("apply", "caution"), "medium");
assert.strictEqual(recommendationDeviationSeverity("caution", "not_recommended"), "medium");
assert.strictEqual(recommendationDeviationSeverity("not_recommended", "caution"), "medium");
assert.strictEqual(recommendationDeviationSeverity("not_recommended", "apply"), "severe");
assert.strictEqual(recommendationDeviationSeverity("apply", "not_recommended"), "severe");
```

- [ ] **Step 3: Add failing structural row tests**

Require each completed row to contain:

```text
expectedRecommendation
shadowRecommendation
matrixRecommendation
actualRecommendation
roleAlignment
coreFit/coreCoverage
supportingFit/supportingCoverage
combinedFit/combinedCoverage
decisionPolicyVersion/decisionPolicyHash
defaultSelectedForBatch
deviationSeverity
```

Require failed/retry rows to have no actual recommendation and no default
selection.

- [ ] **Step 4: Add failing aggregate metric tests**

Derive, do not trust:

```text
exactRecommendationMatches
shadowRecommendationMatches
lightDeviation
mediumDeviation
severeDeviation
unsafeAutoSelection
lostAutoOpportunity
defaultSelectionError
failed/stale/pending/partial
```

Row `pass` means structural validity and no severe product deviation. Exact
four-tier agreement remains a separately reported metric.

- [ ] **Step 5: Run focused tests and verify failure**

Run:

```powershell
node tests/job_match_benchmark.js
node tests/private_full_chain_runner_smoke.js
```

Expected: failures against legacy recommendation/bucket rows.

- [ ] **Step 6: Implement canonical benchmark rows**

Remove bucket accuracy from pass computation. A compatibility bucket may
remain in a legacy report section but cannot be authoritative.

The private runner must bind `decisionPolicyVersion` and
`decisionPolicyHash` into the manifest/report and recompute all summary fields
from rows.

- [ ] **Step 7: Preserve privacy and tamper checks**

Extend existing tests so policy fields, recommendation fields, and summary
fields fail closed when tampered. Keep v3 portability single-read/hash-and-use
behavior and all secret-redaction assertions.

- [ ] **Step 8: Run focused and full tests**

Run:

```powershell
node tests/job_match_benchmark.js
node tests/private_full_chain_runner_smoke.js
npm.cmd test
```

Expected: all pass.

- [ ] **Step 9: Commit benchmark migration**

```powershell
git add -- scripts/lib/benchmark_metrics.js scripts/private-full-chain-runner.js tests/job_match_benchmark.js tests/private_full_chain_runner_smoke.js
git commit -m "test: report four-tier benchmark severity"
git push
```

---

### Task 7: Private Offline Policy Replay

**Files:**
- Create: `scripts/private-policy-replay.js`
- Create: `tests/private_policy_replay_smoke.js`
- Modify: `tests/self_check.js`

**Interfaces:**
- Consumes a private root containing validated semantic analysis artifacts.
- Produces a new private report only under that root.
- Accepts candidate core weights but never imports them into production
  policy.
- Performs no model call and reads no model settings.

- [ ] **Step 1: Add failing CLI-gate tests**

Require:

- output must be absent before execution;
- output must resolve under the declared private root;
- source analysis must be contract-valid and policy-bound;
- candidate weights must be one of `0.80/0.75/0.70/0.65/0.60`;
- supporting weight is exactly `1 - coreWeight`;
- no source artifact is modified;
- the approved policy module remains byte-for-byte unchanged.

- [ ] **Step 2: Add failing candidate-comparison tests**

For a synthetic frozen analysis set, require a report shaped as:

```json
{
  "approvedPolicy": { "core": 0.70, "supporting": 0.30 },
  "candidates": [
    {
      "core": 0.80,
      "supporting": 0.20,
      "exact": 0,
      "light": 0,
      "medium": 0,
      "severe": 0,
      "affectedRows": []
    }
  ]
}
```

Require affected rows to include before/after tiers and reviewed expectation.

- [ ] **Step 3: Run the focused test and verify failure**

Run:

```powershell
node tests/private_policy_replay_smoke.js
```

Expected: failure because the replay script does not exist.

- [ ] **Step 4: Implement replay with production scoring**

The script must import `deriveMatrixDecision` and clone a candidate policy in
memory:

```javascript
const candidatePolicy = {
  ...DECISION_POLICY,
  requirementWeights: {
    core: coreWeight,
    supporting: 1 - coreWeight
  }
};
```

It may compare candidates but must not export, write, or activate them as the
approved policy.

- [ ] **Step 5: Register and run tests**

Run:

```powershell
node tests/private_policy_replay_smoke.js
npm.cmd test
```

Expected: all pass.

- [ ] **Step 6: Commit replay tooling**

```powershell
git add -- scripts/private-policy-replay.js tests/private_policy_replay_smoke.js tests/self_check.js
git commit -m "test: add private four-tier policy replay"
git push
```

---

### Task 8: Documentation, Full Regression, Independent Review, and Baseline Harness Sync

**Files:**
- Modify: `docs/roleflow-terminology.md`
- Modify: `docs/roleflow-decision-matrix.md`
- Modify: `DEV_HANDOFF.md`
- Modify: `docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md`
- Modify: `docs/superpowers/plans/2026-08-01-decision-matrix-v2-plan.md`
- Modify: `docs/superpowers/plans/2026-08-01-four-tier-weighted-decision-architecture.md`

**Interfaces:**
- Produces one reviewed product commit whose strict descendant is a docs-only
  evaluated checkpoint.
- Produces candidate/baseline identical shared harness blobs where required.

- [ ] **Step 1: Update product documentation**

Document:

- canonical four tiers and selection behavior;
- model semantic facts versus code arithmetic;
- 70/30 policy and protected thresholds;
- matrix and evidence coverage;
- shadow-only model advice;
- legacy read conversion;
- severity-aware acceptance;
- current v7 root preserved but not run;
- v8 fresh roots.

- [ ] **Step 2: Run complete verification**

Run:

```powershell
npm.cmd test
git diff --check
```

Expected: all registered offline checks pass and diff check is clean.

- [ ] **Step 3: Request independent read-only review**

The reviewer must report findings first and explicitly evaluate:

- Critical/Important defects;
- all 16 matrix cells;
- no duplicate supporting penalty;
- no divide-by-zero or unknown-as-missing path;
- hard-blocker triple evidence;
- legacy `apply` ambiguity;
- shadow isolation;
- no authoritative three-bucket path;
- caution manual selection and not-recommended rejection;
- benchmark severity recomputation;
- privacy/portability invariants;
- occupation neutrality;
- prompt/call-count growth.

Required terminal result: `Spec PASS` and `Code quality APPROVED`.

- [ ] **Step 4: Fix Important/Critical findings with a failing regression first**

For each blocking finding:

```text
write failing focused test
run and confirm failure
implement minimal fix
run focused test
run npm.cmd test
request re-review
```

Do not change protected policy parameters while fixing code.

- [ ] **Step 5: Commit and push the reviewed product checkpoint**

If review required code changes, stage only the exact product/test files from
Tasks 1-7 that the regression changed:

```powershell
git add -- src/core/decision_policy.js src/core/four_tier_decision.js src/core/model_contract.js src/adapters/models/openai_compatible.js src/adapters/models/mock.js src/core/job_analysis.js src/core/analysis_revision.js src/core/storage.js src/core/workflow_inventory.js src/core/communication_batches.js src/dashboard/server.js scripts/lib/benchmark_metrics.js scripts/private-full-chain-runner.js scripts/private-policy-replay.js tests/four_tier_decision_smoke.js tests/model_adapter_smoke.js tests/semantic_pipeline_smoke.js tests/screening_quality_smoke.js tests/storage_migration_smoke.js tests/data_visibility_smoke.js tests/workflow_inventory_smoke.js tests/workflow_communication_smoke.js tests/communication_batch_storage_smoke.js tests/dashboard_communication_batch_smoke.js tests/workflow_dashboard_smoke.js tests/job_match_benchmark.js tests/private_full_chain_runner_smoke.js tests/private_policy_replay_smoke.js tests/self_check.js
git commit -m "fix: close four-tier review findings"
git push
```

If review required no code change, do not create an empty commit. In both
cases, record the latest non-documentation product SHA with:

```powershell
git rev-parse HEAD
```

- [ ] **Step 6: Mechanically sync shared harness files to baseline**

Baseline worktree:

```text
D:\DevData\RoleFlow-private-benchmark\baseline-worktree-multi-track-recall-v1
```

Copy only reviewed shared harness files required by the new report contract,
run baseline offline tests, commit:

```text
test: mirror four-tier benchmark harness
```

Push the baseline branch and verify candidate/baseline Git blob identity for
each shared file.

- [ ] **Step 7: Commit the docs-only evaluated checkpoint**

Record:

- product SHA;
- baseline harness SHA;
- baseline product `fb0168afce265cf351f03e80f66d9e0f24015887`;
- shared blobs;
- review result;
- verification counts;
- fresh v8 directories.

Commit and push:

```powershell
git add -- DEV_HANDOFF.md docs/roleflow-terminology.md docs/roleflow-decision-matrix.md docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md docs/superpowers/plans/2026-08-01-decision-matrix-v2-plan.md docs/superpowers/plans/2026-08-01-four-tier-weighted-decision-architecture.md
git commit -m "docs: record four-tier evaluated checkpoint"
git push
```

Verify the product commit is a strict ancestor of this evaluated commit.

---

### Task 9: Fresh Private Three-Row and Twenty-Row Acceptance

**Files:**
- Modify after evidence only: `docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md`
- Modify after evidence only: `docs/superpowers/plans/2026-08-01-decision-matrix-v2-plan.md`
- Modify after evidence only: `docs/superpowers/plans/2026-08-01-four-tier-weighted-decision-architecture.md`
- Modify after evidence only: `DEV_HANDOFF.md`

**Interfaces:**
- Consumes the reviewed product/evaluated commits and baseline harness commit.
- Produces immutable private v8 reports and final public documentation only.

- [ ] **Step 1: Re-verify frozen inputs**

Run SHA-256 checks against:

```text
D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730\input\jobs.private.json
D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730\labels\jobs.reviewed.json
```

Stop immediately on any mismatch.

- [ ] **Step 2: Prepare a fresh v8 three-row root**

Use:

```text
D:\DevData\RoleFlow-private-benchmark\multi-track-recall-four-tier-v8-first-3-20260801
```

Require the path to be absent. Copy confirmed evidence and frozen pool files,
create the v3 portability proof, initialize the manifest with the reviewed
product/evaluated commits, and restore the fixed candidate worktree in a
`finally` block.

- [ ] **Step 3: Run exactly the approved three rows**

Use zero-based indices exactly:

```powershell
--diagnostic-indices '4,9,10'
```

Use `Start-Process -Wait` with redirected stdout/stderr. Set only the
previously authorized environment gates inside the wrapper. Never print model
settings.

- [ ] **Step 4: Inspect the three-row report**

Require:

- complete structure/privacy/portability gates;
- no empty, failed, stale, pending, or partial row;
- no severe recommendation deviation;
- correct default selection for all rows;
- reproducible core/supporting/combined arithmetic;
- shadow advice recorded but unable to change final tier;
- fixed candidate worktree restored to its original branch/head and clean.

If a protected policy change appears necessary, preserve the root, show every
affected row and candidate-policy comparison, and request user approval before
changing policy.

- [ ] **Step 5: Prepare a fresh v8 20-row root**

Only after Step 4 passes, use:

```text
D:\DevData\RoleFlow-private-benchmark\multi-track-recall-four-tier-v8-full-20-20260801
```

Require the path to be absent and use a completely fresh cache.

- [ ] **Step 6: Run all 20 rows**

Use the same reviewed commits, policy hash, and authorized live wrapper. Do
not pass diagnostic indices.

- [ ] **Step 7: Audit the 20-row report**

Mandatory:

- all structural/privacy/portability gates pass;
- technical failure counts are zero;
- `not_recommended -> primary/apply` severe deviations are zero;
- `primary/apply -> not_recommended` severe deviations are zero;
- default selection errors are zero;
- no private content or settings appear in public artifacts;
- fixed candidate worktree is restored and clean.

Report exact, shadow, light, and medium results row by row. Medium deviations
do not automatically fail acceptance. Do not change a protected policy merely
to increase exact count.

- [ ] **Step 8: Complete final regression and review**

Run:

```powershell
npm.cmd test
git diff --check
```

Request final independent review. Required result:

```text
Critical 0
Important 0
Spec PASS
Code quality APPROVED
```

- [ ] **Step 9: Record final evidence**

Update the four public docs listed above with:

- product/evaluated/baseline SHAs;
- policy version/hash;
- 3-row result;
- 20-row exact/light/medium/severe counts;
- workflow selection errors;
- shadow comparison;
- review and regression results;
- deferred follow-ups.

Do not copy private evidence into Git.

- [ ] **Step 10: Commit and push final documentation**

```powershell
git add -- DEV_HANDOFF.md docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md docs/superpowers/plans/2026-08-01-decision-matrix-v2-plan.md docs/superpowers/plans/2026-08-01-four-tier-weighted-decision-architecture.md
git commit -m "docs: record four-tier private acceptance"
git push
```

Verify `codex/multi-track-recall-continuation` is pushed and clean. Do not
modify or merge `main`.

---

## Completion Evidence

The work is complete only when all of the following are proven from current
state:

- canonical four-tier product values are used from analysis through workflow;
- three buckets are not authoritative for new decisions;
- code, not the model, performs all arithmetic;
- approved policy values and matrix cells match the specification;
- shadow advice cannot affect the final tier;
- legacy JSON and frozen labels are interpreted safely without bulk migration;
- no severe deviation occurs in the fresh 3-row or 20-row private acceptance;
- default communication selection is correct for every accepted row;
- all privacy, portability, cache, and worktree restoration gates pass;
- full offline regression passes;
- independent review reports no Critical or Important finding;
- continuation and required baseline checkpoints are committed and pushed;
- all old private roots remain preserved.
