# Live Model Benchmark v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用完整脱敏画像、固定人工复核匹配卡和完全相同的 v3 harness，公平比较通用证据匹配候选实现与旧基线，并同时拦截错误放过和错误硬排除。

**Architecture:** 候选分支先完成提示词、契约修复指令和管线版本修正，再冻结三份脱敏输入。`tests/job_match_benchmark.js` 继续作为单文件、跨新旧代码兼容的安全执行器与离线比较器，只使用 Node 标准库；同一 harness 与 fixture 机械复制到独立 v3 基线 worktree。真实模型双跑位于两个明确人工停点之后，不属于普通离线实施步骤。

**Tech Stack:** Node.js >= 22.5、CommonJS、`assert`、`node:crypto`、项目现有 smoke test、Git worktree、PowerShell。

## Global Constraints

- 候选实施从 `D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix` 的 `cf4c964f70e2fd533dffb30342bf868dbe17cae6` 开始；不得改写此前提交历史。
- 候选分支保持 `codex/claude-generic-evidence-matching-live-fix`；v3 基线分支固定为 `codex/generic-evidence-matching-benchmark-v3-baseline`。
- v3 基线固定从 `e9689627540d1cbc419a7a06853ffea986115ff0` 创建，不得带入候选算法、提示词、契约或评分改动。
- harness 版本精确为 `sanitized-live-harness.v3`。
- 不增加 npm 依赖；哈希只用 `node:crypto`，文件和路径只用 Node 标准库。
- `tests/fixtures/job_match_benchmark.json` 的 JD、expectedRecommendation、expectedBucket 和 rationale 本轮全部冻结，不得修改。
- 不访问真实 BOSS 或其他招聘平台，不点击沟通，不恢复批次，不读写 `D:\Guo\ZhiPing\data\jobs.sqlite`，不启动或操作 8787。
- 不读取真实简历、真实画像、Cookie；fixture 必须完全虚构且只位于 `tests/fixtures/`。
- Tasks 1–5 与 Task 6 的 fixture 展示都不得读取正式模型设置、DPAPI 文件或调用真实模型网络。
- Task 7 前必须由用户在看到最终 fixture 摘要后重新明确授权；旧的 live-v2 授权不沿用。
- 获准运行时，只能通过 `--model-settings-root D:\Guo\ZhiPing` 让现有 `resolveRuntimeModelConfig` 原地只读设置和 DPAPI 密钥；不得复制设置文件、加密密钥或明文密钥到 benchmark worktree。
- live 输出只能写入 Task 7 用 `Get-Date -Format 'yyyyMMdd-HHmmss'` 生成的 `D:\DevData\RoleFlow-benchmark\live-v3-$runId\`；不得写入仓库、用户目录、系统临时目录、`.runtime` 或 `data`。
- 任何 harness、画像、简历版本、匹配卡或 JD fixture 变化都使已有 v3 结果失效，必须重新双跑。
- 不 push、不合并、不修改 `D:\Guo\ZhiPing`；完成后先报告结果，由用户决定远端备份与集成。

---

## File Map

| 文件 | 职责 |
|---|---|
| `src/adapters/models/openai_compatible.js` | `understandJob` 契约修复指令与“硬性措辞”边界 |
| `src/core/analysis_revision.js` | 新提示词/语义对应的缓存与 stale 版本 |
| `tests/model_adapter_smoke.js` | 提示词文本边界的离线回归 |
| `tests/semantic_pipeline_smoke.js` | 单次契约修复、缓存版本和 stale 行为 |
| `tests/fixtures/live_benchmark_profile.json` | 完整、虚构、结构化的候选人画像 |
| `tests/fixtures/live_benchmark_resume_versions.json` | 与画像一致的两份脱敏简历版本摘要 |
| `tests/fixtures/live_benchmark_matching_card.json` | 固定、人工复核、带能力限制的匹配偏好卡 |
| `tests/matching_card_smoke.js` | fixture 与现有匹配卡契约的一致性 |
| `tests/job_match_benchmark.js` | v3 安全执行器、输入身份、结果指标与离线比较器 |
| `tests/generic_evidence_matching_smoke.js` | 比较器身份门禁和验收门禁回归 |
| `docs/superpowers/specs/2026-07-25-live-model-benchmark-v3-design.md` | 已批准设计及本计划自审中发现的指标语义澄清 |

---

### Task 1: 修正真实模型提示词并使旧缓存失效

**Files:**
- Modify: `src/adapters/models/openai_compatible.js:41-53`
- Modify: `src/core/analysis_revision.js:4-8`
- Modify: `tests/model_adapter_smoke.js:78-91`
- Modify: `tests/semantic_pipeline_smoke.js:535-544`
- Modify: `tests/semantic_pipeline_smoke.js:1052-1063`
- Modify: `tests/semantic_pipeline_smoke.js:1166-1189`

**Interfaces:**
- Consumes: `cachedModelCall({ db, configs, kind, pipelineVersion, input, run })` 的既有单次修复流程。
- Produces: `PIPELINE_VERSIONS.understandJob === "job-understanding-v6"`、`PIPELINE_VERSIONS.matchJob === "match-decision-v13"`；`understandJob` 明确处理 `contractRepair`，普通“需要理解业务”不再自动成为不可替代核心要求。

- [ ] **Step 1: 写提示词和版本红灯断言**

在 `tests/model_adapter_smoke.js` 取得 `understandPrompt` 后加入：

```js
assert(
  understandPrompt.includes("若输入含 contractRepair")
    && understandPrompt.includes("contractRepair.invalidOutput")
    && understandPrompt.includes("contractRepair.reason")
    && understandPrompt.includes("返回修正后的完整 JSON"),
  "understandJob prompt 必须给出可执行的单次契约修复指令"
);
assert(
  understandPrompt.includes("措辞只是重要性信号")
    && understandPrompt.includes("岗位持续承担的核心工作")
    && understandPrompt.includes("不可替代"),
  "understandJob prompt 不得仅凭“要求/需要”措辞判 indispensable"
);
assert(
  understandPrompt.includes("需要理解业务")
    && understandPrompt.includes("不得仅凭该短语"),
  "普通业务理解要求不得自动升级为硬阻断"
);
assert(
  understandPrompt.includes("要求熟悉某平台")
    && understandPrompt.includes("优先")
    && understandPrompt.includes("不得自动"),
  "平台愿望项不得自动升级为硬阻断"
);
```

把现有“要求/需要 + 熟悉/理解必须是硬性措辞”的断言替换成上述边界断言。

在 `tests/semantic_pipeline_smoke.js` 的 `pipelineVersionCacheSmoke()` 开头加入：

```js
assert.strictEqual(PIPELINE_VERSIONS.understandJob, "job-understanding-v6");
assert.strictEqual(PIPELINE_VERSIONS.matchJob, "match-decision-v13");
```

把 `staleAnalysisSmoke()` 的旧版本样本改成紧邻旧版本：

```js
pipelineVersions: {
  understandJob: "job-understanding-v5",
  matchJob: "match-decision-v12"
}
```

并把断言信息同步为：

```js
assert(
  contractUpgradeReasons.includes("job_understanding_pipeline_changed"),
  "理解提示词升级后必须使 v5 持久化分析 stale"
);
assert(
  contractUpgradeReasons.includes("match_pipeline_changed"),
  "匹配语义升级后必须使 v12 持久化分析 stale"
);
```

- [ ] **Step 2: 写“修复后仍非法只尝试一次”的红灯回归**

在 `understandingContractRepairSmoke()` 成功用例之后加入：

```js
const stillInvalid = {
  ...understanding("understanding-repair-fails"),
  eligibilityConstraints: [{ type: "学历", value: "本科" }]
};
let failedRepairCalls = 0;
const failingRunner = createJobAnalysisRunner(configFor(["Python", "RAG"]), [], {
  db,
  analyzer: {
    understandJob: async (input) => {
      failedRepairCalls += 1;
      assert(failedRepairCalls <= 2, "understandJob 契约修复最多调用两次");
      if (failedRepairCalls === 2) assert(input.contractRepair, "第二次调用必须携带 contractRepair");
      return stillInvalid;
    },
    matchJob: async () => {
      throw new Error("understandJob 未通过时不得调用 matchJob");
    }
  }
});
const failedRepair = await failingRunner(completeJob("understanding-repair-fails"));
assert.strictEqual(failedRepairCalls, 2, "首次非法输出后只允许一次修复");
assert.strictEqual(failedRepair.semanticStatus, "failed");
assert.strictEqual(failedRepair.recommendation, "review");
```

- [ ] **Step 3: 运行红灯**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected:

- `model_adapter_smoke.js` 失败，指出缺少 `contractRepair` 或新的措辞边界；
- `semantic_pipeline_smoke.js` 失败，指出版本仍为 v5/v12；
- 失败不得来自网络、真实配置或 fixture 文件。

- [ ] **Step 4: 最小修改 `understandJob` 提示词**

在 `src/adapters/models/openai_compatible.js` 的 `understandJob` prompt 中，用下面两行替换原先把“要求熟悉/需要理解”一律视为硬性措辞的行，并在输出字段说明后加入修复指令：

```js
"coreRequirements 只收 JD 明确写出的任职要求。必须、熟练、精通、掌握、至少、扎实、具备、要求熟悉、需要理解等措辞只是重要性信号，不能单独决定 indispensable；只有该要求直接服务于岗位持续承担的核心工作，且 JD 把它表达为不可替代条件时，indispensable=true。“优先、加分、了解即可”只能进入 preferredRequirements。经验年限（如“1-3 年”“3-5 年”）只是偏好，不得 indispensable=true，年限信息写入 senioritySignal。语言、工具、平台、证书等只在 JD 明确为核心或加分时出现，不得自行补充。",
"普通“需要理解业务”不得仅凭该短语标为 indispensable；“要求熟悉某平台，相关经验优先”也不得自动升级为硬阻断。若 JD 的核心工作本身是独立开发 Java/Spring 服务，并明确“必须熟练 Java”，则 Java 可标为不可替代核心要求。判断必须同时引用核心工作与要求原文。",
"若输入含 contractRepair，读取 contractRepair.invalidOutput，在原 JSON 上只修正 contractRepair.reason 指出的字段，并返回修正后的完整 JSON；不得改变已有正确事实，不得为通过校验而编造 JD 内容。"
```

不要修改 `matchJob` 现有的年限、信息不足、双侧证据和 blocker 约束。

- [ ] **Step 5: 提升管线版本**

在 `src/core/analysis_revision.js` 精确改为：

```js
const PIPELINE_VERSIONS = Object.freeze({
  understandJob: "job-understanding-v6",
  matchJob: "match-decision-v13",
  communication: "communication-v2"
});
```

- [ ] **Step 6: 运行绿色测试和相邻回归**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/screening_quality_smoke.js
```

Expected:

```text
model_adapter_smoke ok
semantic_pipeline_smoke ok
screening_quality_smoke ok
```

- [ ] **Step 7: 提交 Task 1**

```powershell
git add -- src/adapters/models/openai_compatible.js src/core/analysis_revision.js tests/model_adapter_smoke.js tests/semantic_pipeline_smoke.js
git diff --cached --check
git commit -m "fix: prepare matching prompts for live benchmark v3"
```

---

### Task 2: 冻结完整脱敏画像与静态匹配卡

**Files:**
- Modify: `tests/fixtures/live_benchmark_profile.json`
- Modify: `tests/fixtures/live_benchmark_resume_versions.json`
- Create: `tests/fixtures/live_benchmark_matching_card.json`
- Modify: `tests/matching_card_smoke.js:150-165`

**Interfaces:**
- Consumes: `normalizeMatchingCard(input, { source, editedByUser })`。
- Produces: profile ID `live_benchmark_sanitized_profile`、card ID `live_benchmark_sanitized_matching_card`、两个稳定 resume version ID；三份输入内容在 live 前冻结。

- [ ] **Step 1: 写 fixture 红灯检查**

在 `tests/matching_card_smoke.js` 的主流程中、文档检查之前加入：

```js
assertLiveBenchmarkFixtures();
```

在文件末尾加入：

```js
function assertLiveBenchmarkFixtures() {
  const root = path.resolve(__dirname, "..");
  const profile = JSON.parse(fs.readFileSync(path.join(root, "tests", "fixtures", "live_benchmark_profile.json"), "utf8"));
  const resumeVersions = JSON.parse(fs.readFileSync(path.join(root, "tests", "fixtures", "live_benchmark_resume_versions.json"), "utf8"));
  const envelope = JSON.parse(fs.readFileSync(path.join(root, "tests", "fixtures", "live_benchmark_matching_card.json"), "utf8"));

  assert.strictEqual(profile.id, "live_benchmark_sanitized_profile");
  assert(Array.isArray(profile.education) && profile.education.length > 0, "live profile 必须包含结构化教育经历");
  assert(Array.isArray(profile.experiences) && profile.experiences.length > 0, "live profile 必须包含结构化经历");
  assert(profile.skills.every((item) => item && typeof item === "object" && item.name && Array.isArray(item.evidence)));
  assert(profile.projects.every((item) => item.roleBoundary && Array.isArray(item.canSay) && Array.isArray(item.avoidSaying)));

  const versionIds = resumeVersions.versions.map((item) => item.id);
  assert.deepStrictEqual(versionIds, ["ai_rag_agent", "python_backend_ai"]);
  assert.strictEqual(envelope.id, "live_benchmark_sanitized_matching_card");
  assert.strictEqual(envelope.profileId, profile.id);
  assert.deepStrictEqual(envelope.resumeVersionIds, versionIds);
  assert.strictEqual(envelope.card.source, "user");

  const normalized = normalizeMatchingCard(envelope.card, { source: "user", editedByUser: true });
  assert.deepStrictEqual(normalized, envelope.card, "静态匹配卡必须已经符合现有规范化契约");
  assert(normalized.transferableCapabilities.every((item) => item.limitation), "每条可迁移能力必须写明限制");
  const serialized = JSON.stringify({ profile, resumeVersions, envelope });
  for (const forbidden of ["13800138000", "candidate@example.com", "D:\\\\Guo\\\\ZhiPing", "guo_mingfu"]) {
    assert(!serialized.includes(forbidden), `脱敏 fixture 不得包含 ${forbidden}`);
  }
}
```

- [ ] **Step 2: 运行红灯**

Run:

```powershell
node tests/matching_card_smoke.js
```

Expected: FAIL，首先因为 `live_benchmark_matching_card.json` 不存在；创建空文件或临时占位文件都不允许。

- [ ] **Step 3: 用完整结构替换脱敏画像**

将 `tests/fixtures/live_benchmark_profile.json` 完整替换为：

```json
{
  "id": "live_benchmark_sanitized_profile",
  "candidate": {
    "name": "脱敏基准候选人",
    "city": "广州",
    "targetTitle": "AI应用开发工程师",
    "targetTitles": ["AI应用开发", "Python后端"],
    "expectedSalary": "9-14K",
    "adjustableSalary": ["8-12K", "9-13K"],
    "directions": ["AI应用开发", "Python后端", "RAG", "Agent"]
  },
  "education": [
    {
      "school": "脱敏示例大学",
      "degree": "本科",
      "major": "计算机相关专业",
      "startDate": "2019-09",
      "endDate": "2023-06",
      "status": "已毕业",
      "highlights": []
    }
  ],
  "experiences": [
    {
      "organization": "脱敏项目协作团队",
      "role": "AI应用开发协作成员",
      "type": "项目协作",
      "startDate": "2024-01",
      "endDate": "2025-06",
      "roleBoundary": "参与 AI 应用的检索链路、接口联调和工作流实现，不主张负责整体架构、独立售前或客户项目管理。",
      "highlights": [
        "参与知识库问答检索链路优化与接口联调",
        "使用结构化工作流实现 Agent 工具调用与质量复核"
      ],
      "technologies": ["Python", "FastAPI", "RAG", "LangGraph", "LangChain", "Milvus", "Redis", "MySQL", "Docker", "pytest"]
    }
  ],
  "skills": [
    {"name": "Python", "level": "项目实践", "evidence": ["企业知识库问答项目", "多 Agent 内容生成项目"]},
    {"name": "FastAPI", "level": "项目实践", "evidence": ["企业知识库问答项目"]},
    {"name": "RAG", "level": "项目实践", "evidence": ["企业知识库问答项目"]},
    {"name": "LangGraph", "level": "项目实践", "evidence": ["多 Agent 内容生成项目"]},
    {"name": "LangChain", "level": "项目实践", "evidence": ["多 Agent 内容生成项目"]},
    {"name": "Agent", "level": "项目实践", "evidence": ["多 Agent 内容生成项目"]},
    {"name": "Milvus", "level": "项目实践", "evidence": ["企业知识库问答项目"]},
    {"name": "Redis", "level": "项目实践", "evidence": ["企业知识库问答项目"]},
    {"name": "MySQL", "level": "项目实践", "evidence": ["企业知识库问答项目"]},
    {"name": "Docker", "level": "项目实践", "evidence": ["企业知识库问答项目"]},
    {"name": "pytest", "level": "项目实践", "evidence": ["企业知识库问答项目"]}
  ],
  "projects": [
    {
      "name": "企业知识库问答项目",
      "period": "脱敏项目阶段一",
      "context": "面向企业文档的知识问答应用。",
      "roleBoundary": "参与检索增强问答链路、接口联调和质量检查，不主张负责整体架构。",
      "canSay": [
        "参与向量检索与关键词检索链路优化",
        "使用 FastAPI 完成接口联调",
        "进行日志排查与基础测试"
      ],
      "technologies": ["Python", "FastAPI", "RAG", "Milvus", "Redis", "MySQL", "Docker", "pytest"],
      "results": ["完成可运行的知识库问答链路与接口联调"],
      "avoidSaying": ["负责整体架构", "拥有成熟离线评估体系", "生产级自动降级", "未经记录的量化提升"]
    },
    {
      "name": "多 Agent 内容生成项目",
      "period": "脱敏项目阶段二",
      "context": "使用结构化工作流组织内容生成、工具调用和质量复核。",
      "roleBoundary": "实现工作流节点、条件路由和质量复核步骤，不主张生产级高可用或复杂运维经验。",
      "canSay": [
        "使用 LangGraph 组织多步骤工作流",
        "实现 Agent 工具调用和条件路由",
        "加入结构化质量复核步骤"
      ],
      "technologies": ["Python", "LangGraph", "LangChain", "Agent"],
      "results": ["完成可运行的结构化内容生成与质量复核流程"],
      "avoidSaying": ["主导企业级平台", "成熟模型评估体系", "生产级异常降级", "大规模并发经验"]
    }
  ],
  "credentials": [],
  "strengths": [
    "能够把 Python、RAG 与 Agent 组件组合成可运行应用",
    "能说明本人参与边界，不把协作经历表述为主导"
  ],
  "resumeVersions": [],
  "constraints": {
    "preferredCities": ["广州"],
    "levels": ["初级", "中级", "0-3年", "1-3年", "经验不限"],
    "avoidRoles": ["销售", "培训", "讲师", "纯算法", "纯前端", "纯Java"]
  },
  "riskMessaging": {
    "gap": "如被问到职业空档，基于本人实际经历说明方向探索、持续学习与项目实践。"
  }
}
```

- [ ] **Step 4: 对齐简历版本摘要**

将 `tests/fixtures/live_benchmark_resume_versions.json` 完整替换为：

```json
{
  "versions": [
    {
      "id": "ai_rag_agent",
      "name": "AI / RAG / Agent 版本",
      "summary": "突出 RAG、Agent 工具调用、知识库和结构化工作流实践。",
      "primaryProjects": ["企业知识库问答项目", "多 Agent 内容生成项目"],
      "scenarios": ["AI应用开发", "RAG工程师", "Agent工程师", "知识库工程师", "LLM应用开发"],
      "keywords": ["Python", "RAG", "Agent", "知识库", "LangGraph", "LangChain", "Milvus"]
    },
    {
      "id": "python_backend_ai",
      "name": "Python 后端 + AI 工程版本",
      "summary": "突出 Python、FastAPI、接口联调、数据组件和基础测试实践。",
      "primaryProjects": ["企业知识库问答项目"],
      "scenarios": ["Python后端", "AI后端开发", "FastAPI工程师", "后端开发"],
      "keywords": ["Python", "FastAPI", "Redis", "MySQL", "pytest", "Docker"]
    }
  ]
}
```

- [ ] **Step 5: 创建静态匹配偏好卡**

创建 `tests/fixtures/live_benchmark_matching_card.json`：

```json
{
  "id": "live_benchmark_sanitized_matching_card",
  "profileId": "live_benchmark_sanitized_profile",
  "resumeVersionIds": ["ai_rag_agent", "python_backend_ai"],
  "card": {
    "targetDirections": ["AI应用开发", "Python后端", "RAG", "Agent"],
    "strongEvidence": [
      {
        "label": "Python 与 FastAPI 应用开发",
        "evidence": "简历：在企业知识库问答项目中使用 Python、FastAPI 完成可运行接口与联调。"
      },
      {
        "label": "RAG 知识库实践",
        "evidence": "简历：参与向量检索与关键词检索链路优化，并使用 Milvus、Redis 支撑知识问答流程。"
      },
      {
        "label": "Agent 工作流与质量复核",
        "evidence": "简历：使用 LangGraph 组织工作流节点、条件路由、工具调用和结构化质量复核步骤。"
      }
    ],
    "transferableCapabilities": [
      {
        "label": "Python 自动化与数据处理",
        "evidence": "简历：两个脱敏项目均使用 Python 组织处理流程、接口联调和基础测试。",
        "limitation": "未证明大规模采集平台、高并发或分布式系统经验。"
      },
      {
        "label": "AI 应用交付协作",
        "evidence": "简历：参与知识库接口联调、日志排查和可运行流程实现。",
        "limitation": "未证明独立售前、客户项目管理或长期驻场交付经验。"
      }
    ],
    "cautionTransitions": [
      {
        "direction": "AI实施与解决方案支持",
        "reason": "有 AI 应用、接口联调和方案理解基础，但独立客户交付、售前方案和现场项目管理经验需确认。"
      }
    ],
    "userNotes": [],
    "source": "user"
  }
}
```

- [ ] **Step 6: 运行绿色检查**

Run:

```powershell
node tests/matching_card_smoke.js
node tests/profile_quality_smoke.js
```

Expected:

```text
matching_card_smoke ok
profile_quality_smoke ok
```

- [ ] **Step 7: 提交 Task 2**

```powershell
git add -- tests/fixtures/live_benchmark_profile.json tests/fixtures/live_benchmark_resume_versions.json tests/fixtures/live_benchmark_matching_card.json tests/matching_card_smoke.js
git diff --cached --check
git commit -m "test: add complete sanitized benchmark identity"
```

---

### Task 3: 将安全执行器升级到 harness v3

**Files:**
- Modify: `tests/job_match_benchmark.js:1-427`

**Interfaces:**
- Consumes: 三份冻结 fixture；`profileToRuntimeConfigs(configs, profile, plan, resumeVersionsOverride, matchingCard)`，旧基线安全忽略第五参数。
- Produces: `validateLiveFixtureBundle(profile, resumeVersions, envelope)`、`fixtureIdentity(paths, envelope)`、`sanitizedModelIdentity(modelConfig)`；live JSON 包含完整输入身份和两类硬排除错误。

- [ ] **Step 1: 先写 v3 门禁与 fixture 红灯断言**

在 `assertGateContractOffline()` 中加入：

```js
assert.strictEqual(BENCHMARK_HARNESS_VERSION, "sanitized-live-harness.v3");
assert.strictEqual(granted.request.matchingCardPath, resolveAgainstRoot(LIVE_MATCHING_CARD_FIXTURE));
assert.strictEqual(granted.request.modelSettingsRoot, canonicalizeExisting("D:\\Guo\\ZhiPing"));

const profile = JSON.parse(fs.readFileSync(resolveAgainstRoot(LIVE_PROFILE_FIXTURE), "utf8"));
const resumeVersions = JSON.parse(fs.readFileSync(resolveAgainstRoot(LIVE_RESUME_VERSIONS_FIXTURE), "utf8"));
const envelope = JSON.parse(fs.readFileSync(resolveAgainstRoot(LIVE_MATCHING_CARD_FIXTURE), "utf8"));
const bundle = validateLiveFixtureBundle(profile, resumeVersions, envelope);
assert.strictEqual(bundle.ok, true);
assert.strictEqual(bundle.matchingCard, envelope.card);

for (const invalid of [
  { profile, resumeVersions, envelope: { ...envelope, id: "" } },
  { profile, resumeVersions, envelope: { ...envelope, profileId: "wrong-profile" } },
  { profile, resumeVersions, envelope: { ...envelope, resumeVersionIds: ["wrong-version"] } },
  { profile: { ...profile, education: [] }, resumeVersions, envelope },
  { profile: { ...profile, experiences: [] }, resumeVersions, envelope }
]) {
  const result = validateLiveFixtureBundle(invalid.profile, invalid.resumeVersions, invalid.envelope);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, "LIVE_BENCHMARK_FIXTURE_IDENTITY");
}
```

把 `baseOptions` 扩展为：

```js
matchingCardPath: LIVE_MATCHING_CARD_FIXTURE,
modelSettingsRoot: "D:\\Guo\\ZhiPing",
```

在拒绝用例中加入：

```js
{ name: "匹配卡指向真实画像目录", options: { ...baseOptions, matchingCardPath: "profiles/matching_card.json" }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_UNSANITIZED_INPUT" },
{ name: "匹配卡不在白名单", options: { ...baseOptions, matchingCardPath: "tests/fixtures/generic_evidence_matching.json" }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_FIXTURE_MISMATCH" },
{ name: "缺模型设置根目录", options: { ...baseOptions, modelSettingsRoot: "" }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_MODEL_SETTINGS_ROOT_REQUIRED" },
{ name: "模型设置根目录指向当前 worktree", options: { ...baseOptions, modelSettingsRoot: root }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_MODEL_SETTINGS_ROOT_FORBIDDEN" },
```

再加入 provider 惰性断言：

```js
validateLiveBenchmarkRequest({ ...baseOptions, modelSettingsRoot: "" }, authorizedEnv, countingProvider);
assert.strictEqual(providerCalls, 0, "缺模型设置根目录时不得解析 provider");
```

- [ ] **Step 2: 运行红灯**

Run:

```powershell
node tests/job_match_benchmark.js
```

Expected: FAIL，至少指出 harness 仍为 v2、granted request 缺 `matchingCardPath`，或 `validateLiveFixtureBundle` 不存在。

- [ ] **Step 3: 增加 v3 常量和标准库哈希**

在文件顶部加入：

```js
const crypto = require("crypto");
```

把常量区改为：

```js
const BENCHMARK_HARNESS_VERSION = "sanitized-live-harness.v3";
const LIVE_BENCHMARK_ENV = "ALLOW_LIVE_MODEL_BENCHMARK";
const LIVE_BENCHMARK_OUTPUT_ENV = "BENCHMARK_LIVE_OUTPUT_DIR";
const LIVE_BENCHMARK_EVALUATED_COMMIT_ENV = "BENCHMARK_EVALUATED_COMMIT";
const LIVE_BENCHMARK_BASELINE_COMMIT_ENV = "BENCHMARK_BASELINE_BEHAVIOR_COMMIT";
const LIVE_BENCHMARK_MODEL_SETTINGS_ROOT_ENV = "BENCHMARK_MODEL_SETTINGS_ROOT";
const LIVE_BENCHMARK_CHILD_ENV = "ROLEFLOW_BENCHMARK_OFFLINE_CHILD";
const LIVE_PROFILE_FIXTURE = path.join("tests", "fixtures", "live_benchmark_profile.json");
const LIVE_RESUME_VERSIONS_FIXTURE = path.join("tests", "fixtures", "live_benchmark_resume_versions.json");
const LIVE_MATCHING_CARD_FIXTURE = path.join("tests", "fixtures", "live_benchmark_matching_card.json");
const LIVE_JOB_FIXTURE = path.join("tests", "fixtures", "job_match_benchmark.json");
const LIVE_FIXTURE_PROFILE_ID = "live_benchmark_sanitized_profile";
const LIVE_FIXTURE_MATCHING_CARD_ID = "live_benchmark_sanitized_matching_card";
```

- [ ] **Step 4: 扩展路径门禁和模型设置根目录门禁**

让 `checkLiveFixturePaths()` 的 resolved 对象包含：

```js
const resolved = {
  profilePath: resolveAgainstRoot(paths.profilePath),
  resumeVersionsPath: resolveAgainstRoot(paths.resumeVersionsPath),
  matchingCardPath: resolveAgainstRoot(paths.matchingCardPath)
};
```

白名单比较改为：

```js
if (resolved.profilePath !== resolveAgainstRoot(LIVE_PROFILE_FIXTURE)
  || resolved.resumeVersionsPath !== resolveAgainstRoot(LIVE_RESUME_VERSIONS_FIXTURE)
  || resolved.matchingCardPath !== resolveAgainstRoot(LIVE_MATCHING_CARD_FIXTURE)) {
  return failLiveBenchmark(
    "LIVE_BENCHMARK_FIXTURE_MISMATCH",
    "实时基准只能读取 tests/fixtures 下固定的画像、简历版本和匹配卡 fixture。"
  );
}
```

新增：

```js
function checkLiveModelSettingsRoot(rawRoot) {
  const raw = String(rawRoot || "").trim();
  if (!raw) {
    return failLiveBenchmark(
      "LIVE_BENCHMARK_MODEL_SETTINGS_ROOT_REQUIRED",
      `实时基准需要显式 --model-settings-root 或 ${LIVE_BENCHMARK_MODEL_SETTINGS_ROOT_ENV}。`
    );
  }
  if (LIVE_SOURCE_URL.test(raw)) {
    return failLiveBenchmark("LIVE_BENCHMARK_MODEL_SETTINGS_ROOT_FORBIDDEN", "模型设置根目录必须是本机绝对路径。");
  }
  const resolved = canonicalizeExisting(raw);
  const benchmarkRoot = canonicalizeExisting(root);
  const homeRoot = canonicalizeExisting(os.homedir());
  const tempRoot = canonicalizeExisting(os.tmpdir());
  if (!path.isAbsolute(resolved)
    || isWithinDirectory(resolved, benchmarkRoot)
    || isWithinDirectory(resolved, homeRoot)
    || isWithinDirectory(resolved, tempRoot)) {
    return failLiveBenchmark(
      "LIVE_BENCHMARK_MODEL_SETTINGS_ROOT_FORBIDDEN",
      "模型设置根目录必须是当前 benchmark worktree 之外、用户目录和临时目录之外的显式本机路径。"
    );
  }
  return { ok: true, resolved };
}
```

在 `validateLiveBenchmarkRequest()` 中把 fixture path check 改为：

```js
const fixtureCheck = checkLiveFixturePaths({
  profilePath: opts.profilePath || LIVE_PROFILE_FIXTURE,
  resumeVersionsPath: opts.resumeVersionsPath || LIVE_RESUME_VERSIONS_FIXTURE,
  matchingCardPath: opts.matchingCardPath || LIVE_MATCHING_CARD_FIXTURE
});
```

并在 worktree clean 检查之后、provider 调用之前加入：

```js
const modelSettingsRootCheck = checkLiveModelSettingsRoot(
  opts.modelSettingsRoot || environ[LIVE_BENCHMARK_MODEL_SETTINGS_ROOT_ENV]
);
if (!modelSettingsRootCheck.ok) return modelSettingsRootCheck;
```

granted request 增加：

```js
matchingCardPath: fixtureCheck.resolved.matchingCardPath,
modelSettingsRoot: modelSettingsRootCheck.resolved,
```

- [ ] **Step 5: 增加 fixture 内容与身份函数**

在 `runLive()` 前加入完整函数：

```js
function validateLiveFixtureBundle(profile, resumeVersions, envelope) {
  const versionIds = Array.isArray(resumeVersions?.versions)
    ? resumeVersions.versions.map((item) => String(item?.id || "").trim()).filter(Boolean)
    : [];
  const card = envelope?.card;
  const cardLists = ["targetDirections", "strongEvidence", "transferableCapabilities", "cautionTransitions", "userNotes"];
  const valid = profile?.id === LIVE_FIXTURE_PROFILE_ID
    && Array.isArray(profile.education) && profile.education.length > 0
    && Array.isArray(profile.experiences) && profile.experiences.length > 0
    && versionIds.length > 0
    && envelope?.id === LIVE_FIXTURE_MATCHING_CARD_ID
    && envelope?.profileId === profile.id
    && JSON.stringify(envelope?.resumeVersionIds) === JSON.stringify(versionIds)
    && card && typeof card === "object"
    && card.source === "user"
    && cardLists.every((field) => Array.isArray(card[field]));
  if (!valid) {
    return failLiveBenchmark(
      "LIVE_BENCHMARK_FIXTURE_IDENTITY",
      "v3 脱敏画像、简历版本与匹配卡的结构或关联标识不一致。"
    );
  }
  return { ok: true, profile, resumeVersions, envelope, matchingCard: card };
}

function readJsonFixture(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fixtureIdentity(request, envelope) {
  return {
    fixtureProfileId: LIVE_FIXTURE_PROFILE_ID,
    fixtureProfileSha256: sha256File(request.profilePath),
    fixtureResumeVersionsSha256: sha256File(request.resumeVersionsPath),
    fixtureMatchingCardId: envelope.id,
    fixtureMatchingCardSha256: sha256File(request.matchingCardPath),
    fixtureJobSetSha256: sha256File(resolveAgainstRoot(LIVE_JOB_FIXTURE))
  };
}

function sanitizedModelIdentity(modelConfig) {
  const provider = String(modelConfig?.provider || "");
  const selected = modelConfig?.providers?.[provider] || {};
  const endpoint = String(selected.baseUrl || "");
  return {
    provider,
    model: String(selected.model || ""),
    timeoutMs: Number(selected.timeoutMs || 0),
    endpointSha256: endpoint ? crypto.createHash("sha256").update(endpoint).digest("hex") : ""
  };
}
```

- [ ] **Step 6: 接入 CLI 参数与安全失败子进程**

把 `parseLiveArgs()` 初始值扩展：

```js
const options = {
  outputDir: "",
  evaluatedCommit: "",
  baselineBehaviorCommit: "",
  modelSettingsRoot: ""
};
```

把允许带值参数的条件扩展为：

```js
if (["--output-dir", "--evaluated-commit", "--baseline-commit", "--model-settings-root"].includes(arg)) {
```

并在该分支中赋值：

```js
if (arg === "--model-settings-root") options.modelSettingsRoot = value;
```

在 `assertLiveFailureBranchesOffline()` 的 branches 加入：

```js
{
  name: "缺模型设置根目录",
  args: ["--live", "--output-dir", externalOutput],
  env: branchEnv(authorized),
  code: "LIVE_BENCHMARK_MODEL_SETTINGS_ROOT_REQUIRED"
}
```

该分支必须位于所有可能解析 provider 的路径之前。

- [ ] **Step 7: 让 live 路径使用静态卡和正式设置根目录**

在 `runLive()` 传入 gate options：

```js
matchingCardPath: LIVE_MATCHING_CARD_FIXTURE,
modelSettingsRoot: cliOptions.modelSettingsRoot,
```

provider closure 改为：

```js
() => {
  if (!resolvedModelConfig) {
    resolvedModelConfig = resolveRuntimeModelConfig({
      root: canonicalizeExisting(
        cliOptions.modelSettingsRoot || process.env[LIVE_BENCHMARK_MODEL_SETTINGS_ROOT_ENV]
      ),
      fallbackModelConfig: loadConfigs(root).model
    }).modelConfig;
  }
  return { provider: resolvedModelConfig && resolvedModelConfig.provider };
}
```

门禁通过后，用下面代码替换当前 `runLive()` 中从 `const base = loadConfigs(root, { profile: LIVE_PROFILE_FIXTURE, resumeVersions: LIVE_RESUME_VERSIONS_FIXTURE });` 开始、到 `const configs = profileToRuntimeConfigs(base, candidateProfile, searchPlan);` 结束的整段：

```js
const profile = readJsonFixture(requestGate.request.profilePath);
const resumeVersions = readJsonFixture(requestGate.request.resumeVersionsPath);
const envelope = readJsonFixture(requestGate.request.matchingCardPath);
const bundle = validateLiveFixtureBundle(profile, resumeVersions, envelope);
if (!bundle.ok) {
  const error = new Error(bundle.message);
  error.code = bundle.code;
  throw error;
}

const base = loadConfigs(root);
base.candidateProfile = bundle.profile;
base.resumeVersions = bundle.resumeVersions;
base.model = resolvedModelConfig;
const candidateProfile = bundle.profile;
const searchPlan = benchmarkPlan(candidateProfile);
const configs = profileToRuntimeConfigs(
  base,
  candidateProfile,
  searchPlan,
  null,
  bundle.matchingCard
);
const inputIdentity = fixtureIdentity(requestGate.request, bundle.envelope);
const modelIdentity = sanitizedModelIdentity(resolvedModelConfig);
```

不要 import 候选分支专属的 `matching_card.js`；harness 必须能在旧基线运行。

- [ ] **Step 8: 输出两类硬排除错误与全部身份**

用以下代码替换现有 `hardExpected`/`hardFalsePlacement` 计算：

```js
const hardFalsePlacementIds = rows
  .filter((row) => row.expectedBucket === "not_recommended" && row.actualBucket !== "not_recommended")
  .map((row) => row.id)
  .sort();
const falseHardExclusionIds = rows
  .filter((row) => row.expectedBucket !== "not_recommended" && row.actualBucket === "not_recommended")
  .map((row) => row.id)
  .sort();
const hardFalsePlacement = hardFalsePlacementIds.length;
const falseHardExclusion = falseHardExclusionIds.length;
```

在 summary 中加入：

```js
...inputIdentity,
modelIdentity,
hardFalsePlacement,
hardFalsePlacementIds,
falseHardExclusion,
falseHardExclusionIds,
```

保留 `primaryWithoutEvidence`、`failed/stale/pending/partial` 和全部 rows。`renderMarkdown()` 增加：

```js
`- 画像 SHA-256：${summary.fixtureProfileSha256}`,
`- 简历版本 SHA-256：${summary.fixtureResumeVersionsSha256}`,
`- 匹配卡：${summary.fixtureMatchingCardId}`,
`- 匹配卡 SHA-256：${summary.fixtureMatchingCardSha256}`,
`- JD fixture SHA-256：${summary.fixtureJobSetSha256}`,
`- 模型身份：${summary.modelIdentity.provider}/${summary.modelIdentity.model}`,
`- 硬排除漏拦：${summary.hardFalsePlacement}（${summary.hardFalsePlacementIds.join("、") || "无"}）`,
`- 错误硬排除：${summary.falseHardExclusion}（${summary.falseHardExclusionIds.join("、") || "无"}）`,
```

任何 Markdown/JSON 都不得包含 `modelSettingsRoot`、base URL、API key 或 DPAPI 内容。

- [ ] **Step 9: 运行 harness 离线绿色检查**

Run:

```powershell
node tests/job_match_benchmark.js
```

Expected:

```text
job_match_benchmark fixtures ok (31)
```

确认没有创建 `D:\DevData\RoleFlow-benchmark\subprocess-*`，没有读取正式模型设置，没有网络调用。

- [ ] **Step 10: 提交 Task 3**

```powershell
git add -- tests/job_match_benchmark.js
git diff --cached --check
git commit -m "test: add sanitized live benchmark harness v3"
```

---

### Task 4: 收紧 v3 离线比较器

**Files:**
- Modify: `tests/job_match_benchmark.js:490-722`
- Modify: `tests/generic_evidence_matching_smoke.js:122-290`

**Interfaces:**
- Consumes: Task 3 live JSON 字段。
- Produces: 比较器验证全部输入/model 身份；同时拒绝新增硬排除漏拦和新增错误硬排除。

- [ ] **Step 1: 扩展合成 live 结果**

在 `tests/generic_evidence_matching_smoke.js` 的 `liveResult()` 中加入 fixture/model identity，并把原来的 `hardFalsePlacement: 0` 替换成：

```js
fixtureProfileSha256: "a".repeat(64),
fixtureResumeVersionsSha256: "b".repeat(64),
fixtureMatchingCardId: "fixture-card-a",
fixtureMatchingCardSha256: "c".repeat(64),
fixtureJobSetSha256: "d".repeat(64),
modelIdentity: {
  provider: "openai_compatible",
  model: "benchmark-model",
  timeoutMs: 60000,
  endpointSha256: "e".repeat(64)
},
hardFalsePlacement: 1,
hardFalsePlacementIds: ["java-core-missing"],
falseHardExclusion: 0,
falseHardExclusionIds: [],
```

同时把 baseline 合成结果的 `bucketAccuracy` 改为：

```js
bucketAccuracy: 5 / 6,
```

把合成 rows 的每项补全为相同的默认桶：

```js
{
  id: "ecommerce-core-match",
  pass: true,
  expectedBucket: "primary",
  actualBucket: "primary",
  semanticStatus: "complete"
}
```

`user-ops-vs-pure-sales` 使用：

```js
{
  id: "user-ops-vs-pure-sales",
  pass: true,
  expectedBucket: "not_recommended",
  actualBucket: "not_recommended",
  semanticStatus: "complete"
}
```

其余 ID 使用相同字段；`java-core-missing` 使用：

```js
{
  id: "java-core-missing",
  pass: false,
  expectedBucket: "not_recommended",
  actualBucket: "talk",
  semanticStatus: "complete"
}
```

valid candidate 中把 `java-core-missing` 改成 `actualBucket: "not_recommended"` 和 `pass: true`，并同时覆盖：

```js
bucketAccuracy: 1,
hardFalsePlacement: 0,
hardFalsePlacementIds: [],
```

- [ ] **Step 2: 写身份与两类错误的红灯断言**

在成功报告断言中加入：

```js
assert.strictEqual(ok.report.fixtureMatchingCardId, "fixture-card-a");
assert.strictEqual(ok.report.fixtureMatchingCardSha256, "c".repeat(64));
assert.strictEqual(ok.report.fixtureProfileSha256, "a".repeat(64));
assert.strictEqual(ok.report.fixtureResumeVersionsSha256, "b".repeat(64));
assert.strictEqual(ok.report.fixtureJobSetSha256, "d".repeat(64));
assert.deepStrictEqual(ok.report.modelIdentity, candidate.modelIdentity);
assert.strictEqual(ok.report.baseline.falseHardExclusion, 0);
assert.strictEqual(ok.report.candidate.falseHardExclusion, 0);
```

在结构失败用例中加入：

```js
{ name: "画像内容哈希不一致", baseline, candidate: { ...candidate, fixtureProfileSha256: "f".repeat(64) }, code: "BENCHMARK_COMPARE_FIXTURE_PROFILE" },
{ name: "简历版本哈希不一致", baseline, candidate: { ...candidate, fixtureResumeVersionsSha256: "f".repeat(64) }, code: "BENCHMARK_COMPARE_RESUME_VERSIONS" },
{ name: "匹配卡 ID 不一致", baseline, candidate: { ...candidate, fixtureMatchingCardId: "fixture-card-b" }, code: "BENCHMARK_COMPARE_MATCHING_CARD" },
{ name: "匹配卡哈希不一致", baseline, candidate: { ...candidate, fixtureMatchingCardSha256: "f".repeat(64) }, code: "BENCHMARK_COMPARE_MATCHING_CARD" },
{ name: "JD fixture 哈希不一致", baseline, candidate: { ...candidate, fixtureJobSetSha256: "f".repeat(64) }, code: "BENCHMARK_COMPARE_FIXTURE_SET" },
{ name: "模型身份不一致", baseline, candidate: { ...candidate, modelIdentity: { ...candidate.modelIdentity, model: "other-model" } }, code: "BENCHMARK_COMPARE_MODEL_IDENTITY" },
```

移除原先只改汇总计数、却不改 rows 的 `hardFalsePlacement 增加` 合成用例；比较器会复算 rows，这类伪造结果应属于结构失败。改为以下三条一致的 acceptance 失败用例：

```js
{
  name: "hardFalsePlacement 数量增加",
  mutate: (c) => ({
    ...c,
    passed: 4,
    accuracy: 4 / 6,
    bucketAccuracy: 4 / 6,
    hardFalsePlacement: 2,
    hardFalsePlacementIds: ["java-core-missing", "user-ops-vs-pure-sales"],
    rows: c.rows.map((row) => ["java-core-missing", "user-ops-vs-pure-sales"].includes(row.id)
      ? { ...row, actualBucket: "talk", pass: false }
      : row)
  }),
  reason: /hardFalsePlacement 增加/
},
{
  name: "相同数量但替换成新的硬排除漏拦 ID",
  mutate: (c) => ({
    ...c,
    passed: 5,
    accuracy: 5 / 6,
    bucketAccuracy: 5 / 6,
    hardFalsePlacement: 1,
    hardFalsePlacementIds: ["user-ops-vs-pure-sales"],
    rows: c.rows.map((row) => row.id === "user-ops-vs-pure-sales"
      ? { ...row, actualBucket: "talk", pass: false }
      : row)
  }),
  reason: /新增硬排除漏拦/
},
{
  name: "新增错误硬排除 ID",
  mutate: (c) => ({
    ...c,
    passed: 5,
    accuracy: 5 / 6,
    bucketAccuracy: 5 / 6,
    falseHardExclusion: 1,
    falseHardExclusionIds: ["ecommerce-core-match"],
    rows: c.rows.map((row) => row.id === "ecommerce-core-match"
      ? { ...row, actualBucket: "not_recommended", pass: false }
      : row)
  }),
  reason: /新增错误硬排除/
}
```

- [ ] **Step 3: 运行红灯**

Run:

```powershell
node tests/generic_evidence_matching_smoke.js
```

Expected: FAIL，报告缺 matching card/hash/model identity，或比较器未拒绝身份错位。

- [ ] **Step 4: 扩展比较指标和身份检查**

在 `tests/job_match_benchmark.js` 中把：

```js
const COMPARE_METRIC_FIELDS = [
  "total", "passed", "accuracy", "recommendationAccuracy", "bucketAccuracy",
  "failed", "stale", "pending", "partial", "hardFalsePlacement",
  "falseHardExclusion", "primaryWithoutEvidence"
];
```

在 profile ID 检查后加入：

```js
function sameNonEmptyIdentity(baseline, candidate, field) {
  const left = String(baseline[field] || "").trim();
  const right = String(candidate[field] || "").trim();
  return Boolean(left && right && left === right);
}

function sameSha256(baseline, candidate, field) {
  const left = String(baseline[field] || "").trim().toLowerCase();
  const right = String(candidate[field] || "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(left) && left === right;
}

if (!sameSha256(baseline, candidate, "fixtureProfileSha256")) {
  return failCompare("BENCHMARK_COMPARE_FIXTURE_PROFILE", "两侧必须使用相同且非空的 profile SHA-256。");
}
if (!sameSha256(baseline, candidate, "fixtureResumeVersionsSha256")) {
  return failCompare("BENCHMARK_COMPARE_RESUME_VERSIONS", "两侧必须使用相同且非空的 resume versions SHA-256。");
}
if (!sameNonEmptyIdentity(baseline, candidate, "fixtureMatchingCardId")
  || !sameSha256(baseline, candidate, "fixtureMatchingCardSha256")) {
  return failCompare("BENCHMARK_COMPARE_MATCHING_CARD", "两侧必须使用相同且非空的匹配卡 ID 与 SHA-256。");
}
if (!sameSha256(baseline, candidate, "fixtureJobSetSha256")) {
  return failCompare("BENCHMARK_COMPARE_FIXTURE_SET", "两侧必须使用相同且非空的 JD fixture SHA-256。");
}

const modelFields = ["provider", "model", "timeoutMs", "endpointSha256"];
if (!baseline.modelIdentity || !candidate.modelIdentity
  || !String(baseline.modelIdentity.provider || "")
  || !String(baseline.modelIdentity.model || "")
  || !Number.isFinite(baseline.modelIdentity.timeoutMs)
  || !/^[0-9a-f]{64}$/.test(String(baseline.modelIdentity.endpointSha256 || ""))
  || modelFields.some((field) => baseline.modelIdentity[field] !== candidate.modelIdentity[field])) {
  return failCompare("BENCHMARK_COMPARE_MODEL_IDENTITY", "两侧必须使用相同的去密钥模型身份与参数。");
}
```

- [ ] **Step 5: 从 rows 复算并核对两类 ID**

新增：

```js
function hardPlacementIdentity(result) {
  const hardFalsePlacementIds = result.rows
    .filter((row) => row.expectedBucket === "not_recommended" && row.actualBucket !== "not_recommended")
    .map((row) => row.id)
    .sort();
  const falseHardExclusionIds = result.rows
    .filter((row) => row.expectedBucket !== "not_recommended" && row.actualBucket === "not_recommended")
    .map((row) => row.id)
    .sort();
  return { hardFalsePlacementIds, falseHardExclusionIds };
}

function sameIds(left, right) {
  return JSON.stringify([...(left || [])].sort()) === JSON.stringify([...(right || [])].sort());
}
```

在确认 rows 存在后，对两侧执行：

```js
for (const [label, value] of [["基线", baseline], ["候选", candidate]]) {
  const derived = hardPlacementIdentity(value);
  if (!Array.isArray(value.hardFalsePlacementIds)
    || !Array.isArray(value.falseHardExclusionIds)
    || value.hardFalsePlacement !== derived.hardFalsePlacementIds.length
    || !sameIds(value.hardFalsePlacementIds, derived.hardFalsePlacementIds)
    || value.falseHardExclusion !== derived.falseHardExclusionIds.length
    || !sameIds(value.falseHardExclusionIds, derived.falseHardExclusionIds)) {
    return failCompare(
      "BENCHMARK_COMPARE_METRICS",
      `${label}两类硬排除计数/ID 与 rows 复算结果不一致。`
    );
  }
}
```

- [ ] **Step 6: 收紧 acceptance gate**

在 `acceptanceFailures()` 中保留现有数值门禁并加入：

```js
if (candidate.falseHardExclusion > baseline.falseHardExclusion) {
  failures.push(`falseHardExclusion 增加：${baseline.falseHardExclusion} -> ${candidate.falseHardExclusion}`);
}
const newHardFalsePlacementIds = candidate.hardFalsePlacementIds
  .filter((id) => !baseline.hardFalsePlacementIds.includes(id));
if (newHardFalsePlacementIds.length) {
  failures.push(`新增硬排除漏拦：${newHardFalsePlacementIds.join("、")}`);
}
const newFalseHardExclusionIds = candidate.falseHardExclusionIds
  .filter((id) => !baseline.falseHardExclusionIds.includes(id));
if (newFalseHardExclusionIds.length) {
  failures.push(`新增错误硬排除：${newFalseHardExclusionIds.join("、")}`);
}
```

在 `compareBenchmarkResults()` 的 report 对象中加入：

```js
fixtureProfileSha256: candidate.fixtureProfileSha256,
fixtureResumeVersionsSha256: candidate.fixtureResumeVersionsSha256,
fixtureMatchingCardId: candidate.fixtureMatchingCardId,
fixtureMatchingCardSha256: candidate.fixtureMatchingCardSha256,
fixtureJobSetSha256: candidate.fixtureJobSetSha256,
modelIdentity: candidate.modelIdentity,
hardFalsePlacementIds: [...candidate.hardFalsePlacementIds],
falseHardExclusionIds: [...candidate.falseHardExclusionIds],
```

在 `renderComparisonMarkdown()` 的身份区加入：

```js
`- 脱敏画像 SHA-256：${report.fixtureProfileSha256}`,
`- 简历版本 SHA-256：${report.fixtureResumeVersionsSha256}`,
`- 匹配卡：${report.fixtureMatchingCardId}`,
`- 匹配卡 SHA-256：${report.fixtureMatchingCardSha256}`,
`- JD fixture SHA-256：${report.fixtureJobSetSha256}`,
`- 模型身份：${report.modelIdentity.provider}/${report.modelIdentity.model}`,
`- 候选硬排除漏拦 ID：${report.hardFalsePlacementIds.join("、") || "无"}`,
`- 候选错误硬排除 ID：${report.falseHardExclusionIds.join("、") || "无"}`,
```

不得只展示计数，也不得输出模型设置根目录、base URL 或密钥。

- [ ] **Step 7: 运行绿色测试**

Run:

```powershell
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
```

Expected:

```text
generic_evidence_matching_smoke ok (6 samples)
job_match_benchmark fixtures ok (31)
```

- [ ] **Step 8: 提交 Task 4**

```powershell
git add -- tests/job_match_benchmark.js tests/generic_evidence_matching_smoke.js
git diff --cached --check
git commit -m "test: enforce benchmark v3 comparison identity"
```

---

### Task 5: 完成候选离线验收并建立相同的 v3 基线

**Files:**
- Create worktree: `D:\DevData\RoleFlow-benchmark-v3-baseline`
- Create branch: `codex/generic-evidence-matching-benchmark-v3-baseline`
- Copy exact blobs:
  - `tests/job_match_benchmark.js`
  - `tests/fixtures/live_benchmark_profile.json`
  - `tests/fixtures/live_benchmark_resume_versions.json`
  - `tests/fixtures/live_benchmark_matching_card.json`
  - `tests/fixtures/job_match_benchmark.json`

**Interfaces:**
- Consumes: Tasks 1–4 的候选 HEAD；基线提交 `e9689627540d1cbc419a7a06853ffea986115ff0`。
- Produces: 一个只增加 v3 harness/fixture 的基线提交；五个共享文件在两侧拥有完全相同的 Git blob。

- [ ] **Step 1: 候选分支完整离线回归**

Run:

```powershell
git merge-base --is-ancestor cf4c964f70e2fd533dffb30342bf868dbe17cae6 HEAD
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/matching_card_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
npm.cmd test
git diff --check
git status --short
```

Expected:

- `git merge-base` exit 0；
- 五条目标 smoke 全部输出 `ok`；
- `npm.cmd test` 输出 `All 43 offline checks passed`；
- `git diff --check` 无输出；
- `git status --short` 为空。

- [ ] **Step 2: 预检并创建独立 v3 基线 worktree**

先按 `using-git-worktrees` skill 执行路径和分支预检。PowerShell：

```powershell
$candidateRoot = 'D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$baselineRepo = 'D:\DevData\RoleFlow-benchmark-v2-baseline'
$baselineRoot = 'D:\DevData\RoleFlow-benchmark-v3-baseline'
$baselineBranch = 'codex/generic-evidence-matching-benchmark-v3-baseline'
$baselineStart = 'e9689627540d1cbc419a7a06853ffea986115ff0'

if (Test-Path -LiteralPath $baselineRoot) { throw "目标 worktree 已存在：$baselineRoot" }
if (git -C $baselineRepo branch --list $baselineBranch) { throw "目标分支已存在：$baselineBranch" }
if ((git -C $baselineRepo status --porcelain).Trim()) { throw "v2 baseline repo 工作树不干净" }
git -C $baselineRepo cat-file -e "${baselineStart}^{commit}"
if ($LASTEXITCODE -ne 0) { throw "缺少基线提交 $baselineStart" }
git -C $baselineRepo worktree add -b $baselineBranch $baselineRoot $baselineStart
if ($LASTEXITCODE -ne 0) { throw "创建 v3 baseline worktree 失败" }
```

不得复用或删除已有目录；任一预检失败立即停报。

- [ ] **Step 3: 机械复制五个共享文件**

```powershell
$sharedFiles = @(
  'tests/job_match_benchmark.js',
  'tests/fixtures/live_benchmark_profile.json',
  'tests/fixtures/live_benchmark_resume_versions.json',
  'tests/fixtures/live_benchmark_matching_card.json',
  'tests/fixtures/job_match_benchmark.json'
)

foreach ($relative in $sharedFiles) {
  $source = Join-Path $candidateRoot $relative
  $destination = Join-Path $baselineRoot $relative
  $destinationParent = Split-Path -Parent $destination
  if (!(Test-Path -LiteralPath $source)) { throw "候选共享文件不存在：$source" }
  New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Force
}
```

这是固定列表的机械同步，不得复制 `src/`、`tests/generic_evidence_matching_smoke.js`、`tests/matching_card_smoke.js` 或任何候选算法文件。

- [ ] **Step 4: 在提交前逐文件验证 blob 相同**

```powershell
foreach ($relative in $sharedFiles) {
  $candidateBlob = (git -C $candidateRoot hash-object -- $relative).Trim()
  $baselineBlob = (git -C $baselineRoot hash-object -- $relative).Trim()
  if ($candidateBlob -ne $baselineBlob) {
    throw "共享文件 blob 不一致：$relative ($candidateBlob != $baselineBlob)"
  }
}
```

Expected: 无异常。

- [ ] **Step 5: 运行基线离线测试**

```powershell
Push-Location $baselineRoot
try {
  if (!(Test-Path -LiteralPath 'node_modules')) {
    npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw "baseline npm ci 失败" }
  }
  node tests/job_match_benchmark.js
  if ($LASTEXITCODE -ne 0) { throw "baseline benchmark 离线检查失败" }
  npm.cmd test
  if ($LASTEXITCODE -ne 0) { throw "baseline 全量离线测试失败" }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw "baseline diff-check 失败" }
} finally {
  Pop-Location
}
```

Expected:

```text
job_match_benchmark fixtures ok (31)
All 41 offline checks passed
```

依赖只允许写入 `D:\DevData\RoleFlow-benchmark-v3-baseline\node_modules`。

- [ ] **Step 6: 提交 v3 基线**

```powershell
git -C $baselineRoot add -- $sharedFiles
git -C $baselineRoot diff --cached --check
git -C $baselineRoot commit -m "test: sync benchmark harness v3 implementation"
if ($LASTEXITCODE -ne 0) { throw "v3 baseline commit 失败" }
$v3BaselineCommit = (git -C $baselineRoot rev-parse HEAD).Trim()
$v3CandidateCommit = (git -C $candidateRoot rev-parse HEAD).Trim()
```

- [ ] **Step 7: 提交后再次核对拓扑和 blob**

```powershell
$baselineParents = (git -C $baselineRoot rev-list --parents -n 1 $v3BaselineCommit).Trim().Split(' ')
if ($baselineParents.Count -ne 2 -or $baselineParents[1] -ne $baselineStart) {
  throw "v3 baseline 必须是 e968962 的单父提交"
}
foreach ($relative in $sharedFiles) {
  $candidateBlob = (git -C $candidateRoot rev-parse "$v3CandidateCommit`:$relative").Trim()
  $baselineBlob = (git -C $baselineRoot rev-parse "$v3BaselineCommit`:$relative").Trim()
  if ($candidateBlob -ne $baselineBlob) { throw "提交后 blob 不一致：$relative" }
}
if ((git -C $candidateRoot status --porcelain).Trim()) { throw "candidate worktree 不干净" }
if ((git -C $baselineRoot status --porcelain).Trim()) { throw "baseline worktree 不干净" }
```

保存并报告 `$v3BaselineCommit` 与 `$v3CandidateCommit`，但本任务不 push。

---

### Task 6: Fixture 人工复核停点

**Files:** None.

**Interfaces:**
- Consumes: 两侧已提交且 blob 相同的 v3 fixture。
- Produces: 用户对完整脱敏画像和静态匹配卡的明确确认；没有确认就不能进入 Task 7。

- [ ] **Step 1: 只读输出人类可读摘要**

在候选 worktree 运行：

```powershell
node -e "const p=require('./tests/fixtures/live_benchmark_profile.json'); const r=require('./tests/fixtures/live_benchmark_resume_versions.json'); const c=require('./tests/fixtures/live_benchmark_matching_card.json'); console.log(JSON.stringify({profileId:p.id,education:p.education,experiences:p.experiences,skills:p.skills,projects:p.projects,resumeVersions:r.versions,matchingCard:c},null,2))"
```

不得读取 `.runtime`、正式模型设置或主项目数据。

- [ ] **Step 2: 向用户逐项报告能力边界**

报告必须明确：

- 写入了虚构本科教育；
- 只有项目协作经历，不声称正式公司经历或主导经历；
- 强证据仅有 Python/FastAPI、RAG、Agent 工作流和质量复核；
- 可迁移能力明确排除大规模采集、高并发、分布式、独立售前和客户项目管理；
- 没有写入成熟模型评估体系、生产级异常降级或量化提升；
- JD fixture 与 31 条预期标签未修改。

- [ ] **Step 3: 停止并等待两项明确输入**

必须同时等到：

1. 用户确认 fixture 没有夸大或遗漏关键边界；
2. 用户在看到最终 v3 baseline/candidate 提交哈希后，重新明确写出 `ALLOW_LIVE_MODEL_BENCHMARK=YES`，授权本次 v3 两侧真实运行。

没有这两项时，不得读取 `D:\Guo\ZhiPing\.runtime\settings`、`.runtime\secrets`，不得执行任何 `--live` 命令。

---

### Task 7: 经授权执行 v3 双跑与离线比较

**Files:** None in Git.

**Interfaces:**
- Consumes: Task 6 明确确认和授权；`$v3BaselineCommit`、`$v3CandidateCommit`。
- Produces: 外部结果目录中的 baseline/candidate live JSON、Markdown、独立缓存、comparison JSON/Markdown；最终 accepted 或 rejected 结论。

- [ ] **Step 1: 授权后执行最终安全预检**

```powershell
$candidateRoot = 'D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$baselineRoot = 'D:\DevData\RoleFlow-benchmark-v3-baseline'
$modelSettingsRoot = 'D:\Guo\ZhiPing'
$v3CandidateCommit = (git -C $candidateRoot rev-parse HEAD).Trim()
$v3BaselineCommit = (git -C $baselineRoot rev-parse HEAD).Trim()

if ((git -C $candidateRoot status --porcelain).Trim()) { throw "candidate worktree 不干净" }
if ((git -C $baselineRoot status --porcelain).Trim()) { throw "baseline worktree 不干净" }
if (!(Test-Path -LiteralPath (Join-Path $modelSettingsRoot '.runtime\settings\model.json'))) {
  throw "正式模型设置不存在"
}

$sharedFiles = @(
  'tests/job_match_benchmark.js',
  'tests/fixtures/live_benchmark_profile.json',
  'tests/fixtures/live_benchmark_resume_versions.json',
  'tests/fixtures/live_benchmark_matching_card.json',
  'tests/fixtures/job_match_benchmark.json'
)
foreach ($relative in $sharedFiles) {
  $candidateBlob = (git -C $candidateRoot rev-parse "$v3CandidateCommit`:$relative").Trim()
  $baselineBlob = (git -C $baselineRoot rev-parse "$v3BaselineCommit`:$relative").Trim()
  if ($candidateBlob -ne $baselineBlob) { throw "live 前共享 blob 不一致：$relative" }
}
```

只允许 `Test-Path` 检查设置文件存在；不得 `Get-Content`、打印或复制正式设置/密钥。

- [ ] **Step 2: 建立新的外部结果路径**

```powershell
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$outputRoot = "D:\DevData\RoleFlow-benchmark\live-v3-$runId"
$baselineOutput = Join-Path $outputRoot 'baseline'
$candidateOutput = Join-Path $outputRoot 'candidate'
$comparisonOutput = Join-Path $outputRoot 'comparison.json'
if (Test-Path -LiteralPath $outputRoot) { throw "结果目录已存在：$outputRoot" }
```

- [ ] **Step 3: 单独授权并运行 baseline**

```powershell
Push-Location $baselineRoot
try {
  $env:ALLOW_LIVE_MODEL_BENCHMARK = 'YES'
  npm.cmd run test:live-model -- --output-dir $baselineOutput --model-settings-root $modelSettingsRoot --evaluated-commit $v3BaselineCommit
  $baselineExit = $LASTEXITCODE
} finally {
  Remove-Item Env:ALLOW_LIVE_MODEL_BENCHMARK -ErrorAction SilentlyContinue
  Pop-Location
}
if (!(Test-Path -LiteralPath (Join-Path $baselineOutput 'latest.json'))) {
  throw "baseline 未生成 latest.json，exit=$baselineExit"
}
```

benchmark 因样本未全对而非零退出时仍保留结果；只有没有 `latest.json`、门禁失败、配置失败或网络使整次运行中断时才停止。

- [ ] **Step 4: 再次单独授权并运行 candidate**

```powershell
Push-Location $candidateRoot
try {
  $env:ALLOW_LIVE_MODEL_BENCHMARK = 'YES'
  npm.cmd run test:live-model -- --output-dir $candidateOutput --model-settings-root $modelSettingsRoot --evaluated-commit $v3CandidateCommit --baseline-commit $v3BaselineCommit
  $candidateExit = $LASTEXITCODE
} finally {
  Remove-Item Env:ALLOW_LIVE_MODEL_BENCHMARK -ErrorAction SilentlyContinue
  Pop-Location
}
if (!(Test-Path -LiteralPath (Join-Path $candidateOutput 'latest.json'))) {
  throw "candidate 未生成 latest.json，exit=$candidateExit"
}
```

- [ ] **Step 5: 移除授权并只做离线比较**

```powershell
Remove-Item Env:ALLOW_LIVE_MODEL_BENCHMARK -ErrorAction SilentlyContinue
Push-Location $candidateRoot
try {
  node tests/job_match_benchmark.js --compare --baseline (Join-Path $baselineOutput 'latest.json') --candidate (Join-Path $candidateOutput 'latest.json') --report $comparisonOutput
  $compareExit = $LASTEXITCODE
} finally {
  Pop-Location
}
```

Expected:

- 结构身份错误：非零退出，不生成 comparison；
- 结构可比但未达标：非零退出，生成 `accepted:false` comparison；
- 全部门禁通过：exit 0，生成 `accepted:true` comparison 并打印 `benchmark compare ok`。

- [ ] **Step 6: 生成最终报告**

只读取外部目录的：

- `baseline/latest.json` 与 `latest.md`
- `candidate/latest.json` 与 `latest.md`
- `comparison.json` 与 `comparison.md`

最终报告必须包含：

- baseline/candidate 完整提交哈希；
- 五个共享 Git blob 或 SHA-256 身份；
- 去密钥模型身份；
- 两侧 exit code；
- failed/stale/pending/partial；
- recommendation/bucket accuracy；
- hardFalsePlacement 计数与 ID；
- falseHardExclusion 计数与 ID；
- primaryWithoutEvidence；
- regressions/improvements；
- `accepted` 与全部 failureReasons；
- 安全边界确认。

不论 accepted 与否，都不得自动 push、合并或修改主项目。停止并等待用户决定。

---

## Final Verification Checklist

- [ ] Candidate 从 `cf4c964f70e2fd533dffb30342bf868dbe17cae6` 线性前进，未 amend 历史。
- [ ] `understandJob` 有明确 contractRepair 指令，普通“需要理解业务”不是自动硬门槛。
- [ ] 管线版本为 `job-understanding-v6` / `match-decision-v13`，旧 v5/v12 缓存会 stale。
- [ ] 三份 v3 fixture 完全脱敏、结构完整、关联 ID 一致并由用户人工确认。
- [ ] `tests/fixtures/job_match_benchmark.json` 内容与标签未修改。
- [ ] v3 baseline 是 `e9689627540d1cbc419a7a06853ffea986115ff0` 的单父提交，只增加共享 harness/fixture。
- [ ] 两侧五个共享文件的 Git blob 完全相同。
- [ ] Candidate `All 43 offline checks passed`；baseline `All 41 offline checks passed`。
- [ ] 未获 Task 6 新授权前没有读取正式模型设置或运行真实模型。
- [ ] live 期间没有复制设置、DPAPI 文件或明文密钥。
- [ ] 比较器同时验证错误放过和错误硬排除，不混用 `hardFalsePlacement` 语义。
- [ ] live 结果只存在 `D:\DevData\RoleFlow-benchmark\live-v3-*`。
- [ ] 未访问招聘平台、主数据库或 8787，未修改 `D:\Guo\ZhiPing`。
- [ ] 最终没有自动 push 或合并。
