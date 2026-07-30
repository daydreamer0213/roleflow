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
