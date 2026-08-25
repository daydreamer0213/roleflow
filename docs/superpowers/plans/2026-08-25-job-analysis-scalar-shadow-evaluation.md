# Job Analysis Scalar Shadow Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task with two-stage review (spec compliance, then code quality).

**Goal:** Add a genuinely scalar, offline-only candidate decision and a report that can compare it with the production matrix without influencing production jobs.

**Architecture:** Reuse the existing deterministic semantic normalization and score inputs, but calculate a new continuous joint score and map that score to candidate tiers before applying explicit safety caps. Keep the implementation under `scripts/` so production code cannot import it accidentally. Build a separate comparison CLI that reads the existing Gate D fixture and optional human labels, writes only to an explicit output path, and reports when correctness or stability evidence is insufficient.

**Tech Stack:** Node.js 22, CommonJS, built-in `fs`, `path`, `crypto`, existing four-tier decision helpers and Gate D JSON fixtures, existing offline smoke-test harness.

**Global Constraints:** No production decision change, database write, BOSS access, model call, network call, dependency, schema migration, or generated artifact on `C:`. Thresholds are named evaluation hypotheses, not product policy. A total score may never compensate for a verified hard boundary, severe risk, wrong role direction, missing core requirement, or insufficient evidence.

---

### Task 1: Implement the independent scalar candidate with explicit guardrails

**Files:**
- Create: `tests/scalar_shadow_scorecard_smoke.js`
- Create: `scripts/lib/scalar_shadow_scorecard.js`
- Modify: `scripts/lib/shadow_scorecard.js`

- [ ] **Step 1: Add the failing scalar scorecard tests**

  Cover these behaviors:

  ```js
  const scorecard = buildScalarShadowScorecard(input);
  assert.strictEqual(scorecard.version, "scalar-shadow-scorecard-v1");
  assert.strictEqual(scorecard.score.formula, "responsibilities:0.4+requirements:0.6");
  assert.strictEqual(scorecard.rawTier, "primary");
  assert.strictEqual(scorecard.candidateTier, "primary");
  ```

  Also prove:

  - identical inputs return deeply identical results and are not mutated;
  - a middle continuous score can produce a different tier from `deriveMatrixDecision()`;
  - verified hard boundaries and severe risks force `not_recommended`;
  - effective role misalignment cannot be lifted by high requirement points;
  - low requirement or responsibility coverage, unknown core requirements, and confirmed foundation gaps cap at `caution`;
  - `rawTier` remains visible when a guardrail changes `candidateTier`.

- [ ] **Step 2: Run the new test and confirm failure**

  Run: `node tests/scalar_shadow_scorecard_smoke.js`

  Expected: FAIL with `MODULE_NOT_FOUND` for the scalar scorecard.

- [ ] **Step 3: Expose only the existing boundary inspector**

  Export `inspectBoundaries` from `scripts/lib/shadow_scorecard.js` without changing `buildShadowScorecard()` behavior. This avoids duplicating the verified-boundary parser and does not change any production module.

- [ ] **Step 4: Implement the smallest scalar scorecard**

  Create `scripts/lib/scalar_shadow_scorecard.js` with an immutable evaluation policy:

  ```js
  const SCALAR_SHADOW_POLICY = Object.freeze({
    version: "scalar-joint-v1",
    weights: { responsibilities: 0.4, requirements: 0.6 },
    thresholds: { primary: 0.8, apply: 0.5 }
  });
  ```

  Use `deriveMatrixDecision()` only for existing normalized intermediate metrics and safety facts; never use its `matrixRecommendation` to choose the scalar tier. Require both responsibility and requirement scores for an automatic tier. Calculate:

  ```js
  jointScore = responsibilityScore * 0.4 + combinedFit * 0.6;
  ```

  Map `>= 0.8` to `primary`, `>= 0.5` to `apply`, `> 0` to `caution`, and `0` to `not_recommended`; missing score maps to `caution`. Apply named block/cap reasons after the raw mapping and return both tiers.

- [ ] **Step 5: Re-run scalar and existing shadow tests**

  ```powershell
  node tests/scalar_shadow_scorecard_smoke.js
  node tests/shadow_scorecard_smoke.js
  ```

  Expected: both tests print `ok`; the existing shadow report remains byte-compatible.

- [ ] **Step 6: Commit the scalar scorecard checkpoint**

  ```powershell
  git add tests/scalar_shadow_scorecard_smoke.js scripts/lib/scalar_shadow_scorecard.js scripts/lib/shadow_scorecard.js
  git commit -m "feat: add scalar shadow scorecard"
  ```

### Task 2: Add the separate matrix-versus-scalar report

**Files:**
- Modify: `tests/scalar_shadow_scorecard_smoke.js`
- Create: `scripts/compare-scalar-shadow.js`
- Modify: `tests/run_all.js`

- [ ] **Step 1: Add failing report and CLI tests**

  Build a small fixture containing a normal case, a matrix/scalar difference, a verified hard boundary, an evidence-capped case, a technical bucket, optional confirmed labels, and two rows sharing a `repeatGroup`.

  Assert the report contains:

  ```js
  assert.strictEqual(report.evaluation, "matrix-vs-scalar-shadow");
  assert.strictEqual(report.productionInfluence, "none");
  assert.strictEqual(report.hardBoundaryEscapeCount, 0);
  assert.ok(report.changedTierCount > 0);
  assert.deepStrictEqual(report.correctness.status, "insufficient_labels");
  assert.deepStrictEqual(report.stability.status, "insufficient_repeats");
  ```

  Where sufficient confirmed labels or repeat groups exist, assert separate matrix and scalar metrics are returned without declaring a winner. Test deterministic byte output, duplicate IDs, invalid case input, and refusal to overwrite the input or labels file.

- [ ] **Step 2: Run the new test and confirm failure**

  Run: `node tests/scalar_shadow_scorecard_smoke.js`

  Expected: FAIL because `scripts/compare-scalar-shadow.js` does not exist.

- [ ] **Step 3: Implement the focused report builder and CLI**

  The report must include:

  - fixture SHA-256, evaluated Git commit, scalar policy version, and production policy hash;
  - raw and quality-eligible counts plus technical-bucket counts;
  - matrix/scalar tier distributions and confusion table;
  - changed rows with score, raw scalar tier, guarded scalar tier, coverage, and guardrail codes;
  - verified hard-boundary and severe-risk escapes;
  - coverage bands;
  - exact-match correctness for each route only when confirmed labels exist;
  - within-`repeatGroup` tier variation and scalar score range only when repeated semantic outputs exist;
  - explicit `insufficient_labels` and `insufficient_repeats` states otherwise;
  - no `winner`, `recommendedRoute`, or production-write field.

  Reuse the existing Gate D label loader and path-identity protections. Write only the explicit `--output` file.

- [ ] **Step 4: Register and run the tests**

  Add `scalar_shadow_scorecard_smoke.js` next to the current shadow scorecard entry in `tests/run_all.js`.

  ```powershell
  node tests/scalar_shadow_scorecard_smoke.js
  node tests/run_all.js
  ```

  Expected: the scalar test prints `ok`; the full runner includes it without altering existing test order semantics.

- [ ] **Step 5: Commit the report checkpoint**

  ```powershell
  git add tests/scalar_shadow_scorecard_smoke.js scripts/compare-scalar-shadow.js tests/run_all.js
  git commit -m "feat: compare matrix and scalar shadow"
  ```

### Task 3: Run the frozen local Gate D comparison without changing the baseline

**Files:**
- Verify only; output under `D:\DevData\RoleFlow-gate-d\comparisons\`

- [ ] **Step 1: Run against the current frozen fixture and labels**

  ```powershell
  node scripts/compare-scalar-shadow.js `
    --input D:\DevData\RoleFlow-gate-d\baseline\fixtures\gate-d-evaluation-fixture.json `
    --labels D:\DevData\RoleFlow-gate-d\baseline\labels\gate-d-evaluation-labels.json `
    --output D:\DevData\RoleFlow-gate-d\comparisons\matrix-vs-scalar-2026-08-25.json
  ```

  Expected: report writes to `D:`; input fixture and label hashes/files remain unchanged.

- [ ] **Step 2: Interpret only what the evidence supports**

  Record tier differences, guardrail interventions, coverage distribution, and whether hard-boundary escapes are zero. Because current labels are pending-human and current fixture has no repeated model groups, report correctness and drift comparison as unavailable.

- [ ] **Step 3: Run hygiene checks**

  ```powershell
  git diff --check
  git status --short
  ```

  Expected: generated comparison output is outside Git; repository changes are only intentional source/test work.

