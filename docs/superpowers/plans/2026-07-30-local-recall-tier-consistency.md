# Local Recall Tier Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct two local demotion boundaries so complete direct decision evidence can retain its confirmed tier while non-core omissions do not create false low confidence.

**Architecture:** Reuse the existing decision-bearing requirement partition in sparse confidence and narrowly extend the existing primary ceiling condition. Keep the public result shape, hard boundaries, prompts, validators, and model runtime unchanged.

**Tech Stack:** Node.js CommonJS, existing model contract helpers, assert-based semantic smoke tests, Git.

## Global Constraints

- Work only on `codex/multi-track-recall-continuation`.
- Do not access BOSS, cookies, 8787, communication actions, or the main jobs database.
- Do not print or commit private JD, resume, title, company, evidence, labels, model settings, or secrets.
- Do not change prompts, validators, hard-blocker checks, eligibility checks, model settings, fixtures, or confirmed labels.
- Preserve all prior private roots unchanged.
- Keep the 20-row root absent until a fresh three-row root is exact and safe.

---

### Task 1: Align sparse confidence and role ceiling

**Files:**
- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `src/core/model_contract.js`
- Modify: `src/core/analysis_revision.js`

**Interfaces:**
- Consumes: `validateSparseMatchEvidence`, `roleEvidenceDecisionState`, `PIPELINE_VERSIONS`.
- Produces: decision-scoped sparse confidence, a narrow complete-direct mostly-aligned primary ceiling, and `match-decision-v33`.

- [ ] **Step 1: Write failing role-ceiling tests**

In the role evidence matrix, require:

```js
["mostly_aligned", ["matched", "matched"], "primary"]
```

Add synthetic cases proving these remain `talk` or `backup`:

```text
mostly_aligned + transferable foundation -> talk
mostly_aligned + transferable central non-foundation -> talk
mostly_aligned + missing central -> backup
```

- [ ] **Step 2: Write failing sparse-confidence tests**

Build a synthetic selected track with:

- R1 foundation/central `transferable`;
- R2 central `matched`;
- R3 non-core omitted from sparse output;
- no unknown eligibility and concrete role evidence.

Assert the normalized decision remains `caution` and confidence is `0.72`.
Add a sibling case where an omitted decision-bearing requirement keeps
confidence at `0.45`.

- [ ] **Step 3: Write the failing version test**

Set the expected current match version to:

```js
matchJob: "match-decision-v33"
```

Assert v32 produces `match_pipeline_changed`. Keep:

```js
understandJob: "job-understanding-v17"
```

- [ ] **Step 4: Run semantic test and verify RED**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
```

Expected: failure on the old `talk` ceiling, confidence `0.45`, and v32.

- [ ] **Step 5: Implement the minimal local changes**

In sparse confidence, use:

```js
!decisionUnknownRequirements.length
```

In `roleEvidenceDecisionState`, compute `hasTransferableCentral` internally and
use:

```js
if (
  ["aligned", "mostly_aligned"].includes(analysis.roleAlignment)
  && foundationState === "complete"
  && !hasTransferableFoundation
  && !hasTransferableCentral
  && !hasConcreteFoundationGap
) {
  bucketCeiling = "primary";
  bucketFloor = "talk";
}
```

Set match pipeline v33. Do not change the returned role-evidence object shape.

- [ ] **Step 6: Run focused and full verification**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
npm.cmd test
git diff --check
```

Expected: semantic checks, six generic fixtures, 31 benchmark fixtures, and all
47 offline checks pass.

- [ ] **Step 7: Commit and push**

```powershell
git add -- src/core/model_contract.js src/core/analysis_revision.js tests/semantic_pipeline_smoke.js
git commit -m "fix: align local recall tiers with core evidence"
git push origin codex/multi-track-recall-continuation
```

### Task 2: Bind and rerun the private gate

**Files:**
- Modify: `docs/superpowers/plans/2026-07-30-private-benchmark-fixture-portability.md`
- Modify: `docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md`

**Interfaces:**
- Consumes: Task 1 product, baseline evaluated `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5`, frozen fixture hashes, and the fixed candidate.
- Produces: an evaluated docs checkpoint and a fresh immutable three-row result.

- [ ] **Step 1: Record the prior aggregate evidence**

Record the safe result and local root cause from
`multi-track-recall-first-3-cross-field-consistency-v1-20260730`. Do not record
private content.

- [ ] **Step 2: Create and push the two-step evaluated binding**

Commit the two authoritative plans, record that exact docs commit SHA in an
immediate descendant docs-only commit, and push both.

- [ ] **Step 3: Run a fresh three-row root**

Use only:

```text
D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-local-decision-consistency-v1-20260730
```

Use a new cache and exact zero-based `4,9,10`. Restore the fixed candidate in
`finally`.

- [ ] **Step 4: Gate full acceptance**

Create `multi-track-recall-first-20-v3-20260730` only if all three rows are
exact, complete, evidence-bearing, and pass every recall and safety gate.
