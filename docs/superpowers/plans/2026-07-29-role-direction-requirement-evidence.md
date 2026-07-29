# Role Direction and Requirement Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不增加正常模型调用次数的前提下，把“岗位主体方向”和“逐条任职要求”分开匹配，再用同一套本地规则稳定映射到主投、可投、慎投、不推荐四档。

**Architecture:** 保留现有 `understandJob -> matchJob` 两阶段链路。第一阶段从完整 JD 输出岗位主体、主体证据和带 `foundation` 标记的原子要求；第二阶段同时输出主体匹配和逐项简历证据。本地只新增一个共享的 `roleEvidenceDecisionState()`，供分析守卫、数据库分桶和工作流默认勾选共同使用，避免三处规则漂移。历史分析继续可读，新版本缓存通过流水线版本失效后重新生成。

**Tech Stack:** Node.js、CommonJS、内置 `assert`、SQLite、现有 OpenAI-compatible adapter、现有 dashboard HTTP renderer、现有 private full-chain runner。

## Global Constraints

- 只在 `D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix` 和分支 `codex/claude-generic-evidence-matching-live-fix` 实施。
- 不修改或运行 `D:\Guo\ZhiPing` 的业务代码、`data/jobs.sqlite` 或 8787 工作台；正式项目路径只可在已授权的私有 runner 门禁通过后作为模型设置根目录使用，禁止打印配置、密钥、端点或模型名。
- 不访问 BOSS 或其他招聘平台；真实验收只读取已经冻结的 JD、私有画像、已确认匹配卡和真实简历派生物。
- 正常成功路径必须始终恰好两次模型调用：`understandJob` 一次、`matchJob` 一次。契约非法时仍只允许现有的一次修复；不得新增第三个“职业判断”调用。
- 不新增职业枚举表、关键词相似度救回、数据库迁移、外部依赖或 Markdown 模型输出。
- `roleAlignment` 只设置推荐上限，不单独制造硬淘汰；`not_recommended` 仍只来自现有硬边界或具有双侧证据的结构化硬冲突。
- `AI`、`Agent`、`RAG`、AI 编程工具等方法词不能代替前端、UI、全栈、ERP、图像生成等具体工作对象和交付证据。
- `userNotes` 仍是用户偏好，不得作为 `roleResumeEvidence` 或逐项 `resumeEvidence`。
- 不把聊天中提到的“使用 Claude Code/Codex”自动写入已确认画像或匹配卡；本计划只保留现有用户确认入口。
- 每个任务先写失败测试，确认失败原因与目标行为一致，再写最小实现；每个任务单独提交。
- 离线全绿前不得运行真实模型。两岗位小样本未通过前不得运行 20 条。

## File and Interface Map

### Product code

- Modify: `src/core/model_contract.js`
  - Add `ROLE_ALIGNMENT_STATES`.
  - Validate `responsibilityEvidence`, `foundation`, `roleAlignment`, `roleResumeEvidence`, `roleGaps`.
  - Preserve `foundation` from understanding into normalized requirement matches.
  - Replace the old single-purpose `roleCoreEvidenceState()` decision use with shared `roleEvidenceDecisionState()`, while keeping the old export for historical compatibility tests.
- Modify: `src/adapters/models/openai_compatible.js`
  - Keep two prompts and flat JSON.
  - Add responsibility/foundation instructions to `understandJob`.
  - Add role-alignment fields and work-object evidence rules to `matchJob`.
  - Add safe successful response character count to model-call telemetry.
- Modify: `src/adapters/models/mock.js`
  - Emit deterministic valid fields for offline paths; do not pretend to perform full semantic occupation inference.
- Modify: `src/core/job_analysis.js`
  - Persist the new normalized fields.
  - Apply one shared recommendation ceiling.
  - Keep failed/rule-only analyses safe and readable.
- Modify: `src/core/analysis_revision.js`
  - Bump both model-stage versions.
  - Add a local decision-rules version and stale reason.
- Modify: `src/core/storage.js`
  - Use `roleEvidenceDecisionState()` in `decisionBucket()`.
- Modify: `src/core/workflow_inventory.js`
  - Use the same shared state for eligibility, tier and default selection.
- Modify: `src/dashboard/server.js`
  - Show user-facing role direction, alignment, foundation evidence and unresolved foundation items.
  - Never display internal enum names.

### Offline tests

- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `tests/model_adapter_smoke.js`
- Modify: `tests/screening_quality_smoke.js`
- Modify: `tests/workflow_inventory_smoke.js`
- Modify: `tests/workflow_dashboard_smoke.js`
- Modify: `tests/self_check.js`
- Modify: `tests/private_full_chain_runner_smoke.js`
- Modify if affected by shared fixtures: `tests/generic_evidence_matching_smoke.js`

### Private acceptance tooling

- Modify: `scripts/private-full-chain-runner.js`
  - Add privacy-safe enum and numeric diagnostic fields only.
  - Do not store role evidence text, resume text, JD text, title, company, model identity or endpoint in reports.
- Create after live execution: `docs/superpowers/reports/2026-07-29-role-direction-requirement-evidence-diagnostic.md`
- Create only after explicit 20-row gate decision: `docs/superpowers/reports/2026-07-29-role-direction-requirement-evidence-20.md`

---

## Task 1: Add responsibility and foundation fields to job understanding

**Files:**

- Modify: `src/core/model_contract.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/adapters/models/mock.js`
- Test: `tests/semantic_pipeline_smoke.js`
- Test: `tests/model_adapter_smoke.js`

**Interfaces:**

```js
// Raw understandJob output
{
  roleSummary: "利用 AI 编程工具交付企业业务系统的全栈开发",
  responsibilityEvidence: ["JD：完成企业业务系统前后端开发、联调与上线"],
  requirements: [{
    label: "后端开发能力",
    foundation: true,
    central: false,
    indispensable: false,
    evidence: "JD：后端熟悉 Python 或 Node.js"
  }],
  eligibility: [],
  riskSignals: []
}
```

- [ ] **Step 1: Add failing contract tests**

In `tests/semantic_pipeline_smoke.js`, add compact-understanding cases that assert:

```js
assert.throws(
  () => validateModelResult("understandJob", {
    roleSummary: "企业业务系统全栈交付",
    requirements: [],
    eligibility: [],
    riskSignals: []
  }),
  (error) => error.code === "MODEL_CONTRACT_INVALID" && /responsibilityEvidence/.test(error.message)
);

assert.throws(
  () => validateModelResult("understandJob", {
    roleSummary: "企业业务系统全栈交付",
    responsibilityEvidence: ["负责企业系统开发"],
    requirements: [],
    eligibility: [],
    riskSignals: []
  }),
  (error) => error.code === "MODEL_CONTRACT_INVALID" && /JD：/.test(error.message)
);

assert.throws(
  () => validateModelResult("understandJob", {
    roleSummary: "企业业务系统全栈交付",
    responsibilityEvidence: ["JD：完成企业业务系统开发"],
    requirements: [{
      label: "后端开发能力",
      central: false,
      indispensable: false,
      evidence: "JD：熟悉 Python"
    }],
    eligibility: [],
    riskSignals: []
  }),
  (error) => error.code === "MODEL_CONTRACT_INVALID" && /foundation/.test(error.message)
);
```

Also assert:

- `responsibilityEvidence: []` is valid;
- more than four responsibility rows are truncated to four;
- each responsibility row is a non-empty string beginning with `JD：` and no longer than 120 characters;
- `foundation` must be a real boolean;
- normalized `coreRequirements[0].foundation` is preserved.

- [ ] **Step 2: Add failing prompt-shape tests**

In `tests/model_adapter_smoke.js`, assert the captured `understandJob` prompt contains all of:

```text
responsibilityEvidence
foundation
工作对象
主要动作
交付结果
复合要求必须拆开
```

Assert it still requests JSON and does not request Markdown.

- [ ] **Step 3: Run the focused red tests**

```powershell
node tests/semantic_pipeline_smoke.js
node tests/model_adapter_smoke.js
```

Expected: failures mention missing `responsibilityEvidence`, missing `foundation`, or the new prompt phrases only.

- [ ] **Step 4: Implement strict compact-understanding validation**

In `src/core/model_contract.js`, add a dedicated validator:

```js
function responsibilityEvidenceList(value) {
  if (!Array.isArray(value)) {
    throw new ModelContractError("understandJob", "responsibilityEvidence 必须是字符串数组");
  }
  return value.map((item) => {
    const evidence = requiredContractString(item, "understandJob", "responsibilityEvidence");
    if (!evidence.startsWith("JD：") || evidence.length > 120) {
      throw new ModelContractError(
        "understandJob",
        "responsibilityEvidence 必须以“JD：”开头且不超过 120 个字符"
      );
    }
    return evidence;
  }).slice(0, 4);
}
```

Update compact understanding normalization to require and return:

```js
{
  ...normalized,
  responsibilityEvidence: responsibilityEvidenceList(value.responsibilityEvidence),
  coreRequirements: understandingCoreRequirements(value.requirements, { requireFoundation: true })
}
```

Update `understandingCoreRequirements()` so compact output requires:

```js
if (requireFoundation && typeof item.foundation !== "boolean") {
  throw new ModelContractError(
    "understandJob",
    `coreRequirements「${label}」的 foundation 必须是 boolean`
  );
}
```

Return:

```js
{
  label,
  foundation: requireFoundation ? item.foundation : Boolean(item.foundation),
  central: typeof item.central === "boolean" ? item.central : Boolean(item.indispensable),
  indispensable: item.indispensable,
  evidence
}
```

Keep historical normalized understanding objects readable by supplying `requireFoundation:false` outside the new compact raw path.

- [ ] **Step 5: Replace the `understandJob` prompt shape**

In `src/adapters/models/openai_compatible.js`, request exactly five top-level fields:

```text
roleSummary
responsibilityEvidence
requirements
eligibility
riskSignals
```

State explicitly:

- `roleSummary` must contain work object, main action and deliverable;
- `responsibilityEvidence` contains at most four direct JD snippets;
- section headings are unreliable, so split by meaning after reading the full JD;
- `foundation=true` only when the requirement directly supports the main deliverable;
- front end, back end and database/API ability are separate requirements;
- AI/tool words alone do not define the job body or foundation;
- an alternative list such as “Python or Node.js” may remain one requirement;
- no third-party inference and no copied full JD.

- [ ] **Step 6: Make mock output structurally valid**

In `src/adapters/models/mock.js`, add:

```js
responsibilityEvidence: coreResponsibilities
  .map((item) => `JD：${String(item?.evidence || item?.label || "").replace(/^JD：/, "")}`)
  .filter((item) => item !== "JD：")
  .slice(0, 4)
```

Every mock requirement must include a deterministic boolean `foundation`. Use an existing explicit flag when present; otherwise use `Boolean(item.central || item.indispensable)`. This is an offline structural fallback, not a semantic occupation decision.

- [ ] **Step 7: Run green tests and commit**

```powershell
node tests/semantic_pipeline_smoke.js
node tests/model_adapter_smoke.js
git diff --check
git add -- src/core/model_contract.js src/adapters/models/openai_compatible.js src/adapters/models/mock.js tests/semantic_pipeline_smoke.js tests/model_adapter_smoke.js
git commit -m "feat: extract role responsibility and foundation evidence"
```

Expected: both tests pass and the commit contains only the five listed files.

---

## Task 2: Add strict role-alignment evidence to matchJob

**Files:**

- Modify: `src/core/model_contract.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/adapters/models/mock.js`
- Test: `tests/semantic_pipeline_smoke.js`
- Test: `tests/model_adapter_smoke.js`

**Interfaces:**

```js
const ROLE_ALIGNMENT_STATES = [
  "aligned",
  "mostly_aligned",
  "partially_aligned",
  "misaligned",
  "insufficient_evidence"
];

// Raw matchJob output remains flat.
{
  roleAlignment: "mostly_aligned",
  roleResumeEvidence: ["简历：使用 Python/FastAPI 参与业务系统后端开发"],
  roleGaps: ["前端开发和完整全栈交付尚未证明"],
  matches: [],
  eligibility: []
}
```

- [ ] **Step 1: Add failing sparse-contract tests**

In `tests/semantic_pipeline_smoke.js`, cover:

- missing `roleAlignment`;
- illegal enum;
- non-array `roleResumeEvidence` or `roleGaps`;
- evidence not starting with `简历：`;
- `aligned`, `mostly_aligned` or `partially_aligned` without resume evidence;
- `misaligned` without responsibility evidence, resume evidence or a gap;
- `insufficient_evidence` without a concrete gap;
- empty `responsibilityEvidence` accepting only `insufficient_evidence`;
- `matches` cannot change `foundation`, `central` or `indispensable`;
- normalized requirement matches inherit all three flags from `jobUnderstanding`.

Use a valid sparse fixture:

```js
const sparse = {
  roleAlignment: "mostly_aligned",
  roleResumeEvidence: ["简历：使用 Python/FastAPI 参与业务系统后端开发"],
  roleGaps: ["前端交付尚未证明"],
  matches: [{ id: "R1", state: "matched", resumeEvidence: "简历：使用 Python 开发接口" }],
  eligibility: []
};
```

- [ ] **Step 2: Add failing prompt tests**

Assert the `matchJob` prompt:

- returns the three new role fields plus `matches` and `eligibility`;
- compares `roleSummary + responsibilityEvidence + candidate facts`;
- compares work object, action and deliverable rather than tool-word overlap;
- states that Agent/RAG/AI coding tools do not prove UI components or visual front-end delivery;
- states that Python/FastAPI/API/testing/debugging may prove only the back-end portion of a full-stack delivery;
- does not contain the old broad example saying Agent/RAG/Dify directly proves generic AI tool practice;
- still forbids `userNotes` as resume evidence;
- still outputs JSON only.

- [ ] **Step 3: Run the focused red tests**

```powershell
node tests/semantic_pipeline_smoke.js
node tests/model_adapter_smoke.js
```

Expected: only the new role contract and prompt assertions fail.

- [ ] **Step 4: Implement strict sparse role validation**

In `src/core/model_contract.js`, add:

```js
const ROLE_ALIGNMENT_STATES = Object.freeze([
  "aligned",
  "mostly_aligned",
  "partially_aligned",
  "misaligned",
  "insufficient_evidence"
]);
```

Add a helper that requires all new fields on the sparse/raw path:

```js
function validateRoleAlignmentEvidence(value, jobUnderstanding) {
  if (!ROLE_ALIGNMENT_STATES.includes(value.roleAlignment)) {
    throw new ModelContractError(
      "matchJob",
      `roleAlignment 必须是 ${ROLE_ALIGNMENT_STATES.join("/")}`
    );
  }
  const roleResumeEvidence = contractStringsStrict(
    value.roleResumeEvidence,
    "matchJob",
    "roleResumeEvidence",
    { prefix: "简历：", limit: 4, maxLength: 120 }
  );
  const roleGaps = contractStringsStrict(
    value.roleGaps,
    "matchJob",
    "roleGaps",
    { limit: 4, maxLength: 120 }
  );
  const responsibilityEvidence = jobUnderstanding?.responsibilityEvidence || [];
  if (!responsibilityEvidence.length && value.roleAlignment !== "insufficient_evidence") {
    throw new ModelContractError("matchJob", "职责证据为空时只能输出 insufficient_evidence");
  }
  if (["aligned", "mostly_aligned", "partially_aligned"].includes(value.roleAlignment)
    && !roleResumeEvidence.length) {
    throw new ModelContractError("matchJob", `${value.roleAlignment} 必须有 roleResumeEvidence`);
  }
  if (value.roleAlignment === "misaligned"
    && (!responsibilityEvidence.length || !roleResumeEvidence.length || !roleGaps.length)) {
    throw new ModelContractError("matchJob", "misaligned 必须同时有职责证据、简历事实和差距");
  }
  if (value.roleAlignment === "insufficient_evidence" && !roleGaps.length) {
    throw new ModelContractError("matchJob", "insufficient_evidence 必须说明缺少什么证据");
  }
  return { roleAlignment: value.roleAlignment, roleResumeEvidence, roleGaps };
}
```

`contractStringsStrict()` must reject missing/non-array fields instead of silently treating them as `[]`.

Merge the helper result into `validateSparseMatchEvidence()` and copy source flags:

```js
{
  requirement,
  state,
  foundation: Boolean(source.foundation),
  central: Boolean(source.central),
  indispensable: Boolean(source.indispensable),
  jdEvidence: source.evidence,
  resumeEvidence: match.resumeEvidence
}
```

Update cross-field validation so the match result must preserve `foundation`, `central` and `indispensable` from understanding. The model never supplies or overrides these flags.

- [ ] **Step 5: Preserve historical normalized decisions**

`validateMatchDecision()` is also used when reading old normalized cache/results. Do not reject an old object solely because it lacks the three new role fields. Normalize only that legacy path to:

```js
{
  roleAlignment: ROLE_ALIGNMENT_STATES.includes(value.roleAlignment)
    ? value.roleAlignment
    : "",
  roleResumeEvidence: Array.isArray(value.roleResumeEvidence)
    ? contractStrings(value.roleResumeEvidence, 4)
    : [],
  roleGaps: Array.isArray(value.roleGaps)
    ? contractStrings(value.roleGaps, 4)
    : []
}
```

An empty alignment means “historical semantics”; it must never be mistaken for `aligned`. New sparse adapter output remains strict.

- [ ] **Step 6: Replace the `matchJob` prompt and update mock**

Return exactly:

```json
{
  "roleAlignment": "mostly_aligned",
  "roleResumeEvidence": ["简历：具体事实"],
  "roleGaps": ["具体未证明部分"],
  "matches": [{"id":"R1","state":"matched","resumeEvidence":"简历：具体事实"}],
  "eligibility": []
}
```

For the mock adapter:

- return `insufficient_evidence` with a concrete gap when no responsibility evidence exists;
- otherwise use `partially_aligned` only when there is at least one positive deterministic requirement match;
- never emit `aligned` or `mostly_aligned` from keyword overlap;
- keep mock results clearly offline-only.

- [ ] **Step 7: Run green tests and commit**

```powershell
node tests/semantic_pipeline_smoke.js
node tests/model_adapter_smoke.js
git diff --check
git add -- src/core/model_contract.js src/adapters/models/openai_compatible.js src/adapters/models/mock.js tests/semantic_pipeline_smoke.js tests/model_adapter_smoke.js
git commit -m "feat: match job direction with explicit evidence"
```

Expected: strict sparse tests pass, historical normalized fixtures still load, and no third adapter call exists.

---

## Task 3: Implement one shared role-plus-foundation decision state

**Files:**

- Modify: `src/core/model_contract.js`
- Modify: `src/core/job_analysis.js`
- Modify: `src/core/storage.js`
- Modify: `src/core/workflow_inventory.js`
- Test: `tests/semantic_pipeline_smoke.js`
- Test: `tests/screening_quality_smoke.js`
- Test: `tests/workflow_inventory_smoke.js`

**Interface:**

```js
roleEvidenceDecisionState(analysis) === {
  semantics: "layered",
  alignment: "mostly_aligned",
  foundationState: "partial",
  foundationRequirementCount: 3,
  foundationPositiveCount: 2,
  hasTransferableFoundation: false,
  bucketCeiling: "talk",
  reasonCode: "role_mostly_aligned"
}
```

- [ ] **Step 1: Add the full decision-matrix tests**

In `tests/semantic_pipeline_smoke.js`, add table-driven tests:

```js
[
  ["aligned", ["matched", "matched"], "primary"],
  ["aligned", ["matched", "unknown"], "talk"],
  ["aligned", ["transferable", "matched"], "talk"],
  ["aligned", ["unknown", "missing"], "backup"],
  ["mostly_aligned", ["matched", "matched"], "talk"],
  ["mostly_aligned", ["matched", "unknown"], "talk"],
  ["mostly_aligned", ["unknown", "missing"], "backup"],
  ["partially_aligned", ["matched"], "backup"],
  ["misaligned", ["matched"], "backup"],
  ["insufficient_evidence", ["matched"], "backup"]
]
```

Also assert:

- a new layered analysis with zero foundation requirements is `backup`;
- role misalignment alone never produces `not_recommended`;
- a valid hard blocker still produces `not_recommended`;
- the old no-role/no-foundation analysis follows `roleCoreEvidenceState()` exactly;
- the two disputed synthetic cases resolve to:

```js
// AI-assisted front-end/UI
{ roleAlignment: "misaligned", foundationState: "unproven", bucket: "backup" }

// AI-assisted business full stack
{ roleAlignment: "mostly_aligned", foundationState: "partial", bucket: "talk" }
```

- [ ] **Step 2: Add cross-consumer failing tests**

In `tests/screening_quality_smoke.js` and `tests/workflow_inventory_smoke.js`, prove that the same analysis gets the same ceiling from:

```js
applyRuleGuard(analysis, job)
decisionBucket({ ...job, analysis })
workflowEligibility({ ...job, analysis })
```

Expected red failure: current code only understands `roleCoreEvidenceState().unproven`, so `mostly_aligned + partial` and `misaligned` do not consistently map.

- [ ] **Step 3: Implement the shared helper**

In `src/core/model_contract.js`, add:

```js
function roleEvidenceDecisionState(analysis = {}) {
  const matches = Array.isArray(analysis.requirementMatches)
    ? analysis.requirementMatches
    : [];
  const hasLayeredSemantics = ROLE_ALIGNMENT_STATES.includes(analysis.roleAlignment);
  const foundation = matches.filter((item) => item?.foundation === true);

  if (!hasLayeredSemantics) {
    const legacy = roleCoreEvidenceState(analysis);
    return {
      semantics: "legacy",
      alignment: "",
      foundationState: legacy.unproven ? "unproven" : "none",
      foundationRequirementCount: 0,
      foundationPositiveCount: 0,
      hasTransferableFoundation: false,
      bucketCeiling: legacy.unproven ? "backup" : "primary",
      reasonCode: legacy.unproven ? "legacy_role_core_unproven" : ""
    };
  }

  const positive = foundation.filter((item) =>
    ["matched", "transferable"].includes(item.state)
  );
  const foundationState = !foundation.length
    ? "none"
    : !positive.length
      ? "unproven"
      : positive.length === foundation.length
        ? "complete"
        : "partial";
  const hasTransferableFoundation = foundation.some(
    (item) => item.state === "transferable"
  );

  let bucketCeiling = "backup";
  if (analysis.roleAlignment === "aligned"
    && foundationState === "complete"
    && !hasTransferableFoundation) {
    bucketCeiling = "primary";
  } else if (
    (analysis.roleAlignment === "aligned"
      && ["complete", "partial"].includes(foundationState))
    || (analysis.roleAlignment === "mostly_aligned"
      && ["complete", "partial"].includes(foundationState))
  ) {
    bucketCeiling = "talk";
  }

  return {
    semantics: "layered",
    alignment: analysis.roleAlignment,
    foundationState,
    foundationRequirementCount: foundation.length,
    foundationPositiveCount: positive.length,
    hasTransferableFoundation,
    bucketCeiling,
    reasonCode: roleEvidenceReasonCode(analysis.roleAlignment, foundationState)
  };
}
```

Export it. Keep `roleCoreEvidenceState()` exported for old data/tests, but no new decision consumer may call it directly.

- [ ] **Step 4: Apply the ceiling without promotion**

In `src/core/job_analysis.js`, after existing hard boundaries, structured blockers, evidence completeness and risk checks:

```js
const roleEvidence = roleEvidenceDecisionState(analysis);
if (roleEvidence.bucketCeiling === "backup") {
  return addGuard(
    analysis,
    "review",
    analysis.fitLevel || "C",
    roleEvidenceGuardReason(roleEvidence),
    analysis.semanticStatus,
    "role_evidence_backup_guard"
  );
}
if (roleEvidence.bucketCeiling === "talk" && analysis.recommendation === "apply") {
  return addGuard(
    analysis,
    "caution",
    analysis.fitLevel === "A" ? "B" : analysis.fitLevel,
    roleEvidenceGuardReason(roleEvidence),
    analysis.semanticStatus,
    "role_evidence_talk_guard"
  );
}
```

This code only downgrades. It must not turn `review` into `caution` or turn `caution` into `apply`.

- [ ] **Step 5: Use the same helper in storage and workflow**

In `src/core/storage.js`, replace the old role-core condition with:

```js
const roleEvidence = roleEvidenceDecisionState(analysis);
if (roleEvidence.bucketCeiling === "backup") return "backup";
if (roleEvidence.bucketCeiling === "talk" && analysis.recommendation === "apply") {
  return "talk";
}
```

Keep this after hard boundaries/hard blockers and before any path that could return `primary`.

In `src/core/workflow_inventory.js`:

- replace `WORKFLOW_ROLE_CORE_UNPROVEN` with `WORKFLOW_ROLE_EVIDENCE_BACKUP` for new layered analyses;
- use workflow tier `role_evidence_backup`;
- exclude `role_evidence_backup` from default checked rows;
- continue recognizing legacy `role_core_backup` for historical rows;
- preserve existing high-salary backup behavior.

- [ ] **Step 6: Run green tests and commit**

```powershell
node tests/semantic_pipeline_smoke.js
node tests/screening_quality_smoke.js
node tests/workflow_inventory_smoke.js
git diff --check
git add -- src/core/model_contract.js src/core/job_analysis.js src/core/storage.js src/core/workflow_inventory.js tests/semantic_pipeline_smoke.js tests/screening_quality_smoke.js tests/workflow_inventory_smoke.js
git commit -m "feat: combine role direction and foundation evidence"
```

Expected: every consumer agrees on the bucket ceiling and no role-only case becomes a hard exclusion.

---

## Task 4: Persist new fields and invalidate old semantic caches

**Files:**

- Modify: `src/core/job_analysis.js`
- Modify: `src/core/analysis_revision.js`
- Test: `tests/semantic_pipeline_smoke.js`
- Test: `tests/self_check.js`

**Interfaces:**

```js
const PIPELINE_VERSIONS = Object.freeze({
  understandJob: "job-understanding-v12",
  matchJob: "match-decision-v23",
  decisionRules: "role-direction-requirements-v1",
  communication: "communication-v2"
});
```

- [ ] **Step 1: Add failing persistence and revision tests**

Assert `compactAnalysis()` retains:

```js
{
  roleSummary,
  responsibilityEvidence,
  roleAlignment,
  roleResumeEvidence,
  roleGaps,
  requirementMatches // including foundation
}
```

Assert:

- failed and rule-only analyses use `roleAlignment:""` and empty evidence/gaps;
- changing only `decisionRules` yields stale reason `decision_rules_changed`;
- old revision objects remain readable but stale;
- pipeline versions are exactly v12/v23 plus the new decision-rules version;
- an unchanged current revision is not stale.

- [ ] **Step 2: Run red tests**

```powershell
node tests/semantic_pipeline_smoke.js
node tests/self_check.js
```

Expected: new persisted fields/version assertions fail.

- [ ] **Step 3: Persist fields without changing database schema**

In `compactAnalysis()` add:

```js
responsibilityEvidence: understanding.responsibilityEvidence || [],
roleAlignment: decision.roleAlignment || "",
roleResumeEvidence: decision.roleResumeEvidence || [],
roleGaps: decision.roleGaps || [],
```

Keep `coreRequirements` as its existing label list for historical renderers. The authoritative flags remain in `requirementMatches`; do not introduce a second requirements representation.

Add the same empty defaults to rule-only and failed analyses.

- [ ] **Step 4: Version both model stages and local rules**

In `src/core/analysis_revision.js`:

```js
const PIPELINE_VERSIONS = Object.freeze({
  understandJob: "job-understanding-v12",
  matchJob: "match-decision-v23",
  decisionRules: "role-direction-requirements-v1",
  communication: "communication-v2"
});
```

Add:

```js
if (revision.pipelineVersions?.decisionRules !== PIPELINE_VERSIONS.decisionRules) {
  reasons.push("decision_rules_changed");
}
```

Do not delete old cache rows. The versioned cache key makes them unreachable for new analysis, and stale analysis remains inspectable.

- [ ] **Step 5: Update shared offline fixtures and run green**

Update common fixtures in `tests/self_check.js` and `tests/semantic_pipeline_smoke.js` with valid new fields. Avoid copying the fields into every one-off historical compatibility fixture; those fixtures should intentionally exercise the legacy path.

```powershell
node tests/semantic_pipeline_smoke.js
node tests/self_check.js
git diff --check
git add -- src/core/job_analysis.js src/core/analysis_revision.js tests/semantic_pipeline_smoke.js tests/self_check.js
git commit -m "feat: version layered role evidence analyses"
```

Expected: tests pass and no storage migration file changes.

---

## Task 5: Show both layers in the workflow and job detail UI

**Files:**

- Modify: `src/dashboard/server.js`
- Modify: `src/core/workflow_inventory.js`
- Test: `tests/workflow_dashboard_smoke.js`
- Test: `tests/workflow_inventory_smoke.js`

- [ ] **Step 1: Add failing user-visible tests**

In `tests/workflow_dashboard_smoke.js`, render a layered analysis and assert the HTML contains:

```text
岗位主体
主体匹配
基本一致
已覆盖根基
待确认根基
慎投
```

Assert it does not contain:

```text
mostly_aligned
foundationState
role_evidence_backup
insufficient_evidence
```

In `tests/workflow_inventory_smoke.js`, assert:

- `role_evidence_backup` is not default checked;
- `talk` remains default checked when capacity permits;
- legacy `role_core_backup` remains readable and unchecked.

- [ ] **Step 2: Run red tests**

```powershell
node tests/workflow_dashboard_smoke.js
node tests/workflow_inventory_smoke.js
```

Expected: new labels/sections are absent.

- [ ] **Step 3: Add minimal display helpers**

In `src/dashboard/server.js`, add pure helpers:

```js
function roleAlignmentLabel(value) {
  return {
    aligned: "一致",
    mostly_aligned: "基本一致",
    partially_aligned: "部分一致",
    misaligned: "不一致",
    insufficient_evidence: "证据不足，待确认"
  }[value] || "历史分析，待重新计算";
}

function foundationEvidenceLists(analysis) {
  const rows = (analysis?.requirementMatches || []).filter(
    (item) => item?.foundation === true
  );
  return {
    covered: rows.filter((item) =>
      ["matched", "transferable"].includes(item.state)
    ).map((item) => item.requirement),
    unresolved: rows.filter((item) =>
      !["matched", "transferable"].includes(item.state)
    ).map((item) => item.requirement)
  };
}
```

Render:

- `岗位主体：${roleSummary}`;
- `主体匹配：${roleAlignmentLabel(roleAlignment)}`;
- `主体依据` only as a count in list/workflow views, not raw resume text;
- `已覆盖根基` and `待确认根基` using requirement labels;
- existing fit reasons and hard blockers after the two-layer summary.

Raw role resume evidence may appear only in the authenticated job-detail view if that view already displays other resume evidence. It must never appear in aggregate reports or runner output.

- [ ] **Step 4: Update workflow tier label and style**

Add:

```js
role_evidence_backup: "慎投"
```

Apply the same visual style as the existing yellow backup tiers. Do not rename the public four buckets.

- [ ] **Step 5: Run green tests and commit**

```powershell
node tests/workflow_dashboard_smoke.js
node tests/workflow_inventory_smoke.js
git diff --check
git add -- src/dashboard/server.js src/core/workflow_inventory.js tests/workflow_dashboard_smoke.js tests/workflow_inventory_smoke.js
git commit -m "feat: explain layered role evidence in workflow"
```

Expected: the user sees plain Chinese explanations and no internal enum leaks.

---

## Task 6: Add privacy-safe latency and role diagnostics to the private runner

**Files:**

- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `scripts/private-full-chain-runner.js`
- Test: `tests/model_adapter_smoke.js`
- Test: `tests/private_full_chain_runner_smoke.js`

**Safe row fields:**

```js
{
  roleAlignment: "mostly_aligned",
  foundationState: "partial",
  analysisElapsedMs: 38210,
  understandJobLatencyMs: 15100,
  matchJobLatencyMs: 22400,
  modelCallCount: 2,
  contractRepairCount: 0,
  responseContentChars: 3412
}
```

- [ ] **Step 1: Add failing telemetry tests**

In `tests/model_adapter_smoke.js`, use a fake response and assert `model_call_completed` contains an integer `contentLength` but still does not expose response content.

In `tests/private_full_chain_runner_smoke.js`, inject safe logger events and assert the row:

- contains only the safe enum/numeric fields above;
- counts exactly two successful normal calls;
- increments `contractRepairCount` only on `model_contract_repair_requested`;
- sums response character counts;
- defaults invalid enum/numeric telemetry safely;
- contains no `provider`, `model`, `baseUrl`, `apiKey`, prompt, JD, resume evidence, title or company;
- does not change `deriveBenchmarkMetrics()` pass/fail semantics.

- [ ] **Step 2: Run red tests**

```powershell
node tests/model_adapter_smoke.js
node tests/private_full_chain_runner_smoke.js
```

Expected: successful response length and private row telemetry are missing.

- [ ] **Step 3: Emit safe response size**

In `OpenAICompatibleAdapter.requestJson()`, return:

```js
{
  value: parseJsonContent(content),
  usage: normalizeUsage(data.usage),
  httpStatus: res.status,
  providerRequestId: requestId,
  contentLength: content.length
}
```

In `model_call_completed`, add only:

```js
contentLength: response.contentLength
```

Do not log the content.

- [ ] **Step 4: Collect per-row private telemetry**

In `scripts/private-full-chain-runner.js`, define safe sets:

```js
const SAFE_ROLE_ALIGNMENTS = new Set([
  "aligned",
  "mostly_aligned",
  "partially_aligned",
  "misaligned",
  "insufficient_evidence"
]);
const SAFE_FOUNDATION_STATES = new Set([
  "none",
  "unproven",
  "partial",
  "complete"
]);
```

Use a serial, resettable collector around each `analyze(job)` call. Store only event name, safe stage enum and bounded integers. Never store the logger payload wholesale.

Compute:

```js
roleAlignment: safeEnum(
  analysis.roleAlignment,
  SAFE_ROLE_ALIGNMENTS,
  "insufficient_evidence"
),
foundationState: safeEnum(
  modules.roleEvidenceDecisionState(analysis).foundationState,
  SAFE_FOUNDATION_STATES,
  "none"
),
analysisElapsedMs,
understandJobLatencyMs,
matchJobLatencyMs,
modelCallCount,
contractRepairCount,
responseContentChars
```

Expose `roleEvidenceDecisionState` through the existing private module loader rather than duplicating foundation rules in the runner.

- [ ] **Step 5: Run green tests and commit**

```powershell
node tests/model_adapter_smoke.js
node tests/private_full_chain_runner_smoke.js
git diff --check
git add -- src/adapters/models/openai_compatible.js scripts/private-full-chain-runner.js tests/model_adapter_smoke.js tests/private_full_chain_runner_smoke.js
git commit -m "test: record safe role matching diagnostics"
```

Expected: tests pass and private output contains no sensitive text or model identity.

---

## Task 7: Run the full offline regression gate

**Files:**

- Modify only if a real regression requires it: affected source/test files from Tasks 1–6
- No private or live artifacts yet

- [ ] **Step 1: Run focused tests**

```powershell
node tests/semantic_pipeline_smoke.js
node tests/model_adapter_smoke.js
node tests/screening_quality_smoke.js
node tests/workflow_inventory_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/private_full_chain_runner_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
node tests/self_check.js
```

Expected: every command exits 0.

- [ ] **Step 2: Run the complete offline suite**

```powershell
npm.cmd test
git diff --check
git status --short
```

Expected: all registered offline checks pass, `git diff --check` prints nothing, and the short status is empty.

- [ ] **Step 3: Verify the two-call invariant**

```powershell
rg -n "understandJob|matchJob|createJobAnalysisRunner" src/core/job_analysis.js src/adapters/models
```

Manually verify:

- normal `createJobAnalysisRunner()` still calls one `understandJob` and one `matchJob`;
- no new adapter method or third semantic stage exists;
- contract repair still runs at most once per invalid stage.

- [ ] **Step 4: Record the implementation checkpoint**

```powershell
git log --oneline --decorate -12
git status -sb
```

Expected: all Task 1–6 commits are present, the worktree is clean, and nothing has been merged into the active project.

---

## Task 8: Run a two-job private live diagnostic, then repeat only if stable

**Files and private inputs:**

- Source confirmed evidence: `D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725`
- Frozen JD/profile/card input: `D:\DevData\RoleFlow-private-benchmark\full-chain-v28-role-central-evidence-retry-20260728`
- Baseline worktree: `D:\DevData\RoleFlow-private-benchmark\baseline-worktree-role-direction-v1`
- Candidate worktree: `D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix`
- New private roots:
  - `D:\DevData\RoleFlow-private-benchmark\full-chain-v29-role-direction-front-a2-20260729`
  - `D:\DevData\RoleFlow-private-benchmark\full-chain-v29-role-direction-fullstack-a2-20260729`
  - repeat roots use suffixes `-b-20260729` and `-c-20260729`
- Create aggregate-only report: `docs/superpowers/reports/2026-07-29-role-direction-requirement-evidence-diagnostic.md`

The user has already authorized private-resume and live-model saved-JD diagnostics. These commands still require both environment gates on every process. They do not authorize recruitment-site access.

- [ ] **Step 0: Create the dedicated harness-only baseline**

Do not mutate the earlier paired-overlap baseline. From the approved baseline
product commit, create a new isolated worktree and copy only the three shared
runner files from the clean candidate:

```powershell
$candidateWorktree='D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$baselineWorktree='D:\DevData\RoleFlow-private-benchmark\baseline-worktree-role-direction-v1'
$baselineBranch='codex/role-direction-private-baseline-v1'
$baselineProductCommit='fb0168afce265cf351f03e80f66d9e0f24015887'
git -C $candidateWorktree worktree add -b $baselineBranch $baselineWorktree $baselineProductCommit
New-Item -ItemType Directory -Path (Join-Path $baselineWorktree 'scripts\lib') -Force | Out-Null
foreach($relative in @(
  'scripts\private-full-chain-runner.js',
  'scripts\lib\benchmark_metrics.js',
  'scripts\lib\private_resume_privacy.js'
)){
  Copy-Item -LiteralPath (Join-Path $candidateWorktree $relative) -Destination (Join-Path $baselineWorktree $relative)
}
git -C $baselineWorktree add -- scripts/private-full-chain-runner.js scripts/lib/benchmark_metrics.js scripts/lib/private_resume_privacy.js
git -C $baselineWorktree commit -m "test: sync layered role evidence diagnostic harness"
```

Expected: the baseline evaluated commit has exactly the approved baseline
product commit as its single parent; its three shared file blobs equal the
candidate HEAD blobs; both worktrees are clean.

- [ ] **Step 1: Verify immutable code state**

```powershell
$candidateWorktree='D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$baselineWorktree='D:\DevData\RoleFlow-private-benchmark\baseline-worktree-role-direction-v1'
$candidateProductCommit='ac8fe5b479f63f58fd1fd0d1756d934e7d1853f2'
$candidateEvaluatedCommit=(git -C $candidateWorktree rev-parse HEAD).Trim()
$baselineProductCommit='fb0168afce265cf351f03e80f66d9e0f24015887'
git -C $candidateWorktree status --porcelain
git -C $baselineWorktree status --porcelain
git -C $candidateWorktree merge-base --is-ancestor $candidateProductCommit $candidateEvaluatedCommit
```

Expected: both status commands print nothing, the candidate product commit is a
strict ancestor of the evaluated candidate HEAD, and the baseline is a dedicated
harness-only descendant of the approved baseline product commit. The three
shared runner blobs must be identical between the two worktrees.

- [ ] **Step 2: Create two fresh, cache-empty diagnostic bundles**

```powershell
$sourceEvidence='D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725'
$frozenInput='D:\DevData\RoleFlow-private-benchmark\full-chain-v28-role-central-evidence-retry-20260728'
$runs=@(
  @{Name='full-chain-v29-role-direction-front-a2-20260729';Index='0'},
  @{Name='full-chain-v29-role-direction-fullstack-a2-20260729';Index='1'}
)
foreach($run in $runs){
  $root=Join-Path 'D:\DevData\RoleFlow-private-benchmark' $run.Name
  if(Test-Path -LiteralPath $root){ throw "Private output already exists: $root" }
  New-Item -ItemType Directory -Path (Join-Path $root 'input') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $root 'labels') -Force | Out-Null
  foreach($relative in @(
    'input\confirmed-card.private.json',
    'input\confirmed-profile.private.json',
    'input\identity.private.json',
    'input\jobs.private.json',
    'input\parse-report.json',
    'input\resume.redacted.txt',
    'labels\jobs.reviewed.json'
  )){
    $destination=Join-Path $root $relative
    Copy-Item -LiteralPath (Join-Path $frozenInput $relative) -Destination $destination
  }
}
```

Expected: only frozen inputs and labels are copied; no previous `model-cache.sqlite` or match result exists.

- [ ] **Step 3: Initialize manifests and portability proofs offline**

```powershell
foreach($run in $runs){
  $root=Join-Path 'D:\DevData\RoleFlow-private-benchmark' $run.Name
  node scripts/private-full-chain-runner.js --init-manifest `
    --private-root $root `
    --baseline-worktree $baselineWorktree `
    --candidate-worktree $candidateWorktree `
    --baseline-product-commit $baselineProductCommit `
    --candidate-product-commit $candidateProductCommit `
    --output (Join-Path $root 'run-manifest.json')
  if($LASTEXITCODE -ne 0){ throw "Manifest failed: $($run.Name)" }
  node scripts/private-full-chain-runner.js --create-portability-proof `
    --source-private-root $sourceEvidence `
    --private-root $root `
    --output (Join-Path $root 'input\confirmed-evidence-portability.json')
  if($LASTEXITCODE -ne 0){ throw "Portability proof failed: $($run.Name)" }
}
```

Expected: both commands for both roots exit 0 without model calls.

- [ ] **Step 4: Run exactly one fresh candidate analysis for each disputed job**

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

- each result contains exactly one row;
- each row has `modelCallCount === 2`;
- each row has `contractRepairCount === 0`;
- `failed/pending/partial` are all zero;
- index 0: `roleAlignment === "misaligned"`, `foundationState === "unproven"`, `actualBucket === "backup"`;
- index 1: `roleAlignment === "mostly_aligned"`, `foundationState === "partial"`, `actualBucket === "talk"`;
- no row has a hard blocker;
- each row completes within the 180-second outer safety limit;
- no BOSS/browser process is used.

- [ ] **Step 5: Stop and diagnose before repeats if Gate A fails**

Stop without creating more live calls if any functional condition above fails or
if a contract repair occurs. The earlier 90-second hard stop is intentionally
retired: previous accepted evidence measured an 84.04-second median and a
147.18-second maximum, so 90 seconds misclassifies known model-service variance.
Use a 180-second outer safety limit per row. A row between 90 and 180 seconds is
a performance warning that must be reported, not a functional failure. If a row
is still running at 180 seconds, terminate that exact process, preserve the two
private roots and inspect only:

- safe enums;
- stage latency;
- response character count;
- call/repair counts;
- safe error metadata.

Do not print JD, resume evidence, card content, model identity or settings.

- [ ] **Step 6: If Gate A passes, repeat each job twice with fresh caches**

Create four new roots by repeating Steps 2–4 with:

```powershell
$runs=@(
  @{Name='full-chain-v29-role-direction-front-b-20260729';Index='0'},
  @{Name='full-chain-v29-role-direction-fullstack-b-20260729';Index='1'},
  @{Name='full-chain-v29-role-direction-front-c-20260729';Index='0'},
  @{Name='full-chain-v29-role-direction-fullstack-c-20260729';Index='1'}
)
```

Expected across all six independent rows:

- 3/3 front-end rows are `misaligned + unproven + backup`;
- 3/3 full-stack rows are `mostly_aligned + partial + talk`;
- all rows use exactly two calls and zero repairs;
- no row exceeds the 180-second outer safety limit;
- median and maximum elapsed times are reported separately;
- response character counts stay bounded and do not show runaway output growth.

- [ ] **Step 7: Write a privacy-safe diagnostic report**

Create `docs/superpowers/reports/2026-07-29-role-direction-requirement-evidence-diagnostic.md` containing only:

- candidate commit;
- six private result paths and SHA-256 values;
- count of each safe role/foundation/bucket enum;
- stage median/max latency and total median/max latency;
- model-call and repair counts;
- response character-count median/max;
- whether the two expected outcomes were stable 3/3;
- a go/no-go recommendation for 20 rows.

Do not include title, company, URL, source ID, row ID, JD, resume text/evidence, matching-card content, endpoint, API key or model name.

- [ ] **Step 8: Privacy scan, commit and checkpoint**

```powershell
git diff --check
Select-String -LiteralPath 'docs/superpowers/reports/2026-07-29-role-direction-requirement-evidence-diagnostic.md' `
  -Pattern '郭|zhipin\.com|apiKey|Bearer|D:\\Guo\\ZhiPing|sourceId|jobId|company|modelName|baseUrl'
git add -- docs/superpowers/reports/2026-07-29-role-direction-requirement-evidence-diagnostic.md
git commit -m "docs: record layered role evidence diagnostic"
git status -sb
```

Expected: privacy scan finds nothing, report commit succeeds, and the branch is clean.

---

## Task 9: Gate the 20-row acceptance and branch completion

**Files:**

- Private source: same frozen 20-row JD bundle
- Create only after the one-time 20-row decision: `D:\DevData\RoleFlow-private-benchmark\full-chain-v30-role-direction-evidence-20-20260729`
- Create: `docs/superpowers/reports/2026-07-29-role-direction-requirement-evidence-20.md`

- [ ] **Step 1: Quantify the tradeoff before the 20-row decision**

Report from Task 8:

- exact stability for the two disputed jobs;
- candidate median/max latency;
- call/repair counts;
- output-size median/max;
- expected API-call count for 20 rows: 40 normal calls, plus zero expected repair calls;
- estimated wall time using the measured six-row median and maximum;
- whether the new rules changed recall only by downgrading to unchecked `backup`, never by hard exclusion.

Ask the user once whether to run the 20 rows. Do not ask again for the already authorized two-job diagnostics.

- [ ] **Step 2: Run 20 rows only after approval**

Create a new cache-empty private bundle:

```powershell
$root='D:\DevData\RoleFlow-private-benchmark\full-chain-v30-role-direction-evidence-20-20260729'
$sourceEvidence='D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725'
$frozenInput='D:\DevData\RoleFlow-private-benchmark\full-chain-v28-role-central-evidence-retry-20260728'
$candidateWorktree='D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$baselineWorktree='D:\DevData\RoleFlow-private-benchmark\baseline-worktree-role-direction-v1'
$candidateProductCommit='ac8fe5b479f63f58fd1fd0d1756d934e7d1853f2'
$candidateEvaluatedCommit=(git -C $candidateWorktree rev-parse HEAD).Trim()
$baselineProductCommit='fb0168afce265cf351f03e80f66d9e0f24015887'
git -C $candidateWorktree merge-base --is-ancestor $candidateProductCommit $candidateEvaluatedCommit
if(Test-Path -LiteralPath $root){ throw "Private output already exists: $root" }
New-Item -ItemType Directory -Path (Join-Path $root 'input') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'labels') -Force | Out-Null
foreach($relative in @(
  'input\confirmed-card.private.json',
  'input\confirmed-profile.private.json',
  'input\identity.private.json',
  'input\jobs.private.json',
  'input\parse-report.json',
  'input\resume.redacted.txt',
  'labels\jobs.reviewed.json'
)){
  Copy-Item -LiteralPath (Join-Path $frozenInput $relative) -Destination (Join-Path $root $relative)
}
node scripts/private-full-chain-runner.js --init-manifest `
  --private-root $root `
  --baseline-worktree $baselineWorktree `
  --candidate-worktree $candidateWorktree `
  --baseline-product-commit $baselineProductCommit `
  --candidate-product-commit $candidateProductCommit `
  --output (Join-Path $root 'run-manifest.json')
if($LASTEXITCODE -ne 0){ throw '20-row manifest failed' }
node scripts/private-full-chain-runner.js --create-portability-proof `
  --source-private-root $sourceEvidence `
  --private-root $root `
  --output (Join-Path $root 'input\confirmed-evidence-portability.json')
if($LASTEXITCODE -ne 0){ throw '20-row portability proof failed' }
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
  --output (Join-Path $root 'runs\candidate')
if($LASTEXITCODE -ne 0){ throw '20-row candidate run failed' }
```

Acceptance:

- 20 logical rows are preserved even if a provider response is empty; empty rows remain diagnosable and are not silently deleted;
- `failed=0`, `pending=0`, `partial=0`;
- `modelCallCount=40` total and `contractRepairCount=0`;
- no `primary` row lacks both JD and resume evidence;
- no role-only `misaligned` case becomes a hard exclusion;
- false hard exclusions do not increase;
- both disputed jobs retain their Task 8 outcome;
- recall-first kept opportunities do not regress;
- elapsed time and response size stay within the range forecast from Task 8 or the report explains the measured deviation.

- [ ] **Step 3: Write and commit the aggregate report**

The 20-row report follows the same privacy rules as Task 8 and adds:

- aggregate four-bucket distribution;
- role-alignment/foundation distribution;
- recall-first retained/excluded counts;
- failed/pending/partial/repair totals;
- median/p95/max total and per-stage latency;
- final accepted/rejected decision with reasons.

```powershell
git diff --check
Select-String -LiteralPath 'docs/superpowers/reports/2026-07-29-role-direction-requirement-evidence-20.md' `
  -Pattern '郭|zhipin\.com|apiKey|Bearer|D:\\Guo\\ZhiPing|sourceId|jobId|company|modelName|baseUrl'
git add -- docs/superpowers/reports/2026-07-29-role-direction-requirement-evidence-20.md
git commit -m "docs: record layered role evidence acceptance"
npm.cmd test
git diff --check
git status -sb
```

Expected: privacy scan finds nothing, the full offline suite remains green, and the worktree is clean.

- [ ] **Step 4: Request final code review**

Use the `requesting-code-review` skill against the range from `39138a5` to the final HEAD. The review must explicitly check:

- no third model call;
- no duplicate local bucket matrix;
- no hidden keyword rescue;
- new sparse contracts fail closed;
- old normalized analyses remain readable;
- no sensitive private data enters Git;
- no role mismatch alone becomes `not_recommended`;
- dashboard does not show internal enums;
- BOSS/data/8787 boundaries were not crossed.

- [ ] **Step 5: Choose branch integration only after review**

Use the `finishing-a-development-branch` skill. Do not merge into `D:\Guo\ZhiPing` automatically. Present the tested branch, commit range, reports, remaining risks and explicit integration options to the user.

## Final Self-Review Checklist

- [ ] Every requirement in `docs/superpowers/specs/2026-07-29-role-direction-requirement-evidence-design.md` maps to a task and test above.
- [ ] No step adds a third normal model stage, occupation taxonomy, local fuzzy matching or dependency.
- [ ] Model output remains flat JSON; no Markdown output path is introduced.
- [ ] `responsibilityEvidence`, `foundation` and role evidence have strict red tests.
- [ ] Foundation/role decision logic exists in exactly one shared helper.
- [ ] All decision consumers use that helper and can only downgrade.
- [ ] New analysis with no foundation requirements cannot become `primary`.
- [ ] Historical analysis stays readable and is stale under the new versions.
- [ ] The two disputed jobs have explicit, user-approved expected states.
- [ ] Small live tests use fresh caches, saved JD and exactly two calls.
- [ ] No live test reads BOSS or writes the main database.
- [ ] No private text, identity, model identity or secret appears in committed reports.
- [ ] The 20-row run is separated from the already authorized small diagnostic by one quantified decision.
- [ ] All file paths, commit values and test commands required for execution are explicit.
