# Central Transfer Gap Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject central transferable evidence that has no role gap, using the existing one-shot contract repair instead of silently promoting or accepting contradictory evidence.

**Architecture:** Add one generic invariant inside sparse match validation and invalidate only match caches. Reuse the current repair pipeline and keep all local decision, hard safety, model runtime, and privacy behavior unchanged.

**Tech Stack:** Node.js CommonJS, existing `ModelContractError`, semantic smoke tests, Git.

## Global Constraints

- Work only on `codex/multi-track-recall-continuation`.
- Do not access BOSS, cookies, 8787, communication actions, or the main jobs database.
- Do not print or commit private JD, resume, title, company, evidence, labels, model settings, or secrets.
- Do not change prompts, local decision policy, hard blockers, eligibility, model settings, fixtures, or confirmed labels.
- Preserve all prior private roots unchanged.
- Keep the 20-row root absent until a fresh three-row root is exact and safe.

---

### Task 1: Enforce the central-transfer gap invariant

**Files:**
- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `src/core/model_contract.js`
- Modify: `src/core/analysis_revision.js`

**Interfaces:**
- Consumes: normalized sparse `requirementMatches` and `roleAlignmentEvidence.roleGaps`.
- Produces: a generic `ModelContractError` for ungrounded central transferable evidence and `match-decision-v34`.

- [ ] **Step 1: Write failing contract tests**

Create a synthetic single-track understanding with a central requirement. Assert
that this sparse output fails:

```js
{
  selectedTrackId: "T1",
  roleAlignment: "mostly_aligned",
  roleResumeEvidence: ["Resume: concrete delivery"],
  roleGaps: [],
  matches: [{
    id: "R1",
    state: "transferable",
    resumeEvidence: "Resume: adjacent delivery"
  }],
  eligibility: []
}
```

Expected error:

```text
MODEL_CONTRACT_INVALID
central transferable requires a concrete roleGap
```

- [ ] **Step 2: Add valid boundary tests**

Assert:

- adding one concrete role gap validates and derives `caution`;
- changing the requirement to non-central validates with no role gap;
- changing the state to `matched` validates with no role gap.

- [ ] **Step 3: Add the failing version test**

Expect:

```js
matchJob: "match-decision-v34"
```

Assert v33 yields `match_pipeline_changed`. Keep
`job-understanding-v17`.

- [ ] **Step 4: Run semantic test and verify RED**

```powershell
node tests/semantic_pipeline_smoke.js
```

Expected: the contradictory sparse output is accepted and the product version
is still v33.

- [ ] **Step 5: Implement the minimal invariant**

After constructing `requirementMatches`, add:

```js
if (
  requirementMatches.some((item) => item.central === true && item.state === "transferable")
  && !roleAlignmentEvidence.roleGaps.length
) {
  throw new ModelContractError(
    "matchJob",
    "central transferable requires a concrete roleGap"
  );
}
```

Set `matchJob` to `match-decision-v34`.

- [ ] **Step 6: Run focused and full verification**

```powershell
node tests/semantic_pipeline_smoke.js
node tests/model_adapter_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
npm.cmd test
git diff --check
```

Expected: all focused tests, six generic fixtures, 31 benchmark fixtures, and
all 47 offline checks pass.

- [ ] **Step 7: Commit and push**

```powershell
git add -- src/core/model_contract.js src/core/analysis_revision.js tests/semantic_pipeline_smoke.js
git commit -m "fix: require gaps for central transferable evidence"
git push origin codex/multi-track-recall-continuation
```

### Task 2: Bind and rerun the private gate

**Files:**
- Modify: `docs/superpowers/plans/2026-07-30-private-benchmark-fixture-portability.md`
- Modify: `docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md`

**Interfaces:**
- Consumes: Task 1 product, baseline evaluated `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5`, and frozen fixture hashes.
- Produces: an evaluated docs checkpoint and a fresh immutable three-row result.

- [ ] **Step 1: Record prior aggregate evidence**

Record that the local-decision root was two of three exact and that the
remaining row contained central transferable evidence with zero role gaps. Do
not record private text.

- [ ] **Step 2: Create and push the two-step evaluated binding**

Commit the two authoritative plans, record the exact docs commit SHA in an
immediate descendant docs-only commit, and push both.

- [ ] **Step 3: Run a fresh three-row root**

Use only:

```text
D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-transfer-gap-contract-v1-20260730
```

Use a fresh cache and exact zero-based `4,9,10`. Restore the fixed candidate in
`finally`.

- [ ] **Step 4: Gate full acceptance**

Create the 20-row root only if all three rows are exact, complete,
evidence-bearing, and safe.
