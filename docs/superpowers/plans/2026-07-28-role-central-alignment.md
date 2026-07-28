# Role Central Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distinguish role-defining requirements from hard requirements so that jobs with no résumé evidence for their actual work direction remain visible as unchecked backups instead of default-selected `talk` jobs.

**Architecture:** Extend each compact `understandJob.requirements` row with one optional `central` boolean, preserve it through the existing sparse `matchJob` normalization, and derive role-core evidence locally from `requirementMatches`. Keep the existing two model calls, sparse match response, hard-blocker rules, and workflow safety boundaries; only the final soft bucket changes when a complete analysis has role-defining requirements but no direct or transferable evidence for any of them.

**Tech Stack:** Node.js 22 CommonJS, built-in `node:test`/`assert` style smoke scripts, built-in SQLite, existing OpenAI-compatible adapter.

## Global Constraints

- Work only in `D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix` on branch `codex/claude-generic-evidence-matching-live-fix`.
- Do not modify `D:\Guo\ZhiPing`, its `data/jobs.sqlite`, or the running main dashboard on port 8787.
- Do not access BOSS or perform communication/application/favorite actions during implementation and offline tests.
- Keep exactly two model calls per analyzed job: `understandJob` and `matchJob`.
- Do not add a role taxonomy, occupation-specific keyword list, dependency, database migration, or third model call.
- `central` is a soft bucketing signal; it must never create a `hardBlocker` or `not_recommended` result by itself.
- Missing `central` in legacy results must not trigger contract repair; use the existing `indispensable` value as the compatibility fallback.
- Any live model run requires a separate explicit authorization and must use saved JD data, not a new BOSS visit.
- Any change that further reduces recall beyond `backup` and unchecked must stop for a quantified user decision.

---

### Task 1: Preserve role centrality in the compact model contract

**Files:**
- Modify: `src/adapters/models/openai_compatible.js:89-100`
- Modify: `src/core/model_contract.js:298-335`
- Modify: `src/core/model_contract.js:363-458`
- Modify: `src/core/analysis_revision.js:4-8`
- Test: `tests/model_adapter_smoke.js:192-220`
- Test: `tests/semantic_pipeline_smoke.js`

**Interfaces:**
- Consumes: compact `understandJob` output shaped as `{roleSummary, requirements, eligibility, riskSignals}`.
- Produces: `jobUnderstanding.coreRequirements[]` rows shaped as `{id, label, central, indispensable, evidence}`.
- Produces: sparse-match `requirementMatches[]` rows shaped as `{requirement, state, central, indispensable, jdEvidence, resumeEvidence}`.
- Compatibility: when `requirement.central` is absent, `central` equals `Boolean(requirement.indispensable)`.

- [ ] **Step 1: Add failing compact-contract tests**

Add a focused function to `tests/semantic_pipeline_smoke.js` and invoke it from the existing async smoke sequence:

```js
function compactCentralRequirementSmoke() {
  const understanding = validateModelResult("understandJob", {
    roleSummary: "负责大模型推理部署与硬件性能优化",
    requirements: [
      {
        label: "推理框架与硬件适配",
        central: true,
        indispensable: false,
        evidence: "JD：负责推理框架部署与硬件性能优化"
      },
      {
        label: "基础开发能力",
        central: false,
        indispensable: true,
        evidence: "JD：具备一定基础开发能力"
      }
    ],
    eligibility: [],
    riskSignals: []
  });
  assert.strictEqual(understanding.coreRequirements[0].central, true);
  assert.strictEqual(understanding.coreRequirements[1].central, false);

  const legacy = validateModelResult("understandJob", {
    roleSummary: "负责通用应用开发",
    requirements: [{
      label: "基础开发能力",
      indispensable: true,
      evidence: "JD：具备基础开发能力"
    }],
    eligibility: [],
    riskSignals: []
  });
  assert.strictEqual(legacy.coreRequirements[0].central, true);

  const decision = validateModelResult("matchJob", {
    matches: [{
      id: "R2",
      state: "matched",
      resumeEvidence: "简历：完成过企业级 RAG 后端开发"
    }],
    eligibility: []
  }, { jobUnderstanding: understanding });
  assert.strictEqual(decision.requirementMatches[0].central, true);
  assert.strictEqual(decision.requirementMatches[1].central, false);
}
```

Add prompt assertions to `tests/model_adapter_smoke.js`:

```js
assert(
  understandPrompt.includes("requirements[{label,central,indispensable,evidence}]"),
  "understandJob prompt 必须保留轻量 central 标记"
);
assert(
  understandPrompt.includes("基础开发") && understandPrompt.includes("不能单独") && understandPrompt.includes("central=true"),
  "通用能力不得冒充岗位主线"
);
```

- [ ] **Step 2: Run the focused tests and verify red**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
node tests/model_adapter_smoke.js
```

Expected:

- `semantic_pipeline_smoke.js` fails because `central` is missing from normalized requirements or matches.
- `model_adapter_smoke.js` fails because the prompt still requests `requirements[{label,indispensable,evidence}]`.
- Neither failure starts a real model request; the adapter smoke uses its local HTTP fixture.

- [ ] **Step 3: Implement the compact `central` field without adding repair pressure**

Update the `understandJob` prompt in `src/adapters/models/openai_compatible.js`:

```js
"只输出且必须输出这四个字段：roleSummary、requirements[{label,central,indispensable,evidence}]、eligibility[非空字符串]、riskSignals[{type,severity,evidence}]。数组无内容时输出 []，不要输出其他字段。",
"roleSummary 用一句话概括岗位真实主线。requirements 只收 JD 明确写出的任职要求；central=true 表示该要求直接定义岗位持续承担的主要工作，并能区分相邻岗位。基础开发、学习、沟通、责任心、通用排错等跨岗位能力不能单独标成 central=true。“优先、熟悉、了解”不妨碍一项要求成为 central=true。indispensable=true 仍只表示 JD 明确表达的不可替代硬条件；经验年限不得 indispensable=true。evidence 必须引用 JD 原文短句并以“JD：”开头。",
```

Update `understandingCoreRequirements()` in `src/core/model_contract.js`:

```js
return {
  label,
  central: typeof item.central === "boolean" ? item.central : Boolean(item.indispensable),
  indispensable: item.indispensable,
  evidence
};
```

Preserve `central` in `validateSparseMatchEvidence()`:

```js
const requirements = jobUnderstanding.coreRequirements.map((item, index) => ({
  id: requiredContractString(item.id || `R${index + 1}`, "matchJob", "jobUnderstanding.coreRequirements.id"),
  label: requiredContractString(item.label, "matchJob", "jobUnderstanding.coreRequirements.label"),
  central: typeof item.central === "boolean" ? item.central : Boolean(item.indispensable),
  indispensable: Boolean(item.indispensable),
  evidence: requiredContractString(item.evidence, "matchJob", "jobUnderstanding.coreRequirements.evidence")
}));
```

and:

```js
return {
  requirement: requirement.label,
  state: unverifiedIndispensableMissing ? "unknown" : match.state,
  central: requirement.central,
  indispensable: requirement.indispensable,
  jdEvidence: requirement.evidence,
  resumeEvidence: match.resumeEvidence
};
```

Do not reject an omitted `central` field and do not add it to `matchJob` model output.

Bump both pipeline versions in `src/core/analysis_revision.js` so modified prompts and local derivation cannot reuse pre-change cache entries:

```js
understandJob: "job-understanding-v11",
matchJob: "match-decision-v20",
```

- [ ] **Step 4: Run focused tests and verify green**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected:

- `model_adapter_smoke ok`
- `semantic_pipeline_smoke ok`
- The legacy no-`central` case passes without a repair call.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/adapters/models/openai_compatible.js src/core/model_contract.js src/core/analysis_revision.js tests/model_adapter_smoke.js tests/semantic_pipeline_smoke.js
git commit -m "feat: preserve role centrality in compact matching"
```

---

### Task 2: Demote unsupported role cores to an unchecked backup

**Files:**
- Modify: `src/core/model_contract.js:389-458`
- Modify: `src/core/storage.js:3304-3334`
- Test: `tests/semantic_pipeline_smoke.js`
- Test: `tests/workflow_inventory_smoke.js`

**Interfaces:**
- Consumes: `analysis.requirementMatches[]` with `central`, `state`, and evidence fields.
- Produces: `roleCoreEvidenceState(analysis) -> {centralRequirementCount, centralEvidenceCount, unproven}`.
- Produces: a leading fit reason `"岗位主线与当前简历证据偏离，需要作为备选人工查看。"` when `unproven` is true.
- Produces: `decisionBucket(job) === "backup"` for complete analyses with `unproven === true`.

- [ ] **Step 1: Add failing decision and workflow tests**

Add to `tests/semantic_pipeline_smoke.js`:

```js
function roleCentralBucketSmoke() {
  const analysis = {
    semanticStatus: "complete",
    recommendation: "review",
    fitLevel: "C",
    confidence: 0.45,
    fitReasons: ["基础开发能力：有直接简历证据"],
    requirementMatches: [
      {
        requirement: "推理框架与硬件适配",
        state: "unknown",
        central: true,
        indispensable: false,
        jdEvidence: "JD：负责推理框架部署与硬件适配",
        resumeEvidence: ""
      },
      {
        requirement: "基础开发能力",
        state: "matched",
        central: false,
        indispensable: true,
        jdEvidence: "JD：具备基础开发能力",
        resumeEvidence: "简历：完成过企业级 RAG 后端开发"
      }
    ],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [],
    evidence: {
      jd: ["JD：具备基础开发能力"],
      resume: ["简历：完成过企业级 RAG 后端开发"]
    }
  };
  assert.deepStrictEqual(roleCoreEvidenceState(analysis), {
    centralRequirementCount: 1,
    centralEvidenceCount: 0,
    unproven: true
  });
  assert.strictEqual(
    decisionBucket({ ...completeJob("role-core-unproven"), analysis, qualityTags: [], risks: [] }),
    "backup"
  );

  const transferable = {
    ...analysis,
    requirementMatches: analysis.requirementMatches.map((item, index) => (
      index === 0
        ? { ...item, state: "transferable", resumeEvidence: "简历：完成过模型服务部署与接口集成" }
        : item
    ))
  };
  assert.strictEqual(roleCoreEvidenceState(transferable).unproven, false);
  assert.strictEqual(
    decisionBucket({ ...completeJob("role-core-transferable"), analysis: transferable, qualityTags: [], risks: [] }),
    "talk"
  );
}
```

Import `roleCoreEvidenceState` from `src/core/model_contract.js` in that smoke.

Add a workflow assertion to `tests/workflow_inventory_smoke.js` using the same complete-analysis shape:

```js
assert.deepStrictEqual(
  workflowEligibility(job("role-core-unproven", { analysis: roleCoreUnprovenAnalysis() }), { now }),
  { eligible: false, tier: "", reasonCode: "WORKFLOW_BACKUP_NOT_LOW_RISK" }
);
```

This proves the job is not default-selected into the formal communication review list. It remains in the decision pool as `backup`.

- [ ] **Step 2: Run the focused tests and verify red**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
node tests/workflow_inventory_smoke.js
```

Expected:

- semantic smoke fails because `roleCoreEvidenceState` does not exist or the job still maps to `talk`.
- workflow inventory smoke fails because the job is still eligible as `talk`.

- [ ] **Step 3: Implement one shared role-core evidence helper**

Add to `src/core/model_contract.js`:

```js
function roleCoreEvidenceState(analysis = {}) {
  const central = (analysis.requirementMatches || []).filter((item) => item?.central === true);
  const centralEvidence = central.filter((item) => (
    ["matched", "transferable"].includes(item.state)
      && typeof item.resumeEvidence === "string"
      && Boolean(item.resumeEvidence.trim())
  ));
  return {
    centralRequirementCount: central.length,
    centralEvidenceCount: centralEvidence.length,
    unproven: central.length > 0 && centralEvidence.length === 0
  };
}
```

Export it from `src/core/model_contract.js`.

In the sparse decision derivation, prepend the explanatory fit reason only when the helper reports `unproven`:

```js
const roleCore = roleCoreEvidenceState({ requirementMatches });
const fitReasons = [
  ...(roleCore.unproven ? ["岗位主线与当前简历证据偏离，需要作为备选人工查看。"] : []),
  ...requirementMatches
    .filter((item) => ["matched", "transferable"].includes(item.state))
    .map((item) => `${item.requirement}：${item.state === "matched" ? "有直接简历证据" : "有可迁移简历证据"}`)
].slice(0, 8);
```

Do not create a blocker, change `recommendation` to `skip`, or remove the job.

- [ ] **Step 4: Apply the helper in the final bucket**

Import `roleCoreEvidenceState` in `src/core/storage.js`.

Inside the `semanticStatus === "complete"` branch of `decisionBucket()` and after hard risk checks, add:

```js
if (roleCoreEvidenceState(analysis).unproven) return "backup";
```

Keep existing hard-blocker, safety, salary, refresh, pending, and stale ordering unchanged.

- [ ] **Step 5: Run focused and adjacent regressions**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
node tests/workflow_inventory_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
```

Expected:

- Each smoke prints its existing `ok` line.
- Generic evidence smoke still reports six passing samples.
- Benchmark reports `fixtures ok (31)`.
- Existing explicit eligibility, indispensable-core, and safety exclusions remain unchanged.

- [ ] **Step 6: Commit Task 2**

```powershell
git add src/core/model_contract.js src/core/storage.js tests/semantic_pipeline_smoke.js tests/workflow_inventory_smoke.js
git commit -m "fix: keep unsupported role cores out of default communication"
```

---

### Task 3: Document behavior and verify the complete offline boundary

**Files:**
- Modify: `docs/product_spec.md:79-85`
- Verify: `tests/run_all.js`

**Interfaces:**
- Documents: role-defining `central` versus hard-gate `indispensable`.
- Documents: role-core mismatch maps to visible `backup`, not hard exclusion or default communication.

- [ ] **Step 1: Update the product behavior**

Add to the evidence-matching section of `docs/product_spec.md`:

```markdown
- 每条岗位要求同时区分“是否定义岗位主线”和“是否为不可替代硬门槛”。主线要求即使写成“熟悉、了解、优先”，仍可用于判断岗位实际方向；它不会单独形成硬阻断。
- 完整 JD 已识别出岗位主线、但当前简历对所有主线要求都没有直接或可迁移证据时，岗位进入备选并取消默认勾选。它仍可查看和手动选择，不会被写成候选人明确不能胜任。
```

- [ ] **Step 2: Run the complete offline suite**

Run:

```powershell
npm.cmd test
git diff --check
git status --short
```

Expected:

- `All 47 offline checks passed`
- `git diff --check` prints nothing.
- `git status --short` lists only `docs/product_spec.md` before the documentation commit.

- [ ] **Step 3: Commit Task 3**

```powershell
git add docs/product_spec.md
git commit -m "docs: explain role central alignment"
```

- [ ] **Step 4: Verify final branch state**

Run:

```powershell
git status -sb
git log --oneline -5
git diff 4a753c3..HEAD --check
```

Expected:

- Worktree is clean.
- Three implementation commits follow design commit `4a753c3`.
- Diff check prints nothing.

---

### Task 4: Perform staged real-model acceptance only after authorization

**Files:**
- Read only: `D:\DevData\RoleFlow-private-benchmark\full-flow-review-20260728-01\runtime\jobs-formal.sqlite`
- Output only: a new subdirectory under `D:\DevData\RoleFlow-private-benchmark\`

**Interfaces:**
- Consumes: saved complete JD rows and the existing approved private model configuration boundary.
- Produces: timing, request-count, repair-count, recommendation, bucket, and default-selection evidence.

- [ ] **Step 1: Stop and obtain one explicit authorization**

Request authorization covering:

- one saved-JD real-model analysis for the inference-deployment job;
- if that passes, five saved-JD analyses consisting of two obvious direction mismatches, two aligned roles, and one boundary role;
- no BOSS navigation and no communication action.

Do not treat earlier benchmark authorization as approval for this new post-change run.

- [ ] **Step 2: Run one saved-JD analysis**

Use a fresh external runtime directory and copied test database. Do not mutate the completed formal-flow database.

Record:

```text
jobId
understandJob elapsedMs
matchJob elapsedMs
understandJob repairCount
matchJob repairCount
modelCallCount
recommendation
decisionBucket
defaultChecked
centralRequirementCount
centralEvidenceCount
```

Expected:

- `modelCallCount === 2`
- both repair counts are zero
- the inference-deployment job is `backup`
- `defaultChecked === false`

- [ ] **Step 3: Run the five-row sample only if the single row passes**

Acceptance:

- both obvious direction mismatches are not default selected;
- both aligned Agent/RAG roles remain `talk` or `primary`;
- the boundary role remains visible and is not hard excluded solely for missing résumé evidence;
- no row uses more than two initial model calls;
- no new contract repair is attributable to `central`;
- compare median elapsed time with the accepted lightweight single-row diagnostic and report any material increase before a 20-row run.

- [ ] **Step 4: Report and stop before any 20-row rerun**

Provide the six-row results and recommend one of:

- proceed to 20 rows;
- adjust only the `central` prompt;
- revert the bucketing change.

Do not run 20 rows without a new user decision based on the measured six-row result.
