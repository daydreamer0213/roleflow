# LLM 分析契约

本文定义未来接入 OpenAI / DeepSeek / 通义 / 本地模型时的输入输出结构。当前阶段可以用 mock/rule 实现，但字段必须按这里保留。

## 设计原则

- LLM 负责语义理解，规则负责硬筛。
- LLM 输出必须是 JSON，不直接写入最终报告正文。
- 每个重要结论尽量带 evidence。
- 对外口径必须稳健，不允许夸大经历。
- 模型结果要缓存，避免同一个 JD 重复分析。

## CandidateProfile

```json
{
  "candidate": {
    "name": "示例候选人",
    "city": "广州",
    "targetTitles": ["AI应用开发工程师", "Python后端", "RAG工程师", "Agent工程师"],
    "expectedSalary": "9-14K",
    "adjustableSalary": ["8-12K", "9-13K"]
  },
  "skills": [
    {
      "name": "RAG",
      "level": "project",
      "evidence": ["DocMind", "KnowledgeFlow"]
    }
  ],
  "projects": [
    {
      "name": "DocMind",
      "roleBoundary": "参与开发与优化，不宣称独立搭建完整系统",
      "canSay": ["RAG问答检索链路", "Self-Reflection", "长期记忆", "降级策略"],
      "avoidSaying": ["全权负责", "主导完整架构"]
    }
  ],
  "riskMessaging": {
    "gap": "职业方向探索 + 看好 AI 方向 + 系统自学入行",
    "shortProject": "短期技术协作/原型验证项目，不主动说正式入职"
  }
}
```

## ResumeVersion

```json
{
  "id": "ai_rag_agent",
  "name": "AI / RAG / Agent 版本",
  "targetRoles": ["AI应用开发", "RAG工程师", "Agent工程师"],
  "primaryProjects": ["DocMind", "KnowledgeFlow"],
  "sellingPoints": ["企业级RAG协作经验", "LangGraph多Agent独立项目"],
  "riskNotes": ["不要过度包装德勤实习职责"]
}
```

## JobUnderstanding

```json
{
  "jobId": "boss:xxx",
  "realRoleType": "ai_application",
  "businessScenario": "企业知识库/智能问答",
  "coreRequirements": ["Python", "RAG", "FastAPI"],
  "niceToHave": ["LangChain", "向量数据库"],
  "senioritySignal": "junior_mid",
  "hiddenRisks": [
    {
      "type": "outsourcing",
      "severity": "medium",
      "evidence": "长期驻场/项目外派描述"
    }
  ],
  "isFakeAI": false,
  "isTrainingOrSales": false,
  "evidenceSnippets": ["负责知识库问答系统开发"]
}
```

## MatchDecision

```json
{
  "recommendation": "apply",
  "fitLevel": "A",
  "confidence": 0.82,
  "fitReasons": [
    "JD 提到 RAG/知识库，能对应 DocMind 和 KnowledgeFlow",
    "薪资与初中级 AI 应用岗位匹配"
  ],
  "missingPoints": [
    "JD 提到生产级高并发经验，需要面试前确认深度要求"
  ],
  "riskQuestions": [
    "是否外包驻场",
    "是否真实开发岗而非实施/培训"
  ],
  "recommendedResumeVersion": "ai_rag_agent",
  "primaryProjects": ["DocMind", "KnowledgeFlow"],
  "greetingAngle": "从 Python + RAG/Agent 应用经验切入，主推 DocMind 和 KnowledgeFlow",
  "hrPrep": {
    "gap": "可按标准 GAP 口径回答",
    "salary": "可报 9-13K，视岗位空间调整"
  }
}
```

## CommunicationDraft

```json
{
  "jobId": "boss:xxx",
  "greeting": "您好，我主要做 Python + RAG/Agent 应用方向...",
  "hrReplies": {
    "gap": "这一年主要是在做职业方向收敛和 AI 应用方向的系统学习...",
    "salary": "我目前期望在 9-14K，具体也会结合岗位职责和团队情况沟通。",
    "arrival": "可以尽快到岗，具体按公司流程配合。"
  },
  "tone": "自然、稳健、不过度包装"
}
```

## Adapter 接口

```js
async function analyzeResume({ resumeText, profileHints }) {
  return CandidateProfile;
}

async function recommendSearchPlan({ candidateProfile }) {
  return SearchPlan;
}

async function understandJob({ job, candidateProfile }) {
  return JobUnderstanding;
}

async function matchJob({ candidateProfile, resumeVersions, jobUnderstanding }) {
  return MatchDecision;
}

async function draftCommunication({ candidateProfile, jobUnderstanding, matchDecision }) {
  return CommunicationDraft;
}
```

## 模型接入顺序

1. mock adapter：离线测试和字段稳定。
2. one real adapter：优先接一个真实模型，验证 JSON 输出。
3. multi-provider：OpenAI / DeepSeek / 通义配置切换。
4. cache：按 resume hash + JD hash 缓存结果。
5. review mode：低置信度结果进入人工复核。

## SearchPlan

```json
{
  "name": "广州 AI 应用开发筛选计划",
  "cities": ["广州"],
  "bossCityCode": "101280100",
  "salary": {"minK": 9, "maxK": 14},
  "experience": ["经验不限", "0-3年", "1-3年"],
  "allowExperienceStretch": true,
  "bossActiveDays": 3,
  "directions": ["AI应用开发", "RAG"],
  "keywords": [{"word": "RAG工程师", "priority": "A", "reason": "项目证据充分"}],
  "excludeWords": ["销售", "培训"],
  "hardExcludes": ["培训贷"],
  "scan": {"maxCards": 80, "detailLimit": 8, "maxDetailTotal": 180}
}
```

模型只生成初始建议。用户在页面确认后的 SearchPlan 才会作为扫描、排序和报告的输入。
