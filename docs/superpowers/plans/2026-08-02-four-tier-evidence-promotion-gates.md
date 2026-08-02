# Four-tier Evidence Promotion Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unstable v4.3 heavy-duty-gap recovery rule with profession-neutral evidence promotion gates that retain all confirmed communication jobs and block all confirmed non-communication jobs.

**Architecture:** Keep the user-approved direction-by-requirement matrix and the existing model contract. Extend the deterministic decision layer with a global foundation-missing ceiling, a zero-duty-gap promotion route, a matched-indispensable promotion route, and a confirmed-duty-gap ceiling. Promotion routes may floor a safe result at `apply`, but safety and evidence-coverage ceilings always take precedence.

**Tech Stack:** Node.js CommonJS, built-in `assert`, existing RoleFlow decision policy and smoke-test harnesses, private full-chain runner, SQLite cache replay.

## Global Constraints

- Do not change the user-approved four-tier decision matrix.
- Do not change model prompts, model contract `match-decision-v40`, temperature, thinking mode, provider, or model.
- Do not add repeated model calls or voting.
- Do not add job-title, technology, fixture-index, or AI-application-specific rules.
- Keep `primary` and `apply` selected for communication; keep `caution` and `not_recommended` unselected.
- Safety ceilings must take precedence over promotion floors.
- Do not access BOSS, cookies, port 8787, or `D:\Guo\ZhiPing\data\jobs.sqlite`.
- Private artifacts remain under `D:\DevData\RoleFlow-private-benchmark`.
- Preserve every prior private run directory and use a fresh cache for every new live run.
- Do not modify the user-approved decision matrix without explicit user approval.

---

## File Structure

- Modify `tests/four_tier_decision_smoke.js`: focused regression coverage for the four evidence gates and precedence.
- Modify `src/core/decision_policy.js`: v4.4 policy schema and validation for promotion/ceiling tiers.
- Modify `src/core/four_tier_decision.js`: evidence counts, route readiness, final floor/ceiling application, and observability.
- Modify `tests/four_tier_pipeline_smoke.js`: pipeline version and decision-metric propagation.
- Modify `tests/semantic_pipeline_smoke.js`: semantic pipeline version assertions and persisted revision fixture.
- Modify `src/core/analysis_revision.js`: bump only `decisionRules` to v4.4.
- Modify `docs/roleflow-decision-matrix.md`: explain the v4.4 responsibility gates in beginner-readable Chinese.
- Modify `docs/superpowers/specs/2026-08-01-decision-matrix-v2-design.md`: append v4.4 evidence and review status.
- Modify `docs/superpowers/plans/2026-08-01-decision-matrix-v2-plan.md`: record implementation, product commit, evaluated commit, and acceptance runs.
- Modify `docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md`: record the same evaluated checkpoint and private run directories.
- Modify `docs/superpowers/specs/2026-08-02-four-tier-evidence-promotion-gates-design.md`: change status from approved to implemented after review.

---

### Task 1: Add failing evidence-gate regression tests

**Files:**
- Test: `tests/four_tier_decision_smoke.js`

**Interfaces:**
- Consumes: `deriveMatrixDecision({ roleAlignment, requirementMatches, responsibilityMatches })`.
- Produces: failing assertions for `responsibilityPromotionRoute`, foundation ceiling, confirmed-duty-gap ceiling, and final recommendation.

- [ ] **Step 1: Add a matched-indispensable requirement helper**

Add a helper next to the existing `core`, `supporting`, and `boundCore`
helpers:

```js
function boundIndispensable(state, options = {}) {
  return requirement(state, {
    indispensable: true,
    jdEvidence: "JD：不可缺少要求",
    resumeEvidence: "简历：不可缺少要求证据",
    ...options
  });
}
```

- [ ] **Step 2: Add the global foundation-missing ceiling regression**

```js
const mostlyAlignedMissingFoundation = decision("mostly_aligned", [
  boundCore("missing", { foundation: true }),
  boundCore("matched", { foundation: false, central: true }),
  boundSupporting("matched")
], [
  { id: "D1", state: "matched", jdEvidence: "JD：职责一", resumeEvidence: "简历：职责一" },
  { id: "D2", state: "matched", jdEvidence: "JD：职责二", resumeEvidence: "简历：职责二" }
]);
assert.strictEqual(mostlyAlignedMissingFoundation.matrixRecommendation, "caution");
assert.strictEqual(mostlyAlignedMissingFoundation.responsibilityFoundationMissingCount, 1);
assert.strictEqual(mostlyAlignedMissingFoundation.responsibilityFoundationCeilingApplied, true);
```

- [ ] **Step 3: Add the zero-duty-gap promotion regression**

```js
const zeroDutyGapPromotion = decision("partially_aligned", [
  boundCore("missing", { foundation: false, central: true }),
  boundSupporting("transferable")
], [
  { id: "D1", state: "transferable", jdEvidence: "JD：职责一", resumeEvidence: "简历：可迁移一" },
  { id: "D2", state: "transferable", jdEvidence: "JD：职责二", resumeEvidence: "简历：可迁移二" },
  { id: "D3", state: "transferable", jdEvidence: "JD：职责三", resumeEvidence: "简历：可迁移三" }
]);
assert.strictEqual(zeroDutyGapPromotion.matrixRecommendation, "apply");
assert.strictEqual(zeroDutyGapPromotion.responsibilityPromotionRoute, "zero_duty_gap");
assert.strictEqual(zeroDutyGapPromotion.responsibilityZeroDutyGapPromotionReady, true);
```

- [ ] **Step 4: Add the matched-indispensable promotion regression**

```js
const indispensablePromotion = decision("partially_aligned", [
  boundIndispensable("matched"),
  boundCore("missing", { foundation: false, central: true }),
  boundSupporting("matched")
], [
  { id: "D1", state: "transferable", jdEvidence: "JD：职责一", resumeEvidence: "简历：可迁移一" },
  { id: "D2", state: "transferable", jdEvidence: "JD：职责二", resumeEvidence: "简历：可迁移二" },
  { id: "D3", state: "missing", jdEvidence: "JD：职责三", resumeEvidence: "简历：职责缺口三" },
  { id: "D4", state: "missing", jdEvidence: "JD：职责四", resumeEvidence: "简历：职责缺口四" }
]);
assert.strictEqual(indispensablePromotion.matrixRecommendation, "apply");
assert.strictEqual(indispensablePromotion.responsibilityPromotionRoute, "matched_indispensable");
assert.strictEqual(indispensablePromotion.responsibilityMatchedIndispensableCount, 1);
```

- [ ] **Step 5: Add confirmed-duty-gap and precedence regressions**

```js
const dutyGapWithoutIndispensable = decision("partially_aligned", [
  boundCore("matched", { foundation: false, central: true }),
  boundSupporting("matched")
], [
  { id: "D1", state: "matched", jdEvidence: "JD：职责一", resumeEvidence: "简历：职责一" },
  { id: "D2", state: "transferable", jdEvidence: "JD：职责二", resumeEvidence: "简历：可迁移二" },
  { id: "D3", state: "missing", jdEvidence: "JD：职责三", resumeEvidence: "简历：职责缺口三" }
]);
assert.strictEqual(dutyGapWithoutIndispensable.matrixRecommendation, "caution");
assert.strictEqual(dutyGapWithoutIndispensable.responsibilityConfirmedDutyGapCeilingApplied, true);

const foundationOverridesIndispensable = decision("partially_aligned", [
  boundCore("missing", { foundation: true }),
  boundIndispensable("matched"),
  boundSupporting("matched")
], [
  { id: "D1", state: "transferable", jdEvidence: "JD：职责一", resumeEvidence: "简历：可迁移一" },
  { id: "D2", state: "transferable", jdEvidence: "JD：职责二", resumeEvidence: "简历：可迁移二" }
]);
assert.strictEqual(foundationOverridesIndispensable.matrixRecommendation, "caution");
assert.strictEqual(foundationOverridesIndispensable.responsibilityFoundationCeilingApplied, true);
assert.notStrictEqual(foundationOverridesIndispensable.responsibilityPromotionRoute, "matched_indispensable");
```

- [ ] **Step 6: Add a promotion ceiling regression**

```js
assert.notStrictEqual(zeroDutyGapPromotion.matrixRecommendation, "primary");
assert.notStrictEqual(indispensablePromotion.matrixRecommendation, "primary");
```

- [ ] **Step 7: Run the focused test and confirm RED**

Run:

```powershell
node tests/four_tier_decision_smoke.js
```

Expected: FAIL because v4.3 does not expose the v4.4 route metrics and still
allows the missing-foundation and confirmed-duty-gap cases.

- [ ] **Step 8: Commit the failing tests**

```powershell
git add -- tests/four_tier_decision_smoke.js
git commit -m "test: define evidence promotion gate behavior"
git push
```

---

### Task 2: Implement v4.4 evidence promotion gates

**Files:**
- Modify: `src/core/decision_policy.js`
- Modify: `src/core/four_tier_decision.js`
- Test: `tests/four_tier_decision_smoke.js`

**Interfaces:**
- Consumes: existing normalized requirement and responsibility match arrays.
- Produces: `responsibilityMatchedIndispensableCount`,
  `responsibilityZeroDutyGapPromotionReady`,
  `responsibilityMatchedIndispensablePromotionReady`,
  `responsibilityConfirmedDutyGapCeilingApplied`,
  `responsibilityFoundationCeilingApplied`, and
  `responsibilityPromotionRoute`.

- [ ] **Step 1: Replace the unstable v4.3 policy fields**

In `DECISION_POLICY.responsibilityAlignment.jointFit`, remove:

```js
heavyDutyMissingRatio: 0.50,
minimumCorePositiveForHeavyDutyGap: 2,
heavyDutyRecoveryMinimumRequirementFit: 0.95,
```

Add:

```js
matchedIndispensableStates: ["matched"],
promotionFloor: "apply",
confirmedDutyGapCeiling: "caution",
foundationMissingCeiling: "caution"
```

Keep `promotionThreshold`, `minimumPositiveDutyCount`, existing state weights,
known-count minimum, and coverage minimum unchanged.

- [ ] **Step 2: Update policy validation**

Replace the heavy-gap validation with exact validation:

```js
if (!sameValues(jointFit?.matchedIndispensableStates, ["matched"])) {
  throw new Error("indispensable promotion must require a matched requirement");
}
if (jointFit?.promotionFloor !== "apply") {
  throw new Error("responsibility promotion must stop at apply");
}
if (jointFit?.confirmedDutyGapCeiling !== "caution") {
  throw new Error("an unprotected duty gap must stay outside default batch selection");
}
if (jointFit?.foundationMissingCeiling !== "caution") {
  throw new Error("a missing foundation must stay outside default batch selection");
}
```

Set:

```js
version: "four-tier-weighted-v4.4"
```

- [ ] **Step 3: Compute evidence-bound route inputs**

In `resolveRoleAlignmentForDecision`, compute:

```js
const responsibilityMatchedIndispensableCount = evidenceBoundCore
  .filter((item) => (
    item?.indispensable === true
      && jointPolicy.matchedIndispensableStates.includes(item?.state)
  ))
  .length;

const responsibilityBasePromotionEvidenceReady =
  responsibility.known >= policy.responsibilityAlignment.minimumKnownCount
    && responsibility.positive >= jointPolicy.minimumPositiveDutyCount
    && responsibility.coverage >= policy.responsibilityAlignment.minimumKnownCoverage;

const responsibilityZeroDutyGapPromotionReady =
  reportedRoleAlignment === "partially_aligned"
    && responsibility.total > 0
    && responsibilityBasePromotionEvidenceReady
    && responsibility.missing === 0;

const responsibilityMatchedIndispensablePromotionReady =
  reportedRoleAlignment === "partially_aligned"
    && responsibility.total > 0
    && responsibilityBasePromotionEvidenceReady
    && responsibility.missing > 0
    && responsibilityMatchedIndispensableCount > 0
    && responsibilityRequirementJointFit != null
    && responsibilityRequirementJointFit >= jointPolicy.promotionThreshold;

const responsibilityPromotionRoute = responsibilityFoundationMissingCount > 0
  ? "none"
  : responsibilityZeroDutyGapPromotionReady
    ? "zero_duty_gap"
    : responsibilityMatchedIndispensablePromotionReady
      ? "matched_indispensable"
      : "none";

const responsibilityConfirmedDutyGapCeilingApplied =
  reportedRoleAlignment === "partially_aligned"
    && responsibility.missing > 0
    && responsibilityMatchedIndispensablePromotionReady === false;
```

- [ ] **Step 4: Replace the heavy-gap alignment branch**

Use the route metrics instead of `responsibilityHeavyDutyGap`:

```js
const responsibilityJointPromotionReady = responsibilityPromotionRoute !== "none";

if (reportedRoleAlignment === "partially_aligned") {
  if (responsibilityFoundationMissingCount > 0
    || responsibilityConfirmedDutyGapCeilingApplied) {
    alignmentConsistencyAdjusted = true;
    alignmentConsistencyReason = responsibilityFoundationMissingCount > 0
      ? "foundation_requirement_gap"
      : "confirmed_duty_gap_without_matched_indispensable";
    alignmentAdjustmentSource = "responsibility_requirement_evidence";
    recommendationCeiling = responsibilityFoundationMissingCount > 0
      ? jointPolicy.foundationMissingCeiling
      : jointPolicy.confirmedDutyGapCeiling;
  } else if (responsibility.total > 0 && !responsibilityJointPromotionReady) {
    alignmentConsistencyAdjusted = true;
    alignmentConsistencyReason = "primary_duty_evidence_below_promotion_gate";
    alignmentAdjustmentSource = "responsibility_requirement_evidence";
    recommendationCeiling = policy.responsibilityAlignment.contradictionCeiling;
  }
}
```

When a route is ready, preserve the existing effective-role-alignment
promotion to `mostly_aligned`, but set the reason to:

```js
alignmentConsistencyReason = responsibilityPromotionRoute === "zero_duty_gap"
  ? "zero_duty_gap"
  : "matched_indispensable";
```

- [ ] **Step 5: Add final floor and ceiling helpers**

Add a local helper:

```js
function floorRecommendationTier(recommendation, floor) {
  const rank = {
    not_recommended: 0,
    caution: 1,
    apply: 2,
    primary: 3
  };
  return rank[recommendation] < rank[floor] ? floor : recommendation;
}
```

After the existing no-core, unknown-core, and coverage caps:

```js
const responsibilityPromotionFloorApplied =
  alignment.responsibilityPromotionRoute !== "none"
    && !coverageCapped
    && !coreUnknownCapApplied
    && alignment.responsibilityFoundationMissingCount === 0
    && !alignment.responsibilityConfirmedDutyGapCeilingApplied
    && recommendation === "caution";

if (responsibilityPromotionFloorApplied) {
  recommendation = floorRecommendationTier(
    recommendation,
    policy.responsibilityAlignment.jointFit.promotionFloor
  );
}

const responsibilityFoundationCeilingApplied =
  alignment.responsibilityFoundationMissingCount > 0
    && ["primary", "apply"].includes(recommendation);
if (alignment.responsibilityFoundationMissingCount > 0) {
  recommendation = capRecommendationTier(
    recommendation,
    policy.responsibilityAlignment.jointFit.foundationMissingCeiling
  );
}
```

The confirmed-duty-gap ceiling remains represented by the alignment ceiling
and must not be bypassed by the promotion floor.

- [ ] **Step 6: Return stable observability fields**

Return the new counts, booleans, and route enum from
`resolveRoleAlignmentForDecision` and `deriveMatrixDecision`. Do not include
requirement text or resume evidence.

- [ ] **Step 7: Run the focused test and confirm GREEN**

Run:

```powershell
node tests/four_tier_decision_smoke.js
```

Expected: `four_tier_decision_smoke ok`.

- [ ] **Step 8: Commit and push the decision implementation**

```powershell
git add -- src/core/decision_policy.js src/core/four_tier_decision.js tests/four_tier_decision_smoke.js
git commit -m "feat: stabilize evidence promotion gates"
git push
```

---

### Task 3: Propagate v4.4 pipeline version and metrics

**Files:**
- Modify: `tests/four_tier_pipeline_smoke.js`
- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `src/core/analysis_revision.js`

**Interfaces:**
- Consumes: v4.4 decision metrics from Task 2.
- Produces: persisted revision invalidation and compact-analysis metric coverage.

- [ ] **Step 1: Change version assertions first**

Update test expectations:

```js
assert.equal(PIPELINE_VERSIONS.decisionRules, "four-tier-weighted-v4.4");
```

and:

```js
assert.strictEqual(PIPELINE_VERSIONS.decisionRules, "four-tier-weighted-v4.4");
```

Update the persisted semantic fixture from:

```js
decisionRules: "four-tier-weighted-v4.3"
```

to:

```js
decisionRules: "four-tier-weighted-v4.4"
```

- [ ] **Step 2: Assert compact metric propagation**

Add assertions for:

```js
assert.equal(result.decisionMetrics.responsibilityPromotionRoute, "zero_duty_gap");
assert.equal(result.decisionMetrics.responsibilityZeroDutyGapPromotionReady, true);
assert.equal(result.decisionMetrics.responsibilityMatchedIndispensablePromotionReady, false);
assert.equal(result.decisionMetrics.responsibilityFoundationCeilingApplied, false);
```

Use a fixture whose responsibilities are all `transferable` and whose role
alignment is `partially_aligned`.

- [ ] **Step 3: Run the pipeline tests and confirm RED**

Run:

```powershell
node tests/four_tier_pipeline_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: FAIL because `PIPELINE_VERSIONS.decisionRules` is still v4.3.

- [ ] **Step 4: Bump only the decision-rules version**

In `src/core/analysis_revision.js`:

```js
const PIPELINE_VERSIONS = Object.freeze({
  understandJob: "job-understanding-v18",
  matchJob: "match-decision-v40",
  decisionRules: "four-tier-weighted-v4.4",
  communication: "communication-v2"
});
```

- [ ] **Step 5: Run the pipeline tests and confirm GREEN**

Run:

```powershell
node tests/four_tier_pipeline_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected:

```text
four_tier_pipeline_smoke ok
semantic_pipeline_smoke ok
```

- [ ] **Step 6: Commit and push the pipeline checkpoint**

```powershell
git add -- src/core/analysis_revision.js tests/four_tier_pipeline_smoke.js tests/semantic_pipeline_smoke.js
git commit -m "chore: advance evidence decision rules to v4.4"
git push
```

---

### Task 4: Run offline regression and frozen-cache replay

**Files:**
- No production file changes.
- Private replay input:
  `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-3-full-20-v3-20260802\runs\candidate\model-cache.sqlite`
- Private replay result:
  `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-4-offline-replay-20260802\replay-summary.json`

**Interfaces:**
- Consumes: v4.4 decision implementation and frozen v4.3 model outputs.
- Produces: offline proof that only the five known behavioral failures change.

- [ ] **Step 1: Run focused and generic tests**

Run:

```powershell
node tests/four_tier_decision_smoke.js
node tests/four_tier_pipeline_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/private_full_chain_runner_smoke.js
```

Expected: every command exits zero and prints its `ok` marker.

- [ ] **Step 2: Run the full offline suite**

Run:

```powershell
npm.cmd test
```

Expected: all configured offline checks pass. Any pre-existing failure must be
reported separately and must not be described as caused by v4.4 without
evidence.

- [ ] **Step 3: Replay the frozen cache**

Create a new private output directory. Read the 20 cached `matchJob` payloads,
run each through `deriveMatrixDecision`, and write only:

```json
{
  "sourceRun": "four-tier-weighted-v4-3-full-20-v3-20260802",
  "decisionRules": "four-tier-weighted-v4.4",
  "expectedCommunicate": 10,
  "retained": 10,
  "missed": [],
  "falseCommunicate": [],
  "changedIndices": [5, 8, 11, 12, 13]
}
```

Expected:

- 10/10 communication jobs retained.
- No false communication.
- Changed indices are exactly 5, 8, 11, 12, and 13.
- No model call is performed.

- [ ] **Step 4: Check patch whitespace**

Run:

```powershell
git diff --check
```

Expected: no output and exit zero.

- [ ] **Step 5: Record the product commit**

Commit any final product/test adjustments:

```powershell
git add -- src/core/decision_policy.js src/core/four_tier_decision.js src/core/analysis_revision.js tests/four_tier_decision_smoke.js tests/four_tier_pipeline_smoke.js tests/semantic_pipeline_smoke.js
git commit -m "feat: complete v4.4 evidence gate regression"
git push
```

If Tasks 2 and 3 already left no product changes, use their latest commit as
the v4.4 product commit instead of creating an empty commit.

---

### Task 5: Independent review and evaluated checkpoint

**Files:**
- Modify: `docs/roleflow-decision-matrix.md`
- Modify: `docs/superpowers/specs/2026-08-01-decision-matrix-v2-design.md`
- Modify: `docs/superpowers/plans/2026-08-01-decision-matrix-v2-plan.md`
- Modify: `docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md`
- Modify: `docs/superpowers/specs/2026-08-02-four-tier-evidence-promotion-gates-design.md`

**Interfaces:**
- Consumes: reviewed v4.4 product commit and offline evidence.
- Produces: a docs-only evaluated commit with the product commit as a strict ancestor.

- [ ] **Step 1: Request independent spec review**

Reviewer scope:

- Compare implementation to
  `docs/superpowers/specs/2026-08-02-four-tier-evidence-promotion-gates-design.md`.
- Confirm no prompt, contract, matrix, temperature, or provider change.
- Confirm safety ceilings override promotion floors.
- Confirm no profession-specific conditions.
- Return `Spec PASS` or findings with file and line references.

- [ ] **Step 2: Request independent code-quality review**

Reviewer scope:

- Look for incorrect precedence, silent primary promotion, missing version
  propagation, privacy-sensitive observability, and fixture overfitting.
- Return `Code quality APPROVED` or findings with file and line references.

- [ ] **Step 3: Resolve Important or Critical findings test-first**

For every accepted finding:

1. Add a failing regression.
2. Run it and capture the failure.
3. Apply the smallest fix.
4. Run focused and full offline regression.
5. Re-request the failed review gate.

- [ ] **Step 4: Update decision documentation**

Record:

- The zero-temperature finding.
- The v4.3 full result: missed 5/8 and false communication 11/12/13.
- The structural root cause.
- v4.4 rules and unchanged matrix/model contract.
- Offline replay path and result.
- Product commit.
- Review conclusions.

- [ ] **Step 5: Commit and push the evaluated checkpoint**

```powershell
git add -- docs/roleflow-decision-matrix.md docs/superpowers/specs/2026-08-01-decision-matrix-v2-design.md docs/superpowers/plans/2026-08-01-decision-matrix-v2-plan.md docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md docs/superpowers/specs/2026-08-02-four-tier-evidence-promotion-gates-design.md
git commit -m "docs: bind v4.4 evidence gate evaluation"
git push
```

Verify through Git ancestry that the v4.4 product commit is a strict ancestor
of this docs-only evaluated commit.

---

### Task 6: Run fresh live three-job and twenty-job acceptance

**Files:**
- Candidate worktree:
  `C:\Users\Administrator\.codex\worktrees\e843\ZhiPing`
- Fixed live worktree:
  `D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix`
- Frozen pool:
  `D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730`
- New three-job output:
  `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-4-first-3-20260802`
- New twenty-job output:
  `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-4-full-20-20260802`

**Interfaces:**
- Consumes: reviewed v4.4 product/evaluated commits and frozen private inputs.
- Produces: final behavior, privacy, structure, and technical acceptance evidence.

- [ ] **Step 1: Recheck immutable gates**

Require:

```text
jobs raw SHA-256   = 612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b
labels raw SHA-256 = 97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39
baseline product   = fb0168afce265cf351f03e80f66d9e0f24015887
```

Require candidate, baseline, and fixed live worktrees to be clean. Require both
new output directories to be absent.

- [ ] **Step 2: Bind the fixed live evaluation branch**

Move only `codex/multi-track-recall-first-live-eval` to the reviewed evaluated
commit. Never modify or merge `main`. Run the candidate stage from the fixed
live worktree's runner and restore:

```text
branch = codex/claude-generic-evidence-matching-live-fix
HEAD   = 1fc49dac3670a71c720bfcaed943fa29204d93c5
```

in a `finally` block.

- [ ] **Step 3: Run the fresh diagnostic**

Use zero-based indices exactly:

```text
5,8,13
```

Expected behavior:

- Index 5 remains in `primary` or `apply`.
- Index 8 remains in `primary` or `apply`.
- Index 13 remains outside `primary` and `apply`.
- No empty response, timeout, contract failure, privacy failure, or stale
  artifact.

- [ ] **Step 4: Publish the required three-job stage report**

Report in Chinese and annotate every English field:

- `expectedBucket`（人工期望档位）
- `actualBucket`（实际档位）
- `modelRecommendation`（模型原始建议）
- `responsibilityPromotionRoute`（职责晋级通道）
- `errorCode`（错误代码）

- [ ] **Step 5: Run all 20 with a new cache**

Do not reuse the three-job cache. Acceptance requires:

```text
expected communication retained = 10/10
false communication              = 0
technical failures               = 0
```

- [ ] **Step 6: Publish the required twenty-job stage report**

List every four-tier deviation, even when behaviorally acceptable. Explicitly
separate:

- Missed communication.
- False communication.
- Primary/apply swaps.
- Caution/not-recommended swaps.
- Technical failures.

- [ ] **Step 7: Finalize and push**

Update the approved documentation with final private run paths and sanitized
metrics, commit the docs-only final checkpoint, and push
`codex/multi-track-recall-continuation`.

Do not push private artifacts. Do not modify or merge `main`.
