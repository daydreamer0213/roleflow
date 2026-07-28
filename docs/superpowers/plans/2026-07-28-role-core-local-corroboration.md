# Role Core Local Corroboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the confirmed matching card as a deterministic local corroboration signal so a model-omitted central requirement can move from `backup` to `talk` without creating evidence, weakening hard blockers, or adding a model call.

**Architecture:** `compactAnalysis()` derives a small index-only corroboration record from validated job understanding and the confirmed matching card. `roleCoreEvidenceState()` remains the single shared decision boundary used by the analysis guard, storage bucket, and workflow inventory. A separate local decision-rule revision invalidates old derived decisions while preserving both model-cache versions.

**Tech Stack:** Node.js CommonJS, built-in regular expressions and `Set`, existing assert-based smoke tests, existing private full-chain runner.

## Global Constraints

- Keep exactly two normal model calls per job; do not add a third adjudication call.
- Read only confirmed matching-card fields: `targetDirections`, `strongEvidence`, and `transferableCapabilities`.
- Do not use `userNotes` as candidate evidence.
- Local corroboration may only rescue `backup -> talk`; it must never create `primary`, `resumeEvidence`, or a hard blocker.
- Explicit `missing`, eligibility, indispensable-core, safety, location, internship, salary-floor, and user-exclusion boundaries remain unchanged.
- Add no occupation taxonomy, industry template, dependency, network call, or database migration.
- Do not access BOSS, any recruitment platform, the production database, or port 8787.
- Private live output stays under `D:\DevData\RoleFlow-private-benchmark`.

---

### Task 1: Derive confirmed-card corroboration and reuse it in the shared role-core state

**Files:**
- Modify: `src/core/job_analysis.js:1-360`
- Modify: `src/core/model_contract.js:985-999`
- Test: `tests/semantic_pipeline_smoke.js:1760-1850`

**Interfaces:**
- Consumes: `jobUnderstanding.coreRequirements[]` and `configs.matchingCard`.
- Produces: `buildRoleCoreCorroboration(jobUnderstanding, matchingCard) -> { requirementIndexes: number[] }`.
- Produces: `analysis.roleCoreCorroboration = { requirementIndexes: number[] }`.
- Extends: `roleCoreEvidenceState(analysis)` with `centralCorroborationCount`.
- Preserves: `roleCoreEvidenceState(analysis).unproven` as the only role-core downgrade input used by all callers.

- [ ] **Step 1: Add failing semantic tests for the bounded rescue**

Import `buildRoleCoreCorroboration` from `src/core/job_analysis.js` and add a focused smoke block:

```js
const understanding = {
  coreRequirements: [{
    label: "AI 工具实践",
    central: true,
    indispensable: false,
    evidence: "JD：能够使用 AI 工具完成实际任务"
  }]
};
const card = {
  targetDirections: ["AI 应用开发"],
  strongEvidence: [{ label: "Agent / RAG", evidence: "简历：完成 Agent 与 RAG 工作流交付" }],
  transferableCapabilities: [],
  userNotes: ["偏好不能作为证据"]
};
assert.deepStrictEqual(buildRoleCoreCorroboration(understanding, card), {
  requirementIndexes: [0]
});

const corroborated = {
  semanticStatus: "complete",
  recommendation: "review",
  fitLevel: "C",
  confidence: 0.45,
  requirementMatches: [{
    requirement: "AI 工具实践",
    state: "unknown",
    central: true,
    indispensable: false,
    jdEvidence: "JD：能够使用 AI 工具完成实际任务",
    resumeEvidence: ""
  }],
  roleCoreCorroboration: { requirementIndexes: [0] },
  jobQuality: { level: "normal", concerns: [] },
  hardBlockers: [],
  hiddenRisks: [],
  evidence: { jd: [], resume: [] }
};
assert.deepStrictEqual(roleCoreEvidenceState(corroborated), {
  centralRequirementCount: 1,
  centralEvidenceCount: 0,
  centralCorroborationCount: 1,
  unproven: false
});
assert.strictEqual(
  decisionBucket({ ...completeJob("local-corroboration"), analysis: corroborated, qualityTags: [], risks: [] }),
  "talk"
);
assert.strictEqual(
  applyRuleGuard(corroborated, completeJob("local-corroboration")).decisionSource,
  "role_core_local_corroboration"
);
```

Add negative cases:

```js
assert.deepStrictEqual(buildRoleCoreCorroboration({
  coreRequirements: [{
    label: "业务平台工作流程",
    central: true,
    indispensable: false,
    evidence: "JD：负责业务平台工作流程"
  }]
}, {
  targetDirections: [],
  strongEvidence: [{ label: "应用开发", evidence: "简历：负责平台开发工作" }],
  transferableCapabilities: []
}), { requirementIndexes: [] }, "只有通用中文词不得复核");

assert.deepStrictEqual(buildRoleCoreCorroboration(understanding, {
  targetDirections: [],
  strongEvidence: [{ label: "API 调试", evidence: "简历：完成 API 调试" }],
  transferableCapabilities: []
}), { requirementIndexes: [] }, "AI 不得作为 API 的子串命中");

assert.deepStrictEqual(buildRoleCoreCorroboration(understanding, null), {
  requirementIndexes: []
});

assert.strictEqual(roleCoreEvidenceState({
  ...corroborated,
  requirementMatches: [{ ...corroborated.requirementMatches[0], state: "missing", resumeEvidence: "简历：明确使用其他方向" }]
}).unproven, true, "明确 missing 不得被本地复核覆盖");
```

Update the existing zero-evidence expectation to include:

```js
centralCorroborationCount: 0
```

- [ ] **Step 2: Run the semantic smoke and verify RED**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
```

Expected: exit 1 because `buildRoleCoreCorroboration` is not exported or the unknown central row still enters `backup`.

- [ ] **Step 3: Implement the smallest pure matcher**

Add generic constants and helpers in `src/core/job_analysis.js`:

```js
const ROLE_CORROBORATION_STOP_BIGRAMS = new Set([
  "工作", "作流", "能力", "经验", "相关", "负责",
  "开发", "应用", "技术", "工具", "实践", "熟悉",
  "岗位", "要求", "项目", "业务", "系统", "平台"
]);

function latinTokens(value) {
  return new Set((String(value || "").toLowerCase().match(/[a-z][a-z0-9+#.-]*/g) || [])
    .filter((token) => token.length > 1));
}

function cjkBigrams(value) {
  const chars = (String(value || "").match(/[\u3400-\u9fff]/g) || []).join("");
  const result = new Set();
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const gram = chars.slice(index, index + 2);
    if (!ROLE_CORROBORATION_STOP_BIGRAMS.has(gram)) result.add(gram);
  }
  return result;
}

function textsCorroborate(requirement, fact) {
  const requirementLatin = latinTokens(requirement);
  const factLatin = latinTokens(fact);
  if ([...requirementLatin].some((token) => factLatin.has(token))) return true;
  const requirementCjk = cjkBigrams(requirement);
  const factCjk = cjkBigrams(fact);
  let matches = 0;
  for (const gram of requirementCjk) {
    if (factCjk.has(gram) && ++matches >= 2) return true;
  }
  return false;
}

function buildRoleCoreCorroboration(jobUnderstanding = {}, matchingCard = null) {
  if (!matchingCard || typeof matchingCard !== "object") return { requirementIndexes: [] };
  const facts = [
    ...(matchingCard.targetDirections || []),
    ...(matchingCard.strongEvidence || []).map((item) => `${item?.label || ""} ${item?.evidence || ""}`),
    ...(matchingCard.transferableCapabilities || []).map((item) => `${item?.label || ""} ${item?.evidence || ""}`)
  ].map((item) => String(item || "").trim()).filter(Boolean);
  const requirementIndexes = [];
  for (const [index, item] of (jobUnderstanding.coreRequirements || []).entries()) {
    if (item?.central !== true) continue;
    const requirement = `${item.label || ""} ${item.evidence || ""}`.trim();
    if (facts.some((fact) => textsCorroborate(requirement, fact))) requirementIndexes.push(index);
  }
  return { requirementIndexes };
}
```

In `compactAnalysis()` add only the index record:

```js
roleCoreCorroboration: buildRoleCoreCorroboration(understanding, configs.matchingCard),
```

Export `buildRoleCoreCorroboration`.

Update `roleCoreEvidenceState()` in `src/core/model_contract.js` so local indices count only when the corresponding central row is `unknown`:

```js
function roleCoreEvidenceState(analysis = {}) {
  const central = list(analysis.requirementMatches)
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.central === true
      || (typeof item?.central !== "boolean" && item?.indispensable === true));
  const centralEvidence = central.filter(({ item }) => (
    ["matched", "transferable"].includes(item.state)
      && typeof item.resumeEvidence === "string"
      && Boolean(item.resumeEvidence.trim())
  ));
  const localIndexes = new Set(list(analysis.roleCoreCorroboration?.requirementIndexes)
    .filter(Number.isInteger));
  const centralCorroboration = central.filter(({ item, index }) => (
    item?.state === "unknown" && localIndexes.has(index)
  ));
  return {
    centralRequirementCount: central.length,
    centralEvidenceCount: centralEvidence.length,
    centralCorroborationCount: centralCorroboration.length,
    unproven: central.length > 0
      && centralEvidence.length === 0
      && centralCorroboration.length === 0
  };
}
```

Reuse one computed role-core state in `applyRuleGuard()`:

```js
const roleCore = roleCoreEvidenceState(analysis);
if (roleCore.unproven) {
  return addGuard(analysis, "review", analysis.fitLevel || "C",
    "岗位主线与当前简历证据偏离，需要作为备选人工查看。",
    analysis.semanticStatus, "role_core_unproven_guard");
}
if (roleCore.centralCorroborationCount > 0 && analysis.recommendation === "review") {
  return addGuard(analysis, "review", analysis.fitLevel || "C",
    "确认匹配卡存在相关证据线索，建议先聊确认。",
    analysis.semanticStatus, "role_core_local_corroboration");
}
```

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
node tests/generic_evidence_matching_smoke.js
```

Expected: both exit 0. The generic fixture output remains unchanged because fixture analyses do not contain the new local corroboration record.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- src/core/job_analysis.js src/core/model_contract.js tests/semantic_pipeline_smoke.js
git commit -m "fix: corroborate omitted role evidence locally"
```

### Task 2: Version the local decision rule and verify every downstream consumer

**Files:**
- Modify: `src/core/analysis_revision.js:4-55`
- Test: `tests/semantic_pipeline_smoke.js:440-480,640-655,1480-1525`
- Test: `tests/screening_quality_smoke.js:320-405`
- Test: `tests/workflow_inventory_smoke.js:90-125`

**Interfaces:**
- Produces: `PIPELINE_VERSIONS.decisionRules = "role-core-corroboration-v1"`.
- Produces: stale reason `decision_rules_changed`.
- Preserves: `PIPELINE_VERSIONS.understandJob = "job-understanding-v11"` and `PIPELINE_VERSIONS.matchJob = "match-decision-v22"` so both model caches remain reusable.

- [ ] **Step 1: Write failing version and downstream tests**

Add:

```js
assert.strictEqual(PIPELINE_VERSIONS.decisionRules, "role-core-corroboration-v1");
assert.deepStrictEqual(analysisStaleReasons({
  revision: {
    ...currentPipelineRevision,
    pipelineVersions: {
      understandJob: PIPELINE_VERSIONS.understandJob,
      matchJob: PIPELINE_VERSIONS.matchJob
    }
  }
}, currentPipelineRevision), ["decision_rules_changed"]);
```

Add a workflow candidate whose analysis contains:

```js
roleCoreCorroboration: { requirementIndexes: [0] },
requirementMatches: [{
  requirement: "AI 工具实践",
  state: "unknown",
  central: true,
  indispensable: false,
  jdEvidence: "JD：使用 AI 工具完成任务",
  resumeEvidence: ""
}]
```

Assert `decisionBucket(...) === "talk"` and
`workflowEligibility(...).tier === "talk"`.

Add a screening case with the same corroborated analysis plus
`qualityTags:["salary_target_high"]`; assert it remains `backup`.

- [ ] **Step 2: Run the three target tests and verify RED**

```powershell
node tests/semantic_pipeline_smoke.js
node tests/screening_quality_smoke.js
node tests/workflow_inventory_smoke.js
```

Expected: at least the decision-rule version assertion fails because the version does not yet exist.

- [ ] **Step 3: Add the local decision version**

Update `src/core/analysis_revision.js`:

```js
const PIPELINE_VERSIONS = Object.freeze({
  understandJob: "job-understanding-v11",
  matchJob: "match-decision-v22",
  decisionRules: "role-core-corroboration-v1",
  communication: "communication-v2"
});
```

Add the stale check after the two model-pipeline checks:

```js
if (revision.pipelineVersions?.decisionRules !== PIPELINE_VERSIONS.decisionRules) {
  reasons.push("decision_rules_changed");
}
```

Do not change either model pipeline version.

- [ ] **Step 4: Run target and model-cache regressions**

```powershell
node tests/semantic_pipeline_smoke.js
node tests/screening_quality_smoke.js
node tests/workflow_inventory_smoke.js
node tests/model_adapter_smoke.js
```

Expected: all exit 0, and the model adapter test confirms no prompt or model-contract change.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- src/core/analysis_revision.js tests/semantic_pipeline_smoke.js tests/screening_quality_smoke.js tests/workflow_inventory_smoke.js
git commit -m "fix: version local role corroboration decisions"
```

### Task 3: Complete offline verification and bind the product commit

**Files:**
- No production files beyond Tasks 1-2.
- Update only this plan's checkboxes if execution tracking is committed.

**Interfaces:**
- Consumes: Task 1 and Task 2 commits.
- Produces: a clean, commit-bound candidate product commit suitable for the private runner.

- [ ] **Step 1: Run focused regression**

```powershell
node tests/semantic_pipeline_smoke.js
node tests/screening_quality_smoke.js
node tests/workflow_inventory_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
node tests/model_adapter_smoke.js
```

Expected: all commands exit 0.

- [ ] **Step 2: Run the full offline gate**

```powershell
npm.cmd test
git diff --check
git status --short
```

Expected: `All 47 offline checks passed`, no diff-check output, and an empty short status.

- [ ] **Step 3: Record immutable commit values**

```powershell
$candidateWorktree='D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$candidateProductCommit=(git -C $candidateWorktree rev-parse HEAD).Trim()
$baselineWorktree='D:\DevData\RoleFlow-private-benchmark\baseline-worktree-paired-overlap'
$baselineProductCommit='fb0168afce265cf351f03e80f66d9e0f24015887'
git -C $candidateWorktree status --porcelain
git -C $baselineWorktree status --porcelain
```

Expected: both status commands produce no output.

### Task 4: Run four small private diagnostics without recruitment-site access

**Files:**
- Private source: `D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725`
- Private frozen input: `D:\DevData\RoleFlow-private-benchmark\full-chain-v28-role-central-evidence-retry-20260728`
- Private outputs: four new directories under `D:\DevData\RoleFlow-private-benchmark`
- Create report: `docs/superpowers/reports/2026-07-28-role-core-local-corroboration-recheck.md`

**Interfaces:**
- Consumes: existing runner mode `--diagnostic-indices`.
- Produces: three independent index-1 results and one index-0 control result.
- Produces: aggregate-only report; no title, company, JD, resume text, identifiers, endpoint, key, or model name.

- [ ] **Step 1: Create four fresh private bundles**

```powershell
$sourceEvidence='D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725'
$frozenInput='D:\DevData\RoleFlow-private-benchmark\full-chain-v28-role-central-evidence-retry-20260728'
$runs=@(
  @{Name='full-chain-v29-role-corroboration-a-20260728';Index='1'},
  @{Name='full-chain-v29-role-corroboration-b-20260728';Index='1'},
  @{Name='full-chain-v29-role-corroboration-c-20260728';Index='1'},
  @{Name='full-chain-v29-role-corroboration-control-20260728';Index='0'}
)
foreach($run in $runs){
  $root=Join-Path 'D:\DevData\RoleFlow-private-benchmark' $run.Name
  if(Test-Path -LiteralPath $root){ throw "Private output already exists: $root" }
  New-Item -ItemType Directory -Path (Join-Path $root 'input') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $root 'labels') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $frozenInput 'input\confirmed-card.private.json') -Destination (Join-Path $root 'input\confirmed-card.private.json')
  Copy-Item -LiteralPath (Join-Path $frozenInput 'input\confirmed-profile.private.json') -Destination (Join-Path $root 'input\confirmed-profile.private.json')
  Copy-Item -LiteralPath (Join-Path $frozenInput 'input\identity.private.json') -Destination (Join-Path $root 'input\identity.private.json')
  Copy-Item -LiteralPath (Join-Path $frozenInput 'input\jobs.private.json') -Destination (Join-Path $root 'input\jobs.private.json')
  Copy-Item -LiteralPath (Join-Path $frozenInput 'input\parse-report.json') -Destination (Join-Path $root 'input\parse-report.json')
  Copy-Item -LiteralPath (Join-Path $frozenInput 'input\resume.redacted.txt') -Destination (Join-Path $root 'input\resume.redacted.txt')
  Copy-Item -LiteralPath (Join-Path $frozenInput 'labels\jobs.reviewed.json') -Destination (Join-Path $root 'labels\jobs.reviewed.json')
}
```

Expected: four new roots containing only frozen input and labels; no old model cache or result is copied.

- [ ] **Step 2: Initialize manifests and offline portability proofs**

For each `$run`:

```powershell
$root=Join-Path 'D:\DevData\RoleFlow-private-benchmark' $run.Name
node scripts/private-full-chain-runner.js --init-manifest `
  --private-root $root `
  --baseline-worktree $baselineWorktree `
  --candidate-worktree $candidateWorktree `
  --baseline-product-commit $baselineProductCommit `
  --candidate-product-commit $candidateProductCommit `
  --output (Join-Path $root 'run-manifest.json')
node scripts/private-full-chain-runner.js --create-portability-proof `
  --source-private-root $sourceEvidence `
  --private-root $root `
  --output (Join-Path $root 'input\confirmed-evidence-portability.json')
```

Expected: both commands exit 0 without model or network access.

- [ ] **Step 3: Run the four diagnostics serially**

The user has already granted `ALLOW_PRIVATE_RESUME_BENCHMARK=YES` and
`ALLOW_LIVE_MODEL_BENCHMARK=YES` for small saved-JD diagnostics.

```powershell
$env:ALLOW_PRIVATE_RESUME_BENCHMARK='YES'
$env:ALLOW_LIVE_MODEL_BENCHMARK='YES'
foreach($run in $runs){
  $root=Join-Path 'D:\DevData\RoleFlow-private-benchmark' $run.Name
  node scripts/private-full-chain-runner.js --match-live `
    --private-root $root `
    --side candidate `
    --profile (Join-Path $root 'input\confirmed-profile.private.json') `
    --matching-card (Join-Path $root 'input\confirmed-card.private.json') `
    --jobs (Join-Path $root 'input\jobs.private.json') `
    --labels (Join-Path $root 'labels\jobs.reviewed.json') `
    --portability-proof (Join-Path $root 'input\confirmed-evidence-portability.json') `
    --model-settings-root 'D:\Guo\ZhiPing' `
    --diagnostic-indices $run.Index `
    --output (Join-Path $root 'runs\candidate')
  if($LASTEXITCODE -ne 0){ throw "Diagnostic failed: $($run.Name)" }
}
```

Expected:

- each run has exactly one row and `diagnosticMode:true`;
- all four runs have `failed=0`, `pending=0`, `partial=0`;
- all three index-1 runs end in `talk`;
- the index-0 control remains `backup`;
- no hard blocker appears;
- adapter logs show the existing two stages only.

- [ ] **Step 4: Stop if the small gate fails**

If any index-1 run remains `backup`, the control becomes `talk`, a new hard blocker appears, or a run fails, do not run 20 rows. Record the actual result and return to root-cause analysis.

- [ ] **Step 5: Write a privacy-safe report**

Create `docs/superpowers/reports/2026-07-28-role-core-local-corroboration-recheck.md` with only:

- candidate product and evaluated commit hashes;
- four private result paths and SHA-256 values;
- aggregate elapsed time and safe status fields;
- the three index-1 buckets and one control bucket;
- model-stage count and contract-repair count;
- explicit go/no-go recommendation.

Do not include title, company, JD, resume text, matching-card content, row ID, endpoint, API key, or model name.

- [ ] **Step 6: Verify, commit, and push the report**

```powershell
git diff --check
Select-String -LiteralPath 'docs/superpowers/reports/2026-07-28-role-core-local-corroboration-recheck.md' `
  -Pattern '郭铭福|zhipin\.com|apiKey|Bearer|D:\\Guo\\ZhiPing|sourceId|jobId'
git add -- docs/superpowers/reports/2026-07-28-role-core-local-corroboration-recheck.md
git commit -m "docs: record local role corroboration recheck"
git push
git status -sb
```

Expected: privacy scan has no matches, commit and push succeed, and the branch is clean and synchronized.

## Completion Decision

- Do not merge into the active project in this plan.
- Do not run another 20-row live cycle automatically.
- If the four-row gate passes, report measured behavior and ask the user whether to run the 20-row acceptance.
- If it fails, preserve all private outputs and report the root cause without widening the rule or adding a third model call.
