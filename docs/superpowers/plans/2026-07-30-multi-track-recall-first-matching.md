# Multi-Track Recall-First Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 RoleFlow 能识别一份 JD 中相互独立的招聘分支，只选择与候选人证据最接近的一支做匹配，并以召回优先的四档规则稳定区分主投、可投、慎投和不推荐。

**Architecture:** 保留现有 `understandJob` 与 `matchJob` 两次模型调用。第一次输出最多四个轻量招聘分支和一张带 `trackIds` 的扁平要求表；第二次返回一个 `selectedTrackId`，契约层只允许所选分支与全局要求进入证据匹配。旧单分支缓存继续在读取时归一化为 `T1`，不做数据库迁移；本地决策仍复用现有硬边界、结构化 blocker 和 `roleEvidenceDecisionState`，只修正分支作用域与召回下限。

**Tech Stack:** Node.js CommonJS、内置 `assert` smoke tests、现有 OpenAI-compatible/DeepSeek 适配器、SQLite 私有缓存、PowerShell、Git。

## Global Constraints

- 只在 `codex/multi-track-recall-continuation` 的隔离 worktree、私有 baseline worktree 和验收时固定的候选 worktree 中工作；不得修改 `D:\Guo\ZhiPing` 正式项目。
- 不增加第三次模型调用，不为每个招聘分支重复调用模型；正常路径仍是一轮 `understandJob` 加一轮 `matchJob`。
- 不新增职业分类库、行业字典、第三方依赖或可配置规则引擎。
- 新版 `understandJob` 原始紧凑输出只能包含 `industryContext`、`hiringTracks`、`requirements`、`eligibility`、`riskSignals`。
- `hiringTracks` 必须有 1–4 项；普通 JD 固定为单个 `T1`；每项只含 `id`、`label`、`roleSummary`、`responsibilityEvidence`。
- `requirements` 总数最多 16；每项用 `trackIds` 归属一个或多个既有分支；对所有分支有效的要求必须列出全部分支 ID。
- 多分支结果不得生成跨分支的顶层 `roleSummary` 或 `responsibilityEvidence` 并集；旧单分支结构仅在读取时归一化为 `T1`。
- `matchJob` 必须返回一个既有 `selectedTrackId`，且只允许匹配所选分支及全局要求；其他分支的要求不得变成缺口、blocker 或展示证据。
- 职责用于判断主体工作；只有 JD 明确写成任职门槛或核心交付要求时，才进入逐项要求匹配。
- `aligned` 或 `mostly_aligned` 且没有硬冲突时，通常不得低于 `talk`；沟通、学习、稳定性意识、文档、一般排错等宽泛能力不得单独把岗位降到 `backup` 或 `not_recommended`。
- `misaligned` 本身只限制上限，不自动产生硬淘汰；薪资下限、地点、学历/届别/证书、明确不可替代核心要求、安全风险和用户排除词等既有硬边界继续有效。
- 冻结 20 条测试集位于 `D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730`；不得修改其中 JD、标签或两个 SHA-256。
- 不把真实 JD、公司名、URL、简历、画像、模型配置或密钥提交到 Git。
- 不访问真实 BOSS，不操作浏览器，不点击沟通或投递，不读写 `D:\Guo\ZhiPing\data\jobs.sqlite`，不启动或操作正式 8787。
- 真实模型步骤只有在 `ALLOW_PRIVATE_RESUME_BENCHMARK=YES` 与 `ALLOW_LIVE_MODEL_BENCHMARK=YES` 同时存在时执行；正式模型设置仅通过 `--model-settings-root D:\Guo\ZhiPing` 只读解析，不输出配置内容。
- 先跑三个已保存 JD；三条结构或分档不稳定就停止诊断，不直接消耗完整 20 条。

---

### Task 1: Normalize hiring tracks and requirement ownership

**Files:**

- Modify: `src/core/model_contract.js:274-386`
- Modify: `tests/semantic_pipeline_smoke.js:2250-2435`

**Interfaces:**

- Consumes new compact understanding:
  `industryContext:string`,
  `hiringTracks:Array<{id,label,roleSummary,responsibilityEvidence}>`,
  `requirements:Array<{label,trackIds,foundation,central,indispensable,evidence}>`,
  `eligibility:string[]`,
  `riskSignals:Array<{type,severity,evidence}>`.
- Produces normalized `jobUnderstanding.hiringTracks`, normalized `coreRequirements[*].trackIds`, and legacy single-track aliases only when `hiringTracks.length === 1`.
- Produces internal helpers:
  `normalizeHiringTracks(value, legacy = {})`,
  `requirementsForTrack(jobUnderstanding, selectedTrackId)`.

- [x] **Step 1: Add a canonical three-track failing fixture**

Add this fixture near `compactMatchEvidenceContractSmoke()`:

```js
const multiTrackUnderstandingInput = {
  industryContext: "企业 AI 应用",
  hiringTracks: [
    {
      id: "T1",
      label: "大模型应用开发",
      roleSummary: "使用 Python、Agent 与 RAG 交付 AI 应用",
      responsibilityEvidence: ["JD：负责大模型应用和 Agent 工作流落地"]
    },
    {
      id: "T2",
      label: "Python 全栈开发",
      roleSummary: "维护和扩展 Python 全栈业务系统",
      responsibilityEvidence: ["JD：负责 Python 前后端模块开发与上线"]
    },
    {
      id: "T3",
      label: "Python 算法开发",
      roleSummary: "研发并交付深度学习算法",
      responsibilityEvidence: ["JD：负责深度学习算法研发与优化"]
    }
  ],
  requirements: [
    {
      label: "Agent 与 RAG 应用交付",
      trackIds: ["T1"],
      foundation: true,
      central: true,
      indispensable: false,
      evidence: "JD：熟悉 Agent 搭建并有 RAG 项目经验"
    },
    {
      label: "Python 编程",
      trackIds: ["T1", "T2", "T3"],
      foundation: false,
      central: false,
      indispensable: false,
      evidence: "JD：熟练使用 Python"
    },
    {
      label: "前后端模块开发",
      trackIds: ["T2"],
      foundation: true,
      central: true,
      indispensable: false,
      evidence: "JD：负责前后端模块开发"
    },
    {
      label: "深度学习算法研发",
      trackIds: ["T3"],
      foundation: true,
      central: true,
      indispensable: false,
      evidence: "JD：负责深度学习算法研发"
    }
  ],
  eligibility: [],
  riskSignals: []
};
```

Assert the desired normalized result:

```js
const multiTrack = validateModelResult("understandJob", multiTrackUnderstandingInput);
assert.deepStrictEqual(multiTrack.hiringTracks.map((track) => track.id), ["T1", "T2", "T3"]);
assert.deepStrictEqual(multiTrack.coreRequirements.map((item) => item.trackIds), [
  ["T1"], ["T1", "T2", "T3"], ["T2"], ["T3"]
]);
assert.strictEqual(Object.prototype.hasOwnProperty.call(multiTrack, "roleSummary"), false,
  "多分支理解不得用第一个分支冒充整个岗位主体");
assert.deepStrictEqual(
  requirementsForTrack(multiTrack, "T1").map((item) => item.label),
  ["Agent 与 RAG 应用交付", "Python 编程"]
);
```

Change the current single-track compact fixture to the new raw shape and assert the compatibility aliases:

```js
const singleTrack = validateModelResult("understandJob", {
  industryContext: "企业服务",
  hiringTracks: [{
    id: "T1",
    label: "应用开发",
    roleSummary: "交付应用",
    responsibilityEvidence: ["JD：独立交付应用"]
  }],
  requirements: [{
    label: "独立交付",
    trackIds: ["T1"],
    foundation: true,
    central: true,
    indispensable: true,
    evidence: "JD：独立交付应用"
  }],
  eligibility: [],
  riskSignals: []
});
assert.strictEqual(singleTrack.roleSummary, "交付应用");
assert.deepStrictEqual(singleTrack.responsibilityEvidence, ["JD：独立交付应用"]);
```

- [x] **Step 2: Add failing boundary tests**

Add explicit `MODEL_CONTRACT_INVALID` assertions for:

```js
const invalidTrackOutputs = [
  { ...multiTrackUnderstandingInput, hiringTracks: [] },
  { ...multiTrackUnderstandingInput, hiringTracks: [...multiTrackUnderstandingInput.hiringTracks, {
    id: "T4", label: "第四分支", roleSummary: "第四分支交付", responsibilityEvidence: ["JD：第四分支"]
  }, {
    id: "T5", label: "第五分支", roleSummary: "第五分支交付", responsibilityEvidence: ["JD：第五分支"]
  }] },
  { ...multiTrackUnderstandingInput, hiringTracks: [
    multiTrackUnderstandingInput.hiringTracks[0],
    { ...multiTrackUnderstandingInput.hiringTracks[1], id: "T1" }
  ] },
  { ...multiTrackUnderstandingInput, hiringTracks: [
    { ...multiTrackUnderstandingInput.hiringTracks[0], id: "A1" }
  ] },
  { ...multiTrackUnderstandingInput, hiringTracks: [
    { ...multiTrackUnderstandingInput.hiringTracks[0], responsibilityEvidence: [] }
  ] },
  { ...multiTrackUnderstandingInput, requirements: [
    { ...multiTrackUnderstandingInput.requirements[0], trackIds: ["T9"] }
  ] },
  { ...multiTrackUnderstandingInput, requirements: [
    { ...multiTrackUnderstandingInput.requirements[0], trackIds: [] }
  ] }
];
for (const invalid of invalidTrackOutputs) {
  assert.throws(
    () => validateModelResult("understandJob", invalid),
    (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID"
  );
}
```

Also keep a true legacy full-contract fixture without `hiringTracks`, then assert it becomes one `T1` whose requirements all own `["T1"]`.

- [x] **Step 3: Run the semantic test and confirm the red state**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
```

Expected: exit 1 because `hiringTracks`, `trackIds`, or `requirementsForTrack` is not implemented; the failure must occur before any model or network call.

- [x] **Step 4: Implement the smallest shared normalization**

In `src/core/model_contract.js`, add these helpers beside the existing compact validators:

```js
function normalizeHiringTracks(value, legacy = {}) {
  const source = Array.isArray(value) ? value : [{
    id: "T1",
    label: "默认招聘方向",
    roleSummary: legacy.roleSummary || "未明确主体工作",
    responsibilityEvidence: legacy.responsibilityEvidence || []
  }];
  if (!source.length || source.length > 4) {
    throw new ModelContractError("understandJob", "hiringTracks 必须包含 1-4 个招聘分支");
  }
  const seen = new Set();
  return source.map((item, index) => {
    const id = requiredContractString(item?.id, "understandJob", `hiringTracks[${index}].id`);
    if (id !== `T${index + 1}` || seen.has(id)) {
      throw new ModelContractError("understandJob", "hiringTracks.id 必须按 T1-T4 唯一连续编号");
    }
    seen.add(id);
    return {
      id,
      label: requiredCompactString(item?.label, `hiringTracks[${index}].label`),
      roleSummary: requiredCompactString(item?.roleSummary, `hiringTracks[${index}].roleSummary`),
      responsibilityEvidence: responsibilityEvidenceList(item?.responsibilityEvidence)
    };
  });
}

function normalizeRequirementTrackIds(value, trackIds, field) {
  if (!Array.isArray(value) || !value.length) {
    throw new ModelContractError("understandJob", `${field}.trackIds 必须是非空数组`);
  }
  const normalized = [...new Set(value.map((id) =>
    requiredContractString(id, "understandJob", `${field}.trackIds`)
  ))];
  if (normalized.some((id) => !trackIds.has(id))) {
    throw new ModelContractError("understandJob", `${field}.trackIds 包含不存在的招聘分支`);
  }
  return normalized;
}

function requirementsForTrack(jobUnderstanding, selectedTrackId) {
  const tracks = normalizeHiringTracks(jobUnderstanding?.hiringTracks, {
    roleSummary: jobUnderstanding?.roleSummary,
    responsibilityEvidence: jobUnderstanding?.responsibilityEvidence
  });
  const allTrackIds = tracks.map((track) => track.id);
  if (!allTrackIds.includes(selectedTrackId)) {
    throw new ModelContractError("matchJob", `selectedTrackId ${selectedTrackId} 不存在`);
  }
  return list(jobUnderstanding?.coreRequirements).filter((item) => {
    const owned = Array.isArray(item.trackIds) && item.trackIds.length ? item.trackIds : ["T1"];
    return owned.includes(selectedTrackId)
      || (allTrackIds.every((id) => owned.includes(id)) && owned.length === allTrackIds.length);
  });
}
```

In `validateCompactJobUnderstanding`:

1. Replace top-level `roleSummary`/`responsibilityEvidence` reads with `normalizeHiringTracks(value.hiringTracks)`.
2. Reject any own top-level `roleSummary` or `responsibilityEvidence` in the new compact shape.
3. Attach validated `trackIds` to each normalized requirement.
4. Return `hiringTracks`; add compatibility aliases only when the normalized length is one.

In the legacy full-contract return:

```js
const hiringTracks = normalizeHiringTracks(value.hiringTracks, {
  roleSummary: value.roleSummary,
  responsibilityEvidence
});
```

and give every old requirement `trackIds: ["T1"]` when no explicit ownership exists.

Export `requirementsForTrack` for the smoke test and later match validators. Do not create a new module.

- [x] **Step 5: Run the task gate**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
git diff --check
```

Expected: both commands exit 0.

- [x] **Step 6: Commit the contract normalization**

```powershell
git add -- src/core/model_contract.js tests/semantic_pipeline_smoke.js
git commit -m "feat: normalize multi-track job understanding"
```

---

### Task 2: Select exactly one track during evidence matching

**Files:**

- Modify: `src/core/model_contract.js:394-646`
- Modify: `tests/semantic_pipeline_smoke.js:2394-2520`

**Interfaces:**

- Consumes: `value.selectedTrackId` and Task 1 normalized `jobUnderstanding`.
- Produces: validated `matchDecision.selectedTrackId`, `selectedTrackLabel`, selected track `roleSummary`, selected track `responsibilityEvidence`, and `requirementMatches` containing only selected/global requirements.

- [x] **Step 1: Write the failing selected-track success test**

Using `multiTrack` from Task 1:

```js
const selectedT1 = validateModelResult("matchJob", {
  selectedTrackId: "T1",
  roleAlignment: "aligned",
  roleResumeEvidence: ["简历：交付过 Agentic RAG 与 Python API"],
  roleGaps: [],
  matches: [
    { id: "R1", state: "matched", resumeEvidence: "简历：交付过 Agentic RAG" },
    { id: "R2", state: "matched", resumeEvidence: "简历：使用 Python 开发 API" }
  ],
  eligibility: []
}, { jobUnderstanding: multiTrack });

assert.strictEqual(selectedT1.selectedTrackId, "T1");
assert.strictEqual(selectedT1.selectedTrackLabel, "大模型应用开发");
assert.strictEqual(selectedT1.roleSummary, "使用 Python、Agent 与 RAG 交付 AI 应用");
assert.deepStrictEqual(
  selectedT1.requirementMatches.map((item) => item.requirement),
  ["Agent 与 RAG 应用交付", "Python 编程"]
);
assert(!selectedT1.requirementMatches.some((item) =>
  ["前后端模块开发", "深度学习算法研发"].includes(item.requirement)
));
```

- [x] **Step 2: Write failing leakage and ID tests**

Add:

```js
for (const invalid of [
  {
    selectedTrackId: "T9",
    roleAlignment: "aligned",
    roleResumeEvidence: ["简历：交付过 Agent"],
    roleGaps: [],
    matches: [],
    eligibility: []
  },
  {
    selectedTrackId: "T1",
    roleAlignment: "aligned",
    roleResumeEvidence: ["简历：交付过 Agent"],
    roleGaps: [],
    matches: [{ id: "R3", state: "missing", resumeEvidence: "简历：没有前端经历" }],
    eligibility: []
  }
]) {
  assert.throws(
    () => validateModelResult("matchJob", invalid, { jobUnderstanding: multiTrack }),
    (error) => error instanceof ModelContractError && error.code === "MODEL_CONTRACT_INVALID"
  );
}
```

Add a global eligibility item and assert it remains active for `T1`. Add one selected branch requirement omission and assert it becomes `unknown`; this proves relevant rows are still conservative while non-selected rows disappear completely.

Use these exact assertions:

```js
const scopedWithEligibility = validateModelResult("understandJob", {
  ...multiTrackUnderstandingInput,
  eligibility: ["JD：本科及以上学历"]
});
const selectedWithUnknowns = validateModelResult("matchJob", {
  selectedTrackId: "T1",
  roleAlignment: "mostly_aligned",
  roleResumeEvidence: ["简历：交付过 Agentic RAG"],
  roleGaps: [],
  matches: [{ id: "R2", state: "matched", resumeEvidence: "简历：使用 Python 开发 API" }],
  eligibility: []
}, { jobUnderstanding: scopedWithEligibility });
assert.strictEqual(
  selectedWithUnknowns.requirementMatches.find((item) => item.requirement === "Agent 与 RAG 应用交付").state,
  "unknown"
);
assert.deepStrictEqual(selectedWithUnknowns.questionsToVerify, [
  "Agent 与 RAG 应用交付的信息待确认",
  "JD：本科及以上学历的资格信息待确认"
]);
```

- [x] **Step 3: Run the semantic test and confirm the red state**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
```

Expected: exit 1 because current sparse/compact match validators still inspect all requirements and do not validate `selectedTrackId`.

- [x] **Step 4: Route all match paths through the selected scope**

Add one shared resolver in `src/core/model_contract.js`:

```js
function normalizeExpectedRequirement(item, index) {
  return {
    id: requiredContractString(item.id || `R${index + 1}`, "matchJob", "jobUnderstanding.coreRequirements.id"),
    label: requiredContractString(item.label, "matchJob", "jobUnderstanding.coreRequirements.label"),
    trackIds: Array.isArray(item.trackIds) && item.trackIds.length ? item.trackIds : ["T1"],
    foundation: Boolean(item.foundation),
    central: typeof item.central === "boolean" ? item.central : Boolean(item.indispensable),
    indispensable: Boolean(item.indispensable),
    evidence: requiredContractString(item.evidence, "matchJob", "jobUnderstanding.coreRequirements.evidence")
  };
}

function selectedTrackContext(value, jobUnderstanding) {
  const tracks = normalizeHiringTracks(jobUnderstanding?.hiringTracks, {
    roleSummary: jobUnderstanding?.roleSummary,
    responsibilityEvidence: jobUnderstanding?.responsibilityEvidence
  });
  const fallback = tracks.length === 1 && !Object.prototype.hasOwnProperty.call(value, "selectedTrackId")
    ? tracks[0].id
    : value.selectedTrackId;
  const selectedTrackId = requiredContractString(fallback, "matchJob", "selectedTrackId");
  const track = tracks.find((item) => item.id === selectedTrackId);
  if (!track) throw new ModelContractError("matchJob", `selectedTrackId ${selectedTrackId} 不存在`);
  return {
    selectedTrackId,
    selectedTrackLabel: track.label,
    roleSummary: track.roleSummary,
    responsibilityEvidence: track.responsibilityEvidence,
    requirements: requirementsForTrack({ ...jobUnderstanding, hiringTracks: tracks }, selectedTrackId)
  };
}
```

At the start of `validateSparseMatchEvidence`, `validateCompactMatchEvidence`, and legacy `validateMatchDecision`:

```js
const selected = selectedTrackContext(value, jobUnderstanding);
const requirements = selected.requirements.map(normalizeExpectedRequirement);
```

Reuse the existing inline requirement normalization as `normalizeExpectedRequirement`; do not duplicate it three times. Pass `selected` to role alignment validation so it reads only `selected.responsibilityEvidence`.

Return:

```js
{
  selectedTrackId: selected.selectedTrackId,
  selectedTrackLabel: selected.selectedTrackLabel,
  roleSummary: selected.roleSummary,
  responsibilityEvidence: selected.responsibilityEvidence,
  ...existingDecision
}
```

Compatibility rule: omission of `selectedTrackId` is accepted only for normalized single-track legacy data and resolves to `T1`; omission on multi-track data is a contract error.

- [x] **Step 5: Run the task gate**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
node tests/screening_quality_smoke.js
git diff --check
```

Expected: all commands exit 0; existing hard eligibility/blocker tests remain green.

- [x] **Step 6: Commit the selected-scope contract**

```powershell
git add -- src/core/model_contract.js tests/semantic_pipeline_smoke.js
git commit -m "feat: match only the selected hiring track"
```

---

### Task 3: Teach both model adapters the compact multi-track contract

**Files:**

- Modify: `src/adapters/models/openai_compatible.js:91-136`
- Modify: `src/adapters/models/mock.js:70-180`
- Modify: `src/core/analysis_revision.js:4-9`
- Modify: `tests/model_adapter_smoke.js:204-370`
- Modify: `tests/semantic_pipeline_smoke.js:1700-1740`

**Interfaces:**

- Consumes: full JD, confirmed profile, matching card, and Task 1 normalized understanding.
- Produces raw `understandJob` with five top-level fields and raw `matchJob` with `selectedTrackId`.
- Advances cache versions to:
  `job-understanding-v15`,
  `match-decision-v28`,
  `multi-track-recall-v1`.

- [x] **Step 1: Write failing prompt-shape tests**

In `tests/model_adapter_smoke.js`, assert:

```js
for (const token of [
  "hiringTracks[{id,label,roleSummary,responsibilityEvidence}]",
  "requirements[{label,trackIds,foundation,central,indispensable,evidence}]",
  "最多四个",
  "普通 JD",
  "T1",
  "不得为了规避要求而虚构分支",
  "愿望清单",
  "同一个人承担",
  "全局要求",
  "全部分支 ID"
]) {
  assert(understandPrompt.includes(token), `understandJob prompt 缺少多分支规则：${token}`);
}
assert(!understandPrompt.includes("只输出且必须输出这六个字段"));
assert(
  matchPrompt.includes("selectedTrackId")
    && matchPrompt.includes("only the selected track")
    && matchPrompt.includes("all-track requirement")
    && matchPrompt.includes("Never match requirements from another track"),
  "matchJob prompt 必须先选一支，再匹配该支与全局要求"
);
assert(matchPrompt.includes(
  '{"selectedTrackId":"T1","roleAlignment":"mostly_aligned"'
));
```

Keep the existing assertions that prohibit copied JD, local decision fields, invented IDs, user notes as evidence, and reverse inference.

- [x] **Step 2: Write failing adapter and version tests**

Feed `OpenAICompatibleAdapter.matchJob()` a synthetic `T1` response and assert the returned decision preserves `selectedTrackId`.

For the mock adapter:

```js
const mockUnderstanding = await mockAdapter.understandJob({
  job: { sourceId: "mock-track", title: "应用开发", description: "负责应用开发与交付" }
});
assert.deepStrictEqual(mockUnderstanding.hiringTracks.map((item) => item.id), ["T1"]);
assert(mockUnderstanding.requirements.every((item) => item.trackIds.includes("T1")));

const mockMatch = await mockAdapter.matchJob({
  jobUnderstanding: validateModelResult("understandJob", mockUnderstanding),
  candidateProfile: { skills: [] }
});
assert.strictEqual(mockMatch.selectedTrackId, "T1");
```

Change exact version assertions to:

```js
assert.strictEqual(PIPELINE_VERSIONS.understandJob, "job-understanding-v15");
assert.strictEqual(PIPELINE_VERSIONS.matchJob, "match-decision-v28");
assert.strictEqual(PIPELINE_VERSIONS.decisionRules, "multi-track-recall-v1");
```

Add stale-reason checks for all three previous versions.

- [x] **Step 3: Run tests and confirm red failures**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: prompt, mock-shape, and exact-version assertions fail; no network is used.

- [x] **Step 4: Replace the understanding prompt without adding a call**

Change the compact shape line to:

```js
"只输出且必须输出这五个顶层字段：industryContext、hiringTracks[{id,label,roleSummary,responsibilityEvidence}]、requirements[{label,trackIds,foundation,central,indispensable,evidence}]、eligibility[非空字符串]、riskSignals[{type,severity,evidence}]。数组无内容时输出 []，不要输出其他顶层字段。",
```

Add these rules:

```js
"只有 JD 明确同时招聘相互独立的对象，例如“第一类/第二类/第三类”或岗位 A/岗位 B，才拆分 hiringTracks；不得为了规避要求而虚构分支。普通 JD 只输出一个 T1。hiringTracks 最多四个，按 T1、T2、T3、T4 连续编号；每个分支都必须有一条直接 JD 职责证据。",
"职责很多、技术栈很多、要求像愿望清单，或同一个人被要求承担前端、后端、沟通、文档、稳定性等多项任务，都不等于多个招聘分支，仍只输出一个 T1。只有 JD 明确允许不同候选人分别承担不同工作时才能拆分。",
"requirements 保持一张扁平清单。trackIds 必须引用既有分支；只属于一个分支的要求只写该 ID；对整份招聘都有效的全局要求写入全部分支 ID。不得把其他分支的前端、算法、运维或领域要求并入当前分支。",
```

Keep the current responsibility-versus-requirement, industry boundary, evidence prefix, length limit, risk, and contract-repair rules.

- [x] **Step 5: Replace the match prompt output shape**

Change the selection and output instructions to:

```js
"Choose exactly one selectedTrackId from jobUnderstanding.hiringTracks using concrete resume evidence. Compare roleSummary and responsibilityEvidence only for that selected track. If several tracks are plausible, choose the one with the strongest direct evidence; do not add a third model call.",
"Match only the selected track requirements plus an all-track requirement whose trackIds contain every hiring-track ID. Never match requirements from another track, never report them as roleGaps, and never turn them into a hard blocker.",
"Return exactly {\"selectedTrackId\":\"T1\",\"roleAlignment\":\"mostly_aligned\",\"roleResumeEvidence\":[\"简历：具体事实\"],\"roleGaps\":[\"具体未证明部分\"],\"matches\":[{\"id\":\"R1\",\"state\":\"matched\",\"resumeEvidence\":\"简历：具体事实\"}],\"eligibility\":[]}. Empty arrays are valid.",
```

Keep the adapter’s single `chatJson` call and existing one-time contract repair behavior unchanged.

- [x] **Step 6: Update the mock and versions**

Make mock understanding always emit one `T1`, attach `trackIds: ["T1"]` to requirements, and make mock matching select the first track with a supporting candidate fact without another call. Reuse the existing `findSupportingFact()` helper and fall back to the first track:

```js
const selectedTrack = jobUnderstanding.hiringTracks
  .find((track) => findSupportingFact(
    [track.roleSummary, ...track.responsibilityEvidence].join(" "),
    candidateFacts
  ))
  || jobUnderstanding.hiringTracks[0];
```

Then match only `requirementsForTrack(jobUnderstanding, selectedTrack.id)` and return `selectedTrackId: selectedTrack.id`.

Update:

```js
const PIPELINE_VERSIONS = Object.freeze({
  understandJob: "job-understanding-v15",
  matchJob: "match-decision-v28",
  decisionRules: "multi-track-recall-v1",
  communication: "communication-v2"
});
```

- [x] **Step 7: Run the task gate**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/profile_quality_smoke.js
git diff --check
```

Expected: all commands exit 0. Inspect model-call tests and confirm no new call kind or retry loop was added.

- [x] **Step 8: Commit the adapter contract**

```powershell
git add -- src/adapters/models/openai_compatible.js src/adapters/models/mock.js src/core/analysis_revision.js tests/model_adapter_smoke.js tests/semantic_pipeline_smoke.js
git commit -m "feat: select one hiring track in the model pipeline"
```

---

### Task 4: Persist the selected track and enforce the recall floor

**Files:**

- Modify: `src/core/job_analysis.js:182-346`
- Modify: `src/core/model_contract.js:1086-1139`
- Modify: `src/dashboard/server.js:2332-2385`
- Modify: `tests/semantic_pipeline_smoke.js:1663-1697,2091-2227`
- Modify: `tests/workflow_dashboard_smoke.js:100-140,260-315`

**Interfaces:**

- Consumes: Task 2 selected-track decision and existing structured blockers.
- Produces compact analysis fields:
  `selectedTrackId`,
  `selectedTrackLabel`,
  selected `roleSummary`,
  selected `responsibilityEvidence`.
- Produces a local ceiling/floor decision that preserves hard blocks but keeps aligned/mostly-aligned opportunities at least `talk` unless a concrete central/foundation gap justifies `backup`.

- [x] **Step 1: Write failing persistence and dashboard tests**

Extend `compactRoleEvidencePersistenceSmoke()`:

```js
assert.strictEqual(compact.selectedTrackId, "T1");
assert.strictEqual(compact.selectedTrackLabel, "大模型应用开发");
assert.strictEqual(compact.roleSummary, matchDecision.roleSummary);
assert.deepStrictEqual(compact.responsibilityEvidence, matchDecision.responsibilityEvidence);
for (const analysis of [ruleOnly, failed]) {
  assert.strictEqual(analysis.selectedTrackId, "");
  assert.strictEqual(analysis.selectedTrackLabel, "");
}
```

Update the dashboard fixture with:

```js
selectedTrackId: "T1",
selectedTrackLabel: "大模型应用开发",
roleSummary: "使用 Python、Agent 与 RAG 交付 AI 应用"
```

and require visible text:

```js
for (const label of ["匹配分支", "大模型应用开发", "岗位主体", "主体匹配"]) {
  assert(html.includes(label), `工作台必须显示 ${label}`);
}
```

- [x] **Step 2: Write failing recall-floor tests**

Add explicit decision cases:

```js
const genericDutyGap = layeredRoleAnalysis("mostly_aligned", ["matched", "matched"]);
genericDutyGap.recommendation = "review";
genericDutyGap.requirementMatches.push({
  requirement: "客户沟通与文档意识",
  state: "missing",
  foundation: false,
  central: false,
  indispensable: false,
  jdEvidence: "JD：具备良好的沟通和文档意识",
  resumeEvidence: "简历：未单独列出该表述"
});
assert.strictEqual(
  decisionBucket({ ...completeJob("generic-duty-gap"), analysis: applyRuleGuard(genericDutyGap, completeJob("generic-duty-gap")) }),
  "talk",
  "主体基本一致时，宽泛附带职责不得单独降为慎投"
);

const concreteCoreGap = layeredRoleAnalysis("mostly_aligned", ["matched", "missing"]);
concreteCoreGap.requirementMatches[1] = {
  ...concreteCoreGap.requirementMatches[1],
  requirement: "独立交付 Java 企业后端",
  central: true,
  foundation: true,
  jdEvidence: "JD：独立负责 Java 企业后端交付",
  resumeEvidence: "简历：仅有 Python/FastAPI 交付"
};
assert.strictEqual(
  decisionBucket({ ...completeJob("core-delivery-gap"), analysis: applyRuleGuard(concreteCoreGap, completeJob("core-delivery-gap")) }),
  "backup"
);
```

Keep and rerun current tests proving:

- valid eligibility/indispensable/safety blockers still become `not_recommended`;
- `misaligned` alone stays at `backup`, not `not_recommended`;
- AI-assisted pure front-end cannot become `primary` from AI keyword overlap;
- risk-quality jobs do not get promoted.

- [x] **Step 3: Run tests and confirm the red state**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: selected-track persistence/display assertions fail; the generic-duty case remains too low before the recall-floor change.

- [x] **Step 4: Persist only the selected branch**

In `compactAnalysis`, source the role fields from `matchDecision`, not from the whole understanding:

```js
selectedTrackId: matchDecision.selectedTrackId || "",
selectedTrackLabel: matchDecision.selectedTrackLabel || "",
roleSummary: matchDecision.roleSummary || "",
responsibilityEvidence: matchDecision.responsibilityEvidence || [],
```

Add empty strings to rule-only and failed analysis shapes. Do not persist all branch descriptions in the public compact analysis; `jobUnderstanding` already remains in the model cache.

- [x] **Step 5: Apply the minimal recall rule**

Keep `roleEvidenceDecisionState` as the shared boundary. Change only its aligned/mostly-aligned floor semantics:

```js
const hasConcreteFoundationGap = foundation.some((item) => item.state === "missing");
let bucketCeiling = "backup";
let bucketFloor = null;
if (analysis.roleAlignment === "aligned" && foundationState === "complete" && !hasTransferableFoundation) {
  bucketCeiling = "primary";
  bucketFloor = "talk";
} else if (["aligned", "mostly_aligned"].includes(analysis.roleAlignment) && !hasConcreteFoundationGap) {
  bucketCeiling = "talk";
  bucketFloor = "talk";
} else if (
  (analysis.roleAlignment === "aligned" && ["complete", "partial"].includes(foundationState))
  || (analysis.roleAlignment === "mostly_aligned" && ["complete", "partial"].includes(foundationState))
) {
  bucketCeiling = "talk";
}
```

Return `bucketFloor` and `hasConcreteFoundationGap`. In `applyRuleGuard`, preserve the current precedence:

1. local hard boundary;
2. structured hard blocker;
3. safety/job-quality risk;
4. selected-track concrete central/foundation gap;
5. selected-track alignment floor;
6. other soft gaps.

After hard/risk handling, when `bucketFloor === "talk"` and the model returned `review`, raise only the recommendation to `caution`:

```js
if (roleState.bucketFloor === "talk" && analysis.recommendation === "review") {
  return {
    ...analysis,
    recommendation: "caution",
    fitLevel: "B",
    decisionSource: "role_alignment_floor"
  };
}
```

Do not promote `skip`, do not promote `jobQuality.level === "risk"`, and do not promote an analysis with `decisionHardBlockers(analysis).length > 0`.

Update the existing `roleEvidenceDecisionStateSmoke()` deep-equality assertion to include:

```js
bucketFloor: "talk",
hasConcreteFoundationGap: false,
```

and add the same two fields to all exact expected objects returned by this helper.

- [x] **Step 6: Show the chosen branch**

Change `compactRoleEvidenceSummary()` to render:

```js
const track = analysis.selectedTrackLabel
  ? `匹配分支：${escapeHtml(analysis.selectedTrackLabel)} · `
  : "";
return `${track}岗位主体：${escapeHtml(analysis.roleSummary)} · 主体匹配：${roleAlignmentLabel(analysis.roleAlignment)}${details}`;
```

Legacy rows without a selected label must render exactly as before.

- [x] **Step 7: Run the task gate**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
node tests/screening_quality_smoke.js
node tests/workflow_inventory_smoke.js
node tests/workflow_dashboard_smoke.js
git diff --check
```

Expected: all commands exit 0; hard-block and front-end negative-control assertions remain green.

- [x] **Step 8: Commit persistence and recall behavior**

```powershell
git add -- src/core/job_analysis.js src/core/model_contract.js src/dashboard/server.js tests/semantic_pipeline_smoke.js tests/workflow_dashboard_smoke.js
git commit -m "feat: persist selected tracks and protect viable opportunities"
```

---

### Task 5: Expose selected-track evidence in the private runner and document behavior

**Files:**

- Modify: `scripts/private-full-chain-runner.js:1767-1826`
- Modify: `tests/private_full_chain_runner_smoke.js:625-760`
- Modify: `docs/product_spec.md`
- Modify: `docs/daily_workflow.md`

**Interfaces:**

- Consumes: compact analysis selected-track fields.
- Produces private row fields:
  `selectedTrackId`,
  `selectedTrackLabel`,
  `roleSummary`,
  `roleResumeEvidenceCount`,
  `roleGapCount`.
- Does not add JD text, company, URL, resume text, model endpoint, or secrets to committed fixtures.

- [x] **Step 1: Write the failing private-row test**

In the existing injected `match-live` seam, return:

```js
{
  semanticStatus: "complete",
  recommendation: "caution",
  selectedTrackId: "T1",
  selectedTrackLabel: "大模型应用开发",
  roleSummary: "使用 Python、Agent 与 RAG 交付 AI 应用",
  roleAlignment: "mostly_aligned",
  roleResumeEvidence: ["简历：交付过 Agentic RAG"],
  roleGaps: ["未证明指定平台经验"],
  requirementMatches: [],
  hardBlockers: [],
  evidence: { jd: ["JD：负责 Agent 应用"], resume: ["简历：交付过 Agentic RAG"] }
}
```

Assert the generated private result row:

```js
assert.deepStrictEqual({
  selectedTrackId: row.selectedTrackId,
  selectedTrackLabel: row.selectedTrackLabel,
  roleSummary: row.roleSummary,
  roleResumeEvidenceCount: row.roleResumeEvidenceCount,
  roleGapCount: row.roleGapCount
}, {
  selectedTrackId: "T1",
  selectedTrackLabel: "大模型应用开发",
  roleSummary: "使用 Python、Agent 与 RAG 交付 AI 应用",
  roleResumeEvidenceCount: 1,
  roleGapCount: 1
});
```

Add a failed-analysis case and require empty strings/counts instead of throwing.

- [x] **Step 2: Run the runner smoke and confirm the red state**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: exit 1 because the current row does not expose selected-track evidence.

- [x] **Step 3: Add bounded private diagnostics**

Add only these fields to the row built in `runPrivateFullChain()`:

```js
selectedTrackId: String(analysis.selectedTrackId || "").slice(0, 8),
selectedTrackLabel: String(analysis.selectedTrackLabel || "").slice(0, 80),
roleSummary: String(analysis.roleSummary || "").slice(0, 160),
roleResumeEvidenceCount: Array.isArray(analysis.roleResumeEvidence) ? analysis.roleResumeEvidence.length : 0,
roleGapCount: Array.isArray(analysis.roleGaps) ? analysis.roleGaps.length : 0,
```

These fields remain only under the private benchmark root. Do not add evidence text arrays to public reports.

- [x] **Step 4: Document the user-visible workflow**

In `docs/product_spec.md`, state:

```markdown
- 一份 JD 明确包含多个独立招聘方向时，系统先拆分方向，再只选择与已确认简历证据最接近的一支做匹配。
- 页面会显示“匹配分支”；其他招聘分支的要求不会变成候选人的缺口。
- 职责决定主体工作，任职要求做逐项证据匹配；宽泛通用职责只解释，不单独淘汰。
```

In `docs/daily_workflow.md`, add:

```markdown
查看岗位分析时先看“匹配分支”和“岗位主体”，再看逐项要求。若 JD 同时招聘多类人，当前结论只代表系统选中的一支，不代表候选人满足其他分支。
```

Verify the smoke is already registered and do not modify `tests/run_all.js`:

```powershell
rg -n '"private_full_chain_runner_smoke.js"' tests/run_all.js
```

Expected: exactly one match.

- [x] **Step 5: Run the complete offline gate**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
node tests/model_adapter_smoke.js
node tests/screening_quality_smoke.js
node tests/workflow_inventory_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/private_full_chain_runner_smoke.js
npm.cmd test
git diff --check
git status --short
```

Expected: all focused tests pass, the complete offline suite passes, `git diff --check` has no output, and only Task 5 files are uncommitted.

- [x] **Step 6: Commit runner diagnostics and docs**

```powershell
git add -- scripts/private-full-chain-runner.js tests/private_full_chain_runner_smoke.js docs/product_spec.md docs/daily_workflow.md
git commit -m "docs: expose selected hiring tracks in matching results"
```

#### Tasks 1-5 implementation evidence (sanitized)

All evidence below is offline-only. It records contract and test identifiers only;
it intentionally omits any private job description, resume content, company,
URL, endpoint, or credential.

| Task | Red regression observed before its fix | Green verification | Product commits |
| --- | --- | --- | --- |
| 1 | `semantic_pipeline_smoke` rejected the new compact multi-track shape for missing legacy top-level role fields; a 17th requirement was silently truncated. | `node tests/semantic_pipeline_smoke.js` and `git diff --check` exited 0; explicit-null tracks, invalid ownership, unknown IDs, and over-limit inputs fail closed. | `ea5115b`, `642f177` |
| 2 | `semantic_pipeline_smoke` used absent multi-track top-level responsibility evidence; later regressions accepted free text from an unselected track. | `node tests/semantic_pipeline_smoke.js`, `node tests/screening_quality_smoke.js`, and `git diff --check` exited 0; selection accepts only the selected/global requirement scope. | `5b456ea`, `0feb463`, `4902735` |
| 3 | `model_adapter_smoke` reported the missing `hiringTracks` prompt contract; the mock had no tracks. | `node tests/model_adapter_smoke.js`, `node tests/semantic_pipeline_smoke.js`, and `node tests/profile_quality_smoke.js` exited 0; prompt, mock, and production analyzer validation use the compact selected-track contract without adding a model call. | `42f457d`, `0b3286e`, `87cc68e` |
| 4 | `semantic_pipeline_smoke` had no persisted selected-track fields; `workflow_dashboard_smoke` had no matching-track rendering. | `node tests/semantic_pipeline_smoke.js`, `node tests/screening_quality_smoke.js`, `node tests/workflow_inventory_smoke.js`, `node tests/workflow_dashboard_smoke.js`, and `git diff --check` exited 0; generic gaps keep the recall floor while concrete core gaps, blockers, risk, and evidence guards retain priority. | `c2d4ea0`, `a88aebd` |
| 5 | `private_full_chain_runner_smoke` reported that private rows did not expose the five bounded selected-track diagnostics. | `node tests/private_full_chain_runner_smoke.js` and the focused Task 3-5 smokes exited 0; the row contains bounded IDs/labels/counts only. | `bf6abce` |

Final offline gate after Task 5: `npm.cmd test` exited 0 with **All 47 offline checks passed**. `git diff --check` exited 0 with no output. The candidate product commit for this evaluated checkpoint is `87cc68ede886ac0ef3b53f960c38548cce4a831a`.

---

### Task 6: Create a clean evaluated checkpoint and matching baseline harness

**Files:**

- Modify: `docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md`
- Create worktree:
  `D:\DevData\RoleFlow-private-benchmark\baseline-worktree-multi-track-recall-v1`
- Modify in the new baseline worktree:
  `scripts/private-full-chain-runner.js:1767-1826`

**Interfaces:**

- Produces one docs-only candidate evaluated commit whose strict ancestor is the final Task 1–5 product commit.
- Produces one baseline evaluated commit whose strict ancestor is approved baseline product `fb0168afce265cf351f03e80f66d9e0f24015887`.
- Guarantees identical Git blobs for all three `SHARED_MANIFEST_FILES` on baseline and candidate.
- Keeps the product commit separate from live-result notes so the private runner can prove `candidateProductCommit` is a strict ancestor.

- [ ] **Step 1: Record implementation evidence in this plan**

Mark Tasks 1–5 complete and append exact red failures, green command results, product commit hashes, final offline test count, and `git diff --check` result. Do not include private JD text, resume facts, company names, URLs, model endpoint, or credentials.

- [ ] **Step 2: Commit the docs-only checkpoint**

```powershell
git add -- docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md
git commit -m "docs: prepare multi-track live acceptance"
```

Expected:

```powershell
$evaluated = git rev-parse HEAD
$product = git rev-parse HEAD^
git merge-base --is-ancestor $product $evaluated
if ($LASTEXITCODE -ne 0 -or $product -eq $evaluated) { throw 'product/evaluated topology invalid' }
git status --short
```

The ancestry command exits 0 and status is empty.

- [ ] **Step 3: Create the dedicated baseline harness worktree**

Run:

```powershell
$baselineHarness = 'D:\DevData\RoleFlow-private-benchmark\baseline-worktree-multi-track-recall-v1'
if (Test-Path -LiteralPath $baselineHarness) { throw "baseline harness path already exists: $baselineHarness" }
git worktree add -b codex/multi-track-recall-private-baseline-v1 `
  $baselineHarness `
  86679ca8cddfb312e4025a8c330319fb41b3d385
```

Expected: the new worktree is clean and its starting commit is the existing private baseline tooling commit. Verify the approved product is a strict ancestor:

```powershell
git -C $baselineHarness merge-base --is-ancestor `
  fb0168afce265cf351f03e80f66d9e0f24015887 `
  86679ca8cddfb312e4025a8c330319fb41b3d385
if ($LASTEXITCODE -ne 0) { throw 'approved baseline product is not an ancestor' }
```

- [ ] **Step 4: Mirror only the additive runner row fields**

Apply the exact five-field row change from Task 5 to
`$baselineHarness\scripts\private-full-chain-runner.js`:

```js
selectedTrackId: String(analysis.selectedTrackId || "").slice(0, 8),
selectedTrackLabel: String(analysis.selectedTrackLabel || "").slice(0, 80),
roleSummary: String(analysis.roleSummary || "").slice(0, 160),
roleResumeEvidenceCount: Array.isArray(analysis.roleResumeEvidence) ? analysis.roleResumeEvidence.length : 0,
roleGapCount: Array.isArray(analysis.roleGaps) ? analysis.roleGaps.length : 0,
```

Do not copy any matching-contract, scoring, prompt, adapter, dashboard, profile, card, or fixture change into the baseline. Run:

```powershell
node "$baselineHarness\tests\private_full_chain_runner_smoke.js"
git -C $baselineHarness diff --check
git -C $baselineHarness status --short
```

Expected: smoke exits 0, diff check is clean, and only
`scripts/private-full-chain-runner.js` is modified.

- [ ] **Step 5: Commit and prove shared-blob identity**

```powershell
git -C $baselineHarness add -- scripts/private-full-chain-runner.js
git -C $baselineHarness commit -m "test: mirror multi-track private harness"
$candidateRoot = 'D:\DevData\RoleFlow-worktrees\deepseek-match-nonthinking-ab'
foreach ($file in @(
  'scripts/private-full-chain-runner.js',
  'scripts/lib/benchmark_metrics.js',
  'scripts/lib/private_resume_privacy.js'
)) {
  $left = git -C $baselineHarness rev-parse "HEAD:$file"
  $right = git -C $candidateRoot rev-parse "HEAD:$file"
  if ($left -ne $right) { throw "shared harness blob mismatch: $file" }
}
```

Expected: all three blobs are exactly equal and both worktrees are clean.

---

### Task 6.5: Complete v3 portability review and baseline resynchronization

**Completed evidence:**

- [x] v3 implementation chain completed at `71885b9b2811205ea4b04d2731aad2a240648c92`.
- [x] Independent review identified runtime evaluated consumer binding, check-after-replacement coverage, and circular preflight structure gaps.
- [x] `07ece938a363bf4725fe928cb5a8f778404a4d47` added v3 runtime consumer binding, six-file single-read/hash-and-use race coverage, and an explicit non-circular portability object.
- [x] `9d7d1a4e4865b76073eca3af007250110db18d20` bound runtime blob lookup to the actual candidate or independent baseline repository.
- [x] Independent re-review returned **Spec PASS** and **Code quality APPROVED**, with no Critical, Important, or Moderate findings.
- [x] Candidate runner smoke, 31 benchmark fixtures, all 47 offline checks, and `git diff --check` passed at `9d7d1a4`.
- [x] Baseline mirror commit `cc5dc6adf158c4c38cfefb808a78a53b4bfdf389` passed its repository-native 41 offline checks and 31 benchmark fixtures.
- [x] Candidate and baseline Git blobs are identical for runner `b2729d697bb6d5da8ce9a60aa80ec4015dfc1b35`, benchmark metrics `0edda7c2449639f3fecdee394fa60cc2f0447c05`, and private resume privacy `8a4b21d7493fb5e7d8ce49662ba3951687903c46`.
- [x] Real preflight exposed the frozen-pool `private-user-confirmed.v2` envelope gap before any model call; `6152d70cd584531604db867d9a73747c41a75994` added strict synthetic coverage and exact v3 support.
- [x] Independent re-review returned **Spec PASS** and **Code quality APPROVED** for the frozen-pool envelope fix.
- [x] Candidate runner smoke, 31 benchmark fixtures, all 47 offline checks, and `git diff --check` passed at `6152d70cd584531604db867d9a73747c41a75994`.
- [x] Baseline mirror `c47992259c6c206887b4bb13cf82765e4af68e3b` passed its repository-native 41 offline checks and 31 benchmark fixtures.
- [x] Candidate and baseline Git blobs now match for runner `ece3b6aa097b545b4e41eaf4955c24c9468766f1`, benchmark metrics `0edda7c2449639f3fecdee394fa60cc2f0447c05`, and private resume privacy `8a4b21d7493fb5e7d8ce49662ba3951687903c46`.
- [x] The next real preflight exposed the exact 13-field frozen-job schema and description SHA-256 contract before any model call.
- [x] Candidate fix `cebe59f5aae78abdde873adfe211f296d3322519` passed independent **Spec PASS** / **Code quality APPROVED**, runner smoke, 31 fixtures, all 47 offline checks, and `git diff --check`.
- [x] Baseline mirror `63c2ac393aa6cc8a7728fea6f0944d5f4db9cad6` passed its repository-native 41 offline checks and 31 fixtures.
- [x] Candidate and baseline Git blobs now match for runner `d3cdc259675005dce1370adbd6f0746e423a305f`, benchmark metrics `0edda7c2449639f3fecdee394fa60cc2f0447c05`, and private resume privacy `8a4b21d7493fb5e7d8ce49662ba3951687903c46`.

Candidate product remains `87cc68ede886ac0ef3b53f960c38548cce4a831a`. Frozen candidate evaluated commit `cebe59f5aae78abdde873adfe211f296d3322519` must pass:

```powershell
git merge-base --is-ancestor 87cc68ede886ac0ef3b53f960c38548cce4a831a cebe59f5aae78abdde873adfe211f296d3322519
```

The follow-up documentation record is not a new evaluated checkpoint. Task 7 and Task 8 must run `cebe59f5aae78abdde873adfe211f296d3322519`.

Preserve the failed diagnostic root without modifying or deleting it:
`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-20260730`.

Use only these fresh roots:

- `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-live-run-20260730`
- `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-20-v3-20260730`

The frozen pool remains:

- jobs raw SHA-256 `612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b`
- labels raw SHA-256 `97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39`

Task 7 must use `--proof-version confirmed-evidence-portability.v3` and preserve zero-based `--diagnostic-indices '4,9,10'` exactly.

---

### Task 7: Run three saved-JD real-model diagnostics

**Files:**

- No repository files.
- Private input/output root:
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-live-run-20260730`
- Reuse confirmed evidence from:
  `D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725`
- Reuse frozen jobs/labels from:
  `D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730`

**Interfaces:**

- Consumes zero-based diagnostic indices `4,9,10`:
  multi-branch LLM application, AI-assisted pure front-end, Agent implementation.
- Produces a private `runs\candidate\match-result.json` bound to the evaluated commit and the unchanged confirmed profile/card.

- [ ] **Step 1: Verify the frozen pool before copying**

Run:

```powershell
$pool = 'D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730'
(Get-FileHash -Algorithm SHA256 (Join-Path $pool 'input\jobs.private.json')).Hash.ToLower()
(Get-FileHash -Algorithm SHA256 (Join-Path $pool 'labels\jobs.reviewed.json')).Hash.ToLower()
```

Expected exactly:

```text
612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b
97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39
```

Stop if either differs.

- [ ] **Step 2: Prepare a fresh private bundle**

Create `input`, `labels`, `runs\candidate`, and `reports` below the new private root. Copy:

```powershell
$source = 'D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725'
$pool = 'D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730'
$root = 'D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-live-run-20260730'
if (Test-Path -LiteralPath $root) { throw "private root already exists: $root" }
foreach ($directory in @('input', 'labels', 'runs\candidate', 'reports')) {
  New-Item -ItemType Directory -Path (Join-Path $root $directory) | Out-Null
}
Copy-Item -LiteralPath (Join-Path $source 'input\confirmed-profile.private.json') -Destination (Join-Path $root 'input\confirmed-profile.private.json')
Copy-Item -LiteralPath (Join-Path $source 'input\confirmed-card.private.json') -Destination (Join-Path $root 'input\confirmed-card.private.json')
Copy-Item -LiteralPath (Join-Path $source 'input\identity.private.json') -Destination (Join-Path $root 'input\identity.private.json')
Copy-Item -LiteralPath (Join-Path $source 'input\resume.redacted.txt') -Destination (Join-Path $root 'input\resume.redacted.txt')
Copy-Item -LiteralPath (Join-Path $source 'input\parse-report.json') -Destination (Join-Path $root 'input\parse-report.json')
Copy-Item -LiteralPath (Join-Path $pool 'input\jobs.private.json') -Destination (Join-Path $root 'input\jobs.private.json')
Copy-Item -LiteralPath (Join-Path $pool 'labels\jobs.reviewed.json') -Destination (Join-Path $root 'labels\jobs.reviewed.json')
```

This is a local private copy, never a Git addition.

- [ ] **Step 3: Stage the evaluated commit in the fixed candidate worktree**

Record the current branch and commit of:
`D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix`.
Require it to be clean. Verify the frozen commit locally, then use the temporary branch
`codex/multi-track-recall-first-live-eval-cebe59f` at the Task 6 evaluated commit. If that
branch already exists, reuse it only when it points exactly to the frozen commit.

Do not detach the active optimization worktree and do not weaken
`FIXED_CANDIDATE_WORKTREE`.

Use:

```powershell
$candidate = 'D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$evaluated = 'cebe59f5aae78abdde873adfe211f296d3322519'
$originalBranch = git -C $candidate branch --show-current
$originalCommit = git -C $candidate rev-parse HEAD
$dirty = git -C $candidate status --porcelain
if ($dirty) { throw 'fixed candidate worktree is dirty' }
$evaluationBranch = 'codex/multi-track-recall-first-live-eval-cebe59f'
$reviewedTooling = 'cebe59f5aae78abdde873adfe211f296d3322519'
git -C $candidate cat-file -e "$evaluated^{commit}"
if ($LASTEXITCODE -ne 0) { throw 'frozen evaluated commit is missing from candidate repository' }
git -C $candidate merge-base --is-ancestor $reviewedTooling $evaluated
if ($LASTEXITCODE -ne 0) { throw 'frozen evaluated commit is not descended from reviewed tooling checkpoint' }
$existingEvaluationBranch = git -C $candidate branch --list $evaluationBranch
if ($existingEvaluationBranch) {
  if ((git -C $candidate rev-parse $evaluationBranch) -ne $evaluated) {
    throw 'existing evaluation branch points to the wrong commit'
  }
  git -C $candidate switch $evaluationBranch
} else {
  git -C $candidate switch -c $evaluationBranch $evaluated
}
if ((git -C $candidate rev-parse HEAD) -ne $evaluated) { throw 'candidate is not at the frozen evaluated commit' }
```

- [ ] **Step 4: Initialize and verify the manifest**

Use:

```powershell
$env:ALLOW_PRIVATE_RESUME_BENCHMARK='YES'
$env:ALLOW_LIVE_MODEL_BENCHMARK='YES'
$runner = 'D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix\scripts\private-full-chain-runner.js'
$candidate = 'D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$baseline = 'D:\DevData\RoleFlow-private-benchmark\baseline-worktree-multi-track-recall-v1'
$baselineProduct = 'fb0168afce265cf351f03e80f66d9e0f24015887'
$baselineEvaluated = '63c2ac393aa6cc8a7728fea6f0944d5f4db9cad6'
$candidateProduct = '87cc68ede886ac0ef3b53f960c38548cce4a831a'
$evaluated = 'cebe59f5aae78abdde873adfe211f296d3322519'
if ((git -C $baseline rev-parse HEAD) -ne $baselineEvaluated) { throw 'baseline evaluated checkpoint drifted' }
if ((git -C $candidate rev-parse HEAD) -ne $evaluated) { throw 'candidate evaluated checkpoint drifted' }
git -C $baseline merge-base --is-ancestor $baselineProduct $baselineEvaluated
if ($LASTEXITCODE -ne 0) { throw 'baseline product is not a strict ancestor of evaluated checkpoint' }
git -C $candidate merge-base --is-ancestor $candidateProduct $evaluated
if ($LASTEXITCODE -ne 0) { throw 'candidate product is not a strict ancestor of evaluated checkpoint' }

node $runner --init-manifest `
  --private-root $root `
  --baseline-worktree $baseline `
  --candidate-worktree $candidate `
  --baseline-product-commit $baselineProduct `
  --candidate-product-commit $candidateProduct `
  --output (Join-Path $root 'run-manifest.json')

node $runner --create-portability-proof `
  --source-private-root $source `
  --private-root $root `
  --proof-version confirmed-evidence-portability.v3 `
  --output (Join-Path $root 'input\confirmed-evidence-portability.json')

node $runner --verify-private-bundle `
  --private-root $root `
  --resume-text (Join-Path $root 'input\resume.redacted.txt') `
  --identity (Join-Path $root 'input\identity.private.json') `
  --parse-report (Join-Path $root 'input\parse-report.json')
```

Every command must exit 0 before a model call.

- [ ] **Step 5: Run only indices 4, 9, and 10**

Run:

```powershell
$stdout = Join-Path $root 'reports\match-live.stdout.log'
$stderr = Join-Path $root 'reports\match-live.stderr.log'
$arguments = @(
  $runner
  '--match-live'
  '--private-root', $root
  '--side', 'candidate'
  '--profile', (Join-Path $root 'input\confirmed-profile.private.json')
  '--matching-card', (Join-Path $root 'input\confirmed-card.private.json')
  '--jobs', (Join-Path $root 'input\jobs.private.json')
  '--labels', (Join-Path $root 'labels\jobs.reviewed.json')
  '--portability-proof', (Join-Path $root 'input\confirmed-evidence-portability.json')
  '--model-settings-root', 'D:\Guo\ZhiPing'
  '--diagnostic-indices', '4,9,10'
  '--output', (Join-Path $root 'runs\candidate')
)
$node = (Get-Command node -ErrorAction Stop).Source
$process = Start-Process `
  -FilePath $node `
  -ArgumentList $arguments `
  -Wait `
  -PassThru `
  -NoNewWindow `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr
if ($process.ExitCode -ne 0) {
  throw "live match failed with exit code $($process.ExitCode); inspect the private logs under $root"
}
```

Acceptance:

- index 4 selects the large-model application branch, returns `primary/apply`, and does not contain front-end or deep-learning branch requirements;
- index 9 remains one `T1` and returns `backup/review`; AI coding-tool use cannot turn pure UI/visual front-end delivery into an adjacent AI-application role;
- index 10 remains one `T1` and returns at least `talk/caution`; generic stability, communication, solution-design, learning, or documentation gaps cannot alone push it to `backup`;
- only index 4 may contain more than one hiring track; a long responsibility list or wish-list requirement stack must not make indices 9 or 10 split;
- every row has non-empty `selectedTrackId`, `selectedTrackLabel`, role summary, JD evidence, and resume evidence;
- every normal row has `modelCallCount === 2`;
- no row is failed, stale, pending, partial, hard blocked, or empty-response;
- at most one existing contract-repair attempt may occur and must be recorded.

- [ ] **Step 6: Stop on the first miss**

If any structural or bucket condition fails, preserve the private root, restore the fixed worktree, and diagnose only the failing row. Do not start Task 8 and do not rerun all three blindly.

- [ ] **Step 7: Restore the fixed worktree**

Switch the fixed candidate worktree back to its recorded original branch and commit. Verify:

```powershell
git -C $candidate switch $originalBranch
if ((git -C $candidate rev-parse HEAD) -ne $originalCommit) {
  throw 'fixed candidate worktree did not return to the recorded commit'
}
git -C 'D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix' status --short
```

Expected: no output.

---

### Task 8: Run the final 20-row acceptance

**Files:**

- No repository files during the live run.
- Private root:
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-20-v3-20260730`
- Modify after the run:
  `docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md`

**Interfaces:**

- Consumes the same frozen profile/card/jobs/labels and the Task 6 evaluated commit.
- Produces one complete candidate result and a private human-review summary.

- [ ] **Step 1: Create a new private root**

Run this complete setup:

```powershell
$source = 'D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725'
$pool = 'D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730'
$root = 'D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-20-v3-20260730'
$candidate = 'D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$baseline = 'D:\DevData\RoleFlow-private-benchmark\baseline-worktree-multi-track-recall-v1'
$runner = Join-Path $candidate 'scripts\private-full-chain-runner.js'
$evaluated = 'cebe59f5aae78abdde873adfe211f296d3322519'
$candidateProduct = '87cc68ede886ac0ef3b53f960c38548cce4a831a'
$baselineProduct = 'fb0168afce265cf351f03e80f66d9e0f24015887'
$baselineEvaluated = '63c2ac393aa6cc8a7728fea6f0944d5f4db9cad6'

$jobsHash = (Get-FileHash -Algorithm SHA256 (Join-Path $pool 'input\jobs.private.json')).Hash.ToLower()
$labelsHash = (Get-FileHash -Algorithm SHA256 (Join-Path $pool 'labels\jobs.reviewed.json')).Hash.ToLower()
if ($jobsHash -ne '612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b') {
  throw 'frozen job pool hash changed'
}
if ($labelsHash -ne '97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39') {
  throw 'frozen label hash changed'
}
if (Test-Path -LiteralPath $root) { throw "private root already exists: $root" }
foreach ($directory in @('input', 'labels', 'runs\candidate', 'reports')) {
  New-Item -ItemType Directory -Path (Join-Path $root $directory) | Out-Null
}
foreach ($file in @(
  'confirmed-profile.private.json',
  'confirmed-card.private.json',
  'identity.private.json',
  'resume.redacted.txt',
  'parse-report.json'
)) {
  Copy-Item -LiteralPath (Join-Path $source "input\$file") -Destination (Join-Path $root "input\$file")
}
Copy-Item -LiteralPath (Join-Path $pool 'input\jobs.private.json') -Destination (Join-Path $root 'input\jobs.private.json')
Copy-Item -LiteralPath (Join-Path $pool 'labels\jobs.reviewed.json') -Destination (Join-Path $root 'labels\jobs.reviewed.json')

$originalBranch = git -C $candidate branch --show-current
$originalCommit = git -C $candidate rev-parse HEAD
if (git -C $candidate status --porcelain) { throw 'fixed candidate worktree is dirty' }
$evaluationBranch = 'codex/multi-track-recall-first-live-eval-cebe59f'
git -C $candidate switch $evaluationBranch
if ((git -C $candidate rev-parse HEAD) -ne $evaluated) { throw 'evaluation branch is not at the approved checkpoint' }
if ((git -C $baseline rev-parse HEAD) -ne $baselineEvaluated) { throw 'baseline evaluated checkpoint drifted' }
git -C $baseline merge-base --is-ancestor $baselineProduct $baselineEvaluated
if ($LASTEXITCODE -ne 0) { throw 'baseline product is not a strict ancestor of evaluated checkpoint' }
git -C $candidate merge-base --is-ancestor $candidateProduct $evaluated
if ($LASTEXITCODE -ne 0) { throw 'candidate product is not a strict ancestor of evaluated checkpoint' }

$env:ALLOW_PRIVATE_RESUME_BENCHMARK='YES'
$env:ALLOW_LIVE_MODEL_BENCHMARK='YES'
node $runner --init-manifest `
  --private-root $root `
  --baseline-worktree $baseline `
  --candidate-worktree $candidate `
  --baseline-product-commit $baselineProduct `
  --candidate-product-commit $candidateProduct `
  --output (Join-Path $root 'run-manifest.json')
node $runner --create-portability-proof `
  --source-private-root $source `
  --private-root $root `
  --proof-version confirmed-evidence-portability.v3 `
  --output (Join-Path $root 'input\confirmed-evidence-portability.json')
node $runner --verify-private-bundle `
  --private-root $root `
  --resume-text (Join-Path $root 'input\resume.redacted.txt') `
  --identity (Join-Path $root 'input\identity.private.json') `
  --parse-report (Join-Path $root 'input\parse-report.json')
```

Do not copy `runs\candidate\model-cache.sqlite` from the three-row diagnostic. The 20-row run must use a fresh candidate cache.

- [ ] **Step 2: Run all 20 without diagnostic indices**

Run:

```powershell
node $runner --match-live `
  --private-root $root `
  --side candidate `
  --profile (Join-Path $root 'input\confirmed-profile.private.json') `
  --matching-card (Join-Path $root 'input\confirmed-card.private.json') `
  --jobs (Join-Path $root 'input\jobs.private.json') `
  --labels (Join-Path $root 'labels\jobs.reviewed.json') `
  --portability-proof (Join-Path $root 'input\confirmed-evidence-portability.json') `
  --model-settings-root 'D:\Guo\ZhiPing' `
  --output (Join-Path $root 'runs\candidate')
```

Do not access BOSS and do not refresh any JD; the frozen JSON is the full input.

- [ ] **Step 3: Calculate exact acceptance**

From `runs\candidate\match-result.json`, calculate:

```js
const exact = rows.filter((row) =>
  row.actualRecommendation === row.expectedRecommendation
  && row.actualBucket === row.expectedBucket
);
const falseNegative = rows.slice(0, 15).filter((row) =>
  row.actualBucket === "not_recommended"
);
const falsePrimary = rows.slice(15).filter((row) =>
  row.actualBucket === "primary"
);
const wrong = rows.filter((row) => !exact.includes(row));
```

Acceptance requires:

- exact bucket/recommendation hit count at least `18/20`;
- rows 1–15 never `not_recommended`;
- rows 16–20 never `primary`;
- row 5 exactly `primary/apply` and selected to the large-model application branch;
- `failed`, `stale`, `pending`, `partial`, `primaryWithoutEvidence`, `hardFalsePlacement`, and `falseHardExclusion` all equal zero;
- every normal row uses exactly two model calls;
- selected-track fields are present on all complete rows.

- [ ] **Step 4: Show every miss instead of hiding it in an aggregate**

For each wrong row, prepare a private review table with:

```text
样本序号 | 预期档位 | 实际档位 | selectedTrackId | 匹配分支 | 主体匹配 |
核心要求状态 | 关键缺口数量 | 是否硬阻断 | 两次调用耗时
```

Do not paste company name, URL, full JD, full resume evidence, endpoint, or credentials into the repository.

If exact result is 18/20 or 19/20, show every miss to the user and ask whether the remaining difference is acceptable. If below 18/20, return to the first wrong row for root-cause analysis; do not repeatedly run all 20.

- [ ] **Step 5: Run final offline verification on the frozen evaluated worktree**

Run:

```powershell
if ((git -C $candidate rev-parse HEAD) -ne $evaluated) {
  throw 'candidate left the frozen evaluated commit before final verification'
}
node (Join-Path $candidate 'tests\semantic_pipeline_smoke.js')
node (Join-Path $candidate 'tests\model_adapter_smoke.js')
node (Join-Path $candidate 'tests\screening_quality_smoke.js')
node (Join-Path $candidate 'tests\workflow_inventory_smoke.js')
node (Join-Path $candidate 'tests\workflow_dashboard_smoke.js')
node (Join-Path $candidate 'tests\private_full_chain_runner_smoke.js')
npm.cmd --prefix $candidate test
```

All tests must pass while the fixed candidate worktree is still exactly at `cebe59f5aae78abdde873adfe211f296d3322519`.

- [ ] **Step 6: Restore the fixed worktree**

Run:

```powershell
git -C $candidate switch $originalBranch
if ((git -C $candidate rev-parse HEAD) -ne $originalCommit) {
  throw 'fixed candidate worktree did not return to the recorded commit'
}
if (git -C $candidate status --porcelain) {
  throw 'fixed candidate worktree is dirty after restore'
}
```

- [ ] **Step 7: Record only private-safe results**

Update this plan with:

- evaluated/product commit hashes;
- model identity hash, not model configuration;
- exact hit count and four bucket counts;
- total/average/median/maximum analysis latency;
- total model calls, attempts, empty responses, repairs, and failed/stale/pending counts;
- wrong sample numbers and their expected/actual buckets;
- selected track ID for sample 5;
- user acceptance decision for an 18/20 or 19/20 result.

- [ ] **Step 8: Commit the acceptance record from the explicit docs worktree**

```powershell
$docsWorktree = 'C:\Users\Administrator\.codex\worktrees\e843\ZhiPing'
if ((git -C $docsWorktree branch --show-current) -ne 'codex/multi-track-recall-continuation') {
  throw 'acceptance record worktree is on the wrong branch'
}
git -C $docsWorktree merge-base --is-ancestor $evaluated HEAD
if ($LASTEXITCODE -ne 0) { throw 'docs worktree does not contain the frozen evaluated checkpoint' }
git -C $docsWorktree diff --check
$docsStatus = git -C $docsWorktree status --short
if (($docsStatus | Where-Object { $_ -notmatch '2026-07-30-multi-track-recall-first-matching\.md$' })) {
  throw 'unexpected docs worktree changes'
}
git -C $docsWorktree add -- docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md
git -C $docsWorktree commit -m "docs: record multi-track recall acceptance"
```

Expected: the acceptance record commit is a descendant of the frozen evaluated checkpoint; it is documentation only and never replaces `cebe59f5aae78abdde873adfe211f296d3322519` in the private manifest.

Do not merge to `main`, do not modify the formal project, and do not push until the user has reviewed the result.

## 2026-07-30 live-shell interruption checkpoint

- Preserve `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-job-schema-20260730` unchanged as shell-orchestration interruption evidence.
- The live wrapper used PowerShell with `$ErrorActionPreference = 'Stop'`. Node wrote the SQLite experimental warning to stderr, and PowerShell terminated the wrapper before it captured a trustworthy native exit code.
- Read-only inspection found no `runs\candidate\match-result.json`, zero-byte redirected stdout and stderr logs, zero model-cache rows, and no application/model/state rows. This is not evidence of a completed model result and must not be treated as a 3-row acceptance outcome.
- Do not rerun in that root. Use the fresh, initially absent root `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-live-run-20260730`.
- Keep evaluated candidate `cebe59f5aae78abdde873adfe211f296d3322519`, evaluated baseline `63c2ac393aa6cc8a7728fea6f0944d5f4db9cad6`, zero-based `--diagnostic-indices '4,9,10'`, and the v1 source evidence unchanged.
- For the next live invocation, use a native-process wrapper that redirects stdout/stderr without promoting warnings to terminating PowerShell errors, and capture the process exit code directly.
## 2026-07-30 private contract-failure diagnostic checkpoint

This checkpoint supersedes Task 7's next-action instructions. Do not execute
the three-row live command in Task 7 again.

- The fresh root `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-live-run-20260730` completed with native exit code `0` and produced three logical rows.
- Zero-based index `4` failed after `matchJob` contract repair with `MODEL_CONTRACT_INVALID`, `semanticStatus=failed`, and `actualBucket=analysis_pending`. Its selected track, role summary, and complete evidence were absent.
- Zero-based indices `9` and `10` were structurally complete, but the three-row run is not accepted because the first row failed.
- Preserve that root unchanged. Do not rerun it and do not use its cache for another run.
- The 20-row root `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-20-v3-20260730` must remain absent.
- Privacy-safe field diagnostics were added with red-green evidence in candidate commits `7de5d8d9b29cb1f6ea4b6d1a9f4b74d9b0f2db26` and `4416d295f10bedf1f6774a5b0dc37dd4836ac0b2`.
- The final reviewed candidate evaluated commit is `4416d295f10bedf1f6774a5b0dc37dd4836ac0b2`.
- The mechanically mirrored baseline evaluated commit is `d20606192986f40f49db634e6db999f3cd5d576c`.
- Candidate product remains `87cc68ede886ac0ef3b53f960c38548cce4a831a`; baseline product remains `fb0168afce265cf351f03e80f66d9e0f24015887`.
- Candidate verification passed the private runner smoke, 31 benchmark fixtures, all 47 offline checks, and diff check.
- Baseline verification passed 31 benchmark fixtures, all 41 native offline checks, and diff check.
- Shared blobs match: runner `f45d50450ccd294917db5cc5d995c34eac403c50`, metrics `0edda7c2449639f3fecdee394fa60cc2f0447c05`, and privacy `8a4b21d7493fb5e7d8ce49662ba3951687903c46`.
- Independent review found no Critical, Important, or Moderate issue and concluded `Spec PASS` and `Code quality APPROVED`.

The only permitted next live root is:

`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-diagnostic-v1-20260730`

Create it from the unchanged v1 confirmed evidence and frozen pool, use a new
empty cache and v3 portability proof, stage candidate branch
`codex/multi-track-recall-contract-diagnostic-v1` at
`4416d295f10bedf1f6774a5b0dc37dd4836ac0b2`, and run exactly zero-based
`--diagnostic-indices '4'`. Inspect only the two fixed contract-failure
categories and existing safe status fields. This one-row result is diagnostic
evidence, not acceptance. Restore the fixed candidate worktree immediately and
do not start the three-row or 20-row acceptance until the category identifies
the next reviewed root-cause change.

## 2026-07-30 契约失败原因码复审检查点

- 类别级单条诊断目录 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-diagnostic-v1-20260730` 保持不可变；其安全字段为 initial/repair category 均为 `other`，不足以定位具体 validator 规则，不能覆盖或复用。
- 原因码设计与计划扩展提交为 `4434b6d60de47fef8ff8584a4a68cf6c32c13ec9`。初版实现提交为 `2508b9c6f2872a47d1c5b75e712a8cffbb026cc6`；独立复审发现 failed-only initial reason 未对称回填、以及 pure-unknown/multi-template 回归覆盖不足。
- TDD 修复提交为 `3903b5c0a2a2138033ecd96a46fe7995761df6f5`：先以 failed-only 用例稳定复现 `initial reason = none`，再增加封闭枚举回填；pure unknown 与多模板歧义均固定归为 `other`。复审结论：无 Critical/Important/Moderate/Minor，`Spec PASS`，`Code quality APPROVED`。
- 候选离线证据：`private_full_chain_runner_smoke` 通过，`job_match_benchmark` 31 fixtures 通过，`npm.cmd test` 47 项通过，`git diff --check` 通过，工作树干净。
- 基线只机械镜像 `scripts/private-full-chain-runner.js`，提交为 `90606956713c3666fca42a30f4afd3f0a33af133`；31 fixtures、41 项离线检查、`git diff --check` 均通过，工作树干净。
- 三个共享 Git blob 候选/基线一致：runner `52935822d9b6141ec871b85e2c97cc8719324ef2`，metrics `0edda7c2449639f3fecdee394fa60cc2f0447c05`，privacy `8a4b21d7493fb5e7d8ce49662ba3951687903c46`。
- 产品提交不变：候选 `87cc68ede886ac0ef3b53f960c38548cce4a831a`，基线 `fb0168afce265cf351f03e80f66d9e0f24015887`；产品提交必须继续是 evaluated commit 的严格祖先。
- 下一 live 步骤只允许使用全新目录 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v1-20260730`、全新缓存和零基 `--diagnostic-indices '4'`。先核验冻结岗位池 raw SHA；只读取闭合的安全状态/category/reason 字段；完成后立即恢复固定候选原分支 `codex/claude-generic-evidence-matching-live-fix` @ `1fc49dac3670a71c720bfcaed943fa29204d93c5` 并确认干净。
- 在单条原因码证据支持产品侧根因修复、离线回归与独立复审前，不得重新运行 3 条，也不得创建或运行 20 条目录。

### Evaluated 绑定替换说明

- 本检查点明确 supersede（替换）前一个 category checkpoint 的“下一 live 动作”和 evaluated 绑定；旧 `4416d295f10bedf1f6774a5b0dc37dd4836ac0b2` 及其 category root 只保留为不可变历史证据，不再是 reason live 的允许 HEAD 或允许 next root。
- 新 candidate evaluated 精确为 `3903b5c0a2a2138033ecd96a46fe7995761df6f5`；新 baseline evaluated 精确为 `90606956713c3666fca42a30f4afd3f0a33af133`。后续 docs-only checkpoint 只记录证据，不替换这两个 evaluated 提交。
- 创建 reason root 前，临时候选分支 `codex/multi-track-recall-contract-diagnostic-v1` 必须精确指向并检出 candidate evaluated `3903b5c0a2a2138033ecd96a46fe7995761df6f5`；基线分支 `codex/multi-track-recall-private-baseline-v1` 的 HEAD 必须精确为 baseline evaluated `90606956713c3666fca42a30f4afd3f0a33af133`，两边工作树都必须干净。
- reason root 的 manifest 与 v3 proof 必须分别绑定上述 candidate/baseline evaluated；任一 HEAD、绑定或冻结输入哈希不符都立即停止，不运行模型。
- 已重新验证产品提交的严格祖先关系：candidate product `87cc68ede886ac0ef3b53f960c38548cce4a831a` 是 candidate evaluated 的严格祖先；baseline product `fb0168afce265cf351f03e80f66d9e0f24015887` 是 baseline evaluated 的严格祖先。

### Reason v1 建根失败与 v2 替换

- `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v1-20260730` 在建根阶段因 PowerShell 原生重定向报 `path format is not supported` 而中止；固定候选已在 `finally` 中恢复原分支/原提交并确认干净。
- 安全状态核验：v1 根已有 manifest 与 v3 proof，但没有 `model-cache.sqlite`、没有 `match-result.json`，未发现真实模型运行产物，不能将该根视为已运行或验收证据；该根保持不可变，禁止覆盖、删除、补跑或复用。
- 本条 supersede 上一节对 reason v1 的 next-root 绑定。新的唯一允许 reason live 根为 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v2-20260730`；开始前必须不存在，并重新复制 7 个冻结文件、重新核验 raw SHA、重新生成 manifest/v3 proof、重新执行 candidate/baseline 双侧 preflight。
- v2 继续绑定 candidate evaluated `3903b5c0a2a2138033ecd96a46fe7995761df6f5` 与 baseline evaluated `90606956713c3666fca42a30f4afd3f0a33af133`，只运行零基 `--diagnostic-indices '4'`。命令输出只写 v2 私有 reports；改用 `Start-Process` 的 stdout/stderr 重定向，避免重现 shell 重定向错误。
- v2 live 完成或失败后都必须恢复固定候选 `codex/claude-generic-evidence-matching-live-fix` @ `1fc49dac3670a71c720bfcaed943fa29204d93c5` 并确认干净；3 条和 20 条继续 gated。

### Reason v2 CLI 根因与 v3 替换

- `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v2-20260730` 在 candidate `--preflight` 命令处以 CLI argument 错误停止；runner 的实际 `MODES` 集合不包含 `preflight`，因此不存在可单独调用的 `--preflight` 模式。v2 没有 cache/result，保持不可变并禁止补跑、覆盖或复用。
- 旧成功 category 诊断根只有 `match-live` 私有日志，也佐证此前“preflight 通过”指 live 前的编排门禁与 `match-live` 内部 preflight，不是一个独立 CLI 命令。
- 本条 supersede reason v2 的 next-root 绑定。新的唯一允许根为 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v3-20260730`；必须全新复制 7 个冻结文件并核验 raw SHA，全新生成 manifest/v3 proof，重新 verify-private-bundle，并在 live 前显式核验 candidate/baseline HEAD、clean、产品提交严格祖先、三个共享 blob、固定分支、输出不存在。
- 不再调用不存在的 `--preflight`。候选 `--match-live` 会在模型配置解析与模型调用前执行 runner 内部 manifest、proof、隐私、fixture、diagnostic-index 等 preflight；任一失败都会在 live 产物中止并由外层 `finally` 恢复固定候选。
- v3 继续精确绑定 candidate evaluated `3903b5c0a2a2138033ecd96a46fe7995761df6f5` 与 baseline evaluated `90606956713c3666fca42a30f4afd3f0a33af133`，只运行零基 `--diagnostic-indices '4'`，所有 stdout/stderr 只写 v3 私有 reports。3 条和 20 条继续 gated。

## 2026-07-30 `result_not_object` evaluated 检查点

- reason v3 根 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v3-20260730` 已以冻结 raw SHA 和零基 index `4` 可信退出 0；安全结果为 total 1、failed 1、`MODEL_CONTRACT_INVALID`、matchJob/contract_repair，initial/repair category 与 reason 均为 `other`，未持久化原始错误或 shape。固定候选已恢复原分支/原提交并干净，20 条根仍不存在。v3 保持 immutable。
- 静态 validator 对照将该结果限定为分类器缺口推断；新增闭合 reason `result_not_object` 只匹配固定“必须返回 JSON 对象”或 `must return a JSON object`，category 为 `result_shape`，不保存 raw/capture/key/length/`outputShape`。
- 初版 TDD 提交 `43950770a3e373b98b2f6273317a269eebffbd10`；独立复审指出 category 提前返回会绕过歧义去重、英文模板缺独立覆盖。修复提交 `31e53ef6e728912e19fd207b2b28b4ecf9f6b6d5` 已把 result-shape 纳入统一去重，并锁定中文单模板、英文单模板与混合模板。最终复审无 Critical/Important/Moderate/Minor，`Spec PASS`、`Code quality APPROVED`。
- 新 candidate evaluated 精确为 `31e53ef6e728912e19fd207b2b28b4ecf9f6b6d5`；候选 focused smoke、31 fixtures、47 项离线检查、diff check 全通过，工作树干净。
- 基线仅机械镜像 runner，提交 `fb2f6fe17b171f7cc974b75c6a3740d614c2cacd`；31 fixtures、41 项离线检查、diff check 全通过，工作树干净。新 baseline evaluated 精确为该提交。
- 三项共享 blob 一致：runner `630d958d6de81e0ed2e57ad9d72231919b917b70`，metrics `0edda7c2449639f3fecdee394fa60cc2f0447c05`，privacy `8a4b21d7493fb5e7d8ce49662ba3951687903c46`。
- 本检查点 supersede 此前 reason v1-v3 的 next-root 与旧 evaluated 绑定；v1-v3 只作 immutable 历史证据。后续 docs-only commit 不替换上述 candidate/baseline evaluated。
- 唯一允许的下一根为 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v4-20260730`。临时候选分支与 manifest/proof 必须绑定 candidate evaluated `31e53ef6e728912e19fd207b2b28b4ecf9f6b6d5`，基线 HEAD 与 manifest/proof 必须绑定 baseline evaluated `fb2f6fe17b171f7cc974b75c6a3740d614c2cacd`；重新复制 7 文件、raw SHA、v3 proof、bundle 与所有外层 gates，只运行零基 index `4`，私有日志，最后恢复固定候选。
- 产品提交保持候选 `87cc68ede886ac0ef3b53f960c38548cce4a831a` 与基线 `fb0168afce265cf351f03e80f66d9e0f24015887`，并继续是对应 evaluated 的严格祖先。v4 确认具体规则前不得做产品修复、3 条或 20 条运行。

## 2026-07-30 matchJob 阶段隔离与 sparse reason 检查点

- reason v4 根 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v4-20260730` 可信退出 0；安全结果仍为 matchJob/contract_repair failed、initial/repair `other/other`，但 `modelCallCount=4`、`contractRepairCount=2`。固定候选恢复原分支/提交并干净，20 根不存在；v4 immutable。
- 源码对照发现固定 validator 规则 `multi-track matching requires sparse evidence` 未被分类，且旧 collector 混合 understandJob/matchJob repair。该证据只支持分类器候选，不宣称产品根因。
- 新闭合 reason `multi_track_requires_sparse` 对应 category `result_shape`。新增有界整数 `understandJobContractRepairCount` 与 `matchJobContractRepairCount`；total 统计所有 exact requested，两个子计数只统计已知 kind；四个原因字段只接受 matchJob 事件，unknown kind 只增加 total，failed-only 可回填，逐行 reset。
- 实现提交 `82ae8477c28dab2cc2863749959f0a03df9dff53`；后续测试加强提交 `269430f3e9aae1705b0503f5ff4e83df7da6c280` 与 `c4418e5314e8694c727f56a55ba5486ff2fb1e69` 分别锁定 unknown 后置不覆盖，以及严格 sparse+roleAlignment 双模板歧义。最终独立复审无 Critical/Important/Moderate/Minor，`Spec PASS`、`Code quality APPROVED`。
- 新 candidate evaluated 精确为 `c4418e5314e8694c727f56a55ba5486ff2fb1e69`；focused、31 fixtures、47 项离线检查、diff check 通过且 clean。
- 基线只镜像 runner，提交及新 baseline evaluated 为 `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5`；31 fixtures、41 项离线检查、diff check 通过且 clean。
- 共享 blob 一致：runner `c80e179d9e665b5e75139dfa9704107e95c5300c`，metrics `0edda7c2449639f3fecdee394fa60cc2f0447c05`，privacy `8a4b21d7493fb5e7d8ce49662ba3951687903c46`。
- 本检查点 supersede reason v1-v4 next-root 与旧 evaluated；v1-v4 immutable。docs-only commit 不替代 candidate/baseline evaluated。
- 唯一 next root 为 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v5-20260730`，全新复制/哈希/manifest/v3 proof/bundle/gates，临时分支和 manifest/proof 精确绑定 candidate evaluated `c4418e5314e8694c727f56a55ba5486ff2fb1e69`，基线绑定 `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5`，仅零基 index `4`，私有日志，finally 恢复固定候选。
- 产品 commits 仍为 candidate `87cc68ede886ac0ef3b53f960c38548cce4a831a`、baseline `fb0168afce265cf351f03e80f66d9e0f24015887` 且为严格祖先。v5 确认前不得产品修复、3 条或 20 条。

## 2026-07-30 multi-track sparse repair product checkpoint

- This checkpoint supersedes the prior reason-v5 next action and product
  binding. All earlier diagnostic roots remain immutable historical evidence.
- Reason v5 at
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v5-20260730`
  exited `0` for exact zero-based index `4`. Its private-safe result was one
  failed row at `matchJob` contract repair: initial and repair category
  `result_shape`, reason `multi_track_requires_sparse`, one match repair, zero
  understand-job repairs, no selected track, and incomplete evidence. The raw
  response shape was neither persisted nor inspected; this proves the repeated
  strict sparse-validator failure, not any particular raw legacy key.
- Reviewed design checkpoint `ce3a6f1ae1dc30c6fa2f9a1d9b471ce92a17216c`
  chose exact-key prompt reinforcement plus narrowly targeted repair
  de-anchoring. Product commit
  `9783d0b652ebb4db2233dba6135615494ca2feb9` implements it without weakening
  the validator, adding a repair, changing DeepSeek thinking policy, mutating
  caller input, or changing unrelated repair inputs.
- The TDD regression failed first on the absent exact six-key contract. After
  implementation, `model_adapter_smoke`, `semantic_pipeline_smoke`, all 31
  benchmark fixtures, all 47 candidate offline checks, and `git diff --check`
  passed from a clean product commit. Independent review found no Critical,
  Important, Moderate, or Minor findings and concluded `Spec PASS` and
  `Code quality APPROVED`.
- The docs-only commit produced by this checkpoint is the new candidate
  evaluated commit. A direct descendant docs-only binding record must add its
  exact SHA before any private root is created; that later record does not
  replace the evaluated commit. Candidate product `9783d0b652ebb4db2233dba6135615494ca2feb9`
  must be its strict ancestor.
- Baseline product remains
  `fb0168afce265cf351f03e80f66d9e0f24015887`; baseline evaluated remains
  `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5`. No shared harness file changed,
  so the reviewed candidate/baseline blobs remain runner
  `c80e179d9e665b5e75139dfa9704107e95c5300c`, metrics
  `0edda7c2449639f3fecdee394fa60cc2f0447c05`, and privacy
  `8a4b21d7493fb5e7d8ce49662ba3951687903c46`.
- Recheck the frozen pool before every live root: jobs raw SHA-256
  `612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b`
  and labels raw SHA-256
  `97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39`.
- Preserve the existing
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-20260730`
  unchanged. The only permitted three-row acceptance root is the initially
  absent
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-sparse-repair-v1-20260730`.
  Create/copy/hash all seven frozen files, generate and verify manifest plus
  v3 proof, confirm cache/result/output absence, then run exact zero-based
  `--diagnostic-indices '4,9,10'` with a fresh cache.
- The 20-row root
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-20-v3-20260730`
  must remain absent until all three rows are structurally complete and pass
  their expected bucket/recommendation and safety gates. The 20-row run must
  rebuild its own root, manifest, v3 proof, and fresh cache.
- Every live attempt must stage
  `codex/multi-track-recall-contract-diagnostic-v1` at the exact candidate
  evaluated commit, bind candidate/baseline product and evaluated commits in
  the manifest/proof, and restore
  `codex/claude-generic-evidence-matching-live-fix` at
  `1fc49dac3670a71c720bfcaed943fa29204d93c5` with clean status in `finally`.

### Exact evaluated binding

- Candidate evaluated is exactly
  `e906f6b55c112e89b2a9ec43c9c8168ea74786b9`. Candidate product
  `9783d0b652ebb4db2233dba6135615494ca2feb9` must be verified as its strict
  ancestor immediately before root creation.
- This binding record is documentation-only and does not replace candidate
  evaluated `e906f6b55c112e89b2a9ec43c9c8168ea74786b9` in the manifest, v3 proof,
  temporary evaluation branch, or final offline verification.
- Baseline evaluated remains exactly
  `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5`, with baseline product
  `fb0168afce265cf351f03e80f66d9e0f24015887` as its strict ancestor.

### Sparse-repair three-row v1 orchestration failure and v2 replacement

- Preserve
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-sparse-repair-v1-20260730`
  unchanged. Manifest initialization, v3 proof creation, and bundle
  verification each exited `0`, but an extra outer assertion incorrectly
  required the v3 portability proof to contain the baseline evaluated commit.
  The failure occurred before `match-live`; no model cache, match result, or
  match-live stdout/stderr file exists. The fixed candidate was restored to
  `codex/claude-generic-evidence-matching-live-fix` at
  `1fc49dac3670a71c720bfcaed943fa29204d93c5` with clean status.
- The runner-owned schemas are authoritative: `run-manifest.json` binds both
  candidate and baseline product/evaluated commits. The v3 portability proof
  separately binds its historical source product/evaluated commits and current
  target candidate product/evaluated commits plus the three consumer blobs; it
  does not carry a baseline evaluated field. The successful bundle verifier
  validates this division of responsibility.
- The only permitted replacement root is the initially absent
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-sparse-repair-v2-20260730`.
  Rebuild all seven frozen files, manifest, v3 proof, and verifier outputs.
  Require the manifest to bind all four candidate/baseline commits; require the
  proof to bind target product
  `9783d0b652ebb4db2233dba6135615494ca2feb9` and target evaluated
  `e906f6b55c112e89b2a9ec43c9c8168ea74786b9`. Do not add a synthetic baseline
  field requirement to the proof.
- All other gates remain unchanged: exact raw hashes, identical shared blobs,
  zero-based `4,9,10`, fresh cache/output absence, no 20-row root, private log
  redirection, and fixed-candidate restoration in `finally`.

## 2026-07-30 multi-track validation idempotence product checkpoint

- Preserve
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-sparse-repair-v2-20260730`
  unchanged. Its live process exited `0`: indices `9` and `10` were exact and
  structurally complete, while zero-based index `4` failed after one
  `matchJob` repair with initial/repair category `result_shape`, reason
  `multi_track_requires_sparse`, empty selected track, and incomplete evidence.
  The private-safe aggregate was two of three exact, with no false hard
  exclusion, primary-without-evidence, hard false placement, or missed obvious
  exclusion. The fixed candidate was restored cleanly and the 20-row root
  remained absent.
- Static control-flow inspection, not raw model-output inspection, established
  the product root cause. `validateSparseMatchEvidence` derived a full local
  decision but discarded its validated `matches` and `eligibility`; subsequent
  analyzer/cache validation therefore routed the normalized multi-track value
  through the forbidden legacy full-decision path. The v2 result does not prove
  that DeepSeek returned a legacy shape.
- Reviewed design commit
  `9ca6ddf391a208635711ff6cff3992c0179b4d75` selected validation idempotence:
  retain only the two already normalized sparse arrays in the internal
  decision, keep every validation layer, and increment the match pipeline from
  v28 to v29.
- Product commit
  `099a71331f74d0b21a149b835908744e74962794` implements that design. The focused
  regression first failed because normalized `matches` was absent, then passed
  multi-/single-track repeat validation, JSON cache round-trip, raw extra-key
  and privacy-sentinel removal, injected-adapter validation, legacy boundary
  checks, and v28 stale behavior.
- Candidate verification passed `model_adapter_smoke`,
  `semantic_pipeline_smoke`, all 31 benchmark fixtures, all 47 offline checks,
  and `git diff --check` from a clean product commit. Independent review found
  no Critical, Important, Moderate, or Minor finding and concluded
  `Spec PASS` and `Code quality APPROVED`.
- The docs-only commit produced by this checkpoint is the next candidate
  evaluated commit. Its exact SHA must be recorded by an immediate descendant
  docs-only binding record before private root creation. Candidate product
  `099a71331f74d0b21a149b835908744e74962794` must be its strict ancestor.
- Baseline product/evaluated remain
  `fb0168afce265cf351f03e80f66d9e0f24015887` /
  `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5`; no shared harness file changed,
  so runner/metrics/privacy blobs remain
  `c80e179d9e665b5e75139dfa9704107e95c5300c`,
  `0edda7c2449639f3fecdee394fa60cc2f0447c05`, and
  `8a4b21d7493fb5e7d8ce49662ba3951687903c46`.
- Preserve both sparse-repair v1/v2 roots. The only permitted next three-row
  root is the initially absent
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-validation-idempotence-v1-20260730`.
  Rebuild all seven frozen files, exact hashes, manifest, v3 proof, verifier
  outputs, and fresh cache; run exact zero-based `4,9,10`; restore the fixed
  candidate in `finally`. Do not create the 20-row root until all three rows
  pass exact, structural, recall, and safety gates.

### Validation-idempotence exact evaluated binding

- Candidate evaluated is exactly
  `e28333c0e1410fb6d784aa6f0dc93cb3b695eacb`. Candidate product
  `099a71331f74d0b21a149b835908744e74962794` must be verified as its strict
  ancestor immediately before root creation.
- This docs-only binding record does not replace candidate evaluated
  `e28333c0e1410fb6d784aa6f0dc93cb3b695eacb` in the manifest, v3 proof,
  temporary evaluation branch, or final offline verification.
- Baseline evaluated/product remain exactly
  `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5` /
  `fb0168afce265cf351f03e80f66d9e0f24015887`.

## 2026-07-30 broad requirement direct-instance product checkpoint

- Preserve
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-validation-idempotence-v1-20260730`
  unchanged. All three rows were structurally complete with selected tracks,
  evidence, no hard blockers, and no contract/empty-response failure. Index
  `9` was exact. Index `4` was `caution/talk` instead of confirmed
  `apply/primary`; index `10` was `review/talk` instead of confirmed
  `caution/talk`. The 20-row root remained absent and the fixed candidate was
  restored cleanly.
- The first wrong row's private-safe state isolated its false caution: every
  central requirement was `matched`; two non-core rows were `missing`; one
  non-central foundation/indispensable row was `transferable`. Local policy
  therefore behaved consistently, but the evidence classification did not
  meet the confirmed label.
- Public synthetic fixtures prove that globally promoting transferable
  indispensable evidence would break valid cross-domain caution behavior.
  Reviewed locally, design commit
  `5fcf7399f4d40464f3de2d9f7b7a63a3e95d0304` therefore keeps local policy
  unchanged and strengthens only the generic prompt boundary: a concrete
  direct instance of a broad unqualified capability is `matched`, while an
  explicitly named but unproved domain/platform/tool/work difference remains
  `transferable`.
- Product commit
  `2ef0798bea0c33ae267d0fee8649ff673e9665b4` adds that symmetric prompt rule
  without private examples and increments the match pipeline from v29 to v30.
  The prompt assertion failed before implementation, then adapter, semantic
  pipeline, all six generic evidence fixtures, all 31 benchmark fixtures, all
  47 offline checks, and `git diff --check` passed from a clean commit.
- Independent reviewer capacity was exhausted during this checkpoint. No
  independent approval is claimed. The change is limited to prompt text,
  version invalidation, and tests; the next immutable three-row live result is
  an additional required gate. A later independent review must still be
  attempted if capacity returns.
- The docs-only commit produced by this checkpoint is the next candidate
  evaluated commit. Its exact SHA must be recorded by an immediate descendant
  docs-only binding record. Candidate product
  `2ef0798bea0c33ae267d0fee8649ff673e9665b4` must be its strict ancestor.
- Baseline product/evaluated and all three shared harness blobs remain
  unchanged. The only permitted next three-row root is the initially absent
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-direct-instance-v1-20260730`.
  Rebuild the seven frozen files, exact hashes, manifest, v3 proof, verifier
  outputs, and fresh cache; run zero-based `4,9,10`; restore the fixed
  candidate in `finally`. Keep the 20-row root absent unless all three pass.

### Direct-instance exact evaluated binding

- Candidate evaluated is exactly
  `4845fb37d5c19f9741a17ea074f906c61269a924`. Candidate product
  `2ef0798bea0c33ae267d0fee8649ff673e9665b4` must be verified as its strict
  ancestor before root creation.
- This docs-only binding record does not replace candidate evaluated
  `4845fb37d5c19f9741a17ea074f906c61269a924` in the manifest, v3 proof,
  temporary evaluation branch, or final verification.
- Baseline evaluated/product remain
  `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5` /
  `fb0168afce265cf351f03e80f66d9e0f24015887`.

## 2026-07-30 cross-track responsibility sprawl product checkpoint

- Preserve
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-direct-instance-v1-20260730`
  unchanged. Its live process exited `0`; zero-based indices `9` and `10`
  matched their confirmed bucket/recommendation exactly, while index `4`
  remained `caution/talk` instead of `apply/primary`. All three rows were
  structurally complete with evidence, selected tracks, and no hard blocker,
  contract failure, or empty response. The fixed candidate was restored cleanly
  and the 20-row root remained absent.
- The direct-instance change worked on the first wrong row: its non-central
  foundation/indispensable R3 moved from `transferable` to `matched`. The
  remaining downgrade was the job-quality `responsibility_sprawl` signal even
  though `understandJob` had separated multiple explicit independent hiring
  tracks. This isolates the next root cause to combining duties across tracks
  when evaluating sprawl, rather than match evidence or local recommendation
  policy.
- Design commit `66357ac1621971607ffc233291c227cfc2062c81` requires
  `responsibility_sprawl` to be evaluated inside each independent hiring track
  while preserving the existing signal for a single track that itself mixes
  unrelated duties.
- Product commit `6cc09c9ef2603ac24e1a7c3928ce05f996c74214` adds only that
  prompt boundary and increments `understandJob` from v15 to v16 and `matchJob`
  from v30 to v31. The two focused regressions failed first for the absent
  boundary and stale versions, then passed after the minimal implementation.
- Fresh verification passed `model_adapter_smoke`, `semantic_pipeline_smoke`,
  all six generic evidence fixtures, all 31 benchmark fixtures, all 47 offline
  checks, and `git diff --check`. Independent reviewer capacity remains
  exhausted; no independent approval is claimed.
- Baseline product/evaluated and the three shared harness blobs remain
  unchanged. The only permitted next three-row root is the initially absent
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-cross-track-sprawl-v1-20260730`,
  using a fresh manifest, v3 proof, cache, output, and exact zero-based
  `4,9,10`. The 20-row root must remain absent until this three-row gate is
  exact and safe.
- The docs-only commit containing this checkpoint is the next candidate
  evaluated commit. Its exact SHA must be recorded by an immediate descendant
  docs-only binding record before private root creation. Candidate product
  `6cc09c9ef2603ac24e1a7c3928ce05f996c74214` must be its strict ancestor.

### Cross-track sprawl exact evaluated binding

- Candidate evaluated is exactly
  `615fe7fd5d0c1150017d0a1dcfd686eb67c894fb`. Candidate product
  `6cc09c9ef2603ac24e1a7c3928ce05f996c74214` is its strict ancestor.
- This immediate docs-only binding record does not replace candidate evaluated
  `615fe7fd5d0c1150017d0a1dcfd686eb67c894fb` in the manifest, v3 proof,
  temporary evaluation branch, or live verification.
- Baseline evaluated/product remain exactly
  `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5` /
  `fb0168afce265cf351f03e80f66d9e0f24015887`.

## 2026-07-30 central transferable gap contract checkpoint

- Preserve
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-local-decision-consistency-v1-20260730`
  unchanged. Manifest, v3 proof, bundle verification, and live execution exited
  `0`. The safe result improved to two of three exact: indices `9` and `10`
  were exact; index `4` remained `caution/talk` instead of `apply/primary`.
  All rows were complete and evidence-bearing with no failed, stale, pending,
  partial, empty-response, contract-repair, false-hard-exclusion,
  hard-false-placement, unresolved-disposition, or primary-without-evidence
  result. The fixed candidate was restored cleanly and the 20-row root remained
  absent.
- The local confidence correction fixed index `10`. The only remaining row had
  normal quality, complete foundation evidence, zero role gaps, no hard
  blocker, and one non-foundation central requirement marked `transferable`.
  That output contradicts the existing prompt rule that central transferable
  evidence must identify a concrete named difference in `roleGaps`.
- Design and plan commit
  `1994939abde6291d521d143aac50197bc0a00782` chose fail-closed contract repair
  instead of silently promoting contradictory evidence. Sparse validation now
  rejects central transferable evidence when `roleGaps` is empty using a
  generic error with no private text.
- Product commit `707701e57de9cda25833600e515bf5e9fe1c33cc` adds that
  invariant and increments only `matchJob` from v33 to v34. Transferable
  central evidence with a concrete gap, transferable non-central evidence, and
  matched central evidence remain valid. Prompts, local decision policy, hard
  blockers, eligibility, and model settings are unchanged.
- TDD first proved the contradictory sparse output was accepted. Fresh
  verification passed semantic and model-adapter tests, all six generic
  evidence fixtures, all 31 benchmark fixtures, all 47 offline checks, and
  `git diff --check`. Independent reviewer capacity remains exhausted; no
  independent approval is claimed.
- Baseline product/evaluated and all three shared harness blobs remain
  unchanged. The only permitted next root is the initially absent
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-transfer-gap-contract-v1-20260730`.
  Rebuild all seven files, manifest, v3 proof, bundle verification, and cache,
  then run exact zero-based `4,9,10`. Keep the 20-row root absent unless all
  three are exact and safe.
- The docs-only commit containing this checkpoint is the next candidate
  evaluated commit. Its exact SHA must be recorded by an immediate descendant
  docs-only binding record before private root creation. Candidate product
  `707701e57de9cda25833600e515bf5e9fe1c33cc` must be its strict ancestor.

### Central transfer gap exact evaluated binding

- Candidate evaluated is exactly
  `02ef98a5f57da16626d9daa2d557b09720535bae`. Candidate product
  `707701e57de9cda25833600e515bf5e9fe1c33cc` is its strict ancestor.
- This immediate docs-only binding record does not replace candidate evaluated
  `02ef98a5f57da16626d9daa2d557b09720535bae` in the manifest, v3 proof,
  temporary evaluation branch, or live verification.
- Baseline evaluated/product remain exactly
  `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5` /
  `fb0168afce265cf351f03e80f66d9e0f24015887`.

## 2026-07-30 local recall tier consistency product checkpoint

- Preserve
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-cross-field-consistency-v1-20260730`
  unchanged. Manifest, v3 proof, bundle verification, and live execution exited
  `0`. The safe result was one of three exact: index `9` was exact; index `4`
  remained `caution/talk` instead of `apply/primary`; index `10` remained
  `review/talk` instead of `caution/talk`. All rows were complete and
  evidence-bearing with no failed, stale, pending, partial, empty-response,
  false-hard-exclusion, hard-false-placement, unresolved-disposition, or
  primary-without-evidence result. The fixed candidate was restored cleanly and
  the 20-row root remained absent.
- Safe cache evidence isolated deterministic local demotion. Index `4` had
  normal job quality, no hard blocker, all selected-track foundation and
  central requirements `matched`, cached recommendation `apply`, and confidence
  `0.9`; the blanket `mostly_aligned` talk ceiling changed the final result.
  Index `10` had satisfied eligibility and cached recommendation `caution`, but
  omitted non-core requirements reduced confidence to `0.45`, activating the
  low-confidence review guard.
- Design and plan commit
  `c62018d5f8d21de3705a6f4cf401be40a2e80cb2` selected two narrow local fixes.
  Sparse confidence now uses unknown decision-bearing requirements. A
  `mostly_aligned` role may retain a primary ceiling only when foundation
  evidence is complete and direct, no central evidence is transferable, and no
  central or foundation item is missing.
- Product commit `9b93034a0a7ccef1a478383cd67d11da51168657` implements those
  rules and increments only `matchJob` from v32 to v33. It does not change
  prompts, validators, eligibility or hard-blocker checks, model settings,
  fixtures, or confirmed labels.
- TDD first proved non-core omissions produced false confidence `0.45`. Fresh
  verification passed the semantic test, all six generic evidence fixtures,
  all 31 benchmark fixtures, all 47 offline checks, and `git diff --check`.
  Explicit tests keep transferable foundation, transferable central, and
  missing central evidence below primary. Independent reviewer capacity remains
  exhausted; no independent approval is claimed.
- Baseline product/evaluated and all three shared harness blobs remain
  unchanged. The only permitted next root is the initially absent
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-local-decision-consistency-v1-20260730`.
  Rebuild all seven files, manifest, v3 proof, bundle verification, and cache,
  then run exact zero-based `4,9,10`. Keep the 20-row root absent unless all
  three are exact and safe.
- The docs-only commit containing this checkpoint is the next candidate
  evaluated commit. Its exact SHA must be recorded by an immediate descendant
  docs-only binding record before private root creation. Candidate product
  `9b93034a0a7ccef1a478383cd67d11da51168657` must be its strict ancestor.

### Local recall tier exact evaluated binding

- Candidate evaluated is exactly
  `d47e2cf9602ca9834d13a579afbc22e4d656ca77`. Candidate product
  `9b93034a0a7ccef1a478383cd67d11da51168657` is its strict ancestor.
- This immediate docs-only binding record does not replace candidate evaluated
  `d47e2cf9602ca9834d13a579afbc22e4d656ca77` in the manifest, v3 proof,
  temporary evaluation branch, or live verification.
- Baseline evaluated/product remain exactly
  `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5` /
  `fb0168afce265cf351f03e80f66d9e0f24015887`.

## 2026-07-30 cross-field evidence consistency product checkpoint

- Preserve
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-cross-track-sprawl-v1-20260730`
  unchanged. Manifest, v3 proof, bundle verification, and live execution all
  exited `0`. All three rows were complete and evidence-bearing with no failed,
  stale, pending, partial, empty-response, contract-repair, false-hard-exclusion,
  hard-false-placement, unresolved-disposition, or primary-without-evidence
  result. The fixed candidate was restored cleanly and the 20-row root remained
  absent.
- The safe exact result was one of three: index `9` was exact; index `4` was
  `caution/talk` instead of `apply/primary`; index `10` was `review/talk`
  instead of `caution/talk`.
- The cross-track sprawl change worked: index `4` moved to normal job quality
  with zero concerns and zero role gaps. Its remaining drift was one central,
  indispensable, non-foundation requirement marked `transferable` without a
  corresponding role gap. Index `10` drifted by splitting eligibility into an
  additional item and marking it `conflict`. Comparison with the prior
  immutable cache showed that requirement and eligibility decomposition varied
  across otherwise frozen inputs.
- Design and plan commit
  `2c31fc1d3dd037f46f923a2a8a6759d3269b8ac3` selected prompt-level cross-field
  consistency instead of local promotion, ignored conflicts, or sampling
  changes. Central `transferable` evidence must identify a concrete named
  difference in `roleGaps`; eligibility normalization must preserve logical
  alternatives and only emit independently mandatory gates.
- Product commit `03609837937a53a3e6e31f74bac56ad19d6d1ecb` adds those
  generic constraints and increments `understandJob` from v16 to v17 and
  `matchJob` from v31 to v32. It does not change validators, local decision
  policy, hard-blocker checks, temperature, thinking, retries, or call count.
- The adapter and semantic tests failed first on the missing rules and stale
  versions. Fresh verification then passed both focused tests, all six generic
  evidence fixtures, all 31 benchmark fixtures, all 47 offline checks, and
  `git diff --check`. Independent reviewer capacity remains exhausted; no
  independent approval is claimed.
- Baseline product/evaluated and all three shared harness blobs remain
  unchanged. The only permitted next three-row root is the initially absent
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-cross-field-consistency-v1-20260730`.
  Rebuild all seven files, manifest, v3 proof, bundle verification, and cache,
  then run exact zero-based `4,9,10`. Keep the 20-row root absent unless all
  three are exact and safe.
- The docs-only commit containing this checkpoint is the next candidate
  evaluated commit. Its exact SHA must be recorded by an immediate descendant
  docs-only binding record before private root creation. Candidate product
  `03609837937a53a3e6e31f74bac56ad19d6d1ecb` must be its strict ancestor.

### Cross-field consistency exact evaluated binding

- Candidate evaluated is exactly
  `f2412c82db52b540702b335099e575dc748f58bb`. Candidate product
  `03609837937a53a3e6e31f74bac56ad19d6d1ecb` is its strict ancestor.
- This immediate docs-only binding record does not replace candidate evaluated
  `f2412c82db52b540702b335099e575dc748f58bb` in the manifest, v3 proof,
  temporary evaluation branch, or live verification.
- Baseline evaluated/product remain exactly
  `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5` /
  `fb0168afce265cf351f03e80f66d9e0f24015887`.

### Decision-matrix continuation audited checkpoint (2026-08-01)

- This section supersedes earlier evaluated bindings for the next private run.
  Preserve every old root unchanged; in particular,
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-fullchain-v1-20260731`
  is diagnostic-only because its result is not bound to its current manifest and
  its product/shared-file provenance is stale.
- Candidate product is exactly
  `175e9567fbfaedbfa4d3d92b55fcb5a4289c5a55`. It restores the fixed candidate
  path and implements the audited decision semantics, risk/evidence guards,
  runtime bucket ceiling, workflow review tiers, optional-item filtering, and
  restored test integrity. The missing threshold remains `3`; it must not be
  changed to `5` without fresh 20-row evidence.
- Independent read-only review completed with `Spec PASS` and
  `Code quality APPROVED`. Fresh candidate verification passed all 47 offline
  checks and all 31 benchmark fixtures.
- Baseline harness commit is exactly
  `2878acc694ce9b31ef90602f145dc5958bace4cf`. Fresh baseline verification passed
  all 41 available offline checks and all 31 benchmark fixtures.
- Candidate and baseline Git blobs are identical for
  `scripts/private-full-chain-runner.js`, `scripts/lib/benchmark_metrics.js`,
  and `scripts/lib/private_resume_privacy.js`.
- Frozen jobs and labels were re-hashed and match exactly
  `612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b` and
  `97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39`.
- The only permitted next roots are the initially absent
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v2-first-3-20260801`
  and
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v2-full-20-20260801`.
  Run exact zero-based `4,9,10` first; create the 20-row root with a fresh cache
  only after the three-row run is exact and safe.
- The docs-only commit containing this section is the next candidate evaluated
  commit. Record its exact SHA in an immediate descendant docs-only binding
  before creating either private root. Candidate product `175e956...` must be a
  strict ancestor of that evaluated commit.

### Decision-matrix continuation exact evaluated binding

- Candidate evaluated is exactly
  `e017a524b777675aa294be4935e35357ee094cea`. Candidate product
  `175e9567fbfaedbfa4d3d92b55fcb5a4289c5a55` is its strict ancestor.
- This immediate docs-only binding record does not replace candidate evaluated
  `e017a524b777675aa294be4935e35357ee094cea` in the manifest, v3 proof,
  temporary evaluation branch, or live verification.
- Baseline evaluated is exactly
  `2878acc694ce9b31ef90602f145dc5958bace4cf`; baseline product remains the
  user-approved `fb0168afce265cf351f03e80f66d9e0f24015887`.

### Recall-first confirmed-hard-boundary checkpoint (2026-08-01)

- This section supersedes every earlier candidate evaluated binding for the next
  private run. Every old root remains immutable. In particular,
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v2-first-3-20260801`
  is diagnostic-only after its 0/3 exact result and must not be overwritten,
  deleted, or used as a cache source.
- Candidate product is exactly
  `cf1793a79877c8150385317853ff19e6994a2f00`. It implements recall-first
  `misaligned + partial-positive -> review`, a non-central threshold of five,
  aggregate rather than per-row positive evidence, bounded model trust for
  ambiguous requirement semantics, and the three-part core-skip gate:
  model `indispensable=true`, explicit JD hard boundary, and explicit candidate
  incompatibility.
- Deterministic decision code does not use Java, PMP, AI, or another occupation
  vocabulary as a hard-boundary list. Current live scope remains the frozen AI
  application pool; broader occupation suites are follow-up work after this
  3/20 acceptance, not a prerequisite for it.
- The seventh independent read-only review returned **Critical 0**,
  **Important 0**, **Spec PASS**, and **Code quality APPROVED** under the
  user-confirmed acceptance standard.
- Fresh candidate verification passed `semantic_pipeline_smoke`,
  `model_adapter_smoke`, all 47 offline checks, and all 31 benchmark fixtures.
- Baseline evaluated remains exactly
  `2878acc694ce9b31ef90602f145dc5958bace4cf`; baseline product remains the
  user-approved `fb0168afce265cf351f03e80f66d9e0f24015887`.

### Recall-first v3 structural-diagnostic checkpoint (2026-08-01)

- The first v3 live diagnostic root is now immutable:
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v3-first-3-20260801`.
  Its three recommendation labels were exact (`apply`, `review`, `caution`),
  and the two completed rows also matched their expected buckets. It did not
  pass acceptance because the middle row ended with semantic status `failed`,
  bucket `analysis_pending`, and error `MODEL_CONTRACT_INVALID` during the
  `understandJob` contract-repair phase. A fallback `review` that happens to
  match the label is not a valid structural pass.
- The failed row made two non-empty model attempts and one contract-repair
  request. HTTP, empty-response, response-envelope, and UTF-8 diagnostics did
  not identify a transport failure. The private cache contains only the two
  completed rows, so it is not a valid source for reconstructing the rejected
  model output and must not be reused.
- Root cause in the harness was independently reproduced: the telemetry
  collector counted `understandJob` repair requests but returned before
  classifying their initial error, and it rejected `understandJob` repair-failed
  events entirely. This left all four bounded failure category/reason fields at
  `none`, preventing privacy-safe diagnosis.
- Candidate harness checkpoint is exactly
  `d55f395bcddd1693658cea4c66ac9cbef98cefdc`. The TDD regression emits an
  `understandJob` requested-plus-failed pair and proves that only approved fixed
  enums reach the private result. Candidate verification passed all 47 offline
  checks and `git diff --check`.
- Baseline harness checkpoint is exactly
  `56369670008b187d6259bf37c9dba9117223543f`. Its 41 available offline checks
  passed. Candidate and baseline runner blobs are identical at
  `e05094234f3c599c3e34088b2bd2c2088dc7f31e`; benchmark metrics and privacy
  blobs remain
  `4eea3267ec86aaa236af323562c52eea601320b8` and
  `8a4b21d7493fb5e7d8ce49662ba3951687903c46`.
- Independent read-only review of the telemetry fix returned **Critical 0**,
  **Important 0**, **Minor 0**, **Spec PASS**, and
  **Code quality APPROVED**. Raw error messages remain classifier input only
  and cannot enter the bounded result schema.
- Candidate product remains exactly
  `cf1793a79877c8150385317853ff19e6994a2f00`; baseline product remains exactly
  `fb0168afce265cf351f03e80f66d9e0f24015887`. The telemetry-only commits do
  not change recommendation semantics.
- The only permitted next roots, after confirming they are absent, are
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v3r2-first-3-20260801`
  and
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v3r2-full-20-20260801`.
  Rebuild the bundle, manifest, v3 proof, and cache from scratch. Run exact
  zero-based indices `4,9,10`; do not create the 20-row root until all three
  rows are exact, structurally complete, and safe.

The docs-only commit containing this section is the next candidate evaluated
checkpoint. Candidate product `cf1793a...` must be its strict ancestor. Record
the complete evaluated SHA in an immediate descendant docs-only binding before
creating the v3r2 private root.
- Candidate and baseline Git blobs were rechecked and are identical:
  runner `0675a1cf21788dbc61532b3265d592aa7fa9afb4`,
  benchmark metrics `4eea3267ec86aaa236af323562c52eea601320b8`,
  and private resume privacy
  `8a4b21d7493fb5e7d8ce49662ba3951687903c46`.
- Frozen input files remain inside
  `D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730`.
  Their raw jobs and labels SHA-256 values were rechecked as
  `612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b`
  and
  `97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39`.
- The only permitted new roots, both confirmed absent before this checkpoint,
  are
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v3-first-3-20260801`
  and
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v3-full-20-20260801`.
- Run exact zero-based indices `4,9,10` first. A structural, safety, empty
  response, or exact mismatch stops the run at its first failing row. Only an
  exact and safe three-row result may unlock a fresh-cache 20-row run.
- The 20-row acceptance floor remains exact at least 18/20 with all safety and
  recall gates satisfied. Every deviation must be inspected; the user has
  authorized autonomous root-cause work rather than silently changing labels.
- Private artifacts must be created or validated through the clean-commit v3
  runner flow. Do not use `patch-artifacts.js` or manual edits to fabricate Git,
  manifest, proof, profile, or card bindings.

The docs-only commit containing this section is the next candidate evaluated
checkpoint. Candidate product `cf1793a...` must be its strict ancestor. Record
the complete evaluated SHA in an immediate descendant docs-only binding before
creating either private root. That binding commit must not replace evaluated in
the manifest, v3 proof, temporary evaluation branch, or live verification.

### Recall-first confirmed-hard-boundary exact evaluated binding

- Candidate evaluated is exactly
  `d33e9f1aad1c0364c335e8cae8b9d9f713a083c0`. Candidate product
  `cf1793a79877c8150385317853ff19e6994a2f00` is its strict ancestor.
- This immediate docs-only binding record does not replace candidate evaluated
  `d33e9f1aad1c0364c335e8cae8b9d9f713a083c0` in the manifest, v3 proof,
  temporary evaluation branch, or live verification.
- Baseline evaluated remains exactly
  `2878acc694ce9b31ef90602f145dc5958bace4cf`; baseline product remains the
  user-approved `fb0168afce265cf351f03e80f66d9e0f24015887`.
