# LLM 分析契约

## 调用分工

模型只有五类逻辑调用：

1. `analyzeResume`：简历文本 -> `CandidateProfile`。
2. `recommendSearchPlan`：画像 -> 初始 `SearchPlan`；城市不从空信息猜测。
3. `understandJob`：岗位来源内容 -> `JobUnderstanding`，不接收候选人匹配结论。
4. `matchJob`：画像、简历版本、岗位理解和完整 JD -> `MatchDecision`。
5. `draftCommunication`：用户主动点击后 -> `CommunicationDraft`。

扫描链路只调用 3 和 4。它不会重复解析简历，也不会批量调用 5。

## CandidateProfile

```json
{
  "candidate": {
    "name": "候选人",
    "city": "",
    "targetTitles": ["AI应用开发"],
    "expectedSalary": "10-20K",
    "adjustableSalary": []
  },
  "education": [],
  "experiences": [],
  "skills": [{ "name": "Python", "level": "resume", "evidence": [] }],
  "projects": [],
  "credentials": [],
  "strengths": [],
  "resumeVersions": []
}
```

画像不得包含模型猜测的 GAP、离职原因、到岗时间或短期项目口径。解析阶段不返回简历点评和非筛选必要追问。
`resumeVersions` 在画像解析结果中固定为空；真实简历版本由用户上传的文件创建并保留原文件、解析结果和版本元数据。

## SearchPlan

```json
{
  "directions": ["AI应用开发"],
  "keywords": [
    { "word": "RAG工程师", "priority": "A", "reason": "与项目证据直接对应" }
  ],
  "cities": [],
  "salary": { "minK": 10, "maxK": 20 },
  "experience": ["经验不限", "1-3年", "3-5年（可冲）"],
  "jobTypes": ["全职"],
  "allowExperienceStretch": true
}
```

关键词优先级只允许 A/B/C。模型推荐只是草稿，用户保存后的方案才可扫描。城市为空时 UI 必须要求用户选择。

## JobUnderstanding

```json
{
  "jobId": "boss:job-id",
  "realRoleType": "ai_application",
  "businessScenario": "企业知识库与智能客服",
  "coreRequirements": ["RAG 应用开发"],
  "coreStack": ["Python", "FastAPI"],
  "niceToHave": ["LangGraph"],
  "senioritySignal": "junior_mid",
  "eligibilityConstraints": [],
  "hiddenRisks": [
    { "type": "work_schedule_unknown", "severity": "low", "evidence": "JD 未说明工作制" }
  ],
  "isFakeAI": false,
  "isTrainingOrSales": false,
  "evidenceSnippets": ["负责企业知识库 RAG 链路开发"]
}
```

要求：

- 必须基于岗位完整内容识别真实角色，不因标题或搜索词直接判定。
- `coreStack` 是岗位实现主栈；若 JD 明确以 C++/Golang/Java 为主，必须如实输出。
- 风险必须带严重度和 JD 证据。
- 卡片信息不完整时可以输出初步理解，但后续状态只能是 partial/review。

## MatchDecision

```json
{
  "recommendation": "apply",
  "fitLevel": "A",
  "confidence": 0.86,
  "fitReasons": ["KnowledgeFlow 的 LangGraph 并行工作流对应岗位 Agent 编排要求"],
  "missingPoints": [],
  "blockingGaps": [],
  "riskQuestions": ["团队是否双休"],
  "recommendedResumeVersion": "ai_rag_agent",
  "primaryProjects": ["KnowledgeFlow"],
  "greetingAngle": "围绕 LangGraph 与质量闭环切入",
  "evidence": {
    "jd": ["使用 LangGraph 构建多 Agent 工作流"],
    "resume": ["使用 StateGraph、Send 并行 fan-out"]
  },
  "hrPrep": {}
}
```

契约守卫：

- `recommendation` 只允许 `apply/caution/review/skip`。
- `confidence` 必须为 0–1 数字。
- `apply` 只能是 A/B，且必须有具体理由、JD 证据和简历证据。
- `caution` 同样必须有双证据。
- 明确核心技术栈、资格、届别等阻断缺口放入 `blockingGaps`，并强制 `skip`。
- 中高风险、经验可冲或实施售前职责偏移不能保持 `apply`。
- 置信度低于守卫阈值进入人工复核。

## CommunicationDraft

```json
{
  "kind": "greeting",
  "jobId": "boss:job-id",
  "messages": ["您好，我在 KnowledgeFlow 中……"],
  "missingFact": null,
  "evidence": {
    "jd": ["岗位具体要求"],
    "resume": ["候选人具体项目证据"]
  },
  "tone": "自然、稳健、不夸大"
}
```

`kind` 只允许 `greeting/hr_reply/follow_up`，文案最多 2 条。招呼语和跟进必须有 JD 与简历双证据。

缺少敏感事实时返回：

```json
{
  "kind": "hr_reply",
  "messages": [],
  "missingFact": {
    "key": "gap",
    "question": "这段 GAP 期间你实际在做什么？"
  },
  "evidence": { "jd": [], "resume": [] },
  "tone": "自然、稳健、不夸大"
}
```

`missingFact` 与 `messages` 不能同时存在。用户回答以 `user_provided` 保存后才重新生成。

## 失败、修复和缓存

- 所有调用必须返回 JSON 对象并通过本地契约校验。
- 结构不合格时允许一次明确的契约修复调用；仍失败则记录错误并进入待语义分析。
- 缓存键包含调用种类、提供商、模型、契约版本和标准化输入哈希。
- 缓存命中后仍重新执行当前契约校验；旧契约结果不能直接复用。
- 岗位内容、画像、简历版本或分析版本变化时缓存自然失效。

## 模型适配器与隐私

真实适配器使用 OpenAI-compatible `/chat/completions`，支持 JSON mode；不支持时自动回退普通 JSON 提示。仅对短暂 5xx/网络错误做有限重试，不对鉴权、余额和模型名错误盲目重试。

每个逻辑调用记录：kind、provider、model、缓存命中、延迟、尝试次数、HTTP 状态和 token 用量。日志不得包含 system prompt、输入、输出、简历、JD 或 Key。
