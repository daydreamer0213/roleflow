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
  "kind": "hr_reply",
  "jobId": "boss:job-id",
  "messages": ["您好，我在 KnowledgeFlow 中……"],
  "missingFact": null,
  "messageCategory": "project_fact",
  "progressUpdate": {
    "stage": "reply_ready",
    "nextAction": "复制草稿并手动发送",
    "summary": "项目事实确认"
  },
  "evidence": {
    "jd": ["岗位具体要求"],
    "resume": ["候选人具体项目证据"]
  },
  "tone": "自然、稳健、不夸大"
}
```

`kind` 只允许 `greeting/hr_reply/follow_up`，文案最多 2 条。`messageCategory` 只允许 `project_fact/qualification/salary/availability/interview_invitation/other/identity_uncertain`。`progressUpdate` 必须包含合法进展阶段、下一步和固定短摘要；摘要不得复制 HR 原话或回复正文。招呼语和跟进必须有 JD 与简历双证据。

缺少敏感事实时返回：

```json
{
  "kind": "hr_reply",
  "messages": [],
  "missingFact": {
    "key": "gap",
    "question": "这段 GAP 期间你实际在做什么？"
  },
  "messageCategory": "other",
  "progressUpdate": {
    "stage": "needs_user_action",
    "nextAction": "请用户确认 GAP 事实",
    "summary": "需要补充用户确认事实"
  },
  "evidence": { "jd": [], "resume": [] },
  "tone": "自然、稳健、不夸大"
}
```

`missingFact` 与 `messages` 不能同时存在。用户回答以 `user_provided` 保存后才重新生成。

面试邀约必须返回 `messageCategory=interview_invitation`、`messages=[]`、`missingFact=null` 和 `progressUpdate.stage=interview_invited`。模型不得生成“先确认安排”、接受、推迟或改期建议。岗位或线程不确定时同样返回空 `messages`，并停在 `needs_user_action`。

## 失败、修复和缓存

- 所有调用必须返回 JSON 对象并通过本地契约校验。
- 结构不合格时允许一次明确的契约修复调用；仍失败则记录错误并进入待语义分析。
- 缓存键包含调用种类、提供商、模型、契约版本和标准化输入哈希。
- 缓存命中后仍重新执行当前契约校验；旧契约结果不能直接复用。
- 岗位内容、画像、简历版本或分析版本变化时缓存自然失效。

## 模型适配器与隐私

真实适配器使用 OpenAI-compatible `/chat/completions`，支持 JSON mode；不支持时自动回退普通 JSON 提示。仅对短暂 5xx/网络错误做有限重试，不对鉴权、余额和模型名错误盲目重试。

每个逻辑调用记录：kind、provider、model、缓存命中、延迟、尝试次数、HTTP 状态和 token 用量。日志不得包含 system prompt、输入、输出、简历、JD、HR 消息、回复草稿或 Key。用户粘贴的消息只存在于当前请求，不写入模型缓存、进展事件或隐藏字段。

## 后台只读消息发现的 `draftCommunication`

消息发现只有在用户从 `/messages?profileId=<个人资料 ID>` 主动启动、且页面已可靠关联唯一 `profile + job + thread` 后，才可调用 `draftCommunication({ mode: "hr_reply" })`。HR 消息正文只存在于本次调用的局部内存中，调用后立即释放；不得进入模型缓存、日志、数据库、状态 API、进度事件或页面字段。

返回的 `CommunicationDraft` 继续受现有契约约束：有已确认事实时 `messages` 最多两条；缺失事实时必须为 `messages=[]` 且阶段为 `needs_user_action`；身份或关联不可靠时不得调用模型，同样进入 `needs_user_action`。`messageCategory=interview_invitation` 必须为 `messages=[]`、`missingFact=null`、`progressUpdate.stage=interview_invited`，只提醒用户自行决定，不能产生确认、接受、改期、安排或日历操作建议。

模型输出的草稿只用于本地页面的内存展示与人工复制，不是 BOSS 操作指令。RoleFlow 不自动填写、聚焦或发送 BOSS 输入框；用户在 BOSS 手动发送后，才可在本地页面点击“已手动发送”。草稿在放弃、下一轮发现开始、30 分钟到期或服务重启时清除。不得保存 HR 原话、回复正文、完整聊天、截图、Cookie、localStorage 或敏感 URL。