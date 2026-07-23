# 通用证据岗位匹配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前偏向 AI/Python 技术求职的岗位判断改为“简历证据 + JD 真实要求”的通用匹配内核，并让用户确认可编辑的匹配偏好卡后才切换到新简历版本。

**Architecture:** 新增版本化的 `candidate_matching_cards`，由已确认卡指向可用于匹配的 `profile_versions` 快照。模型只在固定契约内生成卡、拆解 JD 和逐项匹配证据；本地代码统一执行用户硬条件、证据完整性、风险降级和建议分桶。新简历先形成草稿卡，确认后才使旧方案变为待确认状态。

**Tech Stack:** Node.js 22、CommonJS、`node:sqlite`、内置 HTTP 工作台、OpenAI-compatible JSON adapter、现有 smoke tests 与注入式假模型。

## Global Constraints

- 所有实现留在隔离 worktree 的 `codex/generic-evidence-matching-design` 分支；不得读取或写入 `D:\Guo\ZhiPing\data\jobs.sqlite`。
- 不访问真实 BOSS、不启动 8787、不进行真实沟通或投递；测试只使用临时 SQLite、fixture、假模型和 `--input` 扫描。
- 不引入电商运营、内容运营、用户运营等生产职业模板；它们仅作为通用内核的验收样本。
- 用户的城市、最低薪资、工作性质、明确排除项、明确资格和既有风险保护不得被模型放宽。
- `apply` / `caution` 必须具有 JD 与简历两侧证据；缺任一侧时降为 `review`。
- 只有明确资格不符、唯一不可替代的核心能力缺失，或现有收费/违规/虚假风险命中，才可 `skip`；年限、加分项和愿望清单不得单独触发 `skip`。
- 历史岗位分析与历史卡版本不可重写；新管线必须通过版本与缓存键区分旧结果。

---

## Files and Responsibilities

| 文件 | 实现后的职责 |
|---|---|
| `src/core/matching_card.js` | 规范化匹配偏好卡、校验用户编辑字段、生成稳定卡修订指纹。 |
| `src/core/storage.js` | migration v5、匹配卡 CRUD、已确认卡对应的候选人版本上下文、计划依赖状态。 |
| `src/core/profile_onboarding.js` | 从已结构化、脱敏后的候选人事实生成模型草稿卡。 |
| `src/core/llm_analyzer.js` | 暴露 `buildCandidateMatchCard`。 |
| `src/core/model_contract.js` | 校验匹配卡、通用 JD 理解和逐项匹配的固定 JSON 契约。 |
| `src/adapters/models/openai_compatible.js` | 用通用职责/证据提示词生成卡、JD 结构和匹配结论。 |
| `src/adapters/models/mock.js` | 维持离线确定性，但不再把 AI/Python 作为默认候选人或默认岗位。 |
| `src/core/analysis_revision.js` | 将卡修订和新匹配管线版本纳入分析陈旧性判断。 |
| `src/core/search_plan.js` | 将已确认卡传给运行时配置和分析上下文，而不把卡变成搜索筛选规则。 |
| `src/core/job_analysis.js` | 把卡传给岗位匹配；持久化通用职责、逐项证据、岗位质量和四档建议。 |
| `src/core/scoring.js`、`src/core/match_explainer.js` | 删除 AI/Python 专属的本地硬拦截；只保留跨职业的基础条件与非语义初筛。 |
| `src/dashboard/server.js`、`src/cli.js` | 新增卡查看/编辑/确认流程，并在扫描、补读、重试分析中解析已确认的候选人上下文。 |
| `src/core/plan_validation.js`、`src/core/storage.js` | 首次无已确认卡时拒绝开始扫描；新草稿尚未确认时继续使用旧确认卡及其画像快照。 |
| `tests/matching_card_smoke.js` | 卡的存储、版本切换、同哈希复用、计划依赖和历史保留。 |
| `tests/onboarding_smoke.js` | 工作台上传、草稿卡确认、重复上传和扫描前保护的端到端测试。 |
| `tests/semantic_pipeline_smoke.js` | 通用模型契约、缓存失效、双侧证据、风险降级与技术岗回归。 |
| `tests/generic_evidence_matching_smoke.js`、`tests/fixtures/generic_evidence_matching.json` | 三类运营样本、JD 愿望清单、信息不足和技术岗边界的确定性验收。 |
| `tests/storage_migration_smoke.js` | v4 数据库升级到 v5 后表、历史记录与完整性检查。 |

## Shared Interfaces

后续任务使用以下固定接口；不要在各任务中另起同义字段。

```js
// src/core/matching_card.js
normalizeMatchingCard(input, { source = "model", editedByUser = false } = {})
// => {
//   targetDirections: string[],
//   strongEvidence: [{ label, evidence }],
//   transferableCapabilities: [{ label, evidence, limitation }],
//   cautionTransitions: [{ direction, reason }],
//   userNotes: string[],
//   source: "model" | "user"
// }

// src/core/storage.js
createMatchingCardDraft(db, {
  profileId, profileVersionId, resumeDocumentId, resumeContentHash, card
})
getMatchingCard(db, cardId)
getActiveMatchingCard(db, profileId)
getCandidateMatchingContext(db, profileId)
// => { matchingCard, profileVersionId, candidateProfile, resumeDocumentId }
saveMatchingCardDraftEdit(db, { profileId, cardId, card })
confirmMatchingCard(db, { profileId, cardId })
saveConfirmedMatchingCardRevision(db, { profileId, cardId, card })

// src/core/profile_onboarding.js
buildCandidateMatchCard({ modelConfig, profile, logger = null })

// src/core/analysis_revision.js
runtimeAnalysisContext(candidateProfile, searchPlan, matchingCard = null)
// => { profileVersion, searchPlanVersion, matchingCardVersion }
```

模型新增/扩展的固定结构如下。`jobQuality.level` 只允许 `normal`、`caution`、`risk`；`requirementMatches.state` 只允许 `matched`、`transferable`、`missing`、`unknown`、`not_applicable`。

```js
// buildCandidateMatchCard
{
  targetDirections: ["电商运营"],
  strongEvidence: [{ label: "店铺活动与 ROI 复盘", evidence: "简历：负责淘宝店铺活动复盘和投放 ROI 优化" }],
  transferableCapabilities: [{ label: "平台运营数据分析", evidence: "简历：…", limitation: "未证明抖音投流经验" }],
  cautionTransitions: [{ direction: "直播操盘", reason: "简历未证明直播间统筹" }]
}

// understandJob 的新增字段；保留现有 jobId / hiddenRisks 兼容字段
{
  roleSummary: "负责店铺经营、活动和投放复盘",
  coreResponsibilities: [{ label: "店铺活动运营", evidence: "JD：负责…" }],
  coreRequirements: [{ label: "投放与 ROI 分析", indispensable: true, evidence: "JD：必须…" }],
  preferredRequirements: [{ label: "抖音店铺经验", evidence: "JD：有抖音经验优先" }],
  outcomeExpectations: [{ label: "GMV/转化目标", evidence: "JD：完成…" }],
  eligibilityConstraints: [],
  jobQuality: { level: "caution", concerns: [{ type: "responsibility_sprawl", evidence: "JD 同时要求直播、拍摄、剪辑…" }] }
}

// matchJob 的新增字段；仍保留 recommendation / evidence / hardBlockers 等字段
{
  requirementMatches: [{
    requirement: "投放与 ROI 分析", state: "matched", indispensable: true,
    jdEvidence: "JD：负责投放 ROI 优化", resumeEvidence: "简历：完成 ROI 复盘"
  }],
  jobQuality: { level: "caution", concerns: [{ type: "responsibility_sprawl", evidence: "JD：…" }] }
}
```

### Task 1: 版本化匹配偏好卡的存储与活动上下文

**Files:**

- Create: `src/core/matching_card.js`
- Create: `tests/matching_card_smoke.js`
- Modify: `src/core/storage.js`
- Modify: `tests/storage_migration_smoke.js`

**Consumes:** 现有 `candidate_profiles`、`profile_versions`、`resume_documents` 和 `search_plans`。

**Produces:** migration v5、`candidate_matching_cards`、Shared Interfaces 中的五个存储函数，以及由已确认卡决定的计划依赖版本。

- [ ] **Step 1: 写卡生命周期的失败测试。**

在 `tests/matching_card_smoke.js` 用 `openDb(":memory:")` 和 `saveProfileAnalysis` 建两个画像版本。先断言新 API 不存在，然后写出完整预期：首次草稿无活动上下文、确认后上下文指向版本一、同一 `resumeContentHash` 复用该卡、新哈希仅产生草稿且不改变活动上下文、确认草稿后旧卡为 `superseded`、人工编辑产生新的已确认修订。

```js
const first = createMatchingCardDraft(db, {
  profileId, profileVersionId: firstProfileVersionId, resumeDocumentId: firstDocumentId,
  resumeContentHash: "resume-v1", card: card("电商运营")
});
assert.strictEqual(getCandidateMatchingContext(db, profileId), null);
confirmMatchingCard(db, { profileId, cardId: first.id });
assert.strictEqual(getCandidateMatchingContext(db, profileId).profileVersionId, firstProfileVersionId);

const pending = createMatchingCardDraft(db, {
  profileId, profileVersionId: secondProfileVersionId, resumeDocumentId: secondDocumentId,
  resumeContentHash: "resume-v2", card: card("用户运营")
});
assert.strictEqual(getCandidateMatchingContext(db, profileId).profileVersionId, firstProfileVersionId);
assert.strictEqual(getMatchingCard(db, pending.id).status, "draft");
```

- [ ] **Step 2: 运行测试，确认它因模块/API 缺失而失败。**

Run: `node tests/matching_card_smoke.js`

Expected: non-zero exit，报出 `Cannot find module '../src/core/matching_card'` 或缺少导出函数；不得因测试基础数据错误失败。

- [ ] **Step 3: 实现卡规范化、migration v5 和事务性存储 API。**

在 `src/core/matching_card.js` 只接受上方 Shared Interfaces 中的字段；每个字符串 `trim()` 后限 240 字，`targetDirections` 最多 10 项，三类证据/转向数组最多 12 项。拒绝空 `label` 或空 `evidence` 的模型证据；用户备注允许纯文本但最多 12 项。

在 `src/core/storage.js` 添加 migration：

```sql
CREATE TABLE IF NOT EXISTS candidate_matching_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  profile_version_id INTEGER NOT NULL,
  resume_document_id INTEGER,
  resume_content_hash TEXT NOT NULL,
  card_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'confirmed', 'superseded')),
  source TEXT NOT NULL CHECK(source IN ('model', 'user')),
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(profile_version_id) REFERENCES profile_versions(id),
  FOREIGN KEY(resume_document_id) REFERENCES resume_documents(id)
);
CREATE INDEX IF NOT EXISTS idx_matching_cards_active
  ON candidate_matching_cards(profile_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_matching_cards_resume_hash
  ON candidate_matching_cards(profile_id, resume_content_hash, status);
```

`createMatchingCardDraft` 必须在同一 `profileId + resumeContentHash` 已存在 `draft` 或 `confirmed` 卡时返回它，绝不创建第二张卡。`confirmMatchingCard` 在一个 `BEGIN IMMEDIATE` 事务中把该画像已有 `confirmed` 卡设为 `superseded`，再确认目标 `draft`。`saveConfirmedMatchingCardRevision` 不更新旧记录：先 supersede 当前卡，再插入一条 `source='user'` 的 confirmed 卡。

`getCandidateMatchingContext` 必须通过已确认卡的 `profile_version_id` 读取 `profile_versions.profile_json`；不得回退到 `candidate_profiles.profile_json`。`getSearchPlanDependency` 使用该活动版本与 `search_plans.profile_version_id` 比较：存在新草稿而旧卡仍确认时不标 stale；确认新卡后旧计划标 stale；没有确认卡时返回 `matchingCardRequired: true`。

- [ ] **Step 4: 扩展迁移 smoke test。**

更新 `tests/storage_migration_smoke.js`：期望 migration 列表最后一项是 `{ version: 5, name: "candidate_matching_cards_v1" }`；新库和 v1 升级库都存在该表；插入 v4 历史数据后升级仍保留原数据，`PRAGMA quick_check` 为 `ok`。

- [ ] **Step 5: 运行存储与迁移测试。**

Run: `node tests/matching_card_smoke.js; node tests/storage_migration_smoke.js`

Expected: 两条命令均 exit 0，且 `matching_card_smoke ok`、`storage_migration_smoke ok` 出现。

- [ ] **Step 6: 提交这一可独立验证的存储层。**

```powershell
git add src/core/matching_card.js src/core/storage.js tests/matching_card_smoke.js tests/storage_migration_smoke.js
git commit -m "feat: persist confirmed candidate matching cards"
```

### Task 2: 为匹配偏好卡建立受限模型契约

**Files:**

- Modify: `src/core/model_contract.js`
- Modify: `src/core/llm_analyzer.js`
- Modify: `src/core/profile_onboarding.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/adapters/models/mock.js`
- Modify: `tests/profile_quality_smoke.js`
- Modify: `tests/semantic_pipeline_smoke.js`

**Consumes:** `normalizeCandidateProfile` 的事实字段和 Task 1 的 `normalizeMatchingCard`。

**Produces:** `buildCandidateMatchCard` 模型调用；模型卡永远从已解析简历事实生成，不重复发送原始简历正文。

- [ ] **Step 1: 写模型契约失败测试。**

在 `tests/profile_quality_smoke.js` 注入一个 `buildCandidateMatchCard` adapter，断言它收到的是 `candidateProfile` 而不是 `resumeText`，并断言以下输出被规范化：

```js
const card = await buildCandidateMatchCard({ modelConfig, profile: ecommerceProfile });
assert.deepStrictEqual(card.targetDirections, ["电商运营"]);
assert.deepStrictEqual(card.strongEvidence, [{
  label: "店铺活动与 ROI 复盘",
  evidence: "简历：负责淘宝店铺活动和投放 ROI 复盘"
}]);
assert.strictEqual(card.transferableCapabilities[0].limitation, "未证明抖音投流经验");
assert.throws(() => validateModelResult("buildCandidateMatchCard", {
  targetDirections: ["电商运营"], strongEvidence: [{ label: "虚构", evidence: "" }]
}), ModelContractError);
```

- [ ] **Step 2: 运行测试，确认新模型种类尚未被支持。**

Run: `node tests/profile_quality_smoke.js`

Expected: non-zero exit，错误指向 `buildCandidateMatchCard` 为未知模型种类或函数不存在。

- [ ] **Step 3: 实现固定卡契约与两个 adapter。**

在 `validateModelResult` 增加 `buildCandidateMatchCard` 分支，调用 `normalizeMatchingCard`。在 `createLlmAnalyzer` 和导出函数增加同名方法；在 `profile_onboarding.js` 增加：

```js
async function buildCandidateMatchCard({ modelConfig, profile, logger = null }) {
  const analyzer = createLlmAnalyzer({ modelConfig, logger });
  return analyzer.buildCandidateMatchCard({
    candidateProfile: profileForMatchingCard(profile)
  });
}

function profileForMatchingCard(profile = {}) {
  return {
    candidate: profile.candidate || {}, education: profile.education || [],
    experiences: profile.experiences || [], skills: profile.skills || [],
    projects: profile.projects || [], credentials: profile.credentials || [],
    strengths: profile.strengths || []
  };
}
```

OpenAI prompt 必须逐条声明：只能归纳输入事实；强证据要给原事实摘要；相邻平台/行业经历只能写进 `transferableCapabilities` 并标限制；用户没有证据的转向只能进 `cautionTransitions`；不得生成评分、阈值、职业模板或简历不存在的业绩。Mock adapter 只从 `profileHints` / `candidateProfile` 中已有 target titles、experience highlights、skills、projects 产生确定性字段；无法得到可信事实时输出空数组，不默认添加 Python、RAG、Agent 或后端方向。

- [ ] **Step 4: 为 adapter 修复路径增加一次无证据保护。**

在 `tests/semantic_pipeline_smoke.js` 增加一个 invalid-card adapter 输出；确认 `createLlmAnalyzer` 抛出 `MODEL_CONTRACT_INVALID`，且错误不包含完整简历正文、手机号或邮件地址。

- [ ] **Step 5: 运行模型卡与既有画像测试。**

Run: `node tests/profile_quality_smoke.js; node tests/semantic_pipeline_smoke.js`

Expected: 两条 exit 0；既有简历脱敏、事实边界和 `matchJob` 证据校验仍通过。

- [ ] **Step 6: 提交受限的卡生成能力。**

```powershell
git add src/core/model_contract.js src/core/llm_analyzer.js src/core/profile_onboarding.js src/adapters/models/openai_compatible.js src/adapters/models/mock.js tests/profile_quality_smoke.js tests/semantic_pipeline_smoke.js
git commit -m "feat: generate evidence-based matching card drafts"
```

### Task 3: 将上传、确认与扫描统一到活动匹配卡

**Files:**

- Modify: `src/dashboard/server.js`
- Modify: `src/core/plan_validation.js`
- Modify: `src/core/search_plan.js`
- Modify: `src/cli.js`
- Modify: `tests/onboarding_smoke.js`
- Modify: `tests/profile_quality_smoke.js`

**Consumes:** Task 1 的活动上下文和 Task 2 的 `buildCandidateMatchCard`。

**Produces:** `/match-card` 页面、`/api/match-card` 编辑、`/api/match-card/confirm` 确认；扫描、详情补读、重试分析和 workflow 启动统一使用确认版本。

- [ ] **Step 1: 写工作台与 CLI 的失败测试。**

更新 `tests/onboarding_smoke.js` 的首次上传断言：响应必须重定向到 ``/match-card?profileId=${profileId}&cardId=${cardId}``，而不是直接到 `/plan`；卡页面包含目标方向、强证据、可迁移能力、需谨慎转向、保存与确认按钮。未经确认时以测试已生成的 `planId` 运行 `node src/cli.js scan --db ${dbPath} --input data/sample_jobs.json --plan ${planId} --force-mock`，期望失败并包含 `MATCHING_CARD_CONFIRMATION_REQUIRED`。

确认卡后，测试必须：

```js
const confirmed = await fetch(`${baseUrl}/api/match-card/confirm`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ profileId: String(profileId), cardId: String(cardId) }), redirect: "manual"
});
assert.strictEqual(confirmed.status, 303);
assert(confirmed.headers.get("location").startsWith(`/plan?profileId=${profileId}`));
```

再上传完全相同内容，断言不会新增卡或要求确认；上传不同内容，断言新卡为草稿、旧确认卡仍是活动上下文、原计划仍可按旧版本做 `--input` 扫描。确认新卡后，断言旧计划变 stale，必须保存计划后才可继续扫描。

- [ ] **Step 2: 运行工作台 smoke，确认旧流程的重定向断言失败。**

Run: `node tests/onboarding_smoke.js`

Expected: non-zero exit，失败点是首次上传仍重定向 `/plan` 或缺少匹配卡页面；不得启动 Edge 或访问 BOSS。

- [ ] **Step 3: 实现上传与确认状态机。**

在 `handleResumeUpload` 中，在模型解析前比较 `getCandidateProfile(db, profileId)?.sourceHash` 与新 `resume.contentHash`：相同则记录解析尝试并直接跳转到当前已确认卡或计划，绝不新增 `profile_versions`、模型调用或卡确认提示。内容不同则按现有方式保存 profile/document/version，调用 `buildCandidateMatchCard`，再调用 `createMatchingCardDraft`，最后跳转 `/match-card`。仍可生成 Search Plan 建议，但不得把它视为用户确认。

新增 `renderMatchCardPage` 和两个 POST handler：

```js
// 编辑只保存用户输入为新的 card JSON；不确认时 status 维持 draft。
saveMatchingCardDraftEdit(db, { profileId, cardId, card: matchingCardFromForm(params) });

// 确认将旧 confirmed 卡 supersede，并跳到现有 plan 页面。
confirmMatchingCard(db, { profileId, cardId });
redirect(res, `/plan?profileId=${profileId}&planId=${activePlanId || ""}&matchCardConfirmed=1`);
```

页面须显示“当前扫描使用：简历版本名/确认时间”；若有草稿，显示“新简历待确认，不会自动替换当前匹配依据”。`/api/resume-version` 是投递版简历管理，不改变基础候选人画像或活动匹配卡；在页面提示这一语义。

`assertSearchPlanReady` 增加：`dependency.matchingCardRequired` 为真时抛出带 code `MATCHING_CARD_CONFIRMATION_REQUIRED` 的 `appError`。`profileToRuntimeConfigs` 接收第五个可选参数 `matchingCard`，将其挂在 `configs.matchingCard`，并用活动 `candidateProfile` 创建运行时上下文。

所有 `src/dashboard/server.js` 与 `src/cli.js` 中当前使用 `getCandidateProfile(db, plan.profileId).profile` 与 `getSearchPlanDependency(db, plan.id)` 的扫描、workflow、补读、分析重试路径，都改为：

```js
const context = getCandidateMatchingContext(db, plan.profileId);
assertSearchPlanReady(plan, context?.candidateProfile || {}, getSearchPlanDependency(db, plan.id));
const configs = profileToRuntimeConfigs(baseConfigs, context.candidateProfile, plan.plan,
  listCandidateResumeVersions(db, plan.profileId), context.matchingCard);
```

没有上下文时不得回退到 `candidate_profiles.profile_json` 扫描。

- [ ] **Step 4: 运行工作台、计划校验和 CLI fixture 回归。**

Run: `node tests/onboarding_smoke.js; node tests/profile_quality_smoke.js; node tests/dashboard_scan_lifecycle_smoke.js`

Expected: 三条 exit 0；onboarding 测试使用临时端口与 SQLite；计划 stale 只在新卡确认后出现；现有扫描生命周期保护不变。

- [ ] **Step 5: 提交用户确认与活动上下文。**

```powershell
git add src/dashboard/server.js src/core/plan_validation.js src/core/search_plan.js src/cli.js tests/onboarding_smoke.js tests/profile_quality_smoke.js
git commit -m "feat: require confirmed matching card for scans"
```

### Task 4: 用通用 JD 与逐项证据替换技术专用模型判断

**Files:**

- Modify: `src/core/model_contract.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/adapters/models/mock.js`
- Modify: `src/core/job_analysis.js`
- Modify: `src/core/analysis_revision.js`
- Modify: `src/core/search_plan.js`
- Modify: `tests/semantic_pipeline_smoke.js`

**Consumes:** 已确认 `configs.matchingCard`，现有 `candidateProfileForJobMatch` 和 Job facts。

**Produces:** 通用 `JobUnderstanding`、逐项 `requirementMatches`、独立 `jobQuality`、卡修订参与缓存/陈旧性判断。

- [ ] **Step 1: 为通用字段和映射写失败测试。**

在 `tests/semantic_pipeline_smoke.js` 增加注入式 analyzer。断言 `understandJob` 输入仍只有 JD facts（候选人独立缓存），`matchJob` 输入新增 `candidateMatchCard`，且两个模型输出具备上文 Shared Interfaces 的对象字段。断言：

```js
assert.strictEqual(result.requirementMatches[0].state, "transferable");
assert.strictEqual(result.jobQuality.level, "caution");
assert.strictEqual(result.recommendation, "caution");
assert.deepStrictEqual(result.evidence, {
  jd: ["JD：负责抖音店铺投放与复盘"],
  resume: ["简历：负责淘宝店铺投放 ROI 复盘"]
});
```

再断言：`apply` 缺少任何一侧证据会在 contract 层被拒绝；有 `missing` 但并非 `indispensable` 的要求不能放进 `hardBlockers`；`hardBlockers` 仅接受 `eligibility`、`indispensable_core`、`safety` 三种 `kind`，并要求双方证据。

- [ ] **Step 2: 运行语义 smoke，确认当前字符串数组契约无法通过。**

Run: `node tests/semantic_pipeline_smoke.js`

Expected: non-zero exit，错误明确指向缺少 `requirementMatches` 或 `jobQuality`；不能以网络、真实模型或缓存错误结束。

- [ ] **Step 3: 实现通用契约与提示词。**

将 `validateJobUnderstanding` 扩展为对象数组：`coreResponsibilities`、`coreRequirements`、`preferredRequirements`、`outcomeExpectations`；每项均为 `{ label, evidence }`，核心要求额外有 `indispensable` 布尔值。保留 `jobId`、`businessScenario`、`hiddenRisks`、`eligibilityConstraints` 以兼容报告和沟通代码，但删除固定 `realRoleType` 枚举要求。

将 `validateMatchDecision` 扩展为：

```js
requirementMatches: [{
  requirement: text, state: enumState, indispensable: Boolean,
  jdEvidence: text, resumeEvidence: text
}],
jobQuality: {
  level: "normal" | "caution" | "risk",
  concerns: [{ type: text, evidence: text }]
},
hardBlockers: [{ kind, requirement, jdEvidence, resumeEvidence }]
```

验证规则：`apply` 只能在没有 `missing + indispensable`、没有 `jobQuality.level='risk'` 且双侧证据完整时存在；任何 `transferable` 核心项或 `jobQuality.level='caution'` 必须把 `apply` 降为 `caution`；`review` 必须有 `unknown`、待确认问题或缺失信息；`skip` 只接受有双方证据的 structured hard blocker。保留读取历史字符串 blocker 的兼容归一化，仅用于展示历史分析，新的模型输出不得产生字符串 blocker。

改写 OpenAI prompt：JD 先拆“核心工作、核心要求、加分项、成果期望、明确资格、JD 质量关注点、风险信号”，再逐项比对匹配卡与简历。移除“AI/Python/Java/Go/C++/算法/销售运营”的固定分类和专属规则；Python、GMV、CRM、Figma、作品集等仅在 JD 明确为核心或加分时出现。明确告诉模型：多平台、拍摄、剪辑、直播等不相关堆叠要求可标 `responsibility_sprawl`，不能自动判候选人不匹配；工资仅与用户搜索偏好比较，不能凭模型市场猜测变成 hard blocker。

在 `createJobAnalysisRunner` 保持 JD 理解候选人无关的缓存输入；`matchJob` 输入新增 `candidateMatchCard: configs.matchingCard`。`compactAnalysis` 持久化 `coreResponsibilities`、`requirementMatches`、`jobQuality`，并为旧渲染保留 `coreRequirements` 与 `businessScenario` 摘要。把 `PIPELINE_VERSIONS` 升为新的 `understandJob` / `matchJob` 值，并在 `runtimeAnalysisContext`、`buildAnalysisRevision`、`analysisStaleReasons` 增加 `matchingCardVersion` / `matching_card_changed`。

Mock adapter 对没有完整语义的输入返回 `review` 与明确 `unknown`，而不是把每个岗位报为 Python/RAG `apply`；fixture 内的显式电商/技术证据可产生确定性结构输出。

- [ ] **Step 4: 运行契约、缓存和技术岗回归。**

Run: `node tests/semantic_pipeline_smoke.js; node tests/profile_quality_smoke.js`

Expected: 两条 exit 0；同一 JD 的 `understandJob` 仍可跨候选人缓存；卡修订变化只使 `matchJob` 分析陈旧；历史证据保护保持。

- [ ] **Step 5: 提交通用语义契约。**

```powershell
git add src/core/model_contract.js src/adapters/models/openai_compatible.js src/adapters/models/mock.js src/core/job_analysis.js src/core/analysis_revision.js src/core/search_plan.js tests/semantic_pipeline_smoke.js
git commit -m "feat: match jobs with generic evidence contracts"
```

### Task 5: 收窄本地规则为跨职业保护，并按岗位质量分桶

**Files:**

- Modify: `src/core/scoring.js`
- Modify: `src/core/match_explainer.js`
- Modify: `src/core/job_analysis.js`
- Modify: `src/core/storage.js`
- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `tests/screening_quality_smoke.js`

**Consumes:** Task 4 的 structured hard blockers、`requirementMatches` 和 `jobQuality`。

**Produces:** 本地层不再假定技术岗位才是默认岗位；`primary` / `talk` / `not_recommended` 只依据通用门槛、证据、岗位质量和安全风险分桶。

- [ ] **Step 1: 写本地规则失败测试。**

在 `tests/semantic_pipeline_smoke.js` 通过 `createJobAnalysisRunner(configs, [], { db, analyzer })` 注入三份完整 `MatchDecision`，不要测试私有函数。三个样本的固定输入/预期为：

1. 一个 `indispensable: true` 核心项状态为 `transferable`、`jobQuality.level="normal"`、模型初始建议为 `apply`；runner 最终必须输出 `caution`。
2. 所有核心项为 `matched`、`jobQuality.level="caution"`，其中 concern 为 `{ type: "responsibility_sprawl", evidence: "JD 同时要求直播、拍摄、剪辑" }`、模型初始建议为 `apply`；runner 最终必须输出 `caution`。
3. 所有核心项为 `matched`、`jobQuality.level="normal"`、双方证据非空、置信度 `0.9`、模型建议为 `apply`；`decisionBucket({ analysis, qualityTags: [] })` 必须为 `primary`。

每个样本的 JD 设 `detailRead: true`、不同 `sourceId`，并在 `requirementMatches[0]` 中提供 `jdEvidence` 与 `resumeEvidence`，确保失败原因只能来自本地守卫而不是完整 JD 或证据前置条件。

在 `tests/screening_quality_smoke.js` 断言：标题含“运营”“产品”“设计”不再产生 `role_mismatch`；用户未选择实习时，实习岗位仍是通用 `internship_role` 硬边界；地点、链接、活跃状态、用户硬排除和薪资底线仍保持原状态机。

- [ ] **Step 2: 运行测试，确认现有技术专属 local scorer 误拦运营样本。**

Run: `node tests/semantic_pipeline_smoke.js; node tests/screening_quality_smoke.js`

Expected: non-zero exit，至少一个断言显示运营标题仍得到 `role_mismatch` 或技术专属风险标签。

- [ ] **Step 3: 最小化本地评分与保护逻辑。**

在 `scoreJob` 删除将非技术岗、算法岗、Java/Spring、C++/Go、RAG/知识库、实施/售前视作全局默认风险或 blockade 的分支；删除 `role_mismatch`、`algorithm_role`、`core_stack_mismatch`、`java_backend_heavy`、`senior_engineering_heavy` 对 `decisionState` 的技术默认影响。保留并覆盖测试：城市/链接/活跃状态、用户 `hardExcludes`、工作性质、用户薪资底线、经验范围和作息信息。`match_explainer` 的 rule-only 输出只给基础边界与“需启用语义模型”的 `review`，不再默认询问 FastAPI 或 RAG。

`applyRuleGuard` 统一按以下顺序执行：

```js
if (decisionState(job) === "blocked") return hardBoundarySkip(analysis);
if (sourceNeedsRefresh(job) || analysis.semanticStatus !== "complete") return review(analysis);
if (hasStructuredHardBlocker(analysis)) return skip(analysis);
if (missingEitherSideEvidence(analysis)) return review(analysis);
if (hasTransferableCore(analysis) || analysis.jobQuality.level === "caution") return caution(analysis);
if (analysis.jobQuality.level === "risk") return safetySkipOrReview(analysis);
return analysis;
```

`decisionBucket` 删除 `implementation_presales` 特判。`apply` 只有在双侧证据、`jobQuality.level='normal'`、置信度达标且无通用风险时进入 `primary`；`caution` 和 `review` 进入 `talk`；structured hard blocker 与已有安全 risk 进入 `not_recommended`。职责膨胀只会令 `apply` 变 `caution`，不会造成 `skip`。

- [ ] **Step 4: 运行本地边界、语义和存储分桶回归。**

Run: `node tests/screening_quality_smoke.js; node tests/semantic_pipeline_smoke.js; node tests/workflow_dashboard_smoke.js`

Expected: 三条 exit 0；运营岗位可进入语义分析；现有 workflow 仍不把无证据或硬边界岗位放进默认沟通清单。

- [ ] **Step 5: 提交通用本地保护。**

```powershell
git add src/core/scoring.js src/core/match_explainer.js src/core/job_analysis.js src/core/storage.js tests/semantic_pipeline_smoke.js tests/screening_quality_smoke.js
git commit -m "refactor: make local matching guards occupation-neutral"
```

### Task 6: 用运营 fixture 验收通用内核，并回归技术边界

**Files:**

- Create: `tests/fixtures/generic_evidence_matching.json`
- Create: `tests/generic_evidence_matching_smoke.js`
- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `tests/job_match_benchmark.js`

**Consumes:** Task 4/5 的注入式 analyzer 与规则保护。

**Produces:** 不依赖网络、可重复执行的多职业验收集；技术特例不再作为默认代码路径，但明确核心能力缺失仍受保护。

- [ ] **Step 1: 写 fixture 与失败断言。**

`tests/fixtures/generic_evidence_matching.json` 必须包含以下六项，每项放候选人事实、匹配卡、完整 JD、假模型 `JobUnderstanding`、假模型 `MatchDecision` 和唯一预期：

| id | 场景 | 预期 |
|---|---|---|
| `ecommerce-core-match` | 淘宝店铺、ROI、活动复盘对电商核心职责 | `apply`，`jobQuality.normal` |
| `ecommerce-wishlist-sprawl` | 同一候选人面对天猫/抖音/直播/拍摄/剪辑大而全 JD | `caution`，`responsibility_sprawl`，不是 `skip` |
| `content-to-user-transfer` | 内容/新媒体经历转用户运营 | `caution`，至少一项 `transferable` |
| `user-ops-vs-pure-sales` | 用户运营经历，JD 主线为纯销售 | 有双方证据的 `skip` |
| `insufficient-evidence` | JD 或简历不足 | `review`，不产生虚构理由 |
| `java-core-missing` | Python 简历面对明确唯一 Java/Spring 核心岗 | `skip`，structured `indispensable_core` |

测试 runner 只创建 `createJobAnalysisRunner(configs, [], { db, analyzer })` 的注入式 analyzer。每个样本断言 recommendation、jobQuality、每条 evidence 的非空性，以及 `decisionBucket`。不得创建 Browser、调用 `fetch` 或读取项目 `data/jobs.sqlite`。

- [ ] **Step 2: 运行测试，确认 fixture runner 尚不存在。**

Run: `node tests/generic_evidence_matching_smoke.js`

Expected: non-zero exit，`Cannot find module` 或测试文件不存在。

- [ ] **Step 3: 实现 fixture runner，并扩展基准元数据校验。**

`generic_evidence_matching_smoke.js` 要在 `finally` 中关闭临时 `:memory:` SQLite；每个 fixture 使用唯一 `sourceId`；断言 `apply/caution/skip` 均有 `analysis.evidence.jd[0]` 和 `analysis.evidence.resume[0]`，`review` 明确带 `unknown` 或待确认理由。

在 `tests/job_match_benchmark.js` 的 fixture 校验加入：每个未来非技术样本也必须有 `category` 与人工 `rationale`，但不让无 `--live` 的离线命令调用真实模型。保留既有技术 benchmark 的原有最小数量和唯一 ID 检查。

- [ ] **Step 4: 运行验收集及针对性回归。**

Run: `node tests/generic_evidence_matching_smoke.js; node tests/semantic_pipeline_smoke.js; node tests/job_match_benchmark.js`

Expected: 三条 exit 0；第一条打印六个样本均通过；最后一条在无 `--live` 下只校验 fixture，不访问模型网络。

- [ ] **Step 5: 提交验收样本。**

```powershell
git add tests/fixtures/generic_evidence_matching.json tests/generic_evidence_matching_smoke.js tests/semantic_pipeline_smoke.js tests/job_match_benchmark.js
git commit -m "test: cover generic evidence matching scenarios"
```

### Task 7: 更新用户说明并做全量相关验证

**Files:**

- Modify: `docs/product_spec.md`
- Modify: `docs/daily_workflow.md`
- Modify: `tests/run_all.js`

**Consumes:** Tasks 1–6 的已提交接口和 smoke test。

**Produces:** 文档与测试总入口准确描述“确认卡后扫描”“岗位质量不等于候选人不匹配”“无真实 BOSS 测试”。

- [ ] **Step 1: 先写文档/总入口的失败检查。**

在 `tests/run_all.js` 将 `tests/matching_card_smoke.js` 与 `tests/generic_evidence_matching_smoke.js` 加入本地 smoke 列表。增加一个小型 Node 断言（可放在两项测试之一）读取两份文档并要求含有“匹配偏好卡”“谨慎投递”“岗位质量”“不访问真实 BOSS”四个文案，避免文档与功能脱节。

- [ ] **Step 2: 运行总入口，确认它尚未运行新测试或缺少文案。**

Run: `node tests/run_all.js`

Expected: non-zero exit，错误显示新 smoke 未登记或文档关键说明缺失。若已有与本次无关的既知失败，先记录其命令、失败文件和原始错误；不得通过删减测试掩盖它。

- [ ] **Step 3: 更新产品与日常流程说明。**

在 `docs/product_spec.md` 增加三段：卡从简历事实生成、同内容不重复确认、不同内容先草稿后切换；四档建议的定义；岗位质量风险与人岗匹配独立。明确“职责膨胀/愿望清单通常是谨慎投递，而非候选人不匹配”。

在 `docs/daily_workflow.md` 的扫描前检查中增加：确认当前活动匹配卡、核对简历版本、草稿卡确认后重新保存受影响 Search Plan。注明开发验证始终使用 fixture/测试库，不需要真实 BOSS 页面。

- [ ] **Step 4: 运行全量相关测试并保存原始结论。**

Run:

```powershell
node tests/matching_card_smoke.js
node tests/storage_migration_smoke.js
node tests/profile_quality_smoke.js
node tests/onboarding_smoke.js
node tests/screening_quality_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/job_match_benchmark.js
node tests/run_all.js
```

Expected: 每条针对性命令 exit 0；`tests/run_all.js` 也应 exit 0。若总入口存在实施前已知且无关的失败，报告原始错误、保持测试登记，不宣称全量通过，且不得修改无关脚本来使其变绿。

- [ ] **Step 5: 检查改动范围并提交文档与测试入口。**

```powershell
git diff --check
git status --short
git add docs/product_spec.md docs/daily_workflow.md tests/run_all.js
git commit -m "docs: explain confirmed evidence matching workflow"
```

## Final Verification Checklist

- [ ] 新库与 v4 历史库均可迁移到 v5，`PRAGMA quick_check` 为 `ok`。
- [ ] 首次扫描没有已确认卡时被拒绝；同内容简历不重复确认；新内容草稿不悄悄改变活动画像；确认新卡后旧计划变 stale。
- [ ] 工作台、CLI 扫描、补读、工作流与模型重试都使用 `getCandidateMatchingContext`，没有回退到未经确认的当前画像。
- [ ] 模型卡、JD 理解、匹配结论都只有固定字段，且 `apply/caution/skip` 有双侧证据。
- [ ] JD 愿望清单与职责膨胀会标岗位质量风险，不会仅因缺少附加项跳过候选人。
- [ ] 运营三方向与技术核心缺口 fixture 均按预期通过。
- [ ] 未访问真实 BOSS、未启动 8787、未读写主项目数据库。
