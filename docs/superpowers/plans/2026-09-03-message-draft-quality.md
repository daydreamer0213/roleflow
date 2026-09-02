# Message Draft Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 HR 回复和无回复跟进草稿第一次展示前减少近期重复表达，并阻止模型生成没有候选人依据的高风险个人事实。

**Architecture:** 新增无依赖纯函数完成字符相似度和结构化事实检查，再用一个小型生成编排器统一“生成、检查、最多修正一次”。消息发现和跟进服务传入各自的模型回调；用户编辑仍是权威确认，只有未编辑的模型草稿会在发送冻结前按当前有效事实复查。

**Tech Stack:** Node.js 22.5+、CommonJS、现有模型适配器、现有消息学习 SQLite 表。

## Global Constraints

- 最近窗口固定为 20 条已复制或已发送消息，不使用 30/50/70 求职体检阈值。
- 只检查会进入 RoleFlow 自动填写发送链路的 HR 回复与跟进草稿。
- 每次生成最多增加一次模型修正调用。
- 重复表达仅提醒，不阻止发送；事实无依据会阻止未编辑模型草稿进入发送状态。
- 用户亲自编辑后的当前文字就是确认输入，不增加二次确认或发送前问答。
- 允许依据只来自当前启用简历、当前候选人事实和适用的有效用户回答；JD 不能证明候选人事实。
- 不增加向量数据库、嵌入模型、分词依赖或后台改写任务。

---

### Task 1: 本地重复和结构化事实检查

**Files:**
- Create: `src/core/message_draft_quality.js`
- Create: `tests/message_draft_quality_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces: `assessMessageDraftQuality({ text, recentTexts, evidenceTexts }) -> { valid, errors, warnings, matchedOpening }`.
- Produces: `normalizedMessageText(text) -> string`.
- Produces: `extractHighRiskClaims(text) -> Array<{ kind, value }>`.

- [x] **Step 1: Write failing pure-function tests**

```js
const repeated = assessMessageDraftQuality({
  text: "您好，我对贵司的内容运营岗位很感兴趣，期待沟通。",
  recentTexts: ["您好，我对贵司的用户运营岗位很感兴趣，期待沟通。"],
  evidenceTexts: []
});
assert.equal(repeated.valid, true);
assert.equal(repeated.warnings[0].code, "MESSAGE_DRAFT_RECENTLY_SIMILAR");

const invented = assessMessageDraftQuality({
  text: "我可以本周三到岗，期望薪资 25K，手机号 13800138000。",
  recentTexts: [],
  evidenceTexts: ["用户可在两周后到岗"]
});
assert.equal(invented.valid, false);
assert.deepEqual(invented.errors.map((item) => item.kind).sort(), ["arrival", "phone", "salary"]);
```

Add positive cases where exact evidence supports phone, email, URL, availability, salary, year/month duration, percentage and numeric achievement. Add whitespace folding, punctuation-only differences, short generic phrases and unrelated messages.

- [x] **Step 2: Run the test and verify RED**

Run: `node tests/message_draft_quality_smoke.js`

Expected: FAIL because `src/core/message_draft_quality.js` does not exist.

- [x] **Step 3: Implement deterministic normalization and similarity**

Normalize Unicode width, lowercase Latin text, fold whitespace and remove decorative punctuation. Compare:

- the first 18 normalized Han/letter/digit characters; exact same opening of at least 8 characters is a warning;
- character trigrams for normalized texts of at least 16 characters; Jaccard similarity at or above `0.72` is a warning.

Keep thresholds as named constants and export them for fixture assertions. Do not warn on generic openings shorter than 8 normalized characters.

- [x] **Step 4: Implement high-risk claim extraction**

Use bounded regular expressions for:

```js
const CLAIM_PATTERNS = Object.freeze({
  phone: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  email: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  url: /https?:\/\/[^\s，。；]+/gi,
  salary: /(?:期望|薪资|月薪|年薪)[^，。；\n]{0,12}(?:\d+(?:\.\d+)?\s*[KkWw万千]?)/g,
  percentage: /\d+(?:\.\d+)?%/g,
  duration: /\d+(?:\.\d+)?\s*(?:年|个月|月|天)/g
});
```

Add explicit preference phrases for arrival/interview availability, overtime, travel and relocation. A claim is supported only when its normalized token or the same explicit preference is present in at least one evidence text.

- [x] **Step 5: Run the test and commit**

Run: `node tests/message_draft_quality_smoke.js`

Expected: `message_draft_quality_smoke ok`.

```powershell
git add src/core/message_draft_quality.js tests/message_draft_quality_smoke.js tests/run_all.js
git commit -m "feat: assess generated message draft quality"
```

### Task 2: 有界的质量修正编排器

**Files:**
- Create: `src/application/message_draft_quality/index.js`
- Create: `tests/message_draft_quality_service_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: `assessMessageDraftQuality()`.
- Produces: async `generateQualityCheckedDraft({ generate, input, recentTexts, evidenceTexts }) -> { result, assessment, attempts }`.

- [x] **Step 1: Write the failing orchestration test**

```js
const calls = [];
const output = await generateQualityCheckedDraft({
  generate: async (input) => {
    calls.push(input);
    return calls.length === 1
      ? { messages: ["您好，我对贵司岗位很感兴趣，期待沟通。"] }
      : { messages: ["您好，想结合岗位职责进一步了解团队目前的重点。"] };
  },
  input: { messageIntent: "follow_up" },
  recentTexts: ["您好，我对贵司岗位很感兴趣，期待沟通。"],
  evidenceTexts: []
});
assert.equal(output.attempts, 2);
assert.equal(calls[1].draftQualityRevision.reasonCodes[0], "MESSAGE_DRAFT_RECENTLY_SIMILAR");
```

Add cases for unsupported facts, second result still similar, second result still fact-invalid, generator failure on the second call, zero messages and two alternatives where only one is invalid.

- [x] **Step 2: Run the test and verify RED**

Run: `node tests/message_draft_quality_service_smoke.js`

Expected: FAIL because the orchestration service is absent.

- [x] **Step 3: Implement exactly two bounded attempts**

```js
const first = await generate(input);
const firstAssessment = assessResult(first, recentTexts, evidenceTexts);
if (!needsRevision(firstAssessment)) return result(first, firstAssessment, 1);
try {
  const second = await generate({
    ...input,
    draftQualityRevision: revisionInput(firstAssessment)
  });
  return result(second, assessResult(second, recentTexts, evidenceTexts), 2);
} catch (error) {
  return result(first, firstAssessment, 1, error);
}
```

If the second call fails, preserve the first result and its invalid assessment. If any message has unsupported facts, `sendable` is false. Similarity alone keeps `sendable` true.

- [x] **Step 4: Run the service test and commit**

Run: `node tests/message_draft_quality_service_smoke.js`

Expected: `message_draft_quality_service_smoke ok`.

```powershell
git add src/application/message_draft_quality/index.js tests/message_draft_quality_service_smoke.js tests/run_all.js
git commit -m "feat: revise message drafts once for quality"
```

### Task 3: 模型契约接受明确修正请求

**Files:**
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/adapters/models/mock.js`
- Modify: `tests/model_adapter_smoke.js`
- Modify: `tests/message_reply_contract_smoke.js`

**Interfaces:**
- Consumes: optional `input.draftQualityRevision = { reasonCodes, matchedOpening, unsupportedClaims }`.
- Produces: the existing `classifyMessageGroup` and `draftCommunication` result shapes without new required output fields.

- [x] **Step 1: Write failing prompt and mock tests**

```js
await adapter.draftCommunication({
  mode: "follow_up",
  draftQualityRevision: {
    reasonCodes: ["MESSAGE_DRAFT_FACT_UNSUPPORTED"],
    matchedOpening: "",
    unsupportedClaims: [{ kind: "salary", value: "25K" }]
  }
});
assert.match(capturedPrompt, /删除没有依据的薪资事实/);
```

Assert the raw error values are converted to bounded Chinese instructions and arbitrary user-provided instruction strings are never interpolated into the system prompt.

- [x] **Step 2: Run tests and verify RED**

Run: `node tests/model_adapter_smoke.js && node tests/message_reply_contract_smoke.js`

Expected: FAIL because the adapters ignore `draftQualityRevision`.

- [x] **Step 3: Add bounded revision instructions**

Map known reason codes in code:

```js
const QUALITY_REVISION_INSTRUCTIONS = Object.freeze({
  MESSAGE_DRAFT_RECENTLY_SIMILAR: "改写开头和句式，保留事实与语气，不复用近期表达。",
  MESSAGE_DRAFT_FACT_UNSUPPORTED: "删除没有候选人依据的个人事实，不用模糊措辞替代。"
});
```

Pass at most four unsupported `{ kind, value }` entries as JSON data, each value truncated to 80 characters. Do not add a third model call or change the output contract.

- [x] **Step 4: Run adapter tests and commit**

Run: `node tests/model_adapter_smoke.js && node tests/message_reply_contract_smoke.js`

Expected: both tests pass.

```powershell
git add src/adapters/models/openai_compatible.js src/adapters/models/mock.js tests/model_adapter_smoke.js tests/message_reply_contract_smoke.js
git commit -m "feat: guide one message quality revision"
```

### Task 4: 接入消息发现与跟进草稿生成

**Files:**
- Modify: `src/core/message_discovery.js`
- Modify: `src/application/message_follow_up/index.js`
- Modify: `src/dashboard/message_discovery_controller.js`
- Modify: `tests/message_discovery_smoke.js`
- Modify: `tests/message_follow_up_service_smoke.js`
- Modify: `tests/dashboard_message_discovery_smoke.js`

**Interfaces:**
- Consumes: `generateQualityCheckedDraft()` and the current profile's recent completion records.
- Produces: discovery/follow-up results with transient `draftQualityWarnings`; invalid model text is not passed to `recordMessageReplyDrafts()`.

- [x] **Step 1: Write failing integration tests**

For message discovery, seed 20 recent copied/sent memories, return a repeated first model result and a distinct second result, and assert exactly two calls and only the second text is persisted. Return an unsupported phone twice and assert no draft row is created.

For follow-up, return a repeated first result and distinct second result; assert an existing user-edited open draft is not replaced when quality generation fails.

- [x] **Step 2: Run tests and verify RED**

Run: `node tests/message_discovery_smoke.js && node tests/message_follow_up_service_smoke.js`

Expected: FAIL because generation does not use the quality orchestrator.

- [x] **Step 3: Build recent and evidence inputs**

Recent texts:

```js
listCandidateAnswerMemories(db, { profileId, activeOnly: false, limit: 100 })
  .filter((item) => ["copied", "sent"].includes(item.completionKind))
  .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id - a.id)
  .slice(0, 20)
  .map((item) => item.finalText);
```

Evidence texts contain active resume text, `listCandidateFacts`, and only applicable active `user_edited_reply` memories. Do not include JD description in candidate evidence.

- [x] **Step 4: Persist only sendable model output**

If `assessment.errors.length > 0`, set a user-readable missing-fact result and pass an empty `messages` array to storage. If only warnings remain, persist the draft and attach warnings to the in-memory/public view model. Never overwrite an existing open draft during a failed refresh.

- [x] **Step 5: Run integration tests and commit**

Run: `node tests/message_discovery_smoke.js && node tests/message_follow_up_service_smoke.js && node tests/dashboard_message_discovery_smoke.js`

Expected: all tests pass.

```powershell
git add src/core/message_discovery.js src/application/message_follow_up/index.js src/dashboard/message_discovery_controller.js tests/message_discovery_smoke.js tests/message_follow_up_service_smoke.js tests/dashboard_message_discovery_smoke.js
git commit -m "feat: quality-check generated reply drafts"
```

### Task 5: 发送前事实撤回保护和页面提醒

**Files:**
- Modify: `src/application/message_reply_sending/index.js`
- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `src/dashboard/pages/message_follow_up.js`
- Modify: `tests/message_reply_learning_smoke.js`
- Modify: `tests/dashboard_message_reply_send_smoke.js`
- Modify: `tests/dashboard_message_follow_up_smoke.js`

**Interfaces:**
- Consumes: `replyDraftWasEdited(originalText, currentText)` and `assessMessageDraftQuality()`.
- Produces: `MESSAGE_DRAFT_FACT_UNSUPPORTED` before batch creation only for an unedited model draft whose active evidence no longer supports its facts.

- [x] **Step 1: Write failing send and UI tests**

```js
withdrawCandidateAnswerMemory(db, { profileId, memoryId, withdrawnAt: NOW });
assert.throws(
  () => sending.confirmBatch({ profileId, items: [{ draftId, revision }] }),
  (error) => error.code === "MESSAGE_DRAFT_FACT_UNSUPPORTED"
);
saveMessageReplyDraftEdit(db, { profileId, draftId, text: "用户亲自补充：我本周三可以到岗。" });
assert.doesNotThrow(() => sending.confirmBatch({ profileId, items: [{ draftId, revision: 1 }] }));
```

UI tests assert “与近期消息较接近” is visible but the send button remains enabled, while unsupported untouched model text has no send control.

- [x] **Step 2: Run tests and verify RED**

Run: `node tests/message_reply_learning_smoke.js && node tests/dashboard_message_reply_send_smoke.js && node tests/dashboard_message_follow_up_smoke.js`

Expected: FAIL because confirmation does not recheck current evidence and warnings are not rendered.

- [x] **Step 3: Add pre-freeze validation**

In `confirmBatch`, load each draft and compare original/current text. For unedited drafts only, rebuild active evidence and throw before `createMessageReplySendBatch()` if unsupported claims exist. Do not write a batch, close a draft or record a memory on this failure.

- [x] **Step 4: Render plain-language quality messages**

Render only stable user text:

- warning: “这条草稿与近期消息的表达比较接近，你可以直接发送，也可以改得更具体。”
- error: “草稿里有系统找不到依据的个人信息，请修改后再发送。”

Do not display similarity scores, token types or raw model prompts.

- [x] **Step 5: Run focused and full gates**

```powershell
node tests/message_draft_quality_smoke.js
node tests/message_draft_quality_service_smoke.js
node tests/message_discovery_smoke.js
node tests/message_follow_up_service_smoke.js
node tests/dashboard_message_reply_send_smoke.js
npm test
git diff --check
git status --short
```

Expected: focused tests print `ok`; the full suite prints the current exact count; diff check has no output.

- [x] **Step 6: Update documentation and commit**

Update `docs/NEXT_PHASE.md` and `docs/PROJECT_HANDOFF.md` with the 20-message window, one-revision maximum, user-edit authority, exact tests and real-platform non-access.

```powershell
git add src/application/message_reply_sending/index.js src/dashboard/message_discovery_view.js src/dashboard/pages/message_follow_up.js tests/message_reply_learning_smoke.js tests/dashboard_message_reply_send_smoke.js tests/dashboard_message_follow_up_smoke.js docs/NEXT_PHASE.md docs/PROJECT_HANDOFF.md
git commit -m "docs: record message draft quality delivery"
```
