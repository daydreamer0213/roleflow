# Cross-Field Evidence Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make central transferable evidence and eligibility conflicts internally consistent across model fields without weakening local recall or hard-safety policy.

**Architecture:** Add generic consistency instructions to the existing two model prompts and invalidate only the affected understand/match caches. Keep validators, local recommendation policy, model settings, call count, and private fixtures unchanged.

**Tech Stack:** Node.js CommonJS, assert-based smoke tests, existing OpenAI-compatible adapter, existing semantic cache revision checks, Git.

## Global Constraints

- Work only on `codex/multi-track-recall-continuation`.
- Do not access BOSS, cookies, 8787, communication actions, or the main jobs database.
- Do not print or commit private JD, resume, title, company, evidence, labels, model settings, or secrets.
- Do not change model temperature, DeepSeek thinking policy, retries, call count, validators, local bucket policy, hard-blocker checks, fixtures, or confirmed labels.
- Preserve every prior private root unchanged.
- Keep `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-20-v3-20260730` absent until a fresh three-row run is exact and safe.

---

### Task 1: Add cross-field prompt consistency

**Files:**
- Modify: `tests/model_adapter_smoke.js`
- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/core/analysis_revision.js`

**Interfaces:**
- Consumes: existing `understandJob` and `matchJob` prompt construction plus `PIPELINE_VERSIONS`.
- Produces: eligibility logic-preservation instructions, central transferable/role-gap consistency instructions, `job-understanding-v17`, and `match-decision-v32`.

- [ ] **Step 1: Write failing adapter prompt tests**

Add assertions that the `understandJob` prompt contains these exact clauses:

```text
Preserve logical alternatives and scope when normalizing eligibility.
Only emit separate eligibility items when each condition is independently mandatory.
```

Add assertions that the `matchJob` prompt contains these exact clauses:

```text
A central transferable requirement must have a corresponding concrete named difference in roleGaps.
Do not invent a roleGap to justify transferable.
An eligibility conflict requires an explicit candidate fact that fails every accepted alternative in that eligibility item.
```

- [ ] **Step 2: Write failing cache-version tests**

Change current expectations to:

```js
understandJob: "job-understanding-v17",
matchJob: "match-decision-v32"
```

Assert a v16 understanding cache produces
`job_understanding_pipeline_changed` and a v31 match cache produces
`match_pipeline_changed`.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: the adapter test fails on the missing generic clauses and the
semantic test fails because product versions are still v16/v31.

- [ ] **Step 4: Implement the minimal prompt and version changes**

In `understandJob`, add:

```text
Preserve logical alternatives and scope when normalizing eligibility. Do not split a combined or alternative condition into independent hard gates when that changes AND/OR semantics; a relaxation, acceptable alternative, or example is not an independent gate. Only emit separate eligibility items when each condition is independently mandatory.
```

In `matchJob`, add:

```text
A central transferable requirement must have a corresponding concrete named difference in roleGaps. If no such difference exists and the resume evidence is a direct instance of the broad requirement, use matched. Do not invent a roleGap to justify transferable.
An eligibility conflict requires an explicit candidate fact that fails every accepted alternative in that eligibility item. If the candidate satisfies any accepted alternative, use satisfied; omit uncertainty instead of treating it as conflict.
```

Set:

```js
understandJob: "job-understanding-v17",
matchJob: "match-decision-v32"
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: both exit `0`.

- [ ] **Step 6: Run full offline verification**

Run:

```powershell
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
npm.cmd test
git diff --check
```

Expected: six generic fixtures, 31 benchmark fixtures, and all 47 offline
checks pass.

- [ ] **Step 7: Commit and push the product checkpoint**

Commit:

```powershell
git add -- src/adapters/models/openai_compatible.js src/core/analysis_revision.js tests/model_adapter_smoke.js tests/semantic_pipeline_smoke.js
git commit -m "fix: align evidence states across model fields"
git push origin codex/multi-track-recall-continuation
```

### Task 2: Bind and run the next private checkpoint

**Files:**
- Modify: `docs/superpowers/plans/2026-07-30-private-benchmark-fixture-portability.md`
- Modify: `docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md`

**Interfaces:**
- Consumes: Task 1 product commit, baseline evaluated `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5`, frozen jobs/labels hashes, and the fixed candidate worktree.
- Produces: a docs-only candidate evaluated commit and a fresh immutable three-row live result.

- [ ] **Step 1: Record the failed three-row evidence**

Record only private-safe aggregate fields from
`multi-track-recall-first-3-cross-track-sprawl-v1-20260730`, the selected
design, product commit, verification results, and the fact that independent
reviewer capacity remains unavailable.

- [ ] **Step 2: Create a two-step evaluated binding**

Commit the two authoritative plans, record that commit's exact SHA in an
immediate descendant docs-only commit, and push both commits. Verify the Task 1
product is a strict ancestor.

- [ ] **Step 3: Run a fresh three-row acceptance**

Use only the initially absent root:

```text
D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-cross-field-consistency-v1-20260730
```

Copy and hash all seven frozen files, initialize the manifest, create and verify
the v3 portability proof, use a fresh cache, and run exact zero-based:

```text
--diagnostic-indices 4,9,10
```

Restore `codex/claude-generic-evidence-matching-live-fix` at
`1fc49dac3670a71c720bfcaed943fa29204d93c5` in `finally`.

- [ ] **Step 4: Gate the 20-row run**

If any row is structurally incomplete, unsafe, or not exact, preserve the root,
keep the 20-row root absent, and diagnose the first wrong row. Create the
20-row root only after all three rows are exact and safe.
