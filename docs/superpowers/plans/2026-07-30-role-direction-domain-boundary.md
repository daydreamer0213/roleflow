# Role Direction Industry Context Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a job's industry context separately from its primary work, then judge role direction from the primary work while keeping industry, platform, and stack differences in requirement matching.

**Architecture:** Keep the existing `understandJob` and `matchJob` two-call pipeline. Add one flat `industryContext` field to the compact job-understanding contract, keep `roleSummary` limited to work object/action/deliverable, persist both fields, and explicitly tell `matchJob` that industry context does not define the role family by itself. Advance only the two affected model-pipeline versions; do not change local ranking or hard-boundary algorithms.

**Tech Stack:** Node.js 22, CommonJS, built-in `assert`, existing model adapter, SQLite model cache, and the private full-chain runner.

## Global Constraints

- Work only in `D:\DevData\RoleFlow-worktrees\deepseek-match-nonthinking-ab`; use the fixed candidate worktree only for commit-bound live execution and restore it afterward.
- Do not access BOSS or another recruitment platform, do not operate a browser, and do not touch `D:\Guo\ZhiPing\data\jobs.sqlite` or port 8787.
- Keep one normal `understandJob` call and one normal `matchJob` call. Do not add a third model stage.
- `industryContext` is one flat non-empty string, not a taxonomy, nested object, score, or local keyword classifier.
- `roleSummary` describes only the primary work object, action, and deliverable.
- Industry, business domain, customer type, named platform, framework, and stack do not define the role family by themselves.
- Missing industry/platform/stack evidence remains visible in requirements, `roleGaps`, `softGaps`, or `questionsToVerify`; it is never invented.
- A legal licence or real eligibility restriction continues through the existing `eligibility` boundary.
- An industry that changes the actual work or deliverable is represented in `roleSummary`; for example, strategy research and backtesting are different work from ordinary AI-application delivery.
- A UI component-library and multi-device visual-delivery role remains different from back-end or AI-application delivery.
- Eligibility conflicts, indispensable blockers, job-quality risk, salary floor, location, internship, exclusion words, and all existing evidence guards remain unchanged.
- Current 20-row labels contain only `keep` dispositions, so the run measures recall and ranking but cannot prove obvious-mismatch exclusion precision.

---

### Task 1: Extract and persist flat industry context

**Files:**

- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `tests/model_adapter_smoke.js`
- Modify: `src/core/model_contract.js`
- Modify: `src/adapters/models/mock.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/core/job_analysis.js`
- Modify: `src/core/analysis_revision.js`

**Interfaces:**

- Consumes: compact `understandJob` JSON.
- Produces: normalized `JobUnderstanding.industryContext:string`, persisted `analysis.industryContext:string`, and cache version `job-understanding-v13`.

- [ ] **Step 1: Write failing compact-contract and persistence tests**

Add `industryContext: "企业服务"` to canonical compact understanding fixtures. Add:

```js
assert.strictEqual(compact.industryContext, "企业服务");

const missingIndustry = { ...compactInput };
delete missingIndustry.industryContext;
assert.throws(
  () => validateModelResult("understandJob", missingIndustry),
  (error) => error instanceof ModelContractError
    && error.code === "MODEL_CONTRACT_INVALID"
    && /industryContext/.test(error.message),
  "紧凑 understandJob 缺少 industryContext 必须进入一次契约修复"
);

assert.throws(
  () => validateModelResult("understandJob", { ...compactInput, industryContext: "   " }),
  (error) => error instanceof ModelContractError && /industryContext/.test(error.message),
  "industryContext 不能是空白字符串"
);
```

Include `"industryContext"` in the existing required-field loop, and include
`["industryContext", []]` in the invalid-type cases. This makes missing,
array-valued, and whitespace-only industry output fail closed before matching.

Extend `compactRoleEvidencePersistenceSmoke()`:

```js
assert.strictEqual(compact.industryContext, jobUnderstanding.industryContext);
for (const analysis of [ruleOnly, failed]) {
  assert.strictEqual(analysis.industryContext, "");
}
```

Legacy full-contract fixtures remain compatible and may normalize a missing industry context to `"未明确"`.

- [ ] **Step 2: Write failing prompt and version tests**

Add:

```js
assert(
  understandPrompt.includes("industryContext")
    && understandPrompt.includes("主体行业")
    && understandPrompt.includes("roleSummary 只描述主体工作")
    && understandPrompt.includes("工作对象、主要动作和交付结果")
    && understandPrompt.includes("不得根据公司名或常识猜测"),
  "understandJob 必须把主体行业和主体工作分开"
);
```

Change the exact version assertion:

```js
assert.strictEqual(PIPELINE_VERSIONS.understandJob, "job-understanding-v13");
```

Add:

```js
assert(
  analysisStaleReasons({
    revision: {
      ...currentRevision,
      pipelineVersions: { ...PIPELINE_VERSIONS, understandJob: "job-understanding-v12" }
    }
  }, currentRevision).includes("job_understanding_pipeline_changed")
);
```

- [ ] **Step 3: Run tests and verify intended red failures**

```powershell
node tests/semantic_pipeline_smoke.js
node tests/model_adapter_smoke.js
```

Expected: semantic smoke fails because the field is not validated/persisted and the version remains v12; adapter smoke fails because the prompt does not request the field.

- [ ] **Step 4: Implement the flat contract and persistence**

In `validateCompactJobUnderstanding`:

```js
const industryContext = requiredCompactString(value.industryContext, "industryContext");
```

Insert it immediately after `jobId` in the existing compact return object:

```js
industryContext,
```

In the legacy full-contract return object:

```js
industryContext: text(value.industryContext || value.businessScenario || "未明确"),
```

In `MockModelAdapter.understandJob`:

```js
industryContext: "未明确",
```

In rule-only and failed analysis shapes:

```js
industryContext: "",
```

In `compactAnalysis`:

```js
industryContext: understanding.industryContext || "未明确",
```

- [ ] **Step 5: Update the compact understanding prompt and cache version**

Use six exact fields:

```js
"只输出且必须输出这六个字段：industryContext、roleSummary、responsibilityEvidence、requirements[{label,foundation,central,indispensable,evidence}]、eligibility[非空字符串]、riskSignals[{type,severity,evidence}]。数组无内容时输出 []，不要输出其他字段。",
```

Add:

```js
"先分开提取主体行业和主体工作。industryContext 只用一个短语概括 JD 明确写出的主体行业或业务环境；未明确时写“未明确”，不得根据公司名或常识猜测。roleSummary 只描述主体工作，必须写明工作对象、主要动作和交付结果，不得用“电商岗位”“金融科技岗位”等行业名称代替工作内容。行业经验、指定平台、框架和技术栈继续拆入 requirements。",
```

Advance only:

```js
understandJob: "job-understanding-v13",
```

- [ ] **Step 6: Run the task gate**

```powershell
node tests/semantic_pipeline_smoke.js
node tests/model_adapter_smoke.js
node tests/workflow_dashboard_smoke.js
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 7: Commit the industry-context contract**

```powershell
git add -- tests/semantic_pipeline_smoke.js tests/model_adapter_smoke.js src/core/model_contract.js src/adapters/models/mock.js src/adapters/models/openai_compatible.js src/core/job_analysis.js src/core/analysis_revision.js
git commit -m "feat: extract industry context separately from primary work"
```

---

### Task 2: Keep industry differences out of role alignment

**Files:**

- Modify: `tests/model_adapter_smoke.js`
- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/core/analysis_revision.js`

**Interfaces:**

- Consumes: `jobUnderstanding.industryContext`, `roleSummary`, and `responsibilityEvidence`.
- Produces: unchanged sparse match JSON with cache version `match-decision-v25`.

- [ ] **Step 1: Write the failing match-prompt test**

```js
assert(
  matchPrompt.includes("jobUnderstanding.industryContext")
    && matchPrompt.includes("does not by itself define the role family")
    && matchPrompt.includes("same primary work")
    && matchPrompt.includes("mostly_aligned")
    && matchPrompt.includes("requirement gap")
    && matchPrompt.includes("actual work pattern or deliverable differs"),
  "matchJob 不得把行业、平台或技术栈差异冒充岗位方向差异"
);
```

- [ ] **Step 2: Write the failing match-version test**

Change:

```js
assert.strictEqual(PIPELINE_VERSIONS.matchJob, "match-decision-v25");
```

Add:

```js
assert(
  analysisStaleReasons({
    revision: {
      ...currentRevision,
      pipelineVersions: { ...PIPELINE_VERSIONS, matchJob: "match-decision-v24" }
    }
  }, currentRevision).includes("match_pipeline_changed")
);
```

- [ ] **Step 3: Run both tests and verify red failures**

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: adapter smoke fails at the new match-prompt assertion; semantic smoke fails because the current match version remains v24.

- [ ] **Step 4: Add the minimum generic match instruction**

After the existing main-role-family instruction, add:

```js
"Treat jobUnderstanding.industryContext as business context, not resume evidence. Industry, business domain, customer type, named platform, framework, or technology stack does not by itself define the role family. When the candidate proves the same primary work object, action, and software or AI-application delivery pattern, use mostly_aligned and keep uncovered domain, platform, or stack details as roleGaps and requirement gaps. Use partially_aligned or misaligned only when the actual work pattern or deliverable differs, such as UI component and visual delivery versus back-end delivery, strategy research and backtesting versus ordinary AI-application delivery, or sales versus implementation.",
```

Do not remove the existing reverse-inference rule for missing front-end, platform, specialist workflow, stack, or business-system evidence. Do not change the compact output shape.

- [ ] **Step 5: Advance only the match version**

```js
matchJob: "match-decision-v25",
```

Keep `understandJob` at `job-understanding-v13`, `decisionRules` at `role-direction-requirements-v2`, and `communication` at `communication-v2`.

- [ ] **Step 6: Run the product gate**

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/screening_quality_smoke.js
node tests/workflow_inventory_smoke.js
node tests/workflow_dashboard_smoke.js
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 7: Commit the product change**

```powershell
git add -- tests/model_adapter_smoke.js tests/semantic_pipeline_smoke.js src/adapters/models/openai_compatible.js src/core/analysis_revision.js
git commit -m "fix: keep industry context out of role alignment"
```

---

### Task 3: Create a strict-ancestor live checkpoint

**Files:**

- Modify: `docs/superpowers/plans/2026-07-30-role-direction-domain-boundary.md`

**Interfaces:**

- Produces: one docs-only evaluated commit whose parent contains both product commits.

- [ ] **Step 1: Record Tasks 1-2 red/green evidence and commits**

Mark Tasks 1-2 complete and append exact failing assertion messages, green commands, and both product commit hashes. Do not change product files.

- [ ] **Step 2: Commit the checkpoint**

```powershell
git add -- docs/superpowers/plans/2026-07-30-role-direction-domain-boundary.md
git commit -m "docs: prepare industry context live verification"
```

Expected: both product commits are strict ancestors of this docs-only evaluated commit.

---

### Task 4: Run one negative control and four positive saved-JD diagnostics

**Files:**

- No repository files.
- Private output: `D:\DevData\RoleFlow-private-benchmark\full-chain-v40-role-industry-boundary-5-20260730`

**Interfaces:**

- Consumes: frozen input and labels from `D:\DevData\RoleFlow-private-benchmark\full-chain-v39-role-direction-weight-refinement-20-20260730`.
- Produces: candidate diagnostic indices `0,2,3,13,19`.

- [ ] **Step 1: Create a fresh private bundle and commit-bound manifest**

Copy only frozen `input` files and `labels/jobs.reviewed.json`. Bind the approved baseline product, Task 2 product commit, and Task 3 evaluated commit using the existing private runner. Temporarily switch `D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix` to a new branch at the evaluated commit; do not weaken the fixed-path gate.

- [ ] **Step 2: Run exactly five diagnostic rows**

Run candidate `match-live` with:

```text
--diagnostic-indices 0,2,3,13,19
```

Acceptance:

- sample 1, whose primary work is UI/component/visual delivery, remains `backup`;
- samples 3, 4, 14, and 20 reach at least `talk`;
- all rows are complete and evidence-bearing, with no hard blocker;
- normal rows use one `understandJob` call and one `matchJob` call;
- one existing contract-repair attempt is allowed and must be reported;
- any failed, stale, pending, empty-response, or safety result stops the run.

- [ ] **Step 3: Restore the fixed candidate worktree**

Switch it back to `codex/claude-generic-evidence-matching-live-fix` at `1fc49dac3670a71c720bfcaed943fa29204d93c5`, and verify it is clean.

- [ ] **Step 4: Stop on an acceptance miss**

If the negative control is promoted or any positive row remains below `talk`, preserve the private root and diagnose before another live call. Do not start the final 20-row run.

---

### Task 5: Run the final 20-row candidate and reuse the unchanged baseline

**Files:**

- No repository files.
- Private output: `D:\DevData\RoleFlow-private-benchmark\full-chain-v41-role-industry-boundary-20-20260730`

**Interfaces:**

- Reuses baseline result: `D:\DevData\RoleFlow-private-benchmark\full-chain-v21-lightweight-acceptance-20260728\runs\baseline\match-result.json`.
- Produces: a new 20-row candidate result plus a hash-verified paired analysis.

- [ ] **Step 1: Re-verify baseline reuse identity**

Require exact equality for harness version, model identity, resume, identity manifest, confirmed profile, confirmed matching card, jobs, labels, label version, and evaluation policy hashes. Do not require the old run-manifest or portability-proof hash because both bind the historical candidate commit.

- [ ] **Step 2: Run candidate 20 rows only**

Use a fresh candidate SQLite cache and no diagnostic indices. Do not rerun the unchanged baseline.

- [ ] **Step 3: Produce the paired analysis**

Exclude only rows whose semantic status is `failed`, `stale`, or `pending`. Report comparable count; bucket upgrades/same/downgrades; candidate bucket, recommendation, role-alignment, and foundation distributions; total/average/median/maximum latency; model-call/attempt/empty-response/repair totals; and exact frozen-label matches as diagnostics.

Acceptance requires candidate failed/stale/pending/partial, `primaryWithoutEvidence`, `hardFalsePlacement`, and `falseHardExclusion` all to be zero, with every frozen `keep` opportunity retained. State that no expected-exclude rows means this fixture cannot validate obvious-mismatch exclusion precision.

---

### Task 6: Record, verify, review, and push

**Files:**

- Modify: `docs/superpowers/plans/2026-07-30-role-direction-domain-boundary.md`

- [ ] **Step 1: Record private-safe results**

Record only sample numbers, buckets, role/foundation states, timing/count metrics, commit hashes, and aggregate comparisons. Do not commit resume facts, JD text, company names, URLs, model endpoint, or credentials.

- [ ] **Step 2: Run the final offline gate**

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

Expected: focused tests pass, all offline checks pass, diff check is clean, and only the intended plan result is uncommitted.

- [ ] **Step 3: Commit the safe result**

```powershell
git add -- docs/superpowers/plans/2026-07-30-role-direction-domain-boundary.md
git commit -m "docs: record industry context boundary acceptance"
```

- [ ] **Step 4: Review the complete change**

Review from the pre-product documentation commit through `HEAD`, focusing on contract compatibility, cache invalidation, evidence boundaries, private-data leakage, and whether local hard filters changed.

- [ ] **Step 5: Push the isolated branch**

```powershell
git push origin codex/deepseek-match-nonthinking-ab
```

Do not merge to the main project and do not create a pull request.
