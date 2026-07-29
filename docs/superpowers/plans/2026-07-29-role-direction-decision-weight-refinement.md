# Role Direction Decision Weight Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep same-family full-stack roles in the recall-first `talk` pool and prevent ordinary advisory requirements from lowering an otherwise qualified role.

**Architecture:** Preserve the existing two-model-call pipeline. Clarify only the `matchJob` role-alignment prompt, then narrow the local recommendation inputs to requirements marked `foundation`, `central`, or `indispensable` in both the active sparse normalizer and the legacy compact normalizer; all requirement rows remain available for explanations.

**Tech Stack:** Node.js 22, CommonJS, built-in `assert`, existing smoke-test runner, existing private full-chain benchmark runner.

## Global Constraints

- Make product and documentation changes only in `D:\DevData\RoleFlow-worktrees\deepseek-match-nonthinking-ab`. The saved-JD live diagnostic may temporarily check the evaluated commit out at the runner's fixed candidate worktree, then must restore that worktree to its original branch and commit.
- Do not access BOSS or another recruitment platform, do not operate a browser, and do not touch `D:\Guo\ZhiPing\data\jobs.sqlite` or port 8787.
- Keep the normal path at one `understandJob` call plus one `matchJob` call.
- Do not add an occupation taxonomy, local keyword rescue, dependency, database migration, or third model stage.
- `primary` and `talk` are both acceptable for the representative AI application delivery job; `talk` is the acceptance floor.
- Full-stack delivery with a substantial back-end lane must be `mostly_aligned`, while an adjacent Java-only or AI-workflow-only role remains eligible for `partially_aligned`.
- Ordinary requirements with `foundation=false`, `central=false`, and `indispensable=false` remain visible but cannot alone lower the recommendation.
- Eligibility conflicts, structured hard blockers, salary/location/internship boundaries, safety risks, and existing evidence guards remain unchanged.
- Terminology cleanup for “主投/可投/先聊/慎投” is explicitly deferred to a later whole-project audit.

---

### Task 1: Clarify same-family full-stack role alignment

**Files:**

- Modify: `tests/model_adapter_smoke.js`
- Modify: `src/adapters/models/openai_compatible.js`

**Interfaces:**

- Consumes: `OpenAICompatibleAdapter.matchJob(input)`.
- Produces: the same sparse JSON contract `{roleAlignment, roleResumeEvidence, roleGaps, matches, eligibility}`.

- [x] **Step 1: Add the failing prompt-contract test**

Add this assertion next to the existing full-stack prompt assertions in
`tests/model_adapter_smoke.js`:

```js
assert(
  matchPrompt.includes("main role family and delivery direction")
    && matchPrompt.includes("substantial back-end delivery")
    && matchPrompt.includes("mostly_aligned")
    && matchPrompt.includes("missing front-end")
    && matchPrompt.includes("requirement gap")
    && matchPrompt.includes("adjacent AI workflows")
    && matchPrompt.includes("partially_aligned"),
  "full-stack roles must stay in the same role family when a substantial delivery lane is proven"
);
```

- [x] **Step 2: Run the test and verify the intended red failure**

Run:

```powershell
node tests/model_adapter_smoke.js
```

Expected: exit 1 at the new assertion because the current prompt says back-end
evidence does not prove full-stack delivery but does not tell the model when the
same-family result must be `mostly_aligned`.

- [x] **Step 3: Add the minimum prompt clarification**

Insert these two lines after the existing work-object/action/deliverable rule in
`OpenAICompatibleAdapter.matchJob()`:

```js
"Judge roleAlignment by the main role family and delivery direction, not by complete coverage of every responsibility. Put uncovered duties in roleGaps without automatically changing the role family.",
"For a full-stack business-system role, substantial back-end delivery plus API integration, testing, debugging, or end-to-end system work is mostly_aligned when it proves a meaningful delivery lane; missing front-end stays a requirement gap. Use partially_aligned when the candidate has only adjacent AI workflows or generic tools without business-system delivery.",
```

Do not remove the existing reverse-inference restriction: back-end evidence
still does not prove the missing front-end requirement.

- [x] **Step 4: Run the focused test**

Run:

```powershell
node tests/model_adapter_smoke.js
```

Expected: `model adapter smoke ok`.

- [x] **Step 5: Commit Task 1**

```powershell
git add -- tests/model_adapter_smoke.js src/adapters/models/openai_compatible.js
git commit -m "fix: keep substantial full-stack delivery in the same role family"
```

---

### Task 2: Keep advisory requirement gaps out of recommendation ranking

**Files:**

- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `src/core/model_contract.js`

**Interfaces:**

- Consumes: normalized requirement rows containing `foundation`, `central`, `indispensable`, and `state`.
- Produces: the existing normalized MatchDecision; no field or schema changes.

- [x] **Step 1: Change the existing non-core-gap assertion to the approved behavior**

Replace the assertions after `sparseNonCoreGap` with:

```js
assert.strictEqual(sparseNonCoreGap.requirementMatches.find((item) => item.requirement === "客户需求沟通").state, "missing");
assert.strictEqual(sparseNonCoreGap.recommendation, "apply",
  "普通附带要求缺口必须保留说明，但不得单独阻止主投或可投");
assert(sparseNonCoreGap.softGaps.includes("客户需求沟通未找到直接简历证据"),
  "普通附带要求缺口仍必须保留在解释中");
assert.strictEqual(sparseNonCoreGap.confidence, 0.9);
assert.deepStrictEqual(sparseNonCoreGap.hardBlockers, []);
```

Keep the existing central, foundation, transferable, eligibility, and hard
blocker tests unchanged.

Add the equivalent legacy compact-path regression: an ordinary missing
requirement remains in `softGaps`, while the normalized recommendation remains
`apply`. This prevents the inactive-looking compatibility path from drifting
back to the old behavior.

- [x] **Step 2: Run the test and verify the intended red failure**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
```

Expected: exit 1 because the actual recommendation is `caution`, not `apply`.

- [x] **Step 3: Limit ranking signals to decision-bearing requirements**

In both `validateSparseMatchEvidence()` and
`validateCompactMatchEvidence()`, keep the display lists over all requirement
rows and derive separate decision lists:

```js
const unknownRequirements = requirementMatches.filter((item) => ["unknown", "not_applicable"].includes(item.state));
const unknownEligibility = eligibility.filter((item) => item.state === "unknown");
const transferable = requirementMatches.filter((item) => item.state === "transferable");
const softMissing = requirementMatches.filter((item) => item.state === "missing"
  && !hardBlockers.some((blocker) => blocker.requirement === item.requirement));
const decisionRequirements = requirementMatches.filter((item) => item.foundation || item.central || item.indispensable);
const decisionUnknownRequirements = unknownRequirements.filter((item) => decisionRequirements.includes(item));
const decisionTransferable = transferable.filter((item) => decisionRequirements.includes(item));
const decisionSoftMissing = softMissing.filter((item) => decisionRequirements.includes(item));
```

Use only the decision lists in recommendation selection:

```js
if (hardBlockers.length) recommendation = "skip";
else if (!requirementMatches.length || !hasPositiveRequirementEvidence
  || decisionUnknownRequirements.length || unknownEligibility.length
  || uncertainties.length || value.certainty === "low" || jobQuality.level === "risk") recommendation = "review";
else if (decisionTransferable.length || decisionSoftMissing.length
  || decisionCautions.length || jobQuality.level === "caution") recommendation = "caution";
else recommendation = "apply";
```

Continue using `unknownRequirements`, `transferable`, and `softMissing` when
building `questionsToVerify` and `softGaps`, so advisory information remains
visible.

- [x] **Step 4: Run the focused semantic test**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
```

Expected: `semantic pipeline smoke ok`.

- [x] **Step 5: Run adjacent decision tests**

Run:

```powershell
node tests/screening_quality_smoke.js
node tests/workflow_inventory_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: all three commands exit 0. In particular, the existing Java/role
evidence backup tests and hard-blocker tests remain green.

- [x] **Step 6: Commit Task 2**

```powershell
git add -- tests/semantic_pipeline_smoke.js src/core/model_contract.js
git commit -m "fix: keep advisory requirement gaps out of ranking"
```

---

### Task 3: Verify offline, then run two saved-JD live diagnostics

**Files:**

- No product files.
- Private output only:
  `D:\DevData\RoleFlow-private-benchmark\full-chain-v38-role-direction-weight-refinement-2-20260729`

**Interfaces:**

- Consumes: the frozen private inputs from the accepted 20-row run.
- Produces: two diagnostic rows for indices `1,14`; the output is not committed.

- [x] **Step 1: Run the full offline gate**

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/screening_quality_smoke.js
node tests/workflow_inventory_smoke.js
node tests/workflow_dashboard_smoke.js
npm.cmd test
git diff --check
git status --short
```

Expected: all focused tests pass, `npm.cmd test` reports every offline check
passed, `git diff --check` prints nothing, and the worktree is clean.

- [x] **Step 2: Create a fresh two-row private bundle**

```powershell
$source='D:\DevData\RoleFlow-private-benchmark\full-chain-v37-deepseek-adaptive-understanding-repair-20-20260729'
$root='D:\DevData\RoleFlow-private-benchmark\full-chain-v38-role-direction-weight-refinement-2-20260729'
$sourceCandidate='D:\DevData\RoleFlow-worktrees\deepseek-match-nonthinking-ab'
$candidate='D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$baseline='D:\DevData\RoleFlow-private-benchmark\baseline-worktree-empty-response-v1'
if(Test-Path -LiteralPath $root){ throw "Private output already exists: $root" }
New-Item -ItemType Directory -Path (Join-Path $root 'input') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'labels') -Force | Out-Null
foreach($name in @(
  'confirmed-card.private.json',
  'confirmed-profile.private.json',
  'identity.private.json',
  'jobs.private.json',
  'parse-report.json',
  'resume.redacted.txt'
)){
  Copy-Item -LiteralPath (Join-Path $source "input\$name") -Destination (Join-Path $root "input\$name")
}
Copy-Item -LiteralPath (Join-Path $source 'labels\jobs.reviewed.json') -Destination (Join-Path $root 'labels\jobs.reviewed.json')
```

Expected: the new root contains frozen input and labels only; there is no model
cache or result.

- [x] **Step 3: Stage the evaluated commit at the runner's fixed candidate worktree**

The runner intentionally accepts candidate live runs only from
`D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix`.
Do not weaken that gate. Record the fixed worktree's original branch and commit,
verify it is clean, then create a temporary branch there at the evaluated
documentation commit:

```powershell
$candidateProduct='c8281680304c19839e0f375ca3433943ca19d1b3'
$candidateEvaluated=(git -C $sourceCandidate rev-parse HEAD).Trim()
$originalCandidateBranch=(git -C $candidate branch --show-current).Trim()
$originalCandidateCommit=(git -C $candidate rev-parse HEAD).Trim()
if(git -C $candidate status --porcelain){ throw 'Fixed candidate worktree is dirty' }
git -C $sourceCandidate merge-base --is-ancestor $candidateProduct $candidateEvaluated
if($LASTEXITCODE -ne 0 -or $candidateProduct -eq $candidateEvaluated){
  throw 'Candidate product commit must be a strict ancestor of the evaluated documentation commit'
}
git -C $candidate switch -c codex/role-direction-weight-live-candidate $candidateEvaluated
Push-Location $candidate
```

Expected: the fixed candidate worktree is clean at the evaluated commit, while
the product commit is its strict ancestor. No main worktree is changed.

- [x] **Step 4: Initialize the manifest and evidence portability proof offline**

```powershell
$baselineProduct='fb0168afce265cf351f03e80f66d9e0f24015887'
node scripts/private-full-chain-runner.js --init-manifest `
  --private-root $root `
  --baseline-worktree $baseline `
  --candidate-worktree $candidate `
  --baseline-product-commit $baselineProduct `
  --candidate-product-commit $candidateProduct `
  --output (Join-Path $root 'run-manifest.json')
node scripts/private-full-chain-runner.js --create-portability-proof `
  --source-private-root 'D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725' `
  --private-root $root `
  --output (Join-Path $root 'input\confirmed-evidence-portability.json')
```

Expected: both commands exit 0 without a model call.

- [x] **Step 5: Run exactly the two saved-JD diagnostics**

The user already authorized small saved-JD real-model diagnostics. This step
does not authorize BOSS access.

```powershell
$env:ALLOW_PRIVATE_RESUME_BENCHMARK='YES'
$env:ALLOW_LIVE_MODEL_BENCHMARK='YES'
node scripts/private-full-chain-runner.js --match-live `
  --private-root $root `
  --side candidate `
  --profile (Join-Path $root 'input\confirmed-profile.private.json') `
  --matching-card (Join-Path $root 'input\confirmed-card.private.json') `
  --jobs (Join-Path $root 'input\jobs.private.json') `
  --labels (Join-Path $root 'labels\jobs.reviewed.json') `
  --portability-proof (Join-Path $root 'input\confirmed-evidence-portability.json') `
  --model-settings-root 'D:\Guo\ZhiPing' `
  --diagnostic-indices '1,14' `
  --output (Join-Path $root 'runs\candidate')
```

Expected:

- both rows complete with two normal model calls each and no contract repair;
- index 1 is at least `talk`, not `backup`;
- index 14 is `primary` or `talk`; either is accepted;
- neither row has a hard blocker;
- no recruitment platform, browser, main database, or port 8787 is touched.

- [x] **Step 6: Restore the fixed candidate worktree, then stop and report**

Restore the fixed candidate worktree even if the diagnostic fails:

```powershell
Pop-Location
git -C $candidate switch $originalCandidateBranch
if((git -C $candidate rev-parse HEAD).Trim() -ne $originalCandidateCommit){
  throw 'Fixed candidate worktree did not return to its original commit'
}
if(git -C $candidate status --porcelain){ throw 'Fixed candidate worktree is dirty after restore' }
```

Do not start another 20-row run. Report:

- the two final buckets and role alignments;
- per-stage and total elapsed time;
- model-call, attempt, empty-response, and repair counts;
- whether index 1 reached `talk`;
- whether index 14 stayed at or above `talk`;
- offline test results and the final commit range.

If either row is below `talk`, preserve the private root and diagnose before any
new live call.

## Execution Result (2026-07-29)

- Candidate product commit: `c8281680304c19839e0f375ca3433943ca19d1b3`.
- Candidate evaluated tooling commit: `f8d007ddef8c8a35f19c76bc5f43e334f44406bd`.
- The runner's fixed candidate worktree was temporarily switched to the
  evaluated commit and restored to
  `codex/claude-generic-evidence-matching-live-fix` at
  `1fc49dac3670a71c720bfcaed943fa29204d93c5` after the diagnostic.
- Sample 2 completed as `review` / `talk`, with
  `roleAlignment=mostly_aligned`, `foundationState=partial`, no hard blocker,
  two model calls, two attempts, zero empty responses, zero contract repairs,
  and `18,252 ms` total analysis time.
- Sample 15 completed as `caution` / `talk`, with
  `roleAlignment=mostly_aligned`, `foundationState=complete`, no hard blocker,
  two model calls, two attempts, zero empty responses, zero contract repairs,
  and `15,446 ms` total analysis time.
- Both rows met the user-approved retention floor (`talk`). The frozen exact
  label benchmark reports one of two rows as an exact pass because sample 15's
  historical label is `apply` / `primary`; this two-row diagnostic is not an
  acceptance-eligible full benchmark and does not claim exact-label parity.
- Private artifacts remain outside the repository at
  `D:\DevData\RoleFlow-private-benchmark\full-chain-v38-role-direction-weight-refinement-2-20260729`.

## Post-diagnostic Review

The first live diagnostic exercised the active sparse path and met both
retention floors, but the final review found two compatibility issues that had
to be fixed before completion:

- `835ae40` preserves the `foundation` flag in the legacy compact normalizer and
  adds a foundation-only regression. The missing flag could otherwise make a
  decision-bearing legacy requirement look advisory.
- `9b6b47f` advances `matchJob` from `match-decision-v23` to
  `match-decision-v24` and `decisionRules` from
  `role-direction-requirements-v1` to `role-direction-requirements-v2`. This
  invalidates old model-cache entries and marks stored analyses stale instead of
  silently retaining the previous role-family and requirement-weight behavior.

Neither fix weakens a hard boundary. Because they create a new final product
commit after the first diagnostic, the same two saved rows must be rerun in a
fresh private root and bound to `9b6b47f` before completion.

## Final Self-Review Checklist

- [x] The prompt clarification changes role-family interpretation without claiming that back-end evidence proves missing front-end skills.
- [x] Ordinary advisory gaps remain visible in `softGaps` or `questionsToVerify`.
- [x] Only `foundation`, `central`, or `indispensable` gaps affect ranking.
- [x] Hard blockers and existing safety boundaries are unchanged.
- [x] No third model call, taxonomy, dependency, schema change, or UI terminology change is introduced.
- [x] The two live rows use saved JD data only and stop before a 20-row run.
