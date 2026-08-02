# Responsibility Transferability Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize responsibility-state semantics and prevent low-coverage zero-duty-gap promotion without adding model fields, calls, voting, or profession-specific rules.

**Architecture:** Keep the existing D1-Dn `responsibilityMatches` contract. Add one responsibility-specific named-context rule to the existing match prompt, raise only the `zero_duty_gap` known-duty coverage gate to 2/3, and invalidate both match and decision caches. Preserve every existing matrix cell, requirement weight, matched-indispensable route, safety ceiling, and live-run boundary.

**Tech Stack:** Node.js CommonJS, assert-based smoke tests, existing OpenAI-compatible adapter, deterministic four-tier policy, private full-chain runner v3 portability.

## Global Constraints

- Preserve the four final tiers: `primary`, `apply`, `caution`, and `not_recommended`.
- Preserve default communication as `primary` plus `apply` only.
- Do not change the user-approved role-alignment by requirement-fit matrix.
- Do not change core/support weights from 0.70/0.30.
- Do not add a model field, model call, repeated self-check, vote, or retry policy.
- Do not change provider, model, temperature 0, or nonthinking mode.
- Use no profession-specific keywords or fixture identities in production code.
- Set `decisionRules` exactly to `four-tier-weighted-v4.5`.
- Set `matchJob` exactly to `match-decision-v41`.
- Set `zeroDutyGapMinimumKnownCoverage` exactly to `2 / 3`.
- Keep `matched_indispensable` joint-fit threshold exactly 0.50.
- Preserve the failed v4.4 root and cache unchanged.
- Do not access BOSS, cookies, `data/jobs.sqlite`, port 8787, or communication actions.
- Resolve formal model settings only through the private runner gate from
  `D:\Guo\ZhiPing`; never print or copy configuration contents.
- Write private output only under
  `D:\DevData\RoleFlow-private-benchmark`.
- Do not modify or merge `main`.

---

### Task 1: Add failing prompt, coverage, and version regressions

**Files:**
- Modify: `tests/model_adapter_smoke.js`
- Modify: `tests/four_tier_decision_smoke.js`
- Modify: `tests/four_tier_pipeline_smoke.js`
- Modify: `tests/semantic_pipeline_smoke.js`

**Interfaces:**
- Consumes: current D1-Dn prompt and v4.4/v40 cache versions.
- Produces: failing tests that define the v4.5/v41 behavior before production changes.

- [ ] **Step 1: Add the prompt regression**

After the existing D1-Dn prompt assertions in `tests/model_adapter_smoke.js`,
assert all of these clauses:

```js
assert(
  matchPrompt.includes(
    "For responsibilityMatches, do not use missing merely because the resume lacks the exact named domain, platform, tool, framework, or specialist workflow."
  )
    && matchPrompt.includes(
      "If a concrete resume fact proves the same underlying work action and deliverable through a different named context, use transferable."
    )
    && matchPrompt.includes(
      "If the exact context is unproven and no comparable responsibility is evidenced, use unknown with empty resumeEvidence."
    )
    && matchPrompt.includes(
      "Use missing only when a concrete resume fact explicitly proves an incompatible responsibility, work action, or deliverable."
    ),
  "responsibilityMatches must distinguish named-context gaps from missing underlying duties"
);
```

Keep the existing exact eight-key top-level contract assertion unchanged.

- [ ] **Step 2: Add the zero-duty-gap coverage regressions**

In `tests/four_tier_decision_smoke.js`, add:

```js
assert.strictEqual(
  DECISION_POLICY.responsibilityAlignment.jointFit.zeroDutyGapMinimumKnownCoverage,
  2 / 3
);

const zeroDutyGapAtTwoThirdsCoverage = decision("partially_aligned", [
  boundCore("missing", { foundation: false, central: true }),
  boundSupporting("transferable")
], [
  { id: "D1", state: "transferable", jdEvidence: "JD: duty one", resumeEvidence: "Resume: transferable one" },
  { id: "D2", state: "transferable", jdEvidence: "JD: duty two", resumeEvidence: "Resume: transferable two" },
  { id: "D3", state: "unknown", jdEvidence: "JD: duty three", resumeEvidence: "" }
]);
assert.strictEqual(zeroDutyGapAtTwoThirdsCoverage.matrixRecommendation, "apply");
assert.strictEqual(zeroDutyGapAtTwoThirdsCoverage.responsibilityPromotionRoute, "zero_duty_gap");

const zeroDutyGapAtHalfCoverage = decision("partially_aligned", [
  boundCore("missing", { foundation: false, central: true }),
  boundSupporting("transferable")
], [
  { id: "D1", state: "transferable", jdEvidence: "JD: duty one", resumeEvidence: "Resume: transferable one" },
  { id: "D2", state: "transferable", jdEvidence: "JD: duty two", resumeEvidence: "Resume: transferable two" },
  { id: "D3", state: "unknown", jdEvidence: "JD: duty three", resumeEvidence: "" },
  { id: "D4", state: "unknown", jdEvidence: "JD: duty four", resumeEvidence: "" }
]);
assert.strictEqual(zeroDutyGapAtHalfCoverage.matrixRecommendation, "caution");
assert.strictEqual(zeroDutyGapAtHalfCoverage.responsibilityZeroDutyGapPromotionReady, false);
```

Do not change matched-indispensable fixtures.

- [ ] **Step 3: Advance test expectations only**

Change test expectations:

```js
DECISION_POLICY.version === "four-tier-weighted-v4.5"
PIPELINE_VERSIONS.matchJob === "match-decision-v41"
PIPELINE_VERSIONS.decisionRules === "four-tier-weighted-v4.5"
```

Update every exact stale-revision fixture in
`tests/semantic_pipeline_smoke.js` to the same values.

- [ ] **Step 4: Run RED verification**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/four_tier_decision_smoke.js
node tests/four_tier_pipeline_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected:

- prompt assertion fails because the responsibility-specific text is absent;
- policy assertion or half-coverage assertion fails because v4.4 still allows
  0.50 coverage;
- version assertions fail with v40/v4.4 actual values;
- no syntax or fixture-construction error.

- [ ] **Step 5: Commit the RED checkpoint**

```powershell
git add -- tests/model_adapter_smoke.js tests/four_tier_decision_smoke.js tests/four_tier_pipeline_smoke.js tests/semantic_pipeline_smoke.js
git commit -m "test: define responsibility transferability stability"
git push
```

---

### Task 2: Implement the minimal v4.5/v41 change

**Files:**
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/core/decision_policy.js`
- Modify: `src/core/four_tier_decision.js`
- Modify: `src/core/analysis_revision.js`

**Interfaces:**
- Consumes: Task 1 failing prompt, coverage, and version assertions.
- Produces: v41 responsibility semantics and v4.5 zero-duty-gap coverage.

- [ ] **Step 1: Add the compact responsibility instruction**

Immediately after the existing D1-Dn responsibility instruction in
`src/adapters/models/openai_compatible.js`, add one array element:

```js
"For responsibilityMatches, do not use missing merely because the resume lacks the exact named domain, platform, tool, framework, or specialist workflow. If a concrete resume fact proves the same underlying work action and deliverable through a different named context, use transferable. If the exact context is unproven and no comparable responsibility is evidenced, use unknown with empty resumeEvidence. Use missing only when a concrete resume fact explicitly proves an incompatible responsibility, work action, or deliverable.",
```

Do not change the output example, top-level key count, JSON schema, or contract
validator.

- [ ] **Step 2: Add and validate the policy value**

In `src/core/decision_policy.js`:

```js
version: "four-tier-weighted-v4.5",
```

Inside `responsibilityAlignment.jointFit`, add:

```js
zeroDutyGapMinimumKnownCoverage: 2 / 3,
```

In `assertDecisionPolicy`, validate it with `finiteUnit` and require:

```js
zeroDutyGapMinimumKnownCoverage >= minimumKnownCoverage
```

Throw a clear policy-validation error when it is lower.

- [ ] **Step 3: Apply the coverage only to zero-duty-gap readiness**

In `src/core/four_tier_decision.js`, add this condition to
`responsibilityZeroDutyGapPromotionReady`:

```js
&& responsibility.coverage >= jointPolicy.zeroDutyGapMinimumKnownCoverage
```

Do not change `responsibilityBasePromotionEvidenceReady`; the
matched-indispensable route must retain the existing 0.50 coverage and 0.50
joint-fit gates.

- [ ] **Step 4: Advance cache revisions**

In `src/core/analysis_revision.js`:

```js
matchJob: "match-decision-v41",
decisionRules: "four-tier-weighted-v4.5",
```

Do not change `understandJob`.

- [ ] **Step 5: Run GREEN verification**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/four_tier_decision_smoke.js
node tests/four_tier_pipeline_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: all four commands exit 0.

- [ ] **Step 6: Commit and push**

```powershell
git add -- src/adapters/models/openai_compatible.js src/core/decision_policy.js src/core/four_tier_decision.js src/core/analysis_revision.js
git commit -m "fix: stabilize responsibility transferability"
git push
```

---

### Task 3: Offline replay and independent review

**Files:**
- Private output:
  `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-5-offline-replay-20260802`
- Modify only if review finds a real defect: files named by the finding.

**Interfaces:**
- Consumes: reviewed Task 2 product commit and frozen v4.3 cache evidence.
- Produces: offline regression evidence plus `Spec PASS` and
  `Code quality APPROVED`.

- [ ] **Step 1: Run complete offline regression**

Run:

```powershell
node tests/generic_evidence_matching_smoke.js
node tests/private_full_chain_runner_smoke.js
npm.cmd test
git diff --check
```

Expected: generic fixtures pass, runner gates pass, all 50 offline checks pass,
and diff check is clean.

- [ ] **Step 2: Replay the frozen v4.3 full cache**

Create the initially absent private root:

```text
D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-5-offline-replay-20260802
```

Reuse model evidence only from:

```text
D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-3-full-20-v3-20260802
```

Write a sanitized JSON report with indices, expected/actual tiers, behavior
booleans, promotion route, and aggregate counts. Do not copy JD or resume text.

Required result:

```text
expected communication = 10
actual communication   = 10
missed                 = 0
false communication    = 0
behavior pass          = 20/20
```

- [ ] **Step 3: Request independent read-only review**

Review from the v4.5 design commit through the product commit.

Spec reviewer must verify:

- prompt semantics match the design;
- no ninth key, new field, call, vote, or repeated check;
- zero-duty-gap uses 2/3 while matched-indispensable keeps existing gates;
- matrix and 70/30 weights are unchanged;
- version propagation is complete;
- no profession-specific conditions.

Code-quality reviewer must inspect:

- safety precedence;
- malformed/unknown state behavior;
- policy validation;
- prompt contradiction or duplication;
- cache invalidation;
- missing regressions.

- [ ] **Step 4: Resolve every Critical or Important finding test-first**

For each accepted finding:

1. Add one failing regression.
2. Run it and confirm the expected failure.
3. Apply the smallest fix.
4. Run focused and complete offline regression.
5. Re-request the failed review gate.

Do not proceed until the final verdicts are exactly:

```text
Spec PASS
Code quality APPROVED
```

---

### Task 4: Evaluated checkpoint and live 3-to-20 acceptance

**Files:**
- Modify: `docs/roleflow-decision-matrix.md`
- Modify: `docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md`
- Modify: `docs/superpowers/plans/2026-08-01-decision-matrix-v2-plan.md`
- Modify: `docs/superpowers/plans/2026-08-02-responsibility-transferability-stability.md`
- Private diagnostic root:
  `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-5-first-3-20260802`
- Private full root:
  `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-5-full-20-20260802`

**Interfaces:**
- Consumes: reviewed product commit, frozen private evidence, fixed baseline, and fixed live worktree.
- Produces: evaluated commit, fresh diagnostic report, fresh full acceptance report, and final pushed documentation.

- [ ] **Step 1: Create and bind the evaluated checkpoint**

Record:

- failed v4.4 diagnostic result 2/3 and preserved path;
- index 8 state drift root cause;
- rejected numeric-only and new-field alternatives;
- v41 responsibility semantics;
- v4.5 2/3 coverage gate;
- offline tests, replay, reviews, and product commit;
- baseline harness `c1d32641bca2ccd4c82128f48f3cfac996310dfb`;
- approved baseline product
  `fb0168afce265cf351f03e80f66d9e0f24015887`.

Commit the docs-only evaluated checkpoint and push. In one immediate descendant
docs-only commit, record its exact SHA. Verify the product commit is its strict
ancestor. Use the evaluated commit, not the descendant binding commit, for all
runner artifacts and the live-eval branch.

- [ ] **Step 2: Recheck immutable live gates**

Require:

```text
jobs raw SHA-256   = 612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b
labels raw SHA-256 = 97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39
baseline product   = fb0168afce265cf351f03e80f66d9e0f24015887
```

Require candidate, baseline, and fixed live worktrees to be clean. Require both
v4.5 live roots to be absent. Require candidate/baseline blob equality for:

```text
scripts/private-full-chain-runner.js
scripts/lib/benchmark_metrics.js
scripts/lib/private_resume_privacy.js
```

- [ ] **Step 3: Run a fresh diagnostic**

Move only `codex/multi-track-recall-first-live-eval` to the evaluated commit.
Run exactly zero-based:

```text
5,8,13
```

Use v3 proof creation, a fresh model cache, and the runner-gated settings root.
Restore:

```text
branch = codex/claude-generic-evidence-matching-live-fix
HEAD   = 1fc49dac3670a71c720bfcaed943fa29204d93c5
```

in a `finally` block and verify it is clean.

- [ ] **Step 4: Publish the required three-job stage report**

For each row annotate:

- `expectedBucket` (人工期望档位)
- `actualBucket` (实际档位)
- `modelRecommendation` (模型影子建议)
- `responsibilityPromotionRoute` (职责晋级路线)
- `errorCode` (错误代码)

Only behavior 3/3 plus zero technical/privacy/structure/cache failures unlocks
the 20-job run.

- [ ] **Step 5: Run all 20 with a separate fresh cache**

Never copy or reuse the diagnostic SQLite files.

Required:

```text
expected communication retained = 10/10
false communication              = 0
technical failures               = 0
```

- [ ] **Step 6: Publish the required twenty-job stage report**

List:

- missed communication;
- false communication;
- primary/apply swaps;
- caution/not-recommended swaps;
- technical failures;
- every zero-based deviation index.

- [ ] **Step 7: Final regression, review, documentation, and push**

Run the complete offline suite and `git diff --check`. Update the tracking
documents with sanitized live metrics and immutable root paths. Request final
whole-branch review, fix any accepted Critical or Important issue test-first,
commit the docs-only final checkpoint, and push
`codex/multi-track-recall-continuation`.

Do not push private artifacts. Do not modify or merge `main`.
